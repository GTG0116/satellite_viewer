/* Cloud-field retrieval for the 3D volume view (a port of the Python back end's render3d.py).
 *
 * For a lon/lat box, the satellite bands are sampled onto a regular grid and turned into the
 * fields the volumetric renderer needs, per cell:
 *   top   cloud-top height (km)  10.3 µm BT vs the clear-sky surface temperature (6.5 K/km), thin ice
 *                                corrected with the split window, capped above the tropopause
 *   base  cloud-base height (km) LCL for cumulus / towers / thick systems, else top minus a layer depth
 *   ext   extinction (1/km) = optical depth / geometric thickness
 *   conv  0 (flat) .. 1 (heaped / convective)       rain  rain-shaft proxy      ice  ice fraction
 *   tau   visible optical depth (day: 0.64 µm two-stream; night: split window + 3.9 µm fog test)
 * Everything is estimated from passive imagery (one top per column, bases are modelled).
 */
import { lonlatToRC, sunPosition, D2R } from '../geo.js';
import { Q16, NAN_CODE } from '../catalog.js';

const MAX_CELLS = 480, MAX_ELEV_CELLS = 640, GROUND_PAD = 0.4, LAPSE = 6.5, KY = 110.57;
const kmPerDegLon = (lat) => 111.32 * Math.cos(lat * D2R);
const normLon = (x) => ((x + 180) % 360 + 360) % 360 - 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const F = (n, v = 0) => { const a = new Float32Array(n); if (v) a.fill(v); return a; };
const isF = (v) => v === v;

// ------------------------------------------------------------------ half floats
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v; const x = u32[0];
  const s = (x >> 16) & 0x8000; let e = ((x >> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return s; m |= 0x800000; return s | ((m >> (1 - e)) + 0x1000) >> 13; }
  if (e >= 31) return s | 0x7c00 | (((x >> 23) & 0xff) === 255 && m ? 0x200 : 0);
  return s | (e << 10) | ((m + 0x1000) >> 13);
}
function halfPack(arrs, n) {
  const k = arrs.length, out = new Uint16Array(n * k);
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) out[i * k + j] = toHalf(arrs[j][i]);
  return out;
}

// ------------------------------------------------------------------ filters (mode 'nearest')
function boxBlur1(src, dst, nx, ny, r, horiz) {
  const n = 2 * r + 1;
  if (horiz) {
    for (let y = 0; y < ny; y++) {
      const o = y * nx; let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[o + clamp(k, 0, nx - 1)];
      for (let x = 0; x < nx; x++) {
        dst[o + x] = acc / n;
        acc += src[o + Math.min(nx - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
      }
    }
  } else {
    for (let x = 0; x < nx; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[clamp(k, 0, ny - 1) * nx + x];
      for (let y = 0; y < ny; y++) {
        dst[y * nx + x] = acc / n;
        acc += src[Math.min(ny - 1, y + r + 1) * nx + x] - src[Math.max(0, y - r) * nx + x];
      }
    }
  }
}
/** Gaussian blur: exact separable kernel for small sigma, three box passes for large. */
function gauss(a, nx, ny, sigma) {
  if (sigma <= 0.05) return Float32Array.from(a);
  const out = Float32Array.from(a), tmp = new Float32Array(a.length);
  if (sigma > 3) {
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    for (let p = 0; p < 3; p++) { boxBlur1(out, tmp, nx, ny, r, true); boxBlur1(tmp, out, nx, ny, r, false); }
    return out;
  }
  const R = Math.ceil(4 * sigma), ker = new Float32Array(2 * R + 1);
  let s = 0; for (let k = -R; k <= R; k++) { ker[k + R] = Math.exp(-(k * k) / (2 * sigma * sigma)); s += ker[k + R]; }
  for (let k = 0; k < ker.length; k++) ker[k] /= s;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let acc = 0; for (let k = -R; k <= R; k++) acc += ker[k + R] * out[y * nx + clamp(x + k, 0, nx - 1)];
    tmp[y * nx + x] = acc;
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let acc = 0; for (let k = -R; k <= R; k++) acc += ker[k + R] * tmp[clamp(y + k, 0, ny - 1) * nx + x];
    out[y * nx + x] = acc;
  }
  return out;
}
function uniform(a, nx, ny, k) { const r = (k - 1) >> 1, t = new Float32Array(a.length), o = new Float32Array(a.length); boxBlur1(a, t, nx, ny, r, true); boxBlur1(t, o, nx, ny, r, false); return o; }
function maxFilter(a, nx, ny, k) {
  const r = (k - 1) >> 1, t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { let m = -Infinity; for (let d = -r; d <= r; d++) { const v = a[y * nx + clamp(x + d, 0, nx - 1)]; if (v > m) m = v; } t[y * nx + x] = m; }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { let m = -Infinity; for (let d = -r; d <= r; d++) { const v = t[clamp(y + d, 0, ny - 1) * nx + x]; if (v > m) m = v; } o[y * nx + x] = m; }
  return o;
}
/** Values of a where mask, elsewhere the nearest masked value (two-pass nearest-index propagation). */
function fillNearest(a, mask, nx, ny) {
  let any = false, all = true;
  for (let i = 0; i < mask.length; i++) { if (mask[i]) any = true; else all = false; }
  if (all || !any) return a;
  const idx = new Int32Array(a.length).fill(-1), d2 = new Float32Array(a.length).fill(Infinity);
  for (let i = 0; i < mask.length; i++) if (mask[i]) { idx[i] = i; d2[i] = 0; }
  const relax = (i, j) => {
    const s = idx[j]; if (s < 0) return;
    const x = i % nx, y = (i / nx) | 0, sx = s % nx, sy = (s / nx) | 0;
    const d = (x - sx) ** 2 + (y - sy) ** 2;
    if (d < d2[i]) { d2[i] = d; idx[i] = s; }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (x > 0) relax(i, i - 1); if (y > 0) { relax(i, i - nx); if (x > 0) relax(i, i - nx - 1); if (x < nx - 1) relax(i, i - nx + 1); }
    }
    for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) {
      const i = y * nx + x;
      if (x < nx - 1) relax(i, i + 1); if (y < ny - 1) { relax(i, i + nx); if (x < nx - 1) relax(i, i + nx + 1); if (x > 0) relax(i, i + nx - 1); }
    }
  }
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[idx[i] >= 0 ? idx[i] : i];
  return out;
}
function bilin(a, nx, ny, y, x) {
  y = clamp(y, 0, ny - 1); x = clamp(x, 0, nx - 1);
  const x0 = Math.min(nx - 2, x | 0), y0 = Math.min(ny - 2, y | 0);
  if (nx < 2 || ny < 2) return a[0];
  const tx = x - x0, ty = y - y0, k = y0 * nx + x0;
  return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + nx] * (1 - tx) + a[k + nx + 1] * tx) * ty;
}
function percentile(vals, q) {
  if (!vals.length) return NaN;
  const s = Float32Array.from(vals).sort(), p = (q / 100) * (s.length - 1), i = Math.floor(p);
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (p - i) : s[i];
}
function blockStat(a, nx, ny, b, q) {
  const bx = Math.ceil(nx / b), by = Math.ceil(ny / b), out = new Float32Array(bx * by).fill(NaN);
  const need = Math.max(3, (b * b) >> 3);
  for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    const v = [];
    for (let y = j * b; y < Math.min(ny, (j + 1) * b); y++) for (let x = i * b; x < Math.min(nx, (i + 1) * b); x++) { const t = a[y * nx + x]; if (isF(t)) v.push(t); }
    if (v.length >= need) out[j * bx + i] = percentile(v, q);
  }
  return { v: out, bx, by };
}
function upsample(blk, nx, ny, fill) {
  const { v, bx, by } = blk, a = v.map((x) => (isF(x) ? x : fill)), out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) out[y * nx + x] = bilin(a, bx, by, (y + 0.5) * by / ny - 0.5, (x + 0.5) * bx / nx - 0.5);
  return out;
}

// ------------------------------------------------------------------ sampling
function decoder(kind) { const [lo, hi] = Q16[kind], s = (hi - lo) / 65534; return (c) => (c === NAN_CODE ? NaN : c * s + lo); }

function sampleGeo(band, lon, lat, ss) {
  const nx = lon.length, ny = lat.length, out = new Float32Array(nx * ny).fill(NaN), dec = decoder(band.kind);
  const dlon = nx > 1 ? lon[1] - lon[0] : 0, dlat = ny > 1 ? lat[1] - lat[0] : 0, o = [0, 0];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let s = 0, n = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const lo = normLon(lon[x] + ((i + 0.5) / ss - 0.5) * dlon), la = lat[y] + ((j + 0.5) / ss - 0.5) * dlat;
      if (!lonlatToRC(band.grid, lo, la, o)) continue;
      const r = Math.round(o[0]), c = Math.round(o[1]);
      if (r < 0 || c < 0 || r >= band.h || c >= band.w) continue;
      const v = dec(band.codes[r * band.w + c]);
      if (isF(v)) { s += v; n++; }
    }
    if (n) out[y * nx + x] = s / n;
  }
  return out;
}
function sampleBilinear(band, lon, lat) {
  const nx = lon.length, ny = lat.length, out = new Float32Array(nx * ny).fill(NaN), dec = decoder(band.kind), o = [0, 0];
  const at = (r, c) => dec(band.codes[r * band.w + c]);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!lonlatToRC(band.grid, normLon(lon[x]), lat[y], o)) continue;
    const r0 = Math.floor(o[0]), c0 = Math.floor(o[1]);
    if (r0 < 0 || c0 < 0 || r0 >= band.h - 1 || c0 >= band.w - 1) continue;
    const ty = o[0] - r0, tx = o[1] - c0;
    const v00 = at(r0, c0), v01 = at(r0, c0 + 1), v10 = at(r0 + 1, c0), v11 = at(r0 + 1, c0 + 1);
    let v = (v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty;
    if (!isF(v)) v = tx < 0.5 ? (ty < 0.5 ? v00 : v10) : (ty < 0.5 ? v01 : v11);
    out[y * nx + x] = v;
  }
  return out;
}

const mercY = (lat) => (1 - Math.asinh(Math.tan(clamp(lat, -85, 85) * D2R)) / Math.PI) / 2;
const tileCache = new Map();
async function terrarium(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!tileCache.has(k)) {
    tileCache.set(k, (async () => {
      try {
        const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
        if (!r.ok) return null;
        const bmp = await createImageBitmap(await r.blob());
        const c = new OffscreenCanvas(256, 256), g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
        for (let i = 0; i < 65536; i++) h[i] = Math.max(0, d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768); // sea = 0
        return h;
      } catch (e) { return null; }
    })());
    if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
  }
  return tileCache.get(k);
}
/** Ground elevation (km, sea = 0) on a lon/lat grid, bilinear from AWS Terrarium tiles. */
async function ground(lon, lat, cellKm) {
  const nx = lon.length, ny = lat.length, latc = (lat[0] + lat[ny - 1]) / 2;
  const z = clamp(Math.floor(Math.log2(40075 * Math.cos(latc * D2R) / (256 * Math.max(cellKm, 0.03)))) + 1, 1, 12), n = 2 ** z;
  const px = Array.from(lon, (l) => (normLon(l) + 180) / 360 * n * 256 - 0.5);
  for (let i = 1; i < px.length; i++) if (px[i] < px[0] - n * 128) px[i] += n * 256;
  const py = Array.from(lat, (l) => mercY(l) * n * 256 - 0.5);
  const mn = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity), mx = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
  const x0 = Math.floor(mn(px) / 256), x1 = Math.floor(mx(px) / 256) + 1;
  const y0 = Math.max(0, Math.floor(mn(py) / 256)), y1 = Math.min(n - 1, Math.floor(mx(py) / 256) + 1);
  const out = new Float32Array(nx * ny);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) return out;
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256, mos = new Float32Array(W * H);
  await Promise.all([...Array(y1 - y0 + 1)].flatMap((_, j) => [...Array(x1 - x0 + 1)].map(async (__, i) => {
    const h = await terrarium(z, ((x0 + i) % n + n) % n, y0 + j);
    if (!h) return;
    for (let r = 0; r < 256; r++) for (let c = 0; c < 256; c++) mos[(j * 256 + r) * W + i * 256 + c] = h[r * 256 + c];
  })));
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) out[y * nx + x] = bilin(mos, W, H, py[y] - y0 * 256, px[x] - x0 * 256) / 1000;
  return out;
}

function sunAngles(t, lon, lat) {
  const sp = sunPosition(t), d = sp.decl * D2R, p = lat * D2R;
  const h = ((((lon - sp.lon + 540) % 360) + 360) % 360 - 180) * D2R;
  const el = Math.asin(clamp(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(h), -1, 1));
  const az = Math.atan2(-Math.cos(d) * Math.sin(h), Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.sin(p) * Math.cos(h));
  return { elev: el / D2R, azim: ((az / D2R) + 360) % 360 };
}

const C1 = 1.191042e8, C2 = 1.4387752e4, WL = 10.4;
const planck = (t) => C1 / (WL ** 5 * (Math.exp(C2 / (WL * Math.max(t, 1))) - 1));
const invPlanck = (b) => C2 / (WL * Math.log1p(C1 / (WL ** 5 * Math.max(b, 1e-6))));

// ------------------------------------------------------------------ entry
/** bands: {ir, red?, snow?, swir?, ir12?} each {codes, w, h, grid, kind, resKm}; bbox [w,s,e,n]. */
export async function buildFields({ bands, bbox, time, sat, sector, sources }) {
  let [w, s, e, n] = bbox;
  if (e < w) e += 360;
  s = Math.max(-80, s); n = Math.min(80, n);
  const latc = (s + n) / 2, lonc = (w + e) / 2, kx = kmPerDegLon(latc);
  const wKm = (e - w) * kx, hKm = (n - s) * KY;
  const irRes = bands.ir.resKm, visRes = bands.red ? bands.red.resKm : irRes;
  let cell = Math.max(visRes, Math.max(wKm, hKm) / MAX_CELLS, 0.25);
  const nx = Math.max(16, Math.round(wKm / cell)), ny = Math.max(16, Math.round(hKm / cell));
  const lon = Float64Array.from({ length: nx }, (_, i) => w + (i + 0.5) / nx * (e - w));
  const lat = Float64Array.from({ length: ny }, (_, j) => n - (j + 0.5) / ny * (n - s));
  cell = Math.max(wKm / nx, hKm / ny);
  const samp = (k, nat) => {
    const b = bands[k];
    if (!b) return null;
    const ss = clamp(Math.round(cell / Math.max(nat, 0.25)), 1, 4);
    if (ss === 1 && nat > 1.4 * cell) return sampleBilinear(b, lon, lat);
    return sampleGeo(b, lon, lat, ss);
  };
  const t = new Date(time);
  const gw = w - GROUND_PAD * (e - w), gs = Math.max(-82, s - GROUND_PAD * (n - s)), ge = e + GROUND_PAD * (e - w), gn = Math.min(82, n + GROUND_PAD * (n - s));
  const gwKm = (ge - gw) * kx, ghKm = (gn - gs) * KY, ecell = Math.max(gwKm, ghKm) / MAX_ELEV_CELLS;
  const enx = Math.max(32, Math.round(gwKm / ecell)), eny = Math.max(32, Math.round(ghKm / ecell));
  const elon = Float64Array.from({ length: enx }, (_, i) => gw + (i + 0.5) / enx * (ge - gw));
  const elat = Float64Array.from({ length: eny }, (_, j) => gn - (j + 0.5) / eny * (gn - gs));
  const [zg, elev] = await Promise.all([ground(lon, lat, cell), ground(elon, elat, ecell)]);
  const bt = samp('ir', irRes), red = samp('red', visRes), r16 = samp('snow', visRes), bt39 = samp('swir', irRes), bt12 = samp('ir12', irRes);
  const N = nx * ny;
  const lat2 = new Float32Array(N), lon2 = new Float32Array(N), mu = new Float32Array(N);
  const sp = sunPosition(t), dd = sp.decl * D2R, sl = sp.lon * D2R;
  const S0 = Math.cos(dd) * Math.cos(sl), S1 = Math.cos(dd) * Math.sin(sl), S2 = Math.sin(dd);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = y * nx + x, la = lat[y] * D2R, lo = normLon(lon[x]) * D2R;
    lat2[i] = lat[y]; lon2[i] = normLon(lon[x]);
    mu[i] = Math.cos(la) * Math.cos(lo) * S0 + Math.cos(la) * Math.sin(lo) * S1 + Math.sin(la) * S2;
  }
  // polar swaths (VIIRS SDR): reflectance already divided by the sun's cosine; looked at from
  // 830 km, not 36 000, so no geostationary parallax shift
  const g = bands.ir.grid, polar = g.proj === 'laea';
  const f = retrieve({ bt, red, r16, bt39, bt12, mu, zg, lat: lat2, t, cell, irRes, nx, ny, reflNorm: polar });
  if (!polar) parallax(f, lon2, lat2, g.lon0, g.H / 1000, kx * (e - w) / nx, KY * (n - s) / ny, nx, ny);
  return {
    result: {
      bbox: [w, s, e, n], center: [lonc, latc], kx, ky: KY, km: [wKm, hKm], cell_km: cell, ir_res_km: irRes, vis_res_km: visRes,
      grid: [nx, ny], field1: halfPack([f.top, f.base, f.ext, f.conv], N), field2: halfPack([f.rain, f.ice, f.tau, f.valid], N),
      field3: halfPack([f.lcl, f.zg], N), ground_bbox: [gw, gs, ge, gn], elev_grid: [enx, eny], elev: halfPack([elev], enx * eny),
      sun: sunAngles(t, normLon(lonc), latc), time: t.toISOString(), sat, sector_used: sector, sources, stats: f.stats,
    },
  };
}

function parallax(f, lon, lat, satLon, satR, cellX, cellY, nx, ny) {
  const N = nx * ny, sx = new Float32Array(N), sy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const la = lat[i] * D2R, lo = (lon[i] - satLon) * D2R;
    const p = [Math.cos(la) * Math.cos(lo) * 6371, Math.cos(la) * Math.sin(lo) * 6371, Math.sin(la) * 6371];
    let l0 = satR - p[0], l1 = -p[1], l2 = -p[2]; const ll = Math.hypot(l0, l1, l2); l0 /= ll; l1 /= ll; l2 /= ll;
    const up = [p[0] / 6371, p[1] / 6371, p[2] / 6371];
    const east = [-Math.sin(lo), Math.cos(lo), 0], north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    const cz = Math.max(l0 * up[0] + l1 * up[1] + l2 * up[2], 0.08);
    sx[i] = -(l0 * east[0] + l1 * east[1] + l2 * east[2]) / cz / cellX;
    sy[i] = (l0 * north[0] + l1 * north[1] + l2 * north[2]) / cz / cellY;
  }
  const hgt = f.top.map((v) => Math.max(v, 0));
  let d = hgt;
  for (let it = 0; it < 2; it++) {
    const nd = new Float32Array(N);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = y * nx + x; nd[i] = bilin(hgt, nx, ny, y + sy[i] * d[i], x + sx[i] * d[i]); }
    d = nd;
  }
  for (const k of ['top', 'base', 'ext', 'conv', 'rain', 'ice', 'tau', 'valid']) {
    const a = f[k], o = new Float32Array(N);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = y * nx + x; o[i] = bilin(a, nx, ny, y + sy[i] * d[i], x + sx[i] * d[i]); }
    f[k] = o;
  }
  for (let i = 0; i < N; i++) { f.base[i] = Math.max(f.base[i], f.zg[i] + 0.05); f.top[i] = Math.max(f.top[i], f.base[i] + 0.12); }
}

function retrieve({ bt: bt0, red, r16, bt39, bt12, mu, zg: zg0, lat, t, cell, irRes, nx, ny, reflNorm = false }) {
  const N = nx * ny;
  const valid = new Uint8Array(N), bt = new Float32Array(N), zg = new Float32Array(N), alat = new Float32Array(N);
  for (let i = 0; i < N; i++) { valid[i] = isF(bt0[i]) ? 1 : 0; bt[i] = valid[i] ? bt0[i] : 290; zg[i] = isF(zg0[i]) ? zg0[i] : 0; alat[i] = Math.abs(lat[i]); }

  // ---- day: reflectance relative to the clear background
  const wDay = mu.map((m) => sstep(0.12, 0.3, m));
  const b = Math.max(4, Math.round(40 / cell));
  const reff = new Float32Array(N), snow = new Uint8Array(N);
  const haveVis = !!red && wDay.some((v) => v > 0);
  if (haveVis) {
    const rn = new Float32Array(N);
    for (let i = 0; i < N; i++) rn[i] = clamp((isF(red[i]) ? red[i] : 0) / (reflNorm ? 1 : Math.max(mu[i], 0.12)), 0, 1.3);
    let rs = upsample(blockStat(rn.map((v, i) => (valid[i] ? v : NaN)), nx, ny, b, 8), nx, ny, 0.08);
    rs = gauss(rs, nx, ny, b * 0.7);
    for (let i = 0; i < N; i++) { rs[i] = clamp(rs[i], 0.02, 0.35); if (zg[i] < 0.005) rs[i] = Math.min(rs[i], 0.1); }
    for (let i = 0; i < N; i++) {
      if (r16) {
        const s16 = (isF(r16[i]) ? r16[i] : 1) / (reflNorm ? 1 : Math.max(mu[i], 0.12));
        const ndsi = (rn[i] - s16) / Math.max(rn[i] + s16, 1e-3);
        snow[i] = ndsi > 0.4 && s16 < 0.22 && bt[i] > 255 ? 1 : 0;
      }
      reff[i] = snow[i] ? 0 : clamp((rn[i] - rs[i]) / (1 - rs[i]), 0, 0.97);
    }
  }

  // ---- clear-sky surface temperature
  const doy = Math.floor((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  const tClim = new Float32Array(N), tRed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const season = Math.cos(2 * Math.PI * (doy - 200) / 365) * Math.sign(lat[i] + 1e-6);
    tClim[i] = 301 - 0.55 * Math.max(0, alat[i] - 12) + 0.25 * Math.max(0, alat[i] - 15) * season - LAPSE * zg[i];
    tRed[i] = valid[i] ? bt[i] + LAPSE * zg[i] : NaN;
  }
  const validRed = []; for (let i = 0; i < N; i++) if (valid[i]) validRed.push(tRed[i]);
  const glob = validRed.length ? percentile(validRed, 98) : 290;
  let tObs = gauss(upsample(blockStat(tRed, nx, ny, b, 95), nx, ny, glob), nx, ny, b * 0.7);
  let floor = glob - 3;
  const climSl = percentile(Array.from(tClim, (v, i) => v + LAPSE * zg[i]), 50);
  let climMargin = glob < climSl - 10 ? 6 : 15;
  if (haveVis) {
    let clear = new Uint8Array(N), nc = 0;
    for (let i = 0; i < N; i++) if (valid[i] && reff[i] < 0.03 && !snow[i] && wDay[i] > 0.5) { clear[i] = 1; nc++; }
    if (nc > Math.max(30, 0.003 * N)) {
      const p80 = percentile(Array.from(clear).flatMap((c, i) => (c ? [tRed[i]] : [])), 80) - 2.5;
      nc = 0; for (let i = 0; i < N; i++) if (clear[i] && tRed[i] < p80) clear[i] = 0; else if (clear[i]) nc++;
    }
    if (nc > Math.max(30, 0.002 * N)) {
      const sg = b * 1.2;
      const num = gauss(Float32Array.from(clear, (c, i) => (c ? tRed[i] : 0)), nx, ny, sg);
      const den = gauss(Float32Array.from(clear), nx, ny, sg);
      const globC = percentile(Array.from(clear).flatMap((c, i) => (c ? [tRed[i]] : [])), 50);
      for (let i = 0; i < N; i++) {
        const wg = clamp(den[i] / 0.05, 0, 1);
        tObs[i] = (den[i] > 1e-4 ? num[i] / Math.max(den[i], 1e-6) : globC) * wg + globC * (1 - wg);
      }
      floor = globC - 4;
      climMargin = globC < climSl - 10 ? 6 : 15;
    }
  }
  const tSfc = new Float32Array(N), dT = new Float32Array(N);
  for (let i = 0; i < N; i++) { tSfc[i] = Math.max(tObs[i], floor, tClim[i] + LAPSE * zg[i] - climMargin) - LAPSE * zg[i]; dT[i] = tSfc[i] - bt[i]; }

  // ---- optical depth by day (two-stream, g = 0.85)
  const tauDay = new Float32Array(N);
  if (haveVis) for (let i = 0; i < N; i++) {
    let v = reff[i] < 0.035 ? 0 : 13.3 * reff[i] / (1 - reff[i]);
    if (dT[i] < 1.5) v *= clamp((reff[i] - 0.15) / 0.3, 0, 1);
    tauDay[i] = v;
  }
  // ---- night / IR: split-window emissivity, 3.9 µm fog
  const btd = new Float32Array(N);
  if (bt12) for (let i = 0; i < N; i++) btd[i] = isF(bt12[i]) ? bt[i] - bt12[i] : 0;
  let btd0 = 0.8;
  if (validRed.length) {
    const vb = []; for (let i = 0; i < N; i++) if (valid[i]) vb.push(bt[i]);
    const thr = Math.min(percentile(vb, 5), 235), cold = [];
    for (let i = 0; i < N; i++) if (valid[i] && bt[i] < thr) cold.push(btd[i]);
    if (cold.length > 20) btd0 = clamp(percentile(cold, 50), 0.8, 3);
  }
  const btdX = btd.map((v) => v - (btd0 - 0.8));
  const epsIr = new Float32Array(N), tauIr = new Float32Array(N), tauFog = new Float32Array(N), tau = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    epsIr[i] = 1 - clamp((btdX[i] - 0.8) / 4.5, 0, 0.85) * sstep(275, 255, bt[i]);
    tauIr[i] = sstep(2.5, 6, dT[i]) * (-2 * Math.log(1 - 0.98 * epsIr[i])) * (1 + clamp(dT[i] / 15, 0, 6));
    if (bt39 && isF(bt39[i])) tauFog[i] = sstep(1.5, 4, bt[i] - bt39[i]) * 8 * (dT[i] < 8 ? 1 : 0) * (1 - wDay[i]);
    tau[i] = wDay[i] * tauDay[i] + (1 - wDay[i]) * Math.max(tauIr[i], tauFog[i]);
  }
  const opaque = new Float32Array(N);
  for (let i = 0; i < N; i++) opaque[i] = sstep(1.6, 0.7, btdX[i]) * sstep(12, 30, dT[i]);
  const kRim = Math.max(3, Math.round(Math.min(3 * irRes / cell, 1 + 2 * irRes / Math.max(cell, irRes)))) | 1;
  const opD = maxFilter(opaque.map((o, i) => o * (dT[i] > 20 ? 1 : 0)), nx, ny, kRim);
  const tauOp = maxFilter(tauIr.map((v, i) => v * opaque[i]), nx, ny, kRim);
  const rim = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    rim[i] = opD[i] * sstep(8, 20, dT[i]) * (1 - opaque[i]);
    const shade = haveVis ? sstep(6, 12, dT[i]) * sstep(2.5, 1, btdX[i]) * (reff[i] < 0.12 ? 1 : 0) * wDay[i] : 0;
    tau[i] = valid[i] ? clamp(Math.max(tau[i], tauIr[i] * opaque[i], tauOp[i] * rim[i], tauIr[i] * shade), 0, 150) : 0;
  }

  // ---- cloud-top temperature (semi-transparency, broken low cloud)
  const zTop = new Float32Array(N), tc = new Float32Array(N), tauIn = new Float32Array(N), zTrop = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let eps = wDay[i] > 0.5 ? 1 - Math.exp(-tau[i] / 2.13) : epsIr[i];
    eps = clamp(eps, 0.25, 1);
    const thinIce = sstep(1.2, 3, btdX[i]) * sstep(282, 258, bt[i]) * (1 - rim[i]);
    const bObs = planck(bt[i]), bSfc = planck(tSfc[i]);
    const tcc = invPlanck(Math.max((bObs - (1 - eps) * bSfc) / eps, 1e-4));
    let tcv = dT[i] > 3 ? bt[i] + (Math.max(tcc, bt[i] - 40) - bt[i]) * thinIce : bt[i];
    let fSub = 1;
    if (haveVis && wDay[i] > 0.5 && bt[i] > 258 && tau[i] > 0.3) fSub = clamp(reff[i] / 0.45, 0, 1);
    const fs = Math.max(fSub, 0.25);
    const tcb = invPlanck(Math.max((bObs - (1 - fs) * bSfc) / fs, 1e-4));
    const broken = fSub < 0.98 && thinIce < 0.5 && dT[i] > 0.5;
    if (broken) tcv = Math.max(Math.min(tcv, tcb), bt[i] - 25);
    tauIn[i] = broken ? Math.max(tau[i], 9) : tau[i];
    zTrop[i] = 17 - 7 * sstep(15, 65, alat[i]);
    const tTrop = tSfc[i] - LAPSE * (zTrop[i] - zg[i]);
    tcv = Math.max(tcv, tTrop - 18);
    tc[i] = tcv;
    let z = tcv >= tTrop ? zg[i] + (tSfc[i] - tcv) / LAPSE : zTrop[i] + Math.min((tTrop - tcv) / 8, 3);
    if (tauFog[i] > tauIr[i]) z = zg[i] + clamp(dT[i] / LAPSE, 0.15, 0.6);
    zTop[i] = Math.max(z, zg[i] + 0.25);
  }

  // ---- base and thickness by cloud type
  const ice = new Float32Array(N), lcl = new Float32Array(N), lifted = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    ice[i] = sstep(263, 238, tc[i]);
    const tSl = tSfc[i] + LAPSE * zg[i];
    lcl[i] = zg[i] + clamp(0.6 + (tSl - 288) * 0.03, 0.4, 1.8) * (zg[i] < 0.005 ? 0.75 : 1);
    lifted[i] = tau[i] > 0.3 && tauFog[i] <= tauIr[i] ? 1 : 0;
    if (lifted[i]) zTop[i] = Math.max(zTop[i], lcl[i] + clamp(0.12 * Math.sqrt(tauIn[i]), 0.25, 1));
  }
  const k = Math.max(3, Math.round(6 / cell) | 1);
  const m1 = uniform(zTop, nx, ny, k), m2 = uniform(zTop.map((v) => v * v), nx, ny, k);
  const tex = new Float32Array(N), deep = new Float32Array(N);
  for (let i = 0; i < N; i++) { tex[i] = clamp(Math.sqrt(Math.max(m2[i] - m1[i] * m1[i], 0)) / 0.7, 0, 1); deep[i] = sstep(245, 222, tc[i]) * sstep(18, 45, tau[i]); }
  const kCore = 2 * Math.max(3, Math.round(8 / cell)) + 1;
  const deepTop = maxFilter(zTop.map((z, i) => (deep[i] > 0.5 ? z : 0)), nx, ny, kCore);
  const base = new Float32Array(N), cloud = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const pSlope = sstep(1, 3, deepTop[i] - zTop[i]) * sstep(1.5, 3.5, zTop[i] - lcl[i]) * sstep(0.3, 2, tau[i]) * (tauFog[i] <= tauIr[i] ? 1 : 0);
    tau[i] = Math.max(tau[i], 25 * pSlope);
    tauIn[i] = Math.max(tauIn[i], tau[i]);
    const above = zTop[i] - lcl[i];
    const hLiq = 0.2 + 0.1 * Math.pow(Math.max(tauIn[i], 0.01), 0.8), hIce = clamp(1.2 + 0.15 * tau[i], 1.2, 5);
    const hLayer = hLiq + (hIce - hLiq) * ice[i];
    const pBl = sstep(4, 2.5, above) * sstep(0.4, 2.5, tauIn[i]);
    const pTower = tex[i] * sstep(3, 12, tauIn[i]) * (1 - 0.5 * ice[i] * (1 - deep[i]));
    const pThick = sstep(12, 35, tauIn[i]);
    let pCol = Math.max(pBl, pTower, pThick, deep[i], pSlope);
    if (tauFog[i] > tauIr[i]) pCol = 0;
    const bl = Math.max(zg[i] + 0.05, zTop[i] - hLayer);
    let bs = bl + (Math.min(lcl[i], bl) - bl) * pCol;
    bs = Math.max(bs, Math.min(zg[i] + 0.4 * (lcl[i] - zg[i]), zTop[i] - 0.15));
    if (lifted[i]) bs = Math.max(bs, Math.min(lcl[i], zTop[i] - 0.25));
    base[i] = Math.min(bs, zTop[i] - 0.12);
    cloud[i] = tau[i] > 0.3 ? 1 : 0;
  }
  const sigIr = Math.max(0.5, 0.6 * irRes / cell);
  const zFill = fillNearest(zTop, cloud, nx, ny), zBlur = gauss(zFill, nx, ny, sigIr);
  const topF = new Float32Array(N);
  for (let i = 0; i < N; i++) topF[i] = zFill[i] + clamp(zBlur[i] - zFill[i], -0.8, 0.8);
  let dayShare = 0; for (let i = 0; i < N; i++) if (wDay[i] > 0.5) dayShare++;
  if (dayShare / N > 0.3) {
    const kt = Math.max(2, 2.5 / cell);
    const lt = gauss(tau, nx, ny, 0.5).map((v) => Math.log(Math.max(v, 0.3)));
    const ltB = gauss(lt, nx, ny, kt);
    for (let i = 0; i < N; i++) {
      const rel = clamp(lt[i] - ltB[i], -1.2, 1.2);
      topF[i] += rel * 0.22 * clamp(topF[i] - base[i], 0.2, 2.5) * (1 - ice[i]) * wDay[i] * cloud[i];
    }
  }
  const bFill = fillNearest(base, cloud, nx, ny), bBlur = gauss(bFill, nx, ny, sigIr);
  const baseF = new Float32Array(N);
  for (let i = 0; i < N; i++) baseF[i] = Math.min(bFill[i] + clamp(bBlur[i] - bFill[i], -0.8, 0.8), topF[i] - 0.12);
  const tauS = gauss(tau.map((v, i) => (cloud[i] ? v : 0)), nx, ny, 0.6);
  const ext = new Float32Array(N);
  for (let i = 0; i < N; i++) ext[i] = clamp(tauS[i] / Math.max(topF[i] - baseF[i], 0.1), 0, 90);
  const conv0 = new Float32Array(N);
  for (let i = 0; i < N; i++) conv0[i] = tauFog[i] > tauIr[i] ? 0 : Math.max(tex[i], deep[i]);
  const conv = gauss(fillNearest(conv0, cloud, nx, ny), nx, ny, 1);
  const rain = gauss(deep.map((d, i) => d * sstep(35, 90, tau[i]) * sstep(235, 205, tc[i])), nx, ny, Math.max(1, 1.5 / cell));
  const iceF = gauss(fillNearest(ice, cloud, nx, ny), nx, ny, sigIr);

  // ---- stats
  const cv = [], ct = [], cb = [];
  let nValid = 0, nCloud = 0, tauSum = 0, zgMax = 0;
  for (let i = 0; i < N; i++) {
    zgMax = Math.max(zgMax, zg[i]);
    if (valid[i]) { nValid++; tauSum += tauS[i]; if (cloud[i]) nCloud++; }
    if (cloud[i]) { cv.push(zTop[i]); ct.push(tau[i]); cb.push(baseF[i]); }
  }
  const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  let topMax = -Infinity, baseMin = Infinity, depthSum = 0;
  for (let i = 0; i < N; i++) if (cloud[i]) { topMax = Math.max(topMax, topF[i]); baseMin = Math.min(baseMin, baseF[i]); depthSum += topF[i] - baseF[i]; }
  const btMin = (() => { let m = Infinity; for (let i = 0; i < N; i++) if (valid[i]) m = Math.min(m, bt[i]); return m; })();
  const stats = {
    cloud_frac: r2(nValid ? nCloud / nValid : 0, 3),
    max_top_km: r2(cv.length ? percentile(cv, 99.5) : 0), mean_top_km: r2(cv.length ? cv.reduce((a, v) => a + v, 0) / cv.length : 0),
    min_base_km: r2(cb.length ? baseMin : 0), mean_base_km: r2(cb.length ? cb.reduce((a, v) => a + v, 0) / cb.length : 0),
    mean_depth_km: r2(cv.length ? depthSum / cv.length : 0), lcl_km: r2(percentile(Array.from(lcl, (v, i) => v - zg[i]), 50)),
    max_tau: r2(ct.length ? percentile(ct, 99) : 0, 1), mean_tau: r2(nValid ? tauSum / nValid : 0),
    t_sfc_k: r2(percentile(Array.from(tSfc), 50), 1), min_bt_k: r2(isFinite(btMin) ? btMin : 0, 1),
    tropopause_km: r2(percentile(Array.from(zTrop), 50), 1), day_frac: r2(wDay.reduce((a, v) => a + v, 0) / N),
    coverage: r2(nValid / N, 3), max_ground_km: r2(zgMax),
    alt_lo: r2(cb.length ? baseMin - 0.5 : 0), alt_hi: r2(cv.length ? topMax + 2.5 : 1),
  };
  return { top: topF, base: baseF, ext, conv, rain, ice: iceF, tau: tauS, valid: Float32Array.from(valid), lcl, zg, stats };
}
