/**
 * R25 / AT10, C9 (ADR-06), E8: with no worker running (the 2am case), a Stop received by the
 * verified WhatsApp webhook route is fully applied by the route itself: the Suppression row, the
 * cancellation of the contact's QUEUED attempts, their jobs and messages, the audit row, and the
 * SuppressionJournal line appended after commit. When a worker starts later, nothing is sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { approvedTemplate, createLead, DEPS, grantConsent } from '../dispatch/support';
import { activeSuppression, createInboundHarness, inbound, phoneKey, routeJournal, WS_A, type InboundHarness } from './inbound-support';

let h: InboundHarness;
beforeAll(async () => {
  h = await createInboundHarness('stop-worker-down');
}, 120_000);
afterAll(async () => h?.destroy());

async function queuedTemplateSend(lead: { id: string }) {
  const owner = await h.owner();
  const template = await approvedTemplate(h.db);
  const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
  return approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
}

describe('Stop with the worker down', () => {
  it('the AL_QR_STOP_V1 quick reply suppresses, cancels and journals inside the route', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const queued = await queuedTemplateSend(lead);

    const { res, id } = await inbound(lead, { button: { payload: 'AL_QR_STOP_V1', text: 'Stop promotions' } }, h.clock.now());
    expect(res.status).toBe(200);

    // No worker has run: everything below was committed by the route.
    const suppression = await activeSuppression(h, 'WHATSAPP', phoneKey(lead.phoneE164!));
    expect(suppression).toMatchObject({ reason: 'STOP_BUTTON', contactPlain: lead.phoneE164 });
    expect(suppression!.journaledAt).not.toBeNull();
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: `wa:${id}` } });
    expect(suppression!.sourceEventId).toBe(event.id);

    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: queued.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPPRESSED' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: 'CANCELLED' });
    expect(await h.db.message.findUniqueOrThrow({ where: { id: queued.messageId } })).toMatchObject({ status: 'NOT_SENT' });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { workspaceId: WS_A, action: 'suppression.stop', targetId: suppression!.id } });
    expect(audit.actorKind).toBe('WEBHOOK');

    const lines = (await routeJournal(h)).filter((l) => l.suppressionId === suppression!.id);
    expect(lines).toEqual([expect.objectContaining({ action: 'STOP', channel: 'WHATSAPP', reason: 'STOP_BUTTON', sourceEventId: event.id, journalId: `${suppression!.id}:STOP` })]);

    // The worker starts later: zero provider calls for this contact.
    await h.drain();
    expect(h.wa.calls).toHaveLength(0);
  });

  it('a Hindi STOP keyword (बंद) as plain text does the same', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const queued = await queuedTemplateSend(lead);

    const { res } = await inbound(lead, { text: '  बंद ' }, h.clock.now());
    expect(res.status).toBe(200);
    expect(await activeSuppression(h, 'WHATSAPP', phoneKey(lead.phoneE164!))).toMatchObject({ reason: 'STOP_KEYWORD' });
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: queued.attemptId } })).toMatchObject({ state: 'CANCELLED', reasonCode: 'SUPPRESSED' });
    await h.drain();
    expect(h.wa.calls).toHaveLength(0);
  });

  it('ordinary text containing the word stop is not a Stop', async () => {
    const lead = await createLead(h.db);
    const { res } = await inbound(lead, { text: 'Which bus stop is near your clinic?' }, h.clock.now());
    expect(res.status).toBe(200);
    expect(await activeSuppression(h, 'WHATSAPP', phoneKey(lead.phoneE164!))).toBeNull();
  });

  it('a repeated Stop keeps one active row (no-op plus audit) and one journal line', async () => {
    const lead = await createLead(h.db);
    await inbound(lead, { text: 'STOP' }, h.clock.now());
    await inbound(lead, { text: 'unsubscribe' }, h.clock.now());
    const rows = await h.db.suppression.findMany({ where: { workspaceId: WS_A, contactKey: phoneKey(lead.phoneE164!) } });
    expect(rows).toHaveLength(1);
    expect(await h.db.auditEvent.count({ where: { action: 'suppression.stop_repeat', targetId: rows[0]!.id } })).toBe(1);
    expect((await routeJournal(h)).filter((l) => l.suppressionId === rows[0]!.id)).toHaveLength(1);
  });
});
