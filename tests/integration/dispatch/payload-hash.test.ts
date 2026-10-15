/**
 * O3: an approval binds the exact outbound payload. Changing the destination, the template
 * variables, the template, the body, the subject or the attached PDF after approval gives
 * APPROVAL_STALE at preflight and zero provider calls. Applies to messages without a quote too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, computePayloadHash } from '@/server/services/approvals/payload-hash';
import { approveAndSendMessage, approveAndSendQuote, createMessageDraft } from '@/server/services/messaging/dispatch';
import { approvedTemplate, createDispatchHarness, DEPS, eligibleLead, grantConsent, quoteWithPdf, type DispatchHarness } from './support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('payload-hash');
}, 120_000);
afterAll(async () => h?.destroy());

async function expectStale(attemptId: string) {
  const before = h.wa.calls.length + h.email.calls.length;
  await h.drain();
  expect(h.wa.calls.length + h.email.calls.length).toBe(before);
  const attempt = await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  expect(attempt).toMatchObject({ state: 'SKIPPED', reasonCode: 'APPROVAL_STALE' });
  expect((await h.db.message.findUniqueOrThrow({ where: { id: attempt.messageId } })).status).toBe('NOT_SENT');
  expect(await h.db.auditEvent.count({ where: { action: 'dispatch.skipped', targetId: attemptId } })).toBe(1);
}

describe('canonical payload hash', () => {
  it('ignores key order and changes with any field', () => {
    const base = { channel: 'EMAIL' as const, destinationKey: 'k', templateName: null, templateLang: null, variables: { b: '2', a: '1' }, body: 'hi', subject: 's', attachment: null };
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
    expect(computePayloadHash(base)).toBe(computePayloadHash({ ...base, variables: { a: '1', b: '2' } }));
    for (const change of [{ destinationKey: 'k2' }, { body: 'hi!' }, { subject: 'S' }, { variables: { a: '1', b: '3' } }, { templateName: 't' }, { attachment: { quoteVersionId: 'v', artifactSha256: 'x' } }]) {
      expect(computePayloadHash({ ...base, ...change })).not.toBe(computePayloadHash(base));
    }
  });
});

describe('APPROVAL_STALE at preflight (O3)', () => {
  it('a WhatsApp text message: the body edited after approval is not sent', async () => {
    const lead = await eligibleLead(h.db);
    await h.db.conversation.create({ data: { workspaceId: lead.workspaceId, leadId: lead.id, channel: 'WHATSAPP', contactKey: 'x', lastInboundProviderAt: new Date(h.clock.now().getTime() - 60_000) } });
    await grantConsent(h.db, lead, 'WHATSAPP', 'INBOUND_MESSAGE');
    const owner = await h.owner();
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEXT', body: 'Your appointment is at 5 pm.' }, DEPS);
    const sent = await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    await h.db.message.update({ where: { id: draft.messageId }, data: { body: 'Your appointment is at 6 pm.' } });
    await expectStale(sent.attemptId);
  }, 60_000);

  it('an unchanged message without a quote is sent (the hash matches)', async () => {
    const lead = await eligibleLead(h.db);
    const owner = await h.owner();
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'EMAIL', kind: 'EMAIL', subject: 'Clinic hours', body: 'We are open 9 to 5.' }, DEPS);
    const sent = await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    const before = h.email.calls.length;
    await h.drain();
    expect(h.email.calls.length).toBe(before + 1);
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'SENT' });
  }, 60_000);

  it('an email subject changed after approval is stale', async () => {
    const lead = await eligibleLead(h.db);
    const owner = await h.owner();
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'EMAIL', kind: 'EMAIL', subject: 'Clinic hours', body: 'Open 9 to 5.' }, DEPS);
    const sent = await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    await h.db.message.update({ where: { id: draft.messageId }, data: { subject: 'Clinic hours (updated)' } });
    await expectStale(sent.attemptId);
  }, 60_000);

  it('the destination changed after approval (lead phone edited) is stale', async () => {
    const lead = await eligibleLead(h.db);
    const template = await approvedTemplate(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const r = await approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel: 'WHATSAPP', templateId: template.id, variables: { '1': 'A' } }, DEPS);
    await h.db.lead.update({ where: { id: lead.id }, data: { phoneE164: '+919822099999' } });
    await expectStale(r.attemptId);
  }, 60_000);

  it('template variables changed after approval are stale', async () => {
    const lead = await eligibleLead(h.db);
    const template = await approvedTemplate(h.db);
    const { quote } = await quoteWithPdf(h, lead.id);
    const r = await approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel: 'WHATSAPP', templateId: template.id, variables: { '1': 'A' } }, DEPS);
    await h.db.message.update({ where: { id: r.messageId }, data: { variables: { '1': 'B' } } });
    await expectStale(r.attemptId);
  }, 60_000);

  it('another template after approval is stale', async () => {
    const lead = await eligibleLead(h.db);
    const template = await approvedTemplate(h.db);
    const other = await approvedTemplate(h.db, lead.workspaceId, 'quote_ready_alt');
    const { quote } = await quoteWithPdf(h, lead.id);
    const r = await approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel: 'WHATSAPP', templateId: template.id }, DEPS);
    await h.db.message.update({ where: { id: r.messageId }, data: { templateId: other.id } });
    await expectStale(r.attemptId);
  }, 60_000);

  it('a replaced attachment (different PDF hash) after approval is stale', async () => {
    const lead = await eligibleLead(h.db);
    const { quote, version } = await quoteWithPdf(h, lead.id);
    const r = await approveAndSendQuote(await h.owner(), { quoteId: quote.id, expectedVersion: 1, channel: 'EMAIL' }, DEPS);
    await h.db.quoteArtifact.update({ where: { quoteVersionId: version.id }, data: { sha256: 'f'.repeat(64) } });
    await expectStale(r.attemptId);
  }, 60_000);
});
