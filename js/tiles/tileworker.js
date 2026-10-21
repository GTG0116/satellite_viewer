/* Tile worker: holds decoded frames and renders, on demand, the web-mercator tiles MapLibre asks
 * for through the satv:// protocol.
 *
 *   tile   colour tile: every output pixel takes the single nearest satellite pixel (no smoothing);
 *          band values go through a 64k code -> RGBA table, composites are copied
 *   dem    terrain-RGB height tile: cloud-top height from the frame's reference band
 *          (optionally stacked on real ground elevation) for MapLibre 3D terrain
 *   probe  values under a lon/lat
 * Tiles are returned as ImageBitmaps, so nothing is PNG-encoded or decoded on the way.
 */
import { lonlatToRC, gridKey } from '../geo.js';
import { Q16, NAN_CODE } from '../catalog.js';

const frames = new Map();   // id -> frame
const tables = new Map();   // lut id -> Uint32Array(65536) code -> RGBA
const groundCache = new Map();

// Tile -> frame pixel indices, shared by every frame on the same grid: a loop over a fixed sector
// (full disk, CONUS, Japan, a custom box ...) navigates each map tile once instead of once per
// frame, so playback only copies pixels. Bounded by bytes (Int32 per tile pixel).
const indexCache = new Map(); // key -> Int32Array | null (no coverage)
let indexBytes = 0, indexMax = 32e6;
function cachedIndex(g, w, h, z, x, y, size) {
  const k = `${gridKey(g)}|${w}|${h}|${z}/${x}/${y}/${size}`;
  if (indexCache.has(k)) {
    const v = indexCache.get(k);
    indexCache.delete(k); indexCache.set(k, v); // most recently used last
    return v;
  }
  const v = tileIndex(g, w, h, z, x, y, size);
  indexCache.set(k, v);
  indexBytes += v ? v.byteLength : 0;
  for (const [ok, ov] of indexCache) {
    if (indexBytes <= indexMax) break;
    indexCache.delete(ok);
    indexBytes -= ov ? ov.byteLength : 0;
  }
  return v;
}

const PI = Math.PI;
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => { const n = PI - (2 * PI * y) / 2 ** z; return (180 / PI) * Math.atan(Math.sinh(n)); };

/** For every pixel of a z/x/y tile of `size`: index into the frame grid (or -1). Navigation is
 *  exact on an 8 px lattice and linear inside a cell; cells touching the disk edge are exact. */
function tileIndex(g, w, h, z, x, y, size) {
  const STEP = 8, n = size / STEP + 1;
  const lr = new Float64Array(n * n), lc = new Float64Array(n * n), ok = new Uint8Array(n * n);
  const o = [0, 0];
  const lonAt = (px) => tileLon(x + px / size, z);
  const latAt = (py) => tileLat(y + py / size, z);
  let any = false;
  for (let j = 0; j < n; j++) {
    const lat = latAt(j * STEP);
    for (let i = 0; i < n; i++) {
      if (lonlatToRC(g, lonAt(i * STEP), lat, o)) { const k = j * n + i; lr[k] = o[0]; lc[k] = o[1]; ok[k] = 1; any = true; }
    }
  }
  if (!any) return null;
  const idx = new Int32Array(size * size).fill(-1);
  let hit = false;
  for (let cj = 0; cj < n - 1; cj++) for (let ci = 0; ci < n - 1; ci++) {
    const k00 = cj * n + ci, k01 = k00 + 1, k10 = k00 + n, k11 = k10 + 1;
    const all = ok[k00] & ok[k01] & ok[k10] & ok[k11];
    if (all) {
      // whole cell outside the image?  (cheap reject)
      const rmin = Math.min(lr[k00], lr[k01], lr[k10], lr[k11]), rmax = Math.max(lr[k00], lr[k01], lr[k10], lr[k11]);
      const cmin = Math.min(lc[k00], lc[k01], lc[k10], lc[k11]), cmax = Math.max(lc[k00], lc[k01], lc[k10], lc[k11]);
      if (rmax < -0.5 || cmax < -0.5 || rmin > h - 0.5 || cmin > w - 0.5) continue;
    } else if (!(ok[k00] | ok[k01] | ok[k10] | ok[k11])) continue;
    for (let dy = 0; dy < STEP; dy++) {
      const py = cj * STEP + dy, ty = (dy + 0.5) / STEP;
      let lat = 0;
      if (!all) lat = latAt(py + 0.5);
      for (let dx = 0; dx < STEP; dx++) {
        const px = ci * STEP + dx;
        let r, c;
        if (all) {
          const tx = (dx + 0.5) / STEP; // lattice nodes sit on pixel corners, samples on pixel centres
          r = (lr[k00] * (1 - tx) + lr[k01] * tx) * (1 - ty) + (lr[k10] * (1 - tx) + lr[k11] * tx) * ty;
          c = (lc[k00] * (1 - tx) + lc[k01] * tx) * (1 - ty) + (lc[k10] * (1 - tx) + lc[k11] * tx) * ty;
        } else {
          if (!lonlatToRC(g, lonAt(px + 0.5), lat, o)) continue;
          r = o[0]; c = o[1];
        }
        const ri = Math.round(r), ci2 = Math.round(c);
        if (ri < 0 || ci2 < 0 || ri >= h || ci2 >= w) continue;
        idx[py * size + px] = ri * w + ci2;
        hit = true;
      }
    }
  }
  return hit ? idx : null;
}

function codeTable(lut, kind, vmin, vmax) {
  const [lo, hi] = Q16[kind], s = (hi - lo) / 65534;
  const t = new Uint32Array(65536);
  const l32 = new Uint32Array(lut.buffer, lut.byteOffset, 1024);
  const k = 1023 / (vmax - vmin);
  for (let c = 0; c < 65535; c++) {
    let i = ((c * s + lo - vmin) * k + 0.5) | 0;
    i = i < 0 ? 0 : i > 1023 ? 1023 : i;
    t[c] = l32[i];
  }
  t[NAN_CODE] = 0;
  return t;
}

async function bitmap(u8, size) {
  return createImageBitmap(new ImageData(new Uint8ClampedArray(u8.buffer, u8.byteOffset, size * size * 4), size, size));
}

function heightKm(f) {
  const r = f.ref, [lo, hi] = Q16[r.kind], cs = (hi - lo) / 65534;
  if (r.kind === 'bt' && f.flatBT === undefined) {
    const hist = new Uint32Array(1024), step = Math.max(1, Math.floor(r.codes.length / 60000));
    let n = 0;
    for (let i = 0; i < r.codes.length; i += step) { const c = r.codes[i]; if (c !== NAN_CODE) { hist[c >> 6]++; n++; } }
    let acc = 0; f.flatBT = 300;
    for (let b = 1023; b >= 0 && n; b--) { acc += hist[b]; if (acc >= n * 0.03) { f.flatBT = Math.max(265, Math.min(305, ((b << 6) + 32) * cs + lo)); break; } }
  }
  const flat = f.flatBT || 300;
  return (c) => {
    if (c === NAN_CODE) return 0;
    const v = c * cs + lo;
    if (r.kind === 'bt') return v >= flat ? 0 : Math.min(18, (flat - v) / (flat - 190) * 16);
    return Math.max(0, Math.min(1.2, v)) * 9;
  };
}

// Black Marble city lights (NASA GIBS, 256 px tiles up to z8) under GeoColor's night side.
// GIBS sends them with no-store, so without our own cache every visit downloads them again
// (each night-side tile waits for its lights); the 2016 composite never changes.
const LIGHTS_CACHE = 'satview-lights-v1';
async function lightPng(url) {
  let c = null;
  try { c = await caches.open(LIGHTS_CACHE); const hit = await c.match(url); if (hit) return hit.blob(); } catch (e) { /* no Cache Storage */ }
  const r = await fetch(url);
  if (!r.ok) return null;
  if (c) c.put(url, r.clone()).catch(() => {});
  return r.blob();
}
const lightTiles = new Map();
function lightTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!lightTiles.has(k)) {
    lightTiles.set(k, (async () => {
      try {
        const png = await lightPng(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`);
        if (!png) return null;
        const bmp = await createImageBitmap(png);
        const c = new OffscreenCanvas(256, 256), g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, 256, 256).data;
      } catch (e) { return null; }
    })());
    if (lightTiles.size > 200) lightTiles.delete(lightTiles.keys().next().value);
  }
  return lightTiles.get(k);
}
// The lights resampled to one output tile (RGBA, A = 255 where a light tile exists): built once
// per tile position and reused by every loop frame. Bounded by bytes.
const tileLightCache = new Map(); // z/x/y/size -> Promise<Uint8Array>
let tileLightBytes = 0, tileLightMax = 16e6;
function tileLights(z, x, y, size) {
  const k = `${z}/${x}/${y}/${size}`;
  let p = tileLightCache.get(k);
  if (p) { tileLightCache.delete(k); tileLightCache.set(k, p); return p; }
  p = buildTileLights(z, x, y, size);
  tileLightCache.set(k, p);
  tileLightBytes += size * size * 4;
  for (const [ok] of tileLightCache) {
    if (tileLightBytes <= tileLightMax || tileLightCache.size <= 1) break;
    tileLightCache.delete(ok);
    const s = Number(ok.slice(ok.lastIndexOf('/') + 1));
    tileLightBytes -= s * s * 4;
  }
  return p;
}

async function buildTileLights(z, x, y, size) {
  const zl = Math.min(8, z + Math.round(Math.log2(size / 256)));
  const sc = 2 ** zl / 2 ** z * 256 / size; // light px per output px
  const n = 2 ** zl;
  const gx0 = x * size * sc, gy0 = y * size * sc;
  const tx0 = Math.floor(gx0 / 256), tx1 = Math.floor((gx0 + size * sc - 1e-6) / 256);
  const ty0 = Math.floor(gy0 / 256), ty1 = Math.floor((gy0 + size * sc - 1e-6) / 256);
  const ntx = tx1 - tx0 + 1, src = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) src.push(ty >= 0 && ty < n ? lightTile(zl, ((tx % n) + n) % n, ty) : null);
  }
  const tiles = await Promise.all(src);
  const colT = new Int32Array(size), colK = new Int32Array(size);
  for (let px = 0; px < size; px++) {
    const gx = Math.floor(gx0 + (px + 0.5) * sc), tx = Math.floor(gx / 256);
    colT[px] = tx - tx0; colK[px] = (gx - tx * 256) * 4;
  }
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    const gy = Math.floor(gy0 + (py + 0.5) * sc), ty = Math.floor(gy / 256), row = (ty - ty0) * ntx, ly = (gy - ty * 256) * 1024;
    for (let px = 0, o = py * size * 4; px < size; px++, o += 4) {
      const L = tiles[row + colT[px]];
      if (!L) continue;
      const k = ly + colK[px];
      out[o] = L[k]; out[o + 1] = L[k + 1]; out[o + 2] = L[k + 2]; out[o + 3] = 255;
    }
  }
  return out;
}

async function addLightsMasked(out, idx, z, x, y, size) {
  const L = await tileLights(z, x, y, size);
  for (let i = 0, o = 0; i < idx.length; i++, o += 4) {
    const a = out[o + 3];
    if (a === 255 || idx[i] < 0 || !L[o + 3]) continue;
    const t = a / 255, u = 1 - t;
    // night lights glow warm; the imagery keeps its own alpha-weighted colour on top
    out[o] = out[o] * t + L[o] * u; out[o + 1] = out[o + 1] * t + L[o + 1] * 0.9 * u; out[o + 2] = out[o + 2] * t + L[o + 2] * 0.7 * u;
    out[o + 3] = 255;
  }
}

async function groundTile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (groundCache.has(k)) return groundCache.get(k);
  const p = (async () => {
    try {
      const zz = Math.min(z, 12), f = 2 ** (z - zz);
      const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zz}/${Math.floor(x / f)}/${Math.floor(y / f)}.png`);
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      const c = new OffscreenCanvas(256, 256), ctx = c.getContext('2d');
      // a parent tile when deeper than z12: draw the matching quarter enlarged
      const sx = (x % f) * 256 / f, sy = (y % f) * 256 / f;
      ctx.drawImage(bmp, sx, sy, 256 / f, 256 / f, 0, 0, 256, 256);
      const d = ctx.getImageData(0, 0, 256, 256).data, out = new Float32Array(256 * 256);
      for (let i = 0; i < out.length; i++) out[i] = Math.max(0, d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768);
      return out;
    } catch (e) { return null; }
  })();
  groundCache.set(k, p);
  if (groundCache.size > 300) groundCache.delete(groundCache.keys().next().value);
  return p;
}

const TASKS = {
  config({ cacheMB }) { if (cacheMB) { indexMax = cacheMB * 1e6; tileLightMax = cacheMB * 0.5e6; } return { result: true }; },
  put({ id, frame }) { frames.set(id, frame); return { result: true }; },
  drop({ ids }) { for (const id of ids) frames.delete(id); return { result: true }; },
  lut({ id, lut, kind, vmin, vmax }) { tables.set(id, codeTable(lut, kind, vmin, vmax)); if (tables.size > 24) tables.delete(tables.keys().next().value); return { result: true }; },

  async tile({ id, lutId, z, x, y, size, lights }) {
    const f = frames.get(id);
    const out = new Uint8Array(size * size * 4);
    if (f) {
      const idx = cachedIndex(f.grid, f.w, f.h, z, x, y, size);
      if (idx) {
        const o32 = new Uint32Array(out.buffer);
        if (f.mode === 'band') {
          const t = tables.get(lutId), c = f.ref.codes;
          if (t) for (let i = 0; i < idx.length; i++) { const k = idx[i]; if (k >= 0) o32[i] = t[c[k]]; }
        } else {
          const s32 = new Uint32Array(f.rgba.buffer, f.rgba.byteOffset, f.w * f.h);
          for (let i = 0; i < idx.length; i++) { const k = idx[i]; if (k >= 0) o32[i] = s32[k]; }
          // only pixels inside the image get lights (GeoColor's own night alpha decides how much)
          if (lights && f.lights) await addLightsMasked(out, idx, z, x, y, size);
        }
      }
    }
    const bmp = await bitmap(out, size);
    return { result: bmp, transfer: [bmp] };
  },

  async dem({ id, z, x, y, ground }) {
    const size = 256, f = frames.get(id);
    const hm = new Float32Array(size * size);
    if (f && f.ref) {
      const r = f.ref, idx = cachedIndex(r.grid, r.w, r.h, z, x, y, size);
      if (idx) {
        const H = heightKm(f);
        for (let i = 0; i < idx.length; i++) if (idx[i] >= 0) hm[i] = H(r.codes[idx[i]]) * 1000;
      }
    }
    if (ground > 0) {
      const g = await groundTile(z, x, y);
      // the terrain exaggeration applies to the whole DEM: ground is pre-scaled by g = ground / cloud exaggeration
      if (g) for (let i = 0; i < hm.length; i++) hm[i] += g[i] * ground;
    }
    const out = new Uint8Array(size * size * 4);
    for (let i = 0; i < hm.length; i++) {
      const v = Math.max(0, Math.round((hm[i] + 10000) * 10));
      out[i * 4] = (v >> 16) & 255; out[i * 4 + 1] = (v >> 8) & 255; out[i * 4 + 2] = v & 255; out[i * 4 + 3] = 255;
    }
    const bmp = await bitmap(out, size);
    return { result: bmp, transfer: [bmp] };
  },

  probe({ id, lon, lat }) {
    const f = frames.get(id);
    if (!f) return { result: null };
    const o = [0, 0], res = {};
    const r = f.ref;
    if (lonlatToRC(r.grid, lon, lat, o)) {
      const ri = Math.round(o[0]), ci = Math.round(o[1]);
      if (ri >= 0 && ci >= 0 && ri < r.h && ci < r.w) {
        const c = r.codes[ri * r.w + ci], [lo, hi] = Q16[r.kind];
        res.value = c === NAN_CODE ? NaN : lo + c * (hi - lo) / 65534;
        res.kind = r.kind; res.band = r.band;
      }
    }
    if (f.mode === 'rgb' && f.rgba && lonlatToRC(f.grid, lon, lat, o)) {
      const ri = Math.round(o[0]), ci = Math.round(o[1]);
      if (ri >= 0 && ci >= 0 && ri < f.h && ci < f.w) { const k = (ri * f.w + ci) * 4; res.rgb = [f.rgba[k], f.rgba[k + 1], f.rgba[k + 2]]; }
    }
    return { result: res };
  },

};

self.onmessage = async (e) => {
  const { id, type, args } = e.data;
  try {
    const { result, transfer } = await TASKS[type](args);
    self.postMessage({ id, ok: true, result }, transfer || []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
