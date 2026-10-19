/* Device tiers: every budget that keeps the viewer smooth on a given device. */

const BASE = {
  low: { name: 'low', label: 'Low', maxTex: 2048, memMB: 96, framePx: 1.6e6, dprCap: 1,
    workers: 2, tileWorkers: 1, mapWorkers: 1, maxFrames: 24, defFrames: 6, maxFrameMB: 40, antialias: false },
  medium: { name: 'medium', label: 'Medium', maxTex: 4096, memMB: 320, framePx: 6e6, dprCap: 1.5,
    workers: 3, tileWorkers: 2, mapWorkers: 2, maxFrames: 60, defFrames: 12, maxFrameMB: 150, antialias: false },
  high: { name: 'high', label: 'High', maxTex: 8192, memMB: 1024, framePx: 24e6, dprCap: 2,
    workers: 5, tileWorkers: 3, mapWorkers: 2, maxFrames: 120, defFrames: 24, maxFrameMB: 900, antialias: true },
};

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

export function autoTier(d) {
  const mem = d.mem || (d.mobile ? 3 : 8);
  if (d.software || mem <= 2 || d.cores <= 2 || d.maxTex < 4096 || d.saveData) return 'low';
  if (!d.mobile && mem >= 8 && d.cores >= 8 && d.maxTex >= 8192) return 'high';
  if (d.mobile && (mem <= 4 || d.cores <= 4)) return 'low';
  return 'medium';
}

export function makeTier(name, d) {
  const t = { ...BASE[name] };
  t.maxTex = Math.min(t.maxTex, d.maxTex || 4096);
  t.workers = Math.max(1, Math.min(t.workers, (d.cores || 4) - 1));
  t.tileWorkers = Math.max(1, Math.min(t.tileWorkers, Math.floor((d.cores || 4) / 2)));
  if (d.mobile) t.dprCap = Math.min(t.dprCap, name === 'high' ? 2 : 1.5);
  return t;
}
