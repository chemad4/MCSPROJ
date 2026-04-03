const CACHE_NAME = 'fit-track-cache-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/memberDB.html',
  '/css/styles.css'
];

// Install the service worker and cache the core files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Serve cached content when offline
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Return the cached version if found, otherwise fetch from the network
        return response || fetch(event.request);
      })
  );
});