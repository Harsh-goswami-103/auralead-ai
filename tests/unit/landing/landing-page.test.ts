/**
 * R30 (T30): the landing page's server render (src/components/landing/LandingPage.tsx), which the
 * route renders with the mode from getConfig(). Checks the page contract from 06-design §11.7 and
 * F11/F12: one h1, the header / nav / main / footer landmarks, mode-aware CTAs to /login, the
 * how-it-works anchor, the hero poster (no canvas on the server), the ROI label, every section the
 * nav links to, and none of the banned patterns (no /docs links, testimonials, "trusted by", logos
 * or empty placeholders).
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

  it('carries none of the banned patterns', () => {
    for (const html of [demo, live]) {
      // The principles section states the rule itself; everything else must not mention these at all.
      const disclaimer = 'this page shows no testimonials, customer logos or invented numbers.';
      expect(text(html).toLowerCase()).toContain(disclaimer);
      const t = text(html).toLowerCase().replace(disclaimer, '');
      expect(html).not.toMatch(/href="\/docs/);
      for (const banned of ['testimonial', 'trusted by', 'coming soon', 'todo', 'lorem']) expect(t).not.toContain(banned);
      expect(html).not.toMatch(/<img[^>]+logo/i);
      expect(html).not.toMatch(/NaN|Infinity/);
    }
  });
});
