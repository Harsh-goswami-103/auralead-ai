/**
 * Admin global metrics (T25; PRD "Super admin: global metrics + workspace drilldowns"; 06-design
 * §11.1 "Global metrics with workspace table").
 *
 * One read model for the admin home: platform health (worker heartbeat and the three-switch
 * outbound pause, read exactly like Jobs and queue), account counts, global business totals and a
 * table with one row per workspace of this mode. The per-workspace numbers use the same filters as
 * the client command center (./definitions), grouped by workspace, so a workspace's row always
 * equals its owner's dashboard.
 *
 * These are aggregates (counts and sums per workspace), not tenant records: no lead, message or
 * quote row is read or shown, so no drilldown audit is written (the audited drilldown into a
 * workspace's records is T29's adminContext). The statement count is fixed (13) whatever the number
 * of workspaces: every per-workspace figure is one grouped statement.
 */
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole } from '@/server/auth/guards';
import { dbMode } from '@/server/auth/session';
import { readOutboundPause, type OutboundPauseState } from '@/server/services/admin/outbound-pause';
import { WORKER_STALE_AFTER_MS } from '@/server/services/shell/panel-home';
import {
  ACCEPTED_VERSION_WHERE,
  AWAITING_APPROVAL_WHERE,
  CLIENT_METRICS,
  confirmedRevenue,
  LIVE_LEAD_WHERE,
  newLeadsWhere,
  OPEN_CONVERSATION_WHERE,
  pipelineVersionWhere,
  type ConfirmedRevenue,
} from './definitions';
import { type MetricDefinition, type MoneyMetric } from './widget';

export const PLATFORM_METRICS = {
  workspaces: { id: 'workspaces', label: 'Workspaces', definition: 'Client workspaces in this database (this mode only), with how many are active, suspended or have automation paused.' },
  leads: { id: 'leads', label: 'Leads', definition: 'Leads across every workspace of this mode, each counted once. Merged duplicates are not counted.' },
  newLeads: { id: 'newLeads', label: CLIENT_METRICS.newLeads.label, definition: CLIENT_METRICS.newLeads.definition.replace('in this workspace', 'in each workspace') },
  openConversations: { id: 'openConversations', label: CLIENT_METRICS.openConversations.label, definition: CLIENT_METRICS.openConversations.definition },
  quotesAwaitingApproval: { id: 'quotesAwaitingApproval', label: CLIENT_METRICS.quotesAwaitingApproval.label, definition: CLIENT_METRICS.quotesAwaitingApproval.definition },
  pipelineValue: { id: 'pipelineValue', label: CLIENT_METRICS.pipelineValue.label, definition: CLIENT_METRICS.pipelineValue.definition },
  acceptedQuoteValue: { id: 'acceptedQuoteValue', label: CLIENT_METRICS.acceptedQuoteValue.label, definition: CLIENT_METRICS.acceptedQuoteValue.definition },
  people: { id: 'people', label: 'People', definition: 'Owners and members with a membership in the workspace.' },
  assignments: { id: 'assignments', label: 'Operators', definition: 'Employees with an active assignment to the workspace.' },
  lastActivity: { id: 'lastActivity', label: 'Last activity', definition: "Time of the newest audit entry of the workspace (any action by a person, the worker, a webhook or a customer's quote page)." },
} as const satisfies Record<string, MetricDefinition>;

export type WorkspaceMetricsRow = {
  id: string;
  slug: string;
  name: string;
  planLabel: string;
  status: 'ACTIVE' | 'SUSPENDED';
  automationPaused: boolean;
  createdAt: Date;
  people: number;
  activeAssignments: number;
  leads: number;
  newLeads: number;
  openConversations: number;
  quotesAwaitingApproval: number;
  pipelineValue: MoneyMetric;
  acceptedQuoteValue: MoneyMetric;
  lastActivityAt: Date | null;
};

export type PlatformMetrics = {
  asOf: Date;
  mode: 'demo' | 'live';
  totals: {
    workspaces: { total: number; active: number; suspended: number; automationPaused: number };
    leads: number;
    newLeads: number;
    openConversations: number;
    quotesAwaitingApproval: number;
    pipelineValue: MoneyMetric;
    acceptedQuoteValue: MoneyMetric;
    confirmedRevenue: ConfirmedRevenue;
  };
  people: { owners: number; members: number; employees: number; superAdmins: number; disabled: number };
  activeAssignments: number;
  outboundPaused: boolean;
  outbound: OutboundPauseState | null;
  worker: { workerId: string; lastBeatAt: Date; running: boolean; currentJobId: string | null } | null;
  workspaces: WorkspaceMetricsRow[];
};

type Grouped = { workspaceId: string; _count: { _all: number } };
const countsBy = (groups: Grouped[]) => new Map(groups.map((g) => [g.workspaceId, g._count._all]));
const moneyBy = (groups: Array<{ workspaceId: string; _count: { _all: number }; _sum: { totalPaise: bigint | null } }>) =>
  new Map(groups.map((g) => [g.workspaceId, { paise: g._sum.totalPaise ?? 0n, count: g._count._all }]));
const sumMoney = (rows: MoneyMetric[]): MoneyMetric => rows.reduce((a, m) => ({ paise: a.paise + m.paise, count: a.count + m.count }), { paise: 0n, count: 0 });

export async function loadPlatformMetrics(ctx: AppCtx, opts: { envOutboundPaused?: boolean; lockFile?: string } = {}): Promise<PlatformMetrics> {
  requireRole(ctx, 'SUPER_ADMIN');
  const prisma = baseClientOf(ctx);
  const mode = dbMode(ctx.mode);
  const now = ctx.clock.now();
  const userScope = mode === 'DEMO' ? {} : { isDemo: false };

  const workspaces = await prisma.workspace.findMany({
    where: { mode },
    orderBy: [{ name: 'asc' }, { slug: 'asc' }],
    select: { id: true, slug: true, name: true, planLabel: true, status: true, automationPaused: true, createdAt: true },
  });
  const ids = workspaces.map((w) => w.id);
  const inMode = { workspaceId: { in: ids } };

  const [memberships, users, assignments, leads, newLeads, conversations, drafts, pipeline, accepted, lastActivity, beat, outbound] = await Promise.all([
    prisma.membership.findMany({ where: inMode, select: { userId: true, workspaceId: true, role: true } }),
    prisma.user.groupBy({ by: ['globalRole', 'status'], where: userScope, _count: { _all: true } }),
    prisma.employeeAssignment.groupBy({ by: ['workspaceId'], where: { ...inMode, active: true }, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ['workspaceId'], where: { ...inMode, ...LIVE_LEAD_WHERE }, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ['workspaceId'], where: { ...inMode, ...newLeadsWhere(now) }, _count: { _all: true } }),
    prisma.conversation.groupBy({ by: ['workspaceId'], where: { ...inMode, ...OPEN_CONVERSATION_WHERE }, _count: { _all: true } }),
    prisma.quote.groupBy({ by: ['workspaceId'], where: { ...inMode, ...AWAITING_APPROVAL_WHERE }, _count: { _all: true } }),
    prisma.quoteVersion.groupBy({ by: ['workspaceId'], where: { ...inMode, ...pipelineVersionWhere(now) }, _count: { _all: true }, _sum: { totalPaise: true } }),
    prisma.quoteVersion.groupBy({ by: ['workspaceId'], where: { ...inMode, ...ACCEPTED_VERSION_WHERE }, _count: { _all: true }, _sum: { totalPaise: true } }),
    prisma.auditEvent.groupBy({ by: ['workspaceId'], where: inMode, _max: { createdAt: true } }),
    prisma.workerHeartbeat.findFirst({ where: { mode }, orderBy: { lastBeatAt: 'desc' } }),
    opts.lockFile === undefined
      ? prisma.systemSetting.findUnique({ where: { id: 1 }, select: { outboundPaused: true } }).then((s) => ({ state: null, dbPaused: s?.outboundPaused ?? false }))
      : readOutboundPause(prisma, { lockFile: opts.lockFile, envPaused: opts.envOutboundPaused ?? false }).then((state) => ({ state, dbPaused: state.db.paused })),
  ]);

  const peopleBy = new Map<string, number>();
  for (const m of memberships) peopleBy.set(m.workspaceId, (peopleBy.get(m.workspaceId) ?? 0) + 1);
  const assignmentsBy = countsBy(assignments);
  const leadsBy = countsBy(leads);
  const newLeadsBy = countsBy(newLeads);
  const conversationsBy = countsBy(conversations);
  const draftsBy = countsBy(drafts);
  const pipelineBy = moneyBy(pipeline);
  const acceptedBy = moneyBy(accepted);
  const lastBy = new Map(lastActivity.filter((g) => g.workspaceId !== null).map((g) => [g.workspaceId!, g._max.createdAt]));
  const zero: MoneyMetric = { paise: 0n, count: 0 };

  const rows: WorkspaceMetricsRow[] = workspaces.map((w) => ({
    ...w,
    people: peopleBy.get(w.id) ?? 0,
    activeAssignments: assignmentsBy.get(w.id) ?? 0,
    leads: leadsBy.get(w.id) ?? 0,
    newLeads: newLeadsBy.get(w.id) ?? 0,
    openConversations: conversationsBy.get(w.id) ?? 0,
    quotesAwaitingApproval: draftsBy.get(w.id) ?? 0,
    pipelineValue: pipelineBy.get(w.id) ?? zero,
    acceptedQuoteValue: acceptedBy.get(w.id) ?? zero,
    lastActivityAt: lastBy.get(w.id) ?? null,
  }));

  const usersCount = (pred: (g: (typeof users)[number]) => boolean) => users.filter(pred).reduce((n, g) => n + g._count._all, 0);
  const sum = (pick: (r: WorkspaceMetricsRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const envPaused = opts.envOutboundPaused ?? false;

  return {
    asOf: now,
    mode: ctx.mode,
    totals: {
      workspaces: {
        total: workspaces.length,
        active: workspaces.filter((w) => w.status === 'ACTIVE').length,
        suspended: workspaces.filter((w) => w.status === 'SUSPENDED').length,
        automationPaused: workspaces.filter((w) => w.automationPaused).length,
      },
      leads: sum((r) => r.leads),
      newLeads: sum((r) => r.newLeads),
      openConversations: sum((r) => r.openConversations),
      quotesAwaitingApproval: sum((r) => r.quotesAwaitingApproval),
      pipelineValue: sumMoney(rows.map((r) => r.pipelineValue)),
      acceptedQuoteValue: sumMoney(rows.map((r) => r.acceptedQuoteValue)),
      confirmedRevenue: confirmedRevenue(),
    },
    people: {
      owners: new Set(memberships.filter((m) => m.role === 'OWNER').map((m) => m.userId)).size,
      members: memberships.filter((m) => m.role === 'MEMBER').length,
      employees: usersCount((g) => g.globalRole === 'EMPLOYEE'),
      superAdmins: usersCount((g) => g.globalRole === 'SUPER_ADMIN'),
      disabled: usersCount((g) => g.status === 'DISABLED'),
    },
    activeAssignments: sum((r) => r.activeAssignments),
    outboundPaused: outbound.state ? outbound.state.paused : envPaused || outbound.dbPaused,
    outbound: outbound.state,
    worker: beat
      ? { workerId: beat.workerId, lastBeatAt: beat.lastBeatAt, running: now.getTime() - beat.lastBeatAt.getTime() <= WORKER_STALE_AFTER_MS, currentJobId: beat.currentJobId }
      : null,
    workspaces: rows,
  };
}
