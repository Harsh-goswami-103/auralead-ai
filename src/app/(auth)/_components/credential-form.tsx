'use client';

/**
 * Shared client form for sign-in and invite acceptance. Posts JSON to an auth route, shows the
 * route's user-facing message and reference on failure, and follows `redirectTo` on success.
 * The routes set the session cookie; nothing about the session is handled in the browser.
 * Styled with the T08 design system (labels always visible, errors linked by aria-describedby).
 */
import { useId, useState, type FormEvent } from 'react';
import { CircleAlert } from 'lucide-react';
import { isSafeRedirect } from '@/components/patterns/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type CredentialField = {
  name: string;
  label: string;
  type: 'email' | 'password' | 'text';
  autoComplete: string;
  minLength?: number;
  hint?: string;
};

type ErrorBody = { message?: string; reference?: string };

export function CredentialForm(props: {
  action: string;
  fields: CredentialField[];
  extra?: Record<string, string>;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [error, setError] = useState<{ message: string; reference: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const baseId = useId();
  const errorId = `${baseId}-error`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const payload: Record<string, string> = { ...props.extra };
    for (const field of props.fields) payload[field.name] = String(data.get(field.name) ?? '');
    try {
      const res = await fetch(props.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => ({}))) as ErrorBody & { redirectTo?: string };
      if (res.ok && isSafeRedirect(body.redirectTo)) {
        window.location.assign(body.redirectTo);
        return;
      }
      setError({ message: body.message ?? 'The request failed. Try again.', reference: body.reference ?? null });
    } catch {
      setError({ message: 'The server could not be reached. Check your connection and try again.', reference: null });
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-describedby={error ? errorId : undefined}>
      {props.fields.map((field) => {
        const id = `${baseId}-${field.name}`;
        const hintId = field.hint ? `${id}-hint` : undefined;
        return (
          <div key={field.name} className="flex flex-col gap-1.5">
            <Label htmlFor={id} className="text-fg-1">
              {field.label}
            </Label>
            <Input
              id={id}
              name={field.name}
              type={field.type}
              autoComplete={field.autoComplete}
              minLength={field.minLength}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={[hintId, error ? errorId : undefined].filter(Boolean).join(' ') || undefined}
              className="h-10 bg-bg-2 text-md md:text-base"
            />
            {field.hint ? (
              <p id={hintId} className="text-xs text-fg-2">
                {field.hint}
              </p>
            ) : null}
          </div>
        );
      })}
      {error ? (
        <p id={errorId} role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-fg-1">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            {error.message}
            {error.reference ? <span className="block text-xs text-fg-2">Reference: {error.reference}</span> : null}
          </span>
        </p>
      ) : null}
      <Button type="submit" disabled={pending} aria-busy={pending} className="h-10 text-md md:text-base">
        {pending ? props.pendingLabel : props.submitLabel}
      </Button>
    </form>
  );
}
