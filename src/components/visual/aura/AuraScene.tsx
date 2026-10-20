'use client';

/*
 * The AuraLead WebGL scene (design spec §0.7, §3): a noise-displaced energy core with fake-bloom
 * halos, GPU particle orbits and, per preset, the hero's lead streams (sources in, quote and WhatsApp
 * out) or the auth page's aurora. Layout and colors come from aura-layout.ts, the same data the SVG
 * poster projects. Reached only through next/dynamic({ ssr: false }) in AuraVisual.tsx, so no page
 * bundles three eagerly. Decorative only (aria-hidden, no data, no text) and procedural only (no
 * textures, HDRIs or fonts; drei helpers that fetch from the network are not used).
 * React Compiler rules: three objects change only through refs inside useFrame, uniforms are plain
 * useMemo objects handed to JSX materials, and nothing sets state in an effect body.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Float, QuadraticBezierLine, ScreenQuad, Sparkles, type QuadraticBezierLineRef } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { mulberry32 } from '../prng';
import {
  AURA_CAMERA,
  AURA_COLORS,
  AURA_HALOS,
  AURA_ORBITS,
  AURA_PRESETS,
  AURA_STREAMS,
  TIER_BUDGET,
  fitScale,
  streamAnchor,
  type AuraPreset,
  type AuraPresetConfig,
  type AuraStream,
  type AuraTier,
  type OrbitConfig,
} from './aura-layout';
import {
  AURORA_FRAG,
  AURORA_VERT,
  CORE_FRAG,
  CORE_VERT,
  HALO_FRAG,
  HALO_VERT,
  ORBIT_FRAG,
  ORBIT_VERT,
  PACKET_FRAG,
  PACKET_VERT,
} from './aura-glsl';

/*
 * R3F 9.8.2 still constructs THREE.Clock, which three r183+ deprecates with one console warning per
 * Canvas mount. Drop exactly that line and pass everything else through (remove once R3F moves to
 * THREE.Timer).
 */
type ConsoleFn = Parameters<typeof THREE.setConsoleFunction>[0];
const CLOCK_DEPRECATION = 'THREE.Clock: This module has been deprecated';
const previousConsole: ConsoleFn | null = THREE.getConsoleFunction();
THREE.setConsoleFunction((type, message, ...params) => {
  if (type === 'warn' && typeof message === 'string' && message.startsWith(CLOCK_DEPRECATION)) return;
  if (previousConsole) previousConsole(type, message, ...params);
  else console[type](message, ...params);
});

type Num = THREE.IUniform<number>;
type TimedMaterial = THREE.ShaderMaterial & { uniforms: { uTime: Num; uReveal?: Num; uPixelRatio?: Num } };

/* Time advances by a clamped dt, so resuming after frameloop 'never' or a hidden tab never jumps. */
const MAX_DT = 1 / 20;
/* Intro "ignite": 0 -> 1 over about 2 s, derived from each material's own clock (no shared state). */
const reveal = (t: number) => 1 - Math.exp(-1.6 * t);

function useShaderClock(ref: RefObject<TimedMaterial | null>) {
  useFrame((state, dt) => {
    const m = ref.current;
    if (!m) return;
    m.uniforms.uTime.value += Math.min(dt, MAX_DT);
    if (m.uniforms.uReveal) m.uniforms.uReveal.value = reveal(m.uniforms.uTime.value);
    if (m.uniforms.uPixelRatio) m.uniforms.uPixelRatio.value = state.viewport.dpr;
  });
}

/* Frees a useMemo'd geometry when it is replaced (tier change) or unmounted; R3F only disposes JSX children. */
function useDisposable(geometry: THREE.BufferGeometry) {
  useEffect(() => () => geometry.dispose(), [geometry]);
}

type CoreLook = AuraPresetConfig['core'];

function AuraCore({ detail, look }: { detail: number; look: CoreLook }) {
  const { amp, freq, flow, energy } = look;
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<TimedMaterial & { uniforms: { uPulse: Num } }>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmp: { value: amp },
      uFreq: { value: freq },
      uFlow: { value: flow },
      uEnergy: { value: energy },
      uReveal: { value: 0 },
      uPulse: { value: 0 },
      uAura: { value: new THREE.Color(AURA_COLORS.aura) },
      uIce: { value: new THREE.Color(AURA_COLORS.ice) },
      uVolt: { value: new THREE.Color(AURA_COLORS.volt) },
      uFlare: { value: new THREE.Color(AURA_COLORS.flare) },
      uZest: { value: new THREE.Color(AURA_COLORS.zest) },
    }),
    [amp, freq, flow, energy],
  );
  useShaderClock(matRef);
  useFrame(() => {
    const m = matRef.current;
    const mesh = meshRef.current;
    if (!m || !mesh) return;
    const t = m.uniforms.uTime.value;
    /* The hero's hot centre beats (a quick swell, a slow fade); the calm look breathes. */
    const beat = Math.pow(0.5 + 0.5 * Math.sin(t * 2.2), energy > 0 ? 3 : 1);
    m.uniforms.uPulse.value = beat;
    mesh.rotation.y = t * (0.12 + 0.06 * energy);
    mesh.scale.setScalar(THREE.MathUtils.lerp(0.86, 1, reveal(t)));
  });
  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1, detail]} />
      <shaderMaterial ref={matRef} vertexShader={CORE_VERT} fragmentShader={CORE_FRAG} uniforms={uniforms} />
    </mesh>
  );
}

/* Additive back-face fresnel shell: the "bloom" without a postprocessing pass. */
function AuraHalo(props: { scale: number; power: number; intensity: number; a: string; b: string; segments?: number }) {
  const { scale, power, intensity, a, b, segments = 48 } = props;
  const matRef = useRef<TimedMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: intensity },
      uPower: { value: power },
      uColorA: { value: new THREE.Color(a) },
      uColorB: { value: new THREE.Color(b) },
    }),
    [a, b, intensity, power],
  );
  useShaderClock(matRef);
  return (
    <mesh scale={scale}>
      <sphereGeometry args={[1, segments, Math.round(segments * 0.66)]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={HALO_VERT}
        fragmentShader={HALO_FRAG}
        uniforms={uniforms}
        side={THREE.BackSide}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

/* Particles whose positions the GPU computes from (radius, angle, height): zero CPU per frame. */
function OrbitPoints({ orbit, count, rMax, seed }: { orbit: OrbitConfig; count: number; rMax: number; seed: number }) {
  const { rMin, height, speed } = orbit;
  const matRef = useRef<TimedMaterial>(null);
  const geometry = useMemo(() => {
    const rnd = mulberry32(seed);
    const attr = {
      aRadius: new Float32Array(count),
      aAngle: new Float32Array(count),
      aHeight: new Float32Array(count),
      aSpeed: new Float32Array(count),
      aScale: new Float32Array(count),
      aMix: new Float32Array(count),
    };
    for (let i = 0; i < count; i++) {
      const u = Math.pow(rnd(), 1.6);
      attr.aRadius[i] = rMin + (rMax - rMin) * u;
      attr.aAngle[i] = rnd() * Math.PI * 2;
      attr.aHeight[i] = (rnd() - 0.5) * height * (1 - u * 0.6);
      attr.aSpeed[i] = speed * (0.6 + rnd() * 0.8);
      attr.aScale[i] = 0.4 + Math.pow(rnd(), 3) * 1.6;
      attr.aMix[i] = rnd();
    }
    const g = new THREE.BufferGeometry();
    /* three needs a position attribute for the draw range; the shader computes the real position. */
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    for (const [name, arr] of Object.entries(attr)) g.setAttribute(name, new THREE.BufferAttribute(arr, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax + height);
    return g;
  }, [count, rMin, rMax, height, speed, seed]);
  useDisposable(geometry);
  const [colorA, colorB] = orbit.colors;
  const [sparkA, sparkB] = orbit.sparks ?? orbit.colors;
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uSize: { value: orbit.size },
      uReveal: { value: 0 },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
      uSparkA: { value: new THREE.Color(sparkA) },
      uSparkB: { value: new THREE.Color(sparkB) },
      uSparkRatio: { value: orbit.sparks ? 0.03 : 0 },
    }),
    [orbit.size, orbit.sparks, colorA, colorB, sparkA, sparkB],
  );
  useShaderClock(matRef);
  return (
    <points geometry={geometry} rotation={orbit.rotation}>
      <shaderMaterial
        ref={matRef}
        vertexShader={ORBIT_VERT}
        fragmentShader={ORBIT_FRAG}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/* One drei line per stream with marching dashes. start/mid/end are module constants (drei memoizes on identity). */
function DashedStream({ stream }: { stream: AuraStream }) {
  const lineRef = useRef<QuadraticBezierLineRef>(null);
  const clockRef = useRef(0);
  useFrame((_, dt) => {
    const line = lineRef.current;
    if (!line) return;
    const d = Math.min(dt, MAX_DT);
    clockRef.current += d;
    line.material.dashOffset -= d * 0.5;
    line.material.opacity = 0.85 * reveal(clockRef.current);
  });
  /* `segments` is omitted on purpose: drei types it as number & boolean, so passing it fails tsc. */
  return (
    <QuadraticBezierLine
      ref={lineRef}
      start={stream.from}
      mid={stream.mid}
      end={stream.to}
      color={stream.color}
      lineWidth={2}
      dashed
      dashSize={0.06}
      gapSize={0.1}
      transparent
      opacity={0}
      depthWrite={false}
      toneMapped={false}
      blending={THREE.AdditiveBlending}
    />
  );
}

/* Lead packets: every point rides its own jittered bezier in the vertex shader, one draw call in all. */
function LeadStreams({ perStream, seed }: { perStream: number; seed: number }) {
  const matRef = useRef<TimedMaterial>(null);
  const geometry = useMemo(() => {
    const rnd = mulberry32(seed);
    const n = AURA_STREAMS.length * perStream;
    const p0 = new Float32Array(n * 3);
    const p1 = new Float32Array(n * 3);
    const p2 = new Float32Array(n * 3);
    const offset = new Float32Array(n);
    const speed = new Float32Array(n);
    const color = new Float32Array(n * 3);
    const c = new THREE.Color();
    AURA_STREAMS.forEach((s, si) => {
      c.set(s.color);
      for (let k = 0; k < perStream; k++) {
        const i = si * perStream + k;
        const jitter = () => (rnd() - 0.5) * 0.18;
        p0.set([s.from[0] + jitter(), s.from[1] + jitter(), s.from[2] + jitter()], i * 3);
        p1.set([s.mid[0] + jitter() * 2, s.mid[1] + jitter() * 2, s.mid[2] + jitter() * 2], i * 3);
        p2.set(s.to, i * 3);
        offset[i] = rnd();
        speed[i] = s.speed * (0.85 + rnd() * 0.3);
        color.set([c.r, c.g, c.b], i * 3);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aP0', new THREE.BufferAttribute(p0, 3));
    g.setAttribute('aP1', new THREE.BufferAttribute(p1, 3));
    g.setAttribute('aP2', new THREE.BufferAttribute(p2, 3));
    g.setAttribute('aOffset', new THREE.BufferAttribute(offset, 1));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    return g;
  }, [perStream, seed]);
  useDisposable(geometry);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uPixelRatio: { value: 1 }, uSize: { value: 96 }, uReveal: { value: 0 } }), []);
  useShaderClock(matRef);
  return (
    <group>
      {AURA_STREAMS.map((s) => (
        <DashedStream key={s.key} stream={s} />
      ))}
      <points geometry={geometry}>
        <shaderMaterial
          ref={matRef}
          vertexShader={PACKET_VERT}
          fragmentShader={PACKET_FRAG}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      {AURA_STREAMS.map((s) => (
        <Float key={`node-${s.key}`} speed={1.4} rotationIntensity={0.6} floatIntensity={0.5} position={streamAnchor(s)}>
          <mesh>
            <octahedronGeometry args={[0.11, 0]} />
            <meshBasicMaterial color={s.color} toneMapped={false} />
          </mesh>
          <AuraHalo scale={0.3} power={2.4} intensity={1.0} a={s.color} b={s.color} segments={20} />
        </Float>
      ))}
    </group>
  );
}

/* Full-screen aurora behind the auth core: one ScreenQuad in the same canvas (one GL context). */
function AuroraQuad() {
  const matRef = useRef<TimedMaterial & { uniforms: { uAspect: THREE.IUniform<THREE.Vector2> } }>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAspect: { value: new THREE.Vector2(1, 1) },
      uBg: { value: new THREE.Color(AURA_COLORS.bg) },
      uZest: { value: new THREE.Color(AURA_COLORS.zest) },
      uAura: { value: new THREE.Color(AURA_COLORS.aura) },
      uVolt: { value: new THREE.Color(AURA_COLORS.volt) },
      uFlare: { value: new THREE.Color(AURA_COLORS.flare) },
    }),
    [],
  );
  useShaderClock(matRef);
  useFrame((state) => {
    const m = matRef.current;
    if (!m) return;
    const a = state.size.width / Math.max(1, state.size.height);
    m.uniforms.uAspect.value.set(Math.max(1, a), Math.max(1, 1 / a));
  });
  return (
    <ScreenQuad renderOrder={-1}>
      <shaderMaterial ref={matRef} vertexShader={AURORA_VERT} fragmentShader={AURORA_FRAG} uniforms={uniforms} depthWrite={false} depthTest={false} />
    </ScreenQuad>
  );
}

/* Dolly-in to the resting distance plus pointer parallax: one passive window listener, damped in useFrame. */
function Rig({ strength, distance }: { strength: number; distance: number }) {
  const targetRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      targetRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      targetRef.current.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);
  useFrame((state, dt) => {
    const d = Math.min(dt, MAX_DT);
    const cam = state.camera;
    cam.position.x = THREE.MathUtils.damp(cam.position.x, targetRef.current.x * strength, 2.5, d);
    cam.position.y = THREE.MathUtils.damp(cam.position.y, -targetRef.current.y * strength * 0.6, 2.5, d);
    cam.position.z = THREE.MathUtils.damp(cam.position.z, distance, 1.2, d);
    cam.lookAt(0, 0, 0);
  });
  return null;
}

function AuraContent({ preset, tier, seed = 7 }: { preset: AuraPreset; tier: AuraTier; seed?: number }) {
  const config = AURA_PRESETS[preset];
  const budget = TIER_BUDGET[tier];
  /* Fit to the width visible at the resting distance, not the dolly start, so side nodes never clip. */
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const fit = fitScale(preset, aspect);
  return (
    <>
      {config.aurora ? <AuroraQuad /> : null}
      <group scale={fit}>
        <group position={config.core.position} scale={config.core.scale}>
          <AuraCore detail={budget.detail} look={config.core} />
          {AURA_HALOS.map((h) => (
            <AuraHalo key={h.scale} scale={h.scale} power={h.power} intensity={h.intensity * config.haloGain} a={h.colors[0]} b={h.colors[1]} />
          ))}
          {AURA_ORBITS.map((o) => (
            <OrbitPoints
              key={o.seedOffset}
              orbit={o}
              count={o.kind === 'dust' ? budget.dust : budget.ring}
              rMax={o.rMax ?? config.dustRadius}
              seed={seed + o.seedOffset}
            />
          ))}
          <Sparkles count={budget.sparkles} scale={[6, 4, 3]} size={2.4} speed={0.35} opacity={0.8} color={AURA_COLORS.ice} noise={0.6} />
        </group>
        {config.streams ? <LeadStreams perStream={budget.packetsPerStream} seed={seed + 9} /> : null}
      </group>
      {config.parallax > 0 ? <Rig strength={config.parallax} distance={config.restZ} /> : null}
    </>
  );
}

/* frameloop 'demand' invalidated on a timer: at most `fps` frames a second (the dashboard tile). */
function FrameCap({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const id = window.setInterval(() => invalidate(), 1000 / fps);
    return () => window.clearInterval(id);
  }, [fps, invalidate]);
  return null;
}

/*
 * Watches the frame rate in 2 s windows; two slow windows in a row call onSlow once. AuraCanvas uses
 * it to step 'high' down to 'low', and to give up a 'low' scene for the poster (software GL or a weak
 * GPU can crawl at a few fps and burn the CPU for a decorative effect).
 */
function PerfGuard({ minFps, onSlow }: { minFps: number; onSlow: () => void }) {
  const statsRef = useRef({ frames: 0, seconds: 0, strikes: 0, done: false });
  useFrame((_, dt) => {
    const s = statsRef.current;
    /* The first frame after a pause carries the whole pause in dt: skip it. */
    if (s.done || dt > 1) return;
    s.frames += 1;
    s.seconds += dt;
    if (s.seconds < 2) return;
    s.strikes = s.frames / s.seconds < minFps ? s.strikes + 1 : 0;
    s.frames = 0;
    s.seconds = 0;
    if (s.strikes < 2) return;
    s.done = true;
    onSlow();
  });
  return null;
}

/* Tells the shell the first frame is on screen, so the poster fades only once there is something under it. */
function FirstFrame({ onReady }: { onReady: () => void }) {
  const doneRef = useRef(false);
  useFrame(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onReady();
  });
  return null;
}

export type AuraCanvasProps = {
  preset: AuraPreset;
  tier: AuraTier;
  /** false stops the frame loop (offscreen or hidden tab); true resumes without a time jump. */
  active: boolean;
  /** The first frame is on screen. */
  onReady: () => void;
  /** WebGL is unusable here (context lost, or too slow even on the low tier): show the poster for good. */
  onFallback: () => void;
};

export function AuraCanvas({ preset, tier, active, onReady, onFallback }: AuraCanvasProps) {
  const config = AURA_PRESETS[preset];
  const [slow, setSlow] = useState(false);
  const effectiveTier: AuraTier = slow ? 'low' : tier;
  const loop = config.fpsCap === null ? 'always' : 'demand';
  /* Low-tier floor: below 10 fps (half the cap for a capped preset) the scene no longer reads as motion. */
  const lowFloor = config.fpsCap === null ? 10 : config.fpsCap / 2;
  return (
    <Canvas
      aria-hidden
      style={{ pointerEvents: 'none' }}
      dpr={[1, effectiveTier === 'high' ? config.maxDpr : 1]}
      flat
      frameloop={active ? loop : 'never'}
      camera={{ position: [0, 0, config.startZ], fov: AURA_CAMERA.fov, near: AURA_CAMERA.near, far: AURA_CAMERA.far }}
      gl={{ antialias: tier === 'high', alpha: !config.aurora, powerPreference: 'default', stencil: false }}
      onCreated={({ gl }) => {
        gl.setClearColor(AURA_COLORS.bg, config.aurora ? 1 : 0);
        gl.domElement.addEventListener(
          'webglcontextlost',
          (event) => {
            event.preventDefault();
            onFallback();
          },
          { once: true },
        );
      }}
    >
      <AuraContent preset={preset} tier={effectiveTier} />
      {active && config.fpsCap !== null ? <FrameCap fps={config.fpsCap} /> : null}
      {effectiveTier === 'high' ? (
        <PerfGuard key="high" minFps={40} onSlow={() => setSlow(true)} />
      ) : (
        <PerfGuard key="low" minFps={lowFloor} onSlow={onFallback} />
      )}
      <FirstFrame onReady={onReady} />
    </Canvas>
  );
}
