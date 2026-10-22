// Lead-gen B2 (ADR-18, ADR-122..124): `runStructuredTask` is the one structured-output loop every
// AI task shares (lead drafts today; conversation_reply, template_copy and handoff_summary next).
// - Valid output on the first call: one call, parsed by the task's zod schema.
// - Malformed, empty or truncated output gets exactly one repair call carrying the issues (and the
//   previous output when there was one); a truncation raises max tokens by half for the repair.
// - A second invalid output is a failed result (AI_MALFORMED_OUTPUT), never a third call.
// - A retryable provider failure is rethrown while job attempts remain (the job retries) and is a
//   failed result on the final attempt; auth failures and refusals fail at once, with no repair.
// - Errors that are not AppErrors (programming errors) are rethrown untouched.
// - The `task` argument must name the task in the JSON user message, so a local generator can
//   never be handed one task's data under another task's name.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiEmptyOutputError,
  AiMalformedOutputError,
  AiRefusalError,
  AiTruncatedOutputError,
  ProviderAuthError,
  ProviderRateLimitedError,
  ProviderUnavailableError,
} from '@/lib/errors';
import type { AiPort, AiRequest, AiResponse } from '@/server/adapters/ai/port';
import { runStructuredTask, taskUserMessage, NOT_JSON_ISSUES, EMPTY_OR_CUT_OFF_ISSUES } from '@/server/services/ai/run-task';

type Step = { text: string } | { error: Error };

/** A scripted port: each call consumes the next step and records the request it was given. */
function scriptedPort(steps: Step[]): AiPort & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    label: 'anthropic',
    modelId: 'claude-test',
    calls,
    async generate(request: AiRequest): Promise<AiResponse> {
      calls.push(request);
      const step = steps.shift();
      if (!step) throw new Error('scripted port: no step left');
      if ('error' in step) throw step.error;
      return { text: step.text, modelId: 'claude-test-actual', providerRequestId: 'req_1', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

const replySchema = z.strictObject({ reply: z.string().trim().min(1).max(200), escalate: z.boolean() });
const REPLY_JSON_SCHEMA = { type: 'object', additionalProperties: false, required: ['reply', 'escalate'], properties: { reply: { type: 'string' }, escalate: { type: 'boolean' } } };
const GOOD = JSON.stringify({ reply: 'We build websites for clinics.', escalate: false });
const USER = taskUserMessage('conversation_reply', { question: 'Do you build websites?' });

const input = (port: AiPort, over: Partial<{ finalAttempt: boolean; maxTokens: number; task: string; user: string }> = {}) => ({
  port,
  task: over.task ?? 'conversation_reply',
  system: 'You answer service questions.',
  user: over.user ?? USER,
  jsonSchema: REPLY_JSON_SCHEMA,
  zod: replySchema,
  maxTokens: over.maxTokens ?? 1_000,
  finalAttempt: over.finalAttempt ?? false,
});

describe('taskUserMessage', () => {
  it('is the JSON user message { task, data } every generator receives', () => {
    expect(JSON.parse(USER)).toEqual({ task: 'conversation_reply', data: { question: 'Do you build websites?' } });
  });
});

describe('runStructuredTask', () => {
  it('valid first output: one call, parsed by the zod schema', async () => {
    const port = scriptedPort([{ text: GOOD }]);
    const result = await runStructuredTask(input(port));
    expect(result).toMatchObject({ ok: true, repaired: false, value: { reply: 'We build websites for clinics.', escalate: false } });
    expect(result.ok && result.response.modelId).toBe('claude-test-actual');
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toEqual({ system: 'You answer service questions.', user: USER, jsonSchema: REPLY_JSON_SCHEMA, maxTokens: 1_000 });
  });

  it('applies the schema (trim) to the parsed JSON', async () => {
    const port = scriptedPort([{ text: JSON.stringify({ reply: '  Yes, we do.  ', escalate: true }) }]);
    expect(await runStructuredTask(input(port))).toMatchObject({ ok: true, value: { reply: 'Yes, we do.', escalate: true } });
  });

  it('output that is not JSON gets one repair carrying the previous output and the issue', async () => {
    const port = scriptedPort([{ text: 'Sure! We build websites.' }, { text: GOOD }]);
    const result = await runStructuredTask(input(port));
    expect(result).toMatchObject({ ok: true, repaired: true });
    expect(port.calls).toHaveLength(2);
    expect(port.calls[1]).toMatchObject({ maxTokens: 1_000, repair: { previousOutput: 'Sure! We build websites.', issues: NOT_JSON_ISSUES } });
  });

  it('a schema failure gets one repair whose issues name the failing paths', async () => {
    const port = scriptedPort([{ text: JSON.stringify({ reply: '', escalate: 'no' }) }, { text: GOOD }]);
    await runStructuredTask(input(port));
    const issues = port.calls[1]!.repair!.issues;
    expect(issues).toMatch(/^reply: /);
    expect(issues).toMatch(/; escalate: /);
  });

  it('extra keys fail a strict schema and are repaired, not passed through', async () => {
    const port = scriptedPort([{ text: JSON.stringify({ reply: 'Yes.', escalate: false, price: 'Rs 5,000' }) }, { text: GOOD }]);
    const result = await runStructuredTask(input(port));
    expect(result.ok && result.value).toEqual({ reply: 'We build websites for clinics.', escalate: false });
    expect(port.calls).toHaveLength(2);
  });

  it('a truncated output is repaired with max tokens raised by half and no previous output', async () => {
    const port = scriptedPort([{ error: new AiTruncatedOutputError({ message: 'cut off' }) }, { text: GOOD }]);
    const result = await runStructuredTask(input(port, { maxTokens: 1_001 }));
    expect(result.ok).toBe(true);
    expect(port.calls[1]).toMatchObject({ maxTokens: 1_502, repair: { previousOutput: null, issues: EMPTY_OR_CUT_OFF_ISSUES } });
  });

  it('an empty output is repaired at the same max tokens', async () => {
    const port = scriptedPort([{ error: new AiEmptyOutputError({ message: 'empty' }) }, { text: GOOD }]);
    await runStructuredTask(input(port));
    expect(port.calls[1]).toMatchObject({ maxTokens: 1_000, repair: { previousOutput: null, issues: EMPTY_OR_CUT_OFF_ISSUES } });
  });

  it('exactly one repair: a second invalid output fails with AI_MALFORMED_OUTPUT', async () => {
    const port = scriptedPort([{ text: 'nope' }, { text: 'still nope' }, { text: GOOD }]);
    const result = await runStructuredTask(input(port));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AiMalformedOutputError);
    expect(result.error.code).toBe('AI_MALFORMED_OUTPUT');
    expect(result.error.message).toContain('output failed validation after one repair');
    expect(port.calls).toHaveLength(2);
  });

  it('an output error on the repair call is the failure', async () => {
    const port = scriptedPort([{ text: 'nope' }, { error: new AiTruncatedOutputError({ message: 'cut off' }) }]);
    const result = await runStructuredTask(input(port, { finalAttempt: true }));
    expect(!result.ok && result.error.code).toBe('AI_TRUNCATED_OUTPUT');
    expect(port.calls).toHaveLength(2);
  });

  it('a retryable provider failure is rethrown while attempts remain (the job retries)', async () => {
    const port = scriptedPort([{ error: new ProviderUnavailableError({ message: '529' }) }]);
    await expect(runStructuredTask(input(port, { finalAttempt: false }))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(port.calls).toHaveLength(1);
  });

  it('a retryable provider failure on the final attempt is a failed result, not a fallback', async () => {
    const port = scriptedPort([{ error: new ProviderRateLimitedError({ message: '429' }) }]);
    const result = await runStructuredTask(input(port, { finalAttempt: true }));
    expect(!result.ok && result.error).toBeInstanceOf(ProviderRateLimitedError);
    expect(port.calls).toHaveLength(1);
  });

  it('a retryable failure on the repair call is rethrown while attempts remain', async () => {
    const port = scriptedPort([{ text: 'nope' }, { error: new ProviderUnavailableError({ message: '503' }) }]);
    await expect(runStructuredTask(input(port, { finalAttempt: false }))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(port.calls).toHaveLength(2);
  });

  it('auth failures and refusals fail at once, with no repair, even on a first attempt', async () => {
    for (const error of [new ProviderAuthError({ message: '401' }), new AiRefusalError({ message: 'refusal' })]) {
      const port = scriptedPort([{ error }, { text: GOOD }]);
      const result = await runStructuredTask(input(port, { finalAttempt: false }));
      expect(!result.ok && result.error).toBe(error);
      expect(port.calls).toHaveLength(1);
    }
  });

  it('rethrows errors that are not AppErrors (programming errors)', async () => {
    const port = scriptedPort([{ error: new TypeError('boom') }]);
    await expect(runStructuredTask(input(port, { finalAttempt: true }))).rejects.toThrow(TypeError);
  });

  it('refuses a task that does not match the user message, before calling the port', async () => {
    const port = scriptedPort([{ text: GOOD }]);
    await expect(runStructuredTask(input(port, { task: 'template_copy' }))).rejects.toThrow(/template_copy.*conversation_reply/);
    await expect(runStructuredTask(input(port, { user: 'not json' }))).rejects.toThrow(/conversation_reply/);
    expect(port.calls).toHaveLength(0);
  });

  it('accepts a custom evaluator instead of a zod schema (lead drafts keep strip-and-flag)', async () => {
    const port = scriptedPort([{ text: 'first' }, { text: 'second' }]);
    const result = await runStructuredTask({
      port,
      task: 'conversation_reply',
      system: 's',
      user: USER,
      jsonSchema: REPLY_JSON_SCHEMA,
      maxTokens: 100,
      finalAttempt: false,
      evaluate: (raw: string) => (raw === 'second' ? { ok: true as const, value: raw.length } : { ok: false as const, issues: `bad: ${raw}` }),
    });
    expect(result).toMatchObject({ ok: true, value: 6, repaired: true });
    expect(port.calls[1]!.repair).toEqual({ previousOutput: 'first', issues: 'bad: first' });
  });
});
