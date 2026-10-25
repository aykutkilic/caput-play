// Developer mode – Cmd+Shift+D (Ctrl+Shift+D) three times in a row turns it
// on and off (remembered). Drawn over the pitch, what the game is working with
// for whoever has the ball (or you, without it):
//   · the kick fan: directions from the ball for the class he's charging
//     (along the grass when he isn't) – green as far as it gets before one of
//     theirs could get to it, red beyond: their time shadows (shared/lanes.js);
//     a lofted class arcs over the men it clears
//   · the holes in the goal: every target the shot search looks at, coloured
//     by its margin (green: nobody there in time); for you, the hole each shot
//     key picks (its row: low / mid / top) with no stick – ringed, its flight
//     drawn – and with the stick out to either side (the arrow as it points
//     on screen; ↻ bent right, ↺ bent left); for an AI player, his best at each height
//   · the best pass lane to each team-mate, coloured by its odds
//   · the ball's predicted path, the AI's roles and where it's heading
import { pitchOf, teamDir, ballPath, pById, passEndSpeed, loftTime, shotAim, byPerson } from '../shared/sim.js';
import { laneFan, passHole, shotHole } from '../shared/lanes.js';
import { KH, KICK, ROLE, KICK_MASK, FOOT } from '../shared/constants.js';

const ROLE_TAG = ['', 'carry', 'support', 'press', 'mark', 'cover'];
const OPEN = 'rgba(90,235,130,0.5)', SHUT = 'rgba(255,85,70,0.8)';
const marginCol = (m) => (m > 0.1 ? 'rgba(90,235,130,0.95)' : m > -0.1 ? 'rgba(255,214,90,0.95)' : 'rgba(255,85,70,0.9)');
const oddsCol = (o) => (o > 0.7 ? 'rgba(90,235,130,0.9)' : o > 0.4 ? 'rgba(255,214,90,0.9)' : 'rgba(255,85,70,0.85)');

const SHOT_KEY = ['goalG', 'goalM', 'goalH'], PASS_KEY = ['mateG', 'mateM', 'mateH'];

export class DevView {
  // keyLabel(action): the key bound to a binding (e.g. 'goalG' -> 'D')
  constructor(onToggle, keyLabel = (a) => a) {
    this.keyLabel = keyLabel;
    try { this.on = localStorage.getItem('caput.dev') === '1'; } catch { this.on = false; }
    this.presses = [];
    this.cache = null;
    // (capture: the combination never reaches the game – D is a shoot key –
    // nor, where it can be stopped, the browser's own shortcut)
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyD' || !e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const now = performance.now();
      this.presses = this.presses.filter((t) => now - t < 1500);
      this.presses.push(now);
      if (this.presses.length < 3) return;
      this.presses = [];
      this.on = !this.on;
      try { localStorage.setItem('caput.dev', this.on ? '1' : '0'); } catch { /* ignore */ }
      onToggle && onToggle(this.on);
    }, true);
  }

  // the lanes and holes for the man on the ball (worked out every few frames)
  compute(w, myId) {
    const b = w.ball, owner = b.owner >= 0 ? pById(w, b.owner) : null, me = pById(w, myId);
    const p = owner && !b.held ? owner : me;
    if (!p) return null;
    const out = { p, fan: null, holes: [], best: [], passes: [] };
    if (b.owner !== p.id) return out;
    const pit = pitchOf(w), dir = teamDir(w, p.team), gx = dir * pit.L / 2;
    const charging = p.chgBtn ? (p.chgBtn >> 3) & 3 : -1, kh = charging >= 0 ? charging : KH.GROUND;
    const target = p.chgBtn & KICK_MASK;
    // the fan, round where he's facing
    out.fan = { kh, ...laneFan(w, p.team, kh, 0, kh === KH.GROUND ? 20 : 24, p.face, 2.6, 45) };
    // the holes in the goal (in range)
    const dGoal = Math.hypot(gx - b.x, b.y);
    if (dGoal < 36 && (gx - b.x) * dir > 2) {
      const pw = p.chgBtn ? Math.max(0.3, p.chg / 40) : 0.7;
      for (const h of [KH.GROUND, KH.MID, KH.HIGH]) {
        const all = [], best = shotHole(w, p, KICK.SHOT, h, pw, 0, null, [0, -0.5, 0.5], null, all);
        out.holes.push(...all);
        if (!byPerson(p)) { if (best) out.best.push({ ...best, kh: h, stick: 0, pick: false }); continue; }
        // what each key picks: no stick, and the stick out to either side of the goal
        for (const sy of [0, 1, -1]) {
          const a = shotAim(w, p, KICK.SHOT, h, pw, 0, sy, sy ? 1 : 0);
          if (a.hole) out.best.push({ ...a.hole, kf: a.kf, kh: h, stick: sy, pick: target === 3 && h === kh && !sy });
        }
      }
    }
    // the best lane to each team-mate, at the height he's charging (feet otherwise)
    for (const r of w.players) {
      if (r === p || r.team !== p.team || r.role === ROLE.GK) continue;
      const d = Math.hypot(r.x - b.x, r.y - b.y);
      if (d < 3 || d > 40 || (kh !== KH.GROUND && d < 8)) continue;
      const lx = r.x + r.vx * 0.4, ly = r.y + r.vy * 0.4, dl = Math.hypot(lx - b.x, ly - b.y);
      const kv = kh === KH.GROUND ? passEndSpeed(KICK.PASS, dl, 0.4) : loftTime(dl, kh, 0.3);
      const h = passHole(w, p, r, KICK.PASS, kh, lx, ly, kv, kh === KH.GROUND ? [0] : [0, -0.5, 0.5]);
      if (h) out.passes.push(h);
    }
    return out;
  }

  draw(r, w, myId) {
    if (!this.on) return;
    const g = r.gu, cam = r.cam, dpr = r.dpr || 1, b = w.ball;
    if (!g || !cam) return;
    const vis = (x, y, z) => !cam.persp || cam.ahead(x, y, z, 0.2);
    const P = (x, y, z) => [cam.px(x, y, z), cam.py(x, y, z)];
    const path = (pts, col, wd) => {
      g.strokeStyle = col; g.lineWidth = wd * dpr; g.beginPath();
      let on = false;
      for (const [x, y, z] of pts) {
        if (!vis(x, y, z)) { on = false; continue; }
        const [X, Y] = P(x, y, z);
        if (on) g.lineTo(X, Y); else { g.moveTo(X, Y); on = true; }
      }
      g.stroke();
    };
    // a class flight (relative to the ball) turned to th
    const turned = (fl, th, upto = fl.length - 1) => {
      const c = Math.cos(th), sn = Math.sin(th), pts = [[b.x, b.y, b.z]];
      for (let k = 0; k <= Math.min(upto, fl.length - 1); k++) { const q = fl[k]; pts.push([b.x + q.x * c - q.y * sn, b.y + q.x * sn + q.y * c, q.z]); }
      return pts;
    };
    if (!this.cache || this.cache.w !== w || w.tick - this.cache.tick >= 4 || w.tick < this.cache.tick) {
      this.cache = { w, tick: w.tick, d: this.compute(w, myId) };
    }
    const d = this.cache.d;
    g.save();
    // the ball's predicted path (on its own)
    if (b.owner < 0) {
      const pts = ballPath(w).filter((_, k) => k % 2 === 0).map((q) => [q.x, q.y, q.z]);
      path(pts, 'rgba(255,255,255,0.55)', 1.5);
      path(pts.map(([x, y]) => [x, y, 0.02]), 'rgba(0,0,0,0.25)', 1);
    }
    if (d && d.fan) {
      // the kick fan: open (green) as far as it gets first, their shadow (red) beyond
      for (const ray of d.fan.rays) {
        const pts = turned(d.fan.fl, ray.th);
        if (ray.shut < 0) path(pts, OPEN, 1);
        else { path(pts.slice(0, ray.shut + 2), OPEN, 1); path(pts.slice(ray.shut + 1), SHUT, 1.3); }
      }
    }
    if (d) {
      // pass lanes: the best one to each team-mate
      for (const h of d.passes) {
        const pts = turned(h.fl, h.th);
        const end = pts.findIndex(([x, y]) => Math.hypot(x - h.rx, y - h.ry) < 0.6);
        path(end > 0 ? pts.slice(0, end + 1) : pts, oddsCol(h.odds), 2.5);
        if (vis(h.rx, h.ry, 0)) {
          const [X, Y] = P(h.rx, h.ry, 0);
          g.fillStyle = oddsCol(h.odds); g.beginPath(); g.arc(X, Y, 3.5 * dpr, 0, 7); g.fill();
          g.font = `600 ${Math.round(9 * dpr)}px system-ui, sans-serif`; g.textAlign = 'center';
          g.fillText(`${d.p && byPerson(d.p) ? this.keyLabel(PASS_KEY[d.fan ? d.fan.kh : 0]) + ' ' : ''}${Math.round(h.odds * 100)}%${h.kc ? (h.kc > 0 ? ' ↻' : ' ↺') : ''}`, X, Y - 6 * dpr);
        }
      }
      // the holes in the goal mouth, and the best at each height with its flight
      const pit = pitchOf(w), gx = d.p ? teamDir(w, d.p.team) * pit.L / 2 : 0;
      for (const h of d.holes) {
        if (!vis(gx, h.ty, h.z)) continue;
        const [X, Y] = P(gx, h.ty, h.z);
        g.fillStyle = marginCol(h.m); g.globalAlpha = h.kc ? 0.45 : 0.9;
        g.beginPath(); g.arc(X, Y, (h.kc ? 2.5 : 3.5) * dpr, 0, 7); g.fill();
      }
      g.globalAlpha = 1;
      // the stick's arrow for each side of the goal, as it points on this screen
      const [ax0, ay0] = P(gx, -1, 1), [ax1, ay1] = P(gx, 1, 1), sdx = ax1 - ax0, sdy = ay1 - ay0;
      const arrow = (sy) => (Math.abs(sdx) >= Math.abs(sdy) ? (sdx * sy > 0 ? '→' : '←') : (sdy * sy > 0 ? '↓' : '↑'));
      g.font = `700 ${Math.round(10 * dpr)}px system-ui, sans-serif`; g.textAlign = 'center';
      // (the same hole picked more than one way: one ring, one label – "E ←E")
      const spots = new Map();
      for (const h of d.best) {
        const key = `${h.kh}:${h.ty.toFixed(2)}:${h.kc}`;
        if (!spots.has(key)) spots.set(key, []);
        spots.get(key).push(h);
      }
      for (const hs of spots.values()) {
        const h = hs.find((x) => !x.stick) || hs[0], free = hs.some((x) => !x.stick);
        if (free) path(turned(h.fl, h.th).filter((q, k) => k === 0 || Math.hypot(q[0] - b.x, q[1] - b.y) <= Math.hypot(gx - b.x, h.ty - b.y) + 0.3), h.pick ? '#ffffff' : 'rgba(255,255,255,0.45)', h.pick ? 2 : 1.2);
        const z = h.z ?? (h.kh === KH.GROUND ? 0.25 : h.kh === KH.MID ? 1.1 : pit.goalH - 0.3);
        if (!vis(gx, h.ty, z)) continue;
        const [X, Y] = P(gx, h.ty, z);
        g.strokeStyle = '#fff'; g.lineWidth = (free ? 1.5 : 1) * dpr;
        g.beginPath(); g.arc(X, Y, (free ? 6.5 : 4) * dpr, 0, 7); g.stroke();
        if (!d.p || !byPerson(d.p)) continue;
        // which key (and stick) picks it
        const key = this.keyLabel(SHOT_KEY[h.kh]);
        const label = hs.map((x) => (x.stick ? arrow(x.stick) : '') + key).join(' ') + (h.kc ? (h.kc > 0 ? ' ↻' : ' ↺') : '');
        g.lineWidth = 3 * dpr; g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.strokeText(label, X, Y - 9 * dpr); g.fillStyle = free ? '#fff' : 'rgba(255,255,255,0.8)'; g.fillText(label, X, Y - 9 * dpr);
      }
    }
    // the AI: role, and where a supporter is heading
    g.font = `600 ${Math.round(9 * dpr)}px system-ui, sans-serif`; g.textAlign = 'center';
    for (const q of w.players) {
      if (q.human && !q.bot) continue;
      if (q.ai === 2 && vis(q.aiX, q.aiY, 0)) path([[q.x, q.y, 0.05], [q.aiX, q.aiY, 0.05]], 'rgba(120,200,255,0.6)', 1);
      const tag = q.role === ROLE.GK ? 'gk' : ROLE_TAG[q.ai] || '';
      if (tag && vis(q.x, q.y, 0)) { const [X, Y] = P(q.x, q.y, 0); g.fillStyle = 'rgba(170,215,255,0.95)'; g.fillText(tag, X, Y + 12 * dpr); }
    }
    // what it's working with
    const lines = [`DEV · tick ${w.tick} · phase ${w.m.phase}`];
    if (d && d.p) {
      const top = d.best.reduce((a, h) => (!a || h.score > a.score ? h : a), null);
      lines.push(`#${d.p.id}${d.p.human ? '' : ' (AI)'}${d.fan ? ` · fan ${['ground', 'chest', 'head'][d.fan.kh]}: ${d.fan.rays.filter((x) => x.shut < 0).length}/${d.fan.rays.length} open` : ''}`);
      if (top) lines.push(`best hole ${['low', 'mid', 'top'][top.kh]} y ${top.ty.toFixed(1)}${top.kc ? (top.kc > 0 ? ' bent ↻' : ' bent ↺') + (top.kf === FOOT.OUTSIDE ? ' (outside of the foot)' : '') : ''} · margin ${top.m.toFixed(2)} s`);
      if (d.passes.length) lines.push('passes ' + d.passes.map((h) => `${Math.round(h.odds * 100)}%`).join(' '));
    }
    if (d && d.p && byPerson(d.p) && d.holes.length) lines.push(`shot keys: ${this.keyLabel('goalG')} low · ${this.keyLabel('goalM')} mid · ${this.keyLabel('goalH')} top · stick to a side: that half (↻ bent right, ↺ bent left)`);
    lines.push('⌘/Ctrl+Shift+D ×3: leave');
    g.font = `600 ${Math.round(11 * dpr)}px ui-monospace, Menlo, monospace`; g.textAlign = 'left';
    const lh = 14 * dpr, x0 = 10 * dpr, y0 = cam.h - (lines.length * lh) - 120 * dpr;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(x0 - 6 * dpr, y0 - lh, Math.max(...lines.map((l) => g.measureText(l).width)) + 12 * dpr, lines.length * lh + 8 * dpr);
    g.fillStyle = '#e8f6ec';
    lines.forEach((l, i) => g.fillText(l, x0, y0 + i * lh));
    g.restore();
  }
}
