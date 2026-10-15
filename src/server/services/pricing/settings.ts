/**
 * Quote pricing settings (T13): tax with an explicit mode, the workspace discount limit, quote
 * validity and the GSTIN shown on quotations. Lives on WorkspaceSettings (plan §5.2).
 *
 * Rules (plan §8, ADR-31, P8):
 *  - Tax is never implicit: `NONE` means no tax line; `CONFIGURED` needs a label (1..40 chars) and
 *    a rate of 0..10000 bps. Switching to NONE clears the label and rate.
 *  - maxDiscountBps is 0..10000; quoteValidityDays is 1..365.
 *  - GSTIN is format-validated only (it is printed, never interpreted) and stored upper-case.
 * Reads need a workspace; changes need `pricing.override` (workspace OWNER). Every change is one
 * transaction with its AuditEvent; the audit summary names the changed fields, not their values.
 */
import type { TaxMode } from '@/generated/prisma/client';
import { DomainRuleError, NotFoundError } from '@/lib/errors';
import { GSTIN_PATTERN, type SettingsUpdateBody } from '@/lib/schemas/pricing';
import type { AppCtx } from '@/server/auth/context';
import { requireCapability, requireWorkspace } from '@/server/auth/guards';
import type { ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';

export const MAX_BPS = 10_000;
export const QUOTE_VALIDITY_DAYS = { min: 1, max: 365 } as const;
export const TAX_LABEL_MAX = 40;

export type PricingSettings = {
  taxMode: TaxMode;
  taxLabel: string | null;
  taxBps: number | null;
  maxDiscountBps: number;
  quoteValidityDays: number;
  gstin: string | null;
  updatedAt: Date;
};

export type PricingSettingsInput = SettingsUpdateBody;

type SettingsReader = Pick<ScopedTx, 'workspaceSettings'>;

const toSettings = (row: {
  taxMode: TaxMode;
  taxLabel: string | null;
  taxBps: number | null;
  maxDiscountBps: number;
  quoteValidityDays: number;
  gstin: string | null;
  updatedAt: Date;
}): PricingSettings => ({
  taxMode: row.taxMode,
  taxLabel: row.taxLabel,
  taxBps: row.taxBps,
  maxDiscountBps: row.maxDiscountBps,
  quoteValidityDays: row.quoteValidityDays,
  gstin: row.gstin,
  updatedAt: row.updatedAt,
});

/** The workspace's settings row; a workspace without one cannot price quotes. */
export async function readPricingSettings(db: SettingsReader): Promise<PricingSettings> {
  const row = await db.workspaceSettings.findFirst();
  if (!row) throw new NotFoundError({ message: 'workspace settings missing' });
  return toSettings(row);
}

export async function getPricingSettings(ctx: AppCtx): Promise<PricingSettings> {
  requireWorkspace(ctx);
  return readPricingSettings(ctx.db);
}

const rule = (code: string, userMessage: string, field: string) => new DomainRuleError({ code, userMessage, safeDetails: { field } });

const isBps = (v: number) => Number.isInteger(v) && v >= 0 && v <= MAX_BPS;

type Resolved = Omit<PricingSettings, 'updatedAt'>;

/** Applies a partial update to the current settings and validates the result as a whole. */
export function resolveSettings(current: Resolved, input: PricingSettingsInput): Resolved {
  const next: Resolved = { ...current };
  if (input.taxMode !== undefined) next.taxMode = input.taxMode;
  if (input.taxLabel !== undefined) next.taxLabel = input.taxLabel === null ? null : input.taxLabel.trim();
  if (input.taxBps !== undefined) next.taxBps = input.taxBps;
  if (input.maxDiscountBps !== undefined) next.maxDiscountBps = input.maxDiscountBps;
  if (input.quoteValidityDays !== undefined) next.quoteValidityDays = input.quoteValidityDays;
  if (input.gstin !== undefined) {
    const g = input.gstin === null ? '' : input.gstin.trim().toUpperCase();
    next.gstin = g === '' ? null : g;
  }

  if (next.taxMode === 'NONE') {
    next.taxLabel = null;
    next.taxBps = null;
  } else {
    if (next.taxBps === null || next.taxLabel === null || next.taxLabel === '') {
      throw rule('TAX_NOT_CONFIGURED', 'Configured tax needs a label and a rate. Choose "No tax" to quote without tax.', 'taxBps');
    }
    if (!isBps(next.taxBps)) throw rule('TAX_RATE_INVALID', 'The tax rate must be between 0% and 100%.', 'taxBps');
    if (next.taxLabel.length > TAX_LABEL_MAX) throw rule('TAX_LABEL_INVALID', `The tax label can be at most ${TAX_LABEL_MAX} characters.`, 'taxLabel');
  }
  if (!isBps(next.maxDiscountBps)) throw rule('DISCOUNT_LIMIT_INVALID', 'The maximum discount must be between 0% and 100%.', 'maxDiscountBps');
  if (!Number.isInteger(next.quoteValidityDays) || next.quoteValidityDays < QUOTE_VALIDITY_DAYS.min || next.quoteValidityDays > QUOTE_VALIDITY_DAYS.max) {
    throw rule('VALIDITY_INVALID', `Quote validity must be ${QUOTE_VALIDITY_DAYS.min} to ${QUOTE_VALIDITY_DAYS.max} days.`, 'quoteValidityDays');
  }
  if (next.gstin !== null && !GSTIN_PATTERN.test(next.gstin)) {
    throw rule('GSTIN_INVALID', 'The GSTIN must be 15 characters, for example 07AAACR5055K1Z5.', 'gstin');
  }
  return next;
}

const SETTING_FIELDS = ['taxMode', 'taxLabel', 'taxBps', 'maxDiscountBps', 'quoteValidityDays', 'gstin'] as const;

export async function updatePricingSettings(ctx: AppCtx, input: PricingSettingsInput): Promise<PricingSettings> {
  const workspaceId = requireWorkspace(ctx);
  requireCapability(ctx, 'pricing.override');
  return withTx(ctx.db, async (tx) => {
    const current = await readPricingSettings(tx);
    const next = resolveSettings(current, input);
    const changed = SETTING_FIELDS.filter((f) => next[f] !== current[f]);
    const row = await tx.workspaceSettings.update({
      where: { workspaceId },
      data: { ...next, updatedBy: ctx.actor?.userId ?? null },
    });
    await recordAudit(tx, ctx, { action: 'pricing.settings.update', targetType: 'WorkspaceSettings', targetId: workspaceId, summary: { fields: changed } });
    return toSettings(row);
  });
}
