/**
 * Shared harness for the T14 AI integration tests: the seeded DEMO DB (workspace A is the dental
 * clinic with an active price list), a lead created in workspace A, and helpers to switch a
 * workspace to LIVE with an encrypted AI integration so the real Anthropic/OpenAI adapters run
 * against an undici MockAgent (net connect disabled). No test reaches a real provider.
 */
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { getJobContext, type AppCtx } from '@/server/auth/context';
import { OWNER_CAPABILITIES } from '@/server/auth/guards';
import { scopeDb } from '@/server/db/scoped';
import { credentialAad, encryptSecret, type KeyRing } from '@/server/security/secrets';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';
export const WS_A = seedId('workspace', 'smile-avenue-dental');
export const WS_B = seedId('workspace', 'ironpulse-fitness');
export const OWNER_ID = seedId('user', 'owner');
export const SERVICE = {
  CONSULT: seedId('service', 'smile-avenue-dental:CONSULT'),
  WHITEN: seedId('service', 'smile-avenue-dental:WHITEN'),
  RCT: seedId('service', 'smile-avenue-dental:RCT'),
  ALIGN: seedId('service', 'smile-avenue-dental:ALIGN'),
};
export const KEY_RING: KeyRing = { activeKid: 'k1', keys: { k1: randomBytes(32) } };
export const ANTHROPIC_KEY = 'sk-ant-api03-integration-test-key-000000000000000000000';

export type AiHarness = { testDb: TestDb; db: PrismaClient; clock: FixedClock };

export async function createAiHarness(label: string): Promise<AiHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  return { testDb, db, clock: new FixedClock(NOW) };
}

let leadSeq = 0;
export async function createLead(db: PrismaClient, workspaceId: string = WS_A, over: Partial<{ displayName: string; category: string | null; phoneE164: string | null; emailNormalized: string | null }> = {}) {
  leadSeq += 1;
  const displayName = over.displayName ?? `Priya Sharma ${leadSeq}`;
  return db.lead.create({
    data: {
      workspaceId,
      displayName,
      nameNormalized: displayName.toLowerCase(),
      category: over.category === undefined ? 'Teeth whitening' : over.category,
      phoneE164: over.phoneE164 === undefined ? `+9198100${String(leadSeq).padStart(5, '0')}` : over.phoneE164,
      emailNormalized: over.emailNormalized === undefined ? null : over.emailNormalized,
      city: 'Gurugram',
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: 'GOOGLE_SHEETS',
    },
  });
}

/** Switches a seeded workspace to LIVE (defense-in-depth mode check) and optionally adds an AI integration. */
export async function makeLive(db: PrismaClient, workspaceId: string, integration?: { kind: 'AI_ANTHROPIC' | 'AI_OPENAI'; apiKey: string; modelId?: string | null; status?: 'CONNECTED' | 'CONFIGURED_UNVERIFIED' | 'NOT_CONFIGURED' | 'REVOKED' }) {
  await db.workspace.update({ where: { id: workspaceId }, data: { mode: 'LIVE' } });
  await db.integration.deleteMany({ where: { workspaceId, kind: { in: ['AI_ANTHROPIC', 'AI_OPENAI'] } } });
  if (!integration) return null;
  const row = await db.integration.create({
    data: {
      workspaceId,
      kind: integration.kind,
      status: integration.status ?? 'CONNECTED',
      config: integration.modelId === undefined ? {} : { modelId: integration.modelId },
    },
  });
  const envelope = encryptSecret(KEY_RING, integration.apiKey, credentialAad({ workspaceId, integrationId: row.id, field: 'apiKey' }));
  return db.integration.update({ where: { id: row.id }, data: { secrets: { apiKey: envelope }, secretLast4: { apiKey: integration.apiKey.slice(-4) } } });
}

let jobSeq = 0;
export function jobCtx(db: PrismaClient, clock: FixedClock, mode: 'demo' | 'live', workspaceId: string = WS_A): AppCtx {
  jobSeq += 1;
  return getJobContext({ id: `job_ai_test_${jobSeq}`, workspaceId, correlationId: `req_ai_test_${String(jobSeq).padStart(4, '0')}` }, { prisma: db, mode, clock });
}

/** A signed-in workspace owner (not a demo identity), as `getRequestContext` would build it. */
export function ownerCtx(db: PrismaClient, clock: FixedClock, mode: 'demo' | 'live', workspaceId: string = WS_A): AppCtx {
  return {
    kind: 'user',
    correlationId: 'req_ai_owner_0001',
    mode,
    actor: { userId: OWNER_ID, role: 'USER', isDemo: false },
    workspaceId,
    capabilities: OWNER_CAPABILITIES,
    maxDiscountBps: 2000,
    clock,
    db: scopeDb(db, workspaceId),
  };
}
