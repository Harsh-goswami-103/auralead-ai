/**
 * The workspace pipeline as a stepper rail (design spec §6 "Pipeline stages render as a stepper rail
 * with icons"): one node per stage in order, joined by the aurora gradient (zest -> aura -> volt-hi),
 * each node an icon in its own step of that gradient with the stage name underneath. The rail draws
 * itself once from the first stage (RailDraw) and each node rises in as the rail reaches it, so the
 * entrance reads left to right; under reduced motion both rest at once. The ordered list keeps the
 * stage names as text, so order and names never depend on color. `size="lg"` is the full-width
 * variant (bigger nodes and labels) for a section of its own; `inView` holds the entrance until the
 * stepper scrolls into view (for one below the fold). Server-safe.
 */
import type { CSSProperties } from 'react';
import { ArrowDownToLine, Circle, Gauge, PenLine, Send, ShieldCheck, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Reveal } from '@/components/visual/Reveal';
import { RailDraw } from './RailDraw';

const STAGE_ICONS: Readonly<Record<string, LucideIcon>> = {
  ingestion: ArrowDownToLine,
  intake: ArrowDownToLine,
  score: Gauge,
  scoring: Gauge,
  draft: PenLine,
  approval: ShieldCheck,
  delivery: Send,
  send: Send,
};

/** Five stops along --grad-aurora; a pipeline of n stages samples them evenly. */
const STOPS = [
  'var(--zest)',
  'color-mix(in oklab, var(--zest) 45%, var(--aura))',
  'var(--aura)',
  'color-mix(in oklab, var(--aura) 50%, var(--volt-hi))',
  'var(--volt-hi)',
] as const;

function stopFor(index: number, count: number): string {
  if (count <= 1) return STOPS[2];
  return STOPS[Math.round((index * (STOPS.length - 1)) / (count - 1))]!;
}

const SIZES = {
  md: { rail: 'top-4', node: 'size-8 [&>svg]:size-4', label: 'text-xs', gap: 'gap-1.5', draw: 0.42 },
  lg: { rail: 'top-5 sm:top-6', node: 'size-10 sm:size-12 [&>svg]:size-5 sm:[&>svg]:size-5.5', label: 'text-xs sm:text-sm', gap: 'gap-2', draw: 0.7 },
} as const;

export function PipelineStepper(props: { stages: string[]; label?: string; size?: 'md' | 'lg'; inView?: boolean; className?: string }) {
  const n = props.stages.length;
  if (n === 0) return null;
  const size = SIZES[props.size ?? 'md'];
  // n equal columns: the rail runs from the first node's center to the last one's.
  const railStyle: CSSProperties = { left: `${50 / n}%`, right: `${50 / n}%` };
  return (
    <div className={cn('relative', props.className)}>
      {n > 1 ? (
        <span aria-hidden="true" style={railStyle} className={cn('pointer-events-none absolute h-0.5 -translate-y-1/2', size.rail)}>
          <RailDraw seconds={size.draw} inView={props.inView} className="opacity-80 [background-image:var(--grad-aurora)]" />
        </span>
      ) : null}
      <ol aria-label={props.label ?? 'Pipeline stages'} className="relative flex items-start">
        {props.stages.map((stage, i) => {
          const Icon = STAGE_ICONS[stage.trim().toLowerCase()] ?? Circle;
          const nodeStyle = { '--node': stopFor(i, n) } as CSSProperties;
          // Each node arrives as the drawing rail reaches it.
          const delay = 0.06 + (n > 1 ? (i / (n - 1)) * size.draw : 0);
          return (
            <li key={`${stage}-${i}`} className="min-w-0 flex-1">
              <Reveal delay={delay} inView={props.inView} className={cn('flex flex-col items-center text-center', size.gap)}>
                <span
                  aria-hidden="true"
                  style={nodeStyle}
                  className={cn(
                    'relative flex items-center justify-center rounded-full bg-bg-1 text-(--node) ring-1 ring-[color-mix(in_oklab,var(--node)_50%,transparent)] before:absolute before:inset-0 before:rounded-full before:bg-[color-mix(in_oklab,var(--node)_15%,transparent)] [&>svg]:relative',
                    size.node,
                  )}
                >
                  <Icon />
                </span>
                <span className={cn('w-full truncate px-0.5 font-medium text-fg-1', size.label)}>{stage}</span>
              </Reveal>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
