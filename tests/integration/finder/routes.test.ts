// ADR-118 (slice F1): the Lead Finder routes and page over the real route wrapper.
// - POST /api/app/finder/runs starts a run for the console target (slug), GET lists runs, GET
//   /runs/[id] answers the filtered results, POST /import imports, GET /export is an xlsx
//   attachment (nosniff, requester only), POST /cancel and /refresh answer their counts.
// - The `finderRun` limit (10 starts per workspace an hour) answers 429 with Retry-After.
// - The DEMO page renders the run, the "No website listed" chip and the Simulated chip and no
//   Google attribution; a LIVE workspace without a Google Places key shows the configuration gate
//   linking to the setup page, and with results shows the Google Maps attribution line.
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CsrfProvider } from '@/components/patterns/csrf';
import FinderPage from '@/app/dashboard/employee/[ws]/finder/page';
import { GET as listRoute, POST as startRoute } from '@/app/api/app/finder/runs/route';
import { GET as viewRoute } from '@/app/api/app/finder/runs/[runId]/route';
import { POST as importRoute } from '@/app/api/app/finder/runs/[runId]/import/route';
import { GET as exportRoute } from '@/app/api/app/finder/runs/[runId]/export/route';
import { POST as cancelRoute } from '@/app/api/app/finder/runs/[runId]/cancel/route';
import { POST as refreshRoute } from '@/app/api/app/finder/runs/[runId]/refresh/route';
import { readTable } from '@/lib/spreadsheet';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { createRateLimiters } from '@/server/security/rate-limit';
import { GOOGLE_MAPS_TERMS_LINE } from '@/server/services/lead-finder/schemas';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest, testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createDemoHarness, createLiveHarness, drain, PEPPER, storePlacesKey, WS_A_SLUG, type DemoHarness, type LiveHarness } from './support';
import { placesAnswer, SEARCH_PATH } from './places-support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), usePathname: () => '/', useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

const markup = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement));
const text = (el: unknown) => markup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

describe('DEMO routes and page', () => {
  let h: DemoHarness;
  let runtime: TestRuntime;
  let auth: { cookie: string; csrf: string };

  beforeAll(async () => {
    h = await createDemoHarness('finder-routes');
    runtime = useRuntime(h.db, testConfig('demo', { SUPPRESSION_PEPPER: PEPPER }), h.clock);
    const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', 'employee') } });
    const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'f', userAgent: 'vitest', now: h.clock.now() });
    auth = { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id) };
    pageHeaders.current = new Headers({ cookie: auth.cookie });
  }, 120_000);
  afterAll(async () => {
    uninstallRuntime();
    await h?.testDb.destroy();
  });

  it('start, list, view with filters, import, export, cancel and refresh', async () => {
    const start = await startRoute(
      makeRequest('/api/app/finder/runs', { body: { workspaceSlug: WS_A_SLUG, requestKey: 'finder-route-0001', keywords: ['restaurants', ' restaurants '], locations: ['Indore'], maxPerQuery: 20 }, ...auth }),
      params({}),
    );
    expect(start.status).toBe(200);
    const { run, created } = (await start.json()) as { run: { id: string; status: string; keywords: string[] }; created: boolean };
    expect(created).toBe(true);
    expect(run.keywords).toEqual(['restaurants']);
    await drain(h.worker);

    const list = await listRoute(makeRequest(`/api/app/finder/runs?workspaceSlug=${WS_A_SLUG}`, { cookie: auth.cookie }), params({}));
    expect(((await list.json()) as { runs: Array<{ id: string; status: string }> }).runs[0]).toMatchObject({ id: run.id, status: 'SUCCEEDED' });

    const view = await viewRoute(makeRequest(`/api/app/finder/runs/${run.id}?workspaceSlug=${WS_A_SLUG}&noWebsite=1&hasPhone=1`, { cookie: auth.cookie }), params({ runId: run.id }));
    expect(view.status).toBe(200);
    const v = (await view.json()) as { results: Array<{ id: string; websiteListed: boolean; hasPhone: boolean }>; counts: { all: number } };
    expect(v.results.length).toBeGreaterThan(0);
    expect(v.results.every((r) => !r.websiteListed && r.hasPhone)).toBe(true);

    const imp = await importRoute(makeRequest(`/api/app/finder/runs/${run.id}/import`, { body: { workspaceSlug: WS_A_SLUG, requestKey: 'finder-route-import-1', resultIds: v.results.slice(0, 2).map((r) => r.id) }, ...auth }), params({ runId: run.id }));
    expect(imp.status).toBe(200);
    expect(((await imp.json()) as { counts: { accepted: number } }).counts.accepted).toBe(2);

    const file = await exportRoute(makeRequest(`/api/app/finder/runs/${run.id}/export?workspaceSlug=${WS_A_SLUG}`, { cookie: auth.cookie }), params({ runId: run.id }));
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="finder-smile-avenue-dental-\d{8}-\d{4}\.xlsx"$/);
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('cache-control')).toBe('no-store');
    const table = readTable(new Uint8Array(await file.arrayBuffer()), 'finder.xlsx');
    expect(table.rows[0]![0]).toBe('Simulated');
    expect(table.rows).toHaveLength(1 + v.counts.all);

    const cancel = await cancelRoute(makeRequest(`/api/app/finder/runs/${run.id}/cancel`, { body: { workspaceSlug: WS_A_SLUG }, ...auth }), params({ runId: run.id }));
    expect(await cancel.json()).toMatchObject({ cancelled: false, run: { status: 'SUCCEEDED' } });

    const refresh = await refreshRoute(makeRequest(`/api/app/finder/runs/${run.id}/refresh`, { body: { workspaceSlug: WS_A_SLUG, resultIds: [v.results[0]!.id] }, ...auth }), params({ runId: run.id }));
    expect(await refresh.json()).toMatchObject({ refreshed: 0, notExpired: 1 });

    // The page: the run, its filters, the No website chip and the Simulated chip; no Google attribution.
    const page = await FinderPage({ params: Promise.resolve({ ws: WS_A_SLUG }), searchParams: Promise.resolve({ run: run.id, noWebsite: '1' }) });
    const html = markup(page);
    const words = text(page);
    expect(words).toContain('Lead finder');
    expect(words).toContain('restaurants in Indore');
    expect(words).toContain('No website listed');
    expect(words).toContain('Simulated');
    expect(words).toContain('Download Excel');
    expect(words).toContain('Import selected');
    expect(html).toContain('data-places-attribution="simulated"');
    expect(words).not.toContain('Results from Google Maps');
    expect(html).toContain('aria-pressed="true" data-filter="noWebsite"');
  });

  it('the finderRun limit answers 429 with Retry-After after 10 starts in an hour', async () => {
    runtime.limiters = createRateLimiters(runtime.clock);
    for (let i = 0; i < 10; i += 1) {
      const res = await startRoute(makeRequest('/api/app/finder/runs', { body: { workspaceSlug: WS_A_SLUG, requestKey: `finder-limit-${String(i).padStart(4, '0')}`, keywords: ['gym'], locations: ['Ujjain'], maxPerQuery: 20 }, ...auth }), params({}));
      expect(res.status, `start ${i}`).toBe(200);
      await drain(h.worker);
    }
    const limited = await startRoute(makeRequest('/api/app/finder/runs', { body: { workspaceSlug: WS_A_SLUG, requestKey: 'finder-limit-0010', keywords: ['gym'], locations: ['Ujjain'], maxPerQuery: 20 }, ...auth }), params({}));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // A replay of a known request key is answered, not limited.
    const replay = await startRoute(makeRequest('/api/app/finder/runs', { body: { workspaceSlug: WS_A_SLUG, requestKey: 'finder-limit-0003', keywords: ['gym'], locations: ['Ujjain'], maxPerQuery: 20 }, ...auth }), params({}));
    expect(replay.status).toBe(200);
  });

  it('refuses more than 10 keywords with a validation error', async () => {
    const res = await startRoute(
      makeRequest('/api/app/finder/runs', { body: { workspaceSlug: WS_A_SLUG, requestKey: 'finder-route-0099', keywords: Array.from({ length: 11 }, (_, i) => `kw ${i}`), locations: ['Indore'], maxPerQuery: 20 }, ...auth }),
      params({}),
    );
    expect(res.status).toBe(400);
  });
});

describe('LIVE page', () => {
  let h: LiveHarness;
  let employeeId: string;

  beforeAll(async () => {
    h = await createLiveHarness('finder-live-page');
    const employee = await h.db.user.create({ data: { email: 'operator@live-finder.test', name: 'Live Operator', globalRole: 'EMPLOYEE', isDemo: false } });
    employeeId = employee.id;
    await h.db.employeeAssignment.create({ data: { employeeUserId: employee.id, workspaceId: h.wsId, capabilities: ['leads.read', 'leads.write', 'leads.export', 'finder.run'], active: true, createdBy: h.ownerId } });
    const { token } = await createSession(h.db, { userId: employee.id, globalRole: 'EMPLOYEE', mode: 'LIVE', activeWorkspaceId: null, ipHash: 'f', userAgent: 'vitest', now: h.clock.now() });
    pageHeaders.current = new Headers({ cookie: `${sessionCookieName(h.config)}=${token}` });
  }, 120_000);
  afterAll(async () => {
    await h?.destroy();
  });

  it('without a key: the search is gated on configuration with a link to the setup', async () => {
    const page = await FinderPage({ params: Promise.resolve({ ws: 'live-finder-co' }), searchParams: Promise.resolve({}) });
    const html = markup(page);
    expect(html).toContain('data-gate-category="configuration"');
    expect(text(page)).toContain('Save a Google Places API key first');
    expect(html).toContain('href="/dashboard/employee/live-finder-co/integrations/google-places"');
    expect(text(page)).not.toContain('Simulated');
  });

  it('with results: the Google Maps attribution and the terms line', async () => {
    await storePlacesKey(h);
    h.graph.on('POST', SEARCH_PATH, placesAnswer('response.search-page-1.json'));
    const { startFinderRun } = await import('@/server/services/lead-finder/runs');
    const { sessionCtx } = await import('./support');
    const ctx = await sessionCtx(h.db, h.clock, employeeId, 'live', 'live-finder-co');
    const { run } = await startFinderRun(ctx, { requestKey: 'finder-live-page-1', keywords: ['dental clinic'], locations: ['Indore'], maxPerQuery: 20, extractEmails: false, emailBlacklist: [] }, h.deps());
    await drain(h.worker);
    const page = await FinderPage({ params: Promise.resolve({ ws: 'live-finder-co' }), searchParams: Promise.resolve({ run: run.id }) });
    const html = markup(page);
    const words = text(page);
    expect(html).toContain('data-places-attribution="google"');
    expect(words).toContain('Google Maps');
    // The terms line reads exactly as ADR-118 words it (its two document names are links).
    expect(/<p data-google-terms="">(.*?)<\/p>/.exec(html)![1]!.replace(/<[^>]+>/g, '')).toBe(GOOGLE_MAPS_TERMS_LINE);
    expect(words).toContain('Fixture Listings Partner');
    expect(html).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=dental+clinic+Indore&amp;query_place_id=ChIJF1nderFixtureSmileDental01"');
    expect(html).not.toContain('data-gate-category="configuration"');
  });
});
