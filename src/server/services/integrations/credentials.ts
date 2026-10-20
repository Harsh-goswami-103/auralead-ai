/**
 * Encrypted integration credentials (T32; plan §9 Credentials, A33, ADR-25, ADR-80 seam 2).
 *
 * Writes. `saveIntegrationCredentials` sets or replaces (rotates by re-entering) the credential
 * fields of the integration's catalog entry, and its non-secret configuration, in one transaction:
 *  - every secret is an AES-256-GCM envelope `v1.<kid>.<nonce>.<ct>.<tag>` under the active kid of
 *    the key ring, with AAD `workspaceId|integrationId|field`, so a ciphertext copied to another
 *    row or field never decrypts;
 *  - `secretLast4[field] = { last4, updatedAt }`, where last4 is kept only for values of 16
 *    characters or more (four characters of a short password say too much) and only when they are
 *    plain letters or digits;
 *  - a LIVE write leaves the integration CONFIGURED_UNVERIFIED (verification is of the old values,
 *    so `verifiedAt` and the last error are cleared) and claims the webhook routing key
 *    (WhatsApp phone number ID, Meta Page ID); a DEMO write stores `demo_` placeholders only and
 *    leaves the integration SIMULATED (a DEMO integration never reaches a provider);
 *  - the audit row names the fields only, never a value.
 * `revokeIntegrationCredentials` removes every saved secret and sets REVOKED. The routing key is
 * kept, so a customer's Stop on that number is still recorded.
 *
 * Reads. Values never leave this module except decrypted into an adapter's request
 * (`loadIntegrationForUse`, called outside any transaction). There is no reveal path anywhere:
 * the read models show "saved + last four + time" only (center.ts).
 *
 * Rotation. `rotateCredentialEnvelopes` re-encrypts every Integration secret and every
 * `WebhookEvent.processingPayload` (ADR-35) under the active kid (`npm run creds:rotate`).
 * Needs `integrations.manage`.
 */
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import type { IntegrationKind, IntegrationStatus } from '@/lib/domain/enums';
import { catalogEntry } from '@/lib/domain/integrations';
import { ConflictError, DomainRuleError, NotFoundError, ValidationError } from '@/lib/errors';
import { checkConfigValue, checkCredentialValue, configRule, credentialRule } from '@/lib/schemas/integrations';
import type { CredentialState, IntegrationUse } from '@/server/adapters/registry';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { credentialAad, decryptSecretString, encryptSecret, envelopeKid, reencryptToActive, SecretDecryptError, webhookPayloadAad, type KeyRing } from '@/server/security/secrets';
import { recordAudit, type AuditCtx, type AuditDb } from '@/server/services/audit/record';
import { loadIntegrationCard, type MaskedCredential } from './center';
import { CREDENTIAL_UNREADABLE_CODE, CREDENTIAL_UNREADABLE_MESSAGE } from './types';

export { CREDENTIAL_UNREADABLE_CODE, CREDENTIAL_UNREADABLE_MESSAGE };
/** Values shorter than this never show their last four characters. */
export const LAST4_MIN_LENGTH = 16;

export type CredentialDeps = { keyRing: KeyRing | null };

export type SaveCredentialsInput = { kind: IntegrationKind; config?: Record<string, string>; credentials?: Record<string, string> };

export type SaveCredentialsResult = {
  kind: IntegrationKind;
  integrationId: string;
  status: IntegrationStatus;
  simulated: boolean;
  /** Credential fields written by this call (names only). */
  saved: string[];
  /** Of those, the ones that replaced a saved value (a rotation). */
  replaced: string[];
  /** Config fields changed by this call. */
  configChanged: string[];
  /** The masked view after the write: saved, last four, time. Never a value. */
  credentials: MaskedCredential[];
};

export type RevokeResult = { kind: IntegrationKind; integrationId: string; status: IntegrationStatus; revoked: string[]; changed: boolean };

type FieldProblem = { field: string; label: string; message: string };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** The last four characters, only for long values made of letters and digits. */
export function last4Of(value: string): string | null {
  if (value.length < LAST4_MIN_LENGTH) return null;
  const tail = value.slice(-4);
  return /^[A-Za-z0-9]{4}$/.test(tail) ? tail : null;
}

/** The field a webhook routes by (plan §5.6 `routingKey`): WhatsApp phone number ID, Meta Page ID. */
const ROUTING_FIELD: Partial<Record<IntegrationKind, string>> = { WHATSAPP_CLOUD: 'phoneNumberId', META_ADS: 'pageId' };

async function assertWorkspaceMode(ctx: AppCtx, workspaceId: string): Promise<void> {
  const ws = await ctx.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
  if (!ws || ws.mode !== (ctx.mode === 'demo' ? 'DEMO' : 'LIVE')) throw new NotFoundError({ message: 'workspace mode differs from the process mode' });
}

function invalid(problems: FieldProblem[]): ValidationError {
  const first = problems[0]!;
  return new ValidationError({
    code: 'CREDENTIALS_INVALID',
    userMessage: `${first.label}: ${first.message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`,
    safeDetails: { fields: problems.map((p) => ({ field: p.field, message: p.message })) },
  });
}

function isRoutingConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? error.message);
  return text.includes('routingKey');
}

export async function saveIntegrationCredentials(ctx: AppCtx, input: SaveCredentialsInput, deps: CredentialDeps): Promise<SaveCredentialsResult> {
  requireCapability(ctx, 'integrations.manage');
  const workspaceId = requireWorkspace(ctx);
  await assertWorkspaceMode(ctx, workspaceId);
  const entry = catalogEntry(input.kind);
  const ring = deps.keyRing;
  if (!ring) {
    throw new DomainRuleError({ code: 'CREDENTIALS_KEYRING_MISSING', userMessage: 'The server has no credentials key ring configured, so credentials cannot be stored. Ask the operator to set CREDENTIALS_KEYRING.' });
  }

  const problems: FieldProblem[] = [];
  const configSet: Record<string, string> = {};
  const configUnset: string[] = [];
  for (const [field, raw] of Object.entries(input.config ?? {})) {
    const rule = configRule(input.kind, field);
    const label = entry.configFields.find((f) => f.key === field)?.label ?? field;
    if (!rule) {
      problems.push({ field, label, message: 'This integration has no such setting.' });
      continue;
    }
    const value = raw.trim();
    if (value === '') {
      if (rule.required) problems.push({ field, label, message: 'This setting is required.' });
      else configUnset.push(field);
      continue;
    }
    const problem = checkConfigValue(input.kind, field, value);
    if (problem) problems.push({ field, label, message: problem });
    else configSet[field] = value;
  }
  const secretsIn: Record<string, string> = {};
  for (const [field, raw] of Object.entries(input.credentials ?? {})) {
    const rule = credentialRule(input.kind, field);
    const label = entry.credentialFields.find((f) => f.key === field)?.label ?? field;
    if (!rule) {
      problems.push({ field, label, message: 'This integration has no such credential.' });
      continue;
    }
    // An empty field keeps the saved value. Passwords keep their exact characters.
    const value = input.kind === 'EMAIL_SMTP' && field === 'password' ? raw : raw.trim();
    if (value === '') continue;
    const problem = checkCredentialValue(input.kind, field, value, ctx.mode);
    if (problem) problems.push({ field, label, message: problem });
    else secretsIn[field] = value;
  }
  if (problems.length > 0) throw invalid(problems);
  if (Object.keys(configSet).length === 0 && configUnset.length === 0 && Object.keys(secretsIn).length === 0) {
    throw new DomainRuleError({ code: 'NOTHING_TO_SAVE', userMessage: 'Enter at least one setting or credential to save.' });
  }

  const now = ctx.clock.now();
  const status: IntegrationStatus = ctx.mode === 'demo' ? 'SIMULATED' : 'CONFIGURED_UNVERIFIED';
  let written: { integrationId: string; saved: string[]; replaced: string[]; configChanged: string[] };
  try {
    written = await withTx(ctx.db, async (tx) => {
      let row = await tx.integration.findFirst({ where: { kind: input.kind }, select: { id: true, status: true, config: true, secrets: true, secretLast4: true } });
      const created = row === null;
      if (!row) {
        row = await tx.integration.create({ data: { workspaceId, kind: input.kind, status, config: {} }, select: { id: true, status: true, config: true, secrets: true, secretLast4: true } });
      }
      const previousStatus = created ? 'NOT_CONFIGURED' : row.status;
      const config = { ...record(row.config) };
      const configChanged: string[] = [];
      for (const [k, v] of Object.entries(configSet)) {
        if (config[k] !== v) configChanged.push(k);
        config[k] = v;
      }
      for (const k of configUnset) {
        if (k in config) configChanged.push(k);
        delete config[k];
      }
      const secrets = stringRecord(row.secrets);
      const last4 = { ...record(row.secretLast4) };
      const saved: string[] = [];
      const replaced: string[] = [];
      for (const [field, value] of Object.entries(secretsIn)) {
        if (secrets[field]) replaced.push(field);
        secrets[field] = encryptSecret(ring, value, credentialAad({ workspaceId, integrationId: row.id, field }));
        last4[field] = { last4: last4Of(value), updatedAt: now.toISOString() };
        saved.push(field);
      }

      const missing = [
        ...entry.configFields.filter((f) => configRule(input.kind, f.key)?.required && typeof config[f.key] !== 'string').map((f) => ({ field: f.key, label: f.label })),
        ...entry.credentialFields.filter((f) => credentialRule(input.kind, f.key)?.required && !secrets[f.key]).map((f) => ({ field: f.key, label: f.label })),
      ];
      if (missing.length > 0) {
        throw new ValidationError({
          code: 'CREDENTIALS_INCOMPLETE',
          userMessage: `Still needed before ${entry.label} counts as configured: ${missing.map((m) => m.label).join(', ')}.`,
          safeDetails: { fields: missing.map((m) => ({ field: m.field, message: 'This setting is required.' })) },
        });
      }

      const routingField = ROUTING_FIELD[input.kind];
      const routingKey = ctx.mode === 'live' && routingField && typeof config[routingField] === 'string' ? (config[routingField] as string) : undefined;
      await tx.integration.update({
        where: { id: row.id },
        data: {
          config: config as Prisma.InputJsonValue,
          secrets,
          secretLast4: last4 as Prisma.InputJsonValue,
          status,
          lastErrorCode: null,
          lastErrorRedacted: null,
          verifiedAt: null,
          ...(routingKey !== undefined ? { routingKey } : {}),
        },
      });
      await recordAudit(tx, ctx, {
        action: 'integration.credentials.set',
        targetType: 'Integration',
        targetId: row.id,
        simulated: ctx.mode === 'demo',
        summary: { kind: input.kind, fields: saved, rotated: replaced, configFields: configChanged, previousStatus, status },
      });
      return { integrationId: row.id, saved, replaced, configChanged };
    });
  } catch (error) {
    if (isRoutingConflict(error)) {
      throw new ConflictError({ code: 'ROUTING_KEY_TAKEN', userMessage: `This ${input.kind === 'META_ADS' ? 'Page ID' : 'phone number ID'} is already connected to another workspace.` });
    }
    throw error;
  }
  const card = await loadIntegrationCard(ctx, input.kind);
  return { kind: input.kind, integrationId: written.integrationId, status: card.status, simulated: ctx.mode === 'demo', saved: written.saved, replaced: written.replaced, configChanged: written.configChanged, credentials: card.credentials };
}

export async function revokeIntegrationCredentials(ctx: AppCtx, input: { kind: IntegrationKind }): Promise<RevokeResult> {
  requireCapability(ctx, 'integrations.manage');
  const workspaceId = requireWorkspace(ctx);
  await assertWorkspaceMode(ctx, workspaceId);
  return withTx(ctx.db, async (tx) => {
    const row = await tx.integration.findFirst({ where: { kind: input.kind }, select: { id: true, status: true, secrets: true } });
    if (!row) throw new DomainRuleError({ code: 'NOTHING_TO_REVOKE', userMessage: `${catalogEntry(input.kind).label} has no saved credentials.` });
    const fields = Object.keys(stringRecord(row.secrets));
    if (fields.length === 0 && row.status === 'REVOKED') return { kind: input.kind, integrationId: row.id, status: row.status, revoked: [], changed: false };
    await tx.integration.update({
      where: { id: row.id },
      data: { secrets: Prisma.DbNull, secretLast4: Prisma.DbNull, status: 'REVOKED', verifiedAt: null, lastErrorCode: null, lastErrorRedacted: null },
    });
    await recordAudit(tx, ctx, {
      action: 'integration.credentials.revoke',
      targetType: 'Integration',
      targetId: row.id,
      simulated: ctx.mode === 'demo',
      summary: { kind: input.kind, fields, previousStatus: row.status, status: 'REVOKED' },
    });
    return { kind: input.kind, integrationId: row.id, status: 'REVOKED' as const, revoked: fields, changed: true };
  });
}

// ---- Use by adapters (outside any transaction) -------------------------------------------------------

type IntegrationReadDb = {
  integration: {
    findFirst(args: { where: { kind: IntegrationKind }; select: { id: true; workspaceId: true; kind: true; status: true; config: true; secrets: true } }): PromiseLike<{
      id: string;
      workspaceId: string;
      kind: IntegrationKind;
      status: IntegrationStatus;
      config: unknown;
      secrets: unknown;
    } | null>;
  };
};

/** Decrypts every saved field of a stored row (AAD per field); a missing required field or an undecryptable one is reported, never guessed. */
export function decryptIntegrationSecrets(row: { id: string; workspaceId: string; kind: IntegrationKind; secrets: unknown }, keyRing: KeyRing | null): CredentialState {
  const envelopes = stringRecord(row.secrets);
  const values: Record<string, string> = {};
  for (const [field, envelope] of Object.entries(envelopes)) {
    if (!keyRing) return { state: 'unreadable', field };
    try {
      values[field] = decryptSecretString(keyRing, envelope, credentialAad({ workspaceId: row.workspaceId, integrationId: row.id, field }));
    } catch (error) {
      if (error instanceof SecretDecryptError) return { state: 'unreadable', field };
      throw error;
    }
  }
  const missing = catalogEntry(row.kind)
    .credentialFields.filter((f) => credentialRule(row.kind, f.key)?.required && values[f.key] === undefined)
    .map((f) => f.key);
  if (missing.length > 0) return { state: 'missing', fields: missing };
  return { state: 'ok', values };
}

/** The workspace's integration of `kind` with its credentials decrypted, or null when none is stored. */
export async function loadIntegrationForUse(db: IntegrationReadDb, kind: IntegrationKind, keyRing: KeyRing | null): Promise<IntegrationUse | null> {
  const row = await db.integration.findFirst({ where: { kind }, select: { id: true, workspaceId: true, kind: true, status: true, config: true, secrets: true } });
  if (!row) return null;
  return { id: row.id, kind: row.kind, status: row.status, config: record(row.config), credentials: decryptIntegrationSecrets(row, keyRing) };
}

type IntegrationWriteDb = AuditDb & {
  integration: {
    updateMany(args: { where: Prisma.IntegrationWhereInput; data: Prisma.IntegrationUpdateManyMutationInput }): PromiseLike<{ count: number }>;
  };
};

/**
 * Records once that a LIVE integration's saved secret no longer decrypts (a removed key, a swapped
 * ciphertext): status ERROR with "Credential unreadable, re-enter", shown on its setup page. A
 * repeat while the error stands writes nothing.
 */
export async function markCredentialUnreadable(tx: IntegrationWriteDb, ctx: AuditCtx & { workspaceId: string | null }, input: { workspaceId: string; integrationId: string; field: string | null }): Promise<boolean> {
  const moved = await tx.integration.updateMany({
    where: { id: input.integrationId, workspaceId: input.workspaceId, OR: [{ lastErrorCode: null }, { lastErrorCode: { not: CREDENTIAL_UNREADABLE_CODE } }] },
    data: { status: 'ERROR', lastErrorCode: CREDENTIAL_UNREADABLE_CODE, lastErrorRedacted: CREDENTIAL_UNREADABLE_MESSAGE },
  });
  if (moved.count === 0) return false;
  await recordAudit(tx, ctx, {
    action: 'integration.credentials.unreadable',
    targetType: 'Integration',
    targetId: input.integrationId,
    workspaceId: input.workspaceId,
    result: 'FAILED',
    summary: { field: input.field, errorCode: CREDENTIAL_UNREADABLE_CODE },
  });
  return true;
}

// ---- Rotation (`npm run creds:rotate`) ---------------------------------------------------------------

export type RotationProblem = { table: 'Integration' | 'WebhookEvent'; id: string; field: string | null; reason: string };

export type RotationReport = {
  activeKid: string;
  integrations: { rows: number; envelopes: number; rotated: number };
  webhookEvents: { rows: number; rotated: number };
  /** Envelopes still under another kid after the run (0 when the rotation is complete). */
  remainingOldKid: number;
  /** Envelopes that could not be decrypted with any key in the ring (left unchanged). */
  unreadable: RotationProblem[];
};

const ROTATE_BATCH = 50;

function kidOf(envelope: string): string | null {
  try {
    return envelopeKid(envelope);
  } catch {
    return null;
  }
}

/**
 * Re-encrypts every credential envelope and every webhook processing payload under the active kid.
 * Each row is read and rewritten in its own immediate transaction (no lost update against a
 * concurrent writer); envelopes already on the active kid are left as they are, so a second run
 * changes nothing. Undecryptable envelopes are reported by table, id and field, never changed.
 */
export async function rotateCredentialEnvelopes(db: PrismaClient, ring: KeyRing, opts: { clock: Clock; correlationId: string }): Promise<RotationReport> {
  const report: RotationReport = { activeKid: ring.activeKid, integrations: { rows: 0, envelopes: 0, rotated: 0 }, webhookEvents: { rows: 0, rotated: 0 }, remainingOldKid: 0, unreadable: [] };

  let cursor: string | null = null;
  for (;;) {
    // JSON columns are never filtered on (plan §5): rows without secrets are skipped in the loop.
    const page: Array<{ id: string }> = await db.integration.findMany({ where: cursor ? { id: { gt: cursor } } : {}, orderBy: { id: 'asc' }, take: ROTATE_BATCH, select: { id: true } });
    if (page.length === 0) break;
    for (const { id } of page) {
      await withTx(db, async (tx) => {
        const row = await tx.integration.findUnique({ where: { id }, select: { id: true, workspaceId: true, secrets: true } });
        if (!row) return;
        const secrets = stringRecord(row.secrets);
        let changed = false;
        for (const [field, envelope] of Object.entries(secrets)) {
          try {
            const next = reencryptToActive(ring, envelope, credentialAad({ workspaceId: row.workspaceId, integrationId: row.id, field }));
            if (next.changed) {
              secrets[field] = next.envelope;
              changed = true;
              report.integrations.rotated += 1;
            }
          } catch (error) {
            if (!(error instanceof SecretDecryptError)) throw error;
            report.unreadable.push({ table: 'Integration', id: row.id, field, reason: error.reason });
          }
        }
        if (changed) await tx.integration.update({ where: { id: row.id }, data: { secrets } });
      });
    }
    cursor = page.at(-1)!.id;
  }

  cursor = null;
  for (;;) {
    const page: Array<{ id: string }> = await db.webhookEvent.findMany({ where: { processingPayload: { not: null }, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: ROTATE_BATCH, select: { id: true } });
    if (page.length === 0) break;
    for (const { id } of page) {
      await withTx(db, async (tx) => {
        const row = await tx.webhookEvent.findUnique({ where: { id }, select: { id: true, processingPayload: true } });
        if (!row?.processingPayload) return;
        try {
          const next = reencryptToActive(ring, row.processingPayload, webhookPayloadAad(row.id));
          if (next.changed) {
            await tx.webhookEvent.update({ where: { id: row.id }, data: { processingPayload: next.envelope } });
            report.webhookEvents.rotated += 1;
          }
        } catch (error) {
          if (!(error instanceof SecretDecryptError)) throw error;
          report.unreadable.push({ table: 'WebhookEvent', id: row.id, field: null, reason: error.reason });
        }
      });
    }
    cursor = page.at(-1)!.id;
  }

  // The final count reads what is stored now, including rows written while the run was going.
  for (const row of await db.integration.findMany({ select: { secrets: true } })) {
    const envelopes = Object.values(stringRecord(row.secrets));
    if (envelopes.length === 0) continue;
    report.integrations.rows += 1;
    for (const envelope of envelopes) {
      report.integrations.envelopes += 1;
      if (kidOf(envelope) !== ring.activeKid) report.remainingOldKid += 1;
    }
  }
  for (const row of await db.webhookEvent.findMany({ where: { processingPayload: { not: null } }, select: { processingPayload: true } })) {
    report.webhookEvents.rows += 1;
    if (kidOf(row.processingPayload!) !== ring.activeKid) report.remainingOldKid += 1;
  }

  await recordAudit(db, { kind: 'system', actor: null, workspaceId: null, correlationId: opts.correlationId, clock: opts.clock }, {
    action: 'ops.creds_rotate',
    targetType: 'KeyRing',
    targetId: ring.activeKid,
    workspaceId: null,
    result: report.remainingOldKid === 0 && report.unreadable.length === 0 ? 'SUCCESS' : 'FAILED',
    summary: {
      integrationEnvelopes: report.integrations.envelopes,
      integrationRotated: report.integrations.rotated,
      webhookPayloads: report.webhookEvents.rows,
      webhookRotated: report.webhookEvents.rotated,
      remainingOldKid: report.remainingOldKid,
      unreadable: report.unreadable.length,
    },
  });
  return report;
}
