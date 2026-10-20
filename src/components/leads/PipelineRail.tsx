/**
 * PipelineRail (design spec §6 "Pipeline stages render as a stepper rail with icons"): the pinned
 * pipeline's stages in order, each a node with the stage icon tinted by the step's outcome, the
 * stage name, the outcome as an icon + label chip, and the reason in plain words (never a raw
 * code). Vertical on phones, a horizontal rail from lg. The connector after a finished step is
 * filled in the panel gradient and the one after a skipped step is dashed, so progress reads at a
 * glance without claiming work that did not happen; status is never color alone.
 * Each step keeps `data-stage` on the element that holds its outcome label. Steps rise in once
 * (CSS stagger). Server-safe.
 */
import { cn } from '@/components/ui/cn';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import { PIPELINE_STAGE_VOCABULARY, runReasonText, runStatusEntry } from './lead-vocabulary';
import { ToneChip } from './ToneChip';

export type PipelineStep = { stage: string; status: string; reasonCode: string | null };

const NODE_TONES: Readonly<Record<StatusTone, string>> = {
  success: 'border-success/45 bg-success/14 text-success',
  info: 'border-info/45 bg-info/14 text-info',
  warning: 'border-warning/45 bg-warning/14 text-warning',
  danger: 'border-danger/45 bg-danger/14 text-danger',
  neutral: 'border-dashed border-border-input bg-bg-2 text-fg-2',
  demo: 'border-demo/45 bg-demo/14 text-demo',
};

export function PipelineRail({ steps, className }: { steps: PipelineStep[]; className?: string }) {
  return (
    <Stagger as="ol" step="list" className={cn('grid gap-0 lg:grid-cols-5 lg:gap-3', className)}>
      {steps.map((s, i) => {
        const stage = PIPELINE_STAGE_VOCABULARY[s.stage] ?? { label: s.stage, icon: runStatusEntry(s.status).icon };
        const status = runStatusEntry(s.status);
        const StageIcon = stage.icon;
        const last = i === steps.length - 1;
        return (
          <StaggerItem as="li" key={s.stage} className="relative flex min-w-0 gap-3 pb-6 last:pb-0 lg:flex-col lg:gap-3 lg:pb-0">
            {last ? null : (
              <span
                aria-hidden="true"
                data-connector={s.status === 'DONE' ? 'done' : s.status === 'SKIPPED' ? 'skipped' : 'open'}
                className={cn(
                  'absolute top-10 bottom-1 left-[17px] lg:top-[17px] lg:right-1 lg:bottom-auto lg:left-12',
                  s.status === 'DONE'
                    ? 'w-0.5 rounded-full [background-image:var(--panel-grad)] opacity-80 lg:h-0.5 lg:w-auto'
                    : s.status === 'SKIPPED'
                      ? 'w-0 border-l-2 border-dashed border-border-input lg:h-0 lg:w-auto lg:border-t-2 lg:border-l-0'
                      : 'w-0.5 rounded-full bg-border-strong lg:h-0.5 lg:w-auto',
                )}
              />
            )}
            <span aria-hidden="true" className={cn('relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border', NODE_TONES[status.tone])}>
              <StageIcon className="size-4" />
            </span>
            <div data-stage={s.stage} className="flex min-w-0 flex-col items-start gap-1.5 pt-1 lg:pt-0">
              <span className="text-sm font-medium text-fg-1">{stage.label}</span>
              <ToneChip tone={status.tone} icon={status.icon} label={status.label} spinning={status.spinning} />
              {s.reasonCode ? <span className="text-xs text-pretty text-fg-2">{runReasonText(s.reasonCode)}</span> : null}
            </div>
          </StaggerItem>
        );
      })}
    </Stagger>
  );
}
