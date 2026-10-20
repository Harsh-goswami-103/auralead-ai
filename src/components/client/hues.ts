/**
 * Brand hues for decorative client-panel accents (design spec §1, §6): the aurora family only
 * (aura, volt-hi, zest, ice), never a status hue and never the AI violet. Used for icon chips in
 * section titles, KPI tiles and the pipeline stepper so each kind of fact keeps one hue everywhere.
 * `tile` re-tints a StatTile (tone 'panel') by overriding --panel-hue locally; text stays text-1.
 */
export type BrandHue = 'aura' | 'volt' | 'zest' | 'ice';

export const HUE_CHIP: Readonly<Record<BrandHue, string>> = {
  aura: 'bg-aura/14 text-aura ring-aura/25',
  volt: 'bg-volt-hi/16 text-volt-hi ring-volt-hi/30',
  zest: 'bg-zest/12 text-zest ring-zest/25',
  ice: 'bg-ice/10 text-ice ring-ice/25',
};

export const HUE_TILE: Readonly<Record<BrandHue, string>> = {
  aura: '',
  volt: '[--panel-hue:var(--volt-hi)]',
  zest: '[--panel-hue:var(--zest)]',
  ice: '[--panel-hue:var(--ice)]',
};
