// T26 (plan §11 M4, §9 XSS row): the leads CSV export is a job. A request needs `leads.export`, is
// idempotent per request key and audited without the search text (it may hold a name or phone).
// The `leads.export` job writes the file (same filters and order as the list, formula cells
// escaped, Devanagari intact) under STORAGE_DIR/exports, records its sha256, marks it READY for
// 24 hours, audits it and schedules `leads.exportPurge` at the expiry. Only the requester can
// download it, every download is audited, an expired export answers 410, and the purge deletes the
// file. The routes run the same rules over HTTP with a CSV attachment response.
// ADR-73: an identical in-flight request reuses its export, a workspace holds at most 3 active
// exports (409 EXPORT_LIMIT_REACHED), export jobs queue behind sends and PDFs, the search text is
// dropped when an export expires (and never shown for an expired one), an export being built while
// a lead is erased never becomes READY and its file is deleted, and a purge whose file delete keeps
// failing retries, then marks the export EXPIRED with PURGE_FAILED instead of dying at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GET as downloadRoute } from '@/app/api/app/leads/exports/[exportId]/download/route';
import { GET as listRoute, POST as requestRoute } from '@/app/api/app/leads/exports/route';
import { createLogger } from '@/lib/logger';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { createLeadExportJob, createLeadExportPurgeJob, LEAD_EXPORT_JOB, LEAD_EXPORT_PURGE_JOB } from '@/server/jobs/handlers/lead-export';
import { setPauseHandler } from '@/server/testing/pause';
import { buildJobRegistry } from '@/server/jobs/registry';
import { eraseLead } from '@/server/services/admin/lead-erase';
import { getLeadExportDownload, LEAD_EXPORT_ACTIVE_CAP, LEAD_EXPORT_PRIORITY, listLeadExports, requestLeadExport } from '@/server/services/leads/export';
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

/** Ends every active export, so each test starts under the per-workspace cap (test cleanup only). */
async function retireActiveExports(): Promise<void> {
  await h.db.leadExport.updateMany({ where: { status: { in: ['QUEUED', 'READY'] } }, data: { status: 'EXPIRED' } });
}

afterEach(async () => {
  setPauseHandler('job.before-settle', null);
  await retireActiveExports();
});

describe('requesting an export', () => {
  it('is audited without the search text, idempotent per request key, and needs leads.export', async () => {
    const owner = await ownerCtx(h);
    const first = await requestLeadExport(owner, { requestKey: 'export-key-0001', filters: { stage: 'NEW', q: 'राहुल', sort: 'newest' } });
    expect(first.created).toBe(true);
    expect(first.export).toMatchObject({ status: 'QUEUED', effectiveStatus: 'QUEUED', filters: { stage: 'NEW', q: 'राहुल', sort: 'newest' }, rowCount: null });
    const again = await requestLeadExport(owner, { requestKey: 'export-key-0001', filters: { stage: 'NEW', q: 'राहुल', sort: 'newest' } });
    expect(again).toMatchObject({ created: false, export: { id: first.export.id } });
    // The same filters with a new request key (a second click later) reuse the export in flight.
    const same = await requestLeadExport(owner, { requestKey: 'export-key-0001b', filters: { sort: 'newest', q: 'राहुल', stage: 'NEW' } });
    expect(same).toMatchObject({ created: false, export: { id: first.export.id } });

    const jobs = await h.db.job.findMany({ where: { type: LEAD_EXPORT_JOB } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ workspaceId: WS_A, idempotencyKey: `leads.export:${first.export.id}`, status: 'QUEUED', priority: LEAD_EXPORT_PRIORITY });
    // Lower values are claimed first: exports wait behind sends, PDFs and integration checks.
    expect(LEAD_EXPORT_PRIORITY).toBeGreaterThan(5);
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

describe('load limits (ADR-73)', () => {
  it('a workspace holds at most 3 active exports; the 4th is 409 until one expires', async () => {
    const owner = await ownerCtx(h);
    const operator = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    expect(LEAD_EXPORT_ACTIVE_CAP).toBe(3);
    await requestLeadExport(owner, { requestKey: 'export-cap-0001', filters: { stage: 'NEW', sort: 'newest' } });
    await requestLeadExport(owner, { requestKey: 'export-cap-0002', filters: { stage: 'REPLIED', sort: 'newest' } });
    await drain(); // two READY
    await requestLeadExport(operator, { requestKey: 'export-cap-0003', filters: { stage: 'LOST', sort: 'newest' } }); // one QUEUED, another person
    const before = await h.db.leadExport.count();
    await expect(requestLeadExport(owner, { requestKey: 'export-cap-0004', filters: { stage: 'CONTACTED', sort: 'newest' } })).rejects.toMatchObject({
      status: 409,
      code: 'EXPORT_LIMIT_REACHED',
    });
    await expect(requestLeadExport(operator, { requestKey: 'export-cap-0005', filters: { sort: 'score' } })).rejects.toMatchObject({ status: 409, code: 'EXPORT_LIMIT_REACHED' });
    expect(await h.db.leadExport.count()).toBe(before);
    // A repeat of an active one is still answered (reuse, not a new export).
    await expect(requestLeadExport(owner, { requestKey: 'export-cap-0006', filters: { stage: 'NEW', sort: 'newest' } })).resolves.toMatchObject({ created: false });

    const saved = h.clock.now();
    h.clock.set(new Date(saved.getTime() + DAY + 1));
    try {
      // The two READY exports expired (even before their purge ran): room again.
      await expect(requestLeadExport(owner, { requestKey: 'export-cap-0007', filters: { stage: 'CONTACTED', sort: 'newest' } })).resolves.toMatchObject({ created: true });
    } finally {
      h.clock.set(saved);
    }
  });
});

describe('search text retention (ADR-73)', () => {
  it('is dropped when an export expires, and never shown for an expired export', async () => {
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'export-q-0001', filters: { q: '+919810012345', sort: 'newest' } });
    await drain();
    expect((await listLeadExports(owner)).find((e) => e.id === requested.id)?.filters.q).toBe('+919810012345');
    const row = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
    const saved = h.clock.now();
    h.clock.set(new Date(row.expiresAt!.getTime()));
    try {
      const listed = (await listLeadExports(owner)).find((e) => e.id === requested.id)!;
      expect(listed.effectiveStatus).toBe('EXPIRED');
      expect(listed.filters).not.toHaveProperty('q');
      await drain();
      const purged = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
      expect(purged.status).toBe('EXPIRED');
      expect(JSON.stringify(purged.filters)).not.toContain('919810012345');
    } finally {
      h.clock.set(saved);
    }
  });
});

describe('erasure while an export is being built (ADR-73)', () => {
  it('build, erase, complete: the export never becomes READY and the written file is deleted', async () => {
    const [person] = await makeLeads(h.db, WS_A, [{ name: 'Erase While Building', stage: 'NEW', email: 'building@example.test' }]);
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'export-build-0001', filters: { q: 'erase while building', sort: 'newest' } });
    const job = await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `${LEAD_EXPORT_JOB}:${requested.id}` } });
    const full = path.join(storageDir, 'exports', WS_A, `${requested.id}.csv`);
    let builtWithPerson = false;
    setPauseHandler('job.before-settle', async (info) => {
      if (info.jobId !== job.id) return;
      // The handler has written the file; erase the person before its settle runs.
      builtWithPerson = fs.existsSync(full) && fs.readFileSync(full, 'utf8').includes('building@example.test');
      await eraseLead(h.db, h.clock, { workspaceId: WS_A, leadId: person!.id, reason: 'Erasure during export', contactKeyPepper: config.secrets.suppressionPepper!, storageDir, correlationId: 'req_erase_build' });
    });
    await drain();
    expect(builtWithPerson).toBe(true);
    const row = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'LEAD_ERASED', expiresAt: null });
    expect(row.filters).not.toHaveProperty('q');
    expect(fs.existsSync(full)).toBe(false);
    expect(await h.db.job.findFirstOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await h.db.job.count({ where: { idempotencyKey: `${LEAD_EXPORT_PURGE_JOB}:${requested.id}` } })).toBe(0);
    expect(await h.db.auditEvent.count({ where: { action: 'lead.export.ready', targetId: requested.id } })).toBe(0);
    await expect(getLeadExportDownload(owner, requested.id, { storageDir })).rejects.toMatchObject({ status: 409, code: 'EXPORT_FAILED' });
  });
});

describe('purge failures (ADR-73)', () => {
  it('a file that cannot be deleted is retried, then the export is EXPIRED with PURGE_FAILED', async () => {
    const owner = await ownerCtx(h);
    const { export: requested } = await requestLeadExport(owner, { requestKey: 'export-purge-0001', filters: { stage: 'REPLIED', sort: 'newest' } });
    await drain();
    const row = await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } });
    const full = path.join(storageDir, row.path!);
    // Replace the file with a non-empty directory: deleting it fails on every platform.
    fs.rmSync(full, { force: true });
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'keep.txt'), 'x');
    const purge = await h.db.job.findFirstOrThrow({ where: { idempotencyKey: `${LEAD_EXPORT_PURGE_JOB}:${requested.id}` } });

    const saved = h.clock.now();
    h.clock.set(new Date(row.expiresAt!.getTime()));
    try {
      // One attempt runs (other tests' purges due now may run too); the retry is due 1 s later.
      await drain();
      const first = await h.db.job.findUniqueOrThrow({ where: { id: purge.id } });
      expect(first).toMatchObject({ status: 'QUEUED', attempts: 1, lastErrorCode: 'EXPORT_PURGE_FAILED' });
      expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'READY' });
      for (let i = 0; i < 10; i += 1) {
        h.clock.set(new Date(h.clock.now().getTime() + 2_000));
        await drain();
        if ((await h.db.job.findUniqueOrThrow({ where: { id: purge.id } })).status !== 'QUEUED') break;
      }
      const last = await h.db.job.findUniqueOrThrow({ where: { id: purge.id } });
      expect(last.status).toBe('DEAD');
      expect(last.attempts).toBe(last.maxAttempts);
      expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'EXPIRED', errorCode: 'PURGE_FAILED' });
      expect(fs.existsSync(full)).toBe(true);
      await expect(getLeadExportDownload(owner, requested.id, { storageDir })).rejects.toMatchObject({ status: 410 });

      // Once the cause is fixed, a retry from Platform admin > Jobs (which requeues the dead job
      // with its attempts reset) deletes the file and clears the code.
      fs.rmSync(full, { recursive: true, force: true });
      fs.writeFileSync(full, 'left behind');
      await h.db.job.update({ where: { id: purge.id }, data: { status: 'QUEUED', attempts: 0, runAt: h.clock.now(), deadReason: null, finishedAt: null } });
      await drain();
      expect(await h.db.job.findUniqueOrThrow({ where: { id: purge.id } })).toMatchObject({ status: 'SUCCEEDED' });
      expect(fs.existsSync(full)).toBe(false);
      expect(await h.db.leadExport.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'EXPIRED', errorCode: null });
    } finally {
      h.clock.set(saved);
      fs.rmSync(full, { recursive: true, force: true });
    }
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
