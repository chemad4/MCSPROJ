// Cache version — bump this on each deployment to invalidate stale assets.
// Using date-based versioning for clarity (Audit Fix 3.6).
const CACHE_NAME = 'fit-track-cache-v3-standardized';
const urlsToCache = [
  './',
  'index.html',
  'adminDB.html',
  'staffDB.html',
  'trainerDB.html',
  'memberDB.html',
  'css/styles.css',
  'js/script.js',
  'js/attendance.js',
  'js/rfid.js',
  'js/utils.js',
  'js/ui.js',
  'images/icon-192.png'
];

// Install the service worker and cache the core files
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Clean up old caches and take control ASAP
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      ),
      self.clients.claim(),
    ])
  );
});

// Serve cached content when offline
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCoreAsset =
    isSameOrigin &&
    (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html'));

  // Network-first for core assets so updates (like POS/RFID flow) propagate immediately.
  if (isCoreAsset) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first fallback for everything else
  event.respondWith(caches.match(req).then((response) => response || fetch(req)));
});