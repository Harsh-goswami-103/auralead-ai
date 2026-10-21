/**
 * The Apps Script push receiver (T34; plan §9 Webhooks, §4.3, A34, C14, E1, E2, R8, AT3). Called by
 * POST /api/webhooks/google-sheets with the raw body (read once, 256 KB cap) and its headers:
 *  1. `X-AuraLead-Key-Id`, `-Timestamp`, `-Event-Id` and `-Signature` must be well formed
 *     (SIGNATURE_MISSING); the key id resolves the integration through `Integration.routingKey`,
 *     only a GOOGLE_SHEETS integration of a workspace in this process's mode (KEY_UNKNOWN); its
 *     `appsScriptSecret` must decrypt (SECRET_NOT_CONFIGURED). A Sheet URL or a sheet id in the body
 *     authorizes nothing.
 *  2. HMAC-SHA256 over `timestamp.eventId.body` compared in constant time (SIGNATURE_INVALID), then
 *     the timestamp within 300 s either way (REPLAY_WINDOW). Every rejection so far is a 401 that
 *     increments the WebhookRejection counter and persists nothing.
 *  3. Rate limit `appsScript` (120/min/integration), counted only for authenticated deliveries, so
 *     forged traffic cannot use up a workspace's budget.
 *  4. JSON (INVALID_JSON 400), at most 50 rows (TOO_MANY_ROWS 413), the push schema (INVALID_PAYLOAD
 *     400), the header event id equal to the body's (EVENT_ID_MISMATCH 400), the configured sheet
 *     (SHEET_MISMATCH 422).
 *  5. A delivery whose event id was already received in this integration's scope answers its stored
 *     result (200; a different body is 409 BATCH_CONTENT_MISMATCH). A new one must match the active
 *     mapping (MAPPING_NOT_CONFIRMED / MAPPING_SUPERSEDED 409) and its header the mapping's
 *     fingerprint (HEADER_DRIFT 409 with the column diff).
 *  6. Rows without `rowKey` get a weak content-hash id, flagged; then `persistWebhookEvent` stores the
 *     redacted view and the encrypted processing payload, scoped by the integration (E2: the same
 *     event id in two workspaces is two events), and enqueues `ingest.process`, which runs the rows
 *     through `ingestBatch` with the mapping's consent column (P1).
 */
import type { PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { AuthError, ConflictError, DomainRuleError, PayloadTooLargeError, RateLimitedError, SignatureInvalidError, ValidationError, type AppError } from '@/lib/errors';
import { sheetsPushInSchema, SHEETS_MAX_ROWS, type SheetsPush } from '@/lib/schemas/webhooks';
import type { RateLimiter } from '@/server/security/rate-limit';
import { credentialAad, decryptSecretString, type KeyRing } from '@/server/security/secrets';
import type { AuditCtx } from '@/server/services/audit/record';
import { persistWebhookEvent, scopeKeyFor, sha256Hex, type PersistWebhookResult } from '@/server/services/webhooks/events';
import { recordWebhookRejection } from '@/server/services/webhooks/rejections';
import { analyzeHeader, columnDiff } from './header';
import { loadActiveMapping } from './mapping';
import { weakRowKey } from './rows';
import { APPS_SCRIPT_SECRET_FIELD } from './secret';
import { SHEETS_EVENT_ID_RE, SHEETS_KEY_ID_RE, SHEETS_SIGNATURE_HEADERS, SHEETS_TIMESTAMP_RE, verifySheetsSignature, withinReplayWindow } from './signature';

export type SheetsWebhookDeps = {
  db: PrismaClient;
  clock: Clock;
  correlationId: string;
  keyRing: KeyRing | null;
  mode: 'demo' | 'live';
  limiter: RateLimiter;
};

export type SheetsPushResponse = {
  outcome: PersistWebhookResult['outcome'];
  eventId: string;
  rows: number;
  weakIdRows: number;
  status: string;
  result: PersistWebhookResult['result'];
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function receiveSheetsPush(deps: SheetsWebhookDeps, headers: Headers, raw: Buffer): Promise<SheetsPushResponse> {
  let workspaceId: string | null = null;
  const reject = async (reason: string, error: AppError): Promise<never> => {
    await recordWebhookRejection(deps.db, deps.clock, { provider: 'GOOGLE_SHEETS', reason, workspaceId });
    throw error;
  };

  const keyId = headers.get(SHEETS_SIGNATURE_HEADERS.keyId) ?? '';
  const timestamp = headers.get(SHEETS_SIGNATURE_HEADERS.timestamp) ?? '';
  const eventId = headers.get(SHEETS_SIGNATURE_HEADERS.eventId) ?? '';
  const signature = headers.get(SHEETS_SIGNATURE_HEADERS.signature) ?? '';
  if (!SHEETS_KEY_ID_RE.test(keyId) || !SHEETS_TIMESTAMP_RE.test(timestamp) || !SHEETS_EVENT_ID_RE.test(eventId) || signature === '') {
    return reject('SIGNATURE_MISSING', new SignatureInvalidError({ code: 'SIGNATURE_MISSING', message: 'Apps Script signature headers are missing or malformed' }));
  }

  const integration = await deps.db.integration.findUnique({
    where: { routingKey: keyId },
    select: { id: true, workspaceId: true, kind: true, status: true, config: true, secrets: true, workspace: { select: { mode: true } } },
  });
  if (!integration || integration.kind !== 'GOOGLE_SHEETS' || integration.workspace.mode !== (deps.mode === 'live' ? 'LIVE' : 'DEMO')) {
    return reject('KEY_UNKNOWN', new SignatureInvalidError({ code: 'KEY_UNKNOWN', message: 'unknown Apps Script key id' }));
  }
  workspaceId = integration.workspaceId;
  const envelope = record(integration.secrets)[APPS_SCRIPT_SECRET_FIELD];
  let secret = '';
  if (typeof envelope === 'string' && deps.keyRing) {
    try {
      secret = decryptSecretString(deps.keyRing, envelope, credentialAad({ workspaceId: integration.workspaceId, integrationId: integration.id, field: APPS_SCRIPT_SECRET_FIELD }));
    } catch {
      secret = '';
    }
  }
  if (!secret) return reject('SECRET_NOT_CONFIGURED', new AuthError({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'the Apps Script secret is not set or not readable' }));
  if (!verifySheetsSignature(secret, timestamp, eventId, raw, signature)) return reject('SIGNATURE_INVALID', new SignatureInvalidError());
  if (!withinReplayWindow(timestamp, deps.clock.now())) {
    return reject('REPLAY_WINDOW', new AuthError({ code: 'REPLAY_WINDOW', message: 'the push timestamp is more than 300 s from the server time', userMessage: 'The request timestamp is outside the allowed window. Check the clock and send again.' }));
  }

  const decision = deps.limiter.take(`integration:${integration.id}`);
  if (!decision.allowed) throw new RateLimitedError({ retryAfterSeconds: decision.retryAfterSeconds });

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return reject('INVALID_JSON', new ValidationError({ code: 'INVALID_JSON', userMessage: 'The push body is not valid JSON.' }));
  }
  const rows = record(body).rows;
  if (Array.isArray(rows) && rows.length > SHEETS_MAX_ROWS) {
    return reject('TOO_MANY_ROWS', new PayloadTooLargeError({ code: 'TOO_MANY_ROWS', userMessage: `A push carries at most ${SHEETS_MAX_ROWS} rows.` }));
  }
  const parsed = sheetsPushInSchema.safeParse(body);
  if (!parsed.success) return reject('INVALID_PAYLOAD', new ValidationError({ code: 'INVALID_PAYLOAD', userMessage: 'The push body is not an AuraLead Sheets push (version 1).' }));
  const push = parsed.data;
  if (push.eventId !== eventId) return reject('EVENT_ID_MISMATCH', new ValidationError({ code: 'EVENT_ID_MISMATCH', userMessage: 'The event id header differs from the body’s eventId.' }));
  const sheetId = record(integration.config).sheetId;
  if (push.sheetId !== sheetId) return reject('SHEET_MISMATCH', new DomainRuleError({ code: 'SHEET_MISMATCH', userMessage: 'This script was made for another spreadsheet. Copy the script from this workspace’s Google Sheets page.' }));

  const scope = { provider: 'GOOGLE_SHEETS' as const, scopeKey: scopeKeyFor({ integrationId: integration.id, workspaceId: integration.workspaceId }), externalKey: eventId };
  const seen = await deps.db.webhookEvent.findUnique({ where: { provider_scopeKey_externalKey: scope }, select: { id: true } });
  if (!seen) {
    const mapping = await loadActiveMapping(deps.db as never, integration.id);
    if (!mapping) return reject('MAPPING_NOT_CONFIRMED', new ConflictError({ code: 'MAPPING_NOT_CONFIRMED', userMessage: 'No column mapping is confirmed for this Sheet in AuraLead.' }));
    if (push.mappingVersion !== mapping.version) {
      return reject('MAPPING_SUPERSEDED', new ConflictError({ code: 'MAPPING_SUPERSEDED', userMessage: `The mapping changed (now version ${mapping.version}). Copy the new Apps Script from AuraLead; queued rows are kept.` }));
    }
    if (push.header) {
      const header = analyzeHeader(push.header);
      if (header.fingerprint !== mapping.headerFingerprint) {
        const diff = columnDiff(mapping.headerColumns ?? [], header.names);
        return reject('HEADER_DRIFT', new ConflictError({ code: 'HEADER_DRIFT', userMessage: 'The Sheet’s columns changed since the mapping was confirmed. Re-confirm the mapping in AuraLead, then copy the new script.', safeDetails: { added: diff.added, removed: diff.removed } }));
      }
    }
  }

  let weakIdRows = 0;
  const stored: SheetsPush = {
    ...push,
    rows: push.rows.map((r) => {
      if (r.rowKey) return { rowKey: r.rowKey, ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}), values: r.values };
      weakIdRows += 1;
      return { rowKey: weakRowKey(r.values, r.submittedAt), weakId: true, ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}), values: r.values };
    }),
  };
  const audit: AuditCtx = { kind: 'webhook', actor: null, workspaceId: integration.workspaceId, correlationId: deps.correlationId, clock: deps.clock };
  if (!deps.keyRing) throw new AuthError({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'no key ring' });
  const persisted = await persistWebhookEvent(
    deps.db,
    audit,
    { provider: 'GOOGLE_SHEETS', workspaceId: integration.workspaceId, integrationId: integration.id, externalKey: eventId, body: stored, bodySha256: sha256Hex(raw), simulated: false, processJob: 'ingest.process' },
    { keyRing: deps.keyRing },
  );
  return { outcome: persisted.outcome, eventId, rows: stored.rows.length, weakIdRows, status: persisted.status, result: persisted.result };
}
