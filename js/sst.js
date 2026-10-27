/* Sea surface temperature and its anomaly from NOAA Coral Reef Watch: CoralTemp v3.1, the daily
 * 5 km (0.05°) global SST analysis from 1985 to yesterday, and CRW's anomaly against its daily
 * climatology. Drawn on a MapLibre or Mapbox GL map (the same file serves both editions, like
 * overlays.js) as one image over the view, coloured here, so the colour table, its range and the
 * contour (the 26.5 °C isotherm tropical cyclones need) are the user's. It sits behind the
 * satellite imagery (showing where the imagery is transparent or faded), or over it on request.
 *
 * The values come from ERDDAP's binary OPeNDAP (.dods) answer for the view's box, every k-th
 * grid point so the image keeps about the screen's resolution (the full 5 km when zoomed in):
 *   PacIOOS ERDDAP  dhw_5km    CRW's daily 5 km product, sends CORS headers
 *   NOAA CoastWatch NOAA_DHW   the same product; no CORS, so only through the app's proxy
 * In Live mode the newest day is shown; in Archive mode the day of the shown frame.
 */
const SOURCES = [
  { base: 'https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km', proxy: false },
  { base: 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/NOAA_DHW', proxy: true },
];
const FIELDS = {
  sst: { v: 'CRW_SST', name: 'SST', long: 'Sea surface temperature', lo: 20, hi: 32, palette: 'tc', iso: 26.5 },
  anom: { v: 'CRW_SSTANOMALY', name: 'Anomaly', long: 'SST anomaly', lo: -4, hi: 4, palette: 'rdbu', iso: 0 },
};
// colour tables: evenly spaced colours, or [position 0..1, colour] stops
export const PALETTES = {
  tc: { name: 'Tropical (break at 26.5 °C on 20–32)', stops: [[0, '#1b2a6b'], [0.25, '#2f6fd0'], [0.4167, '#4fb3d9'], [0.5, '#8fd6b4'], [0.5417, '#f4e04d'],
    [0.625, '#ffb238'], [0.7083, '#ff7a2f'], [0.7917, '#e8402a'], [0.875, '#b5175e'], [0.9583, '#7a1fa2'], [1, '#f2d9ff']] },
  crw: { name: 'Rainbow (Coral Reef Watch)', stops: ['#2a0a5e', '#3b2fa3', '#2563d1', '#1c9ad6', '#22c3c3', '#5fd38d', '#b6e35a', '#f4e04d', '#f9a93c', '#ef6a32', '#d1352b', '#9e1a1a'] },
  turbo: { name: 'Turbo', stops: ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c8ef34', '#faba39', '#f66b19', '#ca2a04', '#7a0403'] },
  thermal: { name: 'Thermal', stops: ['#042333', '#2c3395', '#744992', '#b15f82', '#eb7958', '#fbb43d', '#e8fa5b'] },
  ocean: { name: 'Ocean (blue to cream)', stops: ['#0b1d51', '#1f4e9c', '#2f86c4', '#5bbdd6', '#a5e3e0', '#f4f7c5'] },
  gray: { name: 'Grayscale', stops: ['#101418', '#ffffff'] },
  rdbu: { name: 'Blue – white – red', stops: ['#053061', '#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b', '#67001f'] },
  crwanom: { name: 'Purple – white – red (CRW anomaly)', stops: ['#2d004b', '#3f2b96', '#2f6fd0', '#7fb8e6', '#d7ecf7', '#ffffff', '#fff3b0', '#ffc04d', '#ff7a2f', '#d7301f', '#7f0000'] },
  balance: { name: 'Balance', stops: ['#181c43', '#0c5ebe', '#75aabe', '#f1eceb', '#d08b73', '#a92e3a', '#3c0912'] },
};
const DEFAULTS = { on: false, field: 'sst', opacity: 0.85, smooth: true, contour: true, contourColor: '#ffffff', probe: true, onTop: false,
  sst: { palette: 'tc', lo: 20, hi: 32, iso: 26.5 }, anom: { palette: 'rdbu', lo: -4, hi: 4, iso: 0 } };
const RES = 0.05, MAX_COLS = 1300, MAX_ROWS = 900, MAX_LAT = 84;
const p2 = (n) => String(n).padStart(2, '0');
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
/** 256-entry RGB table of a palette. */
function lut(name) {
  const p = PALETTES[name] || PALETTES.tc;
  const stops = p.stops.map((s, i) => (Array.isArray(s) ? [s[0], hexToRgb(s[1])] : [i / (p.stops.length - 1), hexToRgb(s)]));
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const f = i / 255;
    let k = 0;
    while (k < stops.length - 2 && f > stops[k + 1][0]) k++;
    const [fa, a] = stops[k], [fb, b] = stops[k + 1], u = fb > fa ? Math.min(1, Math.max(0, (f - fa) / (fb - fa))) : 0;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * u);
  }
  return out;
}
const cssGradient = (name) => {
  const p = PALETTES[name] || PALETTES.tc;
  return `linear-gradient(90deg,${p.stops.map((s, i) => (Array.isArray(s) ? `${s[1]} ${(s[0] * 100).toFixed(1)}%` : `${s} ${(i / (p.stops.length - 1) * 100).toFixed(1)}%`)).join(',')})`;
};

// ------------------------------------------------------------------ data
/** ERDDAP .dods answer for one gridded variable -> {vals (NaN = land / ice / no data), nr, nc, lat, lon, time}. */
function parseDods(buf) {
  const u8 = new Uint8Array(buf), mark = [10, 68, 97, 116, 97, 58, 10];   // "\nData:\n"
  let at = -1;
  for (let i = 0; i < Math.min(u8.length, 20000) - mark.length; i++) {
    let ok = true;
    for (let k = 0; k < mark.length; k++) if (u8[i + k] !== mark[k]) { ok = false; break; }
    if (ok) { at = i + mark.length; break; }
  }
  if (at < 0) throw new Error('not an OPeNDAP answer');
  const dds = new TextDecoder().decode(u8.subarray(0, at));
  const arr = /ARRAY:\s*(Float32|Float64)\s+\w+\[time = (\d+)\]\[latitude = (\d+)\]\[longitude = (\d+)\]/.exec(dds);
  if (!arr) throw new Error('unexpected OPeNDAP layout');
  const dv = new DataView(buf, at), f64 = arr[1] === 'Float64', nr = +arr[3], nc = +arr[4];
  let o = 0;
  const vector = (n, wide) => {
    const out = new Float64Array(n);
    o += 8;   // XDR array: the length, twice
    for (let i = 0; i < n; i++, o += wide ? 8 : 4) out[i] = wide ? dv.getFloat64(o) : dv.getFloat32(o);
    return out;
  };
  const raw = vector(nr * nc, f64), vals = new Float32Array(nr * nc);
  for (let i = 0; i < raw.length; i++) vals[i] = raw[i] > -100 && raw[i] < 100 ? raw[i] : NaN;   // fill value -327.68
  const time = vector(1, true)[0] * 1000, lat = vector(nr, false), lon = vector(nc, false);
  return { vals, nr, nc, lat, lon, time };
}

/** Columns of two answers side by side (a box across the date line). */
function joinCols(a, b) {
  const nc = a.nc + b.nc, vals = new Float32Array(a.nr * nc);
  for (let r = 0; r < a.nr; r++) {
    vals.set(a.vals.subarray(r * a.nc, (r + 1) * a.nc), r * nc);
    vals.set(b.vals.subarray(r * b.nc, (r + 1) * b.nc), r * nc + a.nc);
  }
  const lon = new Float64Array(nc);
  lon.set(a.lon); lon.set(b.lon.map((x) => x + 360), a.nc);
  return { vals, nr: a.nr, nc, lat: a.lat, lon, time: a.time };
}

/**
 * The "Sea surface temperature" card inside `el` and the map layer.
 *   state   a plain object the app persists (filled with defaults here); onChange() after edits
 *   proxy   URL prefix for the NOAA CoastWatch fallback ('' / null: PacIOOS only)
 *   under   layer id the SST image goes under when behind the imagery (the night shading)
 *   over    layer id it goes under when drawn over the imagery (below lines / labels)
 */
export class Sst {
  constructor({ map, el, state, onChange = () => {}, proxy = null, under, over }) {
    Object.assign(this, { map, el, onChange, proxy, under, over });
    this.st = Object.assign(state, { ...DEFAULTS, ...state });
    for (const f of Object.keys(FIELDS)) this.st[f] = { ...DEFAULTS[f], ...(state[f] || {}) };
    if (!FIELDS[this.st.field]) this.st.field = 'sst';
    this.day = null;          // null: the newest day; else a UTC day (ms)
    this.cache = new Map();   // request key -> Promise<grid>
    this.grid = null;         // the grid on screen, with its request
    this.drawn = new Map();   // draw key -> {url, coords} of a finished image
    this.gen = 0;
    this.build();
    if (map) {
      let t = 0;
      map.on('moveend', () => { clearTimeout(t); t = setTimeout(() => this.update(), 350); });
      this.bindProbe();
    }
  }

  get f() { return this.st[this.st.field]; }

  /** Add the layer again after a style change. */
  attach() {
    if (!this.map) return;
    this.added = false;
    if (this.img) this.draw(true);
    else this.update();
  }

  build() {
    const st = this.st;
    this.el.innerHTML = `
      <label class="row check card-head" title="Sea surface temperature or its anomaly from NOAA Coral Reef Watch (CoralTemp, daily, 5 km), over the satellite imagery"><input type="checkbox" data-k="on"> Sea surface temperature (Coral Reef Watch)</label>
      <div class="sst-tools">
        <div class="row rc-chips"><span>Field</span><span class="chips small">${Object.entries(FIELDS).map(([k, f]) => `<button type="button" data-f="${k}" title="${f.long}">${f.name}</button>`).join('')}</span></div>
        <label class="row">Colours <select data-k="palette">${Object.entries(PALETTES).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}</select></label>
        <div class="row sst-range" title="Values at the two ends of the colour table (°C)"><span>Range</span>
          <input type="number" data-k="lo" step="0.5" aria-label="Lowest value (°C)"><span>to</span><input type="number" data-k="hi" step="0.5" aria-label="Highest value (°C)"><span>°C</span>
          <button type="button" class="btn sm sst-reset" title="Default range">Reset</button></div>
        <div class="sst-legend"><div class="sst-bar"></div><div class="sst-ticks mono"></div></div>
        <label class="row" title="Opacity of the SST image over the satellite imagery">Opacity <input type="range" data-k="opacity" min="10" max="100"><span class="mono val sst-op"></span></label>
        <div class="row sst-iso"><label class="check" title="A line where the field crosses this value (tropical cyclones need about 26.5 °C water)"><input type="checkbox" data-k="contour"> Contour at</label>
          <input type="number" data-k="iso" step="0.5" aria-label="Contour value (°C)"><span>°C</span><input type="color" data-k="contourColor" title="Contour colour" aria-label="Contour colour"></div>
        <label class="row check" title="Draw the SST over the satellite imagery instead of behind it (behind, it shows where the imagery is transparent or its opacity is lowered)"><input type="checkbox" data-k="onTop"> Draw over the satellite imagery</label>
        <label class="row check" title="Blend between the 5 km grid points instead of showing each as a square"><input type="checkbox" data-k="smooth"> Smooth</label>
        <label class="row check"><input type="checkbox" data-k="probe"> Value under the cursor</label>
        <div class="note sst-status"></div>
        <div class="note">NOAA Coral Reef Watch CoralTemp v3.1 (daily, 0.05°, night-time SST from 1985) and its SST anomaly, via ERDDAP. Land, ice and gaps are left clear.</div>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.tools = q('.sst-tools');
    const on = q('[data-k=on]');
    on.checked = st.on;
    on.onchange = () => { st.on = on.checked; this.changed(); this.show(); if (st.on) this.update(); };
    for (const b of this.el.querySelectorAll('[data-f]')) b.onclick = () => { st.field = b.dataset.f; this.changed(); this.update(); };
    q('[data-k=palette]').onchange = (e) => { this.f.palette = e.target.value; this.changed(); this.draw(); };
    const num = (k, fn) => { const i = q(`[data-k=${k}]`); i.onchange = () => { const v = parseFloat(i.value); if (isFinite(v)) { this.f[k] = v; this.changed(); fn(); } else this.sync(); }; };
    num('lo', () => this.draw());
    num('hi', () => this.draw());
    num('iso', () => this.draw());
    q('.sst-reset').onclick = () => { const d = FIELDS[st.field]; Object.assign(this.f, { lo: d.lo, hi: d.hi }); this.changed(); this.draw(); };
    const op = q('[data-k=opacity]');
    op.oninput = () => { st.opacity = op.value / 100; this.sync(); this.paint(); };
    op.onchange = () => this.changed();
    for (const k of ['contour', 'smooth', 'probe', 'onTop']) {
      const c = q(`[data-k=${k}]`);
      c.onchange = () => { st[k] = c.checked; this.changed(); if (k === 'onTop') this.restack(); else if (k !== 'probe') this.draw(); };
    }
    q('[data-k=contourColor]').oninput = (e) => { st.contourColor = e.target.value; this.draw(); };
    q('[data-k=contourColor]').onchange = () => this.changed();
    this.sync();
  }

  changed() { this.sync(); this.onChange(this.st); }

  sync() {
    const st = this.st, f = this.f, q = (s) => this.el.querySelector(s);
    this.tools.classList.toggle('hidden', !st.on);
    for (const b of this.el.querySelectorAll('[data-f]')) b.classList.toggle('on', b.dataset.f === st.field);
    q('[data-k=palette]').value = f.palette;
    for (const k of ['lo', 'hi', 'iso']) if (document.activeElement !== q(`[data-k=${k}]`)) q(`[data-k=${k}]`).value = f[k];
    q('[data-k=opacity]').value = Math.round(st.opacity * 100);
    q('.sst-op').textContent = `${Math.round(st.opacity * 100)}%`;
    for (const k of ['contour', 'smooth', 'probe', 'onTop']) q(`[data-k=${k}]`).checked = !!st[k];
    q('[data-k=contourColor]').value = st.contourColor;
    // legend: the colour table with ticks, the contour marked
    const lo = Math.min(f.lo, f.hi - 0.1), hi = Math.max(f.hi, lo + 0.1);
    q('.sst-bar').style.background = cssGradient(f.palette);
    const n = 4, ticks = [];
    for (let i = 0; i <= n; i++) ticks.push(`<span style="left:${i / n * 100}%">${+(lo + (hi - lo) * i / n).toFixed(1)}</span>`);
    if (st.contour && f.iso > lo && f.iso < hi) ticks.push(`<i style="left:${(f.iso - lo) / (hi - lo) * 100}%;background:${st.contourColor}" title="Contour ${f.iso} °C"></i>`);
    q('.sst-ticks').innerHTML = ticks.join('');
  }

  status(text) { this.el.querySelector('.sst-status').textContent = text; }

  /** The shown frame's time; in Live mode the newest analysis is used. */
  setTime(t, { live = false } = {}) {
    // CRW publishes a day's analysis the next day: recent frames use the newest one
    const day = live || !t || t > Date.now() - 36 * 3600e3 ? null : Math.floor(t / 864e5) * 864e5;
    if (day === this.day) return;
    this.day = day;
    if (this.st.on) this.update();
  }

  show() {
    for (const id of this.layers()) this.map.setLayoutProperty(id, 'visibility', this.st.on ? 'visible' : 'none');
    if (!this.st.on) this.tip?.classList.add('hidden');
  }

  paint() {
    for (const id of this.layers()) {
      this.map.setPaintProperty(id, 'raster-opacity', this.st.opacity);
      this.map.setPaintProperty(id, 'raster-resampling', this.st.smooth ? 'linear' : 'nearest');
    }
  }

  /** The box to request for the current view (padded), the stride and the request key. */
  want() {
    const map = this.map, z = map.getZoom();
    let w = -180, e = 180, s = -MAX_LAT, n = MAX_LAT;
    if (z > 2.2) {
      const b = map.getBounds();
      const pw = (b.getEast() - b.getWest()) * 0.25, ph = (b.getNorth() - b.getSouth()) * 0.25;
      w = b.getWest() - pw; e = b.getEast() + pw;
      s = Math.max(-MAX_LAT, b.getSouth() - ph); n = Math.min(MAX_LAT, b.getNorth() + ph);
      if (e - w >= 340) { w = -180; e = 180; }
    }
    // west edge in [-180, 180); the box may run past 180 (across the date line)
    const k = Math.floor((w + 180) / 360);
    w -= k * 360; e -= k * 360;
    const stride = Math.max(1, Math.ceil(Math.max((e - w) / RES / MAX_COLS, (n - s) / RES / MAX_ROWS)));
    const step = stride * RES;
    // snap the box to the strided grid, so small moves reuse the same request
    w = Math.floor(w / step / 4) * step * 4; e = Math.ceil(e / step / 4) * step * 4;
    s = Math.max(-MAX_LAT, Math.floor(s / step / 4) * step * 4); n = Math.min(MAX_LAT, Math.ceil(n / step / 4) * step * 4);
    if (e - w >= 360) { w = -180; e = 180; }
    return { w, e, s, n, stride };
  }

  /** Fetch what the view needs (if the image on screen does not already cover it), then draw. */
  async update() {
    if (!this.st.on || !this.map) return;
    const st = this.st, req = this.want(), field = st.field, day = this.day;
    const g = this.grid;
    if (g && g.field === field && g.day === day && g.req.stride <= req.stride && covers(g.req, req)) {
      if (!this.img || this.img.key !== this.drawKey()) this.draw();
      return;
    }
    const gen = ++this.gen;
    const key = `${field}|${day}|${req.w}|${req.e}|${req.s}|${req.n}|${req.stride}`;
    this.status('Loading sea surface temperature…');
    try {
      if (!this.cache.has(key)) {
        const p = this.fetchGrid(FIELDS[field].v, req, day);
        this.cache.set(key, p);
        p.catch(() => this.cache.delete(key));
        while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
      }
      const grid = await this.cache.get(key);
      if (gen !== this.gen) return;
      this.grid = Object.assign(grid, { field, day, req });
      this.draw();
      const res = req.stride * RES;
      this.status(`${FIELDS[field].long}, ${fmtDay(grid.time)} · ${res < 0.06 ? '5 km (full resolution)' : `every ${req.stride} grid points (${Math.round(res * 111)} km)`}`);
    } catch (e) {
      if (gen !== this.gen) return;
      console.warn('SST', e);
      this.status(`SST unavailable (${e.message})`);
    }
  }

  /** One request per side of the date line; each source in turn. */
  async fetchGrid(v, { w, e, s, n, stride }, day) {
    const time = day == null ? 'last' : `${new Date(day).toISOString().slice(0, 10)}T12:00:00Z`;
    const parts = e > 180 ? [[w, 180 - RES / 2], [-180 + RES / 2, e - 360]] : [[w, e]];
    let err;
    for (const src of SOURCES) {
      if (src.proxy && !this.proxy) continue;
      try {
        const grids = [];
        for (const [a, b] of parts) {
          const lon = (x) => +Math.min(180 - RES / 2, Math.max(-180 + RES / 2, x)).toFixed(3);   // grid centres
          const q = `${v}[(${time})][(${n}):${stride}:(${s})][(${lon(a)}):${stride}:(${lon(b)})]`.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
          const url = `${src.base}.dods?${q}`;
          const r = await fetch(src.proxy ? this.proxy + encodeURIComponent(url) : url);
          if (!r.ok) {
            const msg = (await r.text().catch(() => '')).match(/message="([^"]+)"/);
            throw new Error(msg ? msg[1].slice(0, 120) : `HTTP ${r.status}`);
          }
          grids.push(parseDods(await r.arrayBuffer()));
        }
        return grids.length === 2 ? joinCols(grids[0], grids[1]) : grids[0];
      } catch (e2) { err = e2; console.warn('SST source', src.base, e2); }
    }
    throw err || new Error('no source');
  }

  drawKey() {
    const st = this.st, f = this.f;
    return [f.palette, f.lo, f.hi, st.contour, f.iso, st.contourColor, st.smooth, this.grid?.req && JSON.stringify(this.grid.req), this.grid?.time, st.field].join('|');
  }

  /** Grid -> coloured image in Web Mercator (rows spaced like the map), with the contour. */
  draw(force = false) {
    const g = this.grid, map = this.map;
    if (!g || !map) return;
    const key = this.drawKey();
    if (!force && this.img && this.img.key === key) return;
    const done = this.drawn.get(key);
    if (done) { this.img = { key }; this.place(done); this.sync(); return; }
    const st = this.st, f = this.f, table = lut(f.palette);
    const lo = Math.min(f.lo, f.hi - 0.1), hi = Math.max(f.hi, lo + 0.1);
    const dlat = g.nr > 1 ? g.lat[0] - g.lat[1] : RES, dlon = g.nc > 1 ? (g.lon[g.nc - 1] - g.lon[0]) / (g.nc - 1) : RES;
    const north = Math.min(85, g.lat[0] + dlat / 2), south = Math.max(-85, g.lat[g.nr - 1] - dlat / 2);
    const west = g.lon[0] - dlon / 2, east = g.lon[g.nc - 1] + dlon / 2;
    const up = Math.max(1, Math.min(3, Math.floor(1600 / g.nc)));   // finer than the grid: a thinner contour
    const W = g.nc * up, yN = mercY(north), yS = mercY(south);
    const H = Math.max(2, Math.min(4096, Math.round(W * (yN - yS) / ((east - west) * Math.PI / 180))));
    const out = new Float32Array(W * H);
    const smooth = st.smooth, nr = g.nr, nc = g.nc, vals = g.vals;
    const rowF = new Float32Array(H), colF = new Float32Array(W);
    for (let r = 0; r < H; r++) {
      const lat = Math.atan(Math.sinh(yN + (r + 0.5) / H * (yS - yN))) * 180 / Math.PI;
      rowF[r] = (g.lat[0] - lat) / dlat;
    }
    for (let c = 0; c < W; c++) colF[c] = (c + 0.5) / up - 0.5;
    for (let r = 0; r < H; r++) {
      const fr = rowF[r];
      for (let c = 0; c < W; c++) {
        const fc = colF[c];
        let v;
        if (!smooth) {
          const i = Math.min(nr - 1, Math.max(0, Math.round(fr))), j = Math.min(nc - 1, Math.max(0, Math.round(fc)));
          v = vals[i * nc + j];
        } else {
          const i0 = Math.min(nr - 1, Math.max(0, Math.floor(fr))), j0 = Math.min(nc - 1, Math.max(0, Math.floor(fc)));
          const i1 = Math.min(nr - 1, i0 + 1), j1 = Math.min(nc - 1, j0 + 1);
          const u = Math.min(1, Math.max(0, fr - i0)), t = Math.min(1, Math.max(0, fc - j0));
          const a = vals[i0 * nc + j0], b = vals[i0 * nc + j1], c2 = vals[i1 * nc + j0], d = vals[i1 * nc + j1];
          // next to land keep the nearest of the four
          if (a === a && b === b && c2 === c2 && d === d) v = (a * (1 - t) + b * t) * (1 - u) + (c2 * (1 - t) + d * t) * u;
          else v = u < 0.5 ? (t < 0.5 ? a : b) : (t < 0.5 ? c2 : d);
        }
        out[r * W + c] = v;
      }
    }
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'), im = ctx.createImageData(W, H), px = im.data;
    const iso = f.iso, cc = st.contour ? hexToRgb(st.contourColor) : null, scale = 255 / (hi - lo);
    for (let i = 0; i < W * H; i++) {
      const v = out[i];
      if (v !== v) continue;
      let k = Math.round((v - lo) * scale);
      k = k < 0 ? 0 : k > 255 ? 255 : k;
      const o = i * 4;
      px[o] = table[k * 3]; px[o + 1] = table[k * 3 + 1]; px[o + 2] = table[k * 3 + 2]; px[o + 3] = 255;
      if (cc) {
        const c = i % W, above = v >= iso;
        const right = c < W - 1 ? out[i + 1] : NaN, below = i + W < W * H ? out[i + W] : NaN;
        if ((right === right && (right >= iso) !== above) || (below === below && (below >= iso) !== above)) {
          px[o] = cc[0]; px[o + 1] = cc[1]; px[o + 2] = cc[2];
        }
      }
    }
    ctx.putImageData(im, 0, 0);
    // pieces of at most 180 degrees, cut at the date line / prime meridian: the globe draws no
    // image source that crosses the date line (longitudes past 180) or spans the whole world
    const edges = [west];
    for (let c = Math.ceil(west / 180 + 1e-9) * 180; c < east - 1e-9; c += 180) edges.push(c);
    edges.push(east);
    const pieces = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const x0 = Math.round((edges[i] - west) / (east - west) * W), x1 = Math.round((edges[i + 1] - west) / (east - west) * W);
      if (x1 - x0 < 1) continue;
      const shift = edges[i] >= 180 - 1e-9 ? -360 : 0;
      const a = west + x0 / W * (east - west) + shift, b = west + x1 / W * (east - west) + shift;
      const pc = document.createElement('canvas');
      pc.width = x1 - x0; pc.height = H;
      pc.getContext('2d').drawImage(cv, x0, 0, x1 - x0, H, 0, 0, x1 - x0, H);
      pieces.push({ canvas: pc, coords: [[a, north], [b, north], [b, south], [a, south]] });
    }
    this.img = { key };
    Promise.all(pieces.map((p) => new Promise((res) => p.canvas.toBlob(res, 'image/png')))).then((blobs) => {
      if (blobs.some((b) => !b)) return;
      // the last few images stay ready (a loop across midnight switches between two days)
      const ready = pieces.map((p, i) => ({ url: URL.createObjectURL(blobs[i]), coords: p.coords }));
      this.drawn.set(key, ready);
      while (this.drawn.size > 4) {
        const [k, old] = this.drawn.entries().next().value;
        this.drawn.delete(k);
        setTimeout(() => old.forEach((p) => URL.revokeObjectURL(p.url)), 4000);
      }
      if (this.img?.key === key) this.place(ready);
    });
    this.sync();
  }

  /** Image sources / layers sst-0, sst-1, ... for the pieces (unused ones removed). */
  place(pieces) {
    const map = this.map;
    for (let i = 0; i < 3; i++) {
      const id = `sst-${i}`, p = pieces[i], src = map.getSource(id);
      if (!p) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (src) map.removeSource(id);
        continue;
      }
      if (src && this.added) { src.updateImage({ url: p.url, coordinates: p.coords }); continue; }
      if (map.getLayer(id)) map.removeLayer(id);
      if (src) map.removeSource(id);
      map.addSource(id, { type: 'image', url: p.url, coordinates: p.coords });
      map.addLayer({ id, type: 'raster', source: id, layout: { visibility: this.st.on ? 'visible' : 'none' },
        paint: { 'raster-opacity': this.st.opacity, 'raster-fade-duration': 0, 'raster-resampling': this.st.smooth ? 'linear' : 'nearest' } },
      this.anchor());
    }
    this.added = true;
  }

  /** Layer the SST goes under: behind the imagery, or over it. */
  anchor() {
    const id = this.st.onTop ? this.over : this.under;
    return id && this.map.getLayer(id) ? id : undefined;
  }

  restack() { for (const id of this.layers()) this.map.moveLayer(id, this.anchor()); }

  layers() { return [0, 1, 2].map((i) => `sst-${i}`).filter((id) => this.map?.getLayer(id)); }

  /** Value of the shown grid at a point (°C), or null. */
  valueAt(lon, lat) {
    const g = this.grid;
    if (!g || !this.st.on) return null;
    const dlat = g.nr > 1 ? g.lat[0] - g.lat[1] : RES, dlon = g.nc > 1 ? (g.lon[g.nc - 1] - g.lon[0]) / (g.nc - 1) : RES;
    while (lon < g.lon[0] - dlon / 2) lon += 360;
    while (lon > g.lon[g.nc - 1] + dlon / 2 && lon - 360 >= g.lon[0] - dlon / 2) lon -= 360;
    const i = Math.round((g.lat[0] - lat) / dlat), j = Math.round((lon - g.lon[0]) / dlon);
    if (i < 0 || j < 0 || i >= g.nr || j >= g.nc) return null;
    const v = g.vals[i * g.nc + j];
    return v === v ? v : null;
  }

  bindProbe() {
    const map = this.map, box = document.createElement('div');
    box.className = 'mt-tip sst-tip hidden';
    map.getContainer().appendChild(box);
    this.tip = box;
    map.on('mousemove', (e) => {
      if (!this.st.on || !this.st.probe || e.originalEvent?.buttons) { box.classList.add('hidden'); return; }
      const v = this.valueAt(e.lngLat.lng, e.lngLat.lat);
      if (v == null) { box.classList.add('hidden'); return; }
      const anom = this.st.field === 'anom';
      box.textContent = `${anom ? 'SST anomaly' : 'SST'} ${anom && v > 0 ? '+' : ''}${v.toFixed(2)} °C`;
      box.style.left = `${Math.min(e.point.x + 14, map.getContainer().clientWidth - 160)}px`;
      box.style.top = `${e.point.y + 16}px`;
      box.classList.remove('hidden');
    });
    map.getCanvasContainer().addEventListener('mouseleave', () => box.classList.add('hidden'));
  }
}

function covers(a, b) {
  if (a.e - a.w >= 359.9) return b.s >= a.s - 1e-6 && b.n <= a.n + 1e-6;
  let w = b.w, e = b.e;
  while (w < a.w - 1e-6) { w += 360; e += 360; }
  return w >= a.w - 1e-6 && e <= a.e + 1e-6 && b.s >= a.s - 1e-6 && b.n <= a.n + 1e-6;
}
