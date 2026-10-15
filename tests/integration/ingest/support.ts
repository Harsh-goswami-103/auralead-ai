/**
 * Shared harness for the T10 ingestion tests: a migrated, seeded DEMO DB (five workspaces with an
 * active pipeline v1 each), a webhook-style context scoped to one workspace (the same context the
 * Sheets, Meta and extension routes build after verifying a signature or token), and record
 * builders. The contact-key pepper is a fixed test value.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { getWebhookContext, type AppCtx } from '@/server/auth/context';
import type { IngestDeps } from '@/server/services/leads/ingest';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';
export const PEPPER = `ingest-test-pepper-${'p'.repeat(32)}`;
export const DEPS: IngestDeps = { contactKeyPepper: PEPPER };

export const WS_A = seedId('workspace', 'smile-avenue-dental');
export const WS_B = seedId('workspace', 'ironpulse-fitness');

export type IngestHarness = { testDb: TestDb; db: PrismaClient; clock: FixedClock };

export async function createIngestHarness(label: string): Promise<IngestHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  return { testDb, db, clock: new FixedClock(NOW) };
}

let seq = 0;
export function ctxFor(db: PrismaClient, clock: FixedClock, workspaceId: string = WS_A, correlationId?: string): AppCtx {
  seq += 1;
  return getWebhookContext({ workspaceId }, { prisma: db, mode: 'demo', clock }, correlationId ?? `req_ingest_test_${seq.toString().padStart(4, '0')}`);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
