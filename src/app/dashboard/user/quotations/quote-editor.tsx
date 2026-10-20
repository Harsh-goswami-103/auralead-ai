'use client';

/**
 * Quote editor (T15) for "New quotation" (from an AI proposal or typed) and "Revise". A line is a
 * catalog service and a quantity; the person never types a price (C12). Unit prices shown here are
 * the active price list for orientation; the server prices the version from its price list when it
 * is saved, applies the discount limits and tax, and stores the totals. Discounts are typed as a
 * percentage or rupees and sent as basis points or paise. Any server refusal is shown with its
 * reference; nothing is reported as saved until the server confirms it.
 *
 * Aurora look (design spec §6): each line is a card that rises in when added (CSS entrance, static
 * under reduced motion; no exit animation, so a removed line is gone at once), with a short visible
 * "Quantity" label whose accessible name still names the service. The list-price estimate is a
 * static summary line (no count-up). Selects use the shared NativeSelect. Creating a quotation is
 * the page's one primary action (GlowFrame); in revise mode the page's Approve keeps that role.
 */
import { useMemo, useState } from 'react';
import { BadgePercent, Calculator, ListPlus, Plus, Trash2 } from 'lucide-react';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { Reveal } from '@/components/visual/Reveal';
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
  | {
      kind: 'revise';
      quoteId: string;
      expectedVersion: number;
      pricingVersionId: string;
      pricingVersionNo: number | null;
      /** T22: the approval queue saves through /api/app/approvals/[id]/revise with its workspace slug. */
      endpoint?: string;
      extraBody?: Record<string, string>;
    };

type Row = { key: number; serviceId: string; qty: string; name?: string; unitLabel?: string };

const range = (min: number, max: number) => `${min.toLocaleString('en-IN')} to ${max.toLocaleString('en-IN')}`;

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
            mode.endpoint ?? `/api/app/quotes/${mode.quoteId}/revise`,
            { ...(mode.extraBody ?? {}), expectedVersion: mode.expectedVersion, ...(reprice ? { repriceToActive: true } : {}), ...parsed.body },
            (d) => ({ message: `Saved as version ${d.version.versionNo}. It needs approval again.` }),
          );
    if (!outcome.ok) setFailure({ message: outcome.message, reference: outcome.reference });
    else props.onSaved?.();
  }

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-2 flex items-center gap-2 text-sm font-medium text-fg-1">
          <ListPlus aria-hidden="true" className="size-4 text-panel" />
          Services
        </legend>
        {rows.length === 0 ? <p className="rounded-lg border border-dashed border-border-strong px-3 py-3 text-sm text-fg-2">No services yet. Add one from the price list below.</p> : null}
        <ul className="flex flex-col gap-2">
          {rows.map((r) => {
            const s = byId.get(r.serviceId);
            const name = s?.name ?? r.name ?? 'Service';
            return (
              <Reveal
                as="li"
                key={r.key}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-x-3 gap-y-2 rounded-xl border border-border-subtle bg-bg-2/60 p-3 transition-colors duration-fast hover:border-border-strong sm:grid-cols-[minmax(0,1fr)_6.5rem_8.5rem_auto]"
              >
                <div className="col-span-3 flex min-w-0 flex-col gap-0.5 self-center sm:col-span-1">
                  <span className="text-sm font-medium text-fg-1">{name}</span>
                  <span className="text-xs text-fg-2">
                    {s ? `${formatINR(BigInt(s.unitPricePaise))} per ${s.unitLabel}, ${range(s.minQty, s.maxQty)}` : 'Not in the current price list; the server keeps it for review if it has no price.'}
                  </span>
                </div>
                <TextField
                  name={`qty-${r.key}`}
                  label={
                    <>
                      Quantity<span className="sr-only"> of {name}</span>
                    </>
                  }
                  value={r.qty}
                  inputMode="numeric"
                  error={errors[`qty-${r.key}`]}
                  onChange={(v) => setRows((prev) => prev.map((x) => (x.key === r.key ? { ...x, qty: v } : x)))}
                  className="max-sm:max-w-32"
                />
                <p className="flex flex-col items-end gap-0.5 pb-2 text-right">
                  <span className="text-xs text-fg-3">Amount</span>
                  <span className="tabular text-sm font-semibold text-fg-1">{s && /^\d{1,5}$/.test(r.qty) ? formatINR(BigInt(s.unitPricePaise) * BigInt(r.qty)) : ''}</span>
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${name}`}
                  className="text-fg-2 hover:bg-danger/10 hover:text-danger"
                  onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </Reveal>
            );
          })}
        </ul>
        {errors.items ? <p className="text-xs text-danger">{errors.items}</p> : null}
        <div className="flex max-w-2xl flex-wrap items-end gap-2">
          <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1.5">
            <Label htmlFor="quote-add-service" className="text-fg-1">
              Add a service
            </Label>
            <NativeSelect id="quote-add-service" wrapperClassName="w-full" value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose from price list {catalog.activePricingVersion ? `v${catalog.activePricingVersion.version}` : ''}</option>
              {remaining.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({formatINR(BigInt(s.unitPricePaise))} per {s.unitLabel})
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="button" variant="outline" onClick={addLine} aria-disabled={adding === '' || undefined} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
            <Plus aria-hidden="true" />
            Add
          </Button>
        </div>
        <p className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-1/60 px-3 py-2 text-xs text-fg-2">
          <Calculator aria-hidden="true" className="mt-px size-3.5 shrink-0 text-panel" />
          <span>List price before discount and tax: {formatINR(listEstimate)}. The server prices the quote from the price list when you save.</span>
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="quote-discount-kind" className="text-fg-1">
            Discount
          </Label>
          <NativeSelect
            id="quote-discount-kind"
            wrapperClassName="w-full"
            value={discountKind}
            onChange={(e) => {
              setDiscountKind(e.target.value as DiscountKind);
              setDiscount('');
            }}
          >
            <option value="NONE">No discount</option>
            <option value="PERCENT_BPS">Percentage of subtotal</option>
            <option value="FLAT_PAISE">Flat amount (₹)</option>
          </NativeSelect>
          <p className="flex items-start gap-1.5 text-xs text-fg-2">
            <BadgePercent aria-hidden="true" className="mt-px size-3.5 shrink-0 text-zest" />
            <span>
              Limit for these services: {bpsToPercentString(limitBps)}%{capBps !== null ? `. Your own limit: ${bpsToPercentString(capBps)}%.` : '.'}
            </span>
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
            fieldClassName="max-w-48"
          />
        ) : null}
      </div>

      <TextField name="scopeText" label="Scope of work" multiline value={scopeText} error={errors.scopeText} hint={`Up to ${QUOTE_TEXT_LIMITS.scope} characters. Printed on the quotation.`} onChange={setScope} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <TextField name="timelineText" label="Timeline" value={timelineText} error={errors.timelineText} onChange={setTimeline} />
        <TextField name="validityDays" label="Valid for" suffix="days" inputMode="numeric" value={validity} error={errors.validity} hint="The quotation and its links lapse after this." onChange={setValidity} fieldClassName="max-w-32" className="sm:max-w-72" />
      </div>

      {newerPriceList && mode.kind === 'revise' ? (
        <label className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-2/40 px-3 py-2.5 text-sm text-fg-1">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={reprice} onChange={(e) => setReprice(e.target.checked)} />
          <span>
            Use the current price list (v{catalog.activePricingVersion!.version}) instead of the one this quote was priced with{mode.pricingVersionNo !== null ? ` (v${mode.pricingVersionNo})` : ''}.
          </span>
        </label>
      ) : null}

      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-4">
        {mode.kind === 'create' && props.gate === null ? (
          <GlowFrame>
            <GatedAction label={props.submitLabel} pendingLabel="Saving..." gate={null} onAction={submit} />
          </GlowFrame>
        ) : (
          <GatedAction label={props.submitLabel} pendingLabel="Saving..." gate={props.gate} onAction={submit} />
        )}
      </div>
    </div>
  );
}
