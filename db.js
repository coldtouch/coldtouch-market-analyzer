// ============================================================
// MarketDB – IndexedDB storage layer for Albion market prices
// ============================================================

const MarketDB = (() => {
    const DB_NAME = 'AlbionMarketDB';
    const DB_VERSION = 4;
    const STORE_NAME = 'marketPrices';
    const META_STORE = 'meta';

    let dbPromise = null;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (e.oldVersion < 4 && db.objectStoreNames.contains(STORE_NAME)) {
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
        return `${entry.item_id}_${entry.quality}_${entry.city}`;
    }

    // Parse a market timestamp to ms — handles both "...T00:00:00" (no Z) and "...T00:00:00Z" (UTC)
    function parseTs(d) { return d ? (new Date(d.endsWith('Z') ? d : d + 'Z').getTime() || 0) : 0; }

    async function saveMarketData(entries) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const now = Date.now();
            for (const entry of entries) {
                if (!entry.item_id || !entry.city) continue;
                const key = makeKey(entry);
                const req = store.get(key);

                req.onsuccess = (e) => {
                    const existing = e.target.result;
                    let sellPrice = entry.sell_price_min || 0;
                    let sellDate = entry.sell_price_min_date || '';
                    let buyPrice = entry.buy_price_max || 0;
                    let buyDate = entry.buy_price_max_date || '';

                    if (existing) {
                        // Sell price: use incoming if it has a newer date OR a better (lower non-zero) price
                        if (sellDate && parseTs(sellDate) >= parseTs(existing.sell_price_min_date || '')) {
                            // Incoming is newer — use it (even if 0, meaning the order expired)
                        } else if (sellPrice > 0 && existing.sell_price_min > 0 && sellPrice < existing.sell_price_min) {
                            // Incoming is a better price — use it
                        } else {
                            // Keep existing
                            sellPrice = existing.sell_price_min;
                            sellDate = existing.sell_price_min_date;
                        }

                        // Buy price: use incoming if it has a newer date OR a better (higher) price
                        if (buyDate && parseTs(buyDate) >= parseTs(existing.buy_price_max_date || '')) {
                            // Incoming is newer — use it (even if 0)
                        } else if (buyPrice > 0 && buyPrice > (existing.buy_price_max || 0)) {
                            // Incoming is a better price — use it
                        } else {
                            // Keep existing
                            buyPrice = existing.buy_price_max;
                            buyDate = existing.buy_price_max_date;
                        }
                    }

                    store.put({
                        key,
                        item_id: entry.item_id,
                        quality: entry.quality || 1,
                        city: entry.city,
                        sell_price_min: sellPrice,
                        sell_price_min_date: sellDate,
                        buy_price_max: buyPrice,
                        buy_price_max_date: buyDate,
                        scan_timestamp: now
                    });
                };
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getItemPrices(itemId) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const index = tx.objectStore(STORE_NAME).index('item_id');
            const req = index.getAll(itemId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function getAllPrices() {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function clearAll() {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
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
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function evictStale(maxAgeMs) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const cutoff = Date.now() - maxAgeMs;
            let evicted = 0;
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (cursor.value.scan_timestamp && cursor.value.scan_timestamp < cutoff) {
                        cursor.delete();
                        evicted++;
                    }
                    cursor.continue();
                }
            };
            tx.oncomplete = () => {
                if (evicted > 0) console.log(`[DB] Evicted ${evicted} stale entries`);
                resolve(evicted);
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    return {
        open,
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
