/**
 * AT6 / R19 / P8 (T16, C1, ADR-08): the quote PDF is a real react-pdf document rendered by the
 * `quote.renderPdf` worker job when a version is created, stored as a QuoteArtifact, and its
 * text (extracted with pdfjs) carries exactly the values the public HTML page shows: the total
 * (₹21,240.00 for the AT5 fixture), the quote number, the version and the short content hash.
 * Inter is embedded (it has U+20B9). One tax line, "Quotation, not a tax invoice", the DEMO
 * watermark only in demo, and a 60-line quote paginates with the total on its last page only.
 * The share and authenticated PDF routes serve the stored file, or 503 + Retry-After and enqueue
 * a render when it is missing.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authedPdfRoute from '@/app/api/quotes/[id]/pdf/route';
import { renderQuotePdf } from '@/server/pdf/render';
import { QUOTE_RENDER_PDF_JOB } from '@/server/pdf/artifacts';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { buildQuoteRenderModel, type RenderSource } from '@/server/services/quotes/render-model';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest } from '../auth/support';
import { createPublicHarness, drain, getQuotePage, getSharePdf, issueQuote, pdfWorker, type PublicHarness } from '../quotes/public-support';

let h: PublicHarness;

beforeAll(async () => {
  h = await createPublicHarness('pdf-parity');
});
afterAll(async () => {
  await h?.destroy();
});

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    pages.push(content.items.map((i) => ('str' in i ? i.str : '')).join(' '));
  }
  await task.destroy();
  return pages;
}

function domField(html: string, field: string): string {
  const el = new JSDOM(html).window.document.querySelector(`[data-field="${field}"]`);
  if (!el?.textContent) throw new Error(`the page has no ${field}`);
  return el.textContent.trim();
}

describe('quote PDF parity with the HTML page (AT6)', () => {
  it('the render job stores a real PDF whose text equals the HTML totals, number, version and hash', async () => {
    const q = await issueQuote(h, { sent: true });
    const job = await h.db.job.findFirstOrThrow({ where: { type: QUOTE_RENDER_PDF_JOB, idempotencyKey: { contains: q.versionId } } });
    expect(job.status).toBe('QUEUED');
    await drain(pdfWorker(h));
    expect((await h.db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');

    const artifact = await h.db.quoteArtifact.findUniqueOrThrow({ where: { quoteVersionId: q.versionId } });
    const file = path.join(h.storageDir, artifact.path);
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(artifact.bytes).toBe(bytes.length);
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await h.db.auditEvent.count({ where: { targetId: q.quoteId, action: 'quote.pdf.render' } })).toBe(1);

    const html = await (await getQuotePage(q.token)).text();
    const total = domField(html, 'total');
    const number = domField(html, 'quote-number');
    const version = domField(html, 'version');
    const shortHash = domField(html, 'short-hash');
    expect(total).toBe('₹21,240.00');
    expect(number).toBe(q.number);
    expect(version).toBe('v1');
    expect(shortHash).toMatch(/^[0-9a-f]{12}$/);

    const pages = await pdfPages(bytes);
    const text = pages.join('\n');
    expect(text).toContain('21,240.00');
    expect(text).toContain(total);
    expect(text).toContain(number);
    expect(text).toContain(version);
    expect(text).toContain(shortHash);
    // P8: one configured tax line and the notice.
    expect(text).toContain('Quotation, not a tax invoice');
    expect(text.match(/GST \(18%\)/g)).toHaveLength(1);
    expect(domField(html, 'tax-label')).toBe('GST (18%)');
    // DEMO process: the watermark is on the document.
    expect(text).toContain('DEMO: not a valid offer');

    // Inter is embedded as a TrueType subset.
    const raw = bytes.toString('latin1');
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+Inter-Regular/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+Inter-SemiBold/);
    expect(raw).toContain('/FontFile2');

    // The share route serves exactly the stored file.
    const served = await getSharePdf(q.token);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/pdf');
    expect(served.headers.get('content-disposition')).toContain(`${q.number}-v1.pdf`);
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('re-running the render job is a no-op and rendering is deterministic', async () => {
    const q = await issueQuote(h, { sent: true });
    await drain(pdfWorker(h));
    const artifact = await h.db.quoteArtifact.findUniqueOrThrow({ where: { quoteVersionId: q.versionId } });
    const { loadQuoteRenderModel } = await import('@/server/services/quotes/render-model');
    const model = await loadQuoteRenderModel(h.db, { workspaceId: artifact.workspaceId, quoteVersionId: q.versionId }, 'demo');
    const again = await renderQuotePdf(model);
    expect(createHash('sha256').update(again).digest('hex')).toBe(artifact.sha256);
  });

  it('a missing artifact answers 503 + Retry-After and enqueues one render', async () => {
    const q = await issueQuote(h, { sent: true });
    await h.db.job.deleteMany({ where: { type: QUOTE_RENDER_PDF_JOB, idempotencyKey: { contains: q.versionId } } });
    const first = await getSharePdf(q.token);
    expect(first.status).toBe(503);
    expect(Number(first.headers.get('retry-after'))).toBeGreaterThan(0);
    const second = await getSharePdf(q.token);
    expect(second.status).toBe(503);
    expect(await h.db.job.count({ where: { type: QUOTE_RENDER_PDF_JOB, idempotencyKey: { contains: q.versionId } } })).toBe(1);
    await drain(pdfWorker(h));
    const ready = await getSharePdf(q.token);
    expect(ready.status).toBe(200);
  });

  it('the authenticated download serves the workspace quote and 404s another tenant', async () => {
    const q = await issueQuote(h, { sent: false });
    await drain(pdfWorker(h));
    const owner = seedId('user', 'owner');
    const { token } = await createSession(h.db, { userId: owner, globalRole: 'USER', mode: 'DEMO', activeWorkspaceId: null, ipHash: 'pdf', userAgent: 'vitest', now: h.clock.now() });
    const cookie = `${sessionCookieName(h.runtime.config)}=${token}`;
    const own = await authedPdfRoute.GET(makeRequest(`/api/quotes/${q.quoteId}/pdf`, { cookie }), { params: Promise.resolve({ id: q.quoteId }) });
    expect(own.status).toBe(200);
    expect(Buffer.from(await own.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const foreignId = seedId('quote', 'ironpulse-fitness:Q-0001');
    const foreign = await authedPdfRoute.GET(makeRequest(`/api/quotes/${foreignId}/pdf`, { cookie }), { params: Promise.resolve({ id: foreignId }) });
    expect(foreign.status).toBe(404);
    const anonymous = await authedPdfRoute.GET(makeRequest(`/api/quotes/${q.quoteId}/pdf`), { params: Promise.resolve({ id: q.quoteId }) });
    expect(anonymous.status).toBe(401);
  });
});

describe('PDF layout', () => {
  const source = (lines: number): RenderSource => ({
    quoteNumber: 'Q-0042',
    version: {
      versionNo: 3,
      createdAt: new Date('2026-10-16T06:00:00.000Z'),
      validUntil: new Date('2026-10-31T06:00:00.000Z'),
      scopeText: 'Annual maintenance across all branches.',
      timelineText: 'Twelve months',
      discountKind: 'NONE',
      discountValue: 0n,
      taxLabel: 'GST',
      taxBps: 1800,
      subtotalPaise: BigInt(lines) * 150_000n,
      discountPaise: 0n,
      taxablePaise: BigInt(lines) * 150_000n,
      taxPaise: BigInt(lines) * 27_000n,
      totalPaise: BigInt(lines) * 177_000n,
    },
    items: Array.from({ length: lines }, (_, i) => ({
      position: i,
      serviceNameSnapshot: `Branch service visit ${i + 1}`,
      unitLabel: 'visit',
      qty: 1,
      unitPricePaise: 150_000n,
      lineTotalPaise: 150_000n,
    })),
    document: { senderName: 'Smile Avenue Dental Clinic', timeZone: 'Asia/Kolkata', brandColor: '#0E7490', termsText: 'Terms apply.', gstin: null, recipientName: 'Asha Raman' },
  });

  it('a 60-line quote paginates with the footer on every page and the total on the last page only', async () => {
    const model = buildQuoteRenderModel(source(60), { mode: 'demo' });
    const pages = await pdfPages(await renderQuotePdf(model));
    expect(pages.length).toBeGreaterThan(1);
    const total = model.totals.total;
    expect(total).toBe('₹1,06,200.00');
    expect(pages.at(-1)).toContain(total);
    for (const p of pages.slice(0, -1)) expect(p).not.toContain(total);
    pages.forEach((p, i) => {
      expect(p).toContain(`Q-0042`);
      expect(p).toContain(model.shortHash);
      expect(p).toContain(`Page ${i + 1} of ${pages.length}`);
    });
    expect(pages.join(' ')).toContain('Branch service visit 60');
  });

  it('the watermark is printed only in demo', async () => {
    const live = (await pdfPages(await renderQuotePdf(buildQuoteRenderModel(source(2), { mode: 'live' })))).join(' ');
    const demo = (await pdfPages(await renderQuotePdf(buildQuoteRenderModel(source(2), { mode: 'demo' })))).join(' ');
    expect(live).not.toContain('DEMO');
    expect(demo).toContain('DEMO: not a valid offer');
  });
});
