/**
 * ToneChip: the status chip of the operator panel (design spec §0.2, §6): tone tint + icon + text
 * label from the shared TONE_CLASSES, never color alone. Used for sales stages, pipeline step
 * outcomes, approval and dispatch states. Extra data attributes pass through so pages keep the
 * hooks tests read (data-approval-status, data-dispatch-state, ...). Server-safe.
 */
import type { LucideIcon } from 'lucide-react';
import { TONE_CLASSES, type StatusTone } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';

export function ToneChip(props: {
  tone: StatusTone;
  icon: LucideIcon;
  label: string;
  spinning?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  /** Data attributes for the chip element, e.g. { 'data-approval-status': 'PENDING' }. */
  attrs?: Record<`data-${string}`, string | undefined>;
}) {
  const Icon = props.icon;
  return (
    <span
      {...props.attrs}
      data-tone={props.tone}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        props.size === 'md' ? 'px-2.5 py-1 text-sm' : 'px-2 py-0.5 text-xs',
        TONE_CLASSES[props.tone],
        props.className,
      )}
    >
      <Icon aria-hidden="true" className={cn('shrink-0', props.size === 'md' ? 'size-4' : 'size-3.5', props.spinning && 'motion-safe:animate-spin')} />
      {props.label}
    </span>
  );
}
