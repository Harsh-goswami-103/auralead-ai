/**
 * Plain words for the reach-out panel (ADR-125, lead-gen F5): what the lead's WhatsApp consent
 * allows, as icon + label + one line of guidance. Pure data, server- and client-safe.
 */
import { CircleCheck, CircleDashed, CircleHelp, CircleSlash, MessagesSquare, type LucideIcon } from 'lucide-react';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import type { ConsentState } from '@/lib/schemas/leads';

export const WHATSAPP_REACH: Readonly<Record<ConsentState, { label: string; tone: StatusTone; icon: LucideIcon; help: string }>> = {
  OPT_IN: { label: 'Opt-in on record', tone: 'success', icon: CircleCheck, help: 'Approved templates can be sent to this lead. Every send is still checked at dispatch.' },
  CUSTOMER_MESSAGED: {
    label: 'Customer messaged first',
    tone: 'info',
    icon: MessagesSquare,
    help: 'Replies are allowed inside the 24-hour window after their last message. Templates need a recorded opt-in.',
  },
  B2B_ATTESTED: { label: 'B2B basis attested', tone: 'info', icon: CircleCheck, help: 'An attested B2B basis covers email only, never WhatsApp.' },
  NONE: {
    label: 'No WhatsApp opt-in',
    tone: 'neutral',
    icon: CircleDashed,
    help: 'Record an opt-in the customer gave you, or share your click-to-chat link so they can write first.',
  },
  OPTED_OUT: { label: 'Opted out', tone: 'danger', icon: CircleSlash, help: 'This customer said STOP. Only a newer opt-in they give you can change that.' },
  NO_CONTACT: { label: 'No phone number', tone: 'neutral', icon: CircleHelp, help: 'There is no phone number on record for this lead.' },
};
