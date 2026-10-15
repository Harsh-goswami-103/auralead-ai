// P11, ADR-27, ADR-43 (T23): the PipelineConfigVersion validator. A graph is a validated DAG over the
// five fixed stage kinds (no general workflow language): INGESTION first, a mandatory APPROVAL node,
// DELIVERY only behind APPROVAL, stages in their fixed order, no cycles, no unknown nodes or edges.
// POLICY_AUTO approval is accepted only while workspace auto-send is on.
import { describe, expect, it } from 'vitest';
import { FIXED_STAGE_ORDER, validatePipelineConfig, type PipelineIssueCode } from '@/server/services/pipeline/validator';

const node = (id: string, kind: string) => ({ id, kind, label: id });
const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i]!, to }));

const FULL = {
  schemaVersion: 1,
  stages: [node('ingestion', 'INGESTION'), node('score', 'SCORE'), node('draft', 'DRAFT'), node('approval', 'APPROVAL'), node('delivery', 'DELIVERY')],
  edges: chain('ingestion', 'score', 'draft', 'approval', 'delivery'),
};

function codes(graph: unknown, approvalMode: unknown = 'HUMAN', autoSendEnabled = false): PipelineIssueCode[] {
  const result = validatePipelineConfig({ graph, approvalMode }, { autoSendEnabled });
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe('validatePipelineConfig', () => {
  it('accepts the seeded five-stage graph with HUMAN approval and returns the execution order', () => {
    const result = validatePipelineConfig({ graph: FULL, approvalMode: 'HUMAN' }, { autoSendEnabled: false });
    expect(result).toMatchObject({ ok: true, approvalMode: 'HUMAN', order: [...FIXED_STAGE_ORDER] });
    expect(FIXED_STAGE_ORDER).toEqual(['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY']);
  });

  it('accepts POLICY_AUTO only while workspace auto-send is on', () => {
    expect(codes(FULL, 'POLICY_AUTO', false)).toEqual(['POLICY_AUTO_REQUIRES_AUTO_SEND']);
    expect(codes(FULL, 'POLICY_AUTO', true)).toEqual([]);
  });

  it('rejects an approval mode that is neither HUMAN nor POLICY_AUTO', () => {
    expect(codes(FULL, 'AUTO')).toEqual(['APPROVAL_MODE_INVALID']);
  });

  it('rejects a cycle (including a self loop)', () => {
    expect(codes({ ...FULL, edges: [...FULL.edges, { from: 'delivery', to: 'score' }] })).toContain('CYCLE');
    expect(codes({ ...FULL, edges: [...FULL.edges, { from: 'draft', to: 'draft' }] })).toContain('CYCLE');
  });

  it('rejects an unknown node kind and an edge to an unknown node', () => {
    const unknownKind = { ...FULL, stages: [...FULL.stages, node('webhook', 'WEBHOOK_CALL')], edges: [...FULL.edges, { from: 'delivery', to: 'webhook' }] };
    expect(codes(unknownKind)).toContain('UNKNOWN_NODE');
    expect(codes({ ...FULL, edges: [...FULL.edges, { from: 'delivery', to: 'ghost' }] })).toContain('UNKNOWN_EDGE_NODE');
  });

  it('rejects a graph without the mandatory approval node', () => {
    const noApproval = {
      stages: [node('ingestion', 'INGESTION'), node('score', 'SCORE'), node('draft', 'DRAFT'), node('delivery', 'DELIVERY')],
      edges: chain('ingestion', 'score', 'draft', 'delivery'),
    };
    expect(codes(noApproval)).toContain('APPROVAL_REQUIRED');
    // Even a graph that stops before delivery needs the approval node.
    expect(codes({ stages: [node('ingestion', 'INGESTION'), node('score', 'SCORE')], edges: chain('ingestion', 'score') })).toContain('APPROVAL_REQUIRED');
  });

  it('rejects delivery that is not behind approval, and stages out of their fixed order', () => {
    const bypass = { ...FULL, edges: [...chain('ingestion', 'score', 'draft', 'approval'), { from: 'draft', to: 'delivery' }] };
    expect(codes(bypass)).toContain('DELIVERY_NOT_GATED');
    const swapped = { ...FULL, edges: chain('ingestion', 'draft', 'score', 'approval', 'delivery') };
    expect(codes(swapped)).toContain('STAGE_ORDER');
  });

  it('rejects duplicates, a missing ingestion root and unreachable nodes', () => {
    expect(codes({ ...FULL, stages: [...FULL.stages, node('approval', 'APPROVAL')] })).toContain('DUPLICATE_NODE_ID');
    expect(codes({ ...FULL, stages: [...FULL.stages, node('approval2', 'APPROVAL')], edges: [...FULL.edges, { from: 'draft', to: 'approval2' }] })).toContain('DUPLICATE_STAGE');
    expect(codes({ stages: FULL.stages.slice(1), edges: chain('score', 'draft', 'approval', 'delivery') })).toContain('INGESTION_REQUIRED');
    expect(codes({ ...FULL, edges: chain('ingestion', 'score', 'draft') })).toContain('UNREACHABLE_NODE');
  });

  it('accepts a graph that omits optional stages (score, delivery) when the order and gate hold', () => {
    const lean = { stages: [node('in', 'INGESTION'), node('dr', 'DRAFT'), node('ap', 'APPROVAL')], edges: chain('in', 'dr', 'ap') };
    expect(validatePipelineConfig({ graph: lean, approvalMode: 'HUMAN' }, { autoSendEnabled: false })).toMatchObject({ ok: true, order: ['INGESTION', 'DRAFT', 'APPROVAL'] });
  });

  it('rejects malformed graphs with GRAPH_INVALID and names the node in each issue', () => {
    expect(codes(null)).toEqual(['GRAPH_INVALID']);
    expect(codes({ stages: 'x' })).toEqual(['GRAPH_INVALID']);
    const result = validatePipelineConfig({ graph: { ...FULL, stages: [...FULL.stages, node('x', 'TELEPORT')] }, approvalMode: 'HUMAN' }, { autoSendEnabled: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.find((i) => i.code === 'UNKNOWN_NODE')).toMatchObject({ nodeId: 'x' });
  });
});
