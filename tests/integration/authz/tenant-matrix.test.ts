/**
 * R3 / AT4 / E10 (T09): the generated tenant matrix. Every route in src/server/routes.manifest.ts
 * runs in-process against the deterministic DEMO seed for each matrix actor (anonymous, owner of
 * workspace A, unassigned employee, employee assigned to workspace B without the capability,
 * super admin), aimed at workspace B resources, and must answer exactly the status the manifest
 * specifies. Then every session call is replayed with workspace B's id injected (body key on
 * mutations, query param on reads) and with each declared foreign reference swapped for a
 * workspace B id: an actor that was allowed must now get 404 (or 422), never a 2xx.
 * A route file that is not in the manifest fails the test.
 *
 * Pages run their real layouts and page module; `next/headers` is replaced by the request's
 * headers (the only Next request API the page context reads).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { MATRIX_ACTORS, ROUTES, type HttpMethod, type MatrixActor, type RouteCall, type RouteEntry } from '@/server/routes.manifest';
import { createRateLimiters } from '@/server/security/rate-limit';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import {
  discoverRouteFiles,
  fillPath,
  invokeApi,
  invokePage,
  MATRIX_ACTOR_USERS,
  MATRIX_FIXTURES,
  resolvedParams,
  resolveFixtures,
  type InvokeResult,
} from '../../support/routes';
import { ORIGIN, testConfig, testEnv, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({
  headers: async () => pageHeaders.current,
}));

const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
const NOW = new Date('2026-10-15T06:00:00.000Z');
const SAFE = new Set<HttpMethod>(['GET']);

let db: TestDb;
let prisma: PrismaClient;
let runtime: TestRuntime;
const savedEnv = { ...process.env };

beforeAll(async () => {
  db = await createTestDb({ label: 'tenant-matrix' });
  prisma = db.client();
  await seedDemo(prisma, { config: { mode: 'demo' }, now: SEED_NOW });
  // Pages that read the process config (getConfig) see the same DEMO config as the runtime.
  Object.assign(process.env, testEnv('demo'), { NEXT_PUBLIC_APP_MODE: 'demo' });
  runtime = useRuntime(prisma, testConfig('demo'), new FixedClock(NOW.toISOString()));
});

afterAll(async () => {
  uninstallRuntime();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await db?.destroy();
});

type Auth = { cookie: string | null; csrf: string | null };

/** A fresh DB session per call (logout and re-auth rotate or revoke the presented one). */
async function authFor(actor: MatrixActor): Promise<Auth> {
  const key = MATRIX_ACTOR_USERS[actor];
  if (key === null) return { cookie: null, csrf: null };
  const user = await prisma.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
  const { token, session } = await createSession(prisma, {
    userId: user.id,
    globalRole: user.globalRole,
    mode: 'DEMO',
    activeWorkspaceId: null,
    ipHash: 'matrix',
    userAgent: 'tenant-matrix',
    now: NOW,
  });
  return { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id) };
}

type Variant = { body?: Record<string, unknown>; query?: Record<string, unknown> };

async function run(entry: RouteEntry, call: RouteCall, actor: MatrixActor, variant: Variant = {}): Promise<InvokeResult> {
  // Authorization is under test here, not throttling: every call starts with full buckets.
  runtime.limiters = createRateLimiters(runtime.clock);
  const auth = await authFor(actor);
  const params = resolvedParams(entry);
  const url = new URL(fillPath(entry.path, params), ORIGIN);
  const query = { ...((resolveFixtures(call.query) as Record<string, unknown> | undefined) ?? {}), ...variant.query };
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

  const headers = new Headers({ 'user-agent': 'tenant-matrix' });
  if (auth.cookie) headers.set('cookie', auth.cookie);

  if (entry.kind === 'page') {
    pageHeaders.current = headers;
    return invokePage(entry.file, params);
  }
  const unsafe = !SAFE.has(call.method);
  let body: string | undefined;
  if (unsafe) {
    headers.set('origin', ORIGIN);
    if (auth.csrf) headers.set('x-csrf-token', auth.csrf);
    const base = (resolveFixtures(call.body) as Record<string, unknown> | undefined) ?? {};
    body = JSON.stringify({ ...base, ...variant.body });
    headers.set('content-type', 'application/json');
  }
  return invokeApi(entry.file, call.method, new Request(url, { method: call.method, headers, body }), params);
}

const label = (entry: RouteEntry, call: RouteCall) => `${call.method} ${entry.path}${call.note ? ` (${call.note})` : ''}`;
const cases = ROUTES.flatMap((entry) => entry.calls.map((call) => [label(entry, call), entry, call] as const));

describe('tenant matrix', () => {
  it('covers every route file in the app (an unlisted route fails)', () => {
    const listed = new Set(ROUTES.map((r) => r.file));
    const unlisted = discoverRouteFiles().filter((f) => !listed.has(f));
    expect(unlisted).toEqual([]);
  });

  it.each(cases)('%s answers each actor as specified', async (_label, entry, call) => {
    const actual: Record<string, number> = {};
    for (const actor of MATRIX_ACTORS) actual[actor] = (await run(entry, call, actor)).status;
    expect(actual).toEqual(call.expect);
  });

  // Pages take no workspace id from the browser at all (the layout gate above covers them).
  const sessionApi = cases.filter(([, entry]) => entry.access === 'session' && entry.kind === 'api');
  it.each(sessionApi)('%s ignores browser-supplied workspace B ids (E10)', async (_label, entry, call) => {
    const foreign = MATRIX_FIXTURES['workspaceB.id']!;
    const injected = SAFE.has(call.method) ? { query: { workspaceId: foreign } } : { body: { workspaceId: foreign } };
    for (const actor of MATRIX_ACTORS) {
      const baseline = call.expect[actor];
      const status = (await run(entry, call, actor, injected)).status;
      if (baseline < 400) expect(status, `${actor} with workspaceId of B`).toBe(404);
      else expect(status, `${actor} stays denied`).toBeGreaterThanOrEqual(400);
    }
  });

  it.each(cases.filter(([, , call]) => call.foreignRefs !== undefined))('%s rejects workspace B references (E10)', async (_label, entry, call) => {
    for (const [bodyKey, fixtureKey] of Object.entries(call.foreignRefs!)) {
      const foreign = MATRIX_FIXTURES[fixtureKey];
      expect(foreign, `fixture ${fixtureKey}`).toBeDefined();
      for (const actor of MATRIX_ACTORS) {
        if (call.expect[actor] >= 400) continue;
        const status = (await run(entry, call, actor, { body: { [bodyKey]: foreign } })).status;
        expect([404, 422], `${actor} with ${bodyKey} of B`).toContain(status);
      }
    }
  });

  it('the owner of workspace A resolves only workspace A, and the narrow employee only workspace B', async () => {
    const session = ROUTES.find((r) => r.path === '/api/app/auth/session')!;
    const plain = session.calls.find((c) => !c.query)!;
    const owner = await run(session, plain, 'ownerA');
    expect(owner.status).toBe(200);
    expect((owner.body as { workspace?: { id?: string } }).workspace?.id).toBe(MATRIX_FIXTURES['workspaceA.id']);
    const switchRoute = ROUTES.find((r) => r.path === '/api/app/auth/active-workspace')!;
    const neha = await run(switchRoute, switchRoute.calls[0]!, 'employeeNoCapability');
    expect(neha.status).toBe(200);
    expect((neha.body as { workspaceId?: string }).workspaceId).toBe(MATRIX_FIXTURES['workspaceB.id']);
  });
});
