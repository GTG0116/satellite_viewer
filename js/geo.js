/* Geostationary fixed-grid navigation (GOES ABI sweep 'x', Himawari AHI sweep 'y'), shared by the
 * decode workers and the renderer. A grid maps pixel centres to scan angles
 *   x = x0 + col * dx,   y = y0 + row * dy   (radians, y positive north)
 * and every image <-> lon/lat mapping is exact nearest-pixel lookup through this model.
 * Polar-orbiter slices use the same row / column form on a local equal-area grid (proj 'laea').
 */

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export function makeGrid(g) {
  return { lon0: g.lon0, H: g.H, req: g.req, rpol: g.rpol, sweep: g.sweep, x0: g.x0, dx: g.dx, y0: g.y0, dy: g.dy, ny: g.ny, nx: g.nx };
}

export function subgrid(g, r0, c0, ny, nx, stride = 1) {
  return { ...g, x0: g.x0 + c0 * g.dx, dx: g.dx * stride, y0: g.y0 + r0 * g.dy, dy: g.dy * stride, ny, nx };
}

/** Grid whose pixels split each pixel into f x f (pixel replication). */
export function refine(g, f) {
  if (f === 1) return g;
  const ndx = g.dx / f, ndy = g.dy / f;
  return { ...g, x0: g.x0 - g.dx / 2 + ndx / 2, dx: ndx, y0: g.y0 - g.dy / 2 + ndy / 2, dy: ndy, ny: g.ny * f, nx: g.nx * f };
}

export const resKm = (g) => (g.proj === 'laea' ? Math.abs(g.dx) : Math.abs(g.dx) * (g.H - g.req) / 1000);
export const gridKey = (g) => [g.lon0, g.lat0 || 0, g.rs || 0, g.x0, g.dx, g.y0, g.dy, g.ny, g.nx].map((v) => +(+v).toPrecision(9)).join(',');

// ------------------------------------------------------------------ polar swaths
// Polar-orbiter slices are resampled (nearest swath pixel) onto a Lambert azimuthal equal-area
// grid centred on the slice: {proj: 'laea', lon0, lat0, rc, rs, x0, dx, y0, dy, nx, ny}, x / y in
// km, the axes turned (rc, rs: cos, sin) so columns run along the ground track and the grid hugs
// the swath. One formula works at any latitude, poles included.
const R_EARTH = 6371.0072;

/** Lon/lat (deg) -> LAEA x / y (km) about (lon0, lat0); null at the antipode. */
export function laeaXY(lon0, lat0, lon, lat, out = [0, 0]) {
  const p0 = lat0 * D2R, p = lat * D2R, dl = (lon - lon0) * D2R;
  const sp0 = Math.sin(p0), cp0 = Math.cos(p0), sp = Math.sin(p), cp = Math.cos(p), cdl = Math.cos(dl);
  const d = 1 + sp0 * sp + cp0 * cp * cdl;
  if (d < 1e-9) return null;
  const k = R_EARTH * Math.sqrt(2 / d);
  out[0] = k * cp * Math.sin(dl);
  out[1] = k * (cp0 * sp - sp0 * cp * cdl);
  return out;
}

/** Turn of the grid axes that lines the ground track (first to last nadir point [lon, lat]) up
 *  with the grid's rows: {rc, rs} = cos / sin of the turn. */
export function trackTurn(lon0, lat0, nadir) {
  const a = [0, 0], b = [0, 0];
  if (nadir.length < 2 || !laeaXY(lon0, lat0, nadir[0][0], nadir[0][1], a) || !laeaXY(lon0, lat0, nadir[nadir.length - 1][0], nadir[nadir.length - 1][1], b)) return { rc: 1, rs: 0 };
  const tx = b[0] - a[0], ty = b[1] - a[1], n = Math.hypot(tx, ty);
  return n > 0 ? { rc: ty / n, rs: tx / n } : { rc: 1, rs: 0 };
}

function laeaLonLat(g, x, y, out) {
  const rho = Math.hypot(x, y);
  if (rho > 2 * R_EARTH) return null;
  const p0 = g.lat0 * D2R;
  if (rho < 1e-9) { out[0] = g.lon0; out[1] = g.lat0; return out; }
  const c = 2 * Math.asin(rho / (2 * R_EARTH)), sc = Math.sin(c), cc = Math.cos(c);
  const lat = Math.asin(Math.max(-1, Math.min(1, cc * Math.sin(p0) + (y * sc * Math.cos(p0)) / rho)));
  const lon = g.lon0 + Math.atan2(x * sc, rho * Math.cos(p0) * cc - y * Math.sin(p0) * sc) * R2D;
  out[0] = ((lon + 180) % 360 + 360) % 360 - 180; out[1] = lat * R2D;
  return out;
}

/** lon/lat (deg) -> scan angles; returns null when the point is not visible from the satellite. */
export function lonlatToXY(g, lon, lat, out = [0, 0]) {
  if (g.proj === 'laea') {
    if (!laeaXY(g.lon0, g.lat0, lon, lat, out)) return null;
    // grid axes turned to follow the ground track (rc / rs: cos / sin of the turn)
    if (g.rs) { const x = out[0], y = out[1]; out[0] = x * g.rc - y * g.rs; out[1] = x * g.rs + y * g.rc; }
    return out;
  }
  const req2 = g.req * g.req, rpol2 = g.rpol * g.rpol;
  const e2 = (req2 - rpol2) / req2;
  const phic = Math.atan(rpol2 / req2 * Math.tan(lat * D2R));
  const cphic = Math.cos(phic);
  const rc = g.rpol / Math.sqrt(1 - e2 * cphic * cphic);
  const dl = (lon - g.lon0) * D2R;
  const s1 = g.H - rc * cphic * Math.cos(dl);
  const se = rc * cphic * Math.sin(dl);
  const sn = rc * Math.sin(phic);
  if (g.H * (g.H - s1) < se * se + (req2 / rpol2) * sn * sn) return null;
  if (g.sweep === 'x') {
    out[0] = Math.asin(se / Math.sqrt(s1 * s1 + se * se + sn * sn));
    out[1] = Math.atan(sn / s1);
  } else {
    out[0] = Math.atan(se / s1);
    out[1] = Math.asin(sn / Math.sqrt(s1 * s1 + se * se + sn * sn));
  }
  return out;
}

/** lon/lat -> fractional (row, col) in the grid, or null. */
export function lonlatToRC(g, lon, lat, out = [0, 0]) {
  const xy = lonlatToXY(g, lon, lat, out);
  if (!xy) return null;
  const col = (xy[0] - g.x0) / g.dx, row = (xy[1] - g.y0) / g.dy;
  out[0] = row; out[1] = col;
  return out;
}

/** Scan angles -> lon/lat (deg). With clampLimb, rays missing the earth return the limb point
 *  along the same direction (used for mesh vertices just off the disk); else null. */
export function xyToLonLat(g, x, y, out = [0, 0], clampLimb = false) {
  if (g.proj === 'laea') return g.rs ? laeaLonLat(g, x * g.rc + y * g.rs, y * g.rc - x * g.rs, out) : laeaLonLat(g, x, y, out);
  const k = (g.req * g.req) / (g.rpol * g.rpol);
  let d1, de, dn;
  const cx = Math.cos(x), cy = Math.cos(y), sx = Math.sin(x), sy = Math.sin(y);
  if (g.sweep === 'x') { d1 = cx * cy; de = sx; dn = cx * sy; }
  else { d1 = cx * cy; de = sx * cy; dn = sy; }
  // work in units of the equatorial radius for float stability
  const H = g.H / g.req;
  const a = d1 * d1 + de * de + k * dn * dn, b = -2 * H * d1, c = H * H - 1;
  let disc = b * b - 4 * a * c;
  if (disc < 0) { if (!clampLimb) return null; disc = 0; }
  const s = (-b - Math.sqrt(disc)) / (2 * a);
  const p1 = H - s * d1, pe = s * de, pn = s * dn;
  let lon = g.lon0 + Math.atan2(pe, p1) * R2D;
  const lat = Math.atan(k * pn / Math.sqrt(p1 * p1 + pe * pe)) * R2D;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  out[0] = lon; out[1] = lat;
  return out;
}

export function rcToLonLat(g, row, col, out = [0, 0], clampLimb = false) {
  return xyToLonLat(g, g.x0 + col * g.dx, g.y0 + row * g.dy, out, clampLimb);
}

/** Row/col window [r0, r1, c0, c1) of the grid covering a lon/lat box (sampled densely). */
export function windowForBBox(g, west, south, east, north, pad = 2) {
  if (east < west) east += 360;
  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  const o = [0, 0], N = 64;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    let lon = west + (east - west) * j / N; const lat = south + (north - south) * i / N;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    if (!lonlatToRC(g, lon, lat, o)) continue;
    if (o[0] < r0) r0 = o[0]; if (o[0] > r1) r1 = o[0];
    if (o[1] < c0) c0 = o[1]; if (o[1] > c1) c1 = o[1];
  }
  if (r0 === Infinity) return null;
  const w = [Math.max(0, Math.floor(r0) - pad), Math.min(g.ny, Math.ceil(r1) + pad + 1),
    Math.max(0, Math.floor(c0) - pad), Math.min(g.nx, Math.ceil(c1) + pad + 1)];
  return w[1] > w[0] && w[3] > w[2] ? w : null;
}

/** Outline ring [[lon, lat], ...] of a grid (null when the disk edge is inside it). */
export function outline(g, n = 40) {
  const pts = [], o = [0, 0];
  const edge = (r, c) => { if (!rcToLonLat(g, r, c, o)) return false; pts.push([o[0], o[1]]); return true; };
  for (let i = 0; i < n; i++) if (!edge(0, (g.nx - 1) * i / n)) return null;
  for (let i = 0; i < n; i++) if (!edge((g.ny - 1) * i / n, g.nx - 1)) return null;
  for (let i = 0; i < n; i++) if (!edge(g.ny - 1, (g.nx - 1) * (1 - i / n))) return null;
  for (let i = 0; i < n; i++) if (!edge((g.ny - 1) * (1 - i / n), 0)) return null;
  pts.push(pts[0]);
  return pts;
}

/** Approximate centre / extent of the valid part of a grid (for fitting the camera). */
export function gridCenter(g) {
  const o = [0, 0], pts = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    if (rcToLonLat(g, (g.ny - 1) * i / 8, (g.nx - 1) * j / 8, o)) pts.push([o[0], o[1]]);
  }
  if (!pts.length) return null;
  // unwrap longitudes around the sub-satellite point
  const lons = pts.map((p) => { let d = p[0] - g.lon0; d = ((d + 540) % 360) - 180; return g.lon0 + d; });
  const lats = pts.map((p) => p[1]);
  const w = Math.min(...lons), e = Math.max(...lons), s = Math.min(...lats), n = Math.max(...lats);
  return { lon: (((w + e) / 2 + 540) % 360) - 180, lat: (s + n) / 2, spanLon: e - w, spanLat: n - s };
}

// ------------------------------------------------------------------ sun
/** Sub-solar point (declination, longitude) in degrees (NOAA approximation). */
export function sunPosition(date) {
  const t = date instanceof Date ? date : new Date(date);
  const start = Date.UTC(t.getUTCFullYear(), 0, 1);
  const doy = Math.floor((t.getTime() - start) / 86400000) + 1;
  const hour = t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600;
  const gm = 2 * Math.PI / 365 * (doy - 1 + (hour - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(gm) - 0.032077 * Math.sin(gm) - 0.014615 * Math.cos(2 * gm) - 0.040849 * Math.sin(2 * gm));
  const decl = 0.006918 - 0.399912 * Math.cos(gm) + 0.070257 * Math.sin(gm) - 0.006758 * Math.cos(2 * gm)
    + 0.000907 * Math.sin(2 * gm) - 0.002697 * Math.cos(3 * gm) + 0.00148 * Math.sin(3 * gm);
  return { decl: decl * R2D, lon: -15 * (hour - 12 + eqt / 60) };
}

/** Unit vector toward the sun (x: lon 0, y: north pole, z: lon 90 W). */
export function sunVector(date) {
  const s = sunPosition(date);
  return lonlatToUnit(s.lon, s.decl);
}

/** Renderer earth frame: x toward (0E,0N), y toward the north pole, z toward (90W,0N) — right-handed with y up. */
export function lonlatToUnit(lon, lat, out = [0, 0, 0], r = 1) {
  const lo = lon * D2R, la = lat * D2R, cl = Math.cos(la);
  out[0] = r * cl * Math.cos(lo); out[1] = r * Math.sin(la); out[2] = -r * cl * Math.sin(lo);
  return out;
}

export function unitToLonLat(x, y, z, out = [0, 0]) {
  const r = Math.hypot(x, y, z);
  out[0] = Math.atan2(-z, x) * R2D; out[1] = Math.asin(Math.max(-1, Math.min(1, y / r))) * R2D;
  return out;
}

export { D2R, R2D };
