/**
 * Harness for the T23 pipeline tests (O5, E9): the seeded DEMO DB, a temp STORAGE_DIR and an
 * in-process worker running the real pipeline end to end: `pipeline.advance` with every stage
 * handler (INGESTION, SCORE with a fetcher that fails the test if DEMO ever fetched, DRAFT with
 * the local deterministic generator, APPROVAL, DELIVERY) and the production `dispatch.whatsapp`
 * and `dispatch.email` jobs with the production DEMO transports, which record each would-be send
 * as one line in `<STORAGE_DIR>/demo-outbox/<channel>.jsonl` (zero network). "One demo transport
 * call" is counted from that outbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { createLogger } from '@/lib/logger';
import { readDemoOutbox, demoOutboxDir } from '@/server/adapters/whatsapp/demo';
import { getWebhookContext, type AppCtx } from '@/server/auth/context';
import { createDispatchEmailJob } from '@/server/jobs/handlers/dispatch-email';
import type { DispatchRuntimeDeps } from '@/server/jobs/handlers/dispatch-run';
import { createDispatchWhatsAppJob } from '@/server/jobs/handlers/dispatch-whatsapp';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { buildJobRegistry } from '@/server/jobs/registry';
import { ingestBatch } from '@/server/services/leads/ingest';
import { deriveUnsubscribeKey } from '@/server/services/messaging/dispatch';
import { StageRegistry } from '@/server/services/pipeline/stages';
import { createApprovalStage } from '@/server/services/pipeline/stages/approval';
import { createDeliveryStage } from '@/server/services/pipeline/stages/delivery';
import { createDraftStage } from '@/server/services/pipeline/stages/draft';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import { createScoreStage } from '@/server/services/pipeline/stages/score';
import { createWorker, type Worker } from '../../../worker/worker';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { KEY_RING } from '../ai/support';
import { userCtx } from '../quotes/support';
import { createTestDb, removeDir, type TestDb } from '../../support/db';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';
export const PEPPER = `pipeline-test-pepper-${'p'.repeat(32)}`;
export const DEPS = { contactKeyPepper: PEPPER };
export const WS_A = seedId('workspace', 'smile-avenue-dental');
export const WS_C = seedId('workspace', 'kesari-crafts');
export const NOTICE = 'Send me offers on WhatsApp.';
export const CONSENT_MAPPING = { version: 1, consent: { column: 'consent', truthyValues: ['yes'], channel: 'WHATSAPP' as const, purpose: 'MARKETING' as const, noticeText: NOTICE } };

export type PipelineHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  storageDir: string;
  worker: () => Worker;
  outboundFetches: string[];
  drain: (w?: Worker) => Promise<number>;
  owner: () => Promise<AppCtx>;
  /** Would-be sends the production DEMO transports recorded. */
  outbox: (channel: 'whatsapp' | 'email') => unknown[];
  destroy: () => Promise<void>;
};

export async function createPipelineHarness(label: string): Promise<PipelineHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  const clock = new FixedClock(NOW);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `auralead-${label}-`));
  const storageDir = path.join(base, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  const outboundFetches: string[] = [];

  const runtimeDeps = (): DispatchRuntimeDeps => ({
    contactKeyPepper: PEPPER,
    storageDir,
    appOrigin: 'http://localhost:3000',
    unsubscribeKey: deriveUnsubscribeKey('pipeline-test-session-secret'),
    outboundLockFile: path.join(base, 'outbound.lock'),
    envOutboundPaused: false,
  });
  const stages = () =>
    new StageRegistry()
      .register(ingestionStage)
      .register(
        createScoreStage({
          fetchWebsite: async (url) => {
            outboundFetches.push(url);
            throw new Error('DEMO must never fetch a website');
          },
        }),
      )
      .register(createDraftStage(() => ({ keyRing: KEY_RING })))
      .register(createApprovalStage(() => DEPS))
      .register(createDeliveryStage(() => DEPS));
  const worker = () =>
    createWorker(
      {
        db,
        clock,
        registry: buildJobRegistry([
          createPipelineAdvanceJob({ stages: stages(), mode: () => 'demo' }),
          createDispatchWhatsAppJob({ mode: () => 'demo', deps: runtimeDeps }),
          createDispatchEmailJob({ mode: () => 'demo', deps: runtimeDeps }),
        ]),
        logger: createLogger({ level: 'silent' }),
        mode: 'demo',
        version: 'test',
        random: () => 0,
      },
      { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
    );
  const shared = worker();
  const drain = async (w: Worker = shared) => {
    let ran = 0;
    while ((await w.tick()) === 'ran') ran += 1;
    return ran;
  };
  return {
    testDb,
    db,
    clock,
    storageDir,
    worker,
    outboundFetches,
    drain,
    owner: () => userCtx(db, clock, 'owner'),
    outbox: (channel) => readDemoOutbox(demoOutboxDir(storageDir), channel === 'whatsapp' ? 'WHATSAPP' : 'EMAIL'),
    destroy: async () => {
      await testDb.destroy();
      await removeDir(base);
    },
  };
}

let seq = 0;
export function webhookCtx(h: Pick<PipelineHarness, 'db' | 'clock'>, workspaceId: string = WS_A): AppCtx {
  seq += 1;
  return getWebhookContext({ workspaceId }, { prisma: h.db, mode: 'demo', clock: h.clock }, `req_pipeline_test_${seq.toString().padStart(4, '0')}`);
}

/** One Sheets row with the consent column answered "yes": WhatsApp OPT_IN MARKETING consent (P1). */
export function sheetsBatch(tag: string, phone: string, extra: Record<string, unknown> = {}) {
  return {
    source: 'GOOGLE_SHEETS' as const,
    externalBatchId: `pipeline-${tag}`,
    mapping: CONSENT_MAPPING,
    records: [
      {
        externalId: `row-${tag}`,
        fields: { name: `Pipeline Lead ${tag}`, phone, category: 'Dental clinic', city: 'Gurugram', ...extra },
        answers: { consent: 'yes' },
        submittedAt: '2026-10-15T08:00:00.000Z',
      },
    ],
  };
}

export async function ingestSheetsLead(h: Pick<PipelineHarness, 'db' | 'clock'>, tag: string, phone: string, workspaceId: string = WS_A) {
  const input = sheetsBatch(tag, phone);
  const result = await ingestBatch(webhookCtx(h, workspaceId), input, DEPS);
  const leadId = result.records[0]!.leadId!;
  const execution = await h.db.pipelineExecution.findUniqueOrThrow({ where: { leadId } });
  return { input, leadId, execution };
}

/** A WhatsApp integration (SIMULATED) with an APPROVED first-touch template, as T32's sync stores it. */
export async function firstTouchTemplate(db: PrismaClient, workspaceId: string) {
  const integration =
    (await db.integration.findFirst({ where: { workspaceId, kind: 'WHATSAPP_CLOUD' } })) ??
    (await db.integration.create({ data: { workspaceId, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: {} } }));
  return db.whatsAppTemplate.create({
    data: {
      workspaceId,
      integrationId: integration.id,
      name: 'first_touch',
      language: 'en',
      category: 'MARKETING',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Hello {{1}}, {{2}}' }],
      variableSchema: [],
      variableMap: {},
      categoryHistory: [],
      syncedAt: new Date(NOW),
      intent: 'FIRST_TOUCH',
    },
  });
}

export async function stageRuns(db: PrismaClient, executionId: string) {
  const runs = await db.pipelineStageRun.findMany({ where: { executionId } });
  return Object.fromEntries(runs.map((r) => [r.stage, { status: r.status, reasonCode: r.reasonCode, outputRef: r.outputRef as Record<string, unknown> | null }]));
}

export async function setAutoSend(db: PrismaClient, workspaceId: string, on: boolean) {
  await db.workspaceSettings.update({ where: { workspaceId }, data: { autoSendEnabled: on } });
}
