/**
 * ADR-121 P1: DEMO simulated delivered and read statuses (`wa.demoStatus`).
 * - A DEMO WhatsApp send settles as today; the settle hook queues "delivered" 2 s later, which goes
 *   through the production status path (a simulated WebhookEvent per status, then `status.apply`
 *   and the rank merge), then "read" 4 s after that. The thread shows Delivered, then Read.
 * - No provider call: the provider stand-in sees only the original send (zero outbound).
 * - A replay adds nothing (the receive path answers DUPLICATE); a failed message gets no status;
 *   the hook queues nothing for LIVE or email; the job refuses to run in a LIVE process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '@/server/db/tx';
import { createWaDemoStatusJob, DEMO_DELIVERED_AFTER_MS, DEMO_READ_AFTER_MS, DEMO_STATUS_JOB, queueDemoStatus } from '@/server/jobs/handlers/wa-demo-status';
import type { TxClient } from '@/server/jobs/types';
import { getInboxThread, sendComposerMessage } from '@/server/services/messaging/inbox';
import { permanent } from '../dispatch/support';
import { leadWithConversation } from './conversation-support';
import { advanceAndDrain, createInboundHarness, PEPPER, WS_A, type InboundHarness } from './inbound-support';

const DEPS = { contactKeyPepper: PEPPER, externalOutboundPause: false };
let h: InboundHarness;

beforeAll(async () => {
  h = await createInboundHarness('demo-status', {
    extraDefs: (inbound) => [createWaDemoStatusJob({ mode: () => 'demo', deps: () => ({ ...inbound, journalDir: h.config.paths.journalDir }) })],
  });
}, 120_000);
afterAll(async () => h?.destroy());

async function composerSend(conversationId: string, key: string) {
  const owner = await h.owner();
  return sendComposerMessage(owner, { conversationId, requestKey: key, kind: 'TEXT', body: 'Here are our website packages.' }, DEPS);
}

describe('wa.demoStatus', () => {
  it('a DEMO send gets simulated delivered, then read, through the production status path; no provider call', async () => {
    const { conversation } = await leadWithConversation(h, 'Do you build websites?');
    const sent = await composerSend(conversation.id, 'demo-status-0001');
    const calls0 = h.wa.calls.length;
    await h.drain();
    expect(h.wa.calls.length).toBe(calls0 + 1);
    const message = await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } });
    expect(message).toMatchObject({ status: 'SENT', simulated: true });

    const delivered = await h.db.job.findFirstOrThrow({ where: { type: DEMO_STATUS_JOB, idempotencyKey: `${DEMO_STATUS_JOB}:${sent.messageId}:delivered` } });
    expect(delivered).toMatchObject({ status: 'QUEUED', workspaceId: WS_A });
    expect(delivered.runAt.getTime() - h.clock.now().getTime()).toBe(DEMO_DELIVERED_AFTER_MS);

    await advanceAndDrain(h, DEMO_DELIVERED_AFTER_MS, 1);
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'DELIVERED' });
    const events = await h.db.webhookEvent.findMany({ where: { workspaceId: WS_A, externalKey: { startsWith: `wa:${message.providerMessageId}:` } }, orderBy: { receivedAt: 'asc' } });
    expect(events.map((e) => [e.externalKey, e.simulated, e.status])).toEqual([[`wa:${message.providerMessageId}:delivered`, true, 'PROCESSED']]);

    await advanceAndDrain(h, DEMO_READ_AFTER_MS, 1);
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'READ' });
    const statusEvents = await h.db.messageStatusEvent.findMany({ where: { messageId: sent.messageId }, orderBy: { rank: 'asc' } });
    expect(statusEvents.map((e) => e.status)).toEqual(['delivered', 'read']);
    expect(h.wa.calls.length).toBe(calls0 + 1);

    const thread = await getInboxThread(await h.owner(), conversation.id, DEPS);
    expect(thread.messages.find((m) => m.id === sent.messageId)).toMatchObject({ status: 'READ', statusLabel: 'Read', simulated: true });
  }, 60_000);

  it('a replayed job adds nothing (the receive path answers DUPLICATE)', async () => {
    const { conversation } = await leadWithConversation(h, 'Hello again');
    const sent = await composerSend(conversation.id, 'demo-status-0002');
    await h.drain();
    await advanceAndDrain(h, DEMO_DELIVERED_AFTER_MS, 1);
    const job = await h.db.job.findFirstOrThrow({ where: { type: DEMO_STATUS_JOB, idempotencyKey: `${DEMO_STATUS_JOB}:${sent.messageId}:delivered` } });
    expect(job.status).toBe('SUCCEEDED');
    const before = await h.db.webhookEvent.count({ where: { workspaceId: WS_A } });
    await h.db.message.update({ where: { id: sent.messageId }, data: { status: 'SENT', statusRank: 1 } });
    await h.db.job.update({ where: { id: job.id }, data: { status: 'QUEUED', runAt: h.clock.now(), claimToken: null, leaseUntil: null } });
    await h.drain();
    expect(await h.db.webhookEvent.count({ where: { workspaceId: WS_A } })).toBe(before);
  }, 60_000);

  it('a failed send gets no simulated status', async () => {
    const { conversation } = await leadWithConversation(h, 'One more question');
    h.wa.answer(permanent());
    const sent = await composerSend(conversation.id, 'demo-status-0003');
    await h.drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'FAILED' });
    expect(await h.db.job.count({ where: { type: DEMO_STATUS_JOB, idempotencyKey: { startsWith: `${DEMO_STATUS_JOB}:${sent.messageId}:` } } })).toBe(0);
  }, 60_000);

  it('the hook queues nothing in LIVE or for email, and the job refuses a LIVE process', async () => {
    const plan = { workspaceId: WS_A, messageId: 'msg-hook-probe', channel: 'WHATSAPP' };
    await withTx(h.db, async (tx) => {
      await queueDemoStatus(tx as TxClient, { mode: 'live', clock: h.clock, correlationId: 'c1' }, plan, { providerMessageId: 'wamid.live', simulated: false });
      await queueDemoStatus(tx as TxClient, { mode: 'demo', clock: h.clock, correlationId: 'c2' }, { ...plan, channel: 'EMAIL' }, { providerMessageId: 'email-1', simulated: true });
    });
    expect(await h.db.job.count({ where: { type: DEMO_STATUS_JOB, idempotencyKey: { contains: 'msg-hook-probe' } } })).toBe(0);

    const live = createWaDemoStatusJob({ mode: () => 'live', deps: () => ({ ...h.inboundDeps, journalDir: h.config.paths.journalDir }) });
    const result = await live.handler({
      job: { id: 'job-live', type: DEMO_STATUS_JOB, workspaceId: WS_A, payload: { messageId: 'm', providerMessageId: 'p', status: 'delivered' } },
    } as never);
    expect(result).toMatchObject({ outcome: 'dead', reason: 'DEMO_ONLY' });
  }, 60_000);
});
