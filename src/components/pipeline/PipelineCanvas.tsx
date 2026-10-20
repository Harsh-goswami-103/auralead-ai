'use client';

/**
 * The React Flow canvas of the pipeline editor (T28; @xyflow/react 12.12.0, MIT, attribution kept
 * visible as its maintainers ask, 06-design §11.8). Loaded only at 768 px and up (the editor mounts
 * it through next/dynamic, so phones never download it). Stages sit in their fixed run order; a
 * connection is drawn from a stage's right handle to another stage's left handle and removed with
 * Delete. A connection the validator rejects is drawn in the danger tone with its reason on the
 * edge itself (06-design F13), and a stage with an issue says so on the node. Every change goes
 * through the editor's callbacks; the canvas holds no state of its own. The keyboard path is the
 * editor's side panel, not the canvas.
 */
import '@xyflow/react/dist/base.css';
import { Background, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useMemo, type CSSProperties } from 'react';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import type { PipelineStage } from '@/lib/domain/enums';
import { edgeIssues, edgeKey, loopEdges, nodeIssues, orderedStages, STAGE_INFO, type EditorEdge, type EditorGraph, type EditorIssue } from './pipeline-model';

type Readiness = { label: string; tone: 'success' | 'warning' | 'demo' | 'neutral' } | null;
type StageNodeData = { kind: PipelineStage; title: string; readiness: Readiness; issues: string[]; selected: boolean };
type StageNode = Node<StageNodeData, 'stage'>;

const COLUMN = 210;
const NODE_W = 176;
const NODE_H = 72;
/** Initial geometry so edges draw before the browser has measured the nodes (and on first paint). */
const HANDLES = [
  { type: 'target' as const, position: Position.Left, x: -4, y: NODE_H / 2 - 4, width: 8, height: 8 },
  { type: 'source' as const, position: Position.Right, x: NODE_W - 4, y: NODE_H / 2 - 4, width: 8, height: 8 },
];

/** React Flow's own variables, pointed at the design tokens (no colors of its own). */
const FLOW_STYLE = {
  '--xy-background-color': 'var(--bg-1)',
  '--xy-background-pattern-color': 'var(--border-strong)',
  '--xy-edge-stroke': 'var(--text-3)',
  '--xy-edge-stroke-selected': 'var(--aura)',
  '--xy-edge-stroke-width': '1.5',
  '--xy-connectionline-stroke': 'var(--aura)',
  '--xy-handle-background-color': 'var(--aura)',
  '--xy-handle-border-color': 'var(--bg-1)',
  '--xy-attribution-background-color': 'var(--bg-2)',
  '--xy-edge-label-background-color': 'var(--bg-2)',
  '--xy-edge-label-color': 'var(--text-1)',
} as CSSProperties;

function StageNodeView({ data }: NodeProps<StageNode>) {
  const hasIssue = data.issues.length > 0;
  return (
    <div
      data-stage-node={data.kind}
      className={cn(
        'flex w-44 flex-col gap-1 rounded-lg border bg-bg-2 px-3 py-2 text-left shadow-none',
        hasIssue ? 'border-danger/60' : data.selected ? 'border-aura' : 'border-border-strong',
      )}
    >
      <Handle type="target" position={Position.Left} aria-label={`Connect into ${data.title}`} />
      <span className="text-sm font-semibold text-fg-1">{data.title}</span>
      {data.readiness ? <span className={cn('w-fit rounded-full border px-1.5 text-[10px] font-medium', TONE_CLASSES[data.readiness.tone])}>{data.readiness.label}</span> : null}
      {hasIssue ? <span className="text-[11px] leading-4 text-danger">{data.issues[0]}</span> : null}
      <Handle type="source" position={Position.Right} aria-label={`Connect from ${data.title}`} />
    </div>
  );
}

const NODE_TYPES = { stage: StageNodeView };

export type PipelineCanvasProps = {
  graph: EditorGraph;
  issues: readonly EditorIssue[];
  readiness: Partial<Record<PipelineStage, Readiness>>;
  selectedId: string | null;
  editable: boolean;
  onConnect: (from: string, to: string) => void;
  onDisconnect: (edge: EditorEdge) => void;
  onSelect: (id: string) => void;
};

export function PipelineCanvas(props: PipelineCanvasProps) {
  const { graph, issues } = props;
  const loops = useMemo(() => loopEdges(graph), [graph]);

  const nodes: StageNode[] = useMemo(
    () =>
      orderedStages(graph).map((s, i) => ({
        id: s.id,
        type: 'stage' as const,
        position: { x: i * COLUMN, y: i % 2 === 0 ? 0 : 56 },
        initialWidth: NODE_W,
        initialHeight: NODE_H,
        handles: HANDLES,
        data: { kind: s.kind, title: STAGE_INFO[s.kind].label, readiness: props.readiness[s.kind] ?? null, issues: nodeIssues(graph, issues, s.id), selected: props.selectedId === s.id },
        draggable: false,
      })),
    [graph, issues, props.readiness, props.selectedId],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const problems = edgeIssues(graph, issues, e, loops);
        const bad = problems.length > 0;
        return {
          id: edgeKey(e),
          source: e.from,
          target: e.to,
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed, color: bad ? 'var(--danger)' : 'var(--text-3)' },
          style: bad ? { stroke: 'var(--danger)', strokeWidth: 2 } : undefined,
          label: bad ? problems[0] : undefined,
          labelStyle: bad ? { fill: 'var(--danger)', fontSize: 11 } : undefined,
          labelBgStyle: bad ? { fill: 'var(--bg-2)' } : undefined,
          ariaLabel: `${STAGE_INFO[graph.stages.find((s) => s.id === e.from)?.kind ?? 'INGESTION'].label} to ${STAGE_INFO[graph.stages.find((s) => s.id === e.to)?.kind ?? 'INGESTION'].label}${bad ? `: ${problems.join(' ')}` : ''}`,
          deletable: props.editable,
        } satisfies Edge;
      }),
    [graph, issues, loops, props.editable],
  );

  return (
    <div data-pipeline-canvas className="h-80 w-full overflow-hidden rounded-lg border border-border-subtle" style={FLOW_STYLE}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={props.editable}
        elementsSelectable
        deleteKeyCode={props.editable ? ['Backspace', 'Delete'] : null}
        onConnect={(c: Connection) => {
          if (c.source && c.target) props.onConnect(c.source, c.target);
        }}
        onEdgesDelete={(deleted) => {
          for (const d of deleted) props.onDisconnect({ from: d.source, to: d.target });
        }}
        onNodeClick={(_, node) => props.onSelect(node.id)}
        minZoom={0.4}
        maxZoom={1.5}
      >
        <Background gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
