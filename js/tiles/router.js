/* Main-thread side of the tile workers: frames are handed to one worker each (transferred, not
 * copied) and MapLibre's satv:// / satdem:// tile requests are routed to the owner. */

export class TileRouter {
  constructor(n, { cacheMB = 0 } = {}) {
    this.workers = [];
    this.pending = new Map();
    this.owner = new Map(); // frame id -> worker
    this.luts = new Set();
    this.seq = 0; this.rr = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./tileworker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const { id, ok, result, error } = e.data;
        const p = this.pending.get(id); this.pending.delete(id);
        if (p) (ok ? p.resolve(result) : p.reject(new Error(error)));
      };
      this.workers.push(w);
      if (cacheMB) this._call(w, 'config', { cacheMB: cacheMB / n });
    }
  }

  _call(w, type, args, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); w.postMessage({ id, type, args }, transfer); });
  }

  /** Hand a frame to a worker. The frame's big arrays move there (the frame keeps its metadata). */
  put(frame) {
    const w = this.workers[this.rr++ % this.workers.length];
    this.owner.set(frame.id, w);
    const f = { mode: frame.mode, w: frame.w, h: frame.h, grid: frame.grid, rgba: frame.rgba || null,
      ref: { codes: frame.ref.codes, w: frame.ref.w, h: frame.ref.h, grid: frame.ref.grid, kind: frame.ref.kind, band: frame.ref.band },
      lights: frame.product === 'geocolor' };
    const transfer = [frame.ref.codes.buffer];
    if (frame.rgba) transfer.push(frame.rgba.buffer);
    frame.rgba = null; frame.ref.codes = null;
    frame.memBytes = frame.w * frame.h * (frame.mode === 'rgb' ? 4 : 0) + frame.ref.w * frame.ref.h * 2;
    return this._call(w, 'put', { id: frame.id, frame: f }, transfer);
  }

  drop(ids) {
    const by = new Map();
    for (const id of ids) { const w = this.owner.get(id); if (!w) continue; this.owner.delete(id); (by.get(w) || by.set(w, []).get(w)).push(id); }
    for (const [w, list] of by) this._call(w, 'drop', { ids: list });
  }

  /** Register a colour table (code -> RGBA) on every worker once. */
  async lut(lutId, lut, kind, vmin, vmax) {
    if (this.luts.has(lutId)) return;
    this.luts.add(lutId);
    await Promise.all(this.workers.map((w) => this._call(w, 'lut', { id: lutId, lut, kind, vmin, vmax })));
  }

  tile(id, lutId, z, x, y, size, lights) {
    const w = this.owner.get(id);
    if (!w) return Promise.reject(new Error('frame not loaded'));
    return this._call(w, 'tile', { id, lutId, z, x, y, size, lights });
  }

  dem(id, z, x, y, ground) {
    const w = this.owner.get(id) || this.workers[0];
    return this._call(w, 'dem', { id, z, x, y, ground });
  }

  probe(id, lon, lat) {
    const w = this.owner.get(id);
    return w ? this._call(w, 'probe', { id, lon, lat }) : Promise.resolve(null);
  }
}
