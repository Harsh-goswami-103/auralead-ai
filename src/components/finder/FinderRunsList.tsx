'use client';

/**
 * The workspace's recent Lead Finder runs (ADR-118, slice F1): each with its keywords and
 * locations, status (icon + label), a progress bar over its keyword x location searches, the
 * places found, and the Simulated chip for DEMO runs. While a run waits or searches, the page is
 * re-read on the operator polling schedule (`usePolling`); once the schedule runs out it says the
 * worker is late instead of polling forever. A run that can still be stopped has "Cancel"
 * (needs `finder.run`).
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleStop } from 'lucide-react';
import { toast } from 'sonner';
import { ToneChip } from '@/components/leads/ToneChip';
import { usePolling } from '@/components/leads/use-polling';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';
import type { FinderRunDto } from '@/server/services/lead-finder/runs';
import { finderErrorText, finderHref, isActiveRun, RUN_STATUS } from './finder-vocabulary';

export function FinderRunsList(props: { runs: FinderRunDto[]; selectedId: string | null; workspaceSlug: string; timeZone: string; cancelGate: Gate | null }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const active = props.runs.some((r) => isActiveRun(r.status));
  const { exhausted } = usePolling(active, () => router.refresh());

  async function cancel(runId: string) {
    const res = await postJson(`/api/app/finder/runs/${encodeURIComponent(runId)}/cancel`, { workspaceSlug: props.workspaceSlug }, csrfToken);
    if (!res.ok) {
      toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
      return;
    }
    toast.success('Search cancelled.', { description: 'Places already found stay in the list.' });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Recent searches" className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {props.runs.map((run) => {
          const status = RUN_STATUS[run.status];
          const percent = run.cellsTotal === 0 ? 0 : Math.round((run.cellsDone / run.cellsTotal) * 100);
          const selected = run.id === props.selectedId;
          const error = finderErrorText(run.errorCode);
          return (
            <li key={run.id} data-run-id={run.id} data-run-status={run.status} className={cn('flex flex-col gap-2 px-3 py-3 text-sm', selected && 'bg-panel/8')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={finderHref(props.workspaceSlug, { run: run.id })} aria-current={selected ? 'true' : undefined} className="min-w-0 font-medium text-fg-1 underline-offset-4 hover:underline">
                  {run.keywords.join(', ')} <span className="font-normal text-fg-2">in</span> {run.locations.join(', ')}
                </Link>
                <span className="flex flex-wrap items-center gap-2">
                  <ToneChip tone={status.tone} icon={status.icon} label={status.label} spinning={status.spinning} />
                  {run.simulated ? <ModeChip simulated /> : null}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div
                  role="progressbar"
                  aria-label={`Searches done for ${run.keywords.join(', ')}`}
                  aria-valuemin={0}
                  aria-valuemax={run.cellsTotal}
                  aria-valuenow={run.cellsDone}
                  aria-valuetext={`${run.cellsDone} of ${run.cellsTotal} searches done`}
                  className="h-1.5 w-40 overflow-hidden rounded-full bg-bg-3"
                >
                  <div className="h-full rounded-full bg-cyan transition-[width] duration-fast" style={{ width: `${percent}%` }} />
                </div>
                <span className="tabular text-xs text-fg-2">
                  {run.cellsDone} of {run.cellsTotal} {run.cellsTotal === 1 ? 'search' : 'searches'} · {run.resultsFound.toLocaleString('en-IN')} {run.resultsFound === 1 ? 'place' : 'places'}
                  {run.extractEmails ? ` · ${run.emailsFound.toLocaleString('en-IN')} ${run.emailsFound === 1 ? 'email' : 'emails'}` : ''}
                </span>
                <span className="text-xs text-fg-3">Started {formatDateTime(new Date(run.createdAt), props.timeZone)}</span>
                {isActiveRun(run.status) ? (
                  <GatedAction label="Cancel" pendingLabel="Cancelling..." size="sm" variant="ghost" icon={<CircleStop aria-hidden="true" />} gate={props.cancelGate} onAction={() => cancel(run.id)} />
                ) : null}
              </div>
              {error ? <p className="text-xs text-fg-2">{error}</p> : null}
            </li>
          );
        })}
      </ul>
      {active && exhausted ? (
        <p role="status" className="text-sm text-fg-2">
          The search is taking longer than usual. Reload the page later; if it stays stuck, a super admin can check the job queue.
        </p>
      ) : null}
    </div>
  );
}
