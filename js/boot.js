/* Start-up work that does not need the map. index.html loads this module on its own (async), so
 * it runs while MapLibre (1 MB) is still downloading: it settles the device tier and the saved
 * view, starts the decode workers, and starts listing and downloading the newest frame of that
 * view. app.js imports the same module instance and picks the frame up. */
import { SATS, RGBS, defaultSector, defaultProduct, products } from './catalog.js';
import { plan, scansFor, loadFrame, estimateBytes, frameKey } from './scenes.js';
import { Pool } from './pool.js';
import { probeDevice, autoTier, makeTier, minTier } from './perf.js';

export const SETTINGS_KEY = 'satview.web.v2';

function loadSaved() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } }
export const saved = loadSaved();

export const device = probeDevice();
// Auto quality: the device's tier, capped lower if this browser already ran out of speed or memory
const tierName = saved.quality && saved.quality !== 'auto' ? saved.quality : minTier(autoTier(device), saved.autoCap || 'high');
export const tier = makeTier(tierName, device);

export const S = Object.assign({
  sat: 'goes19', sector: 'conus', product: 'geocolor', cmaps: {}, opacity: 1, nFrames: tier.defFrames, speed: 220,
  blend: false, blendMs: 300, threeD: false, exag: 10, terrain: false, terrainExag: 1.5, borders: true, states: true, grat: true,
  outline: true, night: true, lights: true, labels: true, globe: true, theme: 'dark', quality: 'auto', resolution: 'cmip',
  bbox: null, fps: false, archive: null, cam: null, smooth: false, glm: false, glmMin: 5, storms: true, mtracks: {}, recon: {}, sst: {}, tcstyle: {}, mapstyle: {},
  tab: 'data', group: 'all', panelCollapsed: false, // panel tab, product-group filter, side panel folded (desktop)
}, saved);
S.nFrames = Math.min(S.nFrames || tier.defFrames, tier.maxFrames);
if (!SATS[S.sat]) S.sat = 'goes19';
readHash();
if (S.sector === 'custom' && !S.bbox) S.sector = defaultSector(S.sat);
if (!products(S.sat).some((p) => p.id === S.product)) S.product = defaultProduct(S.sat);

export function readHash() {
  if (!location.hash) return;
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('sat') && SATS[h.get('sat')]) S.sat = h.get('sat');
  if (h.get('sec')) S.sector = h.get('sec');
  if (h.get('p')) S.product = h.get('p');
  if (h.get('bbox')) S.bbox = h.get('bbox').split(',').map(Number);
  if (h.get('cam')) { const [lon, lat, zoom, bearing, pitch] = h.get('cam').split(',').map(Number); if (zoom < 23) S.cam = { center: [lon, lat], zoom, bearing: bearing || 0, pitch: pitch || 0 }; }
  if (h.get('end')) S.archive = { end: new Date(`${h.get('end')}:00Z`).toISOString(), hours: +(h.get('span') || 3) };
  if (!SATS[S.sat].sectors.some((s) => s[0] === S.sector)) S.sector = defaultSector(S.sat);
}

/** Frames in the loop. Polar slices are ~20-70 MB downloads each: their loops are capped per tier. */
export const loopFrames = () => (SATS[S.sat].kind === 'polar' ? Math.min(S.nFrames, { low: 3, medium: 6, high: 12 }[tier.name] || 6) : S.nFrames);

/** Output-resolution budget of one frame: the tier's limit, shared by the whole loop in memory. */
export function budget(rgb) {
  const bpp = rgb ? 6 : 2; // RGBA + 16-bit reference band, or just the band
  return { maxTex: tier.maxTex, framePx: Math.min(tier.framePx, (tier.memMB * 1e6 * 0.85) / (Math.max(1, loopFrames()) * bpp)) };
}
export function currentPlan() {
  return plan({ sat: S.sat, sector: S.sector, product: S.product, resolution: S.resolution, bbox: S.bbox }, budget(!!RGBS[S.product] || S.product.startsWith('v_')));
}

export const pool = device.gl2 ? new Pool(tier.workers) : null;

// The newest frame of the saved live view: {key, frame: Promise} once its scan is known (null: none)
let early = null;
if (pool && !S.archive) {
  const ac = new AbortController();
  const ready = (async () => {
    const p = currentPlan();
    const scans = await scansFor(p, { limit: loopFrames(), signal: ac.signal }); // the listing cache serves app.js the same
    if (!scans.length) return null;
    const scan = scans.reduce((a, b) => (b.t > a.t ? b : a));
    if (estimateBytes(p, scan) > tier.maxFrameMB * 1e6) return null;
    const frame = loadFrame(p, scan, pool, { pri: 0, signal: ac.signal });
    frame.catch(() => {});
    return { key: frameKey(p, scan), frame };
  })().catch(() => null);
  early = { ready, ac };
}

/** {frame: Promise} of the early frame if `key` is it (once; any other key cancels it). */
export async function takeEarly(key) {
  const e = early;
  early = null;
  if (!e) return null;
  const r = await e.ready;
  if (r && r.key === key) return { frame: r.frame };
  e.ac.abort();
  return null;
}
