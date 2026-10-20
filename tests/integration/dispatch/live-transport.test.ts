// T32 dispatch in LIVE through the adapter registry (plan §4.2, §4.4, ADR-60, R1): the handler
// gets its transport per workspace from the registry, with the credentials decrypted outside any
// transaction.
// - CONNECTED integration with a readable token: the Cloud API request goes out (scripted Graph),
//   with the per-send quick-reply payload ids of the template mapping and the attempt id echoed;
//   the attempt is SENT with the provider's message id.
// - No Graph version, an unverified integration, an unreadable credential, or LIVE email (no live
//   email transport until T33): the existing NOT_CONFIGURED skip, zero provider requests, and the
//   demo outbox is never written: LIVE never falls back to a demo transport.
// - A provider error goes through the dated error map; a timeout after the write is AMBIGUOUS
//   (job DEAD, message "Delivery unknown"), never retried.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '@/server/db/tx';
import { queueOutboundMessage } from '@/server/services/messaging/dispatch';
import { contactKey } from '@/server/security/contact-key';
import { fixtureAnswer, networkError } from '../contract/whatsapp-support';
import { createLiveHarness, liveLead, PEPPER, PHONE_ID, queueWhatsApp, SIMPLE_TEMPLATE, storeTemplate, storeWhatsApp, type LiveHarness } from '../integrations/live-support';

let h: LiveHarness;
let templateId: string;

beforeAll(async () => {
  h = await createLiveHarness('t32-live-dispatch');
  await storeWhatsApp(h);
  templateId = (await storeTemplate(h, { name: 'welcome_first_touch', components: SIMPLE_TEMPLATE, buttons: { '0': 'QUOTE', '1': 'STOP' }, intent: 'FIRST_TOUCH' })).id;
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(async () => {
  h.graph.reset();
  h.flags.graphVersion = 'v24.0';
  await storeWhatsApp(h, { status: 'CONNECTED' });
});

const attemptOf = (messageId: string) => h.db.dispatchAttempt.findFirstOrThrow({ where: { messageId }, orderBy: { attemptNo: 'desc' } });

describe('LIVE WhatsApp through the registry', () => {
  it('a CONNECTED integration sends through the Cloud API with per-send payload ids and the attempt id echoed', async () => {
    h.graph.on('POST', new RegExp(`/v24\\.0/${PHONE_ID}/messages$`), fixtureAnswer('response.send-accepted.json'));
    const lead = await liveLead(h);
    const q = await queueWhatsApp(h, await h.owner(), { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId, variables: { '1': 'Asha', '2': 'teeth whitening' } });
    await h.drain();

    const attempt = await attemptOf(q.messageId);
    expect(attempt).toMatchObject({ state: 'SENT', providerMessageId: expect.stringMatching(/^wamid\./) });
    expect(h.graph.requests).toHaveLength(1);
    const body = h.graph.requests[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: lead.phoneE164!.slice(1), type: 'template', biz_opaque_callback_data: attempt.id });
    expect((body.template as { components: unknown[] }).components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'teeth whitening' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'AL_QR_QUOTE_V1' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'AL_QR_STOP_V1' }] },
    ]);
    const message = await h.db.message.findUniqueOrThrow({ where: { id: q.messageId } });
    expect(message).toMatchObject({ status: 'SENT', simulated: false });
    expect(h.demoOutboxExists()).toBe(false);
  });

  it('without META_GRAPH_VERSION the send is skipped NOT_CONFIGURED: no request, no demo transport', async () => {
    h.flags.graphVersion = null;
    const lead = await liveLead(h);
    const q = await queueWhatsApp(h, await h.owner(), { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId, variables: { '1': 'A', '2': 'B' } });
    await h.drain();
    expect(await attemptOf(q.messageId)).toMatchObject({ state: 'SKIPPED', reasonCode: 'NOT_CONFIGURED' });
    expect(h.graph.requests).toHaveLength(0);
    expect(h.demoOutboxExists()).toBe(false);
  });

  it('an integration that is not CONNECTED (configured, not verified) is skipped NOT_CONFIGURED', async () => {
    await storeWhatsApp(h, { status: 'CONFIGURED_UNVERIFIED' });
    const lead = await liveLead(h);
    const q = await queueWhatsApp(h, await h.owner(), { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId, variables: { '1': 'A', '2': 'B' } });
    await h.drain();
    expect(await attemptOf(q.messageId)).toMatchObject({ state: 'SKIPPED', reasonCode: 'NOT_CONFIGURED' });
    expect(h.graph.requests).toHaveLength(0);
    expect(h.demoOutboxExists()).toBe(false);
  });

  it('a provider rejection is classified by the error map (131049: PERMANENT, back to review)', async () => {
    h.graph.on('POST', /\/messages$/, fixtureAnswer('error.131049.json'));
    const lead = await liveLead(h);
    const q = await queueWhatsApp(h, await h.owner(), { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId, variables: { '1': 'A', '2': 'B' } });
    await h.drain();
    expect(await attemptOf(q.messageId)).toMatchObject({ state: 'FAILED', failureClass: 'PERMANENT', reasonCode: 'RECIPIENT_FREQUENCY_CAP' });
    expect(h.graph.requests).toHaveLength(1);
  });

  it('a timeout after the request was written is AMBIGUOUS: job DEAD, delivery unknown, no second request', async () => {
    h.graph.on('POST', /\/messages$/, { throw: networkError('UND_ERR_HEADERS_TIMEOUT') });
    const lead = await liveLead(h);
    const q = await queueWhatsApp(h, await h.owner(), { leadId: lead.id, sendIntent: 'MANUAL_SINGLE', templateId, variables: { '1': 'A', '2': 'B' } });
    await h.drain();
    h.clock.advance(10 * 60_000);
    await h.drain();
    expect(await attemptOf(q.messageId)).toMatchObject({ state: 'AMBIGUOUS' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: q.jobId } })).toMatchObject({ status: 'DEAD', deadReason: 'AMBIGUOUS' });
    expect((await h.db.message.findUniqueOrThrow({ where: { id: q.messageId } })).status).toBe('UNKNOWN');
    expect(h.graph.requests).toHaveLength(1);
  });
});

describe('LIVE email (shaped identically; T33 adds the transport)', () => {
  it('is skipped NOT_CONFIGURED in LIVE, with no demo transport, even with a CONNECTED email integration', async () => {
    const lead = await liveLead(h);
    await h.db.lead.update({ where: { id: lead.id }, data: { emailNormalized: `live${lead.id.slice(-6)}@example.test` } });
    const email = `live${lead.id.slice(-6)}@example.test`;
    await h.db.consentRecord.create({
      data: { workspaceId: h.workspaceId, leadId: lead.id, contactKey: contactKey(PEPPER, 'email', email), channel: 'EMAIL', purpose: 'MARKETING', basis: 'OPT_IN', source: 'MANUAL_EVIDENCE', evidence: {}, collectedAt: new Date('2026-10-01T00:00:00.000Z'), recordedAt: new Date('2026-10-01T00:00:00.000Z') },
    });
    await h.db.integration.create({ data: { workspaceId: h.workspaceId, kind: 'EMAIL_RESEND', status: 'CONNECTED', config: { fromDomain: 'example.test' } } });
    const ctx = await h.owner();
    const q = await withTx(ctx.db, (tx) =>
      queueOutboundMessage(tx, ctx, { kind: 'EMAIL', subject: 'Hello', body: 'Body', leadId: lead.id, channel: 'EMAIL', sendIntent: 'MANUAL_SINGLE', initiatedBy: ctx.actor!.userId, dedupeKey: 't32-live-email' }, { contactKeyPepper: PEPPER }),
    );
    await h.drain();
    expect(await attemptOf(q.messageId)).toMatchObject({ state: 'SKIPPED', reasonCode: 'NOT_CONFIGURED' });
    expect(h.demoOutboxExists()).toBe(false);
    expect(h.graph.requests).toHaveLength(0);
  });
});
