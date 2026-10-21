/**
 * R42-adjacent ops (T24) `npm run lead:erase`: erasing a lead removes its personal data everywhere
 * the app stored it (the lead and its merged duplicates, contact keys, source records, consent,
 * conversations and messages with their attempts and approvals, quotes with versions, shares,
 * view events, acceptance and the rendered PDF file, pipeline execution, drafts, call requests),
 * keeps every Suppression row and its contact HMAC (so the person stays opted out) with
 * `contactPlain` nulled, and writes one audit tombstone without PII. A scan of every table finds
 * none of the lead's name, phone or email afterwards, including lead CSV exports that were requested
 * with the lead's phone or name as the search term (T26, ADR-73: their search text is cleared and a
 * queued export is cancelled so it can never be written with the person's row). An erase is
 * refused while a send is in flight.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applicationTables } from '../../../prisma/seed/seed';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { requestLeadExport } from '@/server/services/leads/export';
import { contactKey } from '@/server/security/contact-key';
import { recordSuppression } from '@/server/services/messaging/suppression';
import { approveAndSendMessage, createMessageDraft } from '@/server/services/messaging/dispatch';
import { userCtx } from '../quotes/support';
import { approvedTemplate, createDispatchHarness, createLead, DEPS, grantConsent, PEPPER, quoteWithPdf, WS_A, type DispatchHarness } from '../dispatch/support';

let h: DispatchHarness;
beforeAll(async () => {
  h = await createDispatchHarness('lead-erase');
}, 120_000);
afterAll(async () => h?.destroy());

const NAME = 'Veena Kulkarni Smiles';
const PHONE = '+919811177777';
const EMAIL = 'veena.erase@example.test';

async function personalLead() {
  const lead = await h.db.lead.create({
    data: {
      workspaceId: WS_A,
      displayName: NAME,
      nameNormalized: NAME.toLowerCase(),
      phoneE164: PHONE,
      phoneRaw: '098111 77777',
      emailNormalized: EMAIL,
      address: '14 Golf Course Road',
      city: 'Gurugram',
      alternatePhones: ['+919811177778'],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: 'MANUAL',
    },
  });
  await h.db.leadContactKey.createMany({
    data: [
      { workspaceId: WS_A, leadId: lead.id, kind: 'PHONE', value: PHONE },
      { workspaceId: WS_A, leadId: lead.id, kind: 'EMAIL', value: EMAIL },
    ],
  });
  return lead;
}

async function dumpAll(): Promise<string> {
  const parts: string[] = [];
  for (const table of await applicationTables(h.db, { includeKept: true })) {
    const rows = await h.db.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}"`);
    parts.push(JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  return parts.join('\n');
}

describe('lead:erase', () => {
  it('removes the PII, keeps the suppression key, nulls contactPlain and writes a PII-free tombstone', async () => {
    const lead = await personalLead();
    const duplicate = await h.db.lead.create({
      data: { workspaceId: WS_A, displayName: NAME, nameNormalized: NAME.toLowerCase(), phoneE164: '+919811177778', alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL', mergedIntoLeadId: lead.id },
    });
    const bystander = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    await grantConsent(h.db, lead, 'EMAIL');

    // A quote with its rendered PDF, and a WhatsApp send that went out.
    const quote = await quoteWithPdf(h, lead.id);
    const artifact = await h.db.quoteArtifact.findFirstOrThrow({ where: { quoteVersionId: quote.version.id } });
    const pdfPath = path.join(h.storageDir, artifact.path);
    expect(fs.existsSync(pdfPath)).toBe(true);
    const owner = await h.owner();
    const template = await approvedTemplate(h.db);
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': NAME } }, DEPS);
    const sent = await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    await h.drain();
    expect(await h.db.dispatchAttempt.findUniqueOrThrow({ where: { id: sent.attemptId } })).toMatchObject({ state: 'SENT' });
    await h.db.callRequest.create({ data: { workspaceId: WS_A, leadId: lead.id, source: 'MANUAL', requestedAt: h.clock.now() } });

    // The person unsubscribed from email: the suppression must survive the erase.
    const suppressed = await recordSuppression(await userCtx(h.db, h.clock, 'owner'), { channel: 'EMAIL', contact: { kind: 'email', value: EMAIL }, reason: 'UNSUBSCRIBE', sourceEventId: null }, { contactKeyPepper: PEPPER, journalDir: h.journalDir });
    const before = await h.db.suppression.findUniqueOrThrow({ where: { id: suppressed.suppressionId } });
    expect(before.contactPlain).toBe(EMAIL);

    // Someone exported the leads found by the person's phone, and by their name (both still queued).
    const byPhone = await requestLeadExport(owner, { requestKey: 'erase-export-phone', filters: { q: PHONE, sort: 'newest' } });
    const byName = await requestLeadExport(owner, { requestKey: 'erase-export-name', filters: { q: NAME, stage: 'NEW', sort: 'name' } });

    const result = await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: lead.id, reason: 'Data principal erasure request #42', contactKeyPepper: PEPPER, storageDir: h.storageDir, correlationId: 'test-erase' });
    expect(result.leadIds.sort()).toEqual([lead.id, duplicate.id].sort());
    expect(result.counts.quotes).toBe(1);
    expect(result.counts.messages).toBeGreaterThanOrEqual(1);
    expect(result.filesDeleted).toBe(1);

    expect(await h.db.lead.count({ where: { id: { in: [lead.id, duplicate.id] } } })).toBe(0);
    expect(await h.db.lead.count({ where: { id: bystander.id } })).toBe(1);
    expect(await h.db.consentRecord.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await h.db.quote.count({ where: { id: quote.quote.id } })).toBe(0);
    expect(await h.db.message.count({ where: { id: sent.messageId } })).toBe(0);
    expect(fs.existsSync(pdfPath)).toBe(false);

    const after = await h.db.suppression.findUniqueOrThrow({ where: { id: suppressed.suppressionId } });
    expect(after.contactKey).toBe(contactKey(PEPPER, 'email', EMAIL));
    expect(after.contactPlain).toBeNull();
    expect(after.clearedAt).toBeNull();

    const tombstone = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.erase', targetId: lead.id } });
    expect(tombstone).toMatchObject({ workspaceId: WS_A, targetType: 'Lead', result: 'SUCCESS', reason: 'Data principal erasure request #42' });

    const dump = await dumpAll();
    for (const needle of [NAME, NAME.toLowerCase(), PHONE, '9811177777', '9811177778', EMAIL, '14 Golf Course Road']) expect(dump).not.toContain(needle);

    // The queued exports are cancelled (they would have held the person's row) and keep no search text.
    for (const e of [byPhone, byName]) {
      const row = await h.db.leadExport.findUniqueOrThrow({ where: { id: e.export.id } });
      expect(row).toMatchObject({ status: 'FAILED', errorCode: 'LEAD_ERASED' });
      expect(row.filters).not.toHaveProperty('q');
    }
    expect((await h.db.leadExport.findUniqueOrThrow({ where: { id: byName.export.id } })).filters).toMatchObject({ stage: 'NEW', sort: 'name' });
  });

  it('refuses while a send to the lead is in flight (SENDING), and a foreign or unknown lead is not found', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const owner = await h.owner();
    const template = await approvedTemplate(h.db);
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
    const sent = await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    await h.db.dispatchAttempt.update({ where: { id: sent.attemptId }, data: { state: 'SENDING' } });
    await expect(eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: lead.id, reason: 'Erasure request', contactKeyPepper: PEPPER, storageDir: h.storageDir, correlationId: 'x' })).rejects.toMatchObject({ code: 'ERASE_SEND_IN_FLIGHT' });
    expect(await h.db.lead.count({ where: { id: lead.id } })).toBe(1);

    await expect(eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: 'nosuchlead000000000000000', reason: 'Erasure request', contactKeyPepper: PEPPER, storageDir: h.storageDir, correlationId: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('cancels the lead\'s queued sends instead of leaving them to fail', async () => {
    const lead = await createLead(h.db);
    await grantConsent(h.db, lead, 'WHATSAPP');
    const owner = await h.owner();
    const template = await approvedTemplate(h.db);
    const draft = await createMessageDraft(owner, { leadId: lead.id, channel: 'WHATSAPP', kind: 'TEMPLATE', templateId: template.id, variables: { '1': 'Asha' } }, DEPS);
    const queued = await approveAndSendMessage(owner, { messageId: draft.messageId }, DEPS);
    const calls = h.wa.calls.length;
    await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: lead.id, reason: 'Erasure request', contactKeyPepper: PEPPER, storageDir: h.storageDir, correlationId: 'x' });
    expect(await h.db.job.findUniqueOrThrow({ where: { id: queued.jobId } })).toMatchObject({ status: 'CANCELLED' });
    await h.drain();
    expect(h.wa.calls).toHaveLength(calls);
  });
});
