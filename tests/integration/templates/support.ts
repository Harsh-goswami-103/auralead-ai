/**
 * Template studio harness (ADR-123, slice F4): the deterministic DEMO seed (Smile Avenue, where the
 * employee persona is given `templates.manage`, as the presentation operator has it; Neha holds
 * only `leads.read` in IronPulse), real user contexts from DB sessions, a temp STORAGE_DIR and an
 * in-process worker running the studio's jobs (`wa.templateReview`, `wa.templateSubmit`) under a
 * FixedClock that the tests move forward.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { createLogger } from '@/lib/logger';
import type { AppCtx } from '@/server/auth/context';
import { createTemplateReviewJob } from '@/server/jobs/handlers/template-review';
import { createTemplateSubmitJob } from '@/server/jobs/handlers/template-submit';
import { buildJobRegistry } from '@/server/jobs/registry';
import type { JobDefinition } from '@/server/jobs/types';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, removeDir, type TestDb } from '../../support/db';
import { userCtx } from '../quotes/support';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-23T06:00:00.000Z';
export const WS_A_SLUG = 'smile-avenue-dental';
export const WS_A = seedId('workspace', WS_A_SLUG);
export const WS_IRON_SLUG = 'ironpulse-fitness';
export const WS_KESARI_SLUG = 'kesari-crafts';

export type StudioHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  base: string;
  storageDir: string;
  worker: Worker;
  drain: () => Promise<number>;
  /** The operator persona in Smile Avenue, with `templates.manage`. */
  operator: () => Promise<AppCtx>;
  /** Neha: `leads.read` only, in IronPulse. */
  neha: () => Promise<AppCtx>;
  destroy: () => Promise<void>;
};

export async function grantCapability(db: PrismaClient, employeeKey: string, workspaceSlug: string, capability: string): Promise<void> {
  const assignment = await db.employeeAssignment.findFirstOrThrow({ where: { employeeUserId: seedId('user', employeeKey), workspaceId: seedId('workspace', workspaceSlug) } });
  const caps = new Set(assignment.capabilities as string[]);
  caps.add(capability);
  await db.employeeAssignment.update({ where: { id: assignment.id }, data: { capabilities: [...caps] } });
}

export async function createStudioHarness(label: string, extraJobs: (h: { db: PrismaClient; clock: FixedClock; storageDir: string }) => JobDefinition[] = () => []): Promise<StudioHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  await grantCapability(db, 'employee', WS_A_SLUG, 'templates.manage');
  const clock = new FixedClock(NOW);
  const base = mkdtempSync(path.join(os.tmpdir(), `auralead-${label}-`));
  const storageDir = path.join(base, 'storage');
  mkdirSync(storageDir, { recursive: true });
  const defs = [
    createTemplateReviewJob({ mode: () => 'demo' }),
    createTemplateSubmitJob({ deps: () => ({ keyRing: null, graphVersion: null, storageDir, mode: 'demo' }) }),
    ...extraJobs({ db, clock, storageDir }),
  ];
  const worker = createWorker(
    { db, clock, registry: buildJobRegistry(defs), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  const drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
  return {
    testDb,
    db,
    clock,
    base,
    storageDir,
    worker,
    drain,
    operator: () => userCtx(db, clock, 'employee', WS_A_SLUG),
    neha: () => userCtx(db, clock, 'neha', WS_IRON_SLUG),
    destroy: async () => {
      await testDb.destroy();
      await removeDir(base);
    },
  };
}
