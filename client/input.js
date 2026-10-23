// Keyboard + gamepad + touch input.
//
// Every kick is a TARGET (team-mate, his running path, the goal, yourself) and a
// HEIGHT (feet, chest, head); how long the key is held sets the power.
//
// Keyboard default – a 4 x 3 grid, one column per target, one row per height:
//              run path   team-mate   goal   self
//   high         Q           W         E      R      (head / top corner)
//   ground       A           S         D      F      (to feet / low)
//   mid          Z           X         C      V      (chest / mid-height)
//   Arrows move, Shift = R1 sprint / knock-on dribble, Space = R2 precision dribble / finesse.
// Pad (standard mapping): ✕/A team-mate, △/Y run path, □/X goal, ○/B self;
//   hold L1 for high, L2 for mid (neither = ground); R1 sprint, R2 precision.
// Touch (phones/tablets): see touch.js – it feeds `input.touch`.

import { BTN, KT, KH, KICK_MASK, packKick } from '../shared/constants.js';

const KICK_BITS = KICK_MASK | (3 << 3); // target + height

// kick actions: binding name -> [target, height]
export const KICK_KEYS = {
  runH: [KT.RUN, KH.HIGH], mateH: [KT.MATE, KH.HIGH], goalH: [KT.GOAL, KH.HIGH], selfH: [KT.SELF, KH.HIGH],
  runG: [KT.RUN, KH.GROUND], mateG: [KT.MATE, KH.GROUND], goalG: [KT.GOAL, KH.GROUND], selfG: [KT.SELF, KH.GROUND],
  runM: [KT.RUN, KH.MID], mateM: [KT.MATE, KH.MID], goalM: [KT.GOAL, KH.MID], selfM: [KT.SELF, KH.MID],
};

export const DEFAULT_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  sprint: 'ShiftLeft', r2: 'Space',
  runH: 'KeyQ', mateH: 'KeyW', goalH: 'KeyE', selfH: 'KeyR',
  runG: 'KeyA', mateG: 'KeyS', goalG: 'KeyD', selfG: 'KeyF',
  runM: 'KeyZ', mateM: 'KeyX', goalM: 'KeyC', selfM: 'KeyV',
};

// v4 replaced the button layout with the target x height grid: of an older
// saved layout only custom movement / sprint / R2 keys survive.
const KEYS_VERSION = 4;
const KEPT = ['up', 'down', 'left', 'right', 'sprint', 'r2'];

export const ACTION_LABELS = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  sprint: 'R1 Get the ball – run to it, or close down whoever has it', r2: 'R2 Precision dribble / finesse / shield',
};

function loadKeys() {
  const keys = { ...DEFAULT_KEYS };
  try {
    let saved = JSON.parse(localStorage.getItem('caput.keys') || 'null');
    const ver = Number(localStorage.getItem('caput.keys.ver')) || (localStorage.getItem('caput.keys.v2') ? 2 : 1);
    if (saved && ver < KEYS_VERSION) {
      for (const k of Object.keys(saved)) if (!KEPT.includes(k) || DEFAULT_KEYS[k] === saved[k]) delete saved[k];
      // a kept custom key that now collides with a new default: start clean
      const merged = Object.values({ ...DEFAULT_KEYS, ...saved });
      if (new Set(merged).size !== merged.length) saved = {};
      // persist the migration, or the old layout would come back on the next load
      if (Object.keys(saved).length) localStorage.setItem('caput.keys', JSON.stringify(saved));
      else { localStorage.removeItem('caput.keys'); saved = null; }
    }
    if (saved) for (const k of Object.keys(DEFAULT_KEYS)) if (typeof saved[k] === 'string') keys[k] = saved[k];
    localStorage.setItem('caput.keys.ver', String(KEYS_VERSION));
  } catch { /* storage unavailable */ }
  return keys;
}

const PAD_TARGETS = [[0, KT.MATE], [1, KT.SELF], [2, KT.GOAL], [3, KT.RUN]];

export class Input {
  constructor() {
    this.down = new Set();
    this.keys = loadKeys();
    this.touch = { x: 0, y: 0, mag: 0, b: 0 }; // written by the on-screen touch controls
    this.order = [];   // kick keys / pad buttons in the order they went down: the latest one counts
    this.padDown = new Set();
    this.enabled = true;
    this.padIndex = -1;
    this.lastDevice = 'keyboard';
    addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      if (this.isBound(e.code)) {
        e.preventDefault();
        // game keys must never drive a focused button, select or slider
        const a = document.activeElement;
        if (a && a !== document.body && /^(BUTTON|SELECT|INPUT)$/.test(a.tagName)) a.blur();
      }
      if (!this.down.has(e.code)) { this.order = this.order.filter((c) => c !== e.code); this.order.push(e.code); }
      this.down.add(e.code);
      this.lastDevice = 'keyboard';
    });
    addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.order = this.order.filter((c) => c !== e.code);
      if (!isTyping(e) && this.isBound(e.code)) e.preventDefault();
    });
    addEventListener('blur', () => { this.down.clear(); this.order = []; });
    addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; });
  }

  isBound(code) { return Object.values(this.keys).includes(code); }

  saveKeys() {
    try {
      localStorage.setItem('caput.keys', JSON.stringify(this.keys));
      localStorage.setItem('caput.keys.ver', String(KEYS_VERSION));
    } catch { /* ignore */ }
  }

  clear() { this.down.clear(); this.order = []; this.touch.b = 0; this.touch.mag = 0; }

  // the most recently pressed kick key still held -> packed target | height
  keyKick() {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const code = this.order[i];
      if (!this.down.has(code)) continue;
      for (const [name, [t, h]] of Object.entries(KICK_KEYS)) if (this.keys[name] === code) return packKick(t, h);
    }
    return 0;
  }

  // Returns screen-space stick (x right, y down), magnitude 0..1 and button bits.
  sample() {
    let x = 0, y = 0, b = 0;
    if (this.enabled) {
      const k = this.keys, d = this.down;
      if (d.has(k.left)) x -= 1;
      if (d.has(k.right)) x += 1;
      if (d.has(k.up)) y -= 1;
      if (d.has(k.down)) y += 1;
      if (d.has(k.sprint) || (k.sprint === 'ShiftLeft' && d.has('ShiftRight'))) b |= BTN.SPRINT;
      if (d.has(k.r2)) b |= BTN.R2;
      b |= this.keyKick();
    }
    let mag = x || y ? 1 : 0;
    const pad = this.pad();
    if (pad && this.enabled) {
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      const am = Math.hypot(ax, ay);
      const bt = (i) => pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.35);
      let px = 0, py = 0, pm = 0;
      if (am > 0.22) { px = ax / am; py = ay / am; pm = Math.min(1, (am - 0.22) / 0.7); }
      if (bt(12)) py -= 1; if (bt(13)) py += 1; if (bt(14)) px -= 1; if (bt(15)) px += 1;
      if (!pm && (px || py)) { const n = Math.hypot(px, py); px /= n; py /= n; pm = 1; }
      let pb = 0;
      for (const [i, t] of PAD_TARGETS) {
        if (bt(i)) { if (!this.padDown.has(t)) { this.padDown.add(t); this.order.push(`pad${t}`); } }
        else if (this.padDown.delete(t)) this.order = this.order.filter((c) => c !== `pad${t}`);
      }
      for (let i = this.order.length - 1; i >= 0; i--) {
        const c = this.order[i];
        if (!c.startsWith('pad')) continue;
        pb = packKick(Number(c.slice(3)), bt(4) ? KH.HIGH : bt(6) ? KH.MID : KH.GROUND);
        break;
      }
      if (bt(5)) pb |= BTN.SPRINT;
      if (bt(7)) pb |= BTN.R2;
      if (pm || pb) this.lastDevice = 'gamepad';
      if (pm) { x = px; y = py; mag = pm; }
      // a pad kick overrides a keyboard one (two kicks can't be packed together)
      if (pb & KICK_MASK) b &= ~KICK_BITS;
      b |= pb;
    }
    const t = this.touch;
    if (this.enabled && (t.mag > 0 || t.b)) {
      if (t.mag > 0) { x = t.x; y = t.y; mag = t.mag; }
      if (t.b & KICK_MASK) b &= ~KICK_BITS;
      b |= t.b;
      this.lastDevice = 'touch';
    }
    if (x || y) { const n = Math.hypot(x, y); x /= n; y /= n; }
    return { x, y, mag, b };
  }

  pad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.padIndex >= 0 && pads[this.padIndex]) return pads[this.padIndex];
    for (const p of pads) if (p && p.connected) { this.padIndex = p.index; return p; }
    return null;
  }
}

const TEXT_INPUTS = new Set(['text', 'number', 'search', 'email', 'password', 'url', 'tel']);
export function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  if (t.tagName === 'INPUT') return TEXT_INPUTS.has(t.type);
  return t.tagName === 'TEXTAREA' || t.isContentEditable;
}

const KEY_NAMES = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space',
  ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'Alt', AltRight: 'R-Alt',
};
export function keyName(code) {
  if (!code) return '-';
  return KEY_NAMES[code] || code.replace(/^Key|^Digit/, '');
}
