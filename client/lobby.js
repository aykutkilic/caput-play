// The public room list (the Worker's Lobby, cloud/src/lobby.js).
//
//  * A room open to others is listed while its host is online: the host keeps
//    a socket to the Lobby and sends its room's line (name, people, password
//    or not, match on) only when that changes – at most every SEND_GAP.
//  * The list is fetched only when a player opens it. A warm-up or a match
//    against the AI never touches the network.
//  * The Lobby also keeps the people playing online under a cap: when it's
//    reached no new rooms open, and hosts turn new guests away until there's
//    room again.
//
// Without the Worker configured (client/cloud.js) there is no list: rooms
// are joined by code or invite link.

import { cloudUrl, cloudEndpoint } from './cloud.js';

const PING_MS = 45000;  // keeps the socket alive (answered without waking the Lobby)
const SEND_GAP = 2000;  // ms between two updates of a room's line (each wakes the Lobby)
const RETRY_MS = [3000, 10000, 30000, 60000];

export const lobbyAvailable = () => !!cloudUrl();

// The rooms: { players, cap, full, rooms: [{ code, name, players, max, locked, live, country, km }] }
export async function fetchRooms() {
  const base = cloudUrl();
  if (!base) throw new Error('no room list here');
  const res = await fetch(cloudEndpoint(base, 'rooms'), { cache: 'no-store' });
  if (!res.ok) throw new Error(`room list: ${res.status}`);
  return res.json();
}

// (developer mode) people online by hour and place over the last `days`
export async function fetchStats(days) {
  const base = cloudUrl();
  if (!base) throw new Error('no stats here');
  const u = cloudEndpoint(base, 'stats');
  u.searchParams.set('days', String(days));
  const res = await fetch(u, { cache: 'no-store' });
  if (!res.ok) throw new Error(`stats: ${res.status}`);
  return res.json();
}

// The host of this room sent us out: towards its "kicks a lot" in the list
// (each network counts once).
export function reportKick(code) {
  const base = cloudUrl();
  if (!base || !/^[A-Z]{4}$/.test(code || '')) return;
  const u = cloudEndpoint(base, 'kicked');
  u.searchParams.set('room', code);
  fetch(u, { cache: 'no-store' }).catch(() => { /* only a hint */ });
}

// A hosted room's place in the list.
export class LobbyLink {
  constructor() {
    this.ws = null;
    this.full = false;  // online play is full: turn new guests away
    this.cap = 0;
    this.closed = false;
    this.line = null;   // the room as it should be listed
    this.sent = '';     // ... as the Lobby last heard it
    this.sentAt = 0;
    this.timer = 0;
    this.tries = 0;
  }

  // Resolves to 'ok' (listed), 'full' (online play is full: don't open the
  // room), 'busy' (too many rooms from this network) or 'none' (no Lobby, or
  // it can't be reached) – in the last two the room opens unlisted.
  open() {
    const base = cloudUrl();
    if (!base || this.closed) return Promise.resolve('none');
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r) => { if (!settled) { settled = true; clearTimeout(wait); resolve(r); } };
      const wait = setTimeout(() => { settle('none'); this.drop(); this.again(); }, 6000);
      const u = cloudEndpoint(base, 'lobby');
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try { ws = new WebSocket(u); } catch { settle('none'); return; }
      this.ws = ws;
      ws.onmessage = (e) => {
        if (ws !== this.ws || e.data === 'pong') return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'ok') {
          this.full = !!m.full; this.cap = m.cap || 0; this.tries = 0;
          this.sent = '';
          this.ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, PING_MS);
          this.flush();
          settle('ok');
        } else if (m.t === 'refused') {
          this.cap = m.cap || 0;
          if (m.why === 'full') this.full = true;
          settle(m.why === 'full' ? 'full' : 'busy');
        } else if (m.t === 'full') this.full = !!m.full;
      };
      ws.onclose = () => {
        if (ws !== this.ws) return;
        clearInterval(this.ping);
        this.ws = null;
        settle('none');
        this.again();
      };
    });
  }

  // lost the Lobby (a network blip, a Worker update): back in a moment,
  // spread out so the hosts don't all return at once
  again() {
    if (this.closed) return;
    const ms = RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)] * (0.6 + Math.random() * 0.8);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.open(), ms);
  }

  // the room's line in the list; sent when it changed
  update(line) {
    this.line = line;
    this.flush();
  }

  flush() {
    clearTimeout(this.timer);
    const ws = this.ws;
    if (!this.line || !ws || ws.readyState !== 1) return;
    const s = JSON.stringify({ t: 'room', ...this.line });
    if (s === this.sent) return;
    const wait = this.sentAt + SEND_GAP - Date.now();
    if (wait > 0) { this.timer = setTimeout(() => this.flush(), wait); return; }
    try { ws.send(s); this.sent = s; this.sentAt = Date.now(); } catch { /* closing */ }
  }

  drop() {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.ping);
    if (ws) { try { ws.close(1000, 'bye'); } catch { /* ignore */ } }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.retry);
    this.drop();
  }
}
