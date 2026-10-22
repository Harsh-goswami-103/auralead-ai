/**
 * The viewer's own recent imports (ADR-120): status (icon + label), file, rows, when, and the
 * outcome counts once processed. Each opens on the import page (`?import=<id>`), where a preview
 * can still be confirmed and a running import is followed. Server-safe.
 */
import Link from 'next/link';
import { ToneChip } from '@/components/leads/ToneChip';
import { formatDateTime } from '@/lib/format/date';
import type { LeadImportDto } from '@/lib/schemas/lead-import';
import { IMPORT_STATUS } from './import-vocabulary';

export function RecentImports(props: { imports: LeadImportDto[]; basePath: string; timeZone: string }) {
  return (
    <ul aria-label="Your recent imports" className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
      {props.imports.map((i) => {
        const status = IMPORT_STATUS[i.effectiveStatus];
        const finished = i.effectiveStatus === 'SUCCEEDED' || i.effectiveStatus === 'FAILED';
        return (
          <li key={i.id} data-import-id={i.id} data-import-status={i.effectiveStatus} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <ToneChip tone={status.tone} icon={status.icon} label={status.label} spinning={status.spinning} />
              <span className="max-w-64 truncate text-fg-1" title={i.fileName}>
                {i.fileName}
              </span>
              <span className="tabular text-fg-2">
                {i.rowCount.toLocaleString('en-IN')} {i.rowCount === 1 ? 'row' : 'rows'}, uploaded {formatDateTime(new Date(i.createdAt), props.timeZone)}
              </span>
              {finished ? (
                <span className="tabular text-fg-2">
                  {i.counts.accepted.toLocaleString('en-IN')} new, {i.counts.duplicates.toLocaleString('en-IN')} duplicate, {i.counts.rejected.toLocaleString('en-IN')} not imported
                </span>
              ) : null}
            </span>
            {i.effectiveStatus === 'EXPIRED' ? null : (
              <Link href={`${props.basePath}?${new URLSearchParams({ import: i.id }).toString()}`} className="text-sm text-cyan underline-offset-4 hover:underline">
                {i.effectiveStatus === 'PREVIEW' ? 'Continue' : 'Open'}
                <span className="sr-only"> {i.fileName}</span>
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
