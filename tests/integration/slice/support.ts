/**
 * Harness for the T17 slice tests: a migrated, seeded DEMO DB, the process runtime installed with
 * one DEMO config (shared key ring for the simulator and the worker, a temp STORAGE_DIR for quote
 * PDFs) and a capturing logger, plus an in-process worker that runs the real production handlers
 * end to end: ingest.process -> pipeline.advance (INGESTION, SCORE, DRAFT; APPROVAL halts until
 * T23) -> ai.draft -> quote.renderPdf. The SCORE stage gets a website fetcher that fails the test
 * if it is ever called, because DEMO makes zero outbound calls.
 *
 * Route callers go through the real route handlers (withRoute: session, CSRF, Zod, capability),
 * with a fixed `x-request-id` so the correlation chain can be asserted exactly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { installRuntime, uninstallRuntime, type Runtime } from '@/server/boot';
import { createAiDraftJob } from '@/server/jobs/handlers/ai-draft';
import { createIngestProcessJob, type IngestProcessDeps } from '@/server/jobs/handlers/ingest-process';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { createQuoteExpireSweepJob } from '@/server/jobs/handlers/quote-expire-sweep';
import { createQuoteRenderPdfJob } from '@/server/jobs/handlers/quote-render-pdf';
import { createWebhookPurgeJob } from '@/server/jobs/handlers/webhook-purge';
import { buildJobRegistry } from '@/server/jobs/registry';
import { createRateLimiters } from '@/server/security/rate-limit';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { createDraftStage } from '@/server/services/pipeline/stages/draft';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import { createScoreStage } from '@/server/services/pipeline/stages/score';
import { POST as draftRoute } from '@/app/api/app/leads/[leadId]/draft/route';
import { POST as createQuoteRoute } from '@/app/api/app/leads/[leadId]/quotes/route';
import { POST as approveRoute } from '@/app/api/app/leads/[leadId]/quotes/[quoteId]/approve/route';
import { GET as pdfRoute } from '@/app/api/app/leads/[leadId]/quotes/[quoteId]/pdf/route';
import { POST as simulateRoute } from '@/app/api/demo/simulate/[source]/route';
import { createWorker, type Worker } from '../../../worker/worker';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { makeRequest, testConfig } from '../auth/support';
import { sessionFor, type Auth } from '../webhooks/support';

export { sessionFor, type Auth };

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';
export const WS_A_SLUG = 'smile-avenue-dental';
export const WS_A = seedId('workspace', WS_A_SLUG);
export const WS_B_SLUG = 'ironpulse-fitness';
export const WS_B = seedId('workspace', WS_B_SLUG);
export const WS_B_LEAD = seedId('lead', `${WS_B_SLUG}:Q-0001`);
export const WS_B_QUOTE = seedId('quote', `${WS_B_SLUG}:Q-0001`);

export type SliceHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  config: AppConfig;
  storageDir: string;
  /** Every log line written by the routes and the worker, as raw JSON text. */
  logs: string[];
  outboundCalls: string[];
  worker: Worker;
  /** Runs the worker until nothing is claimable, advancing the clock 1 s after each job. */
  drain: () => Promise<number>;
  destroy: () => Promise<void>;
};

export async function createSliceHarness(label: string): Promise<SliceHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  const clock = new FixedClock(NOW);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), `auralead-${label}-storage-`));
  const config = testConfig('demo', { TRUSTED_PROXY_HOPS: '1', STORAGE_DIR: storageDir });

  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ level: 'trace', destination: sink });
  const runtime: Runtime = { config, prisma: db, limiters: createRateLimiters(clock), logger, baseClock: clock, warnings: [] };
  installRuntime(runtime);

  const outboundCalls: string[] = [];
  const keyRing = config.secrets.credentials!;
  const deps: IngestProcessDeps = { keyRing, contactKeyPepper: config.secrets.suppressionPepper!, mode: 'demo' };
  const stages = new StageRegistry()
    .register(ingestionStage)
    .register(
      createScoreStage({
        fetchWebsite: async (url) => {
          outboundCalls.push(url);
          throw new Error('DEMO must never fetch a website');
        },
      }),
    )
    .register(createDraftStage(() => ({ keyRing })));
  const registry = buildJobRegistry([
    createIngestProcessJob({ deps: () => deps }),
    createWebhookPurgeJob(),
    createPipelineAdvanceJob({ stages, mode: () => 'demo' }),
    createAiDraftJob({ mode: () => 'demo', deps: () => ({ keyRing }) }),
    createQuoteRenderPdfJob({ mode: () => 'demo', storageDir: () => storageDir }),
    createQuoteExpireSweepJob({ mode: () => 'demo' }),
  ]);
  const worker = createWorker(
    { db, clock, registry, logger: logger.child({ service: 'worker' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  const drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') {
      ran += 1;
      clock.advance(1_000);
    }
    return ran;
  };
  const destroy = async () => {
    uninstallRuntime();
    await testDb.destroy();
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { testDb, db, clock, config, storageDir, logs, outboundCalls, worker, drain, destroy };
}

export type Call = { status: number; requestId: string | null; headers: Headers; body: Record<string, unknown> | null; bytes: Buffer };

async function read(res: Response): Promise<Call> {
  const bytes = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? (JSON.parse(bytes.toString('utf8')) as Record<string, unknown>) : null;
  return { status: res.status, requestId: res.headers.get('x-request-id'), headers: res.headers, body, bytes };
}

function opts(auth: Auth | null, requestId: string | undefined) {
  return { cookie: auth?.cookie ?? null, csrf: auth?.csrf ?? null, headers: requestId ? { 'x-request-id': requestId } : undefined };
}

export async function simulateGmaps(auth: Auth, body: Record<string, unknown>, requestId?: string): Promise<Call> {
  const req = makeRequest('/api/demo/simulate/gmaps', { body, ...opts(auth, requestId) });
  return read(await simulateRoute(req, { params: Promise.resolve({ source: 'gmaps' }) }));
}

export async function requestDraft(auth: Auth | null, leadId: string, body: Record<string, unknown>, requestId?: string): Promise<Call> {
  const req = makeRequest(`/api/app/leads/${leadId}/draft`, { body, ...opts(auth, requestId) });
  return read(await draftRoute(req, { params: Promise.resolve({ leadId }) }));
}

export async function createQuoteFromProposal(auth: Auth | null, leadId: string, body: Record<string, unknown>, requestId?: string): Promise<Call> {
  const req = makeRequest(`/api/app/leads/${leadId}/quotes`, { body, ...opts(auth, requestId) });
  return read(await createQuoteRoute(req, { params: Promise.resolve({ leadId }) }));
}

export async function approveLeadQuote(auth: Auth | null, leadId: string, quoteId: string, body: Record<string, unknown>, requestId?: string): Promise<Call> {
  const req = makeRequest(`/api/app/leads/${leadId}/quotes/${quoteId}/approve`, { body, ...opts(auth, requestId) });
  return read(await approveRoute(req, { params: Promise.resolve({ leadId, quoteId }) }));
}

export async function downloadLeadQuotePdf(auth: Auth | null, leadId: string, quoteId: string, query: string, requestId?: string): Promise<Call> {
  const req = makeRequest(`/api/app/leads/${leadId}/quotes/${quoteId}/pdf?${query}`, { method: 'GET', ...opts(auth, requestId) });
  return read(await pdfRoute(req, { params: Promise.resolve({ leadId, quoteId }) }));
}

/** `summary` is the stored JSON, parsed by the adapter. */
export type AuditRow = { action: string; correlationId: string; targetType: string; targetId: string; result: string; summary: unknown; actorKind: string };

/** AuditEvents of a workspace in insertion order (SQLite rowid), newer than `since`. */
export async function auditTrail(db: PrismaClient, workspaceId: string, since: Date): Promise<AuditRow[]> {
  return db.$queryRawUnsafe<AuditRow[]>(
    'SELECT action, correlationId, targetType, targetId, result, summary, actorKind FROM "AuditEvent" WHERE workspaceId = ? AND createdAt >= ? ORDER BY rowid',
    workspaceId,
    since,
  );
}
