// ============================================================
// MarketDB – Hybrid storage: in-memory Map (fast) + IndexedDB (persistent)
// ============================================================

const MarketDB = (() => {
    const DB_NAME = 'AlbionMarketDB';
    const DB_VERSION = 4;
    const STORE_NAME = 'marketPrices';
    const META_STORE = 'meta';

    let dbPromise = null;

    // === IN-MEMORY CACHE (primary — instant reads) ===
    const memCache = new Map(); // key → price entry
    let memLoaded = false;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (e.oldVersion < DB_VERSION && db.objectStoreNames.contains(STORE_NAME)) { // FE-H5: use DB_VERSION constant
                    db.deleteObjectStore(STORE_NAME);
                }
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                    store.createIndex('item_id', 'item_id', { unique: false });
                    store.createIndex('city', 'city', { unique: false });
                }
                if (!db.objectStoreNames.contains(META_STORE)) {
                    db.createObjectStore(META_STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    function makeKey(entry) {
        return `${entry.item_id}_${entry.quality || 1}_${entry.city}`;
    }

    function parseTs(d) { return d ? (new Date(d.endsWith('Z') ? d : d + 'Z').getTime() || 0) : 0; }

    // Merge incoming entry with existing (keeps best price per direction)
    // Important: NATS packets arrive WITHOUT a date (sell_price_min_date = ''), so if we take the new
    // price we must stamp `now` as the date — otherwise the freshness indicator reports "stale >2h"
    // on rows that were updated seconds ago. Before this fix the freshness dot went black on every
    // NATS-sourced price.
    function mergeEntry(existing, entry) {
        let sellPrice = entry.sell_price_min || 0;
        let sellDate = entry.sell_price_min_date || '';
        let buyPrice = entry.buy_price_max || 0;
        let buyDate = entry.buy_price_max_date || '';
        const nowIso = new Date().toISOString();

        if (existing) {
            if (sellDate && parseTs(sellDate) >= parseTs(existing.sell_price_min_date || '')) {
                // Incoming is newer (explicit date)
            } else if (sellPrice > 0 && existing.sell_price_min > 0 && sellPrice < existing.sell_price_min) {
                // Incoming is a better price — stamp now so freshness knows this update actually happened.
                sellDate = nowIso;
            } else {
                sellPrice = existing.sell_price_min;
                sellDate = existing.sell_price_min_date;
            }

            if (buyDate && parseTs(buyDate) >= parseTs(existing.buy_price_max_date || '')) {
                // Incoming is newer (explicit date)
            } else if (buyPrice > 0 && buyPrice > (existing.buy_price_max || 0)) {
                // Incoming is a better price — stamp now.
                buyDate = nowIso;
            } else {
                buyPrice = existing.buy_price_max;
                buyDate = existing.buy_price_max_date;
            }
        } else {
            // New entry with empty date → stamp now so freshness reads "just now".
            if (sellPrice > 0 && !sellDate) sellDate = nowIso;
            if (buyPrice > 0 && !buyDate) buyDate = nowIso;
        }

        return {
            key: makeKey(entry),
            item_id: entry.item_id,
            quality: entry.quality || 1,
            city: entry.city,
            sell_price_min: sellPrice,
            sell_price_min_date: sellDate,
            buy_price_max: buyPrice,
            buy_price_max_date: buyDate,
            scan_timestamp: Date.now()
        };
    }

    // Write entries to IndexedDB in background batches (non-blocking)
    let idbWriteQueue = [];
    let idbWriteScheduled = false;
    const IDB_BATCH_SIZE = 3000;
    const IDB_WRITE_DELAY = 500; // ms between batches

    function scheduleIdbWrite() {
        if (idbWriteScheduled || idbWriteQueue.length === 0) return;
        idbWriteScheduled = true;
        setTimeout(async () => {
            idbWriteScheduled = false;
            const batch = idbWriteQueue.splice(0, IDB_BATCH_SIZE);
            if (batch.length === 0) return;
            try {
                const db = await open();
                await new Promise((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readwrite');
                    const store = tx.objectStore(STORE_NAME);
                    for (const entry of batch) store.put(entry);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                });
            } catch (e) { /* IDB write failed — memory cache still valid */ }
            // Schedule next batch if more queued
            if (idbWriteQueue.length > 0) scheduleIdbWrite();
        }, IDB_WRITE_DELAY);
    }

    async function saveMarketData(entries) {
        const now = Date.now();
        for (const entry of entries) {
            if (!entry.item_id || !entry.city) continue;
            const key = makeKey(entry);
            const existing = memCache.get(key);
            const merged = mergeEntry(existing, entry);
            merged.scan_timestamp = now;
            memCache.set(key, merged);
            idbWriteQueue.push(merged);
        }
        // Schedule background IDB persist
        scheduleIdbWrite();
    }

    async function getItemPrices(itemId) {
        const results = [];
        for (const entry of memCache.values()) {
            if (entry.item_id === itemId) results.push(entry);
        }
        return results;
    }

    async function getAllPrices() {
        // Return from memory cache (instant)
        return Array.from(memCache.values());
    }

    async function clearAll() {
        memCache.clear();
        idbWriteQueue = [];
        try {
            const db = await open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) { /* best effort */ }
    }

    // Load IndexedDB into memory cache on startup (for returning users)
    async function loadFromIdb() {
        if (memLoaded) return;
        try {
            const db = await open();
            const entries = await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
            for (const entry of entries) {
                memCache.set(entry.key, entry);
            }
            memLoaded = true;
        } catch (e) { /* fresh start */ }
    }

    async function setMeta(id, value) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(META_STORE, 'readwrite');
            tx.objectStore(META_STORE).put({ id, value, timestamp: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getMeta(id) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(META_STORE, 'readonly');
            const req = tx.objectStore(META_STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function getStoredItemCount() {
        return memCache.size;
    }

    async function evictStale(maxAgeMs) {
        const cutoff = Date.now() - maxAgeMs;
        let evicted = 0;
        for (const [key, entry] of memCache) {
            if (entry.scan_timestamp && entry.scan_timestamp < cutoff) {
                memCache.delete(key);
                evicted++;
            }
        }
        // Also clean IDB in background
        if (evicted > 0) {
            try {
                const db = await open();
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const req = store.openCursor();
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        if (cursor.value.scan_timestamp && cursor.value.scan_timestamp < cutoff) cursor.delete();
                        cursor.continue();
                    }
                };
            } catch (e) { /* best effort */ }
        }
        if (evicted > 0) console.log(`[DB] Evicted ${evicted} stale entries`);
        return evicted;
    }

    return {
        open,
        loadFromIdb,
        saveMarketData,
        getItemPrices,
        getAllPrices,
        clearAll,
        setMeta,
        getMeta,
        getStoredItemCount,
        evictStale
    };
})();
