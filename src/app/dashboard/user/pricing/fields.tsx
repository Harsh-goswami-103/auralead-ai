'use client';

/**
 * Small form building blocks for the Pricing forms: a labelled field with hint and field-level
 * error (wired with aria-invalid / aria-describedby), and the form-level summary that shows the
 * server's user-facing message with its reference.
 *
 * Aurora look (design spec §4-§5): fields use the shared Input / Textarea surface (solid input
 * border, aura focus outline, danger border when invalid). A prefix ("₹") or suffix ("%", "days")
 * sits inside the field, so the value and its unit read as one control. The label may be rich
 * (e.g. a short visible "Quantity" with the service name kept for screen readers in sr-only text).
 */
import { useId, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/cn';

export type FieldErrors = Partial<Record<string, string>>;

export function TextField(props: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: ReactNode;
  prefix?: string;
  suffix?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
  readOnly?: boolean;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  /** Sizes the field itself (e.g. `max-w-32` for a two-digit value). */
  fieldClassName?: string;
  name: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [props.hint ? hintId : null, props.error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    name: props.name,
    value: props.value,
    readOnly: props.readOnly,
    placeholder: props.placeholder,
    'aria-invalid': props.error ? true : undefined,
    'aria-describedby': describedBy,
  } as const;
  const suffixPad = props.suffix ? (props.suffix.length > 2 ? 'pr-14' : 'pr-8') : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', props.className)}>
      <Label htmlFor={id} className="text-fg-1">
        {props.label}
      </Label>
      {props.multiline ? (
        <Textarea {...common} rows={3} onChange={(e) => props.onChange(e.target.value)} className={cn('text-fg-1', props.readOnly && 'bg-bg-1', props.fieldClassName)} />
      ) : (
        <div className={cn('relative', props.fieldClassName)}>
          {props.prefix ? (
            <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-2">
              {props.prefix}
            </span>
          ) : null}
          <Input
            {...common}
            inputMode={props.inputMode}
            onChange={(e) => props.onChange(e.target.value)}
            className={cn('tabular text-fg-1', props.prefix && 'pl-7', suffixPad, props.readOnly && 'bg-bg-1')}
          />
          {props.suffix ? (
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-fg-2">
              {props.suffix}
            </span>
          ) : null}
        </div>
      )}
      {props.hint ? (
        <p id={hintId} className="text-xs text-fg-2">
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p id={errorId} className="flex items-start gap-1 text-xs text-danger">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function FormAlert({ message, reference }: { message: string; reference?: string | null }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-fg-1">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <span>
        {message}
        {reference ? <span className="block text-xs text-fg-2">Reference: {reference}</span> : null}
      </span>
    </p>
  );
}
