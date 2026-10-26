// Effects round the play, all drawn by the renderer and none of them part of
// the game (they never change what happens):
//  * bits of grass (snow, spray) and puffs off a hard kick, a tackle, a
//    landing, a slide or a dive – the 3D layer's particle pools;
//  * marks on the grass where a slide or a dive went, fading away;
//  * the ball squashed for a moment by a hard kick;
//  * the net bulging where the ball hits it, the frame shuddering off the
//    woodwork, and the camera's small kick at a hard shot, the woodwork or
//    a goal (none if the system asks for reduced motion).
// What the game reports (kicks, the woodwork, a goal) comes in as events;
// the rest – slides, landings, the net – is read off what is drawn, so goal
// replays have it too.

import { ST, GOAL_DEPTH, BALL_R } from '../shared/constants.js';
import { pitchOf } from '../shared/sim.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = (a, b) => a + Math.random() * (b - a);
// sRGB hex -> linear { r, g, b } (the 3D layer's colours)
const lin = (h) => { const n = parseInt(h.slice(1), 16), c = (v) => Math.pow(v / 255, 2.2); return { r: c(n >> 16), g: c((n >> 8) & 255), b: c(n & 255) }; };

// what flies up, and what's left on the ground, by the weather (see setWeather)
const GROUNDS = {
  grass: { bits: ['#4f9d58', '#3a7f45', '#2e6838', '#6b5638'].map(lin), puff: lin('#e6eedc'), puffA: 0.32, mark: '86,74,44', markA: 0.34 },
  wet: { bits: ['#cfe2ff', '#e8f2ff', '#4f9d58', '#4a3d28'].map(lin), puff: lin('#eef5ff'), puffA: 0.4, mark: '58,48,30', markA: 0.4 },
  snow: { bits: ['#ffffff', '#eef3fa', '#dfe8f2', '#ffffff'].map(lin), puff: lin('#ffffff'), puffA: 0.5, mark: '62,120,70', markA: 0.55 },
};

export class Effects {
  constructor(r) {
    this.r = r;
    this.marks = [];          // { pts: [[x, y]...], w, t0, life }
    this.pl = new Map();      // per player: last height, the mark he's making
    this.shake = null;        // { t0, a }
    this.squash = null;       // { t0, k }
    this.ground = GROUNDS.grass;
    this.lite = false;        // fewer particles (a slow device)
    this.still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.netCool = 0;
  }

  setGround(kind) { this.ground = GROUNDS[kind] || GROUNDS.grass; }

  // ---------------------------------------------------------------- events

  event(e) {
    const g = this.ground;
    switch (e.k) {
      case 'kick': case 'shot': case 'head': case 'punch': case 'block': {
        const v = e.v || 0;
        if (v > 16 && e.k !== 'head') this.squash = { t0: this.r.time, k: clamp((v - 12) / 18, 0.3, 1) };
        if ((e.z ?? 1) < 0.35 && v > 13 && e.k !== 'punch') {
          // off the grass: bits flying up from the boot, a little puff
          this.bits(e.x, e.y, 0.05, Math.round(clamp(v / 3, 3, 10)), 1.6, 2.6);
          this.puff(e.x, e.y, 0.12, 1, 0.6);
        }
        if (e.k === 'shot' && v > 24) this.kick(clamp((v - 22) / 26, 0, 1) * 0.1);
        break;
      }
      case 'post': {
        this.r.s3 && this.r.s3.postHit(Math.sign(e.x) || 1);
        this.kick(0.12);
        break;
      }
      case 'goal': this.kick(0.2); break;
      case 'tackle': case 'steal': case 'foul': this.bits(e.x, e.y, 0.05, 6, 1.4, 2.2); this.puff(e.x, e.y, 0.15, 1, 0.5); break;
      case 'bounce': if ((e.v || 0) > 5) this.bits(e.x, e.y, 0.03, g === GROUNDS.wet ? 6 : 2, 1, 1.6); break;
    }
  }

  // ---------------------------------------------------------------- each frame

  // Before the 3D layer is drawn: slides, landings and the net, from what's on
  // screen; then the particles move on.
  step(w, ppos, Js, ball, dt) {
    const r = this.r, now = r.time;
    for (const p of w.players) {
      const [x, y, z] = ppos.get(p.id);
      let s = this.pl.get(p.id);
      if (!s) { s = { z, mark: null, acc: 0 }; this.pl.set(p.id, s); }
      const sp = Math.hypot(p.vx, p.vy);
      // on the grass at speed – a slide, a keeper's dive sliding along it
      const sliding = (p.st === ST.SLIDE || (p.st === ST.DIVE && z < 0.3)) && sp > 1.2;
      if (sliding && dt > 0) {
        const J = Js.get(p.id), fx = J ? (J.footL[0] + J.footR[0]) / 2 : x, fy = J ? (J.footL[1] + J.footR[1]) / 2 : y;
        if (!s.mark) { s.mark = { pts: [[fx, fy]], w: p.st === ST.DIVE ? 0.5 : 0.3, t0: now, life: 14 }; this.addMark(s.mark); }
        else {
          const q = s.mark.pts[s.mark.pts.length - 1];
          if (Math.hypot(fx - q[0], fy - q[1]) > 0.2) { s.mark.pts.push([fx, fy]); s.mark.t0 = now; }
        }
        s.acc += dt * (this.lite ? 14 : 34) * Math.min(1, sp / 5);
        for (; s.acc >= 1; s.acc--) this.bits(fx, fy, 0.04, 1, 1.2, 2.2, p.vx * 0.5, p.vy * 0.5);
      } else s.mark = null;
      // coming down from a jump or a dive
      if (s.z > 0.16 && z < 0.05) {
        const big = p.st === ST.DIVE || p.st === ST.DIVEHEAD;
        this.puff(x, y, 0.1, big ? 3 : 1, big ? 0.9 : 0.5);
        this.bits(x, y, 0.04, big ? 7 : 3, 1.3, 1.8);
      }
      s.z = z;
    }
    // the wet: spray off a ball skidding along the grass
    const b = w.ball, bs = Math.hypot(b.vx, b.vy);
    if (this.ground === GROUNDS.wet && ball[2] < 0.25 && bs > 6 && b.owner < 0) {
      this.sprayAcc = (this.sprayAcc || 0) + dt * bs * (this.lite ? 1 : 2.5);
      for (; this.sprayAcc >= 1; this.sprayAcc--) this.bits(ball[0], ball[1], 0.05, 1, 0.8, 1.6, b.vx * 0.3, b.vy * 0.3);
    }
    this.netCheck(w, ball, dt);
    if (r.s3) {
      r.s3.stepFx(dt, Math.max(2, 0.05 * r.cam.scale), clamp(0.5 * r.cam.scale, 8, 64));
      r.s3.stepGoals(dt);
    }
  }

  // The ball into the net: it had been going into one of its sides and has
  // stopped (the game holds it inside) – that side bulges out there.
  netCheck(w, ball, dt) {
    const b = w.ball, pv = this.prevV;
    this.prevV = [b.vx, b.vy, b.vz];
    if (this.netCool > 0) { this.netCool -= dt; return; }
    if (!pv || !this.r.s3) return;
    const pit = pitchOf(w), gw = pit.goalW / 2, gh = pit.goalH;
    for (const s of [-1, 1]) {
      const inside = s * (ball[0] - s * pit.L / 2);
      if (inside < 0.05 || inside > GOAL_DEPTH + 0.4 || Math.abs(ball[1]) > gw + 0.3 || ball[2] > gh + 0.3) continue;
      const roof = gh - (gh * 0.25) * clamp(inside / GOAL_DEPTH, 0, 1);
      const sides = [
        [s * pv[0], s * b.vx, inside > GOAL_DEPTH - 0.45],
        [pv[1], b.vy, ball[1] > gw - 0.45], [-pv[1], -b.vy, ball[1] < -gw + 0.45],
        [pv[2], b.vz, ball[2] > roof - BALL_R - 0.35],
      ];
      for (const [was, now, near] of sides) {
        if (near && was > 2.5 && now < was * 0.5) {
          this.r.s3.netHit(s, ball[0], ball[1], ball[2], was);
          this.netCool = 0.25;
          return;
        }
      }
    }
  }

  // the ball's squash this frame (for the 3D layer), stretched along its way
  squashNow(w) {
    const q = this.squash;
    if (!q) return null;
    const u = (this.r.time - q.t0) / 0.1;
    if (u >= 1 || u < 0) { this.squash = null; return null; }
    const b = w.ball;
    if (Math.hypot(b.vx, b.vy, b.vz) < 1) return null;
    return { k: q.k * (1 - u), dir: [b.vx, b.vy, b.vz] };
  }

  // the camera's kick: an offset on the ground (m), dying away in ~0.3 s
  camOffset() {
    const q = this.shake;
    if (!q) return [0, 0];
    const t = this.r.time - q.t0;
    if (t > 0.45 || t < 0) { this.shake = null; return [0, 0]; }
    const e = q.a * Math.exp(-t * 11);
    return [Math.sin(t * 61) * e, Math.cos(t * 47) * e];
  }

  kick(a) {
    if (this.still) return;
    const now = this.r.time, cur = this.shake ? this.shake.a * Math.exp(-(now - this.shake.t0) * 11) : 0;
    if (a > cur) this.shake = { t0: now, a };
  }

  // ---------------------------------------------------------------- pieces

  bits(x, y, z, n, spread, up, vx = 0, vy = 0) {
    const s3 = this.r.s3;
    if (!s3) return;
    if (this.lite) n = Math.ceil(n / 2);
    const cols = this.ground.bits;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rnd(0.3, 1) * spread;
      s3.emit(false, x + rnd(-0.08, 0.08), y + rnd(-0.08, 0.08), z, vx + Math.cos(a) * v, vy + Math.sin(a) * v, rnd(0.5, 1) * up, rnd(0.35, 0.7), cols[(Math.random() * cols.length) | 0], 0.95);
    }
  }

  puff(x, y, z, n, spread) {
    const s3 = this.r.s3;
    if (!s3) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rnd(0.2, 1) * spread;
      s3.emit(true, x, y, z, Math.cos(a) * v, Math.sin(a) * v, rnd(0.2, 0.6), rnd(0.45, 0.7), this.ground.puff, this.ground.puffA, -0.3);
    }
  }

  addMark(m) {
    this.marks.push(m);
    while (this.marks.length > (this.lite ? 12 : 28)) this.marks.shift();
  }

  // The marks on the grass (on the 2D pitch, over its lines), fading out.
  drawMarks() {
    if (!this.marks.length) return;
    const r = this.r, g = r.g, now = r.time, G = this.ground;
    g.lineCap = 'round'; g.lineJoin = 'round';
    this.marks = this.marks.filter((m) => now - m.t0 < m.life);
    for (const m of this.marks) {
      if (m.pts.length < 2) continue;
      const age = now - m.t0, a = G.markA * clamp((m.life - age) / (m.life * 0.5), 0, 1);
      g.strokeStyle = `rgba(${G.mark},${a})`;
      g.lineWidth = m.w * r.cam.scale;
      g.beginPath();
      for (let i = 1; i < m.pts.length; i++) r.paint(m.pts[i - 1][0], m.pts[i - 1][1], m.pts[i][0], m.pts[i][1], m.w);
      g.stroke();
    }
  }
}
