'use client';

/**
 * OneTimeLink: an invite or password reset link shown exactly once (T29). The server keeps only
 * the token's hash, so this is the only time anyone can see the link: the panel says so, names
 * who it is for and when it expires, and offers a copy button. The administrator sends it
 * themselves (the platform has no email transport of its own, ADR-67). "Done" drops the link from
 * the page; nothing stores it.
 */
import { useId } from 'react';
import { Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDateTime } from '@/lib/format/date';
import { CopyButton } from './CopyButton';

export type OneTimeLinkValue = { kind: 'invite' | 'reset'; link: string; expiresAt: string; email: string };

export function OneTimeLink(props: { value: OneTimeLinkValue; label: string; onDone: () => void }) {
  const id = useId();
  const { value } = props;
  const purpose = value.kind === 'invite' ? 'It lets them choose a name and password and signs them in.' : 'It lets them choose a new password; every session of theirs ends.';
  return (
    <section aria-labelledby={`${id}-title`} data-one-time-link={value.kind} className="flex w-full flex-col gap-3 rounded-xl border border-info/40 bg-info/8 p-4">
      <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold text-fg-1">
        <Link2 aria-hidden="true" className="size-4 shrink-0 text-info" />
        Copy this link now: it is shown only once
      </h3>
      <p className="text-sm text-fg-2">
        Send it to <span className="font-medium text-fg-1">{value.email}</span> yourself. {purpose} It works once and expires{' '}
        <span className="tabular">{formatDateTime(new Date(value.expiresAt))}</span> (IST).
      </p>
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-link`} className="sr-only">
          {props.label}
        </label>
        <Input id={`${id}-link`} readOnly value={value.link} className="font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} />
        <CopyButton value={value.link} label={props.label.toLowerCase()} showText />
      </div>
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={props.onDone}>
        Done, I have sent it
      </Button>
    </section>
  );
}
