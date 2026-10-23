// Sound: the soundtrack (menu and warm-up only – never during a match) and
// synthesized effects, through a small mixer:
//
//   master ─┬─ music      soundtrack, fades in/out
//           ├─ effects    ball, bodies, the referee's whistle
//           ├─ crowd      ambience (louder near the boxes), cheers, groans
//           └─ interface  buttons, quick chat, people joining
//
// Every channel has its own volume (saved per device). Browsers only allow
// sound after the first click / tap / key press: unlock() is called then.

const TRACKS = ['client/music/tokat-sarmasi-pentatonik.mp3', 'client/music/vokalli.mp3'];
export const CHANNELS = [['master', 'Master'], ['music', 'Music'], ['sfx', 'Effects'], ['crowd', 'Crowd'], ['ui', 'Interface']];
const DEFAULT_MIX = { master: 0.8, music: 0.55, sfx: 0.9, crowd: 0.7, ui: 0.6 };
const FADE = 1.6; // s, music fade in / out

function loadMix() {
  const mix = { ...DEFAULT_MIX };
  try {
    const saved = JSON.parse(localStorage.getItem('caput.mix') || 'null');
    if (saved) for (const [k] of CHANNELS) if (Number.isFinite(saved[k])) mix[k] = Math.min(1, Math.max(0, saved[k]));
  } catch { /* storage unavailable */ }
  return mix;
}

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try { this.muted = localStorage.getItem('caput.muted') === '1'; } catch { /* ignore */ }
    this.mix = loadMix();
    this.noiseBuf = null;
    this.musicWanted = false;
    this.track = 0;
    this.audio = null;
    this.excite = 0;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.musicWanted && this.audio && this.audio.paused) this.playTrack();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain();
    this.master.connect(c.destination);
    this.bus = {};
    for (const [k] of CHANNELS) if (k !== 'master') { this.bus[k] = c.createGain(); this.bus[k].connect(this.master); }
    this.fx = this.bus.sfx;
    this.applyMix();
    const len = c.sampleRate;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startCrowd();
    if (this.musicWanted) this.setMusic(true, true);
  }

  // ------------------------------------------------------------ mixer

  applyMix() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.mix.master, t, 0.03);
    // a gentle curve: half way on the slider is about a quarter of the power
    for (const k in this.bus) this.bus[k].gain.setTargetAtTime(this.mix[k] * this.mix[k] * 1.4, t, 0.03);
  }

  setVolume(channel, v) {
    this.mix[channel] = Math.min(1, Math.max(0, v));
    try { localStorage.setItem('caput.mix', JSON.stringify(this.mix)); } catch { /* ignore */ }
    this.applyMix();
  }

  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem('caput.muted', m ? '1' : '0'); } catch { /* ignore */ }
    this.applyMix();
  }

  // ------------------------------------------------------------ music

  // The soundtrack plays on the menu and in warm-up; it fades out for a match.
  setMusic(on, force = false) {
    if (on === this.musicWanted && !force) return;
    this.musicWanted = on;
    const c = this.ctx;
    if (!c) return; // starts on unlock()
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.id = 'music'; this.audio.hidden = true;
      document.body.append(this.audio);
      this.audio.addEventListener('ended', () => { this.track = (this.track + 1) % TRACKS.length; this.playTrack(true); });
      this.fade = c.createGain();
      this.fade.gain.value = 0;
      c.createMediaElementSource(this.audio).connect(this.fade);
      this.fade.connect(this.bus.music);
    }
    const t = c.currentTime, g = this.fade.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    clearTimeout(this.pauseTimer);
    if (on) {
      this.playTrack();
      g.linearRampToValueAtTime(1, t + FADE);
    } else {
      g.linearRampToValueAtTime(0, t + FADE);
      this.pauseTimer = setTimeout(() => { if (!this.musicWanted && this.audio) this.audio.pause(); }, FADE * 1000 + 100);
    }
  }

  playTrack(next = false) {
    const a = this.audio;
    if (!a) return;
    if (next || !a.src) a.src = TRACKS[this.track];
    const p = a.play();
    if (p && p.catch) p.catch(() => { /* not allowed yet: the next unlock() retries */ });
  }

  // ------------------------------------------------------------ building blocks

  noise(dur, freq, q, gain, type = 'bandpass', at = 0, bus = this.fx) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime + at;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.01, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(bus);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
    return f;
  }

  tone(f0, f1, dur, gain, type = 'sine', at = 0, bus = this.fx) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime + at;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // a filtered noise swell (crowd voices) on the crowd channel
  swell(peak, attack, hold, release, freq, q, at = 0, sweepTo = 0) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime + at;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.linearRampToValueAtTime(sweepTo, t + attack + hold + release);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    src.connect(f); f.connect(g); g.connect(this.bus.crowd);
    src.start(t); src.stop(t + attack + hold + release + 0.1);
  }

  // ------------------------------------------------------------ ball & bodies

  kick(power = 0.5, vol = 1) {
    const v = Math.min(1, 0.25 + power) * vol;
    this.tone(150, 45, 0.11, 0.55 * v);
    this.noise(0.04, 1800, 0.8, 0.25 * v);
  }
  head(vol = 1) {
    // a duller, rounder thump than a kick
    this.tone(210, 85, 0.1, 0.38 * vol);
    this.noise(0.035, 900, 0.9, 0.16 * vol);
  }
  bounce(vol = 1) { this.tone(110, 50, 0.08, 0.25 * vol); }
  post() { this.tone(900, 860, 0.35, 0.18, 'triangle'); this.tone(1350, 1300, 0.25, 0.08, 'triangle'); this.kick(0.6, 0.6); }
  tackle(vol = 1) { this.noise(0.12, 500, 0.7, 0.35 * vol); this.tone(90, 40, 0.12, 0.3 * vol); }
  block(vol = 1) { this.tone(120, 55, 0.12, 0.42 * vol); this.noise(0.07, 650, 0.8, 0.28 * vol); }
  slide(vol = 1) {
    // studs and grass: a scraping sweep
    const f = this.noise(0.42, 1400, 1.2, 0.22 * vol);
    if (f) f.frequency.exponentialRampToValueAtTime(380, this.ctx.currentTime + 0.4);
  }
  dive(vol = 1) {
    const f = this.noise(0.28, 700, 0.7, 0.12 * vol, 'bandpass');
    if (f) f.frequency.exponentialRampToValueAtTime(2200, this.ctx.currentTime + 0.25);
    this.tone(95, 45, 0.14, 0.32 * vol, 'sine', 0.3); // landing
    this.noise(0.1, 400, 0.8, 0.18 * vol, 'bandpass', 0.3);
  }
  catchBall() { this.noise(0.08, 900, 1, 0.35); this.tone(200, 120, 0.06, 0.2); }
  net() {
    // the ball rippling the net
    this.noise(0.65, 2600, 0.6, 0.2, 'bandpass', 0.02);
    this.noise(0.4, 5200, 1.5, 0.08, 'bandpass', 0.05);
    this.tone(70, 40, 0.18, 0.25, 'sine', 0.02);
  }

  whistle(n = 1) {
    const c = this.ctx; if (!c) return;
    for (let i = 0; i < n; i++) {
      const long = n === 3 && i === 2;
      const at = i * 0.32;
      const dur = long ? 0.75 : 0.22;
      const t = c.currentTime + at;
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = 2900;
      const lfo = c.createOscillator(); lfo.frequency.value = 38;
      const lg = c.createGain(); lg.gain.value = 120;
      lfo.connect(lg); lg.connect(o.frequency);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.13, t + 0.02);
      g.gain.setValueAtTime(0.13, t + dur - 0.04); g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g); g.connect(this.fx);
      o.start(t); lfo.start(t); o.stop(t + dur + 0.02); lfo.stop(t + dur + 0.02);
    }
  }

  // ------------------------------------------------------------ crowd

  cheer(intensity = 1) { this.swell(0.32 * intensity, 0.35, 1.05, 1.8, 1100, 0.6); }
  roar() {
    // a goal: the stand erupts, then a long cheer
    this.swell(0.42, 0.18, 1.6, 2.6, 1000, 0.5);
    this.swell(0.22, 0.25, 1.4, 2.4, 2300, 0.9);
  }
  oooh() { this.swell(0.18, 0.25, 0, 1.15, 500, 2, 0, 300); }
  groan() { this.swell(0.13, 0.2, 0.2, 0.9, 380, 1.6, 0, 240); }
  boo() {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 260; f.Q.value = 3;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.15, t + 0.3);
    g.gain.setValueAtTime(0.15, t + 0.9); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    // wobble, like many voices
    const lfo = c.createOscillator(); lfo.frequency.value = 5;
    const lg = c.createGain(); lg.gain.value = 40;
    lfo.connect(lg); lg.connect(f.frequency);
    src.connect(f); f.connect(g); g.connect(this.bus.crowd);
    src.start(t); lfo.start(t); src.stop(t + 1.9); lfo.stop(t + 1.9);
  }

  startCrowd() {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 650;
    const g = c.createGain(); g.gain.value = 0.035;
    src.connect(f); f.connect(g); g.connect(this.bus.crowd);
    src.start();
    this.crowd = g; this.crowdF = f;
  }

  // Ambience follows the game: 0 = quiet (midfield), 1 = the ball in a box;
  // no stadium at all on the menu.
  setExcitement(x, present = true) {
    if (!this.ctx || !this.crowd) return;
    this.excite += (x - this.excite) * 0.1;
    const t = this.ctx.currentTime;
    this.crowd.gain.setTargetAtTime(present ? 0.02 + 0.07 * this.excite : 0, t, present ? 0.4 : 0.8);
    this.crowdF.frequency.setTargetAtTime(550 + 700 * this.excite, t, 0.4);
  }

  // ------------------------------------------------------------ interface

  click() { this.tone(1500, 1100, 0.035, 0.08, 'triangle', 0, this.bus.ui); }
  chat() { this.tone(880, 880, 0.07, 0.09, 'sine', 0, this.bus.ui); this.tone(1320, 1320, 0.09, 0.08, 'sine', 0.07, this.bus.ui); }
  joined() { this.tone(660, 660, 0.09, 0.08, 'sine', 0, this.bus.ui); this.tone(990, 990, 0.12, 0.08, 'sine', 0.08, this.bus.ui); }
  left() { this.tone(740, 740, 0.09, 0.07, 'sine', 0, this.bus.ui); this.tone(494, 494, 0.14, 0.07, 'sine', 0.08, this.bus.ui); }
}
