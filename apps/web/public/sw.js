// Service worker: makes the app installable and shows a friendly page when there is no
// connection. It never caches API answers (bookings must always be fresh).
const OFFLINE = 'agenda-offline-v1';
const OFFLINE_HTML = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin conexión</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#0f172a;text-align:center;padding:24px">
<div><div style="font-size:48px">📶</div><h1 style="font-size:20px">Sin conexión</h1><p style="color:#475569">Revisa tu internet y vuelve a intentar.</p>
<button onclick="location.reload()" style="background:#0f766e;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px">Reintentar</button></div></body></html>`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(OFFLINE).then((c) => c.put('/__offline', new Response(OFFLINE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  // Only page loads get the offline fallback; everything else goes straight to the network.
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match('/__offline')));
});
