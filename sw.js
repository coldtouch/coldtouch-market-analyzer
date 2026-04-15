// Service Worker for Coldtouch Market Analyzer (PWA app shell caching)
const CACHE_NAME = 'coldtouch-v18';
const APP_SHELL = [
    './',
    './index.html',
    './app.js',
    './style.css',
    './db.js',
    './items.json',
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
    // Network-first for API calls, cache-first for app shell
    if (e.request.url.includes('/api/') || e.request.url.includes('wss://')) return;
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});
