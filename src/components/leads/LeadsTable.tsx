'use client';

/**
 * The Leads table (T26, R31) on TanStack Table v8 (`useReactTable`, ADR-01 / ADR-71). The server
 * does the work: search, filters, sort and keyset paging arrive in the props (manual sorting,
 * filtering and pagination), so the table only lays out the page it was given and moves through
 * the URL. Sortable headers are buttons that change `sort` (aria-sort says the current order);
 * paging is "Previous page" / "Next page" links over keyset cursors with the capped total.
 *
 * Columns: lead (the first link of a row: the detail sheet in the client panel, the lead page in
 * the operator console), stage (icon + label), score ("NN / 100" beside the fit meter), source,
 * contact, city, added, and the "Move to stage" menu when the viewer may move leads.
 *
 * Look (design spec §6): one neutral table, rows tinted on hover only, scrolling inside its card
 * below the table's minimum width (no page-level horizontal scroll).
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Mail, Phone } from 'lucide-react';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '@/lib/format/date';
import type { LeadSort } from '@/lib/schemas/leads';
import { ScoreMeter } from './ScoreMeter';
import { StageChip } from './StageChip';
import { StageMoveMenu } from './StageMoveMenu';
import { cappedCountText, type CappedCountDto, type LeadRowDto } from './types';

/** Header sort choices: the column id and the URL sort each direction maps to. */
const SORTABLE: Readonly<Record<string, { asc?: LeadSort; desc?: LeadSort }>> = {
  name: { asc: 'name' },
  score: { desc: 'score' },
  createdAt: { desc: 'newest', asc: 'oldest' },
};

function sortingOf(sort: LeadSort): SortingState {
  switch (sort) {
    case 'name':
      return [{ id: 'name', desc: false }];
    case 'score':
      return [{ id: 'score', desc: true }];
    case 'oldest':
      return [{ id: 'createdAt', desc: false }];
    default:
      return [{ id: 'createdAt', desc: true }];
  }
}

/** The sort a header click asks for: its other direction when already sorted by it, else its first. */
function nextSort(columnId: string, current: SortingState): LeadSort | null {
  const options = SORTABLE[columnId];
  if (!options) return null;
  const active = current[0]?.id === columnId ? current[0] : null;
  if (active && options.asc && options.desc) return active.desc ? options.asc : options.desc;
  return options.desc ?? options.asc ?? null;
}

export type LeadsTableProps = {
  rows: LeadRowDto[];
  total: CappedCountDto;
  sort: LeadSort;
  timeZone: string;
  /** href for a page of this list with another sort (cursor dropped). */
  sortHrefs: Record<LeadSort, string>;
  prevHref: string | null;
  nextHref: string | null;
  firstHref: string | null;
  canMove: boolean;
  workspaceSlug?: string;
  caption: string;
};

export function LeadsTable(props: LeadsTableProps) {
  const router = useRouter();
  const sorting = sortingOf(props.sort);

  const columns: ColumnDef<LeadRowDto>[] = [
    {
      id: 'name',
      header: 'Lead',
      cell: ({ row }) => (
        <span className="flex flex-wrap items-center gap-2">
          <Link href={row.original.href} scroll={false} className="inline-flex items-center font-medium break-words text-cyan underline-offset-4 hover:underline max-lg:min-h-11">
            {row.original.displayName}
          </Link>
          {row.original.simulated ? <ModeChip simulated /> : null}
        </span>
      ),
    },
    { id: 'stage', header: 'Stage', cell: ({ row }) => <StageChip stage={row.original.salesStage} /> },
    {
      id: 'score',
      header: 'Score',
      cell: ({ row }) =>
        row.original.score === null ? (
          <span className="text-fg-2">Not scored</span>
        ) : (
          <span className="flex items-center gap-2.5">
            <span className="tabular w-[4.25rem] text-fg-1">{`${row.original.score} / 100`}</span>
            <ScoreMeter value={row.original.score} animate={false} />
          </span>
        ),
    },
    { id: 'source', header: 'Source', cell: ({ row }) => <SourceChip source={row.original.firstSource} /> },
    {
      id: 'contact',
      header: 'Contact',
      cell: ({ row }) => {
        const { phoneE164, emailNormalized } = row.original;
        if (!phoneE164 && !emailNormalized) return <span className="text-fg-2">None on record</span>;
        return (
          <span className="flex flex-col gap-0.5 text-fg-1">
            {phoneE164 ? (
              <span className="tabular inline-flex items-center gap-1.5 whitespace-nowrap">
                <Phone aria-hidden="true" className="size-3.5 text-fg-3" />
                {phoneE164}
              </span>
            ) : null}
            {emailNormalized ? (
              <span className="inline-flex items-center gap-1.5 break-all">
                <Mail aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
                {emailNormalized}
              </span>
            ) : null}
          </span>
        );
      },
    },
    { id: 'city', header: 'City', cell: ({ row }) => <span className="text-fg-2">{row.original.city ?? 'Unknown'}</span> },
    {
      id: 'createdAt',
      header: 'Added',
      cell: ({ row }) => <span className="tabular whitespace-nowrap text-fg-2">{formatDateTime(new Date(row.original.createdAt), props.timeZone)}</span>,
    },
  ];
  if (props.canMove) {
    columns.push({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => <StageMoveMenu lead={row.original} workspaceSlug={props.workspaceSlug} />,
    });
  }

  // TanStack Table v8 returns functions the React Compiler cannot memoize, so it skips this component;
  // that is fine here: the table re-renders only when the server sends a new page (ADR-71).
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: props.rows,
    columns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableSortingRemoval: false,
    state: { sorting },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
        <table className="w-full min-w-[58rem] text-left text-sm">
          <caption className="sr-only">{props.caption}</caption>
          <thead className="border-y border-border-subtle bg-bg-2/40 text-xs text-fg-2">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const id = header.column.id;
                  const active = sorting[0]?.id === id ? sorting[0] : null;
                  const target = nextSort(id, sorting);
                  const label = flexRender(header.column.columnDef.header, header.getContext());
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={active ? (active.desc ? 'descending' : 'ascending') : undefined}
                      className="px-3 py-2 font-medium first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5"
                    >
                      {target ? (
                        <button
                          type="button"
                          onClick={() => router.push(props.sortHrefs[target], { scroll: false })}
                          className="group inline-flex items-center gap-1 rounded-sm font-medium text-fg-2 hover:text-fg-1"
                        >
                          {label}
                          {active ? (
                            active.desc ? (
                              <ArrowDown aria-hidden="true" className="size-3.5 text-cyan" />
                            ) : (
                              <ArrowUp aria-hidden="true" className="size-3.5 text-cyan" />
                            )
                          ) : (
                            <ArrowUpDown aria-hidden="true" className="size-3.5 opacity-60" />
                          )}
                          <span className="sr-only">{active ? ', sorted' : ', sort'}</span>
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} data-lead-row={row.id} className="align-top transition-colors duration-fast hover:bg-bg-2/60">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2.5 first:min-w-[12rem] first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav aria-label="Lead pages" className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-fg-2" data-lead-count="">
          <span className="tabular text-fg-1">{props.rows.length.toLocaleString('en-IN')}</span> on this page ·{' '}
          <span className="tabular text-fg-1">{cappedCountText(props.total)}</span> {props.total.count === 1 && !props.total.capped ? 'lead matches' : 'leads match'}
        </p>
        <span className="flex flex-wrap items-center gap-2">
          {props.firstHref ? (
            <Link href={props.firstHref} scroll={false} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              First page
            </Link>
          ) : null}
          {props.prevHref ? (
            <Link href={props.prevHref} scroll={false} rel="prev" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <ChevronLeft aria-hidden="true" />
              Previous page
            </Link>
          ) : null}
          {props.nextHref ? (
            <Link href={props.nextHref} scroll={false} rel="next" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              Next page
              <ChevronRight aria-hidden="true" />
            </Link>
          ) : null}
        </span>
      </nav>
    </div>
  );
}
