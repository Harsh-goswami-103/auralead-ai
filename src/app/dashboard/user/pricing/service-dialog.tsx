'use client';

/**
 * Add or edit a service (T13). The person types rupees and percentages; the form converts them to
 * paise and basis points with the shared helpers and sends only the changed fields with the price
 * list version it was opened on. The server decides: a price or quantity change publishes the
 * next price list version, other edits update the service in place, and its message (with the
 * reference) is shown when it refuses.
 */
import { useState, type ReactNode } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { IconChip } from '@/components/client/IconChip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { paiseToRupeeString, parseRupeesToPaise } from '@/lib/money';
import { bpsToPercentString, parsePercentToBps, SERVICE_CODE_PATTERN } from '@/lib/schemas/pricing';
import type { CatalogServiceDto } from '@/server/services/pricing/catalog';
import { FormAlert, TextField, type FieldErrors } from './fields';
import { usePricingMutation, versionMessage, type VersionResult } from './use-pricing-mutation';

type FormState = {
  code: string;
  name: string;
  description: string;
  unitLabel: string;
  price: string;
  minQty: string;
  maxQty: string;
  timelineDays: string;
  discountLimit: string;
};

function initial(service: CatalogServiceDto | null): FormState {
  return {
    code: service?.code ?? '',
    name: service?.name ?? '',
    description: service?.description ?? '',
    unitLabel: service?.unitLabel ?? '',
    price: service?.price ? paiseToRupeeString(BigInt(service.price.unitPricePaise)) : '',
    minQty: String(service?.price?.minQty ?? 1),
    maxQty: String(service?.price?.maxQty ?? 10000),
    timelineDays: service?.defaultTimelineDays === null || service?.defaultTimelineDays === undefined ? '' : String(service.defaultTimelineDays),
    discountLimit: service?.maxDiscountBps === null || service?.maxDiscountBps === undefined ? '' : bpsToPercentString(service.maxDiscountBps),
  };
}

type Parsed = {
  code: string;
  name: string;
  description: string;
  unitLabel: string;
  unitPricePaise: string;
  minQty: number;
  maxQty: number;
  defaultTimelineDays: number | null;
  maxDiscountBps: number | null;
};

const WHOLE = /^\d{1,6}$/;

function parse(form: FormState, creating: boolean): { ok: true; value: Parsed } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const code = form.code.trim().toUpperCase();
  if (creating && !SERVICE_CODE_PATTERN.test(code)) errors.code = 'Use 1 to 32 capital letters, digits or hyphens, for example SEO-BASIC.';
  if (form.name.trim() === '') errors.name = 'Enter a service name.';
  if (form.unitLabel.trim() === '') errors.unitLabel = 'Enter the unit you charge per, for example "page" or "month".';
  let unitPricePaise = '';
  try {
    const paise = parseRupeesToPaise(form.price);
    if (paise < 0n) errors.price = 'The price cannot be negative.';
    unitPricePaise = paise.toString();
  } catch {
    errors.price = 'Enter a rupee amount with at most two decimals, for example 12,500 or 999.50.';
  }
  if (!WHOLE.test(form.minQty.trim())) errors.minQty = 'Enter a whole number.';
  if (!WHOLE.test(form.maxQty.trim())) errors.maxQty = 'Enter a whole number.';
  const timeline = form.timelineDays.trim();
  if (timeline !== '' && !WHOLE.test(timeline)) errors.timelineDays = 'Enter a number of days, or leave it empty.';
  const limit = form.discountLimit.trim();
  const limitBps = limit === '' ? null : parsePercentToBps(limit);
  if (limit !== '' && limitBps === null) errors.discountLimit = 'Enter a percentage such as 10 or 12.5, or leave it empty.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      code,
      name: form.name.trim(),
      description: form.description.trim(),
      unitLabel: form.unitLabel.trim(),
      unitPricePaise,
      minQty: Number(form.minQty.trim()),
      maxQty: Number(form.maxQty.trim()),
      defaultTimelineDays: timeline === '' ? null : Number(timeline),
      maxDiscountBps: limitBps,
    },
  };
}

/** Only the fields that differ from the service as loaded. */
function changes(service: CatalogServiceDto, v: Parsed): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v.name !== service.name) out.name = v.name;
  if (v.description !== service.description) out.description = v.description;
  if (v.unitLabel !== service.unitLabel) out.unitLabel = v.unitLabel;
  if (v.defaultTimelineDays !== service.defaultTimelineDays) out.defaultTimelineDays = v.defaultTimelineDays;
  if (v.maxDiscountBps !== service.maxDiscountBps) out.maxDiscountBps = v.maxDiscountBps;
  if (v.unitPricePaise !== service.price?.unitPricePaise) out.unitPricePaise = v.unitPricePaise;
  if (v.minQty !== service.price?.minQty) out.minQty = v.minQty;
  if (v.maxQty !== service.price?.maxQty) out.maxQty = v.maxQty;
  return out;
}

/** A titled group of fields; the title is a visual divider (labels name every field). */
function FieldGroup(props: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <p aria-hidden="true" className="flex items-center gap-3 text-xs font-medium tracking-[0.12em] text-fg-3 uppercase after:h-px after:flex-1 after:bg-border-subtle">
        {props.title}
      </p>
      {props.children}
    </div>
  );
}

export function ServiceDialog(props: { trigger: ReactNode; service: CatalogServiceDto | null; expectedVersion: number; workspaceName: string }) {
  const creating = props.service === null;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(() => initial(props.service));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const mutate = usePricingMutation();

  const set = (key: keyof FormState) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    if (pending) return;
    setFailure(null);
    const parsed = parse(form, creating);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    const v = parsed.value;
    let url = '/api/app/pricing/services';
    let body: Record<string, unknown>;
    if (props.service === null) {
      body = { ...v, expectedVersion: props.expectedVersion };
    } else {
      body = changes(props.service, v);
      if (Object.keys(body).length === 0) {
        setFailure({ message: 'Nothing changed.', reference: null });
        return;
      }
      body.expectedVersion = props.expectedVersion;
      url = `/api/app/pricing/services/${encodeURIComponent(props.service.id)}`;
    }
    setPending(true);
    try {
      const outcome = await mutate<VersionResult>(url, body, (data) => versionMessage(creating ? `Added ${v.name}.` : `Saved ${v.name}.`, data));
      if (outcome.ok) setOpen(false);
      else setFailure({ message: outcome.message, reference: outcome.reference });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) {
          setForm(initial(props.service));
          setErrors({});
          setFailure(null);
        }
      }}
    >
      <DialogTrigger asChild>{props.trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <IconChip>{creating ? <Plus aria-hidden="true" /> : <Pencil aria-hidden="true" />}</IconChip>
            <DialogTitle>{creating ? 'Add a service' : `Edit ${props.service?.name ?? ''}`}</DialogTitle>
          </div>
          <DialogDescription>
            {creating
              ? 'The service and its price are added to a new price list version.'
              : 'A price or quantity change publishes a new price list version. Issued quotes keep their prices.'}{' '}
            Workspace: {props.workspaceName}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FieldGroup title="Service">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="code" label="Code" value={form.code} onChange={set('code')} error={errors.code} readOnly={!creating} hint={creating ? 'Short and unique, e.g. SEO-BASIC. It cannot change later.' : 'Codes cannot change.'} />
              <TextField name="name" label="Name" value={form.name} onChange={set('name')} error={errors.name} />
            </div>
            <TextField name="description" label="Description" multiline value={form.description} onChange={set('description')} hint="Shown on quotes under the service name." />
          </FieldGroup>
          <FieldGroup title="Price">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="price" label="Unit price" prefix="₹" inputMode="decimal" value={form.price} onChange={set('price')} error={errors.price} />
              <TextField name="unitLabel" label="Per" value={form.unitLabel} onChange={set('unitLabel')} error={errors.unitLabel} placeholder="page, month, visit" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="minQty" label="Minimum quantity" inputMode="numeric" value={form.minQty} onChange={set('minQty')} error={errors.minQty} />
              <TextField name="maxQty" label="Maximum quantity" inputMode="numeric" value={form.maxQty} onChange={set('maxQty')} error={errors.maxQty} hint="Up to 10,000." />
            </div>
          </FieldGroup>
          <FieldGroup title="Limits">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="timelineDays" label="Typical timeline" inputMode="numeric" suffix="days" value={form.timelineDays} onChange={set('timelineDays')} error={errors.timelineDays} hint="Optional." />
              <TextField
                name="discountLimit"
                label="Discount limit"
                inputMode="decimal"
                suffix="%"
                value={form.discountLimit}
                onChange={set('discountLimit')}
                error={errors.discountLimit}
                hint="Optional. A quote with this service cannot be discounted beyond it."
              />
            </div>
          </FieldGroup>
          {Object.keys(errors).length > 0 ? <FormAlert message="Fix the highlighted fields." /> : null}
          {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
          <DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 border-t border-border-subtle bg-bg-1 px-6 py-4">
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" aria-busy={pending || undefined}>
              {pending ? 'Saving' : creating ? 'Add service' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
