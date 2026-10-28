// Adversarial review: the production page fetcher run for real against a local server (resolver and
// connect target faked, every SSRF check still real): the bot User-Agent reaches the website, and a
// page over 1 MB is cut at 1 MB instead of being read whole.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finderPageFetcher } from '@/server/jobs/handlers/lead-finder-emails';
import type { LookupAll } from '@/server/security/safe-fetch';

let server: http.Server;
let port: number;
const seen: Array<{ path: string; ua: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', ua: String(req.headers['user-agent'] ?? '') });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/big') res.end(`<p>start</p>${'x'.repeat(3 * 1024 * 1024)}`);
    else res.end('<p>info@shop.example</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const lookup: LookupAll = async () => [{ address: '93.184.215.14', family: 4 }];
const fetcher = () => finderPageFetcher('https://app.example', { lookup, connectTo: () => ({ host: '127.0.0.1', port }) });

describe('finderPageFetcher against a real server', () => {
  it('sends the identifying User-Agent built from the app origin', async () => {
    const res = await fetcher()('http://shop.example/contact');
    expect(res.body).toContain('info@shop.example');
    expect(seen.at(-1)).toEqual({ path: '/contact', ua: 'AuraLeadBot/1.0 (+https://app.example/docs/bot)' });
  });

  it('cuts a page at 1 MB', async () => {
    const res = await fetcher()('http://shop.example/big');
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(res.body.startsWith('<p>start</p>')).toBe(true);
  });
});
