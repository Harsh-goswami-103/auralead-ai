/**
 * The pipeline as a read-only list (06-design F13: "React Flow below 768 px is read-only with an
 * 'Edit on a larger screen' note and a list view of the stages"; also the view for people without
 * `pipeline.manage`). Stages in the order they run, each with what it does, what it runs after,
 * and what it depends on right now. Server-safe; the editor renders it too.
 */
import { ArrowDown } from 'lucide-react';
import type { PipelineApprovalMode, PipelineStage } from '@/lib/domain/enums';
import { cn } from '@/components/ui/cn';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { APPROVAL_MODE_LABELS, labelOf, orderedStages, STAGE_INFO, type EditorGraph } from './pipeline-model';

export type StageReadiness = { label: string; tone: 'success' | 'warning' | 'demo' | 'neutral' };

export function PipelineListView(props: {
  graph: EditorGraph;
  approvalMode: PipelineApprovalMode;
  readiness?: Partial<Record<PipelineStage, StageReadiness | null>>;
  note?: string;
  className?: string;
}) {
  const stages = orderedStages(props.graph);
  return (
    <div data-pipeline-list className={cn('flex flex-col gap-3', props.className)}>
      {props.note ? <p className="rounded-lg border border-border-strong bg-bg-2/60 px-3 py-2 text-sm text-fg-2">{props.note}</p> : null}
      <ol aria-label="Pipeline stages in run order" className="flex flex-col gap-1.5">
        {stages.map((s, i) => {
          const after = props.graph.edges.filter((e) => e.to === s.id).map((e) => labelOf(props.graph, e.from));
          const ready = props.readiness?.[s.kind] ?? null;
          return (
            <li key={s.id} data-stage-item={s.kind} className="flex flex-col gap-1.5">
              <div className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span aria-hidden="true" className="tabular flex size-6 shrink-0 items-center justify-center rounded-full border border-panel/35 bg-panel/12 text-xs font-semibold text-fg-1">
                    {i + 1}
                  </span>
                  <span className="text-sm font-medium text-fg-1">{STAGE_INFO[s.kind].label}</span>
                  {s.kind === 'APPROVAL' ? <span className="text-xs text-fg-2">{APPROVAL_MODE_LABELS[props.approvalMode]}</span> : null}
                  {ready ? <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', TONE_CLASSES[ready.tone])}>{ready.label}</span> : null}
                </div>
                <p className="text-xs text-fg-2">{STAGE_INFO[s.kind].description}</p>
                {after.length > 0 ? <p className="text-xs text-fg-2">Runs after {after.join(' and ')}.</p> : null}
              </div>
              {i < stages.length - 1 ? <ArrowDown aria-hidden="true" className="mx-auto size-3.5 text-fg-3" /> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
