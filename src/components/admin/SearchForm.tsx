/**
 * SearchForm (T29): admin list filters as a plain GET form, like FilterForm but with text and date
 * fields too (works without JS; the query keys are the route's filter names). Every field has a
 * visible label tied by id; select values stay the raw enums with readable option text. "Clear"
 * appears when any filter is set. Submitting drops the page cursor, so a new search starts at the
 * newest rows. Server-safe.
 */
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';

export type SearchField =
  | { kind: 'text' | 'date'; name: string; label: string; value: string; placeholder?: string; mono?: boolean }
  | { kind: 'select'; name: string; label: string; value: string; options: ReadonlyArray<{ value: string; label: string }> };

export function SearchForm(props: { fields: SearchField[]; clearHref: string | null; submitLabel?: string; className?: string; idPrefix: string }) {
  return (
    <form method="get" className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4', props.className)}>
      {props.fields.map((field) => {
        const id = `${props.idPrefix}-${field.name}`;
        return (
          <div key={field.name} className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={id} className="text-xs font-medium text-fg-2">
              {field.label}
            </label>
            {field.kind === 'select' ? (
              <NativeSelect key={`${field.name}=${field.value}`} id={id} name={field.name} defaultValue={field.value}>
                <option value="">All</option>
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            ) : (
              <Input
                key={`${field.name}=${field.value}`}
                id={id}
                name={field.name}
                type={field.kind === 'date' ? 'date' : 'text'}
                defaultValue={field.value}
                placeholder={field.kind === 'text' ? field.placeholder : undefined}
                className={field.kind === 'text' && field.mono ? 'font-mono text-[13px]' : undefined}
                autoComplete="off"
              />
            )}
          </div>
        );
      })}
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit" variant="secondary">
          <Search aria-hidden="true" />
          {props.submitLabel ?? 'Search'}
        </Button>
        {props.clearHref ? (
          <Button asChild variant="ghost" className="text-fg-2">
            <Link href={props.clearHref}>
              <X aria-hidden="true" />
              Clear
            </Link>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
