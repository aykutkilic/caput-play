// Minimal isometric renderer (Canvas 2D, orthographic camera) with procedural
// skeletal animation: every pose is computed from simulation state each frame,
// so animations stay fluid and always agree with what the physics is doing.

import { GOAL_DEPTH, BALL_R, ST, ROLE, PHASE, KICK, SP, SKILL, KH, PART, GKB, KQ, FOOT } from '../shared/constants.js';
import { stats } from '../shared/physique.js';
import { CHG_MAX, pitchOf, DIVE_BASE, DIVE_SPAN, diveReach, SIDEARM_MAX, teamDir, keeperBig, CELEB_TICKS } from '../shared/sim.js';
import { skeleton, drawFigure } from './figure.js';
import { Scene3D } from './mesh3d.js';
import { Effects } from './fx.js';
import { GAIT } from './gait.js';

export { skeleton, drawFigure };

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const BALL_MIN_PX = 2.5; // the ball's smallest radius on screen (CSS px)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (u) => u * u * (3 - 2 * u);
const mix = (a, b, u) => a + (b - a) * u;

const KICK_LABEL = ['', 'PASS', 'RUN', 'SHOT', 'SELF'];
const HEIGHT_LABEL = ['feet', 'chest', 'head'];
const SHOT_HEIGHT = ['low', 'mid', 'top'];

// Shadows: the sun (the 3D layer's: high in the afternoon, from the left as
// the isometric view sees it) casts a point 1 m up this far along the grass,
// and how dark (a: the fill's alpha). A floodlight (x, y, h) casts from where
// it stands.
const SUN = { dx: 0.75, dy: -0.15, a: 0.27 };
// The ground by the weather: grass (outside the lines, the two stripes), the
// markings, the worn patches (r,g,b), the night beyond the boards (bg)
// (shadow: how dark the sun's shadows are – the sky's cloud; night: the
// floodlights cast them, four apiece)
const ENVS = {
  day: { grass: ['#2c6b3f', '#358048', '#3a8a4f'], lines: 'rgba(242,247,238,0.84)', worn: '150,140,86', bg: '#0e1a14', apron: '#39413b', speck: 0, sky: ['#3d6fa8', '#8fb7dd', '#cfe2ee'], shadow: 0.27 },
  night: { grass: ['#1c4229', '#245a37', '#28633c'], lines: 'rgba(232,240,234,0.8)', worn: '120,116,80', bg: '#04070a', apron: '#1b211e', speck: 0, sky: ['#02040a', '#08111f', '#152338'], shadow: 0.09 },
  rain: { grass: ['#21573a', '#296b42', '#2d7347'], lines: 'rgba(232,240,236,0.78)', worn: '92,84,58', bg: '#0b1310', apron: '#2b3330', speck: 'rgba(205,225,255,0.12)', sky: ['#48525d', '#76838f', '#a3aeb8'], shadow: 0.12 },
  snow: { grass: ['#d6dee4', '#e3e9ee', '#ecf1f4'], lines: 'rgba(52,104,204,0.85)', worn: '72,124,76', bg: '#1a2127', apron: '#c4ccd3', speck: 'rgba(70,120,80,0.1)', sky: ['#8794a1', '#bfc8d1', '#e1e6eb'], shadow: 0.15 },
};
const WEATHERS = ['day', 'night', 'rain', 'snow'];
// the floodlights: on the towers beyond the corners (see the 3D stadium), 25 m up
const floodlights = (pit) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: a * (pit.L / 2 + 9.5), y: b * (pit.W / 2 + 8.5), h: 25, a: ENVS.night.shadow }));
const TILE_M = 4, TILE_PX = 256; // a grass tile: 4 m, at 64 px a metre
const tileCache = new Map();
// The grass tiles (outside, stripe, stripe): each its colour with fine
// speckles and blades of lighter and darker grass in it.
function grassTiles(E, ctx) {
  let t = tileCache.get(E);
  if (t) return t;
  t = E.grass.map((base, k) => {
    const c = document.createElement('canvas'); c.width = c.height = TILE_PX;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, TILE_PX, TILE_PX);
    let seed = 7 + k * 101;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,230,0.07)' : 'rgba(0,30,10,0.09)';
      g.fillRect(rnd() * TILE_PX, rnd() * TILE_PX, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    g.lineWidth = 1;
    for (let i = 0; i < 260; i++) {
      const x = rnd() * TILE_PX, y = rnd() * TILE_PX, a = rnd() * TAU, l = 2 + rnd() * 4;
      g.strokeStyle = rnd() < 0.6 ? 'rgba(220,255,200,0.08)' : 'rgba(0,25,5,0.1)';
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    // (wet: glints of water; snow: grass showing through)
    if (E.speck) for (let i = 0; i < 300; i++) { g.fillStyle = E.speck; g.fillRect(rnd() * TILE_PX, rnd() * TILE_PX, 1 + rnd() * 2, 1); }
    return ctx.createPattern(c, 'repeat');
  });
  tileCache.set(E, t);
  return t;
}
const lightAt = (l, x, y) => (l.h ? [(x - l.x) / l.h, (y - l.y) / l.h] : [l.dx, l.dy]);
// a player's shadow in pieces: limbs (joint to joint, half-width x height)
// and discs at the joints, so the bands join up round
// (few enough to be cheap: the feet and the small joints don't show at this size)
const SHADOW_LIMBS = [
  ['hipL', 'kneeL', 0.058], ['kneeL', 'footL', 0.042], ['hipR', 'kneeR', 0.058], ['kneeR', 'footR', 0.042],
  ['shL', 'elL', 0.04], ['elL', 'handL', 0.03], ['shR', 'elR', 0.04], ['elR', 'handR', 0.03],
  ['hc', 'neck', 0.1], ['shL', 'shR', 0.05], ['hipL', 'hipR', 0.06],
];
const SHADOW_DISCS = [['kneeL', 0.042], ['kneeR', 0.042], ['hc', 0.1], ['neck', 0.1], ['head', 0.095]];
// (four floodlights' worth: the legs, the body and the head – faint enough
// that the arms aren't missed)
const SHADOW_LIMBS_NIGHT = SHADOW_LIMBS.filter(([a]) => !/^(sh|el)/.test(a));
const SHADOW_DISCS_NIGHT = [['hc', 0.1], ['head', 0.095]];
const SHADOW_JOINTS = [...new Set([...SHADOW_LIMBS.flatMap(([a, b]) => [a, b]), ...SHADOW_DISCS.map(([k]) => k)])];

// The kits (KIT_NAMES order); ui: the team's colour in the HUD, light enough
// to read on the dark panels
const KITS = [
  { shirt: '#e5483b', shorts: '#f4f1ea', socks: '#e5483b', trim: '#ffffff', ui: '#ff6a5c' },
  { shirt: '#2f6be0', shorts: '#14264f', socks: '#2f6be0', trim: '#d6e4ff', ui: '#5b91ff' },
  { shirt: '#1c2d66', shorts: '#f4f1ea', socks: '#1c2d66', trim: '#f2c230', ui: '#7d9cf0' },
  { shirt: '#f4c824', shorts: '#1c2d66', socks: '#f4c824', trim: '#1e1e1e', ui: '#ffd84a' },
  { shirt: '#f3f3ef', shorts: '#f3f3ef', socks: '#f3f3ef', trim: '#22262e', ui: '#ffffff' },
  { shirt: '#1f2024', shorts: '#1f2024', socks: '#1f2024', trim: '#e6e6e6', ui: '#c9cdd4' },
];
// keepers: the first of these that clashes with neither side (nor the other keeper)
const GK_KITS = [
  { gk: '#f2c230', gkShorts: '#2b2b2b', gkTrim: '#1e1e1e' },
  { gk: '#3fd08f', gkShorts: '#1c2c24', gkTrim: '#0f2a1d' },
  { gk: '#ff8a1f', gkShorts: '#2b2b2b', gkTrim: '#1e1e1e' },
  { gk: '#b05cff', gkShorts: '#22182e', gkTrim: '#140d1d' },
  { gk: '#ff5fa2', gkShorts: '#2b2b2b', gkTrim: '#1e1e1e' },
];
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const clash = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i])) < 100;
export const TEAM_COLORS = [{}, {}];
let kitsNow = '';
// Dress the two teams (room setting, KIT_NAMES indices): everything reads
// TEAM_COLORS, so it's changed in place.
export function setKits(kits = [0, 1]) {
  const k = kits.map((v) => KITS[v] ? v : 0), key = k.join();
  if (key === kitsNow) return;
  kitsNow = key;
  const used = [KITS[k[0]].shirt, KITS[k[1]].shirt];
  for (const team of [0, 1]) {
    const order = team ? [1, 0, 2, 3, 4] : [0, 1, 2, 3, 4];
    const gk = GK_KITS[order.find((i) => !used.some((c) => clash(c, GK_KITS[i].gk))) ?? order[0]];
    used.push(gk.gk);
    Object.assign(TEAM_COLORS[team], KITS[k[team]], gk);
  }
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--a', TEAM_COLORS[0].ui);
    document.documentElement.style.setProperty('--b', TEAM_COLORS[1].ui);
  }
}
setKits();

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

// a pose done with the other leg (and the arms swapped to balance it)
function mirrorLegs(P) {
  for (const [l, r] of [['lh', 'rh'], ['lk', 'rk'], ['la', 'ra'], ['lfy', 'rfy'], ['lsh', 'rsh'], ['lab', 'rab'], ['lel', 'rel']]) [P[l], P[r]] = [P[r], P[l]];
  P.tw = -P.tw;
}

function basePose() {
  return {
    lean: 0.04, tw: 0, drop: 0, bob: 0, head: 0, hy: 0,
    lh: 0, lk: 0.12, la: 0.05, rh: 0, rk: 0.12, ra: 0.05, lfy: 0, rfy: 0,
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

// ---------------------------------------------------------------- the stride

// Steps a second at a pace (the stride's phase moves pi a step): ~2 walking,
// ~2.9 at 3.3 m/s (real runners, gait.js), ~4.5 flat out.
const cadence = (sp) => (1.6 + 0.35 * sp) * Math.min(1, sp / 0.6);
// The share of a stride a foot is on the grass: as measured at gait.js's pace,
// more walking (both feet down for a moment), less at a sprint (~0.2).
const duty = (sp) => Math.min(0.62, 0.18 + (GAIT.duty - 0.18) * Math.exp(-(sp - GAIT.v) / (sp < GAIT.v ? 1.2 : 2.5)));

// one of gait.js's curves at the phase set by stridePhase: 0 at its low, 1
// at its high; o -1 for the right side (half a stride on)
const GC = new Float64Array(5), GS = new Float64Array(5);
const GT = { lh: 0, lk: 0, la: 0, rh: 0, rk: 0, ra: 0 }; // (a leg's angles reaching its foot)
function stridePhase(ph) {
  GC[1] = Math.cos(ph); GS[1] = Math.sin(ph);
  for (let k = 2; k <= 4; k++) { GC[k] = GC[k - 1] * GC[1] - GS[k - 1] * GS[1]; GS[k] = GS[k - 1] * GC[1] + GC[k - 1] * GS[1]; }
}
const curve = (f, o = 1) => f[0] + o * (f[1] * GC[1] + f[2] * GS[1]) + f[3] * GC[2] + f[4] * GS[2] + o * (f[5] * GC[3] + f[6] * GS[3]) + f[7] * GC[4] + f[8] * GS[4];

// Running forwards, blended in by w: each leg swings through as real runners'
// do (motion capture – gait.js: the knee folding high behind, the thigh
// driving through) and, while its foot is down, reaches it where it landed –
// planted on the grass as the body goes over it, no skating; the arms swing
// mostly behind with the elbows well bent, the shoulders twist against the
// hips and the body rises and falls twice a stride, lowest over the planted
// foot. Sized by pace from the measured one (gait.js: ~3.3 m/s); faster than
// that, as sprinters do – knees higher, arms driving further.
// (gait.js's curves' middles and half-ranges)
const GM = {}, GH = {};
for (const k in GAIT.ch) { const c = GAIT.ch[k]; GM[k] = (c.lo + c.hi) / 2; GH[k] = (c.hi - c.lo) / 2; }
function stride(P, sp, ph, H, w) {
  const ch = GAIT.ch, r = sp / GAIT.v, r1 = Math.min(1, r), up = Math.max(0, r - 1), e = w * Math.min(1, sp / 0.6);
  if (e <= 0) return;
  stridePhase(ph);
  const hipH = 0.53 * H;
  P.drop = mix(P.drop, GAIT.drop * hipH * r1, e);
  P.bob = mix(P.bob, hipH * (ch.bob.lo + 2 * GH.bob * curve(ch.bob.f)) * r1, e);
  P.tw = mix(P.tw, GH.tw * r1 * (2 * curve(ch.tw.f) - 1), e);
  P.lean += e * r1 * GH.lean * (2 * curve(ch.lean.f) - 1);
  const thLo = ch.thigh.lo * r1, thHi = Math.min(1.3, ch.thigh.hi * r);
  const kLo = ch.knee.lo * r1, kHi = Math.min(2.35, ch.knee.hi * Math.pow(r1, 0.9) + 0.1 * up);
  const aMid = GM.arm * r1 + 0.15 * up, aHalf = GH.arm * r1 + 0.25 * up;
  const eMid = Math.max(1.4, 0.25 + (GM.elbow - 0.25) * r1 - 0.15 * up), eHalf = GH.elbow * r1;
  const beta = duty(sp), cad = cadence(sp), hz = hipH - P.drop + P.bob, foot = 0.13 * H;
  for (let side = -1; side <= 1; side += 2) {
    const o = -side, L = side < 0;
    // the swing
    const th = thLo + (thHi - thLo) * curve(ch.thigh.f, o), kn = kLo + (kHi - kLo) * curve(ch.knee.f, o);
    const sh = aMid + aHalf * (2 * curve(ch.arm.f, o) - 1), el = eMid + eHalf * (2 * curve(ch.elbow.f, o) - 1);
    const ab = mix(0.12, ch.armAbd.lo + 2 * GH.armAbd * curve(ch.armAbd.f, o), r1);
    if (L) { P.lh = mix(P.lh, th, e); P.lk = mix(P.lk, kn, e); P.lsh = mix(P.lsh, sh, e); P.lel = mix(P.lel, el, e); P.lab = mix(P.lab, ab, e); }
    else { P.rh = mix(P.rh, th, e); P.rk = mix(P.rk, kn, e); P.rsh = mix(P.rsh, sh, e); P.rel = mix(P.rel, el, e); P.rab = mix(P.rab, ab, e); }
    // the foot down: from landing to push-off it stays where it landed while
    // the hip passes over it (under it mid-way), lifting off past either end
    const d = ((ph - GAIT.stance - (L ? 0 : Math.PI)) % TAU + TAU * 1.5) % TAU - Math.PI, u = Math.abs(d) / (beta * Math.PI);
    if (u >= 1.35) continue;
    const k = clamp((1.35 - u) / 0.35, 0, 1), lift = u > 1 ? 0.5 * H * (u - 1) * (u - 1) : 0;
    const df = -sp * d / (cad * Math.PI), dr = side * 0.01 * H;
    legIK(GT, side, df, dr, 0.006 * H + lift - hz, H, 1);
    // pushing off he rolls up onto his toes: the foot tips (legFK's foot
    // angle follows the shin) about the toe, which stays where it was on the
    // grass – the ankle rising and edging forward round it
    // (twice: lifting the ankle tips the foot a little further)
    for (let it = 0; it < 2; it++) {
      const fa = clamp(0.7 * (L ? GT.lh - GT.lk : GT.rh - GT.rk), -0.5, 0.9);
      if (fa >= 0) break;
      legIK(GT, side, df + foot * (1 - Math.cos(fa)), dr, 0.006 * H - Math.sin(fa) * foot + lift - hz, H, 1);
    }
    const q = ease(k) * e;
    if (L) { P.lh = mix(P.lh, GT.lh, q); P.lk = mix(P.lk, GT.lk, q); P.la = mix(P.la, GT.la, q); }
    else { P.rh = mix(P.rh, GT.rh, q); P.rk = mix(P.rk, GT.rk, q); P.ra = mix(P.ra, GT.ra, q); }
  }
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
  // the thigh swings as far as each step needs (with the cadence in
  // animState) for the foot on the grass to go back under him as fast as he
  // goes forward – fitted so the planted foot stays put rather than skating
  const swing = Math.min(1.05, 0.25 + 0.085 * sp) * Math.min(1, sp / 0.6) * (1 - 2 * back) * (1 - 0.3 * back);
  P.lh = swing * s; P.rh = -swing * s;
  P.lk = 0.12 + A * (0.25 + lift * Math.max(0, c));
  P.rk = 0.12 + A * (0.25 + lift * Math.max(0, -c));
  P.lsh = -A * 0.78 * s; P.rsh = A * 0.78 * s;
  P.lel = P.rel = 0.3 + A * 1.05;
  P.tw = -0.24 * A * s;
  P.lean = 0.04 + A * 0.2 * (1 - 1.3 * back) + (1 - Math.min(1, A * 3)) * 0.015 * Math.sin(t * 2.1);
  P.bob = A * 0.05 * Math.abs(s);
  // going forwards: the stride as real runners run it (back-pedalling: the
  // cycle above, run backwards)
  stride(P, sp, ph, H, 1 - back);
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
  // hard off the mark he leans into it; braking hard he sits back on bent
  // knees, the feet out in front
  const acc = ctx.acc || 0, brake = clamp(-acc / 12, 0, 1) * Math.min(1, sp / 2), drive = clamp(acc / 10, 0, 1);
  P.lean += 0.12 * drive - 0.28 * brake;
  P.lk += 0.25 * brake; P.rk += 0.25 * brake; P.drop += 0.04 * H * brake;
  P.head = -P.lean * 0.55;
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
  if (ctx.gkBig > 0) {
    // making himself big against a man close in: arms out wide and a little
    // down, palms to the ball, knees bent, feet apart – on the move too
    const g = ctx.gkBig, still = 1 - Math.min(1, A * 1.5);
    P.lh += 0.12 * g * still; P.rh += 0.12 * g * still; P.lk += 0.2 * g * still; P.rk += 0.2 * g * still;
    P.la = P.ra = mix(P.la, 0.24, g * still); P.drop += 0.03 * H * g;
    for (const side of [-1, 1]) armIK(P, side, 0.1 * H, side * 0.52 * H, 0.47 * H, H, g);
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
  if (ctx.celebrate === 'slide' || ctx.celebrate === 'kneel') {
    // the scorer on his knees – sliding on the grass, leaning back, arms
    // flung wide; then there, arms up
    const slide = ctx.celebrate === 'slide';
    P.drop = 0.22 * H; P.lh = P.rh = 0.05; P.lk = P.rk = 1.75; P.la = P.ra = 0.14; P.bob = 0;
    P.lean = slide ? -0.55 : -0.15; P.head = slide ? -0.4 : -0.25;
    P.lsh = P.rsh = slide ? 2.0 : 2.7; P.lab = P.rab = slide ? 1.3 : 0.6; P.lel = P.rel = 0.15;
  } else if (ctx.celebrate === 'hug') {
    // round the scorer: arms out round him
    P.lsh = P.rsh = 1.45; P.lab = P.rab = 0.5; P.lel = P.rel = 1.15; P.lean += 0.12;
  } else if (ctx.celebrate) {
    const j = Math.abs(Math.sin(t * 7 + p.id));
    const kind = p.id % 3;
    if (kind === 0) { P.lsh = P.rsh = 2.75; P.lab = P.rab = 0.45; P.lel = P.rel = 0.2; P.bob += 0.18 * j * (A < 0.3 ? 1 : 0.3); }
    else if (kind === 1) { P.lsh = P.rsh = 0.25; P.lab = P.rab = 1.45; P.lel = P.rel = 0.1; P.roll += 0.22 * Math.sin(t * 3); } // aeroplane
    else { P.rsh = 2.6 + 0.3 * Math.sin(t * 9); P.rel = 1.2; P.lsh = 0.3; P.lel = 1.3; P.bob += 0.1 * j; } // fist pump
  }
  // the side that let it in: hands on heads; standing, some bent over hands
  // on knees; the keeper down on his knees slapping the grass
  if (ctx.dejected === 'slap') {
    P.drop = 0.22 * H; P.lh = P.rh = 0.05; P.lk = P.rk = 1.75; P.la = P.ra = 0.14; P.bob = 0;
    P.lean = 0.45; P.head = 0.35;
    P.lsh = 0.5; P.lel = 0.3; P.rsh = 0.3 + 1.6 * Math.max(0, Math.sin(t * 6)); P.rel = 0.25; P.rab = 0.25;
  } else if (ctx.dejected === 'knees') {
    P.drop = 0.1 * H; P.lh = P.rh = 0.75; P.lk = P.rk = 0.95; P.lean = 0.75; P.head = -0.35;
    P.lsh = P.rsh = 0.35; P.lab = P.rab = 0.15; P.lel = P.rel = 0.15;
  } else if (ctx.dejected === 'head') {
    P.lsh = P.rsh = 2.45; P.lab = P.rab = 1.05; P.lel = P.rel = 2.3; P.head = 0.3;
  }

  if ((p.st === ST.IDLE || p.st === ST.STUMBLE) && p.z > 0.04) {
    const u = clamp(p.z / 0.22, 0, 1);
    P.lh = mix(P.lh, 1.1, u); P.lk = mix(P.lk, 1.7, u); P.rh = mix(P.rh, 0.15, u); P.rk = mix(P.rk, 0.55, u);
  }
  const k = p.stT;
  switch (p.st) {
    case ST.KICK: {
      if (p.kq === KQ.HEEL) {
        // back-heel: the foot steps over the ball, then the heel snaps back
        // into it and the leg swings through behind him
        const cT = Math.max(1, p.stA), dT = Math.max(cT + 1, p.stDur);
        const u = k < cT ? ease(k / cT) : 1, f = k < cT ? 0 : clamp((k - cT) / (dT - cT), 0, 1);
        const snap = Math.min(1, f / 0.3), back = f < 0.3 ? snap : 1 - (f - 0.3) / 0.7;
        P.rh = k < cT ? 0.4 * u : mix(0.4, -0.55, snap) * (f < 0.3 ? 1 : back);
        P.rk = k < cT ? 0.3 + 0.35 * u : mix(0.65, 1.25, snap) * (f < 0.3 ? 1 : 0.3 + 0.7 * back);
        P.lh = 0.08; P.lk = 0.3; P.lean = 0.1 + 0.08 * back;
        P.lsh = 0.45; P.lab = 0.8; P.rsh = 0.25; P.rab = 0.6;
        break;
      }
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
      if (p.kc && !ctx.fromHands) {
        // bent (p.kc: + bends it right on screen, - left): with the inside of
        // the foot – the left one to bend it right, the right one left – the
        // toe turned out, the foot opening onto the ball, more for more curl;
        // or the outside of the other (p.kf – his stronger foot bending it the
        // other way): toe turned in
        const out = p.kf === FOOT.OUTSIDE;
        P.rfy = out ? -0.75 : Math.min(1, Math.abs(p.kc) * 1.6) * 0.95;
        if ((p.kc > 0) !== out) mirrorLegs(P);
      } else if (p.ft && !ctx.fromHands) mirrorLegs(P); // (struck straight: with his stronger foot)
      if (p.kq === KQ.TURN && k < cT) {
        // turning with the ball first: little steps round on the spot, the
        // leg drawing back only as he comes round to face the goal
        let left = Math.atan2(p.ky - p.y, p.kx - p.x) - p.face;
        left = Math.abs(Math.atan2(Math.sin(left), Math.cos(left)));
        const u = clamp(1 - (left - 0.9) / 0.6, 0, 1), st = Math.sin(k * 1.1);
        P.rh = mix(0.3 * st, rh, u); P.rk = mix(0.35 + 0.35 * Math.max(0, st), rk, u);
        P.lh = mix(-0.3 * st, 0.12, u); P.lk = mix(0.35 + 0.35 * Math.max(0, -st), 0.3, u);
        P.tw = mix(0, P.tw, u); P.lean = mix(0.08, P.lean, u);
        P.lsh = mix(0.35, P.lsh, u); P.rsh = mix(0.35, P.rsh, u); P.lab = mix(0.5, P.lab, u); P.rab = mix(0.5, P.rab, u);
      }
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
      } else if (p.stA === SKILL.ELASTICO) {
        // the outside of the foot out one way, the inside snapping it back
        // across – the right foot cutting left, the left cutting right
        const side = p.stB >= 0 ? 1 : -1, u1 = ease(clamp(k / 6, 0, 1)), u2 = ease(clamp((k - 6) / 6, 0, 1)), out = u1 * (1 - u2);
        const end = clamp((p.stDur - k) / 5, 0, 1), ab = (0.75 * out - 0.45 * u2) * end, th = (0.45 + 0.15 * u2) * end;
        if (side > 0) { P.ra = ab; P.rh = th; P.rk = 0.45 * end; P.rfy = (-0.6 * out + 0.7 * u2) * end; P.lk = 0.4; }
        else { P.la = ab; P.lh = th; P.lk = 0.45 * end; P.lfy = (-0.6 * out + 0.7 * u2) * end; P.rk = 0.4; }
        P.roll = (-0.12 * out + 0.28 * u2) * side * end; P.lean = 0.15; P.lab = P.rab = 0.55 * end;
      } else if (p.stA === SKILL.RAINBOW) {
        // the right heel behind the ball draws it up the back of the left leg,
        // then kicks up and flicks it over his head
        const up = ease(clamp(k / 8, 0, 1)), flick = clamp((k - 9) / 4, 0, 1) * clamp((18 - k) / 5, 0, 1);
        P.lh = 0.12; P.lk = 0.3; P.rh = -0.45 * up * (1 - flick) - 0.15 * flick; P.rk = 1.25 * up + 0.9 * flick;
        P.lean = 0.12 + 0.12 * flick; P.lab = P.rab = 0.5 * env; P.head = -0.25 * flick;
      } else if (p.stA === SKILL.AROUND) {
        // the foot goes round the ball as it drops, then back under it
        const c = p.stB, th = clamp((k - (c - 14)) / 14, 0, 1) * Math.PI * 2, round = k < c && k > c - 14 ? 1 : 0, touch = clamp(1 - Math.abs(k - c) / 4, 0, 1);
        P.rh = 0.6 + 0.35 * round * Math.sin(th) + 0.2 * touch; P.ra = 0.55 * round * Math.cos(th); P.rk = 1.0 * round + 0.35 * touch;
        P.rfy = 0.5 * round * Math.sin(th); P.lk = 0.35; P.lab = P.rab = 0.7; P.roll = -0.12 * round * Math.cos(th); P.lean = -0.05;
      } else if (p.stA === SKILL.NECK) {
        // bent over under it, head up and arms out: it settles on the back of
        // his neck and stays there
        const bend = p.hit === 1 ? 1 : ease(clamp(k / Math.max(2, p.stB), 0, 1)) * clamp((p.stDur - k) / 8, 0, 1);
        P.lean = 1.15 * bend; P.drop = 0.05 * H * bend; P.lk = P.rk = 0.35 * bend; P.lh = P.rh = 0.2 * bend;
        P.head = -0.55 * bend; P.lab = P.rab = 1.0 * bend; P.lsh = P.rsh = 0.2; P.lel = P.rel = 0.4;
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
    this.lights = [SUN]; // what casts the shadows
    this.env = ENVS.day; this.weather = 'day';
    this.effectsMode = 'auto'; this.lite = false;
    this.fx = new Effects(this);
    this.fx.lite = false;
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

  // The weather (room setting, WEATHER_NAMES): the grass, the light and the
  // shadows, what falls from the sky, what flies off the grass.
  setWeather(n) {
    const kind = WEATHERS[n] || 'day';
    if (kind === this.weather) return;
    this.weather = kind;
    this.env = ENVS[kind];
    this.lights = kind === 'night' ? [] : [{ ...SUN, a: this.env.shadow }]; // (night: by the pitch, each frame)
    this.fx.setGround(kind === 'rain' ? 'wet' : kind === 'snow' ? 'snow' : 'grass');
    if (this.s3) this.s3.setWeather(kind);
    this.drops = null;
    if (typeof document !== 'undefined') document.body.classList.toggle('snow', kind === 'snow');
  }

  // Lighter effects (a slow device): fewer particles, fans, drops and night
  // shadows. 'auto' turns them on by itself if frames come too slowly.
  setEffects(mode) {
    this.effectsMode = mode;
    this.lite = mode === 'light';
    this.fx.lite = this.lite;
    this.slow = 0;
  }

  // (auto: a few seconds of frames under ~40 a second and it stays lighter)
  watchSpeed(dt) {
    if (this.effectsMode !== 'auto' || this.lite || dt <= 0) return;
    this.slow = dt > 1 / 40 ? (this.slow || 0) + dt : Math.max(0, (this.slow || 0) - dt * 0.5);
    if (this.slow > 4) { this.lite = true; this.fx.lite = true; console.info('[render] slow frames: lighter effects'); }
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
    this.watchSpeed(dt);
    const pit = pitchOf(w);
    if (this.weather === 'night') {
      const fl = floodlights(pit);
      // (lighter: the two towers on the diagonal)
      this.lights = this.lite ? [fl[0], fl[2]].map((l) => ({ ...l, a: l.a * 1.4 })) : fl;
    }
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
    this.ballR = this.ballRadius(ball);

    // camera: follow the ball with a little look-ahead, biased towards me
    // (a dribbler's steady run, not the ball's touch-by-touch pulsing)
    const carrier = w.ball.owner >= 0 ? w.players.find((p) => p.id === w.ball.owner) : null;
    const lv = carrier || w.ball;
    let tx = ball[0] + clamp(lv.vx * 0.25, -4, 4), ty = ball[1] + clamp(lv.vy * 0.25, -4, 4);
    const me = ppos.get(info.myId);
    if (me) { tx = tx * 0.72 + me[0] * 0.28; ty = ty * 0.72 + me[1] * 0.28; }
    // after a goal, before the replay: in close on the scorer
    const fp = info.focus >= 0 && ppos.get(info.focus);
    this.focusK = clamp((this.focusK || 0) + (fp ? dt * 1.2 : -dt * 2.5), 0, 1);
    if (fp) this.focusAt = fp;
    if (this.focusK > 0 && this.focusAt) {
      const u = ease(this.focusK);
      tx += (this.focusAt[0] - tx) * u; ty += (this.focusAt[1] - ty) * u;
      cam.scale *= 1 + 0.5 * u;
    }
    tx = clamp(tx, -pit.L / 2 - 2, pit.L / 2 + 2); ty = clamp(ty, -pit.W / 2 - 1, pit.W / 2 + 1);
    const k = 1 - Math.exp(-dt * 3.2);
    if (!this.camInit) { this.camX = tx; this.camY = ty; this.camInit = true; }
    this.camX += (tx - this.camX) * k; this.camY += (ty - this.camY) * k;
    const [kx, ky] = this.fx.camOffset(); // (its kick at a hard shot, the woodwork, a goal)
    cam.cx = this.camX + kx; cam.cy = this.camY + ky;
    // third person: behind my player (back to the isometric view while I'm
    // not on the pitch)
    const mine = this.tp && !info.replayCam && w.players.find((p) => p.id === info.myId);
    const tpOn = !!mine;
    if (tpOn) cam = this.cam = this.thirdPerson(w, mine, ppos.get(mine.id), ball, dt);
    // a replay's slow-motion finish: from behind the goal
    if (info.replayCam) cam = this.cam = this.broadcast(w, ball, info.replayCam, dt);
    else this.bcInit = false;
    if (this.tpShown !== tpOn) { this.tpShown = tpOn; document.body.classList.toggle('tp', tpOn); }
    // background
    g.fillStyle = this.env.bg;
    g.fillRect(0, 0, cam.w, cam.h);
    if (cam.persp) this.stadium(pit);
    this.drawGround(pit);
    this.fx.drawMarks();
    if (this.weather === 'rain' && !cam.persp) this.rainRings(dt);
    const far = [], near = [];
    if (!this.s3) this.boards(pit, far, near); // (3D: they're meshes)
    for (const f of far) f();

    // shadows: a faint one right under each player where he meets the grass,
    // then his body laid on the grass by each light (not yours in third
    // person: it would show through you, as dark patches on your body)
    this.contactShadows(w, ppos);
    for (const l of this.lights) this.poseShadows(w, Js, l, tpOn ? info.myId : -1);
    this.ballShadow(ball);
    this.meetMarker(w, info.myId);

    this.fx.step(w, ppos, Js, ball, dt);
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

    // overlays: rain or snow first, then the name tags laid out so they
    // don't cover each other
    this.gu.clearRect(0, 0, cam.w, cam.h);
    if (this.weather === 'rain' || this.weather === 'snow') this.precipitation(dt);
    const lifts = this.layoutTags(w, ppos, info, ball);
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id);
      this.overlay(w, p, x, y, z, info, lifts.get(p.id) || 0, ball);
    }
    // a replay: black bars sliding in top and bottom, like the television's
    this.barK = clamp((this.barK || 0) + (info.replay ? dt * 4 : -dt * 4) / Math.max(0.2, info.replay ? info.replaySpeed || 1 : 1), 0, 1);
    if (this.barK > 0) {
      const bh = Math.round(cam.h * 0.085 * ease(this.barK));
      this.gu.fillStyle = '#000'; this.gu.fillRect(0, 0, cam.w, bh); this.gu.fillRect(0, cam.h - bh, cam.w, bh);
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
    s3.setCamera(cam.clipMatrix(), cam.persp ? [cam.ex, cam.ey, cam.ez] : null);
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
    s3.ball(this.ballDrawn(ball), [b.vx, b.vy, b.vz], dt, this.ballR / BALL_R * (this.ballScale ?? 1),
      !cam.persp || cam.ahead(ball[0], ball[1], ball[2]), Math.abs(b.spin) > 0.1 && b.owner < 0, this.fx.squashNow(w));
    s3.goals(pit);
    // (the boards between the camera and the pitch are see-through, as in 2D;
    // the stands and towers there aren't drawn)
    const isNear = (mx, my) => !cam.persp && cam.depth(mx, my) >= 0, kits = [TEAM_COLORS[0].shirt, TEAM_COLORS[1].shirt];
    s3.boards(pit, isNear, kits);
    s3.stadium(pit, isNear, kits, this.lite ? 0.3 : 0.65);
    s3.lamps(clamp(cam.persp ? 90 * this.dpr : 3.2 * cam.scale, 24, 160));
    // the fans: on their feet when their team scores, a murmur as the ball nears a goal
    const ct = info.celebrateTeam ?? -1, gd = pit.L / 2 - Math.abs(ball[0]);
    const jump = [0.4, 0.75, 1][info.goalWeight ?? 2];
    s3.crowdMood(this.time, [ct === 0 ? jump : 0, ct === 1 ? jump : 0], clamp(1 - gd / 22, 0, 1) * (Math.abs(ball[1]) < pit.W / 2 ? 1 : 0));
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

  // The replay's camera for the finish: behind the goal it went into (side),
  // up above the net, turning to follow the ball as it comes.
  broadcast(w, ball, side, dt) {
    const c = this.bcCam || (this.bcCam = new PerspCam()), pit = pitchOf(w);
    if (c.w !== this.isoCam.w || c.h !== this.isoCam.h) { c.w = this.isoCam.w; c.h = this.isoCam.h; }
    const ex = side * (pit.L / 2 + 8.5), ey = clamp(ball[1] * 0.35, -pit.goalW, pit.goalW), ez = 4.2;
    const yaw = Math.atan2(ball[1] - ey, ball[0] - ex), pitch = Math.atan2(ball[2] + 0.6 - ez, Math.hypot(ball[0] - ex, ball[1] - ey));
    const k = this.bcInit ? 1 - Math.exp(-dt * 4) : 1;
    c.ex = ex; c.ey = this.bcInit ? c.ey + (ey - c.ey) * k : ey; c.ez = ez;
    this.bcYaw = this.bcInit ? this.bcYaw + angDiff(this.bcYaw, yaw) * k : yaw;
    this.bcPitch = this.bcInit ? this.bcPitch + (pitch - this.bcPitch) * k : pitch;
    c.yaw = this.bcYaw; c.pitch = clamp(this.bcPitch, -0.5, 0.1);
    this.bcInit = true;
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

  // The grass: each mown stripe a fine-grained tile pinned to the ground (in
  // perspective, where a tile can't be pinned, plain colours), worn patches in
  // the goalmouths and the centre, then the markings.
  drawGround(pit) {
    const g = this.g, hx = pit.L / 2, hy = pit.W / 2, E = this.env, cam = this.cam;
    const tiles = !cam.persp && grassTiles(E, g);
    if (tiles) {
      // world metres -> screen (the isometric view is affine), a tile every TILE_M
      const { c, s: sn, se, scale: k } = cam, m = new DOMMatrix([c * k, sn * se * k, -sn * k, c * se * k, cam.w / 2 - (cam.cx * c - cam.cy * sn) * k, cam.h / 2 - (cam.cx * sn + cam.cy * c) * se * k]);
      this.groundM = m;
      const t = m.scale(TILE_M / TILE_PX);
      for (const p of tiles) p.setTransform(t);
    }
    // (round it, under the front of the stands: the concourse)
    this.poly([[-hx - 7.3, -hy - 6.3], [hx + 7.3, -hy - 6.3], [hx + 7.3, hy + 6.3], [-hx - 7.3, hy + 6.3]], E.apron);
    this.poly([[-hx - 6, -hy - 5], [hx + 6, -hy - 5], [hx + 6, hy + 5], [-hx - 6, hy + 5]], tiles ? tiles[0] : E.grass[0]);
    const n = 14;
    for (let i = 0; i < n; i++) {
      const x0 = -hx - 1 + (pit.L + 2) * i / n, x1 = -hx - 1 + (pit.L + 2) * (i + 1) / n;
      this.poly([[x0, -hy - 1], [x1, -hy - 1], [x1, hy + 1], [x0, hy + 1]], tiles ? tiles[1 + (i % 2)] : E.grass[1 + (i % 2)]);
    }
    // worn where the play is thickest: in front of each goal, round the centre spot
    if (tiles) {
      g.save();
      g.setTransform(this.groundM);
      for (const [x, y, rx, ry, a] of [[-hx + 2.6, 0, 4.2, 3.2, 1], [hx - 2.6, 0, 4.2, 3.2, 1], [0, 0, 3, 3, 0.7]]) {
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
        gr.addColorStop(0, `rgba(${E.worn},${0.2 * a})`); gr.addColorStop(0.6, `rgba(${E.worn},${0.09 * a})`); gr.addColorStop(1, `rgba(${E.worn},0)`);
        g.save(); g.translate(x, y); g.scale(rx, ry);
        g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
        g.restore();
      }
      g.restore();
    }
    g.strokeStyle = g.fillStyle = E.lines;
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
    g.fillStyle = E.lines;
    for (const [x, y] of [[0, 0], [hx - pit.penSpot, 0], [-hx + pit.penSpot, 0]]) {
      g.beginPath();
      // (its real size, but never less than a few pixels across)
      if (this.groundEllipse(x, y, this.cam.persp ? 0.11 : Math.max(0.11, 1.5 * this.dpr / this.cam.scale))) g.fill();
    }
  }

  // Perspective: the sky over the stadium, and (without the 3D layer, which
  // has stands of its own) the stands all round, rising behind the boards.
  stadium(pit) {
    const g = this.g, cam = this.cam, E = this.env;
    const hy = clamp(cam.h / 2 + cam.f * Math.tan(cam.pitch), -cam.h, 2 * cam.h); // the horizon
    const sky = g.createLinearGradient(0, hy - cam.h * 0.9, 0, hy);
    sky.addColorStop(0, E.sky[0]); sky.addColorStop(0.7, E.sky[1]); sky.addColorStop(1, E.sky[2]);
    g.fillStyle = sky; g.fillRect(0, 0, cam.w, Math.max(0, hy + 2));
    if (this.s3) return;
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

  // Every player's shadow by light l: his limbs laid along the grass the way
  // the light falls – a dive, a slide or a jump each casts its own shape. One
  // fill for them all (every piece wound the same way), so where pieces
  // overlap it isn't darker.
  poseShadows(w, Js, l, skip = -1) {
    const g = this.g, cam = this.cam, persp = cam.persp;
    // (the isometric view is affine: the grass at world (x, y) is on screen at
    // A x + C y + E, B x + D y + F)
    const { c, s: sn, se, scale: k } = cam;
    const A = c * k, B = sn * se * k, C = -sn * k, D = c * se * k;
    const E = cam.w / 2 - (cam.cx * c - cam.cy * sn) * k, F = cam.h / 2 - (cam.cx * sn + cam.cy * c) * se * k;
    const m = 3 * k, M = persp ? null : [A, B, C, D], S = this.shS || (this.shS = {});
    g.beginPath();
    for (const p of w.players) {
      const J = Js.get(p.id);
      if (!J || p.id === skip) continue;
      const [lx, ly] = lightAt(l, J.hc[0], J.hc[1]);
      // (off the screen: nothing to see)
      if (persp) { if (!cam.ahead(J.hc[0], J.hc[1], 0, 1.5)) continue; }
      else {
        const x = J.hc[0] + lx, y = J.hc[1] + ly, X = A * x + C * y + E, Y = B * x + D * y + F;
        if (X < -m || X > cam.w + m || Y < -m || Y > cam.h + m) continue;
      }
      const H = stats(p.hgt, p.bld).H;
      // each joint laid on the grass (world x, y) and on screen (X, Y)
      for (const key of SHADOW_JOINTS) {
        const j = J[key], x = j[0] + lx * j[2], y = j[1] + ly * j[2], q = S[key] || (S[key] = [0, 0, 0, 0]);
        q[0] = x; q[1] = y;
        if (persp) { q[2] = cam.px(x, y, 0); q[3] = cam.py(x, y, 0); } else { q[2] = A * x + C * y + E; q[3] = B * x + D * y + F; }
      }
      const night = l.h > 0;
      for (const [a, b, r] of night ? SHADOW_LIMBS_NIGHT : SHADOW_LIMBS) this.shadowLimb(S[a], S[b], r * H, M);
      for (const [key, r] of night ? SHADOW_DISCS_NIGHT : SHADOW_DISCS) this.shadowDisc(S[key], r * H);
    }
    g.fillStyle = `rgba(0,25,10,${l.a})`;
    g.fill();
  }

  // (the pieces: a band along a limb on the grass, a disc at a joint; each
  // point [world x, y, screen X, Y]; M: the isometric view's linear part)
  shadowLimb(a, b, r, M) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 1e-3) return;
    const nx = -dy / L * r, ny = dx / L * r, g = this.g, X = this.shX || (this.shX = [0, 0, 0, 0]), Y = this.shY || (this.shY = [0, 0, 0, 0]);
    if (M) {
      const NX = M[0] * nx + M[2] * ny, NY = M[1] * nx + M[3] * ny;
      X[0] = a[2] + NX; Y[0] = a[3] + NY; X[1] = b[2] + NX; Y[1] = b[3] + NY; X[2] = b[2] - NX; Y[2] = b[3] - NY; X[3] = a[2] - NX; Y[3] = a[3] - NY;
    } else {
      const cam = this.cam, xs = [a[0] + nx, b[0] + nx, b[0] - nx, a[0] - nx], ys = [a[1] + ny, b[1] + ny, b[1] - ny, a[1] - ny];
      for (let i = 0; i < 4; i++) { X[i] = cam.px(xs[i], ys[i], 0); Y[i] = cam.py(xs[i], ys[i], 0); }
    }
    // clockwise on screen, as the discs are
    if ((X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]) >= 0) { g.moveTo(X[0], Y[0]); g.lineTo(X[1], Y[1]); g.lineTo(X[2], Y[2]); g.lineTo(X[3], Y[3]); }
    else { g.moveTo(X[0], Y[0]); g.lineTo(X[3], Y[3]); g.lineTo(X[2], Y[2]); g.lineTo(X[1], Y[1]); }
    g.closePath();
  }

  shadowDisc(q, r) {
    const cam = this.cam, X = q[2], Y = q[3];
    let R = r * cam.scale, se = cam.se;
    if (cam.persp) { R = r * cam.sc(q[0], q[1], 0); se = Math.max(0.03, Math.sin(Math.atan2(cam.ez, Math.hypot(q[0] - cam.ex, q[1] - cam.ey)))); }
    this.g.moveTo(X + R, Y);
    this.g.ellipse(X, Y, R, R * se, 0, 0, TAU);
  }

  // A faint shadow right under each player, where he meets the grass – all
  // of them in one go (soft-edged: a wide faint ring under a tighter one).
  contactShadows(w, ppos) {
    const g = this.g, cam = this.cam, m = 3 * cam.scale;
    for (const [k, a] of [[1.25, 0.45], [0.85, 0.75]]) {
      g.beginPath();
      for (const p of w.players) {
        const [x, y, z] = ppos.get(p.id);
        if (z > 0.6) continue;
        const X = cam.px(x, y, 0), Y = cam.py(x, y, 0);
        if (X < -m || X > cam.w + m || Y < -m || Y > cam.h + m) continue;
        const r = 0.36 * (stats(p.hgt, p.bld).H / 1.8) * k;
        g.moveTo(X + r * cam.scale, Y);
        this.groundEllipse(x, y, r);
      }
      g.fillStyle = `rgba(0,25,10,${0.13 * a})`;
      g.fill();
    }
  }

  // the ball's, cast the same way: the higher it is, the further off its
  // shadow falls (where a header meets it: his head's shadow on the ball's)
  ballShadow([x, y, z]) {
    for (const l of this.lights) {
      const [lx, ly] = lightAt(l, x, y), h = Math.max(0, z - BALL_R);
      this.shadow(x + lx * h, y + ly * h, this.ballR * 1.3, l.a * 1.5 / (1 + z * 0.08));
    }
  }

  // The ball's size as drawn (m): its real size, but never less than a few
  // pixels across, so it's still easy to follow zoomed out on a phone.
  ballRadius([x, y, z]) {
    const cam = this.cam, px = cam.persp ? cam.sc(x, y, z) : cam.scale;
    return px > 0 ? Math.max(BALL_R, BALL_MIN_PX * this.dpr / px) : BALL_R;
  }

  // where it's drawn: drawn bigger, it's lifted to still sit on the grass
  ballDrawn([x, y, z]) { return [x, y, Math.max(z, this.ballR)]; }

  drawBall(w, ball, dt) {
    const g = this.g, cam = this.cam, [x, y, z] = this.ballDrawn(ball);
    const sp = Math.hypot(w.ball.vx, w.ball.vy, w.ball.vz);
    const X = cam.px(x, y, z), Y = cam.py(x, y, z);
    const r = this.ballR * (cam.persp ? cam.sc(x, y, z) : cam.scale) * (this.ballScale ?? 1);
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
    if (!a) { a = { ph: Math.random() * TAU, sp: 0, face: p.face, turn: 0, P: null, vf: 0, vl: 0, acc: 0 }; this.anim.set(p.id, a); }
    const sp = Math.hypot(p.vx, p.vy), sp0 = a.sp;
    a.sp += (sp - a.sp) * (1 - Math.exp(-dt * 12));
    // speeding up / braking (m/s², smoothed): leaning into it, or back
    if (dt > 0) a.acc += ((a.sp - sp0) / dt - a.acc) * (1 - Math.exp(-dt * 8));
    // velocity in his own frame: forwards, and towards his R side (see skeleton)
    const cf = Math.cos(p.face), sf = Math.sin(p.face), kv = 1 - Math.exp(-dt * 10);
    a.vf += (p.vx * cf + p.vy * sf - a.vf) * kv; a.vl += (-p.vx * sf + p.vy * cf - a.vl) * kv;
    // turn rate, for leaning into curves
    const turn = dt > 0 ? angDiff(a.face, p.face) / dt : 0;
    a.turn += (clamp(turn, -12, 12) - a.turn) * (1 - Math.exp(-dt * 10));
    a.face = p.face;
    // a real runner's cadence (see cadence), easing to nothing standing
    a.ph += cadence(a.sp) * dt * Math.PI;
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
      H: s.H, speed: a.sp, phase: a.ph, time: this.time, acc: a.acc,
      gkStance: p.role === ROLE.GK && b.owner !== p.id ? 1 : 0,
      gkBig: 0,
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
      celebrate: false, dejected: null,
      diveRel: angDiff(p.face, p.stA),
      diveEl: p.st === ST.DIVE && !p.spr ? diveReach(p, s)[1] : 0, // a high dive: body on a diagonal
      block: null, reach: null, windup: null, gkSet: 0, contact: null,
    };
    // after a goal: the scorer's knee slide (pulling up from his run) and his
    // arms up on his knees, team-mates hugging him, the rest as they like;
    // the side that let it in heads down (see poseFor)
    if (info.celebrateTeam >= 0 && p.st === ST.IDLE && m.phT < CELEB_TICKS[info.goalWeight ?? 2] + 40) {
      const scorer = w.players.find((q) => q.id === m.scorer);
      if (info.celebrateTeam === p.team) {
        ctx.celebrate = true;
        if (scorer === p && a.sp > 0.9 && a.acc < -1 && m.phT > 30) ctx.celebrate = 'slide';
        else if (scorer === p && a.sp <= 0.9 && m.phT > 60) ctx.celebrate = 'kneel';
        else if (scorer && scorer !== p && scorer.team === p.team && Math.hypot(scorer.x - p.x, scorer.y - p.y) < 1.7) ctx.celebrate = 'hug';
      } else ctx.dejected = p.role === ROLE.GK && a.sp < 0.6 ? 'slap' : a.sp < 0.6 && p.id % 2 ? 'knees' : 'head';
      ctx.gkStance = 0;
    }
    if (ctx.gkStance) {
      // set: hands up a little while an opponent has the ball within shooting range
      const o = b.owner >= 0 ? w.players.find((q) => q.id === b.owner) : null;
      if (o && o.team !== p.team) ctx.gkSet = clamp((26 - Math.hypot(o.x - p.x, o.y - p.y)) / 8, 0, 1);
      // big: eased in and out over a few frames
      a.big = clamp((a.big || 0) + (keeperBig(w, p) ? dt : -dt) * 6, 0, 1);
      ctx.gkBig = ease(a.big);
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
    if (p.st === ST.HEADER) {
      // heading it on: the head turned towards where it's going, as far as a
      // neck goes, the shoulders a little with it (the body turns in the air
      // too – see the sim)
      const [df, dr] = local(p.kx, p.ky), e = clamp(1 - Math.abs(p.stT - p.stA) / 8, 0, 1);
      if (Math.hypot(df, dr) > 0.5) { const yaw = clamp(Math.atan2(dr, df), -1.2, 1.2); target.hy += yaw * e; target.tw += yaw * 0.25 * e; }
    }
    if (p.st === ST.IDLE || p.st === ST.STUMBLE) {
      target.roll += clamp(a.turn * a.sp * 0.012, -0.28, 0.28);
      // eyes on the ball: the head turns to it (as far as a neck goes), the
      // shoulders a little with it, and it tips down to one at his feet or
      // up to one in the air (not with it in his hands, or celebrating)
      if (!holding && !ctx.celebrate && !ctx.dejected && this.ballPos) {
        const [bx, by, bz] = this.ballPos, [df, dr] = local(bx, by), d = Math.hypot(df, dr);
        if (d > 0.3) {
          const yaw = clamp(Math.atan2(dr, df), -1.3, 1.3);
          target.hy += yaw * 0.85; target.tw += yaw * 0.18;
          target.head += clamp(-Math.atan2(bz - 0.9 * s.H, d) * 0.55 - 0.05, -0.45, 0.4);
        }
      }
    }
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

  // Rain or snow falling across the screen (one path for all of it), and
  // rain's rings on the grass.
  precipitation(dt) {
    const g = this.gu, cam = this.cam, d = this.dpr, rain = this.weather === 'rain', n = (rain ? 110 : 140) >> (this.lite ? 1 : 0);
    if (!this.drops || this.drops.length !== n) {
      this.drops = Array.from({ length: n }, () => ({ x: Math.random(), y: Math.random(), v: 0.7 + Math.random() * 0.6, s: 0.5 + Math.random() }));
    }
    const W = cam.w, H = cam.h;
    g.beginPath();
    for (const p of this.drops) {
      p.y += dt * (rain ? 1.6 : 0.16) * p.v;
      p.x += dt * (rain ? 0.12 : 0.03 * Math.sin(this.time * 0.9 + p.s * 9));
      if (p.y > 1) { p.y -= 1; p.x = Math.random(); }
      if (p.x > 1) p.x -= 1; else if (p.x < 0) p.x += 1;
      const X = p.x * W, Y = p.y * H;
      if (rain) { const l = (10 + 8 * p.s) * d; g.moveTo(X, Y); g.lineTo(X - l * 0.18, Y - l); }
      else { const r = (1 + 1.4 * p.s) * d; g.rect(X - r, Y - r, 2 * r, 2 * r); }
    }
    if (rain) { g.strokeStyle = 'rgba(205,220,240,0.32)'; g.lineWidth = d; g.stroke(); }
    else { g.fillStyle = 'rgba(255,255,255,0.85)'; g.fill(); }
  }

  // rain: rings spreading where drops hit the grass round the play (on the pitch layer)
  rainRings(dt) {
    const rings = this.rings || (this.rings = []), cam = this.cam, g = this.g;
    for (let k = this.lite ? 1 : 3; k > 0; k--) if (Math.random() < dt * 20) rings.push({ x: cam.cx + (Math.random() - 0.5) * 30, y: cam.cy + (Math.random() - 0.5) * 22, t: 0 });
    g.beginPath();
    for (const r of rings) { r.t += dt; const R = 0.04 + r.t * 0.6; g.moveTo(cam.px(r.x + R, r.y, 0), cam.py(r.x + R, r.y, 0)); this.groundEllipse(r.x, r.y, R); }
    g.strokeStyle = 'rgba(220,235,255,0.22)'; g.lineWidth = this.dpr; g.stroke();
    this.rings = rings.filter((r) => r.t < 0.35);
  }

  // Where each player's tag goes: over his head, lifted clear of the tags
  // already placed – mine first (it never moves), then people, then the
  // nearest the viewer. Returns how far up (px) each one goes.
  layoutTags(w, ppos, info, ball) {
    const cam = this.cam, g = this.gu, d = this.dpr, out = new Map(), tags = [];
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id), mine = p.id === info.myId;
      const top = Math.max((p._headZ || stats(p.hgt, p.bld).H) + 0.35, z + 0.6);
      if (cam.persp && !cam.ahead(x, y, top, 0.3)) continue;
      const S = cam.persp ? cam.sc(x, y, z) : cam.scale, fs = Math.round(clamp(S * 0.3, 9, 12) * d);
      const name = info.names.get(p.id) || '';
      g.font = `600 ${fs}px system-ui, sans-serif`;
      const keys = info.aiKeys && info.aiKeys.on && !p.human ? 12 * d : 0;
      const wd = Math.max(name ? g.measureText(name).width : 0, keys ? 40 * d : 0) + 6 * d;
      const ht = (name ? fs + 3 * d : 0) + keys + (mine ? (p.chgBtn ? 40 : 18) * d : 0);
      if (!ht) continue;
      const X = cam.px(x, y, top), Y = cam.py(x, y, top);
      tags.push({ id: p.id, X, Y, wd, ht, rank: mine ? 0 : p.human ? 1 : 2 });
    }
    tags.sort((a, b) => a.rank - b.rank || b.Y - a.Y);
    const placed = [];
    for (const t of tags) {
      let bottom = t.Y, moved = true;
      // (up past whatever it would cover, again until it's clear)
      for (let n = 0; moved && n < 8; n++) {
        moved = false;
        for (const o of placed) {
          if (Math.abs(o.X - t.X) * 2 < o.wd + t.wd && bottom > o.top && bottom - t.ht < o.bottom) { bottom = o.top - 1 * d; moved = true; }
        }
      }
      placed.push({ X: t.X, wd: t.wd, top: bottom - t.ht, bottom });
      out.set(t.id, t.Y - bottom);
    }
    return out;
  }

  overlay(w, p, x, y, z, info, lift = 0, ball = null) {
    const g = this.gu, cam = this.cam, S = cam.persp ? cam.sc(x, y, z) : cam.scale;
    const s = stats(p.hgt, p.bld);
    const top = Math.max((p._headZ || s.H) + 0.35, z + 0.6);
    const mine = p.id === info.myId;
    if (cam.persp && !cam.ahead(x, y, top, 0.3)) return;
    const X = cam.px(x, y, top), Y = cam.py(x, y, top) - lift;
    const fs = Math.round(clamp(S * 0.3, 9, 12) * this.dpr);
    let nameY = Y - 2;
    // lifted clear of another tag: a faint line down to his head
    if (lift > 4 * this.dpr) {
      g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = this.dpr;
      g.beginPath(); g.moveTo(X, Y + 2 * this.dpr); g.lineTo(X, Y + lift); g.stroke();
    }
    if (mine) {
      // PES-style cursor
      const tc = TEAM_COLORS[p.team].ui;
      const bounce = Math.sin(this.time * 5) * 2;
      g.fillStyle = tc; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X, Y + bounce); g.lineTo(X - 7 * this.dpr, Y - 10 * this.dpr + bounce); g.lineTo(X + 7 * this.dpr, Y - 10 * this.dpr + bounce);
      g.closePath(); g.fill(); g.stroke();
      const by = Y - 16 * this.dpr;
      // stamina: sprinting spends it (the jog key / a part tilt saves it) – shown while it's not full
      if (p.stam < 0.98) {
        const sw = 36 * this.dpr, sh = 3 * this.dpr;
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(X - sw / 2 - 1, by - 1, sw + 2, sh + 2);
        g.fillStyle = p.stam > 0.5 ? '#9be36a' : p.stam > 0.25 ? '#f4d03f' : '#ff5a4f';
        g.fillRect(X - sw / 2, by, sw * Math.max(0, p.stam), sh);
      }
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
    // small name tag for everyone (AI players dimmed, more so away from the ball)
    // a lagging player's stand-in: the AI plays him until his inputs come back
    const name = (info.names.get(p.id) || '') + (p.human && p.bot && info.names.get(p.id) ? ' · AI' : '');
    if (name) {
      g.font = `600 ${fs}px system-ui, sans-serif`;
      g.textAlign = 'center';
      const nearBall = !ball || w.ball.owner === p.id || Math.hypot(ball[0] - x, ball[1] - y) < 12;
      g.globalAlpha = p.human ? 0.95 : (nearBall ? 0.62 : 0.42) * (this.weather === 'snow' ? 1.45 : 1);
      g.lineWidth = Math.max(2, 2.5 * this.dpr); g.strokeStyle = this.weather === 'snow' ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.6)';
      g.strokeText(name, X, nameY);
      g.fillStyle = mine ? '#ffffff' : p.human ? '#f2f6f3' : '#dfe7e2';
      g.fillText(name, X, nameY);
      g.globalAlpha = 1;
      if (p.human && !mine) { g.fillStyle = TEAM_COLORS[p.team].ui; g.fillRect(X - 7 * this.dpr, nameY + 2 * this.dpr, 14 * this.dpr, 1.5 * this.dpr); }
    }
    // the keys an AI player presses (see aikeys.js), over his name
    if (info.aiKeys) {
      const base = name ? nameY - fs - 2 * this.dpr : nameY, top = info.aiKeys.draw(this, w, p, X, base);
      if (top < base) nameY = top + fs + 2 * this.dpr; // (a bubble goes above them)
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
