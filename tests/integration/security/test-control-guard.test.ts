/**
 * T5 (04-tests) / A40 / plan §9 "Test control": /api/test/* answers only in DEMO with
 * AURALEAD_TEST_CONTROL=1 and the right TEST_CONTROL_TOKEN (constant-time compare); every other
 * combination is an indistinguishable 404. Boot refuses LIVE with the flag set, and refuses to
 * start without the secrets `npm run setup` generates.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { BootError, bootFromEnv, checkBoot } from '@/server/boot';
import { GET as clockGET, POST as clockPOST } from '@/app/api/test/clock/route';
import { POST as loginPOST } from '@/app/api/app/auth/login/route';
import { hashPassword } from '@/server/auth/password';
import { hashToken } from '@/server/security/tokens';
import { createTestDb, type TestDb } from '../../support/db';
import { cookieFrom, makeRequest, noParams, PASSWORD, testConfig, testEnv, uninstallRuntime, useRuntime } from '../auth/support';

const TOKEN = `test-control-${'t'.repeat(40)}`;
const flagOn = { AURALEAD_TEST_CONTROL: '1', TEST_CONTROL_TOKEN: TOKEN };

let testDb: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'test-control' });
  db = testDb.client();
});
afterEach(() => uninstallRuntime());
afterAll(async () => {
  await testDb?.destroy();
});

const setClock = (body: unknown, token: string | null) =>
  clockPOST(makeRequest('/api/test/clock', { body, headers: token === null ? {} : { 'x-test-control-token': token } }), noParams);

describe('/api/test/clock guard', () => {
  it('is 404 in DEMO without the flag, even with a token', async () => {
    useRuntime(db, testConfig('demo', { TEST_CONTROL_TOKEN: TOKEN }));
    const res = await setClock({ frozenAt: '2026-10-20T00:00:00.000Z' }, TOKEN);
    expect(res.status).toBe(404);
    expect(await db.testClock.count()).toBe(0);
  });

  it('is 404 with the flag but a missing or wrong token', async () => {
    useRuntime(db, testConfig('demo', flagOn));
    const missing = await setClock({ frozenAt: '2026-10-20T00:00:00.000Z' }, null);
    const wrong = await setClock({ frozenAt: '2026-10-20T00:00:00.000Z' }, `${TOKEN}x`);
    const getWrong = await clockGET(makeRequest('/api/test/clock', { headers: { 'x-test-control-token': 'nope' } }), noParams);
    for (const res of [missing, wrong, getWrong]) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    }
    expect(await db.testClock.count()).toBe(0);
  });

  it('is 404 in LIVE regardless of headers', async () => {
    useRuntime(db, testConfig('live'));
    const res = await setClock({ frozenAt: '2026-10-20T00:00:00.000Z' }, TOKEN);
    expect(res.status).toBe(404);
  });

  it('with DEMO + flag + token it sets the shared TestClock row that request clocks read', async () => {
    useRuntime(db, testConfig('demo', flagOn));
    const res = await setClock({ frozenAt: '2026-10-20T05:30:00.000Z' }, TOKEN);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { now: string }).now).toBe('2026-10-20T05:30:00.000Z');
    const row = await db.testClock.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.frozenAt?.toISOString()).toBe('2026-10-20T05:30:00.000Z');

    // Another route in the same process now runs on the shifted clock.
    await db.user.create({ data: { email: 'clock@alpha.test', name: 'C', globalRole: 'USER', isDemo: true, passwordHash: await hashPassword(PASSWORD) } });
    const login = await loginPOST(makeRequest('/api/app/auth/login', { body: { email: 'clock@alpha.test', password: PASSWORD } }), noParams);
    expect(login.status).toBe(200);
    const token = cookieFrom(login)!.split('=')[1]!;
    const session = await db.session.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
    expect(session.createdAt.toISOString()).toBe('2026-10-20T05:30:00.000Z');

    const advanced = await setClock({ advanceMs: 1 }, TOKEN);
    expect(((await advanced.json()) as { now: string }).now).toBe('2026-10-20T05:30:00.001Z');

    const offset = await setClock({ offsetMs: 3_600_000 }, TOKEN);
    expect(offset.status).toBe(200);
    const after = await db.testClock.findUniqueOrThrow({ where: { id: 1 } });
    expect(after.frozenAt).toBeNull();
    expect(after.offsetMs).toBe(3_600_000n);

    const reset = await setClock({ reset: true }, TOKEN);
    expect(reset.status).toBe(200);
    const cleared = await db.testClock.findUniqueOrThrow({ where: { id: 1 } });
    expect({ offsetMs: cleared.offsetMs, frozenAt: cleared.frozenAt }).toEqual({ offsetMs: 0n, frozenAt: null });
  });

  it('rejects an ambiguous clock body with 400', async () => {
    useRuntime(db, testConfig('demo', flagOn));
    const res = await setClock({ frozenAt: '2026-10-20T00:00:00.000Z', offsetMs: 5 }, TOKEN);
    expect(res.status).toBe(400);
  });
});

describe('boot', () => {
  it('refuses LIVE with AURALEAD_TEST_CONTROL=1', () => {
    expect(() => bootFromEnv(testEnv('live', flagOn))).toThrow(BootError);
    try {
      bootFromEnv(testEnv('live', flagOn));
    } catch (error) {
      expect((error as BootError).issues.join('\n')).toMatch(/AURALEAD_TEST_CONTROL/);
    }
  });

  it('refuses a LIVE config with test control even if it bypassed parsing', () => {
    const config = { ...testConfig('live'), testControl: { enabled: true, token: TOKEN } };
    expect(() => checkBoot(config)).toThrow(/AURALEAD_TEST_CONTROL/);
  });

  it('refuses to start without the generated secrets, in either mode', () => {
    for (const mode of ['demo', 'live'] as const) {
      const env = testEnv(mode);
      delete env.SESSION_SECRET;
      expect(() => bootFromEnv(env)).toThrow(/SESSION_SECRET/);
    }
    const demo = testEnv('demo');
    delete demo.SHARE_NONCE_KEY;
    delete demo.SUPPRESSION_PEPPER;
    delete demo.CREDENTIALS_KEYRING;
    delete demo.CREDENTIALS_ACTIVE_KID;
    expect(() => bootFromEnv(demo)).toThrow(/npm run setup/);
  });

  it('boots DEMO with test control and LIVE without it, and reports OneDrive paths as warnings', () => {
    expect(bootFromEnv(testEnv('demo', flagOn)).config.testControl.enabled).toBe(true);
    expect(bootFromEnv(testEnv('live')).config.mode).toBe('live');
    const oneDrive = bootFromEnv(testEnv('demo', { AURALEAD_DATA_DIR: 'C:\\Users\\x\\OneDrive\\data' }), { platform: 'win32' });
    expect(oneDrive.warnings.some((w) => /OneDrive/.test(w))).toBe(true);
  });
});
