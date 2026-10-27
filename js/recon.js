/* Hurricane Hunter reconnaissance: the flights of NOAA's Aircraft Operations Center (P-3 Orions
 * "Kermit" / "Miss Piggy", G-IV "Gonzo") and the Air Force Reserve's 53rd Weather Reconnaissance
 * Squadron (WC-130J), drawn on a MapLibre or Mapbox GL map (the same file serves both editions,
 * like overlays.js). From the messages NHC archives as they arrive, every basin it covers:
 *   HDOB       high-density observations every 30 s (one message per 10 min of flight):
 *              position, flight level, extrapolated surface pressure or D-value, temperature,
 *              dew point, flight-level wind, peak 10-s wind, SFMR surface wind and rain rate,
 *              quality flags
 *   VDM        vortex data messages: the center fixes (minimum pressure, eye, maximum winds)
 *   TEMP DROP  dropsondes: release / splash position, surface pressure and wind, the mean
 *              wind of the lowest 500 m and 150 m
 * www.nhc.noaa.gov/archive/recon/<year>/<product>/ sends no CORS headers: its directory listings
 * (filtered to a day by Apache's ?P= pattern) and the messages come through the same small proxy
 * as the model tracks (`proxy`). The observations follow the shown frame: each frame shows the
 * flights during the chosen trail before its time, so a loop animates the aircraft.
 */
import { CATS, category, fmtWind, onStyle } from './overlays.js';
import { PBINS } from './tracks.js';

const ARCHIVE = 'https://www.nhc.noaa.gov/archive/recon';
const BASINS = [
  { id: 'al', name: 'Atlantic', short: 'Atlantic', hdob: 'AHONT1', vdm: 'REPNT2', drop: 'REPNT3' },
  { id: 'ep', name: 'East Pacific', short: 'E Pacific', hdob: 'AHOPN1', vdm: 'REPPN2', drop: 'REPPN3' },
  { id: 'cp', name: 'Central Pacific', short: 'C Pacific', hdob: 'AHOPA1', vdm: 'REPPA2', drop: 'REPPA3' },
];
const H = 3600e3, DAY = 864e5;
const MAX_SPAN = 4 * DAY;              // at most this much is fetched at once
const NODATA = '#7d889a';
const AGENCY = {
  noaa: { name: 'NOAA', long: 'NOAA Aircraft Operations Center', color: '#4dabf7' },
  af: { name: 'Air Force Reserve', long: 'Air Force Reserve 53rd Weather Reconnaissance Squadron', color: '#ffa94d' },
};
const PLANES = { NOAA2: 'NOAA P-3 N42RF “Kermit”', NOAA3: 'NOAA P-3 N43RF “Miss Piggy”', NOAA9: 'NOAA G-IV N49RF “Gonzo”' };
const agencyOf = (ac) => (/^NOAA/i.test(ac) ? 'noaa' : 'af');
const planeName = (ac) => PLANES[ac] || (/^AF/i.test(ac) ? `USAF WC-130J ${ac}` : /^NOAA/i.test(ac) ? `NOAA ${ac}` : ac);

// what the observations can be coloured by
const RAMP_T = ['#3a4cc0', '#5f8de8', '#8fc4f5', '#d9eef2', '#f6e3a3', '#f5a65b', '#e0512f', '#a50f15'];
const RAMP_RAIN = ['#2b3a4f', '#2f6fb5', '#2fb5a3', '#9bd94a', '#f2e14b', '#f59a2c', '#e8412c', '#c51b8a'];
const RAMP_Z = ['#253494', '#2c7fb8', '#41b6c4', '#a1dab4', '#ffffcc'];
const VARS = {
  fl: { name: 'Flight-level wind (30 s)', get: (o) => o.ws, wind: true },
  peak: { name: 'Peak flight-level wind (10 s)', get: (o) => o.fl, wind: true },
  sfmr: { name: 'SFMR surface wind', get: (o) => o.sfmr, wind: true },
  pres: { name: 'Extrapolated surface pressure', get: (o) => o.xp, pres: true },
  temp: { name: 'Temperature', get: (o) => o.T, ramp: RAMP_T, lo: -10, hi: 30, unit: '°C' },
  dew: { name: 'Dew point', get: (o) => o.Td, ramp: RAMP_T, lo: -30, hi: 26, unit: '°C' },
  rain: { name: 'SFMR rain rate', get: (o) => o.rain, ramp: RAMP_RAIN, lo: 0, hi: 60, unit: 'mm/h' },
  alt: { name: 'Flight altitude', get: (o) => o.z, ramp: RAMP_Z, lo: 0, hi: 14000, unit: 'm' },
  agency: { name: 'Agency (NOAA / Air Force)', get: () => 0 },
};

const DEFAULTS = { on: false, basins: ['al', 'ep', 'cp'], noaa: true, af: true, hours: 12, color: 'fl',
  line: true, pts: true, barbs: false, plane: true, vdm: true, drops: true, labels: true, flagged: false };

// ------------------------------------------------------------------ helpers
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`; };
const hm = (t) => { const d = new Date(t); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}Z`; };
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dhm = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONS[d.getUTCMonth()]} ${hm(t)}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const title = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const dayStart = (t) => Math.floor(t / DAY) * DAY;
const fileTime = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
const digits = (s) => (/^\d+$/.test(s) ? +s : null);
const tenths = (s) => (/^[+-]\d{3}$/.test(s) ? +s / 10 : null);
const fmtNum = (v, d = 0) => (v == null ? '—' : v.toFixed(d));

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function rampColor(stops, f) {
  f = Math.min(1, Math.max(0, f)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]);
  return `#${a.map((x, k) => Math.round(x + (b[k] - x) * u).toString(16).padStart(2, '0')).join('')}`;
}

/** WMO 5-digit wind "dddff": direction to 5 degrees, the hundreds of the speed added to its units digit. */
function dddff(s) {
  if (!/^\d{5}$/.test(s)) return null;
  let d = +s.slice(0, 3), f = +s.slice(3);
  const extra = d % 5;
  if (extra) { d -= extra; f += 100 * extra; }
  return { wd: d, ws: f };
}
const stormName = (s) => {
  s = (s || '').trim();
  return !s || /^\d+$/.test(s) ? '' : /^(TRAIN|TEST)/.test(s) ? 'training' : title(s);
};

// ------------------------------------------------------------------ message parsing
// "185900 2755N 08255W 7010 03152 0140 +081 //// ////// /// /// /// 09"
const OB_RE = /^(\d{6}) (\d{4})([NS]) (\d{5})([EW]) (\S{4}) (\S{5}) (\S{4}) (\S{4}) (\S{4}) (\S{6}) (\S{3}) (\S{3}) (\S{3}) (\S{2})/;

/** HDOB: header "AF305 0610A IDALIA HDOB 23 20230829", then one line per 30 s. */
export function parseHdob(txt, fileT) {
  const lines = txt.split(/\r?\n/);
  const hi = lines.findIndex((l) => /\bHDOB\b/.test(l));
  if (hi < 0) return null;
  const tok = lines[hi].trim().split(/\s+/), k = tok.indexOf('HDOB');
  const d0 = dayStart(fileT), obs = [];
  for (const l of lines.slice(hi + 1)) {
    const m = OB_RE.exec(l.trim());
    if (!m) continue;
    let t = d0 + (+m[1].slice(0, 2) * 3600 + +m[1].slice(2, 4) * 60 + +m[1].slice(4, 6)) * 1e3;
    if (t > fileT + 30 * 60e3) t -= DAY;   // observed before midnight, sent after
    const lat = (+m[2].slice(0, 2) + +m[2].slice(2) / 60) * (m[3] === 'S' ? -1 : 1);
    const lon = (+m[4].slice(0, 3) + +m[4].slice(3) / 60) * (m[5] === 'W' ? -1 : 1);
    // pressures in tenths of hPa without the thousands digit
    let p = digits(m[6]);
    if (p != null) { p /= 10; if (p < 100) p += 1000; }
    const x = digits(m[8]);
    let xp = null, dv = null;
    // below 550 hPa the field is the D-value (m, 5000 added when negative)
    if (x != null && p != null) {
      if (p >= 550) { xp = x / 10; if (xp < 100) xp += 1000; } else dv = x >= 5000 ? -(x - 5000) : x;
    }
    const w = /^\d{6}$/.test(m[11]) ? m[11] : null, f = m[15];
    obs.push({ t, lat, lon, p, z: digits(m[7]), xp, dv, T: tenths(m[9]), Td: tenths(m[10]),
      wd: w ? +w.slice(0, 3) : null, ws: w ? +w.slice(3) : null, fl: digits(m[12]), sfmr: digits(m[13]), rain: digits(m[14]),
      qp: /\d/.test(f[0]) ? +f[0] : 0, qm: /\d/.test(f[1]) ? +f[1] : 0 });
  }
  return obs.length ? { kind: 'hdob', ac: tok[0], mission: tok[1] || '', storm: stormName(tok.slice(2, k).join(' ')), obs } : null;
}

/** VDM: "VORTEX DATA MESSAGE AL092026", items "A. 09/18:29:30Z", "B. 28.59 deg N 087.11 deg W", ... */
export function parseVdm(txt, fileT) {
  if (!/VORTEX DATA MESSAGE/.test(txt)) return null;
  const item = (c) => { const m = new RegExp(`^${c}\\.\\s*(.*)$`, 'm').exec(txt); return m ? m[1].trim() : null; };
  const a = /^(\d{1,2})\/(\d{2}):?(\d{2}):?(\d{2})?Z/.exec(item('A') || '');
  const b = /([\d.]+)\s*deg\s*([NS])\s+([\d.]+)\s*deg\s*([EW])/.exec(item('B') || '');
  if (!a || !b) return null;
  const f = new Date(fileT);
  let t = Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), +a[1], +a[2], +a[3], +(a[4] || 0));
  if (t > fileT + DAY) t = Date.UTC(f.getUTCFullYear(), f.getUTCMonth() - 1, +a[1], +a[2], +a[3], +(a[4] || 0));
  const u = /^(\S+)\s+(\S+)\s+(.*?)\s+OB\s+(\d+)/.exec(item('U') || '');
  const kt = (s) => { const m = /(\d+)\s*kt/i.exec(s || ''); return m ? +m[1] : null; };
  const mb = /(\d{3,4})\s*mb/i.exec(item('D') || '');
  const lvl = /(\d{3,4})\s*mb\s+(\d+)\s*m/i.exec(item('C') || '');
  const maxfl = /MAX FL WIND\s+(\d+)\s*KT\s*(\d+)\s*\/\s*(\d+)\s*NM/i.exec(txt);
  const id = (/VORTEX DATA MESSAGE\s+(\w+)/.exec(txt) || [])[1] || '';
  const na = (s) => (s && !/^NA$/i.test(s) ? s : null);
  return { kind: 'vdm', id, t, lat: +b[1] * (b[2] === 'S' ? -1 : 1), lon: +b[3] * (b[4] === 'W' ? -1 : 1),
    mslp: mb ? +mb[1] : null, level: lvl ? `${lvl[1]} hPa ${lvl[2]} m` : null, eye: na(item('F')), shape: na(item('G')),
    sfcIn: kt(item('H')), flIn: kt(item('J')), sfcOut: kt(item('L')), flOut: kt(item('N')),
    maxfl: maxfl ? { kt: +maxfl[1], brg: +maxfl[2], nm: +maxfl[3] } : null,
    ac: u ? u[1] : '', mission: u ? u[2] : '', storm: stormName(u ? u[3] : ''), ob: u ? +u[4] : null };
}

/** TEMP DROP: parts XXAA / XXBB, "61616 NOAA9 WXWXA TRAIN OB 01", "62626 ... REL ... SPG ... =" */
export function parseDrop(txt, fileT) {
  if (!/XXAA|XXBB/.test(txt)) return null;
  const id = /61616\s+(\S+)\s+(\S+)\s+(.*?)\s+OB\s+(\d+)/.exec(txt);
  // the 62626 remarks wrap at a fixed column, also in the middle of a group: join the lines
  const rmk = ((/62626\s+([\s\S]*?)(?:=|$)/.exec(txt) || [])[1] || '').replace(/\r?\n/g, '');
  const pos = (re) => { const m = re.exec(rmk); return m ? { lat: +m[1] / 100 * (m[2] === 'S' ? -1 : 1), lon: +m[3] / 100 * (m[4] === 'W' ? -1 : 1), hms: m[5] } : null; };
  const spg = pos(/SPG\s*(\d{4})([NS])(\d{5})([EW])\s*(\d{6})/) || pos(/SPL\s*(\d{4})([NS])(\d{5})([EW])\s*(\d{4,6})/);
  const rel = pos(/REL\s*(\d{4})([NS])(\d{5})([EW])\s*(\d{6})/);
  let lat = spg?.lat ?? rel?.lat, lon = spg?.lon ?? rel?.lon, p = null, wind = null;
  const part = (name) => {
    const m = new RegExp(`${name}\\s+([\\s\\S]*?)(?:31313|61616|=|$)`).exec(txt);
    return m ? m[1].trim().split(/\s+/) : null;
  };
  const aa = part('XXAA'), bb = part('XXBB');
  if (aa && aa.length >= 4 && lat == null) {
    // 99LaLaLa QcLoLoLoLo: tenths of a degree, quadrant 1 NE, 3 SE, 5 SW, 7 NW
    const la = /^99(\d{3})$/.exec(aa[1]), lo = /^([1357])(\d{4})$/.exec(aa[2]);
    if (la && lo) { lat = +la[1] / 10 * (lo[1] === '3' || lo[1] === '5' ? -1 : 1); lon = +lo[2] / 10 * (lo[1] === '5' || lo[1] === '7' ? -1 : 1); }
  }
  if (lat == null) return null;
  const pres = (s) => { const v = +s.slice(2); return v < 100 ? v + 1000 : v; };
  if (aa && /^99\d{3}$/.test(aa[4] || '')) { p = pres(aa[4]); wind = dddff(aa[6] || ''); }
  else if (bb && /^00\d{3}$/.test(bb[4] || '')) p = pres(bb[4]);
  const mbl = dddff((/MBL WND\s*(\d{5})/.exec(rmk) || [])[1] || ''), wl150 = dddff((/WL150\s*(\d{5})/.exec(rmk) || [])[1] || '');
  const hms = spg?.hms || rel?.hms;
  let t = fileT;
  if (hms) {
    t = dayStart(fileT) + (+hms.slice(0, 2) * 3600 + +hms.slice(2, 4) * 60 + (+hms.slice(4, 6) || 0)) * 1e3;
    if (t > fileT + 30 * 60e3) t -= DAY;
  }
  return { kind: 'drop', t, lat, lon, p, wd: wind?.wd ?? null, ws: wind?.ws ?? null, mbl, wl150, splash: !!spg,
    eye: /\b(EYE|CENTER)\b/.test(rmk), eyewall: /EYEWALL/.test(rmk),
    ac: id ? id[1] : '', mission: id ? id[2] : '', storm: stormName(id ? id[3] : ''), ob: id ? +id[4] : null };
}

// ------------------------------------------------------------------ map icons
/** Wind barb pointing north (into the wind), feathers on the clockwise side (Northern Hemisphere). */
function barbIcon(kt) {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), cx = S / 2, cy = S / 2;
  g.lineCap = 'round'; g.lineJoin = 'round';
  const draw = (color, w) => {
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = w;
    if (kt < 3) { g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.stroke(); return; }
    const L = 26, top = cy - L;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, top); g.stroke();
    let n = Math.round(kt / 5) * 5, y = top;
    const fx = 11, fy = -5;
    while (n >= 50) { g.beginPath(); g.moveTo(cx, y); g.lineTo(cx + fx, y + fy + 3); g.lineTo(cx, y + 6); g.closePath(); g.fill(); y += 8; n -= 50; }
    while (n >= 10) { g.beginPath(); g.moveTo(cx, y); g.lineTo(cx + fx, y + fy); g.stroke(); y += 4.5; n -= 10; }
    if (n >= 5) { if (y === top) y += 4.5; g.beginPath(); g.moveTo(cx, y); g.lineTo(cx + fx / 2, y + fy / 2); g.stroke(); }
  };
  draw('rgba(3,6,12,0.85)', 4.2);
  draw('#ffffff', 1.8);
  return g.getImageData(0, 0, S, S);
}

/** Top view of an aircraft pointing north. */
function planeIcon(color) {
  const S = 56, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.translate(S / 2, S / 2);
  g.scale(S / 30, S / 30);
  g.beginPath();
  g.moveTo(0, -12); g.quadraticCurveTo(1.6, -11, 1.6, -7); g.lineTo(1.6, -3); g.lineTo(12, 2); g.lineTo(12, 4.2); g.lineTo(1.6, 2);
  g.lineTo(1.3, 8); g.lineTo(5, 10.6); g.lineTo(5, 12.2); g.lineTo(0, 11); g.lineTo(-5, 12.2); g.lineTo(-5, 10.6); g.lineTo(-1.3, 8);
  g.lineTo(-1.6, 2); g.lineTo(-12, 4.2); g.lineTo(-12, 2); g.lineTo(-1.6, -3); g.lineTo(-1.6, -7); g.quadraticCurveTo(-1.6, -11, 0, -12);
  g.closePath();
  g.lineWidth = 1.6; g.strokeStyle = 'rgba(3,6,12,0.9)'; g.stroke();
  g.fillStyle = color; g.fill();
  return g.getImageData(0, 0, S, S);
}

/** Center fix: a ring with a cross. */
function fixIcon() {
  const S = 44, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), m = S / 2;
  for (const [col, w] of [['rgba(3,6,12,0.85)', 5], ['#ffe066', 2.2]]) {
    g.strokeStyle = col; g.lineWidth = w;
    g.beginPath(); g.arc(m, m, 9, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(m - 16, m); g.lineTo(m - 4, m); g.moveTo(m + 4, m); g.lineTo(m + 16, m);
    g.moveTo(m, m - 16); g.lineTo(m, m - 4); g.moveTo(m, m + 4); g.lineTo(m, m + 16); g.stroke();
  }
  return g.getImageData(0, 0, S, S);
}

/** Dropsonde: a small downward triangle. */
function dropIcon() {
  const S = 32, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.beginPath(); g.moveTo(8, 9); g.lineTo(24, 9); g.lineTo(16, 24); g.closePath();
  g.lineWidth = 2.4; g.strokeStyle = 'rgba(3,6,12,0.9)'; g.stroke();
  g.fillStyle = '#9be7ff'; g.fill();
  return g.getImageData(0, 0, S, S);
}

// ------------------------------------------------------------------ map layers
const LAYERS = ['recon-seg', 'recon-ob', 'recon-barb', 'recon-drop', 'recon-vdm', 'recon-plane'];
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

function addReconLayers(map, { font, before }) {
  if (!map.hasImage('rc-fix')) map.addImage('rc-fix', fixIcon(), { pixelRatio: 2 });
  if (!map.hasImage('rc-drop')) map.addImage('rc-drop', dropIcon(), { pixelRatio: 2 });
  for (const a of Object.keys(AGENCY)) if (!map.hasImage(`rc-plane-${a}`)) map.addImage(`rc-plane-${a}`, planeIcon(AGENCY[a].color), { pixelRatio: 2 });
  if (map.getSource('recon')) return;
  map.addSource('recon', { type: 'geojson', data: emptyFC(), tolerance: 0.1 });
  map.addSource('recon-now', { type: 'geojson', data: emptyFC() });
  const b = before && map.getLayer(before) ? before : undefined;
  const L = (spec) => map.addLayer(spec, b);
  const halo = { 'text-color': '#ffffff', 'text-halo-color': 'rgba(3,6,12,0.9)', 'text-halo-width': 1.4 };
  const k = (v) => ['==', ['get', 'k'], v];
  L({ id: 'recon-seg', type: 'line', source: 'recon', filter: k('seg'), layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.2, 6, 2.2, 10, 3.4], 'line-opacity': 0.92 } });
  L({ id: 'recon-ob', type: 'circle', source: 'recon', filter: k('ob'),
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 1.1, 6, 2.2, 10, 3.8], 'circle-color': ['get', 'c'],
      'circle-stroke-color': 'rgba(3,6,12,0.6)', 'circle-stroke-width': 0.5 } });
  L({ id: 'recon-barb', type: 'symbol', source: 'recon', filter: ['all', k('ob'), ['has', 'b']],
    layout: { 'icon-image': ['get', 'b'], 'icon-rotate': ['get', 'd'], 'icon-rotation-alignment': 'map', 'icon-anchor': 'center',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 0.95], 'icon-padding': 0 } });
  L({ id: 'recon-drop', type: 'symbol', source: 'recon', filter: k('drop'),
    layout: { 'icon-image': 'rc-drop', 'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.75, 8, 1.1], 'icon-allow-overlap': true,
      'text-field': ['get', 'label'], 'text-font': font, 'text-size': 10, 'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-optional': true },
    paint: { ...halo, 'text-color': '#c9f1ff' } });
  L({ id: 'recon-vdm', type: 'symbol', source: 'recon', filter: k('vdm'),
    layout: { 'icon-image': 'rc-fix', 'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 8, 1.15], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'text-field': ['get', 'label'], 'text-font': font, 'text-size': 11, 'text-anchor': 'left', 'text-offset': [1.3, 0], 'text-optional': true },
    paint: { ...halo, 'text-color': '#fff2b3' } });
  L({ id: 'recon-plane', type: 'symbol', source: 'recon-now',
    layout: { 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'h'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.75, 8, 1.15],
      'text-field': ['get', 'label'], 'text-font': font, 'text-size': 10.5, 'text-anchor': 'left', 'text-offset': [1.6, 0], 'text-justify': 'left', 'text-optional': true },
    paint: halo });
}

// ------------------------------------------------------------------ fetching
async function getText(url, proxy, signal) {
  const r = await fetch(proxy + encodeURIComponent(url), { signal, cache: 'no-cache' });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function eachLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}

/**
 * The "Hurricane Hunters" card inside `el`, the loading and the map layers.
 *   state   a plain object the app persists (filled with defaults here); onChange() after edits
 *   proxy   URL prefix the encoded URL of an NHC archive file is appended to ('' / null: none)
 *   fly     (lon, lat) => void, to go to an aircraft
 */
export class Recon {
  constructor({ map, el, state, onChange = () => {}, proxy = null, fly = null, font = ['Noto Sans Regular'], before }) {
    Object.assign(this, { map, el, onChange, proxy, fly, font, before });
    this.st = Object.assign(state, { ...DEFAULTS, ...state });
    this.st.basins = (this.st.basins || []).filter((b) => BASINS.some((x) => x.id === b));
    if (!VARS[this.st.color]) this.st.color = DEFAULTS.color;
    this.lists = new Map();    // `${folder}/${day}` -> {at, final, p: Promise<[{name, t}]>}
    this.msgs = new Map();     // file name -> parsed message (null: not one we read)
    this.flights = [];
    this.fixes = [];
    this.drops = [];
    this.frameT = Date.now();
    this.span = [Date.now(), Date.now()];
    this.live = true;
    this.gen = 0;
    this.status = '';
    this.build();
    onStyle(() => { this.legend(); this.render(); this.list(); });   // intensity colours / units
    setInterval(() => { if (this.st.on && this.live && !document.hidden) this.load(); }, 2 * 60e3);
  }

  /** Add the layers once the map's style has loaded (again after a style change). */
  attach() {
    if (!this.map) return;
    addReconLayers(this.map, { font: this.font, before: this.before });
    if (!this.hoverBound) this.bindHover();
    this.render();
  }

  build() {
    const st = this.st;
    const chip = (attr, v, text, tip, dot) => `<button type="button" data-${attr}="${v}" title="${esc(tip)}">${dot ? `<i style="background:${dot}"></i>` : ''}${esc(text)}</button>`;
    this.el.innerHTML = `
      <label class="row check card-head" title="Flight-level and SFMR observations, center fixes and dropsondes of the NOAA and Air Force Reserve Hurricane Hunter aircraft (NHC's recon archive), following the shown frame's time"><input type="checkbox" data-k="on"> Hurricane Hunters (recon)</label>
      <div class="rc-tools">
        <div class="row rc-chips"><span>Aircraft</span><span class="chips small">
          ${chip('a', 'noaa', 'NOAA', 'NOAA Aircraft Operations Center: P-3 Orions N42RF “Kermit”, N43RF “Miss Piggy”, G-IV N49RF “Gonzo”', AGENCY.noaa.color)}
          ${chip('a', 'af', 'Air Force Reserve', '53rd Weather Reconnaissance Squadron (Air Force Reserve), WC-130J', AGENCY.af.color)}</span></div>
        <div class="row rc-chips"><span>Basins</span><span class="chips small">${BASINS.map((b) => chip('b', b.id, b.short, b.name)).join('')}</span></div>
        <label class="row" title="Observations in this many hours before the shown frame's time">Trail <select data-k="hours">
          ${[1, 3, 6, 12, 24, 48, 96].map((h) => `<option value="${h}">${h} h</option>`).join('')}</select></label>
        <label class="row" title="Colour of the flight track and the observation dots">Colour by <select data-k="color">
          ${Object.entries(VARS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select></label>
        <div class="row rc-chips"><span>Show</span><span class="chips small">
          ${chip('t', 'line', 'Track', 'The flight track, coloured like the observations')}
          ${chip('t', 'pts', 'Obs', 'A dot at every 30-s observation')}
          ${chip('t', 'barbs', 'Wind barbs', 'Flight-level wind barbs (thinned where they would overlap)')}
          ${chip('t', 'plane', 'Aircraft', 'Each aircraft at its latest observation, pointing where it flies')}
          ${chip('t', 'vdm', 'Center fixes', 'Vortex data messages: the storm center with its minimum pressure')}
          ${chip('t', 'drops', 'Dropsondes', 'Dropsonde splash points with surface pressure and wind')}
          ${chip('t', 'labels', 'Labels', 'Pressure / wind labels on fixes and dropsondes')}</span></div>
        <label class="row check" title="Show flight-level, SFMR and temperature values that the aircraft's quality control marks as suspect (hidden by default)"><input type="checkbox" data-k="flagged"> Include flagged (suspect) values</label>
        <div class="mt-legend rc-legend"></div>
        <div class="rc-status"></div>
        <div class="storm-list rc-list"></div>
        <div class="note">NHC recon archive: HDOB (30-s flight-level and SFMR data), vortex data messages and dropsondes of NOAA AOC and the Air Force Reserve 53rd WRS. Times follow the map's frame; values are as transmitted (preliminary).</div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.tools = q('.rc-tools');
    const on = q('[data-k=on]');
    on.checked = st.on;
    on.onchange = () => { st.on = on.checked; this.changed(); this.show(); if (st.on) this.load(); };
    for (const b of this.el.querySelectorAll('[data-a]')) b.onclick = () => { st[b.dataset.a] = !st[b.dataset.a]; this.changed(); this.rebuild(); };
    for (const b of this.el.querySelectorAll('[data-b]')) {
      b.onclick = () => {
        const i = st.basins.indexOf(b.dataset.b);
        if (i >= 0) st.basins.splice(i, 1); else st.basins.push(b.dataset.b);
        this.changed(); this.load();
      };
    }
    for (const b of this.el.querySelectorAll('[data-t]')) b.onclick = () => { st[b.dataset.t] = !st[b.dataset.t]; this.changed(); this.render(); };
    const sel = (k, fn) => { const s = q(`[data-k=${k}]`); s.value = String(st[k]); if (s.value !== String(st[k])) s.value = st[k] = DEFAULTS[k]; s.onchange = () => { st[k] = k === 'hours' ? +s.value : s.value; this.changed(); fn(); }; };
    sel('hours', () => this.load());
    sel('color', () => { this.render(); this.legend(); });
    const fl = q('[data-k=flagged]');
    fl.checked = st.flagged;
    fl.onchange = () => { st.flagged = fl.checked; this.changed(); this.render(); this.list(); };
    this.sync();
  }

  changed() { this.sync(); this.onChange(this.st); }

  sync() {
    const st = this.st;
    this.tools.classList.toggle('hidden', !st.on);
    for (const b of this.el.querySelectorAll('[data-a]')) b.classList.toggle('on', !!st[b.dataset.a]);
    for (const b of this.el.querySelectorAll('[data-b]')) b.classList.toggle('on', st.basins.includes(b.dataset.b));
    for (const b of this.el.querySelectorAll('[data-t]')) b.classList.toggle('on', !!st[b.dataset.t]);
    this.legend();
    this.showStatus();
  }

  show() {
    if (!this.map) return;
    for (const id of LAYERS) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', this.st.on ? 'visible' : 'none');
    if (!this.st.on) this.tip?.classList.add('hidden');
    this.render();
  }

  legend() {
    const st = this.st, v = VARS[st.color], el = this.el.querySelector('.rc-legend');
    const sw = (c, t) => `<span><i style="background:${c}"></i>${esc(t)}</span>`;
    let h;
    if (v.wind) h = `<div class="mt-leg"><b>Wind</b>${CATS.map((c) => sw(c.color, c.id === 'td' ? `<${fmtWind(34)}` : c.label.replace('Storm', 'TS'))).join('')}</div>`;
    else if (v.pres) h = `<div class="mt-leg"><b>hPa</b>${PBINS.map((b) => sw(b.color, b.label)).join('')}</div>`;
    else if (v.ramp) h = `<div class="mt-leg rc-ramp"><b>${esc(v.unit)}</b><span>${v.lo}</span><em style="background:linear-gradient(90deg,${v.ramp.join(',')})"></em><span>${v.hi}</span></div>`;
    else h = `<div class="mt-leg">${Object.values(AGENCY).map((a) => sw(a.color, a.name)).join('')}</div>`;
    el.innerHTML = h;
  }

  showStatus() {
    const el = this.el.querySelector('.rc-status');
    if (!this.proxy) { el.innerHTML = '<div class="mt-st proxy">Needs the data proxy (desktop app, Cloudflare deployment or tools/serve.py): NHC\'s archive sends no CORS headers.</div>'; return; }
    el.innerHTML = this.status ? `<div class="mt-st ${this.statusKind || ''}">${esc(this.status)}</div>` : '';
  }

  setStatus(text, kind = '') { this.status = text; this.statusKind = kind; this.showStatus(); }

  /** The frame on screen (ms), the loop's first and last frame times, live or archive. */
  setTime(t, { start = t, end = t, live = false } = {}) {
    const span = [Math.min(start, t), Math.max(end, t)];
    const grew = span[0] < this.span[0] - 60e3 || span[1] > this.span[1] + 60e3 || live !== this.live;
    Object.assign(this, { frameT: t, span, live });
    if (grew && this.st.on) this.load(); else this.applyTime();
  }

  /** End of the trail: the frame's time, or now on the newest frame of a live loop. */
  endT() { return this.live && this.frameT >= this.span[1] - 60e3 ? Math.max(this.frameT, Date.now()) : this.frameT; }

  /** List and fetch the messages of the loop's span (plus the trail), then draw. */
  async load() {
    const st = this.st;
    if (!st.on) return;
    if (!this.proxy) { this.showStatus(); return; }
    const gen = ++this.gen;
    const t1 = this.live ? Math.max(this.span[1], Date.now()) : this.span[1] + 30 * 60e3;
    const t0 = Math.max(this.span[0] - st.hours * H, t1 - MAX_SPAN);
    const folders = BASINS.filter((b) => st.basins.includes(b.id)).flatMap((b) => [b.hdob, b.vdm, b.drop].map((f) => ({ f, basin: b.id })));
    const days = [];
    for (let d = dayStart(t0); d <= t1; d += DAY) days.push(d);
    this.setStatus('Listing messages…', 'loading');
    try {
      const lists = await Promise.all(folders.flatMap(({ f, basin }) => days.map(async (d) => (await this.listing(f, d)).map((x) => ({ ...x, basin })))));
      if (gen !== this.gen) return;
      // an HDOB file holds the 10 minutes before its time; a VDM / drop is sent soon after
      const want = lists.flat().filter((x) => x.t >= t0 && x.t <= t1 + 20 * 60e3);
      const todo = want.filter((x) => !this.msgs.has(x.name));
      let done = 0, failed = 0;
      if (todo.length) this.setStatus(`Loading ${todo.length} messages…`, 'loading');
      await eachLimit(todo, 8, async (x) => {
        if (gen !== this.gen) return;
        try {
          const txt = await getText(`${ARCHIVE}/${new Date(x.t).getUTCFullYear()}/${x.folder}/${x.name}`, this.proxy);
          const m = !txt ? null : x.folder.startsWith('AHO') ? parseHdob(txt, x.t) : x.folder.endsWith('2') ? parseVdm(txt, x.t) : parseDrop(txt, x.t);
          if (m) m.basin = x.basin;
          this.msgs.set(x.name, m);
        } catch (e) { failed++; console.warn('recon', x.name, e); }
        if (++done % 25 === 0 && gen === this.gen) { this.setStatus(`Loading messages… ${done} / ${todo.length}`, 'loading'); this.rebuild(); }
      });
      if (gen !== this.gen) return;
      this.rebuild();
      const n = this.flights.length;
      this.setStatus(failed ? `${failed} message${failed === 1 ? '' : 's'} could not be read; retrying on the next refresh.` : n || this.fixes.length || this.drops.length ? '' :
        `No recon flights in the ${st.hours} h before this time.`, failed ? 'error' : '');
    } catch (e) {
      if (gen !== this.gen) return;
      console.warn('recon', e);
      this.setStatus(`Recon data unavailable (${e.message})`, 'error');
    }
  }

  /** Files of one product folder on one UTC day: [{name, folder, t}]. Past days are kept. */
  listing(folder, day) {
    const key = `${folder}/${day}`, now = Date.now(), hit = this.lists.get(key);
    if (hit && (hit.final || now - hit.at < 90e3)) return hit.p;
    const url = `${ARCHIVE}/${new Date(day).getUTCFullYear()}/${folder}/?P=*.${ymd(day)}*`;
    const p = getText(url, this.proxy).then((html) => {
      if (!html) return [];
      const out = [];
      for (const m of html.matchAll(/href="([A-Z0-9]+-K[A-Z]{3}\.(\d{12})\.txt)"/g)) out.push({ name: m[1], folder, t: fileTime(m[2]) });
      return out;
    });
    const entry = { at: now, final: day + DAY < now - 3 * H, p };
    this.lists.set(key, entry);
    p.catch(() => { if (this.lists.get(key) === entry) this.lists.delete(key); });
    return p;
  }

  /** Messages -> flights (one per aircraft and mission, split at 2-h gaps), fixes, drops. */
  rebuild() {
    const st = this.st, basins = new Set(st.basins);
    const by = new Map(), fixes = [], drops = [], seenDrop = new Set();
    for (const m of this.msgs.values()) {
      if (!m || !basins.has(m.basin) || !st[agencyOf(m.ac)]) continue;
      if (m.kind === 'hdob') {
        const key = `${m.ac}|${m.mission}`;
        if (!by.has(key)) by.set(key, { ac: m.ac, mission: m.mission, storm: m.storm, basin: m.basin, obs: [] });
        const f = by.get(key);
        if (!f.storm && m.storm) f.storm = m.storm;
        f.obs.push(...m.obs);
      } else if (m.kind === 'vdm') fixes.push(m);
      else if (m.kind === 'drop') {
        const k = `${m.ac}|${m.mission}|${m.ob}|${m.t}`;
        if (!seenDrop.has(k)) { seenDrop.add(k); drops.push(m); }
      }
    }
    const flights = [];
    for (const f of by.values()) {
      f.obs.sort((a, b) => a.t - b.t);
      let cur = null;
      for (const o of f.obs) {
        if (cur && o.t === cur.obs[cur.obs.length - 1].t) continue;   // repeated in two messages
        if (!cur || o.t - cur.obs[cur.obs.length - 1].t > 2 * H) {
          cur = { ...f, obs: [], agency: agencyOf(f.ac) };
          flights.push(cur);
        }
        cur.obs.push(o);
      }
    }
    flights.forEach((f, i) => { f.i = i; f.id = `${f.ac}-${f.mission}-${f.obs[0].t}`; });
    Object.assign(this, { flights, fixes: fixes.sort((a, b) => a.t - b.t), drops: drops.sort((a, b) => a.t - b.t) });
    this.render();
  }

  /** An observation's value, with the values its quality flags mark as suspect left out. */
  value(o, key = this.st.color) {
    const v = VARS[key].get(o);
    if (v == null || this.st.flagged) return v;
    const q = o.qm;
    if ((key === 'fl' || key === 'peak') && [2, 4, 6, 9].includes(q)) return null;
    if ((key === 'sfmr' || key === 'rain') && [3, 5, 6, 9].includes(q)) return null;
    if ((key === 'temp' || key === 'dew') && [1, 4, 5, 9].includes(q)) return null;
    return v;
  }

  colorOf(o, f) {
    const key = this.st.color, v = VARS[key];
    if (key === 'agency') return AGENCY[f.agency].color;
    const x = this.value(o);
    if (x == null) return NODATA;
    if (v.wind) return category(x).color;
    if (v.pres) return PBINS.find((b) => x >= b.min).color;
    return rampColor(v.ramp, (x - v.lo) / (v.hi - v.lo));
  }

  /** Features of everything loaded; the frame's time window is a layer filter (applyTime). */
  render() {
    const map = this.map;
    if (!map || !map.getSource('recon')) return;
    const st = this.st, feats = [];
    if (st.on) {
      const F = (props, geometry) => feats.push({ type: 'Feature', properties: props, geometry });
      for (const f of this.flights) {
        const ref = f.obs[f.obs.length - 1].lon, x = (lon) => { while (lon - ref > 180) lon -= 360; while (lon - ref < -180) lon += 360; return lon; };
        let prev = null;
        f.obs.forEach((o, i) => {
          const c = this.colorOf(o, f), pt = [x(o.lon), o.lat];
          if (st.line && prev && o.t - prev.o.t <= 3 * 60e3) F({ k: 'seg', t: o.t, c, f: f.i, i }, { type: 'LineString', coordinates: [prev.pt, pt] });
          if (st.pts || st.barbs) {
            const p = { k: st.pts ? 'ob' : 'obx', t: o.t, c, f: f.i, i };
            const ws = this.value(o, 'fl');
            if (st.barbs && ws != null && o.wd != null) {
              const n = ws < 3 ? 0 : Math.round(ws / 5) * 5, id = `rc-b${n}`;
              if (!map.hasImage(id)) map.addImage(id, barbIcon(n), { pixelRatio: 2 });
              Object.assign(p, { b: id, d: o.wd });
            }
            F(p, { type: 'Point', coordinates: pt });
          }
          prev = { o, pt };
        });
      }
      if (st.vdm) {
        this.fixes.forEach((v, i) => F({ k: 'vdm', t: v.t, i, label: st.labels ? `${v.mslp ? `${v.mslp} mb` : 'Fix'}\n${hm(v.t)}` : '' }, { type: 'Point', coordinates: [v.lon, v.lat] }));
      }
      if (st.drops) {
        this.drops.forEach((d, i) => F({ k: 'drop', t: d.t, i, label: st.labels ? [d.p ? `${d.p} mb` : '', d.ws != null ? fmtWind(d.ws) : ''].filter(Boolean).join(' · ') : '' },
          { type: 'Point', coordinates: [d.lon, d.lat] }));
      }
    }
    map.getSource('recon').setData({ type: 'FeatureCollection', features: feats });
    // barbs read the dots' features: without dots they use the hidden 'obx' kind
    if (map.getLayer('recon-barb')) map.setFilter('recon-barb', ['all', ['in', ['get', 'k'], ['literal', ['ob', 'obx']]], ['has', 'b'], this.timeFilter()]);
    this.applyTime();
  }

  timeFilter() {
    const t1 = this.endT(), t0 = t1 - this.st.hours * H;
    return ['all', ['>=', ['get', 't'], t0], ['<=', ['get', 't'], t1]];
  }

  /** Show the trail before the frame's time; place each aircraft at its latest observation. */
  applyTime() {
    const map = this.map;
    if (!map || !map.getSource('recon')) return;
    const tf = this.timeFilter(), k = (v) => ['==', ['get', 'k'], v];
    const set = (id, f) => { if (map.getLayer(id)) map.setFilter(id, f); };
    set('recon-seg', ['all', k('seg'), tf]);
    set('recon-ob', ['all', k('ob'), tf]);
    set('recon-barb', ['all', ['in', ['get', 'k'], ['literal', ['ob', 'obx']]], ['has', 'b'], tf]);
    set('recon-vdm', ['all', k('vdm'), tf]);
    set('recon-drop', ['all', k('drop'), tf]);
    const st = this.st, t1 = this.endT(), t0 = t1 - st.hours * H, planes = [];
    this.active = [];
    if (st.on) {
      for (const f of this.flights) {
        let j = -1;
        for (let i = f.obs.length - 1; i >= 0; i--) if (f.obs[i].t <= t1) { j = i; break; }
        if (j < 0 || f.obs[j].t < t0) continue;
        this.active.push({ f, j });
        // the aircraft only while it is still flying (an observation within 20 minutes)
        if (!st.plane || t1 - f.obs[j].t > 20 * 60e3) continue;
        const o = f.obs[j], p = f.obs[Math.max(0, j - 2)];
        const h = Math.atan2((o.lon - p.lon) * Math.cos(o.lat * Math.PI / 180), o.lat - p.lat) * 180 / Math.PI;
        const ws = this.value(o, 'fl'), sf = this.value(o, 'sfmr');
        const lines = [f.ac + (f.storm ? ` · ${f.storm}` : ''), [ws != null ? `FL ${fmtWind(ws)}` : '', sf != null ? `SFMR ${fmtWind(sf)}` : ''].filter(Boolean).join(' · '),
          o.xp != null ? `${o.xp.toFixed(1)} hPa` : ''].filter(Boolean);
        planes.push({ type: 'Feature', properties: { icon: `rc-plane-${f.agency}`, h: isFinite(h) && j > 0 ? h : 0, label: st.labels ? lines.join('\n') : f.ac, f: f.i },
          geometry: { type: 'Point', coordinates: [o.lon, o.lat] } });
      }
    }
    map.getSource('recon-now').setData({ type: 'FeatureCollection', features: planes });
    this.list();
  }

  /** The flights in the shown window, with their peaks; a click flies to the aircraft. */
  list() {
    const el = this.el.querySelector('.rc-list');
    el.innerHTML = '';
    if (!this.st.on || !this.active) return;
    const t1 = this.endT(), t0 = t1 - this.st.hours * H;
    for (const { f, j } of this.active) {
      const obs = f.obs.filter((o) => o.t >= t0 && o.t <= t1);
      const max = (k) => obs.reduce((m, o) => { const v = this.value(o, k); return v != null && (m == null || v > m) ? v : m; }, null);
      const minP = obs.reduce((m, o) => (o.xp != null && o.xp > 850 && (m == null || o.xp < m) ? o.xp : m), null);
      const fl = max('fl'), sf = max('sfmr');
      const b = document.createElement('button');
      b.className = 'storm';
      b.innerHTML = `<i style="background:${AGENCY[f.agency].color}"></i><span><b></b><small></small></span>`;
      b.querySelector('b').textContent = `${planeName(f.ac)}${f.storm ? ` · ${f.storm}` : ''}`;
      b.querySelector('small').textContent = [`${hm(obs[0]?.t ?? f.obs[j].t)}–${hm(f.obs[j].t)}`, fl != null ? `max FL ${fmtWind(fl)}` : '', sf != null ? `SFMR ${fmtWind(sf)}` : '',
        minP != null ? `min ${minP.toFixed(1)} hPa` : ''].filter(Boolean).join(' · ');
      b.title = `${AGENCY[f.agency].long}, mission ${f.mission}`;
      b.onclick = () => { const o = f.obs[j]; if (this.fly) this.fly(o.lon, o.lat); };
      el.appendChild(b);
    }
    if (this.fixes.length || this.drops.length) {
      const nf = this.fixes.filter((v) => v.t >= t0 && v.t <= t1).length, nd = this.drops.filter((d) => d.t >= t0 && d.t <= t1).length;
      if (nf || nd) { const d = document.createElement('div'); d.className = 'note'; d.textContent = `${nf} center fix${nf === 1 ? '' : 'es'} · ${nd} dropsonde${nd === 1 ? '' : 's'} in this window`; el.appendChild(d); }
    }
  }

  // hover (or tap): an observation's values, a fix or a dropsonde
  bindHover() {
    const map = this.map, box = document.createElement('div');
    box.className = 'mt-tip rc-tip hidden';
    map.getContainer().appendChild(box);
    this.hoverBound = true;
    this.tip = box;
    const show = (e) => {
      if (!this.st.on) return false;
      const layers = ['recon-plane', 'recon-vdm', 'recon-drop', 'recon-ob', 'recon-barb', 'recon-seg'].filter((id) => map.getLayer(id));
      const p = e.point, feat = map.queryRenderedFeatures([[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]], { layers })[0];
      if (!feat) { box.classList.add('hidden'); return false; }
      const q = feat.properties;
      let h = '';
      if (feat.layer.id === 'recon-vdm') h = this.fixTip(this.fixes[q.i]);
      else if (feat.layer.id === 'recon-drop') h = this.dropTip(this.drops[q.i]);
      else {
        const f = this.flights[q.f];
        if (!f) return false;
        const a = this.active.find((x) => x.f === f);
        const o = feat.layer.id === 'recon-plane' ? a && f.obs[a.j] : f.obs[q.i];
        if (!o) return false;
        h = this.obTip(f, o);
      }
      box.innerHTML = h;
      box.style.left = `${Math.min(p.x + 14, map.getContainer().clientWidth - 250)}px`;
      box.style.top = `${Math.max(4, Math.min(p.y - 10, map.getContainer().clientHeight - 200))}px`;
      box.classList.remove('hidden');
      return true;
    };
    map.on('mousemove', (e) => { if (e.originalEvent?.buttons) return; show(e); });
    map.on('click', (e) => { if (show(e)) { clearTimeout(this.tipT); this.tipT = setTimeout(() => box.classList.add('hidden'), 6000); } });
    map.getCanvasContainer().addEventListener('mouseleave', () => box.classList.add('hidden'));
  }

  obTip(f, o) {
    const flag = (k) => (this.value(o, k) == null && VARS[k].get(o) != null ? ' <span class="rc-flag">flagged</span>' : '');
    const w = (v) => (v == null ? '—' : fmtWind(v));
    const ll = `${Math.abs(o.lat).toFixed(2)}°${o.lat < 0 ? 'S' : 'N'} ${Math.abs(o.lon).toFixed(2)}°${o.lon < 0 ? 'W' : 'E'}`;
    const rows = [
      `<b style="color:${AGENCY[f.agency].color}">${esc(planeName(f.ac))}</b>${f.storm ? ` · ${esc(f.storm)}` : ''}`,
      `<span>${dhm(o.t).replace(/Z$/, '')}:${p2(new Date(o.t).getUTCSeconds())}Z · ${ll}</span>`,
      `Flight level ${o.p != null ? `${o.p.toFixed(1)} hPa` : '—'} · ${o.z != null ? `${o.z} m` : '—'}`,
      o.xp != null ? `Extrap. surface pressure <b>${o.xp.toFixed(1)} hPa</b>` : o.dv != null ? `D-value ${o.dv} m` : '',
      `Temp ${fmtNum(o.T, 1)} °C · dew pt ${fmtNum(o.Td, 1)} °C${flag('temp')}`,
      `FL wind <b>${o.wd != null ? `${p2(o.wd).padStart(3, '0')}° ` : ''}${w(o.ws)}</b>${flag('fl')} · peak ${w(o.fl)}`,
      `SFMR <b>${w(o.sfmr)}</b>${flag('sfmr')} · rain ${o.rain != null ? `${o.rain} mm/h` : '—'}`,
      `<span>Mission ${esc(f.mission)}</span>`,
    ];
    return rows.filter(Boolean).join('<br>');
  }

  fixTip(v) {
    if (!v) return '';
    const w = (x) => (x == null ? null : fmtWind(x));
    return [
      `<b style="color:#ffe066">Center fix</b> ${esc(v.id)}${v.storm ? ` · ${esc(v.storm)}` : ''}`,
      `<span>${dhm(v.t)} · ${esc(planeName(v.ac))}</span>`,
      v.mslp ? `Minimum pressure <b>${v.mslp} hPa</b>` : '',
      v.level ? `Fix level ${esc(v.level)}` : '',
      v.eye ? `Eye ${esc(v.eye)}${v.shape ? ` · ${esc(v.shape)}` : ''}` : '',
      [w(v.flIn) && `max FL wind in ${w(v.flIn)}`, w(v.flOut) && `out ${w(v.flOut)}`].filter(Boolean).join(' · '),
      [w(v.sfcIn) && `est. surface in ${w(v.sfcIn)}`, w(v.sfcOut) && `out ${w(v.sfcOut)}`].filter(Boolean).join(' · '),
      v.maxfl ? `Max FL wind ${fmtWind(v.maxfl.kt)} (${v.maxfl.brg}° / ${v.maxfl.nm} nm)` : '',
    ].filter(Boolean).join('<br>');
  }

  dropTip(d) {
    if (!d) return '';
    const w = (x) => (x ? `${p2(x.wd).padStart(3, '0')}° ${fmtWind(x.ws)}` : '—');
    return [
      `<b style="color:#9be7ff">Dropsonde</b>${d.storm ? ` · ${esc(d.storm)}` : ''}${d.eye ? ' · eye' : d.eyewall ? ' · eyewall' : ''}`,
      `<span>${dhm(d.t)} · ${esc(planeName(d.ac))}</span>`,
      `Surface pressure <b>${d.p ? `${d.p} hPa` : '—'}</b>`,
      `Surface wind <b>${d.ws != null ? w({ wd: d.wd, ws: d.ws }) : '—'}</b>`,
      `Lowest 500 m mean ${w(d.mbl)} · lowest 150 m ${w(d.wl150)}`,
      `<span>${d.splash ? 'Splash point' : 'Release point'}</span>`,
    ].join('<br>');
  }
}
