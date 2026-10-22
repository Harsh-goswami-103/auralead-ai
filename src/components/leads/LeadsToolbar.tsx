'use client';

/**
 * Search, filters, sort and the table/board switch of the Leads area (T26, R31). The state lives
 * in the URL: the form is a plain GET form (it works without JavaScript), and with JavaScript a
 * submit or a changed select navigates in place. A new search or filter starts at the first page.
 * Search matches the name (any script, case and accents ignored), phone digits or email.
 * The fields are controlled and follow the URL when it changes (Clear filters, back button) without
 * remounting the form, so a keyboard user keeps focus on the select they changed (ADR-73).
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { KanbanSquare, Search, Table2, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { LeadSource, SalesStage } from '@/lib/domain/enums';
import { hasLeadFilters, LEAD_SEARCH_MAX, LEAD_SORT_LABELS, LEAD_SORTS, leadPageSearch, SCORE_BAND_LABELS, SCORE_BANDS, type LeadPageParams } from '@/lib/schemas/leads';
import { sourceStyle } from '@/components/patterns/source-style';
import { salesStageEntry } from './lead-vocabulary';

type FieldValues = { q: string; stage: string; source: string; score: string; sort: string };

function valuesOf(params: LeadPageParams): FieldValues {
  return { q: params.q ?? '', stage: params.stage ?? '', source: params.source ?? '', score: params.score ?? '', sort: params.sort };
}

export function LeadsToolbar(props: { basePath: string; params: LeadPageParams }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const ids = { q: useId(), stage: useId(), source: useId(), score: useId(), sort: useId() };
  const { params } = props;
  const isBoard = params.view === 'board';
  const urlKey = [params.q, params.stage, params.source, params.score, params.sort, params.view].join('|');
  const [values, setValues] = useState<FieldValues>(() => valuesOf(params));
  const [shownKey, setShownKey] = useState(urlKey);
  // The URL's filters changed: show them (state adjusted during render, no remount, focus kept).
  if (shownKey !== urlKey) {
    setShownKey(urlKey);
    setValues(valuesOf(params));
  }

  function navigate() {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const value = (k: string) => {
      const v = data.get(k);
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    };
    const search = leadPageSearch(
      { view: params.view },
      { q: value('q'), stage: value('stage'), source: value('source'), score: value('score'), sort: value('sort') },
    );
    router.push(`${props.basePath}${search}`, { scroll: false });
  }

  function changeSearch(event: ChangeEvent<HTMLInputElement>) {
    const q = event.target.value;
    setValues((v) => ({ ...v, q }));
  }

  /** A changed select navigates at once; its `name` is the field. */
  function changeSelect(event: ChangeEvent<HTMLSelectElement>) {
    const { name, value } = event.target;
    setValues((v) => ({ ...v, [name]: value }));
    navigate();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate();
  }

  const viewHref = (view: 'table' | 'board') => `${props.basePath}${leadPageSearch({ ...params, cursor: undefined, dir: 'next', lead: undefined }, { view })}`;
  const field = 'flex min-w-0 flex-col gap-1 text-xs text-fg-2';

  return (
    <div className="flex flex-col gap-3">
      <form
        ref={formRef}
        action={props.basePath}
        method="get"
        role="search"
        aria-label="Search and filter leads"
        onSubmit={submit}
        className="flex flex-wrap items-end gap-3"
      >
        {isBoard ? <input type="hidden" name="view" value="board" /> : null}
        <label htmlFor={ids.q} className={cn(field, 'min-w-[14rem] flex-1')}>
          Search leads
          <span className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
            <Input id={ids.q} name="q" type="search" value={values.q} onChange={changeSearch} maxLength={LEAD_SEARCH_MAX} placeholder="Name, phone or email" className="pl-8" />
          </span>
        </label>
        {isBoard ? null : (
          <label htmlFor={ids.stage} className={field}>
            Stage
            <NativeSelect id={ids.stage} name="stage" value={values.stage} onChange={changeSelect}>
              <option value="">All stages</option>
              {SalesStage.map((s) => (
                <option key={s} value={s}>
                  {salesStageEntry(s).label}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        <label htmlFor={ids.source} className={field}>
          Source
          <NativeSelect id={ids.source} name="source" value={values.source} onChange={changeSelect}>
            <option value="">All sources</option>
            {LeadSource.map((s) => (
              <option key={s} value={s}>
                {sourceStyle(s).label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label htmlFor={ids.score} className={field}>
          Score
          <NativeSelect id={ids.score} name="score" value={values.score} onChange={changeSelect}>
            <option value="">Any score</option>
            {SCORE_BANDS.map((b) => (
              <option key={b} value={b}>
                {SCORE_BAND_LABELS[b]}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label htmlFor={ids.sort} className={field}>
          Sort
          <NativeSelect id={ids.sort} name="sort" value={values.sort} onChange={changeSelect}>
            {LEAD_SORTS.map((s) => (
              <option key={s} value={s}>
                {LEAD_SORT_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </label>
        <Button type="submit" variant="secondary">
          <Search aria-hidden="true" />
          Search
        </Button>
        {hasLeadFilters(params) ? (
          <Link href={`${props.basePath}${leadPageSearch({ view: params.view })}`} scroll={false} className={buttonVariants({ variant: 'ghost' })}>
            <X aria-hidden="true" />
            Clear filters
          </Link>
        ) : null}
      </form>
      <nav aria-label="Leads view" className="flex w-fit items-center gap-1 rounded-lg border border-border-subtle bg-bg-1/80 p-1">
        <Link
          href={viewHref('table')}
          scroll={false}
          aria-current={isBoard ? undefined : 'page'}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), !isBoard && 'bg-bg-3 text-fg-1')}
        >
          <Table2 aria-hidden="true" />
          Table
        </Link>
        <Link
          href={viewHref('board')}
          scroll={false}
          aria-current={isBoard ? 'page' : undefined}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), isBoard && 'bg-bg-3 text-fg-1')}
        >
          <KanbanSquare aria-hidden="true" />
          Board
        </Link>
      </nav>
    </div>
  );
}
