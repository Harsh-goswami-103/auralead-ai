/**
 * Every App Router page and route handler, with its access rule, the fixtures it needs and the
 * status each matrix actor must get (plan §3, §9 tenant isolation, R2, R3, E10). It feeds:
 *  - tests/unit/arch/route-manifest.test.ts: every page.tsx / route.ts on disk is listed exactly
 *    once, methods match the module's exports, panel nav targets exist;
 *  - tests/integration/authz/tenant-matrix.test.ts: each call runs for every actor against the
 *    seeded workspace B, then again with workspace B ids injected into the request;
 *  - the AT1 crawl (T38): pages with `crawlAs`.
 *
 * Shared, append-only during parallel work (plan §0 rule 5): a task that adds a route appends its
 * entry here in the same change. Data only: no imports beyond types.
 *
 * Matrix actors (seeded by prisma/seed, resolved in tests/support/routes.ts):
 *   anonymous            no session
 *   ownerA               OWNER of workspace A (the owner persona), nothing in workspace B
 *   employeeUnassigned   EMPLOYEE with no assignment
 *   employeeNoCapability EMPLOYEE assigned to workspace B with `leads.read` only
 *   superAdmin           SUPER_ADMIN (tenant data only through the audited adminContext)
 * Statuses: 404 for anything outside the actor's tenant or role (A6), 403 for a missing
 * capability inside the actor's own workspace, 401 / 307-to-login without a session.
 */
import type { Capability, GlobalRole } from '@/lib/domain/enums';

export const MATRIX_ACTORS = ['anonymous', 'ownerA', 'employeeUnassigned', 'employeeNoCapability', 'superAdmin'] as const;
export type MatrixActor = (typeof MATRIX_ACTORS)[number];

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A reference to a seeded value, resolved by the test harness (keys in tests/support/routes.ts). */
export type FixtureRef = { $fixture: string };
export type FixtureValue = string | number | boolean | null | FixtureRef | FixtureValue[] | { [key: string]: FixtureValue };
export const fixture = (key: string): FixtureRef => ({ $fixture: key });

export type MatrixExpect = Record<MatrixActor, number>;

export type RouteCall = {
  method: HttpMethod;
  /** The status each actor gets for this call (aimed at workspace B where the route has tenant data). */
  expect: MatrixExpect;
  body?: { [key: string]: FixtureValue };
  query?: { [key: string]: FixtureValue };
  /** Body keys holding referenced ids (serviceId, quoteId, leadId, ...) -> fixture of a workspace B id; must give 404 or 422 (E10). */
  foreignRefs?: Record<string, string>;
  note?: string;
};

export type RouteEntry = {
  /** URL pattern with dynamic segments, route groups removed: `/dashboard/employee/[ws]/leads`. */
  path: string;
  /** Repo-relative module path. */
  file: string;
  kind: 'page' | 'api';
  /** Task that owns the route. */
  owner: `T${string}`;
  /** public: no session needed; session: cookie session; demo-only: 404 in LIVE; test-control: 404 unless DEMO + flag + token. */
  access: 'public' | 'session' | 'demo-only' | 'test-control';
  roles?: readonly GlobalRole[];
  capability?: Capability;
  params?: { [segment: string]: FixtureValue };
  calls: RouteCall[];
  /** Panels whose signed-in persona the AT1 crawl visits this page as. */
  crawlAs?: ReadonlyArray<'anonymous' | 'user' | 'employee' | 'admin'>;
};

const all = (status: number): MatrixExpect => ({
  anonymous: status,
  ownerA: status,
  employeeUnassigned: status,
  employeeNoCapability: status,
  superAdmin: status,
});

const signedIn = (status: number, overrides: Partial<MatrixExpect> = {}): MatrixExpect => ({ ...all(status), anonymous: 401, ...overrides });

export const ROUTES: readonly RouteEntry[] = [
  // ---- Public and auth pages (T06, T08) -------------------------------------------------------
  {
    path: '/login',
    file: 'src/app/(auth)/login/page.tsx',
    kind: 'page',
    owner: 'T06',
    access: 'public',
    calls: [{ method: 'GET', expect: all(200) }],
    crawlAs: ['anonymous'],
  },
  {
    path: '/invite/[token]',
    file: 'src/app/(auth)/invite/[token]/page.tsx',
    kind: 'page',
    owner: 'T06',
    access: 'public',
    params: { token: fixture('invite.unknownToken') },
    calls: [{ method: 'GET', expect: all(200), note: 'the form renders; the token is checked on submit' }],
  },
  {
    path: '/',
    file: 'src/app/(public)/page.tsx',
    kind: 'page',
    owner: 'T30',
    access: 'public',
    calls: [{ method: 'GET', expect: all(200) }],
    crawlAs: ['anonymous'],
  },

  // ---- Panel home pages (T09) -----------------------------------------------------------------
  {
    path: '/dashboard/user',
    file: 'src/app/dashboard/user/page.tsx',
    kind: 'page',
    owner: 'T09',
    access: 'session',
    roles: ['USER'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 200, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 } }],
    crawlAs: ['user'],
  },
  {
    path: '/dashboard/employee',
    file: 'src/app/dashboard/employee/page.tsx',
    kind: 'page',
    owner: 'T09',
    access: 'session',
    roles: ['EMPLOYEE'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 200, employeeNoCapability: 200, superAdmin: 404 } }],
    crawlAs: ['employee'],
  },
  {
    path: '/dashboard/admin',
    file: 'src/app/dashboard/admin/page.tsx',
    kind: 'page',
    owner: 'T09',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 200 } }],
    crawlAs: ['admin'],
  },

  // ---- Auth API (T06) -------------------------------------------------------------------------
  {
    path: '/api/app/auth/login',
    file: 'src/app/api/app/auth/login/route.ts',
    kind: 'api',
    owner: 'T06',
    access: 'public',
    calls: [
      {
        method: 'POST',
        body: { email: fixture('workspaceB.ownerEmail'), password: fixture('password.wrong') },
        expect: all(401),
        note: "workspace B owner's email, wrong password",
      },
    ],
  },
  {
    path: '/api/app/auth/logout',
    file: 'src/app/api/app/auth/logout/route.ts',
    kind: 'api',
    owner: 'T06',
    access: 'session',
    calls: [{ method: 'POST', body: {}, expect: signedIn(200) }],
  },
  {
    path: '/api/app/auth/session',
    file: 'src/app/api/app/auth/session/route.ts',
    kind: 'api',
    owner: 'T06',
    access: 'session',
    calls: [
      { method: 'GET', expect: signedIn(200) },
      { method: 'GET', query: { workspaceId: fixture('workspaceB.id') }, expect: signedIn(404), note: 'workspace B id in the query' },
    ],
  },
  {
    path: '/api/app/auth/reauth',
    file: 'src/app/api/app/auth/reauth/route.ts',
    kind: 'api',
    owner: 'T06',
    access: 'session',
    calls: [{ method: 'POST', body: { password: fixture('password.wrong') }, expect: signedIn(401), note: 'wrong password' }],
  },
  {
    path: '/api/app/auth/active-workspace',
    file: 'src/app/api/app/auth/active-workspace/route.ts',
    kind: 'api',
    owner: 'T06',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug') },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 },
        note: 'switch to workspace B',
      },
    ],
  },
  {
    path: '/api/app/auth/invite/accept',
    file: 'src/app/api/app/auth/invite/accept/route.ts',
    kind: 'api',
    owner: 'T06',
    access: 'public',
    calls: [
      {
        method: 'POST',
        body: { token: fixture('invite.unknownToken'), name: 'Matrix Probe', password: fixture('password.wrong') },
        expect: all(404),
        note: 'never-issued token',
      },
    ],
  },

  // ---- DEMO and test control (T06, T09) -------------------------------------------------------
  {
    path: '/api/demo/session',
    file: 'src/app/api/demo/session/route.ts',
    kind: 'api',
    owner: 'T06',
    access: 'demo-only',
    calls: [{ method: 'POST', body: { persona: fixture('persona.user') }, expect: all(200), note: 'DEMO process; 404 in LIVE (demo-isolation.test.ts)' }],
  },
  {
    path: '/api/test/clock',
    file: 'src/app/api/test/clock/route.ts',
    kind: 'api',
    owner: 'T06',
    access: 'test-control',
    calls: [
      { method: 'GET', expect: all(404) },
      { method: 'POST', body: { reset: true }, expect: all(404) },
    ],
  },
  {
    path: '/api/test/reset',
    file: 'src/app/api/test/reset/route.ts',
    kind: 'api',
    owner: 'T09',
    access: 'test-control',
    calls: [{ method: 'POST', body: {}, expect: all(404) }],
  },

  // ---- Operations (T09) -----------------------------------------------------------------------
  {
    path: '/api/health',
    file: 'src/app/api/health/route.ts',
    kind: 'api',
    owner: 'T09',
    access: 'public',
    calls: [{ method: 'GET', expect: all(200) }],
  },

  // ---- Pricing catalog and settings (T13) -----------------------------------------------------
  {
    path: '/dashboard/user/pricing',
    file: 'src/app/dashboard/user/pricing/page.tsx',
    kind: 'page',
    owner: 'T13',
    access: 'session',
    roles: ['USER'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 200, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 } }],
    crawlAs: ['user'],
  },
  {
    path: '/api/app/pricing',
    file: 'src/app/api/app/pricing/route.ts',
    kind: 'api',
    owner: 'T13',
    access: 'session',
    roles: ['USER'],
    calls: [{ method: 'GET', expect: signedIn(404, { ownerA: 200 }), note: "the caller's own workspace overview" }],
  },
  {
    path: '/api/app/pricing/services',
    file: 'src/app/api/app/pricing/services/route.ts',
    kind: 'api',
    owner: 'T13',
    access: 'session',
    roles: ['USER'],
    capability: 'pricing.override',
    calls: [
      {
        method: 'POST',
        body: { code: 'MATRIX-1', name: 'Matrix probe', description: '', unitLabel: 'unit', defaultTimelineDays: null, maxDiscountBps: null, unitPricePaise: '100000', minQty: 1, maxQty: 10, expectedVersion: 1 },
        expect: signedIn(404, { ownerA: 200 }),
        note: "adds a service to the caller's own workspace (seeded price list v1)",
      },
    ],
  },
  {
    path: '/api/app/pricing/services/[serviceId]',
    file: 'src/app/api/app/pricing/services/[serviceId]/route.ts',
    kind: 'api',
    owner: 'T13',
    access: 'session',
    roles: ['USER'],
    capability: 'pricing.override',
    params: { serviceId: fixture('workspaceB.serviceId') },
    calls: [{ method: 'POST', body: { unitPricePaise: '1', expectedVersion: 1 }, expect: signedIn(404), note: "edit workspace B's service" }],
  },
  {
    path: '/api/app/pricing/services/[serviceId]/archive',
    file: 'src/app/api/app/pricing/services/[serviceId]/archive/route.ts',
    kind: 'api',
    owner: 'T13',
    access: 'session',
    roles: ['USER'],
    capability: 'pricing.override',
    params: { serviceId: fixture('workspaceB.serviceId') },
    calls: [{ method: 'POST', body: { expectedVersion: 1 }, expect: signedIn(404), note: "archive workspace B's service" }],
  },
  {
    path: '/api/app/pricing/settings',
    file: 'src/app/api/app/pricing/settings/route.ts',
    kind: 'api',
    owner: 'T13',
    access: 'session',
    roles: ['USER'],
    capability: 'pricing.override',
    calls: [{ method: 'POST', body: { quoteValidityDays: 20 }, expect: signedIn(404, { ownerA: 200 }), note: "the caller's own workspace settings" }],
  },

  // ---- Source simulators and the employee lead console (T11) ---------------------------------
  {
    path: '/api/demo/simulate/[source]',
    file: 'src/app/api/demo/simulate/[source]/route.ts',
    kind: 'api',
    owner: 'T11',
    access: 'demo-only',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'leads.write',
    params: { source: 'sheets' },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), count: 1 },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: 'simulate into workspace B (DEMO process; 404 in LIVE, simulate-sources.test.ts)',
      },
    ],
  },
  {
    path: '/dashboard/employee/[ws]/leads',
    file: 'src/app/dashboard/employee/[ws]/leads/page.tsx',
    kind: 'page',
    owner: 'T17',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's lead console" }],
  },

  // ---- Quote lifecycle (T15) ------------------------------------------------------------------
  {
    path: '/dashboard/user/quotations',
    file: 'src/app/dashboard/user/quotations/page.tsx',
    kind: 'page',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 200, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 } }],
    crawlAs: ['user'],
  },
  {
    path: '/dashboard/user/quotations/new',
    file: 'src/app/dashboard/user/quotations/new/page.tsx',
    kind: 'page',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 200, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 } }],
    crawlAs: ['user'],
  },
  {
    path: '/dashboard/user/quotations/[quoteId]',
    file: 'src/app/dashboard/user/quotations/[quoteId]/page.tsx',
    kind: 'page',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    params: { quoteId: fixture('workspaceB.quoteId') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 }, note: "workspace B's seeded quote" }],
  },
  {
    path: '/api/app/quotes',
    file: 'src/app/api/app/quotes/route.ts',
    kind: 'api',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    calls: [
      { method: 'GET', expect: signedIn(404, { ownerA: 200 }), note: "the caller's own workspace quotes" },
      {
        method: 'POST',
        body: {
          leadId: fixture('workspaceB.leadId'),
          items: [{ serviceId: fixture('workspaceB.serviceId'), qty: 1 }],
          discount: { kind: 'NONE', value: '0' },
          scopeText: 'Matrix probe',
          timelineText: 'One week',
        },
        expect: signedIn(404),
        note: "create a quote for workspace B's lead",
      },
    ],
  },
  {
    path: '/api/app/quotes/[quoteId]',
    file: 'src/app/api/app/quotes/[quoteId]/route.ts',
    kind: 'api',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    params: { quoteId: fixture('workspaceB.quoteId') },
    calls: [{ method: 'GET', expect: signedIn(404), note: "read workspace B's quote" }],
  },
  {
    path: '/api/app/quotes/[quoteId]/revise',
    file: 'src/app/api/app/quotes/[quoteId]/revise/route.ts',
    kind: 'api',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    capability: 'quotes.edit',
    params: { quoteId: fixture('workspaceB.quoteId') },
    calls: [
      {
        method: 'POST',
        body: { expectedVersion: 1, items: [{ serviceId: fixture('workspaceB.serviceId'), qty: 1 }], discount: { kind: 'NONE', value: '0' }, scopeText: 'Matrix probe', timelineText: 'One week' },
        expect: signedIn(404),
        note: "revise workspace B's quote",
      },
    ],
  },
  {
    path: '/api/app/quotes/[quoteId]/approve',
    file: 'src/app/api/app/quotes/[quoteId]/approve/route.ts',
    kind: 'api',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    capability: 'approvals.decide',
    params: { quoteId: fixture('workspaceB.quoteId') },
    calls: [{ method: 'POST', body: { expectedVersion: 1 }, expect: signedIn(404), note: "approve workspace B's quote" }],
  },
  {
    path: '/api/app/quotes/[quoteId]/cancel',
    file: 'src/app/api/app/quotes/[quoteId]/cancel/route.ts',
    kind: 'api',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    capability: 'quotes.edit',
    params: { quoteId: fixture('workspaceB.quoteId') },
    calls: [{ method: 'POST', body: { expectedVersion: 1 }, expect: signedIn(404), note: "cancel workspace B's quote" }],
  },
  {
    path: '/api/app/quotes/[quoteId]/shares',
    file: 'src/app/api/app/quotes/[quoteId]/shares/route.ts',
    kind: 'api',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    capability: 'dispatch.send',
    params: { quoteId: fixture('workspaceB.quoteId') },
    calls: [{ method: 'POST', body: {}, expect: signedIn(404), note: "share workspace B's quote" }],
  },
  {
    path: '/api/app/quotes/[quoteId]/shares/[shareId]/revoke',
    file: 'src/app/api/app/quotes/[quoteId]/shares/[shareId]/revoke/route.ts',
    kind: 'api',
    owner: 'T15',
    access: 'session',
    roles: ['USER'],
    capability: 'dispatch.send',
    params: { quoteId: fixture('workspaceB.quoteId'), shareId: 'matrix-share-probe' },
    calls: [{ method: 'POST', expect: signedIn(404), note: "revoke a link of workspace B's quote" }],
  },
  // ---- Public quote and quote PDFs (T16) --------------------------------------------------------
  {
    path: '/quote/[token]',
    file: 'src/app/(public)/quote/[token]/route.ts',
    kind: 'api',
    owner: 'T16',
    access: 'public',
    params: { token: fixture('share.unknownToken') },
    calls: [{ method: 'GET', expect: all(404), note: 'never-issued share token: the one 404 page (C3); served as HTML by a route handler' }],
  },
  {
    path: '/api/quote-share/[token]/view',
    file: 'src/app/api/quote-share/[token]/view/route.ts',
    kind: 'api',
    owner: 'T16',
    access: 'public',
    params: { token: fixture('share.unknownToken') },
    calls: [{ method: 'POST', body: {}, expect: all(404), note: 'view beacon for a never-issued token' }],
  },
  {
    path: '/api/quote-share/[token]/accept',
    file: 'src/app/api/quote-share/[token]/accept/route.ts',
    kind: 'api',
    owner: 'T16',
    access: 'public',
    params: { token: fixture('share.unknownToken') },
    calls: [
      {
        method: 'POST',
        body: { token: fixture('share.unknownToken'), formNonce: 'matrix-probe', expectedVersionId: 'matrix-probe', acceptorName: 'Matrix Probe' },
        expect: all(403),
        note: 'a nonce the page never rendered is refused before any lookup (C5)',
      },
    ],
  },
  {
    path: '/api/quote-share/[token]/pdf',
    file: 'src/app/api/quote-share/[token]/pdf/route.ts',
    kind: 'api',
    owner: 'T16',
    access: 'public',
    params: { token: fixture('share.unknownToken') },
    calls: [{ method: 'GET', expect: all(404), note: 'PDF for a never-issued token' }],
  },
  {
    path: '/api/quotes/[id]/pdf',
    file: 'src/app/api/quotes/[id]/pdf/route.ts',
    kind: 'api',
    owner: 'T16',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'leads.read',
    params: { id: fixture('workspaceB.quoteId') },
    calls: [{ method: 'GET', expect: signedIn(404), note: "download workspace B's quote PDF" }],
  },

  // ---- Employee lead console: lead detail, drafts, quote from proposal, approve, PDF (T17) -----
  {
    path: '/dashboard/employee/[ws]/leads/[leadId]',
    file: 'src/app/dashboard/employee/[ws]/leads/[leadId]/page.tsx',
    kind: 'page',
    owner: 'T17',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug'), leadId: fixture('workspaceB.leadId') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's lead detail (leads.read is enough to read)" }],
  },
  {
    path: '/api/app/leads/[leadId]/draft',
    file: 'src/app/api/app/leads/[leadId]/draft/route.ts',
    kind: 'api',
    owner: 'T17',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'drafts.generate',
    params: { leadId: fixture('workspaceB.leadId') },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug') },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "generate a draft for workspace B's lead",
      },
      { method: 'POST', body: {}, expect: signedIn(404), note: "workspace B's lead through the caller's active workspace" },
    ],
  },
  {
    path: '/api/app/leads/[leadId]/quotes',
    file: 'src/app/api/app/leads/[leadId]/quotes/route.ts',
    kind: 'api',
    owner: 'T17',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'quotes.edit',
    params: { leadId: fixture('workspaceB.leadId') },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), draftId: 'matrix-draft-probe' },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "create a quote from a proposal for workspace B's lead",
      },
      { method: 'POST', body: { draftId: 'matrix-draft-probe' }, expect: signedIn(404), note: "workspace B's lead through the caller's active workspace" },
    ],
  },
  {
    path: '/api/app/leads/[leadId]/quotes/[quoteId]/approve',
    file: 'src/app/api/app/leads/[leadId]/quotes/[quoteId]/approve/route.ts',
    kind: 'api',
    owner: 'T17',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'approvals.decide',
    params: { leadId: fixture('workspaceB.leadId'), quoteId: fixture('workspaceB.quoteId') },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), expectedVersion: 1 },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "approve workspace B's quote from its lead",
      },
      { method: 'POST', body: { expectedVersion: 1 }, expect: signedIn(404), note: "workspace B's quote through the caller's active workspace" },
    ],
  },
  {
    path: '/api/app/leads/[leadId]/quotes/[quoteId]/pdf',
    file: 'src/app/api/app/leads/[leadId]/quotes/[quoteId]/pdf/route.ts',
    kind: 'api',
    owner: 'T17',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'leads.read',
    params: { leadId: fixture('workspaceB.leadId'), quoteId: fixture('workspaceB.quoteId') },
    calls: [
      {
        method: 'GET',
        query: { workspaceSlug: fixture('workspaceB.slug'), version: 99 },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 },
        note: "workspace B's quote PDF at a version that does not exist: the assigned reader passes the tenant and capability checks and gets 404 (the 200 / 503 paths are in tests/integration/slice/audit-trail.test.ts)",
      },
      { method: 'GET', expect: signedIn(404), note: "workspace B's quote through the caller's active workspace" },
    ],
  },

  // ---- Consent grants and B2B email attestation (T18) ------------------------------------------
  {
    path: '/api/app/consent/grants',
    file: 'src/app/api/app/consent/grants/route.ts',
    kind: 'api',
    owner: 'T18',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'leads.write',
    calls: [
      {
        method: 'POST',
        body: {
          workspaceSlug: fixture('workspaceB.slug'),
          leadId: fixture('workspaceB.leadId'),
          channel: 'WHATSAPP',
          purpose: 'MARKETING',
          source: 'MANUAL_EVIDENCE',
          collectedAt: '2026-10-01T10:00:00.000Z',
          evidence: { note: 'Tenant matrix probe evidence' },
        },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "record an opt-in for workspace B's lead",
      },
      {
        method: 'POST',
        body: {
          leadId: fixture('workspaceB.leadId'),
          channel: 'WHATSAPP',
          purpose: 'MARKETING',
          source: 'MANUAL_EVIDENCE',
          collectedAt: '2026-10-01T10:00:00.000Z',
          evidence: { note: 'Tenant matrix probe evidence' },
        },
        expect: signedIn(404),
        note: "workspace B's lead through the caller's active workspace",
      },
    ],
  },
  {
    path: '/api/app/consent/attestations',
    file: 'src/app/api/app/consent/attestations/route.ts',
    kind: 'api',
    owner: 'T18',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'leads.write',
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), leadId: fixture('workspaceB.leadId'), note: 'Tenant matrix probe attestation' },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "attest a B2B email basis for workspace B's lead",
      },
      {
        method: 'POST',
        body: { leadId: fixture('workspaceB.leadId'), note: 'Tenant matrix probe attestation' },
        expect: signedIn(404),
        note: "workspace B's lead through the caller's active workspace",
      },
    ],
  },
  // ---- Bulk actions (T23) ---------------------------------------------------------------------
  {
    path: '/api/app/bulk/preflight',
    file: 'src/app/api/app/bulk/preflight/route.ts',
    kind: 'api',
    owner: 'T23',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'dispatch.send',
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), action: 'SEND_EMAIL', subject: 'Matrix probe', body: 'Matrix probe body', leadIds: [fixture('workspaceB.leadId')] },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "pre-flight a bulk email over workspace B's lead",
      },
      {
        method: 'POST',
        body: { action: 'SEND_EMAIL', subject: 'Matrix probe', body: 'Matrix probe body', leadIds: [fixture('workspaceB.leadId')] },
        expect: signedIn(404),
        note: "workspace B's lead through the caller's active workspace",
      },
    ],
  },
  {
    path: '/api/app/bulk/runs',
    file: 'src/app/api/app/bulk/runs/route.ts',
    kind: 'api',
    owner: 'T23',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), requestKey: 'matrix-probe-0001', action: 'SEND_EMAIL', subject: 'Matrix probe', body: 'Matrix probe body', leadIds: [fixture('workspaceB.leadId')] },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "confirm a bulk email over workspace B's lead (approvals.decide + dispatch.send)",
      },
      {
        method: 'POST',
        body: { requestKey: 'matrix-probe-0002', action: 'SEND_EMAIL', subject: 'Matrix probe', body: 'Matrix probe body', leadIds: [fixture('workspaceB.leadId')] },
        expect: signedIn(404),
        note: "workspace B's lead through the caller's active workspace",
      },
      {
        method: 'GET',
        query: { workspaceSlug: fixture('workspaceB.slug') },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 },
        note: "list workspace B's bulk runs (leads.read)",
      },
    ],
  },
  {
    path: '/api/app/bulk/runs/[runId]',
    file: 'src/app/api/app/bulk/runs/[runId]/route.ts',
    kind: 'api',
    owner: 'T23',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'leads.read',
    params: { runId: fixture('bulk.unknownRunId') },
    calls: [
      {
        method: 'GET',
        query: { workspaceSlug: fixture('workspaceB.slug') },
        expect: signedIn(404),
        note: 'a run id that does not exist in workspace B',
      },
    ],
  },
  // ---- WhatsApp and email webhooks, unsubscribe, DEMO inbound simulation (T20) -----------------
  {
    path: '/api/webhooks/whatsapp',
    file: 'src/app/api/webhooks/whatsapp/route.ts',
    kind: 'api',
    owner: 'T20',
    access: 'public',
    calls: [
      { method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'matrix-probe', 'hub.challenge': '123' }, expect: all(403), note: 'verification with a wrong token' },
      { method: 'POST', body: { object: 'whatsapp_business_account', entry: [] }, expect: all(401), note: 'unsigned delivery; cookies are never read' },
    ],
  },
  {
    path: '/api/webhooks/whatsapp/simulate',
    file: 'src/app/api/webhooks/whatsapp/simulate/route.ts',
    kind: 'api',
    owner: 'T20',
    access: 'demo-only',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'leads.write',
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), leadId: fixture('workspaceB.leadId'), event: 'text' },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "simulate an inbound message from workspace B's lead",
      },
      { method: 'POST', body: { leadId: fixture('workspaceB.leadId'), event: 'quick_reply_stop' }, expect: signedIn(404), note: "workspace B's lead through the caller's active workspace" },
    ],
  },
  {
    path: '/api/webhooks/email/[provider]',
    file: 'src/app/api/webhooks/email/[provider]/route.ts',
    kind: 'api',
    owner: 'T20',
    access: 'public',
    params: { provider: 'demo' },
    calls: [{ method: 'POST', body: { type: 'email.bounced' }, expect: all(401), note: 'unsigned DEMO provider event' }],
  },
  {
    path: '/api/unsubscribe',
    file: 'src/app/api/unsubscribe/route.ts',
    kind: 'api',
    owner: 'T20',
    access: 'public',
    calls: [
      { method: 'GET', query: { token: 'matrix-probe' }, expect: all(404), note: 'an unsigned token' },
      { method: 'POST', query: { token: 'matrix-probe' }, expect: all(404), note: 'one-click with an unsigned token writes nothing' },
    ],
  },
  {
    path: '/unsubscribe/[token]',
    file: 'src/app/(public)/unsubscribe/[token]/page.tsx',
    kind: 'page',
    owner: 'T20',
    access: 'public',
    params: { token: 'matrix-probe' },
    calls: [{ method: 'GET', expect: all(404), note: 'an unsigned token renders the not-found page' }],
  },
  // ---- Admin inspector, queue health, global pause (T24) --------------------------------------
  {
    path: '/dashboard/admin/jobs',
    file: 'src/app/dashboard/admin/jobs/page.tsx',
    kind: 'page',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 200 } }],
    crawlAs: ['admin'],
  },
  {
    path: '/dashboard/admin/jobs/[jobId]',
    file: 'src/app/dashboard/admin/jobs/[jobId]/page.tsx',
    kind: 'page',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    params: { jobId: fixture('admin.unknownJobId') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 }, note: 'a job id that does not exist' }],
  },
  {
    path: '/dashboard/admin/webhooks',
    file: 'src/app/dashboard/admin/webhooks/page.tsx',
    kind: 'page',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 200 } }],
    crawlAs: ['admin'],
  },
  {
    path: '/dashboard/admin/webhooks/[eventId]',
    file: 'src/app/dashboard/admin/webhooks/[eventId]/page.tsx',
    kind: 'page',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    params: { eventId: fixture('admin.unknownEventId') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 }, note: 'an event id that does not exist' }],
  },
  {
    path: '/api/admin/jobs/[jobId]/cancel',
    file: 'src/app/api/admin/jobs/[jobId]/cancel/route.ts',
    kind: 'api',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    params: { jobId: fixture('admin.unknownJobId') },
    calls: [{ method: 'POST', body: { reason: 'Tenant matrix probe' }, expect: signedIn(404), note: 'a job id that does not exist' }],
  },
  {
    path: '/api/admin/jobs/[jobId]/retry',
    file: 'src/app/api/admin/jobs/[jobId]/retry/route.ts',
    kind: 'api',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    params: { jobId: fixture('admin.unknownJobId') },
    calls: [{ method: 'POST', body: { reason: 'Tenant matrix probe' }, expect: signedIn(404), note: 'a job id that does not exist' }],
  },
  {
    path: '/api/admin/jobs/[jobId]/resolve',
    file: 'src/app/api/admin/jobs/[jobId]/resolve/route.ts',
    kind: 'api',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    params: { jobId: fixture('admin.unknownJobId') },
    calls: [{ method: 'POST', body: { attemptId: fixture('admin.unknownJobId'), resolution: 'DELIVERED', reason: 'Tenant matrix probe' }, expect: signedIn(404), note: 'an attempt that does not exist' }],
  },
  {
    path: '/api/admin/system/outbound-pause',
    file: 'src/app/api/admin/system/outbound-pause/route.ts',
    kind: 'api',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    calls: [{ method: 'POST', body: { paused: false, reason: 'Tenant matrix probe (resume is a no-op)' }, expect: signedIn(404, { superAdmin: 200 }), note: 'super admin only, fresh sign-in' }],
  },
  {
    path: '/api/admin/system/queue-health',
    file: 'src/app/api/admin/system/queue-health/route.ts',
    kind: 'api',
    owner: 'T24',
    access: 'session',
    roles: ['SUPER_ADMIN'],
    calls: [{ method: 'GET', expect: signedIn(404, { superAdmin: 200 }) }],
  },
  // ---- Inbox, approval queue and manual quote hand-over (T22) ----------------------------------
  {
    path: '/dashboard/user/inbox',
    file: 'src/app/dashboard/user/inbox/page.tsx',
    kind: 'page',
    owner: 'T22',
    access: 'session',
    roles: ['USER'],
    capability: 'leads.read',
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 200, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 } }],
    crawlAs: ['user'],
  },
  {
    path: '/dashboard/user/inbox/[conversationId]',
    file: 'src/app/dashboard/user/inbox/[conversationId]/page.tsx',
    kind: 'page',
    owner: 'T22',
    access: 'session',
    roles: ['USER'],
    capability: 'leads.read',
    params: { conversationId: fixture('inbox.unknownConversationId') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 404, superAdmin: 404 }, note: "a conversation id that does not exist in the caller's workspace" }],
  },
  {
    path: '/dashboard/employee/approvals',
    file: 'src/app/dashboard/employee/approvals/page.tsx',
    kind: 'page',
    owner: 'T22',
    access: 'session',
    roles: ['EMPLOYEE'],
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 200, employeeNoCapability: 200, superAdmin: 404 }, note: 'the queues of every assigned workspace' }],
    crawlAs: ['employee'],
  },
  {
    path: '/dashboard/employee/[ws]/approvals',
    file: 'src/app/dashboard/employee/[ws]/approvals/page.tsx',
    kind: 'page',
    owner: 'T22',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's queue, read-only for the leads.read employee" }],
  },
  {
    path: '/dashboard/employee/[ws]/approvals/[approvalId]',
    file: 'src/app/dashboard/employee/[ws]/approvals/[approvalId]/page.tsx',
    kind: 'page',
    owner: 'T22',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug'), approvalId: fixture('workspaceB.approvalId') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's pending quote approval, read-only for the leads.read employee" }],
  },
  {
    path: '/api/app/messages',
    file: 'src/app/api/app/messages/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER'],
    capability: 'dispatch.send',
    calls: [
      {
        method: 'POST',
        body: { conversationId: fixture('inbox.unknownConversationId'), requestKey: 'matrix-probe-0001', kind: 'TEXT', body: 'Matrix probe' },
        expect: signedIn(404),
        note: "composer send into a conversation outside the caller's workspace",
      },
    ],
  },
  {
    path: '/api/app/messages/drafts',
    file: 'src/app/api/app/messages/drafts/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER'],
    capability: 'leads.write',
    calls: [{ method: 'POST', body: { conversationId: fixture('inbox.unknownConversationId'), kind: 'TEXT', body: 'Matrix probe' }, expect: signedIn(404), note: "save for review in a conversation outside the caller's workspace" }],
  },
  {
    path: '/api/app/conversations/[conversationId]/takeover',
    file: 'src/app/api/app/conversations/[conversationId]/takeover/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER'],
    capability: 'leads.write',
    params: { conversationId: fixture('inbox.unknownConversationId') },
    calls: [{ method: 'POST', body: {}, expect: signedIn(404) }],
  },
  {
    path: '/api/app/conversations/[conversationId]/resume',
    file: 'src/app/api/app/conversations/[conversationId]/resume/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER'],
    capability: 'leads.write',
    params: { conversationId: fixture('inbox.unknownConversationId') },
    calls: [{ method: 'POST', body: {}, expect: signedIn(404) }],
  },
  {
    path: '/api/app/conversations/[conversationId]/mode',
    file: 'src/app/api/app/conversations/[conversationId]/mode/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER'],
    capability: 'leads.write',
    params: { conversationId: fixture('inbox.unknownConversationId') },
    calls: [{ method: 'POST', body: { aiMode: 'OFF' }, expect: signedIn(404) }],
  },
  {
    path: '/api/app/approvals/[approvalId]/approve',
    file: 'src/app/api/app/approvals/[approvalId]/approve/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'approvals.decide',
    params: { approvalId: fixture('workspaceB.approvalId') },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), expectedVersion: 1 },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "approve workspace B's quote version from the queue",
      },
      { method: 'POST', body: { expectedVersion: 1 }, expect: signedIn(404), note: "workspace B's approval through the caller's active workspace" },
    ],
  },
  {
    path: '/api/app/approvals/[approvalId]/send',
    file: 'src/app/api/app/approvals/[approvalId]/send/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'dispatch.send',
    params: { approvalId: fixture('workspaceB.approvalId') },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), expectedVersion: 1, channel: 'EMAIL' },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "approve and send workspace B's quote version",
      },
      { method: 'POST', body: { expectedVersion: 1, channel: 'EMAIL' }, expect: signedIn(404), note: "workspace B's approval through the caller's active workspace" },
    ],
  },
  {
    path: '/api/app/approvals/[approvalId]/reject',
    file: 'src/app/api/app/approvals/[approvalId]/reject/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'approvals.decide',
    params: { approvalId: fixture('workspaceB.approvalId') },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), reason: 'Tenant matrix probe' },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "reject workspace B's pending approval",
      },
      { method: 'POST', body: { reason: 'Tenant matrix probe' }, expect: signedIn(404), note: "workspace B's approval through the caller's active workspace" },
    ],
  },
  {
    path: '/api/app/approvals/[approvalId]/revise',
    file: 'src/app/api/app/approvals/[approvalId]/revise/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'quotes.edit',
    params: { approvalId: fixture('workspaceB.approvalId') },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), expectedVersion: 1, items: [{ serviceId: fixture('workspaceB.serviceId'), qty: 1 }], discount: { kind: 'NONE', value: '0' }, scopeText: 'Matrix probe', timelineText: 'One week' },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "edit workspace B's quote from its approval",
      },
      {
        method: 'POST',
        body: { expectedVersion: 1, items: [{ serviceId: fixture('workspaceB.serviceId'), qty: 1 }], discount: { kind: 'NONE', value: '0' }, scopeText: 'Matrix probe', timelineText: 'One week' },
        expect: signedIn(404),
        note: "workspace B's approval through the caller's active workspace",
      },
    ],
  },
  {
    path: '/api/app/quotes/[quoteId]/mark-sent',
    file: 'src/app/api/app/quotes/[quoteId]/mark-sent/route.ts',
    kind: 'api',
    owner: 'T22',
    access: 'session',
    roles: ['USER'],
    capability: 'dispatch.send',
    params: { quoteId: fixture('workspaceB.quoteId') },
    calls: [{ method: 'POST', body: { expectedVersion: 1, via: 'MARK_SENT' }, expect: signedIn(404), note: "mark workspace B's quote as sent manually (P15)" }],
  },

  // ---- Employee panel: Integration center, pipeline editor, Sheets / Meta / Extension (T28) ----
  {
    path: '/dashboard/employee/[ws]/integrations',
    file: 'src/app/dashboard/employee/[ws]/integrations/page.tsx',
    kind: 'page',
    owner: 'T28',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's Integration center, read-only without integrations.manage" }],
  },
  {
    path: '/dashboard/employee/[ws]/integrations/[kind]',
    file: 'src/app/dashboard/employee/[ws]/integrations/[kind]/page.tsx',
    kind: 'page',
    owner: 'T28',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug'), kind: 'whatsapp' },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's WhatsApp setup (masked credentials only)" }],
  },
  {
    path: '/dashboard/employee/[ws]/pipeline',
    file: 'src/app/dashboard/employee/[ws]/pipeline/page.tsx',
    kind: 'page',
    owner: 'T28',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's pipeline, read-only list without pipeline.manage" }],
  },
  {
    path: '/dashboard/employee/[ws]/sheets',
    file: 'src/app/dashboard/employee/[ws]/sheets/page.tsx',
    kind: 'page',
    owner: 'T28',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's Sheets setup" }],
  },
  {
    path: '/dashboard/employee/[ws]/meta',
    file: 'src/app/dashboard/employee/[ws]/meta/page.tsx',
    kind: 'page',
    owner: 'T28',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's Meta console" }],
  },
  {
    path: '/dashboard/employee/[ws]/extension',
    file: 'src/app/dashboard/employee/[ws]/extension/page.tsx',
    kind: 'page',
    owner: 'T28',
    access: 'session',
    roles: ['EMPLOYEE'],
    capability: 'leads.read',
    params: { ws: fixture('workspaceB.slug') },
    calls: [{ method: 'GET', expect: { anonymous: 307, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 200, superAdmin: 404 }, note: "workspace B's extension hub (token prefixes only)" }],
  },
  {
    path: '/api/app/integrations/[kind]/test',
    file: 'src/app/api/app/integrations/[kind]/test/route.ts',
    kind: 'api',
    owner: 'T28',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'integrations.manage',
    params: { kind: 'whatsapp' },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug') },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "test workspace B's WhatsApp connection",
      },
    ],
  },
  {
    path: '/api/app/integrations/[kind]/templates/sync',
    file: 'src/app/api/app/integrations/[kind]/templates/sync/route.ts',
    kind: 'api',
    owner: 'T28',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'integrations.manage',
    params: { kind: 'whatsapp' },
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug') },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "sync workspace B's WhatsApp templates (DEMO: simulated)",
      },
    ],
  },
  {
    path: '/api/app/pipeline/validate',
    file: 'src/app/api/app/pipeline/validate/route.ts',
    kind: 'api',
    owner: 'T28',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'pipeline.manage',
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), graph: { stages: [{ id: 'ingestion', kind: 'INGESTION' }, { id: 'approval', kind: 'APPROVAL' }], edges: [{ from: 'ingestion', to: 'approval' }] }, approvalMode: 'HUMAN' },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "dry-run a pipeline for workspace B",
      },
    ],
  },
  {
    path: '/api/app/pipeline/versions',
    file: 'src/app/api/app/pipeline/versions/route.ts',
    kind: 'api',
    owner: 'T28',
    access: 'session',
    roles: ['USER', 'EMPLOYEE'],
    capability: 'pipeline.manage',
    calls: [
      {
        method: 'POST',
        body: { workspaceSlug: fixture('workspaceB.slug'), graph: { stages: [{ id: 'ingestion', kind: 'INGESTION' }, { id: 'approval', kind: 'APPROVAL' }], edges: [{ from: 'ingestion', to: 'approval' }] }, approvalMode: 'HUMAN', expectedVersion: 1 },
        expect: { anonymous: 401, ownerA: 404, employeeUnassigned: 404, employeeNoCapability: 403, superAdmin: 404 },
        note: "save a pipeline version for workspace B",
      },
    ],
  },
];
