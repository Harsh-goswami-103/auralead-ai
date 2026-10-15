/**
 * R18 / T-e2 (plan §6.1, §6.3, 01-arch §4.3 race e): a dispatch job held at P1 (claimed, before
 * preflight) while the quote is edited to v2 makes zero provider calls when released; its attempt
 * is CANCELLED with SUPERSEDED and the Message is NOT_SENT. An expired quote is cancelled the same
 * way (QUOTE_EXPIRED).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setPauseHandler } from '@/server/testing/pause';
import { approveAndSendQuote } from '@/server/services/messaging/dispatch';
import { reviseQuote } from '@/server/services/quotes/versioning';
import { createDispatchHarness, DEPS, eligibleLead, quoteWithPdf, SERVICE_CONSULT, type DispatchHarness } from './support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('version-binding');
}, 120_000);
afterAll(async () => h?.destroy());
afterEach(() => setPauseHandler('dispatch.p1', null));

describe('version binding (T-e2)', () => {
  it('hold at P1, edit the quote, release: 0 calls, CANCELLED SUPERSEDED', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const owner = await h.owner();
    const r = await approveAndSendQuote(owner, { quoteId: quote.id, expectedVersion: 1, channel: 'EMAIL' }, DEPS);

    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const atP1 = new Promise<void>((resolve) => (reached = resolve));
    setPauseHandler('dispatch.p1', () => {
      reached();
      return new Promise<void>((resolve) => (release = resolve));
    });
    const running = h.worker.tick();
    await atP1;

    const revised = await reviseQuote(owner, quote.id, { expectedVersion: 1, items: [{ serviceId: SERVICE_CONSULT, qty: 2 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Two consultations.', timelineText: 'Two visits' });
    expect(revised.invalidated.dispatchAttempts).toBe(1);
    release();
    await running;
    setPauseHandler('dispatch.p1', null);
    await h.drain();

    expect(h.email.calls).toHaveLength(0);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPERSEDED' });
    expect((await h.db.message.findUniqueOrThrow({ where: { id: r.messageId } })).status).toBe('NOT_SENT');
    expect((await h.db.job.findUniqueOrThrow({ where: { id: r.jobId } })).status).toBe('CANCELLED');
    expect(await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } })).toMatchObject({ status: 'DRAFT', currentVersionNo: 2 });
  }, 60_000);

  it('a quote that expired before preflight is never sent (QUOTE_EXPIRED)', async () => {
    const lead = await eligibleLead(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const r = await approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel: 'EMAIL' }, DEPS);
    const q = await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } });
    await h.db.quote.update({ where: { id: quote.id }, data: { validUntil: new Date(h.clock.now().getTime() - 1) } });
    await h.drain();
    expect(h.email.calls).toHaveLength(0);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'QUOTE_EXPIRED' });
    expect(q.status).toBe('APPROVED');
  }, 60_000);
});
