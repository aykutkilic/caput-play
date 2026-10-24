// AI for outfield players and keepers. Pure function of world state (plus the
// world's seeded RNG) so that clients predicting AI players get the same
// decisions as the server.

import { G, BTN, KT, KH, KICK_MASK, packKick, PHASE, ST, ROLE, SP, KICK, GKB } from './constants.js';
import {
  rnd, teamDir, pitchOf, pById, stOf, startKick, beginSlide, beginDive, beginBlock1v1, blockKind, slotOf, slotIndex, shootingPractice,
  inOwnBox, clamp, encodeStick, ballPath, blockPlan, beginBlock, wantsBlock, loftTime,
  groundSpeedFor, passEndSpeed, MU, CF, byPerson,
} from './sim.js';

const AI_CARRY = 1, AI_SUPPORT = 2;
const PATH_N = 25; // 2.5 s look-ahead in 0.1 s steps
const TAU = Math.PI * 2;

// Difficulty (room setting). react: ticks before a keeper reacts to a shot;
// spin: how much of the curl he reads; misread: his error (m) judging where it
// will cross; think: ticks between a carrier's decisions; block: per-tick
// chance a defender throws himself in front of a shot; sweep: time margin (s)
// a keeper wants before coming off his line; hold: ticks he keeps the ball;
// shuffle: whether he sprints across his goal while tracking a shot; angle:
// how well he finds the angle (0..1); smother: how loose a touch (m) he needs
// before diving at an attacker's feet; read: whether he reads a shooter's
// wind-up and sets himself; spread: ticks after a close-range strike before he
// spreads himself across it (a reflex, not a read reaction), spreadP: how often
// that comes off; misjudge: noise
// in the AI's shoot / pass / keep decisions; claim: how far off his line (m)
// he comes for a cross.
const LEVELS = [
  { react: 18, spin: 0, misread: 0.8, think: 9, block: 0.04, sweep: 0.4, hold: 70, shuffle: false, angle: 0.6, smother: 1.1, read: false, spread: 99, spreadP: 0, misjudge: 0.12, claim: 6 },
  { react: 10, spin: 0.25, misread: 0.35, think: 5, block: 0.12, sweep: 0.2, hold: 45, shuffle: false, angle: 0.85, smother: 0.85, read: true, spread: 4, spreadP: 0.75, misjudge: 0.05, claim: 8 },
  { react: 6, spin: 0.45, misread: 0.12, think: 3, block: 0.3, sweep: 0.05, hold: 28, shuffle: true, angle: 1, smother: 0.7, read: true, spread: 2, spreadP: 0.9, misjudge: 0.015, claim: 10 },
];
// a lagging human's stand-in plays at the middle level, whatever the room's AI
let stand = null;
const lvlOf = (w) => stand || LEVELS[w.m.ai] || LEVELS[1];
function angDiffAI(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }

function setMove(p, dx, dy, mag) {
  const [a, m] = encodeStick(dx, dy, mag);
  p.ia = a; p.im = m;
}

function moveTo(p, tx, ty, sprintDist = 6, arrive = 0.35) {
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
  if (d < arrive) { p.im = 0; return d; }
  // ease into position (no fixed walking pace that stops dead on arrival)
  setMove(p, dx, dy, Math.min(1, Math.max(0.12, d / 2.2)));
  if (d > sprintDist && p.stam > 0.2) p.ib |= BTN.SPRINT;
  return d;
}

// ------------------------------------------------------------ per-tick analysis

function predictPath(w) {
  const b = w.ball, path = [];
  if (b.owner >= 0) {
    const o = pById(w, b.owner);
    for (let k = 0; k <= PATH_N; k++) {
      const t = Math.min(k * 0.1, 0.8);
      path.push({ x: b.x + (o ? o.vx : 0) * t, y: b.y + (o ? o.vy : 0) * t, z: b.z });
    }
    return path;
  }
  const pts = ballPath(w);
  for (let k = 0; k <= PATH_N; k++) path.push(pts[Math.min(pts.length - 1, k * 3)]);
  return path;
}

function intercept(p, path, top = 2.2) {
  const s = stOf(p), v0 = Math.hypot(p.vx, p.vy);
  for (let k = 0; k < path.length; k++) {
    const t = k * 0.1, q = path[k];
    const d = Math.hypot(q.x - p.x, q.y - p.y) - 0.45;
    const reach = t < 0.2 ? v0 * t : v0 * 0.2 + s.sprint * (t - 0.2) * 0.92;
    if (d <= reach && q.z < top) return { t, x: q.x, y: q.y, z: q.z };
  }
  const q = path[path.length - 1];
  return { t: 9, x: q.x, y: q.y, z: q.z };
}

function analyse(w) {
  let c = w._aic;
  if (c && c.tick === w.tick && c.w === w) return c;
  c = { w, tick: w.tick, path: predictPath(w), ic: new Map(), chaser: [-1, -1], presser: [-1, -1], mark: new Map() };
  w._aic = c;
  const b = w.ball, pit = pitchOf(w);
  const owner = b.owner >= 0 ? pById(w, b.owner) : null;
  for (const p of w.players) c.ic.set(p.id, intercept(p, c.path));
  for (const team of [0, 1]) {
    const dir = teamDir(w, team), ogx = -dir * pit.L / 2;
    let bestAI = null, bestAIt = 1e9, bestH = 1e9;
    for (const p of w.players) {
      if (p.team !== team || p.role === ROLE.GK || p.st === ST.FALLEN || p.st === ST.SLIDE) continue;
      const t = c.ic.get(p.id).t;
      if (byPerson(p)) bestH = Math.min(bestH, t);
      else if (t < bestAIt) { bestAIt = t; bestAI = p; }
    }
    if (bestAI && bestAIt < bestH + 0.35) c.chaser[team] = bestAI.id;
    if (owner && owner.team !== team) {
      let bp = null, bd = 1e9, hd = 1e9;
      for (const p of w.players) {
        if (p.team !== team || p.role === ROLE.GK || p.st === ST.FALLEN) continue;
        let d = Math.hypot(p.x - owner.x, p.y - owner.y);
        if ((p.x - owner.x) * dir > 0.5) d += 2.5; // not goal-side
        if (byPerson(p)) hd = Math.min(hd, d);
        else if (d < bd) { bd = d; bp = p; }
      }
      if (bp && (bd < hd + 1.0 || hd > 4)) c.presser[team] = bp.id;
      // man marking for the rest, most dangerous attackers first
      const markers = w.players.filter((p) => p.team === team && !byPerson(p) && p.role === ROLE.OUT && p.id !== c.presser[team]);
      const targets = w.players.filter((o) => o.team !== team && o.role === ROLE.OUT && o !== owner)
        .sort((a, b2) => Math.hypot(a.x - ogx, a.y) - Math.hypot(b2.x - ogx, b2.y));
      const used = new Set();
      for (const o of targets) {
        let bm = null, bmd = 1e9;
        for (const p of markers) {
          if (used.has(p.id)) continue;
          const d = Math.hypot(p.x - o.x, p.y - o.y);
          if (d < bmd) { bmd = d; bm = p; }
        }
        if (!bm) break;
        used.add(bm.id); c.mark.set(bm.id, o.id);
      }
    }
  }
  return c;
}

export function laneBlocked(w, team, ax, ay, bx, by, width) {
  const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
  if (l2 < 1e-6) return false;
  for (const o of w.players) {
    if (o.team === team) continue;
    const u = ((o.x - ax) * vx + (o.y - ay) * vy) / l2;
    if (u < 0.05 || u > 1.02) continue;
    const px = ax + vx * u, py = ay + vy * u;
    if (Math.hypot(o.x - px, o.y - py) < width * (0.5 + 0.6 * u)) return true;
  }
  return false;
}

// Opposing keeper (or null).
function keeperOf(w, team) {
  for (const q of w.players) if (q.team === team && q.role === ROLE.GK) return q;
  return null;
}

// Nearest opponent distance to a point.
function openness(w, team, x, y) {
  let open = 99;
  for (const o of w.players) if (o.team !== team) open = Math.min(open, Math.hypot(o.x - x, o.y - y));
  return open;
}

// ------------------------------------------------------------ pitch control
//
// Time-to-intercept, as in the pitch-control models of football analytics:
// who can get to a spot first decides who controls it. Passes are judged by
// racing the ball along its path against every opponent, and spots by value.

// Seconds q needs to get to (x, y): a short reaction, then accelerating from
// his current speed towards that spot up to his sprint speed. Someone on the
// floor or mid-move needs the rest of it first.
function reachTime(q, x, y) {
  const s = stOf(q);
  const dx = x - q.x, dy = y - q.y, dl = Math.hypot(dx, dy);
  const busy = q.st !== ST.IDLE && q.st !== ST.STUMBLE ? Math.max(0, q.stDur - q.stT) / 60 : 0;
  const d = dl - (q.role === ROLE.GK ? 1.0 : 0.6);
  if (d <= 0) return 0.08 + busy;
  const v0 = clamp((q.vx * dx + q.vy * dy) / dl, 0, s.sprint);
  const a = s.accel, vmax = s.sprint;
  const ta = (vmax - v0) / a, da = v0 * ta + 0.5 * a * ta * ta;
  const t = d <= da ? (Math.sqrt(v0 * v0 + 2 * a * d) - v0) / a : ta + (d - da) / vmax;
  return 0.18 + t + busy;
}

// How likely a pass from (x0, y0) to (x1, y1) reaches `recv`: the smallest
// lead the ball keeps over any opponent anywhere along a ground pass (only the
// landing spot – and a charge-down at the start – for a lofted one), and the
// race between receiver and opponents at the target.
function passOdds(w, team, x0, y0, x1, y1, kind, kh, pw, recv) {
  const d = Math.hypot(x1 - x0, y1 - y0) || 0.01, ux = (x1 - x0) / d, uy = (y1 - y0) / d;
  let tEnd = 0, margin = 9;
  const opps = [];
  for (const o of w.players) if (o.team !== team && o.st !== ST.FALLEN) opps.push(o);
  if (kh === KH.GROUND) {
    const v0 = groundSpeedFor(d, passEndSpeed(kind, d, pw)), K = MU / CF;
    for (let t = 0.07; ; t += 0.07) {
      const sd = Math.min(d, (v0 + K) * (1 - Math.exp(-CF * t)) / CF - K * t);
      const px = x0 + ux * sd, py = y0 + uy * sd;
      for (const o of opps) {
        // a keeper can only use his hands in his box
        if (o.role === ROLE.GK && !inOwnBox(w, o.team, px, py, 0)) continue;
        margin = Math.min(margin, reachTime(o, px, py) - t);
      }
      if (sd >= d || t > 4) { tEnd = t; break; }
    }
  } else {
    // in the air: it can be cut out wherever it's low enough to reach (the
    // same flight the kick will use: arrive at chest / head height after T)
    tEnd = loftTime(d, kh, pw);
    const zt = kh === KH.HIGH ? 1.75 : 1.0, z0 = 0.11;
    const vz = (zt - z0 + 0.5 * G * tEnd * tEnd * 1.03) / tEnd;
    for (let t = 0.07; t < tEnd; t += 0.07) {
      const z = z0 + vz * t - 0.5 * G * t * t;
      if (z > 2.1) continue;
      const sd = d * t / tEnd, px = x0 + ux * sd, py = y0 + uy * sd;
      for (const o of opps) {
        if (o.role === ROLE.GK && !inOwnBox(w, o.team, px, py, 0)) continue;
        margin = Math.min(margin, reachTime(o, px, py) - t);
      }
    }
    for (const o of opps) margin = Math.min(margin, reachTime(o, x1, y1) - tEnd + (kh === KH.HIGH ? -0.15 : 0));
  }
  let tOpp = 9;
  for (const o of opps) tOpp = Math.min(tOpp, reachTime(o, x1, y1));
  const tRecv = recv ? reachTime(recv, x1, y1) : 9;
  margin = Math.min(margin, tOpp - Math.max(tRecv, tEnd) + 0.15);
  // a receiver arriving well after the ball leaves it to run loose
  margin -= Math.max(0, tRecv - tEnd - 0.4) * 0.5;
  return 1 / (1 + Math.exp(-(margin - 0.12) / 0.1));
}

// What having the ball at (x, y) is worth to `team` – shaped like the
// "expected threat" grids of football analytics: little in your own half,
// rising steeply towards the box – plus a rough chance of scoring from there
// (how much of the goal mouth is visible, how far).
function spotValue(w, team, x, y) {
  const pit = pitchOf(w), dir = teamDir(w, team), gx = dir * pit.L / 2;
  const prog = clamp((x * dir + pit.L / 2) / pit.L, 0, 1);
  const fx = Math.max(0.5, (gx - x) * dir);
  const ang = Math.abs(Math.atan2(pit.goalW / 2 - y, fx) - Math.atan2(-pit.goalW / 2 - y, fx));
  return 0.02 + 0.13 * prog * prog * prog + 0.9 * ang * Math.exp(-Math.hypot(gx - x, y) / 10);
}
// ...and what losing it there costs
function lossCost(w, team, x) {
  const pit = pitchOf(w), dir = teamDir(w, team);
  return 0.04 + 0.16 * clamp(1 - (x * dir + pit.L / 2) / pit.L, 0, 1);
}

// Rough chance a shot from p scores: the goal mouth he can see, the distance,
// someone in the way, someone on him.
function shotChance(w, p) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), gx = dir * pit.L / 2;
  const fx = (gx - p.x) * dir;
  if (fx < 1) return 0;
  const ang = Math.abs(Math.atan2(pit.goalW / 2 - p.y, fx) - Math.atan2(-pit.goalW / 2 - p.y, fx));
  let xg = 0.9 * ang * Math.exp(-Math.hypot(gx - p.x, p.y) / 9);
  if (laneBlocked(w, p.team, p.x, p.y, gx, 0, 0.7)) xg *= 0.5;
  if (openness(w, p.team, p.x, p.y) < 1.3) xg *= 0.75;
  return xg;
}

// The best pass by expected value: to feet, into the space ahead of a runner,
// or lofted (chest-high / head-high) when the ground route is shut – each
// candidate raced against the defenders.
function bestPass(w, p) {
  const dir = teamDir(w, p.team), b = w.ball, pit = pitchOf(w);
  const gx = dir * pit.L / 2;
  const wide = Math.abs(p.y) > pit.boxW / 2 - 3 && (gx - p.x) * dir < pit.boxD + 10;
  let best = null;
  const consider = (t, kind, kh, pw, tx, ty) => {
    tx = clamp(tx, -pit.L / 2 + 0.8, pit.L / 2 - 0.8); ty = clamp(ty, -pit.W / 2 + 0.8, pit.W / 2 - 0.8);
    const odds = passOdds(w, p.team, b.x, b.y, tx, ty, kind, kh, pw, t);
    let v = odds * spotValue(w, p.team, tx, ty) - (1 - odds) * lossCost(w, p.team, (b.x + tx) / 2);
    if (byPerson(t)) v += 0.06 * odds;   // give it to the people playing
    if (t.role === ROLE.GK) v -= 0.08;
    if (!best || v > best.v) best = { t, kind, kh, pw, tx, ty, v, odds };
  };
  for (const t of w.players) {
    if (t === p || t.team !== p.team || t.st === ST.FALLEN || t.st === ST.SLIDE) continue;
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d < 3.5 || d > 42) continue;
    // to feet (where he'll be when it gets there)
    const lead = d / 14 + 0.15;
    const fx = t.x + t.vx * lead * 0.8, fy = t.y + t.vy * lead * 0.8;
    consider(t, KICK.PASS, KH.GROUND, 0.35, fx, fy);
    consider(t, KICK.PASS, KH.GROUND, 0.75, fx, fy);
    // into the space ahead of him: along his run, or towards goal
    const sp = Math.hypot(t.vx, t.vy);
    const rx = sp > 2 ? t.vx / sp : dir, ry = sp > 2 ? t.vy / sp : -Math.sign(t.y) * 0.25;
    if ((rx * dir) > 0.2) for (const ahead of [3, 6]) consider(t, KICK.THROUGH, KH.GROUND, 0.5, fx + rx * ahead, fy + ry * ahead);
    // over the top: chest-high to feet; head-high only as a cross into the box
    // (it gets headed, not controlled)
    if (d > 9) {
      const inBox = Math.abs(t.x - gx) < pit.boxD + 2 && Math.abs(t.y) < pit.boxW / 2;
      const kh = wide && inBox ? KH.HIGH : KH.MID;
      const T = loftTime(d, kh, 0.3);
      const cx = t.x + t.vx * T * 0.9, cy = t.y + t.vy * T * 0.9;
      if (kh === KH.HIGH) {
        // value a cross by the header chance it creates
        const odds = passOdds(w, p.team, b.x, b.y, cx, cy, KICK.PASS, kh, 0.3, t);
        const v = odds * 0.6 * spotValue(w, p.team, cx, cy) - (1 - odds) * lossCost(w, p.team, cx);
        if (!best || v > best.v) best = { t, kind: KICK.PASS, kh, pw: 0.3, tx: cx, ty: cy, v, odds };
      } else consider(t, KICK.PASS, kh, 0.3, cx, cy);
    }
  }
  return best;
}

function slotTarget(w, p, attacking) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), b = w.ball, m = w.m;
  const [i, n] = slotIndex(w, p);
  const [a, sb] = slotOf(Math.max(1, n), Math.max(0, i));
  const hx = pit.L / 2, hy = pit.W / 2;
  let x;
  if (attacking) {
    // push up: forwards hold a high line, everyone moves with the ball
    x = dir * Math.min(0.75, a + 0.5) * hx * 0.75 + b.x * 0.3;
  } else {
    x = dir * (a - 0.05) * hx * 0.6 + b.x * 0.4;
    if ((x - b.x) * dir > -1.5) x = b.x - dir * 1.5;
  }
  let y = sb * hy * 0.65 + b.y * 0.25;
  // corners: attackers crowd the box, defenders track back
  if (m.phase !== PHASE.KICKOFF && m.spType === SP.CORNER && (m.phase === PHASE.SETPIECE || m.spTaker >= 0)) {
    const sdir = teamDir(w, m.spTeam), gx = sdir * hx;
    x = gx - sdir * (pit.penSpot * (0.6 + 0.5 * ((i % 3) / 2)));
    y = sb * pit.boxW * 0.3;
  }
  return [clamp(x, -hx + 1.5, hx - 1.5), clamp(y, -hy + 1.2, hy - 1.2)];
}

function aiKick(w, p, kind, power, tx, ty, tid = -1, kh) {
  const b = w.ball, m = w.m;
  if (b.held && b.owner === p.id) {
    if (m.spTaker === p.id) {
      kind = kind === KICK.LONG || (kh !== undefined && kh !== KH.GROUND) ? KICK.LONG : KICK.THROW;
      if (kind === KICK.THROW) kh = KH.GROUND;
    } else if ((kind === KICK.PASS || kind === KICK.THROUGH) && (kh === undefined || kh === KH.GROUND)) {
      kind = KICK.THROW; kh = KH.GROUND; // rolled out
    } else if (kind !== KICK.PUNT && Math.hypot(tx - b.x, ty - b.y) <= 50) {
      kind = KICK.THROW; kh = KH.MID; // thrown – a drop kick beyond throwing range (see startKick)
    } else kind = KICK.PUNT;
  }
  startKick(w, p, kind, power, false, tx, ty, tid, kh);
}

// Where and how to shoot: away from the keeper, low / mid / high, and a chip
// when he has come off his line.
function aimShot(w, p) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), gx = dir * pit.L / 2;
  const gk = keeperOf(w, 1 - p.team);
  const dGoal = Math.hypot(gx - p.x, p.y);
  let side;
  if (gk && Math.abs(gk.y) > 0.3) side = gk.y > 0 ? -1 : 1;
  else side = p.y > 0.5 ? -1 : p.y < -0.5 ? 1 : (rnd(w) < 0.5 ? -1 : 1);
  // close in he picks a corner; from further out he keeps it safely inside the post
  const aimY = side * pit.goalW * (0.24 + rnd(w) * 0.16) * clamp(1.25 - dGoal / 26, 0.4, 1);
  const off = gk ? Math.abs(gk.x - gx) : 0;
  if (gk && off > 3.5 && dGoal > 10 && dGoal - 2 > Math.hypot(gk.x - p.x, gk.y - p.y)) {
    return { kind: KICK.SHOT, kh: KH.HIGH, pw: clamp(0.15 + dGoal * 0.008, 0.15, 0.4), aimY: aimY * 0.5 };
  }
  const r = rnd(w);
  const kh = r < 0.5 ? KH.GROUND : r < 0.82 ? KH.MID : KH.HIGH;
  const kind = dGoal > 12 && rnd(w) < 0.3 ? KICK.FINESSE : KICK.SHOT;
  const range = Math.min(24, pit.L * 0.38);
  const pw = clamp(0.4 + dGoal / range * 0.45 + (rnd(w) - 0.5) * 0.12, 0.3, 0.88);
  return { kind, kh, pw, aimY };
}

// ------------------------------------------------------------ roles

function carrierThink(w, p) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), b = w.ball, m = w.m;
  const gx = dir * pit.L / 2;
  if (p.ai !== AI_CARRY) { p.ai = AI_CARRY; p.aiT = 8 + Math.floor(rnd(w) * 10); p.aiX = 0; }
  p.aiX++;

  if (m.spTaker === p.id) {
    if (m.cd < 40 + (p.id * 13) % 40) return;
    if (m.spType === SP.PENALTY) {
      const side = rnd(w) < 0.5 ? -1 : 1;
      aiKick(w, p, KICK.SHOT, 0.5 + rnd(w) * 0.3, gx, side * pit.goalW * (0.22 + rnd(w) * 0.16), -1, rnd(w) < 0.6 ? KH.GROUND : KH.MID);
      return;
    }
    if (m.spType === SP.FREEKICK && Math.hypot(gx - p.x, p.y) < 24 && (gx - p.x) * dir > 6) {
      // over the wall into the top corner
      const side = p.y > 0 ? -1 : 1;
      aiKick(w, p, KICK.FINESSE, 0.6 + rnd(w) * 0.15, gx, side * pit.goalW * 0.32, -1, KH.HIGH);
      return;
    }
    if (m.spType === SP.CORNER) {
      // head-high to whoever is best placed in the box
      let tgt = null, td = 1e9;
      for (const q of w.players) {
        if (q.team !== p.team || q === p || q.role === ROLE.GK) continue;
        const d = Math.hypot(q.x - (gx - dir * pit.penSpot), q.y) + openness(w, p.team, q.x, q.y) * -0.5;
        if (d < td) { td = d; tgt = q; }
      }
      if (tgt) aiKick(w, p, KICK.PASS, 0.55, tgt.x, tgt.y, tgt.id, KH.HIGH);
      else aiKick(w, p, KICK.LONG, 0.55, gx - dir * pit.penSpot * (0.6 + rnd(w) * 0.5), (rnd(w) - 0.5) * pit.goalW * 1.2, -1, KH.HIGH);
      return;
    }
    const bp = bestPass(w, p);
    if (bp) aiKick(w, p, bp.kind, 0.5, bp.tx, bp.ty, bp.t.id, bp.kh);
    else aiKick(w, p, KICK.LONG, 0.7, p.x + dir * 20, p.y * 0.5, -1, KH.HIGH);
    return;
  }

  // a human team-mate called for the ball (L1)
  const req = p.team === 0 ? m.req0 : m.req1;
  if (req >= 0 && req !== p.id && p.aiX > 4) {
    const r = pById(w, req);
    if (r && r.team === p.team) {
      const d = Math.hypot(r.x - p.x, r.y - p.y);
      const blocked = laneBlocked(w, p.team, b.x, b.y, r.x, r.y, 1.2);
      const kh = blocked && d > 9 ? KH.MID : KH.GROUND;
      const T = kh === KH.GROUND ? 0.5 : loftTime(d, kh, 0.5);
      aiKick(w, p, KICK.PASS, 0.5, r.x + r.vx * T, r.y + r.vy * T, r.id, kh);
      if (p.team === 0) { m.req0 = -1; m.req0T = 0; } else { m.req1 = -1; m.req1T = 0; }
      return;
    }
  }

  let press = 99, nOpp = null;
  for (const o of w.players) {
    if (o.team === p.team) continue;
    const d = Math.hypot(o.x - p.x, o.y - p.y);
    if (d < press) { press = d; nOpp = o; }
  }
  const dGoal = Math.hypot(gx - p.x, p.y);

  if (p.aiT === 0) {
    const lv = lvlOf(w);
    p.aiT = lv.think + Math.floor(rnd(w) * (lv.think + 1));
    // Weigh the options on one scale – roughly "chance this possession ends
    // in a goal": shoot (its scoring chance), pass (odds x where it ends up,
    // minus the cost of losing it), or keep it (fine while nobody can get to
    // him; dribbling buys a little).
    let tPress = 9;
    for (const o of w.players) if (o.team !== p.team) tPress = Math.min(tPress, reachTime(o, p.x, p.y));
    const safe = 1 / (1 + Math.exp(-(tPress - 0.5) / 0.12));
    const keep = safe * spotValue(w, p.team, p.x + dir * 3 * safe, p.y * 0.9) - (1 - safe) * lossCost(w, p.team, p.x);
    const xg = dGoal < 30 ? shotChance(w, p) : 0;
    const bp = bestPass(w, p);
    const passV = bp ? bp.v + (p.aiX > 150 ? 0.1 : 0) : -1;
    // a weaker AI misjudges a little
    const noise = (rnd(w) - 0.5) * lv.misjudge;
    // players like to shoot: a small bias, growing the longer the move goes on
    const urge = 0.025 + Math.min(0.04, p.aiX / 4000);
    if (xg > 0.04 && xg + urge + noise >= Math.max(passV, keep)) {
      const sh = aimShot(w, p);
      aiKick(w, p, sh.kind, sh.pw, gx, sh.aimY, -1, sh.kh);
      return;
    }
    if (bp && passV + noise > keep + 0.01) {
      aiKick(w, p, bp.kind, bp.pw, bp.tx, bp.ty, bp.t.id, bp.kh);
      return;
    }
  }

  let tx = gx - dir * 2, ty = p.y * 0.5;
  if (nOpp && press < 5) {
    const ox = nOpp.x - p.x, oy = nOpp.y - p.y;
    if (ox * dir > -0.5) { ty = p.y + (oy > 0 ? -6 : 6); tx = p.x + dir * 5; }
  }
  ty = clamp(ty, -pit.W / 2 + 2, pit.W / 2 - 2);
  moveTo(p, tx, ty, press > 3 ? 0 : 99, 0.1);
  if (press < 1.3) p.ib |= BTN.R2;
}

// Off-ball movement. Every so often a supporting player looks at spots around
// his formation slot, a few runs in behind and into the channels, and picks
// the most useful: one he gets to before any defender (pitch control), that
// the carrier can find with a pass (pass odds), worth having the ball in
// (spot value), not crowding a team-mate and not too far from his slot. The
// current target gets a bonus so he doesn't dither between similar spots.
function supportThink(w, p, owner) {
  const pit = pitchOf(w), dir = teamDir(w, p.team);
  const hx = pit.L / 2 - 1.5, hy = pit.W / 2 - 1.2;
  if (p.ai !== AI_SUPPORT) { p.ai = AI_SUPPORT; p.aiT = 0; p.aiX = p.x; p.aiY = p.y; }
  if (p.aiT === 0) {
    p.aiT = 24 + Math.floor(rnd(w) * 24);
    const [sx, sy] = slotTarget(w, p, true);
    // the opponents' last line (deepest outfield defender)
    let line = -dir * 1e9;
    for (const o of w.players) if (o.team !== p.team && o.role === ROLE.OUT && (o.x - line) * dir > 0) line = o.x;
    const [, n] = slotIndex(w, p);
    const cands = [[p.aiX, p.aiY, 0.04], [sx, sy, 0]];
    const a0 = rnd(w) * TAU;
    for (let k = 0; k < 10; k++) {
      const a = a0 + k / 10 * TAU, r = k % 2 ? 4.5 : 9;
      cands.push([sx + Math.cos(a) * r, sy + Math.sin(a) * r, 0]);
    }
    // runs in behind / into the channel ahead of the ball, and showing short
    for (const off of [-8, 0, 8]) cands.push([line + dir * 3, clamp(p.y + off, -hy, hy), 0]);
    cands.push([owner.x + dir * 12, clamp(owner.y + (p.y > owner.y ? 9 : -9), -hy, hy), 0]);
    cands.push([owner.x + dir * 2, clamp(owner.y + (p.y > owner.y ? 7 : -7), -hy, hy), 0]);
    let best = null, bestS = -1e9;
    for (const [cx0, cy0, bonus] of cands) {
      const cx = clamp(cx0, -hx, hx), cy = clamp(cy0, -hy, hy);
      const d = Math.hypot(cx - owner.x, cy - owner.y);
      if (d < 4) continue;
      // who controls that spot when he gets there
      const tMe = reachTime(p, cx, cy);
      let tOpp = 9;
      for (const o of w.players) if (o.team !== p.team) tOpp = Math.min(tOpp, reachTime(o, cx, cy));
      const control = 1 / (1 + Math.exp(-(tOpp - tMe) / 0.3));
      const odds = passOdds(w, p.team, owner.x, owner.y, cx, cy, KICK.PASS, d > 22 ? KH.MID : KH.GROUND, 0.5, null);
      let sc = control * (0.4 + 0.6 * odds) * spotValue(w, p.team, cx, cy) + bonus;
      sc -= 0.004 * Math.max(0, d - 26);
      for (const q of w.players) {
        if (q === p || q === owner || q.team !== p.team || q.role === ROLE.GK) continue;
        const qx = q.ai === AI_SUPPORT ? q.aiX : q.x, qy = q.ai === AI_SUPPORT ? q.aiY : q.y;
        const dq = Math.hypot(cx - qx, cy - qy);
        if (dq < 7) sc -= (7 - dq) * 0.006;
      }
      sc -= Math.hypot(cx - sx, cy - sy) * (n > 3 ? 0.003 : 0.0015);
      // waiting behind the last defender is no use until the ball is played
      if ((cx - line) * dir > 4) sc -= 0.05;
      if (sc > bestS) { bestS = sc; best = [cx, cy]; }
    }
    if (best) { p.aiX = best[0]; p.aiY = best[1]; }
  }
  const run = (p.aiX - p.x) * dir > 4;
  moveTo(p, p.aiX, p.aiY, run ? 3 : 8, 0.6);
}

function defendThink(w, p, c, owner) {
  const b = w.ball, pit = pitchOf(w), dir = teamDir(w, p.team);
  // a hard opposing shot / pass coming past: throw a leg or the body at it
  if (!owner && wantsBlock(w, p) && rnd(w) < lvlOf(w).block) {
    const plan = blockPlan(w, p);
    if (plan && plan.t < 0.45 && beginBlock(w, p, plan)) return;
  }
  if (!owner) {
    const ic = c.ic.get(p.id);
    if (c.chaser[p.team] === p.id || b.tgt === p.id) {
      // a pass meant for him: meet it where it can be controlled (chest height
      // at most), not where it could only be headed on
      const mc = b.tgt === p.id && b.lastTeam === p.team ? intercept(p, c.path, 1.4) : ic;
      const go = mc.t < 9 ? mc : ic;
      moveTo(p, go.x, go.y, go.t > 0.5 ? 2 : 99, 0.05);
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (!p.qa && d < 7) {
        const gx = dir * pit.L / 2, dGoal = Math.hypot(gx - p.x, p.y);
        const airborne = b.z > 0.5 || b.vz > 1;
        // a pass meant for him is controlled; a first-time finish only off a
        // ball along the ground, or anything right in front of goal
        const meant = b.tgt === p.id && b.lastTeam === p.team;
        if (dGoal < 16 && (gx - p.x) * dir > 1 && (!meant || !airborne || dGoal < 9)) { p.qa = packKick(KT.GOAL, rnd(w) < 0.5 ? KH.GROUND : KH.MID); p.qp = 0.5 + rnd(w) * 0.3; p.qt = 30; }
        else if (!meant && airborne && inOwnBox(w, p.team, p.x, p.y, 6)) { p.qa = packKick(KT.GOAL, KH.HIGH); p.qp = 0.85; p.qt = 30; } // clear it
        else if (!meant && airborne && b.z > 1.4 && rnd(w) < 0.05) { p.qa = packKick(KT.MATE, KH.MID); p.qp = 0.5; p.qt = 30; }
      }
      return;
    }
    const [tx, ty] = slotTarget(w, p, b.lastTeam === p.team);
    moveTo(p, tx, ty, 8, 0.6);
    return;
  }
  const ogx = -dir * pit.L / 2;
  if (c.presser[p.team] === p.id) {
    let gx = ogx - owner.x, gy = -owner.y;
    const gd = Math.hypot(gx, gy) || 1; gx /= gd; gy /= gd;
    const tx = owner.x + owner.vx * 0.2 + gx * 0.8, ty = owner.y + owner.vy * 0.2 + gy * 0.8;
    const d = Math.hypot(owner.x - p.x, owner.y - p.y);
    moveTo(p, tx, ty, 2.5, 0.05);
    if (d < 1.7 && !owner.held) p.ib |= KT.MATE; // press = hold a team-mate key
    if (d > 1.3 && d < 3.0 && p.tcd === 0 && !owner.held && w.m.spTaker !== owner.id) {
      const bx = b.x - p.x, by = b.y - p.y, bd = Math.hypot(bx, by) || 1;
      const facing = (Math.cos(p.face) * bx + Math.sin(p.face) * by) / bd;
      if (facing > 0.9 && rnd(w) < (inOwnBox(w, p.team, p.x, p.y, 2) ? 0.004 : 0.018)) beginSlide(w, p);
    }
    return;
  }
  // an attacker on the ball near our goal: besides the man pressing him, the
  // nearest of us gets on the line between the ball and the goal, to block
  const dGoalB = Math.hypot(owner.x - ogx, owner.y);
  if (dGoalB < 22) {
    const k = Math.min(0.45, 3.5 / (dGoalB || 1));
    const lx = owner.x + (ogx - owner.x) * k, ly = owner.y * (1 - k);
    let best = null, bd = 1e9;
    for (const q of w.players) {
      if (q.team !== p.team || q.role === ROLE.GK || q.id === c.presser[p.team] || q.st === ST.FALLEN) continue;
      const dq = Math.hypot(q.x - lx, q.y - ly);
      if (dq < bd) { bd = dq; best = q; }
    }
    if (best === p) { moveTo(p, lx, ly, 3, 0.15); return; }
  }
  const [sx, sy] = slotTarget(w, p, false);
  const mk = c.mark.get(p.id);
  let tx = sx, ty = sy;
  if (mk !== undefined) {
    const o = pById(w, mk);
    if (o) {
      // goal-side of the man, shaded towards the ball to cut the passing lane
      const dx = ogx - o.x, dy = -o.y, d = Math.hypot(dx, dy) || 1;
      const lx = o.x + (owner.x - o.x) * 0.22, ly = o.y + (owner.y - o.y) * 0.22;
      const tight = Math.hypot(o.x - ogx, o.y) < pit.boxD + 10 ? 1.2 : 2.0;
      tx = (lx + dx / d * tight) * 0.8 + sx * 0.2;
      ty = (ly + dy / d * tight) * 0.8 + sy * 0.2;
    }
  }
  moveTo(p, tx, ty, 5, 0.5);
}

// Where a keeper stands against a ball at (bx, by): on the bisector of the
// angle the shooter sees between the posts (equal cover of both corners),
// `depth` metres off his line. A ball level with the goal line: near post.
function anglePoint(w, team, bx, by, depth) {
  const pit = pitchOf(w), dir = teamDir(w, team), ogx = -dir * pit.L / 2, hw = pit.goalW / 2;
  let ux = ogx - bx, uy = -hw - by; const l1 = Math.hypot(ux, uy) || 1; ux /= l1; uy /= l1;
  let vx = ogx - bx, vy = hw - by; const l2 = Math.hypot(vx, vy) || 1; vx /= l2; vy /= l2;
  let kx = ux + vx, ky = uy + vy; const lk = Math.hypot(kx, ky) || 1; kx /= lk; ky /= lk;
  const front = (bx - ogx) * dir; // ball's distance out from the goal line
  if (front < 0.6 || Math.abs(kx) < 0.2) return [ogx + dir * 0.5, clamp(by, -hw + 0.45, hw - 0.45)];
  const dep = Math.min(depth, front * 0.6);
  const t = (ogx + dir * dep - bx) / kx;
  return [bx + kx * t, clamp(by + ky * t, -hw + 0.3, hw - 0.3)];
}

// Is anyone of ours between the ball carrier and our goal (inside the cone
// he'd shoot through)?
function defenderBetween(w, team, o, ogx, keeper) {
  for (const q of w.players) {
    if (q.team !== team || q === keeper || q.st === ST.FALLEN || q.st === ST.SLIDE) continue;
    const ax = ogx - o.x, ay = -o.y, al = Math.hypot(ax, ay) || 1;
    const qx = q.x - o.x, qy = q.y - o.y;
    const along = (qx * ax + qy * ay) / al;
    if (along < 0.3 || along > al - 1) continue;
    const off = Math.abs(qx * ay - qy * ax) / al;
    if (off < 1.0 + along * 0.18) return true;
  }
  return false;
}

// Goalkeeping in the textbook order: shot stopping, claiming / sweeping loose
// balls, then positioning – on the shooting angle, set (feet planted) when a
// shot is coming, closing the angle step by step in a one-on-one and diving
// at the ball only when the attacker's touch gives him the chance.
function gkThink(w, p, c) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), b = w.ball, m = w.m, s = stOf(p);
  const ogx = -dir * pit.L / 2;
  const lv = lvlOf(w);
  if (b.owner === p.id && shootingPractice(w)) {
    // shooting practice: serve it to one of the players after a moment – mostly
    // rolled to his feet, sometimes up for a volley or a header
    if (p.ai !== AI_CARRY) { p.ai = AI_CARRY; p.aiT = 40 + Math.floor(rnd(w) * 30); }
    if (p.aiT > 0) { moveTo(p, ogx + dir * 2, p.y * 0.5, 99, 0.3); return; }
    const outs = w.players.filter((q) => q.role !== ROLE.GK);
    const q = outs[Math.floor(rnd(w) * outs.length)];
    const d = Math.hypot(q.x - b.x, q.y - b.y), up = d > 30 || rnd(w) < 0.3;
    const T = up ? 1.1 + d / 30 : 0.35 + d / 14;
    const tx = q.x + q.vx * T, ty = q.y + q.vy * T;
    if (up) aiKick(w, p, KICK.LONG, 0.6, tx, ty, q.id, d > 30 ? KH.HIGH : KH.MID);
    else aiKick(w, p, KICK.PASS, 0.5, tx, ty, q.id, KH.GROUND);
    return;
  }
  if (b.owner === p.id) {
    // in his hands he can take his time; at his feet (a back-pass) he moves it on
    if (p.ai !== AI_CARRY) { p.ai = AI_CARRY; p.aiT = b.held ? lv.hold + Math.floor(rnd(w) * 30) : 10 + Math.floor(rnd(w) * 12); }
    if (m.spTaker === p.id && m.cd < 45) return;
    // quick distribution: a team-mate already free gets it straight away
    const bp = bestPass(w, p);
    const d = bp ? Math.hypot(bp.tx - p.x, bp.ty - p.y) : 99;
    const clear = bp && bp.kh === KH.GROUND && bp.odds > 0.85 && d < 32;
    // ball at his feet with someone closing in: no time to wait – out of his
    // box (sweeping up) with a man on him, it's cleared, long and wide
    const rushed = !b.held && openness(w, p.team, p.x, p.y) < 8;
    if (rushed && !inOwnBox(w, p.team, p.x, p.y, 0) && openness(w, p.team, p.x, p.y) < 4.5 && m.spTaker !== p.id) {
      const side = p.y >= 0 ? 1 : -1;
      aiKick(w, p, KICK.CLEAR, 0.95, p.x + dir * 32, side * pit.W * 0.38, -1, KH.HIGH);
      return;
    }
    if (p.aiT > 0 && m.spTaker !== p.id && !rushed && !(clear && bp.odds > 0.95 && p.aiT < lv.hold - 15)) {
      moveTo(p, ogx + dir * 5, p.y * 0.5, 99, 0.3);
      return;
    }
    if (clear) aiKick(w, p, bp.kind, bp.pw, bp.tx, bp.ty, bp.t.id, KH.GROUND);
    else if (bp && bp.odds > 0.65) aiKick(w, p, bp.kind, bp.pw, bp.tx, bp.ty, bp.t.id, bp.kh);
    else {
      // long: the team-mate (or the wide space) a high ball is most likely to
      // reach – raced against everyone who could head it on the way
      // (getting it away safely first: odds count more than where it lands)
      let best = null;
      const tryTarget = (tx, ty, q) => {
        const odds = passOdds(w, p.team, b.x, b.y, tx, ty, KICK.LONG, KH.HIGH, 0.8, q);
        const v = odds * (0.3 + spotValue(w, p.team, tx, ty));
        if (!best || v > best.v) best = { tx, ty, tid: q ? q.id : -1, v };
      };
      for (const q of w.players) if (q.team === p.team && q !== p && (q.x - p.x) * dir > 12) tryTarget(q.x, q.y, q);
      for (const side of [-1, 1]) for (const fx of [-0.15, 0.1]) tryTarget(dir * pit.L * fx, side * pit.W * 0.4, null);
      // from his hands: a drop kick to a man within range, else punted
      const far = Math.hypot(best.tx - p.x, best.ty - p.y) > 50 || best.tid < 0;
      aiKick(w, p, b.held && far ? KICK.PUNT : KICK.LONG, 0.75 + rnd(w) * 0.2, best.tx, best.ty, best.tid, KH.HIGH);
    }
    return;
  }
  p.ai = 0;
  const owner = b.owner >= 0 ? pById(w, b.owner) : null;
  const pv = Math.hypot(p.vx, p.vy);

  // 1. shot stopping (until he has reacted to a shot he holds his position;
  // a keeper caught moving reacts later)
  const tg0 = !owner && b.vx * -dir > 4 ? (ogx - b.x) / b.vx : -1;
  const shotOnGoal = tg0 > 0 && tg0 < 2 && Math.hypot(b.vx, b.vy) > 9 && b.lastTeam !== p.team
    && Math.abs(b.y + b.vy * tg0) < pit.goalW / 2 + 0.8;
  // struck from close in: no time to react – a block on reflex (it doesn't
  // always come off: then it's hands, a dive or his legs): the K-barrier from
  // a tight angle, spread close in, the star jump a little further out at a
  // shot coming near him (one wide of him is still a dive)
  if (shotOnGoal && b.kt === lv.spread && p.tcd === 0 && (p.x - b.x) / b.vx > 0.04 && rnd(w) < lv.spreadP) {
    const dB = Math.hypot(b.x - p.x, b.y - p.y), tk = (p.x - b.x) / b.vx;
    const kind = blockKind(w, b.x, b.y, dB);
    // each block for the height it covers: spread on the ground for a low one,
    // the K-barrier up to his waist, the star for a high one just out of his
    // standing reach (it leaves a gap at his hips) and only when there's no
    // time to dive; a shot at him at chest height he takes standing
    const off = Math.abs(b.y + b.vy * tk - p.y), zk = b.z + b.vz * tk - 0.5 * G * tk * tk;
    const nearHim = off > 0.55 && off < 1.15 && zk > 1.0 && zk < 2.3;
    if ((kind === GKB.SPREAD && dB < 4.5 && zk < 0.7) || (kind === GKB.STAR && nearHim && tk < 0.25) || (kind === GKB.KNEE && dB < 6.5 && zk < 1.1)) {
      p.tcd = 50;
      beginBlock1v1(w, p, Math.atan2(-b.vy, -b.vx), kind);
      return;
    }
  }
  if (shotOnGoal && b.kt > lv.react + (p.id % 3) + (pv > 2.5 ? 5 : 0)) {
    const t = (p.x - b.x) / b.vx;
    if (t > -0.05 && t < 1.4) {
      const tg = (ogx - b.x) / b.vx, yg = b.y + b.vy * tg;
      if (Math.abs(yg) < pit.goalW / 2 + 0.8) {
        const tt = Math.max(t, 0);
        // lateral bend from spin is spin * vx * t^2 / 2; keepers only partly read it
        const yk = b.y + b.vy * tt + lv.spin * b.spin * b.vx * tt * tt;
        let zk = b.z + b.vz * tt - 0.5 * G * tt * tt;
        if (zk < 0.15) zk = 0.25;
        // a lob over his head that drops in under the bar: back-pedal along
        // its line to where he can reach it jumping (then catch it, or tip it
        // over – see gkSave)
        const top = s.H * 1.22 + s.jump + 0.1;
        const zg = b.z + b.vz * tg - 0.5 * G * tg * tg;
        if (zk > top && zg < pit.goalH + 0.2) {
          const q = c.path.find((q) => (q.x - p.x) * dir < -0.3 && q.z < top);
          if (q) { moveTo(p, (q.x - ogx) * dir < 0.2 ? ogx + dir * 0.2 : q.x, q.y, 0.5, 0.05); return; }
        }
        const dy = yk - p.y;
        // low and just wide, too quick to dive for: a leg slid out along the grass
        // (when there's really no time – otherwise it's a dive, which can hold it)
        if (zk < 0.45 && Math.abs(dy) > 0.5 && Math.abs(dy) < 1.5 && p.tcd === 0 && (tt < 0.18 || (tt < 0.24 && rnd(w) < 0.4))) {
          const to = Math.atan2(b.y - p.y, b.x - p.x);
          p.tcd = 40;
          beginBlock1v1(w, p, to, GKB.SPLITS, Math.cos(to) * dy >= 0 ? 1 : -1);
          return;
        }
        if (Math.abs(dy) > 0.65 && tt < 0.4 + s.h * 0.08) {
          const ey = dy + (rnd(w) - 0.5) * 2 * lv.misread;
          beginDive(w, p, Math.atan2(ey, dir * 0.25 * Math.abs(ey)), Math.min(zk, 2.3), tt, Math.abs(ey) * 1.03);
          return;
        }
        moveTo(p, p.x + dir * 0.05, yk, lv.shuffle ? 0.5 : 99, 0.05);
        return;
      }
    }
  }

  // 2. loose balls and crosses: claim them in the box (he catches above the
  // heads), sweep up balls played in behind; dive at a ball an attacker is
  // about to reach
  if (!owner && !shotOnGoal) {
    const ic = intercept(p, c.path, s.H + 0.75);
    let opp = 9, rival = null;
    for (const q of w.players) if (q.team !== p.team) { const t = c.ic.get(q.id).t; if (t < opp) { opp = t; rival = q; } }
    const called = (p.team === 0 ? m.gkc0 : m.gkc1) > 0;
    const high = ic.z > 1.2; // a cross / lofted ball: only inside his claiming range
    const inBox = inOwnBox(w, p.team, ic.x, ic.y, -0.5) && (!high || Math.abs(ic.x - ogx) < lv.claim);
    const sweep = !inBox && ic.t < 9 && Math.abs(ic.x - ogx) < pit.boxD + 9 && b.vx * dir < -2 && ic.t + lv.sweep < opp - 0.15;
    // a ground ball he has to win clearly (losing the race leaves the goal
    // open); a high one in his range he can take above the attacker's head
    const wins = high ? ic.t <= opp + 0.15 : ic.t < opp - 0.1 - lv.sweep * 0.5;
    // a back-pass to him: go and meet it (to control it with his feet)
    const meant = b.tgt === p.id && b.lastTeam === p.team;
    if ((inBox && (wins || called)) || sweep || (meant && ic.t < 9)) {
      const dBall = Math.hypot(b.x - p.x, b.y - p.y);
      if (inBox && rival && b.z < 0.5 && dBall < 2.4 && dBall > 0.9 && Math.hypot(b.x - rival.x, b.y - rival.y) < 2.2 && p.tcd === 0) {
        p.tcd = 50;
        beginDive(w, p, Math.atan2(b.y - p.y, b.x - p.x), 0.15, Math.max(0.15, dBall / 7), dBall + 0.3);
        return;
      }
      moveTo(p, ic.x, ic.y, 1.5, 0.05);
      return;
    }
  }

  // a shot is on its way but he hasn't reacted yet: stay planted
  if (shotOnGoal) { p.im = 0; return; }

  // 3. positioning
  let tx, ty, set = false, rush = false;
  if (owner && owner.team !== p.team) {
    const dGoal = Math.hypot(owner.x - ogx, owner.y);
    // a breakaway: nobody between him and goal, and running at it (closing
    // down a man standing still only gives him a bigger target to chip)
    const advancing = (owner.vx * (ogx - owner.x) - owner.vy * owner.y) / (dGoal || 1) > 2.5;
    const alone = dGoal < 26 && advancing && !defenderBetween(w, p.team, owner, ogx, p);
    const charge = (p.team === 0 ? m.gkc0 : m.gkc1) > 0;
    // shooting: an AI winding up, or a human charging a shot (the keeper reads the backswing)
    const shooting = (owner.st === ST.KICK && (owner.kk === KICK.SHOT || owner.kk === KICK.FINESSE))
      || (lv.read && (owner.chgBtn & KICK_MASK) === KT.GOAL);
    const sep = Math.hypot(b.x - owner.x, b.y - owner.y), dBall = Math.hypot(b.x - p.x, b.y - p.y);
    // close in, in the box: come off the line at him to make the goal small,
    // whether or not he's running at it
    const close = dGoal < 11 && inOwnBox(w, p.team, owner.x, owner.y, 0);
    rush = close; // closing him down: quick off the line
    // smother: the attacker has let the ball run away from him, or walked into
    // the keeper; spread: he's about to shoot from close in – no time to react,
    // so throw yourself at the ball as he strikes it
    if ((alone || charge || close) && !shooting && inOwnBox(w, p.team, b.x, b.y, 0.5) && p.tcd === 0 && b.z < 0.5
      && dBall < 2.6 && (sep > lv.smother || dBall < 1.3)) {
      p.tcd = 50;
      beginDive(w, p, Math.atan2(b.y - p.y, b.x - p.x), 0.15, Math.max(0.15, dBall / 7), dBall + 0.3);
      return;
    }
    // close the angle: a lone attacker is met further out the closer he gets
    // (the gap between them shrinks faster than he advances)
    const gap = clamp(0.5 * dGoal, 2.8, 11);
    const depth = alone || charge ? clamp(dGoal - gap, 1.0, Math.min(6.5, pit.boxD * 0.55))
      : close ? clamp(dGoal - 2.6, 1.0, Math.min(6, pit.boxD * 0.55))
        : clamp(0.08 * dGoal + 0.7, 0.8, 2.6);
    [tx, ty] = anglePoint(w, p.team, b.x, b.y, depth);
    // crossing position: a wide ball not yet in shooting angle – stand central, a step out
    const wideBall = Math.abs(b.y) > pit.goalW / 2 + 4 && (b.x - ogx) * dir < pit.boxD + 8 && (b.x - ogx) * dir > 4;
    if (!alone && !close && wideBall) { tx = ogx + dir * 1.6; ty = Math.sign(b.y) * pit.goalW * 0.1; }
    set = shooting || (dGoal < 25 && Math.abs(angDiffAI(owner.face, Math.atan2(-owner.y, ogx - owner.x))) < 0.9 && sep < 1.2);
  } else {
    // our ball or a loose one: angle on where the ball is going; further out
    // (sweeper) when we have it
    const q = c.path[Math.min(c.path.length - 1, 5)];
    const ours = owner && owner.team === p.team;
    const dist = Math.hypot(q.x - ogx, q.y);
    const depth = ours ? clamp(0.2 * dist, 1, pit.boxD - 3) : clamp(0.08 * dist + 0.7, 0.8, 3.0);
    [tx, ty] = anglePoint(w, p.team, q.x, q.y, depth);
  }
  // a weaker keeper only roughly finds the angle
  if (lv.angle < 1) { const cx = ogx + dir * Math.abs(tx - ogx); tx = tx * lv.angle + cx * (1 - lv.angle); ty *= lv.angle; }
  if ((tx - ogx) * dir < 0.3) tx = ogx + dir * 0.3;
  const d = Math.hypot(tx - p.x, ty - p.y);
  if (set && !(rush && d > 1)) {
    // set: no rushing in or out, but quick side-steps to stay on the angle
    // (closing a man down close in, he gets out there first, then sets)
    if (d < 0.2) p.im = 0; else setMove(p, tx - p.x, ty - p.y, Math.min(0.65, d));
  } else moveTo(p, tx, ty, rush ? 1.5 : 3.5, 0.12);
}

// ------------------------------------------------------------ entry

export function aiThink(w, p) {
  stand = p.human ? LEVELS[1] : null;
  p.ib = 0; p.im = 0;
  const m = w.m;
  if (m.phase === PHASE.KICKOFF || m.phase === PHASE.HALFTIME) return;
  if (p.st !== ST.IDLE && p.st !== ST.STUMBLE) return;
  if (p.aiT > 0) p.aiT--;
  if (m.phase === PHASE.GOAL || m.phase === PHASE.FULLTIME || m.phase === PHASE.SETPIECE) {
    if (p.role === ROLE.GK) {
      const pit = pitchOf(w), dir = teamDir(w, p.team);
      moveTo(p, -dir * (pit.L / 2 - 1), 0, 99, 0.5);
    } else {
      const [tx, ty] = slotTarget(w, p, m.phase === PHASE.SETPIECE && m.spTeam === p.team);
      moveTo(p, tx, ty, m.phase === PHASE.SETPIECE ? 6 : 99, 0.6);
    }
    return;
  }
  const c = analyse(w);
  if (p.role === ROLE.GK) { gkThink(w, p, c); return; }
  const b = w.ball;
  if (b.owner === p.id) { carrierThink(w, p); return; }
  if (p.ai === AI_CARRY) p.ai = 0;
  const owner = b.owner >= 0 ? pById(w, b.owner) : null;
  if (owner && owner.team === p.team) { supportThink(w, p, owner); return; }
  p.ai = 0;
  defendThink(w, p, c, owner);
}
