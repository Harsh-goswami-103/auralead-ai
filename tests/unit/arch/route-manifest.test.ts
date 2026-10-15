/**
 * R2 / R3 (T09): every App Router page and route handler is in src/server/routes.manifest.ts with
 * fixtures and an expectation for every matrix actor, every manifest entry points at a real file
 * whose exported methods match, and the panel navigation lists only manifest pages (plan §12: no
 * nav item leads to a placeholder).
 */
import { describe, expect, it } from 'vitest';
import { PANELS } from '@/components/patterns/panel-nav';
import { MATRIX_ACTORS, ROUTES, type MatrixActor } from '@/server/routes.manifest';
import {
  discoverRouteFiles,
  dynamicSegments,
  exportedMethods,
  fixtureKeys,
  kindOfFile,
  MATRIX_ACTOR_USERS,
  MATRIX_FIXTURES,
  routePathFromFile,
} from '../../support/routes';
import { USER_FIXTURES } from '../../../prisma/seed/fixtures/identities';

const roleOf = (actor: MatrixActor) => USER_FIXTURES.find((u) => u.key === MATRIX_ACTOR_USERS[actor])?.globalRole ?? null;

describe('route manifest', () => {
  const files = discoverRouteFiles();

  it('discovers the app routes', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain('src/app/api/health/route.ts');
  });

  it('lists every page.tsx and route.ts exactly once, and nothing that does not exist', () => {
    const listed = ROUTES.map((r) => r.file);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(files);
  });

  it.each(ROUTES.map((r) => [r.path, r] as const))('%s matches its file, methods and fixtures', (_path, entry) => {
    expect(entry.path).toBe(routePathFromFile(entry.file));
    expect(entry.kind).toBe(kindOfFile(entry.file));
    expect(entry.owner).toMatch(/^T\d{2}$/);
    expect(entry.calls.length).toBeGreaterThan(0);

    const methods = [...new Set(entry.calls.map((c) => c.method))].sort();
    if (entry.kind === 'api') expect(methods).toEqual([...exportedMethods(entry.file)].sort());
    else expect(methods).toEqual(['GET']);

    for (const segment of dynamicSegments(entry.path)) expect(entry.params?.[segment], `fixture for [${segment}]`).toBeDefined();
    for (const key of fixtureKeys(entry)) expect(Object.keys(MATRIX_FIXTURES), `fixture key ${key}`).toContain(key);

    for (const call of entry.calls) {
      expect(Object.keys(call.expect).sort()).toEqual([...MATRIX_ACTORS].sort());
      for (const actor of MATRIX_ACTORS) {
        const status = call.expect[actor];
        expect([200, 201, 204, 307, 400, 401, 403, 404, 409, 410, 422, 429]).toContain(status);
        // Generic rules the explicit table must agree with.
        if (entry.access === 'session' && actor === 'anonymous') expect(status).toBe(entry.kind === 'page' ? 307 : 401);
        if (entry.access === 'test-control') expect(status, 'test control is 404 without the token').toBe(404);
        const role = roleOf(actor);
        if (entry.access === 'session' && entry.roles && role !== null && !entry.roles.includes(role)) expect(status, `${actor} outside roles`).toBe(404);
      }
    }
  });

  it('lists every panel navigation target as a page in the manifest', () => {
    const pages = new Set(ROUTES.filter((r) => r.kind === 'page').map((r) => r.path));
    for (const panel of Object.values(PANELS)) {
      expect(pages).toContain(panel.home);
      for (const item of panel.items) expect(pages).toContain(item.href);
    }
  });
});
