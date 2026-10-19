/* Decode worker: downloads only the bytes it needs, decodes them and returns compact 16-bit
 * storage codes (or RGBA for composites) as transferable buffers.
 *
 *   goesFile  ABI bands from an L1b Rad or L2 MCMIP NetCDF-4 file (HDF5 chunks, deflate + shuffle)
 *   hsdSeg    one Himawari HSD segment (.DAT.bz2)
 *   composite  an RGB recipe from band codes
 *   retrieve3d cloud fields for the 3D volume view
 */
import { H5File, setInflate, decodeChunk } from './hdf5.js';
import { inflateZlib } from './inflate.js';
import { RangeSource, fetchBytes, setMaxInflight, stats } from './range.js';
import { bunzip2 } from './bzip2.js';
import { parseHSD, hsdCalibrator, hsdGrid } from './hsd.js';
import { composite } from './composites.js';
import { buildFields } from './retrieve3d.js';
import { Q16, NAN_CODE, kindForBand } from '../catalog.js';
import { subgrid } from '../geo.js';

setInflate(inflateZlib);
setMaxInflight(4);

const jobs = new Map(); // id -> AbortController

function encoder(kind) {
  const [lo, hi] = Q16[kind], k = 65534 / (hi - lo);
  return (v) => {
    if (!(v === v)) return NAN_CODE;
    const c = (v - lo) * k + 0.5;
    return c < 0 ? 0 : c > 65534 ? 65534 : c | 0;
  };
}

const first = (a) => (Array.isArray(a) ? a[0] : a);

// ------------------------------------------------------------------ GOES ABI
/** One or more bands of one ABI file. vars: [{v: 'Rad' | 'CMI_Cnn', k: band px per 2 km px}].
 *  win: [R0, R1, C0, C1] in 2 km pixels (null = whole grid); ko: output px per 2 km px. */
async function goesFile({ url, size, vars, win, ko }, signal) {
  const b0 = stats.bytes;
  const src = new RangeSource(url, size, { head: size < 1500000 ? size : 256 * 1024, signal });
  const f = await H5File.open(src);
  const [xd, yd, pd] = await Promise.all([f.dataset('x'), f.dataset('y'), f.dataset('goes_imager_projection')]);
  const [xv, yv] = await Promise.all([f.readAll(xd), f.readAll(yd)]);
  const pa = pd.attrs, A = (m, n) => +first(m.get(n));
  const xs = A(xd.attrs, 'scale_factor'), xo = A(xd.attrs, 'add_offset'), ys = A(yd.attrs, 'scale_factor'), yo = A(yd.attrs, 'add_offset');
  const grid = { lon0: A(pa, 'longitude_of_projection_origin'), H: A(pa, 'perspective_point_height') + A(pa, 'semi_major_axis'),
    req: A(pa, 'semi_major_axis'), rpol: A(pa, 'semi_minor_axis'), sweep: pa.get('sweep_angle_axis') || 'x',
    x0: first(xv) * xs + xo, dx: xs, y0: first(yv) * ys + yo, dy: ys, ny: yd.shape[0], nx: xd.shape[0] };
  const out = await Promise.all(vars.map(({ v, k }) => readVar(f, src, grid, v, k, win, ko)));
  const bytes = stats.bytes - b0;
  return { result: { bands: out, bytes }, transfer: out.map((o) => o.codes.buffer) };
}

async function readVar(f, src, grid, v, k, win, ko) {
  const ds = await f.dataset(v);
  // calibration: stored integer -> storage code, through a 64k lookup table
  const at = ds.attrs;
  const unsigned = String(at.get('_Unsigned') || '') === 'true';
  let fill = +first(at.get('_FillValue')); if (unsigned) fill &= 0xffff;
  const scale = +first(at.get('scale_factor')), offset = +first(at.get('add_offset'));
  let band, phys;
  if (v === 'Rad') {
    band = +first(await f.readAll(await f.dataset('band_id')));
    if (band <= 6) {
      const kappa = +(await f.readAll(await f.dataset('kappa0')));
      phys = (r) => r * kappa;
    } else {
      const [fk1, fk2, bc1, bc2] = await Promise.all(['planck_fk1', 'planck_fk2', 'planck_bc1', 'planck_bc2'].map(async (n) => +(await f.readAll(await f.dataset(n)))));
      phys = (r) => (r > 0 ? (fk2 / Math.log(fk1 / r + 1) - bc1) / bc2 : NaN);
    }
  } else { band = parseInt(v.slice(-2), 10); phys = (r) => r; }
  const kind = kindForBand(band), enc = encoder(kind);
  const lut = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const raw = unsigned ? i : (i << 16) >> 16; // as stored (int16 view)
    lut[i] = raw === fill || i === fill ? NAN_CODE : enc(phys(raw * scale + offset));
  }
  // the band grid: the file's x / y describe the 2 km grid of MCMIP and each band's own grid of L1b
  const g = { ...grid, ny: ds.shape[0], nx: ds.shape[1] };

  // window in this band's pixels (win is in 2 km pixels)
  const [R0, R1, C0, C1] = win || [0, g.ny / k, 0, g.nx / k];
  const r0 = Math.round(R0 * k), r1 = Math.min(g.ny, Math.round(R1 * k)), c0 = Math.round(C0 * k), c1 = Math.min(g.nx, Math.round(C1 * k));
  const s = k >= ko ? Math.round(k / ko) : 1;
  const h = Math.ceil((r1 - r0) / s), w = Math.ceil((c1 - c0) / s);
  const codes = new Uint16Array(w * h).fill(NAN_CODE);
  const [cr, cc] = ds.layout.chunk;
  let chunks = await f.chunkList(ds, [r0, r1, c0, c1]);
  // drop chunks holding none of the kept rows (row-strip chunking + large strides)
  chunks = chunks.filter((ch) => {
    const a = Math.max(ch.off[0], r0), b = Math.min(ch.off[0] + cr, r1);
    return r0 + Math.ceil((a - r0) / s) * s < b;
  });
  await src.streamRanges(chunks.map((ch) => [ch.addr, ch.size, ch]), async (rg, bytes) => {
    const ch = rg[2];
    const u = await decodeChunk(bytes, ds.filters, ch.mask, 2);
    const raw = new Uint16Array(u.buffer, u.byteOffset, u.byteLength >> 1);
    const ra = Math.max(ch.off[0], r0), rb = Math.min(ch.off[0] + cr, r1);
    const ca = Math.max(ch.off[1], c0), cb = Math.min(ch.off[1] + cc, c1);
    let gr = r0 + Math.ceil((ra - r0) / s) * s;
    const gc0 = c0 + Math.ceil((ca - c0) / s) * s;
    for (; gr < rb; gr += s) {
      const orow = ((gr - r0) / s) * w, irow = (gr - ch.off[0]) * cc - ch.off[1];
      for (let gc = gc0; gc < cb; gc += s) codes[orow + (gc - c0) / s] = lut[raw[irow + gc]];
    }
  });
  return { codes, w, h, kind, band, grid: subgrid(g, r0, c0, h, w, s) };
}

// ------------------------------------------------------------------ Himawari HSD
async function hsdSeg({ url, size, rowBase, rowEnd, c0, c1, s, localRows }, signal) {
  const comp = await fetchBytes(url, 0, size, signal);
  const raw = bunzip2(comp, size * 4);
  const h = parseHSD(raw);
  const g0 = localRows ? 0 : h.firstLine - 1;      // global row of local row 0
  const cal = hsdCalibrator(h.cal), kind = kindForBand(h.cal.band), enc = encoder(kind);
  const maxc = 1 << Math.min(16, h.cal.vbits + 1);
  const lut = new Uint16Array(65536).fill(NAN_CODE);
  for (let i = 0; i < Math.min(65536, maxc); i++) lut[i] = enc(cal(i));
  const ca = c0 ?? 0, cb = Math.min(c1 ?? h.ncols, h.ncols);
  const lo = Math.max(rowBase ?? 0, g0), hi = Math.min(rowEnd ?? g0 + h.nlines, g0 + h.nlines);
  const base = rowBase ?? 0;
  let gFirst = base + Math.ceil((lo - base) / s) * s;
  const n = gFirst < hi ? Math.ceil((hi - gFirst) / s) : 0;
  const w = Math.ceil((cb - ca) / s);
  const codes = new Uint16Array(Math.max(0, n * w));
  const cnt = h.counts;
  for (let i = 0; i < n; i++) {
    const lr = gFirst + i * s - g0, src = lr * h.ncols, dst = i * w;
    for (let j = 0, c = ca; j < w; j++, c += s) codes[dst + j] = lut[cnt[src + c]];
  }
  const grid = hsdGrid(h, localRows);
  return {
    result: { codes, w, n, firstOut: n ? (gFirst - base) / s : 0, kind, band: h.cal.band, grid, time: h.time.toISOString(),
      nseg: h.nseg, segLines: h.nlines, bytes: size },
    transfer: [codes.buffer],
  };
}

// ------------------------------------------------------------------ composites
function runComposite({ recipe, bands, out, irLut }) {
  const rgba = composite(recipe, bands, out, irLut);
  const transfer = [rgba.buffer];
  for (const b of Object.values(bands)) transfer.push(b.codes.buffer);
  return { result: { rgba, bands }, transfer };
}

async function retrieve3d(args) {
  const out = await buildFields(args);
  const r = out.result;
  return { result: r, transfer: [r.field1.buffer, r.field2.buffer, r.field3.buffer, r.elev.buffer] };
}

const TASKS = { goesFile, hsdSeg, composite: runComposite, retrieve3d };

export { TASKS };
if (typeof self !== 'undefined') self.onmessage = async (e) => {
  const { id, type, args } = e.data;
  if (type === 'cancel') { jobs.get(id)?.abort(); return; }
  const ac = new AbortController();
  jobs.set(id, ac);
  try {
    const { result, transfer } = await TASKS[type](args, ac.signal);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: ac.signal.aborted ? 'aborted' : String(err && err.message || err) });
  } finally { jobs.delete(id); }
};
