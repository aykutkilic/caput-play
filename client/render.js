// Minimal isometric renderer (Canvas 2D, orthographic camera) with procedural
// skeletal animation: every pose is computed from simulation state each frame,
// so animations stay fluid and always agree with what the physics is doing.

import { GOAL_DEPTH, BALL_R, ST, ROLE, PHASE, KICK, SP, SKILL, KH, PART, GKB } from '../shared/constants.js';
import { stats } from '../shared/physique.js';
import { CHG_MAX, pitchOf, DIVE_BASE, DIVE_SPAN, diveReach, SIDEARM_MAX, teamDir } from '../shared/sim.js';
import { skeleton, drawFigure } from './figure.js';
import { Scene3D } from './mesh3d.js';

export { skeleton, drawFigure };

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (u) => u * u * (3 - 2 * u);
const mix = (a, b, u) => a + (b - a) * u;

const KICK_LABEL = ['', 'PASS', 'RUN', 'SHOT', 'SELF'];
const HEIGHT_LABEL = ['feet', 'chest', 'head'];
const SHOT_HEIGHT = ['low', 'mid', 'top'];

export const TEAM_COLORS = [
  { shirt: '#e5483b', shorts: '#f4f1ea', socks: '#e5483b', trim: '#ffffff', gk: '#f2c230', gkShorts: '#2b2b2b', gkTrim: '#1e1e1e', ui: '#ff6a5c' },
  { shirt: '#2f6be0', shorts: '#14264f', socks: '#2f6be0', trim: '#d6e4ff', gk: '#3fd08f', gkShorts: '#1c2c24', gkTrim: '#0f2a1d', ui: '#5b91ff' },
];

export const CAMERAS = {
  iso: { name: 'Isometric', yaw: 45, elev: 33 },
  iso30: { name: 'Isometric (shallow)', yaw: 30, elev: 36 },
  side: { name: 'Classic side', yaw: 0, elev: 46 },
  tp: { name: 'Third person', tp: true },
};

export function lookFor(avatar, team, role) {
  const tc = TEAM_COLORS[team] || TEAM_COLORS[0];
  const gk = role === ROLE.GK;
  const a = avatar || {};
  return {
    shirt: gk ? tc.gk : tc.shirt,
    shorts: gk ? tc.gkShorts : tc.shorts,
    socks: gk ? tc.gk : tc.socks,
    trim: gk ? tc.gkTrim : tc.trim,
    skin: a.skin || '#e0ac69',
    hair: a.hair ?? 1,
    hairColor: a.hairColor || '#2b1b10',
    beard: a.beard || 0,
    boots: a.boots || '#111111',
    gloves: gk ? '#f7f7f7' : null,
    longSleeves: gk,
    number: a.number || 0,
    female: a.sex === 1,
  };
}

// ---------------------------------------------------------------- camera

export class Camera {
  constructor() {
    this.w = 800; this.h = 600; this.cx = 0; this.cy = 0; this.scale = 30;
    this.set(45, 33);
  }
  set(yawDeg, elevDeg) {
    this.yaw = yawDeg; this.elev = elevDeg;
    this.c = Math.cos(yawDeg * D2R); this.s = Math.sin(yawDeg * D2R);
    this.se = Math.sin(elevDeg * D2R); this.ce = Math.cos(elevDeg * D2R);
  }
  px(x, y, z) {
    const dx = x - this.cx, dy = y - this.cy;
    return this.w / 2 + (dx * this.c - dy * this.s) * this.scale;
  }
  py(x, y, z) {
    const dx = x - this.cx, dy = y - this.cy;
    return this.h / 2 + ((dx * this.s + dy * this.c) * this.se - z * this.ce) * this.scale;
  }
  depth(x, y) { return x * this.s + y * this.c; }
  // This projection as a world -> clip matrix (row-major) for the 3D layer:
  // the same screen position, depth growing away from the viewer.
  clipMatrix(D = 300) {
    const k1 = this.scale * 2 / this.w, k2 = this.scale * 2 / this.h, c = this.c, s = this.s, se = this.se, ce = this.ce;
    const t = this.cx * s + this.cy * c;
    return [
      c * k1, -s * k1, 0, (-this.cx * c + this.cy * s) * k1,
      -s * se * k2, -c * se * k2, ce * k2, t * se * k2,
      -s * ce / D, -c * ce / D, -se / D, t * ce / D,
      0, 0, 0, 1,
    ];
  }
  // screen direction (x right, y down) -> world ground direction
  screenDirToWorld(sx, sy) {
    const yr = sy; // down on screen == towards the viewer on the ground plane
    return [sx * this.c + yr * this.s, -sx * this.s + yr * this.c];
  }
}

// Third person: a perspective camera behind a player, with the same
// interface as Camera (px / py / depth / scale / screenDirToWorld) plus what
// perspective needs – camera space for clipping at the near plane, and the
// scale at a given point. Screen right is 90 degrees anticlockwise of the
// view, as in the isometric views, so the pitch is never mirrored.
export class PerspCam {
  constructor() {
    this.persp = true;
    this.w = 800; this.h = 600; this.ex = 0; this.ey = 0; this.ez = 1.7;
    this.yaw = 0; this.pitch = -0.12; this.near = 0.25; this.fov = 72 * D2R;
    this.update();
  }
  update() {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.F = [cy * cp, sy * cp, sp]; this.R = [-sy, cy, 0]; this.U = [-cy * sp, -sy * sp, cp];
    // a wide screen sees more across, not less up and down (a phone held
    // sideways a little more of both: the ball at his feet stays in view)
    const fov = this.w / this.h > 1.8 ? 78 * D2R : this.fov;
    this.f = Math.min(this.h / 2 / Math.tan(fov / 2), this.w / 2 / Math.tan(50 * D2R));
    this.cx = this.ex; this.cy = this.ey;
    // what code written for the orthographic camera reads: the view straight ahead
    this.c = -sy; this.s = -cy; this.se = Math.max(0.05, Math.sin(-this.pitch)); this.ce = Math.cos(this.pitch);
    this.scale = this.f / 10; // (sizes not tied to a point: as seen from 10 m)
  }
  toCam(x, y, z) {
    const dx = x - this.ex, dy = y - this.ey, dz = z - this.ez, R = this.R, U = this.U, F = this.F;
    return [dx * R[0] + dy * R[1], dx * U[0] + dy * U[1] + dz * U[2], dx * F[0] + dy * F[1] + dz * F[2]];
  }
  sx(c) { return this.w / 2 + this.f * c[0] / Math.max(this.near, c[2]); }
  sy(c) { return this.h / 2 - this.f * c[1] / Math.max(this.near, c[2]); }
  px(x, y, z) { return this.sx(this.toCam(x, y, z)); }
  py(x, y, z) { return this.sy(this.toCam(x, y, z)); }
  depth(x, y) { return -((x - this.ex) * this.F[0] + (y - this.ey) * this.F[1]); } // nearer = bigger
  // world -> clip (row-major) for the 3D layer
  clipMatrix(near = 0.1, far = 500) {
    const kx = this.f / (this.w / 2), ky = this.f / (this.h / 2), R = this.R, U = this.U, F = this.F;
    const dot = (a) => a[0] * this.ex + a[1] * this.ey + a[2] * this.ez;
    const A = (far + near) / (far - near), B = -2 * far * near / (far - near);
    return [
      kx * R[0], kx * R[1], kx * R[2], -kx * dot(R),
      ky * U[0], ky * U[1], ky * U[2], -ky * dot(U),
      A * F[0], A * F[1], A * F[2], -A * dot(F) + B,
      F[0], F[1], F[2], -dot(F),
    ];
  }
  ahead(x, y, z, m = 0) { return this.toCam(x, y, z)[2] > this.near + m; }
  sc(x, y, z) { return this.f / Math.max(this.near, this.toCam(x, y, z)[2]); }
  // the stick: up is where I'm looking
  screenDirToWorld(sx, sy) {
    const fx = Math.cos(this.yaw), fy = Math.sin(this.yaw);
    return [-fy * sx - fx * sy, fx * sx - fy * sy];
  }
  // an orthographic stand-in for drawing one figure at (x, y, z): the real
  // projection, with the scale and the view's angles at that point
  local(x, y, z) {
    const dx = x - this.ex, dy = y - this.ey, a = Math.atan2(dy, dx), down = Math.atan2(this.ez - z, Math.hypot(dx, dy));
    return {
      persp: true, px: (X, Y, Z) => this.px(X, Y, Z), py: (X, Y, Z) => this.py(X, Y, Z), depth: (X, Y) => this.depth(X, Y),
      scale: this.sc(x, y, z), c: -Math.sin(a), s: -Math.cos(a), se: Math.max(0.03, Math.sin(down)), ce: Math.cos(down),
    };
  }
}

// Clips a polygon (camera-space points) to in front of the near plane.
function clipNear(pts, near) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ina = a[2] > near, inb = b[2] > near;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (near - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- pose

function basePose() {
  return {
    lean: 0.04, tw: 0, drop: 0, bob: 0, head: 0,
    lh: 0, lk: 0.12, la: 0.05, rh: 0, rk: 0.12, ra: 0.05,
    lsh: 0.08, lab: 0.12, lel: 0.25, rsh: 0.08, rab: 0.12, rel: 0.25,
    pitch: 0, roll: 0,
  };
}

// lying-down envelope for states that end on the floor
function lieEnv(p, riseTicks = 14) {
  return clamp((p.stDur - p.stT) / riseTicks, 0, 1);
}

// Two-bone IK: hip / knee / abduction angles that put a foot at (df forward,
// dr sideways, du up) from its hip, blended in by e. side: 1 = right leg.
function legIK(P, side, df, dr, du, H, e) {
  const thigh = 0.262 * H, shin = 0.262 * H;
  // leg plane tilted sideways towards the target (the skeleton draws the shin's
  // sideways part at 0.6, hence the correction), then a planar 2-bone solve
  const k = (thigh + shin) / (thigh + 0.6 * shin);
  const abd = clamp(Math.atan2(dr * side * k, Math.hypot(df, du)), -0.4, 1.2), ca = Math.cos(abd);
  const D = clamp(Math.hypot(df, du) / ca, 0.2 * H, (thigh + shin) * 0.995);
  const phi = Math.atan2(df, -du);
  const al = Math.acos(clamp((thigh * thigh + D * D - shin * shin) / (2 * thigh * D), -1, 1));
  const kn = Math.PI - Math.acos(clamp((thigh * thigh + shin * shin - D * D) / (2 * thigh * shin), -1, 1));
  if (side > 0) { P.rh = mix(P.rh, phi + al, e); P.rk = mix(P.rk, kn, e); P.ra = mix(P.ra, abd, e); }
  else { P.lh = mix(P.lh, phi + al, e); P.lk = mix(P.lk, kn, e); P.la = mix(P.la, abd, e); }
}

// Two-bone IK for one arm: put the hand at (tf forward, tr sideways, tz up)
// from the player's feet, given the body's lean / drop / twist in P; the elbow
// bends down and back, as an arm does. side: 1 = right arm. Blended in by e.
function armIK(P, side, tf, tr, tz, H, e) {
  if (e <= 0) return;
  const up = 0.165 * H, fo = 0.165 * H, torso = 0.285 * H, shW = 0.118 * H * 0.9;
  const nz = 0.53 * H - P.drop + torso * Math.cos(P.lean), nx = torso * Math.sin(P.lean);
  const sx = nx - Math.sin(P.tw) * shW * side, sy = Math.cos(P.tw) * shW * side, sz = nz - 0.025 * H;
  const f = tf - sx, out = (tr - sy) * side, u = tz - sz;
  // arm plane tilted outwards towards the target (in the skeleton the hand's
  // sideways offset is sin(abd) x (upper + 0.85 fore), whatever the elbow
  // does), then a planar solve in that plane
  const abd = Math.asin(clamp(out / (up + 0.85 * fo), -0.75, 0.97)), ca = Math.cos(abd);
  const D = clamp(Math.hypot(f, u) / ca, 0.08 * H, (up + fo) * 0.995);
  const phi = Math.atan2(f, -u);
  const al = Math.acos(clamp((up * up + D * D - fo * fo) / (2 * up * D), -1, 1));
  const el = Math.PI - Math.acos(clamp((up * up + fo * fo - D * D) / (2 * up * fo), -1, 1));
  const th = phi - al - P.lean * 0.6;
  if (side > 0) { P.rsh = mix(P.rsh, th, e); P.rab = mix(P.rab, abd, e); P.rel = mix(P.rel, el, e); }
  else { P.lsh = mix(P.lsh, th, e); P.lab = mix(P.lab, abd, e); P.lel = mix(P.lel, el, e); }
}
// Both hands on / round a ball at (f, r, z): either side of it, a little behind
// its centre – a keeper's "W".
function handsTo(P, f, r, z, H, e, apart = 0.105) {
  armIK(P, -1, f - 0.04, r - apart, z, H, e);
  armIK(P, 1, f - 0.04, r + apart, z, H, e);
}

export function poseFor(p, ctx) {
  const P = basePose();
  const H = ctx.H;
  const hipH = 0.53 * H;
  const sp = ctx.speed;
  const A = clamp(sp / 7.5, 0, 1.15);
  const ph = ctx.phase;
  const s = Math.sin(ph), c = Math.cos(ph);
  const t = ctx.time;

  // locomotion (base layer): legs, counter-swinging arms, shoulders twisting
  // against the hips, knees lifting higher at a sprint, head kept level.
  // Moving backwards (back-pedalling) the cycle runs the other way, shorter
  // and more upright; sideways at a modest pace it's a side-step shuffle.
  const vt = Math.max(0.5, sp), back = clamp(-(ctx.vf || 0) / vt, 0, 1);
  const shuffle = clamp((Math.abs(ctx.vl || 0) / vt - 0.6) / 0.3, 0, 1) * clamp((5.5 - sp) / 2, 0, 1);
  const lift = (1.2 + 0.4 * Math.max(0, A - 0.8)) * (1 - 0.5 * back);
  const swing = A * 0.8 * (1 - 2 * back) * (1 - 0.3 * back);
  P.lh = swing * s; P.rh = -swing * s;
  P.lk = 0.12 + A * (0.25 + lift * Math.max(0, c));
  P.rk = 0.12 + A * (0.25 + lift * Math.max(0, -c));
  P.lsh = -A * 0.78 * s; P.rsh = A * 0.78 * s;
  P.lel = P.rel = 0.3 + A * 1.05;
  P.tw = -0.24 * A * s;
  P.lean = 0.04 + A * 0.2 * (1 - 1.3 * back) + (1 - Math.min(1, A * 3)) * 0.015 * Math.sin(t * 2.1);
  if (shuffle > 0) {
    // side-step: the leading leg steps out, the other closes up to it; knees
    // bent, on the toes, no stride
    const lead = (ctx.vl || 0) > 0 ? 1 : -1, open = 0.5 + 0.5 * s;
    const outL = lead < 0 ? open : 1 - open, outR = lead > 0 ? open : 1 - open;
    P.lh = mix(P.lh, 0.28, shuffle); P.rh = mix(P.rh, 0.28, shuffle);
    P.lk = mix(P.lk, 0.55 + 0.15 * outR, shuffle); P.rk = mix(P.rk, 0.55 + 0.15 * outL, shuffle);
    P.la = mix(P.la, 0.06 + 0.3 * outL, shuffle); P.ra = mix(P.ra, 0.06 + 0.3 * outR, shuffle);
    P.tw *= 1 - shuffle; P.lsh *= 1 - shuffle; P.rsh *= 1 - shuffle;
  }
  P.head = -P.lean * 0.55;
  P.bob = A * 0.05 * Math.abs(s);
  if (A < 0.25) {
    // standing: breathing and a slow weight shift
    const q = 1 - A * 4, ws = Math.sin(t * 0.9 + p.id);
    P.lh += 0.05 * ws * q; P.rh -= 0.05 * ws * q; P.roll += 0.03 * ws * q;
    P.lab = P.rab = 0.14 + 0.03 * Math.sin(t * 2.1) * q;
  }

  if (ctx.gkStance > 0) {
    // ready position: knees bent, weight forward, hands out in front at waist
    // height, palms to the ball – higher and wider once a shot could come
    const g = ctx.gkStance * (1 - Math.min(1, A * 1.5)), set = ctx.gkSet || 0;
    P.lh += 0.35 * g; P.rh += 0.35 * g; P.lk += 0.55 * g; P.rk += 0.55 * g;
    P.la = P.ra = 0.05 + 0.12 * g; P.drop += (0.07 + 0.03 * set) * H * g; P.lean += (0.3 + 0.06 * set) * g;
    P.bob += 0.022 * Math.abs(Math.sin(t * 6.5 + p.id)) * g; // on his toes
    const sway = 0.012 * H * Math.sin(t * 3.1 + p.id);
    for (const side of [-1, 1]) armIK(P, side, (0.24 + 0.03 * set) * H, side * (0.17 + 0.04 * set) * H, (0.53 + 0.07 * set) * H + sway, H, g);
  }
  if (ctx.reach) {
    // hands to the ball coming at him, the catch shaped by its height:
    //  * along the ground: a stoop (legs straight and together, bent at the
    //    waist, palms up behind it) for one straight at him; a long barrier
    //    (side-on, down on one knee behind the hands) for a hard or skidding one
    //  * shin to waist: down behind it, scooped up
    //  * waist to chest: the basket – forearms under it, pulled into the stomach
    //  * chest to head: the W – hands behind it, thumbs together
    //  * above the head: the high catch – arms up straight
    const r = ctx.reach, zr = r.z / H, e = r.e;
    if (zr < 0.2) {
      if (r.fast || Math.abs(r.r) > 0.12 * H) {
        const side = r.r >= 0 ? -1 : 1; // the knee away from the ball goes down
        P.drop += 0.26 * H * e; P.lean += 0.5 * e; P.roll += 0.12 * side * e;
        legIK(P, side, -0.24 * H, side * 0.02 * H, -(0.53 * H - P.drop) + 0.03, H, e); // shin back along the grass
        if (side > 0) { P.lh = mix(P.lh, 1.2, e); P.lk = mix(P.lk, 1.5, e); } else { P.rh = mix(P.rh, 1.2, e); P.rk = mix(P.rk, 1.5, e); }
      } else {
        P.lh = mix(P.lh, 0.15, e); P.rh = mix(P.rh, 0.15, e); P.lk = mix(P.lk, 0.18, e); P.rk = mix(P.rk, 0.18, e);
        P.la = mix(P.la, 0.02, e); P.ra = mix(P.ra, 0.02, e); P.lean += 0.95 * e; P.drop += 0.03 * H * e;
      }
      handsTo(P, r.f, r.r, r.z - 0.03, H, e, 0.075);
    } else {
      const low = clamp((0.55 * H - r.z) / (0.4 * H), 0, 1) * e;
      P.drop += 0.12 * H * low; P.lean += 0.35 * low; P.lk += 0.4 * low; P.rk += 0.4 * low; P.lh += 0.3 * low; P.rh += 0.3 * low;
      const basket = zr > 0.42 && zr < 0.72 ? e : 0, high = clamp((zr - 1.05) / 0.12, 0, 1) * e;
      P.lean += 0.12 * basket - 0.15 * high;
      handsTo(P, r.f, r.r, r.z - 0.06 * basket, H, e, 0.1 - 0.03 * low - 0.025 * basket);
    }
  }
  if (ctx.holdAt) {
    // cradling it: both hands round the ball, elbows tucked
    const h = ctx.holdAt;
    handsTo(P, h.f, h.r, h.z, H, 1, 0.1);
  }
  if (ctx.windup) {
    // holding a pass / shot: the kicking leg draws back as the gauge fills, so
    // on release the foot comes straight through
    const { u, big } = ctx.windup;
    P.rh = mix(P.rh, -0.8 * big, u); P.rk = mix(P.rk, 0.2 + 1.4 * big, u); P.tw = mix(P.tw, 0.3, u);
    P.lsh = mix(P.lsh, 0.55, u); P.lab = mix(P.lab, 0.9, u); P.rsh = mix(P.rsh, -0.35, u); P.rab = mix(P.rab, 0.45, u);
    P.lean = mix(P.lean, 0.02 - 0.1 * big, u);
  }
  if (ctx.throwIn) handsTo(P, -0.02 * H, 0, 1.1 * H, H, 1, 0.1); // both hands on it, above and behind his head
  if (ctx.celebrate) {
    const j = Math.abs(Math.sin(t * 7 + p.id));
    const kind = p.id % 3;
    if (kind === 0) { P.lsh = P.rsh = 2.75; P.lab = P.rab = 0.45; P.lel = P.rel = 0.2; P.bob += 0.18 * j * (A < 0.3 ? 1 : 0.3); }
    else if (kind === 1) { P.lsh = P.rsh = 0.25; P.lab = P.rab = 1.45; P.lel = P.rel = 0.1; P.roll += 0.22 * Math.sin(t * 3); } // aeroplane
    else { P.rsh = 2.6 + 0.3 * Math.sin(t * 9); P.rel = 1.2; P.lsh = 0.3; P.lel = 1.3; P.bob += 0.1 * j; } // fist pump
  }

  if ((p.st === ST.IDLE || p.st === ST.STUMBLE) && p.z > 0.04) {
    const u = clamp(p.z / 0.22, 0, 1);
    P.lh = mix(P.lh, 1.1, u); P.lk = mix(P.lk, 1.7, u); P.rh = mix(P.rh, 0.15, u); P.rk = mix(P.rk, 0.55, u);
  }
  const k = p.stT;
  switch (p.st) {
    case ST.KICK: {
      const big = p.kk === KICK.PASS || p.kk === KICK.THROUGH ? 0.6 : 1;
      const cT = Math.max(1, p.stA), dT = Math.max(cT + 1, p.stDur);
      let rh, rk;
      // (a kick released from a held wind-up starts already drawn back)
      if (k < cT) { const u = cT <= 2 ? 1 : ease(k / cT); rh = -0.8 * big * u; rk = 0.2 + 1.4 * big * u; P.tw = 0.3 * u; }
      else {
        const u = clamp((k - cT) / (dT - cT), 0, 1);
        const f = u < 0.35 ? u / 0.35 : 1 - (u - 0.35) / 0.65;
        rh = mix(0.45, 1.3 * big, Math.min(1, u / 0.35)) * (u < 0.35 ? 1 : f * 0.9 + 0.1);
        rk = 0.15 + 0.2 * u; P.tw = -0.2 * f;
      }
      P.rh = rh; P.rk = rk; P.lh = 0.12; P.lk = 0.3;
      P.lsh = 0.55; P.lab = 0.9; P.rsh = -0.35; P.rab = 0.45; P.lean = 0.02 - 0.1 * big;
      if (ctx.fromHands) {
        // punt: ball held out in front, dropped onto the boot, arms out for
        // balance (a drop kick lets go of it earlier: it lands first)
        const rel = clamp((k / cT - (ctx.dropKick ? 0.2 : 0.45)) / 0.35, 0, 1);
        if (rel < 1) handsTo(P, 0.36 * H, 0, 0.5 * H - 0.08 * H * rel, H, 1 - rel, 0.1);
        P.lsh = mix(P.lsh, 1.2, rel); P.lab = mix(P.lab, 0.85, rel); P.lel = mix(P.lel, 0.4, rel);
        P.rsh = mix(P.rsh, 0.3, rel); P.rab = mix(P.rab, 0.7, rel); P.rel = mix(P.rel, 0.3, rel);
      }
      break;
    }
    case ST.THROW: {
      const cT = Math.max(1, p.stA);
      if (ctx.throwInAnim) {
        // throw-in: ball taken back behind the head, then over it and away
        // with both hands, the arms following through
        const u = k < cT ? ease(k / cT) : 1, f = k < cT ? 0 : clamp((k - cT) / 10, 0, 1);
        P.lean = k < cT ? -0.25 * u : 0.25 * (1 - 0.4 * f);
        P.lh = -0.15; P.rh = 0.35; P.rk = 0.3;
        if (k < cT) handsTo(P, mix(-0.02, -0.14, u) * H, 0, mix(1.1, 1.0, u) * H, H, 1, 0.1);
        else handsTo(P, mix(0.18, 0.4, f) * H, 0, mix(1.1, 0.8, f) * H, H, 1, 0.12);
      } else if (ctx.throwRoll) {
        // rolling it out: down low on one knee's worth, the arm swings back and
        // then through along the grass, the other one forward for balance
        const u = k < cT ? ease(k / cT) : 1, f = k < cT ? 0 : clamp((k - cT) / 14, 0, 1);
        const low = k < cT ? u : 1 - f;
        P.drop = 0.17 * H * low; P.lean = 0.2 + 0.4 * low;
        P.rsh = k < cT ? mix(0.5, -0.85, u) : mix(0.3, 1.25, Math.min(1, f * 2.2)); P.rel = 0.15; P.rab = 0.1;
        P.lsh = 0.95; P.lel = 0.55; P.lab = 0.55;
        P.lh = 0.7 * low + 0.2; P.lk = 0.85 * low + 0.2; P.rh = -0.3 * low; P.rk = 1.2 * low + 0.2;
      } else if (ctx.sidearm) {
        // sidearm: the arm swings back at shoulder height, the body coiled,
        // then whips round flat across the front
        const u = k < cT ? ease(k / cT) : 1, f = k < cT ? 0 : clamp((k - cT) / 12, 0, 1);
        P.rsh = k < cT ? mix(0.6, -1.15, u) : mix(-0.6, 1.35, ease(Math.min(1, f * 1.6))); P.rab = k < cT ? mix(0.4, 1.0, u) : mix(1.0, 0.45, f);
        P.rel = 0.35; P.lsh = 0.9; P.lab = 0.6; P.lel = 0.5;
        P.tw = k < cT ? 0.6 * u : mix(0.6, -0.45, Math.min(1, f * 1.6)); P.lean = 0.12 + 0.1 * f;
        P.lh = 0.5; P.lk = 0.35; P.rh = -0.2; P.rk = 0.4; P.drop = 0.04 * H;
      } else {
        // overarm: the arm goes back behind his head, then whips over and through
        const u = k < cT ? ease(k / cT) : 1, f = k < cT ? 0 : clamp((k - cT) / 14, 0, 1);
        P.rsh = k < cT ? mix(1.0, 3.75, u) : mix(2.2, 0.55, ease(f)); P.rel = k < cT ? 1.1 * u + 0.2 : 0.2; P.rab = 0.22;
        P.lsh = k < cT ? mix(0.6, 1.55, u) : mix(1.55, 0.35, f); P.lel = 0.25; P.lab = 0.3;
        P.lean = k < cT ? -0.22 * u : 0.32 * (1 - 0.5 * f); P.tw = k < cT ? 0.45 * u : -0.35 * (1 - f);
        P.lh = 0.55; P.lk = 0.3; P.rh = -0.25; P.rk = 0.45;
      }
      break;
    }
    case ST.TACKLE: {
      const u = k / Math.max(1, p.stDur);
      const env = u < 0.3 ? u / 0.3 : 1 - (u - 0.3) / 0.7;
      P.rh = 1.05 * env; P.rk = 0.15; P.lh = -0.35 * env; P.lk = 0.5 * env;
      P.drop = 0.1 * H * env; P.lean = 0.3 * env; P.lab = 0.7 * env; P.rsh = -0.4;
      break;
    }
    case ST.SLIDE: {
      const env = Math.min(1, k / 5) * (k > 30 ? lieEnv(p, 20) : 1);
      P.pitch = -1.15 * env; P.drop = hipH * 0.62 * env;
      P.rh = mix(P.rh, 0.35, env); P.rk = mix(P.rk, 0.05, env);
      P.lh = mix(P.lh, 0.95, env); P.lk = mix(P.lk, 1.9, env);
      P.lsh = mix(P.lsh, -0.7, env); P.lab = 0.5 * env; P.rsh = mix(P.rsh, 0.9, env); P.rab = 0.3;
      P.lean = mix(P.lean, 0.15, env);
      break;
    }
    case ST.HEADER: {
      const cT = Math.max(1, p.stA);
      P.lsh = P.rsh = 1.05; P.lab = P.rab = 0.75; P.lel = P.rel = 0.6;
      P.lk = 0.75; P.rk = 0.6; P.lh = 0.25; P.rh = -0.1;
      if (k < cT) P.lean = -0.35 * ease(k / cT);
      else P.lean = mix(0.5, 0.05, clamp((k - cT) / 10, 0, 1));
      P.head = P.lean * 0.5;
      break;
    }
    case ST.VOLLEY: {
      const cT = Math.max(1, p.stA);
      const env = k < cT ? ease(k / cT) : 1 - clamp((k - cT) / (p.stDur - cT), 0, 1);
      P.roll = -0.5 * env; P.rh = 1.45 * env; P.ra = 0.55 * env;
      P.rk = k < cT ? mix(0.9, 0.5, k / cT) : 0.1;
      P.lab = 1.15 * env; P.rab = 0.6 * env; P.lsh = 0.4; P.lean = -0.15 * env;
      P.lk = 0.3;
      break;
    }
    case ST.OVERHEAD: {
      const cT = Math.max(1, p.stA);
      const air = clamp(k / cT, 0, 1);
      let pitch = -2.5 * ease(air);
      // after contact the body unwinds towards landing flat on the back
      const after = clamp((k - cT) / 16, 0, 1);
      if (k > cT) pitch = mix(-2.7, -1.55, ease(after));
      const up = lieEnv(p, 16);
      P.pitch = pitch * up;
      P.drop = hipH * 0.78 * ease(after) * clamp(1 - p.z / 0.8, 0, 1) * up;
      P.rh = (1.3 + 0.6 * air) * up; P.rk = 0.6 * (1 - air);
      P.lh = (0.45 - 0.35 * air) * up; P.lk = 1.0 * up;
      P.lab = P.rab = 1.2 * up; P.lsh = P.rsh = 0.3;
      break;
    }
    case ST.DIVEHEAD: {
      const cT = Math.max(1, p.stA);
      const env = clamp(k / cT, 0, 1) * lieEnv(p, 16);
      P.pitch = 1.45 * env; P.drop = (p.z <= 0.02 && k > cT ? hipH * 0.8 : 0) * env;
      P.lsh = P.rsh = mix(P.lsh, -0.5, env); P.lab = P.rab = 0.6 * env;
      P.lh = P.rh = 0; P.lk = P.rk = 0.15;
      break;
    }
    case ST.DIVE: {
      if (p.spr === GKB.STAR) {
        // star jump: a small hop with arms up and out in a V, legs wide
        const e = clamp(k / 4, 0, 1) * clamp((p.stDur - k) / 8, 0, 1);
        P.lsh = mix(P.lsh, 3.05, e); P.rsh = mix(P.rsh, 3.05, e); P.lab = mix(P.lab, 0.95, e); P.rab = mix(P.rab, 0.95, e);
        P.lel = P.rel = mix(P.lel, 0.08, e);
        P.la = mix(P.la, 0.45, e); P.ra = mix(P.ra, 0.45, e); P.lh = mix(P.lh, 0.06, e); P.rh = mix(P.rh, 0.06, e);
        P.lk = mix(P.lk, 0.18, e); P.rk = mix(P.rk, 0.18, e); P.lean = mix(P.lean, 0.06, e); P.tw *= 1 - e;
        break;
      }
      if (p.spr === GKB.SPLITS) {
        // splits save: the leading leg slid out along the grass to the ball,
        // the other bent under him, body low over it, the near hand down
        const e = clamp(k / 4, 0, 1) * clamp((p.stDur - k) / 12, 0, 1);
        const side = Math.sin(ctx.diveRel) >= 0 ? 1 : -1;
        P.drop = mix(P.drop, 0.3 * H, e); P.lean = mix(P.lean, 0.25, e); P.roll = mix(P.roll, -0.25 * side, e); P.tw *= 1 - e;
        const hz = 0.53 * H - P.drop;
        legIK(P, side, 0.05 * H, side * (0.35 + 0.2 * e) * H, -hz + 0.05, H, e);   // out along the grass
        legIK(P, -side, 0.12 * H, -side * 0.1 * H, -hz, H, e);                      // bent under him
        armIK(P, side, 0.18 * H, side * 0.3 * H, 0.15 * H, H, e);                  // near hand down to the ground
        if (side > 0) { P.lsh = mix(P.lsh, 1.4, e); P.lab = mix(P.lab, 1.1, e); } else { P.rsh = mix(P.rsh, 1.4, e); P.rab = mix(P.rab, 1.1, e); }
        break;
      }
      if (p.spr === GKB.KNEE) {
        // K-barrier: down on one knee towards the near post, the shin along
        // the grass, the other foot planted, body upright, hands cupped low
        const e = clamp(k / 6, 0, 1) * clamp((p.stDur - k) / 10, 0, 1);
        const side = Math.sin(ctx.diveRel) >= 0 ? 1 : -1; // (+: his R side, see skeleton)
        P.drop = mix(P.drop, 0.25 * H, e); P.lean = mix(P.lean, 0.18, e); P.tw *= 1 - e;
        const hz = 0.53 * H - P.drop;
        legIK(P, side, -0.05 * H, side * 0.24 * H, -hz + 0.03, H, e);   // the knee down, shin out along the grass
        legIK(P, -side, 0.22 * H, -side * 0.05 * H, -hz, H, e);         // the planted foot
        handsTo(P, 0.2 * H, 0, 0.17 * H, H, e, 0.075);
        break;
      }
      // How big a dive (from its length, see DIVE_BASE in the sim): a quick
      // hop tilts him a little and he's straight back on his feet; a full
      // stretch takes him horizontal in the air, he lands on his side, stays
      // down a moment, then pushes himself up – to his knees, then his feet.
      // A collapse (a low ball close to him) has no spring: the legs fold and
      // he drops straight onto his side.
      const rel = ctx.diveRel, air = p.z > 0.02;
      const big = p.spr ? 1 : clamp((p.stDur - 2 * DIVE_BASE) / DIVE_SPAN, 0, 1);
      const collapse = !p.spr && p.stB < 0.5 && big < 0.45;
      const lieMax = collapse ? 0.95 : 0.3 + 0.7 * big, upT = Math.round(10 + 14 * big), left = p.stDur - k;
      let lie = (air && !collapse ? clamp(k / 9, 0, 1) : clamp(k / (collapse ? 6 : 5), 0, 1)) * lieMax;
      if (left < upT) lie *= ease(left / upT);
      const up = left < upT ? 1 - left / upT : 0;        // getting up (0 .. 1)
      const env = clamp(k / 7, 0, 1) * (left < upT ? ease(left / upT) : 1);
      // in the air on the line of his reach (a diagonal for a high ball), flat once down
      const tilt = air ? ctx.diveEl || 0 : 0;
      P.roll = Math.sin(rel) * (1.5 - tilt) * lie;
      P.pitch = Math.cos(rel) * (1.25 - 0.8 * tilt) * lie;
      // on the ground lying on his side the hips are down at the grass; while
      // getting up he is on one knee for a moment
      P.drop = (air ? hipH * 0.2 * lie : hipH * 0.8 * lie) + (up > 0 && up < 0.8 ? hipH * 0.25 * Math.sin(up / 0.8 * Math.PI) : 0);
      // arms at full stretch towards the ball, gloves together; once he has
      // it, it's pulled in to his chest
      P.lsh = mix(P.lsh, 2.8, env); P.rsh = mix(P.rsh, 2.95, env); P.lab = P.rab = mix(P.lab, -0.06, env); P.lel = P.rel = 0.1;
      if (ctx.diveHold) {
        // caught it: hands on the ball in the air, hugged into the chest once down
        const hug = p.z <= 0.02 && k > 12 ? clamp((k - 12) / 10, 0, 1) * env : 0;
        P.lsh = P.rsh = mix(mix(P.lsh, 2.2, env), 0.85, hug); P.lel = P.rel = mix(0.5 * env, 2.1, hug); P.lab = P.rab = mix(-0.1, 0.15, hug);
      }
      P.lk = 0.25; P.rk = mix(P.rk, 0.9, env); P.rh = 0.5 * env;
      if (collapse) { const f = clamp(1 - k / 8, 0, 1) * env; P.lk = mix(P.lk, 1.3, f); P.rk = mix(P.rk, 1.5, f); P.lh = mix(P.lh, 0.6, f); }
      if (p.hit === 2 && !ctx.diveHold) {
        // tipped it: the top hand stays up where it flicked the ball, the other comes in
        const top = Math.sin(rel) >= 0 ? 1 : -1;
        if (top > 0) { P.rsh = 3.1; P.rel = 0.05; P.lsh = mix(P.lsh, 1.5, env); P.lel = 1.1; }
        else { P.lsh = 3.1; P.lel = 0.05; P.rsh = mix(P.rsh, 1.5, env); P.rel = 1.1; }
      }
      if (up > 0) {
        // pushing himself up off the grass: a hand down, a knee under him
        const u = Math.sin(up * Math.PI);
        P.lsh = mix(P.lsh, 0.7, u); P.lab = mix(P.lab, 0.9, u); P.lel = mix(P.lel, 0.3, u);
        P.lh = mix(P.lh, 1.2, u); P.lk = mix(P.lk, 1.9, u); P.rk = mix(P.rk, 0.6, u);
      }
      if (p.spr) {
        // spread at the shooter's feet: arms and legs out wide, a star on its side
        P.lsh = P.rsh = mix(P.lsh, 1.7, env); P.lab = P.rab = 0.9 * env;
        P.la = P.ra = 0.55 * env; P.lk = P.rk = 0.2; P.rh = 0.2 * env;
      }
      break;
    }
    case ST.PUNCH: case ST.TIP: {
      // punching it clear: the fist(s) driven through where it was; tipping it
      // over: one arm up to it, the wrist flicking it on, leaning back. In the
      // air, the knee nearest the play comes up.
      const c2 = ctx.contact;
      const ext = k < 5 ? ease(k / 5) : 1 - clamp((k - 9) / Math.max(1, p.stDur - 9), 0, 1);
      if (p.st === ST.PUNCH && p.stA === 2) {
        handsTo(P, c2.f + 0.12 * H * ext, c2.r, c2.z + 0.05 * H * ext, H, ext, 0.055);
        P.lean = mix(P.lean, 0.15, ext);
      } else {
        const side = c2.r >= 0 ? 1 : -1, up = p.st === ST.TIP;
        armIK(P, side, c2.f + (up ? 0.02 : 0.12) * H * ext, c2.r, c2.z + (up ? 0.1 : 0.05) * H * ext, H, ext);
        if (side > 0) { P.lsh = mix(P.lsh, 0.9, ext); P.lab = mix(P.lab, 0.6, ext); P.lel = mix(P.lel, 1.2, ext); }
        else { P.rsh = mix(P.rsh, 0.9, ext); P.rab = mix(P.rab, 0.6, ext); P.rel = mix(P.rel, 1.2, ext); }
        P.lean = mix(P.lean, up ? -0.28 : 0.1, ext); P.roll = mix(P.roll, -0.15 * side, ext);
      }
      if (p.z > 0.04) {
        const u = clamp(p.z / 0.2, 0, 1);
        P.lh = mix(P.lh, 1.25, u); P.lk = mix(P.lk, 1.9, u); P.rh = mix(P.rh, 0.1, u); P.rk = mix(P.rk, 0.35, u);
      }
      break;
    }
    case ST.FALLEN: {
      const sgn = p.id % 2 ? -1 : 1;
      const env = clamp(k / 9, 0, 1) * lieEnv(p, 15);
      P.pitch = sgn * 1.5 * env; P.drop = hipH * 0.78 * env;
      P.lsh = mix(P.lsh, 1.8, env); P.rsh = mix(P.rsh, 0.6, env); P.lab = P.rab = 0.6 * env;
      P.lk = 0.6 * env; P.rk = 0.2;
      break;
    }
    case ST.STUMBLE: {
      const u = clamp(k / Math.max(1, p.stDur), 0, 1);
      const env = Math.sin(u * Math.PI);
      P.lean += 0.45 * env; P.lab = 0.9 * env; P.rab = 0.7 * env; P.lsh = 0.9 * env;
      break;
    }
    case ST.CONTROL: {
      // bringing the ball down: the part rises to meet it and gives with it
      const cT = Math.max(1, p.stA);
      const env = k < cT ? ease(k / cT) : 1 - clamp((k - cT) / Math.max(1, p.stDur - cT), 0, 1);
      if (p.stB === PART.FOOT) {
        // instep / sole up to cushion it, arms out for balance
        P.rh = mix(P.rh, 0.55, env); P.rk = mix(P.rk, 0.75, env); P.lk = mix(P.lk, 0.25, env);
        P.lab = P.rab = 0.55 * env; P.lean = mix(P.lean, -0.04, env);
      } else if (p.stB === PART.THIGH) {
        // thigh lifted level, shin hanging, arms wide
        P.rh = mix(P.rh, 1.45, env); P.rk = mix(P.rk, 1.55, env); P.lh = mix(P.lh, 0.05, env); P.lk = mix(P.lk, 0.22, env);
        P.lab = P.rab = 0.9 * env; P.lsh = P.rsh = 0.3 * env; P.lean = mix(P.lean, -0.12, env);
      } else if (p.stB === PART.CHEST) {
        // chest: lean back into it, arms wide, soft knees
        P.lean = -0.38 * env; P.lab = P.rab = 0.95 * env; P.lsh = P.rsh = 0.35 * env; P.lel = P.rel = 0.5;
        P.lk = P.rk = 0.35 * env + 0.12; P.drop = 0.03 * H * env;
      } else {
        // head: up under it, chin tucked, arms out, knees soft for the landing
        P.lsh = P.rsh = mix(P.lsh, 0.6, env); P.lab = P.rab = 0.85 * env; P.lel = P.rel = 0.45;
        P.lk = mix(P.lk, 0.55, env); P.rk = mix(P.rk, 0.45, env); P.lean = mix(P.lean, -0.18, env); P.head = -0.3 * env;
      }
      break;
    }
    case ST.BLOCK: {
      // thrown into the ball's path: a leg (IK to the ball), the body, or a jump to head it
      const e = clamp(k / 4, 0, 1) * clamp((p.stDur - k) / 8, 0, 1);
      const B = ctx.block;
      if (p.stB < 0.8) {
        const side = B.dr >= 0 ? 1 : -1;
        P.drop = 0.14 * H * e; P.lean = mix(P.lean, -0.1, e); P.roll = mix(P.roll, -0.22 * side, e);
        legIK(P, side, B.df, B.dr - side * 0.062 * H, B.z - (hipH - P.drop), H, e);
        // standing leg bent, arms out for balance
        if (side > 0) { P.lh = mix(P.lh, 0.45, e); P.lk = mix(P.lk, 0.95, e); } else { P.rh = mix(P.rh, 0.45, e); P.rk = mix(P.rk, 0.95, e); }
        P.lsh = mix(P.lsh, 0.5, e); P.rsh = mix(P.rsh, 0.5, e); P.lab = P.rab = mix(P.lab, 0.85, e);
      } else if (p.stB < H * 0.85) {
        // body: square up and lean into it, arms tucked behind (no handball)
        const rel = Math.atan2(B.dr, B.df);
        P.lean = mix(P.lean, 0.32 * Math.cos(rel), e); P.roll = mix(P.roll, 0.35 * Math.sin(rel), e);
        P.lsh = mix(P.lsh, -0.45, e); P.rsh = mix(P.rsh, -0.45, e); P.lab = P.rab = mix(P.lab, 0.12, e);
        P.lel = P.rel = mix(P.lel, 1.3, e); P.lk = P.rk = mix(P.lk, 0.45, e); P.drop = 0.04 * H * e;
      } else {
        // header block: jump, arms down
        P.lk = mix(P.lk, 0.8, e); P.rk = mix(P.rk, 0.6, e); P.lh = mix(P.lh, 0.3, e);
        P.lsh = mix(P.lsh, 0.2, e); P.rsh = mix(P.rsh, 0.2, e); P.lab = P.rab = mix(P.lab, 0.5, e);
        P.lean = mix(P.lean, 0.2 * Math.cos(Math.atan2(B.dr, B.df)), e); P.head = 0.25 * e;
      }
      break;
    }
    case ST.SKILL: {
      const env = Math.sin(clamp(k / Math.max(1, p.stDur), 0, 1) * Math.PI);
      if (p.stA === SKILL.LIFT) {
        // toe-and-heel flick: kicking leg tucks up behind then whips through
        P.rh = 0.15 + 0.85 * env; P.rk = 1.7 * env; P.lk = 0.35;
        P.lab = 0.6 * env; P.rab = 0.45 * env; P.lean = -0.08 * env;
      } else if (p.stA === SKILL.KNOCK) {
        P.rh = 0.75 * env; P.rk = 0.35; P.lean = 0.25 + 0.1 * env; P.lsh = -0.5 * env; P.rsh = 0.6 * env;
      } else if (p.stA === SKILL.FEINT_L || p.stA === SKILL.FEINT_R) {
        // step-over: the leg on the feint side circles over the ball, body sways
        const side = p.stA === SKILL.FEINT_L ? 1 : -1;
        P.roll = -0.32 * side * env;
        if (side > 0) { P.lh = 0.55 * env; P.lk = 1.3 * env; P.la = 0.45 * env; }
        else { P.rh = 0.55 * env; P.rk = 1.3 * env; P.ra = 0.45 * env; }
        P.lab = P.rab = 0.65 * env;
      } else if (p.stA === SKILL.DRAGBACK) {
        P.rh = 0.65 * env; P.rk = 0.12; P.lean = -0.15 * env; P.lk = 0.4 * env; P.lab = 0.55 * env; P.rab = 0.35 * env;
      }
      break;
    }
  }
  return P;
}

const ARM_KEYS = new Set(['lsh', 'lab', 'lel', 'rsh', 'rab', 'rel']);

// ---------------------------------------------------------------- renderer

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    // over this 2D canvas (the pitch, markings, shadows): a 3D layer with the
    // players, ball, goals and boards, then the 2D overlays (names, gauges)
    const layer = (id) => { const c = document.createElement('canvas'); c.id = id; c.className = 'layer'; return c; };
    this.uiCanvas = layer('gameui'); canvas.insertAdjacentElement('afterend', this.uiCanvas);
    this.glCanvas = layer('game3d'); canvas.insertAdjacentElement('afterend', this.glCanvas);
    this.gu = this.uiCanvas.getContext('2d');
    this.s3 = Scene3D.create(this.glCanvas);
    if (!this.s3) this.glCanvas.remove();
    this.isoCam = new Camera();
    this.tpCam = new PerspCam();
    this.cam = this.isoCam; // the one in use this frame
    this.tp = false;
    this.anim = new Map();
    this.trail = [];
    this.zoom = 1;
    this.preset = 'iso';
    this.camX = 0; this.camY = 0;
    this.time = 0;
    this.ballRoll = 0;
    this.dpr = 1;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  setPreset(name) {
    if (name === 'fp') name = 'tp'; // (first person became third person)
    if (!CAMERAS[name]) name = 'iso';
    this.preset = name;
    const c = CAMERAS[name];
    this.tp = !!c.tp;
    if (!c.tp) this.isoCam.set(c.yaw, c.elev);
    this.tpInit = false;
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
    for (const c of [this.isoCam, this.tpCam]) { c.w = this.canvas.width; c.h = this.canvas.height; }
    this.tpCam.update();
    if (this.uiCanvas) { this.uiCanvas.width = this.canvas.width; this.uiCanvas.height = this.canvas.height; }
    if (this.s3) this.s3.setSize(this.canvas.width, this.canvas.height);
  }

  pos(e, alpha, off) {
    const x = e.px + (e.x - e.px) * alpha + (off ? off[0] : 0);
    const y = e.py + (e.y - e.py) * alpha + (off ? off[1] : 0);
    const z = e.pz + (e.z - e.pz) * alpha + (off ? off[2] : 0);
    return [x, y, z];
  }

  frame(w, alpha, offsets, info, dt) {
    const g = this.g;
    let cam = this.cam = this.isoCam;
    this.time += dt;
    const pit = pitchOf(w);
    // landscape: fit ~40 m across; portrait (phones): zoom in so players stay readable
    const base = Math.max(Math.min(cam.w, cam.h * 1.7), Math.min(cam.h, cam.w * 1.7) * 0.75) / 40;
    cam.scale = base * this.zoom;

    // positions for this frame
    let ball = this.pos(w.ball, alpha, offsets.get('b'));
    this.ballPos = ball;
    const ppos = new Map();
    for (const p of w.players) ppos.set(p.id, this.pos(p, alpha, offsets.get(p.id)));
    // poses first: a ball in someone's hands is drawn where his hands are
    const Js = new Map();
    for (const p of w.players) { const [x, y, z] = ppos.get(p.id); Js.set(p.id, this.posePlayer(w, p, x, y, z, info, dt)); }
    const heldNow = w.ball.owner >= 0 && w.ball.held;
    this.ballScale = 1;
    if (heldNow) {
      const h = w.players.find((p) => p.id === w.ball.owner);
      const hb = h && this.heldBallAt(w, h, Js.get(h.id), ppos.get(h.id));
      if (hb) ball = hb;
      const pop = h && this.anim.get(h.id)?.pop;
      if (pop !== undefined && this.time - pop < 0.25) {
        this.ballScale = ease(clamp((this.time - pop) / 0.25, 0, 1));
        if (this.time - pop < 0.02) this.trail = [];
      }
    }
    // the moment it leaves someone's hands (a throw, a punt) it goes on from
    // where it was drawn – the hand – easing onto its real flight
    if (this.wasHeld && !heldNow && w.ball.owner < 0 && w.ball.kt < 8 && this.lastBall) {
      this.relOff = { off: [this.lastBall[0] - ball[0], this.lastBall[1] - ball[1], this.lastBall[2] - ball[2]], t0: this.time };
    }
    if (this.relOff) {
      const u = (this.time - this.relOff.t0) / 0.15;
      if (u >= 1 || heldNow) this.relOff = null;
      else { const k = 1 - ease(u), o = this.relOff.off; ball = [ball[0] + o[0] * k, ball[1] + o[1] * k, Math.max(BALL_R, ball[2] + o[2] * k)]; }
    }
    this.wasHeld = heldNow;
    this.lastBall = ball; // where it was drawn: a catch next frame starts from here

    // camera: follow the ball with a little look-ahead, biased towards me
    // (a dribbler's steady run, not the ball's touch-by-touch pulsing)
    const carrier = w.ball.owner >= 0 ? w.players.find((p) => p.id === w.ball.owner) : null;
    const lv = carrier || w.ball;
    let tx = ball[0] + clamp(lv.vx * 0.25, -4, 4), ty = ball[1] + clamp(lv.vy * 0.25, -4, 4);
    const me = ppos.get(info.myId);
    if (me) { tx = tx * 0.72 + me[0] * 0.28; ty = ty * 0.72 + me[1] * 0.28; }
    tx = clamp(tx, -pit.L / 2 - 2, pit.L / 2 + 2); ty = clamp(ty, -pit.W / 2 - 1, pit.W / 2 + 1);
    const k = 1 - Math.exp(-dt * 3.2);
    if (!this.camInit) { this.camX = tx; this.camY = ty; this.camInit = true; }
    this.camX += (tx - this.camX) * k; this.camY += (ty - this.camY) * k;
    cam.cx = this.camX; cam.cy = this.camY;
    // third person: behind my player (back to the isometric view while I'm
    // not on the pitch)
    const mine = this.tp && w.players.find((p) => p.id === info.myId);
    const tpOn = !!mine;
    if (tpOn) cam = this.cam = this.thirdPerson(w, mine, ppos.get(mine.id), ball, dt);
    if (this.tpShown !== tpOn) { this.tpShown = tpOn; document.body.classList.toggle('tp', tpOn); }
    // background
    g.fillStyle = '#0e1a14';
    g.fillRect(0, 0, cam.w, cam.h);
    if (cam.persp) this.stadium(pit);
    this.drawGround(pit);
    const far = [], near = [];
    if (!this.s3) this.boards(pit, far, near); // (3D: they're meshes)
    for (const f of far) f();

    // shadows
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id);
      this.shadow(x, y, 0.42 * (stats(p.hgt, p.bld).H / 1.8), 0.28 / (1 + z * 0.8), p);
    }
    this.ballShadow(ball);
    this.meetMarker(w, info.myId);

    if (this.s3) this.scene3d(w, cam, ppos, Js, ball, info, tpOn, pit, dt);
    // (no WebGL: a depth-sorted 2D scene of players, ball and goal parts)
    const items = [];
    if (!this.s3) for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id);
      if (cam.persp && !cam.ahead(x, y, z + 1, 0.2)) continue;
      // (third person: I'm a little see-through, so the ball at my feet shows)
      const alpha = tpOn && p.id === info.myId ? 0.62 : 1;
      items.push({ d: cam.depth(x, y), fn: () => this.drawPose(p, Js.get(p.id), info, cam.persp ? cam.local(x, y, z + 0.9) : cam, alpha) });
    }
    if (!this.s3 && (!cam.persp || cam.ahead(ball[0], ball[1], ball[2]))) items.push({ d: cam.depth(ball[0], ball[1]) + 0.05, fn: () => this.drawBall(w, ball, dt) });
    if (!this.s3) this.goalParts(pit, items);
    items.sort((a, b) => a.d - b.d);
    for (const it of items) it.fn();
    for (const f of near) f();

    // overlays
    this.gu.clearRect(0, 0, cam.w, cam.h);
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id);
      this.overlay(w, p, x, y, z, info);
    }
    // where am I, when the camera can't see me – in third person, where the ball is
    const meAt = ppos.get(info.myId);
    if (tpOn) this.offscreen(null, ball);
    else if (meAt) this.offscreen(w.players.find((p) => p.id === info.myId), meAt);
  }

  // The 3D layer: every player's meshes on his skeleton, the ball, the goals
  // and the boards, seen through this frame's camera.
  scene3d(w, cam, ppos, Js, ball, info, tpOn, pit, dt) {
    const s3 = this.s3;
    s3.setCamera(cam.clipMatrix());
    s3.beginFrame();
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id), J = Js.get(p.id);
      if (cam.persp && !cam.ahead(x, y, z + 1, 0.2)) continue;
      const st = stats(p.hgt, p.bld);
      // (third person: I'm a little see-through, so the ball at my feet shows)
      s3.player(p.id, J, info.looks.get(p.id) || lookFor(null, p.team, p.role), st.H, st.width, tpOn && p.id === info.myId ? 0.6 : 1);
      p._headZ = J.head[2];
    }
    s3.endFrame();
    const b = w.ball;
    s3.ball(ball, [b.vx, b.vy, b.vz], dt, (cam.persp ? 1.15 : 1.75) * (this.ballScale ?? 1),
      !cam.persp || cam.ahead(ball[0], ball[1], ball[2]), Math.abs(b.spin) > 0.1 && b.owner < 0);
    s3.goals(pit);
    // (the boards between the camera and the pitch are see-through, as in 2D)
    s3.boards(pit, (mx, my) => !cam.persp && cam.depth(mx, my) >= 0, [TEAM_COLORS[0].shirt, TEAM_COLORS[1].shirt]);
    s3.render();
  }

  // The third-person camera: behind and above my player on his line to the
  // goal his team attacks, framing the three things that matter – him, the
  // ball and that goal. It pulls back (and up) only as far as it takes to get
  // all three in, turns just enough to frame them, tilts for a high ball, and
  // eases every change so the view doesn't jump about.
  thirdPerson(w, p, [x, y, z], ball, dt) {
    const c = this.tpCam, init = this.tpInit, pit = pitchOf(w);
    const gx = teamDir(w, p.team) * pit.L / 2;
    const toGoal = Math.hypot(gx - x, y) > 3 ? Math.atan2(-y, gx - x) : this.tpBase ?? Math.atan2(0, gx - x);
    const k = init ? 1 - Math.exp(-dt * 3) : 1;
    this.tpBase = init ? this.tpBase + angDiff(this.tpBase, toGoal) * k : toGoal;
    const fx = Math.cos(this.tpBase), fy = Math.sin(this.tpBase), lx = -fy, ly = fx; // forwards, to his left
    // (closer on a phone held sideways: its view is wider, he'd be small)
    const wide = c.w / c.h > 1.8, near = wide ? 3.5 : 4.6, side = wide ? 0.45 : 0.55;
    const hHalf = Math.atan(c.w / 2 / c.f) * 0.8, vHalf = Math.atan(c.h / 2 / c.f) * 0.8;
    // what has to be in shot: him (feet and head), the ball, the goal (its
    // mouth on the grass and its bar)
    const pts = [[x, y, z], [x, y, z + 1.9], ball, [gx, 0, 0], [gx, 0, pit.goalH]];
    let pick = null;
    for (const back of [near, near * 1.35, near * 1.8, near * 2.4, near * 3.2, near * 4.2, near * 5.5]) {
      const up = (wide ? 2.4 : 2.9) + 0.12 * (back - near);
      const ex = x - fx * back - lx * side, ey = y - fy * back - ly * side, ez = z + up;
      let lo = 9, hi = -9, elo = 9, ehi = -9, ok = true;
      for (const q of pts) {
        const dx = q[0] - ex, dy = q[1] - ey, along = dx * fx + dy * fy;
        if (along < 1.5) { ok = false; break; } // behind the camera: further back
        const a = angDiff(this.tpBase, Math.atan2(dy, dx)), e = Math.atan2(q[2] - ez, Math.hypot(dx, dy));
        lo = Math.min(lo, a); hi = Math.max(hi, a); elo = Math.min(elo, e); ehi = Math.max(ehi, e);
      }
      pick = { back, ex, ey, ez, yaw: this.tpBase + (lo + hi) / 2, pitch: clamp((elo + ehi) / 2, -0.6, 0.35) };
      if (ok && hi - lo < 2 * hHalf && ehi - elo < 2 * vHalf) break;
    }
    const ke = init ? 1 - Math.exp(-dt * 4) : 1;
    c.ex += (pick.ex - c.ex) * ke; c.ey += (pick.ey - c.ey) * ke; c.ez += (pick.ez - c.ez) * ke;
    this.tpYaw = init ? this.tpYaw + angDiff(this.tpYaw, pick.yaw) * ke : pick.yaw;
    this.tpPitch = init ? this.tpPitch + (pick.pitch - this.tpPitch) * ke : pick.pitch;
    c.yaw = this.tpYaw; c.pitch = this.tpPitch;
    this.tpInit = true;
    c.update();
    return c;
  }

  // A badge at the screen edge pointing to my player, with how far away he is.
  offscreen(p, [x, y, z]) {
    const g = this.gu, cam = this.cam, d = this.dpr;
    const zz = p ? z + 0.9 : z;
    let X = cam.px(x, y, zz), Y = cam.py(x, y, zz);
    const m = 10 * d;
    const behind = cam.persp && !cam.ahead(x, y, zz);
    if (!behind && X > m && X < cam.w - m && Y > m && Y < cam.h - m) return;
    if (behind) {
      // behind me: point the way to turn, along the bottom edge
      const c = cam.toCam(x, y, zz);
      X = cam.w / 2 + Math.sign(c[0] || 1) * cam.w; Y = cam.h * 0.9;
    }
    const cx = cam.w / 2, cy = cam.h / 2, pad = 34 * d;
    const dx = X - cx, dy = Y - cy;
    const t = Math.min((cx - pad) / Math.max(1e-6, Math.abs(dx)), (cy - pad) / Math.max(1e-6, Math.abs(dy)));
    const ex = cx + dx * t, ey = cy + dy * t, ang = Math.atan2(dy, dx);
    const col = !p ? '#ffffff' : TEAM_COLORS[p.team] ? TEAM_COLORS[p.team].ui : '#fff';
    const r = 13 * d * (1 + 0.06 * Math.sin(this.time * 6));
    g.save();
    g.translate(ex, ey);
    // arrow
    g.rotate(ang);
    g.fillStyle = col; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 2 * d;
    g.beginPath(); g.moveTo(r + 11 * d, 0); g.lineTo(r - 1 * d, -8 * d); g.lineTo(r - 1 * d, 8 * d); g.closePath();
    g.fill(); g.stroke();
    g.rotate(-ang);
    // badge with the distance
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(10,18,14,0.82)'; g.fill();
    g.lineWidth = 2.5 * d; g.strokeStyle = col; g.stroke();
    const dist = Math.round(Math.hypot(x - cam.cx, y - cam.cy));
    g.fillStyle = '#fff'; g.font = `700 ${Math.round(10 * d)}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(p ? `${dist}m` : '⚽', 0, 0.5 * d);
    g.restore();
  }

  // ---------------------------------------------------------- pitch

  poly(pts, fill) {
    const g = this.g, cam = this.cam;
    g.beginPath();
    if (cam.persp) {
      // perspective: clipped at the near plane (the pitch runs on behind the camera)
      const cp = clipNear(pts.map(([x, y, z = 0]) => cam.toCam(x, y, z)), cam.near);
      cp.forEach((c, i) => { const X = cam.sx(c), Y = cam.sy(c); if (i) g.lineTo(X, Y); else g.moveTo(X, Y); });
      if (cp.length < 3) return;
    } else {
      pts.forEach(([x, y, z = 0], i) => {
        const X = cam.px(x, y, z), Y = cam.py(x, y, z);
        if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
      });
    }
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
  }

  line(x1, y1, z1, x2, y2, z2) {
    const g = this.g, cam = this.cam;
    if (cam.persp) {
      let a = cam.toCam(x1, y1, z1), b = cam.toCam(x2, y2, z2);
      const n = cam.near;
      if (a[2] <= n && b[2] <= n) return;
      if (a[2] <= n || b[2] <= n) {
        const t = (n - a[2]) / (b[2] - a[2]), c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, n];
        if (a[2] <= n) a = c; else b = c;
      }
      g.moveTo(cam.sx(a), cam.sy(a)); g.lineTo(cam.sx(b), cam.sy(b));
      return;
    }
    g.moveTo(cam.px(x1, y1, z1), cam.py(x1, y1, z1));
    g.lineTo(cam.px(x2, y2, z2), cam.py(x2, y2, z2));
  }

  // A painted line on the grass: in perspective a strip of its real width
  // (it narrows into the distance); otherwise part of the stroked path.
  paint(x1, y1, x2, y2, wd = 0.12) {
    if (!this.cam.persp) { this.line(x1, y1, 0, x2, y2, 0); return; }
    const L = Math.hypot(x2 - x1, y2 - y1) || 1, nx = -(y2 - y1) / L * wd / 2, ny = (x2 - x1) / L * wd / 2;
    this.poly([[x1 + nx, y1 + ny, 0.005], [x2 + nx, y2 + ny, 0.005], [x2 - nx, y2 - ny, 0.005], [x1 - nx, y1 - ny, 0.005]], this.g.strokeStyle);
    this.g.beginPath(); // (filled already: nothing left for a stroke() after it)
  }

  // A circle on the grass (shadows, spots, markers): in perspective each
  // with the size and the foreshortening of where it is.
  groundEllipse(x, y, r) {
    const g = this.g, cam = this.cam;
    const X = cam.px(x, y, 0), Y = cam.py(x, y, 0);
    let R = r * cam.scale, se = cam.se;
    if (cam.persp) {
      if (!cam.ahead(x, y, 0, 0.3)) return false;
      R = r * cam.sc(x, y, 0); se = Math.max(0.03, Math.sin(Math.atan2(cam.ez, Math.hypot(x - cam.ex, y - cam.ey))));
    }
    g.ellipse(X, Y, R, R * se, 0, 0, TAU);
    return true;
  }

  arc(cx, cy, r, a0, a1) {
    const g = this.g, cam = this.cam;
    if (cam.persp) {
      // perspective: along the arc as painted strips
      const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / TAU * 48));
      for (let i = 0; i < n; i++) {
        const u0 = a0 + (a1 - a0) * i / n, u1 = a0 + (a1 - a0) * (i + 1) / n;
        this.paint(cx + Math.cos(u0) * r, cy + Math.sin(u0) * r, cx + Math.cos(u1) * r, cy + Math.sin(u1) * r);
      }
      return;
    }
    const X = cam.px(cx, cy, 0), Y = cam.py(cx, cy, 0);
    const yaw = cam.yaw * D2R;
    // ground circle -> screen ellipse (axis-aligned because the rotation is about z)
    g.moveTo(X + Math.cos(a0 + yaw) * r * cam.scale, Y + Math.sin(a0 + yaw) * r * cam.scale * cam.se);
    g.ellipse(X, Y, r * cam.scale, r * cam.scale * cam.se, 0, a0 + yaw, a1 + yaw);
  }

  drawGround(pit) {
    const g = this.g, hx = pit.L / 2, hy = pit.W / 2;
    this.poly([[-hx - 6, -hy - 5], [hx + 6, -hy - 5], [hx + 6, hy + 5], [-hx - 6, hy + 5]], '#2c6b3f');
    const n = 14;
    for (let i = 0; i < n; i++) {
      const x0 = -hx - 1 + (pit.L + 2) * i / n, x1 = -hx - 1 + (pit.L + 2) * (i + 1) / n;
      this.poly([[x0, -hy - 1], [x1, -hy - 1], [x1, hy + 1], [x0, hy + 1]], i % 2 ? '#3a8a4f' : '#358048');
    }
    g.strokeStyle = g.fillStyle = 'rgba(245,250,245,0.85)';
    g.lineWidth = Math.max(1, 0.12 * this.cam.scale);
    g.lineJoin = 'round';
    g.beginPath();
    // touchlines, goal lines, halfway
    this.paint(-hx, -hy, hx, -hy); this.paint(hx, -hy, hx, hy);
    this.paint(hx, hy, -hx, hy); this.paint(-hx, hy, -hx, -hy);
    this.paint(0, -hy, 0, hy);
    for (const s of [-1, 1]) {
      const gx = s * hx;
      // penalty box
      this.paint(gx, -pit.boxW / 2, gx - s * pit.boxD, -pit.boxW / 2);
      this.paint(gx - s * pit.boxD, -pit.boxW / 2, gx - s * pit.boxD, pit.boxW / 2);
      this.paint(gx - s * pit.boxD, pit.boxW / 2, gx, pit.boxW / 2);
      // goal area
      this.paint(gx, -pit.areaW / 2, gx - s * pit.areaD, -pit.areaW / 2);
      this.paint(gx - s * pit.areaD, -pit.areaW / 2, gx - s * pit.areaD, pit.areaW / 2);
      this.paint(gx - s * pit.areaD, pit.areaW / 2, gx, pit.areaW / 2);
    }
    g.stroke();
    g.beginPath();
    this.arc(0, 0, pit.centerR, 0, TAU);
    g.stroke();
    for (const s of [-1, 1]) {
      const gx = s * hx, px = gx - s * pit.penSpot;
      // penalty arc outside the box
      const r = pit.centerR, dx = pit.boxD - pit.penSpot;
      if (r > dx) {
        const a = Math.acos(dx / r);
        g.beginPath();
        if (s > 0) this.arc(px, 0, r, Math.PI - a, Math.PI + a);
        else this.arc(px, 0, r, -a, a);
        g.stroke();
      }
      // corner arcs
      for (const t of [-1, 1]) {
        g.beginPath();
        const a0 = Math.atan2(-t, -s);
        this.arc(gx, t * hy, 0.9, a0 - Math.PI / 4, a0 + Math.PI / 4);
        g.stroke();
      }
    }
    g.fillStyle = 'rgba(245,250,245,0.9)';
    for (const [x, y] of [[0, 0], [hx - pit.penSpot, 0], [-hx + pit.penSpot, 0]]) {
      g.beginPath();
      if (this.groundEllipse(x, y, this.cam.persp ? 0.11 : 0.18)) g.fill(); // (up close: its real size)
    }
  }

  // Third person: a night sky over the stadium and the stands all round,
  // rising behind the boards.
  stadium(pit) {
    const g = this.g, cam = this.cam;
    const hy = clamp(cam.h / 2 + cam.f * Math.tan(cam.pitch), -cam.h, 2 * cam.h); // the horizon
    const sky = g.createLinearGradient(0, hy - cam.h * 0.9, 0, hy);
    sky.addColorStop(0, '#050b14'); sky.addColorStop(0.7, '#14243a'); sky.addColorStop(1, '#2a3d55');
    g.fillStyle = sky; g.fillRect(0, 0, cam.w, Math.max(0, hy + 2));
    // four stands, each widening outwards so they meet at the corners
    const hx = pit.L / 2 + 5.4, hw = pit.W / 2 + 4.4, back = 16, top = 10;
    const corners = [[-hx, -hw], [hx, -hw], [hx, hw], [-hx, hw]];
    const shades = ['#202d3c', '#1b2735', '#17212d', '#121a24']; // darker higher up
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4];
      const len = Math.hypot(bx - ax, by - ay), tx = (bx - ax) / len, ty = (by - ay) / len, nx = ty, ny = -tx; // outwards
      const fa = [ax + (nx - tx) * back, ay + (ny - ty) * back], fb = [bx + (nx + tx) * back, by + (ny + ty) * back];
      const at = (x, y, f, u) => [x + (f[0] - x) * u, y + (f[1] - y) * u, 0.75 + (top - 0.75) * u];
      for (let t = 0; t < 4; t++) {
        const u0 = t / 4, u1 = (t + 1) / 4;
        this.poly([at(ax, ay, fa, u0), at(bx, by, fb, u0), at(bx, by, fb, u1), at(ax, ay, fa, u1)], shades[t]);
      }
    }
  }

  boards(pit, far, near) {
    const hx = pit.L / 2 + 5.4, hy = pit.W / 2 + 4.4, h = 0.75;
    const sides = [
      [[-hx, -hy], [hx, -hy]], [[hx, -hy], [hx, hy]], [[hx, hy], [-hx, hy]], [[-hx, hy], [-hx, -hy]],
    ];
    for (const [a, b] of sides) {
      const mid = this.cam.depth((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      const draw = (alpha) => () => {
        const g = this.g;
        g.globalAlpha = alpha;
        this.poly([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h], [a[0], a[1], h]], '#1b2b3a');
        g.strokeStyle = '#e8eef3'; g.lineWidth = Math.max(1, 0.06 * this.cam.scale);
        g.beginPath(); this.line(a[0], a[1], h, b[0], b[1], h); g.stroke();
        // team-colour stripe
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(len / 12));
        for (let i = 0; i < n; i++) {
          const u0 = i / n + 0.02, u1 = (i + 1) / n - 0.02;
          const p0 = [mix(a[0], b[0], u0), mix(a[1], b[1], u0)], p1 = [mix(a[0], b[0], u1), mix(a[1], b[1], u1)];
          this.poly([[p0[0], p0[1], 0.22], [p1[0], p1[1], 0.22], [p1[0], p1[1], 0.5], [p0[0], p0[1], 0.5]], TEAM_COLORS[i % 2].shirt);
        }
        g.globalAlpha = 1;
      };
      if (mid < 0 || this.cam.persp) far.push(draw(1)); else near.push(draw(0.55));
    }
  }

  goalParts(pit, items) {
    const cam = this.cam, gh = pit.goalH, gw = pit.goalW / 2;
    for (const s of [-1, 1]) {
      const gx = s * pit.L / 2, bx = s * (pit.L / 2 + GOAL_DEPTH), bh = gh * 0.75;
      const net = (pts) => () => {
        const g = this.g;
        this.poly(pts, 'rgba(255,255,255,0.07)');
        g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 1;
        g.stroke();
        // mesh
        g.beginPath();
        const [a, b, c2, d] = pts;
        const n = 10;
        for (let i = 1; i < n; i++) {
          const u = i / n;
          this.line(mix(a[0], b[0], u), mix(a[1], b[1], u), mix(a[2], b[2], u), mix(d[0], c2[0], u), mix(d[1], c2[1], u), mix(d[2], c2[2], u));
          this.line(mix(a[0], d[0], u), mix(a[1], d[1], u), mix(a[2], d[2], u), mix(b[0], c2[0], u), mix(b[1], c2[1], u), mix(b[2], c2[2], u));
        }
        g.strokeStyle = 'rgba(255,255,255,0.13)'; g.stroke();
      };
      const parts = [
        { pts: [[bx, -gw, 0], [bx, gw, 0], [bx, gw, bh], [bx, -gw, bh]] },
        { pts: [[gx, -gw, gh], [gx, gw, gh], [bx, gw, bh], [bx, -gw, bh]] },
        { pts: [[gx, -gw, 0], [gx, -gw, gh], [bx, -gw, bh], [bx, -gw, 0]] },
        { pts: [[gx, gw, 0], [gx, gw, gh], [bx, gw, bh], [bx, gw, 0]] },
      ];
      for (const pt of parts) {
        const cx = pt.pts.reduce((a, q) => a + q[0], 0) / 4, cy = pt.pts.reduce((a, q) => a + q[1], 0) / 4;
        items.push({ d: cam.depth(cx, cy), fn: net(pt.pts) });
      }
      const S = (y) => (cam.persp ? cam.sc(gx, y, gh / 2) : cam.scale); // (perspective: as thick as where it is)
      const post = (y) => () => {
        const g = this.g;
        g.lineCap = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.16 * S(y) + 2;
        g.beginPath(); this.line(gx, y, 0, gx, y, gh); g.stroke();
        g.strokeStyle = '#f7f7f2'; g.lineWidth = Math.max(2, 0.16 * S(y));
        g.beginPath(); this.line(gx, y, 0, gx, y, gh); g.stroke();
      };
      items.push({ d: cam.depth(gx, -gw) + 0.01, fn: post(-gw) });
      items.push({ d: cam.depth(gx, gw) + 0.01, fn: post(gw) });
      items.push({
        d: cam.depth(gx, 0) + 0.01, fn: () => {
          const g = this.g;
          g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.16 * S(0) + 2;
          g.beginPath(); this.line(gx, -gw, gh, gx, gw, gh); g.stroke();
          g.strokeStyle = '#f7f7f2'; g.lineWidth = Math.max(2, 0.16 * S(0));
          g.beginPath(); this.line(gx, -gw, gh, gx, gw, gh); g.stroke();
        },
      });
    }
  }

  // ---------------------------------------------------------- entities

  shadow(x, y, r, a) {
    // soft-edged: a wide faint ellipse under a tighter darker one
    const g = this.g;
    g.fillStyle = `rgba(0,25,10,${a * 0.45})`;
    g.beginPath(); if (this.groundEllipse(x, y, r * 1.25)) g.fill();
    g.fillStyle = `rgba(0,25,10,${a * 0.75})`;
    g.beginPath(); if (this.groundEllipse(x, y, r * 0.85)) g.fill();
  }

  // Where my player is being guided to meet a high ball (receive assist).
  meetMarker(w, myId) {
    const me = w.players.find((p) => p.id === myId);
    const as = me && me._as;
    const b = w.ball;
    if (!as || b.owner >= 0 || !(b.z > 0.6 || b.vz > 1.5)) return;
    const g = this.g, cam = this.cam;
    const head = as.z > 1.5;
    const r = 0.45 + 0.08 * Math.sin(this.time * 9);
    g.strokeStyle = head ? 'rgba(255,214,102,0.9)' : TEAM_COLORS[me.team].ui;
    g.lineWidth = Math.max(1.5, 0.07 * cam.scale);
    g.beginPath(); if (this.groundEllipse(as.x, as.y, r)) g.stroke();
    g.fillStyle = g.strokeStyle;
    g.beginPath(); if (this.groundEllipse(as.x, as.y, r * 0.18)) g.fill();
  }

  ballShadow([x, y, z]) {
    const r = BALL_R * 1.7 * (1 + z * 0.12);
    this.shadow(x, y, r, 0.38 / (1 + z * 0.5));
  }

  drawBall(w, [x, y, z], dt) {
    const g = this.g, cam = this.cam;
    const sp = Math.hypot(w.ball.vx, w.ball.vy, w.ball.vz);
    const X = cam.px(x, y, z), Y = cam.py(x, y, z);
    // (perspective: its real size where it is – a little bigger, to read)
    const r = (cam.persp ? Math.max(2, BALL_R * 1.15 * cam.sc(x, y, z)) : Math.max(3, BALL_R * 1.75 * cam.scale)) * (this.ballScale ?? 1);
    // trail: shows speed, and the bend of a ball with spin (aftertouch / finesse)
    const curving = Math.abs(w.ball.spin) > 0.1 && w.ball.owner < 0;
    const len = curving ? 16 : 7;
    this.trail.push([x, y, z]);
    while (this.trail.length > len) this.trail.shift();
    if (sp > 11 || curving) {
      const col = curving ? '255,214,102' : '255,255,255';
      const n = this.trail.length;
      for (let i = 0; i < n - 1; i++) {
        const [tx, ty, tz] = this.trail[i];
        const a = (i + 1) / n;
        g.fillStyle = `rgba(${col},${(curving ? 0.45 : 0.3) * a})`;
        g.beginPath(); g.arc(cam.px(tx, ty, tz), cam.py(tx, ty, tz), r * (0.35 + 0.6 * a), 0, TAU); g.fill();
      }
    }
    this.ballRoll += Math.hypot(w.ball.vx, w.ball.vy) * dt / BALL_R;
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.beginPath(); g.arc(X, Y, r + 1, 0, TAU); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(X, Y, r, 0, TAU); g.fill();
    g.fillStyle = '#2a2f36';
    for (let i = 0; i < 3; i++) {
      const a = this.ballRoll * 0.35 + i * TAU / 3;
      const cx = X + Math.cos(a) * r * 0.5, cy = Y + Math.sin(a * 0.7) * r * 0.45;
      g.beginPath(); g.arc(cx, cy, r * 0.22, 0, TAU); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.beginPath(); g.arc(X - r * 0.35, Y - r * 0.35, r * 0.28, 0, TAU); g.fill();
  }

  animState(p, dt) {
    let a = this.anim.get(p.id);
    if (!a) { a = { ph: Math.random() * TAU, sp: 0, face: p.face, turn: 0, P: null, vf: 0, vl: 0 }; this.anim.set(p.id, a); }
    const sp = Math.hypot(p.vx, p.vy);
    a.sp += (sp - a.sp) * (1 - Math.exp(-dt * 12));
    // velocity in his own frame: forwards, and towards his R side (see skeleton)
    const cf = Math.cos(p.face), sf = Math.sin(p.face), kv = 1 - Math.exp(-dt * 10);
    a.vf += (p.vx * cf + p.vy * sf - a.vf) * kv; a.vl += (-p.vx * sf + p.vy * cf - a.vl) * kv;
    // turn rate, for leaning into curves
    const turn = dt > 0 ? angDiff(a.face, p.face) / dt : 0;
    a.turn += (clamp(turn, -12, 12) - a.turn) * (1 - Math.exp(-dt * 10));
    a.face = p.face;
    const stride = 1.0 + 0.16 * a.sp;
    a.ph += a.sp * dt / stride * Math.PI;
    if (a.ph > 1e4) a.ph -= 1e4 - (1e4 % TAU);
    return a;
  }

  drawPlayer(w, p, x, y, z, info, dt) {
    const J = this.posePlayer(w, p, x, y, z, info, dt);
    this.drawPose(p, J, info);
    return J;
  }

  drawPose(p, J, info, cam = this.cam, alpha = 1) {
    const s = stats(p.hgt, p.bld);
    drawFigure(this.g, cam, J, info.looks.get(p.id) || lookFor(null, p.team, p.role), s.H, s.width, alpha);
    p._headZ = J.head[2];
  }

  // A ball in someone's hands is drawn in his hands: a keeper holding it,
  // throwing it, or dropping it onto his boot for a punt; a throw-in taker.
  heldBallAt(w, p, J, [x, y]) {
    const b = w.ball;
    if (b.owner !== p.id || !b.held) return null;
    const fx = Math.cos(p.face), fy = Math.sin(p.face);
    const mid = [(J.handL[0] + J.handR[0]) / 2, (J.handL[1] + J.handR[1]) / 2, (J.handL[2] + J.handR[2]) / 2];
    let inHands = [mid[0] + fx * 0.07, mid[1] + fy * 0.07, mid[2] + 0.03];
    // just caught: it goes from where it was taken onto the hands (the arms
    // are already carrying it in, see posePlayer)
    const c = this.anim.get(p.id)?.carry;
    if (c) {
      const u = ease(clamp((this.time - c.t0) / (c.dive ? 0.18 : 0.13), 0, 1));
      const cf = Math.cos(p.face), sf = Math.sin(p.face);
      const from = [x + c.f * cf - c.r * sf, y + c.f * sf + c.r * cf, c.z];
      inHands = [from[0] + (inHands[0] - from[0]) * u, from[1] + (inHands[1] - from[1]) * u, from[2] + (inHands[2] - from[2]) * u];
    }
    if (p.st === ST.THROW && w.m.spTaker !== p.id) {
      const h = J.handR; // a keeper's throw: in the throwing hand
      return [h[0] + fx * 0.05, h[1] + fy * 0.05, h[2] + 0.05];
    }
    if (p.st === ST.KICK && p.kk === KICK.PUNT) {
      // let go of, it drops onto the boot (where the kick meets it)
      const u = clamp((p.stT / Math.max(1, p.stA) - 0.45) / 0.55, 0, 1);
      const c = [x + fx * 0.28, y + fy * 0.28, 0.45];
      return [inHands[0] + (c[0] - inHands[0]) * u * u, inHands[1] + (c[1] - inHands[1]) * u * u, inHands[2] + (c[2] - inHands[2]) * u * u];
    }
    if (p.st === ST.KICK && p.kk === KICK.DROP) {
      // a drop kick: let go of early, it falls to the grass in front of him and
      // is struck as it comes up off it
      const u = p.stT / Math.max(1, p.stA), c = [x + fx * 0.3, y + fy * 0.3];
      if (u < 0.2) return inHands;
      const v = clamp((u - 0.2) / 0.6, 0, 1), z = u < 0.8 ? mix(inHands[2], BALL_R, v * v) : BALL_R + (u - 0.8) / 0.2 * 0.05;
      return [mix(inHands[0], c[0], v), mix(inHands[1], c[1], v), z];
    }
    return inHands;
  }

  posePlayer(w, p, x, y, z, info, dt) {
    const s = stats(p.hgt, p.bld);
    const a = this.animState(p, dt);
    const m = w.m, b = w.ball;
    const holding = b.owner === p.id && b.held && m.spTaker !== p.id;
    // a catch: remember where the ball was (in his own frame, so it moves with
    // him); for a moment the arms carry it from there into his chest
    if (holding && !a.held && this.lastBall && dt > 0) {
      const [lx, ly, lz] = this.lastBall;
      const cf = Math.cos(p.face), sf = Math.sin(p.face);
      const f = (lx - x) * cf + (ly - y) * sf, r = -(lx - x) * sf + (ly - y) * cf;
      if (Math.hypot(f, r, lz - z - s.H * 0.6) < 2.2) a.carry = { t0: this.time, f, r, z: lz, dive: p.st === ST.DIVE };
      else a.pop = this.time; // not a catch – a new ball (a warm-up restart): it appears in his hands
    }
    a.held = holding;
    if (a.carry && (!holding || this.time - a.carry.t0 > (a.carry.dive ? 0.5 : 0.3))) a.carry = null;
    const carrying = a.carry && !a.carry.dive ? ease(clamp((this.time - a.carry.t0) / 0.3, 0, 1)) : -1;
    const ctx = {
      H: s.H, speed: a.sp, phase: a.ph, time: this.time,
      gkStance: p.role === ROLE.GK && b.owner !== p.id ? 1 : 0,
      holding,
      // cradled at his midriff (the ball itself is drawn in his hands)
      holdAt: holding && (p.st === ST.IDLE || p.st === ST.STUMBLE)
        ? (carrying >= 0
          ? { f: mix(a.carry.f, 0.14 * s.H, carrying), r: mix(a.carry.r, 0, carrying), z: mix(a.carry.z - z, 0.6 * s.H, carrying) }
          : { f: 0.14 * s.H, r: 0, z: 0.6 * s.H })
        : null,
      throwIn: b.owner === p.id && b.held && m.spTaker === p.id,
      throwInAnim: p.st === ST.THROW && Math.abs(Math.abs(p.y) - (pitchOf(w).W / 2)) < 1.2,
      throwRoll: p.st === ST.THROW && p.kh === KH.GROUND,
      fromHands: p.st === ST.KICK && (p.kk === KICK.PUNT || p.kk === KICK.DROP),
      dropKick: p.st === ST.KICK && p.kk === KICK.DROP,
      sidearm: p.st === ST.THROW && p.kh === KH.MID && m.spTaker !== p.id && Math.hypot(p.kx - x, p.ky - y) <= SIDEARM_MAX,
      vf: a.vf, vl: a.vl,
      diveHold: p.st === ST.DIVE && holding,
      celebrate: info.celebrateTeam === p.team && p.st === ST.IDLE,
      diveRel: angDiff(p.face, p.stA),
      diveEl: p.st === ST.DIVE && !p.spr ? diveReach(p, s)[1] : 0, // a high dive: body on a diagonal
      block: null, reach: null, windup: null, gkSet: 0, contact: null,
    };
    if (ctx.gkStance) {
      // set: hands up a little while an opponent has the ball within shooting range
      const o = b.owner >= 0 ? w.players.find((q) => q.id === b.owner) : null;
      if (o && o.team !== p.team) ctx.gkSet = clamp((26 - Math.hypot(o.x - p.x, o.y - p.y)) / 8, 0, 1);
    }
    // winding up a kick with the ball at the feet (not the lift / skill key)
    const kicking = p.chgBtn & 7;
    if (kicking && kicking !== 4 && b.owner === p.id && !b.held && (p.st === ST.IDLE || p.st === ST.STUMBLE)) {
      ctx.windup = { u: Math.min(1, p.tapH / 6), big: kicking === 3 ? 1 : 0.6 };
    }
    const cf = Math.cos(p.face), sf = Math.sin(p.face);
    const local = (wx, wy) => [(wx - x) * cf + (wy - y) * sf, -(wx - x) * sf + (wy - y) * cf];
    if (p.st === ST.BLOCK) {
      const [df, dr] = local(p.kx, p.ky);
      ctx.block = { df, dr, z: p.stB - z };
    } else if (p.st === ST.PUNCH || p.st === ST.TIP) {
      const [df, dr] = local(p.kx, p.ky);
      ctx.contact = { f: Math.max(0.08 * s.H, df), r: dr, z: clamp(p.stB - z, 0.5 * s.H, 1.35 * s.H) };
    } else if (ctx.gkStance && !ctx.holding && b.owner < 0 && (p.st === ST.IDLE || p.st === ST.STUMBLE)) {
      // keeper: hands to where a ball coming at him will reach him – they come
      // up in the last half second, earlier the faster it is
      const [bx, by, bz] = this.ballPos || [b.x, b.y, b.z];
      const v2 = b.vx * b.vx + b.vy * b.vy;
      const tc = v2 > 1 ? ((x - bx) * b.vx + (y - by) * b.vy) / v2 : -1; // time to its closest point
      const near = Math.hypot(bx - x, by - y) < 1.4;
      if (tc > -0.05 || near) {
        // the hands go out to meet it on its way in, ~0.45 m before it would
        // reach his body – a catch with the hands, not the chest
        const t = clamp(tc - 0.45 / Math.sqrt(v2), 0, 0.7);
        let pz = bz + b.vz * t - 0.5 * 9.81 * t * t;
        if (pz < 0.11) pz = 0.11 + Math.min(0.3, -pz * 0.3); // it'll have bounced
        const [df, dr] = local(bx + b.vx * t, by + b.vy * t);
        const e = near && tc < 0 ? 1 : clamp((0.55 - tc) / 0.35, 0, 1);
        if (e > 0) {
          // not past arm's length: the hands go out towards it as far as they can
          const reach = 0.6 * s.H, hd = Math.hypot(df, dr);
          const kk = hd > reach ? reach / hd : 1;
          ctx.reach = { f: Math.max(0.12 * s.H, df * kk), r: dr * kk, z: clamp(pz - z, 0.12, s.H * 1.22), e: ease(e), fast: v2 > 121 };
        }
      }
    }
    const target = poseFor(p, ctx);
    if (p.st === ST.IDLE || p.st === ST.STUMBLE) target.roll += clamp(a.turn * a.sp * 0.012, -0.28, 0.28);
    // blend towards the target pose so every transition flows (a keeper's
    // hands quicker: they follow the ball)
    if (!a.P || dt <= 0) a.P = { ...target };
    else {
      const kb = 1 - Math.exp(-dt * 20);
      const kh = carrying >= 0 ? 1 : 1 - Math.exp(-dt * (ctx.reach ? 32 + 40 * ctx.reach.e : 20));
      for (const key in target) a.P[key] += (target[key] - a.P[key]) * (ARM_KEYS.has(key) ? kh : kb);
    }
    const look = info.looks && info.looks.get(p.id);
    return skeleton(p, a.P, s.H, s.width, x, y, z, p.face, look && look.female);
  }

  overlay(w, p, x, y, z, info) {
    const g = this.gu, cam = this.cam, S = cam.persp ? cam.sc(x, y, z) : cam.scale;
    const s = stats(p.hgt, p.bld);
    const top = Math.max((p._headZ || s.H) + 0.35, z + 0.6);
    const mine = p.id === info.myId;
    if (cam.persp && !cam.ahead(x, y, top, 0.3)) return;
    const X = cam.px(x, y, top), Y = cam.py(x, y, top);
    const fs = Math.round(clamp(S * 0.3, 9, 12) * this.dpr);
    let nameY = Y - 2;
    if (mine) {
      // PES-style cursor
      const tc = TEAM_COLORS[p.team].ui;
      const bounce = Math.sin(this.time * 5) * 2;
      g.fillStyle = tc; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X, Y + bounce); g.lineTo(X - 7 * this.dpr, Y - 10 * this.dpr + bounce); g.lineTo(X + 7 * this.dpr, Y - 10 * this.dpr + bounce);
      g.closePath(); g.fill(); g.stroke();
      const by = Y - 16 * this.dpr; // (where the stamina bar used to be: the gauge sits above it)
      // power gauge
      if (p.chgBtn) {
        const u = p.chg / CHG_MAX;
        const gw = 44 * this.dpr, gy = by - 9 * this.dpr;
        g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(X - gw / 2 - 1, gy - 1, gw + 2, 6 * this.dpr + 2);
        g.fillStyle = u < 0.6 ? '#7ee06a' : u < 0.88 ? '#f4d03f' : '#ff5a4f';
        g.fillRect(X - gw / 2, gy, gw * u, 6 * this.dpr);
        // what is being charged: target + height
        const t = p.chgBtn & 7, h = (p.chgBtn >> 3) & 3;
        const boost = p.tap >= 3 ? ' · MAX' : p.tap === 2 ? ' ×2' : '';
        const what = KICK_LABEL[t] ? `${KICK_LABEL[t]} · ${(t === 3 ? SHOT_HEIGHT : HEIGHT_LABEL)[h]}${boost}` : '';
        if (what) {
          g.font = `700 ${Math.round(9 * this.dpr)}px system-ui, sans-serif`; g.textAlign = 'center';
          g.lineWidth = 2.5 * this.dpr; g.strokeStyle = 'rgba(0,0,0,0.65)';
          g.strokeText(what, X, gy - 3 * this.dpr);
          g.fillStyle = '#fff'; g.fillText(what, X, gy - 3 * this.dpr);
        }
      }
      nameY = (p.chgBtn ? by - 24 * this.dpr : by - 4 * this.dpr);
    }
    // small name tag for everyone (AI players dimmed)
    // a lagging player's stand-in: the AI plays him until his inputs come back
    const name = (info.names.get(p.id) || '') + (p.human && p.bot && info.names.get(p.id) ? ' · AI' : '');
    if (name) {
      g.font = `600 ${fs}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.globalAlpha = p.human ? 0.95 : 0.6;
      g.lineWidth = Math.max(2, 2.5 * this.dpr); g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.strokeText(name, X, nameY);
      g.fillStyle = mine ? '#ffffff' : p.human ? '#f2f6f3' : '#dfe7e2';
      g.fillText(name, X, nameY);
      g.globalAlpha = 1;
      if (p.human && !mine) { g.fillStyle = TEAM_COLORS[p.team].ui; g.fillRect(X - 7 * this.dpr, nameY + 2 * this.dpr, 14 * this.dpr, 1.5 * this.dpr); }
    }
    // quick-chat bubble
    const bub = info.bubbles && info.bubbles.get(p.id);
    if (bub) {
      g.font = `700 ${Math.round(fs * 1.15)}px system-ui, sans-serif`;
      const tw = g.measureText(bub).width + 12 * this.dpr, th = fs * 1.15 + 8 * this.dpr;
      const bx = X - tw / 2, byy = nameY - fs - th - 4 * this.dpr;
      g.fillStyle = 'rgba(255,255,255,0.94)';
      g.beginPath(); g.roundRect(bx, byy, tw, th, 6 * this.dpr); g.fill();
      g.beginPath(); g.moveTo(X - 4 * this.dpr, byy + th); g.lineTo(X + 4 * this.dpr, byy + th); g.lineTo(X, byy + th + 5 * this.dpr); g.fill();
      g.fillStyle = '#10200c'; g.textAlign = 'center';
      g.fillText(bub, X, byy + th - 6 * this.dpr);
    }
    const req = p.team === 0 ? w.m.req0 : w.m.req1;
    if (req === p.id && (p.team === 0 ? w.m.req0T : w.m.req1T) > 0) {
      g.font = `800 ${fs + 2}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 3;
      const yy = Y - (mine ? 30 : 16) * this.dpr;
      g.strokeText('!', X, yy); g.fillText('!', X, yy);
    }
  }

  // ---------------------------------------------------------- radar

  radar(rc, w, myId, offsets) {
    const g = rc.getContext('2d');
    const pit = pitchOf(w);
    const W = rc.width, H = rc.height;
    g.clearRect(0, 0, W, H);
    const pad = 6;
    const sx = (W - pad * 2) / pit.L, sy = (H - pad * 2) / pit.W;
    const X = (x) => pad + (x + pit.L / 2) * sx, Y = (y) => pad + (y + pit.W / 2) * sy;
    g.fillStyle = 'rgba(10,30,18,0.55)'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 1;
    g.strokeRect(X(-pit.L / 2), Y(-pit.W / 2), pit.L * sx, pit.W * sy);
    g.beginPath(); g.moveTo(X(0), Y(-pit.W / 2)); g.lineTo(X(0), Y(pit.W / 2)); g.stroke();
    for (const s of [-1, 1]) {
      const gx = s * pit.L / 2;
      g.strokeRect(Math.min(X(gx), X(gx - s * pit.boxD)), Y(-pit.boxW / 2), pit.boxD * sx, pit.boxW * sy);
    }
    for (const p of w.players) {
      g.fillStyle = p.role === ROLE.GK ? TEAM_COLORS[p.team].gk : TEAM_COLORS[p.team].ui;
      const r = p.id === myId ? 4 : 3;
      g.beginPath(); g.arc(X(p.x), Y(p.y), r, 0, TAU); g.fill();
      if (p.id === myId) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    }
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(X(w.ball.x), Y(w.ball.y), 2.5, 0, TAU); g.fill();
  }
}

function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }

// Standalone avatar preview (used by the editor).
export function drawAvatarPreview(canvas, avatar, team, t) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  const cam = new Camera();
  cam.set(35, 18);
  cam.w = W; cam.h = H;
  const s = stats(avatar.phys.h, avatar.phys.b);
  cam.scale = H / 2.35;
  cam.cx = 0; cam.cy = 0;
  // centre the figure vertically: project feet/head
  const look = lookFor(avatar, team, ROLE.OUT);
  const run = (Math.sin(t * 0.5) + 1) / 2 > 0.55;
  const sp = run ? 5.5 : 0;
  const ph = t * (sp ? 7 : 0);
  const p = { id: 0, st: ST.IDLE, stT: 0, stA: 0, stDur: 1, kk: 0, z: 0 };
  const P = poseFor(p, { H: s.H, speed: sp, phase: ph, time: t, gkStance: 0, diveRel: 0 });
  const face = t * 0.7;
  const J = skeleton(p, P, s.H, s.width, 0, 0, 0, face, look.female);
  // shift so that the figure stands on the lower part of the canvas
  const footY = cam.py(0, 0, 0);
  const offset = H * 0.88 - footY;
  g.save();
  g.translate(0, offset);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath(); g.ellipse(W / 2, footY, 0.4 * cam.scale, 0.4 * cam.scale * cam.se, 0, 0, TAU); g.fill();
  // the same 3D model as on the pitch, rendered aside and copied in
  if (preview3d === undefined) preview3d = Scene3D.create(document.createElement('canvas'), true);
  if (!preview3d) drawFigure(g, cam, J, look, s.H, s.width);
  g.restore();
  if (preview3d) {
    if (preview3d.canvas.width !== W || preview3d.canvas.height !== H) preview3d.setSize(W, H);
    const m = cam.clipMatrix();
    m[7] -= offset * 2 / H; // (shifted down like the 2D drawing)
    preview3d.setCamera(m);
    preview3d.beginFrame();
    preview3d.player(0, J, look, s.H, s.width);
    preview3d.endFrame();
    preview3d.render();
    g.drawImage(preview3d.canvas, 0, 0);
  }
}
let preview3d; // (one WebGL context for every preview)
