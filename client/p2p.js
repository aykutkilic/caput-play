// Serverless rooms: the player who creates a room runs the authoritative Room
// (the very same code the Node server runs) inside their browser; everyone else
// connects to them directly with WebRTC.
//
//  * Signalling (the WebRTC handshake) goes through our Cloudflare Worker
//    (cloud/, a PeerJS-compatible broker), which also hands out TURN relay
//    credentials for networks that block direct connections; after that all
//    traffic is peer-to-peer. Without a Worker configured (client/cloud.js)
//    the free public PeerJS broker and its defaults are used.
//  * Each guest gets two channels on one connection: PeerJS's reliable,
//    ordered channel for lobby JSON, and our own negotiated unordered,
//    zero-retransmit channel for inputs, snapshots and pings - the same
//    unreliable transport the dedicated server uses, so the prediction /
//    rollback netcode is unchanged.
//  * The host's simulation is clocked from a Web Worker, because page timers
//    are throttled hard in background tabs while worker timers are not.

import { Transport } from './net.js';
import { Room, sanitizeProfile, MAX_MEMBERS } from '../shared/room.js';
import { MSG, encodePong } from '../shared/protocol.js';
import { TICK_RATE } from '../shared/constants.js';
import { cloudUrl } from './cloud.js';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
const PEERJS_SRI = 'sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu';
const PEER_PREFIX = 'caput-v1-';
const GAME_CHANNEL = { negotiated: true, id: 100, ordered: false, maxRetransmits: 0 };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TICK_MS = 1000 / TICK_RATE;

let peerLib = null;
export function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerLib) {
    peerLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PEERJS_URL;
      s.integrity = PEERJS_SRI;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS failed to load')));
      s.onerror = () => { peerLib = null; reject(new Error('could not load PeerJS')); };
      document.head.appendChild(s);
    });
  }
  return peerLib;
}

// PeerJS options: our Worker as the broker, with its STUN/TURN servers
let iceOnce = null;
async function peerOptions() {
  const base = cloudUrl();
  if (!base) return { debug: 0 };
  const u = new URL(base);
  const secure = u.protocol === 'https:';
  const opts = { debug: 0, host: u.hostname, port: Number(u.port) || (secure ? 443 : 80), path: '/', secure, key: 'peerjs' };
  if (!iceOnce) {
    iceOnce = fetch(new URL('/ice', base), { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => (Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : null))
      .catch(() => null);
  }
  const ice = await iceOnce;
  if (!ice) iceOnce = null; // try again next time
  opts.config = { iceServers: ice || [{ urls: 'stun:stun.cloudflare.com:3478' }] };
  return opts;
}

// A guest's peer id carries the room code, so the broker can route it.
function guestId(code) {
  return `${PEER_PREFIX}${code}-${Math.random().toString(36).slice(2, 10)}`;
}

async function openPeer(Peer, id) {
  const opts = await peerOptions();
  return new Promise((resolve, reject) => {
    const peer = new Peer(id, opts);
    const timer = setTimeout(() => { peer.destroy(); reject(Object.assign(new Error('signalling timeout'), { type: 'timeout' })); }, 12000);
    peer.once('open', () => { clearTimeout(timer); resolve(peer); });
    peer.once('error', (e) => { clearTimeout(timer); peer.destroy(); reject(e); });
  });
}

function openGameChannel(pc, onMessage) {
  const dc = pc.createDataChannel('game', GAME_CHANNEL);
  dc.binaryType = 'arraybuffer';
  dc.onmessage = (e) => { if (e.data instanceof ArrayBuffer) onMessage(e.data); };
  return dc;
}

function toView(b) {
  return b instanceof ArrayBuffer ? new DataView(b) : new DataView(b.buffer, b.byteOffset, b.byteLength);
}

// ---------------------------------------------------------------- host

export class HostSession {
  constructor() {
    this.peer = null;
    this.room = null;
    this.code = null;
    this.guests = new Set();
    this.nextId = 2; // 1 is the host's own client
    this.closed = false;
    this.local = new LocalNet(this);
  }

  async start(roomName) {
    const Peer = await loadPeer();
    let err = null;
    for (let i = 0; i < 5 && !this.peer; i++) {
      let code = '';
      for (let k = 0; k < 4; k++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
      try {
        this.peer = await openPeer(Peer, PEER_PREFIX + code);
        this.code = code;
      } catch (e) {
        err = e;
        if (e.type !== 'unavailable-id') break;
      }
    }
    if (!this.peer) throw err || new Error('could not open a room');
    this.room = new Room(this.code, String(roomName).replace(/[<>]/g, '').slice(0, 28), () => {});
    this.peer.on('connection', (conn) => this.accept(conn));
    // stay reachable for new joiners if the signalling socket drops
    this.peer.on('disconnected', () => { if (!this.closed) this.peer.reconnect(); });
    this.peer.on('error', (e) => console.warn('[host] peer error:', e.type));
    this.startTicker();
    return this.code;
  }

  startTicker() {
    this.nextTick = performance.now() + TICK_MS;
    const run = () => {
      if (this.closed) return;
      const now = performance.now();
      let n = 0;
      while (now >= this.nextTick && n < 8) { this.room.tick(); this.nextTick += TICK_MS; n++; }
      if (now - this.nextTick > 250) this.nextTick = now + TICK_MS;
      if (++this.watch % 250 === 0) this.dropSilentGuests(now);
    };
    this.watch = 0;
    try {
      const src = 'setInterval(() => postMessage(0), 4);';
      this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.worker.onmessage = run;
    } catch {
      this.interval = setInterval(run, 4);
    }
  }

  accept(conn) {
    const client = {
      id: this.nextId++, room: null, profile: sanitizeProfile(null), conn, dc: null, lastSeen: performance.now(),
      sendText: (s) => { if (conn.open) { try { conn.send(s); } catch { /* closed */ } } },
      sendBinary: (b) => {
        const dc = client.dc;
        if (dc && dc.readyState === 'open' && dc.bufferedAmount < 256 * 1024) { try { dc.send(b); } catch { /* closed */ } }
      },
    };
    conn.on('open', () => {
      if (this.closed || this.room.members.size >= MAX_MEMBERS) {
        client.sendText(JSON.stringify({ t: 'error', text: this.closed ? 'Room closed' : 'Room is full' }));
        setTimeout(() => conn.close(), 300);
        return;
      }
      this.guests.add(client);
      client.dc = openGameChannel(conn.peerConnection, (ab) => this.binary(client, ab));
      client.sendText(JSON.stringify({ t: 'welcome', id: client.id, p2p: true }));
    });
    conn.on('data', (d) => this.text(client, d));
    conn.on('close', () => this.drop(client));
    conn.on('error', () => this.drop(client));
  }

  text(client, raw) {
    let msg = raw;
    if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { return; } }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      if (msg.t === 'hello' || msg.t === 'profile') {
        client.profile = sanitizeProfile(msg.profile);
        if (!client.room) { this.room.join(client); return; }
      }
      if (msg.t === 'leave') { client.sendText(JSON.stringify({ t: 'left' })); this.drop(client); return; }
      if (client.room) this.room.handleText(client, msg);
    } catch (e) { console.error('[host] message failed', msg.t, e); }
  }

  binary(client, data) {
    client.lastSeen = performance.now();
    try {
      const dv = toView(data);
      const type = dv.getUint8(0);
      if (type === MSG.PING && dv.byteLength >= 9) {
        client.sendBinary(encodePong(dv.getFloat64(1), this.room.world.tick, 0));
      } else if (type === MSG.INPUT && client.room) {
        const m = this.room.members.get(client.id);
        if (m) this.room.onInput(m, dv);
      }
    } catch { /* malformed packet */ }
  }

  drop(client) {
    if (!this.guests.has(client) && !client.room) return;
    this.guests.delete(client);
    if (client.room) this.room.leave(client);
    try { if (client.dc) client.dc.close(); } catch { /* ignore */ }
    try { client.conn.close(); } catch { /* ignore */ }
  }

  // a guest whose browser vanished without closing the connection
  dropSilentGuests(now) {
    for (const g of this.guests) if (now - g.lastSeen > 20000) this.drop(g);
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    if (this.worker) this.worker.terminate();
    clearInterval(this.interval);
    for (const g of [...this.guests]) {
      g.sendText(JSON.stringify({ t: 'error', text: 'The host closed the room' }));
      this.drop(g);
    }
    setTimeout(() => { try { this.peer.destroy(); } catch { /* ignore */ } }, 200);
  }
}

// The hosting player's own client: an in-memory loopback into the Room.
export class LocalNet extends Transport {
  constructor(host) {
    super('local');
    this.host = host;
    this.client = {
      id: 1, room: null, profile: sanitizeProfile(null), lastSeen: Infinity,
      sendText: (s) => queueMicrotask(() => { if (this.connected) this.emit('msg', JSON.parse(s)); }),
      sendBinary: (b) => {
        const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        queueMicrotask(() => { if (this.connected) this.onBinary(ab); });
      },
    };
  }

  connect() {
    this.connected = true;
    queueMicrotask(() => {
      this.emit('msg', { t: 'welcome', id: this.client.id, p2p: true, host: true });
      this.emit('open');
      this.schedulePing(0);
    });
  }

  send(obj) { queueMicrotask(() => this.host.text(this.client, obj)); }

  sendBinary(buf) {
    this.bytesOut += buf.byteLength;
    const ab = buf instanceof ArrayBuffer ? buf.slice(0) : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    queueMicrotask(() => this.host.binary(this.client, ab));
  }

  close() {
    if (!this.connected) return;
    this.connected = false;
    this.stopPing();
    this.host.destroy();
    this.emit('close', { wasOpen: true });
  }
}

// ---------------------------------------------------------------- guest

export class PeerNet extends Transport {
  constructor(code) {
    super('webrtc p2p');
    this.code = String(code).toUpperCase();
    this.done = false;
    this.lastRecv = 0;
  }

  async connect() {
    try {
      const Peer = await loadPeer();
      this.peer = await openPeer(Peer, guestId(this.code));
      const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'raw' });
      this.conn = conn;
      const timer = setTimeout(() => this.fail('Could not reach the host (a strict firewall can block peer-to-peer).'), 20000);
      conn.on('open', () => {
        clearTimeout(timer);
        this.dc = openGameChannel(conn.peerConnection, (ab) => this.onBinary(ab));
        this.connected = true;
        this.lastRecv = performance.now();
        this.emit('open');
        this.schedulePing(0);
        this.watchdog = setInterval(() => {
          if (performance.now() - this.lastRecv > 8000) this.fail('Lost connection to the host');
        }, 1000);
      });
      conn.on('data', (d) => {
        if (typeof d !== 'string') return;
        this.bytesIn += d.length;
        let msg;
        try { msg = JSON.parse(d); } catch { return; }
        this.emit('msg', msg);
      });
      conn.on('close', () => this.closed());
      conn.on('error', () => this.closed());
      this.peer.on('error', (e) => {
        if (e.type === 'peer-unavailable') this.fail('Room not found – is the host still online?');
        else if (!this.connected) this.fail(`Connection failed (${e.type})`);
      });
    } catch (e) {
      this.fail(`Could not start peer-to-peer (${e.type || e.message})`);
    }
  }

  onBinary(ab) {
    this.lastRecv = performance.now();
    super.onBinary(ab);
  }

  fail(text) {
    if (this.done) return;
    this.emit('msg', { t: 'error', text });
    this.closed();
  }

  closed() {
    if (this.done) return;
    this.done = true;
    const wasOpen = this.connected;
    this.connected = false;
    this.stopPing();
    clearInterval(this.watchdog);
    try { if (this.dc) this.dc.close(); } catch { /* ignore */ }
    try { if (this.peer) this.peer.destroy(); } catch { /* ignore */ }
    this.emit('close', { wasOpen });
  }

  send(obj) {
    if (!this.conn || !this.conn.open) return;
    const s = JSON.stringify(obj);
    this.bytesOut += s.length;
    try { this.conn.send(s); } catch { /* closed */ }
  }

  sendBinary(buf) {
    this.bytesOut += buf.byteLength;
    const dc = this.dc;
    if (dc && dc.readyState === 'open' && dc.bufferedAmount < 64 * 1024) { try { dc.send(buf); } catch { /* closed */ } }
  }

  close() {
    try { if (this.conn) this.conn.close(); } catch { /* ignore */ }
    this.closed();
  }
}
