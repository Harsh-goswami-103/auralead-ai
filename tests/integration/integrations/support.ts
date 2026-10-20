/**
 * Shared harness for the T28 Integration center, source pages, overview and pipeline editor tests:
 * the deterministic DEMO seed (workspace A is Smile Avenue, where the employee persona holds every
 * operator capability; Kesari Crafts lacks integrations.manage and pipeline.manage; Neha holds only
 * leads.read in IronPulse), real user contexts built from DB sessions, and a LIVE workspace with a
 * non-demo owner (a LIVE process never sees the DEMO workspaces, ADR-04).
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { credentialAad, encryptSecret, type KeyRing } from '@/server/security/secrets';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';
import { userCtx } from '../quotes/support';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';

export const WS_A_SLUG = 'smile-avenue-dental';
export const WS_A = seedId('workspace', WS_A_SLUG);
export const WS_KESARI_SLUG = 'kesari-crafts';
export const WS_KESARI = seedId('workspace', WS_KESARI_SLUG);
export const WS_IRON_SLUG = 'ironpulse-fitness';
export const LIVE_SLUG = 'live-ops-co';

export const KEY_RING: KeyRing = { activeKid: 'k1', keys: { k1: Buffer.alloc(32, 7) } };

export type IntegrationsHarness = { testDb: TestDb; db: PrismaClient; clock: FixedClock; liveWorkspaceId: string; liveOwnerId: string };

export async function createIntegrationsHarness(label: string): Promise<IntegrationsHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  const live = await db.workspace.create({ data: { slug: LIVE_SLUG, name: 'Live Ops Co', mode: 'LIVE', planLabel: 'Growth', timezone: 'Asia/Kolkata' } });
  await db.workspaceSettings.create({ data: { workspaceId: live.id, maxDiscountBps: 1000, brandColor: '#0F766E', termsText: 'Terms', internalWaDailyCap: 250 } });
  const owner = await db.user.create({ data: { email: 'owner@live-ops.test', name: 'Live Owner', globalRole: 'USER', isDemo: false } });
  await db.membership.create({ data: { userId: owner.id, workspaceId: live.id, role: 'OWNER' } });
  return { testDb, db, clock: new FixedClock(NOW), liveWorkspaceId: live.id, liveOwnerId: owner.id };
}

/** The employee persona (every operator capability in Smile Avenue; a narrower set in Kesari Crafts). */
export const employeeCtx = (h: IntegrationsHarness, slug: string = WS_A_SLUG) => userCtx(h.db, h.clock, 'employee', slug);
/** Neha: an employee assigned to IronPulse with `leads.read` only. */
export const nehaCtx = (h: IntegrationsHarness) => userCtx(h.db, h.clock, 'neha', WS_IRON_SLUG);

let seq = 0;
/** The LIVE workspace's owner, signed in to a LIVE process (OWNER holds every capability). */
export async function liveOwnerCtx(h: IntegrationsHarness): Promise<AppCtx> {
  seq += 1;
  const { token } = await createSession(h.db, { userId: h.liveOwnerId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: h.liveWorkspaceId, ipHash: 'live', userAgent: 'vitest', now: h.clock.now() });
  const loaded = (await loadSession(h.db, token, { now: h.clock.now(), mode: 'LIVE' }))!;
  return buildUserContext(loaded, { prisma: h.db, mode: 'live', clock: h.clock }, { correlationId: `req_integrations_live_${String(seq).padStart(4, '0')}` });
}

/** Stores an integration with encrypted credentials exactly as T32's writer will (envelope + last four). */
export async function integrationWithSecrets(
  db: PrismaClient,
  opts: { workspaceId: string; kind: 'WHATSAPP_CLOUD' | 'AI_ANTHROPIC' | 'GOOGLE_SHEETS'; status: 'CONFIGURED_UNVERIFIED' | 'CONNECTED' | 'SIMULATED' | 'REVOKED' | 'ERROR'; config?: Record<string, string>; secrets: Record<string, string> },
) {
  const row = await db.integration.create({ data: { workspaceId: opts.workspaceId, kind: opts.kind, status: opts.status, config: opts.config ?? {} } });
  const secrets: Record<string, string> = {};
  const last4: Record<string, { last4: string; updatedAt: string }> = {};
  for (const [field, plain] of Object.entries(opts.secrets)) {
    secrets[field] = encryptSecret(KEY_RING, plain, credentialAad({ workspaceId: opts.workspaceId, integrationId: row.id, field }));
    last4[field] = { last4: plain.slice(-4), updatedAt: NOW };
  }
  return db.integration.update({ where: { id: row.id }, data: { secrets, secretLast4: last4 } });
}
