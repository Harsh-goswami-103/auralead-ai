/**
 * InlineEmpty: the quiet "nothing here yet" row inside a section (a job that has not run, no
 * rejected deliveries, a result not produced yet): a dashed outline, a neutral icon and one plain
 * sentence, the same everywhere in the admin pages. For a whole empty list use EmptyState.
 * Server-safe.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export function InlineEmpty(props: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-center gap-2.5 rounded-lg border border-dashed border-border-strong px-3 py-3.5 text-sm text-fg-2', props.className)}>
      <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-bg-2 text-fg-3 [&>svg]:size-3.5">
        {props.icon}
      </span>
      {props.children}
    </p>
  );
}
