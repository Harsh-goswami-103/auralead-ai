/**
 * Reach-out panel schemas and pure helpers (ADR-125, lead-gen slice F5): the workspace's WhatsApp
 * opt-in notice and privacy contact, and the click-to-chat link. Framework-free, so the routes, the
 * services and the panel share one spelling of every rule.
 *
 * - A WhatsApp opt-in notice must name the business (the workspace name, compared with case, width
 *   and spacing folded), because Meta requires an opt-in that names the business and the person
 *   must be able to prove what they agreed to (DPDP s.5, s.6).
 * - The click-to-chat link is `https://wa.me/<digits of the display number>?text=<prefill>`. The
 *   lead starts the conversation, which opens the service window without a marketing opt-in. The
 *   START/STOP keyword refusal of the prefill is the server's (services/leads/reach-out.ts), which
 *   folds it exactly as inbound messages are folded.
 */
import { z } from 'zod';
import { workspaceSlugField } from './lead-console';

export const OPT_IN_NOTICE_MAX = 2000;
export const PRIVACY_CONTACT_MAX = 200;
export const CLICK_TO_CHAT_PREFILL_MAX = 500;

const optionalText = (max: number) => z.string().trim().max(max).nullable();

export const ReachOutSettingsBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  /** Empty or null clears it (the default notice is then offered). */
  whatsappOptInNotice: optionalText(OPT_IN_NOTICE_MAX),
  privacyContact: optionalText(PRIVACY_CONTACT_MAX),
});
export type ReachOutSettingsBody = z.output<typeof ReachOutSettingsBody>;

export const ClickToChatBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  prefill: z.string().trim().min(1).max(CLICK_TO_CHAT_PREFILL_MAX),
});
export type ClickToChatBody = z.output<typeof ClickToChatBody>;

/** NFKC, lower case, every run of whitespace one space, trimmed. */
export function foldForNameMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when the notice names the business (case, width and spacing ignored). */
export function noticeNamesBusiness(notice: string, businessName: string): boolean {
  const name = foldForNameMatch(businessName);
  return name.length > 0 && foldForNameMatch(notice).includes(name);
}

/** The notice offered when the workspace has not written its own: names the business, the channel, STOP and the contact. */
export function defaultOptInNotice(businessName: string, privacyContact: string | null): string {
  const contact = privacyContact?.trim() ? ` For questions about your data, contact ${privacyContact.trim()}.` : '';
  return `I agree to receive WhatsApp messages from ${businessName} about its services and offers. I can reply STOP at any time to stop them.${contact}`;
}

/** The text a customer's WhatsApp opens with when they follow the link. */
export function defaultClickToChatPrefill(businessName: string): string {
  return `Hi ${businessName}, I would like to know more about your services.`;
}

/** `https://wa.me/<digits>?text=<prefill>` for an E.164 display number. */
export function waMeLink(displayPhoneE164: string, prefill: string): string {
  const digits = displayPhoneE164.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(prefill)}`;
}

/** What the reach-out panel shows (server -> page). */
export type ReachOutDto = {
  workspace: { slug: string; name: string };
  /** The notice prefilled in "Record WhatsApp opt-in": the workspace's own, else the default. */
  noticePrefill: string;
  noticeIsDefault: boolean;
  settings: { whatsappOptInNotice: string | null; privacyContact: string | null };
  clickToChat:
    | { available: true; displayPhoneNumber: string; prefill: string; link: string; simulated: boolean }
    | { available: false; reason: 'NOT_CONFIGURED' | 'NO_DISPLAY_NUMBER' };
  permissions: { canRecordOptIn: boolean; canManageSettings: boolean };
};

export type ClickToChatResultDto = { link: string; prefill: string; displayPhoneNumber: string };
