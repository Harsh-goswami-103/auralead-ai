/**
 * R20 / plan §6.1 (T15): the quote state machine, checked exhaustively over all 7 x 7 status
 * pairs. Allowed pairs are exactly the table in plan §6.1; every other pair throws
 * InvalidTransitionError (409). Triggers map each status to its next status.
 */
import { describe, expect, it } from 'vitest';
import { QuoteStatus as QUOTE_STATUS, type QuoteStatus } from '@/lib/domain/enums';
import { InvalidTransitionError } from '@/lib/errors';
import {
  assertTransition,
  canTransition,
  isTerminalQuoteStatus,
  nextQuoteStatus,
  QUOTE_TRANSITIONS,
  revisionTrigger,
  transitionTrigger,
  type QuoteTrigger,
} from '@/server/services/quotes/state-machine';

/** Plan §6.1, row by row: from -> { to: trigger }. */
const EXPECTED: Record<QuoteStatus, Partial<Record<QuoteStatus, QuoteTrigger>>> = {
  DRAFT: { DRAFT: 'EDIT', APPROVED: 'APPROVE', CANCELLED: 'CANCEL' },
  APPROVED: { DRAFT: 'EDIT', SENT: 'SEND', EXPIRED: 'EXPIRE', CANCELLED: 'CANCEL' },
  SENT: { VIEWED: 'VIEW', ACCEPTED: 'ACCEPT', DRAFT: 'REVISE', EXPIRED: 'EXPIRE', CANCELLED: 'CANCEL' },
  VIEWED: { ACCEPTED: 'ACCEPT', DRAFT: 'REVISE', EXPIRED: 'EXPIRE', CANCELLED: 'CANCEL' },
  ACCEPTED: {},
  EXPIRED: { DRAFT: 'REVISE' },
  CANCELLED: {},
};

const pairs = QUOTE_STATUS.flatMap((from) => QUOTE_STATUS.map((to) => [from, to] as const));

describe('quote state machine (7 x 7)', () => {
  it('covers all seven statuses', () => {
    expect([...QUOTE_STATUS].sort()).toEqual(['ACCEPTED', 'APPROVED', 'CANCELLED', 'DRAFT', 'EXPIRED', 'SENT', 'VIEWED']);
    expect(pairs).toHaveLength(49);
  });

  it.each(pairs)('%s -> %s matches plan §6.1', (from, to) => {
    const trigger = EXPECTED[from][to] ?? null;
    expect(canTransition(from, to)).toBe(trigger !== null);
    expect(transitionTrigger(from, to)).toBe(trigger);
    if (trigger === null) {
      expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      try {
        assertTransition(from, to);
      } catch (error) {
        expect((error as InvalidTransitionError).status).toBe(409);
        expect((error as InvalidTransitionError).safeDetails).toMatchObject({ from, to });
      }
    } else {
      expect(() => assertTransition(from, to)).not.toThrow();
      expect(nextQuoteStatus(from, trigger)).toBe(to);
    }
  });

  it('the transition table lists exactly the allowed pairs, once each', () => {
    const listed = QUOTE_TRANSITIONS.map((t) => `${t.from}>${t.to}:${t.trigger}`).sort();
    const expected = Object.entries(EXPECTED)
      .flatMap(([from, tos]) => Object.entries(tos).map(([to, trigger]) => `${from}>${to}:${trigger}`))
      .sort();
    expect(listed).toEqual(expected);
  });

  it('rejects the transitions plan §6.1 names as invalid', () => {
    const invalid: Array<[QuoteStatus, QuoteStatus]> = [
      ['ACCEPTED', 'DRAFT'],
      ['ACCEPTED', 'CANCELLED'],
      ['CANCELLED', 'DRAFT'],
      ['DRAFT', 'SENT'],
      ['DRAFT', 'VIEWED'],
      ['DRAFT', 'ACCEPTED'],
      ['APPROVED', 'VIEWED'],
      ['VIEWED', 'SENT'],
      ['EXPIRED', 'ACCEPTED'],
    ];
    for (const [from, to] of invalid) expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
  });

  it('a trigger that does not apply to the current status throws 409', () => {
    expect(() => nextQuoteStatus('DRAFT', 'SEND')).toThrow(InvalidTransitionError);
    expect(() => nextQuoteStatus('ACCEPTED', 'REVISE')).toThrow(InvalidTransitionError);
    expect(() => nextQuoteStatus('CANCELLED', 'CANCEL')).toThrow(InvalidTransitionError);
    expect(() => nextQuoteStatus('EXPIRED', 'CANCEL')).toThrow(InvalidTransitionError);
  });

  it('a revision is an EDIT from DRAFT or APPROVED and a REVISE from SENT, VIEWED or EXPIRED', () => {
    expect(revisionTrigger('DRAFT')).toBe('EDIT');
    expect(revisionTrigger('APPROVED')).toBe('EDIT');
    expect(revisionTrigger('SENT')).toBe('REVISE');
    expect(revisionTrigger('VIEWED')).toBe('REVISE');
    expect(revisionTrigger('EXPIRED')).toBe('REVISE');
    for (const s of ['DRAFT', 'APPROVED', 'SENT', 'VIEWED', 'EXPIRED'] as const) expect(nextQuoteStatus(s, revisionTrigger(s))).toBe('DRAFT');
    expect(() => nextQuoteStatus('ACCEPTED', revisionTrigger('ACCEPTED'))).toThrow(InvalidTransitionError);
  });

  it('ACCEPTED and CANCELLED are terminal', () => {
    expect(QUOTE_STATUS.filter(isTerminalQuoteStatus)).toEqual(['ACCEPTED', 'CANCELLED']);
  });
});
