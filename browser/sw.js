// Force clear old service worker caches and always fetch fresh assets
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map(k => caches.delete(k)));
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Always go network-first so updates take effect immediately
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
