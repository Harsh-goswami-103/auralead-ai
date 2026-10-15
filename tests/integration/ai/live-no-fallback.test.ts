// R1, C13, ADR-18: in LIVE an AI provider failure never falls back to the local generator
// silently.
// - A retryable failure (5xx) on a non-final attempt throws so the job retries; nothing is stored.
// - On the final attempt it becomes a NEEDS_REVIEW draft labelled with the provider, with no
//   generated text and no local output.
// - Non-retryable failures (401, refusal) go to NEEDS_REVIEW at once.
// - Malformed output gets exactly one repair call, then NEEDS_REVIEW.
// - With no AI integration configured, nothing is called and the draft is NEEDS_REVIEW
//   (AI_NOT_CONFIGURED).
// - Only the explicit "Generate with local template" action (ai.draft job, LOCAL_EXPLICIT)
//   produces local output, labelled `local-deterministic` on the draft and in the audit.
// - DEMO uses the local generator by default and never calls a provider.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { ProviderUnavailableError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { withTx } from '@/server/db/tx';
import { AI_DRAFT_JOB, createAiDraftJob } from '@/server/jobs/handlers/ai-draft';
import { buildJobRegistry } from '@/server/jobs/registry';
import { generateLeadDraft, persistLeadDraft, requestLeadDraft, type DraftDeps } from '@/server/services/ai/drafts';
import { createWorker } from '../../../worker/worker';
import { createMockTransport, fixture } from '../contract/support';
import { ANTHROPIC_KEY, createAiHarness, createLead, jobCtx, KEY_RING, makeLive, ownerCtx, WS_A, WS_B, type AiHarness } from './support';

let h: AiHarness;
let db: PrismaClient;
let t: ReturnType<typeof createMockTransport>;
let deps: DraftDeps;

beforeAll(async () => {
  h = await createAiHarness('ai-live-no-fallback');
  db = h.db;
});
afterAll(async () => {
  await h.testDb.destroy();
});
beforeEach(async () => {
  await t?.close();
  t = createMockTransport('https://api.anthropic.com');
  deps = { keyRing: KEY_RING, transport: { fetch: t.fetch, timeoutMs: 2_000 } };
  await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, modelId: 'claude-sonnet-5-5' });
});

async function generate(leadId: string, finalAttempt: boolean) {
  const ctx = jobCtx(db, h.clock, 'live');
  const draft = await generateLeadDraft(ctx, { leadId, trigger: 'MANUAL', requestedBy: 'user_test', finalAttempt }, deps);
  const { id } = await withTx(db, (tx) => persistLeadDraft(tx, ctx, draft));
  return db.aiDraft.findUniqueOrThrow({ where: { id } });
}

const NO_OUTPUT = { followUpText: null, emailSubject: null, emailBody: null, proposal: null, pricingPreview: null, templateVariables: { templateId: null, values: [] } };

describe('LIVE provider failure: no silent fallback', () => {
  it('5xx on a non-final attempt throws a retryable error and stores nothing', async () => {
    const lead = await createLead(db);
    t.reply('/v1/messages', 500, fixture('anthropic', 'error-529'));
    const ctx = jobCtx(db, h.clock, 'live');
    await expect(generateLeadDraft(ctx, { leadId: lead.id, trigger: 'MANUAL', requestedBy: 'user_test', finalAttempt: false }, deps)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(await db.aiDraft.count({ where: { leadId: lead.id } })).toBe(0);
    expect(t.captured).toHaveLength(1);
  });

  it('5xx on the final attempt gives NEEDS_REVIEW labelled anthropic, with no local output', async () => {
    const lead = await createLead(db);
    t.reply('/v1/messages', 529, fixture('anthropic', 'error-529'));
    const row = await generate(lead.id, true);
    expect(row).toMatchObject({ status: 'NEEDS_REVIEW', generatorLabel: 'anthropic', modelId: 'claude-sonnet-5-5', errorCode: 'PROVIDER_UNAVAILABLE', escalated: false, ...NO_OUTPUT });
    expect(row.reviewReasons).toEqual([{ code: 'GENERATION_FAILED', errorCode: 'PROVIDER_UNAVAILABLE', localGeneratorAvailable: true }]);
    expect(t.captured).toHaveLength(1);
  });

  it('401 and refusal go to NEEDS_REVIEW immediately, even on a first attempt', async () => {
    const a = await createLead(db);
    t.reply('/v1/messages', 401, fixture('anthropic', 'error-401'));
    expect(await generate(a.id, false)).toMatchObject({ status: 'NEEDS_REVIEW', generatorLabel: 'anthropic', errorCode: 'PROVIDER_AUTH', ...NO_OUTPUT });

    const b = await createLead(db);
    t.reply('/v1/messages', 200, fixture('anthropic', 'refusal'));
    expect(await generate(b.id, false)).toMatchObject({ status: 'NEEDS_REVIEW', generatorLabel: 'anthropic', errorCode: 'AI_REFUSAL', ...NO_OUTPUT });
    expect(t.captured).toHaveLength(2);
  });

  it('malformed output gets exactly one repair call, then NEEDS_REVIEW', async () => {
    const lead = await createLead(db);
    const malformed = { ...fixture('anthropic', 'success'), content: [{ type: 'text', text: 'Sure! Here is a draft for Priya.' }] };
    t.reply('/v1/messages', 200, malformed);
    t.reply('/v1/messages', 200, malformed);
    const row = await generate(lead.id, true);
    expect(row).toMatchObject({ status: 'NEEDS_REVIEW', generatorLabel: 'anthropic', errorCode: 'AI_MALFORMED_OUTPUT', ...NO_OUTPUT });
    expect(t.captured).toHaveLength(2);
    const repairMessages = t.captured[1]!.body.messages as Array<{ role: string }>;
    expect(repairMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('a successful repair gives a usable draft from the provider', async () => {
    const lead = await createLead(db);
    t.reply('/v1/messages', 200, fixture('anthropic', 'max-tokens'));
    const good = fixture('anthropic', 'success') as { content: Array<{ type: string; text?: string }> };
    const output = JSON.parse(good.content[1]!.text!) as { proposal: { items: Array<{ serviceId: string }> } };
    output.proposal.items = [];
    t.reply('/v1/messages', 200, { ...good, content: [{ type: 'text', text: JSON.stringify(output) }] });
    const row = await generate(lead.id, true);
    expect(row.generatorLabel).toBe('anthropic');
    expect(row.errorCode).toBeNull();
    expect(row.followUpText).toContain('teeth whitening');
    expect(row.reviewReasons).toEqual([{ code: 'NO_ITEMS' }]);
    expect(t.captured).toHaveLength(2);
    // The repair after truncation raises max_tokens by half.
    expect(t.captured[1]!.body.max_tokens).toBe(Math.round((t.captured[0]!.body.max_tokens as number) * 1.5));
  });

  it('with no AI integration configured, nothing is called: NEEDS_REVIEW AI_NOT_CONFIGURED', async () => {
    await makeLive(db, WS_A);
    const lead = await createLead(db);
    const row = await generate(lead.id, false);
    expect(row).toMatchObject({ status: 'NEEDS_REVIEW', generatorLabel: 'none', errorCode: 'AI_NOT_CONFIGURED', ...NO_OUTPUT });
    expect(row.reviewReasons).toEqual([{ code: 'AI_NOT_CONFIGURED', localGeneratorAvailable: true }]);
    expect(t.captured).toHaveLength(0);
  });

  it('a revoked integration is not used', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, status: 'REVOKED' });
    const lead = await createLead(db);
    expect(await generate(lead.id, false)).toMatchObject({ generatorLabel: 'none', errorCode: 'AI_NOT_CONFIGURED' });
    expect(t.captured).toHaveLength(0);
  });
});

describe('the explicit local action (ai.draft job)', () => {
  async function runJobs(mode: 'demo' | 'live') {
    const registry = buildJobRegistry([createAiDraftJob({ mode: () => mode, deps: () => deps })]);
    const worker = createWorker(
      { db, clock: h.clock, registry, logger: createLogger({ level: 'silent' }), mode, version: 'test', random: () => 0 },
      { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
    );
    let ran = 0;
    while ((await worker.tick()) === 'ran') ran += 1;
    return ran;
  }

  it('produces local output labelled local-deterministic, in the draft and the audit, with zero provider calls', async () => {
    const lead = await createLead(db);
    const owner = ownerCtx(db, h.clock, 'live');
    const { jobId } = await requestLeadDraft(owner, { leadId: lead.id, local: true });
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ type: AI_DRAFT_JOB, workspaceId: WS_A, payload: { leadId: lead.id, trigger: 'LOCAL_EXPLICIT', requestedBy: owner.actor!.userId } });
    expect(await db.auditEvent.count({ where: { action: 'ai.draft.request', targetId: lead.id } })).toBe(1);

    expect(await runJobs('live')).toBe(1);
    const row = await db.aiDraft.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(row).toMatchObject({ trigger: 'LOCAL_EXPLICIT', generatorLabel: 'local-deterministic', modelId: 'local-deterministic-v1', status: 'READY', requestedBy: owner.actor!.userId });
    expect(row.followUpText).toBeTruthy();
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'ai.draft.generate', targetId: row.id } });
    expect(audit.summary).toMatchObject({ generatorLabel: 'local-deterministic', trigger: 'LOCAL_EXPLICIT' });
    expect(audit.correlationId).toBe(owner.correlationId);
    expect(t.captured).toHaveLength(0);
  });

  it('a manual (non-local) request in LIVE uses the provider and, on a hard failure, stores NEEDS_REVIEW (no local)', async () => {
    const lead = await createLead(db);
    t.reply('/v1/messages', 401, fixture('anthropic', 'error-401'));
    await requestLeadDraft(ownerCtx(db, h.clock, 'live'), { leadId: lead.id, local: false });
    expect(await runJobs('live')).toBe(1);
    const row = await db.aiDraft.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(row).toMatchObject({ trigger: 'MANUAL', generatorLabel: 'anthropic', status: 'NEEDS_REVIEW', errorCode: 'PROVIDER_AUTH', followUpText: null });
    expect(t.captured).toHaveLength(1);
  });

  it('a foreign lead id is 404 and enqueues nothing', async () => {
    const foreign = await createLead(db, WS_B);
    const before = await db.job.count();
    await expect(requestLeadDraft(ownerCtx(db, h.clock, 'live'), { leadId: foreign.id, local: true })).rejects.toMatchObject({ status: 404 });
    expect(await db.job.count()).toBe(before);
  });

  it('needs the drafts.generate capability (403 within the workspace)', async () => {
    const lead = await createLead(db);
    const ctx = { ...ownerCtx(db, h.clock, 'live'), capabilities: new Set<never>() };
    await expect(requestLeadDraft(ctx, { leadId: lead.id, local: true })).rejects.toMatchObject({ status: 403 });
  });
});

describe('DEMO', () => {
  it('uses the local generator by default and never calls a provider', async () => {
    await db.workspace.update({ where: { id: WS_A }, data: { mode: 'DEMO' } });
    const lead = await createLead(db);
    const ctx = jobCtx(db, h.clock, 'demo');
    const draft = await generateLeadDraft(ctx, { leadId: lead.id, trigger: 'MANUAL', requestedBy: 'user_test', finalAttempt: false }, deps);
    expect(draft.generatorLabel).toBe('local-deterministic');
    expect(draft.status).toBe('READY');
    expect(t.captured).toHaveLength(0);
  });
});
