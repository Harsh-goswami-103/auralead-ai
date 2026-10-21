'use client';

/**
 * Sync status and "Sync now" (T34, ADR-104; PRD "sync status"). Sync now queues one run; the worker
 * reads the rows after the last sync cursor through the service account and ingests them like an
 * Apps Script push. The page re-reads itself while a run is open. A run blocked by header drift
 * shows the column diff; the button is then gated on configuration until the mapping is
 * re-confirmed (the server would block the run anyway). Every run lists rows read, created,
 * duplicates, reviews, rejected, skipped and weak ids, and its error in words. Status is icon + label.
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, CircleAlert, CircleCheck, Clock, Loader2, RefreshCw, type LucideIcon } from 'lucide-react';
import { useRefreshWhile } from '@/components/integrations/use-refresh-while';
import { postJson } from '@/components/patterns/api-client';
import { useCsrfToken } from '@/components/patterns/csrf';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';

export type SyncRunRow = {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  createdAt: string;
  finishedAt: string | null;
  fromRow: number | null;
  cursorRow: number | null;
  rowsRead: number;
  created: number;
  duplicate: number;
  review: number;
  rejected: number;
  skipped: number;
  weakIdRows: number;
  pendingRows: number[];
  errorCode: string | null;
  errorMessage: string | null;
  mappingVersion: number | null;
};

const STATUS: Readonly<Record<SyncRunRow['status'], { label: string; icon: LucideIcon; tone: string }>> = {
  QUEUED: { label: 'Queued', icon: Clock, tone: 'text-info' },
  RUNNING: { label: 'Running', icon: Loader2, tone: 'text-info' },
  SUCCEEDED: { label: 'Succeeded', icon: CircleCheck, tone: 'text-success' },
  FAILED: { label: 'Failed', icon: CircleAlert, tone: 'text-danger' },
  BLOCKED: { label: 'Blocked', icon: Ban, tone: 'text-warning' },
};

export function SheetsSyncPanel(props: { workspaceSlug: string; runs: SyncRunRow[]; cursorRow: number; open: boolean; drift: { added: string[]; removed: string[] } | null; gate: Gate | null; timeZone: string }) {
  const router = useRouter();
  const csrf = useCsrfToken();
  const [runNo, setRunNo] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => router.refresh(), [router]);
  const { exhausted } = useRefreshWhile(props.open, refresh, runNo);

  async function sync() {
    setError(null);
    const res = await postJson<{ runId: string; alreadyQueued: boolean }>('/api/app/sheets/sync', { workspaceSlug: props.workspaceSlug }, csrf);
    if (!res.ok) {
      setError(`${res.message}${res.reference ? ` Reference ${res.reference}.` : ''}`);
      return;
    }
    setRunNo((n) => n + 1);
    router.refresh();
  }

  return (
    <div data-sync-panel className="flex flex-col gap-3">
      {props.drift ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-sm text-fg-1">
          <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            Sync is blocked: the Sheet’s columns changed since the mapping was confirmed. Added: {props.drift.added.join(', ') || 'none'}. Removed: {props.drift.removed.join(', ') || 'none'}. Load the columns and confirm the mapping again above.
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <GatedAction label="Sync now" pendingLabel="Queuing..." variant="secondary" size="sm" icon={<RefreshCw aria-hidden="true" />} gate={props.gate} onAction={sync} />
        <p className="text-xs text-fg-2">{props.cursorRow > 1 ? `Synced through row ${props.cursorRow}; the next sync reads from row ${props.cursorRow + 1} (at most 200 rows).` : 'The first sync reads from row 2 (at most 200 rows).'}</p>
      </div>
      {props.open ? (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-2">
          {exhausted ? 'The worker has not finished the sync yet. Reload the page to check again.' : 'The worker is reading the Sheet. This page updates by itself.'}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {props.runs.length === 0 ? (
        <p className="text-sm text-fg-2">No sync has run yet.</p>
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Recent syncs</caption>
            <thead className="bg-bg-2/60 text-xs text-fg-2">
              <tr>
                {['Started', 'Status', 'Rows read', 'Created', 'Duplicates', 'Review', 'Rejected', 'Skipped', 'Details'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.runs.map((r) => {
                const s = STATUS[r.status];
                const Icon = s.icon;
                const details = [
                  r.fromRow !== null && r.cursorRow !== null && r.rowsRead > 0 ? `rows ${r.fromRow}-${r.fromRow + r.rowsRead - 1}` : null,
                  r.weakIdRows > 0 ? `${r.weakIdRows} identified by content (no auralead_event_id)` : null,
                  r.pendingRows.length > 0 ? `row ${r.pendingRows.join(', ')} waiting for its event id` : null,
                  r.errorMessage,
                ].filter(Boolean);
                return (
                  <tr key={r.id} data-sync-status={r.status} className="border-t border-border-subtle">
                    <td className="px-3 py-2 whitespace-nowrap text-fg-2">{formatDateTime(new Date(r.createdAt), props.timeZone)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-fg-1">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon aria-hidden="true" className={cn('size-3.5', s.tone)} />
                        {s.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-fg-1">{r.rowsRead}</td>
                    <td className="px-3 py-2 tabular-nums text-fg-1">{r.created}</td>
                    <td className="px-3 py-2 tabular-nums text-fg-1">{r.duplicate}</td>
                    <td className="px-3 py-2 tabular-nums text-fg-1">{r.review}</td>
                    <td className="px-3 py-2 tabular-nums text-fg-1">{r.rejected}</td>
                    <td className="px-3 py-2 tabular-nums text-fg-1">{r.skipped}</td>
                    <td className="px-3 py-2 text-xs text-fg-2">{details.length > 0 ? details.join('; ') : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
