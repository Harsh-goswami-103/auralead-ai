'use client';

/**
 * Edit the quotation behind an approval item (T22: "edits within pricing permissions"). Reuses the
 * T15 quote editor and saves through /api/app/approvals/[id]/revise with the item's workspace slug:
 * the server prices the new version, and a discount above the editor's own cap is refused (403,
 * shown with its reference). Without `quotes.edit` the control is gated by permission.
 */
import { useState } from 'react';
import { PencilLine } from 'lucide-react';
import { GatedAction } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { QuoteEditor, type EditorInitial } from '@/app/dashboard/user/quotations/quote-editor';
import type { QuoteEditorCatalogDto } from '@/server/services/quotes/versioning';

export function ApprovalEditor(props: {
  approvalId: string;
  workspaceSlug: string;
  quoteId: string;
  versionNo: number;
  pricingVersionId: string;
  pricingVersionNo: number | null;
  catalog: QuoteEditorCatalogDto;
  initial: EditorInitial;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <GatedAction
        label="Edit quotation (new version)"
        variant="outline"
        icon={<PencilLine aria-hidden="true" />}
        gate={props.canEdit ? null : { category: 'permission', reason: 'Your assignment in this workspace does not include editing quotations.' }}
        onAction={() => setOpen(true)}
      />
    );
  }
  return (
    <section aria-labelledby="edit-heading" className="flex flex-col gap-4 rounded-xl border border-border-strong bg-bg-1 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="edit-heading" className="text-lg font-semibold text-fg-1">
          Edit v{props.versionNo}
        </h2>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      <p className="text-sm text-fg-2">Saving creates version {props.versionNo + 1}, priced by the server. It needs approval again; discounts above your own limit are refused.</p>
      <QuoteEditor
        catalog={props.catalog}
        mode={{
          kind: 'revise',
          quoteId: props.quoteId,
          expectedVersion: props.versionNo,
          pricingVersionId: props.pricingVersionId,
          pricingVersionNo: props.pricingVersionNo,
          endpoint: `/api/app/approvals/${props.approvalId}/revise`,
          extraBody: { workspaceSlug: props.workspaceSlug },
        }}
        initial={props.initial}
        gate={null}
        submitLabel={`Save as v${props.versionNo + 1}`}
        onSaved={() => setOpen(false)}
      />
    </section>
  );
}
