/**
 * Quote request schemas (T15), shared by the /api/app/quotes route handlers and the Quotations
 * page forms (plan §2: one Zod schema set). Shape only: a line is a catalog service id and a
 * quantity (never a price, C12), the discount is a kind plus an integer string (basis points or
 * paise, ADR-07). Domain limits (discount caps, quantity bounds, validity days, text lengths) are
 * the quote service's, answered as 422 with a code.
 */
import { z } from 'zod';

export const QUOTE_TEXT_LIMITS = { scope: 4000, timeline: 300 } as const;
export const QUOTE_MAX_LINES = 50;
export const QUOTE_VALIDITY_DAYS = { min: 1, max: 365 } as const;
export const DISCOUNT_KINDS = ['NONE', 'PERCENT_BPS', 'FLAT_PAISE'] as const;

const id = z.string().min(1).max(64);

export const QuoteLineBody = z.strictObject({ serviceId: id, qty: z.number().int() });

export const DiscountBody = z.strictObject({
  kind: z.enum(DISCOUNT_KINDS),
  /** Basis points for PERCENT_BPS, paise for FLAT_PAISE, "0" for NONE. */
  value: z.string().regex(/^-?\d{1,15}$/, 'Enter a whole number.'),
});
export type DiscountBody = z.output<typeof DiscountBody>;

const content = {
  items: z.array(QuoteLineBody).min(1, 'Add at least one service.').max(QUOTE_MAX_LINES),
  discount: DiscountBody,
  scopeText: z.string().max(QUOTE_TEXT_LIMITS.scope),
  timelineText: z.string().max(QUOTE_TEXT_LIMITS.timeline),
  validityDays: z.number().int().optional(),
};

export const QuoteCreateBody = z.object({ leadId: id, draftId: id.nullable().optional(), ...content });
export type QuoteCreateBody = z.output<typeof QuoteCreateBody>;

/** `expectedVersion` is the version number the editor saw (409 when stale). */
export const QuoteReviseBody = z.object({ expectedVersion: z.number().int().min(1), repriceToActive: z.boolean().optional(), ...content });
export type QuoteReviseBody = z.output<typeof QuoteReviseBody>;

export const QuoteDecisionBody = z.object({ expectedVersion: z.number().int().min(1) });
export type QuoteDecisionBody = z.output<typeof QuoteDecisionBody>;

export const QuoteShareCreateBody = z.object({ expiresInDays: z.number().int().min(1).max(QUOTE_VALIDITY_DAYS.max).optional() });
export type QuoteShareCreateBody = z.output<typeof QuoteShareCreateBody>;

export const QUOTE_LIST_STATUSES = ['DRAFT', 'APPROVED', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED', 'CANCELLED'] as const;
