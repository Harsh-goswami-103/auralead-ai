// P1, R22, E11 (T10 part): consent captured at ingestion. This test asserts ConsentRecord state
// only; whether a lead is then eligible or skipped is T18's consent-capture-eligibility test.
// - A Sheets row whose mapped consent column holds a truthy value gives exactly one OPT_IN
//   WHATSAPP MARKETING record with the notice hash, the form evidence and collectedAt = the row's
//   submission time. Replaying the same row adds nothing.
// - No mapping, a missing column, a falsy value or no submission time gives none.
// - A Google Maps (extension) lead never gets consent, whatever the mapping says.
// - Meta form mappings give META_FORM records the same way.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { contactKey } from '@/server/security/contact-key';
import { ingestBatch, type IngestBatchInput } from '@/server/services/leads/ingest';
import { createIngestHarness, ctxFor, DEPS, PEPPER, sha256, WS_A, type IngestHarness } from '../ingest/support';

let h: IngestHarness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createIngestHarness('consent-capture');
  db = h.db;
});
afterAll(async () => {
  await h.testDb.destroy();
});

const NOTICE = 'I agree to receive offers and updates from Smile Avenue Dental on WhatsApp. Reply STOP to opt out.';
type Mapping = NonNullable<IngestBatchInput['mapping']>;
const SHEET_CONSENT: NonNullable<Mapping['consent']> = { column: 'WhatsApp consent', truthyValues: ['yes', 'y', 'true'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: NOTICE };
const SHEET_MAPPING: Mapping = { version: 3, formId: 'sheet-1AbC', consent: SHEET_CONSENT };
const SUBMITTED = '2026-10-14T09:15:00.000Z';

function sheetBatch(batchId: string, row: string, phone: string, answers: Record<string, string> | undefined, mapping: IngestBatchInput['mapping'] = SHEET_MAPPING, submittedAt: string | null = SUBMITTED): IngestBatchInput {
  return {
    source: 'GOOGLE_SHEETS',
    externalBatchId: batchId,
    mapping,
    records: [{ externalId: row, fields: { name: `Patient ${row}`, phone }, answers, submittedAt: submittedAt ?? undefined }],
  };
}

async function consentsFor(leadId: string) {
  return db.consentRecord.findMany({ where: { workspaceId: WS_A, leadId } });
}

describe('consent capture at ingestion (P1)', () => {
  it('a truthy consent column gives one OPT_IN WHATSAPP MARKETING record with notice hash and submission time', async () => {
    const result = await ingestBatch(ctxFor(db, h.clock), sheetBatch('run-yes', 'row-10', '+91 98444 00010', { 'WhatsApp consent': ' Yes ' }), DEPS);
    const rec = result.records[0]!;
    expect(rec.status).toBe('ACCEPTED');
    const consents = await consentsFor(rec.leadId!);
    expect(consents).toHaveLength(1);
    const c = consents[0]!;
    expect(c).toMatchObject({
      channel: 'WHATSAPP',
      purpose: 'MARKETING',
      basis: 'OPT_IN',
      source: 'SHEETS_FORM',
      noticeTextHash: sha256(NOTICE),
      contactKey: contactKey(PEPPER, 'phone', '+919844400010'),
      withdrawnAt: null,
      recordedBy: null,
    });
    expect(c.collectedAt.toISOString()).toBe(SUBMITTED);
    expect(c.recordedAt.toISOString()).toBe(h.clock.now().toISOString());
    expect(c.evidence).toEqual({ formId: 'sheet-1AbC', responseId: 'row-10', questionKey: 'WhatsApp consent', mappingVersion: 3 });
    expect(rec.consent).toEqual({ outcome: 'CREATED', consentRecordId: c.id });

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'consent.capture', targetId: c.id } });
    expect(JSON.stringify(audit.summary)).not.toContain('98444');

    // Replaying the same row (same batch, or the same row in a new sync run) adds nothing.
    const replay = await ingestBatch(ctxFor(db, h.clock), sheetBatch('run-yes', 'row-10', '+91 98444 00010', { 'WhatsApp consent': ' Yes ' }), DEPS);
    expect(replay.replayed).toBe(true);
    expect(replay.records[0]!.consent).toEqual({ outcome: 'CREATED', consentRecordId: c.id });
    await ingestBatch(ctxFor(db, h.clock), sheetBatch('run-yes-again', 'row-10', '+91 98444 00010', { 'WhatsApp consent': 'yes' }), DEPS);
    expect(await consentsFor(rec.leadId!)).toHaveLength(1);
  });

  it('a falsy value, a missing column, no mapping or no submission time gives none', async () => {
    const cases: Array<[string, IngestBatchInput, string]> = [
      ['falsy', sheetBatch('run-no', 'row-11', '+91 98444 00011', { 'WhatsApp consent': 'No' }), 'FALSY_VALUE'],
      ['missing column', sheetBatch('run-missing', 'row-12', '+91 98444 00012', { Name: 'x' }), 'COLUMN_MISSING'],
      ['no answers', sheetBatch('run-none', 'row-13', '+91 98444 00013', undefined), 'COLUMN_MISSING'],
      ['no mapping', sheetBatch('run-nomap', 'row-14', '+91 98444 00014', { 'WhatsApp consent': 'yes' }, { version: 1, formId: 'sheet-1AbC' }), 'NO_MAPPING'],
      ['no submission time', sheetBatch('run-notime', 'row-15', '+91 98444 00015', { 'WhatsApp consent': 'yes' }, SHEET_MAPPING, null), 'NO_EVIDENCE_TIME'],
    ];
    for (const [label, input, reason] of cases) {
      const result = await ingestBatch(ctxFor(db, h.clock), input, DEPS);
      const rec = result.records[0]!;
      expect(rec.status, label).toBe('ACCEPTED');
      expect(rec.consent, label).toEqual({ outcome: 'NONE', reason });
      expect(await consentsFor(rec.leadId!), label).toHaveLength(0);
    }
  });

  it('a WhatsApp consent mapping on a lead without a phone gives none', async () => {
    const input: IngestBatchInput = {
      source: 'GOOGLE_SHEETS',
      externalBatchId: 'run-email-only',
      mapping: SHEET_MAPPING,
      records: [{ externalId: 'row-16', fields: { name: 'Email Only', email: 'patient16@mailbox.in' }, answers: { 'WhatsApp consent': 'yes' }, submittedAt: SUBMITTED }],
    };
    const rec = (await ingestBatch(ctxFor(db, h.clock), input, DEPS)).records[0]!;
    expect(rec.consent).toEqual({ outcome: 'NONE', reason: 'NO_CONTACT_FOR_CHANNEL' });
    expect(await consentsFor(rec.leadId!)).toHaveLength(0);
  });

  it('a Maps lead never gets WhatsApp consent, even with a consent mapping and a truthy value', async () => {
    const input: IngestBatchInput = {
      source: 'GMAPS_EXTENSION',
      externalBatchId: 'ext-batch-1',
      mapping: SHEET_MAPPING,
      records: [{ externalId: 'place-77', fields: { name: 'Maps Clinic', phone: '+91 98444 00077' }, answers: { 'WhatsApp consent': 'yes' }, submittedAt: SUBMITTED }],
    };
    const rec = (await ingestBatch(ctxFor(db, h.clock), input, DEPS)).records[0]!;
    expect(rec.status).toBe('ACCEPTED');
    expect(rec.consent).toEqual({ outcome: 'NONE', reason: 'SOURCE_NOT_ELIGIBLE' });
    expect(await consentsFor(rec.leadId!)).toHaveLength(0);
  });

  it('a Meta lead form mapping gives a META_FORM record', async () => {
    const input: IngestBatchInput = {
      source: 'META_ADS',
      externalBatchId: 'meta:page-1:lg-500',
      mapping: { formId: 'form-42', consent: { column: 'whatsapp_opt_in', truthyValues: ['true'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: NOTICE, noticeVersion: 'v2' } },
      records: [{ externalId: 'lg-500', fields: { name: 'Meta Lead', phone: '+91 98444 00500' }, answers: { whatsapp_opt_in: true }, submittedAt: '2026-10-15T01:02:03.000Z' }],
    };
    const rec = (await ingestBatch(ctxFor(db, h.clock), input, DEPS)).records[0]!;
    const consents = await consentsFor(rec.leadId!);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ source: 'META_FORM', basis: 'OPT_IN', channel: 'WHATSAPP', noticeVersion: 'v2', noticeTextHash: sha256(NOTICE) });
    expect(consents[0]!.collectedAt.toISOString()).toBe('2026-10-15T01:02:03.000Z');
    expect(consents[0]!.evidence).toEqual({ formId: 'form-42', responseId: 'lg-500', questionKey: 'whatsapp_opt_in' });
  });

  it('evidence for an existing lead (a duplicate row) is recorded against that lead', async () => {
    const first = await ingestBatch(ctxFor(db, h.clock), sheetBatch('run-dup-1', 'row-20', '+91 98444 00020', { 'WhatsApp consent': 'no' }), DEPS);
    const leadId = first.records[0]!.leadId!;
    expect(await consentsFor(leadId)).toHaveLength(0);
    const second = await ingestBatch(ctxFor(db, h.clock), sheetBatch('run-dup-2', 'row-21', '+91 98444 00020', { 'WhatsApp consent': 'yes' }), DEPS);
    expect(second.records[0]).toMatchObject({ status: 'DUPLICATE', leadId });
    const consents = await consentsFor(leadId);
    expect(consents).toHaveLength(1);
    expect(consents[0]!.evidence).toMatchObject({ responseId: 'row-21' });
  });

  it('a notice hash that does not match the notice text is rejected before any write', async () => {
    const before = await db.importBatch.count();
    const bad = sheetBatch('run-badhash', 'row-30', '+91 98444 00030', { 'WhatsApp consent': 'yes' }, {
      formId: 'sheet-1AbC',
      consent: { ...SHEET_CONSENT, noticeTextHash: sha256('a different notice') },
    });
    await expect(ingestBatch(ctxFor(db, h.clock), bad, DEPS)).rejects.toThrow();
    expect(await db.importBatch.count()).toBe(before);
  });
});
