/**
 * E7 (ADR-41): failure classes.
 *  - provider 429 then 2xx: attempt 1 FAILED(RETRYABLE), attempt 2 SENT; attempt 2 re-ran preflight;
 *  - a Stop between attempt 1 and 2: attempt 2 is CANCELLED/SKIPPED and the provider saw 1 call;
 *  - RETRYABLE at the job's max attempts: DEAD, message FAILED, no attempt N+1;
 *  - PERMANENT: never retried, job SUCCEEDED (handled), message FAILED;
 *  - PRE_SEND behaves like RETRYABLE (new attempt, full preflight).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SendOutcome } from '@/server/adapters/whatsapp/port';
import { approveAndSendQuote } from '@/server/services/messaging/dispatch';
import { recordSuppression } from '@/server/services/messaging/suppression';
import { attemptsOf, createDispatchHarness, DEPS, eligibleLead, permanent, quoteWithPdf, rateLimited, type DispatchHarness } from './support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('retryable');
}, 120_000);
afterAll(async () => h?.destroy());

async function queued(channel: 'EMAIL' = 'EMAIL') {
  const lead = await eligibleLead(h.db);
  const { quote } = await quoteWithPdf(h, lead.id);
  const r = await approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel }, DEPS);
  return { lead, quote, r };
}

const preSend: SendOutcome = { status: 'failed', failureClass: 'PRE_SEND', reasonCode: 'CONNECT_FAILED', error: 'ECONNREFUSED', suppress: false, manualRetryAfterMs: null, throttleScope: null };

describe('retryable rejection (E7)', () => {
  it('429 then 2xx gives attempt 1 FAILED(RETRYABLE) and attempt 2 SENT after a fresh preflight', async () => {
    const { r, quote } = await queued();
    h.email.answer(rateLimited(30_000));
    const calls0 = h.email.calls.length;
    await h.drain();
    let attempts = await attemptsOf(h.db, r.messageId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, state: 'FAILED', failureClass: 'RETRYABLE', reasonCode: 'RATE_LIMITED' });
    expect(attempts[1]).toMatchObject({ attemptNo: 2, state: 'QUEUED', jobId: r.jobId, sendIntent: 'MANUAL_SINGLE', approvalId: r.approvalId });
    const job = await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } });
    expect(job.status).toBe('QUEUED');
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(h.clock.now().getTime() + 30_000); // Retry-After honored
    expect((await h.db.message.findUniqueOrThrow({ where: { id: r.messageId } })).status).toBe('PENDING');

    h.clock.advance(31_000);
    await h.drain();
    attempts = await attemptsOf(h.db, r.messageId);
    expect(attempts[1]).toMatchObject({ state: 'SENT' });
    expect(h.email.calls.length).toBe(calls0 + 2);
    expect(h.email.calls.at(-1)!.request.attemptId).toBe(attempts[1]!.id);
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('SENT');
    expect(await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).toMatchObject({ status: 'SUCCEEDED' });
  }, 60_000);

  it('a Stop between attempt 1 and attempt 2 blocks attempt 2: 1 provider call in total', async () => {
    const { r, lead } = await queued();
    h.email.answer(rateLimited(30_000));
    const calls0 = h.email.calls.length;
    await h.drain();
    expect(h.email.calls.length).toBe(calls0 + 1);

    const ctx = await h.owner();
    const stop = await recordSuppression(ctx, { channel: 'EMAIL', contact: { kind: 'email', value: lead.emailNormalized! }, reason: 'UNSUBSCRIBE' }, { contactKeyPepper: DEPS.contactKeyPepper, journalDir: h.journalDir });
    expect(stop.cancelledAttempts).toBe(1);
    h.clock.advance(31_000);
    await h.drain();
    expect(h.email.calls.length).toBe(calls0 + 1);
    const attempts = await attemptsOf(h.db, r.messageId);
    expect(attempts.map((a) => a.state)).toEqual(['FAILED', 'CANCELLED']);
    expect(attempts[1]!.reasonCode).toBe('SUPPRESSED');
  }, 60_000);

  it('a suppression the Stop path missed is still caught by attempt 2 preflight (SKIPPED SUPPRESSED)', async () => {
    const { r, lead } = await queued();
    h.email.answer(rateLimited(1_000));
    const calls0 = h.email.calls.length;
    await h.drain();
    // A suppression row written without the cancel (e.g. restored from the journal): preflight must still re-check.
    const { contactKey } = await import('@/server/security/contact-key');
    await h.db.suppression.create({ data: { workspaceId: lead.workspaceId, channel: 'EMAIL', contactKey: contactKey(DEPS.contactKeyPepper, 'email', lead.emailNormalized!), reason: 'MANUAL', createdAt: h.clock.now() } });
    h.clock.advance(2_000);
    await h.drain();
    expect(h.email.calls.length).toBe(calls0 + 1);
    const attempts = await attemptsOf(h.db, r.messageId);
    expect(attempts[1]).toMatchObject({ state: 'SKIPPED', reasonCode: 'SUPPRESSED' });
  }, 60_000);

  it('RETRYABLE at max attempts goes DEAD with no further attempt; message FAILED', async () => {
    const { r } = await queued();
    await h.db.job.update({ where: { id: r.jobId }, data: { maxAttempts: 2 } });
    h.email.answer(rateLimited(1_000), rateLimited(1_000));
    const calls0 = h.email.calls.length;
    for (let i = 0; i < 4; i += 1) {
      await h.drain();
      h.clock.advance(5_000);
    }
    expect(h.email.calls.length).toBe(calls0 + 2);
    const attempts = await attemptsOf(h.db, r.messageId);
    expect(attempts.map((a) => [a.state, a.failureClass])).toEqual([
      ['FAILED', 'RETRYABLE'],
      ['FAILED', 'RETRYABLE'],
    ]);
    expect(await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).toMatchObject({ status: 'DEAD', deadReason: 'MAX_ATTEMPTS' });
    expect((await h.db.message.findUniqueOrThrow({ where: { id: r.messageId } })).status).toBe('FAILED');
  }, 60_000);

  it('PERMANENT is never retried: job SUCCEEDED (handled), message FAILED, quote stays APPROVED', async () => {
    const { r, quote } = await queued();
    h.email.answer(permanent('EMAIL_VALIDATION_FAILED'));
    const calls0 = h.email.calls.length;
    await h.drain();
    h.clock.advance(60 * 60_000);
    await h.drain();
    expect(h.email.calls.length).toBe(calls0 + 1);
    const attempts = await attemptsOf(h.db, r.messageId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'FAILED', failureClass: 'PERMANENT', reasonCode: 'EMAIL_VALIDATION_FAILED' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).toMatchObject({ status: 'SUCCEEDED' });
    expect((await h.db.message.findUniqueOrThrow({ where: { id: r.messageId } })).status).toBe('FAILED');
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('APPROVED');
  }, 60_000);

  it('PRE_SEND requeues and attempt 2 sends', async () => {
    const { r } = await queued();
    h.email.answer(preSend);
    await h.drain();
    h.clock.advance(5_000);
    await h.drain();
    const attempts = await attemptsOf(h.db, r.messageId);
    expect(attempts.map((a) => [a.state, a.failureClass])).toEqual([
      ['FAILED', 'PRE_SEND'],
      ['SENT', null],
    ]);
  }, 60_000);
});
