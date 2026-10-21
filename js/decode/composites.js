/* RGB composite recipes (same maths as the Python back end), evaluated per pixel in a worker.
 *
 * Inputs are 16-bit storage codes per role on grids that may be coarser than the output (they
 * are indexed by integer division: pixel replication, never interpolation). Everything that
 * depends only on sun / view geometry (sun normalisation, Rayleigh path reflectance, day / night
 * weights) varies smoothly, so it is evaluated on a coarse lattice and interpolated per row;
 * the per-pixel work is then a few multiplies and table lookups.
 */
import { Q16, NAN_CODE } from '../catalog.js';
import { rcToLonLat, sunPosition, D2R } from '../geo.js';

function decodeTable(kind) {
  const [lo, hi] = Q16[kind], s = (hi - lo) / 65534, t = new Float32Array(65536);
  for (let c = 0; c < 65535; c++) t[c] = c * s + lo;
  t[NAN_CODE] = NaN;
  return t;
}
const TABLES = {};
const table = (kind) => (TABLES[kind] ||= decodeTable(kind));

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sc = (a, lo, hi) => clamp01((a - lo) / (hi - lo));

// x^p on [0, 1] through a table (outputs end up as 8-bit colours anyway)
const PN = 4096;
function powTable(p) { const t = new Float32Array(PN + 1); for (let i = 0; i <= PN; i++) t[i] = Math.pow(i / PN, p); return t; }
const POW = {};
const powT = (p) => (POW[p] ||= powTable(p));
const pw = (t, x) => t[(clamp01(x) * PN + 0.5) | 0];

// CIRA style true-colour tone curve, tabulated over reflectance 0..1.1
const TONE = (() => {
  const X = [0, 25 / 255, 55 / 255, 100 / 255, 1], Y = [0, 90 / 255, 140 / 255, 175 / 255, 1], t = new Float32Array(PN + 1);
  for (let i = 0; i <= PN; i++) {
    const x = i / PN;
    let k = 1; while (k < 4 && x > X[k]) k++;
    t[i] = Y[k - 1] + (Y[k] - Y[k - 1]) * (x - X[k - 1]) / (X[k] - X[k - 1]);
  }
  return t;
})();
const tone = (a) => TONE[((a < 0 ? 0 : a > 1.1 ? 1.1 : a) / 1.1 * PN + 0.5) | 0];

const rayTau = (l) => 0.008569 * l ** -4 * (1 + 0.0113 * l ** -2 + 0.00013 * l ** -4);
const TAU = [rayTau(0.64), rayTau(0.51), rayTau(0.47), rayTau(0.86)]; // red, green, blue, veg

// geometry quantities on the lattice
const Q_INVMU = 0, Q_RAY = 1 /* 1..4: red, green, blue, veg */, Q_WD = 5, Q_INVMUS = 6, Q_WDS = 7, NQ = 8;

function lattice(grid, w, h, time, STEP = 8) {
  const gw = Math.ceil((w - 1) / STEP) + 1, gh = Math.ceil((h - 1) / STEP) + 1;
  const q = new Float32Array(gw * gh * NQ);
  const sp = sunPosition(time), d = sp.decl * D2R, sl = sp.lon * D2R;
  const S0 = Math.cos(d) * Math.cos(sl), S1 = Math.cos(d) * Math.sin(sl), S2 = Math.sin(d);
  const sLon = grid.lon0 * D2R, R = 6371000;
  const sx = grid.H * Math.cos(sLon), sy = grid.H * Math.sin(sLon);
  const o = [0, 0];
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const k = (j * gw + i) * NQ;
    if (!rcToLonLat(grid, Math.min(h - 1, j * STEP), Math.min(w - 1, i * STEP), o, true)) continue;
    const la = o[1] * D2R, lo = o[0] * D2R, cl = Math.cos(la);
    const n0 = cl * Math.cos(lo), n1 = cl * Math.sin(lo), n2 = Math.sin(la);
    const mu = n0 * S0 + n1 * S1 + n2 * S2;
    let vx = sx - R * n0, vy = sy - R * n1, vz = -R * n2;
    const vn = Math.hypot(vx, vy, vz); vx /= vn; vy /= vn; vz /= vn;
    const mv = n0 * vx + n1 * vy + n2 * vz, cs = -(S0 * vx + S1 * vy + S2 * vz);
    const muc = Math.min(1, Math.max(0.05, mu)), mvc = Math.min(1, Math.max(0.15, mv)), ms = Math.min(1, Math.max(0.02, mu));
    const phase = 0.75 * (1 + cs * cs);
    q[k + Q_INVMU] = 1 / muc;
    for (let b = 0; b < 4; b++) {
      // single-scattering Rayleigh path reflectance (reflectance-factor units); none near the terminator
      q[k + Q_RAY + b] = mu < 0.05 ? 0 : ms * phase / (4 * (ms + mvc)) * (1 - Math.exp(-TAU[b] * (1 / ms + 1 / mvc))) * 0.95;
    }
    const sza = Math.acos(Math.max(-1, Math.min(1, mu))) / D2R;
    q[k + Q_WD] = clamp01((89 - sza) / 11);
    q[k + Q_INVMUS] = 1 / Math.max(0.1, Math.min(1, mu));
    q[k + Q_WDS] = clamp01((88 - sza) / 10);
  }
  // per output row: the lattice interpolated vertically, then horizontally (column weights are
  // the same for every row)
  const rowBuf = new Float32Array(gw * NQ);
  const out = new Float32Array(w * NQ);
  const ca = new Int32Array(w), cb = new Int32Array(w), ctx = new Float64Array(w);
  for (let c = 0; c < w; c++) {
    const fx = c / STEP, x0 = Math.min(gw - 1, fx | 0);
    ca[c] = x0 * NQ; cb[c] = Math.min(gw - 1, x0 + 1) * NQ; ctx[c] = fx - x0;
  }
  return {
    row(r) {
      const fy = r / STEP, y0 = Math.min(gh - 1, fy | 0), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
      for (let i = 0; i < gw * NQ; i++) rowBuf[i] = q[y0 * gw * NQ + i] * (1 - ty) + q[y1 * gw * NQ + i] * ty;
      for (let c = 0, d0 = 0; c < w; c++, d0 += NQ) {
        const a = ca[c], b = cb[c], tx = ctx[c];
        for (let k = 0; k < NQ; k++) out[d0 + k] = rowBuf[a + k] * (1 - tx) + rowBuf[b + k] * tx;
      }
      return out;
    },
  };
}

/**
 * bands: {role: {codes, w, h, f (output px per band px), kind}}; out: {w, h, grid, time}
 * Returns RGBA Uint8Array (w*h*4).
 */
export function composite(recipe, bands, out, irLut) {
  const { w, h } = out;
  const rgba = new Uint8Array(w * h * 4);
  const roles = Object.keys(bands), n = roles.length;
  const idx = {}; roles.forEach((r, i) => { idx[r] = i; });
  const B = roles.map((r) => bands[r]), T = B.map((b) => table(b.kind));
  const geo = ['geocolor', 'truecolor', 'sandwich'].includes(recipe) ? lattice(out.grid, w, h, out.time) : null;
  const fn = RECIPES[recipe](idx, irLut);
  const x = new Float64Array(n);
  const res = new Float64Array(4);
  const colIdx = B.map((b) => { const a = new Int32Array(w); for (let c = 0; c < w; c++) a[c] = Math.min(b.w - 1, Math.floor(c / b.f)); return a; });
  const rowOff = new Int32Array(n);
  for (let r = 0; r < h; r++) {
    for (let i = 0; i < n; i++) rowOff[i] = Math.min(B[i].h - 1, Math.floor(r / B[i].f)) * B[i].w;
    const q = geo ? geo.row(r) : null;
    let o = r * w * 4;
    for (let c = 0; c < w; c++, o += 4) {
      let bad = false;
      for (let i = 0; i < n; i++) {
        const code = B[i].codes[rowOff[i] + colIdx[i][c]];
        if (code === NAN_CODE) { bad = true; break; }
        x[i] = T[i][code];
      }
      if (bad) continue; // alpha stays 0
      fn(x, q, c * NQ, res);
      rgba[o] = clamp01(res[0]) * 255 + 0.5; rgba[o + 1] = clamp01(res[1]) * 255 + 0.5;
      rgba[o + 2] = clamp01(res[2]) * 255 + 0.5; rgba[o + 3] = clamp01(res[3]) * 255 + 0.5;
    }
  }
  return rgba;
}

// Rayleigh-corrected, sun-normalised reflectances -> tc[0..2] (r, g, b)
function trueColorFn(I) {
  const hasG = I.green !== undefined;
  const tc = new Float64Array(3);
  return (x, q, k) => {
    const im = q[k + Q_INVMU];
    const r = Math.max((x[I.red] - q[k + Q_RAY]) * im, 0);
    const b = Math.max((x[I.blue] - q[k + Q_RAY + 2]) * im, 0);
    const nn = Math.max((x[I.veg] - q[k + Q_RAY + 3]) * im, 0);
    tc[0] = r; tc[2] = b;
    tc[1] = hasG ? 0.93 * Math.max((x[I.green] - q[k + Q_RAY + 1]) * im, 0) + 0.07 * nn : 0.45 * r + 0.10 * nn + 0.45 * b;
    return tc;
  };
}

const RECIPES = {
  truecolor(I) {
    const t = trueColorFn(I);
    return (x, q, k, o) => { const c = t(x, q, k); o[0] = tone(c[0]); o[1] = tone(c[1]); o[2] = tone(c[2]); o[3] = 1; };
  },
  geocolor(I) {
    const t = trueColorFn(I), p08 = powT(0.8);
    return (x, q, k, o) => {
      const wd = q[k + Q_WD];
      if (wd >= 1) { // full day: the night layer has no weight
        const c = t(x, q, k);
        o[0] = tone(c[0]); o[1] = tone(c[1]); o[2] = tone(c[2]); o[3] = 1;
        return;
      }
      const bt = x[I.ir103];
      // night: IR clouds + low cloud / fog from 10.3 - 3.9 um
      const w = pw(p08, (282 - bt) / 72);
      const lc = clamp01((bt - x[I.swir] - 1.5) / 4.5) * clamp01((bt - 240) / 20);
      const tot = w > lc ? w : lc, mix = tot > 0 ? w / Math.max(tot, 1e-6) : 1;
      const hiS = 0.42 + 0.58 * w;
      const nr = hiS * 0.96 * mix + 0.62 * (1 - mix), ng = hiS * 0.97 * mix + 0.70 * (1 - mix), nb = hiS * mix + 0.86 * (1 - mix);
      const na = clamp01(Math.max(w, lc * 0.85));
      let dr = 0, dg = 0, db = 0;
      if (wd > 0) { const c = t(x, q, k); dr = tone(c[0]); dg = tone(c[1]); db = tone(c[2]); }
      const kk = (1 - wd) * na, fa = wd + kk, den = fa > 1e-6 ? fa : 1e-6;
      o[0] = (wd * dr + kk * nr) / den; o[1] = (wd * dg + kk * ng) / den; o[2] = (wd * db + kk * nb) / den; o[3] = fa;
    };
  },
  sandwich(I, irLut) {
    return (x, q, k, o) => {
      const v = Math.min(1.1, Math.max(0, x[I.red] * q[k + Q_INVMUS]));
      const vis = Math.sqrt(v / 1.1);
      const bt = x[I.ir103], irg = clamp01((310 - bt) / 110), wd = q[k + Q_WDS];
      const base = vis * wd + irg * (1 - wd);
      const li = Math.max(0, Math.min(1023, Math.floor((bt - 163) / (330 - 163) * 1023))) * 4;
      const a = clamp01((246 - bt) / 14) * 0.8, s = (0.3 + 0.7 * base) * a / 255, keep = base * (1 - a);
      o[0] = keep + irLut[li] * s; o[1] = keep + irLut[li + 1] * s; o[2] = keep + irLut[li + 2] * s; o[3] = 1;
    };
  },
  natural(I) {
    const p = powT(0.8);
    return (x, q, k, o) => { o[0] = pw(p, x[I.snow] / 0.975); o[1] = pw(p, x[I.veg] / 1.086); o[2] = pw(p, x[I.red]); o[3] = 1; };
  },
  airmass(I) {
    return (x, q, k, o) => { o[0] = sc(x[I.wv_upper] - x[I.wv_low], -26.2, 0.6); o[1] = sc(x[I.ozone] - x[I.ir103], -43.2, 6.7); o[2] = sc(x[I.wv_upper], 243.9, 208.5); o[3] = 1; };
  },
  dcp(I) {
    return (x, q, k, o) => { o[0] = sc(x[I.ir103], 280.65, 219.65); o[1] = sc(x[I.red], 0, 0.78); o[2] = sc(x[I.snow], 0.01, 0.59); o[3] = 1; };
  },
  dust(I) {
    const p = powT(1 / 2.5);
    return (x, q, k, o) => { o[0] = sc(x[I.ir123] - x[I.ir103], -6.7, 2.6); o[1] = pw(p, sc(x[I.ir103] - x[I.ir86], -0.5, 20)); o[2] = sc(x[I.ir103], 261.2, 288.7); o[3] = 1; };
  },
  nightmicro(I) {
    return (x, q, k, o) => { o[0] = sc(x[I.ir123] - x[I.ir103], -6.7, 2.6); o[1] = sc(x[I.ir103] - x[I.swir], -3.1, 5.2); o[2] = sc(x[I.ir103], 243.55, 292.65); o[3] = 1; };
  },
  daycon(I) {
    const p = powT(2);
    return (x, q, k, o) => { o[0] = sc(x[I.wv_upper] - x[I.wv_low], -35, 5); o[1] = pw(p, sc(x[I.swir] - x[I.ir103], -5, 60)); o[2] = sc(x[I.snow] - x[I.red], -0.75, 0.25); o[3] = 1; };
  },
  fire(I) {
    const p = powT(2.5);
    return (x, q, k, o) => { o[0] = pw(p, sc(x[I.swir], 273, 333)); o[1] = sc(x[I.cps], 0, 1); o[2] = sc(x[I.snow], 0, 0.75); o[3] = 1; };
  },
  simplewv(I) {
    return (x, q, k, o) => { o[0] = sc(x[I.ir103], 278.96, 202.29); o[1] = sc(x[I.wv_upper], 242.67, 214.66); o[2] = sc(x[I.wv_low], 261.03, 245.12); o[3] = 1; };
  },
  ash(I) {
    return (x, q, k, o) => { o[0] = sc(x[I.ir123] - x[I.ir103], -6.7, 2.6); o[1] = sc(x[I.ir103] - x[I.ir86], -6, 6.3); o[2] = sc(x[I.ir103], 243.6, 302.4); o[3] = 1; };
  },
};
