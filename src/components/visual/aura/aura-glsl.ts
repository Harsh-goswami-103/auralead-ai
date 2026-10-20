/*
 * GLSL for the AuraLead scene (AuraScene.tsx). Procedural only: no textures, HDRIs or fonts. Every
 * fragment shader ends with <colorspace_fragment> because the Canvas renders `flat` (no tone mapping
 * dulling the neon). Color rule from the Aurora palette: flare (pink) only ever blends with ice, never
 * straight into aura or volt, since cyan or blue mixed into pink reads as the reserved AI violet.
 * snoise is Ashima Arts / Ian McEwan simplex noise (MIT, https://github.com/ashima/webgl-noise),
 * copied verbatim with its header (THIRD_PARTY_NOTICES.md); the rest is original.
 */

export const SNOISE3 = /* glsl */ `
//
// Description : Array and textureless GLSL 2D/3D/4D simplex noise functions.
//      Author : Ian McEwan, Ashima Arts.
//     License : Copyright (C) 2011 Ashima Arts. All rights reserved.
//               Distributed under the MIT License. https://github.com/ashima/webgl-noise
//
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

/* Core: noise-displaced icosphere; normals rebuilt from two displaced neighbours. uFlow scales the drift speed. */
export const CORE_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uFreq;
uniform float uFlow;
uniform float uReveal;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying float vNoise;
${SNOISE3}
float field(vec3 p) {
  float t = uTime * uFlow;
  vec3 q = p * uFreq + vec3(0.0, t * 0.21, t * 0.13);
  return snoise(q) * 0.78 + snoise(q * 1.93 + 7.3) * 0.22;
}
vec3 displace(vec3 p) {
  vec3 n = normalize(p);
  return p + n * field(n) * uAmp * mix(0.4, 1.0, uReveal);
}
void main() {
  vec3 n = normalize(position);
  vec3 tangent = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 bitangent = normalize(cross(n, tangent));
  float e = 0.012;
  vec3 p0 = displace(position);
  vec3 p1 = displace(position + tangent * e);
  vec3 p2 = displace(position + bitangent * e);
  vec3 dn = normalize(cross(p1 - p0, p2 - p0));
  vNoise = field(n);
  vNormalV = normalize(normalMatrix * dn);
  vec4 mv = modelViewMatrix * vec4(p0, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

/*
 * Two looks share one program (no extra shader compile), blended by uEnergy (per preset).
 * Calm (0): aura with emissive crests and volt pooling in the valleys that face the camera (depth);
 * ice draws the contour bands and the hot centre. A broad aura fresnel glows over the face; ice and
 * flare live only on the outer rim, where a travelling sweep runs aura -> ice -> flare. Flare takes
 * the tightest rim (the silhouette), replaces the ice rim instead of adding to it and stays below
 * clipping, so the hot-pink fringe keeps its hue and never washes over aura or volt into violet.
 * Vivid (1, the landing hero): a key-lit aura body over deep volt valleys with ice crests; iso-bands
 * that travel across the surface as thin white-hot lines inside soft glows colored by a zest -> aura
 * -> ice sheen; bright veins on the crests; a hot centre that pulses; and a fringe that turns slowly
 * around the silhouette: zest on one side, flare on the other, ice between them. Flare stays out of
 * the body (it would meet the volt valleys) and dims the aura rim under it: pink over cyan or blue
 * reads as the reserved AI violet.
 */
export const CORE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform float uEnergy;
uniform vec3 uAura;
uniform vec3 uIce;
uniform vec3 uVolt;
uniform vec3 uFlare;
uniform vec3 uZest;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying float vNoise;
vec3 sheen(float x) {
  x = abs(fract(x) * 2.0 - 1.0);
  return mix(mix(uZest, uAura, smoothstep(0.0, 0.45, x)), uIce, smoothstep(0.55, 1.0, x));
}
vec3 calmCore(float facing, float fres, float crest) {
  float depth = smoothstep(0.55, 0.9, facing);
  float pool = (1.0 - smoothstep(0.15, 0.6, crest)) * depth;
  vec3 body = mix(uAura, uVolt, pool);
  float glowCrest = smoothstep(0.7, 1.0, crest) * facing;
  float phase = fract(vNoise * 3.0 + uTime * 0.15);
  float bands = smoothstep(0.44, 0.5, phase) * smoothstep(0.56, 0.5, phase);
  float sweep = 0.5 + 0.5 * sin(vNoise * 5.0 + uTime * 0.9 + fres * 4.0);
  float toIce = smoothstep(0.38, 0.56, sweep);
  float toFlare = smoothstep(0.52, 0.78, sweep);
  vec3 rim = mix(uAura, uIce, toIce) * pow(1.0 - facing, 4.5) * 2.6 * (1.0 - toFlare) + uFlare * pow(1.0 - facing, 6.0) * 1.35 * toFlare;
  vec3 inner = uIce * pow(facing, 12.0) * (0.14 + 0.2 * uPulse);
  return body * (0.07 + 0.4 * facing * facing) + uAura * glowCrest * 0.55 + mix(uAura, uIce, 0.55) * bands * 0.7 + inner
    + uAura * fres * 2.0 * (1.0 - toIce) + rim;
}
vec3 vividCore(vec3 N, float facing, float crest) {
  vec3 hot = mix(uIce, vec3(1.0), 0.45);
  float ang = atan(N.y, N.x) + uTime * 0.2;
  float zestW = smoothstep(0.1, 0.85, cos(ang - 3.6));
  float flareW = smoothstep(0.2, 0.9, cos(ang - 0.45));
  float edge = 1.0 - smoothstep(0.15, 0.75, facing);
  float key = clamp(dot(N, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
  float valley = (1.0 - smoothstep(0.22, 0.58, crest)) * smoothstep(0.25, 0.8, facing);
  vec3 body = mix(uAura, uVolt, valley);
  body = mix(body, uIce, max(smoothstep(0.84, 1.0, crest) * 0.4, flareW * edge));
  vec3 color = body * (0.03 + 0.34 * key * key + 0.12 * facing * (1.0 - valley));
  float ph = vNoise * 2.1 - uTime * 0.3;
  float f = fract(ph) - 0.5;
  float face = 0.3 + 0.7 * facing;
  float lit = 0.45 + 0.55 * step(0.5, fract(floor(ph) * 0.5));
  color += uVolt * valley * 0.09;
  color += sheen(floor(ph) * 0.31 + uTime * 0.035) * exp(-f * f * 36.0) * 0.46 * face * (1.0 - 0.75 * valley);
  color += hot * exp(-f * f * 1600.0) * 0.9 * face * lit;
  color += hot * pow(abs(sin(vNoise * 15.0 + uTime * 1.4)), 30.0) * smoothstep(0.62, 0.95, crest) * 0.55 * facing;
  color += mix(hot, uAura, valley) * pow(facing, 8.0) * (0.16 + 0.55 * uPulse) * (1.0 - 0.5 * valley) + uAura * pow(facing, 3.0) * 0.12 * uPulse;
  float rimT = pow(1.0 - facing, 4.0);
  color += uAura * pow(1.0 - facing, 2.6) * 1.1 * (1.0 - 0.9 * flareW) * (1.0 - 0.6 * zestW);
  color += mix(uIce, uZest, zestW) * rimT * 2.4 * (1.0 - flareW);
  color += uFlare * pow(1.0 - facing, 4.2) * 2.6 * flareW;
  return color;
}
void main() {
  vec3 N = normalize(vNormalV);
  vec3 V = normalize(-vViewPos);
  float facing = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - facing, 2.4);
  float crest = clamp(vNoise * 0.5 + 0.5, 0.0, 1.0);
  vec3 color = uEnergy <= 0.0 ? calmCore(facing, fres, crest) : mix(calmCore(facing, fres, crest), vividCore(N, facing, crest), uEnergy);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

/* Halo: additive back-face shell = cheap fake bloom; the hue turns slowly around the rim. */
export const HALO_VERT = /* glsl */ `
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vRel;
void main() {
  vNormalV = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vViewPos = mv.xyz;
  vRel = mv.xyz - c.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const HALO_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uPower;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec3 vNormalV;
varying vec3 vViewPos;
varying vec3 vRel;
void main() {
  float d = dot(normalize(vNormalV), normalize(-vViewPos));
  float glow = pow(clamp(-d, 0.0, 1.0), uPower) * uIntensity;
  float ang = atan(vRel.y, vRel.x);
  float m = 0.5 + 0.5 * sin(ang * 2.0 + uTime * 0.5);
  vec3 col = mix(uColorA, uColorB, m);
  gl_FragColor = vec4(col * glow, glow);
  #include <colorspace_fragment>
}
`;

/* Orbit particles: positions computed on the GPU from (radius, angle, height); zero CPU per frame. */
export const ORBIT_VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
uniform float uReveal;
attribute float aRadius;
attribute float aAngle;
attribute float aHeight;
attribute float aSpeed;
attribute float aScale;
attribute float aMix;
varying float vMix;
varying float vAlpha;
void main() {
  float a = aAngle + uTime * aSpeed / (0.6 + aRadius);
  float r = aRadius * mix(0.8, 1.0, uReveal);
  vec3 p = vec3(cos(a) * r, aHeight, sin(a) * r);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * aScale * uPixelRatio * (1.0 / -mv.z);
  vMix = aMix;
  vAlpha = mix(0.3, 1.0, uReveal) * (0.55 + 0.45 * sin(uTime * 1.7 + aAngle * 13.0));
}
`;

/* Two body colors plus two rare sparks (the top 2 * uSparkRatio of aMix); uSparkRatio 0 = none. */
export const ORBIT_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uSparkA;
uniform vec3 uSparkB;
uniform float uSparkRatio;
varying float vMix;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  float body = 1.0 - 2.0 * uSparkRatio;
  vec3 col = mix(uColorA, uColorB, clamp(vMix / max(body, 0.001), 0.0, 1.0));
  if (vMix > body) col = vMix > 1.0 - uSparkRatio ? uSparkB : uSparkA;
  gl_FragColor = vec4(col * a * vAlpha, a * vAlpha);
  #include <colorspace_fragment>
}
`;

/* Lead packets: each point rides its own quadratic bezier (P0 source, P1 control, P2 target). */
export const PACKET_VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
uniform float uReveal;
attribute vec3 aP0;
attribute vec3 aP1;
attribute vec3 aP2;
attribute float aOffset;
attribute float aSpeed;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float t = fract(aOffset + uTime * aSpeed);
  float it = 1.0 - t;
  vec3 p = it * it * aP0 + 2.0 * it * t * aP1 + t * t * aP2;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float ends = smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.86, t);
  gl_PointSize = uSize * (0.6 + 0.8 * ends) * uPixelRatio * (1.0 / -mv.z);
  vColor = aColor;
  vAlpha = ends * uReveal;
}
`;

export const PACKET_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.18, 0.0, d);
  float glow = smoothstep(0.5, 0.0, d) * 0.55;
  float a = (core + glow) * vAlpha;
  gl_FragColor = vec4((vColor + core * 0.6) * a, a);
  #include <colorspace_fragment>
}
`;

/* Full-screen aurora for the auth backdrop (drei ScreenQuad); p is in units of the shorter side. */
export const AURORA_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/*
 * Curtains: rays rising from a wavy base line and fading upward, colored by a zest -> aura -> volt
 * ramp across the screen (left to right, as in the CSS AuroraBackdrop); the left curtain turns from
 * zest towards aura as it rises, as real ones do. The flare fringe is the lower border of the left
 * curtain only: far from volt, and just under the base line where the green has not started yet
 * (no muddy pink-over-green mix). Ends with a 1/255 dither so the dark gradients do not band.
 */
export const AURORA_FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uAspect;
uniform vec3 uBg;
uniform vec3 uZest;
uniform vec3 uAura;
uniform vec3 uVolt;
uniform vec3 uFlare;
varying vec2 vUv;
${SNOISE3}
vec3 ramp(float x) {
  vec3 c = mix(uZest, uAura, smoothstep(-0.7, -0.05, x));
  return mix(c, uVolt, smoothstep(0.2, 0.75, x));
}
vec3 curtain(vec2 p, float base, float tilt, float seed, float t) {
  float line = base + tilt * p.x + 0.07 * sin(p.x * 2.3 + seed + t * 1.6) + 0.08 * snoise(vec3(p.x * 1.1, seed, t));
  float h = p.y - line;
  float rays = 0.3 + 0.7 * smoothstep(-0.4, 0.8, snoise(vec3(p.x * 7.0 + seed, h * 0.4, t * 1.3)));
  float body = smoothstep(-0.03, 0.02, h) * exp(-max(h, 0.0) * 3.2) * rays;
  float fringe = smoothstep(-0.06, -0.035, h) * (1.0 - smoothstep(-0.03, 0.0, h)) * rays;
  return vec3(body, fringe, h);
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec2 p = (vUv - 0.5) * uAspect;
  float t = uTime * 0.05;
  vec2 w = vec2(snoise(vec3(p * 0.9, t)), snoise(vec3(p * 0.9 + 3.1, t)));
  vec2 q = p + w * vec2(0.1, 0.04);
  vec3 left = curtain(q, 0.06, 0.22, 1.3, t);
  vec3 right = curtain(q, -0.32, -0.12, 7.9, t * 1.2);
  float leftMask = 1.0 - smoothstep(-0.2, 0.25, q.x);
  float rightMask = smoothstep(-0.35, 0.1, q.x);
  float fringeMask = 1.0 - smoothstep(-0.55, -0.1, q.x);
  vec3 leftColor = mix(ramp(q.x), uAura, smoothstep(0.05, 0.45, left.z) * 0.55);
  vec3 aurora = leftColor * left.x * leftMask * 0.7 + ramp(q.x) * right.x * rightMask * 0.5;
  aurora += uFlare * left.y * fringeMask * 0.28;
  float vign = smoothstep(1.3, 0.25, length(p * vec2(0.8, 1.0)));
  gl_FragColor = vec4(uBg + aurora * vign, 1.0);
  #include <colorspace_fragment>
  gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
}
`;
