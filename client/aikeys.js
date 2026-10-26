// The keys the AI players press, over their heads – they play by the same
// keys as people (see the README's "Playing by the keys"): the arrow pushed
// (the stick as a keyboard has it: the nearest of the eight ways on screen),
// the jog key at a part tilt, the kick key held (filling as it charges), R1
// and R2 – named as your own keys are. A key pressed for a tick (a slide, a
// block, a dive) stays up a moment, so it can be seen.
import { KT, BTN, KICK_MASK, kickTarget, kickHeight } from '../shared/constants.js';
import { byPerson, CHG_MAX } from '../shared/sim.js';

const LIT = 12; // ticks a key stays lit after it's let go
const KICK_COL = { [KT.RUN]: 'run', [KT.MATE]: 'mate', [KT.GOAL]: 'goal', [KT.SELF]: 'self' };
const KICK_ROW = ['G', 'M', 'H']; // KH.GROUND, MID, HIGH (the binding names: mateG, goalH, ...)
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
    const lit = (t) => w.tick - t >= 0 && w.tick - t <= LIT;
    const caps = [];
    if (lit(s.st)) {
      // the stick's way on the ground, turned back into the screen's
      const t = s.a * (Math.PI * 2 / 256), wx = Math.cos(t), wy = Math.sin(t);
      const [rx, ry] = r.cam.screenDirToWorld(1, 0), [dx, dy] = r.cam.screenDirToWorld(0, 1);
      const ux = wx * rx + wy * ry, uy = wx * dx + wy * dy;
      caps.push({ text: ARROWS[(Math.round(Math.atan2(uy, ux) / (Math.PI / 4)) + 8) % 8] });
      if (s.m < 15) caps.push({ text: this.keyName('jog') });
    }
    if (lit(s.kt)) {
      const held = (p.ib & (KICK_MASK | (3 << 3))) === s.k && p.chgBtn === s.k;
      caps.push({ text: this.keyName(KICK_COL[kickTarget(s.k)] + KICK_ROW[kickHeight(s.k)]), fill: held ? Math.min(1, p.chg / CHG_MAX) : 0 });
    }
    if (lit(s.r1)) caps.push({ text: this.keyName('sprint') });
    if (lit(s.r2)) caps.push({ text: this.keyName('r2') });
    if (!caps.length) return y;

    const g = r.gu, d = r.dpr, k = Math.round(10 * d), gap = Math.max(1, Math.round(1.5 * d));
    g.font = `700 ${Math.round(k * 0.62)}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const c of caps) c.w = Math.max(k, Math.ceil(g.measureText(c.text).width + 5 * d));
    let x = Math.round(X - (caps.reduce((n, c) => n + c.w, 0) + gap * (caps.length - 1)) / 2);
    const top = Math.round(y) - k;
    g.globalAlpha = 0.7; // (see-through: the play matters more than the keys)
    for (const c of caps) {
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
