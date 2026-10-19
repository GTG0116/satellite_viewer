/* Himawari Standard Data (HSD) segment decoder: header blocks 1-11 + uint16 counts. */

export function parseHSD(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const blocks = {};
  let off = 0;
  for (let i = 0; i < 11; i++) {
    const no = u8[off];
    const len = no === 10 ? v.getUint32(off + 1, true) : v.getUint16(off + 1, true);
    blocks[no] = off; off += len;
  }
  const b1 = blocks[1], b2 = blocks[2], b3 = blocks[3], b5 = blocks[5], b7 = blocks[7];
  const hdrLen = v.getUint32(b1 + 70, true);
  const area = String.fromCharCode(u8[b1 + 38], u8[b1 + 39], u8[b1 + 40], u8[b1 + 41]);
  const obsStart = v.getFloat64(b1 + 46, true); // MJD
  const ncols = v.getUint16(b2 + 5, true), nlines = v.getUint16(b2 + 7, true);
  const h = {
    area, ncols, nlines,
    subLon: v.getFloat64(b3 + 3, true),
    cfac: v.getUint32(b3 + 11, true), lfac: v.getUint32(b3 + 15, true),
    coff: v.getFloat32(b3 + 19, true), loff: v.getFloat32(b3 + 23, true),
    rs: v.getFloat64(b3 + 27, true) * 1000, req: v.getFloat64(b3 + 35, true) * 1000, rpol: v.getFloat64(b3 + 43, true) * 1000,
    nseg: u8[b7 + 3], segno: u8[b7 + 4], firstLine: v.getUint16(b7 + 5, true),
    time: new Date(Date.UTC(1858, 10, 17) + obsStart * 86400000),
    hdrLen,
  };
  const band = v.getUint16(b5 + 3, true);
  const cal = { band, wl: v.getFloat64(b5 + 5, true), vbits: v.getUint16(b5 + 13, true), err: v.getUint16(b5 + 15, true),
    out: v.getUint16(b5 + 17, true), slope: v.getFloat64(b5 + 19, true), icpt: v.getFloat64(b5 + 27, true) };
  if (band >= 7) {
    cal.tb = [v.getFloat64(b5 + 35, true), v.getFloat64(b5 + 43, true), v.getFloat64(b5 + 51, true)];
    cal.c = v.getFloat64(b5 + 83, true); cal.h = v.getFloat64(b5 + 91, true); cal.k = v.getFloat64(b5 + 99, true);
  } else cal.alb = v.getFloat64(b5 + 35, true);
  h.cal = cal;
  // counts may not be 2-byte aligned within the file: copy only when needed
  const start = u8.byteOffset + hdrLen;
  h.counts = start % 2 === 0
    ? new Uint16Array(u8.buffer, start, ncols * nlines)
    : new Uint16Array(u8.slice(hdrLen, hdrLen + ncols * nlines * 2).buffer);
  return h;
}

/** Physical value for one count (reflectance factor or brightness temperature K), NaN for bad. */
export function hsdCalibrator(cal) {
  const maxc = (1 << cal.vbits) - 1;
  if (cal.band <= 6) {
    return (c) => (c === cal.err || c === cal.out || c > maxc ? NaN : (c * cal.slope + cal.icpt) * cal.alb);
  }
  const lam = cal.wl * 1e-6, hh = cal.h, cc = cal.c, k = cal.k, [c0, c1, c2] = cal.tb;
  const A = hh * cc / (k * lam), B = 2 * hh * cc * cc / (lam ** 5);
  return (c) => {
    if (c === cal.err || c === cal.out || c > maxc) return NaN;
    const rad = c * cal.slope + cal.icpt;
    if (rad <= 0) return NaN;
    const te = A / Math.log(B / (rad * 1e6) + 1);
    return c0 + c1 * te + c2 * te * te;
  };
}

/** Grid of a segment/file. FLDK segments use global line numbers (row 0 = disk line 1). */
export function hsdGrid(h, localRows) {
  const sx = 65536 / h.cfac, sy = 65536 / h.lfac, D = Math.PI / 180;
  return { lon0: h.subLon, H: h.rs, req: h.req, rpol: h.rpol, sweep: 'y',
    x0: (1 - h.coff) * sx * D, dx: sx * D, y0: -(1 - h.loff) * sy * D, dy: -sy * D,
    ny: localRows ? h.nlines : h.nlines * h.nseg, nx: h.ncols };
}
