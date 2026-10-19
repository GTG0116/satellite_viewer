/* 3D cloud volume: the map-side tools (box / area / whole view, editable handles, the 3D camera's
 * footprint) and the bridge to the three.js volume renderer (render3d.js), whose cloud fields
 * are retrieved in a worker from the satellite bands inside the region. */
import { destPoint, emptyFC } from './map.js';

const $ = (id) => document.getElementById(id);
const wrapLng = (a, ref) => { while (a - ref > 180) a -= 360; while (a - ref < -180) a += 360; return a; };
const clampLat = (y) => Math.max(-80, Math.min(80, y));
const ringBBox = (ring) => { const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };

export class Volume {
  /**
   * host: { satMap, toast(msg, kind, ms), currentFrame(), loopFrames() -> [{time, sceneId}], showFrameAt(time),
   *         fields(region, progress) -> Promise<fields>, satName(), productName(), tier, onLayout() }
   */
  constructor(host) {
    this.h = host; this.on = false; this.region = null; this.tool = null; this.area = []; this.cam = null; this.drag = null;
    this.viewer = null;
    const map = host.satMap.map;
    this.map = map;
    map.on('mousedown', (e) => this._down(e));
    map.on('touchstart', (e) => { if (e.points.length === 1) this._down(e); });
    map.on('mousemove', (e) => this._move(e));
    map.on('touchmove', (e) => this._move(e));
    map.on('mouseup', (e) => this._up(e));
    map.on('touchend', (e) => this._up(e));
    map.on('click', (e) => { if (this.tool === 'area') this._areaClick(e); });
    map.on('dblclick', (e) => { if (this.tool === 'area') { e.preventDefault(); this._finishArea(); } });
    for (const b of $('volBar').querySelectorAll('[data-t]')) b.onclick = () => this.toolBtn(b.dataset.t);
  }

  async enter() {
    if (!this.h.currentFrame()) { this.h.toast('Wait for a frame to load first', 'info', 3000); return; }
    if (!this.on) {
      let mod;
      try { mod = await import('./render3d.js'); } catch (e) { this.h.toast(`3D renderer unavailable: ${e.message}`); return; }
      this.on = true;
      try { const w = localStorage.getItem('satview.3d.width'); if (w) document.documentElement.style.setProperty('--r3d-w', w); } catch (_) { /* ignore */ }
      document.body.classList.add('r3d-split');
      const low = this.h.tier.name === 'low';
      this.viewer = mod.openPane({
        defaults: low ? { quality: 'draft' } : this.h.tier.name === 'medium' ? { quality: 'standard' } : {},
        lowPower: low, maxTex: low ? 2048 : 4096,
        fields: (r, progress) => this.h.fields(r, progress),
        onClose: () => this.exit(),
        onCancel: () => { if (this.region) this.setTool(null); else this.exit(); },
        onNewBox: () => this.setTool('box'),
        onWindow: (max) => { document.body.classList.toggle('r3d-max', max); this._resize(); },
        onLayout: () => this._resize(),
        onCamera: (c) => { this.cam = c; this.drawCamera(); },
        onFrame: (t) => this.h.showFrameAt(t),
        getFrames: () => this.h.loopFrames(),
      });
      $('volBar').classList.remove('hidden');
      $('volBtn')?.classList.add('active');
      this._resize();
    }
    this.setTool(this.region ? null : 'box');
  }

  exit() {
    if (!this.on) return;
    this.on = false;
    this.setTool(null);
    clearTimeout(this.frameT);
    if (this.viewer) this.viewer.close();
    this.viewer = null; this.region = null; this.cam = null; this.drag = null; this.applied = null;
    document.body.classList.remove('r3d-split', 'r3d-max');
    $('volBar').classList.add('hidden');
    $('volBtn')?.classList.remove('active');
    this.drawRegion(); this.drawCamera();
    this._resize();
  }

  _resize() { setTimeout(() => { this.map.resize(); this.h.onLayout?.(); }, 30); }

  toolBtn(t) {
    if (t === 'exit') this.exit();
    else if (t === 'clear') this.clear();
    else if (t === 'view') this.wholeView();
    else this.setTool(this.tool === t ? null : t);
  }

  hint(html) { $('drawHint').innerHTML = html || ''; $('drawHint').classList.toggle('hidden', !html); }

  setTool(t) {
    this.tool = t; this.area = []; this.boxStart = null;
    for (const b of $('volBar').querySelectorAll('[data-t]')) b.classList.toggle('on', b.dataset.t === t);
    this.h.satMap.setGeo('r3ddraw', null);
    this.map.doubleClickZoom[t === 'area' ? 'disable' : 'enable']();
    this.map.getCanvas().style.cursor = t ? 'crosshair' : '';
    if (t === 'box') this.hint('Drag a box over the clouds (20–1500 km) · <kbd>Esc</kbd> to cancel');
    else if (t === 'area') this.hint('Tap / click corners · double-click or tap the first corner to finish');
    else this.hint(null);
    if (t) this.map.dragPan.disable(); else this.map.dragPan.enable();
    if (this.viewer && !this.region) this.viewer.setWaiting(t === 'area' ? 'Draw an area around the clouds' : null);
    this.drawRegion();
  }

  check(w, s, e, n) {
    const kmW = (e - w) * 111.32 * Math.cos(((s + n) / 2) * Math.PI / 180), kmH = (n - s) * 110.57;
    if (kmW < 20 || kmH < 20) return 'Too small for a 3D view — make it at least ~20 km across';
    if (kmW > 1500 || kmH > 1500 || e - w > 20 || n - s > 16) return 'Too large for a 3D view — keep it under ~1500 km';
    return null;
  }

  setBox(w, s, e, n) {
    const err = this.check(w, s, e, n);
    if (err) { this.h.toast(err, 'info', 3500); this.drawRegion(); if (!this.region) this.setTool('box'); return; }
    this.region = { type: 'box', ring: [[w, s], [e, s], [e, n], [w, n]] };
    this.apply();
  }

  wholeView() {
    this.setTool(null);
    const b = this.map.getBounds(), c = this.map.getCenter();
    let w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    const ix = (e - w) * 0.03, iy = (n - s) * 0.03;
    w += ix; e -= ix; s += iy; n -= iy;
    const kx = 111.32 * Math.cos(c.lat * Math.PI / 180);
    if ((e - w) * kx > 1500 || (n - s) * 110.57 > 1500 || e - w > 20 || n - s > 16) {
      const hw = Math.min(700 / kx, 9.5, (e - w) / 2), hh = Math.min(700 / 110.57, 7.5, (n - s) / 2);
      w = c.lng - hw; e = c.lng + hw; s = Math.max(-80, c.lat - hh); n = Math.min(80, c.lat + hh);
      this.h.toast('The map view is larger than a 3D view can hold — using its central part', 'info', 3500);
    }
    this.setBox(w, s, e, n);
  }

  _finishArea() {
    const pts = [];
    for (const p of this.area) { const q = pts[pts.length - 1]; if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) pts.push(p); }
    if (pts.length < 3) { this.h.toast('An area needs at least three corners', 'info', 3000); return; }
    const [w, s, e, n] = ringBBox(pts);
    const err = this.check(w, s, e, n);
    if (err) { this.h.toast(err, 'info', 3500); this.area = []; this.h.satMap.setGeo('r3ddraw', null); return; }
    this.setTool(null);
    this.region = { type: 'area', ring: pts };
    this.apply();
  }

  _areaClick(e) {
    const ll = [e.lngLat.lng, e.lngLat.lat];
    if (this.area.length) {
      ll[0] = wrapLng(ll[0], this.area[0][0]);
      if (this.area.length >= 3) {
        const p0 = this.map.project(this.area[0]);
        if (Math.hypot(p0.x - e.point.x, p0.y - e.point.y) < 14) { this._finishArea(); return; }
      }
    }
    this.area.push(ll);
    this._areaPreview(null);
  }

  _areaPreview(ll) {
    const pts = this.area.slice();
    if (ll && pts.length) pts.push([wrapLng(ll.lng, pts[0][0]), ll.lat]);
    const feats = this.area.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
    if (pts.length > 1) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.length > 2 ? [...pts, pts[0]] : pts } });
    this.h.satMap.setGeo('r3ddraw', { type: 'FeatureCollection', features: feats });
  }

  apply() {
    this.drawRegion();
    const r = this.region, f = this.h.currentFrame();
    if (!r || !this.viewer || !f) return;
    const [w, s, e, n] = ringBBox(r.ring);
    const norm = (x) => ((x + 540) % 360) - 180, shift = norm(w) - w;
    this.applied = f.id;
    const sm = this.h.satMap;
    this.viewer.setRegion({
      sceneId: f.id, time: f.time.toISOString(), bbox: [w + shift, s, e + shift, n],
      polygon: r.type === 'area' ? r.ring.map(([x, y]) => [x + shift, y]) : null,
      satName: this.h.satName(), productName: this.h.productName(),
      prodTile: (z, x, y) => sm.frameTile(f, z, x, y), prodTileSize: sm.tileSize, prodMaxZoom: sm._maxzoom(f),
    });
  }

  clear() {
    this.setTool(null);
    this.region = null; this.applied = null;
    if (this.viewer) this.viewer.clearRegion();
    this.drawRegion();
  }

  /** The map's shown frame changed: rebuild the 3D view for it unless the 3D view plays its own loop. */
  frameChanged(playing) {
    if (!this.on || !this.region || !this.viewer) return;
    clearTimeout(this.frameT);
    this.frameT = setTimeout(() => {
      const f = this.h.currentFrame(), v = this.viewer;
      if (!f || !v || playing() || v.playing || v.params.framesMode !== 'single' || f.id === this.applied) return;
      this.apply();
    }, 700);
  }

  drawRegion() {
    const sm = this.h.satMap, r = this.on ? this.region : null;
    if (!r) { if (!this.boxStart) sm.setGeo('r3dbox', null); sm.setGeo('r3dhandles', null); return; }
    sm.setGeo('r3dbox', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...r.ring, r.ring[0]]] } }] });
    if (this.tool) { sm.setGeo('r3dhandles', null); return; }
    const [w, s, e, n] = ringBBox(r.ring);
    const hs = r.ring.map((p, i) => ({ type: 'Feature', properties: { kind: 'v', i }, geometry: { type: 'Point', coordinates: p } }));
    hs.push({ type: 'Feature', properties: { kind: 'c' }, geometry: { type: 'Point', coordinates: [(w + e) / 2, (s + n) / 2] } });
    sm.setGeo('r3dhandles', { type: 'FeatureCollection', features: hs });
  }

  drawCamera() {
    const sm = this.h.satMap, c = this.on ? this.cam : null;
    if (!c) { sm.setGeo('r3dcam', null); return; }
    const p0 = [c.lon, c.lat], feats = [];
    if (!c.down) {
      const ring = [p0], half = Math.min(c.hfov, 170) / 2;
      for (let i = 0; i <= 12; i++) { const q = destPoint(p0, c.heading - half + (2 * half) * i / 12, c.range); q[0] = wrapLng(q[0], c.lon); ring.push(q); }
      ring.push(p0);
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    feats.push({ type: 'Feature', properties: { kind: 'cam' }, geometry: { type: 'Point', coordinates: p0 } });
    sm.setGeo('r3dcam', { type: 'FeatureCollection', features: feats });
  }

  _hit(point) {
    if (!this.on) return null;
    const r = 12, box = [[point.x - r, point.y - r], [point.x + r, point.y + r]];
    const layers = ['r3dcam-pt', 'r3dhandles'].filter((l) => this.map.getLayer(l));
    const hits = this.map.queryRenderedFeatures(box, { layers });
    if (hits.find((h) => h.layer.id === 'r3dcam-pt')) return { kind: 'cam' };
    const h = hits.find((x) => x.layer.id === 'r3dhandles');
    return h ? { kind: h.properties.kind, i: h.properties.i } : null;
  }

  // ---- pointer handling: box drawing and handle dragging
  _down(e) {
    if (!this.on) return;
    if (this.tool === 'box') { this.boxStart = e.lngLat; e.preventDefault?.(); return; }
    if (this.tool) return;
    const hit = this._hit(e.point);
    if (!hit) return;
    this.drag = { ...hit, start: e.lngLat, orig: this.region ? this.region.ring.map((p) => p.slice()) : null, moved: false };
    this.map.dragPan.disable();
    e.preventDefault?.();
  }

  _move(e) {
    if (!this.on) return;
    const ll = e.lngLat;
    if (this.tool === 'area' && this.area.length) { this._areaPreview(ll); return; }
    if (this.tool === 'box' && this.boxStart) {
      const a = this.boxStart, x = wrapLng(ll.lng, a.lng);
      const w = Math.min(a.lng, x), ee = Math.max(a.lng, x), s = Math.min(a.lat, ll.lat), n = Math.max(a.lat, ll.lat);
      this.h.satMap.setGeo('r3dbox', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [ee, s], [ee, n], [w, n], [w, s]]] } }] });
      return;
    }
    const d = this.drag;
    if (!d) return;
    d.moved = true;
    if (d.kind === 'cam') { if (this.viewer) this.viewer.setCameraLonLat(ll.lng, ll.lat); return; }
    const r = this.region, r0 = d.orig;
    if (d.kind === 'c') {
      const dx = wrapLng(ll.lng, d.start.lng) - d.start.lng, dy = ll.lat - d.start.lat;
      r.ring = r0.map(([x, y]) => [x + dx, clampLat(y + dy)]);
    } else if (r.type === 'box') {
      const o = r0[(d.i + 2) % 4], x = wrapLng(ll.lng, o[0]), y = clampLat(ll.lat);
      const w = Math.min(o[0], x), e2 = Math.max(o[0], x), s = Math.min(o[1], y), n = Math.max(o[1], y);
      r.ring = [[w, s], [e2, s], [e2, n], [w, n]];
    } else r.ring[d.i] = [wrapLng(ll.lng, r0[d.i][0]), clampLat(ll.lat)];
    this.drawRegion();
  }

  _up(e) {
    if (!this.on) return;
    if (this.tool === 'box' && this.boxStart) {
      const a = this.boxStart, ll = e.lngLat; this.boxStart = null;
      const x = wrapLng(ll.lng, a.lng);
      this.setTool(null);
      this.setBox(Math.min(a.lng, x), Math.min(a.lat, ll.lat), Math.max(a.lng, x), Math.max(a.lat, ll.lat));
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.map.dragPan.enable();
    if (d.kind === 'cam' || !d.moved) return;
    const [w, s, ee, n] = ringBBox(this.region.ring);
    const err = this.check(w, s, ee, n);
    if (err) { this.h.toast(err, 'info', 3500); this.region.ring = d.orig; this.drawRegion(); return; }
    this.apply();
  }
}

export { emptyFC };
