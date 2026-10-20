/**
 * Quotation status history (T27 "status history polish"; PRD "Quotations: ... status history").
 * The quote's audit timeline lists every event (links, PDFs, views); this is the status path only:
 * one step per status change, derived from the same audit rows, with who moved it, the version and
 * how long it stayed in each status ("for 2 days", the current one "since").
 *  - A repeat (a second open, a second send) does not add a step; housekeeping rows are not steps.
 *  - A revision returns the quote to Draft with its new version.
 *  - A quote past its validity before the sweep ran reads Expired (as its badge does): the step is
 *    added at the validity date and marked as derived from the date, not from an event.
 * Status chips use the shared quote vocabulary (icon + label, never colour alone). Server-safe.
 */
import type { QuoteStatus } from '@/lib/domain/enums';
import { TONE_CLASSES } from '@/components/patterns/status-vocabulary';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';
import { QUOTE_STATUS_VOCABULARY } from './quote-status';

/** The status each audit action moves a quote to. Anything else is not a status change. */
const STATUS_OF_ACTION: Readonly<Record<string, QuoteStatus>> = {
  'quote.create': 'DRAFT',
  'quote.revise': 'DRAFT',
  'quote.approve': 'APPROVED',
  'quote.send': 'SENT',
  'quote.sent': 'SENT',
  'quote.view': 'VIEWED',
  'quote.accept': 'ACCEPTED',
  'quote.expire': 'EXPIRED',
  'quote.cancel': 'CANCELLED',
};

export type StatusTimelineRow = { id: string; action: string; createdAt: Date; who: string | null; versionNo: number | null };

export type StatusStep = {
  id: string;
  status: QuoteStatus;
  at: Date;
  who: string | null;
  versionNo: number | null;
  /** Time in this status: until the next step, or until now for the current one. */
  durationMs: number;
  current: boolean;
  /** True for the Expired step read from the validity date (no sweep event yet). */
  derived: boolean;
};

export function deriveStatusHistory(rows: StatusTimelineRow[], opts: { effectiveStatus: QuoteStatus; validUntil: Date | null; now: Date }): StatusStep[] {
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const steps: Array<Omit<StatusStep, 'durationMs' | 'current'>> = [];
  for (const r of ordered) {
    const status = STATUS_OF_ACTION[r.action];
    if (!status) continue;
    const last = steps.at(-1);
    // A revision is a new Draft even after a Draft (a new version); other repeats are not steps.
    if (last && last.status === status && r.action !== 'quote.revise') continue;
    steps.push({ id: r.id, status, at: r.createdAt, who: r.who, versionNo: r.versionNo, derived: false });
  }
  if (opts.effectiveStatus === 'EXPIRED' && steps.at(-1)?.status !== 'EXPIRED' && opts.validUntil) {
    steps.push({ id: 'derived-expiry', status: 'EXPIRED', at: opts.validUntil, who: null, versionNo: steps.at(-1)?.versionNo ?? null, derived: true });
  }
  return steps.map((s, i) => {
    const next = steps[i + 1];
    const end = next ? next.at : opts.now;
    return { ...s, durationMs: Math.max(0, end.getTime() - s.at.getTime()), current: next === undefined };
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "under a minute", "5 min", "2 h 5 min", "1 day", "3 days 4 h". */
export function formatSpan(ms: number): string {
  if (ms < MINUTE) return 'under a minute';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  if (d > 0) return `${d} ${d === 1 ? 'day' : 'days'}${h > 0 ? ` ${h} h` : ''}`;
  if (h > 0) return `${h} h${m > 0 ? ` ${m} min` : ''}`;
  return `${m} min`;
}

export function QuoteStatusHistory(props: { steps: StatusStep[]; timeZone: string }) {
  if (props.steps.length === 0) return <p className="text-sm text-fg-2">No status changes recorded yet.</p>;
  return (
    <ol className="flex flex-col gap-2">
      {props.steps.map((s) => {
        const entry = QUOTE_STATUS_VOCABULARY[s.status];
        const Icon = entry.icon;
        return (
          <li key={s.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm', s.current ? 'border-panel/45 bg-panel/8' : 'border-border-subtle bg-bg-2/40')}>
            <span className={cn('inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE_CLASSES[entry.tone])}>
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              {entry.label}
            </span>
            {s.versionNo !== null ? <span className="text-xs text-fg-2">v{s.versionNo}</span> : null}
            <span className="min-w-0 flex-1 text-xs text-fg-2">
              {s.derived ? 'Validity date passed ' : ''}
              <time dateTime={s.at.toISOString()}>{formatDateTime(s.at, props.timeZone)}</time>
              {s.who ? ` · ${s.who}` : ''}
            </span>
            <span className="text-xs font-medium whitespace-nowrap text-fg-1">{s.current ? `Current, ${formatSpan(s.durationMs)} so far` : `for ${formatSpan(s.durationMs)}`}</span>
          </li>
        );
      })}
    </ol>
  );
}
