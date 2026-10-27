/* Ensemble intensity charts of one storm (opened from the model-track controls; the same file
 * serves both editions): maximum wind with the Saffir-Simpson thresholds, the members' intensity
 * distribution over time, and minimum pressure. Any number of the loaded ensembles at once;
 * wind and pressure each show members, mean, median and spread (10th-90th percentile) or not.
 * Times are valid times, so runs of different hours line up. */
import { CATS, category } from './overlays.js';

const H = 3600e3;
const p2 = (n) => String(n).padStart(2, '0');
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtT = (t) => { const d = new Date(t); return `${DAYS[d.getUTCDay()]} ${p2(d.getUTCDate())} ${MONS[d.getUTCMonth()]} ${p2(d.getUTCHours())}Z`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (sorted, q) => { const i = (sorted.length - 1) * q, lo = Math.floor(i); return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo); };

/** Wind and pressure statistics of a storm's members at each forecast hour, while at least 40 %
 *  of them (two at least) still carry it (the rule of the map's mean / median tracks). */
export function intensity(members) {
  const tracks = [...members.values()];
  const need = Math.max(2, Math.ceil(tracks.length * 0.4));
  const byTau = new Map();
  for (const pts of tracks) for (const p of pts) (byTau.get(p.tau) || byTau.set(p.tau, []).get(p.tau)).push(p);
  const out = [];
  const f = (vals) => {
    if (!vals.length) return null;
    const s = vals.sort((a, b) => a - b);
    return { mean: mean(s), med: pct(s, 0.5), lo: pct(s, 0.1), hi: pct(s, 0.9) };
  };
  for (const tau of [...byTau.keys()].sort((a, b) => a - b)) {
    const ps = byTau.get(tau);
    if (ps.length < need) break;
    out.push({ tau, n: ps.length, kt: f(ps.map((p) => p.kt).filter((v) => v != null)), mb: f(ps.map((p) => p.mb).filter((v) => v != null)) });
  }
  return out;
}

const SHOW = () => ({ members: true, mean: true, median: false, spread: true });
const DEFAULTS = { open: false, models: ['ecmwf', 'gefs'], storm: null, dist: null, wind: SHOW(), pres: { ...SHOW(), members: false } };
const GONE = '#3d434e';
const M = { l: 40, r: 46, t: 8, b: 22 };

export class TrackChart {
  /** tracks: the ModelTracks (its runs, groups, status, state); models: its model list. */
  constructor(tracks, models) {
    this.tr = tracks;
    this.MODELS = models;
    this.M = Object.fromEntries(models.map((m) => [m.id, m]));
    const c = tracks.st.chart && typeof tracks.st.chart === 'object' ? tracks.st.chart : {};
    this.c = tracks.st.chart = { ...DEFAULTS, ...c, wind: { ...DEFAULTS.wind, ...c.wind }, pres: { ...DEFAULTS.pres, ...c.pres } };
    this.c.models = (Array.isArray(this.c.models) ? this.c.models : DEFAULTS.models).filter((m) => this.M[m]);
    this.build();
    if (this.c.open) this.open();
  }

  get isOpen() { return this.c.open; }

  build() {
    const tog = (v) => ['members', 'mean', 'median', 'spread'].map((k) => `<button type="button" data-v="${v}" data-k="${k}">${k[0].toUpperCase()}${k.slice(1)}</button>`).join('');
    const w = document.createElement('div');
    w.className = 'tc-win hidden';
    w.setAttribute('role', 'dialog');
    w.setAttribute('aria-label', 'Ensemble intensity charts');
    w.innerHTML = `
      <header class="tc-head">
        <b>Ensemble intensity</b>
        <select class="tc-storm" aria-label="Storm"></select>
        <button type="button" class="tc-close" title="Close (Esc)" aria-label="Close">×</button>
      </header>
      <div class="tc-models">${this.MODELS.map((m) => `<button type="button" data-m="${m.id}" title="${esc(m.name)}"><i style="background:${m.color}"></i>${esc(m.short)}</button>`).join('')}</div>
      <div class="tc-key"><span><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" stroke="#c9d3e3" stroke-width="2.4"/></svg>mean</span>
        <span><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" stroke="#c9d3e3" stroke-width="2" stroke-dasharray="5 3"/></svg>median</span>
        <span><i class="tc-band"></i>10–90 % spread</span><span><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" stroke="#c9d3e3" stroke-width="0.8" opacity=".6"/></svg>members</span></div>
      <div class="tc-body">
        <div class="tc-sec"><div class="tc-title"><b>Maximum wind (kt)</b><span class="tc-tog">${tog('wind')}</span></div><div class="tc-plot" data-p="wind"></div></div>
        <div class="tc-sec"><div class="tc-title"><b>Intensity distribution</b><select class="tc-dist" aria-label="Ensemble"></select></div><div class="tc-plot" data-p="dist"></div><div class="tc-cats"></div></div>
        <div class="tc-sec"><div class="tc-title"><b>Minimum pressure (hPa)</b><span class="tc-tog">${tog('pres')}</span></div><div class="tc-plot" data-p="pres"></div></div>
        <div class="tc-status"></div>
      </div>
      <div class="tc-tip hidden"></div>`;
    document.body.appendChild(w);
    this.w = w;
    const q = (s) => w.querySelector(s);
    q('.tc-close').onclick = () => this.close();
    q('.tc-storm').onchange = (e) => { this.c.storm = e.target.value; this.save(); this.draw(); };
    q('.tc-dist').onchange = (e) => { this.c.dist = e.target.value; this.save(); this.draw(); };
    for (const b of w.querySelectorAll('.tc-models [data-m]')) {
      b.onclick = () => {
        const m = b.dataset.m, i = this.c.models.indexOf(m);
        if (i >= 0) this.c.models.splice(i, 1); else this.c.models.push(m);
        this.save(); this.sync(); this.tr.load();
        this.draw();
      };
    }
    for (const b of w.querySelectorAll('.tc-tog [data-k]')) b.onclick = () => { const o = this.c[b.dataset.v]; o[b.dataset.k] = !o[b.dataset.k]; this.save(); this.sync(); this.draw(); };
    q('.tc-cats').innerHTML = [...CATS].reverse().map((c) => `<span><i style="background:${c.color}"></i>${c.id === 'td' ? 'TD' : c.id === 'ts' ? 'TS' : c.label}</span>`).join('') + `<span><i style="background:${GONE}"></i>no storm</span>`;
    // drag by the header (wide screens; on phones the window fills the screen)
    q('.tc-head').addEventListener('pointerdown', (e) => {
      if (e.target.closest('select, button') || innerWidth < 700) return;
      const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => { w.style.left = `${Math.max(0, Math.min(innerWidth - 120, ev.clientX - dx))}px`; w.style.top = `${Math.max(0, Math.min(innerHeight - 60, ev.clientY - dy))}px`; };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.c.open && !e.target.matches?.('input, select, textarea')) this.close(); });
    new ResizeObserver(() => { if (this.c.open) this.draw(); }).observe(q('.tc-body'));
    q('.tc-body').addEventListener('pointermove', (e) => this.hover(e));
    q('.tc-body').addEventListener('pointerleave', () => this.unhover());
    this.sync();
  }

  save() { this.tr.changed(); }

  open(storm) {
    if (storm) this.c.storm = storm;
    this.c.open = true;
    this.w.classList.remove('hidden');
    this.save();
    this.tr.load();
    this.update();
  }

  close() {
    this.c.open = false;
    this.w.classList.add('hidden');
    this.unhover();
    this.save();
  }

  sync() {
    for (const b of this.w.querySelectorAll('.tc-models [data-m]')) b.classList.toggle('on', this.c.models.includes(b.dataset.m));
    for (const b of this.w.querySelectorAll('.tc-tog [data-k]')) b.classList.toggle('on', !!this.c[b.dataset.v][b.dataset.k]);
  }

  /** New runs or storms: refill the pickers and redraw. */
  update() {
    if (!this.c.open) return;
    const groups = this.tr.groups.filter((g) => !g.genesis || this.tr.st.genesis || g.id === this.c.storm);
    const sel = this.w.querySelector('.tc-storm');
    if (!groups.some((g) => g.id === this.c.storm)) {
      const panel = this.tr.st.storm;
      this.c.storm = groups.some((g) => g.id === panel) ? panel : this.strongest(groups)?.id ?? this.c.storm;
    }
    sel.innerHTML = groups.length ? groups.map((g) => `<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('') : '<option value="">No storms loaded</option>';
    if (this.c.storm) sel.value = this.c.storm;
    this.draw();
  }

  strongest(groups) {
    let best = null, kt = -1;
    for (const g of groups) {
      if (g.genesis) continue;
      for (const s of g.models.values()) {
        const k = Math.max(...[...s.members.values()].map((p) => p[0]?.kt ?? 0));
        if (k > kt) { kt = k; best = g; }
      }
    }
    return best || groups[0];
  }

  /** The selected ensembles' runs of the chosen storm: [{m, model, t0, s, ser, members}]. */
  series() {
    const g = this.tr.groups.find((x) => x.id === this.c.storm);
    const out = [];
    for (const m of this.MODELS.map((x) => x.id)) {
      if (!this.c.models.includes(m)) continue;
      const s = g?.models.get(m), run = this.tr.runs.get(m);
      if (!s || !run) continue;
      s.inten = s.inten || intensity(s.members);
      out.push({ m, model: this.M[m], t0: run.t, s, ser: s.inten, members: [...s.members.values()] });
    }
    return { g, out };
  }

  draw() {
    if (!this.c.open) return;
    const { g, out } = this.series();
    this.cur = { g, out };
    const q = (s) => this.w.querySelector(s);
    // status: models that are loading, unavailable or without this storm
    q('.tc-status').innerHTML = this.c.models.map((m) => {
      const st = this.tr.status.get(m), have = out.some((o) => o.m === m);
      const text = have ? `${out.find((o) => o.m === m).s.members.size} members` : st && st.state !== 'ok' ? st.text : g ? 'no track of this storm' : '';
      return `<div class="mt-st ${have ? 'ok' : st?.state || ''}"><i style="background:${this.M[m].color}"></i>${esc(this.M[m].name)}: ${esc(text)}</div>`;
    }).join('') + (this.c.models.length ? '' : '<div class="mt-st">Pick one or more ensembles above.</div>');
    // the distribution's ensemble: one of the shown
    const dsel = q('.tc-dist');
    dsel.innerHTML = out.map((o) => `<option value="${o.m}">${esc(o.model.name)}</option>`).join('');
    if (!out.some((o) => o.m === this.c.dist)) this.c.dist = out[0]?.m ?? null;
    if (this.c.dist) dsel.value = this.c.dist;
    dsel.disabled = out.length < 2;
    const plots = { wind: q('[data-p=wind]'), dist: q('[data-p=dist]'), pres: q('[data-p=pres]') };
    if (!out.length) {
      for (const p of Object.values(plots)) p.innerHTML = '<div class="tc-empty">No data</div>';
      this.x = null;
      return;
    }
    // shared time axis: the earliest run to the last member's last hour
    const t0 = Math.min(...out.map((o) => o.t0));
    const t1 = Math.max(...out.map((o) => o.t0 + Math.max(...o.members.map((p) => p[p.length - 1]?.tau || 0)) * H));
    const W = Math.max(280, plots.wind.clientWidth);
    const x = (t) => M.l + ((t - t0) / Math.max(H, t1 - t0)) * (W - M.l - M.r);
    this.x = { t0, t1, W, inv: (px) => t0 + ((px - M.l) / (W - M.l - M.r)) * (t1 - t0) };
    let kmax = 0, pmin = 1010, pmax = 1012;
    for (const o of out) for (const p of o.members.flat()) {
      if (p.kt != null) kmax = Math.max(kmax, p.kt);
      if (p.mb != null) { pmin = Math.min(pmin, p.mb); pmax = Math.max(pmax, p.mb); }
    }
    plots.wind.innerHTML = this.line('kt', out, { W, h: 230, x, y0: 0, y1: Math.max(100, Math.ceil((kmax + 10) / 25) * 25), step: 25, t0, t1 });
    plots.pres.innerHTML = this.line('mb', out, { W, h: 210, x, y0: Math.floor((pmin - 5) / 10) * 10, y1: Math.ceil((pmax + 2) / 5) * 5, step: pmax - pmin > 60 ? 20 : 10, t0, t1 });
    plots.dist.innerHTML = this.dist(out.find((o) => o.m === this.c.dist) || out[0], { W, h: 180, x, t0, t1 });
  }

  /** Time axis: a tick and label per day (every other day when crowded). */
  axis(W, h, x, t0, t1) {
    let s = '';
    const days = [];
    for (let t = Math.ceil(t0 / (24 * H)) * 24 * H; t <= t1; t += 24 * H) days.push(t);
    const every = (W - M.l - M.r) / Math.max(1, days.length) < 44 ? 2 : 1;
    days.forEach((t, i) => {
      const px = x(t);
      s += `<line x1="${px}" y1="${M.t}" x2="${px}" y2="${h - M.b}" class="tc-grid"/>`;
      if (i % every === 0) { const d = new Date(t); s += `<text x="${px}" y="${h - 6}" text-anchor="middle" class="tc-ax">${MONS[d.getUTCMonth()]} ${d.getUTCDate()}</text>`; }
    });
    // the map's "Through" hour, for each run time shown
    const hour = +this.tr.st.hour;
    if (hour < 384) {
      for (const r of new Set(this.cur.out.map((o) => o.t0))) {
        const px = x(r + hour * H);
        if (px >= M.l && px <= W - M.r) s += `<line x1="${px}" y1="${M.t}" x2="${px}" y2="${h - M.b}" class="tc-thru"/><text x="${px + 3}" y="${M.t + 9}" class="tc-ax">+${hour} h</text>`;
      }
    }
    return s;
  }

  line(v, out, { W, h, x, y0, y1, step, t0, t1 }) {
    const y = (val) => M.t + (1 - (val - y0) / (y1 - y0)) * (h - M.t - M.b);
    const show = this.c[v === 'kt' ? 'wind' : 'pres'];
    let s = '';
    for (let val = Math.ceil(y0 / step) * step; val <= y1; val += step) {
      s += `<line x1="${M.l}" y1="${y(val)}" x2="${W - M.r}" y2="${y(val)}" class="tc-grid"/><text x="${M.l - 5}" y="${y(val) + 3.5}" text-anchor="end" class="tc-ax">${val}</text>`;
    }
    s += this.axis(W, h, x, t0, t1);
    if (v === 'kt') {
      // Saffir-Simpson thresholds, labelled at the right
      for (let i = 0; i < CATS.length - 1; i++) {
        const c = CATS[i], k = c.max, py = y(k);
        if (k > y1) break;
        const next = CATS[i + 1];
        s += `<line x1="${M.l}" y1="${py}" x2="${W - M.r}" y2="${py}" stroke="${next.color}" class="tc-cat"/><text x="${W - M.r + 4}" y="${py + 3.5}" fill="${next.color}" class="tc-catl">${next.id === 'ts' ? 'TS' : next.label}</text>`;
      }
    }
    const path = (pts) => {
      let d = '', pen = false;
      for (const [t, val] of pts) {
        if (val == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)} ${y(val).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    for (const o of out) {
      const col = o.model.color, at = (tau) => o.t0 + tau * H;
      if (show.spread) {
        const ok = o.ser.filter((p) => p[v]);
        if (ok.length > 1) {
          const top = ok.map((p) => `${x(at(p.tau)).toFixed(1)} ${y(p[v].hi).toFixed(1)}`), bot = ok.map((p) => `${x(at(p.tau)).toFixed(1)} ${y(p[v].lo).toFixed(1)}`).reverse();
          s += `<path d="M${top.join('L')}L${bot.join('L')}Z" fill="${col}" fill-opacity="0.17" stroke="none"/>`;
        }
      }
      if (show.members) {
        s += `<g stroke="${col}" stroke-width="0.8" stroke-opacity="0.42" fill="none">${o.members.map((pts) => `<path d="${path(pts.map((p) => [at(p.tau), p[v]]))}"/>`).join('')}</g>`;
      }
      if (show.mean) s += `<path d="${path(o.ser.map((p) => [at(p.tau), p[v]?.mean]))}" stroke="${col}" stroke-width="2.6" fill="none" stroke-linejoin="round"/>`;
      if (show.median) s += `<path d="${path(o.ser.map((p) => [at(p.tau), p[v]?.med]))}" stroke="${col}" stroke-width="2" stroke-dasharray="5 3" fill="none"/>`;
    }
    return `<svg width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" class="tc-svg">${s}</svg><div class="tc-cursor hidden"></div>`;
  }

  /** Members per intensity class at each hour, stacked (strongest at the bottom); the rest of
   *  the ensemble (dissipated, lost by the tracker, no wind) in grey on top. */
  dist(o, { W, h, x, t0, t1 }) {
    const N = o.members.length, at = (tau) => o.t0 + tau * H;
    const taus = [...new Set(o.members.flat().map((p) => p.tau))].sort((a, b) => a - b);
    const order = [...CATS].reverse();          // c5 ... td
    const rows = taus.map((tau) => {
      const n = order.map(() => 0);
      for (const pts of o.members) {
        const p = pts.find((q) => q.tau === tau);
        if (p && p.kt != null) n[order.indexOf(category(p.kt))]++;
      }
      return n;
    });
    this.distRows = { o, taus, rows, N };
    const y = (c) => M.t + (1 - c / N) * (h - M.t - M.b);
    let s = '';
    const step = N > 40 ? 10 : 5;
    for (let c = 0; c <= N; c += step) s += `<line x1="${M.l}" y1="${y(c)}" x2="${W - M.r}" y2="${y(c)}" class="tc-grid"/><text x="${M.l - 5}" y="${y(c) + 3.5}" text-anchor="end" class="tc-ax">${c}</text>`;
    s += `<text x="${W - M.r + 4}" y="${y(N) + 3.5}" class="tc-ax">${N}</text>`;
    if (taus.length > 1) {
      const xs = taus.map((tau) => x(at(tau)).toFixed(1));
      let below = taus.map(() => 0);
      for (let k = 0; k <= order.length; k++) {
        const above = below.map((b, i) => b + (k < order.length ? rows[i][k] : N - b));
        const top = above.map((c, i) => `${xs[i]} ${y(c).toFixed(1)}`), bot = below.map((c, i) => `${xs[i]} ${y(c).toFixed(1)}`).reverse();
        const col = k < order.length ? order[k].color : GONE;
        s += `<path d="M${top.join('L')}L${bot.join('L')}Z" fill="${col}" fill-opacity="${k < order.length ? 0.62 : 0.55}" stroke="${col}" stroke-width="0.8"/>`;
        below = above;
      }
    }
    s += this.axis(W, h, x, t0, t1);
    return `<svg width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" class="tc-svg">${s}</svg><div class="tc-cursor hidden"></div>`;
  }

  // crosshair over all three charts + a readout of the nearest 6-hourly time
  hover(e) {
    if (!this.x || !this.cur?.out.length) return;
    const plot = this.w.querySelector('[data-p=wind]'), r = plot.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < M.l || px > this.x.W - M.r) { this.unhover(); return; }
    const ref = this.cur.out[0].t0, t = ref + Math.round((this.x.inv(px) - ref) / (6 * H)) * 6 * H;
    const cx = M.l + ((t - this.x.t0) / Math.max(H, this.x.t1 - this.x.t0)) * (this.x.W - M.l - M.r);
    for (const c of this.w.querySelectorAll('.tc-cursor')) { c.style.left = `${cx}px`; c.classList.remove('hidden'); }
    const f = (v, d = 0) => (v == null ? '–' : v.toFixed(d));
    let h = `<b>${fmtT(t)}</b>`;
    for (const o of this.cur.out) {
      const tau = (t - o.t0) / H, p = o.ser.find((q) => q.tau === tau);
      h += `<div><i style="background:${o.model.color}"></i><b>${esc(o.model.short)}</b> +${tau} h · `;
      if (!p) { h += 'no ensemble value'; continue; }
      const cat = p.kt ? category(p.kt.mean) : null;
      h += `${f(p.kt?.mean)} kt${cat ? ` (${cat.id === 'td' ? 'TD' : cat.id === 'ts' ? 'TS' : cat.label})` : ''}, median ${f(p.kt?.med)}, ${f(p.kt?.lo)}–${f(p.kt?.hi)} · ${f(p.mb?.mean)} hPa (${f(p.mb?.lo)}–${f(p.mb?.hi)}) · ${p.n}/${o.members.length}</div>`;
    }
    const d = this.distRows;
    if (d) {
      const i = d.taus.indexOf((t - d.o.t0) / H);
      if (i >= 0) {
        const order = [...CATS].reverse(), n = d.rows[i];
        const parts = order.map((c, k) => (n[k] ? `${c.id === 'td' ? 'TD' : c.id === 'ts' ? 'TS' : c.label} ${n[k]}` : '')).filter(Boolean);
        const gone = d.N - n.reduce((a, b) => a + b, 0);
        h += `<div class="tc-tipd">${esc(d.o.model.short)}: ${parts.join(' · ') || '—'}${gone ? ` · no storm ${gone}` : ''}</div>`;
      }
    }
    const tip = this.w.querySelector('.tc-tip'), wr = this.w.getBoundingClientRect();
    tip.innerHTML = h;
    tip.classList.remove('hidden');
    const left = e.clientX - wr.left + 16;
    tip.style.left = `${Math.max(6, left + tip.offsetWidth > wr.width - 6 ? e.clientX - wr.left - tip.offsetWidth - 16 : left)}px`;
    tip.style.top = `${Math.min(wr.height - tip.offsetHeight - 6, e.clientY - wr.top + 12)}px`;
  }

  unhover() {
    for (const c of this.w.querySelectorAll('.tc-cursor')) c.classList.add('hidden');
    this.w.querySelector('.tc-tip').classList.add('hidden');
  }
}
