'use client';

/**
 * ROI calculator (plan T30, 06-design F12): every assumption is a visible, editable field, and the
 * result is labelled "Illustrative estimate. Edit the assumptions." The math lives in
 * src/lib/landing/roi.ts (pure, unit-tested: clamps, no NaN or Infinity, reset). Figures render
 * their final value at once on every edit (no count-up, no animation on numbers); money is text-1,
 * never colored. A field that was clamped says which value is in use, and leaving it writes that
 * value back.
 */
import { Info, RotateCcw } from 'lucide-react';
import { useId, useState } from 'react';
import { StatTile } from '@/components/patterns/StatTile';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import {
  ROI_DEFAULTS,
  ROI_KEYS,
  estimateRoi,
  formatAmount,
  formatWholeRupees,
  parseInput,
  resetInputs,
  type RoiInputs,
  type RoiKey,
} from '@/lib/landing/roi';

type Field = { key: RoiKey; label: string; hint: string; prefix?: string; suffix?: string };

const FIELDS: readonly Field[] = [
  { key: 'leadsPerMonth', label: 'Leads per month', hint: 'Across every source', suffix: 'leads' },
  { key: 'replyRatePct', label: 'Current reply rate', hint: 'Share of leads that reply today', suffix: '%' },
  { key: 'replyLiftPts', label: 'Assumed reply-rate lift', hint: 'Your guess for faster, consistent follow-up', suffix: 'points' },
  { key: 'dealValueInr', label: 'Average deal value', hint: 'Per closed deal, in rupees', prefix: '₹' },
  { key: 'closeRatePct', label: 'Close rate of replies', hint: 'Replies that become a deal', suffix: '%' },
  { key: 'hoursSavedPerLead', label: 'Hours saved per lead', hint: 'Copying, pricing and chasing by hand', suffix: 'hours' },
];

const asText = (inputs: RoiInputs): Record<RoiKey, string> =>
  Object.fromEntries(ROI_KEYS.map((k) => [k, String(inputs[k])])) as Record<RoiKey, string>;

export function RoiCalculator() {
  const baseId = useId();
  const [raw, setRaw] = useState<Record<RoiKey, string>>(() => asText(ROI_DEFAULTS));
  const values = Object.fromEntries(ROI_KEYS.map((k) => [k, parseInput(k, raw[k])])) as RoiInputs;
  const estimate = estimateRoi(values);
  const fieldId = (key: RoiKey) => `${baseId}-${key}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
      <section aria-labelledby={`${baseId}-assumptions`} className="flex min-w-0 flex-col gap-5 rounded-2xl border border-border-subtle bg-bg-1/80 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id={`${baseId}-assumptions`} className="font-display text-lg font-semibold text-fg-1">
            Your assumptions
          </h3>
          <Button type="button" variant="secondary" size="sm" onClick={() => setRaw(asText(resetInputs()))}>
            <RotateCcw aria-hidden="true" />
            Reset assumptions
          </Button>
        </div>
        <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const id = fieldId(f.key);
            const used = values[f.key];
            const typed = Number(raw[f.key].replace(/[₹,\s_]/g, '').replace(/%$/, ''));
            const clamped = raw[f.key].trim() !== '' && typed !== used;
            return (
              <div key={f.key} className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor={id} className="text-sm font-medium text-fg-1">
                  {f.label}
                </label>
                <div className="relative">
                  {f.prefix ? (
                    <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-2">
                      {f.prefix}
                    </span>
                  ) : null}
                  <Input
                    id={id}
                    name={f.key}
                    inputMode="decimal"
                    autoComplete="off"
                    value={raw[f.key]}
                    aria-describedby={`${id}-hint`}
                    onChange={(e) => setRaw((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    onBlur={() => setRaw((prev) => ({ ...prev, [f.key]: String(parseInput(f.key, prev[f.key])) }))}
                    className={cn('tabular h-10', f.prefix && 'pl-7', f.suffix && 'pr-16')}
                  />
                  {f.suffix ? (
                    <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-fg-2">
                      {f.suffix}
                    </span>
                  ) : null}
                </div>
                <p id={`${id}-hint`} className="text-xs text-fg-2">
                  {f.hint}
                  {clamped ? <span className="text-fg-1"> Using {formatAmount(used)}.</span> : null}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby={`${baseId}-result`} data-roi-result="" className="relative isolate flex min-w-0 flex-col gap-5 overflow-hidden rounded-2xl border border-border-strong bg-bg-1 p-5 sm:p-6">
        <AuroraBackdrop variant="card" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 [background-image:var(--grad-aurora)]" />
        <p className="inline-flex w-fit items-center gap-2 rounded-full border border-border-strong bg-bg-2 px-3 py-1 text-xs font-medium text-fg-1">
          <Info aria-hidden="true" className="size-3.5 shrink-0 text-aura" />
          Illustrative estimate. Edit the assumptions.
        </p>
        <div className="flex flex-col gap-1">
          <h3 id={`${baseId}-result`} className="text-sm text-fg-2">
            Extra revenue per month
          </h3>
          <output htmlFor={ROI_KEYS.map(fieldId).join(' ')} className="font-display text-4xl font-semibold tracking-[-0.02em] text-fg-1 tabular sm:text-5xl">
            {formatWholeRupees(estimate.extraRevenuePaise)}
          </output>
          <p className="text-sm text-fg-2">
            {formatAmount(estimate.extraDeals)} more deals a month at {formatWholeRupees(BigInt(values.dealValueInr) * 100n)} each.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Replies a month" value={formatAmount(estimate.repliesWithLift)} hint={`${formatAmount(estimate.repliesNow)} today`} className="p-3.5" />
          <StatTile label="Extra deals" value={formatAmount(estimate.extraDeals)} hint={`${formatAmount(values.closeRatePct)}% of new replies`} className="p-3.5" />
          <StatTile label="Hours saved" value={formatAmount(estimate.hoursSaved)} hint="a month" className="p-3.5" />
        </div>
        <p className="mt-auto text-xs text-fg-2">
          Extra revenue = leads x lift x close rate x deal value. The lift is your assumption, not a measured result; the reply rate is capped at 100%.
        </p>
      </section>
    </div>
  );
}
