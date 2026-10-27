// Keyboard + gamepad + touch input.
//
// Every kick is a TARGET (team-mate, his running path, the goal, yourself) and a
// HEIGHT (feet, chest, head); how long the key is held sets the power.
//
// Keyboard default – a key per action:
//   Q through pass (run path, along the grass) – with Shift a high through pass
//   A lob pass (team-mate, lofted)        S ground pass (team-mate, to feet)
//   D shoot – or head / volley it, when it's in the air – with Shift high (the top corner)
//   W knock it into your own run (self, along the grass)   F lift it (self, high)
//   E control it – a ball coming taken dead on the chest, thigh or foot
//   R a trick – elastico / la croqueta / back-heel flick / rainbow flick at
//     your feet, a sombrero on a ball dropping, around the world / neck stall
//     while juggling (timed – see beginTrick in the sim); Space (R2) with a
//     pass key: a no-look pass
//   X / Z held with a kick key: a level higher / lower (feet – chest – head):
//     D + Z a low shot, D + X the top corner, A + X to his head, W + X / F + Z
//     the ball popped up chest-high to yourself
//   Arrows move, Shift = R1 sprint / knock-on dribble, Space = R2 precision dribble / finesse.
// Pad (standard mapping): ✕/A team-mate, △/Y run path, □/X goal, ○/B self;
//   hold L1 for high, L2 for mid (neither = ground); R1 sprint, R2 precision.
// Touch (phones/tablets): see touch.js – it feeds `input.touch`.

import { BTN, KT, KH, KICK_MASK, packKick, JOG_TILT } from '../shared/constants.js';

const KICK_BITS = KICK_MASK | (3 << 3); // target + height

// kick actions: binding name -> [target, height] (through, shoot: high with Shift held)
const SHIFT_HIGH = new Set(['through', 'shoot']);
export const KICK_KEYS = {
  through: [KT.RUN, KH.GROUND], lob: [KT.MATE, KH.MID], pass: [KT.MATE, KH.GROUND], shoot: [KT.GOAL, KH.MID],
  knock: [KT.SELF, KH.GROUND], control: [KT.CTRL, KH.GROUND], lift: [KT.SELF, KH.HIGH], trick: [KT.TRICK, KH.GROUND],
};
// what they do, for the controls dialog
export const KICK_LABELS = {
  through: 'Through pass – into his run (with Shift: a high through pass)', lob: 'Lob pass – lofted to a team-mate',
  pass: 'Ground pass – to a team-mate\'s feet', shoot: 'Shoot – or head / volley it in the air (with Shift: high, the top corner)',
  knock: 'Knock it into your own run (self pass)', control: 'Control it – chest, thigh, foot or head, taken dead · keeper: hold it to catch (R2 does too)', lift: 'Lift the ball – flick it up; again as it drops: keepy-ups',
  trick: 'Trick – at your feet: elastico (stick to a side), la croqueta (diagonally ahead), back-heel flick (back), rainbow flick (forward / none); a ball dropping, the stick pushed: sombrero; juggling: around the world (dropping to your foot), neck stall (dropping to your head) – timed',
};
// the bindings that press a target + height (the AI's keys, as yours are
// named): [the modifier held with it, or null; the kick key]
export function kickKeys(target, height) {
  const up = (key, base) => [height > base ? 'higher' : height < base ? 'lower' : null, key];
  if (target === KT.RUN) return height === KH.HIGH ? ['sprint', 'through'] : up('through', KH.GROUND);
  if (target === KT.MATE) return height === KH.GROUND ? [null, 'pass'] : up('lob', KH.MID);
  if (target === KT.GOAL) return height === KH.HIGH ? ['sprint', 'shoot'] : up('shoot', KH.MID);
  if (target === KT.CTRL) return [null, 'control'];
  if (target === KT.TRICK) return [null, 'trick'];
  return height === KH.HIGH ? [null, 'lift'] : up('knock', KH.GROUND);
}

export const DEFAULT_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  sprint: 'ShiftLeft', r2: 'Space', jog: 'KeyG',
  through: 'KeyQ', lob: 'KeyA', pass: 'KeyS', shoot: 'KeyD', knock: 'KeyW', control: 'KeyE', lift: 'KeyF', trick: 'KeyR',
  higher: 'KeyX', lower: 'KeyZ',
};

// v5 replaced the target x height grid with a key per action: of an older
// saved layout only custom movement / sprint / R2 / jog keys survive. v6 added
// the height keys (higher / lower): one a saved layout already uses starts unbound.
const KEYS_VERSION = 6;
const ADDED_V6 = ['higher', 'lower'];
const KEPT = ['up', 'down', 'left', 'right', 'sprint', 'r2', 'jog'];

export const ACTION_LABELS = {
  higher: 'A level higher (hold with a kick key) – Shoot: the top corner · Lob: to his head · Knock: popped up chest-high to yourself · Through: chest-high',
  lower: 'A level lower (hold with a kick key) – Shoot: a low one, along the grass · Lift: popped up chest-high to yourself · Lob: along the grass',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  sprint: 'R1 Get the ball – run to it, or close down whoever has it', jog: 'Jog (hold) – run at a jog instead of flat out (saves stamina)', r2: 'R2 Precision dribble / finesse / shield · with a pass key: a no-look pass · defending: guard (face the ball)',
};

function loadKeys() {
  const keys = { ...DEFAULT_KEYS };
  try {
    let saved = JSON.parse(localStorage.getItem('caput.keys') || 'null');
    const ver = Number(localStorage.getItem('caput.keys.ver')) || (localStorage.getItem('caput.keys.v2') ? 2 : 1);
    if (saved && ver < 5) {
      for (const k of Object.keys(saved)) if (!KEPT.includes(k) || DEFAULT_KEYS[k] === saved[k]) delete saved[k];
      // a kept custom key that now collides with a new default: start clean
      const merged = Object.values({ ...DEFAULT_KEYS, ...saved });
      if (new Set(merged).size !== merged.length) saved = {};
      // persist the migration, or the old layout would come back on the next load
      if (Object.keys(saved).length) localStorage.setItem('caput.keys', JSON.stringify(saved));
      else { localStorage.removeItem('caput.keys'); saved = null; }
    }
    if (saved) for (const k of Object.keys(DEFAULT_KEYS)) if (typeof saved[k] === 'string') keys[k] = saved[k];
    if (saved && ver < 6) {
      let changed = false;
      for (const k of ADDED_V6) {
        if (typeof saved[k] === 'string' || !Object.entries(keys).some(([n, c]) => n !== k && c === keys[k])) continue;
        keys[k] = saved[k] = ''; changed = true;
      }
      if (changed) localStorage.setItem('caput.keys', JSON.stringify(saved));
    }
    localStorage.setItem('caput.keys.ver', String(KEYS_VERSION));
  } catch { /* storage unavailable */ }
  return keys;
}

// (L3 / R3, the stick clicks: control, a trick)
const PAD_TARGETS = [[0, KT.MATE], [1, KT.SELF], [2, KT.GOAL], [3, KT.RUN], [10, KT.CTRL], [11, KT.TRICK]];

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
      // (with Cmd / Ctrl held it's a shortcut – the browser's, or developer mode – not a game key)
      if ((e.metaKey || e.ctrlKey) && !/^(Shift|Control|Meta|Alt)/.test(e.code)) return;
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
  // (the through pass and the shot high with Shift held; a level up or down
  // with the higher / lower key held)
  keyKick() {
    const d = this.down, shift = d.has(this.keys.sprint) || d.has('ShiftLeft') || d.has('ShiftRight');
    const lvl = (this.keys.higher && d.has(this.keys.higher) ? 1 : 0) - (this.keys.lower && d.has(this.keys.lower) ? 1 : 0);
    for (let i = this.order.length - 1; i >= 0; i--) {
      const code = this.order[i];
      if (!d.has(code)) continue;
      for (const [name, [t, h]] of Object.entries(KICK_KEYS)) {
        if (this.keys[name] !== code) continue;
        const h0 = SHIFT_HIGH.has(name) && shift ? KH.HIGH : h;
        return packKick(t, t === KT.CTRL || t === KT.TRICK ? h0 : Math.max(KH.GROUND, Math.min(KH.HIGH, h0 + lvl)));
      }
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
    // (a keyboard direction is full tilt – a sprint – unless the jog key is
    // held: a gamepad's or the touch stick's tilt sets the pace itself)
    let mag = x || y ? (this.enabled && this.down.has(this.keys.jog) ? JOG_TILT : 1) : 0;
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
