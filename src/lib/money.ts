/**
 * Quote math (plan §8, ADR-07, ADR-31). Pure, bigint paise only, no floats.
 *
 *   lineTotal = qty * unitPricePaise                         exact
 *   subtotal  = sum(lineTotal)
 *   discount  = PERCENT_BPS: mulDivHalfUp(subtotal, bps)     FLAT_PAISE: value (<= subtotal)
 *   taxable   = subtotal - discount
 *   tax       = mulDivHalfUp(taxable, taxBps)                tax mode NONE -> 0
 *   total     = taxable + tax
 *
 * Each derived amount is rounded once, half-up at the paise. Discount limits per workspace,
 * service and actor are enforced by the pricing service (T13), not here; this module only
 * rejects inputs that cannot be a valid quote (negative, > 100%, flat above the subtotal).
 */
import { AmountInvalidError, DiscountInvalidError } from './errors/classes';

export { formatINR, paiseToRupeeString } from './format/inr';

export type Paise = bigint;

/** ₹100 crore. A total above this routes the quote to review (ADR-07). */
export const QUOTE_TOTAL_SANITY_CAP_PAISE: Paise = 10n ** 11n;

const BPS_DENOMINATOR = 10_000n;
const MAX_BPS = 10_000n;

export type DiscountKind = 'NONE' | 'PERCENT_BPS' | 'FLAT_PAISE';
/** Mirrors QuoteVersion.discountKind + discountValue (bps or paise). */
export type DiscountInput = { kind: DiscountKind; value: bigint };
export type TaxInput = { mode: 'NONE' } | { mode: 'CONFIGURED'; bps: number };
export type LineInput = { qty: number; unitPricePaise: Paise };

export type QuoteTotalsInput = {
  lines: readonly LineInput[];
  discount: DiscountInput;
  tax: TaxInput;
};

export type QuoteTotals = {
  lines: Array<LineInput & { lineTotalPaise: Paise }>;
  subtotalPaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
};

function toBps(bps: bigint | number, what: string): bigint {
  if (typeof bps === 'number' && !Number.isInteger(bps)) {
    throw new AmountInvalidError({ message: `${what} must be an integer number of basis points`, safeDetails: { field: what } });
  }
  const b = BigInt(bps);
  if (b < 0n) throw new AmountInvalidError({ message: `${what} must not be negative`, safeDetails: { field: what } });
  return b;
}

/** (a * bps + 5000) / 10000 with floor division: half-up at the paise for a >= 0. */
export function mulDivHalfUp(a: Paise, bps: bigint | number): Paise {
  if (a < 0n) throw new AmountInvalidError({ message: 'mulDivHalfUp amount must not be negative' });
  const b = toBps(bps, 'bps');
  return (a * b + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
}

function validateLine(line: LineInput, index: number): void {
  if (!Number.isSafeInteger(line.qty) || line.qty < 1) {
    throw new AmountInvalidError({ message: `line ${index}: qty must be a positive integer`, safeDetails: { line: index, field: 'qty' } });
  }
  if (typeof line.unitPricePaise !== 'bigint' || line.unitPricePaise < 0n) {
    throw new AmountInvalidError({
      message: `line ${index}: unitPricePaise must be a non-negative bigint`,
      safeDetails: { line: index, field: 'unitPricePaise' },
    });
  }
}

function computeDiscount(subtotal: Paise, discount: DiscountInput): Paise {
  const { kind, value } = discount;
  if (typeof value !== 'bigint') throw new DiscountInvalidError({ message: 'discount value must be a bigint' });
  switch (kind) {
    case 'NONE':
      if (value !== 0n) throw new DiscountInvalidError({ message: 'discount kind NONE must have value 0' });
      return 0n;
    case 'PERCENT_BPS':
      if (value < 0n || value > MAX_BPS) {
        throw new DiscountInvalidError({ message: 'percent discount must be 0..10000 bps', safeDetails: { maxBps: Number(MAX_BPS) } });
      }
      return mulDivHalfUp(subtotal, value);
    case 'FLAT_PAISE':
      if (value < 0n || value > subtotal) {
        throw new DiscountInvalidError({ message: 'flat discount must be between 0 and the subtotal' });
      }
      return value;
    default: {
      const never: never = kind;
      throw new DiscountInvalidError({ message: `unknown discount kind ${String(never)}` });
    }
  }
}

function computeTax(taxable: Paise, tax: TaxInput): Paise {
  if (tax.mode === 'NONE') return 0n;
  const bps = toBps(tax.bps, 'taxBps');
  if (bps > MAX_BPS) throw new AmountInvalidError({ message: 'taxBps must be 0..10000', safeDetails: { field: 'taxBps' } });
  return mulDivHalfUp(taxable, bps);
}

export function computeQuoteTotals(input: QuoteTotalsInput): QuoteTotals {
  input.lines.forEach(validateLine);
  const lines = input.lines.map((l) => ({ qty: l.qty, unitPricePaise: l.unitPricePaise, lineTotalPaise: BigInt(l.qty) * l.unitPricePaise }));
  const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0n);
  const discountPaise = computeDiscount(subtotalPaise, input.discount);
  const taxablePaise = subtotalPaise - discountPaise;
  const taxPaise = computeTax(taxablePaise, input.tax);
  return { lines, subtotalPaise, discountPaise, taxablePaise, taxPaise, totalPaise: taxablePaise + taxPaise };
}

export function exceedsSanityCap(totalPaise: Paise, capPaise: Paise = QUOTE_TOTAL_SANITY_CAP_PAISE): boolean {
  return totalPaise > capPaise;
}

// ---- DTO helpers (ADR-07: money crosses JSON as decimal strings) --------------------------------

export function serializePaise(paise: Paise): string {
  return paise.toString();
}

/** Parses a DTO paise string (`"2124000"`, optional leading '-'). */
export function parsePaise(value: string): Paise {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new AmountInvalidError({ message: 'paise must be an integer string' });
  }
  return BigInt(value);
}

/** Parses a rupee amount typed by a person (`"21,240.5"`) into paise. At most 2 decimals. */
export function parseRupeesToPaise(value: string): Paise {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const m = /^(-)?(\d{1,3}(?:,\d{2,3})*|\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!m) throw new AmountInvalidError({ message: 'amount must be a rupee value with at most two decimals' });
  const rupees = BigInt(m[2]!.replace(/,/g, ''));
  const paise = BigInt((m[3] ?? '').padEnd(2, '0'));
  const abs = rupees * 100n + paise;
  return m[1] ? -abs : abs;
}
