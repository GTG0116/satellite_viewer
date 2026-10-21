/* VR (WebXR immersive-vr) for the 3D cloud view.
 *
 * The volumetric renderer's own passes (terrain -> cloud ray march -> tone mapping) run once per
 * eye with that eye's pose and frustum, at a reduced resolution that adapts to the headset's
 * frame rate, and the result is drawn into the eye's part of the XR framebuffer. three.js only
 * supplies the session, the per-eye poses / projections / viewports and the XR render target;
 * its own XR camera handling stays off (renderer.xr.enabled is never set).
 *
 * The rig maps the headset's reference space (metres, floor at y = 0) into the world (km, y =
 * altitude x vertical exaggeration): world = pos + yaw * (local * scale). scale 0.001 is true
 * size; larger scales turn you into a giant looking at the clouds as a model.
 *
 * Controllers (xr-standard mapping; a single controller acts as the right one)
 *   left stick              fly over the ground toward where you look (faster higher up)
 *   right stick up / down   elevation: fly up or down
 *   right stick left/right  turn in 30° steps
 *   grip + right stick ↕    cloud Height (the 3D view's vertical exaggeration, 1-6×)
 *   trigger                 fly faster (up to 5×)
 *   A / X                   grow (see the area as a model)   B / Y   back toward true size
 *   right stick click       play / pause the loop
 *   left stick click        3D depth: auto (enhanced stereo) / natural
 *
 * Rendering per eye: the ground (with cloud shadows from a precomputed map) at most of the
 * headset's resolution, the clouds ray-marched at a lower one with cheaper lighting and coarser
 * steps toward the edge of the lens, then composited (Viewer.compositeVR).
 *
 * Two profiles: a standalone headset (Quest Browser) renders on its mobile GPU and keeps the clouds
 * coarse; a PC headset (Chrome / Edge with Meta Link / Air Link, Virtual Desktop or SteamVR) renders
 * on the desktop GPU, so the clouds go up to the headset's full resolution with more steps, finer
 * lighting and no foveation. Either way the resolution backs off when the frame rate drops.
 *
 * Stereo: at true size the eyes are 6 cm apart and the clouds kilometres away, so the view has
 * no depth. In auto mode the eye separation grows with the distance to the nearest ground or
 * cloud (hyperstereo), so that always looks a few metres away and everything behind it has
 * depth; close to or inside cloud it eases back to natural.
 */
const SCALES = [0.001, 0.01, 0.1, 1, 10, 100];
// auto stereo: the nearest content should look this many eye separations away (~3 m)
const STEREO_NEAR = 50;
const DEAD = 0.15;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dz = (x) => (Math.abs(x) < DEAD ? 0 : (x - Math.sign(x) * DEAD) / (1 - DEAD));

// Per quality setting: cloud and ground resolution (fraction of the eye's viewport) and ray-march
// steps at full level, each falling to its minimum as the level drops; light taps toward the sun
// (and their growth), step growth toward the edge of the lens and the XR foveation
const PROFILES = {
  standalone: {
    cloud: { draft: 0.34, standard: 0.45, high: 0.58 }, cloudMin: 0.22,
    terr: { draft: 0.6, standard: 0.8, high: 1 }, terrMin: 0.7,
    steps: { draft: 100, standard: 150, high: 190 }, stepsMin: 56,
    taps: 5, grow: 2.9, fov: 0.8, foveation: 1,
  },
  pc: {
    cloud: { draft: 0.6, standard: 0.8, high: 1 }, cloudMin: 0.35,
    terr: { draft: 1, standard: 1, high: 1 }, terrMin: 0.85,
    steps: { draft: 150, standard: 220, high: 300 }, stepsMin: 80,
    taps: 6, grow: 2.3, fov: 0.4, foveation: 0,
  },
};

/** A headset running the page itself (Quest / Pico / Vision Pro / phone) rather than a PC streaming to one. */
function standalone() {
  const ua = navigator.userAgent || '';
  if (/OculusBrowser|Quest|Pico|Wolvic|Android|Mobile|iPhone|iPad/i.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // visionOS / iPadOS Safari
}

export const VR_HELP = 'Left stick: fly · Right stick ↕: elevation, ↔: turn · Grip + right stick ↕: cloud height · '
  + 'Trigger: faster · A/X: grow · B/Y: true size · Right stick click: play loop · Left stick click: 3D depth auto / natural';

export class VRMode {
  constructor(viewer, THREE) {
    this.v = viewer;
    this.T = THREE;
    this.session = null;
    this.rig = { pos: new THREE.Vector3(), yaw: 0, si: 0 };
    this.qYaw = new THREE.Quaternion();
    this.eyes = [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()];
    this.head = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), local: new THREE.Vector3() };
    this.prevBtn = new Map();
    this.turnLatch = false;
    this.level = 1;          // 0..1: render resolution and ray-march steps, adapted to the frame rate
    this.ema = 0;
    this.adaptT = 0;
    this.skyT = 0;
    this.terrRT = null;
    this.cloudRT = null;
    this.depthAuto = true;
    this.stereo = 1;         // eye separation multiplier (eased toward stereoGoal)
    this.stereoGoal = 1;
    this.stereoT = 0;
    this.camT = 0;
    this.tmp = new THREE.Vector3();
    this.pc = !standalone();
    this.prof = PROFILES[this.pc ? 'pc' : 'standalone'];
  }

  static async supported() {
    try { return !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-vr')); } catch (_) { return false; }
  }

  get presenting() { return !!this.session; }
  get scale() { return SCALES[this.rig.si]; }

  toggle() { return this.session ? this.exit() : this.enter(); }

  async enter() {
    const v = this.v, r = v.renderer;
    if (this.session || !v.S || !navigator.xr) return;
    // must be called straight from the click (user activation)
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'layers'] });
    let space = 'local-floor';
    try { await session.requestReferenceSpace(space); } catch (_) { space = 'local'; }
    this.session = session;
    this.align = true;
    this.level = 1;
    this.ema = 0;
    this.prevBtn.clear();
    this.rig.si = 0;
    session.addEventListener('end', () => this.onEnd());
    r.xr.setReferenceSpaceType(space);
    // the runtime's recommended size: on a PC that is the Link / SteamVR render-resolution setting
    r.xr.setFramebufferScaleFactor(1);
    await r.xr.setSession(session);
    r.xr.setFoveation(this.prof.foveation);
    // the lowest refresh rate the headset offers from 72 Hz up: the most time per frame
    const rates = session.supportedFrameRates ? [...session.supportedFrameRates].filter((x) => x >= 72).sort((a, b) => a - b) : [];
    if (rates.length && session.updateTargetFrameRate) session.updateTargetFrameRate(rates[0]).catch(() => {});
    this.stereo = this.stereoGoal = 1;
    this.stereoT = 0;
    if (v.onVR) v.onVR(true);
  }

  exit() { if (this.session) this.session.end(); }

  onEnd() {
    const v = this.v, T = this.T;
    this.session = null;
    // the desktop view continues from where the head was, looking the same way
    const cam = v.camera, h = this.head;
    if (v.S && h.pos.lengthSq() > 0) {
      cam.position.copy(h.pos);
      const f = new T.Vector3(0, 0, -1).applyQuaternion(h.quat);
      f.y = 0;
      if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
      f.normalize();
      const alt = Math.max(0.05, cam.position.y / v.params.vex - v.groundAt(cam.position.x, cam.position.z));
      v.controls.target.copy(cam.position).addScaledVector(f, Math.max(1, alt));
      v.controls.update();
    }
    for (const k of ['terrRT', 'cloudRT']) if (this[k]) { this[k].dispose(); this[k] = null; }
    // three.js restores the canvas size after this handler; resize once it has
    setTimeout(() => { v.resize(); v.touch(); }, 0);
    if (v.onVR) v.onVR(false);
  }

  // ---------------------------------------------------------------- rig
  /** reference-space point -> world */
  toWorld(p, out) {
    return out.copy(p).multiplyScalar(this.scale).applyQuaternion(this.qYaw).add(this.rig.pos);
  }

  setYaw(y) { this.rig.yaw = y; this.qYaw.setFromAxisAngle(new this.T.Vector3(0, 1, 0), y); }

  /** Change the rig (yaw / scale) keeping the head where it is in the world. */
  keepHead(fn) {
    const before = this.toWorld(this.head.local, new this.T.Vector3());
    fn();
    const now = this.toWorld(this.head.local, new this.T.Vector3());
    this.rig.pos.add(before.sub(now));
  }

  updateHead(cams) {
    const T = this.T, h = this.head;
    h.local.copy(cams[0].position);
    if (cams.length > 1) h.local.add(cams[cams.length - 1].position).multiplyScalar(0.5);
    this.toWorld(h.local, h.pos);
    h.quat.multiplyQuaternions(this.qYaw, cams[0].quaternion);
    return h;
  }

  /** First frame: put the head where the desktop camera is, facing the same way. */
  alignTo(cams) {
    const v = this.v, T = this.T, cam = v.camera;
    const yawOf = (f) => Math.atan2(-f.x, -f.z);
    const cf = new T.Vector3(); cam.getWorldDirection(cf);
    const hf = new T.Vector3(0, 0, -1).applyQuaternion(cams[0].quaternion);
    this.setYaw(yawOf(cf) - yawOf(hf));
    this.rig.pos.set(0, 0, 0);
    this.updateHead(cams);
    this.rig.pos.copy(cam.position).sub(this.head.pos);
  }

  altitude(p) { return p.y / this.v.params.vex - this.v.groundAt(p.x, p.z); }

  // ---------------------------------------------------------------- controllers
  input(dt, cams) {
    const v = this.v, T = this.T, p = v.params;
    let lx = 0, ly = 0, rx = 0, ry = 0, grip = false, trig = 0;
    const pressed = (src, i) => {
      const k = `${src.handedness}${i}`, b = src.gamepad.buttons[i], now = !!(b && b.pressed);
      const was = this.prevBtn.get(k);
      this.prevBtn.set(k, now);
      return now && !was;
    };
    for (const src of this.session.inputSources || []) {
      const gp = src.gamepad;
      if (!gp) continue;
      const a = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] || 0, gp.axes[1] || 0];
      if (src.handedness === 'left') { lx = dz(a[0]); ly = dz(a[1]); } else { rx = dz(a[0]); ry = dz(a[1]); }
      if (gp.buttons[1] && gp.buttons[1].pressed) grip = true;
      trig = Math.max(trig, (gp.buttons[0] && gp.buttons[0].value) || 0);
      if (pressed(src, 4)) this.keepHead(() => { this.rig.si = Math.min(SCALES.length - 1, this.rig.si + 1); });
      if (pressed(src, 5)) this.keepHead(() => { this.rig.si = Math.max(0, this.rig.si - 1); });
      if (pressed(src, 3)) {
        if (src.handedness === 'left') this.depthAuto = !this.depthAuto;
        else if (p.framesMode !== 'single') v.togglePlay();
      }
    }
    this.updateHead(cams);
    const h = this.head;
    const alt = Math.max(0.05, this.altitude(h.pos));
    const sp = Math.min(alt * 0.9 + 0.2, 60) * (1 + 4 * trig) * dt; // km this frame
    // fly over the ground toward where the head points
    if (lx || ly) {
      const f = new T.Vector3(0, 0, -1).applyQuaternion(h.quat);
      f.y = 0;
      if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
      f.normalize();
      const rt = new T.Vector3(-f.z, 0, f.x);
      this.rig.pos.addScaledVector(f, -ly * sp).addScaledVector(rt, lx * sp);
    }
    if (grip && ry) {
      // cloud height: the vertical exaggeration, altitude kept
      const old = p.vex, nv = clamp(Math.round(old * Math.exp(-ry * dt * 0.9) * 1000) / 1000, 1, 6);
      if (nv !== old) {
        p.vex = nv;
        v.rescaleVex(old);
        this.rig.pos.y *= nv / old;
        v.markCustom();
        v.syncControls();
        clearTimeout(this.saveT);
        this.saveT = setTimeout(() => v.changed(), 500);
      }
    } else if (ry) this.rig.pos.y -= ry * sp * p.vex;
    // snap turn around the head
    if (Math.abs(rx) > 0.7 && !this.turnLatch) {
      this.turnLatch = true;
      this.keepHead(() => this.setYaw(this.rig.yaw - Math.sign(rx) * Math.PI / 6));
    } else if (Math.abs(rx) < 0.35) this.turnLatch = false;
    // stay above the ground and below 3000 km
    this.updateHead(cams);
    const g = v.groundAt(h.pos.x, h.pos.z);
    const lo = (g + 0.0018) * p.vex, hi = (g + 3000) * p.vex;
    if (h.pos.y < lo) this.rig.pos.y += lo - h.pos.y;
    else if (h.pos.y > hi) this.rig.pos.y += hi - h.pos.y;
    this.updateHead(cams);
  }

  /** Resolution and step count follow the frame rate (VR needs 72-90 fps). */
  adapt(dt) {
    this.ema = this.ema ? this.ema * 0.9 + dt * 0.1 : dt;
    this.adaptT += dt;
    if (this.adaptT < 0.5) return;
    this.adaptT = 0;
    const target = 1 / ((this.session && this.session.frameRate) || 72);
    if (this.ema > target * 1.3) this.level = Math.max(0, this.level - 0.12);
    else if (this.ema < target * 1.08) this.level = Math.min(1, this.level + 0.04);
  }

  ensureTargets(cw, ch, tw, th) {
    const T = this.T;
    const mk = (k, w, h, type) => {
      w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
      if (this[k] && this[k].width === w && this[k].height === h) return;
      if (this[k]) this[k].dispose();
      const rt = new T.WebGLRenderTarget(w, h, { type, depthBuffer: type === T.FloatType });
      // float32 is read 1:1 (it carries the ground distance); the clouds are upsampled smoothly
      rt.texture.minFilter = rt.texture.magFilter = type === T.FloatType ? T.NearestFilter : T.LinearFilter;
      this[k] = rt;
    };
    mk('terrRT', tw, th, T.FloatType);
    mk('cloudRT', cw, ch, T.HalfFloatType);
  }

  /** Eye separation for the depth mode, eased in log space so the depth never jumps. */
  updateStereo(dt, cams) {
    this.stereoT -= dt;
    if (this.stereoT <= 0) {
      this.stereoT = 0.25;
      let goal = 1;
      if (this.depthAuto && cams.length > 1) {
        const sep = cams[0].position.distanceTo(cams[cams.length - 1].position) * this.scale; // km
        if (sep > 0) goal = clamp(this.v.nearestContent(this.head.pos) / STEREO_NEAR / sep, 1, 20000);
      }
      this.stereoGoal = goal;
    }
    // less depth quickly (coming close to cloud), more depth slowly
    const k = 1 - Math.exp(-dt * (this.stereoGoal < this.stereo ? 4 : 1.5));
    this.stereo = Math.exp(Math.log(this.stereo) + (Math.log(this.stereoGoal) - Math.log(this.stereo)) * k);
  }

  // ---------------------------------------------------------------- frame
  /** One XR frame: called from the viewer's animation loop while presenting. */
  render(dt) {
    const v = this.v, r = v.renderer, cams = r.xr.getCamera().cameras;
    const target = r.getRenderTarget(); // the XR framebuffer, bound by three.js for this frame
    if (!cams.length || !target || !v.S) return;
    if (this.align) { this.alignTo(cams); this.align = false; }
    this.input(dt, cams);
    this.adapt(dt);
    this.drawEyes(cams, target, dt);
    // the desktop camera follows the head: the map shows where you are and what you see
    v.camera.position.copy(this.head.pos);
    v.camera.quaternion.copy(this.head.quat);
    v.camera.updateMatrixWorld();
    this.camT += dt;
    if (this.camT > 0.5) { this.camT = 0; v.emitCamera(true); }
    this.skyT += dt;
    if (this.skyT > 1) { this.skyT = 0; v.updateLocalSky(false); }
  }

  /** Render each eye of cams (XR views: position, quaternion, projectionMatrix, viewport) into target. */
  drawEyes(cams, target, dt) {
    const v = this.v, P = this.prof, L = this.level;
    const q = P.cloud[v.params.quality] ? v.params.quality : 'standard';
    // the clouds are soft and can run coarse; the ground and sky stay close to the headset's resolution
    const cres = P.cloudMin + (P.cloud[q] - P.cloudMin) * L;
    const tres = P.terr[q] * (P.terrMin + (1 - P.terrMin) * L);
    const steps = Math.round(P.stepsMin + (P.steps[q] - P.stepsMin) * L);
    const vp0 = cams[0].viewport;
    this.ensureTargets(vp0.z * cres, vp0.w * cres, vp0.z * tres, vp0.w * tres);
    this.updateHead(cams);
    this.updateStereo(dt, cams);
    v.updateShadowMap();
    const saved = target.viewport.clone();
    const alt = Math.max(0.0005, this.altitude(this.head.pos));
    for (let i = 0; i < cams.length; i++) this.renderEye(cams[i], this.eyes[i % 2], target, alt, steps);
    target.viewport.copy(saved);
    v.renderer.setRenderTarget(target);
  }

  renderEye(xc, e, target, alt, steps) {
    const v = this.v;
    // the eye's offset from the middle of the head, times the stereo multiplier
    this.tmp.copy(xc.position).sub(this.head.local).multiplyScalar(this.stereo).add(this.head.local);
    this.toWorld(this.tmp, e.position);
    e.quaternion.multiplyQuaternions(this.qYaw, xc.quaternion);
    e.updateMatrixWorld(true);
    // the eye's (asymmetric) frustum with near / far in km
    const m = xc.projectionMatrix.elements;
    const L = (m[8] - 1) / m[0], R = (m[8] + 1) / m[0], B = (m[9] - 1) / m[5], U = (m[9] + 1) / m[5];
    const near = clamp(alt * 0.2, 0.0005, 2), far = 25000;
    e.near = near; e.far = far;
    e.fov = 2 * Math.atan((U - B) / 2) * 180 / Math.PI;
    e.aspect = (R - L) / (U - B);
    e.projectionMatrix.makePerspective(L * near, R * near, U * near, B * near, near, far);
    e.projectionMatrixInverse.copy(e.projectionMatrix).invert();
    // where the eye looks straight ahead (uv): steps grow from there toward the edge of the lens
    const centre = [0.5 - m[8] / 2, 0.5 - m[9] / 2];
    const P = this.prof;
    v.renderFrame(this.terrRT, this.cloudRT, null, 1, steps, 1.8, false, e, { taps: P.taps, grow: P.grow, fov: P.fov, centre });
    const vp = xc.viewport;
    target.viewport.set(vp.x, vp.y, vp.z, vp.w);
    v.compositeVR(this.cloudRT, this.terrRT, e, target);
  }
}
