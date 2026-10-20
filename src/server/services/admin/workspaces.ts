/**
 * Workspaces for the super admin (T29, R33).
 *
 *  - List and admin view: platform metadata only (name, slug, plan label, status, who has access,
 *    pending invites, the admin actions taken on the workspace). No tenant records, so no
 *    drilldown is needed to read them. Only workspaces of this process's mode appear.
 *  - Create (LIVE and DEMO alike, in the process mode): one immediate transaction writes the
 *    workspace, its settings, scoring v1 and pipeline v1 with human approval (the production
 *    defaults in workspace-defaults.ts; no services, prices or sample data), the `workspace.create`
 *    AuditEvent, and the first owner's access: a single-use OWNER invite shown once as a link, or,
 *    when the address already belongs to an active client user, the OWNER membership directly.
 *  - Plan label: the commercial label shown to the workspace (no billing, PRD scope), audited with
 *    the old and new label.
 *  - Drilldown: tenant data only through `adminContext`, which commits the `admin.elevate`
 *    AuditEvent (reason, crossWorkspace) before anything is read. The answer is read-only and
 *    aggregate: counts, configuration and redacted activity, never a lead's name, contact or
 *    message.
 */
import type { IntegrationKind, IntegrationStatus, JobStatus, PipelineApprovalMode, Prisma, PrismaClient, QuoteStatus, SalesStage, TaxMode, WorkspaceStatus } from '@/generated/prisma/client';
import { ConflictError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { redact } from '@/lib/redact';
import { DEFAULT_WORKSPACE_TIMEZONE, RESERVED_WORKSPACE_SLUGS } from '@/lib/schemas/admin-people';
import { adminContext, baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole } from '@/server/auth/guards';
import { dbMode } from '@/server/auth/session';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { createInviteInTx, findClientUserForOwnership, listPendingInvites, loadModeWorkspace, setMembershipInTx, userScope, type PendingInvite, type WorkspaceRef } from './people';
import { DEFAULT_PIPELINE_APPROVAL_MODE, DEFAULT_PIPELINE_GRAPH, DEFAULT_SCORING_CONFIG, defaultWorkspaceSettings, isValidTimezone } from './workspace-defaults';

const RECENT_ADMIN_ACTIONS = 10;
const DRILLDOWN_ACTIVITY = 20;

const rule = (code: string, userMessage: string) => new DomainRuleError({ code, userMessage });

function adminOf(ctx: AppCtx): { prisma: PrismaClient; adminId: string } {
  const actor = requireRole(ctx, 'SUPER_ADMIN');
  return { prisma: baseClientOf(ctx), adminId: actor.userId };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

// ---- Reads -------------------------------------------------------------------------------------

export type AdminWorkspaceRow = WorkspaceRef & {
  planLabel: string;
  timezone: string;
  status: WorkspaceStatus;
  automationPaused: boolean;
  createdAt: Date;
  owners: Array<{ id: string; name: string; email: string }>;
  memberCount: number;
  activeAssignments: number;
  pendingInvites: number;
};

export async function listWorkspaces(ctx: AppCtx): Promise<AdminWorkspaceRow[]> {
  const { prisma } = adminOf(ctx);
  const now = ctx.clock.now();
  const scope = userScope(ctx);
  const rows = await prisma.workspace.findMany({
    where: { mode: dbMode(ctx.mode) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      memberships: { where: { user: scope }, orderBy: { createdAt: 'asc' }, select: { role: true, user: { select: { id: true, name: true, email: true } } } },
      employeeAssignments: { where: { active: true, employee: scope }, select: { id: true } },
      invites: { where: { redeemedAt: null, expiresAt: { gt: now } }, select: { id: true } },
    },
  });
  return rows.map((w) => ({
    id: w.id,
    slug: w.slug,
    name: w.name,
    planLabel: w.planLabel,
    timezone: w.timezone,
    status: w.status,
    automationPaused: w.automationPaused,
    createdAt: w.createdAt,
    owners: w.memberships.filter((m) => m.role === 'OWNER').map((m) => m.user),
    memberCount: w.memberships.filter((m) => m.role === 'MEMBER').length,
    activeAssignments: w.employeeAssignments.length,
    pendingInvites: w.invites.length,
  }));
}

/** Workspaces of this mode for the admin forms' pickers (membership, assignment, client invite). */
export async function listWorkspaceOptions(ctx: AppCtx): Promise<WorkspaceRef[]> {
  const { prisma } = adminOf(ctx);
  return prisma.workspace.findMany({ where: { mode: dbMode(ctx.mode) }, orderBy: [{ name: 'asc' }, { slug: 'asc' }], select: { id: true, slug: true, name: true } });
}

export type WorkspaceAdminView = {
  workspace: WorkspaceRef & { planLabel: string; timezone: string; status: WorkspaceStatus; mode: 'DEMO' | 'LIVE'; automationPaused: boolean; createdAt: Date };
  members: Array<{ id: string; name: string; email: string; status: string; membershipRole: 'OWNER' | 'MEMBER'; since: Date }>;
  assignments: Array<{ id: string; name: string; email: string; active: boolean; capabilityCount: number; maxDiscountBps: number | null; since: Date }>;
  invites: PendingInvite[];
  /** Administrators' actions on this workspace (drilldowns, access changes), newest first; reasons redacted. */
  adminActions: Array<{ id: string; action: string; actorName: string | null; reason: string | null; createdAt: Date }>;
};

export async function getWorkspaceAdminView(ctx: AppCtx, workspaceId: string): Promise<WorkspaceAdminView> {
  const { prisma } = adminOf(ctx);
  const ref = await loadModeWorkspace(prisma, ctx, workspaceId);
  const scope = userScope(ctx);
  const ws = await prisma.workspace.findUniqueOrThrow({
    where: { id: ref.id },
    include: {
      memberships: { where: { user: scope }, orderBy: [{ role: 'asc' }, { createdAt: 'asc' }], include: { user: { select: { id: true, name: true, email: true, status: true } } } },
      employeeAssignments: { where: { employee: scope }, orderBy: { createdAt: 'asc' }, include: { employee: { select: { id: true, name: true, email: true } } } },
    },
  });
  const audits = await prisma.auditEvent.findMany({
    where: { workspaceId: ws.id, crossWorkspace: true, actorKind: 'SUPER_ADMIN' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: RECENT_ADMIN_ACTIONS,
    select: { id: true, action: true, actorUserId: true, reason: true, createdAt: true },
  });
  const actorIds = [...new Set(audits.map((a) => a.actorUserId).filter((v): v is string => v !== null))];
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
  const actorName = new Map(actors.map((a) => [a.id, a.name]));
  return {
    workspace: { id: ws.id, slug: ws.slug, name: ws.name, planLabel: ws.planLabel, timezone: ws.timezone, status: ws.status, mode: ws.mode, automationPaused: ws.automationPaused, createdAt: ws.createdAt },
    members: ws.memberships.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, status: m.user.status, membershipRole: m.role, since: m.createdAt })),
    assignments: ws.employeeAssignments.map((a) => ({
      id: a.employee.id,
      name: a.employee.name,
      email: a.employee.email,
      active: a.active,
      capabilityCount: Array.isArray(a.capabilities) ? a.capabilities.length : 0,
      maxDiscountBps: a.maxDiscountBps,
      since: a.createdAt,
    })),
    invites: await listPendingInvites(ctx, { workspaceId: ws.id }),
    adminActions: audits.map((a) => ({
      id: a.id,
      action: a.action,
      actorName: a.actorUserId ? (actorName.get(a.actorUserId) ?? null) : null,
      reason: a.reason === null ? null : String(redact(a.reason)),
      createdAt: a.createdAt,
    })),
  };
}

// ---- Create ------------------------------------------------------------------------------------

export type CreateWorkspaceInput = { name: string; slug: string; planLabel: string; timezone?: string; ownerEmail: string; reason: string };

export type CreatedWorkspace = {
  workspace: WorkspaceRef;
  owner:
    | { kind: 'invite'; email: string; inviteId: string; token: string; expiresAt: Date }
    | { kind: 'membership'; email: string; userId: string; revokedSessions: number };
};

export async function createWorkspace(ctx: AppCtx, input: CreateWorkspaceInput): Promise<CreatedWorkspace> {
  const { prisma, adminId } = adminOf(ctx);
  const now = ctx.clock.now();
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const planLabel = input.planLabel.trim();
  const timezone = (input.timezone ?? DEFAULT_WORKSPACE_TIMEZONE).trim();
  if (RESERVED_WORKSPACE_SLUGS.includes(slug)) throw rule('SLUG_RESERVED', `"${slug}" is reserved for the app's own pages. Choose another slug.`);
  if (!isValidTimezone(timezone)) throw rule('TIMEZONE_INVALID', 'Choose a time zone from the IANA list, for example Asia/Kolkata.');
  const slugTaken = () => new ConflictError({ code: 'SLUG_TAKEN', userMessage: `The slug "${slug}" is already used by another workspace. Choose another.` });

  try {
    return await withTx(prisma, async (tx) => {
      if (await tx.workspace.findUnique({ where: { slug }, select: { id: true } })) throw slugTaken();
      const existingOwner = await findClientUserForOwnership(tx, ctx, input.ownerEmail);

      const ws = await tx.workspace.create({ data: { slug, name, mode: dbMode(ctx.mode), planLabel, timezone, status: 'ACTIVE', createdAt: now }, select: { id: true, slug: true, name: true } });
      await tx.workspaceSettings.create({ data: { workspaceId: ws.id, ...defaultWorkspaceSettings({ name }), updatedAt: now, updatedBy: adminId } });
      await tx.scoringConfigVersion.create({
        data: { workspaceId: ws.id, version: 1, weights: DEFAULT_SCORING_CONFIG as unknown as Prisma.InputJsonValue, active: true, createdBy: adminId, createdAt: now },
      });
      await tx.pipelineConfigVersion.create({
        data: { workspaceId: ws.id, version: 1, graph: DEFAULT_PIPELINE_GRAPH as unknown as Prisma.InputJsonValue, approvalMode: DEFAULT_PIPELINE_APPROVAL_MODE, active: true, createdBy: adminId, createdAt: now },
      });
      await recordAudit(tx, ctx, {
        action: 'workspace.create',
        targetType: 'Workspace',
        targetId: ws.id,
        workspaceId: ws.id,
        crossWorkspace: true,
        reason: input.reason,
        summary: { fields: ['workspace', 'settings', 'scoringConfigVersion', 'pipelineConfigVersion'], planLabel, timezone, owner: existingOwner ? 'membership' : 'invite' },
      });

      if (existingOwner) {
        const granted = await setMembershipInTx(tx, ctx, { user: existingOwner, workspace: ws, membershipRole: 'OWNER', reason: input.reason });
        return { workspace: ws, owner: { kind: 'membership' as const, email: existingOwner.email, userId: existingOwner.id, revokedSessions: granted.revokedSessions } };
      }
      const issued = await createInviteInTx(tx, ctx, { email: input.ownerEmail, globalRole: 'USER', membershipRole: 'OWNER', workspace: ws, reason: input.reason });
      return { workspace: ws, owner: { kind: 'invite' as const, email: issued.invite.email, inviteId: issued.invite.id, token: issued.token, expiresAt: issued.invite.expiresAt } };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw slugTaken();
    throw error;
  }
}

// ---- Plan label --------------------------------------------------------------------------------

export async function setWorkspacePlanLabel(ctx: AppCtx, input: { workspaceId: string; planLabel: string; reason: string }): Promise<{ changed: boolean; planLabel: string }> {
  const { prisma } = adminOf(ctx);
  const planLabel = input.planLabel.trim();
  return withTx(prisma, async (tx) => {
    const ref = await loadModeWorkspace(tx, ctx, input.workspaceId);
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ref.id }, select: { planLabel: true } });
    if (ws.planLabel === planLabel) return { changed: false, planLabel };
    await tx.workspace.update({ where: { id: ref.id }, data: { planLabel } });
    await recordAudit(tx, ctx, {
      action: 'workspace.plan_label',
      targetType: 'Workspace',
      targetId: ref.id,
      workspaceId: ref.id,
      crossWorkspace: true,
      reason: input.reason,
      summary: { fields: ['planLabel'], from: ws.planLabel, to: planLabel },
    });
    return { changed: true, planLabel };
  });
}

// ---- Drilldown ---------------------------------------------------------------------------------

export type WorkspaceDrilldown = {
  /** The admin.elevate AuditEvent this view was opened under. */
  audit: { eventId: string; reason: string; openedAt: Date };
  workspace: WorkspaceRef & { planLabel: string; timezone: string; status: WorkspaceStatus; mode: 'DEMO' | 'LIVE'; automationPaused: boolean; automationPauseReason: string | null; createdAt: Date };
  settings: {
    taxMode: TaxMode;
    taxLabel: string | null;
    taxBps: number | null;
    maxDiscountBps: number;
    quoteValidityDays: number;
    autoSendEnabled: boolean;
    emailFallbackEnabled: boolean;
    emailB2bAttestationEnabled: boolean;
    bookingLinkSet: boolean;
    gstinSet: boolean;
    internalWaDailyCap: number | null;
    internalEmailDailyCap: number | null;
  } | null;
  configuration: { pricingVersion: number | null; services: number; pricedServices: number; scoringVersion: number | null; pipelineVersion: number | null; approvalMode: PipelineApprovalMode | null };
  leads: { total: number; byStage: Partial<Record<SalesStage, number>> };
  quotes: { total: number; byStatus: Partial<Record<QuoteStatus, number>> };
  approvalsPending: number;
  openConversations: number;
  activeSuppressions: number;
  integrations: Array<{ kind: IntegrationKind; status: IntegrationStatus; lastCheckedAt: Date | null; verifiedAt: Date | null }>;
  jobs: Partial<Record<JobStatus, number>>;
  recentActivity: Array<{ id: string; action: string; actorKind: string; result: string; crossWorkspace: boolean; createdAt: Date }>;
};

function tally<K extends string>(rows: Array<{ _count: { _all: number } } & Record<string, unknown>>, key: string): { total: number; by: Partial<Record<K, number>> } {
  const by: Partial<Record<K, number>> = {};
  let total = 0;
  for (const r of rows) {
    by[r[key] as K] = r._count._all;
    total += r._count._all;
  }
  return { total, by };
}

/**
 * Opens the audited, read-only view of one workspace. `adminContext` writes and commits the
 * `admin.elevate` row (reason, crossWorkspace) before this function reads a single tenant row.
 */
export async function openWorkspaceDrilldown(ctx: AppCtx, input: { workspaceId: string; reason: string }): Promise<WorkspaceDrilldown> {
  requireRole(ctx, 'SUPER_ADMIN');
  const elevated = await adminContext(ctx, input.workspaceId, input.reason);
  const db = elevated.db;
  const workspace = await db.workspace.findUnique({ where: { id: elevated.workspaceId! } });
  if (!workspace) throw new NotFoundError();

  const [settings, pricing, services, scoring, pipeline, leads, quotes, approvalsPending, openConversations, activeSuppressions, integrations, jobs, recent] = await Promise.all([
    db.workspaceSettings.findFirst(),
    db.pricingVersion.findFirst({ where: { active: true }, select: { version: true, _count: { select: { entries: true } } } }),
    db.service.count({ where: { archivedAt: null } }),
    db.scoringConfigVersion.findFirst({ where: { active: true }, select: { version: true } }),
    db.pipelineConfigVersion.findFirst({ where: { active: true }, select: { version: true, approvalMode: true } }),
    db.lead.groupBy({ by: ['salesStage'], where: { mergedIntoLeadId: null }, _count: { _all: true } }),
    db.quote.groupBy({ by: ['status'], _count: { _all: true } }),
    db.approval.count({ where: { status: 'PENDING' } }),
    db.conversation.count({ where: { closedAt: null } }),
    db.suppression.count({ where: { clearedAt: null } }),
    db.integration.findMany({ orderBy: { kind: 'asc' }, select: { kind: true, status: true, lastCheckedAt: true, verifiedAt: true } }),
    db.job.groupBy({ by: ['status'], _count: { _all: true } }),
    db.auditEvent.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: DRILLDOWN_ACTIVITY, select: { id: true, action: true, actorKind: true, result: true, crossWorkspace: true, createdAt: true } }),
  ]);
  const leadTally = tally<SalesStage>(leads, 'salesStage');
  const quoteTally = tally<QuoteStatus>(quotes, 'status');
  const audit = await baseClientOf(ctx).auditEvent.findUniqueOrThrow({ where: { id: elevated.elevated!.auditEventId }, select: { createdAt: true } });

  return {
    audit: { eventId: elevated.elevated!.auditEventId, reason: elevated.elevated!.reason, openedAt: audit.createdAt },
    workspace: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      planLabel: workspace.planLabel,
      timezone: workspace.timezone,
      status: workspace.status,
      mode: workspace.mode,
      automationPaused: workspace.automationPaused,
      automationPauseReason: workspace.automationPauseReason === null ? null : String(redact(workspace.automationPauseReason)),
      createdAt: workspace.createdAt,
    },
    settings: settings
      ? {
          taxMode: settings.taxMode,
          taxLabel: settings.taxLabel,
          taxBps: settings.taxBps,
          maxDiscountBps: settings.maxDiscountBps,
          quoteValidityDays: settings.quoteValidityDays,
          autoSendEnabled: settings.autoSendEnabled,
          emailFallbackEnabled: settings.emailFallbackEnabled,
          emailB2bAttestationEnabled: settings.emailB2bAttestationEnabled,
          bookingLinkSet: settings.bookingUrl !== null,
          gstinSet: settings.gstin !== null,
          internalWaDailyCap: settings.internalWaDailyCap,
          internalEmailDailyCap: settings.internalEmailDailyCap,
        }
      : null,
    configuration: {
      pricingVersion: pricing?.version ?? null,
      services,
      pricedServices: pricing?._count.entries ?? 0,
      scoringVersion: scoring?.version ?? null,
      pipelineVersion: pipeline?.version ?? null,
      approvalMode: pipeline?.approvalMode ?? null,
    },
    leads: { total: leadTally.total, byStage: leadTally.by },
    quotes: { total: quoteTally.total, byStatus: quoteTally.by },
    approvalsPending,
    openConversations,
    activeSuppressions,
    integrations,
    jobs: tally<JobStatus>(jobs, 'status').by,
    recentActivity: recent,
  };
}
