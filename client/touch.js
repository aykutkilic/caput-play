// On-screen controls for phones and tablets.
//
//  * Left half: a floating stick – put a thumb down anywhere and drag.
//    Pushing it all the way to the rim also sprints.
//  * Right side: eight round buttons, as arcade buttons, laid out as the
//    keyboard's – Q W E R over A S D F: Through, Knock on, Control, Trick /
//    Lob, Pass, Shoot, Lift – each its key's kick at its key's height; slide
//    the finger up on one for a level higher (further up, two), down for a
//    level lower (the keyboard's X / Z); HOW LONG you hold sets the power.
//    Above them Sprint (R1) and R2.
// Everything is multi-touch. The state is written into `input.touch` once per event.

import { BTN, KT, KH, packKick } from '../shared/constants.js';

// The eight buttons, as the keyboard's keys (see input.js KICK_KEYS)
const BUTTONS = [
  { key: 'Q', t: KT.RUN, h: KH.GROUND, cls: 'run' }, { key: 'W', t: KT.SELF, h: KH.GROUND, cls: 'self' },
  { key: 'E', t: KT.CTRL, h: KH.GROUND, cls: 'ctrl' }, { key: 'R', t: KT.TRICK, h: KH.GROUND, cls: 'trick' },
  { key: 'A', t: KT.MATE, h: KH.MID, cls: 'mate' }, { key: 'S', t: KT.MATE, h: KH.GROUND, cls: 'mate' },
  { key: 'D', t: KT.GOAL, h: KH.MID, cls: 'goal' }, { key: 'F', t: KT.SELF, h: KH.HIGH, cls: 'self' },
];
// The same keys defend: the buttons say what they do right now (null: nothing
// special – shown dimmed with its attacking name)
export const BUTTON_LABELS = {
  attack: ['Through', 'Knock on', 'Control', 'Trick', 'Lob', 'Pass', 'Shoot', 'Lift'],
  defend: ['GK out', 'Jockey', null, null, 'Press', 'Press', 'Slide', 'Jockey'],
  keeper: ['Rush out', 'Block', 'Catch', null, 'Press', 'Press', 'Dive', 'Block'],
  keeperAir: [null, null, 'Catch', null, null, null, 'Punch', null],
  keeperCatch: ['Dive', 'Dive', 'Catch', null, 'Dive', 'Dive', 'Dive', 'Dive'],
  block: ['Block', 'Block', null, null, 'Block', 'Block', 'Block', 'Block'],
};

const SHOULDER = [
  { bit: BTN.R2, glyph: 'R2', hint: 'Control', cls: 'small' },
  { bit: BTN.SPRINT, glyph: 'R1', hint: 'Get ball', cls: '' },
];

export class TouchControls {
  constructor(input, onFirstTouch) {
    this.input = input;
    this.onFirstTouch = onFirstTouch;
    this.held = new Map();    // pointerId -> shoulder button (SHOULDER entry)
    this.kick = null;         // { id, t, h0, h, y0, el } – the button being held
    this.stick = null;        // { id, x0, y0 }
    this.sx = 0; this.sy = 0; this.mag = 0; this.rim = false;
    const root = document.createElement('div');
    root.id = 'touch';
    root.hidden = true;
    root.innerHTML = `
      <div class="tzone"></div>
      <div class="tstick" hidden><div class="tknob"></div></div>
      <div class="tshoulder">${SHOULDER.map((b, i) => `<button class="tb ${b.cls}" data-i="${i}"><b>${b.glyph}</b><i>${b.hint}</i></button>`).join('')}</div>
      <div class="tpad">${BUTTONS.map((b, i) => `<button class="tk ${b.cls}" data-k="${i}"><u>${b.key}</u><b>${BUTTON_LABELS.attack[i]}</b></button>`).join('')}</div>`;
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

    for (const el of root.querySelectorAll('.tk')) {
      const def = BUTTONS[Number(el.dataset.k)];
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.first();
        if (this.kick) this.endKick();       // a second button replaces the first
        el.setPointerCapture(e.pointerId);
        this.kick = { id: e.pointerId, t: def.t, h0: def.h, h: def.h, y0: e.clientY, el };
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
    if (mode === this.mode || !BUTTON_LABELS[mode]) return;
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.root.querySelectorAll('.tk').forEach((el, i) => {
      const label = BUTTON_LABELS[mode][i];
      el.querySelector('b').textContent = label || BUTTON_LABELS.attack[i];
      el.classList.toggle('dim', !label);
    });
  }

  // the finger slid up from where it went down: a level higher (further up,
  // two), down: a level lower – the keyboard's X / Z (not for the control
  // and trick buttons)
  setHeight(e) {
    const k = this.kick, dy = e.clientY - k.y0, R = k.el.offsetWidth || 60;
    const lvl = dy < -0.75 * R ? 2 : dy < -0.28 * R ? 1 : dy > 0.28 * R ? -1 : 0;
    const fixed = k.t === KT.CTRL || k.t === KT.TRICK;
    k.h = fixed ? k.h0 : Math.max(KH.GROUND, Math.min(KH.HIGH, k.h0 + lvl));
    k.el.dataset.lv = fixed || k.h === k.h0 ? '' : k.h > k.h0 ? (k.h - k.h0 > 1 ? 'up2' : 'up') : 'down';
    k.el.classList.add('on');
    this.write();
  }

  endKick() {
    this.kick.el.classList.remove('on');
    delete this.kick.el.dataset.lv;
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
    let b = 0;
    for (const d of this.held.values()) b |= d.bit;
    if (this.kick) b |= packKick(this.kick.t, this.kick.h);
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
