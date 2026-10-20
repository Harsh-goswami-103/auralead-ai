/**
 * SectionCard (design spec §4): the standard panel section surface (rounded-xl, subtle border,
 * bg-1 at 80%) with an optional header row: title (Manrope, h2 by default) + meta on the left,
 * actions on the right, wrapping on narrow screens. `min-w-0` is baked in so wide children
 * (tables in `relative overflow-x-auto` wrappers) scroll inside the card instead of pushing the
 * page sideways. `accent` adds the 2px panel hairline on top. A titled card is a labelled region.
 * Server-safe (useId works in Server Components).
 */
import { useId, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export function SectionCard(props: {
  title?: ReactNode;
  titleAs?: 'h2' | 'h3';
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  accent?: boolean;
  id?: string;
}) {
  const headingId = useId();
  const Heading = props.titleAs ?? 'h2';
  const hasHeader = Boolean(props.title || props.meta || props.actions);
  return (
    <section
      id={props.id}
      aria-labelledby={props.title ? headingId : undefined}
      className={cn('relative flex min-w-0 flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5', props.className)}
    >
      {props.accent ? (
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 -top-px h-0.5 rounded-full [background-image:var(--grad-hairline)]" />
      ) : null}
      {hasHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            {props.title ? (
              <Heading id={headingId} className="font-display text-lg font-semibold text-fg-1">
                {props.title}
              </Heading>
            ) : null}
            {props.meta ? <div className="text-xs text-fg-2">{props.meta}</div> : null}
          </div>
          {props.actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div> : null}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}
