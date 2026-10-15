/**
 * EmptyState (06-design §11.3): names what is empty and offers the real next step. Never a
 * placeholder for missing features: the action must be a working link or control.
 */
import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '@/components/ui/cn';

export function EmptyState(props: { title: string; description?: string; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong bg-bg-1 px-6 py-10 text-center', props.className)}>
      <span className="flex size-10 items-center justify-center rounded-full border border-border-subtle bg-bg-2 text-fg-2">
        {props.icon ?? <Inbox aria-hidden="true" className="size-5" />}
      </span>
      <h2 className="text-lg font-semibold text-fg-1">{props.title}</h2>
      {props.description ? <p className="max-w-prose text-fg-2">{props.description}</p> : null}
      {props.action ? <div className="mt-1">{props.action}</div> : null}
    </section>
  );
}
