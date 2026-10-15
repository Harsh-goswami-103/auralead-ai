/**
 * Shared harness for the T11 tests (simulators, webhook persistence, ingest.process, purge): a
 * migrated, seeded DEMO DB, the process runtime installed with one DEMO config (so the route's
 * encryption key ring and the worker's decryption key ring are the same), an in-process worker
 * running the real `ingest.process`, `webhook.purge` and `pipeline.advance` handlers (the pipeline
 * with the INGESTION stage only, so later stages halt visibly and never touch other tasks' code),
 * DB sessions for seeded users, and a caller for POST /api/demo/simulate/[source].
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { createIngestProcessJob, type IngestProcessDeps } from '@/server/jobs/handlers/ingest-process';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { createWebhookPurgeJob } from '@/server/jobs/handlers/webhook-purge';
import { buildJobRegistry } from '@/server/jobs/registry';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import { POST as simulateRoute } from '@/app/api/demo/simulate/[source]/route';
import { createWorker, type Worker } from '../../../worker/worker';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { makeRequest, testConfig, uninstallRuntime, useRuntime as installTestRuntime, type TestRuntime } from '../auth/support';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';

export const WS_A_SLUG = 'smile-avenue-dental';
export const WS_B_SLUG = 'kesari-crafts';
export const WS_A = seedId('workspace', WS_A_SLUG);
export const WS_B = seedId('workspace', WS_B_SLUG);

export type Harness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  config: AppConfig;
  runtime: TestRuntime;
  deps: IngestProcessDeps;
  worker: Worker;
  /** Runs the in-process worker until nothing is claimable; returns how many jobs ran. */
  drain: () => Promise<number>;
  destroy: () => Promise<void>;
};

export async function createHarness(label: string, options: { mode?: 'demo' | 'live'; now?: string } = {}): Promise<Harness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  const clock = new FixedClock(options.now ?? NOW);
  const config = testConfig(options.mode ?? 'demo');
  const runtime = installTestRuntime(db, config, clock);
  const deps: IngestProcessDeps = { keyRing: config.secrets.credentials!, contactKeyPepper: config.secrets.suppressionPepper!, mode: 'demo' };
  const stages = new StageRegistry().register(ingestionStage);
  const registry = buildJobRegistry([
    createIngestProcessJob({ deps: () => deps }),
    createWebhookPurgeJob(),
    createPipelineAdvanceJob({ stages, mode: () => 'demo' }),
  ]);
  const worker = createWorker(
    { db, clock, registry, logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  const drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
  const destroy = async () => {
    uninstallRuntime();
    await testDb.destroy();
  };
  return { testDb, db, clock, config, runtime, deps, worker, drain, destroy };
}

export type Auth = { cookie: string; csrf: string };

/** A DEMO session for a seeded user key (`employee`, `owner`, `neha`, `arjun`, `admin`, ...). */
export async function sessionFor(h: Pick<Harness, 'db' | 'config' | 'clock'>, userKey: string): Promise<Auth> {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, {
    userId: user.id,
    globalRole: user.globalRole,
    mode: 'DEMO',
    activeWorkspaceId: null,
    ipHash: 'webhooks-test',
    userAgent: 'webhooks-test',
    now: h.clock.now(),
  });
  return { cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id) };
}

export type SimulateCall = { status: number; body: Record<string, unknown> };

export async function simulate(source: string, body: Record<string, unknown>, auth: Auth | null): Promise<SimulateCall> {
  const req = makeRequest(`/api/demo/simulate/${source}`, { body, cookie: auth?.cookie ?? null, csrf: auth?.csrf ?? null });
  const res = await simulateRoute(req, { params: Promise.resolve({ source }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export type SimulatedEvent = {
  eventId: string;
  externalKey: string;
  outcome: 'ACCEPTED' | 'DUPLICATE';
  status: string;
  jobId: string | null;
  result: Record<string, unknown> | null;
};

export function eventsOf(call: SimulateCall): SimulatedEvent[] {
  return call.body.events as SimulatedEvent[];
}
