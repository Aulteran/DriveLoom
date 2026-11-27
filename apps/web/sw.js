// Service worker: caches the static app shell and nothing else. The server injects
// BUILD (a hash of every web file) and PRECACHE (the shell's URL list) when it
// serves this file, so a changed client is a changed worker with no hand-bumped
// version. The shell is network-first: online, every navigation and shell file comes
// from the server (revalidated, never from the HTTP cache) and refreshes the cached
// copy; the cache only answers when the network fails, so an offline cold start works
// and no tab can be pinned to old JS. API traffic (/v1/) and every non-GET request
// bypass the worker and are never stored. A new worker (the precache list changed)
// waits until the user accepts the update.
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

// Sign-out: the shell caches hold static files only, so they stay (offline cold start
// must keep working); any other cache is dropped.
const clearAll = async () => { for (const key of await caches.keys()) if (!key.startsWith('driveloom-shell-')) await caches.delete(key); };

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  else if (type === 'CLEAR_CACHES') event.waitUntil(clearAll());
});

/** Network first; the cached copy answers only when the network fails. Only a plain 200 refreshes the cache. */
async function fromNetwork(event, key, fallback) {
  const req = event.request;
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (key && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(key, copy)).catch(() => undefined));
    }
    return res;
  } catch (err) {
    const hit = await caches.match(fallback ?? key, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Signing out also empties the non-shell caches, even for a client that does not message us.
  if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
    event.respondWith(fetch(req).finally(() => event.waitUntil(clearAll())));
    return;
  }
  // The API docs and the contract are public pages of their own: never part of the app shell, never an offline fallback.
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/') || url.pathname === '/openapi.yaml' || url.pathname === '/openapi.json') return;
  if (req.method !== 'GET' || url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return;
  if (req.mode === 'navigate') {
    // Only the root document is the cached shell; any other route is the same index.html offline.
    event.respondWith(fromNetwork(event, url.pathname === '/' ? '/' : null, '/'));
    return;
  }
  if (!SHELL.has(url.pathname)) return;
  event.respondWith(fromNetwork(event, url.pathname));
});
