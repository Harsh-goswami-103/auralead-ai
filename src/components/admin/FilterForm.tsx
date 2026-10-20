/**
 * FilterForm: the admin list filters as a plain GET form (works without JS; the query params and
 * option values stay the raw enums, the option text is readable). Styled native selects with
 * visible labels tied by id, a Filter submit at the select height, and "Clear filters" when any
 * filter is set. Two columns on phones (submit row spans both), one wrapping row from sm.
 * Submitting drops `before`, so a new filter starts at the newest page. Server-safe.
 */
import Link from 'next/link';
import { ListFilter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { NativeSelect } from '@/components/ui/native-select';

export type FilterField = {
  /** Used as the select's id and name (the query param). */
  name: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
};

export function FilterForm(props: { fields: FilterField[]; clearHref: string | null; className?: string }) {
  return (
    <form method="get" className={cn('grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end', props.className)}>
      {props.fields.map((field) => (
        <div key={field.name} className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={field.name} className="text-xs font-medium text-fg-2">
            {field.label}
          </label>
          <NativeSelect id={field.name} name={field.name} defaultValue={field.value} wrapperClassName="w-full sm:w-56">
            <option value="">All</option>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
        <Button type="submit" variant="secondary" className="flex-1 sm:flex-none">
          <ListFilter aria-hidden="true" />
          Filter
        </Button>
        {props.clearHref ? (
          <Button asChild variant="ghost" className="flex-1 text-fg-2 sm:flex-none">
            <Link href={props.clearHref}>
              <X aria-hidden="true" />
              Clear filters
            </Link>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
