// Lead-gen B2 (ADR-18; ADR-122..124 reuse it): `selectWorkspaceAi(ctx, deps)` picks the generator
// for any AI task of the caller's workspace.
// - DEMO: the labelled local generator, always; integration rows are never read.
// - LIVE: the workspace's own decrypted integration, Anthropic first, then OpenAI (with a model id).
//   With none usable (missing, revoked, no key ring, undecryptable key), the result is a typed
//   AI_NOT_CONFIGURED: never a silent switch to the local generator.
// - Only an explicit local action (forceLocal) gets the local generator in LIVE.
// - A workspace whose stored mode differs from the process mode is refused (MODE_MISMATCH).
// - Another workspace's integration is never used (tenant-scoped reads).
// Then `runStructuredTask` runs a non-draft task end to end through the real Anthropic adapter
// (undici MockAgent, net connect disabled), including its one repair call.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PrismaClient } from '@/generated/prisma/client';
import { credentialAad, encryptSecret, type KeyRing } from '@/server/security/secrets';
import { runStructuredTask, selectWorkspaceAi, taskUserMessage, type AiDeps } from '@/server/services/ai/run-task';
import { createMockTransport, fixture } from '../contract/support';
import { ANTHROPIC_KEY, createAiHarness, jobCtx, KEY_RING, makeLive, WS_A, WS_B, type AiHarness } from './support';

const OPENAI_KEY = 'sk-proj-integration-test-key-0000000000000000000000000000';

let h: AiHarness;
let db: PrismaClient;
let t: ReturnType<typeof createMockTransport>;
let deps: AiDeps;

beforeAll(async () => {
  h = await createAiHarness('ai-run-task');
  db = h.db;
});
afterAll(async () => {
  await t?.close();
  await h.testDb.destroy();
});
beforeEach(async () => {
  await t?.close();
  t = createMockTransport('https://api.anthropic.com');
  deps = { keyRing: KEY_RING, transport: { fetch: t.fetch, timeoutMs: 2_000 } };
  await makeLive(db, WS_B);
});

/** Adds an OpenAI integration next to whatever makeLive left in place. */
async function addOpenAi(workspaceId: string, modelId: string | null) {
  const row = await db.integration.create({ data: { workspaceId, kind: 'AI_OPENAI', status: 'CONNECTED', config: modelId === null ? {} : { modelId } } });
  const envelope = encryptSecret(KEY_RING, OPENAI_KEY, credentialAad({ workspaceId, integrationId: row.id, field: 'apiKey' }));
  await db.integration.update({ where: { id: row.id }, data: { secrets: { apiKey: envelope } } });
}

describe('selectWorkspaceAi: LIVE', () => {
  it('uses the workspace Anthropic integration with its model id', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, modelId: 'claude-sonnet-5-5' });
    const selection = await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps);
    expect(selection.ok && { label: selection.port.label, modelId: selection.port.modelId }).toEqual({ label: 'anthropic', modelId: 'claude-sonnet-5-5' });
  });

  it('prefers Anthropic over OpenAI when both are configured', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, modelId: null });
    await addOpenAi(WS_A, 'gpt-5.2');
    const selection = await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps);
    expect(selection.ok && selection.port.label).toBe('anthropic');
  });

  it('uses OpenAI when it is the only integration and has a model id', async () => {
    await makeLive(db, WS_A);
    await addOpenAi(WS_A, 'gpt-5.2');
    const selection = await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps);
    expect(selection.ok && { label: selection.port.label, modelId: selection.port.modelId }).toEqual({ label: 'openai', modelId: 'gpt-5.2' });
  });

  it('with no AI integration: a typed AI_NOT_CONFIGURED, not the local generator', async () => {
    await makeLive(db, WS_A);
    expect(await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps)).toEqual({ ok: false, code: 'AI_NOT_CONFIGURED', errorCode: 'AI_NOT_CONFIGURED', label: 'none', modelId: null });
  });

  it('a revoked integration, or OpenAI without a model id, is not usable', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, status: 'REVOKED' });
    await addOpenAi(WS_A, null);
    expect(await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps)).toMatchObject({ ok: false, code: 'AI_NOT_CONFIGURED' });
  });

  it('without a key ring nothing is decrypted: AI_NOT_CONFIGURED', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY });
    expect(await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), { keyRing: null })).toMatchObject({ ok: false, code: 'AI_NOT_CONFIGURED', errorCode: 'AI_NOT_CONFIGURED' });
  });

  it('a key that does not decrypt is AI_NOT_CONFIGURED with errorCode CREDENTIAL_DECRYPT_FAILED', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const otherRing: KeyRing = { activeKid: 'k1', keys: { k1: randomBytes(32) } };
    expect(await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), { keyRing: otherRing })).toEqual({
      ok: false,
      code: 'AI_NOT_CONFIGURED',
      errorCode: 'CREDENTIAL_DECRYPT_FAILED',
      label: 'none',
      modelId: null,
    });
  });

  it("never uses another workspace's integration", async () => {
    await makeLive(db, WS_A);
    await makeLive(db, WS_B, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY });
    expect(await selectWorkspaceAi(jobCtx(db, h.clock, 'live', WS_A), deps)).toMatchObject({ ok: false, code: 'AI_NOT_CONFIGURED' });
    const b = await selectWorkspaceAi(jobCtx(db, h.clock, 'live', WS_B), deps);
    expect(b.ok && b.port.label).toBe('anthropic');
  });

  it('forceLocal (an explicit local action) gets the labelled local generator', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const selection = await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps, { forceLocal: true });
    expect(selection.ok && selection.port.label).toBe('local-deterministic');
  });

  it('a DEMO workspace under a LIVE process is refused (MODE_MISMATCH)', async () => {
    await db.workspace.update({ where: { id: WS_A }, data: { mode: 'DEMO' } });
    expect(await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps)).toEqual({ ok: false, code: 'MODE_MISMATCH', errorCode: 'MODE_MISMATCH', label: 'none', modelId: null });
  });
});

describe('selectWorkspaceAi: DEMO', () => {
  it('always the local generator, even with a configured provider integration', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY });
    await db.workspace.update({ where: { id: WS_A }, data: { mode: 'DEMO' } });
    const selection = await selectWorkspaceAi(jobCtx(db, h.clock, 'demo'), deps);
    expect(selection.ok && { label: selection.port.label, modelId: selection.port.modelId }).toEqual({ label: 'local-deterministic', modelId: 'local-deterministic-v1' });
  });

  it('a LIVE workspace under a DEMO process is refused (MODE_MISMATCH)', async () => {
    await makeLive(db, WS_A);
    expect(await selectWorkspaceAi(jobCtx(db, h.clock, 'demo'), deps)).toMatchObject({ ok: false, code: 'MODE_MISMATCH' });
  });
});

describe('runStructuredTask through the Anthropic adapter', () => {
  const schema = z.strictObject({ summary: z.string().trim().min(1).max(500) });
  const jsonSchema = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } };
  const anthropicText = (text: string) => ({ ...fixture('anthropic', 'success'), content: [{ type: 'text', text }] });

  it('sends the task message and structured-output schema, repairs once, and returns the parsed value', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY, modelId: 'claude-sonnet-5-5' });
    const selection = await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps);
    if (!selection.ok) throw new Error('expected a provider');
    t.reply('/v1/messages', 200, anthropicText('Here is the summary: interested in a website.'));
    t.reply('/v1/messages', 200, anthropicText(JSON.stringify({ summary: 'Interested in a five-page website.' })));

    const user = taskUserMessage('handoff_summary', { lead: { displayName: 'Ravi Dental' } });
    const result = await runStructuredTask({ port: selection.port, task: 'handoff_summary', system: 'Summarise.', user, jsonSchema, zod: schema, maxTokens: 800, finalAttempt: true });

    expect(result).toMatchObject({ ok: true, repaired: true, value: { summary: 'Interested in a five-page website.' } });
    expect(t.captured).toHaveLength(2);
    const first = t.captured[0]!.body as { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: string }>; output_config: unknown };
    expect(first).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 800, system: 'Summarise.', output_config: { format: { type: 'json_schema', schema: jsonSchema } } });
    expect(first.messages).toEqual([{ role: 'user', content: user }]);
    const repair = t.captured[1]!.body.messages as Array<{ role: string }>;
    expect(repair.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('a 401 is a failed result at once (no repair, no local output)', async () => {
    await makeLive(db, WS_A, { kind: 'AI_ANTHROPIC', apiKey: ANTHROPIC_KEY });
    const selection = await selectWorkspaceAi(jobCtx(db, h.clock, 'live'), deps);
    if (!selection.ok) throw new Error('expected a provider');
    t.reply('/v1/messages', 401, fixture('anthropic', 'error-401'));
    const result = await runStructuredTask({
      port: selection.port,
      task: 'handoff_summary',
      system: 'Summarise.',
      user: taskUserMessage('handoff_summary', {}),
      jsonSchema,
      zod: schema,
      maxTokens: 800,
      finalAttempt: false,
    });
    expect(!result.ok && result.error.code).toBe('PROVIDER_AUTH');
    expect(t.captured).toHaveLength(1);
  });
});
