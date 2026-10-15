/**
 * AT10, R25 (Stop half; the takeover half is T21's takeover-race.test.ts): a Stop cancels the
 * contact's QUEUED attempts and its retry-waiting attempts (attempt N+1 QUEUED behind a backoff) in
 * the same transaction, so no adapter call follows; and a job claimed after the Stop re-checks
 * eligibility in its preflight and skips SUPPRESSED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { approvedTemplate, attemptsOf, createLead, DEPS, grantConsent, rateLimited } from '../dispatch/support';
import { createInboundHarness, inbound, type InboundHarness } from './inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('stop-takeover');
}, 120_000);
afterAll(async () => h?.destroy());

async function templateSend(lead: { id: string }, name = 'Asha') {
  const owner = await h.owner();
  const template = await approvedTemplate(h.db);
  const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': name } }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

describe('Stop cancels queued and retrying work (AT10)', () => {
  it('cancels a QUEUED attempt and a retry-waiting attempt in the Stop transaction; 0 calls after', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');

    // First send hits a provider 429: attempt 1 FAILED(RETRYABLE), attempt 2 QUEUED behind a backoff.
    const retrying = await templateSend(lead, 'first');
    h.wa.answer(rateLimited(60_000));
    await h.drain();
    const before = await attemptsOf(h.db, retrying.messageId);
    expect(before.map((a) => a.state)).toEqual(['FAILED', 'QUEUED']);
    const retryJob = await h.db.job.findUniqueOrThrow({ where: { id: retrying.jobId } });
    expect(retryJob.status).toBe('QUEUED');
    expect(retryJob.runAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
    const callsAfterFirst = h.wa.calls.length;

    // A second message is queued and not yet claimed.
    const queued = await templateSend(lead, 'second');

    const { res } = await inbound(lead, { text: 'STOP' }, h.clock.now());
    expect(res.status).toBe(200);

    expect((await attemptsOf(h.db, retrying.messageId)).map((a) => [a.state, a.reasonCode])).toEqual([
      ['FAILED', 'RATE_LIMITED'],
      ['CANCELLED', 'SUPPRESSED'],
    ]);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: queued.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPPRESSED' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: retrying.jobId } })).toMatchObject({ status: 'CANCELLED' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: 'CANCELLED' });

    // Past the backoff: still nothing is sent.
    h.clock.advance(10 * 60_000);
    await h.drain();
    expect(h.wa.calls.length).toBe(callsAfterFirst);
  }, 60_000);

  it('a job claimed after the Stop re-checks in preflight and skips SUPPRESSED (0 calls)', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    await inbound(lead, { button: { payload: 'AL_QR_STOP_V1', text: 'Stop' } }, h.clock.now());

    // Queued after the Stop, so the Stop transaction never saw it; the dispatch preflight must.
    const late = await templateSend(lead, 'late');
    const calls0 = h.wa.calls.length;
    await h.drain();
    expect(h.wa.calls.length).toBe(calls0);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: late.attemptId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'SUPPRESSED' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: late.messageId } })).toMatchObject({ status: 'NOT_SENT' });
  }, 60_000);
});
