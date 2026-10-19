/* Device tiers: every budget that keeps the viewer smooth on a given device. */

const BASE = {
  low: { name: 'low', label: 'Low', maxTex: 2048, memMB: 96, framePx: 1.6e6, dprCap: 1,
    workers: 2, tileWorkers: 1, mapWorkers: 1, maxFrames: 24, defFrames: 6, maxFrameMB: 40, antialias: false,
    tileCacheMB: 16, lite: true },
  medium: { name: 'medium', label: 'Medium', maxTex: 4096, memMB: 256, framePx: 4e6, dprCap: 1.25,
    workers: 3, tileWorkers: 2, mapWorkers: 2, maxFrames: 48, defFrames: 10, maxFrameMB: 120, antialias: false,
    tileCacheMB: 32, lite: false },
  high: { name: 'high', label: 'High', maxTex: 8192, memMB: 1024, framePx: 24e6, dprCap: 2,
    workers: 5, tileWorkers: 3, mapWorkers: 2, maxFrames: 120, defFrames: 24, maxFrameMB: 900, antialias: true,
    tileCacheMB: 96, lite: false },
};
export const TIERS = ['low', 'medium', 'high'];

export function probeDevice() {
  const info = { mem: navigator.deviceMemory || 0, cores: navigator.hardwareConcurrency || 4, maxTex: 4096, renderer: '', software: false,
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && matchMedia('(pointer: coarse)').matches) };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      info.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      info.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      info.software = /swiftshader|llvmpipe|software|basic render/i.test(info.renderer);
      info.gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch (e) { /* keep defaults */ }
  const conn = navigator.connection;
  info.saveData = !!conn?.saveData;
  info.slowNet = conn ? /(^|-)2g|3g/.test(conn.effectiveType || '') : false;
  return info;
}

/** A dedicated graphics card (integrated GPUs share the laptop's RAM and memory bandwidth). */
const discreteGPU = (r) => /nvidia|geforce|quadro|rtx|radeon (rx|pro|vii)|radeon\(tm\) rx|arc\(tm\) a\d|intel.*arc a\d/i.test(r);
/** Typical school / office / budget laptops: Intel UHD / HD / Iris, AMD Vega APUs, Chromebook GPUs. */
const weakGPU = (r) => /intel.*(uhd|hd graphics|hd \d|iris)|mesa intel|radeon\(tm\) graphics|vega \d|mali|adreno|powervr|videocore/i.test(r);

export function autoTier(d) {
  // navigator.deviceMemory is capped at 8 and missing in Firefox / Safari: unknown counts as modest
  const mem = d.mem || (d.mobile ? 3 : 4);
  if (d.software || mem <= 2 || d.cores <= 2 || d.maxTex < 4096 || d.saveData) return 'low';
  if (d.mobile) return mem <= 4 || d.cores <= 4 ? 'low' : 'medium';
  // only a real graphics card with plenty of RAM and threads gets High
  if (discreteGPU(d.renderer) && mem >= 8 && d.cores >= 8 && d.maxTex >= 8192) return 'high';
  if (weakGPU(d.renderer) && (mem <= 4 || d.cores <= 4)) return 'low';
  return 'medium';
}

/** The lower of two tier names. */
export const minTier = (a, b) => TIERS[Math.min(TIERS.indexOf(a), TIERS.indexOf(b) < 0 ? 2 : TIERS.indexOf(b))];
export const lowerTier = (a) => TIERS[Math.max(0, TIERS.indexOf(a) - 1)];

export function makeTier(name, d) {
  const t = { ...BASE[name] };
  t.maxTex = Math.min(t.maxTex, d.maxTex || 4096);
  t.workers = Math.max(1, Math.min(t.workers, (d.cores || 4) - 1));
  t.tileWorkers = Math.max(1, Math.min(t.tileWorkers, Math.floor((d.cores || 4) / 2)));
  if (d.mobile) t.dprCap = Math.min(t.dprCap, name === 'high' ? 2 : 1.5);
  return t;
}

/**
 * Watches the map's frame times while it animates (panning, zooming, loop playback). onSlow() is
 * called once when the frame rate stays low (median under ~18 fps over several seconds of motion).
 */
export class FrameWatch {
  constructor(onSlow) {
    this.onSlow = onSlow;
    this.last = 0;
    this.dts = [];
    this.bad = 0;
    this.done = false;
  }

  tick(now = performance.now()) {
    if (this.done) return;
    const dt = now - this.last;
    this.last = now;
    if (dt <= 0 || dt > 400) return; // idle gaps (MapLibre renders on demand) say nothing
    this.dts.push(dt);
    if (this.dts.length < 90) return;
    const sorted = this.dts.sort((a, b) => a - b), med = sorted[sorted.length >> 1];
    this.dts = [];
    this.bad = med > 55 ? this.bad + 1 : Math.max(0, this.bad - 1);
    if (this.bad >= 3) { this.done = true; this.onSlow(med); }
  }
}
