/**
 * Webhook inspector (R33, T24): the super admin's read-only view of stored webhook deliveries.
 * Shows the redacted inspector payload (`payloadRedacted`, never the encrypted processing payload,
 * which is not decrypted here), status, attempts, the stored per-record result, whether the
 * processing payload is still held or was purged, and the jobs that processed the event (their
 * payload names the event id; retry and cancel happen on those jobs in the job inspector).
 * Rejected deliveries are never stored; their daily counters (`WebhookRejection`) are listed.
 */
import type { WebhookProvider, WebhookStatus } from '@/generated/prisma/client';
import { NotFoundError } from '@/lib/errors';
import { redact } from '@/lib/redact';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole } from '@/server/auth/guards';
import { jobLabel } from '@/server/services/jobs-admin/inspector';

export const WEBHOOK_STATUSES: readonly WebhookStatus[] = ['RECEIVED', 'PROCESSED', 'FAILED', 'UNROUTED', 'PENDING_CORRELATION', 'ORPHAN'];
export const WEBHOOK_PROVIDERS: readonly WebhookProvider[] = ['META_ADS', 'WHATSAPP', 'GOOGLE_SHEETS', 'GMAPS_EXTENSION', 'RESEND', 'DEMO'];

export type WebhookFilter = { status?: WebhookStatus; provider?: WebhookProvider; before?: string; limit?: number };

export type WebhookRow = {
  id: string;
  provider: WebhookProvider;
  status: WebhookStatus;
  workspace: { id: string; slug: string; name: string } | null;
  externalKey: string;
  attempts: number;
  simulated: boolean;
  receivedAt: Date;
  processedAt: Date | null;
  payloadHeld: boolean;
};

const LIMIT_MAX = 100;

function prismaOf(ctx: AppCtx) {
  requireRole(ctx, 'SUPER_ADMIN');
  return baseClientOf(ctx);
}

export async function listWebhookEvents(ctx: AppCtx, filter: WebhookFilter = {}): Promise<{ rows: WebhookRow[]; nextCursor: string | null; rejections: Array<{ provider: WebhookProvider; reason: string; day: Date; count: number }> }> {
  const prisma = prismaOf(ctx);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), LIMIT_MAX);
  const cursor = filter.before ? await prisma.webhookEvent.findUnique({ where: { id: filter.before }, select: { id: true, receivedAt: true } }) : null;
  const events = await prisma.webhookEvent.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.provider ? { provider: filter.provider } : {}),
      ...(cursor ? { OR: [{ receivedAt: { lt: cursor.receivedAt } }, { receivedAt: cursor.receivedAt, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, provider: true, status: true, workspaceId: true, externalKey: true, attempts: true, simulated: true, receivedAt: true, processedAt: true, processingPayload: true },
  });
  const page = events.slice(0, limit);
  const wsIds = [...new Set(page.map((e) => e.workspaceId).filter((v): v is string => v !== null))];
  const workspaces = new Map((await prisma.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, slug: true, name: true } })).map((w) => [w.id, w]));
  const rejections = await prisma.webhookRejection.findMany({ orderBy: [{ day: 'desc' }, { provider: 'asc' }], take: 20, select: { provider: true, reason: true, day: true, count: true } });
  return {
    rows: page.map((e) => ({
      id: e.id,
      provider: e.provider,
      status: e.status,
      workspace: e.workspaceId ? (workspaces.get(e.workspaceId) ?? null) : null,
      externalKey: e.externalKey,
      attempts: e.attempts,
      simulated: e.simulated,
      receivedAt: e.receivedAt,
      processedAt: e.processedAt,
      payloadHeld: e.processingPayload !== null,
    })),
    nextCursor: events.length > limit ? (page.at(-1)?.id ?? null) : null,
    rejections,
  };
}

export type WebhookDetail = WebhookRow & {
  scopeKey: string;
  bodySha256: string;
  payloadRedacted: unknown;
  result: unknown;
  processingPurgedAt: Date | null;
  jobs: Array<{ id: string; type: string; status: string; label: string; attempts: number; createdAt: Date }>;
};

export async function getWebhookEventDetail(ctx: AppCtx, eventId: string): Promise<WebhookDetail> {
  const prisma = prismaOf(ctx);
  const e = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!e) throw new NotFoundError();
  const workspace = e.workspaceId ? await prisma.workspace.findUnique({ where: { id: e.workspaceId }, select: { id: true, slug: true, name: true } }) : null;
  // Jobs that processed this event name its id in their payload (ids only, plan §4.3); payload JSON
  // is never filtered in SQL, so the event's workspace jobs are matched here.
  const candidates = await prisma.job.findMany({ where: { workspaceId: e.workspaceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2000, select: { id: true, type: true, status: true, attempts: true, runAt: true, deadReason: true, cancelRequestedAt: true, createdAt: true, payload: true } });
  const now = ctx.clock.now();
  const jobs = candidates
    .filter((j) => Object.values((j.payload ?? {}) as Record<string, unknown>).includes(e.id))
    .map((j) => ({ id: j.id, type: j.type, status: j.status, label: jobLabel(j, now), attempts: j.attempts, createdAt: j.createdAt }));
  return {
    id: e.id,
    provider: e.provider,
    status: e.status,
    workspace,
    externalKey: e.externalKey,
    attempts: e.attempts,
    simulated: e.simulated,
    receivedAt: e.receivedAt,
    processedAt: e.processedAt,
    payloadHeld: e.processingPayload !== null,
    scopeKey: e.scopeKey,
    bodySha256: e.bodySha256,
    payloadRedacted: redact(e.payloadRedacted),
    result: redact(e.result),
    processingPurgedAt: e.processingPurgedAt,
    jobs,
  };
}
