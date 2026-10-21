/**
 * P1 end to end through the Apps Script webhook (T34; ADR-15, ADR-51): the confirmed mapping's
 * consent column decides whether a pushed form row records a WhatsApp opt-in.
 *  - "Yes" with a submission time: one ConsentRecord OPT_IN / SHEETS_FORM for the lead's phone, the
 *    verbatim notice hashed, evidence = sheet id, row id, question and mapping version, collectedAt =
 *    the form submission time (not the time it arrived);
 *  - "No", a missing answer or no submission time: no consent, and the stored per-record result says why;
 *  - a later row from the same person (contact match) records its opt-in on the existing lead;
 *  - the mapping is the server's: a push cannot bring its own consent column.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactKey } from '@/server/security/contact-key';
import { createSheetsHarness, formRow, NOTICE, postPush, pushBody, setUpWorkspace, SHEET_ID, type SheetsHarness } from '../sheets/support';

let h: SheetsHarness;
let A: Awaited<ReturnType<typeof setUpWorkspace>>;

beforeAll(async () => {
  h = await createSheetsHarness('t34-sheets-consent');
  A = await setUpWorkspace(h, h.wsA);
}, 120_000);
afterAll(async () => h?.destroy());

async function push(rows: ReturnType<typeof formRow>[]) {
  const body = pushBody(rows);
  const res = await postPush(h, A, body);
  expect(res.status).toBe(200);
  await h.drain();
  const event = await h.db.webhookEvent.findFirstOrThrow({ where: { externalKey: body.eventId } });
  return (event.result as { records: Array<{ externalId: string; status: string; leadId: string | null; consent: string }> }).records;
}

describe('Sheets consent mapping (P1) through the webhook', () => {
  it('a Yes answer with a submission time records an OPT_IN with the hashed notice and form evidence', async () => {
    const row = formRow({ name: 'Consent Yes', phone: '9876500001', whatsapp: 'Yes', submittedAt: '2026-10-19T09:15:00.000Z' });
    const [result] = await push([row]);
    expect(result).toMatchObject({ externalId: row.rowKey, status: 'ACCEPTED', consent: 'CREATED' });
    const consent = await h.db.consentRecord.findFirstOrThrow({ where: { leadId: result!.leadId! } });
    expect(consent).toMatchObject({
      workspaceId: h.wsA.id,
      channel: 'WHATSAPP',
      purpose: 'MARKETING',
      basis: 'OPT_IN',
      source: 'SHEETS_FORM',
      contactKey: contactKey(h.pepper, 'phone', '+919876500001'),
      noticeTextHash: createHash('sha256').update(NOTICE, 'utf8').digest('hex'),
      collectedAt: new Date('2026-10-19T09:15:00.000Z'),
    });
    expect(consent.evidence).toEqual({ formId: SHEET_ID, responseId: row.rowKey, questionKey: 'WhatsApp updates', mappingVersion: A.mappingVersion });
    expect(consent.recordedAt).toEqual(h.clock.now());
  });

  it('No, a missing answer or no submission time records nothing, and says why', async () => {
    const no = formRow({ name: 'Consent No', whatsapp: 'No' });
    const missing = formRow({ name: 'Consent Missing' });
    delete (missing.values as Record<string, unknown>)['WhatsApp updates'];
    const undated = formRow({ name: 'Consent Undated', whatsapp: 'Yes' });
    delete undated.submittedAt;
    const results = await push([no, missing, undated]);
    expect(results.map((r) => [r.status, r.consent])).toEqual([
      ['ACCEPTED', 'FALSY_VALUE'],
      ['ACCEPTED', 'COLUMN_MISSING'],
      ['ACCEPTED', 'NO_EVIDENCE_TIME'],
    ]);
    for (const r of results) expect(await h.db.consentRecord.count({ where: { leadId: r.leadId! } })).toBe(0);
  });

  it('a later Yes from a known person records the opt-in on the existing lead (no second lead)', async () => {
    const first = formRow({ name: 'Returning Person', phone: '9876500077', whatsapp: 'No' });
    const [r1] = await push([first]);
    const second = formRow({ name: 'Returning Person', phone: '9876500077', whatsapp: 'Yes', submittedAt: '2026-10-20T05:10:00.000Z' });
    const [r2] = await push([second]);
    expect(r2).toMatchObject({ status: 'DUPLICATE', leadId: r1!.leadId, consent: 'CREATED' });
    expect(await h.db.lead.count({ where: { workspaceId: h.wsA.id, phoneE164: '+919876500077' } })).toBe(1);
    expect(await h.db.consentRecord.count({ where: { leadId: r1!.leadId! } })).toBe(1);
  });

  it('a push cannot bring its own consent column or mapping', async () => {
    const row = formRow({ name: 'Smuggled Consent', whatsapp: 'No' });
    (row.values as Record<string, unknown>)['I agree'] = 'Yes';
    const body = { ...pushBody([row]), consentMapping: { column: 'I agree', truthyValues: ['Yes'] } };
    const res = await postPush(h, A, body);
    expect(res.status).toBe(200);
    await h.drain();
    const lead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: h.wsA.id, displayName: 'Smuggled Consent' } });
    expect(await h.db.consentRecord.count({ where: { leadId: lead.id } })).toBe(0);
  });
});
