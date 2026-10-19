/**
 * Motion presets (design spec §2): the TypeScript timings must equal the CSS motion tokens, so
 * Motion-driven and CSS-driven animations share one rhythm; springs use visualDuration + bounce
 * only; staggers stop after the first 8 children; exits are faster than enters.
 */
import { describe, expect, it } from 'vitest';
import {
  STAGGER_LIMIT,
  duration,
  ease,
  exitTransition,
  fadeRise,
  focusPull,
  gridStagger,
  listStagger,
  spring,
  staggerInitial,
} from '@/components/motion/presets';
import { resolveToken } from './token-source';

describe('motion presets', () => {
  it('match the --dur-* tokens', () => {
    for (const [name, seconds] of Object.entries(duration)) {
      expect(resolveToken(`dur-${name}`), name).toBe(`${Math.round(seconds * 1000)}ms`);
    }
  });

  it('match the --ease-* tokens', () => {
    for (const [name, points] of Object.entries(ease)) {
      expect(resolveToken(`ease-${name}`), name).toBe(`cubic-bezier(${points.join(', ')})`);
    }
  });

  it('define springs by visualDuration and bounce only', () => {
    expect(spring).toEqual({
      snappy: { type: 'spring', visualDuration: 0.18, bounce: 0.2 },
      smooth: { type: 'spring', visualDuration: 0.3, bounce: 0.1 },
      gentle: { type: 'spring', visualDuration: 0.45, bounce: 0.15 },
      cinematic: { type: 'spring', visualDuration: 0.8, bounce: 0.05 },
    });
  });

  it('reveal from the designed start frames', () => {
    expect(fadeRise.hidden).toEqual({ opacity: 0, y: 8 });
    expect(focusPull.hidden).toEqual({ opacity: 0, y: 12, filter: 'blur(6px)' });
    expect(exitTransition.duration).toBeLessThan(duration.slow);
  });

  it('animates only the first 8 children of a stagger', () => {
    expect(STAGGER_LIMIT).toBe(8);
    expect([0, 7, 8, 20].map(staggerInitial)).toEqual(['hidden', 'hidden', false, false]);
    for (const container of [gridStagger, listStagger]) {
      const show = container.show as { transition: { delayChildren: unknown } };
      expect(typeof show.transition.delayChildren).toBe('function');
    }
  });
});
