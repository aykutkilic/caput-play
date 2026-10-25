// AI for outfield players and keepers. Pure function of world state (plus the
// world's seeded RNG) so that clients predicting AI players get the same
// decisions as the server.

import { G, BTN, KT, KH, KICK_MASK, packKick, PHASE, ST, ROLE, SP, KICK, GKB, FOOT, JOG_TILT } from './constants.js';
import {
  rnd, teamDir, pitchOf, pById, stOf, startKick, beginDive, beginBlock1v1, blockKind, slotOf, slotIndex, shootingPractice,
  inOwnBox, clamp, encodeStick, ballPath, blockPlan, wantsBlock, loftTime,
  groundSpeedFor, passEndSpeed, MU, CF, byPerson, keeperBig, bigReach, exitPoint, keepInReach, footFor, footCurl, offsidePos,
  tiltFor, CHG_MAX,
} from './sim.js';
import { SHAPE, MARK } from './learned.js';
import { shotHole, aiReact, POST_IN } from './lanes.js';

const AI_CARRY = 1, AI_SUPPORT = 2, AI_PRESS = 3, AI_MARK = 4, AI_COVER = 5; // (a marker's man in aiY)
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
// he comes for a cross; bend: how much he bends a shot into a side of the
// goal (lanes.sideCurl, as his foot allows – Casual not at all); aimErr:
// how wayward his strikes are (as launch scales them).
const LEVELS = [
  { react: 18, spin: 0, misread: 0.8, think: 9, block: 0.04, sweep: 0.4, hold: 70, shuffle: false, angle: 0.9, smother: 1.1, read: false, spread: 99, spreadP: 0, misjudge: 0.12, claim: 6, bend: 0, aimErr: 1.6, aimNoise: 0.07, holdNoise: 4 },
  { react: 10, spin: 0.25, misread: 0.35, think: 5, block: 0.12, sweep: 0.2, hold: 45, shuffle: false, angle: 1, smother: 0.85, read: true, spread: 4, spreadP: 0.75, misjudge: 0.05, claim: 8, bend: 0.6, aimErr: 1, aimNoise: 0.035, holdNoise: 2 },
  { react: 6, spin: 0.45, misread: 0.12, think: 3, block: 0.3, sweep: 0.05, hold: 28, shuffle: true, angle: 1, smother: 0.7, read: true, spread: 2, spreadP: 0.9, misjudge: 0.015, claim: 10, bend: 0.85, aimErr: 0.75, aimNoise: 0.015, holdNoise: 1 },
];
// a lagging human's stand-in plays at the middle level, whatever the room's AI
let stand = null;
const lvlOf = (w) => stand || LEVELS[w.m.ai] || LEVELS[1];
function angDiffAI(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }

// A playing style for each AI player, the same every time for the same id:
// all-round; a dribbler (keeps it longer, carries it more); a passer (moves
// it on sooner, likes the pass); a shooter (a quicker trigger)
const STY = { ALL: 0, DRIBBLER: 1, PASSER: 2, SHOOTER: 3 };
export const styleOf = (p) => (byPerson(p) ? STY.ALL : ((p.id * 2654435761) >>> 0) % 4);
const CALM = 1.3, SHARP = 0.45; // s: an easy move into position (see moveTo); a sharp one

// The stick, as a player presses it: tilt 1 sprints, up to JOG_TILT jogs
// (see sim paceFor); sprint() – full tilt, if he has the legs for it
function setMove(p, dx, dy, mag) {
  const [a, m] = encodeStick(dx, dy, mag);
  p.ia = a; p.im = m;
}
const sprintTilt = (p, floor = 0.05) => (p.stam > floor ? 1 : JOG_TILT);
// A key tapped this tick (a slide, a block, a keep-in – the game acts on the
// press as it does for a person); it replaces any kick key held
function tapKey(p, target, kh = KH.GROUND) {
  p.ib = (p.ib & ~KICK_MASK & ~(3 << 3)) | packKick(target, kh);
}

// tau: no hurry – he goes at the pace that gets him there in about tau
// seconds (a walk when it's near, a jog when it's moved on a way), and only
// sprints when it's further than sprintDist and he has the legs for it (real
// players walk or stand half the time and sprint one per cent of it)
function moveTo(p, tx, ty, sprintDist = 6, arrive = 0.35, tau = 0) {
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
  if (d < arrive) { p.im = 0; return d; }
  // ease into position (no fixed walking pace that stops dead on arrival): a
  // tilt up to a jog – full tilt when he sprints
  const jog = JOG_TILT * (tau ? Math.min(1, d / tau / stOf(p).jog) : Math.min(1, Math.max(0.12, d / 2.2)));
  setMove(p, dx, dy, d > sprintDist && p.stam > (tau ? 0.6 : 0.2) ? 1 : jog);
  return d;
}

// Into position facing the ball when he's nearly there (side-steps, backing
// off – see the guard in the sim's movement); further off, a recovery run.
function guardTo(p, tx, ty, sprintDist, arrive, tau = 0) {
  const d = moveTo(p, tx, ty, sprintDist, arrive, tau);
  if (d < 5) p.ib |= BTN.R2;
  return d;
}

// The way from the ball at (bx, by) that splits the angle it sees between our
// posts: standing on it covers both corners alike.
function bisector(w, team, bx, by) {
  const pit = pitchOf(w), ogx = -teamDir(w, team) * pit.L / 2, hw = pit.goalW / 2;
  const l1 = Math.hypot(ogx - bx, -hw - by) || 1, l2 = Math.hypot(ogx - bx, hw - by) || 1;
  const kx = (ogx - bx) / l1 + (ogx - bx) / l2, ky = (-hw - by) / l1 + (hw - by) / l2, lk = Math.hypot(kx, ky) || 1;
  return [kx / lk, ky / lk];
}

// The spot on the man on the ball's shooting line (the bisector, or the way
// (kx, ky)), at least rMin ahead of him, that p gets to before he does – where
// a defender who isn't goal-side recovers to instead of chasing him from behind.
function coverPoint(w, p, owner, rMin, [kx, ky] = bisector(w, p.team, owner.x, owner.y)) {
  const pit = pitchOf(w), ogx = -teamDir(w, p.team) * pit.L / 2, dGoal = Math.hypot(owner.x - ogx, owner.y);
  const vAlong = Math.max(2, owner.vx * kx + owner.vy * ky), rMax = Math.max(1, dGoal - 1.2);
  let r = Math.min(rMin, rMax);
  while (r < rMax && reachTime(p, owner.x + kx * r, owner.y + ky * r) > r / vAlong) r += 0.5;
  r = Math.min(r, rMax);
  return [owner.x + kx * r, owner.y + ky * r];
}

// The parts of our goal (as y-ranges on the line) the outfield players (but
// `except`) hide from a shot at (bx, by): each body a ~0.8 m wide shadow.
function goalShadow(w, team, bx, by, except) {
  const pit = pitchOf(w), ogx = -teamDir(w, team) * pit.L / 2, hw = pit.goalW / 2, iv = [];
  for (const q of w.players) {
    if (q.team !== team || q === except || q.role === ROLE.GK || q.st === ST.FALLEN || q.st === ST.SLIDE) continue;
    const dx = q.x - bx, dy = q.y - by, d = Math.hypot(dx, dy);
    if (d < 0.5 || dx * (ogx - bx) <= 0 || Math.abs(dx) > Math.abs(ogx - bx)) continue; // not in the way
    const a = Math.atan2(dy, dx), h = Math.asin(Math.min(1, 0.4 / d));
    const ys = [a - h, a + h].map((t) => (Math.cos(t) * (ogx - bx) <= 0 ? Math.sign(Math.sin(t)) * 99 : by + Math.tan(t) * (ogx - bx)));
    iv.push([Math.max(-hw, Math.min(...ys)), Math.min(hw, Math.max(...ys))]);
  }
  return iv.filter(([a0, a1]) => a1 > a0).sort((p, q) => p[0] - q[0]);
}

// The biggest part of our goal (y0..y1) still open to a shot from (bx, by)
// with the outfield players (but `except`) in the way, and how much is hidden.
function openGap(w, team, bx, by, except) {
  const hw = pitchOf(w).goalW / 2, sh = goalShadow(w, team, bx, by, except);
  let cur = -hw, g0 = -hw, g1 = -hw, hid = 0;
  for (const [a0, a1] of sh) { if (a0 - cur > g1 - g0) { g0 = cur; g1 = a0; } hid += Math.max(0, a1 - Math.max(a0, cur)); cur = Math.max(cur, a1); }
  if (hw - cur > g1 - g0) { g0 = cur; g1 = hw; }
  return { g0, g1, hid: hid / (2 * hw) };
}

// Where a defender stands to hide as much of the goal as he can: on the
// line splitting the part of it the shooter still sees, r metres out from him.
function laneSpot(w, p, owner, r) {
  const pit = pitchOf(w), ogx = -teamDir(w, p.team) * pit.L / 2;
  const { g0, g1 } = openGap(w, p.team, owner.x, owner.y, p);
  if (g1 - g0 < 0.3) return coverPoint(w, p, owner, r);
  const l0 = Math.hypot(ogx - owner.x, g0 - owner.y) || 1, l1 = Math.hypot(ogx - owner.x, g1 - owner.y) || 1;
  const kx = (ogx - owner.x) / l0 + (ogx - owner.x) / l1, ky = (g0 - owner.y) / l0 + (g1 - owner.y) / l1, lk = Math.hypot(kx, ky) || 1;
  return coverPoint(w, p, owner, r, [kx / lk, ky / lk]);
}

// ------------------------------------------------------------ per-tick analysis

function predictPath(w) {
  const b = w.ball;
  if (b.owner >= 0) {
    // (the same points every tick, refilled – it's only looked at this tick)
    const o = pById(w, b.owner), path = w._pp || (w._pp = Array.from({ length: PATH_N + 1 }, () => ({ x: 0, y: 0, z: 0 })));
    for (let k = 0; k <= PATH_N; k++) {
      const t = Math.min(k * 0.1, 0.8), q = path[k];
      q.x = b.x + (o ? o.vx : 0) * t; q.y = b.y + (o ? o.vy : 0) * t; q.z = b.z;
    }
    return path;
  }
  const path = [];
  const pts = ballPath(w);
  for (let k = 0; k <= PATH_N; k++) path.push(pts[Math.min(pts.length - 1, k * 3)]);
  return path;
}

function intercept(p, path, top = 2.2, vmax = 0) {
  const s = stOf(p), v0 = Math.hypot(p.vx, p.vy), vm = vmax || s.sprint;
  for (let k = 0; k < path.length; k++) {
    const t = k * 0.1, q = path[k];
    const reach = (t < 0.2 ? v0 * t : v0 * 0.2 + vm * (t - 0.2) * 0.92) + 0.45, dx = q.x - p.x, dy = q.y - p.y;
    if (dx * dx + dy * dy <= reach * reach && q.z < top) return { t, x: q.x, y: q.y, z: q.z };
  }
  const q = path[path.length - 1];
  return { t: 9, x: q.x, y: q.y, z: q.z };
}

function analyse(w) {
  let c = w._aic;
  if (c && c.tick === w.tick && c.w === w) return c;
  c = { w, tick: w.tick, path: predictPath(w), ic: new Map(), chaser: [-1, -1], presser: [-1, -1], mark: new Map(), cover: [-1, -1], coverAt: [null, null] };
  w._aic = c;
  const b = w.ball, pit = pitchOf(w);
  const owner = b.owner >= 0 ? pById(w, b.owner) : null;
  // when the ball last changed sides (the moment after winning it: lossCost)
  if (owner && owner.team !== w._possTeam) { w._possTeam = owner.team; w._possTick = w.tick; }
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
        if (p.ai === AI_PRESS) d -= 1.5; // the man already on him stays on him
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
          const d = Math.hypot(p.x - o.x, p.y - o.y) - (p.ai === AI_MARK && p.aiY === o.id ? 2 : 0); // (sticking with his man)
          if (d < bmd) { bmd = d; bm = p; }
        }
        if (!bm) break;
        used.add(bm.id); c.mark.set(bm.id, o.id);
      }
      // Cover: with one of us on him (within 5 m) away from our goal, the next
      // of us sits goal-side of the presser on the carrier's way to our goal,
      // as far off as real sides' second man (7 m in midfield, 8.6 in their
      // third – SkillCorner) – one with no man to mark, or whose man is out of
      // the play (further from our goal than the ball); near our goal the man
      // hiding the shot does it
      const dG = Math.hypot(owner.x - ogx, owner.y);
      if (Math.min(bd, hd) < 5 && dG >= 26) {
        const [kx, ky] = bisector(w, team, owner.x, owner.y);
        const r = Math.min(owner.x * dir > pit.L / 6 ? 8.6 : 7, 0.4 * dG), cx = owner.x + kx * r, cy = owner.y + ky * r;
        let cv = null, cd = 18;
        for (const p of markers) {
          const mo = c.mark.has(p.id) ? pById(w, c.mark.get(p.id)) : null;
          if (p.st === ST.FALLEN || (mo && Math.hypot(mo.x - ogx, mo.y) < dG + 2)) continue;
          const d = Math.hypot(p.x - cx, p.y - cy) - (p.ai === AI_COVER ? 2 : 0);
          if (d < cd) { cd = d; cv = p; }
        }
        if (cv) { c.cover[team] = cv.id; c.coverAt[team] = [cx, cy]; c.mark.delete(cv.id); }
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
// Racing several to a spot, the best time so far can be passed as cap: whoever
// couldn't beat it even sprinting all the way is out of it (Infinity) without
// working it out – the race comes out the same, for a fraction of the work.
function reachTime(q, x, y, cap = Infinity) {
  const s = stOf(q);
  const dx = x - q.x, dy = y - q.y;
  const busy = q.st !== ST.IDLE && q.st !== ST.STUMBLE ? Math.max(0, q.stDur - q.stT) / 60 : 0;
  const rr = q.role === ROLE.GK ? 1.0 : 0.6, R = rr + s.sprint * (cap - 0.18 - busy);
  if (R > rr && dx * dx + dy * dy >= R * R) return Infinity;
  const dl = Math.hypot(dx, dy), d = dl - rr;
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
const OPPS = [];
function passOdds(w, team, x0, y0, x1, y1, kind, kh, pw, recv) {
  const d = Math.hypot(x1 - x0, y1 - y0) || 0.01, ux = (x1 - x0) / d, uy = (y1 - y0) / d;
  let tEnd = 0, margin = 9;
  const opps = OPPS;
  opps.length = 0;
  for (const o of w.players) if (o.team !== team && o.st !== ST.FALLEN) opps.push(o);
  if (kh === KH.GROUND) {
    const v0 = groundSpeedFor(d, passEndSpeed(kind, d, pw)), K = MU / CF;
    for (let t = 0.07; ; t += 0.07) {
      const sd = Math.min(d, (v0 + K) * (1 - Math.exp(-CF * t)) / CF - K * t);
      const px = x0 + ux * sd, py = y0 + uy * sd;
      for (const o of opps) {
        // a keeper can only use his hands in his box
        if (o.role === ROLE.GK && !inOwnBox(w, o.team, px, py, 0)) continue;
        margin = Math.min(margin, reachTime(o, px, py, margin + t) - t);
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
        margin = Math.min(margin, reachTime(o, px, py, margin + t) - t);
      }
    }
    const late = tEnd - (kh === KH.HIGH ? -0.15 : 0);
    for (const o of opps) margin = Math.min(margin, reachTime(o, x1, y1, margin + late) - late);
  }
  let tOpp = 9;
  for (const o of opps) tOpp = Math.min(tOpp, reachTime(o, x1, y1, tOpp));
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
// (just won it – the last 1.5 s – the other side is all around: anything
// risky costs more, wherever it's lost – real sides secure it first; under a
// third of their first passes go forward)
function lossCost(w, team, x) {
  const pit = pitchOf(w), dir = teamDir(w, team), fresh = w._possTeam === team && w.tick - w._possTick < 90 ? 0.06 : 0;
  return 0.04 + 0.16 * clamp(1 - (x * dir + pit.L / 2) / pit.L, 0, 1) + fresh;
}

// Rough chance a shot from p scores: the goal mouth he can see, the distance,
// someone in the way, someone on him – put on the scale of what goes in:
// fitted to ~1,500 shots in our own AI matches (goal ~ logistic in the logit
// of the geometry's figure), the long ones score more often than the geometry
// says and the best chances less. (Steeper fits make the AI shoot so much it
// scores less.)
const XG_A = -0.28, XG_B = 0.666;
function shotChance(w, p) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), gx = dir * pit.L / 2;
  const fx = (gx - p.x) * dir;
  if (fx < 1) return 0;
  const ang = Math.abs(Math.atan2(pit.goalW / 2 - p.y, fx) - Math.atan2(-pit.goalW / 2 - p.y, fx));
  let xg = 0.9 * ang * Math.exp(-Math.hypot(gx - p.x, p.y) / 9);
  if (laneBlocked(w, p.team, p.x, p.y, gx, 0, 0.7)) xg *= 0.5;
  if (openness(w, p.team, p.x, p.y) < 1.3) xg *= 0.75;
  const q = clamp(xg, 0.002, 0.99);
  return 1 / (1 + Math.exp(-(XG_A + XG_B * Math.log(q / (1 - q)))));
}

// The best pass by expected value: to feet, into the space ahead of a runner,
// or lofted (chest-high / head-high) when the ground route is shut – each
// candidate raced against the defenders.
// When a ball played d m gets there: in the air its planned flight, along the
// ground the roll (rolled out of a keeper's hands it can't be as quick).
function arrival(kh, d, pw, fromHands) {
  if (kh !== KH.GROUND) return loftTime(d, kh, pw);
  const v0 = Math.min(groundSpeedFor(d, passEndSpeed(KICK.PASS, d, pw)), fromHands ? 17 : 28), K = MU / CF;
  for (let t = 0.05; t < 5; t += 0.05) if ((v0 + K) * (1 - Math.exp(-CF * t)) / CF - K * t >= d) return t;
  return 5;
}
// Where to play it to a team-mate on the move: where he'll be when it gets
// there – a person led a little less (he may stop or turn; the receive assist
// takes him the rest of the way)
function leadTo(w, p, q, kh, pw) {
  const b = w.ball, k = byPerson(q) ? 0.7 : 0.8, hands = b.held === 1 && b.owner === p.id;
  let tx = q.x, ty = q.y;
  for (let i = 0; i < 3; i++) {
    const T = arrival(kh, Math.hypot(tx - b.x, ty - b.y), pw, hands);
    tx = q.x + q.vx * T * k; ty = q.y + q.vy * T * k;
  }
  return [tx, ty];
}

function bestPass(w, p, forPeople = 0.08) {
  const dir = teamDir(w, p.team), b = w.ball, pit = pitchOf(w);
  const gx = dir * pit.L / 2;
  const wide = Math.abs(p.y) > pit.boxW / 2 - 3 && (gx - p.x) * dir < pit.boxD + 10;
  // back to the keeper only as the very last way out: with a man right on him
  let tPress = 9;
  for (const o of w.players) if (o.team !== p.team) tPress = Math.min(tPress, reachTime(o, p.x, p.y, tPress));
  const cornered = tPress < 0.45;
  let best = null;
  const consider = (t, kind, kh, pw, tx, ty) => {
    tx = clamp(tx, -pit.L / 2 + 0.8, pit.L / 2 - 0.8); ty = clamp(ty, -pit.W / 2 + 0.8, pit.W / 2 - 0.8);
    const odds = passOdds(w, p.team, b.x, b.y, tx, ty, kind, kh, pw, t);
    let v = odds * spotValue(w, p.team, tx, ty) - (1 - odds) * lossCost(w, p.team, (b.x + tx) / 2);
    if (byPerson(t)) v += forPeople * odds;   // give it to the people playing
    // forwards rather than back: ground gained counts a little
    v += 0.015 * odds * clamp((tx - b.x) * dir / 12, 0, 1.5);
    if (t.role === ROLE.GK) v -= 0.3;
    // no playing it back and forth: straight back to the man who just passed
    // it only if it gets well forward of where he played it from; and after a
    // couple of passes going nowhere, sideways and back count against a pass
    // and forward for it – a move has to go somewhere
    if (b.pft === p.team && b.pf === t.id && (tx - b.pfx) * dir < 6) v -= 0.12;
    if (b.pft === p.team && b.stale >= 2) {
      const fwd = (tx - b.x) * dir, k = Math.min(b.stale, 5);
      v += fwd < 3 ? -0.025 * k : 0.01 * k * clamp(fwd / 10, 0, 1);
    }
    // the keeper doesn't give it to a man who has an opponent on him: he'd be
    // closed down as it gets to him, in front of goal
    if (p.role === ROLE.GK) {
      let dO = 9;
      for (const o of w.players) if (o.team !== p.team) dO = Math.min(dO, Math.hypot(o.x - tx, o.y - ty));
      if (dO < 5) v -= 0.2 * (5 - dO) / 5;
    }
    if (!best || v > best.v) best = { t, kind, kh, pw, tx, ty, v, odds };
  };
  for (const t of w.players) {
    if (t === p || t.team !== p.team || t.st === ST.FALLEN || t.st === ST.SLIDE) continue;
    if (t.role === ROLE.GK && p.role !== ROLE.GK && !cornered) continue;
    if (w.m.offs && offsidePos(w, p.team, t, w.ball.x)) continue; // (offside: not to a man beyond their line)
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

// A curve learned over the ball's depth: values at the middles of equal bins
// from our goal line (-1) to theirs (+1), straight lines in between.
function overDepth(v, X) {
  const n = v.length, f = clamp((X + 1) / 2 * n - 0.5, 0, n - 1), i = Math.min(n - 2, Math.floor(f));
  return v[i] + (v[i + 1] - v[i]) * (f - i);
}
// A table learned over a man's distance to goal (rows, at MARK.g m) and to
// the ball (columns, at MARK.b m), straight lines in between.
function along(E, v) {
  if (v <= E[0]) return 0;
  for (let i = 0; i < E.length - 1; i++) if (v < E[i + 1]) return i + (v - E[i]) / (E[i + 1] - E[i]);
  return E.length - 1;
}
function overGrid(t, dGoal, dBall) {
  const fi = along(MARK.g, dGoal), fj = along(MARK.b, dBall);
  const i = Math.min(t.length - 2, Math.floor(fi)), j = Math.min(t[0].length - 2, Math.floor(fj)), di = fi - i, dj = fj - j;
  return (t[i][j] * (1 - dj) + t[i][j + 1] * dj) * (1 - di) + (t[i + 1][j] * (1 - dj) + t[i + 1][j + 1] * dj) * di;
}
// The formation slots of a side of n, standardised (mean 0, spread 1 along
// and across) so the learned spread sizes them.
const slotZs = new Map();
function slotZ(n, i) {
  let z = slotZs.get(n);
  if (!z) {
    const s = Array.from({ length: n }, (_, j) => slotOf(n, j));
    const norm = (k) => {
      const mu = s.reduce((t, q) => t + q[k], 0) / n, sd = Math.sqrt(s.reduce((t, q) => t + (q[k] - mu) * (q[k] - mu), 0) / n);
      return s.map((q) => (sd > 1e-6 ? (q[k] - mu) / sd : 0));
    };
    const za = norm(0), zb = norm(1);
    z = s.map((_, j) => [za[j], zb[j]]);
    slotZs.set(n, z);
  }
  return z[i % n];
}

function slotTarget(w, p, attacking) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), b = w.ball, m = w.m;
  const [i, n] = slotIndex(w, p);
  const hx = pit.L / 2, hy = pit.W / 2;
  // the shape real sides keep (learned from broadcast tracking of league
  // matches, see learned.js): where its middle is and how far it spreads,
  // along and across, for where the ball is – with and without it. His
  // formation slot says where in that shape he stands.
  const sh = attacking ? SHAPE.ip : SHAPE.op, X = clamp(b.x * dir / hx, -1, 1);
  const [za, zb] = slotZ(Math.max(1, n), Math.max(0, i));
  let x = dir * (overDepth(sh.cx, X) + za * overDepth(sh.sx, X)) * hx;
  if (!attacking && (x - b.x) * dir > -1.5) x = b.x - dir * 1.5;
  let y = sh.cyk * b.y + zb * overDepth(sh.sy, X) * hy;
  // corners: attackers crowd the box, defenders track back
  if (m.phase !== PHASE.KICKOFF && m.spType === SP.CORNER && (m.phase === PHASE.SETPIECE || m.spTaker >= 0)) {
    const sdir = teamDir(w, m.spTeam), gx = sdir * hx, [, sb] = slotOf(Math.max(1, n), Math.max(0, i));
    x = gx - sdir * (pit.penSpot * (0.6 + 0.5 * ((i % 3) / 2)));
    y = sb * pit.boxW * 0.3;
  }
  return [clamp(x, -hx + 1.5, hx - 1.5), clamp(y, -hy + 1.2, hy - 1.2)];
}

// A kick, as a player plays it (the AI presses the same keys a person does):
// the stick pointed at where it's to go – the team-mate (the game's own
// targeting picks him and leads him), or the spot in the goal (its holes) –
// the key for it (team-mate / run / goal, the row for the height; R2 for a
// finesse) held for as long as the power needs, then let go. From the
// keeper's hands: the goal key punts it, the team-mate key rolls it (ground)
// or throws it. How true the stick is and how well the hold is timed is his
// level's skill (aimNoise, holdNoise). See driveKey for the pressing.
function aiKick(w, p, kind, power, tx, ty, tid = -1, kh) {
  const b = w.ball, m = w.m, lv = lvlOf(w);
  const held = b.held && b.owner === p.id;
  let target, r2 = false;
  if (held) {
    if (m.spTaker === p.id) { target = KT.MATE; if (kind !== KICK.LONG && (kh === undefined || kh === KH.GROUND)) kh = KH.GROUND; else if (kh === KH.GROUND || kh === undefined) kh = KH.MID; }
    else if (kind === KICK.PUNT || ((kind === KICK.LONG || kind === KICK.CLEAR) && Math.hypot(tx - b.x, ty - b.y) > 50)) { target = KT.GOAL; kh = KH.HIGH; }
    else { target = KT.MATE; if (kh === undefined) kh = KH.GROUND; }
  } else if (kind === KICK.SHOT || kind === KICK.FINESSE) { target = KT.GOAL; r2 = kind === KICK.FINESSE; }
  else if (kind === KICK.THROUGH) target = KT.RUN;
  else if (kind === KICK.LONG || kind === KICK.CLEAR || kind === KICK.PUNT) { target = KT.GOAL; kh = KH.HIGH; power = Math.max(power, 0.85); } // (a hoof upfield: the shot key)
  else if (kind === KICK.SELF) target = KT.SELF;
  else target = KT.MATE;
  if (kh === undefined) kh = target === KT.GOAL ? KH.MID : KH.GROUND;
  // where the stick points: at the man (where he is – the pass is led for
  // his run), at the spot – or for a shot, across to the side of the goal
  // it's to go in (as a player aims one: the further across, the further out)
  const r = tid >= 0 && tid !== p.id ? pById(w, tid) : null;
  let ax = (r ? r.x : tx) - b.x, ay = (r ? r.y : ty) - b.y;
  if (target === KT.GOAL && !held) {
    const pit = pitchOf(w), dir = teamDir(w, p.team), half = pit.goalW / 2 - POST_IN, gx = dir * pit.L / 2;
    const lat = Math.abs(ty) < 0.35 * half ? 0 : Math.sign(ty * dir) * clamp(0.7 * Math.abs(ty) / half, 0.3, 1);
    // (across the way he faces the goal from the ball: his right is 90° anticlockwise of it)
    const fl = Math.hypot(gx - b.x, b.y) || 1, fx = (gx - b.x) / fl, fy = -b.y / fl, f = Math.sqrt(1 - lat * lat);
    ax = fx * f - fy * lat; ay = fy * f + fx * lat;
  }
  const ang = Math.atan2(ay, ax) + skillNoise(w) * lv.aimNoise;
  const [a] = encodeStick(Math.cos(ang), Math.sin(ang), 1);
  // the hold: the gauge fills 1 a tick (a shot half as fast again) – with
  // the ball at his feet only as long as he has before a man's on him
  const fill = target === KT.GOAL ? 1.5 : 1;
  let room = Math.ceil(CHG_MAX / fill);
  if (b.owner === p.id && !held) { let t = 9; for (const o of w.players) if (o.team !== p.team) t = Math.min(t, reachTime(o, b.x, b.y, t)); room = Math.min(room, Math.max(4, Math.floor(t * 60 * 0.75))); }
  const hold = clamp(Math.round(power * CHG_MAX / fill + skillNoise(w) * lv.holdNoise), 1, room);
  p.akK = packKick(target, kh); p.akN = hold; p.akA = a; p.akR = r2 ? 1 : 0;
  // (the stick held on it as he charges: he runs that way at the pace he's
  // going – a man running in on goal keeps running, bending his run to the
  // aim, as a player does; turned back the other way, a walk)
  const v = Math.hypot(p.vx, p.vy), al = v > 1.5 ? (p.vx * Math.cos(ang) + p.vy * Math.sin(ang)) / v : 0;
  p.akM = al > -0.2 ? Math.max(6, Math.round(tiltFor(p, v) * 15)) : 6;
  driveKey(w, p);
}
// (a deterministic, roughly normal number, mean 0, sd ~1)
function skillNoise(w) { return (rnd(w) + rnd(w) + rnd(w) - 1.5) * 2; }

// Pressing the keys of a kick under way (p.akK: the key; akN: ticks still to
// hold it; akA, akM: the stick; akR: R2), then let go – the game fires the
// kick from the gauge. (After it the stick stays barely tilted while the
// aftertouch a player has could bend it – see aiThink.) Lost the ball (or
// the one he was waiting for went elsewhere): he lets go. Returns whether
// the keys are taken this tick.
function driveKey(w, p) {
  const b = w.ball, m = w.m;
  if (p.akK) {
    const owner = b.owner >= 0 ? pById(w, b.owner) : null;
    const playing = m.phase === PHASE.PLAY || m.phase === PHASE.WARMUP || (m.phase === PHASE.SETPIECE && m.spTaker === p.id);
    if ((owner && owner !== p) || !playing) { p.akK = 0; p.akN = 0; return false; }
    p.ia = p.akA; p.im = p.akM;
    if (p.akN > 0) { p.ib = p.akK | (p.akR ? BTN.R2 : 0); p.akN--; return true; }
    // let go (a tick with the key up – R2 still on for a finesse): the gauge fires it
    p.ib = p.akR ? BTN.R2 : 0; p.akK = 0;
    return true;
  }
  return false;
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
  const range = Math.min(24, pit.L * 0.38);
  const pw = clamp(0.4 + dGoal / range * 0.45 + (rnd(w) - 0.5) * 0.12, 0.3, 0.88);
  // the holes in the goal at each height – where neither the keeper nor a man
  // in the way gets to it first, weighed by how sure he is to hit the target
  // there – and the bend that finds it (as much as his level has)
  const lv = lvlOf(w), err = (0.035 + 0.0016 * dGoal + 0.00011 * dGoal * dGoal + 0.06 * pw * pw) * lv.aimErr;
  let best = null;
  for (const kh of [KH.GROUND, KH.MID, KH.HIGH]) {
    const h = shotHole(w, p, KICK.SHOT, kh, pw, err, null, (ty) => footCurl(w, p, ty, pw, lv.bend));
    if (h && (!best || h.score > best.score)) best = { ...h, kh };
  }
  if (best) return { kind: KICK.SHOT, kh: best.kh, pw, aimY: best.ty, kc: best.kc, kf: footFor(p, best.kc) };
  const r = rnd(w);
  return { kind: KICK.SHOT, kh: r < 0.5 ? KH.GROUND : r < 0.82 ? KH.MID : KH.HIGH, pw, aimY };
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
    if (r && r.team === p.team && !(w.m.offs && offsidePos(w, p.team, r, b.x))) {
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
    for (const o of w.players) if (o.team !== p.team) tPress = Math.min(tPress, reachTime(o, p.x, p.y, tPress));
    const safe = 1 / (1 + Math.exp(-(tPress - 0.5) / 0.12));
    const sty = styleOf(p);
    const keep = safe * spotValue(w, p.team, p.x + dir * 3 * safe, p.y * 0.9) * (sty === STY.DRIBBLER ? 1.15 : 1) - (1 - safe) * lossCost(w, p.team, p.x);
    const xg = dGoal < 30 ? shotChance(w, p) : 0;
    const bp = bestPass(w, p);
    const passV = bp ? bp.v + (p.aiX > 150 ? 0.1 : 0) + (sty === STY.PASSER ? 0.006 : 0) : -1;
    // a weaker AI misjudges a little
    const noise = (rnd(w) - 0.5) * lv.misjudge;
    // players like to shoot: a small bias, growing the longer the move goes on
    const urge = 0.025 + Math.min(0.04, p.aiX / 4000) + (sty === STY.SHOOTER ? 0.015 : 0);
    if (xg > 0.04 && xg + urge + noise >= Math.max(passV, keep)) {
      const sh = aimShot(w, p);
      aiKick(w, p, sh.kind, sh.pw, gx, sh.aimY, -1, sh.kh, sh.kc || 0);
      return;
    }
    // with room he takes a touch or two before he lets it go – real players
    // keep it ~1-2 s when they have space (SkillCorner): no pass till he's
    // had it ~1 s, unless he's pressed or it's a far better ball
    const settle = safe > 0.7 && p.aiX < 30 + 35 * safe + (sty === STY.DRIBBLER ? 10 : sty === STY.PASSER ? -15 : 0) && passV < keep + 0.06;
    if (bp && !settle && passV + noise > keep + 0.01) {
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

// Off-ball movement. Every quarter to half a second a supporting player looks
// at spots around his formation slot, runs in behind, into the channels and
// into the space ahead of the ball, and picks the most useful: one he gets to
// before any defender (pitch control), that the carrier can find with a pass
// (pass odds), worth having the ball in (spot value), in space, not crowding
// a team-mate and not too far from his slot – the man nearest the ball comes
// to show for it at an angle. The current target gets a small bonus so he
// doesn't dither between similar spots.
const ADDS = [];
function finishScore(sc, adds) {
  for (const a of adds) sc += a;
  return sc;
}
function supportThink(w, p, owner) {
  const pit = pitchOf(w), dir = teamDir(w, p.team);
  const hx = pit.L / 2 - 1.5, hy = pit.W / 2 - 1.2;
  if (p.ai !== AI_SUPPORT) { p.ai = AI_SUPPORT; p.aiT = 0; p.aiX = p.x; p.aiY = p.y; p.aiS = null; }
  if (p.aiT === 0) {
    p.aiT = 14 + Math.floor(rnd(w) * 16);
    const [sx, sy] = slotTarget(w, p, true);
    // the opponents' last line (deepest outfield defender)
    let line = -dir * 1e9;
    for (const o of w.players) if (o.team !== p.team && o.role === ROLE.OUT && (o.x - line) * dir > 0) line = o.x;
    const [, n] = slotIndex(w, p);
    // (keeping his spot is worth a little: as much as keeps him on the move
    // about half the time, as real players without the ball are)
    const cands = [[p.aiX, p.aiY, 0.01], [sx, sy, 0]];
    // offside on: no use beyond their second-last man (or the ball) – he
    // waits on the shoulder of it, to run in behind as the ball's played
    let offX = null;
    if (w.m.offs) {
      let a = -Infinity, c2 = -Infinity;
      for (const o of w.players) { if (o.team === p.team) continue; const dd = o.x * dir; if (dd > a) { c2 = a; a = dd; } else if (dd > c2) c2 = dd; }
      offX = Math.max(c2, owner.x * dir) * dir;
      cands.push([offX - dir * 0.6, clamp(p.y, -hy, hy), 0]);
    }
    const a0 = rnd(w) * TAU;
    for (let k = 0; k < 10; k++) {
      const a = a0 + k / 10 * TAU, r = k % 2 ? 4.5 : 9;
      cands.push([sx + Math.cos(a) * r, sy + Math.sin(a) * r, 0]);
    }
    // runs in behind / into the channel ahead of the ball, and showing short
    for (const off of [-8, 0, 8]) cands.push([line + dir * 3, clamp(p.y + off, -hy, hy), 0]);
    cands.push([owner.x + dir * 12, clamp(owner.y + (p.y > owner.y ? 9 : -9), -hy, hy), 0]);
    cands.push([owner.x + dir * 2, clamp(owner.y + (p.y > owner.y ? 7 : -7), -hy, hy), 0]);
    // into the space ahead of the ball, between their men
    for (const [ax, ay] of [[7, -6], [7, 6], [14, -4], [14, 4], [10, 0]]) cands.push([owner.x + dir * ax, clamp(p.y + ay, -hy, hy), 0]);
    // (is he the team-mate nearest the man on the ball?)
    let nearest = true;
    const dMe = Math.hypot(p.x - owner.x, p.y - owner.y);
    for (const q of w.players) if (q !== p && q !== owner && q.team === p.team && q.role !== ROLE.GK && Math.hypot(q.x - owner.x, q.y - owner.y) < dMe) nearest = false;
    // In their third the nearest supports him – somewhere 6-13 m off him,
    // never miles away in the box (real sides keep a man ~9-11 m off the
    // ball there; SkillCorner): a ring of spots round him
    const support = nearest && owner.x * dir > pit.L / 6;
    if (support) for (let k = 0; k < 8; k++) { const a = a0 + k / 8 * TAU; cands.push([owner.x + Math.cos(a) * 9, owner.y + Math.sin(a) * 9, 0]); }
    let best = null, bestS = -1e9;
    for (const [cx0, cy0, bonus] of cands) {
      const cx = clamp(cx0, -hx, hx), cy = clamp(cy0, -hy, hy);
      const d = Math.hypot(cx - owner.x, cy - owner.y);
      if (d < 4 || (support && (d < 6 || d > 13))) continue;
      // who controls that spot when he gets there
      const tMe = reachTime(p, cx, cy);
      let tOpp = 9;
      for (const o of w.players) if (o.team !== p.team) tOpp = Math.min(tOpp, reachTime(o, cx, cy, tOpp));
      const control = 1 / (1 + Math.exp(-(tOpp - tMe) / 0.3)), spot = spotValue(w, p.team, cx, cy);
      // the rest of the score, in order:
      const adds = ADDS;
      adds.length = 0;
      // empty space: the further from their nearest man, the better
      let open = 9;
      for (const o of w.players) if (o.team !== p.team && o.role === ROLE.OUT) open = Math.min(open, Math.hypot(o.x - cx, o.y - cy));
      adds.push(0.002 * clamp(open - 2, 0, 5));
      // the man nearest the ball shows for it: an angle 6-14 m off the carrier
      // (with no going back to the keeper, he's the way out under pressure)
      if (nearest && d >= 6 && d <= 14) adds.push(0.06);
      adds.push(-(0.004 * Math.max(0, d - 26)));
      for (const q of w.players) {
        if (q === p || q === owner || q.team !== p.team || q.role === ROLE.GK) continue;
        const qx = q.ai === AI_SUPPORT ? q.aiX : q.x, qy = q.ai === AI_SUPPORT ? q.aiY : q.y;
        const dq = Math.hypot(cx - qx, cy - qy);
        if (dq < 7) adds.push(-((7 - dq) * 0.006));
      }
      adds.push(-(Math.hypot(cx - sx, cy - sy) * (n > 3 ? 0.003 : 0.0015)));
      // waiting behind the last defender is no use until the ball is played
      if ((cx - line) * dir > 4) adds.push(-0.05);
      if (offX !== null && (cx - offX) * dir > -0.2) adds.push(-0.3);
      // (if even a pass sure to get there can't beat the best spot so far,
      // the odds needn't be worked out)
      if (!(finishScore(control * (0.4 + 0.6 * 1) * spot + bonus, adds) > bestS)) continue;
      const odds = passOdds(w, p.team, owner.x, owner.y, cx, cy, KICK.PASS, d > 22 ? KH.MID : KH.GROUND, 0.5, null);
      const sc = finishScore(control * (0.4 + 0.6 * odds) * spot + bonus, adds);
      if (sc > bestS) { bestS = sc; best = [cx, cy]; }
    }
    if (best) { p.aiX = best[0]; p.aiY = best[1]; }
    // (supporting him, the spot goes where he goes: kept as an offset)
    p.aiS = support ? [p.aiX - owner.x, p.aiY - owner.y] : null;
  }
  if (p.aiS) { p.aiX = clamp(owner.x + p.aiS[0], -hx, hx); p.aiY = clamp(owner.y + p.aiS[1], -hy, hy); }
  // a run in behind (or onto their line) while the man on the ball has the
  // time to play it: flat out; anything else – coming short, moving across
  // into space, a run he can't be found on yet – at a jog
  const run = (p.aiX - p.x) * dir > 4;
  let line = -dir * 1e9, press = 99;
  for (const o of w.players) {
    if (o.team === p.team) continue;
    if (o.role === ROLE.OUT && (o.x - line) * dir > 0) line = o.x;
    press = Math.min(press, Math.hypot(o.x - owner.x, o.y - owner.y));
  }
  if (run && (p.aiX - line) * dir > -2 && press > 2.5) moveTo(p, p.aiX, p.aiY, 3, 0.6);
  else if (p.aiS) moveTo(p, p.aiX, p.aiY, 6, 0.6, SHARP); // (supporting the man on the ball in their third)
  else moveTo(p, p.aiX, p.aiY, run ? 10 : 12, 0.6, run ? 0.9 : CALM);
}

function defendThink(w, p, c, owner) {
  const b = w.ball, pit = pitchOf(w), dir = teamDir(w, p.team);
  // a hard opposing shot / pass coming past: throw a leg or the body at it
  if (!owner && wantsBlock(w, p) && rnd(w) < lvlOf(w).block) {
    const plan = blockPlan(w, p);
    if (plan && plan.t < 0.45) { tapKey(p, KT.RUN); return; } // (a kick key as it comes: the block – see the sim's buttons)
  }
  if (!owner) {
    const ic = c.ic.get(p.id);
    if (c.chaser[p.team] === p.id || b.tgt === p.id) {
      // a pass meant for him: meet it where it can be controlled (chest height
      // at most), not where it could only be headed on
      const mc = b.tgt === p.id && b.lastTeam === p.team ? intercept(p, c.path, 1.4) : ic;
      const go = mc.t < 9 ? mc : ic;
      // a ball along the ground and one of them close behind him in getting
      // to it: a race – flat out to the first point he can reach (it moves up
      // towards the ball as he closes), to touch it first rather than wait
      // for it to slow down (in the air he still gets under it and times it)
      let tOpp = 9;
      if (b.z < 0.5 && Math.abs(b.vz) < 2) for (const o of w.players) if (o.team !== p.team && o.st !== ST.FALLEN) tOpp = Math.min(tOpp, c.ic.get(o.id).t);
      // ours to lose (we touched it last) and on its way out: keep it in – a
      // slide to hook it back when it's just going, flat out to it before
      const out = b.lastTeam === p.team && p.role === ROLE.OUT ? exitPoint(w) : null;
      if (out && keepInReach(w, p) && Math.hypot(b.x - p.x, b.y - p.y) > 1.2) { tapKey(p, KT.GOAL); return; } // (the slide key at a ball going out: kept in)
      if (out && (go.t >= out.t - 0.05 || go.t >= 9)) {
        if (out.t < 2.5) {
          setMove(p, out.x - p.x, out.y - p.y, sprintTilt(p));
          return;
        }
      }
      if (go.t < 9 && tOpp < go.t + 0.6) {
        setMove(p, go.x - p.x, go.y - p.y, sprintTilt(p));
      } else {
        // a loose ball no one else is near: no race – he jogs to where he'll
        // meet it, in time (a pass to him is run onto as it was played: it's
        // led for him to get there)
        let tAny = 9;
        for (const o of w.players) if (o.team !== p.team && o.st !== ST.FALLEN) tAny = Math.min(tAny, c.ic.get(o.id).t);
        const gj = go.t < 9 && tAny > go.t + 1 && !(b.tgt === p.id && b.lastTeam === p.team) ? intercept(p, c.path, 2.2, stOf(p).jog) : null;
        if (gj && gj.t < 9 && gj.t + 0.5 < tAny) moveTo(p, gj.x, gj.y, 99, 0.05, Math.max(0.3, gj.t));
        else moveTo(p, go.x, go.y, go.t > 0.5 ? 2 : 99, 0.05);
      }
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (!p.qa && !p.akK && d < 7) {
        // first time, as a player does it: the key pressed as it comes (held
        // for the power, let go – it's struck as it arrives)
        const gx = dir * pit.L / 2, dGoal = Math.hypot(gx - p.x, p.y);
        const airborne = b.z > 0.5 || b.vz > 1;
        // a pass meant for him is controlled; a first-time finish only off a
        // ball along the ground, or anything right in front of goal – into
        // the side the keeper isn't on
        const meant = b.tgt === p.id && b.lastTeam === p.team;
        if (dGoal < 16 && (gx - p.x) * dir > 1 && (!meant || !airborne || dGoal < 9)) {
          const gk = w.players.find((q) => q.team !== p.team && q.role === ROLE.GK);
          aiKick(w, p, KICK.SHOT, 0.5 + rnd(w) * 0.3, gx, (gk && gk.y > 0 ? -1 : 1) * pit.goalW * 0.3, -1, rnd(w) < 0.5 ? KH.GROUND : KH.MID);
        } else if (!meant && airborne && inOwnBox(w, p.team, p.x, p.y, 6)) aiKick(w, p, KICK.SHOT, 0.85, gx, 0, -1, KH.HIGH); // clear it (upfield)
        else if (!meant && airborne && b.z > 1.4 && rnd(w) < 0.05) {
          let to = null;
          for (const q of w.players) if (q.team === p.team && q !== p && q.role !== ROLE.GK && Math.hypot(q.x - p.x, q.y - p.y) < 25 && (!to || q.x * dir > to.x * dir)) to = q;
          if (to) aiKick(w, p, KICK.PASS, 0.5, to.x, to.y, to.id, KH.MID);
        }
      }
      return;
    }
    // a shot of ours on its way or just saved: the men up front follow it in,
    // flat out, to where a rebound drops (six or seven metres out, across
    // the goal as they come) – as real strikers do
    const sh = b.sh >= 0 ? pById(w, b.sh) : null;
    if (sh && sh.team === p.team && sh !== p) {
      const gx = dir * pit.L / 2, hw = pit.goalW / 2;
      if (Math.hypot(gx - p.x, p.y) < 22 && (gx - p.x) * dir > 4) {
        moveTo(p, gx - dir * 6.5, clamp(p.y * 0.45, -hw, hw), 0, 0.5);
        return;
      }
    }
    const [tx, ty] = slotTarget(w, p, b.lastTeam === p.team);
    // one of the last two of us, the ball in our half and nearer our goal
    // than him, his spot well back: a recovery run, flat out; otherwise back
    // into shape – sharply with the ball in our half, at an easy pace further
    // off (real sides barely drop in the seconds after losing it)
    let deeper = 0;
    for (const q of w.players) if (q !== p && q.team === p.team && q.role === ROLE.OUT && (q.x - p.x) * dir < 0) deeper++;
    const beaten = deeper < 2 && b.lastTeam !== p.team && b.x * dir < 0 && (p.x - b.x) * dir > 0 && (p.x - tx) * dir > 8;
    if (beaten) moveTo(p, tx, ty, 8, 0.6);
    else if (b.x * dir < 0) moveTo(p, tx, ty, 8, 0.6, SHARP);
    else moveTo(p, tx, ty, 14, 0.6, CALM);
    return;
  }
  const ogx = -dir * pit.L / 2;
  const dGoalB = Math.hypot(owner.x - ogx, owner.y);
  const mk = c.mark.get(p.id);
  p.ai = c.presser[p.team] === p.id ? AI_PRESS : c.cover[p.team] === p.id ? AI_COVER : mk !== undefined ? AI_MARK : 0;
  if (p.ai === AI_COVER) { const [tx, ty] = c.coverAt[p.team]; guardTo(p, tx, ty, 6, 0.3, SHARP); return; }
  if (mk !== undefined) p.aiY = mk;
  if (c.presser[p.team] === p.id) {
    // near our goal and not goal-side of him (beaten, or off his shooting
    // line): no chasing him from behind – back onto the line ahead of him
    if (dGoalB < 28) {
      const [kx, ky] = bisector(w, p.team, owner.x, owner.y);
      const ahead = (p.x - owner.x) * kx + (p.y - owner.y) * ky, off = Math.abs((p.x - owner.x) * ky - (p.y - owner.y) * kx);
      if (ahead < 0.4 || off > 0.6 + 0.5 * ahead) {
        const [tx, ty] = coverPoint(w, p, owner, 1.2);
        guardTo(p, tx, ty, 2.5, 0.1);
        return;
      }
    }
    // goal-side of him, on his shooting line
    const [gx, gy] = bisector(w, p.team, owner.x, owner.y);
    const tx = owner.x + owner.vx * 0.2 + gx * 0.8, ty = owner.y + owner.vy * 0.2 + gy * 0.8;
    const d = Math.hypot(owner.x - p.x, owner.y - p.y);
    // closing him down: the last few metres facing him, side-on, goal-side
    if (d < 6) guardTo(p, tx, ty, 2.5, 0.05); else moveTo(p, tx, ty, 2.5, 0.05);
    if (d < 1.7 && !owner.held) p.ib |= KT.MATE; // press = hold a team-mate key
    if (d > 1.3 && d < 3.0 && p.tcd === 0 && !owner.held && w.m.spTaker !== owner.id) {
      const bx = b.x - p.x, by = b.y - p.y, bd = Math.hypot(bx, by) || 1;
      const facing = (Math.cos(p.face) * bx + Math.sin(p.face) * by) / bd;
      if (facing > 0.9 && rnd(w) < (inOwnBox(w, p.team, p.x, p.y, 2) ? 0.004 : 0.018)) tapKey(p, KT.GOAL); // (the slide key)
    }
    return;
  }
  // an attacker on the ball near our goal: besides the man pressing him, the
  // nearest of us gets in the way of his shot – on the line that splits the
  // goal he sees, a few metres off him – to hide as much of it as he can
  if (dGoalB < 26) {
    const [lx, ly] = laneSpot(w, p, owner, Math.min(0.45 * dGoalB, 3.5));
    let best = null, bd = 1e9;
    for (const q of w.players) {
      if (q.team !== p.team || q.role === ROLE.GK || q.id === c.presser[p.team] || q.st === ST.FALLEN) continue;
      const dq = Math.hypot(q.x - lx, q.y - ly);
      if (dq < bd) { bd = dq; best = q; }
    }
    if (best === p) { guardTo(p, lx, ly, 3, 0.15); return; }
  }
  const [sx, sy] = slotTarget(w, p, false);
  // nobody to mark and the man on the ball in range: fill the gap he still
  // sees, a little further back
  if (mk === undefined && dGoalB < 26) {
    const [lx, ly] = laneSpot(w, p, owner, Math.min(0.5 * dGoalB, 6.5));
    guardTo(p, lx, ly, 3, 0.2);
    return;
  }
  let tx = sx, ty = sy;
  if (mk !== undefined) {
    const o = pById(w, mk);
    if (o) {
      // where real defenders stand off a man without the ball (learned.js):
      // goal-side, shaded to the ball's side, closer the nearer he is to our
      // goal and to the ball
      const dG = Math.hypot(o.x - ogx, o.y) || 1, ux = (ogx - o.x) / dG, uy = -o.y / dG;
      let vx = -uy, vy = ux;
      if ((owner.x - o.x) * vx + (owner.y - o.y) * vy < 0) { vx = -vx; vy = -vy; }
      const dB = Math.hypot(owner.x - o.x, owner.y - o.y);
      const r = overGrid(MARK.r, dG, dB), a = overGrid(MARK.a, dG, dB);
      // (off where he'll be in a moment: he's on the move)
      tx = o.x + o.vx * 0.3 + (ux * Math.cos(a) + vx * Math.sin(a)) * r;
      ty = o.y + o.vy * 0.3 + (uy * Math.cos(a) + vy * Math.sin(a)) * r;
      // the last man holds the line real sides keep for where the ball is
      // (learned.js, give or take 2 m): a man coming short beyond it is let
      // go – there's no offside to save him from a ball in behind
      let last = true;
      for (const q of w.players) if (q !== p && q.team === p.team && q.role === ROLE.OUT && (q.x - p.x) * dir < 0) last = false;
      const line = (overDepth(SHAPE.op.back, clamp(b.x * dir / (pit.L / 2), -1, 1)) * pit.L / 2 + 2) * dir;
      if (last && (tx - line) * dir > 0) tx = line;
    }
  }
  // (ball and man in view; keeping with a man who's sprinting, sprinting too;
  // the ball in our half, sharp; otherwise – a man jogging or standing, or no
  // one to mark, far from our goal – an easy pace)
  const o = mk !== undefined ? pById(w, mk) : null, hurry = o && Math.hypot(o.vx, o.vy) > stOf(o).jog * 1.05;
  if (hurry) guardTo(p, tx, ty, 3, 0.5);
  else if (owner.x * dir < 0) guardTo(p, tx, ty, 5, 0.5, SHARP);
  else guardTo(p, tx, ty, 9, 0.5, 0.9);
}

// Where a keeper stands against a ball at (bx, by): on the bisector of the
// angle the shooter sees between the posts (equal cover of both corners) – or
// between y0 and y1, the part of the goal left to him – `depth` metres off his
// line. A ball level with the goal line: near post.
// How far off his line a keeper stands against a ball dGoal from his goal:
// as real keepers do (SkillCorner) – 2.3 m with it within a fifth of the
// pitch, stepping up as it goes away: 2.7 m a third of the way out, 4.5 m at
// halfway, 7.2 m beyond (on a 105 m pitch; the steps up scale with ours)
function keeperDepth(pit, dGoal) {
  const f = dGoal / pit.L;
  const extra = f < 0.19 ? 0 : f < 0.33 ? 0.4 * (f - 0.19) / 0.14 : f < 0.5 ? 0.4 + 1.8 * (f - 0.33) / 0.17 : f < 0.6 ? 2.2 + 2.7 * (f - 0.5) / 0.1 : 4.9;
  return 2.3 + extra * pit.L / 105;
}

function anglePoint(w, team, bx, by, depth, y0, y1) {
  const pit = pitchOf(w), dir = teamDir(w, team), ogx = -dir * pit.L / 2, hw = pit.goalW / 2;
  if (y0 === undefined) { y0 = -hw; y1 = hw; }
  let ux = ogx - bx, uy = y0 - by; const l1 = Math.hypot(ux, uy) || 1; ux /= l1; uy /= l1;
  let vx = ogx - bx, vy = y1 - by; const l2 = Math.hypot(vx, vy) || 1; vx /= l2; vy /= l2;
  let kx = ux + vx, ky = uy + vy; const lk = Math.hypot(kx, ky) || 1; kx /= lk; ky /= lk;
  const front = (bx - ogx) * dir; // ball's distance out from the goal line
  if (front < 0.6 || Math.abs(kx) < 0.2) return [ogx + dir * 0.5, clamp(by, -hw + 0.45, hw - 0.45)];
  const dep = Math.min(depth, Math.max(0.3, front - 0.6)); // (no further out than up to the ball)
  let t = (ogx + dir * dep - bx) / kx;
  // On the line, whatever – but against a wide man no further out than where
  // that line passes just inside the near post: further out (beyond the line
  // of the posts) the far post would be out of his reach, and held inside the
  // posts instead (as he used to be) he'd be off the line, the near post open.
  // (a ball out wide and far off: no further across than real keepers go,
  // ~0.6 of the way to the post – a cross or a switch is still on)
  const yMax = Math.abs(by) > 0.3 * pit.W && front > 0.2 * pit.L ? 0.6 * hw : hw - 0.3;
  if (Math.abs(by + ky * t) > yMax && Math.abs(ky) > 1e-3 && Math.abs(by) > yMax) t = (Math.sign(by) * yMax - by) / ky;
  return [bx + kx * t, by + ky * t];
}

// How much of our goal the man on the ball at (bx, by) still sees past the
// keeper standing where he is (body and arms ~1.6 m across).
function openPastKeeper(w, team, bx, by, gk) {
  const pit = pitchOf(w), ogx = -teamDir(w, team) * pit.L / 2, hw = pit.goalW / 2;
  const dx = gk.x - bx, dy = gk.y - by, d = Math.hypot(dx, dy), gl = ogx - bx;
  if (d < 0.3) return 0;
  if (dx * gl <= 0) return 1; // not in the way at all
  const a = Math.atan2(dy, dx), h = Math.asin(Math.min(1, 0.8 / d));
  const proj = (t) => (Math.cos(t) * gl <= 0 ? Math.sign(Math.sin(t)) * 99 : by + Math.tan(t) * gl);
  const y0 = Math.max(-hw, Math.min(proj(a - h), proj(a + h))), y1 = Math.min(hw, Math.max(proj(a - h), proj(a + h)));
  return 1 - Math.max(0, y1 - y0) / (2 * hw);
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
    const kh = up ? (d > 30 ? KH.HIGH : KH.MID) : KH.GROUND;
    const [tx, ty] = leadTo(w, p, q, kh, up ? 0.6 : 0.5);
    // (the practice service, not a football move – no key passes to the
    // other side – so the one kick the game plays for him: rolled out, thrown,
    // or a drop kick beyond throwing range – see startKick)
    if (up) startKick(w, p, b.held && Math.hypot(tx - b.x, ty - b.y) > 50 ? KICK.PUNT : b.held ? KICK.THROW : KICK.LONG, 0.6, false, tx, ty, q.id, b.held ? KH.MID : kh);
    else startKick(w, p, b.held ? KICK.THROW : KICK.PASS, 0.5, false, tx, ty, q.id, KH.GROUND);
    return;
  }
  if (b.owner === p.id) {
    // in his hands he can take his time; at his feet (a back-pass) he moves it on
    if (p.ai !== AI_CARRY) { p.ai = AI_CARRY; p.aiT = b.held ? lv.hold + Math.floor(rnd(w) * 30) : 10 + Math.floor(rnd(w) * 12); p.aiX = 0; }
    p.aiX++;
    // a person on his side calling for it gets it, once the keeper is set
    // (his goal kick placed): rolled or passed to feet if the way is clear,
    // otherwise thrown, drop-kicked or chipped to him
    const req = p.team === 0 ? m.req0 : m.req1, r = req >= 0 && req !== p.id ? pById(w, req) : null;
    if (r && r.team === p.team && (m.spTaker === p.id ? m.cd >= 25 : p.aiX > 15)) {
      const d = Math.hypot(r.x - p.x, r.y - p.y);
      const kh = d > 30 || (d > 9 && laneBlocked(w, p.team, b.x, b.y, r.x, r.y, 1.2)) ? (d > 30 ? KH.HIGH : KH.MID) : KH.GROUND;
      const [tx, ty] = leadTo(w, p, r, kh, 0.5);
      aiKick(w, p, KICK.PASS, 0.5, tx, ty, r.id, kh);
      if (p.team === 0) { m.req0 = -1; m.req0T = 0; } else { m.req1 = -1; m.req1T = 0; }
      return;
    }
    if (m.spTaker === p.id && m.cd < 45) return;
    // quick distribution: a team-mate already free gets it straight away – a
    // person playing rather than an AI one, when he's anywhere near as free
    const bp = bestPass(w, p, 0.25);
    const d = bp ? Math.hypot(bp.tx - p.x, bp.ty - p.y) : 99;
    // (short only to a man who's free where it gets to him – nobody within 4 m)
    let freeAt = 0;
    if (bp) { freeAt = 9; for (const o of w.players) if (o.team !== p.team) freeAt = Math.min(freeAt, Math.hypot(o.x - bp.tx, o.y - bp.ty)); }
    const clear = bp && bp.kh === KH.GROUND && bp.odds > 0.85 && d < 32 && freeAt > 4;
    // ball at his feet with someone closing in: no time to wait – with a man
    // on him (in his box too), unless there's a safe pass to a free man, it's
    // cleared, long and wide: he doesn't hand it on to be pressed
    const rushed = !b.held && openness(w, p.team, p.x, p.y) < 8;
    if (rushed && openness(w, p.team, p.x, p.y) < 4.5 && !(clear && bp.odds > 0.92) && m.spTaker !== p.id) {
      const side = p.y >= 0 ? 1 : -1;
      aiKick(w, p, KICK.CLEAR, 0.95, p.x + dir * 32, side * pit.W * 0.38, -1, KH.HIGH);
      return;
    }
    if (p.aiT > 0 && m.spTaker !== p.id && !rushed && !(clear && bp.odds > 0.95 && p.aiT < lv.hold - 15)) {
      moveTo(p, ogx + dir * 5, p.y * 0.5, 99, 0.3);
      return;
    }
    if (clear) aiKick(w, p, bp.kind, bp.pw, bp.tx, bp.ty, bp.t.id, KH.GROUND);
    else if (bp && bp.odds > 0.65 && freeAt > 4) aiKick(w, p, bp.kind, bp.pw, bp.tx, bp.ty, bp.t.id, bp.kh);
    else {
      // long: the team-mate (or the wide space) a high ball is most likely to
      // reach – raced against everyone who could head it on the way
      // (getting it away safely first: odds count more than where it lands)
      let best = null;
      const tryTarget = (tx, ty, q) => {
        const odds = passOdds(w, p.team, b.x, b.y, tx, ty, KICK.LONG, KH.HIGH, 0.8, q);
        const v = odds * (0.3 + spotValue(w, p.team, tx, ty) + (q && byPerson(q) ? 0.25 : 0));
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
  // made big against a man close in, with the shot coming within reach of a
  // hand: he stays big and it's saved there (a shuffle across to it at most)
  // – no going down. (A low one: a foot, or a leg slid out – see below.)
  if (shotOnGoal && keeperBig(w, p)) {
    const tk = (p.x - b.x) / b.vx, yk = b.y + b.vy * tk, zk = b.z + b.vz * tk - 0.5 * G * tk * tk;
    if (tk > 0 && zk >= 0.45 && Math.abs(yk - p.y) < bigReach(s, zk)) { moveTo(p, p.x, yk, 99, 0.05); return; }
  }
  if (shotOnGoal && b.kt === lv.spread && p.tcd === 0 && (p.x - b.x) / b.vx > 0.04 && rnd(w) < lv.spreadP) {
    const dB = Math.hypot(b.x - p.x, b.y - p.y), tk = (p.x - b.x) / b.vx;
    const kind = blockKind(w, b.x, b.y, dB);
    // each block for the height it covers: spread on the ground for a low one,
    // the K-barrier up to his waist, the star for a high one just out of his
    // standing reach (it leaves a gap at his hips) and only when there's no
    // time to dive; a shot at him at chest height he takes standing
    const off = Math.abs(b.y + b.vy * tk - p.y), zk = b.z + b.vz * tk - 0.5 * G * tk * tk;
    const nearHim = off > 0.55 && off < 1.15 && zk > 1.0 && zk < 2.3;
    // (only at a shot that comes within the block's reach: one going across
    // him to the far post is a dive)
    if ((kind === GKB.SPREAD && dB < 4.5 && zk < 0.7 && off < 1.8) || (kind === GKB.STAR && nearHim && tk < 0.25) || (kind === GKB.KNEE && dB < 6.5 && zk < 1.1 && off < 1.3)) {
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
        // made big, with it coming within reach of a hand: that's where it's
        // saved – he stays on his feet and shuffles across to it
        if (keeperBig(w, p) && zk >= 0.45 && Math.abs(dy) < bigReach(s, zk)) { moveTo(p, p.x + dir * 0.05, yk, 99, 0.05); return; }
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
  let tx, ty, set = false, rush = false, spotVx = 0, spotVy = 0, attackMan = false;
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
    const close = inOwnBox(w, p.team, owner.x, owner.y, 0);
    rush = close; // closing him down: quick off the line
    // a real chance for him: facing the goal from in front of it – or from a
    // tight angle with a good part of it still to aim at past the keeper
    const facingGoal = Math.cos(angDiffAI(owner.face, Math.atan2(-owner.y, ogx - owner.x))) > 0.3;
    const tight = Math.atan2(Math.abs(owner.y), Math.max(0.01, (owner.x - ogx) * dir)) > 1.0;
    const threat = facingGoal && (!tight || openPastKeeper(w, p.team, b.x, b.y, p) > 0.4);
    // smother: the attacker has let the ball run away from him (and the keeper
    // is nearer it), or he has a real chance from right in front of the keeper
    // – throw yourself at the ball. Not at a ball he has under control from
    // where he can hardly score (a tight angle, his back to goal): that's
    // defended on the feet, like a defender would
    const pace = Math.hypot(owner.vx, owner.vy);
    if ((alone || charge || close) && !shooting && inOwnBox(w, p.team, b.x, b.y, 0.5) && p.tcd === 0 && b.z < 0.5
      && dBall < 2.6 && ((sep > lv.smother && dBall < sep + 0.3) || (dBall < 1.3 && threat && pace >= 3.5))) {
      p.tcd = 50;
      beginDive(w, p, Math.atan2(b.y - p.y, b.x - p.x), 0.15, Math.max(0.15, dBall / 7), dBall + 0.3);
      return;
    }
    // ...a man in the box who stands or walks with it – a real chance or not –
    // is attacked: when none of his defenders is on him already, the keeper
    // goes at him on his feet, along his shooting line (staying between him
    // and the goal all the way – see the depth below), and takes the ball off
    // him: the last step into it, gathering it at his feet (see the movement
    // and possession). Only a wind-up has him set instead
    const mateOn = w.players.some((q) => q.team === p.team && q.role !== ROLE.GK && q.st !== ST.FALLEN
      && Math.hypot(q.x - owner.x, q.y - owner.y) < Math.min(dBall, 3));
    // (he has to be dawdling – half a second at walking pace, not just setting
    // off – or holding it up with his back to goal, where he can't shoot)
    p.aiX = pace < 2.5 ? Math.min(255, p.aiX + 1) : 0;
    const backTurned = Math.cos(angDiffAI(owner.face, Math.atan2(-owner.y, ogx - owner.x))) < -0.3;
    attackMan = close && !shooting && !owner.held && !mateOn && dBall < 7 && (p.aiX > 30 || (backTurned && pace < 4.5))
      && inOwnBox(w, p.team, b.x, b.y, 0.5);
    // shielding it, his back to the keeper: no reaching through him from
    // behind (that's a foul) – round to the side of the ball first
    // (clearly beside him or in front: he may turn as the foot goes in)
    const behindHim = ((p.x - owner.x) * Math.cos(owner.face) + (p.y - owner.y) * Math.sin(owner.face)) / (Math.hypot(p.x - owner.x, p.y - owner.y) || 1) < 0.1;
    if (attackMan && dBall < 1.3 && !behindHim) { p.ib |= KT.MATE; return; } // into it
    // Always between the ball and the goal: on the line that splits the goal
    // the man sees (the frustum from the ball to the posts), where he hides
    // the most of it. Further out hides more – in the box (or against a man
    // running in alone) he comes out at him, arms open – but not so far that
    // he can't keep to that line when the man moves across or cuts back: the
    // quicker the man is going, the more he holds back (from ~60% of the
    // man's distance out against one standing to 40% against one in full
    // flight) – except close in, inside ~8 m, where he goes at him whatever
    // (it's point-blank: the nearer he is, the less of the goal is left),
    // to within 1-2 m of him. Aimed at where the ball will be a moment from
    // now (by the man's run: the ball jumps about with his touches).
    const ax = b.x + owner.vx * 0.06, ay = b.y + owner.vy * 0.06, fx = Math.max(0.5, (ax - ogx) * dir);
    // (what he has to keep up with is the man going across: running straight
    // in at goal, he's met further out like a man standing)
    const gl = Math.hypot(ogx - owner.x, owner.y) || 1, across = Math.abs(owner.vx * -owner.y - owner.vy * (ogx - owner.x)) / gl;
    const still = 1 - clamp(across / 6, 0, 1), closeIn = clamp((8 - fx) / 3, 0, 1);
    const share = (0.4 + 0.22 * still) * (1 - closeIn) + 0.62 * closeIn;
    const depth = attackMan ? Math.max(1.0, fx - 0.9)
      : alone || charge || close ? clamp(fx * share, 1.0, Math.max(1.0, Math.min(fx - clamp(0.3 * fx, 1.0, 2.2), 6)))
        : keeperDepth(pit, dGoal);
    [tx, ty] = anglePoint(w, p.team, ax, ay, depth);
    // how that spot moves across with his run: the keeper moves with it (in
    // and out is left to the pull below – backing off fast he can't do, and
    // it would slow him getting across)
    const [nx, ny] = anglePoint(w, p.team, ax + owner.vx * 0.1, ay + owner.vy * 0.1, depth);
    const lx = tx - ax, ly = ty - ay, ll = Math.hypot(lx, ly) || 1; // along the line ball -> spot
    spotVx = (nx - tx) / 0.1; spotVy = (ny - ty) / 0.1;
    const along = (spotVx * lx + spotVy * ly) / ll;
    spotVx -= along * lx / ll; spotVy -= along * ly / ll;
    // going at a man dawdling on it: just in front of the ball on his line,
    // whatever the angle (from by the byline too) – that spot goes with him
    if (attackMan) {
      spotVx = owner.vx; spotVy = owner.vy;
      const [kx, ky] = bisector(w, p.team, ax, ay);
      tx = ax + kx * 0.9; ty = ay + ky * 0.9;
      // (with his body between that spot and the ball – shielding it – the
      // side of the ball nearer the keeper instead)
      const ox = b.x - owner.x, oy = b.y - owner.y, ol = Math.hypot(ox, oy) || 1;
      if ((tx - owner.x) * ox + (ty - owner.y) * oy < 0) {
        const sx = -oy / ol, sy = ox / ol, sg = (p.x - owner.x) * sx + (p.y - owner.y) * sy >= 0 ? 1 : -1;
        tx = b.x + sx * sg * 0.75; ty = b.y + sy * sg * 0.75;
      }
    }
    // a defender in the way hides part of the goal: he covers the rest – the
    // biggest part the shooter still sees (not all the way: it may deflect,
    // the defender may move)
    const { g0, g1, hid } = openGap(w, p.team, ax, ay);
    if (hid > 0.15 && g1 - g0 > 0.3) {
      const [gx2, gy2] = anglePoint(w, p.team, ax, ay, depth, g0, g1);
      const k = Math.min(0.7, hid * 1.2);
      tx += (gx2 - tx) * k; ty += (gy2 - ty) * k;
    }
    // set (planted, small steps only) when the shot is coming: a wind-up
    // (a man just standing on the ball is gone at, above)
    set = shooting;
  } else {
    // our ball or a loose one: angle on where the ball is going; further out
    // (sweeper) when we have it
    const q = c.path[Math.min(c.path.length - 1, 5)];
    const ours = owner && owner.team === p.team;
    const dist = Math.hypot(q.x - ogx, q.y);
    const depth = ours ? clamp(0.2 * dist, 1, pit.boxD - 3) : keeperDepth(pit, dist);
    [tx, ty] = anglePoint(w, p.team, q.x, q.y, depth);
  }
  // a weaker keeper only roughly finds the angle
  if (lv.angle < 1) { const cx = ogx + dir * Math.abs(tx - ogx); tx = tx * lv.angle + cx * (1 - lv.angle); ty *= lv.angle; }
  if ((tx - ogx) * dir < 0.3) tx = ogx + dir * 0.3;
  const d = Math.hypot(tx - p.x, ty - p.y);
  if (owner && owner.team !== p.team) {
    // keeping to the line as he moves: along with the spot (it moves across
    // with the man's run), plus a pull onto it no quicker than he can pull up
    // there (a keeper who overruns it is off the line again). Set for the
    // shot he still keeps to the line – quick side-steps across, at most a
    // jog – but no rushing in or out (closing a man down close in, he gets
    // out there first, then sets).
    let ex = tx - p.x, ey = ty - p.y;
    const setNow = set && !(rush && d > 1);
    if (setNow) {
      const lx = tx - b.x, ly = ty - b.y, ll = Math.hypot(lx, ly) || 1, al = (ex * lx + ey * ly) / ll;
      ex -= al * lx / ll; ey -= al * ly / ll;
    }
    const e = Math.hypot(ex, ey), pull = Math.sqrt(2 * s.accel * 1.2 * e) * 0.85;
    let vx = (e > 1e-3 ? ex / e * pull : 0) + spotVx, vy = (e > 1e-3 ? ey / e * pull : 0) + spotVy;
    let vm = Math.hypot(vx, vy);
    if (setNow && vm > s.jog) { vx *= s.jog / vm; vy *= s.jog / vm; vm = s.jog; }
    if (vm < 0.3) p.im = 0;
    else {
      setMove(p, vx, vy, tiltFor(p, vm)); // (as fast as the spot moves: a sprint when it must)
    }
  } else moveTo(p, tx, ty, rush ? 1.5 : 3.5, 0.12);
}

// ------------------------------------------------------------ entry

// Reaction: a kick by the other side is seen a moment late (longer when it's
// struck behind his back – lanes.aiReact); till then he carries on as he was.
// His own side reads it as it's played.
function reacting(w, p) {
  const b = w.ball;
  if (w.m.phase !== PHASE.PLAY || p.role !== ROLE.OUT || b.owner >= 0 || b.last < 0 || b.lastTeam === p.team || b.kt >= 40) return false;
  const k = pById(w, b.last);
  return !!k && b.kt / 60 < aiReact(w, p, k.x, k.y);
}

export function aiThink(w, p) {
  stand = p.human ? LEVELS[1] : null;
  // a kick under way: its keys (see driveKey)
  if ((p.st === ST.IDLE || p.st === ST.STUMBLE) && driveKey(w, p)) return;
  think(w, p);
  // just kicked it: the stick barely tilted while aftertouch could take it
  // (as a player must, or he bends his own kick)
  const b = w.ball;
  if (b.atk === p.id && b.atT > 0 && p.im > 4) p.im = 4;
}

function think(w, p) {
  if ((p.st === ST.IDLE || p.st === ST.STUMBLE) && reacting(w, p)) { p.ib &= BTN.R2; return; }
  p.ib = 0; p.im = 0;
  const m = w.m;
  if (m.phase === PHASE.KICKOFF || m.phase === PHASE.HALFTIME) return;
  if (p.st !== ST.IDLE && p.st !== ST.STUMBLE) return;
  if (p.aiT > 0) p.aiT--;
  if (m.phase === PHASE.GOAL || m.phase === PHASE.FULLTIME || m.phase === PHASE.SETPIECE) {
    if (p.role === ROLE.GK) {
      const pit = pitchOf(w), dir = teamDir(w, p.team);
      moveTo(p, -dir * (pit.L / 2 - 1), 0, 99, 0.5, m.phase === PHASE.SETPIECE ? 0 : 2.5);
    } else {
      // (after a goal, at the end: walking back; for a set piece, no rush unless it's far)
      const [tx, ty] = slotTarget(w, p, m.phase === PHASE.SETPIECE && m.spTeam === p.team);
      moveTo(p, tx, ty, m.phase === PHASE.SETPIECE ? 10 : 99, 0.6, m.phase === PHASE.SETPIECE ? CALM : 2.5);
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
