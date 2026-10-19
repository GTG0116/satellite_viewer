/* MapLibre GL JS map: free OpenFreeMap vector basemap (no token), globe projection, day / night
 * terminator, satellite frames as worker-rendered raster tiles, and 3D terrain built from
 * cloud-top heights (and optionally real ground elevation).
 *
 * Satellite frames use two "ping-pong" raster layers: the next frame's tiles load into the
 * hidden layer and it is revealed (or cross-faded) when ready. GPU memory therefore holds two
 * frames' tiles however long the loop is — the key to smooth loops on low-end devices.
 */
import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';
import { TileRouter } from './tiles/router.js';
import { outline } from './geo.js';

const OFM = 'https://tiles.openfreemap.org';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const HIDDEN = 0.001; // a hidden ping-pong layer: invisible, but MapLibre keeps loading its tiles
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
const THEMES = {
  dark: { bg: '#0d1626', water: '#081a33', land: '#16202f', line: 'rgba(225,236,252,0.62)', state: 'rgba(210,222,240,0.32)', label: '#e9eef6', halo: 'rgba(3,6,12,0.85)', night: '#01030c' },
  light: { bg: '#e8e6e1', water: '#b9cfe4', land: '#ecebe6', line: 'rgba(60,70,90,0.6)', state: 'rgba(60,70,90,0.3)', label: '#22303f', halo: 'rgba(255,255,255,0.85)', night: '#000814' },
  satellite: { bg: '#0b1220', water: 'rgba(0,0,0,0)', land: 'rgba(0,0,0,0)', line: 'rgba(240,246,255,0.7)', state: 'rgba(240,246,255,0.35)', label: '#ffffff', halo: 'rgba(0,0,0,0.8)', night: '#01030c' },
};
const NIGHT_BANDS = [0, -3, -6, -9, -12, -15, -18], NIGHT_ALPHA = 0.095;

function buildStyle(theme, opts) {
  const T = THEMES[theme];
  const font = ['Noto Sans Regular'], fontB = ['Noto Sans Bold'];
  const sources = {
    omt: { type: 'vector', url: `${OFM}/planet`, attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' },
    relief: { type: 'raster', tiles: [`${OFM}/natural_earth/ne2sr/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 6 },
  };
  if (theme === 'satellite') sources.imagery = { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' };
  const layers = [
    { id: 'background', type: 'background', paint: { 'background-color': T.bg } },
  ];
  if (theme === 'satellite') layers.push({ id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 0 } });
  else {
    // the shaded-relief base layer is one more raster to download and draw: skipped on weak devices
    if (!opts.lite) layers.push({ id: 'relief', type: 'raster', source: 'relief', maxzoom: 7, paint: { 'raster-opacity': theme === 'dark' ? 0.32 : 0.55, 'raster-saturation': theme === 'dark' ? -0.6 : -0.2, 'raster-brightness-max': theme === 'dark' ? 0.55 : 1, 'raster-fade-duration': 0 } });
    layers.push({ id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': T.water, 'fill-opacity': theme === 'dark' ? 0.86 : 0.9 } });
  }
  layers.push(
    { id: 'night', type: 'fill', source: 'night', paint: { 'fill-color': T.night, 'fill-opacity': NIGHT_ALPHA, 'fill-antialias': false } },
    // satellite frames go here (ping-pong layers are inserted before 'sat-anchor')
    { id: 'sat-anchor', type: 'background', layout: { visibility: 'none' }, paint: { 'background-color': '#000' } },
    { id: 'hillshade', type: 'hillshade', source: 'dem-ground', layout: { visibility: 'none' },
      paint: { 'hillshade-exaggeration': 0.4, 'hillshade-shadow-color': 'rgba(0,0,0,0.6)', 'hillshade-highlight-color': 'rgba(255,255,255,0.18)', 'hillshade-accent-color': 'rgba(0,0,0,0)' } },
    { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': theme === 'light' ? 'rgba(40,60,90,0.18)' : 'rgba(150,196,255,0.18)', 'line-width': ['case', ['get', 'major'], 1.1, 0.7] } },
    { id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'line-color': T.line, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.45, 6, 0.85, 10, 1.2] } },
    { id: 'boundary-state', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]], minzoom: 2.5,
      paint: { 'line-color': T.state, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.1], 'line-dasharray': [3, 2] } },
    { id: 'boundary-country', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['<=', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1], ['!=', ['get', 'disputed'], 1]],
      paint: { 'line-color': T.line, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 1.2, 10, 1.8] } },
    { id: 'outline', type: 'line', source: 'outline', paint: { 'line-color': ['case', ['get', 'active'], '#4cb5ff', 'rgba(255,214,102,0.8)'], 'line-width': 1.4, 'line-dasharray': [3, 2] } },
    { id: 'drawbox-fill', type: 'fill', source: 'drawbox', paint: { 'fill-color': '#ffb547', 'fill-opacity': 0.08 } },
    { id: 'drawbox-line', type: 'line', source: 'drawbox', paint: { 'line-color': '#ffb547', 'line-width': 1.6 } },
    // 3D volume region, its handles, an area being drawn, and the 3D camera's view
    { id: 'r3dcam-fill', type: 'fill', source: 'r3dcam', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.13 } },
    { id: 'r3dcam-line', type: 'line', source: 'r3dcam', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': 'rgba(255,255,255,0.55)', 'line-width': 1 } },
    { id: 'r3dbox-fill', type: 'fill', source: 'r3dbox', paint: { 'fill-color': '#3ddc97', 'fill-opacity': 0.14 } },
    { id: 'r3dbox-line', type: 'line', source: 'r3dbox', paint: { 'line-color': '#3ddc97', 'line-width': 1.8 } },
    { id: 'r3ddraw-line', type: 'line', source: 'r3ddraw', paint: { 'line-color': '#3ddc97', 'line-width': 1.6, 'line-dasharray': [2, 1.5] } },
    { id: 'r3ddraw-pts', type: 'circle', source: 'r3ddraw', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4.5, 'circle-color': '#0b1220', 'circle-stroke-color': '#3ddc97', 'circle-stroke-width': 2 } },
    { id: 'r3dhandles', type: 'circle', source: 'r3dhandles', paint: { 'circle-radius': ['case', ['==', ['get', 'kind'], 'c'], 7, 6.5], 'circle-color': ['case', ['==', ['get', 'kind'], 'c'], '#3ddc97', '#0b1220'], 'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'c'], '#ffffff', '#3ddc97'], 'circle-stroke-width': 2 } },
    { id: 'r3dcam-pt', type: 'circle', source: 'r3dcam', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7.5, 'circle-color': '#3ddc97', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.2 } },
  );
  const label = (id, filter, size, extra = {}) => ({ id, type: 'symbol', source: 'omt', 'source-layer': 'place', filter,
    layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']], 'text-font': extra.bold ? fontB : font, 'text-size': size,
      'text-max-width': 8, ...(extra.layout || {}) },
    paint: { 'text-color': T.label, 'text-halo-color': T.halo, 'text-halo-width': 1.3, ...(extra.paint || {}) }, ...(extra.zoom || {}) });
  if (opts.labels) layers.push(
    label('label-city', ['in', ['get', 'class'], ['literal', ['city', 'town']]], ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 14],
      { zoom: { minzoom: 4 }, layout: { 'symbol-sort-key': ['get', 'rank'] }, paint: { 'text-opacity': 0.9 } }),
    label('label-state', ['==', ['get', 'class'], 'state'], ['interpolate', ['linear'], ['zoom'], 3, 9, 7, 12],
      { zoom: { minzoom: 3, maxzoom: 8 }, layout: { 'text-transform': 'uppercase', 'text-letter-spacing': 0.1 }, paint: { 'text-opacity': 0.7 } }),
    label('label-country', ['==', ['get', 'class'], 'country'], ['interpolate', ['linear'], ['zoom'], 1, 10, 6, 15], { bold: true, zoom: { maxzoom: 9 } }),
  );
  return {
    version: 8, projection: { type: opts.globe ? 'globe' : 'mercator' },
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      ...sources,
      night: { type: 'geojson', data: emptyFC(), tolerance: 0.6 },
      graticule: { type: 'geojson', data: graticuleFC() },
      outline: { type: 'geojson', data: emptyFC() },
      drawbox: { type: 'geojson', data: emptyFC() },
      r3dcam: { type: 'geojson', data: emptyFC() }, r3dbox: { type: 'geojson', data: emptyFC() },
      r3ddraw: { type: 'geojson', data: emptyFC() }, r3dhandles: { type: 'geojson', data: emptyFC() },
      'dem-ground': { type: 'raster-dem', tiles: [TERRARIUM], encoding: 'terrarium', tileSize: 256, maxzoom: 13, attribution: 'Terrain: AWS Terrain Tiles' },
    },
    layers,
    sky: skySpec(theme, opts.lite),
  };
}

function skySpec(theme, lite) {
  return {
    'sky-color': theme === 'light' ? '#a9c8ec' : '#0a1a33', 'horizon-color': theme === 'light' ? '#dce9f7' : '#1f4f91',
    'fog-color': theme === 'light' ? '#dfe7f0' : '#0b1626', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.9,
    // the globe's atmosphere glow is a full-screen pass every frame
    'atmosphere-blend': lite ? 0 : ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
  };
}

function graticuleFC() {
  const f = [];
  const line = (c, major) => f.push({ type: 'Feature', properties: { major }, geometry: { type: 'LineString', coordinates: c } });
  for (let lon = -180; lon < 180; lon += 15) { const c = []; for (let lat = -85; lat <= 85; lat += 1) c.push([lon, lat]); line(c, lon === 0); }
  for (let lat = -75; lat <= 75; lat += 15) { const c = []; for (let lon = -180; lon <= 180; lon += 1) c.push([lon, lat]); line(c, lat === 0); }
  return { type: 'FeatureCollection', features: f };
}

// ---- night side: caps of radius 90 + h degrees around the anti-solar point, one per twilight step
function subsolar(date) {
  const rad = Math.PI / 180, d = date.getTime() / 86400000 - 10957.5;
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad, gmst = (18.697374558 + 24.06570982441908 * d) * 15;
  return { lat: Math.asin(Math.sin(e) * Math.sin(L)) / rad, lon: ((((ra - gmst) % 360) + 540) % 360) - 180 };
}
export function destPoint([lon, lat], brgDeg, distKm) {
  const R = 6371, d = distKm / R, b = brgDeg * Math.PI / 180, p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [l2 * 180 / Math.PI, p2 * 180 / Math.PI];
}
export function unwrapLine(pts) {
  const out = [pts[0].slice()];
  for (let i = 1; i < pts.length; i++) {
    let x = pts[i][0];
    const px = out[i - 1][0];
    while (x - px > 180) x -= 360;
    while (x - px < -180) x += 360;
    out.push([x, pts[i][1]]);
  }
  return out;
}
function nightFC(date) {
  const sun = subsolar(date);
  const anti = [sun.lon > 0 ? sun.lon - 180 : sun.lon + 180, -sun.lat];
  const darkPole = anti[1] >= 0 ? 1 : -1;
  const feats = [];
  for (const h of NIGHT_BANDS) {
    const pts = [];
    for (let b = 0; b <= 360; b += 3) pts.push(destPoint(anti, b, (90 + h) * 111.195));
    let ring = unwrapLine(pts);
    if (Math.abs(ring[ring.length - 1][0] - ring[0][0]) > 180) {
      ring = ring.map(([x, y]) => [x, Math.max(-85, Math.min(85, y))]);
      ring.push([ring[ring.length - 1][0], darkPole * 85], [ring[0][0], darkPole * 85], ring[0]);
    }
    feats.push({ type: 'Feature', properties: { h }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  return { type: 'FeatureCollection', features: feats };
}

/** Lon/lat bounds of a geostationary grid (for the raster source: no requests outside). */
function gridBounds(g) {
  const pts = outline(g, 24);
  if (!pts) return null; // disk edge inside: request everywhere the disk could be
  let w = Infinity, e = -Infinity, s = 90, n = -90;
  const un = unwrapLine(pts);
  for (const [x, y] of un) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  if (e - w >= 359) return null;
  return [w, Math.max(-85, s), e, Math.min(85, n)];
}

export class SatMap {
  constructor(container, { tier, theme = 'dark', globe = true, labels = true, camera, onMove } = {}) {
    this.tier = tier;
    this.opts = { theme, globe, labels, lite: !!tier.lite };
    this.tileSize = tier.name === 'low' ? 256 : 512;
    this.router = new TileRouter(tier.tileWorkers, { cacheMB: tier.tileCacheMB });
    this.layer = { a: null, b: null }; // ping-pong: {src id, frame}
    this.front = 'a';
    this.lutId = '';
    this.opacity = 1;
    this.lights = true;
    this.cloud3d = { on: false, exag: 10 };
    this.ground3d = { on: false, exag: 1.5 };
    maplibregl.setWorkerCount(tier.mapWorkers);
    maplibregl.setMaxParallelImageRequests(tier.name === 'low' ? 8 : 16);
    this._protocols();
    const cam = camera || { center: [-80, 22], zoom: 1.8, bearing: 0, pitch: 0 };
    this.map = new maplibregl.Map({
      container, style: buildStyle(theme, this.opts), center: cam.center, zoom: cam.zoom, bearing: cam.bearing || 0, pitch: cam.pitch || 0,
      maxPitch: 80, fadeDuration: 0, antialias: tier.antialias, attributionControl: { compact: true },
      pixelRatio: Math.min(window.devicePixelRatio || 1, tier.dprCap), maxTileCacheSize: tier.name === 'low' ? 60 : 200,
      refreshExpiredTiles: false, cancelPendingTileRequestsWhileZooming: true, renderWorldCopies: false,
    });
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 100 }), 'bottom-left');
    // phones: the attribution starts folded (its (i) button opens it), so it never covers the scale bar
    if (innerWidth < 640) this.map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    this.ready = new Promise((r) => this.map.once('load', () => { this._onStyle(); r(); }));
    this.map.on('move', () => onMove && onMove());
    this.map.on('style.load', () => { if (this._styled) this._onStyle(); });
  }

  _protocols() {
    if (SatMap._protoDone) { SatMap._active = this; return; }
    SatMap._protoDone = true; SatMap._active = this;
    // satv://t/<frame id>/<lut id>/<lights>/<size>/{z}/{x}/{y}
    maplibregl.addProtocol('satv', async (params) => {
      const m = SatMap._active;
      const [, , , id, lutId, lights, size, z, x, y] = params.url.split('/');
      const bmp = await m.router.tile(+id, lutId, +z, +x, +y, +size, lights === '1');
      return { data: bmp };
    });
    // satdem://d/<frame id>/<ground scale>/{z}/{x}/{y}
    maplibregl.addProtocol('satdem', async (params) => {
      const m = SatMap._active;
      const [, , , id, g, z, x, y] = params.url.split('/');
      return { data: await m.router.dem(+id, +z, +x, +y, +g) };
    });
  }

  _onStyle() {
    this._styled = true;
    this.layer = { a: null, b: null };
    if (this.nightDate) this.setNight(this.nightDate, true);
    if (this._shown) { const f = this._shown; this._shown = null; this.showFrame(f, { force: true }); }
    this._applyTerrain();
  }

  get canvas() { return this.map.getCanvas(); }

  // ------------------------------------------------------------------ style
  setTheme(theme) {
    if (theme === this.opts.theme) return;
    this.opts.theme = theme;
    this.map.setStyle(buildStyle(theme, this.opts), { diff: false });
  }
  setLabels(on) {
    this.opts.labels = on;
    for (const id of ['label-city', 'label-state', 'label-country']) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    if (on && !this.map.getLayer('label-country')) this.map.setStyle(buildStyle(this.opts.theme, this.opts), { diff: false });
  }
  setProjection(globe) { this.opts.globe = globe; this.map.setProjection({ type: globe ? 'globe' : 'mercator' }); }

  /** Lighter rendering for a device that turned out to be struggling: 1x pixels, no relief layer,
   *  no atmosphere glow. */
  lighten() {
    const m = this.map;
    this.opts.lite = true;
    m.setPixelRatio(1);
    if (m.getLayer('relief')) m.setLayoutProperty('relief', 'visibility', 'none');
    try { m.setSky(skySpec(this.opts.theme, true)); } catch (e) { /* style still loading */ }
  }

  show(layerIds, on) {
    for (const id of [].concat(layerIds)) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  setNight(date, force = false) {
    this.nightDate = date;
    const src = this.map.getSource('night');
    if (!src || !date) return;
    const t = date.getTime();
    if (!force && Math.abs(t - (this._nightT || 0)) < 120000) return;
    this._nightT = t;
    src.setData(nightFC(date));
  }

  setGeo(source, fc) { const s = this.map.getSource(source); if (s) s.setData(fc || emptyFC()); }

  // ------------------------------------------------------------------ satellite frames
  async putFrame(frame) { await this.router.put(frame); }
  dropFrames(frames) { this.router.drop(frames.map((f) => f.id)); }

  async setColour(lutId, lut, kind, vmin, vmax) {
    await this.router.lut(lutId, lut, kind, vmin, vmax);
    if (lutId === this.lutId) return;
    this.lutId = lutId;
    // re-request the shown frame's tiles with the new colours
    if (this._shown && this._shown.mode === 'band') this.showFrame(this._shown, { force: true });
  }

  _tileUrl(f) {
    return `satv://t/${f.id}/${f.mode === 'band' ? this.lutId : '-'}/${this.lights ? 1 : 0}/${this.tileSize}/{z}/{x}/{y}`;
  }

  _maxzoom(f) {
    const res = Math.max(0.25, f.resKm);
    const z0 = this.tileSize === 512 ? 78.27 : 156.54;
    return Math.max(1, Math.min(14, Math.ceil(Math.log2(z0 / res))));
  }

  _addLayer(slot, f, opacity) {
    const map = this.map, id = `sat-${slot}-${f.id}-${this.lutId}-${this.lights ? 1 : 0}`;
    const old = this.layer[slot];
    if (old) { if (map.getLayer(old.id)) map.removeLayer(old.id); if (map.getSource(old.id)) map.removeSource(old.id); }
    const spec = { type: 'raster', tiles: [this._tileUrl(f)], tileSize: this.tileSize, maxzoom: this._maxzoom(f) };
    const b = gridBounds(f.grid); if (b) spec.bounds = b;
    map.addSource(id, spec);
    map.addLayer({ id, type: 'raster', source: id,
      paint: { 'raster-opacity': opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } } }, 'sat-anchor');
    this.layer[slot] = { id, frame: f };
    return id;
  }

  /** Wait until a source has the tiles for the current view (or a timeout). */
  _loaded(id, ms = 8000) {
    const map = this.map;
    return new Promise((resolve) => {
      if (map.getSource(id) && map.isSourceLoaded(id)) { resolve(true); return; }
      const t0 = performance.now();
      const check = (e) => {
        if (e && e.sourceId && e.sourceId !== id) return;
        if (!map.getSource(id)) { done(false); return; }
        if (map.isSourceLoaded(id) || performance.now() - t0 > ms) done(true);
      };
      const tm = setTimeout(() => done(true), ms);
      const done = (v) => { clearTimeout(tm); map.off('sourcedata', check); map.off('idle', check); resolve(v); };
      map.on('sourcedata', check); map.on('idle', check);
    });
  }

  /**
   * Show a frame. Its tiles load into the hidden layer; when ready it becomes the front layer
   * (cross-faded over blendMs). Resolves once the frame is on screen.
   */
  async showFrame(f, { blendMs = 0, force = false } = {}) {
    if (!this._styled) { this._shown = f; return; }
    const front = this.layer[this.front];
    if (!force && front && front.frame === f && this._shownLut === this.lutId) return;
    const seq = (this._seq = (this._seq || 0) + 1);
    this._shown = f; this._shownLut = this.lutId;
    const back = this.front === 'a' ? 'b' : 'a';
    const first = !this.layer[this.front] || !this.map.getLayer(this.layer[this.front].id);
    // nothing on screen yet: show the tiles as they arrive instead of waiting for all of them
    const id = this._addLayer(back, f, first ? this.opacity : HIDDEN);
    await this._loaded(id, first ? 6000 : 4000);
    if (seq !== this._seq || !this.map.getLayer(id)) return;
    const map = this.map;
    const fid = this.layer[this.front]?.id;
    map.setPaintProperty(id, 'raster-opacity-transition', { duration: blendMs, delay: 0 });
    map.setPaintProperty(id, 'raster-opacity', this.opacity);
    if (fid && map.getLayer(fid)) {
      // the old frame stays fully visible under the fading-in new one, then goes: a layer kept at
      // near-zero opacity would still be drawn on every map frame and hold its tiles on the GPU
      map.moveLayer(id, 'sat-anchor');
      setTimeout(() => {
        if (!map.getLayer(fid) || this.layer[this.front]?.id === fid) return;
        map.removeLayer(fid);
        if (map.getSource(fid)) map.removeSource(fid);
        for (const s of ['a', 'b']) if (this.layer[s]?.id === fid) this.layer[s] = null;
      }, blendMs + 30);
    }
    this.front = back;
    if (this.cloud3d.on) this._cloudDemSoon(f);
  }

  setOpacity(v) {
    this.opacity = v;
    const fr = this.layer[this.front];
    if (fr && this.map.getLayer(fr.id)) { this.map.setPaintProperty(fr.id, 'raster-opacity-transition', { duration: 0 }); this.map.setPaintProperty(fr.id, 'raster-opacity', v); }
  }

  setLights(on) { this.lights = on; if (this._shown) this.showFrame(this._shown, { force: true }); }

  clearFrames() {
    for (const s of ['a', 'b']) { const l = this.layer[s]; if (l) { if (this.map.getLayer(l.id)) this.map.removeLayer(l.id); if (this.map.getSource(l.id)) this.map.removeSource(l.id); } }
    this.layer = { a: null, b: null }; this._shown = null;
  }

  // ------------------------------------------------------------------ 3D terrain
  set3D({ cloud, cloudExag, ground, groundExag } = {}) {
    if (cloud !== undefined) this.cloud3d.on = cloud;
    if (cloudExag !== undefined) this.cloud3d.exag = cloudExag;
    if (ground !== undefined) this.ground3d.on = ground;
    if (groundExag !== undefined) this.ground3d.exag = groundExag;
    this._applyTerrain();
  }

  _cloudDemSoon(f) {
    clearTimeout(this._demT);
    this._demT = setTimeout(() => { this._demFrame = f; this._applyTerrain(); }, this._demFrame ? 350 : 0);
  }

  _applyTerrain() {
    const map = this.map;
    if (!this._styled) return;
    const c = this.cloud3d, g = this.ground3d;
    this.show('hillshade', g.on || c.on);
    if (map.getLayer('hillshade')) map.setLayoutProperty('hillshade', 'visibility', g.on && !c.on ? 'visible' : 'none');
    if (!c.on && !g.on) { map.setTerrain(null); this._demKey = null; return; }
    if (!c.on) { map.setTerrain({ source: 'dem-ground', exaggeration: g.exag }); this._demKey = 'ground'; return; }
    const f = this._demFrame || this._shown;
    if (!f) return;
    // cloud heights: the exaggeration applies to the whole DEM, so ground is pre-scaled to keep its own
    const gs = g.on ? +(g.exag / c.exag).toFixed(4) : 0;
    const key = `${f.id}/${gs}`;
    if (key !== this._demKey) {
      const prev = this._demSrc;
      const id = `clouddem-${f.id}-${gs}`;
      if (!map.getSource(id)) map.addSource(id, { type: 'raster-dem', tiles: [`satdem://d/${f.id}/${gs}/{z}/{x}/{y}`], tileSize: 256, encoding: 'mapbox', maxzoom: Math.min(11, this._maxzoom(f)) });
      map.setTerrain({ source: id, exaggeration: c.exag });
      this._demSrc = id; this._demKey = key;
      if (prev && prev !== id) setTimeout(() => { if (map.getSource(prev) && this._demSrc !== prev) map.removeSource(prev); }, 1500);
    } else map.setTerrain({ source: this._demSrc, exaggeration: c.exag });
  }

  // ------------------------------------------------------------------ camera
  camera() { const m = this.map, c = m.getCenter(); return { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() }; }
  flyTo(o, ms = 1200) { this.map.flyTo({ ...o, duration: ms, essential: true }); }
  fitBounds(b, o = {}) { this.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 1000, ...o }); }
  probe(f, lon, lat) { return f ? this.router.probe(f.id, lon, lat) : Promise.resolve(null); }
  /** A tile of the shown frame as an ImageBitmap (the 3D view drapes the product over its terrain). */
  frameTile(f, z, x, y) { return this.router.tile(f.id, this.lutId, z, x, y, this.tileSize, this.lights); }
}

export { maplibregl, emptyFC };
