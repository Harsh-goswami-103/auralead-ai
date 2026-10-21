/**
 * R27 (T20 part), M2 / ADR-14, C9: email events and unsubscribe.
 *  - POST /api/webhooks/email/demo (DEMO provider, Resend event shape, signed): a permanent bounce
 *    suppresses EMAIL only (WhatsApp stays sendable) and fails the message; a temporary bounce
 *    suppresses nothing; a complaint suppresses; a bad signature is 401; `resend` waits for T33's
 *    verified receiver (404) and SMTP discloses that it has no inbound and no bounce tracking;
 *  - /api/unsubscribe: the RFC 8058 one-click POST suppresses synchronously (queued sends
 *    cancelled, journal line written) without a worker; GET never unsubscribes (link scanners)
 *    and leads to the confirmation page; the page form posts back and sees the result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveAndSendMessage, createMessageDraft, deriveUnsubscribeKey, signUnsubscribeToken } from '@/server/services/messaging/dispatch';
import { EMAIL_PROVIDER_CAPABILITIES } from '@/server/services/messaging/inbound';
import UnsubscribePage from '@/app/(public)/unsubscribe/[token]/page';
import { approvedTemplate, createLead, DEPS, eligibleLead, grantConsent } from '../dispatch/support';
import {
  activeSuppression,
  createInboundHarness,
  emailKey,
  formUnsubscribe,
  getUnsubscribe,
  oneClickUnsubscribe,
  phoneKey,
  postEmailEvent,
  routeJournal,
  SESSION_SECRET,
  WS_A,
  type InboundHarness,
} from './inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('email-webhooks');
}, 120_000);
afterAll(async () => h?.destroy());

async function emailTo(leadId: string) {
  const owner = await h.owner();
  const draft = await createMessageDraft(owner, { leadId, channel: 'EMAIL', kind: 'EMAIL', subject: 'Your visit', body: 'See you soon.' }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

const bounced = (emailId: string, to: string, type: 'Permanent' | 'Temporary') => ({
  type: 'email.bounced',
  created_at: h.clock.now().toISOString(),
  data: { email_id: emailId, to: [to], subject: 'Your visit', bounce: { type, subType: 'General', message: 'Mailbox unavailable' } },
});

let eventSeq = 0;
const eventId = () => `evt_test_${++eventSeq}`;

describe('email provider events', () => {
  it('a permanent bounce suppresses email only and fails the message', async () => {
    const lead = await eligibleLead(h.db);
    const sent = await emailTo(lead.id);
    await h.drain();
    const message = await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } });
    expect(message.status).toBe('SENT');

    const res = await postEmailEvent('demo', bounced(message.providerMessageId!, lead.emailNormalized!, 'Permanent'), { eventId: eventId() });
    expect(res.status).toBe(200);
    // Suppressed by the route itself (no worker needed).
    expect(await activeSuppression(h, 'EMAIL', emailKey(lead.emailNormalized!))).toMatchObject({ reason: 'HARD_BOUNCE' });
    expect(await activeSuppression(h, 'WHATSAPP', phoneKey(lead.phoneE164!))).toBeNull();

    await h.drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'FAILED' });

    // WhatsApp to the same lead still sends.
    const owner = await h.owner();
    const template = await approvedTemplate(h.db);
    const wa = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
    const waSent = await approveAndSendMessage(owner, { messageId: wa.messageId }, DEPS);
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: waSent.attemptId } })).toMatchObject({ state: 'SENT' });
    // And a new email is skipped SUPPRESSED.
    const again = await emailTo(lead.id);
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: again.attemptId } })).toMatchObject({ state: 'SKIPPED', reasonCode: 'SUPPRESSED' });
  }, 60_000);

  it('a temporary bounce suppresses nothing; a complaint suppresses', async () => {
    const lead = await eligibleLead(h.db);
    const sent = await emailTo(lead.id);
    await h.drain();
    const message = await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } });
    expect((await postEmailEvent('demo', bounced(message.providerMessageId!, lead.emailNormalized!, 'Temporary'), { eventId: eventId() })).status).toBe(200);
    expect(await activeSuppression(h, 'EMAIL', emailKey(lead.emailNormalized!))).toBeNull();

    const complaint = { type: 'email.complained', created_at: h.clock.now().toISOString(), data: { email_id: message.providerMessageId, to: [lead.emailNormalized] } };
    expect((await postEmailEvent('demo', complaint, { eventId: eventId() })).status).toBe(200);
    expect(await activeSuppression(h, 'EMAIL', emailKey(lead.emailNormalized!))).toMatchObject({ reason: 'COMPLAINT' });
  }, 60_000);

  it('a delivery event moves the message forward through status.apply; a replayed event id changes nothing', async () => {
    const lead = await eligibleLead(h.db);
    const sent = await emailTo(lead.id);
    await h.drain();
    const message = await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } });
    const delivered = { type: 'email.delivered', created_at: h.clock.now().toISOString(), data: { email_id: message.providerMessageId, to: [lead.emailNormalized] } };
    const id = eventId();
    expect((await postEmailEvent('demo', delivered, { eventId: id })).status).toBe(200);
    expect((await postEmailEvent('demo', delivered, { eventId: id })).status).toBe(200);
    await h.drain();
    expect(await h.db.message.findUniqueOrThrow({ where: { id: sent.messageId } })).toMatchObject({ status: 'DELIVERED', statusRank: 2 });
    expect(await h.db.webhookEvent.count({ where: { provider: 'DEMO', externalKey: `email:${id}` } })).toBe(1);
  }, 60_000);

  it('refuses a bad signature (401) and stores nothing', async () => {
    const res = await postEmailEvent('demo', bounced('x', 'someone@example.test', 'Permanent'), { eventId: 'evt_bad_sig', signature: 'sha256=00' });
    expect(res.status).toBe(401);
    expect(await h.db.webhookEvent.count({ where: { externalKey: 'email:evt_bad_sig' } })).toBe(0);
    expect((await postEmailEvent('demo', bounced('x', 'someone@example.test', 'Permanent'), { eventId: 'evt_no_sig', signature: null })).status).toBe(401);
  });

  it('resend is received only at the workspace URL (T33, [provider]/[routingKey]); SMTP discloses no inbound and no bounce tracking', async () => {
    expect((await postEmailEvent('resend', bounced('x', 'a@example.test', 'Permanent'), { eventId: 'evt_resend' })).status).toBe(404);
    const smtp = await postEmailEvent('smtp', bounced('x', 'a@example.test', 'Permanent'), { eventId: 'evt_smtp' });
    expect(smtp.status).toBe(404);
    expect(await smtp.json()).toMatchObject({ code: 'EMAIL_PROVIDER_NO_WEBHOOKS' });
    expect(EMAIL_PROVIDER_CAPABILITIES.EMAIL_SMTP).toMatchObject({ inbound: false, bounceTracking: false });
    expect(EMAIL_PROVIDER_CAPABILITIES.EMAIL_SMTP.disclosure).toMatch(/no inbound/i);
    expect(EMAIL_PROVIDER_CAPABILITIES.EMAIL_RESEND.inbound).toBe(false);
  });
});

describe('unsubscribe', () => {
  const key = deriveUnsubscribeKey(SESSION_SECRET);

  it('one-click POST suppresses synchronously, cancels queued email and journals, with no worker', async () => {
    const lead = await eligibleLead(h.db);
    const queued = await emailTo(lead.id);
    const token = signUnsubscribeToken(key, { workspaceId: WS_A, contactKey: emailKey(lead.emailNormalized!) });

    const res = await oneClickUnsubscribe(token);
    expect(res.status).toBe(200);
    const suppression = await activeSuppression(h, 'EMAIL', emailKey(lead.emailNormalized!));
    expect(suppression).toMatchObject({ reason: 'UNSUBSCRIBE', contactPlain: lead.emailNormalized });
    expect(suppression!.journaledAt).not.toBeNull();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: queued.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPPRESSED' });
    expect((await routeJournal(h)).filter((l) => l.suppressionId === suppression!.id)).toHaveLength(1);

    // Repeating it is harmless: still one active row.
    expect((await oneClickUnsubscribe(token)).status).toBe(200);
    expect(await h.db.suppression.count({ where: { workspaceId: WS_A, channel: 'EMAIL', contactKey: emailKey(lead.emailNormalized!) } })).toBe(1);
  });

  it('works for a contact with no conversation (keyed by the HMAC, no plain address stored)', async () => {
    const token = signUnsubscribeToken(key, { workspaceId: WS_A, contactKey: emailKey('nobody-we-know@example.test') });
    expect((await oneClickUnsubscribe(token)).status).toBe(200);
    expect(await activeSuppression(h, 'EMAIL', emailKey('nobody-we-know@example.test'))).toMatchObject({ reason: 'UNSUBSCRIBE', contactPlain: null });
  });

  it('refuses a forged or tampered token (404) and writes nothing', async () => {
    const before = await h.db.suppression.count();
    const forged = signUnsubscribeToken(deriveUnsubscribeKey(`another-secret-${'x'.repeat(32)}`), { workspaceId: WS_A, contactKey: emailKey('victim@example.test') });
    expect((await oneClickUnsubscribe(forged)).status).toBe(404);
    expect((await oneClickUnsubscribe('not-a-token')).status).toBe(404);
    expect(await h.db.suppression.count()).toBe(before);
  });

  it('GET never unsubscribes; it redirects to the confirmation page, whose form posts back', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'EMAIL');
    const token = signUnsubscribeToken(key, { workspaceId: WS_A, contactKey: emailKey(lead.emailNormalized!) });
    const res = await getUnsubscribe(token);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/unsubscribe/${token}`);
    expect(await activeSuppression(h, 'EMAIL', emailKey(lead.emailNormalized!))).toBeNull();

    const page = await UnsubscribePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) });
    expect(JSON.stringify(page)).toContain('Smile Avenue');

    const posted = await formUnsubscribe(token);
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe(`/unsubscribe/${token}?done=1`);
    expect(await activeSuppression(h, 'EMAIL', emailKey(lead.emailNormalized!))).toMatchObject({ reason: 'UNSUBSCRIBE' });
    const done = await UnsubscribePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({ done: '1' }) });
    expect(JSON.stringify(done)).toMatch(/unsubscribed/i);
  });
});
