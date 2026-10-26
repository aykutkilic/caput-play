// The keys the AI players press, over their heads – they play by the same
// keys as people (see the README's "Playing by the keys"): the arrows (the
// stick as a keyboard has it: the nearest of the eight ways on screen), the
// jog key at a part tilt, the kick key held (filling as it charges), R1 and
// R2 – named as your own keys are. A key pressed for a tick (a slide, a block,
// a dive) stays lit a moment, so it can be seen.
import { KT, BTN, KICK_MASK, kickTarget, kickHeight } from '../shared/constants.js';
import { byPerson, CHG_MAX } from '../shared/sim.js';

const LIT = 12; // ticks a key stays lit after it's let go
const KICK_COL = { [KT.RUN]: 'run', [KT.MATE]: 'mate', [KT.GOAL]: 'goal', [KT.SELF]: 'self' };
const KICK_ROW = ['G', 'M', 'H']; // KH.GROUND, MID, HIGH (the binding names: mateG, goalH, ...)
const ARROWS = [[1, 1, 0, '↑'], [4, 0, 1, '←'], [2, 1, 1, '↓'], [8, 2, 1, '→']]; // [bit, column, row, glyph]

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
    let arrows = 0;
    if (lit(s.st)) {
      // the stick's way on the ground, turned back into the screen's
      const t = s.a * (Math.PI * 2 / 256), wx = Math.cos(t), wy = Math.sin(t);
      const [rx, ry] = r.cam.screenDirToWorld(1, 0), [dx, dy] = r.cam.screenDirToWorld(0, 1);
      const ux = wx * rx + wy * ry, uy = wx * dx + wy * dy;
      arrows = (uy < -0.38 ? 1 : 0) | (uy > 0.38 ? 2 : 0) | (ux < -0.38 ? 4 : 0) | (ux > 0.38 ? 8 : 0);
      if (s.m < 15) caps.push({ text: this.keyName('jog') });
    }
    if (lit(s.kt)) {
      const held = (p.ib & (KICK_MASK | (3 << 3))) === s.k && p.chgBtn === s.k;
      caps.push({ text: this.keyName(KICK_COL[kickTarget(s.k)] + KICK_ROW[kickHeight(s.k)]), fill: held ? Math.min(1, p.chg / CHG_MAX) : 0 });
    }
    if (lit(s.r1)) caps.push({ text: this.keyName('sprint') });
    if (lit(s.r2)) caps.push({ text: this.keyName('r2') });
    if (!arrows && !caps.length) return y;

    const g = r.gu, d = r.dpr, k = Math.round(12 * d), gap = Math.max(1, Math.round(1.5 * d));
    g.font = `700 ${Math.round(k * 0.62)}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const c of caps) c.w = Math.max(k, Math.ceil(g.measureText(c.text).width + 5 * d));
    const tw = arrows ? 3 * k + 2 * gap : 0;
    const total = tw + (arrows && caps.length ? 2 * gap : 0) + caps.reduce((n, c, i) => n + c.w + (i ? gap : 0), 0);
    let x = Math.round(X - total / 2);
    const bottom = Math.round(y), row1 = bottom - k, row0 = row1 - gap - k;
    const cap = (cx, cy, cw, text, on, fill = 0) => {
      g.fillStyle = on ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.32)';
      g.beginPath(); g.roundRect(cx, cy, cw, k, 2 * d); g.fill();
      if (fill > 0) {
        g.fillStyle = fill < 0.6 ? '#7ee06a' : fill < 0.88 ? '#f4d03f' : '#ff5a4f';
        g.beginPath(); g.roundRect(cx, cy, cw * fill, k, 2 * d); g.fill();
      }
      if (!on) { g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.stroke(); }
      g.fillStyle = on ? '#10200c' : 'rgba(255,255,255,0.45)';
      g.fillText(text, cx + cw / 2, cy + k / 2 + 0.5 * d);
    };
    if (arrows) {
      // the arrow keys, laid out as on a keyboard (an inverted T)
      for (const [bit, col, row, glyph] of ARROWS) cap(x + col * (k + gap), row ? row1 : row0, k, glyph, !!(arrows & bit));
      x += tw + 2 * gap;
    }
    for (const c of caps) { cap(x, row1, c.w, c.text, true, c.fill); x += c.w + gap; }
    g.textBaseline = 'alphabetic';
    return arrows ? row0 : row1;
  }
}
