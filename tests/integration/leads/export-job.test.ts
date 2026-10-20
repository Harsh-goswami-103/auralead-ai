// T26 (plan §11 M4, §9 XSS row): the leads CSV export is a job. A request needs `leads.export`, is
// idempotent per request key and audited without the search text (it may hold a name or phone).
// The `leads.export` job writes the file (same filters and order as the list, formula cells
// escaped, Devanagari intact) under STORAGE_DIR/exports, records its sha256, marks it READY for
// 24 hours, audits it and schedules `leads.exportPurge` at the expiry. Only the requester can
// download it, every download is audited, an expired export answers 410, and the purge deletes the
// file. The routes run the same rules over HTTP with a CSV attachment response.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as downloadRoute } from '@/app/api/app/leads/exports/[exportId]/download/route';
import { GET as listRoute, POST as requestRoute } from '@/app/api/app/leads/exports/route';
import { createLogger } from '@/lib/logger';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { createLeadExportJob, createLeadExportPurgeJob, LEAD_EXPORT_JOB, LEAD_EXPORT_PURGE_JOB } from '@/server/jobs/handlers/lead-export';
import { buildJobRegistry } from '@/server/jobs/registry';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { getLeadExportDownload, listLeadExports, requestLeadExport } from '@/server/services/leads/export';
import type { AppConfig } from '@/lib/config';
import { seedId } from '../../../prisma/seed/ids';
import { createWorker, type Worker } from '../../../worker/worker';
import { makeRequest, testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { createQuoteHarness, DAY, makeLeads, ownerCtx, userCtx, WS_A, type QuoteHarness } from './support';

let h: QuoteHarness;
let storageDir: string;
let config: AppConfig;
let worker: Worker;

const HOSTILE = '=HYPERLINK("http://evil.example","Click")';

beforeAll(async () => {
  h = await createQuoteHarness('export-job');
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auralead-export-job-'));
  config = testConfig('demo', { STORAGE_DIR: storageDir });
  useRuntime(h.db, config, h.clock);
  worker = createWorker(
    {
      db: h.db,
      clock: h.clock,
      registry: buildJobRegistry([
        createLeadExportJob({ storageDir: () => storageDir, mode: () => 'demo' }),
        createLeadExportPurgeJob({ storageDir: () => storageDir, mode: () => 'demo' }),
      ]),
      logger: createLogger({ level: 'silent' }),
      mode: 'demo',
      version: 'test',
      random: () => 0,
    },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  await makeLeads(h.db, WS_A, [
    { name: HOSTILE, stage: 'NEW', phone: '+919810012345', city: 'Gurugram, Haryana' },
    { name: 'राहुल शर्मा', stage: 'NEW', email: 'rahul@example.test', score: 64 },
    { name: 'Export Replied', stage: 'REPLIED' },
    { name: 'Export Third', stage: 'NEW' },
  ]);
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
  fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function drain(): Promise<void> {
  while ((await worker.tick()) === 'ran');
}

describe('requesting an export', () => {
  it('is audited without the search text, idempotent per request key, and needs leads.export', async () => {
    const owner = await ownerCtx(h);
    const first = await requestLeadExport(owner, { requestKey: 'export-key-0001', filters: { stage: 'NEW', q: 'राहुल', sort: 'newest' } });
    expect(first.created).toBe(true);
    expect(first.export).toMatchObject({ status: 'QUEUED', effectiveStatus: 'QUEUED', filters: { stage: 'NEW', q: 'राहुल', sort: 'newest' }, rowCount: null });
    const again = await requestLeadExport(owner, { requestKey: 'export-key-0001', filters: { stage: 'NEW', q: 'राहुल', sort: 'newest' } });
    expect(again).toMatchObject({ created: false, export: { id: first.export.id } });

    const jobs = await h.db.job.findMany({ where: { type: LEAD_EXPORT_JOB } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ workspaceId: WS_A, idempotencyKey: `leads.export:${first.export.id}`, status: 'QUEUED' });
    expect(jobs[0]!.payload).toEqual({ exportId: first.export.id });

    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.export.request', targetId: first.export.id } });
    expect(audit).toMatchObject({ workspaceId: WS_A, actorUserId: seedId('user', 'owner'), result: 'SUCCESS' });
    expect(audit.summary).toMatchObject({ filters: { stage: 'NEW', sort: 'newest', search: true } });
    expect(JSON.stringify(audit.summary)).not.toContain('राहुल');
    expect(await h.db.auditEvent.count({ where: { action: 'lead.export.request' } })).toBe(1);

    for (const [key, slug] of [
      ['pooja', undefined],
      ['neha', 'ironpulse-fitness'],
      ['employee', 'kesari-crafts'],
    ] as const) {
      const ctx = await userCtx(h.db, h.clock, key, slug);
      await expect(requestLeadExport(ctx, { requestKey: `export-denied-${key}`, filters: { sort: 'newest' } })).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe('the export job', () => {
  it('writes the CSV with escaped cells, marks it READY for 24 hours and schedules the purge', async () => {
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'export-key-0002', filters: { stage: 'NEW', sort: 'name' } });
    await drain();

    const row = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
    const now = h.clock.now();
    expect(row).toMatchObject({ status: 'READY', rowCount: 3, truncated: false, path: `exports/${WS_A}/${requested.id}.csv` });
    expect(row.completedAt?.toISOString()).toBe(now.toISOString());
    expect(row.expiresAt?.toISOString()).toBe(new Date(now.getTime() + DAY).toISOString());

    const bytes = fs.readFileSync(path.join(storageDir, row.path!));
    expect(bytes.length).toBe(row.bytes);
    const text = bytes.toString('utf8');
    expect(text.startsWith('﻿Name,Stage,Score,Source,Phone,Email')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    // Header, the 3 NEW leads (name order), and the empty string after the last CRLF.
    expect(lines).toHaveLength(5);
    expect(text).toContain('"\'=HYPERLINK(""http://evil.example"",""Click"")"');
    expect(text).toContain("'+919810012345");
    expect(text).toContain('"Gurugram, Haryana"');
    expect(text).toContain('राहुल शर्मा,New,64,');
    expect(text).not.toContain('Export Replied');

    const ready = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.export.ready', targetId: requested.id } });
    expect(ready.summary).toMatchObject({ rowCount: 3, truncated: false });
    expect(ready.actorKind).toBe('WORKER');

    const purge = await h.db.job.findFirstOrThrow({ where: { type: LEAD_EXPORT_PURGE_JOB, idempotencyKey: `leads.exportPurge:${requested.id}` } });
    expect(purge).toMatchObject({ status: 'QUEUED', workspaceId: WS_A });
    expect(purge.runAt.toISOString()).toBe(row.expiresAt!.toISOString());
  });

  it('applies the same search as the list (Devanagari) and leaves merged leads out', async () => {
    const [target] = await makeLeads(h.db, WS_A, [{ name: 'Export Merge Target', stage: 'CONTACTED' }]);
    await makeLeads(h.db, WS_A, [{ name: 'Export Merge Source', stage: 'CONTACTED', mergedInto: target!.id }]);
    const owner = await ownerCtx(h);
    const devanagari = await requestLeadExport(owner, { requestKey: 'export-key-0003', filters: { q: 'शर्मा', sort: 'newest' } });
    const contacted = await requestLeadExport(owner, { requestKey: 'export-key-0004', filters: { stage: 'CONTACTED', sort: 'newest' } });
    await drain();
    const a = await h.db.leadExport.findUniqueOrThrow({ where: { id: devanagari.export.id } });
    const b = await h.db.leadExport.findUniqueOrThrow({ where: { id: contacted.export.id } });
    expect(a.rowCount).toBe(1);
    expect(b.rowCount).toBe(1);
    expect(fs.readFileSync(path.join(storageDir, b.path!), 'utf8')).not.toContain('Export Merge Source');
  });

  it('cuts the file at the row cap and says so', async () => {
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'export-key-0005', filters: { sort: 'newest' } });
    const capped = createWorker(
      {
        db: h.db,
        clock: h.clock,
        registry: buildJobRegistry([createLeadExportJob({ storageDir: () => storageDir, mode: () => 'demo', rowCap: 2 })]),
        logger: createLogger({ level: 'silent' }),
        mode: 'demo',
        version: 'test',
        random: () => 0,
      },
      { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
    );
    while ((await capped.tick()) === 'ran');
    expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'READY', rowCount: 2, truncated: true });
  });
});

describe('downloading', () => {
  it('only the requester can download, each download is audited, and after 24 hours it is gone', async () => {
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'export-key-0006', filters: { sort: 'newest' } });
    await expect(getLeadExportDownload(owner, requested.id, { storageDir })).rejects.toMatchObject({ status: 409, code: 'EXPORT_NOT_READY' });
    await drain();

    const file = await getLeadExportDownload(owner, requested.id, { storageDir });
    expect(file.fileName).toMatch(/^leads-smile-avenue-dental-\d{8}-\d{4}\.csv$/);
    expect(file.bytes.toString('utf8').startsWith('﻿Name,')).toBe(true);
    const row = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
    expect(row.downloadCount).toBe(1);
    expect(await h.db.auditEvent.count({ where: { action: 'lead.export.download', targetId: requested.id } })).toBe(1);
    expect((await listLeadExports(owner)).map((e) => e.id)).toContain(requested.id);

    // Another person of the same workspace (with leads.export) and another workspace: 404.
    const operator = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    await expect(getLeadExportDownload(operator, requested.id, { storageDir })).rejects.toMatchObject({ status: 404 });
    expect((await listLeadExports(operator)).map((e) => e.id)).not.toContain(requested.id);
    const rohan = await userCtx(h.db, h.clock, 'rohan');
    await expect(getLeadExportDownload(rohan, requested.id, { storageDir })).rejects.toMatchObject({ status: 404 });

    // A tampered file is never served.
    const full = path.join(storageDir, row.path!);
    const original = fs.readFileSync(full);
    fs.writeFileSync(full, Buffer.concat([original, Buffer.from('x')]));
    await expect(getLeadExportDownload(owner, requested.id, { storageDir })).rejects.toMatchObject({ status: 500 });
    fs.writeFileSync(full, original);

    const saved = h.clock.now();
    h.clock.set(new Date(row.expiresAt!.getTime()));
    try {
      await expect(getLeadExportDownload(owner, requested.id, { storageDir })).rejects.toMatchObject({ status: 410, code: 'EXPORT_EXPIRED' });
      expect((await listLeadExports(owner)).find((e) => e.id === requested.id)?.effectiveStatus).toBe('EXPIRED');
      await drain();
      const purged = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
      expect(purged.status).toBe('EXPIRED');
      expect(purged.purgedAt?.toISOString()).toBe(row.expiresAt!.toISOString());
      expect(fs.existsSync(full)).toBe(false);
      await expect(getLeadExportDownload(owner, requested.id, { storageDir })).rejects.toMatchObject({ status: 410 });
      expect(await h.db.auditEvent.count({ where: { action: 'lead.export.expire', targetId: requested.id } })).toBe(1);
    } finally {
      h.clock.set(saved);
    }
  });
});

describe('lead erasure', () => {
  it('ends every ready export of the workspace and deletes its file, since it may hold the erased row', async () => {
    const [person] = await makeLeads(h.db, WS_A, [{ name: 'Erase Me Export', stage: 'NEW', email: 'erase.me@example.test' }]);
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'export-key-erase', filters: { q: 'erase me', sort: 'newest' } });
    await drain();
    const ready = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
    expect(ready).toMatchObject({ status: 'READY', rowCount: 1 });
    const full = path.join(storageDir, ready.path!);
    expect(fs.readFileSync(full, 'utf8')).toContain('erase.me@example.test');

    const result = await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: person!.id, reason: 'DPDP erasure request', contactKeyPepper: config.secrets.suppressionPepper!, storageDir, correlationId: 'req_erase_export' });
    expect(result.exportsExpired).toBeGreaterThanOrEqual(1);
    expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'EXPIRED', errorCode: 'LEAD_ERASED' });
    expect(fs.existsSync(full)).toBe(false);
    await expect(getLeadExportDownload(owner, requested.id, { storageDir })).rejects.toMatchObject({ status: 410 });
  });
});

describe('routes', () => {
  async function auth(key: string) {
    const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
    const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'e', userAgent: 'vitest', now: h.clock.now() });
    return { cookie: `${sessionCookieName(config)}=${token}`, csrf: csrfTokenForSession(config, session.id) };
  }

  it('POST requests, GET lists, and the download is a CSV attachment', async () => {
    const owner = await auth('owner');
    const res = await requestRoute(makeRequest('/api/app/leads/exports', { body: { requestKey: 'export-route-0001', filters: { stage: 'NEW' } }, cookie: owner.cookie, csrf: owner.csrf }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const { export: created } = (await res.json()) as { export: { id: string; status: string } };
    expect(created.status).toBe('QUEUED');
    await drain();

    const list = await listRoute(makeRequest('/api/app/leads/exports', { cookie: owner.cookie }), { params: Promise.resolve({}) });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { exports: Array<{ id: string; status: string }> };
    expect(listed.exports.find((e) => e.id === created.id)?.status).toBe('READY');

    const dl = await downloadRoute(makeRequest(`/api/app/leads/exports/${created.id}/download`, { cookie: owner.cookie }), { params: Promise.resolve({ exportId: created.id }) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="leads-smile-avenue-dental-\d{8}-\d{4}\.csv"$/);
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('cache-control')).toBe('no-store');
    // The UTF-8 BOM bytes, then the header (Response.text() would strip the BOM).
    const body = Buffer.from(await dl.arrayBuffer());
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(body.subarray(3, 8).toString('utf8')).toBe('Name,');

    const member = await auth('pooja');
    const denied = await requestRoute(makeRequest('/api/app/leads/exports', { body: { requestKey: 'export-route-0002' }, cookie: member.cookie, csrf: member.csrf }), { params: Promise.resolve({}) });
    expect(denied.status).toBe(403);
    // Another workspace's owner (who holds leads.export there) cannot see this export at all.
    const otherOwner = await auth('rohan');
    const foreign = await downloadRoute(makeRequest(`/api/app/leads/exports/${created.id}/download`, { cookie: otherOwner.cookie }), { params: Promise.resolve({ exportId: created.id }) });
    expect(foreign.status).toBe(404);
  });
});
