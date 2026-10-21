/* Polar orbiters (NOAA-20, NOAA-21, Suomi NPP): VIIRS imager and ATMS microwave time slices.
 *
 * A frame is a *slice*: every granule that started inside one time window (2-20 min), i.e. the
 * strip of earth the satellite scanned then. VIIRS SDR granules (~85 s) and their geolocation
 * share a start time in their names (SVI05_j01_d20261021_t0000304_..., GMTCO_j01_d20261021_t0000304_...);
 * ATMS comes from the MiRS IMG files (~32 s). In the decode workers each slice is resampled onto a
 * local equal-area grid by nearest swath pixel (decode/swath.js); from then on it is a frame like
 * any other (tiles, probing, colour tables, smoothing, loops).
 */
import { SATS, VIIRS, VIIRS_GEO, polarSource, SLICE_MIN } from './catalog.js';
import { listKeys, s3url } from './listing.js';
import { lonlatToXY, trackTurn } from './geo.js';

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
    const gk = VIIRS[src.bands[0]][6];
    const geoList = (k) => sdrGranules(s.bucket, VIIRS_GEO[k][0], VIIRS_GEO[k][1], s.tag, t0, t1, signal);
    const [lists, geoM] = await Promise.all([
      Promise.all(src.bands.map((b) => sdrGranules(s.bucket, VIIRS[b][3], VIIRS[b][4], s.tag, t0, t1, signal))),
      geoList(gk === 'D' ? 'D' : 'M'),
    ]);
    let geo = new Map([...geoM].map(([id, g]) => [id, { ...g, kind: gk === 'D' ? 'D' : 'M' }]));
    // older I-band granules: NODD no longer has the 750 m geolocation, use the 375 m one
    if (gk === 'I' && [...lists[0].keys()].some((id) => !geo.has(id))) {
      for (const [id, g] of await geoList('I')) if (!geo.has(id)) geo.set(id, { ...g, kind: 'I' });
    }
    for (const [id, g0] of lists[0]) {
      const g = geo.get(id);
      if (!g || !lists.every((l) => l.has(id))) continue;
      const bands = lists.map((l) => l.get(id));
      const share = VIIRS[src.bands[0]][2] === 'dnb' ? SHARE.dnb : SHARE.band;
      grans.push({ t: g0.t, bands, geo: g, bytes: bands.reduce((a, b) => a + b.size * share, 0) + g.size * SHARE[g.kind] });
    }
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

