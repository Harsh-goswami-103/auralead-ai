'use client';

/**
 * Small form building blocks for the Pricing forms: a labelled field with hint and field-level
 * error (wired with aria-invalid / aria-describedby), and the form-level summary that shows the
 * server's user-facing message with its reference.
 */
import { useId, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/components/ui/cn';

export type FieldErrors = Partial<Record<string, string>>;

export function TextField(props: {
  label: string;
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
  return (
    <div className={cn('flex flex-col gap-1.5', props.className)}>
      <Label htmlFor={id} className="text-fg-1">
        {props.label}
      </Label>
      {props.multiline ? (
        <textarea
          {...common}
          rows={3}
          onChange={(e) => props.onChange(e.target.value)}
          className="min-h-20 w-full rounded-md border border-input bg-input/30 px-3 py-2 text-sm text-fg-1 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
        />
      ) : (
        <div className="flex items-center gap-2">
          {props.prefix ? (
            <span aria-hidden="true" className="text-fg-2">
              {props.prefix}
            </span>
          ) : null}
          <Input {...common} inputMode={props.inputMode} onChange={(e) => props.onChange(e.target.value)} className="tabular text-fg-1" />
          {props.suffix ? <span className="shrink-0 text-sm text-fg-2">{props.suffix}</span> : null}
        </div>
      )}
      {props.hint ? (
        <p id={hintId} className="text-xs text-fg-2">
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p id={errorId} className="text-xs text-danger">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function FormAlert({ message, reference }: { message: string; reference?: string | null }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <span>
        {message}
        {reference ? <span className="block text-xs text-fg-2">Reference: {reference}</span> : null}
      </span>
    </p>
  );
}
