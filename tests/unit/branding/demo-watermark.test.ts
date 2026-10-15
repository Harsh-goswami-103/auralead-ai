/**
 * Plan §10 / 06-design (T16): the "DEMO: not a valid offer" watermark appears on quotes only in
 * DEMO, on the render model both presenters read, and in the HTML document (the PDF half is in
 * tests/integration/pdf/pdf-matches-html.test.ts). The content hash ignores the watermark, so
 * the same version hashes the same in both modes.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { QuoteDocument } from '@/components/quote/QuoteDocument';
import { renderStaticMarkup } from '@/components/quote/static-markup';
import { buildQuoteRenderModel, DEMO_WATERMARK, quoteWatermark, type RenderSource } from '@/server/services/quotes/render-model';

const source: RenderSource = {
  quoteNumber: 'Q-0001',
  version: {
    versionNo: 1,
    createdAt: new Date('2026-10-16T06:00:00.000Z'),
    validUntil: new Date('2026-10-31T06:00:00.000Z'),
    scopeText: 'Smile makeover planning.',
    timelineText: 'Four weeks',
    discountKind: 'PERCENT_BPS',
    discountValue: 1000n,
    taxLabel: 'GST',
    taxBps: 1800,
    subtotalPaise: 2_000_000n,
    discountPaise: 200_000n,
    taxablePaise: 1_800_000n,
    taxPaise: 324_000n,
    totalPaise: 2_124_000n,
  },
  items: [{ position: 0, serviceNameSnapshot: 'Smile makeover plan', unitLabel: 'plan', qty: 2, unitPricePaise: 1_000_000n, lineTotalPaise: 2_000_000n }],
  document: { senderName: 'Smile Avenue Dental Clinic', timeZone: 'Asia/Kolkata', brandColor: '#0E7490', termsText: 'Terms apply.', gstin: '06ABCDE1234F1Z5', recipientName: 'Asha Raman' },
};

describe('demo watermark', () => {
  it('is set only in demo', () => {
    expect(DEMO_WATERMARK).toBe('DEMO: not a valid offer');
    expect(quoteWatermark('demo')).toBe(DEMO_WATERMARK);
    expect(quoteWatermark('live')).toBeNull();
    expect(buildQuoteRenderModel(source, { mode: 'demo' }).watermark).toBe(DEMO_WATERMARK);
    expect(buildQuoteRenderModel(source, { mode: 'live' }).watermark).toBeNull();
  });

  it('appears in the HTML document only in demo', () => {
    const demo = renderStaticMarkup(createElement(QuoteDocument, { model: buildQuoteRenderModel(source, { mode: 'demo' }) }));
    const live = renderStaticMarkup(createElement(QuoteDocument, { model: buildQuoteRenderModel(source, { mode: 'live' }) }));
    expect(demo).toContain(DEMO_WATERMARK);
    expect(live).not.toContain('DEMO');
  });

  it('does not change the content hash, which covers the commercial content', () => {
    const demo = buildQuoteRenderModel(source, { mode: 'demo' });
    const live = buildQuoteRenderModel(source, { mode: 'live' });
    expect(demo.contentHash).toBe(live.contentHash);
    expect(demo.shortHash).toBe(demo.contentHash.slice(0, 12));
    const changed = buildQuoteRenderModel({ ...source, version: { ...source.version, totalPaise: 2_124_001n } }, { mode: 'demo' });
    expect(changed.contentHash).not.toBe(demo.contentHash);
  });

  it('carries the AT5 money exactly as persisted, with one tax line and the P8 notice', () => {
    const m = buildQuoteRenderModel(source, { mode: 'live' });
    expect(m.totals).toMatchObject({ subtotal: '₹20,000.00', discount: '₹2,000.00', discountLabel: 'Discount (10%)', taxable: '₹18,000.00', tax: '₹3,240.00', taxLabel: 'GST (18%)', total: '₹21,240.00' });
    expect(m.notice).toBe('Quotation, not a tax invoice');
    expect(m.versionLabel).toBe('v1');
    expect(m.lines).toEqual([{ position: 0, name: 'Smile makeover plan', unitLabel: 'plan', qty: 2, unitPrice: '₹10,000.00', lineTotal: '₹20,000.00' }]);
    expect(m.sender.gstin).toBe('06ABCDE1234F1Z5');
    expect(m.validUntil).toBe('31 Oct 2026');
  });
});
