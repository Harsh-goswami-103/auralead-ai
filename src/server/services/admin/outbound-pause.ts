/**
 * Global outbound pause (R40, O1, plan §4.3): three independent switches, any one of which defers
 * every dispatch at preflight (GLOBAL_PAUSED):
 *  - `SystemSetting.outboundPaused` (the admin panel switch, with who, when and why),
 *  - `<DATA_DIR>/<mode>/outbound.lock` (written first by `db:restore`; an operator may also create
 *    it by hand),
 *  - `OUTBOUND_PAUSED=1` in the environment.
 * Sends already past P2 (SENDING committed) complete; nothing new passes preflight.
 *
 * `setOutboundPause` is the admin action: super admin only, fresh authentication checked by the
 * route, a typed reason, audited crossWorkspace. Resuming also removes a lock that `db:restore`
 * wrote (the operator's review after a restore ends with this resume); a lock someone created by
 * hand is reported and left for them to remove, and `OUTBOUND_PAUSED=1` needs a restart without it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { ValidationError } from '@/lib/errors';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireRole } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';

/** `writtenBy` of the lock that `db:restore` writes; only this lock is removed by a resume. */
export const RESTORE_LOCK_WRITER = 'db:restore';

export type OutboundLockContent = { writtenBy: string; at: string; reason: string; backupFile?: string };

export type OutboundPauseState = {
  paused: boolean;
  db: { paused: boolean; at: Date | null; by: string | null; reason: string | null };
  lockFile: { present: boolean; writtenByRestore: boolean; content: OutboundLockContent | null; path: string };
  env: { paused: boolean };
};

export function readOutboundLock(lockFile: string): { present: boolean; content: OutboundLockContent | null } {
  if (!existsSync(lockFile)) return { present: false, content: null };
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as Partial<OutboundLockContent>;
    if (typeof parsed.writtenBy === 'string' && typeof parsed.at === 'string') {
      return { present: true, content: { writtenBy: parsed.writtenBy, at: parsed.at, reason: typeof parsed.reason === 'string' ? parsed.reason : '', ...(typeof parsed.backupFile === 'string' ? { backupFile: parsed.backupFile } : {}) } };
    }
  } catch {
    // An empty or hand-written lock: present, content unknown.
  }
  return { present: true, content: null };
}

/** Writes the lock with fsync (the file's presence is the pause). */
export async function writeOutboundLock(lockFile: string, content: OutboundLockContent): Promise<void> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const handle = await open(lockFile, 'w');
  try {
    await handle.write(`${JSON.stringify(content)}\n`, null, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function removeOutboundLock(lockFile: string): Promise<void> {
  await rm(lockFile, { force: true, maxRetries: 3, retryDelay: 100 });
}

export async function readOutboundPause(db: Pick<PrismaClient, 'systemSetting'>, opts: { lockFile: string; envPaused: boolean }): Promise<OutboundPauseState> {
  const setting = await db.systemSetting.findUnique({ where: { id: 1 } });
  const lock = readOutboundLock(opts.lockFile);
  const dbPaused = setting?.outboundPaused ?? false;
  return {
    paused: dbPaused || lock.present || opts.envPaused,
    db: { paused: dbPaused, at: setting?.outboundPausedAt ?? null, by: setting?.outboundPausedBy ?? null, reason: setting?.outboundPauseReason ?? null },
    lockFile: { present: lock.present, writtenByRestore: lock.content?.writtenBy === RESTORE_LOCK_WRITER, content: lock.content, path: opts.lockFile },
    env: { paused: opts.envPaused },
  };
}

export const PAUSE_REASON_MIN = 3;
export const PAUSE_REASON_MAX = 500;

export type SetOutboundPauseInput = { paused: boolean; reason: string };

export async function setOutboundPause(ctx: AppCtx, input: SetOutboundPauseInput, opts: { lockFile: string; envPaused: boolean }): Promise<OutboundPauseState> {
  const actor = requireRole(ctx, 'SUPER_ADMIN');
  const reason = input.reason.trim();
  if (reason.length < PAUSE_REASON_MIN || reason.length > PAUSE_REASON_MAX) {
    throw new ValidationError({ code: 'REASON_REQUIRED', userMessage: 'Give a reason (3 to 500 characters).' });
  }
  const prisma = baseClientOf(ctx);
  const now = ctx.clock.now();
  const lockBefore = readOutboundLock(opts.lockFile);
  const removeRestoreLock = !input.paused && lockBefore.content?.writtenBy === RESTORE_LOCK_WRITER;

  await withTx(prisma, async (tx) => {
    const data = input.paused
      ? { outboundPaused: true, outboundPausedAt: now, outboundPausedBy: actor.userId, outboundPauseReason: reason }
      : { outboundPaused: false, outboundPausedAt: null, outboundPausedBy: null, outboundPauseReason: null };
    await tx.systemSetting.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    await recordAudit(tx, { ...ctx, workspaceId: null }, {
      action: input.paused ? 'system.outbound_pause' : 'system.outbound_resume',
      targetType: 'SystemSetting',
      targetId: '1',
      crossWorkspace: true,
      reason,
      workspaceId: null,
      summary: { fields: ['outboundPaused'], restoreLockRemoved: removeRestoreLock, lockFilePresent: lockBefore.present, envPaused: opts.envPaused },
    });
  });
  if (removeRestoreLock) await removeOutboundLock(opts.lockFile);
  return readOutboundPause(prisma, opts);
}
