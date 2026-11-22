// Service worker: caches the static app shell and nothing else. The server injects
// BUILD (a hash of every web file) and PRECACHE (the shell's URL list) when it
// serves this file, so a changed client is a changed worker with no hand-bumped
// version. API traffic (/v1/) and every non-GET request go straight to the network
// and are never stored. A new worker waits until the user accepts the update.
const BUILD = '__BUILD__';
const PRECACHE = /*PRECACHE*/ [];
const CACHE = `driveloom-shell-${BUILD}`;
const SHELL = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `reload` bypasses the HTTP cache so the shell is never a stale mix of builds.
    await Promise.all(PRECACHE.map(async (url) => {
      const res = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`precache ${url}: ${res.status}`);
      await cache.put(url, res);
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key.startsWith('driveloom-shell-')) await caches.delete(key);
    await self.clients.claim();
  })());
});

const clearAll = async () => { for (const key of await caches.keys()) await caches.delete(key); };

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  else if (type === 'CLEAR_CACHES') event.waitUntil(clearAll());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Signing out also empties the caches, even for a client that does not message us.
  if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
    event.respondWith(fetch(req).finally(() => event.waitUntil(clearAll())));
    return;
  }
  if (req.method !== 'GET' || url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return;
  if (req.mode === 'navigate') {
    // Online navigations always hit the network; the cached shell is only the offline fallback.
    event.respondWith(fetch(req).catch(async () => (await caches.match('/', { ignoreSearch: true })) || Response.error()));
    return;
  }
  if (!SHELL.has(url.pathname)) return;
  event.respondWith((async () => (await caches.match(url.pathname)) || fetch(req))());
});
