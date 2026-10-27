// The keys the AI players press, over their heads, in developer mode (see
// devview.js) – they play by the same
// keys as people (see the README's "Playing by the keys"): the arrow pushed
// (the stick as a keyboard has it: the nearest of the eight ways on screen),
// the jog key at a part tilt, the kick key held (filling as it charges), R1
// and R2 – named as your own keys are. A key let go stays up a quarter of a
// second and then fades, so a tap (a keeper's dive, a slide, a block) can be read.
import { BTN, KICK_MASK, kickTarget, kickHeight } from '../shared/constants.js';
import { byPerson, CHG_MAX } from '../shared/sim.js';
import { kickKeys } from './input.js';

const HOLD = 15, FADE = 36; // ticks a key stays up after it's let go, the last of them fading
const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗']; // by the way on screen, from the right clockwise (y down)

export class AIKeys {
  constructor(keyName) { this.keyName = keyName; this.seen = new Map(); this.on = true; }

  // every simulated tick: what each AI player has pressed, and when
  tick(w) {
    if (!this.on) return;
    for (const p of w.players) {
      if (byPerson(p)) continue;
      let s = this.seen.get(p.id);
      if (!s) { s = { a: 0, m: 0, st: -99, k: 0, kt: -99, r1: -99, r2: -99 }; this.seen.set(p.id, s); }
      if (p.im > 0) { s.a = p.ia; s.m = p.im; s.st = w.tick; }
      if (p.ib & KICK_MASK) { s.k = p.ib & (KICK_MASK | (3 << 3)); s.kt = w.tick; }
      if (p.ib & BTN.SPRINT) s.r1 = w.tick;
      if (p.ib & BTN.R2) s.r2 = w.tick;
    }
  }

  // Over p's head, centred on X, standing on y; returns the top of what it drew.
  draw(r, w, p, X, y) {
    const s = this.on && !byPerson(p) && this.seen.get(p.id);
    if (!s) return y;
    const age = (t) => w.tick - t, lit = (t) => age(t) >= 0 && age(t) <= FADE;
    const caps = [];
    if (lit(s.st)) {
      // the stick's way on the ground, turned back into the screen's
      const t = s.a * (Math.PI * 2 / 256), wx = Math.cos(t), wy = Math.sin(t);
      const [rx, ry] = r.cam.screenDirToWorld(1, 0), [dx, dy] = r.cam.screenDirToWorld(0, 1);
      const ux = wx * rx + wy * ry, uy = wx * dx + wy * dy;
      caps.push({ text: ARROWS[(Math.round(Math.atan2(uy, ux) / (Math.PI / 4)) + 8) % 8], age: age(s.st) });
      if (s.m < 15) caps.push({ text: this.keyName('jog'), age: age(s.st) });
    }
    if (lit(s.kt)) {
      const held = (p.ib & (KICK_MASK | (3 << 3))) === s.k && p.chgBtn === s.k;
      // (a level up or down: the higher / lower key with it – a high through ball or shot, Shift)
      const [mod, b] = kickKeys(kickTarget(s.k), kickHeight(s.k));
      caps.push({ text: (mod ? `${this.keyName(mod)}+` : '') + this.keyName(b), age: age(s.kt), fill: held ? Math.min(1, p.chg / CHG_MAX) : 0 });
    }
    if (lit(s.r1)) caps.push({ text: this.keyName('sprint'), age: age(s.r1) });
    if (lit(s.r2)) caps.push({ text: this.keyName('r2'), age: age(s.r2) });
    if (!caps.length) return y;

    const g = r.gu, d = r.dpr, k = Math.round(10 * d), gap = Math.max(1, Math.round(1.5 * d));
    g.font = `700 ${Math.round(k * 0.62)}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const c of caps) c.w = Math.max(k, Math.ceil(g.measureText(c.text).width + 5 * d));
    let x = Math.round(X - (caps.reduce((n, c) => n + c.w, 0) + gap * (caps.length - 1)) / 2);
    const top = Math.round(y) - k;
    for (const c of caps) {
      // (see-through: the play matters more than the keys)
      g.globalAlpha = 0.7 * (c.age <= HOLD ? 1 : 1 - (c.age - HOLD) / (FADE - HOLD + 1));
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.beginPath(); g.roundRect(x, top, c.w, k, 2 * d); g.fill();
      if (c.fill > 0) {
        g.fillStyle = c.fill < 0.6 ? '#7ee06a' : c.fill < 0.88 ? '#f4d03f' : '#ff5a4f';
        g.beginPath(); g.roundRect(x, top, c.w * c.fill, k, 2 * d); g.fill();
      }
      g.fillStyle = '#10200c';
      g.fillText(c.text, x + c.w / 2, top + k / 2 + 0.5 * d);
      x += c.w + gap;
    }
    g.globalAlpha = 1; g.textBaseline = 'alphabetic';
    return top;
  }
}
