import { Net } from './net.js';
import { HostSession, PeerNet } from './p2p.js';
import { CLOUD_URL } from './cloud.js';
import { NetGame } from './netgame.js';
import { Input, DEFAULT_KEYS, ACTION_LABELS, keyName, isTyping } from './input.js';
import { Renderer, CAMERAS, lookFor, drawAvatarPreview, TEAM_COLORS } from './render.js';
import { Sfx, CHANNELS } from './audio.js';
import { TouchControls, isTouchDevice, lockZoom } from './touch.js';
import { Replay } from './replay.js';
import { initPwa } from './pwa.js';
import { encodeStick, pById, wantsBlock, inOwnBox, pitchOf, keeperHands } from '../shared/sim.js';
import { PHASE, SP, SP_NAME, ROLE, TEAM_NAMES, TICK_RATE, QUICK_CHAT, KICK_MASK, GOAL_SIZE_DEFAULT } from '../shared/constants.js';
import { ratings, stats } from '../shared/physique.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ profile

const SKINS = ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#a26b45', '#8d5524', '#5c3a21'];
const HAIR_STYLES = ['Bald', 'Short', 'Buzz', 'Long', 'Afro', 'Mohawk', 'Ponytail', 'Bun', 'Curly', 'Side part', 'Bob', 'Braids'];
const BEARDS = ['None', 'Stubble', 'Beard', 'Moustache', 'Goatee'];
const HAIR_COLS = ['#1b1b1b', '#3b2416', '#6b4423', '#a0662f', '#d9b25f', '#e8d9a8', '#9c9c9c', '#b5532d', '#3d6fd1', '#d94c8a'];
const BOOTS = ['#111111', '#f5f5f5', '#e5483b', '#2f6be0', '#f2c230', '#3fd08f', '#ff8a00', '#b05cff'];

function defaultProfile() {
  const r = (a) => a[(Math.random() * a.length) | 0];
  return {
    name: 'Player' + ((Math.random() * 900 + 100) | 0),
    avatar: (() => {
      const sex = Math.random() < 0.5 ? 1 : 0;
      return { sex, skin: r(SKINS), hair: sex ? r([3, 6, 7, 10, 11]) : 1 + ((Math.random() * 7) | 0), hairColor: r(HAIR_COLS.slice(0, 7)), boots: r(BOOTS), number: 2 + ((Math.random() * 20) | 0), phys: { h: sex ? 168 : 178, b: 45 } };
    })(),
  };
}
function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('caput.profile') || 'null');
    if (p && p.avatar && p.avatar.phys) return p;
  } catch { /* ignore */ }
  const p = defaultProfile();
  saveProfile(p);
  return p;
}
function saveProfile(p) { try { localStorage.setItem('caput.profile', JSON.stringify(p)); } catch { /* ignore */ } }
function buildWord(b) { return b < 25 ? 'lean' : b < 50 ? 'athletic' : b < 75 ? 'sturdy' : 'heavy'; }

// ------------------------------------------------------------------ state

const params = new URLSearchParams(location.search);
// static hosting (no dedicated game server to probe): GitHub Pages, or the
// Cloudflare Worker serving the game itself
const STATIC_HOST = /\.github\.io$/i.test(location.hostname) || CLOUD_URL === 'self';

const state = {
  profile: loadProfile(),
  clientId: -1,
  room: null,
  inRoom: false,
  myId: -1,
  names: new Map(),
  avatars: new Map(),
  lookCache: new Map(),
  lastPhase: -1,
  lastRoomCode: null,
  wantJoin: params.get('room'),
  joining: false,  // (server) asked to join a room after (re)connecting
  roomNet: null,   // the transport the current room came through
  // 'server': a dedicated game server is reachable; 'p2p': rooms are hosted in a player's browser
  mode: params.has('p2p') || STATIC_HOST ? 'p2p' : 'server',
  everConnected: false,
  host: null,
  busy: false,
  bubbles: new Map(), // playerId -> quick-chat speech bubble
  showNet: false,
};
try { state.showNet = localStorage.getItem('caput.net') === '1'; } catch { /* ignore */ }

let net = null; // active transport
const game = new NetGame(null);
const input = new Input();
const renderer = new Renderer($('game'));
const sfx = new Sfx();
try { renderer.setPreset(localStorage.getItem('caput.cam') || 'iso'); renderer.zoom = Number(localStorage.getItem('caput.zoom')) || 1; } catch { renderer.setPreset('iso'); }

const replay = new Replay();
if (params.has('debug')) window.caput = { game, state, renderer, input }; // (for tests and poking around)
const NO_OFFSETS = new Map();
let lastButtons = 0;

game.sampleInput = () => {
  const s = input.sample();
  // a fresh press of an action button skips the replay (not movement/sprint held from play)
  const kick = s.b & KICK_MASK;
  if (kick && kick !== (lastButtons & KICK_MASK) && (replay.active || state.replayAt)) skipReplay();
  lastButtons = s.b;
  const [wx, wy] = renderer.cam.screenDirToWorld(s.x, s.y);
  const [a, m] = encodeStick(wx, wy, s.mag);
  return { a, m, b: s.b };
};

// ------------------------------------------------------------------ networking

function send(obj) { if (net) net.send(obj); }

function inviteQuery(code) {
  return `?room=${code}${params.has('p2p') && !STATIC_HOST ? '&p2p=1' : ''}`;
}

// Wires a transport (dedicated server, serverless host loopback or serverless
// guest) to the game. Only the current transport's events are honoured. A
// deferred one (joining someone's room) takes over once it's connected, so
// the warm-up goes on meanwhile – and does if it fails.
function useTransport(t, onOpen, onClose, deferred = false) {
  if (!deferred) activate(t);
  t.on('open', () => {
    if (deferred) activate(t);
    if (net !== t) return;
    t.send({ t: 'hello', profile: state.profile });
    if (onOpen) onOpen();
  });
  t.on('close', (info) => onClose(info || {}));
  t.on('snap', (snap) => { if (net === t && state.inRoom) game.onSnapshot(snap); });
  t.on('msg', (msg) => {
    if (net !== t) { if (msg.t === 'error') toast(msg.text); return; }
    switch (msg.t) {
      case 'welcome': state.clientId = msg.id; break;
      case 'rooms': renderRoomList(msg.rooms); break;
      case 'room': onRoom(msg); break;
      case 'chat':
        addChat(msg.from, msg.text);
        if (msg.pid >= 0) { state.bubbles.set(msg.pid, { text: msg.text, until: performance.now() + 2500 }); sfx.chat(); }
        break;
      case 'error':
        toast(msg.text);
        t.said = true; // (no second toast if this is the end of the connection)
        // couldn't get back into a room after reconnecting: a fresh one of your own
        if (state.mode === 'server' && state.joining && !state.inRoom) send({ t: 'create' });
        state.joining = false;
        break;
      case 'left': leaveRoomUi(); break;
    }
  });
}

// Makes t the transport the game talks through. The room this tab was
// hosting (the solo warm-up) closes when another one takes over.
function activate(t) {
  const prev = net;
  net = t;
  game.net = t;
  if (!prev || prev === t) return;
  if (state.host && prev === state.host.local) { state.host = null; prev.close(); }
  // nothing from the old room any more; the new one starts with its 'room' message
  state.inRoom = false;
  game.reset();
}

function connectServer() {
  const t = new Net();
  useTransport(t, () => {
    state.everConnected = true;
    t.send({ t: 'list' });
    // straight into a room: the one you were invited to (or were in), else your own
    const code = state.wantJoin || state.lastRoomCode;
    state.wantJoin = null;
    state.joining = !!code;
    t.send(code ? { t: 'join', code } : { t: 'create' });
  }, ({ wasOpen }) => {
    if (net !== t) return;
    // nothing listening on /ws (static hosting): switch to serverless rooms
    if (!wasOpen && !state.everConnected) { enterP2PMode(); return; }
    if (state.inRoom) toast('Disconnected – reconnecting…');
    leaveRoomUi(true);
    setTimeout(connectServer, 1500);
  });
  t.connect();
}

function enterP2PMode() {
  state.mode = 'p2p';
  net = null;
  startSolo();
  if (state.wantJoin) { const c = state.wantJoin; state.wantJoin = null; joinPeer(c); }
  else banner('CAPUT', 'Warm up · create a room to play with friends');
}

// Your own room, run in this tab and offline: you warm up (or play the AI)
// until you open it to friends or join someone else's.
function startSolo() {
  const host = new HostSession();
  host.startLocal(`${state.profile.name}'s room`);
  state.host = host;
  const t = host.local;
  useTransport(t, null, () => {
    if (net !== t) return;
    state.host = null;
    leaveRoomUi();
  });
  t.connect();
}

// Opens the room you're in to others: it gets a code and an invite link,
// and everything on the pitch carries on.
async function openRoom() {
  const host = state.host;
  if (!host || host.online || state.busy) return;
  state.busy = true;
  setFriendsStatus('Opening the room…');
  try {
    await host.goOnline($('newRoomName').value.trim() || `${state.profile.name}'s room`);
  } catch (e) {
    toast(`Could not open a room (${e.type || e.message}) – check your connection`);
    return;
  } finally {
    state.busy = false;
    setFriendsStatus('');
  }
  const url = `${location.origin}${location.pathname}${inviteQuery(host.code)}`;
  try { await navigator.clipboard.writeText(url); toast(`Room ${host.code} is open – link copied, or send it on WhatsApp`); } catch { toast(`Room ${host.code} is open – invite: ${url}`); }
}

function joinPeer(code) {
  if (state.busy) return;
  state.busy = true;
  setFriendsStatus(`Connecting to room ${code}…`);
  const t = new PeerNet(code);
  const done = () => { state.busy = false; setFriendsStatus(''); };
  useTransport(t, done, ({ wasOpen }) => {
    done();
    if (net !== t) return;
    if (wasOpen && state.inRoom && !t.said) toast('Disconnected from the host');
    leaveRoomUi();
  }, true);
  t.connect();
}

if (state.mode === 'server') connectServer(); else enterP2PMode();

// the server's room list, while the panel shows it
setInterval(() => { if (state.mode === 'server' && net && net.connected && !$('panel').hidden) net.send({ t: 'list' }); }, 3000);

// ------------------------------------------------------------------ play with friends

function setFriendsStatus(text) { $('friendsStatus').textContent = text; }

// (dedicated server only) the other rooms you could join
function renderRoomList(rooms) {
  const ul = $('roomList');
  rooms = rooms.filter((r) => !state.room || r.code !== state.room.code);
  ul.innerHTML = rooms.map((r) => `
    <li><div><div class="rn">${esc(r.name)} <span class="muted">· ${r.code}</span></div>
    <div class="rm">${r.humans} player${r.humans === 1 ? '' : 's'}${r.ai ? ` · ${r.ai} AI` : ''}${r.live ? ` · LIVE ${r.score[0]}–${r.score[1]}` : ' · warm-up'}</div></div>
    <button data-code="${r.code}">Join</button></li>`).join('');
}
$('roomList').addEventListener('click', (e) => {
  const code = e.target.dataset && e.target.dataset.code;
  if (code) { sfx.unlock(); send({ t: 'join', code }); }
});
$('createBtn').onclick = () => { sfx.unlock(); openRoom(); $('createBtn').blur(); };
$('newRoomName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('createBtn').click(); });
$('joinBtn').onclick = () => {
  sfx.unlock();
  const c = $('joinCode').value.trim().toUpperCase();
  if (!c) return;
  $('joinCode').value = '';
  $('joinBtn').blur();
  if (state.mode === 'p2p') joinPeer(c); else send({ t: 'join', code: c });
};
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
addEventListener('beforeunload', (e) => {
  // closing the tab ends a hosted room for everyone in it
  if (state.host && state.room && state.room.members.length > 1) { e.preventDefault(); e.returnValue = ''; }
});

// ------------------------------------------------------------------ room

function onRoom(msg) {
  // a room of its own when the transport changes or it's another server room
  // (not when the one you host opens to others or closes again)
  const first = !state.inRoom || state.roomNet !== net || (state.room && state.room.code !== msg.code && state.room.code && msg.code);
  // a chime when someone joins or leaves
  if (!first && state.room) {
    const before = state.room.members.length, after = msg.members.length;
    if (after > before) sfx.joined(); else if (after < before) sfx.left();
  }
  state.room = msg;
  state.lastRoomCode = msg.code || null;
  state.joining = false;
  const query = msg.code ? inviteQuery(msg.code) : '';
  if (location.search !== query) history.replaceState(null, '', query || location.pathname);
  if (first) {
    state.inRoom = true;
    state.roomNet = net;
    game.reset();
    state.lastPhase = -1;
    $('hud').hidden = false;
    $('chatlog').innerHTML = '';
    // your own warm-up starts with the pitch clear (the pill opens the panel)
    let minimized = !msg.code || msg.members.length === 1;
    try { minimized ||= localStorage.getItem('caput.panel') === 'min'; } catch { /* ignore */ }
    showPanel(!minimized, false);
    touch.setVisible(state.touchUI);
  }
  const me = msg.members.find((m) => m.id === state.clientId);
  state.myId = me ? me.playerId : -1;
  game.myId = state.myId;
  state.names.clear(); state.avatars.clear();
  for (const m of msg.members) if (m.playerId >= 0) { state.names.set(m.playerId, m.name); state.avatars.set(m.playerId, m.avatar); }
  for (const a of msg.ai) { state.names.set(a.playerId, a.name); state.avatars.set(a.playerId, a.avatar); }
  state.lookCache.clear();
  renderPanel();
}

// Out of a room: back to a warm-up of your own (unless the server connection
// dropped – reconnecting takes you back in).
function leaveRoomUi(keepCode = false) {
  state.inRoom = false;
  state.room = null;
  state.roomNet = null;
  if (!keepCode) state.lastRoomCode = null;
  state.myId = -1;
  game.reset();
  $('hud').hidden = true;
  showPanel(false);
  touch.setVisible(false);
  state.bubbles.clear();
  replay.stop(); state.replayAt = 0;
  if (pwa.updateReady) pwa.apply(); // a newer version was announced during the match
  if (!keepCode) history.replaceState(null, '', location.pathname);
  if (state.mode === 'p2p') startSolo();
  else if (!keepCode && net && net.connected) send({ t: 'create' });
}

// The room panel can be minimized to a small pill; the choice is remembered.
function showPanel(on, remember = true) {
  $('panel').hidden = !on;
  $('panelPill').hidden = on || !state.inRoom;
  if (on && state.mode === 'server' && net && net.connected) net.send({ t: 'list' });
  if (remember && state.inRoom) { try { localStorage.setItem('caput.panel', on ? 'open' : 'min'); } catch { /* ignore */ } }
}
$('minBtn').onclick = () => showPanel(false);
$('panelPill').onclick = () => showPanel(true);
// a click or tap anywhere outside the open panel (not in a dialog over it) tucks it away
addEventListener('pointerdown', (e) => {
  if (!state.inRoom || $('panel').hidden) return;
  if (e.target.closest && e.target.closest('#panel, #panelPill, .modal, #updateBtn, #toast')) return;
  showPanel(false);
}, true);

function renderPanel() {
  const r = state.room;
  if (!r) return;
  const isHost = r.hostId === state.clientId;
  const p2p = state.mode === 'p2p', offline = !r.code; // your own warm-up, not open to anyone yet
  const alone = r.members.length === 1;
  $('roomName').textContent = offline ? 'Warm-up' : r.name;
  $('roomCode').textContent = r.code;
  $('codeBit').hidden = offline;
  $('inviteRow').hidden = offline;
  $('pillName').textContent = offline ? 'Warm-up · Play with friends' : r.name;
  $('pillCode').textContent = r.code;
  const where = !p2p ? '' : state.host ? ' · hosted in this tab – keep it open' : ' · peer-to-peer';
  $('roomStatus').textContent = offline ? `${r.live ? 'Match in progress' : 'Just you'} · offline` : (r.live ? 'Match in progress' : 'Warm-up') + where;
  // play with friends: open this room to them or join theirs (from the
  // server's list or by code) – from your own warm-up
  $('friends').hidden = p2p ? !offline : !alone;
  $('p2pInfo').hidden = !p2p;
  $('createRow').hidden = !p2p;
  // leaving: closing the room you host takes it offline (you play on);
  // leaving someone else's takes you back to a warm-up of your own
  $('leaveBtn').hidden = p2p ? offline : alone;
  $('leaveBtn').textContent = state.host ? 'Close room' : 'Leave';
  $('leaveBtn').title = state.host ? 'Sends everyone else back to their own warm-up – you play on' : '';
  for (const col of document.querySelectorAll('.teamcol')) {
    const team = Number(col.dataset.team);
    const rows = [];
    for (const m of r.members.filter((x) => x.team === team)) {
      rows.push(`<li class="${m.id === state.clientId ? 'me' : ''}">${esc(m.name)}${m.role === ROLE.GK ? ' <span class="tagx gk">GK</span>' : ''}${m.id === r.hostId ? ' <span class="host">★</span>' : ''}${m.id === state.clientId ? ' <span class="muted">(you)</span>' : ''}</li>`);
    }
    for (const a of r.ai.filter((x) => x.team === team)) {
      rows.push(`<li><span class="muted">${esc(a.name)}</span> <span class="tagx${a.role === ROLE.GK ? ' gk' : ''}">${a.role === ROLE.GK ? 'GK' : 'AI'}</span><button class="x" data-rm="${a.playerId}" title="Remove">×</button></li>`);
    }
    col.querySelector('ul').innerHTML = rows.join('') || '<li class="muted">empty</li>';
  }
  const specs = r.members.filter((m) => m.team === -1).map((m) => esc(m.name));
  $('specList').innerHTML = specs.length ? specs.join(', ') : '–';
  $('matchLen').value = String(r.settings.matchLen);
  $('pitchSel').value = String(r.settings.pitch);
  $('goalSel').value = String(r.settings.goals ?? GOAL_SIZE_DEFAULT);
  $('aiSel').value = String(r.settings.ai ?? 1);
  $('aiSexSel').value = String(r.settings.aiSex ?? 0);
  $('matchLen').disabled = $('pitchSel').disabled = $('aiSel').disabled = $('aiSexSel').disabled = !isHost;
  // the goals can't be resized during a match
  $('goalSel').disabled = !isHost || !!(game.world && game.world.m.live);
  $('startBtn').disabled = !isHost;
  $('startBtn').textContent = r.live ? 'End match' : 'Start match';
  const host = r.members.find((m) => m.id === r.hostId);
  $('hostNote').textContent = isHost ? '(you are host)' : host ? `(host: ${host.name})` : '';
}

document.querySelector('.teams').addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset.rm) { send({ t: 'removeAI', id: Number(t.dataset.rm) }); return; }
  const act = t.dataset.act;
  if (!act) return;
  const team = Number(t.closest('.teamcol').dataset.team), role = Number(t.dataset.role);
  if (act === 'join') send({ t: 'team', team, role });
  else if (act === 'ai') send({ t: 'addAI', team, role });
  t.blur();
});
$('spectate').onclick = () => send({ t: 'team', team: -1, role: 0 });
$('matchLen').onchange = () => send({
  t: 'settings', matchLen: Number($('matchLen').value), pitch: $('pitchSel').value,
  goals: Number($('goalSel').value), ai: Number($('aiSel').value), aiSex: Number($('aiSexSel').value),
});
$('pitchSel').onchange = $('goalSel').onchange = $('aiSel').onchange = $('aiSexSel').onchange = $('matchLen').onchange;
$('startBtn').onclick = () => { send({ t: state.room && state.room.live ? 'stop' : 'start' }); $('startBtn').blur(); };
$('leaveBtn').onclick = () => {
  if (state.host) state.host.goOffline();
  else if (state.mode === 'p2p') { if (net) { net.said = true; net.close(); } } else send({ t: 'leave' });
  $('leaveBtn').blur();
};
// Inviting friends: the room's link on WhatsApp, through the device's share
// sheet (phones), or copied.
function inviteUrl() { return `${location.origin}${location.pathname}${inviteQuery(state.room ? state.room.code : '')}`; }
function inviteText() { return `Come and play football with me on CAPUT – room ${state.room ? state.room.code : ''}: ${inviteUrl()}`; }
$('copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText(inviteUrl()); toast('Invite link copied'); } catch { toast(inviteUrl()); }
};
$('waBtn').onclick = () => {
  // wa.me opens the WhatsApp app on a phone, WhatsApp Web / Desktop on a computer
  window.open(`https://wa.me/?text=${encodeURIComponent(inviteText())}`, '_blank', 'noopener');
};
$('shareBtn').hidden = !navigator.share;
$('shareBtn').onclick = async () => {
  try { await navigator.share({ title: 'CAPUT', text: inviteText(), url: inviteUrl() }); } catch { /* cancelled */ }
};
for (const [k, c] of Object.entries(CAMERAS)) $('camSel').insertAdjacentHTML('beforeend', `<option value="${k}">${c.name}</option>`);
$('camSel').value = renderer.preset;
$('camSel').onchange = () => { renderer.setPreset($('camSel').value); try { localStorage.setItem('caput.cam', renderer.preset); } catch { /* ignore */ } $('camSel').blur(); };
$('zoom').value = String(renderer.zoom);
$('zoom').oninput = () => { renderer.zoom = Number($('zoom').value); try { localStorage.setItem('caput.zoom', String(renderer.zoom)); } catch { /* ignore */ } };
// mixer: the same controls in the room panel and on the home screen
function renderMixers() {
  for (const el of document.querySelectorAll('.mixer')) {
    el.innerHTML = `<label class="check"><input type="checkbox" data-mute ${sfx.muted ? '' : 'checked'}> Sound on</label>`
      + CHANNELS.map(([k, name]) => `<label class="mix">${name}<input type="range" min="0" max="100" step="1" data-ch="${k}" value="${Math.round(sfx.mix[k] * 100)}"></label>`).join('');
  }
}
function syncMixers() {
  for (const el of document.querySelectorAll('.mixer')) {
    el.querySelector('[data-mute]').checked = !sfx.muted;
    for (const r of el.querySelectorAll('[data-ch]')) r.value = String(Math.round(sfx.mix[r.dataset.ch] * 100));
  }
}
renderMixers();
document.addEventListener('input', (e) => {
  const ch = e.target.dataset && e.target.dataset.ch;
  if (!ch || !e.target.closest('.mixer')) return;
  sfx.unlock();
  sfx.setVolume(ch, Number(e.target.value) / 100);
  syncMixers();
});
document.addEventListener('change', (e) => {
  if (!e.target.matches || !e.target.matches('.mixer [data-mute]')) return;
  sfx.unlock();
  sfx.setMuted(!e.target.checked);
  syncMixers();
});
// a soft click for buttons (not the in-game touch controls)
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button');
  if (b && !b.closest('#touch')) { sfx.unlock(); sfx.click(); }
});
$('netChk').checked = state.showNet;
$('netChk').onchange = () => { state.showNet = $('netChk').checked; try { localStorage.setItem('caput.net', state.showNet ? '1' : '0'); } catch { /* ignore */ } };

// ------------------------------------------------------------------ phones & tablets

// installable app + automatic updates (applied between matches, never during one)
const pwa = initPwa({
  // a match, others in the room or the player editor open: update afterwards
  busy: () => !!state.room && (state.room.live || state.room.members.length > 1) || !$('editor').hidden,
  onUpdateReady: () => { $('updateBtn').hidden = false; },
  onInstallable: (on) => { $('installBtn').hidden = !on || pwa.standalone; },
});
$('installBtn').onclick = () => pwa.install();
$('updateBtn').onclick = () => location.reload();
if (pwa.ios && !pwa.standalone) $('iosHint').hidden = false;
$('verTag').textContent = pwa.dev ? '' : `v${pwa.version}`;

// first touch on the controls: go fullscreen and landscape where the browser allows it
async function goFullscreen() {
  if (pwa.standalone) return; // the installed app already runs fullscreen
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch { /* not supported (e.g. iPhone Safari) */ }
}
lockZoom();
const touch = new TouchControls(input, () => { if (isTouchDevice()) goFullscreen(); });
state.touchUI = isTouchDevice();
try { const t = localStorage.getItem('caput.touch'); if (t !== null) state.touchUI = t === '1'; } catch { /* ignore */ }
$('touchChk').checked = state.touchUI;
$('touchChk').onchange = () => {
  state.touchUI = $('touchChk').checked;
  try { localStorage.setItem('caput.touch', state.touchUI ? '1' : '0'); } catch { /* ignore */ }
  touch.setVisible(state.inRoom && state.touchUI);
};
$('fsBtn').hidden = !document.fullscreenEnabled;
$('fsBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen(); else goFullscreen();
};

// ------------------------------------------------------------------ chat & toast

function addChat(from, text) {
  const log = $('chatlog');
  const div = document.createElement('div');
  if (from) div.innerHTML = `<b>${esc(from)}:</b> ${esc(text)}`;
  else { div.className = 'sys'; div.textContent = text; }
  log.appendChild(div);
  while (log.children.length > 8) log.removeChild(log.firstChild);
  setTimeout(() => { div.style.transition = 'opacity 1s'; div.style.opacity = '0.35'; }, 12000);
}
// quick chat: only the predefined lines (keys 1-5, or the chips / 💬 on touch)
$('quick').innerHTML = QUICK_CHAT.map((t, i) => `<button data-q="${i}"><kbd>${i + 1}</kbd>${esc(t)}</button>`).join('');
function quickChat(i) {
  if (!state.inRoom) return;
  send({ t: 'chat', id: i });
  document.body.classList.remove('quickopen');
}
$('quick').onclick = (e) => { const b = e.target.closest('button'); if (b) quickChat(Number(b.dataset.q)); };
$('quickToggle').onclick = () => document.body.classList.toggle('quickopen');

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function banner(text, sub = '', color = '#fff') {
  const b = $('banner');
  $('bannerText').textContent = text;
  $('bannerText').style.color = color;
  $('bannerSub').textContent = sub;
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
}

// ------------------------------------------------------------------ global keys

addEventListener('keydown', (e) => {
  sfx.unlock();
  if (rebinding) return;
  if (e.code === 'F1') { e.preventDefault(); toggleControls(); return; }
  if (e.code === 'F2') {
    // cycle the camera: isometric views, third person
    e.preventDefault();
    const names = Object.keys(CAMERAS), next = names[(names.indexOf(renderer.preset) + 1) % names.length];
    renderer.setPreset(next); $('camSel').value = next;
    try { localStorage.setItem('caput.cam', next); } catch { /* ignore */ }
    toast(`Camera: ${CAMERAS[next].name}`);
    return;
  }
  if (isTyping(e)) return;
  if (e.code === 'Escape') {
    if (!$('editor').hidden) { closeEditor(); return; }
    if (!$('controls').hidden) { toggleControls(false); return; }
    if (state.inRoom) showPanel($('panel').hidden);
    return;
  }
  if (!state.inRoom) return;
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit && !input.isBound(e.code) && Number(digit[1]) <= QUICK_CHAT.length) quickChat(Number(digit[1]) - 1);
  else if (e.code === 'Minus') setZoom(renderer.zoom - 0.1);
  else if (e.code === 'Equal') setZoom(renderer.zoom + 0.1);
  else if (e.code === 'KeyC' && !input.isBound('KeyC')) {
    const keys = Object.keys(CAMERAS);
    renderer.setPreset(keys[(keys.indexOf(renderer.preset) + 1) % keys.length]);
    $('camSel').value = renderer.preset;
    try { localStorage.setItem('caput.cam', renderer.preset); } catch { /* ignore */ }
  }
});
addEventListener('pointerdown', () => sfx.unlock());
// keep keyboard focus on the game after using the menus
addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') e.target.blur(); });
addEventListener('change', (e) => { if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') e.target.blur(); });
$('game').addEventListener('wheel', (e) => { setZoom(renderer.zoom * (e.deltaY > 0 ? 0.92 : 1.08)); e.preventDefault(); }, { passive: false });
function setZoom(z) {
  renderer.zoom = Math.min(1.8, Math.max(0.55, z));
  $('zoom').value = String(renderer.zoom);
  try { localStorage.setItem('caput.zoom', String(renderer.zoom)); } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { input.clear(); game.sendIdleFuture(); }
});

// ------------------------------------------------------------------ avatar editor

let draft = null, kit = 0;
function swatches(el, list, get, set) {
  el.innerHTML = list.map((c) => `<button style="background:${c}" data-v="${c}"></button>`).join('');
  const sync = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === get()));
  el.onclick = (e) => { if (e.target.dataset.v) { set(e.target.dataset.v); sync(); } };
  sync();
}
function openEditor() {
  draft = JSON.parse(JSON.stringify(state.profile));
  const a = draft.avatar;
  $('edName').value = draft.name;
  $('edNum').value = a.number;
  swatches($('edSkin'), SKINS, () => a.skin, (v) => { a.skin = v; });
  swatches($('edHairCol'), HAIR_COLS, () => a.hairColor, (v) => { a.hairColor = v; });
  swatches($('edBoots'), BOOTS, () => a.boots, (v) => { a.boots = v; });
  const hair = $('edHair');
  hair.innerHTML = HAIR_STYLES.map((n, i) => `<button data-i="${i}">${n}</button>`).join('');
  const syncHair = () => hair.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === a.hair));
  hair.onclick = (e) => { if (e.target.dataset.i) { a.hair = Number(e.target.dataset.i); syncHair(); } };
  syncHair();
  const beard = $('edBeard');
  beard.innerHTML = BEARDS.map((n, i) => `<button data-i="${i}">${n}</button>`).join('');
  const syncBeard = () => beard.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === (a.beard || 0)));
  beard.onclick = (e) => { if (e.target.dataset.i) { a.beard = Number(e.target.dataset.i); syncBeard(); } };
  syncBeard();
  // man or woman: the look only – height and build set the attributes, as for anyone
  const sexEl = $('edSex');
  sexEl.innerHTML = ['Man', 'Woman'].map((n, i) => `<button data-i="${i}">${n}</button>`).join('');
  const syncSex = () => {
    sexEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === (a.sex || 0)));
    $('edBeardLbl').hidden = $('edBeard').hidden = a.sex === 1;
  };
  sexEl.onclick = (e) => {
    if (!e.target.dataset.i) return;
    a.sex = Number(e.target.dataset.i);
    if (a.sex === 1) { a.beard = 0; syncBeard(); }
    syncSex();
  };
  syncSex();
  $('edH').value = a.phys.h; $('edB').value = a.phys.b;
  updatePhys();
  $('editor').hidden = false;
}
function updatePhys() {
  const a = draft.avatar;
  a.phys.h = Number($('edH').value); a.phys.b = Number($('edB').value);
  const s = stats(a.phys.h, a.phys.b);
  $('edHval').textContent = `${a.phys.h} cm`;
  $('edBval').textContent = `${Math.round(s.mass)} kg · ${buildWord(a.phys.b)}`;
  $('edStats').innerHTML = ratings(a.phys.h, a.phys.b).map(([n, v]) =>
    `<div class="stat"><span>${n}</span><div class="bar"><i style="width:${v}%"></i></div><span>${v}</span></div>`).join('');
}
$('edH').oninput = updatePhys;
$('edB').oninput = updatePhys;
$('edName').oninput = () => { draft.name = $('edName').value; };
$('edNum').oninput = () => { draft.avatar.number = Math.max(1, Math.min(99, Number($('edNum').value) || 1)); };
document.querySelector('.kitswitch').onclick = (e) => {
  if (e.target.dataset.kit === undefined) return;
  kit = Number(e.target.dataset.kit);
  document.querySelectorAll('.kitswitch button').forEach((b) => b.classList.toggle('ghost', Number(b.dataset.kit) !== kit));
};
function closeEditor() { $('editor').hidden = true; draft = null; }
$('edCancel').onclick = closeEditor;
$('edSave').onclick = () => {
  draft.name = (draft.name || '').trim().slice(0, 16) || 'Player';
  state.profile = draft;
  saveProfile(draft);
  send({ t: 'profile', profile: draft });
  closeEditor();
};
$('editBtn2').onclick = openEditor;

// How excited the crowd is: the ball near a goal, more so in a real match.
function crowdLevel(w, auth) {
  if (!w || !auth) return 0;
  if (auth.m.phase !== PHASE.PLAY) return 0.25;
  const L = pitchOf(w).L / 2, b = w.ball;
  const d = Math.min(Math.hypot(b.x - L, b.y), Math.hypot(b.x + L, b.y));
  return Math.min(1, Math.max(0, (24 - d) / 16)) * (auth.m.live ? 1 : 0.6);
}

// ------------------------------------------------------------------ context controls

// What the kick keys do right now: attacking, defending (press / slide /
// jockey / keeper out), as the keeper, or blocking a hard ball coming in.
let bendHintUntil = 0; // after my shot: how to bend it (see showControlMode)
function controlMode(w) {
  const me = w && pById(w, state.myId);
  if (!me) return 'attack';
  if (performance.now() < bendHintUntil && w.ball.owner < 0) return 'after';
  if (w.m.spTaker === me.id) return w.m.spType === SP.THROWIN ? 'throwin' : w.m.spType === SP.PENALTY ? 'penalty'
    : w.m.spType === SP.FREEKICK || w.m.spType === SP.CORNER ? 'freekick' : 'restart';
  const b = w.ball, owner = b.owner >= 0 ? pById(w, b.owner) : null;
  const gk = me.role === ROLE.GK && inOwnBox(w, me.team, me.x, me.y, 0.6);
  if (gk && b.owner === me.id && b.held) return 'keeperBall';
  if (gk && !owner && keeperHands(w, me) && (b.z > 1.2 || b.vz > 2) && inOwnBox(w, me.team, b.x, b.y, 3)) return 'keeperAir';
  if (owner && owner.team !== me.team) return me.role === ROLE.GK && inOwnBox(w, me.team, me.x, me.y, 2) ? 'keeper' : 'defend';
  if (!owner && wantsBlock(w, me)) return 'block';
  return 'attack';
}
let shownMode = '';
function showControlMode(w) {
  const mode = w ? controlMode(w) : 'attack';
  touch.setMode(['after', 'throwin', 'penalty', 'freekick', 'restart', 'keeperBall'].includes(mode) ? 'attack' : mode);
  if (mode === shownMode) return;
  shownMode = mode;
  const k = (name) => `<b>${esc(keyName(input.keys[name]))}</b>`;
  const lines = {
    defend: `Defending: ${k('mateG')} press · ${k('goalG')} slide · ${k('selfG')} jockey · ${k('runG')} keeper out (any row)`,
    keeper: `Keeper: ${k('goalG')} dive at his feet · ${k('selfG')} one-on-one block · ${k('runG')} rush out · ${k('mateG')} press`,
    keeperAir: `High ball: you catch it on your own · ${k('goalG')} (any row) <b>punches</b> it clear – aim with the stick`,
    keeperBall: `In your hands: <b>ground</b> row rolls it out · <b>mid</b> row throws it (a drop kick when it's far) · <b>high</b> row punts it`,
    block: 'Hard ball coming: any kick key <b>blocks</b> it',
    after: 'Aftertouch – push the stick <b>further out</b> to curl it back in (further right bends it left) · <b>back</b> lifts it · <b>forward</b> dips it',
    freekick: 'Your free kick – turn with the stick, a kick key plays it · or <b>hold a direction</b> to take it quickly and run with it',
    throwin: 'Your throw-in – aim with the stick, a kick key throws it',
    penalty: 'Penalty – aim with the stick (it picks the spot), Goal key shoots',
    restart: 'Your kick – turn with the stick, a kick key plays it',
  };
  $('ctxHint').innerHTML = lines[mode] || '';
  $('ctxHint').hidden = !lines[mode];
}

// ------------------------------------------------------------------ controls dialog

const PAD = { up: 'L-stick / D-pad', down: 'L-stick / D-pad', left: 'L-stick / D-pad', right: 'L-stick / D-pad', sprint: 'R1 / RB', r2: 'R2 / RT' };
// the kick grid: one column per target, one row per height (see input.js)
const GRID_COLS = [['run', 'Run path', '△ / Y'], ['mate', 'Team-mate', '✕ / A'], ['goal', 'Goal', '□ / X'], ['self', 'Self', '○ / B']];
const GRID_ROWS = [['H', 'High', 'head · top corner', '+ L1'], ['G', 'Ground', 'to feet · low', ''], ['M', 'Mid', 'chest · mid-height', '+ L2']];
let rebinding = null;
function renderControls() {
  const key = (k) => `<button data-k="${k}">${rebinding === k ? '…' : keyName(input.keys[k])}</button>`;
  $('ctrlTable').innerHTML = `
    <tr class="gh"><td></td>${GRID_COLS.map(([, name, pad]) => `<th>${name}<span>${pad}</span></th>`).join('')}</tr>
    ${GRID_ROWS.map(([r, name, what, pad]) => `<tr class="grid"><th>${name}<span>${what}${pad ? ` · pad ${pad}` : ''}</span></th>${GRID_COLS.map(([c]) => `<td class="k">${key(c + r)}</td>`).join('')}</tr>`).join('')}
    ${Object.keys(ACTION_LABELS).map((k) => `<tr><td colspan="2">${ACTION_LABELS[k]}</td><td class="k">${key(k)}</td><td class="pad" colspan="2">${PAD[k]}</td></tr>`).join('')}`;
}
$('ctrlTable').onclick = (e) => { const k = e.target.dataset.k; if (k) { rebinding = k; renderControls(); } };
addEventListener('keydown', (e) => {
  if (!rebinding) return;
  e.preventDefault(); e.stopPropagation();
  if (e.code !== 'Escape') { input.keys[rebinding] = e.code; input.saveKeys(); }
  rebinding = null;
  renderControls();
}, true);
function toggleControls(on) {
  const show = on === undefined ? $('controls').hidden : on;
  $('controls').hidden = !show;
  if (show) renderControls();
}
$('controlsBtn').onclick = () => toggleControls(true);
$('ctrlClose').onclick = () => toggleControls(false);
$('ctrlReset').onclick = () => { input.keys = { ...DEFAULT_KEYS }; input.saveKeys(); renderControls(); };

// ------------------------------------------------------------------ events -> sound

game.onEvent = (e) => {
  const cam = renderer.cam;
  const d = e.x !== undefined ? Math.hypot(e.x - cam.cx, e.y - cam.cy) : 0;
  const vol = Math.max(0.15, 1 - d / 45);
  switch (e.k) {
    case 'kick': sfx.kick(Math.min(1, (e.v || 10) / 30), vol); break;
    case 'head': sfx.head(vol); break;
    case 'control': sfx.cushion(vol); break;
    case 'nutmeg': sfx.oooh(); break;
    case 'slide': sfx.slide(vol); break;
    case 'dive': sfx.dive(vol); break;
    case 'shot':
      sfx.kick(Math.min(1, (e.v || 20) / 28) + 0.2, vol);
      if (e.id === state.myId) bendHintUntil = performance.now() + 1600;
      break;
    case 'bounce': sfx.bounce(Math.min(1, (e.v || 3) / 8) * vol); break;
    case 'post': sfx.post(); sfx.oooh(); break;
    case 'tackle': case 'steal': sfx.tackle(vol); break;
    case 'foul': sfx.tackle(vol); if (game.auth && game.auth.m.live) sfx.boo(); break;
    case 'catch': sfx.catchBall(); break;
    case 'save': sfx.kick(0.4, vol); sfx.oooh(); break;
    case 'punch': sfx.kick(Math.min(1, (e.v || 12) / 25), vol); if (e.v > 12) sfx.oooh(); break;
    case 'block': sfx.block(vol); if ((e.v || 0) > 14) sfx.oooh(); break;
  }
};

function skipReplay() {
  const was = replay.active || state.replayAt;
  replay.stop();
  state.replayAt = 0;
  if (was) send({ t: 'skip' });
}
$('game').addEventListener('pointerdown', () => { if (replay.active || state.replayAt) skipReplay(); });
addEventListener('keydown', (e) => {
  if (e.repeat || !(replay.active || state.replayAt)) return;
  const k = input.keys;
  if ([k.short, k.long, k.shoot, k.through, k.l2].includes(e.code)) skipReplay();
});

function onPhaseChange(prev, m) {
  if (m.phase !== PHASE.GOAL) { replay.stop(); state.replayAt = 0; }
  const teamCol = (t) => TEAM_COLORS[t] ? TEAM_COLORS[t].ui : '#fff';
  switch (m.phase) {
    case PHASE.GOAL: {
      if (!m.live) { sfx.net(); break; } // a warm-up goal: no celebration
      const scorer = state.names.get(m.scorer) || '';
      banner('GOAL!', `${TEAM_NAMES[m.lastGoalTeam] || ''}${scorer ? ' · ' + scorer : ''}`, teamCol(m.lastGoalTeam));
      sfx.net(); sfx.roar();
      // a moment of celebration, then the replay
      if (m.live && game.auth) { state.replayAt = performance.now() + 1100; state.replayGoal = game.auth.tick - m.phT; }
      break;
    }
    case PHASE.KICKOFF:
      if (m.live && prev !== PHASE.GOAL) {
        banner('KICK-OFF', `${TEAM_NAMES[0]} vs ${TEAM_NAMES[1]}`);
        showPanel(false, false); // the match is on: get the room panel out of the way
      }
      break;
    case PHASE.PLAY:
      if (prev === PHASE.KICKOFF) sfx.whistle(1);
      break;
    case PHASE.SETPIECE:
      sfx.whistle(m.spType === SP.FREEKICK || m.spType === SP.PENALTY ? 2 : 1);
      if (m.spType !== SP.THROWIN) banner(SP_NAME[m.spType].toUpperCase(), TEAM_NAMES[m.spTeam], teamCol(m.spTeam));
      break;
    case PHASE.HALFTIME:
      sfx.whistle(2);
      banner('HALF TIME', `${TEAM_NAMES[0]} ${m.s0} – ${m.s1} ${TEAM_NAMES[1]}`);
      break;
    case PHASE.FULLTIME:
      sfx.whistle(3); sfx.cheer(0.7);
      banner('FULL TIME', `${TEAM_NAMES[0]} ${m.s0} – ${m.s1} ${TEAM_NAMES[1]}`);
      break;
  }
}

// ------------------------------------------------------------------ HUD

const halfLabel = ['', '1ST', '2ND'];
let bwT = 0, bwIn = 0, bwOut = 0, bwInRate = 0, bwOutRate = 0;
function updateHud(w, auth, now) {
  const m = auth ? auth.m : w.m;
  $('s0').textContent = m.s0; $('s1').textContent = m.s1;
  let clock;
  const pm = w.m;
  if (pm.phase === PHASE.HALFTIME) clock = 'HALF TIME';
  else if (pm.phase === PHASE.FULLTIME) clock = 'FULL TIME';
  else if (!pm.live) clock = 'WARM-UP';
  else {
    const half = Math.round(pm.matchLen * 30);
    const tt = Math.max(0, pm.clock - (pm.half - 1) * half);
    const sec = Math.floor(tt / TICK_RATE);
    clock = `${halfLabel[pm.half] || ''} ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
  $('clock').textContent = clock;
  if (!net) return;
  if (now - bwT > 1000) {
    bwInRate = (net.bytesIn - bwIn) / ((now - bwT) / 1000); bwOutRate = (net.bytesOut - bwOut) / ((now - bwT) / 1000);
    bwIn = net.bytesIn; bwOut = net.bytesOut; bwT = now;
  }
  const ns = $('netstats');
  ns.hidden = !state.showNet;
  if (state.showNet) {
    const st = game.stats;
    ns.textContent =
      `rtt ${net.rtt.toFixed(0)} ms ±${net.jitter.toFixed(1)}   input lead ${st.lead}/${st.target}t\n` +
      `predict ${st.ahead}t ahead   x${game.timeScale.toFixed(3)}   corr ${st.err.toFixed(3)} m\n` +
      `↓ ${(bwInRate / 1024).toFixed(1)} kB/s  ↑ ${(bwOutRate / 1024).toFixed(1)} kB/s  ${net.transport}`;
  }
}

function looksFor(w) {
  const looks = new Map();
  for (const p of w.players) {
    const key = `${p.id}:${p.team}:${p.role}`;
    let l = state.lookCache.get(key);
    if (!l) { l = lookFor(state.avatars.get(p.id), p.team, p.role); state.lookCache.set(key, l); }
    looks.set(p.id, l);
  }
  return looks;
}

// ------------------------------------------------------------------ main loop

let last = performance.now(), frameNo = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const raw = now - last;
  last = now;
  const dt = Math.min(100, raw) / 1000;
  frameNo++;
  // the soundtrack: menu and warm-up, never during a match
  sfx.setMusic(!state.inRoom || !(game.auth && game.auth.m.live));
  if (frameNo % 6 === 0) sfx.setExcitement(state.inRoom ? crowdLevel(game.world, game.auth) : 0, state.inRoom);
  if (state.inRoom) {
    const alpha = game.frame(raw);
    const w = game.world;
    if (w) {
      const auth = game.auth;
      if (auth && auth.m.phase !== state.lastPhase) {
        if (state.lastPhase !== -1) onPhaseChange(state.lastPhase, auth.m);
        state.lastPhase = auth.m.phase;
      }
      const celebrateTeam = auth && auth.m.phase === PHASE.GOAL && auth.m.live ? auth.m.lastGoalTeam : -1;
      const bubbles = new Map();
      for (const [pid, bb] of state.bubbles) { if (bb.until > now) bubbles.set(pid, bb.text); else state.bubbles.delete(pid); }
      if (state.replayAt && now >= state.replayAt) {
        state.replayAt = 0;
        if (replay.start(game.history, state.replayGoal)) {
          $('replayBadge').querySelector('small').textContent = state.touchUI ? 'tap to skip' : 'press any button to skip';
          $('banner').classList.remove('show');
        }
      }
      const rp = replay.active ? replay.next(dt) : null;
      $('replayBadge').hidden = !rp;
      document.body.classList.toggle('replaying', !!rp);
      if (rp) renderer.frame(rp.world, 1, NO_OFFSETS, { myId: state.myId, looks: looksFor(rp.world), names: state.names, celebrateTeam: -1 }, dt * rp.speed);
      else renderer.frame(w, alpha, game.offsets, { myId: state.myId, looks: looksFor(w), names: state.names, celebrateTeam, bubbles }, dt);
      updateHud(w, auth, now);
      if (frameNo % 6 === 0) showControlMode(rp ? null : w);
      if (frameNo % 2 === 0) renderer.radar($('radar'), w, state.myId);
    } else {
      const g = renderer.g;
      g.fillStyle = '#0e1a14'; g.fillRect(0, 0, renderer.cam.w, renderer.cam.h);
    }
  } else {
    const g = renderer.g;
    g.fillStyle = '#0e1a14'; g.fillRect(0, 0, renderer.cam.w, renderer.cam.h);
  }
  if (draft && !$('editor').hidden) drawAvatarPreview($('edPreview'), draft.avatar, kit, now / 1000);
}
requestAnimationFrame(loop);

