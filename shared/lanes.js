// Kick lanes – the holes a kick can go through. A kick is a class (height,
// pace, curl) flown once with the ball's own physics; turning it to a
// direction turns every point of its flight with it. Each opponent can get to
// a disc round him that grows with time (a reaction, then running up to his
// sprint; a keeper in his box dives), at the heights he can reach (a leg up to
// 0.7 m, his head with a jump ~2.25 m, a keeper's hands 2.7 m). So for every
// point of the flight he shuts an interval of directions – his time shadow:
// wider the longer the ball takes to get past him, none where it's above him,
// shifted where a curled ball swings. What's left open are the holes; how
// much time is spare in one is its margin (> 0: it gets there first).
import { stOf, inOwnBox, pitchOf, teamDir, PATH_H, groundSpeedFor, vzToReach, targetHeight, byPerson, stopChance, AIR_K, MU, CF, loftTime } from './sim.js';
import { BALL_R, G, ROLE, ST, KH, KICK } from './constants.js';

// The foot's curl (curve kc -1..1, + bending left of its path; see launch):
// spin up to CURL_MAX (rad/s the path turns), and curl costs pace – the inside
// of the foot gives a medium curve for little, more wraps it round at more.
export const CURL_MAX = 0.55, CURL_COST = 0.3;
export const curlPace = (kc) => 1 - CURL_COST * kc * kc;

// A kick's flight from the origin along angle a – the ball's own physics, as
// ballPath (gravity, drag, spin, bounces, rolling; 1/30 s steps) – until it's
// dMax out (or 2.5 s)
function flight(vh, vz, spin, z0, a, dMax) {
  const h = PATH_H, out = [], d2 = dMax * dMax;
  let x = 0, y = 0, z = Math.max(BALL_R, z0), vx = Math.cos(a) * vh, vy = Math.sin(a) * vh, sp = spin;
  for (let k = 1; k <= 75; k++) {
    const onG = z <= BALL_R + 1e-3 && Math.abs(vz) < 0.05;
    if (!onG) vz -= G * h;
    const f = Math.max(0, 1 - AIR_K * Math.hypot(vx, vy, vz) * h);
    vx *= f; vy *= f; vz *= f;
    if (sp) { const ox = vx; vx -= vy * sp * h; vy += ox * sp * h; sp *= onG ? 0.95 : 0.994; }
    x += vx * h; y += vy * h; z += vz * h;
    if (z < BALL_R) { z = BALL_R; if (vz < -1) { vz = -vz * 0.55; vx *= 0.88; vy *= 0.88; } else vz = 0; }
    if (z <= BALL_R + 1e-3 && vz === 0) {
      const hs = Math.hypot(vx, vy);
      if (hs > 0) { const ns = Math.max(0, hs - (MU + CF * hs) * h); vx *= ns / hs; vy *= ns / hs; }
    }
    out.push({ x, y, z, t: k * h });
    if (x * x + y * y > d2) break;
  }
  return out;
}

// How far off the line to a target d metres away a curled kick is aimed: the
// angle its flight turns through by then (aimed that much the other way, it
// bends back onto the target). Launch uses it too, so plan and kick agree.
export function curlAim(vh, vz, spin, d, z0) {
  if (!spin) return 0;
  const pts = flight(vh, vz, spin, z0, 0, d);
  let q = pts[pts.length - 1];
  for (const p of pts) if (p.x * p.x + p.y * p.y >= d * d) { q = p; break; }
  return -Math.atan2(q.y, q.x);
}

// A class's flight (aimed off for its curl to come back on line d metres
// out), every 0.1 s up to dMax: (x, y) from the ball, rho, height, time
function classFlight(vh, vz, spin, d, z0, dMax) {
  const pts = flight(vh, vz, spin, z0, curlAim(vh, vz, spin, d, z0), dMax), out = [];
  for (let k = 2; k < pts.length; k += 3) {
    const q = pts[k];
    out.push({ rho: Math.hypot(q.x, q.y), x: q.x, y: q.y, z: q.z, t: q.t });
  }
  const q = pts[pts.length - 1]; // (and its last point)
  if ((pts.length - 1) % 3 !== 2) out.push({ rho: Math.hypot(q.x, q.y), x: q.x, y: q.y, z: q.z, t: q.t });
  return out;
}

// Seconds o needs to get to the ball at (x, y, z): a reaction, then running
// up to his sprint until it's within his reach (a keeper in his box: or set
// and dive); Infinity above him
function oppTime(w, o, x, y, z) {
  const gk = o.role === ROLE.GK && inOwnBox(w, o.team, o.x, o.y, 0.5);
  if (z > (gk ? 2.7 : 2.25)) return Infinity;
  const s = stOf(o), d = Math.hypot(x - o.x, y - o.y);
  const busy = o.st !== ST.IDLE && o.st !== ST.STUMBLE ? Math.max(0, o.stDur - o.stT) / 60 : 0;
  // (an AI player reads it the moment it's struck; a person takes a moment;
  // already on his way there, he's that much quicker)
  const react = byPerson(o) ? 0.18 : 0.06;
  const v0 = d > 0 ? Math.max(0, Math.min(s.sprint, (o.vx * (x - o.x) + o.vy * (y - o.y)) / d)) : 0;
  const run = (gap) => {
    if (gap <= 0) return 0.05 + busy;
    const ta = (s.sprint - v0) / s.accel, da = v0 * ta + 0.5 * s.accel * ta * ta;
    return react + busy + (gap <= da ? (Math.sqrt(v0 * v0 + 2 * s.accel * gap) - v0) / s.accel : ta + (gap - da) / s.sprint);
  };
  if (gk) return Math.min(run(d - 1.0), 0.17 + busy + Math.max(0, d - (z < 2.1 ? 1.5 : 1.15)) / s.diveSpeed);
  return run(d - (z < 0.7 ? 0.62 : 0.4));
}

// The margin of a class's flight turned to direction th from (bx, by), up to
// tEnd: the least time anyone of theirs is too late by (negative: he's there
// first). Their shadows grow with the time the ball takes to get past them.
function marginOf(w, team, bx, by, fl, th, tEnd) {
  const c = Math.cos(th), sn = Math.sin(th);
  let m = Infinity;
  for (const o of w.players) {
    if (o.team === team || o.st === ST.FALLEN) continue;
    const sp = stOf(o).sprint;
    for (const q of fl) {
      if (q.t > tEnd) break;
      const x = bx + q.x * c - q.y * sn, y = by + q.x * sn + q.y * c;
      // (couldn't be there before the best so far even flat out: skip)
      if (Math.hypot(x - o.x, y - o.y) - 1.5 > sp * (q.t + m)) continue;
      m = Math.min(m, oppTime(w, o, x, y, q.z) - q.t);
    }
  }
  return m;
}

// The chance a pass along a class's flight (turned to th) gets past them all
// before tEnd: as it goes by each man near it (its nearest point to him, low
// enough for him to get to) he has stepped across towards it in the time it
// took to get there, stretching his reach; inside that, the deeper and the
// slower it's going, the likelier he stops it (stopChance, as slipsPast
// plays it); over his head, or past him, he can't. (Those who went for it –
// in lunged, missed and off balance – are out of the race for it after.)
function passOdds(w, team, bx, by, fl, th, tEnd, lunged) {
  const c = Math.cos(th), sn = Math.sin(th);
  let odds = 1;
  for (const o of w.players) {
    if (o.team === team || o.st === ST.FALLEN || o.st === ST.DIVE || o.st === ST.SLIDE) continue;
    const r = o.role === ROLE.GK && inOwnBox(w, o.team, o.x, o.y, 0) ? 1.0 : 0.62, top = o.role === ROLE.GK && r > 0.9 ? 2.4 : 1.9;
    let near = Infinity, at = null, prev = null;
    for (const q of fl) {
      if (q.t > tEnd) break;
      const x = bx + q.x * c - q.y * sn, y = by + q.x * sn + q.y * c, dd = Math.hypot(x - o.x, y - o.y);
      if (prev && q.z <= top && dd < near) {
        const dx = x - prev.x, dy = y - prev.y, dl = Math.hypot(dx, dy) || 1e-6;
        near = dd; at = { t: q.t, v: dl / (q.t - prev.t), ux: dx / dl, uy: dy / dl };
      }
      prev = { x, y, t: q.t };
    }
    if (!at) continue;
    const reach = r + Math.max(0, at.t - 0.25) * 4;
    if (near < reach) { odds *= at.v <= 0.5 ? 0.1 : 1 - stopChance(o, near / reach * 0.62, at.v, at.ux, at.uy); lunged.add(o); }
  }
  return odds;
}

// where receiver r can first get to a flight turned to direction th (at a
// height he can take it at), and when – null if he can't. (He knows it's
// coming: a short reaction, then accelerating like anyone.)
function receiveAt(r, bx, by, fl, th, top) {
  const s = stOf(r), c = Math.cos(th), sn = Math.sin(th), v0 = 0.5 * Math.hypot(r.vx, r.vy);
  const ta = (s.sprint - v0) / s.accel, da = v0 * ta + 0.5 * s.accel * ta * ta;
  for (const q of fl) {
    if (q.z > top) continue;
    const x = bx + q.x * c - q.y * sn, y = by + q.x * sn + q.y * c;
    const gap = Math.hypot(x - r.x, y - r.y) - 0.5;
    const need = gap <= 0 ? 0 : 0.1 + (gap <= da ? (Math.sqrt(v0 * v0 + 2 * s.accel * gap) - v0) / s.accel : ta + (gap - da) / s.sprint);
    if (need <= q.t) return { t: q.t, x, y, z: q.z };
  }
  return null;
}

// Pace of a pass d metres along at height kh (as launch plays it): ground –
// arriving at vEnd; lofted – over in T seconds, to chest or head height
function passFlight(p, kind, kh, d, kv, z0) {
  const s = stOf(p);
  if (kh === KH.GROUND) return { vh: Math.min(groundSpeedFor(d, kv), 28) * (0.97 + 0.06 * s.shot), vz: 0 };
  const T = kv, zt = kh === KH.HIGH ? 1.75 : 1.0;
  return { vh: d / T * 1.04, vz: (zt - z0 + 0.5 * G * T * T * 1.03) / T };
}

const ANGLES = [0, 0.04, -0.04, 0.08, -0.08, 0.13, -0.13, 0.19, -0.19, 0.26, -0.26, 0.34, -0.34]; // rad off the line to him
// The best hole for a pass to r: kicked d metres towards (lx, ly) – where he's
// meant to meet it – at height kh with pace kv (ground: arrival pace; lofted:
// flight time). A fan of directions round that line, straight or curled
// (curls: which kc to try); each one he must still get to. Prefers the
// straight line, then the least curl, unless the hole is wider.
export function passHole(w, p, r, kind, kh, lx, ly, kv, curls = [0, -0.5, 0.5]) {
  const b = w.ball, d = Math.hypot(lx - b.x, ly - b.y), th0 = Math.atan2(ly - b.y, lx - b.x);
  const top = kh === KH.HIGH ? 2.2 : 1.6;
  let best = null, straight = null;
  for (const kc of curls) {
    if (kh === KH.GROUND && kc) continue; // (along the grass the spin soon goes: ground passes go straight – aftertouch can still bend one)
    const { vh, vz } = passFlight(p, kind, kh, d, kv, b.z);
    const v = vh * (kc ? Math.min(1, 28 * curlPace(kc) / vh) : 1);
    const fl = classFlight(v, vz, kc * CURL_MAX, d, b.z, d + 8);
    for (const da of ANGLES) {
      const th = th0 + da, rec = receiveAt(r, b.x, b.y, fl, th, top);
      if (!rec) continue;
      // along the grass: past them on its way (his run can only be missed by
      // so much – 1.5 m and 0.8 m a second); in the air: over them, and then
      // he has to get to it first – anyone of theirs who can be where he meets
      // it as soon wins the race for it
      const tx = b.x + Math.cos(th) * d, ty = b.y + Math.sin(th) * d;
      if (kh === KH.GROUND && da && Math.hypot(tx - lx, ty - ly) > 1.5 + 0.8 * rec.t) continue;
      const lunged = new Set(), past = passOdds(w, p.team, b.x, b.y, fl, th, rec.t, lunged);
      let odds = past;
      if (kh !== KH.GROUND) {
        let tOpp = Infinity;
        for (const o of w.players) if (o.team !== p.team && o.st !== ST.FALLEN && !lunged.has(o)) tOpp = Math.min(tOpp, oppTime(w, o, rec.x, rec.y, rec.z));
        odds /= 1 + Math.exp(-(tOpp - rec.t) / 0.1);
      }
      // the likeliest to get there, straight rather than angled, and with as
      // little curl as does it
      const score = odds - 0.35 * Math.abs(da) - 0.03 * Math.abs(kc);
      const cand = { score, odds, kc, tx, ty, rx: rec.x, ry: rec.y, t: rec.t, fl, th };
      if (!da && !kc) straight = cand;
      if (!best || score > best.score) best = cand;
    }
  }
  // (straight at him unless that's clearly worse than the hole)
  return straight && best && best.odds < straight.odds + 0.15 ? straight : best;
}

// The best hole in the goal for a shot at height kh (low / mid / top) and
// power pw: targets across the goal mouth – within `span` [y0, y1] if given
// (the part the stick points at) – straight or curled (curls). Each is
// worth: the chance it's on target given his aim (err, rad – 0: a person's
// own risk, not weighed) times the chance nobody (keeper, a man in the way)
// gets to it first, by its margin – and, all else equal, nearer the spot he
// aimed at (aim).
export function shotHole(w, p, kind, kh, pw, err, span, curls = [0, -0.5, 0.5], aim = null, out = null) {
  const b = w.ball, pit = pitchOf(w), dir = teamDir(w, p.team), gx = dir * pit.L / 2, hw = pit.goalW / 2, s = stOf(p);
  const tz = targetHeight(w, p, kind, kh) + (pw > 0.9 ? (pw - 0.9) * 3 : 0);
  const dc = Math.hypot(gx - b.x, b.y);
  let best = null;
  for (const kc of curls) {
    let speed = (12 + 13 * pw) * s.shot;
    speed *= kh === KH.GROUND ? 1.35 : 1 + 0.1 * Math.min(1, Math.max(0, (pw - 0.2) / 0.3));
    if (kind === KICK.FINESSE) speed *= 0.85;
    speed *= curlPace(kc);
    // one flight for the class, turned to each target in the goal mouth
    const vz = kh === KH.GROUND ? 0.4 + 2.5 * Math.max(0, pw - 0.75) : Math.min(14, vzToReach(speed, b.z, dc, tz));
    const fl = classFlight(speed, vz, kc * CURL_MAX, dc, b.z, dc + hw + 2);
    for (let i = 0; i <= 10; i++) {
      const ty = (-0.92 + 1.84 * i / 10) * hw;
      if (span && (ty < span[0] - 0.01 || ty > span[1] + 0.01)) continue;
      const d = Math.hypot(gx - b.x, ty - b.y), th = Math.atan2(ty - b.y, gx - b.x);
      // where it crosses the line
      let cross = null;
      for (const q of fl) if (q.rho >= d) { cross = q; break; }
      if (!cross || cross.z > pit.goalH - BALL_R) continue;
      const m = Math.min(0.6, marginOf(w, p.team, b.x, b.y, fl, th, cross.t));
      const sd = Math.max(0.15, err * d);
      const on = err ? 1 / (1 + Math.exp(-((hw - BALL_R - Math.abs(ty)) / sd) * 1.7)) : 1; // on target, with his aim
      const beat = 1 / (1 + Math.exp(-m / 0.1));
      const score = on * beat - 0.01 * Math.abs(kc) - (aim === null ? 0 : 0.06 * Math.abs(ty - aim));
      if (out) out.push({ ty, z: cross.z, kc, m, on, score });
      if (!best || score > best.score) best = { score, m, on, kc, ty, tx: gx, fl, th, tEnd: cross.t };
    }
  }
  return best;
}

// ---------------------------------------------------------------- developer view

// The fan of directions from the ball for a kick class – along the grass, or
// lofted to land chest / head high d metres out, curled kc – over `spread`
// round th0: along each, the index of the first point one of theirs gets to
// first (-1: none – open as far as it goes), and the flight to draw (points
// relative to the ball, to be turned by th).
export function laneFan(w, team, kh, kc, d, th0, spread = 2.4, n = 41) {
  const b = w.ball;
  let vh, vz;
  if (kh === KH.GROUND) { vh = Math.min(groundSpeedFor(d, 7), 28); vz = 0; } else {
    const T = loftTime(d, kh, 0.3), zt = kh === KH.HIGH ? 1.75 : 1.0;
    vh = d / T * 1.04; vz = (zt - b.z + 0.5 * G * T * T * 1.03) / T;
  }
  const fl = classFlight(vh * (kc ? curlPace(kc) : 1), vz, kc * CURL_MAX, d, b.z, d + 6), rays = [];
  for (let i = 0; i < n; i++) {
    const th = th0 - spread / 2 + spread * i / (n - 1), c = Math.cos(th), sn = Math.sin(th);
    let shut = -1;
    for (let k = 0; k < fl.length && shut < 0; k++) {
      const q = fl[k], x = b.x + q.x * c - q.y * sn, y = b.y + q.x * sn + q.y * c;
      for (const o of w.players) if (o.team !== team && o.st !== ST.FALLEN && oppTime(w, o, x, y, q.z) < q.t) { shut = k; break; }
    }
    rays.push({ th, shut });
  }
  return { fl, rays };
}
