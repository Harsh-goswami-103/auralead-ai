/**
 * A status chip for states that are not an IntegrationStatus or a delivery status (raw provider
 * strings, webhook deliveries, batches): icon plus label on the shared tone classes, so color is
 * never the only signal (06-design F2). Server-safe.
 */
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import type { RawStatusEntry } from './vocabulary';

export function StatusChip({ entry, className, title }: { entry: RawStatusEntry; className?: string; title?: string }) {
  const Icon = entry.icon;
  return (
    <span
      data-status-chip
      data-tone={entry.tone}
      title={title}
      className={cn('inline-flex w-fit max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', TONE_CLASSES[entry.tone], className)}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{entry.label}</span>
    </span>
  );
}
