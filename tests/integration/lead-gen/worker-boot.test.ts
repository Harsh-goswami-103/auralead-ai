// Cross-slice (integrator): the production worker boots with the job types of all six slices at
// once. Two levels:
//  - the registry `worker/index.ts` builds (`buildJobRegistry()`) holds every lead-gen job type, and
//    `reply.auto` as kind `ai`, each exactly once (a duplicated name throws when it is built);
//  - a real worker process (`worker/index.ts` through tsx, against a migrated database) claims one
//    job of each of those types with the production handler: none ends DEAD with UNKNOWN_JOB_TYPE
//    (the fate of a type nobody registered), none is stuck retrying on a missing configuration, and
//    the handlers answer for ids that do not exist the way their documentation says (a no-op, or a
//    typed dead reason), never with a crash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { systemClock } from '@/lib/clock';
import { LEAD_GEN_JOB_OWNERS, LEAD_GEN_JOB_TYPES } from '@/lib/domain/lead-gen';
import { enqueueJob } from '@/server/jobs/queue';
import { buildJobRegistry, JOB_DEFINITIONS } from '@/server/jobs/registry';
import { testEnv } from '../auth/support';
import { createTestDb, removeDir, type TestDb } from '../../support/db';
import { REPO_ROOT, spawnTsx, terminateAll } from '../../support/spawn';
import { waitFor } from '../jobs/support';

/** The job types named in the task: every lead-gen type, with `reply.auto` (kind ai since ADR-122). */
const SUITE_TYPES = [
  'leadFinder.search',
  'leadFinder.emails',
  'leadFinder.purge',
  'leads.placesExpire',
  'leads.import',
  'leads.importPurge',
  'wa.templateSubmit',
  'wa.templateReview',
  'wa.demoStatus',
  'handoff.summary',
  'reply.auto',
] as const;

/** A valid payload per type that names rows which do not exist. */
const PAYLOADS: Record<(typeof SUITE_TYPES)[number], Prisma.InputJsonObject> = {
  'leadFinder.search': { runId: 'run_missing_0001', cell: 0, page: 0 },
  'leadFinder.emails': { runId: 'run_missing_0001', resultIds: ['result_missing_0001'] },
  'leadFinder.purge': { runId: 'run_missing_0001' },
  'leads.placesExpire': {},
  'leads.import': { importId: 'import_missing_0001', chunk: 0 },
  'leads.importPurge': { importId: 'import_missing_0001' },
  'wa.templateSubmit': { templateId: 'template_missing_0001' },
  'wa.templateReview': { templateId: 'template_missing_0001' },
  'wa.demoStatus': { messageId: 'message_missing_0001', providerMessageId: 'wamid.missing.0001', status: 'delivered' },
  'handoff.summary': { handoffId: 'handoff_missing_0001' },
  'reply.auto': { conversationId: 'conversation_missing_0001', inboundMessageId: 'message_missing_0002' },
};

describe('the registry the worker builds', () => {
  const registry = buildJobRegistry();

  it('holds every lead-gen job type and reply.auto exactly once', () => {
    expect(() => buildJobRegistry()).not.toThrow();
    expect(Object.values(LEAD_GEN_JOB_TYPES).every((t) => (SUITE_TYPES as readonly string[]).includes(t))).toBe(true);
    for (const type of SUITE_TYPES) {
      expect(JOB_DEFINITIONS.filter((d) => d.type === type).length, `${type} in JOB_DEFINITIONS`).toBe(1);
      expect(registry.get(type), type).toBeDefined();
      expect(registry.types().filter((t) => t === type)).toHaveLength(1);
    }
    expect(new Set(registry.types()).size).toBe(registry.types().length);
    expect(Object.keys(LEAD_GEN_JOB_OWNERS).sort()).toEqual(Object.values(LEAD_GEN_JOB_TYPES).sort());
  });

  it('registers them with the kinds the ADRs fix', () => {
    const kinds: Record<string, string> = { 'leadFinder.search': 'fetch', 'leadFinder.emails': 'fetch', 'wa.templateSubmit': 'send', 'handoff.summary': 'ai', 'reply.auto': 'ai' };
    for (const [type, kind] of Object.entries(kinds)) expect(registry.get(type)?.kind, type).toBe(kind);
    for (const type of SUITE_TYPES) expect(registry.get(type)!.payloadVersions, type).toContain(1);
  });
});

describe('a real worker process (worker/index.ts)', () => {
  let db: TestDb;
  let dataDir: string;

  beforeAll(async () => {
    db = await createTestDb({ label: 'lg-worker-boot' });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auralead-lg-worker-'));
  }, 120_000);
  afterAll(async () => {
    await terminateAll();
    await db?.destroy();
    if (dataDir) await removeDir(dataDir);
  });

  it('claims a job of every suite type with its production handler', async () => {
    const client = db.client();
    const workspace = await client.workspace.create({ data: { slug: 'boot-co', name: 'Boot Co', mode: 'DEMO', planLabel: 'Starter', timezone: 'Asia/Kolkata' } });
    await client.workspaceSettings.create({ data: { workspaceId: workspace.id, maxDiscountBps: 1000, brandColor: '#0F766E', termsText: 'Terms' } });
    const ids: Record<string, string> = {};
    for (const type of SUITE_TYPES) {
      const { job } = await enqueueJob(client, systemClock, { type, payload: PAYLOADS[type], workspaceId: workspace.id, idempotencyKey: `lg-boot:${type}`, correlationId: `lg-boot-${type}`, kind: 'default' });
      ids[type] = job.id;
    }

    const worker = spawnTsx(path.join(REPO_ROOT, 'worker', 'index.ts'), {
      env: { ...testEnv('demo', { AURALEAD_DATA_DIR: dataDir, STORAGE_DIR: path.join(dataDir, 'storage') }), DATABASE_URL: db.url, NODE_ENV: 'test', LOG_LEVEL: 'warn' },
    });
    try {
      // The worker booted: a heartbeat row in DEMO mode, then every job is claimed and settled.
      const beat = await waitFor(async () => client.workerHeartbeat.findFirst(), 60_000, `a worker heartbeat (stderr: ${worker.stderr()})`);
      expect(beat.mode).toBe('DEMO');
      const rows = await waitFor(
        async () => {
          const found = await client.job.findMany({ where: { id: { in: Object.values(ids) } } });
          return found.every((j) => j.status === 'SUCCEEDED' || j.status === 'DEAD' || j.status === 'CANCELLED') ? found : null;
        },
        90_000,
        `every suite job settled (stderr: ${worker.stderr()})`,
      );
      const byType = Object.fromEntries(rows.map((j) => [j.type, j]));
      for (const type of SUITE_TYPES) {
        const job = byType[type]!;
        expect(job.attempts, `${type} was claimed`).toBeGreaterThanOrEqual(1);
        expect(job.deadReason, `${type} has a handler`).not.toBe('UNKNOWN_JOB_TYPE');
        expect(job.lastErrorCode, `${type} did not crash on missing configuration`).not.toBe('UNHANDLED_ERROR');
      }
      // What the handlers do for ids that do not exist: a no-op, or a typed dead reason.
      expect(Object.fromEntries(rows.map((j) => [j.type, j.status === 'DEAD' ? `DEAD:${j.deadReason}` : j.status]))).toEqual({
        'leadFinder.search': 'DEAD:RUN_NOT_FOUND',
        'leadFinder.emails': 'DEAD:RUN_NOT_FOUND',
        'leadFinder.purge': 'SUCCEEDED',
        'leads.placesExpire': 'SUCCEEDED',
        'leads.import': 'DEAD:IMPORT_NOT_FOUND',
        'leads.importPurge': 'SUCCEEDED',
        'wa.templateSubmit': 'SUCCEEDED',
        'wa.templateReview': 'SUCCEEDED',
        'wa.demoStatus': 'SUCCEEDED',
        'handoff.summary': 'SUCCEEDED',
        'reply.auto': 'SUCCEEDED',
      });
    } finally {
      await terminateAll();
    }
  }, 180_000);
});
