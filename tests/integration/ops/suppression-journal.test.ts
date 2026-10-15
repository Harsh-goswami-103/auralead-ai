// E8, ADR-38, O1 (producer part): the SuppressionJournal.
// - Each Stop and each clear appends exactly one fsynced JSONL line to
//   <journalDir>/suppressions-YYYYMMDD.jsonl after the transaction commits, and stamps journaledAt /
//   clearJournaledAt.
// - A failed append leaves the stamp null and queues `suppression.journalReconcile`, which
//   re-exports the row exactly once (idempotent by journalId, also when the line already exists).
// - A rolled-back transaction writes no line.
// - A clear that happens inside someone else's transaction (consent captured at ingestion) is
//   exported by the reconcile job it queues in that transaction.
// - A Stop cancels the contact's QUEUED dispatch attempts and their jobs in the same transaction.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactKey } from '@/server/security/contact-key';
import { ingestBatch } from '@/server/services/leads/ingest';
import { suppressContact, recordSuppression, withSuppressionTx } from '@/server/services/messaging/suppression';
import { journalFileName, readJournal } from '@/server/services/messaging/suppression-journal';
import { DEPS } from '../ingest/support';
import { createConsentHarness, createLead, drain, journalLines, PEPPER, reconcileWorker, WS_A, wsCtx, type ConsentHarness } from '../consent/support';

let h: ConsentHarness;

beforeAll(async () => {
  h = await createConsentHarness('suppression-journal');
});
afterAll(async () => {
  await h.cleanup();
});

const reconcileJobs = () => h.db.job.findMany({ where: { type: 'suppression.journalReconcile' }, orderBy: { createdAt: 'asc' } });

describe('SuppressionJournal producer (E8)', () => {
  it('a Stop commits the row, then appends exactly one line and stamps journaledAt', async () => {
    h.clock.set('2026-10-16T06:00:00.000Z');
    const phone = '+919845600001';
    const result = await recordSuppression(wsCtx(h), { channel: 'WHATSAPP', contact: { kind: 'phone', value: phone }, reason: 'STOP_BUTTON', sourceEventId: 'wa:evt-1' }, h.deps);
    expect(result.outcome).toBe('CREATED');

    const lines = await journalLines(h.journalDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      journalId: `${result.suppressionId}:STOP`,
      workspaceId: WS_A,
      contactKey: contactKey(PEPPER, 'phone', phone),
      channel: 'WHATSAPP',
      action: 'STOP',
      reason: 'STOP_BUTTON',
      createdAt: '2026-10-16T06:00:00.000Z',
      sourceEventId: 'wa:evt-1',
      suppressionId: result.suppressionId,
      consentId: null,
    });
    expect(journalFileName(new Date('2026-10-16T06:00:00.000Z'))).toBe('suppressions-20261016.jsonl');
    expect(JSON.stringify(lines)).not.toContain('98456');

    const row = await h.db.suppression.findUniqueOrThrow({ where: { id: result.suppressionId } });
    expect(row.journaledAt?.toISOString()).toBe('2026-10-16T06:00:00.000Z');
    expect(row.contactPlain).toBe(phone);
    expect(await h.db.auditEvent.count({ where: { action: 'suppression.stop', targetId: result.suppressionId } })).toBe(1);

    // A repeat while active writes no new line.
    const repeat = await recordSuppression(wsCtx(h), { channel: 'WHATSAPP', contact: { kind: 'phone', value: phone }, reason: 'STOP_KEYWORD' }, h.deps);
    expect(repeat).toMatchObject({ outcome: 'ALREADY_ACTIVE', suppressionId: result.suppressionId });
    expect(await journalLines(h.journalDir)).toHaveLength(1);
    expect(await reconcileJobs()).toHaveLength(0);
  });

  it('a rolled-back transaction writes no row and no line', async () => {
    const before = (await journalLines(h.journalDir)).length;
    const ctx = wsCtx(h);
    await expect(
      withSuppressionTx(ctx, h.deps, async (tx, batch) => {
        await suppressContact(tx, ctx, batch, { channel: 'EMAIL', contact: { kind: 'email', value: 'rollback@example.test' }, reason: 'UNSUBSCRIBE' }, PEPPER);
        throw new Error('route failed after the suppression insert');
      }),
    ).rejects.toThrow('route failed');
    expect(await h.db.suppression.count({ where: { contactKey: contactKey(PEPPER, 'email', 'rollback@example.test') } })).toBe(0);
    expect(await journalLines(h.journalDir)).toHaveLength(before);
  });

  it('a failed append leaves journaledAt null and the reconcile job re-exports it exactly once', async () => {
    h.clock.set('2026-10-17T09:00:00.000Z');
    // Block the journal directory with a regular file: mkdir and open fail for real.
    const before = await journalLines(h.journalDir);
    await rm(h.journalDir, { recursive: true, force: true });
    await mkdir(path.dirname(h.journalDir), { recursive: true });
    await writeFile(h.journalDir, 'not a directory');

    const email = 'bounced@example.test';
    const result = await recordSuppression(wsCtx(h), { channel: 'EMAIL', contact: { kind: 'email', value: email }, reason: 'HARD_BOUNCE', sourceEventId: 'svix:1' }, h.deps);
    expect(result.outcome).toBe('CREATED');
    expect(result.journal).toEqual({ appended: 0, failed: 1 });
    const row = await h.db.suppression.findUniqueOrThrow({ where: { id: result.suppressionId } });
    expect(row.journaledAt).toBeNull();
    const jobs = await reconcileJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'QUEUED', workspaceId: WS_A, idempotencyKey: `suppression.journalReconcile:${result.suppressionId}:STOP` });

    // While the directory is still blocked the job retries; nothing is lost.
    const w = reconcileWorker(h);
    expect(await w.tick()).toBe('ran');
    expect((await h.db.job.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).status).toBe('QUEUED');

    // Unblock, restore the earlier lines, and let the retry run.
    await rm(h.journalDir, { force: true });
    await mkdir(h.journalDir, { recursive: true });
    await writeFile(path.join(h.journalDir, journalFileName(new Date('2026-10-16T06:00:00.000Z'))), before.map((l) => JSON.stringify(l) + '\n').join(''));
    h.clock.advance(5_000);
    await drain(w);
    expect((await h.db.job.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).status).toBe('SUCCEEDED');

    const exported = (await journalLines(h.journalDir)).filter((l) => l.suppressionId === result.suppressionId);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ action: 'STOP', reason: 'HARD_BOUNCE', channel: 'EMAIL', createdAt: '2026-10-17T09:00:00.000Z' });
    expect((await h.db.suppression.findUniqueOrThrow({ where: { id: result.suppressionId } })).journaledAt).not.toBeNull();
    // The exported line goes in the file of the event's day.
    expect((await readJournal(h.journalDir)).map((e) => e.journalId)).toContain(`${result.suppressionId}:STOP`);
  });

  it('reconcile is idempotent by journalId: a line already present is not appended again', async () => {
    const rows = await h.db.suppression.findMany({ where: { workspaceId: WS_A } });
    // Simulate a crash between the append and the journaledAt stamp.
    await h.db.suppression.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { journaledAt: null } });
    const before = (await journalLines(h.journalDir)).length;
    const ctx = wsCtx(h);
    const { enqueueJob } = await import('@/server/jobs/queue');
    await enqueueJob(h.db, h.clock, { type: 'suppression.journalReconcile', payload: {}, workspaceId: WS_A, idempotencyKey: 'suppression.journalReconcile:manual-1', correlationId: ctx.correlationId });
    await drain(reconcileWorker(h));
    expect(await journalLines(h.journalDir)).toHaveLength(before);
    expect(await h.db.suppression.count({ where: { workspaceId: WS_A, journaledAt: null } })).toBe(0);
    // A second run changes nothing.
    await enqueueJob(h.db, h.clock, { type: 'suppression.journalReconcile', payload: {}, workspaceId: WS_A, idempotencyKey: 'suppression.journalReconcile:manual-2', correlationId: ctx.correlationId });
    await drain(reconcileWorker(h));
    expect(await journalLines(h.journalDir)).toHaveLength(before);
  });

  it('a clear inside the ingestion transaction is exported by the reconcile job it queues', async () => {
    h.clock.set('2026-10-18T10:00:00.000Z');
    const phone = '+919845600077';
    const stop = await recordSuppression(wsCtx(h), { channel: 'WHATSAPP', contact: { kind: 'phone', value: phone }, reason: 'STOP_KEYWORD', sourceEventId: 'wa:evt-77' }, h.deps);
    h.clock.set('2026-10-18T11:00:00.000Z');
    const notice = 'Yes, send me WhatsApp offers.';
    const batch = await ingestBatch(
      wsCtx(h),
      {
        source: 'GOOGLE_SHEETS',
        externalBatchId: 'journal-reopt',
        mapping: { version: 1, consent: { column: 'wa', truthyValues: ['yes'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: notice } },
        records: [{ externalId: 'row-77', fields: { name: 'Kabir Shah', phone }, answers: { wa: 'yes' }, submittedAt: '2026-10-18T10:30:00.000Z' }],
      },
      DEPS,
    );
    const consentId = batch.records[0]!.consent.outcome === 'CREATED' ? batch.records[0]!.consent.consentRecordId : null;
    expect(consentId).not.toBeNull();

    const row = await h.db.suppression.findUniqueOrThrow({ where: { id: stop.suppressionId } });
    expect(row.clearedByConsentId).toBe(consentId);
    expect(row.clearJournaledAt).toBeNull();
    const job = await h.db.job.findUniqueOrThrow({ where: { idempotencyKey: `suppression.journalReconcile:${stop.suppressionId}:CLEAR` } });
    expect(job.status).toBe('QUEUED');

    await drain(reconcileWorker(h));
    const clears = (await journalLines(h.journalDir)).filter((l) => l.suppressionId === stop.suppressionId && l.action === 'CLEAR');
    expect(clears).toEqual([
      {
        journalId: `${stop.suppressionId}:CLEAR`,
        workspaceId: WS_A,
        contactKey: contactKey(PEPPER, 'phone', phone),
        channel: 'WHATSAPP',
        action: 'CLEAR',
        reason: 'STOP_KEYWORD',
        createdAt: '2026-10-18T11:00:00.000Z',
        sourceEventId: 'wa:evt-77',
        suppressionId: stop.suppressionId,
        consentId,
      },
    ]);
    expect((await h.db.suppression.findUniqueOrThrow({ where: { id: stop.suppressionId } })).clearJournaledAt).not.toBeNull();
  });

  it('a Stop cancels the contact’s QUEUED attempts and their jobs in the same transaction; other contacts keep theirs', async () => {
    h.clock.set('2026-10-19T08:00:00.000Z');
    const lead = await createLead(h.db, { phone: '+919845600099' });
    const other = await createLead(h.db, { phone: '+919845600098' });
    const queue = async (leadId: string, phone: string, tag: string) => {
      const conversation = await h.db.conversation.create({ data: { workspaceId: WS_A, leadId, channel: 'WHATSAPP', contactKey: contactKey(PEPPER, 'phone', phone) } });
      const message = await h.db.message.create({
        data: { workspaceId: WS_A, conversationId: conversation.id, channel: 'WHATSAPP', direction: 'OUT', kind: 'TEXT', body: 'Hello', status: 'PENDING', sendIntent: 'MANUAL_SINGLE', initiatedBy: 'user-x' },
      });
      const job = await h.db.job.create({
        data: { workspaceId: WS_A, type: 'dispatch.whatsapp', payload: {}, status: 'QUEUED', runAt: h.clock.now(), maxAttempts: 5, idempotencyKey: `j-${tag}`, correlationId: 'c', createdAt: h.clock.now(), updatedAt: h.clock.now() },
      });
      const attempt = await h.db.dispatchAttempt.create({
        data: { workspaceId: WS_A, messageId: message.id, channel: 'WHATSAPP', attemptNo: 1, state: 'QUEUED', sendIntent: 'MANUAL_SINGLE', initiatedBy: 'user-x', idempotencyKey: `a-${tag}`, jobId: job.id },
      });
      return { message, job, attempt };
    };
    const mine = await queue(lead.id, '+919845600099', 'mine');
    const theirs = await queue(other.id, '+919845600098', 'theirs');

    const result = await recordSuppression(wsCtx(h), { channel: 'WHATSAPP', contact: { kind: 'phone', value: '+919845600099' }, reason: 'STOP_BUTTON' }, h.deps);
    expect(result.cancelledAttempts).toBe(1);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: mine.attempt.id } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPPRESSED' });
    expect((await h.db.job.findUniqueOrThrow({ where: { id: mine.job.id } })).status).toBe('CANCELLED');
    expect((await h.db.message.findUniqueOrThrow({ where: { id: mine.message.id } })).status).toBe('NOT_SENT');
    expect((await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: theirs.attempt.id } })).state).toBe('QUEUED');
    expect((await h.db.job.findUniqueOrThrow({ where: { id: theirs.job.id } })).status).toBe('QUEUED');
  });
});
