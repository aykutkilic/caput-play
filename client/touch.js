// On-screen controls for phones and tablets.
//
//  * Left half: a floating stick – put a thumb down anywhere and drag.
//    Pushing it all the way to the rim also sprints.
//  * Right side: four tall kick bars – Run (into a team-mate's path), Mate (to
//    his feet / head), Goal and Self. WHERE on a bar you press sets the height
//    (top = head / top corner, middle = chest, bottom = feet / low; slide the
//    finger to change it), HOW LONG you hold sets the power. Above them Sprint
//    (R1), R2 and Trick (the trick key – R on a keyboard, R3 on a pad).
// Everything is multi-touch. The state is written into `input.touch` once per event.

import { BTN, KT, KH, packKick } from '../shared/constants.js';

const BARS = [
  { t: KT.RUN, glyph: 'Run', hint: 'through', cls: 'run' },
  { t: KT.MATE, glyph: 'Pass', hint: 'team-mate', cls: 'mate' },
  { t: KT.GOAL, glyph: 'Shoot', hint: 'goal', cls: 'goal' },
  { t: KT.SELF, glyph: 'Self', hint: 'lift / skill', cls: 'self' },
];
// The same keys defend: the bars say what they do right now. (A ball coming
// at the keeper: the Catch bars are the catch key – see the sim's catchKey.)
const CATCH_MODES = new Set(['keeperAir', 'keeperCatch']);
export const BAR_LABELS = {
  attack: [['Run', 'through'], ['Pass', 'team-mate'], ['Shoot', 'goal'], ['Self', 'lift / skill']],
  defend: [['GK out', 'send keeper'], ['Press', 'hold'], ['Slide', 'tackle'], ['Jockey', 'hold']],
  keeper: [['Rush', 'come out'], ['Press', 'hold'], ['Dive', 'save'], ['Block', '1v1']],
  keeperAir: [['Catch', 'hold'], ['Catch', 'hold'], ['Punch', 'clear'], ['Catch', 'hold']],
  keeperCatch: [['Catch', 'hold'], ['Catch', 'hold'], ['Dive', 'save'], ['Catch', 'hold']],
  block: [['Block', 'leg / body'], ['Block', 'leg / body'], ['Block', 'leg / body'], ['Block', 'leg / body']],
};

const SHOULDER = [
  { kick: KT.TRICK, glyph: '✦', hint: 'Trick', cls: 'small' },
  { bit: BTN.R2, glyph: 'R2', hint: 'Control', cls: 'small' },
  { bit: BTN.SPRINT, glyph: 'R1', hint: 'Get ball', cls: '' },
];

export class TouchControls {
  constructor(input, onFirstTouch) {
    this.input = input;
    this.onFirstTouch = onFirstTouch;
    this.held = new Map();    // pointerId -> shoulder button (SHOULDER entry)
    this.kick = null;         // { id, t, h, el } – the kick bar being held
    this.stick = null;        // { id, x0, y0 }
    this.sx = 0; this.sy = 0; this.mag = 0; this.rim = false;
    const root = document.createElement('div');
    root.id = 'touch';
    root.hidden = true;
    root.innerHTML = `
      <div class="tzone"></div>
      <div class="tstick" hidden><div class="tknob"></div></div>
      <div class="tshoulder">${SHOULDER.map((b, i) => `<button class="tb ${b.cls}" data-i="${i}"><b>${b.glyph}</b><i>${b.hint}</i></button>`).join('')}</div>
      <div class="tbars">${BARS.map((b, i) => `<button class="tbar ${b.cls}" data-k="${i}"><span class="lv h">head</span><span class="lv m">chest</span><span class="lv g">feet</span><b>${b.glyph}</b><i>${b.hint}</i></button>`).join('')}</div>`;
    this.mode = 'attack';
    document.getElementById('hud').before(root); // under the HUD, so its buttons stay tappable
    this.root = root;
    this.zone = root.querySelector('.tzone');
    this.stickEl = root.querySelector('.tstick');
    this.knob = root.querySelector('.tknob');

    for (const el of root.querySelectorAll('.tb')) {
      const def = SHOULDER[Number(el.dataset.i)];
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.first();
        el.setPointerCapture(e.pointerId);
        this.held.set(e.pointerId, def);
        el.classList.add('on');
        this.write();
      });
      const up = (e) => {
        if (!this.held.has(e.pointerId)) return;
        this.held.delete(e.pointerId);
        if (![...this.held.values()].includes(def)) el.classList.remove('on');
        this.write();
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    for (const el of root.querySelectorAll('.tbar')) {
      const def = BARS[Number(el.dataset.k)];
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.first();
        if (this.kick) this.endKick();       // a second bar replaces the first
        el.setPointerCapture(e.pointerId);
        this.kick = { id: e.pointerId, t: def.t, h: KH.GROUND, el };
        this.setHeight(e);
      });
      el.addEventListener('pointermove', (e) => { if (this.kick && this.kick.id === e.pointerId) this.setHeight(e); });
      const up = (e) => { if (this.kick && this.kick.id === e.pointerId) this.endKick(); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    this.zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.first();
      if (this.stick) return;
      this.zone.setPointerCapture(e.pointerId);
      this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
      this.stickEl.style.left = `${e.clientX}px`;
      this.stickEl.style.top = `${e.clientY}px`;
      this.stickEl.hidden = false;
      this.moveStick(e);
    });
    this.zone.addEventListener('pointermove', (e) => { if (this.stick && e.pointerId === this.stick.id) this.moveStick(e); });
    const release = (e) => {
      if (!this.stick || e.pointerId !== this.stick.id) return;
      this.stick = null;
      this.stickEl.hidden = true;
      this.sx = this.sy = this.mag = 0; this.rim = false;
      this.knob.style.transform = 'translate(-50%, -50%)';
      this.write();
    };
    this.zone.addEventListener('pointerup', release);
    this.zone.addEventListener('pointercancel', release);
  }

  radius() { return this.stickEl.offsetWidth / 2 || 55; }

  // 'attack' | 'defend' | 'keeper' | 'keeperAir' | 'keeperCatch' | 'block'
  setMode(mode) {
    if (mode === this.mode || !BAR_LABELS[mode]) return;
    this.mode = mode;
    if (this.kick) this.write(); // (a bar held on: what it presses now)
    this.root.dataset.mode = mode;
    this.root.querySelectorAll('.tbar').forEach((el, i) => {
      const [glyph, hint] = BAR_LABELS[mode][i];
      el.querySelector('b').textContent = glyph;
      el.querySelector('i').textContent = hint;
    });
  }

  // top third of a bar = high, middle = mid, bottom = ground
  setHeight(e) {
    const k = this.kick, r = k.el.getBoundingClientRect();
    const u = (e.clientY - r.top) / Math.max(1, r.height);
    k.h = u < 1 / 3 ? KH.HIGH : u < 2 / 3 ? KH.MID : KH.GROUND;
    k.el.dataset.h = k.h;
    k.el.classList.add('on');
    this.write();
  }

  endKick() {
    this.kick.el.classList.remove('on');
    delete this.kick.el.dataset.h;
    this.kick = null;
    this.write();
  }

  moveStick(e) {
    const R = this.radius();
    let dx = e.clientX - this.stick.x0, dy = e.clientY - this.stick.y0;
    const d = Math.hypot(dx, dy);
    // drag far enough and the base follows the thumb, so direction changes stay quick
    if (d > R * 1.35) {
      const k = (d - R * 1.35) / d;
      this.stick.x0 += dx * k; this.stick.y0 += dy * k;
      this.stickEl.style.left = `${this.stick.x0}px`; this.stickEl.style.top = `${this.stick.y0}px`;
      dx = e.clientX - this.stick.x0; dy = e.clientY - this.stick.y0;
    }
    const dd = Math.hypot(dx, dy);
    const dead = R * 0.12;
    this.mag = dd < dead ? 0 : Math.min(1, (dd - dead) / (R * 0.8));
    this.sx = dd > 0 ? dx / dd : 0; this.sy = dd > 0 ? dy / dd : 0;
    this.rim = dd > R * 0.95;
    const kd = Math.min(dd, R);
    this.knob.style.transform = `translate(calc(-50% + ${this.sx * kd}px), calc(-50% + ${this.sy * kd}px))`;
    this.write();
  }

  write() {
    let b = 0, trick = false;
    for (const d of this.held.values()) { if (d.kick) trick = true; else b |= d.bit; }
    // (the trick button over a kick bar: two kicks can't be packed together)
    if (trick) b |= packKick(KT.TRICK, KH.GROUND);
    else if (this.kick) b |= packKick(CATCH_MODES.has(this.mode) && this.kick.t !== KT.GOAL ? KT.CTRL : this.kick.t, this.kick.h);
    const t = this.input.touch;
    t.x = this.sx; t.y = this.sy; t.mag = this.mag; t.b = b;
  }

  first() {
    if (this.onFirstTouch) { const f = this.onFirstTouch; this.onFirstTouch = null; f(); }
  }

  setVisible(on) {
    this.root.hidden = !on;
    document.body.classList.toggle('touchui', on);
    if (!on) {
      this.held.clear(); this.stick = null; this.sx = this.sy = this.mag = 0;
      if (this.kick) this.endKick(); else this.write();
    }
  }
}

// The game is a full-screen app: pinching across two controls (stick + a
// button), or double-tapping, must never zoom the page. Android honours the
// viewport's user-scalable=no; iOS Safari ignores it, so block its gesture
// events, any multi-finger move and the second tap of a quick double tap.
export function lockZoom() {
  const block = (e) => { if (e.cancelable) e.preventDefault(); };
  for (const k of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(k, block, { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) block(e); }, { passive: false });
  let lastEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = e.timeStamp;
    // buttons and fields already opt out of double-tap zoom and need their clicks
    const ui = e.target.closest && e.target.closest('button, a, label, input, textarea, select, [contenteditable]');
    if (now - lastEnd < 350 && e.touches.length === 0 && !ui) block(e);
    lastEnd = now;
  }, { passive: false });
  document.addEventListener('dblclick', block, { passive: false });
}

export function isTouchDevice() {
  return (window.matchMedia && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
}
