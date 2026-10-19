/**
 * Sparkles (design spec §3, landing/auth only): small four-point twinkles in the spark hues
 * (zest, aura, flare, ice). Positions, sizes and timing come from a seeded mulberry32 sequence,
 * so markup is identical on the server, the client and in tests; the twinkle is a CSS opacity +
 * transform keyframe. Fill a `relative` parent. Under reduced motion they rest mid-twinkle.
 */
import type { CSSProperties } from 'react';
import { cn } from '@/components/ui/cn';
import { between, mulberry32 } from './prng';

const COLORS = ['var(--zest)', 'var(--aura)', 'var(--ice)', 'var(--flare)', 'var(--aura)'] as const;

export function Sparkles(props: { count?: number; className?: string; seed?: number }) {
  const next = mulberry32(props.seed ?? 11);
  const count = Math.max(0, Math.min(props.count ?? 16, 48));
  const sparkles = Array.from({ length: count }, (_, index) => ({
    left: between(next, 2, 96),
    top: between(next, 4, 92),
    size: Math.round(between(next, 6, 15)),
    delay: between(next, 0, 4),
    duration: between(next, 2.4, 4.8),
    rest: between(next, 0.35, 0.8),
    color: COLORS[index % COLORS.length],
  }));
  return (
    <div aria-hidden="true" data-visual-motion="sparkles" className={cn('pointer-events-none absolute inset-0', props.className)}>
      {sparkles.map((sparkle, index) => (
        <span
          key={index}
          className="visual-sparkle"
          style={
            {
              left: `${sparkle.left}%`,
              top: `${sparkle.top}%`,
              '--sparkle-size': `${sparkle.size}px`,
              '--sparkle-delay': `${sparkle.delay}s`,
              '--sparkle-duration': `${sparkle.duration}s`,
              '--sparkle-rest': sparkle.rest,
              '--sparkle-color': sparkle.color,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
