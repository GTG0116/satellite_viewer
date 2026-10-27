/* Ensemble model tracks of tropical cyclones: every member of six ensembles, their mean and
 * median, drawn on a MapLibre or Mapbox GL map (the same file serves both editions, like
 * overlays.js).
 *
 *   ECMWF ENS  51 members (50 + control), 00/12Z to 360 h, 06/18Z to 144 h: ECMWF open data,
 *              one BUFR file per run (template 3 16 082, one message per storm, one subset per
 *              member), from data.ecmwf.int or its AWS mirror (both CORS).
 *   AIFS ENS   ECMWF's machine-learned ensemble, 50 members + 2 unperturbed runs, every 6 h to
 *              360 h: the same BUFR (a model-name element first), same hosts.
 *   GEFS       31 members (AC00 + AP01-30), 00/06/12/18Z to 384 h  } NCEP's ensemble tracker on
 *   GEPS       21 members (CC00 + CP01-20), 00/12Z to 384 h        } NOMADS (2 days kept), ATCF
 *   FNV3       Google DeepMind FNV3, 50 members, to ~330 h         } Google DeepMind Weather Lab,
 *   WNV3       Google DeepMind WNV3, 60 members, to 360 h          } ATCF a-decks
 * NOMADS and Weather Lab send no CORS headers: those go through a small proxy (the desktop
 * back end, the Cloudflare Worker or tools/serve.py; `proxy` below). Means and medians are
 * computed here from the members, at each forecast hour that at least 40 % of the members
 * carrying the storm still reach.
 */
import { CATS, category } from './overlays.js';
import { TrackChart } from './tchart.js';

const ECMWF = 'https://ecmwf-forecasts.s3.amazonaws.com';
const ECMWF_ORG = 'https://data.ecmwf.int/forecasts';
const NOMADS = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod';
const WLAB = 'https://deepmind.google.com/science/weatherlab/download/cyclones';
const WLAB_TERMS = 'https://storage.googleapis.com/weathernext-public/terms-of-use.pdf';
const H = 3600e3;

export const MODELS = [
  { id: 'ecmwf', name: 'ECMWF ENS', short: 'ECMWF', color: '#ff6f61', cycles: [0, 6, 12, 18], proxy: false },
  { id: 'aifs', name: 'ECMWF AIFS ENS', short: 'AIFS', color: '#f783ac', cycles: [0, 6, 12, 18], proxy: false },
  { id: 'gefs', name: 'GEFS', short: 'GEFS', color: '#4dabf7', cycles: [0, 6, 12, 18], proxy: true },
  { id: 'geps', name: 'GEPS', short: 'GEPS', color: '#c297ff', cycles: [0, 12], proxy: true },
  { id: 'fnv3', name: 'FNV3', short: 'FNV3', color: '#69db7c', cycles: [0, 6, 12, 18], proxy: true },
  { id: 'wnv3', name: 'WNV3', short: 'WNV3', color: '#ffd43b', cycles: [0, 6, 12, 18], proxy: true },
];
const MODEL = Object.fromEntries(MODELS.map((m) => [m.id, m]));

// central pressure classes (hPa, lower bound), weakest first
export const PBINS = [
  { min: 1005, label: '≥1005', color: '#8fa3bf' },
  { min: 1000, label: '1000', color: '#73c2ff' },
  { min: 990, label: '990', color: '#38e0c8' },
  { min: 980, label: '980', color: '#a9e34b' },
  { min: 970, label: '970', color: '#ffe680' },
  { min: 960, label: '960', color: '#ffc44d' },
  { min: 950, label: '950', color: '#ff9638' },
  { min: 940, label: '940', color: '#ff5a3a' },
  { min: 925, label: '925', color: '#f04cff' },
  { min: -Infinity, label: '<925', color: '#ffffff' },
];
const NODATA = '#7d889a';
const windColor = (kt) => (kt == null ? NODATA : category(kt).color);
const presColor = (mb) => (mb == null ? NODATA : PBINS.find((b) => mb >= b.min).color);

export const MAX_HOUR = 384;
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`; };
const hh = (t) => p2(new Date(t).getUTCHours());
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtRun = (t) => { const d = new Date(t); return `${p2(d.getUTCDate())} ${MONS[d.getUTCMonth()]} ${hh(t)}Z`; };
const fmtValid = (t) => { const d = new Date(t); return `${DAYS[d.getUTCDay()]} ${p2(d.getUTCDate())} ${MONS[d.getUTCMonth()]} ${hh(t)}Z`; };
const near = (lon, ref) => { while (lon - ref > 180) lon -= 360; while (lon - ref < -180) lon += 360; return lon; };

class NotFound extends Error {}

// ------------------------------------------------------------------ fetching
function via(url, proxy) { return proxy ? proxy + encodeURIComponent(url) : url; }
/** GET a file; 403 / 404 throw NotFound. Network errors and 5xx (S3's "503 Slow Down" comes
 *  without CORS headers, so it is a network error here) are retried twice. */
async function get(url, { proxy, signal, binary = false }) {
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(via(url, proxy), { signal, cache: 'no-cache' });
      if (r.status === 404 || r.status === 403) throw new NotFound(url);
      if (r.ok) return binary ? new Uint8Array(await r.arrayBuffer()) : await r.text();
    } catch (e) {
      if (e instanceof NotFound || signal?.aborted || i >= 2) throw e;
    }
    if (r && r.status < 500) throw new Error(`HTTP ${r.status}`);
    if (i >= 2) throw new Error(`HTTP ${r.status}`);
    await new Promise((ok) => setTimeout(ok, 1500 * 2 ** i));
  }
}

/** Run a list of async jobs, at most n at a time. */
async function limited(jobs, n) {
  const out = new Array(jobs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (i < jobs.length) { const k = i++; out[k] = await jobs[k](); }
  }));
  return out;
}

// ------------------------------------------------------------------ storms
// basin of an ATCF code (NHC / JTWC / tracker) or of an ECMWF storm letter
const ATCF_BASIN = { AL: 'AL', EP: 'EP', CP: 'CP', WP: 'WP', IO: 'IO', BB: 'IO', AA: 'IO', NI: 'IO', SH: 'SH', SP: 'SH', SI: 'SH', SA: 'SL', SL: 'SL', LS: 'SL' };
const EC_BASIN = { L: 'AL', E: 'EP', C: 'CP', W: 'WP', A: 'IO', B: 'IO', S: 'SH', P: 'SH', U: 'SH', Q: 'SL' };

/** A model run: {t, storms: Map(key -> {key, basin, num, name, genesis, members: Map(id -> [{tau, lat, lon, kt, mb}])})}. */
function stormOf(storms, key, init) {
  let s = storms.get(key);
  if (!s) storms.set(key, (s = { key, members: new Map(), ...init }));
  return s;
}

const deg = (s) => { const m = /^(\d+)([NSEW])$/.exec(s); if (!m) return NaN; const v = +m[1] / 10; return m[2] === 'S' || m[2] === 'W' ? -v : v; };

/** ATCF a-deck lines "EP, 22, 2026102700, 03, AP01, 006, 158N, 1067W, 37, 1004, XX, 34, ..."
 *  (one line per wind-radius threshold: the first one of a member and hour is kept). */
function parseAtcf(txt, storms, memberOf = (tech) => tech) {
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const f = line.split(',').map((x) => x.trim());
    if (f.length < 8) continue;
    const mem = memberOf(f[4]);
    if (!mem) continue;
    const lat = deg(f[6]), lon = deg(f[7]), tau = +f[5];
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(tau)) continue;
    const basin = ATCF_BASIN[f[0]] || f[0], num = +f[1];
    const s = stormOf(storms, `${basin}${p2(num)}`, { basin, num, name: null, genesis: false });
    let pts = s.members.get(mem);
    if (!pts) s.members.set(mem, (pts = []));
    if (pts.length && pts[pts.length - 1].tau === tau) continue;
    pts.push({ tau, lat, lon, kt: +f[8] > 0 ? +f[8] : null, mb: +f[9] > 800 ? +f[9] : null });
  }
  return storms;
}

// ------------------------------------------------------------------ ECMWF BUFR
// The expanded template 3 16 082 (widths, scales, references; s = CCITT IA5 text): the header,
// then a delayed replication (0 31 001) of the 49-element block of each forecast step. The wind
// radii are 15 bits wide (an operator in the message widens Table B's 12).
const E = (w, s = 0, r = 0) => ({ w, s, r });
const T = (w) => ({ w, t: true });
const RADII = () => Array.from({ length: 3 }, () => [E(8), ...Array.from({ length: 4 }, () => [E(16, 2), E(16, 2), E(15, -2)]).flat()]).flat();
const LAT = E(15, 2, -9000), LON = E(16, 2, -18000), SIG = E(4);
const EC_HEAD = [E(8), E(8), E(8), T(24), T(80), E(8), E(10), E(8), E(12), E(4), E(6), E(5), E(6),
  SIG, LAT, LON, SIG, LAT, LON, E(14, -1), SIG, LAT, LON, E(12, 1), ...RADII()];
const EC_STEP = [E(5), E(12, 0, -2048), SIG, LAT, LON, E(14, -1), SIG, LAT, LON, E(12, 1), ...RADII()];

class Bits {
  constructor(u8, byte) { this.u8 = u8; this.p = byte * 8; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++, this.p++) v = v * 2 + ((this.u8[this.p >> 3] >> (7 - (this.p & 7))) & 1);
    return v;
  }
}

/** One element of compressed data for every subset: reference value R0, the increment width,
 *  then the increments (all ones: missing). Text: R0 as bytes, the width in bytes. */
function element(b, d, n) {
  const out = new Array(n);
  if (d.t) {
    const nb = d.w / 8, chars = () => { let s = ''; for (let i = 0; i < nb; i++) s += String.fromCharCode(b.read(8)); return s; };
    const r0 = chars(), w = b.read(6);
    for (let j = 0; j < n; j++) {
      if (!w) { out[j] = r0; continue; }
      let s = '';
      for (let i = 0; i < w; i++) s += String.fromCharCode(b.read(8));
      out[j] = s;
    }
    return out.map((s) => s.replace(/[\0\xff]/g, '').trim());
  }
  const r0 = b.read(d.w), w = b.read(6), k = 10 ** -d.s;
  const allOnes = (bits) => 2 ** bits - 1;
  for (let j = 0; j < n; j++) {
    if (!w) { out[j] = r0 === allOnes(d.w) ? null : (d.r + r0) * k; continue; }
    const inc = b.read(w);
    out[j] = inc === allOnes(w) ? null : (d.r + r0 + inc) * k;
  }
  return out;
}

/** Every storm of an ECMWF ensemble track file into `storms`. */
function parseEcmwf(u8, storms) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u24 = (o) => (u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2];
  let i = 0;
  while (i + 8 < u8.length) {
    if (!(u8[i] === 0x42 && u8[i + 1] === 0x55 && u8[i + 2] === 0x46 && u8[i + 3] === 0x52)) { i++; continue; } // "BUFR"
    const len = u24(i + 4), ed = u8[i + 7];
    const next = i + len;
    try {
      if (ed !== 4) continue;
      let o = i + 8;
      const s1 = u24(o), hasS2 = u8[o + 9] & 0x80;
      o += s1;
      if (hasS2) o += u24(o);
      const s3 = u24(o), nsub = dv.getUint16(o + 4), flags = u8[o + 6];
      // compressed 3 16 082 only, after AIFS's 0 01 030 (numerical model identifier, 16 chars)
      const nd = (s3 - 7) >> 1, descs = Array.from({ length: nd }, (_, k) => dv.getUint16(o + 7 + 2 * k));
      const named = descs[0] === 30 + (1 << 8);
      if (!(flags & 0x40) || descs[named ? 1 : 0] !== ((3 << 14) | (16 << 8) | 82)) continue;
      o += s3;
      const b = new Bits(u8, o + 4);
      if (named) element(b, T(128), nsub);
      const head = EC_HEAD.map((d) => element(b, d, nsub));
      const reps = element(b, E(8), nsub)[0] || 0;
      const steps = [];
      for (let k = 0; k < reps; k++) steps.push(EC_STEP.map((d) => element(b, d, nsub)));
      const id = head[3][0] || '', m = /^(\d+)([A-Z])$/.exec(id);
      if (!m) continue;
      const basin = EC_BASIN[m[2]] || m[2], num = +m[1];
      const name = head[4][0] && head[4][0] !== id ? head[4][0] : null;
      const s = stormOf(storms, `ec:${id}`, { basin, num, name, genesis: num >= 70, ecId: id });
      for (let j = 0; j < nsub; j++) {
        const pts = [];
        const add = (tau, lat, lon, pa, ms) => {
          if (lat == null || lon == null) return;
          pts.push({ tau, lat, lon, kt: ms == null ? null : Math.round(ms * 1.94384), mb: pa == null ? null : Math.round(pa / 100) });
        };
        add(0, head[17][j], head[18][j], head[19][j], head[23][j]);
        for (const st of steps) if (st[1][j] != null) add(st[1][j], st[3][j], st[4][j], st[5][j], st[9][j]);
        // control: ensemble forecast type 0 (AIFS also has a type 1, its second unperturbed run)
        const mem = head[6][j], id = head[7][j] === 0 ? 'control' : head[7][j] === 1 ? `control ${mem}` : `member ${mem}`;
        if (pts.length) s.members.set(id, pts);
      }
    } catch (e) { console.warn('ECMWF track message', e); }
    finally { i = next > i ? next : i + 4; }
  }
  return storms;
}

// ------------------------------------------------------------------ sources
const SOURCES = {
  // the AWS mirror's listing says whether the run exists (data.ecmwf.int sends no CORS headers on
  // a 404); the file comes from data.ecmwf.int while it keeps it (a few days), else the mirror
  ecmwf: (t, o) => ecmwf('ifs', hh(t) === '00' || hh(t) === '12' ? 360 : 144, t, o),
  aifs: (t, o) => ecmwf('aifs-ens', 360, t, o),
  gefs: (t, o) => nomads('gefs', 'aemn', ['ac00', ...Array.from({ length: 30 }, (_, i) => `ap${p2(i + 1)}`)], t, o),
  geps: (t, o) => nomads('cmce', 'cemn', ['cc00', ...Array.from({ length: 20 }, (_, i) => `cp${p2(i + 1)}`)], t, o),
  fnv3: (t, o) => wlab('FNV3', t, o),
  wnv3: (t, o) => wlab('WNV3', t, o),
};

async function ecmwf(model, step, t, o) {
  const d = ymd(t), h = hh(t);
  const key = `${d}/${h}z/${model}/0p25/enfo/${d}${h}0000-${step}h-enfo-tf.bufr`, oo = { ...o, proxy: null };
  const list = await get(`${ECMWF}/?list-type=2&max-keys=1&prefix=${encodeURIComponent(key)}`, oo);
  if (!list.includes('<Key>')) throw new NotFound(key);
  let u8 = null;
  if (Date.now() - t < 3 * 24 * H) u8 = await get(`${ECMWF_ORG}/${key}`, { ...oo, binary: true }).catch((e) => { if (o.signal?.aborted) throw e; return null; });
  return parseEcmwf(u8 || await get(`${ECMWF}/${key}`, { ...oo, binary: true }), new Map());
}

/** NCEP ensemble tracker: one ATCF file per member; the mean's file is written last, so its
 *  presence says the run is complete. */
async function nomads(dir, mean, members, t, o) {
  const base = `${NOMADS}/${dir}.${ymd(t)}/${hh(t)}/tctrack`, file = (m) => `${base}/${m}.t${hh(t)}z.cyclone.trackatcfunix`;
  await get(file(mean), o);
  const storms = new Map();
  const txts = await limited(members.map((m) => () => get(file(m), o).catch((e) => { if (e instanceof NotFound) return ''; throw e; })), 6);
  for (const txt of txts) parseAtcf(txt, storms, (tech) => (/^[A-Z]{2}\d\d$/.test(tech) ? tech : null));
  return storms;
}

async function wlab(model, t, o) {
  const d = new Date(t), stamp = `${d.getUTCFullYear()}_${p2(d.getUTCMonth() + 1)}_${p2(d.getUTCDate())}T${hh(t)}_00`;
  const txt = await get(`${WLAB}/${model}/ensemble/paired/atcf/${model}_${stamp}_atcf_a_deck.txt`, o);
  return parseAtcf(txt, new Map(), (tech) => (/^[A-Z]\d{3}$/.test(tech) ? `member ${+tech.slice(1) + 1}` : null));
}

/** Synoptic times of a model's runs, newest first, back `days` days from `now`. */
export function cycles(model, days = 3, now = Date.now()) {
  const out = [];
  for (let t = Math.floor(now / (6 * H)) * 6 * H; t > now - days * 24 * H; t -= 6 * H) {
    if (!model || MODEL[model].cycles.includes(new Date(t).getUTCHours())) out.push(t);
  }
  return out;
}

// ------------------------------------------------------------------ ensemble statistics
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** Mean and median tracks of a storm's members: at each hour that at least 40 % of the members
 *  (two at least) reach, until the first hour that falls short. */
function stats(members) {
  const tracks = [...members.values()];
  const need = Math.max(2, Math.ceil(tracks.length * 0.4));
  const byTau = new Map();
  const ref = tracks[0]?.[0]?.lon || 0;
  for (const pts of tracks) for (const p of pts) (byTau.get(p.tau) || byTau.set(p.tau, []).get(p.tau)).push(p);
  const taus = [...byTau.keys()].sort((a, b) => a - b);
  const avg = [], med = [];
  for (const tau of taus) {
    const ps = byTau.get(tau);
    if (ps.length < need) break;
    const lon = ps.map((p) => near(p.lon, ref)), lat = ps.map((p) => p.lat);
    const kt = ps.map((p) => p.kt).filter((v) => v != null), mb = ps.map((p) => p.mb).filter((v) => v != null);
    avg.push({ tau, lat: mean(lat), lon: mean(lon), kt: kt.length ? Math.round(mean(kt)) : null, mb: mb.length ? Math.round(mean(mb)) : null, n: ps.length });
    med.push({ tau, lat: median(lat), lon: median(lon), kt: kt.length ? Math.round(median(kt)) : null, mb: mb.length ? Math.round(median(mb)) : null, n: ps.length });
  }
  return { avg, med };
}

/** Points up to hour h, the last one interpolated to h when the track runs past it. */
function cut(pts, h) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.tau <= h) { out.push(p); continue; }
    const a = pts[i - 1];
    if (a && a.tau < h) {
      const f = (h - a.tau) / (p.tau - a.tau), mix = (x, y) => (x == null || y == null ? (f < 0.5 ? x : y) : x + (y - x) * f);
      out.push({ tau: h, lat: mix(a.lat, p.lat), lon: a.lon + (near(p.lon, a.lon) - a.lon) * f, kt: mix(a.kt, p.kt), mb: mix(a.mb, p.mb), n: p.n });
    }
    break;
  }
  return out;
}

// ------------------------------------------------------------------ storms across models
const dist = (a, b) => { // great-circle km
  const r = Math.PI / 180, dl = (b[1] - a[1]) * r, dn = (b[0] - a[0]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dn / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Position on a track of run time t0 at time t (interpolated), or null outside it. */
function trackAt(pts, t0, t) {
  const tau = (t - t0) / H;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.tau === tau) return [p.lon, p.lat];
    if (p.tau > tau) {
      const a = pts[i - 1];
      if (!a) return null;
      const f = (tau - a.tau) / (p.tau - a.tau);
      return [a.lon + (near(p.lon, a.lon) - a.lon) * f, a.lat + (p.lat - a.lat) * f];
    }
  }
  return null;
}

/** One group per real storm: the same ATCF id, or (ECMWF numbers its own, and runs differ in
 *  time) mean tracks within 500 km of each other when both exist.
 *  names: [{name, now: [lon, lat], t}] of the agencies' current storms, for the labels. */
function groupStorms(runs, names = []) {
  const groups = [], entries = [];
  for (const [model, run] of runs) {
    for (const s of run.storms.values()) {
      s.stats = s.stats || stats(s.members);
      const tr = s.stats.avg.length ? s.stats.avg : [...s.members.values()][0];
      if (tr?.length) entries.push({ model, s, tr, t0: run.t, start: run.t + tr[0].tau * H });
    }
  }
  entries.sort((a, b) => (a.s.ecId ? 1 : 0) - (b.s.ecId ? 1 : 0));
  const close = (g, e) => {
    const t = Math.max(g.start, e.start);
    const a = trackAt(g.tr, g.t0, t), b = trackAt(e.tr, e.t0, t);
    return a && b && dist(a, b) < 500;
  };
  for (const e of entries) {
    let g = !e.s.ecId && groups.find((x) => x.key === e.s.key);
    if (!g) g = groups.find((x) => !x.models.has(e.model) && close(x, e));
    if (!g) groups.push((g = { key: null, ecId: e.s.ecId, tr: e.tr, t0: e.t0, start: e.start, name: null, genesis: e.s.genesis, models: new Map() }));
    if (!g.key && !e.s.ecId) g.key = e.s.key;
    if (!e.s.genesis) g.genesis = false;
    if (e.s.name && !/^\d/.test(e.s.name)) g.name = g.name || e.s.name;
    g.models.set(e.model, e.s);
  }
  for (const g of groups) {
    g.pos = [g.tr[0].lon, g.tr[0].lat];
    const agency = names.find((n) => {
      if (!n.now) return false;
      const p = trackAt(g.tr, g.t0, Math.max(g.start, n.t || g.start)) || g.pos;
      return dist(n.now, p) < 400;
    });
    const id = g.key || g.ecId;
    g.id = g.key || `ec:${g.ecId}`;
    g.label = agency ? agency.name : g.name ? `${title(g.name)} (${id})` : g.genesis ? `New system ${id} (ECMWF)` : id;
  }
  return groups.sort((a, b) => (a.genesis - b.genesis) || a.label.localeCompare(b.label));
}
const title = (s) => s.toLowerCase().replace(/(^|[\s-])[a-z]/g, (c) => c.toUpperCase());

// ------------------------------------------------------------------ GeoJSON
/** Lines (split where the colour changes), points, end-of-window markers and labels.
 *  o: {models: Set, members, mean, median, line, pts, hour, storm, genesis}. */
function buildFC(runs, groups, o) {
  const feats = [];
  const F = (props, geometry) => feats.push({ type: 'Feature', properties: props, geometry });
  const colorBy = (mode, m, p) => (mode === 'wind' ? windColor(p.kt) : mode === 'pressure' ? presColor(p.mb) : MODEL[m].color);
  for (const g of groups) {
    if (o.storm !== 'all' && g.id !== o.storm) continue;
    if (g.genesis && !o.genesis) continue;
    const ref = g.pos[0];
    for (const [m, s] of g.models) {
      if (!o.models.has(m)) continue;
      const run = runs.get(m), t0 = run.t;
      const tracks = [];
      if (o.members) for (const [mem, pts] of s.members) tracks.push({ r: 'm', mem, pts });
      if (o.mean || o.median) {
        s.stats = s.stats || stats(s.members);
        if (o.mean && s.stats.avg.length) tracks.push({ r: 'a', mem: 'mean', pts: s.stats.avg });
        if (o.median && s.stats.med.length) tracks.push({ r: 'd', mem: 'median', pts: s.stats.med });
      }
      for (const tr of tracks) {
        const pts = cut(tr.pts, o.hour);
        if (!pts.length) continue;
        const xy = pts.map((p) => [near(p.lon, ref), p.lat]);
        for (let i = 1; i < xy.length; i++) xy[i][0] = near(xy[i][0], xy[i - 1][0]);
        const base = { m, r: tr.r, mem: tr.mem, g: g.id };
        // lines: one feature per run of segments of one colour (a segment takes its start's)
        let seg = null;
        for (let i = 0; i < pts.length - 1; i++) {
          const c = colorBy(o.line, m, pts[i]);
          if (!seg || seg.c !== c) {
            if (seg) F({ k: 'ln', ...base, c: seg.c }, { type: 'LineString', coordinates: seg.xy });
            seg = { c, xy: [xy[i]] };
          }
          seg.xy.push(xy[i + 1]);
        }
        if (seg) F({ k: 'ln', ...base, c: seg.c }, { type: 'LineString', coordinates: seg.xy });
        const info = (p) => ({ ...base, tau: p.tau, t: t0 + p.tau * H, kt: p.kt == null ? -1 : Math.round(p.kt), mb: p.mb == null ? -1 : Math.round(p.mb), n: p.n || 0 });
        if (o.pts !== 'none') pts.forEach((p, i) => F({ k: 'pt', ...info(p), c: colorBy(o.pts, m, p) }, { type: 'Point', coordinates: xy[i] }));
        const lastP = pts[pts.length - 1];
        if (o.hour < MAX_HOUR && lastP.tau === o.hour && pts.length > 1) {
          F({ k: 'end', ...info(lastP), c: colorBy(o.pts !== 'none' ? o.pts : o.line, m, lastP) }, { type: 'Point', coordinates: xy[xy.length - 1] });
        }
        if (tr.r !== 'm') F({ k: 'lbl', ...info(lastP), label: `${MODEL[m].short} ${tr.r === 'a' ? 'mean' : 'median'}`, c: MODEL[m].color }, { type: 'Point', coordinates: xy[xy.length - 1] });
      }
    }
  }
  return { type: 'FeatureCollection', features: feats };
}

// ------------------------------------------------------------------ map layers
const LAYERS = ['mt-mem', 'mt-case', 'mt-mean', 'mt-med', 'mt-pts', 'mt-end', 'mt-lbl'];
const HOVER = ['mt-end', 'mt-pts', 'mt-mean', 'mt-med', 'mt-mem'];
let lastFC = { type: 'FeatureCollection', features: [] };

/** Add the track source / layers (again after a style change), under the cyclone symbols. */
export function addTrackLayers(map, { font = ['Noto Sans Regular'], before } = {}) {
  if (map.getSource('mtracks')) return;
  map.addSource('mtracks', { type: 'geojson', data: lastFC, tolerance: 0.2 });
  const b = map.getLayer('storm-cone') ? 'storm-cone' : before && map.getLayer(before) ? before : undefined;
  const L = (spec) => map.addLayer(spec, b);
  const k = (v) => ['==', ['get', 'k'], v], r = (v) => ['==', ['get', 'r'], v];
  const zw = (a, c) => ['interpolate', ['linear'], ['zoom'], 1, a, 7, c];
  // member / mean-median sizes at zoom 1 and 7 (zoom has to be the outermost interpolation)
  const zr = (m, o) => ['interpolate', ['linear'], ['zoom'], 1, ['case', r('m'), m[0], o[0]], 7, ['case', r('m'), m[1], o[1]]];
  L({ id: 'mt-mem', type: 'line', source: 'mtracks', filter: ['all', k('ln'), r('m')], layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': zw(0.7, 1.5), 'line-opacity': 0.55 } });
  L({ id: 'mt-case', type: 'line', source: 'mtracks', filter: ['all', k('ln'), ['!=', ['get', 'r'], 'm']], layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': 'rgba(3,6,12,0.8)', 'line-width': zw(3.6, 5.6) } });
  L({ id: 'mt-mean', type: 'line', source: 'mtracks', filter: ['all', k('ln'), r('a')], layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': zw(2, 3.2) } });
  L({ id: 'mt-med', type: 'line', source: 'mtracks', filter: ['all', k('ln'), r('d')], layout: { 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': zw(2, 3.2), 'line-dasharray': [1.6, 1] } });
  L({ id: 'mt-pts', type: 'circle', source: 'mtracks', filter: k('pt'),
    paint: { 'circle-radius': zr([1.3, 2.6], [2.6, 4.2]), 'circle-color': ['get', 'c'],
      'circle-stroke-color': 'rgba(3,6,12,0.75)', 'circle-stroke-width': ['case', r('m'), 0.4, 1] } });
  L({ id: 'mt-end', type: 'circle', source: 'mtracks', filter: k('end'),
    paint: { 'circle-radius': zr([2.2, 3.6], [4, 6]), 'circle-color': ['get', 'c'],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['case', r('m'), 0.8, 1.6] } });
  L({ id: 'mt-lbl', type: 'symbol', source: 'mtracks', filter: k('lbl'), minzoom: 2.4,
    layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 10.5, 'text-anchor': 'left', 'text-offset': [0.8, 0], 'text-optional': true },
    paint: { 'text-color': ['get', 'c'], 'text-halo-color': 'rgba(3,6,12,0.92)', 'text-halo-width': 1.4 } });
}

export function showTrackLayers(map, on) {
  for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

function setData(map, fc) {
  lastFC = fc;
  const s = map.getSource('mtracks');
  if (s) s.setData(fc);
}

// ------------------------------------------------------------------ panel + loading
const DEFAULTS = { on: false, models: ['ecmwf', 'gefs'], members: true, mean: true, median: false, line: 'model', pts: 'none',
  run: 'latest', hour: MAX_HOUR, storm: 'all', genesis: false };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * The "Model tracks" controls inside `el`, the loading and the map layers.
 *   state   a plain object the app persists (filled with defaults here); onChange() after edits
 *   proxy   URL prefix that the encoded URL of a NOMADS / Weather Lab file is appended to
 *           ('' or null: those models are unavailable)
 *   names   () => [{name, now: [lon, lat]}] of the agencies' current storms, for labels
 *   fly     (lon, lat) => void, to go to a storm
 */
export class ModelTracks {
  constructor({ map, el, state, onChange = () => {}, proxy = null, names = () => [], fly = null, font, before }) {
    Object.assign(this, { map, el, onChange, proxy, names, fly, font, before });
    this.st = Object.assign(state, { ...DEFAULTS, ...state });
    this.st.models = this.st.models.filter((m) => MODEL[m]);
    this.runs = new Map();       // model -> run in use
    this.cache = new Map();      // `${model}@${t}` -> Promise<storms Map>
    this.status = new Map();     // model -> {state: 'loading'|'ok'|'none'|'error'|'proxy', text}
    this.latest = new Map();     // model -> {t, at}
    this.groups = [];
    this.gen = 0;
    this.build();
    this.chart = new TrackChart(this, MODELS); // the intensity charts window (reopens if it was open)
    setInterval(() => { if ((this.st.on || this.chart.isOpen) && this.st.run === 'latest' && !document.hidden) this.load(true); }, 30 * 60e3);
    if (this.st.on) this.load();
  }

  /** Add the layers once the map's style has loaded (again after a style change); until then
   *  the controls work and the tracks wait. */
  attach() {
    if (!this.map) return;
    addTrackLayers(this.map, { font: this.font, before: this.before });
    showTrackLayers(this.map, this.st.on);
    if (!this.hoverBound) this.bindHover();
  }

  build() {
    const st = this.st;
    this.el.innerHTML = `
      <label class="row check" title="Forecast tracks of every ensemble member (ECMWF ENS and AIFS, GEFS, GEPS, Google DeepMind FNV3 / WNV3), with the ensemble mean and median"><input type="checkbox" data-k="on"> Model tracks (ensembles)</label>
      <div class="mt-tools">
        <div class="chips small mt-models">${MODELS.map((m) => `<button type="button" data-m="${m.id}" title="${m.name}"><i style="background:${m.color}"></i>${m.short}</button>`).join('')}</div>
        <div class="row mt-show"><span>Show</span><span class="chips small">
          <button type="button" data-t="members" title="Every ensemble member">Members</button>
          <button type="button" data-t="mean" title="Ensemble mean position, wind and pressure at each hour (thick line)">Mean</button>
          <button type="button" data-t="median" title="Ensemble median of each coordinate, wind and pressure (thick dashed line)">Median</button></span></div>
        <label class="row" title="Model run (UTC). Latest: each model's newest run">Run <select data-k="run"></select></label>
        <label class="row" title="Colour of the track lines (each segment takes the value at its start)">Track colour <select data-k="line"><option value="model">Model</option><option value="wind">Wind speed</option><option value="pressure">Pressure</option></select></label>
        <label class="row" title="A dot at each forecast time, coloured by">Points <select data-k="pts"><option value="none">None</option><option value="wind">Wind speed</option><option value="pressure">Pressure</option><option value="model">Model</option></select></label>
        <label class="row" title="Draw the tracks only up to this forecast hour (from each model's run); a ring marks where each one is then">Through <input type="range" data-k="hour" min="0" max="${MAX_HOUR}" step="6"><span class="mono val mt-hour"></span></label>
        <div class="note mt-valid"></div>
        <label class="row">Storm <select data-k="storm"><option value="all">All storms</option></select></label>
        <label class="row check" title="Systems the ECMWF tracker finds forming during the forecast (not yet numbered by NHC / JTWC)"><input type="checkbox" data-k="genesis"> ECMWF new-system tracks</label>
        <button type="button" class="btn mt-chartbtn" title="Charts of the storm's forecast wind, intensity class and pressure for any of the ensembles"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 4v16h16 M7 15l4-5 3 3 5-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Intensity charts</button>
        <div class="mt-legend"></div>
        <div class="mt-status"></div>
        <div class="note">ECMWF ENS / AIFS: ECMWF open data (CC BY 4.0) · GEFS / GEPS: NCEP ensemble tracker · FNV3 / WNV3: Google DeepMind Weather Lab, experimental (<a href="${WLAB_TERMS}" target="_blank" rel="noopener">terms</a>). Not an official forecast: see NHC / JTWC.</div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.tools = q('.mt-tools');
    q('.mt-chartbtn').onclick = () => this.chart.open(st.storm !== 'all' ? st.storm : null);
    const onBox = q('[data-k=on]');
    onBox.checked = st.on;
    onBox.onchange = () => { st.on = onBox.checked; this.changed(); if (this.map) showTrackLayers(this.map, st.on); if (st.on) this.load(); else this.render(); };
    for (const b of this.el.querySelectorAll('[data-m]')) {
      b.onclick = () => {
        const m = b.dataset.m, i = st.models.indexOf(m);
        if (i >= 0) st.models.splice(i, 1); else st.models.push(m);
        this.changed(); this.load();
      };
    }
    for (const b of this.el.querySelectorAll('[data-t]')) b.onclick = () => { st[b.dataset.t] = !st[b.dataset.t]; this.changed(); this.render(); };
    // a saved value the select lacks falls back to the default (not the storm: listed as runs load)
    const sel = (k, fn) => { const s = q(`[data-k=${k}]`); s.value = String(st[k]); if (s.value !== String(st[k]) && k !== 'storm') s.value = st[k] = DEFAULTS[k]; s.onchange = () => { st[k] = s.value; this.changed(); fn(); }; };
    this.fillRuns();
    sel('run', () => this.load());
    sel('line', () => this.render());
    sel('pts', () => this.render());
    sel('storm', () => { this.render(); this.flyToStorm(); });
    const hour = q('[data-k=hour]');
    hour.value = st.hour;
    let raf = 0;
    hour.oninput = () => { st.hour = +hour.value; this.hourLabel(); cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.render()); };
    hour.onchange = () => this.changed();
    const gen = q('[data-k=genesis]');
    gen.checked = st.genesis;
    gen.onchange = () => { st.genesis = gen.checked; this.changed(); this.fillStorms(); this.render(); };
    this.sync();
  }

  changed() { this.sync(); this.onChange(this.st); }

  /** Models to load: the map's, and the charts' while their window is open. */
  wanted() {
    const w = new Set([...this.st.models, ...(this.chart?.isOpen ? this.chart.c.models : [])]);
    return MODELS.map((m) => m.id).filter((m) => w.has(m));
  }

  /** Runs of the last 3 days (refreshed as time passes); a chosen older run stays listed. */
  fillRuns() {
    const s = this.el.querySelector('[data-k=run]'), ts = cycles(null, 3);
    if (this.runsFor === ts[0]) return;
    this.runsFor = ts[0];
    if (this.st.run !== 'latest' && !ts.includes(+this.st.run)) ts.push(+this.st.run);
    s.innerHTML = '<option value="latest">Latest of each model</option>' + ts.map((t) => `<option value="${t}">${fmtRun(t)}</option>`).join('');
    s.value = String(this.st.run);
  }

  /** Reflect the state in the controls. */
  sync() {
    const st = this.st;
    this.tools.classList.toggle('hidden', !st.on);
    for (const b of this.el.querySelectorAll('[data-m]')) b.classList.toggle('on', st.models.includes(b.dataset.m));
    for (const b of this.el.querySelectorAll('[data-t]')) b.classList.toggle('on', !!st[b.dataset.t]);
    this.hourLabel();
    this.legend();
    this.showStatus();
  }

  hourLabel() {
    const st = this.st, el = this.el.querySelector('.mt-hour');
    el.textContent = st.hour >= MAX_HOUR ? 'All' : `+${st.hour} h`;
    const ts = new Set([...this.runs].filter(([m]) => st.models.includes(m)).map(([, r]) => r.t));
    const v = this.el.querySelector('.mt-valid');
    if (st.hour >= MAX_HOUR || !ts.size) v.textContent = st.hour >= MAX_HOUR ? 'Whole forecast shown.' : '';
    else if (ts.size === 1) v.textContent = `Valid ${fmtValid([...ts][0] + st.hour * H)}`;
    else v.textContent = `${st.hour} h after each model's run (runs differ: valid ${[...ts].sort((a, b) => b - a).map((t) => fmtValid(t + st.hour * H)).join(' / ')})`;
  }

  legend() {
    const st = this.st, el = this.el.querySelector('.mt-legend');
    const modes = new Set([st.line, st.pts].filter((x) => x === 'wind' || x === 'pressure'));
    const sw = (c, t) => `<span><i style="background:${c}"></i>${esc(t)}</span>`;
    let h = '';
    if (modes.has('wind')) h += `<div class="mt-leg"><b>Wind</b>${CATS.map((c) => sw(c.color, c.id === 'td' ? '<34 kt' : c.label.replace('Storm', 'TS'))).join('')}</div>`;
    if (modes.has('pressure')) h += `<div class="mt-leg"><b>hPa</b>${PBINS.map((b) => sw(b.color, b.label)).join('')}</div>`;
    el.innerHTML = h;
  }

  showStatus() {
    const el = this.el.querySelector('.mt-status');
    el.innerHTML = MODELS.map((x) => x.id).filter((m) => this.st.models.includes(m)).map((m) => {
      const s = this.status.get(m);
      return s ? `<div class="mt-st ${s.state}"><i style="background:${MODEL[m].color}"></i>${esc(MODEL[m].name)}: ${esc(s.text)}</div>` : '';
    }).join('');
  }

  setStatus(m, state, text) { this.status.set(m, { state, text }); this.showStatus(); }

  /** The run of model m at time t (cached: a published run never changes; misses are not kept). */
  fetchRun(m, t) {
    const key = `${m}@${t}`;
    if (!this.cache.has(key)) {
      const p = SOURCES[m](t, { proxy: this.proxy });
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return this.cache.get(key);
  }

  /** Load every selected model's run (Latest: the newest that exists), then draw. */
  async load(fresh = false) {
    const st = this.st, gen = ++this.gen;
    if (!st.on && !this.chart?.isOpen) return;
    const wanted = this.wanted();
    this.fillRuns();
    const jobs = wanted.map(async (m) => {
      const model = MODEL[m];
      if (model.proxy && !this.proxy) { this.runs.delete(m); this.setStatus(m, 'proxy', 'needs the data proxy (desktop app or Cloudflare deployment)'); return; }
      const want = st.run === 'latest' ? null : +st.run;
      if (want != null && !model.cycles.includes(new Date(want).getUTCHours())) {
        this.runs.delete(m); this.setStatus(m, 'none', `no ${hh(want)}Z run (runs at ${model.cycles.map((c) => `${p2(c)}Z`).join(' / ')})`); return;
      }
      const cur = this.runs.get(m), lt = this.latest.get(m);
      const known = want ?? (!fresh && lt && Date.now() - lt.at < 20 * 60e3 ? lt.t : null);
      if (cur && known != null && cur.t === known) return;
      this.setStatus(m, 'loading', want ? `loading ${fmtRun(want)}…` : 'finding the latest run…');
      try {
        let run = null;
        for (const t of known != null ? [known] : cycles(m, 2.5)) {
          try { run = { t, storms: await this.fetchRun(m, t) }; break; } catch (e) { if (!(e instanceof NotFound)) throw e; }
        }
        if (run && want == null) this.latest.set(m, { t: run.t, at: Date.now() });
        if (gen !== this.gen && !this.wanted().includes(m)) return;
        if (!run) {
          this.runs.delete(m);
          this.setStatus(m, 'none', want ? `${fmtRun(want)} not available${m === 'gefs' || m === 'geps' ? ' (NOMADS keeps 2 days)' : ''}` : 'no recent run found');
          return;
        }
        this.runs.set(m, run);
        const n = [...run.storms.values()].filter((s) => !s.genesis).length, g = run.storms.size - n;
        const mem = Math.max(0, ...[...run.storms.values()].map((s) => s.members.size));
        this.setStatus(m, 'ok', `${fmtRun(run.t)} · ${n} storm${n === 1 ? '' : 's'}${g ? ` + ${g} new` : ''}${mem ? ` · ${mem} members` : ''}`);
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.warn('model tracks', m, e);
        this.runs.delete(m);
        this.setStatus(m, 'error', `unavailable (${e.message})`);
      }
    });
    // draw as each model arrives
    for (const j of jobs) j.then(() => { if (gen === this.gen) this.regroup(); });
    await Promise.all(jobs);
    for (const m of this.runs.keys()) if (!this.wanted().includes(m)) this.runs.delete(m);
    if (gen === this.gen) this.regroup();
  }

  regroup() {
    const want = this.wanted(), runs = new Map([...this.runs].filter(([m]) => want.includes(m)));
    this.groups = groupStorms(runs, this.names() || []);
    this.fillStorms();
    this.hourLabel();
    this.render();
    this.chart?.update();
  }

  fillStorms() {
    const s = this.el.querySelector('[data-k=storm]'), st = this.st;
    const list = this.groups.filter((g) => !g.genesis || st.genesis);
    s.innerHTML = `<option value="all">All storms (${list.length})</option>` + list.map((g) => `<option value="${esc(g.id)}">${esc(g.label)} · ${[...g.models.keys()].map((m) => MODEL[m].short).join(', ')}</option>`).join('');
    s.value = st.storm;
    if (s.value !== st.storm) {
      // keep a chosen storm across reloads while its data is still coming
      if (st.storm !== 'all') { const o = document.createElement('option'); o.value = st.storm; o.textContent = `${st.storm} (not in the loaded runs)`; s.appendChild(o); }
      s.value = st.storm;
    }
  }

  flyToStorm() {
    const g = this.groups.find((x) => x.id === this.st.storm);
    if (g && this.fly) this.fly(g.pos[0], g.pos[1]);
  }

  render() {
    if (!this.map) return;
    const st = this.st;
    if (!st.on) { setData(this.map, { type: 'FeatureCollection', features: [] }); return; }
    const runs = new Map([...this.runs].filter(([m]) => st.models.includes(m)));
    setData(this.map, buildFC(runs, this.groups, { ...st, models: new Set(st.models), hour: +st.hour }));
  }

  // hover (or tap): what a track is
  bindHover() {
    const map = this.map, box = document.createElement('div');
    box.className = 'mt-tip hidden';
    map.getContainer().appendChild(box);
    this.hoverBound = true;
    const show = (e) => {
      if (!this.st.on) return false;
      const layers = HOVER.filter((id) => map.getLayer(id));
      const p = e.point, f = map.queryRenderedFeatures([[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]], { layers })[0];
      if (!f) { box.classList.add('hidden'); return false; }
      const q = f.properties, model = MODEL[q.m], run = this.runs.get(q.m);
      const who = q.r === 'm' ? q.mem : `ensemble ${q.mem}${q.n ? ` (${q.n} members)` : ''}`;
      let h = `<b style="color:${model.color}">${esc(model.name)}</b> ${esc(who)}`;
      if (run) h += `<br><span>${fmtRun(run.t)} run</span>`;
      if (q.tau != null && q.t) {
        h += `<br>+${q.tau} h · ${fmtValid(q.t)}`;
        const kt = q.kt >= 0 ? `${q.kt} kt (${category(q.kt).label})` : '', mb = q.mb >= 0 ? `${q.mb} hPa` : '';
        if (kt || mb) h += `<br>${[kt, mb].filter(Boolean).join(' · ')}`;
      }
      const g = this.groups.find((x) => x.id === q.g);
      if (g) h += `<br><span>${esc(g.label)}</span>`;
      box.innerHTML = h;
      box.style.left = `${Math.min(p.x + 14, map.getContainer().clientWidth - 230)}px`;
      box.style.top = `${Math.max(4, p.y - 10)}px`;
      box.classList.remove('hidden');
      return true;
    };
    map.on('mousemove', (e) => { if (e.originalEvent?.buttons) return; show(e); });
    map.on('click', (e) => { if (show(e)) { clearTimeout(this.tipT); this.tipT = setTimeout(() => box.classList.add('hidden'), 5000); } });
    map.getCanvasContainer().addEventListener('mouseleave', () => box.classList.add('hidden'));
  }
}
