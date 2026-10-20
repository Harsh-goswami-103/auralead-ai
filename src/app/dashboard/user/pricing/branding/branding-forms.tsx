'use client';

/**
 * Branding forms (T27): the logo (upload, replace, remove), the brand colour with a live preview
 * of how quotations paint it, and the sender details printed on quotations (GSTIN and terms).
 * Every change goes through /api/app/branding/* (ADR-26) and the page re-reads the database
 * afterwards; the server validates everything again. Without `pricing.override` the same details
 * are shown read-only and each save is gated by permission (plan §12).
 *
 *  - Logo: the browser checks the type and the 1 MB limit first for a quick answer, then sends
 *    the file as base64; the server sniffs the bytes, refuses SVG and mismatches, and stores a
 *    re-encoded WebP without metadata (P7).
 *  - Colour: the preview uses the public quote's own palette (`brandPalette`), so the text colour
 *    and its contrast shown here are exactly what quotations paint (F14: darkened in OKLCH until
 *    it reads at 4.5:1 or more).
 */
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CircleCheck, ImageUp, Palette, ScrollText, Trash2, TriangleAlert } from 'lucide-react';
import { brandPalette } from '@/components/quote/brand-palette';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { IconChip } from '@/components/patterns/IconChip';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { contrastRatio, isBrandHex } from '@/lib/branding/contrast';
import { LOGO_ACCEPT, LOGO_CONTENT_TYPES, LOGO_MAX_BYTES, TERMS_MAX_CHARS } from '@/lib/schemas/branding';
import { GSTIN_PATTERN } from '@/lib/schemas/pricing';
import type { BrandingDto } from '@/server/services/pricing/branding';
import { FormAlert, TextField, type FieldErrors } from '../fields';
import { usePricingMutation } from '../use-pricing-mutation';

export const BRANDING_GATE: Gate = { category: 'permission', reason: 'Only the workspace owner can change branding.' };

type Failure = { message: string; reference: string | null } | null;

function Panel(props: { title: string; description: string; icon: ReactNode; hue?: 'aura' | 'volt' | 'zest' | 'ice'; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5', props.className)}>
      <div className="flex min-w-0 items-start gap-3">
        <IconChip hue={props.hue}>{props.icon}</IconChip>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-display text-lg font-semibold text-fg-1">{props.title}</h2>
          <p className="max-w-prose text-sm text-fg-2">{props.description}</p>
        </div>
      </div>
      {props.children}
    </section>
  );
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

// ---- Logo ------------------------------------------------------------------------------------------

export function LogoPanel(props: { branding: BrandingDto; gate: Gate | null }) {
  const { branding, gate } = props;
  const mutate = usePricingMutation();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);
  const label = branding.logo ? 'Replace logo' : 'Upload logo';

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFailure(null);
    if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setFailure({ message: 'Use a PNG, JPEG or WebP image. SVG and other formats are not accepted.', reference: null });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setFailure({ message: 'The logo is larger than 1 MB. Export a smaller file.', reference: null });
      return;
    }
    setPending(true);
    try {
      const dataBase64 = await readAsBase64(file);
      const outcome = await mutate('/api/app/branding/logo', { contentType: file.type, fileName: file.name, dataBase64 }, () => 'Logo saved. It was converted to WebP without photo details.');
      if (!outcome.ok) setFailure({ message: outcome.message, reference: outcome.reference });
    } catch {
      setFailure({ message: 'The file could not be read. Choose it again.', reference: null });
    } finally {
      setPending(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <Panel title="Logo" icon={<ImageUp aria-hidden="true" />} description="PNG, JPEG or WebP, up to 1 MB. It is converted to WebP, fitted inside 512 px and stripped of photo details such as EXIF and location.">
      <div className="flex min-h-28 items-center justify-center rounded-lg border border-border-subtle bg-paper p-4">
        {branding.logo ? (
          // The logo is served by our own route with a fixed type; next/image adds nothing for it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={branding.logo.url} alt={`Logo of ${branding.workspace.name}`} className="max-h-24 max-w-full object-contain" />
        ) : (
          <span className="text-sm text-ink-2">No logo yet</span>
        )}
      </div>
      <p className="text-xs text-fg-2">Quotation pages and PDFs show your business name, brand colour and GSTIN; they do not print the logo.</p>
      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
      <input ref={input} type="file" accept={LOGO_ACCEPT} hidden onChange={(e) => void onFile(e.target.files?.[0])} />
      <div className="flex flex-wrap items-center gap-2">
        {gate ? (
          <GatedAction label={label} icon={<ImageUp aria-hidden="true" />} gate={gate} />
        ) : (
          <Button type="button" disabled={pending} aria-busy={pending || undefined} onClick={() => input.current?.click()}>
            <ImageUp aria-hidden="true" />
            {pending ? 'Uploading' : label}
          </Button>
        )}
        {branding.logo && !gate ? (
          <ConfirmDialog
            trigger={
              <Button type="button" variant="ghost" className="text-fg-2 hover:bg-danger/10 hover:text-danger">
                <Trash2 aria-hidden="true" />
                Remove logo
              </Button>
            }
            title="Remove the logo?"
            description="The stored logo file is deleted. You can upload a new one at any time."
            confirmLabel="Remove logo"
            pendingLabel="Removing"
            destructive
            workspaceName={branding.workspace.name}
            onConfirm={async () => {
              const outcome = await mutate('/api/app/branding/logo/remove', {}, () => 'Logo removed.');
              return outcome.ok ? { ok: true } : { ok: false, message: outcome.message, reference: outcome.reference };
            }}
          />
        ) : null}
      </div>
    </Panel>
  );
}

// ---- Brand colour ----------------------------------------------------------------------------------

function Swatch(props: { colour: string; label: string }) {
  return <span aria-hidden="true" title={props.label} className="inline-block size-5 shrink-0 rounded-md ring-1 ring-border-strong" style={{ backgroundColor: props.colour }} />;
}

export function ColourForm(props: { branding: BrandingDto; gate: Gate | null }) {
  const { branding, gate } = props;
  const mutate = usePricingMutation();
  const [colour, setColour] = useState(branding.brandColor);
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure>(null);
  const valid = isBrandHex(colour.trim());
  const shown = valid ? colour.trim().toUpperCase() : isBrandHex(branding.brandColor) ? branding.brandColor.toUpperCase() : '#0B7285';
  const palette = brandPalette(shown);
  const ratio = Math.floor(contrastRatio(palette.text, '#FFFFFF') * 100) / 100;
  const adjusted = palette.text !== palette.brand;
  const preview = { '--brand': palette.text, '--band': palette.band, '--band-ink': palette.ink } as CSSProperties;

  async function save() {
    if (gate) return;
    if (!valid) {
      setError('Enter # and six hex digits, for example #0F766E.');
      return;
    }
    setError(undefined);
    setFailure(null);
    const outcome = await mutate('/api/app/branding', { brandColor: colour.trim() }, () => `Brand colour saved: ${colour.trim().toUpperCase()}. New quotation versions use it.`);
    if (!outcome.ok) setFailure({ message: outcome.message, reference: outcome.reference });
  }

  return (
    <Panel title="Brand colour" icon={<Palette aria-hidden="true" />} hue="volt" description="Used for the header band and headings of your quotations. Where it is used for text it is darkened, keeping its hue, until it is easy to read.">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-sm text-fg-1">
            Pick a colour
            <input
              type="color"
              value={shown.toLowerCase()}
              disabled={gate !== null}
              onChange={(e) => setColour(e.target.value.toUpperCase())}
              className="h-9 w-14 cursor-pointer rounded-md border border-border-input bg-bg-1 p-1 disabled:cursor-default"
            />
          </label>
          <TextField name="brandColor" label="Hex value" value={colour} onChange={setColour} error={error} readOnly={gate !== null} fieldClassName="max-w-36" />
        </div>
        <dl className="grid gap-2 rounded-lg border border-border-subtle bg-bg-0/40 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <dt className="text-fg-2">Your colour</dt>
            <dd className="flex items-center gap-2 font-mono text-fg-1">
              <Swatch colour={palette.brand} label="Brand colour" />
              {palette.brand}
            </dd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <dt className="text-fg-2">Text on quotations</dt>
            <dd className="flex flex-wrap items-center gap-2 text-fg-1">
              <Swatch colour={palette.text} label="Text colour" />
              <span className="font-mono">{palette.text}</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-success/35 bg-success/12 px-2 py-0.5 text-xs font-medium text-success">
                <CircleCheck aria-hidden="true" className="size-3.5" />
                {ratio.toFixed(2)}:1 on white
              </span>
              {adjusted ? <span className="text-xs text-fg-2">darkened from your colour for readability</span> : null}
            </dd>
          </div>
        </dl>
        <div aria-hidden="true" style={preview} className="overflow-hidden rounded-lg border border-border-subtle bg-paper">
          <div className="flex items-center justify-between gap-3 px-4 py-3 [background-color:var(--band)] [color:var(--band-ink)]">
            <span className="truncate font-display font-semibold">{branding.workspace.name}</span>
            <span className="text-xs opacity-90">Quotation</span>
          </div>
          <div className="flex flex-col gap-1 px-4 py-3">
            <span className="font-display font-semibold text-brand">Scope of work</span>
            <span className="text-sm text-ink-2">Headings and links use the text colour above.</span>
          </div>
        </div>
        {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
        <GatedAction label="Save brand colour" pendingLabel="Saving" gate={gate} onAction={save} className="w-fit" />
      </form>
    </Panel>
  );
}

// ---- Sender details --------------------------------------------------------------------------------

export function SenderForm(props: { branding: BrandingDto; gate: Gate | null }) {
  const { branding, gate } = props;
  const mutate = usePricingMutation();
  const [gstin, setGstin] = useState(branding.gstin ?? '');
  const [terms, setTerms] = useState(branding.termsText);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<Failure>(null);
  const over = terms.length > TERMS_MAX_CHARS;

  async function save() {
    if (gate) return;
    const next: FieldErrors = {};
    const g = gstin.trim().toUpperCase();
    if (g !== '' && !GSTIN_PATTERN.test(g)) next.gstin = 'A GSTIN has 15 characters, for example 07AAACR5055K1Z5.';
    if (over) next.terms = `Keep the terms to ${TERMS_MAX_CHARS.toLocaleString('en-IN')} characters.`;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFailure(null);
    const outcome = await mutate('/api/app/branding', { gstin: g === '' ? null : g, termsText: terms }, () => 'GSTIN and terms saved. New quotation versions print them.');
    if (!outcome.ok) setFailure({ message: outcome.message, reference: outcome.reference });
  }

  return (
    <Panel title="Sender details" icon={<ScrollText aria-hidden="true" />} hue="zest" description="Printed on every new quotation version. Issued versions keep the details they were issued with.">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField name="gstin" label="GSTIN" value={gstin} onChange={setGstin} error={errors.gstin} readOnly={gate !== null} hint="Optional. Checked for format only; quotations are not tax invoices." className="sm:max-w-sm" />
        <TextField
          name="termsText"
          label="Terms"
          multiline
          value={terms}
          onChange={setTerms}
          error={errors.terms}
          readOnly={gate !== null}
          fieldClassName="min-h-40"
          hint={
            <span className={cn('inline-flex items-center gap-1', over && 'text-danger')}>
              {over ? <TriangleAlert aria-hidden="true" className="size-3.5" /> : null}
              One term per line. {terms.length.toLocaleString('en-IN')} of {TERMS_MAX_CHARS.toLocaleString('en-IN')} characters.
            </span>
          }
        />
        {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
        <GatedAction label="Save GSTIN and terms" pendingLabel="Saving" gate={gate} onAction={save} className="w-fit" />
      </form>
    </Panel>
  );
}

export function BrandingWorkspace(props: { branding: BrandingDto }) {
  const gate = props.branding.canEdit ? null : BRANDING_GATE;
  return (
    <div className="flex flex-col gap-4">
      {gate ? <p className="text-sm text-fg-2">You can view branding. {BRANDING_GATE.reason}</p> : null}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <LogoPanel branding={props.branding} gate={gate} />
          <SenderForm key={props.branding.updatedAt} branding={props.branding} gate={gate} />
        </div>
        <ColourForm key={props.branding.brandColor} branding={props.branding} gate={gate} />
      </div>
    </div>
  );
}
