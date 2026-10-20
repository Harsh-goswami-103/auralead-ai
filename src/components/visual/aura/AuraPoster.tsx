/*
 * AuraPoster: the static SVG resting frame of the AuraLead scene, one per preset (design spec §0.7).
 * It is the first paint (SSR) and the whole visual whenever WebGL is off: reduced motion, no WebGL2,
 * saveData, small screens, few cores, or a lost context. Positions are projected from aura-layout.ts
 * with the scene camera at rest, and the viewBox spans the preset's frame width with `meet`, which
 * scales exactly like the scene's fit, so the crossfade to the canvas keeps everything in place;
 * colors and glow falloffs are calibrated against the WebGL frame. The auth aurora uses units of the
 * shorter side, like its shader. Server-safe (no hooks), deterministic (seeded PRNG, 3-decimal
 * numbers), aria-hidden, no text.
 */
import { mulberry32 } from '../prng';
import {
  AURA_COLORS,
  AURA_ORBITS,
  AURA_PRESETS,
  AURA_STREAMS,
  posterViewBox,
  projectRest,
  quadraticPoint,
  rotateXYZ,
  streamAnchor,
  type AuraPreset,
  type Vec3,
} from './aura-layout';

const r3 = (n: number) => Number(n.toFixed(3));
const { bg, aura, ice, volt, flare, zest } = AURA_COLORS;

type Point = [number, number];
type Dot = { x: number; y: number; r: number; color: string; opacity: number };

function pathOf(points: readonly Point[], close = false): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${r3(x)} ${r3(y)}`).join('') + (close ? 'Z' : '');
}

/* A ring split into the arcs behind the core and the arcs in front of it (drawn after the core). */
function ringArcs(preset: AuraPreset, radius: number, rotation: Vec3): { back: string; front: string } {
  const back: Point[][] = [[]];
  const front: Point[][] = [[]];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    const p = rotateXYZ([Math.cos(a) * radius, 0, Math.sin(a) * radius], rotation);
    const [target, other] = p[2] >= 0 ? [front, back] : [back, front];
    target[target.length - 1]!.push(projectRest(preset, p, true));
    if (other[other.length - 1]!.length > 0) other.push([]);
  }
  const join = (runs: Point[][]) => runs.filter((run) => run.length > 1).map((run) => pathOf(run)).join('');
  return { back: join(back), front: join(front) };
}

/* The first particles of the scene's dust disc (same seed and draw order), projected at rest. */
function dustDots(preset: AuraPreset, count: number, seed: number): Dot[] {
  const dust = AURA_ORBITS[0]!;
  const rMax = dust.rMax ?? AURA_PRESETS[preset].dustRadius;
  const rnd = mulberry32(seed + dust.seedOffset);
  const dots: Dot[] = [];
  for (let i = 0; i < count; i++) {
    const u = Math.pow(rnd(), 1.6);
    const radius = dust.rMin + (rMax - dust.rMin) * u;
    const angle = rnd() * Math.PI * 2;
    const height = (rnd() - 0.5) * dust.height * (1 - u * 0.6);
    rnd();
    const scale = 0.4 + Math.pow(rnd(), 3) * 1.6;
    const mix = rnd();
    const [x, y] = projectRest(preset, rotateXYZ([Math.cos(angle) * radius, height, Math.sin(angle) * radius], dust.rotation), true);
    const color = mix > 0.97 ? flare : mix > 0.94 ? zest : mix > 0.5 ? ice : aura;
    dots.push({ x: r3(x), y: r3(y), r: r3(0.006 + 0.007 * scale), color, opacity: r3(0.3 + 0.5 * Math.abs(Math.sin(angle * 13))) });
  }
  return dots;
}

/* Wobbly closed loops inside the core: the topographic bands of the shader (pools are filled ones). */
function contourLoops(cx: number, cy: number, r: number, seed: number): { d: string; pool: boolean }[] {
  const rnd = mulberry32(seed);
  const loops = [
    { u: -0.05, v: 0.12, s: 0.34, pool: true },
    { u: -0.08, v: 0.1, s: 0.62, pool: false },
    { u: -0.52, v: -0.12, s: 0.2, pool: true },
    { u: 0.42, v: -0.5, s: 0.18, pool: true },
    { u: 0.6, v: 0.25, s: 0.2, pool: false },
    { u: 0.02, v: 0.06, s: 0.88, pool: false },
  ];
  return loops.map((l) => {
    const [p1, p2] = [rnd() * 6.28, rnd() * 6.28];
    const points = Array.from({ length: 48 }, (_, i): Point => {
      const a = (i / 48) * Math.PI * 2;
      const k = l.s * r * (1 + 0.16 * Math.sin(3 * a + p1) + 0.08 * Math.sin(5 * a + p2));
      return [cx + l.u * r + Math.cos(a) * k, cy + l.v * r + Math.sin(a) * k];
    });
    return { d: pathOf(points, true), pool: l.pool };
  });
}

type PosterGeometry = {
  /** The preset's core look: 0 calm, 1 vivid (the landing hero). */
  energy: number;
  viewBox: string;
  core: { cx: number; cy: number; r: number };
  contours: { d: string; pool: boolean }[];
  rings: { back: string; front: string; color: string }[];
  dust: Dot[];
  streams: { d: string; color: string }[];
  packets: Dot[];
  nodes: { x: number; y: number; color: string }[];
};

function buildGeometry(preset: AuraPreset): PosterGeometry {
  const config = AURA_PRESETS[preset];
  const [cx, cy] = projectRest(preset, [0, 0, 0], true);
  const r = config.core.scale;
  const streams = config.streams ? AURA_STREAMS : [];
  return {
    energy: config.core.energy,
    viewBox: posterViewBox(preset).map(r3).join(' '),
    core: { cx: r3(cx), cy: r3(cy), r: r3(r) },
    contours: contourLoops(cx, cy, r, 11),
    rings: AURA_ORBITS.filter((o) => o.kind === 'ring').map((o) => ({
      ...ringArcs(preset, (o.rMin + (o.rMax ?? o.rMin)) / 2, o.rotation),
      color: o.colors[0],
    })),
    dust: dustDots(preset, preset === 'tile' ? 70 : 140, 7),
    streams: streams.map((s) => ({ d: pathOf(Array.from({ length: 21 }, (_, i) => projectRest(preset, quadraticPoint(s, i / 20)))), color: s.color })),
    packets: streams.flatMap((s, si) =>
      [0.14, 0.2, 0.33, 0.47, 0.52, 0.66, 0.79].map((t, k) => {
        const [x, y] = projectRest(preset, quadraticPoint(s, (t + si * 0.05) % 0.95));
        return { x: r3(x), y: r3(y), r: k % 3 === 0 ? 0.02 : 0.013, color: s.color, opacity: 0.9 };
      }),
    ),
    nodes: streams.map((s) => {
      const [x, y] = projectRest(preset, streamAnchor(s));
      return { x: r3(x), y: r3(y), color: s.color };
    }),
  };
}

const GEOMETRY: Record<AuraPreset, PosterGeometry> = {
  hero: buildGeometry('hero'),
  auth: buildGeometry('auth'),
  tile: buildGeometry('tile'),
};

/* Seeded vertical rays for the aurora curtains (a luminance mask: brighter bars are brighter rays). */
const RAYS = (() => {
  const rnd = mulberry32(23);
  return Array.from({ length: 44 }, (_, i) => ({ x: r3(-1.3 + i * 0.06 + rnd() * 0.03), w: r3(0.03 + rnd() * 0.05), o: r3(0.45 + rnd() * 0.55) }));
})();

/*
 * Auth backdrop curtains, mirroring AURORA_FRAG: a zest curtain rising on the left (turning towards
 * aura as it rises) with a thin flare lower border, and an aura -> volt curtain low on the right
 * behind the core. Coordinates are units of the shorter side, y down; one blur softens everything.
 */
function AuroraLayer({ id }: { id: string }) {
  return (
    <svg viewBox="-0.5 -0.5 1 1" preserveAspectRatio="xMidYMid meet" width="100%" height="100%" overflow="visible">
      <defs>
        <filter id={`${id}-blur`} filterUnits="userSpaceOnUse" x="-2" y="-1.5" width="4" height="3">
          <feGaussianBlur stdDeviation="0.02" />
        </filter>
        <filter id={`${id}-soft`} filterUnits="userSpaceOnUse" x="-2" y="-1.5" width="4" height="3">
          <feGaussianBlur stdDeviation="0.004" />
        </filter>
        <linearGradient id={`${id}-left-color`} gradientUnits="userSpaceOnUse" x1="-0.75" y1="0.15" x2="0" y2="-0.45">
          <stop offset="0" stopColor={zest} />
          <stop offset="0.35" stopColor={zest} />
          <stop offset="1" stopColor={aura} />
        </linearGradient>
        <linearGradient id={`${id}-right-color`} gradientUnits="userSpaceOnUse" x1="-0.3" y1="0" x2="0.9" y2="0">
          <stop offset="0" stopColor={aura} />
          <stop offset="0.45" stopColor={aura} />
          <stop offset="1" stopColor={volt} />
        </linearGradient>
        {/* Rise: from just under each curtain's base line up along its normal, bright at the base. */}
        {[
          { key: 'left', x1: -0.63, y1: 0.12, x2: -0.85, y2: -0.86 },
          { key: 'right', x1: 0.5, y1: 0.39, x2: 0.6, y2: -0.6 },
        ].map((r) => (
          <linearGradient key={r.key} id={`${id}-${r.key}-rise-alpha`} gradientUnits="userSpaceOnUse" x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2}>
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.04" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="0.25" stopColor="#fff" stopOpacity="0.45" />
            <stop offset="0.55" stopColor="#fff" stopOpacity="0.12" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        ))}
        <linearGradient id={`${id}-left-fade`} gradientUnits="userSpaceOnUse" x1="-0.2" y1="0" x2="0.25" y2="0">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-right-fade`} gradientUnits="userSpaceOnUse" x1="-0.35" y1="0" x2="0.1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id={`${id}-fringe-fade`} gradientUnits="userSpaceOnUse" x1="-0.55" y1="0" x2="-0.1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-rays`} maskUnits="userSpaceOnUse" x="-2" y="-1.5" width="4" height="3">
          {RAYS.map((ray) => (
            <rect key={ray.x} x={ray.x} y="-1.5" width={ray.w} height="3" fill="#fff" opacity={ray.o} />
          ))}
        </mask>
        <mask id={`${id}-left-mask`} maskUnits="userSpaceOnUse" x="-2" y="-1.5" width="4" height="3">
          <rect x="-2" y="-1.5" width="4" height="3" fill={`url(#${id}-left-fade)`} />
        </mask>
        <mask id={`${id}-right-mask`} maskUnits="userSpaceOnUse" x="-2" y="-1.5" width="4" height="3">
          <rect x="-2" y="-1.5" width="4" height="3" fill={`url(#${id}-right-fade)`} />
        </mask>
        <mask id={`${id}-left-rise`} maskUnits="userSpaceOnUse" x="-2" y="-1.5" width="4" height="3">
          <path d="M-1.6 0.32 C-1 0.2 -0.5 0.1 0.3 -0.12 L0.3 -1.5 L-1.6 -1.5 Z" fill={`url(#${id}-left-rise-alpha)`} />
        </mask>
        <mask id={`${id}-right-rise`} maskUnits="userSpaceOnUse" x="-2" y="-1.5" width="4" height="3">
          <path d="M-0.5 0.29 Q0.3 0.33 1.6 0.52 L1.6 -1.5 L-0.5 -1.5 Z" fill={`url(#${id}-right-rise-alpha)`} />
        </mask>
        <mask id={`${id}-fringe-mask`} maskUnits="userSpaceOnUse" x="-2" y="-1.5" width="4" height="3">
          <rect x="-2" y="-1.5" width="4" height="3" fill={`url(#${id}-fringe-fade)`} />
        </mask>
      </defs>
      <g filter={`url(#${id}-blur)`}>
        <g mask={`url(#${id}-left-mask)`}>
          <g mask={`url(#${id}-rays)`}>
            <rect x="-2" y="-1.5" width="4" height="3" fill={`url(#${id}-left-color)`} mask={`url(#${id}-left-rise)`} />
          </g>
        </g>
        <g mask={`url(#${id}-right-mask)`}>
          <g mask={`url(#${id}-rays)`}>
            <rect x="-2" y="-1.5" width="4" height="3" fill={`url(#${id}-right-color)`} mask={`url(#${id}-right-rise)`} />
          </g>
        </g>
      </g>
      <path d="M-1.6 0.326 C-1 0.206 -0.5 0.106 0.3 -0.114 L0.3 -0.09 C-0.5 0.13 -1 0.23 -1.6 0.35 Z" fill={flare} filter={`url(#${id}-soft)`} mask={`url(#${id}-fringe-mask)`} />
    </svg>
  );
}

/* A clockwise arc on the core's rim between two angles (radians, SVG y-down). */
function rimArc(core: PosterGeometry['core'], from: number, to: number, scale = 1): string {
  const r = r3(core.r * scale);
  const at = (a: number) => `${r3(core.cx + r * Math.cos(a))} ${r3(core.cy + r * Math.sin(a))}`;
  return `M${at(from)}A${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${at(to)}`;
}

/* The calm core (auth, tile): volt-tinted centre, teal mid, bright aura -> ice rim, ice contours, flare rim glints. */
function CalmCore({ id, geometry: g }: { id: string; geometry: PosterGeometry }) {
  const { core } = g;
  return (
    <>
      <defs>
        {/* Body sampled from the WebGL frame: volt-tinted centre, teal mid, bright aura -> ice rim. */}
        <radialGradient id={`${id}-core`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#4a7cc0" />
          <stop offset="0.25" stopColor="#3a98bd" />
          <stop offset="0.5" stopColor="#12879a" />
          <stop offset="0.74" stopColor="#0d8f9f" />
          <stop offset="0.86" stopColor="#05a8b7" />
          <stop offset="0.93" stopColor={aura} />
          <stop offset="0.975" stopColor="#8ff7ff" />
          <stop offset="1" stopColor={aura} />
        </radialGradient>
        <clipPath id={`${id}-core-clip`}>
          <circle cx={core.cx} cy={core.cy} r={core.r} />
        </clipPath>
        <filter id={`${id}-pool-blur`} x="-0.5" y="-0.5" width="2" height="2">
          <feGaussianBlur stdDeviation="0.05" />
        </filter>
      </defs>
      <circle cx={core.cx} cy={core.cy} r={core.r} fill={`url(#${id}-core)`} />
      <g clipPath={`url(#${id}-core-clip)`}>
        <g filter={`url(#${id}-pool-blur)`}>
          {g.contours.map((c, i) => (c.pool ? <path key={i} d={c.d} fill={volt} opacity="0.55" /> : null))}
        </g>
        {g.contours.map((c, i) => (
          <path key={i} d={c.d} fill="none" stroke={ice} strokeWidth="1.3" opacity="0.6" vectorEffect="non-scaling-stroke" />
        ))}
      </g>
      <g fill="none" stroke={flare} strokeWidth="2.4" strokeLinecap="round">
        <path d={rimArc(core, 0.55, 1.25)} vectorEffect="non-scaling-stroke" />
        <path d={rimArc(core, -1.2, -0.85)} vectorEffect="non-scaling-stroke" />
      </g>
    </>
  );
}

/* The displaced silhouette of the vivid core: a few low harmonics, like the shader's noise at rest. */
const wobble = (a: number) => 1 + 0.034 * Math.sin(3 * a + 0.7) + 0.022 * Math.sin(5 * a + 2.1) + 0.012 * Math.sin(7 * a + 4.4);

function wobblePoints(core: PosterGeometry['core'], from: number, to: number, scale = 1): Point[] {
  const steps = Math.max(8, Math.round(((to - from) / (Math.PI * 2)) * 120));
  return Array.from({ length: steps + 1 }, (_, i): Point => {
    const a = from + ((to - from) * i) / steps;
    const k = core.r * scale * wobble(a);
    return [core.cx + Math.cos(a) * k, core.cy + Math.sin(a) * k];
  });
}

/*
 * The vivid hero core, matching CORE_FRAG at energy 1: deep volt valleys under an aura body, ice
 * crests, contour bands in the zest -> aura -> ice sheen with white-hot lines, a hot centre, and the
 * silhouette fringe: flare on the upper right (meeting only ice), zest on the lower left, ice between.
 */
function VividCore({ id, geometry: g }: { id: string; geometry: PosterGeometry }) {
  const { core } = g;
  const sheen = [ice, zest, aura, ice, aura, zest];
  const outline = pathOf(wobblePoints(core, 0, Math.PI * 2), true);
  const arc = (from: number, to: number, scale = 1) => pathOf(wobblePoints(core, from, to, scale));
  return (
    <>
      <defs>
        <radialGradient id={`${id}-core`} cx="0.44" cy="0.42" r="0.6">
          <stop offset="0" stopColor="#3b78e6" />
          <stop offset="0.3" stopColor="#2a73cf" />
          <stop offset="0.55" stopColor="#0f8fb6" />
          <stop offset="0.72" stopColor="#06a9c4" />
          <stop offset="0.82" stopColor="#14cbe0" />
          <stop offset="0.9" stopColor={ice} />
          <stop offset="1" stopColor={aura} />
        </radialGradient>
        <radialGradient id={`${id}-hot`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.7" />
          <stop offset="0.35" stopColor={ice} stopOpacity="0.28" />
          <stop offset="1" stopColor={ice} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-shade`} x1="0.2" y1="0.1" x2="0.85" y2="0.95">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.12" />
          <stop offset="0.55" stopColor="#000000" stopOpacity="0" />
          <stop offset="1" stopColor={bg} stopOpacity="0.35" />
        </linearGradient>
        <clipPath id={`${id}-core-clip`}>
          <path d={outline} />
        </clipPath>
        <filter id={`${id}-pool-blur`} x="-0.5" y="-0.5" width="2" height="2">
          <feGaussianBlur stdDeviation="0.06" />
        </filter>
        <filter id={`${id}-line-glow`} x="-0.5" y="-0.5" width="2" height="2">
          <feGaussianBlur stdDeviation="0.025" />
        </filter>
        <filter id={`${id}-fringe-glow`} x="-0.5" y="-0.5" width="2" height="2">
          <feGaussianBlur stdDeviation="0.04" />
        </filter>
      </defs>
      <path d={outline} fill={`url(#${id}-core)`} />
      <g clipPath={`url(#${id}-core-clip)`}>
        <g filter={`url(#${id}-pool-blur)`}>
          {g.contours.map((c, i) => (c.pool ? <path key={i} d={c.d} fill={volt} opacity="0.7" /> : null))}
        </g>
        <g filter={`url(#${id}-line-glow)`} fill="none" strokeWidth="5" opacity="0.55">
          {g.contours.map((c, i) => (
            <path key={i} d={c.d} stroke={sheen[i % sheen.length]} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        {g.contours.map((c, i) => (
          <path key={i} d={c.d} fill="none" stroke="#f4feff" strokeWidth={i % 2 === 0 ? 1.6 : 1.1} opacity="0.85" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={outline} fill={`url(#${id}-shade)`} />
        <circle cx={r3(core.cx - core.r * 0.08)} cy={r3(core.cy - core.r * 0.06)} r={r3(core.r * 0.55)} fill={`url(#${id}-hot)`} />
      </g>
      <g fill="none" strokeLinecap="round" filter={`url(#${id}-fringe-glow)`}>
        <path d={outline} stroke={aura} strokeWidth="5" opacity="0.6" vectorEffect="non-scaling-stroke" />
        <path d={arc(-1.45, 0.75, 0.985)} stroke={flare} strokeWidth="9" opacity="0.8" vectorEffect="non-scaling-stroke" />
        <path d={arc(1.95, 3.45, 0.985)} stroke={zest} strokeWidth="9" opacity="0.7" vectorEffect="non-scaling-stroke" />
      </g>
      <g fill="none" strokeLinecap="round">
        <path d={outline} stroke={ice} strokeWidth="1.4" opacity="0.9" vectorEffect="non-scaling-stroke" />
        <path d={arc(-1.3, 0.6)} stroke={flare} strokeWidth="2.6" vectorEffect="non-scaling-stroke" />
        <path d={arc(2.05, 3.35)} stroke={zest} strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
      </g>
    </>
  );
}

export function AuraPoster({ preset, className }: { preset: AuraPreset; className?: string }) {
  const g = GEOMETRY[preset];
  const id = `aura-poster-${preset}`;
  return (
    <svg className={className} aria-hidden="true" focusable="false" data-aura-poster={preset}>
      {preset === 'auth' ? <rect width="100%" height="100%" fill={bg} /> : null}
      {preset === 'auth' ? <AuroraLayer id={id} /> : null}
      <svg viewBox={g.viewBox} preserveAspectRatio="xMidYMid meet" width="100%" height="100%" overflow="visible">
        <defs>
          {/* Halo falloff measured on the WebGL frame: aura at about 21% just outside the core, gone by 1.45 r;
              the vivid hero core (haloGain 1.45) burns brighter, with an ice inner ring. */}
          <radialGradient id={`${id}-halo`}>
            {g.energy > 0 ? (
              <>
                <stop offset="0.6" stopColor={ice} stopOpacity="0.7" />
                <stop offset="0.66" stopColor={aura} stopOpacity="0.42" />
                <stop offset="0.76" stopColor={aura} stopOpacity="0.16" />
                <stop offset="0.88" stopColor={volt} stopOpacity="0.07" />
                <stop offset="1" stopColor={volt} stopOpacity="0" />
              </>
            ) : (
              <>
                <stop offset="0.62" stopColor={aura} stopOpacity="0.42" />
                <stop offset="0.7" stopColor={aura} stopOpacity="0.22" />
                <stop offset="0.8" stopColor={volt} stopOpacity="0.12" />
                <stop offset="0.9" stopColor={volt} stopOpacity="0.05" />
                <stop offset="1" stopColor={volt} stopOpacity="0" />
              </>
            )}
          </radialGradient>
          {g.nodes.map((n, i) => (
            <radialGradient key={i} id={`${id}-node-${i}`}>
              <stop offset="0.15" stopColor={n.color} stopOpacity="0.9" />
              <stop offset="0.55" stopColor={n.color} stopOpacity="0.3" />
              <stop offset="1" stopColor={n.color} stopOpacity="0" />
            </radialGradient>
          ))}
        </defs>
        <circle cx={g.core.cx} cy={g.core.cy} r={r3(g.core.r * 1.6)} fill={`url(#${id}-halo)`} />
        <g fill="none" strokeLinecap="round">
          {g.rings.map((ring, i) => (
            <path key={i} d={ring.back} stroke={ring.color} strokeWidth="1.8" strokeDasharray="0.1 4" opacity="0.32" vectorEffect="non-scaling-stroke" />
          ))}
          {g.streams.map((s, i) => (
            <path key={i} d={s.d} stroke={s.color} strokeWidth="1.6" strokeDasharray="7 11" opacity="0.75" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        {g.dust.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={d.color} opacity={d.opacity} />
        ))}
        {g.energy > 0 ? <VividCore id={id} geometry={g} /> : <CalmCore id={id} geometry={g} />}
        <g fill="none" strokeLinecap="round">
          {g.rings.map((ring, i) => (
            <path key={i} d={ring.front} stroke={ring.color} strokeWidth="1.8" strokeDasharray="0.1 4" opacity="0.5" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        {g.packets.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={p.r} fill={p.color} opacity={p.opacity} />
        ))}
        {g.nodes.map((n, i) => (
          <g key={i}>
            <circle cx={n.x} cy={n.y} r="0.3" fill={`url(#${id}-node-${i})`} />
            <rect x={r3(n.x - 0.075)} y={r3(n.y - 0.075)} width="0.15" height="0.15" fill={n.color} transform={`rotate(45 ${n.x} ${n.y})`} />
          </g>
        ))}
      </svg>
    </svg>
  );
}
