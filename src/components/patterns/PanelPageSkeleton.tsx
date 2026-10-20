/**
 * PanelPageSkeleton (design spec §6 "System pages"): the loading shape of a panel page. It shows a
 * PageHeader-shaped band (eyebrow, h1 bar, description bar, all over the header aurora), a row of
 * stat tiles, then section cards with table-like rows. It is one polite status region labelled
 * `label`, and every shape is aria-hidden. Shapes shimmer in the panel hue and rest under reduced
 * motion. Server-safe.
 *
 * Do not mount it as a `loading.tsx` above a page that calls notFound() or redirect(). A segment
 * loading boundary starts streaming with status 200 before the page runs, so such a page's 404
 * becomes a soft 404 (200 + noindex) and its 307 becomes a meta refresh (Next 16 docs,
 * loading.js "Status codes"). Use it as the fallback of an in-page <Suspense> placed after the
 * page's access checks instead.
 */
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/skeleton';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';

export function PanelPageSkeleton(props: { label?: string; tiles?: number; sections?: number; className?: string }) {
  const tiles = Math.max(0, props.tiles ?? 4);
  const sections = Math.max(1, props.sections ?? 2);
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={cn('flex flex-col gap-6', props.className)}>
      <span className="sr-only">{props.label ?? 'Loading this page'}</span>
      <div aria-hidden="true" className="relative isolate flex flex-col gap-3 pb-1">
        <AuroraBackdrop variant="header" />
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-panel/60" />
          <Skeleton className="h-3 w-28 rounded-sm" />
        </div>
        <Skeleton className="h-8 w-[min(22rem,80%)] rounded-md" />
        <Skeleton className="h-4 w-[min(34rem,95%)] rounded-sm" />
      </div>
      {tiles > 0 ? (
        <div aria-hidden="true" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: tiles }, (_, i) => (
            <div key={i} className="relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80 p-4">
              <span className="absolute inset-x-0 top-0 h-0.5 [background-image:var(--panel-grad)] opacity-50" />
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-3.5 w-24 rounded-sm" />
                  <Skeleton className="h-7 w-16 rounded-md" />
                </div>
                <Skeleton className="size-9 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div aria-hidden="true" className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {Array.from({ length: sections }, (_, i) => (
          <div key={i} className={cn('flex min-w-0 flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5', i === 0 && 'xl:col-span-2')}>
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-5 w-40 rounded-sm" />
              <Skeleton className="h-3.5 w-20 rounded-sm" />
            </div>
            {Array.from({ length: 4 }, (_, row) => (
              <Skeleton key={row} className="h-9 rounded-lg" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
