/**
 * The hero's 3D core (design spec §3, §6): AuraHero renders the SSR poster first (the LCP stays the
 * headline) and crossfades to WebGL only when the visual budget allows it (>= 768px, capable GPU,
 * no reduced motion). The stream labels are real DOM text placed at the scene's projected anchors
 * (heroAnchors), outside the aria-hidden visual: icon + text chips in the shared source colors,
 * never color alone. Below sm the chips would crowd the poster, so the hero copy carries the same
 * names instead. Server-safe.
 */
import { FileText } from 'lucide-react';
import type { CSSProperties } from 'react';
import { SourceChip } from '@/components/patterns/SourceChip';
import { AuraHero, heroAnchors, heroAspect, type AuraStreamKey } from '@/components/visual/aura';

const CHIP_SOURCE: Record<Exclude<AuraStreamKey, 'quote'>, string> = {
  sheets: 'sheets',
  meta: 'meta',
  maps: 'maps',
  whatsapp: 'WHATSAPP_INBOUND',
};

function StreamLabel({ stream }: { stream: AuraStreamKey }) {
  if (stream === 'quote') {
    return (
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-aura/35 bg-aura/12 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-fg-1">
        <FileText aria-hidden="true" className="size-3.5 shrink-0 text-aura" />
        Versioned quote
      </span>
    );
  }
  return <SourceChip source={CHIP_SOURCE[stream]} withIcon />;
}

export function HeroVisual() {
  const anchors = heroAnchors();
  return (
    <div data-landing-hero-visual="" className="relative mx-auto w-full max-w-[720px]" style={{ aspectRatio: heroAspect() }}>
      <AuraHero className="absolute inset-0" />
      <ul aria-label="Leads flow in from three sources and leave as quotes and messages" className="pointer-events-none absolute inset-0 hidden sm:block">
        {anchors.map((a) => {
          const style: CSSProperties =
            a.direction === 'in'
              ? { left: `max(0px, calc(${a.left}% - 18px))`, top: `calc(${a.top}% + 24px)` }
              : { right: `max(0px, calc(${100 - a.left}% - 18px))`, top: `calc(${a.top}% + 24px)` };
          return (
            <li key={a.key} data-stream-label={a.key} style={style} className="absolute">
              <span className="block rounded-full bg-bg-0/75">
                <StreamLabel stream={a.key} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
