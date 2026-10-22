/**
 * Extension hub read model (T36; PRD "Extension hub (scoped keys, revocation, webhook config,
 * batch status, errors, simulation)"; 06-design §11.2.2). It extends the T28 view
 * (`getExtensionHub`: tokens by prefix and state, ImportBatch rows, per-row issues, the example
 * payload, the simulation gate) with what the live parts need:
 * - the webhook URL the bridge posts to (`APP_ORIGIN` + the receiver path);
 * - whether the viewer may create and revoke tokens (`extension.manage`, a permission gate
 *   otherwise), the active-token count and the limit;
 * - every recent delivery (WebhookEvent), queued ones included, with the sending token's prefix and
 *   name, its state, counts and the records that failed (rejected at intake or by ingestion, and
 *   records sent to merge review) with their reason codes;
 * - refused uses of this workspace's tokens (revoked, expired, wrong secret, wrong extension) from
 *   the `extension.token.denied` audit, so an operator can see why a bridge stopped.
 * Secrets never appear: tokens are read by prefix, the hash is never selected.
 */
import { EXTENSION_TOKEN_ACTIVE_LIMIT, EXTENSION_WEBHOOK_PATH } from '@/lib/schemas/webhooks';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability } from '@/server/auth/guards';
import { getExtensionHub, type ExtensionHubView } from '@/server/services/integrations/source-pages';
import type { WebhookEventResult } from '@/server/services/webhooks/events';

export type DeliveryFailure = { recordId: string; status: string; reasonCode: string | null };

export type ExtensionDelivery = {
  eventId: string;
  batchId: string;
  state: 'QUEUED' | 'PROCESSED' | 'FAILED' | 'OTHER';
  batchStatus: 'COMPLETED' | 'PARTIAL' | 'FAILED' | null;
  simulated: boolean;
  receivedAt: Date;
  processedAt: Date | null;
  counts: { received: number; accepted: number; duplicate: number; review: number; rejected: number } | null;
  failureCode: string | null;
  tokenPrefix: string | null;
  tokenName: string | null;
  failures: DeliveryFailure[];
  /** Failures beyond the ones listed. */
  moreFailures: number;
};

export type TokenDenial = { at: Date; prefix: string | null; reason: string };

export type ExtensionHubDetails = ExtensionHubView & {
  webhookUrl: string;
  manageGate: { category: 'permission'; reason: string } | null;
  activeTokens: number;
  tokenLimit: number;
  deliveries: ExtensionDelivery[];
  denials: TokenDenial[];
};

const DELIVERY_LIMIT = 15;
const FAILURE_LIMIT = 25;
const DENIAL_LIMIT = 10;

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function intakeOf(payloadRedacted: unknown): { tokenId: string | null; rejected: DeliveryFailure[] } {
  const intake = obj(obj(payloadRedacted).intake);
  const tokenId = typeof intake.extensionTokenId === 'string' ? intake.extensionTokenId : null;
  const rejected = Array.isArray(intake.rejected)
    ? intake.rejected.map((r) => {
        const row = obj(r);
        return { recordId: typeof row.recordId === 'string' ? row.recordId : `#${String(row.index ?? '?')}`, status: 'REJECTED', reasonCode: typeof row.reasonCode === 'string' ? row.reasonCode : null };
      })
    : [];
  return { tokenId, rejected };
}

export async function getExtensionHubDetails(ctx: AppCtx, options: { appOrigin: string }): Promise<ExtensionHubDetails> {
  const base = await getExtensionHub(ctx);
  const now = ctx.clock.now();
  const tokens = await ctx.db.extensionToken.findMany({ select: { id: true, prefix: true, name: true } });
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const events = await ctx.db.webhookEvent.findMany({
    where: { provider: 'GMAPS_EXTENSION' },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: DELIVERY_LIMIT,
    select: { id: true, externalKey: true, status: true, simulated: true, receivedAt: true, processedAt: true, result: true, payloadRedacted: true },
  });
  const deliveries = events.map((e): ExtensionDelivery => {
    const result = (e.result as WebhookEventResult | null) ?? null;
    const intake = intakeOf(e.payloadRedacted);
    const token = intake.tokenId ? byId.get(intake.tokenId) : undefined;
    const failures =
      result?.kind === 'ingest'
        ? result.records.filter((r) => r.status === 'REJECTED' || r.status === 'REVIEW' || r.status === 'UNRETRIEVABLE').map((r) => ({ recordId: r.externalId, status: r.status, reasonCode: r.reasonCode }))
        : intake.rejected;
    return {
      eventId: e.id,
      batchId: e.externalKey,
      state: e.status === 'RECEIVED' ? 'QUEUED' : e.status === 'PROCESSED' ? 'PROCESSED' : e.status === 'FAILED' ? 'FAILED' : 'OTHER',
      batchStatus: result?.kind === 'ingest' ? result.batchStatus : null,
      simulated: e.simulated,
      receivedAt: e.receivedAt,
      processedAt: e.processedAt,
      counts: result?.kind === 'ingest' ? result.counts : null,
      failureCode: result?.kind === 'failed' ? result.code : null,
      tokenPrefix: token?.prefix ?? null,
      tokenName: token?.name ?? null,
      failures: failures.slice(0, FAILURE_LIMIT),
      moreFailures: Math.max(0, failures.length - FAILURE_LIMIT),
    };
  });
  const denialRows = await ctx.db.auditEvent.findMany({
    where: { action: 'extension.token.denied' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: DENIAL_LIMIT,
    select: { createdAt: true, summary: true },
  });
  const canManage = hasCapability(ctx, 'extension.manage');
  return {
    ...base,
    webhookUrl: `${options.appOrigin.replace(/\/+$/, '')}${EXTENSION_WEBHOOK_PATH}`,
    manageGate: canManage ? null : { category: 'permission', reason: 'Creating and revoking ingestion tokens needs the “Manage extension” capability in this workspace. A super admin can grant it.' },
    activeTokens: base.tokens.filter((t) => t.state === 'ACTIVE' && (!t.expiresAt || t.expiresAt.getTime() > now.getTime())).length,
    tokenLimit: EXTENSION_TOKEN_ACTIVE_LIMIT,
    deliveries,
    denials: denialRows.map((d) => {
      const s = obj(d.summary);
      return { at: d.createdAt, prefix: typeof s.prefix === 'string' ? s.prefix : null, reason: typeof s.reason === 'string' ? s.reason : 'UNKNOWN' };
    }),
  };
}
