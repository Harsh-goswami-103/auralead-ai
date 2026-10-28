/**
 * T2 / R1 / AT4 / ADR-04: the demo session route exists only in DEMO, accepts only fixed persona
 * keys, and issues ordinary DB sessions for seeded isDemo users. The LIVE loader rejects
 * DEMO-mode sessions and isDemo users, and the seed guard refuses a LIVE target.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { assertDemoSeedTarget, DEMO_PERSONAS } from '@/server/auth/demo-personas';
import { hashPassword } from '@/server/auth/password';
import { createSession, loadSession } from '@/server/auth/session';
import { POST as demoSessionPOST } from '@/app/api/demo/session/route';
import { POST as loginPOST } from '@/app/api/app/auth/login/route';
import { GET as sessionGET } from '@/app/api/app/auth/session/route';
import { createTestDb, type TestDb } from '../../support/db';
import { cookieFrom, makeRequest, noParams, NOW, PASSWORD, testConfig, uninstallRuntime, useRuntime } from './support';

let testDb: TestDb;
let db: PrismaClient;
let workspaceId: string;
const t0 = new Date(NOW);

beforeAll(async () => {
  testDb = await createTestDb({ label: 'auth-demo' });
  db = testDb.client();
  const ws = await db.workspace.create({ data: { slug: 'demo-alpha', name: 'Demo Alpha', mode: 'DEMO', planLabel: 'Demo' } });
  workspaceId = ws.id;
  const passwordHash = await hashPassword(PASSWORD);
  for (const persona of Object.values(DEMO_PERSONAS)) {
    const user = await db.user.create({ data: { email: persona.email, name: persona.label, globalRole: persona.globalRole, isDemo: true, passwordHash } });
    if (persona.globalRole === 'USER') await db.membership.create({ data: { userId: user.id, workspaceId, role: 'OWNER' } });
    if (persona.globalRole === 'EMPLOYEE') {
      await db.employeeAssignment.create({ data: { employeeUserId: user.id, workspaceId, capabilities: ['leads.read'], createdBy: 'seed' } });
    }
  }
});
afterEach(() => uninstallRuntime());
afterAll(async () => {
  await testDb?.destroy();
});

const switchTo = (persona: unknown, opts: { origin?: string | null; cookie?: string | null } = {}) =>
  demoSessionPOST(makeRequest('/api/demo/session', { body: { persona }, ...opts }), noParams);

describe('/api/demo/session', () => {
  it('is 404 in LIVE and creates nothing', async () => {
    useRuntime(db, testConfig('live'));
    const before = await db.session.count();
    const res = await switchTo('user');
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await db.session.count()).toBe(before);
  });

  it('in DEMO issues a DEMO-mode session for the seeded persona', async () => {
    useRuntime(db, testConfig('demo'));
    // Four personas, including the presentation client (ADR-126), all through the same route.
    expect(Object.keys(DEMO_PERSONAS)).toEqual(['user', 'client', 'employee', 'admin']);
    expect(DEMO_PERSONAS.client).toMatchObject({ globalRole: 'USER', home: '/dashboard/user' });
    for (const [key, persona] of Object.entries(DEMO_PERSONAS)) {
      const res = await switchTo(key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { redirectTo: string };
      expect(body.redirectTo).toBe(persona.home);
      const cookie = cookieFrom(res)!;
      const loaded = await loadSession(db, cookie.split('=')[1]!, { now: t0, mode: 'DEMO' });
      expect(loaded?.user.email).toBe(persona.email);
      expect(loaded?.session.mode).toBe('DEMO');
      const me = (await (await sessionGET(makeRequest('/api/app/auth/session', { cookie }), noParams)).json()) as { user: { role: string } };
      expect(me.user.role).toBe(persona.globalRole);
    }
  });

  it('accepts only the fixed persona keys (no user ids, emails or roles)', async () => {
    useRuntime(db, testConfig('demo'));
    for (const bad of ['root', 'SUPER_ADMIN', DEMO_PERSONAS.admin.email, { id: 'x' }]) {
      const res = await switchTo(bad);
      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('refuses a cross-origin switch', async () => {
    useRuntime(db, testConfig('demo'));
    const res = await switchTo('admin', { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('switching persona revokes the presented session (rotation)', async () => {
    useRuntime(db, testConfig('demo'));
    const first = cookieFrom(await switchTo('user'))!;
    const second = cookieFrom(await switchTo('employee', { cookie: first }))!;
    expect(await loadSession(db, first.split('=')[1]!, { now: t0, mode: 'DEMO' })).toBeNull();
    expect(await loadSession(db, second.split('=')[1]!, { now: t0, mode: 'DEMO' })).not.toBeNull();
  });
});

describe('LIVE loader', () => {
  it('rejects a cookie minted by the demo route', async () => {
    useRuntime(db, testConfig('demo'));
    const cookie = cookieFrom(await switchTo('admin'))!;
    uninstallRuntime();
    useRuntime(db, testConfig('live'));
    const res = await sessionGET(makeRequest('/api/app/auth/session', { cookie }), noParams);
    expect(res.status).toBe(401);
    expect(await loadSession(db, cookie.split('=')[1]!, { now: t0, mode: 'LIVE' })).toBeNull();
  });

  it('rejects an isDemo user even on a LIVE-mode session row', async () => {
    const admin = await db.user.findUniqueOrThrow({ where: { email: DEMO_PERSONAS.admin.email } });
    const forged = await createSession(db, { userId: admin.id, globalRole: 'SUPER_ADMIN', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'x', now: t0 });
    expect(await loadSession(db, forged.token, { now: t0, mode: 'LIVE' })).toBeNull();
  });

  it('a DEMO loader rejects a LIVE-mode session', async () => {
    const user = await db.user.create({ data: { email: 'real@alpha.test', name: 'Real', globalRole: 'USER' } });
    const s = await createSession(db, { userId: user.id, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'x', userAgent: 'x', now: t0 });
    expect(await loadSession(db, s.token, { now: t0, mode: 'DEMO' })).toBeNull();
  });

  it('LIVE password login refuses demo identities with the generic error', async () => {
    useRuntime(db, testConfig('live'));
    const res = await loginPOST(makeRequest('/api/app/auth/login', { body: { email: DEMO_PERSONAS.user.email, password: PASSWORD } }), noParams);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_CREDENTIALS');
  });
});

describe('seed guard', () => {
  it('refuses a LIVE config', async () => {
    await expect(assertDemoSeedTarget(testConfig('live'), db)).rejects.toThrow(/LIVE/);
  });

  it('refuses a DEMO config pointing at a DB that holds LIVE workspaces or real users', async () => {
    const fresh = await createTestDb({ label: 'auth-seed-guard' });
    try {
      const client = fresh.client();
      await expect(assertDemoSeedTarget(testConfig('demo'), client)).resolves.toBeUndefined();
      await client.workspace.create({ data: { slug: 'live-co', name: 'Live Co', mode: 'LIVE', planLabel: 'Pro' } });
      await expect(assertDemoSeedTarget(testConfig('demo'), client)).rejects.toThrow(/LIVE workspace/);
      await client.workspace.deleteMany();
      await client.user.create({ data: { email: 'real@customer.test', name: 'Real', globalRole: 'USER', isDemo: false } });
      await expect(assertDemoSeedTarget(testConfig('demo'), client)).rejects.toThrow(/non-demo user/);
    } finally {
      await fresh.destroy();
    }
  });
});
