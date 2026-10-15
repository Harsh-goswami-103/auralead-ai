/**
 * E6 (ADR-40): a v1 send paused at P3 (provider already called) while the quote is revised to v2
 * and v2 approved. Releasing the v1 settle leaves the Quote APPROVED on v2, sets only v1's sentAt,
 * and audits `quote.sent_superseded_version`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPauseHandler } from '@/server/testing/pause';
import { approveAndSendQuote } from '@/server/services/messaging/dispatch';
import { approveQuote, reviseQuote } from '@/server/services/quotes/versioning';
import { createDispatchHarness, DEPS, eligibleLead, quoteWithPdf, SERVICE_CONSULT, type DispatchHarness } from './support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('superseded-settle');
}, 120_000);
afterAll(async () => {
  setPauseHandler('dispatch.p3', null);
  await h?.destroy();
});

describe('superseded-version settle (E6)', () => {
  it('v1 settles after v2 was approved: quote stays APPROVED on v2, v1 sentAt set, audited', async () => {
    const lead = await eligibleLead(h.db);
    const { quote, version: v1 } = await quoteWithPdf(h, lead.id);
    const owner = await h.owner();
    const r = await approveAndSendQuote(owner, { quoteId: quote.id, expectedVersion: 1, channel: 'EMAIL' }, DEPS);

    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const atP3 = new Promise<void>((resolve) => (reached = resolve));
    setPauseHandler('dispatch.p3', () => {
      reached();
      return new Promise<void>((resolve) => (release = resolve));
    });
    const running = h.worker.tick();
    await atP3;
    expect(h.email.calls).toHaveLength(1);
    expect((await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).state).toBe('SENDING');

    const revised = await reviseQuote(owner, quote.id, { expectedVersion: 1, items: [{ serviceId: SERVICE_CONSULT, qty: 3 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Three visits.', timelineText: 'Three weeks' });
    expect(revised.invalidated.dispatchAttempts).toBe(0); // SENDING is left to the settle CAS
    await approveQuote(owner, quote.id, { expectedVersion: 2 });

    release();
    await running;
    setPauseHandler('dispatch.p3', null);

    const after = await h.db.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(after).toMatchObject({ status: 'APPROVED', currentVersionId: revised.version.id, sentVia: null });
    expect((await h.db.quoteVersion.findUniqueOrThrow({ where: { id: v1.id } })).sentAt).not.toBeNull();
    expect((await h.db.quoteVersion.findUniqueOrThrow({ where: { id: revised.version.id } })).sentAt).toBeNull();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: r.attemptId } })).toMatchObject({ state: 'SENT' });
    const audit = await h.db.auditEvent.findMany({ where: { targetId: quote.id, action: 'quote.sent_superseded_version' } });
    expect(audit).toHaveLength(1);
    expect(await h.db.auditEvent.count({ where: { targetId: quote.id, action: 'quote.send' } })).toBe(0);
    expect(h.email.calls).toHaveLength(1);
  }, 60_000);
});
