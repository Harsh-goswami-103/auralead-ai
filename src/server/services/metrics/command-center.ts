/**
 * The client command center read model (T25; PRD "command center: DB-derived counts,
 * conversations, quote metrics, pipeline value vs confirmed revenue, funnel, activity"; 06-design
 * §11.1 KPI row, "Needs you", funnel, activity feed).
 *
 * Every number is an aggregate over stored rows through the tenant-scoped client (definitions and
 * filters in ./definitions), computed at one "As of" instant from the injected clock. One
 * aggregate per widget; a widget whose query fails is returned as failed with the request
 * reference while the others still load. The whole load is a fixed set of statements (12),
 * independent of how many rows the workspace has (tests/integration/metrics/query-budget.test.ts).
 * Owner and member both read it (no capability gate: it shows counts only, never contact data).
 */
import type { ActorKind, AuditResult } from '@/generated/prisma/client';
import { NotFoundError } from '@/lib/errors';
import type { AppCtx } from '@/server/auth/context';
import { requireRole, requireWorkspace } from '@/server/auth/guards';
import {
  ACCEPTED_VERSION_WHERE,
  AWAITING_APPROVAL_WHERE,
  CLIENT_METRICS,
  confirmedRevenue,
  LIVE_LEAD_WHERE,
  NEEDS_YOU_ITEMS,
  NEEDS_YOU_ORDER,
  needsYouApprovalsWhere,
  needsYouMessagesWhere,
  newLeadsWhere,
  OPEN_CALL_REQUEST_WHERE,
  OPEN_CONVERSATION_WHERE,
  pipelineVersionWhere,
  SALES_STAGES,
  type ConfirmedRevenue,
  type NeedsYouDefinition,
  type NeedsYouId,
  type SalesStageKey,
} from './definitions';
import { moneyOf, settleWidget, type MoneyMetric, type WidgetErrorHandler, type WidgetOutcome } from './widget';

/** Entries in the activity feed. */
export const ACTIVITY_LIMIT = 8;

export type NeedsYouItem = NeedsYouDefinition & { count: number };

export type StageFunnel = { stages: Array<{ stage: SalesStageKey; count: number }>; total: number };

export type ActivityItem = {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actorKind: ActorKind;
  actorName: string | null;
  result: AuditResult;
  crossWorkspace: boolean;
  createdAt: Date;
};

export type ClientCommandCenter = {
  asOf: Date;
  workspace: { name: string; slug: string; planLabel: string; timezone: string; createdAt: Date };
  kpis: {
    newLeads: WidgetOutcome<number>;
    openConversations: WidgetOutcome<number>;
    quotesAwaitingApproval: WidgetOutcome<number>;
    pipelineValue: WidgetOutcome<MoneyMetric>;
    acceptedQuoteValue: WidgetOutcome<MoneyMetric>;
    confirmedRevenue: ConfirmedRevenue;
  };
  needsYou: WidgetOutcome<NeedsYouItem[]>;
  funnel: WidgetOutcome<StageFunnel>;
  activity: WidgetOutcome<ActivityItem[]>;
};

/** A query shared by two widgets runs once, on first use. */
function once<T>(run: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => (promise ??= run());
}

export async function loadClientCommandCenter(ctx: AppCtx, opts: { onWidgetError?: WidgetErrorHandler } = {}): Promise<ClientCommandCenter> {
  requireRole(ctx, 'USER');
  const workspaceId = requireWorkspace(ctx);
  const db = ctx.db;
  const now = ctx.clock.now();
  const settle = <T>(def: { id: string }, run: () => Promise<T>) => settleWidget(ctx, def, run, opts.onWidgetError);

  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, slug: true, planLabel: true, timezone: true, createdAt: true } });
  if (!workspace) throw new NotFoundError();

  // One statement for both the open-conversation KPI and the takeover line of "Needs you".
  const conversations = once(() => db.conversation.groupBy({ by: ['humanTakeover'], where: OPEN_CONVERSATION_WHERE, _count: { _all: true } }));

  const [newLeads, openConversations, quotesAwaitingApproval, pipelineValue, acceptedQuoteValue, needsYou, funnel, activity] = await Promise.all([
    settle(CLIENT_METRICS.newLeads, () => db.lead.count({ where: newLeadsWhere(now) })),
    settle(CLIENT_METRICS.openConversations, async () => (await conversations()).reduce((n, g) => n + g._count._all, 0)),
    settle(CLIENT_METRICS.quotesAwaitingApproval, () => db.quote.count({ where: AWAITING_APPROVAL_WHERE })),
    settle(CLIENT_METRICS.pipelineValue, async () => moneyOf(await db.quoteVersion.aggregate({ where: pipelineVersionWhere(now), _sum: { totalPaise: true }, _count: { _all: true } }))),
    settle(CLIENT_METRICS.acceptedQuoteValue, async () => moneyOf(await db.quoteVersion.aggregate({ where: ACCEPTED_VERSION_WHERE, _sum: { totalPaise: true }, _count: { _all: true } }))),
    settle(CLIENT_METRICS.needsYou, async () => {
      const [approvals, messages, convo, callRequests] = await Promise.all([
        db.approval.groupBy({ by: ['kind', 'status'], where: needsYouApprovalsWhere(now), _count: { _all: true } }),
        db.message.groupBy({ by: ['status'], where: needsYouMessagesWhere(now), _count: { _all: true } }),
        conversations(),
        db.callRequest.count({ where: OPEN_CALL_REQUEST_WHERE }),
      ]);
      const approvalCount = (kind: string, status: string) => approvals.find((g) => g.kind === kind && g.status === status)?._count._all ?? 0;
      const messageCount = (status: string) => messages.find((g) => g.status === status)?._count._all ?? 0;
      const counts: Record<NeedsYouId, number> = {
        quoteApprovals: approvalCount('QUOTE_VERSION', 'PENDING'),
        messageApprovals: approvalCount('OUTBOUND_MESSAGE', 'PENDING'),
        invalidatedApprovals: approvalCount('QUOTE_VERSION', 'INVALIDATED'),
        failedDeliveries: messageCount('FAILED'),
        unknownDeliveries: messageCount('UNKNOWN'),
        takeoverThreads: convo.find((g) => g.humanTakeover)?._count._all ?? 0,
        openCallRequests: callRequests,
      };
      return NEEDS_YOU_ORDER.map((id) => ({ ...NEEDS_YOU_ITEMS[id], count: counts[id] }));
    }),
    settle(CLIENT_METRICS.funnel, async () => {
      const groups = await db.lead.groupBy({ by: ['salesStage'], where: LIVE_LEAD_WHERE, _count: { _all: true } });
      const stages = SALES_STAGES.map((stage) => ({ stage, count: groups.find((g) => g.salesStage === stage)?._count._all ?? 0 }));
      return { stages, total: stages.reduce((n, s) => n + s.count, 0) };
    }),
    settle(CLIENT_METRICS.activity, async () => {
      const rows = await db.auditEvent.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ACTIVITY_LIMIT,
        select: { id: true, action: true, targetType: true, targetId: true, actorKind: true, actorUserId: true, result: true, crossWorkspace: true, createdAt: true },
      });
      const ids = [...new Set(rows.map((r) => r.actorUserId).filter((id): id is string => id !== null))];
      const users = ids.length > 0 ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
      const nameOf = new Map(users.map((u) => [u.id, u.name]));
      return rows.map(({ actorUserId, ...r }) => ({ ...r, actorName: actorUserId ? (nameOf.get(actorUserId) ?? null) : null }));
    }),
  ]);

  return {
    asOf: now,
    workspace,
    kpis: { newLeads, openConversations, quotesAwaitingApproval, pipelineValue, acceptedQuoteValue, confirmedRevenue: confirmedRevenue() },
    needsYou,
    funnel,
    activity,
  };
}
