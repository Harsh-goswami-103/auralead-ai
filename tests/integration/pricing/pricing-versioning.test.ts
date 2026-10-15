/**
 * T13 (R31, 04-tests U5): the pricing catalog through the real /api/app/pricing route handlers.
 *  - Every change to the price list publishes PricingVersion N+1 (one active row; history kept,
 *    earlier entries untouched); metadata-only edits update the service in place.
 *  - Deleting a referenced service archives it (and drops it from the next version); an
 *    unreferenced one is removed.
 *  - A negative price is 422 and changes nothing; a stale expectedVersion is 409.
 *  - Settings: explicit tax mode, limits and GSTIN format are validated (422) and audited.
 *  - A member reads but cannot change pricing (403); workspace B's service is 404.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { GET as getOverview } from '@/app/api/app/pricing/route';
import { POST as createServiceRoute } from '@/app/api/app/pricing/services/route';
import { POST as updateServiceRoute } from '@/app/api/app/pricing/services/[serviceId]/route';
import { POST as archiveServiceRoute } from '@/app/api/app/pricing/services/[serviceId]/archive/route';
import { POST as settingsRoute } from '@/app/api/app/pricing/settings/route';
import { createTestDb, type TestDb } from '../../support/db';
import { NOW, seedIdentities, testConfig, uninstallRuntime, useRuntime, type Identity, type TestRuntime } from '../auth/support';
import { call, createIssuedQuote, signIn, type SignedIn } from './support';

let testDb: TestDb;
let db: PrismaClient;
let ids: Identity;
let runtime: TestRuntime;
let owner: SignedIn;
let member: SignedIn;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'pricing-versioning' });
  db = testDb.client();
  ids = await seedIdentities(db, 'LIVE');
  runtime = useRuntime(db, testConfig('live'), new FixedClock(NOW));
  owner = await signIn(db, runtime, ids.ownerId, 'USER');
  member = await signIn(db, runtime, ids.memberId, 'USER');
});

afterAll(async () => {
  uninstallRuntime();
  await testDb?.destroy();
});

beforeEach(() => {
  runtime.clock.advance(60_000);
});

const activeVersion = async (workspaceId: string) => db.pricingVersion.findFirst({ where: { workspaceId, active: true }, include: { entries: true } });
const versionCount = async (workspaceId: string) => db.pricingVersion.count({ where: { workspaceId } });
const currentVersionNo = async () => (await activeVersion(ids.workspaceAId))?.version ?? 0;

const newService = (code: string, rupees: bigint, extra: Record<string, unknown> = {}) => ({
  code,
  name: `Service ${code}`,
  description: `Description for ${code}`,
  unitLabel: 'unit',
  defaultTimelineDays: 14,
  maxDiscountBps: null,
  unitPricePaise: (rupees * 100n).toString(),
  minQty: 1,
  maxQty: 50,
  ...extra,
});

async function create(code: string, rupees: bigint, extra: Record<string, unknown> = {}) {
  const res = await call(createServiceRoute, '/api/app/pricing/services', owner, { body: { ...newService(code, rupees, extra), expectedVersion: await currentVersionNo() } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { service: { id: string }; pricingVersion: { id: string; version: number } };
}

describe('catalog versioning', () => {
  it('creating the first service publishes v1 with its entry', async () => {
    expect(await versionCount(ids.workspaceAId)).toBe(0);
    const created = await create('WEB', 25_000n);
    expect(created.pricingVersion.version).toBe(1);
    const v1 = await activeVersion(ids.workspaceAId);
    expect(v1?.version).toBe(1);
    expect(v1?.createdBy).toBe(ids.ownerId);
    expect(v1?.entries).toHaveLength(1);
    expect(v1?.entries[0]).toMatchObject({ serviceId: created.service.id, unitPricePaise: 2_500_000n, minQty: 1, maxQty: 50 });
    const audit = await db.auditEvent.findFirst({ where: { action: 'pricing.service.create', targetId: created.service.id } });
    expect(audit?.result).toBe('SUCCESS');
    expect(audit?.actorUserId).toBe(ids.ownerId);
  });

  it('editing a price creates version N+1; version N and its entries stay unchanged; one active version', async () => {
    const seo = await create('SEO', 8_000n);
    const before = await activeVersion(ids.workspaceAId);
    const n = before!.version;
    const res = await call(updateServiceRoute, `/api/app/pricing/services/${seo.service.id}`, owner, {
      params: { serviceId: seo.service.id },
      body: { unitPricePaise: '950000', expectedVersion: n },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ versionCreated: true, pricingVersion: { version: n + 1 } });

    const after = await activeVersion(ids.workspaceAId);
    expect(after?.version).toBe(n + 1);
    expect(after?.entries.find((e) => e.serviceId === seo.service.id)?.unitPricePaise).toBe(950_000n);
    // The other service is carried into the new version unchanged.
    expect(after?.entries).toHaveLength(before!.entries.length);

    const old = await db.pricingVersion.findFirst({ where: { workspaceId: ids.workspaceAId, version: n }, include: { entries: true } });
    expect(old?.active).toBe(false);
    expect(old?.entries.find((e) => e.serviceId === seo.service.id)?.unitPricePaise).toBe(800_000n);
    expect(await db.pricingVersion.count({ where: { workspaceId: ids.workspaceAId, active: true } })).toBe(1);
  });

  it('a metadata-only edit updates the service in place without a new version', async () => {
    const svc = await db.service.findFirstOrThrow({ where: { workspaceId: ids.workspaceAId, code: 'WEB' } });
    const n = await currentVersionNo();
    const count = await versionCount(ids.workspaceAId);
    const res = await call(updateServiceRoute, `/api/app/pricing/services/${svc.id}`, owner, {
      params: { serviceId: svc.id },
      body: { name: 'Business website', defaultTimelineDays: 21, maxDiscountBps: 1000, expectedVersion: n },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ versionCreated: false, pricingVersion: { version: n } });
    expect(await versionCount(ids.workspaceAId)).toBe(count);
    const updated = await db.service.findUniqueOrThrow({ where: { id: svc.id } });
    expect(updated).toMatchObject({ name: 'Business website', defaultTimelineDays: 21, maxDiscountBps: 1000 });
    const audit = await db.auditEvent.findFirst({ where: { action: 'pricing.service.update', targetId: svc.id }, orderBy: { createdAt: 'desc' } });
    expect(audit?.summary).toMatchObject({ fields: ['name', 'defaultTimelineDays', 'maxDiscountBps'] });
  });

  it('a negative price is 422 and changes nothing', async () => {
    const svc = await db.service.findFirstOrThrow({ where: { workspaceId: ids.workspaceAId, code: 'WEB' } });
    const count = await versionCount(ids.workspaceAId);
    const edit = await call(updateServiceRoute, `/api/app/pricing/services/${svc.id}`, owner, {
      params: { serviceId: svc.id },
      body: { unitPricePaise: '-100', expectedVersion: await currentVersionNo() },
    });
    expect(edit.status).toBe(422);
    expect(edit.body.code).toBe('AMOUNT_INVALID');
    const add = await call(createServiceRoute, '/api/app/pricing/services', owner, { body: { ...newService('NEG', 1n), unitPricePaise: '-1', expectedVersion: await currentVersionNo() } });
    expect(add.status).toBe(422);
    expect(await versionCount(ids.workspaceAId)).toBe(count);
    expect(await db.service.count({ where: { workspaceId: ids.workspaceAId, code: 'NEG' } })).toBe(0);
  });

  it('out-of-range quantities and discount caps are 422', async () => {
    const n = await currentVersionNo();
    for (const extra of [{ minQty: 0 }, { minQty: 5, maxQty: 4 }, { maxQty: 10_001 }, { maxDiscountBps: 10_001 }, { maxDiscountBps: -1 }, { defaultTimelineDays: 0 }]) {
      const res = await call(createServiceRoute, '/api/app/pricing/services', owner, { body: { ...newService('BAD', 10n, extra), expectedVersion: n } });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
  });

  it('a duplicate code is 409', async () => {
    const res = await call(createServiceRoute, '/api/app/pricing/services', owner, { body: { ...newService('WEB', 10n), expectedVersion: await currentVersionNo() } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVICE_CODE_TAKEN');
  });

  it('a stale expectedVersion is 409 and publishes nothing', async () => {
    const svc = await db.service.findFirstOrThrow({ where: { workspaceId: ids.workspaceAId, code: 'WEB' } });
    const n = await currentVersionNo();
    const res = await call(updateServiceRoute, `/api/app/pricing/services/${svc.id}`, owner, {
      params: { serviceId: svc.id },
      body: { unitPricePaise: '123400', expectedVersion: n - 1 },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRICING_VERSION_CONFLICT');
    expect(await currentVersionNo()).toBe(n);
  });

  it('deleting a service used by an issued quote archives it, drops it from version N+1 and leaves the quote item untouched', async () => {
    const used = await create('LOGO', 5_000n);
    const issued = await createIssuedQuote(db, ids.workspaceAId, used.pricingVersion.id, used.service.id, 500_000n);
    const n = await currentVersionNo();
    const res = await call(archiveServiceRoute, `/api/app/pricing/services/${used.service.id}/archive`, owner, {
      params: { serviceId: used.service.id },
      body: { expectedVersion: n },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'archived', versionCreated: true, pricingVersion: { version: n + 1 } });
    const svc = await db.service.findUniqueOrThrow({ where: { id: used.service.id } });
    expect(svc.archivedAt).toEqual(runtime.clock.now());
    const active = await activeVersion(ids.workspaceAId);
    expect(active?.entries.some((e) => e.serviceId === used.service.id)).toBe(false);
    const item = await db.quoteItem.findUniqueOrThrow({ where: { id: issued.quoteItemId } });
    expect(item).toMatchObject({ serviceId: used.service.id, unitPricePaise: 500_000n, serviceNameSnapshot: 'Snapshot name' });
    expect(await db.auditEvent.count({ where: { action: 'pricing.service.archive', targetId: used.service.id } })).toBe(1);
  });

  it('a service that was ever priced is archived too (its history stays readable)', async () => {
    const priced = await create('PRINT', 1_500n);
    const res = await call(archiveServiceRoute, `/api/app/pricing/services/${priced.service.id}/archive`, owner, {
      params: { serviceId: priced.service.id },
      body: { expectedVersion: await currentVersionNo() },
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('archived');
    const old = await db.priceEntry.count({ where: { serviceId: priced.service.id } });
    expect(old).toBeGreaterThan(0);
  });

  it('an unreferenced service (never priced, never quoted) is deleted without a new version', async () => {
    const bare = await db.service.create({ data: { workspaceId: ids.workspaceAId, code: 'BARE', name: 'Bare', description: '', unitLabel: 'unit' } });
    const count = await versionCount(ids.workspaceAId);
    const res = await call(archiveServiceRoute, `/api/app/pricing/services/${bare.id}/archive`, owner, {
      params: { serviceId: bare.id },
      body: { expectedVersion: await currentVersionNo() },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'deleted', versionCreated: false });
    expect(await db.service.count({ where: { id: bare.id } })).toBe(0);
    expect(await versionCount(ids.workspaceAId)).toBe(count);
    expect(await db.auditEvent.count({ where: { action: 'pricing.service.delete', targetId: bare.id } })).toBe(1);
  });

  it('an archived service cannot be edited (422)', async () => {
    const archived = await db.service.findFirstOrThrow({ where: { workspaceId: ids.workspaceAId, code: 'LOGO' } });
    const res = await call(updateServiceRoute, `/api/app/pricing/services/${archived.id}`, owner, {
      params: { serviceId: archived.id },
      body: { unitPricePaise: '100', expectedVersion: await currentVersionNo() },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SERVICE_ARCHIVED');
  });

  it('the overview lists active and archived services, the active version and the history (money as strings)', async () => {
    const res = await call(getOverview, '/api/app/pricing', owner, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = res.body as {
      canEdit: boolean;
      activeVersion: { version: number };
      services: Array<{ code: string; archivedAt: string | null; price: { unitPricePaise: string } | null }>;
      versions: Array<{ version: number; active: boolean; entries: unknown[] }>;
      settings: { maxDiscountBps: number; taxMode: string };
    };
    expect(body.canEdit).toBe(true);
    expect(body.activeVersion.version).toBe(await currentVersionNo());
    const web = body.services.find((s) => s.code === 'WEB')!;
    expect(web.price?.unitPricePaise).toBe('2500000');
    expect(body.services.find((s) => s.code === 'LOGO')?.archivedAt).not.toBeNull();
    expect(body.services.find((s) => s.code === 'LOGO')?.price).toBeNull();
    expect(body.versions[0]?.active).toBe(true);
    expect(body.versions.map((v) => v.version)).toEqual([...body.versions.map((v) => v.version)].sort((a, b) => b - a));
    expect(body.settings).toMatchObject({ maxDiscountBps: 1500, taxMode: 'NONE' });
  });
});

describe('pricing settings', () => {
  it('CONFIGURED tax needs a rate and a label (422); NONE clears them', async () => {
    const missing = await call(settingsRoute, '/api/app/pricing/settings', owner, { body: { taxMode: 'CONFIGURED' } });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('TAX_NOT_CONFIGURED');

    const ok = await call(settingsRoute, '/api/app/pricing/settings', owner, { body: { taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.settings).toMatchObject({ taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800 });
    let row = await db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: ids.workspaceAId } });
    expect(row).toMatchObject({ taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800, updatedBy: ids.ownerId });

    const none = await call(settingsRoute, '/api/app/pricing/settings', owner, { body: { taxMode: 'NONE' } });
    expect(none.status).toBe(200);
    row = await db.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: ids.workspaceAId } });
    expect(row).toMatchObject({ taxMode: 'NONE', taxLabel: null, taxBps: null });
    const audits = await db.auditEvent.findMany({ where: { action: 'pricing.settings.update', workspaceId: ids.workspaceAId } });
    expect(audits).toHaveLength(2);
  });

  it('rejects out-of-range limits, validity and a malformed GSTIN (422)', async () => {
    for (const body of [
      { maxDiscountBps: 10_001 },
      { maxDiscountBps: -1 },
      { quoteValidityDays: 0 },
      { quoteValidityDays: 366 },
      { taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 10_001 },
      { taxMode: 'CONFIGURED', taxLabel: '   ', taxBps: 1800 },
      { gstin: '07AAAAA0000A1Z' },
    ]) {
      const res = await call(settingsRoute, '/api/app/pricing/settings', owner, { body });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('saves discount limit, validity and a well-formed GSTIN', async () => {
    const res = await call(settingsRoute, '/api/app/pricing/settings', owner, { body: { maxDiscountBps: 1200, quoteValidityDays: 30, gstin: '07aaacr5055k1z5' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.settings).toMatchObject({ maxDiscountBps: 1200, quoteValidityDays: 30, gstin: '07AAACR5055K1Z5' });
  });

  it('an empty settings body is 400', async () => {
    const res = await call(settingsRoute, '/api/app/pricing/settings', owner, { body: {} });
    expect(res.status).toBe(400);
  });
});

describe('access', () => {
  it('a member reads the overview but cannot change pricing (403)', async () => {
    const read = await call(getOverview, '/api/app/pricing', member, { method: 'GET' });
    expect(read.status).toBe(200);
    expect((read.body as { canEdit: boolean }).canEdit).toBe(false);
    const svc = await db.service.findFirstOrThrow({ where: { workspaceId: ids.workspaceAId, code: 'WEB' } });
    const n = await currentVersionNo();
    const attempts = [
      await call(createServiceRoute, '/api/app/pricing/services', member, { body: { ...newService('MEM', 10n), expectedVersion: n } }),
      await call(updateServiceRoute, `/api/app/pricing/services/${svc.id}`, member, { params: { serviceId: svc.id }, body: { unitPricePaise: '1', expectedVersion: n } }),
      await call(archiveServiceRoute, `/api/app/pricing/services/${svc.id}/archive`, member, { params: { serviceId: svc.id }, body: { expectedVersion: n } }),
      await call(settingsRoute, '/api/app/pricing/settings', member, { body: { maxDiscountBps: 100 } }),
    ];
    expect(attempts.map((a) => a.status)).toEqual([403, 403, 403, 403]);
    expect(await currentVersionNo()).toBe(n);
  });

  it("workspace B's service is 404 for the owner of A, and B's catalog is untouched", async () => {
    const foreign = await db.service.create({ data: { workspaceId: ids.workspaceBId, code: 'B-SVC', name: 'Beta service', description: '', unitLabel: 'unit' } });
    const update = await call(updateServiceRoute, `/api/app/pricing/services/${foreign.id}`, owner, {
      params: { serviceId: foreign.id },
      body: { name: 'Hijacked', expectedVersion: await currentVersionNo() },
    });
    expect(update.status).toBe(404);
    const archive = await call(archiveServiceRoute, `/api/app/pricing/services/${foreign.id}/archive`, owner, {
      params: { serviceId: foreign.id },
      body: { expectedVersion: await currentVersionNo() },
    });
    expect(archive.status).toBe(404);
    expect(await db.service.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({ name: 'Beta service', archivedAt: null });
  });

  it('employees and anonymous callers get 404 / 401', async () => {
    const employee = await signIn(db, runtime, ids.employeeId, 'EMPLOYEE', ids.workspaceAId);
    expect((await call(getOverview, '/api/app/pricing', employee, { method: 'GET' })).status).toBe(404);
    expect((await call(getOverview, '/api/app/pricing', null, { method: 'GET' })).status).toBe(401);
  });
});
