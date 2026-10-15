'use client';

/**
 * BulkResultSummary (06-design F19, AT13, T23): the result drawer of a bulk run, read from the
 * persisted run (`GET /api/app/bulk/runs/[runId]`), so it shows the same result after a reload.
 *
 * - Repeats the workspace name (F8).
 * - Counts that add up: selected = queued + skipped + failed, each with an icon and a label (status
 *   is never colour only).
 * - Skip and failure reasons grouped with their labels and counts (the server's reason labels; the
 *   UI never computes eligibility), then every row with its outcome and reasons. A queued row whose
 *   dispatch waits (pause or internal cap) says so.
 * - "Select skipped rows" hands the skipped lead ids back to the table for a follow-up action.
 * - While the run is still working through the selection, a live status line says how far it got.
 */
import { CircleCheck, CircleSlash, CircleX, ListChecks, LoaderCircle } from 'lucide-react';
import type { ComponentType } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { BulkRunDto, BulkRunRowDto } from '@/lib/schemas/bulk';
import { TONE_CLASSES, type StatusTone } from './status-vocabulary';

const ACTION_TITLES: Record<BulkRunDto['action'], string> = {
  SEND_WHATSAPP_TEMPLATE: 'Bulk WhatsApp template send',
  SEND_EMAIL: 'Bulk email send',
};

const OUTCOMES: Record<BulkRunRowDto['outcome'], { label: string; tone: StatusTone; icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }> = {
  QUEUED: { label: 'Queued', tone: 'success', icon: CircleCheck },
  SKIPPED: { label: 'Skipped', tone: 'warning', icon: CircleSlash },
  FAILED: { label: 'Failed', tone: 'danger', icon: CircleX },
};

function Count({ value, label, tone, icon: Icon }: { value: number; label: string; tone: StatusTone; icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }) {
  return (
    <li className={cn('inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-sm font-medium', TONE_CLASSES[tone])}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span>
        <span className="tabular-nums">{value}</span> {label}
      </span>
    </li>
  );
}

function OutcomeBadge({ outcome }: { outcome: BulkRunRowDto['outcome'] }) {
  const entry = OUTCOMES[outcome];
  const Icon = entry.icon;
  return (
    <span className={cn('inline-flex w-fit items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium', TONE_CLASSES[entry.tone])}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {entry.label}
    </span>
  );
}

function rowDetail(row: BulkRunRowDto): string {
  if (row.outcome === 'QUEUED') return row.deferred && row.reasons.length > 0 ? `Waiting: ${row.reasons.map((r) => r.label).join('; ')}` : 'Sent to the outbox';
  return row.reasons.map((r) => r.label).join('; ');
}

export function BulkResultSummary(props: {
  run: BulkRunDto;
  workspaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the skipped rows' lead ids (to select them in the table). */
  onSelectRows?: (leadIds: string[]) => void;
}) {
  const { run, workspaceName, onSelectRows } = props;
  const processed = run.rows.length;
  const complete = run.status === 'COMPLETED';
  const skippedIds = run.rows.filter((r) => r.outcome === 'SKIPPED').map((r) => r.leadId);

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{ACTION_TITLES[run.action]}</SheetTitle>
          <SheetDescription>
            Workspace: <span className="font-medium text-fg-1">{workspaceName}</span>. Only eligible rows were queued; dispatch checks each one again at send time.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4">
          {complete ? null : (
            <p role="status" className="inline-flex items-center gap-2 text-sm text-fg-2">
              <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />
              Running: {processed} of {run.selected} rows processed.
            </p>
          )}

          <ul aria-label="Result counts" className="flex flex-wrap gap-2">
            <Count value={run.selected} label="selected" tone="neutral" icon={ListChecks} />
            <Count value={run.queued} label="queued" tone="success" icon={CircleCheck} />
            <Count value={run.skipped} label="skipped" tone="warning" icon={CircleSlash} />
            <Count value={run.failed} label="failed" tone="danger" icon={CircleX} />
          </ul>

          {run.byReason.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-fg-1">Why rows were not queued</h3>
              <ul aria-label="Reasons" className="flex flex-col gap-1 text-sm">
                {run.byReason.map((r) => (
                  <li key={r.code} className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-1">
                    <span className="text-fg-1">{r.label}</span>
                    <span className="tabular-nums text-fg-2">{r.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Result per selected lead</caption>
              <thead className="text-xs text-fg-3">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">Lead</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Outcome</th>
                  <th scope="col" className="py-1 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {run.rows.map((row) => (
                  <tr key={row.leadId} className="border-t border-border-subtle align-top">
                    <td className="py-1.5 pr-3 text-fg-1">{row.leadName ?? 'Lead no longer available'}</td>
                    <td className="py-1.5 pr-3">
                      <OutcomeBadge outcome={row.outcome} />
                    </td>
                    <td className="py-1.5 text-fg-2">{rowDetail(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {complete && onSelectRows && skippedIds.length > 0 ? (
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onSelectRows(skippedIds)}>
              Select skipped rows
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
