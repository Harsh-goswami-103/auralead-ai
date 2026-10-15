/**
 * The quote state machine (plan §6.1, R20). Pure: one table of allowed (from, to, trigger)
 * transitions; everything else is an InvalidTransitionError (409). Services decide the guards
 * (CAS on the version number, validity, pricing review) and side effects; this module only says
 * whether a move is allowed and where a trigger leads.
 *
 *   (new)               -> DRAFT      create
 *   DRAFT               -> DRAFT      EDIT    (version N+1)
 *   DRAFT               -> APPROVED   APPROVE
 *   APPROVED            -> DRAFT      EDIT    (material edit: version N+1, approval invalidated)
 *   APPROVED            -> SENT       SEND    (dispatch settle or manual link)
 *   SENT                -> VIEWED     VIEW    (beacon)
 *   SENT, VIEWED        -> ACCEPTED   ACCEPT
 *   SENT, VIEWED        -> DRAFT      REVISE
 *   APPROVED/SENT/VIEWED-> EXPIRED    EXPIRE  (now >= validUntil)
 *   EXPIRED             -> DRAFT      REVISE  (reissue)
 *   DRAFT/APPROVED/SENT/VIEWED -> CANCELLED CANCEL
 */
import type { QuoteStatus } from '@/lib/domain/enums';
import { InvalidTransitionError } from '@/lib/errors';

export type QuoteTrigger = 'EDIT' | 'APPROVE' | 'SEND' | 'VIEW' | 'ACCEPT' | 'REVISE' | 'EXPIRE' | 'CANCEL';

export type QuoteTransition = { from: QuoteStatus; to: QuoteStatus; trigger: QuoteTrigger };

export const QUOTE_TRANSITIONS: readonly QuoteTransition[] = [
  { from: 'DRAFT', to: 'DRAFT', trigger: 'EDIT' },
  { from: 'DRAFT', to: 'APPROVED', trigger: 'APPROVE' },
  { from: 'DRAFT', to: 'CANCELLED', trigger: 'CANCEL' },
  { from: 'APPROVED', to: 'DRAFT', trigger: 'EDIT' },
  { from: 'APPROVED', to: 'SENT', trigger: 'SEND' },
  { from: 'APPROVED', to: 'EXPIRED', trigger: 'EXPIRE' },
  { from: 'APPROVED', to: 'CANCELLED', trigger: 'CANCEL' },
  { from: 'SENT', to: 'VIEWED', trigger: 'VIEW' },
  { from: 'SENT', to: 'ACCEPTED', trigger: 'ACCEPT' },
  { from: 'SENT', to: 'DRAFT', trigger: 'REVISE' },
  { from: 'SENT', to: 'EXPIRED', trigger: 'EXPIRE' },
  { from: 'SENT', to: 'CANCELLED', trigger: 'CANCEL' },
  { from: 'VIEWED', to: 'ACCEPTED', trigger: 'ACCEPT' },
  { from: 'VIEWED', to: 'DRAFT', trigger: 'REVISE' },
  { from: 'VIEWED', to: 'EXPIRED', trigger: 'EXPIRE' },
  { from: 'VIEWED', to: 'CANCELLED', trigger: 'CANCEL' },
  { from: 'EXPIRED', to: 'DRAFT', trigger: 'REVISE' },
];

export function transitionTrigger(from: QuoteStatus, to: QuoteStatus): QuoteTrigger | null {
  return QUOTE_TRANSITIONS.find((t) => t.from === from && t.to === to)?.trigger ?? null;
}

export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return transitionTrigger(from, to) !== null;
}

function invalid(from: QuoteStatus, to: QuoteStatus | null, trigger: QuoteTrigger | null): InvalidTransitionError {
  return new InvalidTransitionError({
    message: `quote transition ${from} -> ${to ?? trigger} is not allowed`,
    userMessage: `This quote is ${from.toLowerCase()}, so that action is not allowed. Reload to see its current state.`,
    safeDetails: { from, to, trigger },
  });
}

export function assertTransition(from: QuoteStatus, to: QuoteStatus): QuoteTrigger {
  const trigger = transitionTrigger(from, to);
  if (trigger === null) throw invalid(from, to, null);
  return trigger;
}

/** Where `trigger` takes a quote in `from`; 409 when the trigger does not apply. */
export function nextQuoteStatus(from: QuoteStatus, trigger: QuoteTrigger): QuoteStatus {
  const t = QUOTE_TRANSITIONS.find((x) => x.from === from && x.trigger === trigger);
  if (!t) throw invalid(from, null, trigger);
  return t.to;
}

/** A new version from DRAFT or APPROVED is an edit; from SENT, VIEWED or EXPIRED it is a revision. */
export function revisionTrigger(from: QuoteStatus): QuoteTrigger {
  return from === 'DRAFT' || from === 'APPROVED' ? 'EDIT' : 'REVISE';
}

export function isTerminalQuoteStatus(status: QuoteStatus): boolean {
  return status === 'ACCEPTED' || status === 'CANCELLED';
}

/** Statuses that lapse at validUntil (plan §6.1 EXPIRE row). */
export const EXPIRING_STATUSES: readonly QuoteStatus[] = ['APPROVED', 'SENT', 'VIEWED'];
