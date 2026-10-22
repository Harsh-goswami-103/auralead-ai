/**
 * The handoff block of each lead page (ADR-124, lead-gen F5). Server-safe; the controls are client
 * islands.
 *  - OperatorHandoff (operator lead page): before the handoff, "Hand over to client" (the dialog
 *    says what will happen), gated on `leads.handoff`, on a merged lead and on a lost one; after it,
 *    the handoff card with the read-only state.
 *  - ClientHandoff (client lead page): the handoff card with the note, the summary and Acknowledge;
 *    while the summary is being written the page re-reads itself. Renders nothing for a lead that
 *    was never handed over.
 */
import type { Gate } from '@/components/patterns/GatedAction';
import type { LeadHandoffViewDto } from '@/lib/schemas/handoff';
import { AcknowledgeButton, SummaryPendingRefresh } from './HandoffActions';
import { HandoffCard } from './HandoffCard';
import { HandOverDialog } from './HandOverDialog';

function handOverGate(view: LeadHandoffViewDto): Gate | null {
  if (!view.permissions.canHandOff) return { category: 'permission', reason: 'Handing a lead over needs leads.handoff, which your access does not include. A super admin can grant it.' };
  if (view.lead.merged) return { category: 'eligibility', reason: 'This lead was merged into another lead. Hand over that lead instead.' };
  if (view.lead.salesStage === 'LOST') return { category: 'eligibility', reason: 'This lead is marked Lost. Move it back to an open stage before handing it over.' };
  return null;
}

export function OperatorHandoff(props: { view: LeadHandoffViewDto; timeZone: string }) {
  const { view } = props;
  if (view.handoff) {
    return (
      <div className="flex flex-col gap-3">
        <HandoffCard handoff={view.handoff} timeZone={props.timeZone} audience="operator" />
        <SummaryPendingRefresh active={view.handoff.summaryStatus === 'PENDING'} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">When the customer is ready to buy, hand the lead to {view.workspace.name}: their team continues the chat and sends the quotation.</p>
      <HandOverDialog
        leadId={view.lead.id}
        leadName={view.lead.displayName}
        workspaceSlug={view.workspace.slug}
        workspaceName={view.workspace.name}
        salesStage={view.lead.salesStage}
        stageVersion={view.lead.stageVersion}
        summaryAvailable={view.summaryAvailable}
        gate={handOverGate(view)}
      />
    </div>
  );
}

export function ClientHandoff(props: { view: LeadHandoffViewDto; timeZone: string }) {
  const { handoff } = props.view;
  if (!handoff) return null;
  const canAcknowledge = props.view.permissions.canAcknowledge && handoff.status === 'HANDED_OVER';
  return (
    <div className="flex flex-col gap-3">
      <HandoffCard
        handoff={handoff}
        timeZone={props.timeZone}
        audience="client"
        actions={canAcknowledge ? <AcknowledgeButton handoffId={handoff.id} leadName={props.view.lead.displayName} /> : undefined}
      />
      <SummaryPendingRefresh active={handoff.summaryStatus === 'PENDING'} />
    </div>
  );
}
