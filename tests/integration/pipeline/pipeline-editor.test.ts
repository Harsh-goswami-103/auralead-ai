// T28 pipeline editor read model and dry-run validation (PRD "React Flow pipeline (small validated
// stage set: ingestion, score, draft, approval, delivery; persisted; rejects cycles/unsupported;
// executed)"; 06-design "Pipeline: canvas, validation panel, persisted versions and execution status
// per stage"). The editor reads the active version, every version, per-stage execution counts and
// what each stage depends on; the dry run is T23's validator with nothing written; saving is T23's
// `savePipelineConfig` (CAS on the version the editor saw, version N+1 active).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermissionDeniedError } from '@/lib/errors';
import { savePipelineConfig } from '@/server/services/pipeline/config';
import { getPipelineEditor, validatePipelineDraft } from '@/server/services/pipeline/editor';
import { seedId } from '../../../prisma/seed/ids';
import { createIntegrationsHarness, employeeCtx, liveOwnerCtx, nehaCtx, WS_A, type IntegrationsHarness } from '../integrations/support';

let h: IntegrationsHarness;

const STAGES = [
  { id: 'ingestion', kind: 'INGESTION', label: 'Ingestion' },
  { id: 'score', kind: 'SCORE', label: 'Score' },
  { id: 'draft', kind: 'DRAFT', label: 'Draft' },
  { id: 'approval', kind: 'APPROVAL', label: 'Approval' },
  { id: 'delivery', kind: 'DELIVERY', label: 'Delivery' },
];
const CHAIN = [
  { from: 'ingestion', to: 'score' },
  { from: 'score', to: 'draft' },
  { from: 'draft', to: 'approval' },
  { from: 'approval', to: 'delivery' },
];

beforeAll(async () => {
  h = await createIntegrationsHarness('pipeline-editor');
}, 120_000);

afterAll(async () => {
  await h?.testDb.destroy();
});

describe('pipeline editor read model', () => {
  it('shows the seeded v1 with its five stages in order, editable for pipeline.manage', async () => {
    const view = await getPipelineEditor(await employeeCtx(h));
    expect(view.canEdit).toBe(true);
    expect(view.active).toMatchObject({ version: 1, approvalMode: 'HUMAN' });
    expect(view.active!.graph.stages.map((s) => s.kind)).toEqual(['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY']);
    expect(view.active!.graph.edges).toEqual(CHAIN);
    expect(view.versions.map((v) => [v.version, v.active])).toEqual([[1, true]]);
    expect(view.autoSendEnabled).toBe(false);
    for (const stage of ['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY'] as const) expect(view.stats[stage]).toEqual({ done: 0, pending: 0, running: 0, skipped: 0, failed: 0 });
  });

  it('counts stage runs of this workspace only', async () => {
    const lead = await h.db.lead.create({ data: { workspaceId: WS_A, displayName: 'Stats lead', nameNormalized: 'stats lead', alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL' } });
    const execution = await h.db.pipelineExecution.create({ data: { workspaceId: WS_A, leadId: lead.id, pipelineConfigVersionId: seedId('pipeline-version', 'smile-avenue-dental:1'), currentStage: 'APPROVAL' } });
    for (const [stage, status] of [
      ['INGESTION', 'DONE'],
      ['SCORE', 'SKIPPED'],
      ['DRAFT', 'DONE'],
      ['APPROVAL', 'FAILED'],
    ] as const) {
      await h.db.pipelineStageRun.create({ data: { workspaceId: WS_A, executionId: execution.id, stage, status } });
    }
    const view = await getPipelineEditor(await employeeCtx(h));
    expect(view.stats.INGESTION).toMatchObject({ done: 1 });
    expect(view.stats.SCORE).toMatchObject({ skipped: 1 });
    expect(view.stats.APPROVAL).toMatchObject({ failed: 1 });
    expect(view.stats.DELIVERY).toEqual({ done: 0, pending: 0, running: 0, skipped: 0, failed: 0 });
    expect((await getPipelineEditor(await nehaCtx(h))).stats.INGESTION.done).toBe(0);
  });

  it('says what the draft and delivery stages run on (DEMO: local generator and demo transports)', async () => {
    const demo = await getPipelineEditor(await employeeCtx(h));
    expect(demo.readiness.DRAFT).toMatchObject({ tone: 'demo' });
    expect(demo.readiness.DELIVERY).toMatchObject({ tone: 'demo' });
    const live = await getPipelineEditor(await liveOwnerCtx(h));
    expect(live.active).toBeNull();
    expect(live.readiness.DRAFT).toMatchObject({ tone: 'warning' });
    expect(live.readiness.DELIVERY).toMatchObject({ tone: 'warning' });
  });

  it('a leads.read assignment reads it without editing', async () => {
    const view = await getPipelineEditor(await nehaCtx(h));
    expect(view.canEdit).toBe(false);
    expect(view.active).toMatchObject({ version: 1 });
  });
});

describe('dry-run validation', () => {
  it('a backward edge is a cycle and a stage-order error on that edge; nothing is written', async () => {
    const before = await h.db.pipelineConfigVersion.count({ where: { workspaceId: WS_A } });
    const result = await validatePipelineDraft(await employeeCtx(h), { graph: { schemaVersion: 1, stages: STAGES, edges: [...CHAIN, { from: 'draft', to: 'score' }] }, approvalMode: 'HUMAN' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['CYCLE', 'STAGE_ORDER']));
    expect(result.issues.find((i) => i.code === 'STAGE_ORDER')!.edge).toEqual({ from: 'draft', to: 'score' });
    expect(await h.db.pipelineConfigVersion.count({ where: { workspaceId: WS_A } })).toBe(before);
  });

  it('a graph without the optional score stage is valid; policy approval needs auto-send', async () => {
    const graph = { schemaVersion: 1, stages: STAGES.filter((s) => s.kind !== 'SCORE'), edges: [{ from: 'ingestion', to: 'draft' }, ...CHAIN.slice(2)] };
    expect(await validatePipelineDraft(await employeeCtx(h), { graph, approvalMode: 'HUMAN' })).toMatchObject({ ok: true, order: ['INGESTION', 'DRAFT', 'APPROVAL', 'DELIVERY'] });
    const auto = await validatePipelineDraft(await employeeCtx(h), { graph, approvalMode: 'POLICY_AUTO' });
    expect(auto.ok).toBe(false);
    if (!auto.ok) expect(auto.issues.map((i) => i.code)).toContain('POLICY_AUTO_REQUIRES_AUTO_SEND');
  });

  it('needs pipeline.manage (403)', async () => {
    await expect(validatePipelineDraft(await nehaCtx(h), { graph: { stages: STAGES, edges: CHAIN }, approvalMode: 'HUMAN' })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('saving through T23 makes v2 the active version the editor shows', async () => {
    const ctx = await employeeCtx(h);
    const graph = { schemaVersion: 1, stages: STAGES.filter((s) => s.kind !== 'SCORE'), edges: [{ from: 'ingestion', to: 'draft' }, ...CHAIN.slice(2)] };
    await savePipelineConfig(ctx, { graph, approvalMode: 'HUMAN', expectedVersion: 1 });
    const view = await getPipelineEditor(await employeeCtx(h));
    expect(view.active).toMatchObject({ version: 2 });
    expect(view.active!.graph.stages.map((s) => s.kind)).toEqual(['INGESTION', 'DRAFT', 'APPROVAL', 'DELIVERY']);
    expect(view.versions.map((v) => [v.version, v.active])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(view.versions[0]!.createdByName).toBe('Imran Qureshi');
  });
});
