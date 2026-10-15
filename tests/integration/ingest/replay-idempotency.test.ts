// AT3 / E2 (T11): webhook idempotency is scoped by the authenticated source (ADR-36).
// - The same event delivered twice creates one WebhookEvent, one ingest job and one lead; the
//   second delivery answers 200 DUPLICATE with the same event id (and, once processed, the stored
//   per-record result), and nothing is ever dispatched.
// - Identical event ids and batch ids sent to workspace A and workspace B, each through its own
//   integration (Sheets, Meta) or its own workspace scope (extension), are distinct events that
//   create distinct leads.
// - The same batch id with a changed record is 409 BATCH_CONTENT_MISMATCH and writes nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { IdempotencyConflictError } from '@/lib/errors';
import { getWebhookContext } from '@/server/auth/context';
import { persistWebhookEvent, sha256Hex, canonicalJson } from '@/server/services/webhooks/events';
import { ensureSimulatedSheets } from '@/server/services/webhooks/simulate';
import { createHarness, eventsOf, sessionFor, simulate, WS_A, WS_A_SLUG, WS_B, WS_B_SLUG, type Auth, type Harness } from '../webhooks/support';

let h: Harness;
let db: PrismaClient;
let auth: Auth;

beforeAll(async () => {
  h = await createHarness('replay-idempotency');
  db = h.db;
  auth = await sessionFor(h, 'employee'); // assigned to both workspace A and workspace B with leads.write
});
afterAll(async () => {
  await h?.destroy();
});

async function totals() {
  return {
    events: await db.webhookEvent.count(),
    leads: await db.lead.count(),
    ingestJobs: await db.job.count({ where: { type: 'ingest.process' } }),
    dispatch: await db.dispatchAttempt.count(),
    messages: await db.message.count(),
  };
}

describe('replays (AT3)', () => {
  it.each(['sheets', 'gmaps'] as const)('%s: the same event twice gives +1 lead, +1 ingest job, 0 dispatch; the replay is 200 DUPLICATE', async (source) => {
    const before = await totals();
    const body = { workspaceSlug: WS_A_SLUG, count: 1, batchId: `replay-${source}` };

    const first = await simulate(source, body, auth);
    expect(first.status).toBe(200);
    const [e1] = eventsOf(first);
    expect(e1!.outcome).toBe('ACCEPTED');

    const second = await simulate(source, body, auth);
    expect(second.status).toBe(200);
    const [e2] = eventsOf(second);
    expect(e2).toMatchObject({ outcome: 'DUPLICATE', eventId: e1!.eventId, jobId: e1!.jobId, status: 'RECEIVED', result: null });

    await h.drain();

    // After processing, a further replay returns the stored per-record result, still no write.
    const third = await simulate(source, body, auth);
    const [e3] = eventsOf(third);
    expect(e3).toMatchObject({ outcome: 'DUPLICATE', eventId: e1!.eventId, status: 'PROCESSED' });
    const result = e3!.result as { counts: { accepted: number }; records: Array<{ status: string; leadId: string }> };
    expect(result.counts.accepted).toBe(1);
    expect(result.records[0]!.status).toBe('ACCEPTED');
    await h.drain();

    const after = await totals();
    expect(after.events - before.events).toBe(1);
    expect(after.leads - before.leads).toBe(1);
    expect(after.ingestJobs - before.ingestJobs).toBe(1);
    expect(after.dispatch).toBe(before.dispatch);
    expect(after.messages).toBe(before.messages);
    expect(await db.lead.count({ where: { id: result.records[0]!.leadId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'webhook.receive', targetId: e1!.eventId } })).toBe(1);
  });

  it('meta: a replayed leadgen notification is one event per leadgen, never a second lead', async () => {
    const before = await totals();
    const body = { workspaceSlug: WS_A_SLUG, count: 2, batchId: 'replay-meta' };
    const first = eventsOf(await simulate('meta', body, auth));
    const second = eventsOf(await simulate('meta', body, auth));
    expect(first.map((e) => e.outcome)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(second.map((e) => e.outcome)).toEqual(['DUPLICATE', 'DUPLICATE']);
    expect(second.map((e) => e.eventId)).toEqual(first.map((e) => e.eventId));
    expect(first.map((e) => e.externalKey)).toEqual([expect.stringMatching(/^meta:\d+:replay-meta-0$/), expect.stringMatching(/^meta:\d+:replay-meta-1$/)]);
    await h.drain();
    const after = await totals();
    expect(after.events - before.events).toBe(2);
    expect(after.leads - before.leads).toBe(2);
    expect(after.ingestJobs - before.ingestJobs).toBe(2);
    expect(after.dispatch).toBe(0);
  });
});

describe('scope keys (E2)', () => {
  it.each(['sheets', 'meta', 'gmaps'] as const)('%s: identical ids sent to workspace A and workspace B are distinct events and distinct leads', async (source) => {
    const batchId = `shared-${source}`;
    const a = eventsOf(await simulate(source, { workspaceSlug: WS_A_SLUG, count: 1, batchId }, auth));
    const b = eventsOf(await simulate(source, { workspaceSlug: WS_B_SLUG, count: 1, batchId }, auth));
    expect(a[0]!.outcome).toBe('ACCEPTED');
    expect(b[0]!.outcome).toBe('ACCEPTED');
    expect(b[0]!.externalKey).toBe(a[0]!.externalKey);
    expect(b[0]!.eventId).not.toBe(a[0]!.eventId);

    const [ea, eb] = await Promise.all([a[0]!, b[0]!].map((e) => db.webhookEvent.findUniqueOrThrow({ where: { id: e.eventId } })));
    expect(ea!.workspaceId).toBe(WS_A);
    expect(eb!.workspaceId).toBe(WS_B);
    expect(ea!.scopeKey).not.toBe(eb!.scopeKey);
    if (source === 'gmaps') {
      expect(ea!.scopeKey).toBe(WS_A);
      expect(eb!.scopeKey).toBe(WS_B);
    } else {
      const ia = await db.integration.findFirstOrThrow({ where: { workspaceId: WS_A, kind: source === 'sheets' ? 'GOOGLE_SHEETS' : 'META_ADS' } });
      const ib = await db.integration.findFirstOrThrow({ where: { workspaceId: WS_B, kind: source === 'sheets' ? 'GOOGLE_SHEETS' : 'META_ADS' } });
      expect(ea!.scopeKey).toBe(ia.id);
      expect(eb!.scopeKey).toBe(ib.id);
    }

    await h.drain();
    const [pa, pb] = await Promise.all([ea!, eb!].map((e) => db.webhookEvent.findUniqueOrThrow({ where: { id: e.id } })));
    const leadA = (pa!.result as { records: Array<{ leadId: string; status: string }> }).records[0]!;
    const leadB = (pb!.result as { records: Array<{ leadId: string; status: string }> }).records[0]!;
    expect(leadA.status).toBe('ACCEPTED');
    expect(leadB.status).toBe('ACCEPTED');
    expect(leadA.leadId).not.toBe(leadB.leadId);
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadA.leadId } })).workspaceId).toBe(WS_A);
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadB.leadId } })).workspaceId).toBe(WS_B);
  });

  it('the persistence service scopes by integration: one Sheets eventId through two integrations, and a replay within one', async () => {
    const correlationId = 'req_e2_direct_persist';
    const deps = { prisma: db, mode: 'demo' as const, clock: h.clock };
    const ctxA = getWebhookContext({ workspaceId: WS_A }, deps, correlationId);
    const ctxB = getWebhookContext({ workspaceId: WS_B }, deps, correlationId);
    const sheetsA = await ensureSimulatedSheets(ctxA);
    const sheetsB = await ensureSimulatedSheets(ctxB);
    const body = {
      version: 1,
      eventId: 'evt-direct-1',
      sheetId: 'sheet-direct',
      mappingVersion: sheetsA.mappingVersion,
      rows: [{ rowKey: 'row-1', submittedAt: '2026-10-16T05:00:00.000Z', values: { [sheetsA.fieldMap.name!]: 'Direct Persist', [sheetsA.fieldMap.phone!]: '+91 98100 77001' } }],
    };
    const input = (integrationId: string, workspaceId: string) => ({
      provider: 'GOOGLE_SHEETS' as const,
      workspaceId,
      integrationId,
      externalKey: 'evt-direct-1',
      body,
      bodySha256: sha256Hex(canonicalJson(body)),
      simulated: false,
      processJob: 'ingest.process' as const,
    });
    const ra = await persistWebhookEvent(db, ctxA, input(sheetsA.integrationId, WS_A), { keyRing: h.deps.keyRing });
    const rb = await persistWebhookEvent(db, ctxB, input(sheetsB.integrationId, WS_B), { keyRing: h.deps.keyRing });
    const replay = await persistWebhookEvent(db, ctxA, input(sheetsA.integrationId, WS_A), { keyRing: h.deps.keyRing });
    expect(ra.outcome).toBe('ACCEPTED');
    expect(rb.outcome).toBe('ACCEPTED');
    expect(rb.eventId).not.toBe(ra.eventId);
    expect(replay).toMatchObject({ outcome: 'DUPLICATE', eventId: ra.eventId, jobId: ra.jobId });

    await h.drain();
    const leads = await db.lead.findMany({ where: { displayName: 'Direct Persist' } });
    expect(leads.map((l) => l.workspaceId).sort()).toEqual([WS_A, WS_B].sort());
  });
});

describe('content mismatch', () => {
  it.each(['sheets', 'gmaps'] as const)('%s: the same batch id with a changed record is 409 BATCH_CONTENT_MISMATCH and writes nothing', async (source) => {
    const batchId = `changed-${source}`;
    const ok = await simulate(source, { workspaceSlug: WS_A_SLUG, count: 1, batchId }, auth);
    expect(ok.status).toBe(200);
    const before = await totals();
    const changed = await simulate(source, { workspaceSlug: WS_A_SLUG, count: 2, batchId }, auth);
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'BATCH_CONTENT_MISMATCH', reference: expect.any(String) });
    expect(await totals()).toEqual(before);
  });

  it('the service raises IdempotencyConflictError for a changed body under the same key', async () => {
    const ctx = getWebhookContext({ workspaceId: WS_A }, { prisma: db, mode: 'demo', clock: h.clock }, 'req_conflict_direct');
    const base = { provider: 'GMAPS_EXTENSION' as const, workspaceId: WS_A, integrationId: null, externalKey: 'batch-conflict', simulated: false, processJob: 'ingest.process' as const };
    const one = { version: 1, batchId: 'batch-conflict', records: [{ recordId: 'r1', name: 'Conflict One', phone: '+91 98100 77002' }] };
    const two = { ...one, records: [{ recordId: 'r1', name: 'Conflict Two', phone: '+91 98100 77002' }] };
    await persistWebhookEvent(db, ctx, { ...base, body: one, bodySha256: sha256Hex(canonicalJson(one)) }, { keyRing: h.deps.keyRing });
    const error = await persistWebhookEvent(db, ctx, { ...base, body: two, bodySha256: sha256Hex(canonicalJson(two)) }, { keyRing: h.deps.keyRing }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect(error).toMatchObject({ code: 'BATCH_CONTENT_MISMATCH', status: 409 });
  });
});
