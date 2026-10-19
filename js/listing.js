/* NODD S3 bucket listings -> complete scans per time.
 *
 * Listings use narrow prefixes (one sector token, all bands) so an hour of 1-minute meso scans is
 * one small request; past hours are cached far longer than the hour still being written.
 */
import { SATS } from './catalog.js';

const cfg = (globalThis.SATVIEW_CONFIG || {});
export function s3url(bucket, key = '') {
  const p = cfg.s3Proxy;
  return p ? `${p.replace(/\/$/, '')}/${bucket}/${key}` : `https://${bucket}.s3.amazonaws.com/${key}`;
}
export function setProxy(p) { cfg.s3Proxy = p; }

const cache = new Map(); // prefix -> {t, ttl, p: Promise}
const RE_ITEM = /<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g;

export async function listKeys(bucket, prefix, ttl = 60e3, signal) {
  const ck = `${bucket}/${prefix}`, now = Date.now();
  const hit = cache.get(ck);
  if (hit && now - hit.t < hit.ttl) return hit.p;
  const p = (async () => {
    const out = [];
    let token = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
      if (token) q.set('continuation-token', token);
      const r = await fetch(`${s3url(bucket)}?${q}`, { signal });
      if (!r.ok) throw new Error(`listing failed (HTTP ${r.status})`);
      const xml = await r.text();
      for (const m of xml.matchAll(RE_ITEM)) out.push({ key: m[1].replace(/&amp;/g, '&'), size: +m[2] });
      const tr = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = tr ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] : null;
      if (!token) break;
    }
    return out;
  })();
  cache.set(ck, { t: now, ttl, p });
  p.catch(() => cache.delete(ck));
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return p;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const doy = (d) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;

// ------------------------------------------------------------------ GOES
export const CADENCE_MIN = { full: 10, conus: 5, pacus: 5, meso1: 1, meso2: 1, custom: 10, japan: 2.5, target: 2.5, la: 2 };

/** Product folder + filename token of a GOES sector for a data family ('cmip' | 'l1b'). */
export function goesSource(sector, family) {
  const s = sector === 'custom' ? 'full' : sector;
  if (family === 'cmip') {
    if (s === 'full') return ['ABI-L2-MCMIPF', 'MCMIPF', 'L2'];
    if (s === 'conus' || s === 'pacus') return ['ABI-L2-MCMIPC', 'MCMIPC', 'L2'];
    return ['ABI-L2-MCMIPM', s === 'meso1' ? 'MCMIPM1' : 'MCMIPM2', 'L2'];
  }
  if (s === 'full') return ['ABI-L1b-RadF', 'RadF', 'L1b'];
  if (s === 'conus' || s === 'pacus') return ['ABI-L1b-RadC', 'RadC', 'L1b'];
  return ['ABI-L1b-RadM', s === 'meso1' ? 'RadM1' : 'RadM2', 'L1b'];
}

const RE_GOES = /OR_ABI-(L1b|L2)-(\w+?)-M\d(C\d\d)?_G\d\d_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)/;

function hourFolders(end, hours) {
  const out = [];
  let t = new Date(end); t.setUTCMinutes(0, 0, 0);
  const stop = end.getTime() - hours * 3600e3;
  while (t.getTime() > stop - 3600e3) { out.push(new Date(t)); t = new Date(t.getTime() - 3600e3); }
  return out;
}

export async function goesScans(sat, sector, family, { end, hours, signal }) {
  const { bucket } = SATS[sat];
  const [folder, token, level] = goesSource(sector, family);
  const now = Date.now();
  end = end || new Date();
  const lists = await Promise.all(hourFolders(end, hours).map((t) => {
    const pfx = `${folder}/${t.getUTCFullYear()}/${pad(doy(t), 3)}/${pad(t.getUTCHours())}/OR_ABI-${level}-${token}-M`;
    const recent = now - t.getTime() < 75 * 60e3;
    return listKeys(bucket, pfx, recent ? 30e3 : 6 * 3600e3, signal).catch(() => []);
  }));
  const scans = new Map(); // ms -> {t, bands: {band: {key,size}}}
  const times = [];
  for (const keys of lists) for (const { key, size } of keys) {
    const m = RE_GOES.exec(key);
    if (!m || m[2] !== token) continue;
    const [y, j, H, M, S, ds] = [+m[4], +m[5], +m[6], +m[7], +m[8], +m[9]];
    const ms = Date.UTC(y, 0, j, H, M, S) + ds * 100;
    const band = m[3] ? parseInt(m[3].slice(1), 10) : 0;
    let tk = times.find((x) => Math.abs(x - ms) <= 3000);
    if (tk === undefined) { tk = ms; times.push(ms); scans.set(ms, { t: new Date(ms), bands: {} }); }
    scans.get(tk).bands[band] = { key, size };
  }
  return scans;
}

// ------------------------------------------------------------------ Himawari
const AHI_FOLDER = { full: 'AHI-L1b-FLDK', custom: 'AHI-L1b-FLDK', japan: 'AHI-L1b-Japan', target: 'AHI-L1b-Target' };
const RE_AHI = /HS_H\d\d_(\d{8})_(\d{4})_B(\d\d)_(\w{4})_R(\d\d)_S(\d\d)(\d\d)\.DAT\.bz2/;

export async function ahiScans(sat, sector, { end, hours, signal }) {
  const { bucket } = SATS[sat];
  const folder = AHI_FOLDER[sector];
  end = end || new Date();
  const t0 = new Date(end); t0.setUTCMinutes(t0.getUTCMinutes() - (t0.getUTCMinutes() % 10), 0, 0);
  const n = Math.ceil(hours * 6 - 1e-9) + 1, now = Date.now();
  const lists = await Promise.all(Array.from({ length: n }, (_, i) => {
    const t = new Date(t0.getTime() - i * 600e3);
    const pfx = `${folder}/${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}/${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}/`;
    return listKeys(bucket, pfx, now - t.getTime() < 3600e3 ? 30e3 : 6 * 3600e3, signal).catch(() => []);
  }));
  const scans = new Map();
  for (const keys of lists) for (const { key, size } of keys) {
    const m = RE_AHI.exec(key);
    if (!m) continue;
    const d = m[1], hm = m[2], area = m[4];
    let ms = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +hm.slice(0, 2), +hm.slice(2, 4));
    if (area.startsWith('JP') || area.startsWith('R3')) ms += 150e3 * (parseInt(area.slice(2), 10) - 1);
    else if (area !== 'FLDK') continue;
    const band = +m[3];
    if (!scans.has(ms)) scans.set(ms, { t: new Date(ms), bands: {} });
    (scans.get(ms).bands[band] ||= []).push({ key, size, seg: +m[6], nseg: +m[7], res: +m[5] });
  }
  return scans;
}

// ------------------------------------------------------------------ GK2A
// AMI/L1B/{FD,LA}/YYYYMM/DD/HH/gk2a_ami_le1b_<channel>_<fd|la><res>ge_YYYYMMDDHHMM.nc
const RE_AMI = /gk2a_ami_le1b_(\w{5})_(fd|la)\d{3}ge_(\d{12})\.nc$/;
const AMI_BAND = { vi004: 1, vi005: 2, vi006: 3, vi008: 4, nr013: 5, nr016: 6, sw038: 7, wv063: 8, wv069: 9, wv073: 10,
  ir087: 11, ir096: 12, ir105: 13, ir112: 14, ir123: 15, ir133: 16 };

export async function amiScans(sat, sector, { end, hours, signal }) {
  const { bucket } = SATS[sat];
  const area = sector === 'la' ? 'LA' : 'FD';
  const now = Date.now();
  end = end || new Date();
  const lists = await Promise.all(hourFolders(end, hours).map((t) => {
    const pfx = `AMI/L1B/${area}/${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}/${pad(t.getUTCHours())}/`;
    const recent = now - t.getTime() < 75 * 60e3;
    return listKeys(bucket, pfx, recent ? 30e3 : 6 * 3600e3, signal).catch(() => []);
  }));
  const scans = new Map();
  for (const keys of lists) for (const { key, size } of keys) {
    const m = RE_AMI.exec(key);
    const band = m && AMI_BAND[m[1]];
    if (!band) continue;
    const d = m[3], ms = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12));
    if (!scans.has(ms)) scans.set(ms, { t: new Date(ms), bands: {} });
    scans.get(ms).bands[band] = { key, size };
  }
  return scans;
}

const complete = (e) => Array.isArray(e) ? e.length > 0 && e.length === e[0].nseg : !!e;

/**
 * Complete scans for a sector/product, newest first.
 *   live:    the latest `limit` scans
 *   archive: every scan in [end - hours, end]
 */
export async function availableScans(sat, sector, family, bands, { limit = 12, end = null, hours = null, signal } = {}) {
  const cad = CADENCE_MIN[sector] || 10;
  const live = !end;
  if (live) hours = Math.min(24, Math.max(sector === 'full' || sector === 'custom' ? 1.5 : 1, (limit * cad) / 60 + 0.4));
  else hours = Math.min(24, Math.max(0.1, hours || 1));
  const kind = SATS[sat].kind;
  const range = { end: end || new Date(), hours, signal };
  const scans = kind === 'goes' ? await goesScans(sat, sector, family, range)
    : kind === 'ami' ? await amiScans(sat, sector, range) : await ahiScans(sat, sector, range);
  const need = kind === 'goes' && family === 'cmip' ? [0] : bands;
  let ok = [...scans.values()].filter((s) => need.every((b) => complete(s.bands[b])));
  if (!live) { const lo = end.getTime() - hours * 3600e3; ok = ok.filter((s) => s.t >= lo && s.t <= end); }
  ok.sort((a, b) => b.t - a.t);
  return live ? ok.slice(0, limit) : ok;
}
