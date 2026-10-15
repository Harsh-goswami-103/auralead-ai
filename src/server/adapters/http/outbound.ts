/**
 * The only door for provider HTTP calls (plan §3 adapters/http, §4.2, R1). Live adapters (WhatsApp
 * Cloud API, Resend, Graph, Sheets) send through `outboundRequest`; it records every attempt and,
 * in DEMO, throws `OutboundBlockedInDemoError` for every host before any socket is opened. DEMO
 * therefore makes zero outbound calls even if a live adapter is wired by mistake.
 *
 * `outboundAttempts()` exposes the attempt log (host and time only) so tests and the admin
 * inspector can show that a simulated flow logged none.
 */
import { request } from 'undici';
import { OutboundBlockedInDemoError } from '@/lib/errors';

export type OutboundMode = 'demo' | 'live';

export type OutboundRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  signal?: AbortSignal;
};

export type OutboundResponse = { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string };

export type OutboundAttempt = { host: string; mode: OutboundMode; blocked: boolean; at: Date };

const attempts: OutboundAttempt[] = [];
const MAX_LOG = 1_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

export function outboundAttempts(): readonly OutboundAttempt[] {
  return attempts;
}

export function resetOutboundAttempts(): void {
  attempts.length = 0;
}

/**
 * `at` is supplied by the caller's clock (no wall-clock reads in src/server). Throws
 * `OutboundBlockedInDemoError` in DEMO for every URL, including localhost.
 */
export async function outboundRequest(mode: OutboundMode, url: string, init: OutboundRequest, at: Date): Promise<OutboundResponse> {
  const host = hostOf(url);
  const blocked = mode === 'demo';
  attempts.push({ host, mode, blocked, at });
  if (attempts.length > MAX_LOG) attempts.shift();
  if (blocked) {
    throw new OutboundBlockedInDemoError({ message: `outbound request to ${host} blocked in DEMO`, safeDetails: { host } });
  }
  const res = await request(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    headersTimeout: init.headersTimeoutMs ?? 10_000,
    bodyTimeout: init.bodyTimeoutMs ?? 10_000,
    signal: init.signal,
  });
  return { statusCode: res.statusCode, headers: res.headers, body: await res.body.text() };
}
