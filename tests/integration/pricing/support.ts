/**
 * Shared harness for the T13 pricing tests: a LIVE runtime on a real test DB with two workspaces
 * (alpha with an owner, a member and an employee; beta as the foreign tenant), signed-in requests
 * through the real route handlers, contexts for direct service calls, and a minimal issued quote
 * (lead, quote, version, item) so "referenced" services and snapshots can be checked.
 */
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, loadSession, sessionCookieName } from '@/server/auth/session';
import { makeRequest, NOW, type TestRuntime } from '../auth/support';

export type SignedIn = { cookie: string; csrf: string; userId: string };

export async function signIn(db: PrismaClient, runtime: TestRuntime, userId: string, globalRole: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN', activeWorkspaceId: string | null = null): Promise<SignedIn> {
  const { token, session } = await createSession(db, {
    userId,
    globalRole,
    mode: 'LIVE',
    activeWorkspaceId,
    ipHash: 'pricing-test',
    userAgent: 'vitest',
    now: runtime.clock.now(),
  });
  return { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id), userId };
}

export async function contextFor(db: PrismaClient, clock: FixedClock, userId: string, globalRole: 'USER' | 'EMPLOYEE', activeWorkspaceId: string | null = null): Promise<AppCtx> {
  const { token } = await createSession(db, { userId, globalRole, mode: 'LIVE', activeWorkspaceId, ipHash: 'x', userAgent: 'vitest', now: clock.now() });
  const loaded = (await loadSession(db, token, { now: clock.now(), mode: 'LIVE' }))!;
  return buildUserContext(loaded, { prisma: db, mode: 'live', clock }, { correlationId: `req_pricing_${userId.slice(0, 12)}` });
}

type Handler = (req: Request, segment: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function call(handler: Handler, path: string, who: SignedIn | null, opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const req = makeRequest(path, { method: opts.method, body: opts.body, cookie: who?.cookie ?? null, csrf: who?.csrf ?? null });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> & { code?: string } };
}

/** An issued quote (v1) with one item on `serviceId`, created straight through the client. */
export async function createIssuedQuote(db: PrismaClient, workspaceId: string, pricingVersionId: string, serviceId: string, unitPricePaise: bigint) {
  const t = new Date(NOW);
  const lead = await db.lead.create({
    data: {
      workspaceId,
      displayName: 'Issued Quote Lead',
      nameNormalized: 'issued quote lead',
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: 'MANUAL',
      createdAt: t,
    },
  });
  const count = await db.quote.count({ where: { workspaceId } });
  const quote = await db.quote.create({ data: { workspaceId, leadId: lead.id, number: `Q-${String(count + 1).padStart(4, '0')}`, createdBy: 'test', createdAt: t } });
  const version = await db.quoteVersion.create({
    data: {
      workspaceId,
      quoteId: quote.id,
      versionNo: 1,
      pricingVersionId,
      snapshot: {},
      scopeText: 'Scope',
      timelineText: '2 weeks',
      subtotalPaise: unitPricePaise,
      discountPaise: 0n,
      taxablePaise: unitPricePaise,
      taxPaise: 0n,
      totalPaise: unitPricePaise,
      validUntil: new Date(t.getTime() + 15 * 86_400_000),
      aiPolicyFlags: [],
      reviewReasons: [],
      createdBy: 'test',
      createdAt: t,
    },
  });
  const item = await db.quoteItem.create({
    data: { workspaceId, quoteVersionId: version.id, serviceId, serviceNameSnapshot: 'Snapshot name', unitLabel: 'unit', qty: 1, unitPricePaise, lineTotalPaise: unitPricePaise, position: 0 },
  });
  await db.quote.update({ where: { id: quote.id }, data: { currentVersionId: version.id, currentVersionNo: 1 } });
  return { leadId: lead.id, quoteId: quote.id, quoteVersionId: version.id, quoteItemId: item.id };
}
