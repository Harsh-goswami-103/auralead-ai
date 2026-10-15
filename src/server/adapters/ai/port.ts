/**
 * AiPort (R16, plan §3 adapters/ai): one interface for the Anthropic adapter, the OpenAI adapter
 * and the labelled local deterministic generator. A port turns a fixed system prompt plus a JSON
 * user message into raw JSON text; it never parses or trusts that text (the AI service validates
 * it) and never sees a credential other than its own API key. Models get no tools.
 *
 * Adapters map every failure to the AppError taxonomy (02-errors §2.6):
 *   ProviderAuthError (401/403), ProviderRejectedError (400, 404 model AI_MODEL_NOT_FOUND),
 *   ProviderRateLimitedError (429, Retry-After), ProviderUnavailableError (5xx, 529, connection),
 *   ProviderTimeoutSafeError (timeout: generation has no side effect, so it is safe to retry),
 *   AiRefusalError, AiTruncatedOutputError, AiEmptyOutputError.
 */
export type GeneratorLabel = 'anthropic' | 'openai' | 'local-deterministic';

export type AiRequest = {
  system: string;
  /** The JSON user message: `{ task, data }` with every untrusted value inside `data`. */
  user: string;
  /** Structured-output JSON schema (strict objects). */
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  /** One repair attempt: the previous raw output (if any) and the validation issues. */
  repair?: { previousOutput: string | null; issues: string };
  signal?: AbortSignal;
};

export type AiResponse = {
  /** Raw output text, expected to be JSON. */
  text: string;
  /** The model that actually answered (as reported by the provider). */
  modelId: string;
  providerRequestId: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

export interface AiPort {
  readonly label: GeneratorLabel;
  /** The configured model id (workspace Integration config, or the adapter default). */
  readonly modelId: string;
  generate(request: AiRequest): Promise<AiResponse>;
}

/** Transport overrides for the HTTP adapters (contract tests inject an undici MockAgent fetch). */
export type AiTransport = { fetch?: typeof fetch; timeoutMs?: number };

export const DEFAULT_AI_TIMEOUT_MS = 60_000;

/** Text the adapters append for a repair attempt. */
export function repairInstruction(issues: string): string {
  return `Your previous output did not match the required JSON schema or rules: ${issues}\nReturn only the corrected JSON object.`;
}
