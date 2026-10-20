'use client';

/**
 * Root error boundary (design spec §6 "System pages"; Next 16.4 error.js). It catches a render
 * error in any page that no nearer error.tsx handles, and renders inside the root layout, so the
 * tokens and fonts apply. It shows ErrorState with the error's digest as the Reference and never
 * error.message, which can carry internals (06-design §11.3). "Try again" calls retry(), which
 * re-fetches and re-renders the segment. Errors in the root layout itself go to global-error.tsx.
 */
import Link from 'next/link';
import { LogIn } from 'lucide-react';
import { ErrorState } from '@/components/patterns/ErrorState';
import { ProductMark } from '@/components/patterns/ProductMark';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { GridPattern } from '@/components/visual/Patterns';
import { Reveal } from '@/components/visual/Reveal';

export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-bg-0">
      <AuroraBackdrop variant="empty" className="bottom-auto h-[28rem]" />
      <GridPattern fade="radial" size={56} className="opacity-60" />
      <header className="flex items-center px-5 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <ProductMark className="size-9" />
          <span className="font-display text-lg font-semibold tracking-tight text-fg-1">AuraLead AI</span>
        </div>
      </header>
      <main id="main" className="flex flex-1 items-center justify-center px-4 pb-20">
        <div className="flex w-full max-w-lg flex-col gap-6">
          <Reveal className="flex flex-col gap-2">
            <h1 className="font-display text-3xl font-semibold text-balance text-fg-1">This page could not be shown</h1>
            <p className="text-fg-2">Something failed while it was loading. Try again, or start over from sign in.</p>
          </Reveal>
          <Reveal delay={0.08}>
            <ErrorState correlationId={error.digest ?? 'not available'} title="The page stopped loading" onRetry={() => retry()} />
          </Reveal>
          <Reveal delay={0.14} variant="fade">
            <Link href="/login" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-fg-2')}>
              <LogIn aria-hidden="true" />
              Go to sign in
            </Link>
          </Reveal>
        </div>
      </main>
    </div>
  );
}
