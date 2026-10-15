/**
 * Read models for the three panel home pages (T09, M1): real, DB-derived identity and workspace
 * information, never placeholders.
 *  - USER: the resolved workspace (through the tenant-scoped client), the members, the service
 *    catalog priced from the active PricingVersion, the active scoring and pipeline versions and
 *    the quote settings.
 *  - EMPLOYEE: the actor's active assignments (capabilities, discount cap), filtered by the
 *    actor's own user id through the base client, exactly like the panel chrome.
 *  - SUPER_ADMIN: platform counts and worker liveness only. Tenant records stay behind the
 *    audited adminContext (later admin pages).
 * Each loader refuses another role with a 404 (A6).
 */
import type { Capability } from '@/lib/domain/enums';
import { isCapability } from '@/lib/domain/enums';
import { NotFoundError } from '@/lib/errors';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole, requireWorkspace } from '@/server/auth/guards';
import { dbMode } from '@/server/auth/session';

/** Plan M3 queue health: a heartbeat older than this means "Worker not running". */
export const WORKER_STALE_AFTER_MS = 30_000;

export type UserHome = {
  workspace: { name: string; slug: string; planLabel: string; timezone: string; createdAt: Date; role: 'OWNER' | 'MEMBER' };
  members: Array<{ name: string; role: 'OWNER' | 'MEMBER' }>;
  pricing: { version: number; note: string; createdAt: Date } | null;
  services: Array<{ code: string; name: string; unitLabel: string; defaultTimelineDays: number | null; unitPricePaise: bigint | null }>;
  scoring: { version: number; createdAt: Date } | null;
  pipeline: { version: number; approvalMode: 'HUMAN' | 'POLICY_AUTO'; stages: string[] } | null;
  settings: {
    taxMode: 'NONE' | 'CONFIGURED';
    taxLabel: string | null;
    taxBps: number | null;
    maxDiscountBps: number;
    quoteValidityDays: number;
    autoSendEnabled: boolean;
    termsText: string;
  } | null;
  capabilityCount: number;
};

function stageLabels(graph: unknown): string[] {
  const stages = (graph as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages)) return [];
  return stages.map((s) => (s as { label?: unknown; kind?: unknown })).map((s) => (typeof s.label === 'string' ? s.label : String(s.kind)));
}

export async function loadUserHome(ctx: AppCtx): Promise<UserHome> {
  const actor = requireRole(ctx, 'USER');
  const workspaceId = requireWorkspace(ctx);
  const db = ctx.db;

  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new NotFoundError();
  const memberships = await db.membership.findMany({ include: { user: { select: { name: true } } }, orderBy: [{ role: 'asc' }, { createdAt: 'asc' }] });
  const mine = memberships.find((m) => m.userId === actor.userId);
  if (!mine) throw new NotFoundError();

  const pricing = await db.pricingVersion.findFirst({ where: { active: true }, include: { entries: true } });
  const services = await db.service.findMany({ where: { archivedAt: null }, orderBy: { code: 'asc' } });
  const priceOf = new Map((pricing?.entries ?? []).map((e) => [e.serviceId, e.unitPricePaise]));
  const scoring = await db.scoringConfigVersion.findFirst({ where: { active: true } });
  const pipeline = await db.pipelineConfigVersion.findFirst({ where: { active: true } });
  const settings = await db.workspaceSettings.findFirst();

  return {
    workspace: { name: workspace.name, slug: workspace.slug, planLabel: workspace.planLabel, timezone: workspace.timezone, createdAt: workspace.createdAt, role: mine.role },
    members: memberships.map((m) => ({ name: m.user.name, role: m.role })),
    pricing: pricing ? { version: pricing.version, note: pricing.note, createdAt: pricing.createdAt } : null,
    services: services.map((s) => ({
      code: s.code,
      name: s.name,
      unitLabel: s.unitLabel,
      defaultTimelineDays: s.defaultTimelineDays,
      unitPricePaise: priceOf.get(s.id) ?? null,
    })),
    scoring: scoring ? { version: scoring.version, createdAt: scoring.createdAt } : null,
    pipeline: pipeline ? { version: pipeline.version, approvalMode: pipeline.approvalMode, stages: stageLabels(pipeline.graph) } : null,
    settings: settings
      ? {
          taxMode: settings.taxMode,
          taxLabel: settings.taxLabel,
          taxBps: settings.taxBps,
          maxDiscountBps: settings.maxDiscountBps,
          quoteValidityDays: settings.quoteValidityDays,
          autoSendEnabled: settings.autoSendEnabled,
          termsText: settings.termsText,
        }
      : null,
    capabilityCount: ctx.capabilities.size,
  };
}

export type EmployeeHome = {
  assignments: Array<{
    slug: string;
    name: string;
    planLabel: string;
    capabilities: Capability[];
    maxDiscountBps: number | null;
    since: Date;
    /** The workspace this session is working in. */
    current: boolean;
  }>;
  inactiveCount: number;
};

export async function loadEmployeeHome(ctx: AppCtx): Promise<EmployeeHome> {
  const actor = requireRole(ctx, 'EMPLOYEE');
  const prisma = baseClientOf(ctx);
  const rows = await prisma.employeeAssignment.findMany({
    where: { employeeUserId: actor.userId, workspace: { mode: dbMode(ctx.mode) } },
    include: { workspace: { select: { slug: true, name: true, planLabel: true } } },
  });
  const active = rows
    .filter((r) => r.active)
    .map((r) => ({
      slug: r.workspace.slug,
      name: r.workspace.name,
      planLabel: r.workspace.planLabel,
      capabilities: (Array.isArray(r.capabilities) ? r.capabilities : []).filter(isCapability),
      maxDiscountBps: r.maxDiscountBps,
      since: r.createdAt,
      current: r.workspaceId === ctx.workspaceId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug, 'en'));
  return { assignments: active, inactiveCount: rows.length - active.length };
}

export type AdminHome = {
  workspaces: { total: number; active: number; suspended: number; automationPaused: number };
  people: { owners: number; members: number; employees: number; superAdmins: number; disabled: number };
  activeAssignments: number;
  outboundPaused: boolean;
  worker: { workerId: string; lastBeatAt: Date; running: boolean; currentJobId: string | null } | null;
};

export async function loadAdminHome(ctx: AppCtx, opts: { envOutboundPaused?: boolean } = {}): Promise<AdminHome> {
  requireRole(ctx, 'SUPER_ADMIN');
  const prisma = baseClientOf(ctx);
  const mode = dbMode(ctx.mode);
  const inMode = { workspace: { mode } };

  const [total, active, suspended, automationPaused] = await Promise.all([
    prisma.workspace.count({ where: { mode } }),
    prisma.workspace.count({ where: { mode, status: 'ACTIVE' } }),
    prisma.workspace.count({ where: { mode, status: 'SUSPENDED' } }),
    prisma.workspace.count({ where: { mode, automationPaused: true } }),
  ]);
  const ownerRows = await prisma.membership.findMany({ where: { role: 'OWNER', ...inMode }, select: { userId: true }, distinct: ['userId'] });
  const members = await prisma.membership.count({ where: { role: 'MEMBER', ...inMode } });
  const isDemo = mode === 'DEMO';
  const userScope = isDemo ? {} : { isDemo: false };
  const [employees, superAdmins, disabled] = await Promise.all([
    prisma.user.count({ where: { globalRole: 'EMPLOYEE', ...userScope } }),
    prisma.user.count({ where: { globalRole: 'SUPER_ADMIN', ...userScope } }),
    prisma.user.count({ where: { status: 'DISABLED', ...userScope } }),
  ]);
  const activeAssignments = await prisma.employeeAssignment.count({ where: { active: true, ...inMode } });
  const setting = await prisma.systemSetting.findUnique({ where: { id: 1 }, select: { outboundPaused: true } });
  const beat = await prisma.workerHeartbeat.findFirst({ where: { mode }, orderBy: { lastBeatAt: 'desc' } });
  const now = ctx.clock.now().getTime();

  return {
    workspaces: { total, active, suspended, automationPaused },
    people: { owners: ownerRows.length, members, employees, superAdmins, disabled },
    activeAssignments,
    outboundPaused: (opts.envOutboundPaused ?? false) || (setting?.outboundPaused ?? false),
    worker: beat
      ? { workerId: beat.workerId, lastBeatAt: beat.lastBeatAt, running: now - beat.lastBeatAt.getTime() <= WORKER_STALE_AFTER_MS, currentJobId: beat.currentJobId }
      : null,
  };
}
