/**
 * OpenAI adapter (R16; fixture-tested, not live-verified, plan §13). Chat Completions with a
 * strict `json_schema` response_format, no tools, SDK retries off (the job runtime owns retries).
 * The model id must come from the workspace's AI_OPENAI Integration config: there is no built-in
 * default, so an integration without one is treated as not configured.
 */
import OpenAI from 'openai';
import { AiEmptyOutputError, AiRefusalError, AiTruncatedOutputError } from '@/lib/errors';
import { mapProviderError, requestIdFrom } from './errors';
import { DEFAULT_AI_TIMEOUT_MS, repairInstruction, type AiPort, type AiRequest, type AiResponse, type AiTransport } from './port';

export type OpenAiAdapterOptions = AiTransport & {
  apiKey: string;
  modelId: string;
  baseURL?: string;
};

export function createOpenAiAdapter(opts: OpenAiAdapterOptions): AiPort {
  const modelId = opts.modelId.trim();
  if (modelId === '') throw new RangeError('OpenAI adapter needs a model id from the integration config');
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    fetch: opts.fetch,
    maxRetries: 0,
    timeout: opts.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
  });

  return {
    label: 'openai',
    modelId,
    async generate(req: AiRequest): Promise<AiResponse> {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ];
      if (req.repair) {
        if (req.repair.previousOutput) messages.push({ role: 'assistant', content: req.repair.previousOutput });
        messages.push({ role: 'user', content: repairInstruction(req.repair.issues) });
      }
      let completion: OpenAI.Chat.ChatCompletion;
      let headers: Headers;
      try {
        const res = await client.chat.completions
          .create(
            {
              model: modelId,
              messages,
              max_completion_tokens: req.maxTokens,
              response_format: { type: 'json_schema', json_schema: { name: 'lead_draft', strict: true, schema: req.jsonSchema } },
            },
            { signal: req.signal },
          )
          .withResponse();
        completion = res.data;
        headers = res.response.headers;
      } catch (error) {
        throw mapProviderError('openai', error, OpenAI);
      }

      const choice = completion.choices[0];
      if (!choice) throw new AiEmptyOutputError({ message: 'openai: no choices in the response' });
      if (choice.message.refusal) throw new AiRefusalError({ message: 'openai: refusal' });
      if (choice.finish_reason === 'content_filter') throw new AiRefusalError({ message: 'openai: content filter' });
      if (choice.finish_reason === 'length') throw new AiTruncatedOutputError({ message: 'openai: output truncated (length)' });
      const text = (choice.message.content ?? '').trim();
      if (text === '') throw new AiEmptyOutputError({ message: 'openai: empty content' });
      return {
        text,
        modelId: completion.model,
        providerRequestId: requestIdFrom(headers, 'x-request-id'),
        usage: completion.usage ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens } : null,
      };
    },
  };
}
