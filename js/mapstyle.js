/* Customisation panels (the same file serves both editions, like overlays.js):
 *   CycloneStyle  the intensity colour table (Depression ... Cat 5) used by the NHC / JTWC
 *                 storms, the model tracks, the intensity charts and the recon data, and how
 *                 the agencies' cones, tracks, points, symbols and labels are drawn
 *   MapStyle      colours, opacity and line widths of the base map: coastlines, borders, grid,
 *                 ocean and land, place labels, night shading; the grid spacing. Each edition
 *                 passes the layer ids of its own style; a layer's own values come back on reset.
 */
import { CATS, CAT_PRESETS, CAT_DEFAULT, STORM_STYLE, setCatColors, setStormStyle, fmtWind } from './overlays.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const isHex = (s) => /^#[0-9a-f]{6}$/i.test(s || '');

/** Any CSS colour -> ['#rrggbb', alpha] (expressions and unknowns: null). */
let probeCtx = null;
export function parseColor(c) {
  if (typeof c !== 'string') return null;
  probeCtx = probeCtx || document.createElement('canvas').getContext('2d');
  probeCtx.fillStyle = '#010203';
  probeCtx.fillStyle = c;
  const v = probeCtx.fillStyle;
  if (v.startsWith('#')) return v === '#010203' && !/^#0?10?20?3$/i.test(c) ? null : [v, 1];
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(v);
  return m ? [`#${[m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('')}`, m[4] != null ? +m[4] : 1] : null;
}
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${+a.toFixed(3)})`; };

/** A number, or an interpolate / step / match / case expression with its outputs multiplied by k. */
function scaled(v, k) {
  if (typeof v === 'number') return v * k;
  if (!Array.isArray(v)) return v;
  const last = v.length - 1;
  if (v[0] === 'interpolate') return v.map((x, i) => (i >= 4 && i % 2 === 0 ? scaled(x, k) : x));
  if (v[0] === 'step') return v.map((x, i) => (i >= 2 && i % 2 === 0 ? scaled(x, k) : x));
  if (v[0] === 'match') return v.map((x, i) => (i >= 3 && (i % 2 === 1 || i === last) ? scaled(x, k) : x));
  if (v[0] === 'case') return v.map((x, i) => (i >= 2 && (i % 2 === 0 || i === last) ? scaled(x, k) : x));
  return v;
}

// ------------------------------------------------------------------ cyclones
const CAT_LABEL = (c) => (c.id === 'td' ? `Depression (< ${fmtWind(34)})` : c.id === 'ts' ? `Tropical storm (${fmtWind(34)}+)` : `${c.label} (${fmtWind(CATS[CATS.indexOf(c) - 1].max)}+)`);
const STYLE_DEFAULTS = { preset: 'default', colors: CAT_DEFAULT.slice(), ...STORM_STYLE };

/**
 * Intensity colours and the agencies' storm drawing, inside `el` (applied at once, so the
 * colours are right before anything is drawn).
 */
export class CycloneStyle {
  constructor({ el, state, onChange = () => {} }) {
    Object.assign(this, { el, onChange });
    this.st = Object.assign(state, { ...STYLE_DEFAULTS, ...state });
    if (!Array.isArray(this.st.colors) || this.st.colors.length !== CATS.length || !this.st.colors.every(isHex)) this.st.colors = CAT_DEFAULT.slice();
    this.apply();
    this.build();
  }

  apply() { setCatColors(this.st.colors); setStormStyle(this.st); }

  build() {
    const st = this.st;
    const color = (k, tip) => `<input type="color" data-s="${k}" title="${esc(tip)}" aria-label="${esc(tip)}">`;
    const chk = (k, text, tip = '') => `<label class="row check" title="${esc(tip)}"><input type="checkbox" data-s="${k}"> ${text}</label>`;
    const range = (k, text, min, max, step, tip = '') => `<label class="row" title="${esc(tip)}">${text} <input type="range" data-s="${k}" min="${min}" max="${max}" step="${step}"><span class="mono val" data-v="${k}"></span></label>`;
    this.el.innerHTML = `
      <details class="fold">
        <summary>Cyclone colours &amp; style</summary>
        <h4>Intensity colours</h4>
        <label class="row" title="Colour table of the intensity classes: NHC / JTWC storms and forecasts, model tracks and charts, recon winds">Preset <select data-k="preset">
          ${Object.entries(CAT_PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}<option value="custom">Custom</option></select></label>
        <div class="cs-cats"></div>
        <h4>Forecast track (NHC / JTWC)</h4>
        <div class="row ms-pair"><span>Line</span>${color('fcstColor', 'Forecast line colour')}<input type="range" data-s="fcstWidth" min="0.5" max="5" step="0.25" title="Line width"><span class="mono val" data-v="fcstWidth"></span></div>
        ${chk('fcstByCat', 'Colour the line by intensity', 'Each segment in the intensity class at its start (instead of one colour)')}
        ${chk('fcstDash', 'Dashed line')}
        ${chk('fcstPts', 'Forecast points', 'A dot at each forecast time, in its intensity colour')}
        ${chk('fptLabels', 'Forecast labels (time · wind)')}
        <div class="row ms-pair"><span>Cone</span>${color('coneColor', 'Cone colour')}<input type="range" data-s="coneOpacity" min="0" max="0.6" step="0.02" title="Cone fill opacity"><span class="mono val" data-v="coneOpacity"></span></div>
        ${chk('coneLine', 'Cone outline')}
        <h4>Past track</h4>
        <div class="row ms-pair"><span>Line</span>${color('pastColor', 'Past track colour')}<input type="range" data-s="pastWidth" min="0.5" max="5" step="0.25" title="Line width"><span class="mono val" data-v="pastWidth"></span></div>
        ${chk('pastByCat', 'Colour the line by intensity')}
        ${chk('pastPts', 'Past positions')}
        <h4>Symbols &amp; labels</h4>
        ${range('ptScale', 'Point size', 0.5, 2.5, 0.1)}
        ${range('iconScale', 'Storm symbol', 0.5, 2.5, 0.1)}
        ${range('labelSize', 'Label size', 8, 18, 0.5)}
        ${chk('nameLabels', 'Storm name and intensity labels')}
        <label class="row" title="Wind speeds in labels, lists and tooltips (storms, model tracks, recon)">Wind units <select data-k="units"><option value="kt">knots</option><option value="mph">mph</option><option value="kmh">km/h</option><option value="ms">m/s</option></select></label>
        <button type="button" class="btn sm cs-reset">Reset all</button>
      </details>`;
    const q = (s) => this.el.querySelector(s);
    q('[data-k=preset]').onchange = (e) => {
      st.preset = e.target.value;
      if (CAT_PRESETS[st.preset]) st.colors = CAT_PRESETS[st.preset].colors.slice();
      this.changed();
    };
    q('[data-k=units]').onchange = (e) => { st.units = e.target.value; this.changed(); };
    for (const i of this.el.querySelectorAll('[data-s]')) {
      const k = i.dataset.s;
      const read = () => (i.type === 'checkbox' ? i.checked : i.type === 'range' ? +i.value : i.value);
      if (i.type === 'checkbox') i.onchange = () => { st[k] = read(); this.changed(); };
      else { i.oninput = () => { st[k] = read(); this.live(); }; i.onchange = () => { st[k] = read(); this.changed(); }; }
    }
    q('.cs-reset').onclick = () => { Object.assign(st, STYLE_DEFAULTS, { colors: CAT_DEFAULT.slice() }); this.changed(); };
    this.sync();
  }

  /** While dragging a slider / colour: apply without saving. */
  live() { setStormStyle(this.st); this.sync(); }

  changed() { this.apply(); this.sync(); this.onChange(this.st); }

  sync() {
    const st = this.st, q = (s) => this.el.querySelector(s);
    q('[data-k=preset]').value = st.preset;
    q('[data-k=units]').value = st.units;
    for (const i of this.el.querySelectorAll('[data-s]')) {
      const k = i.dataset.s;
      if (i.type === 'checkbox') i.checked = !!st[k]; else if (document.activeElement !== i || i.type !== 'range') i.value = st[k];
    }
    for (const v of this.el.querySelectorAll('[data-v]')) {
      const k = v.dataset.v, x = st[k];
      v.textContent = k === 'coneOpacity' ? `${Math.round(x * 100)}%` : k === 'labelSize' ? `${x} px` : `${(+x).toFixed(k.endsWith('Width') ? 2 : 1)}×`.replace('.00×', '×');
    }
    const box = q('.cs-cats');
    box.innerHTML = CATS.map((c, i) => `<label class="cs-cat"><input type="color" data-c="${i}" value="${st.colors[i]}" aria-label="${esc(c.label)} colour"><span>${esc(CAT_LABEL(c))}</span></label>`).join('');
    for (const i of box.querySelectorAll('[data-c]')) {
      i.oninput = () => { st.colors[+i.dataset.c] = i.value; st.preset = 'custom'; setCatColors(st.colors); q('[data-k=preset]').value = 'custom'; };
      i.onchange = () => this.changed();
    }
  }
}

// ------------------------------------------------------------------ base map
/**
 * Base-map colours and lines inside `el`.
 *   items    [{key, name, layers: [ids] | () => ids, color: paint property, scale: property the
 *            size slider multiplies, scaleLayout: true when it is a layout property}]
 *   grid     id of the GeoJSON source holding the latitude / longitude lines (or null)
 */
export class MapStyle {
  constructor({ map, el, state, onChange = () => {}, items, grid = null }) {
    Object.assign(this, { map, el, onChange, grid });
    this.items = items;
    this.st = Object.assign(state, { items: {}, gridStep: 15, ...state });
    if (typeof this.st.items !== 'object' || !this.st.items) this.st.items = {};
    this.orig = new Map();
    this.build();
  }

  ids(item) { return (typeof item.layers === 'function' ? item.layers() : item.layers).filter((id) => this.map.getLayer(id)); }

  /** After the style (re)loads: note each layer's own values, then apply the user's. */
  attach() {
    this.orig.clear();
    for (const it of this.items) {
      for (const id of this.ids(it)) {
        const get = (p, layout) => (layout ? this.map.getLayoutProperty(id, p) : this.map.getPaintProperty(id, p));
        this.orig.set(`${id}|${it.color}`, get(it.color));
        if (it.scale) this.orig.set(`${id}|${it.scale}`, get(it.scale, it.scaleLayout));
      }
    }
    for (const it of this.items) this.applyItem(it);
    if (this.grid && this.st.gridStep !== 15) this.applyGrid();
    this.sync();
  }

  /** The layer's own colour of an item, as [hex, alpha] (the first layer that has one). */
  base(it) {
    for (const id of this.ids(it)) { const c = parseColor(this.orig.get(`${id}|${it.color}`)); if (c) return c; }
    return ['#ffffff', 1];
  }

  applyItem(it) {
    const o = this.st.items[it.key];
    for (const id of this.ids(it)) {
      const oc = this.orig.get(`${id}|${it.color}`), os = this.orig.get(`${id}|${it.scale}`);
      try {
        this.map.setPaintProperty(id, it.color, o && isHex(o.color) ? rgba(o.color, o.alpha ?? 1) : oc);
        if (it.scale) {
          const v = o && o.scale !== 1 ? scaled(os ?? (it.scaleDefault ?? 1), o.scale) : os;
          if (it.scaleLayout) this.map.setLayoutProperty(id, it.scale, v); else this.map.setPaintProperty(id, it.scale, v);
        }
      } catch (e) { console.warn('map style', id, e); }
    }
  }

  applyGrid() {
    const src = this.map.getSource(this.grid);
    if (src) src.setData(graticule(this.st.gridStep));
  }

  build() {
    const scales = [0.5, 0.75, 1, 1.5, 2, 3, 4];
    this.el.innerHTML = `
      <details class="fold">
        <summary>Map colours &amp; lines</summary>
        <div class="ms-grid">
          <span></span><span class="ms-h">Colour</span><span class="ms-h">Opacity</span><span class="ms-h">Size</span><span></span>
          ${this.items.map((it) => `
            <span class="ms-name" title="${esc(it.tip || '')}">${esc(it.name)}</span>
            <input type="color" data-i="${it.key}" data-p="color" aria-label="${esc(it.name)} colour">
            <input type="range" data-i="${it.key}" data-p="alpha" min="0" max="1" step="0.05" aria-label="${esc(it.name)} opacity">
            ${it.scale ? `<select data-i="${it.key}" data-p="scale" aria-label="${esc(it.name)} ${it.scaleName || 'size'}">${scales.map((s) => `<option value="${s}">${s}×</option>`).join('')}</select>` : '<span></span>'}
            <button type="button" class="ms-reset" data-i="${it.key}" data-p="reset" title="Back to the map's own" aria-label="Reset ${esc(it.name)}">↺</button>`).join('')}
        </div>
        ${this.grid ? `<label class="row" title="Spacing of the latitude / longitude grid">Grid spacing <select data-k="gridStep">${[5, 10, 15, 20, 30, 45].map((d) => `<option value="${d}">${d}°</option>`).join('')}</select></label>` : ''}
        <button type="button" class="btn sm ms-resetall">Reset all</button>
        <div class="note">Opacity and size multiply the map's own values; ↺ restores them.</div>
      </details>`;
    const byKey = Object.fromEntries(this.items.map((it) => [it.key, it]));
    for (const i of this.el.querySelectorAll('[data-i]')) {
      const it = byKey[i.dataset.i], p = i.dataset.p;
      const set = (save) => {
        if (p === 'reset') delete this.st.items[it.key];
        else {
          const cur = this.st.items[it.key] || (() => { const [color, alpha] = this.base(it); return { color, alpha, scale: 1 }; })();
          cur[p] = p === 'color' ? i.value : +i.value;
          this.st.items[it.key] = cur;
        }
        if (this.map) this.applyItem(it);
        if (save) { this.sync(); this.onChange(this.st); }
      };
      if (p === 'reset') i.onclick = () => set(true);
      else { i.oninput = () => set(false); i.onchange = () => set(true); }
    }
    const gs = this.el.querySelector('[data-k=gridStep]');
    if (gs) gs.onchange = () => { this.st.gridStep = +gs.value; this.applyGrid(); this.onChange(this.st); };
    this.el.querySelector('.ms-resetall').onclick = () => {
      this.st.items = {};
      this.st.gridStep = 15;
      for (const it of this.items) this.applyItem(it);
      if (this.grid) this.applyGrid();
      this.sync(); this.onChange(this.st);
    };
    this.sync();
  }

  sync() {
    for (const it of this.items) {
      const o = this.st.items[it.key], [c, a] = o ? [o.color, o.alpha] : this.base(it);
      const q = (p) => this.el.querySelector(`[data-i="${it.key}"][data-p="${p}"]`);
      q('color').value = isHex(c) ? c : '#ffffff';
      q('alpha').value = a ?? 1;
      if (q('scale')) q('scale').value = String(o?.scale ?? 1);
      q('reset').classList.toggle('on', !!o);
    }
    const gs = this.el.querySelector('[data-k=gridStep]');
    if (gs) gs.value = String(this.st.gridStep);
  }
}

/** Latitude / longitude lines every `step` degrees (densified to follow the globe); the
 *  equator and the prime meridian are the major lines. */
export function graticule(step) {
  const feats = [];
  const line = (c, major) => feats.push({ type: 'Feature', properties: { major }, geometry: { type: 'LineString', coordinates: c } });
  for (let lon = -180; lon < 180; lon += step) { const c = []; for (let lat = -85; lat <= 85; lat += 1) c.push([lon, lat]); line(c, lon === 0); }
  for (let lat = -90 + step; lat < 90; lat += step) {
    if (Math.abs(lat) > 85) continue;
    const c = [];
    for (let lon = -180; lon <= 180; lon += 1) c.push([lon, lat]);
    line(c, lat === 0);
  }
  return { type: 'FeatureCollection', features: feats };
}
