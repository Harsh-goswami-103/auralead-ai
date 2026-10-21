/**
 * Extension ingestion tokens (T36; plan §9 Extension (T8, C18), §5.6 ExtensionToken).
 *
 * - Create: `alx_<keyId>_<secret>` from `generateExtensionToken` (32 random bytes of secret); only
 *   the prefix (UNIQUE, the lookup key) and the secret's sha256 are stored. The plaintext token is
 *   in this function's return value only: the route answers it once and it is never stored, logged
 *   or audited. Scope `ingest:gmaps`, one workspace. At most 10 active (not revoked, not expired)
 *   tokens per workspace (422 `EXTENSION_TOKEN_LIMIT`).
 * - Revoke: sets `revokedAt`; the receiver reads the row on every request, so the next request is
 *   refused (`token_revoked`). A repeat answers `alreadyRevoked` without a second audit.
 * - Allowed extension id: the Chrome extension id whose `chrome-extension://<id>` Origin the
 *   receiver answers CORS for (and the only extension Origin it accepts for this token); null
 *   clears it. A revoked token cannot be changed (409 `TOKEN_REVOKED`).
 * Every mutation needs `extension.manage` in the context workspace and is audited with the prefix
 * only. Works in DEMO and LIVE alike (a DEMO token lets the bridge be tried against a local DEMO
 * server; DEMO workspaces live in the DEMO database only, ADR-04).
 */
import { ConflictError, DomainRuleError, NotFoundError } from '@/lib/errors';
import { EXTENSION_SCOPE, EXTENSION_TOKEN_ACTIVE_LIMIT } from '@/lib/schemas/webhooks';
import type { AppCtx } from '@/server/auth/context';
import { requireActor, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { generateExtensionToken } from '@/server/security/tokens';
import { recordAudit } from '@/server/services/audit/record';

const DAY_MS = 86_400_000;

export type CreatedExtensionToken = {
  /** Shown once. */
  token: string;
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  allowedExtensionId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
};

export type CreateExtensionTokenInput = { name: string; allowedExtensionId?: string | null; expiresInDays?: number | null };

export async function createExtensionToken(ctx: AppCtx, input: CreateExtensionTokenInput): Promise<CreatedExtensionToken> {
  requireCapability(ctx, 'extension.manage');
  const workspaceId = requireWorkspace(ctx);
  const actor = requireActor(ctx);
  const name = input.name.trim();
  const now = ctx.clock.now();
  const expiresAt = input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * DAY_MS) : null;
  const generated = generateExtensionToken();
  const row = await withTx(ctx.db, async (tx) => {
    const active = await tx.extensionToken.count({ where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
    if (active >= EXTENSION_TOKEN_ACTIVE_LIMIT) {
      throw new DomainRuleError({
        code: 'EXTENSION_TOKEN_LIMIT',
        userMessage: `This workspace already has ${EXTENSION_TOKEN_ACTIVE_LIMIT} active tokens. Revoke one you no longer use first.`,
      });
    }
    const created = await tx.extensionToken.create({
      data: {
        workspaceId,
        name,
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        scopes: [EXTENSION_SCOPE],
        allowedExtensionId: input.allowedExtensionId ?? null,
        createdBy: actor.userId,
        createdAt: now,
        expiresAt,
      },
    });
    await recordAudit(tx, ctx, {
      action: 'extension.token.create',
      targetType: 'ExtensionToken',
      targetId: created.id,
      simulated: ctx.mode === 'demo',
      summary: { prefix: created.prefix, allowedExtension: created.allowedExtensionId !== null, expiresInDays: input.expiresInDays ?? null, activeBefore: active },
    });
    return created;
  });
  return {
    token: generated.token,
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: [EXTENSION_SCOPE],
    allowedExtensionId: row.allowedExtensionId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export type RevokeExtensionTokenResult = { id: string; prefix: string; revokedAt: Date; alreadyRevoked: boolean };

export async function revokeExtensionToken(ctx: AppCtx, input: { tokenId: string }): Promise<RevokeExtensionTokenResult> {
  requireCapability(ctx, 'extension.manage');
  requireWorkspace(ctx);
  return withTx(ctx.db, async (tx) => {
    const row = await tx.extensionToken.findFirst({ where: { id: input.tokenId }, select: { id: true, prefix: true, revokedAt: true } });
    if (!row) throw new NotFoundError({ message: 'no such extension token in this workspace' });
    if (row.revokedAt) return { id: row.id, prefix: row.prefix, revokedAt: row.revokedAt, alreadyRevoked: true };
    const now = ctx.clock.now();
    await tx.extensionToken.update({ where: { id: row.id }, data: { revokedAt: now } });
    await recordAudit(tx, ctx, { action: 'extension.token.revoke', targetType: 'ExtensionToken', targetId: row.id, simulated: ctx.mode === 'demo', summary: { prefix: row.prefix } });
    return { id: row.id, prefix: row.prefix, revokedAt: now, alreadyRevoked: false };
  });
}

export async function setExtensionTokenAllowedId(ctx: AppCtx, input: { tokenId: string; allowedExtensionId: string | null }): Promise<{ id: string; prefix: string; allowedExtensionId: string | null }> {
  requireCapability(ctx, 'extension.manage');
  requireWorkspace(ctx);
  return withTx(ctx.db, async (tx) => {
    const row = await tx.extensionToken.findFirst({ where: { id: input.tokenId }, select: { id: true, prefix: true, revokedAt: true, allowedExtensionId: true } });
    if (!row) throw new NotFoundError({ message: 'no such extension token in this workspace' });
    if (row.revokedAt) throw new ConflictError({ code: 'TOKEN_REVOKED', userMessage: 'This token is revoked. Create a new token instead.' });
    await tx.extensionToken.update({ where: { id: row.id }, data: { allowedExtensionId: input.allowedExtensionId } });
    await recordAudit(tx, ctx, {
      action: 'extension.token.allowed_extension',
      targetType: 'ExtensionToken',
      targetId: row.id,
      simulated: ctx.mode === 'demo',
      summary: { prefix: row.prefix, set: input.allowedExtensionId !== null, previouslySet: row.allowedExtensionId !== null },
    });
    return { id: row.id, prefix: row.prefix, allowedExtensionId: input.allowedExtensionId };
  });
}
