/* Polar orbiters (NOAA-20, NOAA-21, Suomi NPP): VIIRS imager and ATMS microwave time slices.
 *
 * A frame is a *slice*: every granule that started inside one time window (2-20 min), i.e. the
 * strip of earth the satellite scanned then. VIIRS SDR granules (~85 s) and their geolocation
 * share a start time in their names (SVI05_j01_d20261021_t0000304_..., GMTCO_j01_d20261021_t0000304_...);
 * ATMS comes from the MiRS IMG files (~32 s). In the decode workers each slice is resampled onto a
 * local equal-area grid by nearest swath pixel (decode/swath.js); from then on it is a frame like
 * any other (tiles, probing, colour tables, smoothing, loops). The 3D cloud volume reads its own
 * bands (I5 + I1) for just the granules that cross its box (loadPolarBox).
 */
import { SATS, VIIRS, VIIRS_GEO, polarSource, SLICE_MIN, NAN_CODE } from './catalog.js';
import { listKeys, s3url } from './listing.js';
import { lonlatToXY, laeaXY, trackTurn } from './geo.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const dayPath = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
const RE_SDR = /_d(\d{8})_t(\d{6})(\d)_e/;
const RE_MIRS = /NPR-MIRS-IMG_v\w+?_(?:n20|n21|npp)_s(\d{14})/;
// share of each file a frame reads (VIIRS: the calibrated band, not radiance / flags; geolocation: lat / lon)
const SHARE = { band: 0.5, dnb: 0.95, M: 0.27, I: 0.27, D: 0.2 };

function days(t0, t1) {
  const out = [];
  for (let d = Math.floor(t0 / 864e5) * 864e5; d <= t1; d += 864e5) out.push(d);
  return out;
}
const ttlFor = (d) => (Date.now() - d < 1.2 * 864e5 ? 60e3 : 6 * 3600e3);

/** Granules of one SDR / geolocation folder starting in [t0, t1]: Map(id -> {key, size, t}).
 *  Names sort by start time, so listings begin at the window's hour, not at midnight. */
async function sdrGranules(bucket, folder, token, tag, t0, t1, signal) {
  const out = new Map();
  await Promise.all(days(t0, t1).map(async (d) => {
    const day = new Date(d), pfx = `${folder}/${dayPath(day)}/`;
    const from = new Date(Math.floor(Math.max(d, t0 - 3 * 60e3) / 3600e3) * 3600e3);
    const keys = await listKeys(bucket, pfx, ttlFor(d), signal, { startAfter: `${pfx}${token}_${tag}_d${ymd(day)}_t${pad(from.getUTCHours())}0000` }).catch(() => []);
    for (const { key, size } of keys) {
      const m = key.endsWith('.h5') && RE_SDR.exec(key); // (folders also hold .sha384 checksums)
      if (!m) continue;
      const a = m[1], b = m[2];
      const t = Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8), +b.slice(0, 2), +b.slice(2, 4), +b.slice(4, 6)) + +m[3] * 100;
      if (t >= t0 && t <= t1) out.set(a + b + m[3], { key, size, t });
    }
  }));
  return out;
}

/** MiRS IMG files starting in [t0, t1]: [{key, size, t}]. Names start with the retrieval version
 *  (v11r10 ...): one tiny listing learns it, then the day folder is listed from the window's hour. */
async function mirsFiles(bucket, t0, t1, signal) {
  const out = [];
  await Promise.all(days(t0, t1).map(async (d) => {
    const day = new Date(d), pfx = `NPR_MIRS_IMG/${dayPath(day)}/`;
    const first = await listKeys(bucket, pfx, 6 * 3600e3, signal, { startAfter: `${pfx}NPR-MIRS-IMG_v`, maxKeys: 1 }).catch(() => []);
    const m = first[0] && /^(.*NPR-MIRS-IMG_v\w+?_(?:n20|n21|npp)_s)\d/.exec(first[0].key);
    if (!m) return;
    const from = new Date(Math.floor(Math.max(d, t0 - 3 * 60e3) / 3600e3) * 3600e3);
    const keys = await listKeys(bucket, pfx, ttlFor(d), signal, { startAfter: `${m[1]}${ymd(day)}${pad(from.getUTCHours())}` }).catch(() => []);
    for (const { key, size } of keys) {
      const k = key.endsWith('.nc') && RE_MIRS.exec(key);
      if (!k) continue;
      const s = k[1], t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
      if (t >= t0 && t <= t1) out.push({ key, size, t });
    }
  }));
  return out;
}

/** VIIRS granules starting in [t0, t1] with their geolocation: [{t, bands: [{key, size} | null], geo: {key, size, kind}, bytes}].
 *  Every band is needed unless `optional`, then only the first (the others are null where missing). */
async function viirsGranules(s, bandIds, t0, t1, signal, optional = false) {
  const gk = VIIRS[bandIds[0]][6];
  const geoList = (k) => sdrGranules(s.bucket, VIIRS_GEO[k][0], VIIRS_GEO[k][1], s.tag, t0, t1, signal);
  const [lists, geoM] = await Promise.all([
    Promise.all(bandIds.map((b) => sdrGranules(s.bucket, VIIRS[b][3], VIIRS[b][4], s.tag, t0, t1, signal))),
    geoList(gk === 'D' ? 'D' : 'M'),
  ]);
  const geo = new Map([...geoM].map(([id, g]) => [id, { ...g, kind: gk === 'D' ? 'D' : 'M' }]));
  // older I-band granules: NODD no longer has the 750 m geolocation, use the 375 m one
  if (gk === 'I' && [...lists[0].keys()].some((id) => !geo.has(id))) {
    for (const [id, g] of await geoList('I')) if (!geo.has(id)) geo.set(id, { ...g, kind: 'I' });
  }
  const out = [];
  for (const [id, g0] of lists[0]) {
    const g = geo.get(id);
    if (!g || (!optional && !lists.every((l) => l.has(id)))) continue;
    const bands = lists.map((l) => l.get(id) || null);
    const share = VIIRS[bandIds[0]][2] === 'dnb' ? SHARE.dnb : SHARE.band;
    out.push({ t: g0.t, bands, geo: g, bytes: bands.reduce((a, b) => a + (b ? b.size * share : 0), 0) + g.size * SHARE[g.kind] });
  }
  return out;
}

/** Slices of a product, newest first: live the latest `limit`, archive every one in [end - hours, end].
 *  Each: {t (slice start), granules: [{t, bands: [{key, size}], geo: {key, size, kind}}], bytes}. */
export async function polarScans(sat, product, minutes, { limit = 12, end = null, hours = null, signal } = {}) {
  const s = SATS[sat], src = polarSource(product), step = minutes * 60e3;
  const live = !end;
  const t1 = (end || new Date()).getTime();
  // NODD posts granules ~20-60 min after they are taken: live listings look back far enough
  const span = live ? Math.min(6, Math.max(2, (limit * minutes) / 60 + 1.5)) : Math.min(24, Math.max(0.1, hours || 1));
  const t0 = t1 - span * 3600e3;
  let grans = [];
  if (src.family === 'atms') {
    grans = (await mirsFiles(s.bucket, t0, t1, signal)).map((f) => ({ t: f.t, bands: [f], geo: null, bytes: f.size }));
  } else {
    grans = await viirsGranules(s, src.bands, t0, t1, signal);
  }
  const by = new Map();
  for (const g of grans) { const k = Math.floor(g.t / step) * step; (by.get(k) || by.set(k, []).get(k)).push(g); }
  let out = [...by].map(([k, gs]) => ({ t: new Date(k), granules: gs.sort((a, b) => a.t - b.t), bytes: gs.reduce((a, g) => a + g.bytes, 0) }));
  if (!live) out = out.filter((x) => x.t.getTime() + step > t0 && x.t.getTime() <= t1);
  out.sort((a, b) => b.t - a.t);
  return live ? out.slice(0, limit) : out;
}

/** Plan of a polar frame: what to read and the output budget (pixels of the slice grid). */
export function polarPlan({ sat, sector, product }, budget) {
  const src = polarSource(product);
  return { sat, sector, product, family: src.family, src, minutes: SLICE_MIN[sector] || 5, framePx: budget.framePx, polar: true,
    rgb: !!src.rgb, bands: src.bands, roles: {}, k: {}, ko: 1, win2: [0, 0, 0, 0], full: true };
}

/** Local equal-area grid holding a slice: centred on its mean nadir point, cells at the native
 *  resolution unless the slice needs more cells than the budget allows. */
function sliceGrid(parts, km, framePx) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const p of parts) for (const [lon, lat] of p.nadir) {
    const a = lon * Math.PI / 180, b = lat * Math.PI / 180;
    x += Math.cos(b) * Math.cos(a); y += Math.cos(b) * Math.sin(a); z += Math.sin(b); n++;
  }
  if (!n) throw new Error('no geolocation in this slice');
  const lon0 = Math.atan2(y, x) * 180 / Math.PI, lat0 = Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI;
  const g = { proj: 'laea', lon0, lat0, ...trackTurn(lon0, lat0, parts.flatMap((p) => p.nadir)) };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const o = [0, 0];
  for (const p of parts) for (const [lon, lat] of p.edge) {
    if (!lonlatToXY(g, lon, lat, o)) continue;
    if (o[0] < x0) x0 = o[0]; if (o[0] > x1) x1 = o[0]; if (o[1] < y0) y0 = o[1]; if (o[1] > y1) y1 = o[1];
  }
  const W = x1 - x0 + 4 * km, Hh = y1 - y0 + 4 * km;
  const res = Math.max(km, Math.sqrt((W * Hh) / framePx));
  const nx = Math.ceil(W / res), ny = Math.ceil(Hh / res);
  return { ...g, x0: x0 - 2 * km + res / 2, dx: res, y0: y1 + 2 * km - res / 2, dy: -res, nx, ny };
}

/** Decode one slice into a frame (band codes, or RGBA for the VIIRS composites). */
export async function loadPolarFrame(p, scan, pool, { pri = 5, signal, key } = {}) {
  const t0 = performance.now();
  const bucket = SATS[p.sat].bucket, src = p.src;
  let r;
  if (src.family === 'atms') {
    r = await pool.run('atmsSlice', { files: scan.granules.map((g) => ({ url: s3url(bucket, g.bands[0].key), size: g.bands[0].size })),
      product: p.product, ch: src.ch, q: src.q, km: src.km, framePx: p.framePx }, { pri, signal });
  } else {
    // 1) geolocation of every granule (in parallel), 2) the grid, 3) each granule's bands resampled
    //    onto its part of the grid (in parallel), 4) the parts merged
    const geos = await Promise.all(scan.granules.map((g) => pool.run('swathGeo', { url: s3url(bucket, g.geo.key), size: g.geo.size,
      group: VIIRS_GEO[g.geo.kind][2] }, { pri, signal })));
    const km = src.km;
    const grid = sliceGrid(geos, km, p.framePx);
    const parts = await Promise.all(scan.granules.map((g, i) => {
      const geo = geos[i];
      return pool.run('swathSplat', { lat: geo.lat, lon: geo.lon, gy: geo.ny, gx: geo.nx, geoKind: g.geo.kind, grid,
        bands: src.bands.map((b, j) => ({ url: s3url(bucket, g.bands[j].key), size: g.bands[j].size, group: VIIRS[b][5], kind: VIIRS[b][2], fine: VIIRS[b][6] === 'I' })),
        q: src.q }, { pri, signal, transfer: [geo.lat.buffer, geo.lon.buffer] });
    }));
    r = await pool.run('swathMerge', { parts, grid, nb: src.bands.length, q: src.q, rgb: src.rgb ? p.product : null }, { pri, signal,
      transfer: parts.flatMap((pt) => [pt.dist.buffer, ...pt.codes.map((c) => c.buffer)]) });
    r.track = [].concat(...geos.map((g) => g.nadir));
    r.bytes = geos.reduce((a, g) => a + g.bytes, 0) + parts.reduce((a, pt) => a + pt.bytes, 0);
  }
  const g = r.grid;
  const frame = { key, sat: p.sat, sector: p.sector, product: p.product, time: scan.t, bytes: r.bytes, plan: p, scan,
    w: g.nx, h: g.ny, grid: g, track: r.track, range: r.range || null, granules: scan.granules.length };
  const ref = { codes: r.codes, w: g.nx, h: g.ny, grid: g, kind: src.q, band: src.rgb ? src.bands[0] : p.product };
  if (src.rgb) Object.assign(frame, { mode: 'rgb', rgba: r.rgba, ref });
  else Object.assign(frame, { mode: 'band', ref });
  frame.resKm = Math.abs(g.dx);
  frame.ms = performance.now() - t0;
  return frame;
}

// ------------------------------------------------------------------ 3D cloud volume
const normLon = (x) => ((x + 180) % 360 + 360) % 360 - 180;

/** Does a granule outline ([lon, lat] ring) touch the box [w, s, e, n] (e may exceed 180)? Its edges
 *  are walked in small steps (any step inside the box), and the box's corners and centre are tested
 *  against the outline (a box inside a granule). */
function ringCrosses(ring, [w, s, e, n]) {
  if (ring.length < 3) return false;
  const lc = (w + e) / 2, pts = ring.map(([lo, la]) => [lc + normLon(lo - lc), la]);
  const inBox = ([x, y]) => x >= w && x <= e && y >= s && y <= n;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    for (let k = 0; k < 24; k++) if (inBox([a[0] + (b[0] - a[0]) * k / 24, a[1] + (b[1] - a[1]) * k / 24])) return true;
  }
  const inRing = ([x, y]) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  return [[w, s], [e, s], [e, n], [w, n], [lc, (s + n) / 2]].some(inRing);
}

/** North-up equal-area grid over a box, cells of `res` km. */
function boxGrid([w, s, e, n], res) {
  const lon0 = normLon((w + e) / 2), lat0 = (s + n) / 2, o = [0, 0];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k <= 16; k++) {
    const lo = w + (e - w) * k / 16, la = s + (n - s) * k / 16;
    for (const [x, y] of [[lo, s], [lo, n], [w, la], [e, la]]) {
      if (!laeaXY(lon0, lat0, normLon(x), y, o)) continue;
      if (o[0] < x0) x0 = o[0]; if (o[0] > x1) x1 = o[0]; if (o[1] < y0) y0 = o[1]; if (o[1] > y1) y1 = o[1];
    }
  }
  const nx = Math.ceil((x1 - x0) / res) + 2, ny = Math.ceil((y1 - y0) / res) + 2;
  return { proj: 'laea', lon0, lat0, rc: 1, rs: 0, x0: x0 - res / 2, dx: res, y0: y1 + res / 2, dy: -res, nx, ny };
}

/** The bands of the 3D cloud retrieval for a polar slice (start t, `minutes` long) inside a box:
 *  VIIRS I5 (10.8 µm) and I1 (0.64 µm) of the granules whose outlines cross the box, resampled by
 *  nearest swath pixel onto an equal-area grid over the box (native 375 m, coarser for large boxes).
 *  Returns {bands: {ir, red?}: {codes, w, h, grid, kind, resKm}, time, granules, bytes}. */
export async function loadPolarBox(sat, t, minutes, bbox, pool, { pri = 0, progress = () => {}, signal } = {}) {
  const s = SATS[sat];
  let [w, so, e, n] = bbox;
  if (e < w) e += 360;
  const t0 = t.getTime();
  const grans = await viirsGranules(s, ['i5', 'i1'], t0, t0 + minutes * 60e3 - 1, signal, true);
  if (!grans.length) throw new Error('No VIIRS imager granules in this slice yet');
  const geoArgs = (g) => ({ url: s3url(s.bucket, g.geo.key), size: g.geo.size, group: VIIRS_GEO[g.geo.kind][2] });
  const rings = await Promise.all(grans.map((g) => pool.run('swathRing', geoArgs(g), { pri, signal }).catch(() => null)));
  const pad = 0.3 + 0.05 * Math.max(e - w, n - so);
  // a granule without an outline is read anyway (the resampling drops it if it misses the box)
  const used = grans.filter((g, i) => !rings[i] || ringCrosses(rings[i], [w - pad, so - pad, e + pad, n + pad]));
  if (!used.length) throw new Error('This slice does not reach the 3D box: each polar slice covers only the strip scanned then');
  const kx = 111.32 * Math.cos(((so + n) / 2) * Math.PI / 180);
  const grid = boxGrid([w, so, e, n], Math.max(0.375, Math.max((e - w) * kx, (n - so) * 110.57) / 480));
  const mb = used.reduce((a, g) => a + g.bytes, 0) / 1e6;
  progress(`Loading VIIRS I5 + I1 · ${used.length} granule${used.length > 1 ? 's' : ''} · ≈${mb.toFixed(0)} MB…`);
  const parts = await Promise.all(used.map(async (g) => {
    const geo = await pool.run('swathGeo', geoArgs(g), { pri, signal });
    const band = (b, j, q, optional) => (g.bands[j] ? { url: s3url(s.bucket, g.bands[j].key), size: g.bands[j].size, group: VIIRS[b][5], kind: VIIRS[b][2],
      fine: true, q, optional } : null);
    const bands = [band('i5', 0, 'bt', false), band('i1', 1, 'refl', true)].filter(Boolean);
    const part = await pool.run('swathSplat', { lat: geo.lat, lon: geo.lon, gy: geo.ny, gx: geo.nx, geoKind: g.geo.kind, grid, bands, q: 'bt' },
      { pri, signal, transfer: [geo.lat.buffer, geo.lon.buffer] });
    // a granule read without I1 (none posted): an empty I1 part keeps the band count
    if (part.codes.length < 2) part.codes.push(new Uint16Array(part.codes[0].length).fill(NAN_CODE));
    part.bytes += geo.bytes;
    return part;
  }));
  let r;
  try {
    r = await pool.run('swathMerge', { parts, grid, nb: 2, q: 'bt', all: true }, { pri, signal,
      transfer: parts.flatMap((pt) => [pt.dist.buffer, ...pt.codes.map((c) => c.buffer)]) });
  } catch (err) {
    if (/No data/.test(err.message)) throw new Error('This slice has no VIIRS data inside the 3D box');
    throw err;
  }
  const resKm = Math.abs(grid.dx), mk = (codes, kind) => ({ codes, w: grid.nx, h: grid.ny, grid, kind, resKm });
  const out = { ir: mk(r.bands[0], 'bt') };
  // I1 only where the sun was up: an all-empty band would read as black (cloud-free) ground
  if (r.bands[1].some((c) => c !== NAN_CODE)) out.red = mk(r.bands[1], 'refl');
  return { bands: out, time: new Date(Math.min(...used.map((g) => g.t))), granules: used.length, bytes: parts.reduce((a, p) => a + p.bytes, 0) };
}
