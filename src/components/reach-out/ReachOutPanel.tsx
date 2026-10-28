/**
 * Reach-out panel (ADR-125, lead-gen F5) on the operator's lead page: how to start a lawful
 * WhatsApp conversation with this lead.
 *  - The lead's WhatsApp consent state, as icon + label + what it allows (the eligibility check at
 *    dispatch still decides every send).
 *  - "Record WhatsApp opt-in" for an opt-in the customer gave (notice naming the business, how,
 *    when, a note), gated on `leads.write` and on a phone number.
 *  - The business's click-to-chat link for its own channels (email signature, website, visiting
 *    card): the customer writes first, which opens the 24-hour service window; it is not a
 *    marketing opt-in. Without a WhatsApp display number it is a configuration gate.
 *  - The workspace's opt-in notice and privacy contact, for `automation.manage` (an owner holds it).
 * After the handoff (ADR-124) the operator side is read-only: the panel says so and offers nothing.
 * Server-safe; the controls are client islands (./ReachOutForms).
 */
import { Info, MessageCircle, Settings2 } from 'lucide-react';
import { ToneChip } from '@/components/leads/ToneChip';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import type { ConsentChannelDto } from '@/lib/schemas/leads';
import type { ReachOutDto } from '@/lib/schemas/reach-out';
import { ClickToChatLink, ReachOutSettingsForm, RecordOptInForm } from './ReachOutForms';
import { WHATSAPP_REACH } from './reach-out-vocabulary';

export function ReachOutPanel(props: { reachOut: ReachOutDto; whatsapp: ConsentChannelDto; leadId: string; handedOver: boolean; integrationsHref?: string }) {
  const { reachOut, whatsapp } = props;
  const reach = WHATSAPP_REACH[whatsapp.state];
  const optInGate: Gate | null = !reachOut.permissions.canRecordOptIn
    ? { category: 'permission', reason: 'Recording an opt-in needs leads.write, which your access does not include.' }
    : whatsapp.state === 'NO_CONTACT'
      ? { category: 'eligibility', reason: 'This lead has no phone number, so there is no WhatsApp contact to record an opt-in for.' }
      : null;
  const missingNumber: Gate | null = reachOut.clickToChat.available
    ? null
    : {
        category: 'configuration',
        reason:
          reachOut.clickToChat.reason === 'NOT_CONFIGURED'
            ? 'WhatsApp is not connected for this workspace, so there is no business number to link to.'
            : 'Add the display phone number to the WhatsApp integration to get a click-to-chat link.',
        ...(props.integrationsHref ? { fix: { href: props.integrationsHref, label: 'Open integrations' } } : {}),
      };

  return (
    <div className="flex flex-col gap-5" data-reach-out-state={whatsapp.state}>
      <div className="flex flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2 text-sm text-fg-1">
          <MessageCircle aria-hidden="true" className="size-4 text-fg-3" />
          WhatsApp
          <ToneChip tone={reach.tone} icon={reach.icon} label={reach.label} />
        </span>
        <p className="text-sm text-fg-2">{reach.help}</p>
      </div>

      {props.handedOver ? (
        <p className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-2/40 px-3 py-2.5 text-sm text-fg-1">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
          This lead was handed over to the client, so reaching out is theirs now.
        </p>
      ) : (
        <>
          <section aria-label="Record an opt-in" className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-fg-2">Opt-in the customer gave you</h3>
            {whatsapp.state === 'OPT_IN' ? (
              <p className="text-sm text-fg-2">An opt-in is already on record. Record another only for new evidence.</p>
            ) : null}
            <RecordOptInForm leadId={props.leadId} workspaceSlug={reachOut.workspace.slug} businessName={reachOut.workspace.name} noticePrefill={reachOut.noticePrefill} gate={optInGate} />
          </section>

          <section aria-label="Click-to-chat link" className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-fg-2">Let the customer write first</h3>
            <p className="text-sm text-fg-2">
              Put this link on your own channels: your email signature, website or visiting card. The customer starts the chat, which opens a 24-hour window for replies; it is not an
              opt-in for marketing templates.
            </p>
            {reachOut.clickToChat.available ? (
              <ClickToChatLink
                workspaceSlug={reachOut.workspace.slug}
                link={reachOut.clickToChat.link}
                prefill={reachOut.clickToChat.prefill}
                displayPhoneNumber={reachOut.clickToChat.displayPhoneNumber}
                simulated={reachOut.clickToChat.simulated}
              />
            ) : (
              <GatedAction label="Get click-to-chat link" gate={missingNumber!} />
            )}
          </section>
        </>
      )}

      {reachOut.permissions.canManageSettings ? (
        <details className="group rounded-lg border border-border-subtle bg-bg-2/30 px-3.5 py-2.5">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-fg-1">
            <Settings2 aria-hidden="true" className="size-4 text-fg-3" />
            Workspace opt-in notice and privacy contact
          </summary>
          <div className="pt-3">
            <ReachOutSettingsForm workspaceSlug={reachOut.workspace.slug} businessName={reachOut.workspace.name} notice={reachOut.settings.whatsappOptInNotice} privacyContact={reachOut.settings.privacyContact} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
