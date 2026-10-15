/**
 * Service catalog and versioned price list (T13, plan §5.4, 01-arch "Pricing service CRUD").
 *
 *  - A Service row holds what a quote line describes (name, description, unit label, typical
 *    timeline, per-service discount limit). Editing these fields updates the row in place: issued
 *    quotes keep their own snapshot (QuoteItem.serviceNameSnapshot, QuoteVersion.snapshot).
 *  - Prices live in PricingVersion + PriceEntry. Every change to the price list (a service added,
 *    a price or quantity bound changed, a service removed) publishes version N+1: the active
 *    version's entries are copied with the change applied, the old version is deactivated (its
 *    entries are never edited), and exactly one version stays active (partial unique index).
 *  - "Delete" archives a service that anything references (a quote item or a price entry in any
 *    version, so history stays readable) and drops it from the next version; a service nothing
 *    references is removed.
 *  - Optimistic concurrency: every mutation carries the active version number the editor saw
 *    (`expectedVersion`, 0 when there is none); a mismatch is 409 PRICING_VERSION_CONFLICT.
 *
 * Changes need `pricing.override` (the workspace OWNER); reads need a workspace. Each mutation is
 * one immediate transaction including its AuditEvent. Ids from the route are checked against the
 * context workspace with assertSameWorkspace (404 across tenants).
 */
import type { PriceEntry, PricingVersion, Service } from '@/generated/prisma/client';
import { AmountInvalidError, ConflictError, DomainRuleError, NotFoundError, ServiceNotApprovedError } from '@/lib/errors';
import { QUOTE_TOTAL_SANITY_CAP_PAISE, serializePaise } from '@/lib/money';
import type { AppCtx } from '@/server/auth/context';
import { hasCapability, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { assertSameWorkspace, type ScopedTx } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { recordAudit } from '@/server/services/audit/record';
import { getPricingSettings, MAX_BPS, type PricingSettings } from './settings';

export const QTY_BOUNDS = { min: 1, max: 10_000 } as const;
export const TIMELINE_DAYS_MAX = 3650;
/** A single unit priced above the quote sanity cap can never be quoted without review. */
export const MAX_UNIT_PRICE_PAISE = QUOTE_TOTAL_SANITY_CAP_PAISE;

export type ServiceMetadataInput = {
  name: string;
  description: string;
  unitLabel: string;
  defaultTimelineDays: number | null;
  maxDiscountBps: number | null;
};

export type PriceInput = { unitPricePaise: bigint; minQty: number; maxQty: number };

export type CreateServiceInput = ServiceMetadataInput & PriceInput & { code: string; expectedVersion: number };
export type UpdateServiceInput = Partial<ServiceMetadataInput> & Partial<PriceInput> & { expectedVersion: number };

export type VersionRef = { id: string; version: number };

export type CatalogService = {
  id: string;
  code: string;
  name: string;
  description: string;
  unitLabel: string;
  defaultTimelineDays: number | null;
  maxDiscountBps: number | null;
  archivedAt: Date | null;
  price: PriceInput | null;
};

export type PricingHistoryVersion = {
  id: string;
  version: number;
  active: boolean;
  note: string;
  createdAt: Date;
  createdByName: string | null;
  entries: Array<{ serviceId: string; code: string; name: string; unitLabel: string } & PriceInput>;
};

export type PricingOverview = {
  workspace: { name: string; timezone: string };
  canEdit: boolean;
  activeVersion: { id: string; version: number; note: string; createdAt: Date } | null;
  services: CatalogService[];
  settings: PricingSettings;
  versions: PricingHistoryVersion[];
};

/** Versions shown in the history tab, newest first. */
export const HISTORY_LIMIT = 50;

// ---- Validation (422 with a domain code) ---------------------------------------------------------

const invalid = (code: string, userMessage: string, field: string) => new DomainRuleError({ code, userMessage, safeDetails: { field } });

function validateMetadata(m: Partial<ServiceMetadataInput>): Partial<ServiceMetadataInput> {
  const out: Partial<ServiceMetadataInput> = {};
  if (m.name !== undefined) {
    out.name = m.name.trim();
    if (out.name.length < 1 || out.name.length > 120) throw invalid('SERVICE_NAME_INVALID', 'The service name must be 1 to 120 characters.', 'name');
  }
  if (m.description !== undefined) out.description = m.description.trim();
  if (m.unitLabel !== undefined) {
    out.unitLabel = m.unitLabel.trim();
    if (out.unitLabel.length < 1 || out.unitLabel.length > 40) throw invalid('UNIT_LABEL_INVALID', 'The unit must be 1 to 40 characters, for example "page" or "month".', 'unitLabel');
  }
  if (m.defaultTimelineDays !== undefined) {
    const d = m.defaultTimelineDays;
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > TIMELINE_DAYS_MAX)) {
      throw invalid('TIMELINE_INVALID', `The typical timeline must be 1 to ${TIMELINE_DAYS_MAX} days, or empty.`, 'defaultTimelineDays');
    }
    out.defaultTimelineDays = d;
  }
  if (m.maxDiscountBps !== undefined) {
    const b = m.maxDiscountBps;
    if (b !== null && (!Number.isInteger(b) || b < 0 || b > MAX_BPS)) {
      throw invalid('DISCOUNT_LIMIT_INVALID', 'The service discount limit must be between 0% and 100%, or empty.', 'maxDiscountBps');
    }
    out.maxDiscountBps = b;
  }
  return out;
}

function validatePrice(p: PriceInput): PriceInput {
  if (typeof p.unitPricePaise !== 'bigint' || p.unitPricePaise < 0n) {
    throw new AmountInvalidError({ userMessage: 'The price cannot be negative.', safeDetails: { field: 'unitPricePaise' } });
  }
  if (p.unitPricePaise > MAX_UNIT_PRICE_PAISE) {
    throw new AmountInvalidError({ userMessage: 'The price is above ₹100 crore per unit.', safeDetails: { field: 'unitPricePaise' } });
  }
  const { minQty, maxQty } = p;
  if (!Number.isInteger(minQty) || !Number.isInteger(maxQty) || minQty < QTY_BOUNDS.min || maxQty > QTY_BOUNDS.max || minQty > maxQty) {
    throw new AmountInvalidError({
      userMessage: `Quantities must be whole numbers with ${QTY_BOUNDS.min} <= minimum <= maximum <= ${QTY_BOUNDS.max}.`,
      safeDetails: { field: minQty > maxQty ? 'maxQty' : 'minQty' },
    });
  }
  return p;
}

// ---- Reads -------------------------------------------------------------------------------------

type ActiveVersion = PricingVersion & { entries: PriceEntry[] };

async function loadActiveVersion(db: Pick<ScopedTx, 'pricingVersion'>): Promise<ActiveVersion | null> {
  // findFirst with the predicate, never findUnique on the partial-unique key (ADR-47).
  return db.pricingVersion.findFirst({ where: { active: true }, include: { entries: true } });
}

const priceOf = (e: PriceEntry): PriceInput => ({ unitPricePaise: e.unitPricePaise, minQty: e.minQty, maxQty: e.maxQty });

export async function getPricingOverview(ctx: AppCtx): Promise<PricingOverview> {
  const workspaceId = requireWorkspace(ctx);
  const db = ctx.db;
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, timezone: true } });
  if (!workspace) throw new NotFoundError();
  const settings = await getPricingSettings(ctx);
  const active = await loadActiveVersion(db);
  const services = await db.service.findMany({ orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { code: 'asc' }] });
  const entryByService = new Map((active?.entries ?? []).map((e) => [e.serviceId, e]));
  const serviceById = new Map(services.map((s) => [s.id, s]));

  const versions = await db.pricingVersion.findMany({ orderBy: { version: 'desc' }, take: HISTORY_LIMIT, include: { entries: true } });
  const creatorIds = [...new Set(versions.map((v) => v.createdBy))];
  const creators = await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } });
  const creatorName = new Map(creators.map((u) => [u.id, u.name]));

  return {
    workspace,
    canEdit: hasCapability(ctx, 'pricing.override'),
    activeVersion: active ? { id: active.id, version: active.version, note: active.note, createdAt: active.createdAt } : null,
    services: services.map((s) => {
      const entry = entryByService.get(s.id);
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        description: s.description,
        unitLabel: s.unitLabel,
        defaultTimelineDays: s.defaultTimelineDays,
        maxDiscountBps: s.maxDiscountBps,
        archivedAt: s.archivedAt,
        price: entry ? priceOf(entry) : null,
      };
    }),
    settings,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      active: v.active,
      note: v.note,
      createdAt: v.createdAt,
      createdByName: creatorName.get(v.createdBy) ?? null,
      entries: v.entries
        .map((e) => {
          const s = serviceById.get(e.serviceId);
          return { serviceId: e.serviceId, code: s?.code ?? '', name: s?.name ?? '', unitLabel: s?.unitLabel ?? '', ...priceOf(e) };
        })
        .sort((a, b) => a.code.localeCompare(b.code)),
    })),
  };
}

// ---- Version publishing --------------------------------------------------------------------------

function assertExpectedVersion(active: ActiveVersion | null, expectedVersion: number): void {
  const current = active?.version ?? 0;
  if (current !== expectedVersion) {
    throw new ConflictError({
      code: 'PRICING_VERSION_CONFLICT',
      userMessage: `The price list changed (now version ${current}). Reload and try again.`,
      safeDetails: { currentVersion: current, expectedVersion },
    });
  }
}

type EntryDraft = { serviceId: string } & PriceInput;

/** Publishes version N+1 holding `entries`, deactivating the current one. Returns the new version. */
async function publishVersion(tx: ScopedTx, ctx: AppCtx, active: ActiveVersion | null, entries: EntryDraft[], note: string): Promise<VersionRef> {
  const last = await tx.pricingVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;
  if (active) await tx.pricingVersion.update({ where: { id: active.id }, data: { active: false } });
  const created = await tx.pricingVersion.create({
    data: {
      workspaceId: requireWorkspace(ctx),
      version,
      active: true,
      note,
      createdBy: ctx.actor?.userId ?? ctx.kind,
      createdAt: ctx.clock.now(),
      entries: { create: entries.map((e) => ({ serviceId: e.serviceId, unitPricePaise: e.unitPricePaise, minQty: e.minQty, maxQty: e.maxQty })) },
    },
    select: { id: true, version: true },
  });
  return created;
}

const carried = (active: ActiveVersion | null): EntryDraft[] => (active?.entries ?? []).map((e) => ({ serviceId: e.serviceId, ...priceOf(e) }));

const ref = (v: ActiveVersion | null): VersionRef | null => (v ? { id: v.id, version: v.version } : null);

async function loadOwnService(tx: ScopedTx, ctx: AppCtx, serviceId: string): Promise<Service> {
  await assertSameWorkspace(tx, ctx, { serviceId });
  const service = await tx.service.findFirst({ where: { id: serviceId } });
  if (!service) throw new NotFoundError();
  return service;
}

// ---- Mutations ---------------------------------------------------------------------------------

export async function createService(ctx: AppCtx, input: CreateServiceInput): Promise<{ service: CatalogService; pricingVersion: VersionRef }> {
  requireCapability(ctx, 'pricing.override');
  const metadata = validateMetadata(input) as ServiceMetadataInput;
  const price = validatePrice({ unitPricePaise: input.unitPricePaise, minQty: input.minQty, maxQty: input.maxQty });
  const code = input.code.trim().toUpperCase();

  return withTx(ctx.db, async (tx) => {
    const active = await loadActiveVersion(tx);
    assertExpectedVersion(active, input.expectedVersion);
    if ((await tx.service.count({ where: { code } })) > 0) {
      throw new ConflictError({ code: 'SERVICE_CODE_TAKEN', userMessage: `A service with code ${code} already exists (archived services keep their code).`, safeDetails: { field: 'code' } });
    }
    const service = await tx.service.create({ data: { workspaceId: requireWorkspace(ctx), code, ...metadata } });
    const pricingVersion = await publishVersion(tx, ctx, active, [...carried(active), { serviceId: service.id, ...price }], `Added ${code}`);
    await recordAudit(tx, ctx, {
      action: 'pricing.service.create',
      targetType: 'Service',
      targetId: service.id,
      summary: { code, pricingVersion: pricingVersion.version },
    });
    return { service: { ...service, price }, pricingVersion };
  });
}

const METADATA_FIELDS = ['name', 'description', 'unitLabel', 'defaultTimelineDays', 'maxDiscountBps'] as const;
const PRICE_FIELDS = ['unitPricePaise', 'minQty', 'maxQty'] as const;

export async function updateService(
  ctx: AppCtx,
  serviceId: string,
  input: UpdateServiceInput,
): Promise<{ service: CatalogService; pricingVersion: VersionRef | null; versionCreated: boolean }> {
  requireCapability(ctx, 'pricing.override');
  const metadata = validateMetadata(input);

  return withTx(ctx.db, async (tx) => {
    const service = await loadOwnService(tx, ctx, serviceId);
    const active = await loadActiveVersion(tx);
    assertExpectedVersion(active, input.expectedVersion);
    if (service.archivedAt !== null) {
      throw new ServiceNotApprovedError({ code: 'SERVICE_ARCHIVED', userMessage: 'This service is archived and can no longer be edited.' });
    }

    const changedMeta = METADATA_FIELDS.filter((f) => metadata[f] !== undefined && metadata[f] !== service[f]);
    const currentEntry = active?.entries.find((e) => e.serviceId === service.id) ?? null;
    const priceTouched = PRICE_FIELDS.some((f) => input[f] !== undefined);
    let nextPrice: PriceInput | null = currentEntry ? priceOf(currentEntry) : null;
    let changedPrice: string[] = [];
    if (priceTouched) {
      if (input.unitPricePaise === undefined && !currentEntry) {
        throw new AmountInvalidError({ userMessage: 'Set a price for this service first.', safeDetails: { field: 'unitPricePaise' } });
      }
      const candidate = validatePrice({
        unitPricePaise: input.unitPricePaise ?? currentEntry!.unitPricePaise,
        minQty: input.minQty ?? currentEntry?.minQty ?? QTY_BOUNDS.min,
        maxQty: input.maxQty ?? currentEntry?.maxQty ?? QTY_BOUNDS.max,
      });
      changedPrice = PRICE_FIELDS.filter((f) => !currentEntry || candidate[f] !== currentEntry[f]);
      nextPrice = candidate;
    }

    let updated = service;
    if (changedMeta.length > 0) {
      const data = Object.fromEntries(changedMeta.map((f) => [f, metadata[f]]));
      updated = await tx.service.update({ where: { id: service.id }, data });
    }
    let pricingVersion = ref(active);
    if (changedPrice.length > 0 && nextPrice) {
      const entries = carried(active).filter((e) => e.serviceId !== service.id);
      entries.push({ serviceId: service.id, ...nextPrice });
      pricingVersion = await publishVersion(tx, ctx, active, entries, `Changed ${service.code} (${changedPrice.join(', ')})`);
    }
    const versionCreated = pricingVersion !== null && pricingVersion.version !== (active?.version ?? 0);
    if (changedMeta.length > 0 || changedPrice.length > 0) {
      await recordAudit(tx, ctx, {
        action: 'pricing.service.update',
        targetType: 'Service',
        targetId: service.id,
        summary: { fields: [...changedMeta, ...changedPrice], pricingVersion: pricingVersion?.version ?? null, versionCreated },
      });
    }
    return {
      service: { ...updated, price: nextPrice },
      pricingVersion,
      versionCreated,
    };
  });
}

export async function archiveService(
  ctx: AppCtx,
  serviceId: string,
  input: { expectedVersion: number },
): Promise<{ outcome: 'archived' | 'deleted'; pricingVersion: VersionRef | null; versionCreated: boolean }> {
  requireCapability(ctx, 'pricing.override');
  return withTx(ctx.db, async (tx) => {
    const service = await loadOwnService(tx, ctx, serviceId);
    const active = await loadActiveVersion(tx);
    assertExpectedVersion(active, input.expectedVersion);

    const quoted = await tx.quoteItem.count({ where: { serviceId: service.id } });
    const priced = await tx.priceEntry.count({ where: { serviceId: service.id } });
    if (quoted === 0 && priced === 0) {
      await tx.service.delete({ where: { id: service.id } });
      await recordAudit(tx, ctx, { action: 'pricing.service.delete', targetType: 'Service', targetId: service.id, summary: { code: service.code } });
      return { outcome: 'deleted' as const, pricingVersion: ref(active), versionCreated: false };
    }

    if (service.archivedAt === null) {
      await tx.service.update({ where: { id: service.id }, data: { archivedAt: ctx.clock.now() } });
    }
    let pricingVersion = ref(active);
    let versionCreated = false;
    if (active?.entries.some((e) => e.serviceId === service.id)) {
      pricingVersion = await publishVersion(
        tx,
        ctx,
        active,
        carried(active).filter((e) => e.serviceId !== service.id),
        `Archived ${service.code}`,
      );
      versionCreated = true;
    }
    await recordAudit(tx, ctx, {
      action: 'pricing.service.archive',
      targetType: 'Service',
      targetId: service.id,
      summary: { code: service.code, quoteItems: quoted, pricingVersion: pricingVersion?.version ?? null, versionCreated },
    });
    return { outcome: 'archived' as const, pricingVersion, versionCreated };
  });
}

// ---- DTOs (money as decimal strings, dates as ISO, ADR-07) -----------------------------------------

const priceDto = (p: PriceInput | null) => (p ? { unitPricePaise: serializePaise(p.unitPricePaise), minQty: p.minQty, maxQty: p.maxQty } : null);

export function serializeService(s: CatalogService) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    description: s.description,
    unitLabel: s.unitLabel,
    defaultTimelineDays: s.defaultTimelineDays,
    maxDiscountBps: s.maxDiscountBps,
    archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
    price: priceDto(s.price),
  };
}

export function serializeSettings(s: PricingSettings) {
  return { ...s, updatedAt: s.updatedAt.toISOString() };
}

export function serializeOverview(o: PricingOverview) {
  return {
    workspace: o.workspace,
    canEdit: o.canEdit,
    activeVersion: o.activeVersion ? { ...o.activeVersion, createdAt: o.activeVersion.createdAt.toISOString() } : null,
    services: o.services.map(serializeService),
    settings: serializeSettings(o.settings),
    versions: o.versions.map((v) => ({
      ...v,
      createdAt: v.createdAt.toISOString(),
      entries: v.entries.map((e) => ({ ...e, unitPricePaise: serializePaise(e.unitPricePaise) })),
    })),
  };
}

export type PricingOverviewDto = ReturnType<typeof serializeOverview>;
export type CatalogServiceDto = ReturnType<typeof serializeService>;
export type PricingSettingsDto = ReturnType<typeof serializeSettings>;
