/**
 * The Leads area of a panel page (T26, R31), shared by the client panel's Leads page and the
 * operator console: search and filters, the table (keyset pages of 50 with a capped count) or the
 * Kanban board, and the CSV export. The page reads the data through the services and passes it in;
 * this component only builds the links (all state is in the URL). Server-safe.
 */
import type { ReactNode } from 'react';
import { FileDown, Rows3, SearchX } from 'lucide-react';
import { ChipTitle } from '@/components/patterns/IconChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { SectionCard } from '@/components/patterns/SectionCard';
import type { Gate } from '@/components/patterns/GatedAction';
import { hasLeadFilters, LEAD_SORT_LABELS, LEAD_SORTS, leadPageSearch, type BoardColumnDto, type CappedCountDto, type LeadExportDto, type LeadPageParams, type LeadRowDto, type LeadSort } from '@/lib/schemas/leads';
import { BulkLeadsTable } from './BulkLeadsTable';
import type { BulkTemplateOption } from './BulkSendPanel';
import { LeadBoard } from './LeadBoard';
import { LeadExportPanel } from './LeadExportPanel';
import { LeadsTable } from './LeadsTable';
import { LeadsToolbar } from './LeadsToolbar';
import { cappedCountText } from './types';

export type LeadsWorkspaceProps = {
  basePath: string;
  params: LeadPageParams;
  timeZone: string;
  /** Operator console: the workspace the routes act in (the client panel uses the session's). */
  workspaceSlug?: string;
  moveGate: Gate | null;
  exportGate: Gate | null;
  list: { rows: LeadRowDto[]; total: CappedCountDto; nextCursor: string | null; prevCursor: string | null } | null;
  board: { columns: BoardColumnDto[]; total: CappedCountDto } | null;
  exports: LeadExportDto[];
  /** The page link's cursor no longer worked and the first page is shown instead. */
  cursorReset: boolean;
  /** Shown instead of the list when the workspace has no lead at all. */
  emptyWorkspace: ReactNode | null;
  /** Operator console: row selection and bulk send over the selection (needs workspaceSlug). */
  bulk?: { workspaceName: string; templates: BulkTemplateOption[]; sendGate: Gate | null };
};

export function LeadsWorkspace(props: LeadsWorkspaceProps) {
  const { params, basePath } = props;
  const listState = { ...params, lead: undefined };
  const firstPage = { ...listState, cursor: undefined, dir: 'next' as const };
  const href = (search: string) => `${basePath}${search}`;
  const filtered = hasLeadFilters(params);

  let body: ReactNode;
  if (props.emptyWorkspace) {
    body = props.emptyWorkspace;
  } else if (props.board) {
    body = <LeadBoard columns={props.board.columns} moveGate={props.moveGate} workspaceSlug={props.workspaceSlug} tableHref={href(leadPageSearch(firstPage, { view: 'table' }))} />;
  } else if (props.list && props.list.rows.length === 0) {
    body = (
      <EmptyState
        headingLevel="h3"
        icon={<SearchX aria-hidden="true" className="size-5" />}
        title={filtered ? 'No lead matches' : 'No leads on this page'}
        description={filtered ? 'Try another search or clear the filters.' : 'This page is empty now. Go back to the first page.'}
      />
    );
  } else if (props.list) {
    const list = props.list;
    const sortHrefs = Object.fromEntries(LEAD_SORTS.map((s) => [s, href(leadPageSearch(firstPage, { sort: s }))])) as Record<LeadSort, string>;
    const tableProps = {
      rows: list.rows,
      total: list.total,
      sort: params.sort,
      timeZone: props.timeZone,
      sortHrefs,
      prevHref: list.prevCursor ? href(leadPageSearch(listState, { cursor: list.prevCursor, dir: 'prev' })) : null,
      nextHref: list.nextCursor ? href(leadPageSearch(listState, { cursor: list.nextCursor, dir: 'next' })) : null,
      firstHref: params.cursor ? href(leadPageSearch(firstPage)) : null,
      canMove: props.moveGate === null,
      workspaceSlug: props.workspaceSlug,
      caption: `Leads, ${LEAD_SORT_LABELS[params.sort].toLowerCase()}`,
    };
    body =
      props.bulk && props.workspaceSlug ? (
        <BulkLeadsTable {...tableProps} workspaceSlug={props.workspaceSlug} workspaceName={props.bulk.workspaceName} templates={props.bulk.templates} sendGate={props.bulk.sendGate} />
      ) : (
        <LeadsTable {...tableProps} />
      );
  } else body = null;

  const total = props.board?.total ?? props.list?.total ?? null;

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        title={<ChipTitle icon={<Rows3 aria-hidden="true" />}>{props.board ? 'Pipeline board' : 'All leads'}</ChipTitle>}
        meta={total && !props.emptyWorkspace ? `${cappedCountText(total)} ${total.count === 1 && !total.capped ? 'lead matches' : 'leads match'}${filtered ? ' the search and filters' : ''}.` : undefined}
      >
        {props.emptyWorkspace ? null : <LeadsToolbar basePath={basePath} params={params} />}
        {props.cursorReset ? (
          <p role="status" className="text-sm text-fg-2">
            That page link had expired, so the first page is shown.
          </p>
        ) : null}
        {body}
      </SectionCard>
      {props.emptyWorkspace ? null : (
        <SectionCard title={<ChipTitle icon={<FileDown aria-hidden="true" />} hue="ice">Export</ChipTitle>}>
          <LeadExportPanel exports={props.exports} filters={{ q: params.q, stage: params.view === 'board' ? undefined : params.stage, source: params.source, score: params.score, sort: params.sort }} gate={props.exportGate} workspaceSlug={props.workspaceSlug} timeZone={props.timeZone} filtered={filtered} />
        </SectionCard>
      )}
    </div>
  );
}
