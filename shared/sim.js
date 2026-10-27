// Deterministic fixed-step football simulation.
//
// The exact same code runs on the authoritative server and inside every client
// (for prediction + rollback). All state that influences the future lives in the
// plain objects below and is serialised in protocol.js. Randomness comes from a
// seeded xorshift stored in the match state, so a client re-simulating from a
// server snapshot reproduces the server's dice rolls.

import {
  DT, G, BALL_R, PLAYER_R, BTN, KT, KH, KICK_MASK, packKick, PHASE, ST, ROLE, SP, KICK, PITCHES, GOAL_DEPTH, POST_R, SKILL,
  GOAL_SIZES, PART, MEET, GKB, KQ, FOOT, JOG_TILT,
} from './constants.js';
import { stats } from './physique.js';
import { aiThink } from './ai.js';
import { CURL_MAX, curlPace, groundShot, curlAim, passHole, shotHole, sideCurl, POST_IN } from './lanes.js';

export const CHG_MAX = 40;          // ticks to fill the power gauge
// Pressing the same kick key again right after letting go, while the ball is
// on its way to you: a double press fills the gauge twice as fast, a triple
// press is full power at once (a big first-time clearance). With the ball at
// your feet a release always kicks at once – no waiting for a second press.
export const TAP_GAP = 8;           // max ticks between release and the next press
// After a goal in a match: a celebration as long as the goal matters
// (goalWeight: [a goal more on a big lead, a goal back or a two-goal lead, one
// that changes who's winning]), then the replay; the pause is the two (and
// can be skipped).
export const CELEB_TICKS = [50, 110, 180];
const REPLAY_TICKS = 460;
// How much a goal matters, by what it did to the score: 2 – it changed who's
// winning (the first goal, an equaliser, going ahead); 1 – a goal back to one
// behind, or a two-goal lead; 0 – any other (4-0 from 3-0, a late consolation).
export function goalWeight(m) {
  const lead = m.lastGoalTeam === 0 ? m.s0 - m.s1 : m.s1 - m.s0; // the scorers', after it
  return lead === 0 || lead === 1 ? 2 : lead === 2 || lead === -1 ? 1 : 0;
}
export const goalTicks = (m) => (m.live ? CELEB_TICKS[goalWeight(m)] + REPLAY_TICKS : 36);

// Aftertouch (Sensible Soccer style): for a short window after a human kicks
// the ball, a *fresh* stick input bends it (towards the side pushed), lifts it
// (pull back) or dips it (push forward). Holding the aim you kicked with does
// nothing, so PES-style aiming and aftertouch don't fight each other.
export const AT_TICKS = 33;          // 0.55 s window
const AT_CURVE = 1.7;                // spin gained per second at full lateral stick
const AT_SPIN_MAX = 0.9;             // rad/s turn rate of the ball's path (as much as a struck curl: see lanes.CURL_MAX)
const AT_LIFT = 19;                  // m/s^2 upward while pulling back
const AT_DIP = 10;                   // m/s^2 downward while pushing forward
export const MU = 1.0, CF = 0.22;   // rolling resistance: dv/dt = -(MU + CF v)
export const AIR_K = 0.006;         // quadratic air drag
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- helpers

export function rnd(w) {
  let x = w.m.rng | 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  w.m.rng = x >>> 0;
  return (x >>> 0) / 4294967296;
}
function gauss(w) { return (rnd(w) + rnd(w) + rnd(w) - 1.5) * 1.41; }
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const hyp = Math.hypot;
export function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
// The pitch with the room's goal size applied (cached per pitch x goal size).
const scaledPitches = new Map();
export function pitchOf(w) {
  const gs = (w.m && w.m.goalS) || 0;
  const key = (w.pitchId << 2) | gs;
  if (w._pitK === key) return w._pit;
  const base = PITCHES[w.pitchId] || PITCHES[1];
  let pit = scaledPitches.get(key);
  if (!pit) {
    const g = GOAL_SIZES[gs] || GOAL_SIZES[0];
    pit = { ...base, goalW: base.goalW * g.w, goalH: base.goalH * g.h };
    scaledPitches.set(key, pit);
  }
  w._pitK = key; w._pit = pit;
  return pit;
}
export function teamDir(w, team) { return team === 0 ? w.m.dir0 : -w.m.dir0; }
export function pById(w, id) {
  if (id < 0) return null;
  const ps = w.players;
  for (let i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
  return null;
}
// (kept on the player – asked for hundreds of times a tick; p.rl: the room's
// realistic movement, set each tick – see realStats)
export function stOf(p) {
  const k = p.hgt * 256 + p.bld + (p.rl ? 65536 : 0);
  if (p._stK !== k) { p._stK = k; const s = stats(p.hgt, p.bld); p._st = p.rl ? realStats(s) : arcadeStats(s); }
  return p._st;
}
// Realistic movement (room setting m.real), for everyone: nearer real
// players' limits – top speed 0.9x (8.6-9.9 m/s), a jog 0.85x, acceleration
// 0.55x (4.4-7.2 m/s² from still), turning 0.6x and falling away faster
// with pace (wider turns at speed). As real players move in SkillCorner's
// tracking (scripts/learn/learn-running.mjs – the hardest 1 in 1000 moments,
// smoothed): speeding up ~4.5-5 m/s² and less the faster they go (the
// acceleration-speed profile: falling in a line to nothing a little past top
// speed – aV0), braking ~5-6 (brake: as hard as they speed up from still, not
// half as hard again), and at most ~6 m/s² sideways turning at pace (side:
// 7 for an average player, more or less with agility) – so a sharp cut at
// pace means slowing down first (cut: the pace kept into a right-angle turn).
const realStats = (s) => ({
  ...s, sprint: s.sprint * 0.9, jog: s.jog * 0.85, accel: s.accel * 0.55, turn: s.turn * 0.6, turnK: 0.25,
  aV0: s.sprint * 0.9 * 1.08, brake: 1, side: 7 * s.turn / 11, cut: 0.5,
});
// Arcade movement keeps its quickness – the burst, footwork, braking, sprint
// and jog speeds – but takes the sideways limit of the real shape (see
// realStats): no more than ~5x a real player's push into a turn at pace (real
// ~7 m/s²; before, a sharp cut at a sprint took 60), so a cut at a sprint is
// a tight curve, not a corner. (Speeding up less past a jog as well was
// tried: it cost keepy-ups and defenders getting across.)
const arcadeStats = (s) => ({ ...s, side: 36 * s.turn / 11 });
// How hard he can speed up at pace v (realistic movement: less the faster he
// goes – see realStats)
const accelAt = (s, v) => (s.aV0 ? s.accel * Math.max(0.06, 1 - v / s.aV0) : s.accel);
export function stickOf(p) {
  const mag = p.im / 15;
  if (mag < 0.05) return [0, 0, 0];
  const t = p.ia * (TAU / 256);
  return [Math.cos(t), Math.sin(t), mag];
}
export function encodeStick(dx, dy, mag) {
  if (mag <= 0.02) return [0, 0];
  const a = Math.atan2(dy, dx);
  return [((Math.round(a / TAU * 256) % 256) + 256) % 256, clamp(Math.round(mag * 15), 0, 15)];
}
export function inOwnBox(w, team, x, y, margin = 0) {
  const pit = pitchOf(w), dir = teamDir(w, team), gx = -dir * pit.L / 2;
  const d = (x - gx) * dir;
  return Math.abs(y) < pit.boxW / 2 + margin && d > -1.5 && d < pit.boxD + margin;
}
function isFree(p) { return p.st === ST.IDLE || p.st === ST.STUMBLE; }
// A shot met at (x, y) in their half but outside their box: nobody heads it
// (or dives to head it) at goal from there – a ball out of the air is met low
// enough to volley, or headed on as a pass (see meetBall, tryQueued). (In his
// own half the Goal key is a clearance: headers and all.)
const VOLLEY_TOP = 1.35;
const shotKey = (p) => (p.qa & KICK_MASK) === KT.GOAL;
function farShot(w, p, x, y) { return x * teamDir(w, p.team) > 0 && !inOwnBox(w, 1 - p.team, x, y, 0); }

// The back-pass rule: a keeper may not handle a ball a team-mate deliberately
// played to him with his feet (b.dl: the last touch was a kick or throw, not a
// header, deflection or tackle) – he has to play it like an outfielder.
export function keeperHands(w, p) {
  const b = w.ball;
  return !(b.dl && b.lastTeam === p.team && b.last !== p.id);
}
// A keeper on his feet gets his hands to a ball (a catch, a tip, a parry, the
// jump for a high one) only with the catch key held – the control key or R2 –
// or just let go (it stays wanted a moment, as a kick key does), or the shot
// key held to punch it; without it he's like anyone else: it comes off his
// body or he takes it at his feet. (A dive is a key pressed already.) The AI's
// keeper presses it too.
export function catchKey(p) {
  const k = p.qa & KICK_MASK;
  return k === KT.CTRL || k === KT.GOAL || !!(p.ib & BTN.R2);
}

// Played by a person right now: a human whose inputs are arriving. When a
// human's inputs stop coming for a moment (a lag spike) the authoritative side
// lets the AI play him (p.bot) until they resume, instead of him running on
// with the last keys held.
export const BOT_AFTER = 8; // ticks without input before the AI steps in
export function byPerson(p) { return p.human && !p.bot; }

// Ground pass maths (closed form of the rolling model above)
function rollDist(v) { return (v - (MU / CF) * Math.log(1 + CF * v / MU)) / CF; }
export function rollTime(v0, v1) { return Math.log((v0 + MU / CF) / (Math.max(0, v1) + MU / CF)) / CF; }
// (pace the ball still has when it reaches the man: brisk, but not so hot he
// can't control it)
export function passEndSpeed(kind, d, power) {
  return kind === KICK.THROUGH ? 2.6 + 0.065 * d + 2 * power : Math.min(16, 6.5 + 0.28 * d + 5 * power);
}
// How likely q is to stop a ground ball the other side plays past him: h is
// how close its line comes to him, v its pace against his, (ux, uy) its way.
// Straight at him he closes his legs on it – now and then it goes through
// them – and the further out, the more he has to stretch for it. A quick
// ball, one from behind him or one that catches him on the run gets by more.
export function stopChance(q, h, v, ux, uy) {
  if (v < 4) return 0.97;
  const run = Math.hypot(q.vx, q.vy);
  let c;
  if (h < 0.2) c = 0.92 - (run > 3 ? 0.15 : 0);                // through the legs
  else { const e = clamp(h / 0.62, 0, 1); c = 0.97 - 0.55 * e * e; } // past the leg he sticks out
  c -= 0.015 * Math.max(0, v - 7);
  if (Math.cos(q.face) * ux + Math.sin(q.face) * uy > 0.2) c -= 0.25; // it comes from behind him
  return clamp(c, 0.15, 0.97);
}

export function groundSpeedFor(d, vEnd) {
  const target = d + rollDist(vEnd);
  let lo = 0, hi = 45;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (rollDist(mid) < target) lo = mid; else hi = mid; }
  return hi;
}

// ---------------------------------------------------------------- ball prediction

// Predicted flight of the loose ball with the same physics as updateBall
// (gravity, drag, spin, bounces, rolling), PATH_N points 1/30 s apart.
// Cached per tick; anything that changes the ball's velocity mid-tick clears it.
export const PATH_H = 1 / 30;
const PATH_N = 75;
export function ballPath(w) {
  const c = w._bp;
  if (c && c.tick === w.tick && c.w === w) return c.pts;
  const b = w.ball, h = PATH_H, pts = [];
  let x = b.x, y = b.y, z = b.z, vx = b.vx, vy = b.vy, vz = b.vz, spin = b.spin, ts = b.ts || 0;
  pts.push({ x, y, z });
  for (let k = 1; k <= PATH_N; k++) {
    const onG = z <= BALL_R + 1e-3 && Math.abs(vz) < 0.05;
    if (!onG) { vz -= (G + TS_K * ts * Math.hypot(vx, vy)) * h; ts *= 1 - TS_DECAY * h; } else ts = 0;
    const sp = Math.hypot(vx, vy, vz), f = Math.max(0, 1 - AIR_K * sp * h);
    vx *= f; vy *= f; vz *= f;
    if (spin) { const ox = vx; vx -= vy * spin * h; vy += ox * spin * h; spin *= onG ? 0.95 : 0.994; }
    x += vx * h; y += vy * h; z += vz * h;
    if (z < BALL_R) { z = BALL_R; if (vz < -1) { const kh = bounceKeep(ts); vz = -vz * (0.55 - 0.1 * ts); vx *= kh; vy *= kh; ts *= 0.4; } else vz = 0; }
    if (z <= BALL_R + 1e-3 && vz === 0) {
      const hs = Math.hypot(vx, vy);
      if (hs > 0) { const ns = Math.max(0, hs - (MU + CF * hs) * h); vx *= ns / hs; vy *= ns / hs; }
    }
    pts.push({ x, y, z });
  }
  w._bp = { tick: w.tick, w, pts };
  return pts;
}

// Earliest time q can reach the predicted flight at a height up to `top`.
function firstReach(pts, q, top) {
  const s = stOf(q), v0 = Math.hypot(q.vx, q.vy);
  for (let k = 1; k < pts.length; k++) {
    const b = pts[k];
    if (b.z > top) continue;
    const t = k * PATH_H;
    const run = t < 0.15 ? v0 * t : v0 * 0.15 + s.sprint * (t - 0.15) * 0.95;
    if (Math.hypot(b.x - q.x, b.y - q.y) - 0.4 <= run) return t;
  }
  return 99;
}

// Where p should meet the loose ball. Candidates are the points of the
// predicted flight p can reach in time at a playable height (header reach when
// a kick/header is queued, otherwise chest height so the ball can be brought
// down). Points an opponent would reach first are dropped; of the rest the one
// needing the least running wins (small preference for earlier). If an opponent
// beats p everywhere, p goes for the earliest point to contest it.
// `first` (earliest time at header reach) decides which team-mate goes.
export function meetBall(w, p) {
  let c = w._meet;
  if (!c || c.tick !== w.tick || c.w !== w) { c = w._meet = { tick: w.tick, w, map: new Map(), threat: [null, null] }; }
  if (c.map.has(p.id)) return c.map.get(p.id);
  const pts = ballPath(w), s = stOf(p);
  if (c.threat[p.team] === null) {
    let t = 99;
    for (const q of w.players) if (q.team !== p.team && isFree(q)) t = Math.min(t, firstReach(pts, q, stOf(q).reach + 0.05));
    c.threat[p.team] = t;
  }
  const threat = c.threat[p.team];
  const v0 = Math.hypot(p.vx, p.vy);
  // (a keeper who may use his hands goes for it as high as he can catch it)
  const hands = p.role === ROLE.GK && keeperHands(w, p) && inOwnBox(w, p.team, p.x, p.y, 0.6);
  const top = hands ? s.H * 1.22 + s.jump : (p.qa && (p.qa & KICK_MASK) !== KT.CTRL) || p.chgBtn ? s.reach + 0.05 : 1.45;
  // (a shot met outside their box: as low as he can volley it – headed on
  // only if it never comes down in his reach)
  let far = !hands && shotKey(p);
  const rolling = w.ball.z < 0.3 && Math.abs(w.ball.vz) < 1;
  let res = null, best = 1e9, early = null;
  for (let pass = 0; pass < 2; pass++, far = false) {
  for (let k = 1; k < pts.length; k++) {
    const q = pts[k];
    if (q.z > top || (far && q.z > VOLLEY_TOP && farShot(w, p, q.x, q.y))) continue;
    const t = k * PATH_H;
    const d = Math.hypot(q.x - p.x, q.y - p.y) - 0.4;
    const run = t < 0.15 ? v0 * t : v0 * 0.15 + s.sprint * (t - 0.15) * 0.95;
    if (d > run) continue;
    if (!early) early = { t, x: q.x, y: q.y, z: q.z };
    if (t > threat - 0.1) continue;
    let score;
    if (rolling) {
      // a ball along the ground: go and meet it – the earliest point he can be
      // at a moment before it, as long as it's still slow enough there to take
      // cleanly (a hot one he lets come further, losing pace)
      const pq = pts[k - 1], pace = Math.hypot(q.x - pq.x, q.y - pq.y) / PATH_H;
      if (pace > 15 || d > (t < 0.27 ? v0 * Math.max(0, t - 0.12) : v0 * 0.15 + s.sprint * (t - 0.27) * 0.95)) continue;
      score = t + 0.04 * Math.max(0, d);
    } else score = Math.max(0, d) + t; // in the air the height he meets it at matters more
    if (score < best) { best = score; res = { t, x: q.x, y: q.y, z: q.z }; }
  }
  if (res || early || !far) break;
  }
  if (!res) res = early;
  if (res) res.first = firstReach(pts, p, s.reach + 0.05);
  c.map.set(p.id, res);
  return res;
}
function invalidatePath(w) { w._bp = null; w._meet = null; }

// Where and when the ball goes out of play on its way (null: it doesn't within
// the predicted path; over the goal line inside the goal mouth is a goal)
export function exitPoint(w) {
  const pts = ballPath(w), pit = pitchOf(w), hx = pit.L / 2 + BALL_R, hy = pit.W / 2 + BALL_R;
  for (let k = 1; k < pts.length; k++) {
    const q = pts[k];
    if (Math.abs(q.y) > hy) return { t: k * PATH_H, x: q.x, y: Math.sign(q.y) * (hy - BALL_R), z: q.z };
    if (Math.abs(q.x) > hx) {
      if (Math.abs(q.y) < pit.goalW / 2 && q.z < pit.goalH) return null;
      return { t: k * PATH_H, x: Math.sign(q.x) * (hx - BALL_R), y: q.y, z: q.z };
    }
  }
  return null;
}

// A touch near a line: what would take it over is mostly taken off – players
// keep it in (towards the goal itself is fine)
function keptIn(w, x, y, vx, vy) {
  const pit = pitchOf(w), hx = pit.L / 2, hy = pit.W / 2, lim = 2.5;
  if (Math.abs(y) > hy - lim && vy * Math.sign(y) > 0) vy *= 0.05 + 0.95 * clamp((hy - 0.5 - Math.abs(y)) / (lim - 0.5), 0, 1);
  if (Math.abs(x) > hx - lim && vx * Math.sign(x) > 0 && Math.abs(y) > pit.goalW / 2) vx *= 0.05 + 0.95 * clamp((hx - 0.5 - Math.abs(x)) / (lim - 0.5), 0, 1);
  return [vx, vy];
}

// ---------------------------------------------------------------- creation

// ft: his stronger foot (0 right, 1 left)
export function makePlayer(id, team, role, human, hgt = 180, bld = 50, ft = 0) {
  return {
    id, team, role, human: human ? 1 : 0, hgt, bld, ft: ft ? 1 : 0,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, face: 0,
    st: 0, stT: 0, stDur: 0, stA: 0, stB: 0, hit: 0,
    kk: 0, kp: 0, kx: 0, ky: 0, kt: -1, kv: 0, kh: 0, kq: 0, kc: 0, kf: 0,
    akK: 0, akN: 0, akA: 0, akM: 0, akR: 0, // (an AI player's keys for a kick under way – ai.js driveKey)
    chg: 0, chgBtn: 0, stam: 1, pb: 0, kcd: 0, tcd: 0, eng: 0, tap: 0, tapT: 255, tapK: 0, tapH: 0, spr: 0, // (eng: ticks pressing up close – see movement)
    bot: 0, miss: 0, tm: 0, qk: 0,
    qa: 0, qt: 0, qp: 0, dph: 0, hold: 0,
    ai: 0, aiT: 0, aiX: 0, aiY: 0,
    ia: 0, im: 0, ib: 0,
    px: 0, py: 0, pz: 0,
  };
}
export function makeBall() {
  return {
    x: 0, y: 0, z: BALL_R, vx: 0, vy: 0, vz: 0, spin: 0, ts: 0, owner: -1, held: 0, last: -1, lastTeam: -1, kt: 255, tgt: -1, sh: -1, dl: 0, nut: -1,
    atk: -1, atT: 0, atA: 0, atM: 0, atOn: 0, px: 0, py: 0, pz: BALL_R,
    // the passing so far (for the AI: no playing it back and forth): who
    // played the last pass, for which side and from where (x), the furthest
    // forward the side has had it, and how many passes since it got further
    pf: -1, pft: -1, pfx: 0, fwdX: 0, stale: 0,
  };
}
// murmur3 finalizer: neighbouring seeds give unrelated random streams
function mixSeed(seed) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h || 1;
}
export function makeMatch(seed) {
  return {
    phase: PHASE.WARMUP, phT: 0, live: 0, wr: 0, s0: 0, s1: 0, clock: 0, half: 1, dir0: 1, ko: 0, koFirst: 0,
    spType: 0, spTeam: 0, spTaker: -1, spX: 0, spY: 0, spWhy: 0, offs: 0, real: 0, matchLen: 240, rng: mixSeed(seed), goalS: 0, ai: 1,
    lastGoalTeam: -1, scorer: -1, req0: -1, req0T: 0, req1: -1, req1T: 0, gkc0: 0, gkc1: 0, cd: 0,
  };
}
export function createWorld(pitchId = 1, seed = 12345) {
  return { tick: 0, pitchId, players: [], ball: makeBall(), m: makeMatch(seed), events: [], replay: false };
}

// ---------------------------------------------------------------- formation

const SLOTS = {
  1: [[-0.3, 0]],
  2: [[-0.5, -0.15], [-0.05, 0.2]],
  3: [[-0.58, 0], [-0.15, -0.45], [0.0, 0.4]],
  4: [[-0.6, -0.35], [-0.6, 0.35], [-0.15, -0.45], [0.0, 0.3]],
  5: [[-0.62, -0.4], [-0.62, 0.4], [-0.35, 0], [-0.05, -0.45], [0.05, 0.4]],
};
export function slotOf(n, i) {
  if (SLOTS[n]) return SLOTS[n][i % n];
  const def = Math.ceil(n * 0.4), mid = Math.ceil((n - def) * 0.6), fwd = n - def - mid;
  const rows = [[def, -0.6], [mid, -0.25], [fwd, 0.05]];
  let k = i;
  for (const [cnt, a] of rows) {
    if (k < cnt) return [a, cnt === 1 ? 0 : -0.75 + 1.5 * (k / (cnt - 1))];
    k -= cnt;
  }
  return [-0.2, 0];
}
export function teamOutfield(w, team) {
  return w.players.filter((q) => q.team === team && q.role === ROLE.OUT);
}
export function slotIndex(w, p) {
  const out = teamOutfield(w, p.team);
  return [out.indexOf(p), out.length];
}

// ---------------------------------------------------------------- roster ops

export function addPlayer(w, spec) {
  const p = makePlayer(spec.id, spec.team, spec.role, spec.human, spec.hgt, spec.bld, spec.ft);
  w.players.push(p);
  w.players.sort((a, b) => a.id - b.id);
  spawnPlayer(w, p);
  return p;
}
export function removePlayer(w, id) {
  const i = w.players.findIndex((p) => p.id === id);
  if (i < 0) return;
  w.players.splice(i, 1);
  const b = w.ball;
  if (b.owner === id) { b.owner = -1; b.held = 0; }
  if (w.m.spTaker === id) w.m.spTaker = -1;
}
export function updatePlayerSpec(w, spec) {
  const p = pById(w, spec.id);
  if (!p) return addPlayer(w, spec);
  const moved = p.team !== spec.team || p.role !== spec.role;
  p.team = spec.team; p.role = spec.role; p.human = spec.human ? 1 : 0; p.hgt = spec.hgt; p.bld = spec.bld; p.ft = spec.ft ? 1 : 0;
  if (moved) {
    if (w.ball.owner === p.id) { w.ball.owner = -1; w.ball.held = 0; }
    spawnPlayer(w, p);
  }
  return p;
}
function spawnPlayer(w, p) {
  const pit = pitchOf(w), dir = teamDir(w, p.team);
  if (p.role === ROLE.GK) { p.x = -dir * (pit.L / 2 - 1); p.y = 0; }
  else {
    const [i, n] = slotIndex(w, p);
    const [a, b] = slotOf(n, Math.max(0, i));
    p.x = dir * Math.min(a, -0.08) * pit.L / 2; p.y = b * pit.W / 2 * 0.8;
  }
  p.vx = p.vy = p.vz = p.z = 0; p.face = dir > 0 ? 0 : Math.PI; p.st = ST.IDLE; p.stT = 0;
  p.px = p.x; p.py = p.y; p.pz = 0;
}

// ---------------------------------------------------------------- match control

function setPhase(w, ph) {
  w.m.phase = ph; w.m.phT = 0;
  w.events.push({ k: 'phase', ph });
}
function resumePhase(w) { setPhase(w, w.m.live ? PHASE.PLAY : PHASE.WARMUP); }

export function startMatch(w, matchLenSec) {
  const m = w.m;
  m.live = 1; m.s0 = 0; m.s1 = 0; m.clock = 0; m.half = 1; m.dir0 = 1; m.scorer = -1; m.lastGoalTeam = -1;
  m.matchLen = matchLenSec;
  m.koFirst = rnd(w) < 0.5 ? 0 : 1;
  startKickoff(w, m.koFirst);
  w.events.push({ k: 'whistle', n: 1 });
}
export function stopMatch(w) {
  w.m.live = 0;
  startKickoff(w, 0);
}

export function startKickoff(w, team) {
  const m = w.m, b = w.ball;
  setPhase(w, PHASE.KICKOFF);
  m.ko = team; m.spTaker = -1; m.spType = SP.KICKOFF;
  Object.assign(b, { x: 0, y: 0, z: BALL_R, vx: 0, vy: 0, vz: 0, spin: 0, ts: 0, owner: -1, held: 0, last: -1, lastTeam: -1, kt: 255, tgt: -1, atk: -1, atT: 0 });
  b.px = 0; b.py = 0; b.pz = BALL_R; b.sh = -1; b.nut = -1;
  placeKickoff(w);
}

function resetPlayerState(p) {
  p.vx = p.vy = p.vz = p.z = 0; p.st = ST.IDLE; p.stT = 0; p.hit = 0;
  p.chg = 0; p.chgBtn = 0; p.qa = 0; p.qt = 0; p.kcd = 0; p.tcd = 0; p.hold = 0; p.ai = 0; p.aiT = 0;
  p.tap = 0; p.tapT = 255; p.tm = 0;
}

function placeKickoff(w) {
  const pit = pitchOf(w), m = w.m;
  for (const team of [0, 1]) {
    const dir = teamDir(w, team);
    const out = teamOutfield(w, team);
    // most advanced slot takes the kick
    let kickerIdx = -1;
    if (team === m.ko && out.length) {
      let best = -9;
      out.forEach((p, i) => { const a = slotOf(out.length, i)[0]; if (a > best) { best = a; kickerIdx = i; } });
    }
    out.forEach((p, i) => {
      resetPlayerState(p);
      const [a, bb] = slotOf(out.length, i);
      let x = dir * Math.min(a * 0.9, -0.12) * pit.L / 2, y = bb * pit.W / 2 * 0.75;
      if (i === kickerIdx) { x = -dir * 0.45; y = 0.15; }
      else if (team !== m.ko) {
        const d = Math.hypot(x, y);
        if (d < pit.centerR + 0.8) { const k = (pit.centerR + 0.8) / (d || 1); x *= k; y *= k; if (Math.abs(x) < 1) x = -dir * (pit.centerR + 0.8); }
      }
      p.x = x; p.y = y; p.face = dir > 0 ? 0 : Math.PI;
      p.px = x; p.py = y; p.pz = 0;
    });
    for (const p of w.players) if (p.team === team && p.role === ROLE.GK) {
      resetPlayerState(p);
      p.x = -dir * (pit.L / 2 - 1); p.y = 0; p.face = dir > 0 ? 0 : Math.PI;
      p.px = p.x; p.py = p.y; p.pz = 0;
    }
  }
}

// Warm-up with nobody but humans in the outfield and AI keepers in goal:
// shooting practice. The keepers pick up every dead ball and serve it to a
// player (see the AI keeper) instead of the usual restarts. Any other warm-up
// is played by the rules – throw-ins, corners, goal kicks, free kicks, a
// kick-off by the team that conceded – just without a clock, a score or
// celebrations.
export function shootingPractice(w) {
  if (w.m.live) return false;
  let outfield = 0, aiKeeper = false;
  for (const p of w.players) {
    if (p.role === ROLE.GK) { if (!p.human) aiKeeper = true; } else if (!p.human) return false; else outfield++;
  }
  return outfield > 0 && aiKeeper;
}
// The ball in a keeper's hands to restart practice / the warm-up: that team's
// keeper, or the one nearest the ball (AI keepers only unless humansToo).
// False if there's none.
function keeperRestart(w, team, humansToo = false) {
  const b = w.ball;
  let gk = null, bd = 1e9;
  for (const p of w.players) {
    if (p.role !== ROLE.GK || (p.human && !humansToo)) continue;
    const d = p.team === team ? -1 : Math.hypot(p.x - b.x, p.y - b.y);
    if (d < bd) { bd = d; gk = p; }
  }
  if (!gk) return false;
  resetPlayerState(gk);
  Object.assign(b, { x: gk.x, y: gk.y, z: 1.0, vx: 0, vy: 0, vz: 0, spin: 0, ts: 0, owner: gk.id, held: 1, last: gk.id, lastTeam: gk.team,
    kt: 255, tgt: -1, sh: -1, dl: 0, nut: -1, atk: -1, atT: 0 });
  b.px = b.x; b.py = b.y; b.pz = b.z;
  w.m.spTaker = -1; w.m.wr = 0;
  resumePhase(w);
  return true;
}

const WARM_OUT = 36; // ticks a ball out of play in the warm-up is left to roll away
// The warm-up has no set pieces or kick-offs: a keeper (that team's after a
// goal, else the nearest) has the ball straight away; with no keeper on the
// pitch it's dropped back in at (x, y).
function warmRestart(w, team, x, y) {
  if (keeperRestart(w, team, true)) return;
  const b = w.ball, pit = pitchOf(w);
  Object.assign(b, { x: clamp(x, -pit.L / 2 + 1, pit.L / 2 - 1), y: clamp(y, -pit.W / 2 + 0.5, pit.W / 2 - 0.5), z: BALL_R,
    vx: 0, vy: 0, vz: 0, spin: 0, ts: 0, owner: -1, held: 0, kt: 255, tgt: -1, sh: -1, dl: 0, nut: -1, atk: -1, atT: 0 });
  b.px = b.x; b.py = b.y; b.pz = b.z;
  w.m.spTaker = -1; w.m.wr = 0;
  resumePhase(w);
}

// (why: 1 – a free kick for offside, for the banner)
function startSetPiece(w, type, team, x, y, why = 0) {
  const m = w.m;
  setPhase(w, PHASE.SETPIECE);
  m.spType = type; m.spTeam = team; m.spX = x; m.spY = y; m.spTaker = -1; m.spWhy = why; w.off = null;
  w.ball.owner = -1; w.ball.held = 0; w.ball.sh = -1;
  w.events.push({ k: 'whistle', n: type === SP.FREEKICK || type === SP.PENALTY ? 2 : 1 });
}

function takeSetPiece(w) {
  const m = w.m, b = w.ball, pit = pitchOf(w);
  const team = m.spTeam, dir = teamDir(w, team);
  if (shootingPractice(w) && keeperRestart(w, -1)) return;
  let taker = null;
  if (m.spType === SP.GOALKICK) taker = w.players.find((p) => p.team === team && p.role === ROLE.GK) || null;
  if (!taker) {
    let bd = 1e9;
    for (const p of w.players) {
      if (p.team !== team) continue;
      const d = Math.hypot(p.x - m.spX, p.y - m.spY) + (p.role === ROLE.GK ? 60 : 0);
      if (d < bd) { bd = d; taker = p; }
    }
  }
  Object.assign(b, { x: m.spX, y: m.spY, z: BALL_R, vx: 0, vy: 0, vz: 0, spin: 0, ts: 0, owner: -1, held: 0, kt: 255, tgt: -1, atk: -1, atT: 0 });
  b.px = b.x; b.py = b.y; b.pz = b.z;
  if (!taker) { resumePhase(w); return; }
  const gx = dir * pit.L / 2;
  let face;
  switch (m.spType) {
    case SP.THROWIN: face = Math.atan2(-Math.sign(m.spY), dir * 0.6); break;
    case SP.CORNER: face = Math.atan2(-m.spY, gx - dir * pit.penSpot - m.spX); break;
    case SP.PENALTY: face = Math.atan2(-m.spY, gx - m.spX); break;
    default: face = Math.atan2(-m.spY * 0.3, gx - m.spX);
  }
  resetPlayerState(taker);
  taker.face = face;
  const back = m.spType === SP.THROWIN ? 0.05 : 0.5;
  taker.x = m.spX - Math.cos(face) * back; taker.y = m.spY - Math.sin(face) * back;
  taker.px = taker.x; taker.py = taker.y; taker.pz = 0;
  b.owner = taker.id; b.held = m.spType === SP.THROWIN ? 1 : 0;
  b.last = taker.id; b.lastTeam = team;
  m.spTaker = taker.id; m.cd = 0;
  if (m.spType === SP.PENALTY) {
    const odir = -dir;
    for (const p of w.players) {
      if (p === taker) continue;
      if (p.team !== team && p.role === ROLE.GK) {
        resetPlayerState(p);
        p.x = gx - dir * 0.3; p.y = 0; p.face = odir > 0 ? 0 : Math.PI; p.px = p.x; p.py = p.y;
      } else if (inOwnBox(w, 1 - team, p.x, p.y, 1)) {
        p.x = gx - dir * (pit.boxD + 1.5); p.px = p.x;
      }
    }
  }
  if (m.spType === SP.GOALKICK) {
    for (const p of w.players) if (p.team !== team && inOwnBox(w, team, p.x, p.y, 0.5)) {
      p.x = -dir * (pit.L / 2 - pit.boxD - 1.5); p.px = p.x;
    }
  }
  resumePhase(w);
}

// how far the other team has to stay from the ball until it's played: 2 m at
// a throw-in, outside the box and arc at a penalty, otherwise the centre
// circle's radius (9.15 m on a full-size pitch)
function spRadius(w, type) {
  return type === SP.THROWIN ? 2 : type === SP.PENALTY ? 9 : Math.max(5.5, pitchOf(w).centerR);
}

function foul(w, offender, victim) {
  const m = w.m;
  victim.st = ST.FALLEN; victim.stT = 0; victim.stDur = 60;
  if (w.ball.owner === victim.id) { w.ball.owner = -1; w.ball.held = 0; }
  w.events.push({ k: 'foul', x: victim.x, y: victim.y });
  if (m.phase !== PHASE.PLAY && m.phase !== PHASE.WARMUP) return;
  if (!m.live && shootingPractice(w)) return; // shooting practice plays on
  const pit = pitchOf(w);
  if (inOwnBox(w, offender.team, victim.x, victim.y)) {
    const dir = teamDir(w, victim.team);
    startSetPiece(w, SP.PENALTY, victim.team, dir * (pit.L / 2 - pit.penSpot), 0);
  } else {
    startSetPiece(w, SP.FREEKICK, victim.team,
      clamp(victim.x, -pit.L / 2 + 1, pit.L / 2 - 1), clamp(victim.y, -pit.W / 2 + 1, pit.W / 2 - 1));
  }
}

export function requestPass(w, p) {
  if (p.team === 0) { w.m.req0 = p.id; w.m.req0T = 90; } else { w.m.req1 = p.id; w.m.req1T = 90; }
  w.events.push({ k: 'call', id: p.id });
}

// ---------------------------------------------------------------- actions

// target of a kick key -> kind of kick (the height travels separately)
export function kickKind(p, target) {
  switch (target) {
    case KT.MATE: return KICK.PASS;
    case KT.RUN: return KICK.THROUGH;
    case KT.GOAL: return (p.ib & BTN.R2) ? KICK.FINESSE : KICK.SHOT;
    case KT.SELF: return KICK.SELF;
  }
  return KICK.PASS;
}

// Flight time of a lofted ball over distance d, from a sensible pace that
// grows with distance: high balls float, mid-height ones are driven; power
// adds pace (a flatter, quicker ball).
export function loftTime(d, kh, power, capped = true) {
  // (a little brisker than before, but still a pace a man can take down)
  const vh = kh === KH.HIGH ? clamp(7.7 + 0.22 * d, 7.7, 14.8) + 2.5 * power : clamp(9.9 + 0.33 * d, 9.9, 16.5) + 2 * power;
  // A pass is lofted over the men in between, no higher: a long one is
  // driven flatter (quicker) rather than floated up into the sky – about 6 m
  // at the top for a high ball, 3.5 m for a chest-high one. (Punts and
  // clearances go up as high as they go: capped false.)
  const T = Math.max(0.35, d / vh);
  return capped ? Math.min(T, kh === KH.HIGH ? 2.2 : 1.6) : T;
}

// Top and back spin (b.ts: + topspin, - backspin): the ball's spin about the
// axis across its flight. Topspin pulls it down harder the faster it goes (a
// drive dips), backspin holds it up (it floats); it fades slowly in the air;
// at a bounce topspin skids on, backspin checks it up (and it bounces higher),
// and on the grass it's soon gone.
// (TS_PLAN: the share of that lift a lofted kick's plan counts on – the spin
// fades and the ball slows in the air)
export const TS_K = 0.15, TS_DECAY = 0.18, TS_PLAN = 0.75;
const bounceKeep = (ts) => clamp(0.88 + 0.07 * ts, 0.78, 0.96);
// The spin a kick puts on: a full-blooded drive with the laces – topspin, up
// to 1 at full power (it dips); a curler a little; a soft placed one none; a
// lofted pass is struck under the ball – backspin, it floats and stops on
// landing; a punt backspin, a drop kick on the half-volley topspin.
export function topspinFor(kind, kh, pw, tech, kc, fromHands) {
  if (fromHands) return kind === KICK.PUNT ? -0.3 : kind === KICK.DROP ? 0.4 : 0;
  if (tech !== ST.KICK) return 0;
  if (kind === KICK.SHOT || kind === KICK.FINESSE) {
    if (kh === KH.GROUND) return 0;
    return kc ? 0.25 : clamp((pw - 0.5) / 0.4, 0, 1);
  }
  if (kh !== KH.GROUND && (kind === KICK.PASS || kind === KICK.THROUGH || kind === KICK.LONG || kind === KICK.CLEAR)) return -0.45;
  return 0;
}

// Height the ball reaches after travelling d metres along the ground, launched
// with horizontal speed vh and vertical speed vz from height z0 – the same
// gravity and air drag as updateBall (-1 if it never gets there).
function heightAt(vh, vz, z0, d, ts = 0) {
  let x = 0, z = z0, h = vh, v = vz;
  for (let k = 0; k < 600; k++) {
    v -= (G + TS_K * ts * h) * DT; ts *= 1 - TS_DECAY * DT;
    const f = Math.max(0, 1 - AIR_K * Math.hypot(h, v) * DT);
    h *= f; v *= f;
    x += h * DT; z += v * DT;
    if (x >= d) return z;
    if (h < 0.5) break;
  }
  return -1;
}
// Vertical launch speed that brings the ball to height zt after d metres.
export function vzToReach(vh, z0, d, zt, ts = 0) {
  let lo = -4, hi = 22;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(vh, mid, z0, d, ts) < zt) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Height the ball should have when it reaches its target.
export function targetHeight(w, p, kind, kh) {
  if (kind === KICK.SHOT || kind === KICK.FINESSE) {
    return kh === KH.HIGH ? pitchOf(w).goalH - 0.4 : kh === KH.MID ? 1.15 : 0.22; // high: a little under the bar
  }
  const r = p.kt >= 0 ? pById(w, p.kt) : null;
  const head = r ? stOf(r).H * 0.93 : 1.75;
  return kh === KH.HIGH ? head : kh === KH.MID ? 1.0 : BALL_R;
}

// Where a running player will be after t seconds if they keep running
// (accelerating towards sprint/jog speed).
function runAhead(q, t) {
  const sp = Math.hypot(q.vx, q.vy);
  if (sp < 1.5) return [q.x + q.vx * t, q.y + q.vy * t];
  const s = stOf(q);
  const vmax = Math.max(sp, s.sprint); // (anyone can sprint when he must)
  const t1 = (vmax - sp) / s.accel;
  const d = t <= t1 ? sp * t + s.accel * t * t / 2 : sp * t1 + s.accel * t1 * t1 / 2 + vmax * (t - t1);
  return [q.x + q.vx / sp * d, q.y + q.vy / sp * d];
}

// Where a person's shot goes for a stick (world direction sx, sy, magnitude
// sm), the key's height kh and power pw: aimed where the stick points – the
// spot on the goal line along it, up to a metre wide of a post (to bend it
// back in with aftertouch: it goes there); pointing away from goal, that side
// of it. Then the holes: grouped by where the stick points – towards the
// goal, the part of it round that spot; out to a side, that half; none,
// anywhere – the best one there decides where it goes, a little inside the
// frame. Where it goes decides the bend (sideCurl): into the left part, the
// inside of the left foot bends it right, back in; into the right, the other
// way; the longer it's held the more (R2: wrapped round more). (Developer
// mode and the aim line show them with it.)
// How a kick bending kc (+ right on screen, - left) is struck: with his
// stronger foot (p.ft) – the inside when that's the way it bends it (a
// right-footer's inside bends it left), otherwise the outside of it (a
// right-footer bending it right: the trivela – less bend, a little less
// true, but away sooner); not bent, the laces
export function footFor(p, kc) {
  if (!kc) return FOOT.LACES;
  return (kc < 0) === !p.ft ? FOOT.INSIDE : FOOT.OUTSIDE;
}
export const OUTSIDE_CURL = 0.7, OUTSIDE_ERR = 1.15;
// the bend for a shot into ty, struck as his foot allows (sideCurl, less
// with the outside)
export const footCurl = (w, p, ty, pw, bend) => {
  const kc = sideCurl(w, p, ty, pw, bend);
  return footFor(p, kc) === FOOT.OUTSIDE ? kc * OUTSIDE_CURL : kc;
};

// (a person's strike: how far off it can go – launch's spread for a shot
// from d out at power pw, with his truer foot – and so how far inside the
// post he aims: 0.7 m close in, more from further out or flat out, so most
// stay on target – never more than 30% of the way in)
export const SHOT_ERR = 0.7;
function personPostIn(w, p, kind, pw, d, hw) {
  const err = (0.035 + 0.0016 * d + 0.00011 * d * d + 0.06 * pw * pw) * (kind === KICK.FINESSE ? 0.6 : 0.85) * SHOT_ERR;
  return clamp(0.8 * err * d, POST_IN, 0.3 * hw);
}

export function shotAim(w, p, kind, kh, pw, sx, sy, sm) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), b = w.ball, gx = dir * pit.L / 2;
  const hw = pit.goalW / 2;
  const postIn = personPostIn(w, p, kind, pw, Math.hypot(gx - b.x, b.y), hw), half = hw - postIn;
  let aimY = (Math.abs(b.y) < 0.8 ? (p.id % 2 ? 1 : -1) : -Math.sign(b.y)) * pit.goalW * 0.2;
  let span = null;
  if (sm > 0.3) {
    // The stick's side, as he faces the goal from where the ball is (the
    // same in every camera – screen-relative it can point across the pitch
    // at a slant): across to his left, the left part of the goal; to his
    // right, the right part – the further across, the further out (to a
    // little inside the post); at the goal (or back), the middle. (His right
    // is 90° anticlockwise of the way he faces: world +y attacking +x.)
    const fl = Math.hypot(gx - b.x, b.y) || 1, fx = (gx - b.x) / fl, fy = -b.y / fl;
    const lat = -fy * sx + fx * sy; // + to his right
    if (Math.abs(lat) > 0.25) {
      aimY = dir * Math.sign(lat) * half * Math.min(1, Math.abs(lat) / 0.7);
      span = aimY > 0 ? [0, hw] : [-hw, 0];
    } else { aimY = 0; span = [-hw * 0.45, hw * 0.45]; }
  }
  if (Math.abs(aimY) <= hw) {
    const bend = kind === KICK.FINESSE ? 1 : 0.8;
    const hole = shotHole(w, p, kind, kh, pw, 0, span, (ty) => footCurl(w, p, ty, pw, bend), aimY, null, postIn);
    if (hole) return { tx: gx, ty: hole.ty, kc: hole.kc, kf: footFor(p, hole.kc), hole };
  }
  return { tx: gx, ty: aimY, kc: 0, kf: FOOT.LACES, hole: null };
}

// Picks a target for a kick. Humans aim with the stick (PES-style assisted
// passing: the receiver closest to the stick direction gets it).
export function planKick(w, p, kind, power, tx, ty, tid = -1, kh) {
  const pit = pitchOf(w), dir = teamDir(w, p.team), b = w.ball;
  if (kh === undefined) kh = kind === KICK.LONG || kind === KICK.PUNT || kind === KICK.CLEAR ? KH.HIGH : kind === KICK.SHOT ? KH.MID : KH.GROUND;
  p.kk = kind; p.kp = clamp(power, 0, 1); p.kt = -1; p.kv = 0; p.kh = kh; p.kc = 0; p.kf = FOOT.LACES;
  if (tx !== undefined) { p.kx = tx; p.ky = ty; p.kt = tid; return; }
  const [sx, sy, sm] = stickOf(p);
  const ax = sm > 0.3 ? sx : Math.cos(p.face), ay = sm > 0.3 ? sy : Math.sin(p.face);
  if (kind === KICK.SHOT || kind === KICK.FINESSE) {
    const a = shotAim(w, p, kind, kh, p.kp, sx, sy, sm);
    p.kx = a.tx; p.ky = a.ty; p.kc = a.kc; p.kf = a.kf;
    return;
  }
  if (kind === KICK.SELF) {
    // pass to self: into the stick direction (or straight on), further with power
    const dist = 1.5 + 4.5 * power;
    p.kx = b.x + ax * dist; p.ky = b.y + ay * dist; p.kt = p.id;
    return;
  }
  if (kind === KICK.CLEAR) {
    p.kx = b.x + dir * (22 + 12 * power); p.ky = clamp(b.y * 1.3 + ay * 8, -pit.W / 2 + 3, pit.W / 2 - 3);
    return;
  }
  // a lofted pass towards team-mates in their box: a cross – to one of them
  // (roughly the way the stick points), met at head height; held long, to the
  // one further on, behind the first
  let best = null, bestScore = 1e9;
  if (kind === KICK.PASS && kh !== KH.GROUND) {
    const box = [];
    for (const q of w.players) {
      if (q === p || q.team !== p.team || q.role === ROLE.GK || !inOwnBox(w, 1 - p.team, q.x, q.y, 1)) continue;
      const dx = q.x - b.x, dy = q.y - b.y, d = Math.hypot(dx, dy);
      if (d > 5 && d < 45 && (dx * ax + dy * ay) / d > 0.3) box.push([d, q]);
    }
    if (box.length) {
      box.sort((u, v) => u[0] - v[0]);
      best = box[power > 0.65 ? box.length - 1 : 0][1];
      kh = KH.HIGH; p.kh = kh;
    }
  }
  // receiver selection (unless it's a cross)
  const cross = best;
  for (const q of w.players) {
    if (cross) break;
    if (q === p || q.team !== p.team) continue;
    const dx = q.x - b.x, dy = q.y - b.y, d = Math.hypot(dx, dy);
    if (d < 2 || d > (kind === KICK.LONG || kind === KICK.PUNT ? 70 : 45)) continue;
    const c = (dx * ax + dy * ay) / d;
    if (c < 0.55) continue;
    const score = (1 - c) * 30 + d * (kind === KICK.LONG || kind === KICK.PUNT ? 0.05 : 0.12) + (q.role === ROLE.GK ? 6 : 0);
    if (score < bestScore) { bestScore = score; best = q; }
  }
  if (best) {
    // Lead the receiver: search for the earliest meeting time t at which a
    // kick can put the ball where the runner will be, arriving at a pace the
    // runner can control.
    const sp = Math.hypot(best.vx, best.vy);
    const lofted = kh !== KH.GROUND || kind === KICK.LONG || kind === KICK.PUNT;
    const K = MU / CF;
    let lx = best.x, ly = best.y, vEnd = 6;
    let fb = null, fbErr = 1e9;
    for (let t = 0.2; t <= 4; t += 0.05) {
      [lx, ly] = runAhead(best, t);
      if (kind === KICK.THROUGH) {
        const lead = 1.0 + 2.0 * power;
        if (sp > 2) { lx += best.vx / sp * lead; ly += best.vy / sp * lead; } else lx += dir * lead;
      }
      const d = Math.hypot(lx - b.x, ly - b.y);
      if (lofted) {
        vEnd = loftTime(d, kh || KH.HIGH, power, kind !== KICK.PUNT && kind !== KICK.CLEAR && kind !== KICK.THROW);
        if (vEnd <= t) { fb = null; break; }
      } else {
        const v0 = (d + K * t) * CF / (1 - Math.exp(-CF * t)) - K;
        vEnd = (v0 + K) * Math.exp(-CF * t) - K;
        const want = kind === KICK.THROUGH
          ? Math.max(3.2 + 0.065 * d + 2 * power, (0.75 + 0.3 * power) * sp)
          : Math.max(Math.min(15, 5 + 0.31 * d) + 3.75 * power, 0.95 * sp);
        if (v0 <= 28 && vEnd > 0 && vEnd <= want) { fb = null; break; }
        const e = Math.abs(vEnd - want) + (v0 > 28 ? 100 : 0);
        if (e < fbErr) { fbErr = e; fb = [lx, ly, vEnd]; }
      }
    }
    if (fb) [lx, ly, vEnd] = fb;
    if (kind === KICK.PASS || kind === KICK.THROUGH) {
      // The hole: at the height of the key pressed, the way round (or over)
      // the men in between that gets to him first – angled, or bent with the
      // inside of the foot (more curl costs pace) – as long as he can still
      // get to it. With no clear hole, the one that gives it the best chance.
      const hole = passHole(w, p, best, kind, kh, lx, ly, lofted ? vEnd : Math.max(1.5, vEnd), [0, -0.5, 0.5, -1, 1]);
      if (hole) { lx = hole.tx; ly = hole.ty; p.kc = hole.kc; p.kf = footFor(p, hole.kc); }
    }
    p.kv = lofted ? vEnd : Math.max(1.5, vEnd); // lofted: flight time; ground: arrival pace
    p.kx = clamp(lx, -pit.L / 2 - 1, pit.L / 2 + 1); p.ky = clamp(ly, -pit.W / 2 + 0.5, pit.W / 2 - 0.5); p.kt = best.id;
  } else {
    const dist = kind === KICK.LONG || kind === KICK.PUNT ? 22 + 26 * power : kind === KICK.THROUGH ? 12 + 16 * power : 8 + 16 * power;
    p.kx = b.x + ax * dist; p.ky = b.y + ay * dist;
  }
}

// A keeper's distribution from his hands: rolled out along the ground, thrown
// (sidearm – flat and quick – up to SIDEARM_MAX, overarm further), a drop kick
// (dropped, struck on the half-volley as it comes up: low and driven) beyond
// throwing range, or punted (high and long).
export const SIDEARM_MAX = 20, THROW_MAX = 34;

// A shot off the ground with his back to the goal: he turns with the ball
// first and strikes it at full power – but the turn takes time (more for a
// big, heavy man) and he can be tackled meanwhile; or close in, a quick tap
// back-heels it without turning – weak. (A ball in the air: an overhead kick,
// see tryQueued.)
const TURN_OK = 0.9;   // rad off the shooting line he still strikes it at
const TURN_K = 0.65;   // his turn rate with the ball, as a share of his agility
const HEEL_MIS = 1.9;  // rad off the line: it has to go back past him
const HEEL_MAX = 10;   // m to the goal at most
const HEEL_PW = 0.3;   // a quick tap: the gauge under this

// how far off the line to his target he'd be striking the ball (at bx, by) facing `face`
const shotMis = (p, face, bx, by) => Math.abs(angDiff(face, Math.atan2(p.ky - by, p.kx - bx)));
function shotWay(p, face, bx, by) {
  if (p.kk !== KICK.SHOT && p.kk !== KICK.FINESSE) return KQ.PLAIN;
  const mis = shotMis(p, face, bx, by);
  if (mis > HEEL_MIS && p.kp < HEEL_PW && Math.hypot(p.kx - bx, p.ky - by) <= HEEL_MAX) return KQ.HEEL;
  return mis > TURN_OK ? KQ.TURN : KQ.PLAIN;
}

// wound: ticks of wind-up already shown while the key was held – the foot
// comes through that much sooner (straight away after a proper hold).
export function startKick(w, p, kind, power, quick = false, tx, ty, tid = -1, kh, wound = 0) {
  const b = w.ball;
  const fromHands = b.owner === p.id && b.held === 1;
  planKick(w, p, kind, power, tx, ty, tid, kh);
  if (fromHands && kind === KICK.THROW && p.kh === KH.MID && w.m.spTaker !== p.id
    && Math.hypot(p.kx - b.x, p.ky - b.y) > THROW_MAX) p.kk = kind = KICK.DROP;
  let contact;
  if (fromHands) contact = kind === KICK.PUNT ? 12 : kind === KICK.DROP ? 15 : 10;
  else if (kind === KICK.SHOT || kind === KICK.FINESSE) contact = quick ? 3 : 7;
  else if (kind === KICK.LONG || kind === KICK.CLEAR) contact = quick ? 3 : 6;
  else contact = quick ? 2 : 4;
  if (!fromHands && wound > 0) contact = Math.max(1, contact - wound);
  if (p.kf === FOOT.OUTSIDE) contact = Math.max(1, contact - 2); // (a flick of the outside of the foot: away sooner)
  p.st = fromHands && kind !== KICK.PUNT && kind !== KICK.DROP ? ST.THROW : ST.KICK;
  p.kq = p.st === ST.KICK && b.owner === p.id && !fromHands ? shotWay(p, p.face, b.x, b.y) : KQ.PLAIN;
  if (p.kq === KQ.HEEL) contact = Math.min(contact, 4); // a flick
  // R2 with a pass key: the no-look pass – looking the other way, struck
  // without turning to it; a touch less true, but they read it late (see
  // the AI's reacting)
  if (p.kq === KQ.PLAIN && p.st === ST.KICK && !fromHands && (kind === KICK.PASS || kind === KICK.THROUGH) && ((p.ib | p.pb) & BTN.R2) && w.m.spTaker !== p.id) { // (both let go at once: still meant)
    p.kq = KQ.NOLOOK;
    w.events.push({ k: 'trick', name: 'No-look pass', q: -1, id: p.id, x: p.x, y: p.y });
  }
  p.stT = 0; p.stA = contact; p.stDur = contact + (fromHands ? 12 : 11); p.stB = 0; p.hit = 0;
  p.chgBtn = 0; p.chg = 0; p.qa = 0; p.qt = 0;
}

// packed: kick target | height << 3 (see constants)
function beginOwnKick(w, p, packed, power, quick) {
  const b = w.ball, m = w.m;
  const target = packed & KICK_MASK;
  if (target === KT.CTRL) return; // (the control key is no kick)
  let kh = (packed >> 3) & 3;
  const held = b.held === 1 && b.owner === p.id;
  const throwIn = m.spTaker === p.id && m.spType === SP.THROWIN;
  const pen = m.spTaker === p.id && m.spType === SP.PENALTY;
  let kind;
  if (throwIn) kind = kh === KH.GROUND ? KICK.THROW : KICK.LONG;
  else if (held) kind = kh === KH.HIGH || target === KT.GOAL ? KICK.PUNT : KICK.THROW; // ground: rolled; mid: thrown (or a drop kick, see startKick)
  else if (pen) kind = (p.ib & BTN.R2) ? KICK.FINESSE : KICK.SHOT;
  else kind = kickKind(p, target);
  if (kind === KICK.PUNT) kh = KH.HIGH;
  // the wind-up is played while the key is held (see the renderer), so on
  // release the foot meets the ball almost at once
  const wound = p.chgBtn && b.owner === p.id && !held ? p.tapH : 0;
  startKick(w, p, kind, power, quick, undefined, undefined, -1, kh, wound);
}

// ---------------------------------------------------------------- technique moves

function touchedBy(w, p) {
  const b = w.ball;
  b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.sh = -1; b.atT = 0; b.spin = 0; b.ts = 0;
  invalidatePath(w);
}

// W / L2 – "pass to self" – while dribbling. The stick relative to the
// player's facing picks the move: left/right = step-over feint, back =
// drag-back (both instant); none or forward is charged like a kick and fires on
// release (see beginLift). Agility (from the avatar's build) sharpens them.
export function skillFromStick(p) {
  const [sx, sy, sm] = stickOf(p);
  if (sm <= 0.3) return 0;
  const fx = Math.cos(p.face), fy = Math.sin(p.face);
  const fwd = sx * fx + sy * fy, side = -fy * sx + fx * sy; // side > 0: to the left
  if (fwd > 0.7) return 0;
  if (fwd < -0.5) return SKILL.DRAGBACK;
  return side > 0 ? SKILL.FEINT_L : SKILL.FEINT_R;
}

export function beginSkill(w, p, kind) {
  const s = stOf(p);
  const [sx, sy] = stickOf(p);
  const fx = Math.cos(p.face), fy = Math.sin(p.face);
  const agil = clamp((s.turn - 7.8) / 6.5, 0, 1);
  p.st = ST.SKILL; p.stT = 0; p.stA = kind; p.stB = 0; p.hit = 0;
  p.chgBtn = 0; p.chg = 0; p.qa = 0;
  if (kind === SKILL.FEINT_L || kind === SKILL.FEINT_R) {
    // step-over and a sideways shift with the ball; close defenders may bite
    p.stDur = 18;
    const side = kind === SKILL.FEINT_L ? 1 : -1;
    const lat = 3.4 + 1.6 * agil;
    const fwd = Math.max(0, p.vx * fx + p.vy * fy) * 0.6;
    p.vx = fx * fwd - fy * side * lat; p.vy = fy * fwd + fx * side * lat;
    for (const o of w.players) {
      if (o.team === p.team) continue;
      const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy);
      if (d > 3 || (Math.cos(o.face) * dx + Math.sin(o.face) * dy) / (d || 1) < 0.2) continue;
      o.tcd = Math.max(o.tcd, 22);
      const chance = clamp(0.3 + (s.turn - stOf(o).turn) * 0.05 + agil * 0.15, 0.1, 0.7);
      if (isFree(o) && rnd(w) < chance) { o.st = ST.STUMBLE; o.stT = 0; o.stDur = 16; }
    }
    w.events.push({ k: 'feint', x: p.x, y: p.y, id: p.id });
  } else if (kind === SKILL.DRAGBACK) {
    // sole the ball back and spin round with it
    p.stDur = Math.round(17 - 5 * agil);
    p.stB = (-fy * sx + fx * sy) >= 0 ? 1 : -1; // turn towards the stick side
    p.vx *= 0.4; p.vy *= 0.4;
  }
}

// The trick key (R): the trick the moment calls for – done well or not by
// when it's pressed (p.kp: 1 just right, 0 missed):
//  * the ball at his feet – best right at his foot, a touch away it comes off
//    loose – by the stick against the way he faces: to a side, an ELASTICO
//    (the outside of the foot takes it out the other way, the inside snaps it
//    back across to the stick side – a man close in front bites); diagonally
//    ahead, LA CROQUETA (rolled across from one foot to the other and away on
//    the diagonal past a man going in for it); back, a BACK-HEEL FLICK (off
//    his heel to a team-mate behind him, or into the space there as he spins
//    after it – read late, as a no-look pass); forward or none, a RAINBOW
//    flick (rolled up the back of the leg and flicked over his head, landing
//    ahead);
//  * a ball dropping to him, the stick pushed – his own or a bouncing one –
//    the SOMBRERO (best at ~0.8 m: flicked up over the head of a man in front
//    the way the stick points, to come down a few metres on);
//  * his own ball in the air, dropping – AROUND THE WORLD towards his foot
//    (best at ~0.7 m: the foot goes round it, then keeps it up) or a NECK
//    STALL towards his head (best a metre above the back of his neck: caught
//    there; F or R pops it back over his head) – too early or too late, missed.
// (The no-look pass is R2 with a pass key: see startKick.)
const TRICK_NAMES = {
  [SKILL.ELASTICO]: 'Elastico', [SKILL.RAINBOW]: 'Rainbow', [SKILL.AROUND]: 'Around the world', [SKILL.NECK]: 'Neck stall',
  [SKILL.CROQUETA]: 'La croqueta', [SKILL.HEEL]: 'Back-heel flick', [SKILL.SOMBRERO]: 'Sombrero',
};
export function beginTrick(w, p) {
  const b = w.ball, s = stOf(p);
  if (!isFree(p) || p.z > 0 || w.m.spTaker === p.id) return;
  const start = (kind, dur, q, side = 0) => {
    p.st = ST.SKILL; p.stT = 0; p.stA = kind; p.stB = side; p.stDur = dur; p.hit = 0; p.kp = q;
    p.chgBtn = 0; p.chg = 0; p.qa = 0;
    w.events.push({ k: 'trick', name: TRICK_NAMES[kind], q, id: p.id, x: p.x, y: p.y });
  };
  const [sx, sy, sm] = stickOf(p), fx = Math.cos(p.face), fy = Math.sin(p.face);
  if (b.owner === p.id && !b.held) {
    const lat = sm > 0.3 ? -fy * sx + fx * sy : 0, fwd = sm > 0.3 ? fx * sx + fy * sy : 1; // (lat +: to his left)
    const q = clamp(1 - (Math.hypot(b.x - p.x, b.y - p.y) - 0.5) / 0.35, 0, 1);
    if (fwd < -0.5) start(SKILL.HEEL, 16, q);
    else if (Math.abs(lat) > 0.6 && fwd > 0.45) start(SKILL.CROQUETA, 14, q, Math.sign(lat));
    else if (Math.abs(lat) > 0.6) start(SKILL.ELASTICO, 16, q, Math.sign(lat));
    else { start(SKILL.RAINBOW, 22, q); p.kv = Math.hypot(p.vx, p.vy); } // (kv: his pace going into it – he jogs on through it)
    return;
  }
  const at = (z) => (b.vz + Math.sqrt(b.vz * b.vz + 2 * G * Math.max(0, b.z - z))) / G; // (when it's down to z)
  const neckZ = s.H * 0.66, dBall = Math.hypot(b.x - p.x, b.y - p.y);
  if (b.owner < 0 && b.vz < 0 && sm > 0.3 && b.z > 0.3 && b.z < Math.min(1.3, neckZ + 0.3) && dBall < 1.1) {
    // the sombrero: flicked up the way the stick points (kx, ky: where to)
    const q = clamp(1 - Math.abs(b.z - 0.8) / 0.3, 0, 1), tc = Math.max(2, Math.round(at(0.35) / DT));
    start(SKILL.SOMBRERO, tc + 12, q); p.stB = tc;
    p.kx = sx; p.ky = sy; p.vx *= 0.7; p.vy *= 0.7;
    return;
  }
  if (b.owner < 0 && b.last === p.id && b.kt < 90 && b.vz < 0 && dBall < 1.0) {
    if (b.z < neckZ + 0.3) {
      const q = clamp(1 - Math.abs(b.z - 0.7) / 0.25, 0, 1), tc = Math.max(2, Math.round(at(0.25) / DT));
      start(SKILL.AROUND, tc + 10, q); p.stB = tc;
    } else {
      const q = clamp(1 - Math.abs(b.z - neckZ - 1.0) / 0.45, 0, 1), tc = Math.max(2, Math.round(at(neckZ) / DT));
      start(SKILL.NECK, tc + 150, q); p.stB = tc;
    }
    p.vx *= 0.5; p.vy *= 0.5;
  }
}

// Off the back of his neck, F or R: popped back over his head to come down in
// front of him (keepy-ups on); left there, after a while he straightens and
// it rolls off down his back.
function neckRelease(w, p, pop) {
  const b = w.ball, fx = Math.cos(p.face), fy = Math.sin(p.face);
  b.last = p.id; b.lastTeam = p.team; b.kt = 0; b.tgt = p.id; b.dl = 0; b.sh = -1;
  if (pop) { b.vz = 4.2; b.vx = p.vx + fx * 0.9; b.vy = p.vy + fy * 0.9; w.events.push({ k: 'kick', x: b.x, y: b.y, z: b.z, v: 3, id: p.id }); }
  else { b.vz = 0.6; b.vx = -fx * 1.4; b.vy = -fy * 1.4; }
  p.hit = 0; p.st = ST.IDLE; p.stT = 0; p.kcd = 6;
  invalidatePath(w);
}

// Where a trick has the ball at his feet: [ahead, to his left, up] (null: the
// ordinary dribble)
function trickBall(o) {
  if (o.st !== ST.SKILL) return null;
  const t = o.stT, e = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
  if (o.stA === SKILL.ELASTICO) {
    // out to the other side with the outside of the foot, snapped back across
    const out = -o.stB * 0.3, back = o.stB * 0.38;
    return [0.42 + 0.08 * e(t / 6), t < 6 ? out * e(t / 6) : out + (back - out) * e((t - 6) / 7), BALL_R];
  }
  if (o.stA === SKILL.CROQUETA && t < 8) {
    // rolled across from the one foot to the other
    return [0.36, o.stB * (-0.12 + 0.4 * e(t / 5)), BALL_R];
  }
  if (o.stA === SKILL.HEEL && t < 6) {
    // stepped over: the heel comes back onto it
    return [0.42 - 0.38 * e(t / 5), 0, BALL_R];
  }
  if (o.stA === SKILL.RAINBOW && t < 10) {
    // drawn back between his feet and rolled up the back of his leg
    return [0.42 - 0.6 * e(t / 7), 0, BALL_R + 0.25 * e((t - 5) / 5)];
  }
  return null;
}

// Pass to self from the feet, on release of a SELF key: GROUND knocks it on
// along the stick (or straight on), MID lifts it to chest height, HIGH flicks it
// up to head height or over a challenge – further and higher with the hold.
export function beginLift(w, p, power, kh = KH.HIGH) {
  const b = w.ball, s = stOf(p);
  const [sx, sy, sm] = stickOf(p);
  const fx = Math.cos(p.face), fy = Math.sin(p.face);
  const ux = sm > 0.3 ? sx : fx, uy = sm > 0.3 ? sy : fy;
  const forward = sm > 0.3 && sx * fx + sy * fy > 0.7;
  const sp = Math.hypot(p.vx, p.vy);
  p.st = ST.SKILL; p.stT = 0; p.stB = 0; p.hit = 0;
  p.chgBtn = 0; p.chg = 0; p.qa = 0;
  b.owner = -1; b.held = 0;
  if (kh === KH.GROUND) {
    // knock-on: push it ahead along the ground and burst after it
    p.stA = SKILL.KNOCK; p.stDur = 8;
    // a tap just nudges it ahead of him; a long hold sends it on further than
    // he can sprint (scaled with how quick he is)
    const quick = Math.pow(s.sprint / 8.8, 1.6); // a quicker player needs it knocked further
    const v = sp * 0.8 + 0.6 + (11 - 4.5 * power) * power * (1 + (quick - 1) * power);
    b.vx = ux * v; b.vy = uy * v; b.vz = 0.4;
    p.kcd = 14;
    const burst = Math.min(s.sprint * 1.06, sp + 1.6);
    p.vx = ux * burst; p.vy = uy * burst;
    w.events.push({ k: 'kick', x: b.x, y: b.y, z: b.z, v: 6, id: p.id });
  } else {
    // lift: straight up (keepy-up) or scooped ahead over a challenge – from
    // where the ball is (no jump to his foot): it comes down just in front of
    // where he'll be, pushed on with the stick
    p.stA = SKILL.LIFT; p.stDur = 16;
    b.z = Math.max(b.z, BALL_R + 0.02);
    const vz = kh === KH.HIGH ? 4.2 + 3.5 * power : 2.8 + 1.6 * power, T = 2 * vz / G;
    const push = forward ? 1.5 + 4 * power : sm > 0.3 ? 1.0 : 0;
    b.vz = vz;
    b.vx = (p.x + p.vx * T + fx * 0.45 - b.x) / T + ux * push; b.vy = (p.y + p.vy * T + fy * 0.45 - b.y) / T + uy * push;
    p.kcd = 10;
    w.events.push({ k: 'kick', x: b.x, y: b.y, z: b.z, v: 2 + 4 * power, id: p.id });
  }
  touchedBy(w, p);
  b.tgt = p.id; // it's a pass to self: the receive assist helps chase it
}

export function beginSlide(w, p) {
  if (!isFree(p) || p.z > 0) return;
  const sp = Math.min(Math.max(Math.hypot(p.vx, p.vy), 5) + 2.2, 9.5);
  p.st = ST.SLIDE; p.stT = 0; p.stDur = 50; p.stA = 0; p.stB = 0; p.hit = 0;
  p.vx = Math.cos(p.face) * sp; p.vy = Math.sin(p.face) * sp;
  p.tcd = 70; p.chgBtn = 0; p.qa = 0;
  w.events.push({ k: 'slide', x: p.x, y: p.y });
}

// A slide to keep a ball in that's on its way out: along the grass to where
// it crosses, the foot hooking it back into the pitch (stA 1)
export function beginKeepIn(w, p, ang) {
  if (!isFree(p) || p.z > 0) return;
  p.face = ang;
  beginSlide(w, p);
  p.stA = 1;
}

export function beginTackle(w, p) {
  if (!isFree(p) || p.tcd > 0) return;
  p.st = ST.TACKLE; p.stT = 0; p.stA = 5; p.stDur = 18; p.hit = 0;
  const sp = Math.max(Math.hypot(p.vx, p.vy), 3.5);
  p.vx = Math.cos(p.face) * sp; p.vy = Math.sin(p.face) * sp;
  p.tcd = 36;
}

// tArr: seconds until the ball reaches the keeper, dist: how far along the dive
// direction the ball will cross. The dive is sized to arrive in time but can
// never exceed the keeper's physical dive speed / spring.
export function beginDive(w, p, ang, height, tArr = 0.45, dist = Infinity) {
  if (!isFree(p) || p.z > 0) return;
  const s = stOf(p);
  p.st = ST.DIVE; p.stT = 0; p.stDur = 54; p.stA = ang; p.stB = clamp(height, 0, 2.4); p.hit = 0;
  const lateral = Math.abs(Math.sin(angDiff(p.face, ang)));
  const t = clamp(tArr, 0.18, 0.7);
  let cap = s.diveSpeed * (0.55 + 0.45 * lateral);
  // a keeper who is set dives at full stretch; one caught running (forwards,
  // or the wrong way) can't push off properly
  const v = Math.hypot(p.vx, p.vy);
  if (v > 0.5) cap *= clamp(1 - 0.07 * (v - (p.vx * Math.cos(ang) + p.vy * Math.sin(ang))), 0.6, 1.05);
  // the body goes up at most ~0.75 m; the rest of the height is reached by
  // diving diagonally – hands up, feet low (see diveReach) – which costs
  // sideways reach, so he has to travel that much further
  const rise = clamp((p.stB - 0.6) * 0.5, 0, Math.min(0.75, 0.25 + s.jump));
  // a low ball just out of reach: no spring – the legs give way and he
  // collapses sideways onto it (quicker down, and up again, than a full dive)
  const collapse = p.stB < 0.5 && dist < 1.7;
  let spd = cap;
  if (Number.isFinite(dist)) spd = collapse ? clamp(Math.max(0, dist - 0.4) / t * 1.1, 1.0, cap * 0.6) : clamp(Math.max(0, dist - 0.5) / t * 1.1, 1.5, cap);
  p.vx = Math.cos(ang) * spd; p.vy = Math.sin(ang) * spd; p.spr = 0;
  p.vz = collapse ? 0.45 : rise > 0.05 ? Math.min(4.2, rise / t + 0.5 * G * t) : 1.2;
  // in the air for the flight, then on the ground: a full-stretch or high
  // dive puts him down for longer than a quick hop (the renderer reads how
  // big a dive it was from stDur – see DIVE_BASE)
  // (how big a dive: how far across he throws himself – a ball within ~1.8
  // m of him is a short dive, gathered in both hands, one further off a full
  // stretch, the top hand to it (see fullDive) – or how high)
  const big = Math.max(Number.isFinite(dist) ? clamp((dist - 1.0) / 1.4, 0, 1) : spd / s.diveSpeed, clamp(rise / 1.2, 0, 1));
  p.stDur = Math.round(2 * p.vz / G * 60) + DIVE_BASE + Math.round(DIVE_SPAN * big);
  p.chgBtn = 0; p.qa = 0;
  w.events.push({ k: 'dive', x: p.x, y: p.y });
}

export const DIVE_BASE = 18, DIVE_SPAN = 34; // ticks down after a dive: quick hop .. full stretch
// How big a dive was (0 a hop .. 1 full stretch, from its length – as the
// renderer draws it), and whether it's a full-stretch one (one hand to it)
export const diveSize = (p) => clamp((p.stDur - 2 * DIVE_BASE) / DIVE_SPAN, 0, 1);
export const fullDive = (p) => diveSize(p) > 0.55;

// A diving keeper's reach, from his hips to his fingertips, in the plane of
// his dive: [hip height, angle of the line above horizontal, its length]. For
// a high ball the line tilts up so his hands get to the ball's height (the
// body itself only goes up so far); he levels out as he lands. Given the ball,
// the arms swing up to ~35 degrees up or down from that towards it.
export function diveReach(p, s, ball) {
  // the arms come up and out over the first ~0.12 s as he pushes off
  const reach = (0.55 * s.H + s.diveReach * 0.5) * clamp(0.6 + p.stT / 7 * 0.4, 0.6, 1);
  const z0 = p.z + 0.35;
  const level = p.stT < 6 ? 1 : clamp(p.z / 0.12, 0, 1); // levels out as he lands
  let el = Math.asin(clamp((p.stB + 0.05 - z0) / reach, 0.03, 0.85)) * level;
  if (ball) {
    const along = (ball.x - p.x) * Math.cos(p.stA) + (ball.y - p.y) * Math.sin(p.stA);
    el = clamp(Math.atan2(ball.z - z0, Math.max(0.1, along)), el - 0.6, el + 0.6);
  }
  return [z0, el, reach];
}

// AI kick accuracy and keeper handling by the room's AI level (Casual / Normal / Pro)

// ---------------------------------------------------------------- blocking

// A fast ball (shot, pass, clearance) about to pass p within the next 0.7 s:
// the closest point of its flight p could get a leg, the body or the head to.
const BLOCK_REACH = 1.25;
export function blockPlan(w, p) {
  const b = w.ball, s = stOf(p);
  if (b.owner >= 0 || Math.hypot(b.vx, b.vy) < 8) return null;
  if (b.last === p.id && b.kt < 15) return null;
  const pts = ballPath(w);
  let best = null;
  for (let k = 1; k <= 21; k++) {
    const q = pts[k], t = k * PATH_H;
    if (q.z > s.reach + 0.2) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < BLOCK_REACH + Math.min(t, 0.3) * 3.5 && (!best || d < best.d)) best = { t, x: q.x, y: q.y, z: q.z, d };
  }
  return best;
}

// Block rather than play it: a hard-hit opposing ball, or a shot at our goal.
// (Crosses and ordinary passes are met with a header / first-time kick.)
export function wantsBlock(w, p) {
  const b = w.ball;
  if (b.owner >= 0 || b.lastTeam < 0 || b.lastTeam === p.team) return false;
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > 16) return true;
  if (sp < 10) return false;
  const pit = pitchOf(w), gx = -teamDir(w, p.team) * pit.L / 2;
  const t = (gx - b.x) / b.vx;
  return t > 0 && t < 2 && Math.abs(b.y + b.vy * t) < pit.goalW / 2 + 1.5;
}

// Throw a leg, the body or the head (jumping) into the ball's path. The player
// squares up to the ball; the limb's target is kept in kx/ky (ground point) and
// stB (height) for the contact test and the renderer's leg IK.
export function beginBlock(w, p, plan) {
  if (!isFree(p) || p.z > 0) return false;
  const b = w.ball, s = stOf(p);
  const ang = Math.atan2(plan.y - p.y, plan.x - p.x);
  p.st = ST.BLOCK; p.stT = 0; p.stDur = 30; p.hit = 0;
  p.stA = ang; p.stB = clamp(plan.z, 0, 2.8);
  p.kx = plan.x; p.ky = plan.y;
  p.chgBtn = 0; p.chg = 0; p.qa = 0;
  p.face = Math.atan2(-b.vy, -b.vx);
  // step towards the line; the limb covers the rest
  const t = clamp(plan.t, 0.12, 0.5);
  const step = clamp(plan.d - (plan.z < 0.8 ? 0.95 : 0.4), 0, 1.6);
  const v = Math.min(step / t, 5.5);
  p.vx = Math.cos(ang) * v; p.vy = Math.sin(ang) * v;
  // a high ball: jump to get the head to it
  const rise = plan.z - s.H * 0.9;
  if (rise > 0.05) p.vz = Math.min(Math.sqrt(2 * G * (s.jump + 0.05)), rise / t + 0.5 * G * t);
  w.events.push({ k: 'blockgo', x: p.x, y: p.y, id: p.id });
  return true;
}

// The limb used for a block, as a segment [x0,y0,z0, x1,y1,z1, radius].
function blockLimb(p, s) {
  const ca = Math.cos(p.stA), sa = Math.sin(p.stA);
  const d = Math.hypot(p.kx - p.x, p.ky - p.y);
  const ext = clamp((p.stT - 1) / 5, 0, 1); // swings out over a few ticks
  if (p.stB < 0.8) {
    // leg: from the hip out to the foot at the ball's height
    const L = Math.min(d, 0.95) * ext;
    return [p.x, p.y, p.z + s.H * 0.42, p.x + ca * L, p.y + sa * L, p.z + clamp(p.stB, 0.1, 0.8) * ext + s.H * 0.42 * (1 - ext), 0.16];
  }
  if (p.stB < s.H * 0.85) {
    // body: lean in with the chest / thigh
    const L = Math.min(d, 0.55) * ext;
    return [p.x, p.y, p.z + 0.5, p.x + ca * L, p.y + sa * L, p.z + Math.min(p.stB + 0.2, s.H * 0.85), 0.24];
  }
  // head: jumping into it
  const L = Math.min(d, 0.3) * ext;
  return [p.x, p.y, p.z + s.H * 0.6, p.x + ca * L, p.y + sa * L, p.z + s.H * 0.97, 0.17];
}

// Swept ball vs player bodies, so a hard shot can't pass through someone
// standing in its way. Players who could simply control the ball are left to
// possession(); keepers in their box with the catch key are handled by gkSave().
const BODY_R = 0.24;
function blockContacts(w) {
  const b = w.ball;
  if (b.owner >= 0 || b.held) return;
  const mx = b.x - b.px, my = b.y - b.py, mz = b.z - b.pz;
  for (const p of w.players) {
    if (p.st === ST.FALLEN || p.st === ST.DIVE || p.st === ST.SLIDE) continue;
    if (b.last === p.id && b.kt < 10) continue;
    if (p.st === ST.CONTROL) continue; // taking it on a part / just has (see cushion)
    if (b.nut === p.id && b.z < 0.6) continue;      // it's gone past (or through) him
    if (p.role === ROLE.GK && catchKey(p) && inOwnBox(w, p.team, p.x, p.y, 0.6) && inOwnBox(w, p.team, b.x, b.y, 0.3)) continue;
    const rs = Math.hypot(b.vx - p.vx, b.vy - p.vy, b.vz - p.vz);
    const blocking = p.st === ST.BLOCK && !p.hit && p.stT >= 2 && p.stT <= 22;
    if (!blocking && (rs < 9 || (canControl(p) && rs < 15))) continue;
    if (Math.hypot(b.x - p.x, b.y - p.y) > 2.5 + Math.hypot(mx, my)) continue;
    const s = stOf(p);
    const segs = [[p.x, p.y, p.z + 0.15, p.x, p.y, p.z + s.H * 0.95, BODY_R]];
    if (blocking) segs.push(blockLimb(p, s));
    for (let i = 1; i <= 4; i++) {
      const u = i / 4, bx = b.px + mx * u, by = b.py + my * u, bz = b.pz + mz * u;
      for (const g of segs) {
        const [cx, cy, cz] = closestOnSeg(bx, by, bz, g);
        let nx = bx - cx, ny = by - cy, nz = bz - cz;
        const d = Math.hypot(nx, ny, nz);
        if (d > g[6] + BALL_R) continue;
        if (d < 1e-6) { nx = -b.vx; ny = -b.vy; nz = 0; }
        const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        deflect(w, p, nx, ny, nz, blocking && g !== segs[0]);
        b.x = cx + nx * (g[6] + BALL_R + 0.01); b.y = cy + ny * (g[6] + BALL_R + 0.01); b.z = Math.max(BALL_R, cz + nz * (g[6] + BALL_R + 0.01));
        if (blocking) p.hit = 1;
        return;
      }
    }
  }
}

function closestOnSeg(px, py, pz, g) {
  const vx = g[3] - g[0], vy = g[4] - g[1], vz = g[5] - g[2];
  const l2 = vx * vx + vy * vy + vz * vz;
  const t = l2 > 0 ? clamp(((px - g[0]) * vx + (py - g[1]) * vy + (pz - g[2]) * vz) / l2, 0, 1) : 0;
  return [g[0] + vx * t, g[1] + vy * t, g[2] + vz * t];
}

// The ball bounces off a body (dead) or a deliberately thrown limb (a little
// livelier, and it pops up off a foot).
function deflect(w, p, nx, ny, nz, limb) {
  const b = w.ball;
  const rx = b.vx - p.vx, ry = b.vy - p.vy, rz = b.vz - p.vz;
  const vn = rx * nx + ry * ny + rz * nz;
  if (vn < 0) {
    const e = limb ? 0.35 : 0.2, keep = limb ? 0.45 : 0.55;
    const tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz;
    b.vx = p.vx + tx * keep - e * vn * nx;
    b.vy = p.vy + ty * keep - e * vn * ny;
    b.vz = p.vz + tz * keep - e * vn * nz + (limb ? 1.5 + rnd(w) * 2 : 0.5 + rnd(w));
  }
  b.spin = 0; b.ts = 0;
  b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.atT = 0;
  p.kq = KQ.PLAIN;
  invalidatePath(w);
  w.events.push({ k: 'block', x: b.x, y: b.y, z: b.z, v: Math.abs(vn), id: p.id });
}

// A keeper's one-on-one block at a shooter close in (GKB), thrown as the shot
// comes – no time to read it and dive. toBall: the direction it comes from.
//  * spread: a low, wide barrier on his side across the line of the shot (arms
//    one way, legs the other) after a short step at it; beaten by a chip or a
//    shot past the ends of his body.
//  * star jump: up off both feet, arms up and out in a V and legs wide – the
//    corners covered, a gap between his legs.
//  * K-barrier: down onto one knee with the shin along the grass towards the
//    near post, body upright, hands cupped low in front – for a shot from a
//    tight angle: near post and the ground covered, he stays tall.
//  * splits: a low shot just wide of him, too quick to dive for – a leg slid
//    out along the grass towards it (side: +1 to his left), down low.
export function beginBlock1v1(w, p, toBall, kind, side = 1) {
  if (!isFree(p) || p.z > 0) return;
  p.st = ST.DIVE; p.stT = 0; p.hit = 0; p.spr = kind; p.face = toBall;
  const fx = Math.cos(toBall), fy = Math.sin(toBall);
  if (kind === GKB.SPLITS) {
    p.stA = toBall + side * Math.PI / 2; p.stB = 0.15; p.stDur = 40;
    p.vx = Math.cos(p.stA) * 1.8; p.vy = Math.sin(p.stA) * 1.8; p.vz = 0;
  } else if (kind === GKB.STAR) {
    p.stA = toBall + Math.PI / 2; p.stB = 1.2; p.stDur = 32;
    p.vx = fx * 0.8; p.vy = fy * 0.8; p.vz = 1.7; // a small hop (~15 cm): he stays big, not high
  } else if (kind === GKB.KNEE) {
    // the knee goes down on the near post side (stA points that way)
    const pit = pitchOf(w), gx = -teamDir(w, p.team) * pit.L / 2;
    const py = (w.ball.y >= 0 ? 1 : -1) * pit.goalW / 2;
    const side = -fy * (gx - p.x) + fx * (py - p.y) >= 0 ? 1 : -1; // +1: to his left
    p.stA = toBall + side * Math.PI / 2; p.stB = 0.2; p.stDur = 38;
    p.vx = fx * 0.6; p.vy = fy * 0.6; p.vz = 0;
  } else {
    p.stA = toBall + Math.PI / 2; p.stB = 0.25; p.stDur = 46; // body lies across the shot
    p.vx = fx * 2.2; p.vy = fy * 2.2; p.vz = 0.8;
  }
  p.chgBtn = 0; p.qa = 0;
  w.events.push({ k: 'dive', x: p.x, y: p.y });
}
export function beginSpread(w, p, toBall) { beginBlock1v1(w, p, toBall, GKB.SPREAD); }

// Which block suits a shot from (bx, by), d metres from the keeper: the
// K-barrier from a tight angle, spread close in, the star jump a little further.
export function blockKind(w, bx, by, d) {
  const pit = pitchOf(w);
  if (Math.abs(by) > pit.goalW / 2 + 0.5 && d < 6.5) return GKB.KNEE;
  return d < 4.2 ? GKB.SPREAD : GKB.STAR;
}

// The star jump's and the K-barrier's body as limb segments
// [ax, ay, az, bx, by, bz] (see beginBlock1v1). The arm on the ball's side
// still goes to it on reflex, as far as it reaches.
const KNEE_HANDS = 2;
function blockSegs(p, s, b) {
  const H = s.H, fx = Math.cos(p.face), fy = Math.sin(p.face);
  const at = (f, l, z) => [p.x + fx * f - fy * l, p.y + fy * f + fx * l, p.z + z]; // l: to his left
  const bl = -fy * (b.x - p.x) + fx * (b.y - p.y), bz = b.z - p.z; // the ball: to his left, up
  if (p.spr === GKB.STAR) {
    const e = clamp(p.stT / 6, 0.35, 1), arm = 0.5 * H, shz = 0.82 * H, up = 0.45;
    const segs = [];
    for (const side of [-1, 1]) {
      const sl = side * 0.12 * H;
      const el = bl * side > 0.12 * H ? clamp(Math.atan2(bz - shz, Math.abs(bl - sl)), up - 1.1, up + 0.7) : up;
      segs.push([...at(0, sl, shz), ...at(0.05, sl + side * arm * Math.cos(el) * e, shz + arm * Math.sin(el) * e)]);
      segs.push([...at(0, side * 0.06 * H, 0.5 * H), ...at(0, side * (0.06 * H + 0.25 * H * e), 0.06)]);
    }
    // his body is as wide as his shoulders
    for (const side of [-1, 1]) segs.push([...at(0, side * 0.1 * H, 0.5 * H), ...at(0, side * 0.1 * H, 0.95 * H)]);
    return segs;
  }
  if (p.spr === GKB.SPLITS) {
    // the leading leg along the grass towards the ball, the other bent under
    // him, body low and leaning that way, the near arm down to the ground
    const side = Math.sin(angDiff(p.face, p.stA)) >= 0 ? 1 : -1, e = clamp(p.stT / 5, 0.3, 1);
    return [
      [...at(0.05, side * 0.08, 0.3 * H), ...at(0.08, side * (0.25 + 0.75 * e), 0.09)],   // leading leg, out along the grass
      [...at(0, -side * 0.06, 0.3 * H), ...at(0.12, -side * 0.28, 0.06)],               // trailing leg
      [...at(0.05, side * 0.05, 0.32 * H), ...at(0.08, side * 0.18, 0.78 * H)],         // body
      [...at(0.12, side * 0.18, 0.66 * H), ...at(0.25, side * (0.3 + 0.35 * e), 0.25)], // near arm, down
    ];
  }
  const side = Math.sin(angDiff(p.face, p.stA)) >= 0 ? 1 : -1, e = clamp(p.stT / 7, 0.35, 1);
  // the hands: cupped low in front, going out towards the ball
  const shz = 0.62 * H, reach = 0.52 * H, dl = bl, dz = bz - shz, dn = Math.hypot(dl, dz);
  const k = dn > reach ? reach / dn : 1;
  const hl = clamp(dl * k, -reach, reach), hz = Math.max(0.12, shz + dz * k);
  return [
    [...at(0.1, side * 0.05, 0.11), ...at(-0.05, side * (0.15 + 0.4 * e), 0.11)], // shin along the grass
    [...at(0.05, -side * 0.22, 0.08), ...at(0.18, -side * 0.18, 0.3 * H)],      // standing leg
    [...at(0.25, hl * 0.4, (shz + hz) / 2), ...at(0.3, hl, hz)],               // hands, out to the ball
    [...at(0.05, -0.1 * H, 0.33 * H), ...at(0.12, -0.1 * H, 0.8 * H)],         // body, shoulder wide
    [...at(0.05, 0.1 * H, 0.33 * H), ...at(0.12, 0.1 * H, 0.8 * H)],
  ];
}

// Contextual technique for an airborne / incoming ball (PES-style buffered input).
const T_CONTACT = { [ST.KICK]: 3, [ST.VOLLEY]: 6, [ST.HEADER]: 12, [ST.OVERHEAD]: 13, [ST.DIVEHEAD]: 10 };
const T_DUR = { [ST.KICK]: 14, [ST.VOLLEY]: 24, [ST.HEADER]: 30, [ST.OVERHEAD]: 62, [ST.DIVEHEAD]: 52 };
const T_TOL = { [ST.KICK]: 0.75, [ST.VOLLEY]: 0.85, [ST.HEADER]: 0.6, [ST.OVERHEAD]: 0.8, [ST.DIVEHEAD]: 0.7, [ST.CONTROL]: 0.6, [ST.TACKLE]: 0.75 };
// bringing the ball down (ST.CONTROL), by body part: ticks to contact / after it,
// and how far in front of him the part meets the ball
const C_CONTACT = { [PART.FOOT]: 4, [PART.THIGH]: 5, [PART.CHEST]: 6, [PART.HEAD]: 8 };
const C_AFTER = { [PART.FOOT]: 8, [PART.THIGH]: 12, [PART.CHEST]: 12, [PART.HEAD]: 14 };
const C_OFF = { [PART.FOOT]: 0.4, [PART.THIGH]: 0.32, [PART.CHEST]: 0.2, [PART.HEAD]: 0.1 };

export function contactPoint(p, st, part = p.stB) {
  const fx = Math.cos(p.face), fy = Math.sin(p.face), s = stOf(p);
  switch (st) {
    case ST.VOLLEY: return [p.x + fx * 0.6, p.y + fy * 0.6, p.z + 0.9];
    case ST.HEADER: return [p.x + fx * 0.12, p.y + fy * 0.12, p.z + s.H * 0.93];
    case ST.OVERHEAD: return [p.x + fx * 0.25, p.y + fy * 0.25, p.z + 1.3];
    case ST.DIVEHEAD: return [p.x + fx * 0.75, p.y + fy * 0.75, p.z + 0.45];
    case ST.CONTROL: {
      const z = part === PART.HEAD ? s.H * 0.93 : part === PART.CHEST ? s.H * 0.72 : part === PART.THIGH ? s.H * 0.45 : 0.2;
      return [p.x + fx * C_OFF[part], p.y + fy * C_OFF[part], p.z + z];
    }
    case ST.TACKLE: return [p.x + fx * 0.7, p.y + fy * 0.7, 0.15];
    default: return [p.x + fx * 0.5, p.y + fy * 0.5, 0.15];
  }
}

// Heights the body parts take a ball at standing, and whether a part can
// take one at height z – the thigh with a hop, the chest and head with a jump.
const partZ = (s, part) => (part === PART.HEAD ? s.H * 0.93 : part === PART.CHEST ? s.H * 0.72 : part === PART.THIGH ? s.H * 0.45 : 0.2);
const partUp = (s, part, up) => (part === PART.FOOT ? 0 : part === PART.THIGH ? Math.min(up, 0.12) : Math.min(up, s.jump * (part === PART.CHEST ? 0.85 : 0.8)));
function partReaches(s, part, z, up = s.jump) {
  const top = partUp(s, part, up);
  if (part === PART.FOOT) return z < 0.45;
  if (part === PART.THIGH) return z >= 0.45 && z <= s.H * 0.55 + top;
  if (part === PART.CHEST) return z >= s.H * 0.55 && z <= s.H * 0.72 + top;
  return z >= s.H * 0.84 && z <= s.H * 0.93 + top;
}

function predictBallShort(b, t) {
  let z = b.z + b.vz * t - 0.5 * G * t * t;
  if (z < BALL_R) z = BALL_R;
  return [b.x + b.vx * t, b.y + b.vy * t, z];
}

export function tryQueued(w, p) {
  const b = w.ball;
  if (!p.qa || b.owner >= 0 || p.kcd > 0 || !isFree(p) || p.z > 0) return false;
  // a keeper who may use his hands takes a ball in the air with them (a kick
  // key down then means punch it – see gkSave)
  if (p.role === ROLE.GK && b.z > 0.5 && keeperHands(w, p) && inOwnBox(w, p.team, p.x, p.y, 0.6) && inOwnBox(w, p.team, b.x, b.y, 0.3)) return false;
  if ((p.qa & KICK_MASK) === KT.CTRL) return false; // (no kick: see tryControl)
  const d0 = Math.hypot(b.x - p.x, b.y - p.y);
  if (d0 > 6) return false;
  const s = stOf(p), pit = pitchOf(w), dir = teamDir(w, p.team);
  const power = p.chgBtn ? p.chg / CHG_MAX : p.qp;
  const kh = (p.qa >> 3) & 3;
  const kind = kickKind(p, p.qa & KICK_MASK);
  const isShot = kind === KICK.SHOT || kind === KICK.FINESSE;
  const gx = dir * pit.L / 2;
  const gdx = gx - p.x, gdy = -p.y, gd = Math.hypot(gdx, gdy) || 1;
  const fx = Math.cos(p.face), fy = Math.sin(p.face);
  const awayFromGoal = (fx * gdx + fy * gdy) / gd < -0.35;
  const techs = [];
  // pass to self off the ground; in the air it's brought down (tryControl) –
  // and the lift key at a ball off the grass keeps it up (a keepy-up, see tryControl)
  if (kind === KICK.SELF) { if (!(kh === KH.HIGH && (b.z > 0.3 || b.vz > 0.5))) techs.push(ST.KICK); } else if (p.tm === MEET.AT) {
    // running at the ball: head it, jumping as high as it takes – volley or
    // kick it only if it comes in lower; with his back to goal, an overhead
    // kick if it's up there
    if (isShot && awayFromGoal) techs.push(ST.OVERHEAD);
    techs.push(ST.HEADER, ST.VOLLEY, ST.KICK);
  } else if (p.tm === MEET.WITH) {
    // running with it: volley it if he gets there in time, otherwise a flying
    // header (see meetPlan); facing away from goal, an overhead kick
    if (isShot && awayFromGoal) techs.push(ST.OVERHEAD);
    if (p._as && p._as.dive) techs.push(ST.DIVEHEAD, ST.VOLLEY, ST.KICK);
    else techs.push(ST.VOLLEY, ST.KICK);
  } else {
    if (isShot && awayFromGoal) techs.push(ST.OVERHEAD);
    techs.push(ST.KICK, ST.VOLLEY, ST.HEADER);
    if (isShot) techs.push(ST.DIVEHEAD);
  }
  // (outside their box: no header at goal – see farShot)
  for (const tech of techs) {
    const tc = T_CONTACT[tech], t = tc * DT;
    const [bx, by, bz] = predictBallShort(b, t);
    if (isShot && (tech === ST.HEADER || tech === ST.DIVEHEAD) && farShot(w, p, bx, by)) continue;
    const qx = p.x + p.vx * t * 0.6, qy = p.y + p.vy * t * 0.6;
    const hx = bx - qx, hy = by - qy, h = Math.hypot(hx, hy);
    const front = h < 0.05 ? 1 : (hx * fx + hy * fy) / h;
    let ok = false;
    switch (tech) {
      case ST.KICK: ok = bz < 0.45 && h < 1.0; break;
      case ST.VOLLEY: ok = bz >= 0.45 && bz < 1.35 && h < 1.25; break;
      case ST.HEADER: ok = bz >= s.H * 0.8 && bz <= s.reach + 0.1 && h < 1.1; break;
      // (any way it comes in – he turns his back to the goal, see
      // beginTechnique – as long as it isn't behind him already)
      case ST.OVERHEAD: ok = bz >= 0.95 && bz <= 1.4 + s.jump && h < 1.0 && (h < 0.05 || (hx * gdx + hy * gdy) / (h * gd) < 0.6); break;
      // (a dive covers at most 10 m/s – see beginTechnique)
      case ST.DIVEHEAD: ok = bz >= 0.25 && bz <= 1.05 && h > 1.0 && Math.hypot(bx - p.x, by - p.y) - 0.75 <= 10 * t && front > 0.75; break;
    }
    if (ok && isShot && (tech === ST.KICK || tech === ST.VOLLEY || tech === ST.DIVEHEAD)) {
      // back to goal he can't strike it first time: a back-heel off the
      // ground, otherwise he brings it under control first (and then turns
      // with it – see possession)
      planKick(w, p, kind, power, undefined, undefined, -1, kh);
      if (shotMis(p, p.face, bx, by) > HEEL_MIS && !(tech === ST.KICK && shotWay(p, p.face, bx, by) === KQ.HEEL)) continue;
    }
    if (ok) { beginTechnique(w, p, tech, kind, power, bx, by, bz, kh); return true; }
  }
  // outside their box a ball at head height that won't come down for him to
  // volley: headed on as a pass
  if (isShot) {
    const t = T_CONTACT[ST.HEADER] * DT, [bx, by, bz] = predictBallShort(b, t);
    const h = Math.hypot(bx - p.x - p.vx * t * 0.6, by - p.y - p.vy * t * 0.6);
    if (bz >= s.H * 0.8 && bz <= s.reach + 0.1 && h < 1.1 && farShot(w, p, bx, by) && !volleyLater(w, p)) { beginTechnique(w, p, ST.HEADER, KICK.PASS, power, bx, by, bz, kh); return true; }
  }
  // a ball on the grass he'd lose on his feet: slide in and strike it first
  if (kind !== KICK.SELF && p.role !== ROLE.GK) {
    const sk = slideKickPlan(w, p);
    if (sk) { beginSlideKick(w, p, sk.a, kind, power, kh); return true; }
  }
  return false;
}

// A queued kick at a ball on the grass that he'd lose running for it – one
// of theirs (their keeper too) gets a foot to it first, it goes out of play
// (or into his own goal) before he gets there, or it's running past him (a
// ball across the goal: on his feet he'd only catch it well after, far off) –
// where a slide gets his foot there first: the way to slide (null: no slide).
// The slide's foot is 0.85 m ahead of him and he goes down at up to 9.5 m/s,
// slowing (see beginSlide and the SLIDE state).
const SLIDE_REACH_T = 0.4;
function slideKickPlan(w, p) {
  const b = w.ball, s = stOf(p), v = Math.hypot(p.vx, p.vy);
  if (v < s.jog || b.z > 0.45 || b.vz > 1.5) return null;
  const me = meetBall(w, p), threat = w._meet.threat[p.team], gone = goneAt(w, p.team);
  const pts = ballPath(w), v0 = Math.min(Math.max(v, 5) + 2.2, 9.5), ux = p.vx / v, uy = p.vy / v;
  for (let k = 2; k * PATH_H <= SLIDE_REACH_T; k++) {
    const q = pts[k], t = k * PATH_H;
    if (t >= Math.min(threat, gone) - 0.03) return null; // theirs first, or gone, all the same
    if (q.z > 0.4) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    const slid = v0 * DT * (1 - Math.pow(0.955, t / DT)) / 0.045;
    if (Math.abs(d - 0.85 - slid) > 0.45 || dx * ux + dy * uy < 0.75 * d) continue;
    // his on his feet, soon enough (and struck before it's gone)
    if (me && me.t < threat - 0.1 && me.t < t + 0.4 && (gone === Infinity || kickOnFootAt(p, pts) < gone)) return null;
    return { a: Math.atan2(dy, dx), t };
  }
  return null;
}

// When his kick on the run would strike the ball if he ran on as he is: the
// first moment it's in reach as tryQueued sees it (99: not on its path)
function kickOnFootAt(p, pts) {
  const tc = T_CONTACT[ST.KICK] * DT;
  for (let k = 0; k * PATH_H + tc < (pts.length - 1) * PATH_H; k++) {
    const t = k * PATH_H, q = pts[Math.round((t + tc) / PATH_H)];
    const ax = p.x + p.vx * (t + 0.6 * tc), ay = p.y + p.vy * (t + 0.6 * tc);
    if (q.z < 0.45 && Math.hypot(q.x - ax, q.y - ay) < 1.0) return t + tc;
  }
  return 99;
}

// Whether a ball in the air comes down low enough to volley somewhere he can
// get to in the next 0.7 s
function volleyLater(w, p) {
  const pts = ballPath(w), v = Math.max(3, Math.hypot(p.vx, p.vy));
  for (let k = 1; k * PATH_H <= 0.7; k++) {
    const q = pts[k];
    if (q.z >= 0.45 && q.z < VOLLEY_TOP && Math.hypot(q.x - p.x, q.y - p.y) - 1.2 <= v * k * PATH_H) return true;
  }
  return false;
}

// When the ball on its way is gone for a team: over a line, or into its own
// goal (into the one it attacks is a goal, not a loss); Infinity: not on its
// predicted path.
function goneAt(w, team) {
  const pts = ballPath(w), pit = pitchOf(w), hx = pit.L / 2 + BALL_R, hy = pit.W / 2 + BALL_R;
  for (let k = 1; k < pts.length; k++) {
    const q = pts[k];
    if (Math.abs(q.y) > hy) return k * PATH_H;
    if (Math.abs(q.x) > hx) {
      const inGoal = Math.abs(q.y) < pit.goalW / 2 && q.z < pit.goalH;
      return inGoal && Math.sign(q.x) === teamDir(w, team) ? Infinity : k * PATH_H;
    }
  }
  return Infinity;
}

// The slide that strikes it (stA 2): the kick planned as he goes down (aimed
// before he turns, as beginTechnique does), struck when his foot gets to the
// ball (see slideContacts)
function beginSlideKick(w, p, ang, kind, power, kh) {
  planKick(w, p, kind, power, undefined, undefined, -1, kh);
  p.kq = KQ.PLAIN;
  p.face = ang;
  beginSlide(w, p);
  p.stA = 2;
}

function beginTechnique(w, p, tech, kind, power, bx, by, bz, kh) {
  const s = stOf(p);
  // aim before turning to meet the ball, so a neutral stick means "the way I
  // was facing" rather than back towards whoever played it
  planKick(w, p, kind, power, undefined, undefined, -1, kh);
  p.kq = tech === ST.KICK && shotWay(p, p.face, bx, by) === KQ.HEEL ? KQ.HEEL : KQ.PLAIN;
  // (a back-heel keeps his back to goal; an overhead kick turns his back to
  // where it's going – the ball in front of him and over his head that way,
  // however it came in: a cross from the side as much as one from ahead)
  if (tech === ST.OVERHEAD) p.face = Math.atan2(by - p.ky, bx - p.kx);
  else if (p.kq !== KQ.HEEL) p.face = Math.atan2(by - p.y, bx - p.x);
  p.st = tech; p.stT = 0; p.stA = T_CONTACT[tech]; p.stDur = T_DUR[tech]; p.stB = 1; p.hit = 0;
  p.qa = 0; p.qt = 0; p.chgBtn = 0; p.chg = 0;
  const t = p.stA * DT;
  const off = { [ST.KICK]: 0.5, [ST.VOLLEY]: 0.6, [ST.HEADER]: 0.12, [ST.OVERHEAD]: 0.25, [ST.DIVEHEAD]: 0.75 }[tech];
  const fx = Math.cos(p.face), fy = Math.sin(p.face);
  const tx = bx - fx * off, ty = by - fy * off;
  let vx = (tx - p.x) / t, vy = (ty - p.y) / t;
  const vmax = { [ST.KICK]: 6, [ST.VOLLEY]: 3.5, [ST.HEADER]: 4.5, [ST.OVERHEAD]: 2.5, [ST.DIVEHEAD]: 10 }[tech];
  const vm = Math.hypot(vx, vy);
  if (vm > vmax) { vx *= vmax / vm; vy *= vmax / vm; }
  p.vx = vx; p.vy = vy;
  if (tech === ST.HEADER) {
    const rise = clamp(bz - s.H * 0.93, 0, s.jump);
    p.vz = Math.max(bz > 1.5 ? 1.6 : 0, rise > 0.02 ? rise / t + 0.5 * G * t : 0);
  } else if (tech === ST.OVERHEAD) {
    const rise = clamp(bz - 1.3, 0, s.jump);
    p.vz = Math.max(2.2, rise / t + 0.5 * G * t);
  } else if (tech === ST.DIVEHEAD) {
    p.vz = 1.5;
  } else if (tech === ST.VOLLEY && bz > 1.0) {
    p.vz = 1.8;
  }
}

// Bringing a ball down out of the air – nothing queued, or SELF held for a
// touch into space. The part he takes it on follows from the height he meets
// it at (foot, thigh, chest, or head with a jump), and how he meets it (p.tm)
// decides where it drops: in front of him when he runs at it or lets it come,
// out ahead to run onto when he runs with it, where the stick points with SELF.
export function tryControl(w, p) {
  const b = w.ball, m = w.m;
  if (b.owner >= 0 || m.spTaker >= 0 || p.kcd > 0 || !isFree(p) || p.z > 0) return false;
  const self = !!p.qa && (p.qa & KICK_MASK) === KT.SELF;
  const dead = !!p.qa && (p.qa & KICK_MASK) === KT.CTRL; // (the control key: taken dead)
  // the lift key at his own ball in the air: a keepy-up, on what its height
  // calls for – a little pop on the foot, then the knee / thigh, the chest,
  // and a big one on the head
  const juggle = self && ((p.qa >> 3) & 3) === KH.HIGH && b.last === p.id && b.kt < 90;
  if (p.qa && !self && !dead) return false;             // a first-time kick is queued
  if (b.z < 0.45 && b.vz > -1) return false;           // on the ground: an ordinary trap
  if (b.last === p.id && b.kt < 20 && b.tgt !== p.id) return false;
  if (p.role === ROLE.GK && keeperHands(w, p) && inOwnBox(w, p.team, p.x, p.y, 0.6)) return false; // hands
  const meant = b.tgt === p.id && b.lastTeam === p.team;
  const s = stOf(p), fx = Math.cos(p.face), fy = Math.sin(p.face);
  // [part, how far up he'd go for it]: letting it come, a little jump to take
  // it on the chest comes before the head, a big one only after
  const J = s.jump;
  const top = b.z + b.vz * b.vz / (2 * G); // (how high it gets – or got, on its way down)
  const order = juggle ? [[top > s.H * 0.93 + 0.2 ? PART.HEAD : top > s.H * 0.72 + 0.15 ? PART.CHEST : top > 0.75 ? PART.THIGH : PART.FOOT, 0], [PART.THIGH, 0], [PART.FOOT, 0]]
    : b.last === p.id && b.kt < 60 ? [[PART.FOOT, 0]] // his own cushion coming down: onto the foot
    : dead ? [[PART.CHEST, J], [PART.THIGH, J], [PART.FOOT, 0], [PART.HEAD, J]] // (the control key: chest, thigh, foot – or a jump to head it down)
    : p.tm === MEET.AT ? [[PART.HEAD, J], [PART.CHEST, J], [PART.THIGH, J], [PART.FOOT, 0]]
      : p.tm === MEET.WITH ? [[PART.THIGH, J], [PART.FOOT, 0], [PART.CHEST, J], [PART.HEAD, J]]
        : [[PART.CHEST, 0.25], [PART.THIGH, J], [PART.FOOT, 0], [PART.HEAD, J], [PART.CHEST, J]];
  // When and on what he takes it: the first moment along its flight that it's
  // within reach, not behind him (one over his shoulder is taken as it drops
  // in front), and low enough for some part – the one he'd rather use at that
  // height. Started just in time: early enough to get up to it for a jump.
  // running with it, the chest and head only for a ball coming at him from the front
  const fromBehind = p.tm === MEET.WITH && (b.vx - p.vx) * fx + (b.vy - p.vy) * fy > -1;
  for (let k = 1; k <= 36; k++) {
    const t = k * DT, [bx, by, bz] = predictBallShort(b, t);
    const hx = bx - (p.x + p.vx * t * 0.6), hy = by - (p.y + p.vy * t * 0.6), h = Math.hypot(hx, hy);
    if (h > 0.8 || (h >= 0.3 && (hx * fx + hy * fy) / h <= -0.3)) continue;
    for (const [part, up] of order) {
      if (!partReaches(s, part, bz, up)) continue;
      if (part === PART.FOOT && b.vz - G * t > -1) continue; // a dropping ball, not one bobbling along
      if (fromBehind && part >= PART.CHEST) continue;
      const rise = Math.min(bz - partZ(s, part), partUp(s, part, up));
      const lead = Math.max(C_CONTACT[part], rise > 0.04 ? Math.ceil(Math.sqrt(2 * rise / G) * 60) : 0);
      if (k > lead) return false; // the right part – but not time to go for it yet
      beginControl(w, p, part, bx, by, bz, self, Math.max(2, k));
      if (dead) p.kk = KICK.CTRL;
      return true;
    }
  }
  return false;
}

function beginControl(w, p, part, bx, by, bz, self, tk = C_CONTACT[part]) {
  const s = stOf(p);
  p.kq = KQ.PLAIN; // (his next touch isn't a no-look pass)
  if (self) {
    // the touch goes where the stick points – or, with it neutral, forwards,
    // towards the goal he's attacking (kx, ky: that direction)
    const [sx, sy, sm] = stickOf(p);
    p.kk = KICK.SELF; p.kp = clamp(p.chgBtn ? p.chg / CHG_MAX : p.qp, 0, 1); p.kh = (p.qa >> 3) & 3;
    const gdx = teamDir(w, p.team) * pitchOf(w).L / 2 - p.x, gdy = -p.y, gl = Math.hypot(gdx, gdy) || 1;
    p.kx = sm > 0.3 ? sx : gdx / gl; p.ky = sm > 0.3 ? sy : gdy / gl;
  } else { p.kk = 0; p.kp = 0; }
  if (Math.hypot(bx - p.x, by - p.y) > 0.25) p.face = Math.atan2(by - p.y, bx - p.x);
  p.st = ST.CONTROL; p.stB = part; p.stT = 0; p.stA = tk; p.stDur = p.stA + C_AFTER[part]; p.hit = 0;
  p.qa = 0; p.qt = 0; p.chgBtn = 0; p.chg = 0;
  // get the part under the ball – a short step, or keeping his pace on the run
  const t = p.stA * DT, fx = Math.cos(p.face), fy = Math.sin(p.face);
  let vx = (bx - fx * C_OFF[part] - p.x) / t, vy = (by - fy * C_OFF[part] - p.y) / t;
  const vm = Math.hypot(vx, vy), vmax = Math.max(2.5, Math.hypot(p.vx, p.vy));
  if (vm > vmax) { vx *= vmax / vm; vy *= vmax / vm; }
  p.vx = vx; p.vy = vy;
  // a ball above where the part is standing: up to meet it (a hop for the
  // thigh, a jump for the chest or head)
  const rise = clamp(bz - partZ(s, part), 0, s.jump);
  if (rise > 0.04) p.vz = Math.min(rise / t + 0.5 * G * t, Math.sqrt(2 * G * (s.jump + 0.05))); // no higher than he can jump
}

// The touch itself: the ball loses its pace off the part and drops where he
// meant it to. A hot ball or a poor touch leaves more on it.
function cushion(w, p, s) {
  const b = w.ball, part = p.stB;
  const rs = Math.hypot(b.vx - p.vx, b.vy - p.vy);
  const juggle = p.kk === KICK.SELF && p.kh === KH.HIGH && b.last === p.id && b.kt < 90; // (a keepy-up: the lift key at his own ball)
  b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.sh = -1; b.spin = 0; b.ts = 0;
  b.atk = -1; b.atT = 0;
  if (rs > (part === PART.HEAD ? 17 : 20)) {
    // too hot to control: it comes off him
    let nx = b.x - p.x, ny = b.y - p.y; const nd = Math.hypot(nx, ny) || 1; nx /= nd; ny /= nd;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) { b.vx -= 1.5 * vn * nx; b.vy -= 1.5 * vn * ny; }
    b.vx *= 0.45; b.vy *= 0.45; b.vz = Math.abs(b.vz) * 0.3 + 0.5; b.tgt = -1;
    p.hit = 2;
    invalidatePath(w);
    w.events.push({ k: 'block', x: b.x, y: b.y, z: b.z, v: rs, id: p.id });
    return;
  }
  p.hit = 1;
  const fx = Math.cos(p.face), fy = Math.sin(p.face);
  const run = Math.hypot(p.vx, p.vy);
  let vx, vy, lift = 0;
  if (juggle) {
    // a keepy-up: back up, staying with him – on the way the stick points if
    // it's held – higher with the hold
    const [sx, sy, sm] = stickOf(p), push = sm > 0.3 ? 1.0 + 2.5 * p.kp : 0;
    vx = p.vx * 0.9 + fx * 0.15 + sx * push; vy = p.vy * 0.9 + fy * 0.15 + sy * push;
    lift = 2.2 + 2.2 * p.kp;
  } else if (p.kk === KICK.SELF) {
    // a touch into space (see beginControl), further and higher with the hold
    const push = 1.5 + 4 * p.kp;
    vx = p.vx * 0.5 + p.kx * push; vy = p.vy * 0.5 + p.ky * push;
    lift = (p.kh === KH.HIGH ? 1.4 : p.kh === KH.MID ? 0.8 : 0) + 1.2 * p.kp;
  } else if (p.kk !== KICK.CTRL && p.tm === MEET.WITH && run > 1) {
    // taken in his stride: out ahead, where he'll be in a moment
    vx = p.vx * 1.05 + p.vx / run * 1.2; vy = p.vy * 1.05 + p.vy / run * 1.2;
  } else if (p.kk !== KICK.CTRL && stickOf(p)[2] > 0.3) {
    // the stick held: the touch goes the way he wants to go, a little ahead of
    // him, and he carries on dribbling
    const [sx, sy] = stickOf(p);
    vx = p.vx * 0.85 + sx * (1.4 + 0.3 * run); vy = p.vy * 0.85 + sy * (1.4 + 0.3 * run);
  } else {
    // killed: it drops just in front of him (the control key: dead at his feet)
    const k = p.kk === KICK.CTRL ? 0.3 : 0.55;
    vx = p.vx * k + fx * 0.9; vy = p.vy * k + fy * 0.9;
  }
  [vx, vy] = keptIn(w, b.x, b.y, vx, vy);
  // a heavy touch: the faster it came and the clumsier he is, the more it runs off
  const heavy = clamp((rs - 7) / 14, 0, 1) * (1.25 - 0.3 * s.control);
  vx += b.vx * 0.12 * heavy + gauss(w) * 1.2 * heavy;
  vy += b.vy * 0.12 * heavy + gauss(w) * 1.2 * heavy;
  b.tgt = p.id;
  w.events.push({ k: part === PART.HEAD ? 'head' : 'control', x: b.x, y: b.y, z: b.z, v: rs, id: p.id, part });
  if (part === PART.FOOT && !lift && heavy < 0.3) {
    // cushioned under the sole / on the instep: his straight away
    b.owner = p.id; b.held = 0; b.vx = vx; b.vy = vy; b.vz = 0; b.z = BALL_R; b.tgt = -1;
    p.dph = 0; p.st = ST.IDLE; p.stT = 0; p.hit = 0;
    invalidatePath(w);
    w.events.push({ k: 'trap', x: b.x, y: b.y, id: p.id });
    return;
  }
  b.vx = vx; b.vy = vy;
  b.vz = (part === PART.HEAD ? 1.5 : part === PART.CHEST ? 0.5 : part === PART.THIGH ? 1.3 : 0.6) + lift;
  invalidatePath(w);
}

// ---------------------------------------------------------------- ball launch

// how far off the way he's sliding his foot can send it (rad): past HOOK it's
// hooked round with the side of the foot, softer – up to nearly square (a
// ball into his own goal turned round the post)
const SLIDE_TURN = 1.45, SLIDE_HOOK = 1.0;
// a no-look pass: how much further off it can go (rad)
const NOLOOK_ERR = 0.03;
// a header: how fast he turns in the air towards where it's going (rad/s),
// and how far off the way he faces his neck can still send it (rad) –
// softer and less true the further it's turned
const HEAD_SPIN = 6, HEAD_TURN = 1.2;
function launch(w, p, tech) {
  const b = w.ball, s = stOf(p), pit = pitchOf(w);
  if (tech === ST.SLIDE && p.kh === KH.HIGH) p.kh = KH.MID; // (off a slide it's along the grass or mid-height, never high)
  const kind = p.kk, pw = p.kp;
  const fromHands = b.held === 1;
  if (fromHands) {
    // where it leaves his hands: onto the boot for a punt, off the grass for a
    // drop kick, low for a keeper rolling it out, at shoulder height for a
    // sidearm throw, over his head for a throw-in or an overarm throw
    b.held = 0;
    const dt = Math.hypot(p.kx - b.x, p.ky - b.y);
    b.z = kind === KICK.PUNT ? 0.45 : kind === KICK.DROP ? 0.16 : w.m.spTaker === p.id ? 2.0
      : p.kh === KH.GROUND ? 0.3 : kind === KICK.THROW && dt <= SIDEARM_MAX ? 1.35 : 2.0;
  }
  const heel = p.kq === KQ.HEEL && tech === ST.KICK;
  if (heel) { b.x = p.x - Math.cos(p.face) * 0.12; b.y = p.y - Math.sin(p.face) * 0.12; } // off his heel
  let dx = p.kx - b.x, dy = p.ky - b.y;
  // a keeper's kick (from his hands or off the grass) comes down no further
  // than a fifth of the way into their half – past that it's cut short along
  // its line, landing there and running on
  if (p.role === ROLE.GK) {
    const lim = teamDir(w, p.team) * 0.1 * pit.L;
    if ((p.kx - lim) * teamDir(w, p.team) > 0 && Math.abs(dx) > 0.1) { const k = Math.max(0, (lim - b.x) / dx); dx *= k; dy *= k; }
  }
  let d = Math.hypot(dx, dy);
  if (d < 0.1) { dx = Math.cos(p.face); dy = Math.sin(p.face); d = 1; }
  let ux = dx / d, uy = dy / d;
  let vh = 0, vz = 0, spin = 0, err = 0, zErr = 0;
  const aerial = tech !== ST.KICK || fromHands;
  const isHead = tech === ST.HEADER || tech === ST.DIVEHEAD;
  // pressure from nearest opponent
  let near = 99;
  for (const q of w.players) if (q.team !== p.team) near = Math.min(near, Math.hypot(q.x - p.x, q.y - p.y));
  const pressure = near < 1.6 ? 0.025 : 0;
  // body orientation vs kick direction
  const misalign = Math.abs(angDiff(p.face, Math.atan2(uy, ux)));
  if (tech === ST.HEADER && misalign > HEAD_TURN) {
    const a = p.face + Math.sign(angDiff(p.face, Math.atan2(uy, ux))) * HEAD_TURN;
    ux = Math.cos(a); uy = Math.sin(a);
  }
  if (tech === ST.SLIDE && misalign > SLIDE_TURN) {
    // off a slide the foot only turns it so far from the way he's going
    const a = p.face + Math.sign(angDiff(p.face, Math.atan2(uy, ux))) * SLIDE_TURN;
    ux = Math.cos(a); uy = Math.sin(a);
  }

  // top or back spin, as the kick puts it on (see topspinFor)
  let ts = heel ? 0 : topspinFor(kind, p.kh, pw, tech, p.kc, fromHands);
  switch (kind) {
    case KICK.PASS: case KICK.THROUGH: case KICK.THROW:
    case KICK.LONG: case KICK.PUNT: case KICK.CLEAR: case KICK.DROP: {
      const kh = p.kh;
      const footOnly = tech === ST.KICK || tech === ST.THROW || tech === ST.SLIDE;
      if (kh === KH.GROUND && footOnly && kind !== KICK.LONG && kind !== KICK.PUNT && kind !== KICK.CLEAR && kind !== KICK.DROP) {
        // along the ground, arriving at a pace the receiver can control
        const vEnd = p.kv > 0 ? p.kv : passEndSpeed(kind, d, pw);
        vh = Math.min(groundSpeedFor(d, vEnd), kind === KICK.THROW ? 17 : 28) * (0.97 + 0.06 * s.shot);
        if (p.kc && footOnly) vh = Math.min(vh, 28 * curlPace(p.kc)); // (curl costs pace)
        vz = kind === KICK.THROW ? (fromHands && b.z > 1.8 ? 1.5 : b.z < 0.5 ? 0.15 : 0.6) : 0; // (rolled out: along the grass)
        err = 0.012 + (misalign > 1.2 ? (misalign - 1.2) * 0.05 : 0) + pressure * 0.5;
      } else {
        // lofted: arrive at the chosen height (feet / chest / head) after the planned flight
        const lofted = kh !== KH.GROUND ? kh : KH.MID; // a header/volley "to feet" is still in the air
        const zt = targetHeight(w, p, kind, kh);
        const thrown = fromHands && kind !== KICK.PUNT && kind !== KICK.DROP;
        // (a drop kick is driven: flatter and quicker than a lofted pass;
        // punts, clearances and throws keep their natural arc)
        const T = p.kv > 0 && p.kt >= 0 && kh !== KH.GROUND
          ? p.kv
          : kind === KICK.DROP ? Math.max(0.35, d / (clamp(14 + 0.25 * d, 14, 24) + 2 * pw))
            : loftTime(d, kind === KICK.PUNT || kind === KICK.CLEAR ? KH.HIGH : lofted, pw, kind !== KICK.PUNT && kind !== KICK.CLEAR && !thrown);
        vh = d / T * (kind === KICK.DROP ? 1.1 : 1.04);
        vz = (zt - b.z + 0.5 * (G + TS_PLAN * TS_K * ts * vh) * T * T * 1.03) / T;
        const cap = (thrown ? (b.z < 1.6 ? 17 : 21) : isHead ? 16 : 32) * s.shot;
        const v = Math.hypot(vh, vz);
        if (v > cap) { vh *= cap / v; vz *= cap / v; }
        err = 0.018 + (misalign > 1.4 ? 0.05 : 0) + pressure;
        zErr = 0.25;
      }
      break;
    }
    case KICK.SHOT: case KICK.FINESSE: {
      if (heel) {
        // a back-heel: soft and low, and only roughly where he meant it
        vh = (8 + 8 * pw) * s.shot;
        vz = p.kh === KH.GROUND ? 0.3 : Math.min(3, vzToReach(vh, b.z, d, Math.min(0.7, targetHeight(w, p, kind, p.kh))));
        err = 0.09 + 0.004 * d + pressure;
        zErr = 0.15;
        spin = gauss(w) * 0.05;
        break;
      }
      // pace from the hold, height from the key row (low / mid / top corner)
      const techF = { [ST.KICK]: 1, [ST.VOLLEY]: 1.06, [ST.HEADER]: 0.62, [ST.OVERHEAD]: 0.95, [ST.DIVEHEAD]: 0.7, [ST.THROW]: 0.5, [ST.SLIDE]: 0.8 }[tech] || 1;
      let speed = (12 + 13 * pw) * s.shot * techF;
      // struck along the grass it's quicker still; in the air a little quicker
      // too – but not a soft one meant to loop up (a chip stays a chip)
      if (p.kh === KH.GROUND && tech === ST.KICK) speed *= groundShot(pw);
      else speed *= 1 + 0.1 * clamp((pw - 0.2) / 0.3, 0, 1);
      // a header: neck and jump, plus the run he put into it – well short of a
      // kick (a standing one ~45 km/h at most, met on the run ~55-60)
      if (isHead) speed = (6.5 + 6 * pw) * (0.9 + 0.2 * s.h) + 0.4 * Math.max(0, p.vx * ux + p.vy * uy);
      if (kind === KICK.FINESSE) speed *= 0.85;
      const curled = tech === ST.KICK && p.kc;
      if (curled) speed *= curlPace(p.kc); // curl costs pace
      let tz = targetHeight(w, p, kind, p.kh);
      if (pw > 0.9) tz += (pw - 0.9) * 3; // a blasted shot climbs
      vh = speed;
      if (p.kh === KH.GROUND && (tech === ST.KICK || tech === ST.SLIDE)) vz = 0.4 + 2.5 * Math.max(0, pw - 0.75); // skims the grass
      else vz = Math.min(14, vzToReach(speed, b.z, d, tz, ts)); // low pace + high target = a chip
      const techErr = { [ST.KICK]: 0, [ST.VOLLEY]: 0.035, [ST.HEADER]: 0.03, [ST.OVERHEAD]: 0.06, [ST.DIVEHEAD]: 0.04 }[tech] || 0;
      const mis = tech === ST.KICK ? (misalign > 1.0 ? (misalign - 1.0) * 0.07 : 0) : 0;
      const sprint = Math.hypot(p.vx, p.vy) > s.jog * 1.15 ? 0.015 : 0; // struck at full tilt
      // the further out, the wider the spread (and a full-power strike is wilder)
      err = 0.035 + 0.0016 * d + 0.00011 * d * d + 0.06 * pw * pw + techErr + mis + pressure + sprint;
      if (kind === KICK.FINESSE) err *= 0.6; // placed
      else if (curled) err *= p.kf === FOOT.OUTSIDE ? 0.8 * OUTSIDE_ERR : 0.8; // the inside of the foot (the outside: a little less true)
      zErr = (0.2 + 0.35 * pw) * (0.8 + d / 25);
      // no strike is perfectly clean: it swerves a little one way or the other
      spin += gauss(w) * (curled || kind === KICK.FINESSE ? 0.03 : 0.05 + 0.1 * pw);
      break;
    }
    case KICK.SELF: {
      // a soft touch into space: rolled along the ground, or popped up off foot/chest/head
      if (tech === ST.KICK && b.z < 0.4 && p.kh === KH.GROUND) {
        vh = Math.min(groundSpeedFor(d, 1.2), 12); vz = 0;
      } else {
        vz = (p.kh === KH.HIGH ? 3.2 : p.kh === KH.MID ? 2.0 : 1.2) + 1.8 * pw; // cushioned, not a clearance
        const tf = (vz + Math.sqrt(vz * vz + 2 * G * Math.max(0, b.z - BALL_R))) / G;
        vh = Math.min(d / tf, 8);
      }
      err = 0.03;
      break;
    }
  }
  // The foot's curl (planned kc, + bending left): struck off-centre with the
  // inside of the foot – the right one bends it left, the left one right –
  // it spins; aimed off by as much as the spin will bring it back
  if (p.kc && tech === ST.KICK && !fromHands && !heel && kind !== KICK.SELF) {
    const sp = p.kc * CURL_MAX, a = curlAim(vh, vz, sp, d, b.z, ts);
    spin += sp;
    const ca = Math.cos(a), sa = Math.sin(a), nux = ux * ca - uy * sa, nuy = ux * sa + uy * ca;
    ux = nux; uy = nuy;
  }
  if (tech === ST.SLIDE) err += 0.03 + 0.03 * Math.min(misalign, SLIDE_TURN); // (a stab at it, going down)
  if (tech === ST.KICK && p.kq === KQ.NOLOOK) err += NOLOOK_ERR; // (not looking at it)
  if (tech === ST.HEADER) err += 0.04 * Math.min(misalign, HEAD_TURN) / HEAD_TURN; // (glanced, the neck turned)
  if (kind === KICK.SHOT || kind === KICK.FINESSE) err *= SHOT_ERR; // (the same for everyone: the AI's skill is how it presses the keys)
  if (err > 0) {
    const a = gauss(w) * err;
    const ca = Math.cos(a), sa = Math.sin(a);
    const nux = ux * ca - uy * sa, nuy = ux * sa + uy * ca;
    ux = nux; uy = nuy;
  }
  if (zErr > 0) vz += gauss(w) * zErr * 0.6;
  if (p.role === ROLE.GK && vz > 0) {
    // (and wherever it was meant to go, a keeper's kick in the air first
    // comes down no further than that – see above)
    const dirT = teamDir(w, p.team), room = (dirT * 0.1 * pit.L - b.x) * dirT, fwd = ux * dirT;
    const tf = (vz + Math.sqrt(vz * vz + 2 * G * Math.max(0, b.z - BALL_R))) / G, reach = vh * tf * fwd;
    if (fwd > 0.05 && reach > room) vh *= Math.max(0, room) / reach;
  }
  if (tech === ST.SLIDE && misalign > SLIDE_HOOK) { const k = 1 - 0.3 * Math.min(1, (misalign - SLIDE_HOOK) / (SLIDE_TURN - SLIDE_HOOK)); vh *= k; vz *= k; }
  if (tech === ST.HEADER && misalign > 0.35) { const k = 1 - 0.35 * Math.min(1, (misalign - 0.35) / (HEAD_TURN - 0.35)); vh *= k; vz *= k; }
  // overhead and headers inherit a bit of the player's own momentum
  b.vx = ux * vh + (aerial ? p.vx * 0.15 : 0);
  b.vy = uy * vh + (aerial ? p.vy * 0.15 : 0);
  b.vz = vz;
  b.spin = spin; b.ts = ts;
  // the passing record (see makeBall): a new move when the other side last
  // passed it; a pass that gets it 3 m further than they've had it starts the
  // count of passes going nowhere again
  {
    const fwd = b.x * teamDir(w, p.team);
    if (b.pft !== p.team) { b.fwdX = fwd; b.stale = 0; }
    else if (fwd > b.fwdX + 3) { b.fwdX = fwd; b.stale = 0; }
    else if (b.stale < 255) b.stale++;
    b.pf = p.id; b.pft = p.team; b.pfx = b.x;
  }
  b.owner = -1; b.held = 0; b.last = p.id; b.lastTeam = p.team; b.kt = 0; b.tgt = p.kt; b.nut = -1;
  b.dl = isHead ? 0 : 1;
  b.sh = kind === KICK.SHOT || kind === KICK.FINESSE ? p.id : -1; // keeps the credit through saves / blocks
  invalidatePath(w);
  // arm aftertouch for human kickers, remembering the stick they aimed with
  const at = kind !== KICK.THROW; // (anyone's – the AI keeps the stick light after a kick)
  b.atk = at ? p.id : -1; b.atT = at ? AT_TICKS : 0; b.atA = p.ia; b.atM = p.im; b.atOn = 0;
  // a throw-in: no goal straight from it (sh -2, with the thrower in atk)
  if (fromHands && w.m.spTaker === p.id && w.m.spType === SP.THROWIN) { b.sh = -2; b.atk = p.id; }
  if (b.z < BALL_R) b.z = BALL_R;
  p.kcd = 12; p.hit = 1; p.hold = 0;
  markOffside(w, p);
  if (w.m.spTaker === p.id) w.m.spTaker = -1;
  w.events.push({ k: kind === KICK.SHOT || kind === KICK.FINESSE ? 'shot' : isHead ? 'head' : 'kick', x: b.x, y: b.y, z: b.z, v: vh, id: p.id, tech });
}

// ---------------------------------------------------------------- per-player update

function handleButtons(w, p) {
  const m = w.m, b = w.ball;
  const btn = p.ib;
  const owner = b.owner >= 0 ? pById(w, b.owner) : null;
  const mine = owner === p;
  const teamHas = owner && !mine && owner.team === p.team;
  const oppHas = owner && owner.team !== p.team;
  const free = isFree(p);
  const live = m.phase === PHASE.PLAY || m.phase === PHASE.WARMUP;
  if (!live) { p.chgBtn = 0; p.chg = 0; p.qa = 0; p.tap = 0; return; }
  // the other side on the ball: a kick being charged for a loose ball is off –
  // the key held now means pressing him (and no gauge)
  if (oppHas && p.chgBtn) { p.chgBtn = 0; p.chg = 0; p.qa = 0; }
  // ...and while they pass it between them, the team-mate key presses too
  const theirPass = !owner && b.lastTeam >= 0 && b.lastTeam !== p.team && b.tgt >= 0 && (pById(w, b.tgt) || p).team !== p.team;

  const code = btn & KICK_MASK;                   // kick target held (0 = none)
  const packed = code | (((btn >> 3) & 3) << 3);  // ... with its height
  // the trick key (see beginTrick); with the ball on his neck F or R pops it
  if (p.st === ST.SKILL && p.stA === SKILL.NECK && p.hit === 1 && (code === KT.TRICK || code === KT.SELF) && code !== (p.pb & KICK_MASK)) { neckRelease(w, p, true); return; }
  if (code === KT.TRICK) {
    p.chgBtn = 0; p.chg = 0;
    if (code !== (p.pb & KICK_MASK)) beginTrick(w, p);
    return;
  }
  // the control key: no kick – a ball coming is taken dead (see tryControl);
  // it stays wanted a moment after it's let go, as a kick key does
  if (code === KT.CTRL) {
    p.chgBtn = 0; p.chg = 0; // (a kick being wound up is off)
    if (!owner && isFree(p)) { p.qa = packed; p.qt = 255; } else if ((p.qa & KICK_MASK) !== KT.CTRL) p.qa = 0;
    return;
  }
  if ((p.qa & KICK_MASK) === KT.CTRL && p.qt === 255) p.qt = 24;
  const pressed = code && code !== (p.pb & KICK_MASK) ? code : 0;
  if (p.tapT < 255) p.tapT++;
  // (a lift waits for the ball to be at his foot – out ahead in his dribble,
  // until the next touch brings it back)
  const lift = (k) => (k & KICK_MASK) === KT.SELF && ((k >> 3) & 3) === KH.HIGH;
  const atFoot = () => Math.hypot(b.x - p.x, b.y - p.y) < 0.6;
  const fire = (k, power) => {
    if (lift(k) && mine && !b.held && !atFoot()) { p.qa = k; p.qp = power; p.qt = 40; return; }
    if ((k & KICK_MASK) === KT.SELF && !b.held && m.spTaker !== p.id) beginLift(w, p, power, (k >> 3) & 3);
    else beginOwnKick(w, p, k, power, false);
  };
  if (mine && free && !b.held && lift(p.qa) && atFoot()) { beginLift(w, p, p.qp, KH.HIGH); return; }

  // calling for the ball: CALL, or a team-mate key while a team-mate has it
  if (teamHas && (pressed === KT.MATE || pressed === KT.RUN || ((btn & BTN.CALL) && !(p.pb & BTN.CALL)))) requestPass(w, p);

  // SELF + sideways / back while dribbling: instant feint or drag-back
  if (pressed === KT.SELF && mine && free && !b.held && m.spTaker !== p.id && !p.chgBtn) {
    const kind = skillFromStick(p);
    if (kind) { beginSkill(w, p, kind); return; }
  }

  if (p.chgBtn) {
    if (code === (p.chgBtn & KICK_MASK)) {
      // still held – keep the latest height (on touch the finger can slide)
      p.chgBtn = packed;
      if (p.qa) p.qa = packed;
      if (p.tapH < 255) p.tapH++;
      // (a shot winds up half as fast again; a knock into his own run four
      // times as fast – a tap knocks it on at once, a hold sends it on further)
      const knock = code === KT.SELF && ((packed >> 3) & 3) === KH.GROUND;
      p.chg = Math.min(CHG_MAX, p.chg + (p.tap >= 2 ? 2 : 1) + (code === KT.GOAL && p.tapH & 1 ? 1 : 0) + (knock ? 3 : 0));
      if (p.chg >= CHG_MAX && mine && free && (code === KT.GOAL || code === KT.SELF || p.tap >= 2)) fire(p.chgBtn, 1);
    } else {
      p.tapT = 0; p.tapK = p.chgBtn & KICK_MASK;
      const power = p.chg / CHG_MAX;
      if (mine && free) {
        fire(p.chgBtn, power);
      } else if (p.qa) { p.qp = power; p.qt = 24; }
      p.chgBtn = 0; p.chg = 0;
    }
  }

  if (pressed && !p.chgBtn) {
    // pressed again straight after letting go: a double / triple press
    const again = p.tapK === pressed && p.tapT <= TAP_GAP;
    p.tap = again ? Math.min(3, p.tap + 1) : 1;
    p.tapH = 0;
    if (mine) {
      if (free) { p.chgBtn = packed; p.chg = 0; }
    } else if (!owner && pressed === KT.GOAL && free && p.role !== ROLE.GK && keepInReach(w, p)) {
      // the slide key at a ball just about to go out: slide and keep it in
      const out = exitPoint(w);
      beginKeepIn(w, p, Math.atan2(out.y - p.y, out.x - p.x));
    } else if (!owner && !(theirPass && pressed === KT.MATE)) {
      // keeper: a ball coming in – a dive; but the shoot key at one that isn't
      // going in (a cross) means punch it (see gkSave)
      const ownGoalDanger = p.role === ROLE.GK && inOwnBox(w, p.team, b.x, b.y, 8)
        && (b.vx * teamDir(w, p.team) < -3) && Math.hypot(b.x - p.x, b.y - p.y) > 1.2
        && (pressed !== KT.GOAL || goalLineCross(w, p.team, b).on);
      // (a keeper in his box: a loose ball low with one of theirs about to reach it – the smother)
      let smother = false;
      if (p.role === ROLE.GK && keeperHands(w, p) && b.z < 0.5 && Math.hypot(b.x - p.x, b.y - p.y) < 2.6 && Math.hypot(b.vx, b.vy) < 6) {
        for (const q of w.players) if (q.team !== p.team && Math.hypot(b.x - q.x, b.y - q.y) < 2.2) smother = true;
      }
      const plan = !ownGoalDanger && !smother && wantsBlock(w, p) ? blockPlan(w, p) : null;
      if (ownGoalDanger || smother) keeperDive(w, p);  // keeper: hands
      else if (plan && free) beginBlock(w, p, plan);
      else {
        // first-time kick when the ball arrives; pressing again keeps the charge built so far
        p.chg = again && p.qa ? Math.round(p.qp * CHG_MAX) : 0;
        p.chgBtn = packed; p.qa = packed; p.qt = 255; p.qp = 0.5;
        if (p.tap >= 3) { p.chg = CHG_MAX; p.qp = 1; }
      }
    } else if (oppHas) {
      if (pressed === KT.GOAL && free) {
        if (p.role === ROLE.GK && inOwnBox(w, p.team, p.x, p.y, 2)) keeperDive(w, p);
        else beginSlide(w, p);
      } else if (pressed === KT.SELF && free && p.role === ROLE.GK && inOwnBox(w, p.team, p.x, p.y, 2)) {
        // keeper: a one-on-one block at the man on the ball, the one that suits where he is
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < 9) beginBlock1v1(w, p, Math.atan2(b.y - p.y, b.x - p.x), blockKind(w, b.x, b.y, d));
      } else if (pressed === KT.RUN) {
        if (p.team === 0) m.gkc0 = 90; else m.gkc1 = 90;
      }
      // a MATE key held = press the ball carrier (see movement)
    }
  }
}

// A ball low on the grass going out in under half a second, near enough to
// reach the line with a slide in time
export function keepInReach(w, p) {
  const b = w.ball;
  if (b.owner >= 0 || b.z > 0.5) return false;
  const out = exitPoint(w);
  return !!out && out.t < 0.45 && out.z < 0.5 && Math.hypot(out.x - p.x, out.y - p.y) < 0.85 + 8.5 * out.t;
}

// The keeper's save on the dive key – the same for anyone (the AI's keeper
// presses it too): the save that suits the ball, as his training picks it.
// At a man's feet (or a loose ball low with one of theirs on it): down at it,
// the smother. A shot struck from close in, within a block's reach: the
// block, on reflex – spread low, the K-barrier up to the waist, the star jump
// at a high one near him. Made big with it within reach of a hand: no going
// down (the hands take it). Low, just wide and on him in a flash – first of
// all: a leg slid out, the splits. Otherwise a dive – where the stick points, or across to
// where it's going – at the height it comes.
function keeperDive(w, p) {
  const b = w.ball, s = stOf(p);
  const owner = b.owner >= 0 ? pById(w, b.owner) : null;
  const dBall = Math.hypot(b.x - p.x, b.y - p.y);
  let rival = owner && owner.team !== p.team ? owner : null;
  if (!owner && b.z < 0.5 && Math.hypot(b.vx, b.vy) < 6) for (const q of w.players) if (q.team !== p.team && Math.hypot(b.x - q.x, b.y - q.y) < 2.2) rival = q;
  if (rival && b.z < 0.5 && dBall < 2.6) {
    p.tcd = 50;
    beginDive(w, p, Math.atan2(b.y - p.y, b.x - p.x), 0.15, Math.max(0.15, dBall / 7), dBall + 0.3);
    return;
  }
  const [sx, sy, sm] = stickOf(p);
  let ang, h = 0.5, dist = Infinity;
  // predicted crossing of the keeper's lateral line
  const t = Math.abs(b.vx) > 0.5 ? (p.x - b.x) / b.vx : -1;
  const cx = b.x + b.vx * Math.max(t, 0), cy = b.y + b.vy * Math.max(t, 0);
  if (t > 0 && t < 2) h = clamp(b.z + b.vz * t - 0.5 * G * t * t, 0.2, 2.3);
  const off = cy - p.y, offA = Math.abs(off);
  if (t > 0 && t < 2) {
    // a low one just wide of him from close in, on him quickly: a leg slid
    // out along the grass to it – a foot, as keepers stop them, not the hands
    if (t < 0.32 && h < 0.45 && offA > 0.45 && offA < 1.6) {
      const to = Math.atan2(b.y - p.y, b.x - p.x);
      p.tcd = 40;
      beginBlock1v1(w, p, to, GKB.SPLITS, Math.cos(to) * off >= 0 ? 1 : -1);
      return;
    }
    // close in, too quick to dive: the block that covers its height
    if (t < 0.3 && p.tcd === 0) {
      const kind = blockKind(w, b.x, b.y, dBall), zk = b.z + b.vz * t - 0.5 * G * t * t;
      const nearHim = offA > 0.55 && offA < 1.15 && zk > 1.0 && zk < 2.3;
      if ((kind === GKB.SPREAD && dBall < 4.5 && zk < 0.7 && offA < 1.8) || (kind === GKB.STAR && nearHim && t < 0.25) || (kind === GKB.KNEE && dBall < 6.5 && zk < 1.1 && offA < 1.3)) {
        p.tcd = 50;
        beginBlock1v1(w, p, Math.atan2(-b.vy, -b.vx), kind);
        return;
      }
    }
    // made big, coming within reach of a hand: he stays up
    if (keeperBig(w, p) && h >= 0.45 && offA < bigReach(s, h)) return;
  }
  if (sm > 0.3) ang = Math.atan2(sy, sx);
  else if (t > 0 && t < 2) ang = Math.atan2(cy - p.y, (cx - p.x) * 0.3);
  else ang = Math.atan2(b.y - p.y, b.x - p.x);
  if (t > 0 && t < 2) {
    const along = (cx - p.x) * Math.cos(ang) + (cy - p.y) * Math.sin(ang);
    if (along > 0) dist = along;
  }
  beginDive(w, p, ang, h, t > 0 ? t : 0.45, dist);
}

function turnToward(p, target, maxStep) {
  const d = angDiff(p.face, target);
  // ease in to the new heading instead of stopping dead on it
  const step = Math.min(maxStep, Math.max(Math.abs(d) * 0.3, maxStep * 0.25));
  if (Math.abs(d) <= step) p.face = target;
  else p.face += Math.sign(d) * step;
  if (p.face > Math.PI) p.face -= TAU; else if (p.face < -Math.PI) p.face += TAU;
}

// How a human meets a ball in the air (p.tm), from the stick against its line
// of flight: pushing back along it is running at the ball (meet it early, high
// – a header, or head / chest control), pushing along it is running with it
// (let it drop – a volley or a flying header, or thigh / foot control in his
// stride). It holds until the ball is touched again, so the stick is free once
// he has chosen.
function updateMeet(w, p, sx, sy, sm) {
  const b = w.ball;
  const air = b.owner < 0 && (b.z > 0.6 || b.vz > 1.5);
  if (!air || b.kt === 0) p.tm = MEET.NONE;
  if (!air) return;
  const v = Math.hypot(b.vx, b.vy);
  if (sm > 0.3 && v > 2) {
    const along = (sx * b.vx + sy * b.vy) / v;
    if (along < -0.45) p.tm = MEET.AT;
    else if (along > 0.45) p.tm = MEET.WITH;
  }
}

// Where on the ball's flight the chosen way of meeting it takes him: running
// at it, the earliest point he can get to under his jumping reach (head
// height when bringing it down); running with it, the first point he can get
// to where it has dropped to volley height (thigh / foot height when bringing
// it down) – or, if it lands out of reach, where a flying header gets there.
// Running with it he keeps half a metre to the side of its line, so it comes
// down beside him rather than on his back.
function meetPlan(w, p) {
  const pts = ballPath(w), s = stOf(p), v0 = Math.hypot(p.vx, p.vy);
  const kick = !!p.qa && (p.qa & KICK_MASK) !== KT.SELF && (p.qa & KICK_MASK) !== KT.CTRL;
  const reaches = (q, t, extra) => Math.hypot(q.x - p.x, q.y - p.y) - 0.4 - extra
    <= (t < 0.15 ? v0 * t : v0 * 0.15 + s.sprint * (t - 0.15) * 0.95);
  const top = kick ? s.reach + 0.05 : s.H * 0.93 + s.jump * 0.8;
  const lo = kick ? 0.45 : 0, hi = kick ? 1.3 : s.H * 0.55;
  let dive = null;
  for (let k = 1; k < pts.length; k++) {
    const q = pts[k], t = k * PATH_H;
    if (p.tm === MEET.AT) {
      if (q.z <= top && reaches(q, t, 0)) return { t, x: q.x, y: q.y, z: q.z };
    } else {
      if (q.z >= lo && q.z <= hi && reaches(q, t, 0)) {
        const b = w.ball, v = Math.hypot(b.vx, b.vy) || 1, nx = -b.vy / v, ny = b.vx / v;
        const side = (p.x - q.x) * nx + (p.y - q.y) * ny >= 0 ? 0.5 : -0.5;
        return { t, x: q.x + nx * side, y: q.y + ny * side, z: q.z };
      }
      // the dive itself takes the last 1/6 s and gains about a metre on running
      if (kick && !dive && t >= 0.17 && q.z >= 0.25 && q.z <= 1.05 && reaches(q, t, 1.2)) dive = { t, x: q.x, y: q.y, z: q.z, dive: 1 };
    }
  }
  return dive;
}

// Receive assist: help a human meet the loose ball when it's played to them,
// when it's a high ball they'd reach first on their team, or when they steer
// towards a ball they're chasing. In the air it keeps him on the ball's line
// while the stick picks how he meets it (see updateMeet); otherwise pushing
// the stick away turns it off.
function receiveAssist(w, p, sx, sy, sm) {
  const b = w.ball, m = w.m;
  if (b.owner >= 0 || m.spTaker >= 0 || (m.phase !== PHASE.PLAY && m.phase !== PHASE.WARMUP)) return null;
  if (p.role === ROLE.GK && inOwnBox(w, p.team, p.x, p.y, 2)) return null;
  if (b.last === p.id && b.kt < 20 && b.tgt !== p.id) return null; // the kicker isn't chasing his own pass (unless it's to himself)
  if (b.nut === p.id) return null; // it has just slipped past him: he can't take it, the stick is his
  const mine = b.tgt === p.id;
  const aerial = b.z > 0.6 || b.vz > 1.5;
  const me = meetBall(w, p);
  if (!me || me.t > (aerial ? 3 : 2.3)) return null;
  if (!mine) {
    for (const q of w.players) {
      if (q === p || q.team !== p.team || q.role === ROLE.GK) continue;
      const o = meetBall(w, q);
      if (o && o.first < me.first - 0.05) return null; // a team-mate gets there first
    }
  }
  const at = aerial && p.tm ? meetPlan(w, p) || me : me;
  const dx = at.x - p.x, dy = at.y - p.y, d = Math.hypot(dx, dy);
  if (aerial && p.tm) {
    // he has chosen how to meet it: the stick no longer steers
  } else if (p.qa || p.chgBtn) {
    // a first-time pass / shot / touch is lined up: the stick aims it, the
    // assist takes him to the ball – unless he pushes right away from it
    const c = d > 1e-3 ? (sx * dx + sy * dy) / d : 1;
    if (sm > 0.25 && d > 0.5 && c < -0.2) return null;
  } else if (sm > 0.25) {
    // the stick is his: the assist only helps while he's heading for the ball
    // anyway – one played to him, unless he's running away from it
    const c = d > 1e-3 ? (sx * dx + sy * dy) / d : 1;
    if (d > 0.5 && c < (mine ? -0.2 : aerial ? 0.35 : 0.5)) return null;
    if (d <= 0.5 && c < -0.3) return null; // right by it, pushing away: he goes
  } else if (!mine && !aerial) return null;
  return { x: at.x, y: at.y, z: at.z, t: at.t, d, ux: d > 1e-3 ? dx / d : 0, uy: d > 1e-3 ? dy / d : 0, dive: at.dive || 0 };
}

// Pressing (see movement): how far off the man a presser gets set (m), and
// how long up close before he goes in for a ball kept tight (ticks)
const ENGAGE = 1.0, ENGAGE_T = 30;
function movement(w, p, s) {
  const m = w.m, b = w.ball;
  const [sx, sy, sm0] = stickOf(p);
  let sm = sm0;
  const own = b.owner === p.id;
  const owner = b.owner >= 0 ? pById(w, b.owner) : null;
  const oppHas = owner && owner.team !== p.team;
  // Pace from the stick's tilt, the same for everyone (AI players press the
  // same controls): a partial tilt walks or jogs – a jog at JOG_TILT (the jog
  // key on a keyboard) – full tilt sprints (tired, a little slower: stamina).
  // R1 is "get the ball": run to it and take it, or close down whoever has it.
  const chase = (p.ib & BTN.SPRINT) && !own && !(owner && owner.team === p.team);
  const sprint = sm > JOG_TILT + 0.1;
  const prec = (p.ib & BTN.R2) && own;
  let dx = sx, dy = sy;
  let speed = paceFor(s, sm, p);
  if (own) speed *= sprint ? 0.93 : 0.96;
  if (prec) speed = s.jog * 0.55;
  if (p.st === ST.STUMBLE) speed *= 0.45;

  const pressing = oppHas && !owner.held && p.chgBtn === 0 && ((p.ib & KICK_MASK) === KT.MATE || chase);
  // jockeying (contain): stay goal-side of the dribbler at arm's length, facing
  // him, matching his moves – no lunge, so he has to beat you
  const jockey = oppHas && !pressing && (p.ib & KICK_MASK) === KT.SELF && !owner.held && p.chgBtn === 0;
  const charging = p.role === ROLE.GK && !own && (p.team === 0 ? m.gkc0 : m.gkc1) > 0;
  // guarding (R2 held without the ball, the other side on it): he keeps
  // facing the ball and side-steps or backs off into position – between it
  // and the goal – instead of turning his back on it to run there. Anyone
  // does it anyway close to the man on the ball while he's goal-side of him
  // (back-pedalling, half pace); once he's beaten he turns and runs.
  let close = false;
  if (oppHas && !own && p.role !== ROLE.GK && Math.hypot(owner.x - p.x, owner.y - p.y) < 9) {
    const ogx = -teamDir(w, p.team) * pitchOf(w).L / 2;
    close = Math.hypot(p.x - ogx, p.y) < Math.hypot(owner.x - ogx, owner.y) + 0.5;
  }
  const guard = oppHas && !own && ((p.ib & BTN.R2) || close) && !pressing && !jockey && !charging;
  let engaged = false;
  // (a keeper in his box with his hands goes right on to it and gathers it
  // at the man's feet – see below)
  const gather = p.role === ROLE.GK && keeperHands(w, p) && inOwnBox(w, p.team, b.x, b.y, 0.3);
  if (pressing && !gather) {
    // Closing him down as defenders are taught: flat out while there's ground
    // to make up, braking in time to arrive a step off him (ENGAGE) going no
    // faster than he is – not running on past into a touch round him – on
    // the goal side if he's coming at our goal (alongside the ball if he's
    // already past); there, side-on and facing the ball, he matches his
    // moves (the tackle when the moment comes – see below)
    const gx = -teamDir(w, p.team) * pitchOf(w).L / 2;
    let ux = gx - owner.x, uy = -owner.y;
    const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    const rx = p.x - owner.x, ry = p.y - owner.y, rl = Math.hypot(rx, ry) || 1;
    let tx, ty;
    if ((rx * ux + ry * uy) / rl > -0.3) { tx = owner.x + ux * ENGAGE; ty = owner.y + uy * ENGAGE; }
    else { const side = -uy * rx + ux * ry >= 0 ? 1 : -1; tx = b.x - uy * side * 0.7; ty = b.y + ux * side * 0.7; }
    tx += owner.vx * 0.15; ty += owner.vy * 0.15;
    const ddx = tx - p.x, ddy = ty - p.y, dd = Math.hypot(ddx, ddy);
    const ov = Math.hypot(owner.vx, owner.vy), brake = s.accel * (s.brake ?? 1.5) * 0.8;
    engaged = rl < ENGAGE + 1;
    if (engaged) {
      // up close: his own pace plus what closes the last bit
      const vx = owner.vx + ddx * 4, vy = owner.vy + ddy * 4, v = Math.hypot(vx, vy);
      if (v > 0.05) { dx = vx / v; dy = vy / v; }
      speed = Math.min(s.sprint * tiredPace(p), v); sm = v > 0.05 ? 1 : 0;
    } else {
      if (dd > 0.01) { dx = ddx / dd; dy = ddy / dd; }
      speed = Math.min(s.sprint * 0.95 * tiredPace(p), ov + Math.sqrt(2 * brake * Math.max(0, dd - 0.3)) + 1);
      sm = 1;
    }
  } else if (pressing || charging) {
    const tx = b.x + b.vx * 0.15, ty = b.y + b.vy * 0.15;
    const ddx = tx - p.x, ddy = ty - p.y, dd = Math.hypot(ddx, ddy) || 1;
    dx = ddx / dd; dy = ddy / dd; sm = dd < 0.6 ? 0.3 : 1;
    speed = s.sprint * 0.95 * tiredPace(p);
  } else if (jockey) {
    // a little over a step off him, goal-side – and with him out wide, a
    // little inside him: showing him down the line, away from goal
    const gx = -teamDir(w, p.team) * pitchOf(w).L / 2;
    let ux = gx - owner.x, uy = -owner.y;
    const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    const [lx, ly] = ux * owner.y < 0 ? [-uy, ux] : [uy, -ux], ins = 0.35 * clamp((Math.abs(owner.y) - 2) / 6, 0, 1); // (l: across, towards the middle)
    const tx = owner.x + owner.vx * 0.2 + ux * 1.3 + lx * ins, ty = owner.y + owner.vy * 0.2 + uy * 1.3 + ly * ins;
    const ddx = tx - p.x, ddy = ty - p.y, dd = Math.hypot(ddx, ddy) || 1;
    dx = ddx / dd; dy = ddy / dd; sm = dd < 0.15 ? 0 : Math.min(1, dd / 0.8);
    speed = s.sprint * 0.9 * tiredPace(p);
  }
  // get the ball, loose: flat out to where he can first reach it, then it's
  // taken like any other ball coming to him
  let fetching = false;
  if (chase && b.owner < 0 && m.spTaker < 0) {
    const me = meetBall(w, p);
    const tx = me ? me.x : b.x, ty = me ? me.y : b.y, ddx = tx - p.x, ddy = ty - p.y, dd = Math.hypot(ddx, ddy);
    if (dd > 0.05) { dx = ddx / dd; dy = ddy / dd; }
    sm = dd < 0.25 ? 0 : Math.min(1, dd / 0.6);
    speed = s.sprint * tiredPace(p); fetching = true;
  }

  const taker = m.spTaker === p.id;
  if (taker) {
    // A dead ball: he turns on the spot. A free kick or a corner can be taken
    // quickly, though – hold a direction and he plays it on and runs with it.
    const quick = (m.spType === SP.FREEKICK || m.spType === SP.CORNER) && !b.held && sm0 > 0.5;
    p.qk = quick ? Math.min(255, p.qk + 1) : 0;
    if (p.qk > 20) { m.spTaker = -1; p.qk = 0; w.events.push({ k: 'kick', x: b.x, y: b.y, z: b.z, v: 2, id: p.id }); }
    else sm = 0;
  } else p.qk = 0;

  // (the receive assist reads a person's rough stick and steers him onto the
  // ball – an aid for reading his input, not a rule: the AI steers itself to
  // where it meets the ball with the same stick, and the two would fight)
  if (byPerson(p)) updateMeet(w, p, sx, sy, sm0);
  const assist = byPerson(p) && !own && !pressing && !jockey && !charging && !fetching ? receiveAssist(w, p, sx, sy, sm0) : null;
  p._as = assist; // for the renderer's landing marker (not part of the state)
  let need = 0;
  if (assist) {
    dx = assist.ux; dy = assist.uy;
    // run just fast enough to be there in time (sprint if needed or asked for)
    need = assist.d / Math.max(assist.t, 0.05) * 1.15;
    const cap = s.sprint;
    // running with a ball in the air means running – not dawdling to arrive just in time
    const run = p.tm === MEET.WITH && assist.d > 0.4 ? s.jog : 0;
    speed = clamp(Math.max(need, run), 1, cap); // (to go flat out for it, there's "get the ball")
    sm = assist.d < 0.3 ? 0 : assist.d < 1 ? Math.max(0.35, assist.d) : 1;
  }
  // A ball coming at him that he has to step across to meet: he side-steps,
  // still facing it, as long as that gets him there in time (side-stepping is
  // slower than running) – otherwise he turns and runs. The same for an AI
  // player a pass is played to.
  let strafe = false;
  const bv = Math.hypot(b.vx, b.vy);
  if (!own && b.owner < 0 && bv > 3 && sm > 0.1 && p.st === ST.IDLE && p.tm !== MEET.WITH && (assist || (b.tgt === p.id && b.lastTeam === p.team))) {
    const tx = p.x - b.x, ty = p.y - b.y, tl = Math.hypot(tx, ty) || 1;
    const incoming = (tx * b.vx + ty * b.vy) / (tl * bv) > 0.75;
    const across = Math.abs(dx * b.vx + dy * b.vy) / bv < 0.6;
    strafe = incoming && across && (assist ? need <= 0.68 * s.sprint && assist.d < 6 : tl / bv > 0.35);
  }

  // with the ball near a line it may not cross: no running on out with it –
  // he goes along the line instead (over the goal line only into the goal)
  if (own && sm > 0.1) {
    const pit = pitchOf(w), hx = pit.L / 2, hy = pit.W / 2, lim = 0.9;
    let ox = dx * sm, oy = dy * sm;
    if (Math.abs(p.y) > hy - lim && oy * Math.sign(p.y) > 0) oy *= clamp((hy - 0.35 - Math.abs(p.y)) / (lim - 0.35), 0, 1);
    const scoring = Math.sign(p.x) === teamDir(w, p.team) && Math.abs(p.y) < pit.goalW / 2 - 0.3;
    if (!scoring && Math.abs(p.x) > hx - lim && ox * Math.sign(p.x) > 0) ox *= clamp((hx - 0.35 - Math.abs(p.x)) / (lim - 0.35), 0, 1);
    const om = Math.hypot(ox, oy);
    if (om < sm - 1e-6) { if (om > 1e-3) { dx = ox / om; dy = oy / om; } sm = om; }
  }

  // can't sprint as fast sideways/backwards relative to facing (back-pedalling
  // facing the play – a keeper, a defender guarding – slower still: half pace)
  if (sm > 0.1) {
    const align = Math.cos(angDiff(p.face, Math.atan2(dy, dx)));
    speed *= align >= 0 ? 0.72 + 0.28 * align : p.role === ROLE.GK ? 0.72 + 0.17 * align : guard ? 0.72 + 0.22 * align : 0.72;
    if (strafe && assist) speed = Math.max(speed, Math.min(need, 0.72 * s.sprint)); // (still in time)
  }
  const tvx = dx * sm * speed, tvy = dy * sm * speed;
  const v = Math.hypot(p.vx, p.vy), vt = Math.hypot(tvx, tvy);
  if (v > 1.5 && vt > 0.5 && !assist && !jockey && !guard && !engaged && !prec && p.role !== ROLE.GK) {
    // Running: momentum carries. The run bends towards the new direction along
    // an arc (wider the faster you go, tighter for agile players), speed is
    // gained or shed on its own, and a reversal means planting a foot and
    // braking before pushing off the other way – curved, flowing runs instead
    // of sliding sideways the instant the stick moves.
    const cur = Math.atan2(p.vy, p.vx), d = angDiff(cur, Math.atan2(tvy, tvx));
    // (realistic movement: no more than so much sideways – see realStats)
    const omega = Math.min(s.turn * 1.1 / (1 + (s.turnK ?? 0.1) * v), s.side ? s.side / v : Infinity) * (own ? 0.85 : 1) * DT;
    const brake = s.accel * (s.brake ?? 1.5);
    let ang, sp;
    if (Math.abs(d) > 2.3) {
      sp = Math.max(0, v - s.accel * (s.brake ? s.brake * 1.27 : 1.9) * DT);
      ang = cur + Math.sign(d) * omega * 0.4;
    } else {
      ang = cur + clamp(d, -omega, omega);
      const want = vt * (1 - (s.cut ? 1 - s.cut : 0.3) * Math.min(1, Math.abs(d) / 1.5)); // a tight turn costs some pace
      sp = want > v ? Math.min(want, v + accelAt(s, v) * (own ? 0.9 : 1) * DT) : Math.max(want, v - brake * DT);
    }
    p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
  } else {
    const ex = tvx - p.vx, ey = tvy - p.vy, e = Math.hypot(ex, ey);
    const slowing = vt < v;
    // (a keeper's footwork staying on the angle while a man has the ball – the
    // quick push-off – is trained: half as quick again; not the reaction to a
    // shot once it's struck)
    const acc = (slowing ? s.accel * (s.brake ?? 1.5) : accelAt(s, v)) * (own ? 0.9 : 1) * (prec ? 1.3 : 1) * (p.role === ROLE.GK && oppHas ? 1.5 : 1) * DT;
    if (e > acc) { p.vx += ex / e * acc; p.vy += ey / e * acc; } else { p.vx = tvx; p.vy = tvy; }
  }

  // facing
  const sp = Math.hypot(p.vx, p.vy);
  const rate = s.turn * (own ? (prec ? 1.5 : 0.85) : 1) / (1 + 0.09 * sp) * DT;
  // (a keeper caught well off his line, heading back to it: he turns and
  // runs, then faces the play again – back-pedalling it he'd never make it)
  const ogx = -teamDir(w, p.team) * pitchOf(w).L / 2, gkBack = p.role === ROLE.GK && !own && sm > 0.6
    && Math.abs(p.x - ogx) > 6 && dx * (ogx - p.x) > 0 && Math.abs(dx) > 0.6;
  if (gkBack) {
    turnToward(p, Math.atan2(dy, dx), rate * 1.4);
  } else if (pressing || jockey || guard || (p.role === ROLE.GK && !own)) {
    turnToward(p, Math.atan2(b.y - p.y, b.x - p.x), rate * 1.4);
  } else if (assist && assist.d < 1.6 && p.tm === MEET.WITH && Math.hypot(b.vx, b.vy) > 1) {
    turnToward(p, Math.atan2(b.vy, b.vx), rate * 1.2); // running with it: face where it's going
  } else if (assist && assist.d < 1.6 && p.tm === MEET.AT) {
    turnToward(p, Math.atan2(b.y - p.y, b.x - p.x), rate * 1.2); // square up to it
  } else if (assist && assist.d < 1.6) {
    // waiting for the ball: open up between the incoming ball and the goal
    const bx = b.x - p.x, by = b.y - p.y, bl = Math.hypot(bx, by) || 1;
    const gx = teamDir(w, p.team) * pitchOf(w).L / 2 - p.x, gy = -p.y, gl = Math.hypot(gx, gy) || 1;
    const fx = bx / bl + gx / gl, fy = by / bl + gy / gl;
    if (Math.hypot(fx, fy) > 0.3) turnToward(p, Math.atan2(fy, fx), rate * 1.2);
  } else if (strafe) {
    turnToward(p, Math.atan2(b.y - p.y, b.x - p.x), rate * 1.2); // side-stepping across to it, facing it
  } else if ((assist || fetching) && sm > 0.1) {
    turnToward(p, Math.atan2(dy, dx), rate);
  } else if (sm0 > 0.1) {
    turnToward(p, Math.atan2(sy, sx), taker ? rate * 0.6 : rate);
  }

  if (taker && m.spTaker === p.id) { p.vx = 0; p.vy = 0; }

  // (a keeper in his box doesn't poke it away – it would only run loose: he
  // gets to it and gathers it at the man's feet, going round to the side of
  // it when he's shielding it – see possession and the AI)
  // The tackle, pressing: not a lunge the moment he's near – the ball off
  // the man's foot (a touch that's left it nearer the presser than a step
  // from the man), or, kept tight, once he's stood the man up a moment
  // (ENGAGE_T) and the man isn't between him and the ball (shielded, he
  // waits) – and only with it within a tackle's reach. The same for anyone
  // holding the press key.
  p.eng = engaged ? Math.min(255, p.eng + 1) : 0;
  if (pressing && p.tcd === 0 && !gather) {
    const bd = Math.hypot(b.x - p.x, b.y - p.y), od = Math.hypot(owner.x - p.x, owner.y - p.y);
    const fd = (Math.cos(p.face) * (b.x - p.x) + Math.sin(p.face) * (b.y - p.y)) / (bd || 1);
    const off = Math.hypot(b.x - owner.x, b.y - owner.y) > 0.62 || bd + 0.15 < Math.hypot(b.x - owner.x, b.y - owner.y);
    const shielded = bd > od && ((b.x - p.x) * (owner.x - p.x) + (b.y - p.y) * (owner.y - p.y)) / ((bd * od) || 1) > 0.9;
    if (bd < 1.15 && fd > 0.6 && (off || (p.eng >= ENGAGE_T && !shielded))) beginTackle(w, p);
  }
  // Stamina (p.stam, 0..1), for everyone: sprinting spends it – a fit man has
  // 5-6 s flat out in him – easing off brings it back, quickest at a walk;
  // tired, he can't reach his top speed (tiredPace). (The bar under your
  // player shows it.)
  {
    const v = Math.hypot(p.vx, p.vy);
    if (v > s.jog * 1.1) p.stam = Math.max(0, p.stam - DT / (STAM_SPRINT * (0.55 + 0.45 * s.stamina)));
    else p.stam = Math.min(1, p.stam + DT / (v < 2.2 ? STAM_WALK : STAM_JOG));
  }
}
const STAM_SPRINT = 6, STAM_WALK = 12, STAM_JOG = 30; // s: flat out from full to empty; back to full walking / jogging
export const tiredPace = (p) => 0.88 + 0.12 * Math.min(1, p.stam / 0.35);
// The stick's tilt and the pace it gives (target speed = tilt x paceFor): up
// to JOG_TILT a walk to a jog, from there to full tilt a jog to his sprint.
// tiltFor is the other way round – the tilt that runs at v (how the AI
// presses the stick).
export function paceFor(s, sm, p) {
  if (sm <= JOG_TILT) return s.jog / JOG_TILT;
  const f = Math.min(1, (sm - JOG_TILT) / (1 - JOG_TILT));
  return (s.jog + f * (s.sprint * tiredPace(p) - s.jog)) / sm;
}
export function tiltFor(p, v) {
  const s = stOf(p);
  if (v <= s.jog) return Math.max(0, JOG_TILT * v / s.jog);
  const top = s.sprint * tiredPace(p);
  return Math.min(1, JOG_TILT + (1 - JOG_TILT) * (v - s.jog) / Math.max(0.1, top - s.jog));
}

function stateUpdate(w, p, s) {
  const b = w.ball;
  switch (p.st) {
    case ST.KICK: case ST.THROW: {
      const owned = b.owner === p.id;
      // passes are played on the run; a shot or a long ball plants the foot a bit more
      const keep = p.st === ST.THROW || p.kq === KQ.TURN ? 0.88 : p.kk === KICK.PASS || p.kk === KICK.THROUGH || p.kk === KICK.SELF ? 0.975 : 0.93;
      p.vx *= keep; p.vy *= keep;
      if (p.stB === 0 && owned && !p.hit) {
        const want = Math.atan2(p.ky - p.y, p.kx - p.x);
        if (p.kq === KQ.TURN) {
          // turning with the ball to face the goal: the strike waits for it
          turnToward(p, want, s.turn * TURN_K * DT);
          if (p.stT === p.stA && Math.abs(angDiff(p.face, want)) > TURN_OK) { p.stA++; p.stDur++; }
        } else if (p.kq !== KQ.HEEL && p.kq !== KQ.NOLOOK && p.stT < p.stA) turnToward(p, want, s.turn * 1.6 * DT);
      }
      if (!p.hit) {
        if (p.stB === 0) {
          if (p.stT === p.stA) {
            if (owned) launch(w, p, ST.KICK);
            else if (b.owner < 0 && near3(p, ST.KICK, b) < T_TOL[ST.KICK]) launch(w, p, ST.KICK);
            else p.hit = 2;
          }
        } else if (p.stT >= p.stA && p.stT <= p.stA + 3 && b.owner < 0 && !struckByOther(b, p) && near3(p, ST.KICK, b) < T_TOL[ST.KICK]) {
          launch(w, p, ST.KICK);
        }
      }
      break;
    }
    case ST.CONTROL: {
      if (!p.hit) {
        if (p.stT >= p.stA - 1 && p.stT <= p.stA + 3 && b.owner < 0 && !struckByOther(b, p)
          && near3(p, ST.CONTROL, b) < T_TOL[ST.CONTROL] && winsAerialDuel(w, p, s)) cushion(w, p, s);
        else if (p.stT > p.stA + 3) p.hit = 2; // it got away from him
      } else {
        // after the touch: running with it, or the stick held, he keeps going
        // (towards where the stick points) – otherwise he settles
        const [sx, sy, sm] = stickOf(p);
        if (sm > 0.3) {
          const want = Math.max(Math.hypot(p.vx, p.vy), s.jog * sm), f = 1 - Math.exp(-DT * 6);
          p.vx += (sx * want - p.vx) * f; p.vy += (sy * want - p.vy) * f;
        } else {
          const k = p.tm === MEET.WITH ? 0.99 : 0.9;
          p.vx *= k; p.vy *= k;
        }
      }
      break;
    }
    case ST.VOLLEY: case ST.HEADER: case ST.OVERHEAD: case ST.DIVEHEAD: {
      if (p.z <= 0 && p.stT > p.stA + 2) {
        const f = p.st === ST.DIVEHEAD || p.st === ST.OVERHEAD ? 0.82 : 0.86;
        p.vx *= f; p.vy *= f;
      }
      if (p.st === ST.VOLLEY) { p.vx *= 0.94; p.vy *= 0.94; }
      // a header: he turns in the air towards where it's going (it can't go
      // out of the back of his head – see launch)
      if (p.st === ST.HEADER && !p.hit && p.stT <= p.stA + 4) turnToward(p, Math.atan2(p.ky - b.y, p.kx - b.x), HEAD_SPIN * DT);
      if (!p.hit && p.stT >= p.stA - 1 && p.stT <= p.stA + 4 && b.owner < 0 && !struckByOther(b, p)) {
        if (near3(p, p.st, b) < T_TOL[p.st] && winsAerialDuel(w, p, s)) launch(w, p, p.st);
      }
      break;
    }
    case ST.TACKLE: {
      if (p.stT > 6) { p.vx *= 0.82; p.vy *= 0.82; }
      if (p.stT === p.stA) tackleContact(w, p, s);
      break;
    }
    case ST.SLIDE: {
      if (p.stT < 26) { p.vx *= 0.955; p.vy *= 0.955; } else { p.vx *= 0.6; p.vy *= 0.6; }
      break;
    }
    case ST.DIVE: {
      if (p.z <= 0 && p.stT > 6) { p.vx *= 0.78; p.vy *= 0.78; }
      break;
    }
    case ST.BLOCK: {
      if (p.z <= 0 && p.stT > 8) { p.vx *= 0.8; p.vy *= 0.8; }
      break;
    }
    case ST.PUNCH: case ST.TIP: {
      if (p.z <= 0 && p.stT > 4) { p.vx *= 0.82; p.vy *= 0.82; }
      break;
    }
    case ST.FALLEN: {
      p.vx *= 0.85; p.vy *= 0.85;
      break;
    }
    case ST.SKILL: {
      if (p.stA === SKILL.DRAGBACK) {
        const turnTicks = Math.max(4, p.stDur - 4);
        if (p.stT <= turnTicks) {
          p.face += p.stB * Math.PI / turnTicks;
          if (p.face > Math.PI) p.face -= TAU; else if (p.face < -Math.PI) p.face += TAU;
        }
        p.vx *= 0.85; p.vy *= 0.85;
      } else if (p.stA === SKILL.FEINT_L || p.stA === SKILL.FEINT_R) {
        if (p.stT > 9) { p.vx *= 0.88; p.vy *= 0.88; }
      } else if (p.stA === SKILL.LIFT) {
        p.vx *= 0.97; p.vy *= 0.97;
      } else if (p.stA >= SKILL.ELASTICO) trickStep(w, p);
      break;
    }
  }
}

// A trick under way, each tick (see beginTrick)
function trickStep(w, p) {
  const b = w.ball, s = stOf(p), t = p.stT, q = p.kp;
  const fx = Math.cos(p.face), fy = Math.sin(p.face), lx = -fy, ly = fx;
  const agil = clamp((s.turn - 7.8) / 6.5, 0, 1);
  if (p.stA === SKILL.ELASTICO) {
    if (t < 6) { const v = 0.8; p.vx = p.vx * 0.85 - lx * p.stB * v * 0.3; p.vy = p.vy * 0.85 - ly * p.stB * v * 0.3; }
    if (t === 6) {
      // the snap back across: done right he goes with it, wrong-footing a man
      // close in front; a touch too far out and it's gone the other way
      if (b.owner === p.id && q > 0.2) {
        const lat = (3.4 + 1.6 * agil) * (0.6 + 0.4 * q), fwd = Math.max(0, p.vx * fx + p.vy * fy) * 0.6 + 1;
        p.vx = fx * fwd + lx * p.stB * lat; p.vy = fy * fwd + ly * p.stB * lat;
        for (const o of w.players) {
          if (o.team === p.team) continue;
          const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy);
          if (d > 3 || (Math.cos(o.face) * dx + Math.sin(o.face) * dy) / (d || 1) < 0.2) continue;
          o.tcd = Math.max(o.tcd, 26);
          if (isFree(o) && rnd(w) < clamp(0.35 + (s.turn - stOf(o).turn) * 0.05 + agil * 0.15 + 0.2 * q, 0.1, 0.85)) { o.st = ST.STUMBLE; o.stT = 0; o.stDur = 18; }
        }
      } else if (b.owner === p.id) {
        b.owner = -1; b.vx = p.vx - lx * p.stB * 2.2; b.vy = p.vy - ly * p.stB * 2.2; b.vz = 0; b.last = p.id; b.kt = 0; invalidatePath(w);
      }
    }
    if (t > 10) { p.vx *= 0.94; p.vy *= 0.94; }
  } else if (p.stA === SKILL.RAINBOW) {
    p.vx *= 0.98; p.vy *= 0.98;
    if (t === 10 && b.owner === p.id) {
      // flicked up off his heel, over his head, to land a few metres on – off
      // line and short if it was mistimed
      const err = (1 - q) * gauss(w) * 0.5, c = Math.cos(err), sn = Math.sin(err);
      const ux = fx * c - fy * sn, uy = fy * c + fx * sn, v = p.kv + 1.4 + 1.2 * q; // (on ahead of him as he runs on)
      b.owner = -1; b.z = 0.4; b.vz = 4.6 + 1.4 * q;
      b.vx = ux * v; b.vy = uy * v;
      b.last = p.id; b.lastTeam = p.team; b.kt = 0; b.tgt = p.id; b.dl = 0; b.sh = -1; b.atk = -1;
      touchedBy(w, p); invalidatePath(w);
      w.events.push({ k: 'kick', x: b.x, y: b.y, z: b.z, v: 4, id: p.id });
    }
  } else if (p.stA === SKILL.CROQUETA) {
    if (t < 5) { p.vx *= 0.9; p.vy *= 0.9; }
    if (t === 5) {
      // away on the diagonal with it: a man close in front going in for it
      // is past it – his challenge comes too late; mistimed, it runs loose
      if (b.owner === p.id && q > 0.2) {
        const lat = (2.6 + 1.2 * agil) * (0.6 + 0.4 * q), fwd = Math.max(2.2, p.vx * fx + p.vy * fy);
        p.vx = fx * fwd + lx * p.stB * lat; p.vy = fy * fwd + ly * p.stB * lat;
        for (const o of w.players) {
          if (o.team === p.team) continue;
          const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy);
          if (d > 2.4 || (Math.cos(o.face) * dx + Math.sin(o.face) * dy) / (d || 1) < 0.2) continue;
          o.tcd = Math.max(o.tcd, 22);
          if (isFree(o) && rnd(w) < clamp(0.15 + (s.turn - stOf(o).turn) * 0.04 + agil * 0.1 + 0.25 * q, 0.05, 0.6)) { o.st = ST.STUMBLE; o.stT = 0; o.stDur = 12; }
        }
      } else if (b.owner === p.id) {
        b.owner = -1; b.vx = p.vx + lx * p.stB * 2.8; b.vy = p.vy + ly * p.stB * 2.8; b.vz = 0; b.last = p.id; b.kt = 0; invalidatePath(w);
      }
    }
    if (t > 9) { p.vx *= 0.96; p.vy *= 0.96; }
  } else if (p.stA === SKILL.HEEL) {
    p.vx *= 0.88; p.vy *= 0.88;
    if (t === 5 && b.owner === p.id) {
      // off his heel: to the team-mate behind him most nearly the way he
      // faces away (rolled to arrive at a pace he can take), or a few metres
      // into the space there – then he spins round after it
      let mate = null, best = 1e9;
      for (const o of w.players) {
        if (o === p || o.team !== p.team) continue;
        const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy), c = -(dx * fx + dy * fy) / (d || 1);
        if (d < 2.5 || d > 22 || c < 0.75) continue;
        const score = (1 - c) * 20 + d * 0.15 + (o.role === ROLE.GK ? 4 : 0);
        if (score < best) { best = score; mate = o; }
      }
      const tx = mate ? mate.x + mate.vx * 0.4 : p.x - fx * (3 + 2 * q), ty = mate ? mate.y + mate.vy * 0.4 : p.y - fy * (3 + 2 * q);
      const bx = p.x - fx * 0.12, by = p.y - fy * 0.12, d = Math.hypot(tx - bx, ty - by);
      const a = Math.atan2(ty - by, tx - bx) + (1 - q) * gauss(w) * 0.35;
      const v = Math.min(18, groundSpeedFor(d, mate ? 4 + 0.08 * d : 0.8)) * (0.75 + 0.25 * q);
      b.owner = -1; b.held = 0; b.x = bx; b.y = by; b.z = BALL_R; b.vz = 0.3;
      b.vx = Math.cos(a) * v; b.vy = Math.sin(a) * v;
      touchedBy(w, p);
      b.tgt = mate ? mate.id : p.id; b.lastTeam = p.team;
      p.kq = KQ.NOLOOK; p.kcd = 10; // (read late – see the AI's reacting)
      if (!mate) { const [sx, sy, sm] = stickOf(p); p.stB = sm > 0.3 && -fy * sx + fx * sy < 0 ? -1 : 1; }
      w.events.push({ k: 'kick', x: b.x, y: b.y, z: b.z, v: 4, id: p.id });
    }
    if (p.stB && t > 5 && t <= 13) {
      p.face += p.stB * Math.PI / 8;
      if (p.face > Math.PI) p.face -= TAU; else if (p.face < -Math.PI) p.face += TAU;
    }
  } else if (p.stA === SKILL.SOMBRERO) {
    p.vx *= 0.9; p.vy *= 0.9;
    if (t === p.stB && b.owner < 0 && !struckByOther(b, p)) {
      const d = Math.hypot(b.x - p.x - fx * 0.3, b.y - p.y - fy * 0.3);
      if (d < 0.8 && b.z < 0.9) {
        // up over the head of a man in front, to come down a few metres on as
        // he runs round him (the man caught looking up a moment); mistimed,
        // lower, shorter and off line
        const err = (1 - q) * gauss(w) * 0.6, a = Math.atan2(p.ky, p.kx) + err, ux = Math.cos(a), uy = Math.sin(a);
        const vz = 5.0 + 1.4 * q, T = 2 * vz / G, v = (2.6 + 2 * q) / T + Math.max(0, p.vx * ux + p.vy * uy) * 0.5;
        b.z = Math.max(b.z, 0.3); b.vz = vz; b.vx = ux * v; b.vy = uy * v;
        touchedBy(w, p);
        b.tgt = p.id; b.lastTeam = p.team;
        p.kcd = 12;
        for (const o of w.players) {
          if (o.team === p.team) continue;
          const dx = o.x - p.x, dy = o.y - p.y, along = dx * ux + dy * uy;
          if (along > 0.3 && along < 3 && Math.abs(-uy * dx + ux * dy) < 1.2) o.tcd = Math.max(o.tcd, 24);
        }
        const sp = Math.max(3, Math.hypot(p.vx, p.vy));
        p.vx = ux * sp; p.vy = uy * sp;
        w.events.push({ k: 'kick', x: b.x, y: b.y, z: b.z, v: 3, id: p.id });
      } else p.stDur = t + 6;
    }
  } else if (p.stA === SKILL.AROUND) {
    p.vx *= 0.85; p.vy *= 0.85;
    if (t === p.stB && b.owner < 0 && q > 0 && b.last === p.id) {
      // round it and back under it: kept up
      const d = Math.hypot(b.x - p.x - fx * 0.35, b.y - p.y - fy * 0.35);
      if (d < 0.75 && b.z < 0.7) {
        b.vz = 3.4 + 0.6 * q; b.vx = p.vx * 0.9 + fx * 0.15; b.vy = p.vy * 0.9 + fy * 0.15;
        b.last = p.id; b.kt = 0; b.tgt = p.id; invalidatePath(w);
        w.events.push({ k: 'control', x: b.x, y: b.y, z: b.z, v: 3, id: p.id, part: PART.FOOT });
      }
    }
  } else if (p.stA === SKILL.NECK) {
    p.vx *= 0.8; p.vy *= 0.8;
    const [nx, ny, nz] = neckSpot(p, s);
    if (t === p.stB) {
      // there as it comes down: on the back of his neck (a mistimed one he
      // bends too soon or too late for, and it bounces off)
      if (q > 0 && b.owner < 0 && Math.hypot(b.x - nx, b.y - ny, b.z - nz) < 0.55) p.hit = 1;
      else { p.stDur = t + 12; if (b.owner < 0 && b.last === p.id) { b.vz = Math.abs(b.vz) * 0.35 + 0.5; b.vx -= fx * 1.2; b.vy -= fy * 1.2; invalidatePath(w); } }
    }
    if (p.hit === 1 && p.stT >= p.stDur - 1) neckRelease(w, p, false);
  }
}
// Where the ball sits on the back of his neck, bent over (see the renderer)
function neckSpot(p, s) { return [p.x + Math.cos(p.face) * 0.2 * s.H, p.y + Math.sin(p.face) * 0.2 * s.H, s.H * 0.66]; }

// Someone else struck the ball earlier this tick: it's gone.
function struckByOther(b, p) { return b.kt === 0 && b.last !== p.id; }

const AERIAL = new Set([ST.HEADER, ST.VOLLEY, ST.OVERHEAD, ST.DIVEHEAD, ST.CONTROL]);
// Two opponents going for the same ball in the air: height reach and strength
// decide, not who happens to be simulated first. The loser whiffs.
function winsAerialDuel(w, p, s) {
  const b = w.ball;
  for (const q of w.players) {
    if (q.team === p.team || q.hit || !AERIAL.has(q.st) || q.stT < q.stA - 2 || q.stT > q.stA + 4) continue;
    if (near3(q, q.st, b) > T_TOL[q.st] * 1.4) continue; // (both up for it – turning in the air too)
    const sq = stOf(q);
    const chance = clamp(0.5 + (s.reach - sq.reach) * 2 + (s.strength - sq.strength) * 0.6, 0.15, 0.85);
    if (rnd(w) < chance) { q.hit = 2; w.events.push({ k: 'duel', x: b.x, y: b.y }); return true; }
    p.hit = 2;
    w.events.push({ k: 'duel', x: b.x, y: b.y });
    return false;
  }
  return true;
}

function near3(p, st, b) {
  const c = contactPoint(p, st);
  return Math.hypot(c[0] - b.x, c[1] - b.y, (c[2] - b.z) * 0.9);
}

function tackleContact(w, p, ps) {
  const b = w.ball, m = w.m;
  const [fx, fy] = contactPoint(p, ST.TACKLE);
  if (Math.hypot(fx - b.x, fy - b.y) > T_TOL[ST.TACKLE] || b.z > 0.7) return;
  const cf = Math.cos(p.face), sf = Math.sin(p.face);
  if (b.owner >= 0) {
    const o = pById(w, b.owner);
    if (!o || o.team === p.team || b.held || m.spTaker === o.id) return;
    const os = stOf(o);
    const ox = p.x - o.x, oy = p.y - o.y, od = Math.hypot(ox, oy) || 1;
    const behind = (Math.cos(o.face) * ox + Math.sin(o.face) * oy) / od < -0.3;
    let chance = 0.55 + 0.6 * (ps.strength - os.strength) - ((o.ib & BTN.R2) ? 0.15 : 0)
      + clamp(Math.hypot(b.x - o.x, b.y - o.y) - 0.5, 0, 0.6) * 0.5 - (behind ? 0.1 : 0);
    chance = clamp(chance, 0.12, 0.92);
    if (rnd(w) < chance) {
      b.owner = -1; b.held = 0;
      const lat = (rnd(w) - 0.5) * 3;
      b.vx = cf * 4.5 - sf * lat; b.vy = sf * 4.5 + cf * lat; b.vz = 0.6;
      b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.sh = -1;
      o.kcd = 16;
      w.events.push({ k: 'tackle', x: b.x, y: b.y });
      if (behind && rnd(w) < 0.3) foul(w, p, o);
      else if (isFree(o)) { o.st = ST.STUMBLE; o.stT = 0; o.stDur = 18; }
    } else {
      // missed it: off balance – and through the man rather than the ball
      // (his foot where the man's legs are), now and then a foul, more often
      // from behind
      p.st = ST.STUMBLE; p.stT = 0; p.stDur = 20;
      w.events.push({ k: 'miss', x: p.x, y: p.y });
      if (Math.hypot(fx - o.x, fy - o.y) < 0.55 && rnd(w) < (behind ? 0.45 : 0.15)) foul(w, p, o);
    }
  } else {
    b.vx = cf * 6; b.vy = sf * 6; b.vz = 0.3;
    b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.sh = -1;
    invalidatePath(w);
    w.events.push({ k: 'kick', x: b.x, y: b.y, z: b.z, v: 6, id: p.id });
  }
}

// A keeper with a high ball coming straight at him jumps to take it at the top
// of his jump (a ball wide of him is a dive, see beginDive).
function keeperJump(w, p, s) {
  const b = w.ball;
  if (p.role !== ROLE.GK || p.z > 0 || p.vz !== 0 || !isFree(p) || b.owner >= 0 || p.kcd > 0) return;
  if (!keeperHands(w, p) || !catchKey(p) || !inOwnBox(w, p.team, p.x, p.y, 0.6) || (b.last === p.id && b.kt < 20)) return;
  const rvx = b.vx - p.vx, rvy = b.vy - p.vy, v2 = rvx * rvx + rvy * rvy;
  if (v2 < 4) return;
  const tc = ((p.x - b.x) * rvx + (p.y - b.y) * rvy) / v2; // when it's closest
  if (tc <= 0 || tc > 0.6) return;
  const miss = Math.hypot(b.x + rvx * tc - p.x, b.y + rvy * tc - p.y);
  const zc = b.z + b.vz * tc - 0.5 * G * tc * tc;
  if (miss > 0.9 || zc < s.H + 0.05 || zc > s.H + 0.3 + s.jump + 0.3) return;
  const rise = clamp(zc - s.H - 0.05, 0.12, s.jump), vz = Math.sqrt(2 * G * rise);
  if (tc > vz / G + DT) return; // not yet: go up so as to be at the top as it arrives
  p.vz = vz;
  w.events.push({ k: 'jump', x: p.x, y: p.y, id: p.id });
}

function updatePlayer(w, p) {
  const m = w.m, b = w.ball, s = stOf(p), pit = pitchOf(w);
  if (p.kcd > 0) p.kcd--;
  if (p.tcd > 0) p.tcd--;
  if (p.qa && p.qt !== 255 && --p.qt <= 0) { p.qa = 0; p.qt = 0; }
  if (p.stT < 65535) p.stT++;

  if (m.phase === PHASE.KICKOFF) { p.vx = p.vy = 0; p.chgBtn = 0; p.qa = 0; return; }

  handleButtons(w, p); // (the AI presses the same keys – see ai.js driveKey)

  if (p.st !== ST.IDLE && p.st !== ST.STUMBLE) {
    stateUpdate(w, p, s);
    if (p.stT >= p.stDur) { p.st = ST.IDLE; p.stT = 0; p.hit = 0; }
  } else {
    if (p.st === ST.STUMBLE && p.stT >= p.stDur) { p.st = ST.IDLE; p.stT = 0; }
    movement(w, p, s);
    if (!tryQueued(w, p)) tryControl(w, p);
    keeperJump(w, p, s);
  }

  // a player who is no longer able to dribble loses the ball (a keeper keeps
  // a ball he has caught, also while diving)
  if (b.owner === p.id && !(isFree(p) || p.st === ST.KICK || p.st === ST.THROW || p.st === ST.SKILL || (b.held && p.st === ST.DIVE))) {
    b.owner = -1; b.held = 0;
  }

  // keeper holding the ball too long / set piece taker idling
  if (b.owner === p.id && b.held && m.spTaker !== p.id) {
    if (++p.hold > 360 && isFree(p)) startKick(w, p, KICK.PUNT, 0.75);
  } else if (b.owner !== p.id) p.hold = 0;
  if (m.spTaker === p.id && m.cd > 480 && isFree(p)) beginOwnKick(w, p, packKick(KT.MATE, KH.GROUND), 0.5, false);

  p.x += p.vx * DT; p.y += p.vy * DT;
  if (p.z > 0 || p.vz !== 0) {
    p.vz -= G * DT; p.z += p.vz * DT;
    if (p.z <= 0) { p.z = 0; p.vz = 0; }
  }
  // bounds: stay near the pitch and out of the goal frames
  const hx = pit.L / 2, hy = pit.W / 2;
  p.x = clamp(p.x, -hx - 4, hx + 4); p.y = clamp(p.y, -hy - 3.5, hy + 3.5);
  if (Math.abs(p.y) < pit.goalW / 2 + 0.3 && Math.abs(p.x) > hx + 0.15 && Math.abs(p.x) < hx + GOAL_DEPTH + 0.5) {
    p.x = Math.sign(p.x) * (hx + 0.15); p.vx = 0;
  }
}

// A body on the ground (a dive, a slide, a man down) as a segment head to
// feet: along the dive, or the way he faces.
const lying = (p) => (p.st === ST.DIVE || p.st === ST.FALLEN || p.st === ST.SLIDE) && p.z < 0.4;
function bodySeg(p) {
  const a = p.st === ST.DIVE ? p.stA : p.face, ux = Math.cos(a), uy = Math.sin(a);
  return p.st === ST.SLIDE ? [p.x + ux * 0.9, p.y + uy * 0.9, p.x - ux * 0.6, p.y - uy * 0.6]
    : [p.x + ux * 0.8, p.y + uy * 0.8, p.x - ux * 0.9, p.y - uy * 0.9];
}
// from (x, y) to the nearest point of a body on the ground: distance, and the way out
function toBody(p, x, y) {
  const [x0, y0, x1, y1] = bodySeg(p), vx = x1 - x0, vy = y1 - y0;
  const u = clamp(((x - x0) * vx + (y - y0) * vy) / (vx * vx + vy * vy), 0, 1);
  const dx = x - (x0 + vx * u), dy = y - (y0 + vy * u), d = Math.hypot(dx, dy);
  return d > 1e-4 ? [d, dx / d, dy / d] : [0, -vy / Math.hypot(vx, vy), vx / Math.hypot(vx, vy)];
}

function collidePlayers(w) {
  const ps = w.players, b = w.ball;
  const RR = PLAYER_R * 2;
  // a body on the ground is in the way: a man on his feet can't run through
  // it – he's held up, and running into it hard he goes over it (a keeper who
  // dived and took the man, not the ball: a foul)
  for (const a of ps) {
    if (!lying(a) || a.st === ST.SLIDE) continue; // (a slide meets ball or man: see slideContacts)
    for (const c of ps) {
      if (c === a || lying(c) || c.z > 0.5 || c.st === ST.DIVE) continue;
      const [d, nx, ny] = toBody(a, c.x, c.y), R = PLAYER_R * 0.8 + 0.2;
      if (d >= R) continue;
      c.x += nx * (R - d); c.y += ny * (R - d);
      const vin = -(c.vx * nx + c.vy * ny);
      if (vin <= 0) continue;
      c.vx += nx * vin; c.vy += ny * vin;
      if (vin > 4 && isFree(c)) {
        const had = b.owner === c.id || (b.last === c.id && b.kt < 20);
        if (a.st === ST.DIVE && a.team !== c.team && had && !(b.last === a.id && b.kt < 40)) { foul(w, a, c); return; }
        c.st = ST.STUMBLE; c.stT = 0; c.stDur = 22;
        if (b.owner === c.id && !b.held) { b.owner = -1; b.dl = 0; } // (the ball runs on without him)
      }
    }
  }
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    if (a.st === ST.FALLEN || a.st === ST.DIVE || a.z > 0.8) continue;
    for (let j = i + 1; j < ps.length; j++) {
      const c = ps[j];
      if (c.st === ST.FALLEN || c.st === ST.DIVE || c.z > 0.8) continue;
      const dx = c.x - a.x, dy = c.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 >= RR * RR) continue;
      let d = Math.sqrt(d2), nx, ny;
      if (d < 1e-4) { nx = 1; ny = 0; d = 0; } else { nx = dx / d; ny = dy / d; }
      const ov = RR - d;
      let ma = stOf(a).mass, mc = stOf(c).mass;
      if (b.owner === a.id && (a.ib & BTN.R2)) ma *= 1.4;
      if (b.owner === c.id && (c.ib & BTN.R2)) mc *= 1.4;
      const ra = mc / (ma + mc), rc = ma / (ma + mc);
      a.x -= nx * ov * ra; a.y -= ny * ov * ra;
      c.x += nx * ov * rc; c.y += ny * ov * rc;
      const rv = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
      if (rv < 0) {
        a.vx += nx * rv * ra; a.vy += ny * rv * ra;
        c.vx -= nx * rv * rc; c.vy -= ny * rv * rc;
      }
    }
  }
}

// ---------------------------------------------------------------- ball

// Where a ball someone has (at his feet or in his hands) may be: inside the
// lines – except over the opponents' goal line between the posts, where he may
// carry it in to score. Never into his own goal.
function keepIn(w, team, x, y) {
  const pit = pitchOf(w), hx = pit.L / 2 - BALL_R - 0.03, hy = pit.W / 2 - BALL_R - 0.03;
  y = clamp(y, -hy, hy);
  if (Math.abs(x) > hx) {
    const attacking = Math.sign(x) === teamDir(w, team);
    if (!(attacking && Math.abs(y) < pit.goalW / 2 - BALL_R)) x = Math.sign(x) * hx;
  }
  return [x, y];
}

function updateBall(w) {
  const b = w.ball, m = w.m;
  if (b.kt < 255) b.kt++;
  if (b.owner >= 0) {
    const o = pById(w, b.owner);
    if (!o) { b.owner = -1; b.held = 0; }
    else if (b.held) {
      const diving = o.st === ST.DIVE;
      const ha = diving ? o.stA : o.face;
      const fx = Math.cos(ha), fy = Math.sin(ha);
      const throwIn = m.spTaker === o.id;
      const reach = throwIn ? 0.05 : diving ? 0.75 : 0.28;
      let nx = o.x + fx * reach, ny = o.y + fy * reach;
      if (!throwIn) [nx, ny] = keepIn(w, o.team, nx, ny); // a keeper never carries it over his own line
      const nz = Math.max(BALL_R, o.z + (throwIn ? 2.0 : diving ? 0.3 : 1.05));
      b.vx = (nx - b.x) / DT; b.vy = (ny - b.y) / DT; b.vz = 0;
      b.x = nx; b.y = ny; b.z = nz;
      return;
    } else if (m.spTaker === o.id) {
      // dead ball: taker rotates around it
      b.vx = b.vy = b.vz = 0; b.z = BALL_R;
      o.x = b.x - Math.cos(o.face) * 0.5; o.y = b.y - Math.sin(o.face) * 0.5;
      return;
    } else {
      const s = stOf(o);
      const sp = Math.hypot(o.vx, o.vy);
      const sprint = sp > s.jog * 1.1, prec = o.ib & BTN.R2; // big touches at pace
      // touches: the ball eases out ahead and back with no sudden turnarounds –
      // bigger but rarer touches at a sprint (one every ~3.6 m: pushed on
      // ahead of him, out to ~1.3 m – where a man close by can nick it, as
      // real dribblers at full pace keep it furthest off), small ones under R2
      o.dph += sp * DT / (prec ? 1.2 : sprint ? 3.6 : 2.2);
      if (o.dph > 1000) o.dph -= 1000;
      const ease = (1 - Math.cos(2 * Math.PI * (o.dph - Math.floor(o.dph)))) / 2;
      const amp = (prec ? 0.1 : sprint ? 0.85 : 0.35) * Math.min(1, sp / 4) / s.control;
      const tr = trickBall(o);
      const ahead = tr ? tr[0] : o.st === ST.KICK && o.kq === KQ.HEEL ? 0.12 : o.st === ST.KICK || o.st === ST.SKILL ? 0.42 : 0.42 + amp * ease;
      const fx = Math.cos(o.face), fy = Math.sin(o.face);
      const tx = o.x + fx * ahead - fy * (tr ? tr[1] : 0), ty = o.y + fy * ahead + fx * (tr ? tr[1] : 0);
      const k = 1 - Math.exp(-DT * 16 * s.control * (prec ? 1.5 : 1));
      const cx = b.x + o.vx * DT, cy = b.y + o.vy * DT;
      const [nx, ny] = keepIn(w, o.team, cx + (tx - cx) * k, cy + (ty - cy) * k);
      b.vx = (nx - b.x) / DT; b.vy = (ny - b.y) / DT;
      b.x = nx; b.y = ny; b.z = tr ? tr[2] : BALL_R; b.vz = 0; b.spin = 0; b.ts = 0; b.atT = 0;
      if (Math.hypot(b.x - o.x, b.y - o.y) > 2) { b.owner = -1; b.dl = 0; }
      return;
    }
  }
  // a ball stalled on the back of someone's neck rides there (see beginTrick)
  if (b.last >= 0) {
    const q = pById(w, b.last);
    if (q && q.st === ST.SKILL && q.stA === SKILL.NECK && q.hit === 1) {
      const [nx, ny, nz] = neckSpot(q, stOf(q));
      b.vx = (nx - b.x) / DT; b.vy = (ny - b.y) / DT; b.vz = 0; b.x = nx; b.y = ny; b.z = nz; b.kt = 1; b.spin = 0; b.ts = 0;
      return;
    }
  }
  // free ball
  if (b.atT > 0) aftertouch(w, b);
  const onGround = b.z <= BALL_R + 1e-3 && Math.abs(b.vz) < 0.05;
  if (!onGround) { b.vz -= (G + TS_K * b.ts * Math.hypot(b.vx, b.vy)) * DT; b.ts *= 1 - TS_DECAY * DT; } else b.ts = 0;
  const sp = Math.hypot(b.vx, b.vy, b.vz);
  if (sp > 0) {
    const f = Math.max(0, 1 - AIR_K * sp * DT);
    b.vx *= f; b.vy *= f; b.vz *= f;
  }
  if (b.spin !== 0) {
    const vx = b.vx, vy = b.vy;
    b.vx += -vy * b.spin * DT; b.vy += vx * b.spin * DT;
    b.spin *= onGround ? 0.975 : 0.997;
    if (Math.abs(b.spin) < 1e-3) b.spin = 0;
  }
  b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT;
  if (b.z < BALL_R) {
    b.z = BALL_R;
    if (b.vz < -1.0) {
      if (b.vz < -3) w.events.push({ k: 'bounce', x: b.x, y: b.y, v: -b.vz });
      const kh = bounceKeep(b.ts);
      b.vz = -b.vz * (0.55 - 0.1 * b.ts); b.vx *= kh; b.vy *= kh; b.ts *= 0.4;
    } else b.vz = 0;
  }
  if (b.z <= BALL_R + 1e-3 && b.vz === 0) {
    const hs = Math.hypot(b.vx, b.vy);
    if (hs > 0) {
      const ns = Math.max(0, hs - (MU + CF * hs) * DT);
      b.vx *= ns / hs; b.vy *= ns / hs;
    }
  }
  goalFrame(w);
  // perimeter boards keep the ball near the pitch
  const pit = pitchOf(w), bx = pit.L / 2 + 5, by = pit.W / 2 + 4;
  if (Math.abs(b.x) > bx) { b.x = Math.sign(b.x) * bx; b.vx *= -0.3; }
  if (Math.abs(b.y) > by) { b.y = Math.sign(b.y) * by; b.vy *= -0.3; }
}

function aftertouch(w, b) {
  b.atT--;
  const k = pById(w, b.atk);
  if (!k || b.last !== b.atk) { b.atT = 0; b.atk = -1; return; }
  const active = k.im >= 5;
  if (!b.atOn) {
    // Only a fresh input counts: a new direction, or any direction once the
    // stick has been released after the kick.
    if (!active) { b.atM = 0; return; }
    const turned = Math.abs((((k.ia - b.atA) % 256) + 384) % 256 - 128) > 22;
    if (b.atM < 5 || turned) b.atOn = 1;
    else return;
  }
  if (!active) return;
  const hs = Math.hypot(b.vx, b.vy);
  if (hs < 1.5) return;
  const [sx, sy, sm] = stickOf(k);
  const ux = b.vx / hs, uy = b.vy / hs;
  const lat = (-uy * sx + ux * sy) * sm;  // + = left of the flight path
  const lon = (ux * sx + uy * sy) * sm;   // + = along the flight path
  b.spin = clamp(b.spin + lat * AT_CURVE * DT, -AT_SPIN_MAX, AT_SPIN_MAX);
  if (lon < -0.3) b.vz += AT_LIFT * (-lon - 0.3) / 0.7 * DT;
  else if (lon > 0.5 && b.z > BALL_R + 0.05) b.vz -= AT_DIP * (lon - 0.5) / 0.5 * DT;
}

function goalFrame(w) {
  const b = w.ball, pit = pitchOf(w), m = w.m;
  const rr = BALL_R + POST_R;
  for (const side of [-1, 1]) {
    const gx = side * pit.L / 2;
    if (Math.abs(b.x - gx) > GOAL_DEPTH + 1) continue;
    if (b.z < pit.goalH + rr) {
      for (const py of [-pit.goalW / 2, pit.goalW / 2]) {
        const dx = b.x - gx, dy = b.y - py, d = Math.hypot(dx, dy);
        if (d < rr && d > 1e-6) {
          const nx = dx / d, ny = dy / d, vn = b.vx * nx + b.vy * ny;
          if (vn < 0) { b.vx -= 1.65 * vn * nx; b.vy -= 1.65 * vn * ny; w.events.push({ k: 'post', x: b.x, y: b.y }); }
          b.x = gx + nx * rr; b.y = py + ny * rr;
        }
      }
    }
    if (Math.abs(b.y) < pit.goalW / 2) {
      const dx = b.x - gx, dz = b.z - pit.goalH, d = Math.hypot(dx, dz);
      if (d < rr && d > 1e-6) {
        const nx = dx / d, nz = dz / d, vn = b.vx * nx + b.vz * nz;
        if (vn < 0) { b.vx -= 1.65 * vn * nx; b.vz -= 1.65 * vn * nz; w.events.push({ k: 'post', x: b.x, y: b.y }); }
        b.x = gx + nx * rr; b.z = pit.goalH + nz * rr;
      }
    }
    if (m.phase === PHASE.GOAL) {
      const inside = side * (b.x - gx);
      if (inside > 0 && inside < GOAL_DEPTH + 0.6 && Math.abs(b.y) < pit.goalW / 2 + 0.1 && b.z < pit.goalH + 0.1) {
        if (inside > GOAL_DEPTH - BALL_R) { b.x = gx + side * (GOAL_DEPTH - BALL_R); if (side * b.vx > 0) { b.vx *= -0.12; b.vy *= 0.5; b.vz *= 0.5; } }
        if (Math.abs(b.y) > pit.goalW / 2 - BALL_R) { b.y = Math.sign(b.y) * (pit.goalW / 2 - BALL_R); b.vy *= -0.2; }
        if (b.z > pit.goalH - BALL_R) { b.z = pit.goalH - BALL_R; if (b.vz > 0) b.vz *= -0.2; }
      }
    }
  }
}

// ---------------------------------------------------------------- interactions

function canControl(p) { return isFree(p) && p.kcd === 0 && p.z < 0.3; }


// Where the ball would cross a team's goal line: on target or not (between
// the posts, under the bar – a ball that bounces first counts).
function goalLineCross(w, team, b) {
  const pit = pitchOf(w), dir = teamDir(w, team), gx = -dir * pit.L / 2;
  const t = b.vx * dir < -0.5 ? (gx - b.x) / b.vx : -1;
  if (!(t > 0 && t < 2.5)) return { on: false, t: -1, y: 0, z: 0 };
  const y = b.y + b.vy * t, z = b.z + b.vz * t - 0.5 * G * t * t;
  return { on: Math.abs(y) < pit.goalW / 2 + 0.1 && z < pit.goalH + 0.1, t, y, z };
}

// The keeper's hands at the ball for a moment after he has punched it or
// tipped it over (the renderer reaches to kx, ky, stB).
function beginHandsTo(w, p, st, at, kind) {
  p.st = st; p.stT = 0; p.stDur = st === ST.PUNCH ? 24 : 26; p.stA = kind; p.hit = 1;
  p.kx = at[0]; p.ky = at[1]; p.stB = at[2];
  p.chgBtn = 0; p.chg = 0; p.qa = 0;
}

// Tipping a ball that is going in over the bar (a high one, dipping under
// it) or round the post (one by the post, at full stretch in a dive): out
// for a corner instead of back into play. False if a touch can't get it there.
// (STRETCH: how much further a hand or a foot reaches at full stretch, m)
const STRETCH = 0.4;
function tipAway(w, p, s, tgt, at) {
  const b = w.ball, pit = pitchOf(w), gx = -teamDir(w, p.team) * pit.L / 2;
  const k = 0.72 + rnd(w) * 0.1, vx = b.vx * k;
  const t = (gx - b.x) / vx; // till it gets to the line, slowed by the touch
  if (!(t > 0.02 && t < 2)) return false;
  let over;
  if (tgt.z > pit.goalH - 0.8 && b.z > 0.8 * s.H) over = true;
  else if (p.st === ST.DIVE && !p.spr && Math.abs(tgt.y) > pit.goalW / 2 - 0.9) over = false;
  else return false;
  if (over) {
    const vz = (pit.goalH + 0.35 - b.z + 0.5 * G * t * t) / t;
    if (vz - b.vz > 7.5) return false; // more than fingertips can give it
    b.vy = b.vy * k + (rnd(w) - 0.5) * 1.2; b.vz = vz + rnd(w) * 0.8;
  } else {
    const side = tgt.y >= 0 ? 1 : -1;
    const vy = (side * (pit.goalW / 2 + 0.45 + rnd(w) * 0.4) - b.y) / t;
    if (Math.abs(vy - b.vy) > 9) return false;
    b.vy = vy; b.vz = b.vz * 0.6 + 0.4;
  }
  b.vx = vx; b.spin = 0; b.ts = 0;
  b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1;
  p.kcd = 25;
  if (p.st === ST.DIVE) p.hit = 2; // (the top hand flicks it – see the renderer)
  else if (isFree(p)) beginHandsTo(w, p, ST.TIP, at, over ? 0 : 1);
  invalidatePath(w);
  w.events.push({ k: 'save', x: b.x, y: b.y, tip: over ? 1 : 2 });
  return true;
}

// A touch too light to stop it, with one hand or a foot: its way turned by
// up to a rad away from goal – round to the outside of the post it was
// going inside, and up if it's coming in high
function turnAway(w, p, a, at) {
  const b = w.ball, pit = pitchOf(w), tgt = goalLineCross(w, p.team, b);
  const side = tgt.t > 0 ? (tgt.y >= 0 ? 1 : -1) : (b.y >= p.y ? 1 : -1);
  const c = Math.cos(a), sn = Math.sin(a);
  const r1 = [b.vx * c - b.vy * sn, b.vx * sn + b.vy * c], r2 = [b.vx * c + b.vy * sn, -b.vx * sn + b.vy * c];
  [b.vx, b.vy] = r1[1] * side > r2[1] * side ? r1 : r2;
  if (at[2] > pit.goalH - 0.7) b.vz += 6 * a;
  b.spin = 0; b.ts = 0;
  invalidatePath(w);
}

// Punching a high ball clear: with both fists one coming at him goes back out
// the way it came, high and far; with one fist a ball across him is helped on
// its way – always away from goal. A human aims it with the stick. In a crowd
// it's sometimes mistimed.
function punchClear(w, p, at, contest) {
  const b = w.ball, dir = teamDir(w, p.team), v = Math.hypot(b.vx, b.vy);
  const fx = Math.cos(p.face), fy = Math.sin(p.face);
  const inx = v > 0.5 ? b.vx / v : -fx, iny = v > 0.5 ? b.vy / v : -fy;
  const two = -(inx * fx + iny * fy) > 0.6; // coming at him rather than across
  const [sx, sy, sm] = stickOf(p);
  let ux = two ? -inx : inx, uy = two ? -iny : iny;
  if (sm > 0.3) { ux = sx; uy = sy; }
  if (ux * dir < 0.35) ux = 0.35 * dir; // never back towards his own goal
  const a = Math.atan2(uy, ux) + gauss(w) * 0.2;
  let pw = two ? 13 + rnd(w) * 5 : 9 + rnd(w) * 4 + 0.25 * v;
  if (rnd(w) < (contest ? 0.12 : 0.04)) pw *= 0.5;
  b.vx = Math.cos(a) * pw; b.vy = Math.sin(a) * pw; b.vz = 4.5 + rnd(w) * 2.5; b.spin = 0; b.ts = 0;
  b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.sh = -1;
  p.kcd = 22;
  if (isFree(p)) beginHandsTo(w, p, ST.PUNCH, at, two ? 2 : 1);
  invalidatePath(w);
  w.events.push({ k: 'punch', x: b.x, y: b.y, z: b.z, v: pw, id: p.id });
}

// A keeper making himself big: a man on the ball close to him in the box, or
// a ball just struck from there – arms out wide, knees bent, feet apart, so
// that what comes near him meets a hand or a leg (see gkSave and the AI).
export function keeperBig(w, p) {
  if (p.role !== ROLE.GK || p.st !== ST.IDLE || p.z > 0.05) return false;
  const b = w.ball;
  if (b.owner >= 0) {
    const o = pById(w, b.owner);
    return !!o && o.team !== p.team && !b.held && inOwnBox(w, p.team, o.x, o.y, 0) && Math.hypot(o.x - p.x, o.y - p.y) < 8;
  }
  // a ball just struck by them from inside the box (roughly where it came from)
  const t = b.kt * DT;
  return b.lastTeam >= 0 && b.lastTeam !== p.team && b.kt < 30 && Math.hypot(b.x - p.x, b.y - p.y) < 10
    && inOwnBox(w, p.team, b.x - b.vx * t, b.y - b.vy * t, 0);
}
// how far to his side the big stance reaches at height z: his feet low down,
// his hands at hip to shoulder height, only his body above that
export function bigReach(s, z) {
  return z < 0.45 ? 0.5 * s.H : z < 0.85 * s.H ? 0.53 * s.H : 0.3;
}

function gkSave(w, p) {
  const b = w.ball, m = w.m;
  if (p.kcd > 0 || p.role !== ROLE.GK) return false;
  if (b.owner < 0 && !keeperHands(w, p)) return false; // a back-pass: feet only
  // smothering at an attacker's feet: only a low dive, and only if the ball
  // isn't tight to his feet (a heavy touch, a knock-on)
  let victim = null;
  if (b.owner >= 0) {
    victim = pById(w, b.owner);
    if (b.held || p.st !== ST.DIVE || p.stB > 0.6 || b.z > 0.5 || p.hit || !victim || victim.team === p.team || m.spTaker === victim.id) return false;
    if (Math.hypot(b.x - victim.x, b.y - victim.y) < 0.5) return false;
  }
  if (!inOwnBox(w, p.team, b.x, b.y, 0.3) || !inOwnBox(w, p.team, p.x, p.y, 0.6)) return false;
  if (p.st === ST.FALLEN || (p.st === ST.DIVE && p.stT > 30) || !(isFree(p) || p.st === ST.DIVE)) return false;
  if (b.last === p.id && b.kt < 20) return false;
  // (on his feet without the catch key: no hands – a foot out or his body on
  // reflex at most; a ball at him otherwise just comes off him, see blockContacts)
  const keyed = p.st === ST.DIVE || catchKey(p);
  const s = stOf(p);
  // the parts of him that can get to it – segments, how close counts for each,
  // and which are legs (no hands: a block, never a catch), which one hand,
  // and which a hand or a foot at full stretch (STRETCH – further than he
  // gets both hands, being quicker and more agile: it can't hold it, only
  // turn it away)
  let segs, tols, legPart = [], armPart = [], stretchPart = [];
  if (p.st === ST.DIVE && p.spr === GKB.SPREAD) {
    // spread: body across the shot, both ends covered, low
    const ca = Math.cos(p.stA), sa = Math.sin(p.stA), half = 0.55 * s.H + 0.35; // fingertips to boots
    segs = [[p.x - ca * half, p.y - sa * half, 0.25, p.x + ca * half, p.y + sa * half, 0.5]];
    tols = [0.45];
  } else if (p.st === ST.DIVE && p.spr) {
    segs = blockSegs(p, s, b);
    tols = segs.map(() => (p.spr === GKB.SPLITS ? 0.26 : 0.28));
    if (p.spr === GKB.SPLITS) legPart = [0, 1];
  } else if (p.st === ST.DIVE) {
    const ca = Math.cos(p.stA), sa = Math.sin(p.stA);
    const [z0, el, reach] = diveReach(p, s, b);
    const hr = reach * Math.cos(el), hz = Math.max(0.15, z0 - 0.5 * Math.sin(el));
    segs = [
      [p.x - ca * 0.5, p.y - sa * 0.5, hz, p.x + ca * hr, p.y + sa * hr, Math.max(0.15, z0 + reach * Math.sin(el))],
      // his legs trail behind him: a ball under or behind him can still hit them
      [p.x - ca * 0.5, p.y - sa * 0.5, hz, p.x - ca * (0.5 + 0.5 * s.H), p.y - sa * (0.5 + 0.5 * s.H), Math.max(0.12, p.z * 0.5 + 0.12)],
    ];
    tols = [0.45, 0.3];
    legPart = [1];
    // the top hand stretched on past the other, a little higher: fingertips
    const [ex, ey, ez] = segs[0].slice(3), el2 = Math.min(el + 0.3, 1.2);
    segs.push([ex, ey, ez, ex + ca * STRETCH * Math.cos(el2), ey + sa * STRETCH * Math.cos(el2), ez + STRETCH * Math.sin(el2)]);
    tols.push(0.2); armPart.push(2); stretchPart.push(2);
  } else {
    const fx = Math.cos(p.face) * 0.2, fy = Math.sin(p.face) * 0.2;
    segs = [[p.x + fx, p.y + fy, p.z + 0.1, p.x + fx, p.y + fy, p.z + s.H + 0.25]];
    tols = [0.6];
    if (keyed && keeperBig(w, p)) {
      // made himself big: an arm out to each side, shoulder to open hand
      for (const side of [-1, 1]) {
        const lx = -Math.sin(p.face) * side, ly = Math.cos(p.face) * side;
        segs.push([p.x + lx * 0.13 * s.H + fx, p.y + ly * 0.13 * s.H + fy, p.z + 0.8 * s.H,
          p.x + lx * 0.53 * s.H + fx, p.y + ly * 0.53 * s.H + fy, p.z + 0.45 * s.H]);
        tols.push(0.25); // (a glove's width, and a reflex)
        armPart.push(segs.length - 1);
      }
    }
    // a low ball going by beside him: a foot goes out to it (a leg's length
    // from his hip, stretched – further than he can get his hands down in
    // time); a high one beside his head: one arm up to it
    const bl = -Math.sin(p.face) * (b.x - p.x) + Math.cos(p.face) * (b.y - p.y);
    const side = bl > 0 ? 1 : -1, lx = -Math.sin(p.face) * side, ly = Math.cos(p.face) * side;
    if (b.z - p.z < 0.55 && p.z <= 0.05 && isFree(p) && Math.abs(bl) > 0.3) {
      const reach = Math.min(Math.abs(bl), 0.6 * s.H);
      segs.push([p.x + lx * 0.06 * s.H, p.y + ly * 0.06 * s.H, p.z + 0.45 * s.H, p.x + lx * reach + fx, p.y + ly * reach + fy, Math.max(0.1, b.z - p.z)]);
      tols.push(0.22);
      legPart.push(segs.length - 1);
      if (reach > 0.5 * s.H) stretchPart.push(segs.length - 1);
    } else if (keyed && b.z - p.z > 0.85 * s.H && Math.abs(bl) > 0.25) {
      segs.push([p.x + lx * 0.13 * s.H + fx, p.y + ly * 0.13 * s.H + fy, p.z + 0.82 * s.H, p.x + lx * 0.42 * s.H + fx, p.y + ly * 0.42 * s.H + fy, p.z + s.H + 0.45]);
      tols.push(0.2);
      armPart.push(segs.length - 1); stretchPart.push(segs.length - 1);
    }
  }
  const near = (x, y, z) => {
    let best = 1e9, part = 0;
    for (let i = 0; i < segs.length; i++) { const dd = distSeg3(x, y, z, ...segs[i]) - tols[i]; if (dd < best) { best = dd; part = i; } }
    return [best + tols[part], part];
  };
  const [d, part0] = near(b.x, b.y, b.z);
  if (d > tols[part0]) return false;
  const tol = tols[part0];
  // how cleanly he gets to it: how close its line passes him (it is only just
  // inside his reach on the first tick it gets there, however central it is)
  let dPass = d, at = [b.x, b.y, b.z], part = part0;
  for (let k = 1; k <= 6; k++) {
    const t = k * DT * 0.5, q = [b.x + b.vx * t, b.y + b.vy * t, b.z + b.vz * t];
    const [dq, pq] = near(q[0], q[1], q[2]);
    if (dq < dPass) { dPass = dq; at = q; part = pq; }
  }
  // two hands or one: standing, it comes to his body / between his hands
  // rather than to the limit of his reach; diving, along his arms rather than
  // at the fingertips of the top one
  let twoHands = dPass < 0.33 && !armPart.includes(part); // (out on an arm: one hand)
  const leg = legPart.includes(part); // a foot / leg save
  if (p.st === ST.DIVE && !p.spr) {
    // (a full-stretch dive – thrown at a ball well across from him, into
    // the corners, by the posts – gets the top hand to it, never both: only
    // a ball near where he was is gathered in two hands)
    const sg = segs[0], vx = sg[3] - sg[0], vy = sg[4] - sg[1], vz = sg[5] - sg[2];
    const u = ((at[0] - sg[0]) * vx + (at[1] - sg[1]) * vy + (at[2] - sg[2]) * vz) / (vx * vx + vy * vy + vz * vz);
    twoHands = !fullDive(p) && dPass < 0.28 && u < 0.86;
  } else if (p.spr === GKB.KNEE) twoHands = part === KNEE_HANDS && dPass < 0.2; // into the cupped hands
  else if (p.spr) twoHands = false; // spread / star: a block
  // struck from close in and low: no time to get his hands down – it's his
  // legs or body, on reflex (and anything that meets a leg)
  const legs = leg || (!p.spr && p.st !== ST.DIVE && b.kt < 14 && b.z - p.z < 0.75 && Math.hypot(b.vx, b.vy) > 12);
  if (legs) twoHands = false;
  // a rocket from close in straight at his body: it's on him before his hands
  // are – off his chest or stomach, hard to hold
  const zb = b.z - p.z;
  const body = !legs && !p.spr && p.st !== ST.DIVE && b.kt < 12 && zb > 0.48 * s.H && zb < s.H && dPass < 0.3 && Math.hypot(b.vx, b.vy) > 18;
  if (!keyed && !legs && !body) return false;
  if (victim) {
    // one go per dive: the looser the touch, the likelier he gets it
    p.hit = 1;
    const sep = Math.hypot(b.x - victim.x, b.y - victim.y);
    if (rnd(w) > clamp(0.3 + (sep - 0.5) * 0.9, 0.2, 0.85)) { w.events.push({ k: 'miss', x: p.x, y: p.y }); return false; }
    b.owner = p.id; b.held = 1; b.vx = b.vy = b.vz = 0; b.spin = 0; b.ts = 0;
    b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.tgt = -1; b.sh = -1;
    victim.kcd = 20;
    w.events.push({ k: 'catch', x: b.x, y: b.y, smother: 1 });
    return true;
  }
  const rs = Math.hypot(b.vx - p.vx, b.vy - p.vy, b.vz - p.vz);
  const edge = dPass / tol;
  // fingertip contact on a hard shot may not be enough to keep it out
  const hands = 1; // (the same hands for anyone's keeper: the AI's level is how it reads and reacts)
  const stop = clamp((1.45 - rs / 60 - edge * edge * 0.6 - (p.st === ST.DIVE ? 0.05 : 0)) * hands, 0.3, 0.99);
  if (rs > 9 && rnd(w) > stop) {
    const k = 0.7 + rnd(w) * 0.15;
    b.vx *= k; b.vy *= k; b.vz = b.vz * 0.6 + 0.8;
    // one hand or a foot (quicker to it than both hands) still turns it:
    // away from goal – out past the post it was going inside, over the bar
    // if it's high – the firmer the touch, the more; it may yet go in
    if (!twoHands && !body) {
      turnAway(w, p, (0.12 + 0.3 * (1 - Math.min(1, edge))) * (leg ? 0.8 : 1), at);
      // (seen: the top hand flicking it in a dive, a foot out to it, an arm up to it)
      if (p.st === ST.DIVE) p.hit = 2;
      else if (leg && isFree(p) && p.z <= 0) { p.st = ST.BLOCK; p.stT = 3; p.stDur = 22; p.hit = 1; p.stA = Math.atan2(b.y - p.y, b.x - p.x); p.stB = clamp(b.z, 0.12, 0.6); p.kx = b.x; p.ky = b.y; }
      else if (isFree(p)) beginHandsTo(w, p, ST.TIP, at, 1);
    }
    b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1;
    p.kcd = 25;
    w.events.push({ k: 'save', x: b.x, y: b.y, fail: 1 });
    return true;
  }
  const sH = s.H, zr = b.z - p.z;
  const tgt = goalLineCross(w, p.team, b);
  // an opponent going for it too
  let contest = false;
  for (const o of w.players) {
    if (o.team === p.team || o.st === ST.FALLEN) continue;
    if ((Math.hypot(o.x - b.x, o.y - b.y) < 1.8 && b.z < stOf(o).reach + 0.4) || Math.hypot(o.x - p.x, o.y - p.y) < 1.5) { contest = true; break; }
  }
  // a high ball, standing or in the air: punched clear – a human with the
  // shoot key down, the AI when he'd have to catch it in a crowd
  if (!p.spr && p.st !== ST.DIVE && zr > sH * 0.7 && keyed) {
    // (the shot key held for it: the AI's keeper holds it too, when he means to punch)
    if ((p.qa & KICK_MASK) === KT.GOAL) { punchClear(w, p, at, contest); return true; }
  }
  // going back under a ball dropping in over his head: tip it over the bar
  // rather than take it and carry it over his own line
  const back = (p.vx * teamDir(w, p.team)) < -1.2;
  if (tgt.on && back && keyed && !p.spr && zr > sH * 1.05 && rnd(w) < 0.9 && tipAway(w, p, s, tgt, at)) return true;
  // Holding on to it: with two hands on it a keeper catches it – only a
  // rocket gets spilled; with one hand he can only push it away, unless it's
  // a gentle one he can pull in. Someone challenging him for it makes it harder.
  const awkward = (zr < 0.35 ? 0.05 : 0) + (zr > sH + 0.1 ? 0.06 : 0) + (contest ? 0.15 : 0); // skidding along the grass / over his head
  let pc = twoHands
    ? 0.98 - 0.04 * Math.max(0, rs - 20) - (p.st === ST.DIVE ? 0.04 : 0)
    : stretchPart.includes(part) ? 0 : 0.5 - 0.03 * Math.max(0, rs - 6); // (at full stretch: no holding it)
  if (p.spr === GKB.STAR) pc *= 0.3; // arms and legs out: it only drops to him if it's gentle
  if (body) pc *= 0.5;
  pc = clamp((pc - awkward) * hands, 0.04, 0.99);
  if (keyed && rnd(w) < pc) {
    b.owner = p.id; b.held = 1; b.vx = b.vy = b.vz = 0; b.spin = 0; b.ts = 0;
    b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.tgt = -1; b.sh = -1;
    p.hold = 0; p.chgBtn = 0; p.qa = 0;
    w.events.push({ k: 'catch', x: b.x, y: b.y });
  } else {
    // going in: tipped over the bar or round the post if he can
    const arm = keyed && !leg && (!p.spr || (p.spr === GKB.STAR && segs[part][5] > p.z + 0.85 * sH));
    if (tgt.on && !legs && arm && rnd(w) < 0.85 && tipAway(w, p, s, tgt, at)) return true;
    // parried: pushed out wide (to the side it was on) rather than back into
    // the middle, and up – off his legs or a block's body it stays lower. A
    // hard one, or one he only gets a hand to at full stretch, sometimes
    // drops back into the middle instead – the rebound strikers follow in for
    // (more often for a weaker keeper)
    const dir = teamDir(w, p.team);
    const sp = Math.hypot(b.vx, b.vy);
    const low = legs || (p.spr && !arm);
    const side = Math.abs(b.y - p.y) > 0.15 ? Math.sign(b.y - p.y) : (rnd(w) < 0.5 ? -1 : 1);
    const pMid = clamp(0.08 + 0.015 * Math.max(0, sp - 15) + (p.st === ST.DIVE ? 0.08 : 0), 0, 0.4);
    if (body || (!twoHands && rnd(w) < pMid)) {
      // off his body (or that parry): back out in front of him, not far
      b.vx = dir * (2 + sp * 0.15) + (rnd(w) - 0.5) * 2; b.vy = b.vy * 0.15 + (rnd(w) - 0.5) * 3; b.vz = (low ? 0.4 : 1) + rnd(w) * 1.5;
    } else {
      b.vx = dir * (1.2 + sp * 0.1) + (rnd(w) - 0.5) * 2;
      b.vy = b.vy * 0.3 + side * (3.5 + rnd(w) * 4.5);
      b.vz = low ? 0.6 + rnd(w) * 1.6 : 2.2 + rnd(w) * 3.5;
    }
    b.spin = 0; b.ts = 0;
    if ((legs || body) && isFree(p) && p.z <= 0) {
      // the leg that stopped it, out towards the ball – or braced, it off his body
      p.st = ST.BLOCK; p.stT = 3; p.stDur = 22; p.hit = 1;
      p.stA = Math.atan2(b.y - p.y, b.x - p.x); p.stB = body ? clamp(b.z, 0.85, 0.82 * s.H) : clamp(b.z, 0.12, 0.6); p.kx = b.x; p.ky = b.y;
    } else if (stretchPart.includes(part) && isFree(p)) beginHandsTo(w, p, ST.TIP, at, 1); // (an arm up to it)
    else if (stretchPart.includes(part) && p.st === ST.DIVE) p.hit = 2; // (the top hand)
    b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1;
    p.kcd = 20;
    w.events.push({ k: 'save', x: b.x, y: b.y, one: twoHands ? 0 : 1, legs: legs ? 1 : 0, body: body ? 1 : 0 });
  }
  return true;
}

function distSeg3(px, py, pz, ax, ay, az, bx, by, bz) {
  const vx = bx - ax, vy = by - ay, vz = bz - az;
  const l2 = vx * vx + vy * vy + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (py - ay) * vy + (pz - az) * vz) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - ax - vx * t, py - ay - vy * t, pz - az - vz * t);
}

function slideContacts(w) {
  const b = w.ball, m = w.m;
  for (const p of w.players) {
    if (p.st !== ST.SLIDE || p.stT > 26) continue;
    const fx = Math.cos(p.face), fy = Math.sin(p.face);
    const Fx = p.x + fx * 0.85, Fy = p.y + fy * 0.85;
    if (p.stB === 0 && b.z < 0.6 && Math.hypot(Fx - b.x, Fy - b.y) < 0.75 && !b.held && !(b.owner >= 0 && b.owner === m.spTaker)) {
      const prev = b.owner >= 0 ? pById(w, b.owner) : null;
      if (p.stA === 1 && !prev) {
        // keeping it in: hooked back off the line into the pitch
        const pit = pitchOf(w), byTouch = pit.W / 2 - Math.abs(b.y) < pit.L / 2 - Math.abs(b.x);
        const nx = byTouch ? 0 : -Math.sign(b.x), ny = byTouch ? -Math.sign(b.y) : 0, push = 3 + 1.5 * rnd(w);
        const along = (b.vx * ny - b.vy * nx) * 0.25;
        b.vx = nx * push + ny * along; b.vy = ny * push - nx * along; b.vz = 0.3;
        b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.sh = -1; b.atk = -1;
        p.stB = 1;
        invalidatePath(w);
        w.events.push({ k: 'keepin', x: b.x, y: b.y, id: p.id });
      } else if (p.stA === 2 && !prev) {
        // slid in to get there first: struck as he planned it (see slideKickPlan)
        if (!struckByOther(b, p)) { launch(w, p, ST.SLIDE); p.stB = 1; }
      } else if (!prev || prev.team !== p.team) {
        const sp = Math.hypot(p.vx, p.vy), lat = (rnd(w) - 0.5) * 3;
        b.owner = -1; b.held = 0;
        b.vx = fx * (sp * 0.8 + 3) - fy * lat; b.vy = fy * (sp * 0.8 + 3) + fx * lat; b.vz = 0.8 + rnd(w);
        b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.sh = -1;
        p.stB = 1;
        if (prev) prev.kcd = 12;
        w.events.push({ k: 'tackle', x: b.x, y: b.y });
      }
    }
    for (const o of w.players) {
      if (o.team === p.team || o.st === ST.FALLEN || o.st === ST.DIVE || o.z > 0.6) continue;
      if (Math.hypot(o.x - Fx, o.y - Fy) < 0.6 || Math.hypot(o.x - p.x, o.y - p.y) < 0.55) {
        // man before ball is a foul if the ball wasn't playable or it came
        // from behind – and into a keeper with it in his hands, always
        const ballNear = Math.hypot(Fx - b.x, Fy - b.y) < 0.8;
        const fromBehind = Math.cos(angDiff(o.face, p.face)) > 0.5;
        const inHands = b.held && b.owner === o.id;
        if (p.stB !== 2 && (inHands || (p.stB === 0 && (!ballNear || fromBehind)))) { p.stB = 2; foul(w, p, o); }
        else {
          o.st = ST.FALLEN; o.stT = 0; o.stDur = 50;
          if (b.owner === o.id) { b.owner = -1; b.held = 0; }
        }
      }
    }
  }
}

// A ground ball the other side played, coming past (or at) him: does he stop
// it? If not it's gone by – through his legs, or past the leg he stuck out –
// and he can't touch it again on its way past (b.nut).
function slipsPast(w, p) {
  const b = w.ball;
  // (a ball played to him – a keeper's serve in the warm-up – is his to take)
  if (b.lastTeam < 0 || b.lastTeam === p.team || p.role === ROLE.GK || b.tgt === p.id) return false;
  const rvx = b.vx - p.vx, rvy = b.vy - p.vy, v = Math.hypot(rvx, rvy);
  if (v < 4) return false;
  const ux = rvx / v, uy = rvy / v;
  const ox = p.x - b.x, oy = p.y - b.y, ahead = ox * ux + oy * uy;
  const h = ahead > 0 ? Math.abs(ox * uy - oy * ux) : Math.hypot(ox, oy);
  if (rnd(w) < stopChance(p, h, v, ux, uy)) return false;
  b.nut = p.id;
  if (h < 0.2) w.events.push({ k: 'nutmeg', x: p.x, y: p.y, id: p.id, by: b.last });
  else {
    w.events.push({ k: 'beaten', x: p.x, y: p.y, id: p.id, by: b.last });
    if (isFree(p) && p.z <= 0) {
      // the leg goes out for it, a moment too late
      const sx = p.x - ox + ux * Math.max(0, ahead), sy = p.y - oy + uy * Math.max(0, ahead); // nearest point of its line
      p.st = ST.BLOCK; p.stT = 0; p.stDur = 20; p.hit = 1;
      p.stA = Math.atan2(sy - p.y, sx - p.x); p.stB = 0.15; p.kx = sx; p.ky = sy;
      p.face = Math.atan2(-uy, -ux); p.vx *= 0.5; p.vy *= 0.5;
    }
  }
  return true;
}

function possession(w) {
  const b = w.ball, m = w.m;
  if (b.owner >= 0) {
    const o = pById(w, b.owner);
    if (!o || b.held || m.spTaker === o.id) return;
    // run into an opponent's feet – or into a body on the ground (a keeper
    // diving at it, a man down) – the ball is stopped there: a man on his feet
    // has it if he can take it (strength against strength; a keeper in his
    // box gathers it), a keeper down at it smothers it most times, otherwise
    // it comes off him loose
    const os = stOf(o);
    for (const p of w.players) {
      if (p.team === o.team || p.z > 0.4 || p.st === ST.SLIDE) continue; // (a slide: see slideContacts)
      const down = lying(p);
      const [d, nx, ny] = down ? toBody(p, b.x, b.y) : [Math.hypot(b.x - p.x, b.y - p.y), b.x - p.x, b.y - p.y];
      if (d > (down ? 0.3 : 0.36)) continue;
      const hands = p.role === ROLE.GK && keeperHands(w, p) && inOwnBox(w, p.team, b.x, b.y, 0.3) && inOwnBox(w, p.team, p.x, p.y, 0.6);
      const take = clamp(0.62 + 0.4 * (stOf(p).strength - os.strength) - ((o.ib & BTN.R2) ? 0.12 : 0) + (hands ? 0.15 : 0), 0.3, 0.9);
      if ((!down && canControl(p) && p.tcd === 0 && rnd(w) < take) || (down && hands && p.st === ST.DIVE && rnd(w) < 0.75)) {
        b.owner = p.id; b.held = hands ? 1 : 0; b.vx = b.vy = b.vz = 0; b.spin = 0; b.ts = 0;
        b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.tgt = -1; b.sh = -1; p.dph = 0;
        o.kcd = 12;
        w.events.push(hands ? { k: 'catch', x: b.x, y: b.y, smother: 1 } : { k: 'steal', x: b.x, y: b.y });
      } else {
        // off his feet / his body: back out, a little to the side
        const nl = Math.hypot(nx, ny) || 1, v = Math.max(2.5, Math.hypot(o.vx, o.vy) * 0.55), lat = (rnd(w) - 0.5) * 2;
        b.owner = -1; b.held = 0;
        b.vx = nx / nl * v - ny / nl * lat; b.vy = ny / nl * v + nx / nl * lat; b.vz = 0.5;
        b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.sh = -1;
        o.kcd = 12; p.tcd = Math.max(p.tcd, 15);
        invalidatePath(w);
        w.events.push({ k: 'block', x: b.x, y: b.y, z: b.z, v, id: p.id });
      }
      return;
    }
    // a long touch while sprinting can be nicked by a nearby opponent
    if (Math.hypot(b.x - o.x, b.y - o.y) < 0.95) return;
    for (const p of w.players) {
      if (p.team === o.team || !canControl(p) || p.tcd > 0) continue;
      if (Math.hypot(b.x - p.x, b.y - p.y) < 0.55) {
        if (rnd(w) < 0.55 + 0.3 * (stOf(p).strength - os.strength)) {
          b.owner = p.id; b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.tgt = -1; b.sh = -1; p.dph = 0;
          o.kcd = 10;
          w.events.push({ k: 'steal', x: b.x, y: b.y });
        } else p.tcd = 20;
        return;
      }
    }
    return;
  }
  // the man it slipped past can't take it while it's getting away from him –
  // once it's well past him, or has slowed down, it's anyone's
  if (b.nut >= 0) { const q = pById(w, b.nut); if (!q || Math.hypot(b.x - q.x, b.y - q.y) > 1.3 || Math.hypot(b.vx, b.vy) < 3) b.nut = -1; }
  let best = null, bestD = 1e9, zone = 0, rival = null;
  for (const p of w.players) {
    if (b.nut === p.id) continue;
    const settling = p.st === ST.CONTROL && p.hit === 1; // brought it down: collects it at his feet
    if (!canControl(p) && !(settling && b.z < 0.55)) continue;
    if (p.role === ROLE.GK && catchKey(p) && keeperHands(w, p) && inOwnBox(w, p.team, b.x, b.y, 0.3) && inOwnBox(w, p.team, p.x, p.y, 0.6)) continue;
    // (his own flick or keepy-up in the air isn't snatched off its flight:
    // it comes down to him – see tryControl)
    if (b.last === p.id && b.kt < 60 && b.z >= 0.45 && !settling) continue;
    const h = Math.hypot(b.x - p.x, b.y - p.y);
    const s = stOf(p);
    let reach, z;
    if (b.z < 0.55) { reach = 0.62; z = 1; }
    else if (b.z < 1.5) { reach = 0.45; z = 2; }
    else if (b.z < s.H + 0.2) { reach = 0.38; z = 3; }
    else continue;
    if (h < reach) {
      if (z === 1 && slipsPast(w, p)) continue;
      if (h < bestD) { if (best && best.team !== p.team) rival = best; best = p; bestD = h; zone = z; }
      else if (best && best.team !== p.team) rival = p;
    }
  }
  if (!best) return;
  if (rival && rnd(w) < 0.5 + 0.3 * (stOf(rival).strength - stOf(best).strength)) best = rival;
  const p = best;
  const rs = Math.hypot(b.vx - p.vx, b.vy - p.vy);
  // the man it was meant for cushions it: chest balls a little quicker, and a
  // head-high one that isn't hit too hard is brought down instead of headed on
  const meant = b.tgt === p.id && b.lastTeam === p.team;
  if (meant && zone === 3 && rs < 13) zone = 2;
  if ((zone === 1 && rs > 18) || (zone === 2 && rs > (meant ? 17 : 15))) {
    let nx = b.x - p.x, ny = b.y - p.y; const nd = Math.hypot(nx, ny) || 1; nx /= nd; ny /= nd;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) { b.vx -= 1.5 * vn * nx; b.vy -= 1.5 * vn * ny; }
    b.vx *= 0.45; b.vy *= 0.45; b.vz = Math.abs(b.vz) * 0.3 + 0.5;
    b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1;
    p.kcd = 8;
    w.events.push({ k: 'block', x: b.x, y: b.y, z: b.z, v: rs, id: p.id }); // too hot to control: it comes off him
    return;
  }
  if (zone === 3) {
    const fx = Math.cos(p.face), fy = Math.sin(p.face);
    const v = Math.max(4, Math.hypot(b.vx, b.vy) * 0.3);
    b.vx = fx * v; b.vy = fy * v; b.vz = 2;
    b.last = p.id; b.lastTeam = p.team; b.dl = 0; b.kt = 0; b.tgt = -1; b.sh = -1;
    p.kcd = 10;
    w.events.push({ k: 'head', x: b.x, y: b.y, z: b.z, v, id: p.id });
    return;
  }
  b.owner = p.id; b.held = 0; b.vz = 0; b.z = BALL_R; b.spin = 0; b.ts = 0; b.tgt = -1; b.sh = -1;
  b.last = p.id; b.lastTeam = p.team; b.dl = 0;
  p.dph = 0; p.kq = KQ.PLAIN;
  if (p.st === ST.CONTROL) { p.st = ST.IDLE; p.stT = 0; p.hit = 0; }
  w.events.push({ k: 'trap', x: b.x, y: b.y, id: p.id });
  if (p.qa && !p.chgBtn) {
    if ((p.qa & KICK_MASK) === KT.CTRL) p.qa = 0; // (the control key: kept, that's all)
    else if ((p.qa & KICK_MASK) === KT.SELF) beginLift(w, p, p.qp, (p.qa >> 3) & 3);
    else beginOwnKick(w, p, p.qa, p.qp, true);
  }
}

function interact(w) {
  const m = w.m, b = w.ball;
  if (m.phase !== PHASE.PLAY && m.phase !== PHASE.WARMUP) return;
  if (m.wr) return; // a warm-up ball gone out: dead until a keeper has the next one
  slideContacts(w);
  if (m.phase !== PHASE.PLAY && m.phase !== PHASE.WARMUP) return;
  blockContacts(w);
  for (const p of w.players) if (p.role === ROLE.GK && gkSave(w, p)) break;
  possession(w);
  // keep opponents away from a dead-ball taker
  if (m.spTaker >= 0) {
    const t = pById(w, m.spTaker);
    if (!t || b.owner !== t.id) { m.spTaker = -1; return; }
    m.cd++;
    const r = spRadius(w, m.spType);
    for (const p of w.players) {
      if (p.team === t.team) continue;
      const dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy);
      if (d < r) {
        const k = d > 1e-3 ? r / d : 1;
        p.x = b.x + (d > 1e-3 ? dx : -teamDir(w, t.team)) * k; p.y = b.y + (d > 1e-3 ? dy : 0) * k;
      }
    }
  }
}

// ---------------------------------------------------------------- rules

function checkBall(w) {
  const b = w.ball, m = w.m, pit = pitchOf(w);
  const hx = pit.L / 2, hy = pit.W / 2;
  if (Math.abs(b.x) > hx + BALL_R) {
    const side = Math.sign(b.x);
    if (Math.abs(b.y) < pit.goalW / 2 && b.z < pit.goalH) {
      const team = teamDir(w, 0) === side ? 0 : 1;
      // straight in from a throw-in, nobody else touching it: no goal – a
      // goal kick (or a corner, thrown into his own goal)
      if (b.sh === -2 && b.last === b.atk && (m.live || !shootingPractice(w))) {
        const ys = Math.sign(b.y) || 1, defending = 1 - team;
        if (b.lastTeam === defending) startSetPiece(w, SP.CORNER, team, side * (hx - 0.3), ys * (hy - 0.3));
        else startSetPiece(w, SP.GOALKICK, defending, side * (hx - pit.areaD), ys * pit.areaW * 0.3);
        return;
      }
      // a shot that went in off the keeper or a defender is the shooter's goal
      const shooter = b.sh >= 0 ? pById(w, b.sh) : null;
      const credit = b.lastTeam !== team && shooter && shooter.team === team ? shooter.id : b.last;
      m.lastGoalTeam = team; m.scorer = credit;
      if (m.live) { if (team === 0) m.s0++; else m.s1++; }
      b.owner = -1; b.held = 0;
      if (m.spTaker >= 0) m.spTaker = -1;
      setPhase(w, PHASE.GOAL);
      w.events.push({ k: 'goal', team, scorer: credit, own: credit === b.last && b.lastTeam !== team, weight: m.live ? goalWeight(m) : 0 });
      return;
    }
    const defending = teamDir(w, 0) === -side ? 0 : 1;
    const ys = Math.sign(b.y) || 1;
    if (!m.live && shootingPractice(w)) { if (!m.wr) m.wr = WARM_OUT; return; } // shooting practice: a keeper serves the next one
    if (b.lastTeam === defending) startSetPiece(w, SP.CORNER, 1 - defending, side * (hx - 0.3), ys * (hy - 0.3));
    else startSetPiece(w, SP.GOALKICK, defending, side * (hx - pit.areaD), ys * pit.areaW * 0.3);
    return;
  }
  if (Math.abs(b.y) > hy + BALL_R) {
    if (!m.live && shootingPractice(w)) { if (!m.wr) m.wr = WARM_OUT; return; } // shooting practice: a keeper serves the next one
    const team = b.lastTeam === 0 ? 1 : 0;
    startSetPiece(w, SP.THROWIN, team, clamp(b.x, -hx + 0.5, hx - 0.5), Math.sign(b.y) * hy);
  }
}

function rules(w) {
  const m = w.m, b = w.ball;
  if (m.phT < 65535) m.phT++;
  if (m.req0T > 0 && --m.req0T === 0) m.req0 = -1;
  if (m.req1T > 0 && --m.req1T === 0) m.req1 = -1;
  if (m.gkc0 > 0) m.gkc0--;
  if (m.gkc1 > 0) m.gkc1--;
  const halfTicks = Math.round(m.matchLen * 30);
  switch (m.phase) {
    case PHASE.WARMUP: case PHASE.PLAY:
      // warm-up, ball out: it rolls away for a moment, then a keeper has one
      if (m.wr && --m.wr === 0) { warmRestart(w, -1, b.x, b.y); break; }
      if (m.wr) break;
      checkBall(w);
      if (m.phase === PHASE.PLAY && m.live) {
        m.clock++;
        if (m.clock >= halfTicks * m.half) {
          b.owner = -1; b.held = 0; m.spTaker = -1;
          setPhase(w, m.half === 1 ? PHASE.HALFTIME : PHASE.FULLTIME);
          w.events.push({ k: 'whistle', n: m.half === 1 ? 2 : 3 });
        }
      }
      break;
    case PHASE.GOAL:
      // (a warm-up goal: no celebration – just long enough to see it hit the net)
      if (m.phT >= goalTicks(m)) {
        if (m.live && m.clock >= halfTicks * m.half) {
          setPhase(w, m.half === 1 ? PHASE.HALFTIME : PHASE.FULLTIME);
          w.events.push({ k: 'whistle', n: m.half === 1 ? 2 : 3 });
        } else if (!m.live && shootingPractice(w)) warmRestart(w, m.lastGoalTeam >= 0 ? 1 - m.lastGoalTeam : -1, 0, 0);
        else startKickoff(w, m.lastGoalTeam >= 0 ? 1 - m.lastGoalTeam : 0); // the team that conceded kicks off
      }
      break;
    case PHASE.SETPIECE:
      if (m.phT > 20) { b.vx *= 0.9; b.vy *= 0.9; }
      if (m.phT >= 50) takeSetPiece(w);
      break;
    case PHASE.KICKOFF:
      if (m.phT >= 75) {
        let taker = null, bd = 1e9;
        for (const p of w.players) if (p.team === m.ko) {
          const d = Math.hypot(p.x, p.y) + (p.role === ROLE.GK ? 100 : 0);
          if (d < bd) { bd = d; taker = p; }
        }
        if (taker) {
          const dir = teamDir(w, m.ko);
          taker.x = -dir * 0.45; taker.y = 0; taker.face = dir > 0 ? 0 : Math.PI;
          b.owner = taker.id; b.last = taker.id; b.lastTeam = taker.team;
          b.x = 0; b.y = 0;
          // the kick-off team plays it first: the taker plays it on (as at a
          // set piece) while the other team waits outside the centre circle
          // (shooting practice: it's just his ball)
          if (m.live || !shootingPractice(w)) { m.spTaker = taker.id; m.spType = SP.KICKOFF; m.spTeam = taker.team; m.cd = 0; }
        }
        resumePhase(w);
        w.events.push({ k: 'whistle', n: 1 });
      }
      break;
    case PHASE.HALFTIME:
      if (m.phT >= 200) {
        m.half = 2; m.dir0 = -m.dir0;
        startKickoff(w, 1 - m.koFirst);
      }
      break;
    case PHASE.FULLTIME:
      if (m.phT >= 600) { m.live = 0; startKickoff(w, 0); }
      break;
  }
}

// ---------------------------------------------------------------- step

// inputs: Map<playerId, {a, m, b}> for human players (stick angle byte,
// magnitude 0..15, button bits). Missing entries repeat the last input.
export function step(w, inputs) {
  w.events.length = 0;
  w.tick++;
  const b = w.ball, rl = w.m.real ? 1 : 0;
  for (const p of w.players) { p.px = p.x; p.py = p.y; p.pz = p.z; p.rl = rl; }
  b.px = b.x; b.py = b.y; b.pz = b.z;
  if (inputs) {
    for (const p of w.players) {
      if (!p.human) continue;
      const i = inputs.get(p.id);
      if (i) { p.ia = i.a; p.im = i.m; p.ib = i.b; p.miss = 0; p.bot = 0; }
      else if (w.auth && p.miss < 255 && ++p.miss > BOT_AFTER && !p.bot) {
        // only the authoritative side decides an input is missing; clients learn
        // it from the snapshot and keep predicting the AI until inputs return
        p.bot = 1; p.chgBtn = 0; p.chg = 0; p.qa = 0;
      }
    }
  }
  for (const p of w.players) if (!byPerson(p)) aiThink(w, p);
  for (const p of w.players) updatePlayer(w, p);
  collidePlayers(w);
  updateBall(w);
  interact(w);
  callOffside(w);
  rules(w);
  for (const p of w.players) p.pb = p.ib;
}

// Offside (room setting m.offs): as a man plays it, which of his side are in
// an offside position – in the other half, beyond both the ball and the
// second-last of theirs (not from a throw-in, a corner or a goal kick); if
// one of them is next to touch it, a free kick to the other side where he
// stood. (Anyone else touching it first – theirs, or one of ours who was
// onside – and it's played on.)
export function offsidePos(w, team, q, bx) {
  const dir = teamDir(w, team), dq = q.x * dir;
  if (dq <= 0 || dq <= bx * dir + 0.15) return false;
  let a = -Infinity, c = -Infinity; // (their deepest two)
  for (const o of w.players) {
    if (o.team === team) continue;
    const d = o.x * dir;
    if (d > a) { c = a; a = d; } else if (d > c) c = d;
  }
  return dq > c + 0.15;
}
function markOffside(w, p) {
  w.off = null;
  const m = w.m;
  if (!m.offs || (m.spTaker === p.id && (m.spType === SP.THROWIN || m.spType === SP.CORNER || m.spType === SP.GOALKICK))) return;
  const ids = [];
  for (const q of w.players) if (q.team === p.team && q !== p && offsidePos(w, p.team, q, w.ball.x)) ids.push(q.id);
  if (ids.length) w.off = { k: p.id, ids };
}
function callOffside(w) {
  const o = w.off, b = w.ball;
  if (!o) return;
  if (w.m.phase !== PHASE.PLAY) { w.off = null; return; }
  if (b.last === o.k) return;
  w.off = null;
  if (!o.ids.includes(b.last)) return;
  const q = pById(w, b.last), pit = pitchOf(w);
  if (!q) return;
  w.events.push({ k: 'offside', id: q.id, x: q.x, y: q.y });
  if (b.owner === q.id) { b.owner = -1; b.held = 0; }
  startSetPiece(w, SP.FREEKICK, 1 - q.team, clamp(q.x, -pit.L / 2 + 1, pit.L / 2 - 1), clamp(q.y, -pit.W / 2 + 1, pit.W / 2 - 1), 1);
}
