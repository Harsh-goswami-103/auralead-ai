/**
 * Harnesses for the Lead Finder tests (ADR-118, slice F1).
 *
 * DEMO: the seeded DEMO DB (workspace A is the dental clinic; the `employee` persona holds the
 * operator capabilities there and gets `finder.run` here, as an owner of the suite would grant it),
 * user contexts built from real sessions, and an in-process worker with the production finder
 * handlers in DEMO mode (the simulated directory; zero outbound).
 *
 * LIVE: a migrated DB with no DEMO seed, a LIVE workspace with a non-demo OWNER (every capability),
 * its GOOGLE_PLACES key encrypted exactly as the credential writer stores it, and the same handlers
 * in LIVE mode whose only transport is the scripted Places stand-in (`FakeGraph`): anything
 * unscripted fails the test.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { createLeadFinderPurgeJob } from '@/server/jobs/handlers/lead-finder-purge';
import { createLeadFinderSearchJob, type FinderSearchDeps } from '@/server/jobs/handlers/lead-finder-search';
import { buildJobRegistry } from '@/server/jobs/registry';
import type { JobDefinition } from '@/server/jobs/types';
import { credentialAad, encryptSecret, type KeyRing } from '@/server/security/secrets';
import type { IngestDeps } from '@/server/services/leads/ingest';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, type TestDb } from '../../support/db';
import { testConfig, uninstallRuntime, useRuntime as installTestRuntime } from '../auth/support';
import { FakeGraph, PLACES_KEY } from './places-support';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const PEPPER = `finder-test-pepper-${'p'.repeat(32)}`;
export const INGEST: IngestDeps = { contactKeyPepper: PEPPER };
export const KEY_RING: KeyRing = { activeKid: 'k1', keys: { k1: Buffer.alloc(32, 21) } };

export const WS_A_SLUG = 'smile-avenue-dental';
export const WS_A = seedId('workspace', WS_A_SLUG);
export const WS_B_SLUG = 'ironpulse-fitness';
export const WS_B = seedId('workspace', WS_B_SLUG);

let seq = 0;

export function workerFor(db: PrismaClient, clock: FixedClock, mode: 'demo' | 'live', defs: JobDefinition[]): Worker {
  return createWorker(
    { db, clock, registry: buildJobRegistry(defs), logger: createLogger({ level: 'silent' }), mode, version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

export async function drain(w: Worker): Promise<number> {
  let ran = 0;
  while ((await w.tick()) === 'ran') ran += 1;
  return ran;
}

/** A signed-in user context exactly as a route builds it (session -> membership or assignment -> capabilities). */
export async function sessionCtx(db: PrismaClient, clock: FixedClock, userId: string, mode: 'demo' | 'live', workspaceSlug?: string): Promise<AppCtx> {
  seq += 1;
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const sessionMode = mode === 'demo' ? 'DEMO' : 'LIVE';
  const { token } = await createSession(db, { userId, globalRole: user.globalRole, mode: sessionMode, activeWorkspaceId: null, ipHash: 'finder', userAgent: 'vitest', now: clock.now() });
  const loaded = (await loadSession(db, token, { now: clock.now(), mode: sessionMode }))!;
  return buildUserContext(loaded, { prisma: db, mode, clock }, { correlationId: `req_finder_test_${String(seq).padStart(4, '0')}`, ...(workspaceSlug ? { workspaceSlug } : {}) });
}

// ---- DEMO -----------------------------------------------------------------------------------------

export type DemoHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  worker: Worker;
  /** The operator persona in workspace A with `finder.run` added to the seeded operator set. */
  operator: () => Promise<AppCtx>;
  /** The OWNER persona of workspace A (USER panel, every capability). */
  owner: () => Promise<AppCtx>;
  /** An EMPLOYEE of workspace B with `leads.read` only. */
  reader: () => Promise<AppCtx>;
};

export async function createDemoHarness(label: string): Promise<DemoHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  const clock = new FixedClock(NOW);
  const assignment = await db.employeeAssignment.findFirstOrThrow({ where: { employeeUserId: seedId('user', 'employee'), workspaceId: WS_A } });
  const caps = Array.isArray(assignment.capabilities) ? (assignment.capabilities as string[]) : [];
  await db.employeeAssignment.update({ where: { id: assignment.id }, data: { capabilities: [...new Set([...caps, 'finder.run'])] } });
  const worker = workerFor(db, clock, 'demo', [createLeadFinderSearchJob({ mode: () => 'demo', deps: () => ({ keyRing: null }) }), createLeadFinderPurgeJob({ mode: () => 'demo' })]);
  return {
    testDb,
    db,
    clock,
    worker,
    operator: () => sessionCtx(db, clock, seedId('user', 'employee'), 'demo', WS_A_SLUG),
    owner: () => sessionCtx(db, clock, seedId('user', 'owner'), 'demo'),
    reader: () => sessionCtx(db, clock, seedId('user', 'neha'), 'demo', WS_B_SLUG),
  };
}

// ---- LIVE -----------------------------------------------------------------------------------------

export type LiveHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  config: AppConfig;
  graph: FakeGraph;
  wsId: string;
  ownerId: string;
  worker: Worker;
  deps: () => FinderSearchDeps;
  owner: () => Promise<AppCtx>;
  destroy: () => Promise<void>;
};

export async function createLiveHarness(label: string): Promise<LiveHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  const clock = new FixedClock(NOW);
  const config = testConfig('live', {
    SUPPRESSION_PEPPER: PEPPER,
    CREDENTIALS_KEYRING: JSON.stringify({ k1: KEY_RING.keys.k1!.toString('base64') }),
    CREDENTIALS_ACTIVE_KID: 'k1',
  });
  installTestRuntime(db, config, clock);
  const ws = await db.workspace.create({ data: { slug: 'live-finder-co', name: 'Live Finder Co', mode: 'LIVE', planLabel: 'Growth', timezone: 'Asia/Kolkata' } });
  await db.workspaceSettings.create({ data: { workspaceId: ws.id, maxDiscountBps: 1000, brandColor: '#0F766E', termsText: 'Terms' } });
  const owner = await db.user.create({ data: { email: 'owner@live-finder.test', name: 'Live Finder Owner', globalRole: 'USER', isDemo: false } });
  await db.membership.create({ data: { userId: owner.id, workspaceId: ws.id, role: 'OWNER' } });
  const graph = new FakeGraph();
  const deps = (): FinderSearchDeps => ({ keyRing: KEY_RING, seams: { http: graph.http } });
  const worker = workerFor(db, clock, 'live', [createLeadFinderSearchJob({ mode: () => 'live', deps }), createLeadFinderPurgeJob({ mode: () => 'live' })]);
  return {
    testDb,
    db,
    clock,
    config,
    graph,
    wsId: ws.id,
    ownerId: owner.id,
    worker,
    deps,
    owner: () => sessionCtx(db, clock, owner.id, 'live'),
    destroy: async () => {
      uninstallRuntime();
      await testDb.destroy();
    },
  };
}

/** A GOOGLE_PLACES integration stored as the credential writer stores it (key encrypted under KEY_RING). */
export async function storePlacesKey(h: LiveHarness, opts: { status?: 'CONFIGURED_UNVERIFIED' | 'CONNECTED' | 'REVOKED' | 'ERROR'; key?: string; envelope?: string } = {}) {
  const status = opts.status ?? 'CONFIGURED_UNVERIFIED';
  const existing = await h.db.integration.findFirst({ where: { workspaceId: h.wsId, kind: 'GOOGLE_PLACES' } });
  const row = existing ?? (await h.db.integration.create({ data: { workspaceId: h.wsId, kind: 'GOOGLE_PLACES', status, config: {} } }));
  const key = opts.key ?? PLACES_KEY;
  const envelope = opts.envelope ?? encryptSecret(KEY_RING, key, credentialAad({ workspaceId: h.wsId, integrationId: row.id, field: 'apiKey' }));
  return h.db.integration.update({
    where: { id: row.id },
    data: { status, secrets: { apiKey: envelope }, secretLast4: { apiKey: { last4: key.slice(-4), updatedAt: NOW } }, lastErrorCode: null, lastErrorRedacted: null },
  });
}
