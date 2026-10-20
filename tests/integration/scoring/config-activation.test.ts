// P9, R14 (T26): the scoring configuration tab. A new configuration is validated by the shared Zod
// schema (weights are whole numbers summing to 100, no unknown keys) before anything is written; a
// preview scores the 20 newest leads with it and writes nothing; activation creates version N+1 as
// the only active version (compare-and-set on the version the editor saw), audits it and enqueues
// exactly one `lead.rescore` job in the same transaction, which then rescores the workspace with
// the new version. Operators with `scoring.manage` edit; the workspace owner has read-only access
// (P9), and so does an employee without the capability. The routes are operator-panel routes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as activateRoute } from '@/app/api/app/scoring/versions/route';
import { POST as previewRoute } from '@/app/api/app/scoring/preview/route';
import { createLogger } from '@/lib/logger';
import { SCORING_PREVIEW_SAMPLE } from '@/lib/schemas/leads';
import type { ScoringConfig } from '@/lib/schemas/scoring';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { createLeadRescoreJob, LEAD_RESCORE_JOB } from '@/server/jobs/handlers/lead-rescore';
import { buildJobRegistry } from '@/server/jobs/registry';
import { activateScoringConfig, loadScoringOverview, previewScoringConfig } from '@/server/services/scoring/manage';
import { seedId } from '../../../prisma/seed/ids';
import { SCORING_V1 } from '../../../prisma/seed/fixtures/configs';
import { createWorker } from '../../../worker/worker';
import { makeRequest, testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { createQuoteHarness, makeLeads, ownerCtx, userCtx, WS_A, type QuoteHarness } from '../leads/support';

let h: QuoteHarness;
const config = testConfig('demo');

beforeAll(async () => {
  h = await createQuoteHarness('config-activation');
  useRuntime(h.db, config, h.clock);
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

const operator = () => userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');

/** A valid v2: email and reviews matter more, dental categories are targets. */
const V2: ScoringConfig = {
  schemaVersion: 1,
  weights: { phonePresent: 10, emailPresent: 20, websiteStatus: 10, rating: 20, reviewCount: 15, categoryMatch: 20, sourceIntent: 5 },
  targetCategories: ['dental'],
  notes: 'Weighted towards reachable dental clinics.',
};

function versions() {
  return h.db.scoringConfigVersion.findMany({ where: { workspaceId: WS_A }, orderBy: { version: 'asc' } });
}

describe('validation (Zod reject)', () => {
  it('refuses weights that do not sum to 100, unknown keys, negative or fractional weights, and writes nothing', async () => {
    const op = await operator();
    const bad: unknown[] = [
      { ...V2, weights: { ...V2.weights, phonePresent: 15 } },
      { ...V2, bonus: 5 },
      { ...V2, weights: { ...V2.weights, phonePresent: -10, emailPresent: 40 } },
      { ...V2, weights: { ...V2.weights, phonePresent: 10.5, emailPresent: 19.5 } },
      { ...V2, schemaVersion: 2 },
      'not an object',
    ];
    for (const c of bad) {
      await expect(previewScoringConfig(op, { config: c })).rejects.toMatchObject({ status: 400, code: 'SCORING_CONFIG_INVALID' });
      await expect(activateScoringConfig(op, { config: c, expectedActiveVersion: 1 })).rejects.toMatchObject({ status: 400, code: 'SCORING_CONFIG_INVALID' });
    }
    const err = await activateScoringConfig(op, { config: bad[0], expectedActiveVersion: 1 }).catch((e: unknown) => e);
    expect((err as { safeDetails: { issues: Array<{ path: string; message: string }> } }).safeDetails.issues).toEqual([{ path: 'weights', message: 'weights must sum to 100 (got 105)' }]);
    expect(await versions()).toHaveLength(1);
    expect(await h.db.job.count({ where: { type: LEAD_RESCORE_JOB } })).toBe(0);
  });
});

describe('preview on 20 sample leads', () => {
  it('scores the 20 newest leads with the proposed config and writes nothing', async () => {
    const made = await makeLeads(
      h.db,
      WS_A,
      Array.from({ length: 25 }, (_, i) => ({
        name: `Preview Lead ${String(i).padStart(2, '0')}`,
        email: i % 2 === 0 ? `preview${i}@example.test` : null,
        category: i % 3 === 0 ? 'Dental clinic' : 'Bakery',
        score: 40,
        rating: 40 + (i % 10),
        reviewCount: i * 4,
        source: 'GOOGLE_SHEETS',
      })),
    );
    const op = await operator();
    const before = await h.db.lead.findMany({ where: { workspaceId: WS_A }, select: { id: true, score: true, scoreConfigVersionId: true, updatedAt: true } });
    const auditsBefore = await h.db.auditEvent.count();

    const preview = await previewScoringConfig(op, { config: V2 });
    expect(SCORING_PREVIEW_SAMPLE).toBe(20);
    expect(preview.sampleSize).toBe(20);
    expect(preview.rows).toHaveLength(20);
    // The 20 newest leads, newest first.
    expect(preview.rows.map((r) => r.leadId)).toEqual(made.slice(5).reverse().map((l) => l.id));
    const newest = preview.rows[0]!;
    expect(newest).toMatchObject({ displayName: 'Preview Lead 24', currentScore: 40 });
    // Lead 24: phone 10, email 20, website unknown, rating 4.4/5 -> 18, 96 of 100 reviews -> 14, dental -> 20, form source 5.
    expect(newest.proposedScore).toBe(87);
    expect(newest.delta).toBe(47);
    expect(newest.unknownInputs).toBe(1);
    expect(preview.changed).toBe(preview.rows.filter((r) => r.delta !== 0).length);
    expect(preview.averageCurrent).toBe(40);

    // Nothing was written.
    expect(await h.db.lead.findMany({ where: { workspaceId: WS_A }, select: { id: true, score: true, scoreConfigVersionId: true, updatedAt: true } })).toEqual(before);
    expect(await versions()).toHaveLength(1);
    expect(await h.db.auditEvent.count()).toBe(auditsBefore);
    expect(await h.db.job.count({ where: { type: LEAD_RESCORE_JOB } })).toBe(0);
  });
});

describe('activation', () => {
  it('creates v2 as the only active version, audits it and enqueues one rescore job; the job rescores with v2', async () => {
    const op = await operator();
    await expect(activateScoringConfig(op, { config: V2, expectedActiveVersion: 0 })).rejects.toMatchObject({ status: 409, code: 'SCORING_VERSION_CONFLICT' });
    expect(await versions()).toHaveLength(1);

    const result = await activateScoringConfig(op, { config: V2, expectedActiveVersion: 1 });
    expect(result).toMatchObject({ version: 2, previousVersion: 1 });
    const all = await versions();
    expect(all.map((v) => [v.version, v.active])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(all[1]!.weights).toEqual(V2);
    expect(all[1]!.createdBy).toBe(seedId('user', 'employee'));

    const jobs = await h.db.job.findMany({ where: { type: LEAD_RESCORE_JOB } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: result.rescoreJobId, workspaceId: WS_A, status: 'QUEUED', idempotencyKey: `lead.rescore:${result.versionId}` });
    expect(jobs[0]!.payload).toEqual({ scoringConfigVersionId: result.versionId });

    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'scoring.config.activate', targetId: result.versionId } });
    expect(audit).toMatchObject({ workspaceId: WS_A, actorKind: 'EMPLOYEE', result: 'SUCCESS' });
    expect(audit.summary).toMatchObject({ version: 2, previousVersion: 1, rescoreJobId: result.rescoreJobId });

    // The same edit again with the old version: 409, nothing new.
    await expect(activateScoringConfig(op, { config: V2, expectedActiveVersion: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await h.db.job.count({ where: { type: LEAD_RESCORE_JOB } })).toBe(1);

    const worker = createWorker(
      { db: h.db, clock: h.clock, registry: buildJobRegistry([createLeadRescoreJob({ mode: () => 'demo' })]), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test', random: () => 0 },
      { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
    );
    while ((await worker.tick()) === 'ran');
    const leads = await h.db.lead.findMany({ where: { workspaceId: WS_A, mergedIntoLeadId: null } });
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((l) => l.scoreConfigVersionId === result.versionId)).toBe(true);
    const lead24 = leads.find((l) => l.displayName === 'Preview Lead 24')!;
    expect(lead24.score).toBe(87);
  });

  it('the overview lists every version and the active configuration', async () => {
    const owner = await ownerCtx(h);
    const overview = await loadScoringOverview(owner);
    expect(overview.active).toMatchObject({ version: 2, config: V2 });
    expect(overview.history.map((v) => ({ version: v.version, active: v.active }))).toEqual([
      { version: 2, active: true },
      { version: 1, active: false },
    ]);
    expect(overview.history[1]!.config).toEqual(SCORING_V1);
    expect(overview.history[0]!.createdByName).toBe('Imran Qureshi');
  });
});

describe('who may edit (P9: owner read-only)', () => {
  it('the owner and an operator without scoring.manage can read but not preview or activate', async () => {
    const owner = await ownerCtx(h);
    const kesariOperator = await userCtx(h.db, h.clock, 'employee', 'kesari-crafts');
    for (const ctx of [owner, kesariOperator]) {
      await expect(previewScoringConfig(ctx, { config: V2 })).rejects.toMatchObject({ status: 403 });
      await expect(activateScoringConfig(ctx, { config: V2, expectedActiveVersion: 2 })).rejects.toMatchObject({ status: 403 });
    }
    expect((await loadScoringOverview(owner)).canManage).toBe(false);
    expect((await loadScoringOverview(kesariOperator)).canManage).toBe(false);
    expect((await loadScoringOverview(await operator())).canManage).toBe(true);
    expect(await versions()).toHaveLength(2);
  });

  it('routes: the operator previews and activates by workspace slug; the owner gets 404 (not an owner route)', async () => {
    const auth = async (key: string) => {
      const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
      const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 's', userAgent: 'vitest', now: h.clock.now() });
      return { cookie: `${sessionCookieName(config)}=${token}`, csrf: csrfTokenForSession(config, session.id) };
    };
    const call = async (route: typeof previewRoute, url: string, key: string, body: unknown) => {
      const a = await auth(key);
      return route(makeRequest(url, { body, cookie: a.cookie, csrf: a.csrf }), { params: Promise.resolve({}) });
    };
    const preview = await call(previewRoute, '/api/app/scoring/preview', 'employee', { workspaceSlug: 'smile-avenue-dental', config: V2 });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { preview: { sampleSize: number } }).preview.sampleSize).toBe(20);

    const invalid = await call(activateRoute, '/api/app/scoring/versions', 'employee', { workspaceSlug: 'smile-avenue-dental', expectedActiveVersion: 2, config: { ...V2, weights: { ...V2.weights, sourceIntent: 50 } } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'SCORING_CONFIG_INVALID' });

    const ok = await call(activateRoute, '/api/app/scoring/versions', 'employee', { workspaceSlug: 'smile-avenue-dental', expectedActiveVersion: 2, config: { ...V2, notes: 'v3' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ activated: { version: 3, previousVersion: 2 } });

    expect((await call(activateRoute, '/api/app/scoring/versions', 'owner', { expectedActiveVersion: 3, config: V2 })).status).toBe(404);
    expect((await call(previewRoute, '/api/app/scoring/preview', 'owner', { config: V2 })).status).toBe(404);
    expect((await call(activateRoute, '/api/app/scoring/versions', 'employee', { workspaceSlug: 'kesari-crafts', expectedActiveVersion: 1, config: V2 })).status).toBe(403);
    expect((await call(activateRoute, '/api/app/scoring/versions', 'employee', { workspaceSlug: 'ironpulse-fitness', expectedActiveVersion: 1, config: V2 })).status).toBe(404);
  });
});

