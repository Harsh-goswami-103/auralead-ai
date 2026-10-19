/**
 * PageHeader (design spec §4): the top of every panel page. An aurora band in the panel hues sits
 * behind it (AuroraBackdrop 'header', <= 16% under text), then an eyebrow with the panel-hue dot,
 * the page h1 in the panel gradient (the one gradient text of the view), an optional description
 * and meta line ("As of ..."), and actions that sit right-aligned from sm and stack under the
 * text on phones. The h1's text is exactly `title` (tests find pages by heading name). Text rises
 * in once with Reveal (h1 uses the focus pull). Server-safe.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { Reveal } from '@/components/visual/Reveal';

export function PageHeader(props: {
  title: string;
  /** Small uppercase line above the title, e.g. the panel or section name. */
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Secondary facts under the description, e.g. "As of 19 Oct, 10:42". */
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header data-page-header="" className={cn('relative isolate flex flex-col gap-4 pb-1 sm:flex-row sm:items-end sm:justify-between', props.className)}>
      <AuroraBackdrop variant="header" />
      <div className="flex min-w-0 flex-col gap-2">
        {props.eyebrow ? (
          <Reveal as="p" className="flex items-center gap-2 text-xs font-medium tracking-[0.14em] text-fg-2 uppercase">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-panel" />
            {props.eyebrow}
          </Reveal>
        ) : null}
        <Reveal as="h1" variant="focus" delay={0.04} className="text-gradient w-fit max-w-full font-display text-2xl font-semibold text-balance sm:text-3xl">
          {props.title}
        </Reveal>
        {props.description ? (
          <Reveal delay={0.08} className="max-w-prose text-fg-2">
            {props.description}
          </Reveal>
        ) : null}
        {props.meta ? (
          <Reveal delay={0.1} className="text-xs text-fg-2">
            {props.meta}
          </Reveal>
        ) : null}
      </div>
      {props.actions ? (
        <Reveal delay={0.12} className="flex shrink-0 flex-wrap items-center gap-2">
          {props.actions}
        </Reveal>
      ) : null}
    </header>
  );
}
