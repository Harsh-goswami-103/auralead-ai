'use client';

/**
 * The results of one Lead Finder run (ADR-118, slice F1). Filters are links on real columns (No
 * website listed, Has phone, Not imported yet) with their counts; the table shows the listing's
 * name and category, phone, website or the "No website listed" chip, rating and reviews, address
 * with city and PIN code, a Google Maps link built from the place ID (LIVE), the emails found on
 * the business's own website, and whether it was imported (a link to the lead). Rows whose
 * 24-hour working copy expired say "Details expired" and can be refreshed; rows whose details an
 * erasure removed say so and are never fetched again. Selected rows are
 * imported through "Import selected" (needs `leads.write`); "Download Excel" serves the run's file
 * to the person who started it (needs `leads.export`). LIVE shows the Google Maps attribution;
 * DEMO the Simulated chip.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CircleCheck, Download, ExternalLink, Globe, Mail, MapPin, Phone, RefreshCw, Star, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { newRequestKey } from '@/components/inbox/api';
import { ToneChip } from '@/components/leads/ToneChip';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { FINDER_EMAIL_STATUS_LABELS } from '@/lib/domain/lead-gen';
import type { FinderResultDto, FinderRunView } from '@/server/services/lead-finder/runs';
import { finderExportHref, finderHref, ratingWords } from './finder-vocabulary';
import { PlacesAttribution } from './PlacesAttribution';

type ImportResponse = { counts: { accepted: number; duplicate: number; review: number; rejected: number; alreadyImported: number; detailsExpired: number } };

export type FinderResultsProps = {
  view: FinderRunView;
  workspaceSlug: string;
  importGate: Gate | null;
  exportGate: Gate | null;
  refreshGate: Gate | null;
};

function leadHref(slug: string, leadId: string): string {
  return `/dashboard/employee/${encodeURIComponent(slug)}/leads/${encodeURIComponent(leadId)}`;
}

function importSummary(c: ImportResponse['counts']): string {
  const parts = [`${c.accepted} new ${c.accepted === 1 ? 'lead' : 'leads'}`];
  if (c.duplicate > 0) parts.push(`${c.duplicate} already ${c.duplicate === 1 ? 'a lead' : 'leads'}`);
  if (c.review > 0) parts.push(`${c.review} sent to duplicate review`);
  if (c.rejected > 0) parts.push(`${c.rejected} not imported`);
  if (c.alreadyImported > 0) parts.push(`${c.alreadyImported} imported before`);
  if (c.detailsExpired > 0) parts.push(`${c.detailsExpired} with expired details`);
  return parts.join(', ');
}

export function FinderResults(props: FinderResultsProps) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const { view, workspaceSlug } = props;
  const run = view.run;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectable = view.results.filter((r) => r.importedLeadId === null && r.hasDetails);
  const expiredSelected = view.results.filter((r) => selected.has(r.id) && !r.hasDetails && !r.erased);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const q = { run: run.id, ...view.filters };

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)));
  }

  async function importSelected() {
    const ids = view.results.filter((r) => selected.has(r.id) && r.hasDetails && r.importedLeadId === null).map((r) => r.id);
    if (ids.length === 0) {
      toast.error('Select at least one result that is not imported yet.');
      return;
    }
    const res = await postJson<ImportResponse>(`/api/app/finder/runs/${encodeURIComponent(run.id)}/import`, { workspaceSlug, requestKey: newRequestKey(), resultIds: ids }, csrfToken);
    if (!res.ok) {
      toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
      return;
    }
    toast.success('Import finished.', { description: importSummary(res.data.counts) });
    setSelected(new Set());
    router.refresh();
  }

  async function refreshExpired() {
    const ids = expiredSelected.map((r) => r.id);
    const res = await postJson<{ refreshed: number; failed: number }>(`/api/app/finder/runs/${encodeURIComponent(run.id)}/refresh`, { workspaceSlug, resultIds: ids }, csrfToken);
    if (!res.ok) {
      toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
      return;
    }
    toast.success(`${res.data.refreshed} ${res.data.refreshed === 1 ? 'listing' : 'listings'} refreshed.`, { description: res.data.failed > 0 ? `${res.data.failed} could not be refreshed.` : undefined });
    setSelected(new Set());
    router.refresh();
  }

  const filterLinks: Array<{ key: 'noWebsite' | 'hasPhone' | 'notImported'; label: string; count: number }> = [
    { key: 'noWebsite', label: 'No website listed', count: view.counts.noWebsite },
    { key: 'hasPhone', label: 'Has phone', count: view.counts.hasPhone },
    { key: 'notImported', label: 'Not imported', count: view.counts.notImported },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Filter results" className="flex flex-wrap items-center gap-2">
          {filterLinks.map((f) => {
            const on = view.filters[f.key];
            return (
              <Link
                key={f.key}
                href={finderHref(workspaceSlug, { ...q, [f.key]: !on, page: 1 })}
                aria-pressed={on}
                data-filter={f.key}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-fast',
                  on ? 'border-panel/45 bg-panel/14 font-medium text-fg-1' : 'border-border-subtle text-fg-2 hover:bg-bg-3 hover:text-fg-1',
                )}
              >
                {on ? <CircleCheck aria-hidden="true" className="size-3.5" /> : null}
                {f.label}
                <span className="tabular text-xs text-fg-3">{f.count.toLocaleString('en-IN')}</span>
              </Link>
            );
          })}
        </nav>
        <div className="flex flex-wrap items-start gap-2">
          {expiredSelected.length > 0 ? (
            <GatedAction label={`Refresh details (${expiredSelected.length})`} pendingLabel="Refreshing..." variant="outline" icon={<RefreshCw aria-hidden="true" />} gate={props.refreshGate} onAction={refreshExpired} />
          ) : null}
          <GatedAction label={selected.size > 0 ? `Import selected (${selected.size})` : 'Import selected'} pendingLabel="Importing..." icon={<UserPlus aria-hidden="true" />} gate={props.importGate} onAction={importSelected} />
          {props.exportGate ? (
            <GatedAction label="Download Excel" variant="outline" icon={<Download aria-hidden="true" />} gate={props.exportGate} />
          ) : (
            <a href={finderExportHref(run.id, workspaceSlug)} download className={buttonVariants({ variant: 'outline' })}>
              <Download aria-hidden="true" />
              Download Excel
            </a>
          )}
        </div>
      </div>

      {view.results.length === 0 ? (
        <p className="rounded-lg border border-border-subtle px-3 py-6 text-center text-sm text-fg-2">
          {view.counts.all === 0 ? (run.status === 'QUEUED' || run.status === 'RUNNING' ? 'Searching: places appear here as each page arrives.' : 'This search found no places.') : 'No result matches these filters.'}
        </p>
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Places found by this search</caption>
            <thead className="bg-bg-2/60 text-xs text-fg-2">
              <tr>
                <th scope="col" className="w-10 px-3 py-2">
                  <input type="checkbox" aria-label="Select every result on this page that is not imported" checked={allSelected} onChange={toggleAll} disabled={selectable.length === 0} className="size-4 accent-cyan" />
                </th>
                <th scope="col" className="px-3 py-2 font-medium">Business</th>
                <th scope="col" className="px-3 py-2 font-medium">Phone</th>
                <th scope="col" className="px-3 py-2 font-medium">Website</th>
                <th scope="col" className="px-3 py-2 font-medium">Rating</th>
                <th scope="col" className="px-3 py-2 font-medium">Address</th>
                <th scope="col" className="px-3 py-2 font-medium">Emails</th>
                <th scope="col" className="px-3 py-2 font-medium">Lead</th>
              </tr>
            </thead>
            <tbody>
              {view.results.map((r) => (
                <ResultRow key={r.id} r={r} checked={selected.has(r.id)} onToggle={() => toggle(r.id)} workspaceSlug={workspaceSlug} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view.pageCount > 1 ? (
        <nav aria-label="Result pages" className="flex items-center justify-between gap-3 text-sm">
          {view.page > 1 ? (
            <Link href={finderHref(workspaceSlug, { ...q, page: view.page - 1 })} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="tabular text-fg-2">
            Page {view.page} of {view.pageCount} · {view.total.toLocaleString('en-IN')} {view.total === 1 ? 'result' : 'results'}
          </span>
          {view.page < view.pageCount ? (
            <Link href={finderHref(workspaceSlug, { ...q, page: view.page + 1 })} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <PlacesAttribution simulated={run.simulated} attributions={view.attributions} />
    </div>
  );
}

function ResultRow(props: { r: FinderResultDto; checked: boolean; onToggle: () => void; workspaceSlug: string }) {
  const { r } = props;
  const label = r.name ?? `Place ${r.placeId.slice(-8)}`;
  const rating = ratingWords(r.rating, r.reviewCount);
  return (
    <tr data-result-id={r.id} data-website-listed={String(r.websiteListed)} className="border-t border-border-subtle align-top">
      <td className="px-3 py-2.5">
        <input type="checkbox" aria-label={`Select ${label}`} checked={props.checked} onChange={props.onToggle} disabled={r.importedLeadId !== null || r.erased} className="size-4 accent-cyan" />
      </td>
      <th scope="row" className="px-3 py-2.5 font-normal">
        {r.hasDetails ? (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-fg-1">{r.name}</span>
            {r.category ? <span className="text-xs text-fg-2">{r.category}</span> : null}
          </span>
        ) : r.erased ? (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-fg-2">Details removed on request</span>
            <span className="text-xs text-fg-3">This listing is not fetched again.</span>
          </span>
        ) : (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-fg-2">Details expired</span>
            <span className="text-xs text-fg-3">Kept: place ID, “{r.keyword}” in {r.location}. Refresh to see the listing again.</span>
          </span>
        )}
        {r.simulated ? <ModeChip simulated className="mt-1" /> : null}
      </th>
      <td className="px-3 py-2.5 whitespace-nowrap">
        {r.phone ? (
          <span className="inline-flex items-center gap-1.5 text-fg-1">
            <Phone aria-hidden="true" className="size-3.5 text-fg-3" />
            {r.phone}
          </span>
        ) : r.hasDetails ? (
          <span className="text-fg-3">No phone listed</span>
        ) : null}
      </td>
      <td className="px-3 py-2.5">
        {!r.websiteListed ? (
          <ToneChip tone="warning" icon={Globe} label="No website listed" attrs={{ 'data-no-website': '' }} />
        ) : r.websiteHref ? (
          <a href={r.websiteHref} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-56 items-center gap-1 break-all text-fg-1 underline underline-offset-2 hover:text-cyan">
            {r.website}
            <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
          </a>
        ) : r.website ? (
          <span className="break-all text-fg-1">{r.website}</span>
        ) : null}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        {rating ? (
          <span className="inline-flex items-center gap-1 text-fg-1" aria-label={rating}>
            <Star aria-hidden="true" className="size-3.5 text-zest" />
            <span className="tabular">{r.rating!.toFixed(1)}</span>
            {r.reviewCount !== null ? <span className="tabular text-xs text-fg-2">({r.reviewCount.toLocaleString('en-IN')})</span> : null}
          </span>
        ) : r.hasDetails ? (
          <span className="text-fg-3">Not rated</span>
        ) : null}
      </td>
      <td className="px-3 py-2.5">
        <span className="flex flex-col gap-0.5">
          {r.address ? <span className="text-fg-1">{r.address}</span> : null}
          {r.city || r.pincode ? (
            <span className="text-xs text-fg-2">
              {[r.city, r.pincode].filter(Boolean).join(' · ')}
            </span>
          ) : null}
          {r.mapsHref ? (
            <a href={r.mapsHref} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 text-xs text-fg-1 underline underline-offset-2 hover:text-cyan">
              <MapPin aria-hidden="true" className="size-3" />
              Open in Google Maps
            </a>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2.5">
        {r.emails.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {r.emails.map((e) => (
              <li key={e.address} className="inline-flex items-center gap-1.5 text-fg-1">
                <Mail aria-hidden="true" className="size-3.5 text-fg-3" />
                <span className="break-all">{e.address}</span>
              </li>
            ))}
          </ul>
        ) : r.emailStatus === 'NOT_REQUESTED' ? null : (
          <span className="text-xs text-fg-2">{FINDER_EMAIL_STATUS_LABELS[r.emailStatus]}</span>
        )}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        {r.importedLeadId ? (
          <Link href={leadHref(props.workspaceSlug, r.importedLeadId)} className="inline-flex items-center gap-1 text-fg-1 underline underline-offset-2 hover:text-cyan">
            <CircleCheck aria-hidden="true" className="size-3.5 text-success" />
            Imported
          </Link>
        ) : (
          <span className="text-fg-3">Not imported</span>
        )}
      </td>
    </tr>
  );
}

