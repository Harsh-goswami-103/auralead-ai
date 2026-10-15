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
];
