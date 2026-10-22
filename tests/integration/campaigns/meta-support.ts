/**
 * LIVE harness for the T35 Meta tests: a migrated DB with no DEMO seed (a LIVE process never sees
 * DEMO data), LIVE workspaces A and B, each with a non-demo owner (OWNER holds every capability),
 * the process runtime installed with one LIVE config (Meta app secret, verify token,
 * META_GRAPH_VERSION v24.0 and META_MARKETING_VERSION v25.0, the credentials key ring the stored
 * tokens are encrypted with), and an in-process worker running the production Meta handlers with
 * the scripted Graph stand-in (`FakeGraph`, documented-shape fixtures in
 * tests/fixtures/meta/documented-shape) as their only transport. Zero outbound connections:
 * anything unscripted fails the test.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import type { AppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { buildUserContext, type AppCtx } from '@/server/auth/context';
import { createSession, loadSession } from '@/server/auth/session';
import { createCampaignActionJob, createCampaignReadBackJob, type CampaignJobDeps } from '@/server/jobs/handlers/campaign-action';
import { createCampaignMetricsSyncJob } from '@/server/jobs/handlers/campaign-metrics-sync';
import { createMetaLeadBackfillJob, createMetaLeadFetchJob, type MetaLeadDeps } from '@/server/jobs/handlers/meta-lead-fetch';
import { createWebhookPurgeJob } from '@/server/jobs/handlers/webhook-purge';
import { buildJobRegistry } from '@/server/jobs/registry';
import { credentialAad, encryptSecret, type KeyRing } from '@/server/security/secrets';
import type { LiveAdapterDeps } from '@/server/services/integrations/live-testers';
import type { GraphHttp } from '@/server/adapters/whatsapp/cloud-api';
import { GET as metaGet, POST as metaPost } from '@/app/api/webhooks/meta-ads/route';
import { createWorker, type Worker } from '../../../worker/worker';
import { createTestDb, type TestDb } from '../../support/db';
import { testConfig, uninstallRuntime, useRuntime as installTestRuntime } from '../auth/support';
import { FakeGraph } from '../contract/whatsapp-support';

export const NOW = '2026-10-20T06:00:00.000Z';
export const ORIGIN = 'http://localhost:3000';
export const APP_SECRET = `meta-ads-app-secret-for-tests-${'m'.repeat(12)}`;
export const VERIFY_TOKEN = 'auralead-meta-verify-token-test';
export const PEPPER = `meta-t35-pepper-${'p'.repeat(32)}`;
export const KEY_RING: KeyRing = { activeKid: 'k1', keys: { k1: Buffer.alloc(32, 13) } };
export const GRAPH_VERSION = 'v24.0';
export const MARKETING_VERSION = 'v25.0';
export const PAGE_A = '110000000000001';
export const PAGE_B = '120000000000001';
export const FORM_A = '210000000000001';
export const AD_ACCOUNT = '510000000000001';
export const CAMPAIGN = '410000000000001';
export const ACCESS_TOKEN = 'EAAGmetatesttokenYYYY0000000000000000000000abcd';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../../fixtures/meta/documented-shape');

export function metaFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as T;
}

type Sources = { files: Record<string, { httpStatus?: number }> };

/** A fixture as a FakeGraph answer with its documented HTTP status. */
export function metaAnswer(name: string, headers?: Record<string, string>) {
  const status = metaFixture<Sources>('SOURCES.json').files[name]?.httpStatus;
  if (status === undefined) throw new Error(`no HTTP status recorded for fixture ${name}`);
  return { status, body: metaFixture(name), ...(headers ? { headers } : {}) };
}

export type MetaHarness = {
  testDb: TestDb;
  db: PrismaClient;
  clock: FixedClock;
  config: AppConfig;
  graph: FakeGraph;
  wsA: string;
  wsB: string;
  flags: { graphVersion: string | null; marketingVersion: string | null };
  /** Runs before every scripted Graph answer (to observe the DB at the moment of the provider call). */
  hooks: { beforeRequest: ((url: string) => Promise<void>) | null };
  deps: () => LiveAdapterDeps;
  leadDeps: () => MetaLeadDeps;
  ownerCtx: (workspace?: 'A' | 'B') => Promise<AppCtx>;
  memberCtx: () => Promise<AppCtx>;
  worker: Worker;
  drain: () => Promise<number>;
  destroy: () => Promise<void>;
};

let seq = 0;

export async function createMetaHarness(label: string): Promise<MetaHarness> {
  const testDb = await createTestDb({ label });
  const db = testDb.client();
  const clock = new FixedClock(NOW);
  const config = testConfig('live', {
    META_APP_SECRET: APP_SECRET,
    META_VERIFY_TOKEN: VERIFY_TOKEN,
    META_GRAPH_VERSION: GRAPH_VERSION,
    META_MARKETING_VERSION: MARKETING_VERSION,
    SUPPRESSION_PEPPER: PEPPER,
    CREDENTIALS_KEYRING: JSON.stringify({ k1: KEY_RING.keys.k1!.toString('base64') }),
    CREDENTIALS_ACTIVE_KID: 'k1',
  });
  installTestRuntime(db, config, clock);
  const make = async (slug: string, name: string) => {
    const ws = await db.workspace.create({ data: { slug, name, mode: 'LIVE', planLabel: 'Growth', timezone: 'Asia/Kolkata' } });
    await db.workspaceSettings.create({ data: { workspaceId: ws.id, maxDiscountBps: 1000, brandColor: '#0F766E', termsText: 'Terms' } });
    const owner = await db.user.create({ data: { email: `owner@${slug}.test`, name: `${name} Owner`, globalRole: 'USER', isDemo: false } });
    await db.membership.create({ data: { userId: owner.id, workspaceId: ws.id, role: 'OWNER' } });
    return { ws, owner };
  };
  const a = await make('live-meta-a', 'Live Meta A');
  const b = await make('live-meta-b', 'Live Meta B');
  const member = await db.user.create({ data: { email: 'member@live-meta-a.test', name: 'Member A', globalRole: 'USER', isDemo: false } });
  await db.membership.create({ data: { userId: member.id, workspaceId: a.ws.id, role: 'MEMBER' } });

  const graph = new FakeGraph();
  const flags: MetaHarness['flags'] = { graphVersion: GRAPH_VERSION, marketingVersion: MARKETING_VERSION };
  const hooks: MetaHarness['hooks'] = { beforeRequest: null };
  const http: GraphHttp = async (url, init) => {
    if (hooks.beforeRequest) await hooks.beforeRequest(url);
    return graph.http(url, init);
  };
  const deps = (): LiveAdapterDeps => ({ keyRing: KEY_RING, graphVersion: flags.graphVersion, marketingVersion: flags.marketingVersion, graph: { http } });
  const leadDeps = (): MetaLeadDeps => ({ ...deps(), contactKeyPepper: PEPPER, mode: 'live' });
  const campaignDeps = (): CampaignJobDeps => ({ ...deps(), mode: 'live' });
  const live = () => 'live' as const;
  const registry = buildJobRegistry([
    createMetaLeadFetchJob({ deps: leadDeps }),
    createMetaLeadBackfillJob({ deps: leadDeps }),
    createCampaignActionJob({ deps: campaignDeps }),
    createCampaignReadBackJob({ deps: campaignDeps }),
    createCampaignMetricsSyncJob({ mode: live, deps }),
    createWebhookPurgeJob(),
  ]);
  const worker = createWorker(
    { db, clock, registry, logger: createLogger({ level: 'silent' }), mode: 'live', version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
  const drain = async () => {
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  };
  const ctxFor = async (userId: string, workspaceId: string): Promise<AppCtx> => {
    seq += 1;
    const { token } = await createSession(db, { userId, globalRole: 'USER', mode: 'LIVE', activeWorkspaceId: workspaceId, ipHash: 'live', userAgent: 'vitest', now: clock.now() });
    const loaded = (await loadSession(db, token, { now: clock.now(), mode: 'LIVE' }))!;
    return buildUserContext(loaded, { prisma: db, mode: 'live', clock }, { correlationId: `req_t35_${String(seq).padStart(4, '0')}` });
  };
  return {
    testDb,
    db,
    clock,
    config,
    graph,
    wsA: a.ws.id,
    wsB: b.ws.id,
    flags,
    hooks,
    deps,
    leadDeps,
    ownerCtx: (w = 'A') => (w === 'A' ? ctxFor(a.owner.id, a.ws.id) : ctxFor(b.owner.id, b.ws.id)),
    memberCtx: () => ctxFor(member.id, a.ws.id),
    worker,
    drain,
    destroy: async () => {
      uninstallRuntime();
      await testDb.destroy();
    },
  };
}

/** A META_ADS integration stored exactly as the T32 credential writer stores it, routed by its Page id. */
export async function storeMeta(
  h: MetaHarness,
  opts: { workspaceId?: string; pageId?: string; status?: 'CONNECTED' | 'CONFIGURED_UNVERIFIED' | 'DEGRADED' | 'ERROR' | 'REVOKED'; verified?: boolean; adAccountId?: string | null; token?: string } = {},
) {
  const workspaceId = opts.workspaceId ?? h.wsA;
  const pageId = opts.pageId ?? PAGE_A;
  const status = opts.status ?? 'CONNECTED';
  const config: Record<string, string> = { pageId };
  if (opts.adAccountId !== null) config.adAccountId = opts.adAccountId ?? AD_ACCOUNT;
  const existing = await h.db.integration.findFirst({ where: { workspaceId, kind: 'META_ADS' } });
  const row = existing ?? (await h.db.integration.create({ data: { workspaceId, kind: 'META_ADS', status, config, routingKey: pageId } }));
  const token = opts.token ?? ACCESS_TOKEN;
  const envelope = encryptSecret(KEY_RING, token, credentialAad({ workspaceId, integrationId: row.id, field: 'accessToken' }));
  const verified = opts.verified ?? (status === 'CONNECTED' || status === 'DEGRADED');
  return h.db.integration.update({
    where: { id: row.id },
    data: { status, config, secrets: { accessToken: envelope }, secretLast4: { accessToken: { last4: token.slice(-4), updatedAt: NOW } }, verifiedAt: verified ? h.clock.now() : null, lastErrorCode: null, lastErrorRedacted: null },
  });
}

/** The form mapping of FORM_A with Meta's standard keys and a WhatsApp consent question (P1). */
export async function storeFormMapping(h: MetaHarness, integrationId: string, workspaceId = h.wsA, formId = FORM_A) {
  return h.db.metaFormMapping.create({
    data: {
      workspaceId,
      integrationId,
      formId,
      fieldMap: { name: 'full_name', phone: 'phone_number', email: 'email', city: 'city' },
      consentMapping: { column: 'whatsapp_updates', truthyValues: ['yes'], channel: 'WHATSAPP', purpose: 'MARKETING', noticeText: 'I agree to receive updates on WhatsApp. Reply STOP to opt out.' },
    },
  });
}

export function signBody(raw: string | Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

const noParams = { params: Promise.resolve({}) };

export function postMetaRaw(raw: string, headers: Record<string, string>): Promise<Response> {
  return metaPost(new Request(`${ORIGIN}/api/webhooks/meta-ads`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }), noParams);
}

/** POSTs a payload signed with the test app secret, exactly as Meta would. */
export function postMeta(payload: unknown): Promise<Response> {
  const raw = JSON.stringify(payload);
  return postMetaRaw(raw, { 'x-hub-signature-256': signBody(raw) });
}

export function getMeta(query: string): Promise<Response> {
  return metaGet(new Request(`${ORIGIN}/api/webhooks/meta-ads?${query}`), noParams);
}

/** A Page delivery with one leadgen change per leadgen id. */
export function leadgenDelivery(leadgenIds: string[], opts: { pageId?: string; formId?: string } = {}) {
  const pageId = opts.pageId ?? PAGE_A;
  return {
    object: 'page',
    entry: [
      {
        id: pageId,
        time: 1760940000,
        changes: leadgenIds.map((id) => ({ field: 'leadgen', value: { ad_id: '310000000000001', form_id: opts.formId ?? FORM_A, leadgen_id: id, created_time: 1760939990, page_id: pageId, adgroup_id: '710000000000001' } })),
      },
    ],
  };
}

/** The documented lead with another id (and optionally other answers). */
export function leadWithId(id: string, overrides: Record<string, unknown> = {}) {
  return { status: 200, body: { ...metaFixture('response.lead.json'), id, ...overrides } };
}
