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

// intensity classes by 1-minute sustained wind (kt), Saffir-Simpson above 64 kt
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

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
const last = { glm: emptyFC(), storms: emptyFC() };   // re-applied after a style change

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
export function addLayers(map, { font = ['Noto Sans Regular'], before } = {}) {
  for (const cat of CATS) {
    for (const s of [false, true]) {
      const id = `tc-${cat.id}${s ? '-s' : ''}`;
      if (!map.hasImage(id)) map.addImage(id, tcIcon(cat.color, s), { pixelRatio: 2 });
    }
  }
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
  // cyclones: NHC cone, past / forecast tracks, track points, the current position
  L({ id: 'storm-cone', type: 'fill', source: 'storms', filter: k('cone'), paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.08 } });
  L({ id: 'storm-cone-line', type: 'line', source: 'storms', filter: k('cone'),
    paint: { 'line-color': 'rgba(255,255,255,0.6)', 'line-width': 1, 'line-dasharray': [2, 2] } });
  L({ id: 'storm-past', type: 'line', source: 'storms', filter: k('past'), layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#d7dfec', 'line-width': 1.7, 'line-opacity': 0.75 } });
  L({ id: 'storm-fcst', type: 'line', source: 'storms', filter: k('fcst'), layout: { 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [2.4, 1.8] } });
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
}

/** Show or hide one overlay ('glm' | 'storms'). */
export function showLayers(map, which, on) {
  const ids = which === 'glm' ? ['glm-glow', 'glm'] : ['storm-cone', 'storm-cone-line', 'storm-past', 'storm-fcst', 'storm-pts', 'storm-fpt-labels', 'storm-now'];
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
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
    if (past.length) F({ k: 'past', id: s.id }, { type: 'LineString', coordinates: [...past.map(pt), pt({ lon: s.now[0], lat: s.now[1] })] });
    if (s.fcst.length > 1) F({ k: 'fcst', id: s.id }, { type: 'LineString', coordinates: s.fcst.map(pt) });
    for (const p of past) F({ k: 'ppt', id: s.id, c: category(p.kt).color }, { type: 'Point', coordinates: pt(p) });
    for (const p of s.fcst.slice(1)) F({ k: 'fpt', id: s.id, c: category(p.kt).color, t: `${label(p.t)} · ${p.kt} kt` }, { type: 'Point', coordinates: pt(p) });
    const cat = category(s.kt);
    F({ k: 'now', id: s.id, icon: `tc-${cat.id}${south ? '-s' : ''}`, label: `${s.name.replace(/ \(\w+\)$/, '')}\n${s.kt} kt${s.mb ? ` · ${s.mb} mb` : ''}` },
      { type: 'Point', coordinates: [ref, s.now[1]] });
  }
  return { type: 'FeatureCollection', features: feats };
}

export function setStorms(map, fc) {
  last.storms = fc || emptyFC();
  const s = map.getSource('storms');
  if (s) s.setData(last.storms);
}
