// R15, T9, G-SSRF-1 (T12): `safeFetch` is the only way enrichment reaches a lead's website.
// Every check runs on the WHATWG-canonical host, every resolved address must be public unicast,
// the socket goes to the validated (pinned) address, and every redirect hop is re-validated.
//
// A real local server (`http.createServer` on port 0) serves the responses. The tests point
// `site.test` at a public address through a stub resolver and use the `connectTo` seam to land
// that pinned public address on the local server, so the production checks run unchanged on
// real values; only the final socket destination is remapped.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnrichmentBlockedDestinationError, EnrichmentFetchError, EnrichmentTimeoutError } from '@/lib/errors';
import { isPublicAddress, safeFetch, type LookupAll, type SafeFetchOptions } from '@/server/security/safe-fetch';

const PUBLIC_IP = '93.184.215.14';
const MB = 1024 * 1024;

type Seen = { url: string; host: string | undefined; ua: string | undefined; cookie: string | undefined };
const seen: Seen[] = [];
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', host: req.headers.host, ua: req.headers['user-agent'], cookie: req.headers.cookie });
    switch (req.url) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><title>Hi</title><body>Smile Avenue ₹</body></html>');
        return;
      case '/text':
        res.writeHead(200, { 'content-type': 'text/plain' }).end('plain text');
        return;
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"a":1}');
        return;
      case '/missing':
        res.writeHead(404, { 'content-type': 'text/html' }).end('nope');
        return;
      case '/redirect-ok':
        res.writeHead(302, { location: '/ok' }).end();
        return;
      case '/redirect-metadata':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        return;
      case '/redirect-decimal':
        res.writeHead(301, { location: 'http://2130706433/admin' }).end();
        return;
      case '/loop':
        res.writeHead(307, { location: '/loop' }).end();
        return;
      case '/big': {
        res.writeHead(200, { 'content-type': 'text/html' });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 2 * MB) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        pump();
        return;
      }
      case '/slow':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<p>first byte');
        // Never finishes: the total deadline must cut it off.
        return;
      default:
        res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

type Harness = { opts: SafeFetchOptions; lookups: string[]; connects: Array<{ ip: string; port: number; hostname: string }> };

function harness(table: Record<string, string[] | (() => string[])> = { 'site.test': [PUBLIC_IP] }, extra: Partial<SafeFetchOptions> = {}): Harness {
  const lookups: string[] = [];
  const connects: Harness['connects'] = [];
  const lookup: LookupAll = async (hostname) => {
    lookups.push(hostname);
    const entry = table[hostname];
    if (entry === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    const addresses = typeof entry === 'function' ? entry() : entry;
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return {
    lookups,
    connects,
    opts: {
      lookup,
      connectTo: (target) => {
        connects.push(target);
        return { host: '127.0.0.1', port };
      },
      ...extra,
    },
  };
}

async function blocked(promise: Promise<unknown>, reason?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EnrichmentBlockedDestinationError);
  if (reason) expect((error as EnrichmentBlockedDestinationError).safeDetails).toMatchObject({ reason });
  return error as EnrichmentBlockedDestinationError;
}

describe('safeFetch: destination checks before any connection', () => {
  it.each([
    ['decimal IPv4', 'http://2130706433/'],
    ['hex IPv4', 'http://0x7f.1/'],
    ['octal IPv4', 'http://017700000001/'],
    ['short IPv4', 'http://127.1/'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['CGNAT', 'http://100.64.0.1/'],
    ['private 10/8', 'http://10.0.0.1/'],
    ['AWS IPv6 metadata', 'http://[fd00:ec2::254]/'],
    ['NAT64 to private', 'http://[64:ff9b::a00:1]/'],
  ])('blocks %s literals (%s) without DNS or a socket', async (_label, url) => {
    const h = harness();
    await blocked(safeFetch(url, h.opts), 'PRIVATE_ADDRESS');
    expect(h.lookups).toEqual([]);
    expect(h.connects).toEqual([]);
    expect(seen).toEqual([]);
  });

  it.each([['file:///etc/passwd'], ['gopher://site.test/'], ['data:text/html,<p>hi</p>'], ['ftp://site.test/'], ['javascript:alert(1)']])(
    'rejects the %s scheme',
    async (url) => {
      const h = harness();
      await blocked(safeFetch(url, h.opts), 'SCHEME');
      expect(h.lookups).toEqual([]);
    },
  );

  it('rejects userinfo, non-default ports and unparseable URLs', async () => {
    const h = harness();
    await blocked(safeFetch('http://user:pass@site.test/ok', h.opts), 'USERINFO');
    await blocked(safeFetch('http://site.test:8080/ok', h.opts), 'PORT');
    await blocked(safeFetch('https://site.test:80/ok', h.opts), 'PORT');
    await blocked(safeFetch('not a url', h.opts), 'INVALID_URL');
    expect(h.connects).toEqual([]);
  });

  it('blocks a hostname that resolves to 10.0.0.1, or to any private address among public ones', async () => {
    const h = harness({ 'intranet.test': ['10.0.0.1'], 'mixed.test': [PUBLIC_IP, '192.168.1.5'], 'localhost.': ['127.0.0.1'] });
    await blocked(safeFetch('http://intranet.test/', h.opts), 'PRIVATE_ADDRESS');
    await blocked(safeFetch('http://mixed.test/', h.opts), 'PRIVATE_ADDRESS');
    await blocked(safeFetch('http://localhost./', h.opts), 'PRIVATE_ADDRESS');
    expect(h.connects).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('classifies addresses with mapped IPv4 unwrapped', () => {
    expect(isPublicAddress(PUBLIC_IP)).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
    for (const a of ['127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', 'fe80::1', 'fc00::1', '224.0.0.1', '255.255.255.255', '2002:a00:1::1', 'nonsense']) {
      expect(isPublicAddress(a)).toBe(false);
    }
  });
});

describe('safeFetch: fetching through the pinned address', () => {
  it('fetches html from the validated address with the hostname as Host, a fixed UA and no cookies', async () => {
    const h = harness();
    const result = await safeFetch('http://site.test/ok', { ...h.opts, userAgent: 'AuraLeadBot/1.0 (+http://app.test/docs/bot)' });
    expect(result).toMatchObject({ status: 200, finalUrl: 'http://site.test/ok', address: PUBLIC_IP, redirects: 0, truncated: false, downgraded: false });
    expect(result.contentType).toBe('text/html');
    expect(result.body).toContain('Smile Avenue ₹');
    expect(h.connects).toEqual([{ ip: PUBLIC_IP, port: 80, hostname: 'site.test' }]);
    expect(seen).toEqual([{ url: '/ok', host: 'site.test', ua: 'AuraLeadBot/1.0 (+http://app.test/docs/bot)', cookie: undefined }]);

    const text = await safeFetch('http://site.test/text', h.opts);
    expect(text.contentType).toBe('text/plain');
  });

  it('rejects non-text content types and error statuses', async () => {
    const h = harness();
    const json = await safeFetch('http://site.test/json', h.opts).catch((e: unknown) => e);
    expect(json).toBeInstanceOf(EnrichmentFetchError);
    expect(json).toMatchObject({ code: 'ENRICHMENT_UNSUPPORTED_CONTENT_TYPE' });
    const missing = await safeFetch('http://site.test/missing', h.opts).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'ENRICHMENT_HTTP_STATUS', safeDetails: { httpStatus: 404 } });
  });

  it('reports NXDOMAIN as a fetch failure, not as a missing website', async () => {
    const h = harness({});
    const error = await safeFetch('http://no-such-business.test/', h.opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnrichmentFetchError);
    expect(error).toMatchObject({ code: 'ENRICHMENT_DNS_NOT_FOUND' });
  });

  it('follows a redirect inside public space and re-validates each hop', async () => {
    const h = harness();
    const result = await safeFetch('http://site.test/redirect-ok', h.opts);
    expect(result).toMatchObject({ status: 200, finalUrl: 'http://site.test/ok', redirects: 1 });
    expect(h.lookups).toEqual(['site.test', 'site.test']);
  });

  it('blocks a redirect to 169.254.169.254 or to a decimal loopback literal', async () => {
    const h = harness();
    await blocked(safeFetch('http://site.test/redirect-metadata', h.opts), 'PRIVATE_ADDRESS');
    await blocked(safeFetch('http://site.test/redirect-decimal', h.opts), 'PRIVATE_ADDRESS');
    expect(seen.map((s) => s.url)).toEqual(['/redirect-metadata', '/redirect-decimal']);
    expect(h.connects.every((c) => c.ip === PUBLIC_IP)).toBe(true);
  });

  it('stops after 3 redirects', async () => {
    const h = harness();
    await blocked(safeFetch('http://site.test/loop', h.opts), 'TOO_MANY_REDIRECTS');
    expect(seen.length).toBe(4);
  });

  it('defeats DNS rebinding: one resolution per hop, the socket goes to the address that was checked', async () => {
    let calls = 0;
    const rebinding = () => (++calls === 1 ? [PUBLIC_IP] : ['127.0.0.1']);
    const h = harness({ 'site.test': rebinding });
    const result = await safeFetch('http://site.test/ok', h.opts);
    expect(result.address).toBe(PUBLIC_IP);
    expect(h.lookups).toEqual(['site.test']);
    expect(h.connects).toEqual([{ ip: PUBLIC_IP, port: 80, hostname: 'site.test' }]);

    // The next hop resolves again and now gets the private answer: blocked before connecting.
    calls = 0;
    const h2 = harness({ 'site.test': rebinding });
    await blocked(safeFetch('http://site.test/redirect-ok', h2.opts), 'PRIVATE_ADDRESS');
    expect(h2.connects).toHaveLength(1);
  });

  it('stops reading at 1 MB and keeps the head', async () => {
    const h = harness();
    const result = await safeFetch('http://site.test/big', h.opts);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(MB);
    expect(result.body.length).toBe(MB);
  });

  it('times out a body that trickles past the total deadline', async () => {
    const h = harness({ 'site.test': [PUBLIC_IP] }, { totalTimeoutMs: 300 });
    const started = performance.now();
    const error = await safeFetch('http://site.test/slow', h.opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnrichmentTimeoutError);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
