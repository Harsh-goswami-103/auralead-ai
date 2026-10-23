/**
 * Request schemas for the consent routes under /api/app/consent/** (T18), shared by the routes and
 * the panels that call them (plan §2: one schema set). Shape only; domain rules (contact present,
 * attestation enabled, evidence not in the future) are the service's and answer with a code.
 *
 * Manual grants (plan §7, ADR-15) need a purpose, an evidence source and an evidence time. Only
 * sources that are evidence can be cited: MANUAL_EVIDENCE (a person saw or holds the opt-in), or a
 * form the business ran (SHEETS_FORM, META_FORM). A Google Maps listing is not evidence, and the
 * system-only sources (INBOUND_MESSAGE, START_KEYWORD) and the B2B attestation have their own
 * paths, so they are refused here. A WhatsApp MARKETING opt-in also needs the notice text the
 * person agreed to (naming the business) and how it was obtained (`evidence.method`, ADR-125).
 */
import { z } from 'zod';
import { workspaceSlugField } from './lead-console';

const id = z.string().min(1).max(64);
const note = z.string().trim().min(5).max(500);

export const MANUAL_CONSENT_SOURCES = ['MANUAL_EVIDENCE', 'SHEETS_FORM', 'META_FORM'] as const;

/**
 * How a recorded opt-in was obtained (ADR-125). Required for a WhatsApp MARKETING opt-in (the
 * service answers 422 EVIDENCE_METHOD_REQUIRED without it); optional otherwise.
 */
export const OPT_IN_METHODS = ['CALL_VERBAL', 'WRITTEN_FORM', 'WEBSITE_FORM', 'IN_PERSON', 'WHATSAPP_THREAD'] as const;
export type OptInMethod = (typeof OPT_IN_METHODS)[number];

export const OPT_IN_METHOD_LABELS: Readonly<Record<OptInMethod, string>> = {
  CALL_VERBAL: 'Said yes on a phone call',
  WRITTEN_FORM: 'Signed a written form',
  WEBSITE_FORM: 'Submitted a form on the business website',
  IN_PERSON: 'Agreed in person',
  WHATSAPP_THREAD: 'Agreed in a WhatsApp conversation',
};

export const ManualConsentBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  leadId: id,
  channel: z.enum(['WHATSAPP', 'EMAIL']),
  purpose: z.enum(['MARKETING', 'SERVICE_CONVERSATION']),
  source: z.enum(MANUAL_CONSENT_SOURCES),
  /** When the opt-in was given (the evidence time), not when it is recorded. Required: undated evidence is never recorded. */
  collectedAt: z.iso.datetime({ offset: true }),
  evidence: z.object({ note, reference: z.string().trim().min(1).max(200).optional(), method: z.enum(OPT_IN_METHODS).optional() }),
  /**
   * The verbatim notice the person agreed to. Required for a WhatsApp MARKETING opt-in, and it must
   * name the business (ADR-125; the service answers 422). Stored with its sha256.
   */
  noticeText: z.string().trim().min(1).max(2000).optional(),
});
export type ManualConsentBody = z.output<typeof ManualConsentBody>;

export const B2bAttestationBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  leadId: id,
  /** Why the employee attests a B2B basis for emailing this business (ADR-14). */
  note,
});
export type B2bAttestationBody = z.output<typeof B2bAttestationBody>;
