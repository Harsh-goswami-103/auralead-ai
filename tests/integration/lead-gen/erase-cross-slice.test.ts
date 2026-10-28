// Cross-slice (integrator): `lead:erase` of a lead that went through the whole suite. The slices'
// own tests build erase fixtures by hand; here every row is written by the real services, so the
// erase is checked against what they actually store:
//  - F1: a finder run with email extraction, two places imported as leads (one is the person, one a
//    bystander);
//  - F3: the person's WhatsApp question, received through the signed webhook;
//  - F5: a handoff with an operator's note and the `handoff.summary` job's summary;
//  - F2: an Excel export of the leads that holds the person's row, requested with their name as the
//    search text.
// After `eraseLead` the person's name, number, website, address, finder emails, the note and the
// customer's words are in no table and no file; the finder result keeps only the place ID, keyword,
// location and `websiteListed`; the handoff row is gone; the xlsx is ended and deleted; the
// bystander's place keeps its content; the tombstone counts what happened.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTable } from '@/lib/spreadsheet';
import { createLeadExportJob, createLeadExportPurgeJob } from '@/server/jobs/handlers/lead-export';
import { createLeadFinderEmailsJob } from '@/server/jobs/handlers/lead-finder-emails';
import { createLeadFinderPurgeJob } from '@/server/jobs/handlers/lead-finder-purge';
import { createLeadFinderSearchJob } from '@/server/jobs/handlers/lead-finder-search';
import { createHandoffSummaryJob } from '@/server/jobs/handlers/handoff-summary';
import type { AppCtx } from '@/server/auth/context';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { handOverLead } from '@/server/services/leads/handoff';
import { leadExportRelPath, requestLeadExport } from '@/server/services/leads/export';
import { applicationTables } from '../../../prisma/seed/seed';
import { seedId } from '../../../prisma/seed/ids';
import { DEMO_AI, requestKey } from '../handoff/support';
import { userCtx } from '../quotes/support';
import { createInboundHarness, inbound, PEPPER, WS_A, type InboundHarness } from '../messaging/inbound-support';

let h: InboundHarness;
let owner: AppCtx;
let operator: AppCtx;

beforeAll(async () => {
  h = await createInboundHarness('lg-erase', {
    extraDefs: () => [
      createLeadFinderSearchJob({ mode: () => 'demo', deps: () => ({ keyRing: null }) }),
      createLeadFinderPurgeJob({ mode: () => 'demo' }),
      createLeadFinderEmailsJob({ mode: () => 'demo' }),
      createLeadExportJob({ storageDir: () => h.storageDir, mode: () => 'demo' }),
      createLeadExportPurgeJob({ storageDir: () => h.storageDir, mode: () => 'demo' }),
      createHandoffSummaryJob({ mode: () => 'demo', deps: () => DEMO_AI }),
    ],
  });
  owner = await h.owner();
  const assignment = await h.db.employeeAssignment.findFirstOrThrow({ where: { workspaceId: WS_A, employeeUserId: seedId('user', 'employee') } });
  await h.db.employeeAssignment.update({ where: { id: assignment.id }, data: { capabilities: [...new Set([...(assignment.capabilities as string[]), 'finder.run', 'leads.handoff'])] } });
  operator = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
}, 120_000);
afterAll(async () => h?.destroy());

/** The tables (by name) whose rows contain the text, so a leak says where it is. */
async function tablesWith(needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const table of await applicationTables(h.db, { includeKept: true })) {
    const rows = await h.db.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}"`);
    if (JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)).includes(needle)) found.push(table);
  }
  return found;
}

/** Every file under the storage directory, with its text (names and sheets are small). */
function storedFiles(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ file: path.relative(dir, full), text: fs.readFileSync(full).toString('latin1') });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe('lead:erase of a lead that went through the finder, the chat, a handoff and an Excel export', () => {
  it('leaves no Places content, note, summary, message or export row of the person', async () => {
    // F1: a run with email extraction; the person and a bystander come from it.
    const { run } = await startFinderRun(operator, StartFinderRunBody.parse({ requestKey: 'lg-erase-run-0001', keywords: ['Bakery'], locations: ['Indore'], maxPerQuery: 20, extractEmails: true }), { keyRing: null });
    await h.drain();
    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED', simulated: true });
    // The simulated directory repeats business names, so the person and the bystander are places whose name, number and site are unique in the run: a leftover then can only be theirs.
    const all = await h.db.leadFinderResult.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
    const unique = (pick: (r: (typeof all)[number]) => string | null, r: (typeof all)[number]) => all.filter((o) => pick(o) === pick(r)).length === 1;
    const candidates = all.filter((r) => r.hasPhone && r.websiteListed && r.emailCount > 0 && unique((o) => o.name, r) && unique((o) => o.phoneRaw, r) && unique((o) => o.website, r)).slice(0, 2);
    expect(candidates).toHaveLength(2);
    const [personResult, bystanderResult] = candidates as [(typeof candidates)[number], (typeof candidates)[number]];
    const imported = await importFinderResults(operator, { runId: run.id, resultIds: [personResult.id, bystanderResult.id], requestKey: 'lg-erase-import-0001' }, { contactKeyPepper: PEPPER });
    expect(imported.counts.accepted).toBe(2);
    const personId = imported.results.find((r) => r.resultId === personResult.id)!.leadId!;
    const bystanderId = imported.results.find((r) => r.resultId === bystanderResult.id)!.leadId!;
    const person = await h.db.lead.findUniqueOrThrow({ where: { id: personId } });
    const phone = person.phoneE164!;
    const phoneDigits = phone.replace(/^\+91/, '');
    const email = (personResult.emails as Array<{ address: string }>)[0]!.address;

    // F3: the person writes on WhatsApp (the signed webhook, the worker, the real handlers).
    const QUESTION = 'We need an online ordering site for our bakery before the festival season';
    expect((await inbound(person, { text: QUESTION }, h.clock.now())).res.status).toBe(200);
    await h.drain();
    const conversation = await h.db.conversation.findFirstOrThrow({ where: { leadId: personId, channel: 'WHATSAPP' } });

    // F5: the operator hands the lead over with a note; the summary job writes its summary.
    const NOTE = 'Owner prefers calls after six in the evening about the ordering portal';
    const stageVersion = (await h.db.lead.findUniqueOrThrow({ where: { id: personId } })).stageVersion;
    const handoff = await handOverLead(operator, { leadId: personId, note: NOTE, expectedStageVersion: stageVersion, requestKey: requestKey('lg-erase') }, DEMO_AI);
    await h.drain();
    const handoffRow = await h.db.leadHandoff.findUniqueOrThrow({ where: { id: handoff.handoffId } });
    expect(handoffRow).toMatchObject({ note: NOTE, summaryStatus: 'READY' });
    // The summary the generator wrote (JSON text `{asked, promised, nextStep}`) is searched for as well as the note.
    const summary = JSON.parse(handoffRow.summary ?? 'null') as { asked: string; promised: string; nextStep: string };
    expect(summary.asked.length).toBeGreaterThan(20);

    // F2: an Excel export of the leads, requested with the person's name as the search text.
    const exported = await requestLeadExport(owner, { requestKey: 'lg-erase-export-0001', filters: { q: person.displayName, sort: 'newest' }, format: 'xlsx' });
    await h.drain();
    const exportRow = await h.db.leadExport.findUniqueOrThrow({ where: { id: exported.export.id } });
    expect(exportRow).toMatchObject({ status: 'READY', format: 'xlsx' });
    const exportPath = path.join(h.storageDir, exportRow.path!);
    expect(readTable(new Uint8Array(fs.readFileSync(exportPath)), 'export.xlsx').rows.flat().join('|')).toContain(person.displayName);

    // Control: before the erase, every needle is in the database (so its absence afterwards means something).
    const needles = [person.displayName, phoneDigits, personResult.website!, personResult.address!, email, NOTE, QUESTION];
    for (const needle of needles) expect((await tablesWith(needle)).length, `before the erase: ${needle}`).toBeGreaterThan(0);
    // The summary text is catalog wording (no personal data) and the seeded handoffs of other leads can hold the same sentence, so it is checked by table: it sits in the handoff row only, never copied to an audit, a job payload or a task.
    const summaryTexts = [summary.asked, summary.nextStep];
    for (const text of summaryTexts) expect(await tablesWith(text), `before the erase: ${text}`).toEqual(['LeadHandoff']);

    const result = await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: personId, reason: 'Erasure request #cross-slice', contactKeyPepper: PEPPER, storageDir: h.storageDir, correlationId: 'lg-erase' });
    expect(result.counts).toMatchObject({ leadHandoffs: 1 });
    expect(result.finderResultsBlanked).toBeGreaterThanOrEqual(1);
    expect(result.exportsExpired).toBe(1);

    // No table and no file holds anything of the person.
    for (const needle of needles) expect(await tablesWith(needle), `after the erase: ${needle}`).toEqual([]);
    for (const text of summaryTexts) expect((await tablesWith(text)).filter((t) => t !== 'LeadHandoff'), `after the erase: ${text}`).toEqual([]);
    expect(await h.db.leadHandoff.count({ where: { leadId: personId } })).toBe(0);
    for (const file of storedFiles(h.storageDir)) for (const needle of [person.displayName, phoneDigits, NOTE]) expect(file.text.includes(needle), `${file.file}: ${needle}`).toBe(false);

    // The lead, its thread, its handoff (note and summary) and its export file are gone.
    expect(await h.db.lead.count({ where: { id: personId } })).toBe(0);
    expect(await h.db.conversation.count({ where: { id: conversation.id } })).toBe(0);
    expect(await h.db.message.count({ where: { conversationId: conversation.id } })).toBe(0);
    expect(await h.db.leadHandoff.count({ where: { leadId: personId } })).toBe(0);
    expect(fs.existsSync(exportPath)).toBe(false);
    expect(fs.existsSync(path.join(h.storageDir, leadExportRelPath(WS_A, exported.export.id, 'xlsx')))).toBe(false);
    expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: exported.export.id } })).toMatchObject({ status: 'EXPIRED', errorCode: 'LEAD_ERASED' });
    expect((await h.db.leadExport.findUniqueOrThrow({ where: { id: exported.export.id } })).filters).not.toHaveProperty('q');

    // The finder result keeps the place ID, keyword, location and websiteListed, nothing from Places, no link to a lead.
    expect(await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: personResult.id } })).toMatchObject({
      placeId: personResult.placeId,
      keyword: personResult.keyword,
      location: personResult.location,
      websiteListed: true,
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
      emails: [],
      emailCount: 0,
      importedLeadId: null,
      importedAt: null,
    });

    // The bystander is untouched: lead, finder content and its link.
    expect(await h.db.lead.count({ where: { id: bystanderId } })).toBe(1);
    expect(await h.db.leadFinderResult.findUniqueOrThrow({ where: { id: bystanderResult.id } })).toMatchObject({ name: bystanderResult.name, phoneRaw: bystanderResult.phoneRaw, website: bystanderResult.website, importedLeadId: bystanderId });

    // One PII-free tombstone with the counts.
    const tombstone = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.erase', targetId: personId } });
    expect(tombstone).toMatchObject({ workspaceId: WS_A, result: 'SUCCESS' });
    expect(tombstone.summary).toMatchObject({ finderResultsBlanked: result.finderResultsBlanked, exportsExpired: 1, counts: expect.objectContaining({ leadHandoffs: 1 }) });
  }, 120_000);
});
