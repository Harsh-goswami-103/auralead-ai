'use client';

/**
 * The operator console's lead table with bulk selection (T26): the Leads table with a checkbox
 * column (TanStack row selection keyed by lead id, so a selection survives paging and filters) and
 * the bulk send panel above it. "Select skipped rows" in a bulk result selects those leads again
 * for a follow-up action.
 */
import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { RowSelectionState } from '@tanstack/react-table';
import type { Gate } from '@/components/patterns/GatedAction';
import { BULK_MAX_SELECTION } from '@/lib/schemas/bulk';
import { BulkSendPanel, type BulkTemplateOption } from './BulkSendPanel';
import { LeadsTable, type LeadsTableProps } from './LeadsTable';

export function BulkLeadsTable(props: LeadsTableProps & { workspaceSlug: string; workspaceName: string; templates: BulkTemplateOption[]; sendGate: Gate | null }) {
  const { templates, sendGate, workspaceName, ...table } = props;
  const [selection, setSelection] = useState<RowSelectionState>({});
  const selectedIds = Object.keys(selection).filter((id) => selection[id]);

  return (
    <div className="flex flex-col gap-3">
      <BulkSendPanel
        workspaceSlug={props.workspaceSlug}
        workspaceName={workspaceName}
        selectedIds={selectedIds}
        templates={templates}
        sendGate={sendGate}
        onClear={() => setSelection({})}
        onSelectRows={(ids) => setSelection(Object.fromEntries(ids.map((id) => [id, true])))}
      />
      {selectedIds.length > BULK_MAX_SELECTION ? (
        <p role="status" className="flex items-center gap-1.5 text-sm text-fg-1">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />A bulk send takes at most {BULK_MAX_SELECTION} leads. Clear some of the selection first.
        </p>
      ) : null}
      <LeadsTable {...table} selection={{ state: selection, onChange: setSelection }} />
    </div>
  );
}
