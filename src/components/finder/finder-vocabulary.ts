/**
 * Words, icons and links of the Lead Finder screens (ADR-118, slice F1). Status is always an icon
 * plus a label (never colour alone); error codes become a sentence that says what to do. Pure data,
 * shared by the server page and the client islands.
 */
import { CircleCheck, CircleSlash, CircleX, Clock3, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import type { LeadFinderRunStatus } from '@/lib/domain/enums';
import { FINDER_ERROR_LABELS } from '@/server/services/lead-finder/schemas';

export const RUN_STATUS: Readonly<Record<LeadFinderRunStatus, { label: string; tone: StatusTone; icon: LucideIcon; spinning?: boolean }>> = {
  QUEUED: { label: 'Waiting to start', tone: 'info', icon: Clock3 },
  RUNNING: { label: 'Searching', tone: 'info', icon: LoaderCircle, spinning: true },
  SUCCEEDED: { label: 'Finished', tone: 'success', icon: CircleCheck },
  PARTIAL: { label: 'Finished with gaps', tone: 'warning', icon: TriangleAlert },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleX },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', icon: CircleSlash },
};

export function isActiveRun(status: LeadFinderRunStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

export function finderErrorText(code: string | null): string | null {
  if (!code) return null;
  return FINDER_ERROR_LABELS[code] ?? `The search stopped (${code}).`;
}

export type FinderQuery = { run?: string | null; noWebsite?: boolean; hasPhone?: boolean; notImported?: boolean; page?: number };

/** The finder page with a selected run, filters and page as query parameters. */
export function finderHref(slug: string, q: FinderQuery = {}): string {
  const params = new URLSearchParams();
  if (q.run) params.set('run', q.run);
  if (q.noWebsite) params.set('noWebsite', '1');
  if (q.hasPhone) params.set('hasPhone', '1');
  if (q.notImported) params.set('notImported', '1');
  if (q.page && q.page > 1) params.set('page', String(q.page));
  const qs = params.toString();
  return `/dashboard/employee/${encodeURIComponent(slug)}/finder${qs ? `?${qs}` : ''}`;
}

export function finderExportHref(runId: string, workspaceSlug: string): string {
  return `/api/app/finder/runs/${encodeURIComponent(runId)}/export?workspaceSlug=${encodeURIComponent(workspaceSlug)}`;
}

/** "4.5 ★ (212)" style rating words for screen readers and the grid. */
export function ratingWords(rating: number | null, reviews: number | null): string | null {
  if (rating === null) return null;
  return `${rating.toFixed(1)} of 5${reviews !== null ? `, ${reviews.toLocaleString('en-IN')} ${reviews === 1 ? 'review' : 'reviews'}` : ''}`;
}
