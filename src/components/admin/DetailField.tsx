/**
 * DetailField: one name-value pair of an inspector card (a <div> with <dt>/<dd> for a parent
 * <dl>). Identifiers and keys are mono and may break anywhere; dates and words stay in the UI
 * font with tabular figures and wrap only at spaces, so a time never splits mid-token. A copy
 * button can follow an identifier. An empty value reads "-". Server-safe.
 */
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { CopyButton } from './CopyButton';

export function DetailField(props: {
  label: string;
  value: ReactNode;
  /** Identifiers, keys, hashes: mono and breakable anywhere. */
  mono?: boolean;
  /** Adds a copy button for this exact string. */
  copy?: string | null;
  className?: string;
}) {
  const empty = props.value === null || props.value === undefined || props.value === '';
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', props.className)}>
      <dt className="text-xs font-medium text-fg-2">{props.label}</dt>
      <dd className={cn('flex min-w-0 items-start gap-1 text-sm text-fg-1', props.mono ? 'font-mono text-[13px] break-all' : 'tabular')}>
        <span className="min-w-0">{empty ? <span className="text-fg-3">-</span> : props.value}</span>
        {props.copy && !empty ? <CopyButton value={props.copy} label={props.label.toLowerCase()} className="-my-0.5 shrink-0" /> : null}
      </dd>
    </div>
  );
}
