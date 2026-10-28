'use client';

/**
 * The only gate into RoleSwitcher.tsx (ADR-04, P19). NEXT_PUBLIC_APP_MODE is inlined at build
 * time, so in a LIVE build both conditions fold to `false`, the dynamic imports are dead code,
 * and the RoleSwitcher chunk is never emitted (tests/unit/arch/live-bundle.test.ts). Do not
 * import RoleSwitcher anywhere else and do not hoist the comparison into another module: the
 * literal comparison must sit next to each import for the bundler to drop it.
 *
 * The /login persona list loads on the client only, so until its chunk arrives the card shows
 * one persona-card placeholder per DEMO persona (four), of the same size. That avoids an empty
 * card and a layout jump.
 * The placeholders use the shared Skeleton shimmer (static under reduced motion), are aria-hidden
 * and carry no live region; the list's buttons are the content.
 */
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

function PersonaListPlaceholder() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex min-h-16 items-center gap-3 rounded-xl border border-border-strong bg-bg-2/80 px-3 py-2.5">
          <Skeleton className="size-11 shrink-0 rounded-lg bg-bg-3/80" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-32 rounded-sm bg-bg-3/80" />
            <Skeleton className="h-3 w-20 rounded-sm bg-bg-3/50" />
          </div>
        </div>
      ))}
    </div>
  );
}

const LazyRoleSwitcher =
  process.env.NEXT_PUBLIC_APP_MODE === 'demo' ? dynamic(() => import('./RoleSwitcher').then((m) => m.RoleSwitcher), { ssr: false }) : null;

const LazyDemoPersonaList =
  process.env.NEXT_PUBLIC_APP_MODE === 'demo'
    ? dynamic(() => import('./RoleSwitcher').then((m) => m.DemoPersonaList), { ssr: false, loading: PersonaListPlaceholder })
    : null;

/** Floating DEMO role switcher; renders nothing (and ships nothing) in a LIVE build. */
export function DemoRoleSwitcher() {
  return LazyRoleSwitcher ? <LazyRoleSwitcher /> : null;
}

/** Seeded-identity sign-in for /login in DEMO; null in a LIVE build. */
export function DemoPersonaSignIn() {
  return LazyDemoPersonaList ? <LazyDemoPersonaList /> : null;
}
