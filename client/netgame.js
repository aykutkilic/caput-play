// Client-side netcode: full-world prediction with rollback (Rocket League /
// GGPO style), adaptive clock (Overwatch style) and visual error smoothing.
//
//  * The client simulates the whole world *ahead* of the server by
//    ~RTT/2 + a small jitter buffer, so its own input is applied with zero
//    perceived latency and arrives at the server just before it is needed.
//  * Every input packet carries the last 8 inputs, so a lost packet costs nothing.
//  * When an authoritative snapshot for tick S arrives, the client rewinds to it
//    and re-simulates S+1..now with its stored inputs. Remote humans use the
//    inputs the server already holds for those ticks (sent with the snapshot),
//    and beyond that repeat their last known input; AI players are predicted
//    exactly because the AI is deterministic and part of the shared sim.
//  * Any visual discontinuity from a correction is folded into a per-entity
//    offset that decays exponentially, so corrections glide instead of snapping
//    – quickly near the ball, where accuracy decides contests, and slowly far
//    from it, where a smooth picture matters more than the exact spot.
//  * The server reports how early our inputs arrive; we nudge our tick rate
//    (+-6%) to keep that margin minimal but positive.

import { step } from '../shared/sim.js';
import { DT, TICK_RATE } from '../shared/constants.js';
import { encodeInputs, INPUT_REDUNDANCY } from '../shared/protocol.js';

const DT_MS = 1000 / TICK_RATE;
const SMOOTH_NEAR = 0.05;     // s, decay of correction offsets next to the ball
const SMOOTH_FAR = 0.22;      // s, ... 20 m or more away from it
const SNAP_DIST = 3.5;        // m, larger corrections teleport

export class NetGame {
  constructor(net) {
    this.net = net;
    this.world = null;
    this.auth = null;           // last authoritative world (HUD truth: score, phase)
    this.authTick = 0;
    this.myId = -1;
    this.inputHist = new Map(); // tick -> {a, m, b}
    this.remote = new Map();    // other human's id -> Map(tick -> input), from snapshots
    this.inputDelay = 0;        // ticks between pressing and acting (see simTick)
    this.pending = null;
    this.acc = 0;
    this.timeScale = 1;
    this.offsets = new Map();   // entity -> [dx, dy, dz]
    this.sampleInput = () => ({ a: 0, m: 0, b: 0 });
    this.onEvent = () => {};
    this.stats = { lead: 0, target: 2, err: 0, replay: 0, corrections: 0, ahead: 0, resyncs: 0 };
    this.history = [];          // recent authoritative states, for goal replays
    this.lastLead = 0;
  }

  reset() {
    this.world = null; this.auth = null; this.pending = null; this.inputHist.clear(); this.offsets.clear(); this.acc = 0;
    this.remote.clear();
    this.history = [];
  }

  onSnapshot(snap) {
    // keep only the newest; every snapshot is a complete state
    if (!this.pending || snap.world.tick > this.pending.world.tick) this.pending = snap;
  }

  targetLead() {
    return Math.min(8, Math.max(1, 1 + Math.ceil((this.net.jitter * 2) / DT_MS)));
  }

  desiredAhead() {
    // ticks we want to be ahead of a snapshot that has just arrived
    return Math.round(this.net.rtt / DT_MS) + this.targetLead();
  }

  // Rebase on a snapshot and fast-forward to where we should be.
  resync(snap) {
    this.stats.resyncs++;
    this.world = snap.world;
    this.offsets.clear();
    const ahead = this.desiredAhead();
    for (let i = 0; i < ahead; i++) this.simTick(true);
    this.acc = 0;
  }

  // the other humans' real inputs for the ticks after this snapshot
  takeFuture(snap) {
    const S = snap.world.tick;
    for (const [id, map] of this.remote) {
      for (const t of map.keys()) if (t <= S) map.delete(t);
      if (!map.size) this.remote.delete(id);
    }
    if (!snap.future) return;
    for (const [id, list] of snap.future) {
      if (id === this.myId) continue;
      let map = this.remote.get(id);
      if (!map) { map = new Map(); this.remote.set(id, map); }
      for (const it of list) map.set(it.tick, it);
    }
  }

  frameFor(t, own) {
    const frame = new Map();
    for (const [id, map] of this.remote) { const it = map.get(t); if (it) frame.set(id, it); }
    if (own && this.myId >= 0) frame.set(this.myId, own);
    return frame;
  }

  applySnapshot(snap) {
    const S = snap.world;
    const sTick = S.tick;
    this.takeFuture(snap);
    // copy before the rollback below mutates it
    this.history.push({ tick: S.tick, pitchId: S.pitchId, m: { ...S.m }, ball: { ...S.ball }, players: S.players.map((p) => ({ ...p })) });
    if (this.history.length > 340) this.history.shift();
    this.auth = { tick: S.tick, pitchId: S.pitchId, m: { ...S.m } };
    this.authTick = S.tick;
    if (!this.world) { this.resync(snap); return; }
    const C = this.world.tick;
    if (S.tick >= C || C - S.tick > 180) { this.resync(snap); return; }

    // remember where things were drawn before the correction
    const before = this.capture(this.world);

    // rollback: start from the authoritative state and replay our inputs
    const w = S;
    w.replay = true;
    for (let t = S.tick + 1; t <= C; t++) step(w, this.frameFor(t, this.inputHist.get(t)));
    w.replay = false;
    this.stats.replay = C - sTick;
    this.world = w;

    // fold the visual difference into decaying offsets
    let maxErr = 0;
    const after = this.capture(w);
    const ball = after.get('b');
    for (const [k, b] of before) {
      const a = after.get(k);
      if (!a) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const e = Math.hypot(dx, dy, dz);
      maxErr = Math.max(maxErr, e);
      let o = this.offsets.get(k);
      if (!o) { o = [0, 0, 0, SMOOTH_NEAR]; this.offsets.set(k, o); }
      // how fast this correction is allowed to show: by distance from the ball
      const far = k === 'b' ? 0 : Math.min(1, Math.hypot(a[0] - ball[0], a[1] - ball[1]) / 20);
      o[3] = SMOOTH_NEAR + (SMOOTH_FAR - SMOOTH_NEAR) * far;
      if (e > SNAP_DIST * (1 + far) || Math.hypot(o[0] + dx, o[1] + dy) > SNAP_DIST * (1 + far)) { o[0] = o[1] = o[2] = 0; continue; }
      o[0] += dx; o[1] += dy; o[2] += dz;
    }
    this.stats.err = this.stats.err * 0.9 + maxErr * 0.1;
    if (maxErr > 0.05) this.stats.corrections++;

    // clock steering
    if (this.myId >= 0 && snap.lead !== -100) {
      const target = this.targetLead();
      const err = snap.lead - target;
      this.stats.lead = snap.lead; this.stats.target = target;
      if (err < -40 || err > 60) { this.resync(snap); return; }
      if (err < 0) this.timeScale = 1 + Math.min(0.06, -err * 0.012);
      else if (err > 1) this.timeScale = 1 - Math.min(0.05, err * 0.008);
      else this.timeScale = 1;
    } else {
      // spectators: steer purely on RTT estimate
      const err = (C - sTick) - this.desiredAhead();
      this.stats.lead = -err;
      if (Math.abs(err) > 60) { this.resync(snap); return; }
      this.timeScale = err > 2 ? 0.97 : err < -2 ? 1.03 : 1;
    }
    this.stats.ahead = C - sTick;
  }

  capture(w) {
    const m = new Map();
    m.set('b', [w.ball.x, w.ball.y, w.ball.z]);
    for (const p of w.players) m.set(p.id, [p.x, p.y, p.z]);
    return m;
  }

  simTick(silent = false) {
    const w = this.world;
    const t = w.tick + 1;
    let own = null;
    if (this.myId >= 0) {
      // with an input delay of D ticks, what is pressed now is applied D ticks
      // later – and reaches everyone else D ticks earlier than it matters
      const D = this.inputDelay;
      this.inputHist.set(t + D, this.sampleInput());
      this.sendInputs(t + D);
      own = this.inputHist.get(t) || null;
    } else if (t % 6 === 0 && this.net.snapAck) {
      // spectators: just acknowledge snapshots, so they get deltas too
      this.net.sendBinary(encodeInputs(0, [], this.net.snapAck));
    }
    const frame = this.frameFor(t, own);
    w.replay = silent;
    step(w, frame);
    w.replay = false;
    if (!silent) for (const e of w.events) this.onEvent(e, w);
    this.inputHist.delete(t - 240);
  }

  sendInputs(latest) {
    const list = [];
    for (let i = 0; i < INPUT_REDUNDANCY; i++) {
      const it = this.inputHist.get(latest - i);
      if (!it) break;
      list.push(it);
    }
    this.net.sendBinary(encodeInputs(latest, list, this.net.snapAck || 0));
  }

  // When the tab goes to the background, queue neutral inputs so our player
  // stops instead of running with the last held keys.
  sendIdleFuture() {
    if (!this.world || this.myId < 0) return;
    const start = this.world.tick + 1;
    for (let k = 0; k < 120; k += INPUT_REDUNDANCY) {
      const list = [];
      for (let i = 0; i < INPUT_REDUNDANCY; i++) list.push({ a: 0, m: 0, b: 0 });
      this.net.sendBinary(encodeInputs(start + k + INPUT_REDUNDANCY - 1, list, this.net.snapAck || 0));
    }
  }

  // Called once per animation frame. Returns interpolation alpha.
  frame(dtMs) {
    if (this.pending) { const s = this.pending; this.pending = null; this.applySnapshot(s); }
    if (!this.world) return 0;
    if (dtMs > 250) {
      // tab was suspended: the next snapshot will resync us
      this.acc = 0;
      return 1;
    }
    this.acc += dtMs * this.timeScale;
    let n = 0;
    while (this.acc >= DT_MS && n < 8) { this.simTick(false); this.acc -= DT_MS; n++; }
    if (n === 8) this.acc = 0;
    // decay correction offsets
    for (const o of this.offsets.values()) {
      const k = Math.exp(-(dtMs / 1000) / o[3]);
      o[0] *= k; o[1] *= k; o[2] *= k;
    }
    return this.acc / DT_MS;
  }
}

export { DT };
