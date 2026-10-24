// Players, the ball, the goals and the boards as 3D meshes (WebGL, three.js),
// drawn in a canvas laid over the 2D pitch (grass, markings, shadows) and
// under the 2D overlays (names, gauges).
//
//  * The camera is the 2D renderer's own projection (isometric or third
//    person) as a world -> clip matrix, so the meshes sit exactly where the
//    2D layers expect them.
//  * That projection shows the world mirrored compared with a standard 3D
//    camera, so everything here is built in "scene space" – the world with y
//    flipped (S) – and the camera matrix takes M·S: same screen, but faces,
//    normals and lighting the right way round.
//  * A player is built from parts placed on the animation skeleton every
//    frame (see skeleton in figure.js): tapered limbs, joints, a shaped torso,
//    shorts, boots, hands or gloves, and a head with a face and hair. The
//    geometries and materials are shared, so a full pitch is a few hundred
//    small meshes.

import * as THREE from './vendor/three.module.min.js';
import { BALL_R, GOAL_DEPTH } from '../shared/constants.js';

const V = (j) => new THREE.Vector3(j[0], -j[1], j[2]); // world -> scene space
const UP = new THREE.Vector3(0, 1, 0);
const lerpV = (a, b, u) => a.clone().lerp(b, u);

function shadeHex(hex, k) {
  const c = new THREE.Color(hex);
  if (k > 0) c.lerp(new THREE.Color(1, 1, 1), k); else c.multiplyScalar(1 + k);
  return c;
}

export class Scene3D {
  // null when the browser has no WebGL (the 2D figures are drawn instead)
  static create(canvas, keep = false) {
    try { return new Scene3D(canvas, keep); } catch (e) { console.warn('[3d] WebGL unavailable – 2D figures', e && e.message); return null; }
  }

  constructor(canvas, keep = false) {
    this.canvas = canvas;
    // (keep: the picture stays readable after rendering, to copy it elsewhere)
    this.r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: keep });
    this.r.setPixelRatio(1);
    this.r.setClearColor(0x000000, 0);
    this.r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.cam = new THREE.Camera();
    this.cam.matrixAutoUpdate = false;
    // daylight from the top left, a cool sky and a green bounce off the grass
    const hemi = new THREE.HemisphereLight(0xe8f2ff, 0x2f5a35, 1.35);
    hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(-0.45, 0.35, 1);
    this.scene.add(hemi, sun);
    this.geo = {
      sphere: new THREE.SphereGeometry(1, 18, 12),
      lowSphere: new THREE.SphereGeometry(1, 10, 8),
      box: new THREE.BoxGeometry(1, 1, 1),
      plane: new THREE.PlaneGeometry(1, 1),
    };
    this.cyl = new Map();   // taper ratio -> unit tapered cylinder (0..1 along y)
    this.mats = new Map();  // colour|opacity -> material
    this.tex = new Map();   // shirt number textures
    this.players = new Map();
    this.ballMesh = null;
    this.trail = [];
    this.goalKey = '';
    this.boardMeshes = [];
  }

  setSize(w, h) { this.r.setSize(w, h, false); }

  // m: the 2D camera's world -> clip matrix (row-major); scene space flips y
  setCamera(m) {
    const k = m.slice();
    for (let r = 0; r < 4; r++) k[r * 4 + 1] = -k[r * 4 + 1];
    this.cam.projectionMatrix.set(...k);
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
  }

  render() { this.r.render(this.scene, this.cam); }

  // ------------------------------------------------------------ shared parts

  mat(color, opacity = 1) {
    const key = `${color}|${opacity}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: new THREE.Color(color), transparent: opacity < 1, opacity });
      this.mats.set(key, m);
    }
    return m;
  }

  taper(ratio) {
    const k = Math.round(clampN(ratio, 0.3, 2) * 20) / 20;
    let g = this.cyl.get(k);
    if (!g) { g = new THREE.CylinderGeometry(k, 1, 1, 12, 1, false).translate(0, 0.5, 0); this.cyl.set(k, g); }
    return g;
  }

  numberTexture(n, col) {
    const key = `${n}|${col}`;
    let t = this.tex.get(key);
    if (!t) {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d');
      g.font = '800 46px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.45)'; g.strokeText(String(n), 32, 35);
      g.fillStyle = col; g.fillText(String(n), 32, 35);
      t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      this.tex.set(key, t);
    }
    return t;
  }

  // ------------------------------------------------------------ players

  beginFrame() { for (const pm of this.players.values()) pm.seen = false; }
  endFrame() {
    for (const [id, pm] of this.players) {
      if (!pm.seen) { pm.group.visible = false; if (pm.idle++ > 600) { this.scene.remove(pm.group); this.players.delete(id); } }
    }
  }

  // A player in the pose J (world joints from skeleton()), looking like look.
  player(id, J, look, H, wd, alpha = 1) {
    let pm = this.players.get(id);
    if (!pm) { pm = new PlayerMesh(this); this.players.set(id, pm); this.scene.add(pm.group); }
    pm.seen = true; pm.idle = 0; pm.group.visible = true;
    pm.update(J, look, H, wd, alpha);
  }

  // ------------------------------------------------------------ ball

  ball([x, y, z], vel, dt, size, show, curving) {
    if (!this.ballMesh) {
      const c = document.createElement('canvas'); c.width = 256; c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 128);
      // dark patches where an icosahedron's corners are (a football's pentagons)
      const t = (1 + Math.sqrt(5)) / 2, vs = [];
      for (const a of [-1, 1]) for (const b of [-t, t]) vs.push([0, a, b], [a, b, 0], [b, 0, a]);
      g.fillStyle = '#23272e';
      for (const [vx, vy, vz] of vs) {
        const l = Math.hypot(vx, vy, vz), lat = Math.asin(vz / l), lon = Math.atan2(vy, vx);
        const px = (lon / (2 * Math.PI) + 0.5) * 256, py = (0.5 - lat / Math.PI) * 128;
        g.beginPath(); g.ellipse(px, py, 15 / Math.max(0.35, Math.cos(lat)), 15, 0, 0, Math.PI * 2); g.fill();
      }
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      // (lit like everything else, plus a glow of its own so the white stays white
      // on its shaded side – the patches stay dark)
      this.ballMesh = new THREE.Mesh(this.geo.sphere, new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.42 }));
      this.scene.add(this.ballMesh);
      for (let i = 0; i < 16; i++) {
        const m = new THREE.Mesh(this.geo.lowSphere, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
        m.visible = false;
        this.scene.add(m); this.trail.push(m);
      }
      this.trailPos = [];
    }
    const b = this.ballMesh;
    b.visible = show;
    b.position.set(x, -y, z);
    b.scale.setScalar(BALL_R * size);
    // rolls with its speed along the ground
    const sp = Math.hypot(vel[0], vel[1]);
    if (sp > 0.05 && dt > 0) {
      const axis = new THREE.Vector3(vel[1], vel[0], 0).normalize(); // (scene space: y flipped)
      b.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, sp * dt / BALL_R));
    }
    // the trail: speed, and the bend of a curling ball (golden, longer)
    const fast = Math.hypot(vel[0], vel[1], vel[2]) > 11 || curving;
    const len = curving ? 16 : 7;
    this.trailPos.push([x, -y, z]);
    while (this.trailPos.length > len) this.trailPos.shift();
    const n = this.trailPos.length;
    this.trail.forEach((m, i) => {
      m.visible = show && fast && i < n - 1;
      if (!m.visible) return;
      const a = (i + 1) / n;
      m.position.set(...this.trailPos[i]);
      m.scale.setScalar(BALL_R * size * (0.35 + 0.6 * a));
      m.material.opacity = (curving ? 0.45 : 0.3) * a;
      m.material.color.set(curving ? 0xffd666 : 0xffffff);
    });
  }

  // ------------------------------------------------------------ goals & boards

  goals(pit) {
    const key = `${pit.L}|${pit.goalW}|${pit.goalH}`;
    if (key === this.goalKey) return;
    this.goalKey = key;
    if (this.goalGroup) this.scene.remove(this.goalGroup);
    const grp = new THREE.Group();
    const white = this.mat('#f7f7f2'), R = 0.065;
    const bar = (a, b, r = R) => {
      const d = b.clone().sub(a), m = new THREE.Mesh(this.taper(1), white);
      m.position.copy(a); m.quaternion.setFromUnitVectors(UP, d.clone().normalize()); m.scale.set(r, d.length(), r);
      grp.add(m);
    };
    const gw = pit.goalW / 2, gh = pit.goalH, bh = gh * 0.75;
    const netMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32 });
    const sheet = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
    for (const s of [-1, 1]) {
      const gx = s * pit.L / 2, bx = s * (pit.L / 2 + GOAL_DEPTH);
      const P = (x, y, z) => new THREE.Vector3(x, -y, z);
      bar(P(gx, -gw, 0), P(gx, -gw, gh)); bar(P(gx, gw, 0), P(gx, gw, gh)); bar(P(gx, -gw - R, gh), P(gx, gw + R, gh));
      bar(P(bx, -gw, 0), P(bx, -gw, bh), 0.03); bar(P(bx, gw, 0), P(bx, gw, bh), 0.03); bar(P(bx, -gw, bh), P(bx, gw, bh), 0.03);
      bar(P(gx, -gw, gh), P(bx, -gw, bh), 0.03); bar(P(gx, gw, gh), P(bx, gw, bh), 0.03);
      // the net: back, roof and sides, as a mesh of lines over faint sheets
      const quads = [
        [P(bx, -gw, 0), P(bx, gw, 0), P(bx, gw, bh), P(bx, -gw, bh)],
        [P(gx, -gw, gh), P(gx, gw, gh), P(bx, gw, bh), P(bx, -gw, bh)],
        [P(gx, -gw, 0), P(gx, -gw, gh), P(bx, -gw, bh), P(bx, -gw, 0)],
        [P(gx, gw, 0), P(gx, gw, gh), P(bx, gw, bh), P(bx, gw, 0)],
      ];
      const pts = [];
      for (const [a, b, c, d] of quads) {
        const n = 12;
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          pts.push(lerpV(a, b, u), lerpV(d, c, u), lerpV(a, d, u), lerpV(b, c, u));
        }
        const sg = new THREE.BufferGeometry().setFromPoints([a, b, c, a, c, d]);
        grp.add(new THREE.Mesh(sg, sheet));
      }
      grp.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), netMat));
    }
    this.goalGroup = grp;
    this.scene.add(grp);
  }

  // The advertising boards round the pitch; nearOpacity: how see-through the
  // ones between the camera and the pitch are (fn: side index -> near?)
  boards(pit, isNear, colors) {
    const key = `${pit.L}|${pit.W}`;
    if (key !== this.boardKey) {
      this.boardKey = key;
      for (const m of this.boardMeshes) this.scene.remove(m.grp);
      this.boardMeshes = [];
      const hx = pit.L / 2 + 5.4, hy = pit.W / 2 + 4.4, h = 0.75;
      const sides = [[[-hx, -hy], [hx, -hy]], [[hx, -hy], [hx, hy]], [[hx, hy], [-hx, hy]], [[-hx, hy], [-hx, -hy]]];
      for (const [a, b] of sides) {
        const grp = new THREE.Group(), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const mid = new THREE.Vector3((a[0] + b[0]) / 2, -(a[1] + b[1]) / 2, h / 2);
        const ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
        const body = new THREE.Mesh(this.geo.box, new THREE.MeshLambertMaterial({ color: 0x1b2b3a, transparent: true }));
        body.position.copy(mid); body.rotation.z = ang; body.scale.set(len, 0.12, h);
        const top = new THREE.Mesh(this.geo.box, new THREE.MeshLambertMaterial({ color: 0xe8eef3, transparent: true }));
        top.position.set(mid.x, mid.y, h); top.rotation.z = ang; top.scale.set(len, 0.13, 0.03);
        grp.add(body, top);
        const n = Math.max(1, Math.round(len / 12));
        for (let i = 0; i < n; i++) {
          const u = (i + 0.5) / n;
          const st = new THREE.Mesh(this.geo.box, new THREE.MeshLambertMaterial({ color: new THREE.Color(colors[i % 2]), transparent: true }));
          st.position.set(a[0] + (b[0] - a[0]) * u, -(a[1] + (b[1] - a[1]) * u), 0.36); st.rotation.z = ang; st.scale.set(len / n - 0.5, 0.14, 0.28);
          grp.add(st);
        }
        this.scene.add(grp);
        this.boardMeshes.push({ grp, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
      }
    }
    this.boardMeshes.forEach((bm) => {
      const near = isNear(bm.mid[0], bm.mid[1]);
      for (const m of bm.grp.children) { m.material.opacity = near ? 0.55 : 1; m.material.depthWrite = !near; }
    });
  }
}

const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

// One player's meshes, re-placed on his skeleton every frame.
class PlayerMesh {
  constructor(s3) {
    this.s3 = s3;
    this.group = new THREE.Group();
    this.parts = [];
    this.n = 0;
    this.seen = true; this.idle = 0;
  }

  // the next mesh in this player's pool (created on first use)
  part(geo, mat) {
    let m = this.parts[this.n];
    if (!m) { m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; m.frustumCulled = false; this.parts.push(m); this.group.add(m); }
    m.geometry = geo; m.material = mat; m.visible = true;
    this.n++;
    return m;
  }

  // a limb part from a to b, radius ra at a tapering to rb at b
  limb(a, b, ra, rb, mat) {
    const d = b.clone().sub(a), L = d.length();
    if (L < 1e-4) return;
    const m = this.part(this.s3.taper(rb / ra), mat);
    m.matrix.compose(a, new THREE.Quaternion().setFromUnitVectors(UP, d.divideScalar(L)), new THREE.Vector3(ra, L, ra));
  }

  // an ellipsoid at c with radii (rx, ry, rz) along the axes of basis (X, Y, Z)
  blob(c, X, Y, Z, rx, ry, rz, mat, geo = this.s3.geo.sphere) {
    const m = this.part(geo, mat);
    m.matrix.makeBasis(X, Y, Z).scale(new THREE.Vector3(rx, ry, rz)).setPosition(c);
  }

  ball(c, r, mat) { const m = this.part(this.s3.geo.lowSphere, mat); m.matrix.makeScale(r, r, r).setPosition(c); }

  update(Jw, look, H, wd, alpha) {
    this.n = 0;
    const s3 = this.s3, J = {};
    for (const k in Jw) J[k] = V(Jw[k]);
    const op = alpha < 1 ? Math.round(alpha * 20) / 20 : 1;
    const M = (c) => s3.mat(c, op);
    const skin = M(look.skin), shirt = M(look.shirt), shorts = M(look.shorts), socks = M(look.socks), trim = M(look.trim), boots = M(look.boots);
    const hairM = M(look.hairColor);
    const bulk = (0.85 + 0.3 * (wd - 0.8)) * (look.female ? 0.9 : 1);
    const fem = !!look.female;

    // ---- legs
    for (const s of ['L', 'R']) {
      const hip = J['hip' + s], knee = J['knee' + s], ank = J['foot' + s], toe = J['toe' + s];
      this.limb(hip, lerpV(hip, knee, 0.58), 0.064 * bulk * H, 0.056 * bulk * H, shorts);
      this.limb(lerpV(hip, knee, 0.5), knee, 0.048 * bulk * H, 0.034 * bulk * H, skin);
      this.ball(knee, 0.035 * bulk * H, skin);
      const calf = lerpV(knee, ank, 0.34);
      this.limb(lerpV(knee, ank, 0.05), calf, 0.034 * bulk * H, 0.041 * bulk * H, socks);
      this.limb(calf, ank, 0.041 * bulk * H, 0.024 * bulk * H, socks);
      this.limb(lerpV(knee, ank, 0.1), lerpV(knee, ank, 0.15), 0.037 * bulk * H, 0.037 * bulk * H, trim);
      this.ball(ank, 0.025 * bulk * H, socks);
      // boot: heel to a rounded toe
      const heel = lerpV(ank, toe, -0.2), fwd = toe.clone().sub(heel), fl = fwd.length() || 1;
      fwd.divideScalar(fl);
      const side = new THREE.Vector3(0, 0, 1).cross(fwd).normalize(), up = fwd.clone().cross(side).normalize();
      this.blob(lerpV(heel, toe, 0.5).addScaledVector(up, -0.008 * H), fwd, side, up, fl * 0.62, 0.032 * H, 0.03 * H, boots);
    }

    // ---- torso: shorts, then a shirt that tapers from the hips to the shoulders
    const hc = J.hc, neck = J.neck, shL = J.shL, shR = J.shR;
    const Y = neck.clone().sub(hc), tl = Y.length(); Y.divideScalar(tl || 1);
    const X = shR.clone().sub(shL); X.addScaledVector(Y, -X.dot(Y)).normalize();
    let Z = X.clone().cross(Y).normalize();
    const facing = J.nose.clone().sub(J.head);
    if (Z.dot(facing) < 0) Z.negate();
    const shHalf = shR.distanceTo(shL) / 2 + 0.035 * H;
    const hipHalf = J.hipR.distanceTo(J.hipL) / 2 + 0.06 * H * wd;
    const waistHalf = fem ? Math.min(shHalf, hipHalf) * 0.8 : Math.max(shHalf * 0.82, hipHalf * 0.95);
    const along = (u) => hc.clone().addScaledVector(Y, u * tl);
    const section = (u0, u1, r0, r1, d0, d1, mat) => {
      // an elliptic tapered section across the body (X), d: depth / width
      const m = this.part(s3.taper(r1 / r0), mat);
      m.matrix.makeBasis(X, Y, Z).scale(new THREE.Vector3(r0, (u1 - u0) * tl, r0 * (d0 + d1) / 2)).setPosition(along(u0));
    };
    section(-0.32, 0.16, hipHalf, hipHalf * 0.98, 0.66, 0.66, shorts);
    section(0.12, 0.5, hipHalf * 0.97, waistHalf, 0.66, 0.62, shirt);
    section(0.48, 0.97, waistHalf, shHalf, fem ? 0.7 : 0.62, 0.55, shirt);
    // collar and neck
    this.limb(along(0.94), along(1.0), 0.05 * H, 0.046 * H, trim);
    this.limb(neck.clone().addScaledVector(Y, -0.02 * H), lerpV(neck, J.head, 0.6), 0.036 * bulk * H, 0.031 * bulk * H, skin);
    // number on the back
    if (look.number) {
      const m = this.part(s3.geo.plane, numberMat(s3, look.number, look.trim, op));
      const c = along(0.66).addScaledVector(Z, -waistHalf * 0.64 - 0.004);
      m.matrix.makeBasis(X, Y, Z.clone().negate()).scale(new THREE.Vector3(0.17 * H, 0.17 * H, 1)).setPosition(c);
    }

    // ---- arms
    for (const s of ['L', 'R']) {
      const sh = J['sh' + s], el = J['el' + s], hand = J['hand' + s];
      this.ball(sh, 0.05 * bulk * H, shirt);
      if (look.longSleeves) {
        this.limb(sh, el, 0.043 * bulk * H, 0.033 * bulk * H, shirt);
        this.ball(el, 0.032 * bulk * H, shirt);
        this.limb(el, hand, 0.033 * bulk * H, 0.026 * bulk * H, shirt);
      } else {
        this.limb(sh, lerpV(sh, el, 0.55), 0.044 * bulk * H, 0.037 * bulk * H, shirt);
        this.limb(lerpV(sh, el, 0.5), el, 0.03 * bulk * H, 0.024 * bulk * H, skin);
        this.ball(el, 0.024 * bulk * H, skin);
        this.limb(el, hand, 0.025 * bulk * H, 0.019 * bulk * H, skin);
      }
      // the hand along the forearm: a keeper's padded glove with a dark cuff
      const d = hand.clone().sub(el).normalize();
      const sideV = d.clone().cross(Z); if (sideV.lengthSq() < 1e-6) sideV.set(1, 0, 0); sideV.normalize();
      const nrm = sideV.clone().cross(d).normalize();
      if (look.gloves) {
        this.limb(hand.clone().addScaledVector(d, -0.03 * H), hand.clone().addScaledVector(d, 0.005 * H), 0.03 * H, 0.031 * H, M(shadeHex(look.gloves, -0.45).getStyle()));
        this.blob(hand.clone().addScaledVector(d, 0.05 * H), sideV, d, nrm, 0.042 * H, 0.06 * H, 0.03 * H, M(look.gloves));
      } else {
        this.blob(hand.clone().addScaledVector(d, 0.035 * H), sideV, d, nrm, 0.024 * H, 0.042 * H, 0.016 * H, skin);
      }
    }

    // ---- head, face and hair
    const hp = J.head, r = 0.094 * H;
    const f = facing.normalize(), up = J.headUp.clone().sub(hp).normalize(), sd = J.headR.clone().sub(hp).normalize();
    const at = (a, b, c) => hp.clone().addScaledVector(f, a * r).addScaledVector(up, b * r).addScaledVector(sd, c * r);
    this.blob(hp, sd, up, f, r, r * 1.04, r, skin);
    for (const e of [-1, 1]) this.blob(at(-0.02, 0.0, e * 0.96), f, up, sd, r * 0.13, r * 0.22, r * 0.09, skin);
    // eyes, brows, nose, mouth
    const dark = M('#2a1a12'), white = M('#fbfaf6');
    for (const e of [-1, 1]) {
      this.blob(at(0.84, 0.12, e * 0.36), sd, up, f, r * 0.16, r * 0.12, r * 0.08, white);
      this.ball(at(0.9, 0.11, e * 0.35), r * 0.08, dark);
      this.blob(at(0.86, 0.36, e * 0.37), sd, up, f, r * 0.19, r * 0.045, r * 0.05, M(shadeHex(look.hairColor, -0.1).getStyle()));
      if (fem) this.blob(at(0.88, 0.22, e * 0.44), sd, up, f, r * 0.17, r * 0.03, r * 0.04, dark); // lashes
    }
    this.blob(at(1.0, -0.08, 0), sd, up, f, r * 0.09, r * 0.13, r * 0.1, M(shadeHex(look.skin, -0.12).getStyle()));
    this.blob(at(0.88, -0.42, 0), sd, up, f, r * (fem ? 0.2 : 0.18), r * (fem ? 0.075 : 0.045), r * 0.06, M(fem ? '#b4524c' : '#7a2e26'));
    // facial hair
    const beard = look.beard | 0;
    if (beard === 1) this.blob(at(0.45, -0.45, 0), sd, up, f, r * 0.82, r * 0.55, r * 0.62, M(shadeHex(look.hairColor, 0.35).lerp(new THREE.Color(look.skin), 0.55).getStyle()));
    else if (beard === 2) this.blob(at(0.52, -0.55, 0), sd, up, f, r * 0.72, r * 0.5, r * 0.55, hairM);
    else if (beard === 3) this.blob(at(0.93, -0.28, 0), sd, up, f, r * 0.24, r * 0.05, r * 0.06, hairM);
    else if (beard === 4) this.blob(at(0.8, -0.72, 0), sd, up, f, r * 0.17, r * 0.2, r * 0.15, hairM);
    // hair
    const style = look.hair | 0;
    const cap = (k = 1.02, mat = hairM) => this.blob(at(-0.24, 0.24, 0), sd, up, f, r * k, r * k, r * k, mat);
    switch (style) {
      case 1: cap(); break;
      case 2: cap(1.0, M(shadeHex(look.hairColor, 0).lerp(new THREE.Color(look.skin), 0.45).getStyle())); break;
      case 3: cap(); this.blob(at(-0.48, -0.55, 0), sd, up, f, r * 0.98, r * 1.15, r * 0.62, hairM); break;
      case 4: this.blob(at(-0.15, 0.32, 0), sd, up, f, r * 1.4, r * 1.35, r * 1.35, hairM); break;
      case 5: cap(1.0, M(shadeHex(look.hairColor, 0).lerp(new THREE.Color(look.skin), 0.55).getStyle())); this.blob(at(-0.1, 0.98, 0), sd, up, f, r * 0.16, r * 0.24, r * 0.98, hairM); break;
      case 6: cap(); this.ball(at(-1.0, 0.0, 0), r * 0.34, hairM); this.blob(at(-1.12, -0.6, 0), sd, up, f, r * 0.24, r * 0.5, r * 0.24, hairM); break;
      case 7: cap(); this.ball(at(-0.48, 1.0, 0), r * 0.4, hairM); break;
      case 8: cap(); for (let i = 0; i < 7; i++) { const a = -1.3 + i * 0.43; this.ball(at(-0.2, Math.cos(a) * 0.86, Math.sin(a) * 0.86), r * 0.3, hairM); } break;
      case 9: cap(); this.blob(at(0.62, 0.62, 0.3), sd, up, f, r * 0.5, r * 0.22, r * 0.24, hairM); break;
      case 10: cap(); this.blob(at(-0.22, -0.15, 0), sd, up, f, r * 1.12, r * 1.02, r * 1.0, hairM); this.blob(at(0.62, 0.6, 0), sd, up, f, r * 0.62, r * 0.24, r * 0.25, hairM); break;
      case 11: cap(); for (const e of [-1, 1]) for (let i = 0; i < 4; i++) this.ball(at(-0.45, -0.35 - 0.42 * i, e * 0.72), r * (0.27 - 0.03 * i), hairM); break;
      default: break; // bald
    }
    for (let i = this.n; i < this.parts.length; i++) this.parts[i].visible = false;
  }
}

function numberMat(s3, n, col, op) {
  const key = `#${n}|${col}|${op}`;
  let m = s3.mats.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ map: s3.numberTexture(n, col), transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    s3.mats.set(key, m);
  }
  return m;
}
