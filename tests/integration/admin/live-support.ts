/**
 * Harness for the T29 admin tests in LIVE (the mode the admin panel exists for): a migrated test DB
 * with the T06 identities (two LIVE workspaces, one user per role with a real password, and one
 * demo owner that LIVE must never touch), the process runtime installed on it so the admin routes
 * run exactly as in the app, DB sessions with a chosen sign-in time, and contexts built the way a
 * route builds them.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, loadSession, sessionCookieName } from '@/server/auth/session';
import { createRateLimiters } from '@/server/security/rate-limit';
import { createTestDb, type TestDb } from '../../support/db';
import { NOW, seedIdentities, testConfig, uninstallRuntime, useRuntime as installTestRuntime, type Identity, type TestRuntime } from '../auth/support';
import type { AdminAuth } from './support';

export type LiveAdminHarness = {
  testDb: TestDb;
  db: PrismaClient;
  config: AppConfig;
  runtime: TestRuntime;
  clock: FixedClock;
  ids: Identity;
  destroy: () => Promise<void>;
};

export async function createLiveAdminHarness(label: string): Promise<LiveAdminHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  const ids = await seedIdentities(db, 'LIVE');
  const config = testConfig('live');
  const clock = new FixedClock(NOW);
  const runtime = installTestRuntime(db, config, clock);
  return {
    testDb,
    db,
    config,
    runtime,
    clock,
    ids,
    destroy: async () => {
      uninstallRuntime();
      await testDb.destroy();
    },
  };
}

/** Full rate-limit buckets (authorization is under test, not throttling). */
export function refillLimits(h: LiveAdminHarness): void {
  h.runtime.limiters = createRateLimiters(h.clock);
}

/** A LIVE DB session for `userId`, created at `createdAt` (default now), optionally re-authenticated at `reauthAt`. */
export async function liveSession(h: LiveAdminHarness, userId: string, opts: { createdAt?: Date; reauthAt?: Date | null } = {}): Promise<AdminAuth & { token: string }> {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: userId } });
  const { token, session } = await createSession(h.db, {
    userId,
    globalRole: user.globalRole,
    mode: 'LIVE',
    activeWorkspaceId: null,
    ipHash: 'admin-live-test',
    userAgent: 'vitest',
    now: opts.createdAt ?? h.clock.now(),
    reauthAt: opts.reauthAt ?? null,
  });
  return { cookie: `${sessionCookieName(h.config)}=${token}`, csrf: csrfTokenForSession(h.config, session.id), sessionId: session.id, token };
}

let seq = 0;

/** The context a route builds for `userId` (session -> role -> workspace). */
export async function liveCtx(h: LiveAdminHarness, userId: string, workspaceSlug?: string): Promise<AppCtx> {
  seq += 1;
  const { token } = await liveSession(h, userId);
  const loaded = (await loadSession(h.db, token, { now: h.clock.now(), mode: 'LIVE' }))!;
  return buildUserContext(loaded, { prisma: h.db, mode: 'live', clock: h.clock }, { correlationId: `req_admin_live_${String(seq).padStart(4, '0')}`, ...(workspaceSlug ? { workspaceSlug } : {}) });
}

/** Whether a session token still loads (not revoked, not expired, user active). */
export async function sessionAlive(h: LiveAdminHarness, token: string): Promise<boolean> {
  return (await loadSession(h.db, token, { now: h.clock.now(), mode: 'LIVE' })) !== null;
}

export const REASON = 'Customer onboarding call 2026-10-15';
