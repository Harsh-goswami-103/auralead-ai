/**
 * Employee productivity (T25, P10; PRD "employee productivity with explicit definitions (no
 * invented efficiency scores)"; 99-critic P10).
 *
 * Read from the audit trail, per employee (globalRole EMPLOYEE) and per period (the last 7 or 30
 * days before the "As of" time), across the workspaces of this mode. Five metrics, each with the
 * definition string the page prints as a footnote. There is deliberately no composite or
 * "efficiency" score and no ranking: the numbers sit side by side and mean only what their
 * definitions say.
 *
 *  - Lead actions: manual sales-stage changes (`lead.stage*`) plus AI draft requests
 *    (`ai.draft.request`).
 *  - Approvals decided: `quote.approve` + `approval.reject`.
 *  - Median time to decision: wall clock from the Approval's `requestedAt` to the decision's audit
 *    time, over decisions whose audit row names the approval (the `approvalId` in a quote.approve
 *    summary, the target of an approval.reject). The audit row carries no request time, so the
 *    request side comes from the Approval row it names.
 *  - Sends queued: `dispatch.queue` rows this person wrote (composer sends, approve-and-send,
 *    quote sends). Not deliveries.
 *  - Accepted quotes attributed: `quote.accept` rows in the period, attributed to whoever wrote the
 *    latest `quote.approve` for the accepted version before the acceptance.
 * Only SUCCESS rows count. The statement count is fixed (at most 8) whatever the number of
 * employees or rows.
 */
import type { Prisma } from '@/generated/prisma/client';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole } from '@/server/auth/guards';
import { dbMode } from '@/server/auth/session';
import { daysBefore, type MetricDefinition } from './widget';

/** Manual sales-stage changes are audited with an action starting with this (e.g. `lead.stage.move`). */
export const LEAD_STAGE_ACTION_PREFIX = 'lead.stage';
export const DRAFT_REQUEST_ACTION = 'ai.draft.request';
export const DECISION_ACTIONS = ['quote.approve', 'approval.reject'] as const;
export const SEND_ACTION = 'dispatch.queue';
export const ACCEPT_ACTION = 'quote.accept';

export const PRODUCTIVITY_PERIODS = [7, 30] as const;
export type ProductivityPeriod = (typeof PRODUCTIVITY_PERIODS)[number];
export const DEFAULT_PRODUCTIVITY_PERIOD: ProductivityPeriod = 7;

export type ProductivityMetricId = 'leadsProcessed' | 'approvalsDecided' | 'medianTimeToDecision' | 'messagesDispatched' | 'quotesAcceptedAttributed';
export type ProductivityMetricDefinition = MetricDefinition & { id: ProductivityMetricId; source: string };

export const PRODUCTIVITY_METRICS: readonly ProductivityMetricDefinition[] = [
  {
    id: 'leadsProcessed',
    label: 'Lead actions',
    definition:
      'Lead actions this person completed in the period: manual sales-stage changes plus AI draft requests (audit actions lead.stage… and ai.draft.request). Each action counts once, so moving one lead twice counts two.',
    source: 'AuditEvent',
  },
  {
    id: 'approvalsDecided',
    label: 'Approvals decided',
    definition: 'Quotation approvals (quote.approve) and rejections of any approval item (approval.reject) this person made in the period.',
    source: 'AuditEvent',
  },
  {
    id: 'medianTimeToDecision',
    label: 'Median time to decision',
    definition:
      "Median wall-clock time from an approval being requested to this person's decision, over the decisions above whose audit entry names the approval. Business hours are not configured, so nights and weekends count.",
    source: 'AuditEvent + Approval.requestedAt',
  },
  {
    id: 'messagesDispatched',
    label: 'Sends queued',
    definition: 'Messages and quotations this person queued for sending in the period (dispatch.queue). A queued send can still be skipped by the delivery checks or fail; deliveries are not counted here.',
    source: 'AuditEvent',
  },
  {
    id: 'quotesAcceptedAttributed',
    label: 'Accepted quotes attributed',
    definition: 'Quotations a customer accepted in the period whose accepted version this person approved last (the latest quote.approve of that version before the acceptance).',
    source: 'AuditEvent',
  },
];

/** Context for reading the five metrics, not a productivity metric itself. */
export const ACTIVE_ASSIGNMENTS_DEFINITION: MetricDefinition = {
  id: 'assignments',
  label: 'Active assignments',
  definition: 'Workspaces this person is assigned to right now (not limited to the period). Someone assigned to quiet workspaces simply has fewer items to act on.',
};

export type ProductivityRow = {
  userId: string;
  name: string;
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  activeAssignments: number;
  leadsProcessed: number;
  approvalsDecided: number;
  /** Null when no decision of the period could be timed. */
  medianTimeToDecisionMs: number | null;
  decisionsTimed: number;
  messagesDispatched: number;
  quotesAcceptedAttributed: number;
};

export type Productivity = {
  asOf: Date;
  since: Date;
  days: ProductivityPeriod;
  rows: ProductivityRow[];
  definitions: readonly ProductivityMetricDefinition[];
};

export function isProductivityPeriod(days: number): days is ProductivityPeriod {
  return (PRODUCTIVITY_PERIODS as readonly number[]).includes(days);
}

function summaryOf(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The median of a non-empty list (the mean of the middle two for an even count), rounded to ms. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export async function loadProductivity(ctx: AppCtx, input: { days: number }): Promise<Productivity> {
  requireRole(ctx, 'SUPER_ADMIN');
  const days: ProductivityPeriod = isProductivityPeriod(input.days) ? input.days : DEFAULT_PRODUCTIVITY_PERIOD;
  const prisma = baseClientOf(ctx);
  const mode = dbMode(ctx.mode);
  const now = ctx.clock.now();
  const since = daysBefore(now, days);
  const userScope = mode === 'DEMO' ? {} : { isDemo: false };

  const [employees, workspaces] = await Promise.all([
    prisma.user.findMany({ where: { globalRole: 'EMPLOYEE', ...userScope }, select: { id: true, name: true, status: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    prisma.workspace.findMany({ where: { mode }, select: { id: true } }),
  ]);
  const employeeIds = employees.map((e) => e.id);
  const workspaceIds = workspaces.map((w) => w.id);
  const inPeriod = { createdAt: { gte: since, lte: now }, result: 'SUCCESS' as const, workspaceId: { in: workspaceIds } };
  const byEmployees = { ...inPeriod, actorUserId: { in: employeeIds } };

  const [assignments, counts, decisions, accepts] = await Promise.all([
    prisma.employeeAssignment.groupBy({ by: ['employeeUserId'], where: { active: true, workspaceId: { in: workspaceIds } }, _count: { _all: true } }),
    prisma.auditEvent.groupBy({
      by: ['actorUserId', 'action'],
      where: { ...byEmployees, OR: [{ action: { startsWith: LEAD_STAGE_ACTION_PREFIX } }, { action: { in: [DRAFT_REQUEST_ACTION, SEND_ACTION, ...DECISION_ACTIONS] } }] },
      _count: { _all: true },
    }),
    prisma.auditEvent.findMany({ where: { ...byEmployees, action: { in: [...DECISION_ACTIONS] } }, select: { actorUserId: true, action: true, targetId: true, summary: true, createdAt: true } }),
    prisma.auditEvent.findMany({ where: { ...inPeriod, action: ACCEPT_ACTION, targetType: 'Quote' }, select: { targetId: true, summary: true, createdAt: true } }),
  ]);

  // Which approval each decision names.
  const timedDecisions = decisions
    .map((d) => {
      const approvalId = d.action === 'approval.reject' ? d.targetId : summaryOf(d.summary).approvalId;
      return typeof approvalId === 'string' && d.actorUserId ? { actorUserId: d.actorUserId, approvalId, decidedAt: d.createdAt } : null;
    })
    .filter((d): d is { actorUserId: string; approvalId: string; decidedAt: Date } => d !== null);
  const approvalIds = [...new Set(timedDecisions.map((d) => d.approvalId))];
  const acceptedQuoteIds = [...new Set(accepts.map((a) => a.targetId))];

  const [approvals, approves] = await Promise.all([
    approvalIds.length > 0 ? prisma.approval.findMany({ where: { id: { in: approvalIds }, workspaceId: { in: workspaceIds } }, select: { id: true, requestedAt: true } }) : Promise.resolve([]),
    acceptedQuoteIds.length > 0
      ? prisma.auditEvent.findMany({
          where: { action: 'quote.approve', result: 'SUCCESS', targetType: 'Quote', targetId: { in: acceptedQuoteIds }, workspaceId: { in: workspaceIds } },
          select: { actorUserId: true, targetId: true, summary: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);

  const requestedAt = new Map(approvals.map((a) => [a.id, a.requestedAt]));
  const durations = new Map<string, number[]>();
  for (const d of timedDecisions) {
    const requested = requestedAt.get(d.approvalId);
    if (!requested) continue;
    const ms = d.decidedAt.getTime() - requested.getTime();
    if (ms < 0) continue;
    durations.set(d.actorUserId, [...(durations.get(d.actorUserId) ?? []), ms]);
  }

  const attributed = new Map<string, number>();
  for (const accept of accepts) {
    const versionNo = summaryOf(accept.summary).versionNo;
    const last = approves
      .filter((a) => a.targetId === accept.targetId && a.createdAt.getTime() <= accept.createdAt.getTime())
      .filter((a) => typeof versionNo !== 'number' || summaryOf(a.summary).versionNo === versionNo)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (last?.actorUserId) attributed.set(last.actorUserId, (attributed.get(last.actorUserId) ?? 0) + 1);
  }

  const count = (userId: string, match: (action: string) => boolean) =>
    counts.filter((g) => g.actorUserId === userId && match(g.action)).reduce((n, g) => n + g._count._all, 0);
  const assignmentsBy = new Map(assignments.map((a) => [a.employeeUserId, a._count._all]));

  const rows: ProductivityRow[] = employees.map((e) => {
    const times = durations.get(e.id) ?? [];
    return {
      userId: e.id,
      name: e.name,
      status: e.status,
      activeAssignments: assignmentsBy.get(e.id) ?? 0,
      leadsProcessed: count(e.id, (a) => a.startsWith(LEAD_STAGE_ACTION_PREFIX) || a === DRAFT_REQUEST_ACTION),
      approvalsDecided: count(e.id, (a) => (DECISION_ACTIONS as readonly string[]).includes(a)),
      medianTimeToDecisionMs: median(times),
      decisionsTimed: times.length,
      messagesDispatched: count(e.id, (a) => a === SEND_ACTION),
      quotesAcceptedAttributed: attributed.get(e.id) ?? 0,
    };
  });

  return { asOf: now, since, days, rows, definitions: PRODUCTIVITY_METRICS };
}
