/* Frame planning and loading: which files / chunks / segments a frame needs, at which output
 * resolution (fitted to the device budget), and the decode jobs that produce it. */
import { SATS, RGBS, bandsFor, bandRes, buildLut } from './catalog.js';
import { availableScans } from './listing.js';
import { s3url } from './listing.js';
import { subgrid, windowForBBox, resKm } from './geo.js';
import { polarPlan, polarScans, loadPolarFrame } from './polar.js';

// sector sizes in 2 km pixels [rows, cols]
const DIMS2 = {
  goes: { full: [5424, 5424], conus: [1500, 2500], pacus: [1500, 2500], meso1: [500, 500], meso2: [500, 500] },
  ahi: { full: [5500, 5500], japan: [1200, 1500], target: [500, 500] },
  ami: { full: [5500, 5500], la: [500, 500] },
};
// finest output (px per 2 km px) each sector may use: 4 = 0.5 km
const CAP = { full: 1, conus: 2, pacus: 2, meso1: 4, meso2: 4, japan: 2, target: 4, la: 4, custom: 4 };
const KO = [4, 2, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10, 1 / 12, 1 / 16];

export function fdGrid2km(sat) {
  const s = SATS[sat];
  if (s.kind === 'goes') {
    return { lon0: s.local === 'conus' ? -75 : -137, H: 35786023 + 6378137, req: 6378137, rpol: 6356752.31414, sweep: 'x',
      x0: -0.151844, dx: 5.6e-05, y0: 0.151844, dy: -5.6e-05, ny: 5424, nx: 5424 };
  }
  const D = Math.PI / 180, sx = 65536 / (s.kind === 'ami' ? 20425338.90333935 : 20466275);
  return { lon0: s.lon, H: 42164000, req: 6378137, rpol: 6356752.3, sweep: 'y',
    x0: (1 - 2750.5) * sx * D, dx: sx * D, y0: -(1 - 2750.5) * sx * D, dy: -sx * D, ny: 5500, nx: 5500 };
}

/** Data family: 'cmip' (GOES L2 MCMIP, all bands at 2 km in one file), 'l1b' (GOES native), 'ahi' or 'ami'. */
export function familyFor(sat, resolution) {
  const k = SATS[sat].kind;
  return k !== 'goes' ? k : resolution === 'native' ? 'l1b' : 'cmip';
}

/**
 * Plan a frame. budget: {maxTex, framePx}.
 * Returns {roles, bands, family, ko, win2, h, w, k: {band: px per 2 km px}}.
 */
export function plan({ sat, sector, product, resolution, bbox, bandList }, budget) {
  const kind = SATS[sat].kind;
  if (kind === 'polar') {
    if (bandList) throw new Error('The 3D cloud volume works on geostationary frames (GOES, Himawari, GK2A)');
    return polarPlan({ sat, sector, product }, budget);
  }
  const family = familyFor(sat, resolution);
  const roles = bandList ? Object.fromEntries(bandList.map((b) => [`b${b}`, b])) : bandsFor(sat, product);
  const bands = [...new Set(Object.values(roles))].sort((a, b) => a - b);
  const k = {};
  for (const b of bands) k[b] = family === 'cmip' ? 1 : 2 / bandRes(sat, b);
  const kmax = Math.max(...bands.map((b) => k[b]));
  let win2;
  if (sector === 'custom') {
    if (!bbox) throw new Error('Draw a box on the map first');
    win2 = windowForBBox(fdGrid2km(sat), bbox[0], bbox[1], bbox[2], bbox[3], 2);
    if (!win2) throw new Error('The box is not visible from this satellite');
  } else {
    const d = DIMS2[kind][sector];
    win2 = [0, d[0], 0, d[1]];
  }
  const H2 = win2[1] - win2[0], W2 = win2[3] - win2[2];
  const cap = Math.min(CAP[sector] || 1, kmax);
  let ko = KO[KO.length - 1];
  for (const c of KO) {
    if (c > cap) continue;
    if (H2 * c <= budget.maxTex && W2 * c <= budget.maxTex && H2 * W2 * c * c <= budget.framePx) { ko = c; break; }
  }
  if (sector === 'custom' && ko < 1) { // align the window to whole output pixels
    const a = Math.round(1 / ko);
    win2 = [Math.floor(win2[0] / a) * a, win2[1], Math.floor(win2[2] / a) * a, win2[3]];
  }
  const h = Math.ceil((win2[1] - win2[0]) * ko), w = Math.ceil((win2[3] - win2[2]) * ko);
  return { sat, sector, product, family, roles, bands, k, ko, win2, h, w, full: sector !== 'custom', rgb: !bandList && !!RGBS[product] };
}

/** Download estimate (bytes) of one frame from the listing sizes. */
export function estimateBytes(p, scan) {
  const kind = SATS[p.sat].kind;
  if (p.polar) return scan.bytes || 0;
  const rows = p.full ? 1 : (p.win2[1] - p.win2[0]) / DIMS2[kind].full[0];
  if (kind === 'goes') {
    if (p.family === 'cmip') { const f = scan.bands[0]; return f ? f.size * (p.bands.length / 16) * rows * 1.05 : 0; }
    return p.bands.reduce((s, b) => s + (scan.bands[b]?.size || 0), 0) * rows;
  }
  if (kind === 'ami') return p.bands.reduce((s, b) => s + (scan.bands[b]?.size || 0) * amiChunkShare(p, b), 0);
  let s = 0;
  for (const b of p.bands) for (const seg of scan.bands[b] || []) if (segmentNeeded(p, b, seg)) s += seg.size;
  return s;
}

/** Share of a GK2A file's 1375² chunks a window touches (full / local-area sectors: all). */
function amiChunkShare(p, b) {
  if (p.sector !== 'custom') return 1;
  const cs = 1375 / p.k[b], n = Math.ceil(5500 / cs), [r0, r1, c0, c1] = p.win2;
  const span = (a, z) => Math.floor((z - 1) / cs) - Math.floor(a / cs) + 1;
  return (span(r0, r1) * span(c0, c1)) / (n * n);
}

function segmentNeeded(p, b, seg) {
  if (p.sector !== 'full' && p.sector !== 'custom') return true;
  const k = p.k[b], L = (5500 * k) / seg.nseg;
  const s0 = (seg.seg - 1) * L, s1 = seg.seg * L;
  return p.win2[1] * k > s0 && p.win2[0] * k < s1;
}

export async function scansFor(p, opts) {
  if (p.polar) return polarScans(p.sat, p.product, p.minutes, opts);
  return availableScans(p.sat, p.sector === 'custom' ? 'custom' : p.sector, p.family, p.bands, opts);
}

let irLut = null;

/** Decode the bands of a plan for one scan: {bands: {band: {codes, w, h, grid, kind}}, bytes}. */
export async function loadBands(p, scan, pool, { pri = 5, signal } = {}) {
  const { bucket } = SATS[p.sat];
  const kind = SATS[p.sat].kind;
  const bandData = {}; // band -> {codes, w, h, grid, kind}
  let bytes = 0;
  if (kind === 'goes') {
    const files = p.family === 'cmip'
      ? [{ f: scan.bands[0], vars: p.bands.map((b) => ({ v: `CMI_C${String(b).padStart(2, '0')}`, k: 1, b })) }]
      : p.bands.map((b) => ({ f: scan.bands[b], vars: [{ v: 'Rad', k: p.k[b], b }] }));
    await Promise.all(files.map(async ({ f, vars }) => {
      const r = await pool.run('goesFile', { url: s3url(bucket, f.key), size: f.size, vars: vars.map(({ v, k }) => ({ v, k })),
        win: p.full ? null : p.win2, ko: p.ko }, { pri, signal });
      bytes += r.bytes;
      r.bands.forEach((o, i) => { bandData[vars[i].b] = o; });
    }));
  } else if (kind === 'ami') {
    await Promise.all(p.bands.map(async (b) => {
      const f = scan.bands[b];
      const r = await pool.run('amiFile', { url: s3url(bucket, f.key), size: f.size, k: p.k[b], win: p.full ? null : p.win2, ko: p.ko },
        { pri, signal });
      bytes += r.bytes;
      bandData[b] = r;
    }));
  } else {
    await Promise.all(p.bands.map(async (b) => {
      const segs = scan.bands[b].filter((seg) => segmentNeeded(p, b, seg)).sort((x, y) => x.seg - y.seg);
      const k = p.k[b], s = k >= p.ko ? Math.round(k / p.ko) : 1;
      const local = p.sector === 'japan' || p.sector === 'target';
      const rowBase = local ? 0 : Math.round(p.win2[0] * k), rowEnd = local ? undefined : Math.round(p.win2[1] * k);
      const c0 = local ? 0 : Math.round(p.win2[2] * k), c1 = local ? undefined : Math.round(p.win2[3] * k);
      const parts = await Promise.all(segs.map((seg) => pool.run('hsdSeg', { url: s3url(bucket, seg.key), size: seg.size,
        rowBase, rowEnd, c0, c1, s, localRows: local }, { pri, signal })));
      const w = parts[0].w;
      const h = local ? Math.ceil(parts[0].segLines / s) : Math.ceil((rowEnd - rowBase) / s);
      const codes = new Uint16Array(w * h).fill(65535);
      for (const pt of parts) { codes.set(pt.codes.subarray(0, Math.min(pt.n, h - pt.firstOut) * w), pt.firstOut * w); bytes += pt.bytes; }
      const g = parts[0].grid;
      bandData[b] = { codes, w, h, kind: parts[0].kind, band: b, grid: subgrid(g, rowBase, c0, h, w, s), time: parts[0].time };
    }));
  }
  return { bandData, bytes };
}

/** Decode one frame. pool: worker Pool. Returns the frame record. */
export async function loadFrame(p, scan, pool, { pri = 5, signal } = {}) {
  if (p.polar) return loadPolarFrame(p, scan, pool, { pri, signal, key: frameKey(p, scan) });
  const t0 = performance.now();
  const { bandData, bytes } = await loadBands(p, scan, pool, { pri, signal });
  const frame = { key: frameKey(p, scan), sat: p.sat, sector: p.sector, product: p.product, time: scan.t, bytes, plan: p, scan };
  if (!p.rgb) {
    const d = bandData[p.bands[0]];
    Object.assign(frame, { mode: 'band', w: d.w, h: d.h, grid: d.grid, ref: d });
  } else {
    const recipe = RGBS[p.product];
    const finest = p.bands.reduce((a, b) => (p.k[b] > p.k[a] ? b : a));
    const og = bandData[finest].grid;
    const w = Math.ceil((p.win2[3] - p.win2[2]) * p.ko), h = Math.ceil((p.win2[1] - p.win2[0]) * p.ko);
    const bands = {}, transfer = [];
    for (const [role, b] of Object.entries(p.roles)) {
      const d = bandData[b];
      // a band used by two roles is sent once per role (copy for the second)
      const codes = transfer.includes(d.codes.buffer) ? d.codes.slice() : d.codes;
      transfer.push(codes.buffer);
      bands[role] = { codes, w: d.w, h: d.h, f: p.k[b] >= p.ko ? 1 : p.ko / p.k[b], kind: d.kind };
    }
    irLut ||= buildLut('ir_sandwich', 163, 330); // Sandwich's own cold-top enhancement
    const time = new Date(scan.t.getTime() + (p.sector === 'full' ? 5 : 1) * 60e3); // mid-scan sun
    const r = await pool.run('composite', { recipe: p.product, bands, out: { w, h, grid: { ...og, ny: h, nx: w }, time }, irLut },
      { pri, signal, transfer });
    const refRole = recipe.ref in p.roles ? recipe.ref : Object.keys(p.roles)[0];
    const ref = r.bands[refRole];
    const rb = p.roles[refRole];
    Object.assign(frame, { mode: 'rgb', w, h, grid: { ...og, ny: h, nx: w }, rgba: r.rgba,
      ref: { codes: ref.codes, w: ref.w, h: ref.h, kind: ref.kind, band: rb, grid: bandData[rb].grid } });
  }
  frame.resKm = resKm(frame.grid);
  frame.ms = performance.now() - t0;
  return frame;
}

export function frameKey(p, scan) {
  // a polar slice still gaining granules is a new frame once it has more
  return [p.sat, p.sector, p.product, p.family, p.ko, p.win2.join('_'), scan.t.getTime(), scan.granules ? scan.granules.length : ''].join('|');
}
