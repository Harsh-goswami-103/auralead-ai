/**
 * The aura shell's WebGL fallback (design spec §0.7; src/components/visual/aura/AuraScene.tsx and
 * AuraVisual.tsx). A context lost while the canvas is on the page means WebGL is unusable, so the
 * poster stays for good. R3F also forces a context loss on its own renderer after the canvas
 * unmounts (the budget turned WebGL off: a narrow window, reduced motion), and that teardown must
 * not count as a failure, or the scene could never come back when the budget allows it again.
 * R3F is replaced by a fake Canvas that does what the real one does at the edges: a real <canvas>,
 * onCreated with its renderer, and a context loss on that (detached) canvas after unmount.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect, useInsertionEffect, useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuraCanvas } from '@/components/visual/aura/AuraScene';
import { AuraVisual } from '@/components/visual/aura/AuraVisual';
import type { VisualBudget } from '@/components/visual/aura/visual-budget';

const budget = vi.hoisted(() => ({ value: 'high' as VisualBudget }));
const r3f = vi.hoisted(() => ({ canvases: [] as HTMLCanvasElement[] }));

vi.mock('@/components/visual/aura/visual-budget', () => ({ useVisualBudget: () => budget.value }));

vi.mock('@react-three/fiber', () => ({
  Canvas: function FakeCanvas({ onCreated }: { onCreated?: (state: unknown) => void; children?: ReactNode }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const root = useRef<{ canvas: HTMLCanvasElement | null }>({ canvas: null });
    // Like R3F: onCreated runs once per renderer (not again on StrictMode's effect replay or later renders).
    const onCreatedRef = useRef(onCreated);
    useEffect(() => {
      const canvas = ref.current!;
      if (root.current.canvas === canvas) return;
      root.current.canvas = canvas;
      r3f.canvases.push(canvas);
      onCreatedRef.current?.({ gl: { setClearColor: () => undefined, domElement: canvas } });
    }, []);
    // Like R3F, teardown hangs off an insertion effect (StrictMode does not replay those) and is
    // deferred: renderer.forceContextLoss() fires once the canvas has left the page.
    useInsertionEffect(
      () => () => {
        const canvas = root.current.canvas;
        if (canvas) window.setTimeout(() => canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })), 0);
      },
      [],
    );
    return <canvas ref={ref} />;
  },
  useFrame: () => undefined,
  useThree: () => undefined,
}));

vi.mock('@react-three/drei', () => ({
  Float: () => null,
  QuadraticBezierLine: () => null,
  ScreenQuad: () => null,
  Sparkles: () => null,
}));


/** Lets queued timers (the fake teardown, the idle stub) and the dynamic import settle. */
const settle = () => act(() => new Promise<void>((resolve) => window.setTimeout(resolve, 20)));

beforeEach(() => {
  budget.value = 'high';
  r3f.canvases.length = 0;
  vi.stubGlobal('requestIdleCallback', (cb: IdleRequestCallback) => window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0));
  vi.stubGlobal('cancelIdleCallback', (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuraCanvas context loss', () => {
  it('gives up on WebGL when the context is lost while the canvas is mounted', () => {
    const onFallback = vi.fn();
    const { container } = render(<AuraCanvas preset="hero" tier="high" active onReady={() => undefined} onFallback={onFallback} />);
    const lost = new Event('webglcontextlost', { cancelable: true });
    container.querySelector('canvas')!.dispatchEvent(lost);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(lost.defaultPrevented).toBe(true);
  });

  it('still reports a real loss after StrictMode replays its effects', async () => {
    const onFallback = vi.fn();
    const { container } = render(<AuraCanvas preset="hero" tier="high" active onReady={() => undefined} onFallback={onFallback} />, { reactStrictMode: true });
    await settle();
    expect(onFallback).not.toHaveBeenCalled();
    container.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('ignores the context loss R3F causes itself after the canvas unmounts', async () => {
    const onFallback = vi.fn();
    const { unmount } = render(<AuraCanvas preset="hero" tier="high" active onReady={() => undefined} onFallback={onFallback} />);
    unmount();
    await settle();
    expect(r3f.canvases).toHaveLength(1);
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe('AuraVisual budget changes', () => {
  const stage = (container: HTMLElement) => container.querySelector('[data-visual-state]')!;
  const poster = (container: HTMLElement) => container.querySelector('[data-aura-poster]')!;

  it('brings the scene back when the budget allows WebGL again (high, off, high)', async () => {
    const { container, rerender } = render(<AuraVisual preset="hero" />);
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull());

    budget.value = 'off';
    rerender(<AuraVisual preset="hero" />);
    await settle();
    expect(container.querySelector('canvas')).toBeNull();
    expect(stage(container).getAttribute('data-visual-state')).toBe('poster');
    // A budget-driven poster is not a recovery from a failure: no fade-in replay.
    expect(poster(container).getAttribute('class')).not.toContain('animate-in');

    budget.value = 'high';
    rerender(<AuraVisual preset="hero" />);
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull());
    expect(r3f.canvases).toHaveLength(2);
    expect(poster(container).getAttribute('class')).not.toContain('animate-in');
  });

  it('keeps the poster for good after a real context loss', async () => {
    const { container, rerender } = render(<AuraVisual preset="hero" />);
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull());

    act(() => {
      container.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });
    await settle();
    expect(container.querySelector('canvas')).toBeNull();
    expect(poster(container).getAttribute('class')).toContain('animate-in');

    budget.value = 'off';
    rerender(<AuraVisual preset="hero" />);
    budget.value = 'high';
    rerender(<AuraVisual preset="hero" />);
    await settle();
    expect(container.querySelector('canvas')).toBeNull();
    expect(stage(container).getAttribute('data-visual-state')).toBe('poster');
  });
});
