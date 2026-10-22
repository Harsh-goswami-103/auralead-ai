/**
 * The Maps extension receiver (T36; plan §9 Extension (T8, C18), Webhooks, C14; §4.3 "verify,
 * persist, enqueue"; E1/E2). Called by POST and OPTIONS /api/webhooks/gmaps-extension with the raw
 * body already read once (1 MiB cap). Order:
 *
 * 1. Origin: none (a non-browser client) or `chrome-extension://<32 a-p>` only. An http(s) Origin
 *    is 403 `web_origin_forbidden`, anything else (`null`, other schemes) 403 `origin_forbidden`;
 *    both counted in WebhookRejection, nothing stored.
 * 2. Bearer `alx_<keyId>_<secret>` only (cookies are never read): parsed, looked up by prefix, the
 *    secret's sha256 compared in constant time. Then revoked (`token_revoked`), expired
 *    (`token_expired`), the workspace's mode against the process mode (a DEMO workspace's token in a
 *    LIVE process is `token_invalid`), scope `ingest:gmaps` (403 `token_scope_missing`) and, when the
 *    token names an allowed extension id, the extension Origin (403 `extension_not_allowed`). The
 *    row is read on every request, so a revocation applies to the next one. Failures that belong to
 *    a known token are audited (`extension.token.denied`, the prefix and a reason, never a secret;
 *    at most one per minute per token so a guessing client cannot flood the audit log).
 * 3. Rate limit `extension`: 60 batches per minute per token (429 with Retry-After).
 * 4. Body: JSON, at most 200 records (more is 413 `TOO_MANY_RECORDS`), a v1 envelope (400), then
 *    every record on its own: a malformed one is rejected alone (`INVALID_RECORD` with the field
 *    names); a batch with no valid record is 422 `NO_VALID_RECORDS` and nothing is stored.
 * 5. `persistWebhookEvent` (GMAPS_EXTENSION, scope = the token's workspace, external key = batchId,
 *    hash = sha256 of the raw bytes): a new batch is 202 with the intake view per record (QUEUED or
 *    REJECTED); the same bytes again are a replay (200) answered with the stored per-record results
 *    once the worker processed it; the same batch id with other bytes is 409 BATCH_CONTENT_MISMATCH.
 *    The stored body carries the valid records plus the server-written `intake` block (token id,
 *    intake rejections) that `ingest.process` reads.
 * Maps leads get no WhatsApp consent and no invented email: `ingestBatch` (ADR-15, ADR-51).
 * CORS headers go only on answers to the token's allowed `chrome-extension://<id>` Origin.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { AppError, AuthError, DomainRuleError, PayloadTooLargeError, PermissionDeniedError, RateLimitedError, ValidationError, errorToHttp, toAppError } from '@/lib/errors';
import {
  CHROME_EXTENSION_ID_RE,
  EXTENSION_MAX_RECORDS,
  EXTENSION_SCOPE,
  extensionEnvelopeSchema,
  extensionRecordSchema,
  type ExtensionIntakeRejection,
  type ExtensionRecord,
} from '@/lib/schemas/webhooks';
import { getWebhookContext } from '@/server/auth/context';
import { normalizeServerError } from '@/server/auth/http-errors';
import { withTx } from '@/server/db/tx';
import type { RateLimiter } from '@/server/security/rate-limit';
import type { KeyRing } from '@/server/security/secrets';
import { parseExtensionToken, verifyExtensionSecret } from '@/server/security/tokens';
import { recordAudit } from '@/server/services/audit/record';
import { persistWebhookEvent, sha256Hex, type WebhookEventResult } from '@/server/services/webhooks/events';
import { recordWebhookRejection } from '@/server/services/webhooks/rejections';

export type ReceiverDeps = {
  db: PrismaClient;
  clock: Clock;
  correlationId: string;
  mode: 'demo' | 'live';
  keyRing: KeyRing;
  /** The `extension` policy limiter (60 per minute). */
  limiter: RateLimiter;
};

export type ReceiverAnswer = { status: number; headers: Record<string, string>; body: unknown };

export type RecordOutcome = { index: number; recordId: string | null; status: string; reasonCode: string | null; fields?: string[] };

const LAST_USED_EVERY_MS = 60_000;
const CORS_MAX_AGE_SECONDS = 600;
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})$/;

type OriginKind = { kind: 'none' } | { kind: 'extension'; id: string; origin: string } | { kind: 'web' } | { kind: 'other' };

export function classifyOrigin(origin: string | null): OriginKind {
  if (origin === null || origin === '') return { kind: 'none' };
  const m = EXTENSION_ORIGIN_RE.exec(origin);
  if (m) return { kind: 'extension', id: m[1]!, origin };
  if (/^https?:\/\//i.test(origin)) return { kind: 'web' };
  return { kind: 'other' };
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': 'x-request-id, retry-after',
    vary: 'Origin',
  };
}

function tokenError(status: 401 | 403, code: string, userMessage: string): AppError {
  return status === 401 ? new AuthError({ code, userMessage }) : new PermissionDeniedError({ code, userMessage });
}

type TokenRow = {
  id: string;
  workspaceId: string;
  prefix: string;
  secretHash: string;
  scopes: unknown;
  allowedExtensionId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  workspace: { mode: 'DEMO' | 'LIVE' };
};

class Receiver {
  private corsOrigin: string | null = null;

  constructor(private readonly deps: ReceiverDeps) {}

  private async reject(reason: string, error: AppError, workspaceId: string | null = null): Promise<never> {
    await recordWebhookRejection(this.deps.db, this.deps.clock, { provider: 'GMAPS_EXTENSION', reason, workspaceId });
    throw error;
  }

  private async deny(token: TokenRow, reason: string, error: AppError, rejection: string): Promise<never> {
    // One audit row per token and minute at most (a client guessing secrets cannot flood the log).
    if (this.deps.limiter.take(`denied-audit:${token.id}`, this.deps.limiter.policy.limit).allowed) {
      const ctx = getWebhookContext({ workspaceId: token.workspaceId }, { prisma: this.deps.db, mode: this.deps.mode, clock: this.deps.clock }, this.deps.correlationId);
      await withTx(this.deps.db, (tx) =>
        recordAudit(tx, ctx, { action: 'extension.token.denied', targetType: 'ExtensionToken', targetId: token.id, workspaceId: token.workspaceId, result: 'DENIED', summary: { reason, prefix: token.prefix } }),
      );
    }
    return this.reject(rejection, error, token.workspaceId);
  }

  private async authenticate(authorization: string | null, origin: OriginKind): Promise<TokenRow> {
    if (!authorization) return this.reject('TOKEN_MISSING', tokenError(401, 'token_missing', 'Send the ingestion token as "Authorization: Bearer alx_...".'));
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    const parts = m ? parseExtensionToken(m[1]!) : null;
    const invalid = () => tokenError(401, 'token_invalid', 'The ingestion token is not recognized. Create a token in the Extension hub.');
    if (!parts) return this.reject('TOKEN_MALFORMED', invalid());
    const token = (await this.deps.db.extensionToken.findUnique({
      where: { prefix: parts.prefix },
      select: { id: true, workspaceId: true, prefix: true, secretHash: true, scopes: true, allowedExtensionId: true, lastUsedAt: true, expiresAt: true, revokedAt: true, workspace: { select: { mode: true } } },
    })) as TokenRow | null;
    if (!token) return this.reject('TOKEN_UNKNOWN', invalid());
    if (!verifyExtensionSecret(parts.secret, token.secretHash)) return this.deny(token, 'SECRET_MISMATCH', invalid(), 'TOKEN_INVALID');
    if (token.revokedAt) return this.deny(token, 'REVOKED', tokenError(401, 'token_revoked', 'This ingestion token was revoked. Create a new token in the Extension hub.'), 'TOKEN_REVOKED');
    const now = this.deps.clock.now();
    if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
      return this.deny(token, 'EXPIRED', tokenError(401, 'token_expired', 'This ingestion token has expired. Create a new token in the Extension hub.'), 'TOKEN_EXPIRED');
    }
    if (token.workspace.mode !== (this.deps.mode === 'live' ? 'LIVE' : 'DEMO')) return this.deny(token, 'MODE_MISMATCH', invalid(), 'TOKEN_INVALID');
    const scopes = Array.isArray(token.scopes) ? token.scopes : [];
    if (!scopes.includes(EXTENSION_SCOPE)) {
      return this.deny(token, 'SCOPE_MISSING', tokenError(403, 'token_scope_missing', `This token does not carry the ${EXTENSION_SCOPE} scope.`), 'TOKEN_SCOPE');
    }
    if (origin.kind === 'extension' && token.allowedExtensionId !== null && token.allowedExtensionId !== origin.id) {
      return this.deny(
        token,
        'EXTENSION_NOT_ALLOWED',
        tokenError(403, 'extension_not_allowed', 'This token is bound to another Chrome extension id. Check the allowed extension id in the Extension hub.'),
        'EXTENSION_NOT_ALLOWED',
      );
    }
    if (origin.kind === 'extension' && token.allowedExtensionId === origin.id) this.corsOrigin = origin.origin;
    return token;
  }

  private async touch(token: TokenRow): Promise<void> {
    const now = this.deps.clock.now();
    if (token.lastUsedAt && now.getTime() - token.lastUsedAt.getTime() < LAST_USED_EVERY_MS) return;
    await withTx(this.deps.db, (tx) => tx.extensionToken.update({ where: { id: token.id }, data: { lastUsedAt: now } }));
  }

  async receive(request: { authorization: string | null; origin: string | null; raw: Buffer }): Promise<ReceiverAnswer> {
    const origin = classifyOrigin(request.origin);
    if (origin.kind === 'web') await this.reject('WEB_ORIGIN', tokenError(403, 'web_origin_forbidden', 'Web pages cannot send extension batches.'));
    if (origin.kind === 'other') await this.reject('ORIGIN_FORBIDDEN', tokenError(403, 'origin_forbidden', 'Only the Chrome extension may send batches here.'));

    const token = await this.authenticate(request.authorization, origin);
    const decision = this.deps.limiter.take(`extension:${token.id}`);
    if (!decision.allowed) throw new RateLimitedError({ retryAfterSeconds: decision.retryAfterSeconds, userMessage: 'Too many batches from this token. The bridge retries later.' });
    await this.touch(token);

    let json: unknown;
    try {
      json = JSON.parse(request.raw.toString('utf8')) as unknown;
    } catch (error) {
      throw new ValidationError({ code: 'INVALID_JSON', userMessage: 'The request body is not valid JSON.', cause: error });
    }
    const records = (json as { records?: unknown } | null)?.records;
    if (Array.isArray(records) && records.length > EXTENSION_MAX_RECORDS) {
      throw new PayloadTooLargeError({ code: 'TOO_MANY_RECORDS', userMessage: `A batch holds at most ${EXTENSION_MAX_RECORDS} records. Split it.` });
    }
    const envelope = extensionEnvelopeSchema.parse(json);

    const valid: Array<{ index: number; record: ExtensionRecord }> = [];
    const rejected: ExtensionIntakeRejection[] = [];
    envelope.records.forEach((raw, index) => {
      const parsed = extensionRecordSchema.safeParse(raw);
      if (parsed.success) {
        valid.push({ index, record: parsed.data });
        return;
      }
      const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? 'record')))].slice(0, 32);
      const id = (raw as { recordId?: unknown } | null)?.recordId;
      const recordId = typeof id === 'string' && id.trim().length > 0 && id.length <= 256 ? id.trim() : null;
      rejected.push({ index, recordId, reasonCode: 'INVALID_RECORD', fields });
    });
    const intakeView = (r: ExtensionIntakeRejection): RecordOutcome => ({ index: r.index, recordId: r.recordId, status: 'REJECTED', reasonCode: r.reasonCode, fields: r.fields });
    if (valid.length === 0) {
      throw new DomainRuleError({ code: 'NO_VALID_RECORDS', userMessage: 'No record of this batch is valid. Nothing was stored.', safeDetails: { records: rejected.map(intakeView) } });
    }

    const body = {
      version: 1 as const,
      batchId: envelope.batchId,
      ...(envelope.keyword !== undefined ? { keyword: envelope.keyword } : {}),
      records: valid.map((v) => v.record),
      intake: { extensionTokenId: token.id, rejected },
    };
    const ctx = getWebhookContext({ workspaceId: token.workspaceId }, { prisma: this.deps.db, mode: this.deps.mode, clock: this.deps.clock }, this.deps.correlationId);
    const persisted = await persistWebhookEvent(
      this.deps.db,
      ctx,
      { provider: 'GMAPS_EXTENSION', workspaceId: token.workspaceId, integrationId: null, externalKey: envelope.batchId, body, bodySha256: sha256Hex(request.raw), simulated: false, processJob: 'ingest.process' },
      { keyRing: this.deps.keyRing },
    );

    const result: WebhookEventResult | null = persisted.result;
    const ingested = result?.kind === 'ingest' ? result.records.slice(0, valid.length) : null;
    const outcomes: RecordOutcome[] = [];
    let v = 0;
    let r = 0;
    for (let index = 0; index < envelope.records.length; index += 1) {
      if (r < rejected.length && rejected[r]!.index === index) {
        outcomes.push(intakeView(rejected[r]!));
        r += 1;
        continue;
      }
      const item = valid[v]!;
      const stored = ingested?.[v];
      v += 1;
      if (stored) outcomes.push({ index, recordId: item.record.recordId, status: stored.status, reasonCode: stored.reasonCode });
      else if (result?.kind === 'failed') outcomes.push({ index, recordId: item.record.recordId, status: 'FAILED', reasonCode: result.code });
      else outcomes.push({ index, recordId: item.record.recordId, status: 'QUEUED', reasonCode: null });
    }
    const answer = {
      batchId: envelope.batchId,
      eventId: persisted.eventId,
      outcome: persisted.outcome,
      status: persisted.status,
      received: envelope.records.length,
      queued: valid.length,
      rejected: rejected.length,
      ...(result?.kind === 'ingest' ? { batchStatus: result.batchStatus, counts: result.counts } : {}),
      ...(result?.kind === 'failed' ? { failure: { code: result.code } } : {}),
      records: outcomes,
    };
    return { status: persisted.outcome === 'ACCEPTED' ? 202 : 200, headers: {}, body: answer };
  }

  /** Renders a 4xx AppError as the JSON error body; anything else is rethrown (500, logged by the route). */
  answerError(thrown: unknown): ReceiverAnswer {
    const error = toAppError(normalizeServerError(thrown));
    if (error.status >= 500) throw thrown;
    const http = errorToHttp(error, this.deps.correlationId);
    return { status: http.status, headers: http.headers, body: http.body };
  }

  withCors(answer: ReceiverAnswer): ReceiverAnswer {
    return this.corsOrigin ? { ...answer, headers: { ...answer.headers, ...corsHeaders(this.corsOrigin) } } : answer;
  }
}

export async function receiveExtensionBatch(deps: ReceiverDeps, request: { authorization: string | null; origin: string | null; raw: Buffer }): Promise<ReceiverAnswer> {
  const receiver = new Receiver(deps);
  let answer: ReceiverAnswer;
  try {
    answer = await receiver.receive(request);
  } catch (thrown) {
    answer = receiver.answerError(thrown);
  }
  return receiver.withCors(answer);
}

/**
 * CORS preflight (C18): answered only for `chrome-extension://<id>` when a live (not revoked, not
 * expired) token of this process's mode names that id as its allowed extension. Everything else is
 * 403 without CORS headers. Credentials are never allowed (the token is a bearer header).
 */
export async function answerExtensionPreflight(deps: Pick<ReceiverDeps, 'db' | 'clock' | 'mode'>, request: { origin: string | null }): Promise<ReceiverAnswer> {
  const origin = classifyOrigin(request.origin);
  const refused: ReceiverAnswer = { status: 403, headers: {}, body: null };
  if (origin.kind !== 'extension' || !CHROME_EXTENSION_ID_RE.test(origin.id)) return refused;
  const now = deps.clock.now();
  const token = await deps.db.extensionToken.findFirst({
    where: { allowedExtensionId: origin.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], workspace: { mode: deps.mode === 'live' ? 'LIVE' : 'DEMO' } },
    select: { id: true },
  });
  if (!token) return refused;
  return {
    status: 204,
    headers: {
      ...corsHeaders(origin.origin),
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-request-id',
      'access-control-max-age': String(CORS_MAX_AGE_SECONDS),
    },
    body: null,
  };
}
