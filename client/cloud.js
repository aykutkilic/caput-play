// The Cloudflare Worker (cloud/): the room list and the cap on people online
// (its Lobby, see lobby.js). 'self': the game is served by that Worker. Empty:
// no room list – rooms are joined by code or invite link. `?cloud=<url>` or
// localStorage 'caput.cloud' overrides it for testing.
//
// Connecting players (the WebRTC handshake and the relay for networks that
// block direct connections) uses PeerJS's free public servers, as the game
// always has. CLOUD_SIGNALLING moves that to the Worker too (its broker and
// Cloudflare TURN – set up its TURN keys first, see cloud/README.md);
// `?signal=cloud` / `?signal=peerjs` (kept in localStorage 'caput.signal')
// overrides it for testing.
export const CLOUD_URL = 'https://klic.games/caput';
export const CLOUD_SIGNALLING = false;

function override(param, key) {
  let v = '';
  try { v = new URLSearchParams(location.search).get(param) || ''; } catch { /* no location */ }
  try { if (v) localStorage.setItem(key, v); else v = localStorage.getItem(key) || ''; } catch { /* storage unavailable */ }
  return v;
}
// (read as the page loads, before the game tidies the address bar)
const CLOUD = override('cloud', 'caput.cloud') || CLOUD_URL;
const SIGNAL = override('signal', 'caput.signal');

export function cloudUrl() {
  return CLOUD === 'self' ? location.origin : CLOUD;
}

// One of the Worker's endpoints ('rooms', 'lobby', ...), below its address –
// which may have a path (https://klic.games/caput).
export function cloudEndpoint(base, name) {
  return new URL(name, base.endsWith('/') ? base : base + '/');
}

// the Worker to connect through, or '' for PeerJS's public servers
export function signallingUrl() {
  return (SIGNAL ? SIGNAL === 'cloud' : CLOUD_SIGNALLING) ? cloudUrl() : '';
}
