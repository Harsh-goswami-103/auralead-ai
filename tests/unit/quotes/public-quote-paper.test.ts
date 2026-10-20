/**
 * The public quote paper (T16 + design spec §6 "Public quote"): the workspace brand colour becomes
 * a palette whose text pairs meet WCAG AA for any #rrggbb, and the page keeps working without
 * JavaScript and in print:
 *  - the band ink reads at 4.5:1 on both gradient stops, and the brand used as text, rules and the
 *    focus outline reads at 4.6:1 on white and on the brand wash;
 *  - the controls that need the page script (Print, the name field and Accept button, the phone
 *    accept bar) render `hidden`, and `[hidden]` wins over the button display rule;
 *  - numeric column headers align right like their cells;
 *  - the brand rule is a hashed `:root` block with no closing tag, and the CSP lists its hash.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { brandPalette, contrast, NEUTRAL_BRAND, PAPER_INK, senderInitials } from '@/components/quote/brand-palette';
import { PublicQuotePage, viewCsp, type PublicQuoteView } from '@/components/quote/PublicQuotePage';
import { quoteBrandCss } from '@/components/quote/QuoteDocument';
import { QUOTE_DOCUMENT_CSS } from '@/components/quote/quote-css';
import { renderStaticDocument } from '@/components/quote/static-markup';
import { buildQuoteRenderModel, type RenderSource } from '@/server/services/quotes/render-model';

const source = (brandColor: string): RenderSource => ({
  quoteNumber: 'Q-0001',
  version: {
    versionNo: 2,
    createdAt: new Date('2026-10-16T06:00:00.000Z'),
    validUntil: new Date('2026-10-31T06:00:00.000Z'),
    scopeText: 'Smile makeover planning.',
    timelineText: 'Four weeks',
    discountKind: 'NONE',
    discountValue: 0n,
    taxLabel: 'GST',
    taxBps: 1800,
    subtotalPaise: 2_000_000n,
    discountPaise: 0n,
    taxablePaise: 2_000_000n,
    taxPaise: 360_000n,
    totalPaise: 2_360_000n,
  },
  items: [{ position: 0, serviceNameSnapshot: 'Smile makeover plan', unitLabel: 'plan', qty: 2, unitPricePaise: 1_000_000n, lineTotalPaise: 2_000_000n }],
  document: { senderName: 'Smile Avenue Dental Clinic', timeZone: 'Asia/Kolkata', brandColor, termsText: null, gstin: null, recipientName: 'Asha Raman' },
});

const BRANDS = ['#0E7490', '#B45309', '#4D7C0F', '#C2410C', '#7C3AED', '#111318', '#FACC15', '#FF0000', '#22C55E', '#00E1F3', '#FFFFFF', '#000000', '#808080', '#FF47C3'];

describe('brand palette', () => {
  it.each(BRANDS)('keeps every text pair at AA for %s', (hex) => {
    const p = brandPalette(hex);
    expect(contrast(p.ink, p.band)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.ink, p.band2)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.text, '#FFFFFF')).toBeGreaterThanOrEqual(4.6);
    expect(contrast(p.text, p.wash)).toBeGreaterThanOrEqual(4.6);
    expect([p.brand, p.band, p.band2, p.ink, p.text, p.wash, p.soft, p.haze].every((c) => /^#[0-9A-F]{6}$/.test(c))).toBe(true);
  });

  it('uses white ink on dark brands and the paper ink on light ones', () => {
    expect(brandPalette('#0E7490').ink).toBe('#FFFFFF');
    expect(brandPalette('#FACC15').ink).toBe(PAPER_INK);
    expect(brandPalette('not a colour').brand).toBe(NEUTRAL_BRAND);
  });

  it('derives a two-letter monogram', () => {
    expect(senderInitials('Smile Avenue Dental Clinic')).toBe('SA');
    expect(senderInitials('(NestKey) Realty')).toBe('NR');
    expect(senderInitials('Kesari')).toBe('K');
  });
});

describe('public quote page', () => {
  const view = (brand: string, accept: boolean): PublicQuoteView => ({
    kind: 'quote',
    model: buildQuoteRenderModel(source(brand), { mode: 'live' }),
    token: 'tok',
    state: accept ? 'SENT' : 'APPROVED',
    accept: accept ? { formNonce: 'nonce', expectedVersionId: 'ver' } : null,
    acceptance: null,
  });

  it('hides the script-only controls until the page script runs', () => {
    const html = renderStaticDocument(createElement(PublicQuotePage, { view: view('#0E7490', true) }));
    expect(html).toMatch(/<button type="button" class="qp-button secondary" data-action="print" hidden>/);
    expect(html).toMatch(/<div data-accept-fields="true" hidden><div class="qp-field"><label for="qp-name">Your full name<\/label>/);
    expect(html).toMatch(/<div class="qp-mbar" data-accept-bar="true" hidden>/);
    expect(html).toContain('name="formNonce" value="nonce"');
    expect(html).toContain('<noscript>');
    expect(QUOTE_DOCUMENT_CSS).toContain('[hidden]{display:none!important}');
  });

  it('aligns numeric headers right and draws the focus outline in the contrast-checked brand text colour', () => {
    expect(QUOTE_DOCUMENT_CSS).toContain('.qd-table th.qd-num');
    expect(QUOTE_DOCUMENT_CSS).toMatch(/--focus:var\(--brand-text\)/);
    expect(QUOTE_DOCUMENT_CSS).toMatch(/button:focus-visible,input:focus-visible\{outline:3px solid var\(--focus\)/);
    expect(QUOTE_DOCUMENT_CSS).not.toContain('</');
  });

  it('keeps the status heading name "Status: <state>": the colon stays in inline flow, only transparent', () => {
    const html = renderStaticDocument(createElement(PublicQuotePage, { view: view('#0E7490', true) }));
    expect(html).toContain('<h2 id="qp-actions-title"><span class="qp-ribbon-k">Status<span class="qp-colon">:</span></span> <span class="qp-state" data-field="state">Awaiting your response</span></h2>');
    expect(QUOTE_DOCUMENT_CSS).toContain('.qp-colon{opacity:0}');
  });

  it('centres only the expired, not-found and error cards, and the 404 body stays identical', () => {
    const notFound = () => renderStaticDocument(createElement(PublicQuotePage, { view: { kind: 'not-found' } }));
    expect(notFound()).toBe(notFound());
    expect(notFound()).toContain('<main class="qp qp-center">');
    expect(renderStaticDocument(createElement(PublicQuotePage, { view: { kind: 'gone', reason: 'EXPIRED', senderName: 'NestKey' } }))).toContain('<main class="qp qp-center">');
    expect(renderStaticDocument(createElement(PublicQuotePage, { view: { kind: 'error', status: 429 } }))).toContain('<main class="qp qp-center">');
    expect(renderStaticDocument(createElement(PublicQuotePage, { view: view('#0E7490', true) }))).toContain('<main class="qp">');
  });

  it('runs every entrance only under prefers-reduced-motion: no-preference, and nothing loops but the submit spinner', () => {
    const open = '@media (prefers-reduced-motion:no-preference){';
    const start = QUOTE_DOCUMENT_CSS.indexOf(open);
    expect(start).toBeGreaterThan(-1);
    let depth = 1;
    let end = start + open.length;
    for (; depth > 0; end++) depth += QUOTE_DOCUMENT_CSS[end] === '{' ? 1 : QUOTE_DOCUMENT_CSS[end] === '}' ? -1 : 0;
    const motion = QUOTE_DOCUMENT_CSS.slice(start, end);
    const rest = QUOTE_DOCUMENT_CSS.slice(0, start) + QUOTE_DOCUMENT_CSS.slice(end);
    expect(rest.match(/animation:(?!none)/g)).toBeNull();
    expect(rest).not.toMatch(/transition:(?!none)/);
    expect(motion.match(/infinite/g)).toHaveLength(1);
    expect(motion).toMatch(/animation:qp-spin [^;}]*infinite/);
  });

  it('prints the total rule as a border, since print drops backgrounds', () => {
    const print = QUOTE_DOCUMENT_CSS.slice(QUOTE_DOCUMENT_CSS.indexOf('@media print{'));
    expect(print).toContain('.qd-total{border-top-color:var(--brand-text)}');
    expect(print).toMatch(/\.qd-total::before[^{]*\{display:none!important\}/);
  });

  it('ships the brand palette as one hashed :root rule', () => {
    const v = view('#7C3AED', false);
    if (v.kind !== 'quote') throw new Error('unreachable');
    const css = quoteBrandCss(v.model);
    expect(css).toMatch(/^:root\{--brand:#7C3AED;--brand-band:#7C3AED;.*\}$/);
    expect(css).not.toContain('</');
    const html = renderStaticDocument(createElement(PublicQuotePage, { view: v }));
    expect(html).toContain(`<style>${css}</style>`);
    expect(viewCsp(v).split(';')[1]!.trim().split(' ')).toHaveLength(3);
    expect(html).not.toContain('style="');
  });
});
