/**
 * LoadingSkeleton (06-design §11.3): fixed-height rows so content does not shift, announced as
 * busy with a visually hidden label. The pulse is motion-safe only.
 */
import { cn } from '@/components/ui/cn';

export function LoadingSkeleton(props: { rows?: number; label?: string; rowClassName?: string; className?: string }) {
  const rows = Math.max(1, props.rows ?? 3);
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={cn('flex flex-col gap-2', props.className)}>
      <span className="sr-only">{props.label ?? 'Loading'}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} data-skeleton-row aria-hidden="true" className={cn('h-9 rounded-md bg-bg-2 motion-safe:animate-pulse', props.rowClassName)} />
      ))}
    </div>
  );
}
