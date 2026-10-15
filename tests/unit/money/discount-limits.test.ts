/**
 * T13, plan §8 discount limits (AT5, R17). Pure decisions, no I/O:
 *  - effective limit = min(WorkspaceSettings.maxDiscountBps, Service.maxDiscountBps of every line
 *    that sets one);
 *  - at the limit: accepted; limit + 1 bp: 422 DISCOUNT_OVER_LIMIT (flat discounts are compared
 *    as an exact fraction of the subtotal);
 *  - above the actor's own cap without `pricing.override`: 403 (the service also audits DENIED);
 *  - negative, above 10000 bps, or flat above the subtotal: 422 DISCOUNT_INVALID;
 *  - a total above the ₹100 crore sanity cap routes to review.
 */
import { describe, expect, it } from 'vitest';
import { DiscountInvalidError, DiscountLimitExceededError, PermissionDeniedError } from '@/lib/errors';
import { QUOTE_TOTAL_SANITY_CAP_PAISE } from '@/lib/money';
import {
  assertDiscountAllowed,
  discountExceedsBps,
  effectiveDiscountLimitBps,
  evaluateDiscount,
  totalNeedsReview,
} from '@/server/services/pricing/compute-totals';

const SUBTOTAL = 2_000_000n;
const owner = { capBps: 1500, canOverride: true };
const employee = { capBps: 500, canOverride: false };

describe('effectiveDiscountLimitBps', () => {
  it('is the workspace limit when no line sets its own', () => {
    expect(effectiveDiscountLimitBps(1500, [null, null])).toBe(1500);
    expect(effectiveDiscountLimitBps(1500, [])).toBe(1500);
  });
  it('is the minimum over the workspace and every line that sets one', () => {
    expect(effectiveDiscountLimitBps(1500, [null, 1000, 2000])).toBe(1000);
    expect(effectiveDiscountLimitBps(800, [1000])).toBe(800);
  });
});

describe('discountExceedsBps', () => {
  it('percent discounts compare basis points directly', () => {
    expect(discountExceedsBps(SUBTOTAL, { kind: 'PERCENT_BPS', value: 1000n }, 1000)).toBe(false);
    expect(discountExceedsBps(SUBTOTAL, { kind: 'PERCENT_BPS', value: 1001n }, 1000)).toBe(true);
  });
  it('flat discounts compare as an exact fraction of the subtotal', () => {
    // 10% of 2,000,000 is 200,000 paise.
    expect(discountExceedsBps(SUBTOTAL, { kind: 'FLAT_PAISE', value: 200_000n }, 1000)).toBe(false);
    expect(discountExceedsBps(SUBTOTAL, { kind: 'FLAT_PAISE', value: 200_001n }, 1000)).toBe(true);
  });
  it('no discount never exceeds', () => {
    expect(discountExceedsBps(SUBTOTAL, { kind: 'NONE', value: 0n }, 0)).toBe(false);
  });
});

describe('evaluateDiscount / assertDiscountAllowed', () => {
  const base = { subtotalPaise: SUBTOTAL, workspaceMaxBps: 1500, serviceMaxBps: [null, 1000] as Array<number | null> };

  it('accepts a discount exactly at the effective limit', () => {
    const decision = evaluateDiscount({ ...base, discount: { kind: 'PERCENT_BPS', value: 1000n }, authority: owner });
    expect(decision).toEqual({ ok: true, limitBps: 1000 });
    expect(assertDiscountAllowed({ ...base, discount: { kind: 'PERCENT_BPS', value: 1000n }, authority: owner })).toBe(1000);
  });

  it('limit + 1 bp by a human is 422 DISCOUNT_OVER_LIMIT, even for the owner', () => {
    const input = { ...base, discount: { kind: 'PERCENT_BPS' as const, value: 1001n }, authority: owner };
    expect(evaluateDiscount(input)).toMatchObject({ ok: false, code: 'DISCOUNT_OVER_LIMIT', limitBps: 1000 });
    const thrown = (() => {
      try {
        assertDiscountAllowed(input);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(thrown).toBeInstanceOf(DiscountLimitExceededError);
    expect((thrown as DiscountLimitExceededError).status).toBe(422);
    expect((thrown as DiscountLimitExceededError).code).toBe('DISCOUNT_OVER_LIMIT');
  });

  it('a flat discount above the limit fraction is 422 DISCOUNT_OVER_LIMIT', () => {
    expect(() => assertDiscountAllowed({ ...base, discount: { kind: 'FLAT_PAISE', value: 200_001n }, authority: owner })).toThrow(DiscountLimitExceededError);
    expect(assertDiscountAllowed({ ...base, discount: { kind: 'FLAT_PAISE', value: 200_000n }, authority: owner })).toBe(1000);
  });

  it("above the actor's own cap without pricing.override is 403", () => {
    const input = { ...base, discount: { kind: 'PERCENT_BPS' as const, value: 501n }, authority: employee };
    expect(evaluateDiscount(input)).toMatchObject({ ok: false, code: 'DISCOUNT_OVER_ACTOR_CAP', capBps: 500 });
    let thrown: unknown = null;
    try {
      assertDiscountAllowed(input);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PermissionDeniedError);
    expect((thrown as PermissionDeniedError).status).toBe(403);
    expect((thrown as PermissionDeniedError).code).toBe('DISCOUNT_OVER_ACTOR_CAP');
  });

  it("at the actor's cap is accepted", () => {
    expect(assertDiscountAllowed({ ...base, discount: { kind: 'PERCENT_BPS', value: 500n }, authority: employee })).toBe(1000);
  });

  it('pricing.override lifts the actor cap but never the effective limit', () => {
    const overriding = { capBps: 500, canOverride: true };
    expect(assertDiscountAllowed({ ...base, discount: { kind: 'PERCENT_BPS', value: 900n }, authority: overriding })).toBe(1000);
    expect(() => assertDiscountAllowed({ ...base, discount: { kind: 'PERCENT_BPS', value: 1001n }, authority: overriding })).toThrow(DiscountLimitExceededError);
  });

  it('the effective limit wins over the actor cap when both are exceeded (422, not 403)', () => {
    expect(() => assertDiscountAllowed({ ...base, discount: { kind: 'PERCENT_BPS', value: 1200n }, authority: employee })).toThrow(DiscountLimitExceededError);
  });

  it('system and job contexts have no actor cap, only the effective limit', () => {
    expect(assertDiscountAllowed({ ...base, discount: { kind: 'PERCENT_BPS', value: 1000n }, authority: null })).toBe(1000);
    expect(() => assertDiscountAllowed({ ...base, discount: { kind: 'PERCENT_BPS', value: 1001n }, authority: null })).toThrow(DiscountLimitExceededError);
  });

  it('negative, above 10000 bps, or flat above the subtotal is 422 DISCOUNT_INVALID', () => {
    const wide = { ...base, workspaceMaxBps: 10_000, serviceMaxBps: [], authority: owner };
    for (const discount of [
      { kind: 'PERCENT_BPS' as const, value: -1n },
      { kind: 'PERCENT_BPS' as const, value: 10_001n },
      { kind: 'FLAT_PAISE' as const, value: -1n },
      { kind: 'FLAT_PAISE' as const, value: SUBTOTAL + 1n },
      { kind: 'NONE' as const, value: 5n },
    ]) {
      expect(evaluateDiscount({ ...wide, discount })).toMatchObject({ ok: false, code: 'DISCOUNT_INVALID' });
      let thrown: unknown = null;
      try {
        assertDiscountAllowed({ ...wide, discount });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(DiscountInvalidError);
      expect((thrown as DiscountInvalidError).status).toBe(422);
    }
  });

  it('no discount is always allowed', () => {
    expect(assertDiscountAllowed({ ...base, discount: { kind: 'NONE', value: 0n }, authority: employee })).toBe(1000);
  });
});

describe('sanity cap', () => {
  it('a total above ₹100 crore routes to review; at the cap it does not', () => {
    expect(QUOTE_TOTAL_SANITY_CAP_PAISE).toBe(100_000_000_000n);
    expect(totalNeedsReview(QUOTE_TOTAL_SANITY_CAP_PAISE)).toBe(false);
    expect(totalNeedsReview(QUOTE_TOTAL_SANITY_CAP_PAISE + 1n)).toBe(true);
  });
  it('the cap is configurable', () => {
    expect(totalNeedsReview(1_001n, 1_000n)).toBe(true);
    expect(totalNeedsReview(1_000n, 1_000n)).toBe(false);
  });
});
