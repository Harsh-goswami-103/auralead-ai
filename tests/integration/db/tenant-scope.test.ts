/**
 * T03 / E10: the scoped client injects workspaceId on tenant models, refuses tenant access without
 * a workspace, hides other tenants' rows, `assertSameWorkspace` rejects foreign ids, and the
 * composite foreign keys reject cross-workspace child rows at the database level.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { assertSameWorkspace, scopeDb, TenantScopeError } from '@/server/db/scoped';
import { withTx } from '@/server/db/tx';
import { createTestDb, type TestDb } from '../../support/db';
import { T0, createTenantGraph, expectForeignKeyViolation, type TenantGraph } from './fixtures';

let testDb: TestDb;
let db: PrismaClient;
let a: TenantGraph;
let b: TenantGraph;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'tenant-scope' });
  db = testDb.client();
  a = await createTenantGraph(db, 'alpha');
  b = await createTenantGraph(db, 'beta');
});

afterAll(async () => {
  await testDb?.destroy();
});

describe('scopeDb(workspaceId)', () => {
  it('filters reads to the scoped workspace', async () => {
    const scoped = scopeDb(db, a.workspaceId);
    const leads = await scoped.lead.findMany();
    expect(leads.map((l) => l.id)).toEqual([a.leadId]);
    expect(await scoped.quote.count()).toBe(1);
    const grouped = await scoped.service.groupBy({ by: ['workspaceId'], _count: { _all: true } });
    expect(grouped).toEqual([{ workspaceId: a.workspaceId, _count: { _all: 1 } }]);
  });

  it('returns null for another tenant id, even by primary key', async () => {
    const scoped = scopeDb(db, a.workspaceId);
    expect(await scoped.lead.findUnique({ where: { id: b.leadId } })).toBeNull();
    expect(await scoped.quote.findFirst({ where: { id: b.quoteId } })).toBeNull();
    await expect(scoped.lead.findUniqueOrThrow({ where: { id: b.leadId } })).rejects.toThrow();
    expect(await scoped.lead.findUnique({ where: { id: a.leadId } })).not.toBeNull();
  });

  it('cannot update or delete another tenant row', async () => {
    const scoped = scopeDb(db, a.workspaceId);
    const res = await scoped.lead.updateMany({ where: { id: b.leadId }, data: { city: 'Hijacked' } });
    expect(res.count).toBe(0);
    await expect(scoped.lead.update({ where: { id: b.leadId }, data: { city: 'Hijacked' } })).rejects.toThrow();
    const del = await scoped.leadContactKey.deleteMany({ where: {} });
    expect(del.count).toBe(0);
    const theirs = await db.lead.findUniqueOrThrow({ where: { id: b.leadId } });
    expect(theirs.city).toBeNull();
  });

  it('injects workspaceId on create', async () => {
    const scoped = scopeDb(db, a.workspaceId);
    const service = await scoped.service.create({
      // workspaceId is supplied by the scoped client.
      data: { code: 'SEO', name: 'SEO', description: 'Search', unitLabel: 'month' } as never,
    });
    expect(service.workspaceId).toBe(a.workspaceId);
    const many = await scoped.leadContactKey.createMany({
      data: [{ leadId: a.leadId, kind: 'EMAIL', value: 'owner@alpha.test' }] as never,
    });
    expect(many.count).toBe(1);
    expect((await db.leadContactKey.findFirstOrThrow({ where: { value: 'owner@alpha.test' } })).workspaceId).toBe(a.workspaceId);
  });

  it('rejects an explicit foreign workspaceId in where or data', async () => {
    const scoped = scopeDb(db, a.workspaceId);
    await expect(scoped.lead.findMany({ where: { workspaceId: b.workspaceId } })).rejects.toBeInstanceOf(TenantScopeError);
    await expect(
      scoped.service.create({ data: { workspaceId: b.workspaceId, code: 'X', name: 'X', description: 'X', unitLabel: 'x' } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    await expect(
      scoped.lead.update({ where: { id: a.leadId }, data: { workspaceId: b.workspaceId } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('keeps scoping inside interactive transactions', async () => {
    const scoped = scopeDb(db, a.workspaceId);
    const ids = await scoped.$transaction(async (tx) => (await tx.lead.findMany({ select: { id: true } })).map((l) => l.id));
    expect(ids).toEqual([a.leadId]);
    const viaWithTx = await withTx(scoped, async (tx) => {
      await assertSameWorkspace(tx, { workspaceId: a.workspaceId }, { leadId: a.leadId });
      return tx.lead.findUnique({ where: { id: b.leadId } });
    });
    expect(viaWithTx).toBeNull();
  });

  it('leaves identity models unscoped', async () => {
    const scoped = scopeDb(db, a.workspaceId);
    expect(await scoped.workspace.count()).toBe(2);
  });
});

describe('scopeDb(null)', () => {
  it('throws on any tenant model access without a workspace', async () => {
    const unscoped = scopeDb(db, null);
    await expect(unscoped.lead.findMany()).rejects.toBeInstanceOf(TenantScopeError);
    await expect(unscoped.quote.findUnique({ where: { id: a.quoteId } })).rejects.toBeInstanceOf(TenantScopeError);
    await expect(unscoped.priceEntry.count()).rejects.toBeInstanceOf(TenantScopeError);
    await expect(
      unscoped.service.create({ data: { workspaceId: a.workspaceId, code: 'Y', name: 'Y', description: 'Y', unitLabel: 'y' } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('still allows identity models', async () => {
    const unscoped = scopeDb(db, null);
    expect(await unscoped.workspace.count()).toBe(2);
    expect(await unscoped.systemSetting.count()).toBe(0);
  });
});

describe('assertSameWorkspace', () => {
  const ctxA = () => ({ workspaceId: a.workspaceId });

  it('passes for ids owned by the context workspace', async () => {
    await expect(
      assertSameWorkspace(db, ctxA(), {
        serviceId: a.serviceId,
        quoteId: a.quoteId,
        leadId: a.leadId,
        conversationId: a.conversationId,
        templateId: a.templateId,
        pricingVersionId: a.pricingVersionId,
        quoteVersionId: a.quoteVersionId,
        messageId: a.messageId,
        integrationId: a.integrationId,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['serviceId', () => ({ serviceId: b.serviceId })],
    ['quoteId', () => ({ quoteId: b.quoteId })],
    ['leadId', () => ({ leadId: b.leadId })],
    ['conversationId', () => ({ conversationId: b.conversationId })],
    ['templateId', () => ({ templateId: b.templateId })],
    ['pricingVersionId', () => ({ pricingVersionId: b.pricingVersionId })],
  ] as const)('rejects a foreign %s with a 404 TenantScopeError', async (key, refs) => {
    const err = await assertSameWorkspace(db, ctxA(), refs()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TenantScopeError);
    expect((err as TenantScopeError).status).toBe(404);
    expect((err as TenantScopeError).refs).toEqual([key]);
  });

  it('rejects a foreign id hidden among own ids in a list, and an unknown id', async () => {
    await expect(assertSameWorkspace(db, ctxA(), { serviceId: [a.serviceId, b.serviceId] })).rejects.toBeInstanceOf(TenantScopeError);
    await expect(assertSameWorkspace(db, ctxA(), { leadId: 'does-not-exist' })).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('ignores absent refs and rejects a context without a workspace', async () => {
    await expect(assertSameWorkspace(db, ctxA(), { leadId: null, quoteId: undefined })).resolves.toBeUndefined();
    await expect(assertSameWorkspace(db, { workspaceId: null }, { leadId: a.leadId })).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('works inside a transaction', async () => {
    await expect(
      db.$transaction(async (tx) => assertSameWorkspace(tx, ctxA(), { serviceId: b.serviceId })),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });
});

describe('composite foreign keys', () => {
  it('reject a PriceEntry pointing at another workspace service or pricing version', async () => {
    const pv = await db.pricingVersion.create({ data: { workspaceId: a.workspaceId, version: 9, note: 'x', createdBy: 't' } });
    await expectForeignKeyViolation(
      db.priceEntry.create({ data: { workspaceId: a.workspaceId, pricingVersionId: pv.id, serviceId: b.serviceId, unitPricePaise: 100n } }),
    );
    await expectForeignKeyViolation(
      db.priceEntry.create({ data: { workspaceId: a.workspaceId, pricingVersionId: b.pricingVersionId, serviceId: a.serviceId, unitPricePaise: 100n } }),
    );
    await db.priceEntry.create({ data: { workspaceId: a.workspaceId, pricingVersionId: pv.id, serviceId: a.serviceId, unitPricePaise: 100n } });
  });

  it('reject a QuoteItem pointing at another workspace service or quote version', async () => {
    const item = { serviceNameSnapshot: 'Website', unitLabel: 'site', qty: 1, unitPricePaise: 100n, lineTotalPaise: 100n };
    await expectForeignKeyViolation(
      db.quoteItem.create({ data: { ...item, workspaceId: a.workspaceId, quoteVersionId: a.quoteVersionId, serviceId: b.serviceId, position: 1 } }),
    );
    await expectForeignKeyViolation(
      db.quoteItem.create({ data: { ...item, workspaceId: a.workspaceId, quoteVersionId: b.quoteVersionId, serviceId: a.serviceId, position: 1 } }),
    );
    await db.quoteItem.create({ data: { ...item, workspaceId: a.workspaceId, quoteVersionId: a.quoteVersionId, serviceId: a.serviceId, position: 1 } });
  });

  it('reject a Quote, Conversation or DispatchAttempt that crosses workspaces', async () => {
    await expectForeignKeyViolation(db.quote.create({ data: { workspaceId: a.workspaceId, leadId: b.leadId, number: 'Q-0099', createdBy: 't', createdAt: T0 } }));
    await expectForeignKeyViolation(
      db.conversation.create({ data: { workspaceId: a.workspaceId, leadId: b.leadId, channel: 'EMAIL', contactKey: 'x' } }),
    );
    await expectForeignKeyViolation(db.quote.update({ where: { id: a.quoteId }, data: { currentVersionId: b.quoteVersionId } }));
  });
});
