/**
 * Contract-test transport for the AI adapters (T14): an undici MockAgent with real network
 * connections disabled, exposed as a `fetch` the provider SDKs accept. Every request the SDK makes
 * is matched against an interceptor or fails; nothing leaves the process. Response bodies are the
 * JSON fixtures under ./fixtures, shaped after the providers' documented responses (not captured
 * from a live account; see docs/integrations.md once T37 writes it).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fetch as undiciFetch, MockAgent } from 'undici';

export type CapturedRequest = { path: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };

export function fixture(provider: 'anthropic' | 'openai', name: string): Record<string, unknown> {
  const file = path.join(import.meta.dirname, 'fixtures', provider, `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function headersOf(h: unknown): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries([...h.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  if (Array.isArray(h)) {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
    return out;
  }
  return Object.fromEntries(Object.entries(h as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

export function createMockTransport(origin: string) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(origin);
  const captured: CapturedRequest[] = [];

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...(init as object), dispatcher: agent } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;

  /** Replies once to POST `apiPath` with `status` and `body`, recording the request. */
  function reply(apiPath: string, status: number, body: unknown, headers: Record<string, string> = {}, delayMs = 0) {
    const scope = pool
      .intercept({ path: apiPath, method: 'POST' })
      .reply(
        status,
        (opts) => {
          captured.push({
            path: opts.path,
            method: opts.method,
            headers: headersOf(opts.headers),
            body: JSON.parse(typeof opts.body === 'string' ? opts.body : Buffer.from(opts.body as Uint8Array).toString('utf8')) as Record<string, unknown>,
          });
          return body as object;
        },
        { headers: { 'content-type': 'application/json', ...headers } },
      );
    if (delayMs > 0) scope.delay(delayMs);
  }

  return {
    fetch: fetchImpl,
    reply,
    captured,
    /** Interceptors that were defined but never used. */
    pending: () => agent.pendingInterceptors(),
    close: () => agent.close(),
  };
}

/** Awaits a promise that must reject and returns the error. */
export async function rejection(p: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    return e as Error & Record<string, unknown>;
  }
  throw new Error('expected the call to fail');
}
