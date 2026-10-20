/**
 * EmptyState (06-design §11.3): names what is empty and offers the real next step. Never a
 * placeholder for missing features: the action must be a working link or control.
 *
 * Look (design spec §3, §6): a small static aurora in the panel hue, then the icon in a tile with
 * three sparks orbiting it slowly. The orbit is paused offscreen and the sparks rest evenly spaced
 * under reduced motion. Everything decorative is aria-hidden; the heading and description carry
 * the meaning. Server-safe.
 */
import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { OrbitRing } from '@/components/visual/OrbitRing';

const SPARKS = ['bg-panel', 'bg-panel-2', 'bg-ice'] as const;

export function EmptyState(props: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** Heading level of the title (h2 by default; h3 inside a titled section). */
  headingLevel?: 'h2' | 'h3';
}) {
  const Heading = props.headingLevel ?? 'h2';
  return (
    <section
      className={cn(
        'relative isolate flex flex-col items-center gap-3 overflow-hidden rounded-xl border border-dashed border-border-strong bg-bg-1/70 px-6 pt-6 pb-10 text-center',
        props.className,
      )}
    >
      <AuroraBackdrop variant="empty" />
      <OrbitRing
        radius={42}
        iconSize={12}
        duration={26}
        className="-mb-1"
        center={
          <span className="flex size-12 items-center justify-center rounded-xl border border-panel/30 bg-bg-2 text-panel ring-4 ring-bg-1/60 [&>svg]:size-5">
            {props.icon ?? <Inbox aria-hidden="true" className="size-5" />}
          </span>
        }
      >
        {SPARKS.map((spark) => (
          <span key={spark} className={cn('block size-2 rounded-full ring-2 ring-bg-1', spark)} />
        ))}
      </OrbitRing>
      <Heading className="font-display text-lg font-semibold text-fg-1">{props.title}</Heading>
      {props.description ? <p className="max-w-prose text-fg-2">{props.description}</p> : null}
      {props.action ? <div className="mt-1">{props.action}</div> : null}
    </section>
  );
}
