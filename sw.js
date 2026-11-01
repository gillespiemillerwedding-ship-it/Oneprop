const CACHE_NAME = 'keyper-v1';
const ASSETS = ['./index.html', './styles.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
