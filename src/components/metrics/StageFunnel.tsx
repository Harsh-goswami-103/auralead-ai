/**
 * Leads by sales stage (06-design §11.1 "Funnel by sales stage"): the forward stages in order
 * (New to Converted) as labelled bars, then Lost on its own line, because a lost lead is not a
 * step of the funnel. Each line says its count and its share of all leads in text; the bar is
 * decorative (aria-hidden) and sized against the largest stage, drawn at its final width (no
 * animation of the value). Stage chips reuse the shared sales-stage vocabulary (icon + label).
 * Server-safe.
 */
import { salesStageEntry } from '@/components/leads/lead-vocabulary';
import { cn } from '@/components/ui/cn';

export type FunnelStage = { stage: string; count: number };

const share = (count: number, total: number) => (total === 0 ? '0%' : `${Math.round((count / total) * 100)}%`);

function StageLine(props: { stage: FunnelStage; total: number; max: number; muted?: boolean }) {
  const entry = salesStageEntry(props.stage.stage);
  const Icon = entry.icon;
  const width = props.max === 0 ? 0 : Math.max(props.stage.count > 0 ? 2 : 0, (props.stage.count / props.max) * 100);
  return (
    <li className="grid grid-cols-[minmax(7.5rem,9.5rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-y-1.5">
      <span className="flex min-w-0 items-center gap-2 text-fg-1">
        <Icon aria-hidden="true" className={cn('size-4 shrink-0', props.muted ? 'text-fg-3' : 'text-panel')} />
        <span className="truncate">{entry.label}</span>
      </span>
      <span aria-hidden="true" className="block h-2 overflow-hidden rounded-full bg-bg-2 ring-1 ring-border-subtle ring-inset max-sm:order-3 max-sm:col-span-2">
        <span className={cn('block h-full rounded-full', props.muted ? 'bg-fg-3/60' : '[background-image:var(--panel-grad)]')} style={{ width: `${width}%` }} />
      </span>
      <span className="tabular text-right whitespace-nowrap text-fg-1">
        {props.stage.count.toLocaleString('en-IN')}
        <span className="ml-1.5 text-xs text-fg-2">{share(props.stage.count, props.total)}</span>
      </span>
    </li>
  );
}

export function StageFunnel(props: { stages: FunnelStage[]; total: number }) {
  const forward = props.stages.filter((s) => s.stage !== 'LOST');
  const lost = props.stages.find((s) => s.stage === 'LOST');
  const max = Math.max(0, ...props.stages.map((s) => s.count));
  return (
    <div className="flex flex-col gap-4">
      <ol aria-label="Leads in each forward sales stage" className="flex flex-col gap-3">
        {forward.map((s) => (
          <StageLine key={s.stage} stage={s} total={props.total} max={max} />
        ))}
      </ol>
      {lost ? (
        <ul aria-label="Leads marked lost" className="border-t border-border-subtle pt-3">
          <StageLine stage={lost} total={props.total} max={max} muted />
        </ul>
      ) : null}
    </div>
  );
}
