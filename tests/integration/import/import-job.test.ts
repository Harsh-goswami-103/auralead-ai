// ADR-120 (slice F2): confirming and running a lead import. Confirm checks the mapping (a name
// column, a phone or email column, one field per column, columns inside the header), refuses an
// expired upload (410) and a second confirm (409), and queues the first `leads.import` chunk. Each
// chunk job ingests 200 rows through ingestBatch (source FILE_IMPORT, batch `import:<id>:<chunk>`,
// record `import:<id>:row:<n>`), adds its counts and row notes (row, code, field: never a value)
// and queues the next chunk; the last one marks the import SUCCEEDED, deletes the rows file and
// audits the totals. Imported leads have no WhatsApp opt-in. The chunk re-checks the import before
// ingesting, so an import ended by lead:erase ingests nothing more. leads.importPurge expires an
// unconfirmed upload at its expiry and deletes the file; a running import is left to finish.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as confirmRoute } from '@/app/api/app/leads/imports/[importId]/confirm/route';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { confirmLeadImport, getLeadImportView } from '@/server/services/leads/import';
import { makeRequest } from '../auth/support';
import { authAs, businessRows, createImportHarness, csvUpload, DAY, ownerOf, upload, userCtx, WS_A, type ImportHarness } from './support';

let h: ImportHarness;

beforeAll(async () => {
  h = await createImportHarness('import-job');
}, 120_000);

afterAll(async () => {
  await h?.cleanup();
});

const MAP = { name: 0, phone: 1, city: 2 };

async function previewOf(rows: string[][], key: string, header = ['Name', 'Phone', 'City']) {
  const owner = await ownerOf(h);
  const { import: created } = await upload(h, owner, csvUpload([header, ...rows], key));
  return { owner, id: created.id };
}

describe('confirming', () => {
  it('refuses an incomplete or impossible mapping with a code', async () => {
    const { owner, id } = await previewOf(businessRows(2, 'Mapping Check', 100), 'confirm-map-0001');
    const cases: Array<[Record<string, number | null>, string]> = [
      [{ phone: 1 }, 'MAPPING_NAME_REQUIRED'],
      [{ name: 0, city: 2 }, 'MAPPING_CONTACT_REQUIRED'],
      [{ name: 0, phone: 7 }, 'MAPPING_COLUMN_UNKNOWN'],
      [{ name: 0, phone: 0 }, 'MAPPING_COLUMN_REUSED'],
    ];
    for (const [mapping, code] of cases) {
      await expect(confirmLeadImport(owner, id, { mapping }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 422, code });
    }
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PREVIEW', mapping: null });
  });

  it('queues the first chunk once; a second confirm is 409, another person 404, an expired upload 410', async () => {
    const { owner, id } = await previewOf(businessRows(3, 'Confirm Once', 200), 'confirm-once-0001');
    const rohan = await userCtx(h.db, h.clock, 'rohan');
    await expect(confirmLeadImport(rohan, id, { mapping: MAP }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 404 });

    const result = await confirmLeadImport(owner, id, { mapping: MAP, dataSource: 'OWN_CUSTOMERS' }, { storageDir: h.storageDir });
    expect(result.import).toMatchObject({ status: 'QUEUED', mapping: MAP, dataSource: 'OWN_CUSTOMERS', consentAttested: false });
    expect(result.consent).toEqual({ requested: false, honoured: false, reason: 'NOT_REQUESTED' });
    const job = await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `leads.import:${id}:0` } });
    expect(job).toMatchObject({ type: 'leads.import', workspaceId: WS_A, status: 'QUEUED' });
    expect(job.payload).toEqual({ importId: id, chunk: 0 });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.import.confirm', targetId: id } });
    expect(audit.summary).toMatchObject({ fields: ['city', 'name', 'phone'], dataSource: 'OWN_CUSTOMERS', rowCount: 3, consent: 'NOT_REQUESTED' });
    await expect(confirmLeadImport(owner, id, { mapping: MAP }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 409, code: 'IMPORT_ALREADY_STARTED' });

    const late = await previewOf(businessRows(1, 'Too Late', 300), 'confirm-late-0001');
    const saved = h.clock.now();
    h.clock.set(new Date(saved.getTime() + DAY));
    try {
      await expect(confirmLeadImport(late.owner, late.id, { mapping: MAP }, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 410, code: 'IMPORT_EXPIRED' });
    } finally {
      h.clock.set(saved);
    }
    await h.drain();
  });

  it('the route confirms with the session and the slug', async () => {
    const { id } = await previewOf(businessRows(1, 'Route Confirm', 400), 'confirm-route-0001');
    const owner = await authAs(h, 'owner');
    const res = await confirmRoute(makeRequest(`/api/app/leads/imports/${id}/confirm`, { body: { workspaceSlug: 'smile-avenue-dental', mapping: MAP }, cookie: owner.cookie, csrf: owner.csrf }), {
      params: Promise.resolve({ importId: id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ import: { id, status: 'QUEUED' } });
    await h.drain();
  });
});

describe('the leads.import job', () => {
  it('ingests 200 rows per chunk, counts every row, keeps row notes only, and deletes the file at the end', async () => {
    const rows = businessRows(450, 'Chunk Shop', 1_000);
    rows[4] = ['', '+91 9811000099', 'Indore']; // row 6: no name
    rows[9] = ['No Contact Dhaba', 'not a phone', 'Indore']; // row 11: no valid contact
    rows[250] = ['Long City Store', '+91 9811000098', 'x'.repeat(201)]; // row 252: city too long
    rows[449] = ['Chunk Shop Twin', rows[0]![1]!, 'Indore']; // row 451: same phone as row 2 (another chunk)
    const { owner, id } = await previewOf(rows, 'job-chunks-0001');
    await confirmLeadImport(owner, id, { mapping: MAP }, { storageDir: h.storageDir });
    const storagePath = (await h.db.leadImport.findUniqueOrThrow({ where: { id } })).storagePath!;
    expect(fs.existsSync(path.join(h.storageDir, storagePath))).toBe(true);
    await h.drain();

    const done = await h.db.leadImport.findUniqueOrThrow({ where: { id } });
    expect(done).toMatchObject({ status: 'SUCCEEDED', storagePath: null, accepted: 446, duplicates: 1, review: 0, rejected: 3, consentRecorded: 0 });
    expect(done.finishedAt?.toISOString()).toBe(h.clock.now().toISOString());
    expect(done.rejections).toEqual([
      { row: 6, code: 'MISSING_NAME', field: 'name' },
      { row: 11, code: 'NO_VALID_CONTACT' },
      { row: 252, code: 'FIELD_TOO_LONG', field: 'city' },
    ]);
    expect(fs.existsSync(path.join(h.storageDir, storagePath))).toBe(false);

    const batches = await h.db.importBatch.findMany({ where: { source: 'FILE_IMPORT', externalBatchId: { startsWith: `import:${id}:` } }, orderBy: { externalBatchId: 'asc' } });
    expect(batches.map((b) => [b.externalBatchId, (b.counts as { received: number }).received])).toEqual([
      [`import:${id}:0`, 200],
      [`import:${id}:1`, 199],
      [`import:${id}:2`, 50],
    ]);
    const chunkJobs = await h.db.job.findMany({ where: { type: 'leads.import', idempotencyKey: { startsWith: `leads.import:${id}:` } }, orderBy: { idempotencyKey: 'asc' } });
    expect(chunkJobs.map((j) => [j.idempotencyKey, j.status])).toEqual([
      [`leads.import:${id}:0`, 'SUCCEEDED'],
      [`leads.import:${id}:1`, 'SUCCEEDED'],
      [`leads.import:${id}:2`, 'SUCCEEDED'],
    ]);

    const record = await h.db.leadSourceRecord.findFirstOrThrow({ where: { source: 'FILE_IMPORT', externalId: `import:${id}:row:3` } });
    expect(record.status).toBe('ACCEPTED');
    expect(record.attribution).toEqual({ importId: id, row: '3' });
    const lead = await h.db.lead.findUniqueOrThrow({ where: { id: record.leadId! } });
    expect(lead).toMatchObject({ displayName: 'Chunk Shop 2', firstSource: 'FILE_IMPORT', city: 'Indore', simulated: false });
    // Imported leads have no WhatsApp opt-in (ADR-120; eligibility in tests/integration/consent/file-import-consent.test.ts).
    expect(await h.db.consentRecord.count({ where: { leadId: lead.id } })).toBe(0);

    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.import.complete', targetId: id } });
    expect(audit.summary).toMatchObject({ rowCount: 450, accepted: 446, duplicates: 1, rejected: 3, notes: 3 });
    expect(JSON.stringify(audit.summary)).not.toContain('Chunk Shop');

    const view = await getLeadImportView(owner, id, { storageDir: h.storageDir });
    expect(view.import.counts).toEqual({ accepted: 446, duplicates: 1, review: 0, rejected: 3, consentRecorded: 0, processed: 450 });
    expect(view.preview).toBeNull();
  });

  it('a file imported again comes back as duplicates', async () => {
    const rows = businessRows(3, 'Twice Shop', 5_000);
    const first = await previewOf(rows, 'job-twice-0001');
    await confirmLeadImport(first.owner, first.id, { mapping: MAP }, { storageDir: h.storageDir });
    await h.drain();
    const second = await previewOf(rows, 'job-twice-0002');
    await confirmLeadImport(second.owner, second.id, { mapping: MAP }, { storageDir: h.storageDir });
    await h.drain();
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: 'SUCCEEDED', accepted: 0, duplicates: 3 });
  });

  it('a missing rows file fails the import with a code and an audit', async () => {
    const { owner, id } = await previewOf(businessRows(2, 'Missing File', 6_000), 'job-missing-0001');
    await confirmLeadImport(owner, id, { mapping: MAP }, { storageDir: h.storageDir });
    const row = await h.db.leadImport.findUniqueOrThrow({ where: { id } });
    fs.rmSync(path.join(h.storageDir, row.storagePath!));
    await h.drain();
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'FAILED', storagePath: null, accepted: 0 });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.import.failed', targetId: id } });
    expect(audit).toMatchObject({ result: 'FAILED', summary: { errorCode: 'ROWS_FILE_MISSING' } });
  });

  it('an import ended between chunks (lead:erase) ingests nothing more', async () => {
    const { owner, id } = await previewOf(businessRows(250, 'Erase Run', 7_000), 'job-erase-0001');
    await confirmLeadImport(owner, id, { mapping: MAP }, { storageDir: h.storageDir });
    // Chunk 0 only: the next chunk job is queued behind it.
    expect(await h.worker.tick()).toBe('ran');
    const afterFirst = await h.db.leadImport.findUniqueOrThrow({ where: { id } });
    expect(afterFirst).toMatchObject({ status: 'RUNNING', accepted: 200 });
    const firstLead = await h.db.leadSourceRecord.findFirstOrThrow({ where: { source: 'FILE_IMPORT', externalId: `import:${id}:row:2` } });

    const result = await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: firstLead.leadId!, reason: 'DPDP erasure during import', contactKeyPepper: h.pepper, storageDir: h.storageDir, correlationId: 'req_erase_import' });
    expect(result.importsEnded).toBeGreaterThanOrEqual(1);
    await h.drain();
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'FAILED', storagePath: null, accepted: 200 });
    // Chunk 0's rows minus the erased person's own source record; nothing from chunk 1.
    expect(await h.db.leadSourceRecord.count({ where: { source: 'FILE_IMPORT', externalId: { startsWith: `import:${id}:` } } })).toBe(199);
    expect(await h.db.leadSourceRecord.count({ where: { source: 'FILE_IMPORT', externalId: `import:${id}:row:202` } })).toBe(0);
    expect(fs.existsSync(path.join(h.storageDir, afterFirst.storagePath!))).toBe(false);
  });

  it('re-checks the import right before ingesting a chunk', async () => {
    const { owner, id } = await previewOf(businessRows(220, 'Recheck Run', 8_000), 'job-recheck-0001');
    await confirmLeadImport(owner, id, { mapping: MAP }, { storageDir: h.storageDir });
    expect(await h.worker.tick()).toBe('ran');
    // Ended while the next chunk waits, but its job was not cancelled.
    await h.db.leadImport.update({ where: { id }, data: { status: 'FAILED' } });
    await h.drain();
    expect(await h.db.leadSourceRecord.count({ where: { source: 'FILE_IMPORT', externalId: { startsWith: `import:${id}:` } } })).toBe(200);
    expect(await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `leads.import:${id}:1` } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'FAILED', accepted: 200 });
  });
});

describe('leads.importPurge', () => {
  it('expires an unconfirmed upload at its expiry and deletes its rows; a queued import is left to finish', async () => {
    const preview = await previewOf(businessRows(2, 'Purge Me', 9_000), 'purge-preview-0001');
    const queued = await previewOf(businessRows(2, 'Purge Later', 9_100), 'purge-queued-0001');
    await confirmLeadImport(queued.owner, queued.id, { mapping: MAP }, { storageDir: h.storageDir });
    const before = await h.db.leadImport.findUniqueOrThrow({ where: { id: preview.id } });
    const full = path.join(h.storageDir, before.storagePath!);
    expect(fs.existsSync(full)).toBe(true);

    // Early: the purge waits for the expiry.
    const purgeJob = await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `leads.importPurge:${preview.id}` } });
    await h.db.job.update({ where: { id: purgeJob.id }, data: { runAt: h.clock.now() } });
    // The queued import is held so its purge meets it in progress.
    const queuedChunk = await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `leads.import:${queued.id}:0` } });
    await h.db.job.update({ where: { id: queuedChunk.id }, data: { runAt: new Date(h.clock.now().getTime() + 10 * DAY) } });
    await h.drain();
    expect(await h.db.leadImport.findUniqueOrThrow({ where: { id: preview.id } })).toMatchObject({ status: 'PREVIEW' });
    expect(fs.existsSync(full)).toBe(true);

    const saved = h.clock.now();
    h.clock.set(before.expiresAt);
    try {
      await h.drain();
      expect(await h.db.leadImport.findUniqueOrThrow({ where: { id: preview.id } })).toMatchObject({ status: 'EXPIRED', storagePath: null });
      expect(fs.existsSync(full)).toBe(false);
      expect(await h.db.auditEvent.count({ where: { action: 'lead.import.expire', targetId: preview.id } })).toBe(1);
      const queuedRow = await h.db.leadImport.findUniqueOrThrow({ where: { id: queued.id } });
      expect(queuedRow.status).toBe('QUEUED');
      expect(fs.existsSync(path.join(h.storageDir, queuedRow.storagePath!))).toBe(true);
      const queuedPurge = await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `leads.importPurge:${queued.id}` } });
      expect(queuedPurge.status).toBe('QUEUED');
      expect(queuedPurge.runAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
    } finally {
      h.clock.set(saved);
      await h.db.job.update({ where: { id: queuedChunk.id }, data: { runAt: h.clock.now() } });
      await h.drain();
    }
  });
});
