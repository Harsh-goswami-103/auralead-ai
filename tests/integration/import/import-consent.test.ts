// ADR-120 (slice F2, P1): the consent column of a file import. It is honoured only when every rule
// holds: the person holds consent.import (an OWNER; not a MEMBER, not an operator), the data source
// is the business's own list, the notice names the business and WhatsApp, the attestation is the
// exact text, an opt-in date column is mapped and no opted-in row has a future date. Otherwise the
// column is ignored (no consent, the answer says why) or, for a request that cannot be honoured as
// sent, the confirm is 422 and the import stays a preview. An honoured import records OPT_IN
// MARKETING WhatsApp consent per opted-in row with evidence {importId, row, attestedBy, noticeHash}
// and the row's date, but never clears a suppression: a contact that replied STOP gets no consent
// (SUPPRESSED_CONTACT), the refusal audited suppression.clear_refused BACKFILLED_SOURCE. Without the
// attestation no consent is recorded and templates are skipped NO_WHATSAPP_OPT_IN.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentAttestationText, type ImportMappingValue } from '@/lib/schemas/lead-import';
import { getWebhookContext } from '@/server/auth/context';
import { withTx } from '@/server/db/tx';
import { contactKey } from '@/server/security/contact-key';
import { confirmLeadImport } from '@/server/services/leads/import';
import { ingestBatch } from '@/server/services/leads/ingest';
import { noticeTextHash } from '@/server/services/messaging/consent';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { clearSuppressionForConsent, recordSuppression } from '@/server/services/messaging/suppression';
import { seedId } from '../../../prisma/seed/ids';
import { ensureWhatsApp } from '../consent/support';
import { createImportHarness, csvUpload, ownerOf, upload, userCtx, WS_A, type ImportHarness } from './support';

let h: ImportHarness;
let journalDir: string;

const BUSINESS = 'Smile Avenue Dental Clinic';
const NOTICE = `${BUSINESS} will send you offers and updates on WhatsApp. Reply STOP at any time to stop them.`;
const ATTESTATION = consentAttestationText(BUSINESS);
const HEADER = ['Name', 'Phone', 'Email', 'WhatsApp opt-in', 'Opt-in date'];
const MAP: ImportMappingValue = { name: 0, phone: 1, email: 2, consent: 3, consentDate: 4 };
const CONSENT = { noticeText: NOTICE, attestation: ATTESTATION };

beforeAll(async () => {
  h = await createImportHarness('import-consent');
  journalDir = path.join(h.storageDir, 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
}, 120_000);

afterAll(async () => {
  await h?.cleanup();
});

let seq = 0;
/** Rows with distinct phones for each test: `[name, phone, email, opt-in, date]`. */
function rowsFor(tag: string, specs: Array<{ optIn?: string; date?: string; phone?: string | null; email?: string }>): string[][] {
  seq += 1;
  return specs.map((s, i) => [`${tag} ${i + 1}`, s.phone === null ? '' : (s.phone ?? `+91 98300 ${String(seq * 100 + i).padStart(5, '0')}`), s.email ?? '', s.optIn ?? '', s.date ?? '']);
}

async function preview(rows: string[][], key: string, ctxKey: 'owner' | 'pooja' | 'employee' = 'owner') {
  const ctx = ctxKey === 'owner' ? await ownerOf(h) : ctxKey === 'pooja' ? await userCtx(h.db, h.clock, 'pooja') : await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
  const { import: created } = await upload(h, ctx, csvUpload([HEADER, ...rows], key));
  return { ctx, id: created.id };
}

async function leadOfRow(importId: string, row: number) {
  const record = await h.db.leadSourceRecord.findFirstOrThrow({ where: { source: 'FILE_IMPORT', externalId: `import:${importId}:row:${row}` } });
  return h.db.lead.findUniqueOrThrow({ where: { id: record.leadId! } });
}

describe('an honoured consent column', () => {
  it('records OPT_IN MARKETING WhatsApp consent with the import evidence, and notes the rows it could not use', async () => {
    const rows = rowsFor('Consent Shop', [
      { optIn: 'Yes', date: '14/09/2026' }, // row 2: consent
      { optIn: 'no', date: '14/09/2026' }, // row 3: not opted in
      { optIn: 'yes', date: 'last week' }, // row 4: unreadable date
      { optIn: 'yes', date: '15/09/2026', phone: null, email: 'mailonly@consent-shop.in' }, // row 5: no WhatsApp number
      { optIn: 'opted in', date: '2026-10-01' }, // row 6: consent
    ]);
    const { ctx, id } = await preview(rows, 'consent-honoured-01');
    const result = await confirmLeadImport(ctx, id, { mapping: MAP, dataSource: 'OWN_CUSTOMERS', consent: CONSENT }, { storageDir: h.storageDir });
    expect(result.consent).toEqual({ requested: true, honoured: true, reason: null });
    expect(result.import).toMatchObject({ consentAttested: true, mapping: MAP });
    const stored = await h.db.leadImport.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ consentAttested: true, consentAttestedBy: seedId('user', 'owner'), consentNoticeText: NOTICE, consentNoticeHash: noticeTextHash(NOTICE) });
    expect(stored.consentAttestedAt?.toISOString()).toBe(h.clock.now().toISOString());
    const confirmAudit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.import.confirm', targetId: id } });
    expect(confirmAudit.summary).toMatchObject({ consent: 'HONOURED', noticeHash: noticeTextHash(NOTICE), attestationHash: noticeTextHash(ATTESTATION) });

    await h.drain();
    const done = await h.db.leadImport.findUniqueOrThrow({ where: { id } });
    expect(done).toMatchObject({ status: 'SUCCEEDED', accepted: 5, consentRecorded: 2 });
    expect(done.rejections).toEqual([
      { row: 4, code: 'CONSENT_DATE_INVALID', field: 'consentDate' },
      { row: 5, code: 'CONSENT_NO_PHONE', field: 'consent' },
    ]);

    const lead = await leadOfRow(id, 2);
    const records = await h.db.consentRecord.findMany({ where: { leadId: lead.id } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ channel: 'WHATSAPP', purpose: 'MARKETING', basis: 'OPT_IN', source: 'FILE_IMPORT', noticeTextHash: noticeTextHash(NOTICE), recordedBy: seedId('user', 'owner') });
    // 14/09/2026 is midnight in the workspace's zone (Asia/Kolkata).
    expect(records[0]!.collectedAt.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    expect(records[0]!.evidence).toEqual({ responseId: `import:${id}:row:2`, importId: id, row: 2, attestedBy: seedId('user', 'owner'), noticeHash: noticeTextHash(NOTICE) });
    for (const row of [3, 4, 5]) expect(await h.db.consentRecord.count({ where: { leadId: (await leadOfRow(id, row)).id } })).toBe(0);
    expect(await h.db.consentRecord.count({ where: { leadId: (await leadOfRow(id, 6)).id, source: 'FILE_IMPORT' } })).toBe(1);
    const capture = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'consent.capture', targetId: records[0]!.id } });
    expect(capture.summary).toMatchObject({ source: 'FILE_IMPORT', basis: 'OPT_IN' });
  });

  it('never clears a suppression: a contact that replied STOP gets no consent, and the refusal is audited', async () => {
    const rows = rowsFor('Stopped Shop', [{ optIn: 'yes', date: '2026-10-10' }, { optIn: 'yes', date: '2026-10-10' }]);
    const stoppedPhone = `+91${rows[0]![1]!.replace(/\D/g, '').slice(2)}`;
    // The Stop is older than the opt-in date: an ordinary re-opt-in would clear it.
    const saved = h.clock.now();
    h.clock.set(new Date('2026-10-01T06:00:00.000Z'));
    const owner = await ownerOf(h);
    await recordSuppression(owner, { channel: 'WHATSAPP', contact: { kind: 'phone', value: stoppedPhone }, reason: 'STOP_KEYWORD', sourceEventId: null }, { contactKeyPepper: h.pepper, journalDir });
    h.clock.set(saved);
    const key = contactKey(h.pepper, 'phone', stoppedPhone);
    const suppression = await h.db.suppression.findFirstOrThrow({ where: { workspaceId: WS_A, channel: 'WHATSAPP', contactKey: key, clearedAt: null } });

    const { ctx, id } = await preview(rows, 'consent-stopped-01');
    await confirmLeadImport(ctx, id, { mapping: MAP, dataSource: 'OWN_FORM_OR_EVENT', consent: CONSENT }, { storageDir: h.storageDir });
    await h.drain();

    const done = await h.db.leadImport.findUniqueOrThrow({ where: { id } });
    expect(done).toMatchObject({ status: 'SUCCEEDED', accepted: 2, consentRecorded: 1 });
    expect(done.rejections).toEqual([{ row: 2, code: 'SUPPRESSED_CONTACT', field: 'consent' }]);
    expect(await h.db.suppression.findUniqueOrThrow({ where: { id: suppression.id } })).toMatchObject({ clearedAt: null, clearedByConsentId: null });
    expect(await h.db.consentRecord.count({ where: { leadId: (await leadOfRow(id, 2)).id } })).toBe(0);
    const refused = await h.db.auditEvent.findMany({ where: { action: 'suppression.clear_refused', targetId: suppression.id } });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ result: 'DENIED', summary: { channel: 'WHATSAPP', consentId: null, reasonCode: 'BACKFILLED_SOURCE' } });
    expect(await h.db.auditEvent.count({ where: { action: 'suppression.clear', targetId: suppression.id } })).toBe(0);
  });

  it('clearSuppressionForConsent with the backfilled flag refuses even newer evidence; without it the same evidence clears', async () => {
    const phone = '+919830099001';
    const saved = h.clock.now();
    h.clock.set(new Date('2026-10-01T06:00:00.000Z'));
    await recordSuppression(await ownerOf(h), { channel: 'WHATSAPP', contact: { kind: 'phone', value: phone }, reason: 'STOP_KEYWORD', sourceEventId: null }, { contactKeyPepper: h.pepper, journalDir });
    h.clock.set(saved);
    const key = contactKey(h.pepper, 'phone', phone);
    const ctx = getWebhookContext({ workspaceId: WS_A }, { prisma: h.db, mode: 'demo', clock: h.clock }, 'req_backfill_flag');
    const consent = { id: null, channel: 'WHATSAPP' as const, contactKey: key, basis: 'OPT_IN', collectedAt: new Date('2026-10-10T00:00:00.000Z') };
    const backfilled = await withTx(ctx.db, (tx) => clearSuppressionForConsent(tx as never, ctx, 'enqueue-reconcile', consent, { backfilled: true }));
    expect(backfilled).toBe('BACKFILLED_SOURCE');
    expect(await h.db.suppression.count({ where: { workspaceId: WS_A, contactKey: key, clearedAt: null } })).toBe(1);
    const control = await withTx(ctx.db, (tx) => clearSuppressionForConsent(tx as never, ctx, 'enqueue-reconcile', { ...consent, id: 'consent_control' }, {}));
    expect(control).toBe('CLEARED');
  });
});

describe('a consent column that is ignored', () => {
  async function runIgnored(key: string, ctxKey: 'owner' | 'pooja' | 'employee', body: Parameters<typeof confirmLeadImport>[2], reason: string) {
    const { ctx, id } = await preview(rowsFor(`Ignored ${key}`, [{ optIn: 'yes', date: '14/09/2026' }]), key, ctxKey);
    const result = await confirmLeadImport(ctx, id, body, { storageDir: h.storageDir });
    expect(result.consent).toMatchObject({ honoured: false, reason });
    const stored = await h.db.leadImport.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ consentAttested: false, consentAttestedBy: null, consentNoticeText: null, consentNoticeHash: null });
    expect(stored.mapping).not.toHaveProperty('consent');
    expect(stored.mapping).not.toHaveProperty('consentDate');
    await h.drain();
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'SUCCEEDED', accepted: 1, consentRecorded: 0 });
    expect(await h.db.consentRecord.count({ where: { leadId: (await leadOfRow(id, 2)).id } })).toBe(0);
    return id;
  }

  it('no attestation, no consent: the lead is skipped NO_WHATSAPP_OPT_IN', async () => {
    const id = await runIgnored('consent-none-01', 'owner', { mapping: MAP, dataSource: 'OWN_CUSTOMERS' }, 'NOT_REQUESTED');
    const lead = await leadOfRow(id, 2);
    const wa = await ensureWhatsApp(h.db, WS_A, 'SIMULATED');
    const ctx = getWebhookContext({ workspaceId: WS_A }, { prisma: h.db, mode: 'demo', clock: h.clock }, 'req_import_eligibility');
    const r = await checkDispatchEligibility(ctx.db, ctx, { leadId: lead.id, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent: 'BULK', templateId: wa.approved.id }, { contactKeyPepper: h.pepper });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('NO_WHATSAPP_OPT_IN');
  });

  it('a MEMBER (no consent.import) cannot import consent', async () => {
    await runIgnored('consent-member-01', 'pooja', { mapping: MAP, dataSource: 'OWN_CUSTOMERS', consent: { noticeText: 'Kesari Crafts Online on WhatsApp', attestation: consentAttestationText('Kesari Crafts Online') } }, 'NO_CAPABILITY');
  });

  it('an operator with leads.import but not consent.import cannot import consent', async () => {
    await h.db.employeeAssignment.updateMany({ where: { employeeUserId: seedId('user', 'employee'), workspaceId: WS_A }, data: { capabilities: ['leads.read', 'leads.write', 'leads.import'] } });
    await runIgnored('consent-operator-01', 'employee', { mapping: MAP, dataSource: 'OWN_CUSTOMERS', consent: CONSENT }, 'NO_CAPABILITY');
  });

  it.each(['PUBLIC_DIRECTORY', 'THIRD_PARTY_LIST', undefined] as const)('a %s data source ignores the column', async (dataSource) => {
    await runIgnored(`consent-source-${dataSource ?? 'none'}`.slice(0, 40), 'owner', { mapping: MAP, ...(dataSource ? { dataSource } : {}), consent: CONSENT }, 'DATA_SOURCE_NOT_OWN');
  });
});

describe('a consent request that cannot be honoured as sent (422, still a preview)', () => {
  const cases: Array<[string, Partial<{ mapping: ImportMappingValue; noticeText: string; attestation: string; date: string }>, string]> = [
    ['no opt-in column', { mapping: { name: 0, phone: 1, consentDate: 4 } }, 'CONSENT_COLUMN_NOT_MAPPED'],
    ['no opt-in date column', { mapping: { name: 0, phone: 1, consent: 3 } }, 'CONSENT_DATE_NOT_MAPPED'],
    ['a notice without the business name', { noticeText: 'We will send you offers on WhatsApp.' }, 'NOTICE_MISSING_BUSINESS'],
    ['a notice without WhatsApp', { noticeText: `${BUSINESS} will send you offers by SMS.` }, 'NOTICE_MISSING_WHATSAPP'],
    ['an edited attestation', { attestation: ATTESTATION.replace(' (it was not bought or scraped)', '') }, 'ATTESTATION_MISMATCH'],
    ['an opt-in date in the future', { date: '2026-12-01' }, 'CONSENT_DATE_IN_FUTURE'],
  ];

  it.each(cases)('%s is %s', async (_label, over, code) => {
    const { ctx, id } = await preview(rowsFor(`Refused ${code}`, [{ optIn: 'yes', date: '14/09/2026' }, { optIn: 'yes', date: over.date ?? '14/09/2026' }]), `consent-422-${code}`.slice(0, 60));
    await expect(
      confirmLeadImport(ctx, id, { mapping: over.mapping ?? MAP, dataSource: 'OWN_CUSTOMERS', consent: { noticeText: over.noticeText ?? NOTICE, attestation: over.attestation ?? ATTESTATION } }, { storageDir: h.storageDir }),
    ).rejects.toMatchObject({ status: 422, code, ...(code === 'CONSENT_DATE_IN_FUTURE' ? { userMessage: expect.stringContaining('Row 3') } : {}) });
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PREVIEW', consentAttested: false });
  });
});

describe('defence in depth at capture', () => {
  it('a FILE_IMPORT record with a consent mapping but no attested import records nothing', async () => {
    const ctx = getWebhookContext({ workspaceId: WS_A }, { prisma: h.db, mode: 'demo', clock: h.clock }, 'req_import_unattested');
    const { id } = await preview(rowsFor('Unattested', [{ optIn: 'yes', date: '14/09/2026' }]), 'consent-direct-01');
    const result = await ingestBatch(
      ctx,
      {
        source: 'FILE_IMPORT',
        externalBatchId: `import:${id}:direct`,
        mapping: { formId: id, consent: { column: 'consent', truthyValues: ['yes'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: NOTICE } },
        records: [{ externalId: `import:${id}:row:2`, fields: { name: 'Direct Unattested', phone: '+91 98300 99002' }, answers: { consent: 'yes' }, submittedAt: '2026-09-14T00:00:00.000Z' }],
      },
      { contactKeyPepper: h.pepper },
    );
    expect(result.records[0]).toMatchObject({ status: 'ACCEPTED', consent: { outcome: 'NONE', reason: 'NOT_ATTESTED' } });
    expect(await h.db.consentRecord.count({ where: { leadId: result.records[0]!.leadId! } })).toBe(0);
  });
});
