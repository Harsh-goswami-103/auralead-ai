/**
 * Live connection checks for the AI providers (T32; R16, plan §13). One minimal authenticated read
 * of the provider's Models API, through the same SDKs, timeouts and error mapping the generators
 * use (no retries: a check answers once). Nothing is generated and no prompt is sent.
 *
 *  - Anthropic: `GET /v1/models?limit=1` proves the key, then `GET /v1/models/{id}` proves the
 *    configured model id (or the adapter default) exists for it.
 *  - OpenAI: `GET /v1/models` proves the key; the configured model id must be in the list.
 *
 * The answer is either `{ ok: true, modelId }` or the AppError the request ended with
 * (ProviderAuthError, ProviderRejectedError AI_MODEL_NOT_FOUND, ProviderRateLimitedError,
 * ProviderUnavailableError, ProviderTimeoutSafeError). Never a success without a real answer.
 * Endpoints per the providers' API references; the shapes are fixture-tested, not live-verified.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AppError, ProviderRejectedError } from '@/lib/errors';
import { ANTHROPIC_DEFAULT_MODEL } from './anthropic';
import { mapProviderError } from './errors';
import type { AiTransport } from './port';

const CHECK_TIMEOUT_MS = 15_000;

export type AiCheckResult = { ok: true; modelId: string } | { ok: false; error: AppError };

export type AiCheckInput = AiTransport & { apiKey: string; modelId: string | null; baseURL?: string };

function modelNotFound(provider: 'anthropic' | 'openai', modelId: string): AppError {
  return new ProviderRejectedError({
    provider,
    httpStatus: 404,
    code: 'AI_MODEL_NOT_FOUND',
    message: `${provider}: the configured model is not available to this key`,
    userMessage: `The model ${modelId} is not available to this API key. Check the model ID.`,
  });
}

export async function checkAnthropicConnection(input: AiCheckInput): Promise<AiCheckResult> {
  const modelId = input.modelId && input.modelId.trim() !== '' ? input.modelId.trim() : ANTHROPIC_DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: input.apiKey, baseURL: input.baseURL, fetch: input.fetch, maxRetries: 0, timeout: input.timeoutMs ?? CHECK_TIMEOUT_MS });
  try {
    await client.models.list({ limit: 1 });
  } catch (error) {
    return { ok: false, error: mapProviderError('anthropic', error, Anthropic) };
  }
  try {
    const model = await client.models.retrieve(modelId);
    return { ok: true, modelId: model.id };
  } catch (error) {
    const mapped = mapProviderError('anthropic', error, Anthropic);
    return { ok: false, error: mapped.code === 'AI_MODEL_NOT_FOUND' ? modelNotFound('anthropic', modelId) : mapped };
  }
}

export async function checkOpenAiConnection(input: AiCheckInput): Promise<AiCheckResult> {
  const modelId = (input.modelId ?? '').trim();
  const client = new OpenAI({ apiKey: input.apiKey, baseURL: input.baseURL, fetch: input.fetch, maxRetries: 0, timeout: input.timeoutMs ?? CHECK_TIMEOUT_MS });
  let ids: string[];
  try {
    const page = await client.models.list();
    ids = page.data.map((m) => m.id);
  } catch (error) {
    return { ok: false, error: mapProviderError('openai', error, OpenAI) };
  }
  if (modelId === '' || !ids.includes(modelId)) return { ok: false, error: modelNotFound('openai', modelId || '(none)') };
  return { ok: true, modelId };
}
