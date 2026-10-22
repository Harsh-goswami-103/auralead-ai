/**
 * Visual library and shared header patterns (design spec §3-§4). Every decoration is aria-hidden,
 * renders in jsdom without IntersectionObserver / ResizeObserver, is deterministic, and has a
 * static path when the viewer asks for reduced motion (matchMedia mocked per test). PageHeader's
 * h1 text equals its title exactly, because tests across the app find pages by heading name.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadSource } from '@/lib/domain/enums';
import { SIMULATION_SOURCES } from '@/lib/schemas/webhooks';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { SourceChip } from '@/components/patterns/SourceChip';
import { SOURCE_STYLES, sourceStyle } from '@/components/patterns/source-style';
import { StatTile } from '@/components/patterns/StatTile';
import { AnimatedBeam } from '@/components/visual/AnimatedBeam';
import { AuroraBackdrop, type AuroraVariant } from '@/components/visual/AuroraBackdrop';
import { BorderBeam } from '@/components/visual/BorderBeam';
import { ChromaBorder } from '@/components/visual/ChromaBorder';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { Marquee } from '@/components/visual/Marquee';
import { Meteors } from '@/components/visual/Meteors';
import { OrbitRing } from '@/components/visual/OrbitRing';
import { PageTransition } from '@/components/visual/PageTransition';
import { DotPattern, GridPattern } from '@/components/visual/Patterns';
import { mulberry32 } from '@/components/visual/prng';
import { Reveal, Stagger, StaggerItem } from '@/components/visual/Reveal';
import { ShimmerText } from '@/components/visual/ShimmerText';
import { Sparkles } from '@/components/visual/Sparkles';
import { SpotlightCard } from '@/components/visual/SpotlightCard';
import { TiltCard } from '@/components/visual/TiltCard';

const navigation = vi.hoisted(() => ({ pathname: '/dashboard/user' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const visualCss = readFileSync(path.join(repoRoot, 'src/styles/visual.css'), 'utf8');

/** jsdom has no matchMedia: install one that answers the reduced-motion query. */
function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => setReducedMotion(false));
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
  navigation.pathname = '/dashboard/user';
});

describe('AuroraBackdrop', () => {
  it.each<[AuroraVariant, number, boolean]>([
    ['header', 2, true],
    ['hero', 5, true],
    ['auth', 5, true],
    ['empty', 2, false],
    ['card', 1, false],
  ])('%s renders %i aria-hidden blobs; looping=%s', (variant, blobs, loops) => {
    const { container } = render(<AuroraBackdrop variant={variant} />);
    const root = container.querySelector(`[data-aurora="${variant}"]`) as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelectorAll('.visual-aurora__blob')).toHaveLength(blobs);
    // Looping variants carry the reduced-motion hook and pause offscreen; the quiet ones never loop.
    expect(root.hasAttribute('data-visual-motion')).toBe(loops);
    expect(root.classList.contains('ambient')).toBe(loops);
    expect(root.querySelector('[data-pause-probe]') !== null).toBe(loops);
    if (!loops) expect(root.querySelectorAll('.visual-aurora__blob--static')).toHaveLength(blobs);
  });

  it('pauses its drift while the tab is hidden', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { container } = render(<AuroraBackdrop variant="header" />);
    const root = container.querySelector('[data-aurora]') as HTMLElement;
    expect(root.getAttribute('data-paused')).toBe('true');
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(root.hasAttribute('data-paused')).toBe(false);
  });

  it('can drop the grain layer', () => {
    const { container } = render(<AuroraBackdrop variant="card" grain={false} />);
    expect(container.querySelector('[data-aurora]')?.getAttribute('data-grain')).toBe('off');
  });
});

describe('GridPattern and DotPattern', () => {
  it('are static aria-hidden CSS textures with a fade mask', () => {
    const { container } = render(
      <>
        <GridPattern size={32} fade="bottom" />
        <DotPattern gap={20} />
      </>,
    );
    const grid = container.querySelector('[data-pattern="grid"]') as HTMLElement;
    const dots = container.querySelector('[data-pattern="dots"]') as HTMLElement;
    for (const el of [grid, dots]) {
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.hasAttribute('data-visual-motion')).toBe(false);
    }
    expect(grid.style.getPropertyValue('--grid-size')).toBe('32px');
    expect(grid.className).toContain('visual-fade-bottom');
    expect(dots.style.getPropertyValue('--dot-gap')).toBe('20px');
    expect(dots.className).toContain('visual-fade-radial');
  });
});

describe('GlowFrame', () => {
  it('wraps the CTA without changing its role or name', () => {
    render(
      <GlowFrame>
        <button type="button">Approve and send</button>
      </GlowFrame>,
    );
    const button = screen.getByRole('button', { name: 'Approve and send' });
    expect(button.parentElement?.hasAttribute('data-glow-frame')).toBe(true);
  });
});

describe('ChromaBorder', () => {
  it('wraps its child, with an aria-hidden halo and a looping comet', () => {
    const { container } = render(
      <ChromaBorder radius={20}>
        <p>Sign in</p>
      </ChromaBorder>,
    );
    const root = container.querySelector('.visual-chroma') as HTMLElement;
    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(root.getAttribute('data-visual-motion')).toBe('chroma');
    expect(root.hasAttribute('data-motion')).toBe(false);
    expect(root.style.borderRadius).toBe('20px');
    expect(root.querySelector('.visual-chroma__halo')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('rests as a static ring under reduced motion', () => {
    setReducedMotion(true);
    const { container } = render(
      <ChromaBorder>
        <p>Sign in</p>
      </ChromaBorder>,
    );
    expect(container.querySelector('.visual-chroma')?.getAttribute('data-motion')).toBe('static');
  });
});

describe('BorderBeam', () => {
  it('is an aria-hidden border band driven by CSS variables', () => {
    const { container } = render(<BorderBeam duration={6} size={80} colorFrom="var(--aura)" />);
    const beam = container.querySelector('.visual-beam') as HTMLElement;
    expect(beam.getAttribute('aria-hidden')).toBe('true');
    expect(beam.style.getPropertyValue('--beam-duration')).toBe('6s');
    expect(beam.style.getPropertyValue('--beam-size')).toBe('80px');
    expect(beam.style.getPropertyValue('--beam-from')).toBe('var(--aura)');
    expect(beam.querySelector('.visual-beam__light')?.hasAttribute('data-motion')).toBe(false);
  });

  it('holds a still streak under reduced motion', () => {
    setReducedMotion(true);
    const { container } = render(<BorderBeam />);
    expect(container.querySelector('.visual-beam__light')?.getAttribute('data-motion')).toBe('static');
  });
});

describe('SpotlightCard', () => {
  it('follows a mouse pointer through CSS variables and ignores touch', () => {
    render(
      <SpotlightCard as="article">
        <h3>Pricing</h3>
      </SpotlightCard>,
    );
    const card = screen.getByRole('article');
    fireEvent.pointerMove(card, { pointerType: 'touch', clientX: 10, clientY: 10 });
    expect(card.hasAttribute('data-spot')).toBe(false);
    fireEvent.pointerMove(card, { pointerType: 'mouse', clientX: 42, clientY: 17 });
    expect(card.getAttribute('data-spot')).toBe('on');
    expect(card.style.getPropertyValue('--spot-x')).toBe('42px');
    expect(card.style.getPropertyValue('--spot-y')).toBe('17px');
    fireEvent.pointerLeave(card, { pointerType: 'mouse' });
    expect(card.hasAttribute('data-spot')).toBe(false);
  });
});

describe('TiltCard', () => {
  it('tilts for a mouse, not for touch, and stays flat under reduced motion', () => {
    const { container, unmount } = render(
      <TiltCard>
        <p>Sources</p>
      </TiltCard>,
    );
    const card = container.querySelector('[data-tilt-card]') as HTMLElement;
    fireEvent.pointerMove(card, { pointerType: 'touch', clientX: 5, clientY: 5 });
    expect(card.hasAttribute('data-tilt')).toBe(false);
    fireEvent.pointerMove(card, { pointerType: 'mouse', clientX: 5, clientY: 5 });
    expect(card.getAttribute('data-tilt')).toBe('on');
    fireEvent.pointerLeave(card, { pointerType: 'mouse' });
    expect(card.hasAttribute('data-tilt')).toBe(false);
    expect(card.style.getPropertyValue('--tilt-x')).toBe('0deg');
    unmount();

    setReducedMotion(true);
    const reduced = render(
      <TiltCard>
        <p>Sources</p>
      </TiltCard>,
    );
    const still = reduced.container.querySelector('[data-tilt-card]') as HTMLElement;
    fireEvent.pointerMove(still, { pointerType: 'mouse', clientX: 5, clientY: 5 });
    expect(still.hasAttribute('data-tilt')).toBe(false);
  });
});

describe('Reveal, Stagger and StaggerItem', () => {
  it('animates with a CSS entrance and keeps the requested element', () => {
    render(
      <Reveal as="h1" variant="focus" delay={0.08}>
        Jobs
      </Reveal>,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Jobs' });
    expect(heading.className).toContain('visual-reveal');
    expect(heading.getAttribute('data-reveal')).toBe('focus');
    expect(heading.style.getPropertyValue('--reveal-delay')).toBe('80ms');
  });

  it('renders a static element under reduced motion', () => {
    setReducedMotion(true);
    render(<Reveal inView>Below the fold</Reveal>);
    const el = screen.getByText('Below the fold');
    expect(el.getAttribute('data-reveal')).toBe('static');
    expect(el.className).not.toContain('visual-reveal');
    expect(el.hasAttribute('data-reveal-wait')).toBe(false);
  });

  it('releases an inView reveal at once when IntersectionObserver is missing (jsdom)', () => {
    render(<Reveal inView>Below the fold</Reveal>);
    expect(screen.getByText('Below the fold').hasAttribute('data-reveal-wait')).toBe(false);
  });

  it('staggers direct children with the grid or list step', () => {
    const { container } = render(
      <Stagger as="ul" step="list">
        <StaggerItem as="li">One</StaggerItem>
        <StaggerItem as="li">Two</StaggerItem>
      </Stagger>,
    );
    const list = container.querySelector('[data-stagger]') as HTMLElement;
    expect(list.tagName).toBe('UL');
    expect(list.style.getPropertyValue('--stagger-step')).toBe('30ms');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.className).toContain('visual-reveal');
  });
});

describe('PageTransition', () => {
  let animate: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    animate = vi.fn(() => ({ cancel: () => undefined }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  });

  it('fades the content in when the pathname changes, never on first render', () => {
    const { rerender } = render(<PageTransition>Page A</PageTransition>);
    expect(animate).not.toHaveBeenCalled();
    navigation.pathname = '/dashboard/user/leads';
    rerender(<PageTransition>Page B</PageTransition>);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 240 });
  });

  it('does not animate under reduced motion', () => {
    setReducedMotion(true);
    const { rerender } = render(<PageTransition>Page A</PageTransition>);
    navigation.pathname = '/dashboard/user/inbox';
    rerender(<PageTransition>Page B</PageTransition>);
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByText('Page B')).toBeTruthy();
  });
});

function BeamFixture(props: { active?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const from = useRef<HTMLDivElement>(null);
  const to = useRef<HTMLDivElement>(null);
  return (
    <div ref={container} style={{ position: 'relative' }}>
      <div ref={from}>Google Sheets</div>
      <div ref={to}>AuraLead</div>
      <AnimatedBeam containerRef={container} fromRef={from} toRef={to} active={props.active} />
    </div>
  );
}

describe('AnimatedBeam', () => {
  it('draws an aria-hidden curve with a travelling pulse between the two nodes', () => {
    const { container } = render(<BeamFixture />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('data-beam')).toBe('active');
    expect(svg.querySelectorAll('.visual-beam-path--dash')).toHaveLength(2);
    // The geometry was written through refs (jsdom rects are all zero).
    expect(svg.querySelector('.visual-beam-path--base')?.getAttribute('d')).toMatch(/^M 0\.0,0\.0 Q /);
  });

  it('rests as a solid line under reduced motion', () => {
    setReducedMotion(true);
    const { container } = render(<BeamFixture />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.querySelectorAll('.visual-beam-path--dash')).toHaveLength(0);
    expect(svg.querySelector('.visual-beam-path--rest')).not.toBeNull();
    expect(svg.hasAttribute('data-visual-motion')).toBe(false);
  });

  it('draws a static dashed link, with no pulse, when the link is not live', () => {
    const { container } = render(<BeamFixture active={false} />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    expect(svg.getAttribute('data-beam')).toBe('idle');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelector('.visual-beam-path--idle')).not.toBeNull();
  });
});

describe('Meteors and Sparkles', () => {
  it('render the requested count deterministically, aria-hidden', () => {
    const first = render(
      <>
        <Meteors count={6} />
        <Sparkles count={9} />
      </>,
    );
    const markup = first.container.innerHTML;
    expect(first.container.querySelectorAll('.visual-meteor')).toHaveLength(6);
    expect(first.container.querySelectorAll('.visual-sparkle')).toHaveLength(9);
    for (const root of first.container.querySelectorAll('[data-visual-motion]')) expect(root.getAttribute('aria-hidden')).toBe('true');
    first.unmount();
    const second = render(
      <>
        <Meteors count={6} />
        <Sparkles count={9} />
      </>,
    );
    expect(second.container.innerHTML).toBe(markup);
  });

  it('pause offscreen and in a hidden tab, like every other loop', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { container } = render(
      <>
        <Meteors count={3} />
        <Sparkles count={3} />
      </>,
    );
    const roots = [...container.querySelectorAll<HTMLElement>('[data-visual-motion]')];
    expect(roots.map((root) => root.dataset.visualMotion)).toEqual(['meteors', 'sparkles']);
    for (const root of roots) {
      expect(root.querySelector(':scope > [data-pause-probe]')).not.toBeNull();
      expect(root.getAttribute('data-paused')).toBe('true');
    }
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    for (const root of roots) expect(root.hasAttribute('data-paused')).toBe(false);
  });

  it('use an integer-only PRNG that repeats per seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const run = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(run);
    for (const value of run) expect(value >= 0 && value < 1).toBe(true);
  });
});

describe('Marquee', () => {
  it('duplicates the track as an inert, aria-hidden copy', () => {
    const { container } = render(
      <Marquee reverse>
        <a href="#sheets">Google Sheets</a>
      </Marquee>,
    );
    const root = container.querySelector('.visual-marquee') as HTMLElement;
    expect(root.hasAttribute('data-reverse')).toBe(true);
    expect(root.hasAttribute('data-pause-on-hover')).toBe(true);
    const copy = root.querySelector('[data-marquee-copy]') as HTMLElement;
    expect(copy.getAttribute('aria-hidden')).toBe('true');
    expect(copy.hasAttribute('inert')).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Google Sheets' })).toHaveLength(1);
  });

  it('has one pause toggle beside the strip that freezes it with its own attribute (WCAG 2.2.2)', () => {
    const { container } = render(
      <Marquee>
        <span>Google Sheets</span>
      </Marquee>,
    );
    const root = container.querySelector('.visual-marquee') as HTMLElement;
    const buttons = screen.getAllByRole('button', { name: 'Pause scrolling' });
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    // Outside both tracks, so it is never copied into the inert duplicate or carried by the scroll.
    expect(root.contains(button)).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(root.hasAttribute('data-user-paused')).toBe(true);
    // Not data-paused: the offscreen observer rewrites that one whenever the strip scrolls into view.
    expect(root.hasAttribute('data-paused')).toBe(false);
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(root.hasAttribute('data-user-paused')).toBe(false);
    expect(visualCss.replace(/\s+/g, ' ')).toMatch(/\.visual-marquee\[data-user-paused\] \.visual-marquee__track \{ animation-play-state: paused; \}/);
  });
});

describe('OrbitRing', () => {
  it('spaces its items evenly on an aria-hidden ring', () => {
    const { container } = render(
      <OrbitRing radius={80} center={<span>core</span>}>
        <span>a</span>
        <span>b</span>
        <span>c</span>
        <span>d</span>
      </OrbitRing>,
    );
    const root = container.querySelector('.visual-orbit') as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    const angles = [...root.querySelectorAll<HTMLElement>('.visual-orbit__item')].map((el) => el.style.getPropertyValue('--orbit-angle'));
    expect(angles).toEqual(['0.00deg', '90.00deg', '180.00deg', '270.00deg']);
    expect(root.style.getPropertyValue('--orbit-radius')).toBe('80px');
  });
});

describe('ShimmerText', () => {
  it('keeps the label readable to assistive tech', () => {
    render(<ShimmerText>Syncing sheet…</ShimmerText>);
    const text = screen.getByText('Syncing sheet…');
    expect(text.hasAttribute('aria-hidden')).toBe(false);
    expect(text.className).toContain('visual-shimmer-text');
  });
});

describe('visual.css contract', () => {
  const reducedBlock = visualCss.slice(visualCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  it('defines every component class the visual components render', () => {
    for (const cls of [
      'visual-aurora--header',
      'visual-aurora--hero',
      'visual-aurora--auth',
      'visual-aurora--empty',
      'visual-aurora--card',
      'visual-chroma__halo',
      'visual-beam__light',
      'visual-spotlight',
      'visual-tilt',
      'visual-reveal',
      'visual-stagger',
      'visual-beam-path--dash',
      'visual-meteor',
      'visual-sparkle',
      'visual-marquee__track',
      'visual-orbit__item',
      'visual-shimmer-text',
    ]) {
      expect(visualCss, cls).toContain(`.${cls}`);
    }
  });

  it('gives each effect a designed resting frame under reduced motion', () => {
    for (const rest of ['.visual-reveal', '.visual-chroma::before', '.visual-beam__light', '.visual-beam-path--dash', '.visual-meteor::before', '[data-marquee-copy]', '.visual-shimmer-text', '.visual-tilt']) {
      expect(reducedBlock, rest).toContain(rest);
    }
  });

  it('is imported by globals.css and exposes the animations as Tailwind tokens', () => {
    expect(readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8')).toContain('../styles/visual.css');
    for (const token of ['--animate-aurora-a', '--animate-chroma-spin', '--animate-marquee', '--animate-reveal-rise']) {
      expect(visualCss).toContain(token);
    }
  });

  // tokens.css and globals.css own the button sheen, the skeleton shimmer and --chroma-angle; a
  // second definition here would silently lose to (or override) theirs, depending on import order.
  it('defines no animation token, keyframes or @property that the theme files already define', () => {
    const themeCss = ['src/styles/tokens.css', 'src/app/globals.css'].map((file) => readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
    const names = (css: string) => new Set([...css.matchAll(/(--animate-[\w-]+)\s*:|@keyframes\s+([\w-]+)|@property\s+(--[\w-]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]));
    const theme = names(themeCss);
    expect([...names(visualCss)].filter((name) => theme.has(name))).toEqual([]);
  });
});

describe('PageHeader', () => {
  it('renders an h1 whose text is exactly the title, over an aria-hidden aurora', () => {
    const { container } = render(
      <PageHeader
        eyebrow="Platform admin"
        title="Jobs and queue"
        description="Actions need a reason and are audited."
        meta="As of 19 Oct 2026, 10:42"
        actions={<button type="button">Retry selected</button>}
      />,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Jobs and queue' });
    expect(heading.textContent).toBe('Jobs and queue');
    expect(heading.className).toContain('text-gradient');
    expect(screen.getByText('Platform admin')).toBeTruthy();
    expect(screen.getByText('As of 19 Oct 2026, 10:42')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry selected' })).toBeTruthy();
    expect(container.querySelector('[data-aurora="header"]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the h1 static under reduced motion', () => {
    setReducedMotion(true);
    render(<PageHeader title="Lead console" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Lead console' }).getAttribute('data-reveal')).toBe('static');
  });
});

describe('SectionCard', () => {
  it('is a region named by its title, shrinkable, with meta, actions and an optional hairline', () => {
    const { container } = render(
      <SectionCard title="Worker" titleAs="h3" meta="As of 10:42" actions={<button type="button">Refresh</button>} accent>
        <p>Running</p>
      </SectionCard>,
    );
    const region = screen.getByRole('region', { name: 'Worker' });
    expect(region.className).toContain('min-w-0');
    expect(within(region).getByRole('heading', { level: 3, name: 'Worker' })).toBeTruthy();
    expect(within(region).getByText('As of 10:42')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it('renders without a header when untitled', () => {
    const { container } = render(<SectionCard>Body</SectionCard>);
    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('section')?.hasAttribute('aria-labelledby')).toBe(false);
  });
});

describe('StatTile', () => {
  it('shows the label and the final value as a description list', () => {
    render(<StatTile label="Dead jobs" value="3" hint="needs an operator" tone="warning" />);
    expect(screen.getByRole('term').textContent).toBe('Dead jobs');
    const values = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(values).toEqual(['3', 'needs an operator']);
  });

  it('becomes a single link when it has an href', () => {
    render(<StatTile label="Leads this week" value="128" href="/dashboard/user/leads" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/dashboard/user/leads');
    expect(link.textContent).toContain('Leads this week');
    expect(link.textContent).toContain('128');
  });
});

describe('source styles and SourceChip', () => {
  it('cover every LeadSource and simulator key with a label, an icon and chart-palette classes', () => {
    for (const key of [...LeadSource, ...SIMULATION_SOURCES, 'maps']) {
      const style = sourceStyle(key);
      expect(style.label.length, key).toBeGreaterThan(0);
      expect(style.icon, key).toBeTruthy();
      expect(style.dotClass, key).toMatch(/^bg-/);
      expect(style.chipClass, key).toContain('text-fg-1');
    }
    expect(SOURCE_STYLES.GOOGLE_SHEETS.dotClass).toContain('chart-2');
    expect(SOURCE_STYLES.META_ADS.dotClass).toContain('chart-4');
    expect(SOURCE_STYLES.GMAPS_EXTENSION.dotClass).toContain('chart-1');
    expect(SOURCE_STYLES.WHATSAPP_INBOUND.dotClass).toContain('chart-3');
    expect(SOURCE_STYLES.MANUAL.dotClass).toContain('chart-other');
    // Lead-gen sources share their family's hue and differ by label and icon (ADR-118, ADR-120).
    expect(SOURCE_STYLES.GOOGLE_PLACES.dotClass).toContain('chart-1');
    expect(SOURCE_STYLES.FILE_IMPORT.dotClass).toContain('chart-2');
    expect([SOURCE_STYLES.GOOGLE_PLACES.label, SOURCE_STYLES.FILE_IMPORT.label]).toEqual(['Google Places', 'File import']);
    expect(SOURCE_STYLES.GOOGLE_PLACES.icon).not.toBe(SOURCE_STYLES.GMAPS_EXTENSION.icon);
    expect(SOURCE_STYLES.FILE_IMPORT.icon).not.toBe(SOURCE_STYLES.GOOGLE_SHEETS.icon);
    expect(sourceStyle('sheets')).toBe(SOURCE_STYLES.GOOGLE_SHEETS);
    expect(sourceStyle('gmaps')).toBe(sourceStyle('maps'));
  });

  it('keeps the existing page labels, and an unknown source keeps its own text', () => {
    expect(['GOOGLE_SHEETS', 'META_ADS', 'GMAPS_EXTENSION', 'WHATSAPP_INBOUND', 'EMAIL_INBOUND', 'MANUAL'].map((s) => sourceStyle(s).label)).toEqual([
      'Google Sheets',
      'Meta Lead Ads',
      'Maps extension',
      'WhatsApp',
      'Email',
      'Manual',
    ]);
    expect(sourceStyle('CSV_IMPORT').label).toBe('CSV_IMPORT');
  });

  it('renders the label with a decorative dot or icon (never color alone)', () => {
    const { container } = render(
      <>
        <SourceChip source="META_ADS" />
        <SourceChip source="gmaps" withIcon />
      </>,
    );
    expect(screen.getByText('Meta Lead Ads')).toBeTruthy();
    expect(screen.getByText('Maps extension')).toBeTruthy();
    const decorations = container.querySelectorAll('[data-source-chip] [aria-hidden="true"]');
    expect(decorations).toHaveLength(2);
    expect(decorations[1]?.tagName.toLowerCase()).toBe('svg');
  });
});
