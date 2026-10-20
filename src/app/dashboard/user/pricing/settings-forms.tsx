'use client';

/**
 * Settings forms of the Pricing page (T13): tax with an explicit mode (plan §8: "No tax" is a
 * choice, never a default of 0%), the workspace discount limit and the quote validity. Each form
 * posts only its own fields to /api/app/pricing/settings; the server validates the merged result.
 * Without `pricing.override` the values are shown read-only and the save control is gated by
 * permission (plan §12).
 *
 * A save runs once at a time whether it starts from the button or from Enter in a field (the form's
 * submit), so two quick Enters cannot post twice. The tax choice is a pair of radio cards: the chosen
 * card takes the panel hue with a check, and keyboard focus on the radio rings the whole card.
 */
import { useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { days as daysLabel } from '@/components/client/labels';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { cn } from '@/components/ui/cn';
import { bpsToPercentString, GSTIN_PATTERN, parsePercentToBps } from '@/lib/schemas/pricing';
import type { PricingSettingsDto } from '@/server/services/pricing/catalog';
import { FormAlert, TextField, type FieldErrors } from './fields';
import { usePricingMutation } from './use-pricing-mutation';

type Failure = { message: string; reference: string | null } | null;

function SaveRow(props: { gate: Gate | null; label: string; onSave: () => Promise<void> }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <GatedAction label={props.label} pendingLabel="Saving" gate={props.gate} onAction={props.onSave} />
    </div>
  );
}

function useSettingsSave() {
  const mutate = usePricingMutation();
  const [failure, setFailure] = useState<Failure>(null);
  const running = useRef(false);
  async function save(body: Record<string, unknown>, message: string) {
    setFailure(null);
    const outcome = await mutate(`/api/app/pricing/settings`, body, () => message);
    if (!outcome.ok) setFailure({ message: outcome.message, reference: outcome.reference });
  }
  /** Runs one save flow at a time (button and Enter share it). */
  async function guarded(run: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    try {
      await run();
    } finally {
      running.current = false;
    }
  }
  return { failure, save, guarded };
}

export function TaxForm({ settings, gate }: { settings: PricingSettingsDto; gate: Gate | null }) {
  const [mode, setMode] = useState(settings.taxMode);
  const [label, setLabel] = useState(settings.taxLabel ?? 'GST');
  const [rate, setRate] = useState(settings.taxBps === null ? '' : bpsToPercentString(settings.taxBps));
  const [gstin, setGstin] = useState(settings.gstin ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const { failure, save, guarded } = useSettingsSave();
  const readOnly = gate !== null;

  const onSave = () => guarded(saveTax);
  async function saveTax() {
    if (gate !== null) return;
    const next: FieldErrors = {};
    const bps = parsePercentToBps(rate);
    if (mode === 'CONFIGURED') {
      if (label.trim() === '') next.label = 'Enter the label printed on the tax line, for example GST.';
      if (bps === null || bps > 10_000) next.rate = 'Enter a rate between 0 and 100, for example 18.';
    }
    const g = gstin.trim().toUpperCase();
    if (g !== '' && !GSTIN_PATTERN.test(g)) next.gstin = 'A GSTIN has 15 characters, for example 07AAACR5055K1Z5.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body = mode === 'CONFIGURED' ? { taxMode: mode, taxLabel: label.trim(), taxBps: bps, gstin: g === '' ? null : g } : { taxMode: mode, gstin: g === '' ? null : g };
    await save(body, mode === 'CONFIGURED' ? `Tax saved: ${label.trim()} ${rate}%. New quotes use it.` : 'Saved: new quotes have no tax line.');
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <fieldset className="grid gap-2 sm:grid-cols-2" disabled={readOnly}>
        <legend className="mb-2 text-sm font-medium text-fg-1 sm:col-span-2">Tax on quotes</legend>
        {(
          [
            ['NONE', 'No tax', 'Quotes show no tax line.'],
            ['CONFIGURED', 'Add one tax line', 'For example GST 18%, applied to the discounted subtotal.'],
          ] as const
        ).map(([value, title, detail]) => (
          <label
            key={value}
            className={cn(
              'relative flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-[background-color,border-color] duration-fast has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-cyan',
              mode === value ? 'border-panel/55 bg-[linear-gradient(110deg,color-mix(in_oklab,var(--panel-hue)_12%,transparent),transparent_70%)]' : 'border-border-subtle bg-bg-1 hover:border-border-strong hover:bg-bg-2/60',
              readOnly && 'cursor-default',
            )}
          >
            <input type="radio" name="taxMode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1 size-4 accent-cyan focus-visible:outline-none" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium text-fg-1">{title}</span>
              <span className="text-sm text-fg-2">{detail}</span>
            </span>
            {mode === value ? <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-panel motion-safe:animate-reveal-focus" /> : null}
          </label>
        ))}
      </fieldset>
      {mode === 'CONFIGURED' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="taxLabel" label="Label" value={label} onChange={setLabel} error={errors.label} readOnly={readOnly} />
          <TextField name="taxRate" label="Rate" suffix="%" inputMode="decimal" value={rate} onChange={setRate} error={errors.rate} readOnly={readOnly} />
        </div>
      ) : null}
      <TextField
        name="gstin"
        label="GSTIN"
        value={gstin}
        onChange={setGstin}
        error={errors.gstin}
        readOnly={readOnly}
        hint="Optional. Printed on quotations, which are not tax invoices."
        className="sm:max-w-sm"
      />
      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
      <SaveRow gate={gate} label="Save tax settings" onSave={onSave} />
    </form>
  );
}

export function DiscountLimitForm({ settings, gate }: { settings: PricingSettingsDto; gate: Gate | null }) {
  const [limit, setLimit] = useState(bpsToPercentString(settings.maxDiscountBps));
  const [error, setError] = useState<string | undefined>();
  const { failure, save, guarded } = useSettingsSave();

  const onSave = () => guarded(saveLimit);
  async function saveLimit() {
    if (gate !== null) return;
    const bps = parsePercentToBps(limit);
    if (bps === null || bps > 10_000) {
      setError('Enter a percentage between 0 and 100.');
      return;
    }
    setError(undefined);
    await save({ maxDiscountBps: bps }, `Maximum discount saved: ${limit}%.`);
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <TextField
        name="maxDiscount"
        label="Maximum discount on any quote"
        suffix="%"
        inputMode="decimal"
        value={limit}
        onChange={setLimit}
        error={error}
        readOnly={gate !== null}
        hint="Nobody can discount a quote beyond this. A service limit below it applies to quotes that include that service; operators may have a lower personal limit."
        fieldClassName="max-w-40"
      />
      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
      <SaveRow gate={gate} label="Save discount limit" onSave={onSave} />
    </form>
  );
}

export function ValidityForm({ settings, gate }: { settings: PricingSettingsDto; gate: Gate | null }) {
  const [days, setDays] = useState(String(settings.quoteValidityDays));
  const [error, setError] = useState<string | undefined>();
  const { failure, save, guarded } = useSettingsSave();

  const onSave = () => guarded(saveValidity);
  async function saveValidity() {
    if (gate !== null) return;
    const n = /^\d{1,3}$/.test(days.trim()) ? Number(days.trim()) : NaN;
    if (!(n >= 1 && n <= 365)) {
      setError('Enter 1 to 365 days.');
      return;
    }
    setError(undefined);
    await save({ quoteValidityDays: n }, `New quotes are valid for ${daysLabel(n)}.`);
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <TextField
        name="validity"
        label="Quote validity"
        suffix="days"
        inputMode="numeric"
        value={days}
        onChange={setDays}
        error={error}
        readOnly={gate !== null}
        hint="A quote expires this many days after it is issued. Issued quotes keep their date."
        fieldClassName="max-w-40"
      />
      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
      <SaveRow gate={gate} label="Save validity" onSave={onSave} />
    </form>
  );
}
