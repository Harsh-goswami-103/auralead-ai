// ADR-118 (slice F1, P1): website email extraction, the 30-day expiry of Places details on
// imported leads, and the operator's "Confirm details".
// - LIVE: `leadFinder.emails` reads only the listed website through the production `safeFetch`
//   (stub resolver + `connectTo` onto a local server, every SSRF check still real), with the bot
//   User-Agent: robots.txt first (a site that disallows the bot is BLOCKED and its pages are never
//   read), the home page and at most two same-host contact pages; it keeps `{address, sourceUrl,
//   kind}`, drops placeholders and the run's blacklist; an unreadable site is FAILED.
// - DEMO: simulated `@demo-leads.in` addresses, the blacklist applied, nothing fetched.
// - `leads.placesExpire` nulls the Places-sourced fields of unconfirmed imported leads after 30
//   days (phone keys removed, place ID and name kept) and re-arms; a confirmed lead keeps them.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as confirmRoute } from '@/app/api/app/leads/[leadId]/confirm-contact/route';
import { outboundAttempts, resetOutboundAttempts } from '@/server/adapters/http/outbound';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { createLeadFinderEmailsJob } from '@/server/jobs/handlers/lead-finder-emails';
import { createLeadFinderPurgeJob } from '@/server/jobs/handlers/lead-finder-purge';
import { createLeadFinderSearchJob } from '@/server/jobs/handlers/lead-finder-search';
import { createLeadsPlacesExpireJob } from '@/server/jobs/handlers/leads-places-expire';
import { safeFetch, type LookupAll } from '@/server/security/safe-fetch';
import { importFinderResults } from '@/server/services/lead-finder/import';
import { confirmLeadContact } from '@/server/services/lead-finder/places-expire';
import { startFinderRun } from '@/server/services/lead-finder/runs';
import { StartFinderRunBody } from '@/server/services/lead-finder/schemas';
import { finderEmails } from '@/server/services/lead-finder/runs';
import type { PageFetcher } from '@/server/services/lead-finder/emails';
import { PermissionDeniedError } from '@/lib/errors';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest, testConfig, uninstallRuntime, useRuntime as installRuntime } from '../auth/support';
import { SEARCH_PATH } from './places-support';
import { createDemoHarness, createLiveHarness, DAY, drain, INGEST, NOW, PEPPER, storePlacesKey, workerFor, WS_A, WS_A_SLUG, type DemoHarness, type LiveHarness } from './support';

const PUBLIC_IP = '93.184.215.14';

type Site = { fetchPage: PageFetcher; requests: Array<{ host: string; path: string; ua: string }>; close: () => Promise<void> };

const PAGES: Record<string, Record<string, { status?: number; type?: string; body: string }>> = {
  'alpha.test': {
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private\n' },
    '/': { body: '<a href="mailto:info@alpha.test">Mail</a> <p>Call us. care@alpha.test</p> <a href="/contact">Contact</a> <a href="/private/contact">Private contact</a> <a href="/about">About</a> <img src="logo@2x.png">' },
    '/contact': { body: '<p>Owner: ravi.kumar@alpha.test. Example: your@email.com</p>' },
    '/about': { body: '<p>Bookings: bookings@alpha.test, alpha.sweets@gmail.com</p>' },
    '/private/contact': { body: '<p>secret@alpha.test</p>' },
  },
  'beta.test': {
    '/robots.txt': { type: 'text/plain', body: 'User-agent: AuraLeadBot\nDisallow: /\n' },
    '/': { body: '<p>info@beta.test</p>' },
  },
  'gamma.test': {
    '/robots.txt': { status: 404, body: 'none' },
    '/': { status: 500, body: 'broken' },
  },
};

async function startSites(): Promise<Site> {
  const requests: Site['requests'] = [];
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const path = req.url ?? '/';
    requests.push({ host, path, ua: String(req.headers['user-agent'] ?? '') });
    const page = PAGES[host]?.[path];
    if (!page) return void res.writeHead(404, { 'content-type': 'text/html' }).end('not found');
    res.writeHead(page.status ?? 200, { 'content-type': `${page.type ?? 'text/html'}; charset=utf-8` }).end(page.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const lookup: LookupAll = async (hostname) => {
    if (!(hostname in PAGES)) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return [{ address: PUBLIC_IP, family: 4 }];
  };
  return {
    requests,
    fetchPage: (url, signal) => safeFetch(url, { lookup, connectTo: () => ({ host: '127.0.0.1', port }), userAgent: 'AuraLeadBot/1.0 (+http://app.test/docs/bot)', totalTimeoutMs: 8_000, maxBytes: 1024 * 1024, ...(signal ? { signal } : {}) }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('LIVE email extraction', () => {
  let h: LiveHarness;
  let site: Site;

  beforeAll(async () => {
    h = await createLiveHarness('finder-emails-live');
    site = await startSites();
    await storePlacesKey(h);
  }, 120_000);
  afterAll(async () => {
    await site?.close();
    await h?.destroy();
  });

  it('reads robots.txt, the home page and two contact pages, keeps the published addresses and honours the blacklist', async () => {
    const place = (id: string, name: string, website?: string) => ({ id, displayName: { text: name }, internationalPhoneNumber: '+91 98260 10001', ...(website ? { websiteUri: website } : {}) });
    h.graph.on('POST', SEARCH_PATH, {
      status: 200,
      body: {
        places: [
          place('ChIJEmailAlpha0001', 'Alpha Sweets', 'http://alpha.test/'),
          place('ChIJEmailBeta00002', 'Beta Bakers', 'http://beta.test/'),
          place('ChIJEmailGamma0003', 'Gamma Cafe', 'http://gamma.test/'),
          place('ChIJEmailDelta0004', 'Delta Dhaba', 'http://missing.test/'),
          place('ChIJEmailNoSite005', 'No Site Kitchen'),
        ],
      },
    });
    const worker = workerFor(h.db, h.clock, 'live', [
      createLeadFinderSearchJob({ mode: () => 'live', deps: h.deps }),
      createLeadFinderPurgeJob({ mode: () => 'live' }),
      createLeadFinderEmailsJob({ mode: () => 'live', fetchPage: () => site.fetchPage }),
    ]);
    const { run } = await startFinderRun(
      await h.owner(),
      StartFinderRunBody.parse({ requestKey: 'finder-emails-live-1', keywords: ['sweets'], locations: ['Indore'], maxPerQuery: 20, extractEmails: true, emailBlacklist: ['care@alpha.test', 'gmail.com'] }),
      h.deps(),
    );
    await drain(worker);

    const rows = await h.db.leadFinderResult.findMany({ where: { runId: run.id } });
    const by = (placeId: string) => rows.find((r) => r.placeId === placeId)!;
    const alpha = by('ChIJEmailAlpha0001');
    expect(alpha.emailStatus).toBe('FOUND');
    expect(finderEmails(alpha.emails)).toEqual([
      { address: 'info@alpha.test', sourceUrl: 'http://alpha.test/', kind: 'ROLE' },
      { address: 'ravi.kumar@alpha.test', sourceUrl: 'http://alpha.test/contact', kind: 'PERSONAL' },
      { address: 'bookings@alpha.test', sourceUrl: 'http://alpha.test/about', kind: 'ROLE' },
    ]);
    expect(alpha.emailCount).toBe(3);
    expect(by('ChIJEmailBeta00002')).toMatchObject({ emailStatus: 'BLOCKED', emailCount: 0 });
    expect(by('ChIJEmailGamma0003')).toMatchObject({ emailStatus: 'FAILED', emailCount: 0 });
    expect(by('ChIJEmailDelta0004')).toMatchObject({ emailStatus: 'FAILED', emailCount: 0 });
    expect(by('ChIJEmailNoSite005')).toMatchObject({ emailStatus: 'NO_WEBSITE', emailCount: 0 });

    expect(await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'SUCCEEDED', emailsFound: 3 });
    // Only the listed hosts, robots.txt first, never a disallowed page, always the bot User-Agent.
    expect(site.requests.filter((r) => r.host === 'alpha.test').map((r) => r.path)).toEqual(['/robots.txt', '/', '/contact', '/about']);
    expect(site.requests.filter((r) => r.host === 'beta.test').map((r) => r.path)).toEqual(['/robots.txt']);
    expect(site.requests.every((r) => r.ua.startsWith('AuraLeadBot/1.0'))).toBe(true);
    const audits = await h.db.auditEvent.findMany({ where: { action: 'finder.emails.extract', targetId: run.id } });
    expect(audits.reduce((n, a) => n + ((a.summary as { found: number }).found ?? 0), 0)).toBe(3);
    expect(JSON.stringify(audits.map((a) => a.summary))).not.toContain('@');
  });
});

describe('DEMO email extraction, Places expiry and Confirm details', () => {
  let h: DemoHarness;
  const fetched: string[] = [];

  beforeAll(async () => {
    h = await createDemoHarness('finder-emails-demo');
  }, 120_000);
  afterAll(async () => {
    uninstallRuntime();
    await h?.testDb.destroy();
  });

  function worker() {
    return workerFor(h.db, h.clock, 'demo', [
      createLeadFinderSearchJob({ mode: () => 'demo', deps: () => ({ keyRing: null }) }),
      createLeadFinderPurgeJob({ mode: () => 'demo' }),
      createLeadFinderEmailsJob({ mode: () => 'demo', fetchPage: () => (url) => (fetched.push(url), Promise.reject(new Error('DEMO must not fetch'))) }),
      createLeadsPlacesExpireJob({ mode: () => 'demo' }),
    ]);
  }

  it('DEMO finds simulated @demo-leads.in addresses, applies the blacklist and fetches nothing', async () => {
    resetOutboundAttempts();
    const ctx = await h.operator();
    const w = worker();
    const a = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: 'finder-emails-demo-1', keywords: ['dental clinic'], locations: ['Indore'], maxPerQuery: 20, extractEmails: true }), { keyRing: null });
    await drain(w);
    const rows = await h.db.leadFinderResult.findMany({ where: { runId: a.run.id } });
    for (const r of rows) {
      if (!r.websiteListed) expect(r.emailStatus).toBe('NO_WEBSITE');
      else expect(['FOUND', 'NONE_FOUND']).toContain(r.emailStatus);
      for (const e of finderEmails(r.emails)) expect(e.address.endsWith('@demo-leads.in')).toBe(true);
    }
    const found = rows.reduce((n, r) => n + r.emailCount, 0);
    expect(found).toBeGreaterThan(0);
    expect((await h.db.leadFinderRun.findUniqueOrThrow({ where: { id: a.run.id } })).emailsFound).toBe(found);

    const b = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: 'finder-emails-demo-2', keywords: ['dental clinic'], locations: ['Indore'], maxPerQuery: 20, extractEmails: true, emailBlacklist: ['demo-leads.in'] }), { keyRing: null });
    await drain(w);
    const blocked = await h.db.leadFinderResult.findMany({ where: { runId: b.run.id, websiteListed: true } });
    expect(blocked.every((r) => r.emailStatus === 'NONE_FOUND' && r.emailCount === 0)).toBe(true);
    expect(fetched).toEqual([]);
    expect(outboundAttempts()).toEqual([]);
  });

  it('after 30 days the sweep removes unconfirmed Places details and keeps confirmed ones', async () => {
    const ctx = await h.operator();
    const w = worker();
    const { run } = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: 'finder-expire-1', keywords: ['gym'], locations: ['Bhopal'], maxPerQuery: 20 }), { keyRing: null });
    await drain(w);
    const picks = await h.db.leadFinderResult.findMany({ where: { runId: run.id, hasPhone: true, websiteListed: true }, take: 2, orderBy: { createdAt: 'asc' } });
    const imported = await importFinderResults(ctx, { runId: run.id, resultIds: picks.map((p) => p.id), requestKey: 'finder-expire-import-1' }, INGEST);
    const [keepId, dropId] = imported.results.map((r) => r.leadId!);

    const confirmed = await confirmLeadContact(ctx, keepId!);
    expect(confirmed).toMatchObject({ confirmed: true, contactConfirmedVia: 'OPERATOR' });
    expect(await confirmLeadContact(ctx, keepId!)).toMatchObject({ confirmed: false });
    expect(await h.db.auditEvent.count({ where: { action: 'lead.contact_confirm', targetId: keepId } })).toBe(1);
    await expect(confirmLeadContact(await h.reader(), keepId!)).rejects.toBeInstanceOf(PermissionDeniedError);

    // A later search and import (day 10) expires later (day 40): the day-31 sweep re-arms for it.
    h.clock.set(new Date(new Date(NOW).getTime() + 10 * DAY).toISOString());
    const second = await startFinderRun(ctx, StartFinderRunBody.parse({ requestKey: 'finder-expire-2', keywords: ['bakery'], locations: ['Ujjain'], maxPerQuery: 20 }), { keyRing: null });
    await drain(w);
    const later = await h.db.leadFinderResult.findFirstOrThrow({ where: { runId: second.run.id, hasPhone: true }, orderBy: { createdAt: 'asc' } });
    const laterLeadId = (await importFinderResults(ctx, { runId: second.run.id, resultIds: [later.id], requestKey: 'finder-expire-import-2' }, INGEST)).results[0]!.leadId!;

    h.clock.set(new Date(new Date(NOW).getTime() + 31 * DAY).toISOString());
    await drain(w);
    expect((await h.db.lead.findUniqueOrThrow({ where: { id: laterLeadId } })).phoneE164).not.toBeNull();
    const rearmed = await h.db.job.findMany({ where: { type: 'leads.placesExpire', workspaceId: WS_A, status: 'QUEUED' } });
    expect(rearmed.map((j) => j.runAt.getTime())).toContain(Math.floor((new Date(NOW).getTime() + 40 * DAY) / DAY + 1) * DAY);
    const drop = await h.db.lead.findUniqueOrThrow({ where: { id: dropId! } });
    expect(drop).toMatchObject({ phoneE164: null, phoneRaw: null, rating: null, reviewCount: null, address: null, pincode: null, category: null, placesContentExpiresAt: null });
    expect(drop.alternatePhones).toEqual([]);
    expect(drop.placeId).not.toBeNull();
    expect(drop.displayName).not.toBe('');
    expect(await h.db.leadContactKey.count({ where: { leadId: dropId!, kind: 'PHONE' } })).toBe(0);
    expect(await h.db.leadContactKey.count({ where: { leadId: dropId!, kind: 'PROVIDER' } })).toBe(1);
    const keep = await h.db.lead.findUniqueOrThrow({ where: { id: keepId! } });
    expect(keep.phoneE164).not.toBeNull();
    expect(keep.placesContentExpiresAt).not.toBeNull();
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'lead.places_expire', workspaceId: WS_A } });
    expect(audit.summary).toMatchObject({ leads: 1 });
    h.clock.set(NOW);
  });

  it('the confirm-contact route needs a session target and answers the confirmation', async () => {
    const runtime = installRuntime(h.db, testConfig('demo', { SUPPRESSION_PEPPER: PEPPER }), h.clock);
    const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', 'employee') } });
    const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'c', userAgent: 'vitest', now: h.clock.now() });
    const auth = { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id) };
    const lead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: WS_A, firstSource: 'GOOGLE_PLACES', contactConfirmedAt: null, placesContentExpiresAt: { not: null } } });
    const res = await confirmRoute(makeRequest(`/api/app/leads/${lead.id}/confirm-contact`, { body: { workspaceSlug: WS_A_SLUG }, ...auth }), { params: Promise.resolve({ leadId: lead.id }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ leadId: lead.id, confirmed: true, contactConfirmedVia: 'OPERATOR' });
    const foreign = await confirmRoute(makeRequest('/api/app/leads/finderleadmatrixprobe0000/confirm-contact', { body: { workspaceSlug: WS_A_SLUG }, ...auth }), { params: Promise.resolve({ leadId: 'finderleadmatrixprobe0000' }) });
    expect(foreign.status).toBe(404);
  });
});
