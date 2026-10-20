'use client';

/**
 * CapabilityPicker (T29): the capabilities an employee's assignment grants, as a labelled group of
 * native checkboxes (keyboard and screen reader friendly), each with what it allows. "All" and
 * "None" set the whole group. The order is the plan's (§5.2) so the list reads the same everywhere.
 */
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { CAPABILITIES, type Capability } from '@/lib/domain/enums';
import { CAPABILITY_LABELS } from './people-vocabulary';

export function CapabilityPicker(props: { value: readonly Capability[]; onChange: (next: Capability[]) => void; legend?: string }) {
  const id = useId();
  const chosen = new Set(props.value);
  const toggle = (cap: Capability) => {
    const next = new Set(chosen);
    if (next.has(cap)) next.delete(cap);
    else next.add(cap);
    props.onChange(CAPABILITIES.filter((c) => next.has(c)));
  };
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 flex w-full items-center justify-between gap-2 text-sm font-medium text-fg-1">
        <span>
          {props.legend ?? 'Capabilities'} <span className="tabular font-normal text-fg-2">({chosen.size} of {CAPABILITIES.length})</span>
        </span>
        <span className="flex gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={() => props.onChange([...CAPABILITIES])}>
            All
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => props.onChange([])}>
            None
          </Button>
        </span>
      </legend>
      <ul className="grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-border-subtle bg-bg-1/50 p-2 sm:grid-cols-2">
        {CAPABILITIES.map((cap) => {
          const inputId = `${id}-${cap}`;
          return (
            <li key={cap} className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-bg-2/60">
              <input id={inputId} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-aura" checked={chosen.has(cap)} onChange={() => toggle(cap)} aria-describedby={`${inputId}-hint`} />
              <label htmlFor={inputId} className="flex min-w-0 flex-col text-sm text-fg-1">
                {CAPABILITY_LABELS[cap].label}
                <span id={`${inputId}-hint`} className="text-xs text-fg-2">
                  {CAPABILITY_LABELS[cap].hint}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
