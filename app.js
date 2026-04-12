// ============================================================
// Coldtouch Market Analyzer – Main Application
// ============================================================

const API_URLS = {
    west: 'https://west.albion-online-data.com/api/v2/stats/prices',
    east: 'https://east.albion-online-data.com/api/v2/stats/prices',
    europe: 'https://europe.albion-online-data.com/api/v2/stats/prices'
};

const CHART_API_URLS = {
    west: 'https://west.albion-online-data.com/api/v2/stats/charts',
    east: 'https://east.albion-online-data.com/api/v2/stats/charts',
    europe: 'https://europe.albion-online-data.com/api/v2/stats/charts'
};

const CITIES = ['Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Bridgewatch', 'Caerleon', 'Brecilien', 'Black Market'];
const TAX_RATE = 0.03;      // 3% market transaction tax (insta-sell to buy orders)
const SETUP_FEE = 0.025;    // 2.5% listing setup fee (sell orders only; combined = 5.5%)

// Transport mount carry-weight table. Mounts only add weight capacity — slots come from player inventory only.
// "none" = player base carry capacity with a standard bag (600 kg).
const MOUNT_DATA = {
    'none':            { weight: 600,      label: 'No Mount'             },
    'ox_t3':           { weight: 476,      label: 'T3 Transport Ox'      },
    'ox_t5':           { weight: 816,      label: 'T5 Transport Ox'      },
    'ox_t7':           { weight: 1262,     label: 'T7 Transport Ox'      },
    'mammoth_t8':      { weight: 1764,     label: 'T8 Transport Mammoth'  },
    'mammoth_saddled': { weight: 2308,     label: 'T8 Saddled Mammoth'   },
    'ignore':          { weight: Infinity, label: 'Ignore Weight'         },
};

function getTransportMountConfig() {
    const key = document.getElementById('transport-mount').value;
    const mount = MOUNT_DATA[key] || MOUNT_DATA.none;
    const freeSlots = Math.max(1, parseInt(document.getElementById('transport-free-slots').value) || 30);
    return { mountCapacity: mount.weight, freeSlots };
}

const ITEMS_PER_PAGE = 48;
const MAX_INVENTORY_SLOTS = 48;

// Weight system — material weight per tier × materials needed per slot
const TIER_MATERIAL_WEIGHT = { 2: 0.1, 3: 0.1, 4: 0.2125, 5: 0.3125, 6: 0.475, 7: 0.7125, 8: 1.06875 };
const SLOT_MATERIAL_COUNT = {
    chest: 16, head: 8, shoes: 8, offhand: 8,
    onehand: 24, twohand: 32, cape: 8, bag: 16
};
// Stack sizes for non-gear items (per inventory slot)
const STACK_SIZE = { resources: 999, materials: 999, consumables: 999, other: 999, mounts: 1 };
const API_CHUNK_SIZE = 100;

// ====== STATE ======
let ITEM_NAMES = {};
let ITEM_WEIGHTS = {};
let itemsList = [];
let recipesData = {};
let currentTab = 'browser';
let browserPage = 1;
let browserFilteredItems = [];
let _priceCache = null;
let _priceCacheTime = 0;
const PRICE_CACHE_TTL = 30000; // 30 seconds

async function getCachedPrices() {
    const now = Date.now();
    if (_priceCache && (now - _priceCacheTime) < PRICE_CACHE_TTL) return _priceCache;
    try {
        _priceCache = await MarketDB.getAllPrices();
        _priceCacheTime = now;
    } catch { _priceCache = []; }
    return _priceCache;
}

function invalidatePriceCache() { _priceCache = null; _priceCacheTime = 0; }
let compareSelectedId = null;
let arbSearchExactId = null;
let craftSearchExactId = null;
let priceChartInstance = null;
let vpsGameServer = 'europe'; // detected from VPS on init; used to skip VPS cache reload when on a different server
let analyticsChartInstance = null;
let scanAbortController = null;
let spreadStatsCache = {}; // keyed by "itemId_quality_buyCity_sellCity"
const analyticsCache = new Map(); // keyed by itemId, value: { price_trend, latest_price } | 'pending'
let spreadStatsCacheTime = 0;
let discordUser = null; // stored on auth check for contribution tracking

// ====== UTILITY ======
function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Toast notification system — replaces alert()/confirm()
function showToast(message, type = 'info', duration = 4000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = esc(message);
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function showConfirm(message, onYes) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast toast-confirm show';
    toast.innerHTML = `<div style="margin-bottom:0.5rem;">${esc(message)}</div>
        <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
            <button class="btn-small" onclick="this.closest('.toast').remove()">Cancel</button>
            <button class="btn-small-danger" onclick="this.closest('.toast').remove(); (${onYes.toString()})()">Confirm</button>
        </div>`;
    container.appendChild(toast);
}

function getFriendlyName(id) {
    if (ITEM_NAMES[id] && ITEM_NAMES[id].trim() !== '') return ITEM_NAMES[id];
    return id.replace(/_/g, ' ').replace(/T(\d+)/, 'Tier $1').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

function getItemWeight(id) {
    return ITEM_WEIGHTS[id] || 0;
}

function getQualityName(q) {
    const map = { '1': 'Normal', '2': 'Good', '3': 'Outstanding', '4': 'Excellent', '5': 'Masterpiece' };
    return map[String(q)] || 'Unknown';
}

function timeAgo(dateString) {
    if (!dateString || dateString.startsWith('0001')) return 'Never';
    const date = new Date(dateString.endsWith('Z') ? dateString : dateString + 'Z');
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 0) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
}

function getFreshnessIndicator(dateString) {
    if (!dateString || dateString.startsWith('0001')) return '<span class="freshness-dot stale" title="No data">⚫</span>';
    const date = new Date(dateString.endsWith('Z') ? dateString : dateString + 'Z');
    const now = new Date();
    const diffMins = Math.floor((now - date) / 60000);
    if (diffMins < 30) return '<span class="freshness-dot fresh" title="Updated < 30 min ago">🟢</span>';
    if (diffMins < 120) return '<span class="freshness-dot aging" title="Updated 30m–2h ago">🟡</span>';
    return '<span class="freshness-dot old" title="Updated > 2h ago">🔴</span>';
}

function extractTier(itemId) {
    const m = itemId.match(/^T(\d+)/);
    return m ? m[1] : null;
}

function extractEnchantment(itemId) {
    if (!itemId || !itemId.includes('@')) return '0';
    return itemId.split('@')[1];
}

function getTierEnchLabel(itemId) {
    const tier = extractTier(itemId);
    const ench = extractEnchantment(itemId);
    if (!tier) return '';
    return ench !== '0' ? `T${tier}.${ench}` : `T${tier}`;
}

function getEnchantmentBadge(itemId) {
    if (!itemId || !itemId.includes('@')) return '';
    const level = itemId.split('@')[1];
    return `<div class="enchantment-badge ench-${level}">${level}</div>`;
}

function categorizeItem(itemId) {
    const id = itemId.toUpperCase();
    if (id.includes('MAIN_') || id.includes('2H_') && !id.includes('TOOL_')) {
        if (id.includes('TOOL_')) return 'other';
        return 'weapons';
    }
    if (id.includes('HEAD_') || id.includes('ARMOR_') || id.includes('SHOES_')) {
        if (id.includes('PLATE_') || id.includes('LEATHER_') || id.includes('CLOTH_')) return 'armor';
    }
    if (id.includes('BAG') || id.includes('CAPE')) return 'accessories';
    if (id.includes('OFF_')) return 'offhand';
    if (id.includes('_WOOD') || id.includes('_ORE') || id.includes('_HIDE') || id.includes('_FIBER') || id.includes('_ROCK')) {
        if (!id.includes('PLANKS') && !id.includes('METALBAR') && !id.includes('LEATHER') && !id.includes('CLOTH') && !id.includes('STONEBLOCK')) return 'resources';
    }
    if (id.includes('PLANKS') || id.includes('METALBAR') || id.includes('LEATHER') || id.includes('CLOTH') || id.includes('STONEBLOCK')) return 'materials';
    if (id.includes('POTION_') || id.includes('MEAL_') || id.includes('FISH')) return 'consumables';
    if (id.includes('MOUNT_') || id.includes('MOUNT')) return 'mounts';
    if (id.includes('2H_TOOL_')) return 'other';
    return 'other';
}

// Determine equipment slot type from item ID for weight calculation
function getEquipmentSlot(itemId) {
    const id = itemId.toUpperCase();
    // Two-hand weapons (must check before one-hand)
    if (id.includes('2H_') && !id.includes('TOOL_')) return 'twohand';
    // One-hand weapons
    if (id.includes('MAIN_')) return 'onehand';
    // Head armor
    if (id.includes('HEAD_') || id.includes('_HELMET') || id.includes('_HOOD') || id.includes('_COWL') || id.includes('_CAP')) {
        if (id.includes('PLATE_') || id.includes('LEATHER_') || id.includes('CLOTH_') || id.includes('ARMOR_')) return 'head';
    }
    // Chest armor (ARMOR_ that isn't head/shoes)
    if (id.includes('ARMOR_') || id.includes('_JACKET') || id.includes('_ROBE')) {
        if ((id.includes('PLATE_') || id.includes('LEATHER_') || id.includes('CLOTH_')) && !id.includes('HEAD_') && !id.includes('SHOES_')) return 'chest';
    }
    // Shoes
    if (id.includes('SHOES_')) return 'shoes';
    // Off-hand / shield
    if (id.includes('OFF_')) return 'offhand';
    // Capes
    if (id.includes('CAPE')) return 'cape';
    // Bags / satchels
    if (id.includes('BAG') || id.includes('SATCHEL')) return 'bag';
    return null; // Not gear — weight = 0 (stackable items like resources, consumables)
}

// Calculate single item weight using tier × material count (gear) or tier weight (resources)
function calcItemWeight(itemId) {
    // Use real game weight data from itemweights.json (loaded from ao-bin-dumps)
    const w = getItemWeight(itemId);
    if (w > 0) return w;
    // Fallback: estimate from tier × slot type (for items not in weight map)
    const tier = parseInt(extractTier(itemId));
    if (!tier) return 0;
    const slot = getEquipmentSlot(itemId);
    const matWeight = TIER_MATERIAL_WEIGHT[tier] || TIER_MATERIAL_WEIGHT[8];
    if (slot) {
        const matCount = SLOT_MATERIAL_COUNT[slot] || 8;
        return matWeight * matCount;
    }
    return matWeight;
}

// Get how many items fit in one inventory slot
function getStackSize(itemId) {
    const slot = getEquipmentSlot(itemId);
    if (slot) return 1; // Gear: 1 per slot
    const cat = categorizeItem(itemId);
    return STACK_SIZE[cat] || 999;
}

// Check if an item is stackable (resources, materials, consumables — NOT gear)
function isStackableItem(itemId) {
    return getEquipmentSlot(itemId) === null;
}

function getServer() {
    return document.getElementById('server-select').value;
}

function showError(container, msg) {
    container.textContent = msg;
    container.classList.remove('hidden');
}

function hideError(container) {
    container.classList.add('hidden');
}

// ====== DATA LOADING ======
async function loadData() {
    try {
        const cb = '?v=' + Date.now();
        const [resItems, resRecipes, resWeights] = await Promise.all([
            fetch('items.json' + cb),
            fetch('recipes.json' + cb),
            fetch('itemweights.json' + cb).catch(() => ({ ok: false }))
        ]);
        ITEM_NAMES = await resItems.json();
        itemsList = Object.keys(ITEM_NAMES).filter(k => k && ITEM_NAMES[k]);
        recipesData = await resRecipes.json();
        if (resWeights.ok) ITEM_WEIGHTS = await resWeights.json();
    } catch (e) {
        console.error('Failed to load data files:', e);
    }
}

// ====== API FETCHING ======
async function fetchMarketChunk(server, items) {
    if (items.length === 0) return [];
    const url = `${API_URLS[server]}/${items.join(',')}.json?v=${Date.now()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function fetchMarketData(server, items) {
    let allData = [];
    for (let i = 0; i < items.length; i += API_CHUNK_SIZE) {
        const chunk = items.slice(i, i + API_CHUNK_SIZE);
        const data = await fetchMarketChunk(server, chunk);
        allData = allData.concat(data);
    }
    return allData;
}

// ====== DB STATUS ======
async function updateDbStatus() {
    invalidatePriceCache(); // New data arrived — bust the browser price cache
    try {
        const count = await MarketDB.getStoredItemCount();
        const meta = await MarketDB.getMeta('lastScan');
        const el = document.getElementById('db-status');
        const textEl = el.querySelector('.db-status-text');

        if (count > 0) {
            el.classList.add('has-data');
            const timeStr = meta ? timeAgo(new Date(meta.timestamp).toISOString().slice(0, -1)) : 'Unknown';
            textEl.textContent = `${count.toLocaleString()} prices cached • Last scan: ${timeStr}`;
        } else {
            el.classList.remove('has-data');
            textEl.textContent = 'No data scanned';
        }
    } catch (e) {
        console.error('DB status error:', e);
    }
}


// ====== TAB NAVIGATION ======
function initTabs() {
    const tabs = document.querySelectorAll('.nav-tab');
    const groups = document.querySelectorAll('.nav-group');
    const groupToggles = document.querySelectorAll('.nav-group-toggle');

    // Close all dropdowns
    function closeAllDropdowns() {
        groups.forEach(g => g.classList.remove('open'));
    }

    // Handle group toggle clicks (open/close dropdown)
    groupToggles.forEach(toggle => {
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const group = toggle.closest('.nav-group');
            const isOpen = group.classList.contains('open');
            closeAllDropdowns();
            if (!isOpen) group.classList.add('open');
        });
    });

    // Handle tab clicks (switch tab content)
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.stopPropagation();

            // Deactivate all tabs and group toggles
            tabs.forEach(t => t.classList.remove('active'));
            groupToggles.forEach(g => g.classList.remove('active'));

            // Activate clicked tab
            tab.classList.add('active');
            currentTab = tab.dataset.tab;

            // Activate parent group toggle if tab is inside a dropdown
            const parentGroup = tab.closest('.nav-group');
            if (parentGroup) {
                parentGroup.querySelector('.nav-group-toggle').classList.add('active');
            }

            // Switch pane
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
            document.getElementById(`pane-${currentTab}`).classList.remove('hidden');

            if (currentTab === 'browser') renderBrowser();
            if (currentTab === 'live-flips') initLiveFlipsTab();
            if (currentTab === 'profile') initProfileTab();
            if (currentTab === 'loot-buyer') { renderLootCaptures(); loadTrackedTabs(); loadRecentSales(); }
            if (currentTab === 'loot-logger') { showLootLoggerMode('live'); }
            if (currentTab === 'crafting') {
                // Restore detail view if we had one calculated before switching away
                if (window._craftLastData && window._craftLastRecipe && window._craftLastItemId) {
                    document.getElementById('craft-settings').style.display = 'flex';
                    document.getElementById('craft-detail-view').style.display = 'block';
                    document.getElementById('craft-bulk-section').style.display = 'none';
                    renderCraftDetail(window._craftLastItemId, window._craftLastRecipe, window._craftLastData);
                }
            }

            // Close dropdown after selection
            closeAllDropdowns();
        });
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        closeAllDropdowns();
    });
}

// ============================================================
// MARKET BROWSER
// ============================================================
function filterBrowserItems() {
    const searchVal = document.getElementById('browser-search').value.toLowerCase().trim();
    const tierVal = document.getElementById('browser-tier').value;
    const enchVal = document.getElementById('browser-enchantment').value;
    const catVal = document.getElementById('browser-category').value;

    // Smart search: parse Albion notation like "rootbound 6.2" or "T6.2 rootbound"
    let searchWords = searchVal.split(' ').filter(w => w);
    let parsedTier = null;
    let parsedEnch = null;
    const remainingWords = [];

    for (const word of searchWords) {
        // Match patterns like "6.2", "T6.2", "t6.2", "8.3"
        const tierEnchMatch = word.match(/^t?(\d)\.(\d)$/i);
        if (tierEnchMatch) {
            parsedTier = tierEnchMatch[1];
            parsedEnch = tierEnchMatch[2];
            continue;
        }
        // Match standalone tier like "T6" or "t6" (only if exactly 2 chars)
        const tierOnlyMatch = word.match(/^t(\d)$/i);
        if (tierOnlyMatch) {
            parsedTier = tierOnlyMatch[1];
            continue;
        }
        remainingWords.push(word);
    }

    browserFilteredItems = itemsList.filter(id => {
        // Tier filter (dropdown or parsed from search)
        const itemTier = extractTier(id);
        const effectiveTier = tierVal !== 'all' ? tierVal : parsedTier;
        if (effectiveTier && itemTier !== effectiveTier) return false;

        // Enchantment filter (dropdown or parsed from search)
        const itemEnch = extractEnchantment(id);
        const effectiveEnch = enchVal !== 'all' ? enchVal : parsedEnch;
        if (effectiveEnch && itemEnch !== effectiveEnch) return false;

        // Category filter
        if (catVal !== 'all') {
            if (categorizeItem(id) !== catVal) return false;
        }

        // Text search (remaining words after extracting tier/ench notation)
        if (remainingWords.length > 0) {
            const name = getFriendlyName(id);
            const tierEnchLabel = getTierEnchLabel(id);
            const target = (name + ' ' + id.replace(/_/g, ' ') + ' ' + tierEnchLabel).toLowerCase();
            return remainingWords.every(w => target.includes(w));
        }
        return true;
    });
}

async function renderBrowser() {
    filterBrowserItems();

    const container = document.getElementById('browser-results');
    const countEl = document.getElementById('browser-count');
    const total = browserFilteredItems.length;
    const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
    if (browserPage > totalPages) browserPage = totalPages;

    countEl.textContent = `${total.toLocaleString()} items`;

    // Get cached prices (module-level cache avoids re-reading IndexedDB on every page/filter)
    let priceMap = {};
    try {
        const allPrices = await getCachedPrices();
        for (const p of allPrices) {
            if (!priceMap[p.item_id]) priceMap[p.item_id] = [];
            priceMap[p.item_id].push(p);
        }
    } catch (e) { /* no data yet */ }

    // Update count with prices info so users know whether cached data exists for this server
    const priceCount = Object.keys(priceMap).length;
    if (priceCount > 0) {
        countEl.textContent = `${total.toLocaleString()} items · ${priceCount.toLocaleString()} prices cached`;
    } else if (getServer() !== vpsGameServer) {
        countEl.textContent = `${total.toLocaleString()} items · prices load on demand`;
    }

    const sortVal = document.getElementById('browser-sort').value;
    const qualityVal = document.getElementById('browser-quality').value;
    const cityVal = document.getElementById('browser-city').value;

    if (sortVal === 'name') {
        browserFilteredItems.sort((a, b) => getFriendlyName(a).localeCompare(getFriendlyName(b)));
    } else {
        const tempArr = browserFilteredItems.map(id => {
            const prices = priceMap[id] || [];
            let bestBuy = 0;
            let bestSell = Infinity;
            for (const p of prices) {
                if (qualityVal !== 'all' && p.quality.toString() !== qualityVal) continue;
                if (cityVal !== 'all' && p.city !== cityVal) continue;
                if (p.sell_price_min > 0 && p.sell_price_min < bestSell) bestSell = p.sell_price_min;
                if (p.buy_price_max > 0 && p.buy_price_max > bestBuy) bestBuy = p.buy_price_max;
            }
            if (bestSell === Infinity) bestSell = 0;
            return { id, bestBuy, bestSell };
        });

        if (sortVal === 'buy_low') {
            tempArr.sort((a, b) => {
                const aVal = a.bestSell > 0 ? a.bestSell : Infinity;
                const bVal = b.bestSell > 0 ? b.bestSell : Infinity;
                return aVal - bVal;
            });
        } else if (sortVal === 'sell_high') {
            tempArr.sort((a, b) => b.bestBuy - a.bestBuy);
        }
        browserFilteredItems = tempArr.map(x => x.id);
    }

    const start = (browserPage - 1) * ITEMS_PER_PAGE;
    const pageItems = browserFilteredItems.slice(start, start + ITEMS_PER_PAGE);

    container.innerHTML = '';

    if (pageItems.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <p>No items found</p>
            <p class="hint">Try adjusting your filters or search terms</p>
        </div>`;
        renderPagination(totalPages);
        return;
    }

    // FETH BATCHED HISTORY
    let batchedHistory = [];
    try {
        const server = getServer();
        const batchIds = pageItems.join(',');
        const locQuery = cityVal !== 'all' ? `&locations=${cityVal}` : '';
        const hRes = await fetch(`${CHART_API_URLS[server]}/${batchIds}.json?time-scale=24${locQuery}`);
        if (hRes.ok) {
            const hData = await hRes.json();
            if (Array.isArray(hData)) batchedHistory = hData;
        }
    } catch(e) {}

    for (const id of pageItems) {
        const name = getFriendlyName(id);
        const tier = extractTier(id);
        const prices = priceMap[id] || [];

        // Find best sell (lowest sell_price_min) and best buy (highest buy_price_max)
        let bestSell = null, bestBuy = null;
        for (const p of prices) {
            if (qualityVal !== 'all' && p.quality.toString() !== qualityVal) continue;
            if (cityVal !== 'all' && p.city !== cityVal) continue;
            if (p.sell_price_min > 0 && (!bestSell || p.sell_price_min < bestSell.sell_price_min)) bestSell = p;
            if (p.buy_price_max > 0 && (!bestBuy || p.buy_price_max > bestBuy.buy_price_max)) bestBuy = p;
        }

        // Parse History
        let vol24h = 0;
        let avg24h = 0;
        const itemHistoryList = batchedHistory.filter(h => h.item_id === id);
        if (itemHistoryList.length > 0) {
            let volSum = 0;
            let avgSum = 0;
            let avgCount = 0;
            for (const h of itemHistoryList) {
                if (h.data && h.data.item_count && h.data.item_count.length > 0) {
                    const lastVol = h.data.item_count[h.data.item_count.length - 1];
                    const lastAvg = h.data.prices_avg[h.data.prices_avg.length - 1];
                    if (lastVol > 0) {
                        volSum += lastVol;
                        avgSum += (lastAvg * lastVol);
                        avgCount += lastVol;
                    }
                }
            }
            if (avgCount > 0) {
                vol24h = volSum;
                avg24h = Math.round(avgSum / avgCount);
            }
        }

        let maxDateStr = '';
        if (bestBuy && bestBuy.buy_price_max_date && bestSell && bestSell.sell_price_min_date) {
            maxDateStr = bestBuy.buy_price_max_date > bestSell.sell_price_min_date ? bestBuy.buy_price_max_date : bestSell.sell_price_min_date;
        } else if (bestBuy && bestBuy.buy_price_max_date) {
            maxDateStr = bestBuy.buy_price_max_date;
        } else if (bestSell && bestSell.sell_price_min_date) {
            maxDateStr = bestSell.sell_price_min_date;
        }

        const card = document.createElement('div');
        card.className = 'item-card';
        card.innerHTML = `
            <div class="item-card-header">
                <div style="position: relative;">
                    <img class="item-card-icon" src="https://render.albiononline.com/v1/item/${id}.png" alt="" loading="lazy">
                    ${getEnchantmentBadge(id)}
                </div>
                <div class="item-card-info">
                    <div class="item-card-name" title="${esc(name)}">${esc(name)}</div>
                    <div class="item-card-id">${esc(id)} <span class="tier-badge">${getTierEnchLabel(id)}</span>${(() => { const w = getItemWeight(id); return w > 0 ? ` <span class="weight-badge">${w} kg</span>` : ''; })()}</div>
                </div>
            </div>
            <div class="item-card-prices">
                <div class="price-cell">
                    <div class="pc-label">Buy Price</div>
                    <div class="pc-value text-accent">${bestSell ? bestSell.sell_price_min.toLocaleString() + ' 💰' : '—'}</div>
                    <div class="pc-city">${bestSell ? esc(bestSell.city) : ''}</div>
                </div>
                <div class="price-cell">
                    <div class="pc-label">Sell Price</div>
                    <div class="pc-value text-green">${bestBuy ? bestBuy.buy_price_max.toLocaleString() + ' 💰' : '—'}</div>
                    <div class="pc-city">${bestBuy ? esc(bestBuy.city) : ''}</div>
                </div>
            </div>
            <div class="item-card-prices" style="padding-top:0.5rem; margin-top:0.5rem; border-top: 1px solid rgba(255,255,255,0.05);">
                <div class="price-cell">
                    <div class="pc-label" style="font-size:0.7rem; color:var(--text-muted);">24h Avg Price</div>
                    <div class="pc-value" style="font-size:0.85rem; color:#a89c8a;">${avg24h > 0 ? avg24h.toLocaleString() + ' 💰' : 'N/A'}</div>
                </div>
                <div class="price-cell">
                    <div class="pc-label" style="font-size:0.7rem; color:var(--text-muted);" title="Number of price data points recorded in the last 24 hours — higher means more market activity">24h Activity</div>
                    <div class="pc-value" style="font-size:0.85rem; color:#a89c8a;">${vol24h > 0 ? vol24h.toLocaleString() : 'N/A'}</div>
                </div>
            </div>
            <div style="text-align:center; font-size:0.7rem; color:var(--text-muted); padding: 0.5rem 0 0 0; font-style:italic;">
                ${getFreshnessIndicator(maxDateStr)} Updated: ${timeAgo(maxDateStr)}
            </div>
            <div class="item-card-actions">
                <button class="btn-card-action" data-action="compare" data-item="${id}" title="Compare prices across cities">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                    Compare
                </button>
                <button class="btn-card-action" data-action="refresh" data-item="${id}" title="Refresh this item's data">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                    Refresh
                </button>
                <button class="btn-card-action" data-action="graph" data-item="${id}" title="View price history">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline></svg>
                    Graph
                </button>
                <button class="btn-card-action" data-action="flips" data-item="${id}" title="Find flip opportunities for this item">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                    Flips
                </button>
            </div>
        `;
        container.appendChild(card);
    }

    // Wire up actions
    container.querySelectorAll('[data-action="compare"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const itemId = btn.dataset.item;
            switchToCompare(itemId);
        });
    });

    container.querySelectorAll('[data-action="refresh"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const itemId = btn.dataset.item;
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0;"></div>';
            try {
                const data = await fetchMarketChunk(getServer(), [itemId]);
                if (data.length > 0) await MarketDB.saveMarketData(data);
                trackContribution(1);
                await renderBrowser();
                await updateDbStatus();
            } catch (e) {
                console.error('Refresh failed:', e);
            }
            btn.disabled = false;
        });
    });

    container.querySelectorAll('[data-action="graph"]').forEach(btn => {
        btn.addEventListener('click', () => showGraph(btn.dataset.item));
    });

    container.querySelectorAll('[data-action="flips"]').forEach(btn => {
        btn.addEventListener('click', () => {
            // Switch to Market Flipper tab and scan for this item
            document.querySelector('[data-tab="arbitrage"]')?.click();
            setTimeout(() => doArbScan(btn.dataset.item), 200);
        });
    });

    renderPagination(totalPages);
}

function renderPagination(totalPages) {
    const topPag = document.getElementById('browser-pagination');
    const botPag = document.getElementById('browser-pagination-bottom');

    const html = buildPaginationHTML(totalPages);
    topPag.innerHTML = html;
    botPag.innerHTML = html;

    [topPag, botPag].forEach(container => {
        container.querySelectorAll('.page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = btn.dataset.page;
                if (page === 'prev') browserPage = Math.max(1, browserPage - 1);
                else if (page === 'next') browserPage = Math.min(totalPages, browserPage + 1);
                else browserPage = parseInt(page);
                renderBrowser();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
    });
}

function buildPaginationHTML(totalPages) {
    if (totalPages <= 1) return '';
    let html = `<button class="page-btn" data-page="prev" ${browserPage === 1 ? 'disabled' : ''}>‹</button>`;

    const maxVisible = 5;
    let start = Math.max(1, browserPage - Math.floor(maxVisible / 2));
    let end = Math.min(totalPages, start + maxVisible - 1);
    if (end - start + 1 < maxVisible) start = Math.max(1, end - maxVisible + 1);

    if (start > 1) {
        html += `<button class="page-btn" data-page="1">1</button>`;
        if (start > 2) html += `<span style="color:var(--text-muted);padding:0 0.3rem;">…</span>`;
    }

    for (let i = start; i <= end; i++) {
        html += `<button class="page-btn ${i === browserPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }

    if (end < totalPages) {
        if (end < totalPages - 1) html += `<span style="color:var(--text-muted);padding:0 0.3rem;">…</span>`;
        html += `<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
    }

    html += `<button class="page-btn" data-page="next" ${browserPage === totalPages ? 'disabled' : ''}>›</button>`;
    return html;
}

// ============================================================
// SPREAD STATS (Historical Confidence)
// ============================================================
async function loadSpreadStats() {
    const now = Date.now();
    // Cache for 10 minutes
    if (now - spreadStatsCacheTime < 10 * 60 * 1000 && Object.keys(spreadStatsCache).length > 0) return;
    try {
        const res = await fetch(`${VPS_BASE}/api/spread-stats/top?limit=2000&min_confidence=5`);
        if (!res.ok) return;
        const rows = await res.json();
        spreadStatsCache = {};
        for (const r of rows) {
            const key = `${r.item_id}_${r.quality}_${r.buy_city}_${r.sell_city}`;
            spreadStatsCache[key] = r;
        }
        spreadStatsCacheTime = now;
        console.log(`[SpreadStats] Loaded ${rows.length} spread stats`);
    } catch (e) {
        console.log('[SpreadStats] Failed to load:', e.message);
    }
}

function getSpreadStat(itemId, quality, buyCity, sellCity) {
    const key = `${itemId}_${quality}_${buyCity}_${sellCity}`;
    return spreadStatsCache[key] || null;
}

function getConfidenceBadge(confidence) {
    if (confidence === null || confidence === undefined) return '';
    let cls, label;
    if (confidence >= 70) { cls = 'confidence-high'; label = 'High'; }
    else if (confidence >= 40) { cls = 'confidence-mid'; label = 'Mid'; }
    else { cls = 'confidence-low'; label = 'Low'; }
    return `<span class="confidence-badge ${cls}" title="Historical confidence: ${confidence}% — Based on 7 days of server scans">${confidence}% ${label}</span>`;
}

function getTrendBadge(priceTrend) {
    if (priceTrend === null || priceTrend === undefined) return '';
    if (priceTrend > 2) {
        return `<span class="trend-badge trend-up" title="Price trending up ${priceTrend.toFixed(1)}% over last 7 days">&#9650; ${priceTrend.toFixed(1)}%</span>`;
    } else if (priceTrend < -2) {
        return `<span class="trend-badge trend-down" title="Price trending down ${Math.abs(priceTrend).toFixed(1)}% over last 7 days">&#9660; ${Math.abs(priceTrend).toFixed(1)}%</span>`;
    }
    return `<span class="trend-badge trend-neutral" title="Price stable (${priceTrend.toFixed(1)}% over 7 days)">&#8212; ${Math.abs(priceTrend).toFixed(1)}%</span>`;
}

function getVolatilityBadge(consistencyPct) {
    if (consistencyPct === null || consistencyPct === undefined) return '';
    if (consistencyPct < 50) {
        return `<span class="volatile-badge" title="High spread volatility — this route is only profitable ${consistencyPct}% of the time. Proceeds may vary significantly.">Volatile</span>`;
    }
    return '';
}

async function fetchAnalytics(itemId) {
    if (analyticsCache.has(itemId)) return analyticsCache.get(itemId);
    analyticsCache.set(itemId, 'pending');
    try {
        const res = await fetch(`${VPS_BASE}/api/analytics/${encodeURIComponent(itemId)}`);
        if (!res.ok) { analyticsCache.delete(itemId); return null; }
        const raw = await res.json();
        // Response is { cities: { "CityName": { price_trend, sma_7d, ... }, ... } }
        // Extract average price_trend across all cities
        let priceTrend = null;
        if (raw.cities) {
            const trends = Object.values(raw.cities)
                .map(c => c.price_trend)
                .filter(v => v !== null && v !== undefined && isFinite(v));
            if (trends.length > 0) {
                priceTrend = trends.reduce((a, b) => a + b, 0) / trends.length;
            }
        } else if (raw.metrics && raw.metrics.price_trend !== undefined) {
            priceTrend = raw.metrics.price_trend;
        }
        const data = { price_trend: priceTrend, _raw: raw };
        analyticsCache.set(itemId, data);
        return data;
    } catch {
        analyticsCache.delete(itemId);
        return null;
    }
}

function prefetchTrendBadges(container) {
    const seen = new Set();
    container.querySelectorAll('[data-trend-item]').forEach(el => {
        const itemId = el.dataset.trendItem;
        if (seen.has(itemId)) return;
        seen.add(itemId);
        fetchAnalytics(itemId).then(data => {
            if (!data || data === 'pending' || data.price_trend === null || data.price_trend === undefined) return;
            container.querySelectorAll(`[data-trend-item="${CSS.escape(itemId)}"]`).forEach(badge => {
                badge.outerHTML = getTrendBadge(data.price_trend);
            });
        });
    });
}

function computeSMA(values, period) {
    return values.map((_, i) => {
        if (i < period - 1) return null;
        const slice = values.slice(i - period + 1, i + 1).filter(v => v > 0);
        return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : null;
    });
}

function computeEMA(values, period) {
    const alpha = 2 / (period + 1);
    const result = [];
    let ema = null;
    for (let i = 0; i < values.length; i++) {
        if (values[i] <= 0) { result.push(ema); continue; }
        if (ema === null) { ema = values[i]; result.push(null); continue; }
        ema = alpha * values[i] + (1 - alpha) * ema;
        result.push(ema);
    }
    return result;
}

// ============================================================
// MARKET FLIPPING (ARBITRAGE)
// ============================================================
function processArbitrage(data, quality, tier, enchantment, includeBM, buyCityFilter, sellCityFilter, isSingleItem = false, freshMode = 'off', freshThresholdMins = 30, sortBy = 'profit', minConfidence = 0) {
    const itemsData = {};
    data.forEach(entry => {
        if (quality !== 'all' && entry.quality.toString() !== quality) return;
        if (tier !== 'all' && !entry.item_id.startsWith('T' + tier)) return;
        if (enchantment !== 'all' && extractEnchantment(entry.item_id) !== enchantment) return;
        if (entry.sell_price_min === 0 && entry.buy_price_max === 0) return;

        const itemKey = `${entry.item_id}_${entry.quality}`;
        if (!itemsData[itemKey]) itemsData[itemKey] = {};

        let city = entry.city;
        if (city && city.includes('Black Market')) city = 'Black Market';
        if (!CITIES.includes(city)) return;
        if (!includeBM && city === 'Black Market') return;

        let current = itemsData[itemKey][city];
        const sellDate = entry.sell_price_min_date || '';
        const buyDate = entry.buy_price_max_date || '';

        if (!current) {
            itemsData[itemKey][city] = { sellMin: entry.sell_price_min, buyMax: entry.buy_price_max, sellDate, buyDate };
        } else {
            if (entry.sell_price_min > 0 && (current.sellMin === 0 || entry.sell_price_min < current.sellMin)) {
                current.sellMin = entry.sell_price_min;
                if (sellDate > current.sellDate) current.sellDate = sellDate;
            }
            if (entry.buy_price_max > 0 && entry.buy_price_max > current.buyMax) {
                current.buyMax = entry.buy_price_max;
                if (buyDate > current.buyDate) current.buyDate = buyDate;
            }
        }
    });

    // Build cross-item median sell prices per item to detect junk listings
    const itemMedians = {};
    for (const [itemKey, citiesObj] of Object.entries(itemsData)) {
        const sells = Object.values(citiesObj).map(c => c.sellMin).filter(p => p > 0);
        if (sells.length >= 2) {
            sells.sort((a, b) => a - b);
            itemMedians[itemKey] = sells[Math.floor(sells.length / 2)];
        }
    }

    const trades = [];
    for (const [itemKey, citiesObj] of Object.entries(itemsData)) {
        const lastUnderscore = itemKey.lastIndexOf('_');
        const itemId = itemKey.substring(0, lastUnderscore);
        const qual = itemKey.substring(lastUnderscore + 1);
        const cities = Object.keys(citiesObj);

        for (let i = 0; i < cities.length; i++) {
            for (let j = 0; j < cities.length; j++) {
                if (i === j) continue;
                const cityBuy = cities[i];
                const citySell = cities[j];
                if (cityBuy === 'Black Market') continue;

                if (buyCityFilter !== 'all' && cityBuy !== buyCityFilter) continue;
                if (sellCityFilter !== 'all' && citySell !== sellCityFilter) continue;

                const priceBuy = citiesObj[cityBuy].sellMin;
                const priceSell = citiesObj[citySell].buyMax;

                // Skip junk/placeholder sell prices (buy-from side)
                // A price >20x the median for the same item is almost certainly a junk listing
                const median = itemMedians[itemKey];
                if (median && priceBuy > median * 20) continue;

                if (priceBuy > 0 && priceSell > 0) {
                    const tax = priceSell * TAX_RATE;
                    const profit = priceSell - priceBuy - tax;
                    
                    const destSellOrder = citiesObj[citySell].sellMin;
                    let soTax = 0;
                    let soProfit = 0;
                    if (destSellOrder > 0) {
                        soTax = destSellOrder * (TAX_RATE + SETUP_FEE); // 5.5% for sell orders
                        soProfit = destSellOrder - priceBuy - soTax;
                    }

                    if (profit > 0 || isSingleItem) {
                        // dateBuy = freshness of the price we BUY at (buy city's sell_price_min_date)
                        // dateSell = freshness of the price we SELL at (sell city's buy_price_max_date)
                        const dateBuy = citiesObj[cityBuy].sellDate;
                        const dateSell = citiesObj[citySell].buyDate;
                        const stat = getSpreadStat(itemId, qual, cityBuy, citySell);
                        trades.push({
                            itemId, quality: qual, buyCity: cityBuy, sellCity: citySell,
                            buyPrice: priceBuy, sellPrice: priceSell,
                            originBuyOrder: citiesObj[cityBuy].buyMax,
                            destSellOrder: destSellOrder,
                            tax, profit, roi: (profit / priceBuy) * 100,
                            soTax, soProfit, soRoi: destSellOrder > 0 ? (soProfit / priceBuy) * 100 : 0,
                            updateDate: dateBuy < dateSell ? dateBuy : dateSell,
                            dateBuy: dateBuy, dateSell: dateSell,
                            confidence: stat ? stat.confidence_score : null,
                            consistencyPct: stat ? stat.consistency_pct : null,
                            avgSpread: stat ? stat.avg_spread : null,
                            sampleCount: stat ? stat.sample_count : null
                        });
                    }
                }
            }
        }
    }
    // Apply freshness filter
    let filtered = trades;
    if (freshMode !== 'off') {
        const now = new Date();
        const thresholdMs = freshThresholdMins * 60 * 1000;
        filtered = trades.filter(t => {
            const buyAge = t.dateBuy && !t.dateBuy.startsWith('0001') ? now - new Date(t.dateBuy.endsWith('Z') ? t.dateBuy : t.dateBuy + 'Z') : Infinity;
            const sellAge = t.dateSell && !t.dateSell.startsWith('0001') ? now - new Date(t.dateSell.endsWith('Z') ? t.dateSell : t.dateSell + 'Z') : Infinity;
            if (freshMode === 'buy') return buyAge < thresholdMs;
            if (freshMode === 'sell') return sellAge < thresholdMs;
            return buyAge < thresholdMs && sellAge < thresholdMs; // 'both'
        });
    }

    // Apply confidence filter
    if (minConfidence > 0) {
        filtered = filtered.filter(t => t.confidence !== null && t.confidence >= minConfidence);
    }

    // Sort
    if (sortBy === 'confidence') {
        filtered.sort((a, b) => {
            const ca = a.confidence !== null ? a.confidence : -1;
            const cb = b.confidence !== null ? b.confidence : -1;
            if (cb !== ca) return cb - ca;
            return b.profit - a.profit;
        });
    } else if (sortBy === 'roi') {
        filtered.sort((a, b) => b.roi - a.roi);
    } else if (freshMode !== 'off') {
        filtered.sort((a, b) => {
            // Sort by the freshness side that matters for the selected mode
            let dateA, dateB;
            if (freshMode === 'buy') { dateA = a.dateBuy; dateB = b.dateBuy; }
            else if (freshMode === 'sell') { dateA = a.dateSell; dateB = b.dateSell; }
            else { dateA = a.dateBuy > a.dateSell ? a.dateBuy : a.dateSell; dateB = b.dateBuy > b.dateSell ? b.dateBuy : b.dateSell; }
            if (dateB > dateA) return 1;
            if (dateA > dateB) return -1;
            return b.profit - a.profit;
        });
    } else {
        filtered.sort((a, b) => b.profit - a.profit);
    }

    return filtered.slice(0, 60);
}

function buildArbitrageCardDOM(trade) {
    const card = document.createElement('div');
    card.className = 'trade-card';
    card.dataset.itemId = trade.itemId;
    card.dataset.buyCity = trade.buyCity;
    card.dataset.sellCity = trade.sellCity;
    card.innerHTML = `
        <div class="card-header">
            <div style="position: relative; display: flex;">
                <img class="item-icon" src="https://render.albiononline.com/v1/item/${trade.itemId}.png" alt="" loading="lazy">
                ${getEnchantmentBadge(trade.itemId)}
            </div>
            <div class="header-titles">
                <div class="item-name">${esc(getFriendlyName(trade.itemId))} <span class="trend-badge" data-trend-item="${esc(trade.itemId)}"></span></div>
                <span class="item-quality">${getQualityName(trade.quality)}</span>
            </div>
        </div>
        <div class="trade-route">
            <div class="city buy-city">
                <span class="route-label">Buy from (Instant Buy)</span>
                <strong class="city-name">${esc(trade.buyCity)}</strong>
                <div style="display:flex; align-items:center; gap:0.5rem; justify-content:center;">
                    <span class="price" title="Instant Buy (Cheapest Sell Order)">${Math.floor(trade.buyPrice).toLocaleString()} 💰</span>
                </div>
                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.3rem;">
                    Buy Order: <strong>${Math.floor(trade.originBuyOrder).toLocaleString()}</strong>
                </div>
            </div>
            <div class="arrow">➔</div>
            <div class="city sell-city">
                <span class="route-label">Sell to (Instant Sell)</span>
                <strong class="city-name">${esc(trade.sellCity)}</strong>
                <div style="display:flex; align-items:center; gap:0.5rem; justify-content:center;">
                    <span class="price" title="Instant Sell (Highest Buy Order)">${Math.floor(trade.sellPrice).toLocaleString()} 💰</span>
                </div>
                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.3rem;">
                    Sell Order: <strong>${Math.floor(trade.destSellOrder).toLocaleString()}</strong>
                </div>
            </div>
        </div>
        <div class="profit-section">
            <div style="font-size:0.85rem; font-weight:bold; color:var(--text-muted); margin-bottom:0.3rem;">Instant Sell Profit</div>
            <div class="profit-row"><span>Tax (3%):</span><span class="text-red">-${Math.floor(trade.tax).toLocaleString()} 💰</span></div>
            <div class="profit-row total"><span>Net Profit:</span><strong class="${trade.profit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(trade.profit).toLocaleString()} 💰</strong></div>
            <div class="roi-row"><span>ROI:</span><strong class="${trade.roi >= 0 ? 'text-green' : 'text-red'}">${trade.roi.toFixed(1)}%</strong></div>
        </div>
        ${trade.destSellOrder > 0 ? `
        <div class="profit-section" style="border-top:1px solid var(--border); margin-top:0.5rem; padding-top:0.5rem;">
            <div style="font-size:0.85rem; font-weight:bold; color:var(--text-muted); margin-bottom:0.3rem;">Sell Order Profit</div>
            <div class="profit-row"><span>Tax+Setup (5.5%):</span><span class="text-red">-${Math.floor(trade.soTax).toLocaleString()} 💰</span></div>
            <div class="profit-row total"><span>Net Profit:</span><strong class="${trade.soProfit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(trade.soProfit).toLocaleString()} 💰</strong></div>
            <div class="roi-row"><span>ROI:</span><strong class="${trade.soRoi >= 0 ? 'text-green' : 'text-red'}">${trade.soRoi.toFixed(1)}%</strong></div>
        </div>
        ` : ''}
        <div style="text-align:center; font-size:0.7rem; color:var(--text-muted); padding: 0.5rem 0 0 0; font-style:italic;">
            ${(() => {
                const ageMs = Math.max(
                    trade.dateBuy ? Date.now() - new Date(trade.dateBuy).getTime() : Infinity,
                    trade.dateSell ? Date.now() - new Date(trade.dateSell).getTime() : Infinity
                );
                const ageHrs = ageMs / 3600000;
                return ageHrs > 6 ? '<div class="stale-data-badge">STALE DATA — prices may have changed</div>' :
                       ageHrs > 2 ? '<div class="stale-data-badge mild">Data is 2+ hours old</div>' : '';
            })()}
            <div style="display:flex; justify-content:center; gap:1rem; flex-wrap:wrap;">
                <span title="Buy Data Age">${getFreshnessIndicator(trade.dateBuy)} ${esc(trade.buyCity)}: ${timeAgo(trade.dateBuy)}</span>
                <span title="Sell Data Age">${getFreshnessIndicator(trade.dateSell)} ${esc(trade.sellCity)}: ${timeAgo(trade.dateSell)}</span>
            </div>
            ${trade.confidence !== null ? `
            <div style="margin-top:0.4rem; display:flex; justify-content:center; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                ${getConfidenceBadge(trade.confidence)}
                ${getVolatilityBadge(trade.consistencyPct)}
                <span title="Profitable ${trade.consistencyPct}% of the time over 7 days (${trade.sampleCount} samples). Avg spread: ${trade.avgSpread ? Math.floor(trade.avgSpread).toLocaleString() : '?'} silver">
                    Profitable ${trade.consistencyPct}% of the time
                </span>
            </div>` : ''}
        </div>
        <div class="item-card-actions">
            <button class="btn-card-action" data-action="compare" data-item="${trade.itemId}" title="Compare prices across cities">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                Compare
            </button>
            <button class="btn-card-action" data-action="refresh" data-item="${trade.itemId}" title="Refresh this item's data">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                Refresh
            </button>
            <button class="btn-card-action" data-action="graph" data-item="${trade.itemId}" title="View price history">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline></svg>
                Graph
            </button>
            <button class="btn-card-action" data-action="craft" data-item="${trade.itemId}" title="Check crafting profit for this item">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                Craft?
            </button>
        </div>
    `;
    return card;
}

function renderArbitrage(trades, isSingleItem = false, targetItemId = null) {
    const container = document.getElementById('arbitrage-results');

    // Scroll results into view so the user sees the new data after re-scan
    if (!targetItemId) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    if (targetItemId) {
        let existingCards = Array.from(container.querySelectorAll('.trade-card[data-item-id="' + targetItemId + '"]'));
        
        trades.filter(t => t.itemId === targetItemId).forEach(t => {
            const oldCardIndex = existingCards.findIndex(c => c.dataset.buyCity === t.buyCity && c.dataset.sellCity === t.sellCity);
            let oldCard = null;
            if (oldCardIndex > -1) {
                oldCard = existingCards[oldCardIndex];
                existingCards.splice(oldCardIndex, 1);
            }
            
            const card = buildArbitrageCardDOM(t);
            if (oldCard) {
                oldCard.replaceWith(card);
            } else {
                // If no old card, append it. This might not maintain sort order,
                // but for single item refresh, it's usually just updating existing.
                container.appendChild(card);
            }
            setupCardButtons(card);
        });

        // Any leftover cards are no longer profitable for this item/route
        existingCards.forEach(c => c.remove());
        
        // Update total counter logic if targetItemId is used (optional polish)
        const countBar = document.querySelector('.result-count-bar strong');
        if (countBar) countBar.textContent = document.querySelectorAll('.trade-card').length;
        return;
    }

    container.innerHTML = '';

    if (trades.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>${isSingleItem ? 'No market data for this item.' : 'No profitable routes found.'}</p><p class="hint">Data refreshes automatically every 5 minutes. Try adjusting your filters.</p></div>`;
        return;
    }

    const countBar = document.createElement('div');
    countBar.className = 'result-count-bar';
    countBar.innerHTML = `Showing <strong>${trades.length}</strong> routes`;
    container.appendChild(countBar);

    trades.forEach(trade => {
        const card = buildArbitrageCardDOM(trade);
        container.appendChild(card);
    });

    setupCardButtons(container);
    prefetchTrendBadges(container);
}

async function doArbScan(targetItemId = null) {
    // Abort any previous scan in progress
    if (scanAbortController) scanAbortController.abort();
    scanAbortController = new AbortController();
    const signal = scanAbortController.signal;

    if (itemsList.length === 0) await loadData();
    await loadSpreadStats();

    const spinner = document.getElementById('arb-spinner');
    const errorEl = document.getElementById('arb-error'); // Restored to original 'arb-error'
    const container = document.getElementById('arbitrage-results');
    const searchInput = document.getElementById('arb-search');
    const quality = document.getElementById('arb-quality').value;
    const tier = document.getElementById('arb-tier').value;
    const enchantment = document.getElementById('arb-enchantment').value;
    const category = document.getElementById('arb-category').value;
    const buyCityFilter = document.getElementById('arb-buy-city').value;
    const sellCityFilter = document.getElementById('arb-sell-city').value;
    const includeBM = document.getElementById('include-black-market').checked;
    const freshMode = document.getElementById('fresh-mode').value;
    const freshThresholdMins = parseInt(document.getElementById('fresh-threshold').value) || 30;
    const sortBy = document.getElementById('arb-sort').value;
    const minConfidence = parseInt(document.getElementById('arb-min-confidence').value) || 0;

    if (!targetItemId) {
        hideError(errorEl);
        container.innerHTML = '';
        spinner.classList.remove('hidden');
    }

    let searchVal = searchInput.value.trim();
    let isSingleItem = false;

    // If the search box was cleared but arbSearchExactId lingers from a
    // previous autocomplete selection, reset it so we do a broad scan.
    if (!searchVal) arbSearchExactId = null;

    if (arbSearchExactId) {
        searchVal = arbSearchExactId;
    } else if (searchVal) {
        const match = itemsList.find(i => getFriendlyName(i).toLowerCase() === searchVal.toLowerCase() || i.toLowerCase() === searchVal.toLowerCase());
        if (match) searchVal = match;
        else searchVal = searchVal.toUpperCase();
    }

    let itemsToFetch = [];
    if (searchVal) {
        isSingleItem = true;
        itemsToFetch = [searchVal];
    } else {
        // Use cached data from IndexedDB
        try {
            const cachedData = await MarketDB.getAllPrices();
            if (cachedData.length > 0) {
                spinner.classList.add('hidden');

                // Filter by category
                let filteredData = cachedData;
                if (category !== 'all') {
                    filteredData = cachedData.filter(entry => {
                        if (recipesData[entry.item_id] && recipesData[entry.item_id].category === category) return true;
                        if (category === 'materials') return categorizeItem(entry.item_id) === 'materials' || categorizeItem(entry.item_id) === 'resources';
                        if (category === 'bags') return categorizeItem(entry.item_id) === 'accessories';
                        if (category === 'gear') return categorizeItem(entry.item_id) === 'weapons' || categorizeItem(entry.item_id) === 'armor';
                        return false;
                    });
                }

                const trades = processArbitrage(filteredData, quality, tier, enchantment, includeBM, buyCityFilter, sellCityFilter, isSingleItem, freshMode, freshThresholdMins, sortBy, minConfidence);
                renderArbitrage(trades, isSingleItem, targetItemId);
                return;
            } else {
                spinner.classList.add('hidden');
                errorEl.textContent = 'No market data available yet. Data loads automatically from the server — please wait a moment and try again.';
                errorEl.classList.remove('hidden');
                return;
            }
        } catch (e) { /* fall through */ }

        showError(errorEl, 'No cached data available yet. Data loads automatically from the server — please wait a moment and try again.');
        spinner.classList.add('hidden');
        return;
    }

    try {
        const server = getServer();
        const data = await fetchMarketData(server, itemsToFetch);
        if (data.length > 0) await MarketDB.saveMarketData(data);
        spinner.classList.add('hidden');
        const trades = processArbitrage(data, quality, tier, enchantment, includeBM, buyCityFilter, sellCityFilter, isSingleItem, freshMode, freshThresholdMins, sortBy, minConfidence);
        renderArbitrage(trades, isSingleItem);
        await updateDbStatus();
    } catch (e) {
        spinner.classList.add('hidden');
        showError(errorEl, 'Failed to fetch data: ' + e.message);
    }
}

// ============================================================
// CITY COMPARISON
// ============================================================
function switchToCompare(itemId) {
    // Switch to compare tab
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.nav-tab[data-tab="compare"]').classList.add('active');
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById('pane-compare').classList.remove('hidden');
    currentTab = 'compare';

    document.getElementById('compare-search').value = getFriendlyName(itemId);
    compareSelectedId = itemId;
    doCompare();
}

async function doCompare() {
    if (!compareSelectedId) return;

    const spinner = document.getElementById('compare-spinner');
    const container = document.getElementById('compare-results');
    const qualityFilter = document.getElementById('compare-quality').value;

    spinner.classList.remove('hidden');
    container.innerHTML = '';

    const itemId = compareSelectedId;
    const name = getFriendlyName(itemId);
    const server = getServer();

    try {
        // Fetch all qualities for this item
        const qualitiesParam = '&qualities=1,2,3,4,5';
        const url = `${API_URLS[server]}/${itemId}.json?${qualitiesParam}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.length > 0) await MarketDB.saveMarketData(data);

        spinner.classList.add('hidden');

        // Group by quality → city
        const byQuality = {};
        for (const entry of data) {
            const q = entry.quality || 1;
            if (qualityFilter !== 'all' && q.toString() !== qualityFilter) continue;
            if (!byQuality[q]) byQuality[q] = {};
            let city = entry.city;
            if (city && city.includes('Black Market')) city = 'Black Market';
            byQuality[q][city] = {
                sellMin: entry.sell_price_min || 0,
                sellMax: entry.sell_price_max || 0,
                buyMin: entry.buy_price_min || 0,
                buyMax: entry.buy_price_max || 0,
                sellDate: entry.sell_price_min_date || '',
                buyDate: entry.buy_price_max_date || ''
            };
        }

        if (Object.keys(byQuality).length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No price data available for this item${qualityFilter !== 'all' ? ' at this quality' : ''}.</p></div>`;
            return;
        }

        // Render header
        container.innerHTML = `
            <div class="compare-header">
                <div style="position: relative;">
                    <img src="https://render.albiononline.com/v1/item/${itemId}.png" alt="">
                    ${getEnchantmentBadge(itemId)}
                </div>
                <div style="flex:1;">
                    <h3>${esc(name)} <span class="tier-badge">${getTierEnchLabel(itemId)}</span></h3>
                    <span style="color:var(--text-muted);font-size:0.8rem;">${esc(itemId)}</span>
                </div>
                <div class="item-card-actions" style="margin-left: auto; display: flex; gap: 0.5rem; justify-content: flex-end;">
                    <button class="btn-card-action" data-action="refresh" data-item="${itemId}" title="Refresh this item's data">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        Refresh
                    </button>
                    <button class="btn-card-action" data-action="graph" data-item="${itemId}" title="View price history">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline></svg>
                        History
                    </button>
                </div>
            </div>
        `;

        // Render a table for each quality
        for (const [quality, cities] of Object.entries(byQuality)) {
            const qualName = getQualityName(quality);
            const orderedCities = CITIES.filter(c => cities[c]);
            if (orderedCities.length === 0) continue;

            // Calculate bests for highlighting
            const buyNowPrices = orderedCities.map(c => cities[c].sellMin).filter(v => v > 0);
            const sellNowPrices = orderedCities.map(c => cities[c].buyMax).filter(v => v > 0);
            const bestBuyNow = buyNowPrices.length > 0 ? Math.min(...buyNowPrices) : 0;
            const bestSellNow = sellNowPrices.length > 0 ? Math.max(...sellNowPrices) : 0;

            let tableHTML = `<h4 style="color:var(--accent);margin:1.5rem 0 0.5rem;font-size:0.9rem;">${qualName} Quality</h4>`;
            tableHTML += `<table class="compare-table"><thead><tr><th></th>`;
            orderedCities.forEach(c => tableHTML += `<th>${esc(c)}</th>`);
            tableHTML += `</tr></thead><tbody>`;

            // Row 1: Buy Now (instant buy = cheapest sell order)
            tableHTML += `<tr><td title="Cheapest sell order — the price to instantly buy this item">💰 Buy Now</td>`;
            orderedCities.forEach(c => {
                const v = cities[c].sellMin;
                const cls = v > 0 && v === bestBuyNow ? 'best-price' : '';
                tableHTML += `<td class="${cls}">${v > 0 ? v.toLocaleString() : '—'}</td>`;
            });
            tableHTML += `</tr>`;

            // Row 2: Sell Now (instant sell = highest buy order)
            tableHTML += `<tr><td title="Highest buy order — the price you'll receive if you sell instantly">💸 Sell Now</td>`;
            orderedCities.forEach(c => {
                const v = cities[c].buyMax;
                const cls = v > 0 && v === bestSellNow ? 'best-price' : '';
                tableHTML += `<td class="${cls}">${v > 0 ? v.toLocaleString() : '—'}</td>`;
            });
            tableHTML += `</tr>`;

            // Row 3: Sell Order Range
            tableHTML += `<tr class="detail-row"><td title="Range of current sell orders (min - max)">📊 Sell Orders</td>`;
            orderedCities.forEach(c => {
                const lo = cities[c].sellMin;
                const hi = cities[c].sellMax;
                if (lo > 0 && hi > 0 && lo !== hi) {
                    tableHTML += `<td>${lo.toLocaleString()} – ${hi.toLocaleString()}</td>`;
                } else if (lo > 0) {
                    tableHTML += `<td>${lo.toLocaleString()}</td>`;
                } else {
                    tableHTML += `<td>—</td>`;
                }
            });
            tableHTML += `</tr>`;

            // Row 4: Buy Order Range
            tableHTML += `<tr class="detail-row"><td title="Range of current buy orders (min - max)">📊 Buy Orders</td>`;
            orderedCities.forEach(c => {
                const lo = cities[c].buyMin;
                const hi = cities[c].buyMax;
                if (lo > 0 && hi > 0 && lo !== hi) {
                    tableHTML += `<td>${lo.toLocaleString()} – ${hi.toLocaleString()}</td>`;
                } else if (hi > 0) {
                    tableHTML += `<td>${hi.toLocaleString()}</td>`;
                } else {
                    tableHTML += `<td>—</td>`;
                }
            });
            tableHTML += `</tr>`;

            // Row 5: Spread (profit margin if you buy & sell in same city)
            tableHTML += `<tr class="detail-row"><td title="Difference between Sell Now and Buy Now in same city">📈 Spread</td>`;
            orderedCities.forEach(c => {
                const buy = cities[c].sellMin;
                const sell = cities[c].buyMax;
                if (buy > 0 && sell > 0) {
                    const spread = sell - buy;
                    const pct = ((spread / buy) * 100).toFixed(1);
                    const color = spread >= 0 ? 'var(--green)' : 'var(--red, #ef4444)';
                    tableHTML += `<td style="color:${color}">${spread >= 0 ? '+' : ''}${spread.toLocaleString()} (${pct}%)</td>`;
                } else {
                    tableHTML += `<td>—</td>`;
                }
            });
            tableHTML += `</tr>`;

            // Row 6: Last Updated
            tableHTML += `<tr class="updated-row"><td>🕐 Updated</td>`;
            orderedCities.forEach(c => {
                const d = cities[c].sellDate || cities[c].buyDate;
                tableHTML += `<td>${timeAgo(d)}</td>`;
            });
            tableHTML += `</tr>`;

            tableHTML += `</tbody></table>`;
            container.insertAdjacentHTML('beforeend', tableHTML);
        }

        // Wire up actions
        container.querySelectorAll('[data-action="refresh"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.item;
                btn.disabled = true;
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0;"></div>';
                try {
                    const chunk = await fetchMarketChunk(getServer(), [id]);
                    if (chunk.length > 0) await MarketDB.saveMarketData(chunk);
                    trackContribution(1);
                    await doCompare();
                } catch (e) {
                    console.error('Refresh failed:', e);
                }
                if (document.contains(btn)) {
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                }
            });
        });

        container.querySelectorAll('[data-action="graph"]').forEach(btn => {
            btn.addEventListener('click', () => showGraph(btn.dataset.item));
        });

        await updateDbStatus();
    } catch (e) {
        spinner.classList.add('hidden');
        container.innerHTML = `<div class="empty-state"><p>Error fetching data: ${esc(e.message)}</p></div>`;
    }
}

// ============================================================
// CRAFTING PROFITS
// ============================================================

function calculateRRR(useFocus, cityBonusPct) {
    const basePB = 18; // Royal city base production bonus
    const focusPB = useFocus ? 59 : 0;
    const totalPB = basePB + cityBonusPct + focusPB;
    return 1 - 1 / (1 + totalPB / 100);
}

function calculateFocusCost(baseCost, specLevel, masteryLevel) {
    const reduction = (specLevel * 0.6 + masteryLevel * 0.3);
    return Math.max(1, Math.floor(baseCost * (1 - reduction / 100)));
}

// ====== SINGLE ITEM CRAFTING CALCULATOR ======
let craftDetailItemId = null;

async function doCraftSearch() {
    if (itemsList.length === 0) await loadData();

    const itemId = craftSearchExactId || document.getElementById('craft-search').value.trim();
    if (!itemId) return;

    // Resolve to exact ID
    let resolvedId = craftSearchExactId;
    if (!resolvedId) {
        const searchLower = itemId.toLowerCase();
        // Try exact match in recipes first
        for (const id of Object.keys(recipesData)) {
            if (getFriendlyName(id).toLowerCase() === searchLower || id.toLowerCase() === searchLower) {
                resolvedId = id;
                break;
            }
        }
        if (!resolvedId) {
            // Fuzzy search
            const words = searchLower.split(' ').filter(w => w);
            for (const id of Object.keys(recipesData)) {
                const target = (getFriendlyName(id) + ' ' + id.replace(/_/g, ' ')).toLowerCase();
                if (words.every(w => target.includes(w))) {
                    resolvedId = id;
                    break;
                }
            }
        }
    }

    if (!resolvedId || !recipesData[resolvedId]) {
        showError(document.getElementById('craft-error'), 'No recipe found for this item. Try another search.');
        return;
    }

    craftDetailItemId = resolvedId;
    const recipe = recipesData[resolvedId];

    const spinner = document.getElementById('craft-spinner');
    const errorEl = document.getElementById('craft-error');
    hideError(errorEl);
    spinner.classList.remove('hidden');

    // Show settings panel
    document.getElementById('craft-settings').style.display = 'flex';
    document.getElementById('craft-detail-view').style.display = 'block';
    document.getElementById('craft-bulk-section').style.display = 'none';

    try {
        const server = getServer();
        // Fetch prices for finished item (all qualities) + all materials across all cities
        const allItemIds = [resolvedId, ...recipe.materials.map(m => m.id)];
        const uniqueIds = [...new Set(allItemIds)];
        const data = await fetchMarketData(server, uniqueIds);
        if (data.length > 0) await MarketDB.saveMarketData(data);

        // Store raw data for recalculation with different quality/settings
        window._craftLastData = data;
        window._craftLastRecipe = recipe;
        window._craftLastItemId = resolvedId;

        spinner.classList.add('hidden');
        renderCraftDetail(resolvedId, recipe, data);
        await updateDbStatus();
    } catch (e) {
        spinner.classList.add('hidden');
        showError(errorEl, 'Failed to fetch data: ' + e.message);
    }
}

function renderCraftDetail(itemId, recipe, data) {
    const container = document.getElementById('craft-detail-view');
    const name = getFriendlyName(itemId);

    // Read settings
    const useFocus = document.getElementById('craft-use-focus').checked;
    const specLevel = parseInt(document.getElementById('craft-spec').value) || 0;
    const masteryLevel = parseInt(document.getElementById('craft-mastery').value) || 0;
    const cityBonusPct = parseFloat(document.getElementById('craft-city-bonus').value) || 0;
    const stationFee = parseFloat(document.getElementById('craft-fee').value) || 0;
    const craftQuality = parseInt(document.getElementById('craft-quality')?.value) || 1;
    const rrr = calculateRRR(useFocus, cityBonusPct);
    const effectiveMultiplier = 1 - rrr;

    // Index prices by item_id → city (filter finished item by selected quality)
    const priceIndex = {};
    for (const entry of data) {
        const id = entry.item_id;
        const q = entry.quality || 1;
        // For the finished item, only include prices matching selected quality
        // For materials, include all qualities (materials are always Q1)
        if (id === itemId && q !== craftQuality) continue;
        let city = entry.city;
        if (city && city.includes('Black Market')) city = 'Black Market';
        if (!priceIndex[id]) priceIndex[id] = {};
        const existing = priceIndex[id][city];
        if (!existing) {
            priceIndex[id][city] = {
                sellMin: entry.sell_price_min || 0,
                buyMax: entry.buy_price_max || 0,
                sellDate: entry.sell_price_min_date || '',
                buyDate: entry.buy_price_max_date || ''
            };
        } else {
            if (entry.sell_price_min > 0 && (existing.sellMin === 0 || entry.sell_price_min < existing.sellMin)) {
                existing.sellMin = entry.sell_price_min;
            }
            if (entry.buy_price_max > 0 && entry.buy_price_max > existing.buyMax) {
                existing.buyMax = entry.buy_price_max;
            }
        }
    }

    const buyCities = CITIES.filter(c => c !== 'Black Market');

    // ===== Material cost table =====
    let matTableHTML = `<div class="craft-detail-section">
        <h3>📦 Materials Required</h3>
        <div class="craft-detail-info">
            <span class="rrr-badge">RRR: ${(rrr * 100).toFixed(1)}%</span>
            ${useFocus ? '<span class="focus-badge">🔮 Focus Active</span>' : ''}
        </div>
        <div class="table-scroll-wrapper">
        <table class="compare-table craft-cost-table">
            <thead><tr><th>Material</th><th>Qty</th><th>Eff. Qty</th>`;
    buyCities.forEach(c => matTableHTML += `<th>${c}</th>`);
    matTableHTML += `</tr></thead><tbody>`;

    const matCostByCity = {}; // city → total cost
    buyCities.forEach(c => matCostByCity[c] = 0);
    let anyMissing = false;

    for (const mat of recipe.materials) {
        const effectiveQty = Math.ceil(mat.qty * effectiveMultiplier * 100) / 100;
        const matPrices = priceIndex[mat.id] || {};
        const matName = getFriendlyName(mat.id);

        matTableHTML += `<tr>
            <td class="mat-cell">
                <img class="mat-icon-sm" src="https://render.albiononline.com/v1/item/${mat.id}.png" alt="" loading="lazy">
                <span>${matName}</span>
            </td>
            <td>${mat.qty}</td>
            <td class="text-accent">${effectiveQty.toFixed(1)}</td>`;

        let cheapestPrice = Infinity;
        buyCities.forEach(c => {
            const p = matPrices[c];
            const price = p ? p.sellMin : 0;
            if (price > 0 && price < cheapestPrice) cheapestPrice = price;
        });

        buyCities.forEach(c => {
            const p = matPrices[c];
            const sellPrice = p ? p.sellMin : 0;
            const buyPrice = p ? p.buyMax : 0;
            const totalSellCost = sellPrice > 0 ? Math.ceil(sellPrice * effectiveQty) : 0;
            const totalBuyCost = buyPrice > 0 ? Math.ceil(buyPrice * effectiveQty) : 0;
            
            if (totalSellCost > 0) {
                matCostByCity[c] += totalSellCost;
            } else {
                matCostByCity[c] = Infinity;
            }
            
            const isCheapest = sellPrice > 0 && sellPrice === cheapestPrice;
            matTableHTML += `<td class="${isCheapest ? 'best-price' : ''}">
                <div style="font-weight:700" title="Cost if Insta-Bought">${totalSellCost > 0 ? totalSellCost.toLocaleString() : '—'}</div>
                <div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px;" title="Cost if Buy Ordered">B.O: ${totalBuyCost > 0 ? totalBuyCost.toLocaleString() : '—'}</div>
            </td>`;
        });
        matTableHTML += `</tr>`;

        if (cheapestPrice === Infinity) anyMissing = true;
    }

    // Totals row
    matTableHTML += `<tr class="total-row"><td colspan="3"><strong>Total Material Cost</strong></td>`;
    let cheapestTotal = Infinity;
    buyCities.forEach(c => {
        if (matCostByCity[c] < cheapestTotal && matCostByCity[c] !== Infinity) cheapestTotal = matCostByCity[c];
    });
    buyCities.forEach(c => {
        const cost = matCostByCity[c];
        const isBest = cost === cheapestTotal && cost !== Infinity;
        matTableHTML += `<td class="${isBest ? 'best-price' : ''}">${cost !== Infinity ? cost.toLocaleString() : '—'}</td>`;
    });
    matTableHTML += `</tr></tbody></table></div></div>`;

    // ===== Sell price comparison =====
    const finishedPrices = priceIndex[itemId] || {};
    const outputQty = recipe.output || 1;
    const outputSuffix = outputQty > 1 ? ` (x${outputQty})` : '';

    let sellHTML = `<div class="craft-detail-section">
        <h3>💰 Sell Price Comparison</h3>
        <div class="table-scroll-wrapper">
        <table class="compare-table craft-cost-table">
            <thead><tr><th></th>`;
    CITIES.forEach(c => sellHTML += `<th>${c}</th>`);
    sellHTML += `</tr></thead><tbody>`;

    // Sell Now (buy orders = buyMax)
    let bestSellNow = 0;
    CITIES.forEach(c => {
        const p = finishedPrices[c];
        const v = p ? p.buyMax : 0;
        if (v > bestSellNow) bestSellNow = v;
    });
    sellHTML += `<tr><td>Insta-Sell${outputSuffix}<br><small style="color:var(--text-muted);font-weight:normal;">(to highest Buy Order)</small></td>`;
    CITIES.forEach(c => {
        const p = finishedPrices[c];
        const v = p ? p.buyMax : 0;
        const totalV = v * outputQty;
        sellHTML += `<td class="${v > 0 && v === bestSellNow ? 'best-price' : ''}">${totalV > 0 ? totalV.toLocaleString() : '—'}</td>`;
    });
    sellHTML += `</tr>`;

    // Place Sell Order (buy now price = sellMin)
    let bestSellOrder = 0;
    CITIES.forEach(c => {
        const p = finishedPrices[c];
        const v = p ? p.sellMin : 0;
        if (v > bestSellOrder) bestSellOrder = v;
    });
    sellHTML += `<tr><td>Sell Order${outputSuffix}<br><small style="color:var(--text-muted);font-weight:normal;">(undercut lowest Sell Order)</small></td>`;
    CITIES.forEach(c => {
        const p = finishedPrices[c];
        const v = p ? p.sellMin : 0;
        const totalV = v * outputQty;
        sellHTML += `<td class="${v > 0 && v === bestSellOrder ? 'best-price' : ''}">${totalV > 0 ? totalV.toLocaleString() : '—'}</td>`;
    });
    sellHTML += `</tr>`;

    // Profit row (using cheapest materials)
    if (cheapestTotal !== Infinity) {
        sellHTML += `<tr class="total-row"><td><strong>Net Profit</strong></td>`;
        CITIES.forEach(c => {
            const p = finishedPrices[c];
            const sellPrice = p ? p.buyMax : 0;
            if (sellPrice > 0) {
                const totalRevenue = sellPrice * outputQty;
                const tax = totalRevenue * (TAX_RATE + SETUP_FEE); // 5.5% for sell orders
                const fee = totalRevenue * (stationFee / 100);     // station fee on item value
                const profit = totalRevenue - cheapestTotal - tax - fee;
                const cls = profit >= 0 ? 'text-green' : 'text-red';
                sellHTML += `<td class="${cls}"><strong>${Math.floor(profit).toLocaleString()}</strong></td>`;
            } else {
                sellHTML += `<td>—</td>`;
            }
        });
        sellHTML += `</tr>`;
    }

    sellHTML += `</tbody></table></div></div>`;

    // ===== Summary card =====
    let bestProfit = -Infinity, bestCity = '', bestSellPrice = 0;
    CITIES.forEach(c => {
        const p = finishedPrices[c];
        const sellPrice = p ? p.buyMax : 0;
        if (sellPrice > 0 && cheapestTotal !== Infinity) {
            const tax = sellPrice * (TAX_RATE + SETUP_FEE); // 5.5% for sell orders
            const fee = sellPrice * (stationFee / 100);     // station fee on item value
            const profit = sellPrice - cheapestTotal - tax - fee;
            if (profit > bestProfit) {
                bestProfit = profit;
                bestCity = c;
                bestSellPrice = sellPrice;
            }
        }
    });

    let summaryHTML = `<div class="craft-summary-card">
        <div class="craft-summary-header">
            <div style="position:relative;display:flex;">
                <img class="item-icon" src="https://render.albiononline.com/v1/item/${itemId}.png" alt="" loading="lazy">
                ${getEnchantmentBadge(itemId)}
            </div>
            <div>
                <h2>${name} <span class="tier-badge">${getTierEnchLabel(itemId)}</span></h2>
                <span style="color:var(--text-muted);font-size:0.8rem;">${itemId}</span>
            </div>
        </div>`;

    if (bestProfit > -Infinity) {
        const roi = cheapestTotal > 0 ? (bestProfit / cheapestTotal * 100).toFixed(1) : '0.0';
        const gaugeWidth = Math.min(100, Math.abs(parseFloat(roi)));
        // Focus cost calculation
        const baseFocusCost = recipe.focusCost || 0;
        const focusCost = baseFocusCost > 0 ? calculateFocusCost(baseFocusCost, specLevel, masteryLevel) : 0;
        const qualityLabel = craftQuality > 1 ? ` (Q${craftQuality})` : '';
        summaryHTML += `
        <div class="craft-summary-stats">
            <div class="stat-box"><div class="stat-label">Cheapest Materials</div><div class="stat-value">${cheapestTotal.toLocaleString()} s</div></div>
            <div class="stat-box"><div class="stat-label">Best Sell${qualityLabel} (${bestCity})</div><div class="stat-value text-accent">${bestSellPrice.toLocaleString()} s</div></div>
            <div class="stat-box"><div class="stat-label">Tax+Setup (5.5%)</div><div class="stat-value text-red">-${Math.floor(bestSellPrice * (TAX_RATE + SETUP_FEE)).toLocaleString()}</div></div>
            ${stationFee > 0 ? `<div class="stat-box"><div class="stat-label">Station Fee (${stationFee}%)</div><div class="stat-value text-red">-${Math.floor(bestSellPrice * stationFee / 100).toLocaleString()}</div></div>` : ''}
            <div class="stat-box highlight"><div class="stat-label">Net Profit</div><div class="stat-value ${bestProfit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(bestProfit).toLocaleString()} s</div></div>
            <div class="stat-box"><div class="stat-label">ROI</div><div class="stat-value ${bestProfit >= 0 ? 'text-green' : 'text-red'}">${roi}%</div></div>
            ${useFocus && focusCost > 0 ? `<div class="stat-box"><div class="stat-label">Focus Cost</div><div class="stat-value" style="color:#a78bfa;">${focusCost.toLocaleString()} focus</div></div>
            <div class="stat-box"><div class="stat-label">Silver/Focus</div><div class="stat-value" style="color:#a78bfa;">${focusCost > 0 ? (bestProfit / focusCost).toFixed(1) : '0'} s/f</div></div>` : ''}
        </div>
        <div class="profit-gauge"><div class="profit-gauge-fill ${bestProfit >= 0 ? 'positive' : 'negative'}" style="width:${gaugeWidth}%"></div></div>`;
    } else {
        summaryHTML += `<div class="craft-summary-stats"><div class="stat-box"><div class="stat-value">No profitable route found</div></div></div>`;
    }
    summaryHTML += `</div>`;

    container.innerHTML = summaryHTML + matTableHTML + sellHTML;

    // Generate shopping list grouped by cheapest city
    generateShoppingList(recipe, itemId, priceIndex, effectiveMultiplier);
}

// ====== BULK SCAN (legacy) ======
function processCrafting(data, tier, sortBy) {
    const useFocus = document.getElementById('craft-use-focus')?.checked || false;
    const cityBonusPct = parseFloat(document.getElementById('craft-city-bonus')?.value) || 0;
    const stationFee = parseFloat(document.getElementById('craft-fee')?.value) || 0;
    const rrr = calculateRRR(useFocus, cityBonusPct);
    const effectiveMultiplier = 1 - rrr;

    const prices = {};
    data.forEach(entry => {
        if (entry.sell_price_min === 0 && entry.buy_price_max === 0) return;
        if (tier !== 'all' && !entry.item_id.startsWith('T' + tier)) return;

        if (!prices[entry.item_id]) prices[entry.item_id] = {};
        if (!prices[entry.item_id][entry.quality]) prices[entry.item_id][entry.quality] = {};

        let city = entry.city;
        if (city && city.includes('Black Market')) city = 'Black Market';
        if (!CITIES.includes(city)) return;

        let current = prices[entry.item_id][entry.quality][city];
        const entryDate = entry.sell_price_min_date > entry.buy_price_max_date ? entry.sell_price_min_date : entry.buy_price_max_date;

        if (!current) {
            prices[entry.item_id][entry.quality][city] = {
                sell: entry.sell_price_min, buy: entry.buy_price_max, updateDate: entryDate
            };
        } else {
            if (entry.sell_price_min > 0 && (current.sell === 0 || entry.sell_price_min < current.sell)) current.sell = entry.sell_price_min;
            if (entry.buy_price_max > 0 && entry.buy_price_max > current.buy) current.buy = entry.buy_price_max;
            if (entryDate > '0001' && entryDate > current.updateDate) current.updateDate = entryDate;
        }
    });

    const crafts = [];
    for (const [finishedItem, recipe] of Object.entries(recipesData)) {
        if (!prices[finishedItem]) continue;

        for (const [quality, citiesObj] of Object.entries(prices[finishedItem])) {
            let bestSellCity = null, bestSellPrice = 0, finalDate = '0001';
            for (const city of Object.keys(citiesObj)) {
                if (citiesObj[city].buy > bestSellPrice) {
                    bestSellPrice = citiesObj[city].buy;
                    bestSellCity = city;
                    finalDate = citiesObj[city].updateDate;
                }
            }
            if (bestSellPrice === 0) continue;

            let totalMatCost = 0, missingMat = false;
            const matBreakdown = [];

            for (const mat of recipe.materials) {
                if (!prices[mat.id]) { missingMat = true; break; }
                let bestBuyCity = null, bestBuyPrice = Infinity, matDate = '0001';

                for (const [matQual, matCities] of Object.entries(prices[mat.id])) {
                    for (const city of Object.keys(matCities)) {
                        if (city === 'Black Market') continue;
                        if (matCities[city].sell > 0 && matCities[city].sell < bestBuyPrice) {
                            bestBuyPrice = matCities[city].sell;
                            bestBuyCity = city;
                            matDate = matCities[city].updateDate;
                        }
                    }
                }
                if (bestBuyPrice === Infinity) { missingMat = true; break; }
                const effectiveQty = mat.qty * effectiveMultiplier;
                const cost = bestBuyPrice * effectiveQty;
                totalMatCost += cost;
                matBreakdown.push({ id: mat.id, qty: mat.qty, effectiveQty: +effectiveQty.toFixed(1), city: bestBuyCity, unitPrice: bestBuyPrice, total: cost, updateDate: matDate });
            }
            if (missingMat) continue;

            const tax = bestSellPrice * (TAX_RATE + SETUP_FEE); // 5.5% for sell orders
            const fee = bestSellPrice * (stationFee / 100);     // station fee on item value
            const profit = bestSellPrice - totalMatCost - tax - fee;
            const roi = (profit / totalMatCost) * 100;

            let oldestDate = finalDate;
            for (const mat of matBreakdown) {
                if (mat.updateDate < oldestDate) oldestDate = mat.updateDate;
            }

            crafts.push({
                itemId: finishedItem, quality, sellCity: bestSellCity, sellPrice: bestSellPrice,
                matCost: totalMatCost, mats: matBreakdown, tax, fee, profit, roi,
                updateDate: oldestDate, category: recipe.category || 'other'
            });
        }
    }

    if (sortBy === 'roi') crafts.sort((a, b) => b.roi - a.roi);
    else if (sortBy === 'name') crafts.sort((a, b) => getFriendlyName(a.itemId).localeCompare(getFriendlyName(b.itemId)));
    else crafts.sort((a, b) => b.profit - a.profit);

    return crafts.slice(0, 60);
}

function renderCrafting(crafts) {
    const container = document.getElementById('crafting-results');
    container.innerHTML = '';

    if (crafts.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No profitable recipes found.</p><p class="hint">Scan the market first, then try again.</p></div>`;
        return;
    }

    const countBar = document.createElement('div');
    countBar.className = 'result-count-bar';
    countBar.innerHTML = `Showing <strong>${crafts.length}</strong> recipes`;
    container.appendChild(countBar);

    crafts.forEach(craft => {
        const card = document.createElement('div');
        card.className = 'craft-card';

        let matsHTML = '';
        craft.mats.forEach(mat => {
            matsHTML += `
                <div class="mat-item">
                    <div class="mat-info">
                        <div style="position: relative; display: flex;">
                            <img class="mat-icon" src="https://render.albiononline.com/v1/item/${mat.id}.png" alt="" loading="lazy">
                            ${getEnchantmentBadge(mat.id)}
                        </div>
                        <span>${mat.effectiveQty || mat.qty}x ${esc(getFriendlyName(mat.id))} <span class="mat-city">from ${esc(mat.city)}</span></span>
                    </div>
                    <span>${Math.floor(mat.total).toLocaleString()} 💰</span>
                </div>
            `;
        });

        const gaugeWidth = Math.min(100, Math.abs(craft.roi));
        const gaugeClass = craft.profit >= 0 ? 'positive' : 'negative';

        card.innerHTML = `
            <div class="card-header">
                <div style="position: relative; display: flex;">
                    <img class="item-icon" src="https://render.albiononline.com/v1/item/${craft.itemId}.png" alt="" loading="lazy">
                    ${getEnchantmentBadge(craft.itemId)}
                </div>
                <div class="header-titles">
                    <div class="item-name">${esc(getFriendlyName(craft.itemId))}</div>
                    <span class="item-quality">${getQualityName(craft.quality)}</span>
                </div>
            </div>
            <div class="craft-materials">
                <div class="craft-materials-title">Materials Required (after ${(calculateRRR(document.getElementById('craft-use-focus')?.checked || false, parseFloat(document.getElementById('craft-city-bonus')?.value) || 0) * 100).toFixed(1)}% RRR)</div>
                ${matsHTML}
                <div class="total-mat-cost">Total Cost: ${Math.floor(craft.matCost).toLocaleString()} 💰</div>
            </div>
            <div class="craft-sell-route">
                <div>
                    <div class="craft-sell-label">Sell to</div>
                    <strong class="city-name">${esc(craft.sellCity)}</strong>
                </div>
                <span class="price text-accent">${Math.floor(craft.sellPrice).toLocaleString()} 💰</span>
            </div>
            <div class="profit-section">
                <div class="profit-row"><span>Tax+Setup (5.5%):</span><span class="text-red">-${Math.floor(craft.tax).toLocaleString()} 💰</span></div>
                ${craft.fee > 0 ? `<div class="profit-row"><span>Station Fee:</span><span class="text-red">-${Math.floor(craft.fee).toLocaleString()} 💰</span></div>` : ''}
                <div class="profit-row total"><span>Net Profit:</span><strong class="${craft.profit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(craft.profit).toLocaleString()} 💰</strong></div>
                <div class="roi-row"><span>ROI:</span><strong class="${craft.roi >= 0 ? 'text-green' : 'text-red'}">${craft.roi.toFixed(1)}%</strong></div>
                <div class="profit-gauge"><div class="profit-gauge-fill ${gaugeClass}" style="width:${gaugeWidth}%"></div></div>
            </div>
            <div style="text-align:center; font-size:0.7rem; color:var(--text-muted); padding: 0.5rem 0 0 0; font-style:italic;">
                Updated: ${timeAgo(craft.updateDate)}
            </div>
            <div class="item-card-actions">
                <button class="btn-card-action" data-action="compare" data-item="${craft.itemId}" title="Compare prices across cities">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                    Compare
                </button>
                <button class="btn-card-action" data-action="refresh" data-item="${craft.itemId}" title="Refresh this item's data">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                    Refresh
                </button>
                <button class="btn-card-action" data-action="graph" data-item="${craft.itemId}" title="View price history">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline></svg>
                    Graph
                </button>
            </div>
        `;
        container.appendChild(card);
    });

    setupCardButtons(container);
}

async function doCraftScan() {
    if (itemsList.length === 0) await loadData();

    const spinner = document.getElementById('craft-spinner');
    const errorEl = document.getElementById('craft-error');
    const tier = document.getElementById('craft-tier').value;
    const sortBy = document.getElementById('craft-sort').value;

    hideError(errorEl);
    document.getElementById('crafting-results').innerHTML = '';
    document.getElementById('craft-detail-view').style.display = 'none';
    document.getElementById('craft-bulk-section').style.display = 'block';
    document.getElementById('craft-settings').style.display = 'flex';
    spinner.classList.remove('hidden');

    try {
        const cachedData = await MarketDB.getAllPrices();
        spinner.classList.add('hidden');

        if (cachedData.length === 0) {
            showError(errorEl, 'No cached data available yet. Data loads automatically — please wait a moment and try again.');
            return;
        }

        // Filter by search
        const searchVal = (craftSearchExactId || document.getElementById('craft-search').value.trim()).toLowerCase();
        let filteredData = cachedData;
        if (searchVal) {
            const matchingRecipes = Object.keys(recipesData).filter(id => {
                const name = getFriendlyName(id).toLowerCase();
                return name.includes(searchVal) || id.toLowerCase().includes(searchVal);
            });
            const relevantIds = new Set();
            matchingRecipes.forEach(id => {
                relevantIds.add(id);
                recipesData[id].materials.forEach(m => relevantIds.add(m.id));
            });
            filteredData = cachedData.filter(e => relevantIds.has(e.item_id));
        }

        const crafts = processCrafting(filteredData, tier, sortBy);
        renderCrafting(crafts);
    } catch (e) {
        spinner.classList.add('hidden');
        showError(errorEl, 'Error: ' + e.message);
    }
}

// ============================================================
// SHARED HELPERS
// ============================================================
function setupCardButtons(container) {
    container.querySelectorAll('[data-action="compare"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            switchToCompare(btn.dataset.item);
        });
    });

    container.querySelectorAll('[data-action="refresh"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const itemId = btn.dataset.item;
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0;"></div>';
            try {
                const data = await fetchMarketChunk(getServer(), [itemId]);
                if (data.length > 0) await MarketDB.saveMarketData(data);
                trackContribution(1);
                await updateDbStatus();

                // Natively hot-swap via local targetItemId logic!
                if (currentTab === 'browser') {
                    // Temporarily using strict scroll restore for Browser
                    const scrollY = window.scrollY;
                    await renderBrowser();
                    window.scrollTo(0, scrollY);
                }
                else if (currentTab === 'arbitrage') await doArbScan(itemId);
                else if (currentTab === 'crafting') {
                    const scrollY = window.scrollY;
                    await doCraftScan();
                    window.scrollTo(0, scrollY);
                }
                else if (currentTab === 'transport' && lastTransportRoutes) {
                    const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
                    const sortBy = document.getElementById('transport-sort').value;
                    const { mountCapacity, freeSlots } = getTransportMountConfig();
                    await enrichAndRenderTransport(lastTransportRoutes, budget, sortBy, mountCapacity, freeSlots);
                }
            } catch (err) {
                console.error('Refresh failed:', err);
            }
            btn.disabled = false;
        });
    });

    container.querySelectorAll('[data-action="graph"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showGraph(btn.dataset.item);
        });
    });

    container.querySelectorAll('[data-action="craft"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            switchToCraft(btn.dataset.item);
        });
    });

    container.querySelectorAll('[data-action="flips"]').forEach(btn => {
        if (btn._flipsWired) return;
        btn._flipsWired = true;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelector('[data-tab="arbitrage"]')?.click();
            setTimeout(() => doArbScan(btn.dataset.item), 200);
        });
    });
}

function switchToCraft(itemId) {
    // Switch to crafting tab and pre-fill the search with this item
    document.querySelector('[data-tab="crafting"]')?.click();
    setTimeout(() => {
        const search = document.getElementById('craft-search');
        if (search) {
            search.value = getFriendlyName(itemId) || itemId;
            search.dispatchEvent(new Event('input'));
        }
    }, 100);
}

function switchToBrowser(itemId) {
    document.querySelector('[data-tab="browser"]')?.click();
    setTimeout(() => {
        const search = document.getElementById('browser-search');
        if (search) {
            search.value = getFriendlyName(itemId) || itemId;
            browserPage = 1;
            renderBrowser();
        }
    }, 100);
}

let currentChartData = [];
let currentChartItemId = null;

async function showGraph(itemId) {
    const modal = document.getElementById('chart-modal');
    const ctx = document.getElementById('priceChart').getContext('2d');
    const citySelect = document.getElementById('chart-city-select');

    modal.classList.remove('hidden');

    // Reset to live tab on each new item
    document.getElementById('chart-pane-live').classList.remove('hidden');
    document.getElementById('chart-pane-analytics').classList.add('hidden');
    document.querySelectorAll('.chart-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.chartTab === 'live');
    });

    if (priceChartInstance) priceChartInstance.destroy();
    if (analyticsChartInstance) { analyticsChartInstance.destroy(); analyticsChartInstance = null; }
    document.getElementById('chart-avg-price').textContent = 'Loading...';
    document.getElementById('sell-orders-list').innerHTML = '';
    document.getElementById('buy-orders-list').innerHTML = '';

    if (citySelect) {
        citySelect.innerHTML = '<option>Loading...</option>';
        citySelect.disabled = true;
    }

    try {
        const server = getServer();
        const response = await fetch(`${CHART_API_URLS[server]}/${itemId}.json?time-scale=24`);
        if (!response.ok) throw new Error('Failed to fetch chart data');
        const data = await response.json();

        if (data.length === 0) {
            document.getElementById('chart-avg-price').textContent = 'N/A';
            return;
        }

        currentChartData = data;
        currentChartItemId = itemId;

        // Extract unique locations
        const uniqueLocations = [...new Set(data.map(d => d.location).filter(Boolean))].sort();

        let defaultCity = null;
        if (citySelect && uniqueLocations.length > 0) {
            citySelect.innerHTML = '';
            uniqueLocations.forEach(loc => {
                const opt = document.createElement('option');
                opt.value = loc;
                opt.textContent = loc;
                citySelect.appendChild(opt);
            });

            // Default to non-BM city if possible
            const nonBM = uniqueLocations.filter(c => c !== 'Black Market');
            defaultCity = nonBM.length > 0 ? nonBM[0] : uniqueLocations[0];
            citySelect.value = defaultCity;
            citySelect.disabled = false;

            citySelect.onchange = () => {
                renderChartForCity(citySelect.value);
                const analyticsPane = document.getElementById('chart-pane-analytics');
                if (!analyticsPane.classList.contains('hidden')) {
                    const days = parseInt(document.querySelector('input[name="analytics-time"]:checked')?.value || '30');
                    renderAnalyticsChart(currentChartItemId, citySelect.value, days);
                }
            };
        } else {
            defaultCity = data[0].location; // Fallback
        }

        document.querySelectorAll('input[name="chart-time"]').forEach(radio => {
            radio.onclick = () => renderChartForCity(citySelect.value || defaultCity);
        });

        document.querySelectorAll('input[name="analytics-time"]').forEach(radio => {
            radio.onclick = () => {
                const city = citySelect?.value || defaultCity;
                renderAnalyticsChart(currentChartItemId, city, parseInt(radio.value));
            };
        });

        renderChartForCity(defaultCity);

    } catch (e) {
        document.getElementById('chart-avg-price').textContent = 'Error';
    }
}

function renderChartForCity(city) {
    const ctx = document.getElementById('priceChart').getContext('2d');
    if (priceChartInstance) priceChartInstance.destroy();

    const cityDataAll = currentChartData.filter(d => d.location === city);
    let targetDataset = cityDataAll.find(d => d.quality === 1);
    if (!targetDataset && cityDataAll.length > 0) {
        targetDataset = cityDataAll[0];
    }

    if (!targetDataset || !targetDataset.data || !targetDataset.data.timestamps || targetDataset.data.timestamps.length === 0) {
        return;
    }

    const timeToggles = document.querySelector('input[name="chart-time"]:checked');
    const chartDays = timeToggles ? parseInt(timeToggles.value, 10) : 28;

    const timestamps = targetDataset.data.timestamps.slice(-chartDays);
    const avgPrices = targetDataset.data.prices_avg.slice(-chartDays);
    const volumes = targetDataset.data.item_count.slice(-chartDays);
    const now = Date.now();
    const labels = timestamps.map(ts => {
        const diffHours = (now - new Date(ts).getTime()) / (1000 * 60 * 60);
        if (diffHours < 48) return Math.round(diffHours) + 'h';
        return Math.round(diffHours / 24) + 'd';
    });

    const avgPriceDisplay = document.getElementById('chart-avg-price');
    if (avgPrices.length > 0) {
        const lastValid = avgPrices.filter(p => p > 0).pop();
        if (lastValid) {
            avgPriceDisplay.textContent = Math.round(lastValid).toLocaleString();
        } else {
            avgPriceDisplay.textContent = '0';
        }
    }

    // Populate fake order book from cached MarketDB
    MarketDB.getItemPrices(currentChartItemId).then(dbPrices => {
        const cityData = dbPrices.filter(p => p.city === city && p.quality === 1);
        let best = cityData.length > 0 ? cityData[0] : null;
        
        const sellList = document.getElementById('sell-orders-list');
        const buyList = document.getElementById('buy-orders-list');
        
        if (best && best.sell_price_min > 0) {
            sellList.innerHTML = `<div class="order-row"><span class="price"><span class="silver-icon">💰</span>${Math.round(best.sell_price_min).toLocaleString()}</span><span class="amount">1</span></div>`;
        } else {
            sellList.innerHTML = `<div style="text-align:center; color:#8e7c65; padding:1rem; font-size:0.8rem;">No Sell Orders</div>`;
        }
        
        if (best && best.buy_price_max > 0) {
            buyList.innerHTML = `<div class="order-row"><span class="price"><span class="silver-icon">💰</span>${Math.round(best.buy_price_max).toLocaleString()}</span><span class="amount">1</span></div>`;
        } else {
            buyList.innerHTML = `<div style="text-align:center; color:#8e7c65; padding:1rem; font-size:0.8rem;">No Buy Orders</div>`;
        }
    });

    priceChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    type: 'bar',
                    label: 'Sold',
                    data: volumes,
                    backgroundColor: 'rgba(140, 123, 103, 0.4)',
                    hoverBackgroundColor: 'rgba(140, 123, 103, 0.7)',
                    borderWidth: 0,
                    yAxisID: 'y1',
                    order: 2
                },
                {
                    label: 'Average Price',
                    type: 'line',
                    data: avgPrices,
                    borderColor: '#c64a38',
                    backgroundColor: '#c64a38',
                    fill: false,
                    tension: 0, 
                    borderWidth: 2,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#c64a38',
                    pointBorderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: '#ffffff',
                    pointHoverBorderColor: '#c64a38',
                    pointHoverBorderWidth: 2,
                    yAxisID: 'y',
                    order: 1
                }
            ]
        },
        options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: { 
                        display: true,
                        grid: { display: false, drawBorder: true, color: '#4a3e31' },
                        ticks: { color: '#8e7c65', font: { weight: 'bold' }, maxRotation: 0, maxTicksLimit: 8 }
                    },
                    y: { 
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: false, 
                        grid: { color: 'rgba(177, 148, 114, 0.3)', drawBorder: false }, 
                        ticks: { color: '#8e7c65', font: { weight: 'bold' }, maxTicksLimit: 5 } 
                    },
                    y1: {
                        type: 'linear',
                        display: false,
                        position: 'right',
                        beginAtZero: true
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1c1814',
                        titleColor: '#a89c8a',
                        bodyColor: '#ffffff',
                        borderColor: '#4a3e31',
                        borderWidth: 1,
                        padding: 10,
                        displayColors: false,
                        callbacks: {
                            title: () => null,
                            label: function(context) {
                                if (context.dataset.label === 'Average Price') {
                                    return `  Average Price: 💰${context.parsed.y.toLocaleString()}`;
                                } else if (context.dataset.label === 'Sold') {
                                    return `  Sold: ${context.parsed.y.toLocaleString()}`;
                                }
                                return '';
                            }
                        }
                    }
                }
            }
        });
}

async function renderAnalyticsChart(itemId, city, days) {
    if (!itemId || !city) return;
    const canvas = document.getElementById('analyticsChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    document.getElementById('analytics-avg-price').textContent = 'Loading...';
    document.getElementById('analytics-legend').innerHTML = '';

    if (analyticsChartInstance) { analyticsChartInstance.destroy(); analyticsChartInstance = null; }

    try {
        const res = await fetch(`${VPS_BASE}/api/price-history?item_id=${encodeURIComponent(itemId)}&city=${encodeURIComponent(city)}&days=${days}`);
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        // Support legacy array and new { history, ohlc, analytics } envelope
        const rows = Array.isArray(data) ? data : (data.history || []);

        if (!rows || rows.length < 2) {
            document.getElementById('analytics-avg-price').textContent = 'No data';
            document.getElementById('analytics-legend').innerHTML = `<span style="color:var(--text-muted); font-size:0.8rem;">No historical data from our servers for this item/city yet. Data accumulates over time as scans run.</span>`;
            return;
        }

        const labels = rows.map(r => {
            const d = new Date(r.recorded_at);
            return `${d.getMonth() + 1}/${d.getDate()}`;
        });
        const prices = rows.map(r => r.sell_price_min || 0);
        const highs = rows.map(r => r.min_sell || 0);
        const sma7 = computeSMA(prices, 7);
        const sma30 = computeSMA(prices, 30);
        const ema7 = computeEMA(prices, 7);

        // VWAP from analytics data if available, otherwise compute from rows
        let vwapLine = null;
        if (rows.some(r => r.sample_count > 0)) {
            let cumVol = 0, cumPV = 0;
            vwapLine = rows.map(r => {
                const p = r.sell_price_min || 0;
                const v = r.sample_count || 0;
                if (p <= 0 || v <= 0) return null;
                cumPV += p * v;
                cumVol += v;
                return cumVol > 0 ? cumPV / cumVol : null;
            });
        }

        const validPrices = prices.filter(p => p > 0);
        if (validPrices.length > 0) {
            const avg = validPrices.reduce((a, b) => a + b, 0) / validPrices.length;
            document.getElementById('analytics-avg-price').textContent = Math.round(avg).toLocaleString();
        } else {
            document.getElementById('analytics-avg-price').textContent = '—';
        }

        document.getElementById('analytics-legend').innerHTML = `
            <span class="analytics-legend-item"><span class="analytics-legend-dot" style="background:#c64a38;"></span>Price</span>
            <span class="analytics-legend-item"><span class="analytics-legend-dot" style="background:#d4af37;"></span>SMA 7d</span>
            <span class="analytics-legend-item"><span class="analytics-legend-dot" style="background:#7c9fcc;"></span>SMA 30d</span>
            <span class="analytics-legend-item"><span class="analytics-legend-dot" style="background:#50c878;"></span>EMA 7d</span>
            ${vwapLine ? '<span class="analytics-legend-item"><span class="analytics-legend-dot" style="background:#e879f9;"></span>VWAP</span>' : ''}
        `;

        analyticsChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Price',
                        data: prices.map(p => p > 0 ? p : null),
                        borderColor: '#c64a38',
                        backgroundColor: 'rgba(198,74,56,0.08)',
                        borderWidth: 1.5,
                        pointRadius: 2,
                        tension: 0.2,
                        fill: false,
                        spanGaps: true,
                        yAxisID: 'y'
                    },
                    {
                        label: 'SMA 7d',
                        data: sma7,
                        borderColor: '#d4af37',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.3,
                        fill: false,
                        spanGaps: true,
                        yAxisID: 'y'
                    },
                    {
                        label: 'SMA 30d',
                        data: sma30,
                        borderColor: '#7c9fcc',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.3,
                        fill: false,
                        spanGaps: true,
                        yAxisID: 'y'
                    },
                    {
                        label: 'EMA 7d',
                        data: ema7,
                        borderColor: '#50c878',
                        backgroundColor: 'transparent',
                        borderWidth: 1.5,
                        borderDash: [4, 2],
                        pointRadius: 0,
                        tension: 0.3,
                        fill: false,
                        spanGaps: true,
                        yAxisID: 'y'
                    },
                    ...(vwapLine ? [{
                        label: 'VWAP',
                        data: vwapLine,
                        borderColor: '#e879f9',
                        backgroundColor: 'transparent',
                        borderWidth: 1.5,
                        borderDash: [6, 3],
                        pointRadius: 0,
                        tension: 0.3,
                        fill: false,
                        spanGaps: true,
                        yAxisID: 'y'
                    }] : [])
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        display: true,
                        grid: { display: false },
                        ticks: { color: '#8e7c65', font: { weight: 'bold' }, maxRotation: 0, maxTicksLimit: 10 }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: false,
                        grid: { color: 'rgba(177,148,114,0.3)' },
                        ticks: { color: '#8e7c65', font: { weight: 'bold' }, maxTicksLimit: 5 }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1c1814',
                        titleColor: '#a89c8a',
                        bodyColor: '#ffffff',
                        borderColor: '#4a3e31',
                        borderWidth: 1,
                        padding: 10,
                        displayColors: true,
                        callbacks: {
                            label: ctx => {
                                if (ctx.parsed.y === null) return null;
                                return `  ${ctx.dataset.label}: 💰${Math.round(ctx.parsed.y).toLocaleString()}`;
                            }
                        }
                    }
                }
            }
        });
    } catch (e) {
        document.getElementById('analytics-avg-price').textContent = 'Error';
    }
}

// ====== AUTOCOMPLETE SETUP ======
function setupAutocomplete(inputId, listId, onSelect) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);

    input.addEventListener('input', () => {
        const val = input.value.toLowerCase().trim();
        list.innerHTML = '';
        if (!val) { list.classList.add('hidden'); return; }

        const words = val.split(' ').filter(w => w);
        const matches = [];
        for (const item of itemsList) {
            const name = getFriendlyName(item);
            const target = (name + ' ' + item.replace(/_/g, ' ') + ' ' + getTierEnchLabel(item)).toLowerCase();
            if (words.every(w => target.includes(w))) {
                matches.push({ id: item, name });
                if (matches.length >= 8) break;
            }
        }

        if (matches.length > 0) {
            list.classList.remove('hidden');
            matches.forEach(m => {
                const div = document.createElement('div');
                div.innerHTML = `<strong>${esc(m.name)}</strong> <span style="color:var(--text-muted);font-size:0.75rem;">(${esc(m.id)})</span>`;
                div.addEventListener('click', () => {
                    input.value = m.name;
                    list.classList.add('hidden');
                    onSelect(m.id);
                });
                list.appendChild(div);
            });
        } else {
            list.classList.add('hidden');
        }
    });

    document.addEventListener('click', (e) => {
        if (e.target !== input) list.classList.add('hidden');
    });
}

// ============================================================
// ALERT MANAGEMENT
// ============================================================
const VPS_BASE = 'https://albionaitool.xyz';

// Returns Authorization header for authenticated API calls.
// Uses a JWT stored in localStorage — avoids cross-origin third-party cookie
// restrictions (Safari ITP, Chrome Privacy Sandbox) that silently drop session
// cookies when calling nip.io from github.io.
function authHeaders() {
    const token = localStorage.getItem('albion_auth_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

async function loadAlerts() {
    const listEl = document.getElementById('alerts-list');
    const emptyEl = document.getElementById('alerts-empty');
    if (!listEl) return;

    try {
        const res = await fetch(`${VPS_BASE}/api/alerts`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const alerts = await res.json();
        if (!Array.isArray(alerts) || alerts.length === 0) {
            listEl.innerHTML = '';
            emptyEl.style.display = '';
            return;
        }

        emptyEl.style.display = 'none';
        // Build cards with DOM — avoid inline onclick with channel_id (XSS via attribute injection)
        listEl.innerHTML = '';
        for (const a of alerts) {
            const card = document.createElement('div');
            card.className = 'item-card';
            card.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:1rem; margin-bottom:0.5rem;';
            const sourceLabel = a.guild_id ? (a.guild_id.startsWith('web-') ? '🌐 Web' : '🤖 Discord') : '';
            card.innerHTML = `
                <div>
                    <div style="font-weight:600; color:var(--text-primary);">📢 Channel: <span style="color:var(--accent);"></span></div>
                    <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:0.3rem;">
                        Min Profit: <strong style="color:var(--profit-green);">${parseInt(a.min_profit || 0).toLocaleString()} silver</strong>
                        ${sourceLabel ? ` • Source: ${sourceLabel}` : ''}
                    </div>
                </div>
                <button class="btn-card-action" style="color:var(--loss-red);" title="Delete this alert">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    Delete
                </button>`;
            // Set channel_id via textContent (safe) and wire delete button via closure (no inline onclick)
            card.querySelector('span[style*="accent"]').textContent = a.channel_id;
            card.querySelector('button').addEventListener('click', () => deleteAlert(a.channel_id));
            listEl.appendChild(card);
        }
    } catch (e) {
        listEl.innerHTML = '<div class="empty-state"><p>Could not load alerts. Is the bot server online?</p></div>';
    }
}

async function createAlert() {
    const channelId = document.getElementById('alert-channel-id').value.trim();
    const minProfit = document.getElementById('alert-min-profit').value;

    if (!channelId) return showToast('Please enter a Discord Channel ID.', 'warn');
    if (!minProfit || parseInt(minProfit) < 1000) return showToast('Min profit must be at least 1,000 silver.', 'warn');

    try {
        const res = await fetch(`${VPS_BASE}/api/alerts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ channel_id: channelId, min_profit: parseInt(minProfit) })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('alert-channel-id').value = '';
            await loadAlerts();
        } else {
            showToast('Failed to create alert: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (e) {
        showToast('Failed to connect to alert server.', 'error');
    }
}

async function deleteAlert(channelId) {
    if (!confirm(`Delete alert for channel ${channelId}?`)) return;
    try {
        await fetch(`${VPS_BASE}/api/alerts`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ channel_id: channelId })
        });
        await loadAlerts();
    } catch (e) {
        showToast('Failed to delete alert.', 'error');
    }
}

// ============================================================
// BLACK MARKET FLIPPER
// ============================================================
let bmSearchExactId = null;

async function doBMFlipperScan() {
    if (itemsList.length === 0) await loadData();
    await loadSpreadStats();

    const spinner = document.getElementById('bm-spinner');
    const errorEl = document.getElementById('bm-error');
    const container = document.getElementById('bm-results');

    const tier = document.getElementById('bm-tier').value;
    const enchantment = document.getElementById('bm-enchantment').value;
    const category = document.getElementById('bm-category').value;
    const minProfit = parseInt(document.getElementById('bm-min-profit').value) || 0;
    const sortBy = document.getElementById('bm-sort').value;

    hideError(errorEl);
    container.innerHTML = '';
    spinner.classList.remove('hidden');

    try {
        const cachedData = await MarketDB.getAllPrices();
        spinner.classList.add('hidden');

        if (cachedData.length === 0) {
            showError(errorEl, 'No cached data available yet. Data loads automatically — please wait a moment and try again.');
            return;
        }

        // Filter by category if set
        let filteredData = cachedData;
        if (category !== 'all') {
            filteredData = cachedData.filter(entry => {
                if (recipesData[entry.item_id] && recipesData[entry.item_id].category === category) return true;
                if (category === 'materials') return categorizeItem(entry.item_id) === 'materials' || categorizeItem(entry.item_id) === 'resources';
                if (category === 'bags') return categorizeItem(entry.item_id) === 'accessories';
                if (category === 'gear') return categorizeItem(entry.item_id) === 'weapons' || categorizeItem(entry.item_id) === 'armor';
                return false;
            });
        }

        // Use processArbitrage with BM-specific params
        const trades = processArbitrage(
            filteredData,
            'all',           // quality - all
            tier,            // tier filter
            enchantment,     // enchantment filter
            true,            // includeBM = true
            'all',           // buyCityFilter = all royal cities
            'Black Market',  // sellCityFilter = Black Market only
            false,           // isSingleItem
            'off',           // freshMode
            30,              // freshThresholdMins
            sortBy,          // sort
            0                // minConfidence
        );

        // Filter for BM sell and minimum profit
        const bmTrades = trades.filter(t => t.sellCity === 'Black Market' && t.profit >= minProfit);

        renderBMFlips(bmTrades);
    } catch (e) {
        spinner.classList.add('hidden');
        showError(errorEl, 'Error: ' + e.message);
    }
}

function renderBMFlips(trades) {
    const container = document.getElementById('bm-results');
    container.innerHTML = '';

    if (trades.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No profitable Black Market flips found.</p><p class="hint">Try lowering the minimum profit or adjusting filters.</p></div>`;
        return;
    }

    const countBar = document.createElement('div');
    countBar.className = 'result-count-bar';
    countBar.innerHTML = `Showing <strong>${trades.length}</strong> Black Market flips`;
    container.appendChild(countBar);

    trades.forEach(trade => {
        const card = document.createElement('div');
        card.className = 'trade-card';
        card.dataset.itemId = trade.itemId;
        card.dataset.buyCity = trade.buyCity;
        card.dataset.sellCity = trade.sellCity;
        card.innerHTML = `
            <div class="card-header">
                <div style="position: relative; display: flex;">
                    <img class="item-icon" src="https://render.albiononline.com/v1/item/${trade.itemId}.png" alt="" loading="lazy">
                    ${getEnchantmentBadge(trade.itemId)}
                </div>
                <div class="header-titles">
                    <div class="item-name">${esc(getFriendlyName(trade.itemId))} <span class="trend-badge" data-trend-item="${esc(trade.itemId)}"></span></div>
                    <span class="item-quality">${getQualityName(trade.quality)} ${getTierEnchLabel(trade.itemId)}</span>
                </div>
            </div>
            <div class="trade-route">
                <div class="city buy-city">
                    <span class="route-label">Buy From</span>
                    <strong class="city-name">${esc(trade.buyCity)}</strong>
                    <div style="display:flex; align-items:center; gap:0.5rem; justify-content:center;">
                        <span class="price" title="Instant Buy (Cheapest Sell Order)">${Math.floor(trade.buyPrice).toLocaleString()} silver</span>
                    </div>
                </div>
                <div class="arrow">➔</div>
                <div class="city sell-city" style="border-color: #6b21a8;">
                    <span class="route-label">Sell to Black Market</span>
                    <strong class="city-name" style="color: #a855f7;">Black Market</strong>
                    <div style="display:flex; align-items:center; gap:0.5rem; justify-content:center;">
                        <span class="price" title="BM Buy Order Price">${Math.floor(trade.sellPrice).toLocaleString()} silver</span>
                    </div>
                </div>
            </div>
            <div class="profit-section">
                <div class="profit-row"><span>Tax (3%):</span><span class="text-red">-${Math.floor(trade.tax).toLocaleString()} silver</span></div>
                <div class="profit-row total"><span>Net Profit:</span><strong class="${trade.profit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(trade.profit).toLocaleString()} silver</strong></div>
                <div class="roi-row"><span>ROI:</span><strong class="${trade.roi >= 0 ? 'text-green' : 'text-red'}">${trade.roi.toFixed(1)}%</strong></div>
            </div>
            <div style="text-align:center; font-size:0.7rem; color:var(--text-muted); padding: 0.5rem 0 0 0; font-style:italic;">
                <div style="display:flex; justify-content:center; gap:1rem; flex-wrap:wrap;">
                    <span title="Buy Data Age">${getFreshnessIndicator(trade.dateBuy)} ${esc(trade.buyCity)}: ${timeAgo(trade.dateBuy)}</span>
                    <span title="Sell Data Age">${getFreshnessIndicator(trade.dateSell)} BM: ${timeAgo(trade.dateSell)}</span>
                </div>
                ${trade.confidence !== null ? `
                <div style="margin-top:0.4rem; display:flex; justify-content:center; align-items:center; gap:0.5rem; flex-wrap:wrap;">
                    ${getConfidenceBadge(trade.confidence)}
                    ${getVolatilityBadge(trade.consistencyPct)}
                    <span title="Profitable ${trade.consistencyPct}% of the time over 7 days (${trade.sampleCount} samples)">
                        Profitable ${trade.consistencyPct}% of the time
                    </span>
                </div>` : ''}
            </div>
            <div class="item-card-actions">
                <button class="btn-card-action" data-action="compare" data-item="${trade.itemId}" title="Compare prices across cities">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                    Compare
                </button>
                <button class="btn-card-action" data-action="refresh" data-item="${trade.itemId}" title="Refresh this item's data">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                    Refresh
                </button>
                <button class="btn-card-action" data-action="graph" data-item="${trade.itemId}" title="View price history">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline></svg>
                    Graph
                </button>
            </div>
        `;
        container.appendChild(card);
    });

    setupCardButtons(container);
    prefetchTrendBadges(container);
}

// ============================================================
// JOURNALS CALCULATOR
// ============================================================
const JOURNAL_DATA = {
    mercenary: {
        name: 'Mercenary',
        tiers: {
            3: { empty: 'T3_JOURNAL_MERCENARY_EMPTY', full: 'T3_JOURNAL_MERCENARY_FULL' },
            4: { empty: 'T4_JOURNAL_MERCENARY_EMPTY', full: 'T4_JOURNAL_MERCENARY_FULL' },
            5: { empty: 'T5_JOURNAL_MERCENARY_EMPTY', full: 'T5_JOURNAL_MERCENARY_FULL' },
            6: { empty: 'T6_JOURNAL_MERCENARY_EMPTY', full: 'T6_JOURNAL_MERCENARY_FULL' },
            7: { empty: 'T7_JOURNAL_MERCENARY_EMPTY', full: 'T7_JOURNAL_MERCENARY_FULL' },
            8: { empty: 'T8_JOURNAL_MERCENARY_EMPTY', full: 'T8_JOURNAL_MERCENARY_FULL' }
        }
    },
    lumberjack: {
        name: 'Lumberjack',
        tiers: {
            3: { empty: 'T3_JOURNAL_WOOD_EMPTY', full: 'T3_JOURNAL_WOOD_FULL' },
            4: { empty: 'T4_JOURNAL_WOOD_EMPTY', full: 'T4_JOURNAL_WOOD_FULL' },
            5: { empty: 'T5_JOURNAL_WOOD_EMPTY', full: 'T5_JOURNAL_WOOD_FULL' },
            6: { empty: 'T6_JOURNAL_WOOD_EMPTY', full: 'T6_JOURNAL_WOOD_FULL' },
            7: { empty: 'T7_JOURNAL_WOOD_EMPTY', full: 'T7_JOURNAL_WOOD_FULL' },
            8: { empty: 'T8_JOURNAL_WOOD_EMPTY', full: 'T8_JOURNAL_WOOD_FULL' }
        }
    },
    stonecutter: {
        name: 'Stonecutter',
        tiers: {
            3: { empty: 'T3_JOURNAL_STONE_EMPTY', full: 'T3_JOURNAL_STONE_FULL' },
            4: { empty: 'T4_JOURNAL_STONE_EMPTY', full: 'T4_JOURNAL_STONE_FULL' },
            5: { empty: 'T5_JOURNAL_STONE_EMPTY', full: 'T5_JOURNAL_STONE_FULL' },
            6: { empty: 'T6_JOURNAL_STONE_EMPTY', full: 'T6_JOURNAL_STONE_FULL' },
            7: { empty: 'T7_JOURNAL_STONE_EMPTY', full: 'T7_JOURNAL_STONE_FULL' },
            8: { empty: 'T8_JOURNAL_STONE_EMPTY', full: 'T8_JOURNAL_STONE_FULL' }
        }
    },
    prospector: {
        name: 'Prospector',
        tiers: {
            3: { empty: 'T3_JOURNAL_ORE_EMPTY', full: 'T3_JOURNAL_ORE_FULL' },
            4: { empty: 'T4_JOURNAL_ORE_EMPTY', full: 'T4_JOURNAL_ORE_FULL' },
            5: { empty: 'T5_JOURNAL_ORE_EMPTY', full: 'T5_JOURNAL_ORE_FULL' },
            6: { empty: 'T6_JOURNAL_ORE_EMPTY', full: 'T6_JOURNAL_ORE_FULL' },
            7: { empty: 'T7_JOURNAL_ORE_EMPTY', full: 'T7_JOURNAL_ORE_FULL' },
            8: { empty: 'T8_JOURNAL_ORE_EMPTY', full: 'T8_JOURNAL_ORE_FULL' }
        }
    },
    cropper: {
        name: 'Cropper',
        tiers: {
            3: { empty: 'T3_JOURNAL_FIBER_EMPTY', full: 'T3_JOURNAL_FIBER_FULL' },
            4: { empty: 'T4_JOURNAL_FIBER_EMPTY', full: 'T4_JOURNAL_FIBER_FULL' },
            5: { empty: 'T5_JOURNAL_FIBER_EMPTY', full: 'T5_JOURNAL_FIBER_FULL' },
            6: { empty: 'T6_JOURNAL_FIBER_EMPTY', full: 'T6_JOURNAL_FIBER_FULL' },
            7: { empty: 'T7_JOURNAL_FIBER_EMPTY', full: 'T7_JOURNAL_FIBER_FULL' },
            8: { empty: 'T8_JOURNAL_FIBER_EMPTY', full: 'T8_JOURNAL_FIBER_FULL' }
        }
    },
    gamekeeper: {
        name: 'Gamekeeper',
        tiers: {
            3: { empty: 'T3_JOURNAL_HIDE_EMPTY', full: 'T3_JOURNAL_HIDE_FULL' },
            4: { empty: 'T4_JOURNAL_HIDE_EMPTY', full: 'T4_JOURNAL_HIDE_FULL' },
            5: { empty: 'T5_JOURNAL_HIDE_EMPTY', full: 'T5_JOURNAL_HIDE_FULL' },
            6: { empty: 'T6_JOURNAL_HIDE_EMPTY', full: 'T6_JOURNAL_HIDE_FULL' },
            7: { empty: 'T7_JOURNAL_HIDE_EMPTY', full: 'T7_JOURNAL_HIDE_FULL' },
            8: { empty: 'T8_JOURNAL_HIDE_EMPTY', full: 'T8_JOURNAL_HIDE_FULL' }
        }
    },
    blacksmith: {
        name: 'Blacksmith',
        tiers: {
            3: { empty: 'T3_JOURNAL_WARRIOR_EMPTY', full: 'T3_JOURNAL_WARRIOR_FULL' },
            4: { empty: 'T4_JOURNAL_WARRIOR_EMPTY', full: 'T4_JOURNAL_WARRIOR_FULL' },
            5: { empty: 'T5_JOURNAL_WARRIOR_EMPTY', full: 'T5_JOURNAL_WARRIOR_FULL' },
            6: { empty: 'T6_JOURNAL_WARRIOR_EMPTY', full: 'T6_JOURNAL_WARRIOR_FULL' },
            7: { empty: 'T7_JOURNAL_WARRIOR_EMPTY', full: 'T7_JOURNAL_WARRIOR_FULL' },
            8: { empty: 'T8_JOURNAL_WARRIOR_EMPTY', full: 'T8_JOURNAL_WARRIOR_FULL' }
        }
    },
    fletcher: {
        name: 'Fletcher',
        tiers: {
            3: { empty: 'T3_JOURNAL_HUNTER_EMPTY', full: 'T3_JOURNAL_HUNTER_FULL' },
            4: { empty: 'T4_JOURNAL_HUNTER_EMPTY', full: 'T4_JOURNAL_HUNTER_FULL' },
            5: { empty: 'T5_JOURNAL_HUNTER_EMPTY', full: 'T5_JOURNAL_HUNTER_FULL' },
            6: { empty: 'T6_JOURNAL_HUNTER_EMPTY', full: 'T6_JOURNAL_HUNTER_FULL' },
            7: { empty: 'T7_JOURNAL_HUNTER_EMPTY', full: 'T7_JOURNAL_HUNTER_FULL' },
            8: { empty: 'T8_JOURNAL_HUNTER_EMPTY', full: 'T8_JOURNAL_HUNTER_FULL' }
        }
    },
    imbuer: {
        name: 'Imbuer',
        tiers: {
            3: { empty: 'T3_JOURNAL_MAGE_EMPTY', full: 'T3_JOURNAL_MAGE_FULL' },
            4: { empty: 'T4_JOURNAL_MAGE_EMPTY', full: 'T4_JOURNAL_MAGE_FULL' },
            5: { empty: 'T5_JOURNAL_MAGE_EMPTY', full: 'T5_JOURNAL_MAGE_FULL' },
            6: { empty: 'T6_JOURNAL_MAGE_EMPTY', full: 'T6_JOURNAL_MAGE_FULL' },
            7: { empty: 'T7_JOURNAL_MAGE_EMPTY', full: 'T7_JOURNAL_MAGE_FULL' },
            8: { empty: 'T8_JOURNAL_MAGE_EMPTY', full: 'T8_JOURNAL_MAGE_FULL' }
        }
    },
    tinker: {
        name: 'Tinker',
        tiers: {
            3: { empty: 'T3_JOURNAL_TOOLMAKER_EMPTY', full: 'T3_JOURNAL_TOOLMAKER_FULL' },
            4: { empty: 'T4_JOURNAL_TOOLMAKER_EMPTY', full: 'T4_JOURNAL_TOOLMAKER_FULL' },
            5: { empty: 'T5_JOURNAL_TOOLMAKER_EMPTY', full: 'T5_JOURNAL_TOOLMAKER_FULL' },
            6: { empty: 'T6_JOURNAL_TOOLMAKER_EMPTY', full: 'T6_JOURNAL_TOOLMAKER_FULL' },
            7: { empty: 'T7_JOURNAL_TOOLMAKER_EMPTY', full: 'T7_JOURNAL_TOOLMAKER_FULL' },
            8: { empty: 'T8_JOURNAL_TOOLMAKER_EMPTY', full: 'T8_JOURNAL_TOOLMAKER_FULL' }
        }
    }
};

async function calculateJournals() {
    const spinner = document.getElementById('journals-spinner');
    const container = document.getElementById('journals-results');
    const city = document.getElementById('journal-city').value;
    const buyCity = city;
    const sellCity = city;

    container.innerHTML = '';
    spinner.classList.remove('hidden');

    // Collect all journal item IDs
    const allJournalIds = [];
    for (const [typeKey, typeData] of Object.entries(JOURNAL_DATA)) {
        for (const [tier, ids] of Object.entries(typeData.tiers)) {
            allJournalIds.push(ids.empty, ids.full);
        }
    }

    try {
        const server = getServer();
        // Fetch from all cities to maximize data coverage, then filter to selected city
        const allCities = ['Bridgewatch','Caerleon','Fort Sterling','Lymhurst','Martlock','Thetford','Brecilien'];
        const locations = encodeURIComponent(allCities.join(','));

        // Fetch prices from API in chunks
        let allPrices = [];
        for (let i = 0; i < allJournalIds.length; i += API_CHUNK_SIZE) {
            const chunk = allJournalIds.slice(i, i + API_CHUNK_SIZE);
            const url = `${API_URLS[server]}/${chunk.join(',')}.json?locations=${locations}`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                allPrices = allPrices.concat(data);
            }
        }

        // Save to cache
        if (allPrices.length > 0) await MarketDB.saveMarketData(allPrices);

        spinner.classList.add('hidden');

        // Index prices: itemId → city → { sellMin, buyMax }
        const priceIndex = {};
        for (const entry of allPrices) {
            const id = entry.item_id;
            let city = entry.city;
            if (city && city.includes('Black Market')) city = 'Black Market';
            if (!priceIndex[id]) priceIndex[id] = {};
            const existing = priceIndex[id][city];
            if (!existing) {
                priceIndex[id][city] = {
                    sellMin: entry.sell_price_min || 0,
                    buyMax: entry.buy_price_max || 0
                };
            } else {
                if (entry.sell_price_min > 0 && (existing.sellMin === 0 || entry.sell_price_min < existing.sellMin)) {
                    existing.sellMin = entry.sell_price_min;
                }
                if (entry.buy_price_max > 0 && entry.buy_price_max > existing.buyMax) {
                    existing.buyMax = entry.buy_price_max;
                }
            }
        }

        // Calculate results
        const results = [];
        for (const [typeKey, typeData] of Object.entries(JOURNAL_DATA)) {
            const row = { type: typeData.name, tiers: {} };
            for (const [tier, ids] of Object.entries(typeData.tiers)) {
                const emptyPrices = priceIndex[ids.empty];
                const fullPrices = priceIndex[ids.full];

                // Buy empty in buyCity (instant buy = sellMin), sell full in sellCity (instant sell = buyMax)
                const emptyBuyPrice = emptyPrices && emptyPrices[buyCity] ? emptyPrices[buyCity].sellMin : 0;
                const fullSellPrice = fullPrices && fullPrices[sellCity] ? fullPrices[sellCity].buyMax : 0;

                // Also get sell order price for full journals (for sell order profit)
                const fullSellOrderPrice = fullPrices && fullPrices[sellCity] ? fullPrices[sellCity].sellMin : 0;

                // Show data even if one price is missing (show what we have)
                const tax = fullSellPrice > 0 ? fullSellPrice * TAX_RATE : 0;
                const profit = (emptyBuyPrice > 0 && fullSellPrice > 0) ? fullSellPrice - emptyBuyPrice - tax : 0;
                const roi = (emptyBuyPrice > 0 && profit !== 0) ? (profit / emptyBuyPrice) * 100 : 0;

                let soProfit = 0, soRoi = 0;
                if (fullSellOrderPrice > 0 && emptyBuyPrice > 0) {
                    const soTax = fullSellOrderPrice * (TAX_RATE + SETUP_FEE); // 5.5% for sell orders
                    soProfit = fullSellOrderPrice - emptyBuyPrice - soTax;
                    soRoi = (soProfit / emptyBuyPrice) * 100;
                }

                if (emptyBuyPrice > 0 || fullSellPrice > 0) {
                    row.tiers[tier] = {
                        emptyBuyPrice,
                        fullSellPrice,
                        fullSellOrderPrice,
                        tax,
                        profit,
                        roi,
                        soProfit,
                        soRoi,
                        emptyId: ids.empty,
                        fullId: ids.full
                    };
                } else {
                    row.tiers[tier] = null;
                }
            }
            results.push(row);
        }

        renderJournalResults(results);
        await updateDbStatus();
    } catch (e) {
        spinner.classList.add('hidden');
        container.innerHTML = `<div class="empty-state"><p>Failed to fetch journal prices: ${esc(e.message)}</p></div>`;
    }
}

function renderJournalResults(results) {
    const container = document.getElementById('journals-results');
    container.innerHTML = '';

    if (results.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No journal data available.</p></div>`;
        return;
    }

    const tiers = [3, 4, 5, 6, 7, 8];
    let tableHTML = `<div class="table-scroll-wrapper">
        <table class="compare-table">
            <thead>
                <tr>
                    <th>Journal Type</th>
                    ${tiers.map(t => `<th>T${t}</th>`).join('')}
                </tr>
            </thead>
            <tbody>`;

    for (const row of results) {
        tableHTML += `<tr><td style="font-weight:700; white-space:nowrap;">${row.type}</td>`;
        for (const t of tiers) {
            const data = row.tiers[t];
            if (!data) {
                tableHTML += `<td style="text-align:center; color:var(--text-muted);">--</td>`;
            } else {
                const profitColor = data.profit >= 0 ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)';
                const soProfitColor = data.soProfit >= 0 ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)';
                tableHTML += `<td style="text-align:center; padding:0.5rem;">
                    <div style="font-size:0.7rem; color:var(--text-muted);">Empty: ${data.emptyBuyPrice.toLocaleString()}</div>
                    <div style="font-size:0.7rem; color:var(--text-muted);">Full: ${data.fullSellPrice.toLocaleString()}</div>
                    <div style="font-weight:700; color:${profitColor}; font-size:0.9rem; margin-top:0.2rem;">
                        ${data.profit >= 0 ? '+' : ''}${Math.floor(data.profit).toLocaleString()}
                    </div>
                    <div style="font-size:0.7rem; color:${profitColor};">${data.roi.toFixed(1)}% ROI</div>
                    ${data.fullSellOrderPrice > 0 ? `<div style="font-size:0.65rem; color:${soProfitColor}; margin-top:0.2rem; border-top:1px solid rgba(255,255,255,0.05); padding-top:0.2rem;" title="Sell Order profit">
                        SO: ${data.soProfit >= 0 ? '+' : ''}${Math.floor(data.soProfit).toLocaleString()}
                    </div>` : ''}
                </td>`;
            }
        }
        tableHTML += `</tr>`;
    }

    tableHTML += `</tbody></table></div>`;

    const header = document.createElement('div');
    header.className = 'result-count-bar';
    header.innerHTML = `Showing <strong>${results.length}</strong> journal types across T3-T8`;
    container.appendChild(header);
    container.insertAdjacentHTML('beforeend', tableHTML);
}

// ============================================================
// RRR CALCULATOR (STANDALONE TAB)
// ============================================================
function calculateRRRStandalone() {
    const activityType = document.getElementById('rrr-activity').value; // 'crafting' or 'refining'
    const specLevel = parseInt(document.getElementById('rrr-spec').value) || 0;
    const cityBonus = parseFloat(document.getElementById('rrr-city-bonus').value) || 0;
    const useFocus = document.getElementById('rrr-use-focus').checked;

    // Base production bonus values
    const basePB = activityType === 'refining' ? 18 : 18; // Royal city base for both
    const focusPB = useFocus ? 59 : 0;
    // Spec bonus: each spec level adds production bonus
    // In Albion, specialization adds to production bonus: specLevel * 0.2 effective PB
    const specPB = specLevel * 0.2;
    const totalPB = basePB + cityBonus + focusPB + specPB;
    const returnRate = 1 - 1 / (1 + totalPB / 100);

    // Breakdown
    const baseRR = 1 - 1 / (1 + basePB / 100);
    const withSpecRR = 1 - 1 / (1 + (basePB + specPB) / 100);
    const withCityRR = 1 - 1 / (1 + (basePB + specPB + cityBonus) / 100);
    const fullRR = returnRate;

    const results = {
        returnRate: fullRR * 100,
        baseContribution: baseRR * 100,
        specContribution: (withSpecRR - baseRR) * 100,
        cityContribution: (withCityRR - withSpecRR) * 100,
        focusContribution: useFocus ? (fullRR - withCityRR) * 100 : 0,
        materialsSavedPer100: (fullRR * 100).toFixed(1),
        specLevel,
        cityBonus,
        useFocus,
        activityType
    };

    renderRRRResults(results);
}

function renderRRRResults(results) {
    const rr = results.returnRate;
    const barColor = rr >= 50 ? '#22c55e' : rr >= 30 ? 'var(--accent)' : '#ef4444';

    // Update the built-in HTML elements
    const rateEl = document.getElementById('rrr-rate');
    const savedEl = document.getElementById('rrr-saved');
    const breakevenEl = document.getElementById('rrr-breakeven');
    const barEl = document.getElementById('rrr-bar');
    const barLabelEl = document.getElementById('rrr-bar-label');

    if (rateEl) {
        rateEl.textContent = rr.toFixed(1) + '%';
        rateEl.style.color = barColor;
    }
    if (savedEl) {
        savedEl.textContent = results.materialsSavedPer100 + ' mats';
        savedEl.style.color = barColor;
    }
    if (breakevenEl) {
        const costMult = (100 - rr).toFixed(1);
        breakevenEl.innerHTML = `You only pay <strong style="color:${barColor};">${costMult}%</strong> of material costs`;
    }
    if (barEl) {
        barEl.style.width = Math.min(100, rr) + '%';
        barEl.style.background = `linear-gradient(90deg, ${barColor}, #f0c040)`;
    }
    if (barLabelEl) {
        barLabelEl.textContent = rr.toFixed(1) + '%';
        barLabelEl.style.color = barColor;
    }
}

// ============================================================
// REPAIR COST CALCULATOR
// ============================================================
const REPAIR_BASE_VALUES = { 4: 256, 5: 512, 6: 1024, 7: 2048, 8: 4096 };
const REPAIR_ENCH_MULTIPLIER = 3.2;
const REPAIR_QUALITY_MULTIPLIERS = {
    '1': 1.0,   // Normal
    '2': 1.04,  // Good
    '3': 1.08,  // Outstanding
    '4': 1.12,  // Excellent
    '5': 1.16   // Masterpiece
};

let repairSearchExactId = null;

async function calculateRepairCost() {
    const searchInput = document.getElementById('repair-search');
    const container = document.getElementById('repair-results');

    const itemId = repairSearchExactId || searchInput.value.trim();
    if (!itemId) {
        container.innerHTML = `<div class="empty-state"><p>Please search for an item first.</p></div>`;
        return;
    }

    // Resolve to exact ID
    let resolvedId = repairSearchExactId;
    if (!resolvedId) {
        const searchLower = itemId.toLowerCase();
        for (const id of itemsList) {
            if (getFriendlyName(id).toLowerCase() === searchLower || id.toLowerCase() === searchLower) {
                resolvedId = id;
                break;
            }
        }
        if (!resolvedId) {
            const words = searchLower.split(' ').filter(w => w);
            for (const id of itemsList) {
                const target = (getFriendlyName(id) + ' ' + id.replace(/_/g, ' ')).toLowerCase();
                if (words.every(w => target.includes(w))) {
                    resolvedId = id;
                    break;
                }
            }
        }
    }

    if (!resolvedId) {
        container.innerHTML = `<div class="empty-state"><p>Item not found. Try another search.</p></div>`;
        return;
    }

    const quality = document.getElementById('repair-quality').value;
    const durabilityFrom = parseInt(document.getElementById('repair-durability').value) || 0;
    const durabilityTo = 100; // always repair to full
    const maxDurability = 100;

    // Extract tier and enchantment
    const tier = parseInt(extractTier(resolvedId)) || 0;
    const enchantment = parseInt(extractEnchantment(resolvedId)) || 0;

    // Calculate item base value
    let baseValue = REPAIR_BASE_VALUES[tier] || 0;
    if (tier < 4) {
        // T3 and below: estimate
        baseValue = Math.pow(2, tier + 5); // T3=256 approximation via lower
        if (tier === 3) baseValue = 128;
        if (tier === 2) baseValue = 64;
        if (tier === 1) baseValue = 32;
    }

    // Apply enchantment multiplier
    let itemValue = baseValue;
    for (let i = 0; i < enchantment; i++) {
        itemValue *= REPAIR_ENCH_MULTIPLIER;
    }

    const qualityMultiplier = REPAIR_QUALITY_MULTIPLIERS[quality] || 1.0;

    // Repair cost = itemValue * (1 - currentDurability/maxDurability) * qualityMultiplier
    // For a range: cost to repair from durabilityFrom to durabilityTo
    const damagePortion = (durabilityTo - durabilityFrom) / maxDurability;
    const repairCost = Math.ceil(itemValue * damagePortion * qualityMultiplier);

    // Full repair cost (from 0 to 100)
    const fullRepairCost = Math.ceil(itemValue * 1.0 * qualityMultiplier);

    const results = {
        itemId: resolvedId,
        name: getFriendlyName(resolvedId),
        tier,
        enchantment,
        quality,
        qualityName: getQualityName(quality),
        qualityMultiplier,
        durabilityFrom,
        durabilityTo,
        maxDurability,
        baseValue: Math.floor(baseValue),
        itemValue: Math.floor(itemValue),
        repairCost,
        fullRepairCost
    };

    renderRepairResults(results);
}

function renderRepairResults(results) {
    const container = document.getElementById('repair-results');
    container.innerHTML = '';

    const tierEnch = results.enchantment > 0 ? `T${results.tier}.${results.enchantment}` : `T${results.tier}`;
    const durabilityPct = ((results.durabilityTo - results.durabilityFrom) / results.maxDurability * 100).toFixed(0);

    let html = `
        <div class="craft-summary-card">
            <div class="craft-summary-header">
                <div style="position:relative;display:flex;">
                    <img class="item-icon" src="https://render.albiononline.com/v1/item/${results.itemId}.png" alt="" loading="lazy">
                    ${getEnchantmentBadge(results.itemId)}
                </div>
                <div>
                    <h2>${esc(results.name)} <span class="tier-badge">${tierEnch}</span></h2>
                    <span style="color:var(--text-muted);font-size:0.8rem;">${esc(results.itemId)} | ${esc(results.qualityName)}</span>
                </div>
            </div>

            <div class="craft-summary-stats">
                <div class="stat-box highlight">
                    <div class="stat-label">Repair Cost (${results.durabilityFrom}% -> ${results.durabilityTo}%)</div>
                    <div class="stat-value text-red">${results.repairCost.toLocaleString()} silver</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Full Repair (0% -> 100%)</div>
                    <div class="stat-value text-accent">${results.fullRepairCost.toLocaleString()} silver</div>
                </div>
            </div>

            <div style="margin-top:1rem;">
                <h4 style="color:var(--text-secondary); margin:0 0 0.5rem 0; font-size:0.85rem;">Calculation Breakdown</h4>
                <table class="compare-table" style="width:100%;">
                    <tbody>
                        <tr>
                            <td>Base Item Value (T${results.tier})</td>
                            <td style="text-align:right; font-weight:700;">${results.baseValue.toLocaleString()} silver</td>
                        </tr>
                        ${results.enchantment > 0 ? `<tr>
                            <td>Enchantment (x${REPAIR_ENCH_MULTIPLIER} per level, ${results.enchantment} levels)</td>
                            <td style="text-align:right; font-weight:700;">${Math.floor(results.itemValue).toLocaleString()} silver</td>
                        </tr>` : ''}
                        <tr>
                            <td>Quality Multiplier (${results.qualityName})</td>
                            <td style="text-align:right; font-weight:700;">x${results.qualityMultiplier.toFixed(2)}</td>
                        </tr>
                        <tr>
                            <td>Durability Restored</td>
                            <td style="text-align:right; font-weight:700;">${results.durabilityFrom}% -> ${results.durabilityTo}% (${durabilityPct}%)</td>
                        </tr>
                        <tr class="total-row">
                            <td><strong>Total Repair Cost</strong></td>
                            <td style="text-align:right; font-weight:800; color:var(--red, #ef4444);">${results.repairCost.toLocaleString()} silver</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div style="margin-top:1rem; padding:0.75rem; background:rgba(255,255,255,0.03); border-radius:0.5rem;">
                <h4 style="color:var(--text-secondary); margin:0 0 0.5rem 0; font-size:0.85rem;">Quick Reference</h4>
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap:0.5rem;">
                    ${[25, 50, 75, 100].map(pct => {
                        const cost = Math.ceil(results.itemValue * (pct / 100) * results.qualityMultiplier);
                        return `<div style="text-align:center; padding:0.5rem; background:rgba(0,0,0,0.2); border-radius:0.3rem;">
                            <div style="font-size:0.7rem; color:var(--text-muted);">Repair ${pct}%</div>
                            <div style="font-weight:700; color:var(--text-primary);">${cost.toLocaleString()}</div>
                        </div>`;
                    }).join('')}
                </div>
            </div>

            <div style="font-size:0.75rem; color:var(--text-muted); border-top:1px solid var(--border); padding-top:0.75rem; margin-top:1rem;">
                <strong>Formula:</strong> Repair Cost = Item Value x (Durability Restored / Max Durability) x Quality Multiplier.
                Base values: T4=256, T5=512, T6=1024, T7=2048, T8=4096. Each enchantment level multiplies by ${REPAIR_ENCH_MULTIPLIER}.
            </div>
        </div>
    `;

    container.innerHTML = html;
}

// ====== INITIALIZATION ======

function dismissLandingOverlay() {
    const overlay = document.getElementById('landing-overlay');
    if (overlay) {
        overlay.classList.add('dismissed');
        setTimeout(() => { overlay.style.display = 'none'; }, 750);
    }
}

function showDeviceAuthDialog(userCode) {
    // Create a modal overlay for device authorization
    const existing = document.getElementById('device-auth-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'device-auth-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:var(--radius-lg);padding:2rem;max-width:400px;width:90%;text-align:center;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" style="margin-bottom:1rem;">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            <h2 style="color:var(--text-primary);margin:0 0 0.5rem;">Authorize Data Client</h2>
            <p style="color:var(--text-secondary);font-size:0.9rem;margin:0 0 1rem;">The Coldtouch Data Client is requesting access to your account.</p>
            <div style="background:var(--bg-dark);border:1px solid var(--border-color);border-radius:var(--radius);padding:0.75rem;margin-bottom:1.5rem;">
                <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem;">Device Code</div>
                <div style="font-size:1.5rem;font-weight:800;color:var(--accent);letter-spacing:0.2em;">${userCode}</div>
            </div>
            <p id="device-auth-status" style="color:var(--text-muted);font-size:0.8rem;margin:0 0 1rem;">Click Authorize to link this device to your account.</p>
            <div style="display:flex;gap:0.75rem;justify-content:center;">
                <button id="device-auth-approve" class="btn-primary" style="padding:0.6rem 2rem;">Authorize</button>
                <button id="device-auth-cancel" class="btn-secondary" style="padding:0.6rem 1.5rem;" onclick="document.getElementById('device-auth-modal').remove();">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('device-auth-approve').addEventListener('click', async () => {
        const statusEl = document.getElementById('device-auth-status');
        const btn = document.getElementById('device-auth-approve');
        btn.disabled = true;
        btn.textContent = 'Authorizing...';
        statusEl.textContent = 'Connecting to server...';

        try {
            const res = await fetch(`${VPS_BASE}/api/device/authorize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ user_code: userCode })
            });
            const data = await res.json();
            if (data.success) {
                statusEl.style.color = 'var(--profit-green)';
                statusEl.textContent = 'Authorized! The data client is now linked to your account. You can close this.';
                btn.textContent = 'Done';
                btn.onclick = () => modal.remove();
                btn.disabled = false;
            } else {
                statusEl.style.color = 'var(--loss-red)';
                statusEl.textContent = data.error || 'Authorization failed.';
                btn.textContent = 'Retry';
                btn.disabled = false;
            }
        } catch (e) {
            statusEl.style.color = 'var(--loss-red)';
            statusEl.textContent = 'Network error. Try again.';
            btn.textContent = 'Retry';
            btn.disabled = false;
        }
    });
}

function updateHeaderProfile(user) {
    document.getElementById('login-discord-btn').classList.add('hidden');
    const profile = document.getElementById('discord-user-profile');
    profile.classList.remove('hidden');
    profile.style.display = 'flex';
    const avatarEl = document.getElementById('discord-avatar');
    if (user.avatar && user.authType !== 'email') {
        avatarEl.src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    } else {
        avatarEl.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="%23888" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>');
    }
    document.getElementById('discord-username').textContent = user.username;
    const profileTab = document.getElementById('nav-profile-tab');
    if (profileTab) profileTab.style.display = '';
}

async function checkDiscordAuth() {
    const overlay = document.getElementById('landing-overlay');
    const authChecking = document.getElementById('landing-auth-checking');
    const authContent = document.getElementById('landing-auth-content');
    const authError = document.getElementById('landing-auth-error');
    const authErrorText = document.getElementById('landing-auth-error-text');

    // Handle redirect back from OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const loginParam = urlParams.get('login');
    const tokenParam = urlParams.get('token');
    const linkParam = urlParams.get('link');
    const verifyParam = urlParams.get('verify');
    const deviceParam = urlParams.get('device');
    // Persist device code through login redirects — the param gets stripped by replaceState
    if (deviceParam) sessionStorage.setItem('pending_device_code', deviceParam);
    const pendingDevice = deviceParam || sessionStorage.getItem('pending_device_code');
    if (linkParam === 'success') {
        history.replaceState(null, '', window.location.pathname);
        // Discord account linked — just continue with existing session
    }
    if (verifyParam) {
        history.replaceState(null, '', window.location.pathname);
        // Will be handled after login check completes
    }
    if (loginParam || tokenParam) {
        // Store JWT from OAuth redirect — used as Authorization: Bearer header
        // instead of session cookies (which are blocked as third-party by Safari/Chrome).
        if (tokenParam) localStorage.setItem('albion_auth_token', tokenParam);
        history.replaceState(null, '', window.location.pathname);
        if (loginParam === 'failed') {
            // Show login UI immediately with error
            if (authChecking) authChecking.style.display = 'none';
            if (authContent) authContent.style.display = 'block';
            if (authError) {
                authError.style.display = 'flex';
                if (authErrorText) authErrorText.textContent = 'Discord login failed. Please try again.';
            }
            return;
        }
    }

    // If no JWT stored and no token arriving in URL, user is definitely not logged in.
    // Skip the slow /api/me network call entirely — show login UI instantly.
    let storedToken = localStorage.getItem('albion_auth_token');

    // Check if stored JWT is expired (avoids a wasted round-trip)
    if (storedToken && !tokenParam) {
        try {
            const payload = JSON.parse(atob(storedToken.split('.')[1]));
            if (payload.exp && payload.exp * 1000 < Date.now()) {
                localStorage.removeItem('albion_auth_token');
                storedToken = null;
            }
        } catch { storedToken = null; localStorage.removeItem('albion_auth_token'); }
    }
    if (!storedToken && !tokenParam) {
        if (authChecking) authChecking.style.display = 'none';
        if (authContent) authContent.style.display = 'block';
        if (overlay) overlay.style.display = 'flex';
        return;
    }

    // --- Optimistic login from JWT claims (no network wait) ---
    // Decode the JWT payload to get user info immediately, then verify /api/me in background.
    // This avoids the 8-17s hang when VPS is slow or under heavy query load.
    let jwtPayload = null;
    try {
        jwtPayload = JSON.parse(atob(storedToken.split('.')[1]));
    } catch { /* invalid JWT, will fall through to network check */ }

    if (jwtPayload && jwtPayload.id) {
        // Optimistic: trust the JWT and show the UI immediately
        discordUser = {
            id: jwtPayload.id,
            username: jwtPayload.username || jwtPayload.name || 'User',
            avatar: jwtPayload.avatar || null,
            discriminator: jwtPayload.discriminator || '0'
        };

        dismissLandingOverlay();
        updateHeaderProfile(discordUser);
        const profileTab = document.getElementById('nav-profile-tab');
        if (profileTab) profileTab.style.display = '';

        // Handle device authorization immediately (no waiting for /api/me)
        if (pendingDevice) {
            sessionStorage.removeItem('pending_device_code');
            history.replaceState(null, '', window.location.pathname);
            showDeviceAuthDialog(pendingDevice);
        }

        // Verify /api/me in background — update tier, stats, full profile data
        // If verification fails (token revoked), sign out gracefully
        fetch(`${VPS_BASE}/api/me`, { headers: authHeaders(), signal: AbortSignal.timeout(6000) })
            .then(r => r.json())
            .then(data => {
                if (data.loggedIn) {
                    discordUser = data.user;
                    updateHeaderProfile(data.user);
                    window._userData = data;
                    const tier = data.stats && data.stats.tier;
                    if (tier) {
                        const tierBadge = document.getElementById('discord-tier-badge');
                        tierBadge.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
                        tierBadge.className = `tier-badge tier-${tier}`;
                        tierBadge.style.display = 'inline-block';
                    }
                } else {
                    // Token was revoked server-side — sign out
                    localStorage.removeItem('albion_auth_token');
                    location.reload();
                }
            })
            .catch(() => {
                // VPS unreachable — stay logged in optimistically, user can still use cached data
                console.warn('[Auth] VPS unreachable for verification — using JWT claims');
            });

        // Handle email verification redirect
        if (verifyParam === 'success') {
            const succDiv = document.getElementById('landing-auth-success');
            if (succDiv) { succDiv.style.display = 'flex'; succDiv.querySelector('span').textContent = 'Email verified successfully!'; }
        }

        return; // Done — page is usable immediately
    }

    // --- Fallback: JWT has no user claims (old format?) — do full /api/me check ---
    if (authChecking) authChecking.style.display = 'flex';
    if (authContent) authContent.style.display = 'none';

    let data;
    try {
        let res;
        try {
            res = await fetch(`${VPS_BASE}/api/me`, { headers: authHeaders(), signal: AbortSignal.timeout(6000) });
        } catch (retryErr) {
            await new Promise(r => setTimeout(r, 1000));
            res = await fetch(`${VPS_BASE}/api/me`, { headers: authHeaders(), signal: AbortSignal.timeout(6000) });
        }
        data = await res.json();
        if (data.loggedIn) {
            discordUser = data.user;

            dismissLandingOverlay();
            updateHeaderProfile(data.user);

            const tier = data.stats && data.stats.tier;
            if (tier) {
                const tierBadge = document.getElementById('discord-tier-badge');
                tierBadge.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
                tierBadge.className = `tier-badge tier-${tier}`;
                tierBadge.style.display = 'inline-block';
            }

            const profileTab = document.getElementById('nav-profile-tab');
            if (profileTab) profileTab.style.display = '';

            window._userData = data;

            if (verifyParam === 'success') {
                const succDiv = document.getElementById('landing-auth-success');
                if (succDiv) { succDiv.style.display = 'flex'; succDiv.querySelector('span').textContent = 'Email verified successfully!'; }
            }

            if (pendingDevice) {
                sessionStorage.removeItem('pending_device_code');
                history.replaceState(null, '', window.location.pathname);
                showDeviceAuthDialog(pendingDevice);
            }
        } else {
            // Not logged in — show login/guest options
            if (authChecking) authChecking.style.display = 'none';
            if (authContent) authContent.style.display = 'block';
            if (overlay) overlay.style.display = 'flex';
        }
    } catch (e) {
        console.log('Discord OAuth check failed:', e.message);
        // If the VPS is temporarily unreachable but we have a valid (non-expired) JWT,
        // decode its payload and log the user in using the embedded claims.
        // This prevents a transient network hiccup from looking like a login failure.
        const fallbackToken = localStorage.getItem('albion_auth_token');
        if (fallbackToken) {
            try {
                const payload = JSON.parse(atob(fallbackToken.split('.')[1]));
                if (payload.exp && payload.exp * 1000 > Date.now()) {
                    discordUser = {
                        id: payload.id,
                        username: payload.username,
                        avatar: payload.avatar,
                        authType: 'discord',
                        role: 'free'
                    };
                    dismissLandingOverlay();
                    updateHeaderProfile(discordUser);
                    window._userData = { user: discordUser, stats: { scans_30d: 0, scans_total: 0, tier: 'bronze' } };
                    console.log('[Auth] VPS unreachable — logged in from cached JWT claims');
                    return;
                }
            } catch { /* malformed token, fall through to error UI */ }
        }
        // No valid token — show connection error
        if (authChecking) authChecking.style.display = 'none';
        if (authContent) authContent.style.display = 'block';
        if (authError) {
            authError.style.display = 'flex';
            if (authErrorText) authErrorText.textContent = 'Could not reach server. You can browse as guest or try logging in.';
        }
        if (overlay) overlay.style.display = 'flex';
    }
}

async function loadServerCache(silent = false) {
    const statusEl = document.querySelector('.db-status-text');
    try {
        if (!silent && statusEl) statusEl.textContent = 'Loading shared market data...';
        const res = await fetch(`${VPS_BASE}/api/market-cache`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        if (payload.data && payload.data.length > 0) {
            await MarketDB.saveMarketData(payload.data);
            await MarketDB.setMeta('lastScan', { server: 'shared-cache', timestamp: payload.timestamp });
            console.log(`Loaded ${payload.count} prices from server cache (${payload.timestamp})`);
            await updateDbStatus();
            return true;
        }
    } catch (e) {
        console.log('Server cache not available, using local data:', e.message);
    }
    return false;
}

async function onServerChange() {
    const server = getServer();
    const serverLabels = { europe: 'Europe', west: 'Americas West', east: 'Asia East' };
    const statusEl = document.querySelector('.db-status-text');
    if (statusEl) statusEl.textContent = `Switching to ${serverLabels[server] || server}...`;

    // Clear all cached prices from the previous server
    await MarketDB.clearAll();
    invalidatePriceCache();

    // Reload from VPS cache only when the VPS scans the same server the user selected
    if (server === vpsGameServer) {
        await loadServerCache();
    } else {
        // Non-VPS server: VPS cache doesn't apply; prices load on-demand via AODP
        await updateDbStatus();
        showToast(`Switched to ${serverLabels[server]} — prices load on demand when you browse items`, 'info');
    }

    // Re-render browser immediately; other tabs require the user to re-run their scan
    if (currentTab === 'browser') await renderBrowser();
}

async function init() {
    // === IMMEDIATE: attach all UI listeners before any async work ===
    // Scripts are at bottom of <body> so DOM is fully ready here.
    initTabs();

    // Server switch: clear cached prices and reload for the new server
    document.getElementById('server-select').addEventListener('change', onServerChange);

    // Fresh filter mode shows/hides threshold dropdown
    const freshMode = document.getElementById('fresh-mode');
    const freshThresholdGroup = document.getElementById('fresh-threshold-group');
    const syncFreshThreshold = () => {
        freshThresholdGroup.style.display = freshMode.value === 'off' ? 'none' : '';
    };
    freshMode.addEventListener('change', syncFreshThreshold);
    syncFreshThreshold(); // sync on page load

    // Arbitrage tab
    document.getElementById('arb-scan-btn').addEventListener('click', () => doArbScan());
    setupAutocomplete('arb-search', 'arb-autocomplete', (id) => { arbSearchExactId = id; });
    document.getElementById('arb-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doArbScan();
    });
    document.getElementById('arb-search').addEventListener('input', () => { arbSearchExactId = null; });

    // Compare tab
    document.getElementById('compare-fetch-btn').addEventListener('click', doCompare);
    setupAutocomplete('compare-search', 'compare-autocomplete', (id) => { compareSelectedId = id; });
    document.getElementById('compare-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doCompare();
    });
    document.getElementById('compare-search').addEventListener('input', () => { compareSelectedId = null; });

    // Crafting tab
    document.getElementById('craft-search-btn').addEventListener('click', doCraftSearch);
    document.getElementById('craft-scan-btn').addEventListener('click', doCraftScan);
    document.getElementById('craft-recalc-btn').addEventListener('click', () => {
        // Re-render with cached data (no refetch needed for quality/settings changes)
        if (window._craftLastData && window._craftLastRecipe && window._craftLastItemId) {
            renderCraftDetail(window._craftLastItemId, window._craftLastRecipe, window._craftLastData);
        } else if (craftDetailItemId && recipesData[craftDetailItemId]) {
            doCraftSearch(); // Fallback: refetch if no cached data
        }
    });
    setupAutocomplete('craft-search', 'craft-autocomplete', (id) => { craftSearchExactId = id; });
    document.getElementById('craft-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doCraftSearch();
    });
    document.getElementById('craft-search').addEventListener('input', () => { craftSearchExactId = null; });

    // Crafting save/load
    const craftSaveBtn = document.getElementById('craft-save-btn');
    if (craftSaveBtn) craftSaveBtn.addEventListener('click', saveCraftSetup);
    const craftLoadSelect = document.getElementById('craft-load-select');
    if (craftLoadSelect) craftLoadSelect.addEventListener('change', loadCraftSetup);
    const craftDeleteSetupBtn = document.getElementById('craft-delete-setup-btn');
    if (craftDeleteSetupBtn) craftDeleteSetupBtn.addEventListener('click', deleteCraftSetup);
    loadCraftSetupDropdown();

    // Transport tab
    document.getElementById('transport-scan-btn').addEventListener('click', doTransportScan);

    // Transport mode toggle (Live vs Historical)
    document.querySelectorAll('.transport-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.transport-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Re-render with current data if we have it
            if (lastTransportRoutes) {
                const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
                const sortBy = document.getElementById('transport-sort').value;
                const { mountCapacity, freeSlots } = getTransportMountConfig();
                enrichAndRenderTransport(lastTransportRoutes, budget, sortBy, mountCapacity, freeSlots);
            }
        });
    });
    document.getElementById('transport-exclude-caerleon').addEventListener('change', function () {
        const sellSelect = document.getElementById('transport-sell-city');
        const exclude = this.checked;
        sellSelect.querySelectorAll('option[value="Caerleon"], option[value="Black Market"]').forEach(opt => {
            opt.hidden = exclude;
        });
        if (exclude && (sellSelect.value === 'Caerleon' || sellSelect.value === 'Black Market')) {
            sellSelect.value = '';
        }
    });

    // Loot Buyer: mode toggle and analyze button
    document.querySelectorAll('.loot-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.loot-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            lootAnalysisMode = btn.dataset.mode;
            const askSection = document.getElementById('loot-asking-price-section');
            if (askSection) askSection.style.display = lootAnalysisMode === 'worth' ? '' : 'none';
        });
    });
    const lootAnalyzeBtn = document.getElementById('loot-analyze-btn');
    if (lootAnalyzeBtn) lootAnalyzeBtn.addEventListener('click', analyzeLoot);

    // Loot Buyer: manual item entry
    initLootManualEntry();

    // Transport sell strategy: re-render on change
    const sellStrategyEl = document.getElementById('transport-sell-strategy');
    if (sellStrategyEl) {
        sellStrategyEl.addEventListener('change', () => {
            if (lastTransportRoutes) {
                const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
                const sortBy = document.getElementById('transport-sort').value;
                const { mountCapacity, freeSlots } = getTransportMountConfig();
                enrichAndRenderTransport(lastTransportRoutes, budget, sortBy, mountCapacity, freeSlots);
            }
        });
    }

    // Transport freshness filter: show/hide threshold, re-render on change
    const transportFreshMode = document.getElementById('transport-fresh-mode');
    const transportFreshThreshold = document.getElementById('transport-fresh-threshold');
    const transportFreshGroup = document.getElementById('transport-fresh-threshold-group');
    if (transportFreshMode) {
        transportFreshMode.addEventListener('change', () => {
            if (transportFreshGroup) transportFreshGroup.style.display = transportFreshMode.value === 'off' ? 'none' : '';
            if (lastTransportRoutes) {
                const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
                const sortBy = document.getElementById('transport-sort').value;
                const { mountCapacity, freeSlots } = getTransportMountConfig();
                enrichAndRenderTransport(lastTransportRoutes, budget, sortBy, mountCapacity, freeSlots);
            }
        });
    }
    if (transportFreshThreshold) {
        transportFreshThreshold.addEventListener('change', () => {
            if (lastTransportRoutes && transportFreshMode?.value !== 'off') {
                const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
                const sortBy = document.getElementById('transport-sort').value;
                const { mountCapacity, freeSlots } = getTransportMountConfig();
                enrichAndRenderTransport(lastTransportRoutes, budget, sortBy, mountCapacity, freeSlots);
            }
        });
    }

    // Transport mount: update capacity info line and re-render on change
    const transportMountEl = document.getElementById('transport-mount');
    function updateMountCapacityInfo() {
        const key = transportMountEl?.value || 'mammoth_t8';
        const md = MOUNT_DATA[key] || MOUNT_DATA['mammoth_t8'];
        const infoEl = document.getElementById('transport-mount-info');
        if (!infoEl) return;
        const weightStr = Number.isFinite(md.weight) ? md.weight.toLocaleString() + ' kg' : '∞';
        infoEl.textContent = `Carry capacity: ${weightStr}`;
    }
    if (transportMountEl) {
        transportMountEl.addEventListener('change', () => {
            updateMountCapacityInfo();
            if (lastTransportRoutes) {
                const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
                const sortBy = document.getElementById('transport-sort').value;
                const { mountCapacity, freeSlots } = getTransportMountConfig();
                enrichAndRenderTransport(lastTransportRoutes, budget, sortBy, mountCapacity, freeSlots);
            }
        });
        updateMountCapacityInfo();
    }

    // Alerts tab
    document.getElementById('alert-create-btn').addEventListener('click', createAlert);
    // Load alerts/community when switching to those tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.dataset.tab === 'alerts') loadAlerts();
            if (tab.dataset.tab === 'community') loadCommunityTab();
        });
    });

    // Browser search/filters
    setupAutocomplete('browser-search', 'browser-autocomplete', (id) => {
        document.getElementById('browser-search').value = getFriendlyName(id);
        browserPage = 1;
        renderBrowser();
    });

    const doBrowserSearch = () => {
        browserPage = 1;
        renderBrowser();
    };

    document.getElementById('browser-search-btn').addEventListener('click', doBrowserSearch);
    document.getElementById('browser-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doBrowserSearch();
        }
    });

    // Chart modal close
    document.getElementById('chart-close-btn').addEventListener('click', () => {
        document.getElementById('chart-modal').classList.add('hidden');
    });

    // Chart tab switching
    document.querySelectorAll('.chart-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chart-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.chartTab;
            document.getElementById('chart-pane-live').classList.toggle('hidden', tab !== 'live');
            document.getElementById('chart-pane-analytics').classList.toggle('hidden', tab !== 'analytics');
            if (tab === 'analytics' && currentChartItemId) {
                const city = document.getElementById('chart-city-select')?.value;
                const days = parseInt(document.querySelector('input[name="analytics-time"]:checked')?.value || '30');
                if (city && city !== 'Loading...') renderAnalyticsChart(currentChartItemId, city, days);
            }
        });
    });

    // Black Market Flipper tab
    const bmScanBtn = document.getElementById('bm-scan-btn');
    if (bmScanBtn) {
        bmScanBtn.addEventListener('click', () => doBMFlipperScan());
    }

    // Journals Calculator tab
    const journalCalcBtn = document.getElementById('journal-calc-btn');
    if (journalCalcBtn) {
        journalCalcBtn.addEventListener('click', () => calculateJournals());
    }

    // RRR Calculator tab
    const rrrCalcBtn = document.getElementById('rrr-calc-btn');
    if (rrrCalcBtn) {
        rrrCalcBtn.addEventListener('click', () => calculateRRRStandalone());
    }
    // Also auto-calculate on input changes for RRR
    ['rrr-activity', 'rrr-spec', 'rrr-city-bonus', 'rrr-use-focus', 'rrr-premium'].forEach(elId => {
        const el = document.getElementById(elId);
        if (el) {
            el.addEventListener('change', () => calculateRRRStandalone());
            if (el.type === 'number' || el.type === 'range') {
                el.addEventListener('input', () => calculateRRRStandalone());
            }
        }
    });

    // Repair Cost Calculator tab
    const repairCalcBtn = document.getElementById('repair-calc-btn');
    if (repairCalcBtn) {
        repairCalcBtn.addEventListener('click', () => calculateRepairCost());
    }
    setupAutocomplete('repair-search', 'repair-autocomplete', (id) => { repairSearchExactId = id; });
    const repairSearchInput = document.getElementById('repair-search');
    if (repairSearchInput) {
        repairSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') calculateRepairCost();
        });
        repairSearchInput.addEventListener('input', () => { repairSearchExactId = null; });
    }

    // Item Power Checker
    const ipScanBtn = document.getElementById('ip-scan-btn');
    if (ipScanBtn) ipScanBtn.addEventListener('click', doItemPowerScan);

    // Favorites
    const favNewBtn = document.getElementById('fav-new-btn');
    if (favNewBtn) favNewBtn.addEventListener('click', () => {
        document.getElementById('fav-editor').style.display = 'block';
        favCurrentItems = [];
        document.getElementById('fav-list-name').value = '';
        document.getElementById('fav-items-list').innerHTML = '';
    });
    const favSaveBtn = document.getElementById('fav-save-btn');
    if (favSaveBtn) favSaveBtn.addEventListener('click', saveFavoriteList);
    const favLoadBtn = document.getElementById('fav-load-btn');
    if (favLoadBtn) favLoadBtn.addEventListener('click', loadFavoriteListPrices);
    const favDeleteBtn = document.getElementById('fav-delete-btn');
    if (favDeleteBtn) favDeleteBtn.addEventListener('click', deleteFavoriteList);
    setupAutocomplete('fav-item-search', 'fav-autocomplete', (id) => { addFavoriteItem(id); });

    // Mounts
    const mountScanBtn = document.getElementById('mount-scan-btn');
    if (mountScanBtn) mountScanBtn.addEventListener('click', loadMountsDatabase);

    // Top Traded
    const topScanBtn = document.getElementById('top-scan-btn');
    if (topScanBtn) topScanBtn.addEventListener('click', loadTopTraded);

    // Portfolio
    const portfolioAddBtn = document.getElementById('portfolio-add-btn');
    if (portfolioAddBtn) portfolioAddBtn.addEventListener('click', () => {
        document.getElementById('portfolio-form').style.display = 'block';
    });
    const portfolioCancelBtn = document.getElementById('portfolio-cancel-btn');
    if (portfolioCancelBtn) portfolioCancelBtn.addEventListener('click', () => {
        document.getElementById('portfolio-form').style.display = 'none';
    });
    const portfolioSubmitBtn = document.getElementById('portfolio-submit-btn');
    if (portfolioSubmitBtn) portfolioSubmitBtn.addEventListener('click', addPortfolioTrade);
    const portfolioExportBtn = document.getElementById('portfolio-export-btn');
    if (portfolioExportBtn) portfolioExportBtn.addEventListener('click', exportPortfolioCSV);
    const portfolioClearBtn = document.getElementById('portfolio-clear-btn');
    if (portfolioClearBtn) portfolioClearBtn.addEventListener('click', clearPortfolio);
    setupAutocomplete('portfolio-item-search', 'portfolio-autocomplete', (id) => { portfolioSearchExactId = id; });
    const portfolioSearchInput = document.getElementById('portfolio-item-search');
    if (portfolioSearchInput) portfolioSearchInput.addEventListener('input', () => { portfolioSearchExactId = null; });

    // Farming
    const farmCalcBtn = document.getElementById('farm-calc-btn');
    if (farmCalcBtn) farmCalcBtn.addEventListener('click', calculateFarming);

    // Builds Browser
    const buildsLoadBtn = document.getElementById('builds-load-btn');
    if (buildsLoadBtn) buildsLoadBtn.addEventListener('click', () => loadBuilds(false));
    const buildsMoreBtn = document.getElementById('builds-more-btn');
    if (buildsMoreBtn) buildsMoreBtn.addEventListener('click', () => loadBuilds(true));

    // Landing page: Guest skip button
    const guestBtn = document.getElementById('landing-guest-btn');
    if (guestBtn) guestBtn.addEventListener('click', dismissLandingOverlay);

    // Landing page: Discord button loading state
    const landingDiscordBtn = document.getElementById('landing-discord-btn');
    if (landingDiscordBtn) {
        landingDiscordBtn.addEventListener('click', () => {
            landingDiscordBtn.classList.add('loading');
        });
    }

    // Auth tabs: switch between Login and Register forms
    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const mode = tab.dataset.tab;
            const loginForm = document.getElementById('auth-login-form');
            const registerForm = document.getElementById('auth-register-form');
            if (loginForm) loginForm.style.display = mode === 'login' ? 'flex' : 'none';
            if (registerForm) registerForm.style.display = mode === 'register' ? 'flex' : 'none';
            // Clear errors
            const errDiv = document.getElementById('landing-auth-error');
            if (errDiv) errDiv.style.display = 'none';
            const succDiv = document.getElementById('landing-auth-success');
            if (succDiv) succDiv.style.display = 'none';
        });
    });

    // Email/password login form
    const loginForm = document.getElementById('auth-login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email').value.trim();
            const password = document.getElementById('login-password').value;
            const submitBtn = loginForm.querySelector('.btn-auth-submit');
            const errDiv = document.getElementById('landing-auth-error');
            const errText = document.getElementById('landing-auth-error-text');

            if (errDiv) errDiv.style.display = 'none';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing in...'; }

            try {
                const res = await fetch(`${VPS_BASE}/api/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();
                if (data.success && data.token) {
                    localStorage.setItem('albion_auth_token', data.token);
                    discordUser = data.user;
                    dismissLandingOverlay();
                    updateHeaderProfile(data.user);
                } else {
                    if (errDiv && errText) { errText.textContent = data.error || 'Login failed.'; errDiv.style.display = 'flex'; }
                }
            } catch (err) {
                if (errDiv && errText) { errText.textContent = 'Could not reach server. Please try again.'; errDiv.style.display = 'flex'; }
            }
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Sign In'; }
        });
    }

    // Email/password registration form
    const registerForm = document.getElementById('auth-register-form');
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('register-username').value.trim();
            const email = document.getElementById('register-email').value.trim();
            const password = document.getElementById('register-password').value;
            const submitBtn = registerForm.querySelector('.btn-auth-submit');
            const errDiv = document.getElementById('landing-auth-error');
            const errText = document.getElementById('landing-auth-error-text');
            const succDiv = document.getElementById('landing-auth-success');
            const succText = document.getElementById('landing-auth-success-text');

            if (errDiv) errDiv.style.display = 'none';
            if (succDiv) succDiv.style.display = 'none';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating account...'; }

            try {
                const res = await fetch(`${VPS_BASE}/api/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, email, password })
                });
                const data = await res.json();
                if (data.success && data.token) {
                    localStorage.setItem('albion_auth_token', data.token);
                    discordUser = data.user;
                    dismissLandingOverlay();
                    updateHeaderProfile(data.user);
                } else {
                    if (errDiv && errText) { errText.textContent = data.error || 'Registration failed.'; errDiv.style.display = 'flex'; }
                }
            } catch (err) {
                if (errDiv && errText) { errText.textContent = 'Could not reach server. Please try again.'; errDiv.style.display = 'flex'; }
            }
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg> Create Account'; }
        });
    }

    // Initialize portfolio on load
    renderPortfolio();

    // Load favorites dropdown on load
    loadFavoriteLists();

    // Initialize RRR with default values so it doesn't show "--"
    calculateRRRStandalone();

    // Connect live sync immediately — doesn't need data
    initLiveSync();

    // Live Flips filter handlers
    ['flips-min-profit', 'flips-min-roi', 'flips-city-filter', 'flips-type-filter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => renderLiveFlips());
    });

    // Live Flips notification toggles
    const desktopNotifyToggle = document.getElementById('flips-desktop-notify-toggle');
    if (desktopNotifyToggle) {
        desktopNotifyToggle.addEventListener('change', () => {
            if (desktopNotifyToggle.checked && Notification.permission === 'default') {
                Notification.requestPermission();
            }
        });
    }

    // === ASYNC: load data and update UI in background ===
    // Run checkDiscordAuth concurrently with loadData — do NOT await it first.
    // Awaiting it blocks the entire init chain for up to 10s if the VPS is slow,
    // freezing the UI with the landing overlay showing and no feedback.
    checkDiscordAuth(); // fire-and-forget — manages the overlay itself
    await loadData();

    // Auto-detect which game server the VPS scans and match the dropdown
    try {
        const statusRes = await fetch(`${VPS_BASE}/api/market-cache/status`);
        if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.gameServer) {
                const serverMap = { 'west': 'west', 'east': 'east', 'europe': 'europe' };
                const serverVal = serverMap[statusData.gameServer];
                if (serverVal) {
                    document.getElementById('server-select').value = serverVal;
                    vpsGameServer = serverVal;
                }
            }
        }
    } catch (e) { /* ignore */ }

    // Load VPS cache on startup — only when the selected server matches the VPS server.
    // If the user switched servers during init (race), or on first load of a non-VPS server,
    // skip the load so we don't populate the DB with the wrong server's prices.
    if (getServer() === vpsGameServer) await loadServerCache();

    // Evict stale prices older than 24h
    await MarketDB.evictStale(24 * 60 * 60 * 1000);

    await updateDbStatus();

    // Background refresh: pull server cache every 5 min + evict stale data.
    // Only reload VPS cache when the user is on the same server the VPS scans.
    setInterval(async () => {
        if (getServer() === vpsGameServer) await loadServerCache(true);
        await MarketDB.evictStale(24 * 60 * 60 * 1000);
        if (currentTab === 'browser') renderBrowser();
    }, 5 * 60 * 1000);

    // Keep db-status indicator fresh
    setInterval(updateDbStatus, 60 * 1000);

    // Initial render (now we have item data)
    renderBrowser();
}

// ====== 0-DELAY LIVE SYNC (VPS WEBSOCKET) ======
let wsLink = null;
const API_LOCALE_MAP = {
    '0': 'Thetford',
    '7': 'Thetford', 
    '3004': 'Thetford',
    '3': 'Lymhurst',
    '1002': 'Lymhurst',
    '4': 'Bridgewatch',
    '2004': 'Bridgewatch',
    '3003': 'Black Market',
    '3005': 'Caerleon',
    '3008': 'Fort Sterling',
    '4000': 'Martlock',
    '4300': 'Brecilien'
};

function initLiveSync() {
    const syncDot = document.querySelector('.live-sync-dot');
    const syncText = document.querySelector('.live-sync-text');

    // Tear down the old socket before creating a new one.
    // Without this, the old socket's onclose fires after reconnect and creates
    // a second concurrent connection, accumulating open sockets over time.
    if (wsLink) {
        wsLink.onopen = null;
        wsLink.onclose = null;
        wsLink.onmessage = null;
        if (wsLink.readyState !== WebSocket.CLOSED) wsLink.close();
        wsLink = null;
    }

    // Connect to the new VPS Proxy
    wsLink = new WebSocket('wss://albionaitool.xyz');

    wsLink.onopen = () => {
        console.log("🟢 Connected to Live NATS Stream at 209-97-129-125");
        if(syncText) syncText.textContent = "Live Sync Active";
        if(syncDot) {
            syncDot.style.background = '#00ff00';
            syncDot.style.boxShadow = '0 0 8px #00ff00';
        }
        // Authenticate WebSocket for live flips if user is logged in
        const token = localStorage.getItem('albion_auth_token');
        if (token) {
            wsLink.send(JSON.stringify({ type: 'auth', token }));
        }
    };

    wsLink.onclose = () => {
        console.log("🔴 Live Stream Disconnected. Reconnecting in 5s...");
        if(syncText) syncText.textContent = "Live Sync Offline";
        if(syncDot) {
            syncDot.style.background = 'var(--loss-red)';
            syncDot.style.boxShadow = '0 0 6px var(--loss-red)';
        }
        setTimeout(initLiveSync, 5000);
    };

    wsLink.onmessage = async (e) => {
        try {
            const data = JSON.parse(e.data);

            // Handle server messages (auth response, flip data)
            if (data.type === 'auth') {
                const statusEl = document.getElementById('flips-connection-status');
                const dot = document.getElementById('live-flips-dot');
                if (data.success) {
                    if (statusEl) statusEl.innerHTML = '<span style="color:#22c55e;">Connected</span>';
                    if (dot) dot.classList.add('connected');
                    wsFlipsAuthenticated = true;
                } else {
                    if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">Auth failed</span>';
                }
                return;
            }

            if (data.type === 'flip-history') {
                // Initial batch of recent flips
                if (data.data && Array.isArray(data.data)) {
                    liveFlipsCache = data.data;
                    renderLiveFlips();
                }
                return;
            }

            if (data.type === 'flip') {
                // Single new flip detected
                if (data.data) {
                    liveFlipsCache.unshift(data.data);
                    if (liveFlipsCache.length > 200) liveFlipsCache.pop();
                    renderLiveFlips(true);
                    // Flash the tab if not active
                    const tab = document.querySelector('[data-tab="live-flips"]');
                    if (tab && currentTab !== 'live-flips') {
                        tab.classList.add('has-new');
                        setTimeout(() => tab.classList.remove('has-new'), 3000);
                    }
                }
                return;
            }

            // Chest captures from game client
            if (data.type === 'chest-capture' || data.type === 'chest-captures') {
                const captures = data.type === 'chest-captures' ? data.data : [data.data];
                if (captures && captures.length > 0) {
                    for (const cap of captures) {
                        if (cap && cap.items) lootBuyerCaptures.unshift(cap);
                    }
                    if (lootBuyerCaptures.length > 20) lootBuyerCaptures.length = 20;
                    renderLootCaptures();
                    // Flash the tab
                    const tab = document.querySelector('[data-tab="loot-buyer"]');
                    if (tab && currentTab !== 'loot-buyer') {
                        tab.classList.add('has-new');
                        setTimeout(() => tab.classList.remove('has-new'), 3000);
                    }
                }
                return;
            }

            // Sale notification from in-game mail
            if (data.type === 'sale-notification' && data.data) {
                const sale = data.data;
                const name = sale.itemId || 'Unknown';
                const qty = sale.amount || 1;
                const price = (sale.price || 0).toLocaleString();
                showToast(`Sold: ${name} x${qty} @ ${price} silver`, 'success');
                // Refresh Phase 3 if on Loot Buyer tab
                if (currentTab === 'loot-buyer' && typeof loadTrackedTabs === 'function') loadTrackedTabs();
                // Store for Recent Sales feed
                if (!window._recentSales) window._recentSales = [];
                window._recentSales.unshift({ ...sale, receivedAt: Date.now() });
                if (window._recentSales.length > 20) window._recentSales.length = 20;
                renderRecentSales();
                return;
            }

            // Loot events + chest captures → loot logger
            if (typeof handleLootLoggerWsMessage === 'function') handleLootLoggerWsMessage(data);

            // Standard NATS market data
            // Format incoming NATS string arrays back to the standardized MarketDB schema
            // IMPORTANT: NATS packets are individual orders, NOT authoritative market summaries.
            // We use a low-priority date so db.js merge will only accept them if the price is BETTER
            // (lower sell_price_min or higher buy_price_max), not just because the date is "newer".
            const formattedUpdates = [];
            const natsDate = ''; // Empty date = lowest priority → only wins via better price path

            for (const payload of data) {
                 if (!payload.LocationId || !API_LOCALE_MAP[payload.LocationId]) continue;
                 if (!payload.UnitPriceSilver || payload.UnitPriceSilver <= 0) continue;

                 formattedUpdates.push({
                     item_id: payload.ItemTypeId,
                     city: API_LOCALE_MAP[payload.LocationId],
                     quality: payload.QualityLevel,
                     sell_price_min: payload.AuctionType === 'offer' ? payload.UnitPriceSilver : 0,
                     sell_price_min_date: natsDate,
                     buy_price_max: payload.AuctionType === 'request' ? payload.UnitPriceSilver : 0,
                     buy_price_max_date: natsDate
                 });
            }

            if (formattedUpdates.length > 0) {
                 // Non-blocking background save to IndexedDB
                 // With empty dates, these only overwrite cached prices if the new price is strictly better
                 MarketDB.saveMarketData(formattedUpdates);
            }

        } catch(err) {
            // Silently drop unparseable packets to avoid console spam
        }
    };
}

// ====== LIVE FLIPS TAB ======
let liveFlipsCache = [];
let wsFlipsAuthenticated = false;

function initLiveFlipsTab() {
    const authGate = document.getElementById('flips-auth-gate');
    const feed = document.getElementById('flips-feed');
    const token = localStorage.getItem('albion_auth_token');

    if (!token || !discordUser) {
        // Not logged in — show auth gate
        if (authGate) authGate.style.display = 'block';
        if (feed) feed.style.display = 'none';
        return;
    }

    // Logged in — show feed
    if (authGate) authGate.style.display = 'none';
    if (feed) feed.style.display = 'block';

    // If WS is connected but not authenticated for flips, authenticate now
    if (wsLink && wsLink.readyState === WebSocket.OPEN && !wsFlipsAuthenticated) {
        wsLink.send(JSON.stringify({ type: 'auth', token }));
    }

    // If we already have cached flips from a previous auth, render them
    if (liveFlipsCache.length > 0) renderLiveFlips();

    // Also fetch initial batch via REST API as backup
    if (liveFlipsCache.length === 0) {
        fetch(`${VPS_BASE}/api/live-flips`, { headers: authHeaders() })
            .then(r => r.json())
            .then(data => {
                if (data.flips && data.flips.length > 0) {
                    liveFlipsCache = data.flips;
                    renderLiveFlips();
                }
            })
            .catch(() => {});
    }
}

function renderLiveFlips(isNewFlip = false) {
    const container = document.getElementById('flips-list');
    if (!container) return;

    const minProfit = parseInt(document.getElementById('flips-min-profit')?.value) || 50000;
    const minRoi = parseFloat(document.getElementById('flips-min-roi')?.value) || 3;
    const cityFilter = document.getElementById('flips-city-filter')?.value || 'all';
    const typeFilter = document.getElementById('flips-type-filter')?.value || 'all';

    const filtered = liveFlipsCache.filter(f => {
        if (f.profit < minProfit || f.roi < minRoi) return false;
        if (cityFilter !== 'all' && f.buyCity !== cityFilter && f.sellCity !== cityFilter) return false;
        if (typeFilter !== 'all' && (f.type || 'cross-city') !== typeFilter) return false;
        return true;
    });

    // Update stats
    const statsEl = document.getElementById('flips-stats');
    if (statsEl) {
        const totalProfit = filtered.reduce((s, f) => s + f.profit, 0);
        statsEl.textContent = `${filtered.length} flips | ${(totalProfit / 1000).toFixed(0)}k potential silver`;
    }

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No flips matching your filters yet.</p><p class="hint">Profitable opportunities will appear here in real-time. Try lowering the minimum profit or ROI.</p></div>';
        return;
    }

    // Sound + desktop notification for new flips
    if (isNewFlip && filtered.length > 0) {
        const flip = filtered[0];
        if (document.getElementById('flips-sound-toggle')?.checked) {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain); gain.connect(ctx.destination);
                osc.frequency.value = 880; gain.gain.value = 0.08;
                osc.start(); osc.stop(ctx.currentTime + 0.12);
            } catch {}
        }
        if (document.getElementById('flips-desktop-notify-toggle')?.checked && Notification.permission === 'granted') {
            new Notification(`Flip: ${flip.name}`, {
                body: `${flip.buyCity} -> ${flip.sellCity} | +${flip.profit.toLocaleString()} silver (${flip.roi}% ROI)`,
                icon: `https://render.albiononline.com/v1/item/${flip.itemId}.png?quality=${flip.quality}`,
                tag: flip.id
            });
        }
    }

    container.innerHTML = filtered.map((flip, i) => {
        const ago = timeAgo(new Date(flip.detectedAt).toISOString());
        const isNew = isNewFlip && i === 0;
        const qualName = flip.quality > 1 ? ` q${flip.quality}` : '';
        const flipType = flip.type || 'cross-city';
        const typeBadge = flipType === 'instant'
            ? '<span class="flip-type-badge instant">Instant</span>'
            : '<span class="flip-type-badge cross-city">Transport</span>';
        const routeArrow = flipType === 'instant'
            ? '<span style="margin:0 4px; color:var(--purple);">&#8634;</span>'
            : '<span style="margin:0 4px; color:var(--text-muted);">&#10142;</span>';
        return `<div class="flip-card${isNew ? ' new' : ''}">
            <img class="flip-icon" src="https://render.albiononline.com/v1/item/${flip.itemId}.png?quality=${flip.quality}" alt="" loading="lazy">
            <div style="min-width:0;">
                <div style="display:flex; align-items:center; gap:0.4rem; font-weight:600; font-size:0.88rem; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(flip.name)}${qualName} ${typeBadge}</div>
                <div class="flip-route">
                    <span style="color:var(--text-secondary);">${esc(flip.buyCity)}</span>
                    <span style="color:var(--text-muted);"> @ ${Math.floor(flip.buyPrice).toLocaleString()}</span>
                    ${routeArrow}
                    <span style="color:var(--text-secondary);">${esc(flip.sellCity)}</span>
                    <span style="color:var(--text-muted);"> @ ${Math.floor(flip.sellPrice).toLocaleString()}</span>
                    <span style="margin-left:6px; opacity:0.6;">${ago}</span>
                </div>
            </div>
            <div class="flip-profit">
                <div class="amount">+${flip.profit.toLocaleString()}</div>
                <div class="roi">${flip.roi}% ROI</div>
            </div>
        </div>`;
    }).join('');

    // Remove 'new' class after animation
    if (isNewFlip) {
        setTimeout(() => {
            const newCard = container.querySelector('.flip-card.new');
            if (newCard) newCard.classList.remove('new');
        }, 3000);
    }
}

// ====== PROFILE TAB ======
function initProfileTab() {
    if (!discordUser || !window._userData) {
        // Fetch fresh data
        fetch(`${VPS_BASE}/api/me`, { headers: authHeaders() })
            .then(r => r.json())
            .then(data => {
                if (data.loggedIn) {
                    window._userData = data;
                    renderProfile(data);
                }
            }).catch(() => {});
        return;
    }
    renderProfile(window._userData);
}

function renderProfile(data) {
    const user = data.user;
    const stats = data.stats || {};

    // Avatar
    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl) {
        if (user.avatar && user.authType !== 'email') {
            avatarEl.src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
        } else {
            avatarEl.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="%23888" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>');
        }
    }

    // Display name & email
    const nameEl = document.getElementById('profile-display-name');
    if (nameEl) nameEl.textContent = user.username;
    const emailEl = document.getElementById('profile-email-display');
    if (emailEl) emailEl.textContent = user.email || '';
    const currentUsernameEl = document.getElementById('profile-current-username');
    if (currentUsernameEl) currentUsernameEl.textContent = user.username;

    // Member since
    const sinceEl = document.getElementById('profile-member-since');
    if (sinceEl && user.createdAt) {
        sinceEl.textContent = 'Member since ' + new Date(user.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    }

    // Auth type badge
    const authBadge = document.getElementById('profile-auth-type');
    if (authBadge) {
        authBadge.textContent = user.authType === 'discord' ? 'Discord' : 'Email';
    }

    // Tier
    const tierEl = document.getElementById('profile-tier-display');
    if (tierEl && stats.tier) {
        tierEl.textContent = stats.tier.charAt(0).toUpperCase() + stats.tier.slice(1);
        tierEl.className = `tier-badge tier-${stats.tier}`;
    }

    // Verified badge
    const verifiedBadge = document.getElementById('profile-verified-badge');
    if (verifiedBadge) {
        verifiedBadge.style.display = user.emailVerified ? 'inline-block' : 'none';
    }

    // Verification banner
    const verifyBanner = document.getElementById('profile-verify-banner');
    if (verifyBanner) {
        verifyBanner.style.display = (user.authType === 'email' && !user.emailVerified) ? 'flex' : 'none';
    }

    // Stats
    const s30d = document.getElementById('profile-scans-30d');
    if (s30d) s30d.textContent = (stats.scans_30d || 0).toLocaleString();
    const sTotal = document.getElementById('profile-scans-total');
    if (sTotal) sTotal.textContent = (stats.scans_total || 0).toLocaleString();
    const tierText = document.getElementById('profile-tier-text');
    if (tierText && stats.tier) tierText.textContent = stats.tier.charAt(0).toUpperCase() + stats.tier.slice(1);

    // Password section visibility (email accounts only)
    const pwSection = document.getElementById('profile-password-section');
    if (pwSection) pwSection.style.display = user.authType === 'email' ? 'block' : 'none';

    // Discord link/unlink
    const linkBtn = document.getElementById('profile-discord-link-btn');
    const unlinkBtn = document.getElementById('profile-discord-unlink-btn');
    const discordStatus = document.getElementById('profile-discord-status');
    if (user.hasDiscordLinked) {
        if (discordStatus) discordStatus.textContent = 'Linked';
        if (linkBtn) linkBtn.style.display = 'none';
        if (unlinkBtn) unlinkBtn.style.display = '';
    } else {
        if (discordStatus) discordStatus.textContent = 'Not linked';
        if (linkBtn) linkBtn.style.display = '';
        if (unlinkBtn) unlinkBtn.style.display = 'none';
    }

    // Wire up event handlers (use onclick to avoid duplicate listeners)
    const resendBtn = document.getElementById('profile-resend-btn');
    if (resendBtn) resendBtn.onclick = async () => {
        resendBtn.disabled = true; resendBtn.textContent = 'Sending...';
        try {
            const res = await fetch(`${VPS_BASE}/api/resend-verification`, { method: 'POST', headers: authHeaders() });
            const d = await res.json();
            resendBtn.textContent = d.success ? 'Sent!' : (d.error || 'Failed');
        } catch { resendBtn.textContent = 'Failed'; }
        setTimeout(() => { resendBtn.disabled = false; resendBtn.textContent = 'Resend Email'; }, 3000);
    };

    const saveUsernameBtn = document.getElementById('profile-save-username-btn');
    if (saveUsernameBtn) saveUsernameBtn.onclick = async () => {
        const newName = document.getElementById('profile-new-username')?.value.trim();
        const msgEl = document.getElementById('profile-username-msg');
        if (!newName || newName.length < 2) { if (msgEl) { msgEl.textContent = 'Min 2 characters'; msgEl.className = 'profile-msg error'; } return; }
        try {
            const res = await fetch(`${VPS_BASE}/api/change-username`, {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: newName })
            });
            const d = await res.json();
            if (d.success) {
                if (d.token) localStorage.setItem('albion_auth_token', d.token);
                discordUser.username = d.username;
                if (nameEl) nameEl.textContent = d.username;
                if (currentUsernameEl) currentUsernameEl.textContent = d.username;
                document.getElementById('discord-username').textContent = d.username;
                if (msgEl) { msgEl.textContent = 'Updated!'; msgEl.className = 'profile-msg success'; }
                document.getElementById('profile-username-form').classList.add('hidden');
            } else {
                if (msgEl) { msgEl.textContent = d.error || 'Failed'; msgEl.className = 'profile-msg error'; }
            }
        } catch { if (msgEl) { msgEl.textContent = 'Network error'; msgEl.className = 'profile-msg error'; } }
    };

    const savePasswordBtn = document.getElementById('profile-save-password-btn');
    if (savePasswordBtn) savePasswordBtn.onclick = async () => {
        const curPw = document.getElementById('profile-current-password')?.value;
        const newPw = document.getElementById('profile-new-password')?.value;
        const msgEl = document.getElementById('profile-password-msg');
        if (!curPw || !newPw) { if (msgEl) { msgEl.textContent = 'Both fields required'; msgEl.className = 'profile-msg error'; } return; }
        if (newPw.length < 8) { if (msgEl) { msgEl.textContent = 'Min 8 characters'; msgEl.className = 'profile-msg error'; } return; }
        try {
            const res = await fetch(`${VPS_BASE}/api/change-password`, {
                method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: curPw, newPassword: newPw })
            });
            const d = await res.json();
            if (d.success) {
                if (msgEl) { msgEl.textContent = 'Password updated!'; msgEl.className = 'profile-msg success'; }
                document.getElementById('profile-password-form').classList.add('hidden');
                document.getElementById('profile-current-password').value = '';
                document.getElementById('profile-new-password').value = '';
            } else {
                if (msgEl) { msgEl.textContent = d.error || 'Failed'; msgEl.className = 'profile-msg error'; }
            }
        } catch { if (msgEl) { msgEl.textContent = 'Network error'; msgEl.className = 'profile-msg error'; } }
    };

    if (linkBtn) linkBtn.onclick = async () => {
        try {
            const res = await fetch(`${VPS_BASE}/api/link-discord`, { method: 'POST', headers: authHeaders() });
            const d = await res.json();
            if (d.url) window.location.href = d.url;
        } catch { showToast('Failed to start Discord linking.', 'error'); }
    };

    if (unlinkBtn) unlinkBtn.onclick = async () => {
        if (!confirm('Unlink your Discord account?')) return;
        try {
            const res = await fetch(`${VPS_BASE}/api/unlink-discord`, { method: 'POST', headers: authHeaders() });
            const d = await res.json();
            if (d.success) {
                if (discordStatus) discordStatus.textContent = 'Not linked';
                unlinkBtn.style.display = 'none';
                linkBtn.style.display = '';
            } else {
                showToast(d.error || 'Failed to unlink.', 'error');
            }
        } catch { showToast('Network error.', 'error'); }
    };

    // Capture token
    const genTokenBtn = document.getElementById('profile-generate-token-btn');
    const tokenDisplay = document.getElementById('profile-capture-token-display');
    const tokenValue = document.getElementById('profile-capture-token-value');
    const tokenStatus = document.getElementById('profile-capture-token-status');

    // Load existing token
    fetch(`${VPS_BASE}/api/capture-token`, { headers: authHeaders() })
        .then(r => r.json())
        .then(d => {
            if (d.token) {
                if (tokenStatus) tokenStatus.textContent = 'Active';
                if (tokenValue) tokenValue.textContent = d.token;
                if (tokenDisplay) tokenDisplay.classList.remove('hidden');
            }
        }).catch(() => {});

    if (genTokenBtn) genTokenBtn.onclick = async () => {
        try {
            const res = await fetch(`${VPS_BASE}/api/generate-capture-token`, { method: 'POST', headers: authHeaders() });
            const d = await res.json();
            if (d.success && d.token) {
                if (tokenStatus) tokenStatus.textContent = 'Active';
                if (tokenValue) tokenValue.textContent = d.token;
                if (tokenDisplay) tokenDisplay.classList.remove('hidden');
            }
        } catch { showToast('Failed to generate token.', 'error'); }
    };
}

// ====== LOOT BUYER TAB ======
let lootBuyerCaptures = [];
let lootAnalysisMode = 'worth';
let lootSelectedCapture = null;
let lastLootEvalData = null; // retained for "I Bought This" save action
let lootManualItems = []; // manually added items for analysis

function initLootManualEntry() {
    const toggleBtn = document.getElementById('loot-manual-toggle');
    const form = document.getElementById('loot-manual-form');
    if (!toggleBtn || !form) return;

    toggleBtn.addEventListener('click', () => {
        form.style.display = form.style.display === 'none' ? '' : 'none';
    });

    let selectedItemId = null;
    setupAutocomplete('loot-manual-search', 'loot-manual-autocomplete', (id) => {
        selectedItemId = id;
    });

    const addBtn = document.getElementById('loot-manual-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => {
        if (!selectedItemId) return;
        const quality = parseInt(document.getElementById('loot-manual-quality').value) || 1;
        const qty = Math.max(1, parseInt(document.getElementById('loot-manual-qty').value) || 1);

        // Check if same item+quality already in list — merge quantities
        const existing = lootManualItems.find(it => it.itemId === selectedItemId && it.quality === quality);
        if (existing) {
            existing.quantity += qty;
        } else {
            lootManualItems.push({ itemId: selectedItemId, quality, quantity: qty, isEquipment: false });
        }

        // Reset inputs
        document.getElementById('loot-manual-search').value = '';
        document.getElementById('loot-manual-qty').value = '1';
        document.getElementById('loot-manual-quality').value = '1';
        selectedItemId = null;

        renderLootManualItems();
    });

    const useBtn = document.getElementById('loot-manual-use-btn');
    if (useBtn) useBtn.addEventListener('click', () => {
        if (lootManualItems.length === 0) return;
        lootSelectedCapture = {
            items: lootManualItems.map(it => ({ ...it })),
            tabName: 'Manual Entry',
            capturedAt: new Date().toISOString(),
            isManual: true
        };
        selectLootCaptureUI(`Manual Entry`, lootSelectedCapture.items);
    });

    const clearBtn = document.getElementById('loot-manual-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', () => {
        lootManualItems = [];
        renderLootManualItems();
    });
}

function renderLootManualItems() {
    const container = document.getElementById('loot-manual-items');
    const actions = document.getElementById('loot-manual-actions');
    if (!container) return;

    if (lootManualItems.length === 0) {
        container.innerHTML = '';
        if (actions) actions.style.display = 'none';
        return;
    }

    if (actions) actions.style.display = 'flex';

    container.innerHTML = lootManualItems.map((item, i) => {
        const name = getFriendlyName(item.itemId);
        const qualLabel = item.quality > 1 ? ` q${item.quality}` : '';
        const iconUrl = `https://render.albiononline.com/v1/item/${item.itemId}.png?quality=${item.quality}`;
        return `<div class="loot-manual-item">
            <img src="${iconUrl}" class="sell-plan-icon" loading="lazy" onerror="this.style.display='none'">
            <span class="loot-manual-item-name">${esc(name)}${qualLabel}</span>
            <span class="loot-manual-item-qty">x${item.quantity}</span>
            <button class="loot-manual-remove" onclick="removeLootManualItem(${i})" title="Remove">&times;</button>
        </div>`;
    }).join('');
}

function removeLootManualItem(index) {
    lootManualItems.splice(index, 1);
    renderLootManualItems();
}

function renderLootCaptures() {
    const list = document.getElementById('loot-captures-list');
    const empty = document.getElementById('loot-no-captures');
    if (!list) return;

    if (lootBuyerCaptures.length === 0) {
        list.innerHTML = '';
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    // If captures have vaultTabs, split items into per-tab groups
    let cards = [];
    lootBuyerCaptures.forEach((cap, capIdx) => {
        const ago = timeAgo(new Date(cap.capturedAt).toISOString());
        const hasDirectTabName = cap.tabName && cap.tabName.length > 0;
        const hasTabs = !hasDirectTabName && cap.vaultTabs && cap.vaultTabs.length > 0;

        // Helper to build a compact card
        const calcTabWeight = (items) => items.reduce((sum, it) => sum + getItemWeight(it.itemId) * (it.quantity || 1), 0);
        const makeCard = (onclick, name, badge, itemCount, equipCount, stackCount, totalWeight, timeAgoStr) => {
            const weightStr = totalWeight > 0 ? `${totalWeight.toFixed(1)} kg` : '';
            return `<div class="loot-capture-card" onclick="${onclick}" style="cursor:pointer;">
                <div style="display:flex; align-items:center; gap:0.4rem;">
                    <span class="loot-card-title">${esc(name)}</span>
                    ${badge ? `<span style="font-size:0.6rem; padding:0.1rem 0.35rem; background:var(--bg-elevated); border-radius:8px; color:var(--text-muted);">${badge}</span>` : ''}
                </div>
                <div class="loot-card-meta">${itemCount} items &bull; ${equipCount}⚔ ${stackCount}📦${weightStr ? ` &bull; ${weightStr}` : ''} &bull; ${timeAgoStr}</div>
            </div>`;
        };

        if (hasDirectTabName) {
            const equipCount = cap.items.filter(it => it.isEquipment).length;
            const stackCount = cap.items.length - equipCount;
            const badge = cap.isGuild ? 'Guild' : 'Bank';
            cards.push(makeCard(`selectLootCapture(${capIdx})`, cap.tabName, badge, cap.items.length, equipCount, stackCount, calcTabWeight(cap.items), ago));
        } else if (hasTabs) {
            const tabIdx = typeof cap.tabIndex === 'number' ? cap.tabIndex : -1;
            const tabName = (tabIdx >= 0 && tabIdx < cap.vaultTabs.length && cap.vaultTabs[tabIdx].name)
                ? cap.vaultTabs[tabIdx].name
                : (tabIdx >= 0 ? `Tab ${tabIdx + 1}` : 'Chest Capture');
            const equipCount = cap.items.filter(it => it.isEquipment).length;
            const stackCount = cap.items.length - equipCount;
            const vaultType = cap.isGuild ? 'Guild' : 'Bank';
            const displayName = cap.customName || tabName;
            cards.push(makeCard(`selectLootCapture(${capIdx})`, displayName, vaultType, cap.items.length, equipCount, stackCount, calcTabWeight(cap.items), ago));
        } else {
            const equipCount = cap.items.filter(it => it.isEquipment).length;
            const stackCount = cap.items.length - equipCount;
            cards.push(makeCard(`selectLootCapture(${capIdx})`, `Chest Capture`, '', cap.items.length, equipCount, stackCount, calcTabWeight(cap.items), ago));
        }
    });
    list.innerHTML = cards.join('');
}

function renameLootCapture(index) {
    const cap = lootBuyerCaptures[index];
    if (!cap) return;
    const name = prompt('Name this capture:', cap.customName || '');
    if (name !== null) {
        cap.customName = name.trim() || null;
        renderLootCaptures();
    }
}

function selectLootCaptureTab(capIndex, tabIndex, slotsPerTab) {
    const cap = lootBuyerCaptures[capIndex];
    if (!cap) return;
    const tabMin = tabIndex * slotsPerTab;
    const tabMax = (tabIndex + 1) * slotsPerTab;
    const tabItems = cap.items.filter(it => it.slot >= tabMin && it.slot < tabMax);
    const tabName = cap.vaultTabs?.[tabIndex]?.name || `Tab ${tabIndex + 1}`;
    lootSelectedCapture = { ...cap, items: tabItems, itemCount: tabItems.length, tabName };
    selectLootCaptureUI(tabName, tabItems);
}

function selectLootCapture(index) {
    const cap = lootBuyerCaptures[index];
    if (!cap) return;
    lootSelectedCapture = cap;
    selectLootCaptureUI('All Items', cap.items);
}

function selectLootCaptureUI(titleText, items) {
    const section = document.getElementById('loot-selected-items');
    const titleEl = document.getElementById('loot-selected-title');
    const list = document.getElementById('loot-selected-list');
    if (!section || !list) return;

    section.style.display = 'block';
    if (titleEl) titleEl.textContent = `${titleText} (${items.length} items)`;

    const equipCount = items.filter(it => it.isEquipment).length;
    const stackCount = items.length - equipCount;

    // Store items for search filtering
    window._lootSelectedItems = items;
    window._lootSelectedTitle = titleText;

    // Build a single collapsible card with summary, search, and expandable item grid
    list.innerHTML = `
        <div class="loot-items-card expanded">
            <div class="loot-items-header" onclick="this.parentElement.classList.toggle('expanded')">
                <div class="loot-items-summary">
                    <span class="loot-items-title">${esc(titleText)}</span>
                    <span class="loot-items-stats">${items.length} items &bull; ${equipCount}⚔ ${stackCount}📦 ${(() => { const tw = items.reduce((s, it) => s + getItemWeight(it.itemId) * (it.quantity || 1), 0); return tw > 0 ? `&bull; ${tw.toFixed(1)} kg` : ''; })()}</span>
                </div>
                <span class="loot-items-chevron">▾</span>
            </div>
            <div class="loot-items-grid">
                <div class="loot-items-search-wrap">
                    <input type="text" id="loot-items-search" class="sale-form-input" placeholder="Search items in this tab..." style="font-size:0.8rem;">
                </div>
                <div id="loot-items-rows">
                    ${renderLootItemRows(items)}
                </div>
            </div>
        </div>`;

    // Wire search filter
    const searchInput = document.getElementById('loot-items-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.toLowerCase().trim();
            const filtered = q ? items.filter(item => {
                const name = (getFriendlyName(item.itemId) || item.itemId).toLowerCase();
                const id = item.itemId.toLowerCase();
                return name.includes(q) || id.includes(q);
            }) : items;
            document.getElementById('loot-items-rows').innerHTML = renderLootItemRows(filtered);
            // Update count in header
            const statsEl = list.querySelector('.loot-items-stats');
            if (statsEl) {
                const eq = filtered.filter(it => it.isEquipment).length;
                statsEl.textContent = `${filtered.length}/${items.length} items` + (q ? ' (filtered)' : ` \u2022 ${eq}\u2694 ${filtered.length - eq}\uD83D\uDCE6`);
            }
        });
    }
}

function renderLootItemRows(items) {
    return items.map((item, i) => {
        const qualName = item.quality > 1 ? ` q${item.quality}` : '';
        const iconUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(item.itemId)}.png?quality=${item.quality}`;
        const name = getFriendlyName(item.itemId) || item.itemId;
        const safeId = esc(item.itemId);
        const iw = getItemWeight(item.itemId);
        const totalW = iw * (item.quantity || 1);
        const weightStr = totalW > 0 ? `<span class="loot-item-weight">${totalW.toFixed(1)} kg</span>` : '';
        return `<div class="loot-item-row" onclick="toggleLootItemDetail(this, '${safeId}', ${item.quality || 1})" style="cursor:pointer;">
            <img src="${iconUrl}" class="loot-item-icon" loading="lazy" onerror="this.style.display='none'">
            <span class="loot-item-name">${esc(name)}${qualName}</span>
            ${weightStr}
            <span class="loot-item-qty">x${item.quantity}</span>
        </div>`;
    }).join('');
}

async function toggleLootItemDetail(rowEl, itemId, quality) {
    // If already expanded, collapse
    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains('loot-item-detail')) {
        existing.remove();
        return;
    }
    // Remove any other open detail
    rowEl.closest('.loot-items-grid')?.querySelectorAll('.loot-item-detail').forEach(d => d.remove());

    const detail = document.createElement('div');
    detail.className = 'loot-item-detail';
    detail.innerHTML = '<div style="padding:0.4rem 0.85rem; font-size:0.72rem; color:var(--text-muted);">Loading...</div>';
    rowEl.after(detail);

    try {
        const server = document.getElementById('server-select')?.value || 'europe';
        const apiBase = { west: 'https://west.albion-online-data.com/api/v2/stats/prices', east: 'https://east.albion-online-data.com/api/v2/stats/prices', europe: 'https://europe.albion-online-data.com/api/v2/stats/prices' }[server] || 'https://europe.albion-online-data.com/api/v2/stats/prices';
        const res = await fetch(`${apiBase}/${encodeURIComponent(itemId)}.json?qualities=${quality}`);
        const data = await res.json();

        if (!data || data.length === 0) {
            detail.innerHTML = `<div class="loot-item-detail-inner">
                <span style="color:var(--text-muted);">No market data available</span>
                <a class="loot-detail-link" onclick="event.stopPropagation(); switchToCompare('${esc(itemId)}')">View in Market Browser →</a>
            </div>`;
            return;
        }

        // Find best sell (lowest sell_price_min) and best buy (highest buy_price_max)
        let bestSell = null, bestBuy = null;
        for (const entry of data) {
            if (entry.sell_price_min > 0 && (!bestSell || entry.sell_price_min < bestSell.sell_price_min)) bestSell = entry;
            if (entry.buy_price_max > 0 && (!bestBuy || entry.buy_price_max > bestBuy.buy_price_max)) bestBuy = entry;
        }

        const sellStr = bestSell ? `${bestSell.sell_price_min.toLocaleString()}s <span style="color:var(--text-muted);">(${bestSell.city})</span>` : '<span style="color:var(--text-muted);">—</span>';
        const buyStr = bestBuy ? `${bestBuy.buy_price_max.toLocaleString()}s <span style="color:var(--text-muted);">(${bestBuy.city})</span>` : '<span style="color:var(--text-muted);">—</span>';

        // Freshness
        const freshDate = bestSell?.sell_price_min_date || bestBuy?.buy_price_max_date || '';
        const freshStr = freshDate ? timeAgo(freshDate) : 'unknown';

        detail.innerHTML = `<div class="loot-item-detail-inner">
            <div class="loot-detail-prices">
                <span>Sell: <strong style="color:var(--profit-green);">${sellStr}</strong></span>
                <span>Buy: <strong style="color:var(--accent);">${buyStr}</strong></span>
                <span style="color:var(--text-muted);">Fresh: ${freshStr}</span>
            </div>
            <a class="loot-detail-link" onclick="event.stopPropagation(); switchToCompare('${esc(itemId)}')">View in Market Browser →</a>
        </div>`;
    } catch (e) {
        detail.innerHTML = `<div class="loot-item-detail-inner">
            <span style="color:var(--loss-red);">Failed to load</span>
            <a class="loot-detail-link" onclick="event.stopPropagation(); switchToCompare('${esc(itemId)}')">View in Market Browser →</a>
        </div>`;
    }
}

async function analyzeLoot() {
    if (!lootSelectedCapture || !lootSelectedCapture.items.length) {
        showToast('Select a chest capture first.', 'warn');
        return;
    }
    if (!localStorage.getItem('albion_auth_token')) {
        const resultsDiv = document.getElementById('loot-results');
        if (resultsDiv) {
            resultsDiv.style.display = 'block';
            resultsDiv.innerHTML = `<div class="empty-state" style="padding:2rem;"><p>Login required to analyze items.</p><button class="btn-accent" onclick="document.getElementById('discord-login-btn')?.click()">Login with Discord</button></div>`;
        }
        return;
    }

    const mode = lootAnalysisMode;
    const resultsDiv = document.getElementById('loot-results');
    if (!resultsDiv) return;
    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = '<div class="spinner"></div>';

    const askingPrice = parseInt(document.getElementById('loot-asking-price')?.value) || 0;

    try {
        const res = await fetch(`${VPS_BASE}/api/loot-evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ items: lootSelectedCapture.items, askingPrice })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');

        lastLootEvalData = data;
        if (mode === 'worth') {
            renderWorthAnalysis(data, resultsDiv);
        } else {
            renderSellPlan(data, resultsDiv);
        }

        // "I Bought This" button — appears after any analysis
        const saveSection = document.createElement('div');
        saveSection.id = 'loot-save-section';
        saveSection.style.cssText = 'margin-top:1.25rem; padding-top:1rem; border-top:1px solid var(--border-color); display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap;';
        saveSection.innerHTML = `
            <input type="text" id="loot-save-city" placeholder="City (e.g. Bridgewatch)" style="flex:1; min-width:140px; max-width:200px; padding:0.4rem 0.6rem; border-radius:var(--radius); border:1px solid var(--border-color); background:var(--bg-elevated); color:var(--text-primary); font-size:0.82rem;">
            <button class="btn-accent" id="loot-save-btn" style="flex:1; min-width:160px;">I Bought This — Track Tab</button>
        `;
        resultsDiv.appendChild(saveSection);
        document.getElementById('loot-save-btn').addEventListener('click', buyThisTab);
    } catch (e) {
        resultsDiv.innerHTML = `<div class="empty-state"><p>Analysis failed: ${esc(e.message)}</p></div>`;
    }
}

async function buyThisTab() {
    if (!lastLootEvalData || !lootSelectedCapture) return;
    const btn = document.getElementById('loot-save-btn');
    const cityInput = document.getElementById('loot-save-city');
    const askingPrice = parseInt(document.getElementById('loot-asking-price')?.value) || 0;
    const tabName = lootSelectedCapture.tabName || lootSelectedCapture.customName || 'Unnamed Tab';
    const city = cityInput ? cityInput.value.trim() : '';

    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tab/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ tabName, city, purchasePrice: askingPrice, items: lootSelectedCapture.items })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Failed');
        if (btn) {
            btn.textContent = 'Saved! See My Tracked Tabs below';
            btn.style.background = 'var(--profit-green)';
            btn.style.color = '#000';
            btn.disabled = false;
        }
        loadTrackedTabs();
    } catch(e) {
        if (btn) { btn.disabled = false; btn.textContent = 'I Bought This — Track Tab'; }
        showToast('Failed to save: ' + e.message, 'error');
    }
}

function renderWorthAnalysis(data, container) {
    const askingPrice = parseInt(document.getElementById('loot-asking-price')?.value) || 0;
    const qs = data.totals.quickSellTotal;
    const ps = data.totals.patientSellTotal;

    let verdict = '', verdictClass = '';
    if (askingPrice > 0) {
        const margin = ((qs - askingPrice) / askingPrice * 100).toFixed(0);
        const pMargin = ((ps - askingPrice) / askingPrice * 100).toFixed(0);
        if (askingPrice <= qs) { verdict = `BUY — ${margin}% instant margin (${qs.toLocaleString()} quick-sell)`; verdictClass = 'good'; }
        else if (askingPrice <= ps) { verdict = `MAYBE — ${pMargin}% if listed on market, not instant`; verdictClass = 'caution'; }
        else { verdict = `SKIP — asking ${askingPrice.toLocaleString()} exceeds market value ${ps.toLocaleString()}`; verdictClass = 'bad'; }
    }

    const riskCount = data.totals.riskItemCount;
    const riskNote = riskCount > 0 ? ` · <span style="color:var(--loss-red);">${riskCount} risky item${riskCount > 1 ? 's' : ''}</span>` : '';

    container.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:0.75rem; margin-bottom:1rem;">
            <div class="profile-stat-item">
                <span class="profile-stat-value" style="color:var(--profit-green);">${qs.toLocaleString()}</span>
                <span class="profile-stat-label">Quick-Sell Value</span>
            </div>
            <div class="profile-stat-item">
                <span class="profile-stat-value" style="color:var(--blue);">${ps.toLocaleString()}</span>
                <span class="profile-stat-label">Patient-Sell Value</span>
            </div>
            ${askingPrice > 0 ? `<div class="profile-stat-item">
                <span class="profile-stat-value">${askingPrice.toLocaleString()}</span>
                <span class="profile-stat-label">Asking Price</span>
            </div>` : ''}
            <div class="profile-stat-item">
                <span class="profile-stat-value">${data.totals.itemCount}${riskNote}</span>
                <span class="profile-stat-label">Items Analyzed</span>
            </div>
        </div>
        ${verdict ? `<div class="loot-verdict ${verdictClass}">${verdict}</div>` : '<div style="color:var(--text-muted); font-size:0.85rem; margin-bottom:1rem;">Enter an asking price above to get a buy/skip verdict.</div>'}
        <div style="margin-top:1rem;">
            <h3 style="color:var(--text-primary); font-size:0.95rem; margin:0 0 0.5rem 0;">Per-Item Breakdown</h3>
            <div class="flips-feed-container">
                ${data.items.map(item => {
                    const iconUrl = `https://render.albiononline.com/v1/item/${item.itemId}.png?quality=${item.quality}`;
                    const instant = item.bestInstantSell
                        ? `${item.bestInstantSell.city}: ${item.bestInstantSell.netPerUnit.toLocaleString()}/ea`
                        : 'No buyers';
                    const market = item.bestMarketSell
                        ? `${item.bestMarketSell.city}: ${item.bestMarketSell.netPerUnit.toLocaleString()}/ea`
                        : 'No data';
                    const risk = item.riskFlags.length > 0
                        ? item.riskFlags.map(f => `<span class="risk-badge ${f === 'no_data' || f === 'no_buy_orders' ? 'danger' : 'warning'}">${f.replace(/_/g,' ')}</span>`).join(' ')
                        : '<span class="risk-badge ok">OK</span>';
                    const totalInstant = item.bestInstantSell
                        ? (item.bestInstantSell.netPerUnit * item.quantity).toLocaleString()
                        : '—';
                    const qualLabel = item.quality > 1 ? ` q${item.quality}` : '';
                    return `<div class="flip-card" style="animation:none;">
                        <img class="flip-icon" src="${iconUrl}" alt="" loading="lazy" onerror="this.style.display='none'">
                        <div style="min-width:0;">
                            <div style="font-weight:600; font-size:0.82rem; color:var(--text-primary);">${esc(item.name)}${qualLabel} ×${item.quantity}</div>
                            <div style="font-size:0.7rem; color:var(--text-muted);">Instant: ${instant} · Market: ${market}</div>
                        </div>
                        <div style="text-align:right; flex-shrink:0;">
                            <div style="font-size:0.85rem; font-weight:600; color:var(--profit-green);">${totalInstant}</div>
                            <div style="margin-top:2px;">${risk}</div>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>
    `;
}

// Build the sell plan data structure from loot-evaluate items.
// Per item: decides between instant sell and market listing using an 85% threshold
// (if instant is within 15% of market price, prefer instant — not worth waiting).
// Returns { trips: [[city, tripObj], ...sorted by value desc], noData: [...items] }
function buildSellPlan(items) {
    const trips = {};
    const noData = [];

    for (const item of items) {
        const hasInstant = item.bestInstantSell && item.bestInstantSell.netPerUnit > 0;
        const hasMarket  = item.bestMarketSell  && item.bestMarketSell.netPerUnit  > 0;

        if (!hasInstant && !hasMarket) {
            noData.push(item);
            continue;
        }

        let sellMethod, city, netPerUnit, price;
        if (hasInstant && hasMarket) {
            const ratio = item.bestInstantSell.netPerUnit / item.bestMarketSell.netPerUnit;
            if (ratio >= 0.85) {
                // Instant is within 15% of best market — take the certainty
                sellMethod = 'instant'; city = item.bestInstantSell.city;
                netPerUnit = item.bestInstantSell.netPerUnit; price = item.bestInstantSell.price;
            } else {
                // Significantly better on market — worth listing
                sellMethod = 'market'; city = item.bestMarketSell.city;
                netPerUnit = item.bestMarketSell.netPerUnit; price = item.bestMarketSell.price;
            }
        } else if (hasInstant) {
            sellMethod = 'instant'; city = item.bestInstantSell.city;
            netPerUnit = item.bestInstantSell.netPerUnit; price = item.bestInstantSell.price;
        } else {
            sellMethod = 'market'; city = item.bestMarketSell.city;
            netPerUnit = item.bestMarketSell.netPerUnit; price = item.bestMarketSell.price;
        }

        const totalValue = netPerUnit * item.quantity;
        if (!trips[city]) trips[city] = { items: [], total: 0, instantTotal: 0, marketTotal: 0 };
        trips[city].items.push({ ...item, sellMethod, city, netPerUnit, price, totalValue });
        trips[city].total += totalValue;
        if (sellMethod === 'instant') trips[city].instantTotal += totalValue;
        else trips[city].marketTotal += totalValue;
    }

    // Sort each city's items by value desc so most valuable go first
    for (const t of Object.values(trips)) {
        t.items.sort((a, b) => b.totalValue - a.totalValue);
    }

    const sortedTrips = Object.entries(trips).sort((a, b) => b[1].total - a[1].total);

    // Suggest a travel route based on Royal Continent geography
    const routeOrder = ['Caerleon', 'Martlock', 'Fort Sterling', 'Thetford', 'Lymhurst', 'Bridgewatch', 'Brecilien', 'Black Market'];
    const tripCities = sortedTrips.map(([city]) => city);
    const orderedRoute = routeOrder.filter(c => tripCities.includes(c));
    // Add any cities not in the predefined route (custom/unknown)
    tripCities.forEach(c => { if (!orderedRoute.includes(c)) orderedRoute.push(c); });

    return { trips: sortedTrips, noData, suggestedRoute: orderedRoute.length > 1 ? orderedRoute : null };
}

// Copy text for a single trip (called from inline button via dataset id)
function copySellTrip(tripId) {
    const el = document.getElementById(tripId);
    if (!el) return;
    navigator.clipboard.writeText(el.dataset.copytext || '').then(() => {
        const btn = el.querySelector('.loot-copy-btn');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy List'; }, 2000); }
    });
}

function renderSellPlan(data, container) {
    const { trips, noData, suggestedRoute } = buildSellPlan(data.items);

    if (trips.length === 0 && noData.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No items to plan.</p></div>';
        return;
    }

    const grandTotal   = trips.reduce((s, [, t]) => s + t.total, 0);
    const instantTotal = trips.reduce((s, [, t]) => s + t.instantTotal, 0);
    const marketTotal  = trips.reduce((s, [, t]) => s + t.marketTotal, 0);

    // Build full plain-text summary for "Copy All" button
    const allCopyLines = ['=== SELL PLAN ==='];
    if (suggestedRoute) allCopyLines.push('Route: ' + suggestedRoute.join(' → '));
    allCopyLines.push('');
    trips.forEach(([city, trip], i) => {
        allCopyLines.push(`Trip ${i + 1}: ${city}  (${trip.items.length} items · ${trip.total.toLocaleString()}s)`);
        trip.items.forEach(it => {
            const method = it.sellMethod === 'instant' ? 'Instant sell' : 'Market list';
            allCopyLines.push(`  ${method}: ${it.name}${it.quality > 1 ? ' q' + it.quality : ''} ×${it.quantity}  →  ${it.netPerUnit.toLocaleString()}/ea  =  ${it.totalValue.toLocaleString()}s`);
        });
        allCopyLines.push('');
    });
    if (noData.length > 0) {
        allCopyLines.push('No market data (skip or check manually):');
        noData.forEach(it => allCopyLines.push(`  ${it.name} ×${it.quantity}`));
    }
    const allCopyText = allCopyLines.join('\n');

    const tripsHtml = trips.map(([city, trip], i) => {
        const tripId = `sell-trip-${i}`;

        // Per-trip clipboard text
        const tripLines = [`${city}  (${trip.items.length} items · ${trip.total.toLocaleString()}s)`];
        trip.items.forEach(it => {
            const method = it.sellMethod === 'instant' ? 'Sell' : 'List';
            tripLines.push(`  ${method}: ${it.name}${it.quality > 1 ? ' q' + it.quality : ''} ×${it.quantity}  →  ${it.price.toLocaleString()}/ea`);
        });
        const tripCopyText = tripLines.join('\n').replace(/"/g, '&quot;');

        const itemsHtml = trip.items.map(item => {
            const iconUrl  = `https://render.albiononline.com/v1/item/${item.itemId}.png?quality=${item.quality}`;
            const qualLabel = item.quality > 1 ? ` <span style="color:var(--text-muted); font-size:0.7rem;">q${item.quality}</span>` : '';
            const methodBadge = item.sellMethod === 'instant'
                ? `<span class="sell-method-badge instant">Instant</span>`
                : `<span class="sell-method-badge market">Market</span>`;
            const priceStr   = item.price.toLocaleString();
            const totalStr   = item.totalValue.toLocaleString();
            return `<div class="sell-plan-item">
                <img src="${iconUrl}" class="sell-plan-icon" loading="lazy" onerror="this.style.display='none'">
                <div class="sell-plan-name">${esc(item.name)}${qualLabel}</div>
                <div class="sell-plan-qty">×${item.quantity}</div>
                ${methodBadge}
                <div class="sell-plan-price">${priceStr}<span style="color:var(--text-muted); font-size:0.65rem;">/ea</span></div>
                <div class="sell-plan-total">${totalStr}<span style="color:var(--text-muted); font-size:0.65rem;">s</span></div>
            </div>`;
        }).join('');

        const instantNote = trip.instantTotal > 0 ? `<span style="color:var(--profit-green); font-size:0.72rem;">⚡ ${trip.instantTotal.toLocaleString()}s instant</span>` : '';
        const marketNote  = trip.marketTotal > 0  ? `<span style="color:var(--blue); font-size:0.72rem;">📋 ${trip.marketTotal.toLocaleString()}s listed</span>` : '';

        const tripWeight = trip.items.reduce((s, it) => s + getItemWeight(it.itemId) * (it.quantity || 1), 0);
        const tripWeightStr = tripWeight > 0 ? ` &bull; ${tripWeight.toFixed(1)} kg` : '';
        return `<div class="loot-city-group" id="${tripId}" data-copytext="${tripCopyText}">
            <div class="sell-trip-header">
                <div>
                    <span class="sell-trip-title">Trip ${i + 1} — ${esc(city)}</span>
                    <span class="sell-trip-count">${trip.items.length} item${trip.items.length > 1 ? 's' : ''}${tripWeightStr}</span>
                </div>
                <div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">
                    ${instantNote} ${marketNote}
                    <span class="sell-trip-total">${trip.total.toLocaleString()}s</span>
                    <button class="btn-small-accent loot-copy-btn" onclick="copySellTrip('${tripId}')">Copy List</button>
                </div>
            </div>
            <div class="sell-plan-items">${itemsHtml}</div>
        </div>`;
    }).join('');

    const noDataHtml = noData.length > 0 ? `
        <div class="loot-city-group" style="opacity:0.7;">
            <div class="sell-trip-header">
                <span class="sell-trip-title" style="color:var(--text-muted);">No Market Data</span>
                <span class="sell-trip-count" style="color:var(--loss-red);">${noData.length} item${noData.length > 1 ? 's' : ''} — check manually</span>
            </div>
            <div class="sell-plan-items">
                ${noData.map(item => {
                    const iconUrl = `https://render.albiononline.com/v1/item/${item.itemId}.png?quality=${item.quality}`;
                    return `<div class="sell-plan-item">
                        <img src="${iconUrl}" class="sell-plan-icon" loading="lazy" onerror="this.style.display='none'">
                        <div class="sell-plan-name" style="color:var(--text-muted);">${esc(item.name)}</div>
                        <div class="sell-plan-qty">×${item.quantity}</div>
                        <span class="risk-badge danger">no data</span>
                        <div class="sell-plan-price" style="color:var(--text-muted);">—</div>
                        <div class="sell-plan-total" style="color:var(--text-muted);">—</div>
                    </div>`;
                }).join('')}
            </div>
        </div>` : '';

    container.innerHTML = `
        <div class="sell-plan-summary">
            <div class="sell-plan-summary-row">
                <span>${trips.length} trip${trips.length !== 1 ? 's' : ''} · ${data.items.length - noData.length} items</span>
                <span style="font-weight:700; color:var(--profit-green);">${grandTotal.toLocaleString()} silver</span>
            </div>
            <div style="display:flex; gap:1rem; font-size:0.78rem; margin-top:0.25rem; flex-wrap:wrap;">
                ${instantTotal > 0 ? `<span style="color:var(--profit-green);">⚡ ${instantTotal.toLocaleString()}s instant</span>` : ''}
                ${marketTotal  > 0 ? `<span style="color:var(--blue);">📋 ${marketTotal.toLocaleString()}s listed</span>` : ''}
                ${noData.length > 0 ? `<span style="color:var(--loss-red);">⚠ ${noData.length} item${noData.length > 1 ? 's' : ''} with no data</span>` : ''}
            </div>
            <button class="btn-small-accent loot-copy-all-btn" id="sell-copy-all-btn" style="margin-top:0.5rem;">Copy All Trips</button>
            ${suggestedRoute ? `<div class="sell-route-hint">Route: ${suggestedRoute.map(c => esc(c)).join(' → ')}</div>` : ''}
        </div>
        ${tripsHtml}
        ${noDataHtml}
    `;

    // Wire up Copy All button using safe JS (no inline string interpolation)
    const copyAllBtn = document.getElementById('sell-copy-all-btn');
    if (copyAllBtn) {
        copyAllBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(allCopyText).then(() => {
                copyAllBtn.textContent = 'Copied!';
                setTimeout(() => { copyAllBtn.textContent = 'Copy All Trips'; }, 2000);
            });
        });
    }
}

// ====== LOOT TAB LIFECYCLE TRACKER ======

async function loadTrackedTabs() {
    if (!localStorage.getItem('albion_auth_token')) return;
    const list = document.getElementById('loot-tracked-list');
    const empty = document.getElementById('loot-tracked-empty');
    if (!list) return;

    list.innerHTML = '<div class="spinner" style="margin:1.5rem auto;"></div>';
    if (empty) empty.style.display = 'none';

    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tabs`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');

        if (!data.tabs || data.tabs.length === 0) {
            list.innerHTML = '';
            if (empty) empty.style.display = '';
            return;
        }
        list.innerHTML = data.tabs.map(tab => renderTrackedTabCard(tab)).join('');
    } catch(e) {
        list.innerHTML = `<div class="empty-state"><p>Failed to load tracked tabs: ${esc(e.message)}</p></div>`;
    }
}

async function loadRecentSales() {
    if (!localStorage.getItem('albion_auth_token')) return;
    try {
        const res = await fetch(`${VPS_BASE}/api/sale-notifications`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        window._recentSales = data.map(s => ({
            itemId: s.item_id, amount: s.quantity, price: s.unit_price,
            total: s.total, location: s.location, orderType: s.order_type,
            mailId: s.mail_id, matchedTabId: s.matched_tab_id,
            receivedAt: s.sold_at
        }));
        renderRecentSales();
    } catch(e) { /* silent */ }
}

function renderRecentSales() {
    let container = document.getElementById('loot-recent-sales');
    if (!container) return;
    const sales = window._recentSales || [];
    if (sales.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; padding:0.5rem;">No sales detected yet. Open your in-game mailbox while the client is running.</div>';
        return;
    }
    container.innerHTML = sales.slice(0, 10).map(s => {
        const name = s.itemId || 'Unknown';
        const icon = getItemIcon ? getItemIcon(name) : '';
        const qty = s.amount || 1;
        const price = (s.price || 0).toLocaleString();
        const total = (s.total || 0).toLocaleString();
        const ago = timeAgo ? timeAgo(s.receivedAt) : '';
        const matched = s.matchedTabId ? `<span style="color:var(--profit-green); font-size:0.68rem;"> (auto-matched)</span>` : '';
        const typeLabel = s.orderType === 'EXPIRED' ? '<span style="color:var(--loss-red); font-size:0.68rem;">EXPIRED</span>' : '';
        return `<div class="sale-notif-card">
            ${icon ? `<img src="${icon}" class="sale-notif-icon" onerror="this.style.display='none'" />` : ''}
            <div class="sale-notif-info">
                <span class="sale-notif-item">${esc(name)} x${qty}</span>
                <span class="sale-notif-price">${price}s/ea = ${total}s total${matched}</span>
            </div>
            <div class="sale-notif-meta">${typeLabel} ${ago}</div>
        </div>`;
    }).join('');
}

function renderTrackedTabCard(tab) {
    const net = tab.revenueSoFar - tab.purchasePrice;
    const netColor = net >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';
    const netSign = net >= 0 ? '+' : '';
    const progressPct = tab.purchasePrice > 0 ? Math.min(100, Math.round(tab.revenueSoFar / tab.purchasePrice * 100)) : 0;
    const progressColor = progressPct >= 100 ? 'var(--profit-green)' : progressPct >= 50 ? '#fbbf24' : 'var(--accent)';
    const statusClass = tab.status === 'sold' ? 'status-sold' : tab.status === 'partial' ? 'status-partial' : 'status-open';
    const date = new Date(tab.purchasedAt).toLocaleDateString();

    return `<div class="loot-tracked-card" onclick="toggleTrackedTabDetail(${tab.id}, this)">
        <div class="loot-tracked-header">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
                <span class="loot-card-title">${esc(tab.tabName)}</span>
                ${tab.city ? `<span class="loot-tab-badge">${esc(tab.city)}</span>` : ''}
                <span class="loot-tab-status ${statusClass}">${tab.status}</span>
            </div>
            <span style="font-size:0.72rem; color:var(--text-muted); flex-shrink:0;">${date}</span>
        </div>
        <div class="loot-tracked-stats">
            <div class="loot-tracked-stat">
                <span class="loot-tracked-stat-label">Paid</span>
                <span class="loot-tracked-stat-value">${tab.purchasePrice.toLocaleString()}s</span>
            </div>
            <div class="loot-tracked-stat">
                <span class="loot-tracked-stat-label">Revenue</span>
                <span class="loot-tracked-stat-value" style="color:var(--profit-green);">${tab.revenueSoFar.toLocaleString()}s</span>
            </div>
            <div class="loot-tracked-stat">
                <span class="loot-tracked-stat-label">Net Profit</span>
                <span class="loot-tracked-stat-value" style="color:${netColor};">${netSign}${net.toLocaleString()}s</span>
            </div>
            <div class="loot-tracked-stat">
                <span class="loot-tracked-stat-label">Progress</span>
                <span class="loot-tracked-stat-value">${progressPct}%</span>
            </div>
        </div>
        <div class="loot-tracked-progress-bar">
            <div class="loot-tracked-progress-fill" style="width:${progressPct}%; background:${progressColor};"></div>
        </div>
        <div class="loot-tracked-detail" id="loot-tracked-detail-${tab.id}" style="display:none;"></div>
    </div>`;
}

async function toggleTrackedTabDetail(tabId, cardEl) {
    const detail = document.getElementById(`loot-tracked-detail-${tabId}`);
    if (!detail) return;

    if (detail.style.display !== 'none') {
        detail.style.display = 'none';
        return;
    }

    detail.style.display = 'block';
    detail.innerHTML = '<div class="spinner" style="margin:0.75rem auto; width:20px; height:20px;"></div>';

    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tab/${tabId}`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        detail.innerHTML = renderTrackedTabDetail(data);
    } catch(e) {
        detail.innerHTML = `<p style="color:var(--loss-red); font-size:0.8rem; margin:0.5rem 0;">${esc(e.message)}</p>`;
    }
}

function renderTrackedTabDetail(tab) {
    const salesHtml = tab.sales.length === 0
        ? '<p style="color:var(--text-muted); font-size:0.8rem; margin:0.5rem 0;">No sales recorded yet.</p>'
        : tab.sales.map(s => {
            const name = (typeof ITEM_NAMES !== 'undefined' && ITEM_NAMES[s.item_id]) || s.item_id;
            const qualLabel = s.quality > 1 ? ` q${s.quality}` : '';
            const total = (s.sale_price * s.quantity).toLocaleString();
            const date = new Date(s.sold_at).toLocaleDateString();
            return `<div style="display:grid; grid-template-columns:1fr auto auto; align-items:center; gap:0.5rem; font-size:0.78rem; padding:0.3rem 0; border-bottom:1px solid var(--border-color);">
                <span style="color:var(--text-primary);">${esc(name)}${qualLabel} ×${s.quantity}</span>
                <span style="color:var(--profit-green); font-weight:600;">${total}s</span>
                <span style="color:var(--text-muted);">${date}</span>
            </div>`;
        }).join('');

    const totalRevLabel = tab.revenueSoFar.toLocaleString();
    const netLabel = (tab.netProfit >= 0 ? '+' : '') + tab.netProfit.toLocaleString();
    const netColor = tab.netProfit >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';

    return `<div style="margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid var(--border-color);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap; gap:0.4rem;">
            <div style="display:flex; gap:1rem; font-size:0.78rem;">
                <span>Revenue: <strong style="color:var(--profit-green);">${totalRevLabel}s</strong></span>
                <span>Net: <strong style="color:${netColor};">${netLabel}s</strong></span>
            </div>
            <div style="display:flex; gap:0.5rem; align-items:center;" onclick="event.stopPropagation()">
                <button class="btn-small-accent" onclick="showSaleForm(${tab.id})">+ Record Sale</button>
                <select class="loot-status-select" onchange="updateTabStatus(${tab.id}, this.value)">
                    <option value="open" ${tab.status === 'open' ? 'selected' : ''}>Open</option>
                    <option value="partial" ${tab.status === 'partial' ? 'selected' : ''}>Partial</option>
                    <option value="sold" ${tab.status === 'sold' ? 'selected' : ''}>Sold</option>
                </select>
                <button class="btn-small-danger" onclick="deleteTrackedTab(${tab.id}, this)" title="Delete this tab">Delete</button>
            </div>
        </div>
        <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.35rem;">${tab.sales.length} sale record${tab.sales.length !== 1 ? 's' : ''}</div>
        ${salesHtml}
    </div>`;
}

function showSaleForm(tabId) {
    const existing = document.getElementById(`sale-form-${tabId}`);
    if (existing) { existing.remove(); return; } // toggle off

    const detail = document.getElementById(`loot-tracked-detail-${tabId}`);
    if (!detail || detail.style.display === 'none') return;

    // Find tab data from the detail endpoint cache — re-fetch items
    fetch(`${VPS_BASE}/api/loot-tab/${tabId}`, { headers: authHeaders() })
        .then(r => r.json())
        .then(tab => {
            if (!tab.items || !tab.items.length) return;

            // Build item options grouped — deduplicate by itemId+quality, sum quantities
            const grouped = {};
            for (const it of tab.items) {
                const key = it.itemId + '_' + (it.quality || 1);
                if (!grouped[key]) grouped[key] = { ...it, quantity: 0 };
                grouped[key].quantity += (it.quantity || 1);
            }
            const opts = Object.values(grouped);

            const form = document.createElement('div');
            form.id = `sale-form-${tabId}`;
            form.className = 'sale-inline-form';
            form.onclick = e => e.stopPropagation();
            form.innerHTML = `
                <div class="sale-form-row">
                    <label class="sale-form-label">Item</label>
                    <select id="sale-item-${tabId}" class="sale-form-select">
                        ${opts.map(o => {
                            const name = (typeof ITEM_NAMES !== 'undefined' && ITEM_NAMES[o.itemId]) || o.itemId;
                            const qLbl = (o.quality || 1) > 1 ? ` q${o.quality}` : '';
                            return `<option value="${esc(o.itemId)}" data-quality="${o.quality || 1}" data-qty="${o.quantity}">${esc(name)}${qLbl} (×${o.quantity})</option>`;
                        }).join('')}
                        <option value="__custom__">— Custom item ID —</option>
                    </select>
                </div>
                <div id="sale-custom-row-${tabId}" class="sale-form-row" style="display:none;">
                    <label class="sale-form-label">Item ID</label>
                    <input type="text" id="sale-custom-id-${tabId}" class="sale-form-input" placeholder="e.g. T5_BAG">
                </div>
                <div class="sale-form-row">
                    <label class="sale-form-label">Qty</label>
                    <input type="number" id="sale-qty-${tabId}" class="sale-form-input sale-form-qty" value="${opts[0]?.quantity || 1}" min="1">
                </div>
                <div class="sale-form-row">
                    <label class="sale-form-label">Price/ea</label>
                    <input type="number" id="sale-price-${tabId}" class="sale-form-input" placeholder="Silver per unit" min="1">
                </div>
                <div class="sale-form-actions">
                    <button class="btn-small-accent" id="sale-submit-${tabId}">Save Sale</button>
                    <button class="btn-small-danger" onclick="document.getElementById('sale-form-${tabId}').remove()">Cancel</button>
                </div>
            `;

            // Insert form before sales list
            detail.querySelector('.sale-inline-form')?.remove();
            detail.insertBefore(form, detail.firstChild);

            // Wire up item dropdown → auto-fill qty
            const sel = document.getElementById(`sale-item-${tabId}`);
            const customRow = document.getElementById(`sale-custom-row-${tabId}`);
            sel.addEventListener('change', () => {
                if (sel.value === '__custom__') {
                    customRow.style.display = '';
                    document.getElementById(`sale-qty-${tabId}`).value = 1;
                } else {
                    customRow.style.display = 'none';
                    const opt = sel.selectedOptions[0];
                    document.getElementById(`sale-qty-${tabId}`).value = opt.dataset.qty || 1;
                }
            });

            // Submit
            document.getElementById(`sale-submit-${tabId}`).addEventListener('click', () => submitSaleForm(tabId));
        })
        .catch(() => {});
}

async function submitSaleForm(tabId) {
    const sel = document.getElementById(`sale-item-${tabId}`);
    let itemId = sel.value;
    let quality = parseInt(sel.selectedOptions[0]?.dataset?.quality) || 1;

    if (itemId === '__custom__') {
        itemId = document.getElementById(`sale-custom-id-${tabId}`)?.value?.trim();
        quality = 1;
        if (!itemId) return;
    }

    const qty = Math.max(1, parseInt(document.getElementById(`sale-qty-${tabId}`).value) || 1);
    const price = parseInt(document.getElementById(`sale-price-${tabId}`).value);
    if (!price || price <= 0) return;

    const btn = document.getElementById(`sale-submit-${tabId}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tab/${tabId}/sale`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ itemId, quality, quantity: qty, salePrice: price })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Failed');
        // Remove form and reload
        document.getElementById(`sale-form-${tabId}`)?.remove();
        const detail = document.getElementById(`loot-tracked-detail-${tabId}`);
        if (detail) detail.style.display = 'none'; // collapse so re-click reloads fresh
        loadTrackedTabs();
    } catch(e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Sale'; }
        showToast('Failed to record sale: ' + e.message, 'error');
    }
}

async function updateTabStatus(tabId, status) {
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tab/${tabId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ status })
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
        loadTrackedTabs();
    } catch(e) {
        showToast('Failed to update status: ' + e.message, 'error');
    }
}

async function deleteTrackedTab(tabId, btnEl) {
    // Inline confirmation — replace button with confirm/cancel
    const parent = btnEl.parentElement;
    const origHtml = btnEl.outerHTML;
    btnEl.outerHTML = `<span id="del-confirm-${tabId}" style="display:flex; gap:0.3rem; align-items:center;">
        <span style="font-size:0.7rem; color:var(--text-muted);">Delete?</span>
        <button class="btn-small-danger" onclick="confirmDeleteTab(${tabId})">Yes</button>
        <button class="btn-small" onclick="cancelDeleteTab(${tabId})">No</button>
    </span>`;
    window._deleteOrigHtml = window._deleteOrigHtml || {};
    window._deleteOrigHtml[tabId] = origHtml;
}

function cancelDeleteTab(tabId) {
    const span = document.getElementById(`del-confirm-${tabId}`);
    if (span && window._deleteOrigHtml && window._deleteOrigHtml[tabId]) {
        span.outerHTML = window._deleteOrigHtml[tabId];
        delete window._deleteOrigHtml[tabId];
    }
}

async function confirmDeleteTab(tabId) {
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tab/${tabId}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
        // Remove the card from DOM
        const card = document.getElementById(`del-confirm-${tabId}`)?.closest('.loot-tracked-card');
        if (card) card.remove();
        else loadTrackedTabs(); // fallback: reload all
    } catch(e) {
        const span = document.getElementById(`del-confirm-${tabId}`);
        if (span) span.innerHTML = `<span style="color:var(--profit-red); font-size:0.7rem;">${esc(e.message)}</span>`;
    }
}

// ====== LOOT LOGGER TAB ======

let lootLoggerMode = 'live';
let lootSessions = [];
let liveLootEvents = []; // real-time events from current WS session
let liveSessionActive = false; // whether we are actively recording live events
let chestCaptureActive = false; // whether chest capture mode is on
window._chestCaptures = window._chestCaptures || [];
// Loot Logger filter/sort state (persisted across re-renders)
let _llCurrentEvents = [];
let _llCurrentByPlayer = {};
let _llPriceMap = {};
let _llDepositedMap = null;
let _llTargetEl = null;
let _llIsDetail = false;

// --- Silver formatting ---
function formatSilver(n) {
    if (!n || n <= 0) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return Math.round(n).toLocaleString();
}

// --- Price map for loot values (VPS scan data, fallback to IndexedDB) ---
async function getLootPriceMap(itemIds) {
    const ids = [...itemIds].filter(Boolean);
    if (ids.length === 0) return {};

    // Try VPS batch lookup first (fresh scan data, no outliers)
    try {
        const res = await fetch(`${VPS_BASE}/api/batch-prices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemIds: ids }),
            signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
            const data = await res.json();
            if (Object.keys(data).length > 0) return data;
        }
    } catch { /* timeout or network error — fall through to IndexedDB */ }

    // Fallback: IndexedDB cache (may have stale/outlier NATS data)
    try {
        const allPrices = await getCachedPrices();
        const map = {};
        for (const p of allPrices) {
            if (!p.item_id || !itemIds.has(p.item_id) || p.sell_price_min <= 0) continue;
            const existing = map[p.item_id];
            if (!existing) {
                map[p.item_id] = { price: p.sell_price_min, city: p.city || '' };
            } else if (p.sell_price_min < existing.price) {
                map[p.item_id] = { price: p.sell_price_min, city: p.city || '' };
            }
        }
        return map;
    } catch { return {}; }
}

// --- Live session controls ---
function toggleLiveSession() {
    liveSessionActive = !liveSessionActive;
    const btn = document.getElementById('ll-live-toggle-btn');
    if (liveSessionActive) {
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg> Stop Live Session`;
        btn.classList.add('active');
        document.getElementById('ll-live-indicator')?.classList.remove('hidden');
    } else {
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg> Start Live Session`;
        btn.classList.remove('active');
    }
    updateLiveLootIndicator();
}

function updateLiveLootIndicator() {
    const indicator = document.getElementById('ll-live-indicator');
    if (!indicator) return;
    if (!liveSessionActive) { indicator.classList.add('hidden'); }
    else { indicator.classList.remove('hidden'); }
    const players = new Set(liveLootEvents.map(e => e.looted_by_name || e.lootedBy?.name || '')).size;
    const evEl = document.getElementById('ll-event-count');
    const plEl = document.getElementById('ll-player-count');
    if (evEl) evEl.textContent = liveLootEvents.length;
    if (plEl) plEl.textContent = players;
    const saveBtn = document.getElementById('ll-save-btn');
    const resetBtn = document.getElementById('ll-reset-btn');
    if (saveBtn) saveBtn.disabled = liveLootEvents.length === 0;
    if (resetBtn) resetBtn.disabled = liveLootEvents.length === 0;
}

function resetLiveSession() {
    liveLootEvents = [];
    liveSessionActive = false;
    const btn = document.getElementById('ll-live-toggle-btn');
    if (btn) {
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg> Start Live Session`;
        btn.classList.remove('active');
    }
    document.getElementById('ll-live-indicator')?.classList.add('hidden');
    document.getElementById('ll-save-btn').disabled = true;
    document.getElementById('ll-reset-btn').disabled = true;
    const detail = document.getElementById('loot-session-detail');
    if (detail) { detail.style.display = 'none'; detail.innerHTML = ''; }
    if (lootLoggerMode === 'live') loadLootSessions();
    showToast('Live session cleared', 'info');
}

async function saveLiveSession() {
    if (liveLootEvents.length === 0) { showToast('No events to save', 'warning'); return; }
    const btn = document.getElementById('ll-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const lines = liveLootEvents.map(e => {
            const ts = new Date(e.timestamp || Date.now()).toISOString();
            const byAlliance = e.looted_by_alliance || e.lootedBy?.alliance || '';
            const byGuild = e.looted_by_guild || e.lootedBy?.guild || '';
            const byName = e.looted_by_name || e.lootedBy?.name || '';
            const itemId = e.item_id || e.itemId || '';
            const itemName = getFriendlyName(itemId) || itemId;
            const qty = e.quantity || 1;
            const fromAlliance = e.looted_from_alliance || e.lootedFrom?.alliance || '';
            const fromGuild = e.looted_from_guild || e.lootedFrom?.guild || '';
            const fromName = e.looted_from_name || e.lootedFrom?.name || '';
            return [ts, byAlliance, byGuild, byName, itemId, itemName, qty, fromAlliance, fromGuild, fromName].join(';');
        });
        const res = await fetch(`${VPS_BASE}/api/loot-upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ lines })
        });
        if (res.ok) {
            const data = await res.json();
            showToast(`Session saved (${data.eventsImported} events)`, 'success');
            if (lootLoggerMode === 'live') loadLootSessions();
        } else {
            showToast('Save failed — login required', 'error');
        }
    } catch(e) {
        showToast('Save failed: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = liveLootEvents.length === 0; btn.textContent = 'Save Session'; }
    }
}

// --- Chest capture controls ---
function toggleChestCapture() {
    chestCaptureActive = !chestCaptureActive;
    const btn = document.getElementById('ll-capture-toggle-btn');
    const bar = document.getElementById('ll-capture-status-bar');
    if (chestCaptureActive) {
        if (btn) { btn.textContent = 'Stop Capturing'; btn.classList.add('active'); }
        if (bar) bar.classList.remove('hidden');
    } else {
        if (btn) { btn.textContent = 'Start Capturing'; btn.classList.remove('active'); }
        if (bar) bar.classList.add('hidden');
    }
}

function resetChestCaptures() {
    window._chestCaptures = [];
    chestCaptureActive = false;
    const btn = document.getElementById('ll-capture-toggle-btn');
    if (btn) { btn.textContent = 'Start Capturing'; btn.classList.remove('active'); }
    document.getElementById('ll-capture-status-bar')?.classList.add('hidden');
    renderCaptureChips();
    populateAccountabilityDropdowns();
    showToast('Captures cleared', 'info');
}

function renderCaptureChips() {
    const chips = document.getElementById('ll-capture-chips');
    if (!chips) return;
    const captures = window._chestCaptures || [];
    if (captures.length === 0) {
        chips.innerHTML = '<span style="font-size:0.75rem; color:var(--text-muted);">No chest captures yet</span>';
        return;
    }
    chips.innerHTML = captures.map((cap, i) => {
        const name = esc(cap.tabName || `Tab ${i + 1}`);
        const count = cap.items ? cap.items.length : 0;
        const tw = cap.items ? cap.items.reduce((s, it) => s + getItemWeight(it.itemId) * (it.quantity || 1), 0) : 0;
        const weightStr = tw > 0 ? ` · ${tw.toFixed(1)} kg` : '';
        return `<div class="ll-capture-chip">${name}<span class="ll-chip-count">${count} items${weightStr}</span></div>`;
    }).join('');
}

// --- Mode switching ---
function showLootLoggerMode(mode) {
    lootLoggerMode = mode;
    document.querySelectorAll('.loot-log-mode').forEach(el => el.style.display = 'none');
    document.getElementById('loot-log-live').style.display = mode === 'live' ? '' : 'none';
    document.getElementById('loot-log-upload').style.display = mode === 'upload' ? '' : 'none';
    document.getElementById('loot-log-accountability').style.display = mode === 'accountability' ? '' : 'none';
    document.getElementById('loot-log-live-btn').className = mode === 'live' ? 'btn-small-accent' : 'btn-small';
    document.getElementById('loot-log-upload-btn').className = mode === 'upload' ? 'btn-small-accent' : 'btn-small';
    document.getElementById('loot-log-acc-btn').className = mode === 'accountability' ? 'btn-small-accent' : 'btn-small';
    if (mode === 'live') {
        const token = localStorage.getItem('albion_auth_token');
        if (!token && !discordUser) {
            const list = document.getElementById('loot-sessions-list');
            if (list) list.innerHTML = `<div class="empty-state"><p>Log in with Discord to view saved sessions.<br><span style="font-size:0.78rem; color:var(--text-muted);">Upload mode works without login.</span></p></div>`;
            return;
        }
        loadLootSessions();
    }
    if (mode === 'accountability') {
        // Seed from lootBuyerCaptures if _chestCaptures is empty (captures arrived before switching here)
        if ((!window._chestCaptures || window._chestCaptures.length === 0) && typeof lootBuyerCaptures !== 'undefined' && lootBuyerCaptures.length > 0) {
            window._chestCaptures = [...lootBuyerCaptures];
        }
        populateAccountabilityDropdowns();
        renderCaptureChips();
    }
}

async function loadLootSessions() {
    const list = document.getElementById('loot-sessions-list');
    if (!list) return;
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) });
        if (res.status === 401 || res.status === 403) throw new Error('auth');
        if (!res.ok) throw new Error('server');
        const data = await res.json();
        lootSessions = data.sessions || [];

        let html = '';
        // Show live session card if events are accumulated
        if (liveLootEvents.length > 0) {
            const players = new Set(liveLootEvents.map(e => e.looted_by_name || e.lootedBy?.name || '')).size;
            const badge = liveSessionActive
                ? '<span class="loot-tab-status status-open" style="margin-left:0.4rem;">LIVE</span>'
                : '<span class="loot-tab-status status-partial" style="margin-left:0.4rem;">PAUSED</span>';
            html += `<div class="ll-session-card active-live" onclick="showLiveSession()">
                <div class="ll-session-info">
                    <div class="ll-session-title">Live Session${badge}</div>
                    <div class="ll-session-meta">${liveLootEvents.length} events &bull; ${players} players</div>
                </div>
            </div>`;
        }

        if (lootSessions.length === 0 && liveLootEvents.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>No loot sessions yet. Start a live session with the Coldtouch client, or upload a log file.</p></div>';
            return;
        }

        html += lootSessions.map(s => {
            const started = new Date(s.started_at).toLocaleString();
            const endedAt = s.ended_at ? new Date(s.ended_at) : null;
            const duration = endedAt ? Math.round((endedAt - new Date(s.started_at)) / 60000) + ' min' : 'ongoing';
            const sid = esc(s.session_id);
            return `<div class="ll-session-card" onclick="showSessionDetail('${sid}')">
                <div class="ll-session-info">
                    <div class="ll-session-title">${started} <span style="font-size:0.68rem; color:var(--text-muted);">(${duration})</span></div>
                    <div class="ll-session-meta">${s.event_count} events &bull; ${s.player_count} players</div>
                </div>
                <button class="btn-small-danger" style="padding:0.2rem 0.4rem; font-size:0.65rem; flex-shrink:0;" onclick="event.stopPropagation(); deleteLootSession('${sid}', this)" title="Delete">✕</button>
            </div>`;
        }).join('');
        list.innerHTML = html;
    } catch(e) {
        const isAuth = e.message === 'auth';
        const msg = isAuth
            ? 'Log in with Discord to view saved sessions.'
            : 'Could not reach server. Check your connection.';
        list.innerHTML = `<div class="empty-state"><p>${msg}</p>
            ${!isAuth ? '<button class="btn-small" onclick="loadLootSessions()" style="margin-top:0.5rem;">Retry</button>' : ''}
        </div>`;
    }
}

function showLiveSession() {
    renderLootSessionEvents(liveLootEvents.map(e => ({
        looted_by_name: e.looted_by_name || e.lootedBy?.name || '',
        looted_by_guild: e.looted_by_guild || e.lootedBy?.guild || '',
        looted_by_alliance: e.looted_by_alliance || e.lootedBy?.alliance || '',
        looted_from_name: e.looted_from_name || e.lootedFrom?.name || '',
        looted_from_guild: e.looted_from_guild || e.lootedFrom?.guild || '',
        looted_from_alliance: e.looted_from_alliance || e.lootedFrom?.alliance || '',
        item_id: e.item_id || e.itemId || '',
        quantity: e.quantity || 1,
        timestamp: e.timestamp,
        weight: e.weight || 0,
        died: e.died || false
    })));
}

async function showSessionDetail(sessionId) {
    const detail = document.getElementById('loot-session-detail');
    detail.style.display = '';
    detail.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-session/${encodeURIComponent(sessionId)}`, { headers: authHeaders() });
        const data = await res.json();
        renderLootSessionEvents(data.events || []);
    } catch(e) {
        detail.innerHTML = `<div class="empty-state"><p>Failed to load session: ${esc(e.message)}</p></div>`;
    }
}

function hideLootSessionDetail() {
    const el = document.getElementById('loot-session-detail');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

function clearLootUpload() {
    document.getElementById('loot-upload-result').innerHTML = '';
    document.getElementById('loot-log-file-status').textContent = '';
    document.getElementById('ll-upload-clear-btn').style.display = 'none';
}

async function renderLootSessionEvents(events, targetEl, depositedMap) {
    // depositedMap: optional { itemId: qty } for accountability coloring
    const isDetail = !targetEl;
    const detail = targetEl || document.getElementById('loot-session-detail');
    detail.style.display = '';

    if (events.length === 0) {
        detail.innerHTML = '<div class="empty-state"><p>No loot events in this session.</p></div>';
        return;
    }

    // Build per-player breakdown
    const byPlayer = {};
    for (const ev of events) {
        const name = ev.looted_by_name || 'Unknown';
        if (!byPlayer[name]) byPlayer[name] = {
            guild: ev.looted_by_guild || '', alliance: ev.looted_by_alliance || '',
            items: [], totalQty: 0, totalWeight: 0
        };
        byPlayer[name].items.push(ev);
        byPlayer[name].totalQty += (ev.quantity || 1);
        const w = ev.weight > 0 ? ev.weight : getItemWeight(ev.item_id) * (ev.quantity || 1);
        byPlayer[name].totalWeight += w;
    }

    // Build price map for all item IDs
    const allItemIds = new Set(events.map(e => e.item_id).filter(Boolean));
    const priceMap = await getLootPriceMap(allItemIds);

    // Cache state for filter/sort re-renders
    _llCurrentEvents = events;
    _llCurrentByPlayer = byPlayer;
    _llPriceMap = priceMap;
    _llDepositedMap = depositedMap || null;
    _llTargetEl = detail;
    _llIsDetail = isDetail;

    // Compute player values and attach to byPlayer for sorting
    for (const [, data] of Object.entries(byPlayer)) {
        data.totalValue = data.items.reduce((s, ev) => {
            const p = priceMap[ev.item_id];
            return s + (p ? p.price * (ev.quantity || 1) : 0);
        }, 0);
    }

    // Render header + search/sort bar + cards
    _llRenderFiltered();
}

// Re-render player cards based on current search/sort (no async, no price refetch)
function _llRenderFiltered() {
    const detail = _llTargetEl;
    const byPlayer = _llCurrentByPlayer;
    const priceMap = _llPriceMap;
    const depositedMap = _llDepositedMap;
    const isDetail = _llIsDetail;
    const events = _llCurrentEvents;
    if (!detail || !events.length) return;

    // Read current filter/sort values (may not exist yet on first render)
    const searchEl = document.getElementById('ll-search');
    const sortEl = document.getElementById('ll-sort');
    const searchVal = searchEl ? searchEl.value.toLowerCase().trim() : '';
    const sortVal = sortEl ? sortEl.value : 'value';

    // Filter players by search text (match player name, guild, or any item name)
    let entries = Object.entries(byPlayer);
    if (searchVal) {
        entries = entries.filter(([name, data]) => {
            if (name.toLowerCase().includes(searchVal)) return true;
            if (data.guild && data.guild.toLowerCase().includes(searchVal)) return true;
            if (data.alliance && data.alliance.toLowerCase().includes(searchVal)) return true;
            return data.items.some(ev => {
                const iName = getFriendlyName(ev.item_id) || ev.item_id || '';
                return iName.toLowerCase().includes(searchVal);
            });
        });
    }

    // Sort
    if (sortVal === 'value') entries.sort((a, b) => b[1].totalValue - a[1].totalValue);
    else if (sortVal === 'items') entries.sort((a, b) => b[1].totalQty - a[1].totalQty);
    else if (sortVal === 'weight') entries.sort((a, b) => b[1].totalWeight - a[1].totalWeight);
    else if (sortVal === 'name') entries.sort((a, b) => a[0].localeCompare(b[0]));

    // Totals (from full dataset, not filtered)
    const totalItems = events.reduce((s, e) => s + (e.quantity || 1), 0);
    const totalValue = events.reduce((s, e) => {
        const p = priceMap[e.item_id];
        return s + (p ? p.price * (e.quantity || 1) : 0);
    }, 0);
    const totalPlayers = Object.keys(byPlayer).length;

    // Header
    let html = `<div class="ll-viewer-header">
        <div style="font-size:0.82rem; color:var(--text-muted);">
            ${events.length} events &bull; ${totalPlayers} players &bull; ${totalItems} items
            ${totalValue > 0 ? `&bull; <span style="color:var(--accent);">${formatSilver(totalValue)} est. value</span>` : ''}
        </div>
        ${isDetail ? `<button class="btn-small" onclick="hideLootSessionDetail()">&#x2190; Back</button>` : ''}
    </div>`;

    // Search/sort bar
    html += `<div class="ll-filter-bar">
        <div class="search-input-wrapper" style="flex:1; min-width:160px;">
            <span class="search-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></span>
            <input type="text" id="ll-search" placeholder="Search player, guild, or item..." value="${esc(searchVal)}" oninput="_llRenderFiltered()">
        </div>
        <select id="ll-sort" class="transport-select" style="min-width:100px;" onchange="_llRenderFiltered()">
            <option value="value"${sortVal === 'value' ? ' selected' : ''}>Value ↓</option>
            <option value="items"${sortVal === 'items' ? ' selected' : ''}>Items ↓</option>
            <option value="weight"${sortVal === 'weight' ? ' selected' : ''}>Weight ↓</option>
            <option value="name"${sortVal === 'name' ? ' selected' : ''}>Name A-Z</option>
        </select>
        <span style="font-size:0.72rem; color:var(--text-muted); white-space:nowrap;">${entries.length}/${totalPlayers}</span>
    </div>`;

    // Guild color palette (muted, dark-theme friendly)
    const guildPalette = ['#5b8def','#e06c75','#56b6c2','#c678dd','#e5c07b','#61afef','#98c379','#d19a66','#be5046','#7ec8e3'];
    const guildColorMap = {};
    let guildIdx = 0;
    for (const [, data] of entries) {
        const g = data.guild;
        if (g && !(g in guildColorMap)) {
            const hash = [...g].reduce((s, c) => s + c.charCodeAt(0), 0);
            guildColorMap[g] = guildPalette[hash % guildPalette.length];
            guildIdx++;
        }
    }

    // Player cards
    html += entries.map(([name, data]) => {
        const playerValue = data.totalValue;
        const weightStr = data.totalWeight > 0 ? data.totalWeight.toFixed(1) + ' kg' : '—';
        const guildBorder = data.guild && guildColorMap[data.guild]
            ? `border-left: 3px solid ${guildColorMap[data.guild]};` : '';

        // Item icon preview strip (all unique items)
        const seenIds = new Set();
        const previewIcons = [];
        for (const ev of data.items) {
            if (ev.item_id && !seenIds.has(ev.item_id)) {
                seenIds.add(ev.item_id);
                previewIcons.push(ev.item_id);
            }
        }
        const iconStripHtml = previewIcons.map(id =>
            `<img src="https://render.albiononline.com/v1/item/${encodeURIComponent(id)}.png" class="ll-preview-icon" loading="lazy" onerror="this.style.display='none'">`
        ).join('');

        const itemsHtml = data.items.map(ev => {
            const iName = getFriendlyName(ev.item_id) || ev.item_id;
            const iconId = ev.item_id || 'T4_BAG';
            const iconUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(iconId)}.png`;
            const iw = ev.weight > 0 ? ev.weight : getItemWeight(ev.item_id) * (ev.quantity || 1);
            const priceEntry = priceMap[ev.item_id];
            const totalVal = priceEntry ? priceEntry.price * (ev.quantity || 1) : 0;
            const fromStr = ev.looted_from_name
                ? `<span style="font-size:0.67rem; color:var(--text-muted); margin-left:0.2rem;">from ${esc(ev.looted_from_name)}</span>`
                : '';

            // Accountability or death coloring
            let rowClass = '', dotClass = 'll-dot-none';
            if (ev.died) {
                rowClass = 'll-item-died'; dotClass = 'll-dot-died';
            } else if (depositedMap) {
                const inChest = depositedMap[ev.item_id] || 0;
                if (inChest <= 0) { rowClass = 'll-item-missing'; dotClass = 'll-dot-missing'; }
                else if (inChest >= (ev.quantity || 1)) { rowClass = 'll-item-deposited'; dotClass = 'll-dot-deposited'; }
                else { rowClass = 'll-item-partial'; dotClass = 'll-dot-partial'; }
            }

            return `<div class="ll-item-row ll-item-clickable ${rowClass}" onclick="event.stopPropagation(); switchToBrowser('${esc(iconId)}')" title="View in Market Browser">
                <img src="${iconUrl}" class="ll-item-icon" loading="lazy" onerror="this.style.display='none'">
                <span class="ll-item-name">${esc(iName)}${fromStr}</span>
                <span class="ll-item-qty">&times;${ev.quantity || 1}</span>
                <span class="ll-item-value">${totalVal > 0 ? formatSilver(totalVal) : '—'}</span>
                <span class="ll-item-weight">${iw > 0 ? iw.toFixed(1) + ' kg' : ''}</span>
                <span class="ll-item-status-dot ${dotClass}"></span>
            </div>`;
        }).join('');

        return `<div class="ll-player-card" style="${guildBorder}">
            <div class="ll-player-header" onclick="this.closest('.ll-player-card').classList.toggle('expanded')">
                <div class="ll-player-info">
                    <span class="ll-player-name">${esc(name)}</span>
                    ${data.guild ? `<span class="ll-player-guild" style="color:${guildColorMap[data.guild]}">[${esc(data.guild)}]</span>` : ''}
                </div>
                <div class="ll-item-preview">${iconStripHtml}</div>
                <div class="ll-player-stats">
                    <div class="ll-player-stat">
                        <span class="ll-stat-label">Items</span>
                        <span class="ll-stat-value">${data.totalQty}</span>
                    </div>
                    ${playerValue > 0 ? `<div class="ll-player-stat">
                        <span class="ll-stat-label">Value</span>
                        <span class="ll-stat-value accent">${formatSilver(playerValue)}</span>
                    </div>` : ''}
                    <div class="ll-player-stat">
                        <span class="ll-stat-label">Weight</span>
                        <span class="ll-stat-value">${weightStr}</span>
                    </div>
                </div>
                <span class="ll-player-chevron">&#x25BE;</span>
            </div>
            <div class="ll-player-items">${itemsHtml}</div>
        </div>`;
    }).join('');

    if (entries.length === 0 && searchVal) {
        html += '<div class="empty-state"><p>No players match your search.</p></div>';
    }

    detail.innerHTML = html;

    // Restore search focus + cursor position after re-render
    const newSearch = document.getElementById('ll-search');
    if (newSearch && searchVal) {
        newSearch.focus();
        newSearch.setSelectionRange(searchVal.length, searchVal.length);
    }
}

// Handle .txt file upload
async function handleLootFileUpload(input) {
    const file = input.files[0];
    if (!file) return;
    const status = document.getElementById('loot-log-file-status');
    const resultEl = document.getElementById('loot-upload-result');
    const clearBtn = document.getElementById('ll-upload-clear-btn');
    status.textContent = `Reading ${file.name}…`;

    const text = await file.text();
    const allLines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('timestamp'));

    const parsedEvents = [];
    for (const line of allLines) {
        const parts = line.split(';');
        if (parts.length < 10) continue;
        const [ts, byAlliance, byGuild, byName, itemId, , qty, fromAlliance, fromGuild, fromName] = parts;
        parsedEvents.push({
            timestamp: new Date(ts).getTime() || Date.now(),
            looted_by_name: byName || '',
            looted_by_guild: byGuild || '',
            looted_by_alliance: byAlliance || '',
            looted_from_name: (fromName || '').trim(),
            looted_from_guild: fromGuild || '',
            looted_from_alliance: fromAlliance || '',
            item_id: itemId || '',
            quantity: parseInt(qty) || 1,
            weight: 0
        });
    }

    status.textContent = `${parsedEvents.length} loot events from ${file.name}`;
    if (clearBtn) clearBtn.style.display = '';
    await renderLootSessionEvents(parsedEvents, resultEl);

    // Background upload for accountability use
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ lines: allLines })
        });
        if (res.ok) {
            const data = await res.json();
            status.textContent += ` — saved (${data.eventsImported} events)`;
        }
    } catch { /* silent — viewing works without login */ }

    input.value = '';
}

// === ACCOUNTABILITY CHECK ===

function populateAccountabilityDropdowns() {
    const sessionSel = document.getElementById('acc-session-select');
    const captureSel = document.getElementById('acc-capture-select');
    if (!sessionSel || !captureSel) return;

    fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
            let opts = '<option value="">-- Select session --</option>';
            if (liveLootEvents.length > 0) opts += `<option value="__live__">Live Session (${liveLootEvents.length} events)</option>`;
            (data.sessions || []).forEach(s => {
                const d = new Date(s.started_at).toLocaleString();
                opts += `<option value="${esc(s.session_id)}">${d} (${s.event_count} events, ${s.player_count} players)</option>`;
            });
            sessionSel.innerHTML = opts;
        }).catch(() => {});

    const captures = window._chestCaptures || [];
    if (captures.length === 0) {
        captureSel.innerHTML = '<option value="" disabled>No captures yet — open a chest with the client running</option>';
    } else {
        captureSel.innerHTML = captures.map((cap, i) => {
            const name = cap.tabName || `Capture ${i + 1}`;
            const count = cap.items ? cap.items.length : 0;
            const tw = cap.items ? cap.items.reduce((s, it) => s + getItemWeight(it.itemId) * (it.quantity || 1), 0) : 0;
            const weightStr = tw > 0 ? ` &bull; ${tw.toFixed(1)} kg` : '';
            return `<option value="${i}">${esc(name)} (${count} items${weightStr})</option>`;
        }).join('');
    }
}

async function deleteLootSession(sessionId, btnEl) {
    btnEl.outerHTML = `<span style="display:flex; gap:0.2rem; align-items:center;">
        <span style="font-size:0.6rem; color:var(--text-muted);">Delete?</span>
        <button class="btn-small-danger" style="padding:0.15rem 0.3rem; font-size:0.6rem;" onclick="confirmDeleteLootSession('${esc(sessionId)}', this)">Yes</button>
        <button class="btn-small" style="padding:0.15rem 0.3rem; font-size:0.6rem;" onclick="loadLootSessions()">No</button>
    </span>`;
}

async function confirmDeleteLootSession(sessionId, btnEl) {
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-session/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
        const card = btnEl.closest('.ll-session-card');
        if (card) card.remove();
        hideLootSessionDetail();
        showToast('Session deleted', 'success');
    } catch(e) {
        showToast('Failed to delete: ' + e.message, 'error');
        loadLootSessions();
    }
}

async function runAccountabilityCheck() {
    const sessionId = document.getElementById('acc-session-select').value;
    const captureSel = document.getElementById('acc-capture-select');
    const selectedIdxs = Array.from(captureSel.selectedOptions).map(o => parseInt(o.value)).filter(v => !isNaN(v));
    const resultEl = document.getElementById('accountability-result');

    if (!sessionId) { showToast('Select a loot session first', 'warning'); return; }
    if (selectedIdxs.length === 0) { showToast('Select at least one chest capture', 'warning'); return; }

    resultEl.innerHTML = '<div class="empty-state"><p>Analyzing…</p></div>';

    // Fetch loot events
    let lootEvents;
    if (sessionId === '__live__') {
        lootEvents = liveLootEvents.map(e => ({
            looted_by_name: e.looted_by_name || e.lootedBy?.name || '',
            looted_by_guild: e.looted_by_guild || e.lootedBy?.guild || '',
            item_id: e.item_id || e.itemId || '',
            quantity: e.quantity || 1
        }));
    } else {
        try {
            const res = await fetch(`${VPS_BASE}/api/loot-session/${encodeURIComponent(sessionId)}`, { headers: authHeaders() });
            const data = await res.json();
            lootEvents = data.events || [];
        } catch(e) {
            resultEl.innerHTML = `<div class="empty-state"><p>Failed to load session: ${esc(e.message)}</p></div>`;
            return;
        }
    }

    // Merge selected chest captures into deposit inventory
    const captures = window._chestCaptures || [];
    const deposited = {};
    const selectedTabNames = [];
    for (const idx of selectedIdxs) {
        const cap = captures[idx];
        if (!cap || !cap.items) continue;
        selectedTabNames.push(cap.tabName || `Tab ${idx + 1}`);
        for (const item of cap.items) {
            deposited[item.itemId] = (deposited[item.itemId] || 0) + (item.quantity || 1);
        }
    }

    // Per-player looted inventory
    const lootedByPlayer = {};
    for (const ev of lootEvents) {
        const name = ev.looted_by_name || 'Unknown';
        if (!lootedByPlayer[name]) lootedByPlayer[name] = { guild: ev.looted_by_guild || '', items: {} };
        lootedByPlayer[name].items[ev.item_id] = (lootedByPlayer[name].items[ev.item_id] || 0) + (ev.quantity || 1);
    }

    // Cross-reference
    const playerResults = [];
    for (const [name, data] of Object.entries(lootedByPlayer)) {
        let totalLooted = 0, totalDeposited = 0;
        const itemResults = [];
        for (const [itemId, qty] of Object.entries(data.items)) {
            totalLooted += qty;
            const inChest = Math.min(qty, deposited[itemId] || 0);
            const missing = qty - inChest;
            totalDeposited += inChest;
            itemResults.push({ itemId, looted: qty, inChest, missing });
        }
        const pct = totalLooted > 0 ? Math.round(totalDeposited / totalLooted * 100) : 0;
        playerResults.push({ name, guild: data.guild, totalLooted, totalDeposited, totalMissing: totalLooted - totalDeposited, pct, items: itemResults });
    }
    playerResults.sort((a, b) => a.pct - b.pct);

    // Build price map
    const allItemIds = new Set(playerResults.flatMap(p => p.items.map(i => i.itemId)));
    const priceMap = await getLootPriceMap(allItemIds);

    const totalLooted = playerResults.reduce((s, p) => s + p.totalLooted, 0);
    const totalDeposited = playerResults.reduce((s, p) => s + p.totalDeposited, 0);
    const totalMissing = playerResults.reduce((s, p) => s + p.totalMissing, 0);

    let html = '';
    if (selectedTabNames.length > 0) {
        html += `<div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.75rem;">Comparing against: <strong>${selectedTabNames.map(n => esc(n)).join(', ')}</strong></div>`;
    }
    html += `<div class="ll-acc-summary">
        <div class="loot-tracked-stat"><span class="loot-tracked-stat-label">Looted</span><span class="loot-tracked-stat-value">${totalLooted}</span></div>
        <div class="loot-tracked-stat"><span class="loot-tracked-stat-label">In Chest</span><span class="loot-tracked-stat-value" style="color:var(--profit-green);">${totalDeposited}</span></div>
        <div class="loot-tracked-stat"><span class="loot-tracked-stat-label">Missing</span><span class="loot-tracked-stat-value" style="color:var(--loss-red);">${totalMissing}</span></div>
        <div class="loot-tracked-stat"><span class="loot-tracked-stat-label">Players</span><span class="loot-tracked-stat-value">${playerResults.length}</span></div>
    </div>`;

    html += playerResults.map(p => {
        const barColor = p.pct >= 80 ? 'var(--profit-green)' : p.pct >= 40 ? '#fbbf24' : 'var(--loss-red)';
        const initials = p.name.substring(0, 2).toUpperCase();

        const itemsHtml = p.items.map(it => {
            const iName = getFriendlyName(it.itemId) || it.itemId;
            const iconUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(it.itemId || 'T4_BAG')}.png`;
            const priceEntry = priceMap[it.itemId];
            const totalVal = priceEntry ? priceEntry.price * it.looted : 0;
            const iw = getItemWeight(it.itemId);
            const weightStr = iw > 0 ? (iw * it.looted).toFixed(1) + ' kg' : '';
            let rowClass, dotClass, statusLabel;
            if (it.missing === 0) {
                rowClass = 'll-item-deposited'; dotClass = 'll-dot-deposited'; statusLabel = 'Deposited';
            } else if (it.inChest > 0) {
                rowClass = 'll-item-partial'; dotClass = 'll-dot-partial'; statusLabel = `${it.inChest}/${it.looted}`;
            } else {
                rowClass = 'll-item-missing'; dotClass = 'll-dot-missing'; statusLabel = 'Missing';
            }
            return `<div class="ll-item-row ${rowClass}">
                <img src="${iconUrl}" class="ll-item-icon" loading="lazy" onerror="this.style.display='none'">
                <span class="ll-item-name">${esc(iName)}</span>
                <span class="ll-item-qty">&times;${it.looted}</span>
                <span class="ll-item-value">${totalVal > 0 ? formatSilver(totalVal) : '—'}</span>
                <span class="ll-item-weight">${weightStr}</span>
                <span class="ll-item-status-dot ${dotClass}" title="${statusLabel}"></span>
                <span style="font-size:0.67rem; flex-shrink:0; color:${dotClass === 'll-dot-missing' ? 'var(--loss-red)' : dotClass === 'll-dot-partial' ? '#fbbf24' : 'var(--profit-green)'};">${statusLabel}</span>
            </div>`;
        }).join('');

        const playerVal = p.items.reduce((s, it) => {
            const pe = priceMap[it.itemId];
            return s + (pe ? pe.price * it.looted : 0);
        }, 0);

        return `<div class="ll-player-card">
            <div class="ll-player-header" onclick="this.closest('.ll-player-card').classList.toggle('expanded')">
                <div class="ll-player-avatar">${esc(initials)}</div>
                <div class="ll-player-info">
                    <span class="ll-player-name">${esc(p.name)}</span>
                    ${p.guild ? `<span class="ll-player-guild">[${esc(p.guild)}]</span>` : ''}
                </div>
                <div class="ll-player-stats">
                    <div class="ll-player-stat">
                        <span class="ll-stat-label">Deposited</span>
                        <span class="ll-stat-value ${p.pct >= 80 ? 'green' : p.pct >= 40 ? '' : 'red'}">${p.pct}%</span>
                    </div>
                    ${playerVal > 0 ? `<div class="ll-player-stat">
                        <span class="ll-stat-label">Value</span>
                        <span class="ll-stat-value accent">${formatSilver(playerVal)}</span>
                    </div>` : ''}
                    <div class="ll-player-stat">
                        <span class="ll-stat-label">Missing</span>
                        <span class="ll-stat-value ${p.totalMissing > 0 ? 'red' : 'green'}">${p.totalMissing}</span>
                    </div>
                </div>
                <span class="ll-player-chevron">&#x25BE;</span>
            </div>
            <div class="ll-deposit-bar"><div class="ll-deposit-fill" style="width:${p.pct}%; background:${barColor};"></div></div>
            <div class="ll-player-items">${itemsHtml}</div>
        </div>`;
    }).join('');

    resultEl.innerHTML = html;
}

// Hook into existing WS to capture loot events for live mode
function handleLootLoggerWsMessage(msg) {
    if (msg.type === 'loot-event' && msg.data) {
        if (liveSessionActive) {
            liveLootEvents.push(msg.data);
            updateLiveLootIndicator();
            // Real-time update if viewing live session detail
            if (lootLoggerMode === 'live' && document.getElementById('loot-session-detail')?.style.display !== 'none') {
                showLiveSession();
            }
        }
    }
    if (msg.type === 'chest-capture' && msg.data) {
        // Always store captures — available on both Loot Buyer and Loot Logger Accountability
        if (!window._chestCaptures) window._chestCaptures = [];
        window._chestCaptures.push(msg.data);
        if (window._chestCaptures.length > 20) window._chestCaptures.shift();
        // Update Accountability UI if visible
        if (lootLoggerMode === 'accountability') {
            populateAccountabilityDropdowns();
            renderCaptureChips();
        }
    }
    // Death event — prepare for future opcode
    if (msg.type === 'death-event' && msg.data) {
        const playerName = msg.data.playerName || '';
        if (playerName) {
            liveLootEvents.forEach(ev => {
                const evName = ev.looted_by_name || ev.lootedBy?.name || '';
                if (evName === playerName) ev.died = true;
            });
            if (lootLoggerMode === 'live' && document.getElementById('loot-session-detail')?.style.display !== 'none') {
                showLiveSession();
            }
        }
    }
}

// ====== TRANSPORT TAB ======
let lastTransportRoutes = null;

async function doTransportScan() {
    if (scanAbortController) scanAbortController.abort();
    scanAbortController = new AbortController();

    const spinner = document.getElementById('transport-spinner');
    const errorEl = document.getElementById('transport-error');
    const container = document.getElementById('transport-results');
    const buyCity = document.getElementById('transport-buy-city').value;
    const sellCity = document.getElementById('transport-sell-city').value;
    const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
    const minConfidence = parseInt(document.getElementById('transport-min-confidence').value) || 0;
    const sortBy = document.getElementById('transport-sort').value;
    const { mountCapacity, freeSlots } = getTransportMountConfig();
    const transportMode = document.querySelector('.transport-mode-btn.active')?.dataset.mode || 'live';
    const sellStrategy = document.getElementById('transport-sell-strategy')?.value || 'market';
    const excludeCaerleon = document.getElementById('transport-exclude-caerleon').checked;

    container.innerHTML = '';
    hideError(errorEl);
    spinner.classList.remove('hidden');

    try {
        let routes;

        if (transportMode === 'live') {
            // NEW: Use backend-computed routes from alertMarketDb (real-time NATS data)
            const freshMode = document.getElementById('transport-fresh-mode')?.value || 'off';
            const freshMins = parseInt(document.getElementById('transport-fresh-threshold')?.value) || 60;
            const maxAge = freshMode !== 'off' ? freshMins : 120; // default 2h max age for live data

            const params = new URLSearchParams({
                sell_strategy: sellStrategy,
                max_age: maxAge,
                limit: 300
            });
            if (buyCity) params.set('buy_city', buyCity);
            if (sellCity) params.set('sell_city', sellCity);
            if (excludeCaerleon) params.set('exclude', 'Caerleon,Black Market');

            const res = await fetch(`${VPS_BASE}/api/transport-routes-live?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            routes = data.routes || [];

            // Convert live routes to the format enrichAndRenderTransport expects
            lastTransportRoutes = routes.map(r => ({
                item_id: r.item_id, quality: r.quality,
                buy_city: r.buy_city, sell_city: r.sell_city,
                avg_spread: r.profit, confidence_score: 0, consistency_pct: 0,
                sample_count: 0, buy_volume: 0, sell_volume: 0,
                // Carry pre-computed prices so enrichment doesn't need IndexedDB
                _liveData: r
            }));
        } else {
            // Historical mode: use spread_stats (old endpoint)
            const params = new URLSearchParams({ min_confidence: minConfidence, limit: 150 });
            if (buyCity) params.set('buy_city', buyCity);
            if (sellCity) params.set('sell_city', sellCity);
            const res = await fetch(`${VPS_BASE}/api/transport-routes?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            routes = await res.json();
            lastTransportRoutes = routes;
        }

        spinner.classList.add('hidden');
        await enrichAndRenderTransport(lastTransportRoutes, budget, sortBy, mountCapacity, freeSlots);
    } catch (e) {
        spinner.classList.add('hidden');
        showError(errorEl, 'Failed to load transport routes: ' + e.message);
    }
}

async function enrichAndRenderTransport(routes, budget, sortBy, mountCapacity, freeSlots) {
    const availableSlots = freeSlots || 30;
    const transportMode = document.querySelector('.transport-mode-btn.active')?.dataset.mode || 'live';

    // Enrich with current live prices from IndexedDB
    const cachedData = await MarketDB.getAllPrices();
    const priceMap = {};
    cachedData.forEach(p => {
        let city = p.city;
        if (city && city.includes('Black Market')) city = 'Black Market';
        const key = `${p.item_id}_${p.quality}_${city}`;
        if (!priceMap[key]) priceMap[key] = { sellMin: 0, buyMax: 0, sellDate: '', buyDate: '' };
        if (p.sell_price_min > 0 && (priceMap[key].sellMin === 0 || p.sell_price_min < priceMap[key].sellMin)) {
            priceMap[key].sellMin = p.sell_price_min;
            priceMap[key].sellDate = p.sell_price_min_date || '';
        }
        if (p.buy_price_max > 0 && p.buy_price_max > priceMap[key].buyMax) {
            priceMap[key].buyMax = p.buy_price_max;
            priceMap[key].buyDate = p.buy_price_max_date || '';
        }
    });

    const sellStrategy = document.getElementById('transport-sell-strategy')?.value || 'market';

    const enriched = [];
    for (const r of routes) {
        const buyKey = `${r.item_id}_${r.quality}_${r.buy_city}`;
        const sellKey = `${r.item_id}_${r.quality}_${r.sell_city}`;
        const buyData = priceMap[buyKey];
        const sellData = priceMap[sellKey];

        let buyPrice, sellPrice, profitPerUnit, dateBuy, dateSell, isHistorical, sellMode;

        if (r._liveData) {
            // Pre-computed from /api/transport-routes-live — no IndexedDB needed
            const ld = r._liveData;
            buyPrice = ld.buy_price;
            sellPrice = ld.sell_price;
            profitPerUnit = ld.profit;
            dateBuy = '';
            dateSell = '';
            isHistorical = false;
            sellMode = ld.sell_strategy || 'market';
            if (ld.buy_age >= 0) dateBuy = new Date(Date.now() - ld.buy_age * 60000).toISOString();
            if (ld.sell_age >= 0 && ld.sell_age < 9999) dateSell = new Date(Date.now() - ld.sell_age * 60000).toISOString();
            // Carry through available amounts from NATS
            r._buyAmount = ld.buy_amount || 0;
        } else if (transportMode === 'historical') {
            // Historical mode: use spread_stats avg_spread directly
            const spread = r.avg_spread || 0;
            if (spread <= 0) continue;

            if (buyData && buyData.sellMin > 0) {
                buyPrice = buyData.sellMin;
                sellPrice = buyPrice + spread + (buyPrice * TAX_RATE * (spread / (spread + buyPrice)));
            } else {
                buyPrice = Math.round(spread * 3);
                sellPrice = Math.round(buyPrice + spread + (buyPrice + spread) * TAX_RATE);
            }
            profitPerUnit = Math.round(spread);
            dateBuy = buyData ? buyData.sellDate : '';
            dateSell = sellData ? sellData.buyDate : '';
            isHistorical = true;
            sellMode = 'historical';
        } else {
            // Fallback: Live mode IndexedDB enrichment
            if (!buyData || buyData.sellMin <= 0) continue;
            buyPrice = buyData.sellMin;

            const sellStrategyVal = document.getElementById('transport-sell-strategy')?.value || 'market';
            if (sellStrategyVal === 'market') {
                if (!sellData || sellData.sellMin <= 0) continue;
                sellPrice = sellData.sellMin;
                dateSell = sellData.sellDate;
                sellMode = 'market';
            } else {
                if (!sellData || sellData.buyMax <= 0) continue;
                sellPrice = sellData.buyMax;
                dateSell = sellData.buyDate;
                sellMode = 'instant';
            }

            const effectiveTaxRate = sellMode === 'instant' ? TAX_RATE : (TAX_RATE + SETUP_FEE);
            profitPerUnit = sellPrice - buyPrice - (sellPrice * effectiveTaxRate);
            if (profitPerUnit <= 0) continue;
            dateBuy = buyData.sellDate;
            isHistorical = false;
        }

        const effectiveTaxRate = sellMode === 'instant' ? TAX_RATE : (TAX_RATE + SETUP_FEE);
        const tax = sellPrice * effectiveTaxRate;
        const roi = (profitPerUnit / buyPrice) * 100;
        const sellVolume = r.sell_volume || 0;
        const buyVolume = r.buy_volume || 0;
        const volume = Math.max(buyVolume, sellVolume);
        const realisticVolume = Math.min(buyVolume || volume, sellVolume || volume);

        // Weight + slot calculation
        const itemWeight = calcItemWeight(r.item_id);
        const stackable = isStackableItem(r.item_id);
        const stackSize = getStackSize(r.item_id);
        const category = categorizeItem(r.item_id);

        // Use AVAILABLE slots (player's actual free slots), not hardcoded 48
        let maxByBudget = Math.floor(budget / buyPrice);
        const hasVolumeData = realisticVolume > 0;
        let maxByVolume = hasVolumeData ? Math.ceil(realisticVolume) : Infinity;
        let maxBySlots = stackable ? availableSlots * stackSize : availableSlots;
        let maxByWeight = itemWeight > 0 ? Math.floor(mountCapacity / itemWeight) : Infinity;
        // Hard cap: available quantity at this price (from NATS order amounts)
        const buyAmount = r._buyAmount || r.buyAmount || 0;
        let maxByAmount = buyAmount > 0 ? buyAmount : Infinity;

        const unitsCanCarry = Math.max(1, Math.min(maxByBudget, maxByVolume, maxBySlots, maxByWeight, maxByAmount));
        const silverUsed = unitsCanCarry * buyPrice;
        const tripProfit = profitPerUnit * unitsCanCarry;
        const transportScore = profitPerUnit * volume;

        // Slot efficiency: profit per slot used (key metric for haul packing)
        const slotsUsed = stackable ? Math.ceil(unitsCanCarry / stackSize) : unitsCanCarry;
        const profitPerSlot = slotsUsed > 0 ? tripProfit / slotsUsed : 0;

        // Determine limiting factor
        let limitingFactor = 'budget';
        if (unitsCanCarry === maxByAmount && maxByAmount < maxByBudget) limitingFactor = 'available';
        if (unitsCanCarry === maxByVolume && maxByVolume < maxByBudget && maxByVolume <= maxByAmount) limitingFactor = 'volume';
        if (unitsCanCarry === maxBySlots && maxBySlots < maxByBudget && maxBySlots <= maxByVolume && maxBySlots <= maxByAmount) limitingFactor = 'slots';
        if (unitsCanCarry === maxByWeight && maxByWeight < maxByBudget && maxByWeight <= maxByVolume && maxByWeight <= maxBySlots && maxByWeight <= maxByAmount) limitingFactor = 'weight';

        enriched.push({
            itemId: r.item_id,
            quality: r.quality,
            buyCity: r.buy_city,
            sellCity: r.sell_city,
            buyPrice, sellPrice, tax, profitPerUnit, roi,
            volume: Math.round(volume),
            realisticVolume: Math.round(realisticVolume),
            hasVolumeData,
            unitsCanCarry,
            slotsUsed,
            silverUsed: Math.round(silverUsed),
            tripProfit,
            transportScore,
            profitPerSlot,
            itemWeight,
            totalWeight: itemWeight * unitsCanCarry,
            stackable,
            stackSize,
            category,
            limitingFactor,
            confidence: r.confidence_score,
            consistencyPct: r.consistency_pct,
            avgSpread: r.avg_spread,
            medianSpread: r.median_spread,
            sampleCount: r.sample_count,
            dateBuy, dateSell,
            isHistorical, sellMode,
            buyAmount: r._buyAmount || 0,
            instantSellPrice: r._liveData?.instant_sell_price || 0,
            instantProfit: r._liveData?.instant_profit || 0
        });
    }

    // Sort
    if (sortBy === 'trip_profit') enriched.sort((a, b) => b.tripProfit - a.tripProfit);
    else if (sortBy === 'transport_score') enriched.sort((a, b) => b.transportScore - a.transportScore);
    else if (sortBy === 'profit_per_unit') enriched.sort((a, b) => b.profitPerUnit - a.profitPerUnit);
    else if (sortBy === 'volume') enriched.sort((a, b) => b.volume - a.volume);
    else if (sortBy === 'confidence') enriched.sort((a, b) => (b.confidence||0) - (a.confidence||0));

    const excludeCaerleon = document.getElementById('transport-exclude-caerleon').checked;
    const caerleonCities = new Set(['Caerleon', 'Black Market']);
    const itemTypeFilter = document.getElementById('transport-item-type').value;

    let filtered = enriched;
    if (excludeCaerleon) filtered = filtered.filter(r => !caerleonCities.has(r.sellCity) && !caerleonCities.has(r.buyCity));
    if (itemTypeFilter === 'gear') filtered = filtered.filter(r => !r.stackable);
    else if (itemTypeFilter === 'stackable') filtered = filtered.filter(r => r.stackable);
    else if (itemTypeFilter !== 'all') filtered = filtered.filter(r => r.category === itemTypeFilter);

    // Freshness filter — only filters items that HAVE date data.
    // Items with unknown dates (empty/NATS-sourced) are kept, not penalized.
    const freshMode = document.getElementById('transport-fresh-mode')?.value || 'off';
    const freshThresholdMins = parseInt(document.getElementById('transport-fresh-threshold')?.value) || 60;
    if (freshMode !== 'off') {
        const now = new Date();
        const thresholdMs = freshThresholdMins * 60 * 1000;
        filtered = filtered.filter(r => {
            const hasDateBuy = r.dateBuy && r.dateBuy.length > 4 && !r.dateBuy.startsWith('0001');
            const hasDateSell = r.dateSell && r.dateSell.length > 4 && !r.dateSell.startsWith('0001');
            const buyAge = hasDateBuy ? now - new Date(r.dateBuy.endsWith('Z') ? r.dateBuy : r.dateBuy + 'Z') : null;
            const sellAge = hasDateSell ? now - new Date(r.dateSell.endsWith('Z') ? r.dateSell : r.dateSell + 'Z') : null;
            // If we have date data, enforce freshness. If no date, allow through.
            if (freshMode === 'buy') return buyAge === null || buyAge < thresholdMs;
            if (freshMode === 'sell') return sellAge === null || sellAge < thresholdMs;
            const buyOk = buyAge === null || buyAge < thresholdMs;
            const sellOk = sellAge === null || sellAge < thresholdMs;
            return buyOk && sellOk;
        });
    }

    // === GROUP ITEMS INTO HAUL PLANS ===
    // Group by route (buyCity -> sellCity), then optimally pack each trip
    const routeGroups = {};
    for (const item of filtered) {
        const routeKey = `${item.buyCity}→${item.sellCity}`;
        if (!routeGroups[routeKey]) routeGroups[routeKey] = [];
        routeGroups[routeKey].push(item);
    }

    // Build haul plans with improved packing: prioritize PROFIT PER SLOT, not just profit per unit.
    // This ensures stackable items that fill 1 slot with 999 units rank higher than
    // a gear piece that fills 1 slot with 1 unit (if the stackable has better total profit).
    const haulPlans = [];
    for (const [routeKey, items] of Object.entries(routeGroups)) {
        // Score each item by profit per slot (how much silver each inventory slot earns)
        // For gear (1 per slot): profitPerSlot = profitPerUnit
        // For stackable (999 per slot): profitPerSlot = profitPerUnit * min(budget/price, volume, 999)
        const scored = items.map(item => {
            const maxAffordable = Math.floor(budget / item.buyPrice);
            const maxVol = item.realisticVolume > 0 ? Math.ceil(item.realisticVolume) : maxAffordable;
            const maxWt = item.itemWeight > 0 ? Math.floor(mountCapacity / item.itemWeight) : maxAffordable;
            const unitsPerSlot = item.stackable ? Math.min(item.stackSize, maxAffordable, maxVol) : 1;
            return { ...item, slotScore: item.profitPerUnit * unitsPerSlot };
        });
        scored.sort((a, b) => b.slotScore - a.slotScore);

        let remainingBudget = budget;
        let remainingWeight = mountCapacity;
        let remainingSlots = availableSlots;
        const planItems = [];

        // Two-pass packing: Pass 1 caps each item at 40% of budget/slots to force variety.
        // Pass 2 fills remaining capacity with top items that can still absorb more.
        const maxBudgetPerItem = budget * 0.4;
        const maxSlotsPerItem = Math.max(1, Math.ceil(availableSlots * 0.4));

        for (const item of scored) {
            if (remainingBudget <= item.buyPrice * 0.5 || remainingSlots <= 0) break;
            if (item.itemWeight > 0 && remainingWeight < item.itemWeight) continue;

            let maxAfford = Math.floor(Math.min(remainingBudget, maxBudgetPerItem) / item.buyPrice);
            if (maxAfford <= 0) continue;
            let maxVolume = item.realisticVolume > 0 ? Math.ceil(item.realisticVolume) : Infinity;
            const slotsAvail = Math.min(maxSlotsPerItem, remainingSlots);
            let maxSlots = item.stackable ? slotsAvail * item.stackSize : slotsAvail;
            let maxWeight = item.itemWeight > 0 ? Math.floor(remainingWeight / item.itemWeight) : Infinity;

            const units = Math.min(maxAfford, maxVolume, maxSlots, maxWeight);
            if (units <= 0) continue;

            const cost = units * item.buyPrice;
            const profit = units * item.profitPerUnit;
            const weight = units * item.itemWeight;
            const slots = item.stackable ? Math.ceil(units / item.stackSize) : units;

            if (slots > remainingSlots) continue;

            planItems.push({ ...item, planUnits: units, planCost: Math.round(cost), planProfit: Math.round(profit), planWeight: weight, planSlots: slots });
            remainingBudget -= cost;
            remainingWeight -= weight;
            remainingSlots -= slots;
        }

        // Pass 2: Fill remaining budget/slots with more units of items already in plan
        if (remainingBudget > 0 && remainingSlots > 0 && planItems.length > 0) {
            for (const pi of planItems) {
                if (remainingBudget <= pi.buyPrice * 0.5 || remainingSlots <= 0) break;
                let extraAfford = Math.floor(remainingBudget / pi.buyPrice);
                if (extraAfford <= 0) continue;
                let extraVol = pi.realisticVolume > 0 ? Math.max(0, Math.ceil(pi.realisticVolume) - pi.planUnits) : Infinity;
                let extraSlots = pi.stackable ? remainingSlots * pi.stackSize : remainingSlots;
                let extraWeight = pi.itemWeight > 0 ? Math.floor(remainingWeight / pi.itemWeight) : Infinity;
                const extra = Math.min(extraAfford, extraVol, extraSlots, extraWeight);
                if (extra <= 0) continue;
                const extraCost = extra * pi.buyPrice;
                const extraProfit = extra * pi.profitPerUnit;
                const extraWt = extra * pi.itemWeight;
                const newSlots = pi.stackable ? Math.ceil((pi.planUnits + extra) / pi.stackSize) : pi.planUnits + extra;
                const slotsAdded = newSlots - pi.planSlots;
                if (slotsAdded > remainingSlots) continue;
                pi.planUnits += extra;
                pi.planCost = Math.round(pi.planCost + extraCost);
                pi.planProfit = Math.round(pi.planProfit + extraProfit);
                pi.planWeight += extraWt;
                pi.planSlots = newSlots;
                remainingBudget -= extraCost;
                remainingWeight -= extraWt;
                remainingSlots -= slotsAdded;
            }
        }

        if (planItems.length > 0) {
            const totalCost = planItems.reduce((s, i) => s + i.planCost, 0);
            const totalProfit = planItems.reduce((s, i) => s + i.planProfit, 0);
            const totalWeight = planItems.reduce((s, i) => s + i.planWeight, 0);
            const totalSlots = planItems.reduce((s, i) => s + i.planSlots, 0);
            haulPlans.push({
                routeKey,
                buyCity: planItems[0].buyCity,
                sellCity: planItems[0].sellCity,
                items: planItems,
                totalCost,
                totalProfit,
                totalWeight,
                totalSlots,
                budgetUsed: ((totalCost / budget) * 100).toFixed(0),
                avgConfidence: Math.round(planItems.reduce((s, i) => s + (i.confidence || 0), 0) / planItems.length),
                isHistorical: planItems.some(i => i.isHistorical)
            });
        }
    }

    // Sort haul plans by total profit
    haulPlans.sort((a, b) => b.totalProfit - a.totalProfit);

    // Track which items are in haul plans to avoid duplicate display
    const inHaulPlan = new Set();
    for (const plan of haulPlans.slice(0, 8)) {
        for (const item of plan.items) {
            inHaulPlan.add(`${item.itemId}_${item.quality}_${item.buyCity}_${item.sellCity}`);
        }
    }

    // Individual routes: only show items NOT already in a haul plan
    const individualRoutes = filtered.filter(r => !inHaulPlan.has(`${r.itemId}_${r.quality}_${r.buyCity}_${r.sellCity}`));

    renderTransportResults(individualRoutes.slice(0, 40), budget, mountCapacity, haulPlans, availableSlots);
}

// Track which haul plans are expanded (persists across re-renders)
const expandedHaulPlans = new Set();

function renderTransportResults(routes, budget, mountCapacity, haulPlans, availableSlots) {
    const container = document.getElementById('transport-results');

    // Snapshot which haul plans are currently expanded from the DOM BEFORE clearing
    container.querySelectorAll('.haul-plan-card.expanded').forEach(card => {
        const key = card.dataset.routeKey;
        if (key) expandedHaulPlans.add(key);
    });

    container.innerHTML = '';

    if (routes.length === 0 && (!haulPlans || haulPlans.length === 0)) {
        container.innerHTML = '<div class="empty-state"><p>No profitable transport routes found.</p><p class="hint">Try adjusting your filters, budget, or city selection.</p></div>';
        return;
    }

    // === HAUL PLANS SECTION (Collapsible cards) ===
    if (haulPlans && haulPlans.length > 0) {
        const planSection = document.createElement('div');
        planSection.className = 'haul-plans-section';
        planSection.innerHTML = `<div class="section-header" style="display:flex; align-items:center; gap:0.5rem; margin-bottom:1rem;">
            <h3 style="color:var(--accent); margin:0; font-size:1.1rem;">Haul Plans</h3>
            <span style="font-size:0.8rem; color:var(--text-muted);">${haulPlans.length} route${haulPlans.length > 1 ? 's' : ''} found &bull; ${availableSlots} free slots &bull; ${budget.toLocaleString()} silver budget</span>
        </div>`;

        const topPlans = haulPlans.slice(0, 8);
        topPlans.forEach((plan, idx) => {
            const planCard = document.createElement('div');
            planCard.className = 'haul-plan-card';
            planCard.dataset.routeKey = plan.routeKey;
            const weightPct = Number.isFinite(mountCapacity) && mountCapacity > 0 ? ((plan.totalWeight / mountCapacity) * 100).toFixed(0) : null;
            const roiPct = plan.totalCost > 0 ? ((plan.totalProfit / plan.totalCost) * 100).toFixed(1) : 0;
            const confBadge = plan.avgConfidence >= 70 ? '<span style="color:#22c55e; font-size:0.7rem;">HIGH</span>' : plan.avgConfidence >= 40 ? '<span style="color:#f59e0b; font-size:0.7rem;">MED</span>' : '<span style="color:#ef4444; font-size:0.7rem;">LOW</span>';
            const histBadge = plan.isHistorical ? ' <span style="background:rgba(167,139,250,0.15); color:#a78bfa; border:1px solid rgba(167,139,250,0.3); padding:0 4px; border-radius:4px; font-size:0.6rem; font-weight:700;">HISTORICAL</span>' : '';

            // Find oldest price date among all items to show worst-case freshness
            const allDates = plan.items.flatMap(i => [i.dateBuy, i.dateSell]).filter(d => d);
            const oldestDate = allDates.length > 0 ? allDates.reduce((oldest, d) => d < oldest ? d : oldest) : '';
            const freshnessHtml = oldestDate ? `${getFreshnessIndicator(oldestDate)} ${timeAgo(oldestDate)}` : '<span style="color:#ef4444;">No data</span>';

            // --- Collapsed summary (always visible) ---
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'haul-plan-summary';
            summaryDiv.style.cursor = 'pointer';
            summaryDiv.innerHTML = `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:0.75rem; flex-wrap:wrap;">
                    <div style="display:flex; align-items:center; gap:0.75rem; min-width:0;">
                        <span class="haul-plan-rank">#${idx + 1}</span>
                        <div style="display:flex; align-items:center; gap:6px;">
                            ${plan.items.slice(0, 5).map(item => `<img src="https://render.albiononline.com/v1/item/${item.itemId}.png" alt="" loading="lazy" style="width:26px; height:26px; border-radius:4px; border:1px solid var(--border-dim);" title="${esc(getFriendlyName(item.itemId))}">`).join('')}
                            ${plan.items.length > 5 ? `<span style="font-size:0.7rem; color:var(--text-muted);">+${plan.items.length - 5}</span>` : ''}
                        </div>
                        <div style="min-width:0;">
                            <div style="font-weight:600; font-size:0.9rem; color:var(--text-primary);">${esc(plan.buyCity)} ➔ ${esc(plan.sellCity)}</div>
                            <div style="font-size:0.72rem; color:var(--text-muted);">${plan.items.length} item${plan.items.length > 1 ? 's' : ''} &bull; ${plan.totalSlots}/${availableSlots} slots &bull; ${Number.isFinite(mountCapacity) ? `${plan.totalWeight.toFixed(1)}/${mountCapacity} kg` : `${plan.totalWeight.toFixed(1)} kg`} &bull; ${plan.budgetUsed}% budget &bull; ${freshnessHtml} ${confBadge}${histBadge}</div>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:1.2rem; flex-shrink:0;">
                        <div style="text-align:right;">
                            <div style="font-size:0.7rem; color:var(--text-muted);">Trip Profit</div>
                            <div style="font-size:1rem; font-weight:700; color:var(--profit-green);">+${plan.totalProfit.toLocaleString()}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:0.7rem; color:var(--text-muted);">ROI</div>
                            <div style="font-size:0.9rem; font-weight:600; color:var(--profit-green);">${roiPct}%</div>
                        </div>
                        <span class="haul-expand-arrow" style="font-size:1.2rem; color:var(--text-muted); transition:transform 0.2s;">&#9660;</span>
                    </div>
                </div>
            `;

            // --- Expanded detail (hidden by default) ---
            const detailDiv = document.createElement('div');
            detailDiv.className = 'haul-plan-detail';
            detailDiv.style.display = 'none';

            let itemsHtml = plan.items.map(item => {
                const limitIcon = item.limitingFactor === 'available' ? '📦' : item.limitingFactor === 'volume' ? '📊' : item.limitingFactor === 'weight' ? '⚖️' : item.limitingFactor === 'slots' ? '🎒' : '💰';
                const weightStr = item.planWeight > 0 ? `${(item.planWeight).toFixed(1)} kg` : '—';
                const slotsStr = item.stackable ? `${item.planSlots} slot${item.planSlots > 1 ? 's' : ''}` : `${item.planSlots} slot${item.planSlots > 1 ? 's' : ''}`;
                return `<div class="haul-item-row" style="display:flex; align-items:center; gap:0.5rem; padding:0.4rem 0; border-bottom:1px solid var(--border-dim);">
                    <img src="https://render.albiononline.com/v1/item/${item.itemId}.png" alt="" loading="lazy" style="width:32px; height:32px; border-radius:4px;">
                    <div style="flex:1; min-width:0;">
                        <div style="display:flex; align-items:center; gap:0.4rem;">
                            <span style="font-size:0.82rem; font-weight:600; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(getFriendlyName(item.itemId))}</span>
                            <button class="btn-haul-refresh" data-action="haul-refresh" data-item="${item.itemId}" title="Refresh live prices for this item" style="
                                background:var(--surface-3, #2a2a3a); border:1px solid var(--accent, #d4a843); color:var(--accent, #d4a843); border-radius:4px;
                                padding:2px 6px; cursor:pointer; display:inline-flex; align-items:center; gap:3px; font-size:0.65rem; line-height:1; transition:all 0.15s;">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                            </button>
                        </div>
                        <div style="font-size:0.7rem; color:var(--text-muted);">
                            ${getTierEnchLabel(item.itemId)} ${getQualityName(item.quality)}
                            ${item.isHistorical
                                ? `&nbsp;<span style="color:#a78bfa;" title="Prices based on 7-day historical average spread">📊 Avg Spread: +${Math.floor(item.profitPerUnit).toLocaleString()}/unit</span> <span style="opacity:0.7">(${item.consistencyPct ? item.consistencyPct.toFixed(0) + '% consistent' : 'no data'})</span>`
                                : `&nbsp;${getFreshnessIndicator(item.dateBuy)} Buy @ ${Math.floor(item.buyPrice).toLocaleString()} <span style="opacity:0.7">${timeAgo(item.dateBuy)}</span>
                                   &nbsp;${getFreshnessIndicator(item.dateSell)} ${item.sellMode === 'market' ? 'Avg' : 'Sell'} @ ${Math.floor(item.sellPrice).toLocaleString()} <span style="opacity:0.7">${item.sellMode === 'market' ? '7d avg' : timeAgo(item.dateSell)}</span>
                                   ${item.instantSellPrice > 0 ? `&nbsp;<span style="color:var(--profit-green); font-size:0.65rem;" title="Active buy order — instant sell available">⚡ Instant: ${Math.floor(item.instantSellPrice).toLocaleString()}</span>` : ''}`
                            }
                            ${item.buyAmount > 0
                                ? item.planUnits > item.buyAmount
                                    ? ` <span style="color:#f59e0b;" title="Only ${item.buyAmount} available at this price, but ${item.planUnits} suggested">⚠ ${item.buyAmount} avail</span>`
                                    : ` <span style="color:var(--profit-green); font-size:0.65rem;" title="${item.buyAmount} units available at this price (from live orders)">✓ ${item.buyAmount} avail</span>`
                                : !item.hasVolumeData ? ' <span style="color:#f59e0b;" title="No quantity data — verify availability in-game">⚠ qty unknown</span>'
                                : item.realisticVolume > 0 ? ` <span style="color:var(--text-muted);" title="Estimated daily volume">~${Math.round(item.realisticVolume)}/day</span>` : ''}
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns: repeat(5, auto); gap:0.6rem; align-items:center; font-size:0.76rem; flex-shrink:0; text-align:right;">
                        <span title="Buy quantity">${limitIcon} <b>x${item.planUnits.toLocaleString()}</b></span>
                        <span title="Cost" style="color:var(--text-secondary);">${item.planCost.toLocaleString()}s</span>
                        <span title="Weight" style="color:var(--text-muted);">${weightStr}</span>
                        <span title="Slots" style="color:var(--text-muted);">${slotsStr}</span>
                        <span title="Profit" style="color:var(--profit-green); font-weight:600;">+${item.planProfit.toLocaleString()}</span>
                    </div>
                </div>`;
            }).join('');

            detailDiv.innerHTML = `
                <div class="haul-plan-stats" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap:0.5rem; margin-bottom:0.75rem; padding:0.5rem; background:var(--surface-2); border-radius:6px;">
                    <div style="text-align:center;">
                        <div style="font-size:0.68rem; color:var(--text-muted);">Total Cost</div>
                        <div style="font-size:0.85rem; font-weight:600;">${plan.totalCost.toLocaleString()}s</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="font-size:0.68rem; color:var(--text-muted);">Weight</div>
                        <div style="font-size:0.85rem; font-weight:600;">${plan.totalWeight > 0 ? plan.totalWeight.toFixed(1) + ' kg' : 'Minimal'}${weightPct ? ` (${weightPct}%)` : ''}</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="font-size:0.68rem; color:var(--text-muted);">Slots</div>
                        <div style="font-size:0.85rem; font-weight:600;">${plan.totalSlots} / ${availableSlots}</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="font-size:0.68rem; color:var(--text-muted);">Items</div>
                        <div style="font-size:0.85rem; font-weight:600;">${plan.items.length}</div>
                    </div>
                </div>
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem;">
                    <span style="font-size:0.72rem; color:var(--text-muted);">Items in this haul</span>
                    <button class="btn-haul-refresh-all" title="Refresh live prices for all items in this haul plan" style="
                        background:var(--surface-3, #2a2a3a); border:1px solid var(--accent, #d4a843); color:var(--accent, #d4a843); border-radius:5px;
                        padding:4px 10px; cursor:pointer; display:inline-flex; align-items:center; gap:0.3rem; font-size:0.75rem; font-weight:600; transition:all 0.15s;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        Refresh All
                    </button>
                </div>
                <div class="haul-items-list">${itemsHtml}</div>
                <div style="margin-top:0.75rem; text-align:right;">
                    <button class="btn-copy-shopping-list" style="
                        background:var(--surface-3, #2a2a3a); border:1px solid var(--border-dim); color:var(--text-secondary);
                        padding:0.4rem 0.8rem; border-radius:6px; cursor:pointer; font-size:0.76rem;
                        display:inline-flex; align-items:center; gap:0.35rem; transition: all 0.15s;"
                        title="Copy shopping list to clipboard">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy Shopping List
                    </button>
                </div>
            `;

            // Copy shopping list handler
            const copyBtn = detailDiv.querySelector('.btn-copy-shopping-list');
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const lines = [`Shopping List: ${plan.buyCity} → ${plan.sellCity}`, '─'.repeat(40)];
                for (const item of plan.items) {
                    const name = getFriendlyName(item.itemId);
                    lines.push(`Buy ${item.planUnits}x ${name} @ ${Math.floor(item.buyPrice).toLocaleString()} ea = ${item.planCost.toLocaleString()} silver`);
                }
                lines.push('─'.repeat(40));
                lines.push(`Total cost: ${plan.totalCost.toLocaleString()} silver | Expected profit: +${plan.totalProfit.toLocaleString()} silver`);
                lines.push(`Slots: ${plan.totalSlots}/${availableSlots} | ROI: ${plan.totalCost > 0 ? ((plan.totalProfit / plan.totalCost) * 100).toFixed(1) : 0}%`);
                const text = lines.join('\n');
                navigator.clipboard.writeText(text).then(() => {
                    copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
                    copyBtn.style.borderColor = 'var(--profit-green)';
                    copyBtn.style.color = 'var(--profit-green)';
                    setTimeout(() => {
                        copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Shopping List`;
                        copyBtn.style.borderColor = '';
                        copyBtn.style.color = '';
                    }, 2000);
                }).catch(() => {
                    // Fallback for non-HTTPS or older browsers
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    copyBtn.textContent = '✓ Copied!';
                    setTimeout(() => { copyBtn.textContent = '📋 Copy Shopping List'; }, 2000);
                });
            });

            // Per-item refresh buttons
            detailDiv.querySelectorAll('.btn-haul-refresh').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const itemId = btn.dataset.item;
                    btn.disabled = true;
                    btn.innerHTML = '<div class="spinner" style="width:10px;height:10px;border-width:2px;margin:0;"></div>';
                    try {
                        const data = await fetchMarketChunk(getServer(), [itemId]);
                        if (data.length > 0) await MarketDB.saveMarketData(data);
                        trackContribution(1);
                        await updateDbStatus();
                        // Re-render transport with fresh prices
                        if (lastTransportRoutes) {
                            const b = parseInt(document.getElementById('transport-budget').value) || 500000;
                            const s = document.getElementById('transport-sort').value;
                            const { mountCapacity: mc, freeSlots: fs } = getTransportMountConfig();
                            await enrichAndRenderTransport(lastTransportRoutes, b, s, mc, fs);
                        }
                    } catch (err) { console.error('Refresh failed:', err); }
                    btn.disabled = false;
                });
            });

            // Refresh All button for entire haul plan
            const refreshAllBtn = detailDiv.querySelector('.btn-haul-refresh-all');
            refreshAllBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const itemIds = plan.items.map(i => i.itemId);
                refreshAllBtn.disabled = true;
                refreshAllBtn.innerHTML = '<div class="spinner" style="width:10px;height:10px;border-width:2px;margin:0;"></div> Refreshing...';
                try {
                    const data = await fetchMarketChunk(getServer(), itemIds);
                    if (data.length > 0) await MarketDB.saveMarketData(data);
                    trackContribution(itemIds.length);
                    await updateDbStatus();
                    if (lastTransportRoutes) {
                        const b = parseInt(document.getElementById('transport-budget').value) || 500000;
                        const s = document.getElementById('transport-sort').value;
                        const { mountCapacity: mc, freeSlots: fs } = getTransportMountConfig();
                        await enrichAndRenderTransport(lastTransportRoutes, b, s, mc, fs);
                    }
                } catch (err) { console.error('Refresh all failed:', err); }
                refreshAllBtn.disabled = false;
            });

            // Toggle expand/collapse
            summaryDiv.addEventListener('click', () => {
                const isOpen = detailDiv.style.display !== 'none';
                detailDiv.style.display = isOpen ? 'none' : 'block';
                const arrow = summaryDiv.querySelector('.haul-expand-arrow');
                if (arrow) arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
                planCard.classList.toggle('expanded', !isOpen);
                // Remember expanded state across re-renders
                if (!isOpen) expandedHaulPlans.add(plan.routeKey);
                else expandedHaulPlans.delete(plan.routeKey);
            });

            // Restore expanded state from previous render
            if (expandedHaulPlans.has(plan.routeKey)) {
                detailDiv.style.display = 'block';
                const arrow = summaryDiv.querySelector('.haul-expand-arrow');
                if (arrow) arrow.style.transform = 'rotate(180deg)';
                planCard.classList.add('expanded');
            }

            planCard.appendChild(summaryDiv);
            planCard.appendChild(detailDiv);
            planSection.appendChild(planCard);
        });

        container.appendChild(planSection);
    }

    // === INDIVIDUAL ROUTES SECTION (items NOT in haul plans) ===
    if (routes.length > 0) {
        const routeSection = document.createElement('div');
        routeSection.style.marginTop = '2rem';
        const countBar = document.createElement('div');
        countBar.className = 'result-count-bar';
        countBar.innerHTML = `<strong>${routes.length}</strong> more individual items (not in haul plans above)`;
        routeSection.appendChild(countBar);

        const grid = document.createElement('div');
        grid.className = 'transport-results-grid';

        routes.forEach(r => {
            const limitLabel = r.limitingFactor === 'volume' ? '<span title="Limited by daily sell volume" style="color:#f59e0b;">📊 Vol-capped</span>'
                : r.limitingFactor === 'weight' ? '<span title="Limited by mount carry weight" style="color:#ef4444;">⚖️ Weight-capped</span>'
                : r.limitingFactor === 'slots' ? `<span title="Limited by ${availableSlots} free inventory slots" style="color:#8b5cf6;">🎒 Slot-capped</span>`
                : '<span title="Budget is the limiting factor" style="color:var(--accent);">💰 Budget-limited</span>';

            const weightLabel = r.stackable ? `${r.itemWeight.toFixed(2)} kg/ea` : `${r.itemWeight.toFixed(1)} kg`;
            const slotsInfo = r.stackable ? `${r.slotsUsed} slots (x${r.stackSize}/stack)` : `${r.unitsCanCarry} slots`;
            const totalWeightStr = r.totalWeight > 0 ? `${r.totalWeight.toFixed(1)} kg total` : '—';

            const card = document.createElement('div');
            card.className = 'transport-card';
            card.innerHTML = `
                <div class="transport-card-header">
                    <div style="position:relative; display:flex;">
                        <img class="item-icon" src="https://render.albiononline.com/v1/item/${r.itemId}.png" alt="" loading="lazy">
                        ${getEnchantmentBadge(r.itemId)}
                    </div>
                    <div class="header-titles">
                        <div class="item-name">${esc(getFriendlyName(r.itemId))}</div>
                        <span class="item-quality">${getQualityName(r.quality)} ${getTierEnchLabel(r.itemId)}</span>
                    </div>
                    <div style="display:flex; gap:0.3rem; align-items:center; flex-wrap:wrap;">
                        ${r.confidence !== null ? getConfidenceBadge(r.confidence) : ''}
                        ${getVolatilityBadge(r.consistencyPct)}
                    </div>
                </div>
                <div class="transport-route-bar">
                    <span class="city-tag">${esc(r.buyCity)}</span>
                    <span>➔</span>
                    <span class="city-tag">${esc(r.sellCity)}</span>
                    <span style="margin-left:auto; font-size:0.7rem; color:var(--text-muted);">
                        ${getFreshnessIndicator(r.dateBuy)} Buy: ${timeAgo(r.dateBuy)} &nbsp;
                        ${getFreshnessIndicator(r.dateSell)} Sell: ${timeAgo(r.dateSell)}
                    </span>
                </div>
                <div class="transport-stats-row">
                    <div class="transport-stat">
                        <div class="transport-stat-label">Buy Price</div>
                        <div class="transport-stat-value">${Math.floor(r.buyPrice).toLocaleString()}</div>
                    </div>
                    <div class="transport-stat">
                        <div class="transport-stat-label">Sell Price</div>
                        <div class="transport-stat-value">${Math.floor(r.sellPrice).toLocaleString()}</div>
                    </div>
                    <div class="transport-stat">
                        <div class="transport-stat-label">Profit/Unit</div>
                        <div class="transport-stat-value profit">+${Math.floor(r.profitPerUnit).toLocaleString()}</div>
                    </div>
                    <div class="transport-stat">
                        <div class="transport-stat-label">ROI</div>
                        <div class="transport-stat-value ${r.roi >= 10 ? 'profit' : 'accent'}">${r.roi.toFixed(1)}%</div>
                    </div>
                    <div class="transport-stat">
                        <div class="transport-stat-label">Carry Qty</div>
                        <div class="transport-stat-value">${r.unitsCanCarry.toLocaleString()}</div>
                    </div>
                    <div class="transport-stat">
                        <div class="transport-stat-label">Slots</div>
                        <div class="transport-stat-value">${slotsInfo}</div>
                    </div>
                </div>
                <div class="transport-trip-summary">
                    <div>
                        <div class="transport-trip-label">Est. Trip Profit</div>
                        <div class="transport-trip-value">+${Math.floor(r.tripProfit).toLocaleString()} silver</div>
                    </div>
                    <div style="text-align:center;">
                        <div class="transport-trip-label">Limiting Factor</div>
                        <div style="font-size:0.8rem; margin-top:2px;">${limitLabel}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="transport-trip-label">Silver Used</div>
                        <div style="font-size:0.85rem; font-weight:600; color:var(--text-secondary);">${r.silverUsed.toLocaleString()} / ${budget.toLocaleString()}</div>
                    </div>
                </div>
                <div class="item-card-actions" style="margin-top:0.75rem;">
                    <button class="btn-card-action" data-action="compare" data-item="${r.itemId}" title="Compare prices">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
                        Compare
                    </button>
                    <button class="btn-card-action" data-action="refresh" data-item="${r.itemId}" title="Refresh prices">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        Refresh
                    </button>
                    <button class="btn-card-action" data-action="graph" data-item="${r.itemId}" title="Price history">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline></svg>
                        Graph
                    </button>
                </div>
            `;
            grid.appendChild(card);
        });

        routeSection.appendChild(grid);
        container.appendChild(routeSection);
    }
    setupCardButtons(container);
}

// ====== CONTRIBUTION TRACKING ======
function trackContribution(itemCount) {
    if (!discordUser) return; // Only track for logged-in users
    fetch(`${VPS_BASE}/api/contributions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ source: 'web_refresh', item_count: itemCount })
    }).catch(() => {}); // Fire-and-forget
}

// ====== COMMUNITY TAB ======
const TIER_THRESHOLDS = { bronze: 0, silver: 50, gold: 200, diamond: 500 };
const TIER_ORDER = ['bronze', 'silver', 'gold', 'diamond'];

function getTierProgress(tier, scans30d) {
    const idx = TIER_ORDER.indexOf(tier);
    if (idx >= TIER_ORDER.length - 1) return { pct: 100, nextTier: null, nextThreshold: null };
    const nextTier = TIER_ORDER[idx + 1];
    const currentThreshold = TIER_THRESHOLDS[tier];
    const nextThreshold = TIER_THRESHOLDS[nextTier];
    const pct = Math.min(100, Math.round(((scans30d - currentThreshold) / (nextThreshold - currentThreshold)) * 100));
    return { pct, nextTier, nextThreshold };
}

async function loadCommunityTab() {
    // Load my stats if logged in
    if (discordUser) {
        try {
            const res = await fetch(`${VPS_BASE}/api/my-stats`, { headers: authHeaders() });
            if (res.ok) {
                const stats = await res.json();
                const card = document.getElementById('community-my-stats');
                card.style.display = 'block';
                document.getElementById('community-my-avatar').src = `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`;
                document.getElementById('community-my-name').textContent = discordUser.username;

                const tier = stats.tier || 'bronze';
                const tierBadge = document.getElementById('community-my-tier');
                tierBadge.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
                tierBadge.className = `tier-badge tier-${tier}`;

                document.getElementById('community-my-rank').textContent = stats.rank || '—';
                document.getElementById('community-my-scans30d').textContent = (stats.scans_30d || 0).toLocaleString();
                document.getElementById('community-my-scans-total').textContent = (stats.scans_total || 0).toLocaleString();

                // Tier progress bar
                const progress = getTierProgress(tier, stats.scans_30d || 0);
                document.getElementById('tier-current-label').textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
                if (progress.nextTier) {
                    document.getElementById('tier-next-label').textContent = `→ ${progress.nextTier.charAt(0).toUpperCase() + progress.nextTier.slice(1)} (${progress.nextThreshold} scans)`;
                } else {
                    document.getElementById('tier-next-label').textContent = 'Max tier reached!';
                }
                document.getElementById('tier-progress-fill').style.width = progress.pct + '%';
            }
        } catch (e) {
            console.log('Failed to load my stats:', e);
        }
    }

    // Load leaderboard
    try {
        const res = await fetch(`${VPS_BASE}/api/leaderboard`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const lb = await res.json();
        const listEl = document.getElementById('leaderboard-list');
        const emptyEl = document.getElementById('leaderboard-empty');

        if (!lb || lb.length === 0) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';

        listEl.innerHTML = lb.map((u, i) => {
            const rank = i + 1;
            const rankClass = rank <= 3 ? `top-${rank}` : '';
            const tier = /^[a-z]+$/.test(u.tier || '') ? u.tier : 'bronze';
            const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
            const avatarUrl = u.avatar
                ? `https://cdn.discordapp.com/avatars/${u.user_id}/${u.avatar}.png?size=64`
                : 'https://cdn.discordapp.com/embed/avatars/0.png';
            const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;

            return `
                <div class="leaderboard-row">
                    <div class="leaderboard-rank ${rankClass}">${medal}</div>
                    <img class="leaderboard-avatar" src="${avatarUrl}" alt="">
                    <div class="leaderboard-name">
                        ${esc(u.username) || 'Unknown'}
                        <span class="tier-badge tier-${tier}">${tierLabel}</span>
                    </div>
                    <div class="leaderboard-scans">${(u.scans_30d || 0).toLocaleString()} scans</div>
                </div>`;
        }).join('');
    } catch (e) {
        console.log('Failed to load leaderboard:', e);
    }
}

// ============================================================
// ITEM POWER CHECKER
// ============================================================
const BASE_ITEM_POWER = { 4: 700, 5: 800, 6: 900, 7: 1000, 8: 1100 };
const IP_PER_ENCHANT = 100;

function getItemPower(itemId) {
    const tier = parseInt(extractTier(itemId)) || 0;
    const ench = parseInt(extractEnchantment(itemId)) || 0;
    const base = BASE_ITEM_POWER[tier];
    if (!base) return 0;
    return base + (ench * IP_PER_ENCHANT);
}

async function doItemPowerScan() {
    if (itemsList.length === 0) await loadData();

    const spinner = document.getElementById('ip-spinner');
    const errorEl = document.getElementById('ip-error');
    const container = document.getElementById('ip-results');

    const category = document.getElementById('ip-category').value;
    const tierFilter = document.getElementById('ip-tier').value;
    const city = document.getElementById('ip-city').value;
    const sortBy = document.getElementById('ip-sort').value;

    if (errorEl) hideError(errorEl);
    container.innerHTML = '';
    if (spinner) spinner.classList.remove('hidden');

    try {
        const cachedData = await MarketDB.getAllPrices();
        if (spinner) spinner.classList.add('hidden');

        if (cachedData.length === 0) {
            if (errorEl) showError(errorEl, 'No cached data available yet. Data loads automatically — please wait a moment and try again.');
            return;
        }

        // Build price map: item_id -> { city -> sell_price_min }
        const priceMap = {};
        for (const p of cachedData) {
            if (!priceMap[p.item_id]) priceMap[p.item_id] = {};
            if (p.sell_price_min > 0) {
                if (!priceMap[p.item_id][p.city] || p.sell_price_min < priceMap[p.item_id][p.city]) {
                    priceMap[p.item_id][p.city] = p.sell_price_min;
                }
            }
        }

        // Get unique item IDs from cached data that have IP
        const seenItems = new Set();
        const results = [];

        for (const itemId of Object.keys(priceMap)) {
            if (seenItems.has(itemId)) continue;
            seenItems.add(itemId);

            const ip = getItemPower(itemId);
            if (ip === 0) continue;

            // Filter by category
            if (category !== 'all') {
                const cat = categorizeItem(itemId);
                if (category === 'gear') {
                    if (cat !== 'weapons' && cat !== 'armor' && cat !== 'offhand') continue;
                } else if (cat !== category) {
                    continue;
                }
            }

            // Filter by tier
            if (tierFilter !== 'all') {
                const itemTier = extractTier(itemId);
                if (itemTier !== tierFilter) continue;
            }

            // Get price for selected city
            const cityPrices = priceMap[itemId];
            let price = 0;
            if (city === 'all') {
                // Use cheapest across all cities
                for (const c of Object.values(cityPrices)) {
                    if (c > 0 && (price === 0 || c < price)) price = c;
                }
            } else {
                price = cityPrices[city] || 0;
            }

            if (price <= 0) continue;

            const silverPerIP = price / ip;

            results.push({
                itemId,
                ip,
                price,
                silverPerIP,
                tier: parseInt(extractTier(itemId)) || 0,
                ench: parseInt(extractEnchantment(itemId)) || 0
            });
        }

        // Sort
        if (sortBy === 'silver_per_ip') {
            results.sort((a, b) => a.silverPerIP - b.silverPerIP);
        } else if (sortBy === 'ip_desc') {
            results.sort((a, b) => b.ip - a.ip);
        } else if (sortBy === 'price_asc') {
            results.sort((a, b) => a.price - b.price);
        } else if (sortBy === 'price_desc') {
            results.sort((a, b) => b.price - a.price);
        }

        renderItemPowerResults(results);
    } catch (e) {
        if (spinner) spinner.classList.add('hidden');
        if (errorEl) showError(errorEl, 'Error: ' + e.message);
    }
}

function renderItemPowerResults(results) {
    const container = document.getElementById('ip-results');
    container.innerHTML = '';

    if (results.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No items found matching your filters.</p><p class="hint">Try adjusting the category, tier, or city filters.</p></div>`;
        return;
    }

    const countBar = document.createElement('div');
    countBar.className = 'result-count-bar';
    countBar.innerHTML = `Showing <strong>${results.length}</strong> items sorted by efficiency`;
    container.appendChild(countBar);

    // Calculate silver/IP range for color coding
    const sipValues = results.map(r => r.silverPerIP).filter(v => v > 0);
    const sipMin = Math.min(...sipValues);
    const sipMax = Math.max(...sipValues);

    const table = document.createElement('div');
    table.style.overflowX = 'auto';
    table.innerHTML = `
        <table class="compare-table" style="width:100%;">
            <thead>
                <tr>
                    <th style="width:64px;"></th>
                    <th>Item</th>
                    <th>Tier</th>
                    <th>IP</th>
                    <th>Price</th>
                    <th>Silver/IP</th>
                </tr>
            </thead>
            <tbody>
                ${results.map(r => {
                    // Color code: green = good value (low silver/IP), red = bad value
                    const ratio = sipMax > sipMin ? (r.silverPerIP - sipMin) / (sipMax - sipMin) : 0;
                    let sipColor;
                    if (ratio < 0.33) sipColor = '#22c55e'; // green - good value
                    else if (ratio < 0.66) sipColor = '#eab308'; // yellow - mid value
                    else sipColor = '#ef4444'; // red - expensive per IP

                    return `
                        <tr class="ip-result-row" data-item-id="${r.itemId}" style="cursor:pointer;" title="Click to view in City Comparison">
                            <td style="padding:0.25rem;"><img src="https://render.albiononline.com/v1/item/${r.itemId}.png" style="width:48px;height:48px;" loading="lazy"></td>
                            <td><strong>${esc(getFriendlyName(r.itemId))}</strong><br><span style="font-size:0.7rem;color:var(--text-muted);">${esc(r.itemId)}</span></td>
                            <td>${getTierEnchLabel(r.itemId)}</td>
                            <td><strong>${r.ip}</strong></td>
                            <td>${Math.floor(r.price).toLocaleString()}</td>
                            <td style="color:${sipColor};font-weight:bold;">${r.silverPerIP.toFixed(1)}</td>
                        </tr>`;
                }).join('')}
            </tbody>
        </table>`;
    container.appendChild(table);

    // Make rows clickable to switch to City Comparison tab
    table.querySelectorAll('.ip-result-row').forEach(row => {
        row.addEventListener('click', () => {
            const itemId = row.dataset.itemId;
            switchToCompare(itemId);
        });
    });
}

// ============================================================
// FAVORITES SYSTEM
// ============================================================
const FAV_STORAGE_KEY = 'albion_favorites';
let favCurrentItems = [];
let favSearchExactId = null;

function loadFavoriteLists() {
    const select = document.getElementById('fav-list-select');
    if (!select) return;

    const lists = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '{}');
    select.innerHTML = '<option value="">-- Select a list --</option>';

    const names = Object.keys(lists).sort();
    names.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `${name} (${lists[name].items.length} items)`;
        select.appendChild(opt);
    });
}

function saveFavoriteList() {
    const nameInput = document.getElementById('fav-list-name');
    const name = nameInput.value.trim();

    if (!name) {
        showToast('Please enter a list name.', 'warn');
        return;
    }
    if (favCurrentItems.length === 0) {
        showToast('Please add at least one item to the list.', 'warn');
        return;
    }

    const lists = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '{}');
    lists[name] = {
        items: [...favCurrentItems],
        created: Date.now()
    };
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(lists));

    loadFavoriteLists();

    // Select the saved list in the dropdown
    const select = document.getElementById('fav-list-select');
    if (select) select.value = name;

    // Hide editor
    const editor = document.getElementById('fav-editor');
    if (editor) editor.style.display = 'none';
}

function deleteFavoriteList() {
    const select = document.getElementById('fav-list-select');
    const name = select ? select.value : '';

    if (!name) {
        showToast('Please select a list to delete.', 'warn');
        return;
    }

    if (!confirm(`Delete the list "${name}"?`)) return;

    const lists = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '{}');
    delete lists[name];
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(lists));

    loadFavoriteLists();

    // Clear results
    const container = document.getElementById('fav-results');
    if (container) container.innerHTML = '';
}

function addFavoriteItem(itemId) {
    if (favCurrentItems.includes(itemId)) return; // no duplicates
    favCurrentItems.push(itemId);
    renderFavoriteChips();

    // Clear the search input
    const input = document.getElementById('fav-item-search');
    if (input) input.value = '';
}

function removeFavoriteItem(itemId) {
    favCurrentItems = favCurrentItems.filter(id => id !== itemId);
    renderFavoriteChips();
}

function renderFavoriteChips() {
    const chipContainer = document.getElementById('fav-items-list');
    if (!chipContainer) return;

    chipContainer.innerHTML = favCurrentItems.map(id => `
        <span class="fav-chip" style="display:inline-flex;align-items:center;gap:0.25rem;background:var(--surface-2);padding:0.25rem 0.5rem;border-radius:0.5rem;margin:0.125rem;font-size:0.8rem;">
            <img src="https://render.albiononline.com/v1/item/${id}.png" style="width:20px;height:20px;" loading="lazy">
            ${esc(getFriendlyName(id))}
            <button onclick="removeFavoriteItem('${id}')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0 0.25rem;font-size:1rem;line-height:1;">&times;</button>
        </span>
    `).join('');
}

async function loadFavoriteListPrices() {
    const select = document.getElementById('fav-list-select');
    const name = select ? select.value : '';
    const container = document.getElementById('fav-results');
    const spinner = document.getElementById('fav-spinner');
    const errorEl = document.getElementById('fav-error');

    if (!name) {
        if (errorEl) showError(errorEl, 'Please select a list first.');
        return;
    }

    const lists = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '{}');
    const list = lists[name];
    if (!list || list.items.length === 0) {
        if (errorEl) showError(errorEl, 'Selected list is empty.');
        return;
    }

    if (errorEl) hideError(errorEl);
    if (container) container.innerHTML = '';
    if (spinner) spinner.classList.remove('hidden');

    try {
        const server = getServer();
        const priceData = await fetchMarketData(server, list.items);
        if (spinner) spinner.classList.add('hidden');

        // Build price map: item_id -> { city -> sell_price_min }
        const priceMap = {};
        for (const p of priceData) {
            if (!priceMap[p.item_id]) priceMap[p.item_id] = {};
            if (p.sell_price_min > 0) {
                if (!priceMap[p.item_id][p.city] || p.sell_price_min < priceMap[p.item_id][p.city]) {
                    priceMap[p.item_id][p.city] = p.sell_price_min;
                }
            }
        }

        renderFavoritePrices(list.items, priceMap);
    } catch (e) {
        if (spinner) spinner.classList.add('hidden');
        if (errorEl) showError(errorEl, 'Error fetching prices: ' + e.message);
    }
}

function renderFavoritePrices(items, priceMap) {
    const container = document.getElementById('fav-results');
    if (!container) return;
    container.innerHTML = '';

    if (items.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No items in this list.</p></div>`;
        return;
    }

    const countBar = document.createElement('div');
    countBar.className = 'result-count-bar';
    countBar.innerHTML = `Showing prices for <strong>${items.length}</strong> items`;
    container.appendChild(countBar);

    const cities = CITIES.filter(c => c !== 'Black Market');

    const table = document.createElement('div');
    table.style.overflowX = 'auto';
    table.innerHTML = `
        <table class="compare-table" style="width:100%;">
            <thead>
                <tr>
                    <th style="width:48px;"></th>
                    <th>Item</th>
                    ${cities.map(c => `<th>${c}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
                ${items.map(itemId => {
                    const cityPrices = priceMap[itemId] || {};
                    const prices = cities.map(c => cityPrices[c] || 0);
                    const validPrices = prices.filter(p => p > 0);
                    const minPrice = validPrices.length > 0 ? Math.min(...validPrices) : 0;
                    const maxPrice = validPrices.length > 0 ? Math.max(...validPrices) : 0;

                    return `
                        <tr>
                            <td style="padding:0.25rem;"><img src="https://render.albiononline.com/v1/item/${itemId}.png" style="width:40px;height:40px;" loading="lazy"></td>
                            <td><strong>${esc(getFriendlyName(itemId))}</strong><br><span style="font-size:0.65rem;color:var(--text-muted);">${getTierEnchLabel(itemId)}</span></td>
                            ${cities.map((c, i) => {
                                const p = prices[i];
                                if (p <= 0) return '<td style="color:var(--text-muted);">—</td>';
                                let color = 'inherit';
                                if (validPrices.length > 1) {
                                    if (p === minPrice) color = '#22c55e';
                                    else if (p === maxPrice) color = '#ef4444';
                                }
                                return `<td style="color:${color};font-weight:${p === minPrice ? 'bold' : 'normal'};">${Math.floor(p).toLocaleString()}</td>`;
                            }).join('')}
                        </tr>`;
                }).join('')}
            </tbody>
        </table>`;
    container.appendChild(table);
}

// ============================================================
// MOUNTS DATABASE
// ============================================================
function classifyMount(itemId) {
    const id = itemId.toUpperCase();
    if (id.includes('MULE') || id.includes('OX') || id.includes('MAMMOTH_TRANSPORT') || id.includes('TRANSPORT')) {
        return 'transport';
    }
    if (id.includes('BATTLE') || id.includes('SIEGE') || id.includes('COMMAND_MAMMOTH') || id.includes('MOOSE_BATTLE')) {
        return 'battle';
    }
    return 'riding';
}

function getMountTypeLabel(type) {
    const labels = { riding: 'Riding', transport: 'Transport', battle: 'Battle' };
    return labels[type] || 'Other';
}

async function loadMountsDatabase() {
    if (itemsList.length === 0) await loadData();

    const spinner = document.getElementById('mount-spinner');
    const errorEl = document.getElementById('mount-error');
    const container = document.getElementById('mount-results');
    const city = document.getElementById('mount-city') ? document.getElementById('mount-city').value : 'Caerleon';
    const searchVal = document.getElementById('mount-search') ? document.getElementById('mount-search').value.toLowerCase().trim() : '';
    const typeFilter = document.getElementById('mount-type') ? document.getElementById('mount-type').value : 'all';
    const sortBy = document.getElementById('mount-sort') ? document.getElementById('mount-sort').value : 'price_asc';

    if (errorEl) hideError(errorEl);
    if (container) container.innerHTML = '';
    if (spinner) spinner.classList.remove('hidden');

    try {
        // Filter items that contain MOUNT in the ID
        const mountItems = itemsList.filter(id => id.toUpperCase().includes('MOUNT'));

        if (mountItems.length === 0) {
            if (spinner) spinner.classList.add('hidden');
            if (container) container.innerHTML = `<div class="empty-state"><p>No mount items found in the database.</p></div>`;
            return;
        }

        // Fetch live prices for mount items
        const server = getServer();
        const priceData = await fetchMarketData(server, mountItems);
        if (spinner) spinner.classList.add('hidden');

        // Build price map for selected city
        const priceMap = {};
        for (const p of priceData) {
            if (p.city === city && p.sell_price_min > 0) {
                if (!priceMap[p.item_id] || p.sell_price_min < priceMap[p.item_id]) {
                    priceMap[p.item_id] = p.sell_price_min;
                }
            }
        }

        // Build mount data
        let mounts = mountItems.map(itemId => {
            const tier = parseInt(extractTier(itemId)) || 0;
            const ench = parseInt(extractEnchantment(itemId)) || 0;
            const mountType = classifyMount(itemId);
            const price = priceMap[itemId] || 0;

            return {
                itemId,
                name: getFriendlyName(itemId),
                tier,
                ench,
                tierLabel: getTierEnchLabel(itemId),
                mountType,
                price
            };
        });

        // Filter by search text
        if (searchVal) {
            const words = searchVal.split(' ').filter(w => w);
            mounts = mounts.filter(m => {
                const target = (m.name + ' ' + m.itemId.replace(/_/g, ' ') + ' ' + m.tierLabel).toLowerCase();
                return words.every(w => target.includes(w));
            });
        }

        // Filter by type
        if (typeFilter !== 'all') {
            mounts = mounts.filter(m => m.mountType === typeFilter);
        }

        // Sort
        if (sortBy === 'price_asc') {
            mounts.sort((a, b) => {
                const aP = a.price > 0 ? a.price : Infinity;
                const bP = b.price > 0 ? b.price : Infinity;
                return aP - bP;
            });
        } else if (sortBy === 'price_desc') {
            mounts.sort((a, b) => (b.price || 0) - (a.price || 0));
        } else if (sortBy === 'tier_asc') {
            mounts.sort((a, b) => (a.tier + a.ench * 0.1) - (b.tier + b.ench * 0.1));
        } else if (sortBy === 'tier_desc') {
            mounts.sort((a, b) => (b.tier + b.ench * 0.1) - (a.tier + a.ench * 0.1));
        } else if (sortBy === 'name') {
            mounts.sort((a, b) => a.name.localeCompare(b.name));
        }

        renderMountsDatabase(mounts, city);
    } catch (e) {
        if (spinner) spinner.classList.add('hidden');
        if (errorEl) showError(errorEl, 'Error: ' + e.message);
    }
}

function renderMountsDatabase(mounts, city) {
    const container = document.getElementById('mount-results');
    if (!container) return;
    container.innerHTML = '';

    if (mounts.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No mounts found matching your filters.</p><p class="hint">Try adjusting the search, type, or city filters.</p></div>`;
        return;
    }

    const countBar = document.createElement('div');
    countBar.className = 'result-count-bar';
    countBar.innerHTML = `Showing <strong>${mounts.length}</strong> mounts in <strong>${city}</strong>`;
    container.appendChild(countBar);

    // Group by type
    const groups = {};
    for (const m of mounts) {
        const type = m.mountType;
        if (!groups[type]) groups[type] = [];
        groups[type].push(m);
    }

    const typeOrder = ['riding', 'transport', 'battle'];

    for (const type of typeOrder) {
        const group = groups[type];
        if (!group || group.length === 0) continue;

        const section = document.createElement('div');
        section.style.marginBottom = '1.5rem';
        section.innerHTML = `
            <h3 style="color:var(--accent);margin:0.75rem 0 0.5rem 0;font-size:1rem;border-bottom:1px solid var(--border);padding-bottom:0.25rem;">
                ${getMountTypeLabel(type)} Mounts (${group.length})
            </h3>
            <div style="overflow-x:auto;">
                <table class="compare-table" style="width:100%;">
                    <thead>
                        <tr>
                            <th style="width:64px;"></th>
                            <th>Mount</th>
                            <th>Tier</th>
                            <th>Type</th>
                            <th>Price (${city})</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${group.map(m => `
                            <tr style="cursor:pointer;" class="mount-row" data-item-id="${m.itemId}" title="Click to view in City Comparison">
                                <td style="padding:0.25rem;"><img src="https://render.albiononline.com/v1/item/${m.itemId}.png" style="width:48px;height:48px;" loading="lazy"></td>
                                <td><strong>${m.name}</strong><br><span style="font-size:0.65rem;color:var(--text-muted);">${m.itemId}</span></td>
                                <td>${m.tierLabel}</td>
                                <td><span style="text-transform:capitalize;">${m.mountType}</span></td>
                                <td>${m.price > 0 ? `<strong>${Math.floor(m.price).toLocaleString()}</strong> silver` : '<span style="color:var(--text-muted);">No data</span>'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
        container.appendChild(section);

        // Make rows clickable
        section.querySelectorAll('.mount-row').forEach(row => {
            row.addEventListener('click', () => {
                switchToCompare(row.dataset.itemId);
            });
        });
    }
}

// ============================================================
// TOP TRADED ITEMS
// ============================================================
async function loadTopTraded() {
    const spinner = document.getElementById('top-spinner');
    const container = document.getElementById('top-results');
    const city = document.getElementById('top-city').value;
    const tier = document.getElementById('top-tier').value;
    const category = document.getElementById('top-category').value;
    const limit = parseInt(document.getElementById('top-limit').value) || 50;

    container.innerHTML = '';
    spinner.classList.remove('hidden');

    try {
        // Use cached prices from IndexedDB
        const cachedData = await MarketDB.getAllPrices();

        // Build volume data from our price cache
        // Group by item_id, sum up volumes per city
        const itemVolumes = {};
        for (const entry of cachedData) {
            if (tier !== 'all' && !entry.item_id.startsWith('T' + tier)) continue;
            if (category !== 'all' && categorizeItem(entry.item_id) !== category &&
                !(category === 'materials' && categorizeItem(entry.item_id) === 'resources')) continue;

            let entryCity = entry.city;
            if (entryCity && entryCity.includes('Black Market')) entryCity = 'Black Market';
            if (city !== 'all' && entryCity !== city) continue;

            // Use sell_price_min as indicator of active item
            if (entry.sell_price_min <= 0 && entry.buy_price_max <= 0) continue;

            if (!itemVolumes[entry.item_id]) {
                itemVolumes[entry.item_id] = {
                    totalValue: 0,
                    cityCount: 0,
                    avgPrice: 0,
                    prices: [],
                    cities: new Set()
                };
            }

            const vol = itemVolumes[entry.item_id];
            if (entry.sell_price_min > 0) {
                vol.prices.push(entry.sell_price_min);
                vol.totalValue += entry.sell_price_min;
                vol.cities.add(entryCity);
            }
        }

        // Now fetch Charts API for actual volume data for top items
        // Get items that appear in most cities (proxy for most traded)
        let ranked = Object.entries(itemVolumes)
            .map(([id, vol]) => ({
                itemId: id,
                cityCount: vol.cities.size,
                avgPrice: vol.prices.length > 0 ? Math.floor(vol.prices.reduce((a,b)=>a+b,0) / vol.prices.length) : 0,
                cities: [...vol.cities]
            }))
            .filter(r => r.avgPrice > 0)
            .sort((a, b) => b.cityCount - a.cityCount || b.avgPrice - a.avgPrice);

        // Take top items and fetch their chart data for actual daily volumes
        const topItems = ranked.slice(0, Math.min(limit * 2, 200));

        if (topItems.length > 0) {
            const server = getServer();
            const chartBase = CHART_API_URLS[server];
            // Fetch in chunks
            let chartData = [];
            for (let i = 0; i < topItems.length; i += API_CHUNK_SIZE) {
                const chunk = topItems.slice(i, i + API_CHUNK_SIZE);
                const ids = chunk.map(t => t.itemId).join(',');
                const loc = city !== 'all' ? city : 'Caerleon,Bridgewatch,Fort Sterling,Lymhurst,Martlock,Thetford';
                try {
                    const res = await fetch(`${chartBase}/${ids}.json?locations=${loc}&date=${new Date(Date.now() - 7*86400000).toISOString().split('T')[0]}&end_date=${new Date().toISOString().split('T')[0]}`);
                    if (res.ok) {
                        const data = await res.json();
                        chartData = chartData.concat(data);
                    }
                } catch(e) { /* continue */ }
            }

            // Aggregate daily volumes
            const volumeMap = {};
            for (const entry of chartData) {
                const id = entry.item_id;
                if (!volumeMap[id]) volumeMap[id] = 0;
                if (entry.data && entry.data.item_count) {
                    const counts = entry.data.item_count;
                    volumeMap[id] += counts.reduce((a,b) => a + b, 0);
                }
            }

            // Merge volume data and re-sort
            for (const item of topItems) {
                item.volume = volumeMap[item.itemId] || 0;
            }
            topItems.sort((a, b) => b.volume - a.volume);
        }

        spinner.classList.add('hidden');
        renderTopTraded(topItems.slice(0, limit));
    } catch (e) {
        spinner.classList.add('hidden');
        container.innerHTML = `<div class="empty-state"><p>Failed to load top items: ${e.message}</p></div>`;
    }
}

function renderTopTraded(items) {
    const container = document.getElementById('top-results');
    container.innerHTML = '';

    if (items.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No trading data available. Make sure market data is loaded.</p></div>`;
        return;
    }

    const header = document.createElement('div');
    header.className = 'result-count-bar';
    header.innerHTML = `Showing top <strong>${items.length}</strong> most traded items`;
    container.appendChild(header);

    let tableHTML = `<div class="table-scroll-wrapper"><table class="compare-table">
        <thead><tr>
            <th>#</th><th>Item</th><th>Tier</th><th>Avg Price</th><th>7-Day Volume</th><th>Cities Listed</th>
        </tr></thead><tbody>`;

    items.forEach((item, i) => {
        const name = getFriendlyName(item.itemId);
        const tierLabel = getTierEnchLabel(item.itemId);
        const enchBadge = getEnchantmentBadge(item.itemId);
        tableHTML += `<tr style="cursor:pointer;" onclick="switchToCompare('${item.itemId}')">
            <td style="font-weight:700; color:var(--accent);">${i + 1}</td>
            <td style="display:flex; align-items:center; gap:0.5rem;">
                <img src="https://render.albiononline.com/v1/item/${item.itemId}.png" width="32" height="32" style="image-rendering:pixelated;" onerror="this.style.display='none'">
                <span>${esc(name)}</span>${enchBadge}
            </td>
            <td>${tierLabel}</td>
            <td>${item.avgPrice > 0 ? item.avgPrice.toLocaleString() : '--'}</td>
            <td style="font-weight:700; color:var(--accent);">${item.volume > 0 ? item.volume.toLocaleString() : '--'}</td>
            <td>${item.cityCount}</td>
        </tr>`;
    });

    tableHTML += `</tbody></table></div>`;
    container.insertAdjacentHTML('beforeend', tableHTML);
}

// ============================================================
// PORTFOLIO TRACKER
// ============================================================
const PORTFOLIO_STORAGE_KEY = 'albion_portfolio';
let portfolioSearchExactId = null;

function getPortfolioTrades() {
    try {
        return JSON.parse(localStorage.getItem(PORTFOLIO_STORAGE_KEY)) || [];
    } catch { return []; }
}

function savePortfolioTrades(trades) {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, JSON.stringify(trades));
}

function addPortfolioTrade() {
    const type = document.getElementById('portfolio-type').value;
    const itemId = portfolioSearchExactId || document.getElementById('portfolio-item-search').value.trim();
    const quantity = parseInt(document.getElementById('portfolio-quantity').value) || 0;
    const price = parseInt(document.getElementById('portfolio-price').value) || 0;
    const city = document.getElementById('portfolio-city').value;

    if (!itemId || quantity <= 0 || price <= 0) {
        showToast('Please fill in all fields.', 'warn');
        return;
    }

    // Resolve item ID
    let resolvedId = portfolioSearchExactId || itemId;
    if (!portfolioSearchExactId) {
        const match = itemsList.find(i => getFriendlyName(i).toLowerCase() === itemId.toLowerCase() || i.toLowerCase() === itemId.toLowerCase());
        if (match) resolvedId = match;
    }

    const trade = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type,
        itemId: resolvedId,
        quantity,
        price,
        city,
        timestamp: new Date().toISOString()
    };

    const trades = getPortfolioTrades();
    trades.push(trade);
    savePortfolioTrades(trades);

    // Reset form
    document.getElementById('portfolio-form').style.display = 'none';
    portfolioSearchExactId = null;
    document.getElementById('portfolio-item-search').value = '';
    document.getElementById('portfolio-quantity').value = '1';
    document.getElementById('portfolio-price').value = '0';

    renderPortfolio();
}

function deletePortfolioTrade(tradeId) {
    const trades = getPortfolioTrades().filter(t => t.id !== tradeId);
    savePortfolioTrades(trades);
    renderPortfolio();
}

function clearPortfolio() {
    if (!confirm('Delete all portfolio trades? This cannot be undone.')) return;
    localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
    renderPortfolio();
}

function exportPortfolioCSV() {
    const trades = getPortfolioTrades();
    if (trades.length === 0) { showToast('No trades to export.', 'warn'); return; }

    const header = 'Type,Item,Quantity,Price,Total,City,Date\n';
    const rows = trades.map(t => {
        const name = getFriendlyName(t.itemId);
        const total = t.quantity * t.price;
        const date = new Date(t.timestamp).toLocaleDateString();
        return `${t.type},${name},${t.quantity},${t.price},${total},${t.city},${date}`;
    }).join('\n');

    const blob = new Blob([header + rows], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `albion_portfolio_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
}

function renderPortfolio() {
    const trades = getPortfolioTrades();
    const summaryEl = document.getElementById('portfolio-summary');
    const tradesEl = document.getElementById('portfolio-trades');

    // Calculate summary by item using FIFO
    const itemStats = {};
    for (const trade of trades) {
        if (!itemStats[trade.itemId]) {
            itemStats[trade.itemId] = { buys: [], sells: [], totalBought: 0, totalSold: 0, totalSpent: 0, totalEarned: 0, realizedPL: 0 };
        }
        const stat = itemStats[trade.itemId];
        if (trade.type === 'buy') {
            stat.buys.push({ qty: trade.quantity, price: trade.price, remaining: trade.quantity });
            stat.totalBought += trade.quantity;
            stat.totalSpent += trade.quantity * trade.price;
        } else {
            stat.totalSold += trade.quantity;
            stat.totalEarned += trade.quantity * trade.price;

            // FIFO matching
            let sellQty = trade.quantity;
            for (const buy of stat.buys) {
                if (sellQty <= 0) break;
                if (buy.remaining <= 0) continue;
                const matched = Math.min(sellQty, buy.remaining);
                stat.realizedPL += matched * (trade.price - buy.price);
                buy.remaining -= matched;
                sellQty -= matched;
            }
        }
    }

    // Summary cards
    let totalPL = 0;
    let totalInvested = 0;
    for (const stat of Object.values(itemStats)) {
        totalPL += stat.realizedPL;
        totalInvested += stat.totalSpent;
    }
    const taxEstimate = Object.values(itemStats).reduce((sum, s) => sum + s.totalEarned * (TAX_RATE + SETUP_FEE), 0);
    const netPL = totalPL - taxEstimate;

    summaryEl.innerHTML = `
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:1rem;">
            <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius); padding:1rem; text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-secondary);">Total Trades</div>
                <div style="font-size:1.5rem; font-weight:800; color:var(--text-primary);">${trades.length}</div>
            </div>
            <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius); padding:1rem; text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-secondary);">Total Invested</div>
                <div style="font-size:1.5rem; font-weight:800; color:var(--text-primary);">${totalInvested.toLocaleString()}</div>
            </div>
            <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius); padding:1rem; text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-secondary);">Realized P/L (pre-tax)</div>
                <div style="font-size:1.5rem; font-weight:800; color:${totalPL >= 0 ? 'var(--profit-green)' : 'var(--loss-red)'};">${totalPL >= 0 ? '+' : ''}${Math.floor(totalPL).toLocaleString()}</div>
            </div>
            <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius); padding:1rem; text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-secondary);">Net P/L (after ${((TAX_RATE+SETUP_FEE)*100).toFixed(1)}% tax+setup)</div>
                <div style="font-size:1.5rem; font-weight:800; color:${netPL >= 0 ? 'var(--profit-green)' : 'var(--loss-red)'};">${netPL >= 0 ? '+' : ''}${Math.floor(netPL).toLocaleString()}</div>
            </div>
        </div>`;

    // Trade history table
    if (trades.length === 0) {
        tradesEl.innerHTML = `<div class="empty-state"><p>No trades logged yet.</p><p class="hint">Click "+ Log Trade" to start tracking your trades.</p></div>`;
        return;
    }

    let tableHTML = `<div class="table-scroll-wrapper"><table class="compare-table">
        <thead><tr>
            <th>Date</th><th>Type</th><th>Item</th><th>Qty</th><th>Price/Unit</th><th>Total</th><th>City</th><th></th>
        </tr></thead><tbody>`;

    // Show most recent first
    [...trades].reverse().forEach(t => {
        const name = getFriendlyName(t.itemId);
        const total = t.quantity * t.price;
        const date = new Date(t.timestamp).toLocaleDateString();
        const typeColor = t.type === 'buy' ? 'var(--loss-red)' : 'var(--profit-green)';
        const typeLabel = t.type === 'buy' ? 'BUY' : 'SELL';
        const safeItemId = encodeURIComponent(t.itemId);
        const safeTradeId = esc(t.id);
        tableHTML += `<tr>
            <td>${date}</td>
            <td><span style="font-weight:700; color:${typeColor};">${typeLabel}</span></td>
            <td style="display:flex; align-items:center; gap:0.5rem;">
                <img src="https://render.albiononline.com/v1/item/${safeItemId}.png" width="24" height="24" style="image-rendering:pixelated;" onerror="this.style.display='none'">
                ${esc(name)}
            </td>
            <td>${t.quantity.toLocaleString()}</td>
            <td>${t.price.toLocaleString()}</td>
            <td style="font-weight:700;">${total.toLocaleString()}</td>
            <td>${esc(t.city)}</td>
            <td><button data-trade-id="${safeTradeId}" class="portfolio-delete-btn" style="background:none; border:none; color:var(--loss-red); cursor:pointer; font-size:1rem;" title="Delete trade">×</button></td>
        </tr>`;
    });

    tableHTML += `</tbody></table></div>`;
    tradesEl.innerHTML = tableHTML;

    // Wire up delete buttons via delegation (avoids inline onclick with user data)
    tradesEl.querySelectorAll('.portfolio-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deletePortfolioTrade(btn.dataset.tradeId));
    });
}

// ============================================================
// FARM & BREED CALCULATOR
// ============================================================
const FARM_DATA = {
    crops: [
        { tier: 1, seed: 'T1_FARM_CARROT_SEED', crop: 'T1_FARM_CARROT', name: 'Carrot', yield: 9, growthHours: 22 },
        { tier: 2, seed: 'T2_FARM_BEAN_SEED', crop: 'T2_FARM_BEAN', name: 'Bean', yield: 9, growthHours: 22 },
        { tier: 3, seed: 'T3_FARM_WHEAT_SEED', crop: 'T3_FARM_WHEAT', name: 'Wheat', yield: 9, growthHours: 22 },
        { tier: 4, seed: 'T4_FARM_TURNIP_SEED', crop: 'T4_FARM_TURNIP', name: 'Turnip', yield: 9, growthHours: 22 },
        { tier: 5, seed: 'T5_FARM_CABBAGE_SEED', crop: 'T5_FARM_CABBAGE', name: 'Cabbage', yield: 9, growthHours: 22 },
        { tier: 6, seed: 'T6_FARM_POTATO_SEED', crop: 'T6_FARM_POTATO', name: 'Potato', yield: 9, growthHours: 22 },
        { tier: 7, seed: 'T7_FARM_CORN_SEED', crop: 'T7_FARM_CORN', name: 'Corn', yield: 9, growthHours: 22 },
        { tier: 8, seed: 'T8_FARM_PUMPKIN_SEED', crop: 'T8_FARM_PUMPKIN', name: 'Pumpkin', yield: 9, growthHours: 22 }
    ],
    herbs: [
        { tier: 2, seed: 'T2_FARM_AGARIC_SEED', crop: 'T2_FARM_AGARIC', name: 'Arcane Agaric', yield: 9, growthHours: 22 },
        { tier: 3, seed: 'T3_FARM_COMFREY_SEED', crop: 'T3_FARM_COMFREY', name: 'Brightleaf Comfrey', yield: 9, growthHours: 22 },
        { tier: 4, seed: 'T4_FARM_BURDOCK_SEED', crop: 'T4_FARM_BURDOCK', name: 'Crenellated Burdock', yield: 9, growthHours: 22 },
        { tier: 5, seed: 'T5_FARM_TEASEL_SEED', crop: 'T5_FARM_TEASEL', name: 'Dragon Teasel', yield: 9, growthHours: 22 },
        { tier: 6, seed: 'T6_FARM_FOXGLOVE_SEED', crop: 'T6_FARM_FOXGLOVE', name: 'Elusive Foxglove', yield: 9, growthHours: 22 },
        { tier: 7, seed: 'T7_FARM_MULLEIN_SEED', crop: 'T7_FARM_MULLEIN', name: 'Firetouched Mullein', yield: 9, growthHours: 22 },
        { tier: 8, seed: 'T8_FARM_YARROW_SEED', crop: 'T8_FARM_YARROW', name: 'Ghoul Yarrow', yield: 9, growthHours: 22 }
    ],
    animals: [
        { tier: 3, baby: 'T3_FARM_OX_BABY', grown: 'T3_FARM_OX_GROWN', name: 'Ox', product: null, growthHours: 44 },
        { tier: 4, baby: 'T4_FARM_OX_BABY', grown: 'T4_FARM_OX_GROWN', name: 'Ox', product: null, growthHours: 44 },
        { tier: 5, baby: 'T5_FARM_OX_BABY', grown: 'T5_FARM_OX_GROWN', name: 'Ox', product: null, growthHours: 44 },
        { tier: 6, baby: 'T6_FARM_OX_BABY', grown: 'T6_FARM_OX_GROWN', name: 'Ox', product: null, growthHours: 44 },
        { tier: 7, baby: 'T7_FARM_OX_BABY', grown: 'T7_FARM_OX_GROWN', name: 'Ox', product: null, growthHours: 44 },
        { tier: 8, baby: 'T8_FARM_OX_BABY', grown: 'T8_FARM_OX_GROWN', name: 'Ox', product: null, growthHours: 44 },
        { tier: 3, baby: 'T3_FARM_HORSE_BABY', grown: 'T3_FARM_HORSE_GROWN', name: 'Horse', product: null, growthHours: 44 },
        { tier: 4, baby: 'T4_FARM_HORSE_BABY', grown: 'T4_FARM_HORSE_GROWN', name: 'Horse', product: null, growthHours: 44 },
        { tier: 5, baby: 'T5_FARM_HORSE_BABY', grown: 'T5_FARM_HORSE_GROWN', name: 'Horse', product: null, growthHours: 44 },
        { tier: 6, baby: 'T6_FARM_HORSE_BABY', grown: 'T6_FARM_HORSE_GROWN', name: 'Horse', product: null, growthHours: 44 },
        { tier: 7, baby: 'T7_FARM_HORSE_BABY', grown: 'T7_FARM_HORSE_GROWN', name: 'Horse', product: null, growthHours: 44 },
        { tier: 8, baby: 'T8_FARM_HORSE_BABY', grown: 'T8_FARM_HORSE_GROWN', name: 'Horse', product: null, growthHours: 44 },
        { tier: 3, baby: 'T3_FARM_HEN_BABY', grown: 'T3_FARM_HEN', name: 'Hen', product: 'T3_FARM_HEN_EGG', growthHours: 22 },
        { tier: 4, baby: 'T4_FARM_GOOSE_BABY', grown: 'T4_FARM_GOOSE', name: 'Goose', product: 'T4_FARM_GOOSE_EGG', growthHours: 44 },
        { tier: 5, baby: 'T5_FARM_GOAT_BABY', grown: 'T5_FARM_GOAT', name: 'Goat', product: 'T5_FARM_GOAT_MILK', growthHours: 44 },
        { tier: 6, baby: 'T6_FARM_SHEEP_BABY', grown: 'T6_FARM_SHEEP', name: 'Sheep', product: 'T6_FARM_SHEEP_MILK', growthHours: 44 },
        { tier: 7, baby: 'T7_FARM_PIG_BABY', grown: 'T7_FARM_PIG', name: 'Pig', product: 'T7_FARM_PIG_MILK', growthHours: 44 },
        { tier: 8, baby: 'T8_FARM_COW_BABY', grown: 'T8_FARM_COW', name: 'Cow', product: 'T8_FARM_COW_MILK', growthHours: 44 }
    ]
};

async function calculateFarming() {
    const farmType = document.getElementById('farm-type').value;
    const city = document.getElementById('farm-city').value;
    const premium = document.getElementById('farm-premium').checked;
    const useFocus = document.getElementById('farm-focus').checked;
    const spinner = document.getElementById('farm-spinner');
    const container = document.getElementById('farm-results');

    container.innerHTML = '';
    spinner.classList.remove('hidden');

    try {
        const items = FARM_DATA[farmType];
        // Collect all item IDs to fetch
        const allIds = [];
        for (const item of items) {
            if (farmType === 'animals') {
                allIds.push(item.baby, item.grown);
                if (item.product) allIds.push(item.product);
            } else {
                allIds.push(item.seed, item.crop);
            }
        }

        // Fetch prices
        const server = getServer();
        let allPrices = [];
        for (let i = 0; i < allIds.length; i += API_CHUNK_SIZE) {
            const chunk = allIds.slice(i, i + API_CHUNK_SIZE);
            const url = `${API_URLS[server]}/${chunk.join(',')}.json?locations=${city}`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                allPrices = allPrices.concat(data);
            }
        }
        if (allPrices.length > 0) await MarketDB.saveMarketData(allPrices);

        // Index prices
        const priceIndex = {};
        for (const entry of allPrices) {
            let c = entry.city;
            if (c && c.includes('Black Market')) c = 'Black Market';
            if (c !== city) continue;
            if (!priceIndex[entry.item_id] || (entry.sell_price_min > 0 && entry.sell_price_min < (priceIndex[entry.item_id].sellMin || Infinity))) {
                priceIndex[entry.item_id] = {
                    sellMin: entry.sell_price_min || 0,
                    buyMax: entry.buy_price_max || 0
                };
            }
        }

        spinner.classList.add('hidden');

        // Calculate profits
        const results = [];
        for (const item of items) {
            if (farmType === 'animals') {
                const babyPrice = priceIndex[item.baby] ? priceIndex[item.baby].sellMin : 0;
                const grownPrice = priceIndex[item.grown] ? priceIndex[item.grown].buyMax : 0;
                const productPrice = item.product && priceIndex[item.product] ? priceIndex[item.product].buyMax : 0;

                const cost = babyPrice; // buy baby
                const revenue = grownPrice; // sell grown
                const productRevenue = productPrice; // sell product (if applicable)
                const tax = revenue * TAX_RATE + productRevenue * TAX_RATE;
                const profit = revenue + productRevenue - cost - tax;

                // Premium gives 50% more offspring chance
                const premiumBonus = premium ? 1.5 : 1.0;

                results.push({
                    name: `T${item.tier} ${item.name}`,
                    tier: item.tier,
                    costLabel: 'Baby',
                    costPrice: babyPrice,
                    revenueLabel: 'Grown',
                    revenuePrice: grownPrice,
                    productLabel: item.product ? 'Product' : null,
                    productPrice: productPrice,
                    profit,
                    growthHours: item.growthHours,
                    profitPerHour: item.growthHours > 0 ? profit / item.growthHours : 0,
                    seedId: item.baby,
                    cropId: item.grown
                });
            } else {
                const seedPrice = priceIndex[item.seed] ? priceIndex[item.seed].sellMin : 0;
                const cropPrice = priceIndex[item.crop] ? priceIndex[item.crop].buyMax : 0;

                const yieldAmount = premium ? Math.floor(item.yield * 1.5) : item.yield;
                const seedReturn = premium ? 3 : 2; // seeds returned on harvest

                const cost = seedPrice; // buy 1 seed
                const revenue = cropPrice * yieldAmount;
                const seedSavings = seedPrice * seedReturn; // returned seeds worth
                const tax = revenue * TAX_RATE;
                const profit = revenue + seedSavings - cost - tax;

                results.push({
                    name: `T${item.tier} ${item.name}`,
                    tier: item.tier,
                    costLabel: 'Seed',
                    costPrice: seedPrice,
                    revenueLabel: `Crop (x${yieldAmount})`,
                    revenuePrice: cropPrice * yieldAmount,
                    productLabel: `Seeds back (x${seedReturn})`,
                    productPrice: seedPrice * seedReturn,
                    profit,
                    growthHours: item.growthHours,
                    profitPerHour: item.growthHours > 0 ? profit / item.growthHours : 0,
                    seedId: item.seed,
                    cropId: item.crop
                });
            }
        }

        // Sort by profit descending
        results.sort((a, b) => b.profit - a.profit);
        renderFarmResults(results, farmType);
    } catch (e) {
        spinner.classList.add('hidden');
        container.innerHTML = `<div class="empty-state"><p>Failed to calculate farming profits: ${esc(e.message)}</p></div>`;
    }
}

function renderFarmResults(results, farmType) {
    const container = document.getElementById('farm-results');
    container.innerHTML = '';

    if (results.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No farming data available.</p></div>`;
        return;
    }

    const header = document.createElement('div');
    header.className = 'result-count-bar';
    header.innerHTML = `Showing <strong>${results.length}</strong> ${farmType} profit calculations`;
    container.appendChild(header);

    let tableHTML = `<div class="table-scroll-wrapper"><table class="compare-table">
        <thead><tr>
            <th>Item</th><th>Cost (Buy)</th><th>Revenue (Sell)</th>
            ${results.some(r => r.productLabel) ? '<th>Extra Revenue</th>' : ''}
            <th>Profit</th><th>Growth Time</th><th>Profit/Hour</th>
        </tr></thead><tbody>`;

    for (const r of results) {
        const profitColor = r.profit >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';
        const pphColor = r.profitPerHour >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';

        tableHTML += `<tr>
            <td style="display:flex; align-items:center; gap:0.5rem; font-weight:700;">
                <img src="https://render.albiononline.com/v1/item/${r.cropId}.png" width="32" height="32" style="image-rendering:pixelated;" onerror="this.style.display='none'">
                ${r.name}
            </td>
            <td>${r.costPrice > 0 ? r.costPrice.toLocaleString() : '--'} <span style="color:var(--text-muted); font-size:0.75rem;">(${r.costLabel})</span></td>
            <td>${r.revenuePrice > 0 ? r.revenuePrice.toLocaleString() : '--'} <span style="color:var(--text-muted); font-size:0.75rem;">(${r.revenueLabel})</span></td>
            ${results.some(res => res.productLabel) ? `<td>${r.productLabel ? `${r.productPrice > 0 ? r.productPrice.toLocaleString() : '--'} <span style="color:var(--text-muted); font-size:0.75rem;">(${r.productLabel})</span>` : '--'}</td>` : ''}
            <td style="font-weight:700; color:${profitColor};">${r.profit >= 0 ? '+' : ''}${Math.floor(r.profit).toLocaleString()}</td>
            <td>${r.growthHours}h</td>
            <td style="font-weight:700; color:${pphColor};">${Math.floor(r.profitPerHour).toLocaleString()}/h</td>
        </tr>`;
    }

    tableHTML += `</tbody></table></div>`;
    container.insertAdjacentHTML('beforeend', tableHTML);
}

// ============================================================
// BUILDS BROWSER (AlbionFreeMarket Public API)
// ============================================================
const BUILDS_API = 'https://api.albionfreemarket.com/be/builds';
let buildsCursor = null;
let buildsCurrentSort = 'netVotes';

async function loadBuilds(append = false) {
    const spinner = document.getElementById('builds-spinner');
    const container = document.getElementById('builds-results');
    const moreBtn = document.getElementById('builds-more-btn');
    const sortBy = document.getElementById('builds-sort').value;

    if (!append) {
        container.innerHTML = '';
        buildsCursor = null;
        buildsCurrentSort = sortBy;
    }
    spinner.classList.remove('hidden');

    try {
        let url = `${BUILDS_API}?limit=20&sort=${buildsCurrentSort}&order=-1`;
        if (buildsCursor) {
            url += `&lastValue=${buildsCursor.lastValue}&lastId=${buildsCursor.lastId}`;
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        spinner.classList.add('hidden');

        const builds = data.builds || [];
        buildsCursor = data.nextCursor || null;

        if (builds.length === 0 && !append) {
            container.innerHTML = `<div class="empty-state"><p>No builds found.</p></div>`;
            moreBtn.style.display = 'none';
            return;
        }

        // Filter by search
        const search = document.getElementById('builds-search').value.toLowerCase().trim();
        const filtered = search
            ? builds.filter(b => (b.name || '').toLowerCase().includes(search) ||
                (b.authorName || '').toLowerCase().includes(search) ||
                (b.weaponItemGroup || '').toLowerCase().includes(search))
            : builds;

        for (const build of filtered) {
            const card = createBuildCard(build);
            container.appendChild(card);
        }

        moreBtn.style.display = buildsCursor ? 'inline-flex' : 'none';
    } catch (e) {
        spinner.classList.add('hidden');
        if (!append) {
            container.innerHTML = `<div class="empty-state"><p>Failed to load builds: ${e.message}</p></div>`;
        }
    }
}

function createBuildCard(build) {
    const card = document.createElement('div');
    card.className = 'trade-card';
    card.style.cursor = 'default';

    // Equipment slots
    const slots = build.slots || [];
    const mainHand = slots.find(s => s.slot === 'mainhand');
    const offHand = slots.find(s => s.slot === 'offhand');
    const head = slots.find(s => s.slot === 'head');
    const armor = slots.find(s => s.slot === 'armor');
    const shoes = slots.find(s => s.slot === 'shoes');
    const cape = slots.find(s => s.slot === 'cape');
    const food = slots.find(s => s.slot === 'food');
    const potion = slots.find(s => s.slot === 'potion');

    const getSlotItem = (slot) => {
        if (!slot || !slot.mainItemSelection || !slot.mainItemSelection.itemUniqueName) return null;
        return slot.mainItemSelection.itemUniqueName;
    };

    const renderSlotIcon = (slot, label) => {
        const itemId = getSlotItem(slot);
        if (!itemId) return `<div style="width:48px; height:48px; background:var(--bg-elevated); border-radius:var(--radius-sm); display:flex; align-items:center; justify-content:center; font-size:0.6rem; color:var(--text-muted);" title="${label}">${label}</div>`;
        return `<img src="https://render.albiononline.com/v1/item/${itemId}.png" width="48" height="48" style="image-rendering:pixelated; border-radius:var(--radius-sm); background:var(--bg-elevated);" title="${getFriendlyName(itemId) || itemId}" onerror="this.style.display='none'">`;
    };

    // Tags
    const allTags = [
        ...(build.roleTags || []),
        ...(build.zoneTags || []),
        ...(build.activityTags || []),
        ...(build.sizeTags || [])
    ];
    const tagsHTML = allTags.slice(0, 5).map(t =>
        `<span style="background:var(--accent-dim); color:var(--accent); padding:0.15rem 0.5rem; border-radius:12px; font-size:0.65rem; white-space:nowrap;">${esc(t)}</span>`
    ).join('');

    const votes = (build.upvotesCount || 0) - (build.downvotesCount || 0);
    const votesColor = votes >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';
    const dateStr = build.createdAt ? new Date(build.createdAt).toLocaleDateString() : '';

    card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
            <div>
                <div style="font-weight:700; font-size:1rem; color:var(--text-primary);">${esc(build.name) || 'Unnamed Build'}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">by ${esc(build.authorName) || 'Unknown'} &bull; ${dateStr}</div>
            </div>
            <div style="display:flex; align-items:center; gap:0.25rem; font-weight:700; color:${votesColor};">
                <span style="font-size:1.1rem;">${votes >= 0 ? '+' : ''}${votes}</span>
                <span style="font-size:0.7rem; color:var(--text-muted);">votes</span>
            </div>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.75rem;">
            ${renderSlotIcon(mainHand, 'Main')}
            ${renderSlotIcon(offHand, 'Off')}
            ${renderSlotIcon(head, 'Head')}
            ${renderSlotIcon(armor, 'Armor')}
            ${renderSlotIcon(shoes, 'Shoes')}
            ${renderSlotIcon(cape, 'Cape')}
            ${renderSlotIcon(food, 'Food')}
            ${renderSlotIcon(potion, 'Pot')}
        </div>
        ${allTags.length > 0 ? `<div style="display:flex; gap:0.25rem; flex-wrap:wrap;">${tagsHTML}</div>` : ''}
        ${build.strengths && build.strengths.length > 0 ? `<div style="margin-top:0.5rem; font-size:0.75rem; color:var(--profit-green);">+ ${build.strengths.slice(0, 2).map(esc).join(' | ')}</div>` : ''}
    `;

    return card;
}

// ============================================================
// CRAFTING SAVE/LOAD & SHOPPING LIST
// ============================================================
const CRAFT_SETUPS_KEY = 'albion_craft_setups';

function getCraftSetups() {
    try { return JSON.parse(localStorage.getItem(CRAFT_SETUPS_KEY)) || {}; }
    catch { return {}; }
}

function saveCraftSetup() {
    const searchInput = document.getElementById('craft-search');
    const itemId = craftSearchExactId || searchInput.value.trim();
    if (!itemId) { showToast('Search for an item first.', 'warn'); return; }

    const name = prompt('Name this crafting setup:', getFriendlyName(itemId) || itemId);
    if (!name) return;

    const setup = {
        itemId: craftSearchExactId || itemId,
        searchText: searchInput.value,
        useFocus: document.getElementById('craft-use-focus').checked,
        spec: document.getElementById('craft-spec').value,
        mastery: document.getElementById('craft-mastery').value,
        cityBonus: document.getElementById('craft-city-bonus').value,
        fee: document.getElementById('craft-fee').value,
        quality: document.getElementById('craft-quality')?.value || '1',
        savedAt: new Date().toISOString()
    };

    const setups = getCraftSetups();
    setups[name] = setup;
    localStorage.setItem(CRAFT_SETUPS_KEY, JSON.stringify(setups));
    loadCraftSetupDropdown();
}

function loadCraftSetupDropdown() {
    const select = document.getElementById('craft-load-select');
    if (!select) return;
    const setups = getCraftSetups();
    select.innerHTML = '<option value="">Load Setup...</option>';
    for (const name of Object.keys(setups)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
}

function loadCraftSetup() {
    const select = document.getElementById('craft-load-select');
    const name = select.value;
    if (!name) return;

    const setups = getCraftSetups();
    const setup = setups[name];
    if (!setup) return;

    document.getElementById('craft-search').value = setup.searchText || '';
    document.getElementById('craft-use-focus').checked = setup.useFocus || false;
    document.getElementById('craft-spec').value = setup.spec || '0';
    document.getElementById('craft-mastery').value = setup.mastery || '0';
    document.getElementById('craft-city-bonus').value = setup.cityBonus || '0';
    document.getElementById('craft-fee').value = setup.fee || '0';
    const qualitySelect = document.getElementById('craft-quality');
    if (qualitySelect) qualitySelect.value = setup.quality || '1';

    if (setup.itemId) {
        craftSearchExactId = setup.itemId;
    }

    // Auto-calculate
    const calcBtn = document.getElementById('craft-search-btn');
    if (calcBtn) calcBtn.click();
}

function deleteCraftSetup() {
    const select = document.getElementById('craft-load-select');
    const name = select.value;
    if (!name) return;
    if (!confirm(`Delete setup "${name}"?`)) return;

    const setups = getCraftSetups();
    delete setups[name];
    localStorage.setItem(CRAFT_SETUPS_KEY, JSON.stringify(setups));
    loadCraftSetupDropdown();
}

function generateShoppingList(recipe, itemId, priceIndex, effectiveMultiplier) {
    const container = document.getElementById('craft-shopping-list');
    const content = document.getElementById('craft-shopping-content');
    if (!container || !content || !recipe || !recipe.materials) {
        if (container) container.style.display = 'none';
        return;
    }

    container.style.display = 'block';

    // Group materials by cheapest buy city
    const byCheapestCity = {};
    let totalCost = 0;
    const buyCities = CITIES.filter(c => c !== 'Black Market');

    for (const mat of recipe.materials) {
        const matPrices = priceIndex ? (priceIndex[mat.id] || {}) : {};
        const effQty = effectiveMultiplier ? Math.ceil(mat.qty * effectiveMultiplier * 100) / 100 : mat.qty;

        // Find cheapest city
        let cheapestPrice = Infinity, cheapestCity = 'Unknown';
        for (const city of buyCities) {
            const p = matPrices[city];
            if (p && p.sellMin > 0 && p.sellMin < cheapestPrice) {
                cheapestPrice = p.sellMin;
                cheapestCity = city;
            }
        }

        const cost = cheapestPrice < Infinity ? Math.ceil(cheapestPrice * effQty) : 0;
        totalCost += cost;

        if (!byCheapestCity[cheapestCity]) byCheapestCity[cheapestCity] = [];
        byCheapestCity[cheapestCity].push({
            id: mat.id,
            name: getFriendlyName(mat.id),
            qty: mat.qty,
            effQty: effQty.toFixed(1),
            unitPrice: cheapestPrice < Infinity ? cheapestPrice : 0,
            cost
        });
    }

    // Render grouped by city
    let html = '';
    for (const [city, mats] of Object.entries(byCheapestCity)) {
        const cityTotal = mats.reduce((s, m) => s + m.cost, 0);
        html += `<div style="margin-bottom:0.75rem;">
            <div style="font-weight:600; color:var(--text-primary); margin-bottom:0.35rem; font-size:0.85rem;">${esc(city)} <span style="color:var(--text-muted); font-weight:normal;">(${cityTotal > 0 ? cityTotal.toLocaleString() + 's' : '--'})</span></div>`;
        for (const m of mats) {
            html += `<div style="display:flex; align-items:center; gap:0.5rem; padding:0.2rem 0; font-size:0.8rem;">
                <img src="https://render.albiononline.com/v1/item/${m.id}.png" width="22" height="22" style="image-rendering:pixelated; border-radius:3px;" onerror="this.style.display='none'" loading="lazy">
                <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(m.name)}</span>
                <span style="color:var(--accent); font-weight:600; flex-shrink:0;">${m.effQty}x</span>
                <span style="color:var(--text-muted); flex-shrink:0; min-width:60px; text-align:right;">${m.cost > 0 ? m.cost.toLocaleString() + 's' : '--'}</span>
            </div>`;
        }
        html += `</div>`;
    }

    html += `<div style="border-top:2px solid var(--border-color); padding-top:0.5rem; margin-top:0.5rem; display:flex; justify-content:space-between; font-weight:700; font-size:0.9rem;">
        <span>Total Materials</span>
        <span style="color:var(--accent);">${totalCost > 0 ? totalCost.toLocaleString() + ' silver' : '--'}</span>
    </div>`;

    // Copy button
    const copyLines = [];
    for (const [city, mats] of Object.entries(byCheapestCity)) {
        copyLines.push(`--- ${city} ---`);
        for (const m of mats) copyLines.push(`${m.effQty}x ${m.name}`);
    }
    html += `<button class="btn-small" style="margin-top:0.5rem; width:100%;" onclick="navigator.clipboard.writeText(${JSON.stringify(copyLines.join('\n')).replace(/'/g, "\\'")}); showToast('Shopping list copied!', 'success');">Copy Shopping List</button>`;

    content.innerHTML = html;
}

// ===== FEEDBACK MODAL =====
function openFeedbackModal() {
    document.getElementById('feedback-modal').classList.remove('hidden');
    document.getElementById('feedback-message').focus();
}

function closeFeedbackModal() {
    document.getElementById('feedback-modal').classList.add('hidden');
    const status = document.getElementById('feedback-status');
    status.className = 'feedback-status hidden';
    status.textContent = '';
}

document.getElementById('feedback-message').addEventListener('input', function() {
    document.getElementById('feedback-char-count').textContent = `${this.value.length} / 1000`;
});

document.getElementById('feedback-modal').addEventListener('click', function(e) {
    if (e.target === this) closeFeedbackModal();
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !document.getElementById('feedback-modal').classList.contains('hidden')) {
        closeFeedbackModal();
    }
});

async function submitFeedback() {
    const type = document.getElementById('feedback-type').value;
    const message = document.getElementById('feedback-message').value.trim();
    const status = document.getElementById('feedback-status');
    const btn = document.getElementById('feedback-submit-btn');

    if (message.length < 5) {
        status.textContent = 'Message must be at least 5 characters.';
        status.className = 'feedback-status error';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting...';
    status.className = 'feedback-status hidden';

    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = localStorage.getItem('albion_auth_token');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const res = await fetch(VPS_BASE + '/api/feedback', {
            method: 'POST',
            headers,
            body: JSON.stringify({ type, message })
        });
        const data = await res.json();
        if (!res.ok) {
            status.textContent = esc(data.error || 'Submission failed.');
            status.className = 'feedback-status error';
        } else {
            status.textContent = 'Thanks! Your feedback was submitted.';
            status.className = 'feedback-status success';
            document.getElementById('feedback-message').value = '';
            document.getElementById('feedback-char-count').textContent = '0 / 1000';
        }
    } catch(e) {
        status.textContent = 'Network error. Please try again.';
        status.className = 'feedback-status error';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Submit';
    }
}

window.addEventListener('load', init);
