/**
 * Request schemas for the consent routes under /api/app/consent/** (T18), shared by the routes and
 * the panels that call them (plan §2: one schema set). Shape only; domain rules (contact present,
 * attestation enabled, evidence not in the future) are the service's and answer with a code.
 *
 * Manual grants (plan §7, ADR-15) need a purpose, an evidence source and an evidence time. Only
 * sources that are evidence can be cited: MANUAL_EVIDENCE (a person saw or holds the opt-in), or a
 * form the business ran (SHEETS_FORM, META_FORM). A Google Maps listing is not evidence, and the
 * system-only sources (INBOUND_MESSAGE, START_KEYWORD) and the B2B attestation have their own
 * paths, so they are refused here.
 */
import { z } from 'zod';
import { workspaceSlugField } from './lead-console';

const id = z.string().min(1).max(64);
export const CONSENT_NOTE_MIN = 5;
export const CONSENT_NOTE_MAX = 500;
const note = z.string().trim().min(CONSENT_NOTE_MIN).max(CONSENT_NOTE_MAX);

export const MANUAL_CONSENT_SOURCES = ['MANUAL_EVIDENCE', 'SHEETS_FORM', 'META_FORM'] as const;

export const ManualConsentBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  leadId: id,
  channel: z.enum(['WHATSAPP', 'EMAIL']),
  purpose: z.enum(['MARKETING', 'SERVICE_CONVERSATION']),
  source: z.enum(MANUAL_CONSENT_SOURCES),
  /** When the opt-in was given (the evidence time), not when it is recorded. Required: undated evidence is never recorded. */
  collectedAt: z.iso.datetime({ offset: true }),
  evidence: z.object({ note, reference: z.string().trim().min(1).max(200).optional() }),
  /** The verbatim notice the person agreed to, when known; only its sha256 is stored. */
  noticeText: z.string().trim().min(1).max(2000).optional(),
});
export type ManualConsentBody = z.output<typeof ManualConsentBody>;

/** The answer of POST /api/app/consent/grants: whether the opt-in lifted an active opt-out (O2, E3). */
export type ManualConsentAnswer = { consentId: string; reoptIn: 'CLEARED' | 'NOT_SUPPRESSED' | 'EVIDENCE_NOT_NEWER' | 'NOT_OPT_IN' };

export const B2bAttestationBody = z.object({
  workspaceSlug: workspaceSlugField.optional(),
  leadId: id,
  /** Why the employee attests a B2B basis for emailing this business (ADR-14). */
  note,
});
export type B2bAttestationBody = z.output<typeof B2bAttestationBody>;
