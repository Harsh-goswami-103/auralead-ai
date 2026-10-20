/**
 * Lead-source activity tables (T28; 06-design §11.3 "Sheets setup: connected + last sync, rows with
 * per-row failures"; "Extension hub: batch partially failed: per-row table"): recent deliveries with
 * their state (icon + label), Simulated or Live, and the per-record counts the worker stored; and
 * the per-row issues (rejected or in review) with the reason in words. Tables scroll inside their
 * card. Server-safe.
 */
import { ModeChip } from '@/components/patterns/StatusBadge';
import { formatDateTime } from '@/lib/format/date';
import { StatusChip } from './StatusChip';
import { BATCH_STATE, DELIVERY_STATE, ROW_STATUS_LABELS, rowReason, type RawStatusEntry } from './vocabulary';

type Counts = { received: number; accepted: number; duplicate: number; review: number; rejected: number } | null;

export type DeliveryRow = { id: string; label: string; state: string; stateKind: 'delivery' | 'batch'; simulated: boolean; at: Date; counts: Counts; failureCode?: string | null };
export type IssueRow = { id: string; externalId: string; status: string; reasonCode: string | null; receivedAt: Date };

const fallback = (state: string): RawStatusEntry => ({ label: state, tone: 'neutral', icon: DELIVERY_STATE.ORPHAN!.icon });

function CountsText({ counts }: { counts: Counts }) {
  if (!counts) return <span className="text-fg-2">Not processed yet</span>;
  return (
    <span className="tabular text-fg-1">
      {counts.received} received · {counts.accepted} created · {counts.duplicate} duplicate · {counts.review} in review · {counts.rejected} rejected
    </span>
  );
}

export function DeliveryTable({ rows, timeZone, caption, firstColumn }: { rows: DeliveryRow[]; timeZone: string; caption: string; firstColumn: string }) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full min-w-[42rem] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-bg-2/60 text-xs text-fg-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {firstColumn}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              State
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Records
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Received
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const vocab = r.stateKind === 'batch' ? BATCH_STATE : DELIVERY_STATE;
            return (
              <tr key={r.id} data-delivery={r.id} className="border-t border-border-subtle align-top">
                <th scope="row" className="px-3 py-2 font-normal">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-fg-1">{r.label}</span>
                    <ModeChip simulated={r.simulated} />
                  </span>
                </th>
                <td className="px-3 py-2">
                  <StatusChip entry={vocab[r.state] ?? fallback(r.state)} />
                  {r.failureCode ? <span className="mt-1 block text-xs text-fg-2">Reason code {r.failureCode}</span> : null}
                </td>
                <td className="px-3 py-2 text-xs">
                  <CountsText counts={r.counts} />
                </td>
                <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-2">{formatDateTime(r.at, timeZone)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function IssueTable({ rows, timeZone }: { rows: IssueRow[]; timeZone: string }) {
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <caption className="sr-only">Rows that need attention</caption>
        <thead className="bg-bg-2/60 text-xs text-fg-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Source row
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Outcome
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Reason
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Received
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-row-issue={r.externalId} className="border-t border-border-subtle">
              <th scope="row" className="px-3 py-2 font-mono text-xs font-normal text-fg-1">
                {r.externalId}
              </th>
              <td className="px-3 py-2 text-fg-1">{ROW_STATUS_LABELS[r.status] ?? r.status}</td>
              <td className="px-3 py-2 text-fg-1">{rowReason(r.reasonCode)}</td>
              <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-2">{formatDateTime(r.receivedAt, timeZone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
