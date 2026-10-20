/**
 * JobLifecycle: a three-step rail for one job, Queued, then Running, then its outcome (Succeeded,
 * Dead or Cancelled), derived only from the job's real status and timestamps. Reached steps are
 * checked, the current step is filled in its status tone with its own icon and label, a step the
 * job skipped (cancelled or dead before it ever started) is marked "Not reached", and future steps
 * stay hollow. Every step names its state in text (aria-current on the current one), so the rail
 * never relies on color.
 *
 * Look: the rail sits in a recessed well over a faint dot grid (like the client panel's pipeline
 * stepper). Entrance, once: each node rises in and the panel-gradient rail draws on to the next
 * reached node (RailDraw, a clip reveal), so the job's progress reads left to right; it never
 * re-runs on a refresh and rests at once under reduced motion. Server-safe.
 */
import { Check, Circle, CircleDashed } from 'lucide-react';
import { RailDraw } from '@/components/client/RailDraw';
import type { StatusEntry } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { DotPattern } from '@/components/visual/Patterns';
import { Reveal } from '@/components/visual/Reveal';
import type { JobStatus } from '@/lib/domain/enums';
import { formatDateTime } from '@/lib/format/date';
import { JOB_STATUS_VOCABULARY, TONE_NODE } from './admin-vocabulary';

type StepState = 'done' | 'current' | 'skipped' | 'upcoming';
type Step = { key: string; label: string; state: StepState; entry?: StatusEntry; time: Date | null };

function steps(job: { status: JobStatus; entry: StatusEntry; createdAt: Date; runAt: Date; startedAt: Date | null; finishedAt: Date | null }): Step[] {
  const started = job.startedAt !== null;
  switch (job.status) {
    case 'QUEUED':
      return [
        { key: 'queued', label: 'Queued', state: 'current', entry: job.entry, time: job.runAt },
        { key: 'running', label: 'Running', state: 'upcoming', time: null },
        { key: 'outcome', label: 'Outcome', state: 'upcoming', time: null },
      ];
    case 'RUNNING':
      return [
        { key: 'queued', label: 'Queued', state: 'done', time: job.createdAt },
        { key: 'running', label: 'Running', state: 'current', entry: job.entry, time: job.startedAt },
        { key: 'outcome', label: 'Outcome', state: 'upcoming', time: null },
      ];
    default:
      return [
        { key: 'queued', label: 'Queued', state: 'done', time: job.createdAt },
        { key: 'running', label: 'Running', state: started ? 'done' : 'skipped', time: job.startedAt },
        { key: 'outcome', label: JOB_STATUS_VOCABULARY[job.status].label, state: 'current', entry: job.entry, time: job.finishedAt },
      ];
  }
}

const STATE_TEXT: Record<StepState, string> = { done: 'Done', current: 'Current', skipped: 'Not reached', upcoming: 'Not yet' };

/** Seconds between steps of the one-time entrance: node, then the rail to the next node. */
const STEP = 0.26;

export function JobLifecycle(props: { job: { status: JobStatus; entry: StatusEntry; createdAt: Date; runAt: Date; startedAt: Date | null; finishedAt: Date | null }; className?: string }) {
  const list = steps(props.job);
  return (
    <div className={cn('relative isolate overflow-hidden rounded-lg border border-border-subtle bg-bg-0/40 px-3 py-4 sm:px-5', props.className)}>
      <DotPattern fade="radial" className="opacity-50" />
      <ol aria-label="Job lifecycle" className="grid grid-cols-3 gap-2 sm:gap-3">
        {list.map((step, i) => {
          const Icon = step.state === 'current' && step.entry ? step.entry.icon : step.state === 'done' ? Check : step.state === 'skipped' ? CircleDashed : Circle;
          const node =
            step.state === 'current' && step.entry
              ? cn(TONE_NODE[step.entry.tone], 'ring-2')
              : step.state === 'done'
                ? 'bg-panel/14 text-panel ring-1 ring-panel/45'
                : 'bg-bg-2 text-fg-3 ring-1 ring-border-strong';
          const next = list[i + 1];
          const reached = next !== undefined && next.state !== 'upcoming' && next.state !== 'skipped';
          const arrive = 0.05 + i * STEP * 2;
          return (
            <li key={step.key} aria-current={step.state === 'current' ? 'step' : undefined} className="relative flex min-w-0 flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <Reveal as="span" delay={arrive} className="flex shrink-0 rounded-full bg-bg-1">
                  <span aria-hidden="true" className={cn('flex size-9 items-center justify-center rounded-full ring-inset', node)}>
                    <Icon className={cn('size-4', step.state === 'current' && step.entry?.spinning && 'motion-safe:animate-spin')} />
                  </span>
                </Reveal>
                {next ? (
                  <span aria-hidden="true" className="block h-0.5 flex-1 overflow-hidden rounded-full bg-border-strong">
                    {reached ? <RailDraw delay={arrive + STEP * 0.4} seconds={STEP * 1.4} className="[background-image:var(--panel-grad)]" /> : null}
                  </span>
                ) : null}
              </div>
              <Reveal delay={arrive + 0.04} className="flex min-w-0 flex-col">
                <span className={cn('text-sm font-medium', step.state === 'upcoming' || step.state === 'skipped' ? 'text-fg-2' : 'text-fg-1')}>
                  {step.state === 'current' && step.entry ? step.entry.label : step.label}
                </span>
                <span className="text-xs text-fg-2">
                  {STATE_TEXT[step.state]}
                  {step.time ? <span className="tabular block">{formatDateTime(step.time)}</span> : null}
                </span>
              </Reveal>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
