/**
 * R1 for the chat slice (DEMO zero outbound, plan §4.2 and §5): a customer's WhatsApp question in
 * DEMO goes through the real signed webhook, `webhook.process`, `reply.auto` (kind ai, the DEMO
 * generator is the labelled local one), the dispatch outbox with the production DEMO transport, and
 * the simulated delivered and read ticks (`wa.demoStatus`) without one outbound attempt, socket,
 * TLS handshake, DNS lookup or `fetch`. The reply reaches the demo outbox as a simulated send and the
 * thread ends Read, labelled Simulated; the scripted provider stand-in of the other chat tests is
 * never touched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { demoOutboxDir, readDemoOutbox } from '@/server/adapters/whatsapp/demo';
import { createDispatchWhatsAppJob } from '@/server/jobs/handlers/dispatch-whatsapp';
import { createReplyAutoJob } from '@/server/jobs/handlers/reply-auto';
import { createStatusApplyJob } from '@/server/jobs/handlers/status-apply';
import { createWaDemoStatusJob, DEMO_DELIVERED_AFTER_MS, DEMO_READ_AFTER_MS } from '@/server/jobs/handlers/wa-demo-status';
import { createWebhookProcessJob } from '@/server/jobs/handlers/webhook-process';
import { buildJobRegistry } from '@/server/jobs/registry';
import { automatedReplyDisclosure } from '@/server/services/ai/reply-guard';
import { setConversationAiMode, setWorkspaceAutoSend } from '@/server/services/messaging/conversations';
import { getInboxThread } from '@/server/services/messaging/inbox';
import { createWorker } from '../../../worker/worker';
import { createLead } from '../dispatch/support';
import { customerSays, inboundMessage, repliesTo } from '../messaging/conversation-support';
import { createInboundHarness, inbound, PEPPER, WS_A, type InboundHarness } from '../messaging/inbound-support';
import { armOutboundTripwire, tripwireArmed } from '../../support/tripwire';

const counters = { connect: 0, tls: 0, lookup: 0, fetch: 0 };
let h: InboundHarness;
let drain: () => Promise<number>;

beforeAll(async () => {
  h = await createInboundHarness('chat-tripwire');
  resetOutboundAttempts();

  // The production handlers and the production DEMO transport (no `whatsapp` double, no AI double):
  // the harness's own worker, with its scripted transport, is never drained by this file.
  const worker = createWorker(
    {
      db: h.db,
      clock: h.clock,
      registry: buildJobRegistry([
        createWebhookProcessJob({ deps: () => h.inboundDeps }),
        createStatusApplyJob({ deps: () => h.inboundDeps }),
        createReplyAutoJob({ mode: () => 'demo', deps: () => ({ contactKeyPepper: PEPPER, ai: { keyRing: null } }) }),
        createDispatchWhatsAppJob({ mode: () => 'demo', deps: h.runtimeDeps }),
        createWaDemoStatusJob({ mode: () => 'demo', deps: () => ({ ...h.inboundDeps, journalDir: h.config.paths.journalDir }) }),
      ]),
      logger: createLogger({ level: 'silent' }),
      mode: 'demo',
      version: 'test',
      random: () => 0,
    },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
}, 120_000);

// Armed before every test: restoreMocks (vitest config) restores spies before each test, so a spy set in beforeAll would be gone.
beforeEach(() => armOutboundTripwire(counters));

afterAll(async () => {
  vi.restoreAllMocks();
  await h?.destroy();
});

describe('DEMO chat outbound tripwire', () => {
  it('a customer question, the AI reply and its delivered and read ticks open no socket and make no outbound attempt', async () => {
    expect(tripwireArmed(), 'the wire tripwire is armed for this test').toBe(true);
    const owner = await h.owner();
    await setWorkspaceAutoSend(owner, { enabled: true });
    const lead = await createLead(h.db);
    const first = await inbound(lead, { text: 'Hello' }, h.clock.now());
    expect(first.res.status).toBe(200);
    await drain();
    const conversation = await h.db.conversation.findFirstOrThrow({ where: { workspaceId: WS_A, leadId: lead.id, channel: 'WHATSAPP' } });
    await setConversationAiMode(owner, { conversationId: conversation.id, aiMode: 'AUTO' });

    const wamid = await customerSays(h, lead, 'Do you do root canal treatment?');
    await drain();
    const [reply] = await repliesTo(h, (await inboundMessage(h, wamid)).id);
    expect(reply).toMatchObject({ status: 'SENT', simulated: true, generatorLabel: 'local-deterministic', sendIntent: 'AUTOMATED' });
    expect(reply!.body!.startsWith(automatedReplyDisclosure('Smile Avenue Dental Clinic'))).toBe(true);
    expect(reply!.body).toContain('Root canal treatment');

    h.clock.advance(DEMO_DELIVERED_AFTER_MS);
    await drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: reply!.id } })).toMatchObject({ status: 'DELIVERED' });
    h.clock.advance(DEMO_READ_AFTER_MS);
    await drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: reply!.id } })).toMatchObject({ status: 'READ', simulated: true });

    // The would-be send is in the demo outbox (recipient tail only); nothing else went anywhere.
    const outbox = readDemoOutbox(demoOutboxDir(h.storageDir), 'WHATSAPP');
    expect(outbox.map((e) => e.providerMessageId)).toContain(reply!.providerMessageId);
    expect(h.wa.calls).toEqual([]);
    expect(outboundAttempts()).toHaveLength(0);
    expect(counters).toEqual({ connect: 0, tls: 0, lookup: 0, fetch: 0 });

    const thread = await getInboxThread(owner, conversation.id, { contactKeyPepper: PEPPER, externalOutboundPause: false });
    expect(thread.messages.find((m) => m.id === reply!.id)).toMatchObject({ status: 'READ', statusLabel: 'Read', simulated: true, generatorLabel: 'local-deterministic' });
  }, 120_000);
});
