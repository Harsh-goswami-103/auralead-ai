/**
 * Version diff on an approval item (T22; 06-design F18): "v3 (current)" against "v2 (approved, now
 * invalidated)" line by line (quantity, unit price, amount), then discount, tax and total. Every
 * change is named in words as well as shown by tone. Server-rendered.
 */
import { formatINR } from '@/lib/money';
import { cn } from '@/components/ui/cn';
import type { VersionDiff as Diff } from '@/server/services/approvals/queue';

const CHANGE_WORDS = { ADDED: 'Added', REMOVED: 'Removed', CHANGED: 'Changed', SAME: 'Unchanged' } as const;
const APPROVAL_WORDS: Record<string, string> = {
  APPROVED: 'approved',
  INVALIDATED: 'approved or waiting, now invalidated',
  REJECTED: 'rejected',
  PENDING: 'waiting for approval',
};

const money = (v: bigint | null) => (v === null ? '-' : formatINR(v));

export function VersionDiff({ diff }: { diff: Diff }) {
  const prev = diff.previousApproval ? ` (${APPROVAL_WORDS[diff.previousApproval] ?? diff.previousApproval.toLowerCase()})` : '';
  return (
    <section aria-labelledby="diff-heading" className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1 p-4" data-version-diff>
      <h2 id="diff-heading" className="text-lg font-semibold text-fg-1">
        v{diff.toVersionNo} (current) against v{diff.fromVersionNo}
        {prev}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <caption className="sr-only">
            Changes from version {diff.fromVersionNo} to version {diff.toVersionNo}
          </caption>
          <thead className="text-xs text-fg-2">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">Service</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Change</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">Qty</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">Unit price</th>
              <th scope="col" className="py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {diff.lines.map((l) => (
              <tr key={l.serviceId} className="border-t border-border-subtle" data-diff-change={l.change}>
                <td className="py-1.5 pr-3 text-fg-1">{l.name}</td>
                <td className={cn('py-1.5 pr-3', l.change === 'SAME' ? 'text-fg-2' : l.change === 'REMOVED' ? 'text-danger' : 'text-warning')}>{CHANGE_WORDS[l.change]}</td>
                <td className="py-1.5 pr-3 text-right tabular text-fg-1">{l.fromQty === l.toQty ? l.toQty : `${l.fromQty ?? '-'} → ${l.toQty ?? '-'}`}</td>
                <td className="py-1.5 pr-3 text-right tabular text-fg-2">{l.fromUnitPricePaise === l.toUnitPricePaise ? money(l.toUnitPricePaise) : `${money(l.fromUnitPricePaise)} → ${money(l.toUnitPricePaise)}`}</td>
                <td className="py-1.5 text-right tabular text-fg-1">{l.fromLineTotalPaise === l.toLineTotalPaise ? money(l.toLineTotalPaise) : `${money(l.fromLineTotalPaise)} → ${money(l.toLineTotalPaise)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-2">Discount</dt>
        <dd className="text-right tabular text-fg-1">{diff.discount.from === diff.discount.to ? `-${money(diff.discount.to)}` : `-${money(diff.discount.from)} → -${money(diff.discount.to)}`}</dd>
        <dt className="text-fg-2">Tax</dt>
        <dd className="text-right tabular text-fg-1">{diff.tax.from === diff.tax.to ? money(diff.tax.to) : `${money(diff.tax.from)} → ${money(diff.tax.to)}`}</dd>
        <dt className="font-semibold text-fg-1">Total</dt>
        <dd className="text-right font-semibold tabular text-fg-1">{diff.totals.from === diff.totals.to ? money(diff.totals.to) : `${money(diff.totals.from)} → ${money(diff.totals.to)}`}</dd>
      </dl>
    </section>
  );
}
