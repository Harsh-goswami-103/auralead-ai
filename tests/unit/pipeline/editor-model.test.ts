/**
 * T28 pipeline editor graph operations (pure): adding or removing an optional stage keeps the chain
 * whole in the fixed order; a stage to itself and a repeated connection are refused before the
 * server sees them; connections on a loop are found so the loop shows on the edge; the validator's
 * codes become sentences with stage names (no raw codes or kinds on screen).
 */
import { describe, expect, it } from 'vitest';
import {
  addStage,
  connect,
  defaultGraph,
  disconnect,
  edgeIssues,
  edgeKey,
  issueText,
  loopEdges,
  orderedStages,
  removeStage,
  sameGraph,
  toPayloadGraph,
} from '@/components/pipeline/pipeline-model';

const keys = (g: { edges: Array<{ from: string; to: string }> }) => g.edges.map(edgeKey).sort();

describe('pipeline editor model', () => {
  it('the default template is the five stages in a chain', () => {
    const g = defaultGraph();
    expect(orderedStages(g).map((s) => s.kind)).toEqual(['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY']);
    expect(keys(g)).toEqual(['approval->delivery', 'draft->approval', 'ingestion->score', 'score->draft']);
  });

  it('removing a stage reconnects its neighbours; adding it back restores the chain', () => {
    const without = removeStage(defaultGraph(), 'score');
    expect(without.stages.map((s) => s.kind)).not.toContain('SCORE');
    expect(keys(without)).toEqual(['approval->delivery', 'draft->approval', 'ingestion->draft']);
    const back = addStage(without, 'SCORE');
    expect(sameGraph(back, defaultGraph())).toBe(true);
    const noDelivery = removeStage(defaultGraph(), 'delivery');
    expect(keys(noDelivery)).toEqual(['draft->approval', 'ingestion->score', 'score->draft']);
    expect(keys(addStage(noDelivery, 'DELIVERY'))).toContain('approval->delivery');
    expect(addStage(defaultGraph(), 'DRAFT')).toEqual(defaultGraph());
  });

  it('refuses a stage to itself, a repeated connection and unknown stages', () => {
    const g = defaultGraph();
    expect(connect(g, 'draft', 'draft')).toEqual({ ok: false, reason: 'Draft cannot connect to itself.' });
    expect(connect(g, 'ingestion', 'score')).toEqual({ ok: false, reason: 'Ingestion already leads to Score.' });
    expect(connect(g, 'ingestion', 'nowhere')).toMatchObject({ ok: false });
    const added = connect(g, 'draft', 'score');
    expect(added.ok && keys(added.graph)).toContain('draft->score');
  });

  it('finds the connections that lie on a loop', () => {
    const added = connect(defaultGraph(), 'draft', 'score');
    if (!added.ok) throw new Error('unexpected refusal');
    expect([...loopEdges(added.graph)].sort()).toEqual(['draft->score', 'score->draft']);
    expect(loopEdges(defaultGraph()).size).toBe(0);
    expect(loopEdges(disconnect(added.graph, { from: 'draft', to: 'score' })).size).toBe(0);
  });

  it('turns issues into sentences with stage names, on the offending edge', () => {
    const added = connect(defaultGraph(), 'draft', 'score');
    if (!added.ok) throw new Error('unexpected refusal');
    const g = added.graph;
    const issues = [
      { code: 'CYCLE', message: 'The stages form a loop.' },
      { code: 'STAGE_ORDER', message: 'SCORE cannot come after DRAFT.', edge: { from: 'draft', to: 'score' } },
    ];
    const back = edgeIssues(g, issues, { from: 'draft', to: 'score' }, loopEdges(g));
    expect(back).toEqual(['Score cannot come after Draft: stages run in their fixed order.', 'Part of a loop.']);
    expect(edgeIssues(g, issues, { from: 'score', to: 'draft' }, loopEdges(g))).toEqual(['Part of a loop.']);
    expect(edgeIssues(g, issues, { from: 'ingestion', to: 'score' }, loopEdges(g))).toEqual([]);
    for (const code of ['CYCLE', 'INGESTION_REQUIRED', 'APPROVAL_REQUIRED', 'DELIVERY_NOT_GATED', 'UNREACHABLE_NODE', 'POLICY_AUTO_REQUIRES_AUTO_SEND']) {
      const sentence = issueText(g, { code, message: 'raw', nodeId: 'delivery' });
      expect(sentence).not.toMatch(/[A-Z]{2,}_[A-Z]/);
      expect(sentence).not.toMatch(/\b(INGESTION|SCORE|DRAFT|APPROVAL|DELIVERY)\b/);
    }
  });

  it('builds the body the routes take', () => {
    expect(toPayloadGraph(defaultGraph())).toMatchObject({ schemaVersion: 1, stages: expect.arrayContaining([{ id: 'approval', kind: 'APPROVAL', label: 'Approval' }]) });
  });
});
