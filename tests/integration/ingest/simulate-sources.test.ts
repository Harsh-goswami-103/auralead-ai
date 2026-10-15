// AT2 / R11 (T11): each DEMO source simulation (Google Sheets, Meta Lead Ads, Maps extension) goes
// through the same path as a verified webhook: POST /api/demo/simulate/[source] persists a
// WebhookEvent (redacted view + encrypted processing payload) and enqueues `ingest.process`; the
// worker decrypts the payload and calls the same ingestion service, which creates the Lead, its
// LeadSourceRecord, the ImportBatch, the pipeline job and the audit rows. Everything is durable
// (read back through a fresh client) and flagged simulated. LIVE mode and LIVE workspaces get 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LeadSource, PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { NotFoundError } from '@/lib/errors';
import { buildUserContext, getWebhookContext } from '@/server/auth/context';
import { loadSession } from '@/server/auth/session';
import { simulateSource } from '@/server/services/webhooks/simulate';
import { seedId } from '../../../prisma/seed/ids';
import { testConfig, useRuntime } from '../auth/support';
import { createHarness, eventsOf, sessionFor, simulate, WS_A, WS_A_SLUG, type Harness } from '../webhooks/support';

let h: Harness;
let db: PrismaClient;

beforeAll(async () => {
  h = await createHarness('simulate-sources');
  db = h.db;
});
afterAll(async () => {
  await h?.destroy();
});

const SOURCES: Array<{ source: 'sheets' | 'meta' | 'gmaps'; leadSource: LeadSource; provider: string; integrationKind: string | null; consents: number }> = [
  { source: 'sheets', leadSource: 'GOOGLE_SHEETS', provider: 'GOOGLE_SHEETS', integrationKind: 'GOOGLE_SHEETS', consents: 1 },
  { source: 'meta', leadSource: 'META_ADS', provider: 'META_ADS', integrationKind: 'META_ADS', consents: 1 },
  { source: 'gmaps', leadSource: 'GMAPS_EXTENSION', provider: 'GMAPS_EXTENSION', integrationKind: null, consents: 0 },
];

describe('DEMO source simulations (AT2)', () => {
  it.each(SOURCES)('$source creates leads, source records, jobs and audit through the webhook path', async ({ source, leadSource, provider, integrationKind, consents }) => {
    const auth = await sessionFor(h, 'employee');
    const before = {
      leads: await db.lead.count({ where: { workspaceId: WS_A, firstSource: leadSource } }),
      records: await db.leadSourceRecord.count({ where: { workspaceId: WS_A, source: leadSource } }),
    };

    const res = await simulate(source, { workspaceSlug: WS_A_SLUG, count: 2, batchId: `at2-${source}` }, auth);
    expect(res.status).toBe(200);
    const events = eventsOf(res);
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      expect(e.outcome).toBe('ACCEPTED');
      expect(e.status).toBe('RECEIVED');
      expect(e.jobId).toEqual(expect.any(String));
    }

    // Verify, persist, enqueue: nothing is ingested inside the request.
    expect(await db.lead.count({ where: { workspaceId: WS_A, firstSource: leadSource } })).toBe(before.leads);
    const stored = await db.webhookEvent.findMany({ where: { id: { in: events.map((e) => e.eventId) } } });
    expect(stored).toHaveLength(events.length);
    for (const e of stored) {
      expect(e).toMatchObject({ provider, workspaceId: WS_A, simulated: true, status: 'RECEIVED' });
      expect(e.processingPayload).toMatch(/^v1\./);
      expect(e.processingPurgedAt).toBeNull();
    }

    await h.drain();

    const leads = await db.lead.findMany({ where: { workspaceId: WS_A, firstSource: leadSource }, orderBy: { createdAt: 'asc' } });
    expect(leads).toHaveLength(before.leads + 2);
    const created = leads.slice(before.leads);
    for (const lead of created) {
      expect(lead.simulated).toBe(true);
      expect(lead.phoneE164).toMatch(/^\+91\d{10}$/);
      expect(lead.pipelineConfigVersionId).toEqual(expect.any(String));
    }
    expect(await db.leadSourceRecord.count({ where: { workspaceId: WS_A, source: leadSource } })).toBe(before.records + 2);
    expect(await db.leadSourceRecord.count({ where: { workspaceId: WS_A, source: leadSource, leadId: { in: created.map((l) => l.id) }, status: 'ACCEPTED' } })).toBe(2);

    const batches = await db.importBatch.findMany({ where: { workspaceId: WS_A, source: leadSource } });
    expect(batches.length).toBeGreaterThanOrEqual(1);
    for (const b of batches) expect(b).toMatchObject({ simulated: true, status: 'COMPLETED' });

    const processed = await db.webhookEvent.findMany({ where: { id: { in: events.map((e) => e.eventId) } } });
    for (const e of processed) {
      expect(e.status).toBe('PROCESSED');
      expect(e.processedAt).not.toBeNull();
      const result = e.result as { counts: { accepted: number }; records: Array<{ leadId: string | null; status: string }> };
      expect(result.records.every((r) => r.status === 'ACCEPTED' && r.leadId !== null)).toBe(true);
    }

    // Jobs: one ingest.process per event (succeeded), one pipeline.advance chain per lead, and the
    // purge of the processing payload scheduled after the retention window.
    const ingestJobs = await db.job.findMany({ where: { type: 'ingest.process', id: { in: events.map((e) => e.jobId!) } } });
    expect(ingestJobs.map((j) => j.status)).toEqual(events.map(() => 'SUCCEEDED'));
    for (const lead of created) {
      const execution = await db.pipelineExecution.findUniqueOrThrow({ where: { leadId: lead.id } });
      expect(await db.job.count({ where: { type: 'pipeline.advance', idempotencyKey: { startsWith: `pipeline.advance:${execution.id}:` } } })).toBeGreaterThanOrEqual(1);
    }
    for (const e of events) expect(await db.job.count({ where: { type: 'webhook.purge', idempotencyKey: `webhook.purge:${e.eventId}` } })).toBe(1);

    // Audit: the receipt (by the employee), the processing, the batch and each lead, all simulated.
    const employeeId = seedId('user', 'employee');
    const receipt = await db.auditEvent.findMany({ where: { action: 'webhook.receive', targetId: { in: events.map((e) => e.eventId) } } });
    expect(receipt).toHaveLength(events.length);
    for (const a of receipt) expect(a).toMatchObject({ workspaceId: WS_A, actorUserId: employeeId, actorKind: 'EMPLOYEE', simulated: true });
    expect(await db.auditEvent.count({ where: { action: 'webhook.process', targetId: { in: events.map((e) => e.eventId) }, simulated: true } })).toBe(events.length);
    for (const lead of created) {
      expect(await db.auditEvent.count({ where: { action: 'lead.ingest', targetId: lead.id, simulated: true, actorKind: 'WORKER' } })).toBe(1);
    }

    // The provider integration is a SIMULATED row in DEMO (sheets and meta); the extension is
    // scoped by workspace, as a token would be.
    if (integrationKind) {
      const integration = await db.integration.findFirstOrThrow({ where: { workspaceId: WS_A, kind: integrationKind as 'GOOGLE_SHEETS' } });
      expect(integration.status).toBe('SIMULATED');
      for (const e of processed) expect(e).toMatchObject({ integrationId: integration.id, scopeKey: integration.id });
    } else {
      for (const e of processed) expect(e).toMatchObject({ integrationId: null, scopeKey: WS_A });
    }

    // Consent comes only from a mapped form answer (P1): one of the two form rows opted in.
    expect(await db.consentRecord.count({ where: { workspaceId: WS_A, leadId: { in: created.map((l) => l.id) } } })).toBe(consents);

    // Durable: a fresh client (a reload) sees the same records.
    const fresh = h.testDb.client();
    expect(await fresh.lead.count({ where: { id: { in: created.map((l) => l.id) }, simulated: true } })).toBe(2);
    expect(await fresh.webhookEvent.count({ where: { id: { in: events.map((e) => e.eventId) }, status: 'PROCESSED' } })).toBe(events.length);
  });

  it('the redacted inspector view never holds a simulated phone number or email', async () => {
    const leads = await db.lead.findMany({ where: { workspaceId: WS_A, simulated: true } });
    const events = await db.webhookEvent.findMany({ where: { workspaceId: WS_A, simulated: true } });
    expect(events.length).toBeGreaterThan(0);
    const views = JSON.stringify(events.map((e) => e.payloadRedacted));
    for (const lead of leads) {
      if (lead.phoneE164) {
        expect(views).not.toContain(lead.phoneE164);
        expect(views).not.toContain(lead.phoneE164.slice(3));
      }
      if (lead.emailNormalized) expect(views.toLowerCase()).not.toContain(lead.emailNormalized);
    }
  });

  it('a workspace owner simulates into their own workspace without naming it', async () => {
    const res = await simulate('gmaps', { count: 1, batchId: 'owner-own-ws' }, await sessionFor(h, 'owner'));
    expect(res.status).toBe(200);
    const [event] = eventsOf(res);
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: event!.eventId } })).workspaceId).toBe(WS_A);
  });

  it('refuses callers outside the workspace or without leads.write, and unknown sources', async () => {
    const countBefore = await db.webhookEvent.count();
    expect((await simulate('sheets', { workspaceSlug: WS_A_SLUG }, null)).status).toBe(401);
    // neha: leads.read only in ironpulse-fitness.
    expect((await simulate('sheets', { workspaceSlug: 'ironpulse-fitness' }, await sessionFor(h, 'neha'))).status).toBe(403);
    // arjun: no assignment; the employee persona's nestkey assignment is inactive.
    expect((await simulate('sheets', { workspaceSlug: WS_A_SLUG }, await sessionFor(h, 'arjun'))).status).toBe(404);
    expect((await simulate('sheets', { workspaceSlug: 'nestkey-realty' }, await sessionFor(h, 'employee'))).status).toBe(404);
    // The owner of workspace A naming workspace B (by slug or by id) gets 404.
    expect((await simulate('sheets', { workspaceSlug: 'ironpulse-fitness' }, await sessionFor(h, 'owner'))).status).toBe(404);
    expect((await simulate('sheets', { workspaceId: seedId('workspace', 'ironpulse-fitness') }, await sessionFor(h, 'owner'))).status).toBe(404);
    expect((await simulate('sheets', { workspaceSlug: WS_A_SLUG }, await sessionFor(h, 'admin'))).status).toBe(404);
    expect((await simulate('whatsapp', { workspaceSlug: WS_A_SLUG }, await sessionFor(h, 'employee'))).status).toBe(404);
    expect((await simulate('sheets', { workspaceSlug: WS_A_SLUG, count: 11 }, await sessionFor(h, 'employee'))).status).toBe(400);
    expect(await db.webhookEvent.count()).toBe(countBefore);
  });

  it('a LIVE workspace, or a context in LIVE mode, is never simulated into (404, nothing written)', async () => {
    const live = await db.workspace.create({ data: { slug: 'live-shop', name: 'Live Shop', mode: 'LIVE', planLabel: 'Starter' } });
    const countBefore = await db.webhookEvent.count();
    const deps = { prisma: db, mode: 'demo' as const, clock: h.clock };
    const liveWsCtx = getWebhookContext({ workspaceId: live.id }, deps, 'req_sim_live_workspace');
    await expect(simulateSource(liveWsCtx, { source: 'sheets', count: 1 }, { keyRing: h.deps.keyRing })).rejects.toBeInstanceOf(NotFoundError);
    const liveModeCtx = getWebhookContext({ workspaceId: WS_A }, { ...deps, mode: 'live' }, 'req_sim_live_mode');
    await expect(simulateSource(liveModeCtx, { source: 'gmaps', count: 1 }, { keyRing: h.deps.keyRing })).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.webhookEvent.count()).toBe(countBefore);
    expect(await db.integration.count({ where: { workspaceId: live.id } })).toBe(0);

    // A user context resolves only DEMO workspaces in a DEMO process, so the route never reaches it.
    const auth = await sessionFor(h, 'employee');
    const token = decodeURIComponent(auth.cookie.split('=')[1]!);
    const loaded = await loadSession(db, token, { now: h.clock.now(), mode: 'DEMO' });
    const userCtx = await buildUserContext(loaded!, deps, { correlationId: 'req_sim_user_ctx', workspaceSlug: WS_A_SLUG });
    expect(userCtx.workspaceId).toBe(WS_A);
  });

  it('the route is 404 in a LIVE process before any session or body handling', async () => {
    const liveRuntime = useRuntime(db, testConfig('live'), new FixedClock(h.clock.now().toISOString()));
    try {
      const countBefore = await db.webhookEvent.count();
      const res = await simulate('sheets', { workspaceSlug: WS_A_SLUG }, await sessionFor({ ...h, config: liveRuntime.config }, 'employee'));
      expect(res.status).toBe(404);
      expect(await db.webhookEvent.count()).toBe(countBefore);
    } finally {
      useRuntime(db, h.config, h.clock);
    }
  });
});
