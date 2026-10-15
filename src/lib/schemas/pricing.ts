/**
 * Pricing request schemas (T13), shared by the /api/app/pricing route handlers and the Pricing
 * page forms (plan §2: one Zod schema set). They check shape only: types, string formats and
 * which keys may appear. Domain ranges (non-negative prices, 0..10000 bps, quantity bounds, an
 * explicit tax rate) are enforced by the pricing services, so a bad value is a 422 with a domain
 * code rather than a 400. Money crosses JSON as an integer paise string (ADR-07).
 */
import { z } from 'zod';

/** An integer paise amount as a decimal string; the sign is allowed so the service can answer 422. */
export const PaiseString = z.string().regex(/^-?\d{1,15}$/, 'Enter a whole number of paise.');

export const SERVICE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,31}$/;

const int = z.number().int();

const serviceMetadata = {
  name: z.string().max(120),
  description: z.string().max(2000),
  unitLabel: z.string().max(40),
  defaultTimelineDays: int.nullable(),
  maxDiscountBps: int.nullable(),
};

/** `expectedVersion` is the active price list version the editor saw (0 when there is none). */
const expectedVersion = int.min(0);

export const ServiceCreateBody = z.object({
  code: z.string().trim().toUpperCase().regex(SERVICE_CODE_PATTERN, 'Use 1 to 32 capital letters, digits or hyphens.'),
  ...serviceMetadata,
  unitPricePaise: PaiseString,
  minQty: int.default(1),
  maxQty: int.default(10_000),
  expectedVersion,
});
export type ServiceCreateBody = z.output<typeof ServiceCreateBody>;

export const ServiceUpdateBody = z
  .object({
    name: serviceMetadata.name.optional(),
    description: serviceMetadata.description.optional(),
    unitLabel: serviceMetadata.unitLabel.optional(),
    defaultTimelineDays: serviceMetadata.defaultTimelineDays.optional(),
    maxDiscountBps: serviceMetadata.maxDiscountBps.optional(),
    unitPricePaise: PaiseString.optional(),
    minQty: int.optional(),
    maxQty: int.optional(),
    expectedVersion,
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'expectedVersion'), { message: 'Change at least one field.' });
export type ServiceUpdateBody = z.output<typeof ServiceUpdateBody>;

export const ServiceArchiveBody = z.object({ expectedVersion });

export const TAX_MODES = ['NONE', 'CONFIGURED'] as const;

export const SettingsUpdateBody = z
  .object({
    taxMode: z.enum(TAX_MODES).optional(),
    taxLabel: z.string().max(40).nullable().optional(),
    taxBps: int.nullable().optional(),
    maxDiscountBps: int.optional(),
    quoteValidityDays: int.optional(),
    gstin: z.string().max(20).nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Change at least one setting.' });
export type SettingsUpdateBody = z.output<typeof SettingsUpdateBody>;

/** GSTIN format only (P8): state code, PAN, entity number, 'Z', checksum character. */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// ---- Form helpers (percentages typed by a person) ----------------------------------------------

/** "18" or "12.5" percent to basis points; null for anything else (at most two decimals). */
export function parsePercentToBps(value: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** 1800 -> "18", 1250 -> "12.5", 5 -> "0.05". */
export function bpsToPercentString(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
