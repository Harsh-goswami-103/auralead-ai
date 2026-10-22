/**
 * Landing hero (plan T30, 06-design §11.7 landing row): eyebrow, the one h1 (56px cap, 36px at
 * 390) with the keyword in the aurora gradient, a one-line value prop, the primary CTA (DEMO: open
 * the demo; LIVE: sign in) and a secondary anchor to #how-it-works. The 3D core sits on the right
 * (poster first). Behind: the hero aurora, a dot grid and a few meteors (the landing's ambient
 * budget). Copy rises in with Reveal; the h1 uses the focus pull. Server-safe.
 */
import { ArrowDown, ArrowRight, FlaskConical, KeyRound, Sparkles } from 'lucide-react';
import { SourceChip } from '@/components/patterns/SourceChip';
import { Button } from '@/components/ui/button';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { Meteors } from '@/components/visual/Meteors';
import { DotPattern } from '@/components/visual/Patterns';
import { Reveal } from '@/components/visual/Reveal';
import { PrimaryCta, type LandingMode } from './cta';
import { HeroVisual } from './HeroVisual';

export function Hero({ mode }: { mode: LandingMode }) {
  return (
    <section aria-labelledby="landing-title" data-landing-hero="" className="relative isolate overflow-hidden">
      <AuroraBackdrop variant="hero" />
      <DotPattern fade="radial" className="opacity-70" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 -z-10 hidden w-[58%] lg:block">
        <Meteors count={8} seed={23} />
      </div>
      <div className="mx-auto grid w-full max-w-[1280px] items-center gap-8 px-4 pt-10 pb-14 sm:px-6 sm:pt-14 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)] lg:gap-4 lg:px-8 lg:pt-14 lg:pb-16">
        <div className="flex min-w-0 flex-col items-start gap-6">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-aura/30 bg-bg-1/70 py-1 pr-3 pl-1 text-xs font-medium text-fg-1">
              <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-aura/15">
                <Sparkles className="size-3 text-aura" />
              </span>
              Lead-to-quote for Indian service businesses
            </span>
          </Reveal>
          <Reveal
            as="h1"
            variant="focus"
            delay={0.06}
            id="landing-title"
            className="font-display text-[36px] leading-[40px] font-bold tracking-[-0.02em] text-balance text-fg-1 sm:text-[48px] sm:leading-[52px] lg:text-[56px] lg:leading-[60px]"
          >
            Leads in. <span className="text-gradient pb-1">Quotes out.</span>
          </Reveal>
          <Reveal as="p" delay={0.14} className="max-w-[34rem] text-md text-fg-2 sm:text-lg sm:leading-7">
            Find businesses through Google Places or your own Excel list, chat with them on WhatsApp where consent allows it, hand converted leads to the client, and close with a versioned quote and a real PDF.
          </Reveal>
          <Reveal delay={0.22} className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <GlowFrame className="w-full sm:w-auto">
              <PrimaryCta mode={mode} className="w-full sm:w-auto" />
            </GlowFrame>
            <Button asChild variant="secondary" size="lg" className="w-full sm:w-auto">
              <a href="#how-it-works">
                See how it works
                <ArrowDown aria-hidden="true" />
              </a>
            </Button>
          </Reveal>
          <Reveal delay={0.3} className="flex flex-col gap-3">
            <p className="flex items-start gap-2 text-sm text-fg-2">
              {mode === 'demo' ? (
                <>
                  <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-2" />
                  <span>Seeded businesses, simulated providers. Nothing leaves this app.</span>
                </>
              ) : (
                <>
                  <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-aura" />
                  <span>Accounts are created by invitation from your administrator.</span>
                </>
              )}
            </p>
            <ul aria-label="Lead sources in, channels out" className="flex flex-wrap items-center gap-2 sm:hidden">
              {(['GOOGLE_PLACES', 'FILE_IMPORT', 'sheets', 'meta', 'maps'] as const).map((s) => (
                <li key={s}>
                  <SourceChip source={s} withIcon />
                </li>
              ))}
              <li aria-hidden="true">
                <ArrowRight className="size-4 text-fg-3" />
              </li>
              {(['WHATSAPP_INBOUND', 'EMAIL_INBOUND'] as const).map((s) => (
                <li key={s}>
                  <SourceChip source={s} withIcon />
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
        <Reveal variant="fade" delay={0.1} className="relative min-w-0 lg:-mr-6 xl:-mr-10">
          <HeroVisual />
        </Reveal>
      </div>
    </section>
  );
}
