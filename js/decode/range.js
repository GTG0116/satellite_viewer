/* HTTP range-request byte source with a block cache.
 *
 * Metadata reads go through 64 KB blocks (adjacent missing blocks are fetched in one request and
 * concurrent reads of the same block share one request). Bulk chunk data is fetched with
 * fetchRanges(): nearby ranges are merged so a window needs few requests, and a global limiter
 * keeps at most a handful of requests in flight (browsers allow ~6 connections per host).
 */

const BLOCK = 64 * 1024;
let inflight = 0;
const waiters = [];
export let MAX_INFLIGHT = 6;
export const stats = { requests: 0, bytes: 0 };
export function setMaxInflight(n) { MAX_INFLIGHT = n; }

async function slot() {
  if (inflight < MAX_INFLIGHT) { inflight++; return; }
  await new Promise((r) => waiters.push(r));
  inflight++;
}
function release() { inflight--; const w = waiters.shift(); if (w) w(); }

export async function fetchBytes(url, start, end, signal) { // [start, end)
  await slot();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal, cache: 'force-cache' });
        if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
        const b = new Uint8Array(await r.arrayBuffer());
        stats.requests++; stats.bytes += b.length;
        // a server that ignored Range returns the whole object
        if (r.status === 200 && b.length > end - start) return b.subarray(start, end);
        return b;
      } catch (e) {
        if (signal?.aborted || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  } finally { release(); }
}

export class RangeSource {
  /** head: bytes fetched up front in one request (most NetCDF metadata sits at the start);
   *  tail: bytes at the end fetched alongside it (HDF5 files written in pieces, like the JPSS
   *  SDRs, keep much of their metadata there). */
  constructor(url, size, { head = 256 * 1024, tail = 0, signal } = {}) {
    this.url = url; this.size = size; this.signal = signal;
    this.blocks = new Map(); // block index -> Promise<Uint8Array>
    this.head = Math.min(size, head);
    this.tail = this.head >= size ? 0 : Math.min(size - this.head, tail);
  }

  _blocks(b0, b1) {
    const out = [];
    let run = -1;
    const flush = (end) => {
      if (run < 0) return;
      const s = run * BLOCK, e = Math.min(end * BLOCK, this.size);
      const p = fetchBytes(this.url, s, e, this.signal);
      for (let b = run; b < end; b++) {
        const off = (b - run) * BLOCK, bp = p.then((u) => u.subarray(off, off + BLOCK));
        bp.catch(() => {}); // (a prefetched block nobody reads must not fail loudly when cancelled)
        this.blocks.set(b, bp);
      }
      run = -1;
    };
    for (let b = b0; b <= b1; b++) {
      if (!this.blocks.has(b)) { if (run < 0) run = b; } else flush(b);
    }
    flush(b1 + 1);
    for (let b = b0; b <= b1; b++) out.push(this.blocks.get(b));
    return out;
  }

  async read(off, n) {
    n = Math.max(0, Math.min(n, this.size - off));
    if (!n) return new Uint8Array(0);
    if (!this.started && this.head) { // one request for the header region (and one for the tail)
      this.started = true;
      this._blocks(0, Math.ceil(this.head / BLOCK) - 1);
      if (this.tail) this._blocks(Math.floor((this.size - this.tail) / BLOCK), Math.ceil(this.size / BLOCK) - 1);
    }
    const b0 = Math.floor(off / BLOCK), b1 = Math.floor((off + n - 1) / BLOCK);
    const parts = await Promise.all(this._blocks(b0, b1));
    if (parts.length === 1) return parts[0].subarray(off - b0 * BLOCK, off - b0 * BLOCK + n);
    const out = new Uint8Array(n);
    let o = 0;
    for (let i = 0; i < parts.length; i++) {
      const s = i === 0 ? off - b0 * BLOCK : 0;
      const take = Math.min(parts[i].length - s, n - o);
      out.set(parts[i].subarray(s, s + take), o); o += take;
    }
    return out;
  }

  /** Fetch many [offset, size] ranges; returns a lookup (offset, size) -> bytes. */
  async fetchRanges(ranges, { gap = 32 * 1024, maxReq = 4 * 1024 * 1024 } = {}) {
    const sorted = ranges.map((r, i) => [r[0], r[1], i]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, n] of sorted) {
      const e = s + n, last = merged[merged.length - 1];
      if (last && s - last[1] <= gap && e - last[0] <= maxReq) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    const got = await Promise.all(merged.map(async ([s, e]) => [s, await fetchBytes(this.url, s, e, this.signal)]));
    return (s, n) => {
      let lo = 0, hi = got.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (got[m][0] <= s) lo = m; else hi = m - 1; }
      const [gs, u] = got[lo];
      return u.subarray(s - gs, s - gs + n);
    };
  }

  /** Like fetchRanges, but yields each merged request as soon as it arrives, so decoding can
   *  overlap downloading. cb(offset, bytes) is called once per original range. */
  async streamRanges(ranges, cb, { gap = 32 * 1024, maxReq = 2 * 1024 * 1024 } = {}) {
    if (this.head >= this.size) { // whole (small) file already requested: serve from the block cache
      await Promise.all(ranges.map(async (r) => cb(r, await this.read(r[0], r[1]))));
      return;
    }
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const groups = [];
    for (const r of sorted) {
      const g = groups[groups.length - 1];
      if (g && r[0] - g.e <= gap && r[0] + r[1] - g.s <= maxReq) { g.e = Math.max(g.e, r[0] + r[1]); g.items.push(r); }
      else groups.push({ s: r[0], e: r[0] + r[1], items: [r] });
    }
    await Promise.all(groups.map(async (g) => {
      const u = await fetchBytes(this.url, g.s, g.e, this.signal);
      for (const r of g.items) await cb(r, u.subarray(r[0] - g.s, r[0] - g.s + r[1]));
    }));
  }
}
