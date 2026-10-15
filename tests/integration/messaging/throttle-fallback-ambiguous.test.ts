/**
 * AT11 (plan §4.4, §7): throttles defer, fallback needs its own eligibility, ambiguity is visible.
 *  - internal daily cap reached: the attempt stays QUEUED and the job moves to the next local day;
 *  - provider 429: the job backs off by Retry-After and later preflights in the workspace defer
 *    until the throttle window closes (0 calls meanwhile);
 *  - email fallback only when enabled AND the email side is independently eligible for an
 *    automated send (attested B2B never qualifies);
 *  - a timeout after the write is AMBIGUOUS ("Delivery unknown"), DEAD(AMBIGUOUS), never resent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryLabel } from '@/server/services/messaging/delivery-state';
import { approveAndSendMessage, approveAndSendQuote, createMessageDraft, FALLBACK_INITIATOR } from '@/server/services/messaging/dispatch';
import { startOfLocalDay } from '@/server/services/messaging/eligibility';
import { ambiguous, createDispatchHarness, createLead, DEPS, eligibleLead, grantConsent, quoteWithPdf, rateLimited, WS_A, type DispatchHarness } from '../dispatch/support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('throttle-fallback');
}, 120_000);
afterAll(async () => h?.destroy());

async function manualEmail(leadId: string, subject = 'Hello') {
  const owner = await h.owner();
  const draft = await createMessageDraft(owner, { leadId, channel: 'EMAIL', kind: 'EMAIL', subject, body: 'Body text.' }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

describe('throttle, fallback, ambiguous (AT11)', () => {
  it('internal cap reached defers to the next local day with the attempt still QUEUED', async () => {
    await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { internalEmailDailyCap: 1 } });
    const first = await manualEmail((await eligibleLead(h.db)).id);
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: first.attemptId } })).toMatchObject({ state: 'SENT' });

    const second = await manualEmail((await eligibleLead(h.db)).id);
    const calls0 = h.email.calls.length;
    await h.drain();
    expect(h.email.calls.length).toBe(calls0);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: second.attemptId } })).toMatchObject({ state: 'QUEUED' });
    const job = await h.db.job.findUniqueOrThrow({ where: { id: second.jobId } });
    expect(job).toMatchObject({ status: 'QUEUED', lastErrorCode: 'CAP_REACHED', attempts: 0 });
    const nextDay = startOfLocalDay(new Date(h.clock.now().getTime() + 86_400_000), 'Asia/Kolkata');
    expect(job.runAt.toISOString()).toBe(nextDay.toISOString());

    // Next local day: the cap resets and the same attempt sends.
    h.clock.set(nextDay.toISOString());
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: second.attemptId } })).toMatchObject({ state: 'SENT' });
    await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { internalEmailDailyCap: null } });
  }, 60_000);

  it('a provider 429 backs the job off by Retry-After and defers other sends until the window closes', async () => {
    const a = await manualEmail((await eligibleLead(h.db)).id, 'A');
    h.email.answer(rateLimited(120_000));
    await h.drain();
    const jobA = await h.db.job.findUniqueOrThrow({ where: { id: a.jobId } });
    expect(jobA.runAt.getTime()).toBeGreaterThanOrEqual(h.clock.now().getTime() + 120_000);

    const b = await manualEmail((await eligibleLead(h.db)).id, 'B');
    const calls0 = h.email.calls.length;
    await h.drain();
    expect(h.email.calls.length).toBe(calls0);
    const jobB = await h.db.job.findUniqueOrThrow({ where: { id: b.jobId } });
    expect(jobB).toMatchObject({ status: 'QUEUED', lastErrorCode: 'PROVIDER_THROTTLED' });
    expect(jobB.runAt.getTime()).toBe(jobA.runAt.getTime());

    h.clock.set(new Date(jobA.runAt.getTime()).toISOString());
    await h.drain();
    expect(h.email.calls.length).toBe(calls0 + 2);
    expect((await h.db.dispatchAttempt.findMany({ where: { messageId: { in: [a.messageId, b.messageId] }, state: 'SENT' } })).length).toBe(2);
  }, 60_000);

  describe('email fallback for a skipped WhatsApp send', () => {
    async function whatsappToLeadWithoutOptIn(lead: { id: string }) {
      const owner = await h.owner();
      const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Your report is ready.' }, DEPS);
      return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    }
    const fallbacks = (leadId: string) => h.db.message.findMany({ where: { channel: 'EMAIL', initiatedBy: FALLBACK_INITIATOR, conversation: { leadId } } });

    it('is not used while the workspace setting is off', async () => {
      const lead = await createLead(h.db);
      await grantConsent(h.db, lead, 'EMAIL');
      const r = await whatsappToLeadWithoutOptIn(lead);
      await h.drain();
      expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'NO_WHATSAPP_OPT_IN' });
      expect(await fallbacks(lead.id)).toHaveLength(0);
    }, 60_000);

    it('is refused when email is only B2B-attested (manual only), even with the setting on', async () => {
      await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { emailFallbackEnabled: true, autoSendEnabled: true, emailB2bAttestationEnabled: true } });
      const lead = await createLead(h.db, { source: 'GMAPS_EXTENSION' });
      await grantConsent(h.db, lead, 'EMAIL', 'B2B_ATTESTED');
      const r = await whatsappToLeadWithoutOptIn(lead);
      await h.drain();
      expect((await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).state).toBe('SKIPPED');
      expect(await fallbacks(lead.id)).toHaveLength(0);
      const refused = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'dispatch.fallback_refused', targetId: r.messageId } });
      expect(JSON.stringify(refused.summary)).toContain('ATTESTED_MANUAL_ONLY');
    }, 60_000);

    it('queues and sends an automated email when enabled and email is independently eligible', async () => {
      const lead = await createLead(h.db);
      await grantConsent(h.db, lead, 'EMAIL');
      const calls0 = h.email.calls.length;
      const r = await whatsappToLeadWithoutOptIn(lead);
      await h.drain();
      expect((await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).state).toBe('SKIPPED');
      const [email] = await fallbacks(lead.id);
      expect(email).toMatchObject({ sendIntent: 'AUTOMATED', body: 'Your report is ready.', status: 'SENT' });
      expect(h.email.calls.length).toBe(calls0 + 1);
      expect(h.wa.calls.filter((c) => c.request.attemptId === r.attemptId)).toHaveLength(0);
      await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { emailFallbackEnabled: false, autoSendEnabled: false, emailB2bAttestationEnabled: false } });
    }, 60_000);
  });

  it('a timeout after the write is AMBIGUOUS, shown as "Delivery unknown", and never sent again', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const r = await approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel: 'EMAIL' }, DEPS);
    h.email.answer(ambiguous());
    const calls0 = h.email.calls.length;
    await h.drain();
    h.clock.advance(60 * 60_000);
    await h.drain();
    expect(h.email.calls.length).toBe(calls0 + 1);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'AMBIGUOUS', reasonCode: 'TIMEOUT_AFTER_WRITE' });
    expect(await h.db.dispatchAttempt.count({ where: { messageId: r.messageId } })).toBe(1);
    const message = await h.db.message.findUniqueOrThrow({ where: { id: r.messageId } });
    expect(deliveryLabel(message.status)).toBe('Delivery unknown');
    expect(await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).toMatchObject({ status: 'DEAD', deadReason: 'AMBIGUOUS', retrySafe: false });
    expect((await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).status).toBe('APPROVED');
  }, 60_000);
});
