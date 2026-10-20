/**
 * AuroraBackdrop (design spec §3): soft drifting color blobs plus a static film grain, placed
 * absolutely behind content (-z-10; give the parent `relative isolate`). Server-safe: no hooks,
 * the drift is CSS (visual.css, transform only, 24-36s alternate) and a PauseOffscreen island
 * stops it offscreen. Variants:
 *   header  page header band, panel hue + panel-hue-2, blob alpha <= 16% because text sits on it
 *   hero    landing hero: aura, zest, volt and a small flare spark (kept away from volt) at the
 *           edges (<= 28%), tied together by a faint aura wash (<= 8%) behind the text
 *   auth    login / invite full-bleed, same hues as hero without the bottom fade
 *   empty   empty states, one quiet static wash in the panel hue
 *   card    a static corner tint for a feature card
 * Under reduced motion the blobs rest where they start (`ambient` + data-visual-motion). An
 * original CSS build; the aurora idea is inspired by Aceternity UI, whose code is not used.
 */
import { cn } from '@/components/ui/cn';
import { PauseOffscreen } from './PauseOffscreen';

export type AuroraVariant = 'header' | 'hero' | 'auth' | 'empty' | 'card';

const BLOBS: Record<AuroraVariant, readonly ('a' | 'b' | 'c' | 'd' | 'e')[]> = {
  header: ['a', 'b'],
  hero: ['a', 'b', 'c', 'd', 'e'],
  auth: ['a', 'b', 'c', 'd', 'e'],
  empty: ['a', 'b'],
  card: ['a'],
};

const ANIMATED: Record<AuroraVariant, boolean> = { header: true, hero: true, auth: true, empty: false, card: false };

export function AuroraBackdrop(props: { variant?: AuroraVariant; className?: string; grain?: boolean }) {
  const variant = props.variant ?? 'header';
  const animated = ANIMATED[variant];
  return (
    <div
      aria-hidden="true"
      data-aurora={variant}
      data-visual-motion={animated ? 'aurora' : undefined}
      data-grain={props.grain === false ? 'off' : undefined}
      className={cn('visual-aurora', `visual-aurora--${variant}`, animated && 'ambient', props.className)}
    >
      {BLOBS[variant].map((blob) => (
        <div key={blob} className={cn('visual-aurora__blob', `visual-aurora__blob--${blob}`, !animated && 'visual-aurora__blob--static')} />
      ))}
      {animated ? <PauseOffscreen /> : null}
    </div>
  );
}
