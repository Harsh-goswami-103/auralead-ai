// ADR-120 (slice F2): the lead export writes CSV or an Excel workbook. `format: 'xlsx'` gives one
// sheet "Leads" with the CSV's header and rows (LEAD_CSV_HEADER / leadCsvRow), every text cell an
// inline string that a spreadsheet never evaluates (a formula-like name stays text, without the
// CSV's apostrophe), Devanagari intact. The stored file is exports/<ws>/<id>.xlsx; the download is
// typed as a workbook with an .xlsx name. A CSV and an Excel export of the same filters are two
// exports; the same format reuses the one in flight. lead:erase ends an xlsx export and deletes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as downloadRoute } from '@/app/api/app/leads/exports/[exportId]/download/route';
import { POST as requestRoute } from '@/app/api/app/leads/exports/route';
import type { AppConfig } from '@/lib/config';
import { readTable } from '@/lib/spreadsheet';
import { createLeadExportJob, createLeadExportPurgeJob } from '@/server/jobs/handlers/lead-export';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { LEAD_CSV_HEADER } from '@/server/services/leads/csv';
import { getLeadExportDownload, listLeadExports, requestLeadExport } from '@/server/services/leads/export';
import { makeRequest, testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { createQuoteHarness, drain, makeLeads, ownerCtx, workerWith, WS_A, type QuoteHarness } from '../leads/support';
import { authAs } from './support';

let h: QuoteHarness;
let storageDir: string;
let config: AppConfig;
let run: () => Promise<void>;

const HOSTILE = '=HYPERLINK("http://evil.example","Click")';

beforeAll(async () => {
  h = await createQuoteHarness('export-xlsx');
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auralead-export-xlsx-'));
  config = testConfig('demo', { STORAGE_DIR: storageDir });
  useRuntime(h.db, config, h.clock);
  const worker = workerWith(h, [createLeadExportJob({ storageDir: () => storageDir, mode: () => 'demo' }), createLeadExportPurgeJob({ storageDir: () => storageDir, mode: () => 'demo' })]);
  run = () => drain(worker);
  await makeLeads(h.db, WS_A, [
    { name: HOSTILE, stage: 'NEW', phone: '+919810012345', city: 'Gurugram, Haryana', rating: 46, reviewCount: 120 },
    { name: 'राहुल शर्मा', stage: 'NEW', email: 'rahul@example.test', score: 64 },
    { name: 'Xlsx Replied', stage: 'REPLIED' },
  ]);
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
  fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('an Excel export', () => {
  it('writes the same header and rows as one sheet, text never a formula', async () => {
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'xlsx-key-0001', filters: { stage: 'NEW', sort: 'name' }, format: 'xlsx' });
    expect(requested.format).toBe('xlsx');
    await run();
    const row = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
    expect(row).toMatchObject({ status: 'READY', format: 'xlsx', rowCount: 2, path: `exports/${WS_A}/${requested.id}.xlsx` });
    const bytes = fs.readFileSync(path.join(storageDir, row.path!));
    expect(bytes.length).toBe(row.bytes);

    const table = readTable(new Uint8Array(bytes), 'export.xlsx');
    expect(table.sheetName).toBe('Leads');
    expect(table.rows[0]).toEqual(LEAD_CSV_HEADER);
    const byName = new Map(table.rows.slice(1).map((r) => [r[0], r]));
    const hostile = byName.get(HOSTILE)!;
    expect(hostile[4]).toBe('+919810012345');
    expect(hostile[8]).toBe('Gurugram, Haryana');
    expect(hostile[11]).toBe('4.6');
    expect(hostile[12]).toBe('120');
    expect(byName.get('राहुल शर्मा')![2]).toBe('64');
    expect(byName.has('Xlsx Replied')).toBe(false);
    // Inline strings only: no formula element anywhere in the sheet.
    const sheet = strFromU8(unzipSync(new Uint8Array(bytes))['xl/worksheets/sheet1.xml']!);
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('t="inlineStr"');

    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.export.request', targetId: requested.id } });
    expect(audit.summary).toMatchObject({ format: 'xlsx' });
    expect((await listLeadExports(owner)).find((e) => e.id === requested.id)?.format).toBe('xlsx');

    const file = await getLeadExportDownload(owner, requested.id, { storageDir });
    expect(file.fileName).toMatch(/^leads-smile-avenue-dental-\d{8}-\d{4}\.xlsx$/);
    expect(file.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('a CSV and an Excel export of the same filters are two exports; the same format reuses the one in flight', async () => {
    await h.db.leadExport.updateMany({ where: { status: { in: ['QUEUED', 'READY'] } }, data: { status: 'EXPIRED' } });
    const owner = await ownerCtx(h);
    const csv = await requestLeadExport(owner, { requestKey: 'xlsx-key-0002', filters: { stage: 'REPLIED', sort: 'newest' } });
    const xlsx = await requestLeadExport(owner, { requestKey: 'xlsx-key-0003', filters: { stage: 'REPLIED', sort: 'newest' }, format: 'xlsx' });
    expect(csv.export.format).toBe('csv');
    expect(xlsx).toMatchObject({ created: true, export: { format: 'xlsx' } });
    expect(xlsx.export.id).not.toBe(csv.export.id);
    const again = await requestLeadExport(owner, { requestKey: 'xlsx-key-0004', filters: { stage: 'REPLIED', sort: 'newest' }, format: 'xlsx' });
    expect(again).toMatchObject({ created: false, export: { id: xlsx.export.id } });
    await run();
    expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: csv.export.id } })).toMatchObject({ path: `exports/${WS_A}/${csv.export.id}.csv` });
  });

  it('lead:erase ends an Excel export and deletes its file', async () => {
    await h.db.leadExport.updateMany({ where: { status: { in: ['QUEUED', 'READY'] } }, data: { status: 'EXPIRED' } });
    const [person] = await makeLeads(h.db, WS_A, [{ name: 'Erase Me Xlsx', stage: 'NEW', email: 'erase.xlsx@example.test' }]);
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'xlsx-key-erase', filters: { q: 'erase me xlsx', sort: 'newest' }, format: 'xlsx' });
    await run();
    const ready = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
    const full = path.join(storageDir, ready.path!);
    expect(ready.status).toBe('READY');
    expect(readTable(new Uint8Array(fs.readFileSync(full)), 'x.xlsx').rows.flat()).toContain('erase.xlsx@example.test');

    await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: person!.id, reason: 'DPDP erasure request', contactKeyPepper: config.secrets.suppressionPepper!, storageDir, correlationId: 'req_erase_xlsx' });
    expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'EXPIRED', errorCode: 'LEAD_ERASED' });
    expect(fs.existsSync(full)).toBe(false);
  });
});

describe('routes', () => {
  it('POST takes the format, the download is a workbook attachment, and an unknown format is 400', async () => {
    await h.db.leadExport.updateMany({ where: { status: { in: ['QUEUED', 'READY'] } }, data: { status: 'EXPIRED' } });
    const owner = await authAs({ db: h.db, clock: h.clock, config }, 'owner');
    const res = await requestRoute(makeRequest('/api/app/leads/exports', { body: { requestKey: 'xlsx-route-0001', filters: { stage: 'NEW' }, format: 'xlsx' }, cookie: owner.cookie, csrf: owner.csrf }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const { export: created } = (await res.json()) as { export: { id: string; format: string } };
    expect(created.format).toBe('xlsx');
    await run();
    const dl = await downloadRoute(makeRequest(`/api/app/leads/exports/${created.id}/download`, { cookie: owner.cookie }), { params: Promise.resolve({ exportId: created.id }) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="leads-smile-avenue-dental-\d{8}-\d{4}\.xlsx"$/);
    const body = new Uint8Array(await dl.arrayBuffer());
    expect([...body.subarray(0, 2)]).toEqual([0x50, 0x4b]);

    const bad = await requestRoute(makeRequest('/api/app/leads/exports', { body: { requestKey: 'xlsx-route-0002', format: 'pdf' }, cookie: owner.cookie, csrf: owner.csrf }), { params: Promise.resolve({}) });
    expect(bad.status).toBe(400);
  });
});
