'use client';

/**
 * Quote editor (T15) for "New quotation" (from an AI proposal or typed) and "Revise". A line is a
 * catalog service and a quantity; the person never types a price (C12). Unit prices shown here are
 * the active price list for orientation; the server prices the version from its price list when it
 * is saved, applies the discount limits and tax, and stores the totals. Discounts are typed as a
 * percentage or rupees and sent as basis points or paise. Any server refusal is shown with its
 * reference; nothing is reported as saved until the server confirms it.
 */
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { formatINR, parseRupeesToPaise, paiseToRupeeString } from '@/lib/money';
import { bpsToPercentString, parsePercentToBps } from '@/lib/schemas/pricing';
import { QUOTE_TEXT_LIMITS, QUOTE_VALIDITY_DAYS, type DISCOUNT_KINDS } from '@/lib/schemas/quotes';
import type { QuoteEditorCatalogDto } from '@/server/services/quotes/versioning';
import { FormAlert, TextField, type FieldErrors } from '../pricing/fields';
import { useQuoteMutation } from './use-quote-mutation';

type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export type EditorLine = { serviceId: string; qty: number; name?: string; unitLabel?: string };

export type EditorInitial = {
  items: EditorLine[];
  discountKind: DiscountKind;
  /** Basis points (PERCENT_BPS) or paise (FLAT_PAISE) as an integer string. */
  discountValue: string;
  scopeText: string;
  timelineText: string;
  validityDays: number | null;
};

export type EditorMode =
  | { kind: 'create'; leadId: string; draftId: string | null }
  | { kind: 'revise'; quoteId: string; expectedVersion: number; pricingVersionId: string; pricingVersionNo: number | null };

type Row = { key: number; serviceId: string; qty: string; name?: string; unitLabel?: string };

const selectClass =
  'h-9 w-full rounded-md border border-input bg-input/30 px-3 text-sm text-fg-1 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

function discountText(kind: DiscountKind, value: string): string {
  if (kind === 'PERCENT_BPS') return bpsToPercentString(Number(value));
  if (kind === 'FLAT_PAISE') return paiseToRupeeString(BigInt(value));
  return '';
}

export function QuoteEditor(props: { catalog: QuoteEditorCatalogDto; mode: EditorMode; initial: EditorInitial; gate: Gate | null; submitLabel: string; onSaved?: () => void }) {
  const { catalog, mode, initial } = props;
  const mutate = useQuoteMutation();
  const byId = useMemo(() => new Map(catalog.services.map((s) => [s.id, s])), [catalog.services]);
  const [rows, setRows] = useState<Row[]>(() => initial.items.map((i, key) => ({ key, serviceId: i.serviceId, qty: String(i.qty), name: i.name, unitLabel: i.unitLabel })));
  const [nextKey, setNextKey] = useState(initial.items.length);
  const [adding, setAdding] = useState('');
  const [discountKind, setDiscountKind] = useState<DiscountKind>(initial.discountKind);
  const [discount, setDiscount] = useState(initial.discountKind === 'NONE' ? '' : discountText(initial.discountKind, initial.discountValue));
  const [scopeText, setScope] = useState(initial.scopeText);
  const [timelineText, setTimeline] = useState(initial.timelineText);
  const [validity, setValidity] = useState(String(initial.validityDays ?? catalog.settings.quoteValidityDays));
  const [reprice, setReprice] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);

  const remaining = catalog.services.filter((s) => !rows.some((r) => r.serviceId === s.id));
  const limitBps = rows.reduce<number>((min, r) => {
    const s = byId.get(r.serviceId);
    return s && s.maxDiscountBps !== null ? Math.min(min, s.maxDiscountBps) : min;
  }, catalog.settings.maxDiscountBps);
  const capBps = catalog.actorMaxDiscountBps;
  const newerPriceList = mode.kind === 'revise' && catalog.activePricingVersion !== null && catalog.activePricingVersion.id !== mode.pricingVersionId;

  let listEstimate = 0n;
  for (const r of rows) {
    const s = byId.get(r.serviceId);
    if (s && /^\d{1,5}$/.test(r.qty)) listEstimate += BigInt(s.unitPricePaise) * BigInt(r.qty);
  }

  function addLine() {
    const s = byId.get(adding);
    if (!s) return;
    setRows((prev) => [...prev, { key: nextKey, serviceId: s.id, qty: String(s.minQty) }]);
    setNextKey((k) => k + 1);
    setAdding('');
  }

  function parse(): { ok: true; body: Record<string, unknown> } | { ok: false; errors: FieldErrors } {
    const e: FieldErrors = {};
    if (rows.length === 0) e.items = 'Add at least one service.';
    const items = rows.map((r) => {
      if (!/^\d{1,5}$/.test(r.qty.trim()) || Number(r.qty) < 1) e[`qty-${r.key}`] = 'Enter a whole number of at least 1.';
      return { serviceId: r.serviceId, qty: Number(r.qty) };
    });
    let value = '0';
    if (discountKind === 'PERCENT_BPS') {
      const bps = parsePercentToBps(discount);
      if (bps === null) e.discount = 'Enter a percentage such as 5 or 7.5.';
      else value = String(bps);
    } else if (discountKind === 'FLAT_PAISE') {
      try {
        value = parseRupeesToPaise(discount).toString();
      } catch {
        e.discount = 'Enter a rupee amount, for example 1,500 or 999.50.';
      }
    }
    if (scopeText.trim() === '') e.scopeText = 'Describe the scope of work.';
    if (timelineText.trim() === '') e.timelineText = 'Give a timeline, for example "Two weeks".';
    const days = Number(validity);
    if (!/^\d{1,3}$/.test(validity.trim()) || days < QUOTE_VALIDITY_DAYS.min || days > QUOTE_VALIDITY_DAYS.max) e.validity = `Enter ${QUOTE_VALIDITY_DAYS.min} to ${QUOTE_VALIDITY_DAYS.max} days.`;
    if (Object.keys(e).length > 0) return { ok: false, errors: e };
    return { ok: true, body: { items, discount: { kind: discountKind, value }, scopeText, timelineText, validityDays: days } };
  }

  async function submit() {
    setFailure(null);
    const parsed = parse();
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    const outcome =
      mode.kind === 'create'
        ? await mutate<{ quote: { id: string; number: string } }>('/api/app/quotes', { leadId: mode.leadId, draftId: mode.draftId, ...parsed.body }, (d) => ({
            message: `Quotation ${d.quote.number} created as a draft (v1).`,
            redirectTo: `/dashboard/user/quotations/${d.quote.id}`,
          }))
        : await mutate<{ version: { versionNo: number } }>(
            `/api/app/quotes/${mode.quoteId}/revise`,
            { expectedVersion: mode.expectedVersion, ...(reprice ? { repriceToActive: true } : {}), ...parsed.body },
            (d) => ({ message: `Saved as version ${d.version.versionNo}. It needs approval again.` }),
          );
    if (!outcome.ok) setFailure({ message: outcome.message, reference: outcome.reference });
    else props.onSaved?.();
  }

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-fg-1">Services</legend>
        {rows.length === 0 ? <p className="text-sm text-fg-2">No services yet. Add one from the price list below.</p> : null}
        <ul className="flex flex-col gap-2">
          {rows.map((r) => {
            const s = byId.get(r.serviceId);
            const name = s?.name ?? r.name ?? 'Service';
            return (
              <li key={r.key} className="grid grid-cols-[1fr_auto_auto] items-end gap-2 rounded-md border border-border-subtle bg-bg-2 p-3 sm:grid-cols-[1fr_8rem_9rem_auto]">
                <div className="col-span-3 flex flex-col sm:col-span-1">
                  <span className="text-sm font-medium text-fg-1">{name}</span>
                  <span className="text-xs text-fg-2">
                    {s ? `${formatINR(BigInt(s.unitPricePaise))} per ${s.unitLabel}, ${s.minQty} to ${s.maxQty}` : 'Not in the current price list; the server keeps it for review if it has no price.'}
                  </span>
                </div>
                <TextField name={`qty-${r.key}`} label={`Quantity of ${name}`} value={r.qty} inputMode="numeric" error={errors[`qty-${r.key}`]} onChange={(v) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: v } : x)))} />
                <p className="pb-2 text-right text-sm text-fg-2 tabular">{s && /^\d{1,5}$/.test(r.qty) ? formatINR(BigInt(s.unitPricePaise) * BigInt(r.qty)) : ''}</p>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
        {errors.items ? <p className="text-xs text-danger">{errors.items}</p> : null}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <Label htmlFor="quote-add-service" className="text-fg-1">
              Add a service
            </Label>
            <select id="quote-add-service" className={selectClass} value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose from price list {catalog.activePricingVersion ? `v${catalog.activePricingVersion.version}` : ''}</option>
              {remaining.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({formatINR(BigInt(s.unitPricePaise))} per {s.unitLabel})
                </option>
              ))}
            </select>
          </div>
          <Button type="button" variant="outline" onClick={addLine} aria-disabled={adding === '' || undefined}>
            <Plus aria-hidden="true" />
            Add
          </Button>
        </div>
        <p className="text-xs text-fg-2">List price before discount and tax: {formatINR(listEstimate)}. The server prices the quote from the price list when you save.</p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="quote-discount-kind" className="text-fg-1">
            Discount
          </Label>
          <select
            id="quote-discount-kind"
            className={selectClass}
            value={discountKind}
            onChange={(e) => {
              setDiscountKind(e.target.value as DiscountKind);
              setDiscount('');
            }}
          >
            <option value="NONE">No discount</option>
            <option value="PERCENT_BPS">Percentage of subtotal</option>
            <option value="FLAT_PAISE">Flat amount (₹)</option>
          </select>
          <p className="text-xs text-fg-2">
            Limit for these services: {bpsToPercentString(limitBps)}%{capBps !== null ? `. Your own limit: ${bpsToPercentString(capBps)}%.` : '.'}
          </p>
        </div>
        {discountKind !== 'NONE' ? (
          <TextField
            name="discount"
            label={discountKind === 'PERCENT_BPS' ? 'Discount (%)' : 'Discount (₹)'}
            value={discount}
            inputMode="decimal"
            suffix={discountKind === 'PERCENT_BPS' ? '%' : undefined}
            prefix={discountKind === 'FLAT_PAISE' ? '₹' : undefined}
            error={errors.discount}
            onChange={setDiscount}
          />
        ) : null}
      </div>

      <TextField name="scopeText" label="Scope of work" multiline value={scopeText} error={errors.scopeText} hint={`Up to ${QUOTE_TEXT_LIMITS.scope} characters. Printed on the quotation.`} onChange={setScope} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="timelineText" label="Timeline" value={timelineText} error={errors.timelineText} onChange={setTimeline} />
        <TextField name="validityDays" label="Valid for" suffix="days" inputMode="numeric" value={validity} error={errors.validity} hint="The quotation and its links lapse after this." onChange={setValidity} />
      </div>

      {newerPriceList && mode.kind === 'revise' ? (
        <label className="flex items-start gap-2 text-sm text-fg-1">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={reprice} onChange={(e) => setReprice(e.target.checked)} />
          <span>
            Use the current price list (v{catalog.activePricingVersion!.version}) instead of the one this quote was priced with{mode.pricingVersionNo !== null ? ` (v${mode.pricingVersionNo})` : ''}.
          </span>
        </label>
      ) : null}

      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
      <div>
        <GatedAction label={props.submitLabel} pendingLabel="Saving..." gate={props.gate} onAction={submit} />
      </div>
    </div>
  );
}
