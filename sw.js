// Service Worker for Coldtouch Market Analyzer (PWA app shell caching)
// v58: deaths section now shows [Guild] prefix on victim + killer names in
// both Friendly Deaths and Enemy Kills subsections (plus looter rows inside
// the expanded death body). Helps ZvZ audits where many players share
// similar names but wear different guild tags.
const CACHE_NAME = 'coldtouch-v74';
const APP_SHELL = [
    './',
    './index.html',
    './app.js',
    './style.css',
    './db.js',
    './items.json',
    './itemmap.json',
    './manifest.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    // Pass-through: API calls and WebSocket upgrades
    if (e.request.url.includes('/api/') || e.request.url.includes('wss://')) return;
    // FE-H3: stale-while-revalidate — serve cached copy instantly, refresh cache in background
    e.respondWith(
        caches.open(CACHE_NAME).then(cache =>
            cache.match(e.request).then(cached => {
                const networkFetch = fetch(e.request).then(response => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        cache.put(e.request, response.clone());
                    }
                    return response;
                });
                return cached || networkFetch;
            })
        )
    );
});
