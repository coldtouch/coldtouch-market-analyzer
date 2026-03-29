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
let spreadStatsCache = {}; // keyed by "itemId_quality_buyCity_sellCity"
let spreadStatsCacheTime = 0;
let discordUser = null; // stored on auth check for contribution tracking

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
                        soTax = destSellOrder * TAX_RATE;
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
            <div style="display:flex; justify-content:center; gap:1rem; flex-wrap:wrap;">
                <span title="Buy Data Age">${getFreshnessIndicator(trade.dateBuy)} ${trade.buyCity}: ${timeAgo(trade.dateBuy)}</span>
                <span title="Sell Data Age">${getFreshnessIndicator(trade.dateSell)} ${trade.sellCity}: ${timeAgo(trade.dateSell)}</span>
            </div>
            ${trade.confidence !== null ? `
            <div style="margin-top:0.4rem; display:flex; justify-content:center; align-items:center; gap:0.5rem;">
                ${getConfidenceBadge(trade.confidence)}
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
        </div>
    `;
    return card;
}

function renderArbitrage(trades, isSingleItem = false, targetItemId = null) {
    const container = document.getElementById('arbitrage-results');

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
}

async function doArbScan(targetItemId = null) {
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
                    <h3>${name} <span class="tier-badge">${getTierEnchLabel(itemId)}</span></h3>
                    <span style="color:var(--text-muted);font-size:0.8rem;">${itemId}</span>
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
                    await enrichAndRenderTransport(lastTransportRoutes, budget, sortBy);
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

// ============================================================
// ALERT MANAGEMENT
// ============================================================
const VPS_BASE = 'https://209-97-129-125.nip.io';

async function loadAlerts() {
    const listEl = document.getElementById('alerts-list');
    const emptyEl = document.getElementById('alerts-empty');
    if (!listEl) return;

    try {
        const res = await fetch(`${VPS_BASE}/api/alerts`);
        const alerts = await res.json();

        if (!alerts || alerts.length === 0) {
            listEl.innerHTML = '';
            emptyEl.style.display = '';
            return;
        }

        emptyEl.style.display = 'none';
        listEl.innerHTML = alerts.map(a => `
            <div class="item-card" style="display:flex; justify-content:space-between; align-items:center; padding:1rem; margin-bottom:0.5rem;">
                <div>
                    <div style="font-weight:600; color:var(--text-primary);">📢 Channel: <span style="color:var(--accent);">${a.channel_id}</span></div>
                    <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:0.3rem;">
                        Min Profit: <strong style="color:var(--profit-green);">${parseInt(a.min_profit).toLocaleString()} silver</strong>
                        ${a.guild_id ? ` • Source: ${a.guild_id.startsWith('web-') ? '🌐 Web' : '🤖 Discord'}` : ''}
                    </div>
                </div>
                <button class="btn-card-action" style="color:var(--loss-red);" onclick="deleteAlert('${a.channel_id}')" title="Delete this alert">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    Delete
                </button>
            </div>
        `).join('');
    } catch (e) {
        listEl.innerHTML = '<div class="empty-state"><p>Could not load alerts. Is the bot server online?</p></div>';
    }
}

async function createAlert() {
    const channelId = document.getElementById('alert-channel-id').value.trim();
    const minProfit = document.getElementById('alert-min-profit').value;

    if (!channelId) return alert('Please enter a Discord Channel ID.');
    if (!minProfit || parseInt(minProfit) < 1000) return alert('Min profit must be at least 1,000 silver.');

    try {
        const res = await fetch(`${VPS_BASE}/api/alerts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_id: channelId, min_profit: parseInt(minProfit) })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('alert-channel-id').value = '';
            await loadAlerts();
        } else {
            alert('Failed to create alert: ' + (data.error || 'Unknown error'));
        }
    } catch (e) {
        alert('Failed to connect to alert server.');
    }
}

async function deleteAlert(channelId) {
    if (!confirm(`Delete alert for channel ${channelId}?`)) return;
    try {
        await fetch(`${VPS_BASE}/api/alerts`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_id: channelId })
        });
        await loadAlerts();
    } catch (e) {
        alert('Failed to delete alert.');
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
                    <div class="item-name">${getFriendlyName(trade.itemId)}</div>
                    <span class="item-quality">${getQualityName(trade.quality)} ${getTierEnchLabel(trade.itemId)}</span>
                </div>
            </div>
            <div class="trade-route">
                <div class="city buy-city">
                    <span class="route-label">Buy From</span>
                    <strong class="city-name">${trade.buyCity}</strong>
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
                <div class="profit-row"><span>Tax (6.5%):</span><span class="text-red">-${Math.floor(trade.tax).toLocaleString()} silver</span></div>
                <div class="profit-row total"><span>Net Profit:</span><strong class="${trade.profit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(trade.profit).toLocaleString()} silver</strong></div>
                <div class="roi-row"><span>ROI:</span><strong class="${trade.roi >= 0 ? 'text-green' : 'text-red'}">${trade.roi.toFixed(1)}%</strong></div>
            </div>
            <div style="text-align:center; font-size:0.7rem; color:var(--text-muted); padding: 0.5rem 0 0 0; font-style:italic;">
                <div style="display:flex; justify-content:center; gap:1rem; flex-wrap:wrap;">
                    <span title="Buy Data Age">${getFreshnessIndicator(trade.dateBuy)} ${trade.buyCity}: ${timeAgo(trade.dateBuy)}</span>
                    <span title="Sell Data Age">${getFreshnessIndicator(trade.dateSell)} BM: ${timeAgo(trade.dateSell)}</span>
                </div>
                ${trade.confidence !== null ? `
                <div style="margin-top:0.4rem; display:flex; justify-content:center; align-items:center; gap:0.5rem;">
                    ${getConfidenceBadge(trade.confidence)}
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
                    const soTax = fullSellOrderPrice * TAX_RATE;
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
        container.innerHTML = `<div class="empty-state"><p>Failed to fetch journal prices: ${e.message}</p></div>`;
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
                    <h2>${results.name} <span class="tier-badge">${tierEnch}</span></h2>
                    <span style="color:var(--text-muted);font-size:0.8rem;">${results.itemId} | ${results.qualityName}</span>
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

async function checkDiscordAuth() {
    try {
        const res = await fetch(`${VPS_BASE}/api/me`, {credentials: 'include', signal: AbortSignal.timeout(5000)});
        const data = await res.json();
        if (data.loggedIn) {
            discordUser = data.user;
            document.getElementById('login-discord-btn').classList.add('hidden');
            const profile = document.getElementById('discord-user-profile');
            profile.classList.remove('hidden');
            profile.style.display = 'flex';
            document.getElementById('discord-avatar').src = `https://cdn.discordapp.com/avatars/${data.user.id}/${data.user.avatar}.png`;
            document.getElementById('discord-username').textContent = data.user.username;

            // Show tier badge in header
            if (data.tier) {
                const tierBadge = document.getElementById('discord-tier-badge');
                tierBadge.textContent = data.tier.charAt(0).toUpperCase() + data.tier.slice(1);
                tierBadge.className = `tier-badge tier-${data.tier}`;
                tierBadge.style.display = 'inline-block';
            }
        }
    } catch (e) {
        console.log('Discord OAuth session not detected.', e);
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

async function init() {
    // === IMMEDIATE: attach all UI listeners before any async work ===
    // Scripts are at bottom of <body> so DOM is fully ready here.
    initTabs();

    // Fresh filter mode shows/hides threshold dropdown
    const freshMode = document.getElementById('fresh-mode');
    const freshThresholdGroup = document.getElementById('fresh-threshold-group');
    freshMode.addEventListener('change', () => {
        freshThresholdGroup.style.display = freshMode.value === 'off' ? 'none' : '';
    });

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
        if (craftDetailItemId && recipesData[craftDetailItemId]) {
            doCraftSearch(); // Re-fetch and re-render with new settings
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

    // Initialize portfolio on load
    renderPortfolio();

    // Load favorites dropdown on load
    loadFavoriteLists();

    // Initialize RRR with default values so it doesn't show "--"
    calculateRRRStandalone();

    // Connect live sync immediately — doesn't need data
    initLiveSync();

    // === ASYNC: load data and update UI in background ===
    await checkDiscordAuth();
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
                }
            }
        }
    } catch (e) { /* ignore */ }

    // Load shared server cache (always — keeps data fresh for all users)
    await loadServerCache();

    // Evict stale prices older than 24h
    await MarketDB.evictStale(24 * 60 * 60 * 1000);

    await updateDbStatus();

    // Background refresh: pull server cache every 5 min + evict stale data
    setInterval(async () => {
        await loadServerCache(true);
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

    // Connect to the new VPS Proxy
    wsLink = new WebSocket('wss://209-97-129-125.nip.io');

    wsLink.onopen = () => {
        console.log("🟢 Connected to Live NATS Stream at 209-97-129-125");
        if(syncText) syncText.textContent = "Live Sync Active";
        if(syncDot) {
            syncDot.style.background = '#00ff00';
            syncDot.style.boxShadow = '0 0 8px #00ff00';
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

// ====== TRANSPORT TAB ======
let lastTransportRoutes = null;

async function doTransportScan() {
    const spinner = document.getElementById('transport-spinner');
    const errorEl = document.getElementById('transport-error');
    const container = document.getElementById('transport-results');
    const buyCity = document.getElementById('transport-buy-city').value;
    const sellCity = document.getElementById('transport-sell-city').value;
    const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
    const minConfidence = parseInt(document.getElementById('transport-min-confidence').value) || 0;
    const sortBy = document.getElementById('transport-sort').value;

    container.innerHTML = '';
    hideError(errorEl);
    spinner.classList.remove('hidden');

    try {
        // Fetch transport routes from backend (volume + spread stats combined)
        const params = new URLSearchParams({ min_confidence: minConfidence, limit: 150 });
        if (buyCity) params.set('buy_city', buyCity);
        if (sellCity) params.set('sell_city', sellCity);
        const res = await fetch(`${VPS_BASE}/api/transport-routes?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const routes = await res.json();
        lastTransportRoutes = routes;

        spinner.classList.add('hidden');
        await enrichAndRenderTransport(routes, budget, sortBy);
    } catch (e) {
        spinner.classList.add('hidden');
        showError(errorEl, 'Failed to load transport routes: ' + e.message);
    }
}

async function enrichAndRenderTransport(routes, budget, sortBy) {
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

    const enriched = [];
    for (const r of routes) {
        const buyKey = `${r.item_id}_${r.quality}_${r.buy_city}`;
        const sellKey = `${r.item_id}_${r.quality}_${r.sell_city}`;
        const buyData = priceMap[buyKey];
        const sellData = priceMap[sellKey];

        if (!buyData || buyData.sellMin <= 0) continue; // No buy price available
        if (!sellData || sellData.buyMax <= 0) continue; // No sell price available

        const buyPrice = buyData.sellMin; // We buy at sell order (instant buy)
        const sellPrice = sellData.buyMax; // We sell at buy order (instant sell)
        const tax = sellPrice * TAX_RATE;
        const profitPerUnit = sellPrice - buyPrice - tax;
        if (profitPerUnit <= 0) continue;

        const roi = (profitPerUnit / buyPrice) * 100;
        const volume = Math.max(r.buy_volume || 0, r.sell_volume || 0);
        const unitsCanBuy = Math.floor(budget / buyPrice);
        const tripProfit = profitPerUnit * unitsCanBuy;
        const transportScore = profitPerUnit * volume; // profit × daily volume

        enriched.push({
            itemId: r.item_id,
            quality: r.quality,
            buyCity: r.buy_city,
            sellCity: r.sell_city,
            buyPrice,
            sellPrice,
            tax,
            profitPerUnit,
            roi,
            volume: Math.round(volume),
            unitsCanBuy,
            tripProfit,
            transportScore,
            confidence: r.confidence_score,
            consistencyPct: r.consistency_pct,
            avgSpread: r.avg_spread,
            sampleCount: r.sample_count,
            dateBuy: buyData.sellDate,
            dateSell: sellData.buyDate
        });
    }

    // Sort
    if (sortBy === 'trip_profit') enriched.sort((a, b) => b.tripProfit - a.tripProfit);
    else if (sortBy === 'transport_score') enriched.sort((a, b) => b.transportScore - a.transportScore);
    else if (sortBy === 'profit_per_unit') enriched.sort((a, b) => b.profitPerUnit - a.profitPerUnit);
    else if (sortBy === 'volume') enriched.sort((a, b) => b.volume - a.volume);
    else if (sortBy === 'confidence') enriched.sort((a, b) => b.confidence - a.confidence);

    const excludeCaerleon = document.getElementById('transport-exclude-caerleon').checked;
    const caerleonCities = new Set(['Caerleon', 'Black Market']);
    const filtered = excludeCaerleon
        ? enriched.filter(r => !caerleonCities.has(r.sellCity) && !caerleonCities.has(r.buyCity))
        : enriched;

    renderTransportResults(filtered.slice(0, 60), budget);
}

function renderTransportResults(routes, budget) {
    const container = document.getElementById('transport-results');
    container.innerHTML = '';

    if (routes.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No profitable transport routes found.</p><p class="hint">Try adjusting your filters, budget, or city selection.</p></div>';
        return;
    }

    const countBar = document.createElement('div');
    countBar.className = 'result-count-bar';
    countBar.innerHTML = `Showing <strong>${routes.length}</strong> transport routes &bull; Budget: <strong>${budget.toLocaleString()}</strong> silver`;
    container.appendChild(countBar);

    const grid = document.createElement('div');
    grid.className = 'transport-results-grid';

    routes.forEach(r => {
        const card = document.createElement('div');
        card.className = 'transport-card';
        card.innerHTML = `
            <div class="transport-card-header">
                <div style="position:relative; display:flex;">
                    <img class="item-icon" src="https://render.albiononline.com/v1/item/${r.itemId}.png" alt="" loading="lazy">
                    ${getEnchantmentBadge(r.itemId)}
                </div>
                <div class="header-titles">
                    <div class="item-name">${getFriendlyName(r.itemId)}</div>
                    <span class="item-quality">${getQualityName(r.quality)} ${getTierEnchLabel(r.itemId)}</span>
                </div>
                ${r.confidence !== null ? getConfidenceBadge(r.confidence) : ''}
            </div>
            <div class="transport-route-bar">
                <span class="city-tag">${r.buyCity}</span>
                <span>➔</span>
                <span class="city-tag">${r.sellCity}</span>
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
                    <div class="transport-stat-label">Daily Volume</div>
                    <div class="transport-stat-value accent">${r.volume > 0 ? r.volume.toLocaleString() : '—'}</div>
                </div>
                <div class="transport-stat">
                    <div class="transport-stat-label">Units (Budget)</div>
                    <div class="transport-stat-value">${r.unitsCanBuy.toLocaleString()}</div>
                </div>
            </div>
            <div class="transport-trip-summary">
                <div>
                    <div class="transport-trip-label">Est. Trip Profit</div>
                    <div class="transport-trip-value">+${Math.floor(r.tripProfit).toLocaleString()} silver</div>
                </div>
                <div style="text-align:right;">
                    <div class="transport-trip-label">Transport Score</div>
                    <div style="font-size:1rem; font-weight:700; color:var(--accent);">${r.transportScore > 1000000 ? (r.transportScore / 1000000).toFixed(1) + 'M' : r.transportScore > 1000 ? (r.transportScore / 1000).toFixed(0) + 'K' : Math.round(r.transportScore)}</div>
                </div>
                ${r.confidence !== null ? `<div style="text-align:right;">
                    <div class="transport-trip-label">Reliability</div>
                    <div style="font-size:0.8rem; color:var(--text-secondary);">Profitable ${r.consistencyPct}% of the time</div>
                </div>` : ''}
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

    container.appendChild(grid);
    setupCardButtons(container);
}

// ====== CONTRIBUTION TRACKING ======
function trackContribution(itemCount) {
    if (!discordUser) return; // Only track for logged-in users
    fetch(`${VPS_BASE}/api/contributions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
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
            const res = await fetch(`${VPS_BASE}/api/my-stats`, { credentials: 'include' });
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
            const tier = u.tier || 'bronze';
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
                        ${u.username || 'Unknown'}
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
                            <td><strong>${getFriendlyName(r.itemId)}</strong><br><span style="font-size:0.7rem;color:var(--text-muted);">${r.itemId}</span></td>
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
        alert('Please enter a list name.');
        return;
    }
    if (favCurrentItems.length === 0) {
        alert('Please add at least one item to the list.');
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
        alert('Please select a list to delete.');
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
            ${getFriendlyName(id)}
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
                            <td><strong>${getFriendlyName(itemId)}</strong><br><span style="font-size:0.65rem;color:var(--text-muted);">${getTierEnchLabel(itemId)}</span></td>
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
                <span>${name}</span>${enchBadge}
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
        alert('Please fill in all fields.');
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
    if (trades.length === 0) { alert('No trades to export.'); return; }

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
    const taxEstimate = Object.values(itemStats).reduce((sum, s) => sum + s.totalEarned * TAX_RATE, 0);
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
                <div style="font-size:0.75rem; color:var(--text-secondary);">Net P/L (after ${(TAX_RATE*100).toFixed(1)}% tax)</div>
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
        tableHTML += `<tr>
            <td>${date}</td>
            <td><span style="font-weight:700; color:${typeColor};">${typeLabel}</span></td>
            <td style="display:flex; align-items:center; gap:0.5rem;">
                <img src="https://render.albiononline.com/v1/item/${t.itemId}.png" width="24" height="24" style="image-rendering:pixelated;" onerror="this.style.display='none'">
                ${name}
            </td>
            <td>${t.quantity.toLocaleString()}</td>
            <td>${t.price.toLocaleString()}</td>
            <td style="font-weight:700;">${total.toLocaleString()}</td>
            <td>${t.city}</td>
            <td><button onclick="deletePortfolioTrade('${t.id}')" style="background:none; border:none; color:var(--loss-red); cursor:pointer; font-size:1rem;" title="Delete trade">×</button></td>
        </tr>`;
    });

    tableHTML += `</tbody></table></div>`;
    tradesEl.innerHTML = tableHTML;
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
        container.innerHTML = `<div class="empty-state"><p>Failed to calculate farming profits: ${e.message}</p></div>`;
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
        `<span style="background:var(--accent-dim); color:var(--accent); padding:0.15rem 0.5rem; border-radius:12px; font-size:0.65rem; white-space:nowrap;">${t}</span>`
    ).join('');

    const votes = (build.upvotesCount || 0) - (build.downvotesCount || 0);
    const votesColor = votes >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';
    const dateStr = build.createdAt ? new Date(build.createdAt).toLocaleDateString() : '';

    card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
            <div>
                <div style="font-weight:700; font-size:1rem; color:var(--text-primary);">${build.name || 'Unnamed Build'}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">by ${build.authorName || 'Unknown'} &bull; ${dateStr}</div>
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
        ${build.strengths && build.strengths.length > 0 ? `<div style="margin-top:0.5rem; font-size:0.75rem; color:var(--profit-green);">+ ${build.strengths.slice(0, 2).join(' | ')}</div>` : ''}
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
    if (!itemId) { alert('Search for an item first.'); return; }

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

function generateShoppingList(recipe, itemId) {
    const container = document.getElementById('craft-shopping-list');
    const content = document.getElementById('craft-shopping-content');
    if (!container || !content || !recipe || !recipe.materials) {
        if (container) container.style.display = 'none';
        return;
    }

    container.style.display = 'block';

    // Build shopping list from materials
    let html = '<div class="table-scroll-wrapper"><table class="compare-table"><thead><tr>';
    html += '<th>Material</th><th>Quantity</th><th>Estimated Cost</th>';
    html += '</tr></thead><tbody>';

    let totalCost = 0;
    for (const mat of recipe.materials) {
        const name = getFriendlyName(mat.id);
        // Try to get price from cache
        const price = mat.estimatedPrice || 0;
        const cost = price * mat.qty;
        totalCost += cost;

        html += `<tr>
            <td style="display:flex; align-items:center; gap:0.5rem;">
                <img src="https://render.albiononline.com/v1/item/${mat.id}.png" width="24" height="24" style="image-rendering:pixelated;" onerror="this.style.display='none'">
                ${name}
            </td>
            <td style="font-weight:700;">${mat.qty}</td>
            <td>${price > 0 ? cost.toLocaleString() + ' silver' : '--'}</td>
        </tr>`;
    }

    html += `<tr style="border-top:2px solid var(--border-color);">
        <td style="font-weight:700;">Total</td>
        <td></td>
        <td style="font-weight:700; color:var(--accent);">${totalCost > 0 ? totalCost.toLocaleString() + ' silver' : '--'}</td>
    </tr>`;
    html += '</tbody></table></div>';

    content.innerHTML = html;
}

window.addEventListener('load', init);
