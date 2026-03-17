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
        const [resItems, resRecipes] = await Promise.all([
            fetch('items.json'),
            fetch('recipes.json')
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

    browserPage = 1;
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

    for (const id of pageItems) {
        const name = getFriendlyName(id);
        const tier = extractTier(id);
        const prices = priceMap[id] || [];

        // Find best sell (lowest sell_price_min) and best buy (highest buy_price_max)
        let bestSell = null, bestBuy = null;
        for (const p of prices) {
            if (p.sell_price_min > 0 && (!bestSell || p.sell_price_min < bestSell.sell_price_min)) bestSell = p;
            if (p.buy_price_max > 0 && (!bestBuy || p.buy_price_max > bestBuy.buy_price_max)) bestBuy = p;
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
                    <div class="pc-label">Best Sell</div>
                    <div class="pc-value text-green">${bestSell ? bestSell.sell_price_min.toLocaleString() + ' 💰' : '—'}</div>
                    <div class="pc-city">${bestSell ? bestSell.city : ''}</div>
                </div>
                <div class="price-cell">
                    <div class="pc-label">Best Buy</div>
                    <div class="pc-value text-accent">${bestBuy ? bestBuy.buy_price_max.toLocaleString() + ' 💰' : '—'}</div>
                    <div class="pc-city">${bestBuy ? bestBuy.city : ''}</div>
                </div>
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
function processArbitrage(data, quality, tier, includeBM, isSingleItem = false) {
    const itemsData = {};
    data.forEach(entry => {
        if (quality !== 'all' && entry.quality.toString() !== quality) return;
        if (tier !== 'all' && !entry.item_id.startsWith('T' + tier)) return;
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

                const priceBuy = citiesObj[cityBuy].sellMin;
                const priceSell = citiesObj[citySell].buyMax;

                if (priceBuy > 0 && priceSell > 0) {
                    const tax = priceSell * TAX_RATE;
                    const profit = priceSell - priceBuy - tax;
                    if (profit > 0 || isSingleItem) {
                        const dateBuy = citiesObj[cityBuy].updateDate;
                        const dateSell = citiesObj[citySell].updateDate;
                        trades.push({
                            itemId, quality: qual, buyCity: cityBuy, sellCity: citySell,
                            buyPrice: priceBuy, sellPrice: priceSell,
                            tax, profit, roi: (profit / priceBuy) * 100,
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
                    <span class="route-label">Buy from</span>
                    <strong class="city-name">${trade.buyCity}</strong>
                    <span class="price">${Math.floor(trade.buyPrice).toLocaleString()} 💰</span>
                </div>
                <div class="arrow">➔</div>
                <div class="city sell-city">
                    <span class="route-label">Sell to</span>
                    <strong class="city-name">${trade.sellCity}</strong>
                    <span class="price">${Math.floor(trade.sellPrice).toLocaleString()} 💰</span>
                </div>
            </div>
            <div class="profit-section">
                <div class="profit-row"><span>Tax (6.5%):</span><span class="text-red">-${Math.floor(trade.tax).toLocaleString()} 💰</span></div>
                <div class="profit-row total"><span>Net Profit:</span><strong class="${trade.profit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(trade.profit).toLocaleString()} 💰</strong></div>
                <div class="roi-row"><span>ROI:</span><strong class="${trade.roi >= 0 ? 'text-green' : 'text-red'}">${trade.roi.toFixed(1)}%</strong></div>
            </div>
            <div class="card-footer">
                <span>Updated: ${timeAgo(trade.updateDate)}</span>
                <button class="btn-refresh-item" data-item="${trade.itemId}" title="Refresh this item">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                </button>
            </div>
            <button class="btn-graph" data-item="${trade.itemId}">Show Price History</button>
        `;
        container.appendChild(card);
    });

    setupCardButtons(container);
}

async function doArbScan() {
    if (itemsList.length === 0) await loadData();

    const spinner = document.getElementById('arb-spinner');
    const errorEl = document.getElementById('arb-error');
    const container = document.getElementById('arbitrage-results');
    const searchInput = document.getElementById('arb-search');
    const quality = document.getElementById('arb-quality').value;
    const tier = document.getElementById('arb-tier').value;
    const category = document.getElementById('arb-category').value;
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

                const trades = processArbitrage(filteredData, quality, tier, includeBM, isSingleItem);
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
        const trades = processArbitrage(data, quality, tier, includeBM, isSingleItem);
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

    spinner.classList.remove('hidden');
    container.innerHTML = '';

    const itemId = compareSelectedId;
    const name = getFriendlyName(itemId);
    const server = getServer();

    try {
        // Fetch live data for this item
        const data = await fetchMarketChunk(server, [itemId]);
        if (data.length > 0) await MarketDB.saveMarketData(data);

        spinner.classList.add('hidden');

        // Group by quality → city
        const byQuality = {};
        for (const entry of data) {
            const q = entry.quality || 1;
            if (!byQuality[q]) byQuality[q] = {};
            let city = entry.city;
            if (city && city.includes('Black Market')) city = 'Black Market';
            byQuality[q][city] = {
                sell: entry.sell_price_min || 0,
                buy: entry.buy_price_max || 0,
                sellDate: entry.sell_price_min_date || '',
                buyDate: entry.buy_price_max_date || ''
            };
        }

        if (Object.keys(byQuality).length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No price data available for this item.</p></div>`;
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
                    <h3>${name}</h3>
                    <span style="color:var(--text-muted);font-size:0.8rem;">${itemId}</span>
                </div>
            </div>
        `;

        // Render a table for each quality
        for (const [quality, cities] of Object.entries(byQuality)) {
            const qualName = getQualityName(quality);
            const orderedCities = CITIES.filter(c => cities[c]);
            if (orderedCities.length === 0) continue;

            // Find best/worst
            const sells = orderedCities.map(c => cities[c].sell).filter(v => v > 0);
            const buys = orderedCities.map(c => cities[c].buy).filter(v => v > 0);
            const minSell = sells.length > 0 ? Math.min(...sells) : 0;
            const maxBuy = buys.length > 0 ? Math.max(...buys) : 0;

            let tableHTML = `<h4 style="color:var(--accent);margin:1.5rem 0 0.5rem;font-size:0.9rem;">${qualName} Quality</h4>`;
            tableHTML += `<table class="compare-table"><thead><tr><th></th>`;
            orderedCities.forEach(c => tableHTML += `<th>${c}</th>`);
            tableHTML += `</tr></thead><tbody>`;

            // Sell prices row
            tableHTML += `<tr><td>Sell Order Min</td>`;
            orderedCities.forEach(c => {
                const v = cities[c].sell;
                const cls = v > 0 && v === minSell ? 'best-price' : '';
                tableHTML += `<td class="${cls}">${v > 0 ? v.toLocaleString() : '—'}</td>`;
            });
            tableHTML += `</tr>`;

            // Buy prices row
            tableHTML += `<tr><td>Buy Order Max</td>`;
            orderedCities.forEach(c => {
                const v = cities[c].buy;
                const cls = v > 0 && v === maxBuy ? 'best-price' : '';
                tableHTML += `<td class="${cls}">${v > 0 ? v.toLocaleString() : '—'}</td>`;
            });
            tableHTML += `</tr>`;

            // Updated row
            tableHTML += `<tr class="updated-row"><td>Last Updated</td>`;
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
function processCrafting(data, tier, sortBy) {
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
            // Find best sell city for the finished item
            let bestSellCity = null, bestSellPrice = 0, finalDate = '0001';
            for (const city of Object.keys(citiesObj)) {
                if (citiesObj[city].buy > bestSellPrice) {
                    bestSellPrice = citiesObj[city].buy;
                    bestSellCity = city;
                    finalDate = citiesObj[city].updateDate;
                }
            }
            if (bestSellPrice === 0) continue;

            // Calculate material costs
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
                const cost = bestBuyPrice * mat.qty;
                totalMatCost += cost;
                matBreakdown.push({ id: mat.id, qty: mat.qty, city: bestBuyCity, unitPrice: bestBuyPrice, total: cost, updateDate: matDate });
            }
            if (missingMat) continue;

            const tax = bestSellPrice * TAX_RATE;
            const profit = bestSellPrice - totalMatCost - tax;
            const roi = (profit / totalMatCost) * 100;

            let oldestDate = finalDate;
            for (const mat of matBreakdown) {
                if (mat.updateDate < oldestDate) oldestDate = mat.updateDate;
            }

            crafts.push({
                itemId: finishedItem, quality, sellCity: bestSellCity, sellPrice: bestSellPrice,
                matCost: totalMatCost, mats: matBreakdown, tax, profit, roi,
                updateDate: oldestDate, category: recipe.category || 'other'
            });
        }
    }

    // Sort
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
                        <span>${mat.qty}x ${getFriendlyName(mat.id)} <span class="mat-city">from ${mat.city}</span></span>
                    </div>
                    <span>${mat.total.toLocaleString()} 💰</span>
                </div>
            `;
        });

        // Profit gauge width (capped at 100%)
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
                <div class="craft-materials-title">Materials Required</div>
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
                <div class="profit-row total"><span>Net Profit:</span><strong class="${craft.profit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(craft.profit).toLocaleString()} 💰</strong></div>
                <div class="roi-row"><span>ROI:</span><strong class="${craft.roi >= 0 ? 'text-green' : 'text-red'}">${craft.roi.toFixed(1)}%</strong></div>
                <div class="profit-gauge"><div class="profit-gauge-fill ${gaugeClass}" style="width:${gaugeWidth}%"></div></div>
            </div>
            <div class="card-footer">
                <span>Updated: ${timeAgo(craft.updateDate)}</span>
                <button class="btn-refresh-item" data-item="${craft.itemId}" title="Refresh this item">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                </button>
            </div>
            <button class="btn-graph" data-item="${craft.itemId}">Show Price History</button>
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
            // Only process recipes that match the search
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
    container.querySelectorAll('.btn-refresh-item').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const itemId = btn.dataset.item;
            btn.classList.add('loading');
            try {
                const data = await fetchMarketChunk(getServer(), [itemId]);
                if (data.length > 0) await MarketDB.saveMarketData(data);
                await updateDbStatus();
                // Could re-render here but it would disrupt scroll position
            } catch (err) {
                console.error('Refresh failed:', err);
            }
            btn.classList.remove('loading');
        });
    });

    container.querySelectorAll('.btn-graph').forEach(btn => {
        btn.addEventListener('click', () => showGraph(btn.dataset.item));
    });
}

async function showGraph(itemId) {
    const modal = document.getElementById('chart-modal');
    const title = document.getElementById('chart-title');
    const ctx = document.getElementById('priceChart').getContext('2d');

    modal.classList.remove('hidden');
    title.textContent = `Loading history for ${getFriendlyName(itemId)}...`;

    if (priceChartInstance) priceChartInstance.destroy();

    try {
        const server = getServer();
        const response = await fetch(`${CHART_API_URLS[server]}/${itemId}.json?time-scale=24`);
        if (!response.ok) throw new Error('Failed to fetch chart data');
        const data = await response.json();

        if (data.length === 0 || !data[0].data || !data[0].data.timestamps) {
            title.textContent = 'No history available';
            return;
        }

        title.textContent = `${getFriendlyName(itemId)} – Price History (30 Days)`;
        const timestamps = data[0].data.timestamps.slice(-30);
        const avgPrices = data[0].data.prices_avg.slice(-30);
        const labels = timestamps.map(ts => new Date(ts).toLocaleDateString());

        priceChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Average Price',
                    data: avgPrices,
                    borderColor: '#d4af37',
                    backgroundColor: 'rgba(212, 175, 55, 0.15)',
                    fill: true,
                    tension: 0.4,
                    borderWidth: 2,
                    pointRadius: 2,
                    pointHoverRadius: 5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: false, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#888' } },
                    x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#888', maxRotation: 45 } }
                },
                plugins: {
                    legend: { labels: { color: '#e0e0e0' } }
                }
            }
        });
    } catch (e) {
        title.textContent = 'Error: ' + e.message;
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
    document.getElementById('craft-scan-btn').addEventListener('click', doCraftScan);
    setupAutocomplete('craft-search', 'craft-autocomplete', (id) => { craftSearchExactId = id; });
    document.getElementById('craft-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doCraftScan();
    });
    document.getElementById('craft-search').addEventListener('input', () => { craftSearchExactId = null; });

    // Browser search/filters
    let browserDebounce = null;
    const browserInputs = ['browser-search', 'browser-tier', 'browser-enchantment', 'browser-category'];
    browserInputs.forEach(id => {
        document.getElementById(id).addEventListener(id === 'browser-search' ? 'input' : 'change', () => {
            clearTimeout(browserDebounce);
            browserDebounce = setTimeout(() => renderBrowser(), 200);
        });
    });

    // Chart modal close
    document.getElementById('chart-close-btn').addEventListener('click', () => {
        document.getElementById('chart-modal').classList.add('hidden');
    });

    // Initial render
    renderBrowser();
}

window.addEventListener('load', init);
