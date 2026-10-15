/**
 * Anthropic adapter (R16; fixture-tested, not live-verified, plan §13). Messages API with
 * structured output (`output_config.format` json_schema), no tools, no thinking configuration
 * (current Opus models think adaptively by default), SDK retries off (the job runtime owns
 * retries and backoff). The model id comes from the workspace's AI_ANTHROPIC Integration config;
 * without one the current Opus model is used.
 *
 * A `refusal` stop reason escalates to review (AiRefusalError) rather than switching models: the
 * draft then waits for a person, which is the plan's rule for refusals (02-errors §2.6).
 */
import Anthropic from '@anthropic-ai/sdk';
import { AiEmptyOutputError, AiRefusalError, AiTruncatedOutputError } from '@/lib/errors';
import { mapProviderError, requestIdFrom } from './errors';
import { DEFAULT_AI_TIMEOUT_MS, repairInstruction, type AiPort, type AiRequest, type AiResponse, type AiTransport } from './port';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

export type AnthropicAdapterOptions = AiTransport & {
  apiKey: string;
  modelId: string | null;
  baseURL?: string;
};

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): AiPort {
  const modelId = opts.modelId && opts.modelId.trim() !== '' ? opts.modelId.trim() : ANTHROPIC_DEFAULT_MODEL;
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    fetch: opts.fetch,
    maxRetries: 0,
    timeout: opts.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
  });

  return {
    label: 'anthropic',
    modelId,
    async generate(req: AiRequest): Promise<AiResponse> {
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.user }];
      if (req.repair) {
        if (req.repair.previousOutput) messages.push({ role: 'assistant', content: req.repair.previousOutput });
        messages.push({ role: 'user', content: repairInstruction(req.repair.issues) });
      }
      let message: Anthropic.Message;
      let headers: Headers;
      try {
        const res = await client.messages
          .create(
            {
              model: modelId,
              max_tokens: req.maxTokens,
              system: req.system,
              messages,
              output_config: { format: { type: 'json_schema', schema: req.jsonSchema } },
            },
            { signal: req.signal },
          )
          .withResponse();
        message = res.data;
        headers = res.response.headers;
      } catch (error) {
        throw mapProviderError('anthropic', error, Anthropic);
      }

      if (message.stop_reason === 'refusal') {
        throw new AiRefusalError({ message: `anthropic: refusal (${message.stop_details?.category ?? 'uncategorized'})` });
      }
      if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
        throw new AiTruncatedOutputError({ message: `anthropic: output truncated (${message.stop_reason})` });
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (text === '') throw new AiEmptyOutputError({ message: 'anthropic: no text in the response' });
      return {
        text,
        modelId: message.model,
        providerRequestId: requestIdFrom(headers, 'request-id', 'x-request-id'),
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    },
  };
}
