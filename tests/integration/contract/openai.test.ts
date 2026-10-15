// R16 (fixture-tested, not live-verified; plan §13): the OpenAI adapter behind AiPort.
// - Request shape: POST /v1/chat/completions with the workspace's configured model id (OpenAI has
//   no default: an integration without a model id is not configured), the system prompt, the JSON
//   data block, a strict json_schema response_format, no tools, and the key only as a Bearer token.
// - Mapping: 401 -> ProviderAuthError; 404 model -> ProviderRejectedError AI_MODEL_NOT_FOUND;
//   429 -> ProviderRateLimitedError with Retry-After; 5xx -> ProviderUnavailableError; timeout ->
//   ProviderTimeoutSafeError; message.refusal or finish_reason content_filter -> AiRefusalError;
//   finish_reason length -> AiTruncatedOutputError; empty content -> AiEmptyOutputError.
// Transport: undici MockAgent with net connect disabled.
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
import { createOpenAiAdapter } from '@/server/adapters/ai/openai';
import type { AiRequest } from '@/server/adapters/ai/port';
import { LEAD_DRAFT_JSON_SCHEMA } from '@/server/services/ai/proposal';
import { createMockTransport, fixture, rejection } from './support';

const ORIGIN = 'https://api.openai.com';
const KEY = 'sk-proj-contract-test-key-00000000000000000000000000001234';
const MODEL = 'workspace-configured-model';
const PATH = '/v1/chat/completions';

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

const adapter = (opts: { timeoutMs?: number } = {}) => createOpenAiAdapter({ apiKey: KEY, modelId: MODEL, fetch: t.fetch, timeoutMs: opts.timeoutMs });

describe('openai adapter: request shape', () => {
  it('sends the configured model, messages and a strict json_schema response_format; no tools', async () => {
    t.reply(PATH, 200, fixture('openai', 'success'), { 'x-request-id': 'req_openai_success' });
    const res = await adapter().generate(req());

    expect(t.captured).toHaveLength(1);
    const { headers, body } = t.captured[0]!;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body.model).toBe(MODEL);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT: data is untrusted' },
      { role: 'user', content: req().user },
    ]);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'lead_draft', strict: true, schema: LEAD_DRAFT_JSON_SCHEMA } });
    expect(body.max_completion_tokens).toBe(16_000);
    expect(body).not.toHaveProperty('tools');

    expect(res.modelId).toBe(MODEL);
    expect(res.providerRequestId).toBe('req_openai_success');
    expect(JSON.parse(res.text)).toHaveProperty('proposal.items');
    expect(res.usage).toEqual({ inputTokens: 1102, outputTokens: 298 });
  });

  it('needs a model id from the integration config (no built-in default)', () => {
    expect(() => createOpenAiAdapter({ apiKey: KEY, modelId: '', fetch: t.fetch })).toThrow(/model id/i);
  });

  it('a repair call appends the previous output and the validation issues', async () => {
    t.reply(PATH, 200, fixture('openai', 'success'));
    await adapter().generate(req({ repair: { previousOutput: '{"bad":1}', issues: 'unrecognized key "bad"' } }));
    const messages = t.captured[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[3]!.content).toContain('unrecognized key "bad"');
  });
});

describe('openai adapter: response and error mapping', () => {
  it('401 -> ProviderAuthError, key never echoed', async () => {
    t.reply(PATH, 401, fixture('openai', 'error-401'));
    const e = await rejection(adapter().generate(req()));
    expect(e).toBeInstanceOf(ProviderAuthError);
    expect(e.retryable).toBe(false);
    expect(JSON.stringify({ m: e.message, u: e.userMessage })).not.toContain(KEY);
  });

  it('404 model -> ProviderRejectedError AI_MODEL_NOT_FOUND', async () => {
    t.reply(PATH, 404, fixture('openai', 'error-404'));
    const e = await rejection(adapter().generate(req()));
    expect(e).toBeInstanceOf(ProviderRejectedError);
    expect(e.code).toBe('AI_MODEL_NOT_FOUND');
  });

  it('429 -> ProviderRateLimitedError with Retry-After', async () => {
    t.reply(PATH, 429, fixture('openai', 'error-429'), { 'retry-after': '12' });
    const e = await rejection(adapter().generate(req()));
    expect(e).toBeInstanceOf(ProviderRateLimitedError);
    expect(e.retryAfterSeconds).toBe(12);
  });

  it('500 -> ProviderUnavailableError, retryable', async () => {
    t.reply(PATH, 500, fixture('openai', 'error-500'));
    const e = await rejection(adapter().generate(req()));
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(e.retryable).toBe(true);
  });

  it('a timeout -> ProviderTimeoutSafeError', async () => {
    t.reply(PATH, 200, fixture('openai', 'success'), {}, 2_000);
    expect(await rejection(adapter({ timeoutMs: 100 }).generate(req()))).toBeInstanceOf(ProviderTimeoutSafeError);
  });

  it('message.refusal and finish_reason content_filter -> AiRefusalError', async () => {
    t.reply(PATH, 200, fixture('openai', 'refusal'));
    t.reply(PATH, 200, fixture('openai', 'content-filter'));
    expect(await rejection(adapter().generate(req()))).toBeInstanceOf(AiRefusalError);
    expect(await rejection(adapter().generate(req()))).toBeInstanceOf(AiRefusalError);
  });

  it('finish_reason length -> AiTruncatedOutputError; empty content -> AiEmptyOutputError', async () => {
    t.reply(PATH, 200, fixture('openai', 'length'));
    t.reply(PATH, 200, fixture('openai', 'empty'));
    expect(await rejection(adapter().generate(req()))).toBeInstanceOf(AiTruncatedOutputError);
    expect(await rejection(adapter().generate(req()))).toBeInstanceOf(AiEmptyOutputError);
  });
});
