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
const TAX_RATE = 0.065;
const ITEMS_PER_PAGE = 48;
const API_CHUNK_SIZE = 100;

// ====== STATE ======
let ITEM_NAMES = {};
let itemsList = [];
let recipesData = {};
let currentTab = 'browser';
let browserPage = 1;
let browserFilteredItems = [];
let compareSelectedId = null;
let arbSearchExactId = null;
let craftSearchExactId = null;
let priceChartInstance = null;
let scanAbortController = null;

// ====== UTILITY ======
function getFriendlyName(id) {
    if (ITEM_NAMES[id] && ITEM_NAMES[id].trim() !== '') return ITEM_NAMES[id];
    return id.replace(/_/g, ' ').replace(/T(\d+)/, 'Tier $1').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

function getQualityName(q) {
    const map = { '1': 'Normal', '2': 'Good', '3': 'Outstanding', '4': 'Excellent', '5': 'Masterpiece' };
    return map[String(q)] || 'Unknown';
}

function timeAgo(dateString) {
    if (!dateString || dateString.startsWith('0001')) return 'Never';
    const date = new Date(dateString + 'Z');
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 0) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
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
        const [resItems, resRecipes] = await Promise.all([
            fetch('items.json' + cb),
            fetch('recipes.json' + cb)
        ]);
        ITEM_NAMES = await resItems.json();
        itemsList = Object.keys(ITEM_NAMES).filter(k => k && ITEM_NAMES[k]);
        recipesData = await resRecipes.json();
    } catch (e) {
        console.error('Failed to load data files:', e);
    }
}

// ====== API FETCHING ======
async function fetchMarketChunk(server, items) {
    if (items.length === 0) return [];
    const url = `${API_URLS[server]}/${items.join(',')}.json`;
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

// ====== SCAN ALL MARKET ======
async function scanAllMarket() {
    const btn = document.getElementById('scan-all-btn');
    const progressWrap = document.getElementById('scan-progress-wrap');
    const progressText = document.getElementById('scan-progress-text');
    const progressPercent = document.getElementById('scan-progress-percent');
    const progressFill = document.getElementById('scan-progress-fill');

    if (itemsList.length === 0) await loadData();

    btn.disabled = true;
    btn.textContent = 'Scanning...';
    progressWrap.classList.remove('hidden');
    progressFill.style.width = '0%';

    const server = getServer();
    const totalItems = itemsList.length;
    const totalChunks = Math.ceil(totalItems / API_CHUNK_SIZE);
    let scannedItems = 0;
    let failedChunks = 0;
    const startTime = Date.now();

    for (let i = 0; i < totalItems; i += API_CHUNK_SIZE) {
        const chunk = itemsList.slice(i, i + API_CHUNK_SIZE);
        try {
            const data = await fetchMarketChunk(server, chunk);
            if (data.length > 0) {
                await MarketDB.saveMarketData(data);
            }
        } catch (e) {
            failedChunks++;
            console.warn(`Chunk ${Math.floor(i / API_CHUNK_SIZE) + 1} failed:`, e.message);
        }

        scannedItems += chunk.length;
        const pct = Math.round((scannedItems / totalItems) * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        progressFill.style.width = pct + '%';
        progressPercent.textContent = pct + '%';
        progressText.textContent = `${scannedItems.toLocaleString()} / ${totalItems.toLocaleString()} items • ${elapsed}s elapsed${failedChunks > 0 ? ` • ${failedChunks} errors` : ''}`;
    }

    await MarketDB.setMeta('lastScan', { server });

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    progressText.textContent = `Scan complete! ${scannedItems.toLocaleString()} items in ${totalElapsed}s${failedChunks > 0 ? ` (${failedChunks} failed chunks)` : ''}`;
    progressPercent.textContent = '100%';
    progressFill.style.width = '100%';

    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"></path><path d="M21 3v6h-6"></path></svg> Scan All Market`;

    await updateDbStatus();

    // Auto-hide progress after 5s
    setTimeout(() => {
        progressWrap.classList.add('hidden');
    }, 5000);

    // Refresh current view
    if (currentTab === 'browser') renderBrowser();
}

// ====== TAB NAVIGATION ======
function initTabs() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTab = tab.dataset.tab;

            document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
            document.getElementById(`pane-${currentTab}`).classList.remove('hidden');

            if (currentTab === 'browser') renderBrowser();
        });
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

    // Get cached prices
    let priceMap = {};
    try {
        const allPrices = await MarketDB.getAllPrices();
        for (const p of allPrices) {
            if (!priceMap[p.item_id]) priceMap[p.item_id] = [];
            priceMap[p.item_id].push(p);
        }
    } catch (e) { /* no data yet */ }

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
                    <div class="item-card-name" title="${name}">${name}</div>
                    <div class="item-card-id">${id} <span class="tier-badge">${getTierEnchLabel(id)}</span></div>
                </div>
            </div>
            <div class="item-card-prices">
                <div class="price-cell">
                    <div class="pc-label">Buy Price</div>
                    <div class="pc-value text-accent">${bestSell ? bestSell.sell_price_min.toLocaleString() + ' 💰' : '—'}</div>
                    <div class="pc-city">${bestSell ? bestSell.city : ''}</div>
                </div>
                <div class="price-cell">
                    <div class="pc-label">Sell Price</div>
                    <div class="pc-value text-green">${bestBuy ? bestBuy.buy_price_max.toLocaleString() + ' 💰' : '—'}</div>
                    <div class="pc-city">${bestBuy ? bestBuy.city : ''}</div>
                </div>
            </div>
            <div class="item-card-prices" style="padding-top:0.5rem; margin-top:0.5rem; border-top: 1px solid rgba(255,255,255,0.05);">
                <div class="price-cell">
                    <div class="pc-label" style="font-size:0.7rem; color:var(--text-muted);">24h Avg Price</div>
                    <div class="pc-value" style="font-size:0.85rem; color:#a89c8a;">${avg24h > 0 ? avg24h.toLocaleString() + ' 💰' : 'N/A'}</div>
                </div>
                <div class="price-cell">
                    <div class="pc-label" style="font-size:0.7rem; color:var(--text-muted);">24h Vol Sold</div>
                    <div class="pc-value" style="font-size:0.85rem; color:#a89c8a;">${vol24h > 0 ? vol24h.toLocaleString() : 'N/A'}</div>
                </div>
            </div>
            <div style="text-align:center; font-size:0.7rem; color:var(--text-muted); padding: 0.5rem 0 0 0; font-style:italic;">
                Updated: ${timeAgo(maxDateStr)}
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
// MARKET FLIPPING (ARBITRAGE)
// ============================================================
function processArbitrage(data, quality, tier, enchantment, includeBM, buyCityFilter, sellCityFilter, isSingleItem = false) {
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
        const entryDate = entry.sell_price_min_date > entry.buy_price_max_date ? entry.sell_price_min_date : entry.buy_price_max_date;

        if (!current) {
            itemsData[itemKey][city] = { sellMin: entry.sell_price_min, buyMax: entry.buy_price_max, updateDate: entryDate };
        } else {
            if (entry.sell_price_min > 0 && (current.sellMin === 0 || entry.sell_price_min < current.sellMin)) current.sellMin = entry.sell_price_min;
            if (entry.buy_price_max > 0 && entry.buy_price_max > current.buyMax) current.buyMax = entry.buy_price_max;
            if (entryDate > '0001' && entryDate > current.updateDate) current.updateDate = entryDate;
        }
    });

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

                if (priceBuy > 0 && priceSell > 0) {
                    const tax = priceSell * TAX_RATE;
                    const profit = priceSell - priceBuy - tax;
                    
                    const destSellOrder = citiesObj[citySell].sellMin;
                    let soTax = 0;
                    let soProfit = 0;
                    if (destSellOrder > 0) {
                        soTax = destSellOrder * TAX_RATE;
                        soProfit = destSellOrder - priceBuy - soTax;
                    }

                    if (profit > 0 || isSingleItem) {
                        const dateBuy = citiesObj[cityBuy].updateDate;
                        const dateSell = citiesObj[citySell].updateDate;
                        trades.push({
                            itemId, quality: qual, buyCity: cityBuy, sellCity: citySell,
                            buyPrice: priceBuy, sellPrice: priceSell,
                            originBuyOrder: citiesObj[cityBuy].buyMax,
                            destSellOrder: destSellOrder,
                            tax, profit, roi: (profit / priceBuy) * 100,
                            soTax, soProfit, soRoi: destSellOrder > 0 ? (soProfit / priceBuy) * 100 : 0,
                            updateDate: dateBuy < dateSell ? dateBuy : dateSell
                        });
                    }
                }
            }
        }
    }
    return trades.sort((a, b) => b.profit - a.profit).slice(0, 60);
}

function renderArbitrage(trades, isSingleItem = false) {
    const container = document.getElementById('arbitrage-results');
    container.innerHTML = '';

    if (trades.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>${isSingleItem ? 'No market data for this item.' : 'No profitable routes found.'}</p><p class="hint">Try scanning the market first, then search for items.</p></div>`;
        return;
    }

    const countBar = document.createElement('div');
    countBar.className = 'result-count-bar';
    countBar.innerHTML = `Showing <strong>${trades.length}</strong> routes`;
    container.appendChild(countBar);

    trades.forEach(trade => {
        const card = document.createElement('div');
        card.className = 'trade-card';
        card.innerHTML = `
            <div class="card-header">
                <div style="position: relative; display: flex;">
                    <img class="item-icon" src="https://render.albiononline.com/v1/item/${trade.itemId}.png" alt="" loading="lazy">
                    ${getEnchantmentBadge(trade.itemId)}
                </div>
                <div class="header-titles">
                    <div class="item-name">${getFriendlyName(trade.itemId)}</div>
                    <span class="item-quality">${getQualityName(trade.quality)}</span>
                </div>
            </div>
            <div class="trade-route">
                <div class="city buy-city">
                    <span class="route-label">Buy from (Instant Buy)</span>
                    <strong class="city-name">${trade.buyCity}</strong>
                    <div style="display:flex; align-items:center; gap:0.5rem; justify-content:center;">
                        <span class="price" title="Instant Buy (Cheapest Sell Order)">${Math.floor(trade.buyPrice).toLocaleString()} 💰</span>
                        <button class="btn-refresh-item" data-item="${trade.itemId}" title="Refresh Prices" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding:0;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        </button>
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.3rem;">
                        Buy Order: <strong>${Math.floor(trade.originBuyOrder).toLocaleString()}</strong>
                    </div>
                </div>
                <div class="arrow">➔</div>
                <div class="city sell-city">
                    <span class="route-label">Sell to (Instant Sell)</span>
                    <strong class="city-name">${trade.sellCity}</strong>
                    <div style="display:flex; align-items:center; gap:0.5rem; justify-content:center;">
                        <span class="price" title="Instant Sell (Highest Buy Order)">${Math.floor(trade.sellPrice).toLocaleString()} 💰</span>
                        <button class="btn-refresh-item" data-item="${trade.itemId}" title="Refresh Prices" style="background:none; border:none; color:var(--text-muted); cursor:pointer; padding:0;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                        </button>
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.3rem;">
                        Sell Order: <strong>${Math.floor(trade.destSellOrder).toLocaleString()}</strong>
                    </div>
                </div>
            </div>
            <div class="profit-section">
                <div style="font-size:0.85rem; font-weight:bold; color:var(--text-muted); margin-bottom:0.3rem;">Instant Sell Profit</div>
                <div class="profit-row"><span>Tax (6.5%):</span><span class="text-red">-${Math.floor(trade.tax).toLocaleString()} 💰</span></div>
                <div class="profit-row total"><span>Net Profit:</span><strong class="${trade.profit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(trade.profit).toLocaleString()} 💰</strong></div>
                <div class="roi-row"><span>ROI:</span><strong class="${trade.roi >= 0 ? 'text-green' : 'text-red'}">${trade.roi.toFixed(1)}%</strong></div>
            </div>
            ${trade.destSellOrder > 0 ? `
            <div class="profit-section" style="border-top:1px solid var(--border); margin-top:0.5rem; padding-top:0.5rem;">
                <div style="font-size:0.85rem; font-weight:bold; color:var(--text-muted); margin-bottom:0.3rem;">Sell Order Profit</div>
                <div class="profit-row"><span>Tax (6.5%):</span><span class="text-red">-${Math.floor(trade.soTax).toLocaleString()} 💰</span></div>
                <div class="profit-row total"><span>Net Profit:</span><strong class="${trade.soProfit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(trade.soProfit).toLocaleString()} 💰</strong></div>
                <div class="roi-row"><span>ROI:</span><strong class="${trade.soRoi >= 0 ? 'text-green' : 'text-red'}">${trade.soRoi.toFixed(1)}%</strong></div>
            </div>
            ` : ''}
            <div style="text-align:center; font-size:0.7rem; color:var(--text-muted); padding: 0.5rem 0 0 0; font-style:italic;">
                Updated: ${timeAgo(trade.updateDate)}
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
}

async function doArbScan() {
    if (itemsList.length === 0) await loadData();

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

    hideError(errorEl);
    container.innerHTML = '';
    spinner.classList.remove('hidden');

    let searchVal = searchInput.value.trim();
    let isSingleItem = false;

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

                const trades = processArbitrage(filteredData, quality, tier, enchantment, includeBM, buyCityFilter, sellCityFilter, isSingleItem);
                renderArbitrage(trades, isSingleItem);
                return;
            }
        } catch (e) { /* fall through */ }

        showError(errorEl, 'No cached data. Click "Scan All Market" first to download market prices, or search for a specific item.');
        spinner.classList.add('hidden');
        return;
    }

    try {
        const server = getServer();
        const data = await fetchMarketData(server, itemsToFetch);
        if (data.length > 0) await MarketDB.saveMarketData(data);
        spinner.classList.add('hidden');
        const trades = processArbitrage(data, quality, tier, enchantment, includeBM, buyCityFilter, sellCityFilter, isSingleItem);
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
                <div>
                    <h3>${name} <span class="tier-badge">${getTierEnchLabel(itemId)}</span></h3>
                    <span style="color:var(--text-muted);font-size:0.8rem;">${itemId}</span>
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
            orderedCities.forEach(c => tableHTML += `<th>${c}</th>`);
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

        await updateDbStatus();
    } catch (e) {
        spinner.classList.add('hidden');
        container.innerHTML = `<div class="empty-state"><p>Error fetching data: ${e.message}</p></div>`;
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
        // Fetch prices for finished item + all materials across all cities
        const allItemIds = [resolvedId, ...recipe.materials.map(m => m.id)];
        const uniqueIds = [...new Set(allItemIds)];
        const data = await fetchMarketData(server, uniqueIds);
        if (data.length > 0) await MarketDB.saveMarketData(data);

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
    const rrr = calculateRRR(useFocus, cityBonusPct);
    const effectiveMultiplier = 1 - rrr;

    // Index prices by item_id → city
    const priceIndex = {};
    for (const entry of data) {
        const id = entry.item_id;
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
                const tax = totalRevenue * TAX_RATE;
                const fee = cheapestTotal * (stationFee / 100);
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
            const tax = sellPrice * TAX_RATE;
            const fee = cheapestTotal * (stationFee / 100);
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
        summaryHTML += `
        <div class="craft-summary-stats">
            <div class="stat-box"><div class="stat-label">Cheapest Materials</div><div class="stat-value">${cheapestTotal.toLocaleString()} 💰</div></div>
            <div class="stat-box"><div class="stat-label">Best Sell (${bestCity})</div><div class="stat-value text-accent">${bestSellPrice.toLocaleString()} 💰</div></div>
            <div class="stat-box"><div class="stat-label">Tax (6.5%)</div><div class="stat-value text-red">-${Math.floor(bestSellPrice * TAX_RATE).toLocaleString()}</div></div>
            ${stationFee > 0 ? `<div class="stat-box"><div class="stat-label">Station Fee (${stationFee}%)</div><div class="stat-value text-red">-${Math.floor(cheapestTotal * stationFee / 100).toLocaleString()}</div></div>` : ''}
            <div class="stat-box highlight"><div class="stat-label">Net Profit</div><div class="stat-value ${bestProfit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(bestProfit).toLocaleString()} 💰</div></div>
            <div class="stat-box"><div class="stat-label">ROI</div><div class="stat-value ${bestProfit >= 0 ? 'text-green' : 'text-red'}">${roi}%</div></div>
        </div>
        <div class="profit-gauge"><div class="profit-gauge-fill ${bestProfit >= 0 ? 'positive' : 'negative'}" style="width:${gaugeWidth}%"></div></div>`;
    } else {
        summaryHTML += `<div class="craft-summary-stats"><div class="stat-box"><div class="stat-value">No profitable route found</div></div></div>`;
    }
    summaryHTML += `</div>`;

    container.innerHTML = summaryHTML + matTableHTML + sellHTML;
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

            const tax = bestSellPrice * TAX_RATE;
            const fee = totalMatCost * (stationFee / 100);
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
                        <span>${mat.effectiveQty || mat.qty}x ${getFriendlyName(mat.id)} <span class="mat-city">from ${mat.city}</span></span>
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
                    <div class="item-name">${getFriendlyName(craft.itemId)}</div>
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
                    <strong class="city-name">${craft.sellCity}</strong>
                </div>
                <span class="price text-accent">${Math.floor(craft.sellPrice).toLocaleString()} 💰</span>
            </div>
            <div class="profit-section">
                <div class="profit-row"><span>Tax (6.5%):</span><span class="text-red">-${Math.floor(craft.tax).toLocaleString()} 💰</span></div>
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
            showError(errorEl, 'No cached data. Click "Scan All Market" first.');
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
                await updateDbStatus();
                // Rerender specific active tab completely seamlessly
                if (currentTab === 'browser') await renderBrowser();
                else if (currentTab === 'arbitrage') await doArbScan();
                else if (currentTab === 'crafting') await doCraftScan();
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
}

let currentChartData = [];
let currentChartItemId = null;

async function showGraph(itemId) {
    const modal = document.getElementById('chart-modal');
    const ctx = document.getElementById('priceChart').getContext('2d');
    const citySelect = document.getElementById('chart-city-select');

    modal.classList.remove('hidden');
    
    if (priceChartInstance) priceChartInstance.destroy();
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
            };
        } else {
            defaultCity = data[0].location; // Fallback
        }
        
        document.querySelectorAll('input[name="chart-time"]').forEach(radio => {
            radio.onclick = () => renderChartForCity(citySelect.value || defaultCity);
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
                div.innerHTML = `<strong>${m.name}</strong> <span style="color:var(--text-muted);font-size:0.75rem;">(${m.id})</span>`;
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

// ====== INITIALIZATION ======
async function init() {
    await loadData();
    await updateDbStatus();

    initTabs();

    // Scan All Market button
    document.getElementById('scan-all-btn').addEventListener('click', scanAllMarket);

    // Arbitrage tab
    document.getElementById('arb-scan-btn').addEventListener('click', doArbScan);
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
        if (craftDetailItemId && recipesData[craftDetailItemId]) {
            doCraftSearch(); // Re-fetch and re-render with new settings
        }
    });
    setupAutocomplete('craft-search', 'craft-autocomplete', (id) => { craftSearchExactId = id; });
    document.getElementById('craft-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doCraftSearch();
    });
    document.getElementById('craft-search').addEventListener('input', () => { craftSearchExactId = null; });

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

    // Initialize 0-Delay Live Sync
    initLiveSync();
    
    // Initial render
    renderBrowser();
}

// ====== 0-DELAY LIVE SYNC (VPS WEBSOCKET) ======
let wsLink = null;
const API_LOCALE_MAP = {
    '0': 'Thetford',
    '7': 'Thetford', 
    '1002': 'Lymhurst',
    '2004': 'Bridgewatch',
    '3003': 'Black Market',
    '3005': 'Caerleon',
    '3008': 'Fort Sterling',
    '4000': 'Martlock',
    '4300': 'Brecilien'
};

function initLiveSync() {
    const statusDot = document.querySelector('.db-status-dot');
    const statusText = document.querySelector('.db-status-text');
    
    // Connect to the new VPS Proxy 
    wsLink = new WebSocket('wss://209-97-129-125.nip.io');
    
    wsLink.onopen = () => {
        console.log("🟢 Connected to Live NATS Stream at 209-97-129-125");
        if(statusText) statusText.textContent = "Live Market Sync Active";
        if(statusDot) {
            statusDot.style.background = '#00ff00';
            statusDot.style.boxShadow = '0 0 8px #00ff00';
        }
    };

    wsLink.onclose = () => {
        console.log("🔴 Live Stream Disconnected. Reconnecting in 5s...");
        if(statusText) statusText.textContent = "Live Sync Offline (Retrying)";
        if(statusDot) {
            statusDot.style.background = 'var(--loss-red)';
            statusDot.style.boxShadow = '0 0 6px var(--loss-red)';
        }
        setTimeout(initLiveSync, 5000);
    };

    wsLink.onmessage = async (e) => {
        try {
            const data = JSON.parse(e.data);
            
            // Format incoming NATS string arrays back to the standardized MarketDB schema
            const formattedUpdates = [];
            
            for (const payload of data) {
                 if (!payload.LocationId || !API_LOCALE_MAP[payload.LocationId]) continue;
                 
                 formattedUpdates.push({
                     item_id: payload.ItemTypeId,
                     city: API_LOCALE_MAP[payload.LocationId],
                     quality: payload.QualityLevel,
                     sell_price_min: payload.AuctionType === 'offer' ? payload.UnitPriceSilver / 10000 : 0, 
                     sell_price_min_date: payload.AuctionType === 'offer' ? payload.Expires : "1970-01-01T00:00:00",
                     buy_price_max: payload.AuctionType === 'request' ? payload.UnitPriceSilver / 10000 : 0,
                     buy_price_max_date: payload.AuctionType === 'request' ? payload.Expires : "1970-01-01T00:00:00"
                 });
            }

            if (formattedUpdates.length > 0) {
                 // Non-blocking background save to IndexedDB
                 MarketDB.saveMarketData(formattedUpdates);
                 // Note: We don't forcefully re-render the DOM here to avoid interrupting the user's scrolling,
                 // but the database is now perfectly up to date with 0-second delays for the next interaction!
            }
            
        } catch(err) {
            // Silently drop unparseable packets to avoid console spam
        }
    };
}

window.addEventListener('load', init);
