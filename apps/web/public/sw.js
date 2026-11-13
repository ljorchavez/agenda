// Service worker: makes the app installable and lets it open without internet (the point of sale
// keeps selling on a register). It keeps the last app it loaded (page, scripts, styles, icons);
// API answers are never cached here (bookings and stock must always be fresh).
const CACHE = 'lugali-app-v2';
const OFFLINE_HTML = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin conexión</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#0f172a;text-align:center;padding:24px">
<div><div style="font-size:48px">📶</div><h1 style="font-size:20px">Sin conexión</h1><p style="color:#475569">Revisa tu internet y vuelve a intentar.</p>
<button onclick="location.reload()" style="background:#0f766e;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px">Reintentar</button></div></body></html>`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.put('/__offline', new Response(OFFLINE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const STATIC = /^\/(assets|icons)\/|^\/(manifest\.webmanifest|favicon-32\.png)$/;

/** Keeps the newest page and forgets scripts/styles of older versions. */
async function keepPage(res) {
  const cache = await caches.open(CACHE);
  const html = await res.clone().text();
  await cache.put('/__app', new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const used = new Set([...html.matchAll(/\/assets\/[^"' )]+/g)].map((m) => m[0]));
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/') && !used.has(path)) await cache.delete(req);
  }
  // Fetch this version's files now, so it opens offline even before they're used
  await Promise.all([...used].map((p) => cache.match(p).then((hit) => hit || fetch(p).then((r) => (r.ok ? cache.put(p, r) : undefined)).catch(() => undefined))));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: the network first; without it, the last app loaded (or the offline note)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) e.waitUntil(keepPage(res.clone()));
          return res;
        })
        .catch(async () => (await caches.match('/__app')) || (await caches.match('/__offline'))),
    );
    return;
  }

  // Versioned files never change: from the cache when there, else the network (and keep it)
  if (STATIC.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
            }
            return res;
          }),
      ),
    );
  }
});
