/**
 * ADR-68 end to end: `scripts/admin-bootstrap.ts` run as a child process against a migrated LIVE
 * database, the way an operator runs `npm run admin:bootstrap`. The printed link is redeemed
 * through the real invite route, and the CLI then refuses a second administrator.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { POST as acceptPOST } from '@/app/api/app/auth/invite/accept/route';
import { createTestDb, type TestDb } from '../../support/db';
import { REPO_ROOT, spawnTsx, terminateAll } from '../../support/spawn';
import { makeRequest, noParams, ORIGIN, testConfig, testEnv, uninstallRuntime, useRuntime } from '../auth/support';

let testDb: TestDb;
let db: PrismaClient;
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'admin-bootstrap.ts');

beforeAll(async () => {
  testDb = await createTestDb({ label: 'admin-bootstrap-cli' });
  db = testDb.client();
}, 120_000);
afterAll(async () => {
  uninstallRuntime();
  await terminateAll();
  await testDb?.destroy();
});

async function run(args: string[], mode: 'live' | 'demo' = 'live') {
  const child = spawnTsx(SCRIPT, { args, env: { ...testEnv(mode), DATABASE_URL: testDb.url, AURALEAD_TEST_CONTROL: '0', NEXT_PUBLIC_APP_MODE: mode } });
  const exit = await child.waitForExit(60_000);
  return { code: exit.code, out: child.lines.join('\n'), err: child.stderr() };
}

describe('npm run admin:bootstrap', () => {
  it('prints a single-use invite link that creates the first administrator, then refuses a second', async () => {
    const first = await run(['--email', 'founder@example.test']);
    expect(first.code).toBe(0);
    const link = /(https?:\/\/\S+\/invite\/([A-Za-z0-9_-]{43}))/.exec(first.out);
    expect(link, first.out + first.err).not.toBeNull();
    expect(link![1]!.startsWith(ORIGIN)).toBe(true);

    useRuntime(db, testConfig('live'));
    const res = await acceptPOST(makeRequest('/api/app/auth/invite/accept', { body: { token: link![2], name: 'Founder', password: 'a long first admin passphrase' } }), noParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ redirectTo: '/dashboard/admin' });
    expect(await db.user.count({ where: { globalRole: 'SUPER_ADMIN', status: 'ACTIVE', isDemo: false } })).toBe(1);

    const second = await run(['--email', 'another@example.test']);
    expect(second.code).toBe(1);
    expect(second.err).toMatch(/administrator already exists/);
    expect(second.err).toMatch(/--recover/);
  }, 120_000);

  it('--recover prints a one-hour reset link for the existing administrator and logs nothing secret', async () => {
    const out = await run(['--email', 'founder@example.test', '--recover']);
    expect(out.code).toBe(0);
    const token = /\/reset\/([A-Za-z0-9_-]{43})/.exec(out.out)?.[1];
    expect(token, out.out + out.err).toBeDefined();
    const audit = await db.auditEvent.findFirst({ where: { action: 'password.reset_issue' } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain(token!);
    expect(out.err).not.toContain(token!);
  }, 120_000);

  it('needs an email and refuses DEMO', async () => {
    expect((await run([])).code).toBe(1);
    const demo = await run(['--email', 'x@example.test'], 'demo');
    expect(demo.code).toBe(1);
    expect(demo.err).toMatch(/DEMO mode/);
  }, 120_000);
});
