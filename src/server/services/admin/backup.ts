/**
 * `db:backup` and `db:restore` (R42, O1, E8; ADR-22, ADR-38).
 *
 * Backup: `VACUUM INTO` writes a consistent, compacted copy of the live SQLite DB (safe while the
 * web and worker run) to `<BACKUP_DIR>/auralead-<mode>-<time>.db`, then a manifest beside it
 * (`<file>.json`: format, mode, backupAt, bytes, sha256, applied migrations). The manifest is
 * written last, so a manifest means a complete backup. `backupAt` is taken before the copy starts,
 * so anything the copy might also contain is replayed idempotently, never lost.
 *
 * Restore (stop the web and the worker first; a fresh worker heartbeat refuses):
 *  1. The manifest and the file are checked (mode, sha256) before anything changes.
 *  2. `outbound.lock` is written first (fsynced): no send passes preflight from here on.
 *  3. In ONE transaction on the live DB file (no file swap, so no Windows file-lock problems and no
 *     half-restored state): every application table is replaced by the backup's rows (columns
 *     common to both, so a backup taken before a later additive migration still restores;
 *     WorkerHeartbeat and `_prisma_migrations` are live process state and stay), then
 *       - every non-terminal DispatchAttempt (QUEUED or SENDING) created before the backup becomes
 *         AMBIGUOUS (`RESTORED_IN_FLIGHT`): it may have been sent after the backup was taken, so it
 *         is never sent again automatically; its job goes DEAD(AMBIGUOUS), its message UNKNOWN;
 *       - the SuppressionJournal entries newer than the backup are replayed in event order: STOP
 *         inserts the journaled row (same id) when no active row exists, CLEAR clears the row with
 *         the journaled consent id. The journal lives outside the DB and survives the restore;
 *       - SystemSetting.outboundPaused is set (by `system:db.restore`), and `ops.restore` audited.
 *  4. The lock stays. Outbound resumes only when an operator resumes it in the admin panel (which
 *     clears the DB flag and removes this lock) after reviewing the AMBIGUOUS attempts.
 * A failure before the transaction commits removes a lock this run created; the DB is unchanged.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { ConflictError, DomainRuleError, ValidationError } from '@/lib/errors';
import { dbMode } from '@/server/auth/session';
import { withTx } from '@/server/db/tx';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { projectUnsentMany } from '@/server/services/messaging/delivery-state';
import { readJournal, type JournalEntry } from '@/server/services/messaging/suppression-journal';
import { WORKER_STALE_AFTER_MS } from '@/server/services/shell/panel-home';
import { readOutboundLock, removeOutboundLock, RESTORE_LOCK_WRITER, writeOutboundLock } from './outbound-pause';

export { RESTORE_LOCK_WRITER };

type Tx = Prisma.TransactionClient;
type Mode = 'demo' | 'live';

export const BACKUP_FORMAT = 1;
export const RESTORED_IN_FLIGHT = 'RESTORED_IN_FLIGHT';
export const RESTORE_INITIATOR = 'system:db.restore';
/** Tables that hold live process state, not data: never overwritten by a restore. */
const KEEP_TABLES = new Set(['_prisma_migrations', 'WorkerHeartbeat']);
const ATTACH_AS = 'restore_src';
const RESTORE_TX = { timeoutMs: 600_000, maxWaitMs: 60_000, maxAttempts: 1 } as const;

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  mode: Mode;
  /** ISO time taken just before the copy started; journal entries after it are replayed. */
  backupAt: string;
  /** File name of the backup, in the manifest's directory. */
  file: string;
  bytes: number;
  sha256: string;
  migrations: string[];
};

export class BackupError extends DomainRuleError {}

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

function systemAudit(clock: Clock, correlationId: string): AuditCtx {
  return { kind: 'system', actor: null, workspaceId: null, correlationId, clock };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function appliedMigrations(db: Pick<PrismaClient, '$queryRawUnsafe'>, schema: 'main' | typeof ATTACH_AS = 'main'): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT "migration_name" FROM ${schema}."_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "migration_name"`,
  );
  return rows.map((r) => r.migration_name);
}

function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace('.', '');
}

// ---- Backup ----------------------------------------------------------------------------------------

export async function createBackup(db: PrismaClient, clock: Clock, opts: { backupDir: string; mode: Mode; correlationId: string }): Promise<{ file: string; manifestFile: string; manifest: BackupManifest }> {
  await mkdir(opts.backupDir, { recursive: true });
  const backupAt = clock.now();
  let name = `auralead-${opts.mode}-${stampOf(backupAt)}.db`;
  for (let i = 2; existsSync(path.join(opts.backupDir, name)); i += 1) name = `auralead-${opts.mode}-${stampOf(backupAt)}-${i}.db`;
  const file = path.join(opts.backupDir, name);
  const partial = `${file}.partial`;
  const migrations = await appliedMigrations(db);
  await db.$executeRawUnsafe('VACUUM INTO ?', partial);
  await rename(partial, file);
  const manifest: BackupManifest = { format: BACKUP_FORMAT, mode: opts.mode, backupAt: backupAt.toISOString(), file: name, bytes: (await stat(file)).size, sha256: await sha256File(file), migrations };
  const manifestFile = `${file}.json`;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await recordAudit(db, systemAudit(clock, opts.correlationId), {
    action: 'ops.backup',
    targetType: 'Database',
    targetId: name,
    workspaceId: null,
    summary: { bytes: manifest.bytes, migrations: migrations.length },
  });
  return { file, manifestFile, manifest };
}

export async function readBackupManifest(manifestFile: string): Promise<BackupManifest> {
  let parsed: Partial<BackupManifest>;
  try {
    parsed = JSON.parse(await readFile(manifestFile, 'utf8')) as Partial<BackupManifest>;
  } catch (cause) {
    throw new ValidationError({ code: 'BACKUP_MANIFEST_INVALID', message: `cannot read backup manifest ${manifestFile}`, userMessage: 'The backup manifest is missing or unreadable.', cause });
  }
  const ok =
    parsed.format === BACKUP_FORMAT &&
    (parsed.mode === 'demo' || parsed.mode === 'live') &&
    typeof parsed.backupAt === 'string' &&
    !Number.isNaN(Date.parse(parsed.backupAt)) &&
    typeof parsed.file === 'string' &&
    path.basename(parsed.file) === parsed.file &&
    typeof parsed.sha256 === 'string' &&
    typeof parsed.bytes === 'number' &&
    Array.isArray(parsed.migrations);
  if (!ok) throw new ValidationError({ code: 'BACKUP_MANIFEST_INVALID', message: `backup manifest ${manifestFile} has an unexpected shape`, userMessage: 'The backup manifest is not valid.' });
  return parsed as BackupManifest;
}

/** Complete backups in a directory (those with a manifest), newest first. */
export async function listBackups(backupDir: string): Promise<Array<{ manifestFile: string; manifest: BackupManifest }>> {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: Array<{ manifestFile: string; manifest: BackupManifest }> = [];
  for (const name of names.filter((n) => n.endsWith('.db.json'))) {
    const manifestFile = path.join(backupDir, name);
    try {
      out.push({ manifestFile, manifest: await readBackupManifest(manifestFile) });
    } catch {
      // Not a backup manifest: ignored in the listing.
    }
  }
  return out.sort((a, b) => b.manifest.backupAt.localeCompare(a.manifest.backupAt));
}

// ---- Restore ---------------------------------------------------------------------------------------

export type RestoreOptions = {
  manifestFile: string;
  lockFile: string;
  journalDir: string;
  mode: Mode;
  correlationId: string;
  /** Skip the running-worker refusal (the operator has confirmed the worker is stopped). */
  allowRunningWorker?: boolean;
};

export type RestoreResult = {
  backupAt: string;
  backupFile: string;
  tablesRestored: number;
  rowsRestored: number;
  attemptsMadeAmbiguous: number;
  jobsMadeDead: number;
  journal: { replayed: number; stopsInserted: number; clearsApplied: number; skipped: number };
  lockFile: string;
};

async function tableColumns(tx: Tx, schema: string, table: string): Promise<string[]> {
  const rows = await tx.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA ${schema}.table_info(${q(table)})`);
  return rows.map((r) => r.name);
}

async function tablesOf(tx: Tx, schema: string): Promise<string[]> {
  const rows = await tx.$queryRawUnsafe<Array<{ name: string }>>(`SELECT "name" FROM ${schema}."sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`);
  return rows.map((r) => r.name).filter((n) => !KEEP_TABLES.has(n));
}

async function copyTables(tx: Tx): Promise<{ tables: number; rows: number }> {
  const main = await tablesOf(tx, 'main');
  const source = new Set(await tablesOf(tx, ATTACH_AS));
  const unknown = [...source].filter((t) => !main.includes(t));
  if (unknown.length > 0) {
    throw new BackupError({ code: 'BACKUP_NEWER_THAN_DATABASE', message: `backup has tables this database lacks: ${unknown.join(', ')}`, userMessage: 'The backup is from a newer schema. Upgrade the app first.' });
  }
  // Foreign keys are checked at commit, when every table holds the backup's rows.
  await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
  for (const table of main) await tx.$executeRawUnsafe(`DELETE FROM main.${q(table)}`);
  let rows = 0;
  for (const table of main) {
    if (!source.has(table)) continue;
    const sourceCols = new Set(await tableColumns(tx, ATTACH_AS, table));
    const cols = (await tableColumns(tx, 'main', table)).filter((c) => sourceCols.has(c)).map(q).join(', ');
    rows += await tx.$executeRawUnsafe(`INSERT INTO main.${q(table)} (${cols}) SELECT ${cols} FROM ${ATTACH_AS}.${q(table)}`);
  }
  return { tables: main.length, rows };
}

async function reconcileInFlight(tx: Tx, backupAt: Date, now: Date): Promise<{ attempts: number; jobs: number }> {
  const inflight = await tx.dispatchAttempt.findMany({ where: { state: { in: ['QUEUED', 'SENDING'] }, createdAt: { lte: backupAt } }, select: { id: true, messageId: true, jobId: true } });
  if (inflight.length === 0) return { attempts: 0, jobs: 0 };
  const attempts = await tx.dispatchAttempt.updateMany({
    where: { id: { in: inflight.map((a) => a.id) }, state: { in: ['QUEUED', 'SENDING'] } },
    data: { state: 'AMBIGUOUS', reasonCode: RESTORED_IN_FLIGHT, errorRedacted: `restored from a backup taken ${backupAt.toISOString()}: the send may have happened after the backup`, updatedAt: now },
  });
  await projectUnsentMany(tx, inflight.map((a) => a.messageId), 'UNKNOWN');
  const jobs = await tx.job.updateMany({
    where: { id: { in: [...new Set(inflight.map((a) => a.jobId))] }, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'DEAD', deadReason: 'AMBIGUOUS', retrySafe: false, lastErrorCode: RESTORED_IN_FLIGHT, lastErrorRedacted: 'restored from backup while a send was in flight', claimToken: null, leaseUntil: null, finishedAt: now, updatedAt: now },
  });
  return { attempts: attempts.count, jobs: jobs.count };
}

function replayOrder(entries: readonly JournalEntry[], backupAt: Date): JournalEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.createdAt) }))
    .filter((e) => e.at > backupAt.getTime())
    .sort((a, b) => a.at - b.at || (a.entry.action === b.entry.action ? a.index - b.index : a.entry.action === 'STOP' ? -1 : 1))
    .map((e) => e.entry);
}

async function replayJournal(tx: Tx, entries: readonly JournalEntry[], audit: AuditCtx, now: Date): Promise<RestoreResult['journal']> {
  const result = { replayed: entries.length, stopsInserted: 0, clearsApplied: 0, skipped: 0 };
  const workspaces = new Set((await tx.workspace.findMany({ select: { id: true } })).map((w) => w.id));
  for (const entry of entries) {
    if (!workspaces.has(entry.workspaceId)) {
      result.skipped += 1;
      continue;
    }
    if (entry.action === 'STOP') {
      const existing = await tx.suppression.findUnique({ where: { id: entry.suppressionId }, select: { id: true } });
      const active = existing ? null : await tx.suppression.findFirst({ where: { workspaceId: entry.workspaceId, channel: entry.channel, contactKey: entry.contactKey, clearedAt: null }, select: { id: true } });
      if (existing || active) {
        result.skipped += 1;
        continue;
      }
      await tx.suppression.create({
        data: {
          id: entry.suppressionId,
          workspaceId: entry.workspaceId,
          channel: entry.channel,
          contactKey: entry.contactKey,
          contactPlain: null,
          reason: entry.reason,
          sourceEventId: entry.sourceEventId,
          createdAt: new Date(entry.createdAt),
          journaledAt: now,
        },
      });
      result.stopsInserted += 1;
    } else {
      const cleared = await tx.suppression.updateMany({
        where: { id: entry.suppressionId, workspaceId: entry.workspaceId, clearedAt: null },
        data: { clearedAt: new Date(entry.createdAt), clearedByConsentId: entry.consentId, clearJournaledAt: now },
      });
      if (cleared.count !== 1) {
        result.skipped += 1;
        continue;
      }
      result.clearsApplied += 1;
    }
    await recordAudit(tx, { ...audit, workspaceId: entry.workspaceId }, {
      action: 'suppression.replay',
      targetType: 'Suppression',
      targetId: entry.suppressionId,
      summary: { action: entry.action, channel: entry.channel, reason: entry.reason, journalId: entry.journalId },
    });
  }
  return result;
}

export async function restoreBackup(db: PrismaClient, clock: Clock, opts: RestoreOptions): Promise<RestoreResult> {
  // 1. Everything that can be checked without touching the database.
  const manifest = await readBackupManifest(opts.manifestFile);
  if (manifest.mode !== opts.mode) {
    throw new BackupError({ code: 'BACKUP_MODE_MISMATCH', message: `backup mode ${manifest.mode} does not match this process's mode ${opts.mode}`, userMessage: 'This backup belongs to the other mode.' });
  }
  const backupFile = path.join(path.dirname(opts.manifestFile), manifest.file);
  if (!existsSync(backupFile)) throw new BackupError({ code: 'BACKUP_FILE_MISSING', message: `backup file ${backupFile} is missing`, userMessage: 'The backup file is missing.' });
  if ((await sha256File(backupFile)) !== manifest.sha256) {
    throw new BackupError({ code: 'BACKUP_CHECKSUM_MISMATCH', message: `backup file ${backupFile} does not match its manifest sha256`, userMessage: 'The backup file was changed after it was written.' });
  }
  const backupAt = new Date(manifest.backupAt);
  const started = clock.now();
  if (!opts.allowRunningWorker) {
    const beat = await db.workerHeartbeat.findFirst({ where: { mode: dbMode(opts.mode) }, orderBy: { lastBeatAt: 'desc' } });
    if (beat && started.getTime() - beat.lastBeatAt.getTime() <= WORKER_STALE_AFTER_MS) {
      throw new ConflictError({ code: 'WORKER_RUNNING', message: `worker ${beat.workerId} sent a heartbeat ${started.getTime() - beat.lastBeatAt.getTime()} ms ago`, userMessage: 'Stop the worker (and the web app) before restoring.' });
    }
  }

  // 2. The lock first: from here on nothing passes preflight.
  const lockExisted = readOutboundLock(opts.lockFile).present;
  await writeOutboundLock(opts.lockFile, { writtenBy: RESTORE_LOCK_WRITER, at: started.toISOString(), reason: 'database restore in progress', backupFile: manifest.file });

  let committed = false;
  let attached = false;
  try {
    await db.$executeRawUnsafe(`ATTACH DATABASE ? AS ${ATTACH_AS}`, backupFile);
    attached = true;
    const [check] = await db.$queryRawUnsafe<Array<{ quick_check: string }>>(`PRAGMA ${ATTACH_AS}.quick_check`);
    if (check?.quick_check !== 'ok') throw new BackupError({ code: 'BACKUP_CORRUPT', message: `backup quick_check: ${check?.quick_check ?? 'no result'}`, userMessage: 'The backup file is damaged.' });
    const modes = await db.$queryRawUnsafe<Array<{ mode: string }>>(`SELECT DISTINCT "mode" FROM ${ATTACH_AS}."Workspace"`);
    if (modes.some((m) => m.mode !== dbMode(opts.mode))) {
      throw new BackupError({ code: 'BACKUP_MODE_MISMATCH', message: 'the backup holds workspaces of the other mode', userMessage: 'This backup belongs to the other mode.' });
    }
    const live = new Set(await appliedMigrations(db));
    const ahead = (await appliedMigrations(db, ATTACH_AS)).filter((m) => !live.has(m));
    if (ahead.length > 0) {
      throw new BackupError({ code: 'BACKUP_NEWER_THAN_DATABASE', message: `backup has migrations this database lacks: ${ahead.join(', ')}`, userMessage: 'The backup is from a newer schema. Upgrade the app first.' });
    }
    const entries = replayOrder(await readJournal(opts.journalDir), backupAt);

    // 3. One transaction: replace, reconcile, replay, pause, audit.
    const result = await withTx(
      db,
      async (tx) => {
        const now = clock.now();
        const audit = systemAudit(clock, opts.correlationId);
        const copied = await copyTables(tx);
        const reconciled = await reconcileInFlight(tx, backupAt, now);
        const journal = await replayJournal(tx, entries, audit, now);
        const paused = { outboundPaused: true, outboundPausedAt: now, outboundPausedBy: RESTORE_INITIATOR, outboundPauseReason: `Restored from ${manifest.file} (taken ${manifest.backupAt}). Review the AMBIGUOUS attempts, then resume.` };
        await tx.systemSetting.upsert({ where: { id: 1 }, create: { id: 1, ...paused }, update: paused });
        await recordAudit(tx, audit, {
          action: 'ops.restore',
          targetType: 'Database',
          targetId: manifest.file,
          workspaceId: null,
          crossWorkspace: true,
          summary: { backupAt: manifest.backupAt, tables: copied.tables, rows: copied.rows, attemptsMadeAmbiguous: reconciled.attempts, jobsMadeDead: reconciled.jobs, ...journal },
        });
        return { copied, reconciled, journal };
      },
      RESTORE_TX,
    );
    committed = true;
    return {
      backupAt: manifest.backupAt,
      backupFile,
      tablesRestored: result.copied.tables,
      rowsRestored: result.copied.rows,
      attemptsMadeAmbiguous: result.reconciled.attempts,
      jobsMadeDead: result.reconciled.jobs,
      journal: result.journal,
      lockFile: opts.lockFile,
    };
  } finally {
    if (attached) await db.$executeRawUnsafe(`DETACH DATABASE ${ATTACH_AS}`);
    if (!committed && !lockExisted) await removeOutboundLock(opts.lockFile);
  }
}
