/**
 * The Apps Script signing secret (T34, ADR-105). Generated on the server (32 random bytes,
 * base64url), never typed in: the integration's `appsScriptSecret` credential is written through
 * the T32 envelope (AES-256-GCM under the active kid, AAD `workspaceId|integrationId|appsScriptSecret`,
 * masked as "saved + last four + time"), and a new key id `as_<random>` is stored in the config and
 * claimed as the integration's `routingKey`, the unique lookup column the webhook resolves the
 * integration by (a header value, never a payload field). The secret is returned once to the
 * person who asked for it and is never readable again (no reveal path); rotating (typed ROTATE)
 * replaces both immediately, so the installed script stops until the new script and secret are
 * pasted. LIVE only: a DEMO database never holds a secret a real script could push with.
 */
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { ConflictError, DomainRuleError } from '@/lib/errors';
import { APPS_SCRIPT_ROTATE_CONFIRMATION } from '@/lib/schemas/sheets';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { credentialAad, encryptSecret, type KeyRing } from '@/server/security/secrets';
import { recordAudit } from '@/server/services/audit/record';
import { last4Of } from '@/server/services/integrations/credentials';

export const APPS_SCRIPT_SECRET_FIELD = 'appsScriptSecret';
export const APPS_SCRIPT_KEY_ID_FIELD = 'appsScriptKeyId';

export function newAppsScriptKeyId(): string {
  return `as_${randomBytes(12).toString('base64url')}`;
}

export function newAppsScriptSecret(): string {
  return randomBytes(32).toString('base64url');
}

export type IssuedSecret = { keyId: string; secret: string; rotated: boolean; issuedAt: Date };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function issueAppsScriptSecret(ctx: AppCtx, input: { confirm?: typeof APPS_SCRIPT_ROTATE_CONFIRMATION }, deps: { keyRing: KeyRing | null }): Promise<IssuedSecret> {
  requireCapability(ctx, 'sheets.manage');
  const workspaceId = requireWorkspace(ctx);
  if (ctx.mode !== 'live') {
    throw new DomainRuleError({ code: 'SHEETS_LIVE_ONLY', userMessage: 'DEMO never issues an Apps Script secret: a real script could then push real people’s rows into a demo database. DEMO rows come from the simulator.' });
  }
  const ring = deps.keyRing;
  if (!ring) throw new DomainRuleError({ code: 'CREDENTIALS_KEYRING_MISSING', userMessage: 'The server has no credentials key ring configured, so the secret cannot be stored. Ask the operator to set CREDENTIALS_KEYRING.' });
  const keyId = newAppsScriptKeyId();
  const secret = newAppsScriptSecret();
  const now = ctx.clock.now();
  const rotated = await withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Prisma.TransactionClient;
    const row = await tx.integration.findFirst({ where: { workspaceId, kind: 'GOOGLE_SHEETS' }, select: { id: true, status: true, config: true, secrets: true, secretLast4: true } });
    if (!row || ['NOT_CONFIGURED', 'REVOKED', 'SIMULATED'].includes(row.status)) {
      throw new DomainRuleError({ code: 'INTEGRATION_NOT_CONFIGURED', userMessage: 'Save the service account key and spreadsheet ID in the Google Sheets setup first.' });
    }
    const secrets = Object.fromEntries(Object.entries(record(row.secrets)).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const exists = typeof secrets[APPS_SCRIPT_SECRET_FIELD] === 'string';
    if (exists && input.confirm !== APPS_SCRIPT_ROTATE_CONFIRMATION) {
      throw new ConflictError({ code: 'APPS_SCRIPT_SECRET_EXISTS', userMessage: 'A signing secret already exists. Type ROTATE to replace it; the installed script stops until you paste the new script and secret.' });
    }
    secrets[APPS_SCRIPT_SECRET_FIELD] = encryptSecret(ring, secret, credentialAad({ workspaceId, integrationId: row.id, field: APPS_SCRIPT_SECRET_FIELD }));
    const last4 = { ...record(row.secretLast4), [APPS_SCRIPT_SECRET_FIELD]: { last4: last4Of(secret), updatedAt: now.toISOString() } };
    const config = { ...record(row.config), [APPS_SCRIPT_KEY_ID_FIELD]: keyId };
    await tx.integration.update({ where: { id: row.id }, data: { secrets, secretLast4: last4 as Prisma.InputJsonValue, config: config as Prisma.InputJsonValue, routingKey: keyId } });
    await recordAudit(tx, ctx, {
      action: 'sheets.apps_script.secret',
      targetType: 'Integration',
      targetId: row.id,
      summary: { kind: 'GOOGLE_SHEETS', fields: [APPS_SCRIPT_SECRET_FIELD], rotated: exists },
    });
    return exists;
  });
  return { keyId, secret, rotated, issuedAt: now };
}
