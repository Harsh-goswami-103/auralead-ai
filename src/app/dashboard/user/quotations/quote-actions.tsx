'use client';

/**
 * Quote actions on the detail page (T15): Approve (CAS on the version on screen), Revise (opens
 * the editor; saving creates the next version and invalidates the approval and links), Cancel
 * (confirmation naming the workspace). Each control is shown only where the state machine allows
 * the move; when the move is allowed but blocked, GatedAction says why (permission, or eligibility:
 * pricing review, validity passed). The server re-checks everything and its answer is shown.
 */
import { useState } from 'react';
import { CircleCheck, PencilLine, XCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import type { QuoteStatus } from '@/lib/domain/enums';
import type { QuoteEditorCatalogDto } from '@/server/services/quotes/versioning';
import { canTransition } from '@/server/services/quotes/state-machine';
import { FormAlert } from '../pricing/fields';
import { QuoteEditor, type EditorInitial } from './quote-editor';
import { useQuoteMutation } from './use-quote-mutation';

export type QuoteActionsProps = {
  quoteId: string;
  number: string;
  workspaceName: string;
  status: QuoteStatus;
  effectiveStatus: QuoteStatus;
  versionNo: number;
  pricingVersionId: string;
  pricingVersionNo: number | null;
  needsPricingReview: boolean;
  /** DRAFT whose validity date has passed: approval is refused until a revision sets a new one. */
  validityPassed: boolean;
  permissions: { canEdit: boolean; canApprove: boolean };
  catalog: QuoteEditorCatalogDto;
  editorInitial: EditorInitial;
};

const OWNER_ONLY: Gate = { category: 'permission', reason: 'Only the workspace owner can approve quotations.' };
const NO_EDIT: Gate = { category: 'permission', reason: 'Your role cannot edit quotations in this workspace.' };

export function QuoteActions(props: QuoteActionsProps) {
  const mutate = useQuoteMutation();
  const [revising, setRevising] = useState(false);
  const [failure, setFailure] = useState<{ message: string; reference: string | null } | null>(null);
  // The stored status decides which moves exist; a lapsed validity blocks approval (eligibility).
  const { status, effectiveStatus } = props;
  const canApproveState = canTransition(status, 'APPROVED');
  const canRevise = canTransition(effectiveStatus, 'DRAFT');
  const canCancel = canTransition(status, 'CANCELLED') && effectiveStatus !== 'EXPIRED';

  let approveGate: Gate | null = null;
  if (!props.permissions.canApprove) approveGate = OWNER_ONLY;
  else if (props.needsPricingReview) approveGate = { category: 'eligibility', reason: 'A service has no price or the total is above the limit. Revise the quote before approving.' };
  else if (props.validityPassed) approveGate = { category: 'eligibility', reason: 'This version is past its validity date. Revise it to set a new one.' };

  async function approve() {
    setFailure(null);
    const outcome = await mutate<{ quote: { number: string } }>(`/api/app/quotes/${props.quoteId}/approve`, { expectedVersion: props.versionNo }, (d) => ({
      message: `Quotation ${d.quote.number} v${props.versionNo} approved.`,
    }));
    if (!outcome.ok) setFailure({ message: outcome.message, reference: outcome.reference });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        {canApproveState ? <GatedAction label={`Approve v${props.versionNo}`} pendingLabel="Approving..." icon={<CircleCheck aria-hidden="true" />} gate={approveGate} onAction={approve} /> : null}
        {canRevise && !revising ? (
          <GatedAction
            label={status === 'DRAFT' ? 'Edit (new version)' : 'Revise'}
            variant="outline"
            icon={<PencilLine aria-hidden="true" />}
            gate={props.permissions.canEdit ? null : NO_EDIT}
            onAction={() => setRevising(true)}
          />
        ) : null}
        {canCancel ? (
          props.permissions.canEdit ? (
            <ConfirmDialog
              trigger={
                <Button variant="outline">
                  <XCircle aria-hidden="true" />
                  Cancel quotation
                </Button>
              }
              title={`Cancel quotation ${props.number}?`}
              description="Its share links stop working, its approval is withdrawn and queued sends are cancelled. This cannot be undone."
              confirmLabel="Cancel quotation"
              pendingLabel="Cancelling..."
              cancelLabel="Keep it"
              workspaceName={props.workspaceName}
              destructive
              onConfirm={async () => {
                const outcome = await mutate<{ quote: { number: string } }>(`/api/app/quotes/${props.quoteId}/cancel`, { expectedVersion: props.versionNo }, (d) => ({
                  message: `Quotation ${d.quote.number} cancelled.`,
                }));
                return outcome.ok ? { ok: true } : { ok: false, message: outcome.message, reference: outcome.reference };
              }}
            />
          ) : (
            <GatedAction label="Cancel quotation" variant="outline" gate={NO_EDIT} onAction={() => setRevising(false)} />
          )
        ) : null}
      </div>
      {failure ? <FormAlert message={failure.message} reference={failure.reference} /> : null}
      {revising ? (
        <section aria-labelledby="revise-heading" className="flex flex-col gap-4 rounded-lg border border-border-strong bg-bg-1 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 id="revise-heading" className="text-lg font-semibold text-fg-1">
              {status === 'DRAFT' ? `Edit v${props.versionNo}` : `Revise v${props.versionNo}`}
            </h2>
            <Button variant="ghost" onClick={() => setRevising(false)}>
              Close
            </Button>
          </div>
          <p className="text-sm text-fg-2">Saving creates version {props.versionNo + 1}. The current approval and any share links stop applying; issued versions stay as they are.</p>
          <QuoteEditor
            catalog={props.catalog}
            mode={{ kind: 'revise', quoteId: props.quoteId, expectedVersion: props.versionNo, pricingVersionId: props.pricingVersionId, pricingVersionNo: props.pricingVersionNo }}
            initial={props.editorInitial}
            gate={null}
            submitLabel={`Save as v${props.versionNo + 1}`}
            onSaved={() => setRevising(false)}
          />
        </section>
      ) : null}
    </div>
  );
}
