/**
 * ConsentChips (plan §3 patterns, R4, R21, D4; built by T26): what the records say about messaging
 * this lead, per channel, as icon + label chips with the evidence time and source. An opt-out
 * always shows over any consent. The chips inform; they never decide: every send is checked again
 * by the eligibility function at dispatch, and the sales stage has nothing to do with consent.
 * Server-safe.
 */
import { BadgeCheck, CircleCheck, CircleDashed, CircleHelp, CircleSlash, Mail, MessageCircle, MessagesSquare, type LucideIcon } from 'lucide-react';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import { formatDateTime } from '@/lib/format/date';
import type { ConsentChannelDto as ConsentDto, ConsentState } from '@/lib/schemas/leads';
import { ToneChip } from './ToneChip';

const STATES: Readonly<Record<ConsentState, { label: string; tone: StatusTone; icon: LucideIcon }>> = {
  OPTED_OUT: { label: 'Opted out', tone: 'danger', icon: CircleSlash },
  OPT_IN: { label: 'Opt-in on record', tone: 'success', icon: CircleCheck },
  B2B_ATTESTED: { label: 'B2B basis attested (manual sends only)', tone: 'info', icon: BadgeCheck },
  CUSTOMER_MESSAGED: { label: 'Customer messaged first', tone: 'info', icon: MessagesSquare },
  NONE: { label: 'No opt-in', tone: 'neutral', icon: CircleDashed },
  NO_CONTACT: { label: 'No contact', tone: 'neutral', icon: CircleHelp },
};

const CHANNELS: Readonly<Record<ConsentDto['channel'], { label: string; icon: LucideIcon; noContact: string }>> = {
  WHATSAPP: { label: 'WhatsApp', icon: MessageCircle, noContact: 'No phone number on record' },
  EMAIL: { label: 'Email', icon: Mail, noContact: 'No email address on record' },
};

/** Consent sources and suppression reasons in plain words. */
export const CONSENT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  SHEETS_FORM: 'Google Sheets form answer',
  META_FORM: 'Meta Lead Ads form answer',
  INBOUND_MESSAGE: 'The customer’s own message',
  START_KEYWORD: 'START keyword',
  MANUAL_EVIDENCE: 'Evidence recorded by a person',
  EMPLOYEE_ATTESTATION: 'Attested by an operator',
  STOP_BUTTON: 'Stop button',
  STOP_KEYWORD: 'STOP keyword',
  UNSUBSCRIBE: 'Unsubscribe link',
  HARD_BOUNCE: 'Email bounced permanently',
  COMPLAINT: 'Spam complaint',
  MARKETING_STOPPED: 'Marketing messages stopped',
  MANUAL: 'Recorded by a person',
};

export function consentStateLabel(dto: Pick<ConsentDto, 'channel' | 'state'>): string {
  return dto.state === 'NO_CONTACT' ? CHANNELS[dto.channel].noContact : STATES[dto.state].label;
}

export function ConsentChips(props: { consent: readonly ConsentDto[]; timeZone: string }) {
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Consent by channel" className="flex flex-col gap-2.5">
        {props.consent.map((c) => {
          const channel = CHANNELS[c.channel];
          const state = STATES[c.state];
          const ChannelIcon = channel.icon;
          const detail = [c.since ? `${c.state === 'OPTED_OUT' ? 'Since' : 'Evidence from'} ${formatDateTime(new Date(c.since), props.timeZone)}` : null, c.source ? (CONSENT_SOURCE_LABELS[c.source] ?? null) : null]
            .filter(Boolean)
            .join(' · ');
          return (
            <li key={c.channel} data-consent-channel={c.channel} data-consent-state={c.state} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex w-24 items-center gap-1.5 text-sm text-fg-1">
                <ChannelIcon aria-hidden="true" className="size-4 text-fg-3" />
                {channel.label}
              </span>
              <ToneChip tone={state.tone} icon={state.icon} label={consentStateLabel(c)} />
              {detail ? <span className="text-xs text-fg-2">{detail}</span> : null}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-fg-2">Consent is separate from the sales stage. Every send is checked again at dispatch.</p>
    </div>
  );
}
