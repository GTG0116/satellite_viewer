/* Minimal, read-only HDF5 reader for NetCDF-4 files (GOES ABI L1b / L2), written for the browser.
 *
 * Everything is asynchronous over a byte source with `read(offset, length) -> Promise<Uint8Array>`
 * (HTTP range requests with a block cache, see range.js), so only the metadata a lookup touches and
 * the chunks a window needs are ever downloaded.
 *
 * Supported: superblock v0-v3; object headers v1/v2 (+ continuations); old-style groups (symbol
 * table, v1 B-tree, local heap) and new-style groups (compact links, dense links in a fractal heap
 * indexed by a v2 B-tree); compact / dense attributes; numeric + fixed string datatypes; compact,
 * contiguous and chunked layouts (v1 B-tree index, v4 single-chunk / fixed-array / implicit);
 * filters deflate, shuffle and fletcher32.
 */

const UNDEF = -1;

// --------------------------------------------------------------------------- byte cursor
class Cur {
  constructor(u8, pos = 0, so = 8, sl = 8) {
    this.u = u8; this.v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = pos;
    this.so = so; this.sl = sl;
  }
  u8() { return this.u[this.p++]; }
  u16() { const x = this.v.getUint16(this.p, true); this.p += 2; return x; }
  u32() { const x = this.v.getUint32(this.p, true); this.p += 4; return x; }
  u64() { const lo = this.v.getUint32(this.p, true), hi = this.v.getUint32(this.p + 4, true); this.p += 8; return hi * 4294967296 + lo; }
  uN(n) { // little-endian unsigned of n bytes (n <= 8)
    let x = 0, m = 1;
    for (let i = 0; i < n; i++) { x += this.u[this.p + i] * m; m *= 256; }
    this.p += n; return x;
  }
  addr() { // offset of size `so`; all-ones = undefined
    let ones = true;
    for (let i = 0; i < this.so; i++) if (this.u[this.p + i] !== 0xff) { ones = false; break; }
    const x = this.uN(this.so); return ones ? UNDEF : x;
  }
  len() { return this.uN(this.sl); }
  bytes(n) { const b = this.u.subarray(this.p, this.p + n); this.p += n; return b; }
  skip(n) { this.p += n; return this; }
  str(n) { const b = this.bytes(n); let e = b.indexOf(0); if (e < 0) e = n; return dec.decode(b.subarray(0, e)); }
  sig() { return String.fromCharCode(this.u[this.p], this.u[this.p + 1], this.u[this.p + 2], this.u[this.p + 3]); }
}
const dec = new TextDecoder();
const encSize = (n) => (n <= 0 ? 1 : Math.floor(Math.log2(n) / 8) + 1); // H5VM_limit_enc_size

// --------------------------------------------------------------------------- datatypes
function parseDatatype(c) {
  const b0 = c.u8(), cls = b0 & 15, ver = b0 >> 4;
  const f0 = c.u8(), f1 = c.u8(), f2 = c.u8();
  const size = c.u32();
  const t = { cls, ver, size, le: !(f0 & 1), signed: !!(f0 & 8) };
  if (cls === 0) { c.skip(4); }                      // fixed point: bit offset, precision
  else if (cls === 1) { c.skip(12); }                // float: offsets, exponent/mantissa layout
  else if (cls === 3) { t.str = true; }              // fixed string
  else if (cls === 9) { t.vlen = true; t.vstr = (f0 & 15) === 1; } // variable length
  else if (cls === 8) {                              // enum: base type + members (skip names)
    t.base = parseDatatype(c);
  }
  return t;
}

function decodeValues(u8, t, n) {
  const out = [];
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (t.str) { return [dec.decode(u8.subarray(0, t.size * n)).replace(/\0+$/, '')]; }
  if (t.cls === 8) return decodeValues(u8, t.base, n);
  for (let i = 0; i < n; i++) {
    const o = i * t.size;
    if (o + t.size > u8.length) break;
    if (t.cls === 1) out.push(t.size === 4 ? v.getFloat32(o, t.le) : v.getFloat64(o, t.le));
    else if (t.cls === 0) {
      if (t.size === 1) out.push(t.signed ? v.getInt8(o) : v.getUint8(o));
      else if (t.size === 2) out.push(t.signed ? v.getInt16(o, t.le) : v.getUint16(o, t.le));
      else if (t.size === 4) out.push(t.signed ? v.getInt32(o, t.le) : v.getUint32(o, t.le));
      else out.push(Number(t.signed ? v.getBigInt64(o, t.le) : v.getBigUint64(o, t.le)));
    } else out.push(null);
  }
  return out;
}

function parseDataspace(c) {
  const ver = c.u8(), rank = c.u8(), flags = c.u8();
  let type = 1;
  if (ver === 1) c.skip(5); else type = c.u8();
  const shape = [];
  for (let i = 0; i < rank; i++) shape.push(c.len());
  if (flags & 1) c.skip(rank * c.sl);
  if (ver === 1 && (flags & 2)) c.skip(rank * c.sl);
  const n = type === 2 ? 0 : shape.reduce((a, b) => a * b, 1);
  return { shape, n, ver };
}

// --------------------------------------------------------------------------- file
export class H5File {
  constructor(src) { this.src = src; this.headers = new Map(); }

  static async open(src) {
    const f = new H5File(src);
    await f._superblock();
    return f;
  }

  async _read(addr, n) { return this.src.read(this.base + addr, n); }
  async cur(addr, n) { return new Cur(await this._read(addr, n), 0, this.so, this.sl); }

  async _superblock() {
    let at = 0, u = await this.src.read(0, 512);
    const SIG = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
    const isSig = (b) => SIG.every((x, i) => b[i] === x);
    while (!isSig(u)) { // signature may sit at 0, 512, 1024, ...
      at = at ? at * 2 : 512;
      if (at > (this.src.size || 1 << 30)) throw new Error('not an HDF5 file');
      u = await this.src.read(at, 512);
    }
    const ver = u[8];
    const c = new Cur(u, 9);
    if (ver <= 1) {
      c.skip(4);                   // free-space, root sym table, reserved, shared header versions
      this.so = c.u8(); this.sl = c.u8(); c.so = this.so; c.sl = this.sl;
      c.skip(1); c.skip(4); c.skip(4); // reserved, leaf K, internal K, flags
      if (ver === 1) c.skip(4);
      this.base = c.addr(); if (this.base === UNDEF) this.base = 0;
      c.addr(); c.addr(); c.addr();   // free space, EOF, driver
      c.addr();                       // root: link name offset
      this.root = c.addr();
    } else {
      this.so = c.u8(); this.sl = c.u8(); c.so = this.so; c.sl = this.sl;
      c.skip(1);
      this.base = c.addr(); if (this.base === UNDEF) this.base = 0;
      c.addr(); c.addr();
      this.root = c.addr();
    }
    this.base += 0; this.sbAt = at;
  }

  // ------------------------------------------------------------------ object headers
  async header(addr) {
    let h = this.headers.get(addr);
    if (!h) { h = this._header(addr); this.headers.set(addr, h); }
    return h;
  }

  async _header(addr) {
    const msgs = [];
    let first = await this._read(addr, 512);
    const blocks = [];
    if (first[0] === 0x4f && first[1] === 0x48 && first[2] === 0x44 && first[3] === 0x52) { // 'OHDR' v2
      const c = new Cur(first, 5, this.so, this.sl);
      const flags = c.u8();
      if (flags & 0x20) c.skip(16);
      if (flags & 0x10) c.skip(4);
      const n = 1 << (flags & 3);
      const size0 = c.uN(n);
      const start = c.p;
      if (start + size0 + 4 > first.length) first = await this._read(addr, start + size0 + 4);
      blocks.push({ u: first, s: start, e: start + size0, v2: true, co: !!(flags & 4) });
    } else { // v1
      const c = new Cur(first, 0, this.so, this.sl);
      c.skip(2); c.u16(); c.u32();
      const hsize = c.u32();
      if (16 + hsize > first.length) first = await this._read(addr, 16 + hsize);
      blocks.push({ u: first, s: 16, e: 16 + hsize, v2: false });
    }
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const c = new Cur(b.u, b.s, this.so, this.sl);
      while (c.p < b.e) {
        let type, size, mflags;
        if (b.v2) {
          if (b.e - c.p < 4) break;               // gap
          type = c.u8(); size = c.u16(); mflags = c.u8();
          if (b.co) c.skip(2);
        } else {
          if (b.e - c.p < 8) break;
          type = c.u16(); size = c.u16(); mflags = c.u8(); c.skip(3);
        }
        const body = b.u.subarray(c.p, c.p + size);
        c.skip(size);
        if (type === 0x10) { // continuation
          const cc = new Cur(body, 0, this.so, this.sl);
          const off = cc.addr(), ln = cc.len();
          const u = await this._read(off, ln);
          if (b.v2) blocks.push({ u, s: 4, e: ln - 4, v2: true, co: b.co });
          else blocks.push({ u, s: 0, e: ln, v2: false });
        } else if (type !== 0) {
          msgs.push({ type, flags: mflags, body });
        }
      }
    }
    return msgs;
  }

  // ------------------------------------------------------------------ groups
  links(addr) {
    this.linkCache ||= new Map();
    let p = this.linkCache.get(addr);
    if (!p) { p = this._links(addr); this.linkCache.set(addr, p); }
    return p;
  }

  async _links(addr) {
    const msgs = await this.header(addr);
    const out = new Map();
    for (const m of msgs) {
      if (m.type === 0x06) { const l = this._link(m.body); if (l) out.set(l.name, l.addr); }
      else if (m.type === 0x11) { // old style: symbol table
        const c = new Cur(m.body, 0, this.so, this.sl);
        const bt = c.addr(), heap = c.addr();
        await this._symtab(bt, heap, out);
      } else if (m.type === 0x02) { // link info: dense links
        const c = new Cur(m.body, 0, this.so, this.sl);
        c.u8(); const fl = c.u8(); if (fl & 1) c.skip(8);
        const fheap = c.addr(), nameBt = c.addr();
        if (fheap !== UNDEF && nameBt !== UNDEF) {
          const hp = await this._fheap(fheap);
          const recs = await this._btree2(nameBt);
          const objs = await Promise.all(recs.map((r) => this._fheapObj(hp, r.subarray(4))));
          for (const obj of objs) {
            const l = this._link(obj);
            if (l) out.set(l.name, l.addr);
          }
        }
      }
    }
    return out;
  }

  _link(body) {
    const c = new Cur(body, 0, this.so, this.sl);
    c.u8(); const fl = c.u8();
    let ltype = 0;
    if (fl & 8) ltype = c.u8();
    if (fl & 4) c.skip(8);
    if (fl & 16) c.skip(1);
    const nlen = c.uN(1 << (fl & 3));
    const name = dec.decode(c.bytes(nlen));
    if (ltype !== 0) return null; // soft / external links are not followed
    return { name, addr: c.addr() };
  }

  async _symtab(btAddr, heapAddr, out) {
    const hc = await this.cur(heapAddr, 32 + 2 * this.sl);
    hc.skip(8); const dsize = hc.len(); hc.len(); const daddr = hc.addr();
    const heap = await this._read(daddr, dsize);
    const visit = async (node) => {
      const c = await this.cur(node, 8 + 2 * this.so + 4096);
      if (c.sig() !== 'TREE') throw new Error('bad group B-tree');
      c.skip(4); c.u8(); const level = c.u8(); const n = c.u16(); c.addr(); c.addr();
      const kids = [];
      for (let i = 0; i < n; i++) { c.len(); kids.push(c.addr()); }
      for (const k of kids) {
        if (level > 0) { await visit(k); continue; }
        const s = await this.cur(k, 8 + 2048 * (2 * this.so + 24));
        if (s.sig() !== 'SNOD') throw new Error('bad symbol node');
        s.skip(6); const ns = s.u16();
        for (let j = 0; j < ns; j++) {
          const nameOff = s.addr(), oh = s.addr(); s.skip(24);
          let e = nameOff; while (heap[e]) e++;
          out.set(dec.decode(heap.subarray(nameOff, e)), oh);
        }
      }
    };
    await visit(btAddr);
  }

  // ------------------------------------------------------------------ fractal heap
  async _fheap(addr) {
    const c = await this.cur(addr, 256);
    if (c.sig() !== 'FRHP') throw new Error('bad fractal heap');
    c.skip(5);
    const idLen = c.u16(), filtLen = c.u16(), flags = c.u8(), maxMan = c.u32();
    c.len(); c.addr(); c.len(); c.addr(); c.len(); c.len(); c.len(); c.len(); c.len(); c.len(); c.len(); c.len();
    const width = c.u16(), startBlk = c.len(), maxDirect = c.len(), maxHeapBits = c.u16();
    c.u16(); const root = c.addr(), curRows = c.u16();
    if (filtLen) throw new Error('filtered fractal heaps are not supported');
    const offSize = Math.ceil(maxHeapBits / 8);
    const lenSize = Math.min(Math.ceil(Math.log2(maxDirect) / 8), encSize(maxMan));
    return { addr, idLen, flags, maxMan, width, startBlk, maxDirect, root, curRows, offSize, lenSize,
      maxDirRows: Math.log2(maxDirect) - Math.log2(startBlk) + 2, blocks: new Map() };
  }

  async _fheapObj(hp, id) {
    const t = (id[0] >> 4) & 3;
    if (t === 2) { // tiny: length in low nibble
      const n = (id[0] & 15) + 1; return id.subarray(1, 1 + n);
    }
    if (t !== 0) throw new Error('huge fractal heap objects are not supported');
    const c = new Cur(id, 1);
    const off = c.uN(hp.offSize), len = c.uN(hp.lenSize);
    const blk = await this._fheapFind(hp, off);
    return (await this._read(blk.addr + (off - blk.off), len));
  }

  // locate the direct block holding heap offset `off` -> {addr, off(start offset of block)}
  async _fheapFind(hp, off) {
    if (hp.curRows === 0) return { addr: hp.root, off: 0 };
    const rowSize = (r) => (r === 0 ? hp.startBlk : hp.startBlk * 2 ** (r - 1));
    const walk = async (iaddr, nrows, base) => {
      const ndir = Math.min(nrows, hp.maxDirRows);
      const nent = nrows * hp.width;
      const c = await this.cur(iaddr, 5 + this.so + hp.offSize + nent * this.so + 4);
      c.skip(5 + this.so + hp.offSize);
      let o = base;
      for (let r = 0; r < nrows; r++) {
        const sz = rowSize(r);
        for (let k = 0; k < hp.width; k++) {
          const a = c.addr();
          if (off >= o && off < o + sz) {
            if (r < ndir) return { addr: a, off: o };
            // nested indirect block of this row size
            const sub = Math.round(Math.log2(sz) - Math.log2(hp.startBlk * hp.width)) + 1;
            return walk(a, sub, o);
          }
          o += sz;
        }
      }
      throw new Error('fractal heap offset not found');
    };
    return walk(hp.root, hp.curRows, 0);
  }

  // ------------------------------------------------------------------ v2 B-tree: every record
  async _btree2(addr) {
    const c = await this.cur(addr, 64);
    if (c.sig() !== 'BTHD') throw new Error('bad v2 B-tree');
    c.skip(5);
    c.u8(); // type
    const nodeSize = c.u32(), recSize = c.u16(), depth = c.u16(); c.skip(2);
    const root = c.addr(), rootN = c.u16();
    // node geometry (H5B2__hdr_init)
    const PREFIX = 10;
    const info = [{ max: Math.floor((nodeSize - PREFIX) / recSize) }];
    info[0].cum = info[0].max; info[0].cumSize = 0;
    const maxNrecSize = encSize(info[0].max);
    for (let d = 1; d <= depth; d++) {
      const ptr = this.so + maxNrecSize + info[d - 1].cumSize;
      const max = Math.floor((nodeSize - (PREFIX + ptr)) / (recSize + ptr));
      const cum = (max + 1) * info[d - 1].cum + max;
      info.push({ max, cum, cumSize: encSize(cum) });
    }
    const recs = [];
    const visit = async (a, n, d) => {
      const u = await this._read(a, nodeSize);
      const nc = new Cur(u, 6, this.so, this.sl);
      for (let i = 0; i < n; i++) recs.push(nc.bytes(recSize));
      if (d === 0) return;
      const kids = [];
      for (let i = 0; i <= n; i++) {
        const ka = nc.addr(), kn = nc.uN(maxNrecSize);
        if (d > 1) nc.uN(info[d - 1].cumSize);
        kids.push([ka, kn]);
      }
      for (const [ka, kn] of kids) await visit(ka, kn, d - 1);
    };
    if (root !== UNDEF) await visit(root, rootN, depth);
    return recs;
  }

  // ------------------------------------------------------------------ objects
  async resolve(path) {
    let addr = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      const l = await this.links(addr);
      if (!l.has(part)) throw new Error(`HDF5: no object '${part}'`);
      addr = l.get(part);
    }
    return addr;
  }

  async names() { return [...(await this.links(this.root)).keys()]; }

  async dataset(path) {
    const addr = await this.resolve(path);
    const msgs = await this.header(addr);
    const ds = { path, addr, attrs: new Map(), filters: [], shape: [], file: this };
    for (const m of msgs) {
      const c = new Cur(m.body, 0, this.so, this.sl);
      if (m.type === 0x01) { const s = parseDataspace(c); ds.shape = s.shape; ds.n = s.n; }
      else if (m.type === 0x03) ds.dtype = parseDatatype(c);
      else if (m.type === 0x08) ds.layout = this._layout(c);
      else if (m.type === 0x0b) ds.filters = parseFilters(c);
      else if (m.type === 0x0c) { const a = this._attr(m.body); if (a) ds.attrs.set(a.name, a.value); }
      else if (m.type === 0x15) await this._denseAttrs(c, ds.attrs);
    }
    return ds;
  }

  async attrs(path) { return (await this.dataset(path)).attrs; }

  _layout(c) {
    const ver = c.u8();
    if (ver < 3) throw new Error('old data layout message');
    const cls = c.u8();
    const L = { cls, ver };
    if (cls === 0) { const n = c.u16(); L.data = c.bytes(n); }
    else if (cls === 1) { L.addr = c.addr(); L.size = c.len(); }
    else if (cls === 2) {
      if (ver === 3) {
        const rank = c.u8(); L.index = 'btree1'; L.addr = c.addr();
        L.chunk = []; for (let i = 0; i < rank; i++) L.chunk.push(c.u32());
        L.elem = L.chunk.pop();
      } else {
        L.flags = c.u8(); const rank = c.u8(), es = c.u8();
        L.chunk = []; for (let i = 0; i < rank; i++) L.chunk.push(c.uN(es));
        L.elem = L.chunk.pop();
        const it = c.u8();
        L.index = { 1: 'single', 2: 'implicit', 3: 'farray', 4: 'earray', 5: 'btree2' }[it];
        if (it === 1 && (L.flags & 2)) { L.fsize = c.len(); L.fmask = c.u32(); }
        else if (it === 3) c.skip(1);
        else if (it === 4) c.skip(5);
        else if (it === 5) c.skip(6);
        L.addr = c.addr();
      }
    }
    return L;
  }

  _attr(body) {
    const c = new Cur(body, 0, this.so, this.sl);
    const ver = c.u8(); c.u8();
    const nlen = c.u16(), tlen = c.u16(), slen = c.u16();
    if (ver >= 3) c.u8();
    const pad = (n) => (ver === 1 ? Math.ceil(n / 8) * 8 : n);
    const name = c.str(nlen); c.p += pad(nlen) - nlen;
    const tStart = c.p; const t = parseDatatype(c); c.p = tStart + pad(tlen);
    const sStart = c.p; const s = parseDataspace(c); c.p = sStart + pad(slen);
    if (t.vlen) return { name, value: null };
    const n = Math.max(1, s.n);
    const vals = decodeValues(c.u.subarray(c.p), t, n);
    return { name, value: t.str ? vals[0] : (vals.length === 1 && s.shape.length === 0 ? vals[0] : vals) };
  }

  async _denseAttrs(c, out) {
    c.u8(); const fl = c.u8(); if (fl & 1) c.skip(2);
    const fheap = c.addr(), nameBt = c.addr();
    if (fheap === UNDEF || nameBt === UNDEF) return;
    const hp = await this._fheap(fheap);
    const recs = await this._btree2(nameBt);
    await Promise.all(recs.map(async (r) => {
      // 'huge' heap objects (big array attributes, e.g. GK2A's) are skipped: nothing reads them
      if (((r[0] >> 4) & 3) === 1) return;
      const obj = await this._fheapObj(hp, r.subarray(0, hp.idLen));
      const a = this._attr(obj);
      if (a) out.set(a.name, a.value);
    }));
  }

  // ------------------------------------------------------------------ data
  /** Entire (small) dataset as plain numbers. */
  async readAll(ds) {
    const n = Math.max(1, ds.n || 1), t = ds.dtype, L = ds.layout;
    let raw;
    if (L.cls === 0) raw = L.data;
    else if (L.cls === 1) raw = L.addr === UNDEF ? new Uint8Array(n * t.size) : await this._read(L.addr, n * t.size);
    else {
      const chunks = await this.chunkList(ds);
      const out = new Uint8Array(n * t.size);
      const cs = L.chunk, rank = cs.length, sh = ds.shape;
      for (const ch of chunks) {
        const u = await decodeChunk(await this._read(ch.addr, ch.size), ds.filters, ch.mask, t.size);
        if (rank === 1) {
          const o = ch.off[0], m = Math.min(cs[0], sh[0] - o);
          out.set(u.subarray(0, m * t.size), o * t.size);
        } else throw new Error('readAll: only 1-D chunked datasets');
      }
      raw = out;
    }
    const vals = decodeValues(raw, t, n);
    return ds.shape.length === 0 ? vals[0] : vals;
  }

  /** Chunks of a chunked dataset ({off:[...], addr, size, mask}); optionally only those
   *  intersecting a 2-D window [r0, r1) x [c0, c1). */
  async chunkList(ds, win) {
    const L = ds.layout;
    const cs = L.chunk;
    const hit = (off) => !win || (off[0] < win[1] && off[0] + cs[0] > win[0] && off[1] < win[3] && off[1] + cs[1] > win[2]);
    if (L.index === 'btree1') return this._chunksBtree1(ds, hit, win);
    const nper = ds.shape.map((s, i) => Math.ceil(s / cs[i]));
    const total = nper.reduce((a, b) => a * b, 1);
    const offOf = (k) => { // linear chunk index -> offsets (row-major)
      const off = new Array(nper.length);
      for (let i = nper.length - 1; i >= 0; i--) { off[i] = (k % nper[i]) * cs[i]; k = Math.floor(k / nper[i]); }
      return off;
    };
    const chunkBytes = cs.reduce((a, b) => a * b, 1) * L.elem;
    if (L.index === 'single') return [{ off: ds.shape.map(() => 0), addr: L.addr, size: L.fsize || chunkBytes, mask: L.fmask || 0 }];
    if (L.index === 'implicit') {
      const out = [];
      for (let k = 0; k < total; k++) { const off = offOf(k); if (hit(off)) out.push({ off, addr: L.addr + k * chunkBytes, size: chunkBytes, mask: 0 }); }
      return out;
    }
    if (L.index === 'farray') return this._chunksFarray(ds, total, offOf, hit, chunkBytes);
    throw new Error(`HDF5 chunk index '${L.index}' not supported`);
  }

  async _chunksBtree1(ds, hit, win) {
    const L = ds.layout, rank = L.chunk.length + 1, cs = L.chunk;
    const keySize = 8 + 8 * rank;
    const out = [];
    let level = [L.addr];
    while (level.length) {
      const next = [];
      await Promise.all(level.map(async (a) => {
        const head = await this.cur(a, 8 + 2 * this.so);
        if (head.sig() !== 'TREE') throw new Error('bad chunk B-tree');
        head.skip(5); const lvl = head.u8(), n = head.u16();
        const c = await this.cur(a + 8 + 2 * this.so, n * (keySize + this.so) + keySize);
        const keys = [], kids = [];
        for (let i = 0; i <= n; i++) {
          const size = c.u32(), mask = c.u32();
          const off = []; for (let d = 0; d < rank; d++) off.push(c.u64());
          off.pop();
          keys.push({ size, mask, off });
          if (i < n) kids.push(c.addr());
        }
        for (let i = 0; i < n; i++) {
          if (lvl === 0) { if (hit(keys[i].off)) out.push({ off: keys[i].off, addr: kids[i], size: keys[i].size, mask: keys[i].mask }); }
          else {
            // child i holds chunks from key i up to (not incl.) key i+1 in row-major order
            if (win && rank === 3) {
              const rlo = keys[i].off[0], rhi = keys[i + 1].off[0] + cs[0];
              if (rhi <= win[0] || rlo >= win[1]) continue;
            }
            next.push(kids[i]);
          }
        }
      }));
      level = next;
    }
    return out;
  }

  async _chunksFarray(ds, total, offOf, hit, chunkBytes) {
    const L = ds.layout;
    const filtered = ds.filters.length > 0;
    const c = await this.cur(L.addr, 64);
    if (c.sig() !== 'FAHD') throw new Error('bad fixed array header');
    c.skip(5); c.u8(); const esz = c.u8(), pageBits = c.u8(); const nel = c.len(); const dblk = c.addr();
    const d = await this.cur(dblk, 6 + this.so + Math.ceil(nel / 8) + nel * esz + 64);
    d.skip(6 + this.so);
    const pageN = 1 << pageBits;
    const paged = nel > pageN;
    if (paged) throw new Error('paged fixed arrays are not supported');
    const out = [];
    const sizeBytes = filtered ? esz - this.so - 4 : 0;
    for (let k = 0; k < Math.min(nel, total); k++) {
      const addr = d.addr();
      let size = chunkBytes, mask = 0;
      if (filtered) { size = d.uN(sizeBytes); mask = d.u32(); }
      const off = offOf(k);
      if (addr !== UNDEF && hit(off)) out.push({ off, addr, size, mask });
    }
    return out;
  }

  absolute(addr) { return this.base + addr; }
}

function parseFilters(c) {
  const ver = c.u8(), n = c.u8();
  if (ver === 1) c.skip(6);
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = c.u16();
    const nlen = ver === 1 || id >= 256 ? c.u16() : 0;
    const flags = c.u16(), nv = c.u16();
    if (nlen) c.skip(ver === 1 ? Math.ceil(nlen / 8) * 8 : nlen);
    const vals = []; for (let j = 0; j < nv; j++) vals.push(c.u32());
    if (ver === 1 && nv % 2) c.skip(4);
    out.push({ id, flags, vals });
  }
  return out;
}

// --------------------------------------------------------------------------- filters
let inflateImpl = null;
export function setInflate(fn) { inflateImpl = fn; }

export async function decodeChunk(u8, filters, mask, elemSize) {
  let d = u8;
  for (let i = filters.length - 1; i >= 0; i--) {
    if (mask & (1 << i)) continue;
    const f = filters[i];
    if (f.id === 1) d = await inflateImpl(d);
    else if (f.id === 2) d = unshuffle(d, f.vals[0] || elemSize);
    else if (f.id === 3) d = d.subarray(0, d.length - 4);
    else throw new Error(`HDF5 filter ${f.id} not supported`);
  }
  return d;
}

export function unshuffle(u8, es) {
  if (es <= 1) return u8;
  const n = Math.floor(u8.length / es), out = new Uint8Array(u8.length);
  if (es === 2) {
    for (let i = 0; i < n; i++) { out[2 * i] = u8[i]; out[2 * i + 1] = u8[n + i]; }
  } else {
    for (let b = 0; b < es; b++) { const src = b * n; for (let i = 0; i < n; i++) out[i * es + b] = u8[src + i]; }
  }
  if (n * es < u8.length) out.set(u8.subarray(n * es), n * es);
  return out;
}
