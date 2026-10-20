/**
 * T08 panel chrome: the data behind the top bar (WorkspaceChip, user menu, mode and pause
 * banners) comes from the server context only. A USER sees their memberships, an EMPLOYEE only
 * their active assignments, a SUPER_ADMIN no workspace; workspaces of the other mode never
 * appear; the global outbound pause comes from SystemSetting, the env kill switch or outbound.lock.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { buildUserContext } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { loadPanelChrome } from '@/server/services/shell/panel-chrome';
import { CSRF_HEADER } from '@/server/security/csrf';
import { CSRF_HEADER_NAME } from '@/components/patterns/api-client';
import { createTestDb, type TestDb } from '../../support/db';
import { NOW, seedIdentities, type Identity } from '../auth/support';

let testDb: TestDb;
let db: PrismaClient;
let ids: Identity;
const clock = new FixedClock(NOW);
const lockDir = mkdtempSync(path.join(tmpdir(), 'auralead-chrome-lock-'));
const outboundLockFile = path.join(lockDir, 'outbound.lock');

beforeAll(async () => {
  testDb = await createTestDb({ label: 'panel-chrome' });
  db = testDb.client();
  ids = await seedIdentities(db, 'LIVE');
  // A second membership for the owner, one DEMO workspace that must never show in LIVE, and an
  // inactive assignment that must never show for the employee.
  const gamma = await db.workspace.create({ data: { slug: 'gamma', name: 'Gamma Fitness', mode: 'LIVE', planLabel: 'Growth' } });
  const demoWs = await db.workspace.create({ data: { slug: 'demo-ws', name: 'Demo Only', mode: 'DEMO', planLabel: 'Demo' } });
  await db.membership.create({ data: { userId: ids.ownerId, workspaceId: gamma.id, role: 'MEMBER' } });
  await db.membership.create({ data: { userId: ids.ownerId, workspaceId: demoWs.id, role: 'OWNER' } });
  await db.employeeAssignment.create({
    data: { employeeUserId: ids.employeeId, workspaceId: ids.workspaceBId, capabilities: ['leads.read'], active: false, createdBy: ids.adminId },
  });
  await db.employeeAssignment.create({
    data: { employeeUserId: ids.employeeId, workspaceId: gamma.id, capabilities: ['leads.read'], createdBy: ids.adminId },
  });
});
afterAll(async () => {
  await testDb?.destroy();
  rmSync(lockDir, { recursive: true, force: true });
});

async function chromeFor(userId: string, role: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN', active: string | null = null, envOutboundPaused = false) {
  const { token } = await createSession(db, { userId, globalRole: role, mode: 'LIVE', activeWorkspaceId: active, ipHash: 'x', userAgent: 'vitest', now: clock.now() });
  const loaded = (await loadSession(db, token, { now: clock.now(), mode: 'LIVE' }))!;
  const ctx = await buildUserContext(loaded, { prisma: db, mode: 'live', clock }, { correlationId: 'req_panel_chrome_01' });
  return loadPanelChrome(ctx, loaded, { envOutboundPaused, outboundLockFile });
}

describe('loadPanelChrome', () => {
  it('the browser helper sends CSRF in the header withRoute checks', () => {
    expect(CSRF_HEADER_NAME).toBe(CSRF_HEADER);
  });

  it('USER: identity, current workspace and switchable memberships of this mode only', async () => {
    const chrome = await chromeFor(ids.ownerId, 'USER');
    expect(chrome.mode).toBe('live');
    expect(chrome.user).toEqual({ name: 'owner', email: 'owner@alpha.test', role: 'USER', isDemo: false });
    expect(chrome.workspace).toEqual({ slug: 'alpha', name: 'Alpha Dental', planLabel: 'Starter', mode: 'LIVE' });
    expect(chrome.switchable.map((w) => w.slug)).toEqual(['alpha', 'gamma']);
    expect(chrome.outboundPaused).toBe(false);
    expect(chrome.automationPaused).toBe(false);
  });

  it('USER: the session active workspace drives the chip', async () => {
    const gamma = await db.workspace.findUniqueOrThrow({ where: { slug: 'gamma' } });
    const chrome = await chromeFor(ids.ownerId, 'USER', gamma.id);
    expect(chrome.workspace?.slug).toBe('gamma');
  });

  it('EMPLOYEE: only active assignments are switchable', async () => {
    const chrome = await chromeFor(ids.employeeId, 'EMPLOYEE');
    expect(chrome.switchable.map((w) => w.slug)).toEqual(['alpha', 'gamma']);
    expect(chrome.workspace).toBeNull();
  });

  it('EMPLOYEE without assignments: nothing switchable', async () => {
    const chrome = await chromeFor(ids.unassignedEmployeeId, 'EMPLOYEE');
    expect(chrome.switchable).toEqual([]);
    expect(chrome.workspace).toBeNull();
  });

  it('SUPER_ADMIN: no workspace and nothing switchable', async () => {
    const chrome = await chromeFor(ids.adminId, 'SUPER_ADMIN');
    expect(chrome.workspace).toBeNull();
    expect(chrome.switchable).toEqual([]);
    expect(chrome.user.role).toBe('SUPER_ADMIN');
  });

  it('outbound pause from SystemSetting or the env switch; workspace automation pause', async () => {
    expect((await chromeFor(ids.ownerId, 'USER', null, true)).outboundPaused).toBe(true);
    await db.systemSetting.upsert({ where: { id: 1 }, create: { id: 1, outboundPaused: true }, update: { outboundPaused: true } });
    await db.workspace.update({ where: { id: ids.workspaceAId }, data: { automationPaused: true, automationPauseReason: 'Owner review' } });
    const chrome = await chromeFor(ids.ownerId, 'USER', ids.workspaceAId);
    expect(chrome.outboundPaused).toBe(true);
    expect(chrome.automationPaused).toBe(true);
    await db.systemSetting.update({ where: { id: 1 }, data: { outboundPaused: false } });
    await db.workspace.update({ where: { id: ids.workspaceAId }, data: { automationPaused: false, automationPauseReason: null } });
  });

  it('outbound pause from an outbound.lock file alone (a restore or an operator), like dispatch preflight', async () => {
    expect((await chromeFor(ids.ownerId, 'USER')).outboundPaused).toBe(false);
    writeFileSync(outboundLockFile, JSON.stringify({ writtenBy: 'db:restore', at: NOW, reason: 'restore' }));
    try {
      expect((await chromeFor(ids.ownerId, 'USER')).outboundPaused).toBe(true);
      expect((await chromeFor(ids.adminId, 'SUPER_ADMIN')).outboundPaused).toBe(true);
    } finally {
      rmSync(outboundLockFile, { force: true });
    }
    expect((await chromeFor(ids.ownerId, 'USER')).outboundPaused).toBe(false);
  });
});
