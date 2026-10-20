/**
 * LoadingSkeleton (06-design §11.3): fixed-height rows so content does not shift, announced as
 * busy with a visually hidden label. Rows use the shared Skeleton (design spec §5): a bg-2 block
 * with a panel-hue shimmer that rests as a static shape under reduced motion. Use it only while
 * data is genuinely loading. Server-safe.
 */
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/skeleton';

export function LoadingSkeleton(props: { rows?: number; label?: string; rowClassName?: string; className?: string }) {
  const rows = Math.max(1, props.rows ?? 3);
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={cn('flex flex-col gap-2', props.className)}>
      <span className="sr-only">{props.label ?? 'Loading'}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} data-skeleton-row aria-hidden="true" className={cn('h-9 rounded-lg', props.rowClassName)} />
      ))}
    </div>
  );
}
