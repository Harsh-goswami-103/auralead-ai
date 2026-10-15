/**
 * Shared harness for the T15 quote tests: the seeded DEMO DB (workspace A is the dental clinic
 * with GST 18%, 15-day validity and price list v1), real user contexts built from DB sessions
 * (the owner persona of A; `pooja`, a MEMBER of kesari-crafts), leads created per test, an
 * AiDraft with a proposal, a queued dispatch attempt on a quote version, and an in-process worker.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { createLogger } from '@/lib/logger';
import { buildUserContext, getJobContext, type AppCtx } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { buildJobRegistry } from '@/server/jobs/registry';
import type { JobDefinition } from '@/server/jobs/types';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, type TestDb } from '../../support/db';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = '2026-10-16T06:00:00.000Z';
export const DAY = 86_400_000;

export const WS_A_SLUG = 'smile-avenue-dental';
export const WS_A = seedId('workspace', WS_A_SLUG);
export const WS_B = seedId('workspace', 'ironpulse-fitness');
export const WS_KESARI_SLUG = 'kesari-crafts';
export const PRICING_V1_A = seedId('pricing-version', `${WS_A_SLUG}:1`);
export const SERVICE = {
  CONSULT: seedId('service', `${WS_A_SLUG}:CONSULT`),
  WHITEN: seedId('service', `${WS_A_SLUG}:WHITEN`),
  RCT: seedId('service', `${WS_A_SLUG}:RCT`),
  ALIGN: seedId('service', `${WS_A_SLUG}:ALIGN`),
};
export const SERVICE_B = seedId('service', 'ironpulse-fitness:PT-12');

export type QuoteHarness = { testDb: TestDb; db: PrismaClient; clock: FixedClock };

export async function createQuoteHarness(label: string): Promise<QuoteHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  return { testDb, db, clock: new FixedClock(NOW) };
}

let seq = 0;

/** A signed-in user context exactly as a route builds it (session -> membership -> capabilities). */
export async function userCtx(db: PrismaClient, clock: FixedClock, userKey: string, workspaceSlug?: string): Promise<AppCtx> {
  seq += 1;
  const userId = seedId('user', userKey);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const { token } = await createSession(db, { userId, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'quotes', userAgent: 'vitest', now: clock.now() });
  const loaded = (await loadSession(db, token, { now: clock.now(), mode: 'DEMO' }))!;
  return buildUserContext(loaded, { prisma: db, mode: 'demo', clock }, { correlationId: `req_quotes_test_${String(seq).padStart(4, '0')}`, ...(workspaceSlug ? { workspaceSlug } : {}) });
}

export const ownerCtx = (h: QuoteHarness) => userCtx(h.db, h.clock, 'owner');

export function jobCtx(h: QuoteHarness, workspaceId: string = WS_A): AppCtx {
  seq += 1;
  return getJobContext({ id: `job_quotes_${seq}`, workspaceId, correlationId: `req_quotes_job_${seq}` }, { prisma: h.db, mode: 'demo', clock: h.clock });
}

let leadSeq = 0;
export async function createLead(db: PrismaClient, workspaceId: string = WS_A, displayName?: string) {
  leadSeq += 1;
  const name = displayName ?? `Quote Lead ${leadSeq}`;
  return db.lead.create({
    data: {
      workspaceId,
      displayName: name,
      nameNormalized: name.toLowerCase(),
      phoneE164: `+9197300${String(leadSeq).padStart(5, '0')}`,
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: 'MANUAL',
    },
  });
}

/** An AiDraft as T14 persists it, with a proposal over catalog ids and the given flags. */
export async function createDraft(db: PrismaClient, leadId: string, opts: { items: Array<{ serviceId: string; qty: number }>; flags?: string[]; reviewReasons?: unknown[]; workspaceId?: string }) {
  return db.aiDraft.create({
    data: {
      workspaceId: opts.workspaceId ?? WS_A,
      leadId,
      trigger: 'MANUAL',
      status: opts.flags && opts.flags.length > 0 ? 'NEEDS_REVIEW' : 'READY',
      generatorLabel: 'local-deterministic',
      inputHash: `hash-${leadId}`,
      templateVariables: { templateId: null, values: ['Asha', 'Teeth whitening'] },
      proposal: { items: opts.items, scopeText: 'Whitening course with review visit.', timelineText: 'Two weeks' },
      aiPolicyFlags: opts.flags ?? [],
      reviewReasons: (opts.reviewReasons ?? []) as never,
      policyViolations: [],
      requestedBy: seedId('user', 'owner'),
      correlationId: 'req_draft_fixture',
    },
  });
}

/** A QUEUED WhatsApp dispatch attempt (with its QUEUED job) carrying the given quote version. */
export async function queueDispatch(db: PrismaClient, opts: { leadId: string; quoteVersionId: string; approvalId: string | null; tag: string; workspaceId?: string }) {
  const workspaceId = opts.workspaceId ?? WS_A;
  const now = new Date(NOW);
  const conversation = await db.conversation.create({ data: { workspaceId, leadId: opts.leadId, channel: 'WHATSAPP', contactKey: `ck-${opts.tag}` } });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      channel: 'WHATSAPP',
      direction: 'OUT',
      kind: 'DOCUMENT',
      quoteVersionId: opts.quoteVersionId,
      status: 'PENDING',
      statusRank: 0,
      simulated: true,
      sendIntent: 'MANUAL_SINGLE',
      initiatedBy: seedId('user', 'owner'),
    },
  });
  const job = await db.job.create({
    data: {
      workspaceId,
      type: 'dispatch.whatsapp',
      payload: { messageId: message.id },
      status: 'QUEUED',
      runAt: new Date(now.getTime() + 60_000),
      maxAttempts: 5,
      idempotencyKey: `dispatch-fixture:${opts.tag}`,
      correlationId: 'req_dispatch_fixture',
      createdAt: now,
      updatedAt: now,
    },
  });
  const attempt = await db.dispatchAttempt.create({
    data: {
      workspaceId,
      messageId: message.id,
      quoteVersionId: opts.quoteVersionId,
      approvalId: opts.approvalId,
      channel: 'WHATSAPP',
      attemptNo: 1,
      state: 'QUEUED',
      sendIntent: 'MANUAL_SINGLE',
      initiatedBy: seedId('user', 'owner'),
      idempotencyKey: `dispatch-attempt-fixture:${opts.tag}`,
      jobId: job.id,
    },
  });
  return { attempt, job, message };
}

export function workerWith(h: QuoteHarness, defs: JobDefinition[]): Worker {
  return createWorker(
    { db: h.db, clock: h.clock, registry: buildJobRegistry(defs), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

export async function drain(w: Worker): Promise<void> {
  while ((await w.tick()) === 'ran');
}

export function auditActions(db: PrismaClient, quoteId: string) {
  return db.auditEvent.findMany({ where: { targetType: 'Quote', targetId: quoteId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}
