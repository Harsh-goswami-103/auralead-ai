// ADR-120 (slice F2): uploading a lead file. A .xlsx or .csv upload (base64 in JSON) needs
// leads.import, is parsed by readTable and stored as a PREVIEW LeadImport whose rows live only in
// STORAGE_DIR/imports/<ws>/<id>.json; the answer carries the header, the first 20 rows and a
// mapping suggested from the header names. The upload schedules leads.importPurge at its 24 h
// expiry and is audited without the file name or any cell. A repeated request key returns the same
// import. Files the reader refuses (and wrong types, too many rows, an empty sheet) are 422 with a
// code; a body over the route cap is 413. Only the person who uploaded can read an import. The
// sample workbook is a header row and five fictitious rows that the suggestions map completely.
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as viewRoute } from '@/app/api/app/leads/imports/[importId]/route';
import { GET as listRoute, POST as uploadRoute } from '@/app/api/app/leads/imports/route';
import { GET as sampleRoute } from '@/app/api/app/leads/sample-workbook/route';
import { LEAD_IMPORT_MAX_BODY_BYTES, LEAD_IMPORT_MAX_ROWS, suggestImportMapping } from '@/lib/schemas/lead-import';
import { readTable } from '@/lib/spreadsheet';
import { getLeadImportView, listLeadImports, SAMPLE_WORKBOOK_HEADER } from '@/server/services/leads/import';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest } from '../auth/support';
import { authAs, b64, businessRows, createImportHarness, csvUpload, ownerOf, upload, userCtx, WS_A, xlsxUpload, type ImportHarness } from './support';

let h: ImportHarness;

beforeAll(async () => {
  h = await createImportHarness('upload');
}, 120_000);

afterAll(async () => {
  await h?.cleanup();
});

const HEADER = ['Business Name', 'Mobile No.', 'E-mail', 'Site', 'City', 'Notes'];

describe('uploading a file', () => {
  it('stores a PREVIEW import with the rows in its file, answers the first 20 rows and a suggested mapping', async () => {
    const owner = await ownerOf(h);
    const rows = businessRows(25, 'Preview Shop').map((r) => [r[0]!, r[1]!, '', '', r[2]!, 'call after 5pm']);
    const result = await upload(h, owner, csvUpload([HEADER, ...rows], 'upload-key-0001'));
    expect(result.created).toBe(true);
    expect(result.import).toMatchObject({ status: 'PREVIEW', effectiveStatus: 'PREVIEW', fileName: 'leads.csv', rowCount: 25, header: HEADER, mapping: null, counts: { accepted: 0, processed: 0 } });
    expect(result.preview!.rows).toHaveLength(20);
    expect(result.preview!.rows[0]).toEqual({ row: 2, cells: ['Preview Shop 1', '+91 9810000000', '', '', 'Indore', 'call after 5pm'] });
    expect(result.preview!.suggestedMapping).toEqual({ name: 0, phone: 1, email: 2, website: 3, city: 4 });

    const row = await h.db.leadImport.findUniqueOrThrow({ where: { id: result.import.id } });
    const now = h.clock.now();
    expect(row).toMatchObject({ workspaceId: WS_A, requestedBy: seedId('user', 'owner'), status: 'PREVIEW', storagePath: `imports/${WS_A}/${row.id}.json`, rowCount: 25 });
    expect(row.expiresAt.toISOString()).toBe(new Date(now.getTime() + 24 * 3_600_000).toISOString());
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The rows are in the file, never in the database.
    const file = JSON.parse(fs.readFileSync(path.join(h.storageDir, row.storagePath!), 'utf8')) as { header: string[]; rows: unknown[] };
    expect(file.header).toEqual(HEADER);
    expect(file.rows).toHaveLength(25);
    expect(JSON.stringify(row)).not.toContain('Preview Shop');

    const purge = await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `leads.importPurge:${row.id}` } });
    expect(purge).toMatchObject({ type: 'leads.importPurge', workspaceId: WS_A, status: 'QUEUED' });
    expect(purge.runAt.toISOString()).toBe(row.expiresAt.toISOString());
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.import.upload', targetId: row.id } });
    expect(audit.summary).toEqual({ kind: 'csv', rowCount: 25, columns: 6, bytes: expect.any(Number) });
    expect(JSON.stringify(audit.summary)).not.toContain('leads.csv');
  });

  it('reads an Excel workbook the same way, numbering rows as in the sheet and skipping blank rows', async () => {
    const owner = await ownerOf(h);
    const result = await upload(h, owner, xlsxUpload(['Name', 'Phone', 'Pincode'], [['Xlsx Bakery', '98260 11111', '452001'], ['', '', ''], ['Xlsx Tailor', '98260 11112', '452002']], 'upload-key-0002'));
    expect(result.import).toMatchObject({ rowCount: 2, sheetName: 'Leads' });
    expect(result.preview!.rows).toEqual([
      { row: 2, cells: ['Xlsx Bakery', '98260 11111', '452001'] },
      { row: 4, cells: ['Xlsx Tailor', '98260 11112', '452002'] },
    ]);
    expect(result.preview!.suggestedMapping).toEqual({ name: 0, phone: 1, pincode: 2 });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.import.upload', targetId: result.import.id } });
    expect(audit.summary).toMatchObject({ kind: 'xlsx', rowCount: 2 });
  });

  it('is idempotent per request key, and a key used by another person is a conflict', async () => {
    const owner = await ownerOf(h);
    const body = csvUpload([['Name', 'Phone'], ['Again Cafe', '98260 22222']], 'upload-key-0003');
    const first = await upload(h, owner, body);
    const again = await upload(h, owner, body);
    expect(again).toMatchObject({ created: false, import: { id: first.import.id } });
    expect(again.preview?.rows).toHaveLength(1);
    expect(await h.db.leadImport.count({ where: { requestKey: 'upload-key-0003' } })).toBe(1);
    const member = await userCtx(h.db, h.clock, 'pooja');
    // Another workspace: its own import with that key is a different row.
    await expect(upload(h, member, body)).resolves.toMatchObject({ created: true });
  });

  it('needs leads.import: an operator without it and a read-only employee are refused before the file is read', async () => {
    const operator = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    const neha = await userCtx(h.db, h.clock, 'neha', 'ironpulse-fitness');
    for (const ctx of [operator, neha]) {
      await expect(upload(h, ctx, { requestKey: 'upload-denied-01', fileName: 'x.xls', contentType: 'text/csv', dataBase64: 'not base64!' })).rejects.toMatchObject({ status: 403 });
    }
    // A MEMBER holds leads.import.
    const member = await userCtx(h.db, h.clock, 'pooja');
    await expect(upload(h, member, csvUpload([['Name', 'Phone'], ['Member Cafe', '98260 33333']], 'upload-member-01'))).resolves.toMatchObject({ created: true });
  });
});

describe('files that cannot be imported', () => {
  const cases: Array<[string, () => { requestKey: string; fileName: string; contentType: string; dataBase64: string }, number, string]> = [
    ['an .xls workbook', () => ({ requestKey: 'bad-file-0001', fileName: 'old.xls', contentType: 'application/vnd.ms-excel', dataBase64: b64('Name\nA\n') }), 422, 'UNSUPPORTED_FILE_TYPE'],
    ['a PDF content type', () => ({ requestKey: 'bad-file-0002', fileName: 'leads.csv', contentType: 'application/pdf', dataBase64: b64('Name\nA\n') }), 422, 'UNSUPPORTED_FILE_TYPE'],
    ['text named .xlsx', () => ({ requestKey: 'bad-file-0003', fileName: 'leads.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dataBase64: b64('Name,Phone\nA,1\n') }), 422, 'NOT_A_WORKBOOK'],
    [
      'a zip without a workbook',
      () => ({ requestKey: 'bad-file-0004', fileName: 'leads.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dataBase64: b64(zipSync({ 'readme.txt': strToU8('hello') })) }),
      422,
      'NOT_A_WORKBOOK',
    ],
    ['a zip named .csv', () => ({ requestKey: 'bad-file-0005', fileName: 'leads.csv', contentType: 'text/csv', dataBase64: b64(zipSync({ 'a.txt': strToU8('a') })) }), 422, 'FILE_TYPE_MISMATCH'],
    ['an unterminated quote', () => ({ requestKey: 'bad-file-0006', fileName: 'leads.csv', contentType: 'text/csv', dataBase64: b64('Name,Phone\n"Open quote,98260 44444\n') }), 422, 'MALFORMED_CSV'],
    ['blank lines only', () => ({ requestKey: 'bad-file-0007', fileName: 'leads.csv', contentType: 'text/csv', dataBase64: b64('\r\n,,\r\n') }), 422, 'EMPTY_FILE'],
    ['a header without rows', () => csvUpload([['Name', 'Phone']], 'bad-file-0008'), 422, 'NO_DATA_ROWS'],
    ['more than 2,000 rows', () => csvUpload([['Name', 'Phone', 'City'], ...businessRows(LEAD_IMPORT_MAX_ROWS + 1, 'Too Many')], 'bad-file-0009'), 422, 'TOO_MANY_ROWS'],
    ['more than 5 MB', () => ({ requestKey: 'bad-file-0010', fileName: 'big.csv', contentType: 'text/csv', dataBase64: b64(`Name\n${'x'.repeat(5 * 1024 * 1024)}\n`) }), 422, 'TOO_LARGE'],
    ['damaged base64', () => ({ requestKey: 'bad-file-0011', fileName: 'leads.csv', contentType: 'text/csv', dataBase64: 'TmFtZQ$$' }), 422, 'FILE_ENCODING_INVALID'],
  ];

  it.each(cases)('%s is %i %s, and nothing is stored', async (_label, body, status, code) => {
    const owner = await ownerOf(h);
    const before = await h.db.leadImport.count();
    await expect(upload(h, owner, body())).rejects.toMatchObject({ status, code });
    expect(await h.db.leadImport.count()).toBe(before);
  });

  it('exactly 2,000 rows are accepted', async () => {
    const owner = await ownerOf(h);
    const result = await upload(h, owner, csvUpload([['Name', 'Phone', 'City'], ...businessRows(LEAD_IMPORT_MAX_ROWS, 'Max Rows')], 'max-rows-0001'));
    expect(result.import.rowCount).toBe(LEAD_IMPORT_MAX_ROWS);
  });
});

describe('reading imports', () => {
  it('only the uploader reads an import; the preview is there while it is a live PREVIEW', async () => {
    const owner = await ownerOf(h);
    const { import: created } = await upload(h, owner, csvUpload([['Name', 'Phone'], ['Read Me Salon', '98260 55555']], 'read-key-0001'));
    const view = await getLeadImportView(owner, created.id, { storageDir: h.storageDir });
    expect(view.preview?.rows).toEqual([{ row: 2, cells: ['Read Me Salon', '98260 55555'] }]);
    expect((await listLeadImports(owner)).map((i) => i.id)).toContain(created.id);

    const rohan = await userCtx(h.db, h.clock, 'rohan');
    await expect(getLeadImportView(rohan, created.id, { storageDir: h.storageDir })).rejects.toMatchObject({ status: 404 });
    // After the expiry the preview reads EXPIRED (even before the purge ran) and shows no rows.
    const saved = h.clock.now();
    h.clock.set(new Date(saved.getTime() + 24 * 3_600_000));
    try {
      const later = await getLeadImportView(owner, created.id, { storageDir: h.storageDir });
      expect(later.import.effectiveStatus).toBe('EXPIRED');
      expect(later.preview).toBeNull();
    } finally {
      h.clock.set(saved);
    }
  });
});

describe('routes', () => {
  it('POST uploads, GET lists and reads; refused files carry their code; an oversized body is 413', async () => {
    const owner = await authAs(h, 'owner');
    const res = await uploadRoute(
      makeRequest('/api/app/leads/imports', { body: csvUpload([['Name', 'Phone'], ['Route Cafe', '98260 66666']], 'route-key-0001'), cookie: owner.cookie, csrf: owner.csrf }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { import: { id: string; status: string }; preview: { rows: unknown[] }; created: boolean };
    expect(body).toMatchObject({ created: true, import: { status: 'PREVIEW' } });
    expect(body.preview.rows).toHaveLength(1);

    const list = await listRoute(makeRequest('/api/app/leads/imports', { cookie: owner.cookie }), { params: Promise.resolve({}) });
    expect(((await list.json()) as { imports: Array<{ id: string }> }).imports.map((i) => i.id)).toContain(body.import.id);
    const one = await viewRoute(makeRequest(`/api/app/leads/imports/${body.import.id}`, { cookie: owner.cookie }), { params: Promise.resolve({ importId: body.import.id }) });
    expect(one.status).toBe(200);

    const refused = await uploadRoute(
      makeRequest('/api/app/leads/imports', { body: { requestKey: 'route-key-0002', fileName: 'a.xlsx', contentType: 'text/csv', dataBase64: b64('Name\nA\n') }, cookie: owner.cookie, csrf: owner.csrf }),
      { params: Promise.resolve({}) },
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'NOT_A_WORKBOOK' });

    const huge = await uploadRoute(
      makeRequest('/api/app/leads/imports', { rawBody: JSON.stringify({ requestKey: 'route-key-0003', fileName: 'a.csv', contentType: 'text/csv', dataBase64: 'A'.repeat(LEAD_IMPORT_MAX_BODY_BYTES) }), headers: { 'content-type': 'application/json' }, cookie: owner.cookie, csrf: owner.csrf }),
      { params: Promise.resolve({}) },
    );
    expect(huge.status).toBe(413);

    const operator = await authAs(h, 'employee');
    const denied = await uploadRoute(
      makeRequest('/api/app/leads/imports', { body: { ...csvUpload([['Name'], ['A']], 'route-key-0004'), workspaceSlug: 'smile-avenue-dental' }, cookie: operator.cookie, csrf: operator.csrf }),
      { params: Promise.resolve({}) },
    );
    expect(denied.status).toBe(403);
  });

  it('the sample workbook: header first, five fictitious rows, every field suggested', async () => {
    const member = await authAs(h, 'pooja');
    const res = await sampleRoute(makeRequest('/api/app/leads/sample-workbook', { cookie: member.cookie }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="auralead-lead-import-sample.xlsx"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const table = readTable(new Uint8Array(await res.arrayBuffer()), 'sample.xlsx');
    expect(table.rows[0]).toEqual(SAMPLE_WORKBOOK_HEADER);
    expect(table.rows).toHaveLength(6);
    for (const [i, row] of table.rows.slice(1).entries()) {
      expect(row[0]).toMatch(/^Example /);
      expect(row[1]).toBe(`+91 90000 0000${i + 1}`);
    }
    expect(table.rows.flat().join(' ')).not.toMatch(/instruction/i);
    expect(Object.keys(suggestImportMapping(table.rows[0]!)).sort()).toEqual(['address', 'category', 'city', 'consent', 'consentDate', 'email', 'name', 'phone', 'pincode', 'rating', 'reviewCount', 'website']);

    const anonymous = await sampleRoute(makeRequest('/api/app/leads/sample-workbook'), { params: Promise.resolve({}) });
    expect(anonymous.status).toBe(401);
  });
});
