'use client';

/*
 * AuraVisual: the client shell of the decorative AuraLead scene (design spec §0.7, §3). It renders the
 * SVG poster first (SSR and hydration agree on it). Only when the visual budget allows WebGL, the
 * browser has been idle once and the box has come within 200px of the viewport does it fetch the
 * scene (next/dynamic with ssr: false: the only import of AuraScene, so no page bundles three
 * eagerly), then crossfades the canvas in after its first frame. Offscreen or on a hidden tab the
 * frame loop stops; a lost WebGL context, a scene too slow even on the low tier, a failed context
 * creation or a failed chunk load swaps back to the poster for good (a decorative visual never
 * breaks or bogs down its page). aria-hidden, no data.
 * `data-visual-state` reads 'poster' or 'webgl' for tests.
 */
import dynamic from 'next/dynamic';
import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { cn } from '@/components/ui/cn';
import { AuraPoster } from './AuraPoster';
import { AURA_PRESETS, type AuraPreset, type AuraTier } from './aura-layout';
import { useVisualBudget } from './visual-budget';

const AuraCanvas = dynamic(() => import('./AuraScene').then((m) => m.AuraCanvas), { ssr: false });

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible', () => false);
}

/* True once the browser has been idle (LCP stays the SSR headline and poster). Safari has no rIC. */
function useIdleOnce(timeoutMs = 1500): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => setIdle(true), { timeout: timeoutMs });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(() => setIdle(true), timeoutMs);
    return () => window.clearTimeout(id);
  }, [timeoutMs]);
  return idle;
}

/* { near: has come within the margin once, onScreen: is within it now }. Without IO (jsdom): both true. */
function useNearViewport(ref: RefObject<Element | null>, rootMargin: string): { near: boolean; onScreen: boolean } {
  const [state, setState] = useState({ near: false, onScreen: false });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        setState((prev) => ({ near: prev.near || visible, onScreen: visible }));
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return typeof IntersectionObserver === 'function' ? state : { near: true, onScreen: true };
}

/* Any render error below (chunk load, WebGL context creation) is reported once and renders nothing. */
class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export type AuraVisualProps = {
  preset: AuraPreset;
  /** Size and placement of the visual box; the poster and canvas fill it. */
  className?: string;
};

export function AuraVisual({ preset, className }: AuraVisualProps) {
  const config = AURA_PRESETS[preset];
  const budget = useVisualBudget(config.minWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const { near, onScreen } = useNearViewport(rootRef, '200px 0px');
  const pageVisible = usePageVisible();
  const idle = useIdleOnce();
  const [failed, setFailed] = useState(false);
  const live = budget !== 'off' && idle && near && !failed;
  const tier: AuraTier = budget === 'high' && config.maxTier === 'high' ? 'high' : 'low';
  return (
    <div ref={rootRef} aria-hidden="true" data-aura={preset} className={cn('pointer-events-none relative overflow-hidden', className)}>
      {/* Keyed by `live`: a fresh stage (ready = false) whenever the canvas mounts or goes away. */}
      <AuraStage key={live ? 'live' : 'poster'} preset={preset} live={live} recovered={failed} tier={tier} active={onScreen && pageVisible} onFail={() => setFailed(true)} />
    </div>
  );
}

function AuraStage(props: { preset: AuraPreset; live: boolean; recovered: boolean; tier: AuraTier; active: boolean; onFail: () => void }) {
  const { preset, live, recovered, tier, active, onFail } = props;
  const [ready, setReady] = useState(false);
  const webgl = live && ready;
  return (
    <div className="absolute inset-0" data-visual-state={webgl ? 'webgl' : 'poster'}>
      <AuraPoster
        preset={preset}
        className={cn(
          'absolute inset-0 h-full w-full transition-opacity duration-[var(--dur-cinematic)] ease-[var(--ease-emphasized)]',
          webgl && 'opacity-0',
          /* Back from a failed canvas: fade the poster in rather than snapping. */
          recovered && 'animate-in fade-in',
        )}
      />
      {live ? (
        <div className={cn('absolute inset-0 opacity-0 transition-opacity duration-[1200ms] ease-[var(--ease-emphasized)]', webgl && 'opacity-100')}>
          <SceneBoundary onError={onFail}>
            <AuraCanvas preset={preset} tier={tier} active={active} onReady={() => setReady(true)} onFallback={onFail} />
          </SceneBoundary>
        </div>
      ) : null}
    </div>
  );
}

/** Landing hero visual: core, orbits and the lead streams (Sheets, Meta Lead Ads, Maps in; Quote, WhatsApp out). */
export function AuraHero({ className }: { className?: string }) {
  return <AuraVisual preset="hero" className={className} />;
}

/** Full-bleed /login and /invite backdrop: aurora curtains with the core off-centre right. Paints its own bg-0. */
export function AuraAuthBackdrop({ className }: { className?: string }) {
  return <AuraVisual preset="auth" className={cn('absolute inset-0 bg-bg-0', className)} />;
}

/** Command-center tile: WebGL from 1440px only, 24 fps cap, low tier; the poster below that. */
export function AuraTile({ className }: { className?: string }) {
  return <AuraVisual preset="tile" className={className} />;
}
