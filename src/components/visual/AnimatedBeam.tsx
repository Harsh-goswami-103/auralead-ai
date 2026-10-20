'use client';

/**
 * AnimatedBeam (design spec §3, landing pipeline and integration maps): a curved SVG link between
 * two elements inside a shared container, with a gradient pulse travelling along it. Geometry
 * after Magic UI's animated-beam (MIT, see THIRD_PARTY_NOTICES.md): a quadratic curve between
 * the two element centers, recomputed by a ResizeObserver. Re-implemented: paths are written to
 * the DOM through refs (no React state per resize) and the pulse is a CSS dash offset on a
 * 100-unit path, not a JS gradient loop. Truthful UI: pass `active={false}` for a link that is not
 * really flowing (not connected) and it renders as a static dashed line with no pulse. Paused
 * offscreen; under reduced motion it rests as a solid gradient line. The container must be
 * `relative`; the SVG fills it and is aria-hidden, so label the nodes in text.
 */
import { useEffect, useId, useRef, type CSSProperties, type RefObject } from 'react';
import { cn } from '@/components/ui/cn';
import { useInViewPause } from './use-in-view-pause';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

type Anchor = RefObject<HTMLElement | null>;

export function AnimatedBeam(props: {
  containerRef: Anchor;
  fromRef: Anchor;
  toRef: Anchor;
  /** Lift of the curve's control point in px (positive bends upward; 0 draws a straight line). */
  curvature?: number;
  /** Pulse travels from `to` back to `from`. */
  reverse?: boolean;
  /** Seconds per pulse (default 4). */
  duration?: number;
  /** Seconds before the first pulse. */
  delay?: number;
  /** Gradient color at the `from` end (default the panel hue). */
  fromColor?: string;
  /** Gradient color at the `to` end (default the second panel hue). */
  toColor?: string;
  /** Stroke width in px (default 2). */
  width?: number;
  /** False draws a static dashed line: use it for links that are not live (default true). */
  active?: boolean;
  className?: string;
}) {
  const { containerRef, fromRef, toRef } = props;
  const curvature = props.curvature ?? 0;
  const gradientId = `beam-${useId().replace(/:/g, '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const gradientRef = useRef<SVGLinearGradientElement>(null);
  const reduced = usePrefersReducedMotion();
  const active = props.active ?? true;
  const pulsing = active && !reduced;
  useInViewPause(svgRef);

  useEffect(() => {
    const container = containerRef.current;
    const from = fromRef.current;
    const to = toRef.current;
    const svg = svgRef.current;
    const gradient = gradientRef.current;
    if (!container || !from || !to || !svg || !gradient) return;

    const update = () => {
      const box = container.getBoundingClientRect();
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const originX = box.left + container.clientLeft;
      const originY = box.top + container.clientTop;
      const sx = a.left - originX + a.width / 2;
      const sy = a.top - originY + a.height / 2;
      const ex = b.left - originX + b.width / 2;
      const ey = b.top - originY + b.height / 2;
      const d = `M ${sx.toFixed(1)},${sy.toFixed(1)} Q ${((sx + ex) / 2).toFixed(1)},${((sy + ey) / 2 - curvature).toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
      for (const path of svg.querySelectorAll('path')) path.setAttribute('d', d);
      gradient.setAttribute('x1', sx.toFixed(1));
      gradient.setAttribute('y1', sy.toFixed(1));
      gradient.setAttribute('x2', ex.toFixed(1));
      gradient.setAttribute('y2', ey.toFixed(1));
    };

    update();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(update);
    for (const element of [container, from, to]) observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef, fromRef, toRef, curvature, pulsing, active]);

  const width = props.width ?? 2;
  const style = { '--beam-duration': `${props.duration ?? 4}s`, '--beam-delay': `${props.delay ?? 0}s` } as CSSProperties;
  const stroke = `url(#${gradientId})`;
  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      data-visual-motion={pulsing ? 'beam' : undefined}
      data-beam={active ? 'active' : 'idle'}
      fill="none"
      style={style}
      className={cn('pointer-events-none absolute inset-0 size-full overflow-visible', props.className)}
    >
      <defs>
        <linearGradient ref={gradientRef} id={gradientId} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={props.fromColor ?? 'var(--panel-hue)'} />
          <stop offset="1" stopColor={props.toColor ?? 'var(--panel-hue-2)'} />
        </linearGradient>
      </defs>
      {active ? (
        <>
          <path className="visual-beam-path--base" strokeWidth={width} strokeLinecap="round" />
          <path className="visual-beam-path--rest" stroke={stroke} strokeWidth={width} strokeLinecap="round" />
          {pulsing ? (
            <>
              <path
                className="visual-beam-path--dash visual-beam-path--glow"
                data-reverse={props.reverse ? '' : undefined}
                pathLength={100}
                stroke={stroke}
                strokeWidth={width * 3}
                strokeLinecap="round"
              />
              <path
                className="visual-beam-path--dash"
                data-reverse={props.reverse ? '' : undefined}
                pathLength={100}
                stroke={stroke}
                strokeWidth={width}
                strokeLinecap="round"
              />
            </>
          ) : null}
        </>
      ) : (
        <path className="visual-beam-path--idle" strokeWidth={width} strokeLinecap="round" />
      )}
    </svg>
  );
}
