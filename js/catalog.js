/* Satellites, sectors, bands, products and colour tables (shared by the UI and the workers). */

export const GOES_BANDS = {
  1: ['Blue', 0.47, 'vis', 1], 2: ['Red', 0.64, 'vis', 0.5], 3: ['Veggie', 0.86, 'vis', 1], 4: ['Cirrus', 1.37, 'vis', 2],
  5: ['Snow/Ice', 1.61, 'vis', 1], 6: ['Cloud Particle Size', 2.24, 'vis', 2], 7: ['Shortwave Window', 3.9, 'ir', 2],
  8: ['Upper-Level Water Vapor', 6.19, 'ir', 2], 9: ['Mid-Level Water Vapor', 6.93, 'ir', 2],
  10: ['Lower-Level Water Vapor', 7.34, 'ir', 2], 11: ['Cloud-Top Phase', 8.44, 'ir', 2], 12: ['Ozone', 9.61, 'ir', 2],
  13: ['"Clean" Longwave IR', 10.33, 'ir', 2], 14: ['Longwave IR', 11.21, 'ir', 2], 15: ['"Dirty" Longwave IR', 12.29, 'ir', 2],
  16: ['CO₂ Longwave IR', 13.28, 'ir', 2],
};
export const AHI_BANDS = {
  1: ['Blue', 0.47, 'vis', 1], 2: ['Green', 0.51, 'vis', 1], 3: ['Red', 0.64, 'vis', 0.5], 4: ['Veggie', 0.86, 'vis', 1],
  5: ['Snow/Ice', 1.61, 'vis', 2], 6: ['Cloud Particle Size', 2.26, 'vis', 2], 7: ['Shortwave Window', 3.89, 'ir', 2],
  8: ['Upper-Level Water Vapor', 6.24, 'ir', 2], 9: ['Mid-Level Water Vapor', 6.94, 'ir', 2],
  10: ['Lower-Level Water Vapor', 7.35, 'ir', 2], 11: ['Cloud-Top Phase', 8.59, 'ir', 2], 12: ['Ozone', 9.64, 'ir', 2],
  13: ['"Clean" Longwave IR', 10.41, 'ir', 2], 14: ['Longwave IR', 11.24, 'ir', 2], 15: ['"Dirty" Longwave IR', 12.38, 'ir', 2],
  16: ['CO₂ Longwave IR', 13.28, 'ir', 2],
};
export const GOES_ROLE = { blue: 1, red: 2, veg: 3, cirrus: 4, snow: 5, cps: 6, swir: 7, wv_upper: 8, wv_mid: 9, wv_low: 10, ir86: 11, ozone: 12, ir103: 13, ir112: 14, ir123: 15, co2: 16 };
export const AHI_ROLE = { blue: 1, green: 2, red: 3, veg: 4, snow: 5, cps: 6, swir: 7, wv_upper: 8, wv_mid: 9, wv_low: 10, ir86: 11, ozone: 12, ir103: 13, ir112: 14, ir123: 15, co2: 16 };

const GOES_EAST_SECTORS = [['full', 'Full Disk'], ['conus', 'CONUS'], ['meso1', 'Meso 1'], ['meso2', 'Meso 2'], ['custom', 'Custom']];
const GOES_WEST_SECTORS = [['full', 'Full Disk'], ['pacus', 'PACUS'], ['meso1', 'Meso 1'], ['meso2', 'Meso 2'], ['custom', 'Custom']];
const AHI_SECTORS = [['full', 'Full Disk'], ['japan', 'Japan'], ['target', 'Target'], ['custom', 'Custom']];

export const SECTOR_NOTES = {
  full: 'Whole disk · every 10 min', conus: 'Continental US · every 5 min', pacus: 'Pacific US · every 5 min',
  meso1: 'Movable 1000 km box · every minute', meso2: 'Movable 1000 km box · every minute',
  japan: 'Japan area · every 2.5 min', target: 'Movable target · every 2.5 min', custom: 'Draw a box · only the rows inside are downloaded',
};

export const SATS = {
  goes19: { name: 'GOES-19', sub: 'GOES-East · 75.2°W', kind: 'goes', bucket: 'noaa-goes19', tag: 'G19', lon: -75.2, local: 'conus', sectors: GOES_EAST_SECTORS, start: '2024-10-10' },
  goes18: { name: 'GOES-18', sub: 'GOES-West · 137.0°W', kind: 'goes', bucket: 'noaa-goes18', tag: 'G18', lon: -137.0, local: 'pacus', sectors: GOES_WEST_SECTORS, start: '2022-05-11' },
  himawari9: { name: 'Himawari-9', sub: 'Japan · 140.7°E', kind: 'ahi', bucket: 'noaa-himawari9', tag: 'H09', lon: 140.7, sectors: AHI_SECTORS, start: '2022-10-28' },
  goes16: { name: 'GOES-16', sub: 'GOES-East · 2017–2025', kind: 'goes', bucket: 'noaa-goes16', tag: 'G16', lon: -75.2, local: 'conus', sectors: GOES_EAST_SECTORS, retired: true, start: '2017-02-28', end: '2025-04-07' },
  goes17: { name: 'GOES-17', sub: 'GOES-West · 2018–2023', kind: 'goes', bucket: 'noaa-goes17', tag: 'G17', lon: -137.2, local: 'pacus', sectors: GOES_WEST_SECTORS, retired: true, start: '2018-08-28', end: '2023-01-10' },
  himawari8: { name: 'Himawari-8', sub: 'Japan · 2015–2022', kind: 'ahi', bucket: 'noaa-himawari8', tag: 'H08', lon: 140.7, sectors: AHI_SECTORS, retired: true, start: '2015-07-07', end: '2022-12-13' },
};

export const bandsOf = (sat) => (SATS[sat].kind === 'goes' ? GOES_BANDS : AHI_BANDS);
export const rolesOf = (sat) => (SATS[sat].kind === 'goes' ? GOES_ROLE : AHI_ROLE);
export const bandRes = (sat, b) => bandsOf(sat)[b][3];

// RGB composites: roles ('?' = optional) ; the reference role drives 3D heights and probing
export const RGBS = {
  geocolor: { name: 'GeoColor', roles: ['blue', 'red', 'veg', 'ir103', 'swir', 'green?'], ref: 'ir103', desc: 'True colour by day, IR clouds and fog over city lights at night' },
  sandwich: { name: 'Sandwich', roles: ['red', 'ir103'], ref: 'ir103', desc: 'Visible texture with colour-enhanced cold IR cloud tops' },
  truecolor: { name: 'True Color', roles: ['blue', 'red', 'veg', 'green?'], ref: 'red', desc: 'Rayleigh-corrected true colour (daytime)' },
  natural: { name: 'Day Land Cloud', roles: ['snow', 'veg', 'red'], ref: 'red', desc: 'Natural colour: 1.6 / 0.86 / 0.64 µm' },
  airmass: { name: 'Air Mass', roles: ['wv_upper', 'wv_low', 'ozone', 'ir103'], ref: 'ir103', desc: 'Jet streams, dry intrusions, PV anomalies' },
  dcp: { name: 'Day Cloud Phase', roles: ['ir103', 'red', 'snow'], ref: 'ir103', desc: 'Ice vs water clouds, glaciation' },
  daycon: { name: 'Day Convection', roles: ['wv_upper', 'wv_low', 'swir', 'ir103', 'snow', 'red'], ref: 'ir103', desc: 'Strong updrafts and small ice' },
  nightmicro: { name: 'Night Microphysics', roles: ['ir123', 'ir103', 'swir'], ref: 'ir103', desc: 'Fog and low stratus at night' },
  dust: { name: 'Dust', roles: ['ir123', 'ir103', 'ir86'], ref: 'ir103', desc: 'Dust plumes (magenta)' },
  ash: { name: 'Ash', roles: ['ir123', 'ir103', 'ir86'], ref: 'ir103', desc: 'Volcanic ash and SO₂' },
  fire: { name: 'Fire Temperature', roles: ['swir', 'cps', 'snow'], ref: 'swir', desc: 'Active fire hot spots' },
  simplewv: { name: 'Simple Water Vapor', roles: ['ir103', 'wv_upper', 'wv_low'], ref: 'ir103', desc: 'Moisture at three levels' },
};

// value ranges of 16-bit storage codes (code 65535 = no data)
export const Q16 = { refl: [-0.25, 2.0], bt: [150, 420] };
export const NAN_CODE = 65535;
export const kindForBand = (b) => (b <= 6 ? 'refl' : 'bt');

export const IR_CMAPS = ['ir_color', 'ir_gray', 'ir_rainbow', 'ir_bd', 'wv', 'turbo'];
export const VIS_CMAPS = ['vis', 'gray'];
export const FIXED_RANGE = { ir_color: [163, 330], ir_rainbow: [163, 330], ir_bd: [163, 330], wv: [180, 290] };
export const BAND_RANGE = { 1: [0, 1.1], 2: [0, 1.1], 3: [0, 1.1], 4: [0, 0.5], 5: [0, 0.8], 6: [0, 0.6], 7: [200, 330],
  8: [195, 260], 9: [200, 270], 10: [205, 280], 11: [180, 320], 12: [180, 310], 13: [180, 320], 14: [180, 320], 15: [180, 320], 16: [190, 290] };

export function bandDefaultCmap(b) {
  if (b <= 3) return 'vis';
  if (b <= 6) return 'gray';
  if (b === 7) return 'ir_gray';
  if (b >= 8 && b <= 10) return 'wv';
  if (b === 13) return 'ir_color';
  return 'ir_gray';
}

/** AHI band numbers differ from ABI (AHI 3 = red, 2 = green); map an ABI-style band to the
 *  default colour table via its role so both instruments look alike. */
export function cmapFor(sat, b) {
  if (SATS[sat].kind === 'ahi') return b <= 4 ? 'vis' : b <= 6 ? 'gray' : bandDefaultCmap(b);
  return bandDefaultCmap(b);
}

export function rangeFor(sat, b, cmap) {
  if (FIXED_RANGE[cmap]) return FIXED_RANGE[cmap];
  if (SATS[sat].kind === 'ahi' && b <= 4) return [0, 1.1];
  return BAND_RANGE[b];
}

/** Products of a satellite: RGB composites then single bands. */
export function products(sat) {
  const roles = rolesOf(sat), bands = bandsOf(sat), pre = SATS[sat].kind === 'goes' ? 'C' : 'B';
  const out = [];
  for (const [id, r] of Object.entries(RGBS)) {
    if (r.roles.every((x) => x.endsWith('?') || x in roles)) out.push({ id, name: r.name, group: 'RGB', desc: r.desc, kind: 'rgb' });
  }
  for (const [b, [name, wl, kind, res]] of Object.entries(bands)) {
    const n = +b;
    out.push({ id: `b${String(n).padStart(2, '0')}`, band: n, name: `${pre}${String(n).padStart(2, '0')} · ${wl} µm`, label: name,
      group: kind === 'vis' ? 'Visible' : 'Infrared', desc: `native ${res} km`, kind,
      cmaps: kind === 'vis' ? VIS_CMAPS : IR_CMAPS, cmap: cmapFor(sat, n) });
  }
  return out;
}

/** Bands a product needs: {role: band}. */
export function bandsFor(sat, product) {
  const roles = rolesOf(sat);
  if (RGBS[product]) {
    const m = {};
    for (let r of RGBS[product].roles) {
      const opt = r.endsWith('?'); r = r.replace('?', '');
      if (r in roles) m[r] = roles[r];
      else if (!opt) throw new Error(`${product} needs ${r}`);
    }
    return m;
  }
  const b = parseInt(product.slice(1), 10);
  return { band: b };
}

// ------------------------------------------------------------------ colour tables
export const CMAPS = {
  vis: { label: 'Grayscale (sqrt)' }, gray: { label: 'Grayscale (linear)' }, ir_gray: { label: 'IR grayscale' },
  ir_color: { label: 'Clean IR (colour)' }, ir_rainbow: { label: 'IR rainbow' }, ir_bd: { label: 'Dvorak BD' },
  wv: { label: 'Water vapour' }, turbo: { label: 'Turbo' },
};

function grayStops(lo, hi, invert = false, gamma = 1, n = 32) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = lo + (hi - lo) * i / (n - 1);
    let f = ((v - lo) / (hi - lo)) ** gamma;
    if (invert) f = 1 - f;
    const g = Math.round(255 * f);
    out.push([v, [g, g, g]]);
  }
  return out;
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const H = (arr) => arr.map(([v, c]) => [v, hex(c)]);

const STOPS = {
  vis: (lo, hi) => grayStops(lo, hi, false, 0.5, 64),
  gray: (lo, hi) => grayStops(lo, hi),
  ir_gray: (lo, hi) => grayStops(lo, hi, true),
  ir_color: () => H([[163, '#ffffff'], [180, '#f0f0f0'], [186, '#e2d4ff'], [191, '#b48cff'], [196, '#7b2cbf'], [201, '#3c096c'],
    [206, '#6a040f'], [211, '#b0151d'], [216, '#ef3b1f'], [221, '#ff7b00'], [226, '#ffb703'], [230, '#ffe94d'], [234, '#7dd87a'],
    [238, '#2a9d8f'], [241, '#2b6cb0'], [243, '#5a8fd6'], [243.0001, '#d6d6d6'], [253, '#bdbdbd'], [273, '#8a8a8a'],
    [293, '#4a4a4a'], [313, '#181818'], [330, '#000000']]),
  ir_rainbow: () => H([[180, '#ffffff'], [190, '#000000'], [198, '#ff00ff'], [205, '#8b008b'], [212, '#ff0000'], [219, '#ff8c00'],
    [226, '#ffff00'], [233, '#00ff00'], [240, '#008b00'], [247, '#00bfff'], [254, '#00008b'], [254.001, '#b4b4b4'], [330, '#000000']]),
  ir_bd: () => H([[170, '#ffffff'], [192, '#ffffff'], [192.01, '#000000'], [198, '#000000'], [198.01, '#5a5a5a'], [204, '#5a5a5a'],
    [204.01, '#a0a0a0'], [210, '#a0a0a0'], [210.01, '#000000'], [220, '#000000'], [220.01, '#c8c8c8'], [232, '#c8c8c8'],
    [232.01, '#808080'], [242, '#808080'], [242.01, '#6e6e6e'], [282, '#141414'], [303, '#000000'], [330, '#000000']]),
  wv: () => H([[180, '#ffffff'], [200, '#e8f4ff'], [212, '#9fd4ff'], [222, '#3a8ee6'], [230, '#1f4fb4'], [237, '#3b4f75'],
    [242, '#5c6b80'], [248, '#2a2a2a'], [256, '#8a4b08'], [266, '#e08a1c'], [278, '#ffd27a'], [290, '#fff4d6']]),
  turbo: (lo, hi) => {
    const c = ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b', '#d1e834', '#f3c63a',
      '#fe9b2d', '#f36315', '#d93806', '#b11901', '#7a0402'];
    return c.map((h, i) => [lo + (hi - lo) * i / (c.length - 1), hex(h)]);
  },
};

export const LUT_N = 1024;
/** 1024-entry RGBA colour table over [vmin, vmax] (piecewise-linear between stops). */
export function buildLut(name, vmin, vmax) {
  const stops = STOPS[name](vmin, vmax);
  const out = new Uint8Array(LUT_N * 4);
  let k = 0;
  for (let i = 0; i < LUT_N; i++) {
    const v = vmin + (vmax - vmin) * i / (LUT_N - 1);
    while (k < stops.length - 2 && stops[k + 1][0] < v) k++;
    const [v0, c0] = stops[k], [v1, c1] = stops[Math.min(k + 1, stops.length - 1)];
    const t = v <= v0 ? 0 : v >= v1 ? 1 : (v - v0) / (v1 - v0);
    for (let ch = 0; ch < 3; ch++) out[i * 4 + ch] = Math.round(c0[ch] + (c1[ch] - c0[ch]) * t);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function lutCss(name, vmin, vmax, n = 24) {
  const l = buildLut(name, vmin, vmax), stops = [];
  for (let i = 0; i < n; i++) {
    const j = Math.round(i * (LUT_N - 1) / (n - 1)) * 4;
    stops.push(`rgb(${l[j]},${l[j + 1]},${l[j + 2]}) ${(i * 100 / (n - 1)).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(',')})`;
}
