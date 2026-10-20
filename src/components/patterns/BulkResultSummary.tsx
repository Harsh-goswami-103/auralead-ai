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
 *
 * Look (design spec §6): the counts are tone tiles (icon chip, large tabular number in text-1, the
 * label next to it; final values from the first paint, no count-up). Each reason has a static bar
 * sized by its share of the selection. The running line shimmers next to its spinner, because it
 * is a genuine in-progress state. The result table stays neutral: no row colors and no stagger.
 */
import { CircleCheck, CircleSlash, CircleX, ListChecks, LoaderCircle } from 'lucide-react';
import type { ComponentType } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ShimmerText } from '@/components/visual/ShimmerText';
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
    <li className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border-subtle bg-bg-2/60 px-3 py-2.5">
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg border', TONE_CLASSES[tone])}>
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="min-w-0 text-sm text-fg-2">
        <span className="tabular font-display text-xl leading-6 font-semibold text-fg-1">{value}</span> {label}
      </span>
    </li>
  );
}

function OutcomeBadge({ outcome }: { outcome: BulkRunRowDto['outcome'] }) {
  const entry = OUTCOMES[outcome];
  const Icon = entry.icon;
  return (
    <span className={cn('inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', TONE_CLASSES[entry.tone])}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {entry.label}
    </span>
  );
}

/** Whole-percent share of the selection for a reason bar (0-100; static, computed from the counts). */
function share(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(4, Math.round((count / total) * 100)));
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
              <LoaderCircle aria-hidden className="size-4 text-panel motion-safe:animate-spin" />
              <ShimmerText>
                Running: {processed} of {run.selected} rows processed.
              </ShimmerText>
            </p>
          )}

          <ul aria-label="Result counts" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Count value={run.selected} label="selected" tone="neutral" icon={ListChecks} />
            <Count value={run.queued} label="queued" tone="success" icon={CircleCheck} />
            <Count value={run.skipped} label="skipped" tone="warning" icon={CircleSlash} />
            <Count value={run.failed} label="failed" tone="danger" icon={CircleX} />
          </ul>

          {run.byReason.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-fg-1">Why rows were not queued</h3>
              <ul aria-label="Reasons" className="flex flex-col gap-2 text-sm">
                {run.byReason.map((r) => (
                  <li key={r.code} className="flex flex-col gap-1.5 border-b border-border-subtle pb-2">
                    <span className="flex items-baseline justify-between gap-4">
                      <span className="text-fg-1">{r.label}</span>
                      <span className="tabular-nums text-fg-2">{r.count}</span>
                    </span>
                    <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-bg-3">
                      <span className="block h-full rounded-full bg-fg-3/70" style={{ width: `${share(r.count, run.selected)}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="relative overflow-x-auto rounded-xl border border-border-subtle">
            <table className="w-full text-left text-sm [&_td:first-child]:pl-3 [&_td:last-child]:pr-3 [&_th:first-child]:pl-3 [&_th:last-child]:pr-3">
              <caption className="sr-only">Result per selected lead</caption>
              <thead className="bg-bg-2/60 text-xs text-fg-2">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Lead</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Outcome</th>
                  <th scope="col" className="py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {run.rows.map((row) => (
                  <tr key={row.leadId} className="border-t border-border-subtle align-top">
                    <td className="py-2 pr-3 text-fg-1">{row.leadName ?? 'Lead no longer available'}</td>
                    <td className="py-2 pr-3">
                      <OutcomeBadge outcome={row.outcome} />
                    </td>
                    <td className="py-2 text-fg-2">{rowDetail(row)}</td>
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
