'use client';

/*
 * Visual budget for the decorative WebGL scene (plan §10, design spec §0.7): 'off' renders only the
 * SSR poster and never requests the three chunk; 'low' and 'high' pick the scene tier. decideBudget
 * is pure (tests/unit/visual/visual-budget.test.ts). The hook reads the device through
 * useSyncExternalStore, so the server and the hydrating client both see 'off' (the poster), media-query
 * changes re-evaluate it, and nothing sets state in an effect. jsdom-safe: without matchMedia it
 * reports reduced motion, and the WebGL probe runs only when nothing cheaper already says 'off'.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type VisualBudget = 'off' | 'low' | 'high';

export type BudgetInputs = {
  reducedMotion: boolean;
  webgl2: boolean;
  /** UNMASKED_RENDERER_WEBGL (or RENDERER) of the probe context; null when unknown. */
  renderer: string | null;
  saveData: boolean;
  cores: number;
  /** navigator.deviceMemory in GB; null where the browser does not expose it. */
  memoryGb: number | null;
  width: number;
  coarsePointer: boolean;
};

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export function decideBudget(i: BudgetInputs, minWidth = 768): VisualBudget {
  if (i.reducedMotion || !i.webgl2 || i.saveData || i.cores <= 4 || i.width < minWidth) return 'off';
  /* Software GL renders, but slowly: low tier at most. */
  if (i.renderer !== null && SOFTWARE_RENDERER.test(i.renderer)) return 'low';
  if (i.width >= 1280 && i.cores >= 8 && (i.memoryGb ?? 8) >= 8 && !i.coarsePointer) return 'high';
  return 'low';
}

type GlProbe = Pick<BudgetInputs, 'webgl2' | 'renderer'>;
let glProbe: GlProbe | null = null;

/* One throwaway context, released at once so it never counts against the per-page context cap. */
function probeWebGL2(): GlProbe {
  if (glProbe) return glProbe;
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) {
      glProbe = { webgl2: false, renderer: null };
    } else {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      glProbe = { webgl2: true, renderer };
    }
  } catch {
    glProbe = { webgl2: false, renderer: null };
  }
  return glProbe;
}

type NavigatorExtras = Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };

function matches(query: string, fallback: boolean): boolean {
  return typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback;
}

function readBudget(minWidth: number): VisualBudget {
  const nav = navigator as NavigatorExtras;
  const cheap: BudgetInputs = {
    reducedMotion: matches('(prefers-reduced-motion: reduce)', true),
    webgl2: true,
    renderer: null,
    saveData: nav.connection?.saveData === true,
    cores: nav.hardwareConcurrency ?? 4,
    memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    width: window.innerWidth,
    coarsePointer: matches('(pointer: coarse)', false),
  };
  if (decideBudget(cheap, minWidth) === 'off') return 'off';
  return decideBudget({ ...cheap, ...probeWebGL2() }, minWidth);
}

function subscribeBudget(minWidth: number, onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const queries = ['(prefers-reduced-motion: reduce)', '(pointer: coarse)', `(min-width: ${minWidth}px)`, '(min-width: 1280px)'].map((q) =>
    window.matchMedia(q),
  );
  for (const q of queries) q.addEventListener('change', onChange);
  return () => {
    for (const q of queries) q.removeEventListener('change', onChange);
  };
}

/** The current budget for a placement that needs at least `minWidth` px of viewport. */
export function useVisualBudget(minWidth = 768): VisualBudget {
  const subscribe = useCallback((onChange: () => void) => subscribeBudget(minWidth, onChange), [minWidth]);
  const getSnapshot = useCallback(() => readBudget(minWidth), [minWidth]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 'off');
}
