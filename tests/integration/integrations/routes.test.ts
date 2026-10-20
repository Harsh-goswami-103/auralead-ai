// T28 routes over HTTP (withRoute: session, CSRF, Zod, workspace by slug as a `[ws]` segment,
// ADR-58): test connection, DEMO template sync, pipeline dry run and save. A foreign workspace slug
// is 404, an unknown integration slug is 404, a missing capability is 403, an invalid graph is 422
// PIPELINE_INVALID with its issues, a stale editor is 409, and a valid save answers the new active
// version. The tenant matrix (tests/integration/authz) covers the remaining actor combinations.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as testConnection } from '@/app/api/app/integrations/[kind]/test/route';
import { POST as syncTemplates } from '@/app/api/app/integrations/[kind]/templates/sync/route';
import { POST as validatePipeline } from '@/app/api/app/pipeline/validate/route';
import { POST as savePipeline } from '@/app/api/app/pipeline/versions/route';
import { SIMULATED_TEST_LABEL } from '@/lib/domain/integrations';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest, testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createIntegrationsHarness, WS_A, WS_A_SLUG, type IntegrationsHarness } from './support';

let h: IntegrationsHarness;
let runtime: TestRuntime;
let auth: { cookie: string; csrf: string };

const STAGES = [
  { id: 'ingestion', kind: 'INGESTION', label: 'Ingestion' },
  { id: 'score', kind: 'SCORE', label: 'Score' },
  { id: 'draft', kind: 'DRAFT', label: 'Draft' },
  { id: 'approval', kind: 'APPROVAL', label: 'Approval' },
  { id: 'delivery', kind: 'DELIVERY', label: 'Delivery' },
];
const CHAIN = [
  { from: 'ingestion', to: 'score' },
  { from: 'score', to: 'draft' },
  { from: 'draft', to: 'approval' },
  { from: 'approval', to: 'delivery' },
];

async function signIn(userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'routes', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id) };
}

const call = (handler: typeof testConnection, path: string, params: Record<string, string>, body: unknown, who = auth) =>
  handler(makeRequest(path, { body, cookie: who.cookie, csrf: who.csrf }), { params: Promise.resolve(params) });

beforeAll(async () => {
  h = await createIntegrationsHarness('integration-routes');
  runtime = useRuntime(h.db, testConfig('demo'), h.clock);
  auth = await signIn('employee');
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
});

describe('POST /api/app/integrations/[kind]/test', () => {
  it('DEMO: 200 simulated for the workspace named by slug', async () => {
    const res = await call(testConnection, '/api/app/integrations/whatsapp/test', { kind: 'whatsapp' }, { workspaceSlug: WS_A_SLUG });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'SIMULATED', kind: 'WHATSAPP_CLOUD', message: SIMULATED_TEST_LABEL });
  });

  it('unknown kind 404, foreign workspace 404, missing capability 403, no CSRF 403', async () => {
    expect((await call(testConnection, '/api/app/integrations/telegram/test', { kind: 'telegram' }, { workspaceSlug: WS_A_SLUG })).status).toBe(404);
    expect((await call(testConnection, '/api/app/integrations/whatsapp/test', { kind: 'whatsapp' }, { workspaceSlug: 'ironpulse-fitness' })).status).toBe(404);
    expect((await call(testConnection, '/api/app/integrations/whatsapp/test', { kind: 'whatsapp' }, { workspaceSlug: 'kesari-crafts' })).status).toBe(403);
    const noCsrf = await testConnection(makeRequest('/api/app/integrations/whatsapp/test', { body: { workspaceSlug: WS_A_SLUG }, cookie: auth.cookie }), { params: Promise.resolve({ kind: 'whatsapp' }) });
    expect(noCsrf.status).toBe(403);
  });
});

describe('POST /api/app/integrations/[kind]/templates/sync', () => {
  it('DEMO: creates the demo templates; only WhatsApp has templates (404 for another kind)', async () => {
    const res = await call(syncTemplates, '/api/app/integrations/whatsapp/templates/sync', { kind: 'whatsapp' }, { workspaceSlug: WS_A_SLUG });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ simulated: true });
    expect(await h.db.whatsAppTemplate.count({ where: { workspaceId: WS_A } })).toBeGreaterThan(0);
    expect((await call(syncTemplates, '/api/app/integrations/email-smtp/templates/sync', { kind: 'email-smtp' }, { workspaceSlug: WS_A_SLUG })).status).toBe(404);
  });
});

describe('pipeline routes', () => {
  it('validate answers the issues without writing; save answers v2 active; a stale save is 409', async () => {
    const cyclic = { workspaceSlug: WS_A_SLUG, graph: { schemaVersion: 1, stages: STAGES, edges: [...CHAIN, { from: 'draft', to: 'score' }] }, approvalMode: 'HUMAN' };
    const dry = await call(validatePipeline, '/api/app/pipeline/validate', {}, cyclic);
    expect(dry.status).toBe(200);
    const dryBody = (await dry.json()) as { ok: boolean; issues: Array<{ code: string; edge?: unknown }> };
    expect(dryBody.ok).toBe(false);
    expect(dryBody.issues.find((i) => i.code === 'STAGE_ORDER')!.edge).toEqual({ from: 'draft', to: 'score' });

    const invalid = await call(savePipeline, '/api/app/pipeline/versions', {}, { ...cyclic, expectedVersion: 1 });
    expect(invalid.status).toBe(422);
    const invalidBody = (await invalid.json()) as { code: string; details: { issues: unknown[] } };
    expect(invalidBody.code).toBe('PIPELINE_INVALID');
    expect(invalidBody.details.issues.length).toBeGreaterThan(0);

    const graph = { schemaVersion: 1, stages: STAGES.filter((s) => s.kind !== 'SCORE'), edges: [{ from: 'ingestion', to: 'draft' }, ...CHAIN.slice(2)] };
    const saved = await call(savePipeline, '/api/app/pipeline/versions', {}, { workspaceSlug: WS_A_SLUG, graph, approvalMode: 'HUMAN', expectedVersion: 1 });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ version: 2, active: true, approvalMode: 'HUMAN' });

    const stale = await call(savePipeline, '/api/app/pipeline/versions', {}, { workspaceSlug: WS_A_SLUG, graph, approvalMode: 'HUMAN', expectedVersion: 1 });
    expect(stale.status).toBe(409);
  });

  it('without pipeline.manage both routes are 403', async () => {
    const body = { workspaceSlug: 'kesari-crafts', graph: { stages: STAGES, edges: CHAIN }, approvalMode: 'HUMAN' };
    expect((await call(validatePipeline, '/api/app/pipeline/validate', {}, body)).status).toBe(403);
    expect((await call(savePipeline, '/api/app/pipeline/versions', {}, { ...body, expectedVersion: 1 })).status).toBe(403);
  });
});
