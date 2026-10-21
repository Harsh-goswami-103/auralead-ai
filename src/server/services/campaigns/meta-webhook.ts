/**
 * Meta Lead Ads webhook persistence (T35; plan §4.3 "verify, persist, enqueue, 200", §9 Webhooks,
 * E1/ADR-35, E2/ADR-36). Called by POST /api/webhooks/meta-ads after the raw-body signature
 * check, with the parsed Page delivery.
 *
 * - Only `field: "leadgen"` changes are lead notifications; any other change is counted as
 *   ignored. A change whose ids are not digits, or whose `page_id` differs from its entry's Page
 *   id, is counted INVALID and stored nowhere.
 * - Routing is by `page_id` through `Integration.routingKey`, only to a META_ADS integration of a
 *   workspace in this process's mode; never by anything else in the payload. An unknown Page is
 *   stored UNROUTED with no processing job (30-day purge), so it can be inspected.
 * - Each notification is one WebhookEvent `meta:{page}:{leadgen}`, scoped by the routed
 *   integration (E2), whose body is the change value (ids only); `bodySha256` is the hash of that
 *   item's canonical JSON (the raw body, which covers the whole delivery, was verified by the
 *   route). A redelivery is a duplicate (no second event or job); the same key with different
 *   content is reported CONFLICT and not stored (a 409 would make Meta retry forever).
 * - A routed event enqueues `meta.lead.fetch`, which reads the lead from the Graph API in the
 *   worker; the webhook itself never calls Meta.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { IdempotencyConflictError } from '@/lib/errors';
import type { MetaPageWebhook } from '@/lib/schemas/meta';
import { META_ID_RE } from '@/lib/schemas/meta';
import { metaLeadgenChangeSchema, type MetaLeadgenChange } from '@/lib/schemas/webhooks';
import type { KeyRing } from '@/server/security/secrets';
import { canonicalJson, META_LEAD_FETCH_JOB, persistWebhookEvent, sha256Hex } from '@/server/services/webhooks/events';

export type MetaWebhookItem = {
  externalKey: string | null;
  outcome: 'ACCEPTED' | 'DUPLICATE' | 'CONFLICT' | 'INVALID';
  eventId: string | null;
  routed: boolean;
};

export type MetaWebhookSummary = { items: MetaWebhookItem[]; ignored: number; integrationIds: string[] };

export type MetaRouting = { workspaceId: string; integrationId: string } | null;

/** Routing by `page_id` (Integration.routingKey), only to a Meta Lead Ads integration of a workspace in this process's mode. */
export async function routeByPageId(db: PrismaClient, mode: 'demo' | 'live', pageId: string): Promise<MetaRouting> {
  const integration = await db.integration.findUnique({ where: { routingKey: pageId }, select: { id: true, workspaceId: true, kind: true } });
  if (!integration || integration.kind !== 'META_ADS') return null;
  const workspace = await db.workspace.findUnique({ where: { id: integration.workspaceId }, select: { mode: true } });
  if (!workspace || workspace.mode !== (mode === 'demo' ? 'DEMO' : 'LIVE')) return null;
  return { workspaceId: integration.workspaceId, integrationId: integration.id };
}

/** The leadgen changes of a delivery with their entry's Page id, plus how many changes were not leadgen. */
export function leadgenChangesOf(payload: MetaPageWebhook): { changes: Array<{ entryPageId: string; value: unknown }>; ignored: number } {
  const changes: Array<{ entryPageId: string; value: unknown }> = [];
  let ignored = 0;
  for (const entry of payload.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field === 'leadgen') changes.push({ entryPageId: entry.id, value: change.value });
      else ignored += 1;
    }
  }
  return { changes, ignored };
}

/**
 * The routing of every Page a delivery names (one lookup per Page), so the route can apply the
 * per-integration rate limit before anything is persisted.
 */
export async function routePages(db: PrismaClient, mode: 'demo' | 'live', payload: MetaPageWebhook): Promise<Map<string, MetaRouting>> {
  const routes = new Map<string, MetaRouting>();
  for (const { entryPageId, value } of leadgenChangesOf(payload).changes) {
    const change = validChange(entryPageId, value);
    if (change && !routes.has(change.page_id)) routes.set(change.page_id, await routeByPageId(db, mode, change.page_id));
  }
  return routes;
}

function validChange(entryPageId: string, value: unknown): MetaLeadgenChange | null {
  const parsed = metaLeadgenChangeSchema.safeParse(value);
  if (!parsed.success) return null;
  const c = parsed.data;
  if (![c.leadgen_id, c.page_id, c.form_id].every((id) => META_ID_RE.test(id))) return null;
  if (c.page_id !== entryPageId) return null;
  return c;
}

export async function receiveMetaLeadgenWebhook(
  db: PrismaClient,
  ctx: { clock: Clock; correlationId: string },
  payload: MetaPageWebhook,
  deps: { keyRing: KeyRing; mode: 'demo' | 'live'; routes?: Map<string, MetaRouting> },
): Promise<MetaWebhookSummary> {
  const { changes, ignored } = leadgenChangesOf(payload);
  const items: MetaWebhookItem[] = [];
  const integrationIds = new Set<string>();
  const routes = deps.routes ?? new Map<string, MetaRouting>();
  for (const { entryPageId, value } of changes) {
    const change = validChange(entryPageId, value);
    if (!change) {
      items.push({ externalKey: null, outcome: 'INVALID', eventId: null, routed: false });
      continue;
    }
    if (!routes.has(change.page_id)) routes.set(change.page_id, await routeByPageId(db, deps.mode, change.page_id));
    const route = routes.get(change.page_id) ?? null;
    if (route) integrationIds.add(route.integrationId);
    const externalKey = `meta:${change.page_id}:${change.leadgen_id}`;
    try {
      const persisted = await persistWebhookEvent(
        db,
        { kind: 'webhook', actor: null, workspaceId: route?.workspaceId ?? null, correlationId: ctx.correlationId, clock: ctx.clock },
        {
          provider: 'META_ADS',
          workspaceId: route?.workspaceId ?? null,
          integrationId: route?.integrationId ?? null,
          externalKey,
          body: change,
          bodySha256: sha256Hex(canonicalJson(change)),
          simulated: false,
          processJob: META_LEAD_FETCH_JOB,
        },
        { keyRing: deps.keyRing },
      );
      items.push({ externalKey, outcome: persisted.outcome, eventId: persisted.eventId, routed: route !== null });
    } catch (error) {
      if (!(error instanceof IdempotencyConflictError)) throw error;
      items.push({ externalKey, outcome: 'CONFLICT', eventId: null, routed: route !== null });
    }
  }
  return { items, ignored, integrationIds: [...integrationIds] };
}
