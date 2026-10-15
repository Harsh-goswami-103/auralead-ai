/**
 * R25, T-a1 / T-a2 (plan §4.4 pause points): a Stop that lands while a dispatch job is in flight.
 *  - T-a1, Stop at P1 (claimed, before preflight): the preflight sees the cancelled attempt; 0 calls.
 *  - T-a2, Stop at P2 (SENDING already committed): that one call goes out (the request was decided
 *    before the Stop, plan §13 "in-flight provider delivery"), exactly 1 call; its retry (attempt
 *    N+1, queued by the settle after a 429) re-runs preflight and is skipped SUPPRESSED, 0 more calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setPauseHandler } from '@/server/testing/pause';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { approvedTemplate, attemptsOf, createLead, DEPS, grantConsent, rateLimited } from '../dispatch/support';
import { activeSuppression, createInboundHarness, inbound, phoneKey, type InboundHarness } from './inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('stop-race');
}, 120_000);
afterAll(async () => h?.destroy());
afterEach(() => {
  setPauseHandler('dispatch.p1', null);
  setPauseHandler('dispatch.p2', null);
});

async function templateSend(lead: { id: string }) {
  const owner = await h.owner();
  const template = await approvedTemplate(h.db);
  const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

describe('Stop racing an in-flight dispatch', () => {
  it('T-a1: Stop at P1 gives 0 provider calls', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const sent = await templateSend(lead);
    let stopped = false;
    setPauseHandler('dispatch.p1', async () => {
      if (stopped) return;
      stopped = true;
      const { res } = await inbound(lead, { text: 'Stop' }, h.clock.now());
      expect(res.status).toBe(200);
    });
    const calls0 = h.wa.calls.length;
    await h.drain();
    expect(stopped).toBe(true);
    expect(h.wa.calls.length).toBe(calls0);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPPRESSED' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: sent.jobId } })).toMatchObject({ status: 'CANCELLED' });
  }, 60_000);

  it('T-a2: Stop at P2 gives exactly 1 call; the retry gives 0', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const sent = await templateSend(lead);
    let stopped = false;
    setPauseHandler('dispatch.p2', async () => {
      if (stopped) return;
      stopped = true;
      await inbound(lead, { button: { payload: 'AL_QR_STOP_V1', text: 'Stop' } }, h.clock.now());
      // The attempt was already SENDING: the Stop leaves it to the settle path.
      expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'SENDING' });
    });
    const calls0 = h.wa.calls.length;
    h.wa.answer(rateLimited(30_000));
    await h.drain();
    expect(stopped).toBe(true);
    expect(h.wa.calls.length).toBe(calls0 + 1);
    expect(await activeSuppression(h, 'WHATSAPP', phoneKey(lead.phoneE164!))).not.toBeNull();

    h.clock.advance(5 * 60_000);
    await h.drain();
    expect(h.wa.calls.length).toBe(calls0 + 1);
    expect((await attemptsOf(h.db, sent.messageId)).map((a) => [a.state, a.reasonCode])).toEqual([
      ['FAILED', 'RATE_LIMITED'],
      ['SKIPPED', 'SUPPRESSED'],
    ]);
  }, 60_000);
});
