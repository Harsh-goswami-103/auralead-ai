/**
 * T27 quotations list filters: the status filter uses the status a reader sees (an approved, sent
 * or opened quote past its validity is EXPIRED before the sweep runs, and is not SENT any more);
 * search matches the quote number or the lead's name through the normalised column (case and
 * accents folded); "needs pricing review" narrows to flagged drafts; the status counts cover every
 * quotation matching the search, not just the listed rows; everything stays inside the caller's
 * workspace. The page renders the filter form with the current values and an honest empty state.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { CsrfProvider } from '@/components/patterns/csrf';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { countQuotesByStatus, listQuotesFiltered, parseQuoteListFilters } from '@/server/services/quotes/list';
import QuotationsPage from '@/app/dashboard/user/quotations/page';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { ago, ahead, createMetricsHarness, ctxFor, DAY, destroyHarness, insertLead, insertQuote, NOW, WS_A, WS_B, type MetricsHarness } from '../metrics/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

let h: MetricsHarness;
let db: PrismaClient;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await createMetricsHarness('quote-list-filters');
  db = h.db;
  const renu = await insertLead(db, { name: 'Rénu Dental Care' });
  const arjun = await insertLead(db, { name: 'Arjun Gym' });
  ids.draft = (await insertQuote(db, { status: 'DRAFT', totals: [100n], leadId: renu.id })).quote.id;
  ids.sent = (await insertQuote(db, { status: 'SENT', totals: [200n], leadId: arjun.id, validUntil: ahead(DAY) })).quote.id;
  ids.sentLapsed = (await insertQuote(db, { status: 'SENT', totals: [300n], leadId: renu.id, validUntil: ago(60_000) })).quote.id;
  ids.expired = (await insertQuote(db, { status: 'EXPIRED', totals: [400n], validUntil: ago(DAY) })).quote.id;
  ids.approvedLapsed = (await insertQuote(db, { status: 'APPROVED', totals: [500n], validUntil: ago(1) })).quote.id;
  const review = await insertQuote(db, { status: 'DRAFT', totals: [600n] });
  await db.quote.update({ where: { id: review.quote.id }, data: { needsPricingReview: true } });
  ids.review = review.quote.id;
  ids.foreign = (await insertQuote(db, { workspaceId: WS_B, status: 'SENT', totals: [700n], validUntil: ahead(DAY) })).quote.id;
});
afterAll(async () => {
  await destroyHarness(h);
});

const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe('listQuotesFiltered', () => {
  it('filters by the status a reader sees', async () => {
    const ctx = await ctxFor(h, 'owner');
    expect(idsOf(await listQuotesFiltered(ctx, { status: 'SENT' }))).toEqual([ids.sent].sort());
    expect(idsOf(await listQuotesFiltered(ctx, { status: 'EXPIRED' }))).toEqual([ids.sentLapsed, ids.expired, ids.approvedLapsed].sort());
    expect(idsOf(await listQuotesFiltered(ctx, { status: 'APPROVED' }))).toEqual([]);
    expect((await listQuotesFiltered(ctx, { status: 'EXPIRED' })).every((r) => r.effectiveStatus === 'EXPIRED')).toBe(true);
  });

  it('searches the quote number and the normalised lead name', async () => {
    const ctx = await ctxFor(h, 'owner');
    const number = (await db.quote.findUniqueOrThrow({ where: { id: ids.sent } })).number;
    expect(idsOf(await listQuotesFiltered(ctx, { q: number.toLowerCase() }))).toEqual([ids.sent]);
    expect(idsOf(await listQuotesFiltered(ctx, { q: 'RENU dental' }))).toEqual([ids.draft, ids.sentLapsed].sort());
    expect(idsOf(await listQuotesFiltered(ctx, { q: 'renu', status: 'EXPIRED' }))).toEqual([ids.sentLapsed]);
  });

  it('narrows to drafts that need a pricing review', async () => {
    const ctx = await ctxFor(h, 'owner');
    expect(idsOf(await listQuotesFiltered(ctx, { needsReview: true }))).toEqual([ids.review]);
  });

  it('counts every matching quotation by the status a reader sees, inside the workspace only', async () => {
    const ctx = await ctxFor(h, 'owner');
    const counts = await countQuotesByStatus(ctx, {});
    expect(counts).toMatchObject({ DRAFT: 2, SENT: 1, EXPIRED: 3, APPROVED: 0 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(await db.quote.count({ where: { workspaceId: WS_A } }));
    expect(await countQuotesByStatus(ctx, { q: 'arjun' })).toMatchObject({ SENT: 1, DRAFT: 0, EXPIRED: 0 });
    expect((await listQuotesFiltered(ctx, {})).some((r) => r.id === ids.foreign)).toBe(false);
  });

  it('parses query strings leniently: unknown values are ignored, never an error', () => {
    expect(parseQuoteListFilters({ status: 'SENT', q: '  renu  ', review: '1' })).toEqual({ status: 'SENT', q: 'renu', needsReview: true });
    expect(parseQuoteListFilters({ status: 'BOGUS', q: '', review: 'no' })).toEqual({});
    expect(parseQuoteListFilters({ status: ['VIEWED', 'SENT'], q: 'x'.repeat(300) })).toEqual({ status: 'VIEWED', q: 'x'.repeat(100) });
  });
});

describe('quotations page', () => {
  const html = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('renders the filter form with its values, filtered rows and the clear link', async () => {
    const runtime = useRuntime(h.db, testConfig('demo'), h.clock);
    try {
      const { token } = await createSession(h.db, { userId: seedId('user', 'owner'), globalRole: 'USER', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: NOW });
      pageHeaders.current = new Headers({ cookie: `${sessionCookieName(runtime.config)}=${token}` });
      const markup = renderToStaticMarkup(
        createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, (await QuotationsPage({ searchParams: Promise.resolve({ status: 'EXPIRED', q: 'renu' }) })) as ReactElement),
      );
      expect(markup).toMatch(/<input[^>]*name="q"[^>]*value="renu"/);
      expect(markup).toMatch(/<option[^>]*value="EXPIRED"[^>]*selected/);
      expect(markup).toContain('href="/dashboard/user/quotations"');
      const text = html((await QuotationsPage({ searchParams: Promise.resolve({ status: 'EXPIRED', q: 'renu' }) })) as ReactElement);
      expect(text).toContain('1 quotation matches');
      expect(text).toContain('Rénu Dental Care');
      expect(text).not.toContain('Arjun Gym');

      const none = html((await QuotationsPage({ searchParams: Promise.resolve({ q: 'no such lead' }) })) as ReactElement);
      expect(none).toContain('No quotations match');
      expect(none).toContain('Clear filters');
    } finally {
      uninstallRuntime();
    }
  });
});
