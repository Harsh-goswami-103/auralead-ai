/**
 * Server-side quote pricing (T13, plan §8, AT5, R17). The one place that turns requested lines
 * (service id + quantity) and a discount into priced lines and totals:
 *
 *  - Unit prices come only from a PricingVersion (the active one unless a version is pinned).
 *    Nothing in the input can carry a price, so neither a person nor an AI can invent one.
 *  - Money math is `computeQuoteTotals` from src/lib/money.ts (half-up once per derived amount).
 *  - Tax comes from WorkspaceSettings with an explicit mode: NONE gives no tax line; CONFIGURED
 *    uses its label and rate. Nothing defaults to 0%.
 *  - Review, not rejection: a service without a price in the version (PRICE_MISSING, or
 *    SERVICE_ARCHIVED) is left out of the totals and sets `needsPricingReview`; so does a total
 *    above the ₹100 crore sanity cap (configurable).
 *  - Rejection: quantities outside the price entry's bounds (422), a service id of another
 *    workspace (404 via assertSameWorkspace), no price list at all (422 PRICING_MISSING), and
 *    discounts outside the limits:
 *      effective limit = min(WorkspaceSettings.maxDiscountBps, Service.maxDiscountBps of every
 *      line that sets one); above it 422 DISCOUNT_OVER_LIMIT for everyone; within it but above
 *      the actor's own cap (ctx.maxDiscountBps) without `pricing.override`: 403, and an AuditEvent
 *      with result DENIED is committed before the error is thrown.
 *
 * Call it outside any transaction (it reads through ctx.db and may write the DENIED audit row);
 * persist the result with `quoteVersionPricingData` and `quoteItemsData` inside the caller's
 * transaction. The pure decision helpers below are exported for unit tests and other callers.
 */
import type { DiscountKind, Prisma, TaxMode } from '@/generated/prisma/client';
import { AmountInvalidError, DiscountInvalidError, DiscountLimitExceededError, PermissionDeniedError, PricingMissingError, type AppError } from '@/lib/errors';
import { computeQuoteTotals as computeMoney, exceedsSanityCap, QUOTE_TOTAL_SANITY_CAP_PAISE, serializePaise, type DiscountInput, type Paise } from '@/lib/money';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireWorkspace } from '@/server/auth/guards';
import { assertSameWorkspace } from '@/server/db/scoped';
import { recordAudit } from '@/server/services/audit/record';
import { readPricingSettings } from './settings';

const MAX_BPS = 10_000n;

// ---- Pure decisions ------------------------------------------------------------------------------

export function effectiveDiscountLimitBps(workspaceMaxBps: number, serviceMaxBps: ReadonlyArray<number | null>): number {
  return serviceMaxBps.reduce<number>((min, b) => (b === null ? min : Math.min(min, b)), workspaceMaxBps);
}

/** True when the discount is above `limitBps` of the subtotal (flat amounts compared exactly). */
export function discountExceedsBps(subtotalPaise: Paise, discount: DiscountInput, limitBps: number): boolean {
  const limit = BigInt(limitBps);
  switch (discount.kind) {
    case 'NONE':
      return false;
    case 'PERCENT_BPS':
      return discount.value > limit;
    case 'FLAT_PAISE':
      return discount.value * MAX_BPS > limit * subtotalPaise;
  }
}

/** Who is applying the discount: their own cap and whether they hold `pricing.override`. Null for system and job contexts. */
export type DiscountAuthority = { capBps: number | null; canOverride: boolean } | null;

export type DiscountCheckInput = {
  subtotalPaise: Paise;
  discount: DiscountInput;
  workspaceMaxBps: number;
  serviceMaxBps: ReadonlyArray<number | null>;
  authority: DiscountAuthority;
};

export type DiscountDecision =
  | { ok: true; limitBps: number }
  | { ok: false; code: 'DISCOUNT_INVALID' | 'DISCOUNT_OVER_LIMIT' | 'DISCOUNT_OVER_ACTOR_CAP'; limitBps: number; capBps: number | null };

function discountIsValid(subtotalPaise: Paise, d: DiscountInput): boolean {
  if (typeof d.value !== 'bigint') return false;
  switch (d.kind) {
    case 'NONE':
      return d.value === 0n;
    case 'PERCENT_BPS':
      return d.value >= 0n && d.value <= MAX_BPS;
    case 'FLAT_PAISE':
      return d.value >= 0n && d.value <= subtotalPaise;
    default:
      return false;
  }
}

export function evaluateDiscount(input: DiscountCheckInput): DiscountDecision {
  const limitBps = effectiveDiscountLimitBps(input.workspaceMaxBps, input.serviceMaxBps);
  const capBps = input.authority?.capBps ?? null;
  if (!discountIsValid(input.subtotalPaise, input.discount)) return { ok: false, code: 'DISCOUNT_INVALID', limitBps, capBps };
  if (discountExceedsBps(input.subtotalPaise, input.discount, limitBps)) return { ok: false, code: 'DISCOUNT_OVER_LIMIT', limitBps, capBps };
  if (input.authority && !input.authority.canOverride && capBps !== null && discountExceedsBps(input.subtotalPaise, input.discount, capBps)) {
    return { ok: false, code: 'DISCOUNT_OVER_ACTOR_CAP', limitBps, capBps };
  }
  return { ok: true, limitBps };
}

const pct = (bps: number) => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

export function discountDecisionError(decision: Exclude<DiscountDecision, { ok: true }>): AppError {
  switch (decision.code) {
    case 'DISCOUNT_INVALID':
      return new DiscountInvalidError({ safeDetails: { field: 'discount' } });
    case 'DISCOUNT_OVER_LIMIT':
      return new DiscountLimitExceededError({
        userMessage: `The discount is above the ${pct(decision.limitBps)} limit for this quote.`,
        safeDetails: { field: 'discount', limitBps: decision.limitBps },
      });
    case 'DISCOUNT_OVER_ACTOR_CAP':
      return new PermissionDeniedError({
        code: 'DISCOUNT_OVER_ACTOR_CAP',
        userMessage: `Your discount limit is ${pct(decision.capBps ?? 0)}. Ask the workspace owner to approve a larger discount.`,
        safeDetails: { field: 'discount', capBps: decision.capBps },
      });
  }
}

/** Throws the decision's error; returns the effective limit when allowed. */
export function assertDiscountAllowed(input: DiscountCheckInput): number {
  const decision = evaluateDiscount(input);
  if (!decision.ok) throw discountDecisionError(decision);
  return decision.limitBps;
}

export function totalNeedsReview(totalPaise: Paise, capPaise: Paise = QUOTE_TOTAL_SANITY_CAP_PAISE): boolean {
  return exceedsSanityCap(totalPaise, capPaise);
}

// ---- Catalog-backed computation --------------------------------------------------------------------

export type QuoteLineRequest = { serviceId: string; qty: number };

export type ComputeTotalsInput = {
  items: readonly QuoteLineRequest[];
  discount: DiscountInput;
  /** Price against this version (a revision of an issued quote); defaults to the active version. */
  pricingVersionId?: string;
  /** Total above which the quote goes to review (default ₹100 crore). */
  sanityCapPaise?: Paise;
  /** What the DENIED audit row points at (default: the workspace). */
  auditTarget?: { type: string; id: string };
};

export type ReviewReason =
  | { code: 'PRICE_MISSING'; serviceId: string }
  | { code: 'SERVICE_ARCHIVED'; serviceId: string }
  | { code: 'TOTAL_ABOVE_SANITY_CAP'; totalPaise: string; capPaise: string };

export type PricedLine = {
  serviceId: string;
  serviceName: string;
  unitLabel: string;
  qty: number;
  unitPricePaise: Paise;
  lineTotalPaise: Paise;
  position: number;
};

export type UnpricedLine = { serviceId: string; serviceName: string; qty: number; reason: 'PRICE_MISSING' | 'SERVICE_ARCHIVED' };

export type QuoteTax = { mode: TaxMode; label: string | null; bps: number | null };

export type ComputedQuote = {
  pricingVersion: { id: string; version: number };
  lines: PricedLine[];
  unpriced: UnpricedLine[];
  totals: { subtotalPaise: Paise; discountPaise: Paise; taxablePaise: Paise; taxPaise: Paise; totalPaise: Paise };
  discount: DiscountInput;
  tax: QuoteTax;
  discountLimitBps: number;
  needsPricingReview: boolean;
  reviewReasons: ReviewReason[];
  /** Stored on QuoteVersion.snapshot: what the prices and rules were when this was computed. */
  snapshot: Prisma.InputJsonObject;
};

export async function computeQuoteTotals(ctx: AppCtx, input: ComputeTotalsInput): Promise<ComputedQuote> {
  const workspaceId = requireWorkspace(ctx);
  const db = ctx.db;
  const serviceIds = [...new Set(input.items.map((i) => i.serviceId))];
  await assertSameWorkspace(db, ctx, { serviceId: serviceIds, pricingVersionId: input.pricingVersionId ?? null });

  const settings = await readPricingSettings(db);
  const version = await db.pricingVersion.findFirst({
    where: input.pricingVersionId ? { id: input.pricingVersionId } : { active: true },
    include: { entries: { where: { serviceId: { in: serviceIds } } } },
  });
  if (!version) throw new PricingMissingError({ userMessage: 'This workspace has no price list yet. Add services under Pricing.' });
  const services = await db.service.findMany({ where: { id: { in: serviceIds } } });
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const entryById = new Map(version.entries.map((e) => [e.serviceId, e]));

  const lines: Array<Omit<PricedLine, 'lineTotalPaise'>> = [];
  const unpriced: UnpricedLine[] = [];
  const reviewReasons: ReviewReason[] = [];
  for (const item of input.items) {
    const service = serviceById.get(item.serviceId)!;
    const entry = entryById.get(item.serviceId);
    const min = entry?.minQty ?? 1;
    const max = entry?.maxQty ?? 10_000;
    if (!Number.isSafeInteger(item.qty) || item.qty < min || item.qty > max) {
      throw new AmountInvalidError({
        userMessage: `Quantity for ${service.name} must be a whole number from ${min} to ${max}.`,
        safeDetails: { field: 'qty', serviceId: service.id, minQty: min, maxQty: max },
      });
    }
    if (!entry) {
      const reason = service.archivedAt !== null && !input.pricingVersionId ? 'SERVICE_ARCHIVED' : 'PRICE_MISSING';
      unpriced.push({ serviceId: service.id, serviceName: service.name, qty: item.qty, reason });
      reviewReasons.push({ code: reason, serviceId: service.id });
      continue;
    }
    lines.push({ serviceId: service.id, serviceName: service.name, unitLabel: service.unitLabel, qty: item.qty, unitPricePaise: entry.unitPricePaise, position: lines.length });
  }

  const tax: QuoteTax =
    settings.taxMode === 'CONFIGURED' && settings.taxBps !== null
      ? { mode: 'CONFIGURED', label: settings.taxLabel, bps: settings.taxBps }
      : { mode: 'NONE', label: null, bps: null };
  if (settings.taxMode === 'CONFIGURED' && settings.taxBps === null) {
    throw new PricingMissingError({ code: 'TAX_NOT_CONFIGURED', userMessage: 'Tax is set to configured but has no rate. Fix it under Pricing.' });
  }

  const subtotalPaise = lines.reduce((sum, l) => sum + BigInt(l.qty) * l.unitPricePaise, 0n);
  const authority: DiscountAuthority = ctx.actor ? { capBps: ctx.maxDiscountBps, canOverride: hasCapability(ctx, 'pricing.override') } : null;
  const decision = evaluateDiscount({
    subtotalPaise,
    discount: input.discount,
    workspaceMaxBps: settings.maxDiscountBps,
    serviceMaxBps: lines.map((l) => serviceById.get(l.serviceId)!.maxDiscountBps),
    authority,
  });
  if (!decision.ok) {
    if (decision.code === 'DISCOUNT_OVER_ACTOR_CAP') {
      await recordAudit(db, ctx, {
        action: 'pricing.discount.denied',
        targetType: input.auditTarget?.type ?? 'Workspace',
        targetId: input.auditTarget?.id ?? workspaceId,
        result: 'DENIED',
        summary: {
          discountKind: input.discount.kind,
          requestedBps: input.discount.kind === 'PERCENT_BPS' ? Number(input.discount.value) : null,
          capBps: decision.capBps,
          limitBps: decision.limitBps,
        },
      });
    }
    throw discountDecisionError(decision);
  }

  const money = computeMoney({
    lines,
    discount: input.discount,
    tax: tax.mode === 'CONFIGURED' ? { mode: 'CONFIGURED', bps: tax.bps! } : { mode: 'NONE' },
  });
  const capPaise = input.sanityCapPaise ?? QUOTE_TOTAL_SANITY_CAP_PAISE;
  if (totalNeedsReview(money.totalPaise, capPaise)) {
    reviewReasons.push({ code: 'TOTAL_ABOVE_SANITY_CAP', totalPaise: serializePaise(money.totalPaise), capPaise: serializePaise(capPaise) });
  }

  const pricedLines: PricedLine[] = lines.map((l, i) => ({ ...l, lineTotalPaise: money.lines[i]!.lineTotalPaise }));
  const snapshot: Prisma.InputJsonObject = {
    pricingVersionId: version.id,
    pricingVersion: version.version,
    services: serviceIds.map((id) => {
      const s = serviceById.get(id)!;
      const e = entryById.get(id);
      return {
        serviceId: s.id,
        code: s.code,
        name: s.name,
        unitLabel: s.unitLabel,
        unitPricePaise: e ? serializePaise(e.unitPricePaise) : null,
        minQty: e?.minQty ?? null,
        maxQty: e?.maxQty ?? null,
        maxDiscountBps: s.maxDiscountBps,
      };
    }),
    rules: {
      workspaceMaxDiscountBps: settings.maxDiscountBps,
      effectiveDiscountLimitBps: decision.limitBps,
      taxMode: tax.mode,
      taxLabel: tax.label,
      taxBps: tax.bps,
      quoteValidityDays: settings.quoteValidityDays,
      gstin: settings.gstin,
      sanityCapPaise: serializePaise(capPaise),
    },
    computedAt: ctx.clock.now().toISOString(),
  };

  return {
    pricingVersion: { id: version.id, version: version.version },
    lines: pricedLines,
    unpriced,
    totals: {
      subtotalPaise: money.subtotalPaise,
      discountPaise: money.discountPaise,
      taxablePaise: money.taxablePaise,
      taxPaise: money.taxPaise,
      totalPaise: money.totalPaise,
    },
    discount: input.discount,
    tax,
    discountLimitBps: decision.limitBps,
    needsPricingReview: reviewReasons.length > 0,
    reviewReasons,
    snapshot,
  };
}

// ---- Persistence mapping (used inside the caller's transaction) -----------------------------------

/** The pricing columns of a QuoteVersion, exactly as computed (persisted, never recomputed at render). */
export function quoteVersionPricingData(q: ComputedQuote): {
  pricingVersionId: string;
  snapshot: Prisma.InputJsonObject;
  discountKind: DiscountKind;
  discountValue: bigint;
  taxLabel: string | null;
  taxBps: number | null;
  subtotalPaise: bigint;
  discountPaise: bigint;
  taxablePaise: bigint;
  taxPaise: bigint;
  totalPaise: bigint;
  reviewReasons: Prisma.InputJsonArray;
} {
  return {
    pricingVersionId: q.pricingVersion.id,
    snapshot: q.snapshot,
    discountKind: q.discount.kind,
    discountValue: q.discount.value,
    taxLabel: q.tax.label,
    taxBps: q.tax.bps,
    ...q.totals,
    reviewReasons: q.reviewReasons as unknown as Prisma.InputJsonArray,
  };
}

/** QuoteItem rows for the version, in line order. */
export function quoteItemsData(q: ComputedQuote): Array<{
  serviceId: string;
  serviceNameSnapshot: string;
  unitLabel: string;
  qty: number;
  unitPricePaise: bigint;
  lineTotalPaise: bigint;
  position: number;
}> {
  return q.lines.map((l) => ({
    serviceId: l.serviceId,
    serviceNameSnapshot: l.serviceName,
    unitLabel: l.unitLabel,
    qty: l.qty,
    unitPricePaise: l.unitPricePaise,
    lineTotalPaise: l.lineTotalPaise,
    position: l.position,
  }));
}
