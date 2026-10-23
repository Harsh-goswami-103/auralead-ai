// Lead-gen F5 in DEMO makes zero outbound calls (plan §5, R1, ADR-18): handing a lead over, the
// `handoff.summary` job, the reach-out panel and the click-to-chat link open no socket, resolve no
// host name, call no fetch and log no outbound attempt. The summary is the labelled local
// generator even when the workspace holds an AI integration and the job's dependencies carry a key
// ring and a transport: DEMO never reads them, so nothing could reach a provider.
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import type { AppCtx } from '@/server/auth/context';
import type { AiDeps } from '@/server/services/ai/run-task';
import { handOverLead, loadLeadHandoff } from '@/server/services/leads/handoff';
import { buildClickToChat, loadReachOut } from '@/server/services/leads/reach-out';
import { KEY_RING } from '../ai/support';
import { leadWithConversation } from '../messaging/conversation-support';
import { createInboundHarness, WS_A, type InboundHarness } from '../messaging/inbound-support';
import { drain, handoffWorker, operatorWithHandoff, requestKey } from './support';

let h: InboundHarness;
let employee: AppCtx;
const counters = { connect: 0, tls: 0, lookup: 0, fetch: 0, transport: 0 };
const TRIPWIRE_AI: AiDeps = {
  keyRing: KEY_RING,
  transport: {
    fetch: async () => {
      counters.transport += 1;
      throw new Error('tripwire: AI transport called');
    },
    timeoutMs: 1_000,
  },
};

beforeAll(async () => {
  h = await createInboundHarness('handoff-demo-tripwire');
  employee = await operatorWithHandoff(h);
  // An AI integration with a stored key and a WhatsApp display number: DEMO must ignore the first.
  await h.db.integration.create({ data: { workspaceId: WS_A, kind: 'AI_ANTHROPIC', status: 'CONNECTED', config: { modelId: 'claude-sonnet-5-5' }, secrets: { apiKey: 'v1.k1.not-a-real-envelope' } } });
  await h.db.integration.update({ where: { id: h.integrationId }, data: { config: { phoneNumberId: '109876543210987', displayPhoneNumber: '+919812300000' } } });
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
    counters.connect += 1;
    throw new Error('tripwire: socket connect attempted');
  });
  vi.spyOn(tls, 'connect').mockImplementation(() => {
    counters.tls += 1;
    throw new Error('tripwire: tls connect attempted');
  });
  vi.spyOn(dns, 'lookup').mockImplementation((() => {
    counters.lookup += 1;
    throw new Error('tripwire: dns lookup attempted');
  }) as never);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    counters.fetch += 1;
    throw new Error('tripwire: fetch attempted');
  });
  resetOutboundAttempts();
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await h?.destroy();
});

describe('DEMO handoff and reach-out', () => {
  it('hand over, the summary job, the reach-out panel and click-to-chat make no outbound call', async () => {
    const { lead } = await leadWithConversation(h, 'How much is a website and how long does it take?');
    const { stageVersion } = await h.db.lead.findUniqueOrThrow({ where: { id: lead.id } });

    expect((await loadLeadHandoff(employee, lead.id, TRIPWIRE_AI)).summaryAvailable).toBe(true);
    const result = await handOverLead(employee, { leadId: lead.id, note: 'Call after 5 pm.', expectedStageVersion: stageVersion, requestKey: requestKey('tripwire') }, TRIPWIRE_AI);
    expect(result).toMatchObject({ created: true, summaryStatus: 'PENDING' });
    await drain(handoffWorker(h, { deps: () => TRIPWIRE_AI }));
    expect(await h.db.leadHandoff.findUniqueOrThrow({ where: { id: result.handoffId } })).toMatchObject({ summaryStatus: 'READY', summaryGeneratorLabel: 'local-deterministic' });

    const reachOut = await loadReachOut(employee);
    expect(reachOut.clickToChat).toMatchObject({ available: true, displayPhoneNumber: '+919812300000' });
    expect((await buildClickToChat(employee, { prefill: 'Hi, I saw your card' })).link).toBe('https://wa.me/919812300000?text=Hi%2C%20I%20saw%20your%20card');

    expect(counters).toEqual({ connect: 0, tls: 0, lookup: 0, fetch: 0, transport: 0 });
    expect(outboundAttempts()).toEqual([]);
  });
});
