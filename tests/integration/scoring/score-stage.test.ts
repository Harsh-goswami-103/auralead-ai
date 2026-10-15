// R14, E9 (T12): the SCORE pipeline stage (enrich, then score), the `lead.score` job and the
// `lead.rescore` job, against a real migrated and seeded DB.
// - A pipeline run checks the website once, stores the score with its reasons and config version,
//   and moves on to DRAFT; a replayed SCORE job neither fetches nor scores again.
// - DEMO scores without any outbound call.
// - Rescore after activating a new config version rescores every lead of that workspace only, and
//   a rescore for a version that is no longer active changes nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createLogger } from '@/lib/logger';
import { createLeadRescoreJob, enqueueLeadRescore } from '@/server/jobs/handlers/lead-rescore';
import { createLeadScoreJob, enqueueLeadScore } from '@/server/jobs/handlers/lead-score';
import { createPipelineAdvanceJob } from '@/server/jobs/handlers/pipeline-advance';
import { enqueueJob } from '@/server/jobs/queue';
import { buildJobRegistry } from '@/server/jobs/registry';
import { ingestBatch } from '@/server/services/leads/ingest';
import { buildStageRegistry, StageRegistry } from '@/server/services/pipeline/stages';
import { ingestionStage } from '@/server/services/pipeline/stages/ingestion';
import { createScoreStage } from '@/server/services/pipeline/stages/score';
import { seedId } from '../../../prisma/seed/ids';
import { SCORING_V1 } from '../../../prisma/seed/fixtures/configs';
import { createWorker, type Worker } from '../../../worker/worker';
import { createLead, startSite, type SiteHarness } from '../enrichment/support';
import { createIngestHarness, ctxFor, DEPS, WS_A, WS_B, type IngestHarness } from '../ingest/support';

let h: IngestHarness;
let db: PrismaClient;
let site: SiteHarness;

const SCORING_V1_A = seedId('scoring-version', 'smile-avenue-dental:1');
const SCORING_V1_B = seedId('scoring-version', 'ironpulse-fitness:1');

function workerFor(mode: 'demo' | 'live'): Worker {
  const stages = new StageRegistry().register(ingestionStage).register(createScoreStage({ fetchWebsite: (url) => site.fetchWebsite(url) }));
  const registry = buildJobRegistry([
    createPipelineAdvanceJob({ stages, mode: () => mode }),
    createLeadScoreJob({ mode: () => mode }),
    createLeadRescoreJob({ mode: () => mode, batchSize: 2 }),
  ]);
  return createWorker(
    { db, clock: h.clock, registry, logger: createLogger({ level: 'silent' }), mode, version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

let live: Worker;
let demo: Worker;

beforeAll(async () => {
  h = await createIngestHarness('score-stage');
  db = h.db;
  site = await startSite();
  live = workerFor('live');
  demo = workerFor('demo');
});
afterAll(async () => {
  await site.close();
  await h.testDb.destroy();
});

async function drain(w: Worker) {
  while ((await w.tick()) === 'ran');
}

async function ingestMapsLead(tag: string, phone: string, website: string) {
  const result = await ingestBatch(
    ctxFor(db, h.clock),
    {
      source: 'GMAPS_EXTENSION',
      externalBatchId: `score-${tag}`,
      records: [{ externalId: `place-${tag}`, providerId: `place-${tag}`, fields: { name: `Score ${tag}`, phone, website, category: 'Dentist', rating: 4.6, reviewCount: 80 } }],
    },
    DEPS,
  );
  const leadId = result.records[0]!.leadId!;
  const execution = await db.pipelineExecution.findUniqueOrThrow({ where: { leadId } });
  return { leadId, execution };
}

async function runs(executionId: string) {
  const rows = await db.pipelineStageRun.findMany({ where: { executionId } });
  return Object.fromEntries(rows.map((r) => [r.stage, { status: r.status, reasonCode: r.reasonCode, outputRef: r.outputRef }]));
}

describe('SCORE pipeline stage', () => {
  it('is registered in the production stage registry', () => {
    expect(buildStageRegistry().get('SCORE')).toBeDefined();
  });

  it('enriches then scores once, records the config version and hands over to DRAFT', async () => {
    const { leadId, execution } = await ingestMapsLead('live', '+91 98111 00001', 'http://smile.test/');
    const before = site.calls.length;
    await drain(live);

    expect(site.calls.length - before).toBe(1);
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.websiteStatus).toBe('REACHABLE');
    expect(lead.websiteEnrichment).toMatchObject({ untrusted: true });
    expect(lead.scoreConfigVersionId).toBe(SCORING_V1_A);
    const reasons = lead.scoreReasons as Array<{ input: string; points: number }>;
    expect(lead.score).toBe(reasons.reduce((s, r) => s + r.points, 0));
    // phone 15 + email 0 + website 20 + rating 46/50*20=18 + reviews 80/100*15=12 + maps 0 = 65.
    expect(lead.score).toBe(65);
    expect((lead.unknownInputs as Array<{ input: string }>).map((u) => u.input)).toEqual(['categoryMatch']);

    const r = await runs(execution.id);
    expect(r.SCORE).toEqual({
      status: 'DONE',
      reasonCode: null,
      outputRef: { score: 65, scoreConfigVersionId: SCORING_V1_A, scoreConfigVersion: 1, unknownInputs: ['categoryMatch'], website: { checked: true, status: 'REACHABLE', reasonCode: null } },
    });
    // No DRAFT handler is registered in this test's stage registry: the execution waits there.
    expect(r.DRAFT).toMatchObject({ status: 'PENDING', reasonCode: 'STAGE_HANDLER_MISSING' });

    const audits = await db.auditEvent.findMany({ where: { targetId: leadId, action: { in: ['lead.enrich', 'lead.score'] } } });
    expect(audits.map((a) => a.action).sort()).toEqual(['lead.enrich', 'lead.score']);
    expect(new Set(audits.map((a) => a.correlationId)).size).toBe(1);

    // A replayed SCORE job (new key, same execution and stage) runs nothing again.
    await enqueueJob(db, h.clock, { type: 'pipeline.advance', payload: { executionId: execution.id, stage: 'SCORE' }, workspaceId: WS_A, idempotencyKey: `replay-score-${execution.id}`, correlationId: 'req_replay_score_0001' });
    await drain(live);
    expect(site.calls.length - before).toBe(1);
    expect(await db.auditEvent.count({ where: { targetId: leadId, action: 'lead.score' } })).toBe(1);
  });

  it('scores in DEMO without any outbound call; the website stays unverified and unknown', async () => {
    const { leadId, execution } = await ingestMapsLead('demo', '+91 98111 00002', 'http://smile.test/');
    const before = site.calls.length;
    await drain(demo);
    expect(site.calls.length).toBe(before);
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.websiteStatus).toBe('PRESENT_UNVERIFIED');
    expect(lead.score).toBe(45);
    expect((await runs(execution.id)).SCORE).toMatchObject({
      status: 'DONE',
      outputRef: { website: { checked: false, status: 'PRESENT_UNVERIFIED', reasonCode: 'OUTBOUND_BLOCKED_IN_DEMO' } },
    });
  });

  it('skips scoring visibly when the workspace has no active scoring config', async () => {
    await db.scoringConfigVersion.update({ where: { id: SCORING_V1_A }, data: { active: false } });
    try {
      const { leadId, execution } = await ingestMapsLead('noconfig', '+91 98111 00003', 'http://smile.test/');
      await drain(live);
      expect((await runs(execution.id)).SCORE).toMatchObject({ status: 'SKIPPED', reasonCode: 'NO_ACTIVE_SCORING_CONFIG' });
      const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
      expect(lead.score).toBeNull();
      expect(lead.websiteStatus).toBe('REACHABLE');
    } finally {
      await db.scoringConfigVersion.update({ where: { id: SCORING_V1_A }, data: { active: true } });
    }
  });
});

describe('lead.score and lead.rescore jobs', () => {
  it('lead.score scores one lead with the active config', async () => {
    const lead = await createLead(db, WS_A, { website: null, rating: 40, reviewCount: 10, firstSource: 'META_ADS' });
    await enqueueLeadScore(db, h.clock, { workspaceId: WS_A, leadId: lead.id, requestKey: 'one', correlationId: 'req_lead_score_0001' });
    await drain(live);
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    // phone 15 + email 0 + rating 16 + reviews 2 (10/100*15=1.5 rounds to 2) + form 5 = 38.
    expect(after).toMatchObject({ score: 38, scoreConfigVersionId: SCORING_V1_A });
  });

  it('rescores every lead of the workspace with a newly activated version, and only that workspace', async () => {
    const extra = await Promise.all([1, 2, 3].map(() => createLead(db, WS_A, { rating: 50, reviewCount: 200 })));
    const otherWs = await createLead(db, WS_B, { rating: 50 });
    const v2Id = 'scv_rescore_v2';
    await db.$transaction([
      db.scoringConfigVersion.update({ where: { id: SCORING_V1_A }, data: { active: false } }),
      db.scoringConfigVersion.create({
        data: { id: v2Id, workspaceId: WS_A, version: 2, active: true, createdBy: 'test', weights: { ...SCORING_V1, weights: { phonePresent: 100, emailPresent: 0, websiteStatus: 0, rating: 0, reviewCount: 0, categoryMatch: 0, sourceIntent: 0 } } },
      }),
    ]);
    await enqueueLeadRescore(db, h.clock, { workspaceId: WS_A, scoringConfigVersionId: v2Id, correlationId: 'req_rescore_0001' });
    await drain(live);

    const wsLeads = await db.lead.findMany({ where: { workspaceId: WS_A, mergedIntoLeadId: null } });
    expect(wsLeads.length).toBeGreaterThanOrEqual(extra.length);
    for (const l of wsLeads) {
      expect(l.scoreConfigVersionId).toBe(v2Id);
      expect(l.score).toBe(l.phoneE164 ? 100 : 0);
    }
    const untouched = await db.lead.findUniqueOrThrow({ where: { id: otherWs.id } });
    expect(untouched.scoreConfigVersionId).toBeNull();
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'scoring.rescore', targetId: v2Id } });
    expect(audit.summary).toEqual({ scoreConfigVersion: 2, rescored: wsLeads.length, superseded: false });
    expect(await db.lead.count({ where: { workspaceId: WS_B, scoreConfigVersionId: SCORING_V1_B } })).toBe(0);
  });

  it('a rescore for a version that is no longer active changes nothing', async () => {
    const v3Id = 'scv_rescore_v3';
    await db.$transaction([
      db.scoringConfigVersion.updateMany({ where: { workspaceId: WS_A, active: true }, data: { active: false } }),
      db.scoringConfigVersion.create({ data: { id: v3Id, workspaceId: WS_A, version: 3, active: false, createdBy: 'test', weights: SCORING_V1 } }),
      db.scoringConfigVersion.update({ where: { id: 'scv_rescore_v2' }, data: { active: true } }),
    ]);
    await enqueueLeadRescore(db, h.clock, { workspaceId: WS_A, scoringConfigVersionId: v3Id, correlationId: 'req_rescore_0002' });
    await drain(live);
    expect(await db.lead.count({ where: { workspaceId: WS_A, scoreConfigVersionId: v3Id } })).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'scoring.rescore', targetId: v3Id } });
    expect(audit.summary).toMatchObject({ rescored: 0, superseded: true });
  });
});
