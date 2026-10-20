/**
 * Where a lead came from (T26, R12 attribution): its source records, newest first, with the source
 * chip, the record outcome (icon + label), when it was received (and extracted, for the Maps
 * extension), the batch, the mapping version and the attribution the source sent (campaign, form,
 * sheet, keyword). The raw payload is never shown. Server-safe.
 */
import { CircleCheck, CircleSlash, Copy, SearchCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import { formatDateTime } from '@/lib/format/date';
import type { SourceRecordDto } from '@/lib/schemas/leads';
import { ToneChip } from './ToneChip';

const STATUS: Readonly<Record<string, { label: string; tone: StatusTone; icon: LucideIcon }>> = {
  ACCEPTED: { label: 'Created this lead', tone: 'success', icon: CircleCheck },
  DUPLICATE: { label: 'Matched this lead (duplicate)', tone: 'neutral', icon: Copy },
  REVIEW: { label: 'Sent to duplicate review', tone: 'warning', icon: SearchCheck },
  REJECTED: { label: 'Rejected', tone: 'danger', icon: CircleSlash },
  UNRETRIEVABLE: { label: 'Could not be fetched', tone: 'warning', icon: TriangleAlert },
};

/** "adId" -> "Ad id", "campaign_name" -> "Campaign name". */
function keyLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function SourceRecords(props: { records: readonly SourceRecordDto[]; timeZone: string }) {
  if (props.records.length === 0) return <p className="text-sm text-fg-2">No source record is linked to this lead (it was added by hand or merged).</p>;
  return (
    <ul aria-label="Source records" className="flex flex-col gap-3">
      {props.records.map((r) => {
        const status = STATUS[r.status] ?? { label: keyLabel(r.status), tone: 'neutral' as const, icon: CircleCheck };
        return (
          <li key={r.id} data-source-record={r.id} className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/50 p-3">
            <span className="flex flex-wrap items-center gap-2">
              <SourceChip source={r.source} withIcon />
              <ToneChip tone={status.tone} icon={status.icon} label={status.label} />
              {r.batch?.simulated ? <ModeChip simulated /> : null}
            </span>
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
              <div className="flex min-w-0 flex-col">
                <dt className="text-xs text-fg-2">Received</dt>
                <dd className="text-fg-1">{formatDateTime(new Date(r.receivedAt), props.timeZone)}</dd>
              </div>
              {r.extractedAt ? (
                <div className="flex min-w-0 flex-col">
                  <dt className="text-xs text-fg-2">Extracted</dt>
                  <dd className="text-fg-1">{formatDateTime(new Date(r.extractedAt), props.timeZone)}</dd>
                </div>
              ) : null}
              <div className="flex min-w-0 flex-col">
                <dt className="text-xs text-fg-2">Source reference</dt>
                <dd className="font-mono text-xs break-all text-fg-1">{r.externalId}</dd>
              </div>
              {r.batch ? (
                <div className="flex min-w-0 flex-col">
                  <dt className="text-xs text-fg-2">Batch</dt>
                  <dd className="font-mono text-xs break-all text-fg-1">{r.batch.externalBatchId}</dd>
                </div>
              ) : null}
              {r.mappingVersion !== null ? (
                <div className="flex min-w-0 flex-col">
                  <dt className="text-xs text-fg-2">Field mapping</dt>
                  <dd className="text-fg-1">Version {r.mappingVersion}</dd>
                </div>
              ) : null}
              {r.attribution.map((a) => (
                <div key={a.key} className="flex min-w-0 flex-col">
                  <dt className="text-xs text-fg-2">{keyLabel(a.key)}</dt>
                  <dd className="break-words text-fg-1">{a.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
