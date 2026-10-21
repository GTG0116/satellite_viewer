/* GLM lightning: flashes seen by the GOES-East and GOES-West Geostationary Lightning Mappers in
 * the minutes before a time, from the 20 s L2 LCFA files on the NOAA buckets (decoded in a worker,
 * each file once). */
import { listKeys, s3url } from './listing.js';

// operational GOES-East / GOES-West and when each took over (their GLM data is on the same bucket)
const EAST = [['goes19', Date.UTC(2025, 3, 7)], ['goes16', Date.UTC(2017, 1, 28)]];
const WEST = [['goes18', Date.UTC(2023, 0, 4)], ['goes17', Date.UTC(2019, 1, 12)]];
const RE = /OR_GLM-L2-LCFA_G\d\d_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const doy = (d) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;

/** The satellites whose GLM was operational at t (ms). */
export function glmSats(t) {
  const out = [];
  for (const chain of [EAST, WEST]) { const s = chain.find(([, since]) => t >= since); if (s) out.push(s[0]); }
  return out;
}

const decoded = new Map(); // url -> Promise<{lat, lon, energy}>

async function filesOf(sat, t0, t1, signal) {
  const bucket = `noaa-${sat}`, out = [];
  const now = Date.now();
  for (let h = Math.floor(t0 / 3600e3) * 3600e3; h < t1; h += 3600e3) {
    const d = new Date(h);
    const keys = await listKeys(bucket, `GLM-L2-LCFA/${d.getUTCFullYear()}/${pad(doy(d), 3)}/${pad(d.getUTCHours())}/`,
      now - h < 75 * 60e3 ? 30e3 : 6 * 3600e3, signal).catch(() => []);
    for (const { key, size } of keys) {
      const m = RE.exec(key);
      if (!m) continue;
      const ms = Date.UTC(+m[1], 0, +m[2], +m[3], +m[4], +m[5]);
      if (ms >= t0 && ms < t1) out.push({ url: s3url(bucket, key), size, t: ms });
    }
  }
  return out;
}

/** Flashes in [end - minutes, end]: {lon, lat, age (s before end), energy (fJ)} arrays plus the
 *  satellites used and the number of files read. */
export async function glmFlashes(end, minutes, pool, { signal } = {}) {
  const t1 = end.getTime(), t0 = t1 - minutes * 60e3;
  const sats = glmSats(t1);
  const lists = await Promise.all(sats.map((s) => filesOf(s, t0, t1, signal)));
  const files = lists.flat();
  const parts = await Promise.all(files.map(async (f) => {
    let p = decoded.get(f.url);
    if (!p) {
      p = pool.run('glmFile', { url: f.url, size: f.size }, { pri: 4, signal });
      decoded.set(f.url, p);
      p.catch(() => decoded.delete(f.url));
      if (decoded.size > 800) decoded.delete(decoded.keys().next().value);
    }
    try { return { ...(await p), age: Math.max(0, (t1 - f.t) / 1000 - 10) }; } catch (e) { return null; }
  }));
  let n = 0;
  for (const p of parts) if (p) n += p.lat.length;
  const lon = new Float32Array(n), lat = new Float32Array(n), age = new Float32Array(n), energy = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    if (!p) continue;
    lon.set(p.lon, o); lat.set(p.lat, o); energy.set(p.energy, o); age.fill(p.age, o, o + p.lat.length);
    o += p.lat.length;
  }
  return { lon, lat, age, energy, sats: sats.filter((s, i) => lists[i].length), files: files.length };
}
