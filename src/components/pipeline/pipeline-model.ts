/**
 * The pipeline editor's graph operations and words (T28; PRD "small validated stage set:
 * ingestion, score, draft, approval, delivery"). Pure and browser-safe. The server's validator
 * (T23, P11) is the only judge of a graph: these helpers only edit the draft the person is working
 * on, refuse connections no graph can use (a stage to itself, a repeated connection), mark the
 * connections that sit on a loop so the loop shows on the edge itself, and turn the validator's
 * issue codes into plain sentences (no raw codes on screen, ADR-66).
 */
import type { PipelineApprovalMode, PipelineStage } from '@/lib/domain/enums';

export type EditorStage = { id: string; kind: PipelineStage; label: string };
export type EditorEdge = { from: string; to: string };
export type EditorGraph = { stages: EditorStage[]; edges: EditorEdge[] };
export type EditorIssue = { code: string; message: string; nodeId?: string; edge?: EditorEdge };

export const STAGE_ORDER: readonly PipelineStage[] = ['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY'];

export const STAGE_INFO: Readonly<Record<PipelineStage, { label: string; description: string; required: boolean }>> = {
  INGESTION: { label: 'Ingestion', description: 'Normalizes and de-duplicates every new lead, then starts the run.', required: true },
  SCORE: { label: 'Score', description: 'Checks the website (LIVE only) and gives a heuristic fit score with reasons.', required: false },
  DRAFT: { label: 'Draft', description: 'Writes the first message and a quote proposal. Prices always come from the price list.', required: false },
  APPROVAL: { label: 'Approval', description: 'A person approves the first message, or policy approval when auto-send is on.', required: true },
  DELIVERY: { label: 'Delivery', description: 'Sends only what was approved, after every dispatch check.', required: false },
};

export const APPROVAL_MODE_LABELS: Readonly<Record<PipelineApprovalMode, string>> = { HUMAN: 'Human approval', POLICY_AUTO: 'Policy approval' };

/** The default five-stage template (the seeded v1): what an empty workspace starts from. */
export function defaultGraph(): EditorGraph {
  const stages = STAGE_ORDER.map((kind) => ({ id: kind.toLowerCase(), kind, label: STAGE_INFO[kind].label }));
  return { stages, edges: stages.slice(1).map((s, i) => ({ from: stages[i]!.id, to: s.id })) };
}

export const edgeKey = (e: EditorEdge): string => `${e.from}->${e.to}`;

const rank = (kind: PipelineStage) => STAGE_ORDER.indexOf(kind);

export function labelOf(graph: EditorGraph, id: string): string {
  const stage = graph.stages.find((s) => s.id === id);
  return stage ? STAGE_INFO[stage.kind].label : id;
}

/** Stages in their fixed order (the order the executor runs them). */
export function orderedStages(graph: EditorGraph): EditorStage[] {
  return [...graph.stages].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** Adds an absent stage between the closest present stages before and after it in the fixed order. */
export function addStage(graph: EditorGraph, kind: PipelineStage): EditorGraph {
  if (graph.stages.some((s) => s.kind === kind)) return graph;
  const ordered = orderedStages(graph);
  const prev = [...ordered].reverse().find((s) => rank(s.kind) < rank(kind));
  const next = ordered.find((s) => rank(s.kind) > rank(kind));
  const id = graph.stages.some((s) => s.id === kind.toLowerCase()) ? `${kind.toLowerCase()}-${graph.stages.length}` : kind.toLowerCase();
  let edges = graph.edges;
  if (prev && next) edges = edges.filter((e) => !(e.from === prev.id && e.to === next.id));
  if (prev) edges = [...edges, { from: prev.id, to: id }];
  if (next) edges = [...edges, { from: id, to: next.id }];
  return { stages: [...graph.stages, { id, kind, label: STAGE_INFO[kind].label }], edges };
}

/** Removes a stage and reconnects each stage before it to each stage after it, so the chain stays whole. */
export function removeStage(graph: EditorGraph, id: string): EditorGraph {
  const into = graph.edges.filter((e) => e.to === id && e.from !== id).map((e) => e.from);
  const outOf = graph.edges.filter((e) => e.from === id && e.to !== id).map((e) => e.to);
  let edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
  for (const from of into) for (const to of outOf) if (!edges.some((e) => e.from === from && e.to === to)) edges = [...edges, { from, to }];
  return { stages: graph.stages.filter((s) => s.id !== id), edges };
}

export type ConnectResult = { ok: true; graph: EditorGraph } | { ok: false; reason: string };

/** Adds a connection; a stage to itself, a repeated connection or an unknown stage is refused here. */
export function connect(graph: EditorGraph, from: string, to: string): ConnectResult {
  if (!graph.stages.some((s) => s.id === from) || !graph.stages.some((s) => s.id === to)) return { ok: false, reason: 'Both stages must be in the pipeline.' };
  if (from === to) return { ok: false, reason: `${labelOf(graph, from)} cannot connect to itself.` };
  if (graph.edges.some((e) => e.from === from && e.to === to)) return { ok: false, reason: `${labelOf(graph, from)} already leads to ${labelOf(graph, to)}.` };
  return { ok: true, graph: { stages: graph.stages, edges: [...graph.edges, { from, to }] } };
}

export function disconnect(graph: EditorGraph, edge: EditorEdge): EditorGraph {
  return { stages: graph.stages, edges: graph.edges.filter((e) => !(e.from === edge.from && e.to === edge.to)) };
}

function reaches(graph: EditorGraph, start: string, target: string): boolean {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === target) return true;
    for (const e of graph.edges) {
      if (e.from === at && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return false;
}

/** Keys of the connections that lie on a loop (u -> v is on a loop when v leads back to u). */
export function loopEdges(graph: EditorGraph): Set<string> {
  return new Set(graph.edges.filter((e) => reaches(graph, e.to, e.from)).map(edgeKey));
}

/** The validator's issue in words, with stage names instead of ids and kinds. */
export function issueText(graph: EditorGraph, issue: EditorIssue): string {
  const node = issue.nodeId ? labelOf(graph, issue.nodeId) : null;
  switch (issue.code) {
    case 'CYCLE':
      return 'These connections form a loop. Each lead runs every stage once, in order.';
    case 'STAGE_ORDER':
      return issue.edge ? `${labelOf(graph, issue.edge.to)} cannot come after ${labelOf(graph, issue.edge.from)}: stages run in their fixed order.` : 'The stages must run in their fixed order.';
    case 'INGESTION_REQUIRED':
      return 'Every pipeline starts with Ingestion.';
    case 'APPROVAL_REQUIRED':
      return 'The Approval stage is mandatory.';
    case 'DELIVERY_NOT_GATED':
      return 'Delivery can only come after Approval.';
    case 'UNREACHABLE_NODE':
      return `${node ?? 'A stage'} is not connected to Ingestion.`;
    case 'UNKNOWN_NODE':
      return 'A stage that is not one of the five pipeline stages was found.';
    case 'DUPLICATE_STAGE':
    case 'DUPLICATE_NODE_ID':
      return `${node ?? 'A stage'} appears twice.`;
    case 'UNKNOWN_EDGE_NODE':
      return 'A connection points at a stage that is not in the pipeline.';
    case 'APPROVAL_MODE_INVALID':
      return 'Choose human or policy approval.';
    case 'POLICY_AUTO_REQUIRES_AUTO_SEND':
      return 'Policy approval needs workspace auto-send to be on.';
    case 'GRAPH_INVALID':
      return 'The pipeline could not be read.';
    default:
      return issue.message;
  }
}

/** Issues about one connection: its own (stage order) plus "forms a loop" for a connection on a loop. */
export function edgeIssues(graph: EditorGraph, issues: readonly EditorIssue[], edge: EditorEdge, loops: ReadonlySet<string>): string[] {
  const own = issues.filter((i) => i.edge && i.edge.from === edge.from && i.edge.to === edge.to).map((i) => issueText(graph, i));
  if (loops.has(edgeKey(edge)) && issues.some((i) => i.code === 'CYCLE')) own.push('Part of a loop.');
  return own;
}

export function nodeIssues(graph: EditorGraph, issues: readonly EditorIssue[], id: string): string[] {
  return issues.filter((i) => i.nodeId === id).map((i) => issueText(graph, i));
}

/** The body the validate and save routes take. */
export function toPayloadGraph(graph: EditorGraph) {
  return { schemaVersion: 1, stages: graph.stages.map((s) => ({ id: s.id, kind: s.kind, label: s.label })), edges: graph.edges.map((e) => ({ from: e.from, to: e.to })) };
}

const graphKey = (g: EditorGraph) => JSON.stringify({ s: [...g.stages].map((s) => `${s.id}:${s.kind}`).sort(), e: g.edges.map(edgeKey).sort() });

export function sameGraph(a: EditorGraph, b: EditorGraph): boolean {
  return graphKey(a) === graphKey(b);
}

/**
 * The identity of a draft (stages, connections and approval mode, order ignored): a validation
 * verdict is shown only for the draft whose key it was computed for (ADR-84).
 */
export function draftKey(graph: EditorGraph, approvalMode: PipelineApprovalMode): string {
  return `${approvalMode}|${graphKey(graph)}`;
}

/** The stage to select once `id` is removed: the one before it in run order, else the one after. */
export function stageAfterRemoval(graph: EditorGraph, id: string): string | null {
  const ordered = orderedStages(graph);
  const at = ordered.findIndex((s) => s.id === id);
  if (at === -1) return ordered[0]?.id ?? null;
  return ordered[at - 1]?.id ?? ordered[at + 1]?.id ?? null;
}
