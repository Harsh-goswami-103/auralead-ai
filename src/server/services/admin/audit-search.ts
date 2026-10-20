/**
 * Platform-wide audit search for the super admin (T29, R33).
 *
 * AuditEvent summaries are PII-free by contract (field names, counts, codes; `recordAudit` redacts
 * them on write), so searching them is platform metadata, like the job inspector's correlation
 * timeline (ADR-64), and needs no drilldown. They are redacted again on read, together with the
 * typed reason, so a row written before a redaction rule existed still never shows a contact or a
 * secret. There is no export: the page of redacted rows is the whole answer.
 *
 * Filters combine with AND: actor (a user id, or an email resolved to one), action prefix
 * (`quote.` finds every quote action), target type and id, workspace (id or slug), result,
 * correlation id, and a range of India calendar days (IST, UTC+05:30 all year), both ends
 * inclusive. Keyset pagination, newest first, ties broken by id.
 */
import type { ActorKind, AuditResult, Prisma, PrismaClient } from '@/generated/prisma/client';
import { redact } from '@/lib/redact';
import type { AuditSearchQuery } from '@/lib/schemas/admin-people';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole } from '@/server/auth/guards';
import { normalizeEmail } from '@/server/auth/login';
import type { WorkspaceRef } from './people';

export const AUDIT_PAGE_SIZE = 50;
const AUDIT_PAGE_MAX = 100;
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

export type AuditSearchFilter = AuditSearchQuery & { limit?: number };

export type AuditRow = {
  id: string;
  createdAt: Date;
  action: string;
  actorKind: ActorKind;
  actor: { id: string; name: string; email: string } | null;
  targetType: string;
  targetId: string;
  workspace: WorkspaceRef | null;
  result: AuditResult;
  crossWorkspace: boolean;
  reason: string | null;
  correlationId: string;
  summary: unknown;
};

export type AuditSearchResult = {
  rows: AuditRow[];
  nextCursor: string | null;
  /** The actor email matches no account (the page is empty rather than unfiltered). */
  unknownActor: boolean;
  /** The workspace id or slug matches no workspace. */
  unknownWorkspace: boolean;
};

/** Start of an India calendar day `YYYY-MM-DD` as a UTC instant (plus `days`). */
export function istDayStart(day: string, days = 0): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days) - IST_OFFSET_MS);
}

function empty(flags: Partial<Pick<AuditSearchResult, 'unknownActor' | 'unknownWorkspace'>>): AuditSearchResult {
  return { rows: [], nextCursor: null, unknownActor: false, unknownWorkspace: false, ...flags };
}

export async function searchAudit(ctx: AppCtx, filter: AuditSearchFilter = {}): Promise<AuditSearchResult> {
  requireRole(ctx, 'SUPER_ADMIN');
  const prisma: PrismaClient = baseClientOf(ctx);
  const limit = Math.min(Math.max(filter.limit ?? AUDIT_PAGE_SIZE, 1), AUDIT_PAGE_MAX);
  const and: Prisma.AuditEventWhereInput[] = [];

  const actor = filter.actor?.trim();
  if (actor) {
    if (actor.includes('@')) {
      const user = await prisma.user.findUnique({ where: { email: normalizeEmail(actor) }, select: { id: true } });
      if (!user) return empty({ unknownActor: true });
      and.push({ actorUserId: user.id });
    } else {
      and.push({ actorUserId: actor });
    }
  }
  const workspace = filter.workspace?.trim();
  if (workspace) {
    const ws = await prisma.workspace.findFirst({ where: { OR: [{ id: workspace }, { slug: workspace.toLowerCase() }] }, select: { id: true } });
    if (!ws) return empty({ unknownWorkspace: true });
    and.push({ workspaceId: ws.id });
  }
  if (filter.action?.trim()) and.push({ action: { startsWith: filter.action.trim() } });
  if (filter.targetType?.trim()) and.push({ targetType: filter.targetType.trim() });
  if (filter.targetId?.trim()) and.push({ targetId: filter.targetId.trim() });
  if (filter.result) and.push({ result: filter.result });
  if (filter.correlationId?.trim()) and.push({ correlationId: filter.correlationId.trim() });
  if (filter.from) and.push({ createdAt: { gte: istDayStart(filter.from) } });
  if (filter.to) and.push({ createdAt: { lt: istDayStart(filter.to, 1) } });
  if (filter.before) {
    const cursor = await prisma.auditEvent.findUnique({ where: { id: filter.before }, select: { id: true, createdAt: true } });
    if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
  }

  const events = await prisma.auditEvent.findMany({ where: { AND: and }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
  const page = events.slice(0, limit);
  const userIds = [...new Set(page.map((e) => e.actorUserId).filter((v): v is string => v !== null))];
  const workspaceIds = [...new Set(page.map((e) => e.workspaceId).filter((v): v is string => v !== null))];
  const [users, workspaces] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    workspaceIds.length ? prisma.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, slug: true, name: true } }) : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const wsById = new Map(workspaces.map((w) => [w.id, w]));

  return {
    rows: page.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      action: e.action,
      actorKind: e.actorKind,
      actor: e.actorUserId ? (userById.get(e.actorUserId) ?? null) : null,
      targetType: e.targetType,
      targetId: e.targetId,
      workspace: e.workspaceId ? (wsById.get(e.workspaceId) ?? null) : null,
      result: e.result,
      crossWorkspace: e.crossWorkspace,
      reason: e.reason === null ? null : String(redact(e.reason)),
      correlationId: e.correlationId,
      summary: redact(e.summary),
    })),
    nextCursor: events.length > limit ? (page.at(-1)?.id ?? null) : null,
    unknownActor: false,
    unknownWorkspace: false,
  };
}
