/**
 * The cinematic frame shared by /login and /invite (design spec §6 "Auth"; this supersedes the
 * T08 "no glow and no glass" note, recorded in the Aurora ADRs).
 *
 * Layers, back to front:
 * - The full-bleed AuraAuthBackdrop: aurora curtains with the AuraLead core off-centre right. The
 *   SVG poster renders first (SSR); WebGL fades in only when the visual budget allows it (at
 *   least 1024px, no reduced motion, a capable GPU). Otherwise the poster stays. It is skipped
 *   from 640 to 767px, where the core would peek out from behind the card whichever side the
 *   card sits on.
 * - Below 768px only, the CSS aurora: there the core is hidden behind the card (or skipped), so
 *   the blobs at the edges carry the color.
 * - A dot grid fading out from the centre.
 * - A scrim that darkens the content column, so the wordmark and the card never sit on a bright
 *   curtain (text over decoration stays at or under the 16% aurora cap).
 * - The content. From 768px the card is on the left (26rem wide until 1024px) and the core stays
 *   whole on the right; a centred card on a tablet half-covered the core, which read as an
 *   accident. On phones the card takes the full width over a darker scrim.
 *
 * The card is glass (bg-1 at 80%, at most 16px blur) inside the one ChromaBorder of the view, with
 * a static aurora tint in its corner. The wordmark is the view's single gradient text; the h1
 * stays text-1. The wordmark, card and footnote rise in once (Reveal) and rest under reduced
 * motion. The titles, descriptions, footnotes and form semantics are the pages' own.
 */
import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { ProductMark } from '@/components/patterns/ProductMark';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { ChromaBorder } from '@/components/visual/ChromaBorder';
import { DotPattern } from '@/components/visual/Patterns';
import { Reveal } from '@/components/visual/Reveal';
import { AuraAuthBackdrop } from '@/components/visual/aura';

export function AuthFrame(props: { title: string; description: ReactNode; children: ReactNode; footnote?: ReactNode; banner?: ReactNode }) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-bg-0">
      <AuraAuthBackdrop className="-z-10 sm:max-md:hidden" />
      {/* Phones: the core sits behind the full-width card there, so a CSS aurora carries the color. */}
      <AuroraBackdrop variant="auth" className="md:hidden" />
      <DotPattern fade="radial" gap={22} className="opacity-60" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-bg-0/20 md:bg-transparent md:bg-[linear-gradient(100deg,color-mix(in_oklab,var(--bg-0)_74%,transparent)_0%,color-mix(in_oklab,var(--bg-0)_42%,transparent)_34%,transparent_58%)]"
      />
      {props.banner}
      <main id="main" className="relative flex flex-1 items-center px-4 py-10 sm:px-8 md:px-[4vw] lg:px-[7vw] lg:py-16">
        <div className="mx-auto flex w-full max-w-md flex-col gap-7 md:mx-0 md:max-w-[26rem] lg:max-w-md">
          <Reveal className="flex items-center gap-3">
            <ProductMark className="size-11" />
            <span className="flex flex-col gap-0.5">
              <span className="text-gradient font-display text-2xl leading-7 font-bold tracking-tight">AuraLead AI</span>
              <span className="text-xs font-medium tracking-[0.14em] text-fg-2 uppercase">Lead capture to approved quotes</span>
            </span>
          </Reveal>
          <Reveal delay={0.08}>
            <ChromaBorder className="rounded-2xl">
              <section className="relative isolate flex flex-col gap-6 overflow-hidden rounded-2xl border border-border-strong bg-bg-1/80 p-6 shadow-overlay backdrop-blur-lg sm:p-7">
                <AuroraBackdrop variant="card" />
                <div className="flex flex-col gap-2">
                  <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">{props.title}</h1>
                  <div className="text-fg-2">{props.description}</div>
                </div>
                {props.children}
                {props.footnote ? (
                  <div className="-mx-6 -mb-6 flex items-start gap-2 border-t border-border-subtle bg-bg-0/40 px-6 py-3.5 text-xs text-fg-2 sm:-mx-7 sm:-mb-7 sm:px-7">
                    <Info aria-hidden="true" className="mt-px size-3.5 shrink-0 text-fg-3" />
                    <div>{props.footnote}</div>
                  </div>
                ) : null}
              </section>
            </ChromaBorder>
          </Reveal>
        </div>
      </main>
    </div>
  );
}
