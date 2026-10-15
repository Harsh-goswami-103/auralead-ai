/**
 * SuppressionJournal (E8, ADR-38): an append-only JSONL file per UTC day,
 * `<DATA_DIR>/<mode>/journal/suppressions-YYYYMMDD.jsonl`, outside the DB file so a DB restore never
 * replaces it. One line per suppression event:
 *   { journalId, workspaceId, contactKey, channel, action: STOP|CLEAR, reason, createdAt,
 *     sourceEventId, suppressionId, consentId }
 * `journalId` is `<suppressionId>:<action>`, so every export is idempotent. Lines carry the contact
 * HMAC only, never the contact.
 *
 * Producer rules:
 *  - `messaging/suppression.ts` appends after the Suppression transaction commits (never inside
 *    it), with fsync, then stamps `journaledAt` (STOP) or `clearJournaledAt` (CLEAR).
 *  - A failed append leaves the stamp null and queues `suppression.journalReconcile`, which
 *    re-exports every unstamped row of the workspace. Before appending it reads the journal, so a
 *    line that was written before a crash (append ok, stamp lost) is stamped, not duplicated.
 *  - A clear made inside another service's transaction (consent captured at ingestion) cannot
 *    append after that commit, so it queues the reconcile job in the same transaction instead.
 * Consumer: `db:restore` (T24) replays entries newer than the backup through `readJournal`.
 */
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Channel, JournalAction, SuppressionReason } from '@/lib/domain/enums';
import type { Clock } from '@/lib/clock';

export const SUPPRESSION_JOURNAL_RECONCILE_JOB = 'suppression.journalReconcile';
export const SUPPRESSION_JOURNAL_PAYLOAD_VERSION = 1;

export type JournalEntry = {
  journalId: string;
  workspaceId: string;
  contactKey: string;
  channel: Channel;
  action: JournalAction;
  reason: SuppressionReason;
  /** The event time: the Stop's createdAt, or the clear's clearedAt (ISO, UTC). */
  createdAt: string;
  sourceEventId: string | null;
  suppressionId: string;
  consentId: string | null;
};

export type JournalDeps = { journalDir: string };

/** The Suppression columns a journal entry is built from. */
export type JournalRow = {
  id: string;
  workspaceId: string;
  channel: Channel;
  contactKey: string;
  reason: SuppressionReason;
  sourceEventId: string | null;
  createdAt: Date;
  clearedAt: Date | null;
  clearedByConsentId: string | null;
};

export function journalIdFor(suppressionId: string, action: JournalAction): string {
  return `${suppressionId}:${action}`;
}

export function reconcileJobKey(suppressionId: string, action: JournalAction): string {
  return `${SUPPRESSION_JOURNAL_RECONCILE_JOB}:${suppressionId}:${action}`;
}

export function journalFileName(at: Date): string {
  const y = at.getUTCFullYear().toString().padStart(4, '0');
  const m = (at.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = at.getUTCDate().toString().padStart(2, '0');
  return `suppressions-${y}${m}${d}.jsonl`;
}

export function journalEntryFor(row: JournalRow, action: JournalAction): JournalEntry {
  const at = action === 'STOP' ? row.createdAt : row.clearedAt;
  if (at === null) throw new Error(`suppression ${row.id} has no clear to journal`);
  return {
    journalId: journalIdFor(row.id, action),
    workspaceId: row.workspaceId,
    contactKey: row.contactKey,
    channel: row.channel,
    action,
    reason: row.reason,
    createdAt: at.toISOString(),
    sourceEventId: row.sourceEventId,
    suppressionId: row.id,
    consentId: action === 'CLEAR' ? row.clearedByConsentId : null,
  };
}

/** Appends one line and fsyncs it before returning. Throws when the directory or file is unusable. */
export async function appendJournalEntry(deps: JournalDeps, entry: JournalEntry): Promise<void> {
  await mkdir(deps.journalDir, { recursive: true });
  const file = path.join(deps.journalDir, journalFileName(new Date(entry.createdAt)));
  const handle = await open(file, 'a');
  try {
    await handle.write(`${JSON.stringify(entry)}\n`, null, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isEntry(value: unknown): value is JournalEntry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.journalId === 'string' && typeof v.suppressionId === 'string' && (v.action === 'STOP' || v.action === 'CLEAR') && typeof v.createdAt === 'string';
}

/**
 * Every entry in the journal, files in date order and lines in file order. A torn last line (a
 * crash mid-write before fsync) is skipped; a missing directory is an empty journal.
 */
export async function readJournal(journalDir: string): Promise<JournalEntry[]> {
  let names: string[];
  try {
    names = (await readdir(journalDir)).filter((n) => /^suppressions-\d{8}\.jsonl$/.test(n)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: JournalEntry[] = [];
  for (const name of names) {
    const text = await readFile(path.join(journalDir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntry(parsed)) out.push(parsed);
      } catch {
        // A torn line: the reconcile job re-exports whatever it described.
      }
    }
  }
  return out;
}

// ---- Reconcile ----------------------------------------------------------------------------------

type ReconcileRow = JournalRow & { journaledAt: Date | null; clearJournaledAt: Date | null };

export type ReconcileReadDb = {
  suppression: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: { createdAt: 'asc' };
    }): PromiseLike<ReconcileRow[]>;
  };
};

export type ReconcileStampTx = {
  suppression: {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): PromiseLike<{ count: number }>;
  };
};

export type ReconcileResult = { exported: number; alreadyPresent: number; failed: number; stamped: number; firstError: string | null };

/**
 * Exports every unstamped STOP and CLEAR of `workspaceId` (every workspace when null) that the
 * journal does not hold yet, then stamps the rows whose line is now present. Appends run outside
 * any transaction; `stampTx` runs the stamping writes (the job passes its fenced transaction).
 */
export async function reconcileSuppressionJournal(
  db: ReconcileReadDb,
  clock: Clock,
  deps: JournalDeps,
  workspaceId: string | null,
  stampTx: <R>(fn: (tx: ReconcileStampTx) => Promise<R>) => Promise<R>,
): Promise<ReconcileResult> {
  const scope = workspaceId === null ? {} : { workspaceId };
  const rows = await db.suppression.findMany({
    where: { ...scope, OR: [{ journaledAt: null }, { clearedAt: { not: null }, clearJournaledAt: null }] },
    orderBy: { createdAt: 'asc' },
  });
  const result: ReconcileResult = { exported: 0, alreadyPresent: 0, failed: 0, stamped: 0, firstError: null };
  if (rows.length === 0) return result;

  const pending: Array<{ row: ReconcileRow; action: JournalAction }> = [];
  for (const row of rows) {
    if (row.journaledAt === null) pending.push({ row, action: 'STOP' });
    if (row.clearedAt !== null && row.clearJournaledAt === null) pending.push({ row, action: 'CLEAR' });
  }
  let present: Set<string>;
  try {
    present = new Set((await readJournal(deps.journalDir)).map((e) => e.journalId));
  } catch (error) {
    // An unreadable journal (directory missing permissions, a file in its place): retry later.
    return { ...result, failed: pending.length, firstError: (error as Error).message };
  }
  const stampStop: string[] = [];
  const stampClear: string[] = [];
  // STOP before CLEAR, by event time, so replay order matches history.
  pending.sort((a, b) => eventTime(a.row, a.action) - eventTime(b.row, b.action));
  for (const { row, action } of pending) {
    const entry = journalEntryFor(row, action);
    if (present.has(entry.journalId)) {
      result.alreadyPresent += 1;
    } else {
      try {
        await appendJournalEntry(deps, entry);
        present.add(entry.journalId);
        result.exported += 1;
      } catch (error) {
        result.failed += 1;
        result.firstError ??= (error as Error).message;
        continue;
      }
    }
    (action === 'STOP' ? stampStop : stampClear).push(row.id);
  }

  if (stampStop.length + stampClear.length > 0) {
    const now = clock.now();
    result.stamped = await stampTx(async (tx) => {
      let n = 0;
      if (stampStop.length > 0) n += (await tx.suppression.updateMany({ where: { id: { in: stampStop }, journaledAt: null }, data: { journaledAt: now } })).count;
      if (stampClear.length > 0) {
        n += (await tx.suppression.updateMany({ where: { id: { in: stampClear }, clearJournaledAt: null }, data: { clearJournaledAt: now } })).count;
      }
      return n;
    });
  }
  return result;
}

function eventTime(row: JournalRow, action: JournalAction): number {
  return (action === 'STOP' ? row.createdAt : (row.clearedAt ?? row.createdAt)).getTime();
}
