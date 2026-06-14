// Service Worker for Coldtouch Market Analyzer (PWA app shell caching)
// v149: Refresh Albion item maps/weights from ao-bin-dumps 20260526 so loot
// logger numeric IDs resolve to the current game items.
const CACHE_NAME = 'coldtouch-v150';
const IS_GITHUB_PAGES = self.location.hostname === 'coldtouch.github.io';
const APP_SHELL = [
    '/',
    '/index.html',
    '/app.js',
    '/lootlogger-core.js',
    '/style.css',
    '/db.js',
    '/zonemap.js',
    '/items.json',
    '/recipes.json',
    '/itemmap.json',
    '/itemweights.json',  // 2026-04-28: was missing — 411KB hit on every fresh install
    '/manifest.json'
];

self.addEventListener('install', (e) => {
    if (IS_GITHUB_PAGES) {
        self.skipWaiting();
        return;
    }
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
    if (IS_GITHUB_PAGES && e.request.mode === 'navigate') {
        const url = new URL(e.request.url);
        const path = url.pathname.replace(/^\/coldtouch-market-analyzer\/?/, '/') || '/';
        e.respondWith(Response.redirect('https://albionaitool.xyz' + path + url.search + url.hash, 302));
        return;
    }
    // Pass-through: API calls and WebSocket upgrades
    if (e.request.url.includes('/api/') || e.request.url.includes('/auth/') || e.request.url.includes('wss://')) return;
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
