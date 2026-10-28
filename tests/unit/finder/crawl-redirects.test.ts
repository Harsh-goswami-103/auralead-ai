// Adversarial review: a redirect off the listed host must not slip past robots.txt (ADR-118). The
// crawl checks the robots.txt of the origin a page was actually served from before using its body.
import { describe, expect, it } from 'vitest';
import { crawlSiteEmails, type PageFetcher } from '@/server/services/lead-finder/emails';
import type { SafeFetchResult } from '@/server/security/safe-fetch';

type Page = { body: string; finalUrl?: string; fail?: { httpStatus: number } };

function fetcherFor(pages: Record<string, Page>, requested: string[]): PageFetcher {
  return async (url) => {
    requested.push(url);
    const page = pages[url];
    if (!page) throw Object.assign(new Error('not found'), { safeDetails: { httpStatus: 404 } });
    return { url, finalUrl: page.finalUrl ?? url, status: 200, contentType: 'text/html', body: page.body, bytes: page.body.length, truncated: false, redirects: page.finalUrl ? 1 : 0, downgraded: false, address: '93.184.215.14' } satisfies SafeFetchResult;
  };
}

describe('crawlSiteEmails and redirects', () => {
  it('BLOCKs a home page that redirects to a host whose robots.txt disallows the bot, and keeps nothing from it', async () => {
    const requested: string[] = [];
    const pages: Record<string, Page> = {
      'https://acme.in/robots.txt': { body: 'User-agent: *\nAllow: /\n' },
      'https://acme.in/': { body: '<p>wrong@www.acme.in</p>', finalUrl: 'https://www.acme.in/' },
      'https://www.acme.in/robots.txt': { body: 'User-agent: AuraLeadBot\nDisallow: /\n' },
    };
    const out = await crawlSiteEmails('https://acme.in/', [], fetcherFor(pages, requested));
    expect(out).toMatchObject({ status: 'BLOCKED', emails: [] });
    expect(requested).toContain('https://www.acme.in/robots.txt');
  });

  it('reads a redirect to a host that allows the bot, and a same-origin redirect needs no extra robots.txt', async () => {
    const requested: string[] = [];
    const pages: Record<string, Page> = {
      'https://acme.in/robots.txt': { body: '' },
      'https://acme.in/': { body: '<p>hello@acme.in</p>', finalUrl: 'https://www.acme.in/home' },
      'https://www.acme.in/robots.txt': { body: 'User-agent: *\nDisallow: /private\n' },
    };
    expect(await crawlSiteEmails('https://acme.in/', [], fetcherFor(pages, requested))).toMatchObject({ status: 'FOUND' });
    const same: Record<string, Page> = { 'https://acme.in/robots.txt': { body: '' }, 'https://acme.in/': { body: '<p>hello@acme.in</p>', finalUrl: 'https://acme.in/en/' } };
    const again: string[] = [];
    expect(await crawlSiteEmails('https://acme.in/', [], fetcherFor(same, again))).toMatchObject({ status: 'FOUND' });
    expect(again).toEqual(['https://acme.in/robots.txt', 'https://acme.in/']);
  });

  it('skips a contact page that redirects to a disallowing host', async () => {
    const requested: string[] = [];
    const pages: Record<string, Page> = {
      'https://acme.in/robots.txt': { body: '' },
      'https://acme.in/': { body: '<p>info@acme.in</p><a href="/contact">Contact</a>' },
      'https://acme.in/contact': { body: '<p>stolen@elsewhere.in</p>', finalUrl: 'https://elsewhere.in/contact' },
      'https://elsewhere.in/robots.txt': { body: 'User-agent: *\nDisallow: /\n' },
    };
    const out = await crawlSiteEmails('https://acme.in/', [], fetcherFor(pages, requested));
    expect(out.status).toBe('FOUND');
    expect(out.emails.map((e) => e.address)).toEqual(['info@acme.in']);
  });
});
