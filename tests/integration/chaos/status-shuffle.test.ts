/**
 * R28, AT12 (statuses half), C10: delivery status webhooks arrive shuffled and duplicated (3x),
 * through the real route and the `status.apply` job.
 *  - the message ends at the rank-max state, one MessageStatusEvent per (providerMessageId,
 *    status), and one recorded change per applied rank (strictly increasing);
 *  - a status for an unknown provider id is stored (PENDING_CORRELATION), retried 5 times over
 *    about 10 minutes, then ORPHAN, its raw event kept;
 *  - a status echoing an AMBIGUOUS attempt's id as biz_opaque_callback_data resolves it to SENT.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryEvent } from '@/server/services/messaging/status-merge';
import { createLead } from '../dispatch/support';
import { phoneKey } from '../messaging/inbound-support';
import { advanceAndDrain, createInboundHarness, postWhatsApp, waEnvelope, waFrom, waStatusValue, WS_A, type InboundHarness } from '../messaging/inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('status-shuffle');
}, 120_000);
afterAll(async () => h?.destroy());

let seq = 0;
async function outboundMessage(status: 'PENDING' | 'UNKNOWN' = 'PENDING') {
  seq += 1;
  const lead = await createLead(h.db);
  const conversation = await h.db.conversation.create({ data: { workspaceId: WS_A, leadId: lead.id, channel: 'WHATSAPP', contactKey: phoneKey(lead.phoneE164!) } });
  const message = await h.db.message.create({
    data: {
      workspaceId: WS_A,
      conversationId: conversation.id,
      direction: 'OUT',
      channel: 'WHATSAPP',
      kind: 'TEMPLATE',
      status,
      statusRank: 0,
      providerMessageId: status === 'PENDING' ? `wamid.shuffle.${seq}.${process.pid}` : null,
      sendIntent: 'MANUAL_SINGLE',
      initiatedBy: 'test',
    },
  });
  return { lead, message };
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

describe('status webhooks shuffled with duplicates', () => {
  it('end at rank max with one change per rank (fast-check, fixed seed)', async () => {
    const scenarios = fc.sample(
      fc
        .uniqueArray(fc.constantFrom<DeliveryEvent>('sent', 'delivered', 'read', 'failed'), { minLength: 1, maxLength: 4 })
        .chain((set) => fc.shuffledSubarray(set.flatMap((e) => [e, e, e]), { minLength: set.length * 3 })),
      { seed: 42, numRuns: 12 },
    );
    for (const events of scenarios) {
      const { lead, message } = await outboundMessage();
      for (const [i, status] of events.entries()) {
        const res = await postWhatsApp(waEnvelope(waStatusValue({ id: message.providerMessageId!, status, at: new Date(h.clock.now().getTime() + i * 1000), recipient: waFrom(lead.phoneE164!) })));
        expect(res.status).toBe(200);
      }
      await h.drain();

      const top = Math.max(0, ...events.filter((e) => e !== 'failed').map((e) => RANK[e]!));
      const expected = top >= 2 ? (top === 2 ? 'DELIVERED' : 'READ') : events.includes('failed') ? 'FAILED' : 'SENT';
      const after = await h.db.message.findUniqueOrThrow({ where: { id: message.id } });
      expect({ events, status: after.status }).toEqual({ events, status: expected });

      const stored = await h.db.messageStatusEvent.findMany({ where: { providerMessageId: message.providerMessageId! } });
      expect(stored.map((s) => s.status).sort()).toEqual([...new Set(events)].sort());
      expect(stored.every((s) => s.messageId === message.id)).toBe(true);

      // One recorded change per rank: no rank is applied twice, and the highest applied is the final rank.
      const changes = await h.db.auditEvent.findMany({ where: { action: 'message.status', targetId: message.id } });
      const positive = changes.map((c) => (c.summary as { rank: number }).rank).filter((r) => r > 0);
      expect(new Set(positive).size).toBe(positive.length);
      if (top >= 2) expect(Math.max(...positive)).toBe(top);
      expect(changes.length).toBeLessThanOrEqual(new Set(events).size);
    }
  }, 240_000);

  it('stores an orphan status, retries correlation 5 times over ~10 minutes, then marks it ORPHAN', async () => {
    const res = await postWhatsApp(waEnvelope(waStatusValue({ id: 'wamid.never.sent.by.us', status: 'delivered', at: h.clock.now(), recipient: '919800099999' })));
    expect(res.status).toBe(200);
    await h.drain();
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: 'wa:wamid.never.sent.by.us:delivered' } });
    expect(event.status).toBe('PENDING_CORRELATION');
    expect(await h.db.messageStatusEvent.findFirst({ where: { providerMessageId: 'wamid.never.sent.by.us' } })).toMatchObject({ messageId: null, status: 'delivered' });

    await advanceAndDrain(h, 2 * 60_000 + 1_000, 6);
    expect((await h.db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('ORPHAN');
    const job = await h.db.job.findFirstOrThrow({ where: { type: 'status.apply', workspaceId: WS_A, idempotencyKey: { contains: event.id } } });
    expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 6 });
  }, 60_000);

  it('a late status for a message whose provider id arrives later correlates on retry', async () => {
    const { lead, message } = await outboundMessage();
    const lateId = `${message.providerMessageId!}.late`;
    await postWhatsApp(waEnvelope(waStatusValue({ id: lateId, status: 'read', at: h.clock.now(), recipient: waFrom(lead.phoneE164!) })));
    await h.drain();
    // The settle that records the provider id lands after the webhook.
    await h.db.message.update({ where: { id: message.id }, data: { providerMessageId: lateId, status: 'SENT', statusRank: 1 } });
    await advanceAndDrain(h, 2 * 60_000 + 1_000, 1);
    expect(await h.db.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ status: 'READ', statusRank: 3 });
  }, 60_000);

  it('resolves an AMBIGUOUS attempt from an echoed biz_opaque_callback_data (positive evidence only)', async () => {
    const { lead, message } = await outboundMessage('UNKNOWN');
    const job = await h.db.job.create({
      data: { type: 'dispatch.whatsapp', payload: { messageId: message.id }, workspaceId: WS_A, status: 'DEAD', deadReason: 'AMBIGUOUS', idempotencyKey: `amb-${message.id}`, correlationId: 'test', runAt: h.clock.now(), maxAttempts: 5 },
    });
    const attempt = await h.db.dispatchAttempt.create({
      data: { workspaceId: WS_A, messageId: message.id, channel: 'WHATSAPP', attemptNo: 1, state: 'AMBIGUOUS', sendIntent: 'MANUAL_SINGLE', initiatedBy: 'test', idempotencyKey: `amb-attempt-${message.id}`, jobId: job.id },
    });
    await postWhatsApp(waEnvelope(waStatusValue({ id: `wamid.resolved.${message.id}`, status: 'delivered', at: h.clock.now(), recipient: waFrom(lead.phoneE164!), callbackData: attempt.id })));
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ state: 'SENT', providerMessageId: `wamid.resolved.${message.id}` });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ status: 'DELIVERED', providerMessageId: `wamid.resolved.${message.id}` });
    expect(await h.db.auditEvent.count({ where: { action: 'dispatch.ambiguous_resolved', targetId: attempt.id } })).toBe(1);
  }, 60_000);
});
