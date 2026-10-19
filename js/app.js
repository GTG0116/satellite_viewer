/* Satellite Viewer (static web edition): UI, state, loading and playback on a MapLibre map. */
import { SATS, products, RGBS, CMAPS, buildLut, lutCss, rangeFor, SECTOR_NOTES, bandsOf, rolesOf, bandLabel } from './catalog.js';
import { plan, scansFor, loadFrame, loadBands, estimateBytes, frameKey } from './scenes.js';
import { SatMap, unwrapLine } from './map.js';
import { Pool } from './pool.js';
import { probeDevice, autoTier, makeTier, minTier, lowerTier, FrameWatch } from './perf.js';
import { outline, gridCenter, resKm, lonlatToRC } from './geo.js';
import { setProxy, availableScans } from './listing.js';
import { Volume } from './volume.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'satview.web.v2';
const REFRESH_MS = 60e3;

// ------------------------------------------------------------------ settings
function loadSaved() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } }
const saved = loadSaved();
let saveT = 0, hashT = 0, lastHash = '';
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...S, cam: sm ? sm.camera() : S.cam })); } catch (e) { /* storage unavailable */ }
  }, 400);
}

const device = probeDevice();
// Auto quality: the device's tier, capped lower if this browser already ran out of speed or memory
const tierName = saved.quality && saved.quality !== 'auto' ? saved.quality : minTier(autoTier(device), saved.autoCap || 'high');
const tier = makeTier(tierName, device);
document.body.classList.add(`tier-${tier.name}`);

const S = Object.assign({
  sat: 'goes19', sector: 'conus', product: 'geocolor', cmaps: {}, opacity: 1, nFrames: tier.defFrames, speed: 220,
  blend: false, blendMs: 300, threeD: false, exag: 10, terrain: false, terrainExag: 1.5, borders: true, states: true, grat: true,
  outline: true, night: true, lights: true, labels: true, globe: true, theme: 'dark', quality: 'auto', resolution: 'cmip',
  bbox: null, fps: false, archive: null, cam: null,
}, saved);
S.nFrames = Math.min(S.nFrames || tier.defFrames, tier.maxFrames);
if (!SATS[S.sat]) S.sat = 'goes19';
readHash();

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
const pool = new Pool(tier.workers);
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

function budget(rgb) {
  const bpp = rgb ? 6 : 2; // RGBA + 16-bit reference band, or just the band
  return { maxTex: tier.maxTex, framePx: Math.min(tier.framePx, (tier.memMB * 1e6 * 0.85) / (Math.max(1, S.nFrames) * bpp)) };
}
function currentPlan() {
  return plan({ sat: S.sat, sector: S.sector, product: S.product, resolution: S.resolution, bbox: S.bbox }, budget(!!RGBS[S.product]));
}
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

function getFrame(p, scan, pri) {
  const key = frameKey(p, scan);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (loading.has(key)) return loading.get(key);
  const pr = loadFrame(p, scan, pool, { pri, signal: cur.ac?.signal }).then(async (f) => {
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
    if (S.archive) scans = sample(await scansFor(p, { end: new Date(S.archive.end), hours: S.archive.hours, signal: cur.ac.signal }), S.nFrames);
    else scans = await scansFor(p, { limit: S.nFrames, signal: cur.ac.signal });
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
    const f = await getFrame(p, scans[last], 0);
    if (token !== cur.token) return;
    await show(last, { blend: false });
    if (fit || cur.fitted !== `${S.sat}|${S.sector}|${S.bbox}`) { fitTo(f); cur.fitted = `${S.sat}|${S.sector}|${S.bbox}`; }
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
  vol.frameChanged(() => playing);
  await sm.showFrame(f, { blendMs: ms });
}
const showCurrent = () => show(cur.idx, { blend: false });

async function applyColour(f) {
  if (f.mode !== 'band') return;
  const cm = S.cmaps[S.product] || prodInfo().cmap;
  const [vmin, vmax] = rangeFor(S.sat, f.ref.band, cm);
  await sm.setColour(`${cm}|${vmin}|${vmax}|${f.ref.kind}`, buildLut(cm, vmin, vmax), f.ref.kind, vmin, vmax);
}

function updateOutline(f) {
  const feats = [];
  if (S.outline && f && f.sector !== 'full') { const o = outline(f.grid); if (o) feats.push({ type: 'Feature', properties: { active: true }, geometry: { type: 'LineString', coordinates: unwrapLine(o) } }); }
  if (S.sector === 'custom' && S.bbox) {
    const [w, s, e, n] = S.bbox;
    feats.push({ type: 'Feature', properties: { active: false }, geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } });
  }
  sm.setGeo('outline', { type: 'FeatureCollection', features: feats });
}

function fitTo(f) {
  const sat = satInfo();
  if (S.sector === 'full') { sm.flyTo({ center: [sat.lon, 0], zoom: 1.4, pitch: S.threeD ? 40 : 0, bearing: 0 }); return; }
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
    const dwell = next === L[L.length - 1] ? S.speed * 4 : S.speed;
    playT = setTimeout(tick, Math.max(0, dwell - (performance.now() - t0)));
  };
  tick();
}
function stopPlay() { playing = false; clearTimeout(playT); setPlayIcon(); }
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
  const [vmin, vmax] = rangeFor(S.sat, f.ref.band, cm), pct = f.ref.kind === 'refl';
  $('legendTitle').textContent = `${pi.name} · ${pi.label}`;
  $('legendBar').style.background = lutCss(cm, vmin, vmax);
  const ticks = [];
  for (let i = 0; i <= 4; i++) { const v = vmin + (vmax - vmin) * i / 4; ticks.push(pct ? `${Math.round(v * 100)}%` : `${Math.round(v)}${i === 4 ? ' K' : ''}`); }
  $('legendTicks').innerHTML = ticks.map((t) => `<span>${t}</span>`).join('');
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
      txt += v !== v ? ` · <b>${label}</b> no data` : ` · <b>${label}</b> ${r.kind === 'refl' ? `${(v * 100).toFixed(1)}%` : `${v.toFixed(1)} K (${(v - 273.15).toFixed(1)} °C)`}`;
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

// ------------------------------------------------------------------ UI: lists
function swatch(p) {
  if (p.kind === 'rgb') {
    const c = { geocolor: '#4b7bd8,#e8e2c8', truecolor: '#3d6fb5,#d9cfa8', natural: '#31a3c9,#e0f0ff', airmass: '#c0362c,#2f5ec4',
      dcp: '#e06ef0,#ffe14a', daycon: '#f0d040,#3050d0', nightmicro: '#e0c0a0,#90a8c8', dust: '#ff40c0,#203040', ash: '#e0f040,#2070c0',
      fire: '#ff3020,#203010', simplewv: '#f0f0f0,#2050a0', sandwich: '#d8d8d8,#ff4040' }[p.id] || '#999,#333';
    return `linear-gradient(135deg, ${c})`;
  }
  const [vmin, vmax] = rangeFor(S.sat, p.band, p.cmap);
  return lutCss(p.cmap, vmin, vmax, 8);
}
function buildSats() {
  const el = $('satList'); el.innerHTML = '';
  for (const [id, s] of Object.entries(SATS)) {
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
let groupFilter = 'all', estimates = {};
function buildProducts() {
  const list = prodList();
  const groups = ['all', ...new Set(list.map((p) => p.group))];
  const ge = $('prodGroups'); ge.innerHTML = '';
  for (const g of groups) {
    const b = document.createElement('button');
    b.textContent = g === 'all' ? 'All' : g; b.className = g === groupFilter ? 'on' : '';
    b.onclick = () => { groupFilter = g; buildProducts(); };
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
  if (!satInfo().sectors.some((s) => s[0] === S.sector)) S.sector = SATS[id].kind === 'goes' ? SATS[id].local : 'full';
  if (!prodList().some((p) => p.id === S.product)) S.product = 'geocolor';
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
  for (const b of $('modeSeg').children) b.classList.toggle('on', (b.dataset.m === 'archive') === on);
  const sat = satInfo(), inp = $('arcEnd');
  inp.min = `${sat.start}T00:00`;
  inp.max = (sat.end ? new Date(sat.end) : new Date()).toISOString().slice(0, 16);
  if (on) { inp.value = new Date(S.archive.end).toISOString().slice(0, 16); $('arcSpan').value = S.archive.hours; }
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
  if (satInfo().retired) { toast(`${satInfo().name} is retired — only archive data exists.`, 'info', 4000); return; }
  S.archive = null; syncArchive(); save(); reload();
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
  if (desktop) { p.classList.toggle('collapsed', !open); document.body.classList.toggle('panel-collapsed', !open); }
  else { p.classList.toggle('open', open); document.body.classList.toggle('panel-open', open); }
  $('btnPanel').setAttribute('aria-expanded', String(open));
  $('btnPanel').classList.toggle('on', open);
}
function selectTab(t) {
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
function readHash() {
  if (!location.hash) return;
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('sat') && SATS[h.get('sat')]) S.sat = h.get('sat');
  if (h.get('sec')) S.sector = h.get('sec');
  if (h.get('p')) S.product = h.get('p');
  if (h.get('bbox')) S.bbox = h.get('bbox').split(',').map(Number);
  if (h.get('cam')) { const [lon, lat, zoom, bearing, pitch] = h.get('cam').split(',').map(Number); if (zoom < 23) S.cam = { center: [lon, lat], zoom, bearing: bearing || 0, pitch: pitch || 0 }; }
  if (h.get('end')) S.archive = { end: new Date(`${h.get('end')}:00Z`).toISOString(), hours: +(h.get('span') || 3) };
  if (!SATS[S.sat].sectors.some((s) => s[0] === S.sector)) S.sector = SATS[S.sat].kind === 'goes' ? SATS[S.sat].local : 'full';
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
    const scans = (await scansFor(cur.plan, { limit: S.nFrames })).sort((a, b) => a.t - b.t);
    const newest = scans[scans.length - 1];
    if (!newest || newest.t <= cur.scans[cur.scans.length - 1].t) return;
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
buildSats(); buildSectors(); buildProducts(); buildCmaps(); buildFrames(); syncArchive();
perfInfo();
if (S.sector === 'custom' && !S.bbox) S.sector = SATS[S.sat].kind === 'goes' ? SATS[S.sat].local : 'full';
if (S.cam) cur.fitted = `${S.sat}|${S.sector}|${S.bbox}`;
sm.ready.then(() => {
  sm.show(['coast', 'boundary-country'], S.borders); sm.show('boundary-state', S.states); sm.show('graticule', S.grat); sm.show('night', S.night);
  sm.setNight(new Date(), true);
  sm.lights = S.lights;
  if (S.threeD) set3D(true);
  if (S.terrain) setTerrain(true);
});
map.on('style.load', () => { // a new base map style: re-apply the overlay switches
  sm.show(['coast', 'boundary-country'], S.borders); sm.show('boundary-state', S.states); sm.show('graticule', S.grat); sm.show('night', S.night);
  if (!S.labels) sm.setLabels(false);
  updateOutline(shown);
});
reload({ fit: !S.cam });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.satview = { S, sm, cache, cur, tier, device, pool, vol };
