// T32 live connection testers (ADR-80 seam 1; PRD "never silently fall back to simulated
// success"): WhatsApp (GET phone number and WABA fields), Anthropic and OpenAI (Models API), each
// through the adapter registry with its credentials decrypted by the tester. Outcomes are
// persisted (status, check time, redacted error, verifiedAt only on CONNECTED) and audited; a
// CONNECTED result arms the scheduled checks; nothing is CONNECTED without a real provider answer
// that matches the configuration. The hourly `integration.health` job re-runs the tester, and a
// revoked token stops the integration (and the chain). Zero outbound connections: a scripted
// Graph stand-in, and an undici MockAgent with net connect disabled for the AI SDKs.
import { fetch as undiciFetch, MockAgent } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { credentialAad, encryptSecret } from '@/server/security/secrets';
import { testIntegrationConnection } from '@/server/services/integrations/connection-test';
import { liveAdapters } from '@/server/services/integrations/live-adapters';
import type { LiveAdapterDeps } from '@/server/services/integrations/live-testers';
import { INTEGRATION_HEALTH_JOB, WA_QUALITY_CHECK_JOB, WA_TEMPLATE_SYNC_JOB } from '@/server/services/integrations/schedules';
import { fixture } from '../contract/support';
import { FakeGraph, fixtureAnswer, networkError } from '../contract/whatsapp-support';
import { ACCESS_TOKEN, createLiveHarness, KEY_RING, PHONE_ID, storeWhatsApp, WABA_ID, type LiveHarness } from './live-support';

let h: LiveHarness;

beforeAll(async () => {
  h = await createLiveHarness('t32-live-testers');
}, 120_000);
afterAll(async () => h?.destroy());
beforeEach(() => h.graph.reset());

const run = async (kind: 'WHATSAPP_CLOUD' | 'AI_ANTHROPIC' | 'AI_OPENAI', deps: LiveAdapterDeps = h.deps()) => testIntegrationConnection(await h.owner(), { kind }, { testers: liveAdapters(deps).testers });
const row = (kind: string) => h.db.integration.findFirstOrThrow({ where: { workspaceId: h.workspaceId, kind: kind as never } });

describe('WhatsApp tester', () => {
  it('CONNECTED only when Meta answers for the configured phone number and WABA; persisted, audited, checks armed', async () => {
    await storeWhatsApp(h, { status: 'CONFIGURED_UNVERIFIED' });
    h.graph.on('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), fixtureAnswer('response.phone-number.json'));
    h.graph.on('GET', new RegExp(`^/v24\\.0/${WABA_ID}$`), fixtureAnswer('response.waba.json'));
    const result = await run('WHATSAPP_CLOUD');
    expect(result).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED', errorCode: null });
    expect(h.graph.requests.map((r) => [r.path, r.query.fields])).toEqual([
      [`/v24.0/${PHONE_ID}`, 'id,display_phone_number,verified_name'],
      [`/v24.0/${WABA_ID}`, 'id,name'],
    ]);
    expect(h.graph.requests.every((r) => r.headers.authorization === `Bearer ${ACCESS_TOKEN}` && !r.url.includes(ACCESS_TOKEN))).toBe(true);
    expect(await row('WHATSAPP_CLOUD')).toMatchObject({ status: 'CONNECTED', verifiedAt: h.clock.now(), lastCheckedAt: h.clock.now(), lastErrorCode: null });
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { action: 'integration.test', result: 'SUCCESS' } });
    expect(audit.summary).toMatchObject({ status: 'CONNECTED', previousStatus: 'CONFIGURED_UNVERIFIED', trigger: 'manual' });
    const jobs = await h.db.job.findMany({ where: { workspaceId: h.workspaceId }, select: { type: true, runAt: true } });
    const now = h.clock.now().getTime();
    expect(jobs.filter((j) => j.runAt.getTime() === now).map((j) => j.type).sort()).toEqual([WA_QUALITY_CHECK_JOB, WA_TEMPLATE_SYNC_JOB]);
    expect(jobs.filter((j) => j.type === INTEGRATION_HEALTH_JOB).map((j) => j.runAt.getTime() > now)).toEqual([true]);
  });

  it('maps provider answers: rejected token, missing permission, a different id, no answer', async () => {
    const cases: Array<{ answer: Parameters<FakeGraph['on']>[2]; previous: 'CONNECTED' | 'CONFIGURED_UNVERIFIED'; status: string; errorCode: string }> = [
      { answer: fixtureAnswer('error.190.json'), previous: 'CONFIGURED_UNVERIFIED', status: 'ERROR', errorCode: 'PROVIDER_AUTH' },
      { answer: { status: 403, body: { error: { message: '(#10) Application does not have permission for this action', code: 10 } } }, previous: 'CONFIGURED_UNVERIFIED', status: 'ERROR', errorCode: 'PERMISSION_MISSING' },
      { answer: { status: 200, body: { id: '999999999999' } }, previous: 'CONFIGURED_UNVERIFIED', status: 'ERROR', errorCode: 'CONFIG_INVALID' },
      { answer: { throw: networkError('UND_ERR_CONNECT_TIMEOUT') }, previous: 'CONFIGURED_UNVERIFIED', status: 'CONFIGURED_UNVERIFIED', errorCode: 'PROVIDER_UNREACHABLE' },
      { answer: { throw: networkError('UND_ERR_HEADERS_TIMEOUT') }, previous: 'CONNECTED', status: 'DEGRADED', errorCode: 'PROVIDER_UNREACHABLE' },
      { answer: { status: 429, body: { error: { message: 'Application request limit reached', code: 4 } } }, previous: 'CONNECTED', status: 'DEGRADED', errorCode: 'PROVIDER_RATE_LIMITED' },
    ];
    for (const c of cases) {
      h.graph.reset();
      await storeWhatsApp(h, { status: c.previous });
      h.graph.on('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), c.answer);
      const result = await run('WHATSAPP_CLOUD');
      expect(result, c.errorCode).toMatchObject({ outcome: 'TESTED', status: c.status, errorCode: c.errorCode });
      const stored = await row('WHATSAPP_CLOUD');
      expect(stored).toMatchObject({ status: c.status, lastErrorCode: c.errorCode });
      expect(stored.lastErrorRedacted ?? '').not.toContain(ACCESS_TOKEN);
    }
  });

  it('without META_GRAPH_VERSION it cannot verify: no request, never CONNECTED', async () => {
    await storeWhatsApp(h, { status: 'CONFIGURED_UNVERIFIED' });
    const result = await run('WHATSAPP_CLOUD', { ...h.deps(), graphVersion: null });
    expect(result).toMatchObject({ status: 'CONFIGURED_UNVERIFIED', errorCode: 'INTEGRATION_NOT_CONFIGURED' });
    expect(result.message).toContain('META_GRAPH_VERSION');
    expect(h.graph.requests).toHaveLength(0);
  });

  it('integration.health: an hourly re-test that finds the token revoked stops the integration and ends the chain', async () => {
    await storeWhatsApp(h, { status: 'CONNECTED' });
    const integration = await row('WHATSAPP_CLOUD');
    await h.db.job.deleteMany({ where: { workspaceId: h.workspaceId } });
    await h.db.job.create({
      data: { type: INTEGRATION_HEALTH_JOB, payload: { integrationId: integration.id }, payloadVersion: 1, workspaceId: h.workspaceId, idempotencyKey: `integration.health:${integration.id}:test`, correlationId: 'req_health', runAt: h.clock.now(), maxAttempts: 8, createdAt: h.clock.now(), updatedAt: h.clock.now() },
    });
    h.graph.on('GET', new RegExp(`^/v24\\.0/${PHONE_ID}$`), fixtureAnswer('error.190.json'));
    await h.drain();
    expect(await row('WHATSAPP_CLOUD')).toMatchObject({ status: 'ERROR', lastErrorCode: 'PROVIDER_AUTH' });
    const scheduled = (await h.db.auditEvent.findMany({ where: { action: 'integration.test', targetId: integration.id } })).filter((a) => (a.summary as { trigger?: string }).trigger === 'scheduled');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ result: 'FAILED', actorKind: 'WORKER' });
    expect(await h.db.job.count({ where: { workspaceId: h.workspaceId, status: 'QUEUED' } })).toBe(0);
  });
});

describe('AI testers (Models API through the SDKs)', () => {
  let agent: MockAgent;
  const fetchVia = () => ((input: string | URL | Request, init?: RequestInit) => undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });
  afterEach(async () => agent.close());

  async function storeAi(kind: 'AI_ANTHROPIC' | 'AI_OPENAI', apiKey: string, modelId: string | null) {
    await h.db.integration.deleteMany({ where: { workspaceId: h.workspaceId, kind } });
    const created = await h.db.integration.create({ data: { workspaceId: h.workspaceId, kind, status: 'CONFIGURED_UNVERIFIED', config: modelId ? { modelId } : {} } });
    return h.db.integration.update({ where: { id: created.id }, data: { secrets: { apiKey: encryptSecret(KEY_RING, apiKey, credentialAad({ workspaceId: h.workspaceId, integrationId: created.id, field: 'apiKey' })) } } });
  }
  const aiDeps = (): LiveAdapterDeps => ({ ...h.deps(), aiTransport: { fetch: fetchVia() } });

  it('Anthropic: a listed key and an existing model are CONNECTED; the key travels only in x-api-key', async () => {
    const key = 'sk-ant-api03-tester-key-000000000000000000';
    await storeAi('AI_ANTHROPIC', key, 'claude-sonnet-5-5');
    const seen: Array<{ path: string; headers: Record<string, string> }> = [];
    const pool = agent.get('https://api.anthropic.com');
    const record = (status: number, body: object) => (opts: { path: string; headers?: unknown }) => {
      seen.push({ path: opts.path, headers: Object.fromEntries(Object.entries((opts.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)])) });
      return { statusCode: status, data: JSON.stringify(body), responseOptions: { headers: { 'content-type': 'application/json' } } };
    };
    pool.intercept({ path: (p) => p.startsWith('/v1/models?'), method: 'GET' }).reply(record(200, fixture('anthropic', 'models-list')));
    pool.intercept({ path: '/v1/models/claude-sonnet-5-5', method: 'GET' }).reply(record(200, fixture('anthropic', 'model')));
    const result = await run('AI_ANTHROPIC', aiDeps());
    expect(result).toMatchObject({ outcome: 'TESTED', status: 'CONNECTED' });
    expect(seen.map((s) => s.path)).toEqual(['/v1/models?limit=1', '/v1/models/claude-sonnet-5-5']);
    expect(seen.every((s) => s.headers['x-api-key'] === key && s.headers.authorization === undefined)).toBe(true);
    expect(await row('AI_ANTHROPIC')).toMatchObject({ status: 'CONNECTED', verifiedAt: h.clock.now() });
  });

  it('Anthropic: a rejected key is ERROR PROVIDER_AUTH; an unknown model is ERROR AI_MODEL_NOT_FOUND', async () => {
    await storeAi('AI_ANTHROPIC', 'sk-ant-api03-bad-key-0000000000000000000', 'claude-retired-model');
    const pool = agent.get('https://api.anthropic.com');
    pool.intercept({ path: (p) => p.startsWith('/v1/models?'), method: 'GET' }).reply(401, fixture('anthropic', 'error-401'), { headers: { 'content-type': 'application/json' } });
    expect(await run('AI_ANTHROPIC', aiDeps())).toMatchObject({ status: 'ERROR', errorCode: 'PROVIDER_AUTH' });

    await storeAi('AI_ANTHROPIC', 'sk-ant-api03-good-key-000000000000000000', 'claude-retired-model');
    pool.intercept({ path: (p) => p.startsWith('/v1/models?'), method: 'GET' }).reply(200, fixture('anthropic', 'models-list'), { headers: { 'content-type': 'application/json' } });
    pool.intercept({ path: '/v1/models/claude-retired-model', method: 'GET' }).reply(404, fixture('anthropic', 'error-404'), { headers: { 'content-type': 'application/json' } });
    const result = await run('AI_ANTHROPIC', aiDeps());
    expect(result).toMatchObject({ status: 'ERROR', errorCode: 'AI_MODEL_NOT_FOUND' });
    expect(result.message).toContain('claude-retired-model');
  });

  it('OpenAI: CONNECTED only when the configured model is listed; throttling leaves it unverified', async () => {
    const pool = agent.get('https://api.openai.com');
    await storeAi('AI_OPENAI', 'sk-proj-openai-tester-000000000000000000', 'gpt-5.1');
    pool.intercept({ path: '/v1/models', method: 'GET' }).reply(200, fixture('openai', 'models-list'), { headers: { 'content-type': 'application/json' } });
    expect(await run('AI_OPENAI', aiDeps())).toMatchObject({ status: 'CONNECTED' });

    await storeAi('AI_OPENAI', 'sk-proj-openai-tester-000000000000000000', 'gpt-unknown');
    pool.intercept({ path: '/v1/models', method: 'GET' }).reply(200, fixture('openai', 'models-list'), { headers: { 'content-type': 'application/json' } });
    expect(await run('AI_OPENAI', aiDeps())).toMatchObject({ status: 'ERROR', errorCode: 'AI_MODEL_NOT_FOUND' });

    await storeAi('AI_OPENAI', 'sk-proj-openai-tester-000000000000000000', 'gpt-5.1');
    pool.intercept({ path: '/v1/models', method: 'GET' }).reply(429, fixture('openai', 'error-429'), { headers: { 'content-type': 'application/json' } });
    expect(await run('AI_OPENAI', aiDeps())).toMatchObject({ status: 'CONFIGURED_UNVERIFIED', errorCode: 'PROVIDER_RATE_LIMITED' });
  });
});
