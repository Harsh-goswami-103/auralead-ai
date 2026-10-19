/**
 * The AuraLead scene's shared layout (design spec §0.7, §3): palette, presets, camera, orbits and
 * lead streams in world units. The WebGL scene (AuraScene) builds from it and the SVG poster
 * (AuraPoster) projects it with the same camera at rest, so the crossfade from poster to canvas keeps
 * everything in place. Pure data and math: no three import, safe on the server and in unit tests.
 */

export type AuraPreset = 'hero' | 'auth' | 'tile';
export type AuraTier = 'high' | 'low';
export type Vec3 = [number, number, number];

/*
 * Scene colors as sRGB hex, the same values as src/styles/tokens.css (tests/unit/visual/aura-layout
 * .test.ts keeps them in sync). The ramp is volt (depth) -> aura -> ice (heat) -> flare (fringe): flare
 * only ever meets ice, never aura or volt directly, because blue or cyan mixed into pink reads as the
 * reserved AI violet. Status hues and the violet --ai token are absent by design.
 */
export const AURA_COLORS = {
  bg: '#060a13', // --bg-0
  aura: '#00e1f3',
  ice: '#d1f6fd',
  volt: '#4181ff',
  voltHi: '#5c94ff',
  flare: '#ff47c3',
  flareIce: '#ffcee4',
  zest: '#aff03c',
  maps: '#00d6ec', // --chart-1-hi: the Maps extension chip dot, so the 3D stream matches the DOM label
} as const;

export const AURA_CAMERA = { fov: 38, near: 0.1, far: 50 } as const;

export type AuraPresetConfig = {
  /** Below this viewport width the budget is 'off' and only the poster renders. */
  minWidth: number;
  maxTier: AuraTier;
  maxDpr: number;
  /** null: frameloop 'always'; a number: frameloop 'demand' invalidated at most this often. */
  fpsCap: number | null;
  /** Camera distance on the first frame (the dolly-in starts here) and at rest. */
  startZ: number;
  restZ: number;
  /** World width that must stay visible at rest; on narrower boxes the whole scene scales down. */
  frameWidth: number;
  core: { position: Vec3; scale: number };
  dustRadius: number;
  streams: boolean;
  aurora: boolean;
  /** Pointer parallax strength in world units (0: no camera rig). */
  parallax: number;
};

export const AURA_PRESETS: Record<AuraPreset, AuraPresetConfig> = {
  hero: {
    minWidth: 768,
    maxTier: 'high',
    maxDpr: 1.5,
    fpsCap: null,
    startZ: 7.9,
    restZ: 7,
    frameWidth: 6.6,
    core: { position: [0, 0, 0], scale: 1 },
    dustRadius: 3.2,
    streams: true,
    aurora: false,
    parallax: 0.45,
  },
  /* Login and invite: full-bleed aurora with the core off-centre right, clear of the card. */
  auth: {
    minWidth: 1024,
    maxTier: 'high',
    maxDpr: 1.25,
    fpsCap: null,
    startZ: 7.9,
    restZ: 7,
    frameWidth: 6,
    core: { position: [1.6, -0.3, 0], scale: 1 },
    dustRadius: 3.2,
    streams: false,
    aurora: true,
    parallax: 0.25,
  },
  /* Command-center tile: small, always the low tier, 24 fps, no rig. */
  tile: {
    minWidth: 1440,
    maxTier: 'low',
    maxDpr: 1,
    fpsCap: 24,
    startZ: 6.2,
    restZ: 6.2,
    frameWidth: 5.6,
    core: { position: [0, 0, 0], scale: 1.15 },
    dustRadius: 2.2,
    streams: false,
    aurora: false,
    parallax: 0,
  },
};

/* Particle budget per tier. high: 3400 + 3*600 + 5*70 + 60 = 5610 (<= 6000); low: 1100 + 3*200 + 5*24 + 24 = 1844 (<= 2000). */
export const TIER_BUDGET = {
  high: { detail: 48, dust: 3400, ring: 600, packetsPerStream: 70, sparkles: 60 },
  low: { detail: 20, dust: 1100, ring: 200, packetsPerStream: 24, sparkles: 24 },
} as const;

export type OrbitConfig = {
  kind: 'dust' | 'ring';
  rMin: number;
  /** null: the preset's dustRadius. */
  rMax: number | null;
  height: number;
  speed: number;
  size: number;
  colors: readonly [string, string];
  /** Rare bright particles (about 3% each) for punch. */
  sparks: readonly [string, string] | null;
  rotation: Vec3;
  seedOffset: number;
};

/* A dust disc plus three tilted rings: aura/ice close in, volt depth in the middle, zest outside. */
export const AURA_ORBITS: readonly OrbitConfig[] = [
  { kind: 'dust', rMin: 1.25, rMax: null, height: 0.9, speed: 0.35, size: 42, colors: [AURA_COLORS.aura, AURA_COLORS.ice], sparks: [AURA_COLORS.zest, AURA_COLORS.flare], rotation: [0.35, 0, 0.12], seedOffset: 0 },
  { kind: 'ring', rMin: 1.45, rMax: 1.55, height: 0.04, speed: 0.9, size: 70, colors: [AURA_COLORS.aura, AURA_COLORS.ice], sparks: null, rotation: [1.25, 0.2, 0.3], seedOffset: 1 },
  { kind: 'ring', rMin: 1.7, rMax: 1.78, height: 0.04, speed: -0.7, size: 64, colors: [AURA_COLORS.volt, AURA_COLORS.voltHi], sparks: null, rotation: [-0.9, 0.4, -0.5], seedOffset: 2 },
  { kind: 'ring', rMin: 2.0, rMax: 2.06, height: 0.03, speed: 0.5, size: 58, colors: [AURA_COLORS.zest, AURA_COLORS.aura], sparks: null, rotation: [0.2, 0.6, 1.4], seedOffset: 3 },
];

/* Additive back-face fresnel shells around the core (the bloom, without a postprocessing pass). */
export const AURA_HALOS = [
  { scale: 1.32, power: 2.6, intensity: 1.15, colors: [AURA_COLORS.aura, AURA_COLORS.ice] },
  { scale: 1.9, power: 3.5, intensity: 0.45, colors: [AURA_COLORS.volt, AURA_COLORS.aura] },
] as const;

export type AuraStreamKey = 'sheets' | 'meta' | 'maps' | 'quote' | 'whatsapp';
export type AuraStream = {
  key: AuraStreamKey;
  direction: 'in' | 'out';
  from: Vec3;
  mid: Vec3;
  to: Vec3;
  color: string;
  speed: number;
};

/*
 * Hero only. Inbound (left): Google Sheets, Meta Lead Ads, Maps extension -> core; outbound (right):
 * core -> Quote, WhatsApp. Colors follow src/components/patterns/source-style.ts so a DOM label next
 * to a node matches it. Meta (volt) and WhatsApp (flare) sit on opposite sides, so blue never
 * meets pink. Labels live in the DOM (icon + text), never in WebGL.
 */
export const AURA_STREAMS: readonly AuraStream[] = [
  { key: 'sheets', direction: 'in', from: [-2.7, 1.35, -0.3], mid: [-1.4, 1.5, 0.4], to: [-0.25, 0.2, 0.2], color: AURA_COLORS.zest, speed: 0.16 },
  { key: 'meta', direction: 'in', from: [-2.9, 0, 0.2], mid: [-1.6, -0.35, 0.6], to: [-0.3, 0, 0.25], color: AURA_COLORS.voltHi, speed: 0.19 },
  { key: 'maps', direction: 'in', from: [-2.7, -1.35, -0.2], mid: [-1.4, -1.5, 0.4], to: [-0.25, -0.2, 0.2], color: AURA_COLORS.maps, speed: 0.14 },
  { key: 'quote', direction: 'out', from: [0.3, 0.15, 0.25], mid: [1.5, 1.4, 0.4], to: [2.75, 0.85, -0.1], color: AURA_COLORS.aura, speed: 0.17 },
  { key: 'whatsapp', direction: 'out', from: [0.3, -0.15, 0.25], mid: [1.5, -1.4, 0.4], to: [2.75, -0.85, -0.1], color: AURA_COLORS.flare, speed: 0.15 },
];

export const streamAnchor = (s: AuraStream): Vec3 => (s.direction === 'in' ? s.from : s.to);

export function quadraticPoint(s: AuraStream, t: number): Vec3 {
  const it = 1 - t;
  const a = it * it;
  const b = 2 * it * t;
  const c = t * t;
  return [a * s.from[0] + b * s.mid[0] + c * s.to[0], a * s.from[1] + b * s.mid[1] + c * s.to[1], a * s.from[2] + b * s.mid[2] + c * s.to[2]];
}

/** Rotates like three's Euler order 'XYZ' (matrix Rx * Ry * Rz). */
export function rotateXYZ(v: Vec3, r: Vec3): Vec3 {
  const [sx, cx, sy, cy, sz, cz] = [Math.sin(r[0]), Math.cos(r[0]), Math.sin(r[1]), Math.cos(r[1]), Math.sin(r[2]), Math.cos(r[2])];
  const x1 = cz * v[0] - sz * v[1];
  const y1 = sz * v[0] + cz * v[1];
  const z1 = v[2];
  const x2 = cy * x1 + sy * z1;
  const z2 = -sy * x1 + cy * z1;
  return [x2, cx * y1 - sx * z2, sx * y1 + cx * z2];
}

/** Half the height visible at the focal plane (z = 0) with the camera at rest. */
export function restHalfHeight(preset: AuraPreset): number {
  return AURA_PRESETS[preset].restZ * Math.tan(((AURA_CAMERA.fov / 2) * Math.PI) / 180);
}

/** Scene scale for a box of this aspect: the frame width stays visible at rest (never above 1). */
export function fitScale(preset: AuraPreset, aspect: number): number {
  return Math.min(1, (2 * restHalfHeight(preset) * aspect) / AURA_PRESETS[preset].frameWidth);
}

/** The poster's viewBox, in world units at the focal plane: the frame width by the visible height. */
export function posterViewBox(preset: AuraPreset): [number, number, number, number] {
  const h = restHalfHeight(preset);
  const w = AURA_PRESETS[preset].frameWidth / 2;
  return [-w, -h, 2 * w, 2 * h];
}

/**
 * Projects a world point (scene group coordinates, before the fit scale) to poster coordinates with
 * the camera at rest: perspective onto the focal plane, y flipped for SVG. Points of the core group
 * pass `inCore` so the core's offset and scale apply first.
 */
export function projectRest(preset: AuraPreset, p: Vec3, inCore = false): [number, number] {
  const { core, restZ } = AURA_PRESETS[preset];
  const world: Vec3 = inCore
    ? [core.position[0] + p[0] * core.scale, core.position[1] + p[1] * core.scale, core.position[2] + p[2] * core.scale]
    : p;
  const s = restZ / (restZ - world[2]);
  return [world[0] * s, -world[1] * s];
}

/**
 * Where each hero stream's anchor node sits, as percentages of a box with the hero frame's aspect
 * (`heroAspect()`): page builders place the DOM labels (icon + text) beside these points.
 */
export function heroAspect(): number {
  const [, , w, h] = posterViewBox('hero');
  return w / h;
}

export function heroAnchors(): { key: AuraStreamKey; direction: 'in' | 'out'; left: number; top: number }[] {
  const [x0, y0, w, h] = posterViewBox('hero');
  return AURA_STREAMS.map((s) => {
    const [u, v] = projectRest('hero', streamAnchor(s));
    return { key: s.key, direction: s.direction, left: Number((((u - x0) / w) * 100).toFixed(2)), top: Number((((v - y0) / h) * 100).toFixed(2)) };
  });
}
