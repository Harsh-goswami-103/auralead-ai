/**
 * T37: the server render of /docs and every /docs/[slug] page (the views the route modules
 * return), in DEMO and LIVE. The page contract (06-design §11.7, F11/F12, plan T37):
 *  - a skip link to #main is the first focusable element, before the DEMO banner and the nav;
 *  - exactly one h1 (the page title), header / main / footer landmarks;
 *  - the DEMO banner only in DEMO;
 *  - "Applies to" with a DEMO and/or LIVE tag (icon plus text) on every page, and the checked date;
 *  - "On this page" links every section, and every in-page anchor in the markup has its target;
 *  - the sidebar lists every page and marks the current one; previous / next links follow it;
 *  - code blocks and tables scroll inside a focusable, labelled region; no javascript: href;
 *  - an unknown slug is a 404 from the route module.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DOC_PAGES, docNeighbours } from '@content/docs/index';
import { DocsIndexView, DocsPageView } from '@/app/(public)/docs/_components/views';

type Mode = 'demo' | 'live';
const MODES: readonly Mode[] = ['demo', 'live'];

const renderPage = (mode: Mode, slug: string) => renderToStaticMarkup(createElement(DocsPageView, { mode, slug }));
const renderIndex = (mode: Mode) => renderToStaticMarkup(createElement(DocsIndexView, { mode }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const between = (html: string, start: string, end: string) => {
  const i = html.indexOf(start);
  return i === -1 ? '' : html.slice(i, html.indexOf(end, i) + end.length);
};

/** Every in-page fragment link has an element with that id. */
function danglingAnchors(html: string): string[] {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  return [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]!).filter((id) => !ids.has(id));
}

function shellContract(html: string, mode: Mode) {
  const firstFocusable = html.match(/<(a|button|input|select|textarea)\b[^>]*>/)?.[0] ?? '';
  expect(firstFocusable).toContain('href="#main"');
  expect(html).toContain('<main id="main"');
  expect(count(html, /<header[\s>]/g)).toBeGreaterThanOrEqual(1);
  expect(count(html, /<main[\s>]/g)).toBe(1);
  expect(count(html, /<footer[\s>]/g)).toBe(1);
  if (mode === 'demo') {
    expect(html).toContain('data-mode-banner="demo"');
    expect(html.indexOf('href="#main"')).toBeLessThan(html.indexOf('data-mode-banner'));
  } else {
    expect(html).not.toContain('data-mode-banner');
  }
  expect(html).not.toMatch(/href="\s*javascript:/i);
  expect(danglingAnchors(html)).toEqual([]);
  // The sidebar lists the index and every page.
  const sidebar = between(html, 'aria-label="Documentation"', '</nav>');
  expect(sidebar).toContain('href="/docs"');
  for (const p of DOC_PAGES) expect(sidebar).toContain(`href="/docs/${p.slug}"`);
}

describe('docs pages render', () => {
  for (const mode of MODES) {
    describe(`${mode.toUpperCase()}`, () => {
      it.each(DOC_PAGES.map((p) => [p.slug, p] as const))('%s', (slug, page) => {
        const html = renderPage(mode, slug);
        shellContract(html, mode);

        // One h1: the page title.
        expect(count(html, /<h1[\s>]/g)).toBe(1);
        expect(text(between(html, '<h1', '</h1>')).trim()).toBe(page.title);

        // Applies to: one tag per mode with an icon and its text, and the checked date.
        const applies = between(html, 'data-applies-to=', '</p>');
        expect(text(applies)).toContain('Applies to');
        for (const m of page.appliesTo) {
          const tag = between(applies, `data-mode-tag="${m}"`, '</span>');
          expect(tag).toContain('<svg');
          expect(text(tag)).toContain(m);
        }
        for (const m of ['DEMO', 'LIVE'].filter((x) => !page.appliesTo.includes(x as 'DEMO' | 'LIVE'))) expect(applies).not.toContain(`data-mode-tag="${m}"`);
        expect(html).toContain(`dateTime="${page.checked}"`);

        // On this page: one link per section, each to a section with that id.
        const toc = between(html, 'aria-label="On this page"', '</nav>');
        for (const s of page.sections) {
          expect(toc).toContain(`href="#${s.id}"`);
          expect(html).toContain(`id="${s.id}"`);
          expect(text(html)).toContain(s.title);
        }

        // Sidebar marks the current page.
        const sidebar = between(html, 'aria-label="Documentation"', '</nav>');
        expect(sidebar).toMatch(new RegExp(`<a[^>]*aria-current="page"[^>]*href="/docs/${slug}"|<a[^>]*href="/docs/${slug}"[^>]*aria-current="page"`));
        expect(count(sidebar, /aria-current="page"/g)).toBe(1);

        // Previous / next follow the sidebar order.
        const { previous, next } = docNeighbours(slug);
        const pager = between(html, 'aria-label="Previous and next page"', '</nav>');
        if (previous) expect(pager).toContain(`href="/docs/${previous.slug}"`);
        if (next) expect(pager).toContain(`href="/docs/${next.slug}"`);

        // Code blocks and tables scroll inside a focusable, labelled region.
        const blocks = page.sections.flatMap((s) => s.blocks);
        const scrollers = blocks.filter((b) => b.kind === 'code' || b.kind === 'table').length;
        expect(count(html, /role="region"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/gi)).toBeGreaterThanOrEqual(scrollers);
      });
    });
  }
});

describe('docs index renders', () => {
  it.each(MODES)('%s', (mode) => {
    const html = renderIndex(mode);
    shellContract(html, mode);
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(text(between(html, '<h1', '</h1>')).trim()).toBe('Documentation');
    const main = between(html, '<main', '</main>');
    for (const p of DOC_PAGES) {
      expect(main).toContain(`href="/docs/${p.slug}"`);
      expect(text(main)).toContain(p.title);
      expect(text(main)).toContain(p.summary.slice(0, 40));
    }
    // Every card carries its Applies to tags.
    expect(count(main, /data-applies-to=/g)).toBe(DOC_PAGES.length);
    const sidebar = between(html, 'aria-label="Documentation"', '</nav>');
    expect(sidebar).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/docs"|<a[^>]*href="\/docs"[^>]*aria-current="page"/);
  });
});

describe('docs route modules', () => {
  it('answers 404 for an unknown slug', async () => {
    const mod = (await import('@/app/(public)/docs/[slug]/page')) as { default: (p: { params: Promise<{ slug: string }> }) => Promise<unknown> };
    await expect(mod.default({ params: Promise.resolve({ slug: 'no-such-page' }) })).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });

  it('titles every page from its content', async () => {
    const mod = (await import('@/app/(public)/docs/[slug]/page')) as {
      generateMetadata: (p: { params: Promise<{ slug: string }> }) => Promise<{ title?: unknown; description?: unknown }>;
    };
    for (const p of DOC_PAGES) {
      const meta = await mod.generateMetadata({ params: Promise.resolve({ slug: p.slug }) });
      expect(meta.title).toBe(`${p.title} (docs)`);
      expect(meta.description).toBe(p.summary);
    }
  });
});
