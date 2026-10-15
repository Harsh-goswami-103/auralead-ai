/**
 * R1 (DEMO zero outbound, plan §4.2): `adapters/http/outbound.ts` throws OutboundBlockedInDemo for
 * every host in DEMO before any socket opens; and a full simulated flow (Maps lead through the real
 * webhook path, pipeline, local AI draft, quote, worker-rendered PDF, B2B attestation, approve-and-
 * send by email and by WhatsApp, both dispatch handlers with the production DEMO transports) logs 0
 * outbound attempts, opens 0 sockets and resolves 0 host names. The email reaches the demo outbox as
 * a simulated send; the WhatsApp send to the Maps lead is skipped NO_WHATSAPP_OPT_IN (D4).
 */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OutboundBlockedInDemoError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { outboundAttempts, outboundRequest, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { demoOutboxDir, readDemoOutbox } from '@/server/adapters/whatsapp/demo';
import { createDispatchEmailJob } from '@/server/jobs/handlers/dispatch-email';
import { createDispatchWhatsAppJob } from '@/server/jobs/handlers/dispatch-whatsapp';
import { deriveUnsubscribeKey, approveAndSendQuote } from '@/server/services/messaging/dispatch';
import { attestB2bEmail } from '@/server/services/messaging/consent';
import { buildJobRegistry } from '@/server/jobs/registry';
import { createWorker } from '../../../worker/worker';
import { approvedTemplate } from '../dispatch/support';
import { userCtx } from '../quotes/support';
import { createQuoteFromProposal, createSliceHarness, sessionFor, simulateGmaps, WS_A, WS_A_SLUG, type Auth, type SliceHarness } from '../slice/support';

let h: SliceHarness;
let employee: Auth;
const counters = { connect: 0, tls: 0, lookup: 0, fetch: 0 };

beforeAll(async () => {
  h = await createSliceHarness('outbound-tripwire');
  employee = await sessionFor(h, 'employee');
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

describe('DEMO outbound tripwire', () => {
  it('blocks every host, including localhost, before any socket opens', async () => {
    for (const url of ['https://graph.facebook.com/v23.0/123/messages', 'https://api.resend.com/emails', 'http://127.0.0.1:3000/x', 'http://localhost/x']) {
      await expect(outboundRequest('demo', url, { method: 'POST', body: '{}' }, h.clock.now())).rejects.toBeInstanceOf(OutboundBlockedInDemoError);
    }
    expect(outboundAttempts().map((a) => [a.host, a.blocked])).toEqual([
      ['graph.facebook.com', true],
      ['api.resend.com', true],
      ['127.0.0.1:3000', true],
      ['localhost', true],
    ]);
    expect(counters).toEqual({ connect: 0, tls: 0, lookup: 0, fetch: 0 });
    resetOutboundAttempts();
  });

  it('a full simulated flow up to dispatch logs 0 outbound attempts and opens 0 sockets', async () => {
    const pepper = h.config.secrets.suppressionPepper!;
    const deps = () => ({
      contactKeyPepper: pepper,
      storageDir: h.storageDir,
      appOrigin: h.config.appOrigin,
      unsubscribeKey: deriveUnsubscribeKey(h.config.secrets.sessionSecret!),
      outboundLockFile: h.config.paths.outboundLockFile,
      envOutboundPaused: false,
    });
    // The production DEMO transports (default factories), not test doubles.
    const dispatchWorker = createWorker(
      {
        db: h.db,
        clock: h.clock,
        registry: buildJobRegistry([createDispatchEmailJob({ mode: () => 'demo', deps }), createDispatchWhatsAppJob({ mode: () => 'demo', deps })]),
        logger: createLogger({ level: 'silent' }),
        mode: 'demo',
        version: 'test',
        random: () => 0,
      },
      { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
    );

    expect((await simulateGmaps(employee, { workspaceSlug: WS_A_SLUG, count: 1 })).status).toBe(200);
    await h.drain();
    const lead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: WS_A, firstSource: 'GMAPS_EXTENSION' } });
    const draft = await h.db.aiDraft.findFirstOrThrow({ where: { leadId: lead.id } });
    const created = await createQuoteFromProposal(employee, lead.id, { workspaceSlug: WS_A_SLUG, draftId: draft.id });
    expect(created.status).toBe(200);
    const quoteId = (created.body!.quote as { id: string }).id;
    await h.drain(); // PDF

    // D4: Maps leads carry no email from the listing; the employee records the business address
    // and attests a B2B basis (workspace setting on). Manual single send only.
    await h.db.lead.update({ where: { id: lead.id }, data: { emailNormalized: 'frontdesk@clinic-example.in' } });
    await h.db.workspaceSettings.update({ where: { workspaceId: WS_A }, data: { emailB2bAttestationEnabled: true } });
    const ctx = await userCtx(h.db, h.clock, 'employee', WS_A_SLUG);
    await attestB2bEmail(ctx, { leadId: lead.id, note: 'Clinic front desk address from their website contact page.' }, { contactKeyPepper: pepper });

    const email = await approveAndSendQuote(ctx, { quoteId, expectedVersion: 1, channel: 'EMAIL' }, { contactKeyPepper: pepper });
    const template = await approvedTemplate(h.db);
    const wa = await approveAndSendQuote(ctx, { quoteId, expectedVersion: 1, channel: 'WHATSAPP', templateId: template.id }, { contactKeyPepper: pepper });
    while ((await dispatchWorker.tick()) === 'ran');

    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: email.attemptId } })).toMatchObject({ state: 'SENT', providerMessageId: `demo.email.${email.attemptId}` });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: email.messageId } })).toMatchObject({ status: 'SENT', simulated: true });
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: wa.attemptId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'NO_WHATSAPP_OPT_IN' });
    const outbox = readDemoOutbox(demoOutboxDir(h.storageDir), 'EMAIL');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ attemptId: email.attemptId, kind: 'email+unsubscribe', toTail: 'e.in' });
    expect(JSON.stringify(outbox)).not.toContain('frontdesk@');
    expect(readDemoOutbox(demoOutboxDir(h.storageDir), 'WHATSAPP')).toHaveLength(0);

    expect(outboundAttempts()).toHaveLength(0);
    expect(counters).toEqual({ connect: 0, tls: 0, lookup: 0, fetch: 0 });
    expect(h.outboundCalls).toEqual([]);
  }, 120_000);
});
