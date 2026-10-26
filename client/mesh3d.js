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
//    shorts, boots, hands or gloves, and a head with a face and hair. Every
//    part is an instance of one of four shapes (a sphere, a small sphere, a
//    tapered cylinder, the number on the back), so a full pitch – some eight
//    hundred parts – is four draw calls: what a phone can afford.
//  * The parts' edges are a little darker, like an outline, so players stand
//    out from the grass and from each other where they overlap.

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
    // daylight: the afternoon sun (where the 2D shadows fall from – SUN in
    // render.js), a cool sky and a green bounce off the grass
    const hemi = new THREE.HemisphereLight(0xe8f2ff, 0x2f5a35, 1.35);
    hemi.position.set(0, 0, 1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(-0.75, -0.15, 1);
    this.scene.add(hemi, sun);
    this.hemi = hemi; this.sun = sun;
    this.geo = {
      sphere: new THREE.SphereGeometry(1, 18, 12),
      lowSphere: new THREE.SphereGeometry(1, 10, 8),
      box: new THREE.BoxGeometry(1, 1, 1),
      plane: new THREE.PlaneGeometry(1, 1),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 12, 1, false).translate(0, 0.5, 0), // (0..1 along y)
    };
    this.mats = new Map();  // colour|opacity -> material
    // the way to the viewer (isometric) or where he is (perspective), for the edges
    this.uView = { value: new THREE.Vector3(0, 0, 1) }; this.uEye = { value: new THREE.Vector3() }; this.uPersp = { value: 0 };
    this.batch = new Batch(this, 1);
    this.ghost = null; // (see-through players: third person's own man)
    this.ballMesh = null;
    this.goalKey = '';
    this.boardMeshes = [];
  }

  setSize(w, h) { this.r.setSize(w, h, false); }

  // m: the 2D camera's world -> clip matrix (row-major); scene space flips y.
  // eye: where a perspective camera is (none: orthographic)
  setCamera(m, eye = null) {
    const k = m.slice();
    for (let r = 0; r < 4; r++) k[r * 4 + 1] = -k[r * 4 + 1];
    this.cam.projectionMatrix.set(...k);
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
    if (eye) { this.uPersp.value = 1; this.uEye.value.set(eye[0], -eye[1], eye[2]); return; }
    // towards the viewer: the way along which nothing moves on screen and depth falls
    const d = new THREE.Vector3(k[0], k[1], k[2]).cross(new THREE.Vector3(k[4], k[5], k[6])).normalize();
    if (d.x * k[8] + d.y * k[9] + d.z * k[10] > 0) d.negate();
    this.uPersp.value = 0; this.uView.value.copy(d);
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

  // ------------------------------------------------------------ players

  beginFrame() { this.batch.begin(); if (this.ghost) this.ghost.begin(); }
  endFrame() { this.batch.end(); if (this.ghost) this.ghost.end(); }

  // A player in the pose J (world joints from skeleton()), looking like look.
  player(id, J, look, H, wd, alpha = 1) {
    if (alpha < 1 && !this.ghost) this.ghost = new Batch(this, 0.6);
    emitPlayer(alpha < 1 ? this.ghost : this.batch, J, look, H, wd);
  }

  // ------------------------------------------------------------ ball

  // squash: { k: 0..1, dir: [x, y, z] } – the ball flattened by a hard kick
  // for a moment, stretched along where it's going
  ball([x, y, z], vel, dt, size, show, curving, squash = null) {
    if (!this.ballMesh) {
      const c = document.createElement('canvas'); c.width = 256; c.height = 128;
      const g = c.getContext('2d');
      this.ballTex = c;
      paintBall(g, ...(this.ballLook || ['#ffffff', '#23272e']));
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      // (lit like everything else, plus a glow of its own so the white stays white
      // on its shaded side – the patches stay dark)
      this.ballMesh = new THREE.Mesh(this.geo.sphere, new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.42 }));
      this.ballMesh.matrixAutoUpdate = false;
      this.ballQ = new THREE.Quaternion();
      this.scene.add(this.ballMesh);
      this.trail = new Trail(this);
    }
    const b = this.ballMesh;
    b.visible = show;
    // rolls with its speed along the ground
    const sp = Math.hypot(vel[0], vel[1]);
    if (sp > 0.05 && dt > 0) {
      const axis = _d.set(vel[1], vel[0], 0).normalize(); // (scene space: y flipped)
      this.ballQ.premultiply(_q.setFromAxisAngle(axis, sp * dt / BALL_R));
    }
    const r = BALL_R * size;
    b.matrix.makeRotationFromQuaternion(this.ballQ).scale(_v.set(r, r, r));
    if (squash && squash.k > 0) {
      // longer along its way, thinner across it
      const u = _d.set(squash.dir[0], -squash.dir[1], squash.dir[2]).normalize(), s = 1 + 0.3 * squash.k, q = 1 - 0.16 * squash.k, k = s - q;
      _m.set(
        q + k * u.x * u.x, k * u.x * u.y, k * u.x * u.z, 0,
        k * u.y * u.x, q + k * u.y * u.y, k * u.y * u.z, 0,
        k * u.z * u.x, k * u.z * u.y, q + k * u.z * u.z, 0,
        0, 0, 0, 1);
      b.matrix.premultiply(_m);
    }
    b.matrix.setPosition(x, -y, z);
    // the trail: speed, and the bend of a curling ball (golden, longer)
    this.trail.update([x, -y, z], show && (Math.hypot(vel[0], vel[1], vel[2]) > 11 || curving), curving, r, dt);
  }

  // the ball's colours: white, or orange on snow
  ballColors(base, patch) {
    if (!this.ballMesh || this.ballCols === base + patch) return;
    this.ballCols = base + patch;
    paintBall(this.ballTex.getContext('2d'), base, patch);
    this.ballMesh.material.map.needsUpdate = true;
  }

  // The light by the weather: the sun (or, at night, the floodlights from
  // two sides and their lamps glowing), the sky; the ball orange on snow.
  setWeather(kind) {
    this.weatherKind = kind;
    const L = {
      day: [0xe8f2ff, 0x2f5a35, 1.35, 1.9], night: [0xb4c4e2, 0x1a2e20, 1.0, 1.45],
      rain: [0xc9d2dc, 0x2a4a33, 1.55, 0.85], snow: [0xeef3f8, 0xd5dde3, 1.45, 1.15],
    }[kind] || [0xe8f2ff, 0x2f5a35, 1.35, 1.9];
    this.hemi.color.setHex(L[0]); this.hemi.groundColor.setHex(L[1]); this.hemi.intensity = L[2];
    this.sun.intensity = L[3];
    // (night: the floodlights, from high above – one light, as cheap as the sun)
    this.sun.position.set(kind === 'night' ? -0.25 : -0.75, kind === 'night' ? 0.2 : -0.15, 1);
    this.sun.color.setHex(kind === 'night' ? 0xf2f5ff : 0xffffff);
    this.ballLook = kind === 'snow' ? ['#ff7417', '#3a1b08'] : ['#ffffff', '#23272e'];
    if (this.ballMesh) this.ballColors(...this.ballLook);
  }

  // the floodlights' glow at night (each frame: where the towers' lamps are, in px)
  lampGlow(towers, px) {
    if (!this.glow) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3).setUsage(THREE.DynamicDrawUsage));
      this.glow = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xfff6dc, size: 64, sizeAttenuation: false, map: softDot(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.glow.frustumCulled = false;
      this.scene.add(this.glow);
    }
    const on = this.weatherKind === 'night';
    this.glow.visible = on;
    if (!on) return;
    const P = this.glow.geometry.attributes.position, vis = towers.filter((t) => t.mesh.visible);
    vis.forEach((t, i) => P.setXYZ(i, t.lamp[0], -t.lamp[1], t.lamp[2]));
    P.needsUpdate = true;
    this.glow.geometry.setDrawRange(0, vis.length);
    this.glow.material.size = px;
  }

  // ------------------------------------------------------------ particles

  // Bits of grass, dirt, snow or spray (soft: puffs – larger, fading) at
  // world (x, y, z) moving at (vx, vy, vz) for life seconds; each kind is a
  // pool drawn in one go. color: a THREE.Color.
  emit(soft, x, y, z, vx, vy, vz, life, color, alpha, grav = 9.81) {
    if (!this.bits) { this.bits = new Particles(this, 260, false); this.puffs = new Particles(this, 70, true); }
    (soft ? this.puffs : this.bits).emit(x, -y, z, vx, -vy, vz, life, color, alpha, grav);
  }

  // (sizes in pixels at the current zoom)
  stepFx(dt, bitPx, puffPx) {
    if (!this.bits) return;
    this.bits.step(dt, bitPx); this.puffs.step(dt, puffPx);
  }

  // ------------------------------------------------------------ goals & boards

  goals(pit) {
    const key = `${pit.L}|${pit.goalW}|${pit.goalH}`;
    if (key === this.goalKey) return;
    this.goalKey = key;
    if (this.goalGroup) this.scene.remove(this.goalGroup);
    const grp = new THREE.Group();
    const white = this.mat('#f7f7f2'), R = 0.065;
    const bar = (g, a, b, r = R) => {
      const d = b.clone().sub(a), m = new THREE.Mesh(this.geo.cyl, white);
      m.position.copy(a); m.quaternion.setFromUnitVectors(UP, d.clone().normalize()); m.scale.set(r, d.length(), r);
      g.add(m);
    };
    const gw = pit.goalW / 2, gh = pit.goalH, bh = gh * 0.75;
    const netMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32 });
    const sheet = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
    this.nets = [];
    for (const s of [-1, 1]) {
      const gx = s * pit.L / 2, bx = s * (pit.L / 2 + GOAL_DEPTH);
      const P = (x, y, z) => new THREE.Vector3(x, -y, z);
      // the posts and bar (they shake when the ball hits them), the frame at the back
      const frame = new THREE.Group();
      bar(frame, P(gx, -gw, 0), P(gx, -gw, gh)); bar(frame, P(gx, gw, 0), P(gx, gw, gh)); bar(frame, P(gx, -gw - R, gh), P(gx, gw + R, gh));
      grp.add(frame);
      bar(grp, P(bx, -gw, 0), P(bx, -gw, bh), 0.03); bar(grp, P(bx, gw, 0), P(bx, gw, bh), 0.03); bar(grp, P(bx, -gw, bh), P(bx, gw, bh), 0.03);
      bar(grp, P(gx, -gw, gh), P(bx, -gw, bh), 0.03); bar(grp, P(gx, gw, gh), P(bx, gw, bh), 0.03);
      // the net: back, roof and sides, each a grid of points (that the ball
      // can push out) joined by lines, over faint sheets
      const quads = [
        [P(bx, -gw, 0), P(bx, gw, 0), P(bx, gw, bh), P(bx, -gw, bh)],
        [P(gx, -gw, gh), P(gx, gw, gh), P(bx, gw, bh), P(bx, -gw, bh)],
        [P(gx, -gw, 0), P(gx, -gw, gh), P(bx, -gw, bh), P(bx, -gw, 0)],
        [P(gx, gw, 0), P(gx, gw, gh), P(bx, gw, bh), P(bx, gw, 0)],
      ];
      const n = 12, inside = P(gx + s * GOAL_DEPTH / 2, 0, gh / 3), base = [], nrm = [], lines = [], tris = [];
      for (const [a, b, c, d] of quads) {
        const o = base.length / 3;
        // outwards: away from the middle of the goal
        const fn = b.clone().sub(a).cross(d.clone().sub(a)).normalize();
        if (fn.dot(a.clone().sub(inside)) < 0) fn.negate();
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
          const p = lerpV(lerpV(a, b, i / n), lerpV(d, c, i / n), j / n);
          // (the edges are tied to the frame: only the middle gives)
          const free = Math.min(i, n - i, j, n - j) > 0 ? 1 : 0;
          base.push(p.x, p.y, p.z); nrm.push(fn.x * free, fn.y * free, fn.z * free);
          if (i < n) lines.push(o + j * (n + 1) + i, o + j * (n + 1) + i + 1);
          if (j < n) lines.push(o + j * (n + 1) + i, o + (j + 1) * (n + 1) + i);
          if (i < n && j < n) { const q = o + j * (n + 1) + i; tris.push(q, q + 1, q + n + 1, q + 1, q + n + 2, q + n + 1); }
        }
      }
      const pos = new THREE.BufferAttribute(new Float32Array(base), 3).setUsage(THREE.DynamicDrawUsage);
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', pos); lg.setIndex(lines);
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', pos); sg.setIndex(tris);
      const ls = new THREE.LineSegments(lg, netMat), sm = new THREE.Mesh(sg, sheet);
      ls.frustumCulled = sm.frustumCulled = false;
      grp.add(sm, ls);
      this.nets.push({ side: s, base: new Float32Array(base), nrm: new Float32Array(nrm), pos, hits: [], live: false, frame, shake: -1 });
    }
    this.goalGroup = grp;
    this.scene.add(grp);
  }

  // The ball into the net at (x, y, z) at speed v: it bulges out there
  netHit(side, x, y, z, v) {
    const N = this.nets && this.nets.find((q) => q.side === side);
    if (!N) return;
    if (N.hits.length > 2) N.hits.shift();
    N.hits.push({ x, y: -y, z, a: clampN(v * 0.03, 0.06, 0.45), t: 0 });
  }

  // The ball off a post or the bar: the frame shudders
  postHit(side) {
    const N = this.nets && this.nets.find((q) => q.side === side);
    if (N) N.shake = 0;
  }

  stepGoals(dt) {
    if (!this.nets) return;
    for (const N of this.nets) {
      if (N.shake >= 0) {
        N.shake += dt;
        const e = Math.exp(-N.shake * 9) * 0.03;
        N.frame.position.set(Math.sin(N.shake * 71) * e * N.side, Math.sin(N.shake * 53) * e * 0.5, 0);
        if (N.shake > 0.6) { N.shake = -1; N.frame.position.set(0, 0, 0); }
      }
      if (!N.hits.length && !N.live) continue;
      for (const h of N.hits) h.t += dt;
      N.hits = N.hits.filter((h) => h.t < 1.4);
      const p = N.pos.array, B = N.base, M = N.nrm;
      for (let i = 0; i < B.length; i += 3) {
        let d = 0;
        for (const h of N.hits) {
          const dx = B[i] - h.x, dy = B[i + 1] - h.y, dz = B[i + 2] - h.z;
          // out with the ball, then a couple of swings back as it settles
          const env = (1 - Math.exp(-h.t * 30)) * Math.exp(-h.t * 3.5) * Math.cos(h.t * 9);
          d += h.a * env * Math.exp(-(dx * dx + dy * dy + dz * dz) / 0.55);
        }
        p[i] = B[i] + M[i] * d; p[i + 1] = B[i + 1] + M[i + 1] * d; p[i + 2] = B[i + 2] + M[i + 2] * d;
      }
      N.pos.needsUpdate = true;
      N.live = N.hits.length > 0;
    }
  }

  // The advertising boards round the pitch, a mesh a side (the ones between
  // the camera and the pitch see-through: isNear(x, y) -> near?)
  boards(pit, isNear, colors) {
    const key = `${pit.L}|${pit.W}|${colors.join()}`;
    if (key !== this.boardKey) {
      this.boardKey = key;
      for (const m of this.boardMeshes) this.scene.remove(m.mesh);
      this.boardMeshes = [];
      const hx = pit.L / 2 + 5.4, hy = pit.W / 2 + 4.4, h = 0.75;
      const sides = [[[-hx, -hy], [hx, -hy]], [[hx, -hy], [hx, hy]], [[hx, hy], [-hx, hy]], [[-hx, hy], [-hx, -hy]]];
      for (const [a, b] of sides) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]), along = Math.abs(b[0] - a[0]) > 0.1;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        // (a box along the side: its length one way, its thickness the other)
        const box = (u, l, th, z0, z1, col) => {
          const x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u;
          return along ? { x, y, z: (z0 + z1) / 2, sx: l, sy: th, sz: z1 - z0, col } : { x, y, z: (z0 + z1) / 2, sx: th, sy: l, sz: z1 - z0, col };
        };
        const parts = [box(0.5, len, 0.12, 0, h, '#1b2b3a'), box(0.5, len, 0.13, h - 0.03, h + 0.0, '#e8eef3')];
        const n = Math.max(1, Math.round(len / 12));
        for (let i = 0; i < n; i++) parts.push(box((i + 0.5) / n, len / n - 0.5, 0.14, 0.22, 0.5, colors[i % 2]));
        const mesh = new THREE.Mesh(boxGeometry(parts), new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true }));
        this.scene.add(mesh);
        this.boardMeshes.push({ mesh, mid: [mx, my] });
      }
    }
    this.boardMeshes.forEach((bm) => {
      const near = isNear(bm.mid[0], bm.mid[1]);
      bm.mesh.material.opacity = near ? 0.55 : 1; bm.mesh.material.depthWrite = !near;
    });
  }

  // ------------------------------------------------------------ stadium

  // The stands round the pitch (stepped, a crowd on them in the teams'
  // colours, jumping when their team scores), the floodlight towers at the
  // corners and the dugouts. The stands and towers between the camera and the
  // pitch aren't drawn (isNear, as for the boards). crowd: 0..1, how full.
  stadium(pit, isNear, colors, crowd) {
    const key = `${pit.L}|${pit.W}|${colors.join()}|${crowd}`;
    if (key !== this.standKey) this.buildStadium(pit, colors, crowd, key);
    for (const s of this.stands) s.grp.visible = !isNear(s.mid[0], s.mid[1]);
    for (const t of this.towers) t.mesh.visible = !isNear(t.at[0], t.at[1]);
  }

  // (each frame, with the stadium: the lamps' glow, glowPx across)
  lamps(glowPx) { if (this.towers) this.lampGlow(this.towers, glowPx); }

  // jump: [team A's fans, team B's] 0..1; bob: a murmur all round
  crowdMood(time, jump, bob) {
    if (!this.crowdU) return;
    this.crowdU.uTime.value = time % 1000; this.crowdU.uJump.value.set(jump[0], jump[1]); this.crowdU.uBob.value = bob;
  }

  buildStadium(pit, colors, crowd, key) {
    this.standKey = key;
    for (const s of this.stands || []) this.scene.remove(s.grp);
    for (const t of this.towers || []) this.scene.remove(t.mesh);
    this.stands = []; this.towers = [];
    const hx = pit.L / 2, hy = pit.W / 2, ROWS = 10, DEPTH = 0.85, RISE = 0.42, FRONT = 0.9;
    if (!this.crowdU) this.crowdU = { uTime: { value: 0 }, uJump: { value: new THREE.Vector2() }, uBob: { value: 0 } };
    const crowdMat = crowdMaterial(this.crowdU);
    const standMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const neutral = ['#f2f2f2', '#2b2f36', '#56606b', '#c9ced6', '#38414d'];
    // four sides: where the first row is (out from the middle), which way is
    // out, how long
    const sides = [
      { o: [0, -1], d0: hy + 6.2, len: pit.L + 8 }, { o: [1, 0], d0: hx + 7.2, len: pit.W + 6 },
      { o: [0, 1], d0: hy + 6.2, len: pit.L + 8 }, { o: [-1, 0], d0: hx + 7.2, len: pit.W + 6 },
    ];
    for (const [si, sd] of sides.entries()) {
      const grp = new THREE.Group(), [ox, oy] = sd.o, tx = -oy, ty = ox; // out, along
      const P = (d, t) => [ox * d + tx * t, oy * d + ty * t];
      const boxes = [];
      const box = (d, t, dd, tl, z0, z1, col) => {
        const [x, y] = P(d, t);
        return ox ? { x, y, z: (z0 + z1) / 2, sx: dd, sy: tl, sz: z1 - z0, col } : { x, y, z: (z0 + z1) / 2, sx: tl, sy: dd, sz: z1 - z0, col };
      };
      boxes.push(box(sd.d0 - 0.15, 0, 0.3, sd.len, 0, FRONT, '#3b444d'));
      for (let r = 0; r < ROWS; r++) boxes.push(box(sd.d0 + (r + 0.5) * DEPTH, 0, DEPTH, sd.len, 0, FRONT + (r + 1) * RISE, r % 2 ? '#4a535c' : '#555f69'));
      boxes.push(box(sd.d0 + ROWS * DEPTH + 0.2, 0, 0.4, sd.len, 0, FRONT + ROWS * RISE + 1.6, '#2c333a'));
      // the dugouts, by the far touchline
      if (si === 0) for (const k of [0, 1]) {
        const x = (k ? 1 : -1) * Math.min(8, pit.L / 6), y = -(hy + 3.1);
        boxes.push({ x, y: y - 0.7, z: 0.95, sx: 4.6, sy: 0.15, sz: 1.9, col: '#2a3a4a' });
        boxes.push({ x, y: y - 0.1, z: 1.95, sx: 4.8, sy: 1.5, sz: 0.1, col: '#33475a' });
        for (const e of [-1, 1]) boxes.push({ x: x + e * 2.35, y: y - 0.1, z: 0.95, sx: 0.1, sy: 1.4, sz: 1.9, col: '#2a3a4a' });
        boxes.push({ x, y: y - 0.45, z: 0.25, sx: 4.2, sy: 0.4, sz: 0.5, col: colors[k] });
      }
      const sm = new THREE.Mesh(boxGeometry(boxes), standMat);
      grp.add(sm);
      // the crowd: on each row, a fan every 0.6 m or so – the nearer half of
      // each long stand for one team, the ends for the team at that end
      const fans = [];
      for (let r = 0; r < ROWS; r++) {
        const z = FRONT + (r + 1) * RISE;
        for (let t = -sd.len / 2 + 0.4; t < sd.len / 2 - 0.4; t += 0.6) {
          if (rnd() > crowd) continue;
          const [x, y] = P(sd.d0 + (r + 0.5) * DEPTH + (rnd() - 0.5) * 0.2, t + (rnd() - 0.5) * 0.25);
          const team = ox ? (ox < 0 ? 0 : 1) : (x < 0 ? 0 : 1);
          const col = rnd() < 0.7 ? colors[team] : neutral[(rnd() * neutral.length) | 0];
          fans.push({ x, y, z, team, col, ph: rnd(), turn: ox ? Math.PI / 2 : 0, s: 0.9 + rnd() * 0.2 });
        }
      }
      if (fans.length) {
        const geo = fanGeometry();
        const ph = new Float32Array(fans.length), tm = new Float32Array(fans.length);
        fans.forEach((f, i) => { ph[i] = f.ph; tm[i] = f.team; });
        geo.setAttribute('phase', new THREE.InstancedBufferAttribute(ph, 1));
        geo.setAttribute('team', new THREE.InstancedBufferAttribute(tm, 1));
        const im = new THREE.InstancedMesh(geo, crowdMat, fans.length);
        const c = new THREE.Color();
        fans.forEach((f, i) => {
          _m.makeRotationZ(f.turn).scale(_v.set(f.s, f.s, f.s)).setPosition(f.x, -f.y, f.z);
          im.setMatrixAt(i, _m); im.setColorAt(i, c.set(f.col));
        });
        im.frustumCulled = false;
        grp.add(im);
      }
      this.scene.add(grp);
      this.stands.push({ grp, mid: P(sd.d0, 0) });
    }
    // the floodlight towers, beyond the corners
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [a * (hx + 9.5), b * (hy + 8.5)])) {
      const H = 24, sx = -Math.sign(x), sy = -Math.sign(y);
      const parts = [{ x, y, z: H / 2, sx: 0.5, sy: 0.5, sz: H, col: '#6c747c' }];
      // the lamps: a bank on top, leaning in over the pitch
      parts.push({ x: x + sx * 0.4, y: y + sy * 0.4, z: H + 0.9, sx: 2.6, sy: 2.6, sz: 1.8, col: '#8a939b' });
      parts.push({ x: x + sx * 1.0, y: y + sy * 1.0, z: H + 0.9, sx: 2.2, sy: 2.2, sz: 1.5, col: '#f4f1de' });
      const mesh = new THREE.Mesh(boxGeometry(parts), standMat);
      this.scene.add(mesh);
      this.towers.push({ mesh, at: [x, y], lamp: [x + sx * 1.6, y + sy * 1.6, H + 0.9] });
    }
  }
}

// Boxes (world centre x, y, z, size, colour) merged into one geometry,
// coloured by vertex: a whole set of them is one draw call.
function boxGeometry(list) {
  const pos = [], nrm = [], col = [], c = new THREE.Color();
  const F = [ // faces: normal, then four corners (unit cube, -1..1)
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [[-1, 0, 0], [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]]],
    [[0, 1, 0], [[1, 1, -1], [-1, 1, -1], [-1, 1, 1], [1, 1, 1]]], [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]]],
  ];
  for (const b of list) {
    c.set(b.col);
    for (const [n, q] of F) {
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const v = q[k];
        // (scene space: y flipped)
        pos.push(b.x + v[0] * b.sx / 2, -(b.y + v[1] * b.sy / 2), b.z + v[2] * b.sz / 2);
        nrm.push(n[0], -n[1], n[2]);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// A fan: a body and a head (head: 1 on its vertices – skin, not the shirt)
function fanGeometry() {
  const body = boxGeometry([{ x: 0, y: 0, z: 0.3, sx: 0.42, sy: 0.28, sz: 0.6, col: '#ffffff' }]);
  const head = boxGeometry([{ x: 0, y: 0, z: 0.72, sx: 0.2, sy: 0.2, sz: 0.22, col: '#ffffff' }]);
  const g = new THREE.BufferGeometry(), n = body.attributes.position.count;
  for (const a of ['position', 'normal']) {
    const A = new Float32Array(n * 6);
    A.set(body.attributes[a].array); A.set(head.attributes[a].array, n * 3);
    g.setAttribute(a, new THREE.BufferAttribute(A, 3));
  }
  const h = new Float32Array(n * 2); h.fill(1, n);
  g.setAttribute('head', new THREE.BufferAttribute(h, 1));
  return g;
}

// The crowd's material: shirts from the instance colour, a skin tone per
// fan, and the whole fan up and down – jumping (their team scored) or a murmur.
function crowdMaterial(U) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'attribute float phase;\nattribute float team;\nattribute float head;\nvarying float vHead;\nvarying float vSkin;\nuniform float uTime;\nuniform vec2 uJump;\nuniform float uBob;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  vHead = head; vSkin = fract(phase * 7.31);
  float j = team < 0.5 ? uJump.x : uJump.y;
  transformed.z += j * 0.3 * max(0.0, sin(uTime * 9.0 + phase * 6.283)) + uBob * 0.05 * (0.5 + 0.5 * sin(uTime * 2.6 + phase * 40.0));`);
    sh.fragmentShader = 'varying float vHead;\nvarying float vSkin;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.82, 0.55, 0.38), vec3(0.18, 0.09, 0.05), vSkin), vHead);`);
  };
  m.customProgramCacheKey = () => 'crowd';
  return m;
}

const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------ player parts

// Lambert, coloured per part, edges darkened towards the silhouette; on the
// tapered cylinder the taper (top radius / bottom) comes per part too.
function partMaterial(s3, opacity, tapered) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: opacity < 1, opacity });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uView = s3.uView; sh.uniforms.uEye = s3.uEye; sh.uniforms.uPersp = s3.uPersp;
    if (tapered) {
      sh.vertexShader = 'attribute float taper;\n' + sh.vertexShader
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  if (abs(objectNormal.y) < 0.5) objectNormal = normalize(vec3(objectNormal.x, 1.0 - taper, objectNormal.z));')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed.xz *= mix(1.0, taper, position.y);');
    }
    sh.fragmentShader = 'uniform vec3 uView;\nuniform vec3 uEye;\nuniform float uPersp;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `{
    vec3 V = uPersp > 0.5 ? normalize(uEye + vViewPosition) : uView;
    outgoingLight *= 1.0 - 0.38 * smoothstep(0.72, 1.0, 1.0 - abs(dot(normal, V)));
  }
  #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => `part|${tapered ? 1 : 0}`;
  return m;
}

// Depth only, a hair behind the parts (so they pass where they're nearest);
// tapered like them on the cylinder. Drawn with the transparent things, after
// what's solid.
function depthOnly(tapered) {
  const m = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  if (tapered) {
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute float taper;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed.xz *= mix(1.0, taper, position.y);');
    };
  }
  m.customProgramCacheKey = () => `depth|${tapered ? 1 : 0}`;
  return m;
}

// The shirt numbers 0-99 in one texture, white (tinted per player).
function numberAtlas() {
  const c = document.createElement('canvas'); c.width = c.height = 640;
  const g = c.getContext('2d');
  g.font = '800 46px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.45)'; g.fillStyle = '#ffffff';
  for (let n = 1; n < 100; n++) {
    const x = (n % 10) * 64 + 32, y = Math.floor(n / 10) * 64 + 35;
    g.strokeText(String(n), x, y); g.fillText(String(n), x, y);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const CAP = { hi: 640, lo: 640, tap: 720, num: 32 };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _d = new THREE.Vector3();
const colors = new Map();
const col = (c) => { let v = colors.get(c); if (!v) { v = new THREE.Color(c); colors.set(c, v); } return v; };
const tint = (c, k) => { const key = `${c}|${k}`; let v = colors.get(key); if (!v) { v = shadeHex(c, k); colors.set(key, v); } return v; };
const tintMix = (c, k, other, u) => { const key = `${c}|${k}|${other}|${u}`; let v = colors.get(key); if (!v) { v = shadeHex(c, k).lerp(new THREE.Color(other), u); colors.set(key, v); } return v; };

// Every player's parts for one frame, as instances of four shapes.
class Batch {
  constructor(s3, opacity) {
    const tap = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false).translate(0, 0.5, 0);
    tap.setAttribute('taper', new THREE.InstancedBufferAttribute(new Float32Array(CAP.tap), 1).setUsage(THREE.DynamicDrawUsage));
    const num = s3.geo.plane.clone();
    num.setAttribute('cell', new THREE.InstancedBufferAttribute(new Float32Array(CAP.num * 2), 2).setUsage(THREE.DynamicDrawUsage));
    if (!s3.numbers) s3.numbers = numberAtlas();
    const numMat = new THREE.MeshBasicMaterial({ map: s3.numbers, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    numMat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute vec2 cell;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = vMapUv * 0.1 + cell;');
    };
    numMat.customProgramCacheKey = () => 'number';
    const make = (geo, mat, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; m.count = 0;
      s3.scene.add(m);
      return { m, n: 0, cap: n };
    };
    const solid = partMaterial(s3, opacity, false);
    this.k = {
      hi: make(s3.geo.sphere, solid, CAP.hi), lo: make(s3.geo.lowSphere, solid, CAP.lo),
      tap: make(tap, partMaterial(s3, opacity, true), CAP.tap), num: make(num, numMat, CAP.num),
    };
    // See-through: the parts' depth first (no colour), then the parts only
    // where they're nearest – one see-through figure, not the face through the
    // back of the head and the shoulders through the shirt.
    this.pre = [];
    if (opacity < 1) {
      for (const name of ['hi', 'lo', 'tap']) {
        const k = this.k[name], m = new THREE.InstancedMesh(k.m.geometry, depthOnly(name === 'tap'), k.cap);
        m.instanceMatrix = k.m.instanceMatrix;
        m.frustumCulled = false; m.count = 0; m.renderOrder = 10;
        s3.scene.add(m);
        this.pre.push([m, k]);
      }
      for (const name in this.k) this.k[name].m.renderOrder = 11;
    }
  }

  begin() { for (const k in this.k) this.k[k].n = 0; }

  end() {
    for (const name in this.k) {
      const k = this.k[name], m = k.m;
      m.count = k.n;
      const up = (attr, size) => { attr.clearUpdateRanges(); attr.addUpdateRange(0, Math.max(1, k.n) * size); attr.needsUpdate = true; };
      up(m.instanceMatrix, 16); up(m.instanceColor, 3);
      if (name === 'tap') up(m.geometry.attributes.taper, 1);
      if (name === 'num') up(m.geometry.attributes.cell, 2);
    }
    for (const [m, k] of this.pre) m.count = k.n;
  }

  // the next instance of a shape, placed by _m (false when the pool is full)
  push(name, color) {
    const k = this.k[name];
    if (k.n >= k.cap) return -1;
    _m.toArray(k.m.instanceMatrix.array, k.n * 16);
    color.toArray(k.m.instanceColor.array, k.n * 3);
    return k.n++;
  }

  // a limb part from a to b, radius ra at a tapering to rb at b
  limb(a, b, ra, rb, color) {
    _d.subVectors(b, a);
    const L = _d.length();
    if (L < 1e-4) return;
    _q.setFromUnitVectors(UP, _d.divideScalar(L));
    _m.compose(a, _q, _v.set(ra, L, ra));
    const i = this.push('tap', color);
    if (i >= 0) this.k.tap.m.geometry.attributes.taper.array[i] = clampN(rb / ra, 0.3, 2);
  }

  // an elliptic tapered section with its own axes (X across, Y along, Z depth)
  section(base, X, Y, Z, r0, len, depth, ratio, color) {
    _m.makeBasis(X, Y, Z).scale(_v.set(r0, len, r0 * depth)).setPosition(base);
    const i = this.push('tap', color);
    if (i >= 0) this.k.tap.m.geometry.attributes.taper.array[i] = clampN(ratio, 0.3, 2);
  }

  // an ellipsoid at c with radii (rx, ry, rz) along the axes of basis (X, Y, Z)
  blob(c, X, Y, Z, rx, ry, rz, color, name = 'hi') {
    _m.makeBasis(X, Y, Z).scale(_v.set(rx, ry, rz)).setPosition(c);
    this.push(name, color);
  }

  ball(c, r, color) { _m.makeScale(r, r, r).setPosition(c); this.push('lo', color); }

  number(c, X, Y, Z, size, n, color) {
    _m.makeBasis(X, Y, Z).scale(_v.set(size, size, 1)).setPosition(c);
    const i = this.push('num', color);
    if (i >= 0) { const a = this.k.num.m.geometry.attributes.cell.array; a[i * 2] = (n % 10) * 0.1; a[i * 2 + 1] = 1 - (Math.floor(n / 10) + 1) * 0.1; }
  }
}

// One player's parts on his skeleton (world joints Jw), into batch B.
function emitPlayer(B, Jw, look, H, wd) {
  const J = {};
  for (const k in Jw) J[k] = V(Jw[k]);
  const skin = col(look.skin), shirt = col(look.shirt), shorts = col(look.shorts), socks = col(look.socks), trim = col(look.trim), boots = col(look.boots);
  const hairM = col(look.hairColor);
  const bulk = (0.85 + 0.3 * (wd - 0.8)) * (look.female ? 0.9 : 1);
  const fem = !!look.female;

  // ---- legs
  for (const s of ['L', 'R']) {
    const hip = J['hip' + s], knee = J['knee' + s], ank = J['foot' + s], toe = J['toe' + s];
    B.limb(hip, lerpV(hip, knee, 0.58), 0.064 * bulk * H, 0.056 * bulk * H, shorts);
    B.limb(lerpV(hip, knee, 0.5), knee, 0.048 * bulk * H, 0.034 * bulk * H, skin);
    B.ball(knee, 0.035 * bulk * H, skin);
    const calf = lerpV(knee, ank, 0.34);
    B.limb(lerpV(knee, ank, 0.05), calf, 0.034 * bulk * H, 0.041 * bulk * H, socks);
    B.limb(calf, ank, 0.041 * bulk * H, 0.024 * bulk * H, socks);
    B.limb(lerpV(knee, ank, 0.1), lerpV(knee, ank, 0.15), 0.037 * bulk * H, 0.037 * bulk * H, trim);
    B.ball(ank, 0.025 * bulk * H, socks);
    // boot: heel to a rounded toe
    const heel = lerpV(ank, toe, -0.2), fwd = toe.clone().sub(heel), fl = fwd.length() || 1;
    fwd.divideScalar(fl);
    const side = new THREE.Vector3(0, 0, 1).cross(fwd).normalize(), up = fwd.clone().cross(side).normalize();
    B.blob(lerpV(heel, toe, 0.5).addScaledVector(up, -0.008 * H), fwd, side, up, fl * 0.62, 0.032 * H, 0.03 * H, boots);
  }

  // ---- torso: shorts, then a shirt that tapers from the hips to the shoulders
  const hc = J.hc, neck = J.neck, shL = J.shL, shR = J.shR;
  const Y = neck.clone().sub(hc), tl = Y.length(); Y.divideScalar(tl || 1);
  const X = shR.clone().sub(shL); X.addScaledVector(Y, -X.dot(Y)).normalize();
  const Z = X.clone().cross(Y).normalize();
  const facing = J.nose.clone().sub(J.head);
  if (Z.dot(facing) < 0) Z.negate();
  const shHalf = shR.distanceTo(shL) / 2 + 0.035 * H;
  const hipHalf = J.hipR.distanceTo(J.hipL) / 2 + 0.06 * H * wd;
  const waistHalf = fem ? Math.min(shHalf, hipHalf) * 0.8 : Math.max(shHalf * 0.82, hipHalf * 0.95);
  const along = (u) => hc.clone().addScaledVector(Y, u * tl);
  // an elliptic tapered section across the body (X), d: depth / width
  const section = (u0, u1, r0, r1, d0, d1, c) => B.section(along(u0), X, Y, Z, r0, (u1 - u0) * tl, (d0 + d1) / 2, r1 / r0, c);
  section(-0.32, 0.16, hipHalf, hipHalf * 0.98, 0.66, 0.66, shorts);
  section(0.12, 0.5, hipHalf * 0.97, waistHalf, 0.66, 0.62, shirt);
  section(0.48, 0.97, waistHalf, shHalf, fem ? 0.7 : 0.62, 0.55, shirt);
  // collar and neck
  B.limb(along(0.94), along(1.0), 0.05 * H, 0.046 * H, trim);
  B.limb(neck.clone().addScaledVector(Y, -0.02 * H), lerpV(neck, J.head, 0.6), 0.036 * bulk * H, 0.031 * bulk * H, skin);
  // number on the back
  if (look.number) {
    const c = along(0.66).addScaledVector(Z, -waistHalf * 0.64 - 0.004);
    B.number(c, X, Y, Z.clone().negate(), 0.17 * H, clampN(look.number | 0, 1, 99), trim);
  }

  // ---- arms
  for (const s of ['L', 'R']) {
    const sh = J['sh' + s], el = J['el' + s], hand = J['hand' + s];
    B.ball(sh, 0.05 * bulk * H, shirt);
    if (look.longSleeves) {
      B.limb(sh, el, 0.043 * bulk * H, 0.033 * bulk * H, shirt);
      B.ball(el, 0.032 * bulk * H, shirt);
      B.limb(el, hand, 0.033 * bulk * H, 0.026 * bulk * H, shirt);
    } else {
      B.limb(sh, lerpV(sh, el, 0.55), 0.044 * bulk * H, 0.037 * bulk * H, shirt);
      B.limb(lerpV(sh, el, 0.5), el, 0.03 * bulk * H, 0.024 * bulk * H, skin);
      B.ball(el, 0.024 * bulk * H, skin);
      B.limb(el, hand, 0.025 * bulk * H, 0.019 * bulk * H, skin);
    }
    // the hand along the forearm: a keeper's padded glove with a dark cuff
    const d = hand.clone().sub(el).normalize();
    const sideV = d.clone().cross(Z); if (sideV.lengthSq() < 1e-6) sideV.set(1, 0, 0); sideV.normalize();
    const nrm = sideV.clone().cross(d).normalize();
    if (look.gloves) {
      B.limb(hand.clone().addScaledVector(d, -0.03 * H), hand.clone().addScaledVector(d, 0.005 * H), 0.03 * H, 0.031 * H, tint(look.gloves, -0.45));
      B.blob(hand.clone().addScaledVector(d, 0.05 * H), sideV, d, nrm, 0.042 * H, 0.06 * H, 0.03 * H, col(look.gloves));
    } else {
      B.blob(hand.clone().addScaledVector(d, 0.035 * H), sideV, d, nrm, 0.024 * H, 0.042 * H, 0.016 * H, skin);
    }
  }

  // ---- head, face and hair
  const hp = J.head, r = 0.094 * H;
  const f = facing.normalize(), up = J.headUp.clone().sub(hp).normalize(), sd = J.headR.clone().sub(hp).normalize();
  const at = (a, b, c) => hp.clone().addScaledVector(f, a * r).addScaledVector(up, b * r).addScaledVector(sd, c * r);
  B.blob(hp, sd, up, f, r, r * 1.04, r, skin);
  for (const e of [-1, 1]) B.blob(at(-0.02, 0.0, e * 0.96), f, up, sd, r * 0.13, r * 0.22, r * 0.09, skin);
  // eyes, brows, nose, mouth
  const dark = col('#2a1a12'), white = col('#fbfaf6');
  for (const e of [-1, 1]) {
    B.blob(at(0.84, 0.12, e * 0.36), sd, up, f, r * 0.16, r * 0.12, r * 0.08, white);
    B.ball(at(0.9, 0.11, e * 0.35), r * 0.08, dark);
    B.blob(at(0.86, 0.36, e * 0.37), sd, up, f, r * 0.19, r * 0.045, r * 0.05, tint(look.hairColor, -0.1));
    if (fem) B.blob(at(0.88, 0.22, e * 0.44), sd, up, f, r * 0.17, r * 0.03, r * 0.04, dark); // lashes
  }
  B.blob(at(1.0, -0.08, 0), sd, up, f, r * 0.09, r * 0.13, r * 0.1, tint(look.skin, -0.12));
  B.blob(at(0.88, -0.42, 0), sd, up, f, r * (fem ? 0.2 : 0.18), r * (fem ? 0.075 : 0.045), r * 0.06, col(fem ? '#b4524c' : '#7a2e26'));
  // facial hair
  const beard = look.beard | 0;
  if (beard === 1) B.blob(at(0.45, -0.45, 0), sd, up, f, r * 0.82, r * 0.55, r * 0.62, tintMix(look.hairColor, 0.35, look.skin, 0.55));
  else if (beard === 2) B.blob(at(0.52, -0.55, 0), sd, up, f, r * 0.72, r * 0.5, r * 0.55, hairM);
  else if (beard === 3) B.blob(at(0.93, -0.28, 0), sd, up, f, r * 0.24, r * 0.05, r * 0.06, hairM);
  else if (beard === 4) B.blob(at(0.8, -0.72, 0), sd, up, f, r * 0.17, r * 0.2, r * 0.15, hairM);
  // hair
  const style = look.hair | 0;
  const cap = (k = 1.02, c = hairM) => B.blob(at(-0.24, 0.24, 0), sd, up, f, r * k, r * k, r * k, c);
  switch (style) {
    case 1: cap(); break;
    case 2: cap(1.0, tintMix(look.hairColor, 0, look.skin, 0.45)); break;
    case 3: cap(); B.blob(at(-0.48, -0.55, 0), sd, up, f, r * 0.98, r * 1.15, r * 0.62, hairM); break;
    case 4: B.blob(at(-0.15, 0.32, 0), sd, up, f, r * 1.4, r * 1.35, r * 1.35, hairM); break;
    case 5: cap(1.0, tintMix(look.hairColor, 0, look.skin, 0.55)); B.blob(at(-0.1, 0.98, 0), sd, up, f, r * 0.16, r * 0.24, r * 0.98, hairM); break;
    case 6: cap(); B.ball(at(-1.0, 0.0, 0), r * 0.34, hairM); B.blob(at(-1.12, -0.6, 0), sd, up, f, r * 0.24, r * 0.5, r * 0.24, hairM); break;
    case 7: cap(); B.ball(at(-0.48, 1.0, 0), r * 0.4, hairM); break;
    case 8: cap(); for (let i = 0; i < 7; i++) { const a = -1.3 + i * 0.43; B.ball(at(-0.2, Math.cos(a) * 0.86, Math.sin(a) * 0.86), r * 0.3, hairM); } break;
    case 9: cap(); B.blob(at(0.62, 0.62, 0.3), sd, up, f, r * 0.5, r * 0.22, r * 0.24, hairM); break;
    case 10: cap(); B.blob(at(-0.22, -0.15, 0), sd, up, f, r * 1.12, r * 1.02, r * 1.0, hairM); B.blob(at(0.62, 0.6, 0), sd, up, f, r * 0.62, r * 0.24, r * 0.25, hairM); break;
    case 11: cap(); for (const e of [-1, 1]) for (let i = 0; i < 4; i++) B.ball(at(-0.45, -0.35 - 0.42 * i, e * 0.72), r * (0.27 - 0.03 * i), hairM); break;
    default: break; // bald
  }
}

// ------------------------------------------------------------ ball, trail, particles

// A football's pattern: dark patches where an icosahedron's corners are (its pentagons)
function paintBall(g, base, patch) {
  g.fillStyle = base; g.fillRect(0, 0, 256, 128);
  const t = (1 + Math.sqrt(5)) / 2, vs = [];
  for (const a of [-1, 1]) for (const b of [-t, t]) vs.push([0, a, b], [a, b, 0], [b, 0, a]);
  g.fillStyle = patch;
  for (const [vx, vy, vz] of vs) {
    const l = Math.hypot(vx, vy, vz), lat = Math.asin(vz / l), lon = Math.atan2(vy, vx);
    const px = (lon / (2 * Math.PI) + 0.5) * 256, py = (0.5 - lat / Math.PI) * 128;
    g.beginPath(); g.ellipse(px, py, 15 / Math.max(0.35, Math.cos(lat)), 15, 0, 0, Math.PI * 2); g.fill();
  }
}

// The ball's trail: a ribbon facing the viewer, tapering to nothing behind
// it – the last 0.12 s of a fast ball, 0.3 s of a curling one (golden).
class Trail {
  constructor(s3) {
    this.s3 = s3; this.pts = []; this.N = 28;
    const N = this.N, geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(N * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(N * 8), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos); geo.setAttribute('color', this.col);
    const idx = [];
    for (let i = 0; i < N - 1; i++) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false; this.mesh.visible = false;
    s3.scene.add(this.mesh);
    this.t = 0;
  }

  update(p, show, curving, r, dt) {
    this.t += dt;
    this.pts.push({ x: p[0], y: p[1], z: p[2], t: this.t });
    const keep = curving ? 0.3 : 0.12;
    while (this.pts.length > this.N || (this.pts.length > 2 && this.t - this.pts[0].t > keep)) this.pts.shift();
    const n = this.pts.length;
    this.mesh.visible = show && n > 2;
    if (!this.mesh.visible) return;
    const P = this.pos.array, C = this.col.array, s3 = this.s3, persp = s3.uPersp.value > 0.5, V = s3.uView.value, E = s3.uEye.value;
    const rgb = curving ? [1, 0.84, 0.4] : [1, 1, 1], a0 = curving ? 0.5 : 0.34;
    for (let i = 0; i < this.N; i++) {
      const k = Math.min(i, n - 1), q = this.pts[k], q0 = this.pts[Math.max(0, k - 1)], q1 = this.pts[Math.min(n - 1, k + 1)];
      // across the trail, square to it and to the line of sight
      const tx = q1.x - q0.x, ty = q1.y - q0.y, tz = q1.z - q0.z;
      const vx = persp ? E.x - q.x : V.x, vy = persp ? E.y - q.y : V.y, vz = persp ? E.z - q.z : V.z;
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz) || 1, u = n > 1 ? k / (n - 1) : 1, w = r * (0.1 + 0.9 * u) / sl;
      sx *= w; sy *= w; sz *= w;
      P[i * 6] = q.x + sx; P[i * 6 + 1] = q.y + sy; P[i * 6 + 2] = q.z + sz;
      P[i * 6 + 3] = q.x - sx; P[i * 6 + 4] = q.y - sy; P[i * 6 + 5] = q.z - sz;
      const a = i < n ? a0 * u * u : 0;
      for (const o of [0, 4]) { C[i * 8 + o] = rgb[0]; C[i * 8 + o + 1] = rgb[1]; C[i * 8 + o + 2] = rgb[2]; C[i * 8 + o + 3] = a; }
    }
    this.pos.needsUpdate = true; this.col.needsUpdate = true;
  }
}

// A soft round dot (the puffs' shape)
function softDot() {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

// A pool of particles (scene space), one draw call; the dead ones swapped out.
class Particles {
  constructor(s3, cap, soft) {
    this.cap = cap; this.n = 0;
    this.p = new Float32Array(cap * 3); this.v = new Float32Array(cap * 3);
    this.age = new Float32Array(cap); this.life = new Float32Array(cap); this.a = new Float32Array(cap); this.g = new Float32Array(cap);
    this.rgb = new Float32Array(cap * 3);
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos); geo.setAttribute('color', this.col); geo.setDrawRange(0, 0);
    this.soft = soft;
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, map: soft ? softDot() : null }));
    this.points.frustumCulled = false;
    s3.scene.add(this.points);
  }

  emit(x, y, z, vx, vy, vz, life, color, alpha, grav) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.age[i] = 0; this.life[i] = life; this.a[i] = alpha; this.g[i] = grav;
    this.rgb[i * 3] = color.r; this.rgb[i * 3 + 1] = color.g; this.rgb[i * 3 + 2] = color.b;
  }

  step(dt, px) {
    const { p, v } = this;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        // (the last one into its place)
        const j = --this.n;
        for (let k = 0; k < 3; k++) { p[i * 3 + k] = p[j * 3 + k]; v[i * 3 + k] = v[j * 3 + k]; this.rgb[i * 3 + k] = this.rgb[j * 3 + k]; }
        this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.a[i] = this.a[j]; this.g[i] = this.g[j];
        i--; continue;
      }
      const drag = Math.exp(-dt * (this.soft ? 3 : 1.2));
      v[i * 3] *= drag; v[i * 3 + 1] *= drag; v[i * 3 + 2] = v[i * 3 + 2] * drag - this.g[i] * dt;
      p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
      if (p[i * 3 + 2] < 0.01) { p[i * 3 + 2] = 0.01; v[i * 3] *= 0.5; v[i * 3 + 1] *= 0.5; v[i * 3 + 2] = 0; }
    }
    const P = this.pos.array, C = this.col.array;
    for (let i = 0; i < this.n; i++) {
      const u = this.age[i] / this.life[i];
      P[i * 3] = p[i * 3]; P[i * 3 + 1] = p[i * 3 + 1]; P[i * 3 + 2] = p[i * 3 + 2];
      C[i * 4] = this.rgb[i * 3]; C[i * 4 + 1] = this.rgb[i * 3 + 1]; C[i * 4 + 2] = this.rgb[i * 3 + 2];
      C[i * 4 + 3] = this.a[i] * (this.soft ? (1 - u) * Math.min(1, u * 8) : 1 - u * u);
    }
    this.points.geometry.setDrawRange(0, this.n);
    this.points.visible = this.n > 0;
    this.points.material.size = px;
    if (this.n) {
      this.pos.clearUpdateRanges(); this.pos.addUpdateRange(0, this.n * 3); this.pos.needsUpdate = true;
      this.col.clearUpdateRanges(); this.col.addUpdateRange(0, this.n * 4); this.col.needsUpdate = true;
    }
  }
}
