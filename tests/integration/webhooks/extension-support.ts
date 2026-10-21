/**
 * Shared harness for the T36 extension tests (the ingest endpoint, the token routes and the bridge
 * chaos run against the real server): a migrated DB with the DEMO seed (workspace A Smile Avenue,
 * where the employee persona holds `extension.manage`) or, for LIVE, one LIVE workspace with a
 * non-demo owner; the process runtime installed with one config (so the route encrypts and the
 * worker decrypts with the same key ring); an in-process worker running the real `ingest.process`,
 * `webhook.purge` and `pipeline.advance` handlers in the harness mode; token issuing through the
 * real service; and callers for POST and OPTIONS /api/webhooks/gmaps-extension.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { createIngestProcessJob, type IngestProcessDeps } from '@/server/jobs/handlers/ingest-process';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { createWebhookPurgeJob } from '@/server/jobs/handlers/webhook-purge';
import { buildJobRegistry } from '@/server/jobs/registry';
import { createExtensionToken, type CreatedExtensionToken } from '@/server/services/extension/tokens';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import { OPTIONS as preflightRoute, POST as ingestRoute } from '@/app/api/webhooks/gmaps-extension/route';
import { createWorker, type Worker } from '../../../worker/worker';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { ORIGIN, testConfig, uninstallRuntime, useRuntime as installTestRuntime, type TestRuntime } from '../auth/support';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';
export const ENDPOINT = '/api/webhooks/gmaps-extension';

export const WS_A_SLUG = 'smile-avenue-dental';
export const WS_A = seedId('workspace', WS_A_SLUG);
export const WS_KESARI_SLUG = 'kesari-crafts';
export const WS_KESARI = seedId('workspace', WS_KESARI_SLUG);
export const LIVE_SLUG = 'live-maps-co';

/** A well-formed Chrome extension id (32 letters a-p). */
export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const OTHER_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

export type ExtensionHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  config: AppConfig;
  runtime: TestRuntime;
  mode: 'demo' | 'live';
  /** LIVE harness only: the LIVE workspace and its owner. */
  live: { workspaceId: string; ownerId: string } | null;
  worker: Worker;
  drain: () => Promise<number>;
  destroy: () => Promise<void>;
};

export async function createExtensionHarness(label: string, options: { mode?: 'demo' | 'live' } = {}): Promise<ExtensionHarness> {
  const mode = options.mode ?? 'demo';
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  let live: ExtensionHarness['live'] = null;
  if (mode === 'demo') {
    await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  } else {
    const ws = await db.workspace.create({ data: { slug: LIVE_SLUG, name: 'Live Maps Co', mode: 'LIVE', planLabel: 'Growth', timezone: 'Asia/Kolkata' } });
    await db.workspaceSettings.create({ data: { workspaceId: ws.id, maxDiscountBps: 1000, brandColor: '#0F766E', termsText: 'Terms' } });
    const owner = await db.user.create({ data: { email: 'owner@live-maps.test', name: 'Live Owner', globalRole: 'USER', isDemo: false } });
    await db.membership.create({ data: { userId: owner.id, workspaceId: ws.id, role: 'OWNER' } });
    live = { workspaceId: ws.id, ownerId: owner.id };
  }
  const clock = new FixedClock(NOW);
  const config = testConfig(mode);
  const runtime = installTestRuntime(db, config, clock);
  const deps: IngestProcessDeps = { keyRing: config.secrets.credentials!, contactKeyPepper: config.secrets.suppressionPepper!, mode };
  const stages = new StageRegistry().register(ingestionStage);
  const registry = buildJobRegistry([createIngestProcessJob({ deps: () => deps }), createWebhookPurgeJob(), createPipelineAdvanceJob({ stages, mode: () => mode })]);
  const worker = createWorker(
    { db, clock, registry, logger: createLogger({ level: 'silent' }), mode, version: 'test', random: () => 0 },
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
  return { testDb, db, clock, config, runtime, mode, live, worker, drain, destroy };
}

let seq = 0;

/** A signed-in context exactly as a route builds it: a seeded DEMO user, or the LIVE owner. */
export async function managerCtx(h: ExtensionHarness, userKey = 'employee', workspaceSlug: string = WS_A_SLUG): Promise<AppCtx> {
  seq += 1;
  const correlationId = `req_extension_test_${String(seq).padStart(4, '0')}`;
  if (h.mode === 'live') {
    const { token } = await createSession(h.db, { userId: h.live!.ownerId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: h.live!.workspaceId, ipHash: 'ext', userAgent: 'vitest', now: h.clock.now() });
    const loaded = (await loadSession(h.db, token, { now: h.clock.now(), mode: 'LIVE' }))!;
    return buildUserContext(loaded, { prisma: h.db, mode: 'live', clock: h.clock }, { correlationId });
  }
  const userId = seedId('user', userKey);
  const user = await h.db.user.findUniqueOrThrow({ where: { id: userId } });
  const { token } = await createSession(h.db, { userId, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'ext', userAgent: 'vitest', now: h.clock.now() });
  const loaded = (await loadSession(h.db, token, { now: h.clock.now(), mode: 'DEMO' }))!;
  return buildUserContext(loaded, { prisma: h.db, mode: 'demo', clock: h.clock }, { correlationId, workspaceSlug });
}

/** Issues a token through the real service (shown once: the plaintext is only in this return value). */
export async function issueToken(
  h: ExtensionHarness,
  options: { name?: string; allowedExtensionId?: string | null; expiresInDays?: number | null; workspaceSlug?: string } = {},
): Promise<CreatedExtensionToken> {
  seq += 1;
  const ctx = await managerCtx(h, 'employee', options.workspaceSlug ?? WS_A_SLUG);
  // Test housekeeping: a file issues more tokens than the 10-active limit, so the oldest active
  // ones of earlier tests are retired first (written directly, not through the audited service).
  const active = await h.db.extensionToken.findMany({ where: { workspaceId: ctx.workspaceId!, revokedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  const retire = active.slice(0, Math.max(0, active.length - 5)).map((t) => t.id);
  if (retire.length > 0) await h.db.extensionToken.updateMany({ where: { id: { in: retire } }, data: { revokedAt: new Date(h.clock.now().getTime() - 1) } });
  h.clock.advance(1); // distinct createdAt, so "oldest" is well defined

  return createExtensionToken(ctx, {
    name: options.name ?? `Test laptop ${seq}`,
    allowedExtensionId: options.allowedExtensionId ?? null,
    expiresInDays: options.expiresInDays ?? null,
  });
}

export type BatchRecord = Record<string, unknown>;

let recordSeq = 0;
/** The E.164 form of the phone `mapsRecord` gives its n-th record (display form `074281 0nnnn`). */
export const mapsPhoneE164 = (n: number) => `+9174281${String(n).padStart(5, '0')}`;

/** A Maps record with a unique, valid Indian mobile number (national format, trunk 0) and no email. */
export function mapsRecord(overrides: BatchRecord = {}): BatchRecord {
  recordSeq += 1;
  const n = String(recordSeq).padStart(4, '0');
  return {
    recordId: `cid-${Date.parse(NOW)}-${n}`,
    name: `Maps Business ${n}`,
    phone: `074281 ${String(recordSeq).padStart(5, '0')}`,
    website: `https://maps-business-${n}.example.in`,
    address: `Shop ${n}, Sector 29`,
    city: 'Gurugram',
    category: 'Dental clinic',
    rating: 4.4,
    reviewCount: 120,
    extractedAt: '2026-10-16T05:30:00+05:30',
    ...overrides,
  };
}

export function batchBody(batchId: string, records: BatchRecord[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, batchId, keyword: 'dental clinic in Gurugram', records, ...extra });
}

export type PostOptions = { token?: string | null; origin?: string | null; headers?: Record<string, string> };

export async function postBatch(raw: string, options: PostOptions = {}): Promise<{ res: Response; body: Record<string, unknown> }> {
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (options.origin) headers.set('origin', options.origin);
  const req = new Request(`${ORIGIN}${ENDPOINT}`, { method: 'POST', headers, body: raw });
  const res = await ingestRoute(req, { params: Promise.resolve({}) });
  const text = await res.text();
  return { res, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

export async function preflight(origin: string | null, requestHeaders = 'authorization, content-type'): Promise<Response> {
  const headers = new Headers({ 'access-control-request-method': 'POST', 'access-control-request-headers': requestHeaders });
  if (origin) headers.set('origin', origin);
  return preflightRoute(new Request(`${ORIGIN}${ENDPOINT}`, { method: 'OPTIONS', headers }), { params: Promise.resolve({}) });
}

export type RecordResult = { index: number; recordId: string | null; status: string; reasonCode: string | null; fields?: string[] };
export const recordsOf = (body: Record<string, unknown>) => body.records as RecordResult[];
