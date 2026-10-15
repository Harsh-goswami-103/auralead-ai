/**
 * Plan §6.1 CAS rules (T15): approve and revise carry the version number the editor saw.
 * Approving expectedVersion 1 after v2 exists is 409; two editors revising v1 at the same time
 * (two Prisma clients, two SQLite connections) give exactly one v2 and one 409; transitions out
 * of ACCEPTED or CANCELLED are 409. The same answers come back through the real route handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { buildUserContext } from '@/server/auth/context';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, loadSession, sessionCookieName } from '@/server/auth/session';
import { approveQuote, cancelQuote, createQuote, reviseQuote } from '@/server/services/quotes/versioning';
import * as approveRoute from '@/app/api/app/quotes/[quoteId]/approve/route';
import * as reviseRoute from '@/app/api/app/quotes/[quoteId]/revise/route';
import * as quotesRoute from '@/app/api/app/quotes/route';
import * as detailRoute from '@/app/api/app/quotes/[quoteId]/route';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest, testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createLead, createQuoteHarness, ownerCtx, SERVICE, type QuoteHarness } from './support';

let h: QuoteHarness;
let db: PrismaClient;
let second: PrismaClient;
let runtime: TestRuntime;

beforeAll(async () => {
  h = await createQuoteHarness('quote-conflict');
  db = h.db;
  second = h.testDb.client();
  runtime = useRuntime(db, testConfig('demo'), h.clock);
});
afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

const line = (qty: number) => ({ items: [{ serviceId: SERVICE.CONSULT, qty }], discount: { kind: 'NONE' as const, value: 0n }, scopeText: 'Consultation', timelineText: 'Same day' });

async function newQuote() {
  const ctx = await ownerCtx(h);
  const lead = await createLead(db);
  return { ctx, lead, ...(await createQuote(ctx, { leadId: lead.id, ...line(1) })) };
}

type Handler = (req: Request, segment: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function ownerSession() {
  const userId = seedId('user', 'owner');
  const { token, session } = await createSession(db, { userId, globalRole: 'USER', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id) };
}

async function call(handler: Handler, path: string, opts: { body?: unknown; params?: Record<string, string>; method?: string } = {}) {
  const who = await ownerSession();
  const req = makeRequest(path, { method: opts.method, body: opts.body, cookie: who.cookie, csrf: who.csrf });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

describe('quote version conflicts', () => {
  it('approve with expectedVersion 1 after v2 exists is 409 and changes nothing', async () => {
    const { ctx, quote } = await newQuote();
    await reviseQuote(ctx, quote.id, { expectedVersion: 1, ...line(2) });
    await expect(approveQuote(ctx, quote.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: 'QUOTE_VERSION_CONFLICT' });
    const row = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(row).toMatchObject({ status: 'DRAFT', currentVersionNo: 2 });
    expect(await db.approval.count({ where: { quoteId: quote.id, status: 'APPROVED' } })).toBe(0);
    expect((await approveQuote(ctx, quote.id, { expectedVersion: 2 })).quote.status).toBe('APPROVED');
  });

  it('two editors revising v1 at once: one v2, one 409', async () => {
    const { lead, quote } = await newQuote();
    const session = async (client: PrismaClient) => {
      const { token } = await createSession(client, { userId: seedId('user', 'owner'), globalRole: 'USER', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
      const loaded = (await loadSession(client, token, { now: h.clock.now(), mode: 'DEMO' }))!;
      return buildUserContext(loaded, { prisma: client, mode: 'demo', clock: h.clock }, { correlationId: `req_conflict_${client === db ? 'a' : 'b'}_000` });
    };
    const [a, b] = await Promise.all([session(db), session(second)]);
    const results = await Promise.allSettled([reviseQuote(a, quote.id, { expectedVersion: 1, ...line(2) }), reviseQuote(b, quote.id, { expectedVersion: 1, ...line(3) })]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409, code: 'QUOTE_VERSION_CONFLICT' });
    expect(await db.quoteVersion.count({ where: { quoteId: quote.id } })).toBe(2);
    expect(await db.approval.count({ where: { quoteId: quote.id, status: 'PENDING' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { targetId: quote.id, action: 'quote.revise' } })).toBe(1);
    expect(lead.id).toBeTruthy();
  });

  it('nothing leaves ACCEPTED or CANCELLED', async () => {
    const { ctx, quote } = await newQuote();
    await db.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });
    await expect(reviseQuote(ctx, quote.id, { expectedVersion: 1, ...line(2) })).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    await expect(cancelQuote(ctx, quote.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });

    const other = await newQuote();
    await cancelQuote(other.ctx, other.quote.id, { expectedVersion: 1 });
    await expect(approveQuote(other.ctx, other.quote.id, { expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    await expect(reviseQuote(other.ctx, other.quote.id, { expectedVersion: 1, ...line(2) })).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    expect(await db.quoteVersion.count({ where: { quoteId: other.quote.id } })).toBe(1);
  });

  it('the routes create, revise and answer a stale approve with 409', async () => {
    const lead = await createLead(db);
    const created = await call(quotesRoute.POST as Handler, '/api/app/quotes', {
      body: { leadId: lead.id, items: [{ serviceId: SERVICE.WHITEN, qty: 1 }], discount: { kind: 'PERCENT_BPS', value: '500' }, scopeText: 'Whitening', timelineText: 'One visit' },
    });
    expect(created.status).toBe(200);
    const quote = created.body.quote as { id: string; currentVersionNo: number; status: string };
    expect(quote).toMatchObject({ currentVersionNo: 1, status: 'DRAFT' });
    expect((created.body.version as { totalPaise: string }).totalPaise).toBe('952850');

    const revised = await call(reviseRoute.POST as Handler, `/api/app/quotes/${quote.id}/revise`, {
      params: { quoteId: quote.id },
      body: { expectedVersion: 1, items: [{ serviceId: SERVICE.WHITEN, qty: 2 }], discount: { kind: 'NONE', value: '0' }, scopeText: 'Whitening x2', timelineText: 'Two visits' },
    });
    expect(revised.status).toBe(200);
    const stale = await call(approveRoute.POST as Handler, `/api/app/quotes/${quote.id}/approve`, { params: { quoteId: quote.id }, body: { expectedVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('QUOTE_VERSION_CONFLICT');
    const ok = await call(approveRoute.POST as Handler, `/api/app/quotes/${quote.id}/approve`, { params: { quoteId: quote.id }, body: { expectedVersion: 2 } });
    expect(ok.status).toBe(200);

    const detail = await call(detailRoute.GET as Handler, `/api/app/quotes/${quote.id}`, { params: { quoteId: quote.id }, method: 'GET' });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ quote: { status: 'APPROVED', currentVersionNo: 2 } });
    const list = await call(quotesRoute.GET as Handler, '/api/app/quotes', { method: 'GET' });
    expect((list.body.quotes as Array<{ id: string }>).some((q) => q.id === quote.id)).toBe(true);

    const bad = await call(quotesRoute.POST as Handler, '/api/app/quotes', { body: { leadId: lead.id, items: [], discount: { kind: 'NONE', value: '0' }, scopeText: 'x', timelineText: 'y' } });
    expect(bad.status).toBe(400);
  });
});
