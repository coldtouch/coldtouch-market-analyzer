// Service Worker for Coldtouch Market Analyzer (PWA app shell caching)
// v55: fix craft-runs ReferenceError (fmtSilver -> formatSilver, fmtNum ->
// toLocaleString). The broken references threw inside crRunCardHTML and the
// broad fetch catch block then showed a bogus "Could not reach server"
// message, making a JS bug look like a network outage.
const CACHE_NAME = 'coldtouch-v55';
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
