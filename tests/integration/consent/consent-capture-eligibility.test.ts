// P1, E11 (T18 part): consent captured at ingestion decides eligibility. The same Sheets row with
// and without the consent column evaluates eligible vs skipped NO_WHATSAPP_OPT_IN for a template
// send, through the one eligibility function. A falsy answer is skipped too; the inbound-message
// consent of a later reply would not help a template (P13, covered in the unit matrix).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { ingestBatch, type IngestBatchInput } from '@/server/services/leads/ingest';
import { DEPS } from '../ingest/support';
import { createConsentHarness, ensureWhatsApp, wsCtx, type ConsentHarness } from './support';

let h: ConsentHarness;
let approvedTemplate: string;
let pendingTemplate: string;

beforeAll(async () => {
  h = await createConsentHarness('consent-capture-eligibility');
  const wa = await ensureWhatsApp(h.db);
  approvedTemplate = wa.approved.id;
  pendingTemplate = wa.pending.id;
});
afterAll(async () => {
  await h.cleanup();
});

const NOTICE = 'I agree to receive appointment offers from Smile Avenue Dental on WhatsApp. Reply STOP to opt out.';
const MAPPING: IngestBatchInput['mapping'] = {
  version: 2,
  formId: 'sheet-capture',
  consent: { column: 'WhatsApp consent', truthyValues: ['yes'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: NOTICE },
};

async function ingestRow(batchId: string, phone: string, answers: Record<string, string>) {
  const result = await ingestBatch(
    wsCtx(h),
    { source: 'GOOGLE_SHEETS', externalBatchId: batchId, mapping: MAPPING, records: [{ externalId: batchId, fields: { name: 'Ananya Rao', phone, city: 'Gurugram' }, answers, submittedAt: '2026-10-15T09:00:00.000Z' }] },
    DEPS,
  );
  expect(result.records[0]!.status).toBe('ACCEPTED');
  return result.records[0]!.leadId!;
}

async function template(leadId: string, templateId: string = approvedTemplate) {
  const ctx = wsCtx(h);
  return checkDispatchEligibility(ctx.db, ctx, { leadId, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent: 'MANUAL_SINGLE', templateId }, h.deps);
}

describe('consent captured at ingestion drives template eligibility (P1)', () => {
  it('the row with the consent column is eligible; the same row without it is skipped NO_WHATSAPP_OPT_IN', async () => {
    const withConsent = await ingestRow('row-with', '+91 98111 40001', { 'WhatsApp consent': 'Yes', Treatment: 'Aligners' });
    const without = await ingestRow('row-without', '+91 98111 40002', { Treatment: 'Aligners' });

    expect(await template(withConsent)).toMatchObject({ eligible: true, mode: 'template', reasons: [] });
    expect(await template(without)).toMatchObject({ eligible: false, mode: 'none', reasons: ['NO_WHATSAPP_OPT_IN'] });
  });

  it('a falsy answer is skipped the same way', async () => {
    const no = await ingestRow('row-no', '+91 98111 40003', { 'WhatsApp consent': 'No' });
    expect((await template(no)).reasons).toEqual(['NO_WHATSAPP_OPT_IN']);
  });

  it('consent does not override the template check: a PENDING template is TEMPLATE_NOT_APPROVED', async () => {
    const lead = await ingestRow('row-pending-template', '+91 98111 40004', { 'WhatsApp consent': 'yes' });
    expect((await template(lead, pendingTemplate)).reasons).toEqual(['TEMPLATE_NOT_APPROVED']);
  });

  it('a WhatsApp opt-in does not make the lead email-eligible', async () => {
    const lead = await ingestRow('row-email', '+91 98111 40005', { 'WhatsApp consent': 'yes' });
    await h.db.lead.update({ where: { id: lead }, data: { emailNormalized: 'ananya@example.in' } });
    const ctx = wsCtx(h);
    const r = await checkDispatchEligibility(ctx.db, ctx, { leadId: lead, channel: 'EMAIL', kind: 'EMAIL', sendIntent: 'MANUAL_SINGLE' }, h.deps);
    expect(r.reasons).toEqual(['NO_EMAIL_BASIS']);
  });
});
