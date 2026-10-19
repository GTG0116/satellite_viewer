/* bzip2 decompressor (Himawari HSD segments are distributed as .DAT.bz2).
 *
 * A straightforward, allocation-light implementation of the bzip2 format: Huffman groups with
 * limit/base tables, RUNA/RUNB + move-to-front decoding, inverse BWT through a single Int32
 * vector, then the final run-length expansion. Concatenated streams are supported. CRCs are not
 * verified (S3 transfers are already checked by TCP/TLS).
 */

class Bits {
  constructor(u8) { this.u = u8; this.p = 0; this.buf = 0; this.n = 0; }
  bits(k) { // k <= 24
    while (this.n < k) { this.buf = ((this.buf << 8) | (this.u[this.p++] ?? 0)) >>> 0; this.n += 8; }
    this.n -= k;
    return (this.buf >>> this.n) & ((1 << k) - 1);
  }
  bit() { return this.bits(1); }
  eof() { return this.p >= this.u.length && this.n < 8; }
}

const MAX_GROUPS = 6, MAX_ALPHA = 258, MAX_LEN = 20, LUT_BITS = 10;

export function bunzip2(src, sizeHint = 0) {
  let out = new Uint8Array(sizeHint > 0 ? sizeHint : Math.max(1 << 20, src.length * 6));
  let op = 0;
  const grow = (need) => {
    if (op + need <= out.length) return;
    let m = out.length * 2; while (m < op + need) m *= 2;
    const o = new Uint8Array(m); o.set(out.subarray(0, op)); out = o;
  };
  const br = new Bits(src);
  let tt = null;

  while (!br.eof()) {
    // stream header
    if (br.bits(8) !== 0x42 || br.bits(8) !== 0x5a || br.bits(8) !== 0x68) break;
    const level = br.bits(8) - 0x30;
    if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
    const maxBlock = level * 100000;
    if (!tt || tt.length < maxBlock) tt = new Int32Array(maxBlock);

    for (;;) {
      const m1 = br.bits(24), m2 = br.bits(24);
      if (m1 === 0x177245 && m2 === 0x385090) { br.bits(24); br.bits(8); br.n -= br.n % 8; break; } // end of stream (+crc), byte align
      if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block magic');
      br.bits(16); br.bits(16); // block CRC
      if (br.bit()) throw new Error('bzip2: randomised blocks are not supported');
      const origPtr = br.bits(24);

      // symbol map
      const used = br.bits(16);
      const seqToUnseq = new Uint8Array(256);
      let nInUse = 0;
      for (let i = 0; i < 16; i++) {
        if (used & (0x8000 >> i)) {
          const w = br.bits(16);
          for (let j = 0; j < 16; j++) if (w & (0x8000 >> j)) seqToUnseq[nInUse++] = i * 16 + j;
        }
      }
      const alpha = nInUse + 2;
      const nGroups = br.bits(3);
      if (nGroups < 2 || nGroups > MAX_GROUPS) throw new Error('bzip2: bad group count');
      const nSel = br.bits(15);
      const selMtf = new Uint8Array(nSel);
      for (let i = 0; i < nSel; i++) { let j = 0; while (br.bit()) { j++; if (j >= nGroups) throw new Error('bzip2: bad selector'); } selMtf[i] = j; }
      const pos = [0, 1, 2, 3, 4, 5];
      const sel = new Uint8Array(nSel);
      for (let i = 0; i < nSel; i++) {
        let v = selMtf[i]; const tmp = pos[v];
        while (v > 0) { pos[v] = pos[v - 1]; v--; }
        pos[0] = tmp; sel[i] = tmp;
      }

      // Huffman tables: limit/base/perm per group
      const limit = [], base = [], perm = [], minLen = [], luts = [];
      const len = new Uint8Array(MAX_ALPHA);
      for (let g = 0; g < nGroups; g++) {
        let cur = br.bits(5);
        for (let s = 0; s < alpha; s++) {
          for (;;) {
            if (cur < 1 || cur > MAX_LEN) throw new Error('bzip2: bad code length');
            if (!br.bit()) break;
            cur += br.bit() ? -1 : 1;
          }
          len[s] = cur;
        }
        let mn = 32, mx = 0;
        for (let s = 0; s < alpha; s++) { if (len[s] > mx) mx = len[s]; if (len[s] < mn) mn = len[s]; }
        const P = new Uint16Array(MAX_ALPHA), L = new Int32Array(MAX_LEN + 2), B = new Int32Array(MAX_LEN + 2);
        let pp = 0;
        for (let l = mn; l <= mx; l++) for (let s = 0; s < alpha; s++) if (len[s] === l) P[pp++] = s;
        const cnt = new Int32Array(MAX_LEN + 2);
        for (let s = 0; s < alpha; s++) cnt[len[s]]++;
        let code = 0, idx = 0;
        for (let l = mn; l <= mx; l++) {
          B[l] = idx - code;       // perm index = code + B[l]
          code += cnt[l]; idx += cnt[l];
          L[l] = code - 1;         // largest code of this length
          code <<= 1;
        }
        L[mx + 1] = 0x7fffffff;
        // fast path: codes up to LUT_BITS long decoded with one table lookup
        const lut = new Uint16Array(1 << LUT_BITS);
        for (let l = mn; l <= Math.min(mx, LUT_BITS); l++) {
          for (let c = L[l] - cnt[l] + 1; c <= L[l]; c++) {
            const e = (l << 9) | P[c + B[l]], sh = LUT_BITS - l;
            for (let k = 0; k < (1 << sh); k++) lut[(c << sh) | k] = e;
          }
        }
        limit.push(L); base.push(B); perm.push(P); minLen.push(mn); luts.push(lut);
      }

      // MTF / RLE2 decode into tt (low byte = symbol)
      const mtf = new Uint8Array(256);
      for (let i = 0; i < 256; i++) mtf[i] = i;
      const counts = new Int32Array(256);
      const EOB = nInUse + 1;
      let n = 0, gi = -1, left = 0, run = 0, runBit = 1;
      let L = null, B = null, P = null, mn = 0, LUT = null;
      // bit reader state kept in locals for the hot loop
      const u = br.u; let bp = br.p, bb = br.buf, bn = br.n;
      for (;;) {
        if (left === 0) {
          gi++; if (gi >= nSel) throw new Error('bzip2: selectors exhausted');
          const g = sel[gi]; L = limit[g]; B = base[g]; P = perm[g]; mn = minLen[g]; LUT = luts[g]; left = 50;
        }
        left--;
        while (bn < 24) { bb = ((bb << 8) | (u[bp++] ?? 0)) >>> 0; bn += 8; }
        let sym;
        const e = LUT[(bb >>> (bn - LUT_BITS)) & ((1 << LUT_BITS) - 1)];
        if (e) { bn -= e >> 9; sym = e & 511; }
        else {
          let l = mn, c = (bb >>> (bn - mn)) & ((1 << mn) - 1); bn -= mn;
          while (c > L[l]) {
            l++; if (l > MAX_LEN) throw new Error('bzip2: bad Huffman code');
            if (bn < 1) { bb = ((bb << 8) | (u[bp++] ?? 0)) >>> 0; bn += 8; }
            bn--; c = (c << 1) | ((bb >>> bn) & 1);
          }
          sym = P[c + B[l]];
        }
        if (sym <= 1) { // RUNA / RUNB
          run += (sym + 1) * runBit; runBit <<= 1;
          continue;
        }
        if (run) {
          const v = seqToUnseq[mtf[0]];
          if (n + run > maxBlock) throw new Error('bzip2: block overflow');
          counts[v] += run;
          for (; run; run--) tt[n++] = v;
          runBit = 1;
        }
        if (sym === EOB) { br.p = bp; br.buf = bb; br.n = bn; break; }
        // move-to-front by (sym - 1)
        let k = sym - 1; const v0 = mtf[k];
        if (k > 12) mtf.copyWithin(1, 0, k);
        else while (k > 0) { mtf[k] = mtf[k - 1]; k--; }
        mtf[0] = v0;
        const v = seqToUnseq[v0];
        if (n >= maxBlock) throw new Error('bzip2: block overflow');
        counts[v]++; tt[n++] = v;
      }
      if (origPtr >= n) throw new Error('bzip2: bad origPtr');

      // inverse BWT: tt[cum[c]++] |= i << 8
      const cum = new Int32Array(256);
      for (let i = 0, s = 0; i < 256; i++) { cum[i] = s; s += counts[i]; }
      for (let i = 0; i < n; i++) { const c = tt[i] & 0xff; tt[cum[c]++] |= i << 8; }

      // walk + final RLE1 (runs of 4 equal bytes followed by a repeat count)
      grow(n + 1024);
      let t = tt[origPtr] >> 8;
      let last = -1, same = 0;
      for (let i = 0; i < n; i++) {
        const e = tt[t]; const b = e & 0xff; t = e >> 8;
        if (same === 4) {
          if (b) { grow(b + n - i + 16); out.fill(last, op, op + b); op += b; }
          same = 0; last = -1; continue;
        }
        if (b === last) same++; else { same = 1; last = b; }
        if (op >= out.length) grow(n - i + 16);
        out[op++] = b;
      }
    }
  }
  return out.subarray(0, op);
}
