/* 3D volume view: volumetric clouds retrieved from the satellite bands inside a drawn box or
   area, over real terrain draped with satellite basemap imagery. It opens as a pane beside the
   map (or full window); the map shows the drawn area and the camera's position and view.

   Pipeline (per frame)
     terrain pass   ground mesh -> float target (linear radiance, alpha = distance from camera)
     cloud pass     full-screen ray march through the cloud fields (top / base / extinction /
                    convective / rain / ice / optical depth / mask, retrieved in a worker by decode/retrieve3d.js) with 3D
                    noise for sub-pixel structure, sun light marching, multiple-scattering
                    octaves, sky ambient, rain shafts and height fog, composited over terrain or
                    sky; accumulated over jittered frames while the camera is still. Loop frames
                    are blended field-by-field (interpolated playback).
     display pass   ACES tone mapping
   World units are km; x east, y up (altitude x vertical exaggeration), z south. The earth's
   curvature is applied relative to the camera, so distant clouds and ground drop below the
   horizon as they really do. */
import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';

import { VRMode, VR_HELP } from './vr3d.js';

const R_E = 6371;
const SKY_W = 256, SKY_H = 96;
const MAX_LOOP = 24;
const SAVE_KEY = 'satview.3d.v1';
const QUALITY = {
  draft: { scale: 0.6, steps: 260, frames: 16, moveScale: 0.35, moveSteps: 100 },
  standard: { scale: 1.0, steps: 480, frames: 48, moveScale: 0.5, moveSteps: 160 },
  high: { scale: 1.0, steps: 720, frames: 128, moveScale: 0.6, moveSteps: 200 },
};
const DEFAULTS = {
  look: 'clouds', preset: 'photoreal',
  vex: 1, fov: 55, visibility: 200, exposure: 1, quality: 'standard', footprint: true,
  sunAuto: true, sunElev: 45, sunAzim: 180,
  baseAuto: true, baseKm: 1.0, density: 1, coverage: 0, detail: 1, rain: true,
  framesMode: 'single', speed: 350,
};
const PRESETS = {
  photoreal: { density: 1, coverage: 0, detail: 1, visibility: 200, exposure: 1, vex: 1, rain: true },
  storm: { density: 1.4, coverage: 0.06, detail: 1.25, visibility: 55, exposure: 0.8, vex: 1, rain: true },
  heights: { density: 1, coverage: 0, detail: 0.9, visibility: 260, exposure: 1.05, vex: 1, rain: false },
  structure: { density: 1.15, coverage: 0.08, detail: 0.55, visibility: 320, exposure: 1.1, vex: 2, rain: false },
};
// what is remembered between visits (sun angles only when set by hand)
const SAVED = ['look', 'preset', 'vex', 'fov', 'visibility', 'exposure', 'quality', 'footprint', 'baseAuto', 'baseKm',
  'density', 'coverage', 'detail', 'rain', 'framesMode', 'speed'];

// ------------------------------------------------------------------ helpers
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mercY = (lat) => (1 - Math.asinh(Math.tan(clamp(lat, -85, 85) * Math.PI / 180)) / Math.PI) / 2;
const lon2x = (lon, n) => ((lon + 180) / 360) * n;
const fromH = THREE.DataUtils.fromHalfFloat, toH = THREE.DataUtils.toHalfFloat;

function b64ToU16(s) {
  if (s instanceof Uint16Array) return s; // fields computed in the browser arrive as half floats already
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Uint16Array(u8.buffer);
}

// separable max / min filter of a w x h grid over a (2r+1)^2 square
function dilate2d(a, w, h, r, op) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let m = a[o + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = op(m, a[o + k]);
      tmp[o + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = op(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

function el(tag, attrs = {}, html = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}


function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    const out = {};
    for (const k of SAVED) if (k in s && typeof s[k] === typeof DEFAULTS[k]) out[k] = s[k];
    return out;
  } catch (_) { return {}; }
}

// Web-mercator tiles for a lon/lat box, stitched into one canvas. Returns the canvas and the
// mercator extent it covers. url(z, x, y) gives a tile; tiles may be partly transparent.
async function stitchTiles(bbox, maxPx, { url, maxZoom = 16, fill = '#2a3340', maxTiles = 90, tile: T = 512 }, onProgress) {
  let [w, s, e, n] = bbox;
  s = clamp(s, -84, 84); n = clamp(n, -84, 84);
  let z = maxZoom;
  for (; z > 0; z--) {
    const N = 2 ** z;
    const wpx = (lon2x(e, N) - lon2x(w, N)) * T, hpx = (mercY(s) - mercY(n)) * N * T;
    const tiles = (Math.floor(lon2x(e, N)) - Math.floor(lon2x(w, N)) + 1) * (Math.floor(mercY(s) * N) - Math.floor(mercY(n) * N) + 1);
    if (wpx <= maxPx && hpx <= maxPx && tiles <= maxTiles) break;
  }
  const N = 2 ** z;
  const px0 = lon2x(w, N) * T, px1 = lon2x(e, N) * T;
  const py0 = mercY(n) * N * T, py1 = mercY(s) * N * T;
  const cw = Math.max(1, Math.round(px1 - px0)), ch = Math.max(1, Math.round(py1 - py0));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, cw, ch); }
  const jobs = [];
  let done = 0, total = 0;
  for (let ty = Math.floor(py0 / T); ty <= Math.floor((py1 - 1e-6) / T); ty++) {
    if (ty < 0 || ty >= N) continue;
    for (let tx = Math.floor(px0 / T); tx <= Math.floor((px1 - 1e-6) / T); tx++) {
      const x = ((tx % N) + N) % N;
      total++;
      const src = url(z, x, ty);
      jobs.push((typeof src === 'string' ? loadImage(src) : Promise.resolve(src).catch(() => null)).then((img) => {
        if (img) ctx.drawImage(img, tx * T - px0, ty * T - py0, T, T);
        done++;
        if (onProgress) onProgress(done, total);
      }));
    }
  }
  await Promise.all(jobs);
  return { canvas, lonW: w, lonE: e, mercN: py0 / (N * T), mercS: py1 / (N * T) };
}

// ------------------------------------------------------------------ tileable 3D noise (worker)
function noiseWorker() {
  /* eslint-disable no-restricted-globals */
  function hash3(x, y, z, s) {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function grad(ix, iy, iz, p, s, x, y, z) {
    const a = hash3(((ix % p) + p) % p, ((iy % p) + p) % p, ((iz % p) + p) % p, s) * 12 | 0;
    const g = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]][a];
    return g[0] * x + g[1] * y + g[2] * z;
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function perlin(x, y, z, p, s) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(grad(ix, iy, iz, p, s, fx, fy, fz), grad(ix + 1, iy, iz, p, s, fx - 1, fy, fz), u),
        l(grad(ix, iy + 1, iz, p, s, fx, fy - 1, fz), grad(ix + 1, iy + 1, iz, p, s, fx - 1, fy - 1, fz), u), v),
      l(l(grad(ix, iy, iz + 1, p, s, fx, fy, fz - 1), grad(ix + 1, iy, iz + 1, p, s, fx - 1, fy, fz - 1), u),
        l(grad(ix, iy + 1, iz + 1, p, s, fx, fy - 1, fz - 1), grad(ix + 1, iy + 1, iz + 1, p, s, fx - 1, fy - 1, fz - 1), u), v), w);
  }
  function worley(x, y, z, p, s) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let d = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const cx = ix + a, cy = iy + b, cz = iz + c;
      const wx = ((cx % p) + p) % p, wy = ((cy % p) + p) % p, wz = ((cz % p) + p) % p;
      const dx = cx + hash3(wx, wy, wz, s) - x, dy = cy + hash3(wx, wy, wz, s + 17) - y, dz = cz + hash3(wx, wy, wz, s + 31) - z;
      d = Math.min(d, dx * dx + dy * dy + dz * dz);
    }
    return Math.min(1, Math.sqrt(d));
  }
  const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
  function shape(N) {
    const out = new Uint8Array(N * N * N * 4);
    let i = 0;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, w = z / N;
      // Perlin fbm (period 4) remapped by inverted Worley fbm: billowy "Perlin-Worley"
      let pf = 0, amp = 1, tot = 0;
      for (let o = 0; o < 4; o++) { const f = 4 << o; pf += amp * perlin(u * f, v * f, w * f, f, 3 + o); tot += amp; amp *= 0.5; }
      pf = pf / tot * 0.5 + 0.5;
      const w1 = 1 - worley(u * 4, v * 4, w * 4, 4, 11), w2 = 1 - worley(u * 8, v * 8, w * 8, 8, 12), w3 = 1 - worley(u * 16, v * 16, w * 16, 16, 13);
      const wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
      const pw = Math.min(1, Math.max(0, remap(pf, wf - 1, 1, 0, 1)));
      // smooth low-frequency Perlin channels for domain warping
      let g1 = 0, g2 = 0; amp = 1; tot = 0;
      for (let o = 0; o < 3; o++) { const f = 2 << o; g1 += amp * perlin(u * f, v * f, w * f, f, 40 + o); g2 += amp * perlin(u * f, v * f, w * f, f, 50 + o); tot += amp; amp *= 0.5; }
      out[i++] = pw * 255;
      out[i++] = (g1 / tot * 0.7 + 0.5) * 255;
      out[i++] = (g2 / tot * 0.7 + 0.5) * 255;
      out[i++] = wf * 255;
    }
    return out;
  }
  function detail(N) {
    const out = new Uint8Array(N * N * N);
    let i = 0;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, w = z / N;
      const a = 1 - worley(u * 2, v * 2, w * 2, 2, 71), b = 1 - worley(u * 4, v * 4, w * 4, 4, 72), c = 1 - worley(u * 8, v * 8, w * 8, 8, 73);
      out[i++] = Math.min(1, Math.max(0, a * 0.625 + b * 0.25 + c * 0.125)) * 255;
    }
    return out;
  }
  self.onmessage = (e) => {
    const { s, d } = e.data;
    const a = shape(s), b = detail(d);
    self.postMessage({ shape: a, detail: b, s, d }, [a.buffer, b.buffer]);
  };
}

let noiseCache = null;
function getNoise() {
  if (!noiseCache) {
    noiseCache = new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([`(${noiseWorker.toString()})()`], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = (e) => { resolve(e.data); w.terminate(); URL.revokeObjectURL(url); };
      w.onerror = (e) => { noiseCache = null; reject(e); };
      w.postMessage({ s: 64, d: 32 });
    });
  }
  return noiseCache;
}

// ------------------------------------------------------------------ atmosphere (JS side)
const K_RLH = [5.5e-6, 13.0e-6, 22.4e-6], K_MIE = 12e-6, SH_RLH = 8000, SH_MIE = 1200, I_SUN = 22;
function sunTransmittance(elevDeg) {
  // optical depth from the ground toward the sun through a spherical atmosphere
  const r0 = 6371e3 + 200, ra = 6471e3;
  const e = Math.max(elevDeg, -2) * Math.PI / 180;
  const dy = Math.sin(e), dx = Math.cos(e);
  const b = 2 * r0 * dy, c = r0 * r0 - ra * ra;
  const len = (-b + Math.sqrt(b * b - 4 * c)) / 2;
  let odR = 0, odM = 0;
  const N = 64;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N * len;
    const h = Math.hypot(t * dx, r0 + t * dy) - 6371e3;
    if (h < 0) return [0, 0, 0];
    odR += Math.exp(-h / SH_RLH) * len / N;
    odM += Math.exp(-h / SH_MIE) * len / N;
  }
  return K_RLH.map((k) => Math.exp(-(k * odR + K_MIE * 1.1 * odM)));
}

// ------------------------------------------------------------------ shaders
const FS_QUAD_VS = /* glsl */`
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const SKY_FS = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec3 uSunDir;
uniform float uAltM;
#define PI 3.14159265
vec2 rsi(vec3 r0, vec3 rd, float sr) {
  float a = dot(rd, rd), b = 2.0 * dot(rd, r0), c = dot(r0, r0) - sr * sr, d = b * b - 4.0 * a * c;
  if (d < 0.0) return vec2(1e5, -1e5);
  return vec2((-b - sqrt(d)) / (2.0 * a), (-b + sqrt(d)) / (2.0 * a));
}
vec3 atmosphere(vec3 r, vec3 r0, vec3 pSun) {
  const float rPlanet = 6371e3, rAtmos = 6471e3, kMie = 12e-6, shRlh = 8e3, shMie = 1.2e3, g = 0.758, iSun = 22.0;
  const vec3 kRlh = vec3(5.5e-6, 13.0e-6, 22.4e-6);
  vec2 p = rsi(r0, r, rAtmos);
  if (p.x > p.y) return vec3(0.0);
  p.x = max(p.x, 0.0);
  p.y = min(p.y, rsi(r0, r, rPlanet).x > 0.0 ? rsi(r0, r, rPlanet).x : p.y);
  float iStep = (p.y - p.x) / 24.0, iTime = p.x;
  vec3 tR = vec3(0.0), tM = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  float mu = dot(r, pSun), mumu = mu * mu, gg = g * g;
  float pR = 3.0 / (16.0 * PI) * (1.0 + mumu);
  float pM = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0)) / (pow(1.0 + gg - 2.0 * mu * g, 1.5) * (2.0 + gg));
  for (int i = 0; i < 24; i++) {
    vec3 ip = r0 + r * (iTime + iStep * 0.5);
    float h = length(ip) - rPlanet;
    float sR = exp(-h / shRlh) * iStep, sM = exp(-h / shMie) * iStep;
    odR += sR; odM += sM;
    float jStep = rsi(ip, pSun, rAtmos).y / 8.0, jT = 0.0, jR = 0.0, jM = 0.0;
    for (int j = 0; j < 8; j++) {
      vec3 jp = ip + pSun * (jT + jStep * 0.5);
      float jh = length(jp) - rPlanet;
      jR += exp(-jh / shRlh) * jStep; jM += exp(-jh / shMie) * jStep;
      jT += jStep;
    }
    vec3 att = exp(-(kMie * 1.1 * (odM + jM) + kRlh * (odR + jR)));
    tR += sR * att; tM += sM * att;
    iTime += iStep;
  }
  return iSun * (pR * kRlh * tR + pM * kMie * tM);
}
void main() {
  float az = (vUv.x - 0.5) * 2.0 * PI;
  float el = vUv.y * vUv.y * 0.5 * PI;            // more rows near the horizon
  vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
  vec3 r0 = vec3(0.0, 6371e3 + uAltM, 0.0);
  outColor = vec4(atmosphere(d, r0, uSunDir), 1.0);
}`;

// shared by the terrain (cloud shadows) and cloud passes
const COMMON = /* glsl */`
uniform sampler2D uField;    // r top km, g base km, b extinction 1/km, a convective
uniform sampler2D uField2;   // r rain, g ice, b optical depth, a mask (has data x inside the drawn area)
uniform sampler2D uFieldB;   // the next loop frame, blended in by uMix (interpolated playback)
uniform sampler2D uField2B;
uniform float uMix;
uniform sampler3D uShape;    // r perlin-worley, gb warp, a worley
uniform sampler3D uDetail;   // r worley fbm
uniform sampler2D uSky;
uniform vec4 uBox;           // x west, z north, x east, z south (km)
uniform vec2 uAlt;           // cloud slab altitude range (km)
uniform vec4 uGeo;           // lon centre, lat centre, km per deg lon, km per deg lat
uniform float uCellKm, uDetailAmt, uDensity, uCoverage, uFrame, uPixAng;
uniform vec3 uSunDir;        // real-space unit vector toward the sun
uniform vec3 uBounce;        // radiance of the sunlit cloud walls around the camera (side light)
const float R_E = 6371.0;

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / max(b - a, 1e-4) * (d - c); }
vec2 boxUv(vec2 xz) { return (xz - uBox.xy) / (uBox.zw - uBox.xy); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec4 fld1(vec2 uv) { vec4 a = textureLod(uField, uv, 0.0); return uMix > 0.001 ? mix(a, textureLod(uFieldB, uv, 0.0), uMix) : a; }
vec4 fld2(vec2 uv) { vec4 a = textureLod(uField2, uv, 0.0); return uMix > 0.001 ? mix(a, textureLod(uField2B, uv, 0.0), uMix) : a; }
// longitude and web-mercator y of a point (km east / south of the centre)
vec2 lonMerc(vec2 xz) {
  float lon = uGeo.x + xz.x / uGeo.z;
  float lat = uGeo.y - xz.y / uGeo.w;
  return vec2(lon, (1.0 - log(tan(0.78539816 + radians(clamp(lat, -85.0, 85.0)) * 0.5)) / 3.14159265) * 0.5);
}

vec3 skyLut(vec3 d) {
  float az = atan(d.x, -d.z);
  float el = asin(clamp(d.y, 0.0, 1.0));
  return textureLod(uSky, vec2(az / 6.2831853 + 0.5, sqrt(el / 1.5707963)), 0.0).rgb;
}

// mip level of a noise texture for a sample footprint fp (km) and voxel size vox (km): distant
// samples read pre-filtered noise, so far-away cloud fields are smooth instead of grainy
float nLod(float fp, float vox) { return log2(max(fp / vox, 1.0)); }
// each noise lookup is turned about the vertical by its own angle: the tiling lattices of the
// octaves never line up, so cloud fields seen from above show no repeating grid
vec3 yaw(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }

// Cloud extinction (1/km) at a real-space point pk = (x km, altitude km, z km); fp = footprint (km).
// hf: height within the cloud (0 base .. 1 top), or -1 where no cloud column can reach the point
// at all (clear cell, above / below anything the noise can raise or lower it to)
float cloudDensity(vec3 pk, bool hq, float fp, out float hf) {
  hf = -1.0;
  vec2 uv = boxUv(pk.xz);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  vec4 wn = textureLod(uShape, pk * 0.043, nLod(fp, 0.36));
  // plus a finer 3D warp (~1.5 km lumps that change with height) so the sides of thick cloud
  // (an eyewall, a tower) bulge and stack instead of following the straight cell edges
  vec2 w2 = textureLod(uShape, yaw(pk, 0.54) * vec3(0.33, 0.22, 0.33) + vec3(0.5, 0.1, 0.3), nLod(fp, 0.09)).gb - 0.5;
  vec2 wuv = uv + ((wn.gb - 0.5) * (2.4 * uCellKm) + w2 * max(1.4, 1.2 * uCellKm)) / (uBox.zw - uBox.xy);
  vec4 f = fld1(wuv);
  float thick = max(f.r - f.g, 0.08);
  if (f.b < 0.015 || pk.y < f.g - 0.6 || pk.y > f.r + 0.6 * min(thick, 4.0) + 0.4 * min(thick, 2.5) + 0.05) return 0.0;
  vec4 f2 = fld2(wuv);
  if (f2.a < 0.02) return 0.0;
  hf = 0.0;
  float conv = f.a, ice = f2.g, tau = f2.b;
  // every octave's phase also drifts with the slow warp field (by most of a period over tens of km):
  // the noise is no longer exactly periodic, so features never stack up into rows or a grid
  vec3 ph = vec3(wn.g - 0.5, 0.0, wn.b - 0.5);
  float big = textureLod(uShape, yaw(pk + ph * 13.0, 1.17) * vec3(0.085, 0.12, 0.085), nLod(fp, 0.18)).r;
  // the big lumps come and go over tens of km instead of repeating evenly
  big = 0.5 + (big - 0.5) * (0.35 + 0.65 * smoothstep(0.25, 0.75, wn.r));
  // ~2 km lumps: heaped tops and a lumpy (not flat-blurred) underside
  vec2 mid = textureLod(uShape, yaw(pk + ph * 3.4, 1.97) * vec3(0.42, 0.3, 0.42) + vec3(0.37, 0.11, 0.73), nLod(fp, 0.037)).ra;
  float topD = f.r + (big - 0.5) * mix(0.35, 1.5, conv) * min(thick, 4.0) * 0.8
             + (mid.x - 0.5) * mix(0.4, 0.8, conv) * min(thick, 2.5);
  float baseD = f.g + (wn.a - 0.5) * 0.25 * min(thick, 2.0) + (0.55 - mid.y) * 0.45 * min(thick, 1.6);
  // optically thin (edge / broken) liquid cloud is also geometrically thin: edges dome down
  // instead of ending in vertical walls
  float fill = mix(smoothstep(0.3, 7.0, tau), 1.0, ice * (1.0 - conv));
  topD = baseD + (topD - baseD) * mix(0.6, 1.0, fill);
  float thD = max(topD - baseD, 0.05);
  float dB = pk.y - baseD, dT = topD - pk.y;
  if (dB <= 0.0 || dT <= 0.0) return 0.0;
  float h = dB / thD;
  hf = h;
  // vertical profile in km, not as a fraction of the depth: tall columns stay columns and only
  // their upper few km round off into domes (cumulus heads); bases are flat-ish
  float taper = clamp(thD * mix(0.25, 0.55, conv), 0.12, mix(1.2, 3.0, conv));
  float pr = smoothstep(0.0, clamp(thD * mix(0.05, 0.12, conv), 0.04, 0.5), dB) * smoothstep(0.0, taper, dT);
  // optically thin liquid cloud is mostly broken (sub-pixel) cumulus; thin ice is a veil
  float cov = 0.42 + 0.58 * smoothstep(0.3, 9.0, tau);
  cov = mix(cov, 0.82, ice * (1.0 - conv));
  vec2 e = min(uv, 1.0 - uv);
  cov = clamp(cov + uCoverage, 0.0, 1.0) * smoothstep(0.0, 0.07, min(e.x, e.y) + (wn.g - 0.5) * 0.05)
      * smoothstep(0.03, 0.8, f2.a + (wn.g - 0.5) * 0.3);
  vec3 sp = yaw(pk + ph * 6.0, 0.38) * vec3(0.24, mix(0.26, 0.6, ice * (1.0 - conv)), 0.24);
  float n = textureLod(uShape, sp, nLod(fp, 0.065)).r;
  // towers get bigger lobes: blend in the same noise at ~2.5x the scale (3-4 km heads on a
  // cumulonimbus, ~1 km bulges on small cumulus)
  float big3 = smoothstep(2.0, 9.0, thick) * conv;
  if (big3 > 0.01) n = mix(n, n * textureLod(uShape, yaw(pk + ph * 10.0, 2.64) * 0.11 + vec3(0.21, 0.53, 0.08), nLod(fp, 0.15)).r * 1.6, big3 * 0.5);
  float shape = clamp(remap(n * pr, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (shape <= 0.0) return 0.0;
  // solid interiors, defined surfaces: what is clearly inside is uniformly dense, so the visible
  // surface is the noise boundary (lobes) rather than a grainy density texture
  shape = mix(shape, smoothstep(0.0, 0.45, shape), 0.6 * conv);
  float dl = nLod(fp, 0.028);
  if (hq && dl < 4.0) {
    float d = textureLod(uDetail, yaw(pk + ph * 1.3, 0.82) * vec3(1.1, mix(1.1, 2.2, ice), 1.1), dl).r;
    float dm = mix(d, 1.0 - d, clamp(dB / 0.8, 0.0, 1.0));
    float er = mix(0.45, 0.7, 1.0 - smoothstep(0.0, taper * 1.5, dT));   // billowy heads, wispy bases
    shape = clamp(remap(shape, dm * er * uDetailAmt * (1.0 - smoothstep(1.5, 4.0, dl)), 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  // density ramps up quickly inside the boundary: crisp cauliflower edges on heaped cloud, a
  // softer rim on veils and stratiform layers
  return pow(shape, mix(1.4, 1.0, conv * (1.0 - 0.6 * ice))) * 1.35 * f.b * uDensity / max(cov, 0.3);
}

// optical depth from a ground point toward the sun through the cloud layer
float cloudShadowOD(vec3 g, float jitter, float fp) {
  if (uSunDir.y < 0.02) return 0.0;
  float a0 = max(uAlt.x, g.y), a1 = uAlt.y;
  if (a1 <= a0) return 0.0;
  float s0 = (a0 - g.y) / uSunDir.y, s1 = min((a1 - g.y) / uSunDir.y, s0 + 90.0);
  float ds = (s1 - s0) / 20.0, od = 0.0, hf;
  for (int i = 0; i < 20; i++) od += cloudDensity(g + uSunDir * (s0 + ds * (float(i) + jitter)), false, max(ds * 0.5, fp), hf) * ds;
  return od;
}`;

const TERRAIN_VS = /* glsl */`
precision highp float;
precision highp sampler2D;
in vec3 position;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
uniform sampler2D uElev;
uniform vec4 uGround;
uniform float uVex, uBaseElev, uOuter;
uniform vec3 uCamPos;
out vec3 vReal;
out vec3 vWorld;
out vec2 vGuv;
out float vElev;             // the real ground elevation (the drawn surface eases to a flat rim)
void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 guv = (p.xz - uGround.xy) / (uGround.zw - uGround.xy);
  float e;
  if (uOuter > 0.5) {
    bool inside = all(greaterThan(guv, vec2(0.002))) && all(lessThan(guv, vec2(0.998)));
    e = uBaseElev - (inside ? 0.12 : 0.0);
    vElev = 0.0;
  } else {
    vec2 ed = min(guv, 1.0 - guv);
    vElev = textureLod(uElev, guv, 0.0).r;
    e = mix(uBaseElev, vElev, smoothstep(0.0, 0.05, min(ed.x, ed.y)));
  }
  vec2 d = p.xz - uCamPos.xz;
  float drop = dot(d, d) / (2.0 * 6371.0);
  vec3 w = vec3(p.x, (e - drop) * uVex, p.z);
  vReal = vec3(p.x, e, p.z);
  vWorld = w;
  vGuv = guv;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const TERRAIN_FS = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
in vec3 vReal;
in vec3 vWorld;
in vec2 vGuv;
in float vElev;
out vec4 outColor;
uniform sampler2D uImg;
uniform vec4 uImgGeo;        // lon west, lon east, mercator y north, mercator y south
uniform sampler2D uElev;
uniform vec2 uElevTexel;
uniform vec4 uGround;
uniform float uVex, uOuter, uSunVisible;
uniform vec3 uSunColor, uSkyIrr, uCamPos;
${COMMON}
void main() {
  vec2 lm = lonMerc(vReal.xz);
  vec2 iuv = vec2((lm.x - uImgGeo.x) / (uImgGeo.y - uImgGeo.x), (lm.y - uImgGeo.z) / (uImgGeo.w - uImgGeo.z));
  vec3 alb = texture(uImg, iuv).rgb;
  vec3 n = vec3(0.0, 1.0, 0.0);
  float od = 0.0, tauC = 0.0;
  if (uOuter < 0.5) {
    vec2 tk = (uGround.zw - uGround.xy) * uElevTexel;
    float eW = texture(uElev, vGuv - vec2(uElevTexel.x, 0.0)).r, eE = texture(uElev, vGuv + vec2(uElevTexel.x, 0.0)).r;
    float eN = texture(uElev, vGuv - vec2(0.0, uElevTexel.y)).r, eS = texture(uElev, vGuv + vec2(0.0, uElevTexel.y)).r;
    n = normalize(vec3(-(eE - eW) * uVex / (2.0 * tk.x), 1.0, -(eS - eN) * uVex / (2.0 * tk.y)));
    vec2 buv = boxUv(vReal.xz);
    if (all(greaterThanEqual(buv, vec2(0.0))) && all(lessThanEqual(buv, vec2(1.0)))) {
      od = cloudShadowOD(vReal, fract(ign(gl_FragCoord.xy) + uFrame * 0.618034), length(vWorld - uCamPos) * uPixAng);
      vec4 c2 = fld2(buv);
      tauC = c2.b * smoothstep(0.03, 0.8, c2.a);
    }
  }
  vec3 sunW = normalize(vec3(uSunDir.x, uSunDir.y * uVex, uSunDir.z));
  float sh = exp(-od);
  float td = 1.0 / (1.0 + 0.11 * tauC);                  // diffuse transmittance of the cloud column
  float ndl = max(dot(n, sunW), 0.0);
  vec3 E = uSunColor * uSunVisible * (ndl * sh + max(uSunDir.y, 0.0) * (1.0 - sh) * td * 0.75)
         + uSkyIrr * mix(1.0, td * 0.85 + 0.08, smoothstep(0.0, 3.0, tauC)) * (0.55 + 0.45 * n.y)
         + uBounce * 1.57 * (0.3 + 0.7 * td);
  vec3 col = alb * E / 3.14159265;
  // calm water: Fresnel sky reflection and sun glint
  if (vElev < 0.002 && alb.b > alb.r * 1.05 && dot(alb, vec3(0.333)) < 0.09) {
    vec3 v = normalize(uCamPos - vWorld);
    // wind-roughened sea, not a mirror: waves tilt the reflected rays up into the sky and keep
    // the grazing-angle Fresnel well below 1
    float fr = 0.02 + 0.55 * pow(1.0 - max(v.y, 0.0), 5.0);
    vec3 rf = reflect(-v, vec3(0.0, 1.0, 0.0));
    rf = normalize(vec3(rf.x, max(rf.y, 0.0) + 0.12, rf.z));
    // under cloud the mirrored "sky" is mostly the grey cloud base
    vec3 baseCol = vec3(dot(uSkyIrr, vec3(0.3, 0.5, 0.2))) / 3.14159265 * (0.35 + 0.65 * td);
    vec3 refl = mix(skyLut(rf), baseCol, smoothstep(0.3, 4.0, tauC));
    // low reflected rays see the cloud walls around (an eye's sunlit eyewall), not open sky
    refl = mix(refl, uBounce * 2.0, clamp(uBounce.g, 0.0, 1.0) * (1.0 - smoothstep(0.05, 0.5, rf.y)));
    float spec = pow(max(dot(normalize(v + sunW), vec3(0.0, 1.0, 0.0)), 0.0), 900.0) * 120.0;
    col = mix(col, refl, fr) + uSunColor * uSunVisible * sh * spec * 0.06;
  }
  outColor = vec4(col, length(vWorld - uCamPos));
}`;

const CLOUD_FS = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTerrain;
uniform sampler2D uPrev;
uniform sampler2D uBlocks;   // per block of cells: r highest possible cloud, g lowest, b max extinction, a max rain
uniform vec2 uBlockN;
uniform sampler2D uEnv;      // the same per cell (dilated by the domain warp's reach)
uniform vec2 uCellN;
uniform float uBlend, uVex, uSteps, uStepScale, uDropMax, uSunVisible, uHazeBeta, uHazeH, uOvercast, uRainAmt;
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos, uSunColor, uSkyAmb, uGroundAmb, uSkyIrr;
uniform int uTint;           // cloud colour: 0 natural, 1 the satellite product, 2 by altitude
uniform sampler2D uProd;     // the shown satellite product over the box (web mercator)
uniform vec4 uProdGeo;       // lon west, lon east, mercator y north, mercator y south
${COMMON}

float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (12.5663706 * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }

// sunlight reaching a cloud sample: Beer-Lambert with multiple-scattering octaves (Wrenninge)
vec3 sunScatter(float od, float mu) {
  float s = 0.0, a = 1.0, b = 1.0, c = 1.0;
  for (int o = 0; o < 4; o++) {
    s += a * mix(hg(mu, 0.8 * c), hg(mu, -0.3 * c), 0.25) * exp(-od * b);
    a *= 0.5; b *= 0.5; c *= 0.6;
  }
  return uSunColor * s * uSunVisible;
}

// optical depth toward the sun, ~9 km out: far enough for a tall wall (an eyewall, a tower) to
// shade the cloud beside it; samples outside the block envelope cost nothing
float sunOD(vec3 pk, float fp) {
  float od = 0.0, s = 0.0, l = 0.08, hf;
  for (int j = 0; j < 8; j++) {
    vec3 q = pk + uSunDir * (s + 0.5 * l);
    if (q.y > uAlt.y) break;
    vec4 b = textureLod(uBlocks, boxUv(q.xz), 0.0);
    if (b.b >= 0.015 && q.y < b.r && q.y > b.g) od += cloudDensity(q, j < 2, max(fp, l * 0.5), hf) * l;
    s += l; l *= 1.75;
  }
  return od;
}

float rainDensity(vec3 pk, vec4 f, float rain) {
  if (rain < 0.02 || pk.y > f.g) return 0.0;
  float st = textureLod(uDetail, pk * vec3(0.45, 0.05, 0.45), 0.0).r;
  return rain * 0.9 * uRainAmt * smoothstep(0.35, 0.8, st) * (1.0 - smoothstep(f.g - 0.5, f.g, pk.y) * 0.6);
}

vec3 heightRamp(float km) {
  const vec3 c[7] = vec3[7](vec3(0.25, 0.45, 1.0), vec3(0.15, 0.8, 0.95), vec3(0.3, 0.9, 0.4), vec3(0.95, 0.92, 0.25),
                            vec3(1.0, 0.55, 0.15), vec3(0.95, 0.2, 0.25), vec3(0.85, 0.45, 0.95));
  float t = clamp(km / 16.0, 0.0, 1.0) * 6.0;
  int i = int(min(floor(t), 5.0));
  return mix(c[i], c[i + 1], t - float(i));
}

vec3 cloudTint(vec3 pk) {
  if (uTint == 1) {
    vec2 lm = lonMerc(pk.xz);
    vec4 c = textureLod(uProd, vec2((lm.x - uProdGeo.x) / (uProdGeo.y - uProdGeo.x), (lm.y - uProdGeo.z) / (uProdGeo.w - uProdGeo.z)), 0.0);
    return mix(vec3(0.85), c.rgb * 1.5 + 0.03, c.a);
  }
  if (uTint == 2) return heightRamp(pk.y);
  return vec3(1.0);
}

float fogBeta(float y) { return uHazeBeta * exp(-max(y, -0.5) / uHazeH); }

// optical depth of exponential height haze along a ray (altitude y0 km, dy km per km, len km);
// written with the two end densities so nothing overflows from high above
float fogOD(float y0, float dy, float len) {
  len = min(len, 4000.0);
  float y1 = max(y0 + dy * len, -0.5);
  y0 = max(y0, -0.5);
  if (abs(dy) < 1e-4) return uHazeBeta * exp(-y0 / uHazeH) * len;
  return max(uHazeBeta * uHazeH / dy * (exp(-y0 / uHazeH) - exp(-y1 / uHazeH)), 0.0);
}

void main() {
  // ray direction from the near plane: the far-plane unprojection loses all precision when the
  // camera stands a few metres above the ground (near / far ~ 1e-7)
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(normalize(vp.xyz / vp.w), 0.0)).xyz);
  vec3 ro = uCamPos;
  vec4 ter = texture(uTerrain, vUv);
  bool hitT = ter.a > 0.0;
  float tT = hitT ? ter.a : 1e7;

  vec3 rdr = vec3(rd.x, rd.y / uVex, rd.z);
  float kr = length(rdr);                 // real km per world unit along the ray
  vec3 rdn = rdr / kr;
  float mu = dot(rdn, uSunDir);
  float camAlt = ro.y / uVex;
  // a ray that misses the ground mesh but points below the horizon ends on the sea surface of
  // the curved earth (altitude = camAlt + s * rd.y / vex + (s |rd.xz|)^2 / 2R = 0)
  bool hitP = false;
  if (!hitT && rdr.y < 0.0) {
    float qa = dot(rd.xz, rd.xz) / (2.0 * R_E), disc = rdr.y * rdr.y - 4.0 * qa * camAlt;
    if (disc >= 0.0) { tT = 2.0 * camAlt / (-rdr.y + sqrt(disc)); hitP = true; }
  }
  // haze is integrated along a straight line in altitude: for a ray ending on the ground, the slope
  // that really takes it there (earth curvature lifts a straight ray off the ground far away)
  float endAlt = 0.0;
  if (hitT || hitP) {
    vec3 pe = ro + rd * tT;
    vec2 dd = pe.xz - ro.xz;
    endAlt = pe.y / uVex + dot(dd, dd) / (2.0 * R_E);
  }
  float fdy = hitT || hitP ? (endAlt - camAlt) / max(tT * kr, 1e-4) : rdn.y;
  vec3 hazeCol = skyLut(normalize(vec3(rd.x, 0.15 + max(rd.y, 0.0) * 0.3, rd.z)));
  float hl = dot(hazeCol, vec3(0.3, 0.5, 0.2));
  hazeCol = mix(vec3(hl), hazeCol, 0.75);                         // aerosol haze is whiter than the sky
  hazeCol = mix(vec3(hl) * 0.75, hazeCol, uOvercast);

  // ray vs cloud slab
  vec3 bmin = vec3(uBox.x, (uAlt.x - uDropMax) * uVex, uBox.y);
  vec3 bmax = vec3(uBox.z, uAlt.y * uVex, uBox.w);
  vec3 rds = mix(rd, vec3(1e-7), vec3(lessThan(abs(rd), vec3(1e-7))));
  vec3 inv = 1.0 / rds;
  vec3 ta = (bmin - ro) * inv, tb = (bmax - ro) * inv;
  vec3 tmn = min(ta, tb), tmx = max(ta, tb);
  float tN = max(max(tmn.x, tmn.y), max(tmn.z, 0.0));
  float tF = min(min(min(tmx.x, tmx.y), tmx.z), tT);

  vec3 L = vec3(0.0);
  float T = 1.0;
  float tA = tF > tN ? tN : tT;
  float od0 = fogOD(camAlt, fdy, tA * kr);
  float tr0 = exp(-od0);
  L += hazeCol * (1.0 - tr0);
  T *= tr0;

  if (tF > tN) {
    float jit = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803398875);
    float t = tN + jit * clamp(tN * 0.002, 0.03, 0.4) * uStepScale;
    int maxS = int(uSteps);
    vec2 bsz = (uBox.zw - uBox.xy) / uBlockN, csz = (uBox.zw - uBox.xy) / uCellN;
    vec2 rxz = mix(rd.xz, vec2(1e-7), vec2(lessThan(abs(rd.xz), vec2(1e-7))));
    bool rainOn = uRainAmt > 0.0;
    // run > 0: samples in a row that found no cloud, each stride a little longer (so clear air
    // inside a cloud's envelope, e.g. an eye, does not use up the step budget); a hit after a long
    // stride backs up and comes in at the fine step
    float run = 0.0, lastDt = 0.0;
    for (int i = 0; i < 1500; i++) {
      if (i >= maxS || t >= tF || T < 0.003) break;
      vec3 p = ro + rd * t;
      vec2 dxz = p.xz - ro.xz;
      vec3 pk = vec3(p.x, p.y / uVex + dot(dxz, dxz) / (2.0 * R_E), p.z);
      vec2 uv = boxUv(pk.xz);
      float dyEff = rdn.y + length(dxz) / R_E;
      // empty-space skipping, on the block grid and then the cell grid: jump to the exit of a
      // block / cell that cannot hold cloud at this height, or to where the ray descends (rises)
      // into its envelope
      vec4 env = textureLod(uBlocks, uv, 0.0);
      vec2 gsz = bsz;
      bool empty = false, ab = false, be = false;
      for (int lv = 0; lv < 2; lv++) {
        bool rainEnv = rainOn && env.a > 0.02;
        empty = env.b < 0.015 && !rainEnv;
        ab = pk.y > env.r;
        be = !rainEnv && pk.y < env.g;
        if (empty || ab || be || lv == 1) break;
        env = textureLod(uEnv, uv, 0.0);
        gsz = csz;
      }
      if (empty || ab || be) {
        vec2 lo = uBox.xy + floor((p.xz - uBox.xy) / gsz) * gsz;
        vec2 te = (lo + gsz * step(0.0, rd.xz) - p.xz) / rxz;
        float jump = max(min(te.x, te.y), 0.0);
        if (!empty) {
          if (ab && dyEff < 0.0) jump = min(jump, (pk.y - env.r) / (-dyEff * kr));
          else if (be && dyEff > 0.0) jump = min(jump, (env.g - pk.y) / (dyEff * kr));
        }
        // land at a jittered offset past the boundary, so samples never line up across pixels
        jump = clamp(jump + 0.005 + jit * clamp(t * 0.0018, 0.035, 0.45) * uStepScale, 0.01, tF - t + 1e-3);
        float tr = exp(-fogOD(pk.y, dyEff, jump * kr));
        L += T * hazeCol * (1.0 - tr);
        T *= tr;
        t += jump;
        run = 0.0;
        continue;
      }
      vec4 fc = fld1(uv);
      vec4 fc2 = fld2(uv);
      float rainHere = fc2.r * smoothstep(0.03, 0.8, fc2.a);
      bool nearRain = rainOn && rainHere > 0.02 && pk.y < fc.g + 0.1;
      float dt = clamp(t * 0.0018, 0.035, 0.45) * uStepScale * (1.0 + 0.6 * max(run, 0.0));
      // past half the step budget, stretch the steps so the ray still gets through the volume:
      // a ray that runs out of steps would show the ground through the cloud
      // (randomised per step and frame, so the long strides do not print slices into the clouds)
      if (i > maxS / 2) dt = max(dt, (tF - t) / float(max(maxS - i, 1)) * (0.6 + 0.8 * fract(jit + float(i) * 0.618034)));
      dt = min(dt, tF - t + 1e-3);
      float dsr = dt * kr;
      float fogB = uHazeBeta * exp(-max(pk.y, -0.5) / uHazeH);
      float hf = 0.0;
      float fp = max(t * uPixAng, dsr * 0.3);             // filter the noise to the step length too
      float sig = cloudDensity(pk, true, fp, hf);
      float rs = nearRain ? rainDensity(pk, fc, rainHere) : 0.0;
      // (only through air no cloud column reaches: grazing a lumpy top, every bump must be caught)
      if (sig <= 0.0 && rs <= 0.0 && hf < 0.0) run = min(run + 1.0, 5.0);
      else if (run > 1.5) {
        t = max(t - lastDt, tN);
        run = -3.0;
        lastDt = 0.0;
        continue;
      } else run = min(run, 0.0);
      vec3 S = fogB * hazeCol;
      if (sig > 0.003) {
        float od = sunOD(pk, fp);
        float above = fc.b * max(fc.r - pk.y, 0.0) * 0.6;
        float hfo;
        float occ = cloudDensity(pk + vec3(0.0, 0.3, 0.0), false, max(fp, 0.15), hfo);
        vec3 amb = uSkyAmb * (0.3 + 0.7 * hf) * exp(-above * 0.1 - occ * 0.12) + uGroundAmb * (1.0 - hf)
                 + uBounce * 0.6 * exp(-occ * 0.06);
        // deep inside / under thick cloud the light is diffuse: two-stream transmittance of the
        // optical depth toward the sun (local, so thin spots of the base glow brighter)
        float tv = od * max(uSunDir.y, 0.05);
        // (only toward the base: near the top the scattering octaves already carry it)
        vec3 diff = uSunColor * uSunVisible * max(uSunDir.y, 0.0) * (0.5 / 3.14159265) / (1.0 + 0.1125 * tv)
                  * (1.0 - exp(-od)) * (1.0 - hf) * (1.0 - hf);
        S += sig * cloudTint(pk) * (sunScatter(od, mu) + amb + diff);
      }
      if (rs > 0.0) {
        float colOD = fc.b * max(fc.r - fc.g, 0.0);
        S += rs * ((uSkyAmb + uGroundAmb) * (0.25 + 0.75 * exp(-colOD * 0.03)) + uBounce * 0.7
                   + sunScatter(colOD * 0.5, mu) * 0.3) * 0.85;
      }
      float sigT = sig + rs + fogB;
      float tr = exp(-sigT * dsr);
      L += T * (S - S * tr) / max(sigT, 1e-6);
      T *= tr;
      t += dt;
      lastDt = dt;
    }
    if (tT > tF) {
      vec3 pe = ro + rd * tF;
      vec2 dxz = pe.xz - ro.xz;
      float y0 = pe.y / uVex + dot(dxz, dxz) / (2.0 * R_E), len = (min(tT, 1e5) - tF) * kr;
      float od = fogOD(y0, hitT || hitP ? (endAlt - y0) / max(len, 1e-4) : rdn.y, len);
      float tr = exp(-od);
      L += T * hazeCol * (1.0 - tr);
      T *= tr;
    }
  }
  vec3 bg;
  if (hitT) bg = ter.rgb;
  else if (hitP) {
    // open sea beyond the imagery: dark water lit by sun and sky, mirroring the sky at grazing angles
    float vy = max(-rdn.y, 0.0);
    vec3 E = uSunColor * uSunVisible * max(uSunDir.y, 0.0) + uSkyIrr;
    bg = mix(vec3(0.004, 0.012, 0.03) * E / 3.14159265, skyLut(normalize(vec3(rd.x, 0.12 + vy, rd.z))),
             0.02 + 0.55 * pow(1.0 - vy, 5.0));
  } else {
    bg = skyLut(rd);
    float cs = dot(rd, uSunDir);
    bg += uSunColor * uSunVisible * smoothstep(0.99994, 0.99998, cs) * 2500.0;
  }
  vec3 col = L + T * bg;
  vec3 prev = texture(uPrev, vUv).rgb;
  outColor = vec4(mix(prev, col, uBlend), 1.0);
}`;

const DISPLAY_FS = /* glsl */`
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uExposure;
uniform vec2 uTexel;         // 1 / source size
uniform float uDenoise;      // 0..1: 3x3 filter over a single-sample (moving / VR) frame
vec3 aces(vec3 x) {
  // ACES fitted (Stephen Hill)
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = i * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(o * (a / b), 0.0, 1.0);
}
vec3 tone(vec2 uv) { return pow(aces(texture(uSrc, uv).rgb * uExposure), vec3(1.0 / 2.2)); }
void main() {
  vec3 c = tone(vUv);
  // a frame that is not accumulated is one jittered ray-march sample per pixel: where the ray first
  // lands inside a cloud varies from pixel to pixel, so the cloud surface comes out speckled. The
  // jitter is interleaved gradient noise, whose offsets are spread evenly over every 3x3 block, so
  // averaging that block (after tone mapping, so no single bright sample dominates) recovers a
  // nearly stratified 9-sample estimate
  if (uDenoise > 0.0) {
    vec3 s = c;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
      if (x != 0 || y != 0) s += tone(vUv + vec2(float(x), float(y)) * uTexel);
    c = mix(c, s / 9.0, uDenoise);
  }
  float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  outColor = vec4(c + d / 255.0, 1.0);
}`;

// ------------------------------------------------------------------ icons
const IC = {
  cube: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  dl: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="17" height="17"><rect x="6.5" y="5.5" width="4" height="13" rx="1" fill="currentColor"/><rect x="13.5" y="5.5" width="4" height="13" rx="1" fill="currentColor"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="17" height="17"><circle cx="5.5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="18.5" cy="12" r="1.7" fill="currentColor"/></svg>',
  expand: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shrink: '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  box: '<svg viewBox="0 0 24 24" width="19" height="19"><rect x="4" y="5" width="16" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="3 2.4"/></svg>',
  person: '<svg viewBox="0 0 24 24" width="19" height="19"><circle cx="12" cy="4.6" r="2" fill="currentColor"/><path d="M12 7.5v6.5m0 0l-3.5 6.5M12 14l3.5 6.5M6.5 10.5l5.5-2 5.5 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  overview: '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  tower: '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M5 19c-1.6 0-2.5-1.2-2.5-2.5S3.6 14 5 14c.2-2 1.7-3.3 3.4-3.3.3-2.6 2-4.7 4.6-4.7 2.7 0 4.4 2.2 4.6 4.8 1.9.2 3.4 1.8 3.4 3.8 0 2.4-1.6 4.4-4 4.4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  plane: '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M21 15.5l-8-4.5V5.5a1.5 1.5 0 00-3 0V11l-8 4.5V17l8-2.5V19l-2.5 1.5V22l4-1 4 1v-1.5L13 19v-4.5l8 2.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  top: '<svg viewBox="0 0 24 24" width="19" height="19"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
  window: '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrowL: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M19 12H5m6-6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  scene: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 19l6-10 4 6 3-4 5 8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 18.5a4 4 0 01-.6-7.95A5.5 5.5 0 0117 9.5a4.5 4.5 0 01.5 9z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  film: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4" stroke="currentColor" stroke-width="1.5"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5.5M12 7.6v.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  reset: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4.5 12a7.5 7.5 0 107.5-7.5c-2.3 0-4.3 1-5.7 2.6M4.5 4v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  vr: '<svg viewBox="0 0 24 24" width="19" height="19"><path d="M3.5 8.5A1.5 1.5 0 015 7h14a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0119 17h-4.2l-1.6-2.4a1.4 1.4 0 00-2.4 0L9.2 17H5a1.5 1.5 0 01-1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="8" cy="11.6" r="1.6" fill="currentColor"/><circle cx="16" cy="11.6" r="1.6" fill="currentColor"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="14" height="14" class="chev"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

// ------------------------------------------------------------------ viewer
let active = null;

class Viewer {
  constructor(opts) {
    this.opts = opts;
    this.disposed = false;
    this.params = { ...DEFAULTS, ...(opts.defaults || {}), ...loadSaved() };
    this.frames = [];         // loop frames, oldest first (the shown map frame only, until a loop is loaded)
    this.fi = 0;              // frame on screen
    this.playing = false;
    this.playT = 0;
    this.seq = 0;
    this.keys = new Set();
    this.version = 0;
    this.max = false;
    this.S = null;            // the current region's scene (geometry, textures)
    this.buildDom();
    this.initRenderer();
    this.bindControls();
    this.setWaiting();
    this.vr = new VRMode(this, THREE);
    VRMode.supported().then((ok) => {
      if (!ok || this.disposed) return;
      this.$('r3dVrBtn').classList.remove('hidden');
      this.$('r3dHelp').textContent += ' · VR headset: the goggles button';
    });
  }

  // ---------------------------------------------------------------- DOM
  buildDom() {
    const root = el('div', { id: 'r3d' });
    const row = (k, icon, label, sumId, body) => `
      <details class="r3d-acc" data-k="${k}"><summary>${IC[icon]}<span>${label}</span><em id="${sumId}"></em>${IC.chev}</summary><div class="r3d-acc-body">${body}</div></details>`;
    root.innerHTML = `
      <div class="r3d-splitter" id="r3dSplitter" title="Drag to resize"></div>
      <canvas id="r3dCanvas" tabindex="0"></canvas>
      <div class="r3d-bar hidden" id="r3dBar"><div></div></div>
      <div class="r3d-head">
        <div class="r3d-tab glass">${IC.cube}<b id="r3dTitle">3D Volume</b><span id="r3dSub"></span>
          <button class="r3d-ib sm" data-act="close" title="Close the 3D view">${IC.x}</button></div>
        <div class="r3d-tools glass">
          <button class="r3d-ib hidden" data-act="vr" id="r3dVrBtn" title="View in a VR headset. ${VR_HELP}">${IC.vr}</button>
          <button class="r3d-ib" data-act="export" title="Export the view as PNG">${IC.dl}</button>
          <button class="r3d-ib hidden" data-act="play" id="r3dPlay" title="Play the loop in 3D">${IC.play}</button>
          <button class="r3d-ib" data-act="window" id="r3dWinBtn" title="Full window">${IC.expand}</button>
          <button class="r3d-ib" data-act="menu" id="r3dMenuBtn" title="3D view settings">${IC.dots}</button>
          <button class="r3d-ib" data-act="close" title="Close the 3D view">${IC.x}</button>
        </div>
      </div>
      <div class="r3d-menu glass hidden" id="r3dMenu">
        <div class="r3d-menu-head"><b>3D view</b><button class="r3d-ib sm" data-act="menu">${IC.x}</button></div>
        <div class="r3d-tiles">
          <button data-act="export">${IC.dl}<span>Export</span></button>
          <button data-act="newbox">${IC.box}<span>New box</span></button>
          <button data-act="ground">${IC.person}<span>Ground</span></button>
          <button data-act="recon" title="Hurricane-hunter view: 3 km up inside an eye (or the clearest gap among tall cloud), looking at the sunlit wall">${IC.plane}<span>Recon</span></button>
          <button data-act="overview">${IC.overview}<span>Overview</span></button>
          <button data-act="tallest">${IC.tower}<span>Tallest</span></button>
          <button data-act="top">${IC.top}<span>Top-down</span></button>
          <button data-act="window">${IC.window}<span id="r3dWinLabel">Window</span></button>
        </div>
        <div class="r3d-label">Look</div>
        <div class="r3d-seg" id="r3dLook"><button data-look="clouds">Clouds</button><button data-look="satellite">Satellite</button></div>
        <div class="r3d-presets" id="r3dPresets">
          <button data-p="photoreal" title="Natural colours and lighting">Photoreal</button>
          <button data-p="storm" title="Denser, darker cloud, hazy air and rain shafts">Storm</button>
          <button data-p="heights" title="Clouds coloured by altitude (blue low … red / violet high)">Heights</button>
          <button data-p="structure" title="2× vertical, smooth solid shapes in clear air">Structure</button>
        </div>
        ${row('scene', 'scene', 'Scene and camera', 'sumScene', `
          <label class="row" title="Vertical exaggeration of clouds and terrain (1× = true scale)">Height <input type="range" id="r3dVex" min="1" max="6" step="0.25"><span class="mono" id="r3dVexV"></span></label>
          <label class="row">Field of view <input type="range" id="r3dFov" min="25" max="95" step="1"><span class="mono" id="r3dFovV"></span></label>
          <label class="row" title="Horizontal visibility near the ground">Visibility <input type="range" id="r3dVis" min="15" max="400" step="5"><span class="mono" id="r3dVisV"></span></label>
          <label class="row">Exposure <input type="range" id="r3dExp" min="0.2" max="3" step="0.05"><span class="mono" id="r3dExpV"></span></label>
          <label class="row">Quality <select id="r3dQuality"><option value="draft">Draft</option><option value="standard">Standard</option><option value="high">High</option></select></label>
          <label class="row check"><input type="checkbox" id="r3dFoot"> Show the camera and its view on the map</label>`)}
        ${row('sun', 'sun', 'Sun and lighting', 'sumSun', `
          <label class="row check"><input type="checkbox" id="r3dSunAuto"> Sun at scan time</label>
          <label class="row">Elevation <input type="range" id="r3dSunEl" min="-4" max="88" step="0.5"><span class="mono" id="r3dSunElV"></span></label>
          <label class="row">Azimuth <input type="range" id="r3dSunAz" min="0" max="360" step="1"><span class="mono" id="r3dSunAzV"></span></label>
          <div class="note" id="r3dSunNote"></div>`)}
        ${row('clouds', 'cloud', 'Clouds and rain', 'sumClouds', `
          <label class="row check" title="Bases come from the retrieval: the lifting condensation level for cumulus and deep cloud, a layer depth for mid / high cloud"><input type="checkbox" id="r3dBaseAuto"> Retrieved cloud base</label>
          <label class="row" title="Base of cumulus and deep cloud, above ground">Base <input type="range" id="r3dBase" min="0.2" max="3" step="0.1"><span class="mono" id="r3dBaseV"></span></label>
          <label class="row" title="Scales the retrieved extinction">Density <input type="range" id="r3dDensity" min="0.2" max="3" step="0.05"><span class="mono" id="r3dDensityV"></span></label>
          <label class="row" title="How much of each grid cell is filled with cloud (sub-pixel cloud fraction)">Coverage <input type="range" id="r3dCoverage" min="-0.4" max="0.4" step="0.02"><span class="mono" id="r3dCoverageV"></span></label>
          <label class="row" title="Small-scale erosion of cloud edges">Detail <input type="range" id="r3dDetail" min="0" max="1.6" step="0.05"><span class="mono" id="r3dDetailV"></span></label>
          <label class="row check"><input type="checkbox" id="r3dRain"> Rain shafts under deep cloud</label>`)}
        ${row('frames', 'film', 'Frames', 'sumFrames', `
          <label class="row">Show <select id="r3dFrames"><option value="single">Shown frame</option><option value="loop">Loop</option><option value="interp">Loop, interpolated</option></select></label>
          <label class="row">Speed <select id="r3dSpeed"><option value="700">Slow</option><option value="350">Normal</option><option value="160">Fast</option></select></label>
          <div class="note" id="r3dFramesNote">Plays the map's loop frames (set the loop length on the timeline) in 3D. Interpolated playback morphs the clouds between scans.</div>`)}
        ${row('info', 'info', 'Retrieval', 'sumInfo', `
          <div id="r3dStats" class="r3d-stats mono"></div>
          <details class="r3d-how"><summary>How the clouds are built</summary>
            <p>Cloud-top height comes from the 10.3 µm brightness temperature against the clear-sky surface temperature (6.5 K/km lapse rate, semi-transparent ice corrected with the split window, capped at the tropopause).</p>
            <p>Optical depth comes from 0.64 µm reflectance by day (two-stream) and from the IR split window / 3.9 µm fog test at night or with a low sun. Dim, warm pixels of broken cloud are unmixed into a sub-pixel cloud fraction, so small cumulus keep their true height.</p>
            <p>Bases follow the cloud type: cumulus, towers and optically thick systems reach down to the lifting condensation level as one deep column; altocumulus, altostratus, cirrus and anvils away from the cores are layers 0.3–5 km deep, deeper the thicker they are. Extinction = optical depth / depth, so the clouds reflect as much light as the satellite saw.</p>
            <p>Satellites see only cloud tops: one layer per column, bases are estimated, and detail below the pixel size is procedural noise. Rain shafts are a proxy from cold, very thick tops.</p>
          </details>`)}
        <button class="r3d-reset" data-act="reset">${IC.reset}<span>Reset 3D view settings</span></button>
        <div class="note r3d-reset-note">Puts every 3D view setting back to its default.</div>
      </div>
      <div class="r3d-wait" id="r3dWait">
        <div class="r3d-wait-ic">${IC.arrowL}</div>
        <b id="r3dWaitTitle">Drag a box over the clouds</b>
        <span id="r3dWaitSub">On the map; the 3D view opens here</span>
        <button class="r3d-btn" data-act="cancel">${IC.x}<span>Cancel</span></button>
      </div>
      <div class="r3d-toast glass hidden" id="r3dToast"><span class="spinner" id="r3dToastSpin"></span><span id="r3dToastText"></span></div>
      <div class="r3d-frame glass mono hidden" id="r3dFrame"></div>
      <div class="r3d-help glass mono" id="r3dHelp">Drag orbit · Right-drag pan · Wheel zoom · W A S D / Q E fly (Shift faster)</div>`;
    document.body.appendChild(root);
    this.root = root;
    this.canvas = root.querySelector('#r3dCanvas');
    const $ = (id) => root.querySelector('#' + id);
    this.$ = $;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && root.contains(b)) this.act(b.dataset.act);
    });
    // keyboard flight only while the pointer is over the 3D view (or it has focus)
    root.addEventListener('pointerenter', () => { this.hover = true; });
    root.addEventListener('pointerleave', () => { this.hover = false; this.keys.clear(); });
    this.canvas.addEventListener('pointerdown', () => { this.canvas.focus({ preventScroll: true }); this.menu(false); });
    this.onKeyDown = (e) => {
      if (!this.hover && document.activeElement !== this.canvas) return;
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
      if (e.key === 'Escape' && !$('r3dMenu').classList.contains('hidden')) { this.menu(false); e.stopPropagation(); return; }
      const k = e.key.toLowerCase();
      if (k.length === 1 && 'wasdqe'.includes(k) && !e.ctrlKey && !e.metaKey) { this.keys.add(k); e.preventDefault(); e.stopPropagation(); }
      if (e.key === 'Shift') this.keys.add('shift');
    };
    this.onKeyUp = (e) => { this.keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') this.keys.delete('shift'); };
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.bindSplitter($('r3dSplitter'));
    setTimeout(() => $('r3dHelp').classList.add('fade'), 9000);
  }

  bindSplitter(bar) {
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const w = clamp(window.innerWidth - ev.clientX, 320, window.innerWidth - 320);
        document.documentElement.style.setProperty('--r3d-w', `${w}px`);
        if (this.opts.onLayout) this.opts.onLayout();
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        try { localStorage.setItem('satview.3d.width', document.documentElement.style.getPropertyValue('--r3d-w')); } catch (_) { /* ignore */ }
        if (this.opts.onLayout) this.opts.onLayout(true);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
  }

  act(a) {
    const o = this.opts;
    if (a === 'close') { if (o.onClose) o.onClose(); else this.close(); }
    else if (a === 'export') this.save();
    else if (a === 'play') this.togglePlay();
    else if (a === 'vr') this.toggleVR();
    else if (a === 'window') this.setMax(!this.max);
    else if (a === 'menu') this.menu();
    else if (a === 'newbox') { this.menu(false); if (o.onNewBox) o.onNewBox(); }
    else if (a === 'cancel') { if (o.onCancel) o.onCancel(); }
    else if (a === 'reset') this.reset();
    else if (['ground', 'recon', 'overview', 'tallest', 'top'].includes(a)) { if (this.S) this.setView(a); }
  }

  toggleVR() {
    if (!this.vr.presenting && !this.S) { this.toast('Pick an area first, then enter VR', { spin: false, ms: 3000 }); return; }
    this.menu(false);
    this.vr.toggle().catch((e) => this.toast(`VR failed: ${e.message}`, { spin: false, ms: 6000 }));
  }

  onVR(on) {
    const b = this.$('r3dVrBtn');
    b.classList.toggle('on', on);
    b.title = on ? 'Exit VR' : `View in a VR headset. ${VR_HELP}`;
    this.toast(on ? 'In VR · put on the headset (left stick fly, right stick elevation / turn, grip + right stick cloud height)' : null,
      { spin: false, ms: on ? 8000 : 0 });
    this.touch();
  }

  menu(on) {
    const m = this.$('r3dMenu');
    const show = on === undefined ? m.classList.contains('hidden') : on;
    m.classList.toggle('hidden', !show);
    this.$('r3dMenuBtn').classList.toggle('on', show);
  }

  setMax(on) {
    this.max = on;
    this.$('r3dWinBtn').innerHTML = on ? IC.shrink : IC.expand;
    this.$('r3dWinBtn').title = on ? 'Back to split view' : 'Full window';
    this.$('r3dWinLabel').textContent = on ? 'Split view' : 'Window';
    if (this.opts.onWindow) this.opts.onWindow(on);
  }

  toast(text, { spin = true, ms = 0 } = {}) {
    const t = this.$('r3dToast');
    clearTimeout(this.toastT);
    if (!text) { t.classList.add('hidden'); return; }
    this.$('r3dToastText').textContent = text;
    this.$('r3dToastSpin').classList.toggle('hidden', !spin);
    t.classList.remove('hidden');
    if (ms) this.toastT = setTimeout(() => t.classList.add('hidden'), ms);
  }

  busy(on) { this.$('r3dBar').classList.toggle('hidden', !on); }

  setWaiting(title, sub) {
    this.$('r3dWaitTitle').textContent = title || 'Drag a box over the clouds';
    this.$('r3dWaitSub').textContent = sub || 'On the map, or pick Area / Whole view below it; the 3D view opens here';
    this.$('r3dWait').classList.toggle('hidden', !!this.S);
  }

  // ---------------------------------------------------------------- settings
  bindControls() {
    const $ = this.$, p = this.params;
    const ranges = {
      r3dVex: ['vex', (v) => `${v}×`],
      r3dFov: ['fov', (v) => `${v}°`],
      r3dVis: ['visibility', (v) => `${v} km`],
      r3dExp: ['exposure', (v) => v.toFixed(2)],
      r3dBase: ['baseKm', (v) => `${v.toFixed(1)} km`],
      r3dDensity: ['density', (v) => `${v.toFixed(2)}×`],
      r3dCoverage: ['coverage', (v) => (v > 0 ? '+' : '') + v.toFixed(2)],
      r3dDetail: ['detail', (v) => v.toFixed(2)],
    };
    this.ranges = ranges;
    for (const [id, [key, fmt]] of Object.entries(ranges)) {
      const inp = $(id);
      inp.oninput = () => {
        const old = p[key];
        p[key] = +inp.value;
        $(id + 'V').textContent = fmt(p[key]);
        if (key === 'vex') this.rescaleVex(old);
        else if (key === 'baseKm') this.applyBase();
        else if (key === 'exposure') this.displayOnly = true;
        else if (key === 'fov') { this.camera.fov = p.fov; this.camera.updateProjectionMatrix(); }
        if (['density', 'coverage', 'detail', 'visibility', 'exposure', 'vex'].includes(key)) this.markCustom();
        this.changed();
      };
    }
    const sunIn = () => {
      p.sunElev = +$('r3dSunEl').value; p.sunAzim = +$('r3dSunAz').value;
      p.sunAuto = false;
      this.updateSun();
      this.changed();
    };
    $('r3dSunEl').oninput = sunIn;
    $('r3dSunAz').oninput = sunIn;
    $('r3dSunAuto').onchange = (e) => {
      p.sunAuto = e.target.checked;
      if (p.sunAuto && this.S) { p.sunElev = this.S.sun.elev; p.sunAzim = this.S.sun.azim; }
      this.updateSun();
      this.changed();
    };
    $('r3dBaseAuto').onchange = (e) => { p.baseAuto = e.target.checked; this.applyBase(); this.changed(); };
    $('r3dRain').onchange = (e) => { p.rain = e.target.checked; this.changed(); };
    $('r3dFoot').onchange = (e) => { p.footprint = e.target.checked; this.lastCamEmit = 0; this.emitCamera(true); this.changed(); };
    $('r3dQuality').onchange = (e) => { p.quality = e.target.value; this.resize(); this.changed(); };
    $('r3dFrames').onchange = (e) => {
      p.framesMode = e.target.value;
      if (p.framesMode === 'single') this.dropLoop();
      else this.loadLoop();
      this.changed();
    };
    $('r3dSpeed').onchange = (e) => { p.speed = +e.target.value; this.changed(); };
    $('r3dLook').onclick = (e) => {
      const v = e.target.dataset && e.target.dataset.look;
      if (!v) return;
      p.look = v;
      this.changed();
    };
    $('r3dPresets').onclick = (e) => {
      const v = e.target.dataset && e.target.dataset.p;
      if (v) this.applyPreset(v);
    };
    this.syncControls();
  }

  // push params into the controls and the summaries next to each section
  syncControls() {
    const $ = this.$, p = this.params;
    for (const [id, [key, fmt]] of Object.entries(this.ranges)) {
      $(id).value = p[key];
      $(id + 'V').textContent = fmt(p[key]);
    }
    $('r3dSunEl').value = p.sunElev; $('r3dSunAz').value = p.sunAzim;
    $('r3dSunElV').textContent = `${(+p.sunElev).toFixed(1)}°`;
    $('r3dSunAzV').textContent = `${(+p.sunAzim).toFixed(0)}°`;
    $('r3dSunAuto').checked = p.sunAuto;
    $('r3dBaseAuto').checked = p.baseAuto;
    $('r3dBase').disabled = p.baseAuto;
    $('r3dRain').checked = p.rain;
    $('r3dFoot').checked = p.footprint;
    $('r3dQuality').value = p.quality;
    $('r3dFrames').value = p.framesMode;
    $('r3dSpeed').value = String(p.speed);
    for (const b of $('r3dLook').children) b.classList.toggle('on', b.dataset.look === p.look);
    for (const b of $('r3dPresets').children) b.classList.toggle('on', b.dataset.p === p.preset);
    $('sumScene').textContent = `${p.vex}× height`;
    $('sumSun').textContent = p.sunAuto ? 'Scan time' : `${(+p.sunElev).toFixed(0)}° · ${(+p.sunAzim).toFixed(0)}°`;
    const lcl = this.S && this.S.stats.lcl_km;
    $('sumClouds').textContent = p.baseAuto ? (lcl ? `Base ${lcl.toFixed(1)} km` : 'Base auto') : `Base ${p.baseKm.toFixed(1)} km`;
    const okN = this.frames.filter((f) => f.ok).length;
    $('sumFrames').textContent = p.framesMode === 'single' ? 'Shown frame' : `${p.framesMode === 'interp' ? 'Interpolated' : 'Loop'}${okN > 1 ? ` · ${okN}` : ''}`;
    $('sumInfo').textContent = this.S ? `${(this.S.stats.cloud_frac * 100).toFixed(0)}% cloud` : '';
    $('r3dPlay').classList.toggle('hidden', p.framesMode === 'single');
  }

  changed() {
    this.syncControls();
    this.touch();
    try {
      const s = {};
      for (const k of SAVED) s[k] = this.params[k];
      localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    } catch (_) { /* ignore */ }
  }

  markCustom() { this.params.preset = ''; }

  applyPreset(name) {
    const p = this.params, old = p.vex;
    Object.assign(p, PRESETS[name]);
    p.preset = name;
    if (name === 'heights' && p.look === 'satellite') p.look = 'clouds';
    this.rescaleVex(old);
    this.camera.fov = p.fov;
    this.changed();
  }

  reset() {
    const old = this.params.vex;
    const sun = this.S ? this.S.sun : null;
    this.params = { ...DEFAULTS, ...(this.opts.defaults || {}) };
    if (sun) { this.params.sunElev = sun.elev; this.params.sunAzim = sun.azim; this.daylightFallback(); }
    this.rescaleVex(old);
    this.camera.fov = this.params.fov;
    this.camera.updateProjectionMatrix();
    this.dropLoop();
    this.applyBase();
    this.updateSun();
    this.resize();
    this.changed();
  }

  rescaleVex(old) {
    const r = this.params.vex / old;
    if (r === 1 || !this.camera) return;
    this.camera.position.y *= r;
    this.controls.target.y *= r;
  }

  // ---------------------------------------------------------------- GL (once)
  initRenderer() {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: this.opts.lowPower ? 'low-power' : 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.autoClear = false;
    this.renderer = renderer;
    if (!renderer.capabilities.isWebGL2) throw new Error('WebGL 2 is required for the 3D view');
    const gl = renderer.getContext();
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    const one = (data, fmt) => { const t = new THREE.DataTexture(data, 1, 1, fmt); t.needsUpdate = true; return t; };
    this.blankTex = one(new Uint8Array([255, 255, 255, 0]), THREE.RGBAFormat);

    this.skyRT = new THREE.WebGLRenderTarget(SKY_W, SKY_H, { type: THREE.FloatType, depthBuffer: false });
    this.skyRT.texture.minFilter = this.skyRT.texture.magFilter = THREE.LinearFilter;
    this.skyRT.texture.wrapS = THREE.RepeatWrapping;
    this.skyRT.texture.wrapT = THREE.ClampToEdgeWrapping;
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const raw = (fs, uniforms) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_QUAD_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.skyMat = raw(SKY_FS, { uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uAltM: { value: 300 } });
    this.skyScene = new THREE.Scene();
    const skyMesh = new THREE.Mesh(quad, this.skyMat); skyMesh.frustumCulled = false; this.skyScene.add(skyMesh);

    // uniforms shared by the terrain and cloud passes (objects kept; values change per region)
    this.U = {
      uField: { value: null }, uField2: { value: null }, uFieldB: { value: null }, uField2B: { value: null }, uMix: { value: 0 },
      uShape: { value: null }, uDetail: { value: null }, uSky: { value: this.skyRT.texture },
      uBox: { value: new THREE.Vector4() }, uAlt: { value: new THREE.Vector2() }, uGeo: { value: new THREE.Vector4() },
      uCellKm: { value: 1 }, uPixAng: { value: 0.001 }, uDetailAmt: { value: 1 }, uDensity: { value: 2 }, uCoverage: { value: 0 }, uFrame: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Vector3(1, 1, 1) }, uSunVisible: { value: 1 },
      uSkyAmb: { value: new THREE.Vector3() }, uGroundAmb: { value: new THREE.Vector3() }, uSkyIrr: { value: new THREE.Vector3() },
      uBounce: { value: new THREE.Vector3() },
      uVex: { value: 1 }, uCamPos: { value: new THREE.Vector3() },
    };
    this.cloudMat = raw(CLOUD_FS, {
      ...this.U,
      uTerrain: { value: null }, uPrev: { value: null }, uBlend: { value: 1 },
      uBlocks: { value: null }, uBlockN: { value: new THREE.Vector2(1, 1) }, uEnv: { value: null }, uCellN: { value: new THREE.Vector2(1, 1) },
      uSteps: { value: 300 }, uStepScale: { value: 1 }, uDropMax: { value: 0 },
      uHazeBeta: { value: 0.03 }, uHazeH: { value: 1.6 }, uOvercast: { value: 1 }, uRainAmt: { value: 1 },
      uTint: { value: 0 }, uProd: { value: this.blankTex }, uProdGeo: { value: new THREE.Vector4(0, 1, 0, 1) },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    });
    this.cloudScene = new THREE.Scene();
    const cm = new THREE.Mesh(quad, this.cloudMat); cm.frustumCulled = false; this.cloudScene.add(cm);
    this.dispMat = raw(DISPLAY_FS, { uSrc: { value: null }, uExposure: { value: 1 }, uTexel: { value: new THREE.Vector2() }, uDenoise: { value: 0 } });
    this.dispScene = new THREE.Scene();
    const dm = new THREE.Mesh(quad, this.dispMat); dm.frustumCulled = false; this.dispScene.add(dm);

    this.camera = new THREE.PerspectiveCamera(this.params.fov, 1, 0.01, 20000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.9;
    this.controls.minDistance = 0.02;
    this.controls.zoomToCursor = true;
    this.lastT = performance.now();
    this.loop = this.loop.bind(this);
    // three.js drives the loop: window frames normally, the headset's frames in VR
    renderer.setAnimationLoop(this.loop);
  }

  // ---------------------------------------------------------------- regions
  // r: { sceneId, time, bbox [w,s,e,n] (e may exceed 180), polygon [[lon,lat]..] | null,
  //      satName, productName, prodTiles (url template), prodMaxZoom }
  async setRegion(r) {
    const seq = ++this.seq;
    this.region = r;
    this.stopPlay();
    this.menu(false);
    this.$('r3dTitle').textContent = `${r.satName} · ${r.productName}`;
    this.$('r3dSub').textContent = '3D';
    this.$('r3dWait').classList.add('hidden');
    this.toast('Preparing the 3D view…');
    this.busy(true);
    const keep = this.S ? this.cameraGeo() : null;
    try {
      const noiseP = getNoise();
      const d = await this.opts.fields(r, (msg) => { if (seq === this.seq) this.toast(msg); });
      if (seq !== this.seq || this.disposed) return;
      const [w, s, e, n] = d.bbox, [gw, gs, ge, gn] = d.ground_bbox;
      const bw = e - w, bh = n - s;
      const outer = [w - 3 * bw - 2, Math.max(-84, s - 3 * bh - 2), e + 3 * bw + 2, Math.min(84, n + 3 * bh + 2)];
      // free satellite imagery for the ground (Esri World Imagery, 256 px tiles)
      const sat = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
      this.toast('Loading terrain imagery…');
      const prodUrl = r.prodTile || null;
      const [inner, out, prod, noise] = await Promise.all([
        stitchTiles([gw, gs, ge, gn], this.opts.maxTex || 4096, { url: sat, tile: 256, maxZoom: 17, maxTiles: 160 }, (a, b) => { if (seq === this.seq) this.toast(`Loading terrain imagery… ${a}/${b}`); }),
        stitchTiles(outer, 2048, { url: sat, tile: 256, maxTiles: 60 }),
        prodUrl ? stitchTiles([w, s, e, n], 2048, { url: prodUrl, maxZoom: r.prodMaxZoom || 8, fill: null, maxTiles: 64, tile: r.prodTileSize || 512 }) : null,
        noiseP,
      ]);
      if (seq !== this.seq || this.disposed) return;
      this.buildScene(d, inner, out, prod, noise, keep);
      this.toast(null);
      this.busy(false);
      if (this.params.framesMode !== 'single') this.loadLoop();
    } catch (e) {
      if (seq !== this.seq || this.disposed) return;
      console.error(e);
      this.busy(false);
      this.toast(`3D view failed: ${e.message}`, { spin: false, ms: 8000 });
      if (!this.S) this.setWaiting('Could not build the 3D view', e.message);
      if (this.opts.onError) this.opts.onError(e);
    }
  }

  clearRegion() {
    if (this.vr.presenting) this.vr.exit();
    ++this.seq;
    this.stopPlay();
    this.disposeScene();
    this.toast(null);
    this.busy(false);
    this.$('r3dSub').textContent = '';
    this.$('r3dFrame').classList.add('hidden');
    this.setWaiting();
    if (this.opts.onCamera) this.opts.onCamera(null);
  }

  // ---------------------------------------------------------------- scene (per region)
  buildScene(d, inner, outer, prod, noise, keep) {
    this.disposeScene();
    const r = this.renderer, U = this.U, p = this.params;
    const [w, s, e, n] = d.bbox;
    const [lonc, latc] = d.center;
    const kx = d.kx, ky = d.ky;
    const X = (lon) => (lon - lonc) * kx, Z = (lat) => (latc - lat) * ky;
    const [gw, gs, ge, gn] = d.ground_bbox;
    const S = this.S = {
      d, stats: d.stats, sun: d.sun, grid: d.grid, geo: { lonc, latc, kx, ky },
      box: [X(w), Z(n), X(e), Z(s)], gbox: [X(gw), Z(gn), X(ge), Z(gs)],
      textures: [], disposables: [],
    };
    const [nx, ny] = d.grid;
    S.mask = this.buildMask(nx, ny, d.bbox, this.region.polygon);

    // noise (kept across regions)
    if (!this.shapeTex) {
      const n3 = (data, N, fmt) => {
        const t = new THREE.Data3DTexture(data, N, N, N);
        t.format = fmt; t.type = THREE.UnsignedByteType;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = true;
        t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
        t.unpackAlignment = 1;
        t.needsUpdate = true;
        return t;
      };
      this.shapeTex = n3(noise.shape, noise.s, THREE.RGBAFormat);
      this.detailTex = n3(noise.detail, noise.d, THREE.RedFormat);
    }

    // the shown frame
    const base = this.makeFrame(d, this.region.time || d.time, this.region.sceneId);
    this.frames = [base];
    this.fi = 0;

    // terrain grid
    const [enx, eny] = d.elev_grid;
    const ev = b64ToU16(d.elev);
    S.elev = { data: Float32Array.from(ev, (h) => fromH(h)), nx: enx, ny: eny };
    S.elevTex = this.dataTex(ev, enx, eny, THREE.RedFormat);
    let sum = 0, cnt = 0;
    const E = S.elev.data;
    for (let i = 0; i < enx; i++) { sum += E[i] + E[(eny - 1) * enx + i]; cnt += 2; }
    for (let j = 0; j < eny; j++) { sum += E[j * enx] + E[j * enx + enx - 1]; cnt += 2; }
    S.baseElev = sum / cnt;
    // mean diffuse transmittance of the area: how overcast it is (tints haze and ambient)
    let td = 0, tw = 0;
    for (let i = 0; i < nx * ny; i++) {
      const m = S.mask ? S.mask[i] : 1;
      td += m / (1 + 0.11 * fromH(base.f2[i * 4 + 2])); tw += m;
    }
    S.overcast = S.overcastBox = tw > 0 ? td / tw : 1;

    const imgTex = (im) => {
      const t = new THREE.CanvasTexture(im.canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.anisotropy = r.capabilities.getMaxAnisotropy();
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      S.textures.push(t);
      return t;
    };
    const innerTex = imgTex(inner), outerTex = imgTex(outer);
    S.prodTex = prod ? imgTex(prod) : null;
    if (S.prodTex) { S.prodTex.anisotropy = 1; S.prodTex.minFilter = THREE.LinearFilter; S.prodTex.generateMipmaps = false; }

    // shared uniforms
    U.uShape.value = this.shapeTex; U.uDetail.value = this.detailTex;
    U.uBox.value.set(...S.box);
    U.uGeo.value.set(lonc, latc, kx, ky);
    U.uCellKm.value = d.cell_km;
    this.bindFrames(base, null, 0);
    this.rebuildBlocks();

    // terrain meshes
    const terrMat = (outerFlag, img, tex) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS,
      uniforms: {
        ...U,
        uElev: { value: S.elevTex }, uElevTexel: { value: new THREE.Vector2(1 / enx, 1 / eny) },
        uGround: { value: new THREE.Vector4(...S.gbox) }, uBaseElev: { value: S.baseElev }, uOuter: { value: outerFlag },
        uImg: { value: tex }, uImgGeo: { value: new THREE.Vector4(img.lonW, img.lonE, img.mercN, img.mercS) },
      },
    });
    S.terrainScene = new THREE.Scene();
    const gwk = S.gbox[2] - S.gbox[0], ghk = S.gbox[3] - S.gbox[1];
    const seg = Math.min(700, Math.max(enx, eny));
    const gi = new THREE.PlaneGeometry(gwk, ghk, Math.round(seg * gwk / Math.max(gwk, ghk)), Math.round(seg * ghk / Math.max(gwk, ghk)));
    gi.rotateX(-Math.PI / 2);
    gi.translate((S.gbox[0] + S.gbox[2]) / 2, 0, (S.gbox[1] + S.gbox[3]) / 2);
    const innerMesh = new THREE.Mesh(gi, terrMat(0, inner, innerTex)); innerMesh.frustumCulled = false;
    const oX0 = X(outer.lonW), oX1 = X(outer.lonE);
    const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * outer.mercS))) * 180 / Math.PI;
    const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * outer.mercN))) * 180 / Math.PI;
    const oZ0 = Z(latN), oZ1 = Z(latS);
    const go = new THREE.PlaneGeometry(oX1 - oX0, oZ1 - oZ0, 260, 260);
    go.rotateX(-Math.PI / 2);
    go.translate((oX0 + oX1) / 2, 0, (oZ0 + oZ1) / 2);
    const outerMesh = new THREE.Mesh(go, terrMat(1, outer, outerTex)); outerMesh.frustumCulled = false;
    S.terrainScene.add(innerMesh, outerMesh);

    const cu = this.cloudMat.uniforms;
    cu.uOvercast.value = S.overcast;
    cu.uProd.value = S.prodTex || this.blankTex;
    if (prod) cu.uProdGeo.value.set(prod.lonW, prod.lonE, prod.mercN, prod.mercS);

    S.diag = Math.hypot(S.box[2] - S.box[0], S.box[3] - S.box[1]);
    this.controls.maxDistance = S.diag * 4;
    if (p.sunAuto) { p.sunElev = d.sun.elev; p.sunAzim = d.sun.azim; }
    this.daylightFallback();
    this.fillInfo();
    this.applyBase();
    this.updateSun();
    this.resize();
    if (keep && this.restoreCamera(keep)) this.updateLocalSky(true);
    else this.setView('overview');
    this.syncControls();
    this.showFrameLabel();
    this.emitCamera(true);
  }

  disposeScene() {
    const S = this.S;
    if (!S) return;
    this.S = null;
    for (const f of this.frames) this.freeFrame(f);
    this.frames = [];
    for (const t of S.textures) t.dispose();
    if (S.elevTex) S.elevTex.dispose();
    if (S.blocks) { S.blocks.tex.dispose(); S.blocks.env.dispose(); }
    if (S.terrainScene) S.terrainScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }

  dataTex(u16, w, h, fmt) {
    const t = new THREE.DataTexture(u16, w, h, fmt, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  }

  // drawn area -> soft 0..1 mask on the cloud grid (null for a plain box)
  buildMask(nx, ny, bbox, poly) {
    if (!poly || poly.length < 3) return null;
    const [w, s, e, n] = bbox;
    const c = document.createElement('canvas');
    c.width = nx; c.height = ny;
    const g = c.getContext('2d');
    g.filter = 'blur(1.2px)';
    g.fillStyle = '#fff';
    g.beginPath();
    poly.forEach(([lon, lat], i) => {
      let L = lon;
      while (L < w - 180) L += 360;
      while (L > w + 180) L -= 360;
      const x = (L - w) / (e - w) * nx, y = (n - lat) / (n - s) * ny;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.closePath();
    g.fill();
    const px = g.getImageData(0, 0, nx, ny).data;
    const m = new Float32Array(nx * ny);
    for (let i = 0; i < m.length; i++) m[i] = px[i * 4 + 3] / 255;
    return m;
  }

  // ---------------------------------------------------------------- frames (fields of one scan)
  makeFrame(d, time, sceneId) {
    const fr = { time, sceneId, ok: true, stats: d.stats, grid: d.grid,
      f1o: b64ToU16(d.field1), f2o: b64ToU16(d.field2), f3: d.field3 ? b64ToU16(d.field3) : null };
    this.prepFrame(fr);
    return fr;
  }

  // apply the drawn-area mask and a set cloud base to a frame's fields; (re)upload the textures
  prepFrame(fr) {
    const [nx, ny] = fr.grid, N = nx * ny, p = this.params;
    const mask = this.S && this.S.mask;
    const f1 = new Uint16Array(fr.f1o), f2 = new Uint16Array(fr.f2o);
    if (mask) for (let i = 0; i < N; i++) f2[i * 4 + 3] = toH(fromH(f2[i * 4 + 3]) * mask[i]);
    if (!p.baseAuto && fr.f3) {
      // cumulus / deep-column bases sit at the retrieved LCL: move them to the chosen height
      for (let i = 0; i < N; i++) {
        const base = fromH(f1[i * 4 + 1]), lcl = fromH(fr.f3[i * 2]);
        const wgt = 1 - sstep(lcl + 0.1, lcl + 0.8, base);
        if (wgt <= 0) continue;
        const top = fromH(f1[i * 4]), zg = fromH(fr.f3[i * 2 + 1]);
        const nb = clamp(base + (zg + p.baseKm - lcl) * wgt, zg + 0.05, Math.max(zg + 0.05, top - 0.15));
        f1[i * 4 + 1] = toH(nb);
      }
    }
    fr.f1 = f1; fr.f2 = f2;
    if (fr.tex1) {
      fr.tex1.image.data = f1; fr.tex1.needsUpdate = true;
      fr.tex2.image.data = f2; fr.tex2.needsUpdate = true;
    } else {
      fr.tex1 = this.dataTex(f1, nx, ny, THREE.RGBAFormat);
      fr.tex2 = this.dataTex(f2, nx, ny, THREE.RGBAFormat);
    }
  }

  freeFrame(f) {
    if (f.tex1) f.tex1.dispose();
    if (f.tex2) f.tex2.dispose();
    f.tex1 = f.tex2 = null;
  }

  applyBase() {
    if (!this.S) return;
    for (const f of this.frames) if (f.ok && f.f1o) this.prepFrame(f);
    this.rebuildBlocks();
    this.touch();
  }

  bindFrames(a, b, mix) {
    const U = this.U;
    U.uField.value = a.tex1; U.uField2.value = a.tex2;
    const bb = b && b.ok ? b : a;
    U.uFieldB.value = bb.tex1; U.uField2B.value = bb.tex2;
    U.uMix.value = b && b.ok ? mix : 0;
  }

  // Acceleration grids for the ray march, over every loaded loop frame (so blending between frames
  // never escapes them): per cell, the altitude envelope that noise can push cloud into, dilated by
  // how far the shader's domain warp (plus the bilinear lookup) can reach, so nothing outside it
  // can ever hold cloud; and the same per 8x8 block of cells for long jumps through clear air.
  rebuildBlocks() {
    const S = this.S;
    if (!S) return;
    const [nx, ny] = S.grid, B = 8;
    const bx = Math.ceil(nx / B), by = Math.ceil(ny / B);
    const top = new Float32Array(nx * ny).fill(-100), base = new Float32Array(nx * ny).fill(100);
    const ext = new Float32Array(nx * ny), rain = new Float32Array(nx * ny);
    let lo = Infinity, hi = -Infinity;
    for (const f of this.frames) {
      if (!f.ok || !f.f1) continue;
      lo = Math.min(lo, f.stats.alt_lo); hi = Math.max(hi, f.stats.alt_hi);
      const f1 = f.f1, f2 = f.f2;
      for (let i = 0; i < nx * ny; i++) {
        const m = fromH(f2[i * 4 + 3]);
        if (m < 0.02) continue;
        const e = fromH(f1[i * 4 + 2]);
        const rr = fromH(f2[i * 4]);
        if (rr > rain[i]) rain[i] = rr;
        if (e < 0.015) continue;
        if (e > ext[i]) ext[i] = e;
        // highest / lowest point cloudDensity() can reach in this column (its noise amplitudes)
        const t = fromH(f1[i * 4]), b = fromH(f1[i * 4 + 1]), th = Math.max(t - b, 0.08);
        const tt = t + 0.6 * Math.min(th, 4) + 0.4 * Math.min(th, 2.5) + 0.25;
        const bb = b - 0.13 * Math.min(th, 2) - 0.25 * Math.min(th, 1.6) - 0.6;
        if (tt > top[i]) top[i] = tt;
        if (bb < base[i]) base[i] = bb;
      }
    }
    // the domain warp moves a lookup by up to 1.2 cells + half of max(1.4 km, 1.2 cells) per axis
    const cell = S.d.cell_km;
    const R = Math.ceil(1.2 + 0.5 * Math.max(1.4 / cell, 1.2) + 1.2);
    for (let i = 0; i < nx * ny; i++) if (ext[i] < 0.015) { top[i] = -100; base[i] = 100; }
    const dTop = dilate2d(top, nx, ny, R, Math.max), dBase = dilate2d(base, nx, ny, R, Math.min);
    const dExt = dilate2d(ext, nx, ny, R, Math.max), dRain = dilate2d(rain, nx, ny, R, Math.max);
    const env = new Uint16Array(nx * ny * 4);
    for (let i = 0; i < nx * ny; i++) {
      env[i * 4] = toH(dTop[i]); env[i * 4 + 1] = toH(dBase[i]); env[i * 4 + 2] = toH(dExt[i]); env[i * 4 + 3] = toH(dRain[i]);
    }
    const out = new Uint16Array(bx * by * 4);
    for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
      let mt = -100, mb = 100, me = 0, mr = 0;
      for (let y = j * B; y < Math.min(ny, (j + 1) * B); y++) {
        for (let x = i * B; x < Math.min(nx, (i + 1) * B); x++) {
          const k = y * nx + x;
          if (dRain[k] > mr) mr = dRain[k];
          if (dExt[k] < 0.015) continue;
          if (dExt[k] > me) me = dExt[k];
          if (dTop[k] > mt) mt = dTop[k];
          if (dBase[k] < mb) mb = dBase[k];
        }
      }
      const o = (j * bx + i) * 4;
      out[o] = toH(mt); out[o + 1] = toH(mb); out[o + 2] = toH(me); out[o + 3] = toH(mr);
    }
    const grid = (data, w, h) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      return t;
    };
    if (S.blocks) { S.blocks.tex.dispose(); S.blocks.env.dispose(); }
    S.blocks = { tex: grid(out, bx, by), env: grid(env, nx, ny), nx: bx, ny: by };
    const cu = this.cloudMat.uniforms;
    cu.uBlocks.value = S.blocks.tex;
    cu.uBlockN.value.set(bx, by);
    cu.uEnv.value = S.blocks.env;
    cu.uCellN.value.set(nx, ny);
    if (Number.isFinite(lo)) this.U.uAlt.value.set(lo, hi);
    this.touch();
  }

  // ---------------------------------------------------------------- loop frames
  async loadLoop() {
    if (!this.S || !this.opts.getFrames) return;
    const seq = this.seq, S = this.S;
    let list = (this.opts.getFrames() || []).filter((f) => f.sceneId);
    if (list.length > MAX_LOOP) list = list.slice(-MAX_LOOP);
    const note = this.$('r3dFramesNote');
    if (list.length < 2) {
      note.textContent = 'The map has no loop loaded: pick a loop length on the timeline (e.g. 12 frames), then choose Loop again.';
      return;
    }
    const have = new Map(this.frames.map((f) => [f.time, f]));
    const shown = this.frames[this.fi];
    this.frames = list.map((f) => have.get(f.time) || { time: f.time, sceneId: f.sceneId, ok: false, pending: true });
    if (!this.frames.includes(shown)) { this.frames.push(shown); this.frames.sort((a, b) => (a.time < b.time ? -1 : 1)); }
    for (const f of have.values()) if (!this.frames.includes(f)) this.freeFrame(f);
    this.fi = this.frames.indexOf(shown);
    const todo = this.frames.filter((f) => f.pending);
    const n = this.frames.length;
    const report = () => {
      const ok = this.frames.filter((f) => f.ok).length;
      note.textContent = ok < n ? `Loading loop frames ${ok}/${n}…` : `${ok} frames ready — press play (top right).`;
      this.syncControls();
      if (ok < n) this.toast(`Loading loop frames ${ok}/${n}…`); else this.toast(`${ok} frames ready`, { spin: false, ms: 2500 });
    };
    report();
    let blocksT = null;
    const worker = async () => {
      while (todo.length) {
        const f = todo.shift();
        try {
          const d = await this.opts.fields({ ...this.region, sceneId: f.sceneId, time: f.time });
          if (seq !== this.seq || this.S !== S) return;
          f.pending = false;
          if (d.grid[0] !== S.grid[0] || d.grid[1] !== S.grid[1]) { f.bad = true; continue; }
          Object.assign(f, { ok: true, stats: d.stats, grid: d.grid, f1o: b64ToU16(d.field1), f2o: b64ToU16(d.field2), f3: d.field3 ? b64ToU16(d.field3) : null });
          this.prepFrame(f);
          clearTimeout(blocksT);
          blocksT = setTimeout(() => this.rebuildBlocks(), 300);
        } catch (e) {
          f.pending = false; f.bad = true;
          console.warn('3D loop frame', f.time, e);
        }
        if (seq !== this.seq) return;
        report();
      }
    };
    await Promise.all([worker(), worker()]);
    if (seq !== this.seq || this.S !== S) return;
    // frames that failed or whose grid differs are left out of the loop
    const shownNow = this.frames[this.fi];
    this.frames = this.frames.filter((f) => f.ok);
    this.fi = Math.max(0, this.frames.indexOf(shownNow));
    this.rebuildBlocks();
    report();
  }

  dropLoop() {
    this.stopPlay();
    if (!this.frames.length) return;
    const keep = this.frames.find((f) => f.sceneId === (this.region && this.region.sceneId)) || this.frames[this.fi];
    for (const f of this.frames) if (f !== keep) this.freeFrame(f);
    this.frames = keep ? [keep] : [];
    this.fi = 0;
    if (keep && keep.ok) this.bindFrames(keep, null, 0);
    this.rebuildBlocks();
    this.showFrameLabel();
    this.$('r3dFramesNote').textContent = "Plays the map's loop frames (set the loop length on the timeline) in 3D. Interpolated playback morphs the clouds between scans.";
  }

  togglePlay() { if (this.playing) this.stopPlay(); else this.startPlay(); }

  startPlay() {
    const ok = this.frames.filter((f) => f.ok);
    if (ok.length < 2) {
      if (this.params.framesMode === 'single') { this.params.framesMode = 'interp'; this.changed(); }
      this.loadLoop();
      this.toast('Loading loop frames first…', { spin: true, ms: 2500 });
      return;
    }
    this.playing = true;
    this.playT = this.fi * this.params.speed;
    this.$('r3dPlay').innerHTML = IC.pause;
    this.$('r3dPlay').classList.add('on');
  }

  stopPlay() {
    if (!this.playing) return;
    this.playing = false;
    this.$('r3dPlay').innerHTML = IC.play;
    this.$('r3dPlay').classList.remove('on');
    const f = this.frames[this.fi];
    if (f && f.ok) this.bindFrames(f, null, 0);
    this.touch();
  }

  advancePlay(dt) {
    const fr = this.frames.filter((f) => f.ok);
    const n = fr.length;
    if (n < 2) { this.stopPlay(); return; }
    const dwell = this.params.speed, hold = 3;
    this.playT += dt * 1000;
    const L = n - 1 + hold;
    const u = (this.playT / dwell) % L;
    let i, mix = 0;
    if (u < n - 1) { i = Math.floor(u); mix = u - i; } else { i = n - 1; }
    const interp = this.params.framesMode === 'interp';
    const a = fr[i], b = interp && i < n - 1 ? fr[i + 1] : null;
    this.bindFrames(a, b, interp ? mix : 0);
    const idx = this.frames.indexOf(a);
    if (idx !== this.fi) {
      this.fi = idx;
      this.showFrameLabel();
      if (this.opts.onFrame) this.opts.onFrame(a.time);
    }
    this.touch();
  }

  showFrameLabel() {
    const f = this.frames[this.fi];
    const lab = this.$('r3dFrame');
    if (!f || !this.S) { lab.classList.add('hidden'); return; }
    const t = new Date(f.time);
    const p2 = (v) => String(v).padStart(2, '0');
    const n = this.frames.length;
    lab.textContent = `${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}Z${n > 1 ? `  ${this.fi + 1}/${n}` : ''}`;
    lab.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- info + sun
  daylightFallback() {
    const S = this.S, p = this.params;
    const note = this.$('r3dSunNote');
    note.textContent = '';
    if (!S) return;
    if (S.sun.elev < 3 && p.sunAuto) {
      p.sunAuto = false;
      p.sunElev = 30; p.sunAzim = (S.sun.azim + 180) % 360;
      note.textContent = `The sun was ${S.sun.elev < -6 ? 'down' : 'low'} (${S.sun.elev.toFixed(0)}°) at scan time; showing artificial daylight. Tick “Sun at scan time” for the real lighting.`;
    }
  }

  fillInfo() {
    const d = this.S.d, s = d.stats;
    const src = d.sources.find((x) => x.role === 'ir') || {};
    const rows = [
      ['Area', `${d.km[0].toFixed(0)} × ${d.km[1].toFixed(0)} km${this.region.polygon ? ' (clipped to area)' : ''}`],
      ['Cloud cover', `${(s.cloud_frac * 100).toFixed(0)}%`],
      ['Cloud tops', s.cloud_frac > 0 ? `${s.mean_top_km.toFixed(1)} km mean · ${s.max_top_km.toFixed(1)} km max` : '—'],
      ['Cloud bases', s.cloud_frac > 0 && s.mean_base_km !== undefined ? `${s.mean_base_km.toFixed(1)} km mean · LCL ${s.lcl_km.toFixed(1)} km` : '—'],
      ['Cloud depth', s.cloud_frac > 0 && s.mean_depth_km !== undefined ? `${s.mean_depth_km.toFixed(1)} km mean` : '—'],
      ['Optical depth', s.cloud_frac > 0 ? `${s.mean_tau.toFixed(1)} mean · ${s.max_tau.toFixed(0)} max` : '—'],
      ['Surface temp', `${s.t_sfc_k.toFixed(0)} K (${(s.t_sfc_k - 273.15).toFixed(0)} °C)`],
      ['Coldest top', `${s.min_bt_k.toFixed(0)} K (${(s.min_bt_k - 273.15).toFixed(0)} °C)`],
      ['Tropopause', `~${s.tropopause_km.toFixed(1)} km`],
      ['Grid', `${d.grid[0]}×${d.grid[1]} · ${d.cell_km.toFixed(2)} km cells`],
      ['Bands', d.sources.map((x) => x.product.toUpperCase()).join(' ')],
      ['Source', src.source || '—'],
      ['Lighting', s.day_frac > 0.5 ? 'Day — visible + IR' : s.day_frac > 0.05 ? 'Low sun — visible + IR' : 'Night / low sun — IR'],
    ];
    if (s.coverage < 0.98) rows.push(['Coverage', `${(s.coverage * 100).toFixed(0)}% of box has data`]);
    this.$('r3dStats').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');
  }

  updateSun() {
    if (!this.S) { this.syncControls(); return; }
    const p = this.params;
    const el_ = p.sunElev, az = p.sunAzim;
    const e = el_ * Math.PI / 180, a = az * Math.PI / 180;
    const dir = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
    this.U.uSunDir.value.copy(dir);
    this.skyMat.uniforms.uSunDir.value.copy(dir);
    const tr = sunTransmittance(el_);
    // sun just below the horizon still lights high cloud tops; ground is in shadow
    const vis = clamp((el_ + 3) / 4, 0, 1);
    this.U.uSunColor.value.set(tr[0] * I_SUN, tr[1] * I_SUN, tr[2] * I_SUN);
    this.U.uSunVisible.value = vis;
    if (el_ < 0) {
      const lift = sunTransmittance(0.3);
      this.U.uSunColor.value.set(lift[0] * I_SUN * 0.6, lift[1] * I_SUN * 0.45, lift[2] * I_SUN * 0.35);
    }
    // render the sky LUT and read it back for the ambient terms
    const r = this.renderer;
    r.setRenderTarget(this.skyRT);
    r.render(this.skyScene, this.quadCam);
    const px = new Float32Array(SKY_W * SKY_H * 4);
    r.readRenderTargetPixels(this.skyRT, 0, 0, SKY_W, SKY_H, px);
    r.setRenderTarget(null);
    let avg = [0, 0, 0], irr = [0, 0, 0], wsum = 0;
    for (let j = 0; j < SKY_H; j++) {
      const v = (j + 0.5) / SKY_H, elv = v * v * Math.PI / 2;
      const dOmega = Math.cos(elv) * (2 * v * Math.PI / 2 / SKY_H) * (2 * Math.PI / SKY_W);
      for (let i = 0; i < SKY_W; i++) {
        const k = (j * SKY_W + i) * 4;
        for (let c = 0; c < 3; c++) { avg[c] += px[k + c] * dOmega; irr[c] += px[k + c] * Math.sin(elv) * dOmega; }
        wsum += dOmega;
      }
    }
    avg = avg.map((v) => v / wsum);
    const oc = this.S.overcast;
    // under an overcast deck the sky seen from inside / below the clouds is the cloud base
    const grey = (v) => { const l = 0.3 * v[0] + 0.5 * v[1] + 0.2 * v[2]; return v.map((x) => x * oc + l * (1 - oc) * 0.8); };
    const skyAvg = grey(avg), skyIrr = grey(irr);
    this.U.uSkyAmb.value.set(skyAvg[0] * 0.6, skyAvg[1] * 0.6, skyAvg[2] * 0.6);
    this.U.uSkyIrr.value.set(...skyIrr);
    const sc = this.U.uSunColor.value, mu = Math.max(0, Math.sin(e)) * vis;
    // radiance of the cloud walls around the camera: albedo ~0.7, about half of them sunlit
    const wl = 0.7 / Math.PI * vis * clamp(Math.sin(e) + 0.25, 0, 1) * (this.S.wall || 0) * 0.5;
    this.U.uBounce.value.set(sc.x * wl, sc.y * wl, sc.z * wl);
    const alb = 0.16;
    // light reflected by the ground below the clouds (isotropic radiance, half the sphere)
    this.U.uGroundAmb.value.set(
      alb * (sc.x * mu * (0.35 + 0.65 * oc) + skyIrr[0]) / Math.PI * 0.5,
      alb * (sc.y * mu * (0.35 + 0.65 * oc) + skyIrr[1]) / Math.PI * 0.5,
      alb * (sc.z * mu * (0.35 + 0.65 * oc) + skyIrr[2]) / Math.PI * 0.5);
    this.syncControls();
    this.touch();
  }

  touch() { this.version++; }

  // ---------------------------------------------------------------- render targets
  resize() {
    if (!this.renderer || this.disposed || this.renderer.xr.isPresenting) return;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (!W || !H) return;
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    const q = QUALITY[this.params.quality];
    const mk = (w, h, type) => {
      const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), { type, depthBuffer: type === THREE.FloatType });
      // float32 targets are read 1:1 (float linear filtering is an optional extension)
      rt.texture.minFilter = rt.texture.magFilter = type === THREE.FloatType ? THREE.NearestFilter : THREE.LinearFilter;
      return rt;
    };
    for (const k of ['terrRT', 'terrLoRT', 'accA', 'accB', 'loRT']) if (this[k]) this[k].dispose();
    const fw = W * q.scale, fh = H * q.scale;
    this.terrRT = mk(fw, fh, THREE.FloatType);
    this.accA = mk(fw, fh, THREE.HalfFloatType);
    this.accB = mk(fw, fh, THREE.HalfFloatType);
    const ms = q.moveScale * (this.moveDyn || 1);
    this.terrLoRT = mk(W * ms, H * ms, THREE.FloatType);
    this.loRT = mk(W * ms, H * ms, THREE.HalfFloatType);
    this.touch();
  }

  // Weak GPUs: while the camera moves, the interactive render drops resolution until it keeps up
  // (~22 fps) and climbs back when there is headroom.
  adaptMove(dt) {
    this.moveEma = this.moveEma ? this.moveEma * 0.85 + dt * 0.15 : dt;
    this.moveAdaptT = (this.moveAdaptT || 0) + dt;
    if (this.moveAdaptT < 0.4) return;
    this.moveAdaptT = 0;
    const old = this.moveDyn || 1;
    let d = old;
    if (this.moveEma > 1 / 22) d = Math.max(0.4, d * 0.85);
    else if (this.moveEma < 1 / 45) d = Math.min(1, d * 1.08);
    if (Math.abs(d - old) / old > 0.06) { this.moveDyn = d; this.resize(); }
  }

  // ---------------------------------------------------------------- camera
  groundAt(x, z) {
    const S = this.S, g = S.gbox, E = S.elev;
    const u = (x - g[0]) / (g[2] - g[0]), v = (z - g[1]) / (g[3] - g[1]);
    if (u < 0 || v < 0 || u > 1 || v > 1) return S.baseElev;
    const fx = u * E.nx - 0.5, fy = v * E.ny - 0.5;
    const x0 = clamp(Math.floor(fx), 0, E.nx - 1), y0 = clamp(Math.floor(fy), 0, E.ny - 1);
    const x1 = Math.min(E.nx - 1, x0 + 1), y1 = Math.min(E.ny - 1, y0 + 1);
    const tx = clamp(fx - x0, 0, 1), ty = clamp(fy - y0, 0, 1);
    const a = E.data[y0 * E.nx + x0], b = E.data[y0 * E.nx + x1], c = E.data[y1 * E.nx + x0], d = E.data[y1 * E.nx + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  shownFields() { const f = this.frames[this.fi]; return f && f.ok ? f : this.frames.find((x) => x.ok); }

  tallest() {
    const S = this.S, [nx, ny] = S.grid, fr = this.shownFields(), b = S.box;
    let best = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 2], bt = -1;
    if (!fr) return best;
    for (let j = 4; j < ny - 4; j += 2) for (let i = 4; i < nx - 4; i += 2) {
      const k = (j * nx + i) * 4;
      if (fromH(fr.f1[k + 2]) < 1 || fromH(fr.f2[k + 3]) < 0.5) continue;
      const t = fromH(fr.f1[k]);
      if (t > bt) { bt = t; best = [b[0] + (i + 0.5) / nx * (b[2] - b[0]), b[1] + (j + 0.5) / ny * (b[3] - b[1]), t]; }
    }
    return best;
  }

  // A clearing enclosed by tall cloud (a tropical cyclone's eye, a gap in a storm complex):
  // the clear cell with tall cloud in the most directions around it. Null when nothing is enclosed.
  clearing() {
    const S = this.S, fr = this.shownFields();
    if (!fr) return null;
    const [nx, ny] = S.grid, b = S.box;
    const st = Math.max(1, Math.round(Math.max(nx, ny) / 140));
    const gx = Math.floor(nx / st), gy = Math.floor(ny / st);
    const ck = S.d.cell_km * st;
    const tall = new Float32Array(gx * gy), clear = new Uint8Array(gx * gy);
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
      const c = (j * st + (st >> 1)) * nx + i * st + (st >> 1), k = c * 4;
      const m = fromH(fr.f2[k + 3]), tau = fromH(fr.f2[k + 2]), top = fromH(fr.f1[k]);
      if (m < 0.5) continue;
      const zg = fr.f3 ? fromH(fr.f3[c * 2 + 1]) : 0;
      if (tau > 8 && top > 6) tall[j * gx + i] = top;
      // clear air, or only low cloud below (an eye's floor of sunlit stratocumulus)
      else if (tau < 3 || top - zg < 2.5) clear[j * gx + i] = 1;
    }
    const R = Math.max(3, Math.round(40 / ck)), edge = Math.round(R * 0.4);
    let topMax = 0;
    for (const t of tall) if (t > topMax) topMax = t;
    let best = null;
    const sd = new Float32Array(12), st_ = new Float32Array(12);
    for (let j = edge; j < gy - edge; j++) for (let i = edge; i < gx - edge; i++) {
      if (!clear[j * gx + i]) continue;
      sd.fill(Infinity); st_.fill(0);
      let near = Infinity, nearDir = null;
      for (let dj = -R; dj <= R; dj++) {
        const y = j + dj;
        if (y < 0 || y >= gy) continue;
        for (let di = -R; di <= R; di++) {
          const x = i + di;
          if (x < 0 || x >= gx) continue;
          const t = tall[y * gx + x];
          if (!t) continue;
          const r = Math.hypot(di, dj);
          if (r > R || r < 1) continue;
          const s = Math.floor(((Math.atan2(dj, di) + Math.PI) / (2 * Math.PI)) * 12) % 12;
          if (r < sd[s]) { sd[s] = r; st_[s] = t; }
          if (r < near) { near = r; nearDir = [di, dj, t]; }
        }
      }
      let n = 0, md = 0, md2 = 0, mt = 0;
      for (let s = 0; s < 12; s++) if (sd[s] < Infinity) { n++; md += sd[s]; md2 += sd[s] * sd[s]; mt += st_[s]; }
      if (n < 10) continue;
      md /= n; mt /= n;
      const sdev = Math.sqrt(Math.max(md2 / n - md * md, 0));
      // an eye: ringed on every side, close and at even distances (its centre), by the tallest
      // cloud of the area
      const score = n + 4 * mt / Math.max(topMax, 1) - 3 * md / R - 4 * sdev / R;
      if (!best || score > best.score) {
        best = { score, x: b[0] + (i * st + st / 2) / nx * (b[2] - b[0]), z: b[1] + (j * st + st / 2) / ny * (b[3] - b[1]),
          dir: nearDir, dist: near * ck, top: nearDir[2], ci: i, cj: j, R };
      }
    }
    if (!best) return null;
    // local cloudiness (for the ambient light): mean column transmittance within the clearing radius
    let td = 0, c = 0;
    const rr = Math.max(2, Math.round(best.dist / ck));
    for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
      const x = best.ci + di, y = best.cj + dj;
      if (x < 0 || y < 0 || x >= gx || y >= gy || Math.hypot(di, dj) > rr) continue;
      const k = ((y * st) * nx + x * st) * 4;
      td += 1 / (1 + 0.11 * fromH(fr.f2[k + 2])); c++;
    }
    best.overcast = c ? td / c : 1;
    return best;
  }

  cameraGeo() {
    const g = this.S.geo, c = this.camera.position, t = this.controls.target, v = this.params.vex;
    return { lon: g.lonc + c.x / g.kx, lat: g.latc - c.z / g.ky, alt: c.y / v,
      tlon: g.lonc + t.x / g.kx, tlat: g.latc - t.z / g.ky, talt: t.y / v };
  }

  restoreCamera(k) {
    const S = this.S, g = S.geo, b = S.box, v = this.params.vex;
    const tx = (k.tlon - g.lonc) * g.kx, tz = (g.latc - k.tlat) * g.ky;
    const pw = (b[2] - b[0]) * 0.3, ph = (b[3] - b[1]) * 0.3;
    if (tx < b[0] - pw || tx > b[2] + pw || tz < b[1] - ph || tz > b[3] + ph) return false;
    this.camera.position.set((k.lon - g.lonc) * g.kx, k.alt * v, (g.latc - k.lat) * g.ky);
    this.controls.target.set(tx, k.talt * v, tz);
    this.controls.update();
    this.touch();
    return true;
  }

  setCameraLonLat(lon, lat) {
    if (!this.S) return;
    const g = this.S.geo, cam = this.camera, v = this.params.vex;
    const x = (lon - g.lonc) * g.kx, z = (g.latc - lat) * g.ky;
    const alt = cam.position.y / v - this.groundAt(cam.position.x, cam.position.z);
    const dx = x - cam.position.x, dz = z - cam.position.z;
    cam.position.x += dx; cam.position.z += dz;
    this.controls.target.x += dx; this.controls.target.z += dz;
    const ny = (this.groundAt(x, z) + Math.max(alt, 0.002)) * v;
    this.controls.target.y += ny - cam.position.y;
    cam.position.y = ny;
    this.controls.update();
    this.touch();
  }

  setView(v) {
    const S = this.S, b = S.box, vex = this.params.vex;
    const cx = (b[0] + b[2]) / 2, cz = (b[1] + b[3]) / 2;
    const bw = b[2] - b[0], bh = b[3] - b[1];
    const midAlt = clamp((S.stats.mean_top_km || 2) * 0.55, 1, 8);
    const cam = this.camera, ctl = this.controls;
    const eye = v === 'ground' || v === 'recon' ? this.clearing() : null;
    if (v === 'recon' && !eye) {
      v = 'tallest';
      this.toast('No eye or enclosed clearing in this area — showing the tallest cloud', { spin: false, ms: 3500 });
    }
    if (eye) {
      // in the middle of the clearing with the sun behind, looking at the sunlit side of the wall
      // (the view from inside an eye): on the sea surface (Ground) or at a hurricane hunter's
      // ~3 km flight level (Recon), where the stadium-shaped bowl of the eyewall shows
      const g = this.groundAt(eye.x, eye.z);
      const a = this.params.sunAzim * Math.PI / 180;
      const ux = -Math.sin(a), uz = Math.cos(a);
      const h = v === 'recon' ? 3.0 : 0.004;
      // back up toward the shaded (sun-side) wall, so the view crosses the whole eye
      const back = eye.dist * 0.6;
      cam.position.set(eye.x - ux * back, (g + h) * vex, eye.z - uz * back);
      eye.x -= ux * back; eye.z -= uz * back;
      const reach = Math.max(eye.dist * 1.6 + back, 2);
      const pitch = v === 'recon' ? Math.atan2(eye.top * 0.5 - h, reach) * 0.6 : Math.atan2(eye.top * 0.5, reach);
      ctl.target.set(eye.x + ux, (g + h + Math.tan(clamp(pitch, v === 'recon' ? 0.05 : 0.25, 0.6))) * vex, eye.z + uz);
      this.params.fov = Math.max(this.params.fov, 70);
      cam.fov = this.params.fov;
      this.syncControls();
    } else if (v === 'overview') {
      ctl.target.set(cx, midAlt * vex, cz);
      cam.position.set(cx - bw * 0.15, (midAlt + S.diag * 0.38) * vex ** 0.5, cz + bh * 0.95);
    } else if (v === 'ground') {
      // standing on the ground some way from the tallest cloud, sun behind, looking at it
      const [tx, tz, top] = this.tallest();
      const a = this.params.sunAzim * Math.PI / 180;
      const dist = clamp(top * 2.2 + 6, 10, 0.6 * Math.max(bw, bh));
      let px = tx + Math.sin(a) * dist, pz = tz - Math.cos(a) * dist;
      px = clamp(px, S.gbox[0] + 1, S.gbox[2] - 1); pz = clamp(pz, S.gbox[1] + 1, S.gbox[3] - 1);
      const g = this.groundAt(px, pz);
      cam.position.set(px, (g + 0.004) * vex, pz);
      const dd = Math.hypot(tx - px, tz - pz) || 1;
      ctl.target.set(px + (tx - px) / dd * 1.0, (g + 0.004 + 0.22 * Math.min(top / dd, 1.2)) * vex, pz + (tz - pz) / dd * 1.0);
    } else if (v === 'tallest') {
      // the tallest cloud, seen from a few km up with the sun behind the camera
      const [tx, tz, top] = this.tallest();
      const a = this.params.sunAzim * Math.PI / 180;
      const dist = clamp(top * 4 + 15, 25, 0.8 * Math.max(bw, bh));
      let px = tx + Math.sin(a) * dist, pz = tz - Math.cos(a) * dist;
      px = clamp(px, b[0] - 0.2 * bw, b[2] + 0.2 * bw); pz = clamp(pz, b[1] - 0.2 * bh, b[3] + 0.2 * bh);
      const g = this.groundAt(px, pz);
      cam.position.set(px, (g + clamp(top * 0.25, 1.2, 4)) * vex, pz);
      ctl.target.set(tx, top * 0.45 * vex, tz);
    } else if (v === 'top') {
      ctl.target.set(cx, 0, cz);
      cam.position.set(cx, Math.max(bw, bh) * 1.05, cz + 0.001);
    }
    ctl.update();
    this.menu(false);
    this.updateLocalSky(true);
    this.touch();
  }

  // Ambient light and haze colour follow how cloudy the sky is around the camera: under a deck
  // the sky is the grey cloud base, but in a clearing (an eye) it is open sky. High above the
  // clouds the whole area counts.
  updateLocalSky(force) {
    const S = this.S, fr = this.shownFields();
    if (!S || !fr) return;
    const cam = this.camera, b = S.box, [nx, ny] = S.grid;
    const alt = cam.position.y / this.params.vex - this.groundAt(cam.position.x, cam.position.z);
    let oc = S.overcastBox, wall = 0;
    const u = (cam.position.x - b[0]) / (b[2] - b[0]), w = (cam.position.z - b[1]) / (b[3] - b[1]);
    const camY = cam.position.y / this.params.vex;
    const ci = Math.floor(u * nx), cj = Math.floor(w * ny);
    if (u > -0.05 && u < 1.05 && w > -0.05 && w < 1.05) {
      // how much of the view around the camera is the side of cloud reaching above it (the wall of
      // an eye, a canyon between towers): sunlit cloud lights everything in it from the side
      const R = clamp(Math.round(25 / S.d.cell_km), 2, 150), st = Math.max(1, Math.round(R / 16));
      let sw = 0, c = 0;
      for (let dj = -R; dj <= R; dj += st) for (let di = -R; di <= R; di += st) {
        if (di * di + dj * dj > R * R) continue;
        c++;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const k = (j * nx + i) * 4;
        const tau = fromH(fr.f2[k + 2]);
        sw += fromH(fr.f2[k + 3]) * (1 - 1 / (1 + 0.11 * tau)) * sstep(camY + 0.3, camY + 1.5, fromH(fr.f1[k]));
      }
      wall = c ? sw / c : 0;
    }
    if (alt < 6 && u > 0 && u < 1 && w > 0 && w < 1) {
      const R = clamp(Math.round(8 / S.d.cell_km), 2, 60);
      const st = Math.max(1, Math.round(R / 12));
      let td = 0, c = 0;
      for (let dj = -R; dj <= R; dj += st) for (let di = -R; di <= R; di += st) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny || di * di + dj * dj > R * R) continue;
        const k = (j * nx + i) * 4;
        // only cloud reaching above the camera hides the sky (not an eye's low floor seen from above)
        const m = fromH(fr.f2[k + 3]) * sstep(camY - 0.3, camY + 0.6, fromH(fr.f1[k]));
        td += m / (1 + 0.11 * fromH(fr.f2[k + 2])) + (1 - m); c++;
      }
      if (c) oc = td / c;
      // blend toward the area mean as the camera rises
      oc += (S.overcastBox - oc) * sstep(1, 6, alt);
    }
    if (force || Math.abs(oc - S.overcast) > 0.04 || Math.abs(wall - (S.wall || 0)) > 0.04) {
      S.overcast = oc;
      S.wall = wall;
      this.cloudMat.uniforms.uOvercast.value = oc;
      this.updateSun();
    }
  }

  fly(dt) {
    if (!this.keys.size) return false;
    const cam = this.camera, ctl = this.controls;
    const alt = Math.max(0.05, cam.position.y / this.params.vex - this.groundAt(cam.position.x, cam.position.z));
    const sp = Math.min(alt * 0.9 + 0.2, 60) * (this.keys.has('shift') ? 5 : 1) * dt;
    const f = new THREE.Vector3();
    cam.getWorldDirection(f);
    f.y = 0;
    if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
    f.normalize();
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const m = new THREE.Vector3();
    if (this.keys.has('w')) m.add(f);
    if (this.keys.has('s')) m.sub(f);
    if (this.keys.has('d')) m.add(r);
    if (this.keys.has('a')) m.sub(r);
    if (this.keys.has('e')) m.y += 1;
    if (this.keys.has('q')) m.y -= 1;
    if (m.lengthSq() === 0) return false;
    m.normalize().multiplyScalar(sp);
    m.y *= this.params.vex;
    cam.position.add(m);
    ctl.target.add(m);
    return true;
  }

  clampCamera() {
    const cam = this.camera, vex = this.params.vex;
    const g = this.groundAt(cam.position.x, cam.position.z);
    const minY = (g + 0.0018) * vex;
    if (cam.position.y < minY) {
      const dy = minY - cam.position.y;
      cam.position.y += dy;
      this.controls.target.y += dy;
    }
    const alt = cam.position.y / vex - g;
    cam.near = clamp(alt * 0.2, 0.0005, 2);
    cam.far = 25000;
  }

  // camera position, heading and horizontal field of view for the map (wedge of what is seen)
  emitCamera(force) {
    const o = this.opts;
    if (!o.onCamera || !this.S) return;
    const now = performance.now();
    if (!force && now - (this.lastCamEmit || 0) < 90) { this.camDirty = true; return; }
    this.lastCamEmit = now;
    this.camDirty = false;
    if (!this.params.footprint) { o.onCamera(null); return; }
    const cam = this.camera, g = this.S.geo, b = this.S.box;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const flat = Math.hypot(fwd.x, fwd.z);
    let range = 0;
    for (const [x, z] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) range = Math.max(range, Math.hypot(x - cam.position.x, z - cam.position.z));
    o.onCamera({
      lon: g.lonc + cam.position.x / g.kx, lat: g.latc - cam.position.z / g.ky,
      alt: cam.position.y / this.params.vex,
      heading: (Math.atan2(fwd.x, -fwd.z) * 180 / Math.PI + 360) % 360,
      hfov: 2 * Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect) * 180 / Math.PI,
      range: clamp(range * 1.05, 5, 3000), down: flat < 0.2,
    });
  }

  // ---------------------------------------------------------------- frame loop
  loop(now) {
    if (this.disposed) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;
    if (!this.S || !this.terrRT) return;
    if (this.playing) this.advancePlay(dt);
    if (this.vr.presenting) { this.vr.render(dt); return; }
    if (this.fly(dt)) this.touch();
    this.controls.update();
    this.clampCamera();
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    const sig = [...this.camera.matrixWorld.elements, this.camera.near, this.camera.fov, this.version].map((v) => v.toFixed(5)).join(',');
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.lastChange = now;
      this.frame = 0;
      this.displayOnly = false;
      this.emitCamera(false);
    } else if (this.camDirty) this.emitCamera(true);
    const q = QUALITY[this.params.quality];
    const moving = now - this.lastChange < 120 || this.playing;
    if (this.wasMoving && !moving) this.updateLocalSky(false);
    this.wasMoving = moving;
    if (moving) {
      this.adaptMove(dt);
      this.renderFrame(this.terrLoRT, this.loRT, null, 1, q.moveSteps, 1.8, false);
      this.display(this.loRT, null, 1);
    } else if (this.frame < q.frames) {
      const tgt = this.frame % 2 ? this.accB : this.accA, prev = this.frame % 2 ? this.accA : this.accB;
      this.renderFrame(this.terrRT, tgt, prev, 1 / (this.frame + 1), q.steps, 1, true);
      this.display(tgt, null, clamp(1 - this.frame / 8, 0, 1)); // fade the filter out as frames accumulate
      this.frame++;
    } else if (this.displayOnly) {
      this.display(this.frame % 2 ? this.accA : this.accB);
      this.displayOnly = false;
    }
  }

  renderFrame(terrRT, outRT, prevRT, blend, steps, stepScale, jitter, cam = this.camera) {
    const r = this.renderer, U = this.U, p = this.params, S = this.S;
    const W = outRT.width, H = outRT.height;
    if (jitter && this.frame > 0) {
      const h = (i, b) => { let f = 1, x = 0; while (i > 0) { f /= b; x += f * (i % b); i = Math.floor(i / b); } return x; };
      cam.setViewOffset(W, H, h(this.frame, 2) - 0.5, h(this.frame, 3) - 0.5, W, H);
    } else if (cam.view && cam.view.enabled) cam.clearViewOffset(); // (VR eyes carry their own projection)
    cam.updateMatrixWorld();
    U.uVex.value = p.vex;
    U.uPixAng.value = 2 * Math.tan(cam.fov * Math.PI / 360) / H;
    U.uCamPos.value.copy(cam.position);
    U.uFrame.value = this.frame || 0;
    U.uDensity.value = 2 * p.density;
    U.uCoverage.value = p.coverage;
    U.uDetailAmt.value = p.detail;
    r.setRenderTarget(terrRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(S.terrainScene, cam);
    const b = S.box;
    let dmax = 0;
    for (const [x, z] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) dmax = Math.max(dmax, (x - cam.position.x) ** 2 + (z - cam.position.z) ** 2);
    const cu = this.cloudMat.uniforms;
    cu.uTerrain.value = terrRT.texture;
    cu.uPrev.value = prevRT ? prevRT.texture : terrRT.texture;
    cu.uBlend.value = prevRT ? blend : 1;
    cu.uSteps.value = steps;
    cu.uStepScale.value = stepScale;
    cu.uDropMax.value = dmax / (2 * R_E);
    cu.uHazeBeta.value = 3.912 / p.visibility;
    cu.uRainAmt.value = p.rain ? (p.preset === 'storm' ? 1.6 : 1) : 0;
    cu.uTint.value = p.look === 'satellite' && S.prodTex ? 1 : p.preset === 'heights' ? 2 : 0;
    cu.uInvProj.value.copy(cam.projectionMatrixInverse);
    cu.uCamWorld.value.copy(cam.matrixWorld);
    r.setRenderTarget(outRT);
    r.render(this.cloudScene, this.quadCam);
    if (cam.view && cam.view.enabled) cam.clearViewOffset();
  }

  display(rt, target = null, denoise = 0) {
    const r = this.renderer;
    this.dispMat.uniforms.uSrc.value = rt.texture;
    this.dispMat.uniforms.uTexel.value.set(1 / rt.width, 1 / rt.height);
    this.dispMat.uniforms.uDenoise.value = denoise;
    this.dispMat.uniforms.uExposure.value = this.params.exposure * 0.62;
    r.setRenderTarget(target);
    r.render(this.dispScene, this.quadCam);
  }

  save() {
    if (!this.S) return;
    const a = document.createElement('a');
    const f = this.frames[this.fi];
    const t = ((f && f.time) || '').replace(/[:]/g, '').slice(0, 15);
    a.download = `3d-view-${t}.png`;
    a.href = this.canvas.toDataURL('image/png');
    a.click();
  }

  close() {
    if (this.disposed) return;
    if (this.vr.presenting) this.vr.exit();
    this.renderer.setAnimationLoop(null);
    this.disposed = true;
    ++this.seq;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    this.ro.disconnect();
    this.disposeScene();
    if (this.controls) this.controls.dispose();
    for (const k of ['terrRT', 'terrLoRT', 'accA', 'accB', 'loRT', 'skyRT']) if (this[k]) this[k].dispose();
    for (const t of [this.shapeTex, this.detailTex, this.blankTex]) if (t) t.dispose();
    for (const m of [this.cloudMat, this.dispMat, this.skyMat]) m.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.root.remove();
    if (active === this) active = null;
  }
}

export function openPane(opts) {
  if (active) active.close();
  active = new Viewer(opts);
  return active;
}

window.Render3D = { openPane, get active() { return active; } };
