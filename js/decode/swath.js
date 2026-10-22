/* Polar-orbiter swaths -> a local equal-area grid, by nearest swath pixel (decode-worker side of
 * polar.js). Nothing is interpolated except pixel *positions*: VIIRS I-band pixels nest 2x2 inside
 * the 750 m geolocation, so their centres are placed inside each 16-line scan from those points.
 *
 *   swathGeo    one granule's geolocation (lat / lon arrays, nadir track, edge samples)
 *   swathRing   one granule's outline (G-Ring metadata only)
 *   swathSplat  one granule's bands: every swath pixel claims the grid cells within its footprint
 *               that no nearer pixel has claimed (a distance buffer), giving each cell its nearest
 *               pixel; bow-tie deleted / fill pixels never claim cells (the overlapping scan does)
 *   swathMerge  the granules' parts into one frame (nearest wins), DNB contrast, VIIRS RGBs
 *   atmsSlice   ATMS footprints (MiRS IMG files) of a slice, the same way with their own footprints
 */
import { H5File, decodeChunk } from './hdf5.js';
import { RangeSource, stats } from './range.js';
import { Q16, NAN_CODE } from '../catalog.js';
import { lonlatToXY, trackTurn } from '../geo.js';

const D2R = Math.PI / 180;

function encoder(kind) {
  const [lo, hi] = Q16[kind], k = 65534 / (hi - lo);
  return (v) => {
    if (!(v === v)) return NAN_CODE;
    const c = (v - lo) * k + 0.5;
    return c < 0 ? 0 : c > 65534 ? 65534 : c | 0;
  };
}

/** A whole dataset as a typed array (contiguous, compact or chunked 1-D / 2-D). */
async function readArray(f, ds) {
  const L = ds.layout, t = ds.dtype, es = t.size, n = ds.shape.reduce((a, b) => a * b, 1);
  let bytes;
  if (L.cls === 0) bytes = L.data;
  else if (L.cls === 1) bytes = await f._read(L.addr, n * es);
  else {
    bytes = new Uint8Array(n * es);
    const sh = ds.shape.length === 1 ? [1, ds.shape[0]] : ds.shape;
    const cs = L.chunk.length === 1 ? [1, L.chunk[0]] : L.chunk;
    const [H, W] = sh, [cr, cc] = cs;
    const chunks = await f.chunkList(ds);
    await Promise.all(chunks.map(async (ch) => {
      const raw = await decodeChunk(await f._read(ch.addr, ch.size), ds.filters, ch.mask, es);
      const off = ch.off.length === 1 ? [0, ch.off[0]] : ch.off;
      const cols = Math.min(cc, W - off[1]);
      for (let r = 0; r < cr && off[0] + r < H; r++) bytes.set(raw.subarray(r * cc * es, (r * cc + cols) * es), ((off[0] + r) * W + off[1]) * es);
    }));
  }
  const le = t.le !== false;
  const Ty = t.cls === 1 ? (es === 4 ? Float32Array : Float64Array)
    : es === 2 ? (t.signed ? Int16Array : Uint16Array) : es === 4 ? (t.signed ? Int32Array : Uint32Array) : es === 1 ? (t.signed ? Int8Array : Uint8Array) : null;
  if (!Ty) throw new Error('unsupported datatype');
  const aligned = bytes.byteOffset % es === 0 ? bytes : bytes.slice();
  const out = new Ty(aligned.buffer, aligned.byteOffset, n);
  if (!le && es > 1) { // big-endian: swap in place on a copy
    const v = new DataView(aligned.buffer, aligned.byteOffset, n * es), o = new Ty(n);
    for (let i = 0; i < n; i++) o[i] = t.cls === 1 ? (es === 4 ? v.getFloat32(i * 4) : v.getFloat64(i * 8)) : es === 2 ? (t.signed ? v.getInt16(i * 2) : v.getUint16(i * 2)) : (t.signed ? v.getInt32(i * 4) : v.getUint32(i * 4));
    return o;
  }
  return out;
}

const okLat = (v) => v >= -90 && v <= 90;

// ------------------------------------------------------------------ VIIRS
export async function swathGeo({ url, size, group }, signal) {
  const b0 = stats.bytes;
  const src = new RangeSource(url, size, { head: 64 * 1024, signal });
  const f = await H5File.open(src);
  const [dla, dlo] = await Promise.all([f.dataset(`All_Data/${group}/Latitude`), f.dataset(`All_Data/${group}/Longitude`)]);
  const [lat, lon] = await Promise.all([readArray(f, dla), readArray(f, dlo)]);
  const [ny, nx] = dla.shape;
  const nadir = [], edge = [], mid = nx >> 1;
  for (let r = 0; r < ny; r += 8) {
    let k = r * nx + mid;
    if (okLat(lat[k])) nadir.push([lon[k], lat[k]]);
    for (const c of [0, 1, 2, nx - 3, nx - 2, nx - 1]) { k = r * nx + c; if (okLat(lat[k])) edge.push([lon[k], lat[k]]); }
  }
  for (const r of [0, ny - 1]) for (let c = 0; c < nx; c += 64) { const k = r * nx + c; if (okLat(lat[k])) edge.push([lon[k], lat[k]]); }
  return { result: { lat, lon, ny, nx, nadir, edge, bytes: stats.bytes - b0 }, transfer: [lat.buffer, lon.buffer] };
}

/** A granule's outline from its geolocation file's metadata (the G-Ring: 8+ [lon, lat] points
 *  around the swath), without reading the geolocation arrays. */
export async function swathRing({ url, size, group }, signal) {
  const f = await H5File.open(new RangeSource(url, size, { head: 64 * 1024, signal }));
  const prod = group.replace(/_All$/, '');
  const a = await f.attrs(`Data_Products/${prod}/${prod}_Gran_0`);
  const la = a.get('G-Ring_Latitude') || [], lo = a.get('G-Ring_Longitude') || [];
  const ring = [];
  for (let i = 0; i < Math.min(la.length, lo.length); i++) if (okLat(la[i])) ring.push([lo[i], la[i]]);
  return { result: ring };
}

/** Grid row / column of every geolocation pixel (NaN where there is none). */
function project(lat, lon, grid) {
  const n = lat.length, X = new Float32Array(n), Y = new Float32Array(n);
  const sp0 = Math.sin(grid.lat0 * D2R), cp0 = Math.cos(grid.lat0 * D2R), R = 6371.0072;
  const ix = 1 / grid.dx, iy = 1 / grid.dy, rc = grid.rs ? grid.rc : 1, rs = grid.rs || 0;
  for (let i = 0; i < n; i++) {
    const la = lat[i];
    if (!(la >= -90 && la <= 90)) { X[i] = NaN; Y[i] = NaN; continue; }
    const p = la * D2R, dl = (lon[i] - grid.lon0) * D2R, sp = Math.sin(p), cp = Math.cos(p), cdl = Math.cos(dl);
    const d = 1 + sp0 * sp + cp0 * cp * cdl;
    if (d < 1e-6) { X[i] = NaN; Y[i] = NaN; continue; }
    const k = R * Math.sqrt(2 / d), x = k * cp * Math.sin(dl), y = k * (cp0 * sp - sp0 * cp * cdl);
    X[i] = (x * rc - y * rs - grid.x0) * ix;   // same turn of the axes as geo.js lonlatToXY
    Y[i] = (x * rs + y * rc - grid.y0) * iy;
  }
  return [X, Y];
}

/** One VIIRS band as storage codes (uint16 scaled BT / reflectance; DNB radiance as log10). */
async function bandCodes({ url, size, group, kind }, q, signal) {
  const src = new RangeSource(url, size, { head: 64 * 1024, signal });
  const f = await H5File.open(src);
  const enc = encoder(q);
  if (kind === 'dnb') {
    const rad = await readArray(f, await f.dataset(`All_Data/${group}/Radiance`));
    const out = new Uint16Array(rad.length);
    for (let i = 0; i < rad.length; i++) { const v = rad[i]; out[i] = v > 0 ? enc(Math.log10(v)) : NAN_CODE; }
    return out;
  }
  const name = kind === 'ir' ? 'BrightnessTemperature' : 'Reflectance';
  const [ds, fd] = await Promise.all([f.dataset(`All_Data/${group}/${name}`), f.dataset(`All_Data/${group}/${name}Factors`).catch(() => null)]);
  const [raw, fac] = await Promise.all([readArray(f, ds), fd ? readArray(f, fd) : null]);
  const sc = fac ? fac[0] : 1, of = fac ? fac[1] : 0;
  const lut = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) lut[i] = i >= 65528 ? NAN_CODE : enc(i * sc + of); // 65528+: fill / bow-tie deleted
  const out = new Uint16Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = lut[raw[i]];
  return out;
}

/** bands: [{url, size, group, kind, fine, q?, optional?}]; a band's own q overrides q, an
 *  optional band that cannot be read is left empty instead of dropping the granule. */
export async function swathSplat({ lat, lon, gy, gx, geoKind, grid, bands, q }, signal) {
  const b0 = stats.bytes;
  // reflective bands on the night side come as near-empty files: no data, not an error
  const read = (b) => bandCodes(b, b.q || q, signal).catch((e) => { if (signal?.aborted) throw e; return null; });
  const [codesIn, [X, Y]] = await Promise.all([Promise.all(bands.map(read)), Promise.resolve(project(lat, lon, grid))]);
  const empty = () => ({ result: { r0: 0, c0: 0, h: 0, w: 0, dist: new Float32Array(0), codes: bands.map(() => new Uint16Array(0)), bytes: stats.bytes - b0 } });
  const ok = (c) => c && c.length;
  if (!ok(codesIn[0])) return empty();
  for (let j = 1; j < bands.length; j++) {
    if (ok(codesIn[j]) && codesIn[j].length === codesIn[0].length) continue;
    if (!bands[j].optional) return empty();
    codesIn[j] = new Uint16Array(codesIn[0].length).fill(NAN_CODE);
  }
  const nIn = codesIn[0].length;
  const f = Math.round(Math.sqrt(nIn / (gy * gx))) || 1;   // 2: I band on the 750 m geolocation
  const by = gy * f, bx = gx * f;
  const scanG = geoKind === 'I' ? 32 : 16;                  // geolocation lines per scan
  // the part of the grid this granule covers
  let rmin = Infinity, rmax = -Infinity, cmin = Infinity, cmax = -Infinity;
  for (let i = 0; i < X.length; i += 7) { const x = X[i], y = Y[i]; if (x === x) { if (x < cmin) cmin = x; if (x > cmax) cmax = x; if (y < rmin) rmin = y; if (y > rmax) rmax = y; } }
  const r0 = Math.max(0, Math.floor(rmin) - 8), c0 = Math.max(0, Math.floor(cmin) - 8);
  const r1 = Math.min(grid.ny, Math.ceil(rmax) + 9), c1 = Math.min(grid.nx, Math.ceil(cmax) + 9);
  const h = Math.max(0, r1 - r0), w = Math.max(0, c1 - c0);
  const dist = new Float32Array(h * w).fill(Infinity);
  const out = bands.map(() => new Uint16Array(h * w).fill(NAN_CODE));
  if (!h || !w) return { result: { r0, c0, h, w, dist, codes: out, bytes: stats.bytes - b0 }, transfer: [dist.buffer, ...out.map((o) => o.buffer)] };
  // pixel size in grid cells (nadir): heavily downsampled grids take every s-th pixel
  const nadirPx = (Math.hypot(X[(gy >> 1) * gx + (gx >> 1) + 1] - X[(gy >> 1) * gx + (gx >> 1)], Y[(gy >> 1) * gx + (gx >> 1) + 1] - Y[(gy >> 1) * gx + (gx >> 1)]) || 1) / f;
  const s = Math.max(1, Math.floor(0.6 / nadirPx));
  const nb = bands.length, C0 = codesIn[0];
  for (let ri = 0; ri < by; ri += s) {
    const rg = (ri / f) | 0, scan0 = Math.floor(rg / scanG) * scanG;
    // geolocation row used for spacing / interpolation (rows of the same scan only)
    for (let ci = 0; ci < bx; ci += s) {
      const k = ri * bx + ci, code = C0[k];
      if (code === NAN_CODE) continue;
      let x, y, kg;
      if (f === 1) { kg = k; x = X[k]; y = Y[k]; if (!(x === x)) continue; }
      else {
        // I pixel centre inside its 16-line M scan: (ri, ci) -> fractional M row / column
        const mr = scan0 + ((ri - scan0 * 2) - 0.5) / 2, mc = (ci - 0.5) / 2;
        const ra = Math.min(scan0 + scanG - 2, Math.max(scan0, Math.floor(mr))), ca = Math.min(gx - 2, Math.max(0, Math.floor(mc)));
        const wr = mr - ra, wc = mc - ca, k00 = ra * gx + ca;
        const x00 = X[k00], x01 = X[k00 + 1], x10 = X[k00 + gx], x11 = X[k00 + gx + 1];
        if (!(x00 === x00 && x01 === x01 && x10 === x10 && x11 === x11)) continue;
        x = (x00 * (1 - wc) + x01 * wc) * (1 - wr) + (x10 * (1 - wc) + x11 * wc) * wr;
        y = (Y[k00] * (1 - wc) + Y[k00 + 1] * wc) * (1 - wr) + (Y[k00 + gx] * (1 - wc) + Y[k00 + gx + 1] * wc) * wr;
        kg = Math.min(gy - 1, Math.round(mr)) * gx + Math.min(gx - 1, Math.round(mc));
      }
      // footprint radius from the spacing to the next pixel across and along the scan
      const rgk = (kg / gx) | 0, cgk = kg - rgk * gx;
      const kc = cgk < gx - 1 ? kg + 1 : kg - 1;
      const ka = (rgk + 1) % scanG !== 0 && rgk + 1 < gy ? kg + gx : kg - gx;
      let sc = Math.hypot(X[kc] - X[kg], Y[kc] - Y[kg]), sa = Math.hypot(X[ka] - X[kg], Y[ka] - Y[kg]);
      if (!(sc === sc)) sc = nadirPx * f; if (!(sa === sa)) sa = sc;
      const rr = Math.min(8, 0.5 * Math.max(sc, sa) / f * s + 0.5), r2 = rr * rr;
      const ya = Math.max(r0, Math.ceil(y - rr)), yb = Math.min(r1 - 1, Math.floor(y + rr));
      const xa = Math.max(c0, Math.ceil(x - rr)), xb = Math.min(c1 - 1, Math.floor(x + rr));
      for (let cy = ya; cy <= yb; cy++) {
        const dy = cy - y, dy2 = dy * dy, row = (cy - r0) * w - c0;
        for (let cx = xa; cx <= xb; cx++) {
          const dx = cx - x, d2 = dx * dx + dy2;
          if (d2 > r2) continue;
          const o = row + cx;
          if (d2 < dist[o]) {
            dist[o] = d2;
            out[0][o] = code;
            for (let b = 1; b < nb; b++) out[b][o] = codesIn[b][k];
          }
        }
      }
    }
  }
  return { result: { r0, c0, h, w, dist, codes: out, bytes: stats.bytes - b0 }, transfer: [dist.buffer, ...out.map((o) => o.buffer)] };
}

// satpy / CIRA style true-colour tone curve (piecewise linear)
const TC_X = [0, 25, 55, 100, 255].map((v) => v / 255), TC_Y = [0, 90, 140, 175, 255].map((v) => v / 255);
function tone(a) {
  const v = Math.min(1.1, Math.max(0, a)) / 1.1;
  for (let i = 1; i < TC_X.length; i++) if (v <= TC_X[i]) return TC_Y[i - 1] + (TC_Y[i] - TC_Y[i - 1]) * (v - TC_X[i - 1]) / (TC_X[i] - TC_X[i - 1]);
  return 1;
}

export function swathMerge({ parts, grid, nb, q, rgb, all = false }) {
  const N = grid.nx * grid.ny, W = grid.nx;
  const codes = Array.from({ length: nb }, () => new Uint16Array(N).fill(NAN_CODE));
  const dist = new Float32Array(N).fill(Infinity);
  for (const p of parts) {
    for (let r = 0; r < p.h; r++) {
      const src = r * p.w, dst = (p.r0 + r) * W + p.c0;
      for (let c = 0; c < p.w; c++) {
        const d = p.dist[src + c];
        if (d < dist[dst + c]) {
          dist[dst + c] = d;
          for (let b = 0; b < nb; b++) codes[b][dst + c] = p.codes[b][src + c];
        }
      }
    }
  }
  let any = false;
  for (let i = 0; i < N && !any; i += 97) any = codes[0][i] !== NAN_CODE;
  for (let i = 0; i < N && !any; i++) any = codes[0][i] !== NAN_CODE;
  if (!any) throw new Error(q === 'refl' ? 'No daylight in this slice: visible bands are empty on the night side (try an infrared band or the Day/Night Band)' : 'No data in this slice');
  const out = { codes: codes[0], grid };
  const transfer = [codes[0].buffer];
  if (all) { out.bands = codes; transfer.push(...codes.slice(1).map((c) => c.buffer)); }
  const [lo, hi] = Q16[q], cs = (hi - lo) / 65534;
  if (q === 'lograd') {
    // Day/Night Band contrast from this slice: 2nd .. 99.7th percentile of log radiance
    const hist = new Uint32Array(4096);
    let n = 0;
    for (let i = 0; i < N; i += 3) { const c = codes[0][i]; if (c !== NAN_CODE) { hist[c >> 4]++; n++; } }
    const pct = (p) => { let acc = 0; for (let b = 0; b < 4096; b++) { acc += hist[b]; if (acc >= n * p) return ((b << 4) + 8) * cs + lo; } return hi; };
    if (n) { const a = pct(0.02), b = pct(0.997); out.range = [a, Math.max(b, a + 0.5)]; }
  }
  if (rgb) {
    const rgba = new Uint8Array(N * 4);
    const tc = rgb === 'v_truecolor';
    for (let i = 0; i < N; i++) {
      const a = codes[0][i], b = codes[1][i], c = codes[2][i];
      if (a === NAN_CODE || b === NAN_CODE || c === NAN_CODE) continue;
      const v = [a * cs + lo, b * cs + lo, c * cs + lo];
      for (let ch = 0; ch < 3; ch++) rgba[i * 4 + ch] = 255 * (tc ? tone(v[ch]) : Math.min(1, Math.max(0, v[ch])) ** 0.8) + 0.5;
      rgba[i * 4 + 3] = 255;
    }
    out.rgba = rgba;
    transfer.push(rgba.buffer);
  }
  return { result: out, transfer };
}

// ------------------------------------------------------------------ ATMS (MiRS IMG)
export async function atmsSlice({ files, ch, q, km, framePx }, signal) {
  const b0 = stats.bytes;
  const enc = encoder(q);
  const got = await Promise.all(files.map(async ({ url, size }) => {
    try {
      const f = await H5File.open(new RangeSource(url, size, { head: size, signal }));
      const [la, lo] = await Promise.all([f.dataset('Latitude'), f.dataset('Longitude')]);
      const vname = q === 'mwbt' ? 'YM' : q === 'logrr' ? 'RR' : 'TPW';
      const dv = await f.dataset(vname);
      const [lat, lon, raw] = await Promise.all([readArray(f, la), readArray(f, lo), readArray(f, dv)]);
      const [ns, nf] = la.shape, nch = dv.shape[2] || 1;
      const val = new Uint16Array(ns * nf);
      for (let i = 0; i < ns * nf; i++) {
        const r = q === 'mwbt' ? raw[i * nch + ch] : raw[i];
        if (r <= -999 || !(r === r)) { val[i] = NAN_CODE; continue; }
        val[i] = q === 'mwbt' ? enc(r * 0.015) : q === 'tpw' ? (r < 0 ? NAN_CODE : enc(r * 0.1)) : (r < 0 ? NAN_CODE : enc(r > 0.01 ? Math.log10(r) : -2));
      }
      return { lat, lon, val, ns, nf };
    } catch (e) { if (signal?.aborted) throw e; return null; }
  }));
  const parts = got.filter(Boolean);
  if (!parts.length) throw new Error('No readable ATMS granules in this time slice');
  // grid: centred on the mean nadir footprint
  let sx = 0, sy = 0, sz = 0, n = 0;
  const track = [];
  for (const p of parts) for (let i = 0; i < p.ns; i++) {
    const k = i * p.nf + (p.nf >> 1), la = p.lat[k], lo = p.lon[k];
    if (!okLat(la)) continue;
    const a = lo * D2R, b = la * D2R;
    sx += Math.cos(b) * Math.cos(a); sy += Math.cos(b) * Math.sin(a); sz += Math.sin(b); n++;
    if (i % 3 === 0) track.push([lo, la]);
  }
  if (!n) throw new Error('No ATMS geolocation in this time slice');
  const lon0 = Math.atan2(sy, sx) / D2R, lat0 = Math.atan2(sz, Math.hypot(sx, sy)) / D2R;
  const g0 = { proj: 'laea', lon0, lat0, ...trackTurn(lon0, lat0, track) };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const o = [0, 0];
  for (const p of parts) for (let i = 0; i < p.lat.length; i++) {
    if (!okLat(p.lat[i]) || !lonlatToXY(g0, p.lon[i], p.lat[i], o)) continue;
    if (o[0] < x0) x0 = o[0]; if (o[0] > x1) x1 = o[0]; if (o[1] < y0) y0 = o[1]; if (o[1] > y1) y1 = o[1];
  }
  const pad = 40; // km: edge footprints are ~70 km across
  const res = Math.max(km, Math.sqrt(((x1 - x0 + 2 * pad) * (y1 - y0 + 2 * pad)) / framePx));
  const grid = { ...g0, x0: x0 - pad + res / 2, dx: res, y0: y1 + pad - res / 2, dy: -res,
    nx: Math.ceil((x1 - x0 + 2 * pad) / res), ny: Math.ceil((y1 - y0 + 2 * pad) / res) };
  const N = grid.nx * grid.ny, codes = new Uint16Array(N).fill(NAN_CODE), dist = new Float32Array(N).fill(Infinity);
  for (const p of parts) {
    const [X, Y] = project(p.lat, p.lon, grid);
    for (let i = 0; i < p.ns; i++) for (let j = 0; j < p.nf; j++) {
      const k = i * p.nf + j, code = p.val[k], x = X[k], y = Y[k];
      if (code === NAN_CODE || !(x === x)) continue;
      const kc = j < p.nf - 1 ? k + 1 : k - 1, ka = i < p.ns - 1 ? k + p.nf : k - p.nf;
      let sc = Math.hypot(X[kc] - x, Y[kc] - y), sa = Math.hypot(X[ka] - x, Y[ka] - y);
      if (!(sc === sc)) sc = 16 / res; if (!(sa === sa)) sa = sc;
      const rr = Math.min(48, 0.55 * Math.max(sc, sa) + 0.5), r2 = rr * rr;
      for (let cy = Math.max(0, Math.ceil(y - rr)); cy <= Math.min(grid.ny - 1, Math.floor(y + rr)); cy++) {
        const dy2 = (cy - y) ** 2, row = cy * grid.nx;
        for (let cx = Math.max(0, Math.ceil(x - rr)); cx <= Math.min(grid.nx - 1, Math.floor(x + rr)); cx++) {
          const d2 = (cx - x) ** 2 + dy2;
          if (d2 <= r2 && d2 < dist[row + cx]) { dist[row + cx] = d2; codes[row + cx] = code; }
        }
      }
    }
  }
  return { result: { codes, grid, track, bytes: stats.bytes - b0 }, transfer: [codes.buffer] };
}
