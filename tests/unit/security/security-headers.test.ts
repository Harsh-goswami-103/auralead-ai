/**
 * ADR-69 / plan §9 XSS: the document security headers the proxy sets on every HTML response.
 * Pure builders, so the policy is pinned without a browser: a per-request script nonce with
 * `strict-dynamic`, no inline or eval script in production, no framing, no plugins, and HSTS only
 * when the public origin is HTTPS.
 */
import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, buildDocumentHeaders, newNonce } from '@/lib/security-headers';

const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)] as const));

describe('buildContentSecurityPolicy', () => {
  const nonce = 'dGVzdC1ub25jZQ==';
  const prod = directives(buildContentSecurityPolicy({ nonce, dev: false, httpsOrigin: true }));

  it('allows scripts only by nonce with strict-dynamic, and never unsafe-inline or unsafe-eval in production', () => {
    const script = prod.get('script-src')!;
    expect(script).toContain(`'nonce-${nonce}'`);
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it('locks down framing, plugins, base URI, forms and default sources', () => {
    expect(prod.get('default-src')).toEqual(["'self'"]);
    expect(prod.get('frame-ancestors')).toEqual(["'none'"]);
    expect(prod.get('object-src')).toEqual(["'none'"]);
    expect(prod.get('base-uri')).toEqual(["'self'"]);
    expect(prod.get('form-action')).toEqual(["'self'"]);
    expect(prod.get('frame-src')).toEqual(["'none'"]);
  });

  it('keeps connections same-origin in production and upgrades insecure requests on an HTTPS origin', () => {
    expect(prod.get('connect-src')).toEqual(["'self'"]);
    expect(prod.has('upgrade-insecure-requests')).toBe(true);
    const http = directives(buildContentSecurityPolicy({ nonce, dev: false, httpsOrigin: false }));
    expect(http.has('upgrade-insecure-requests')).toBe(false);
  });

  it('needs unsafe-eval and websockets only in development', () => {
    const dev = directives(buildContentSecurityPolicy({ nonce, dev: true, httpsOrigin: false }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.get('connect-src')).toEqual(expect.arrayContaining(["'self'", 'ws:', 'wss:']));
  });

  it('allows images and workers the aura canvas and logos use, from this origin only', () => {
    expect(prod.get('img-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
    expect(prod.get('worker-src')).toEqual(expect.arrayContaining(["'self'", 'blob:']));
    for (const [name, sources] of prod) {
      if (name === 'upgrade-insecure-requests') continue;
      expect(sources.join(' ')).not.toMatch(/https?:\/\/|\*/);
    }
  });
});

describe('newNonce', () => {
  it('is unique per request and base64', () => {
    const a = newNonce();
    expect(a).not.toBe(newNonce());
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(a, 'base64').length).toBeGreaterThanOrEqual(16);
  });
});

describe('buildDocumentHeaders', () => {
  const nonce = 'dGVzdC1ub25jZQ==';

  it('sends the CSP always and HSTS only for an HTTPS public origin', () => {
    const https = buildDocumentHeaders({ appOrigin: 'https://app.example.com', nonce, dev: false });
    expect(https['Content-Security-Policy']).toContain(`'nonce-${nonce}'`);
    expect(https['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains');
    const http = buildDocumentHeaders({ appOrigin: 'http://localhost:3000', nonce, dev: false });
    expect(http['Content-Security-Policy']).toBeDefined();
    expect(http['Strict-Transport-Security']).toBeUndefined();
  });

  it('upgrades insecure requests only behind an HTTPS origin', () => {
    expect(buildDocumentHeaders({ appOrigin: 'https://a.example', nonce, dev: false })['Content-Security-Policy']).toContain('upgrade-insecure-requests');
    expect(buildDocumentHeaders({ appOrigin: 'http://localhost:3000', nonce, dev: false })['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
  });
});
