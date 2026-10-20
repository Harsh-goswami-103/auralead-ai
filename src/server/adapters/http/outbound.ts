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
 * Where a thrown request error happened (E7, ADR-41), for adapters that must tell "definitely not
 * sent" from "may have reached the provider". Before the request was written: name resolution,
 * refused or unreachable connections, connect timeouts, TLS handshake failures, invalid URLs and
 * the DEMO block. Everything else (headers or body timeout, a reset or a closed socket, an abort,
 * anything unknown) counts as after the write, so a send is never retried blindly.
 */
const BEFORE_WRITE_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_INVALID_ARG',
  'ERR_INVALID_URL',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

function errorCodeOf(error: unknown): string | null {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : null;
}

export function outboundFailurePhase(error: unknown): 'before-write' | 'after-write' {
  if (error instanceof OutboundBlockedInDemoError) return 'before-write';
  const code = errorCodeOf(error);
  return code !== null && BEFORE_WRITE_CODES.has(code) ? 'before-write' : 'after-write';
}

/** A short, value-free description of a thrown request error (its code or class name). */
export function outboundFailureLabel(error: unknown): string {
  const code = errorCodeOf(error);
  if (code) return code;
  return error instanceof Error ? error.name : 'unknown error';
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
