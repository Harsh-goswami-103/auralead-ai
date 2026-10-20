/**
 * StatusChip: one admin status as tone tint + icon + text label (TONE_CLASSES, the StatusBadge
 * recipe without the Simulated/Live chip, since jobs and attempts are not simulator output).
 * Color is never the only signal; the icon is decorative and the label is the accessible text.
 * `data-status-chip` carries the raw state for tests and tooling. Server-safe.
 */
import { TONE_CLASSES, type StatusEntry } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';

export function StatusChip(props: { entry: StatusEntry; state?: string; size?: 'sm' | 'md'; className?: string }) {
  const { entry } = props;
  const Icon = entry.icon;
  const md = props.size === 'md';
  return (
    <span
      data-status-chip={props.state}
      data-tone={entry.tone}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        md ? 'px-2.5 py-1 text-sm' : 'px-2 py-0.5 text-xs',
        TONE_CLASSES[entry.tone],
        props.className,
      )}
    >
      <Icon aria-hidden="true" className={cn('shrink-0', md ? 'size-4' : 'size-3.5', entry.spinning && 'motion-safe:animate-spin')} />
      {entry.label}
    </span>
  );
}
