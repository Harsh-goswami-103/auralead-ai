/**
 * T09 panel home pages read real, DB-derived identity and workspace data through the server
 * context: the owner sees their workspace's catalog, active pricing / scoring / pipeline versions
 * and settings; an employee sees exactly their active assignments; the super admin sees platform
 * counts, worker liveness and the outbound pause (with outbound.lock, as on the jobs page). Each
 * loader refuses the wrong role (404, A6).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { NotFoundError } from '@/lib/errors';
import { buildUserContext } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { readOutboundPause } from '@/server/services/admin/outbound-pause';
import { loadAdminHome, loadEmployeeHome, loadUserHome, WORKER_STALE_AFTER_MS } from '@/server/services/shell/panel-home';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';

const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
const NOW = new Date('2026-10-15T06:00:00.000Z');
const clock = new FixedClock(NOW.toISOString());

let testDb: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'panel-home' });
  db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
});
afterAll(async () => {
  await testDb.destroy();
});

async function ctxFor(userKey: string, activeWorkspaceSlug: string | null = null) {
  const user = await db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token } = await createSession(db, {
    userId: user.id,
    globalRole: user.globalRole,
    mode: 'DEMO',
    activeWorkspaceId: activeWorkspaceSlug ? seedId('workspace', activeWorkspaceSlug) : null,
    ipHash: 'x',
    userAgent: 'panel-home',
    now: NOW,
  });
  const loaded = (await loadSession(db, token, { now: NOW, mode: 'DEMO' }))!;
  return buildUserContext(loaded, { prisma: db, mode: 'demo', clock }, { correlationId: 'req_panel_home_test' });
}

describe('loadUserHome', () => {
  it("shows the owner's workspace, catalog with v1 prices, versions and settings", async () => {
    const home = await loadUserHome(await ctxFor('owner'));
    expect(home.workspace).toMatchObject({ name: 'Smile Avenue Dental Clinic', slug: 'smile-avenue-dental', planLabel: 'Growth', timezone: 'Asia/Kolkata', role: 'OWNER' });
    expect(home.members).toEqual([{ name: 'Ananya Sharma', role: 'OWNER' }]);
    expect(home.pricing).toMatchObject({ version: 1, note: 'Initial price list' });
    expect(home.services.map((s) => s.code)).toEqual(['ALIGN', 'CONSULT', 'RCT', 'WHITEN']);
    expect(home.services.find((s) => s.code === 'CONSULT')).toMatchObject({ name: 'Dental consultation and X-ray', unitLabel: 'visit', unitPricePaise: 80_000n });
    expect(home.scoring).toEqual({ version: 1, createdAt: new Date(SEED_NOW.getTime() - 120 * 86_400_000) });
    expect(home.pipeline).toMatchObject({ version: 1, approvalMode: 'HUMAN', stages: ['Ingestion', 'Score', 'Draft', 'Approval', 'Delivery'] });
    expect(home.settings).toMatchObject({ taxMode: 'CONFIGURED', taxLabel: 'GST', taxBps: 1800, maxDiscountBps: 1500, quoteValidityDays: 15, autoSendEnabled: false });
    expect(home.capabilityCount).toBe(15);
  });

  it('refuses a non-USER context', async () => {
    await expect(loadUserHome(await ctxFor('employee'))).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadUserHome(await ctxFor('admin'))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('loadEmployeeHome', () => {
  it('lists only active assignments with their capabilities and discount caps', async () => {
    const home = await loadEmployeeHome(await ctxFor('employee', 'kesari-crafts'));
    expect(home.assignments.map((a) => a.slug)).toEqual(['kesari-crafts', 'smile-avenue-dental']);
    expect(home.inactiveCount).toBe(1);
    const kesari = home.assignments[0]!;
    expect(kesari).toMatchObject({ name: 'Kesari Crafts Online', maxDiscountBps: 1500, current: true });
    expect(kesari.capabilities).toContain('sheets.manage');
    expect(kesari.capabilities).not.toContain('pricing.override');
    expect(home.assignments[1]!.current).toBe(false);
  });

  it('shows an unassigned employee no workspace', async () => {
    const home = await loadEmployeeHome(await ctxFor('arjun'));
    expect(home.assignments).toEqual([]);
    expect(home.inactiveCount).toBe(0);
  });

  it('refuses a non-EMPLOYEE context', async () => {
    await expect(loadEmployeeHome(await ctxFor('owner'))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('loadAdminHome', () => {
  it('counts workspaces, people and assignments for the platform', async () => {
    const home = await loadAdminHome(await ctxFor('admin'));
    expect(home.workspaces).toEqual({ total: 5, active: 5, suspended: 0, automationPaused: 0 });
    expect(home.people).toEqual({ owners: 5, members: 1, employees: 3, superAdmins: 1, disabled: 0 });
    expect(home.activeAssignments).toBe(3);
    expect(home.outboundPaused).toBe(false);
    expect(home.worker).toBeNull();
  });

  it('reports the worker as running only with a fresh heartbeat', async () => {
    const beat = (lastBeatAt: Date) =>
      db.workerHeartbeat.upsert({
        where: { workerId: 'w-test' },
        create: { workerId: 'w-test', pid: 1, hostname: 'h', version: '0.1.0', mode: 'DEMO', startedAt: SEED_NOW, lastBeatAt },
        update: { lastBeatAt },
      });
    await beat(new Date(NOW.getTime() - 5_000));
    expect((await loadAdminHome(await ctxFor('admin'))).worker).toMatchObject({ running: true, lastBeatAt: new Date(NOW.getTime() - 5_000) });
    await beat(new Date(NOW.getTime() - WORKER_STALE_AFTER_MS - 1));
    expect((await loadAdminHome(await ctxFor('admin'))).worker).toMatchObject({ running: false });
  });

  it('reads the outbound pause like the jobs page, so a hand-made outbound.lock shows as paused', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'auralead-panel-home-lock-'));
    const lockFile = path.join(dir, 'outbound.lock');
    try {
      const ctx = await ctxFor('admin');
      const clear = await loadAdminHome(ctx, { lockFile, envOutboundPaused: false });
      expect(clear.outboundPaused).toBe(false);
      expect(clear.outbound).toMatchObject({ paused: false, db: { paused: false }, lockFile: { present: false, path: lockFile }, env: { paused: false } });

      // An operator creates the lock by hand (no JSON content): the admin switch and env stay off.
      writeFileSync(lockFile, '');
      const locked = await loadAdminHome(ctx, { lockFile, envOutboundPaused: false });
      expect(locked.outboundPaused).toBe(true);
      expect(locked.outbound).toMatchObject({ paused: true, db: { paused: false }, lockFile: { present: true, writtenByRestore: false, content: null }, env: { paused: false } });
      // Same answer as the jobs page read model.
      expect(locked.outbound).toEqual(await readOutboundPause(db, { lockFile, envPaused: false }));
      rmSync(lockFile);

      const envOnly = await loadAdminHome(ctx, { lockFile, envOutboundPaused: true });
      expect(envOnly.outboundPaused).toBe(true);
      expect(envOnly.outbound).toMatchObject({ paused: true, db: { paused: false }, lockFile: { present: false }, env: { paused: true } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps reading the admin switch and env flag when no lock file path is given', async () => {
    const ctx = await ctxFor('admin');
    expect(await loadAdminHome(ctx, { envOutboundPaused: true })).toMatchObject({ outboundPaused: true, outbound: null });
    await db.systemSetting.update({ where: { id: 1 }, data: { outboundPaused: true } });
    try {
      expect(await loadAdminHome(ctx)).toMatchObject({ outboundPaused: true, outbound: null });
    } finally {
      await db.systemSetting.update({ where: { id: 1 }, data: { outboundPaused: false } });
    }
    expect(await loadAdminHome(ctx)).toMatchObject({ outboundPaused: false, outbound: null });
  });

  it('refuses a non-admin context', async () => {
    await expect(loadAdminHome(await ctxFor('owner'))).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadAdminHome(await ctxFor('neha'))).rejects.toBeInstanceOf(NotFoundError);
  });
});
