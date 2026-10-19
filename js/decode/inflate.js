/* zlib / raw DEFLATE decoding.
 *
 * Uses the browser's native DecompressionStream when it exists (fast, off the JS heap), and a
 * compact table-driven JavaScript inflater otherwise (older Safari / embedded browsers).
 */

const HAS_NATIVE = typeof DecompressionStream === 'function';

export async function inflateZlib(u8) {
  if (HAS_NATIVE) {
    try {
      const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    } catch (e) { /* fall through to the JS decoder */ }
  }
  return inflateRaw(u8.subarray(2)); // skip the 2-byte zlib header (adler32 trailer is ignored)
}

// ------------------------------------------------------------------ JS inflate
const LBASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
const LEXT = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DBASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
const DEXT = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Huffman table: lookup by `bits` reversed bits -> (len << 16 | symbol)
function buildTable(lengths, n) {
  let max = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > max) max = lengths[i];
  const count = new Uint16Array(16), next = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  let code = 0;
  for (let b = 1; b <= 15; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  const size = 1 << max, t = new Int32Array(size);
  for (let s = 0; s < n; s++) {
    const l = lengths[s];
    if (!l) continue;
    let c = next[l]++, r = 0;
    for (let i = 0; i < l; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    for (let j = r; j < size; j += 1 << l) t[j] = (l << 16) | s;
  }
  return { t, max };
}

let FIXED_L = null, FIXED_D = null;
function fixedTables() {
  if (!FIXED_L) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED_L = buildTable(l, 288);
    FIXED_D = buildTable(new Uint8Array(30).fill(5), 30);
  }
}

export function inflateRaw(src, sizeHint = 0) {
  let out = new Uint8Array(sizeHint || src.length * 4 + 1024), op = 0;
  let pos = 0, bit = 0, buf = 0;
  const need = (n) => { while (bit < n) { buf |= (src[pos++] | 0) << bit; bit += 8; } };
  const bits = (n) => { need(n); const v = buf & ((1 << n) - 1); buf >>>= n; bit -= n; return v; };
  const sym = (h) => {
    need(h.max);
    const e = h.t[buf & ((1 << h.max) - 1)];
    const l = e >>> 16; buf >>>= l; bit -= l; return e & 0xffff;
  };
  const grow = (n) => {
    if (op + n <= out.length) return;
    let m = out.length * 2; while (m < op + n) m *= 2;
    const o2 = new Uint8Array(m); o2.set(out.subarray(0, op)); out = o2;
  };
  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      buf = 0; bit = 0;
      const len = src[pos] | (src[pos + 1] << 8); pos += 4;
      grow(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
      continue;
    }
    let lt, dt;
    if (type === 1) { fixedTables(); lt = FIXED_L; dt = FIXED_D; }
    else {
      const hl = bits(5) + 257, hd = bits(5) + 1, hc = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hc; i++) cl[CLORDER[i]] = bits(3);
      const ct = buildTable(cl, 19);
      const lens = new Uint8Array(hl + hd);
      for (let i = 0; i < hl + hd;) {
        const s = sym(ct);
        if (s < 16) lens[i++] = s;
        else if (s === 16) { const p = lens[i - 1]; for (let r = bits(2) + 3; r; r--) lens[i++] = p; }
        else if (s === 17) i += bits(3) + 3;
        else i += bits(7) + 11;
      }
      lt = buildTable(lens.subarray(0, hl), hl);
      dt = buildTable(lens.subarray(hl), hd);
    }
    for (;;) {
      const s = sym(lt);
      if (s < 256) { if (op >= out.length) grow(1); out[op++] = s; continue; }
      if (s === 256) break;
      const li = s - 257;
      const len = LBASE[li] + bits(LEXT[li]);
      const di = sym(dt);
      const dist = DBASE[di] + bits(DEXT[di]);
      grow(len);
      let from = op - dist;
      for (let k = 0; k < len; k++) out[op++] = out[from++];
    }
  }
  return out.subarray(0, op);
}
