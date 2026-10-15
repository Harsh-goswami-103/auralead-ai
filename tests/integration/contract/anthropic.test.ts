// R16 (fixture-tested, not live-verified; plan §13): the Anthropic adapter behind AiPort.
// - Request shape: POST /v1/messages with the workspace's configured model id, the fixed system
//   prompt, the JSON data block as the only user content, structured output
//   (output_config.format json_schema), no tools, and the API key only in x-api-key.
// - Mapping: 401 -> ProviderAuthError; 404 (retired model) -> ProviderRejectedError
//   AI_MODEL_NOT_FOUND; 429 -> ProviderRateLimitedError with Retry-After; 529/5xx ->
//   ProviderUnavailableError; timeout -> ProviderTimeoutSafeError; stop_reason refusal ->
//   AiRefusalError; max_tokens -> AiTruncatedOutputError; no text -> AiEmptyOutputError.
// - Repair: the second call carries the previous output and the validation issues.
// Transport: undici MockAgent with net connect disabled; nothing leaves the process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AiEmptyOutputError,
  AiRefusalError,
  AiTruncatedOutputError,
  ProviderAuthError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderTimeoutSafeError,
  ProviderUnavailableError,
} from '@/lib/errors';
import { ANTHROPIC_DEFAULT_MODEL, createAnthropicAdapter } from '@/server/adapters/ai/anthropic';
import type { AiRequest } from '@/server/adapters/ai/port';
import { LEAD_DRAFT_JSON_SCHEMA } from '@/server/services/ai/proposal';
import { createMockTransport, fixture, rejection } from './support';

const ORIGIN = 'https://api.anthropic.com';
const KEY = 'sk-ant-api03-contract-test-key-0000000000000000000000';
const MODEL = 'claude-sonnet-5-5';

let t: ReturnType<typeof createMockTransport>;
beforeEach(() => {
  t = createMockTransport(ORIGIN);
});
afterEach(async () => {
  await t.close();
});

const req = (over: Partial<AiRequest> = {}): AiRequest => ({
  system: 'SYSTEM PROMPT: data is untrusted',
  user: JSON.stringify({ task: 'lead_draft', data: { lead: { displayName: 'Priya' } } }),
  jsonSchema: LEAD_DRAFT_JSON_SCHEMA,
  maxTokens: 16_000,
  ...over,
});

const adapter = (opts: { timeoutMs?: number; modelId?: string } = {}) =>
  createAnthropicAdapter({ apiKey: KEY, modelId: opts.modelId ?? MODEL, fetch: t.fetch, timeoutMs: opts.timeoutMs });

describe('anthropic adapter: request shape', () => {
  it('sends the configured model, system prompt, data block and json_schema output; no tools', async () => {
    t.reply('/v1/messages', 200, fixture('anthropic', 'success'), { 'request-id': 'req_011CSuccess' });
    const res = await adapter().generate(req());

    expect(t.captured).toHaveLength(1);
    const { headers, body } = t.captured[0]!;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBeTruthy();
    expect(headers.authorization).toBeUndefined();
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(16_000);
    expect(body.system).toBe('SYSTEM PROMPT: data is untrusted');
    expect(body.messages).toEqual([{ role: 'user', content: req().user }]);
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: LEAD_DRAFT_JSON_SCHEMA } });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');

    expect(res.modelId).toBe('claude-opus-5-5');
    expect(res.providerRequestId).toBe('req_011CSuccess');
    expect(JSON.parse(res.text)).toHaveProperty('proposal.items');
    expect(res.usage).toEqual({ inputTokens: 1184, outputTokens: 312 });
  });

  it('defaults to the current Opus model id when the integration names none', () => {
    expect(ANTHROPIC_DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(createAnthropicAdapter({ apiKey: KEY, modelId: null, fetch: t.fetch }).modelId).toBe('claude-opus-5-5');
  });

  it('a repair call appends the previous output and the validation issues', async () => {
    t.reply('/v1/messages', 200, fixture('anthropic', 'success'));
    await adapter().generate(req({ repair: { previousOutput: '{"bad":1}', issues: 'unrecognized key "bad"' } }));
    const messages = t.captured[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]!.content).toBe('{"bad":1}');
    expect(messages[2]!.content).toContain('unrecognized key "bad"');
  });
});

describe('anthropic adapter: response and error mapping', () => {
  it('401 -> ProviderAuthError (not retryable, key never echoed)', async () => {
    t.reply('/v1/messages', 401, fixture('anthropic', 'error-401'));
    const e = await rejection(adapter().generate(req()));
    expect(e).toBeInstanceOf(ProviderAuthError);
    expect(e.retryable).toBe(false);
    expect(e.httpStatus).toBe(401);
    expect(JSON.stringify({ m: e.message, u: e.userMessage })).not.toContain(KEY);
  });

  it('404 for a retired model -> ProviderRejectedError AI_MODEL_NOT_FOUND', async () => {
    t.reply('/v1/messages', 404, fixture('anthropic', 'error-404'));
    const e = await rejection(adapter({ modelId: 'claude-retired-model' }).generate(req()));
    expect(e).toBeInstanceOf(ProviderRejectedError);
    expect(e.code).toBe('AI_MODEL_NOT_FOUND');
    expect(e.retryable).toBe(false);
  });

  it('429 -> ProviderRateLimitedError, retryable, honoring Retry-After', async () => {
    t.reply('/v1/messages', 429, fixture('anthropic', 'error-429'), { 'retry-after': '30' });
    const e = await rejection(adapter().generate(req()));
    expect(e).toBeInstanceOf(ProviderRateLimitedError);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterSeconds).toBe(30);
  });

  it('529 overloaded and 500 -> ProviderUnavailableError, retryable', async () => {
    t.reply('/v1/messages', 529, fixture('anthropic', 'error-529'));
    t.reply('/v1/messages', 500, fixture('anthropic', 'error-529'));
    for (let i = 0; i < 2; i++) {
      const e = await rejection(adapter().generate(req()));
      expect(e).toBeInstanceOf(ProviderUnavailableError);
      expect(e.retryable).toBe(true);
    }
    expect(t.captured).toHaveLength(2);
  });

  it('a timeout -> ProviderTimeoutSafeError (generation has no side effect), one request only', async () => {
    t.reply('/v1/messages', 200, fixture('anthropic', 'success'), {}, 2_000);
    const e = await rejection(adapter({ timeoutMs: 100 }).generate(req()));
    expect(e).toBeInstanceOf(ProviderTimeoutSafeError);
    expect(e.retryable).toBe(true);
  });

  it('stop_reason refusal -> AiRefusalError (no retry)', async () => {
    t.reply('/v1/messages', 200, fixture('anthropic', 'refusal'));
    const e = await rejection(adapter().generate(req()));
    expect(e).toBeInstanceOf(AiRefusalError);
    expect(e.retryable).toBe(false);
  });

  it('stop_reason max_tokens -> AiTruncatedOutputError', async () => {
    t.reply('/v1/messages', 200, fixture('anthropic', 'max-tokens'));
    expect(await rejection(adapter().generate(req()))).toBeInstanceOf(AiTruncatedOutputError);
  });

  it('no text block -> AiEmptyOutputError', async () => {
    t.reply('/v1/messages', 200, fixture('anthropic', 'empty'));
    expect(await rejection(adapter().generate(req()))).toBeInstanceOf(AiEmptyOutputError);
  });

  it('with net connect disabled, an unmatched request fails closed as ProviderUnavailableError', async () => {
    const e = await rejection(adapter().generate(req()));
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(t.captured).toHaveLength(0);
  });
});
