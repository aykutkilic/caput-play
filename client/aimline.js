// The aim line: while you hold a kick key with the ball at your feet, the
// kick as it would go if you let go now – its flight, bending as the strike
// will, to the hole or the team-mate it picks, ending in a ring there. Worked
// out by the same planning the kick uses (planKick, on a copy of you), so it
// follows the stick, the key's row (feet / chest / head; low / mid / top) and
// the power as it builds.
import { pById, planKick, kickKind, CHG_MAX } from '../shared/sim.js';
import { kickFlight } from '../shared/lanes.js';
import { KT, KICK_MASK, BTN, SP } from '../shared/constants.js';

export class AimLine {
  constructor() { this.cache = null; }

  draw(r, w, myId) {
    const p = pById(w, myId), b = w.ball, m = w.m;
    const target = p ? p.chgBtn & KICK_MASK : 0;
    if (!p || !target || target === KT.SELF || b.owner !== p.id || b.held || (m.spTaker === p.id && m.spType === SP.THROWIN)) { this.cache = null; return; }
    // (again only when something it depends on changes, or every few ticks as they move)
    const key = `${w.tick >> 2}:${p.chgBtn}:${p.ia}:${p.im}:${p.ib & BTN.R2}:${p.chg >> 3}`;
    if (!this.cache || this.cache.key !== key) {
      const q = { ...p };
      planKick(w, q, kickKind(q, target), Math.max(0.05, p.chg / CHG_MAX), undefined, undefined, -1, (p.chgBtn >> 3) & 3);
      this.cache = { key, pts: kickFlight(w, q) };
    }
    const g = r.gu, cam = r.cam, dpr = r.dpr || 1, pts = this.cache.pts;
    if (!g || !cam || pts.length < 2) return;
    const vis = (q) => !cam.persp || cam.ahead(q.x, q.y, q.z, 0.2);
    g.save();
    g.setLineDash([6 * dpr, 4 * dpr]);
    g.lineCap = 'round';
    // a dark edge under a light line: readable on grass and against the stands
    for (const [col, wd] of [['rgba(0,0,0,0.35)', 4], ['rgba(255,255,255,0.85)', 2]]) {
      g.strokeStyle = col; g.lineWidth = wd * dpr; g.beginPath();
      let on = false;
      for (const q of [{ x: b.x, y: b.y, z: b.z }, ...pts]) {
        if (!vis(q)) { on = false; continue; }
        const X = cam.px(q.x, q.y, q.z), Y = cam.py(q.x, q.y, q.z);
        if (on) g.lineTo(X, Y); else { g.moveTo(X, Y); on = true; }
      }
      g.stroke();
    }
    g.setLineDash([]);
    const e = pts[pts.length - 1];
    if (vis(e)) {
      const X = cam.px(e.x, e.y, e.z), Y = cam.py(e.x, e.y, e.z);
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2 * dpr;
      g.beginPath(); g.arc(X, Y, 5 * dpr, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
  }
}
