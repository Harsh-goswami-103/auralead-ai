'use client';

/**
 * The only gate into RoleSwitcher.tsx (ADR-04, P19). NEXT_PUBLIC_APP_MODE is inlined at build
 * time, so in a LIVE build both conditions fold to `false`, the dynamic imports are dead code,
 * and the RoleSwitcher chunk is never emitted (tests/unit/arch/live-bundle.test.ts). Do not
 * import RoleSwitcher anywhere else and do not hoist the comparison into another module: the
 * literal comparison must sit next to each import for the bundler to drop it.
 */
import dynamic from 'next/dynamic';

const LazyRoleSwitcher =
  process.env.NEXT_PUBLIC_APP_MODE === 'demo' ? dynamic(() => import('./RoleSwitcher').then((m) => m.RoleSwitcher), { ssr: false }) : null;

const LazyDemoPersonaList =
  process.env.NEXT_PUBLIC_APP_MODE === 'demo' ? dynamic(() => import('./RoleSwitcher').then((m) => m.DemoPersonaList), { ssr: false }) : null;

/** Floating DEMO role switcher; renders nothing (and ships nothing) in a LIVE build. */
export function DemoRoleSwitcher() {
  return LazyRoleSwitcher ? <LazyRoleSwitcher /> : null;
}

/** Seeded-identity sign-in for /login in DEMO; null in a LIVE build. */
export function DemoPersonaSignIn() {
  return LazyDemoPersonaList ? <LazyDemoPersonaList /> : null;
}
