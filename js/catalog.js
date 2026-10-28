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
// GK2A AMI: same band order as AHI except 5 = 1.38 µm cirrus and 6 = 1.61 µm (no 2.2 µm channel)
export const AMI_BANDS = {
  1: ['Blue', 0.47, 'vis', 1], 2: ['Green', 0.51, 'vis', 1], 3: ['Red', 0.64, 'vis', 0.5], 4: ['Veggie', 0.86, 'vis', 1],
  5: ['Cirrus', 1.38, 'vis', 2], 6: ['Snow/Ice', 1.61, 'vis', 2], 7: ['Shortwave Window', 3.83, 'ir', 2],
  8: ['Upper-Level Water Vapor', 6.21, 'ir', 2], 9: ['Mid-Level Water Vapor', 6.94, 'ir', 2],
  10: ['Lower-Level Water Vapor', 7.33, 'ir', 2], 11: ['Cloud-Top Phase', 8.59, 'ir', 2], 12: ['Ozone', 9.62, 'ir', 2],
  13: ['"Clean" Longwave IR', 10.35, 'ir', 2], 14: ['Longwave IR', 11.23, 'ir', 2], 15: ['"Dirty" Longwave IR', 12.36, 'ir', 2],
  16: ['CO₂ Longwave IR', 13.29, 'ir', 2],
};
export const AMI_CHANNELS = ['', 'VI004', 'VI005', 'VI006', 'VI008', 'NR013', 'NR016', 'SW038', 'WV063', 'WV069', 'WV073',
  'IR087', 'IR096', 'IR105', 'IR112', 'IR123', 'IR133'];
export const GOES_ROLE = { blue: 1, red: 2, veg: 3, cirrus: 4, snow: 5, cps: 6, swir: 7, wv_upper: 8, wv_mid: 9, wv_low: 10, ir86: 11, ozone: 12, ir103: 13, ir112: 14, ir123: 15, co2: 16 };
export const AHI_ROLE = { blue: 1, green: 2, red: 3, veg: 4, snow: 5, cps: 6, swir: 7, wv_upper: 8, wv_mid: 9, wv_low: 10, ir86: 11, ozone: 12, ir103: 13, ir112: 14, ir123: 15, co2: 16 };
export const AMI_ROLE = { blue: 1, green: 2, red: 3, veg: 4, cirrus: 5, snow: 6, swir: 7, wv_upper: 8, wv_mid: 9, wv_low: 10, ir86: 11, ozone: 12, ir103: 13, ir112: 14, ir123: 15, co2: 16 };

const GOES_EAST_SECTORS = [['full', 'Full Disk'], ['conus', 'CONUS'], ['meso1', 'Meso 1'], ['meso2', 'Meso 2'], ['custom', 'Custom']];
const GOES_WEST_SECTORS = [['full', 'Full Disk'], ['pacus', 'PACUS'], ['meso1', 'Meso 1'], ['meso2', 'Meso 2'], ['custom', 'Custom']];
const AHI_SECTORS = [['full', 'Full Disk'], ['japan', 'Japan'], ['target', 'Target'], ['custom', 'Custom']];
const AMI_SECTORS = [['full', 'Full Disk'], ['la', 'Local Area'], ['custom', 'Custom']];

// polar orbiters: a "sector" is the length of the time slice each frame shows
const POLAR_SECTORS = [['slice2', '2 min'], ['slice5', '5 min'], ['slice10', '10 min'], ['slice20', '20 min']];
export const SLICE_MIN = { slice2: 2, slice5: 5, slice10: 10, slice20: 20 };
const SLICE_NOTE = 'Each frame is the strip the satellite scanned in that time';

export const SECTOR_NOTES = {
  full: 'Whole disk · every 10 min', conus: 'Continental US · every 5 min', pacus: 'Pacific US · every 5 min',
  meso1: 'Movable 1000 km box · every minute', meso2: 'Movable 1000 km box · every minute',
  japan: 'Japan area · every 2.5 min', target: 'Movable target · every 2.5 min', la: 'Korea / East Asia 1000 km box · every 2 min', custom: 'Draw a box · only the rows inside are downloaded',
  slice2: SLICE_NOTE, slice5: SLICE_NOTE, slice10: SLICE_NOTE, slice20: SLICE_NOTE,
};

export const SATS = {
  goes19: { name: 'GOES-19', sub: 'GOES-East · 75.2°W', kind: 'goes', bucket: 'noaa-goes19', tag: 'G19', lon: -75.2, local: 'conus', sectors: GOES_EAST_SECTORS, start: '2024-10-10' },
  goes18: { name: 'GOES-18', sub: 'GOES-West · 137.0°W', kind: 'goes', bucket: 'noaa-goes18', tag: 'G18', lon: -137.0, local: 'pacus', sectors: GOES_WEST_SECTORS, start: '2022-05-11' },
  himawari9: { name: 'Himawari-9', sub: 'Japan · 140.7°E', kind: 'ahi', bucket: 'noaa-himawari9', tag: 'H09', lon: 140.7, sectors: AHI_SECTORS, start: '2022-10-28' },
  gk2a: { name: 'GK2A', sub: 'Korea · 128.2°E', kind: 'ami', bucket: 'noaa-gk2a-pds', tag: 'GK2A', lon: 128.2, sectors: AMI_SECTORS, start: '2023-02-16' },
  noaa20: { name: 'NOAA-20', sub: 'Polar · VIIRS + ATMS', kind: 'polar', bucket: 'noaa-nesdis-n20-pds', tag: 'j01', mirs: 'n20', lon: 0, sectors: POLAR_SECTORS, start: '2021-02-01' },
  noaa21: { name: 'NOAA-21', sub: 'Polar · VIIRS + ATMS', kind: 'polar', bucket: 'noaa-nesdis-n21-pds', tag: 'j02', mirs: 'n21', lon: 0, sectors: POLAR_SECTORS, start: '2023-02-10' },
  snpp: { name: 'Suomi NPP', sub: 'Polar · VIIRS + ATMS', kind: 'polar', bucket: 'noaa-nesdis-snpp-pds', tag: 'npp', mirs: 'npp', lon: 0, sectors: POLAR_SECTORS, start: '2022-08-01' },
  goes16: { name: 'GOES-16', sub: 'GOES-East · 2017–2025', kind: 'goes', bucket: 'noaa-goes16', tag: 'G16', lon: -75.2, local: 'conus', sectors: GOES_EAST_SECTORS, retired: true, successor: 'goes19', start: '2017-02-28', end: '2025-04-07' },
  goes17: { name: 'GOES-17', sub: 'GOES-West · 2018–2023', kind: 'goes', bucket: 'noaa-goes17', tag: 'G17', lon: -137.2, local: 'pacus', sectors: GOES_WEST_SECTORS, retired: true, successor: 'goes18', start: '2018-08-28', end: '2023-01-10' },
  himawari8: { name: 'Himawari-8', sub: 'Japan · 2015–2022', kind: 'ahi', bucket: 'noaa-himawari8', tag: 'H08', lon: 140.7, sectors: AHI_SECTORS, retired: true, successor: 'himawari9', start: '2015-07-07', end: '2022-12-13' },
};

export const bandsOf = (sat) => ({ goes: GOES_BANDS, ahi: AHI_BANDS, ami: AMI_BANDS, polar: {} })[SATS[sat].kind];
export const rolesOf = (sat) => ({ goes: GOES_ROLE, ahi: AHI_ROLE, ami: AMI_ROLE, polar: {} })[SATS[sat].kind];
export const defaultSector = (sat) => (SATS[sat].kind === 'goes' ? SATS[sat].local : SATS[sat].kind === 'polar' ? 'slice5' : 'full');
export const defaultProduct = (sat) => (SATS[sat].kind === 'polar' ? 'i5' : 'geocolor');
/** Short band name as the instrument calls it: C13 (ABI), B13 (AHI), IR105 (AMI), I5 / Ch 16 (polar). */
export const bandLabel = (sat, b) => {
  const k = SATS[sat].kind;
  if (L2[b]) return L2[b].short || L2[b].name;
  if (k === 'polar') return VIIRS[b]?.[0] || (ATMS_PRODUCTS[b] ? ATMS_PRODUCTS[b].short : String(b));
  return k === 'ami' ? AMI_CHANNELS[b] : `${k === 'goes' ? 'C' : 'B'}${String(b).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ polar orbiters (VIIRS + ATMS)
// VIIRS: id -> [label, µm, 'vis' | 'ir' | 'dnb', folder, file token, dataset group, geolocation, native km]
export const VIIRS = {};
[[0.64, 'vis'], [0.865, 'vis'], [1.61, 'vis'], [3.74, 'ir'], [11.45, 'ir']].forEach(([wl, k], i) => {
  VIIRS[`i${i + 1}`] = [`I${i + 1}`, wl, k, `VIIRS-I${i + 1}-SDR`, `SVI0${i + 1}`, `VIIRS-I${i + 1}-SDR_All`, 'I', 0.375];
});
[[0.412, 'vis'], [0.445, 'vis'], [0.488, 'vis'], [0.555, 'vis'], [0.672, 'vis'], [0.746, 'vis'], [0.865, 'vis'], [1.24, 'vis'],
  [1.378, 'vis'], [1.61, 'vis'], [2.25, 'vis'], [3.7, 'ir'], [4.05, 'ir'], [8.55, 'ir'], [10.763, 'ir'], [12.013, 'ir']].forEach(([wl, k], i) => {
  VIIRS[`m${i + 1}`] = [`M${i + 1}`, wl, k, `VIIRS-M${i + 1}-SDR`, `SVM${String(i + 1).padStart(2, '0')}`, `VIIRS-M${i + 1}-SDR_All`, 'M', 0.75];
});
VIIRS.dnb = ['DNB', 0.7, 'dnb', 'VIIRS-DNB-SDR', 'SVDNB', 'VIIRS-DNB-SDR_All', 'D', 0.75];
// geolocation: [folder, file token, dataset group]; I bands use the 750 m GMTCO when it exists
// (NODD keeps it ~3 months), else their own 375 m GITCO
export const VIIRS_GEO = { M: ['VIIRS-MOD-GEO-TC', 'GMTCO', 'VIIRS-MOD-GEO-TC_All'], I: ['VIIRS-IMG-GEO-TC', 'GITCO', 'VIIRS-IMG-GEO-TC_All'],
  D: ['VIIRS-DNB-GEO', 'GDNBO', 'VIIRS-DNB-GEO_All'] };
const VIIRS_DESC = { i1: 'Visible red', i2: 'Near-IR vegetation', i3: 'Snow/ice', i4: 'Shortwave IR (fire, fog)', i5: 'Longwave IR window',
  m1: 'Violet (aerosol)', m2: 'Deep blue', m3: 'Blue', m4: 'Green', m5: 'Red', m6: 'Atmospheric correction', m7: 'Near-IR vegetation',
  m8: 'Cloud particle size', m9: 'Cirrus', m10: 'Snow/ice', m11: 'Cloud particle size', m12: 'Shortwave IR window', m13: 'Fire / shortwave IR',
  m14: 'Cloud-top phase', m15: 'Longwave IR window', m16: '"Dirty" longwave IR', dnb: 'Day/Night Band (moonlight, city lights)' };
export const VIIRS_RGBS = {
  v_truecolor: { name: 'True Color', bands: ['m5', 'm4', 'm3'], desc: 'M5 / M4 / M3 reflectance, 750 m' },
  v_natural: { name: 'Natural Color', bands: ['i3', 'i2', 'i1'], desc: 'I3 / I2 / I1 reflectance, 375 m' },
};
const VIIRS_RANGE = { i3: [0, 0.8], m9: [0, 0.4], m10: [0, 0.8], m11: [0, 0.6], i4: [200, 340], m12: [200, 340], m13: [200, 340], m14: [180, 320] };
// ATMS channels (MiRS IMG files): [frequency, polarisation, default range K, colour table, what it shows]
export const ATMS_CH = [
  ['23.8 GHz', 'QV', [150, 290], 'turbo', 'Water vapour / surface'], ['31.4 GHz', 'QV', [140, 290], 'turbo', 'Window: cloud liquid water, surface'],
  ['50.3 GHz', 'QH', [180, 280], 'turbo', 'Surface / lower troposphere'], ['51.76 GHz', 'QH', [205, 275], 'turbo', 'Lower troposphere temperature'],
  ['52.8 GHz', 'QH', [215, 265], 'turbo', 'Lower troposphere temperature (~1 km)'], ['53.596±0.115 GHz', 'QH', [215, 255], 'turbo', 'Temperature ~4 km'],
  ['54.4 GHz', 'QH', [205, 245], 'turbo', 'Temperature ~7 km'], ['54.94 GHz', 'QH', [200, 235], 'turbo', 'Temperature ~10 km'],
  ['55.5 GHz', 'QH', [195, 230], 'turbo', 'Temperature ~13 km (tropopause)'], ['57.29 GHz (fo)', 'QH', [195, 235], 'turbo', 'Temperature ~17 km'],
  ['fo±0.217 GHz', 'QH', [195, 235], 'turbo', 'Temperature ~20 km'], ['fo±0.322±0.048 GHz', 'QH', [200, 240], 'turbo', 'Temperature ~25 km'],
  ['fo±0.322±0.022 GHz', 'QH', [205, 250], 'turbo', 'Temperature ~30 km'], ['fo±0.322±0.010 GHz', 'QH', [210, 260], 'turbo', 'Temperature ~35 km'],
  ['fo±0.322±0.0045 GHz', 'QH', [215, 270], 'turbo', 'Temperature ~40 km'], ['88.2 GHz', 'QV', [150, 295], 'mw_scatter', 'Window: ice scattering in convection'],
  ['165.5 GHz', 'QH', [130, 290], 'mw_scatter', 'Window: ice scattering, moisture'], ['183.31±7.0 GHz', 'QH', [150, 285], 'mw_scatter', 'Water vapour, lower troposphere'],
  ['183.31±4.5 GHz', 'QH', [160, 280], 'mw_scatter', 'Water vapour ~3 km'], ['183.31±3.0 GHz', 'QH', [170, 275], 'mw_scatter', 'Water vapour ~5 km'],
  ['183.31±1.8 GHz', 'QH', [180, 270], 'mw_scatter', 'Water vapour ~6 km'], ['183.31±1.0 GHz', 'QH', [190, 265], 'mw_scatter', 'Water vapour ~8 km (upper)'],
];
export const ATMS_PRODUCTS = { rr: { short: 'Rain', q: 'logrr' }, tpw: { short: 'TPW', q: 'tpw' } };
ATMS_CH.forEach((c, i) => { ATMS_PRODUCTS[`ch${String(i + 1).padStart(2, '0')}`] = { short: `Ch ${i + 1}`, q: 'mwbt', ch: i }; });

/** What a polar product reads: {family: 'viirs' | 'atms', bands, q (storage kind), km (native)}. */
export function polarSource(product) {
  if (VIIRS_RGBS[product]) return { family: 'viirs', bands: VIIRS_RGBS[product].bands, q: 'refl', km: VIIRS[VIIRS_RGBS[product].bands[0]][7], rgb: true };
  if (VIIRS[product]) { const v = VIIRS[product]; return { family: 'viirs', bands: [product], q: v[2] === 'ir' ? 'bt' : v[2] === 'dnb' ? 'lograd' : 'refl', km: v[7] }; }
  if (ATMS_PRODUCTS[product]) return { family: 'atms', bands: [product], q: ATMS_PRODUCTS[product].q, km: 4, ch: ATMS_PRODUCTS[product].ch };
  throw new Error(`unknown product ${product}`);
}

function polarProducts() {
  const out = [];
  for (const [id, r] of Object.entries(VIIRS_RGBS)) out.push({ id, name: r.name, group: 'RGB', desc: r.desc, kind: 'rgb' });
  const km = (v) => (v[7] < 0.5 ? '375 m' : '750 m');
  const vis = [], ir = [];
  for (const [id, v] of Object.entries(VIIRS)) {
    const p = { id, band: id, name: v[2] === 'dnb' ? 'DNB · Day/Night Band' : `${v[0]} · ${v[1]} µm`, label: VIIRS_DESC[id], desc: km(v), kind: v[2] === 'ir' ? 'ir' : 'vis' };
    if (v[2] === 'ir') ir.push({ ...p, group: 'Infrared', cmaps: IR_CMAPS, cmap: ['i5', 'm15', 'm16'].includes(id) ? 'ir_color' : 'ir_gray' });
    else vis.push({ ...p, group: 'Visible', cmaps: VIS_CMAPS, cmap: ['m9', 'm10', 'm11', 'i3', 'dnb'].includes(id) ? 'gray' : 'vis' });
  }
  const mw = [
    { id: 'rr', band: 'rr', name: 'Rain rate', label: 'MiRS (ATMS)', desc: 'mm/h, 16–50 km footprints', kind: 'rr', group: 'Microwave', cmaps: ['precip'], cmap: 'precip' },
    { id: 'tpw', band: 'tpw', name: 'Precipitable water', label: 'MiRS (ATMS)', desc: 'total column, mm', kind: 'tpw', group: 'Microwave', cmaps: ['tpw', 'turbo'], cmap: 'tpw' },
  ];
  ATMS_CH.forEach(([f, pol, , cm, d], i) => {
    const id = `ch${String(i + 1).padStart(2, '0')}`;
    mw.push({ id, band: id, name: `Ch ${i + 1} · ${f}`, label: `${pol} · ATMS`, desc: d, kind: 'mw', group: 'Microwave', cmaps: ['turbo', 'mw_scatter', 'ir_gray', 'gray'], cmap: cm });
  });
  return out.concat(vis, ir, mw);
}
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

// value ranges of 16-bit storage codes (code 65535 = no data). Polar products add microwave
// brightness temperatures, log10 rain rate (mm/h), precipitable water (mm) and log10 DNB radiance.
export const Q16 = { refl: [-0.25, 2.0], bt: [150, 420], mwbt: [60, 340], logrr: [-2, 2.5], tpw: [0, 100], lograd: [-13, 1] };
export const NAN_CODE = 65535;
export const kindForBand = (b) => (b <= 6 ? 'refl' : 'bt');

// ------------------------------------------------------------------ GOES ABI Level-2 products (GOES only)
// id -> f: product folder ABI-L2-<f><F|C|M> · v: variable · km: its grid · sec: sectors it is made for
// (F full disk, C CONUS / PACUS, M mesoscale) · q: storage code range (its own kind unless `kind`)
// · val: decoded value (scale / offset applied, fill already NaN) -> shown value (NaN = no data)
// · range, cmap, cmaps · unit, mul (display = value * mul), dp (decimals) · classes: [value, label, colour]
// for categories (codes are the class values; values under the first class show `below`) · cad: minutes
// between files where not the sector's own cadence.
const pct = (v) => (v > 100 ? NaN : v); // cloud-layer / snow percentages: 101+ are flags (no retrieval)
const FIRE_CLASS = { 10: 1, 30: 1, 11: 2, 31: 2, 12: 3, 32: 3, 13: 4, 33: 4, 14: 5, 34: 5, 15: 6, 35: 6, 100: 0, 120: 0, 121: 0, 123: 0, 124: 0, 125: 0, 126: 0, 127: 0 };
const PCT = { q: [0, 100], range: [0, 100], unit: '%', dp: 0 };
const FRAC = { q: [0, 1.05], range: [0, 1], unit: '%', mul: 100, dp: 0 };
const DSI = { f: 'DSI', km: 10, sec: 'FCM' };
const CCL = { f: 'CCL', km: 10, sec: 'FCM', group: 'Clouds' };
const CF_LAYERS = ['surface – 5,000 ft', '5,000 – 10,000 ft', '10,000 – 18,000 ft', '18,000 – 24,000 ft', 'above 24,000 ft'];
export const L2 = {
  csm: { name: 'Clear Sky Mask', group: 'Clouds', f: 'ACM', v: 'BCM', km: 2, sec: 'FCM', q: [0, 65534],
    classes: [[0, 'Clear', '#1d3557'], [1, 'Cloudy', '#f1f3f5']], desc: 'Binary cloud mask, 2 km' },
  ...Object.fromEntries(CF_LAYERS.map((lay, i) => [`cf${i + 1}`, { ...CCL, ...PCT, name: `Cloud Fraction — Layer ${i + 1}`, short: `CF${i + 1}`,
    v: `CF${i + 1}`, val: pct, cmap: 'cloudfrac', cmaps: ['cloudfrac', 'turbo', 'gray'], desc: `Cloud cover ${lay}, 10 km` }])),
  clf: { ...CCL, name: 'Cloud Layer Flag', short: 'Layers', v: 'CL', q: [0, 65534], val: (v) => (v > 31 ? NaN : v),
    // bit i = a cloud in layer i + 1; coloured by the highest layer present
    classes: Array.from({ length: 32 }, (_, v) => [v, v ? layerNames(v) : 'Clear',
      ['#14213d', '#4ea8de', '#52b788', '#ffd166', '#f77f00', '#e63946'][v ? 32 - Math.clz32(v) : 0]]),
    legend: [[0, 'Clear', '#14213d'], [1, '< 5 kft', '#4ea8de'], [2, '5–10 kft', '#52b788'], [4, '10–18 kft', '#ffd166'], [8, '18–24 kft', '#f77f00'], [16, '> 24 kft', '#e63946']],
    desc: 'Layers holding cloud (highest shown), 10 km' },
  cprob: { ...FRAC, name: 'Cloud Probability', group: 'Clouds', f: 'ACM', v: 'Cloud_Probabilities', km: 2, sec: 'FCM',
    cmap: 'cloudfrac', cmaps: ['cloudfrac', 'turbo', 'gray'], desc: 'Probability of cloud, 2 km' },
  cth: { name: 'Cloud Top Height', group: 'Clouds', f: 'ACHA', v: 'HT', km: 10, sec: 'FCM', q: [0, 20500], range: [0, 18000], unit: 'km', mul: 1e-3, dp: 1,
    cmap: 'cth', cmaps: ['cth', 'turbo', 'gray'], desc: 'Height of the highest cloud top, 10 km' },
  ctph: { name: 'Cloud Top Phase', group: 'Clouds', f: 'ACTP', v: 'Phase', km: 2, sec: 'FCM', q: [0, 65534],
    classes: [[0, 'Clear', '#1d3557'], [1, 'Liquid', '#48cae4'], [2, 'Supercooled', '#2a9d8f'], [3, 'Mixed', '#e9c46a'],
      [4, 'Ice', '#f1f3f5'], [5, 'Unknown', '#6c757d']], desc: 'Liquid, supercooled, mixed or ice tops, 2 km' },
  ctp: { name: 'Cloud Top Pressure', group: 'Clouds', f: 'CTP', v: 'PRES', km: 10, sec: 'FC', q: [0, 1100], range: [100, 1000], unit: 'hPa', dp: 0,
    cmap: 'ctp', cmaps: ['ctp', 'turbo', 'gray'], desc: 'Pressure at the cloud top, 10 km' },
  tcf: { ...CCL, ...FRAC, name: 'Total Cloud Fraction', short: 'TCF', v: 'TCF', cmap: 'cloudfrac', cmaps: ['cloudfrac', 'turbo', 'gray'], desc: 'Cloud cover of the whole column, 10 km' },
  aod: { name: 'Aerosol Optical Depth', group: 'Atmosphere', f: 'AOD', v: 'AOD', km: 2, sec: 'FC', q: [-0.05, 5], range: [0, 1], dp: 2,
    cmap: 'aod', cmaps: ['aod', 'turbo'], desc: '550 nm, daytime and cloud-free, 2 km' },
  dust: { name: 'Dust Detection', group: 'Atmosphere', f: 'ADP', v: 'Dust', km: 2, sec: 'FCM', q: [0, 65534], cad: { conus: 10, pacus: 10 },
    classes: [[0, 'None', null], [1, 'Dust', '#d4a373']], desc: 'Dust flagged pixels, 2 km' },
  rrqpe: { name: 'Rainfall Rate', group: 'Atmosphere', f: 'RRQPE', v: 'RRQPE', km: 2, sec: 'F', kind: 'logrr', unit: 'mm/h',
    val: (v) => (v > 0 ? Math.log10(Math.max(v, 0.01)) : -2), range: [Math.log10(0.1), Math.log10(60)], cmap: 'precip', cmaps: ['precip'],
    desc: 'Rain rate from IR calibrated by microwave, 2 km' },
  smoke: { name: 'Smoke Detection', group: 'Atmosphere', f: 'ADP', v: 'Smoke', km: 2, sec: 'FCM', q: [0, 65534], cad: { conus: 10, pacus: 10 },
    classes: [[0, 'None', null], [1, 'Smoke', '#adb5bd']], desc: 'Smoke flagged pixels (daytime), 2 km' },
  tpw: { name: 'Total Precipitable Water', short: 'TPW', group: 'Atmosphere', f: 'TPW', v: 'TPW', km: 10, sec: 'FCM', kind: 'tpw', range: [0, 75], unit: 'mm', dp: 1,
    cmap: 'tpw', cmaps: ['tpw', 'turbo'], desc: 'Clear-sky column water vapour, 10 km' },
  cape: { ...DSI, name: 'CAPE', group: 'Stability', v: 'CAPE', q: [0, 5000], range: [0, 4000], unit: 'J/kg', dp: 0, cmap: 'cape', cmaps: ['cape', 'turbo'], desc: 'Convective available potential energy, clear sky, 10 km' },
  ki: { ...DSI, name: 'K-Index', group: 'Stability', v: 'KI', q: [-70, 50], range: [0, 45], unit: '°C', dp: 1, cmap: 'cape', cmaps: ['cape', 'turbo', 'stab'], desc: 'Thunderstorm potential, clear sky, 10 km' },
  li: { ...DSI, name: 'Lifted Index', group: 'Stability', v: 'LI', q: [-10, 40], range: [-10, 10], unit: '°C', dp: 1, cmap: 'stab', cmaps: ['stab', 'turbo'], desc: 'Negative = unstable, clear sky, 10 km' },
  si: { ...DSI, name: 'Showalter Index', group: 'Stability', v: 'SI', q: [-10, 25], range: [-10, 10], unit: '°C', dp: 1, cmap: 'stab', cmaps: ['stab', 'turbo'], desc: 'Negative = unstable, clear sky, 10 km' },
  tt: { ...DSI, name: 'Total Totals Index', group: 'Stability', v: 'TT', q: [-43, 60], range: [20, 65], unit: '°C', dp: 1, cmap: 'cape', cmaps: ['cape', 'turbo'], desc: 'Severe weather potential, clear sky, 10 km' },
  farea: { name: 'Fire Area', group: 'Fire', f: 'FDC', v: 'Area', km: 2, sec: 'FCM', q: [0, 5], range: [0, 0.5], unit: 'km²', mul: 1, dp: 3, val: (v) => v / 1e6,
    cmap: 'fire', cmaps: ['fire', 'turbo'], desc: 'Burning area of fire pixels, 2 km' },
  fmask: { name: 'Fire Detection Mask', group: 'Fire', f: 'FDC', v: 'Mask', km: 2, sec: 'FCM', q: [0, 65534], val: (v) => FIRE_CLASS[v] ?? NaN,
    classes: [[0, 'No fire', null], [1, 'Good fire pixel', '#ff0000'], [2, 'Saturated', '#ff00ff'], [3, 'Cloud contaminated', '#ff9900'],
      [4, 'High probability', '#ffff00'], [5, 'Medium probability', '#a3e635'], [6, 'Low probability', '#4cc9f0']], desc: 'Fire pixels by confidence, 2 km' },
  fpower: { name: 'Fire Radiative Power', group: 'Fire', f: 'FDC', v: 'Power', km: 2, sec: 'FCM', q: [0, 20000], range: [0, 500], unit: 'MW', dp: 1,
    cmap: 'fire', cmaps: ['fire', 'turbo'], desc: 'Heat given off by fire pixels, 2 km' },
  ftemp: { name: 'Fire Temperature', group: 'Fire', f: 'FDC', v: 'Temp', km: 2, sec: 'FCM', q: [400, 4000], range: [400, 1500], unit: 'K', dp: 0,
    cmap: 'fire', cmaps: ['fire', 'turbo'], desc: 'Temperature of fire pixels, 2 km' },
  lsa: { name: 'Land Surface Albedo', group: 'Land', f: 'LSA', v: 'LSA', km: 2, sec: 'FCM', q: [0, 1.05], range: [0, 0.6], unit: '%', mul: 100, dp: 1,
    cmap: 'albedo', cmaps: ['albedo', 'gray', 'turbo'], desc: 'Shortwave broadband albedo, clear land, 2 km' },
  lst: { name: 'Land Surface Temperature', group: 'Land', f: 'LST', v: 'LST', km: 2, sec: 'FCM', kind: 'bt', range: [250, 330], cad: { full: 60, conus: 60, pacus: 60 },
    cmap: 'turbo', cmaps: ['turbo', 'ir_gray'], desc: 'Skin temperature of clear land, hourly' },
  fsc: { name: 'Snow Cover', group: 'Land', f: 'FSC', v: 'FSC', km: 2, sec: 'FCM', ...PCT, val: pct, cad: { full: 60, conus: 60, pacus: 60 },
    cmap: 'snow', cmaps: ['snow', 'gray'], desc: 'Fraction of each clear pixel under snow, hourly' },
};
function layerNames(v) {
  const out = [];
  for (let i = 0; i < 5; i++) if (v & (1 << i)) out.push(CF_LAYERS[i]);
  return out.join(' + ');
}
export const L2_GROUPS = ['Clouds', 'Atmosphere', 'Stability', 'Fire', 'Land'];
/** Kinds whose codes are categories: never blended between pixels. */
export const DISCRETE = new Set();
for (const [id, p] of Object.entries(L2)) {
  p.kind ||= id;
  if (!Q16[p.kind]) Q16[p.kind] = p.q;
  if (p.classes) {
    DISCRETE.add(p.kind);
    const shown = p.classes.filter((c) => c[2]);
    p.range = [shown[0][0] - 0.5, p.classes[p.classes.length - 1][0] + 0.5];
    p.cmap = `cls_${id}`; p.cmaps = [p.cmap];
  }
}
const L2_SECTOR = { full: 'F', custom: 'F', conus: 'C', pacus: 'C', meso1: 'M', meso2: 'M' };
/** Product folder and file token of an L2 product for a sector, or null when it is not made there. */
export function l2Source(product, sector) {
  const p = L2[product], s = L2_SECTOR[sector];
  if (!p.sec.includes(s)) return null;
  const tok = `${p.f}${s}${s === 'M' ? (sector === 'meso2' ? '2' : '1') : ''}`;
  return [`ABI-L2-${p.f}${s}`, tok, 'L2'];
}
export const l2SectorNames = (product) => [...L2[product].sec].map((s) => ({ F: 'Full Disk', C: 'CONUS / PACUS', M: 'Meso' })[s]).join(', ');

export const IR_CMAPS = ['ir_color', 'ir_gray', 'ir_rainbow', 'ir_bd', 'wv', 'turbo'];
export const VIS_CMAPS = ['vis', 'gray'];
export const FIXED_RANGE = { ir_color: [-90 + 273.15, 40 + 273.15], ir_rainbow: [163, 330], ir_bd: [163, 330], wv: [180, 290] };
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
  if (SATS[sat].kind !== 'goes') return b <= 4 ? 'vis' : b <= 6 ? 'gray' : bandDefaultCmap(b);
  return bandDefaultCmap(b);
}

export function rangeFor(sat, b, cmap) {
  if (FIXED_RANGE[cmap]) return FIXED_RANGE[cmap];
  const k = SATS[sat].kind;
  if (k === 'polar') {
    // b: the product id (DNB ranges come from each frame, see app.js)
    if (b === 'rr') return [Math.log10(0.1), Math.log10(60)];
    if (b === 'tpw') return [0, 75];
    if (ATMS_PRODUCTS[b]) return ATMS_CH[ATMS_PRODUCTS[b].ch][2];
    if (b === 'dnb') return [-10, -7];
    return VIIRS_RANGE[b] || (VIIRS[b] && VIIRS[b][2] === 'ir' ? [180, 320] : [0, 1.1]);
  }
  if (L2[b]) return L2[b].range;
  if (k !== 'goes' && b <= 4) return [0, 1.1];
  if (k === 'ami' && (b === 5 || b === 6)) return b === 5 ? [0, 0.5] : [0, 0.8];
  return BAND_RANGE[b];
}

/** Products of a satellite: RGB composites then single bands. */
export function products(sat) {
  if (SATS[sat].kind === 'polar') return polarProducts();
  const roles = rolesOf(sat), bands = bandsOf(sat);
  const out = [];
  for (const [id, r] of Object.entries(RGBS)) {
    if (r.roles.every((x) => x.endsWith('?') || x in roles)) out.push({ id, name: r.name, group: 'RGB', desc: r.desc, kind: 'rgb' });
  }
  const single = [];
  for (const [b, [name, wl, kind, res]] of Object.entries(bands)) {
    const n = +b;
    single.push({ id: `b${String(n).padStart(2, '0')}`, band: n, name: `${bandLabel(sat, n)} · ${wl} µm`, label: name,
      group: kind === 'vis' ? 'Visible' : n >= 8 && n <= 10 ? 'Water Vapor' : 'Infrared', desc: `native ${res} km`, kind,
      cmaps: kind === 'vis' ? VIS_CMAPS : IR_CMAPS, cmap: cmapFor(sat, n) });
  }
  // Visible, Infrared, then Water Vapor (bands 8-10) as a section of its own (sort is stable)
  const G = ['Visible', 'Infrared', 'Water Vapor'];
  out.push(...single.sort((a, b) => G.indexOf(a.group) - G.indexOf(b.group)));
  // GOES only: the ABI Level-2 products, by group, alphabetical within each
  if (SATS[sat].kind === 'goes') {
    const l2 = Object.entries(L2).map(([id, p]) => ({ id, band: id, name: p.name, group: p.group,
      desc: p.sec === 'FCM' ? p.desc : `${p.desc} · ${l2SectorNames(id)} only`, kind: 'l2', cmaps: p.cmaps, cmap: p.cmap, classes: p.classes }));
    out.push(...l2.sort((a, b) => L2_GROUPS.indexOf(a.group) - L2_GROUPS.indexOf(b.group) || a.name.localeCompare(b.name)));
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
  wv: { label: 'Water vapour' }, turbo: { label: 'Turbo' }, mw_scatter: { label: 'Microwave scattering' },
  // values below the table (no rain) get their own colour: a faint veil that shows the swath
  precip: { label: 'Precipitation', below: [14, 22, 34, 70] }, tpw: { label: 'Precipitable water' },
  cloudfrac: { label: 'Cloud cover' }, cth: { label: 'Cloud height' }, ctp: { label: 'Cloud-top pressure' }, aod: { label: 'Aerosol' },
  cape: { label: 'Instability' }, stab: { label: 'Unstable red / stable blue' }, fire: { label: 'Fire' }, albedo: { label: 'Albedo' },
  snow: { label: 'Snow cover' },
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
// Clean IR colour table, defined in °C: grayscale from black (40 °C) to white (-20 °C), then
// cyan -> navy -> green -> yellow -> red -> black (-70 °C), grays (-70 .. -80 °C), and pink
// -> purple for the coldest tops (-80 .. -90 °C). Values beyond either end keep the end colour.
const IR_COLOR_C = [
  [-90, '#7e0281'], [-80, '#e86ebc'], [-79.99, '#ebebeb'], [-75, '#858585'], [-70, '#000000'],
  [-65, '#970000'], [-60, '#ff0000'], [-55, '#fd9600'], [-50, '#ffff00'], [-45, '#67ff00'],
  [-41, '#0fff00'], [-40, '#00e608'], [-35, '#04644f'], [-30, '#000073'], [-25, '#0096c3'],
  [-20, '#00f0f0'], [-19.99, '#ffffff'], [-10, '#eeeeee'], [0, '#cdcdcd'], [10, '#a0a0a0'],
  [20, '#707070'], [30, '#404040'], [40, '#000000'],
];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const H = (arr) => arr.map(([v, c]) => [v, hex(c)]);

const STOPS = {
  vis: (lo, hi) => grayStops(lo, hi, false, 0.5, 64),
  gray: (lo, hi) => grayStops(lo, hi),
  ir_gray: (lo, hi) => grayStops(lo, hi, true),
  ir_color: () => H(IR_COLOR_C.map(([c, col]) => [c + 273.15, col])),
  ir_sandwich: () => H([[163, '#ffffff'], [180, '#f0f0f0'], [186, '#e2d4ff'], [191, '#b48cff'], [196, '#7b2cbf'], [201, '#3c096c'],
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
  // 89 / 165 GHz style: deep convection (cold) red / yellow, warm background blue / grey
  mw_scatter: (lo, hi) => {
    const c = ['#5b0011', '#c1121f', '#ff5d00', '#ffb000', '#fff200', '#9ef01a', '#21c45d', '#0e9aa7', '#2d6cdf', '#5560c8', '#8a8fb0', '#c8c8d8', '#ffffff'];
    return c.map((h, i) => [lo + (hi - lo) * i / (c.length - 1), hex(h)]);
  },
  precip: () => H([[0.1, '#3b5bdb'], [0.5, '#1c7ed6'], [1, '#15aabf'], [2, '#2fb344'], [4, '#94d82d'], [6, '#fcc419'], [10, '#fd7e14'],
    [16, '#f03e3e'], [25, '#c2255c'], [40, '#ae3ec9'], [60, '#f8d7ff']].map(([v, c]) => [Math.log10(v), c])),
  tpw: () => H([[0, '#4a2f1a'], [8, '#a0662b'], [16, '#e0b56a'], [24, '#d8f0a8'], [32, '#4cc06a'], [40, '#1c9aa8'], [48, '#2554c7'],
    [56, '#5b2bb5'], [64, '#c43fc7'], [75, '#ffd6ff']]),
  // GOES Level-2 products (spread over the shown range)
  cloudfrac: spread(['#0b1a33', '#1f3b63', '#3f6595', '#7c9cc0', '#bccbdc', '#ffffff']),
  cth: spread(['#1b4332', '#2d6a4f', '#52b788', '#b7e4c7', '#ffd166', '#f77f00', '#d62828', '#9d0208', '#ff70a6', '#ffffff']),
  ctp: spread(['#ffffff', '#ff70a6', '#9d0208', '#d62828', '#f77f00', '#ffd166', '#b7e4c7', '#52b788', '#2d6a4f', '#1b4332']),
  aod: spread(['#313695', '#4575b4', '#74add1', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026', '#5e0016']),
  cape: spread(['#f8f9fa', '#ffe066', '#ffa94d', '#ff6b6b', '#e03131', '#ae3ec9', '#5f3dc4']),
  stab: spread(['#7b0099', '#d6336c', '#f76707', '#fcc419', '#f8f9fa', '#74c0fc', '#1c7ed6', '#1b3a8c']),
  fire: spread(['#fff3b0', '#ffd000', '#ff8800', '#ff3300', '#b30000', '#4a0000']),
  albedo: spread(['#1a1a2e', '#3a5a40', '#a3b18a', '#dda15e', '#e9edc9', '#ffffff']),
  snow: spread(['#3d3a33', '#6b705c', '#a5a58d', '#b8d8e8', '#e0f4ff', '#ffffff']),
};
function spread(cols) {
  return (lo, hi) => cols.map((h, i) => [lo + (hi - lo) * i / (cols.length - 1), hex(h)]);
}
// category tables: flat colour per class value; values under the first coloured class are transparent
for (const p of Object.values(L2)) {
  if (!p.classes) continue;
  CMAPS[p.cmap] = { label: 'Categories', below: [0, 0, 0, 0] };
  STOPS[p.cmap] = () => p.classes.filter((c) => c[2]).flatMap(([v, , c]) => [[v - 0.5, hex(c)], [v + 0.4999, hex(c)]]);
}

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
