/**
 * PartialNotice (06-design §11.3 PARTIAL column): what is shown is real, and the parts that
 * failed or are pending are named, so a partial result never passes for a complete one.
 *
 * Look (design spec §6): it matches ErrorState in the warning tone, with a 4px warning edge, the
 * icon in a tinted disc and warning bullets. The title and each item stay their own text nodes.
 */
import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/components/ui/cn';

export function PartialNotice(props: { title: string; items?: string[]; action?: ReactNode; className?: string }) {
  return (
    <div role="status" className={cn('relative flex items-start gap-3 overflow-hidden rounded-xl border border-warning/35 bg-warning/8 py-3 pr-3 pl-4', props.className)}>
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-warning" />
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning ring-1 ring-warning/35 ring-inset">
        <TriangleAlert className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-col gap-1 pt-0.5">
        <p className="font-medium text-fg-1">{props.title}</p>
        {props.items && props.items.length > 0 ? (
          <ul className="list-disc pl-4 text-fg-2 marker:text-warning">
            {props.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        {props.action}
      </div>
    </div>
  );
}
