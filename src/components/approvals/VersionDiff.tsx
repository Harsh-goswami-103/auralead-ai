/**
 * Version diff on an approval item (T22; 06-design F18): "v3 (current)" against "v2 (approved, now
 * invalidated)" line by line (quantity, unit price, amount), then discount, tax and total. Every
 * change is named in words as well as shown by tone and a marker. Server-rendered.
 *
 * Look (design spec §6, employee report): added rows tinted success with a "+" marker, removed rows
 * danger with "−" and struck-through text, changed rows warning with a swap marker; unchanged rows
 * stay neutral. A changed value shows the old one struck through, an arrow and the new one, with
 * "from X to Y" for screen readers. The total change is a neutral chip with its sign and an icon
 * (money is never colored). Keeps data-version-diff and data-diff-change.
 */
import { ArrowRight, ArrowRightLeft, Equal, Minus, Plus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { formatINR } from '@/lib/money';
import { cn } from '@/components/ui/cn';
import { SectionCard } from '@/components/patterns/SectionCard';
import type { VersionDiff as Diff } from '@/server/services/approvals/queue';

const CHANGE_WORDS = { ADDED: 'Added', REMOVED: 'Removed', CHANGED: 'Changed', SAME: 'Unchanged' } as const;
const CHANGE_STYLE: Readonly<Record<keyof typeof CHANGE_WORDS, { row: string; chip: string; icon: LucideIcon }>> = {
  ADDED: { row: 'bg-success/8', chip: 'border-success/35 bg-success/12 text-success', icon: Plus },
  REMOVED: { row: 'bg-danger/8', chip: 'border-danger/35 bg-danger/12 text-danger', icon: Minus },
  CHANGED: { row: 'bg-warning/8', chip: 'border-warning/35 bg-warning/12 text-warning', icon: ArrowRightLeft },
  SAME: { row: '', chip: 'border-border-strong bg-bg-2 text-fg-2', icon: Equal },
};
const APPROVAL_WORDS: Record<string, string> = {
  APPROVED: 'approved',
  INVALIDATED: 'approved or waiting, now invalidated',
  REJECTED: 'rejected',
  PENDING: 'waiting for approval',
};

const money = (v: bigint | null) => (v === null ? '-' : formatINR(v));
/** A discount reads "None" when there is none (not "-₹0.00"). */
const discount = (v: bigint) => (v === 0n ? 'None' : `−${formatINR(v)}`);

/** A value that may have changed: unchanged as is; changed as old (struck) → new, with words for screen readers. */
function Delta({ from, to, render, removed }: { from: string | null; to: string | null; render?: (v: string) => string; removed?: boolean }) {
  const show = render ?? ((v: string) => v);
  if (from === to || from === null) {
    return <span className={cn(removed && 'text-fg-3 line-through')}>{to === null ? (from === null ? '-' : show(from)) : show(to)}</span>;
  }
  if (to === null) return <span className="text-fg-3 line-through">{show(from)}</span>;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1">
      <span aria-hidden="true" className="text-fg-3 line-through">
        {show(from)}
      </span>
      <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-fg-3" />
      <span aria-hidden="true" className="font-semibold text-fg-1">
        {show(to)}
      </span>
      <span className="sr-only">
        from {show(from)} to {show(to)}
      </span>
    </span>
  );
}

export function VersionDiff({ diff }: { diff: Diff }) {
  const prev = diff.previousApproval ? ` (${APPROVAL_WORDS[diff.previousApproval] ?? diff.previousApproval.toLowerCase()})` : '';
  const change = diff.totals.to - diff.totals.from;
  const ChangeIcon = change > 0n ? TrendingUp : change < 0n ? TrendingDown : Equal;
  return (
    <div data-version-diff="" className="flex min-w-0 flex-col">
      <SectionCard
        title={
          <>
            v{diff.toVersionNo} (current) against v{diff.fromVersionNo}
            {prev}
          </>
        }
        actions={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-bg-2 px-2.5 py-1 text-xs text-fg-1">
            <ChangeIcon aria-hidden="true" className="size-3.5 text-fg-2" />
            <span className="tabular">{change === 0n ? 'Total unchanged' : `Total ${change > 0n ? '+' : '−'}${formatINR(change > 0n ? change : -change)}`}</span>
          </span>
        }
      >
        <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
          <table className="w-full min-w-[38rem] text-left text-sm">
            <caption className="sr-only">
              Changes from version {diff.fromVersionNo} to version {diff.toVersionNo}
            </caption>
            <thead className="border-y border-border-subtle bg-bg-2/40 text-xs text-fg-2">
              <tr>
                <th scope="col" className="py-2 pr-3 pl-4 font-medium sm:pl-5">Service</th>
                <th scope="col" className="px-3 py-2 font-medium">Change</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Qty</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Unit price</th>
                <th scope="col" className="py-2 pr-4 pl-3 text-right font-medium sm:pr-5">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {diff.lines.map((l) => {
                const style = CHANGE_STYLE[l.change];
                const ChangeMark = style.icon;
                const removed = l.change === 'REMOVED';
                return (
                  <tr key={l.serviceId} className={style.row} data-diff-change={l.change}>
                    <td className={cn('py-2 pr-3 pl-4 sm:pl-5', removed ? 'text-fg-2 line-through' : 'text-fg-1')}>{l.name}</td>
                    <td className="px-3 py-2">
                      <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', style.chip)}>
                        <ChangeMark aria-hidden="true" className="size-3.5" />
                        {CHANGE_WORDS[l.change]}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-1">
                      <Delta from={l.fromQty === null ? null : String(l.fromQty)} to={l.toQty === null ? null : String(l.toQty)} removed={removed} />
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-2">
                      <Delta from={l.fromUnitPricePaise === null ? null : l.fromUnitPricePaise.toString()} to={l.toUnitPricePaise === null ? null : l.toUnitPricePaise.toString()} render={(v) => money(BigInt(v))} removed={removed} />
                    </td>
                    <td className="tabular py-2 pr-4 pl-3 text-right text-fg-1 sm:pr-5">
                      <Delta from={l.fromLineTotalPaise === null ? null : l.fromLineTotalPaise.toString()} to={l.toLineTotalPaise === null ? null : l.toLineTotalPaise.toString()} render={(v) => money(BigInt(v))} removed={removed} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-y-1.5 text-sm">
          <dt className="text-fg-2">Discount</dt>
          <dd className="tabular pl-4 text-right text-fg-1">
            <Delta from={diff.discount.from.toString()} to={diff.discount.to.toString()} render={(v) => discount(BigInt(v))} />
          </dd>
          <dt className="text-fg-2">Tax</dt>
          <dd className="tabular pl-4 text-right text-fg-1">
            <Delta from={diff.tax.from.toString()} to={diff.tax.to.toString()} render={(v) => money(BigInt(v))} />
          </dd>
          <dt className="border-t border-dashed border-border-strong pt-1.5 font-semibold text-fg-1">Total</dt>
          <dd className="tabular border-t border-dashed border-border-strong pt-1.5 pl-4 text-right font-display text-base font-semibold text-fg-1">
            <Delta from={diff.totals.from.toString()} to={diff.totals.to.toString()} render={(v) => money(BigInt(v))} />
          </dd>
        </dl>
      </SectionCard>
    </div>
  );
}
