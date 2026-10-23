// Installable app + automatic updates.
//
//  * Registers the service worker (sw.js) that makes the site installable and
//    serves the newest files whenever the device is online.
//  * Compares the running build (VERSION, stamped at deploy) with the deployed
//    one (version.json) on launch, when the app returns to the foreground and
//    every few minutes. Outside a match it reloads straight into the new
//    version; during a match it only announces it, and the update is applied
//    when the player leaves the room – a game is never interrupted.
//  * Exposes the browser's install prompt (Android / desktop Chrome & Edge);
//    iOS has no prompt, so the UI shows the Share → Add to Home Screen hint.

import { VERSION } from './version.js';

const CHECK_EVERY = 5 * 60 * 1000;

export function initPwa({ busy, onUpdateReady, onInstallable }) {
  let deferred = null;
  const api = {
    version: VERSION,
    dev: VERSION.startsWith('__'),
    updateReady: false,
    standalone: matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true,
    ios: /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    async install() {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice.catch(() => {});
      deferred = null;
      onInstallable(false);
    },
    apply: () => refreshThenReload(files),
  };
  let files = [];

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* e.g. private mode */ });
  }
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; onInstallable(true); });
  addEventListener('appinstalled', () => { deferred = null; onInstallable(false); });

  if (api.dev) return api; // local development build: nothing to compare against

  const check = async () => {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const info = await res.json();
      if (!info.version || info.version === VERSION) return;
      api.updateReady = true;
      // (not the music: it rarely changes and is big)
      files = Array.isArray(info.files) ? info.files.filter((f) => !/\.(mp3|ogg|m4a)$/.test(f)) : [];
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) reg.update().catch(() => {});
      if (busy()) onUpdateReady(info.version); else refreshThenReload(files);
    } catch { /* offline: try again later */ }
  };
  check();
  setInterval(check, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  addEventListener('online', check);
  return api;
}

// Re-download every file of the release, bypassing the HTTP cache, before
// reloading: a page load the service worker doesn't handle (e.g. while it is
// being swapped) would otherwise get stale copies for up to the CDN's max-age,
// and a half-old, half-new set of modules can't start.
async function refreshThenReload(files) {
  await Promise.all(files.map((f) => fetch(f, { cache: 'reload' }).catch(() => {})));
  reloadOnce();
}

// While a fresh deploy propagates through the CDN the old files can still be
// served for a moment; never reload more than once a minute.
function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem('caput.reloadAt') || 0);
    if (Date.now() - last < 60000) return;
    sessionStorage.setItem('caput.reloadAt', String(Date.now()));
  } catch { /* storage unavailable */ }
  location.reload();
}
