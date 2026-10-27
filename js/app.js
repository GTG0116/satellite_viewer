/* Satellite Viewer (static web edition): UI, state, loading and playback on a MapLibre map. */
import { SATS, products, CMAPS, buildLut, lutCss, rangeFor, SECTOR_NOTES, bandsOf, rolesOf, bandLabel, defaultSector, defaultProduct } from './catalog.js';
import { plan, scansFor, loadFrame, loadBands, estimateBytes, frameKey } from './scenes.js';
import { SatMap, unwrapLine } from './map.js';
import { autoTier, makeTier, lowerTier, FrameWatch } from './perf.js';
import { outline, gridCenter, resKm, lonlatToRC } from './geo.js';
import { setProxy, availableScans } from './listing.js';
import { Volume } from './volume.js';
import { loadPolarBox } from './polar.js';
import { glmFlashes } from './glm.js';
import * as OV from './overlays.js';
import { ModelTracks } from './tracks.js';
import { Recon } from './recon.js';
import { Sst } from './sst.js';
import { CycloneStyle, MapStyle } from './mapstyle.js';
// settings, device tier, decode workers and the first frame's download started before the map loaded
import { SETTINGS_KEY, device, tier, S, readHash, budget, currentPlan, pool, takeEarly, loopFrames } from './boot.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 60e3;

// ------------------------------------------------------------------ settings
let saveT = 0, hashT = 0, lastHash = '';
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...S, cam: sm ? sm.camera() : S.cam })); } catch (e) { /* storage unavailable */ }
  }, 400);
}

document.body.classList.add(`tier-${tier.name}`);

// ------------------------------------------------------------------ core objects
const cfg = globalThis.SATVIEW_CONFIG || {};
if (cfg.s3Proxy) setProxy(cfg.s3Proxy);
if (!device.gl2) {
  document.body.innerHTML = '<div class="nojs">Sorry — this browser has no WebGL 2, which the map needs. Try an up-to-date Chrome, Edge, Firefox or Safari.</div>';
  throw new Error('no WebGL 2');
}
const sm = new SatMap($('map'), { tier, theme: S.theme, globe: S.globe, labels: S.labels, camera: S.cam,
  onMove: () => { save(); hashSoon(); } });
const map = sm.map;
sm.smooth = !!S.smooth;
let frameSeq = 0;

// ------------------------------------------------------------------ helpers
function status(text) {
  if (text) { $('statusText').textContent = text; $('status').classList.remove('hidden'); $('loadbar').classList.add('on'); }
  else { $('status').classList.add('hidden'); $('loadbar').classList.remove('on'); }
}
let toastT;
function toast(msg, kind = 'error', ms = 6000) {
  const t = $('toast'); t.textContent = msg; t.className = kind === 'info' ? 'info' : '';
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
const p2 = (n) => String(n).padStart(2, '0');
const fmtTime = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}Z`;
function fmtAge(d) {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  const days = Math.floor(h / 24);
  return days < 365 ? `${days} days ago` : `${(days / 365.25).toFixed(1)} years ago`;
}
const fmtMB = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);
const satInfo = () => SATS[S.sat];
const prodList = () => products(S.sat);
const prodInfo = () => prodList().find((p) => p.id === S.product) || prodList()[0];
const isNarrow = () => innerWidth < 1100;

// ------------------------------------------------------------------ frames
const cache = new Map();       // frame key -> frame (its pixels live in a tile worker)
const byId = new Map();        // frame id -> frame
const loading = new Map();     // frame key -> promise
let cur = { plan: null, scans: [], idx: 0, token: 0, ac: null, fitted: '' };
let shown = null;              // frame on screen

const memUsed = () => { let s = 0; for (const f of cache.values()) s += f.memBytes || 0; return s; };

function evict() {
  const keep = new Set(cur.scans.map((s) => cur.plan && frameKey(cur.plan, s)));
  const lim = tier.memMB * 1e6, drop = [];
  for (const [k, f] of cache) {
    if (memUsed() <= lim * 0.9 && cache.size <= keep.size + 4) break;
    if (keep.has(k) || f === shown) continue;
    cache.delete(k); byId.delete(f.id); drop.push(f);
  }
  if (drop.length) sm.dropFrames(drop);
}

function getFrame(p, scan, pri, early = null) {
  const key = frameKey(p, scan);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (loading.has(key)) return loading.get(key);
  const pr = (early || loadFrame(p, scan, pool, { pri, signal: cur.ac?.signal })).then(async (f) => {
    f.id = ++frameSeq;
    await sm.putFrame(f);
    loading.delete(key);
    cache.set(key, f); byId.set(f.id, f);
    evict(); updateTicks();
    return f;
  }, (e) => { loading.delete(key); throw e; });
  loading.set(key, pr);
  return pr;
}

const scanAt = (i) => cur.scans[i];
const frameAt = (i) => (cur.plan && cur.scans[i] ? cache.get(frameKey(cur.plan, cur.scans[i])) : null);

// ------------------------------------------------------------------ reload
async function reload({ fit = false } = {}) {
  const token = ++cur.token;
  cur.ac?.abort();
  cur.ac = new AbortController();
  stopPlay();
  let p;
  try { p = currentPlan(); } catch (e) { toast(e.message, 'info'); return; }
  cur.plan = p;
  status('Listing scans…');
  let scans;
  try {
    if (S.archive) scans = sample(await scansFor(p, { end: new Date(S.archive.end), hours: S.archive.hours, signal: cur.ac.signal }), loopFrames());
    else scans = await scansFor(p, { limit: loopFrames(), signal: cur.ac.signal });
  } catch (e) {
    if (token !== cur.token) return;
    status(); toast(`Could not list scans: ${e.message}`); return;
  }
  if (token !== cur.token) return;
  if (!scans.length) {
    status();
    toast(S.archive ? 'No complete scans in this archive window for this product.' : 'No complete scan found yet for this sector / product.', 'info');
    return;
  }
  scans.sort((a, b) => a.t - b.t);
  cur.scans = scans;
  updateEstimates(scans[scans.length - 1]);
  const est = estimateBytes(p, scans[scans.length - 1]);
  if (est > tier.maxFrameMB * 1e6) {
    status();
    toast(`This product needs ≈${fmtMB(est)} per frame — too heavy for the ${tier.label} quality setting. Try a smaller sector (Japan / Target / Custom), an infrared product, or raise Quality in Settings.`, 'info', 9000);
    return;
  }
  renderTimeline();
  const last = scans.length - 1;
  cur.idx = last;
  status(`Loading ${prodInfo().name} · ≈${fmtMB(est)}`);
  const t0 = performance.now();
  try {
    const f = await getFrame(p, scans[last], 0, (await takeEarly(frameKey(p, scans[last])))?.frame);
    if (token !== cur.token) return;
    await show(last, { blend: false });
    // (a polar slice is somewhere else every time: always go to it)
    if (fit || f.track || cur.fitted !== `${S.sat}|${S.sector}|${S.bbox}`) { fitTo(f); cur.fitted = `${S.sat}|${S.sector}|${S.bbox}`; }
    perfInfo(f, performance.now() - t0);
  } catch (e) {
    if (token !== cur.token || /aborted/.test(e.message)) return;
    status();
    if (outOfMemory(e)) return;
    toast(`Loading failed: ${e.message}`); console.error(e); return;
  }
  status();
  preload(token);
}

// ------------------------------------------------------------------ weak devices
const isOOM = (e) => /allocation failed|out of memory|invalid array length|Array buffer/i.test(String(e && e.message || e));
/** The browser ran out of memory decoding a frame: step the quality down (auto) or halve the loop. */
function outOfMemory(e) {
  if (!isOOM(e)) return false;
  if (S.quality === 'auto' && tier.name !== 'low') {
    S.autoCap = lowerTier(tier.name);
    S.nFrames = Math.min(S.nFrames, makeTier(S.autoCap, device).defFrames);
    save();
    toast('This device ran out of memory — switching to lighter settings…', 'info', 4000);
    setTimeout(() => location.reload(), 1500);
  } else if (S.nFrames > 1) {
    S.nFrames = Math.max(1, Math.floor(S.nFrames / 2));
    buildFrames(); save();
    toast(`Out of memory — loop shortened to ${S.nFrames} frame${S.nFrames > 1 ? 's' : ''}.`, 'info', 5000);
    setTimeout(() => reload(), 300);
  } else toast('Out of memory — try a smaller sector or an infrared product.', 'error', 8000);
  return true;
}
// map frame times while it animates: a device too slow for its tier is stepped down (auto quality)
const frameWatch = new FrameWatch((ms) => {
  if (S.quality !== 'auto' || tier.name === 'low') return;
  S.autoCap = lowerTier(tier.name);
  save();
  sm.lighten();
  toast(`The map is running slowly here (${Math.round(1000 / ms)} fps) — lighter settings applied; the next visit starts at ${S.autoCap} quality.`, 'info', 7000);
});

function sample(all, n) {
  all = [...all].sort((a, b) => a.t - b.t);
  if (all.length <= n) return all;
  const k = all.length / n, out = [];
  for (let i = 0; i < n; i++) out.push(all[Math.min(all.length - 1, Math.round(all.length - 1 - (n - 1 - i) * k))]);
  return [...new Set(out)];
}

async function preload(token) {
  const p = cur.plan, n = cur.scans.length;
  if (n <= 1) return;
  let done = 1;
  status(`Loop frames 1/${n}`);
  let oom = false;
  await Promise.all(cur.scans.slice(0, -1).reverse().map((scan, j) => getFrame(p, scan, 2 + j).then(() => {
    done++;
    if (token === cur.token) status(done < n ? `Loop frames ${done}/${n}` : '');
  }).catch((e) => {
    if (/aborted/.test(e.message)) return;
    if (isOOM(e) && !oom && token === cur.token) { oom = true; cur.ac?.abort(); outOfMemory(e); }
    else console.warn('frame failed', e);
  })));
  if (token === cur.token) status();
}

// ------------------------------------------------------------------ showing frames
async function show(i, { blend = true } = {}) {
  const f = frameAt(i);
  cur.idx = i;
  updateTimeLabel(); updateTicks();
  if (!f) return;
  shown = f;
  await applyColour(f);
  const ms = blend && S.blend ? Math.min(S.blendMs, playing ? S.speed * 0.9 : S.blendMs) : 0;
  sm.setNight(f.time);
  updateOutline(f);
  updateLegend(f);
  updateGlm(f.time);
  overlayTime(f);
  vol.frameChanged(() => playing);
  await sm.showFrame(f, { blendMs: ms });
}
const showCurrent = () => show(cur.idx, { blend: false });

/** Value range of a frame under a colour table (the Day/Night Band's comes from each slice). */
const frameRange = (f, cm) => (f.range && !['ir_color', 'ir_rainbow', 'ir_bd', 'wv'].includes(cm) ? f.range : rangeFor(f.sat, f.ref.band, cm));

async function applyColour(f) {
  if (f.mode !== 'band') return;
  const cm = S.cmaps[S.product] || prodInfo().cmap;
  const [vmin, vmax] = frameRange(f, cm), below = CMAPS[cm].below || null;
  await sm.setColour(`${cm}|${vmin.toFixed(3)}|${vmax.toFixed(3)}|${f.ref.kind}`, buildLut(cm, vmin, vmax), f.ref.kind, vmin, vmax, below);
}

function updateOutline(f) {
  const feats = [];
  if (S.outline && f && f.track?.length > 1) feats.push({ type: 'Feature', properties: { active: true }, geometry: { type: 'LineString', coordinates: unwrapLine(f.track) } });
  else if (S.outline && f && f.sector !== 'full') { const o = outline(f.grid); if (o) feats.push({ type: 'Feature', properties: { active: true }, geometry: { type: 'LineString', coordinates: unwrapLine(o) } }); }
  if (S.sector === 'custom' && S.bbox) {
    const [w, s, e, n] = S.bbox;
    feats.push({ type: 'Feature', properties: { active: false }, geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } });
  }
  sm.setGeo('outline', { type: 'FeatureCollection', features: feats });
}

function fitTo(f) {
  const sat = satInfo();
  if (S.sector === 'full') { sm.flyTo({ center: [sat.lon, 0], zoom: 1.4, pitch: S.threeD ? 40 : 0, bearing: 0 }); return; }
  if (f.grid.proj === 'laea') {
    // a polar slice: its centre, zoomed to its size (a box would wrap around a pole)
    const km = Math.max(f.grid.nx, f.grid.ny) * Math.abs(f.grid.dx), px = Math.min(innerWidth - (isNarrow() ? 40 : 420), innerHeight - 180);
    const zoom = Math.max(1.5, Math.min(8, Math.log2((40075 * Math.cos(Math.min(80, Math.abs(f.grid.lat0)) * Math.PI / 180) * px) / (512 * km * 1.15))));
    sm.flyTo({ center: [f.grid.lon0, Math.max(-80, Math.min(80, f.grid.lat0))], zoom: S.globe ? Math.min(zoom, 4.2) : zoom, pitch: S.threeD ? 40 : 0, bearing: 0 });
    return;
  }
  let b;
  if (S.sector === 'custom' && S.bbox) b = S.bbox;
  else {
    const c = gridCenter(f.grid);
    if (!c) return;
    b = [c.lon - c.spanLon / 2, c.lat - c.spanLat / 2, c.lon + c.spanLon / 2, c.lat + c.spanLat / 2];
  }
  const narrow = innerWidth < 640;
  sm.fitBounds(b, { padding: narrow ? { top: 60, bottom: 110, left: 16, right: 16 } : { top: 70, bottom: 110, left: 40, right: isNarrow() ? 40 : 380 }, pitch: S.threeD ? 45 : 0, bearing: 0 });
}

// ------------------------------------------------------------------ playback
let playing = false, playT = 0;
function loadedIdx() { const out = []; for (let i = 0; i < cur.scans.length; i++) if (frameAt(i)) out.push(i); return out; }
function startPlay() {
  if (cur.scans.length < 2) { toast('Choose a loop length above 1 frame in Settings', 'info', 3000); return; }
  playing = true; setPlayIcon();
  const tick = async () => {
    if (!playing) return;
    const L = loadedIdx();
    if (L.length < 2) { playT = setTimeout(tick, 300); return; }
    const pos = L.indexOf(cur.idx);
    const next = pos < 0 || pos === L.length - 1 ? L[0] : L[pos + 1];
    const t0 = performance.now();
    await show(next, { blend: pos !== L.length - 1 });   // waits until the frame's tiles are on screen
    if (!playing) return;
    // the frame after it loads its tiles while this one is on screen
    const L2 = loadedIdx();
    sm.prefetch(frameAt(L2[(L2.indexOf(next) + 1) % L2.length]));
    const dwell = next === L[L.length - 1] ? S.speed * 4 : S.speed;
    playT = setTimeout(tick, Math.max(0, dwell - (performance.now() - t0)));
  };
  tick();
}
function stopPlay() { playing = false; clearTimeout(playT); setPlayIcon(); sm.cancelPrefetch(); }
function setPlayIcon() {
  $('playIcon').innerHTML = playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>' : '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>';
  $('playBtn').setAttribute('aria-label', playing ? 'Pause loop' : 'Play loop');
}
function step(d) {
  stopPlay();
  const L = loadedIdx(); if (!L.length) return;
  const pos = Math.max(0, L.indexOf(cur.idx));
  show(L[(pos + d + L.length) % L.length]);
}

// ------------------------------------------------------------------ timeline
function renderTimeline() {
  const n = cur.scans.length;
  $('tlRange').max = Math.max(0, n - 1);
  const ticks = $('tlTicks');
  ticks.innerHTML = '';
  for (let i = 0; i < n; i++) { const t = document.createElement('i'); t.style.left = `${n > 1 ? (i / (n - 1)) * 100 : 100}%`; ticks.appendChild(t); }
  updateTicks(); updateTimeLabel();
}
function updateTicks() {
  const els = $('tlTicks').children;
  for (let i = 0; i < els.length; i++) els[i].className = (i === cur.idx ? 'cur ' : '') + (frameAt(i) ? 'ok' : '');
  $('tlRange').value = cur.idx;
}
function updateTimeLabel() {
  const s = scanAt(cur.idx);
  if (!s) { $('timeMain').textContent = '—'; return; }
  $('timeMain').textContent = fmtTime(s.t);
  $('timeAge').textContent = fmtAge(s.t);
  const lb = $('liveBadge');
  lb.textContent = S.archive ? 'ARCHIVE' : 'LIVE';
  lb.className = S.archive ? 'badge arc' : 'badge';
}
setInterval(updateTimeLabel, 30e3);

// ------------------------------------------------------------------ legend / probe
function updateLegend(f) {
  const lg = $('legend');
  if (!f || f.mode !== 'band') { lg.classList.add('hidden'); return; }
  const pi = prodInfo(), cm = S.cmaps[S.product] || pi.cmap;
  const [vmin, vmax] = frameRange(f, cm), kind = f.ref.kind, pct = kind === 'refl';
  $('legendTitle').textContent = `${pi.name} · ${pi.label}`;
  $('legendBar').style.background = lutCss(cm, vmin, vmax);
  const el = $('legendTicks');
  el.classList.toggle('abs', !pct);
  const at = (v, txt) => { const p = ((v - vmin) / (vmax - vmin)) * 100; return `<span style="left:${p.toFixed(1)}%;transform:translateX(-${p.toFixed(1)}%)">${txt}</span>`; };
  if (kind === 'logrr') {
    el.innerHTML = [0.1, 0.5, 2, 6, 16, 60].map((v, i, a) => at(Math.log10(v), `${v}${i === a.length - 1 ? ' mm/h' : ''}`)).join('');
  } else if (kind === 'tpw') {
    el.innerHTML = [0, 15, 30, 45, 60, 75].filter((v) => v >= vmin && v <= vmax).map((v) => at(v, `${v}${v === 75 ? ' mm' : ''}`)).join('');
  } else if (kind === 'lograd') {
    el.innerHTML = `${at(vmin, 'dim')}${at(vmax, 'bright')}`;
  } else if (kind === 'mwbt') {
    const step = vmax - vmin > 100 ? 40 : 20, out = [];
    for (let v = Math.ceil(vmin / step) * step; v <= vmax + 1e-9; v += step) out.push(at(v, `${v}${v + step > vmax ? ' K' : ''}`));
    el.innerHTML = out.join('');
  } else if (pct) {
    const ticks = [];
    for (let i = 0; i <= 4; i++) ticks.push(`${Math.round((vmin + (vmax - vmin) * i / 4) * 100)}%`);
    el.innerHTML = ticks.map((t) => `<span>${t}</span>`).join('');
  } else {
    // brightness temperatures in °C, at round values (a label's anchor slides from its left
    // edge at the bar's start to its right edge at the end, so none overflow the legend)
    const lo = vmin - 273.15, hi = vmax - 273.15, step = hi - lo > 100 ? 30 : hi - lo > 50 ? 20 : 10, out = [];
    for (let c = Math.ceil(lo / step) * step; c <= hi + 1e-9; c += step) {
      const p = ((c - lo) / (hi - lo)) * 100;
      out.push(`<span style="left:${p.toFixed(1)}%;transform:translateX(-${p.toFixed(1)}%)">${c}${c + step > hi ? ' °C' : ''}</span>`);
    }
    el.innerHTML = out.join('');
  }
  lg.classList.remove('hidden');
}

let probeSeq = 0, probeHide = 0, probeRaf = 0;
async function probeAt(lngLat, sticky) {
  const pr = $('probe');
  if (!lngLat) { if (!sticky) pr.classList.add('hidden'); return; }
  const seq = ++probeSeq;
  const lon = ((lngLat.lng + 540) % 360) - 180, lat = lngLat.lat;
  let txt = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  const f = shown;
  if (f) {
    const r = await sm.probe(f, lon, lat);
    if (seq !== probeSeq) return;
    if (!r || r.value === undefined) txt += ' · outside image';
    else {
      const bn = bandsOf(f.sat)[r.band], label = `${bandLabel(f.sat, r.band)} ${bn ? bn[1] + ' µm' : ''}`;
      const v = r.value;
      const fmt = { refl: () => `${(v * 100).toFixed(1)}%`, mwbt: () => `${v.toFixed(1)} K`, tpw: () => `${v.toFixed(1)} mm`,
        logrr: () => (v <= -1.99 ? 'no rain' : `${(10 ** v).toFixed(v < 0 ? 2 : 1)} mm/h`), lograd: () => `${(10 ** v).toExponential(2)} W/cm²/sr` }[r.kind];
      txt += v !== v ? ` · <b>${label}</b> no data` : ` · <b>${label}</b> ${fmt ? fmt() : `${v.toFixed(1)} K (${(v - 273.15).toFixed(1)} °C)`}`;
      if (r.rgb) txt += ` <span style="display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;background:rgb(${r.rgb})"></span>`;
    }
  }
  pr.innerHTML = txt;
  pr.classList.remove('hidden');
  clearTimeout(probeHide);
  if (sticky) probeHide = setTimeout(() => pr.classList.add('hidden'), 5000);
}
map.on('mousemove', (e) => {
  if (drawState || vol.tool || e.originalEvent.buttons) return;
  cancelAnimationFrame(probeRaf);
  probeRaf = requestAnimationFrame(() => probeAt(e.lngLat, false));
});
map.getCanvasContainer().addEventListener('mouseleave', () => $('probe').classList.add('hidden'));
map.on('click', (e) => {
  if (drawState || vol.tool) return;
  const touch = e.originalEvent && e.originalEvent.pointerType && e.originalEvent.pointerType !== 'mouse';
  if (touch || matchMedia('(hover: none)').matches) probeAt(e.lngLat, true);
  if (document.body.classList.contains('panel-open')) togglePanel(false);
});

// ------------------------------------------------------------------ overlays: lightning, cyclones
let glmWant = null, glmBusy = false;
/** GLM flashes of the minutes before a frame's time (while one request runs, the latest wins). */
function updateGlm(t) {
  glmWant = S.glm && t ? t : null;
  if (!S.glm) { OV.setGlm(map, null); $('glmInfo').textContent = ''; return; }
  if (glmBusy || !glmWant) return;
  glmBusy = true;
  (async () => {
    while (glmWant && S.glm) {
      const want = glmWant;
      glmWant = null;
      try {
        const d = await glmFlashes(want, S.glmMin, pool);
        if (!S.glm) break;
        const n = OV.setGlm(map, d, S.glmMin);
        $('glmInfo').textContent = d.sats.length ? `${n.toLocaleString()}` : 'none';
        $('glmInfo').title = d.sats.length ? `${n} flashes from ${d.sats.map((s) => SATS[s]?.name || s).join(' + ')} (${d.files} files)` : 'No GLM data at this time (GLM data starts in 2017)';
      } catch (e) { console.warn('GLM', e); $('glmInfo').textContent = '—'; }
    }
    glmBusy = false;
    if (!S.glm) OV.setGlm(map, null);
  })();
}

let storms = null, stormsT = 0;
async function loadStorms() {
  stormsT = Date.now();
  try {
    storms = await OV.fetchStorms();
    if (storms.errors.length) console.warn('cyclones', storms.errors);
  } catch (e) { console.warn('cyclones', e); storms = { storms: [], fc: null, errors: [e.message] }; }
  OV.setStorms(map, storms.fc);
  renderStorms();
  tracks?.regroup(); // names for the model tracks' storms
}
/** Cyclones show in live mode (the agencies publish current storms only). */
function syncStorms() {
  const on = S.storms && !S.archive;
  OV.showLayers(map, 'storms', on);
  if (on && (!storms || Date.now() - stormsT > 10 * 60e3)) loadStorms();
  renderStorms();
}
function renderStorms() {
  const el = $('stormList');
  el.innerHTML = '';
  const note = (t) => { const d = document.createElement('div'); d.className = 'note'; d.textContent = t; el.appendChild(d); };
  if (!S.storms) return;
  if (S.archive) { note('Current storms show in Live mode.'); return; }
  if (!storms) { note('Loading active storms…'); return; }
  if (!storms.storms.length) note(storms.errors.length ? 'Storm data unavailable right now.' : 'No active tropical cyclones.');
  for (const s of storms.storms) {
    const c = OV.category(s.kt), b = document.createElement('button');
    b.className = 'storm';
    b.innerHTML = `<i style="background:${c.color}"></i><span><b></b><small></small></span>`;
    b.querySelector('b').textContent = s.name;
    b.querySelector('small').textContent = `${s.agency} · ${OV.fmtWind(s.kt)}${s.mb ? ` · ${s.mb} mb` : ''} · ${c.label}`;
    b.onclick = () => { sm.flyTo({ center: s.now, zoom: Math.max(map.getZoom(), 4.5) }); if (innerWidth < 640) togglePanel(false); };
    el.appendChild(b);
  }
}
setInterval(() => { if (S.storms && !S.archive && !document.hidden) loadStorms(); }, 15 * 60e3);

function addOverlays() {
  OV.addLayers(map, { font: ['Noto Sans Regular'], before: 'outline' });
  OV.showLayers(map, 'glm', S.glm);
  OV.showLayers(map, 'storms', S.storms && !S.archive);
  tracks?.attach();
  recon?.attach();
  sst?.attach();
  mapStyle?.attach();
}

// intensity colours and the storms' style (mapstyle.js): applied before anything is drawn
new CycloneStyle({ el: $('csPanel'), state: S.tcstyle, onChange: save });
OV.onStyle(() => renderStorms());

// Hurricane Hunter recon (recon.js, over the storms), Coral Reef Watch SST (sst.js, behind the
// imagery under the night shading, or over it under the lines), base-map colours (mapstyle.js)
let recon = null, sst = null, mapStyle = null;
function startExtras() {
  const fly = (lon, lat, z) => { sm.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), z) }); if (innerWidth < 640) togglePanel(false); };
  recon = new Recon({ map, el: $('rcPanel'), state: S.recon, onChange: save, proxy: cfg.tcProxy || null, font: ['Noto Sans Regular'], before: 'outline',
    fly: (lon, lat) => fly(lon, lat, 5.5) });
  sst = new Sst({ map, el: $('sstPanel'), state: S.sst, onChange: save, proxy: cfg.tcProxy || null, under: 'night', over: 'graticule' });
  const line = (key, name, layers) => ({ key, name, layers, color: 'line-color', scale: 'line-width', scaleName: 'width' });
  const labels = ['label-city', 'label-state', 'label-country'];
  mapStyle = new MapStyle({ map, el: $('msPanel'), state: S.mapstyle, onChange: save, grid: 'graticule', items: [
    line('coast', 'Coastlines', ['coast']),
    line('country', 'Country borders', ['boundary-country']),
    line('state', 'State lines', ['boundary-state']),
    line('grid', 'Lat / lon grid', ['graticule']),
    { key: 'water', name: 'Ocean', layers: ['water'], color: 'fill-color' },
    { key: 'land', name: 'Land / background', layers: ['background'], color: 'background-color' },
    { key: 'labels', name: 'Place labels', layers: labels, color: 'text-color', scale: 'text-size', scaleLayout: true, scaleDefault: 16 },
    { key: 'halo', name: 'Label halo', layers: labels, color: 'text-halo-color', scale: 'text-halo-width', scaleName: 'width' },
    { key: 'night', name: 'Night side', layers: ['night'], color: 'fill-color', scale: 'fill-opacity', scaleName: 'strength', tip: 'Colour and strength of the night shading' },
  ] });
}

/** Recon and SST follow the shown frame: the trail before its time, the SST of its day. */
function overlayTime(f) {
  const t = f.time.getTime(), ts = cur.scans.map((s) => +s.t).filter(isFinite);
  recon?.setTime(t, { start: ts.length ? Math.min(...ts) : t, end: ts.length ? Math.max(...ts) : t, live: !S.archive });
  sst?.setTime(t, { live: !S.archive });
}

// ensemble model tracks (tracks.js): the controls under the storm list, any mode
let tracks = null;
function startTracks() {
  tracks = new ModelTracks({ map, el: $('mtPanel'), state: S.mtracks, onChange: save, proxy: cfg.tcProxy || null,
    names: () => (storms?.storms || []).map((s) => ({ name: s.name, now: s.now, t: s.t })),
    fly: (lon, lat) => { sm.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 3.5) }); if (innerWidth < 640) togglePanel(false); },
    font: ['Noto Sans Regular'], before: 'outline' });
}

// ------------------------------------------------------------------ custom sector box
let drawState = null;
function startDraw() {
  drawState = { a: null };
  map.dragPan.disable(); map.touchZoomRotate.disable(); map.boxZoom.disable();
  document.body.classList.add('drawing');
  $('drawHint').innerHTML = 'Drag on the map to draw a box · <button id="drawCancel" class="link">Cancel</button>';
  $('drawHint').classList.remove('hidden');
  $('drawCancel').onclick = endDraw;
  if (isNarrow()) togglePanel(false);
}
function endDraw() {
  drawState = null;
  map.dragPan.enable(); map.touchZoomRotate.enable(); map.boxZoom.enable();
  document.body.classList.remove('drawing');
  $('drawHint').classList.add('hidden');
  sm.setGeo('drawbox', null);
}
function boxFromDrag(a, b) {
  let x = b.lng; while (x - a.lng > 180) x -= 360; while (x - a.lng < -180) x += 360;
  return [Math.min(a.lng, x), Math.min(a.lat, b.lat), Math.max(a.lng, x), Math.max(a.lat, b.lat)];
}
const boxFC = ([w, s, e, n]) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }] });
const drawDown = (e) => { if (drawState) { drawState.a = e.lngLat; e.preventDefault(); } };
const drawMove = (e) => { if (drawState?.a) sm.setGeo('drawbox', boxFC(boxFromDrag(drawState.a, e.lngLat))); };
const drawUp = (e) => {
  if (!drawState?.a) return;
  const [w, s, ee, n] = boxFromDrag(drawState.a, e.lngLat);
  endDraw();
  if (ee - w < 0.3 || n - s < 0.3) { toast('Box too small — drag a larger area', 'info', 3000); return; }
  const norm = (x) => ((x + 540) % 360) - 180, shift = norm(w) - w;
  S.bbox = [+(w + shift).toFixed(3), +s.toFixed(3), +(ee + shift).toFixed(3), +n.toFixed(3)];
  $('bboxText').textContent = S.bbox.map((v) => v.toFixed(1)).join(', ');
  save(); reload({ fit: true });
};
map.on('mousedown', drawDown); map.on('touchstart', drawDown);
map.on('mousemove', drawMove); map.on('touchmove', drawMove);
map.on('mouseup', drawUp); map.on('touchend', drawUp);

// ------------------------------------------------------------------ 3D volume
const vol = new Volume({
  satMap: sm, tier, toast,
  currentFrame: () => shown,
  loopFrames: () => cur.scans.map((s, i) => frameAt(i)).filter(Boolean).map((f) => ({ time: f.time.toISOString(), sceneId: f.id })),
  showFrameAt: (t) => { const i = cur.scans.findIndex((s) => s.t.toISOString() === t); if (i >= 0) show(i, { blend: false }); },
  satName: () => satInfo().name, productName: () => prodInfo().name,
  fields: volumeFields,
  onLayout: () => layoutVars(),
});

/** Cloud fields for a 3D region: the bands the retrieval needs, at native resolution inside the box. */
async function volumeFields(r, progress = () => {}) {
  const f = byId.get(r.sceneId) || shown;
  if (!f) throw new Error('frame not loaded');
  if (SATS[f.sat].kind === 'polar') return polarVolumeFields(f, r, progress);
  const roles = rolesOf(f.sat);
  const want = { ir: roles.ir103, red: roles.red, snow: roles.snow, swir: roles.swir, ir12: roles.ir123 };
  const bandList = [...new Set(Object.values(want))];
  let [w, s, e, n] = r.bbox;
  const pad = 0.04 * Math.max(e - w, n - s) + 0.05;
  const bbox = [w - pad, Math.max(-80, s - pad), e + pad, Math.min(80, n + pad)];
  const res = tier.name === 'high' ? 'native' : S.resolution;
  // the shown sector when it is a small native one holding the box (same scan), else a custom box
  const inside = (g) => [[w, s], [e, s], [e, n], [w, n]].every(([x, y]) => { const o = lonlatToRC(g, ((x + 540) % 360) - 180, y); return o && o[0] >= 0 && o[1] >= 0 && o[0] < g.ny && o[1] < g.nx; });
  let sector = 'custom', scan = null;
  if (['meso1', 'meso2', 'target', 'japan', 'la'].includes(f.sector) && inside(f.grid)) { sector = f.sector; scan = f.scan; }
  const budget3 = { maxTex: 8192, framePx: tier.name === 'low' ? 4e6 : tier.name === 'medium' ? 9e6 : 25e6 };
  const p = plan({ sat: f.sat, sector, resolution: res, bbox: sector === 'custom' ? bbox : null, bandList }, budget3);
  if (!scan) {
    progress('Finding the matching full-disk scan…');
    const end = new Date(f.time.getTime() + 11 * 60e3);
    const scans = await availableScans(f.sat, 'custom', p.family, p.bands, { end, hours: 0.6 });
    if (!scans.length) throw new Error('no full-disk scan near this time');
    scan = scans.reduce((a, b) => (Math.abs(b.t - f.time) < Math.abs(a.t - f.time) ? b : a));
  }
  const est = estimateBytes(p, scan);
  progress(`Loading satellite bands · ≈${fmtMB(est)}…`);
  const { bandData } = await loadBands(p, scan, pool, { pri: 0 });
  progress('Retrieving cloud tops, bases and optical depth…');
  const bands = {}, transfer = [];
  for (const [role, b] of Object.entries(want)) {
    const d = bandData[b];
    if (!d) continue;
    const codes = transfer.includes(d.codes.buffer) ? d.codes.slice() : d.codes;
    transfer.push(codes.buffer);
    bands[role] = { codes, w: d.w, h: d.h, grid: d.grid, kind: d.kind, resKm: resKm(d.grid) };
  }
  const SRC = { cmip: 'ABI-L2-MCMIP', l1b: 'ABI-L1b-Rad', ahi: 'AHI-L1b HSD', ami: 'AMI-L1B NetCDF' };
  const sources = Object.entries(want).filter(([role]) => bands[role]).map(([role, b]) => ({ role, product: bandLabel(f.sat, b),
    time: scan.t.toISOString(), source: SRC[p.family], res_km: +bands[role].resKm.toFixed(2) }));
  return pool.run('retrieve3d', { bands, bbox: r.bbox, time: scan.t.toISOString(), sat: f.sat, sector, sources }, { pri: 0, transfer });
}

/** Polar slices: VIIRS I5 + I1 of the granules crossing the box (whatever product the map shows). */
async function polarVolumeFields(f, r, progress) {
  progress('Finding the VIIRS granules that cross the box…');
  const { bands, time, granules } = await loadPolarBox(f.sat, f.time, f.plan?.minutes || 5, r.bbox, pool, { progress });
  progress('Retrieving cloud tops, bases and optical depth…');
  const sources = Object.entries(bands).map(([role, b]) => ({ role, product: role === 'ir' ? 'I5' : 'I1', time: time.toISOString(),
    source: `VIIRS SDR · ${granules} granule${granules > 1 ? 's' : ''}`, res_km: +b.resKm.toFixed(2) }));
  return pool.run('retrieve3d', { bands, bbox: r.bbox, time: time.toISOString(), sat: f.sat, sector: 'swath', sources },
    { pri: 0, transfer: Object.values(bands).map((b) => b.codes.buffer) });
}

// ------------------------------------------------------------------ UI: lists
function swatch(p) {
  if (p.kind === 'rgb') {
    const c = { geocolor: '#4b7bd8,#e8e2c8', truecolor: '#3d6fb5,#d9cfa8', natural: '#31a3c9,#e0f0ff', airmass: '#c0362c,#2f5ec4',
      dcp: '#e06ef0,#ffe14a', daycon: '#f0d040,#3050d0', nightmicro: '#e0c0a0,#90a8c8', dust: '#ff40c0,#203040', ash: '#e0f040,#2070c0',
      fire: '#ff3020,#203010', simplewv: '#f0f0f0,#2050a0', sandwich: '#d8d8d8,#ff4040', v_truecolor: '#3d6fb5,#d9cfa8', v_natural: '#31a3c9,#e0f0ff' }[p.id] || '#999,#333';
    return `linear-gradient(135deg, ${c})`;
  }
  const [vmin, vmax] = rangeFor(S.sat, p.band, p.cmap);
  return lutCss(p.cmap, vmin, vmax, 8);
}
function buildSats() {
  const el = $('satList'); el.innerHTML = '';
  for (const [id, s] of Object.entries(SATS)) {
    // legacy satellites only exist in the archive: listed in archive mode only
    if (s.retired && !S.archive) continue;
    const b = document.createElement('button');
    b.className = `sat-card${id === S.sat ? ' on' : ''}${s.retired ? ' retired' : ''}`;
    b.innerHTML = `<b>${s.name}</b><span>${s.sub}</span>`;
    b.onclick = () => selectSat(id);
    el.appendChild(b);
  }
}
function buildSectors() {
  const el = $('sectorList'); el.innerHTML = '';
  for (const [id, name] of satInfo().sectors) {
    const b = document.createElement('button');
    b.textContent = name; b.className = id === S.sector ? 'on' : '';
    b.onclick = () => selectSector(id);
    el.appendChild(b);
  }
  $('sectorNote').textContent = SECTOR_NOTES[S.sector] || '';
  $('customTools').classList.toggle('hidden', S.sector !== 'custom');
  $('bboxText').textContent = S.bbox ? S.bbox.map((v) => v.toFixed(1)).join(', ') : 'no box yet';
}
let estimates = {};
function buildProducts() {
  const list = prodList();
  const groups = ['all', ...new Set(list.map((p) => p.group))];
  // the saved filter, unless this satellite has no such group
  const groupFilter = groups.includes(S.group) ? S.group : 'all';
  const ge = $('prodGroups'); ge.innerHTML = '';
  for (const g of groups) {
    const b = document.createElement('button');
    b.textContent = g === 'all' ? 'All' : g; b.className = g === groupFilter ? 'on' : '';
    b.onclick = () => { S.group = g; save(); buildProducts(); };
    ge.appendChild(b);
  }
  const q = $('prodSearch').value.trim().toLowerCase();
  const el = $('prodList'); el.innerHTML = '';
  for (const p of list) {
    if (groupFilter !== 'all' && p.group !== groupFilter) continue;
    if (q && !`${p.name} ${p.label || ''} ${p.desc}`.toLowerCase().includes(q)) continue;
    const b = document.createElement('button');
    const est = estimates[p.id], heavy = est > tier.maxFrameMB * 1e6;
    b.className = `prod${p.id === S.product ? ' on' : ''}${heavy ? ' heavy' : ''}`;
    b.setAttribute('role', 'option'); b.setAttribute('aria-selected', p.id === S.product);
    b.innerHTML = `<span class="sw" style="background:${swatch(p)}"></span><span><span class="pn">${p.name}</span><span class="pd">${p.label ? p.label + ' · ' : ''}${p.desc}</span></span>${est ? `<span class="sz" title="Download per frame">${fmtMB(est)}</span>` : ''}`;
    b.onclick = () => selectProduct(p.id);
    el.appendChild(b);
  }
}
function updateEstimates(scan) {
  estimates = {};
  if (SATS[S.sat].kind === 'polar') { if (cur.plan) estimates[S.product] = estimateBytes(cur.plan, scan); buildProducts(); return; }
  for (const p of prodList()) {
    try {
      const pl = plan({ sat: S.sat, sector: S.sector, product: p.id, resolution: S.resolution, bbox: S.bbox }, budget(p.kind === 'rgb'));
      if (SATS[S.sat].kind === 'goes' && pl.family === 'cmip' && !scan.bands[0]) continue;
      estimates[p.id] = estimateBytes(pl, scan);
    } catch (e) { /* product unavailable here */ }
  }
  buildProducts();
}
function buildCmaps() {
  const p = prodInfo(), row = $('cmapRow');
  if (p.kind === 'rgb') { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  const sel = $('cmapSel'); sel.innerHTML = '';
  for (const c of p.cmaps) { const o = document.createElement('option'); o.value = c; o.textContent = CMAPS[c].label; sel.appendChild(o); }
  sel.value = S.cmaps[S.product] || p.cmap;
}
function buildFrames() {
  const sel = $('framesSel'); sel.innerHTML = '';
  for (const n of [1, 6, 12, 24, 36, 48, 72, 120]) {
    if (n > tier.maxFrames) continue;
    const o = document.createElement('option'); o.value = n; o.textContent = n === 1 ? 'Latest only' : `${n} frames`; sel.appendChild(o);
  }
  if (![...sel.options].some((o) => +o.value === S.nFrames)) { const o = document.createElement('option'); o.value = S.nFrames; o.textContent = `${S.nFrames} frames`; sel.appendChild(o); }
  sel.value = S.nFrames;
}

// ------------------------------------------------------------------ selections
function selectSat(id) {
  if (id === S.sat) return;
  S.sat = id;
  if (!satInfo().sectors.some((s) => s[0] === S.sector)) S.sector = defaultSector(id);
  if (!prodList().some((p) => p.id === S.product)) S.product = defaultProduct(id);
  // AHI / AMI full disks have no 2 km multi-band file: visible composites are far too heavy there
  if (SATS[id].kind !== 'goes' && S.sector === 'full' && tier.name !== 'high' && ['geocolor', 'truecolor', 'natural', 'dcp', 'daycon', 'sandwich', 'fire'].includes(S.product)) S.product = tier.name === 'low' ? 'b13' : 'airmass';
  if (SATS[id].retired && !S.archive) startArchive(true);
  estimates = {};
  buildSats(); buildSectors(); buildProducts(); buildCmaps(); syncArchive();
  save(); reload({ fit: true });
}
function selectSector(id) {
  S.sector = id; estimates = {};
  buildSectors(); buildProducts(); save();
  if (id === 'custom' && !S.bbox) { startDraw(); return; }
  reload({ fit: true });
}
function selectProduct(id) {
  S.product = id;
  buildProducts(); buildCmaps(); save();
  reload();
  if (innerWidth < 640) togglePanel(false);
}

// ------------------------------------------------------------------ archive
function syncArchive() {
  const on = !!S.archive;
  $('archiveBar').classList.toggle('hidden', !on);
  buildSats();
  for (const b of $('modeSeg').children) b.classList.toggle('on', (b.dataset.m === 'archive') === on);
  const sat = satInfo(), inp = $('arcEnd');
  inp.min = `${sat.start}T00:00`;
  inp.max = (sat.end ? new Date(sat.end) : new Date()).toISOString().slice(0, 16);
  if (on) { inp.value = new Date(S.archive.end).toISOString().slice(0, 16); $('arcSpan').value = S.archive.hours; }
  syncStorms();
  layoutVars();
}
function startArchive(silent) {
  const sat = satInfo();
  const end = sat.end ? new Date(`${sat.end}T00:00:00Z`) : new Date(Date.now() - 24 * 3600e3);
  S.archive = { end: end.toISOString(), hours: 3 };
  syncArchive();
  if (!silent) { save(); reload(); }
}
function stopArchive() {
  const sat = satInfo();
  S.archive = null;
  // a retired satellite has no live data: going live switches to the satellite that replaced it
  if (sat.retired) { selectSat(sat.successor); return; }
  syncArchive(); save(); reload();
}
function arcLoad(dir = 0) {
  const v = $('arcEnd').value;
  if (!v) return;
  const hours = +$('arcSpan').value;
  const end = Math.min(new Date(`${v}:00Z`).getTime() + dir * hours * 3600e3, Date.now());
  S.archive = { end: new Date(end).toISOString(), hours };
  syncArchive(); save(); reload();
}

// ------------------------------------------------------------------ panel: side panel / drawer / bottom sheet
function togglePanel(open) {
  const p = $('panel'), desktop = !isNarrow();
  if (open === undefined) open = desktop ? p.classList.contains('collapsed') : !p.classList.contains('open');
  if (desktop) { p.classList.toggle('collapsed', !open); document.body.classList.toggle('panel-collapsed', !open); S.panelCollapsed = !open; save(); }
  else { p.classList.toggle('open', open); document.body.classList.toggle('panel-open', open); }
  $('btnPanel').setAttribute('aria-expanded', String(open));
  $('btnPanel').classList.toggle('on', open);
}
function selectTab(t) {
  if (!document.querySelector(`.tabs button[data-tab="${t}"]`)) t = 'data';
  S.tab = t; save();
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === t);
  for (const s of document.querySelectorAll('.panel-body section')) s.classList.toggle('on', s.dataset.tab === t);
}
(function sheetDrag() {
  const grip = $('grip'), panel = $('panel');
  let y0 = null;
  grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; grip.setPointerCapture(e.pointerId); panel.style.transition = 'none'; });
  grip.addEventListener('pointermove', (e) => { if (y0 !== null) panel.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`; });
  const end = (e) => {
    if (y0 === null) return;
    const d = e.clientY - y0; y0 = null; panel.style.transition = ''; panel.style.transform = '';
    if (d > 70 || Math.abs(d) < 4) togglePanel(false);
  };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
})();

// ------------------------------------------------------------------ 3D on the map
function set3D(on) {
  S.threeD = on; $('threeChk').checked = on;
  sm.set3D({ cloud: on, cloudExag: S.exag });
  if (on && map.getPitch() < 20) map.easeTo({ pitch: 50, duration: 700 });
  save();
}
function setTerrain(on) {
  S.terrain = on; $('terrainChk').checked = on;
  sm.set3D({ ground: on, groundExag: S.terrainExag });
  if (on && map.getPitch() < 20) map.easeTo({ pitch: 50, duration: 700 });
  save();
}
function view(v) {
  if (v === 'top') map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  if (v === 'tilt') map.easeTo({ pitch: 50, duration: 600 });
  if (v === 'low') map.easeTo({ pitch: 70, duration: 700 });
  if (v === 'spin') map.easeTo({ bearing: map.getBearing() + 90, duration: 800 });
}

// ------------------------------------------------------------------ perf info / fps
function perfInfo(f, ms) {
  $('perfInfo').innerHTML = [
    `Quality: <b>${tier.label}</b>${S.quality === 'auto' ? (S.autoCap && S.autoCap !== autoTier(device) ? ' (auto, lowered after this device struggled)' : ' (auto)') : ''} · max texture ${device.maxTex}`,
    `${device.renderer ? device.renderer.slice(0, 64) : 'GPU'} · ${device.cores} threads${device.mem ? ` · ${device.mem} GB` : ''}`,
    f ? `Frame ${f.w}×${f.h} @ ${resKm(f.grid).toFixed(2)} km · ${fmtMB(f.bytes)} downloaded · ${Math.round(ms || f.ms)} ms` : '',
    `Decoded frames ${fmtMB(memUsed())} of ${tier.memMB} MB · ${tier.workers} decode + ${tier.tileWorkers} tile workers`,
  ].filter(Boolean).join('<br>');
}
let fpsN = 0, fpsT = performance.now();
map.on('render', () => {
  // (not while the 3D view shares the GPU: its ray marching would count against the map)
  if (S.quality === 'auto' && tier.name !== 'low' && !document.hidden && !vol.on) frameWatch.tick();
  if (!S.fps) return;
  fpsN++;
  const now = performance.now();
  if (now - fpsT > 1000) { $('fps').textContent = `${Math.round(fpsN * 1000 / (now - fpsT))} fps (renders/s)`; fpsN = 0; fpsT = now; }
});

// ------------------------------------------------------------------ URL hash
function hashSoon() { clearTimeout(hashT); hashT = setTimeout(writeHash, 600); }
function writeHash() {
  const c = sm.camera();
  const h = new URLSearchParams({ sat: S.sat, sec: S.sector, p: S.product,
    cam: [c.center[0].toFixed(2), c.center[1].toFixed(2), c.zoom.toFixed(2), Math.round(c.bearing), Math.round(c.pitch)].join(',') });
  if (S.bbox && S.sector === 'custom') h.set('bbox', S.bbox.join(','));
  if (S.archive) { h.set('end', S.archive.end.slice(0, 16)); h.set('span', S.archive.hours); }
  lastHash = h.toString();
  history.replaceState(null, '', `#${lastHash}`);
}

// ------------------------------------------------------------------ bind UI
function bind() {
  $('btnPanel').onclick = () => togglePanel();
  $('btn3d').onclick = () => vol.enter();
  $('volBtn').onclick = () => { if (isNarrow()) togglePanel(false); vol.enter(); };
  $('btnNorth').onclick = () => map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => selectTab(b.dataset.tab);
  $('prodSearch').oninput = buildProducts;
  $('drawBtn').onclick = startDraw;
  $('cmapSel').onchange = (e) => { S.cmaps[S.product] = e.target.value; save(); showCurrent(); buildProducts(); };
  $('opacity').value = Math.round(S.opacity * 100);
  $('opacityVal').textContent = `${Math.round(S.opacity * 100)}%`;
  $('opacity').oninput = (e) => { S.opacity = e.target.value / 100; $('opacityVal').textContent = `${e.target.value}%`; sm.setOpacity(S.opacity); save(); };
  const chk = (id, key, fn) => { $(id).checked = !!S[key]; $(id).onchange = (e) => { S[key] = e.target.checked; fn(S[key]); save(); }; };
  chk('bordersChk', 'borders', (v) => sm.show(['coast', 'boundary-country'], v));
  chk('statesChk', 'states', (v) => sm.show('boundary-state', v));
  chk('gratChk', 'grat', (v) => sm.show('graticule', v));
  chk('outlineChk', 'outline', () => updateOutline(shown));
  chk('nightChk', 'night', (v) => sm.show('night', v));
  chk('lightsChk', 'lights', (v) => sm.setLights(v));
  chk('smoothChk', 'smooth', (v) => sm.setSmooth(v));
  chk('glmChk', 'glm', (v) => { OV.showLayers(map, 'glm', v); $('glmRow').classList.toggle('hidden', !v); updateGlm(shown?.time); });
  $('glmRow').classList.toggle('hidden', !S.glm);
  $('glmMin').value = S.glmMin;
  $('glmMin').onchange = (e) => { S.glmMin = +e.target.value; save(); updateGlm(shown?.time); };
  chk('stormsChk', 'storms', syncStorms);
  chk('labelsChk', 'labels', (v) => sm.setLabels(v));
  chk('globeChk', 'globe', (v) => sm.setProjection(v));
  chk('blendChk', 'blend', () => {});
  chk('fpsChk', 'fps', (v) => $('fps').classList.toggle('hidden', !v));
  $('fps').classList.toggle('hidden', !S.fps);
  $('themeSel').value = S.theme;
  $('themeSel').onchange = (e) => { S.theme = e.target.value; sm.setTheme(S.theme); save(); };
  $('threeChk').checked = S.threeD; $('threeChk').onchange = (e) => set3D(e.target.checked);
  $('terrainChk').checked = S.terrain; $('terrainChk').onchange = (e) => setTerrain(e.target.checked);
  $('exag').value = S.exag; $('exagVal').textContent = `${S.exag}×`;
  $('exag').oninput = (e) => { S.exag = +e.target.value; $('exagVal').textContent = `${S.exag}×`; sm.set3D({ cloudExag: S.exag }); save(); };
  $('terrainExag').value = S.terrainExag; $('terrainExagVal').textContent = `${S.terrainExag}×`;
  $('terrainExag').oninput = (e) => { S.terrainExag = +e.target.value; $('terrainExagVal').textContent = `${S.terrainExag}×`; sm.set3D({ groundExag: S.terrainExag }); save(); };
  for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => view(b.dataset.view);
  $('blendMs').value = S.blendMs; $('blendVal').textContent = `${S.blendMs} ms`;
  $('blendMs').oninput = (e) => { S.blendMs = +e.target.value; $('blendVal').textContent = `${S.blendMs} ms`; save(); };
  $('speedSel').value = S.speed; $('speedSel').onchange = (e) => { S.speed = +e.target.value; save(); };
  $('framesSel').onchange = (e) => { S.nFrames = +e.target.value; save(); reload(); };
  $('qualitySel').value = S.quality;
  $('qualitySel').onchange = (e) => {
    S.quality = e.target.value;
    delete S.autoCap; // picking Auto again re-tests the device
    save(); toast('Reloading with the new quality setting…', 'info', 3000); setTimeout(() => location.reload(), 700);
  };
  $('resSel').value = S.resolution;
  $('resSel').onchange = (e) => { S.resolution = e.target.value; estimates = {}; save(); reload(); };
  $('playBtn').onclick = () => (playing ? stopPlay() : startPlay());
  $('tlRange').oninput = (e) => { stopPlay(); show(+e.target.value, { blend: false }); };
  for (const b of $('modeSeg').children) b.onclick = () => (b.dataset.m === 'archive' ? (S.archive || startArchive()) : S.archive && stopArchive());
  $('arcGo').onclick = () => arcLoad(0);
  $('arcPrev').onclick = () => arcLoad(-1);
  $('arcNext').onclick = () => arcLoad(1);
  document.addEventListener('keydown', (e) => {
    if (e.target.matches?.('input, select, textarea') || document.getElementById('r3d')?.contains(e.target)) return;
    if (e.key === ' ') { e.preventDefault(); playing ? stopPlay() : startPlay(); }
    else if (e.key === 'ArrowLeft' && !e.shiftKey) { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight' && !e.shiftKey) { e.preventDefault(); step(1); }
    else if (e.key === 'Escape') { if (drawState) endDraw(); else if (vol.tool) vol.setTool(null); else togglePanel(false); }
    else if (e.key.toLowerCase() === 'n') $('btnNorth').click();
  }, true);
  document.body.addEventListener('click', (e) => { if (e.target === document.body && document.body.classList.contains('panel-open')) togglePanel(false); });
  window.addEventListener('hashchange', () => {
    if (location.hash.slice(1) === lastHash) return;
    const before = `${S.sat}|${S.sector}|${S.product}|${S.bbox}|${S.archive?.end}`;
    readHash();
    if (S.cam) map.jumpTo(S.cam);
    buildSats(); buildSectors(); buildProducts(); buildCmaps(); syncArchive();
    if (before !== `${S.sat}|${S.sector}|${S.product}|${S.bbox}|${S.archive?.end}`) reload();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlay(); });
}

// live refresh: new scans join the loop, the oldest drop out
setInterval(async () => {
  if (S.archive || document.hidden || !cur.plan || !cur.scans.length) return;
  try {
    const scans = (await scansFor(cur.plan, { limit: loopFrames() })).sort((a, b) => a.t - b.t);
    const newest = scans[scans.length - 1], last = cur.scans[cur.scans.length - 1];
    const grew = newest && newest.granules && newest.t.getTime() === last.t.getTime() && newest.granules.length > last.granules.length;
    if (!newest || (newest.t <= last.t && !grew)) return;
    const atEnd = cur.idx === cur.scans.length - 1, shownT = scanAt(cur.idx)?.t;
    cur.scans = scans;
    renderTimeline();
    await getFrame(cur.plan, newest, 1);
    if (atEnd && !playing) show(cur.scans.length - 1);
    else cur.idx = Math.max(0, cur.scans.findIndex((s) => s.t.getTime() === shownT?.getTime()));
    evict(); updateTicks();
  } catch (e) { /* try again next minute */ }
}, REFRESH_MS);

// ------------------------------------------------------------------ layout
// Floating UI (legend, probe, scale bar, 3D tools) sits above the timeline, whose height changes
// with the archive bar, the two-row phone layout and the 3D split: track where its top really is.
function layoutVars() {
  const r = $('timeline').getBoundingClientRect(), st = document.documentElement.style;
  if (!r.height) return;
  st.setProperty('--tl-top', `${Math.round(innerHeight - r.top)}px`);
  st.setProperty('--tl-map', `${Math.max(0, Math.round($('map').getBoundingClientRect().bottom - r.top))}px`);
}
new ResizeObserver(layoutVars).observe($('timeline'));
addEventListener('resize', layoutVars);
layoutVars();

// ------------------------------------------------------------------ boot
bind();
startTracks(); // its layers join the map in addOverlays()
startExtras();
if (satInfo().retired && !S.archive) startArchive(true); // a link to a retired satellite opens its archive
buildSectors(); buildProducts(); buildCmaps(); buildFrames(); syncArchive();
selectTab(S.tab);
if (S.panelCollapsed && !isNarrow()) togglePanel(false);
perfInfo();
if (S.cam) cur.fitted = `${S.sat}|${S.sector}|${S.bbox}`;
sm.ready.then(() => {
  sm.show(['coast', 'boundary-country'], S.borders); sm.show('boundary-state', S.states); sm.show('graticule', S.grat); sm.show('night', S.night);
  sm.setNight(new Date(), true);
  sm.lights = S.lights;
  if (S.threeD) set3D(true);
  if (S.terrain) setTerrain(true);
  addOverlays();
});
map.on('style.load', () => { // a new base map style: re-apply the overlay switches
  sm.show(['coast', 'boundary-country'], S.borders); sm.show('boundary-state', S.states); sm.show('graticule', S.grat); sm.show('night', S.night);
  if (!S.labels) sm.setLabels(false);
  addOverlays();
  updateOutline(shown);
});
reload({ fit: !S.cam });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.satview = { S, sm, cache, cur, tier, device, pool, vol };
