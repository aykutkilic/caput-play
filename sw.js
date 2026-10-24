// Service worker: makes CAPUT installable and keeps it up to date.
//
// Network-first for the app's own files, so an online player always runs the
// latest release; the cache is only a fallback (e.g. opening the installed app
// with a flaky connection). The deploy workflow stamps VERSION, so every
// release starts a fresh cache and old ones are dropped.

const VERSION = 'be84ca3.10241801';
const CACHE = `caput-${VERSION}`;
const SHELL = ['./', './index.html', './manifest.webmanifest', './client/style.css', './client/main.js', './client/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE);
      await c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    } catch { /* offline install: the cache fills as files are used */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('caput-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // only our own files; the version probe always goes to the network untouched
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('/version.json')) return;
  // audio streams in ranges (206 partial responses can't be cached): let the browser handle it
  if (req.headers.has('range') || url.pathname.endsWith('.mp3')) return;
  e.respondWith((async () => {
    try {
      // revalidate with the server every time (cheap 304s when nothing changed)
      const res = req.mode === 'navigate' ? await fetch(req.url, { cache: 'no-cache' }) : await fetch(req, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
      }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
