/**
 * Provider error mapping shared by the Anthropic and OpenAI adapters (02-errors §2.6, R16).
 * Messages are our own fixed text plus the provider's error type; provider message bodies are
 * not copied (they can echo key fragments), and the API key never appears.
 */
import {
  AppError,
  ProviderAuthError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderTimeoutSafeError,
  ProviderUnavailableError,
} from '@/lib/errors';

type SdkErrorClasses = {
  APIError: abstract new (...args: never[]) => Error;
  APIConnectionError: abstract new (...args: never[]) => Error;
  APIConnectionTimeoutError: abstract new (...args: never[]) => Error;
  APIUserAbortError: abstract new (...args: never[]) => Error;
};

const MAX_RETRY_AFTER_SECONDS = 600;

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const v = (headers as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : null;
}

function retryAfterSeconds(headers: unknown): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.ceil(n), MAX_RETRY_AFTER_SECONDS);
}

/** Maps an SDK error to the AppError taxonomy; AppErrors pass through unchanged. */
export function mapProviderError(provider: 'anthropic' | 'openai', error: unknown, sdk: SdkErrorClasses): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof sdk.APIConnectionTimeoutError) {
    return new ProviderTimeoutSafeError({ provider, message: `${provider}: request timed out` });
  }
  if (error instanceof sdk.APIUserAbortError) {
    return new ProviderUnavailableError({ provider, message: `${provider}: request aborted` });
  }
  if (error instanceof sdk.APIConnectionError) {
    return new ProviderUnavailableError({ provider, message: `${provider}: connection failed` });
  }
  if (error instanceof sdk.APIError) {
    const e = error as Error & { status?: number; headers?: unknown; type?: string; code?: string | null; error?: { type?: string; error?: { type?: string } } };
    const status = typeof e.status === 'number' ? e.status : undefined;
    const providerCode = e.error?.error?.type ?? e.error?.type ?? e.code ?? e.type ?? undefined;
    const base = { provider, httpStatus: status, providerCode: providerCode ?? undefined };
    if (status === 401 || status === 403) return new ProviderAuthError({ ...base, message: `${provider}: credentials rejected (${status})` });
    if (status === 404) {
      return new ProviderRejectedError({
        ...base,
        code: 'AI_MODEL_NOT_FOUND',
        message: `${provider}: model or endpoint not found (404)`,
        userMessage: 'The configured AI model was not found. Check the model id in the integration settings.',
      });
    }
    if (status === 429) {
      return new ProviderRateLimitedError({ ...base, message: `${provider}: rate limited (429)`, retryAfterSeconds: retryAfterSeconds(e.headers) });
    }
    if (status !== undefined && (status >= 500 || status === 408 || status === 409)) {
      return new ProviderUnavailableError({ ...base, message: `${provider}: unavailable (${status})`, retryAfterSeconds: retryAfterSeconds(e.headers) });
    }
    return new ProviderRejectedError({ ...base, message: `${provider}: request rejected (${status ?? 'no status'})` });
  }
  return new ProviderUnavailableError({ provider, message: `${provider}: unexpected client failure`, cause: error });
}

export function requestIdFrom(headers: unknown, ...names: string[]): string | null {
  for (const n of names) {
    const v = headerValue(headers, n);
    if (v) return v;
  }
  return null;
}
