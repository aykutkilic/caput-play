// Binary wire protocol. Snapshots carry the *complete* simulation state so a
// client can roll back to it and re-simulate forward bit-for-bit like the server
// – usually as a delta against a snapshot the client has acknowledged (the
// changed bytes only, run-length coded: ~4x smaller, one packet even for 16
// players), so a lost packet never costs more than the next one repairs.

import { createWorld, makePlayer, makeBall, makeMatch } from './sim.js';

export const MSG = { INPUT: 1, SNAP: 2, PING: 3, PONG: 4, SNAPD: 5 };
export const INPUT_REDUNDANCY = 8; // every input packet repeats the last N ticks

const PLAYER = [
  ['id', 'u8'], ['team', 'u8'], ['role', 'u8'], ['human', 'u8'], ['hgt', 'u8'], ['bld', 'u8'],
  ['x', 'f32'], ['y', 'f32'], ['z', 'f32'], ['vx', 'f32'], ['vy', 'f32'], ['vz', 'f32'], ['face', 'f32'],
  ['st', 'u8'], ['stT', 'u16'], ['stDur', 'u16'], ['stA', 'f32'], ['stB', 'f32'], ['hit', 'u8'],
  ['kk', 'u8'], ['kp', 'f32'], ['kx', 'f32'], ['ky', 'f32'], ['kt', 'i8'], ['kv', 'f32'], ['kh', 'u8'], ['kq', 'u8'],
  ['chg', 'u8'], ['chgBtn', 'u8'], ['stam', 'f32'], ['pb', 'u8'], ['kcd', 'u8'], ['tcd', 'u8'],
  ['tap', 'u8'], ['tapT', 'u8'], ['tapK', 'u8'], ['tapH', 'u8'], ['spr', 'u8'], ['bot', 'u8'], ['miss', 'u8'], ['tm', 'u8'], ['qk', 'u8'],
  ['qa', 'u8'], ['qt', 'u8'], ['qp', 'f32'], ['dph', 'f32'], ['hold', 'u16'],
  ['ai', 'u8'], ['aiT', 'u16'], ['aiX', 'f32'], ['aiY', 'f32'],
  ['ia', 'u8'], ['im', 'u8'], ['ib', 'u8'],
];
const BALL = [
  ['x', 'f32'], ['y', 'f32'], ['z', 'f32'], ['vx', 'f32'], ['vy', 'f32'], ['vz', 'f32'], ['spin', 'f32'],
  ['owner', 'i8'], ['held', 'u8'], ['last', 'i8'], ['lastTeam', 'i8'], ['kt', 'u8'], ['tgt', 'i8'], ['sh', 'i8'], ['dl', 'u8'], ['nut', 'i8'],
  ['atk', 'i8'], ['atT', 'u8'], ['atA', 'u8'], ['atM', 'u8'], ['atOn', 'u8'],
  ['pf', 'i8'], ['pft', 'i8'], ['pfx', 'f32'], ['fwdX', 'f32'], ['stale', 'u8'],
];
const MATCH = [
  ['phase', 'u8'], ['phT', 'u16'], ['live', 'u8'], ['s0', 'u8'], ['s1', 'u8'], ['clock', 'u32'], ['half', 'u8'],
  ['dir0', 'i8'], ['ko', 'u8'], ['koFirst', 'u8'], ['spType', 'u8'], ['spTeam', 'u8'], ['spTaker', 'i8'],
  ['spX', 'f32'], ['spY', 'f32'], ['matchLen', 'u16'], ['rng', 'u32'], ['lastGoalTeam', 'i8'], ['scorer', 'i8'],
  ['req0', 'i8'], ['req0T', 'u8'], ['req1', 'i8'], ['req1T', 'u8'], ['gkc0', 'u8'], ['gkc1', 'u8'], ['cd', 'u16'],
  ['goalS', 'u8'], ['ai', 'u8'], ['wr', 'u8'],
];

const SIZE = { u8: 1, i8: 1, u16: 2, u32: 4, f32: 4 };
const sizeOf = (schema) => schema.reduce((n, [, t]) => n + SIZE[t], 0);
const P_SIZE = sizeOf(PLAYER), B_SIZE = sizeOf(BALL), M_SIZE = sizeOf(MATCH);
const HEADER = 4 + 1 + 1; // tick, pitchId, nPlayers

function writeObj(dv, o, schema, off) {
  for (const [k, t] of schema) {
    const v = o[k];
    switch (t) {
      case 'u8': dv.setUint8(off, v); off += 1; break;
      case 'i8': dv.setInt8(off, v); off += 1; break;
      case 'u16': dv.setUint16(off, v); off += 2; break;
      case 'u32': dv.setUint32(off, v >>> 0); off += 4; break;
      case 'f32': dv.setFloat32(off, v); off += 4; break;
    }
  }
  return off;
}
function readObj(dv, o, schema, off) {
  for (const [k, t] of schema) {
    switch (t) {
      case 'u8': o[k] = dv.getUint8(off); off += 1; break;
      case 'i8': o[k] = dv.getInt8(off); off += 1; break;
      case 'u16': o[k] = dv.getUint16(off); off += 2; break;
      case 'u32': o[k] = dv.getUint32(off); off += 4; break;
      case 'f32': o[k] = dv.getFloat32(off); off += 4; break;
    }
  }
  return off;
}

export function worldSize(w) { return HEADER + M_SIZE + B_SIZE + P_SIZE * w.players.length; }

export function writeWorld(dv, off, w) {
  dv.setUint32(off, w.tick); off += 4;
  dv.setUint8(off++, w.pitchId);
  dv.setUint8(off++, w.players.length);
  off = writeObj(dv, w.m, MATCH, off);
  off = writeObj(dv, w.ball, BALL, off);
  for (const p of w.players) off = writeObj(dv, p, PLAYER, off);
  return off;
}

export function readWorld(dv, off) {
  const tick = dv.getUint32(off); off += 4;
  const pitchId = dv.getUint8(off++);
  const n = dv.getUint8(off++);
  const w = createWorld(pitchId, 1);
  w.tick = tick;
  w.m = makeMatch(1);
  off = readObj(dv, w.m, MATCH, off);
  w.ball = makeBall();
  off = readObj(dv, w.ball, BALL, off);
  w.ball.px = w.ball.x; w.ball.py = w.ball.y; w.ball.pz = w.ball.z;
  for (let i = 0; i < n; i++) {
    const p = makePlayer(0, 0, 0, 0);
    off = readObj(dv, p, PLAYER, off);
    p.px = p.x; p.py = p.y; p.pz = p.z;
    w.players.push(p);
  }
  return [w, off];
}

// Round-trips a world through the binary format: gives the server a state that
// is bit-identical to what clients will decode (f32 precision).
export function quantize(w) {
  const buf = new ArrayBuffer(worldSize(w));
  writeWorld(new DataView(buf), 0, w);
  return readWorld(new DataView(buf), 0)[0];
}

// Deep copy without going through f32.
export function cloneWorld(w) {
  return {
    tick: w.tick, pitchId: w.pitchId, replay: w.replay, events: [],
    m: { ...w.m }, ball: { ...w.ball }, players: w.players.map((p) => ({ ...p })),
  };
}

// ----- snapshots
//   full:  [MSG.SNAP][lead i8][ackTick u32][world][future inputs]
//   delta: [MSG.SNAPD][lead i8][ackTick u32][base tick u32][world bytes u16][delta bytes u16][delta][future inputs]
// Future inputs: the inputs the server already holds for ticks after the
// snapshot (clients send them a few ticks early), so every client can re-run
// the other humans with what they really pressed instead of guessing:
//   [nPlayers u8] then per player [id u8][first tick - snapshot tick u8][n u8][n * (a, m, b)]

export function worldBytes(w) {
  const bytes = new Uint8Array(worldSize(w));
  writeWorld(new DataView(bytes.buffer), 0, w);
  return bytes;
}

export function encodeFuture(tick, future) {
  let size = 1;
  if (future) for (const list of future.values()) size += 3 + list.length * 3;
  const out = new Uint8Array(size);
  let off = 0;
  out[off++] = future ? future.size : 0;
  if (future) {
    for (const [id, list] of future) {
      out[off++] = id; out[off++] = list.length ? list[0].tick - tick : 1; out[off++] = list.length;
      for (const it of list) { out[off++] = it.a; out[off++] = it.m; out[off++] = it.b; }
    }
  }
  return out;
}
function decodeFuture(dv, off, tick) {
  const future = new Map();
  if (off >= dv.byteLength) return future;
  const n = dv.getUint8(off++);
  for (let i = 0; i < n && off + 3 <= dv.byteLength; i++) {
    const id = dv.getUint8(off++), first = tick + dv.getUint8(off++), k = dv.getUint8(off++);
    const list = [];
    for (let j = 0; j < k && off + 3 <= dv.byteLength; j++, off += 3) {
      list.push({ tick: first + j, a: dv.getUint8(off), m: dv.getUint8(off + 1), b: dv.getUint8(off + 2) });
    }
    future.set(id, list);
  }
  return future;
}

// Bytes that differ from the base, XORed, as (equal run, changed run, changed bytes) pairs.
export function xorDelta(cur, base) {
  const out = new Uint8Array(cur.length * 2 + 2);
  let o = 0, i = 0;
  const n = cur.length;
  while (i < n) {
    let z = 0;
    while (i < n && z < 255 && cur[i] === base[i]) { z++; i++; }
    const s = i;
    let l = 0;
    while (i < n && l < 255 && cur[i] !== base[i]) { l++; i++; }
    out[o++] = z; out[o++] = l;
    for (let k = 0; k < l; k++) out[o++] = cur[s + k] ^ base[s + k];
  }
  return out.subarray(0, o);
}
function applyDelta(base, delta) {
  const out = new Uint8Array(base);
  let i = 0, o = 0;
  while (o + 1 < delta.length) {
    i += delta[o++];
    const l = delta[o++];
    for (let k = 0; k < l; k++) out[i + k] ^= delta[o++];
    i += l;
  }
  return out;
}

export function encodeSnapshot(w, future = null) {
  return fullSnapshot(worldBytes(w), encodeFuture(w.tick, future));
}
export function fullSnapshot(world, fut) {
  const out = new Uint8Array(6 + world.length + fut.length);
  out[0] = MSG.SNAP;
  out.set(world, 6); out.set(fut, 6 + world.length);
  return out;
}
export function deltaSnapshot(world, base, baseTick, fut) {
  const d = xorDelta(world, base);
  const out = new Uint8Array(14 + d.length + fut.length);
  const dv = new DataView(out.buffer);
  out[0] = MSG.SNAPD;
  dv.setUint32(6, baseTick >>> 0); dv.setUint16(10, world.length); dv.setUint16(12, d.length);
  out.set(d, 14); out.set(fut, 14 + d.length);
  return out;
}
export function patchSnapshotHeader(bytes, lead, ackTick) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dv.setInt8(1, Math.max(-127, Math.min(127, Math.round(lead))));
  dv.setUint32(2, ackTick >>> 0);
}
export function decodeSnapshot(ab) {
  const dv = new DataView(ab);
  const [w, off] = readWorld(dv, 6);
  return { lead: dv.getInt8(1), ack: dv.getUint32(2), world: w, future: decodeFuture(dv, off, w.tick) };
}

// Client side: keeps the recent snapshots it has, rebuilds deltas against
// them, and tells the server (via `latest`) which one it can use as a base.
export class SnapshotDecoder {
  constructor() { this.bases = new Map(); this.latest = 0; }
  decode(ab) {
    const dv = new DataView(ab);
    let world, futOff;
    if (dv.getUint8(0) === MSG.SNAP) {
      const [, end] = readWorld(dv, 6);
      world = new Uint8Array(ab, 6, end - 6).slice();
      futOff = end;
    } else {
      const base = this.bases.get(dv.getUint32(6));
      const len = dv.getUint16(10), dl = dv.getUint16(12);
      if (!base || base.length !== len) return null; // its base is gone: wait for the next one
      world = applyDelta(base, new Uint8Array(ab, 14, dl));
      futOff = 14 + dl;
    }
    const [w] = readWorld(new DataView(world.buffer), 0);
    this.bases.set(w.tick, world);
    if (w.tick > this.latest) this.latest = w.tick;
    for (const t of this.bases.keys()) if (t < this.latest - 240) this.bases.delete(t);
    return { lead: dv.getInt8(1), ack: dv.getUint32(2), world: w, future: decodeFuture(dv, futOff, w.tick) };
  }
}

// ----- input: [MSG.INPUT][n u8][latestTick u32][snapshot ack u32] then n * (a, m, b) newest first
export function encodeInputs(latestTick, list, snapAck = 0) {
  const n = list.length;
  const buf = new ArrayBuffer(10 + n * 3);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG.INPUT); dv.setUint8(1, n); dv.setUint32(2, latestTick >>> 0); dv.setUint32(6, snapAck >>> 0);
  for (let i = 0; i < n; i++) {
    const it = list[i];
    dv.setUint8(10 + i * 3, it.a); dv.setUint8(11 + i * 3, it.m); dv.setUint8(12 + i * 3, it.b);
  }
  return buf;
}
export function decodeInputs(dv) {
  const n = dv.getUint8(1), latest = dv.getUint32(2), ack = dv.getUint32(6), out = [];
  for (let i = 0; i < n; i++) {
    out.push({ tick: latest - i, a: dv.getUint8(10 + i * 3), m: dv.getUint8(11 + i * 3), b: dv.getUint8(12 + i * 3) });
  }
  return { latest, ack, inputs: out };
}

// ----- ping/pong (clock sync)
export function encodePing(clientTime) {
  const buf = new ArrayBuffer(9); const dv = new DataView(buf);
  dv.setUint8(0, MSG.PING); dv.setFloat64(1, clientTime);
  return buf;
}
export function encodePong(clientTime, serverTick, tickFrac) {
  const buf = new ArrayBuffer(17); const dv = new DataView(buf);
  dv.setUint8(0, MSG.PONG); dv.setFloat64(1, clientTime); dv.setUint32(9, serverTick >>> 0); dv.setFloat32(13, tickFrac);
  return new Uint8Array(buf);
}
export function decodePong(dv) {
  return { clientTime: dv.getFloat64(1), serverTick: dv.getUint32(9), frac: dv.getFloat32(13) };
}
