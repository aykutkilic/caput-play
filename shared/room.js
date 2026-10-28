// A room: one authoritative world, the people in it and their AI helpers.
// Runs either inside the Node server or inside the browser of the player who
// hosts a serverless (peer-to-peer) room; it only talks to `client` objects
// that expose sendText(string) and sendBinary(bytes).
//
// Netcode (authority side):
//  * fixed 60 Hz simulation, snapshots at 30 Hz carrying the full state
//  * clients run *ahead* of the server and send inputs stamped with the tick they
//    are meant for (+ the previous 7 ticks for loss resilience). The server keeps a
//    small per-player jitter buffer keyed by tick and consumes exactly the input
//    for the tick it is simulating; a missing input repeats the last one.
//  * every snapshot tells each client how many ticks early its inputs arrive
//    ("lead"); the client speeds up/slows down its clock to keep that lead small
//    but positive, i.e. minimal added latency with no dropped inputs.
//  * the server re-quantises its own state after each snapshot so clients
//    re-simulating from it reproduce the server bit-for-bit.
//  * each snapshot also carries the inputs already received for the ticks
//    after it, so clients replay the other humans with their real inputs
//    (less guessing, smaller corrections) instead of repeating the last one.
//  * snapshots go out as deltas against the newest one each client has
//    acknowledged (falling back to a full one), ~4x smaller.
//  * a human whose inputs stop arriving is played by the AI after a moment
//    (sim BOT_AFTER) until they resume, instead of running on blindly.

import {
  createWorld, addPlayer, removePlayer, updatePlayerSpec, step, startMatch, stopMatch, startKickoff, pById, goalTicks,
} from './sim.js';
import { cleanPlayerName } from './names.js';
import { SNAP_EVERY, ROLE, PHASE, autoPitch, MAX_PLAYERS, TEAM_NAMES, QUICK_CHAT, GOAL_SIZE_DEFAULT, KIT_NAMES, KITS_DEFAULT, GAME_SPEEDS, GAME_SPEED_DEFAULT } from './constants.js';
import {
  worldBytes, encodeFuture, fullSnapshot, deltaSnapshot, patchSnapshotHeader, readWorld, decodeInputs,
} from './protocol.js';

const MAX_PER_TEAM = 8;
const LEAD_WINDOW = 30;
export const MAX_MEMBERS = 16;

const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
export function sanitizeProfile(p) {
  const a = (p && p.avatar) || {};
  // (a name that isn't allowed – see names.js – becomes PlayerNNN, the same for the same name)
  const raw = String((p && p.name) || '');
  let h = 7;
  for (const c of raw) h = (h * 31 + c.codePointAt(0)) >>> 0;
  const name = cleanPlayerName(raw) || `Player${100 + (h % 900)}`;
  const sex = clampInt(a.sex, 0, 1, 0); // 0: man, 1: woman (looks only – the body sliders set the attributes)
  return {
    name,
    avatar: {
      sex, skin: hex(a.skin, '#e0ac69'), hair: clampInt(a.hair, 0, 11, 1), hairColor: hex(a.hairColor, '#2b1b10'),
      beard: sex ? 0 : clampInt(a.beard, 0, 4, 0),
      boots: hex(a.boots, '#111111'), number: clampInt(a.number, 1, 99, 10),
      phys: { h: clampInt(a.phys && a.phys.h, 160, 200, 180), b: clampInt(a.phys && a.phys.b, 0, 100, 50), f: a.phys && a.phys.f === 1 ? 1 : 0 },
    },
  };
}

const AI_SKINS = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a26b45'];
const AI_HAIR = ['#1b1b1b', '#3b2416', '#7a4a1f', '#d9b25f', '#9c9c9c', '#b5532d'];
const AI_HAIR_W = [3, 6, 6, 7, 10, 11, 1, 8]; // long, ponytail (×2), bun, bob, braids, short, curly

// An AI player's looks, the same every time for the same id. aiSex (room
// setting): 0 mixed, 1 men, 2 women.
function aiAvatar(id, role, aiSex) {
  const r = (k) => (id * 2654435761 + k * 40503) >>> 0;
  const sex = aiSex === 1 ? 0 : aiSex === 2 ? 1 : r(9) % 2;
  const gk = role === ROLE.GK;
  return {
    sex, skin: AI_SKINS[r(1) % AI_SKINS.length],
    hair: sex ? AI_HAIR_W[r(2) % AI_HAIR_W.length] : r(2) % 10, hairColor: AI_HAIR[r(3) % (sex ? 5 : AI_HAIR.length)],
    beard: !sex && r(7) % 3 === 0 ? 1 + (r(8) % 4) : 0,
    boots: '#222222', number: gk ? 1 : 2 + (r(4) % 20),
    // (about one in four left-footed)
    phys: sex
      ? { h: gk ? 176 + (r(5) % 12) : 160 + (r(5) % 18), b: 20 + (r(6) % 45), f: r(10) % 4 === 0 ? 1 : 0 }
      : { h: gk ? 186 + (r(5) % 10) : 168 + (r(5) % 22), b: 30 + (r(6) % 45), f: r(10) % 4 === 0 ? 1 : 0 },
  };
}

export class Room {
  constructor(code, name, onEmpty) {
    this.code = code;
    this.name = name;
    this.onEmpty = onEmpty;
    this.members = new Map(); // clientId -> member
    this.ai = new Map();      // playerId -> ai spec
    this.hostId = null;
    this.ended = false; // a match played to its end (or stopped): the next is a restart
    this.settings = { matchLen: 240, pitch: 'auto', goals: GOAL_SIZE_DEFAULT, ai: 1, aiSex: 0, kits: [...KITS_DEFAULT], offside: 0, movement: 0, weather: 1, speed: GAME_SPEED_DEFAULT }; // (a night match, at 80%)
    this.world = createWorld(1, (Math.random() * 2 ** 31) | 0);
    this.world.auth = true; // inputs that don't arrive are missing here (see BOT_AFTER)
    this.world.m.matchLen = this.settings.matchLen;
    this.world.m.goalS = this.settings.goals;
    startKickoff(this.world, 0);
    this.inputs = new Map();  // playerId -> Map(tick -> input)
    this.skips = new Set();   // members who skipped the current goal replay
    this.onChange = null;     // (whoever lists the room: called whenever the room state goes out)
    this.addAI(1, ROLE.GK);   // someone to shoot at from the start (Team A's first player: shooting practice)
  }

  // ------------------------------------------------------------ membership

  join(client) {
    const m = {
      client, id: client.id, name: client.profile.name, avatar: client.profile.avatar,
      team: -1, role: ROLE.OUT, playerId: -1, leads: [], lead: 0, lastAck: 0,
    };
    this.members.set(client.id, m);
    client.room = this;
    if (this.hostId === null) this.hostId = client.id;
    // auto-assign to the team with fewer outfield players (keepers don't count)
    const c0 = this.teamCount(0, true), c1 = this.teamCount(1, true);
    const team = c0 <= c1 ? 0 : 1;
    if (this.teamCount(team) < MAX_PER_TEAM && this.world.players.length < MAX_PLAYERS) this.setTeam(m, team, ROLE.OUT, true);
    if (this.members.size > 1) this.system(`${m.name} joined`);
    this.broadcastRoom();
    this.sendSnapshotTo(m, this.encode());
  }

  leave(client) {
    const m = this.members.get(client.id);
    if (!m) return;
    if (m.playerId >= 0) this.removeWorldPlayer(m.playerId);
    this.members.delete(client.id);
    client.room = null;
    if (this.hostId === client.id) this.hostId = this.members.size ? this.members.keys().next().value : null;
    if (this.members.size === 0) { this.onEmpty(this); return; }
    this.system(`${m.name} left`);
    this.refreshPitch();
    this.broadcastRoom();
  }

  teamCount(team, outfield = false) {
    let n = 0;
    for (const p of this.world.players) if (p.team === team && !(outfield && p.role === ROLE.GK)) n++;
    return n;
  }

  freeId() {
    const used = new Set(this.world.players.map((p) => p.id));
    for (let i = 0; i < 120; i++) if (!used.has(i)) return i;
    return -1;
  }

  hasKeeper(team, exceptId = -1) {
    return this.world.players.some((p) => p.team === team && p.role === ROLE.GK && p.id !== exceptId);
  }

  setTeam(m, team, role, silent = false) {
    if (team !== -1 && team !== 0 && team !== 1) return;
    role = role === ROLE.GK ? ROLE.GK : ROLE.OUT;
    if (team === -1) {
      if (m.playerId >= 0) this.removeWorldPlayer(m.playerId);
      m.playerId = -1; m.team = -1;
    } else {
      // a human taking the keeper spot replaces an AI keeper
      if (role === ROLE.GK && this.hasKeeper(team, m.playerId)) {
        const aiGk = [...this.ai.values()].find((a) => a.team === team && a.role === ROLE.GK);
        if (aiGk) this.removeAI(aiGk.playerId, true);
        else return this.whisper(m, 'That team already has a keeper.');
      }
      const switching = m.team !== team;
      if (switching && this.teamCount(team) >= MAX_PER_TEAM) return this.whisper(m, 'Team is full.');
      const phys = m.avatar.phys;
      if (m.playerId < 0) {
        if (this.world.players.length >= MAX_PLAYERS) return this.whisper(m, 'Room is full.');
        m.playerId = this.freeId();
        addPlayer(this.world, { id: m.playerId, team, role, human: 1, hgt: phys.h, bld: phys.b, ft: phys.f });
      } else {
        updatePlayerSpec(this.world, { id: m.playerId, team, role, human: 1, hgt: phys.h, bld: phys.b, ft: phys.f });
      }
      m.team = team; m.role = role;
      this.inputs.set(m.playerId, new Map());
    }
    this.refreshPitch();
    if (!silent) this.broadcastRoom();
  }

  removeWorldPlayer(id) {
    removePlayer(this.world, id);
    this.inputs.delete(id);
  }

  addAI(team, role) {
    if (team !== 0 && team !== 1) return;
    role = role === ROLE.GK ? ROLE.GK : ROLE.OUT;
    if (role === ROLE.GK && this.hasKeeper(team)) return;
    if (this.teamCount(team) >= MAX_PER_TEAM || this.world.players.length >= MAX_PLAYERS) return;
    const id = this.freeId();
    const spec = {
      playerId: id, team, role,
      name: role === ROLE.GK ? 'AI Keeper' : `AI ${id}`,
      avatar: aiAvatar(id, role, this.settings.aiSex),
    };
    this.ai.set(id, spec);
    addPlayer(this.world, { id, team, role, human: 0, hgt: spec.avatar.phys.h, bld: spec.avatar.phys.b, ft: spec.avatar.phys.f });
    this.refreshPitch();
    this.broadcastRoom();
  }

  removeAI(id, silent = false) {
    if (!this.ai.has(id)) return;
    this.ai.delete(id);
    this.removeWorldPlayer(id);
    this.refreshPitch();
    if (!silent) this.broadcastRoom();
  }

  updateProfile(m, profile) {
    m.name = profile.name; m.avatar = profile.avatar;
    if (m.playerId >= 0) {
      updatePlayerSpec(this.world, { id: m.playerId, team: m.team, role: m.role, human: 1, hgt: profile.avatar.phys.h, bld: profile.avatar.phys.b, ft: profile.avatar.phys.f });
    }
    this.broadcastRoom();
  }

  refreshPitch() {
    if (this.world.m.live) return;
    const want = this.settings.pitch === 'auto'
      ? autoPitch(Math.max(this.teamCount(0), this.teamCount(1)))
      : Number(this.settings.pitch);
    if (want !== this.world.pitchId) {
      this.world.pitchId = want;
      startKickoff(this.world, 0);
    }
  }

  // ------------------------------------------------------------ host controls

  applySettings(m, s) {
    if (m.id !== this.hostId) return;
    if ([120, 240, 360, 600, 900].includes(s.matchLen)) this.settings.matchLen = s.matchLen;
    if (['auto', '0', '1', '2', 0, 1, 2].includes(s.pitch)) this.settings.pitch = String(s.pitch);
    if ([0, 1, 2].includes(Number(s.goals))) this.settings.goals = Number(s.goals);
    if ([0, 1, 2].includes(Number(s.ai))) this.settings.ai = Number(s.ai);
    if ([0, 1].includes(Number(s.offside))) this.settings.offside = Number(s.offside);
    if ([0, 1].includes(Number(s.movement))) this.settings.movement = Number(s.movement);
    if (GAME_SPEEDS.includes(Number(s.speed))) this.settings.speed = Number(s.speed);
    if ([0, 1, 2, 3].includes(Number(s.weather))) this.settings.weather = Number(s.weather);
    if (Array.isArray(s.kits) && s.kits.length === 2) {
      const k = s.kits.map(Number);
      if (k.every((v) => Number.isInteger(v) && v >= 0 && v < KIT_NAMES.length) && k[0] !== k[1]) this.settings.kits = k;
    }
    if ([0, 1, 2].includes(Number(s.aiSex)) && Number(s.aiSex) !== this.settings.aiSex) {
      // the AI players on the pitch change to match (their bodies too)
      this.settings.aiSex = Number(s.aiSex);
      for (const a of this.ai.values()) {
        a.avatar = aiAvatar(a.playerId, a.role, this.settings.aiSex);
        updatePlayerSpec(this.world, { id: a.playerId, team: a.team, role: a.role, human: 0, hgt: a.avatar.phys.h, bld: a.avatar.phys.b, ft: a.avatar.phys.f });
      }
    }
    if (!this.world.m.live) {
      this.world.m.matchLen = this.settings.matchLen;
      this.world.m.goalS = this.settings.goals; // the goals don't change size mid-match
    }
    this.world.m.ai = this.settings.ai; this.world.m.offs = this.settings.offside; this.world.m.real = this.settings.movement;
    this.refreshPitch();
    this.broadcastRoom();
  }

  start(m) {
    if (m.id !== this.hostId) return;
    if (this.teamCount(0) === 0 || this.teamCount(1) === 0) return this.whisper(m, 'Both teams need at least one player.');
    this.world.m.live = 0;
    this.refreshPitch();
    this.world.m.goalS = this.settings.goals; this.world.m.ai = this.settings.ai; this.world.m.offs = this.settings.offside; this.world.m.real = this.settings.movement;
    startMatch(this.world, this.settings.matchLen);
    this.ended = false;
    this.system('Kick-off! ' + TEAM_NAMES[0] + ' vs ' + TEAM_NAMES[1]);
    this.broadcastRoom();
  }

  stop(m) {
    if (m.id !== this.hostId) return;
    stopMatch(this.world);
    this.refreshPitch();
    this.ended = true;
    this.system('Match stopped - back to warm-up');
    this.broadcastRoom();
  }

  // ------------------------------------------------------------ client messages

  // Messages a member can send once inside the room (lobby-level messages such
  // as create/join/list are handled by whoever hosts the room).
  handleText(client, msg) {
    const m = this.members.get(client.id);
    if (!m) return;
    switch (msg.t) {
      case 'hello':
      case 'profile':
        client.profile = sanitizeProfile(msg.profile);
        this.updateProfile(m, client.profile);
        break;
      case 'team': this.setTeam(m, Number(msg.team), Number(msg.role)); break;
      case 'addAI': this.addAI(Number(msg.team), Number(msg.role)); break;
      case 'removeAI': this.removeAI(Number(msg.id)); break;
      case 'settings': this.applySettings(m, msg); break;
      case 'start': this.start(m); break;
      case 'stop': this.stop(m); break;
      case 'skip': {
        // once every player on the pitch has skipped the replay, restart sooner
        const w = this.world;
        if (w.m.phase !== PHASE.GOAL || !w.m.live) break;
        this.skips.add(m.id);
        const players = [...this.members.values()].filter((x) => x.playerId >= 0);
        if (players.every((x) => this.skips.has(x.id))) w.m.phT = Math.max(w.m.phT, goalTicks(w.m) - 45);
        break;
      }
      case 'chat': {
        // quick chat only: a number from the fixed list, at most one every 1.5 s
        const i = Number(msg.id);
        const now = Date.now();
        if (!Number.isInteger(i) || i < 0 || i >= QUICK_CHAT.length || now - (m.lastChat || 0) < 1500) break;
        m.lastChat = now;
        this.say(m.name, QUICK_CHAT[i], m.playerId);
        break;
      }
    }
  }

  // ------------------------------------------------------------ inputs

  onInput(m, dv) {
    if (dv.byteLength < 10 || dv.byteLength < 10 + dv.getUint8(1) * 3) return;
    const { latest, ack, inputs } = decodeInputs(dv);
    if (ack > (m.snapAck || 0) && ack <= this.world.tick) m.snapAck = ack;
    if (m.playerId < 0) return; // spectators only acknowledge snapshots
    const buf = this.inputs.get(m.playerId);
    if (!buf) return;
    const next = this.world.tick + 1;
    for (const it of inputs) {
      if (it.tick < next || it.tick > next + 120) continue;
      if (!buf.has(it.tick)) buf.set(it.tick, it);
    }
    // how many ticks before it is needed did the newest input arrive?
    m.leads.push(latest - next);
    if (m.leads.length > LEAD_WINDOW) m.leads.shift();
    m.lastAck = Math.max(m.lastAck, latest);
  }

  // ------------------------------------------------------------ simulation

  // how fast the room plays: a share of TICK_RATE (see GAME_SPEEDS)
  speed() { return (this.settings.speed || GAME_SPEED_DEFAULT) / 100; }

  tick() {
    const w = this.world;
    const t = w.tick + 1;
    const frame = new Map();
    for (const [pid, buf] of this.inputs) {
      const it = buf.get(t);
      if (it) { frame.set(pid, it); buf.delete(t); }
      for (const k of buf.keys()) if (k < t) buf.delete(k);
    }
    const phase = w.m.phase, live = w.m.live;
    step(w, frame);
    for (const e of w.events) if (e.k === 'goal') this.onGoal(e);
    // the final whistle, and the warm-up after it: everyone's panel hears
    // (its button becomes a restart)
    if (phase !== PHASE.FULLTIME && w.m.phase === PHASE.FULLTIME) { this.ended = true; this.broadcastRoom(); }
    else if (live && !w.m.live) this.broadcastRoom();
    if (w.tick % SNAP_EVERY === 0) this.broadcastSnapshot();
  }

  onGoal(e) {
    this.skips = new Set();
    const scorer = this.nameOf(e.scorer);
    const w = this.world;
    if (!w.m.live) return; // warm-up goals aren't announced
    const score = `  ${w.m.s0}-${w.m.s1}`;
    this.system(`GOAL ${TEAM_NAMES[e.team]}${scorer ? ' - ' + scorer : ''}${e.own ? ' (own goal)' : ''}${score}`);
  }

  nameOf(pid) {
    for (const m of this.members.values()) if (m.playerId === pid) return m.name;
    const a = this.ai.get(pid);
    return a ? a.name : '';
  }

  // inputs already here for the coming ticks, in order (contiguous from the next tick)
  future() {
    const future = new Map();
    const t0 = this.world.tick + 1;
    for (const [pid, buf] of this.inputs) {
      const list = [];
      for (let t = t0; buf.has(t) && list.length < 16; t++) list.push(buf.get(t));
      if (list.length) future.set(pid, list.map((it, i) => ({ tick: t0 + i, a: it.a, m: it.m, b: it.b })));
    }
    return future;
  }

  encode() { return fullSnapshot(worldBytes(this.world), encodeFuture(this.world.tick, this.future())); }

  broadcastSnapshot() {
    const world = worldBytes(this.world);
    const fut = encodeFuture(this.world.tick, this.future());
    // Adopt the f32-quantised state so the server and every client continue
    // from bit-identical numbers.
    const [qw] = readWorld(new DataView(world.buffer), 0);
    qw.replay = false;
    qw.auth = true;
    this.world = qw;
    // keep recent snapshots as delta bases (about 2 s)
    if (!this.sent) this.sent = new Map();
    this.sent.set(qw.tick, world);
    for (const t of this.sent.keys()) if (t < qw.tick - 120) this.sent.delete(t);
    let full = null;
    for (const m of this.members.values()) {
      const base = m.snapAck ? this.sent.get(m.snapAck) : null;
      let bytes;
      if (base && base.length === world.length) bytes = deltaSnapshot(world, base, m.snapAck, fut);
      else bytes = full || (full = fullSnapshot(world, fut));
      this.sendSnapshotTo(m, bytes);
    }
  }

  sendSnapshotTo(m, bytes) {
    const copy = new Uint8Array(bytes);
    let lead = 0;
    if (m.leads.length) lead = Math.min(...m.leads);
    else if (m.playerId >= 0) lead = -100; // no inputs yet
    patchSnapshotHeader(copy, lead, m.lastAck);
    m.client.sendBinary(copy);
  }

  // ------------------------------------------------------------ messaging

  roomState() {
    const members = [...this.members.values()].map((m) => ({
      id: m.id, name: m.name, avatar: m.avatar, team: m.team, role: m.role, playerId: m.playerId,
    }));
    const ai = [...this.ai.values()];
    return {
      t: 'room', code: this.code, name: this.name, hostId: this.hostId, settings: this.settings,
      members, ai, live: this.world.m.live, ended: this.ended ? 1 : 0, // (ended: a match was played to its end, or stopped – the next one's a restart)
    };
  }

  broadcastRoom() {
    const msg = JSON.stringify(this.roomState());
    for (const m of this.members.values()) m.client.sendText(msg);
    if (this.onChange) this.onChange();
  }

  system(text) { this.say(null, text); }

  say(from, text, pid = -1) {
    const msg = JSON.stringify({ t: 'chat', from, text, pid, at: Date.now() });
    for (const m of this.members.values()) m.client.sendText(msg);
  }

  whisper(m, text) { m.client.sendText(JSON.stringify({ t: 'chat', from: null, text, at: Date.now() })); }

  summary() {
    const humans = [...this.members.values()].length;
    return { code: this.code, name: this.name, humans, ai: this.ai.size, live: this.world.m.live, score: [this.world.m.s0, this.world.m.s1] };
  }
}
