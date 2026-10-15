/**
 * PipelineConfigVersion validator (T23; P11, ADR-27, ADR-43). A pipeline is a small validated DAG
 * over the five fixed stage kinds, never a general workflow language:
 *
 *  - every node is one of INGESTION, SCORE, DRAFT, APPROVAL, DELIVERY (UNKNOWN_NODE), each kind at
 *    most once (DUPLICATE_STAGE), node ids unique (DUPLICATE_NODE_ID);
 *  - edges join known nodes (UNKNOWN_EDGE_NODE) and form no cycle, self loops included (CYCLE);
 *  - INGESTION is present (INGESTION_REQUIRED) and every node is reachable from it
 *    (UNREACHABLE_NODE);
 *  - the APPROVAL node is mandatory (APPROVAL_REQUIRED), and DELIVERY, when present, is reachable
 *    only through it (DELIVERY_NOT_GATED): nothing reaches a customer without the approval node;
 *  - every edge points forward in the fixed order and the executor's order (the same
 *    `stageOrder` the executor runs) follows it (STAGE_ORDER);
 *  - the approval mode is HUMAN or POLICY_AUTO (APPROVAL_MODE_INVALID), and POLICY_AUTO only while
 *    workspace auto-send is on (POLICY_AUTO_REQUIRES_AUTO_SEND). Dispatch checks still run at send.
 *
 * Pure: no I/O. `config.ts` runs it before saving a version; the React Flow editor (T28) shows the
 * issues per node and edge.
 */
import { z } from 'zod';
import type { PipelineApprovalMode, PipelineStage } from '@/lib/domain/enums';
import { PipelineStage as PIPELINE_STAGES } from '@/lib/domain/enums';
import { stageOrder } from './executor';

export const FIXED_STAGE_ORDER: readonly PipelineStage[] = PIPELINE_STAGES;
export const PIPELINE_GRAPH_SCHEMA_VERSION = 1;

export type PipelineIssueCode =
  | 'GRAPH_INVALID'
  | 'UNKNOWN_NODE'
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_STAGE'
  | 'UNKNOWN_EDGE_NODE'
  | 'CYCLE'
  | 'INGESTION_REQUIRED'
  | 'UNREACHABLE_NODE'
  | 'APPROVAL_REQUIRED'
  | 'DELIVERY_NOT_GATED'
  | 'STAGE_ORDER'
  | 'APPROVAL_MODE_INVALID'
  | 'POLICY_AUTO_REQUIRES_AUTO_SEND';

export type PipelineIssue = { code: PipelineIssueCode; message: string; nodeId?: string; edge?: { from: string; to: string } };

export type PipelineGraph = {
  schemaVersion: number;
  stages: Array<{ id: string; kind: PipelineStage; label: string }>;
  edges: Array<{ from: string; to: string }>;
};

export type PipelineValidation =
  | { ok: true; graph: PipelineGraph; order: PipelineStage[]; approvalMode: PipelineApprovalMode }
  | { ok: false; issues: PipelineIssue[] };

const nodeId = z.string().trim().min(1).max(64);
const rawGraphSchema = z.object({
  schemaVersion: z.literal(PIPELINE_GRAPH_SCHEMA_VERSION).optional(),
  stages: z.array(z.object({ id: nodeId, kind: z.string().min(1).max(64), label: z.string().trim().max(60).optional() })).min(1).max(16),
  edges: z.array(z.object({ from: nodeId, to: nodeId })).max(64).default([]),
});

const STAGE_INDEX = new Map(FIXED_STAGE_ORDER.map((s, i) => [s, i]));
const isStage = (kind: string): kind is PipelineStage => STAGE_INDEX.has(kind as PipelineStage);

/** Node ids reachable from `start` along the edges (start included). */
function reachableFrom(start: string, edges: ReadonlyArray<{ from: string; to: string }>, skip?: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of edges) {
      if (e.from !== at || e.to === skip || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}

function hasCycle(ids: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): boolean {
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const ready = ids.filter((id) => indegree.get(id) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const at = ready.pop()!;
    visited += 1;
    for (const e of edges) {
      if (e.from !== at) continue;
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0) ready.push(e.to);
    }
  }
  return visited !== ids.length;
}

export function validatePipelineConfig(input: { graph: unknown; approvalMode: unknown }, context: { autoSendEnabled: boolean }): PipelineValidation {
  const issues: PipelineIssue[] = [];
  const mode = input.approvalMode;
  if (mode !== 'HUMAN' && mode !== 'POLICY_AUTO') {
    issues.push({ code: 'APPROVAL_MODE_INVALID', message: 'The approval mode must be HUMAN or POLICY_AUTO.' });
  } else if (mode === 'POLICY_AUTO' && !context.autoSendEnabled) {
    issues.push({ code: 'POLICY_AUTO_REQUIRES_AUTO_SEND', message: 'Policy approval needs workspace auto-send to be on.' });
  }

  const parsed = rawGraphSchema.safeParse(input.graph);
  if (!parsed.success) return { ok: false, issues: [{ code: 'GRAPH_INVALID', message: 'The pipeline graph is not a list of stages and edges.' }, ...issues] };
  const { stages, edges } = parsed.data;

  const ids = new Set<string>();
  const kinds = new Map<PipelineStage, string>();
  for (const s of stages) {
    if (ids.has(s.id)) issues.push({ code: 'DUPLICATE_NODE_ID', message: `Node id "${s.id}" is used twice.`, nodeId: s.id });
    ids.add(s.id);
    if (!isStage(s.kind)) {
      issues.push({ code: 'UNKNOWN_NODE', message: `"${s.kind}" is not a pipeline stage.`, nodeId: s.id });
      continue;
    }
    if (kinds.has(s.kind)) issues.push({ code: 'DUPLICATE_STAGE', message: `The ${s.kind} stage appears twice.`, nodeId: s.id });
    else kinds.set(s.kind, s.id);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) issues.push({ code: 'UNKNOWN_EDGE_NODE', message: 'An edge joins a node that does not exist.', edge: e });
  }
  const knownEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const cyclic = hasCycle([...ids], knownEdges);
  if (cyclic) issues.push({ code: 'CYCLE', message: 'The stages form a loop.' });

  const ingestion = kinds.get('INGESTION');
  const approval = kinds.get('APPROVAL');
  const delivery = kinds.get('DELIVERY');
  if (ingestion === undefined) issues.push({ code: 'INGESTION_REQUIRED', message: 'Every pipeline starts with ingestion.' });
  if (approval === undefined) issues.push({ code: 'APPROVAL_REQUIRED', message: 'The approval stage is mandatory.' });

  if (ingestion !== undefined) {
    const reachable = reachableFrom(ingestion, knownEdges);
    for (const s of stages) {
      if (!reachable.has(s.id)) issues.push({ code: 'UNREACHABLE_NODE', message: `${s.label ?? s.id} is not connected to ingestion.`, nodeId: s.id });
    }
    // Delivery must not be reachable from ingestion without passing through approval.
    if (delivery !== undefined && approval !== undefined && reachable.has(delivery) && reachableFrom(ingestion, knownEdges, approval).has(delivery)) {
      issues.push({ code: 'DELIVERY_NOT_GATED', message: 'Delivery can only follow the approval stage.', nodeId: delivery });
    }
  }
  if (delivery !== undefined && approval === undefined) {
    issues.push({ code: 'DELIVERY_NOT_GATED', message: 'Delivery can only follow the approval stage.', nodeId: delivery });
  }

  const kindOf = new Map(stages.map((s) => [s.id, s.kind]));
  for (const e of knownEdges) {
    const from = kindOf.get(e.from)!;
    const to = kindOf.get(e.to)!;
    if (isStage(from) && isStage(to) && STAGE_INDEX.get(from)! >= STAGE_INDEX.get(to)! && e.from !== e.to) {
      issues.push({ code: 'STAGE_ORDER', message: `${to} cannot come after ${from}.`, edge: e });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const graph: PipelineGraph = {
    schemaVersion: PIPELINE_GRAPH_SCHEMA_VERSION,
    stages: stages.map((s) => ({ id: s.id, kind: s.kind as PipelineStage, label: s.label ?? s.kind })),
    edges: knownEdges.map((e) => ({ from: e.from, to: e.to })),
  };
  const order = stageOrder(graph);
  if (order === null || order.some((k, i) => i > 0 && STAGE_INDEX.get(order[i - 1]!)! > STAGE_INDEX.get(k)!) || order[0] !== 'INGESTION') {
    return { ok: false, issues: [{ code: 'STAGE_ORDER', message: 'The stages must run in their fixed order.' }] };
  }
  return { ok: true, graph, order, approvalMode: mode as PipelineApprovalMode };
}
