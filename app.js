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

const ITEM_NAMES = {
    'T4_BAG': 'Tier 4 Bag', 'T5_BAG': 'Tier 5 Bag', 'T6_BAG': 'Tier 6 Bag', 'T7_BAG': 'Tier 7 Bag', 'T8_BAG': 'Tier 8 Bag',
    'T4_CAPE': 'Tier 4 Cape', 'T5_CAPE': 'Tier 5 Cape', 'T6_CAPE': 'Tier 6 Cape', 'T7_CAPE': 'Tier 7 Cape', 'T8_CAPE': 'Tier 8 Cape',
    'T4_MOUNT_HORSE': 'Tier 4 Riding Horse', 'T5_MOUNT_ARMORED_HORSE': 'Tier 5 Armored Horse', 'T6_MOUNT_DIRE_WOLF': 'Tier 6 Direwolf',
    'T4_WOOD': 'Tier 4 Pine Logs', 'T5_WOOD': 'Tier 5 Cedar Logs', 'T6_WOOD': 'Tier 6 Bloodoak Logs',
    'T4_PLANKS': 'Tier 4 Pine Planks', 'T5_PLANKS': 'Tier 5 Cedar Planks', 'T6_PLANKS': 'Tier 6 Bloodoak Planks',
    'T4_ORE': 'Tier 4 Iron Ore', 'T5_ORE': 'Tier 5 Titanium Ore', 'T6_ORE': 'Tier 6 Runite Ore',
    'T4_METALBAR': 'Tier 4 Steel Bar', 'T5_METALBAR': 'Tier 5 Titanium Steel Bar', 'T6_METALBAR': 'Tier 6 Runite Steel Bar',
    'T4_HIDE': 'Tier 4 Thick Hide', 'T5_HIDE': 'Tier 5 Heavy Hide', 'T6_HIDE': 'Tier 6 Robust Hide',
    'T4_LEATHER': 'Tier 4 Worked Leather', 'T5_LEATHER': 'Tier 5 Cured Leather', 'T6_LEATHER': 'Tier 6 Hardened Leather',
    'T4_FIBER': 'Tier 4 Hemp', 'T5_FIBER': 'Tier 5 Skyflower', 'T6_FIBER': 'Tier 6 Redspring Cotton',
    'T4_CLOTH': 'Tier 4 Fine Cloth', 'T5_CLOTH': 'Tier 5 Ornate Cloth', 'T6_CLOTH': 'Tier 6 Lavish Cloth',
    'T4_MAIN_FIRESTAFF': 'Tier 4 Fire Staff', 'T4_2H_BOW': 'Tier 4 Bow', 'T5_2H_BOW': 'Tier 5 Bow'
};

function getFriendlyName(id) {
    if (ITEM_NAMES[id] && ITEM_NAMES[id].trim() !== '') return ITEM_NAMES[id];
    return id.replace(/_/g, ' ').replace(/T(\d+)/, 'Tier $1').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

const btnRefresh = document.getElementById('refresh-btn');
const uiArbitrage = document.getElementById('pane-arbitrage');
const uiCrafting = document.getElementById('pane-crafting');
const resultsArbitrage = document.getElementById('arbitrage-results');
const resultsCrafting = document.getElementById('crafting-results');
const spinner = document.getElementById('loading-spinner');
const errorMessage = document.getElementById('error-message');

const templateArbitrage = document.getElementById('trade-card-template');
const templateCrafting = document.getElementById('crafting-card-template');
const tabBtns = document.querySelectorAll('.tab-btn');
const categorySelect = document.getElementById('category-select');
const qualitySelect = document.getElementById('quality-select');
const searchInput = document.getElementById('item-search');
const toggleBlackMarket = document.getElementById('include-black-market');

const chartModal = document.getElementById('chart-modal');
const closeBtn = document.querySelector('.close-btn');
const chartTitle = document.getElementById('chart-title');
const ctxChart = document.getElementById('priceChart').getContext('2d');
let priceChartInstance = null;

let itemsList = [];
let recipesData = {};
let currentMode = 'arbitrage';

const autocompleteList = document.getElementById('autocomplete-list');
let searchExactId = null;

searchInput.addEventListener('input', function () {
    const val = this.value;
    autocompleteList.innerHTML = '';
    searchExactId = null;

    if (!val) {
        autocompleteList.classList.add('hidden');
        return;
    }

    const valWords = val.toLowerCase().split(' ').filter(w => w);
    const matches = [];
    for (const item of itemsList) {
        const friendlyName = getFriendlyName(item);
        const searchTarget = (friendlyName + " " + item.replace(/_/g, ' ')).toLowerCase();

        const isMatch = valWords.every(word => searchTarget.includes(word));

        if (isMatch) {
            matches.push({ id: item, name: friendlyName });
            if (matches.length >= 7) break;
        }
    }

    if (matches.length > 0) {
        autocompleteList.classList.remove('hidden');
        matches.forEach(match => {
            const div = document.createElement('div');
            div.innerHTML = `<strong>${match.name}</strong> <small class="text-secondary">(${match.id})</small>`;
            div.addEventListener('click', function () {
                searchInput.value = match.name;
                searchExactId = match.id;
                autocompleteList.classList.add('hidden');
            });
            autocompleteList.appendChild(div);
        });
    } else {
        autocompleteList.classList.add('hidden');
    }
});

document.addEventListener('click', function (e) {
    if (e.target !== searchInput) {
        autocompleteList.classList.add('hidden');
    }
});

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = btn.dataset.tab;

        if (currentMode === 'arbitrage') {
            uiArbitrage.classList.add('active');
            uiArbitrage.classList.remove('hidden');
            uiCrafting.classList.remove('active');
            uiCrafting.classList.add('hidden');
        } else {
            uiCrafting.classList.add('active');
            uiCrafting.classList.remove('hidden');
            uiArbitrage.classList.remove('active');
            uiArbitrage.classList.add('hidden');
        }
    });
});

searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
        autocompleteList.classList.add('hidden');
        btnRefresh.click();
    }
});

closeBtn.addEventListener('click', () => {
    chartModal.classList.add('hidden');
});

async function loadData() {
    try {
        const [resItems, resRecipes] = await Promise.all([
            fetch('items.json'),
            fetch('recipes.json')
        ]);
        const itemsDict = await resItems.json();
        Object.assign(ITEM_NAMES, itemsDict);
        itemsList = Object.keys(itemsDict).filter(k => k);
        recipesData = await resRecipes.json();
    } catch (e) {
        showError("Failed to load local data files. " + e.message);
    }
}

async function fetchMarketData(server, items) {
    if (items.length === 0) return [];

    const chunkSize = 100;
    let allData = [];

    try {
        for (let i = 0; i < items.length; i += chunkSize) {
            const chunk = items.slice(i, i + chunkSize);
            const url = `${API_URLS[server]}/${chunk.join(',')}.json`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            allData = allData.concat(data);
        }

        // INTERCEPT: Try to fetch LIVE overlay data from our Companion App
        try {
            const liveResponse = await fetch('http://localhost:8081/api/live', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server: server, items: items })
            });
            if (liveResponse.ok) {
                const liveData = await liveResponse.json();

                // Merge Live Data over Public Data
                liveData.forEach(liveEntry => {
                    // Fix key name from companion
                    if (liveEntry.is_live_overlay) liveEntry.is_live = true;

                    let found = false;
                    for (let entry of allData) {
                        if (entry.item_id === liveEntry.item_id && entry.city === liveEntry.city && entry.quality === liveEntry.quality) {
                            if (liveEntry.sell_price_min > 0) {
                                entry.sell_price_min = liveEntry.sell_price_min;
                                entry.sell_price_min_date = liveEntry.sell_price_min_date;
                                entry.is_live = true;
                            }
                            if (liveEntry.buy_price_max > 0) {
                                entry.buy_price_max = liveEntry.buy_price_max;
                                entry.buy_price_max_date = liveEntry.buy_price_max_date;
                                entry.is_live = true;
                            }
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        liveEntry.is_live = true;
                        allData.push(liveEntry);
                    }
                });
            }
        } catch (e) {
            console.log("Companion app not running, using standard public API data.");
        }

        return allData;
    } catch (error) {
        showError("Failed to fetch market data. " + error.message);
        return [];
    }
}

function filterItemsByCategory(category) {
    if (category === 'all') return itemsList;
    return itemsList.filter(item => {
        if (recipesData[item] && recipesData[item].category === category) return true;
        if (category === 'materials' && (item.includes('WOOD') || item.includes('ORE') || item.includes('HIDE') || item.includes('FIBER') || item.includes('ROCK') || item.includes('PLANKS') || item.includes('METALBAR') || item.includes('LEATHER') || item.includes('CLOTH') || item.includes('STONEBLOCK'))) return true;
        return false;
    });
}

function timeAgo(dateString) {
    if (!dateString || dateString.startsWith("0001")) return "Never";
    const date = new Date(dateString + "Z"); // Albion API times are in UTC
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 0) return "Just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hr ago`;
    return `${Math.floor(diffHours / 24)} days ago`;
}

function getQualityName(q) {
    const qMap = { "1": "Normal", "2": "Good", "3": "Outstanding", "4": "Excellent", "5": "Masterpiece" };
    return qMap[q] || "Unknown";
}

function processArbitrage(data, isSingleItemMode = false) {
    const itemsData = {};
    const includeBM = toggleBlackMarket.checked;
    const sq = qualitySelect.value;

    data.forEach(entry => {
        if (sq !== 'all' && entry.quality.toString() !== sq) return;
        if (entry.sell_price_min === 0 && entry.buy_price_max === 0) return;
        const itemKey = `${entry.item_id}_${entry.quality}`;
        if (!itemsData[itemKey]) itemsData[itemKey] = {};
        let city = entry.city;
        if (city && city.includes("Black Market")) city = "Black Market";

        if (!CITIES.includes(city)) return;
        if (!includeBM && city === "Black Market") return;

        let current = itemsData[itemKey][city];
        const entryDate = entry.sell_price_min_date > entry.buy_price_max_date ? entry.sell_price_min_date : entry.buy_price_max_date;

        if (!current) {
            itemsData[itemKey][city] = {
                sellMin: entry.sell_price_min,
                buyMax: entry.buy_price_max,
                updateDate: entryDate,
                isLive: entry.is_live || false
            };
        } else {
            if (entry.sell_price_min > 0 && (current.sellMin === 0 || entry.sell_price_min < current.sellMin)) {
                current.sellMin = entry.sell_price_min;
                current.isLive = entry.is_live || false;
            }
            if (entry.buy_price_max > 0 && entry.buy_price_max > current.buyMax) {
                current.buyMax = entry.buy_price_max;
                current.isLive = entry.is_live || false;
            }
            if (entryDate > '0001' && entryDate > current.updateDate) {
                current.updateDate = entryDate;
                current.isLive = entry.is_live || false;
            }
        }
    });

    const trades = [];
    for (const [itemKey, citiesObj] of Object.entries(itemsData)) {
        const lastUnderscore = itemKey.lastIndexOf('_');
        const itemId = itemKey.substring(0, lastUnderscore);
        const quality = itemKey.substring(lastUnderscore + 1);

        const availableCities = Object.keys(citiesObj);
        for (let i = 0; i < availableCities.length; i++) {
            for (let j = 0; j < availableCities.length; j++) {
                if (i === j) continue;

                const cityBuy = availableCities[i];
                const citySell = availableCities[j];

                // Can't buy from black market
                if (cityBuy === "Black Market") continue;

                const priceToBuy = citiesObj[cityBuy].sellMin;
                const priceToSell = citiesObj[citySell].buyMax;

                if (priceToBuy > 0 && priceToSell > 0) {
                    const tax = priceToSell * TAX_RATE;
                    const netProfit = priceToSell - priceToBuy - tax;
                    if (netProfit > 0 || isSingleItemMode) {
                        const dateBuy = citiesObj[cityBuy].updateDate;
                        const dateSell = citiesObj[citySell].updateDate;
                        const oldestUpdate = (dateBuy < dateSell) ? dateBuy : dateSell;

                        const liveTag = (citiesObj[cityBuy].isLive || citiesObj[citySell].isLive) ? true : false;

                        trades.push({
                            itemId, quality, buyCity: cityBuy, sellCity: citySell,
                            buyPrice: priceToBuy, sellPrice: priceToSell,
                            tax, profit: netProfit, roi: (netProfit / priceToBuy) * 100,
                            updateDate: oldestUpdate,
                            isLive: liveTag,
                            buyIsLive: citiesObj[cityBuy].isLive || false,
                            sellIsLive: citiesObj[citySell].isLive || false
                        });
                    }
                }
            }
        }
    }
    return trades.sort((a, b) => b.profit - a.profit).slice(0, 50);
}

function processCrafting(data, isSingleItemMode = false) {
    const prices = {};
    const includeBM = toggleBlackMarket.checked;
    const sq = qualitySelect.value;

    data.forEach(entry => {
        if (sq !== 'all' && entry.quality.toString() !== sq) return;
        if (entry.sell_price_min === 0) return;
        if (!prices[entry.item_id]) prices[entry.item_id] = {};
        if (!prices[entry.item_id][entry.quality]) prices[entry.item_id][entry.quality] = {};

        let city = entry.city;
        if (city && city.includes("Black Market")) city = "Black Market";
        if (!CITIES.includes(city)) return;
        if (!includeBM && city === "Black Market") return;

        let current = prices[entry.item_id][entry.quality][city];
        const entryDate = entry.sell_price_min_date > entry.buy_price_max_date ? entry.sell_price_min_date : entry.buy_price_max_date;

        if (!current) {
            prices[entry.item_id][entry.quality][city] = {
                sell: entry.sell_price_min,
                buy: entry.buy_price_max,
                updateDate: entryDate,
                isLive: entry.is_live || false
            };
        } else {
            if (entry.sell_price_min > 0 && (current.sell === 0 || entry.sell_price_min < current.sell)) {
                current.sell = entry.sell_price_min;
                current.isLive = entry.is_live || false;
            }
            if (entry.buy_price_max > 0 && entry.buy_price_max > current.buy) {
                current.buy = entry.buy_price_max;
                current.isLive = entry.is_live || false;
            }
            if (entryDate > '0001' && entryDate > current.updateDate) {
                current.updateDate = entryDate;
                current.isLive = entry.is_live || false;
            }
        }
    });

    const crafts = [];

    for (const [finishedItem, recipe] of Object.entries(recipesData)) {
        if (!prices[finishedItem]) continue;

        for (const [quality, citiesObj] of Object.entries(prices[finishedItem])) {
            let bestSellCity = null;
            let bestSellPrice = 0;
            let finalItemUpdateDate = "0001-01-01T00:00:00";
            let finalItemLive = false;
            for (const city of Object.keys(citiesObj)) {
                if (citiesObj[city].buy > bestSellPrice) {
                    bestSellPrice = citiesObj[city].buy;
                    bestSellCity = city;
                    finalItemUpdateDate = citiesObj[city].updateDate;
                    finalItemLive = citiesObj[city].isLive;
                }
            }

            if (bestSellPrice === 0) continue;

            let totalMatCost = 0;
            let missingMat = false;
            const matBreakdown = [];

            for (const mat of recipe.materials) {
                if (!prices[mat.id]) { missingMat = true; break; }

                let bestBuyCity = null;
                let bestBuyPrice = Infinity;
                let matUpdateDate = "0001-01-01T00:00:00";
                let matIsLive = false;

                for (const [matQual, matCities] of Object.entries(prices[mat.id])) {
                    for (const city of Object.keys(matCities)) {
                        if (city === "Black Market") continue;
                        if (matCities[city].sell > 0 && matCities[city].sell < bestBuyPrice) {
                            bestBuyPrice = matCities[city].sell;
                            bestBuyCity = city;
                            matUpdateDate = matCities[city].updateDate;
                            matIsLive = matCities[city].isLive;
                        }
                    }
                }

                if (bestBuyPrice === Infinity) { missingMat = true; break; }

                const cost = bestBuyPrice * mat.qty;
                totalMatCost += cost;
                matBreakdown.push({
                    id: mat.id,
                    qty: mat.qty,
                    city: bestBuyCity,
                    unitPrice: bestBuyPrice,
                    total: cost,
                    updateDate: matUpdateDate,
                    isLive: matIsLive
                });
            }

            if (missingMat) continue;

            const tax = bestSellPrice * TAX_RATE;
            const netProfit = bestSellPrice - totalMatCost - tax;

            if (netProfit > 0 || isSingleItemMode) {

                let oldestDate = finalItemUpdateDate;
                let isAnyLive = finalItemLive;

                for (const mat of matBreakdown) {
                    if (mat.updateDate < oldestDate) oldestDate = mat.updateDate;
                    if (mat.isLive) isAnyLive = true;
                }

                crafts.push({
                    itemId: finishedItem,
                    quality: quality,
                    sellCity: bestSellCity,
                    sellPrice: bestSellPrice,
                    matCost: totalMatCost,
                    mats: matBreakdown,
                    tax,
                    profit: netProfit,
                    roi: (netProfit / totalMatCost) * 100,
                    updateDate: oldestDate,
                    isLive: isAnyLive,
                    sellIsLive: finalItemLive || false
                });
            }
        }
    }

    return crafts.sort((a, b) => b.profit - a.profit).slice(0, 50);
}

function setupGraphButtons(container) {
    const btns = container.querySelectorAll('.btn-graph');
    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            const itemId = btn.getAttribute('data-item');
            showGraph(itemId);
        });
    });
}

function setupRefreshButtons(container) {
    const btns = container.querySelectorAll('.btn-refresh-item');
    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            const itemId = btn.getAttribute('data-item');
            searchInput.value = getFriendlyName(itemId);
            searchExactId = itemId;
            btnRefresh.click();
        });
    });
}

function renderArbitrage(trades, isSingleItemMode = false) {
    resultsArbitrage.innerHTML = '';
    if (trades.length === 0) {
        resultsArbitrage.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: var(--text-secondary);">${isSingleItemMode ? "No market data found for this item." : "No profitable routes found."}</p>`;
        return;
    }
    // Result count badge
    const countBadge = document.createElement('div');
    countBadge.className = 'result-count-bar';
    countBadge.innerHTML = `Showing <strong>${trades.length}</strong> routes`;
    resultsArbitrage.appendChild(countBadge);

    trades.forEach(trade => {
        const clone = templateArbitrage.content.cloneNode(true);
        clone.querySelector('.btn-graph').setAttribute('data-item', trade.itemId);
        clone.querySelector('.btn-refresh-item').setAttribute('data-item', trade.itemId);
        clone.querySelector('.item-name').textContent = getFriendlyName(trade.itemId);
        clone.querySelector('.item-quality').textContent = getQualityName(trade.quality);
        clone.querySelector('.item-icon').src = `https://render.albiononline.com/v1/item/${trade.itemId}.png`;
        clone.querySelector('.buy-city .city-name').textContent = trade.buyCity;
        clone.querySelector('.sell-city .city-name').textContent = trade.sellCity;
        clone.querySelector('.buy-price').innerHTML = `${Math.floor(trade.buyPrice).toLocaleString()} 💰${trade.buyIsLive ? ' <span class="live-indicator" title="Scanned Live">⚡</span>' : ''}`;
        clone.querySelector('.sell-price').innerHTML = `${Math.floor(trade.sellPrice).toLocaleString()} 💰${trade.sellIsLive ? ' <span class="live-indicator" title="Scanned Live">⚡</span>' : ''}`;
        clone.querySelector('.tax-amount').textContent = `-${Math.floor(trade.tax).toLocaleString()} 💰`;
        const profAmt = clone.querySelector('.profit-amount');
        profAmt.textContent = `${Math.floor(trade.profit).toLocaleString()} 💰`;
        if (trade.profit < 0) {
            profAmt.classList.remove('text-green');
            profAmt.classList.add('text-red');
        }

        const roiAmt = clone.querySelector('.roi-percent');
        roiAmt.textContent = `${trade.roi.toFixed(1)}%`;
        if (trade.roi < 0) {
            roiAmt.classList.add('text-red');
        }

        const timeAgoEl = clone.querySelector('.time-ago');
        if (trade.isLive) {
            timeAgoEl.innerHTML = `<span style="color:var(--accent); font-weight:bold; text-shadow: 0 0 5px var(--accent);">⚡ SCANNED LIVE</span>`;
        } else {
            timeAgoEl.textContent = `Updated: ${timeAgo(trade.updateDate)}`;
        }

        resultsArbitrage.appendChild(clone);
    });
    setupGraphButtons(resultsArbitrage);
    setupRefreshButtons(resultsArbitrage);
}

function renderCrafting(crafts, isSingleItemMode = false) {
    resultsCrafting.innerHTML = '';
    if (crafts.length === 0) {
        resultsCrafting.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: var(--text-secondary);">${isSingleItemMode ? "No recipe or market data found for this item." : "No profitable recipes found."}</p>`;
        return;
    }
    // Result count badge
    const countBadge = document.createElement('div');
    countBadge.className = 'result-count-bar';
    countBadge.innerHTML = `Showing <strong>${crafts.length}</strong> recipes`;
    resultsCrafting.appendChild(countBadge);

    crafts.forEach(craft => {
        const clone = templateCrafting.content.cloneNode(true);
        clone.querySelector('.btn-graph').setAttribute('data-item', craft.itemId);
        clone.querySelector('.btn-refresh-item').setAttribute('data-item', craft.itemId);
        clone.querySelector('.item-name').textContent = getFriendlyName(craft.itemId);
        clone.querySelector('.item-quality').textContent = getQualityName(craft.quality);
        clone.querySelector('.item-icon').src = `https://render.albiononline.com/v1/item/${craft.itemId}.png`;

        const matContainer = clone.querySelector('.mats-container');
        craft.mats.forEach(mat => {
            const row = document.createElement('div');
            row.className = 'mat-item';
            row.innerHTML = `
                <div class="mat-info">
                    <img class="mat-icon" src="https://render.albiononline.com/v1/item/${mat.id}.png" alt="mat">
                    <span>${mat.qty}x ${getFriendlyName(mat.id)} <small style="color:var(--text-secondary)">from ${mat.city}</small>${mat.isLive ? ' <span class="live-indicator" title="Scanned Live">⚡</span>' : ''}</span>
                </div>
                <span>${mat.total.toLocaleString()} 💰</span>
            `;
            matContainer.appendChild(row);
        });

        clone.querySelector('.total-mat-cost span').textContent = `${Math.floor(craft.matCost).toLocaleString()} 💰`;
        clone.querySelector('.sell-route .city-name').textContent = craft.sellCity;
        clone.querySelector('.sell-price').innerHTML = `${Math.floor(craft.sellPrice).toLocaleString()} 💰${craft.sellIsLive ? ' <span class="live-indicator" title="Scanned Live">⚡</span>' : ''}`;
        clone.querySelector('.tax-amount').textContent = `-${Math.floor(craft.tax).toLocaleString()} 💰`;
        const profAmt = clone.querySelector('.profit-amount');
        profAmt.textContent = `${Math.floor(craft.profit).toLocaleString()} 💰`;
        if (craft.profit < 0) {
            profAmt.classList.remove('text-green');
            profAmt.classList.add('text-red');
        }

        const roiAmt = clone.querySelector('.roi-percent');
        roiAmt.textContent = `${craft.roi.toFixed(1)}%`;
        if (craft.roi < 0) {
            roiAmt.classList.add('text-red');
        }
        const timeAgoEl = clone.querySelector('.time-ago');
        if (craft.isLive) {
            timeAgoEl.innerHTML = `<span style="color:var(--accent); font-weight:bold; text-shadow: 0 0 5px var(--accent);">⚡ SCANNED LIVE</span>`;
        } else {
            timeAgoEl.textContent = `Updated: ${timeAgo(craft.updateDate)}`;
        }

        resultsCrafting.appendChild(clone);
    });
    setupGraphButtons(resultsCrafting);
    setupRefreshButtons(resultsCrafting);
}

async function showGraph(itemId) {
    chartModal.classList.remove('hidden');
    chartTitle.textContent = `Loading history for ${itemId.replace(/_/g, ' ')}...`;

    if (priceChartInstance) {
        priceChartInstance.destroy();
    }

    const server = document.getElementById('server-select').value;
    try {
        const response = await fetch(`${CHART_API_URLS[server]}/${itemId}.json?time-scale=24`);
        if (!response.ok) throw new Error("Failed to fetch chart data");
        const data = await response.json();

        if (data.length === 0 || !data[0].data || !data[0].data.timestamps) {
            chartTitle.textContent = "No history available";
            return;
        }

        chartTitle.textContent = `${itemId.replace(/_/g, ' ')} Volume & Avg Price (Last 30 Days)`;

        // We'll aggregate cities or just pick the first main data blob
        // Usually index 0 is the primary city data or an aggregate
        const timestamps = data[0].data.timestamps.slice(-30); // Last 30 points
        const prices = data[0].data.prices_avg.slice(-30);

        const labels = timestamps.map(ts => new Date(ts).toLocaleDateString());
        const avgPrices = prices;

        priceChartInstance = new Chart(ctxChart, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Average Price',
                    data: avgPrices,
                    borderColor: '#d4af37',
                    backgroundColor: 'rgba(212, 175, 55, 0.2)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: false,
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    },
                    x: {
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: '#e0e0e0' }
                    }
                }
            }
        });

    } catch (e) {
        chartTitle.textContent = "Error loading graph: " + e.message;
    }
}

function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.classList.remove('hidden');
    spinner.classList.add('hidden');
}

btnRefresh.addEventListener('click', async () => {
    if (itemsList.length === 0) await loadData();

    errorMessage.classList.add('hidden');
    resultsArbitrage.innerHTML = '';
    resultsCrafting.innerHTML = '';
    spinner.classList.remove('hidden');

    const server = document.getElementById('server-select').value;
    const category = categorySelect.value;

    let searchVal = searchInput.value.trim();
    if (searchExactId) {
        searchVal = searchExactId;
    } else if (searchVal) {
        // Fallback: if user typed something but didn't click dropdown, attempt to find exact match
        const manualMatch = itemsList.find(i => getFriendlyName(i).toLowerCase() === searchVal.toLowerCase() || i.toLowerCase() === searchVal.toLowerCase());
        if (manualMatch) searchVal = manualMatch;
        else searchVal = searchVal.toUpperCase();
    }

    let itemsToFetch = [];
    let isSingleItemMode = false;

    if (searchVal !== '') {
        isSingleItemMode = true;
        // Custom single item search overrides everything
        itemsToFetch = [searchVal];
        // If it's a known recipe, make sure we fetch its mats too if we are in crafting mode
        if (currentMode === 'crafting' && recipesData[searchVal]) {
            recipesData[searchVal].materials.forEach(m => itemsToFetch.push(m.id));
        }
    } else {
        if (currentMode === 'crafting') {
            const recipeSet = new Set();
            for (const [finishedItem, recipe] of Object.entries(recipesData)) {
                recipeSet.add(finishedItem);
                recipe.materials.forEach(m => recipeSet.add(m.id));
            }
            itemsToFetch = Array.from(recipeSet);
        } else {
            itemsToFetch = filterItemsByCategory(category);
        }
    }

    if (itemsToFetch.length === 0) {
        showError("No items found to fetch.");
        return;
    }

    if (itemsToFetch.length > 500) {
        showError(`Cannot fetch ${itemsToFetch.length} items at once to prevent API abuse. Please select a specific category or search for a single item.`);
        return;
    }

    try {
        const data = await fetchMarketData(server, itemsToFetch);
        spinner.classList.add('hidden');

        if (currentMode === 'arbitrage') {
            const topTrades = processArbitrage(data, isSingleItemMode);
            renderArbitrage(topTrades, isSingleItemMode);
        } else {
            const topCrafts = processCrafting(data, isSingleItemMode);
            renderCrafting(topCrafts, isSingleItemMode);
        }
    } catch (e) {
        showError("Error fetching data: " + e.message);
    }
});

// Init
window.addEventListener('load', loadData);

// Companion status polling
async function checkCompanionStatus() {
    const el = document.getElementById('companion-status');
    if (!el) return;
    try {
        const res = await fetch('http://localhost:8081/api/stats');
        if (res.ok) {
            const data = await res.json();
            el.classList.remove('offline');
            el.classList.add('online');
            el.querySelector('.status-text').textContent = `Companion: Online (${data.cached_items} items cached)`;
        } else {
            throw new Error('not ok');
        }
    } catch (e) {
        el.classList.remove('online');
        el.classList.add('offline');
        el.querySelector('.status-text').textContent = 'Companion: Offline';
    }
}
checkCompanionStatus();
setInterval(checkCompanionStatus, 10000);
