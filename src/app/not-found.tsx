/**
 * Branded 404 (design spec §6 "System pages"). It renders inside the root layout, so it gets the
 * dark tokens and the 404 status. It covers every unknown URL and every notFound() call: a
 * foreign workspace, a missing record, or a panel the role cannot open. One generic sentence
 * never says which of those it was (A6).
 *
 * Look: a full-bleed aurora over a faint grid, a giant gradient "404" (decorative and aria-hidden;
 * the view's one gradient text), the plain h1 "Page not found", and two ways out: sign in (the
 * primary CTA, in GlowFrame) and the home page. From md up, four source sparks circle the
 * block slowly on a faint ring. The entrances run once, and everything rests under reduced
 * motion. Server component, no data.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { House, LogIn } from 'lucide-react';
import { ProductMark } from '@/components/patterns/ProductMark';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { OrbitRing } from '@/components/visual/OrbitRing';
import { GridPattern } from '@/components/visual/Patterns';
import { Reveal } from '@/components/visual/Reveal';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-bg-0">
      <AuroraBackdrop variant="auth" />
      <GridPattern fade="radial" size={56} className="opacity-80" />
      <header className="flex items-center px-5 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <ProductMark className="size-9" />
          <span className="font-display text-lg font-semibold tracking-tight text-fg-1">AuraLead AI</span>
        </div>
      </header>
      <main id="main" className="flex flex-1 items-center justify-center px-4 pb-20">
        <div className="relative isolate flex max-w-xl flex-col items-center text-center">
          {/* Wide enough (r = 300px) to circle the whole block without crossing any text; hidden on phones. */}
          <OrbitRing radius={300} iconSize={14} duration={48} className="absolute top-1/2 left-1/2 -z-10 -translate-x-1/2 -translate-y-1/2 opacity-80 max-md:hidden">
            <span className="block size-2.5 rounded-full bg-zest ring-4 ring-zest/15" />
            <span className="block size-2 rounded-full bg-aura ring-4 ring-aura/15" />
            <span className="block size-2.5 rounded-full bg-flare ring-4 ring-flare/15" />
            <span className="block size-1.5 rounded-full bg-ice ring-4 ring-ice/15" />
          </OrbitRing>
          <Reveal variant="focus">
            <p aria-hidden="true" className="text-gradient font-display text-[clamp(7rem,28vw,13.5rem)] leading-[0.9] font-extrabold tracking-[-0.05em] select-none">
              404
            </p>
          </Reveal>
          <Reveal as="h1" delay={0.08} className="mt-4 font-display text-3xl font-semibold text-balance text-fg-1 sm:text-4xl">
            Page not found
          </Reveal>
          <Reveal as="p" delay={0.12} className="mt-3 max-w-md text-md text-balance text-fg-2">
            The link may be wrong or out of date, or this page is not available to the account you are using.
          </Reveal>
          <Reveal delay={0.18} className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <GlowFrame className="rounded-md">
              <Link href="/login" className={buttonVariants({ size: 'lg' })}>
                <LogIn aria-hidden="true" />
                Go to sign in
              </Link>
            </GlowFrame>
            <Link href="/" className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'bg-bg-2/80')}>
              <House aria-hidden="true" />
              Back to home
            </Link>
          </Reveal>
        </div>
      </main>
    </div>
  );
}
