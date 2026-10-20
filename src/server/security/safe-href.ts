/**
 * `safeHref` (plan §9 XSS, T11 contract; built with T37 for the docs renderer, ADR-92): the one gate
 * for an href that comes from data rather than code. It returns the href to render, or null when
 * the value must not become a link.
 *
 * Allowed: absolute `http:`, `https:`, `mailto:` and `tel:` URLs; same-origin paths (`/docs`, never
 * the protocol-relative `//host` or `/\host`); in-page fragments (`#section`). Everything else is
 * refused: `javascript:`, `data:`, `vbscript:`, `file:` and any other scheme in any letter case,
 * relative paths, empty values, and any value with whitespace or control characters inside (browsers
 * strip tabs and newlines from URLs, which is how `java\tscript:` slips past naive checks).
 * Framework-free and pure, so server components and client islands can both use it.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (href === '') return null;
  if (/[\u0000- \u007f-\u009f]/.test(href)) return null;

  if (href.startsWith('#')) return href.length > 1 ? href : null;
  if (href.startsWith('/')) return href.startsWith('//') || href.startsWith('/\\') ? null : href;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === '') return null;
  return href;
}
