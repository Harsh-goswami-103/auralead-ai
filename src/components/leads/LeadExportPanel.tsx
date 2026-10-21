'use client';

/**
 * CSV export of the Leads area (T26, ADR-70). "Export CSV" asks the server for an export of the
 * leads matching the current search and filters (one request key per click, so a double click is
 * one export); the worker writes the file and the panel re-reads the page until it is ready. The
 * list shows the viewer's own recent exports with their status (icon + label), row count and
 * expiry; a ready export downloads until it expires 24 hours after it was written. Without
 * leads.export the button stays focusable and says why (plan §12). The same filters as an export
 * still preparing or ready reuse it, and a workspace at its active-export limit gets the server's
 * message (ADR-73).
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CircleCheck, CircleSlash, Clock3, Download, FileDown, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { newRequestKey } from '@/components/inbox/api';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import { buttonVariants } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format/date';
import { leadExportDownloadHref, LEAD_EXPORT_TTL_HOURS, type LeadExportDto, type LeadExportStatus, type LeadFilters } from '@/lib/schemas/leads';
import { usePolling } from './use-polling';
import { ToneChip } from './ToneChip';

const STATUS: Readonly<Record<LeadExportStatus, { label: string; tone: StatusTone; icon: LucideIcon; spinning?: boolean }>> = {
  QUEUED: { label: 'Preparing', tone: 'info', icon: LoaderCircle, spinning: true },
  READY: { label: 'Ready', tone: 'success', icon: CircleCheck },
  FAILED: { label: 'Failed', tone: 'danger', icon: TriangleAlert },
  EXPIRED: { label: 'Expired', tone: 'neutral', icon: CircleSlash },
};

export function LeadExportPanel(props: { exports: LeadExportDto[]; filters: LeadFilters; gate: Gate | null; workspaceSlug?: string; timeZone: string; filtered: boolean }) {
  const router = useRouter();
  const csrfToken = useCsrfToken();
  const [requestNo, setRequestNo] = useState(0);
  const preparing = props.exports.some((e) => e.effectiveStatus === 'QUEUED');
  const { exhausted } = usePolling(preparing, () => router.refresh(), undefined, requestNo);

  async function requestExport() {
    const res = await postJson<{ export: LeadExportDto; created: boolean }>(
      '/api/app/leads/exports',
      { requestKey: newRequestKey(), filters: props.filters, ...(props.workspaceSlug ? { workspaceSlug: props.workspaceSlug } : {}) },
      csrfToken,
    );
    if (!res.ok) {
      toast.error(res.message, { description: res.reference ? `Reference: ${res.reference}` : undefined });
      return;
    }
    if (res.data.created) toast.success('Export started.', { description: 'The file appears below when it is ready.' });
    else toast.success('This export is already in your list.', { description: 'An export with the same search and filters is still preparing or ready.' });
    setRequestNo((n) => n + 1);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <GatedAction
          label={props.filtered ? 'Export matching leads (CSV)' : 'Export all leads (CSV)'}
          pendingLabel="Starting..."
          variant="outline"
          icon={<FileDown aria-hidden="true" />}
          gate={props.gate}
          onAction={requestExport}
        />
        <p className="max-w-prose text-xs text-fg-2">
          Uses the current search and filters. Cells that could run as spreadsheet formulas are written as text. Files can be downloaded for {LEAD_EXPORT_TTL_HOURS} hours, by you only, and every download is recorded.
        </p>
      </div>
      {props.exports.length > 0 ? (
        <ul aria-label="Your recent exports" className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {props.exports.map((e) => {
            const status = STATUS[e.effectiveStatus];
            return (
              <li key={e.id} data-export-id={e.id} data-export-status={e.effectiveStatus} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <ToneChip tone={status.tone} icon={status.icon} label={status.label} spinning={status.spinning} />
                  <span className="text-fg-2">Requested {formatDateTime(new Date(e.createdAt), props.timeZone)}</span>
                  {e.rowCount !== null ? (
                    <span className="tabular text-fg-1">
                      {e.rowCount.toLocaleString('en-IN')} {e.rowCount === 1 ? 'lead' : 'leads'}
                      {e.truncated ? ' (cut at the export limit)' : ''}
                    </span>
                  ) : null}
                </span>
                {e.effectiveStatus === 'READY' ? (
                  <span className="flex flex-wrap items-center gap-3">
                    {e.expiresAt ? (
                      <span className="inline-flex items-center gap-1 text-xs text-fg-2">
                        <Clock3 aria-hidden="true" className="size-3.5" />
                        Until {formatDateTime(new Date(e.expiresAt), props.timeZone)}
                      </span>
                    ) : null}
                    <a href={leadExportDownloadHref(e.id, props.workspaceSlug)} download className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                      <Download aria-hidden="true" />
                      Download CSV
                    </a>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {preparing && exhausted ? (
        <p role="status" className="text-sm text-fg-2">
          The export is taking longer than usual. Reload the page later; if it stays stuck, a super admin can check the job queue.
        </p>
      ) : null}
    </div>
  );
}
