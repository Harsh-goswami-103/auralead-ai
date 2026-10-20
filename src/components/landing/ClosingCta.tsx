/**
 * The closing call to action before the footer: one line on what to do next and the primary CTA.
 * The hero aurora returns with a few sparkles kept to the side margins, away from the text
 * (landing only); copy is mode-aware. Server-safe.
 */
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { Reveal } from '@/components/visual/Reveal';
import { Sparkles } from '@/components/visual/Sparkles';
import { PrimaryCta, type LandingMode } from './cta';

export function ClosingCta({ mode }: { mode: LandingMode }) {
  return (
    <section aria-labelledby="closing-title" data-landing-section="closing" className="relative isolate overflow-hidden py-20 sm:py-24">
      <AuroraBackdrop variant="hero" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 -z-10 hidden w-1/4 sm:block">
        <Sparkles count={8} seed={31} />
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 -z-10 hidden w-1/4 sm:block">
        <Sparkles count={8} seed={47} />
      </div>
      <Reveal inView className="mx-auto flex w-full max-w-[1280px] flex-col items-center gap-6 px-4 text-center sm:px-6 lg:px-8">
        <h2
          id="closing-title"
          className="max-w-3xl font-display text-[28px] leading-9 font-semibold tracking-[-0.02em] text-balance text-fg-1 sm:text-4xl sm:leading-[44px] lg:text-5xl lg:leading-[56px]"
        >
          {mode === 'demo' ? 'Follow one lead from form fill to signed quote.' : 'Pick up where your team left off.'}
        </h2>
        <p className="max-w-xl text-md text-pretty text-fg-2 sm:text-lg sm:leading-7">
          {mode === 'demo'
            ? 'Choose a seeded identity and open its panel. Every provider is simulated, so nothing you do here reaches a real customer.'
            : 'Sign in with the account your administrator invited you to.'}
        </p>
        <PrimaryCta mode={mode} />
      </Reveal>
    </section>
  );
}
