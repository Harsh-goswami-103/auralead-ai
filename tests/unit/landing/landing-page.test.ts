/**
 * R30 (T30): the landing page's server render (src/components/landing/LandingPage.tsx), which the
 * route renders with the mode from getConfig(). Checks the page contract from 06-design §11.7 and
 * F11/F12: one h1, the header / nav / main / footer landmarks, mode-aware CTAs to /login, the
 * how-it-works anchor, the hero poster (no canvas on the server), the ROI label, every section the
 * nav links to, the documentation link in the nav and the footer (T37: /docs exists now), and none
 * of the banned patterns (testimonials, "trusted by", logos or empty placeholders).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingPage } from '@/components/landing/LandingPage';

const render = (mode: 'demo' | 'live') => renderToStaticMarkup(createElement(LandingPage, { mode }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe('landing page', () => {
  const demo = render('demo');
  const live = render('live');

  it('has one h1 with the headline and the landmarks', () => {
    for (const html of [demo, live]) {
      expect(count(html, /<h1[\s>]/g)).toBe(1);
      expect(text(html.slice(html.indexOf('<h1'), html.indexOf('</h1>')))).toContain('Leads in. Quotes out.');
      expect(count(html, /<header[\s>]/g)).toBeGreaterThanOrEqual(1);
      expect(count(html, /<main[\s>]/g)).toBe(1);
      expect(count(html, /<footer[\s>]/g)).toBe(1);
      expect(html).toContain('aria-label="Main"');
    }
  });

  it('labels the primary CTA by mode and always points it at /login', () => {
    const ctas = (html: string) => [...html.matchAll(/<a[^>]*data-landing-cta="primary"[^>]*>(.*?)<\/a>/g)];
    expect(ctas(demo).length).toBeGreaterThanOrEqual(2);
    for (const [tag, inner] of ctas(demo).map((m) => [m[0], m[1]!] as const)) {
      expect(tag).toContain('href="/login"');
      expect(text(inner).trim()).toBe('Open live demo');
    }
    for (const [tag, inner] of ctas(live).map((m) => [m[0], m[1]!] as const)) {
      expect(tag).toContain('href="/login"');
      expect(text(inner).trim()).toBe('Sign in');
    }
    expect(text(live)).not.toContain('Open live demo');
  });

  it('starts with a skip link to main, before the banner and the nav', () => {
    for (const html of [demo, live]) {
      const firstFocusable = html.match(/<(a|button|input)\b[^>]*>/)?.[0] ?? '';
      expect(firstFocusable).toContain('href="#main"');
      expect(text(html.slice(html.indexOf(firstFocusable), html.indexOf('</a>')))).toContain('Skip to content');
      expect(html.indexOf(firstFocusable)).toBeLessThan(html.indexOf('data-landing-nav'));
      expect(html).toContain('<main id="main"');
    }
    expect(demo.indexOf('href="#main"')).toBeLessThan(demo.indexOf('data-mode-banner'));
  });

  it('shows the DEMO banner only in DEMO', () => {
    expect(demo).toContain('data-mode-banner="demo"');
    expect(live).not.toContain('data-mode-banner');
  });

  it('links the secondary CTA and the nav to sections that exist', () => {
    expect(demo).toContain('href="#how-it-works"');
    for (const id of ['how-it-works', 'features', 'roi', 'principles']) {
      expect(demo).toContain(`href="#${id}"`);
      expect(demo).toContain(`id="${id}"`);
    }
  });

  it('links the documentation from the nav and the footer', () => {
    for (const html of [demo, live]) {
      const nav = html.slice(html.indexOf('data-landing-nav'), html.indexOf('</header>', html.indexOf('data-landing-nav')));
      const footer = html.slice(html.indexOf('data-landing-footer'), html.indexOf('</footer>'));
      expect(nav).toMatch(/<a[^>]*href="\/docs"[^>]*>(?:(?!<\/a>).)*Docs(?:(?!<\/a>).)*<\/a>/);
      expect(footer).toMatch(/<a[^>]*href="\/docs"[^>]*>(?:(?!<\/a>).)*Documentation(?:(?!<\/a>).)*<\/a>/);
    }
  });

  it('server-renders the hero poster and no canvas', () => {
    expect(demo).toContain('data-aura="hero"');
    expect(demo).toContain('data-visual-state="poster"');
    expect(demo).toContain('data-aura-poster="hero"');
    expect(demo).not.toContain('<canvas');
  });

  it('labels the ROI output as an illustrative estimate with every assumption editable', () => {
    expect(text(demo)).toContain('Illustrative estimate. Edit the assumptions.');
    expect(count(demo, /<input[^>]*inputMode="decimal"/g)).toBe(6);
    expect(text(demo)).toContain('Reset assumptions');
  });

  it('names what each pipeline stage really does', () => {
    const t = text(demo);
    expect(t).toContain('Prices are resolved from your versioned price list, never by AI.');
    expect(t).toContain('contact key');
    expect(t).toContain('24-hour WhatsApp window');
    expect(t).toContain('Nothing goes out until a person approves it.');
  });

  it('captions the diagram nodes with real behavior and frames the Stop exchange as an example', () => {
    const t = text(demo);
    expect(t).toContain('E.164 phones, deduped by contact key');
    expect(t).toContain('Every point comes with its reason');
    expect(t).toContain('Priced from your price list, never by AI');
    expect(t).toMatch(/After approval,\s*consent and suppression checks/);
    expect(t).toContain('Example WhatsApp reply');
    expect(t).toContain('Suppressed at once; queued outreach is cancelled.');
  });

  it('presents the lead-gen flow in order: Find, Chat, Hand over, Quote (ADR-126)', () => {
    for (const html of [demo, live]) {
      const start = html.indexOf('data-landing-flow');
      expect(start).toBeGreaterThan(0);
      const list = html.slice(start, html.indexOf('</ol>', start));
      const titles = [...list.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((m) => text(m[1]!).trim());
      expect(titles).toEqual(['Find', 'Chat', 'Hand over', 'Quote']);
      const t = text(list);
      expect(t).toContain('Google Places');
      expect(t).toContain('24-hour window');
      expect(t).toContain('price list');
      // The flow sits in the how-it-works section, before the pipeline stages.
      expect(start).toBeGreaterThan(html.indexOf('id="how-it-works"'));
      expect(start).toBeLessThan(html.indexOf('data-stage="capture"'));
    }
  });

  it('names a Google Places search and Excel import as capture sources', () => {
    for (const html of [demo, live]) {
      const start = html.indexOf('data-stage="capture"');
      const capture = text(html.slice(start, html.indexOf('data-stage="normalize"')));
      expect(capture).toContain('Google Places search');
      expect(capture).toMatch(/Excel or CSV import/);
      expect(text(html)).toContain('Excel and CSV import');
    }
  });

  it('never calls lead data "scraped"', () => {
    for (const html of [demo, live]) expect(text(html)).not.toMatch(/scrap/i);
  });

  it('says nothing about demos, simulators or the mode in LIVE (ADR-116)', () => {
    const t = text(live);
    expect(t).not.toMatch(/\bdemo|simulat|fictitious|seeded|LIVE mode|DEMO and LIVE/i);
    expect(live).not.toContain('data-mode-chip');
    // The DEMO build keeps its honest notes.
    expect(text(demo)).toMatch(/simulat/i);
  });

  it('carries none of the banned patterns', () => {
    for (const html of [demo, live]) {
      // The principles section states the rule itself; everything else must not mention these at all.
      const disclaimer = 'this page shows no testimonials, customer logos or invented numbers.';
      expect(text(html).toLowerCase()).toContain(disclaimer);
      const t = text(html).toLowerCase().replace(disclaimer, '');
      for (const banned of ['testimonial', 'trusted by', 'coming soon', 'todo', 'lorem']) expect(t).not.toContain(banned);
      expect(html).not.toMatch(/<img[^>]+logo/i);
      expect(html).not.toMatch(/NaN|Infinity/);
    }
  });
});
