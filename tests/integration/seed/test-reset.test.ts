/**
 * POST /api/test/reset (A40): with DEMO + AURALEAD_TEST_CONTROL=1 + the token it wipes and
 * reseeds to exactly the deterministic fixtures (anchored at SEED_NOW, else the request clock
 * floored to the hour); without the token it is a plain 404 and changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { TEST_CONTROL_HEADER } from '@/app/api/_lib/with-route';
import { POST } from '@/app/api/test/reset/route';
import { contentHash } from '../../../prisma/seed/content-hash';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { makeRequest, noParams, testConfig, uninstallRuntime, useRuntime } from '../auth/support';

const TOKEN = 'reset-token-'.padEnd(40, 'x');
const NOW = '2026-10-15T06:42:10.000Z';
const ANCHOR = new Date('2026-10-15T06:00:00.000Z');

let target: TestDb;
let reference: TestDb;
let db: PrismaClient;
let expected: string;

beforeAll(async () => {
  target = await createTestDb({ label: 'test-reset' });
  reference = await createTestDb({ label: 'test-reset-ref' });
  db = target.client();
  const ref = reference.client();
  await seedDemo(ref, { config: { mode: 'demo' }, now: ANCHOR });
  expected = (await contentHash(ref)).hash;
  await seedDemo(db, { config: { mode: 'demo' }, now: new Date('2026-09-01T00:00:00.000Z') });
  await db.workspace.update({ where: { id: seedId('workspace', 'ironpulse-fitness') }, data: { automationPaused: true } });
  useRuntime(db, testConfig('demo', { AURALEAD_TEST_CONTROL: '1', TEST_CONTROL_TOKEN: TOKEN }), new FixedClock(NOW));
});

afterAll(async () => {
  uninstallRuntime();
  await target.destroy();
  await reference.destroy();
});

describe('/api/test/reset', () => {
  it('is a 404 without the token and changes nothing', async () => {
    const before = await contentHash(db);
    const res = await POST(makeRequest('/api/test/reset', { method: 'POST', body: {} }), noParams);
    expect(res.status).toBe(404);
    const wrong = await POST(makeRequest('/api/test/reset', { method: 'POST', body: {}, headers: { [TEST_CONTROL_HEADER]: 'nope' } }), noParams);
    expect(wrong.status).toBe(404);
    expect(await contentHash(db)).toEqual(before);
  });

  it('reseeds to the deterministic fixtures anchored at the clock floored to the hour', async () => {
    const res = await POST(makeRequest('/api/test/reset', { method: 'POST', body: {}, headers: { [TEST_CONTROL_HEADER]: TOKEN } }), noParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reset: true, anchorAt: ANCHOR.toISOString(), workspaces: 5 });
    expect((await contentHash(db)).hash).toBe(expected);
  });
});
