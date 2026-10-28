// Adversarial review of ADR-118: "the home page and at most two same-host contact pages". The
// integration fixture site has exactly two allowed contact pages, so it passes with or without the
// cap; this pins the cap itself, and that a page robots.txt disallows does not use up the budget.
import { describe, expect, it } from 'vitest';
import type { SafeFetchResult } from '@/server/security/safe-fetch';
import { crawlSiteEmails, MAX_CONTACT_PAGES, type PageFetcher } from '@/server/services/lead-finder/emails';

function site(pages: Record<string, string>, requested: string[]): PageFetcher {
  return async (url) => {
    requested.push(new URL(url).pathname);
    const body = pages[new URL(url).pathname];
    if (body === undefined) throw Object.assign(new Error('missing'), { safeDetails: { httpStatus: 404 } });
    return { url, finalUrl: url, status: 200, contentType: 'text/html', body, bytes: body.length, truncated: false, redirects: 0, downgraded: false, address: '93.184.215.14' } satisfies SafeFetchResult;
  };
}

describe('crawlSiteEmails page budget', () => {
  it('reads the home page and at most MAX_CONTACT_PAGES contact pages, however many the home page links', async () => {
    expect(MAX_CONTACT_PAGES).toBe(2);
    const requested: string[] = [];
    const pages = {
      '/robots.txt': '',
      '/': ['/contact', '/about', '/support', '/enquiry', '/connect'].map((p) => `<a href="${p}">${p}</a>`).join(' '),
      '/contact': 'one@shop.example',
      '/about': 'two@shop.example',
      '/support': 'three@shop.example',
      '/enquiry': 'four@shop.example',
      '/connect': 'five@shop.example',
    };
    const out = await crawlSiteEmails('https://shop.example/', [], site(pages, requested));
    expect(requested).toEqual(['/robots.txt', '/', '/contact', '/about']);
    expect(out.pagesRead).toBe(3);
    expect(out.emails.map((e) => e.address)).toEqual(['one@shop.example', 'two@shop.example']);
  });

  it('a contact page robots.txt disallows does not use up the budget', async () => {
    const requested: string[] = [];
    const pages = {
      '/robots.txt': 'User-agent: *\nDisallow: /private\n',
      '/': ['/private/contact', '/contact', '/about', '/support'].map((p) => `<a href="${p}">${p}</a>`).join(' '),
      '/private/contact': 'secret@shop.example',
      '/contact': 'one@shop.example',
      '/about': 'two@shop.example',
      '/support': 'three@shop.example',
    };
    await crawlSiteEmails('https://shop.example/', [], site(pages, requested));
    expect(requested).toEqual(['/robots.txt', '/', '/contact', '/about']);
  });
});
