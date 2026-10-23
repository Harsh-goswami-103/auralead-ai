/**
 * What a lead found through Google Places shows next to its contact facts (ADR-118 (b) and (d)):
 * the attribution wherever Places content appears (LIVE: "Google Maps", the attributions Google
 * returned and the terms line; DEMO: the Simulated note) and "Confirm details", which keeps the
 * Places-sourced fields past their 30-day expiry once the business has confirmed them. Used by the
 * operator's and the client's lead pages and by the Leads sheet. Server-safe (the button inside is
 * a client component); renders nothing for a lead that did not come from Places.
 */
import { ConfirmContactButton } from '@/components/finder/ConfirmContactButton';
import { PlacesAttribution } from '@/components/finder/PlacesAttribution';
import type { Gate } from '@/components/patterns/GatedAction';
import type { LeadProfileDto } from '@/lib/schemas/leads';

const CONFIRM_GATE: Gate = {
  category: 'permission',
  reason: 'Confirming a business’s contact details needs leads.write, which you do not hold in this workspace.',
};

export function LeadPlacesNotice(props: { leadId: string; places: LeadProfileDto['places']; simulated: boolean; timeZone: string; workspaceSlug?: string }) {
  const { places } = props;
  if (places === null) return null;
  return (
    <div data-lead-places="" className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-bg-2/40 px-3.5 py-3">
      <ConfirmContactButton
        leadId={props.leadId}
        workspaceSlug={props.workspaceSlug}
        placesContentExpiresAt={places.expiresAt}
        contactConfirmedAt={places.confirmedAt}
        contactConfirmedVia={places.confirmedVia}
        timeZone={props.timeZone}
        gate={places.canConfirm ? null : CONFIRM_GATE}
      />
      <PlacesAttribution simulated={props.simulated} attributions={places.attributions} />
    </div>
  );
}
