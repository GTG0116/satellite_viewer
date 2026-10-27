/* Hurricane Hunter charts, opened by clicking the recon on the map (the same file serves both
 * editions, like recon.js):
 *   FlightChart  one flight's 30-s observations against time, or against distance from the storm
 *                center (interpolated between the center fixes): flight-level, peak and SFMR wind
 *                with the intensity classes; extrapolated surface pressure with the center fixes
 *                and dropsondes; temperature and dew point; altitude; SFMR rain rate. Hovering
 *                reads every value and marks the aircraft's position on the map.
 *   SondeView    a dropsonde: Skew-T log-p (isotherms, dry and moist adiabats, mixing-ratio lines,
 *                the surface parcel, wind barbs) and its numbers: release and splash, surface
 *                values, layer-mean winds, LCL, CAPE / CIN, precipitable water, freezing level,
 *                the strongest wind, every level, and the message as sent.
 * Both are floating windows like the ensemble intensity charts (tchart.js), sharing its styles.
 */
import { CATS, fmtWind, toUnit, unitLabel } from './overlays.js';

const p2 = (n) => String(n).padStart(2, '0');
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hm = (t) => { const d = new Date(t); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
const hms = (t) => `${hm(t)}:${p2(new Date(t).getUTCSeconds())}Z`;
const day = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fix = (v, d = 1) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d));
const ll = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
const wdir = (d) => `${String(Math.round(d)).padStart(3, '0')}°`;
const windTxt = (w) => (w && w.ws != null ? `${w.wd != null ? `${wdir(w.wd)} ` : ''}${fmtWind(w.ws)}` : '—');
function km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A floating window (styled like tchart.js's): header with a title, extra controls and close;
 *  dragged by its header on wide screens, closed with Esc. */
function makeWindow(cls, label, onClose) {
  const w = document.createElement('div');
  w.className = `tc-win ${cls} hidden`;
  w.setAttribute('role', 'dialog');
  w.setAttribute('aria-label', label);
  w.innerHTML = `<header class="tc-head"><b class="rw-title"></b><span class="rw-ctl"></span>
    <button type="button" class="tc-close" title="Close (Esc)" aria-label="Close">×</button></header>
    <div class="tc-body"></div><div class="tc-tip hidden"></div>`;
  document.body.appendChild(w);
  w.querySelector('.tc-close').onclick = onClose;
  w.querySelector('.tc-head').addEventListener('pointerdown', (e) => {
    if (e.target.closest('select, button, input') || innerWidth < 700) return;
    const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => { w.style.left = `${Math.max(0, Math.min(innerWidth - 120, ev.clientX - dx))}px`; w.style.top = `${Math.max(0, Math.min(innerHeight - 60, ev.clientY - dy))}px`; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !w.classList.contains('hidden') && !e.target.matches?.('input, select, textarea')) onClose(); });
  return w;
}

// ================================================================== flight chart
const M = { l: 44, r: 40, t: 8, b: 22 };
const SERIES = {
  fl: { name: 'Flight level (30 s)', color: '#e9eef6', width: 1.6 },
  peak: { name: 'Peak FL (10 s)', color: '#8fa3bf', width: 1, dash: '3 2' },
  sfmr: { name: 'SFMR surface', color: '#ffa94d', width: 1.6 },
};
const CDEF = { x: 'time', fl: true, peak: false, sfmr: true };

export class FlightChart {
  /** rc: the Recon (its flights, fixes, drops, state, value(), highlight()). */
  constructor(rc) {
    this.rc = rc;
    this.c = rc.st.chart = { ...CDEF, ...(rc.st.chart && typeof rc.st.chart === 'object' ? rc.st.chart : {}) };
    this.w = makeWindow('rc-win', 'Hurricane Hunter flight charts', () => this.close());
    this.w.querySelector('.rw-title').textContent = 'Recon flight';
    const ctl = this.w.querySelector('.rw-ctl');
    ctl.innerHTML = '<select class="rc-flight" aria-label="Flight"></select>';
    ctl.querySelector('select').onchange = (e) => { this.fid = e.target.value; this.draw(); };
    const body = this.w.querySelector('.tc-body');
    body.innerHTML = `
      <div class="tc-title rc-top"><span class="rc-sum"></span>
        <label class="rc-xsel">X axis <select data-k="x"><option value="time">Time</option><option value="dist">Distance from center</option></select></label></div>
      <div class="tc-sec"><div class="tc-title"><b class="rc-wtitle">Wind</b><span class="tc-tog">${Object.entries(SERIES).map(([k, s]) => `<button type="button" data-s="${k}"><i style="background:${s.color}"></i>${s.name}</button>`).join('')}</span></div><div class="tc-plot" data-p="wind"></div></div>
      <div class="tc-sec"><div class="tc-title"><b>Extrapolated surface pressure (hPa)</b><span class="rc-key"><span><i class="rc-k-fix"></i>center fix</span><span><i class="rc-k-drop"></i>dropsonde (click for its Skew-T)</span></span></div><div class="tc-plot" data-p="pres"></div></div>
      <div class="tc-sec"><div class="tc-title"><b>Flight-level temperature / dew point (°C)</b></div><div class="tc-plot" data-p="temp"></div></div>
      <div class="tc-sec"><div class="tc-title"><b>Altitude (m) · D-value (m)</b></div><div class="tc-plot" data-p="alt"></div></div>
      <div class="tc-sec"><div class="tc-title"><b>SFMR rain rate (mm/h)</b></div><div class="tc-plot" data-p="rain"></div></div>
      <div class="note rc-note"></div>`;
    for (const b of body.querySelectorAll('[data-s]')) b.onclick = () => { this.c[b.dataset.s] = !this.c[b.dataset.s]; this.save(); this.draw(); };
    const xs = body.querySelector('[data-k=x]');
    xs.onchange = () => { this.c.x = xs.value; this.save(); this.draw(); };
    body.addEventListener('pointermove', (e) => this.hover(e));
    body.addEventListener('pointerleave', () => this.unhover());
    body.addEventListener('click', (e) => {
      const d = e.target.closest('[data-drop]');
      if (d) this.rc.openSonde(this.rc.drops[+d.dataset.drop]);
    });
    new ResizeObserver(() => { if (this.isOpen) this.draw(); }).observe(body);
  }

  get isOpen() { return !this.w.classList.contains('hidden'); }
  save() { this.rc.onChange(this.rc.st); }

  open(flight, t) {
    this.fid = flight.id;
    this.w.classList.remove('hidden');
    this.draw();
    if (t) this.mark(t);
  }

  close() { this.w.classList.add('hidden'); this.unhover(); }

  flight() { return this.rc.flights.find((f) => f.id === this.fid) || null; }

  /** The storm center at time t from the flight's storm's fixes (between two fixes: interpolated;
   *  up to 6 h beyond them: extrapolated with the nearest two), or null. */
  centerFn(f) {
    const t0 = f.obs[0].t, t1 = f.obs[f.obs.length - 1].t;
    let fx = this.rc.fixes.filter((v) => v.t > t0 - 12 * 3600e3 && v.t < t1 + 12 * 3600e3);
    fx = f.storm ? fx.filter((v) => v.storm === f.storm) : fx.filter((v) => f.obs.some((o, i) => i % 40 === 0 && km(o, v) < 600));
    fx.sort((a, b) => a.t - b.t);
    if (!fx.length) return null;
    return (t) => {
      if (fx.length === 1) return Math.abs(t - fx[0].t) < 6 * 3600e3 ? fx[0] : null;
      let i = fx.findIndex((v) => v.t >= t);
      if (i <= 0) i = i === 0 ? 1 : fx.length - 1;
      const a = fx[i - 1], b = fx[i], dt = b.t - a.t || 1, u = (t - a.t) / dt;
      if ((t < a.t && a.t - t > 6 * 3600e3) || (t > b.t && t - b.t > 6 * 3600e3)) return null;
      return { lat: a.lat + (b.lat - a.lat) * u, lon: a.lon + (b.lon - a.lon) * u };
    };
  }

  draw() {
    if (!this.isOpen) return;
    const rc = this.rc, q = (s) => this.w.querySelector(s), sel = q('.rc-flight');
    sel.innerHTML = rc.flights.map((f) => `<option value="${esc(f.id)}">${esc(f.ac)}${f.storm ? ` · ${esc(f.storm)}` : ''} · ${day(f.obs[0].t)} ${hm(f.obs[0].t)}–${hm(f.obs[f.obs.length - 1].t)}Z</option>`).join('');
    const f = this.flight();
    if (!f) { for (const p of this.w.querySelectorAll('.tc-plot')) p.innerHTML = '<div class="tc-empty">This flight is no longer loaded.</div>'; return; }
    sel.value = f.id;
    for (const b of this.w.querySelectorAll('[data-s]')) b.classList.toggle('on', !!this.c[b.dataset.s]);
    q('.rc-wtitle').textContent = `Wind (${unitLabel()})`;
    const center = this.centerFn(f), dist = this.c.x === 'dist' && center;
    q('[data-k=x]').value = this.c.x;
    q('.rc-note').textContent = this.c.x === 'dist' && !center ? 'No center fixes of this storm near the flight: distance from center is not available, so the charts use time.' :
      dist ? `Distance from the storm center (interpolated between the center fixes), within ${unitLabel() === 'kt' || unitLabel() === 'mph' ? '250 nm' : '450 km'}.` : '';
    // points: x value per observation
    const nm = unitLabel() === 'kt' || unitLabel() === 'mph';
    const obs = f.obs.map((o) => {
      const c = center ? center(o.t) : null;
      const d = c ? km(o, c) : null;
      return { o, x: dist ? (d == null ? null : nm ? d / 1.852 : d) : o.t, d };
    }).filter((p) => p.x != null && (!dist || p.x <= (nm ? 250 : 450)));   // radial profiles: the storm, not the ferry legs
    this.pts = obs;
    if (!obs.length) return;
    const xs = obs.map((p) => p.x), x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
    const W = Math.max(300, q('[data-p=wind]').clientWidth);
    const X = (v) => M.l + ((v - x0) / (x1 - x0)) * (W - M.l - M.r);
    this.X = { x0, x1, W, dist, nm, inv: (px) => x0 + ((px - M.l) / (W - M.l - M.r)) * (x1 - x0) };
    const val = (k) => (p) => rc.value(p.o, k);
    // summary
    const mx = (k) => obs.reduce((m, p) => { const v = rc.value(p.o, k); return v != null && (!m || v > m.v) ? { v, p } : m; }, null);
    const mn = obs.reduce((m, p) => (p.o.xp != null && p.o.xp > 850 && (!m || p.o.xp < m.v) ? { v: p.o.xp, p } : m), null);
    const fl = mx('fl'), sf = mx('sfmr');
    q('.rc-sum').innerHTML = [`<b>${esc(f.ac)}</b> mission ${esc(f.mission)}`, `${obs.length} obs`,
      fl ? `max FL <b>${fmtWind(fl.v)}</b> ${hm(fl.p.o.t)}Z` : '', sf ? `max SFMR <b>${fmtWind(sf.v)}</b> ${hm(sf.p.o.t)}Z` : '',
      mn ? `min <b>${mn.v.toFixed(1)} hPa</b>` : ''].filter(Boolean).join(' · ');
    // wind with the intensity classes
    const wins = Object.keys(SERIES).filter((k) => this.c[k]);
    let wmax = 50;
    for (const k of wins) for (const p of obs) { const v = rc.value(p.o, k); if (v != null) wmax = Math.max(wmax, toUnit(v)); }
    const wtop = Math.ceil((wmax * 1.08) / 20) * 20;
    let cats = '';
    const Yw = (v) => M.t + (1 - v / wtop) * (200 - M.t - M.b);
    for (let i = 0; i < CATS.length - 1; i++) {
      const v = toUnit(CATS[i].max);
      if (v > wtop) break;
      const n = CATS[i + 1];
      cats += `<line x1="${M.l}" x2="${W - M.r}" y1="${Yw(v)}" y2="${Yw(v)}" class="tc-cat" stroke="${n.color}"/><text x="${W - M.r + 3}" y="${Yw(v) + 3.5}" class="tc-catl" fill="${n.color}">${n.id === 'ts' ? 'TS' : n.label.replace('Cat ', 'C')}</text>`;
    }
    q('[data-p=wind]').innerHTML = this.svg({ W, h: 200, X, y0: 0, y1: wtop, step: wtop > 160 ? 40 : 20, extra: cats,
      series: wins.map((k) => ({ ...SERIES[k], get: (p) => toUnit(val(k)(p)) })) });
    // pressure, with fixes and dropsondes of this flight
    const span = [f.obs[0].t - 600e3, f.obs[f.obs.length - 1].t + 600e3];
    const mine = (v) => v.ac === f.ac && v.t >= span[0] && v.t <= span[1];
    const xOf = (t, lat, lon) => (dist ? (() => { const c = center(t); if (!c) return null; const d = km({ lat, lon }, c); return nm ? d / 1.852 : d; })() : t);
    const fixes = rc.fixes.filter(mine).map((v) => ({ v, x: xOf(v.t, v.lat, v.lon) })).filter((a) => a.x != null && a.v.mslp);
    const drops = rc.drops.map((d, i) => ({ d, i })).filter((a) => mine(a.d) && a.d.p).map((a) => ({ ...a, x: xOf(a.d.t, a.d.lat, a.d.lon) })).filter((a) => a.x != null);
    const ps = [...obs.map((p) => p.o.xp).filter((v) => v != null && v > 850), ...fixes.map((a) => a.v.mslp), ...drops.map((a) => a.d.p)];
    const pr = ps.length ? [Math.floor((Math.min(...ps) - 2) / 5) * 5, Math.ceil((Math.max(...ps) + 2) / 5) * 5] : [990, 1015];
    const hP = 170, Yp = (v) => M.t + (1 - (v - pr[0]) / Math.max(1, pr[1] - pr[0])) * (hP - M.t - M.b);
    let marks = '';
    for (const a of fixes) {
      const x = X(a.x), y = Yp(a.v.mslp);
      marks += `<path d="M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z" class="rc-fixm"><title>Center fix ${hm(a.v.t)}Z: ${a.v.mslp} hPa</title></path>`;
    }
    for (const a of drops) {
      const x = X(a.x), y = Yp(a.d.p);
      marks += `<path d="M${x - 5.5} ${y - 4}L${x + 5.5} ${y - 4}L${x} ${y + 5}Z" class="rc-dropm" data-drop="${a.i}"><title>Dropsonde ${hm(a.d.t)}Z: ${a.d.p} hPa${a.d.ws != null ? `, ${fmtWind(a.d.ws)}` : ''} (click: Skew-T)</title></path>`;
    }
    q('[data-p=pres]').innerHTML = this.svg({ W, h: hP, X, y0: pr[0], y1: pr[1], step: pr[1] - pr[0] > 60 ? 20 : pr[1] - pr[0] > 25 ? 10 : 5, extra: marks, after: true,
      series: [{ color: '#c9d3e3', width: 1.6, get: (p) => (p.o.xp != null && p.o.xp > 850 ? p.o.xp : null) }] });
    // temperature / dew point
    const tv = obs.flatMap((p) => [rc.value(p.o, 'temp'), rc.value(p.o, 'dew')]).filter((v) => v != null);
    const tr = tv.length ? [Math.floor((Math.min(...tv) - 1) / 5) * 5, Math.ceil((Math.max(...tv) + 1) / 5) * 5] : [0, 30];
    q('[data-p=temp]').innerHTML = this.svg({ W, h: 150, X, y0: tr[0], y1: tr[1], step: tr[1] - tr[0] > 40 ? 10 : 5,
      series: [{ color: '#ff6b6b', width: 1.5, get: val('temp') }, { color: '#4cd08a', width: 1.5, get: val('dew') }] });
    // altitude and D-value
    const zs = obs.map((p) => p.o.z).filter((v) => v != null), dvs = obs.map((p) => p.o.dv).filter((v) => v != null);
    const zr = [0, Math.max(1000, Math.ceil((Math.max(0, ...zs, ...dvs) * 1.05) / 1000) * 1000)], zl = Math.min(0, ...dvs);
    q('[data-p=alt]').innerHTML = this.svg({ W, h: 130, X, y0: Math.floor(zl / 500) * 500, y1: zr[1], step: zr[1] > 6000 ? 2000 : 1000,
      series: [{ color: '#74c0fc', width: 1.5, get: (p) => p.o.z }, { color: '#b197fc', width: 1.2, dash: '4 2', get: (p) => p.o.dv }] });
    // rain rate
    const rr = obs.map((p) => rc.value(p.o, 'rain')).filter((v) => v != null);
    q('[data-p=rain]').innerHTML = this.svg({ W, h: 110, X, y0: 0, y1: Math.max(10, Math.ceil((Math.max(0, ...rr) * 1.1) / 10) * 10), step: Math.max(...rr, 0) > 50 ? 20 : 10, bars: true,
      series: [{ color: '#4dabf7', width: 1, get: val('rain') }] });
  }

  /** One chart: grid, x axis (times or distances), lines (dots against distance), markers. */
  svg({ W, h, X, y0, y1, step, series, extra = '', after = false, bars = false }) {
    const Y = (v) => M.t + (1 - (v - y0) / Math.max(1e-9, y1 - y0)) * (h - M.t - M.b);
    let s = '';
    for (let v = Math.ceil(y0 / step) * step; v <= y1 + 1e-9; v += step) {
      s += `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}" class="tc-grid"/><text x="${M.l - 5}" y="${Y(v) + 3.5}" text-anchor="end" class="tc-ax">${v}</text>`;
    }
    s += this.xaxis(W, h, X);
    if (!after) s += extra;
    const dots = this.X.dist;
    for (const se of series) {
      if (bars) {
        for (const p of this.pts) { const v = se.get(p); if (v) s += `<line x1="${X(p.x)}" x2="${X(p.x)}" y1="${Y(0)}" y2="${Y(v)}" stroke="${se.color}" stroke-width="1.2" opacity="0.8"/>`; }
        continue;
      }
      if (dots) {
        let d = '';
        for (const p of this.pts) { const v = se.get(p); if (v != null) d += `M${X(p.x).toFixed(1)} ${Y(v).toFixed(1)}h0.1`; }
        s += `<path d="${d}" stroke="${se.color}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.85"/>`;
        continue;
      }
      let d = '', prev = null;
      for (const p of this.pts) {
        const v = se.get(p);
        if (v == null) { prev = null; continue; }
        const cmd = prev && p.o.t - prev.o.t <= 3 * 60e3 ? 'L' : 'M';
        d += `${cmd}${X(p.x).toFixed(1)} ${Y(v).toFixed(1)}`;
        prev = p;
      }
      s += `<path d="${d}" stroke="${se.color}" stroke-width="${se.width}" fill="none" stroke-linejoin="round"${se.dash ? ` stroke-dasharray="${se.dash}"` : ''}/>`;
    }
    if (after) s += extra;
    return `<svg class="tc-svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">${s}</svg><div class="tc-cursor hidden"></div>`;
  }

  xaxis(W, h, X) {
    const { x0, x1, dist, nm } = this.X;
    let s = '';
    if (dist) {
      const span = x1 - x0, st = [10, 20, 25, 50, 100, 200].find((v) => span / v <= 8) || 500;
      for (let v = Math.ceil(x0 / st) * st; v <= x1; v += st) {
        s += `<line x1="${X(v)}" x2="${X(v)}" y1="${M.t}" y2="${h - M.b}" class="tc-grid"/><text x="${X(v)}" y="${h - 6}" text-anchor="middle" class="tc-ax">${v} ${nm ? 'nm' : 'km'}</text>`;
      }
      return s;
    }
    const st = [5, 10, 15, 30, 60, 120, 180, 360].map((m) => m * 60e3).find((v) => (x1 - x0) / v <= 8) || 720 * 60e3;
    for (let t = Math.ceil(x0 / st) * st; t <= x1; t += st) {
      s += `<line x1="${X(t)}" x2="${X(t)}" y1="${M.t}" y2="${h - M.b}" class="tc-grid"/><text x="${X(t)}" y="${h - 6}" text-anchor="middle" class="tc-ax">${hm(t)}Z</text>`;
    }
    return s;
  }

  /** Cursor and readout at the observation nearest the pointer; its position marked on the map. */
  hover(e) {
    if (!this.X || !this.pts?.length) return;
    const plot = this.w.querySelector('[data-p=wind]'), r = plot.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < M.l - 4 || px > this.X.W - M.r + 4) { this.unhover(); return; }
    const xv = this.X.inv(px);
    let best = null;
    for (const p of this.pts) if (!best || Math.abs(p.x - xv) < Math.abs(best.x - xv)) best = p;
    this.show(best, e);
  }

  show(p, e) {
    const X = (v) => M.l + ((v - this.X.x0) / (this.X.x1 - this.X.x0)) * (this.X.W - M.l - M.r);
    for (const c of this.w.querySelectorAll('.tc-cursor')) { c.style.left = `${X(p.x)}px`; c.classList.remove('hidden'); }
    const o = p.o, rc = this.rc, f = this.flight();
    const flag = (k) => (rc.value(o, k) == null && o[{ fl: 'ws', sfmr: 'sfmr', temp: 'T' }[k]] != null ? ' <span class="rc-flag">flagged</span>' : '');
    const tip = this.w.querySelector('.tc-tip');
    tip.innerHTML = [
      `<div><b>${hms(o.t)}</b> · ${ll(o.lat, o.lon)}${p.d != null ? ` · ${(this.X.nm ? p.d / 1.852 : p.d).toFixed(0)} ${this.X.nm ? 'nm' : 'km'} from center` : ''}</div>`,
      `<div>FL wind <b>${o.wd != null && o.ws != null ? `${wdir(o.wd)} ` : ''}${fmtWind(o.ws)}</b>${flag('fl')} · peak ${fmtWind(o.fl)}</div>`,
      `<div>SFMR <b>${fmtWind(o.sfmr)}</b>${flag('sfmr')} · rain ${o.rain != null ? `${o.rain} mm/h` : '—'}</div>`,
      `<div>${o.xp != null ? `Extrap. surface pressure <b>${o.xp.toFixed(1)} hPa</b>` : o.dv != null ? `D-value <b>${o.dv} m</b>` : 'No surface pressure'}</div>`,
      `<div>Flight level ${fix(o.p)} hPa · ${o.z ?? '—'} m</div>`,
      `<div>Temp ${fix(o.T)} °C · dew pt ${fix(o.Td)} °C${flag('temp')}</div>`,
      f ? `<div class="tc-tipd">${esc(f.ac)} · mission ${esc(f.mission)}</div>` : '',
    ].join('');
    const body = this.w.querySelector('.tc-body').getBoundingClientRect(), wr = this.w.getBoundingClientRect();
    tip.classList.remove('hidden');
    const x = (e ? e.clientX : wr.left + X(p.x) + 12) - wr.left + 14, tw = tip.offsetWidth;
    tip.style.left = `${x + tw > wr.width - 8 ? x - tw - 28 : x}px`;
    tip.style.top = `${Math.max(body.top - wr.top + 4, (e ? e.clientY - wr.top : 90) - 20)}px`;
    rc.highlight(o);
  }

  /** Cursor at a time (the observation clicked on the map). */
  mark(t) {
    if (!this.pts?.length) return;
    let best = this.pts[0];
    for (const p of this.pts) if (Math.abs(p.o.t - t) < Math.abs(best.o.t - t)) best = p;
    this.show(best, null);
  }

  unhover() {
    for (const c of this.w.querySelectorAll('.tc-cursor')) c.classList.add('hidden');
    this.w.querySelector('.tc-tip').classList.add('hidden');
    this.rc.highlight(null);
  }
}

// ================================================================== dropsonde
const Rd = 287.04, CP = 1005.7, LV = 2.501e6, EPS = 0.622, K = 273.15, KAPPA = Rd / CP;
const es = (T) => 6.112 * Math.exp((17.67 * T) / (T + 243.5));          // hPa, T in °C
const mixr = (T, p) => { const e = es(T); return (EPS * e) / Math.max(1, p - e); };   // kg/kg at saturation
const dewFromE = (e) => { const l = Math.log(e / 6.112); return (243.5 * l) / (17.67 - l); };
const theta = (T, p) => (T + K) * (1000 / p) ** KAPPA;
/** Pseudo-adiabatic dT/dlnp (K) for a saturated parcel at T (K), p (hPa). */
function moistRate(TK, p) {
  const rs = mixr(TK - K, p);
  return (Rd * TK + LV * rs) / (CP + (LV * LV * rs * EPS) / (Rd * TK * TK));
}
/** Saturated parcel from (T °C, p0) to p1: RK2 in ln p. */
function moistTo(T, p0, p1, n = 24) {
  let TK = T + K, lp = Math.log(p0);
  const h = (Math.log(p1) - lp) / n;
  for (let i = 0; i < n; i++) {
    const k1 = moistRate(TK, Math.exp(lp)), k2 = moistRate(TK + k1 * h, Math.exp(lp + h));
    TK += ((k1 + k2) / 2) * h; lp += h;
  }
  return TK - K;
}
/** LCL of a surface parcel (Bolton 1980): {p, T}. */
function lcl(T, Td, p) {
  const TK = T + K, DK = Td + K;
  const TL = 1 / (1 / (DK - 56) + Math.log(TK / DK) / 800) + 56;
  return { p: p * (TL / TK) ** (1 / KAPPA), T: TL - K };
}

/** Derived numbers of a sounding: heights, RH, parcel, LCL, CAPE / CIN, PW, freezing level, max wind. */
export function analyze(d) {
  const lv = d.levels.map((l) => ({ ...l }));
  const tl = lv.filter((l) => l.T != null);
  // heights: hypsometric from the surface (sea level at the splash), else from a standard level
  const zKnown = lv.find((l) => l.surface) ? { p: lv[0].p, z: 0 } : lv.find((l) => l.z != null);
  if (zKnown && tl.length) {
    const Tv = (l) => (l.T + K) * (1 + 0.61 * (l.Td != null ? mixr(l.Td, l.p) : 0));
    const zs = new Map();
    // integrate from the known level both ways over the temperature levels
    const at = tl.map((l) => ({ p: l.p, tv: Tv(l) }));
    let i0 = at.findIndex((a) => a.p <= zKnown.p);
    if (i0 < 0) i0 = at.length - 1;
    const tvAt = (p) => { let j = at.findIndex((a) => a.p <= p); if (j <= 0) return at[Math.max(0, j)].tv; const a = at[j - 1], b = at[j], u = Math.log(a.p / p) / Math.log(a.p / b.p); return a.tv + (b.tv - a.tv) * u; };
    const zOf = (p) => {
      // simple integration in 20 steps between the known level and p
      const n = 20, la = Math.log(zKnown.p), lb = Math.log(p);
      let z = zKnown.z;
      for (let k = 0; k < n; k++) { const pm = Math.exp(la + (lb - la) * (k + 0.5) / n); z -= (Rd / 9.80665) * tvAt(pm) * ((lb - la) / n); }
      return z;
    };
    for (const l of lv) if (l.z == null || !l.surface) zs.set(l, l.surface ? 0 : zOf(l.p));
    for (const [l, z] of zs) l.z = Math.round(z);
    if (lv[0].surface) lv[0].z = 0;
  }
  for (const l of lv) l.rh = l.T != null && l.Td != null ? Math.min(100, (100 * es(l.Td)) / es(l.T)) : null;
  const out = { lv, tl, top: Math.min(...lv.map((l) => l.p)), bot: Math.max(...lv.map((l) => l.p)) };
  const s = tl[0];
  if (s && s.Td != null) {
    out.lcl = lcl(s.T, s.Td, s.p);
    // parcel path, surface to the sounding's top
    const path = [], steps = 60, lp0 = Math.log(s.p), lp1 = Math.log(out.top);
    let Tm = null, pm = null;
    for (let k = 0; k <= steps; k++) {
      const p = Math.exp(lp0 + ((lp1 - lp0) * k) / steps);
      let T;
      if (p >= out.lcl.p) T = (s.T + K) * (p / s.p) ** KAPPA - K;
      else { T = moistTo(Tm == null ? out.lcl.T : Tm, pm == null ? out.lcl.p : pm, p, 6); Tm = T; pm = p; }
      path.push({ p, T });
    }
    out.parcel = path;
    // CAPE / CIN with the environment interpolated in ln p (temperature, not virtual)
    const envT = (p) => interp(tl, p, 'T');
    let cape = 0, cin = 0, lfc = null;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1], b = path[k], ea = envT(a.p), eb = envT(b.p);
      if (ea == null || eb == null) continue;
      const da = a.T - ea, db = b.T - eb, dl = Math.log(a.p / b.p), e = Rd * ((da + db) / 2) * dl;
      if (e > 0) { cape += e; if (lfc == null && b.p < out.lcl.p) lfc = b.p; } else if (lfc == null) cin += e;
    }
    Object.assign(out, { cape, cin, lfc });
  }
  // precipitable water over the levels with a dew point
  let pw = 0;
  const wl = tl.filter((l) => l.Td != null);
  for (let k = 1; k < wl.length; k++) {
    const a = wl[k - 1], b = wl[k];
    pw += (((mixr(a.Td, a.p) + mixr(b.Td, b.p)) / 2) * (a.p - b.p) * 100) / 9.80665;
  }
  out.pw = wl.length > 1 ? pw : null;
  out.pwTop = wl.length ? wl[wl.length - 1].p : null;
  // freezing level
  for (let k = 1; k < tl.length; k++) {
    const a = tl[k - 1], b = tl[k];
    if (a.T >= 0 && b.T < 0 && a.z != null && b.z != null) { out.frz = { z: a.z + ((b.z - a.z) * a.T) / (a.T - b.T), p: Math.exp(Math.log(a.p) + (Math.log(b.p / a.p) * a.T) / (a.T - b.T)) }; break; }
  }
  const wv = lv.filter((l) => l.ws != null);
  out.maxw = wv.length ? wv.reduce((a, b) => (b.ws > a.ws ? b : a)) : null;
  return out;
}
function interp(levels, p, k) {
  const a = levels.filter((l) => l[k] != null);
  if (!a.length || p > a[0].p + 1 || p < a[a.length - 1].p - 1) return null;
  for (let i = 1; i < a.length; i++) {
    if (a[i].p <= p) { const u = Math.log(a[i - 1].p / p) / Math.log(a[i - 1].p / a[i].p); return a[i - 1][k] + (a[i][k] - a[i - 1][k]) * u; }
  }
  return a[a.length - 1][k];
}

/** A wind barb on a canvas: the staff points where the wind comes from, feathers on its
 *  clockwise side (Northern Hemisphere). */
function barb(g, x, y, wd, kt, L = 24) {
  const a = (wd * Math.PI) / 180, ux = Math.sin(a), uy = -Math.cos(a), px = -uy, py = ux;
  g.beginPath();
  if (kt < 3) { g.arc(x, y, 3.5, 0, Math.PI * 2); g.stroke(); return; }
  g.moveTo(x, y); g.lineTo(x + ux * L, y + uy * L); g.stroke();
  let n = Math.round(kt / 5) * 5, s = L;
  const fx = 10, fy = 4;
  const at = (d) => [x + ux * d, y + uy * d];
  while (n >= 50) {
    const [ax, ay] = at(s), [mx, my] = at(s - 3.5), [bx, by] = at(s - 7);
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(mx + px * fx, my + py * fx); g.lineTo(bx, by); g.closePath(); g.fill();
    s -= 8; n -= 50;
  }
  while (n >= 10) { const [ax, ay] = at(s); g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + px * fx + ux * fy, ay + py * fx + uy * fy); g.stroke(); s -= 4; n -= 10; }
  if (n >= 5) { if (s === L) s -= 4; const [ax, ay] = at(s); g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + px * fx / 2 + ux * fy / 2, ay + py * fx / 2 + uy * fy / 2); g.stroke(); }
}

const ISOBARS = [1050, 1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 500, 400, 300, 250, 200, 150, 100];

export class SondeView {
  constructor(rc) {
    this.rc = rc;
    this.w = makeWindow('sd-win', 'Dropsonde Skew-T', () => this.close());
    this.w.querySelector('.rw-title').textContent = 'Dropsonde';
    const ctl = this.w.querySelector('.rw-ctl');
    ctl.innerHTML = `<button type="button" class="sd-nav" data-n="-1" title="Previous dropsonde" aria-label="Previous dropsonde">‹</button><span class="sd-sub"></span><button type="button" class="sd-nav" data-n="1" title="Next dropsonde" aria-label="Next dropsonde">›</button>`;
    for (const b of ctl.querySelectorAll('[data-n]')) b.onclick = () => this.step(+b.dataset.n);
    this.w.querySelector('.tc-body').innerHTML = `<div class="sd-grid"><div class="sd-plot"><canvas></canvas><div class="sd-read mono"></div></div><div class="sd-info"></div></div>`;
    this.cv = this.w.querySelector('canvas');
    this.cv.addEventListener('pointermove', (e) => this.hover(e));
    this.cv.addEventListener('pointerleave', () => { this.hp = null; this.paint(); });
    new ResizeObserver(() => { if (this.isOpen) this.draw(); }).observe(this.w.querySelector('.sd-plot'));
  }

  get isOpen() { return !this.w.classList.contains('hidden'); }

  open(d) {
    if (!d) return;
    this.d = d;
    this.an = analyze(d);
    this.w.classList.remove('hidden');
    this.info();
    this.draw();
    this.rc.highlight(d);
  }

  close() { this.w.classList.add('hidden'); this.rc.highlight(null); }

  step(n) {
    const all = this.rc.drops.filter((x) => x.levels?.length).sort((a, b) => a.t - b.t);
    const i = all.indexOf(this.d);
    const next = all[i + n];
    if (next) this.open(next);
  }

  info() {
    const d = this.d, a = this.an, q = (s) => this.w.querySelector(s);
    q('.sd-sub').textContent = `${d.ac}${d.storm ? ` · ${d.storm}` : ''} · ${day(d.t)} ${hm(d.t)}Z`;
    const all = this.rc.drops.filter((x) => x.levels?.length).sort((x, y) => x.t - y.t), i = all.indexOf(d);
    for (const b of this.w.querySelectorAll('.sd-nav')) b.disabled = !all[i + +b.dataset.n];
    const s = a.lv[0];
    const row = (k, v) => (v == null || v === '' ? '' : `<tr><th>${k}</th><td>${v}</td></tr>`);
    const loc = (x) => (x ? `${x.t ? `${hms(x.t)} · ` : ''}${ll(x.lat, x.lon)}` : null);
    const fall = d.rel?.t && d.spg?.t ? Math.round((d.spg.t - d.rel.t) / 1000) : null;
    const z = (v) => (v == null ? '' : ` · ${Math.round(v)} m`);
    const hum = (l) => (l?.rh != null ? ` · RH ${Math.round(l.rh)} %` : '');
    const kind = d.eye ? 'Eye / center drop' : d.eyewall ? 'Eyewall drop' : 'Dropsonde';
    q('.sd-info').innerHTML = `
      <table class="sd-tab">
        ${row('Type', `${kind}${d.ob ? ` · ob ${d.ob}` : ''}`)}
        ${row('Aircraft', `${esc(d.ac)} · mission ${esc(d.mission)}`)}
        ${row('Release', loc(d.rel) ? `${loc(d.rel)} · ${a.top} hPa` : null)}
        ${row('Splash', loc(d.spg))}
        ${row('Fall time', fall ? `${Math.floor(fall / 60)} min ${fall % 60} s` : null)}
        ${row('Surface', s?.surface ? `<b>${s.p} hPa</b> · ${fix(s.T)} / ${fix(s.Td)} °C${hum(s)}` : 'did not reach the surface')}
        ${row('Surface wind', s?.surface ? `<b>${windTxt(s)}</b>` : null)}
        ${row('Lowest 150 m mean', d.wl150 ? windTxt(d.wl150) : null)}
        ${row('Lowest 500 m mean', d.mbl ? windTxt(d.mbl) : null)}
        ${row('Deep-layer mean', d.dlm ? `${windTxt(d.dlm)} (${d.dlm.bot}–${d.dlm.top} hPa)` : null)}
        ${row('Strongest wind', a.maxw ? `<b>${windTxt(a.maxw)}</b> at ${a.maxw.p} hPa${z(a.maxw.z)}` : null)}
        ${row('LCL', a.lcl ? `${Math.round(a.lcl.p)} hPa · ${fix(a.lcl.T)} °C` : null)}
        ${row('CAPE / CIN', a.cape != null ? `${Math.round(a.cape)} / ${Math.round(a.cin)} J/kg${a.top > 250 ? ` (to ${a.top} hPa only)` : ''}` : null)}
        ${row('Precipitable water', a.pw != null ? `${a.pw.toFixed(1)} mm${a.pwTop > 300 ? ` (to ${a.pwTop} hPa only)` : ''}` : null)}
        ${row('Freezing level', a.frz ? `${Math.round(a.frz.z)} m · ${Math.round(a.frz.p)} hPa` : null)}
      </table>
      <details class="sd-levels"><summary>All ${a.lv.length} levels</summary>
        <table class="sd-tab sd-lv mono"><tr><th>hPa</th><th>m</th><th>°C</th><th>Td</th><th>RH</th><th>wind</th></tr>
        ${a.lv.map((l) => `<tr><td>${l.p}</td><td>${l.z ?? ''}</td><td>${l.T ?? ''}</td><td>${l.Td ?? ''}</td><td>${l.rh != null ? Math.round(l.rh) : ''}</td><td>${l.ws != null ? `${wdir(l.wd)} ${fmtWind(l.ws)}` : ''}</td></tr>`).join('')}</table></details>
      ${d.remarks ? `<div class="note">Remarks: ${esc(d.remarks)}</div>` : ''}
      <details class="sd-raw"><summary>Message as sent</summary><pre>${esc(d.raw || '')}</pre></details>`;
  }

  /** Geometry and the static background (grid, adiabats, profile) into an off-screen canvas. */
  draw() {
    const box = this.w.querySelector('.sd-plot'), dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.max(260, box.clientWidth), H = Math.max(260, Math.min(box.clientHeight || 520, W * 1.25));
    this.cv.width = W * dpr; this.cv.height = H * dpr;
    this.cv.style.width = `${W}px`; this.cv.style.height = `${H}px`;
    const a = this.an, m = { l: 40, r: 50, t: 10, b: 24 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const pBot = Math.max(1050, a.bot + 5), pTop = Math.max(100, Math.min(a.top - 25, 850));
    const Y = (p) => m.t + ph * (1 - Math.log(pBot / p) / Math.log(pBot / pTop));
    // 45° isotherms: the temperature span across the plot and the left edge fitted to the
    // temperature (and the low-level dew point); very dry layers aloft run off the left edge
    const yy = (p) => Math.log(pBot / p) / Math.log(pBot / pTop);
    let span = 60, left = 0;
    for (let it = 0; it < 4; it++) {
      const S = span * (ph / pw), xs = [];
      for (const l of a.lv) { if (l.T != null) xs.push(l.T + yy(l.p) * S); if (l.Td != null && l.p >= 700) xs.push(l.Td + yy(l.p) * S); }
      if (!xs.length) break;
      const lo = Math.min(...xs), hi = Math.max(...xs);
      span = Math.max(45, hi - lo + 24);
      left = lo - 14;
    }
    const S = span * (ph / pw);
    const X = (T, p) => m.l + ((T + yy(p) * S - left) / span) * pw;
    this.geo = { W, H, m, pw, ph, pBot, pTop, X, Y, dpr };
    const base = document.createElement('canvas');
    base.width = W * dpr; base.height = H * dpr;
    const g = base.getContext('2d');
    g.scale(dpr, dpr);
    g.save();
    g.beginPath(); g.rect(m.l, m.t, pw, ph); g.clip();
    const curve = (fn, color, width = 1, dash = null) => {
      g.beginPath(); g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash || []);
      let first = true;
      for (let k = 0; k <= 40; k++) {
        const p = Math.exp(Math.log(pBot) + (Math.log(pTop) - Math.log(pBot)) * (k / 40)), T = fn(p);
        if (T == null) { first = true; continue; }
        if (first) g.moveTo(X(T, p), Y(p)); else g.lineTo(X(T, p), Y(p));
        first = false;
      }
      g.stroke();
    };
    // isotherms, dry adiabats, moist adiabats, mixing-ratio lines
    for (let T = -120; T <= 50; T += 10) curve(() => T, T === 0 ? 'rgba(76,181,255,0.45)' : 'rgba(160,190,230,0.13)', 1);
    for (let th = 250; th <= 480; th += 10) curve((p) => th * (p / 1000) ** KAPPA - K, 'rgba(255,170,90,0.2)', 1);
    for (let T0 = -16; T0 <= 40; T0 += 4) curve((p) => moistTo(T0, 1000, p, 10), 'rgba(110,200,255,0.2)', 1, [5, 3]);
    for (const w of [1, 2, 4, 7, 10, 16, 24]) curve((p) => (p < 550 ? null : dewFromE(((w / 1000) * p) / (EPS + w / 1000))), 'rgba(120,230,150,0.22)', 1, [2, 3]);
    // the profile: parcel, dew point, temperature
    const prof = (arr, k, color, width, dash) => {
      g.beginPath(); g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash || []); g.lineJoin = 'round';
      let first = true;
      for (const l of arr) { if (l[k] == null) { continue; } const x = X(l[k], l.p), y = Y(l.p); if (first) g.moveTo(x, y); else g.lineTo(x, y); first = false; }
      g.stroke();
    };
    if (a.parcel) prof(a.parcel, 'T', 'rgba(233,238,246,0.75)', 1.4, [6, 4]);
    prof(a.tl, 'Td', '#4cd08a', 2.2);
    prof(a.tl, 'T', '#ff6b6b', 2.2);
    if (a.lcl) { const x = X(a.lcl.T, a.lcl.p), y = Y(a.lcl.p); g.setLineDash([]); g.strokeStyle = '#e9eef6'; g.lineWidth = 1; g.beginPath(); g.moveTo(x - 7, y); g.lineTo(x + 7, y); g.stroke(); g.fillStyle = '#c9d3e3'; g.font = '10px system-ui, sans-serif'; g.fillText('LCL', x + 9, y + 3); }
    g.restore();
    // frame, isobar labels (with heights), temperature labels
    g.strokeStyle = 'rgba(160,190,230,0.35)'; g.lineWidth = 1; g.setLineDash([]);
    g.strokeRect(m.l, m.t, pw, ph);
    g.font = '10px system-ui, sans-serif'; g.fillStyle = '#8a96a9';
    for (const p of ISOBARS) {
      if (p > pBot || p < pTop) continue;
      const y = Y(p);
      g.strokeStyle = 'rgba(160,190,230,0.16)'; g.beginPath(); g.moveTo(m.l, y); g.lineTo(m.l + pw, y); g.stroke();
      g.textAlign = 'right'; g.fillText(String(p), m.l - 4, y + 3.5);
      const z = interp(a.lv.filter((l) => l.z != null), p, 'z');
      if (z != null && p <= a.bot && (p % 100 === 0 || p === 925 || p === 250)) { g.textAlign = 'left'; g.fillText(`${(z / 1000).toFixed(1)} km`, m.l + 3, y - 2); }
    }
    g.textAlign = 'center';
    for (let T = -100; T <= 50; T += 10) { const x = X(T, pBot); if (x > m.l + 8 && x < m.l + pw - 8) g.fillText(`${T}°`, x, m.t + ph + 14); }
    // wind barbs in the right margin, at least 16 px apart
    g.strokeStyle = '#e9eef6'; g.fillStyle = '#e9eef6'; g.lineWidth = 1.3;
    let lastY = Infinity;
    for (const l of a.lv) {
      if (l.ws == null || l.wd == null || l.p < pTop || l.p > pBot) continue;
      const y = Y(l.p);
      if (lastY - y < 16) continue;
      barb(g, m.l + pw + 26, y, l.wd, l.ws, 20);
      lastY = y;
    }
    this.base = base;
    this.paint();
  }

  /** Background + the hover line and its readout. */
  paint() {
    if (!this.base) return;
    const g = this.cv.getContext('2d'), { m, pw, Y, dpr } = this.geo;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.cv.width, this.cv.height);
    g.drawImage(this.base, 0, 0);
    const r = this.w.querySelector('.sd-read');
    if (!this.hp) { r.innerHTML = '<span style="color:#ff6b6b">━</span> temperature <span style="color:#4cd08a">━</span> dew point <span>╌</span> surface parcel'; return; }
    g.scale(dpr, dpr);
    const y = Y(this.hp);
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(m.l, y); g.lineTo(m.l + pw, y); g.stroke(); g.setLineDash([]);
    const a = this.an, p = this.hp, T = interp(a.tl, p, 'T'), Td = interp(a.tl, p, 'Td'), z = interp(a.lv.filter((l) => l.z != null), p, 'z');
    const wl = a.lv.filter((l) => l.ws != null).reduce((b, l) => (!b || Math.abs(l.p - p) < Math.abs(b.p - p) ? l : b), null);
    r.innerHTML = [`<b>${Math.round(p)} hPa</b>`, z != null ? `${Math.round(z)} m` : '', T != null ? `T ${T.toFixed(1)} °C` : '', Td != null ? `Td ${Td.toFixed(1)} °C` : '',
      T != null && Td != null ? `RH ${Math.round(Math.min(100, (100 * es(Td)) / es(T)))} %` : '', T != null ? `θ ${theta(T, p).toFixed(1)} K` : '',
      wl && Math.abs(wl.p - p) < 25 ? `wind ${windTxt(wl)} (${wl.p} hPa)` : ''].filter(Boolean).join(' · ');
  }

  hover(e) {
    if (!this.geo) return;
    const { m, ph, pBot, pTop } = this.geo, r = this.cv.getBoundingClientRect(), y = e.clientY - r.top;
    if (y < m.t || y > m.t + ph) { this.hp = null; this.paint(); return; }
    this.hp = pBot * (pTop / pBot) ** ((m.t + ph - y) / ph);
    this.paint();
  }
}
