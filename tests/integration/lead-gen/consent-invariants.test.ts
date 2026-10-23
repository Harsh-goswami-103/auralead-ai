// Cross-slice (integrator): the consent invariants of the lead-gen suite (ADR-15, ADR-118, ADR-120),
// checked where the slices meet: F1 (Lead Finder) and F2 (file import) create leads, F4's per-lead
// template values and the bulk run send to them, and the shared eligibility function decides.
//  - A lead imported from the Lead Finder (GOOGLE_PLACES) has no WhatsApp opt-in: a bulk template
//    send skips it NO_WHATSAPP_OPT_IN (pre-flight, run row and every send intent), and nothing is
//    queued or handed to a transport.
//  - A file import without the owner's attestation records no consent, whatever the opt-in column
//    says: an owner who did not attest, and an operator who holds no `consent.import` even with the
//    attestation text, both leave the leads skipped NO_WHATSAPP_OPT_IN.
//  - A file import with the full attestation records OPT_IN MARKETING WhatsApp consent, and the
//    template reaches that lead (also when the number was already a Places lead: the consent goes
//    to the existing lead), but it never clears a STOP: the contact that said Stop gets no consent
//    record, stays suppressed, and the refusal is audited BACKFILLED_SOURCE.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentAttestationText, type ImportMappingValue } from '@/lib/schemas/lead-import';
import { createLeadFinderPurgeJob } from '@/server/jobs/handlers/lead-finder-purge';
import { createLeadFinderSearchJob } from '@/server/jobs/handlers/lead-finder-search';
import type { AppCtx } from '@/server/auth/context';
import { createBulkRunJob } from '@/server/jobs/handlers/bulk-run';
import { createLeadImportJob, createLeadImportPurgeJob } from '@/server/jobs/handlers/lead-import';
import { contactKey } from '@/server/security/contact-key';
import { getBulkRun, previewBulkAction, requestBulkRun } from '@/server/services/bulk/bulk';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { confirmLeadImport, uploadLeadImport } from '@/server/services/leads/import';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { recordSuppression } from '@/server/services/messaging/suppression';
import { createDispatchHarness, DEPS, WS_A, type DispatchHarness } from '../dispatch/support';
import { csvUpload } from '../import/support';
import { userCtx } from '../quotes/support';
import { seedId } from '../../../prisma/seed/ids';
import { approvedMarketingTemplate } from './support';

const BUSINESS = 'Smile Avenue Dental Clinic';
const NOTICE = `${BUSINESS} will send you offers and updates on WhatsApp. Reply STOP at any time to stop them.`;
const ATTESTATION = consentAttestationText(BUSINESS);
const HEADER = ['Name', 'Phone', 'WhatsApp opt-in', 'Opt-in date'];
const MAP: ImportMappingValue = { name: 0, phone: 1, consent: 2, consentDate: 3 };

let h: DispatchHarness;
let owner: AppCtx;
let operator: AppCtx;
let templateId: string;
let placesLeads: Array<{ id: string; phoneE164: string | null }> = [];

beforeAll(async () => {
  h = await createDispatchHarness('lg-consent', () => [
    createLeadFinderSearchJob({ mode: () => 'demo', deps: () => ({ keyRing: null }) }),
    createLeadFinderPurgeJob({ mode: () => 'demo' }),
    createLeadImportJob({ deps: () => ({ storageDir: h.storageDir, contactKeyPepper: DEPS.contactKeyPepper, mode: 'demo' }) }),
    createLeadImportPurgeJob({ deps: () => ({ storageDir: h.storageDir, mode: 'demo' }) }),
    createBulkRunJob({ deps: () => DEPS, mode: () => 'demo' }),
  ]);
  // The operator persona of workspace A runs the finder and imports files, as a presentation operator does.
  const assignment = await h.db.employeeAssignment.findFirstOrThrow({ where: { workspaceId: WS_A, employeeUserId: seedId('user', 'employee') } });
  const caps = Array.isArray(assignment.capabilities) ? (assignment.capabilities as string[]) : [];
  await h.db.employeeAssignment.update({ where: { id: assignment.id }, data: { capabilities: [...new Set([...caps, 'finder.run', 'leads.import'])] } });
  owner = await h.owner();
  operator = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
  templateId = (await approvedMarketingTemplate(h.db, WS_A)).id;
}, 120_000);
afterAll(async () => h?.destroy());

let keySeq = 0;
const key = (tag: string) => `lgc-${tag}-${String((keySeq += 1)).padStart(5, '0')}`;

const bulkTemplate = (leadIds: string[]) => ({ action: 'SEND_WHATSAPP_TEMPLATE' as const, templateId, variables: {}, leadIds });

async function outboundTo(leadIds: string[]) {
  const messages = await h.db.message.count({ where: { direction: 'OUT', conversation: { leadId: { in: leadIds } } } });
  const attempts = await h.db.dispatchAttempt.count({ where: { message: { conversation: { leadId: { in: leadIds } } } } });
  return { messages, attempts };
}

async function leadOfRow(importId: string, row: number) {
  const record = await h.db.leadSourceRecord.findFirstOrThrow({ where: { source: 'FILE_IMPORT', externalId: `import:${importId}:row:${row}` } });
  return h.db.lead.findUniqueOrThrow({ where: { id: record.leadId! } });
}

async function runImport(ctx: AppCtx, rows: string[][], body: Parameters<typeof confirmLeadImport>[2]) {
  const { import: created } = await uploadLeadImport(ctx, csvUpload([HEADER, ...rows], key('import')), { storageDir: h.storageDir });
  const confirmed = await confirmLeadImport(ctx, created.id, body, { storageDir: h.storageDir });
  await h.drain();
  return { id: created.id, confirmed, done: await h.db.leadImport.findUniqueOrThrow({ where: { id: created.id } }) };
}

describe('leads from the Lead Finder', () => {
  it('have no WhatsApp opt-in: a bulk template send skips them NO_WHATSAPP_OPT_IN and sends nothing', async () => {
    const { run } = await startFinderRun(operator, StartFinderRunBody.parse({ requestKey: key('finder'), keywords: ['Dental clinic'], locations: ['Indore'], maxPerQuery: 20 }), { keyRing: null });
    await h.drain();
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED', simulated: true });
    const results = await h.db.leadFinderResult.findMany({ where: { runId: run.id, hasPhone: true }, orderBy: { createdAt: 'asc' }, take: 3 });
    expect(results).toHaveLength(3);

    const imported = await importFinderResults(operator, { runId: run.id, resultIds: results.map((r) => r.id), requestKey: key('finder-import') }, DEPS);
    expect(imported.counts).toMatchObject({ accepted: 3, rejected: 0, review: 0 });
    const leads = await h.db.lead.findMany({ where: { id: { in: imported.results.map((r) => r.leadId!) } } });
    placesLeads = leads.map((l) => ({ id: l.id, phoneE164: l.phoneE164 }));
    expect(leads.map((l) => l.firstSource)).toEqual(['GOOGLE_PLACES', 'GOOGLE_PLACES', 'GOOGLE_PLACES']);
    expect(await h.db.consentRecord.count({ where: { leadId: { in: leads.map((l) => l.id) } } })).toBe(0);

    const ids = leads.map((l) => l.id);
    const preview = await previewBulkAction(owner, bulkTemplate(ids), DEPS);
    expect(preview).toMatchObject({ selected: 3, eligible: 0, skipped: 3, failed: 0, byReason: [{ code: 'NO_WHATSAPP_OPT_IN', count: 3 }] });
    for (const row of preview.rows) expect(row).toMatchObject({ outcome: 'SKIPPED', reasons: ['NO_WHATSAPP_OPT_IN'] });

    const before = await outboundTo(ids);
    const queued = await requestBulkRun(owner, { ...bulkTemplate(ids), requestKey: key('bulk') }, DEPS);
    await h.drain();
    expect(await getBulkRun(owner, queued.id)).toMatchObject({ status: 'COMPLETED', queued: 0, skipped: 3, failed: 0 });
    expect(await outboundTo(ids)).toEqual(before);
    expect(h.wa.calls).toEqual([]);

    // Every send intent reads the same answer from the shared eligibility function (an automated
    // send also reports that auto-send is off in this workspace).
    for (const sendIntent of ['BULK', 'AUTOMATED', 'MANUAL_SINGLE'] as const) {
      const r = await checkDispatchEligibility(owner.db, owner, { leadId: ids[0]!, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent, templateId }, DEPS);
      expect(r).toMatchObject({ eligible: false, deferrable: false });
      expect(r.reasons).toContain('NO_WHATSAPP_OPT_IN');
      if (sendIntent !== 'AUTOMATED') expect(r.reasons).toEqual(['NO_WHATSAPP_OPT_IN']);
    }
  });
});

describe('a file import without the attestation', () => {
  it('records no consent when the owner does not attest, and none when an operator without consent.import sends the attestation', async () => {
    const owners = await runImport(owner, [['No Attestation Salon', '+91 98250 10001', 'Yes', '2026-10-01']], { mapping: MAP, dataSource: 'OWN_CUSTOMERS' });
    expect(owners.confirmed.consent).toMatchObject({ honoured: false, reason: 'NOT_REQUESTED' });

    const operators = await runImport(operator, [['Operator Attested Salon', '+91 98250 10002', 'Yes', '2026-10-01']], { mapping: MAP, dataSource: 'OWN_CUSTOMERS', consent: { noticeText: NOTICE, attestation: ATTESTATION } });
    expect(operators.confirmed.consent).toMatchObject({ honoured: false, reason: 'NO_CAPABILITY' });

    const ids: string[] = [];
    for (const r of [owners, operators]) {
      expect(r.done).toMatchObject({ status: 'SUCCEEDED', accepted: 1, consentRecorded: 0, consentAttested: false });
      const lead = await leadOfRow(r.id, 2);
      expect(lead.firstSource).toBe('FILE_IMPORT');
      ids.push(lead.id);
    }
    expect(await h.db.consentRecord.count({ where: { leadId: { in: ids } } })).toBe(0);

    const preview = await previewBulkAction(owner, bulkTemplate(ids), DEPS);
    expect(preview).toMatchObject({ selected: 2, eligible: 0, skipped: 2, byReason: [{ code: 'NO_WHATSAPP_OPT_IN', count: 2 }] });
    const before = await outboundTo(ids);
    const run = await requestBulkRun(owner, { ...bulkTemplate(ids), requestKey: key('bulk') }, DEPS);
    await h.drain();
    expect(await getBulkRun(owner, run.id)).toMatchObject({ status: 'COMPLETED', queued: 0, skipped: 2 });
    expect(await outboundTo(ids)).toEqual(before);
    expect(h.wa.calls).toEqual([]);
  });
});

describe('a file import with the full attestation', () => {
  it('records OPT_IN, reaches an existing Places lead by its number, and never clears a STOP', async () => {
    const existingPlaces = placesLeads[0]!;
    const stoppedPhone = '+919825010099';
    // The Stop is older than the opt-in date below: an ordinary re-opt-in would clear it.
    const saved = h.clock.now();
    h.clock.set(new Date('2026-10-01T06:00:00.000Z'));
    await recordSuppression(owner, { channel: 'WHATSAPP', contact: { kind: 'phone', value: stoppedPhone }, reason: 'STOP_KEYWORD', sourceEventId: null }, { contactKeyPepper: DEPS.contactKeyPepper, journalDir: h.journalDir });
    h.clock.set(saved);
    const stoppedKey = contactKey(DEPS.contactKeyPepper, 'phone', stoppedPhone);
    const suppression = await h.db.suppression.findFirstOrThrow({ where: { workspaceId: WS_A, channel: 'WHATSAPP', contactKey: stoppedKey, clearedAt: null } });

    const { id, confirmed, done } = await runImport(
      owner,
      [
        ['Attested Bakery', '+91 98250 10003', 'Yes', '2026-10-10'], // row 2: consent
        ['Stopped Cafe', stoppedPhone, 'Yes', '2026-10-10'], // row 3: said Stop
        ['Not Opted In Gym', '+91 98250 10004', 'No', '2026-10-10'], // row 4: no consent
        ['Known Places Clinic', existingPlaces.phoneE164!, 'Yes', '2026-10-10'], // row 5: already a Places lead
      ],
      { mapping: MAP, dataSource: 'OWN_CUSTOMERS', consent: { noticeText: NOTICE, attestation: ATTESTATION } },
    );
    expect(confirmed.consent).toEqual({ requested: true, honoured: true, reason: null });
    expect(done).toMatchObject({ status: 'SUCCEEDED', accepted: 3, duplicates: 1, consentRecorded: 2, consentAttested: true });
    expect(done.rejections).toEqual([{ row: 3, code: 'SUPPRESSED_CONTACT', field: 'consent' }]);

    const bakery = await leadOfRow(id, 2);
    const cafe = await leadOfRow(id, 3);
    const gym = await leadOfRow(id, 4);
    const clinic = await leadOfRow(id, 5);
    expect(clinic.id).toBe(existingPlaces.id);
    expect(clinic.firstSource).toBe('GOOGLE_PLACES');

    // Consent: recorded for the two opted-in numbers, with the import as evidence; none for the others.
    for (const lead of [bakery, clinic]) {
      const records = await h.db.consentRecord.findMany({ where: { leadId: lead.id, source: 'FILE_IMPORT' } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ channel: 'WHATSAPP', purpose: 'MARKETING', basis: 'OPT_IN', source: 'FILE_IMPORT' });
      expect(records[0]!.evidence).toMatchObject({ importId: id, attestedBy: owner.actor!.userId });
    }
    for (const lead of [cafe, gym]) expect(await h.db.consentRecord.count({ where: { leadId: lead.id } })).toBe(0);

    // The Stop stands: not cleared, no consent record, and the refusal is audited.
    expect(await h.db.suppression.findUniqueOrThrow({ where: { id: suppression.id } })).toMatchObject({ clearedAt: null, clearedByConsentId: null });
    expect(await h.db.auditEvent.findMany({ where: { action: 'suppression.clear_refused', targetId: suppression.id } })).toMatchObject([{ result: 'DENIED', summary: { channel: 'WHATSAPP', reasonCode: 'BACKFILLED_SOURCE' } }]);
    expect(await h.db.auditEvent.count({ where: { action: 'suppression.clear', targetId: suppression.id } })).toBe(0);

    // The template reaches the two opted-in leads and only them.
    const ids = [bakery.id, cafe.id, gym.id, clinic.id];
    const preview = await previewBulkAction(owner, bulkTemplate(ids), DEPS);
    const byLead = Object.fromEntries(preview.rows.map((r) => [r.leadId, r]));
    expect(byLead[bakery.id]).toMatchObject({ outcome: 'ELIGIBLE', reasons: [] });
    expect(byLead[clinic.id]).toMatchObject({ outcome: 'ELIGIBLE', reasons: [] });
    expect(byLead[cafe.id]!.outcome).toBe('SKIPPED');
    expect(byLead[cafe.id]!.reasons).toContain('SUPPRESSED');
    expect(byLead[gym.id]).toMatchObject({ outcome: 'SKIPPED', reasons: ['NO_WHATSAPP_OPT_IN'] });

    const run = await requestBulkRun(owner, { ...bulkTemplate(ids), requestKey: key('bulk') }, DEPS);
    await h.drain();
    expect(await getBulkRun(owner, run.id)).toMatchObject({ status: 'COMPLETED', queued: 2, skipped: 2, failed: 0 });
    expect(h.wa.calls.map((c) => c.request.template?.name)).toEqual(['lead_gen_intro', 'lead_gen_intro']);
    // The duplicate row did not rename the Places lead: its own name is the greeting.
    expect(h.wa.calls.map((c) => c.request.template?.variables['1']).sort()).toEqual(['Attested Bakery', clinic.displayName].sort());
    expect(await outboundTo([cafe.id, gym.id])).toEqual({ messages: 0, attempts: 0 });
  });
});
