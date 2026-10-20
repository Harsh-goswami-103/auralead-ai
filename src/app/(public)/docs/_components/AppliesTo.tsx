/**
 * "Applies to: DEMO / LIVE" (plan T37). Each mode is a tag with an icon and its name, never color
 * alone. DEMO uses the orange --demo token, which is reserved for DEMO (design spec §0.3); LIVE is a
 * neutral tag. The checked date says when the page was last compared with the code. Server-safe.
 */
import { CalendarCheck, FlaskConical, Radio } from 'lucide-react';
import { formatCheckedDate, type DocMode } from '@content/docs/format';
import { cn } from '@/components/ui/cn';

const TAG: Readonly<Record<DocMode, { icon: typeof Radio; className: string }>> = {
  DEMO: { icon: FlaskConical, className: 'border-demo/40 bg-demo/12 text-demo' },
  LIVE: { icon: Radio, className: 'border-border-strong bg-bg-2 text-fg-1' },
};

export function ModeTag({ mode }: { mode: DocMode }) {
  const { icon: Icon, className } = TAG[mode];
  return (
    <span data-mode-tag={mode} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] leading-4 font-semibold tracking-wide', className)}>
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      {mode}
    </span>
  );
}

export function AppliesTo({ modes, className }: { modes: readonly DocMode[]; className?: string }) {
  return (
    <p data-applies-to={modes.join(' ')} className={cn('flex flex-wrap items-center gap-1.5 text-xs text-fg-2', className)}>
      <span>Applies to:</span>
      {modes.map((m) => (
        <ModeTag key={m} mode={m} />
      ))}
    </p>
  );
}

export function CheckedDate({ iso }: { iso: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-2">
      <CalendarCheck aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        Checked against the code on <time dateTime={iso}>{formatCheckedDate(iso)}</time>
      </span>
    </span>
  );
}
