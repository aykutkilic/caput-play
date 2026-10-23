// Minimal isometric renderer (Canvas 2D, orthographic camera) with procedural
// skeletal animation: every pose is computed from simulation state each frame,
// so animations stay fluid and always agree with what the physics is doing.

import { GOAL_DEPTH, BALL_R, ST, ROLE, PHASE, KICK, SP, SKILL, KH, PART } from '../shared/constants.js';
import { stats } from '../shared/physique.js';
import { CHG_MAX, pitchOf } from '../shared/sim.js';
import { skeleton, drawFigure } from './figure.js';

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
  // screen direction (x right, y down) -> world ground direction
  screenDirToWorld(sx, sy) {
    const yr = sy; // down on screen == towards the viewer on the ground plane
    return [sx * this.c + yr * this.s, -sx * this.s + yr * this.c];
  }
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

// Both arms reaching for a point (df, dr, du) relative to the middle of the
// shoulders – a keeper's hands going to the ball. Blended in by e.
function armsIK(P, df, dr, du, H, e) {
  const L = 0.33 * H, shW = 0.118 * H;
  for (const side of [-1, 1]) {
    const sa = clamp((dr * side - shW) / L, -0.6, 0.9);
    const th = Math.atan2(df, -du) - P.lean * 0.6;
    const ab = Math.asin(sa);
    if (side > 0) { P.rsh = mix(P.rsh, th, e); P.rab = mix(P.rab, ab, e); P.rel = mix(P.rel, 0.12, e); }
    else { P.lsh = mix(P.lsh, th, e); P.lab = mix(P.lab, ab, e); P.lel = mix(P.lel, 0.12, e); }
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
  // against the hips, knees lifting higher at a sprint, head kept level
  const lift = 1.2 + 0.4 * Math.max(0, A - 0.8);
  P.lh = A * 0.8 * s; P.rh = -A * 0.8 * s;
  P.lk = 0.12 + A * (0.25 + lift * Math.max(0, c));
  P.rk = 0.12 + A * (0.25 + lift * Math.max(0, -c));
  P.lsh = -A * 0.78 * s; P.rsh = A * 0.78 * s;
  P.lel = P.rel = 0.3 + A * 1.05;
  P.tw = -0.24 * A * s;
  P.lean = 0.04 + A * 0.2 + (1 - Math.min(1, A * 3)) * 0.015 * Math.sin(t * 2.1);
  P.head = -P.lean * 0.55;
  P.bob = A * 0.05 * Math.abs(s);
  if (A < 0.25) {
    // standing: breathing and a slow weight shift
    const q = 1 - A * 4, ws = Math.sin(t * 0.9 + p.id);
    P.lh += 0.05 * ws * q; P.rh -= 0.05 * ws * q; P.roll += 0.03 * ws * q;
    P.lab = P.rab = 0.14 + 0.03 * Math.sin(t * 2.1) * q;
  }

  if (ctx.gkStance > 0) {
    const g = ctx.gkStance * (1 - Math.min(1, A * 1.5));
    P.lh += 0.35 * g; P.rh += 0.35 * g; P.lk += 0.55 * g; P.rk += 0.55 * g;
    P.la = P.ra = 0.05 + 0.12 * g; P.drop += 0.07 * H * g; P.lean += 0.3 * g;
    P.lsh = mix(P.lsh, 0.75, g); P.rsh = mix(P.rsh, 0.75, g); P.lab = P.rab = mix(0.12, 0.6, g);
    P.lel = P.rel = mix(P.lel, 0.6, g);
    P.bob += 0.022 * Math.abs(Math.sin(t * 6.5 + p.id)) * g; // on his toes
  }
  if (ctx.holding) { P.lsh = P.rsh = 1.0; P.lel = P.rel = 0.95; P.lab = P.rab = 0.15; }
  if (ctx.reach) { const r = ctx.reach; armsIK(P, r.df, r.dr, r.du, H, r.e); }
  if (ctx.windup) {
    // holding a pass / shot: the kicking leg draws back as the gauge fills, so
    // on release the foot comes straight through
    const { u, big } = ctx.windup;
    P.rh = mix(P.rh, -0.8 * big, u); P.rk = mix(P.rk, 0.2 + 1.4 * big, u); P.tw = mix(P.tw, 0.3, u);
    P.lsh = mix(P.lsh, 0.55, u); P.lab = mix(P.lab, 0.9, u); P.rsh = mix(P.rsh, -0.35, u); P.rab = mix(P.rab, 0.45, u);
    P.lean = mix(P.lean, 0.02 - 0.1 * big, u);
  }
  if (ctx.throwIn) { P.lsh = P.rsh = 2.9; P.lel = P.rel = 1.6; P.lab = P.rab = 0.25; }
  if (ctx.celebrate) {
    const j = Math.abs(Math.sin(t * 7 + p.id));
    const kind = p.id % 3;
    if (kind === 0) { P.lsh = P.rsh = 2.75; P.lab = P.rab = 0.45; P.lel = P.rel = 0.2; P.bob += 0.18 * j * (A < 0.3 ? 1 : 0.3); }
    else if (kind === 1) { P.lsh = P.rsh = 0.25; P.lab = P.rab = 1.45; P.lel = P.rel = 0.1; P.roll += 0.22 * Math.sin(t * 3); } // aeroplane
    else { P.rsh = 2.6 + 0.3 * Math.sin(t * 9); P.rel = 1.2; P.lsh = 0.3; P.lel = 1.3; P.bob += 0.1 * j; } // fist pump
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
      if (ctx.fromHands) { P.lsh = P.rsh = k < cT ? 1.0 : 0.4; P.lab = P.rab = 0.4; }
      break;
    }
    case ST.THROW: {
      const cT = Math.max(1, p.stA);
      if (ctx.throwInAnim) {
        const sh = k < cT ? mix(2.7, 3.35, ease(k / cT)) : mix(2.0, 1.3, clamp((k - cT) / 10, 0, 1));
        P.lsh = P.rsh = sh; P.lel = P.rel = k < cT ? 1.7 : 0.3; P.lab = P.rab = 0.2;
        P.lean = k < cT ? -0.25 * ease(k / cT) : 0.25;
        P.lh = -0.15; P.rh = 0.35; P.rk = 0.3;
      } else {
        const sh = k < cT ? mix(0.3, -1.1, ease(k / cT)) : mix(1.6, 0.6, clamp((k - cT) / 12, 0, 1));
        P.rsh = sh; P.rel = 0.2; P.lsh = 0.5; P.lab = 0.5;
        P.rh = 0.4; P.rk = 0.3; P.lean = 0.25;
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
      const env = clamp(k / 7, 0, 1) * lieEnv(p, 16);
      const rel = ctx.diveRel;
      P.roll = Math.sin(rel) * 1.4 * env;
      P.pitch = Math.cos(rel) * 1.2 * env;
      P.drop = (p.z <= 0.02 && k > 10 ? hipH * 0.72 : hipH * 0.2) * env;
      P.lsh = P.rsh = mix(P.lsh, 2.85, env); P.lab = P.rab = 0.3 * env; P.lel = P.rel = 0.15;
      P.lk = 0.25; P.rk = mix(P.rk, 0.9, env); P.rh = 0.5 * env;
      if (p.spr) {
        // spread at the shooter's feet: arms and legs out wide, a star on its side
        P.lsh = P.rsh = mix(P.lsh, 1.7, env); P.lab = P.rab = 0.9 * env;
        P.la = P.ra = 0.55 * env; P.lk = P.rk = 0.2; P.rh = 0.2 * env;
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

// ---------------------------------------------------------------- renderer

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.cam = new Camera();
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
    if (!CAMERAS[name]) name = 'iso';
    this.preset = name;
    const c = CAMERAS[name];
    this.cam.set(c.yaw, c.elev);
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
    this.cam.w = this.canvas.width; this.cam.h = this.canvas.height;
  }

  pos(e, alpha, off) {
    const x = e.px + (e.x - e.px) * alpha + (off ? off[0] : 0);
    const y = e.py + (e.y - e.py) * alpha + (off ? off[1] : 0);
    const z = e.pz + (e.z - e.pz) * alpha + (off ? off[2] : 0);
    return [x, y, z];
  }

  frame(w, alpha, offsets, info, dt) {
    const g = this.g, cam = this.cam;
    this.time += dt;
    const pit = pitchOf(w);
    // landscape: fit ~40 m across; portrait (phones): zoom in so players stay readable
    const base = Math.max(Math.min(cam.w, cam.h * 1.7), Math.min(cam.h, cam.w * 1.7) * 0.75) / 40;
    cam.scale = base * this.zoom;

    // positions for this frame
    const ball = this.pos(w.ball, alpha, offsets.get('b'));
    this.ballPos = ball;
    const ppos = new Map();
    for (const p of w.players) ppos.set(p.id, this.pos(p, alpha, offsets.get(p.id)));

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

    // background
    g.fillStyle = '#0e1a14';
    g.fillRect(0, 0, cam.w, cam.h);
    this.drawGround(pit);
    const far = [], near = [];
    this.boards(pit, far, near);
    for (const f of far) f();

    // shadows
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id);
      this.shadow(x, y, 0.42 * (stats(p.hgt, p.bld).H / 1.8), 0.28 / (1 + z * 0.8), p);
    }
    this.ballShadow(ball);
    this.meetMarker(w, info.myId);

    // depth-sorted scene: players, ball, goal parts
    const items = [];
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id);
      items.push({ d: cam.depth(x, y), fn: () => this.drawPlayer(w, p, x, y, z, info, dt) });
    }
    items.push({ d: cam.depth(ball[0], ball[1]) + 0.05, fn: () => this.drawBall(w, ball, dt) });
    this.goalParts(pit, items);
    items.sort((a, b) => a.d - b.d);
    for (const it of items) it.fn();
    for (const f of near) f();

    // overlays
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id);
      this.overlay(w, p, x, y, z, info);
    }
    // where am I, when the camera can't see me
    const meAt = ppos.get(info.myId);
    if (meAt) this.offscreen(w.players.find((p) => p.id === info.myId), meAt);
  }

  // A badge at the screen edge pointing to my player, with how far away he is.
  offscreen(p, [x, y, z]) {
    const g = this.g, cam = this.cam, d = this.dpr;
    const X = cam.px(x, y, z + 0.9), Y = cam.py(x, y, z + 0.9);
    const m = 10 * d;
    if (X > m && X < cam.w - m && Y > m && Y < cam.h - m) return;
    const cx = cam.w / 2, cy = cam.h / 2, pad = 34 * d;
    const dx = X - cx, dy = Y - cy;
    const t = Math.min((cx - pad) / Math.max(1e-6, Math.abs(dx)), (cy - pad) / Math.max(1e-6, Math.abs(dy)));
    const ex = cx + dx * t, ey = cy + dy * t, ang = Math.atan2(dy, dx);
    const col = TEAM_COLORS[p.team] ? TEAM_COLORS[p.team].ui : '#fff';
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
    g.fillText(`${dist}m`, 0, 0.5 * d);
    g.restore();
  }

  // ---------------------------------------------------------- pitch

  poly(pts, fill) {
    const g = this.g, cam = this.cam;
    g.beginPath();
    pts.forEach(([x, y, z = 0], i) => {
      const X = cam.px(x, y, z), Y = cam.py(x, y, z);
      if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
    });
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
  }

  line(x1, y1, z1, x2, y2, z2) {
    const g = this.g, cam = this.cam;
    g.moveTo(cam.px(x1, y1, z1), cam.py(x1, y1, z1));
    g.lineTo(cam.px(x2, y2, z2), cam.py(x2, y2, z2));
  }

  arc(cx, cy, r, a0, a1) {
    const g = this.g, cam = this.cam;
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
    g.strokeStyle = 'rgba(245,250,245,0.85)';
    g.lineWidth = Math.max(1, 0.12 * this.cam.scale);
    g.lineJoin = 'round';
    g.beginPath();
    // touchlines, goal lines, halfway
    this.line(-hx, -hy, 0, hx, -hy, 0); this.line(hx, -hy, 0, hx, hy, 0);
    this.line(hx, hy, 0, -hx, hy, 0); this.line(-hx, hy, 0, -hx, -hy, 0);
    this.line(0, -hy, 0, 0, hy, 0);
    for (const s of [-1, 1]) {
      const gx = s * hx;
      // penalty box
      this.line(gx, -pit.boxW / 2, 0, gx - s * pit.boxD, -pit.boxW / 2, 0);
      this.line(gx - s * pit.boxD, -pit.boxW / 2, 0, gx - s * pit.boxD, pit.boxW / 2, 0);
      this.line(gx - s * pit.boxD, pit.boxW / 2, 0, gx, pit.boxW / 2, 0);
      // goal area
      this.line(gx, -pit.areaW / 2, 0, gx - s * pit.areaD, -pit.areaW / 2, 0);
      this.line(gx - s * pit.areaD, -pit.areaW / 2, 0, gx - s * pit.areaD, pit.areaW / 2, 0);
      this.line(gx - s * pit.areaD, pit.areaW / 2, 0, gx, pit.areaW / 2, 0);
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
      g.ellipse(this.cam.px(x, y, 0), this.cam.py(x, y, 0), 0.18 * this.cam.scale, 0.18 * this.cam.scale * this.cam.se, 0, 0, TAU);
      g.fill();
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
      if (mid < 0) far.push(draw(1)); else near.push(draw(0.55));
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
      const post = (y) => () => {
        const g = this.g;
        g.lineCap = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.16 * cam.scale + 2;
        g.beginPath(); this.line(gx, y, 0, gx, y, gh); g.stroke();
        g.strokeStyle = '#f7f7f2'; g.lineWidth = Math.max(2, 0.16 * cam.scale);
        g.beginPath(); this.line(gx, y, 0, gx, y, gh); g.stroke();
      };
      items.push({ d: cam.depth(gx, -gw) + 0.01, fn: post(-gw) });
      items.push({ d: cam.depth(gx, gw) + 0.01, fn: post(gw) });
      items.push({
        d: cam.depth(gx, 0) + 0.01, fn: () => {
          const g = this.g;
          g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.16 * cam.scale + 2;
          g.beginPath(); this.line(gx, -gw, gh, gx, gw, gh); g.stroke();
          g.strokeStyle = '#f7f7f2'; g.lineWidth = Math.max(2, 0.16 * cam.scale);
          g.beginPath(); this.line(gx, -gw, gh, gx, gw, gh); g.stroke();
        },
      });
    }
  }

  // ---------------------------------------------------------- entities

  shadow(x, y, r, a) {
    // soft-edged: a wide faint ellipse under a tighter darker one
    const g = this.g, cam = this.cam;
    const X = cam.px(x, y, 0), Y = cam.py(x, y, 0), R = r * cam.scale;
    g.fillStyle = `rgba(0,25,10,${a * 0.45})`;
    g.beginPath(); g.ellipse(X, Y, R * 1.25, R * 1.25 * cam.se, 0, 0, TAU); g.fill();
    g.fillStyle = `rgba(0,25,10,${a * 0.75})`;
    g.beginPath(); g.ellipse(X, Y, R * 0.85, R * 0.85 * cam.se, 0, 0, TAU); g.fill();
  }

  // Where my player is being guided to meet a high ball (receive assist).
  meetMarker(w, myId) {
    const me = w.players.find((p) => p.id === myId);
    const as = me && me._as;
    const b = w.ball;
    if (!as || b.owner >= 0 || !(b.z > 0.6 || b.vz > 1.5)) return;
    const g = this.g, cam = this.cam;
    const head = as.z > 1.5;
    const r = (0.45 + 0.08 * Math.sin(this.time * 9)) * cam.scale;
    const X = cam.px(as.x, as.y, 0), Y = cam.py(as.x, as.y, 0);
    g.strokeStyle = head ? 'rgba(255,214,102,0.9)' : TEAM_COLORS[me.team].ui;
    g.lineWidth = Math.max(1.5, 0.07 * cam.scale);
    g.beginPath(); g.ellipse(X, Y, r, r * cam.se, 0, 0, TAU); g.stroke();
    g.fillStyle = g.strokeStyle;
    g.beginPath(); g.ellipse(X, Y, r * 0.18, r * 0.18 * cam.se, 0, 0, TAU); g.fill();
  }

  ballShadow([x, y, z]) {
    const r = BALL_R * 1.7 * (1 + z * 0.12);
    this.shadow(x, y, r, 0.38 / (1 + z * 0.5));
  }

  drawBall(w, [x, y, z], dt) {
    const g = this.g, cam = this.cam;
    const sp = Math.hypot(w.ball.vx, w.ball.vy, w.ball.vz);
    const X = cam.px(x, y, z), Y = cam.py(x, y, z);
    const r = Math.max(3, BALL_R * 1.75 * cam.scale);
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
    if (!a) { a = { ph: Math.random() * TAU, sp: 0, face: p.face, turn: 0, P: null }; this.anim.set(p.id, a); }
    const sp = Math.hypot(p.vx, p.vy);
    a.sp += (sp - a.sp) * (1 - Math.exp(-dt * 12));
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
    const s = stats(p.hgt, p.bld);
    const look = info.looks.get(p.id) || lookFor(null, p.team, p.role);
    const a = this.animState(p, dt);
    const m = w.m, b = w.ball;
    const ctx = {
      H: s.H, speed: a.sp, phase: a.ph, time: this.time,
      gkStance: p.role === ROLE.GK && b.owner !== p.id ? 1 : 0,
      holding: b.owner === p.id && b.held && m.spTaker !== p.id,
      throwIn: b.owner === p.id && b.held && m.spTaker === p.id,
      throwInAnim: p.st === ST.THROW && Math.abs(Math.abs(p.y) - (pitchOf(w).W / 2)) < 1.2,
      fromHands: p.st === ST.KICK && p.kk === KICK.PUNT,
      celebrate: info.celebrateTeam === p.team && p.st === ST.IDLE,
      diveRel: angDiff(p.face, p.stA),
      block: null, reach: null, windup: null,
    };
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
    } else if (ctx.gkStance && !ctx.holding && b.owner < 0 && (p.st === ST.IDLE || p.st === ST.STUMBLE)) {
      // keeper: hands up to a ball that is coming at him
      const [bx, by, bz] = this.ballPos || [b.x, b.y, b.z];
      const d = Math.hypot(bx - x, by - y, bz - z - s.H * 0.75);
      const closing = ((x - bx) * b.vx + (y - by) * b.vy) > 0 || d < 1.3;
      const e = closing ? clamp((3.2 - d) / 1.6, 0, 1) : 0;
      if (e > 0) {
        const [df, dr] = local(bx, by);
        ctx.reach = { df, dr, du: bz - z - s.H * 0.8, e };
      }
    }
    const target = poseFor(p, ctx);
    if (p.st === ST.IDLE || p.st === ST.STUMBLE) target.roll += clamp(a.turn * a.sp * 0.012, -0.28, 0.28);
    // blend towards the target pose so every transition flows
    if (!a.P || dt <= 0) a.P = { ...target };
    else {
      const kb = 1 - Math.exp(-dt * 20);
      for (const key in target) a.P[key] += (target[key] - a.P[key]) * kb;
    }
    const J = skeleton(p, a.P, s.H, s.width, x, y, z, p.face);
    drawFigure(this.g, this.cam, J, look, s.H, s.width);
    p._headZ = J.head[2];
  }

  overlay(w, p, x, y, z, info) {
    const g = this.g, cam = this.cam, S = cam.scale;
    const s = stats(p.hgt, p.bld);
    const top = Math.max((p._headZ || s.H) + 0.35, z + 0.6);
    const X = cam.px(x, y, top), Y = cam.py(x, y, top);
    const mine = p.id === info.myId;
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
      // stamina
      const bw = 34 * this.dpr, by = Y - 16 * this.dpr;
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(X - bw / 2, by, bw, 3 * this.dpr);
      g.fillStyle = p.stam > 0.3 ? '#9be37a' : '#f0a63c'; g.fillRect(X - bw / 2, by, bw * p.stam, 3 * this.dpr);
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
  const J = skeleton(p, P, s.H, s.width, 0, 0, 0, face);
  // shift so that the figure stands on the lower part of the canvas
  const footY = cam.py(0, 0, 0);
  const offset = H * 0.88 - footY;
  g.save();
  g.translate(0, offset);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath(); g.ellipse(W / 2, footY, 0.4 * cam.scale, 0.4 * cam.scale * cam.se, 0, 0, TAU); g.fill();
  drawFigure(g, cam, J, look, s.H, s.width);
  g.restore();
}
