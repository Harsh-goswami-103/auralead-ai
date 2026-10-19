/**
 * Motion presets for motion 14 (`motion/react`), design spec §2. One vocabulary for every animated
 * component so the product moves alike everywhere:
 * - Springs use visualDuration + bounce only (stiffness/damping would be overridden by it).
 * - Enters are slower than exits, and route changes never wait on an exit.
 * - Decoration only: numbers render their final value from frame one (no count-up), tables get one
 *   container fade and no row stagger, and focusPull (blur) is for at most 3 elements per view.
 * - MotionConfig reducedMotion="user" (patterns/Providers) strips transforms under reduced motion;
 *   opacity still fades, so every variant here is readable as an opacity-only crossfade.
 * Plain module without next/* imports, usable from any client component.
 */
import { stagger, type TargetAndTransition, type Transition, type Variants } from 'motion/react';

/** Cubic-bezier easings matching --ease-* in src/styles/tokens.css. */
export const ease = {
  enter: [0.2, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
  emphasized: [0.16, 1, 0.3, 1],
  ambient: [0.45, 0, 0.55, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Durations in seconds matching --dur-* in src/styles/tokens.css. */
export const duration = {
  instant: 0.09,
  fast: 0.15,
  base: 0.22,
  slow: 0.32,
  enter: 0.48,
  chart: 0.45,
  cinematic: 0.9,
} as const;

/**
 * snappy: press, toggles, chips. smooth: nav pill layoutId, tab indicator, popovers.
 * gentle: card and list enter, dialogs, toasts. cinematic: landing and login hero only.
 */
export const spring = {
  snappy: { type: 'spring', visualDuration: 0.18, bounce: 0.2 },
  smooth: { type: 'spring', visualDuration: 0.3, bounce: 0.1 },
  gentle: { type: 'spring', visualDuration: 0.45, bounce: 0.15 },
  cinematic: { type: 'spring', visualDuration: 0.8, bounce: 0.05 },
} as const satisfies Record<string, Transition>;

/** Every exit: 150ms on the exit curve. */
export const exitTransition: Transition = { duration: duration.fast, ease: ease.exit };

/** Default reveal: rise 8px and fade in on the gentle spring. Variant labels: hidden / show. */
export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: spring.gentle },
};

/** Page h1 and hero only (max 3 per view; blur is expensive): rise 12px out of a 6px blur. */
export const focusPull: Variants = {
  hidden: { opacity: 0, y: 12, filter: 'blur(6px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: duration.enter, ease: ease.emphasized } },
};

/** Opacity only: tables (one 200ms container fade) and anything that must not move. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2, ease: ease.enter } },
};

/** Only the first 8 children of a staggered container animate; later ones render settled. */
export const STAGGER_LIMIT = 8;

/** Container variants that stagger their children's `show` (grids 0.045s, short lists 0.03s). */
export function staggerContainer(step: number = 0.045, startDelay: number = 0.05): Variants {
  return {
    hidden: {},
    show: { transition: { delayChildren: stagger(step, { startDelay }) } },
  };
}

/** Card grids and rows of tiles. */
export const gridStagger = staggerContainer(0.045);

/** Lists of 12 or fewer items. */
export const listStagger = staggerContainer(0.03);

/** `initial` for the child at `index`: 'hidden' for the first 8, false (already settled) after. */
export function staggerInitial(index: number): 'hidden' | false {
  return index < STAGGER_LIMIT ? 'hidden' : false;
}

/** Buttons and pressable chips: whileTap={press} (CSS active:scale-[.97] covers ui/Button). */
export const press: TargetAndTransition = { scale: 0.97, transition: spring.snappy };

/** Link cards: whileHover={hoverLift}; pair with a border that brightens to the panel hue at 45%. */
export const hoverLift: TargetAndTransition = { y: -2, transition: spring.snappy };

/** Route enter (PageTransition, keyed by pathname): 240ms fade and 6px rise, no exit. */
export const routeEnter = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24, ease: ease.enter },
} as const satisfies { initial: TargetAndTransition; animate: TargetAndTransition; transition: Transition };
