/**
 * SSRF-safe fetch for website enrichment (R15, plan §9 SSRF, 03-security T9, 02-errors G-SSRF-1).
 * Worker only; the only way the product reaches a lead's website.
 *
 * Per hop (the first request and each redirect):
 * 1. Parse with WHATWG `URL`, which canonicalizes decimal, octal, hex and short IPv4 forms, so
 *    every check runs on the canonical host. Only http and https, only ports 80 and 443, no
 *    userinfo.
 * 2. Resolve once with `dns.lookup({ all: true })` (an IP literal is not resolved) and require
 *    every address to be public unicast (`ipaddr.js` range `unicast`, IPv4-mapped IPv6 unwrapped).
 *    One private answer blocks the request.
 * 3. Connect to that validated address through an undici `Agent` whose connector replaces the
 *    hostname with the pinned address (SNI and the Host header keep the hostname). There is no
 *    second, unchecked resolution, so DNS rebinding cannot redirect the socket.
 * 4. Redirects are manual (at most 3); the target goes through steps 1 to 3 again. An https to
 *    http downgrade is allowed and reported.
 * 5. Connect timeout 5 s, total deadline 10 s (headers and body), body read as a stream and cut at
 *    1 MB (the head is kept, `truncated` is set), only text/html and text/plain, no cookies or
 *    auth headers, a fixed User-Agent.
 *
 * Errors: EnrichmentBlockedDestinationError (safeDetails.reason SCHEME | PORT | USERINFO |
 * INVALID_URL | PRIVATE_ADDRESS | TOO_MANY_REDIRECTS), EnrichmentTimeoutError, and
 * EnrichmentFetchError with codes ENRICHMENT_DNS_NOT_FOUND, ENRICHMENT_CONNECT_FAILED,
 * ENRICHMENT_HTTP_STATUS, ENRICHMENT_UNSUPPORTED_CONTENT_TYPE. NXDOMAIN and timeouts are fetch
 * failures, never evidence that a website does not exist (G-SSRF-2).
 *
 * `lookup` and `connectTo` are injection seams. Production passes neither; tests use them to point
 * a hostname at a public address and land that pinned address on a local server.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, buildConnector, request } from 'undici';
import { EnrichmentBlockedDestinationError, EnrichmentFetchError, EnrichmentTimeoutError } from '@/lib/errors';

export type ResolvedAddress = { address: string; family: number };
export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;

export type SafeFetchOptions = {
  lookup?: LookupAll;
  /** Test seam: where the socket for a validated (ip, port) actually goes. */
  connectTo?: (target: { ip: string; port: number; hostname: string }) => { host: string; port: number };
  userAgent?: string;
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
};

export type SafeFetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: 'text/html' | 'text/plain';
  body: string;
  bytes: number;
  truncated: boolean;
  redirects: number;
  downgraded: boolean;
  /** The validated address the socket was pinned to. */
  address: string;
};

export const SAFE_FETCH_LIMITS = { maxBytes: 1024 * 1024, connectTimeoutMs: 5_000, totalTimeoutMs: 10_000, maxRedirects: 3 } as const;
export const DEFAULT_USER_AGENT = 'AuraLeadBot/1.0';

const ALLOWED_TYPES = new Set(['text/html', 'text/plain']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DNS_MISS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'EAI_NONAME', 'EAI_FAIL']);
const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

type BlockReason = 'SCHEME' | 'PORT' | 'USERINFO' | 'INVALID_URL' | 'PRIVATE_ADDRESS' | 'TOO_MANY_REDIRECTS';

function block(reason: BlockReason, host: string | null): EnrichmentBlockedDestinationError {
  return new EnrichmentBlockedDestinationError({ message: `blocked destination (${reason})`, safeDetails: host === null ? { reason } : { reason, host } });
}

function fetchError(code: string, message: string, safeDetails: Record<string, unknown> = {}, cause?: unknown): EnrichmentFetchError {
  return new EnrichmentFetchError({ code, message, safeDetails, cause });
}

/** True only for public unicast addresses; IPv4-mapped IPv6 is unwrapped and checked as IPv4. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.process(address).range() === 'unicast';
}

function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Step 1: the URL itself. Returns the parsed URL and its effective port. */
export function validateUrl(raw: string): { url: URL; port: number } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw block('INVALID_URL', null);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw block('SCHEME', null);
  if (url.username !== '' || url.password !== '') throw block('USERINFO', url.hostname);
  // WHATWG drops the default port, so a non-empty port is a non-default one.
  if (url.port !== '') throw block('PORT', url.hostname);
  if (url.hostname === '') throw block('INVALID_URL', null);
  return { url, port: url.protocol === 'https:' ? 443 : 80 };
}

const defaultLookup: LookupAll = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Step 2: resolve once and require every address to be public. Returns the pinned address. */
async function resolvePinned(url: URL, lookup: LookupAll): Promise<string> {
  const host = bareHost(url.hostname);
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw block('PRIVATE_ADDRESS', url.hostname);
    return host;
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && DNS_MISS.has(code)) throw fetchError('ENRICHMENT_DNS_NOT_FOUND', `no DNS answer for ${host}`, { host }, error);
    throw fetchError('ENRICHMENT_DNS_NOT_FOUND', `DNS lookup failed for ${host}`, { host }, error);
  }
  if (addresses.length === 0) throw fetchError('ENRICHMENT_DNS_NOT_FOUND', `no DNS answer for ${host}`, { host });
  if (!addresses.every((a) => isPublicAddress(a.address))) throw block('PRIVATE_ADDRESS', url.hostname);
  return addresses[0]!.address;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Drops a response body we will not read; the abort it raises is expected, not an error. */
function discard(body: NodeJS.ReadableStream & { destroyed: boolean; destroy(): void }): void {
  body.on('error', () => undefined);
  if (!body.destroyed) body.destroy();
}

function isTimeout(error: unknown, deadline: AbortSignal): boolean {
  if (deadline.aborted) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TIMEOUT_CODES.has(code);
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const lookup = options.lookup ?? defaultLookup;
  const maxBytes = options.maxBytes ?? SAFE_FETCH_LIMITS.maxBytes;
  const totalTimeoutMs = options.totalTimeoutMs ?? SAFE_FETCH_LIMITS.totalTimeoutMs;
  const connectTimeoutMs = Math.min(options.connectTimeoutMs ?? SAFE_FETCH_LIMITS.connectTimeoutMs, totalTimeoutMs);
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_LIMITS.maxRedirects;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  const deadline = AbortSignal.timeout(totalTimeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;

  let current = rawUrl;
  let downgraded = false;
  for (let hop = 0; ; hop += 1) {
    const { url, port } = validateUrl(current);
    const pinned = await resolvePinned(url, lookup);
    const hostname = url.hostname;
    const target = options.connectTo ? options.connectTo({ ip: pinned, port, hostname }) : { host: pinned, port };

    const connector = buildConnector({ timeout: connectTimeoutMs });
    const agent = new Agent({
      connections: 1,
      headersTimeout: totalTimeoutMs,
      bodyTimeout: totalTimeoutMs,
      connect(opts, callback) {
        // Step 3: only the origin validated above, only to the pinned address.
        if (opts.hostname !== hostname) {
          callback(block('PRIVATE_ADDRESS', opts.hostname), null);
          return;
        }
        connector(
          { ...opts, hostname: target.host, port: String(target.port), servername: opts.protocol === 'https:' ? bareHost(hostname) : undefined },
          callback,
        );
      },
    });

    try {
      let response: Awaited<ReturnType<typeof request>>;
      try {
        response = await request(url, {
          method: 'GET',
          dispatcher: agent,
          signal,
          headers: { 'user-agent': userAgent, accept: 'text/html, text/plain;q=0.9' },
        });
      } catch (error) {
        if (error instanceof EnrichmentBlockedDestinationError) throw error;
        if (isTimeout(error, deadline)) throw new EnrichmentTimeoutError({ message: `timed out fetching ${hostname}`, safeDetails: { host: hostname }, cause: error });
        throw fetchError('ENRICHMENT_CONNECT_FAILED', `could not connect to ${hostname}`, { host: hostname }, error);
      }

      const { statusCode, headers, body } = response;
      if (REDIRECTS.has(statusCode)) {
        const location = headerValue(headers.location);
        discard(body);
        if (location === undefined) throw fetchError('ENRICHMENT_HTTP_STATUS', `redirect without a location from ${hostname}`, { httpStatus: statusCode });
        if (hop >= maxRedirects) throw block('TOO_MANY_REDIRECTS', hostname);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw block('INVALID_URL', hostname);
        }
        if (url.protocol === 'https:' && next.protocol === 'http:') downgraded = true;
        current = next.href;
        continue;
      }
      if (statusCode < 200 || statusCode > 299) {
        discard(body);
        throw fetchError('ENRICHMENT_HTTP_STATUS', `HTTP ${statusCode} from ${hostname}`, { httpStatus: statusCode, host: hostname });
      }
      const mime = (headerValue(headers['content-type']) ?? '').split(';')[0]!.trim().toLowerCase();
      if (!ALLOWED_TYPES.has(mime)) {
        discard(body);
        throw fetchError('ENRICHMENT_UNSUPPORTED_CONTENT_TYPE', `unsupported content type from ${hostname}`, { contentType: mime || null, host: hostname });
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      try {
        for await (const chunk of body) {
          const buf = chunk as Buffer;
          if (bytes + buf.length >= maxBytes) {
            chunks.push(buf.subarray(0, maxBytes - bytes));
            truncated = bytes + buf.length > maxBytes;
            bytes = maxBytes;
            break;
          }
          chunks.push(buf);
          bytes += buf.length;
        }
      } catch (error) {
        if (isTimeout(error, deadline)) throw new EnrichmentTimeoutError({ message: `timed out reading ${hostname}`, safeDetails: { host: hostname }, cause: error });
        throw fetchError('ENRICHMENT_CONNECT_FAILED', `connection to ${hostname} failed while reading`, { host: hostname }, error);
      } finally {
        discard(body);
      }

      return {
        url: rawUrl,
        finalUrl: url.href,
        status: statusCode,
        contentType: mime as 'text/html' | 'text/plain',
        body: new TextDecoder('utf-8').decode(Buffer.concat(chunks)),
        bytes,
        truncated,
        redirects: hop,
        downgraded,
        address: pinned,
      };
    } finally {
      await agent.destroy().catch(() => undefined);
    }
  }
}
