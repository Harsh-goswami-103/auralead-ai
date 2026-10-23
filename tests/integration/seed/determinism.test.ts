/**
 * R43 / P20 (T09): the demo seed is deterministic, covers the PRD fixture list (fictitious Indian
 * businesses in Delhi NCR, Mumbai and Bengaluru: clinic, gym, property agency, e-commerce,
 * freelancer), refuses LIVE targets, resets to the identical content, and `demo:refresh`
 * re-bases fixture times without changing any id. ADR-126: the sixth, presentation workspace
 * (codecraft-web) and its fourth persona are part of the same content; the pepper that keys its
 * consent and chat rows changes those two tables only.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { isCapability } from '@/lib/domain/enums';
import { DEMO_PERSONAS, SeedTargetError } from '@/server/auth/demo-personas';
import { contentHash } from '../../../prisma/seed/content-hash';
import { REQUIRED_CATEGORIES, REQUIRED_CITIES, WORKSPACE_FIXTURES } from '../../../prisma/seed/fixtures/workspaces';
import { seedId } from '../../../prisma/seed/ids';
import { AlreadySeededError, resetAndSeedDemo, seedDemo } from '../../../prisma/seed/seed';
import { refreshDemo } from '../../../scripts/demo-refresh';
import { createTestDb, type TestDb } from '../../support/db';
import { REPO_ROOT, spawnTsx, terminateAll } from '../../support/spawn';
import { testEnv } from '../auth/support';

const T0 = new Date('2026-10-15T04:30:00.000Z');
const DEMO = { mode: 'demo' as const };
const DAY = 86_400_000;

const dbs: TestDb[] = [];
async function freshDb(label: string): Promise<{ db: TestDb; client: PrismaClient }> {
  const db = await createTestDb({ label });
  dbs.push(db);
  return { db, client: db.client() };
}

afterAll(async () => {
  await terminateAll();
  for (const db of dbs) await db.destroy();
});

describe('demo seed determinism', () => {
  let a: PrismaClient;
  let b: PrismaClient;

  beforeAll(async () => {
    a = (await freshDb('seed-a')).client;
    b = (await freshDb('seed-b')).client;
    await seedDemo(a, { config: DEMO, now: T0 });
    await seedDemo(b, { config: DEMO, now: T0 });
  });

  it('gives the identical content hash for two seeds with the same SEED_NOW', async () => {
    const [ha, hb] = await Promise.all([contentHash(a), contentHash(b)]);
    expect(ha.rows).toBeGreaterThan(50);
    expect(ha.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hb).toEqual(ha);
  });

  it('uses SEED_NOW for every timestamp (a different SEED_NOW changes the hash)', async () => {
    const { client } = await freshDb('seed-c');
    await seedDemo(client, { config: DEMO, now: new Date(T0.getTime() + DAY) });
    expect((await contentHash(client)).hash).not.toBe((await contentHash(a)).hash);
    const ws = await a.workspace.findMany({ select: { createdAt: true } });
    for (const w of ws) expect(w.createdAt.getTime()).toBeLessThanOrEqual(T0.getTime());
  });

  it('covers the required fixture list (cities, categories, Indian businesses)', async () => {
    const cities = new Set(WORKSPACE_FIXTURES.map((w) => w.city));
    const categories = new Set(WORKSPACE_FIXTURES.map((w) => w.category));
    for (const c of REQUIRED_CITIES) expect(cities).toContain(c);
    for (const c of REQUIRED_CATEGORIES) expect(categories).toContain(c);

    const rows = await a.workspace.findMany({ include: { settings: true }, orderBy: { slug: 'asc' } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.map((r) => r.slug).sort()).toEqual(WORKSPACE_FIXTURES.map((w) => w.slug).sort());
    for (const fixture of WORKSPACE_FIXTURES) {
      const row = rows.find((r) => r.slug === fixture.slug)!;
      expect(row.id).toBe(seedId('workspace', fixture.slug));
      expect(row.mode).toBe('DEMO');
      expect(row.timezone).toBe('Asia/Kolkata');
      expect(row.settings).not.toBeNull();
      expect(row.settings!.currencyDisplay).toBe('INR');
      // The business's locality and city are on its quotation terms (jurisdiction line).
      expect(row.settings!.termsText).toContain(fixture.city);
    }
  });

  it('seeds services, pricing v1, scoring v1 and pipeline v1 for every workspace', async () => {
    for (const fixture of WORKSPACE_FIXTURES) {
      const workspaceId = seedId('workspace', fixture.slug);
      const services = await a.service.findMany({ where: { workspaceId } });
      expect(services.length).toBe(fixture.services.length);
      expect(services.length).toBeGreaterThanOrEqual(3);

      const pricing = await a.pricingVersion.findMany({ where: { workspaceId }, include: { entries: true } });
      expect(pricing).toHaveLength(1);
      expect(pricing[0]).toMatchObject({ version: 1, active: true });
      expect(pricing[0]!.entries.map((e) => e.serviceId).sort()).toEqual(services.map((s) => s.id).sort());
      for (const entry of pricing[0]!.entries) {
        expect(typeof entry.unitPricePaise).toBe('bigint');
        expect(entry.unitPricePaise).toBeGreaterThan(0n);
        expect(entry.unitPricePaise % 100n).toBe(0n);
      }

      const scoring = await a.scoringConfigVersion.findMany({ where: { workspaceId } });
      expect(scoring).toHaveLength(1);
      expect(scoring[0]).toMatchObject({ version: 1, active: true });
      const weights = (scoring[0]!.weights as { weights: Record<string, number> }).weights;
      expect(Object.values(weights).reduce((s, v) => s + v, 0)).toBe(100);

      const pipeline = await a.pipelineConfigVersion.findMany({ where: { workspaceId } });
      expect(pipeline).toHaveLength(1);
      expect(pipeline[0]).toMatchObject({ version: 1, active: true, approvalMode: 'HUMAN' });
      const graph = pipeline[0]!.graph as { stages: Array<{ kind: string }> };
      expect(graph.stages.map((s) => s.kind)).toEqual(['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL', 'DELIVERY']);
    }
  });

  it('seeds the exact demo personas, memberships and assignments', async () => {
    for (const persona of Object.values(DEMO_PERSONAS)) {
      const user = await a.user.findUnique({ where: { email: persona.email } });
      expect(user).toMatchObject({ isDemo: true, status: 'ACTIVE', globalRole: persona.globalRole });
    }
    const owner = await a.user.findUniqueOrThrow({ where: { email: DEMO_PERSONAS.user.email }, include: { memberships: true } });
    expect(owner.memberships.some((m) => m.role === 'OWNER')).toBe(true);
    // ADR-126: the client persona owns the presentation workspace only.
    const client = await a.user.findUniqueOrThrow({ where: { email: DEMO_PERSONAS.client.email }, include: { memberships: true } });
    expect(client.memberships.map((m) => [m.workspaceId, m.role])).toEqual([[seedId('workspace', 'codecraft-web'), 'OWNER']]);
    const employee = await a.user.findUniqueOrThrow({ where: { email: DEMO_PERSONAS.employee.email }, include: { employeeAssignments: true } });
    const active = employee.employeeAssignments.filter((x) => x.active);
    expect(active.length).toBeGreaterThanOrEqual(2);
    for (const assignment of employee.employeeAssignments) {
      const caps = assignment.capabilities as unknown[];
      expect(Array.isArray(caps)).toBe(true);
      for (const c of caps) expect(isCapability(c)).toBe(true);
    }

    const users = await a.user.findMany();
    for (const u of users) {
      expect(u.isDemo).toBe(true);
      expect(u.passwordHash).toBeNull();
      // Non-deliverable fixture contacts only (RFC 2606 reserved TLD).
      expect(u.email).toMatch(/\.test$/);
    }
    // Every workspace has an owner; at least one employee has no assignment and one has a narrow one.
    for (const fixture of WORKSPACE_FIXTURES) {
      const owners = await a.membership.count({ where: { workspaceId: seedId('workspace', fixture.slug), role: 'OWNER' } });
      expect(owners).toBe(1);
    }
    const employees = await a.user.findMany({ where: { globalRole: 'EMPLOYEE' }, include: { employeeAssignments: true } });
    expect(employees.some((e) => e.employeeAssignments.length === 0)).toBe(true);
    expect(await a.systemSetting.findUnique({ where: { id: 1 } })).toMatchObject({ outboundPaused: false });
    expect(await a.testClock.findUnique({ where: { id: 1 } })).toMatchObject({ offsetMs: 0n, frozenAt: null });
    const audit = await a.auditEvent.findMany({ where: { action: 'demo.seed' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'SYSTEM', simulated: true, createdAt: T0 });
  });

  it('keys the presentation consents and chats with the configured pepper, and nothing else changes with it', async () => {
    const { client } = await freshDb('seed-pepper');
    await seedDemo(client, { config: { ...DEMO, secrets: { suppressionPepper: `determinism-pepper-${'q'.repeat(32)}` } }, now: T0 });
    const [withPepper, standIn] = await Promise.all([contentHash(client), contentHash(a)]);
    expect(withPepper.rows).toBe(standIn.rows);
    expect(withPepper.hash).not.toBe(standIn.hash);
    const differing: string[] = [];
    for (const table of Object.keys(standIn.tables)) {
      const only = { excludeTables: Object.keys(standIn.tables).filter((x) => x !== table) };
      if ((await contentHash(client, only)).hash !== (await contentHash(a, only)).hash) differing.push(table);
    }
    expect(differing.sort()).toEqual(['ConsentRecord', 'Conversation']);
  });

  it('refuses to seed an already seeded database (reset is explicit)', async () => {
    const before = await contentHash(a);
    await expect(seedDemo(a, { config: DEMO, now: T0 })).rejects.toBeInstanceOf(AlreadySeededError);
    expect(await contentHash(a)).toEqual(before);
  });
});

describe('demo seed refusals and reset', () => {
  it('refuses LIVE mode and leaves the database empty', async () => {
    const { client } = await freshDb('seed-live');
    await expect(seedDemo(client, { config: { mode: 'live' }, now: T0 })).rejects.toBeInstanceOf(SeedTargetError);
    await expect(resetAndSeedDemo(client, { config: { mode: 'live' }, now: T0 })).rejects.toBeInstanceOf(SeedTargetError);
    expect(await client.workspace.count()).toBe(0);
    expect(await client.user.count()).toBe(0);
  });

  it('refuses (and does not wipe) a database that holds LIVE data', async () => {
    const { client } = await freshDb('seed-livedata');
    await client.workspace.create({ data: { slug: 'real-co', name: 'Real Co', mode: 'LIVE', planLabel: 'Pro' } });
    await client.user.create({ data: { email: 'someone@real.test', name: 'Someone', globalRole: 'USER' } });
    await expect(resetAndSeedDemo(client, { config: DEMO, now: T0 })).rejects.toBeInstanceOf(SeedTargetError);
    expect(await client.workspace.count()).toBe(1);
    expect(await client.user.count()).toBe(1);
  });

  it('reset restores the exact seeded content after edits and extra rows', async () => {
    const { client } = await freshDb('seed-reset');
    await seedDemo(client, { config: DEMO, now: T0 });
    const original = await contentHash(client);

    const wsId = seedId('workspace', WORKSPACE_FIXTURES[0]!.slug);
    await client.workspace.update({ where: { id: wsId }, data: { name: 'Edited name', automationPaused: true } });
    await client.service.create({ data: { workspaceId: wsId, code: 'EXTRA', name: 'Extra', description: 'x', unitLabel: 'unit' } });
    await client.auditEvent.create({
      data: { actorKind: 'SYSTEM', action: 'test.noise', targetType: 'X', targetId: 'x', result: 'SUCCESS', summary: {}, correlationId: 'noise', createdAt: T0 },
    });
    expect((await contentHash(client)).hash).not.toBe(original.hash);

    const summary = await resetAndSeedDemo(client, { config: DEMO, now: T0 });
    expect(summary.workspaces).toBe(WORKSPACE_FIXTURES.length);
    expect(await contentHash(client)).toEqual(original);
  });
});

describe('demo:refresh (P20)', () => {
  it('re-bases fixture times to a new now without changing ids, matching a fresh seed at that time', async () => {
    const T1 = new Date(T0.getTime() + 3 * DAY + 7 * 3_600_000);
    const { client: refreshed } = await freshDb('refresh-a');
    const { client: fresh } = await freshDb('refresh-b');
    await seedDemo(refreshed, { config: DEMO, now: T0 });
    await seedDemo(fresh, { config: DEMO, now: T1 });

    const idsBefore = (await refreshed.workspace.findMany({ select: { id: true } })).map((r) => r.id).sort();
    const userIdsBefore = (await refreshed.user.findMany({ select: { id: true } })).map((r) => r.id).sort();
    const result = await refreshDemo(refreshed, { config: DEMO, now: T1 });
    expect(result).toMatchObject({ from: T0.toISOString(), to: T1.toISOString(), shiftMs: T1.getTime() - T0.getTime() });
    expect(result.rowsShifted).toBeGreaterThan(0);

    expect((await refreshed.workspace.findMany({ select: { id: true } })).map((r) => r.id).sort()).toEqual(idsBefore);
    expect((await refreshed.user.findMany({ select: { id: true } })).map((r) => r.id).sort()).toEqual(userIdsBefore);
    const excludeAudit = { excludeTables: ['AuditEvent'] };
    expect(await contentHash(refreshed, excludeAudit)).toEqual(await contentHash(fresh, excludeAudit));

    const refreshAudit = await refreshed.auditEvent.findMany({ where: { action: 'demo.refresh' } });
    expect(refreshAudit).toHaveLength(1);
    expect(refreshAudit[0]!.summary).toMatchObject({ anchorAt: T1.toISOString(), previousAnchorAt: T0.toISOString() });

    // A second refresh to the same time is a no-op shift.
    const again = await refreshDemo(refreshed, { config: DEMO, now: T1 });
    expect(again.shiftMs).toBe(0);
    expect(await contentHash(refreshed, excludeAudit)).toEqual(await contentHash(fresh, excludeAudit));
  });

  it('refuses LIVE mode', async () => {
    const { client } = await freshDb('refresh-live');
    await expect(refreshDemo(client, { config: { mode: 'live' }, now: T0 })).rejects.toBeInstanceOf(SeedTargetError);
  });
});

describe('seed CLI (npm run db:seed / db:reset)', () => {
  it('seeds through the env loader and config, is a no-op when already seeded, and resets with --reset', async () => {
    const { db, client } = await freshDb('seed-cli');
    const env = { ...testEnv('demo'), DATABASE_URL: db.url, SEED_NOW: T0.toISOString(), PRISMA_HIDE_UPDATE_MESSAGE: '1' };
    const entry = path.join(REPO_ROOT, 'prisma', 'seed', 'index.ts');

    const first = spawnTsx(entry, { env });
    expect(await first.waitForExit(60_000)).toMatchObject({ code: 0 });
    expect(first.lines.join('\n')).toMatch(/Seeded \d+ workspaces/);
    const seeded = await contentHash(client);

    const second = spawnTsx(entry, { env });
    expect(await second.waitForExit(60_000)).toMatchObject({ code: 0 });
    expect(second.lines.join('\n')).toMatch(/already seeded/i);

    await client.workspace.update({ where: { id: seedId('workspace', WORKSPACE_FIXTURES[0]!.slug) }, data: { name: 'Changed' } });
    const reset = spawnTsx(entry, { env, args: ['--reset'] });
    expect(await reset.waitForExit(60_000)).toMatchObject({ code: 0 });
    expect(await contentHash(client)).toEqual(seeded);

    const live = spawnTsx(entry, { env: { ...testEnv('live'), DATABASE_URL: db.url, SEED_NOW: T0.toISOString() } });
    expect(await live.waitForExit(60_000)).toMatchObject({ code: 1 });
    expect(live.stderr()).toMatch(/LIVE/);
  });
});
