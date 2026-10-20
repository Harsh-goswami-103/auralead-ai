/**
 * Shared harness for the T25 metrics tests: the seeded DEMO DB, a Prisma client whose driver
 * adapter counts every SQL statement it runs (the query budget), real user contexts built from DB
 * sessions exactly as a page builds them, and small fixture writers for the rows the widgets read
 * (leads in each stage, quotes in every status with persisted totals, conversations, outbound
 * messages, approvals, call requests and audit rows). The writers use the base client and name the
 * workspace explicitly, so a fixture can be placed in workspace B to prove tenant scoping.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient, type Prisma } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { seedDemo } from '../../../prisma/seed/seed';
import { createTestDb, type TestDb } from '../../support/db';

export const SEED_NOW = new Date('2026-10-15T04:30:00.000Z');
export const NOW = new Date('2026-10-20T06:00:00.000Z');
export const DAY = 86_400_000;
export const WS_A = seedId('workspace', 'smile-avenue-dental');
export const WS_B = seedId('workspace', 'ironpulse-fitness');
export const OWNER_A = seedId('user', 'owner');
export const EMPLOYEE = seedId('user', 'employee');
export const NEHA = seedId('user', 'neha');
export const ADMIN = seedId('user', 'admin');

export const ago = (ms: number) => new Date(NOW.getTime() - ms);
export const ahead = (ms: number) => new Date(NOW.getTime() + ms);

export type QueryCounter = { count: number; sql: string[]; reset(): void };

type Queryable = { queryRaw(q: { sql: string }): Promise<unknown>; executeRaw(q: { sql: string }): Promise<unknown> };

/**
 * A client on `url` whose driver adapter counts `queryRaw` / `executeRaw` calls, i.e. the SQL
 * statements Prisma actually sends (a relation include that Prisma splits into two statements
 * counts twice). PRAGMAs run at connect, before counting matters.
 */
export function createCountingClient(url: string): { client: PrismaClient; counter: QueryCounter } {
  const counter: QueryCounter = {
    count: 0,
    sql: [],
    reset() {
      this.count = 0;
      this.sql = [];
    },
  };
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const value = Reflect.get(t, prop) as unknown;
        if (prop === 'queryRaw' || prop === 'executeRaw') {
          return async (q: { sql: string }) => {
            counter.count += 1;
            counter.sql.push(q.sql);
            return (value as Queryable['queryRaw']).call(t, q);
          };
        }
        if (prop === 'startTransaction') {
          return async (...args: unknown[]) => wrap((await (value as (...a: unknown[]) => Promise<object>).apply(t, args)) as object);
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
      },
    });
  const inner = new PrismaBetterSqlite3({ url, timeout: 5000 });
  const factory = {
    provider: 'sqlite' as const,
    adapterName: inner.adapterName,
    async connect() {
      const adapter = await inner.connect();
      await adapter.executeScript('PRAGMA busy_timeout = 5000;\nPRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;');
      return wrap(adapter);
    },
    async connectToShadowDb() {
      return inner.connectToShadowDb();
    },
  };
  return { client: new PrismaClient({ adapter: factory as unknown as PrismaBetterSqlite3 }), counter };
}

export type MetricsHarness = {
  testDb: TestDb;
  /** The plain production client (fixtures and direct checks). */
  db: PrismaClient;
  /** The counting client (contexts built on it count their statements). */
  counting: PrismaClient;
  counter: QueryCounter;
  clock: FixedClock;
};

export async function createMetricsHarness(label: string): Promise<MetricsHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  await seedDemo(db, { config: { mode: 'demo' }, now: SEED_NOW });
  const { client, counter } = createCountingClient(testDb.url);
  return { testDb, db, counting: client, counter, clock: new FixedClock(NOW.toISOString()) };
}

export async function destroyHarness(h: MetricsHarness | undefined): Promise<void> {
  if (!h) return;
  await h.counting.$disconnect();
  await h.testDb.destroy();
}

let seq = 0;

/** A signed-in context exactly as a page builds it, on the given client (counting or plain). */
export async function ctxFor(h: MetricsHarness, userKey: string, opts: { client?: PrismaClient; workspaceSlug?: string } = {}): Promise<AppCtx> {
  seq += 1;
  const prisma = opts.client ?? h.db;
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'metrics', userAgent: 'vitest', now: NOW });
  const loaded = (await loadSession(prisma, token, { now: NOW, mode: 'DEMO' }))!;
  return buildUserContext(loaded, { prisma, mode: 'demo', clock: h.clock }, { correlationId: `req_metrics_${String(seq).padStart(4, '0')}`, ...(opts.workspaceSlug ? { workspaceSlug: opts.workspaceSlug } : {}) });
}

// ---- Fixture writers -------------------------------------------------------------------------------

let leadSeq = 0;
export async function insertLead(
  db: PrismaClient,
  opts: { workspaceId?: string; stage?: Prisma.LeadUncheckedCreateInput['salesStage']; createdAt?: Date; mergedIntoLeadId?: string | null; name?: string } = {},
) {
  leadSeq += 1;
  const name = opts.name ?? `Metrics Lead ${leadSeq}`;
  return db.lead.create({
    data: {
      workspaceId: opts.workspaceId ?? WS_A,
      displayName: name,
      nameNormalized: name.toLowerCase(),
      phoneE164: `+9198100${String(leadSeq).padStart(5, '0')}`,
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: 'MANUAL',
      salesStage: opts.stage ?? 'NEW',
      mergedIntoLeadId: opts.mergedIntoLeadId ?? null,
      createdAt: opts.createdAt ?? ago(30 * DAY),
    },
  });
}

let quoteSeq = 0;
type QuoteStatus = Prisma.QuoteUncheckedCreateInput['status'];

/**
 * A quote with one version per entry of `totals` (paise; the last is current), stored directly in
 * the given status. `accepted` marks the current version as the accepted one (ACCEPTED quotes).
 */
export async function insertQuote(
  db: PrismaClient,
  opts: { workspaceId?: string; leadId?: string; status: NonNullable<QuoteStatus>; totals: bigint[]; validUntil?: Date; acceptedAt?: Date },
) {
  quoteSeq += 1;
  const workspaceId = opts.workspaceId ?? WS_A;
  const slug = workspaceId === WS_A ? 'smile-avenue-dental' : workspaceId === WS_B ? 'ironpulse-fitness' : null;
  if (!slug) throw new Error('insertQuote: unknown workspace');
  const leadId = opts.leadId ?? (await insertLead(db, { workspaceId })).id;
  const validUntil = opts.validUntil ?? ahead(10 * DAY);
  const createdBy = workspaceId === WS_A ? OWNER_A : seedId('user', 'rohan');
  const quote = await db.quote.create({ data: { workspaceId, leadId, number: `M-${String(quoteSeq).padStart(4, '0')}`, status: 'DRAFT', createdBy } });
  let versionId = '';
  for (const [i, total] of opts.totals.entries()) {
    const v = await db.quoteVersion.create({
      data: {
        workspaceId,
        quoteId: quote.id,
        versionNo: i + 1,
        pricingVersionId: seedId('pricing-version', `${slug}:1`),
        snapshot: {},
        scopeText: 'Scope',
        timelineText: 'Two weeks',
        subtotalPaise: total,
        discountPaise: 0n,
        taxablePaise: total,
        taxPaise: 0n,
        totalPaise: total,
        validUntil,
        aiPolicyFlags: [],
        reviewReasons: [],
        createdBy,
        createdAt: ago(5 * DAY),
      },
    });
    versionId = v.id;
  }
  const accepted = opts.status === 'ACCEPTED';
  const updated = await db.quote.update({
    where: { id: quote.id },
    data: { status: opts.status, currentVersionId: versionId, currentVersionNo: opts.totals.length, validUntil, ...(accepted ? { acceptedVersionId: versionId } : {}) },
  });
  if (accepted) {
    await db.quoteAcceptance.create({
      data: { workspaceId, quoteId: quote.id, quoteVersionId: versionId, acceptorName: 'Customer', ipHash: 'x', userAgent: 'vitest', acceptedAt: opts.acceptedAt ?? ago(DAY) },
    });
  }
  return { quote: updated, versionId, leadId };
}

let convSeq = 0;
export async function insertConversation(db: PrismaClient, opts: { workspaceId?: string; leadId?: string; closed?: boolean; takeover?: boolean } = {}) {
  convSeq += 1;
  const workspaceId = opts.workspaceId ?? WS_A;
  const leadId = opts.leadId ?? (await insertLead(db, { workspaceId })).id;
  return db.conversation.create({
    data: {
      workspaceId,
      leadId,
      channel: 'WHATSAPP',
      contactKey: `metrics-ck-${convSeq}`,
      humanTakeover: opts.takeover ?? false,
      closedAt: opts.closed ? ago(DAY) : null,
      createdAt: ago(3 * DAY),
    },
  });
}

export async function insertOutbound(db: PrismaClient, opts: { conversationId: string; workspaceId?: string; status: Prisma.MessageUncheckedCreateInput['status']; createdAt?: Date }) {
  return db.message.create({
    data: {
      workspaceId: opts.workspaceId ?? WS_A,
      conversationId: opts.conversationId,
      channel: 'WHATSAPP',
      direction: 'OUT',
      kind: 'TEXT',
      body: 'Hello',
      status: opts.status,
      statusRank: 0,
      simulated: true,
      sendIntent: 'MANUAL_SINGLE',
      initiatedBy: OWNER_A,
      createdAt: opts.createdAt ?? ago(DAY),
    },
  });
}

export async function insertApproval(
  db: PrismaClient,
  opts: {
    workspaceId?: string;
    kind: Prisma.ApprovalUncheckedCreateInput['kind'];
    status: NonNullable<Prisma.ApprovalUncheckedCreateInput['status']>;
    quoteId?: string | null;
    quoteVersionId?: string | null;
    messageId?: string | null;
    requestedAt?: Date;
    decidedBy?: string | null;
    decidedAt?: Date | null;
    invalidatedAt?: Date | null;
    invalidationReason?: string | null;
  },
) {
  return db.approval.create({
    data: {
      workspaceId: opts.workspaceId ?? WS_A,
      kind: opts.kind,
      status: opts.status,
      quoteId: opts.quoteId ?? null,
      quoteVersionId: opts.quoteVersionId ?? null,
      messageId: opts.messageId ?? null,
      flags: [],
      requestedAt: opts.requestedAt ?? ago(DAY),
      decidedBy: opts.decidedBy ?? null,
      decidedAt: opts.decidedAt ?? null,
      invalidatedAt: opts.invalidatedAt ?? null,
      invalidationReason: opts.invalidationReason ?? null,
    },
  });
}

let callSeq = 0;
export async function insertCallRequest(db: PrismaClient, opts: { workspaceId?: string; status: NonNullable<Prisma.CallRequestUncheckedCreateInput['status']> }) {
  callSeq += 1;
  const workspaceId = opts.workspaceId ?? WS_A;
  const lead = await insertLead(db, { workspaceId });
  return db.callRequest.create({ data: { workspaceId, leadId: lead.id, source: 'MANUAL', status: opts.status, requestedAt: ago(callSeq * 60_000) } });
}

let auditSeq = 0;
export async function insertAudit(
  db: PrismaClient,
  opts: {
    workspaceId?: string | null;
    actorUserId?: string | null;
    actorKind?: Prisma.AuditEventUncheckedCreateInput['actorKind'];
    action: string;
    targetType?: string;
    targetId?: string;
    result?: Prisma.AuditEventUncheckedCreateInput['result'];
    summary?: Prisma.InputJsonValue;
    createdAt?: Date;
  },
) {
  auditSeq += 1;
  return db.auditEvent.create({
    data: {
      workspaceId: opts.workspaceId === undefined ? WS_A : opts.workspaceId,
      actorUserId: opts.actorUserId ?? null,
      actorKind: opts.actorKind ?? 'EMPLOYEE',
      action: opts.action,
      targetType: opts.targetType ?? 'Lead',
      targetId: opts.targetId ?? `target-${auditSeq}`,
      result: opts.result ?? 'SUCCESS',
      summary: opts.summary ?? {},
      correlationId: `req_metrics_audit_${auditSeq}`,
      createdAt: opts.createdAt ?? ago(DAY),
    },
  });
}
