// @vitest-environment jsdom
/**
 * R30 (T30): the landing nav's scroll-spy (src/components/landing/LandingNavLinks.tsx). The links
 * always point at the four in-page sections; nothing is marked current on the first render (so
 * server and client agree) or without IntersectionObserver (jsdom, old browsers); once the
 * observer reports, exactly the first section in page order that crosses the band is marked with
 * aria-current, and leaving every section clears the mark.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingNavLinks } from '@/components/landing/LandingNavLinks';
import { LANDING_SECTIONS } from '@/components/landing/sections';

type Callback = (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void;

class FakeObserver {
  static last: FakeObserver | null = null;
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: Callback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.last = this;
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  disconnect() {
    this.disconnected = true;
  }
  report(changes: Record<string, boolean>) {
    act(() => this.callback(Object.entries(changes).map(([id, isIntersecting]) => ({ target: document.getElementById(id)!, isIntersecting }))));
  }
}

const ids = LANDING_SECTIONS.map((s) => s.href.slice(1));

function mountSections() {
  for (const id of ids) {
    const section = document.createElement('section');
    section.id = id;
    document.body.append(section);
  }
}

const current = () => screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'true');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  FakeObserver.last = null;
  vi.unstubAllGlobals();
});

describe('landing nav scroll-spy', () => {
  it('links every section and marks none on the server render', () => {
    const html = renderToStaticMarkup(createElement(LandingNavLinks));
    for (const s of LANDING_SECTIONS) expect(html).toContain(`href="${s.href}"`);
    expect(html).not.toContain('aria-current');
  });

  it('marks nothing when IntersectionObserver is missing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    mountSections();
    render(createElement(LandingNavLinks));
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(LANDING_SECTIONS.map((s) => s.label));
    expect(current()).toHaveLength(0);
  });

  it('marks the section crossing the band, in page order, and clears on leaving', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    mountSections();
    const { unmount } = render(createElement(LandingNavLinks));
    const observer = FakeObserver.last!;
    expect(observer.observed.map((e) => e.id)).toEqual(ids);
    expect(observer.options?.rootMargin).toBe('-40% 0px -55% 0px');
    expect(current()).toHaveLength(0);

    observer.report({ features: true });
    expect(current().map((l) => l.textContent)).toEqual(['Features']);

    // Two sections in the band at a boundary: the earlier one in page order wins.
    observer.report({ roi: true });
    expect(current().map((l) => l.textContent)).toEqual(['Features']);
    observer.report({ features: false });
    expect(current().map((l) => l.textContent)).toEqual(['ROI estimate']);

    observer.report({ roi: false });
    expect(current()).toHaveLength(0);

    unmount();
    expect(observer.disconnected).toBe(true);
  });
});
