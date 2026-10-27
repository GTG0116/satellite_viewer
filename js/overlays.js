/* Weather overlays: GOES GLM lightning flashes and active tropical cyclones, drawn as GeoJSON
 * layers on a MapLibre or Mapbox GL map (the same file serves both editions).
 *
 * Cyclones come from the agencies' own products, both readable from the browser (CORS):
 *   NHC   Atlantic, East and Central Pacific: NOAA's tropical map service (forecast points,
 *         cone, past points of the current advisories)
 *   JTWC  West Pacific, Indian Ocean, Southern Hemisphere: the warning feed, then each storm's
 *         JMV 3.0 track file (forecast + past positions) or, without one, its warning text.
 * JTWC also warns on East / Central Pacific storms; those come from NHC alone.
 */

const NHC = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const JTWC = 'https://www.metoc.navy.mil/jtwc';

// intensity classes by 1-minute sustained wind (kt), Saffir-Simpson above 64 kt. The colours are
// the user's (setCatColors): the storms, model tracks, intensity charts and recon all read them here.
export const CATS = [
  { id: 'td', max: 34, label: 'Depression', color: '#73c2ff' },
  { id: 'ts', max: 64, label: 'Storm', color: '#38e0c8' },
  { id: 'c1', max: 83, label: 'Cat 1', color: '#ffe680' },
  { id: 'c2', max: 96, label: 'Cat 2', color: '#ffc44d' },
  { id: 'c3', max: 113, label: 'Cat 3', color: '#ff9638' },
  { id: 'c4', max: 137, label: 'Cat 4', color: '#ff5a3a' },
  { id: 'c5', max: Infinity, label: 'Cat 5', color: '#f04cff' },
];
export const category = (kt) => CATS.find((c) => (+kt || 0) < c.max);

// intensity colour tables (td, ts, c1 ... c5)
export const CAT_PRESETS = {
  default: { name: 'Default', colors: ['#73c2ff', '#38e0c8', '#ffe680', '#ffc44d', '#ff9638', '#ff5a3a', '#f04cff'] },
  saffir: { name: 'Saffir-Simpson (classic)', colors: ['#5ebaff', '#00faf4', '#ffffcc', '#ffe775', '#ffc140', '#ff8f20', '#ff6060'] },
  unisys: { name: 'Best-track maps (green to white)', colors: ['#3cdc3c', '#ffff3c', '#ff2a2a', '#ff8080', '#ff3cff', '#ff9cff', '#ffffff'] },
  heat: { name: 'Heat (yellow to purple)', colors: ['#9fb4cc', '#ffe066', '#ffb300', '#ff7a00', '#f03b20', '#c2185b', '#7b1fa2'] },
  cb: { name: 'Colour-blind safe', colors: ['#7fb3ff', '#4dd0e1', '#ffe066', '#ffb000', '#fe6100', '#dc267f', '#9d6bff'] },
  reds: { name: 'Light to dark red', colors: ['#c7d0dc', '#fde0dd', '#fcbba1', '#fc9272', '#fb6a4a', '#de2d26', '#a50f15'] },
};
export const CAT_DEFAULT = CAT_PRESETS.default.colors.slice();

// how the agencies' storms are drawn (setStormStyle)
export const STORM_STYLE = {
  coneColor: '#ffffff', coneOpacity: 0.08, coneLine: true,
  pastColor: '#d7dfec', pastWidth: 1.7, pastByCat: false, pastPts: true,
  fcstColor: '#ffffff', fcstWidth: 1.5, fcstDash: true, fcstByCat: false, fcstPts: true,
  ptScale: 1, iconScale: 1, fptLabels: true, nameLabels: true, labelSize: 11.5, units: 'kt',
};
const style = { ...STORM_STYLE };

// wind speeds in the chosen unit (labels, lists, tooltips)
const UNITS = { kt: [1, 'kt'], mph: [1.15078, 'mph'], kmh: [1.852, 'km/h'], ms: [0.514444, 'm/s'] };
export const unitLabel = (u = style.units) => (UNITS[u] || UNITS.kt)[1];
export function fmtWind(kt, u = style.units) {
  if (kt == null || !isFinite(kt)) return '—';
  const [f, name] = UNITS[u] || UNITS.kt;
  return `${Math.round(kt * f)} ${name}`;
}

// told when the colours or the style change (model tracks, charts, recon, panels)
const listeners = new Set();
export function onStyle(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } };

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
const last = { glm: emptyFC(), storms: emptyFC(), list: null, map: null };   // re-applied after a style change

// ------------------------------------------------------------------ map layers
/** Cyclone symbol (a disc with two curved arms; mirrored in the Southern Hemisphere). */
function tcIcon(color, south, size = 52) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d'), k = size / 26;
  g.translate(size / 2, size / 2);
  g.scale(south ? -k : k, k);
  g.lineJoin = 'round';
  g.lineWidth = 1.3;
  g.strokeStyle = 'rgba(4,8,16,0.85)';
  g.fillStyle = color;
  for (const rot of [0, Math.PI]) {
    g.save();
    g.rotate(rot);
    g.beginPath();
    g.moveTo(-2.5, -5.2);
    g.bezierCurveTo(1, -11.5, 7.5, -11.8, 11, -8.2);
    g.bezierCurveTo(6.5, -9, 3.6, -6.4, 3.2, -2.2);
    g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }
  g.beginPath(); g.arc(0, 0, 5.6, 0, Math.PI * 2); g.fill(); g.stroke();
  g.beginPath(); g.arc(0, 0, 2.1, 0, Math.PI * 2); g.fillStyle = 'rgba(8,13,24,0.92)'; g.fill();
  return g.getImageData(0, 0, size, size);
}

/** Add the overlay sources / layers (again after a style change), under `before` if given.
 *  font: a text-font stack the map's glyphs serve. */
function addIcons(map, replace = false) {
  for (const cat of CATS) {
    for (const s of [false, true]) {
      const id = `tc-${cat.id}${s ? '-s' : ''}`;
      if (!map.hasImage(id)) map.addImage(id, tcIcon(cat.color, s), { pixelRatio: 2 });
      else if (replace) map.updateImage(id, tcIcon(cat.color, s));
    }
  }
}

export function addLayers(map, { font = ['Noto Sans Regular'], before } = {}) {
  last.map = map;
  addIcons(map);
  if (map.getSource('storms')) return;
  map.addSource('glm', { type: 'geojson', data: last.glm, buffer: 4, tolerance: 0 });
  map.addSource('storms', { type: 'geojson', data: last.storms });
  const b = before && map.getLayer(before) ? before : undefined;
  const L = (spec) => map.addLayer(spec, b);
  const halo = { 'text-color': '#ffffff', 'text-halo-color': 'rgba(3,6,12,0.9)', 'text-halo-width': 1.4 };
  const k = (v) => ['==', ['get', 'k'], v];
  // lightning: newest flashes white-hot with a glow, cooling to orange / red as they age
  L({ id: 'glm-glow', type: 'circle', source: 'glm', filter: ['<', ['get', 'a'], 0.2],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 6, 7, 10, 11], 'circle-color': '#fff7b0',
      'circle-blur': 1, 'circle-opacity': 0.55 } });
  L({ id: 'glm', type: 'circle', source: 'glm',
    paint: {
      // brighter (more energetic) flashes are bigger; zoom has to be the outermost interpolation
      'circle-radius': ['interpolate', ['linear'], ['zoom'], ...[[1, 1.3], [6, 2.6], [10, 4.2]].flatMap(([z, r]) => [z, ['*', r, ['+', 0.8, ['*', 0.25, ['get', 'e']]]]])],
      'circle-color': ['interpolate', ['linear'], ['get', 'a'], 0, '#ffffff', 0.12, '#fff36b', 0.4, '#ffb12e', 0.75, '#ff6a1f', 1, '#d62d1c'],
      'circle-opacity': ['interpolate', ['linear'], ['get', 'a'], 0, 1, 1, 0.55],
      'circle-stroke-color': 'rgba(30,8,0,0.55)', 'circle-stroke-width': 0.4,
    } });
  // cyclones: NHC cone, past / forecast tracks (one line, or segments coloured by intensity),
  // track points, the current position; colours and sizes then come from applyStyle()
  L({ id: 'storm-cone', type: 'fill', source: 'storms', filter: k('cone'), paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.08 } });
  L({ id: 'storm-cone-line', type: 'line', source: 'storms', filter: k('cone'),
    paint: { 'line-color': 'rgba(255,255,255,0.6)', 'line-width': 1, 'line-dasharray': [2, 2] } });
  L({ id: 'storm-past', type: 'line', source: 'storms', filter: k('past'), layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#d7dfec', 'line-width': 1.7, 'line-opacity': 0.75 } });
  L({ id: 'storm-past-seg', type: 'line', source: 'storms', filter: k('pseg'), layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': 1.7, 'line-opacity': 0.9 } });
  L({ id: 'storm-fcst', type: 'line', source: 'storms', filter: k('fcst'), layout: { 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [2.4, 1.8] } });
  L({ id: 'storm-fcst-seg', type: 'line', source: 'storms', filter: k('fseg'), layout: { 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': 1.5, 'line-dasharray': [2.4, 1.8] } });
  L({ id: 'storm-pts', type: 'circle', source: 'storms', filter: ['in', ['get', 'k'], ['literal', ['ppt', 'fpt']]],
    paint: { 'circle-radius': ['case', k('fpt'), 4.4, 2.8], 'circle-color': ['get', 'c'], 'circle-stroke-color': 'rgba(4,8,16,0.8)', 'circle-stroke-width': 1 } });
  L({ id: 'storm-fpt-labels', type: 'symbol', source: 'storms', filter: k('fpt'), minzoom: 3.2,
    layout: { 'text-field': ['get', 't'], 'text-font': font, 'text-size': 10, 'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-optional': true },
    paint: { ...halo, 'text-color': '#dfe7f3' } });
  L({ id: 'storm-now', type: 'symbol', source: 'storms', filter: k('now'),
    layout: { 'icon-image': ['get', 'icon'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.85, 6, 1.25], 'icon-allow-overlap': true,
      'icon-ignore-placement': true, 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 11.5, 'text-anchor': 'left',
      'text-offset': [1.5, 0], 'text-justify': 'left', 'text-optional': true },
    paint: halo });
  applyStyle(map);
}

const STORM_LAYERS = ['storm-cone', 'storm-cone-line', 'storm-past', 'storm-past-seg', 'storm-fcst', 'storm-fcst-seg', 'storm-pts', 'storm-fpt-labels', 'storm-now'];
let stormsOn = true;

/** '#rrggbb' + alpha -> 'rgba(...)' */
export function hexA(hex, a) {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!h) return hex;
  const n = parseInt(h[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Paint and layout of the storm layers from the style. */
function applyStyle(map) {
  if (!map.getLayer('storm-cone')) return;
  const S = style, k = (v) => ['==', ['get', 'k'], v];
  const paint = (id, p, v) => map.setPaintProperty(id, p, v), layout = (id, p, v) => map.setLayoutProperty(id, p, v);
  paint('storm-cone', 'fill-color', S.coneColor);
  paint('storm-cone', 'fill-opacity', +S.coneOpacity);
  paint('storm-cone-line', 'line-color', hexA(S.coneColor, 0.6));
  paint('storm-past', 'line-color', S.pastColor);
  paint('storm-fcst', 'line-color', S.fcstColor);
  for (const id of ['storm-past', 'storm-past-seg']) paint(id, 'line-width', +S.pastWidth);
  for (const id of ['storm-fcst', 'storm-fcst-seg']) {
    paint(id, 'line-width', +S.fcstWidth);
    paint(id, 'line-dasharray', S.fcstDash ? [2.4, 1.8] : [1, 0]);
  }
  map.setFilter('storm-pts', ['in', ['get', 'k'], ['literal', [S.pastPts && 'ppt', S.fcstPts && 'fpt'].filter(Boolean)]]);
  paint('storm-pts', 'circle-radius', ['case', k('fpt'), 4.4 * S.ptScale, 2.8 * S.ptScale]);
  layout('storm-now', 'icon-size', ['interpolate', ['linear'], ['zoom'], 1, 0.85 * S.iconScale, 6, 1.25 * S.iconScale]);
  layout('storm-now', 'text-size', +S.labelSize);
  layout('storm-now', 'text-field', S.nameLabels ? ['get', 'label'] : '');
  layout('storm-fpt-labels', 'text-size', Math.max(7, S.labelSize - 1.5));
  showStorms(map);
}

/** Visibility of the storm layers: all off, or the line kind (single / by intensity) chosen. */
function showStorms(map) {
  const S = style, on = stormsOn;
  const vis = { 'storm-past': !S.pastByCat, 'storm-past-seg': S.pastByCat, 'storm-fcst': !S.fcstByCat, 'storm-fcst-seg': S.fcstByCat,
    'storm-cone-line': S.coneLine, 'storm-fpt-labels': S.fptLabels && S.fcstPts };
  for (const id of STORM_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on && (vis[id] ?? true) ? 'visible' : 'none');
}

/** Intensity colours: 7 colours (td, ts, c1 ... c5). Redraws the storms, tells the listeners. */
export function setCatColors(colors) {
  const c = Array.isArray(colors) && colors.length === CATS.length ? colors : CAT_DEFAULT;
  CATS.forEach((cat, i) => { cat.color = /^#[0-9a-f]{6}$/i.test(c[i]) ? c[i] : CAT_DEFAULT[i]; });
  if (last.map) { addIcons(last.map, true); restyleStorms(); }
  notify();
}

/** Storm drawing options (keys of STORM_STYLE; others are ignored). */
export function setStormStyle(opts) {
  for (const k of Object.keys(STORM_STYLE)) if (opts && opts[k] !== undefined) style[k] = opts[k];
  if (last.map) { applyStyle(last.map); restyleStorms(); }
  notify();
}

/** Rebuild the storm features (colours, wind units) from the last fetched storms. */
function restyleStorms() {
  if (last.list && last.map) setStorms(last.map, stormsFC(last.list));
}

/** Show or hide one overlay ('glm' | 'storms'). */
export function showLayers(map, which, on) {
  if (which === 'storms') { stormsOn = on; showStorms(map); return; }
  for (const id of ['glm-glow', 'glm']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

// ------------------------------------------------------------------ lightning
/** Flash arrays {lon, lat, age (s before the frame), energy (fJ)} -> the map's 'glm' source.
 *  null clears it. */
export function setGlm(map, d, minutes = 5) {
  const feats = [];
  if (d) {
    const span = Math.max(30, minutes * 60);
    for (let i = 0; i < d.lat.length; i++) {
      const e = d.energy[i];
      feats.push({ type: 'Feature', properties: { a: Math.min(1, d.age[i] / span), e: e > 1 ? Math.min(4, Math.log10(e)) : 0 },
        geometry: { type: 'Point', coordinates: [d.lon[i], d.lat[i]] } });
    }
  }
  last.glm = { type: 'FeatureCollection', features: feats };
  const s = map.getSource('glm');
  if (s) s.setData(last.glm);
  return feats.length;
}

// ------------------------------------------------------------------ cyclones
const title = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const near = (lon, ref) => { while (lon - ref > 180) lon -= 360; while (lon - ref < -180) lon += 360; return lon; };
const p2 = (n) => String(n).padStart(2, '0');
const label = (ms) => { const d = new Date(ms); return `${p2(d.getUTCDate())}/${p2(d.getUTCHours())}Z`; };

async function getJSON(url, signal) {
  const r = await fetch(url, { signal, cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getText(url, signal) {
  const r = await fetch(url, { signal, cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** NHC's active storms: [{id, agency, name, basin, num, kt, mb, now: [lon, lat], t, fcst: [...], past: [...], cone}]. */
async function nhcStorms(signal) {
  const q = (layer) => getJSON(`${NHC}/${layer}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`, signal);
  const [fp, cone, pp] = await Promise.all([q(5), q(7), q(10)]);
  const by = new Map();
  const get = (bin) => by.get(bin) || by.set(bin, { fcst: [], past: [], cone: null }).get(bin);
  for (const f of fp.features || []) {
    const p = f.properties, s = get(p.binnumber);
    const [lon, lat] = f.geometry.coordinates;
    // validtime "DD/HHMM" of the advisory's month (a forecast may run into the next one)
    const now = new Date(), [dd, hm] = String(p.validtime || '').split('/');
    let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +dd, +String(hm).slice(0, 2), +String(hm).slice(2, 4));
    if (t - now.getTime() > 20 * 864e5) t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, +dd, +String(hm).slice(0, 2));
    if (now.getTime() - t > 20 * 864e5) t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, +dd, +String(hm).slice(0, 2));
    s.fcst.push({ lon, lat, kt: p.maxwind, tau: p.tau, t });
    if (p.tau === 0) Object.assign(s, { name: p.stormname, basin: p.basin, num: p.stormnum, kt: p.maxwind, mb: p.mslp < 9000 ? p.mslp : null, t, adv: p.advisnum });
  }
  for (const f of cone.features || []) { const s = by.get(f.properties.binnumber); if (s) s.cone = f.geometry; }
  for (const f of pp.features || []) {
    const p = f.properties, s = by.get(p.binnumber);
    if (!s || !f.geometry) continue;
    const d = String(p.dtg);
    s.past.push({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], kt: p.intensity,
      t: Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10)) });
  }
  const out = [];
  for (const [bin, s] of by) {
    if (!s.name) continue;
    s.fcst.sort((a, b) => a.tau - b.tau);
    s.past.sort((a, b) => a.t - b.t);
    const n0 = s.fcst[0];
    out.push({ id: `${s.basin}${p2(s.num)}`.toLowerCase(), agency: 'NHC', bin, name: s.name, basin: String(s.basin).toUpperCase(), num: s.num,
      kt: s.kt, mb: s.mb, now: [n0.lon, n0.lat], t: s.t, fcst: s.fcst, past: s.past, cone: s.cone, adv: s.adv });
  }
  return out;
}

const ll = (lat, ns, lon, ew, div = 10) => [(+lon / div) * (ew === 'W' ? -1 : 1), (+lat / div) * (ns === 'S' ? -1 : 1)];

/** A JTWC JMV 3.0 track file (.tcw): forecast lines "T012 209N 1255E 120 ..." after a header
 *  "2026102118 29W CHAMPI ...", the warning text, then past positions "2926101700 123N1486E  90". */
function parseTcw(txt, code) {
  const lines = txt.split(/\r?\n/);
  const hdr = lines.map((l) => /^(\d{10}) (\d{2}[A-Z]) (\S+)/.exec(l)).find(Boolean);
  if (!hdr) return null;
  const b = hdr[1], base = Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8), +b.slice(8, 10));
  const fcst = [], past = [], seen = new Set();
  for (const l of lines) {
    let m = /^T(\d{3}) (\d{3})([NS]) (\d{4})([EW]) (\d{3})/.exec(l);
    if (m) { const [lon, lat] = ll(m[2], m[3], m[4], m[5]); fcst.push({ lon, lat, kt: +m[6], tau: +m[1], t: base + +m[1] * 3600e3 }); continue; }
    m = /^\d{2}(\d{2})(\d{2})(\d{2})(\d{2}) +(\d{1,3})([NS]) *(\d{1,4})([EW])\s+(\d+)/.exec(l); // positions may be space-padded
    if (m && !seen.has(m[0])) {
      seen.add(m[0]);
      const [lon, lat] = ll(m[5], m[6], m[7], m[8]);
      past.push({ lon, lat, kt: +m[9], t: Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4]) });
    }
  }
  if (!fcst.length) return null;
  const subj = /SUBJ:?\/?\s*(.+?)\s+WARNING NR\s*(\d+)/.exec(txt);
  return finishJtwc(code, subj ? subj[1] : `${hdr[2]} (${hdr[3]})`, subj ? +subj[2] : null, fcst, past);
}

/** A JTWC warning text: "211200Z --- NEAR 9.5N 99.0W ... MAX SUSTAINED WINDS - 030 KT" for the
 *  warning position, then the same per forecast time (no past track). */
function parseWarning(txt, code) {
  const re = /(\d{2})(\d{2})(\d{2})Z --- (?:NEAR )?(\d+\.\d)([NS]) (\d+\.\d)([EW])[\s\S]*?MAX SUSTAINED WINDS - (\d+) KT/g;
  const now = new Date(), fcst = [];
  for (const m of txt.matchAll(re)) {
    let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +m[1], +m[2], +m[3]);
    if (t - now.getTime() > 20 * 864e5) t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, +m[1], +m[2], +m[3]);
    if (now.getTime() - t > 20 * 864e5) t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, +m[1], +m[2], +m[3]);
    const [lon, lat] = ll(m[4], m[5], m[6], m[7], 1);
    fcst.push({ lon, lat, kt: +m[8], t, tau: fcst.length ? Math.round((t - fcst[0].t) / 3600e3) : 0 });
  }
  if (!fcst.length) return null;
  const subj = /(?:SUBJ\/|\d\.\s+)(.+?)\s+WARNING NR\s*(\d+)/.exec(txt);
  return finishJtwc(code, subj ? subj[1] : code.toUpperCase(), subj ? +subj[2] : null, fcst, []);
}

function finishJtwc(code, subject, adv, fcst, past) {
  // "SUPER TYPHOON 29W (CHAMPI)" -> Super Typhoon Champi (29W)
  const m = /^(.*?)\s*(\d{2}[A-Z])\s*\(([^)]+)\)/.exec(subject.trim());
  const name = m ? `${title(m[1])} ${title(m[3])} (${m[2]})` : title(subject);
  past.sort((a, b) => a.t - b.t);
  const n0 = fcst[0];
  return { id: code.slice(0, 4), agency: 'JTWC', name, basin: code.slice(0, 2).toUpperCase(), num: +code.slice(2, 4),
    kt: n0.kt, mb: null, now: [n0.lon, n0.lat], t: n0.t, fcst, past, cone: null, adv };
}

async function jtwcStorms(signal, skip) {
  const rss = await getText(`${JTWC}/rss/jtwc.rss`, signal);
  const codes = [...new Set([...rss.matchAll(/products\/([a-z]{2}\d{4})web\.txt/g)].map((m) => m[1]))].filter((c) => !skip(c));
  const got = await Promise.all(codes.map(async (code) => {
    try {
      const tcw = await getText(`${JTWC}/products/${code}.tcw`, signal).catch(() => null);
      return (tcw && parseTcw(tcw, code)) || parseWarning(await getText(`${JTWC}/products/${code}web.txt`, signal), code);
    } catch (e) { if (signal?.aborted) throw e; console.warn('JTWC', code, e); return null; }
  }));
  return got.filter(Boolean);
}

/** Active cyclones of both agencies: {storms, fc (GeoJSON for setStorms), errors}. */
export async function fetchStorms({ signal } = {}) {
  const errors = [];
  const nhc = await nhcStorms(signal).catch((e) => { if (signal?.aborted) throw e; errors.push(`NHC: ${e.message}`); return []; });
  const have = new Set(nhc.map((s) => s.id));
  // JTWC codes look like ep2226: basin, number, year; NHC already covers its own basins
  const jt = await jtwcStorms(signal, (c) => have.has(c.slice(0, 4)) || c.startsWith('al'))
    .catch((e) => { if (signal?.aborted) throw e; errors.push(`JTWC: ${e.message}`); return []; });
  const storms = [...nhc, ...jt].sort((a, b) => (b.kt || 0) - (a.kt || 0));
  last.list = storms;
  return { storms, fc: stormsFC(storms), errors };
}

function unwrapRings(geom, ref) {
  const fix = (ring) => ring.map(([x, y]) => [near(x, ref), y]);
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(fix) };
  if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map(fix)) };
  return geom;
}

/** Storms -> GeoJSON: cone, past / forecast lines, track points, current position. Longitudes are
 *  kept continuous around each storm, so tracks crossing the date line stay in one piece. */
export function stormsFC(storms) {
  const feats = [];
  const F = (props, geometry) => feats.push({ type: 'Feature', properties: props, geometry });
  for (const s of storms) {
    const ref = s.now[0], south = s.now[1] < 0;
    const pt = (p) => [near(p.lon, ref), p.lat];
    if (s.cone) F({ k: 'cone', id: s.id }, unwrapRings(s.cone, ref));
    const past = s.past.filter((p) => p.t < s.t);
    const pastLine = [...past, { lon: s.now[0], lat: s.now[1], kt: s.kt }];
    if (past.length) F({ k: 'past', id: s.id }, { type: 'LineString', coordinates: pastLine.map(pt) });
    if (s.fcst.length > 1) F({ k: 'fcst', id: s.id }, { type: 'LineString', coordinates: s.fcst.map(pt) });
    // the same lines as segments, each in the intensity class at its start
    for (let i = 1; i < pastLine.length; i++) F({ k: 'pseg', id: s.id, c: category(pastLine[i - 1].kt).color }, { type: 'LineString', coordinates: [pt(pastLine[i - 1]), pt(pastLine[i])] });
    for (let i = 1; i < s.fcst.length; i++) F({ k: 'fseg', id: s.id, c: category(s.fcst[i - 1].kt).color }, { type: 'LineString', coordinates: [pt(s.fcst[i - 1]), pt(s.fcst[i])] });
    for (const p of past) F({ k: 'ppt', id: s.id, c: category(p.kt).color }, { type: 'Point', coordinates: pt(p) });
    for (const p of s.fcst.slice(1)) F({ k: 'fpt', id: s.id, c: category(p.kt).color, t: `${label(p.t)} · ${fmtWind(p.kt)}` }, { type: 'Point', coordinates: pt(p) });
    const cat = category(s.kt);
    F({ k: 'now', id: s.id, icon: `tc-${cat.id}${south ? '-s' : ''}`, label: `${s.name.replace(/ \(\w+\)$/, '')}\n${fmtWind(s.kt)}${s.mb ? ` · ${s.mb} mb` : ''}` },
      { type: 'Point', coordinates: [ref, s.now[1]] });
  }
  return { type: 'FeatureCollection', features: feats };
}

export function setStorms(map, fc) {
  last.storms = fc || emptyFC();
  const s = map.getSource('storms');
  if (s) s.setData(last.storms);
}
