/**
 * Suppression (C9, C17, E3, E8; ADR-06, ADR-19, ADR-37, ADR-38). The only writer of Suppression
 * rows: Stop (button or keyword), unsubscribe, hard bounce, complaint, WhatsApp 131050, manual, and
 * the clear on re-opt-in.
 *
 *  - Rows are append-only history keyed by the contact HMAC (never the lead), at most one ACTIVE
 *    row (clearedAt IS NULL) per workspace, channel and contact. A Stop while a row is active is a
 *    no-op plus audit; a Stop after a clear inserts a new active row. Rows are never deleted.
 *  - A Stop cancels the contact's QUEUED dispatch attempts on that channel in the same
 *    transaction (their QUEUED jobs CANCELLED, RUNNING jobs get cancelRequestedAt, PENDING
 *    messages NOT_SENT). Attempts already SENDING are left to the settle path.
 *  - Re-opt-in: the active row is cleared only by an OPT_IN ConsentRecord whose collectedAt is
 *    strictly newer than the latest Stop for the contact and channel (the newest row's createdAt,
 *    active or cleared). Older, equal or other-basis evidence never clears it.
 *  - Journal (E8): writes made through `withSuppressionTx` append their STOP / CLEAR lines after
 *    the transaction commits (nothing for a rolled-back transaction). A clear made inside another
 *    service's transaction queues `suppression.journalReconcile` in that transaction instead.
 *
 * Synchronous Stop and unsubscribe routes (T20) run their whole transaction (WebhookEvent insert,
 * suppression, cancellation, audit) inside `withSuppressionTx`.
 */
import type { Channel, Prisma, PrismaClient, SuppressionReason } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { ValidationError } from '@/lib/errors';
import { baseClientOf, type AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import type { ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { enqueueJob } from '@/server/jobs/queue';
import { contactKey, normalizeContact } from '@/server/security/contact-key';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import {
  appendJournalEntry,
  journalEntryFor,
  reconcileJobKey,
  SUPPRESSION_JOURNAL_PAYLOAD_VERSION,
  SUPPRESSION_JOURNAL_RECONCILE_JOB,
  type JournalDeps,
} from './suppression-journal';

type Tx = Prisma.TransactionClient;
type JournalAction = 'STOP' | 'CLEAR';

export type SuppressionDeps = JournalDeps & {
  /** SUPPRESSION_PEPPER (C17). */
  contactKeyPepper: string;
};

export type ContactRef = { kind: 'phone' | 'email'; value: string };

/** Journal entries owed by the current transaction; appended only after it commits. */
export class SuppressionJournalBatch {
  #entries: Array<{ suppressionId: string; action: JournalAction }> = [];
  add(suppressionId: string, action: JournalAction): void {
    this.#entries.push({ suppressionId, action });
  }
  clear(): void {
    this.#entries = [];
  }
  entries(): ReadonlyArray<{ suppressionId: string; action: JournalAction }> {
    return [...this.#entries];
  }
}

/** Where a write records its journal obligation: a batch flushed after commit, or a reconcile job queued in the same transaction. */
export type JournalSink = SuppressionJournalBatch | 'enqueue-reconcile';

export type SuppressionCtx = AuditCtx & { workspaceId: string | null; clock: Clock };

export type JournalFlushResult = { appended: number; failed: number };

const CHANNEL_KIND: Record<Channel, ContactRef['kind']> = { WHATSAPP: 'phone', EMAIL: 'email' };

// ---- Transactions and the journal ------------------------------------------------------------------

/**
 * Runs `fn` in one immediate transaction, then appends the journal lines its suppression writes
 * owe. Returns the callback's value and the flush outcome.
 */
export async function runSuppressionTx<R>(
  ctx: AppCtx,
  deps: JournalDeps,
  fn: (tx: Tx, batch: SuppressionJournalBatch) => Promise<R>,
): Promise<{ value: R; journal: JournalFlushResult }> {
  const batch = new SuppressionJournalBatch();
  const value = await withTx(ctx.db, async (scoped: ScopedTx) => {
    batch.clear();
    return fn(scoped as unknown as Tx, batch);
  });
  const journal = await flushSuppressionJournal(baseClientOf(ctx), ctx.clock, deps, batch, ctx.correlationId);
  return { value, journal };
}

export async function withSuppressionTx<R>(ctx: AppCtx, deps: JournalDeps, fn: (tx: Tx, batch: SuppressionJournalBatch) => Promise<R>): Promise<R> {
  return (await runSuppressionTx(ctx, deps, fn)).value;
}

/**
 * After commit: appends one fsynced line per owed entry and stamps the row. A failed append leaves
 * the stamp null and queues the reconcile job; it never throws, because the suppression itself is
 * already committed.
 */
export async function flushSuppressionJournal(
  db: PrismaClient,
  clock: Clock,
  deps: JournalDeps,
  batch: SuppressionJournalBatch,
  correlationId: string,
): Promise<JournalFlushResult> {
  const out: JournalFlushResult = { appended: 0, failed: 0 };
  for (const { suppressionId, action } of batch.entries()) {
    const row = await db.suppression.findFirst({ where: { id: suppressionId } });
    if (!row) continue;
    if ((action === 'STOP' ? row.journaledAt : row.clearJournaledAt) !== null) continue;
    try {
      await appendJournalEntry(deps, journalEntryFor(row, action));
    } catch {
      out.failed += 1;
      await queueReconcile(db, clock, row.workspaceId, suppressionId, action, correlationId).catch(() => undefined);
      continue;
    }
    out.appended += 1;
    const now = clock.now();
    await withTx(db, (tx) =>
      action === 'STOP'
        ? tx.suppression.updateMany({ where: { id: suppressionId, journaledAt: null }, data: { journaledAt: now } })
        : tx.suppression.updateMany({ where: { id: suppressionId, clearJournaledAt: null }, data: { clearJournaledAt: now } }),
    ).catch(() => queueReconcile(db, clock, row.workspaceId, suppressionId, action, correlationId).catch(() => undefined));
  }
  return out;
}

function queueReconcile(db: Pick<PrismaClient, 'job'> | Pick<Tx, 'job'>, clock: Clock, workspaceId: string, suppressionId: string, action: JournalAction, correlationId: string) {
  return enqueueJob(db, clock, {
    type: SUPPRESSION_JOURNAL_RECONCILE_JOB,
    payload: {},
    payloadVersion: SUPPRESSION_JOURNAL_PAYLOAD_VERSION,
    workspaceId,
    idempotencyKey: reconcileJobKey(suppressionId, action),
    correlationId,
  });
}

async function owe(tx: Tx, ctx: SuppressionCtx, sink: JournalSink, workspaceId: string, suppressionId: string, action: JournalAction): Promise<void> {
  if (sink === 'enqueue-reconcile') await queueReconcile(tx, ctx.clock, workspaceId, suppressionId, action, ctx.correlationId);
  else sink.add(suppressionId, action);
}

// ---- Stop ----------------------------------------------------------------------------------------

export type SuppressInput = {
  channel: Channel;
  contact: ContactRef;
  reason: SuppressionReason;
  /** WebhookEvent id, svix id, message id: what caused it. */
  sourceEventId?: string | null;
  simulated?: boolean;
};

export type SuppressResult = { outcome: 'CREATED' | 'ALREADY_ACTIVE'; suppressionId: string; cancelledAttempts: number };

function contactFor(pepper: string, channel: Channel, contact: ContactRef): { key: string; plain: string } {
  if (CHANNEL_KIND[channel] !== contact.kind) {
    throw new ValidationError({ code: 'CONTACT_CHANNEL_MISMATCH', message: `a ${contact.kind} cannot be suppressed on ${channel}` });
  }
  try {
    return { key: contactKey(pepper, contact.kind, contact.value), plain: normalizeContact(contact.kind, contact.value) };
  } catch {
    throw new ValidationError({ code: 'CONTACT_INVALID', message: `the ${contact.kind} to suppress is not normalized` });
  }
}

/** Inside the caller's transaction: inserts the active row (or audits a repeat) and cancels queued work. */
export async function suppressContact(tx: Tx, ctx: SuppressionCtx, sink: JournalSink, input: SuppressInput, pepper: string): Promise<SuppressResult> {
  const { key, plain } = contactFor(pepper, input.channel, input.contact);
  return suppressContactKey(tx, ctx, sink, { channel: input.channel, contactKey: key, contactPlain: plain, reason: input.reason, sourceEventId: input.sourceEventId ?? null, simulated: input.simulated ?? false });
}

export type SuppressKeyInput = {
  channel: Channel;
  /** The contact HMAC (C17) when only the key is known (a signed unsubscribe token, T20). */
  contactKey: string;
  /** The normalized contact when known; null keeps no plain copy. */
  contactPlain: string | null;
  reason: SuppressionReason;
  sourceEventId?: string | null;
  simulated?: boolean;
};

/** `suppressContact` for a caller that holds the contact HMAC (and maybe the plain contact). */
export async function suppressContactKey(tx: Tx, ctx: SuppressionCtx, sink: JournalSink, input: SuppressKeyInput): Promise<SuppressResult> {
  const workspaceId = requireWorkspace(ctx);
  if (!/^[0-9a-f]{64}$/.test(input.contactKey)) throw new ValidationError({ code: 'CONTACT_INVALID', message: 'a suppression contact key is a sha256 HMAC in hex' });
  const key = input.contactKey;
  const plain = input.contactPlain;
  const now = ctx.clock.now();
  const cancelledAttempts = await cancelQueuedForContact(tx, ctx, { workspaceId, channel: input.channel, contactKey: key });

  const active = await tx.suppression.findFirst({ where: { workspaceId, channel: input.channel, contactKey: key, clearedAt: null }, select: { id: true } });
  if (active) {
    await recordAudit(tx, ctx, {
      action: 'suppression.stop_repeat',
      targetType: 'Suppression',
      targetId: active.id,
      simulated: input.simulated ?? false,
      summary: { channel: input.channel, reason: input.reason, cancelledAttempts },
    });
    return { outcome: 'ALREADY_ACTIVE', suppressionId: active.id, cancelledAttempts };
  }

  const row = await tx.suppression.create({
    data: { workspaceId, channel: input.channel, contactKey: key, contactPlain: plain, reason: input.reason, sourceEventId: input.sourceEventId ?? null, createdAt: now },
    select: { id: true },
  });
  await recordAudit(tx, ctx, {
    action: 'suppression.stop',
    targetType: 'Suppression',
    targetId: row.id,
    simulated: input.simulated ?? false,
    summary: { channel: input.channel, reason: input.reason, cancelledAttempts, hasSourceEvent: input.sourceEventId != null },
  });
  await owe(tx, ctx, sink, workspaceId, row.id, 'STOP');
  return { outcome: 'CREATED', suppressionId: row.id, cancelledAttempts };
}

/** Records a suppression in its own transaction and journals it after commit. */
export async function recordSuppression(ctx: AppCtx, input: SuppressInput, deps: SuppressionDeps): Promise<SuppressResult & { journal: JournalFlushResult }> {
  const { value, journal } = await runSuppressionTx(ctx, deps, (tx, batch) => suppressContact(tx, ctx, batch, input, deps.contactKeyPepper));
  return { ...value, journal };
}

/**
 * Cancels QUEUED (including retry-waiting) dispatch attempts to this contact on this channel:
 * attempts CANCELLED(`SUPPRESSED`), their QUEUED jobs CANCELLED, RUNNING jobs flagged for cancel,
 * PENDING messages NOT_SENT. Returns the number of attempts cancelled.
 */
export async function cancelQueuedForContact(tx: Tx, ctx: { clock: Clock }, target: { workspaceId: string; channel: Channel; contactKey: string }): Promise<number> {
  const conversations = await tx.conversation.findMany({ where: { workspaceId: target.workspaceId, channel: target.channel, contactKey: target.contactKey }, select: { id: true } });
  if (conversations.length === 0) return 0;
  const messages = await tx.message.findMany({ where: { workspaceId: target.workspaceId, conversationId: { in: conversations.map((c) => c.id) }, direction: 'OUT' }, select: { id: true } });
  if (messages.length === 0) return 0;
  const queued = await tx.dispatchAttempt.findMany({
    where: { workspaceId: target.workspaceId, channel: target.channel, state: 'QUEUED', messageId: { in: messages.map((m) => m.id) } },
    select: { id: true, jobId: true, messageId: true },
  });
  if (queued.length === 0) return 0;
  const now = ctx.clock.now();
  const cancelled = await tx.dispatchAttempt.updateMany({ where: { id: { in: queued.map((a) => a.id) }, state: 'QUEUED' }, data: { state: 'CANCELLED', reasonCode: 'SUPPRESSED' } });
  const jobIds = [...new Set(queued.map((a) => a.jobId))];
  await tx.job.updateMany({ where: { id: { in: jobIds }, status: 'QUEUED' }, data: { status: 'CANCELLED', finishedAt: now, updatedAt: now } });
  await tx.job.updateMany({ where: { id: { in: jobIds }, status: 'RUNNING', cancelRequestedAt: null }, data: { cancelRequestedAt: now, updatedAt: now } });
  await tx.message.updateMany({ where: { id: { in: queued.map((a) => a.messageId) }, status: 'PENDING' }, data: { status: 'NOT_SENT' } });
  return cancelled.count;
}

// ---- Re-opt-in -----------------------------------------------------------------------------------

export type ReoptInOutcome = 'CLEARED' | 'NOT_SUPPRESSED' | 'EVIDENCE_NOT_NEWER' | 'NOT_OPT_IN' | 'BACKFILLED_SOURCE';

/** `id` is null only for a backfilled consent checked before it is recorded (ADR-120). */
export type ReoptInConsent = { id: string | null; channel: Channel; contactKey: string; basis: string; collectedAt: Date };

/**
 * Inside the transaction that recorded `consent`: clears the active suppression when the consent is
 * an OPT_IN whose evidence time is strictly newer than the latest Stop. A refusal is audited.
 *
 * `backfilled` (ADR-120): consent from a backfilled source (a file import) never clears a
 * suppression, whatever its evidence time: an active suppression answers `BACKFILLED_SOURCE`,
 * audited `suppression.clear_refused`. Such a check may run before the consent is recorded (id
 * null), so the caller can leave a suppressed contact without consent.
 */
export async function clearSuppressionForConsent(
  tx: Tx,
  ctx: SuppressionCtx,
  sink: JournalSink,
  consent: ReoptInConsent,
  opts: { simulated?: boolean; backfilled?: boolean } = {},
): Promise<ReoptInOutcome> {
  const workspaceId = requireWorkspace(ctx);
  if (consent.basis !== 'OPT_IN') return 'NOT_OPT_IN';
  const where = { workspaceId, channel: consent.channel, contactKey: consent.contactKey };
  const active = await tx.suppression.findFirst({ where: { ...where, clearedAt: null }, select: { id: true } });
  if (!active) return 'NOT_SUPPRESSED';
  if (opts.backfilled) {
    await recordAudit(tx, ctx, {
      action: 'suppression.clear_refused',
      targetType: 'Suppression',
      targetId: active.id,
      result: 'DENIED',
      simulated: opts.simulated ?? false,
      summary: { channel: consent.channel, consentId: consent.id, reasonCode: 'BACKFILLED_SOURCE' },
    });
    return 'BACKFILLED_SOURCE';
  }
  if (consent.id === null) throw new Error('only a backfilled consent may be checked before it is recorded');
  const latest = await tx.suppression.findFirst({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true } });
  const latestStop = latest?.createdAt ?? new Date(0);

  if (consent.collectedAt.getTime() <= latestStop.getTime()) {
    await recordAudit(tx, ctx, {
      action: 'suppression.clear_refused',
      targetType: 'Suppression',
      targetId: active.id,
      result: 'DENIED',
      simulated: opts.simulated ?? false,
      summary: { channel: consent.channel, consentId: consent.id, reasonCode: 'EVIDENCE_NOT_NEWER' },
    });
    return 'EVIDENCE_NOT_NEWER';
  }

  const now = ctx.clock.now();
  const updated = await tx.suppression.updateMany({ where: { id: active.id, clearedAt: null }, data: { clearedAt: now, clearedByConsentId: consent.id } });
  if (updated.count !== 1) return 'NOT_SUPPRESSED';
  await recordAudit(tx, ctx, {
    action: 'suppression.clear',
    targetType: 'Suppression',
    targetId: active.id,
    simulated: opts.simulated ?? false,
    summary: { channel: consent.channel, consentId: consent.id },
  });
  await owe(tx, ctx, sink, workspaceId, active.id, 'CLEAR');
  return 'CLEARED';
}
