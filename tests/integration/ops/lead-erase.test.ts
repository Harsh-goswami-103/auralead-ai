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
 *
 * Lead-gen suite (ADR-118, ADR-120, ADR-124): the lead's handoff row is deleted; every Lead Finder
 * result that is the person's place (imported as the lead, or the same place ID) loses its Places
 * content, emails and import link but keeps its place ID, keyword and location; every import still
 * holding a parsed-rows file is ended and the file deleted (it may hold the person's row); xlsx
 * exports are ended and deleted like CSV ones; jobs naming the handoff or an ended import are
 * cancelled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applicationTables } from '../../../prisma/seed/seed';
import { enqueueJob } from '@/server/jobs/queue';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { leadExportRelPath, requestLeadExport } from '@/server/services/leads/export';
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

  it('covers the lead-gen tables: handoff, finder results, import files, xlsx exports and their jobs', async () => {
    const PLACE_NAME = 'Rukmini Saree Emporium';
    const PLACE_PHONE = '+919826077777';
    const PLACE_ID = 'ChIJ-rukmini-erase';
    const now = h.clock.now();
    const lead = await h.db.lead.create({
      data: {
        workspaceId: WS_A,
        displayName: PLACE_NAME,
        nameNormalized: PLACE_NAME.toLowerCase(),
        phoneE164: PLACE_PHONE,
        address: '7 Rajwada Chowk',
        pincode: '452002',
        alternatePhones: [],
        scoreReasons: [],
        unknownInputs: [],
        firstSource: 'GOOGLE_PLACES',
        placeId: PLACE_ID,
        placesContentExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
        handedOverAt: now,
      },
    });
    await h.db.leadContactKey.createMany({
      data: [
        { workspaceId: WS_A, leadId: lead.id, kind: 'PHONE', value: PLACE_PHONE },
        { workspaceId: WS_A, leadId: lead.id, kind: 'PROVIDER', value: `GOOGLE_PLACES:${PLACE_ID}` },
      ],
    });
    const owner = await h.owner();
    const handoff = await h.db.leadHandoff.create({
      data: { workspaceId: WS_A, leadId: lead.id, fromUserId: owner.actor!.userId, note: `Call ${PLACE_NAME} after 6 pm`, summary: `${PLACE_NAME} wants a catalogue site`, summaryStatus: 'READY', createdAt: now },
    });

    // Two runs found the place (one imported it); a third result is someone else's place.
    const run = (key: string) =>
      h.db.leadFinderRun.create({
        data: { workspaceId: WS_A, requestKey: key, requestedBy: owner.actor!.userId, keywords: ['saree shop'], locations: ['Indore'], maxPerQuery: 20, emailBlacklist: [], status: 'SUCCEEDED', createdAt: now },
      });
    const [run1, run2] = [await run('erase-run-1'), await run('erase-run-2')];
    const placeContent = {
      name: PLACE_NAME,
      category: 'Saree shop',
      phoneRaw: '098260 77777',
      hasPhone: true,
      website: null,
      websiteListed: false,
      ratingX10: 43,
      reviewCount: 88,
      address: '7 Rajwada Chowk',
      city: 'Indore',
      state: 'Madhya Pradesh',
      pincode: '452002',
      attributions: [{ provider: 'Google Maps' }],
      emails: [{ address: 'rukmini.owner@gmail.example.in', sourceUrl: 'https://rukmini.example.in/contact', kind: 'PERSONAL' }],
      emailCount: 1,
      emailStatus: 'DONE',
      keyword: 'saree shop',
      location: 'Indore',
      contentExpiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
    };
    const imported = await h.db.leadFinderResult.create({ data: { ...placeContent, workspaceId: WS_A, runId: run1.id, placeId: PLACE_ID, importedLeadId: lead.id, importedAt: now } });
    const sameplace = await h.db.leadFinderResult.create({ data: { ...placeContent, workspaceId: WS_A, runId: run2.id, placeId: PLACE_ID } });
    const otherPlace = await h.db.leadFinderResult.create({ data: { ...placeContent, workspaceId: WS_A, runId: run2.id, placeId: 'ChIJ-someone-else', name: 'Bystander Textiles', phoneRaw: '098260 66666', address: '3 Sarafa Bazar', emails: [], emailCount: 0 } });

    // Imports still holding their parsed rows (a preview and a queued one), and a finished one without a file.
    const importFile = (id: string) => {
      const rel = `imports/${WS_A}/${id}.json`;
      fs.mkdirSync(path.dirname(path.join(h.storageDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(h.storageDir, rel), JSON.stringify([[PLACE_NAME, '098260 77777']]));
      return rel;
    };
    const importRow = (key: string, status: 'PREVIEW' | 'QUEUED' | 'SUCCEEDED') =>
      h.db.leadImport.create({
        data: { workspaceId: WS_A, requestKey: key, requestedBy: owner.actor!.userId, fileName: 'contacts.xlsx', sheetName: 'Sheet1', sha256: 'a'.repeat(64), rowCount: 1, header: ['Name', 'Phone'], rejections: [], status, createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000) },
      });
    const preview = await importRow('erase-import-preview', 'PREVIEW');
    const queued = await importRow('erase-import-queued', 'QUEUED');
    const finished = await importRow('erase-import-done', 'SUCCEEDED');
    await h.db.leadImport.update({ where: { id: preview.id }, data: { storagePath: importFile(preview.id) } });
    await h.db.leadImport.update({ where: { id: queued.id }, data: { storagePath: importFile(queued.id) } });

    // An xlsx export that is ready, and one being written right now.
    const exportRow = (key: string, status: 'READY' | 'QUEUED') =>
      h.db.leadExport.create({ data: { workspaceId: WS_A, requestKey: key, status, filters: { sort: 'newest' }, requestedBy: owner.actor!.userId, correlationId: 'erase-xlsx', format: 'xlsx', createdAt: now } });
    const readyXlsx = await exportRow('erase-xlsx-ready', 'READY');
    const queuedXlsx = await exportRow('erase-xlsx-queued', 'QUEUED');
    const writeExport = (id: string) => {
      const rel = leadExportRelPath(WS_A, id, 'xlsx');
      fs.mkdirSync(path.dirname(path.join(h.storageDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(h.storageDir, rel), PLACE_NAME);
      return rel;
    };
    await h.db.leadExport.update({ where: { id: readyXlsx.id }, data: { path: writeExport(readyXlsx.id), expiresAt: new Date(now.getTime() + 86_400_000) } });
    writeExport(queuedXlsx.id);

    // Pending jobs that name the handoff or an import.
    const job = (type: string, payload: Record<string, string>) => enqueueJob(h.db, h.clock, { type, payload, workspaceId: WS_A, idempotencyKey: `${type}:${Object.values(payload).join(':')}`, correlationId: 'erase-jobs' });
    const summaryJob = await job('handoff.summary', { handoffId: handoff.id });
    const importJob = await job('leads.import', { importId: queued.id });

    const result = await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: lead.id, reason: 'Erasure request #77', contactKeyPepper: PEPPER, storageDir: h.storageDir, correlationId: 'test-erase-leadgen' });
    expect(result.counts.leadHandoffs).toBe(1);
    expect(result).toMatchObject({ finderResultsBlanked: 2, importsEnded: 2, exportsExpired: 1, exportsCancelled: 1 });
    expect(await h.db.leadHandoff.count({ where: { id: handoff.id } })).toBe(0);

    for (const id of [imported.id, sameplace.id]) {
      expect(await h.db.leadFinderResult.findUniqueOrThrow({ where: { id } })).toMatchObject({
        placeId: PLACE_ID,
        keyword: 'saree shop',
        location: 'Indore',
        websiteListed: false,
        name: null,
        category: null,
        phoneRaw: null,
        hasPhone: false,
        website: null,
        ratingX10: null,
        reviewCount: null,
        address: null,
        city: null,
        state: null,
        pincode: null,
        attributions: null,
        emails: [],
        emailCount: 0,
        importedLeadId: null,
        importedAt: null,
      });
    }
    expect(await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: otherPlace.id } })).toMatchObject({ name: 'Bystander Textiles', phoneRaw: '098260 66666' });

    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id: preview.id } })).toMatchObject({ status: 'EXPIRED', storagePath: null, finishedAt: now });
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'FAILED', storagePath: null, finishedAt: now });
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id: finished.id } })).toMatchObject({ status: 'SUCCEEDED', storagePath: null, finishedAt: null });
    for (const id of [preview.id, queued.id]) expect(fs.existsSync(path.join(h.storageDir, 'imports', WS_A, `${id}.json`))).toBe(false);

    expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: readyXlsx.id } })).toMatchObject({ status: 'EXPIRED', errorCode: 'LEAD_ERASED' });
    expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: queuedXlsx.id } })).toMatchObject({ status: 'FAILED', errorCode: 'LEAD_ERASED' });
    for (const id of [readyXlsx.id, queuedXlsx.id]) expect(fs.existsSync(path.join(h.storageDir, leadExportRelPath(WS_A, id, 'xlsx')))).toBe(false);

    for (const j of [summaryJob.job, importJob.job]) expect(await h.db.job.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: 'CANCELLED' });

    const tombstone = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.erase', targetId: lead.id } });
    expect(tombstone.summary).toMatchObject({ finderResultsBlanked: 2, importsEnded: 2, counts: expect.objectContaining({ leadHandoffs: 1 }) });
    const dump = await dumpAll();
    for (const needle of [PLACE_NAME, PLACE_NAME.toLowerCase(), PLACE_PHONE, '9826077777', '098260 77777', '7 Rajwada Chowk', 'rukmini.owner@gmail.example.in']) expect(dump).not.toContain(needle);
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
