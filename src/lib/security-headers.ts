/**
 * Document security headers (ADR-69, plan §9 XSS). Pure builders, used by `src/proxy.ts` for every
 * HTML response of the app.
 *
 * Scripts run only with the per-request nonce (Next applies it to its own scripts when the request
 * carries this CSP) plus `strict-dynamic`; production has no `unsafe-inline` or `unsafe-eval`
 * script. Styles allow inline because React and the motion library write `style` attributes, which a
 * nonce cannot cover; style injection cannot run script. Nothing may frame the app, load a plugin
 * or change the base URI, and every connection and subresource stays on this origin (fonts are
 * self-hosted by next/font, the logo and PDFs are served by this app). The public quote page sets
 * its own hash-based policy and is excluded from the proxy.
 */
import { randomBytes } from 'node:crypto';

export type CspOptions = { nonce: string; dev: boolean; httpsOrigin: boolean };

/** A fresh, unguessable nonce for one response. */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

export function buildContentSecurityPolicy({ nonce, dev, httpsOrigin }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "worker-src 'self' blob:",
    "media-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (httpsOrigin) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export type DocumentHeaderOptions = { appOrigin: string; nonce: string; dev: boolean };

/** Response headers for an HTML document. HSTS is sent only when the public origin is HTTPS. */
export function buildDocumentHeaders({ appOrigin, nonce, dev }: DocumentHeaderOptions): Record<string, string> {
  const httpsOrigin = appOrigin.startsWith('https://');
  const headers: Record<string, string> = { 'Content-Security-Policy': buildContentSecurityPolicy({ nonce, dev, httpsOrigin }) };
  if (httpsOrigin) headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  return headers;
}
