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
// === TAX + CRAFTING CONFIG ===
// Tax rates depend on Premium status (per 2023 Lands Awakened + forum 169251 / devtracker 510446ae).
// Premium: 4% instant-sell (to buy orders), 4% + 2.5% setup = 6.5% sell-order.
// Non-Premium: 8% instant-sell, 8% + 2.5% setup = 10.5% sell-order.
// (Previous 3%/5.5% hardcode was stale pre-2021 data and under-projected tax by 33-167%.)
// TAX_RATE/SETUP_FEE are `let` so Premium toggle live-updates every existing reference.
let TAX_RATE = 0.04;        // Current active insta-sell / market tax (premium default)
const SETUP_FEE = 0.025;    // 2.5% listing setup fee (applied on sell orders only)

// Runtime crafting/refining config — persisted to localStorage, shared across tabs
const CraftConfig = {
    premium: true,              // assume premium; first-interaction persists
    craftingBasePB: 18,         // DECISION-A1: sources disagree 15 vs 18; default 18, user-configurable
    refiningBasePB: 18,         // refining is unambiguous at 18
    foodBuff: 'none',           // 'none' | 'pork' (T6, +18% focus eff) | 'avalonian' (T8, +30%)
    qualityEV: false,           // toggle weighted-avg sell across quality distribution
    stationSilverPer100: 200,   // default station "silver per 100 nutrition" — typical city prime
    liquidityMin: 50,           // default daily-volume gate for Top-N ranker (items/day)
};

function loadCraftConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem('craftConfig_v1') || '{}');
        Object.assign(CraftConfig, saved);
    } catch {}
    TAX_RATE = CraftConfig.premium ? 0.04 : 0.08;
}
function saveCraftConfig() {
    try { localStorage.setItem('craftConfig_v1', JSON.stringify(CraftConfig)); } catch {}
    TAX_RATE = CraftConfig.premium ? 0.04 : 0.08;
}
function setPremium(isPremium) {
    CraftConfig.premium = !!isPremium;
    saveCraftConfig();
}

// --- City Specialty Map (DECISION-A2) ---
// Applies +15/+20% production bonus in Royal cities / +20% Caerleon when recipe category matches.
// Refining specialty = +40% PB when raw material family matches city.
const CITY_CRAFT_SPECIALTY = {
    'Lymhurst':       { categories: ['bow','cursedstaff','mage_robe','mage_shoes','mage_helmet'], bonus: 15, label: 'Cloth Armor, Bow, Cursed' },
    'Bridgewatch':    { categories: ['crossbow','dagger','plate_helmet','plate_shoes','plate_armor','cursedstaff'], bonus: 15, label: 'Plate Armor, Crossbow, Dagger' },
    'Fort Sterling':  { categories: ['hammer','quarterstaff','holystaff','plate_helmet','plate_shoes','plate_armor'], bonus: 15, label: 'Plate, Hammer, Quarterstaff' },
    'Thetford':       { categories: ['cursedstaff','firestaff','leather_helmet','leather_shoes','leather_armor','mage_helmet','mage_robe','mage_shoes'], bonus: 15, label: 'Cloth Armor, Fire, Cursed' },
    'Martlock':       { categories: ['axe','quarterstaff','froststaff','leather_helmet','leather_shoes','leather_armor'], bonus: 15, label: 'Leather, Axe, Frost' },
    'Caerleon':       { categories: ['cape','bag','offhand_torch','offhand_book','offhand_shield','food','naturestaff','arcanestaff','holystaff','firestaff','froststaff','cursedstaff'], bonus: 20, label: 'Capes, Bags, Magic Staves' },
    'Brecilien':      { categories: [], bonus: 0, label: 'No crafting specialty' },
};
// Raw material → refining specialty city
const CITY_REFINE_SPECIALTY = {
    'Fort Sterling':  { family: 'WOOD',   refined: 'PLANKS',     bonus: 40 },
    'Thetford':       { family: 'ORE',    refined: 'METALBAR',   bonus: 40 },
    'Lymhurst':       { family: 'FIBER',  refined: 'CLOTH',      bonus: 40 },
    'Bridgewatch':    { family: 'HIDE',   refined: 'LEATHER',    bonus: 40 },
    'Martlock':       { family: 'ROCK',   refined: 'STONEBLOCK', bonus: 40 },
    'Caerleon':       { family: null,    refined: null,         bonus: 0  },
    'Brecilien':      { family: null,    refined: null,         bonus: 0  },
};

// Heuristic category-from-itemId (used when recipe doesn't carry the specific slot).
// Falls back through known patterns in the Albion item-id namespace.
function detectRecipeCategory(itemId) {
    if (!itemId) return null;
    const id = itemId.toUpperCase();
    if (id.includes('2H_BOW') || id.includes('_BOW_')) return 'bow';
    if (id.includes('CROSSBOW')) return 'crossbow';
    if (id.includes('AXE')) return 'axe';
    if (id.includes('HAMMER')) return 'hammer';
    if (id.includes('DAGGER')) return 'dagger';
    if (id.includes('QUARTERSTAFF') || id.includes('_SPEAR_') || id.includes('SPEAR')) return 'quarterstaff';
    if (id.includes('HOLYSTAFF')) return 'holystaff';
    if (id.includes('FIRESTAFF')) return 'firestaff';
    if (id.includes('FROSTSTAFF')) return 'froststaff';
    if (id.includes('CURSEDSTAFF')) return 'cursedstaff';
    if (id.includes('NATURESTAFF')) return 'naturestaff';
    if (id.includes('ARCANESTAFF')) return 'arcanestaff';
    if (id.includes('_SHIELD')) return 'offhand_shield';
    if (id.includes('_BOOK') || id.includes('TOME_')) return 'offhand_book';
    if (id.includes('_TORCH')) return 'offhand_torch';
    if (id.includes('PLATE_SET1') || id.includes('ARMOR_PLATE')) return 'plate_armor';
    if (id.includes('PLATE_HEAD') || id.includes('HEAD_PLATE')) return 'plate_helmet';
    if (id.includes('PLATE_SHOES') || id.includes('SHOES_PLATE')) return 'plate_shoes';
    if (id.includes('LEATHER_SET1') || id.includes('ARMOR_LEATHER')) return 'leather_armor';
    if (id.includes('LEATHER_HEAD') || id.includes('HEAD_LEATHER')) return 'leather_helmet';
    if (id.includes('LEATHER_SHOES') || id.includes('SHOES_LEATHER')) return 'leather_shoes';
    if (id.includes('CLOTH_SET1') || id.includes('ARMOR_CLOTH')) return 'mage_robe';
    if (id.includes('CLOTH_HEAD') || id.includes('HEAD_CLOTH')) return 'mage_helmet';
    if (id.includes('CLOTH_SHOES') || id.includes('SHOES_CLOTH')) return 'mage_shoes';
    if (id.includes('CAPEITEM_') || id.includes('_CAPE')) return 'cape';
    if (id.includes('_BAG')) return 'bag';
    if (id.includes('MEAL_') || id.includes('_POTION')) return 'food';
    return null;
}

// City craft bonus auto-detect: returns {bonus, reason, autoApplied} given city+item.
function getCityCraftBonus(cityName, itemId) {
    const specialty = CITY_CRAFT_SPECIALTY[cityName];
    if (!specialty) return { bonus: 0, reason: '', autoApplied: false };
    const cat = detectRecipeCategory(itemId);
    if (!cat) return { bonus: 0, reason: '', autoApplied: false };
    if (specialty.categories.includes(cat)) {
        return { bonus: specialty.bonus, reason: `${cityName} specialty (${cat})`, autoApplied: true };
    }
    return { bonus: 0, reason: '', autoApplied: false };
}

// Refining city bonus: T6_PLANKS @ Fort Sterling = 40% PB
function getCityRefineBonus(cityName, itemId) {
    const specialty = CITY_REFINE_SPECIALTY[cityName];
    if (!specialty || !specialty.family) return { bonus: 0, reason: '', autoApplied: false };
    const id = itemId.toUpperCase();
    // Match on "refined" suffix: T6_PLANKS, T6_METALBAR etc.
    if (specialty.refined && id.includes('_' + specialty.refined)) {
        return { bonus: specialty.bonus, reason: `${cityName} refining specialty`, autoApplied: true };
    }
    return { bonus: 0, reason: '', autoApplied: false };
}

// --- Item Value (DECISION-A5) ---
// Per wiki Item_Value page: sum of non-artifact material values + artifact values at item's tier.
// Base unit = 16 × 2^(tier + enchant - 4). T4=16, T5=32, T6=64, T7=128, T8=256 (enchant 0).
const IV_BASE = (tier, ench) => 16 * Math.pow(2, Math.max(0, tier + ench - 4));
// Crude artifact detector: artifact material IDs typically contain ARTEFACT or specific suffixes.
function isArtifactId(id) {
    if (!id) return false;
    const u = id.toUpperCase();
    return u.includes('ARTEFACT') || u.includes('RUNE_') || u.includes('SOUL_') || u.includes('RELIC_') || u.includes('AVALONIAN_');
}
function parseTierEnch(itemId) {
    const m = /^T(\d)/.exec(itemId || '');
    const tier = m ? parseInt(m[1]) : 0;
    const em = /@(\d)/.exec(itemId || '');
    const ench = em ? parseInt(em[1]) : 0;
    return { tier, ench };
}
function itemValue(itemId) {
    const recipe = recipesData[itemId];
    if (!recipe || !recipe.materials) return 0;
    const { tier, ench } = parseTierEnch(itemId);
    if (!tier) return 0;
    const base = IV_BASE(tier, ench);
    let nonArtifactMats = 0;
    let artifactValue = 0;
    for (const m of recipe.materials) {
        if (isArtifactId(m.id)) {
            // Artifact material: rough IV = 16 × 2^(matTier + matEnch - 4) × artifact premium (~5×)
            const mt = parseTierEnch(m.id);
            artifactValue += IV_BASE(mt.tier || tier, mt.ench || ench) * 5 * (m.qty || 1);
        } else {
            nonArtifactMats += (m.qty || 0);
        }
    }
    return Math.round(nonArtifactMats * base + artifactValue);
}

// --- Station fee (DECISION-A6) ---
// Station fee per craft = ItemValue × 0.1125 × (silverPer100Nutrition / 100)
function stationFeePerCraft(itemId, silverPer100Nutrition) {
    const iv = itemValue(itemId);
    const sp100 = (silverPer100Nutrition == null ? CraftConfig.stationSilverPer100 : silverPer100Nutrition);
    return Math.round(iv * 0.1125 * (sp100 / 100));
}

// --- Focus formula (DECISION-A3) ---
// Correct exponential: cost = base × 0.5^(efficiency/10000)
// efficiency = masteryLevel × 30 + mainSpecLevel × 250 + otherSpecLevels × 30
// Food buffs (Pork +18%, Avalonian +30%) multiply efficiency by 1.18 / 1.30.
function calculateFocusCostV2(baseCost, mainSpecLevel, masteryLevel, otherSpecLevels = 0, foodBuff = null) {
    if (!baseCost || baseCost <= 0) return 0;
    const buff = foodBuff || CraftConfig.foodBuff || 'none';
    const buffMult = buff === 'avalonian' ? 1.30 : (buff === 'pork' ? 1.18 : 1.0);
    const efficiency = (masteryLevel * 30 + mainSpecLevel * 250 + otherSpecLevels * 30) * buffMult;
    return Math.max(1, Math.ceil(baseCost * Math.pow(0.5, efficiency / 10000)));
}

// --- Quality distribution (DECISION-A7) ---
// Base table (wiki, forum 67684): Normal 68.9%, Good 25.0%, Outstanding 5.0%, Excellent 1.0%, Masterpiece 0.1%
// Each +100 quality points from spec/city/food = 1 re-roll. Maxed ≈ 50% Outstanding+.
const QUALITY_BASE_DIST = [0.689, 0.250, 0.050, 0.010, 0.001];
function qualityDistribution(qualityPoints = 0) {
    // qualityPoints divided by 100 = rerolls (keep best). Approximation: shift mass rightward.
    const rerolls = Math.max(0, Math.min(5, qualityPoints / 100));
    const dist = QUALITY_BASE_DIST.slice();
    if (rerolls > 0) {
        // For each reroll, P(at least one ≥ Q) = 1 - (1 - P(single ≥ Q))^(1 + rerolls)
        // Work from the tail down.
        let cumAbove = 0; // cumulative prob of Q+ (starting from masterpiece)
        const tailProbs = [];
        for (let q = 4; q >= 0; q--) {
            const singleQPlus = dist[q] + cumAbove;
            const rerolledQPlus = 1 - Math.pow(1 - singleQPlus, 1 + rerolls);
            tailProbs[q] = rerolledQPlus;
            cumAbove += dist[q];
        }
        // Convert back to per-quality
        const out = [0, 0, 0, 0, 0];
        for (let q = 0; q < 5; q++) {
            const qPlus = tailProbs[q] || 0;
            const qPlusNext = (q < 4 ? tailProbs[q + 1] : 0) || 0;
            out[q] = Math.max(0, qPlus - qPlusNext);
        }
        out[0] = Math.max(0, 1 - out[1] - out[2] - out[3] - out[4]); // renormalise
        return out;
    }
    return dist;
}
function qualityEVPrice(pricesByQuality, qualityPoints = 0) {
    // pricesByQuality: { 1: price, 2: price, 3: price, 4: price, 5: price }
    if (!pricesByQuality) return 0;
    const dist = qualityDistribution(qualityPoints);
    let ev = 0;
    for (let q = 1; q <= 5; q++) {
        const p = pricesByQuality[q] || pricesByQuality[1] || 0; // fall back to Q1 if quality price missing
        ev += p * dist[q - 1];
    }
    return Math.round(ev);
}

// --- Focus costs lookup (refining + crafting base values) ---
// Research-derived per-tier base focus; verify at one tier in-game after rollout.
const FOCUS_COSTS = {
    refining: {
        2: 1, 3: 3, 4: 48, 5: 96, 6: 192, 7: 384, 8: 768,
    },
    crafting: {
        4: 14, 5: 30, 6: 62, 7: 126, 8: 254,
    },
};
function baseFocusForItem(itemId, activity /* 'crafting' | 'refining' */) {
    const { tier, ench } = parseTierEnch(itemId);
    if (!tier) return 0;
    // Enchanted items cost 2^ench × base
    const tierBase = (FOCUS_COSTS[activity] && FOCUS_COSTS[activity][tier]) || 0;
    return Math.round(tierBase * Math.pow(2, ench));
}

// --- Effective tax rate helper ---
function effectiveTaxRate(sellMode /* 'instant' | 'order' */) {
    return sellMode === 'instant' ? TAX_RATE : (TAX_RATE + SETUP_FEE);
}

// Transport mount carry-weight table — corrected 2026-04-18 audit.
// Previous values were 5-10x too low (T7 Ox 1262 vs wiki 2667, T8 Mammoth 1764 vs wiki 22521!).
// Per-mount max load from wiki (Grandmaster's Transport Ox, Elder's Transport Mammoth pages).
// "none" = player base carry capacity with a standard bag (600 kg).
const MOUNT_DATA = {
    'none':            { weight: 600,   label: 'No Mount' },
    'mule':            { weight: 360,   label: 'Mule' },
    'horse_t3':        { weight: 520,   label: 'T3 Riding Horse' },
    'ox_t3':           { weight: 1200,  label: 'T3 Journeyman\'s Transport Ox' },
    'ox_t4':           { weight: 1600,  label: 'T4 Adept\'s Transport Ox' },
    'ox_t5':           { weight: 2000,  label: 'T5 Expert\'s Transport Ox' },
    'ox_t6':           { weight: 2400,  label: 'T6 Master\'s Transport Ox' },
    'ox_t7':           { weight: 2667,  label: 'T7 Grandmaster\'s Transport Ox' },
    'ox_t8':           { weight: 3200,  label: 'T8 Elder\'s Transport Ox' },
    'swiftclaw':       { weight: 900,   label: 'T5 Swiftclaw (hybrid)' },
    'moose':           { weight: 1400,  label: 'T6 Moose (combat mount)' },
    'giant_stag':      { weight: 1600,  label: 'T7 Giant Stag (medium load)' },
    'grizzly_bear':    { weight: 2200,  label: 'T7 Grizzly Bear (combat+haul)' },
    'mammoth_t8':      { weight: 22521, label: 'T8 Elder\'s Transport Mammoth', extraSlots: 8 },
    'mammoth_saddled': { weight: 22521, label: 'T8 Saddled Mammoth', extraSlots: 8 },
    'ignore':          { weight: Infinity, label: 'Ignore Weight' },
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

const DEBUG = false;

// ====== STATE ======
let ITEM_NAMES = {};
let ITEM_WEIGHTS = {};
// Numeric item ID → string ID (e.g. "1954" → "T4_RUNE"). Fallback resolver for
// loot events coming from an out-of-date Go client where itemmap.json wasn't
// loaded — the client stamps "UNKNOWN_<numericID>" as item_id but still sends
// numeric_id, so we can recover the real string ID here.
let NUMERIC_ITEM_MAP = {};
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

function invalidatePriceCache() {
    _priceCache = null;
    _priceCacheTime = 0;
    // Re-render active tab if it depends on prices
    if (currentTab === 'browser') renderBrowser();
}
let compareSelectedId = null;
let arbSearchExactId = null;
let craftSearchExactId = null;
let priceChartInstance = null;
let vpsGameServer = 'europe'; // detected from VPS on init; used to skip VPS cache reload when on a different server
let analyticsChartInstance = null;
let scanAbortController = null;
let spreadStatsCache = {}; // keyed by "itemId_quality_buyCity_sellCity"
const SPREAD_STATS_CACHE_MAX = 2000; // FE-M1: evict oldest batch when over limit
const analyticsCache = new Map(); // keyed by itemId, value: { price_trend, latest_price } | 'pending'
const ANALYTICS_CACHE_MAX = 500; // evict oldest entries when over limit
let spreadStatsCacheTime = 0;
let discordUser = null; // stored on auth check for contribution tracking

// ====== UTILITY ======
function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Toast notification system — replaces alert()/confirm()
const _activeToasts = [];
const MAX_VISIBLE_TOASTS = 5;

function showToast(message, type = 'info', duration = 4000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    // Remove oldest toast if we exceed the max
    while (_activeToasts.length >= MAX_VISIBLE_TOASTS) {
        const oldest = _activeToasts.shift();
        if (oldest && oldest.parentNode) {
            oldest.classList.remove('show');
            setTimeout(() => oldest.remove(), 300);
        }
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = esc(message);
    container.appendChild(toast);
    _activeToasts.push(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        const idx = _activeToasts.indexOf(toast);
        if (idx > -1) _activeToasts.splice(idx, 1);
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// CODE-L3: callback registry — avoids serialising function source into onclick attributes
const _toastCallbacks = {};
function _runToastCb(id) { try { _toastCallbacks[id]?.(); } finally { delete _toastCallbacks[id]; } }
function _runToastPrompt(id, inputId) {
    const v = document.getElementById(inputId)?.value ?? '';
    try { _toastCallbacks[id]?.(v); } finally { delete _toastCallbacks[id]; }
}

function showConfirm(message, onYes, autoMs) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    // UX-4: cap confirm dialogs at MAX_VISIBLE_TOASTS — dismiss oldest if exceeded
    const existing = container.querySelectorAll('.toast-confirm');
    if (existing.length >= MAX_VISIBLE_TOASTS) existing[0].remove();
    const cbId = 'cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    _toastCallbacks[cbId] = onYes;
    const toast = document.createElement('div');
    toast.className = 'toast toast-confirm show';
    toast.innerHTML = `<div style="margin-bottom:0.5rem;">${esc(message)}</div>
        <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
            <button class="btn-small" onclick="this.closest('.toast').remove()">Cancel</button>
            <button class="btn-small-danger" onclick="this.closest('.toast').remove(); _runToastCb('${cbId}')">Confirm</button>
        </div>`;
    container.appendChild(toast);
    if (autoMs) setTimeout(() => toast.remove(), autoMs);
    return toast;
}

function showPrompt(message, defaultValue, onSubmit) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    // UX-4: cap prompts at MAX_VISIBLE_TOASTS
    const existing = container.querySelectorAll('.toast-confirm');
    if (existing.length >= MAX_VISIBLE_TOASTS) existing[0].remove();
    const cbId = 'cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    _toastCallbacks[cbId] = onSubmit;
    const toast = document.createElement('div');
    toast.className = 'toast toast-confirm show';
    const inputId = 'show-prompt-input-' + Date.now();
    toast.innerHTML = `<div style="margin-bottom:0.5rem;">${esc(message)}</div>
        <input id="${inputId}" type="text" class="input-field" value="${esc(defaultValue || '')}" style="width:100%; margin-bottom:0.5rem;">
        <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
            <button class="btn-small" onclick="this.closest('.toast').remove()">Cancel</button>
            <button class="btn-small-accent" onclick="this.closest('.toast').remove(); _runToastPrompt('${cbId}', '${inputId}')">OK</button>
        </div>`;
    container.appendChild(toast);
    setTimeout(() => { const inp = document.getElementById(inputId); if (inp) { inp.focus(); inp.select(); } }, 50);
}

function getFriendlyName(id) {
    if (ITEM_NAMES[id] && ITEM_NAMES[id].trim() !== '') return ITEM_NAMES[id];
    // Display-time safety net for UNKNOWN_<n> items that slipped past the
    // ingestion-time normalizer (e.g. if NUMERIC_ITEM_MAP was still loading
    // when the event arrived). Look up the numeric suffix directly.
    if (typeof id === 'string' && id.startsWith('UNKNOWN_')) {
        const mapped = NUMERIC_ITEM_MAP[id.slice(8)];
        if (mapped && ITEM_NAMES[mapped] && ITEM_NAMES[mapped].trim() !== '') return ITEM_NAMES[mapped];
        if (mapped) return mapped; // at least show the string ID if no localized name
    }
    return id.replace(/_/g, ' ').replace(/T(\d+)/, 'Tier $1').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

// If an itemId arrives as "UNKNOWN_<numericID>" (friend's Go client was missing
// itemmap.json), recover the real string ID via numeric_id + NUMERIC_ITEM_MAP.
// Safe no-op when the id is already resolved or the numeric isn't in our map.
function rewriteUnknownItemId(itemId, numericId) {
    if (typeof itemId !== 'string' || !itemId.startsWith('UNKNOWN_')) return itemId;
    const n = parseInt(numericId != null ? numericId : itemId.slice(8), 10);
    if (!Number.isFinite(n) || n <= 0) return itemId;
    const mapped = NUMERIC_ITEM_MAP[String(n)];
    return (mapped && typeof mapped === 'string' && mapped.trim()) ? mapped : itemId;
}

// Normalize loot events in place — handles both snake_case (backend replay) and
// camelCase (direct WS relay) field shapes.
function normalizeLootEventInPlace(ev) {
    if (!ev || typeof ev !== 'object') return ev;
    if (typeof ev.item_id === 'string') ev.item_id = rewriteUnknownItemId(ev.item_id, ev.numeric_id);
    if (typeof ev.itemId === 'string')  ev.itemId  = rewriteUnknownItemId(ev.itemId, ev.numericId);
    return ev;
}

// Normalize a chest capture (and its nested items array) in place.
function normalizeChestCaptureInPlace(cap) {
    if (cap && Array.isArray(cap.items)) {
        for (const it of cap.items) {
            if (typeof it.itemId === 'string') it.itemId = rewriteUnknownItemId(it.itemId, it.numericId);
        }
    }
    return cap;
}

function getItemWeight(id) {
    return ITEM_WEIGHTS[id] || 0;
}

// Non-tradeable patterns — account-bound cosmetics, unlock tokens, avatar art, etc.
// The game sometimes leaks these into chest-tab slot maps (notably mount skin unlocks
// like UNIQUE_UNLOCK_SKIN_HORSE_*_TELLAFRIEND), so we filter them out of Loot Buyer
// captures. Same patterns as the Go client's IsNonTradeableItem.
function isNonTradeableItemId(itemId) {
    if (!itemId || typeof itemId !== 'string') return false;
    if (itemId.startsWith('UNIQUE_UNLOCK_')) return true;
    if (itemId.startsWith('SKIN_'))          return true;
    if (itemId.startsWith('UNIQUE_AVATAR'))  return true;
    if (itemId.startsWith('UNIQUE_HIDEOUT')) return true;
    if (itemId.startsWith('UNKNOWN_'))       return true;
    if (itemId.includes('_TELLAFRIEND'))     return true;
    return false;
}

function getQualityName(q) {
    const map = { '1': 'Normal', '2': 'Good', '3': 'Outstanding', '4': 'Excellent', '5': 'Masterpiece' };
    return map[String(q)] || 'Unknown';
}

function _computeTimeAgo(dateString) {
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

function timeAgo(dateString) {
    const text = _computeTimeAgo(dateString);
    if (!dateString || dateString.startsWith('0001')) return text;
    const ts = dateString.endsWith('Z') ? dateString : dateString + 'Z';
    return `<span class="time-ago" data-ts="${esc(ts)}">${text}</span>`;
}

function _computeFreshness(dateString) {
    if (!dateString || dateString.startsWith('0001')) return { cls: 'stale', title: 'No data', icon: '\u26AB' };
    const date = new Date(dateString.endsWith('Z') ? dateString : dateString + 'Z');
    const diffMins = Math.floor((new Date() - date) / 60000);
    if (diffMins < 30) return { cls: 'fresh', title: 'Updated < 30 min ago', icon: '\uD83D\uDFE2' };
    if (diffMins < 120) return { cls: 'aging', title: 'Updated 30m\u20132h ago', icon: '\uD83D\uDFE1' };
    return { cls: 'old', title: 'Updated > 2h ago', icon: '\uD83D\uDD34' };
}

function getFreshnessIndicator(dateString) {
    const f = _computeFreshness(dateString);
    if (!dateString || dateString.startsWith('0001')) return `<span class="freshness-dot ${f.cls}" title="${f.title}">${f.icon}</span>`;
    const ts = dateString.endsWith('Z') ? dateString : dateString + 'Z';
    return `<span class="freshness-dot ${f.cls}" title="${f.title}" data-ts-fresh="${esc(ts)}">${f.icon}</span>`;
}

// Auto-refresh freshness badges and time-ago labels every 60s
setInterval(() => {
    document.querySelectorAll('.time-ago[data-ts]').forEach(el => {
        el.textContent = _computeTimeAgo(el.dataset.ts);
    });
    document.querySelectorAll('.freshness-dot[data-ts-fresh]').forEach(el => {
        const f = _computeFreshness(el.dataset.tsFresh);
        el.className = `freshness-dot ${f.cls}`;
        el.title = f.title;
        el.textContent = f.icon;
    });
}, 60000);

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
    // Operator precedence fix — MAIN_ || 2H_ paired together, THEN excluded if TOOL_
    if ((id.includes('MAIN_') || id.includes('2H_')) && !id.includes('TOOL_')) {
        return 'weapons';
    }
    if (id.includes('TOOL_')) return 'other';
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
    if (getEquipmentSlot(itemId) !== null) return false;
    const id = (itemId || '').toUpperCase();
    // Non-stackable gear + content the old check missed — trophies, furniture, mount tokens, kill trophies,
    // labourer items, journals-filled, bags. These would otherwise produce absurd transport suggestions
    // like "buy 20k Mammoth kits" because isStackableItem falls back to 999-cap when it can't slot them.
    if (id.includes('TROPHY_')) return false;
    if (id.includes('UNIQUE_FURNITUREITEM_')) return false;
    if (id.includes('FURNITUREITEM_')) return false;
    if (id.includes('MOUNT_')) return false;
    if (id.includes('KILLTROPHY_')) return false;
    if (id.includes('LABORER_')) return false;
    if (id.includes('UNIQUE_HIDEOUT')) return false;
    if (/^T\d_BAG(_|$)/.test(id)) return false;  // bags are equipment-like, not stackable
    return true;
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
// loadData is called from many entry points (each tab's first-render, share
// handler, etc.). We memoize the in-flight promise so concurrent callers share
// one network round-trip rather than kicking off duplicates. Also lets callers
// `await loadData()` as a synchronization point when they need ITEM_NAMES /
// NUMERIC_ITEM_MAP to be populated before proceeding (e.g. the accountability
// normalizer relies on NUMERIC_ITEM_MAP).
let _loadDataPromise = null;
function loadData() {
    if (_loadDataPromise) return _loadDataPromise;
    _loadDataPromise = (async () => {
        try {
            const cb = '?v=' + Date.now();
            const [resItems, resRecipes, resWeights, resItemMap] = await Promise.all([
                fetch('items.json' + cb),
                fetch('recipes.json' + cb),
                fetch('itemweights.json' + cb).catch(() => ({ ok: false })),
                fetch('itemmap.json' + cb).catch(() => ({ ok: false }))
            ]);
            ITEM_NAMES = await resItems.json();
            itemsList = Object.keys(ITEM_NAMES).filter(k => k && ITEM_NAMES[k]);
            recipesData = await resRecipes.json();
            if (resWeights.ok) ITEM_WEIGHTS = await resWeights.json();
            if (resItemMap.ok) {
                try { NUMERIC_ITEM_MAP = await resItemMap.json(); } catch { NUMERIC_ITEM_MAP = {}; }
            }
        } catch (e) {
            console.error('Failed to load data files:', e);
            _loadDataPromise = null; // allow retry on next call
        }
    })();
    return _loadDataPromise;
}

// ====== API FETCHING ======
async function fetchMarketChunk(server, items) {
    if (items.length === 0) return [];
    const url = `${API_URLS[server]}/${items.join(',')}.json?v=${Date.now()}`;
    // FE-H4: abort after 30s so a slow/hanging market API never blocks indefinitely
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
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
            textEl.innerHTML = `${count.toLocaleString()} prices cached &bull; Last scan: ${timeStr}`;
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
            if (currentTab === 'loot-buyer') { renderLootCaptures(); loadTrackedTabs(); loadRecentSales(); initLootCombineBar(); }
            if (currentTab === 'loot-logger') { showLootLoggerMode('live'); }
            if (currentTab === 'crafting') {
                if (window._craftLastData && window._craftLastRecipe && window._craftLastItemId) {
                    document.getElementById('craft-settings').style.display = 'flex';
                    document.getElementById('craft-detail-view').style.display = 'block';
                    document.getElementById('craft-bulk-section').style.display = 'none';
                    renderCraftDetail(window._craftLastItemId, window._craftLastRecipe, window._craftLastData);
                }
            }
            if (currentTab === 'alerts') loadAlerts();
            if (currentTab === 'community') { if (typeof loadLeaderboard === 'function') loadLeaderboard(); }
            if (currentTab === 'portfolio') { if (typeof renderPortfolio === 'function') renderPortfolio(); }
            if (currentTab === 'craft-runs') initCraftRunsTab();
            // BENCHED: if (currentTab === 'mounts') { if (typeof renderMountsDatabase === 'function') renderMountsDatabase(); }
            // Tab name is 'farming' in data-tab, NOT 'farm' — this guard never fired before this fix.
            if (currentTab === 'farming') { if (typeof renderFarmBreed === 'function') renderFarmBreed(); }
            if (currentTab === 'loot-logger') { if (typeof renderLootLoggerTab === 'function') renderLootLoggerTab(); }

            // Update browser tab title
            const TAB_TITLES = {
                browser: 'Market Browser', arbitrage: 'Market Flipping', bmflipper: 'BM Flipper',
                compare: 'City Comparison', toptraded: 'Top Traded', itempower: 'Item Power',
                favorites: 'Favorites', crafting: 'Crafting Profits', 'craft-top-n': 'Top-N Ranker',
                'refining-lab': 'Refining Lab', journals: 'Journals', rrr: 'RRR Calculator',
                repair: 'Repair Cost', transport: 'Transport Routes', 'live-flips': 'Live Flips',
                portfolio: 'Portfolio Tracker', 'craft-runs': 'Craft Runs',
                'loot-buyer': 'Loot Buyer', 'loot-logger': 'Loot Logger',
                farming: 'Farm & Breed', alerts: 'Alerts', community: 'Community',
                profile: 'Profile', about: 'About',
            };
            const tabLabel = TAB_TITLES[currentTab];
            if (tabLabel) document.title = `${tabLabel} \u2014 Coldtouch Market Analyzer`;

            // Update URL with current tab (shareable deep link)
            const url = new URL(window.location);
            url.searchParams.set('tab', currentTab);
            history.replaceState(null, '', url);

            // UX-2: update browser tab title
            const _TAB_TITLES = { browser:'Market Browser', arbitrage:'Market Flipping', bmflipper:'BM Flipper', compare:'City Comparison', toptraded:'Top Traded', itempower:'Item Power', favorites:'Favorites', crafting:'Crafting Profits', 'craft-top-n':'Top-N Ranker', 'refining-lab':'Refining Lab', journals:'Journals', rrr:'Return Rate Calc', repair:'Repair Cost', transport:'Transport Routes', 'live-flips':'Live Flips', portfolio:'Portfolio Tracker', 'craft-runs':'Craft Runs', 'loot-buyer':'Loot Buyer', 'loot-logger':'Loot Logger', farming:'Farm Calculator', alerts:'Alerts', about:'About', community:'Community', profile:'Profile' };
            document.title = (_TAB_TITLES[currentTab] ? _TAB_TITLES[currentTab] + ' — ' : '') + 'Albion Market Analyzer';

            // Close dropdown after selection
            closeAllDropdowns();
        });
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        closeAllDropdowns();
    });

    // Restore tab + item from URL on load (shareable deep links)
    const urlParams = new URLSearchParams(window.location.search);
    const urlTab = urlParams.get('tab');
    const urlItem = urlParams.get('item');
    const urlFrom = urlParams.get('from');
    const urlTo = urlParams.get('to');
    // Must match the actual `data-tab` values in index.html. Previously listed non-existent
    // 'flipper'/'top-traded'/'item-power'/'farm'/'mounts'/'builds'/'feedback' — these silently
    // broke shareable deep links like `?tab=toptraded`.
    const VALID_TABS = new Set([
        'browser','arbitrage','bmflipper','compare','toptraded','itempower','favorites',
        'crafting','craft-top-n','refining-lab','journals','rrr','repair',
        'transport','live-flips','portfolio','craft-runs',
        'loot-buyer','loot-logger',
        'farming',
        'alerts','community','profile','about'
    ]);
    if (urlTab && VALID_TABS.has(urlTab)) {
        const tabEl = document.querySelector(`.nav-tab[data-tab="${urlTab}"]`);
        if (tabEl) tabEl.click();
        // Pre-fill item search if provided
        if (urlItem) {
            setTimeout(() => {
                if (urlTab === 'browser') switchToBrowser(urlItem);
                else if (urlTab === 'compare') switchToCompare(urlItem);
                else if (urlTab === 'crafting') switchToCraft(urlItem);
            }, 300);
        }
        // Pre-fill transport cities if provided
        if (urlTab === 'transport' && (urlFrom || urlTo)) {
            setTimeout(() => {
                if (urlFrom) {
                    const fromEl = document.getElementById('transport-buy-city');
                    if (fromEl) fromEl.value = urlFrom;
                }
                if (urlTo) {
                    const toEl = document.getElementById('transport-sell-city');
                    if (toEl) toEl.value = urlTo;
                }
            }, 300);
        }
    }
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

    // When qualityVal === 'all' we historically picked max buyMax across any quality and min sellMin
    // across any quality — producing a fictional spread (e.g. Q1 sell vs Q5 buy). Default to Q1 for
    // card-view accuracy; the user can still pick Q2-Q5 explicitly from the dropdown.
    const cardQualityFilter = qualityVal === 'all' ? '1' : qualityVal;
    if (sortVal === 'name') {
        browserFilteredItems.sort((a, b) => getFriendlyName(a).localeCompare(getFriendlyName(b)));
    } else {
        const tempArr = browserFilteredItems.map(id => {
            const prices = priceMap[id] || [];
            let bestBuy = 0;
            let bestSell = Infinity;
            for (const p of prices) {
                if (p.quality.toString() !== cardQualityFilter) continue;
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

        // Find best sell (lowest sell_price_min) and best buy (highest buy_price_max).
        // Respect the same "default to Q1 when All" rule to avoid cross-quality spreads on cards.
        let bestSell = null, bestBuy = null;
        for (const p of prices) {
            if (p.quality.toString() !== cardQualityFilter) continue;
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
        card.style.position = 'relative';
        card.innerHTML = `
            ${renderFavStarButton(id)}
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
                ${recipesData[id] ? `<button class="btn-card-action" data-action="craft-browser" data-item="${id}" title="Open crafting profit breakdown — materials, focus, best sell city">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                    Craft
                </button>` : `<button class="btn-card-action" data-action="flips" data-item="${id}" title="Find flip opportunities for this item (no recipe — showing flips instead)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                    Flips
                </button>`}
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

    // Craft button (swapped from Flips for items that have a recipe).
    container.querySelectorAll('[data-action="craft-browser"]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (typeof switchToCraft === 'function') switchToCraft(btn.dataset.item);
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
        // FE-M1: hard cap — drop excess entries (server already limits to 2000 but guard here too)
        const ssKeys = Object.keys(spreadStatsCache);
        if (ssKeys.length > SPREAD_STATS_CACHE_MAX) ssKeys.splice(0, ssKeys.length - SPREAD_STATS_CACHE_MAX).forEach(k => delete spreadStatsCache[k]);
        spreadStatsCacheTime = now;
        if (DEBUG) console.log(`[SpreadStats] Loaded ${rows.length} spread stats`);
    } catch (e) {
        if (DEBUG) console.log('[SpreadStats] Failed to load:', e.message);
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

const _analyticsInFlight = new Map(); // dedup concurrent fetches for same itemId
async function fetchAnalytics(itemId) {
    if (analyticsCache.has(itemId)) {
        const cached = analyticsCache.get(itemId);
        if (cached !== 'pending') return cached;
    }
    if (_analyticsInFlight.has(itemId)) return _analyticsInFlight.get(itemId);
    const promise = (async () => {
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
        if (analyticsCache.size > ANALYTICS_CACHE_MAX) analyticsCache.delete(analyticsCache.keys().next().value);
        return data;
    } catch {
        analyticsCache.delete(itemId);
        return null;
    }
    })();
    _analyticsInFlight.set(itemId, promise);
    try { return await promise; } finally { _analyticsInFlight.delete(itemId); }
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
            const pDiff = b.profit - a.profit;
            if (pDiff !== 0) return pDiff;
            return (a.itemId || '').localeCompare(b.itemId || '');
        });
    } else {
        filtered.sort((a, b) => {
            const pDiff = b.profit - a.profit;
            if (pDiff !== 0) return pDiff;
            return (a.itemId || '').localeCompare(b.itemId || '');
        });
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
            <div class="profit-row"><span>Tax (${(TAX_RATE*100).toFixed(1)}%):</span><span class="text-red">-${Math.floor(trade.tax).toLocaleString()} 💰</span></div>
            <div class="profit-row total"><span>Net Profit:</span><strong class="${trade.profit >= 0 ? 'text-green' : 'text-red'}">${Math.floor(trade.profit).toLocaleString()} 💰</strong></div>
            <div class="roi-row"><span>ROI:</span><strong class="${trade.roi >= 0 ? 'text-green' : 'text-red'}">${trade.roi.toFixed(1)}%</strong></div>
        </div>
        ${trade.destSellOrder > 0 ? `
        <div class="profit-section" style="border-top:1px solid var(--border); margin-top:0.5rem; padding-top:0.5rem;">
            <div style="font-size:0.85rem; font-weight:bold; color:var(--text-muted); margin-bottom:0.3rem;">Sell Order Profit</div>
            <div class="profit-row"><span>Tax+Setup (${((TAX_RATE+SETUP_FEE)*100).toFixed(1)}%):</span><span class="text-red">-${Math.floor(trade.soTax).toLocaleString()} 💰</span></div>
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
    _lastArbTrades = trades || []; // cache for CSV export

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
// UPGRADE FLIPS (cross-enchantment arbitrage)
// ============================================================
// Exact rune/soul/relic counts to upgrade one enchantment step (N → N+1)
// per item slot category. Extracted from ao-bin-dumps items.xml
// <upgraderequirements> blocks. Identical at every tier 4–8; only the
// material type changes per step:
//   0 → 1 : T{tier}_RUNE
//   1 → 2 : T{tier}_SOUL
//   2 → 3 : T{tier}_RELIC
const UPGRADE_MATERIAL_COUNT = {
    '2H':    384,   // two-hand weapons
    '1H':    288,   // one-hand weapons (MAIN_)
    'CHEST': 192,   // chest armor
    'BAG':   192,
    'HEAD':  96,
    'SHOES': 96,
    'OFF':   96,    // off-hands (shield / book / torch / orb etc.)
    'CAPE':  96,
    'TOOL':  96,
};

// Per-step material class by enchantment level we're upgrading TO.
// e.g. upgrading 0 → 1 uses the "RUNE" class, so index 1 → 'RUNE'.
const UPGRADE_MATERIAL_CLASS = { 1: 'RUNE', 2: 'SOUL', 3: 'RELIC' };

function getBaseItemId(itemId) {
    if (!itemId) return '';
    return itemId.split('@')[0];
}

// Classify an item id (base or enchanted) into one of the slot buckets above.
// Returns null for items we don't know how to upgrade (pets, food, etc.).
function upgradeSlotOf(itemId) {
    if (!itemId) return null;
    const base = getBaseItemId(itemId);
    if (/^T[3-8]_2H_TOOL_/.test(base)) return 'TOOL';
    if (/^T[3-8]_2H_/.test(base)) return '2H';
    if (/^T[3-8]_MAIN_/.test(base)) return '1H';
    if (/^T[3-8]_OFF_/.test(base)) return 'OFF';
    if (/^T[3-8]_HEAD_/.test(base)) return 'HEAD';
    if (/^T[3-8]_ARMOR_/.test(base)) return 'CHEST';
    if (/^T[3-8]_SHOES_/.test(base)) return 'SHOES';
    if (/^T[3-8]_BAG/.test(base)) return 'BAG';
    if (/^T[3-8]_CAPE/.test(base) || /^T[3-8]_CAPEITEM_/.test(base)) return 'CAPE';
    return null;
}

// Look up the cheapest sell_price_min for (itemId, city [, quality]) in the cached market data.
// Returns 0 if not found. Used to price a specific rune/soul/relic at the upgrade step's city.
function _lookupLivePrice(cachedData, itemId, city) {
    let best = 0;
    for (const entry of cachedData) {
        if (entry.item_id !== itemId) continue;
        if (city && entry.city !== city) continue;
        if (!entry.sell_price_min || entry.sell_price_min <= 0) continue;
        if (!best || entry.sell_price_min < best) best = entry.sell_price_min;
    }
    return best;
}

// Compute the full upgrade cost from `fromEnch` → `toEnch` for an item.
// Returns { totalSilver, breakdown: [{itemId, count, unitPrice, subtotal, step}], missingPrices: [ids] }
// Returns null if the slot isn't upgradable OR any material price is missing
// (we refuse to show a misleading flip if we can't price the materials).
function estimateUpgradeCost(itemId, fromEnch, toEnch, cachedData, city) {
    const tierMatch = itemId.match(/^T(\d)/);
    if (!tierMatch) return null;
    const tier = parseInt(tierMatch[1]);
    const slot = upgradeSlotOf(itemId);
    if (!slot) return null;
    const count = UPGRADE_MATERIAL_COUNT[slot];
    if (!count) return null;

    const breakdown = [];
    let total = 0;
    const missing = [];
    for (let e = fromEnch + 1; e <= toEnch; e++) {
        const cls = UPGRADE_MATERIAL_CLASS[e];
        if (!cls) return null; // Enchant level 4 not supported (avalonian shard path)
        const matId = `T${tier}_${cls}`;
        const unit = _lookupLivePrice(cachedData || [], matId, city);
        if (!unit) {
            missing.push(matId);
            continue;
        }
        const subtotal = unit * count;
        total += subtotal;
        breakdown.push({ itemId: matId, count, unitPrice: unit, subtotal, step: e });
    }
    if (missing.length > 0) return { totalSilver: null, breakdown, missingPrices: missing, slot };
    return { totalSilver: total, breakdown, missingPrices: [], slot };
}

function processUpgradeFlips(data, opts = {}) {
    const { minProfit = 10000, minRoi = 5, cityFilter = 'all', quality = 'all' } = opts;
    // Group prices by (baseId, city, quality) → { enchLevel: entry }
    const groups = {};
    for (const entry of data) {
        if (quality !== 'all' && entry.quality.toString() !== quality) continue;
        if (cityFilter !== 'all' && entry.city !== cityFilter) continue;
        if (!entry.sell_price_min || entry.sell_price_min <= 0) continue;
        const base = getBaseItemId(entry.item_id);
        const ench = parseInt(extractEnchantment(entry.item_id)) || 0;
        // Only gear-style items (armor, weapon, bag, tool, cape) are enchantable
        if (!/^T[3-8]_(ARMOR|HEAD|SHOES|MAIN|2H|OFF|BAG|TOOL|CAPE)/i.test(base)) continue;
        const key = `${base}|${entry.city}|${entry.quality}`;
        if (!groups[key]) groups[key] = {};
        // Keep the cheapest sell offer per (base, city, qual, ench)
        const existing = groups[key][ench];
        if (!existing || entry.sell_price_min < existing.sell_price_min) {
            groups[key][ench] = entry;
        }
    }

    const flips = [];
    for (const [key, byEnch] of Object.entries(groups)) {
        const levels = Object.keys(byEnch).map(Number).sort((a, b) => a - b);
        if (levels.length < 2) continue;
        const [base, city] = key.split('|');
        // Compare every lower→higher enchantment pair in this city
        for (let i = 0; i < levels.length - 1; i++) {
            for (let j = i + 1; j < levels.length; j++) {
                const low = byEnch[levels[i]];
                const high = byEnch[levels[j]];
                if (!low || !high) continue;
                const buyPrice = low.sell_price_min;
                const sellPrice = high.sell_price_min;
                // Price upgrade materials at the LIVE rune/soul/relic cost in the same city as the flip.
                const costInfo = estimateUpgradeCost(base, levels[i], levels[j], data, city);
                if (!costInfo) continue;
                // If any material price is missing we skip the flip — profit math would lie.
                if (costInfo.totalSilver == null) continue;
                const upgradeCost = costInfo.totalSilver;
                const tax = sellPrice * 0.055; // Sell order tax+setup
                const profit = sellPrice - buyPrice - upgradeCost - tax;
                const cost = buyPrice + upgradeCost;
                const roi = cost > 0 ? (profit / cost) * 100 : 0;
                if (profit < minProfit || roi < minRoi) continue;
                flips.push({
                    itemId: high.item_id, // display enchanted version
                    quality: high.quality,
                    buyCity: city,
                    sellCity: city,
                    buyPrice,
                    sellPrice,
                    profit,
                    roi,
                    tax,
                    soTax: tax,
                    soProfit: profit,
                    soRoi: roi,
                    originBuyOrder: low.buy_price_max || 0,
                    destSellOrder: 0,
                    dateBuy: low.sell_price_min_date,
                    dateSell: high.sell_price_min_date,
                    confidence: null,
                    consistencyPct: 0,
                    sampleCount: 0,
                    isUpgradeFlip: true,
                    upgradeCost,
                    upgradeBreakdown: costInfo.breakdown, // [{ itemId, count, unitPrice, subtotal, step }]
                    upgradeSlot: costInfo.slot,
                    fromEnch: levels[i],
                    toEnch: levels[j],
                    baseItemId: base
                });
            }
        }
    }
    flips.sort((a, b) => b.profit - a.profit);
    return flips.slice(0, 60);
}

async function scanUpgradeFlips() {
    const container = document.getElementById('arbitrage-results');
    const spinner = document.getElementById('arb-spinner');
    const errorEl = document.getElementById('arb-error');
    hideError(errorEl);
    spinner.classList.remove('hidden');
    container.innerHTML = '';
    try {
        const cachedData = await MarketDB.getAllPrices();
        spinner.classList.add('hidden');
        if (cachedData.length === 0) {
            showError(errorEl, 'No cached data yet — run a normal scan first so price data is available.');
            return;
        }
        const quality = document.getElementById('arb-quality').value;
        const buyCityFilter = document.getElementById('arb-buy-city').value; // "all" or a city
        const flips = processUpgradeFlips(cachedData, {
            minProfit: 10000,
            minRoi: 5,
            cityFilter: buyCityFilter,
            quality
        });
        if (flips.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No profitable enchantment upgrades found.</p>
                <p class="hint">Try a broader city filter, or run a normal market scan so rune/soul/relic prices are cached too — they're used to price each upgrade step.</p></div>`;
            _lastArbTrades = [];
            return;
        }
        // Reuse the arbitrage card renderer — flag each card with an upgrade badge.
        renderArbitrage(flips, false);
        // Decorate each card with the upgrade badge + material breakdown
        // querySelectorAll('.trade-card') matches cards in order (countBar has a different class),
        // so flips[idx] maps 1:1 to cards[idx].
        flips.forEach((f, idx) => {
            const cards = container.querySelectorAll('.trade-card');
            const card = cards[idx];
            if (!card) return;
            const nameEl = card.querySelector('.item-name');
            if (nameEl && !nameEl.querySelector('.upgrade-flip-badge')) {
                nameEl.insertAdjacentHTML('beforeend', `<span class="upgrade-flip-badge">UPGRADE @${f.fromEnch}→@${f.toEnch}</span>`);
            }
            // Insert the upgrade cost breakdown inside the profit section.
            // Shows one row per material step (rune / soul / relic) with count, unit price and subtotal,
            // followed by a summary line so the user knows what to actually buy.
            const profitSection = card.querySelector('.profit-section');
            if (profitSection) {
                const totalRow = profitSection.querySelector('.profit-row.total');
                const MAT_LABEL = { RUNE: '🔷 Runes', SOUL: '💜 Souls', RELIC: '🔮 Relics' };
                const MAT_EMOJI = { RUNE: '🔷', SOUL: '💜', RELIC: '🔮' };
                const breakdown = Array.isArray(f.upgradeBreakdown) ? f.upgradeBreakdown : [];
                // Header row — makes the block visually distinct
                const header = document.createElement('div');
                header.className = 'profit-row';
                header.style.cssText = 'border-top:1px dashed var(--border); margin-top:0.3rem; padding-top:0.3rem; font-size:0.72rem; color:var(--text-muted);';
                header.innerHTML = `<span>Upgrade materials (${esc(f.upgradeSlot || '?')} × ${breakdown.length} step${breakdown.length !== 1 ? 's' : ''})</span><span></span>`;
                profitSection.insertBefore(header, totalRow);
                // One row per material step
                for (const step of breakdown) {
                    const matMatch = step.itemId.match(/^T\d_(RUNE|SOUL|RELIC)$/);
                    const matClass = matMatch ? matMatch[1] : '?';
                    const label = MAT_LABEL[matClass] || step.itemId;
                    const row = document.createElement('div');
                    row.className = 'profit-row';
                    row.style.cssText = 'font-size:0.78rem; padding-left:0.5rem;';
                    row.innerHTML = `<span>&nbsp;&nbsp;${esc(step.itemId)} × ${step.count.toLocaleString()} @ ${Math.floor(step.unitPrice).toLocaleString()}</span><span class="text-red">-${Math.floor(step.subtotal).toLocaleString()} 💰</span>`;
                    row.title = `${label}: ${step.count} × ${Math.floor(step.unitPrice).toLocaleString()} silver = ${Math.floor(step.subtotal).toLocaleString()} silver (enchant ${step.step - 1} → ${step.step})`;
                    profitSection.insertBefore(row, totalRow);
                }
                // Summary row — the total material cost (already factored into profit)
                const sumRow = document.createElement('div');
                sumRow.className = 'profit-row';
                sumRow.innerHTML = `<span>Upgrade materials total:</span><span class="text-red">-${Math.floor(f.upgradeCost).toLocaleString()} 💰</span>`;
                profitSection.insertBefore(sumRow, totalRow);
            }
        });
        // Update count bar to reflect upgrade context
        const countBar = container.querySelector('.result-count-bar');
        if (countBar) countBar.innerHTML = `Showing <strong>${flips.length}</strong> enchantment upgrades <span style="font-size:0.7rem; color:var(--text-muted);">• material costs use live rune/soul/relic prices in the buy city</span>`;
    } catch (e) {
        spinner.classList.add('hidden');
        showError(errorEl, 'Upgrade scan failed: ' + e.message);
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
    // Update URL for sharing
    const url = new URL(window.location);
    url.searchParams.set('tab', 'compare');
    url.searchParams.set('item', itemId);
    history.replaceState(null, '', url);
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
        container.innerHTML = `<div class="empty-state"><p>Failed to fetch comparison data. Please check your connection and try again.</p><p class="hint">${esc(e.message)}</p></div>`;
        showToast('Compare fetch failed: ' + e.message, 'error');
    }
}

// ============================================================
// CRAFTING PROFITS
// ============================================================

function calculateRRR(useFocus, cityBonusPct, activity = 'crafting') {
    const basePB = activity === 'refining' ? CraftConfig.refiningBasePB : CraftConfig.craftingBasePB;
    const focusPB = useFocus ? 59 : 0;
    const totalPB = basePB + (cityBonusPct || 0) + focusPB;
    return 1 - 1 / (1 + totalPB / 100);
}

// Backward-compat shim: old call-sites passed (baseCost, specLevel, masteryLevel).
// New V2 is exposed as calculateFocusCostV2 and uses exponential formula per wiki.
function calculateFocusCost(baseCost, specLevel, masteryLevel) {
    return calculateFocusCostV2(baseCost, specLevel, masteryLevel, 0, CraftConfig.foodBuff);
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
        trackActivity('craft_calc', 1);
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
    const cityBonusRaw = document.getElementById('craft-city-bonus').value;
    // Hideout: bonus = 15% base + PL×2% + core% (overrides the select numeric value)
    const cityBonusPct = cityBonusRaw === 'hideout'
        ? 15 + (parseInt(document.getElementById('craft-hideout-pl')?.value) || 0) * 2
            + (parseFloat(document.getElementById('craft-hideout-core')?.value) || 0)
        : parseFloat(cityBonusRaw) || 0;
    const stationFee = parseFloat(document.getElementById('craft-fee').value) || 0;
    const stationS100 = parseFloat(document.getElementById('craft-station-s100')?.value) || 0;
    const craftQuality = parseInt(document.getElementById('craft-quality')?.value) || 1;
    const qualityEV = !!document.getElementById('craft-quality-ev')?.checked;
    const isRefining = (recipe.category === 'materials');
    const rrr = calculateRRR(useFocus, cityBonusPct, isRefining ? 'refining' : 'crafting');
    const effectiveMultiplier = 1 - rrr;

    // Index prices by item_id → city (filter finished item by selected quality, unless Quality EV)
    // When qualityEV is on, finishedPricesByQuality[city] = { 1: {...}, 2: {...}, ... } for EV calc.
    const priceIndex = {};
    const finishedPricesByQuality = {}; // city → { quality(1-5): { buyMax, sellMin } }
    for (const entry of data) {
        const id = entry.item_id;
        const q = entry.quality || 1;
        let city = entry.city;
        if (city && city.includes('Black Market')) city = 'Black Market';

        // For the finished item in quality-EV mode, collect per-quality prices.
        if (id === itemId && qualityEV) {
            if (!finishedPricesByQuality[city]) finishedPricesByQuality[city] = {};
            if (!finishedPricesByQuality[city][q]) finishedPricesByQuality[city][q] = { sellMin: 0, buyMax: 0 };
            const slot = finishedPricesByQuality[city][q];
            if (entry.sell_price_min > 0 && (slot.sellMin === 0 || entry.sell_price_min < slot.sellMin)) slot.sellMin = entry.sell_price_min;
            if (entry.buy_price_max > 0 && entry.buy_price_max > slot.buyMax) slot.buyMax = entry.buy_price_max;
        }

        // For the finished item (non-EV), filter by selected quality.
        // For materials, include all qualities (materials are always Q1).
        if (id === itemId && !qualityEV && q !== craftQuality) continue;
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

    // If Quality EV mode on, overwrite finished-item priceIndex with EV-weighted prices per city.
    if (qualityEV) {
        if (!priceIndex[itemId]) priceIndex[itemId] = {};
        // Quality points: rough heuristic — masteryLevel + specLevel contributes via Albion table.
        // Mastery 100 ≈ 30 quality points per tier, spec 100 ≈ 50 quality points. Simple blend:
        const qPoints = (masteryLevel + specLevel) * 0.8;
        for (const city of Object.keys(finishedPricesByQuality)) {
            const byQ = finishedPricesByQuality[city];
            const buyByQ = {}; const sellByQ = {};
            for (let q = 1; q <= 5; q++) { buyByQ[q] = byQ[q]?.buyMax || 0; sellByQ[q] = byQ[q]?.sellMin || 0; }
            priceIndex[itemId][city] = {
                sellMin: qualityEVPrice(sellByQ, qPoints),
                buyMax: qualityEVPrice(buyByQ, qPoints),
                sellDate: '', buyDate: '', qualityEV: true,
            };
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

    // Profit row (using cheapest materials). Station fee uses new ItemValue × 11.25% × (s/100) formula
    // if stationS100 is set; else falls back to legacy flat % input.
    const sFeePerCraft = stationS100 > 0 ? stationFeePerCraft(itemId, stationS100) : 0;
    if (cheapestTotal !== Infinity) {
        sellHTML += `<tr class="total-row"><td><strong>Net Profit</strong></td>`;
        CITIES.forEach(c => {
            const p = finishedPrices[c];
            const sellPrice = p ? p.buyMax : 0;
            if (sellPrice > 0) {
                const totalRevenue = sellPrice * outputQty;
                const tax = totalRevenue * (TAX_RATE + SETUP_FEE); // premium-aware
                const fee = sFeePerCraft > 0 ? sFeePerCraft : totalRevenue * (stationFee / 100);
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

    // Recompute bestProfit using per-craft station fee (stationFeePerCraft) and per-city auto-specialty.
    let bestProfit2 = -Infinity, bestCity2 = '', bestSellPrice2 = 0, bestCityRRR = rrr;
    for (const c of CITIES) {
        const p = finishedPrices[c];
        const sellPrice = p ? p.buyMax : 0;
        if (sellPrice > 0 && cheapestTotal !== Infinity) {
            const detect = isRefining ? getCityRefineBonus(c, itemId) : getCityCraftBonus(c, itemId);
            const cityRRR = detect.autoApplied ? calculateRRR(useFocus, detect.bonus, isRefining ? 'refining' : 'crafting') : rrr;
            // Note: existing matCostByCity is already computed at the user-selected cityBonusPct.
            // Auto-applied specialty adjustment is informational; primary ranking still uses matCostByCity.
            const tax = sellPrice * effectiveTaxRate('order');
            const fee = sFeePerCraft > 0 ? sFeePerCraft : sellPrice * (stationFee / 100);
            const profit = sellPrice - cheapestTotal - tax - fee;
            if (profit > bestProfit2) { bestProfit2 = profit; bestCity2 = c; bestSellPrice2 = sellPrice; bestCityRRR = cityRRR; }
        }
    }
    if (bestProfit2 > -Infinity) { bestProfit = bestProfit2; bestCity = bestCity2; bestSellPrice = bestSellPrice2; }
    const cityDetect = isRefining ? getCityRefineBonus(bestCity, itemId) : getCityCraftBonus(bestCity, itemId);

    let summaryHTML = `<div class="craft-summary-card">
        <div class="craft-summary-header">
            <div style="position:relative;display:flex;">
                <img class="item-icon" src="https://render.albiononline.com/v1/item/${itemId}.png" alt="" loading="lazy">
                ${getEnchantmentBadge(itemId)}
            </div>
            <div>
                <h2>${esc(name)} <span class="tier-badge">${getTierEnchLabel(itemId)}</span></h2>
                <span style="color:var(--text-muted);font-size:0.8rem;">${esc(itemId)}</span>
                ${cityDetect.autoApplied ? `<span class="badge-specialty" title="City auto-applied +${cityDetect.bonus}% production bonus">🏙️ ${esc(cityDetect.reason)} +${cityDetect.bonus}% PB</span>` : ''}
                ${qualityEV ? '<span class="badge-specialty" style="background:#6d28d9;" title="Prices shown are expected value across quality distribution at your spec">🎯 Quality EV</span>' : ''}
                ${!CraftConfig.premium ? '<span class="badge-specialty" style="background:#ea580c;" title="Non-premium tax: 8% + 2.5% setup = 10.5%">💎 Non-Premium (10.5% tax)</span>' : '<span class="badge-specialty" style="background:#0d9488;" title="Premium tax: 4% + 2.5% setup = 6.5%">💎 Premium (6.5% tax)</span>'}
            </div>
        </div>`;

    if (bestProfit > -Infinity) {
        const roi = cheapestTotal > 0 ? (bestProfit / cheapestTotal * 100).toFixed(1) : '0.0';
        const gaugeWidth = Math.min(100, Math.abs(parseFloat(roi)));
        // Focus cost calculation — V2 exponential, food-buff aware.
        const baseFocusCost = recipe.focusCost || baseFocusForItem(itemId, isRefining ? 'refining' : 'crafting');
        const focusCost = baseFocusCost > 0 ? calculateFocusCostV2(baseFocusCost, specLevel, masteryLevel, 0, CraftConfig.foodBuff) : 0;
        const qualityLabel = craftQuality > 1 && !qualityEV ? ` (Q${craftQuality})` : (qualityEV ? ' (EV)' : '');
        const taxPct = ((TAX_RATE + SETUP_FEE) * 100).toFixed(1);
        const feeLabel = sFeePerCraft > 0 ? `Station Fee (IV)` : (stationFee > 0 ? `Station Fee (${stationFee}%)` : null);
        const feeAmount = sFeePerCraft > 0 ? sFeePerCraft : (stationFee > 0 ? Math.floor(bestSellPrice * stationFee / 100) : 0);
        summaryHTML += `
        <div class="craft-summary-stats">
            <div class="stat-box"><div class="stat-label">Cheapest Materials</div><div class="stat-value">${cheapestTotal.toLocaleString()} s</div></div>
            <div class="stat-box"><div class="stat-label">Best Sell${qualityLabel} (${esc(bestCity)})</div><div class="stat-value text-accent">${bestSellPrice.toLocaleString()} s</div></div>
            <div class="stat-box"><div class="stat-label">Tax+Setup (${taxPct}%)</div><div class="stat-value text-red">-${Math.floor(bestSellPrice * (TAX_RATE + SETUP_FEE)).toLocaleString()}</div></div>
            ${feeLabel ? `<div class="stat-box"><div class="stat-label">${esc(feeLabel)}</div><div class="stat-value text-red">-${feeAmount.toLocaleString()}</div></div>` : ''}
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

    // ===== City Heatmap (C4) — 7 cities × (focus on/off) matrix =====
    const heatmapHTML = renderCityHeatmap(itemId, recipe, priceIndex, specLevel, masteryLevel, stationS100, stationFee, sFeePerCraft, isRefining, cheapestTotal);

    // ===== Sub-recipe tree with buy-vs-craft toggles (C2) =====
    const treeHTML = renderSubRecipeTree(itemId, recipe, priceIndex, { useFocus, specLevel, masteryLevel, cityBonusPct, isRefining });

    // ===== Inverse calc — max material prices for target margin (C5) =====
    const inverseHTML = renderInverseCalc(itemId, recipe, priceIndex, { bestSellPrice, bestCity, effectiveMultiplier, sFeePerCraft, stationFee });

    container.innerHTML = summaryHTML + matTableHTML + sellHTML + heatmapHTML + treeHTML + inverseHTML;

    // Wire up sub-recipe tree toggle buttons now that the HTML is mounted
    wireSubRecipeTreeEvents(itemId, recipe, priceIndex, { useFocus, specLevel, masteryLevel, cityBonusPct, isRefining });

    // Wire up inverse calc slider
    wireInverseCalcEvents(itemId, recipe, priceIndex, { bestSellPrice, bestCity, effectiveMultiplier, sFeePerCraft, stationFee });

    // Generate shopping list grouped by cheapest city
    generateShoppingList(recipe, itemId, priceIndex, effectiveMultiplier);
}

// ============================================================
// CRAFTING — City Heatmap (C4)
// ============================================================
// 7 cities × (focus-off, focus-on) = 14-cell matrix of profit / RRR / liquidity.
// Uses per-city specialty auto-detection for PB.
function renderCityHeatmap(itemId, recipe, priceIndex, specLevel, masteryLevel, stationS100, stationFee, sFeePerCraft, isRefining, matCostBaseline) {
    const cities = ['Caerleon','Bridgewatch','Fort Sterling','Lymhurst','Martlock','Thetford','Brecilien'];
    const outputQty = recipe.output || 1;
    let html = `<div class="craft-detail-section">
        <h3>🗺️ City Heatmap — Profit by City × Focus</h3>
        <p style="color:var(--text-muted);font-size:0.8rem;margin:0 0 0.5rem 0;">Best city shown in green. Auto-applied specialty bonus badges on each row.</p>
        <div class="table-scroll-wrapper">
        <table class="compare-table craft-cost-table city-heatmap">
            <thead><tr><th>City</th><th>Specialty</th><th>No Focus</th><th>With Focus</th></tr></thead>
            <tbody>`;

    let globalBest = -Infinity;
    const cells = cities.map(c => {
        const detect = isRefining ? getCityRefineBonus(c, itemId) : getCityCraftBonus(c, itemId);
        const cityBonus = detect.bonus || 0;
        const row = { city: c, specialty: detect };
        for (const focusOn of [false, true]) {
            const cityRRR = calculateRRR(focusOn, cityBonus, isRefining ? 'refining' : 'crafting');
            const effMult = 1 - cityRRR;
            // Recompute mat cost at this city's RRR using cheapest-per-mat prices from priceIndex.
            let matCost = 0; let missing = false;
            for (const mat of recipe.materials) {
                const byCity = priceIndex[mat.id] || {};
                let cheapest = Infinity;
                for (const cityName of Object.keys(byCity)) {
                    if (cityName === 'Black Market') continue;
                    const sp = byCity[cityName].sellMin;
                    if (sp > 0 && sp < cheapest) cheapest = sp;
                }
                if (cheapest === Infinity) { missing = true; break; }
                matCost += cheapest * mat.qty * effMult;
            }
            const p = priceIndex[itemId] && priceIndex[itemId][c];
            const sellPrice = p ? p.buyMax : 0;
            if (sellPrice > 0 && !missing) {
                const tax = sellPrice * effectiveTaxRate('order');
                const fee = sFeePerCraft > 0 ? sFeePerCraft : sellPrice * (stationFee / 100);
                const profit = sellPrice * outputQty - matCost - tax - fee;
                const rrrPct = (cityRRR * 100).toFixed(1);
                row[focusOn ? 'focus' : 'nofocus'] = { profit: Math.floor(profit), rrr: rrrPct };
                if (profit > globalBest) globalBest = profit;
            } else {
                row[focusOn ? 'focus' : 'nofocus'] = null;
            }
        }
        return row;
    });

    for (const r of cells) {
        html += `<tr>
            <td><strong>${esc(r.city)}</strong></td>
            <td style="font-size:0.75rem;color:var(--text-muted);">${r.specialty.autoApplied ? `+${r.specialty.bonus}% ${esc(r.specialty.reason.replace(r.city + ' ', ''))}` : '—'}</td>`;
        for (const key of ['nofocus', 'focus']) {
            const cell = r[key];
            if (!cell) { html += `<td class="text-muted">—</td>`; continue; }
            const isBest = cell.profit === globalBest && globalBest > 0;
            const cls = cell.profit < 0 ? 'text-red' : (isBest ? 'best-price text-green' : 'text-green');
            html += `<td class="${cls}"><strong>${cell.profit.toLocaleString()} s</strong><br><small style="color:var(--text-muted);font-weight:normal;">RRR ${cell.rrr}%</small></td>`;
        }
        html += `</tr>`;
    }
    html += `</tbody></table></div></div>`;
    return html;
}

// ============================================================
// CRAFTING — Sub-recipe Tree with Buy-vs-Craft Toggles (C2)
// ============================================================
// Persisted per-session via window._craftTreeState: { [materialId]: 'buy' | 'craft' } (default 'buy').
// Recursive — "craft" node expands into its own children. Auto-optimize picks cheapest path per node.
function renderSubRecipeTree(itemId, recipe, priceIndex, ctx) {
    if (!recipe || !recipe.materials) return '';
    window._craftTreeState = window._craftTreeState || {};
    // Walk the tree at render time.
    const state = window._craftTreeState;
    let html = `<div class="craft-detail-section" id="craft-subtree-section">
        <h3>🌳 Sub-recipe Tree — Buy vs Craft per Node</h3>
        <p style="color:var(--text-muted);font-size:0.8rem;margin:0 0 0.5rem 0;">Toggle each material to craft locally (applies your RRR) or buy at current cheapest city. "Auto-optimize" picks the cheaper path for each node.</p>
        <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">
            <button class="btn-secondary" id="craft-tree-auto-btn">✨ Auto-optimize</button>
            <button class="btn-secondary" id="craft-tree-reset-btn">Reset all to Buy</button>
            <span id="craft-tree-savings" style="align-self:center;color:var(--text-muted);font-size:0.85rem;"></span>
        </div>
        <div id="craft-subtree-view" class="subtree-view">`;
    html += renderSubRecipeNode(itemId, recipe, priceIndex, ctx, 0, true);
    html += `</div></div>`;
    return html;
}

function renderSubRecipeNode(itemId, recipe, priceIndex, ctx, depth, isRoot) {
    if (!recipe || !recipe.materials) return '';
    const state = window._craftTreeState || {};
    const effMult = 1 - calculateRRR(ctx.useFocus, ctx.cityBonusPct, ctx.isRefining ? 'refining' : 'crafting');
    let html = '';
    for (const mat of recipe.materials) {
        const matRecipe = recipesData[mat.id];
        const canCraft = !!matRecipe;
        const nodeState = canCraft ? (state[mat.id] || 'buy') : 'buy';
        const effQty = mat.qty * (isRoot ? effMult : 1); // root mats multiply by RRR; downstream assumes exact need
        // Get cheapest price across cities (excluding Black Market)
        const byCity = priceIndex[mat.id] || {};
        let cheapest = Infinity, cheapestCity = '—';
        for (const cityName of Object.keys(byCity)) {
            if (cityName === 'Black Market') continue;
            const sp = byCity[cityName].sellMin;
            if (sp > 0 && sp < cheapest) { cheapest = sp; cheapestCity = cityName; }
        }
        const buyCost = cheapest === Infinity ? 0 : cheapest * effQty;
        // Craft cost: sum of child mats (approx — own RRR applied)
        let craftCost = null;
        if (canCraft) {
            // Recursive leaf-cost estimate: sum(mat.id * mat.qty * cheapest price)
            let cc = 0;
            for (const sub of matRecipe.materials) {
                const sByCity = priceIndex[sub.id] || {};
                let subCheap = Infinity;
                for (const cn of Object.keys(sByCity)) {
                    if (cn === 'Black Market') continue;
                    const sp = sByCity[cn].sellMin;
                    if (sp > 0 && sp < subCheap) subCheap = sp;
                }
                if (subCheap === Infinity) { cc = null; break; }
                cc += subCheap * sub.qty;
            }
            if (cc != null) craftCost = cc * effQty;
        }
        const chosenCost = nodeState === 'craft' && craftCost != null ? craftCost : buyCost;
        const savings = (canCraft && craftCost != null && buyCost > 0) ? (buyCost - craftCost) : 0;
        const matName = getFriendlyName(mat.id);
        html += `<div class="subtree-node" style="margin-left:${depth * 1.5}rem;" data-mat-id="${esc(mat.id)}">
            <div class="subtree-row">
                <img class="mat-icon-sm" src="https://render.albiononline.com/v1/item/${esc(mat.id)}.png" alt="" loading="lazy">
                <span class="subtree-qty">${effQty.toFixed(1)}×</span>
                <span class="subtree-name">${esc(matName)}</span>
                <span class="subtree-cost">${Math.round(chosenCost).toLocaleString()}s</span>
                ${canCraft && craftCost != null ? `
                    <button class="subtree-toggle ${nodeState === 'buy' ? 'active' : ''}" data-action="buy" data-mat="${esc(mat.id)}" title="Buy at ${esc(cheapestCity)} — ${Math.round(buyCost).toLocaleString()}s">🛒 Buy ${cheapest !== Infinity ? '('+Math.round(buyCost).toLocaleString()+')' : ''}</button>
                    <button class="subtree-toggle ${nodeState === 'craft' ? 'active' : ''}" data-action="craft" data-mat="${esc(mat.id)}" title="Craft locally — ${Math.round(craftCost).toLocaleString()}s">🔨 Craft (${Math.round(craftCost).toLocaleString()})</button>
                    ${savings > 0 ? `<span class="subtree-savings text-green" title="Savings if crafted">−${Math.round(savings).toLocaleString()}s</span>` : ''}
                ` : `<span class="subtree-buy-only" style="color:var(--text-muted);font-size:0.75rem;">${cheapest !== Infinity ? '🛒 '+esc(cheapestCity) : '—'}</span>`}
            </div>`;
        if (nodeState === 'craft' && matRecipe) {
            html += renderSubRecipeNode(mat.id, matRecipe, priceIndex, ctx, depth + 1, false);
        }
        html += `</div>`;
    }
    return html;
}

function wireSubRecipeTreeEvents(itemId, recipe, priceIndex, ctx) {
    const section = document.getElementById('craft-subtree-section');
    if (!section) return;
    const rerender = () => {
        const view = document.getElementById('craft-subtree-view');
        if (view) view.innerHTML = renderSubRecipeNode(itemId, recipe, priceIndex, ctx, 0, true);
        // Recompute savings summary
        updateSubRecipeSavings(itemId, recipe, priceIndex, ctx);
        // Re-wire (new buttons)
        const newView = document.getElementById('craft-subtree-view');
        if (newView) newView.addEventListener('click', onClick);
    };
    const onClick = (e) => {
        const btn = e.target.closest('.subtree-toggle');
        if (!btn) return;
        const mat = btn.dataset.mat;
        const action = btn.dataset.action;
        if (!mat || !action) return;
        window._craftTreeState = window._craftTreeState || {};
        window._craftTreeState[mat] = action;
        rerender();
    };
    const autoBtn = document.getElementById('craft-tree-auto-btn');
    if (autoBtn) autoBtn.addEventListener('click', () => {
        // Pick cheaper per-node greedy
        window._craftTreeState = window._craftTreeState || {};
        const walk = (r) => {
            if (!r || !r.materials) return;
            for (const mat of r.materials) {
                const matRecipe = recipesData[mat.id];
                if (!matRecipe) continue;
                const byCity = priceIndex[mat.id] || {};
                let cheapest = Infinity;
                for (const cityName of Object.keys(byCity)) {
                    if (cityName === 'Black Market') continue;
                    const sp = byCity[cityName].sellMin;
                    if (sp > 0 && sp < cheapest) cheapest = sp;
                }
                let craftSum = 0; let valid = true;
                for (const sub of matRecipe.materials) {
                    const sBy = priceIndex[sub.id] || {};
                    let subCheap = Infinity;
                    for (const cn of Object.keys(sBy)) {
                        if (cn === 'Black Market') continue;
                        const sp = sBy[cn].sellMin;
                        if (sp > 0 && sp < subCheap) subCheap = sp;
                    }
                    if (subCheap === Infinity) { valid = false; break; }
                    craftSum += subCheap * sub.qty;
                }
                window._craftTreeState[mat.id] = (valid && craftSum < cheapest) ? 'craft' : 'buy';
                walk(matRecipe);
            }
        };
        walk(recipe);
        rerender();
        showToast('Auto-optimized sub-recipe tree ✓', 'success');
    });
    const resetBtn = document.getElementById('craft-tree-reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => { window._craftTreeState = {}; rerender(); });
    const view = document.getElementById('craft-subtree-view');
    if (view) view.addEventListener('click', onClick);
    updateSubRecipeSavings(itemId, recipe, priceIndex, ctx);
}

function updateSubRecipeSavings(itemId, recipe, priceIndex, ctx) {
    const el = document.getElementById('craft-tree-savings');
    if (!el) return;
    // Compare all-buy baseline vs current state
    const state = window._craftTreeState || {};
    const effMult = 1 - calculateRRR(ctx.useFocus, ctx.cityBonusPct, ctx.isRefining ? 'refining' : 'crafting');
    let buyTotal = 0, currentTotal = 0, valid = true;
    const walk = (r, effQtyMult, depth) => {
        for (const mat of r.materials) {
            const effQty = mat.qty * effQtyMult;
            const byCity = priceIndex[mat.id] || {};
            let cheapest = Infinity;
            for (const cityName of Object.keys(byCity)) {
                if (cityName === 'Black Market') continue;
                const sp = byCity[cityName].sellMin;
                if (sp > 0 && sp < cheapest) cheapest = sp;
            }
            const matRecipe = recipesData[mat.id];
            const node = state[mat.id] || 'buy';
            if (cheapest === Infinity && node !== 'craft') { valid = false; return; }
            // Baseline always buy.
            if (cheapest !== Infinity) buyTotal += cheapest * effQty;
            else valid = false;
            if (node === 'craft' && matRecipe) walk(matRecipe, effQty, depth + 1);
            else currentTotal += (cheapest === Infinity ? 0 : cheapest * effQty);
        }
    };
    walk(recipe, effMult, 0);
    if (!valid) { el.textContent = ''; return; }
    const savings = buyTotal - currentTotal;
    if (Math.abs(savings) < 1) { el.textContent = 'All-buy baseline is optimal (no savings from crafting any subcomponent)'; return; }
    el.innerHTML = savings > 0
        ? `<strong class="text-green">Saving ${Math.round(savings).toLocaleString()} silver</strong> vs all-buy baseline`
        : `<strong class="text-red">Costing ${Math.round(-savings).toLocaleString()} more</strong> than all-buy`;
}

// ============================================================
// CRAFTING — Inverse Calc (C5)
// ============================================================
// "I want X% margin — what's the max I can pay per material?"
function renderInverseCalc(itemId, recipe, priceIndex, ctx) {
    if (!ctx.bestSellPrice || !ctx.bestSellPrice > 0) return '';
    return `<div class="craft-detail-section" id="craft-inverse-section">
        <h3>🎯 Inverse Calc — Max Material Prices for Target Margin</h3>
        <p style="color:var(--text-muted);font-size:0.8rem;margin:0 0 0.5rem 0;">Set a target net margin — tool computes the max you can pay per material (evenly scaled) to hit it. Useful for setting buy orders.</p>
        <div class="inverse-panel">
            <div class="inverse-controls">
                <label>Target Margin:
                    <input type="range" id="craft-inverse-slider" min="0" max="60" value="10" step="1">
                    <span id="craft-inverse-margin-value">10%</span>
                </label>
                <span style="color:var(--text-muted);font-size:0.8rem;">Sell price: <strong>${ctx.bestSellPrice.toLocaleString()} s</strong> @ ${esc(ctx.bestCity)}</span>
            </div>
            <div id="craft-inverse-table"></div>
        </div>
    </div>`;
}

function wireInverseCalcEvents(itemId, recipe, priceIndex, ctx) {
    const slider = document.getElementById('craft-inverse-slider');
    if (!slider) return;
    const computeAndRender = () => {
        const marginPct = parseInt(slider.value) || 10;
        document.getElementById('craft-inverse-margin-value').textContent = marginPct + '%';
        const sellPrice = ctx.bestSellPrice || 0;
        const tax = sellPrice * effectiveTaxRate('order');
        const fee = ctx.sFeePerCraft > 0 ? ctx.sFeePerCraft : sellPrice * ((ctx.stationFee || 0) / 100);
        // Target: (sellPrice - matCostTotal - tax - fee) / matCostTotal = margin
        // => matCostTotal = (sellPrice - tax - fee) / (1 + margin)
        const netAvailable = sellPrice - tax - fee;
        const maxMatBudget = netAvailable / (1 + marginPct / 100);
        // Current cheapest mat cost
        let currentMatCost = 0; let currentMatParts = [];
        for (const mat of recipe.materials) {
            const effQty = mat.qty * ctx.effectiveMultiplier;
            const byCity = priceIndex[mat.id] || {};
            let cheapest = Infinity, cheapestCity = '—';
            for (const cityName of Object.keys(byCity)) {
                if (cityName === 'Black Market') continue;
                const sp = byCity[cityName].sellMin;
                if (sp > 0 && sp < cheapest) { cheapest = sp; cheapestCity = cityName; }
            }
            const thisCost = cheapest !== Infinity ? cheapest * effQty : 0;
            currentMatCost += thisCost;
            currentMatParts.push({ mat, effQty, unit: cheapest === Infinity ? 0 : cheapest, total: thisCost, city: cheapestCity });
        }
        const scale = currentMatCost > 0 ? maxMatBudget / currentMatCost : 1;
        let rowsHTML = `<table class="compare-table craft-cost-table" style="margin-top:0.5rem;">
            <thead><tr><th>Material</th><th>Cheapest Now</th><th>Max You Can Pay (unit)</th><th>Delta</th></tr></thead><tbody>`;
        for (const part of currentMatParts) {
            const maxUnit = part.unit > 0 ? Math.floor(part.unit * scale) : 0;
            const delta = maxUnit - part.unit;
            const cls = delta >= 0 ? 'text-green' : 'text-red';
            rowsHTML += `<tr>
                <td>${esc(getFriendlyName(part.mat.id))}</td>
                <td>${part.unit > 0 ? part.unit.toLocaleString() : '—'}</td>
                <td><strong>${maxUnit > 0 ? maxUnit.toLocaleString() : '—'}</strong></td>
                <td class="${cls}">${delta >= 0 ? '+' : ''}${delta.toLocaleString()} s</td>
            </tr>`;
        }
        rowsHTML += `<tr class="total-row"><td><strong>Total material budget</strong></td><td>${Math.round(currentMatCost).toLocaleString()}</td><td><strong>${Math.round(maxMatBudget).toLocaleString()}</strong></td><td class="${scale >= 1 ? 'text-green' : 'text-red'}">${scale >= 1 ? '+' : ''}${Math.round(maxMatBudget - currentMatCost).toLocaleString()} s</td></tr>`;
        rowsHTML += `</tbody></table>`;
        document.getElementById('craft-inverse-table').innerHTML = rowsHTML;
    };
    slider.addEventListener('input', computeAndRender);
    computeAndRender();
}

// ====== BULK SCAN (legacy) ======
function processCrafting(data, tier, sortBy) {
    const useFocus = document.getElementById('craft-use-focus')?.checked || false;
    const cityBonusPct = parseFloat(document.getElementById('craft-city-bonus')?.value) || 0;
    const stationFee = parseFloat(document.getElementById('craft-fee')?.value) || 0;
    const categoryFilter = document.getElementById('craft-category')?.value || 'all';
    const batchQty = Math.max(1, parseInt(document.getElementById('craft-qty')?.value) || 1);
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
        // Category filter
        if (categoryFilter !== 'all' && (recipe.category || 'other') !== categoryFilter) continue;

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
                matCost: totalMatCost * batchQty, mats: matBreakdown,
                tax: tax * batchQty, fee: fee * batchQty,
                profit: profit * batchQty, roi,
                batchQty,
                updateDate: oldestDate, category: recipe.category || 'other'
            });
        }
    }

    if (sortBy === 'roi') crafts.sort((a, b) => b.roi - a.roi);
    else if (sortBy === 'name') crafts.sort((a, b) => getFriendlyName(a.itemId).localeCompare(getFriendlyName(b.itemId)));
    else crafts.sort((a, b) => (b.profit - a.profit) || (a.itemId || '').localeCompare(b.itemId || ''));

    return crafts.slice(0, 60);
}

function renderCrafting(crafts) {
    const container = document.getElementById('crafting-results');
    container.innerHTML = '';
    _lastCraftsRendered = crafts || []; // cache for CSV export

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
                <div class="profit-row"><span>Tax+Setup (${((TAX_RATE+SETUP_FEE)*100).toFixed(1)}%):</span><span class="text-red">-${Math.floor(craft.tax).toLocaleString()} 💰</span></div>
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

// ============================================================
// TOP-N CRAFTING RANKER (Phase 3 — C3 — the killer feature)
// ============================================================
// Ranks every recipe by: silver/focus, silver/hour, net profit, or ROI.
// Runs client-side against IndexedDB price cache (no backend endpoint needed;
// 5026 recipes × ~8 cities × ~4 enchants = ~160k ops, completes in <1s on modern hardware).
const TOPN_CACHE = { key: null, items: null, ts: 0 };
const CRAFT_SECONDS_PER = 3; // assumption: 3 seconds per craft attempt in-game (swing) for silver/hour estimate

async function doTopNRank() {
    if (itemsList.length === 0) await loadData();
    const spinner = document.getElementById('topn-spinner');
    const results = document.getElementById('topn-results');
    spinner.classList.remove('hidden');
    results.innerHTML = '';

    const tier = document.getElementById('topn-tier').value;
    const category = document.getElementById('topn-category').value;
    const enchFilter = document.getElementById('topn-ench').value;
    const useFocus = document.getElementById('topn-focus').checked;
    const specLevel = parseInt(document.getElementById('topn-spec').value) || 0;
    const masteryLevel = parseInt(document.getElementById('topn-mastery').value) || 0;
    const sortBy = document.getElementById('topn-sort').value;
    const liquidityMin = parseInt(document.getElementById('topn-liquidity').value) || 0;

    const data = await MarketDB.getAllPrices();
    if (!data || data.length === 0) {
        spinner.classList.add('hidden');
        results.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><p>No cached prices yet — open Market Browser once or wait for the VPS cache to load.</p></div>';
        return;
    }

    // Build price index: itemId → city → { sellMin, buyMax, dateISO }
    const priceIndex = {};
    for (const e of data) {
        if (e.quality && e.quality !== 1 && e.quality !== 0) continue; // Top-N uses Q1 baseline; Quality EV is per-detail
        let city = e.city;
        if (city && city.includes('Black Market')) city = 'Black Market';
        if (!CITIES.includes(city)) continue;
        const id = e.item_id;
        if (!priceIndex[id]) priceIndex[id] = {};
        const existing = priceIndex[id][city];
        if (!existing) priceIndex[id][city] = { sellMin: e.sell_price_min || 0, buyMax: e.buy_price_max || 0, date: (e.sell_price_min_date || e.buy_price_max_date || '') };
        else {
            if (e.sell_price_min > 0 && (existing.sellMin === 0 || e.sell_price_min < existing.sellMin)) existing.sellMin = e.sell_price_min;
            if (e.buy_price_max > 0 && e.buy_price_max > existing.buyMax) existing.buyMax = e.buy_price_max;
        }
    }

    const ranked = [];
    for (const [itemId, recipe] of Object.entries(recipesData)) {
        const { tier: t, ench } = parseTierEnch(itemId);
        if (!t) continue;
        if (tier !== 'all' && String(t) !== String(tier)) continue;
        if (enchFilter !== 'any' && String(ench) !== String(enchFilter)) continue;
        if (category !== 'all' && (recipe.category || 'other') !== category) continue;
        if (!priceIndex[itemId]) continue;

        // Pick best sell city for this item.
        // IMPORTANT: Black Market only buys finished equipment, NOT refined materials.
        // Including BM for refined materials pulled rankings toward a price the user cannot actually realise.
        const isRefinedMaterial = recipe.category === 'materials';
        const sellCityList = isRefinedMaterial ? CITIES.filter(c => c !== 'Black Market') : CITIES;
        let bestSellPrice = 0, bestSellCity = '';
        for (const c of sellCityList) {
            const p = priceIndex[itemId][c];
            if (p && p.buyMax > bestSellPrice) { bestSellPrice = p.buyMax; bestSellCity = c; }
        }
        if (bestSellPrice === 0) continue;

        // Pick specialty city for max PB (if specialty matches) else user's default (0% bonus)
        const cityDetect = recipe.category === 'materials'
            ? sellCityList.map(c => ({ c, d: getCityRefineBonus(c, itemId) }))
            : sellCityList.map(c => ({ c, d: getCityCraftBonus(c, itemId) }));
        const bestSpecialty = cityDetect.reduce((best, x) => x.d.bonus > best.d.bonus ? x : best, { c: '', d: { bonus: 0, autoApplied: false } });
        const cityBonus = bestSpecialty.d.bonus || 0;

        const activity = recipe.category === 'materials' ? 'refining' : 'crafting';
        const rrr = calculateRRR(useFocus, cityBonus, activity);
        const effMult = 1 - rrr;

        // Cheapest material cost (best city per mat)
        let matCost = 0; let missing = false;
        for (const mat of recipe.materials) {
            const mp = priceIndex[mat.id] || {};
            let cheapest = Infinity;
            for (const cn of Object.keys(mp)) {
                if (cn === 'Black Market') continue;
                const sp = mp[cn].sellMin;
                if (sp > 0 && sp < cheapest) cheapest = sp;
            }
            if (cheapest === Infinity) { missing = true; break; }
            matCost += cheapest * mat.qty * effMult;
        }
        if (missing) continue;

        // Profit
        const outputQty = recipe.output || 1;
        const revenue = bestSellPrice * outputQty;
        const tax = revenue * effectiveTaxRate('order');
        const stationS100 = CraftConfig.stationSilverPer100 || 0;
        const fee = stationS100 > 0 ? stationFeePerCraft(itemId, stationS100) : 0;
        const profit = revenue - matCost - tax - fee;
        if (profit <= 0) continue;

        // Focus cost (if using focus)
        let focusCost = 0;
        if (useFocus) {
            const baseFocus = recipe.focusCost || baseFocusForItem(itemId, activity);
            if (baseFocus > 0) focusCost = calculateFocusCostV2(baseFocus, specLevel, masteryLevel, 0, CraftConfig.foodBuff);
        }

        // Liquidity — use spreadStatsCache or analytics cache if present; else assume unlimited
        let dailyVolume = Infinity;
        const cacheKey = itemId + '_1_' + bestSellCity;
        if (analyticsCache.has(itemId)) {
            const a = analyticsCache.get(itemId);
            if (a && a.avg_volume_24h != null) dailyVolume = a.avg_volume_24h;
        }
        if (dailyVolume < liquidityMin) continue;

        ranked.push({
            itemId, recipe, profit, roi: matCost > 0 ? (profit / matCost * 100) : 0,
            matCost, revenue, tax, fee, focusCost,
            silverPerFocus: focusCost > 0 ? profit / focusCost : 0,
            silverPerHour: profit / (CRAFT_SECONDS_PER / 3600),
            bestSellCity, bestSpecialtyCity: bestSpecialty.c, cityBonus,
            rrrPct: rrr * 100, dailyVolume,
            autoSpecialty: bestSpecialty.d.autoApplied, specReason: bestSpecialty.d.reason,
        });
    }

    // Sort
    const sortFns = {
        silver_per_focus: (a, b) => b.silverPerFocus - a.silverPerFocus,
        silver_per_hour:  (a, b) => b.silverPerHour  - a.silverPerHour,
        net_profit:       (a, b) => b.profit         - a.profit,
        roi:              (a, b) => b.roi            - a.roi,
    };
    ranked.sort(sortFns[sortBy] || sortFns.net_profit);

    spinner.classList.add('hidden');
    renderTopN(ranked.slice(0, 60), sortBy);
    if (ranked.length === 0) {
        results.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><p>No profitable recipes match these filters right now.</p><p class="hint">Try widening the tier or reducing the liquidity minimum.</p></div>';
    }
}

function renderTopN(list, sortBy) {
    const container = document.getElementById('topn-results');
    if (list.length === 0) return;
    container.innerHTML = '';
    const sortLabel = { silver_per_focus: 's/focus', silver_per_hour: 's/hr', net_profit: 'net', roi: 'ROI' }[sortBy] || 'profit';
    list.forEach((r, idx) => {
        const card = document.createElement('div');
        card.className = 'topn-card';
        card.setAttribute('data-item', r.itemId);
        const primaryMetric = sortBy === 'silver_per_focus' && r.focusCost > 0
            ? `${r.silverPerFocus.toFixed(1)} s/f`
            : sortBy === 'silver_per_hour'
            ? `${Math.round(r.silverPerHour/1000)}k/hr`
            : sortBy === 'roi'
            ? `${r.roi.toFixed(1)}%`
            : `${Math.round(r.profit).toLocaleString()}s`;
        card.innerHTML = `
            <div class="topn-card-header">
                <img src="https://render.albiononline.com/v1/item/${esc(r.itemId)}.png" alt="" loading="lazy">
                <div style="flex:1 1 auto;min-width:0;">
                    <div class="topn-name">${esc(getFriendlyName(r.itemId))}</div>
                    <div class="topn-rank">#${idx + 1} · ${getTierEnchLabel(r.itemId)}</div>
                </div>
                <div style="text-align:right;">
                    <div style="color:var(--accent);font-weight:700;font-size:1rem;">${primaryMetric}</div>
                    <div style="color:var(--text-muted);font-size:0.7rem;">${sortLabel}</div>
                </div>
            </div>
            <div class="topn-card-body">
                <div class="topn-stat"><span class="topn-stat-label">Net</span><span class="topn-stat-value text-green">${Math.round(r.profit).toLocaleString()}s</span></div>
                <div class="topn-stat"><span class="topn-stat-label">Sell @</span><span class="topn-stat-value">${esc(r.bestSellCity)}</span></div>
                <div class="topn-stat"><span class="topn-stat-label">RRR</span><span class="topn-stat-value">${r.rrrPct.toFixed(1)}%</span></div>
                <div class="topn-stat"><span class="topn-stat-label">Mat Cost</span><span class="topn-stat-value">${Math.round(r.matCost).toLocaleString()}s</span></div>
                ${r.focusCost > 0 ? `<div class="topn-stat"><span class="topn-stat-label">Focus</span><span class="topn-stat-value">${r.focusCost.toLocaleString()}</span></div>` : ''}
                <div class="topn-stat"><span class="topn-stat-label">ROI</span><span class="topn-stat-value ${r.roi > 0 ? 'text-green' : 'text-red'}">${r.roi.toFixed(1)}%</span></div>
            </div>
            <div class="topn-badges">
                ${r.autoSpecialty ? `<span class="topn-badge topn-badge-specialty" title="${esc(r.specReason)}">+${r.cityBonus}% ${esc(r.bestSpecialtyCity)}</span>` : ''}
                ${r.dailyVolume === Infinity ? '' : r.dailyVolume < 50 ? '<span class="topn-badge topn-badge-illiquid">⚠ Low Volume</span>' : ''}
            </div>
        `;
        card.addEventListener('click', () => switchToCraft(r.itemId));
        container.appendChild(card);
    });
}

// ============================================================
// REFINING LAB (Phase 2 — B1-B4)
// ============================================================
// Three modes: Today's Best, Single Material Deep-Dive, Daily Focus Planner.
// Default landing = Today's Best.
let _refineMode = 'best';
function initRefineLabEvents() {
    document.querySelectorAll('.refine-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.refine-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _refineMode = btn.dataset.refineMode;
            doRefineScan(); // auto-refresh on mode switch
        });
    });
    const scanBtn = document.getElementById('refine-scan-btn');
    if (scanBtn) scanBtn.addEventListener('click', doRefineScan);
}

async function doRefineScan() {
    if (itemsList.length === 0) await loadData();
    const spinner = document.getElementById('refine-spinner');
    const results = document.getElementById('refine-results');
    spinner.classList.remove('hidden');
    results.innerHTML = '';

    const family = document.getElementById('refine-family').value;
    const tier = document.getElementById('refine-tier').value;
    const enchFilter = document.getElementById('refine-ench').value;
    const useFocus = document.getElementById('refine-focus').checked;
    const specLevel = parseInt(document.getElementById('refine-spec').value) || 0;
    const masteryLevel = parseInt(document.getElementById('refine-mastery').value) || 0;
    const focusBudget = parseInt(document.getElementById('refine-budget').value) || 10000;

    const data = await MarketDB.getAllPrices();
    if (!data || data.length === 0) {
        spinner.classList.add('hidden');
        results.innerHTML = '<div class="empty-state"><p>No cached prices yet. Open Market Browser once to hydrate the cache.</p></div>';
        return;
    }

    const priceIndex = {};
    for (const e of data) {
        if (e.quality && e.quality !== 1 && e.quality !== 0) continue;
        let city = e.city;
        if (city && city.includes('Black Market')) city = 'Black Market';
        if (!CITIES.includes(city)) continue;
        if (!priceIndex[e.item_id]) priceIndex[e.item_id] = {};
        const existing = priceIndex[e.item_id][city];
        if (!existing) priceIndex[e.item_id][city] = { sellMin: e.sell_price_min || 0, buyMax: e.buy_price_max || 0 };
        else {
            if (e.sell_price_min > 0 && (existing.sellMin === 0 || e.sell_price_min < existing.sellMin)) existing.sellMin = e.sell_price_min;
            if (e.buy_price_max > 0 && e.buy_price_max > existing.buyMax) existing.buyMax = e.buy_price_max;
        }
    }

    // Collect refining recipes (category === 'materials')
    const refineRecipes = [];
    for (const [itemId, recipe] of Object.entries(recipesData)) {
        if (recipe.category !== 'materials') continue;
        const { tier: t, ench } = parseTierEnch(itemId);
        if (!t) continue;
        if (tier !== 'all' && String(t) !== String(tier)) continue;
        if (enchFilter !== 'any' && String(ench) !== String(enchFilter)) continue;
        if (family !== 'all' && !itemId.toUpperCase().includes('_' + family)) continue;
        refineRecipes.push([itemId, recipe]);
    }

    // For each refine recipe, compute best profit at specialty city.
    // Refined materials can't be sold to BM in-game — exclude from sell city consideration.
    const refineCities = CITIES.filter(c => c !== 'Black Market');
    const rows = [];
    for (const [itemId, recipe] of refineRecipes) {
        if (!priceIndex[itemId]) continue;
        let bestSellPrice = 0, bestSellCity = '';
        for (const c of refineCities) {
            const p = priceIndex[itemId][c];
            if (p && p.buyMax > bestSellPrice) { bestSellPrice = p.buyMax; bestSellCity = c; }
        }
        if (bestSellPrice === 0) continue;

        const specBonus = refineCities.reduce((best, c) => {
            const d = getCityRefineBonus(c, itemId);
            return d.bonus > best.bonus ? { ...d, city: c } : best;
        }, { bonus: 0, city: '' });
        const cityBonus = specBonus.bonus || 0;
        const rrr = calculateRRR(useFocus, cityBonus, 'refining');
        const effMult = 1 - rrr;

        let matCost = 0; let missing = false;
        for (const mat of recipe.materials) {
            const mp = priceIndex[mat.id] || {};
            let cheapest = Infinity;
            for (const cn of Object.keys(mp)) {
                if (cn === 'Black Market') continue;
                const sp = mp[cn].sellMin;
                if (sp > 0 && sp < cheapest) cheapest = sp;
            }
            if (cheapest === Infinity) { missing = true; break; }
            matCost += cheapest * mat.qty * effMult;
        }
        if (missing) continue;

        const revenue = bestSellPrice * (recipe.output || 1);
        const tax = revenue * effectiveTaxRate('order');
        const profit = revenue - matCost - tax;
        if (profit <= 0) continue;

        const baseFocus = recipe.focusCost || baseFocusForItem(itemId, 'refining');
        const focusCost = useFocus && baseFocus > 0 ? calculateFocusCostV2(baseFocus, specLevel, masteryLevel, 0, CraftConfig.foodBuff) : 0;
        rows.push({
            itemId, profit, roi: matCost > 0 ? profit / matCost * 100 : 0,
            matCost, revenue, tax, focusCost, specCity: specBonus.city, specBonus: cityBonus,
            sellCity: bestSellCity, rrr: rrr * 100,
            silverPerFocus: focusCost > 0 ? profit / focusCost : profit, // fallback to raw profit when no focus
        });
    }

    spinner.classList.add('hidden');

    if (_refineMode === 'best') renderRefineBest(rows);
    else if (_refineMode === 'planner') renderRefinePlanner(rows, focusBudget);
    else if (_refineMode === 'deepdive') renderRefineDeepdive(rows);
}

function renderRefineBest(rows) {
    const container = document.getElementById('refine-results');
    if (rows.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No profitable refines found for these filters.</p></div>';
        return;
    }
    rows.sort((a, b) => b.silverPerFocus - a.silverPerFocus);
    let html = '<div class="topn-grid">';
    rows.slice(0, 50).forEach((r, i) => {
        html += `<div class="topn-card" data-item="${esc(r.itemId)}" onclick="switchToCraft('${esc(r.itemId)}')">
            <div class="topn-card-header">
                <img src="https://render.albiononline.com/v1/item/${esc(r.itemId)}.png" alt="" loading="lazy">
                <div style="flex:1 1 auto;min-width:0;">
                    <div class="topn-name">${esc(getFriendlyName(r.itemId))}</div>
                    <div class="topn-rank">#${i+1} · ${getTierEnchLabel(r.itemId)}</div>
                </div>
                <div style="text-align:right;">
                    <div style="color:var(--accent);font-weight:700;">${r.focusCost > 0 ? r.silverPerFocus.toFixed(1)+' s/f' : Math.round(r.profit).toLocaleString()+'s'}</div>
                    <div style="color:var(--text-muted);font-size:0.7rem;">${r.focusCost > 0 ? 'silver/focus' : 'net profit'}</div>
                </div>
            </div>
            <div class="topn-card-body">
                <div class="topn-stat"><span class="topn-stat-label">Net</span><span class="topn-stat-value text-green">${Math.round(r.profit).toLocaleString()}s</span></div>
                <div class="topn-stat"><span class="topn-stat-label">Sell @</span><span class="topn-stat-value">${esc(r.sellCity)}</span></div>
                <div class="topn-stat"><span class="topn-stat-label">Refine @</span><span class="topn-stat-value">${esc(r.specCity) || '—'}</span></div>
                <div class="topn-stat"><span class="topn-stat-label">RRR</span><span class="topn-stat-value">${r.rrr.toFixed(1)}%</span></div>
            </div>
            <div class="topn-badges">
                ${r.specBonus > 0 ? `<span class="topn-badge topn-badge-specialty">+${r.specBonus}% ${esc(r.specCity)}</span>` : ''}
            </div>
        </div>`;
    });
    html += '</div>';
    container.innerHTML = html;
}

function renderRefinePlanner(rows, focusBudget) {
    const container = document.getElementById('refine-results');
    if (rows.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No profitable refines — can\'t plan.</p></div>';
        return;
    }
    // Sort by silver-per-focus descending; greedy allocate focus budget.
    const candidates = rows.filter(r => r.focusCost > 0).sort((a, b) => b.silverPerFocus - a.silverPerFocus);
    if (candidates.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>Enable focus to use the Daily Focus Planner.</p></div>';
        return;
    }
    let remaining = focusBudget;
    const plan = [];
    for (const r of candidates) {
        if (remaining < r.focusCost) continue;
        const runs = Math.floor(remaining / r.focusCost);
        if (runs > 0) {
            plan.push({ ...r, runs, totalProfit: runs * r.profit, totalFocus: runs * r.focusCost });
            remaining -= runs * r.focusCost;
        }
    }
    const totalProfit = plan.reduce((s, p) => s + p.totalProfit, 0);
    const totalFocus = plan.reduce((s, p) => s + p.totalFocus, 0);
    let html = `<div class="refine-planner">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
            <div><strong>Budget:</strong> ${focusBudget.toLocaleString()} focus</div>
            <div><strong>Used:</strong> ${totalFocus.toLocaleString()} focus (${Math.round(totalFocus/focusBudget*100)}%)</div>
            <div><strong class="text-green">Expected: ${Math.round(totalProfit).toLocaleString()}s</strong></div>
        </div>
        <div class="plan-row header">
            <span>Item</span>
            <span>Runs</span>
            <span class="plan-hide-mobile">Focus Used</span>
            <span class="plan-hide-mobile">s/focus</span>
            <span>Total Profit</span>
        </div>`;
    for (const p of plan) {
        html += `<div class="plan-row">
            <span><img src="https://render.albiononline.com/v1/item/${esc(p.itemId)}.png" style="width:24px;height:24px;vertical-align:middle;margin-right:0.35rem;"> ${esc(getFriendlyName(p.itemId))}</span>
            <span>${p.runs}×</span>
            <span class="plan-hide-mobile">${p.totalFocus.toLocaleString()}</span>
            <span class="plan-hide-mobile">${p.silverPerFocus.toFixed(1)}</span>
            <span class="plan-budget">${Math.round(p.totalProfit).toLocaleString()}s</span>
        </div>`;
    }
    if (plan.length === 0) html += '<div class="empty-state"><p>Not enough budget to complete any profitable refine batch.</p></div>';
    html += `</div>`;
    container.innerHTML = html;
}

function renderRefineDeepdive(rows) {
    const container = document.getElementById('refine-results');
    if (rows.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>Nothing to dive into — no profitable refines match these filters.</p></div>';
        return;
    }
    // Show the top candidate, give option to switch to Crafting Profits detail.
    const top = rows.sort((a,b) => b.silverPerFocus - a.silverPerFocus)[0];
    container.innerHTML = `<div class="refine-planner">
        <h3 style="margin:0 0 0.5rem 0;">🔍 Deep-Dive: ${esc(getFriendlyName(top.itemId))} <span class="tier-badge">${getTierEnchLabel(top.itemId)}</span></h3>
        <p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 0.5rem 0;">Top candidate from your current filters. Click "Open in Crafting" for the full sub-recipe tree, city heatmap, and inverse calc.</p>
        <div class="craft-summary-stats">
            <div class="stat-box"><div class="stat-label">Profit per run</div><div class="stat-value text-green">${Math.round(top.profit).toLocaleString()}s</div></div>
            <div class="stat-box"><div class="stat-label">Silver/focus</div><div class="stat-value">${top.focusCost > 0 ? top.silverPerFocus.toFixed(1) : '—'}</div></div>
            <div class="stat-box"><div class="stat-label">Best refine city</div><div class="stat-value">${esc(top.specCity) || '—'} (+${top.specBonus}%)</div></div>
            <div class="stat-box"><div class="stat-label">Best sell city</div><div class="stat-value">${esc(top.sellCity)}</div></div>
            <div class="stat-box"><div class="stat-label">RRR</div><div class="stat-value">${top.rrr.toFixed(1)}%</div></div>
            <div class="stat-box"><div class="stat-label">ROI</div><div class="stat-value">${top.roi.toFixed(1)}%</div></div>
        </div>
        <div style="margin-top:0.75rem;">
            <button class="btn-primary" onclick="switchToCraft('${esc(top.itemId)}')">Open in Crafting Profits →</button>
        </div>
    </div>`;
}

// Timeline rich tooltip: on hover of a .ll-timeline-bar with data-tip-html,
// show a floating tooltip with death details (guild-colored).
function initTimelineRichTooltip() {
    let tipEl = null;
    const showTip = (bar, ev) => {
        const encoded = bar.getAttribute('data-tip-html');
        if (!encoded) return;
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.className = 'll-timeline-rich-tip';
            document.body.appendChild(tipEl);
        }
        tipEl.innerHTML = decodeURIComponent(encoded);
        tipEl.style.display = 'block';
        const rect = bar.getBoundingClientRect();
        const tipRect = tipEl.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - tipRect.width / 2;
        let top = rect.top - tipRect.height - 8;
        if (top < 8) top = rect.bottom + 8;
        if (left < 8) left = 8;
        if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
        tipEl.style.left = left + 'px';
        tipEl.style.top = top + 'px';
    };
    const hideTip = () => { if (tipEl) tipEl.style.display = 'none'; };
    document.addEventListener('mouseover', (e) => {
        const bar = e.target.closest('.ll-timeline-bar[data-tip-html]');
        if (bar) showTip(bar, e);
    });
    document.addEventListener('mouseout', (e) => {
        const bar = e.target.closest('.ll-timeline-bar');
        if (bar) hideTip();
    });
}

function initTopNRankerEvents() {
    const btn = document.getElementById('topn-scan-btn');
    if (btn) btn.addEventListener('click', doTopNRank);
    // Auto-rerun when sort changes (cheap since we already have rankings rebuilt)
    ['topn-sort','topn-tier','topn-category','topn-ench','topn-liquidity'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => {
            // Only rerun if we've already scanned once (has results)
            const results = document.getElementById('topn-results');
            if (results && !results.querySelector('.empty-state')) doTopNRank();
        });
    });
}

// ============================================================
// CRAFTER PROFILES (Phase 5 — C1)
// ============================================================
// Multiple named profiles stored in localStorage. Each profile carries
// spec, mastery, city, premium, food buff, basePB, stationSilverPer100.
// A "crafter pill" in the nav summary shows the active profile and opens the modal.
const CRAFTER_PROFILE_STORAGE = 'crafterProfiles_v1';

function loadCrafterProfiles() {
    try {
        const raw = JSON.parse(localStorage.getItem(CRAFTER_PROFILE_STORAGE) || '{"profiles":[],"activeId":null}');
        return raw.profiles ? raw : { profiles: [], activeId: null };
    } catch { return { profiles: [], activeId: null }; }
}
function saveCrafterProfiles(state) { try { localStorage.setItem(CRAFTER_PROFILE_STORAGE, JSON.stringify(state)); } catch {} }

function getActiveCrafterProfile() {
    const s = loadCrafterProfiles();
    return s.profiles.find(p => p.id === s.activeId) || null;
}

function applyCrafterProfile(profile) {
    if (!profile) return;
    // Write to CraftConfig + relevant inputs
    CraftConfig.premium = profile.premium !== false;
    CraftConfig.craftingBasePB = profile.basePB || 18;
    CraftConfig.foodBuff = profile.foodBuff || 'none';
    CraftConfig.stationSilverPer100 = profile.stationSilverPer100 || 200;
    saveCraftConfig();

    // Propagate to Crafting tab inputs
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = String(v); };
    const check = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.checked = !!v; };
    set('craft-spec', profile.spec || 0);
    set('craft-mastery', profile.mastery || 0);
    set('craft-food', profile.foodBuff || 'none');
    set('craft-base-pb', profile.basePB || 18);
    set('craft-station-s100', profile.stationSilverPer100 || 200);
    check('craft-premium', profile.premium !== false);
    // RRR tab
    set('rrr-spec', profile.spec || 0);
    check('rrr-premium', profile.premium !== false);
    set('rrr-base-pb', profile.basePB || 18);
    // Top-N tab
    set('topn-spec', profile.spec || 0);
    set('topn-mastery', profile.mastery || 0);
    // Refining Lab
    set('refine-spec', profile.spec || 0);
    set('refine-mastery', profile.mastery || 0);
    updateCrafterProfilePill();
}

function updateCrafterProfilePill() {
    const pill = document.getElementById('crafter-profile-pill');
    if (!pill) return;
    const active = getActiveCrafterProfile();
    if (active) {
        pill.innerHTML = `🧑‍🔧 ${esc(active.name)} <span style="opacity:0.7;font-size:0.7rem;">· spec ${active.spec || 0} · ${esc(active.foodBuff || 'no food')}</span>`;
        pill.title = '';
        pill.style.display = '';
    } else {
        const seen = localStorage.getItem('crafterPillSeen');
        if (!seen) {
            // First visit: show full CTA, mark as seen for next time
            localStorage.setItem('crafterPillSeen', '1');
            pill.innerHTML = `🧑‍🔧 No profile — click to create`;
            pill.title = '';
        } else {
            // Subsequent visits: compact icon only with tooltip
            pill.innerHTML = `🧑‍🔧`;
            pill.title = 'No crafter profile — click to create one';
        }
        pill.style.display = '';
    }
}

function openCrafterProfileModal() {
    let modal = document.getElementById('crafter-profile-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'crafter-profile-modal';
        modal.className = 'modal hidden';
        modal.innerHTML = `<div class="modal-content crafter-profile-modal-content">
            <button class="close-btn" id="crafter-profile-close">&times;</button>
            <h3>🧑‍🔧 Crafter Profiles</h3>
            <p style="color:var(--text-secondary);font-size:0.85rem;">Save your spec, mastery, city, premium, food buff, and station setup per profile. Quick-switch propagates everywhere (Crafting, RRR, Refining Lab, Top-N, Repair, Journals).</p>
            <div style="margin:0.75rem 0;padding:0.75rem;background:rgba(255,255,255,0.03);border-radius:6px;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
                    <div class="control-group"><label>Name<input type="text" id="cp-name" placeholder="e.g. Plate Specialist" style="width:100%;"></label></div>
                    <div class="control-group"><label>Spec<input type="number" id="cp-spec" min="0" max="100" value="100" style="width:100%;"></label></div>
                    <div class="control-group"><label>Mastery<input type="number" id="cp-mastery" min="0" max="100" value="0" style="width:100%;"></label></div>
                    <div class="control-group"><label>Preferred City<select id="cp-city" style="width:100%;">
                        <option value="">— none —</option>
                        ${CITIES.filter(c => c !== 'Black Market').map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
                    </select></label></div>
                    <div class="control-group"><label>Food Buff<select id="cp-food" style="width:100%;">
                        <option value="none">None</option>
                        <option value="pork">Pork Omelette</option>
                        <option value="avalonian">Avalonian Pork</option>
                    </select></label></div>
                    <div class="control-group"><label>Base PB<select id="cp-basepb" style="width:100%;"><option value="18" selected>18</option><option value="15">15</option></select></label></div>
                    <div class="control-group"><label>Station s/100<input type="number" id="cp-s100" min="0" max="5000" value="200" step="10" style="width:100%;"></label></div>
                    <div class="control-group checkbox-group" style="display:flex;align-items:center;"><label><input type="checkbox" id="cp-premium" checked> Premium</label></div>
                </div>
                <div style="margin-top:0.6rem;display:flex;gap:0.4rem;">
                    <button class="btn-primary" id="cp-save-btn">💾 Save as New Profile</button>
                    <button class="btn-secondary" id="cp-update-btn">Update Active</button>
                </div>
            </div>
            <div class="crafter-profile-list" id="cp-list"></div>
        </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#crafter-profile-close').addEventListener('click', () => modal.classList.add('hidden'));
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
        modal.querySelector('#cp-save-btn').addEventListener('click', () => {
            const name = (document.getElementById('cp-name').value || '').trim();
            if (!name) { showToast('Profile name is required', 'error'); return; }
            const state = loadCrafterProfiles();
            const prof = {
                id: 'p_' + Date.now(),
                name,
                spec: parseInt(document.getElementById('cp-spec').value) || 0,
                mastery: parseInt(document.getElementById('cp-mastery').value) || 0,
                city: document.getElementById('cp-city').value || '',
                foodBuff: document.getElementById('cp-food').value || 'none',
                basePB: parseInt(document.getElementById('cp-basepb').value) || 18,
                stationSilverPer100: parseInt(document.getElementById('cp-s100').value) || 200,
                premium: !!document.getElementById('cp-premium').checked,
            };
            state.profiles.push(prof);
            state.activeId = prof.id;
            saveCrafterProfiles(state);
            applyCrafterProfile(prof);
            renderCrafterProfileList();
            showToast(`Profile "${name}" saved and activated ✓`, 'success');
        });
        modal.querySelector('#cp-update-btn').addEventListener('click', () => {
            const state = loadCrafterProfiles();
            const active = state.profiles.find(p => p.id === state.activeId);
            if (!active) { showToast('No active profile to update. Save a new one first.', 'info'); return; }
            active.name = (document.getElementById('cp-name').value || active.name).trim();
            active.spec = parseInt(document.getElementById('cp-spec').value) || 0;
            active.mastery = parseInt(document.getElementById('cp-mastery').value) || 0;
            active.city = document.getElementById('cp-city').value || '';
            active.foodBuff = document.getElementById('cp-food').value || 'none';
            active.basePB = parseInt(document.getElementById('cp-basepb').value) || 18;
            active.stationSilverPer100 = parseInt(document.getElementById('cp-s100').value) || 200;
            active.premium = !!document.getElementById('cp-premium').checked;
            saveCrafterProfiles(state);
            applyCrafterProfile(active);
            renderCrafterProfileList();
            showToast(`Profile "${active.name}" updated ✓`, 'success');
        });
    }
    modal.classList.remove('hidden');
    // Seed form with currently-active profile values
    const active = getActiveCrafterProfile();
    if (active) {
        document.getElementById('cp-name').value = active.name;
        document.getElementById('cp-spec').value = active.spec || 0;
        document.getElementById('cp-mastery').value = active.mastery || 0;
        document.getElementById('cp-city').value = active.city || '';
        document.getElementById('cp-food').value = active.foodBuff || 'none';
        document.getElementById('cp-basepb').value = String(active.basePB || 18);
        document.getElementById('cp-s100').value = active.stationSilverPer100 || 200;
        document.getElementById('cp-premium').checked = active.premium !== false;
    }
    renderCrafterProfileList();
}

function renderCrafterProfileList() {
    const list = document.getElementById('cp-list');
    if (!list) return;
    const state = loadCrafterProfiles();
    if (state.profiles.length === 0) { list.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No profiles yet. Save your current setup above to create the first one.</p>'; return; }
    list.innerHTML = state.profiles.map(p => `
        <div class="crafter-profile-item ${p.id === state.activeId ? 'active' : ''}">
            <div>
                <div class="profile-name">${esc(p.name)}</div>
                <div class="profile-specs">spec ${p.spec || 0} · mastery ${p.mastery || 0} · ${esc(p.city || 'no city')} · ${esc(p.foodBuff || 'no food')} · ${p.premium !== false ? 'premium' : 'non-premium'}</div>
            </div>
            <div class="profile-actions">
                <button class="btn-small-accent" data-cp-activate="${esc(p.id)}">Activate</button>
                <button class="btn-small-danger" data-cp-delete="${esc(p.id)}">🗑</button>
            </div>
        </div>
    `).join('');
    list.querySelectorAll('[data-cp-activate]').forEach(b => b.addEventListener('click', () => {
        const id = b.getAttribute('data-cp-activate');
        const st = loadCrafterProfiles();
        st.activeId = id;
        saveCrafterProfiles(st);
        const p = st.profiles.find(pp => pp.id === id);
        if (p) applyCrafterProfile(p);
        renderCrafterProfileList();
        showToast(`Switched to "${p?.name}" ✓`, 'success');
    }));
    list.querySelectorAll('[data-cp-delete]').forEach(b => b.addEventListener('click', () => {
        const id = b.getAttribute('data-cp-delete');
        const st = loadCrafterProfiles();
        st.profiles = st.profiles.filter(p => p.id !== id);
        if (st.activeId === id) st.activeId = null;
        saveCrafterProfiles(st);
        renderCrafterProfileList();
        updateCrafterProfilePill();
    }));
}

function initCrafterProfileEvents() {
    // Inject the pill into the header if not present
    if (!document.getElementById('crafter-profile-pill')) {
        const hero = document.querySelector('header') || document.body;
        const pill = document.createElement('span');
        pill.id = 'crafter-profile-pill';
        pill.className = 'crafter-profile-pill';
        pill.style.display = 'none';
        pill.addEventListener('click', openCrafterProfileModal);
        // Attach to the nav area if possible
        const nav = document.querySelector('.main-nav') || document.querySelector('nav');
        (nav || hero).appendChild(pill);
    }
    // Load + apply active profile
    const active = getActiveCrafterProfile();
    if (active) applyCrafterProfile(active);
    updateCrafterProfilePill();
}

// ============================================================
// BONUS — Monte-Carlo Craft Session Simulator
// ============================================================
// Given spec/mastery/focus/runs, simulates actual outcomes factoring in
// RRR variance and quality rolls — returns silver distribution (p5/p50/p95).
// Shows the *risk profile* of a crafting session, not just expected value.
// No competitor does this; helps players gauge "best-case vs worst-case" income.
function runCraftMonteCarlo(itemId, recipe, priceIndex, cfg, runs = 1000) {
    // cfg: { useFocus, specLevel, masteryLevel, cityBonus, isRefining, qualityPoints }
    const rrrMean = calculateRRR(cfg.useFocus, cfg.cityBonus || 0, cfg.isRefining ? 'refining' : 'crafting');
    // For each craft, sample Bernoulli-per-material for "returned"; sum materials used.
    // For quality, sample from the user's distribution.
    const qDist = qualityDistribution(cfg.qualityPoints || 0);
    const matUnitCosts = recipe.materials.map(m => {
        const by = priceIndex[m.id] || {};
        let c = Infinity;
        for (const cn of Object.keys(by)) {
            if (cn === 'Black Market') continue;
            if (by[cn].sellMin > 0 && by[cn].sellMin < c) c = by[cn].sellMin;
        }
        return c === Infinity ? 0 : c;
    });
    const sellPrices = [cfg.q1Price || 0, cfg.q2Price || cfg.q1Price || 0, cfg.q3Price || cfg.q1Price || 0, cfg.q4Price || cfg.q1Price || 0, cfg.q5Price || cfg.q1Price || 0];
    const results = [];
    const sessionRuns = Math.max(1, cfg.sessionRuns || runs);
    const samples = 400;
    for (let s = 0; s < samples; s++) {
        let totalMatsConsumed = 0;
        let totalRevenue = 0;
        for (let i = 0; i < sessionRuns; i++) {
            // Materials: for each material unit, roll P(return) = rrrMean → consumed = qty × (1 - Σ returns)
            for (let mi = 0; mi < recipe.materials.length; mi++) {
                const mat = recipe.materials[mi];
                let consumed = 0;
                for (let q = 0; q < mat.qty; q++) {
                    if (Math.random() > rrrMean) consumed++;
                }
                totalMatsConsumed += consumed * matUnitCosts[mi];
            }
            // Quality roll
            const r = Math.random();
            let cum = 0; let qRolled = 0;
            for (let q = 0; q < 5; q++) { cum += qDist[q]; if (r <= cum) { qRolled = q; break; } }
            totalRevenue += sellPrices[qRolled] * (recipe.output || 1);
        }
        const tax = totalRevenue * effectiveTaxRate('order');
        const net = totalRevenue - totalMatsConsumed - tax;
        results.push(net);
    }
    results.sort((a, b) => a - b);
    return {
        p5: results[Math.floor(samples * 0.05)],
        p50: results[Math.floor(samples * 0.50)],
        p95: results[Math.floor(samples * 0.95)],
        mean: results.reduce((a, b) => a + b, 0) / results.length,
        min: results[0], max: results[results.length - 1],
        samples: results,
    };
}

function openCraftSimulator() {
    const itemId = craftDetailItemId || window._craftLastItemId;
    if (!itemId || !recipesData[itemId]) { showToast('Calculate a craft first before running the simulator', 'info'); return; }
    let modal = document.getElementById('craft-sim-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'craft-sim-modal';
        modal.className = 'modal hidden';
        modal.innerHTML = `<div class="modal-content craft-sim-panel" style="max-width:640px;">
            <button class="close-btn" id="craft-sim-close">&times;</button>
            <h3 style="margin:0 0 0.5rem 0;color:var(--accent);">🎲 Monte-Carlo Craft Simulator</h3>
            <p style="color:var(--text-secondary);font-size:0.85rem;margin:0 0 0.75rem 0;">Simulates 400 full crafting sessions using your spec/RRR/quality distribution. Shows the silver-earned distribution — p5 (unlucky), p50 (median), p95 (lucky).</p>
            <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;align-items:center;flex-wrap:wrap;">
                <div class="control-group"><label>Session runs<input type="number" id="sim-runs" min="1" max="10000" value="200" style="width:80px;"></label></div>
                <button class="btn-primary" id="sim-run-btn">Simulate</button>
                <span id="sim-target" style="color:var(--text-muted);font-size:0.8rem;"></span>
            </div>
            <div class="craft-sim-chart" id="sim-chart"></div>
            <div class="craft-sim-stats" id="sim-stats"></div>
        </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#craft-sim-close').addEventListener('click', () => modal.classList.add('hidden'));
        modal.querySelector('#sim-run-btn').addEventListener('click', () => renderCraftSim());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
    }
    modal.classList.remove('hidden');
    document.getElementById('sim-target').textContent = `Target: ${getFriendlyName(itemId)} (${itemId})`;
    renderCraftSim();
}

function renderCraftSim() {
    const itemId = craftDetailItemId || window._craftLastItemId;
    const recipe = recipesData[itemId];
    if (!recipe) return;
    const data = window._craftLastData || [];
    // Build a quick priceIndex similar to detail view
    const priceIndex = {};
    for (const e of data) {
        let city = e.city;
        if (city && city.includes('Black Market')) city = 'Black Market';
        const id = e.item_id;
        if (!priceIndex[id]) priceIndex[id] = {};
        if (!priceIndex[id][city]) priceIndex[id][city] = { sellMin: e.sell_price_min || 0, buyMax: e.buy_price_max || 0 };
        else {
            if (e.sell_price_min > 0 && (priceIndex[id][city].sellMin === 0 || e.sell_price_min < priceIndex[id][city].sellMin)) priceIndex[id][city].sellMin = e.sell_price_min;
            if (e.buy_price_max > 0 && e.buy_price_max > priceIndex[id][city].buyMax) priceIndex[id][city].buyMax = e.buy_price_max;
        }
    }
    // Gather per-quality prices (use buyMax = insta-sell for realism)
    const qPrices = {};
    for (const e of data) {
        if (e.item_id !== itemId) continue;
        const q = e.quality || 1;
        if (!qPrices[q]) qPrices[q] = 0;
        if (e.buy_price_max > qPrices[q]) qPrices[q] = e.buy_price_max;
    }
    const cfg = {
        useFocus: document.getElementById('craft-use-focus')?.checked || false,
        specLevel: parseInt(document.getElementById('craft-spec')?.value) || 0,
        masteryLevel: parseInt(document.getElementById('craft-mastery')?.value) || 0,
        cityBonus: parseFloat(document.getElementById('craft-city-bonus')?.value) || 0,
        isRefining: recipe.category === 'materials',
        qualityPoints: (parseInt(document.getElementById('craft-spec')?.value) || 0) * 0.8 + (parseInt(document.getElementById('craft-mastery')?.value) || 0) * 0.8,
        q1Price: qPrices[1] || 0, q2Price: qPrices[2] || 0, q3Price: qPrices[3] || 0, q4Price: qPrices[4] || 0, q5Price: qPrices[5] || 0,
        sessionRuns: parseInt(document.getElementById('sim-runs').value) || 200,
    };
    const result = runCraftMonteCarlo(itemId, recipe, priceIndex, cfg);

    // Histogram
    const chart = document.getElementById('sim-chart');
    if (chart) {
        const bins = 30;
        const range = (result.max - result.min) || 1;
        const hist = Array(bins).fill(0);
        for (const s of result.samples) {
            const idx = Math.min(bins - 1, Math.floor(((s - result.min) / range) * bins));
            hist[idx]++;
        }
        const maxBin = Math.max(...hist, 1);
        chart.innerHTML = hist.map(h => `<div class="craft-sim-bar" style="height:${(h / maxBin * 100).toFixed(1)}%"></div>`).join('');
    }
    const stats = document.getElementById('sim-stats');
    if (stats) {
        stats.innerHTML = `
            <div class="stat-box"><div class="stat-label">Unlucky (p5)</div><div class="stat-value ${result.p5 >= 0 ? 'text-green' : 'text-red'}">${Math.round(result.p5).toLocaleString()} s</div></div>
            <div class="stat-box highlight"><div class="stat-label">Median (p50)</div><div class="stat-value ${result.p50 >= 0 ? 'text-green' : 'text-red'}">${Math.round(result.p50).toLocaleString()} s</div></div>
            <div class="stat-box"><div class="stat-label">Lucky (p95)</div><div class="stat-value text-green">${Math.round(result.p95).toLocaleString()} s</div></div>
            <div class="stat-box"><div class="stat-label">Mean</div><div class="stat-value">${Math.round(result.mean).toLocaleString()} s</div></div>
            <div class="stat-box"><div class="stat-label">Range</div><div class="stat-value" style="font-size:0.9rem;">${Math.round(result.min).toLocaleString()} → ${Math.round(result.max).toLocaleString()}</div></div>
        `;
    }
}

function initCraftSimEvents() {
    // A "Run Simulator" button is added inside renderCraftDetail via inline wiring.
    // We also add a global button near the Crafting settings panel after it's been shown.
    // Hook: listen for the detail view becoming visible, add a button if missing.
    const observer = new MutationObserver(() => {
        const view = document.getElementById('craft-detail-view');
        if (view && view.style.display !== 'none' && !document.getElementById('craft-sim-open-btn')) {
            const summaryCards = view.querySelector('.craft-summary-card');
            if (summaryCards) {
                const btn = document.createElement('button');
                btn.id = 'craft-sim-open-btn';
                btn.className = 'btn-secondary';
                btn.style.cssText = 'margin-top:0.5rem;';
                btn.textContent = '🎲 Run Monte-Carlo Simulator';
                btn.addEventListener('click', openCraftSimulator);
                summaryCards.appendChild(btn);
            }
        }
    });
    // Observe body for attribute changes is expensive; just observe the pane.
    const pane = document.getElementById('pane-crafting');
    if (pane) observer.observe(pane, { subtree: true, attributes: true, attributeFilter: ['style'] });
}

function switchToCraft(itemId) {
    // Switch to crafting tab, pre-fill the search, and auto-calculate
    document.querySelector('[data-tab="crafting"]')?.click();
    setTimeout(() => {
        const search = document.getElementById('craft-search');
        if (search) {
            search.value = getFriendlyName(itemId) || itemId;
            search.dispatchEvent(new Event('input'));
            // Auto-trigger calculation after autocomplete settles
            setTimeout(() => {
                const calcBtn = document.getElementById('craft-calc-btn');
                if (calcBtn) calcBtn.click();
            }, 300);
        }
    }, 100);
}

// Cross-tab nav helpers — open a target tab pre-filled for the given item.
function switchToRefineLab(itemId) {
    document.querySelector('[data-tab="refining-lab"]')?.click();
    setTimeout(() => {
        // If the item has a known family, pre-filter; else show "All Families".
        if (itemId) {
            const u = itemId.toUpperCase();
            const fam = ['PLANKS','METALBAR','CLOTH','LEATHER','STONEBLOCK'].find(f => u.includes('_' + f));
            if (fam) {
                const famSel = document.getElementById('refine-family');
                if (famSel) famSel.value = fam;
            }
            const tier = parseTierEnch(itemId).tier;
            const tierSel = document.getElementById('refine-tier');
            if (tier && tierSel) tierSel.value = String(tier);
        }
        const btn = document.getElementById('refine-scan-btn');
        if (btn) btn.click();
    }, 120);
}

function switchToTopN(opts = {}) {
    document.querySelector('[data-tab="craft-top-n"]')?.click();
    setTimeout(() => {
        if (opts.tier) { const el = document.getElementById('topn-tier'); if (el) el.value = String(opts.tier); }
        if (opts.category) { const el = document.getElementById('topn-category'); if (el) el.value = opts.category; }
        const btn = document.getElementById('topn-scan-btn');
        if (btn) btn.click();
    }, 120);
}

function switchToBrowser(itemId) {
    document.querySelector('[data-tab="browser"]')?.click();
    setTimeout(() => {
        const search = document.getElementById('browser-search');
        if (search) {
            search.value = getFriendlyName(itemId) || itemId;
            browserPage = 1;
            renderBrowser();
            // Update URL for sharing
            const url = new URL(window.location);
            url.searchParams.set('tab', 'browser');
            url.searchParams.set('item', itemId);
            history.replaceState(null, '', url);
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
    const formEl = document.getElementById('alert-create-btn')?.closest('.controls-panel');
    if (!listEl) return;

    if (!localStorage.getItem('albion_auth_token')) {
        listEl.innerHTML = '<div class="empty-state"><p>Login to create and manage price alerts.</p></div>';
        if (emptyEl) emptyEl.style.display = 'none';
        if (formEl) formEl.style.display = 'none';
        return;
    }
    if (formEl) formEl.style.display = '';

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
    showConfirm(`Delete alert for channel ${channelId}?`, async () => {
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
    });
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
                <div class="profit-row"><span>Tax (${(TAX_RATE*100).toFixed(1)}%):</span><span class="text-red">-${Math.floor(trade.tax).toLocaleString()} silver</span></div>
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

    // Base production bonus values (DECISION-A1: user-configurable, default 18 each).
    const basePB = activityType === 'refining' ? CraftConfig.refiningBasePB : CraftConfig.craftingBasePB;
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

// SEC-H4: handle ?reset=<token> email link — strip token from URL, show reset modal
function _handlePasswordResetParam() {
    const params = new URLSearchParams(window.location.search);
    const resetToken = params.get('reset');
    if (!resetToken) return;
    history.replaceState(null, '', window.location.pathname); // strip token from URL immediately

    const modal = document.getElementById('reset-password-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    const submitBtn = document.getElementById('reset-pw-submit');
    const errDiv = document.getElementById('reset-pw-error');
    const errText = document.getElementById('reset-pw-error-text');
    const successDiv = document.getElementById('reset-pw-success');
    const formWrap = document.getElementById('reset-pw-form-wrap');

    submitBtn.addEventListener('click', async () => {
        const newPassword = document.getElementById('reset-pw-input').value;
        if (errDiv) errDiv.style.display = 'none';
        if (!newPassword || newPassword.length < 8) {
            if (errDiv && errText) { errText.textContent = 'Password must be at least 8 characters.'; errDiv.style.display = 'flex'; }
            return;
        }
        submitBtn.disabled = true; submitBtn.textContent = 'Saving...';
        try {
            const res = await fetch(`${VPS_BASE}/api/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: resetToken, newPassword })
            });
            const data = await res.json();
            if (data.ok) {
                if (formWrap) formWrap.style.display = 'none';
                if (successDiv) successDiv.style.display = 'flex';
                setTimeout(() => { modal.style.display = 'none'; }, 3000);
            } else {
                if (errDiv && errText) { errText.textContent = data.error || 'Reset failed. The link may have expired.'; errDiv.style.display = 'flex'; }
                submitBtn.disabled = false; submitBtn.textContent = 'Set Password';
            }
        } catch {
            if (errDiv && errText) { errText.textContent = 'Could not reach server. Please try again.'; errDiv.style.display = 'flex'; }
            submitBtn.disabled = false; submitBtn.textContent = 'Set Password';
        }
    });
}

async function checkDiscordAuth() {
    const overlay = document.getElementById('landing-overlay');
    const authChecking = document.getElementById('landing-auth-checking');
    const authContent = document.getElementById('landing-auth-content');
    const authError = document.getElementById('landing-auth-error');
    const authErrorText = document.getElementById('landing-auth-error-text');

    _handlePasswordResetParam(); // SEC-H4: detect ?reset= before clearing URL params

    // Handle redirect back from OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const loginParam = urlParams.get('login');
    const codeParam = urlParams.get('code');   // SEC-C1: exchange code replaces raw token in URL
    const tokenParam = urlParams.get('token'); // legacy fallback (kept for any direct links)
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
    if (loginParam || codeParam || tokenParam) {
        // SEC-C1: exchange short-lived code for JWT (code never stays in URL/history/logs).
        if (codeParam) {
            history.replaceState(null, '', window.location.pathname); // strip code from URL immediately
            try {
                const exchRes = await fetch(`${VPS_BASE}/api/auth/exchange`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: codeParam })
                });
                if (exchRes.ok) {
                    const exchData = await exchRes.json();
                    if (exchData.token) localStorage.setItem('albion_auth_token', exchData.token);
                }
            } catch { /* exchange failed — fall through, user will see login UI */ }
        } else if (tokenParam) {
            // Legacy: direct token param (e.g. from old bookmarks)
            localStorage.setItem('albion_auth_token', tokenParam);
            history.replaceState(null, '', window.location.pathname);
        }
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
        if (DEBUG) console.log('Discord OAuth check failed:', e.message);
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
                    if (DEBUG) console.log('[Auth] VPS unreachable — logged in from cached JWT claims');
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

// === NEWS BANNER ===
async function loadNewsBanner() {
    try {
        const res = await fetch(`${VPS_BASE}/api/news`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return;
        const data = await res.json();
        const el = document.getElementById('news-banner');
        if (!el || !data.active || !data.message) { if (el) el.style.display = 'none'; return; }
        // Don't show if user dismissed this exact message
        const dismissedKey = 'news_dismissed_' + (data.updatedAt || 0);
        if (localStorage.getItem(dismissedKey)) { el.style.display = 'none'; return; }
        const linkHtml = data.link ? ` <a href="${esc(data.link)}" target="_blank" rel="noopener noreferrer">Learn more</a>` : '';
        el.className = `banner-${esc(data.type || 'info')}`;
        el.innerHTML = `${esc(data.message)}${linkHtml}<button class="banner-close">&times;</button>`;
        el.querySelector('.banner-close').addEventListener('click', () => {
            el.style.display = 'none';
            localStorage.setItem(dismissedKey, '1');
        });
        el.style.display = '';
    } catch { /* silent */ }
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
            if (DEBUG) console.log(`Loaded ${payload.count} prices from server cache (${payload.timestamp})`);
            await updateDbStatus();
            return true;
        }
    } catch (e) {
        if (DEBUG) console.log('Server cache not available, using local data:', e.message);
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

// Initialise all new crafting config controls from CraftConfig + bind change handlers.
function initCraftConfigControls() {
    loadCraftConfig();
    const bindCB = (id, key, onChange) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = !!CraftConfig[key];
        el.addEventListener('change', () => {
            CraftConfig[key] = el.checked;
            saveCraftConfig();
            if (onChange) onChange();
        });
    };
    const bindSelect = (id, key, parse, onChange) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = String(CraftConfig[key]);
        el.addEventListener('change', () => {
            CraftConfig[key] = parse ? parse(el.value) : el.value;
            saveCraftConfig();
            if (onChange) onChange();
        });
    };
    const bindNum = (id, key, min, max, onChange) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = String(CraftConfig[key]);
        el.addEventListener('change', () => {
            let v = parseFloat(el.value);
            if (isNaN(v)) v = CraftConfig[key];
            if (min != null) v = Math.max(min, v);
            if (max != null) v = Math.min(max, v);
            CraftConfig[key] = v;
            el.value = String(v);
            saveCraftConfig();
            if (onChange) onChange();
        });
    };
    const recalc = () => {
        if (window._craftLastData && window._craftLastRecipe && window._craftLastItemId) {
            renderCraftDetail(window._craftLastItemId, window._craftLastRecipe, window._craftLastData);
        }
    };
    bindCB('craft-premium', 'premium', () => { saveCraftConfig(); recalc(); });
    bindCB('craft-quality-ev', 'qualityEV', recalc);
    bindSelect('craft-food', 'foodBuff', (v) => v, recalc);
    bindSelect('craft-base-pb', 'craftingBasePB', (v) => parseInt(v) || 18, recalc);
    bindNum('craft-station-s100', 'stationSilverPer100', 0, 10000, recalc);

    // RRR Calculator also supports premium + basePB + food — provide a quick sync.
    const rrrPremium = document.getElementById('rrr-premium');
    if (rrrPremium) {
        rrrPremium.checked = CraftConfig.premium;
        rrrPremium.addEventListener('change', () => { setPremium(rrrPremium.checked); });
    }
    const rrrBasePB = document.getElementById('rrr-base-pb');
    if (rrrBasePB) {
        rrrBasePB.value = String(CraftConfig.craftingBasePB);
        rrrBasePB.addEventListener('change', () => {
            const v = parseInt(rrrBasePB.value) || 18;
            CraftConfig.craftingBasePB = v;
            saveCraftConfig();
            if (typeof calculateRRRStandalone === 'function') calculateRRRStandalone();
        });
    }
}

async function init() {
    // === IMMEDIATE: attach all UI listeners before any async work ===
    // Scripts are at bottom of <body> so DOM is fully ready here.
    initTabs();
    initCraftConfigControls();
    initRefineLabEvents();
    initTopNRankerEvents();
    initCrafterProfileEvents();
    initCraftSimEvents();
    initLiveFlipsFilterPersistence();
    initTimelineRichTooltip();

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
    // Toggle focus cost input visibility
    const focusCB = document.getElementById('craft-use-focus');
    if (focusCB) focusCB.addEventListener('change', () => {
        const fg = document.getElementById('craft-focus-cost-group');
        if (fg) fg.style.display = focusCB.checked ? '' : 'none';
    });

    // Hideout bonus — show/hide PL+Core inputs when "Hideout" is selected
    const cityBonusSel = document.getElementById('craft-city-bonus');
    const hideoutGroup = document.getElementById('craft-hideout-group');
    function updateHideoutBonusDisplay() {
        if (!cityBonusSel || !hideoutGroup) return;
        const isHideout = cityBonusSel.value === 'hideout';
        hideoutGroup.style.display = isHideout ? 'flex' : 'none';
        if (isHideout) {
            const pl = parseInt(document.getElementById('craft-hideout-pl')?.value) || 0;
            const core = parseFloat(document.getElementById('craft-hideout-core')?.value) || 0;
            const total = 15 + pl * 2 + core;
            const totalEl = document.getElementById('craft-hideout-total');
            if (totalEl) totalEl.textContent = `= ${total.toFixed(1)}% bonus`;
        }
    }
    if (cityBonusSel) {
        cityBonusSel.addEventListener('change', updateHideoutBonusDisplay);
        document.getElementById('craft-hideout-pl')?.addEventListener('input', updateHideoutBonusDisplay);
        document.getElementById('craft-hideout-core')?.addEventListener('input', updateHideoutBonusDisplay);
    }
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
    initTransportEnhancements();

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

    // BENCHED: Mounts
    // const mountScanBtn = document.getElementById('mount-scan-btn');
    // if (mountScanBtn) mountScanBtn.addEventListener('click', loadMountsDatabase);

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

    // Loot Logger: session naming, auto-save toggle, draft restore
    const sessionNameInput = document.getElementById('ll-session-name-input');
    if (sessionNameInput) sessionNameInput.value = liveSessionName;
    const autosaveToggle = document.getElementById('ll-autosave-toggle');
    if (autosaveToggle) {
        const enabled = localStorage.getItem(LL_AUTOSAVE_KEY) === '1';
        autosaveToggle.checked = enabled;
        if (enabled) toggleLiveAutosave(true); // also starts the interval
    }
    // Offer to restore a draft if one exists (only for users who already had the toggle on)
    restoreLiveDraftIfAny();

    // BENCHED: Builds Browser
    // const buildsLoadBtn = document.getElementById('builds-load-btn');
    // if (buildsLoadBtn) buildsLoadBtn.addEventListener('click', () => loadBuilds(false));
    // const buildsMoreBtn = document.getElementById('builds-more-btn');
    // if (buildsMoreBtn) buildsMoreBtn.addEventListener('click', () => loadBuilds(true));

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

    // Load existing IDB data into memory cache first (instant for returning users)
    await MarketDB.loadFromIdb();
    loadNewsBanner(); // non-blocking — shows status/news banner if active
    await updateDbStatus();

    // Then fetch fresh data from VPS (merges into memory, writes to IDB in background)
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

    // UX-1: offline/online indicator
    let _offlineToastEl = null;
    window.addEventListener('offline', () => {
        if (_offlineToastEl) return;
        const container = document.getElementById('toast-container') || document.body;
        const el = document.createElement('div');
        el.className = 'toast toast-warn';
        el.style.cssText = 'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);z-index:9999;padding:0.6rem 1.2rem;border-radius:8px;background:rgba(239,120,30,0.95);color:#fff;font-weight:600;pointer-events:none;white-space:nowrap;';
        el.textContent = '⚠ You are offline — prices may be stale';
        container.appendChild(el);
        _offlineToastEl = el;
    });
    window.addEventListener('online', () => {
        if (_offlineToastEl) { _offlineToastEl.remove(); _offlineToastEl = null; }
        showToast('Back online', 'success', 3000);
    });

    // Mobile touch support for .ll-missing-tooltip — tap the row to toggle
    document.addEventListener('touchstart', (e) => {
        const row = e.target.closest('.ll-item-row.ll-has-tooltip');
        if (row) {
            e.preventDefault();
            const wasActive = row.classList.contains('tt-active');
            document.querySelectorAll('.ll-item-row.tt-active').forEach(r => r.classList.remove('tt-active'));
            if (!wasActive) row.classList.add('tt-active');
        } else {
            document.querySelectorAll('.ll-item-row.tt-active').forEach(r => r.classList.remove('tt-active'));
        }
    }, { passive: false });
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
    wsLink = new WebSocket(VPS_BASE.replace(/^https/, 'wss')); // FE-M6: derive from VPS_BASE constant

    wsLink.onopen = () => {
        if (DEBUG) console.log("[WS] Connected to live data stream");
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
        console.warn("[WS] Disconnected. Reconnecting in 5s...");
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
                const isBatch = data.type === 'chest-captures';
                const captures = isBatch ? data.data : [data.data];
                if (captures && captures.length > 0) {
                    let added = 0;
                    for (const cap of captures) {
                        if (!cap || !cap.items) continue;
                        // Deduplicate: skip if we already have a capture with the same containerId+capturedAt
                        const isDup = lootBuyerCaptures.some(existing =>
                            existing.containerId === cap.containerId &&
                            existing.capturedAt === cap.capturedAt
                        );
                        if (!isDup) { lootBuyerCaptures.unshift(cap); added++; }
                    }
                    if (lootBuyerCaptures.length > 20) lootBuyerCaptures.length = 20;
                    if (added > 0 || isBatch) renderLootCaptures();
                    if (added > 0) {
                        _fireCaptureBusEvent('add', captures[0]); // F3: notify subscribers
                        trackActivity('chest_capture', added);
                        // Flash the tab only for genuinely new captures
                        const tab = document.querySelector('[data-tab="loot-buyer"]');
                        if (tab && currentTab !== 'loot-buyer') {
                            tab.classList.add('has-new');
                            setTimeout(() => tab.classList.remove('has-new'), 3000);
                        }
                        // Refresh Accountability UI if that tab is visible — previously this
                        // was only done in handleLootLoggerWsMessage, which never ran because
                        // this handler returns early. Users on Loot Logger → Accountability
                        // saw the dropdown stay stale even though the capture WAS stored.
                        if (typeof _updateLootLoggerModePillCounts === 'function') _updateLootLoggerModePillCounts();
                        if (currentTab === 'loot-logger' && lootLoggerMode === 'accountability') {
                            if (typeof populateAccountabilityDropdowns === 'function') populateAccountabilityDropdowns();
                            if (typeof renderCaptureChips === 'function') renderCaptureChips();
                            // Toast so the user actually notices the new capture appeared.
                            showToast(`New chest capture added: ${esc(captures[0].tabName || 'Unknown tab')} (${captures[0].items?.length || 0} items)`, 'success');
                        }
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

            // Trade event from game client (insta-buy, listing, buy order)
            if (data.type === 'trade-event' && data.data) {
                const trade = data.data;
                const name = trade.itemId || 'Unknown';
                const qty = trade.amount || 1;
                const price = (trade.unitPrice || 0).toLocaleString();
                const typeLabels = { 'insta-buy': 'Bought', 'listing-created': 'Listed', 'buy-order-placed': 'Buy Order' };
                const label = typeLabels[trade.tradeType] || trade.tradeType;
                showToast(`${label}: ${name} x${qty} @ ${price} silver`, trade.tradeType === 'insta-buy' ? 'info' : 'success');
                // Add to Recent Sales feed
                if (!window._recentSales) window._recentSales = [];
                window._recentSales.unshift({ ...trade, price: trade.unitPrice, orderType: trade.tradeType, receivedAt: Date.now() });
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
            // FE-M4: only swallow JSON parse errors; rethrow logic/render bugs
            if (err instanceof SyntaxError) return; // unparseable packet
            console.error('[WS] Message handler error:', err);
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

    const minProfit = parseInt(document.getElementById('flips-min-profit')?.value) || 10000;
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

    // Filter out "dismissed" flips this session (user can click a dismiss X on a card).
    const dismissed = window._dismissedFlips || new Set();
    const visible = filtered.filter(f => !dismissed.has(f.id));

    container.innerHTML = visible.map((flip, i) => {
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
        return `<div class="flip-card${isNew ? ' new' : ''}" data-flip-item="${esc(flip.itemId)}" data-flip-quality="${flip.quality}" data-flip-id="${esc(flip.id)}" style="cursor:pointer;" title="Click to view chart; × to dismiss">
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
            <button class="flip-dismiss-btn" data-dismiss-id="${esc(flip.id)}" aria-label="Dismiss this flip" title="Mark as taken / hide">×</button>
        </div>`;
    }).join('');

    // Wire up click-to-chart and dismiss buttons (delegation: single listener).
    if (!container._flipClickHandler) {
        container._flipClickHandler = (e) => {
            const dismissBtn = e.target.closest('[data-dismiss-id]');
            if (dismissBtn) {
                e.stopPropagation();
                window._dismissedFlips = window._dismissedFlips || new Set();
                window._dismissedFlips.add(dismissBtn.dataset.dismissId);
                const card = dismissBtn.closest('.flip-card');
                if (card) card.remove();
                return;
            }
            const card = e.target.closest('.flip-card');
            if (!card) return;
            const itemId = card.dataset.flipItem;
            if (itemId && typeof showGraph === 'function') showGraph(itemId);
        };
        container.addEventListener('click', container._flipClickHandler);
    }

    // Remove 'new' class after animation
    if (isNewFlip) {
        setTimeout(() => {
            const newCard = container.querySelector('.flip-card.new');
            if (newCard) newCard.classList.remove('new');
        }, 3000);
    }
}

// Persist Live Flips filter state across tab re-entries / reloads.
function initLiveFlipsFilterPersistence() {
    const FILTER_KEY = 'liveFlipsFilters_v1';
    // Real DOM IDs from index.html — previous list had non-existent 'flips-city-buy'/'flips-city-sell'/'flips-type' so persistence silently dropped them.
    const ids = ['flips-city-filter','flips-type-filter','flips-min-profit','flips-min-roi','flips-sound-toggle','flips-desktop-notify-toggle'];
    // Restore
    try {
        const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
        for (const id of ids) {
            const el = document.getElementById(id);
            if (!el || saved[id] == null) continue;
            if (el.type === 'checkbox') el.checked = !!saved[id];
            else el.value = saved[id];
        }
    } catch {}
    // Persist on change
    const save = () => {
        const out = {};
        for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            out[id] = el.type === 'checkbox' ? el.checked : el.value;
        }
        try { localStorage.setItem(FILTER_KEY, JSON.stringify(out)); } catch {}
    };
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', save);
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

// Profile: lifetime loot stats — aggregates from /api/loot-sessions + /api/loot-tabs
async function _loadLootLifetimeStats() {
    const card = document.getElementById('profile-loot-stats-card');
    if (!card) return;
    if (!localStorage.getItem('albion_auth_token') && !discordUser) {
        card.style.display = 'none';
        return;
    }
    try {
        const [sessionsRes, tabsRes] = await Promise.all([
            fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`${VPS_BASE}/api/loot-tabs`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null)
        ]);
        const sessions = sessionsRes?.sessions || [];
        const tabs = tabsRes?.tabs || [];
        // Only show the card when there's actually data to show
        if (sessions.length === 0 && tabs.length === 0) {
            card.style.display = 'none';
            return;
        }
        card.style.display = '';
        const totalEvents = sessions.reduce((s, x) => s + (x.event_count || 0), 0);
        const totalPaid = tabs.reduce((s, t) => s + (t.purchasePrice || 0), 0);
        const totalRev = tabs.reduce((s, t) => s + (t.revenueSoFar || 0), 0);
        const netProfit = totalRev - totalPaid;
        const set = (id, val, colorClass) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = val;
            if (colorClass) el.style.color = colorClass;
        };
        set('prof-loot-sessions', sessions.length.toLocaleString());
        set('prof-loot-events', totalEvents.toLocaleString());
        set('prof-loot-tabs', tabs.length.toLocaleString());
        set('prof-loot-paid', totalPaid > 0 ? formatSilver(totalPaid) : '—', 'var(--loss-red)');
        set('prof-loot-revenue', totalRev > 0 ? formatSilver(totalRev) : '—', 'var(--accent)');
        set('prof-loot-net', (netProfit === 0 ? '—' : (netProfit > 0 ? '+' : '') + formatSilver(Math.abs(netProfit))), netProfit >= 0 ? 'var(--profit-green)' : 'var(--loss-red)');
    } catch { /* silent */ }
}

function renderProfile(data) {
    const user = data.user;
    const stats = data.stats || {};

    // Kick off async loot lifetime stats (safe if it fails — card stays hidden)
    _loadLootLifetimeStats();

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

    // Stats — activity-score-first (refreshed from /api/my-stats which now returns { score, breakdown, rank, scans_30d, scans_total, tier })
    const s30d = document.getElementById('profile-scans-30d');
    if (s30d) s30d.textContent = (stats.scans_30d || 0).toLocaleString();
    const sTotal = document.getElementById('profile-scans-total');
    if (sTotal) sTotal.textContent = (stats.scans_total || 0).toLocaleString();
    const tierText = document.getElementById('profile-tier-text');
    if (tierText && stats.tier) tierText.textContent = stats.tier.charAt(0).toUpperCase() + stats.tier.slice(1);
    const scoreEl = document.getElementById('profile-score');
    if (scoreEl) scoreEl.textContent = (stats.score || 0).toLocaleString();
    const rankEl = document.getElementById('profile-rank');
    if (rankEl) rankEl.textContent = stats.rank > 0 ? '#' + stats.rank : '—';

    // Activity breakdown — rendered from stats.breakdown (if present) OR fetched separately
    // (the existing /api/my-stats now includes breakdown; kept the fallback fetch for older cached payloads).
    const breakdownEl = document.getElementById('profile-activity-breakdown');
    if (breakdownEl) {
        const renderBreakdown = (breakdown, score) => {
            const ACTIVITY_LABELS = { scan: '🔍 Market Scans', loot_session: '📋 Loot Sessions', chest_capture: '📦 Chest Captures', sale_record: '💰 Sales', accountability: '✓ Accountability', transport_plan: '🚛 Transport', craft_calc: '🔨 Crafting' };
            const ACTIVITY_WEIGHTS = { scan: 1, loot_session: 5, chest_capture: 3, sale_record: 2, accountability: 3, transport_plan: 1, craft_calc: 1 };
            const entries = Object.entries(ACTIVITY_LABELS).filter(([k]) => (breakdown[k] || 0) > 0);
            if (entries.length === 0) {
                breakdownEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.78rem; margin:0.25rem 0 0;">No activity tracked yet. Use the tools (market scans, loot sessions, chest captures, sales, transport, crafting) and your score will grow.</p>';
                return;
            }
            let html = '<div style="padding:0.5rem 0.6rem; background:rgba(0,0,0,0.15); border-radius:6px; border:1px solid var(--border);"><div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; font-weight:600; margin-bottom:0.4rem;">Activity Breakdown</div>';
            html += '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:0.3rem;">';
            for (const [key, label] of entries) {
                const count = breakdown[key] || 0;
                const pts = count * (ACTIVITY_WEIGHTS[key] || 1);
                html += `<div style="font-size:0.75rem; padding:0.25rem 0.4rem; background:rgba(255,255,255,0.03); border-radius:4px;" title="${count} actions × ${ACTIVITY_WEIGHTS[key]} pts = ${pts} pts">${label} <strong style="color:var(--accent);">${count}</strong> <span style="color:var(--text-muted);">(${pts} pts)</span></div>`;
            }
            html += '</div></div>';
            breakdownEl.innerHTML = html;
        };
        if (stats.breakdown && Object.keys(stats.breakdown).length > 0) {
            renderBreakdown(stats.breakdown, stats.score || 0);
        } else {
            // Fetch breakdown in background
            fetch(`${VPS_BASE}/api/activity-stats`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null).then(d => {
                if (d) renderBreakdown(d.breakdown || {}, d.combinedScore || 0);
            }).catch(() => {});
        }
    }

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

    if (unlinkBtn) unlinkBtn.onclick = () => {
        showConfirm('Unlink your Discord account?', async () => {
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
        });
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

/**
 * @typedef {Object} CapturedItem
 * @property {string} itemId - Albion item string ID (e.g. "T7_HEAD_PLATE_SET1")
 * @property {number} [quality=1] - Item quality (1=Normal, 2=Good, 3=Outstanding, 4=Excellent, 5=Masterpiece)
 * @property {number} [enchantment=0] - Enchantment level (0-4)
 * @property {number} [quantity=1] - Stack count
 * @property {string} [crafterName] - Who crafted the item (chest captures only, unavailable for loot drops)
 */

/**
 * @typedef {Object} ChestCapture
 * @property {string} [tabName] - Tab label from in-game container
 * @property {CapturedItem[]} items - Items in the captured container
 * @property {number} [timestamp] - Capture timestamp (ms epoch)
 */

/**
 * @typedef {Object} LootEvent
 * @property {number} timestamp - Event timestamp (ms epoch)
 * @property {string} looted_by_name - Player who picked up the item
 * @property {string} [looted_by_guild] - Looter's guild
 * @property {string} [looted_by_alliance] - Looter's alliance
 * @property {string} looted_from_name - Source (corpse name or container)
 * @property {string} [looted_from_guild] - Source guild
 * @property {string} item_id - Item ID or '__DEATH__' for death events
 * @property {number} [quantity=1] - Stack count
 * @property {number} [weight=0] - Item weight in kg
 * @property {boolean} [is_silver=false] - True if this event is a silver pickup
 */

/**
 * @typedef {Object} LootSession
 * @property {string} session_id - UUID or generated session identifier
 * @property {number} started_at - First event timestamp
 * @property {number} ended_at - Last event timestamp
 * @property {number} event_count - Total events in session
 * @property {number} player_count - Distinct players
 * @property {string} [public_token] - G4 share token (null if not shared)
 */

/**
 * @typedef {Object} TrackedTab
 * @property {number} id - Database row ID
 * @property {string} tabName - User-facing tab name
 * @property {string} [city] - Purchase city
 * @property {number} purchasePrice - Total silver paid
 * @property {number} purchasedAt - Purchase timestamp (ms epoch)
 * @property {string} status - 'open' | 'partial' | 'sold'
 * @property {CapturedItem[]} [items] - Original items (only in detail view)
 * @property {{id:number, item_id:string, quality:number, quantity:number, sale_price:number, sold_at:number}[]} [sales] - Sale records
 * @property {number} revenueSoFar - Sum of recorded sales
 * @property {number} netProfit - Revenue minus purchase price
 * @property {number} [totalQuantity] - Total item count
 * @property {number} [saleRecords] - Number of sale records
 */

// E2: Single store for chest captures — both Loot Buyer and Loot Logger
// read from window._chestCaptures. The alias keeps existing code working.
window._chestCaptures = window._chestCaptures || [];
const lootBuyerCaptures = window._chestCaptures;

// F3: Capture event bus — fire a DOM custom event whenever captures change.
// Both Loot Buyer and Loot Logger subscribe via document.addEventListener.
// Callers push to _chestCaptures first, then fire the event.
function _fireCaptureBusEvent(action, capture) {
    document.dispatchEvent(new CustomEvent('chest-capture-change', {
        detail: { action, capture, captures: window._chestCaptures }
    }));
}
// Subscriber: Loot Logger accountability chips auto-refresh on capture changes
document.addEventListener('chest-capture-change', () => {
    if (typeof renderCaptureChips === 'function' &&
        typeof lootLoggerMode !== 'undefined' && lootLoggerMode === 'accountability') {
        renderCaptureChips();
        if (typeof populateAccountabilityDropdowns === 'function') populateAccountabilityDropdowns();
    }
});
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
        const quality = parseInt(document.getElementById('loot-manual-quality')?.value) || 1;
        const qty = Math.max(1, parseInt(document.getElementById('loot-manual-qty')?.value) || 1);

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
        const capturedMs = typeof cap.capturedAt === 'number' ? cap.capturedAt : (cap.capturedAt ? new Date(cap.capturedAt).getTime() : 0);
        const ago = capturedMs > 0 ? timeAgo(new Date(capturedMs).toISOString()) : 'Unknown time';
        const hasDirectTabName = cap.tabName && cap.tabName.length > 0;
        const hasTabs = !hasDirectTabName && cap.vaultTabs && cap.vaultTabs.length > 0;

        // Helper to build a compact card
        const calcTabWeight = (items) => items.reduce((sum, it) => sum + getItemWeight(it.itemId) * (it.quantity || 1), 0);
        const makeCard = (onclick, name, badge, itemCount, equipCount, stackCount, totalWeight, timeAgoStr, capIndex) => {
            const weightStr = totalWeight > 0 ? `${totalWeight.toFixed(1)} kg` : '';
            const isMultiSelected = window._lootMultiSelected && window._lootMultiSelected.has(capIndex);
            return `<div class="loot-capture-card${isMultiSelected ? ' loot-multi-selected' : ''}" style="cursor:pointer; position:relative;">
                <label class="loot-multi-check" onclick="event.stopPropagation();" title="Select to combine with other tabs" style="display:flex; align-items:center; padding:0 0.5rem 0 0.25rem;">
                    <input type="checkbox" data-cap-idx="${capIndex}" ${isMultiSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleLootMultiSelect(${capIndex}, this.checked);" style="transform:scale(1.15); cursor:pointer;">
                </label>
                <div onclick="${onclick}" style="flex:1;">
                    <div style="display:flex; align-items:center; gap:0.4rem;">
                        <span class="loot-card-title">${esc(name)}</span>
                        ${badge ? `<span style="font-size:0.6rem; padding:0.1rem 0.35rem; background:var(--bg-elevated); border-radius:8px; color:var(--text-muted);">${badge}</span>` : ''}
                    </div>
                    <div class="loot-card-meta">${itemCount} items &bull; ${equipCount} equip ${stackCount} stack${weightStr ? ` &bull; ${weightStr}` : ''} &bull; ${timeAgoStr}</div>
                </div>
                <div style="position:absolute; top:0.4rem; right:0.4rem; display:flex; gap:0.3rem;">
                    <button class="btn-small" onclick="event.stopPropagation(); trackCaptureDirectly(${capIndex});" style="font-size:0.65rem; padding:0.15rem 0.4rem; color:var(--accent); background:none; border:1px solid var(--accent); border-radius:4px;" title="Mark as already-bought and track in Phase 3 without running analysis">📦 Track</button>
                    <button class="btn-small" onclick="event.stopPropagation(); removeLootCapture(${capIndex});" style="font-size:0.65rem; padding:0.15rem 0.4rem; color:var(--loss-red); background:none; border:1px solid var(--loss-red); border-radius:4px;" title="Remove this capture">✕</button>
                </div>
            </div>`;
        };

        if (hasDirectTabName) {
            const equipCount = cap.items.filter(it => it.isEquipment).length;
            const stackCount = cap.items.length - equipCount;
            const badge = cap.isGuild ? 'Guild' : 'Bank';
            cards.push(makeCard(`selectLootCapture(${capIdx})`, cap.tabName, badge, cap.items.length, equipCount, stackCount, calcTabWeight(cap.items), ago, capIdx));
        } else if (hasTabs) {
            const tabIdx = typeof cap.tabIndex === 'number' ? cap.tabIndex : -1;
            const tabName = (tabIdx >= 0 && tabIdx < cap.vaultTabs.length && cap.vaultTabs[tabIdx].name)
                ? cap.vaultTabs[tabIdx].name
                : (tabIdx >= 0 ? `Tab ${tabIdx + 1}` : 'Chest Capture');
            const equipCount = cap.items.filter(it => it.isEquipment).length;
            const stackCount = cap.items.length - equipCount;
            const vaultType = cap.isGuild ? 'Guild' : 'Bank';
            const displayName = cap.customName || tabName;
            cards.push(makeCard(`selectLootCapture(${capIdx})`, displayName, vaultType, cap.items.length, equipCount, stackCount, calcTabWeight(cap.items), ago, capIdx));
        } else {
            const equipCount = cap.items.filter(it => it.isEquipment).length;
            const stackCount = cap.items.length - equipCount;
            cards.push(makeCard(`selectLootCapture(${capIdx})`, `Chest Capture`, '', cap.items.length, equipCount, stackCount, calcTabWeight(cap.items), ago, capIdx));
        }
    });
    list.innerHTML = cards.join('');
}

function removeLootCapture(index) {
    if (index >= 0 && index < lootBuyerCaptures.length) {
        lootBuyerCaptures.splice(index, 1);
        // E2: No sync needed — lootBuyerCaptures IS window._chestCaptures
        lootSelectedCapture = null;
        // Removing a capture shifts higher indices — safest to clear multi-select state.
        if (window._lootMultiSelected) window._lootMultiSelected.clear();
        updateLootCombineBar();
        renderLootCaptures();
        _fireCaptureBusEvent('remove', null); // F3: notify subscribers
        showToast('Capture removed', 'info');
    }
}

// ─── Multi-tab select + combine ───────────────────────────────────────
window._lootMultiSelected = window._lootMultiSelected || new Set();

function toggleLootMultiSelect(capIndex, checked) {
    if (checked) {
        window._lootMultiSelected.add(capIndex);
    } else {
        window._lootMultiSelected.delete(capIndex);
    }
    // Update visual highlight on the card without re-rendering the whole list
    const card = document.querySelector(`input[data-cap-idx="${capIndex}"]`)?.closest('.loot-capture-card');
    if (card) card.classList.toggle('loot-multi-selected', checked);
    updateLootCombineBar();
}

function updateLootCombineBar() {
    const bar = document.getElementById('loot-combine-bar');
    const summary = document.getElementById('loot-combine-summary');
    if (!bar) return;
    const sel = window._lootMultiSelected || new Set();
    if (sel.size < 2) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = 'flex';
    // Aggregate stats across selected captures
    let totalItems = 0, totalQty = 0, totalWeight = 0;
    for (const idx of sel) {
        const cap = lootBuyerCaptures[idx];
        if (!cap || !Array.isArray(cap.items)) continue;
        totalItems += cap.items.length;
        for (const it of cap.items) {
            const q = it.quantity || 1;
            totalQty += q;
            totalWeight += getItemWeight(it.itemId) * q;
        }
    }
    if (summary) {
        summary.textContent = `${sel.size} tabs selected · ${totalItems} item lines · ${totalQty} total qty${totalWeight > 0 ? ` · ${totalWeight.toFixed(1)} kg` : ''}`;
    }
}

function combineLootMultiSelect() {
    const sel = window._lootMultiSelected || new Set();
    if (sel.size < 2) { showToast('Select at least 2 tabs to combine.', 'warn'); return; }

    // Build a stacked-item merge keyed by itemId|quality|enchantment for stackables.
    // Equipment items stay separate — each crafted item is unique (quality + enchant + crafter),
    // and we preserve source tab info in _sourceTabs for display.
    const mergedStack = new Map();
    const equipItems = [];
    const sourceTabs = [];
    let earliestMs = Infinity;
    let isGuild = false;

    const orderedIdxs = [...sel].sort((a, b) => a - b);
    for (const idx of orderedIdxs) {
        const cap = lootBuyerCaptures[idx];
        if (!cap || !Array.isArray(cap.items)) continue;
        const tabLabel = cap.customName || cap.tabName
            || (cap.vaultTabs && typeof cap.tabIndex === 'number' && cap.vaultTabs[cap.tabIndex]?.name)
            || `Tab ${idx + 1}`;
        sourceTabs.push(tabLabel);
        if (cap.isGuild) isGuild = true;
        const capMs = typeof cap.capturedAt === 'number' ? cap.capturedAt : (cap.capturedAt ? new Date(cap.capturedAt).getTime() : 0);
        if (capMs > 0 && capMs < earliestMs) earliestMs = capMs;

        for (const it of cap.items) {
            if (it.isEquipment) {
                // Keep all equipment as separate lines — each instance is unique
                equipItems.push({ ...it, _sourceTab: tabLabel });
            } else {
                const key = `${it.itemId}|${it.quality || 1}|${it.enchantment || 0}`;
                const existing = mergedStack.get(key);
                if (existing) {
                    existing.quantity = (existing.quantity || 1) + (it.quantity || 1);
                } else {
                    mergedStack.set(key, { ...it, _sourceTab: tabLabel });
                }
            }
        }
    }

    const mergedItems = [...equipItems, ...mergedStack.values()];
    if (mergedItems.length === 0) {
        showToast('Selected tabs have no items to combine.', 'warn');
        return;
    }

    // Build a synthetic capture so downstream code (Phase 1 eval, sell plan, track) works unchanged.
    const combinedTabName = sourceTabs.length <= 3
        ? `Combined: ${sourceTabs.join(' + ')}`
        : `Combined: ${sourceTabs.slice(0, 3).join(' + ')} + ${sourceTabs.length - 3} more`;

    lootSelectedCapture = {
        tabName:     combinedTabName,
        customName:  combinedTabName,
        isGuild,
        items:       mergedItems,
        itemCount:   mergedItems.length,
        capturedAt:  earliestMs === Infinity ? Date.now() : earliestMs,
        _combined:   true,
        _sourceTabs: sourceTabs,
    };
    selectLootCaptureUI(combinedTabName, mergedItems);
    showToast(`Combined ${orderedIdxs.length} tabs → ${mergedItems.length} merged item lines.`, 'success');
}

function clearLootMultiSelect() {
    window._lootMultiSelected.clear();
    updateLootCombineBar();
    // Uncheck boxes + remove highlight
    document.querySelectorAll('#loot-captures-list .loot-capture-card .loot-multi-check input').forEach(input => {
        input.checked = false;
    });
    document.querySelectorAll('#loot-captures-list .loot-capture-card.loot-multi-selected').forEach(card => {
        card.classList.remove('loot-multi-selected');
    });
}

let _lootCombineBarWired = false;
function initLootCombineBar() {
    if (_lootCombineBarWired) { updateLootCombineBar(); return; }
    _lootCombineBarWired = true;
    document.getElementById('loot-combine-btn')?.addEventListener('click', combineLootMultiSelect);
    document.getElementById('loot-combine-clear')?.addEventListener('click', clearLootMultiSelect);
    updateLootCombineBar();
}

function renameLootCapture(index) {
    const cap = lootBuyerCaptures[index];
    if (!cap) return;
    showPrompt('Name this capture:', cap.customName || '', (name) => {
        cap.customName = name.trim() || null;
        renderLootCaptures();
    });
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

    // Restore chip state from localStorage (persists across captures)
    const savedChips = (() => {
        try { return JSON.parse(localStorage.getItem('albion_buyer_chips') || '[]'); } catch { return []; }
    })();
    window._lootSelectedChips = new Set(savedChips);

    // Build a single collapsible card with summary, search, chips, and expandable item grid
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
                <div class="ll-filter-chips" id="loot-buyer-chips" onclick="event.stopPropagation();"></div>
                <div id="loot-items-rows">
                    ${renderLootItemRows(items)}
                </div>
            </div>
        </div>`;
    _renderLootBuyerChips();
    _applyLootBuyerFilter();

    // Wire search filter (chip-aware)
    const searchInput = document.getElementById('loot-items-search');
    if (searchInput) searchInput.addEventListener('input', _applyLootBuyerFilter);
}

// Phase 1 filter chips — same UX as the Loot Logger chips
function _getLootBuyerChipDef() {
    return [
        { id: 't6+', label: 'T6+' },
        { id: 't7+', label: 'T7+' },
        { id: 't8+', label: 'T8+' },
        { id: 'weapons', label: '🗡 Weapons' },
        { id: 'bags', label: '🎒 Bags' },
        { id: 'equipment', label: '⚔ Equipment only' }
    ];
}
function _renderLootBuyerChips() {
    const container = document.getElementById('loot-buyer-chips');
    if (!container) return;
    const active = window._lootSelectedChips || new Set();
    const chipHtml = _getLootBuyerChipDef().map(c => {
        return `<button class="ll-filter-chip${active.has(c.id) ? ' active' : ''}" onclick="event.stopPropagation(); _toggleLootBuyerChip('${c.id}')" data-chip="${c.id}">${c.label}</button>`;
    }).join('');
    const clearHtml = active.size > 0
        ? `<button class="ll-filter-chip ll-chip-clear" onclick="event.stopPropagation(); _clearLootBuyerChips()" title="Clear item filters">✕ clear</button>`
        : '';
    container.innerHTML = chipHtml + clearHtml;
}
function _toggleLootBuyerChip(chip) {
    const active = window._lootSelectedChips || new Set();
    // Tier chips are mutually exclusive
    if (['t6+', 't7+', 't8+'].includes(chip)) {
        const wasActive = active.has(chip);
        ['t6+', 't7+', 't8+'].forEach(c => active.delete(c));
        if (!wasActive) active.add(chip);
    } else {
        if (active.has(chip)) active.delete(chip);
        else active.add(chip);
    }
    window._lootSelectedChips = active;
    try { localStorage.setItem('albion_buyer_chips', JSON.stringify(Array.from(active))); } catch {}
    _renderLootBuyerChips();
    _applyLootBuyerFilter();
}
function _clearLootBuyerChips() {
    window._lootSelectedChips = new Set();
    try { localStorage.removeItem('albion_buyer_chips'); } catch {}
    _renderLootBuyerChips();
    _applyLootBuyerFilter();
}
function _applyLootBuyerFilter() {
    const items = window._lootSelectedItems || [];
    const rows = document.getElementById('loot-items-rows');
    if (!rows) return;
    const searchInput = document.getElementById('loot-items-search');
    const q = (searchInput?.value || '').toLowerCase().trim();
    const active = window._lootSelectedChips || new Set();
    const getTier = (id) => { const m = (id || '').match(/^T(\d)/); return m ? parseInt(m[1]) : 0; };
    const isWeapon = (id) => /^T\d_(MAIN|2H|OFF)_/i.test(id || '');
    const isBag = (id) => /^T\d_BAG/i.test(id || '');
    const filtered = items.filter(item => {
        const name = (getFriendlyName(item.itemId) || item.itemId).toLowerCase();
        if (q && !name.includes(q) && !item.itemId.toLowerCase().includes(q)) return false;
        const tierChips = ['t8+', 't7+', 't6+'].filter(c => active.has(c));
        if (tierChips.length > 0) {
            const minTier = parseInt(tierChips[0][1]);
            if (getTier(item.itemId) < minTier) return false;
        }
        if (active.has('weapons') && !isWeapon(item.itemId)) return false;
        if (active.has('bags') && !isBag(item.itemId)) return false;
        if (active.has('equipment') && !item.isEquipment) return false;
        return true;
    });
    rows.innerHTML = renderLootItemRows(filtered);
    // Update header count
    const statsEl = document.querySelector('.loot-items-stats');
    if (statsEl) {
        const eq = filtered.filter(it => it.isEquipment).length;
        const filterActive = q || active.size > 0;
        statsEl.textContent = `${filtered.length}/${items.length} items` + (filterActive ? ' (filtered)' : ` \u2022 ${eq}\u2694 ${filtered.length - eq}\uD83D\uDCE6`);
    }
}

function renderLootItemRows(items) {
    const favs = getAllFavoriteItemIds();
    return items.map((item, i) => {
        const qualName = item.quality > 1 ? ` q${item.quality}` : '';
        const iconUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(item.itemId)}.png?quality=${item.quality}`;
        const name = getFriendlyName(item.itemId) || item.itemId;
        const safeId = esc(item.itemId);
        const iw = getItemWeight(item.itemId);
        const totalW = iw * (item.quantity || 1);
        const weightStr = totalW > 0 ? `<span class="loot-item-weight">${totalW.toFixed(1)} kg</span>` : '';
        // Accept both server-side naming conventions (Go: crafterName, legacy: crafter)
        const crafter = item.crafterName || item.crafter || '';
        const crafterAttr = crafter ? ` data-tip-crafter="${esc(crafter)}"` : '';
        const qAttr = item.quality ? ` data-tip-quality="${item.quality}"` : '';
        const isFav = favs.has(item.itemId);
        const favBadge = isFav ? ' <span class="ll-fav-badge" title="In your favorites" data-tip="In your favorites list">📌</span>' : '';
        const favClass = isFav ? ' loot-item-favorite' : '';
        return `<div class="loot-item-row${favClass}" onclick="toggleLootItemDetail(this, '${safeId}', ${item.quality || 1})" style="cursor:pointer;" data-tip-item="${safeId}" data-tip-source="chest"${qAttr}${crafterAttr}>
            <img src="${iconUrl}" class="loot-item-icon" loading="lazy" onerror="this.style.display='none'" alt="">
            <span class="loot-item-name">${esc(name)}${qualName}${favBadge}</span>
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
            body: JSON.stringify({ items: lootSelectedCapture.items, askingPrice, isPremium: !!CraftConfig.premium })
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

// Fast-path: "Track this" button on a chest capture chip. Prompts for purchase
// price, then posts directly to /api/loot-tab/save without running Phase 1 eval.
// Intended for the workflow "I already bought this and I just want to track sales now".
function trackCaptureDirectly(capIndex) {
    const cap = lootBuyerCaptures[capIndex];
    if (!cap || !cap.items || cap.items.length === 0) {
        showToast('Capture not found or empty', 'error');
        return;
    }
    const defaultName = cap.customName || cap.tabName || 'Chest Capture';
    showPrompt(`Purchase price for "${defaultName}" (silver)? (${cap.items.length} items will be tracked)`, '0', (priceStr) => {
        const purchasePrice = Math.max(0, parseInt(priceStr) || 0);
        showPrompt('Which city did you buy this in? (optional)', '', async (city) => {
            try {
                const res = await fetch(`${VPS_BASE}/api/loot-tab/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ tabName: defaultName, city: city || '', purchasePrice, items: cap.items })
                });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || 'Failed');
                showToast(`Tracked "${defaultName}" — view it below`, 'success');
                loadTrackedTabs();
                // Remove capture from chip list so user doesn't double-track
                removeLootCapture(capIndex);
            } catch(e) {
                showToast('Failed to track: ' + e.message, 'error');
            }
        });
    });
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
        // Auto-sync to Portfolio: create a BUY entry with the tab's details
        if (askingPrice > 0 && d.id) {
            _addPortfolioBuyFromTab(d.id, tabName, askingPrice, lootSelectedCapture.items);
        }
        loadTrackedTabs();
    } catch(e) {
        if (btn) { btn.disabled = false; btn.textContent = 'I Bought This — Track Tab'; }
        showToast('Failed to save: ' + e.message, 'error');
    }
}

// G13: Build plain-language reasoning for the BUY/MAYBE/SKIP verdict.
// Uses the already-computed evaluation data (items with bestInstantSell,
// bestMarketSell, riskFlags) to explain WHY the verdict was what it was.
function _buildVerdictReasoning(data, askingPrice, qs, ps, verdictClass) {
    if (!askingPrice || askingPrice <= 0) return '';
    const items = data.items || [];
    const totalItems = data.totals.itemCount || items.length;
    const riskCount = data.totals.riskItemCount || 0;
    const bullets = [];

    // Spread analysis
    const spreadPct = qs > 0 ? ((ps - qs) / qs * 100) : 0;
    if (ps > qs && qs > 0) {
        if (spreadPct >= 50) {
            bullets.push(`<li><strong>Big spread:</strong> patient-sell value is ${Math.round(spreadPct)}% above quick-sell — listing on the market earns far more than dumping to buy orders, but takes days.</li>`);
        } else if (spreadPct >= 15) {
            bullets.push(`<li><strong>Moderate spread:</strong> ${Math.round(spreadPct)}% uplift from patient-sell vs quick-sell. Listing is worthwhile if you have market slots.</li>`);
        } else {
            bullets.push(`<li><strong>Tight spread:</strong> only ${Math.round(spreadPct)}% between instant and market — instant sell makes sense for speed.</li>`);
        }
    } else if (qs === 0) {
        bullets.push(`<li><strong>No instant-sell floor:</strong> no active buy orders for most items — you'd have to list everything on the market and wait for buyers.</li>`);
    }

    // Risk breakdown
    if (riskCount > 0) {
        const riskTypes = {};
        for (const it of items) {
            for (const f of (it.riskFlags || [])) {
                riskTypes[f] = (riskTypes[f] || 0) + 1;
            }
        }
        const humanFlag = (f) => {
            if (f === 'no_data') return 'no market data';
            if (f === 'no_buy_orders') return 'no buyers (market is thin)';
            if (f === 'stale_data') return 'stale prices (>24h old)';
            if (f === 'low_volume') return 'low daily volume';
            return f.replace(/_/g, ' ');
        };
        const flagList = Object.entries(riskTypes).map(([f, c]) => `${c}x ${humanFlag(f)}`).join(', ');
        const riskPct = Math.round((riskCount / totalItems) * 100);
        if (riskPct >= 50) {
            bullets.push(`<li><strong>High risk:</strong> ${riskPct}% of items (${riskCount} of ${totalItems}) have issues — ${flagList}. Expect real sell values to undershoot the quoted totals.</li>`);
        } else {
            bullets.push(`<li><strong>${riskCount} item${riskCount !== 1 ? 's' : ''} flagged:</strong> ${flagList}. Quoted totals may be slightly optimistic.</li>`);
        }
    } else {
        bullets.push(`<li><strong>Clean data:</strong> all ${totalItems} items have active buy orders and fresh prices.</li>`);
    }

    // Best city summary (where most value concentrates)
    const cityValue = {};
    for (const it of items) {
        const pick = it.bestInstantSell || it.bestMarketSell;
        if (!pick || !pick.city) continue;
        const v = (pick.netPerUnit || 0) * (it.quantity || 1);
        cityValue[pick.city] = (cityValue[pick.city] || 0) + v;
    }
    const sortedCities = Object.entries(cityValue).sort((a, b) => b[1] - a[1]);
    if (sortedCities.length > 0) {
        const top = sortedCities[0];
        const topShare = Math.round((top[1] / (qs || ps || 1)) * 100);
        if (sortedCities.length === 1) {
            bullets.push(`<li><strong>Single destination:</strong> all sellable items move through <strong>${top[0]}</strong>.</li>`);
        } else if (topShare >= 60) {
            bullets.push(`<li><strong>Concentrated sell:</strong> ${topShare}% of value is in <strong>${top[0]}</strong> — one trip handles most of it.</li>`);
        } else {
            const citiesStr = sortedCities.slice(0, 3).map(([c]) => c).join(', ');
            bullets.push(`<li><strong>Multi-city trip:</strong> best values split across ${citiesStr}. Expect multiple haul legs.</li>`);
        }
    }

    // Verdict-specific closing line
    let closing = '';
    if (verdictClass === 'good') {
        const profitAbs = qs - askingPrice;
        closing = `<p class="verdict-conclusion good">Bottom line: at ${askingPrice.toLocaleString()} you pocket ~${formatSilver(profitAbs)} right away even if you dump everything to buy orders.</p>`;
    } else if (verdictClass === 'caution') {
        const patientProfit = ps - askingPrice;
        closing = `<p class="verdict-conclusion caution">Bottom line: instant sell won't cover the asking price, but listing patiently earns ~${formatSilver(patientProfit)}. Only buy if you have the time + slots.</p>`;
    } else if (verdictClass === 'bad') {
        const overpay = askingPrice - ps;
        closing = `<p class="verdict-conclusion bad">Bottom line: you'd overpay by ~${formatSilver(overpay)} even at patient-sell prices. Walk away or negotiate down.</p>`;
    }

    return `<ul class="verdict-bullets">${bullets.join('')}</ul>${closing}`;
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

    // G13: plain-language reasoning for the verdict. Expandable "Why?" section below the main verdict line.
    const reasoning = _buildVerdictReasoning(data, askingPrice, qs, ps, verdictClass);

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
        ${verdict ? `<div class="loot-verdict ${verdictClass}">
            <div class="loot-verdict-headline">${verdict}</div>
            ${reasoning ? `<button class="loot-verdict-why" onclick="this.nextElementSibling.classList.toggle('open'); this.textContent = this.nextElementSibling.classList.contains('open') ? '▲ Hide reasoning' : '▼ Why?'">▼ Why?</button>
            <div class="loot-verdict-reasoning">${reasoning}</div>` : ''}
        </div>` : '<div style="color:var(--text-muted); font-size:0.85rem; margin-bottom:1rem;">Enter an asking price above to get a buy/skip verdict.</div>'}
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

// Copy text for a single trip — routes through the copy-preview modal so
// users can tweak the text (add notes, trim items) before it hits clipboard.
function copySellTrip(tripId) {
    const el = document.getElementById(tripId);
    if (!el) return;
    const text = el.dataset.copytext || '';
    if (!text) { showToast('Nothing to copy', 'warn'); return; }
    const titleEl = el.querySelector('.sell-trip-title');
    const tripTitle = titleEl?.textContent?.trim() || 'Sell Trip';
    openCopyPreview(`Preview — ${tripTitle}`, text, `${tripTitle} copied`);
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

    // Wire up Copy All button — routes through the copy-preview modal for edits
    const copyAllBtn = document.getElementById('sell-copy-all-btn');
    if (copyAllBtn) {
        copyAllBtn.addEventListener('click', () => {
            openCopyPreview('Preview — Full Sell Plan', allCopyText, 'Full sell plan copied');
        });
    }
}

// ====== LOOT TAB LIFECYCLE TRACKER ======

// Cache the last-fetched tabs so sort-order changes don't need a refetch
let _lastTrackedTabs = [];
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
            _lastTrackedTabs = [];
            _renderTrackedTabsHeader([]);
            if (empty) empty.style.display = '';
            return;
        }
        _lastTrackedTabs = data.tabs;
        _renderTrackedTabsList();
        _loadCrafterStats(); // C4: async crafter aggregation
        _loadSessionTabOverlaps(data.tabs); // F1: async overlap badges
    } catch(e) {
        list.innerHTML = `<div class="empty-state"><p>Failed to load tracked tabs: ${esc(e.message)}</p></div>`;
    }
}

// Compute net profit per tab once so sort doesn't recalculate each comparison
function _netForTab(t) { return (t.revenueSoFar || 0) - (t.purchasePrice || 0); }

function _renderTrackedTabsList() {
    const list = document.getElementById('loot-tracked-list');
    if (!list) return;
    const tabs = [..._lastTrackedTabs];
    const sort = localStorage.getItem('albion_buyer_sort') || 'newest';
    if (sort === 'oldest') tabs.sort((a, b) => (a.purchasedAt || 0) - (b.purchasedAt || 0));
    else if (sort === 'profit-desc') tabs.sort((a, b) => _netForTab(b) - _netForTab(a));
    else if (sort === 'profit-asc') tabs.sort((a, b) => _netForTab(a) - _netForTab(b));
    else if (sort === 'open-first') tabs.sort((a, b) => {
        const order = { open: 0, partial: 1, sold: 2 };
        const oa = order[a.status] ?? 99; const ob = order[b.status] ?? 99;
        return oa - ob || (b.purchasedAt || 0) - (a.purchasedAt || 0);
    });
    else tabs.sort((a, b) => (b.purchasedAt || 0) - (a.purchasedAt || 0)); // newest default
    _renderTrackedTabsHeader(tabs);
    list.innerHTML = tabs.map(tab => renderTrackedTabCard(tab)).join('');
}

// Summary header: totals across all tracked tabs + sort picker
function _renderTrackedTabsHeader(tabs) {
    let header = document.getElementById('loot-tracked-header');
    if (!header) {
        const list = document.getElementById('loot-tracked-list');
        if (!list || !list.parentElement) return;
        header = document.createElement('div');
        header.id = 'loot-tracked-header';
        list.parentElement.insertBefore(header, list);
    }
    if (!tabs || tabs.length === 0) { header.innerHTML = ''; return; }
    const totalPaid = tabs.reduce((s, t) => s + (t.purchasePrice || 0), 0);
    const totalRev = tabs.reduce((s, t) => s + (t.revenueSoFar || 0), 0);
    const totalNet = totalRev - totalPaid;
    const openCount = tabs.filter(t => t.status === 'open').length;
    const partialCount = tabs.filter(t => t.status === 'partial').length;
    const soldCount = tabs.filter(t => t.status === 'sold').length;
    const currentSort = localStorage.getItem('albion_buyer_sort') || 'newest';
    header.innerHTML = `
        <div class="loot-tracked-summary">
            <div class="ll-summary-stat"><div class="ll-summary-label">Tabs</div><div class="ll-summary-value">${tabs.length}</div></div>
            <div class="ll-summary-stat"><div class="ll-summary-label">Open · Partial · Sold</div><div class="ll-summary-value">${openCount} · ${partialCount} · ${soldCount}</div></div>
            <div class="ll-summary-stat"><div class="ll-summary-label">Paid</div><div class="ll-summary-value loss">${formatSilver(totalPaid)}</div></div>
            <div class="ll-summary-stat"><div class="ll-summary-label">Revenue</div><div class="ll-summary-value accent">${formatSilver(totalRev)}</div></div>
            <div class="ll-summary-stat"><div class="ll-summary-label">Net</div><div class="ll-summary-value ${totalNet >= 0 ? '' : 'loss'}" style="${totalNet >= 0 ? 'color:var(--profit-green);' : ''}">${totalNet >= 0 ? '+' : ''}${formatSilver(Math.abs(totalNet))}</div></div>
            <div class="ll-summary-actions">
                <label style="font-size:0.7rem; color:var(--text-muted); align-self:center;">Sort</label>
                <select id="loot-tracked-sort" onchange="_onTrackedTabsSortChange(this.value)" class="transport-select" style="height:30px; font-size:0.78rem;">
                    <option value="newest"${currentSort === 'newest' ? ' selected' : ''}>Newest</option>
                    <option value="oldest"${currentSort === 'oldest' ? ' selected' : ''}>Oldest</option>
                    <option value="profit-desc"${currentSort === 'profit-desc' ? ' selected' : ''}>Highest profit</option>
                    <option value="profit-asc"${currentSort === 'profit-asc' ? ' selected' : ''}>Lowest profit</option>
                    <option value="open-first"${currentSort === 'open-first' ? ' selected' : ''}>Open first</option>
                </select>
            </div>
        </div>
    `;
}

function _onTrackedTabsSortChange(val) {
    try { localStorage.setItem('albion_buyer_sort', val); } catch {}
    _renderTrackedTabsList();
}

// C4: Crafter aggregation — fetch and render top crafters across tracked tabs
async function _loadCrafterStats() {
    if (!localStorage.getItem('albion_auth_token') && !discordUser) return;
    try {
        const res = await fetch(`${VPS_BASE}/api/crafter-stats`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const crafters = data.crafters || [];
        if (crafters.length === 0) return;
        let container = document.getElementById('crafter-stats-strip');
        if (!container) {
            container = document.createElement('div');
            container.id = 'crafter-stats-strip';
            const header = document.getElementById('loot-tracked-header');
            if (header) header.after(container);
            else return;
        }
        const top5 = crafters.slice(0, 5);
        container.innerHTML = `<div class="crafter-strip">
            <span class="crafter-strip-label">🔨 Top crafters</span>
            ${top5.map((c, i) => `<span class="crafter-chip" title="${esc(c.name)}: ${c.items} items across ${c.tabs} tab${c.tabs !== 1 ? 's' : ''}">${i < 3 ? ['🥇','🥈','🥉'][i] + ' ' : ''}${esc(c.name)} <strong>${c.items}</strong></span>`).join('')}
            ${crafters.length > 5 ? `<span class="crafter-chip crafter-more" title="Total: ${crafters.length} crafters">+${crafters.length - 5} more</span>` : ''}
        </div>`;
    } catch { /* silent */ }
}

// F1: Session ↔ Tracked tab overlap badges — async stamps badges on tab cards
async function _loadSessionTabOverlaps(tabs) {
    if (!tabs || !tabs.length) return;
    if (!localStorage.getItem('albion_auth_token') && !discordUser) return;
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const sessions = data.sessions || [];
        if (!sessions.length) return;
        // For each tab, check if its purchase time falls within a session window (±1h buffer)
        const BUFFER = 3600000; // 1 hour
        for (const tab of tabs) {
            const purchaseTime = tab.purchasedAt || 0;
            if (!purchaseTime) continue;
            const matchingSession = sessions.find(s => {
                const start = s.started_at - BUFFER;
                const end = (s.ended_at || s.started_at) + BUFFER;
                return purchaseTime >= start && purchaseTime <= end;
            });
            if (matchingSession) {
                // Find the card in DOM and add a badge
                const card = document.querySelector(`.loot-tracked-card[onclick*="toggleTrackedTabDetail(${tab.id},"]`);
                if (!card) continue;
                const titleArea = card.querySelector('.loot-tracked-header > div');
                if (!titleArea) continue;
                // Don't double-add
                if (titleArea.querySelector('.session-overlap-badge')) continue;
                const badge = document.createElement('span');
                badge.className = 'loot-tab-badge session-overlap-badge';
                badge.style.cssText = 'background:rgba(139,92,246,0.15); color:#a78bfa; border-color:rgba(139,92,246,0.3);';
                badge.title = 'Purchased during a logged loot session';
                badge.textContent = '📋 Session';
                titleArea.appendChild(badge);
            }
        }
    } catch { /* silent */ }
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

// Copy the last N recent sales to Discord, using the copy-preview modal so
// the user can trim the list or edit prices before it hits their guild chat.
function copyRecentSalesToDiscord() {
    const sales = window._recentSales || [];
    if (sales.length === 0) {
        showToast('No sales detected yet — open your in-game mailbox with the client running', 'warn');
        return;
    }
    // Take the most recent 15 to keep the message compact
    const slice = sales.slice(0, 15);
    const totalSilver = slice.reduce((s, x) => s + ((x.total || (x.price * (x.amount || 1))) || 0), 0);
    const matchedCount = slice.filter(s => s.matchedTabId).length;
    const lines = [];
    lines.push(`**Recent Sales** (last ${slice.length} from in-game mail)`);
    lines.push(`Total: **${formatSilver(totalSilver)}**${matchedCount > 0 ? ` · ${matchedCount} auto-matched to tracked tabs` : ''}`);
    lines.push('');
    lines.push('```');
    lines.push('Item'.padEnd(32) + 'Qty'.padEnd(6) + 'Price/ea'.padEnd(12) + 'Total');
    lines.push('-'.repeat(65));
    for (const s of slice) {
        const name = (getFriendlyName(s.itemId) || s.itemId || 'Unknown').slice(0, 31).padEnd(32);
        const qty = String(s.amount || 1).padEnd(6);
        const price = (s.price || 0).toLocaleString().padEnd(12);
        const total = ((s.total || (s.price * (s.amount || 1))) || 0).toLocaleString();
        lines.push(name + qty + price + total);
    }
    lines.push('```');
    openCopyPreview('Preview — Recent Sales', lines.join('\n'), 'Recent sales copied');
}

function renderRecentSales() {
    let container = document.getElementById('loot-recent-sales');
    if (!container) return;
    const sales = window._recentSales || [];
    if (sales.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; padding:0.5rem;">No sales detected yet. Open your in-game mailbox while the client is running.</div>';
        return;
    }
    // Filter by search query (matches item id, friendly name, or city)
    const q = (document.getElementById('loot-sales-search')?.value || '').toLowerCase().trim();
    const filtered = q ? sales.filter(s => {
        const name = (getFriendlyName(s.itemId) || s.itemId || '').toLowerCase();
        const id = (s.itemId || '').toLowerCase();
        const city = (s.location || '').toLowerCase();
        return name.includes(q) || id.includes(q) || city.includes(q);
    }) : sales;
    if (filtered.length === 0) {
        container.innerHTML = `<div style="color:var(--text-muted); font-size:0.78rem; padding:0.5rem;">No sales match "${esc(q)}". Clear the filter to see all ${sales.length} sale${sales.length !== 1 ? 's' : ''}.</div>`;
        return;
    }
    container.innerHTML = filtered.slice(0, 10).map(s => {
        const name = s.itemId || 'Unknown';
        const icon = (typeof getItemIcon === 'function') ? getItemIcon(name) : `https://render.albiononline.com/v1/item/${encodeURIComponent(name)}.png`;
        const qty = s.amount || 1;
        const price = (s.price || 0).toLocaleString();
        const total = (s.total || 0).toLocaleString();
        // receivedAt can be ISO string (from /api/sale-notifications) or ms number (from WS push) — normalize
        const agoInput = typeof s.receivedAt === 'number' ? new Date(s.receivedAt).toISOString() : (s.receivedAt || '');
        const ago = agoInput && typeof timeAgo === 'function' ? timeAgo(agoInput) : '';
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
    // Progress: if purchase price set, use revenue/cost ratio. Otherwise use items sold / total items.
    const totalItems = tab.totalQuantity || tab.itemCount || 1;
    const itemsSold = tab.saleRecords || 0;
    // Unbounded progress (can exceed 100%) so we know how far past break-even a tab went
    const rawProgressPct = tab.purchasePrice > 0
        ? Math.round(tab.revenueSoFar / tab.purchasePrice * 100)
        : Math.round(itemsSold / totalItems * 100);
    const progressPct = Math.min(100, rawProgressPct);
    const progressColor = rawProgressPct >= 100 ? 'var(--profit-green)' : rawProgressPct >= 50 ? '#fbbf24' : 'var(--accent)';
    const statusClass = tab.status === 'sold' ? 'status-sold' : tab.status === 'partial' ? 'status-partial' : 'status-open';
    const date = new Date(tab.purchasedAt).toLocaleDateString();
    // Days-held badge: gives a feel for stale tabs
    const daysHeld = Math.max(0, Math.floor((Date.now() - (tab.purchasedAt || Date.now())) / 86400000));
    let ageBadge = '';
    if (tab.status !== 'sold' && daysHeld >= 1) {
        const isStale = daysHeld > 14;
        ageBadge = `<span class="loot-tab-age-badge${isStale ? ' stale' : ''}" title="Days since purchase">${daysHeld}d</span>`;
    }
    // Break-even tick on the progress bar (at 100% position, only shown when there IS a purchase price)
    const showBreakEvenTick = tab.purchasePrice > 0;

    return `<div class="loot-tracked-card" onclick="toggleTrackedTabDetail(${tab.id}, this)">
        <div class="loot-tracked-header">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
                <span class="loot-card-title">${esc(tab.tabName)}</span>
                ${tab.city ? `<span class="loot-tab-badge">${esc(tab.city)}</span>` : ''}
                <span class="loot-tab-status ${statusClass}">${tab.status}</span>
                ${ageBadge}
            </div>
            <span style="font-size:0.72rem; color:var(--text-muted); flex-shrink:0;">${date}</span>
        </div>
        <div class="loot-tracked-stats">
            <div class="loot-tracked-stat">
                <span class="loot-tracked-stat-label">Paid</span>
                <span class="loot-tracked-stat-value">${tab.purchasePrice > 0 ? tab.purchasePrice.toLocaleString() + 's' : '—'}</span>
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
                <span class="loot-tracked-stat-label">Sold</span>
                <span class="loot-tracked-stat-value">${itemsSold}/${totalItems} (${rawProgressPct}%)</span>
            </div>
        </div>
        <div class="loot-tracked-progress-bar" title="${showBreakEvenTick ? `Break-even at ${tab.purchasePrice.toLocaleString()}s` : 'No purchase price set'}">
            <div class="loot-tracked-progress-fill" style="width:${progressPct}%; background:${progressColor};"></div>
            ${showBreakEvenTick ? '<span class="loot-tracked-break-even-tick" title="Break-even"></span>' : ''}
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

// Re-render a single tab detail with a new sort order (no re-fetch)
function _onSalesSortChange(tabId, sort) {
    try { localStorage.setItem('albion_tab_sales_sort', sort); } catch {}
    const tab = window['_trackedTab_' + tabId];
    if (!tab) return;
    const detail = document.getElementById(`loot-tracked-detail-${tabId}`);
    if (!detail) return;
    detail.innerHTML = renderTrackedTabDetail(tab);
}

// Export a single tab's sales history as CSV
function exportTabSalesCSV(tabId) {
    const tab = window['_trackedTab_' + tabId];
    if (!tab) { showToast('Tab data not loaded — re-expand the card', 'warn'); return; }
    const sales = tab.sales || [];
    if (sales.length === 0) { showToast('No sales to export for this tab', 'warn'); return; }
    const rows = sales.map(s => ({
        sold_at: new Date(s.sold_at).toISOString(),
        item_id: s.item_id || '',
        item_name: getFriendlyName(s.item_id) || s.item_id || '',
        quality: s.quality || 1,
        quantity: s.quantity || 1,
        sale_price: Math.floor(s.sale_price || 0),
        total: Math.floor((s.sale_price || 0) * (s.quantity || 1))
    }));
    const safeName = (tab.tabName || 'tab').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30);
    exportToCSV(rows, `sales-${safeName}-${new Date().toISOString().slice(0, 10)}.csv`);
}

function renderTrackedTabDetail(tab) {
    // Stash the tab on window so the CSV export can read it without re-fetching
    window['_trackedTab_' + tab.id] = tab;
    // Honor sort preference for sales history (per-user, persists across reloads)
    const salesSort = localStorage.getItem('albion_tab_sales_sort') || 'newest';
    const sales = [...(tab.sales || [])];
    if (salesSort === 'newest') sales.sort((a, b) => +new Date(b.sold_at) - +new Date(a.sold_at));
    else if (salesSort === 'oldest') sales.sort((a, b) => +new Date(a.sold_at) - +new Date(b.sold_at));
    else if (salesSort === 'price-desc') sales.sort((a, b) => (b.sale_price * b.quantity) - (a.sale_price * a.quantity));
    else if (salesSort === 'price-asc') sales.sort((a, b) => (a.sale_price * a.quantity) - (b.sale_price * b.quantity));

    const salesHeader = sales.length > 0 ? `
        <div style="display:flex; justify-content:space-between; align-items:center; margin:0.5rem 0 0.25rem;">
            <span style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; font-weight:600;">Sales history (${sales.length})</span>
            <div style="display:flex; gap:0.4rem; align-items:center;" onclick="event.stopPropagation()">
                <select onchange="_onSalesSortChange(${tab.id}, this.value)" class="transport-select" style="height:26px; font-size:0.72rem; padding:0 0.4rem;">
                    <option value="newest"${salesSort === 'newest' ? ' selected' : ''}>Newest</option>
                    <option value="oldest"${salesSort === 'oldest' ? ' selected' : ''}>Oldest</option>
                    <option value="price-desc"${salesSort === 'price-desc' ? ' selected' : ''}>Highest $</option>
                    <option value="price-asc"${salesSort === 'price-asc' ? ' selected' : ''}>Lowest $</option>
                </select>
                <button class="btn-small" onclick="event.stopPropagation(); exportTabSalesCSV(${tab.id})" title="Download this tab's sales history as CSV">CSV</button>
            </div>
        </div>` : '';
    const salesHtml = sales.length === 0
        ? '<p style="color:var(--text-muted); font-size:0.8rem; margin:0.5rem 0;">No sales recorded yet.</p>'
        : salesHeader + sales.map(s => {
            const name = (typeof ITEM_NAMES !== 'undefined' && ITEM_NAMES[s.item_id]) || s.item_id;
            const qualLabel = s.quality > 1 ? ` q${s.quality}` : '';
            const total = (s.sale_price * s.quantity).toLocaleString();
            const date = new Date(s.sold_at).toLocaleDateString();
            return `<div class="sale-row" data-sale-id="${s.id}" style="display:grid; grid-template-columns:1fr auto auto auto; align-items:center; gap:0.5rem; font-size:0.78rem; padding:0.3rem 0; border-bottom:1px solid var(--border-color);">
                <span style="color:var(--text-primary);">${esc(name)}${qualLabel} ×${s.quantity}</span>
                <span style="color:var(--profit-green); font-weight:600;">${total}s</span>
                <span style="color:var(--text-muted);">${date}</span>
                <span class="sale-actions" onclick="event.stopPropagation()">
                    <button class="btn-icon" onclick="editSaleInline(${tab.id},${s.id},${s.sale_price},${s.quantity})" title="Edit sale" aria-label="Edit sale">✏</button>
                    <button class="btn-icon btn-icon-danger" onclick="deleteSaleRecord(${tab.id},${s.id})" title="Delete sale" aria-label="Delete sale">✕</button>
                </span>
            </div>`;
        }).join('');

    const totalRevLabel = tab.revenueSoFar.toLocaleString();
    const netLabel = (tab.netProfit >= 0 ? '+' : '') + tab.netProfit.toLocaleString();
    const netColor = tab.netProfit >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';

    // Per-item mark-off checklist (persisted in localStorage)
    const soldKey = `albion_sold_items_${tab.id}`;
    let soldSet;
    try { soldSet = new Set(JSON.parse(localStorage.getItem(soldKey) || '[]')); } catch { soldSet = new Set(); }
    const items = tab.items || [];
    const itemsGrouped = {};
    for (const it of items) {
        const k = (it.itemId || '') + '_' + (it.quality || 1);
        if (!itemsGrouped[k]) itemsGrouped[k] = { ...it, quantity: 0 };
        itemsGrouped[k].quantity += (it.quantity || 1);
    }
    const itemsList = Object.entries(itemsGrouped);
    const soldCount = itemsList.filter(([k]) => soldSet.has(k)).length;
    const itemsChecklistHtml = itemsList.length > 0 ? `
        <div style="margin-top:0.75rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="event.stopPropagation(); const el=document.getElementById('items-checklist-${tab.id}'); el.style.display=el.style.display==='none'?'':'none';">
                <span style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; font-weight:600;">Items checklist (${soldCount}/${itemsList.length} sold)</span>
                <span style="font-size:0.7rem; color:var(--text-muted);">▼</span>
            </div>
            <div id="items-checklist-${tab.id}" style="display:none; margin-top:0.35rem;">
                ${soldCount > 0 ? `<div style="text-align:right; margin-bottom:0.25rem;" onclick="event.stopPropagation()"><button class="btn-small" style="font-size:0.65rem; padding:0.15rem 0.4rem;" onclick="clearSoldMarks(${tab.id})">Clear all marks</button></div>` : ''}
                ${itemsList.map(([key, it]) => {
                    const name = getFriendlyName(it.itemId) || it.itemId;
                    const qLbl = (it.quality || 1) > 1 ? ` q${it.quality}` : '';
                    const isSold = soldSet.has(key);
                    const iconUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(it.itemId)}.png?quality=${it.quality || 1}`;
                    return `<div class="item-check-row${isSold ? ' item-sold' : ''}" onclick="event.stopPropagation(); toggleItemSold(${tab.id},'${esc(key)}',this)">
                        <span class="item-check-box">${isSold ? '✓' : ''}</span>
                        <img src="${iconUrl}" class="item-check-icon" loading="lazy" onerror="this.style.display='none'" alt="">
                        <span class="item-check-name">${esc(name)}${qLbl} ×${it.quantity}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>` : '';

    return `<div style="margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid var(--border-color);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap; gap:0.4rem;">
            <div style="display:flex; gap:1rem; font-size:0.78rem;">
                <span>Revenue: <strong style="color:var(--profit-green);">${totalRevLabel}s</strong></span>
                <span>Net: <strong style="color:${netColor};">${netLabel}s</strong></span>
            </div>
            <div style="display:flex; gap:0.5rem; align-items:center;" onclick="event.stopPropagation()">
                <button class="btn-small-accent" onclick="showSaleForm(${tab.id})">+ Record Sale</button>
                <button class="btn-small" onclick="showSellStrategy(${tab.id})" title="Reopen Phase 2 Sell Optimizer for this tab's unsold items">📊 Sell Strategy</button>
                <select class="loot-status-select" onchange="updateTabStatus(${tab.id}, this.value)" aria-label="Tab status">
                    <option value="open" ${tab.status === 'open' ? 'selected' : ''}>Open</option>
                    <option value="partial" ${tab.status === 'partial' ? 'selected' : ''}>Partial</option>
                    <option value="sold" ${tab.status === 'sold' ? 'selected' : ''}>Sold</option>
                </select>
                <button class="btn-small-danger" onclick="deleteTrackedTab(${tab.id}, this)" title="Delete this tab" aria-label="Delete tab">Delete</button>
            </div>
        </div>
        <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.35rem;">${tab.sales.length} sale record${tab.sales.length !== 1 ? 's' : ''}</div>
        <details class="tracked-tab-accordion" id="sell-strategy-accordion-${tab.id}" onclick="event.stopPropagation()">
            <summary>📊 Sell Strategy for unsold items</summary>
            <div class="accordion-body" id="sell-strategy-body-${tab.id}">
                <p style="color:var(--text-muted);font-size:0.8rem;margin:0;">Click to compute the best sell route for each remaining item in this tab.</p>
            </div>
        </details>
        ${salesHtml}
        ${itemsChecklistHtml}
    </div>`;
}

// Open the Phase 2 Sell Optimizer view for a tracked tab without forcing a capture restart.
async function showSellStrategy(tabId) {
    const acc = document.getElementById(`sell-strategy-accordion-${tabId}`);
    const body = document.getElementById(`sell-strategy-body-${tabId}`);
    if (!acc || !body) return;
    if (!acc.open) acc.open = true;
    body.innerHTML = '<div class="spinner" style="margin:0.5rem auto;width:20px;height:20px;"></div>';
    try {
        const tabRes = await fetch(`${VPS_BASE}/api/loot-tab/${tabId}`, { headers: authHeaders() });
        const tab = await tabRes.json();
        if (!tabRes.ok) throw new Error(tab.error || 'Failed to load tab');
        // Filter to unsold items (not in the sold-marks set)
        const soldKey = `albion_sold_items_${tabId}`;
        let soldSet;
        try { soldSet = new Set(JSON.parse(localStorage.getItem(soldKey) || '[]')); } catch { soldSet = new Set(); }
        const unsold = (tab.items || []).filter(it => !soldSet.has(((it.itemId || '') + '_' + (it.quality || 1))));
        if (unsold.length === 0) { body.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;">All items marked sold — nothing to optimize.</p>'; return; }

        // Call loot-evaluate as if Phase 2; use existing renderer in lightweight mode.
        const evalRes = await fetch(`${VPS_BASE}/api/loot-evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ items: unsold, askingPrice: 0, isPremium: !!CraftConfig.premium }),
        });
        const data = await evalRes.json();
        if (!evalRes.ok) throw new Error(data.error || 'Evaluation failed');

        // Inline mini Sell Plan table
        let html = `<table class="compare-table" style="width:100%;margin-top:0.4rem;"><thead>
            <tr><th>Item</th><th>Qty</th><th>Best Instant</th><th>Best Patient</th><th>Recommended</th></tr></thead><tbody>`;
        for (const r of (data.results || [])) {
            const instant = r.bestInstantSell;
            const patient = r.bestMarketSell;
            let rec = 'N/A';
            if (instant && patient) {
                const instantTotal = instant.netPerUnit * r.quantity;
                const patientTotal = patient.netPerUnit * r.quantity;
                // 85% rule: take instant if >= 85% of patient.
                if (instantTotal >= patientTotal * 0.85) rec = `⚡ Instant @ ${esc(instant.city)}`;
                else rec = `📋 List @ ${esc(patient.city)}`;
            } else if (instant) rec = `⚡ Instant @ ${esc(instant.city)}`;
            else if (patient) rec = `📋 List @ ${esc(patient.city)}`;
            html += `<tr>
                <td>${esc(r.name)}${r.quality > 1 ? ' q'+r.quality : ''}</td>
                <td>×${r.quantity}</td>
                <td>${instant ? instant.netPerUnit.toLocaleString()+'s @ '+esc(instant.city) : '—'}</td>
                <td>${patient ? patient.netPerUnit.toLocaleString()+'s @ '+esc(patient.city) : '—'}</td>
                <td><strong class="text-green">${rec}</strong></td>
            </tr>`;
        }
        html += '</tbody></table>';
        body.innerHTML = html;
    } catch (e) {
        body.innerHTML = `<p style="color:var(--loss-red);font-size:0.8rem;">${esc(e.message)}</p>`;
    }
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
            if (!sel) return;
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
    if (!sel) return;
    let itemId = sel.value;
    let quality = parseInt(sel.selectedOptions[0]?.dataset?.quality) || 1;

    if (itemId === '__custom__') {
        itemId = document.getElementById(`sale-custom-id-${tabId}`)?.value?.trim();
        quality = 1;
        if (!itemId) return;
    }

    const qty = Math.max(1, parseInt(document.getElementById(`sale-qty-${tabId}`)?.value) || 1);
    const price = parseInt(document.getElementById(`sale-price-${tabId}`)?.value);
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
        trackActivity('sale_record', 1);
        _addPortfolioSellFromTab(tabId, price * qty, qty); // Portfolio sync
        loadTrackedTabs();
    } catch(e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Sale'; }
        showToast('Failed to record sale: ' + e.message, 'error');
    }
}

// Inline edit a sale — replace the row with editable fields
function editSaleInline(tabId, saleId, currentPrice, currentQty) {
    const row = document.querySelector(`.sale-row[data-sale-id="${saleId}"]`);
    if (!row) return;
    row.innerHTML = `
        <div style="display:flex; gap:0.4rem; align-items:center; grid-column:1/-1;" onclick="event.stopPropagation()">
            <label style="font-size:0.72rem; color:var(--text-muted);">Qty</label>
            <input type="number" id="edit-qty-${saleId}" value="${currentQty}" min="1" class="sale-form-input" style="width:60px; height:26px; font-size:0.78rem;">
            <label style="font-size:0.72rem; color:var(--text-muted);">Price/ea</label>
            <input type="number" id="edit-price-${saleId}" value="${currentPrice}" min="1" class="sale-form-input" style="width:100px; height:26px; font-size:0.78rem;">
            <button class="btn-small-accent" onclick="submitSaleEdit(${tabId},${saleId})">Save</button>
            <button class="btn-small" onclick="_reloadTabDetail(${tabId})">Cancel</button>
        </div>`;
}
async function submitSaleEdit(tabId, saleId) {
    const qty = Math.max(1, parseInt(document.getElementById(`edit-qty-${saleId}`)?.value) || 1);
    const price = parseInt(document.getElementById(`edit-price-${saleId}`)?.value);
    if (!price || price <= 0) return;
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tab/${tabId}/sale/${saleId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ salePrice: price, quantity: qty })
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
        showToast('Sale updated', 'success');
        _reloadTabDetail(tabId);
    } catch(e) {
        showToast('Failed to update sale: ' + e.message, 'error');
    }
}
async function deleteSaleRecord(tabId, saleId) {
    showConfirm('Delete this sale record?', async () => {
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tab/${tabId}/sale/${saleId}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
        showToast('Sale deleted', 'success');
        _reloadTabDetail(tabId);
    } catch(e) {
        showToast('Failed to delete sale: ' + e.message, 'error');
    }
    });
}
// Per-item sold mark-off toggle (localStorage persistence)
function toggleItemSold(tabId, itemKey, rowEl) {
    const soldKey = `albion_sold_items_${tabId}`;
    let sold;
    try { sold = new Set(JSON.parse(localStorage.getItem(soldKey) || '[]')); } catch { sold = new Set(); }
    if (sold.has(itemKey)) sold.delete(itemKey);
    else sold.add(itemKey);
    try { localStorage.setItem(soldKey, JSON.stringify([...sold])); } catch {}
    // Update UI inline
    const isSold = sold.has(itemKey);
    rowEl.classList.toggle('item-sold', isSold);
    const box = rowEl.querySelector('.item-check-box');
    if (box) box.textContent = isSold ? '✓' : '';
    // Update checklist header count
    const checklist = rowEl.closest('[id^="items-checklist-"]');
    if (checklist) {
        const header = checklist.previousElementSibling;
        if (header) {
            const totalRows = checklist.querySelectorAll('.item-check-row').length;
            const soldRows = checklist.querySelectorAll('.item-check-row.item-sold').length;
            const label = header.querySelector('span');
            if (label) label.textContent = `Items checklist (${soldRows}/${totalRows} sold)`;
            // Auto-suggest status change to "sold" when all items are checked
            if (soldRows === totalRows && totalRows > 0) {
                const statusSel = checklist.closest('[style*="border-top"]')?.querySelector('.loot-status-select');
                if (statusSel && statusSel.value !== 'sold') {
                    showToast('All items sold! Consider marking this tab as Sold ✓', 'success');
                }
            }
        }
    }
}

function clearSoldMarks(tabId) {
    try { localStorage.removeItem(`albion_sold_items_${tabId}`); } catch {}
    _reloadTabDetail(tabId);
    showToast('All sold marks cleared', 'info');
}

function _reloadTabDetail(tabId) {
    const detail = document.getElementById(`loot-tracked-detail-${tabId}`);
    if (detail) detail.style.display = 'none';
    loadTrackedTabs();
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
let liveSessionSaved = false;   // whether current live session has been saved (prevents duplicates)
let _llShowLiveTimer = null;    // debounce timer for showLiveSession re-renders
let _llSearchTimer = null;      // debounce timer for search/filter input
// E6: Debounced render — all filter/sort changes go through this
function _llDebouncedRender(delay) {
    if (_llSearchTimer) clearTimeout(_llSearchTimer);
    _llSearchTimer = setTimeout(_llRenderFiltered, delay || 200);
}
let _llRemovedPlayers = new Set(); // players removed from current view
let _llResolvedDeaths = new Set(); // deaths marked as resolved
// E2: window._chestCaptures already initialized in Loot Buyer section (= lootBuyerCaptures)
// ─── Loot Logger render state ──────────────────────────────────────────
// These globals hold the current session's computed data between renders.
// They are set by renderLootSessionEvents() and read by _llRenderFiltered().
// 4.4: Grouped here for clarity — see also liveSession* flags near resetLiveSession().
let _llCurrentEvents = [];          // current session's event array
let _llCurrentByPlayer = {};        // {playerName: {items[], guild, alliance, totalValue, ...}}
let _llPriceMap = {};               // {itemId: {price}} — cached per session (E4 memoization)
let _llDepositedMap = null;         // accountability deposit map (null in normal session view)
let _llTargetEl = null;             // DOM element to render into
let _llIsDetail = false;            // true = viewing a specific saved session
let _llDeaths = [];                 // computed death timeline for current session
let _llDiedWithByVictim = {};       // { victimName: { items: [{itemId,quality,qty}], deaths: [{ts,location,killer,lootedBy[]}] } } — used by player-card "died with" preview section
let _llPrimaryGuild = '';           // most-common guild among looters (= "our" side)
let _llPrimaryAlliance = '';        // most-common alliance
let _llDeathFilterVictim = null;    // when set, restricts view to that death's chain
let _llCurrentSessionId = null;     // session_id when viewing a saved session, null for live
let _llPlayerTrends = {};           // G6: per-player cross-session stats, keyed by name
// Phase 5 item filter chips (multi-select) — hydrated from localStorage so user choices persist
let _llActiveChips = new Set((() => {
    try { return JSON.parse(localStorage.getItem('albion_ll_chips') || '[]'); } catch { return []; }
})());
function _persistChips() {
    try { localStorage.setItem('albion_ll_chips', JSON.stringify(Array.from(_llActiveChips))); } catch {}
}

// --- Session naming, whitelist, auto-save ---
const LL_SESSION_NAME_KEY = 'albion_live_session_name';
const LL_SAVED_NAMES_KEY = 'albion_loot_session_names';    // map { session_id: custom_name }
const LL_WHITELIST_KEY = 'albion_loot_whitelist';          // array of lowercase strings
const LL_AUTOSAVE_KEY = 'albion_loot_autosave_enabled';
const LL_DRAFT_KEY = 'albion_loot_live_draft';             // { events, name, savedAt }
let liveSessionName = localStorage.getItem(LL_SESSION_NAME_KEY) || '';
let lootWhitelist; try { lootWhitelist = JSON.parse(localStorage.getItem(LL_WHITELIST_KEY) || '[]'); } catch { lootWhitelist = []; } // FE-M5
let _llAutosaveInterval = null;

// G7: Suggest an auto-name based on session data. Pure function — returns a
// sensible string or '' if there's not enough info. Pattern: "{Day} — {OurGuild} vs {TopEnemy}"
// Falls back to just the date when guilds are unknown.
function suggestSessionName() {
    const events = liveLootEvents;
    if (!events || events.length === 0) return '';
    const { guild } = _detectPrimaryGuildAlliance();
    // Most common enemy guild = most common guild among looted-FROM names
    const enemyCount = {};
    for (const ev of events) {
        if (ev.item_id === '__DEATH__') continue;
        const eg = ev.looted_from_guild || '';
        if (eg && eg !== guild) enemyCount[eg] = (enemyCount[eg] || 0) + 1;
    }
    const topEnemy = Object.entries(enemyCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const tsNums = events.map(e => +new Date(e.timestamp)).filter(n => !isNaN(n));
    const firstTs = tsNums.length ? Math.min(...tsNums) : Date.now();
    const d = new Date(firstTs);
    const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    let name = datePart;
    if (guild) name = `${guild}`;
    if (guild && topEnemy) name = `${guild} vs ${topEnemy}`;
    else if (topEnemy) name = `vs ${topEnemy}`;
    return `${name} · ${datePart}`.slice(0, 80);
}

function applySessionNameSuggestion() {
    const suggestion = suggestSessionName();
    if (!suggestion) {
        showToast('Not enough session data to suggest a name yet', 'warn');
        return;
    }
    const input = document.getElementById('ll-session-name-input');
    if (input) input.value = suggestion;
    onSessionNameInput(suggestion);
    showToast(`Suggested: ${suggestion}`, 'success');
}

function onSessionNameInput(val) {
    liveSessionName = (val || '').trim().slice(0, 80);
    try { localStorage.setItem(LL_SESSION_NAME_KEY, liveSessionName); } catch {}
    // Refresh the session list if we're in the live sessions view so the card title updates
    if (lootLoggerMode === 'live') {
        // Only re-render the live card header text in place (cheap)
        const liveCard = document.querySelector('.ll-session-card.active-live .ll-session-title');
        if (liveCard) {
            const badge = liveSessionActive
                ? '<span class="loot-tab-status status-open" style="margin-left:0.4rem;">LIVE</span>'
                : '<span class="loot-tab-status status-partial" style="margin-left:0.4rem;">PAUSED</span>';
            liveCard.innerHTML = `${esc(liveSessionName || 'Live Session')}${badge}`;
        }
    }
}

function getSavedSessionNames() {
    try { return JSON.parse(localStorage.getItem(LL_SAVED_NAMES_KEY) || '{}'); } catch { return {}; }
}
function setSavedSessionName(sid, name) {
    const map = getSavedSessionNames();
    if (name) map[sid] = name.slice(0, 80);
    else delete map[sid];
    try { localStorage.setItem(LL_SAVED_NAMES_KEY, JSON.stringify(map)); } catch {}
}
// A10: Inline rename — replace the old prompt() with an in-DOM editable field.
// Click the ✏️ on a session card → title becomes an input → Enter saves, Esc cancels.
function renameSavedSession(sid) {
    const btn = document.querySelector(`[onclick*="renameSavedSession('${sid}')"]`);
    if (!btn) { _fallbackPromptRename(sid); return; }
    const card = btn.closest('.ll-session-card');
    const titleEl = card?.querySelector('.ll-session-title');
    if (!card || !titleEl) { _fallbackPromptRename(sid); return; }
    // Save original HTML so Esc can restore it
    const originalHtml = titleEl.innerHTML;
    const current = getSavedSessionNames()[sid] || '';
    titleEl.innerHTML = `<input type="text" class="ll-inline-rename-input" value="${esc(current)}" placeholder="Session name (blank to remove)" maxlength="80">`;
    const input = titleEl.querySelector('input');
    input.focus();
    input.select();
    const commit = () => {
        const val = input.value.trim();
        setSavedSessionName(sid, val);
        loadLootSessions();
    };
    const cancel = () => { titleEl.innerHTML = originalHtml; };
    input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // don't trigger global shortcut handler
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation()); // don't open the session detail
}

function _fallbackPromptRename(sid) {
    const current = getSavedSessionNames()[sid] || '';
    showPrompt('Rename this loot session:', current, (next) => {
        if (!next && next !== '') return;
        setSavedSessionName(sid, next.trim());
        loadLootSessions();
    });
}

// --- Whitelist ---
function openWhitelistModal() {
    const modal = document.getElementById('whitelist-modal');
    const input = document.getElementById('whitelist-input');
    if (!modal || !input) return;
    input.value = lootWhitelist.join('\n');
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 20);
}
function closeWhitelistModal() {
    document.getElementById('whitelist-modal')?.classList.add('hidden');
}
function saveWhitelist() {
    const raw = document.getElementById('whitelist-input')?.value || '';
    lootWhitelist = raw.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
    try { localStorage.setItem(LL_WHITELIST_KEY, JSON.stringify(lootWhitelist)); } catch {}
    closeWhitelistModal();
    showToast(lootWhitelist.length ? `Whitelist saved (${lootWhitelist.length} entries)` : 'Whitelist cleared', 'success');
    // Re-render current view if showing live session
    if (liveLootEvents.length > 0 && _llTargetEl) showLiveSession();
}
function clearWhitelist() {
    lootWhitelist = [];
    try { localStorage.removeItem(LL_WHITELIST_KEY); } catch {}
    const input = document.getElementById('whitelist-input');
    if (input) input.value = '';
}

// Auto-detect primary guild/alliance from the current events so presets work
// even if the session hasn't been rendered yet (user opens the modal first).
function _detectPrimaryGuildAlliance() {
    let guild = _llPrimaryGuild;
    let alliance = _llPrimaryAlliance;
    if (!guild || !alliance) {
        const gCount = {}, aCount = {};
        for (const ev of liveLootEvents) {
            if (ev.item_id === '__DEATH__') continue;
            const g = ev.looted_by_guild || '';
            const a = ev.looted_by_alliance || '';
            if (g) gCount[g] = (gCount[g] || 0) + 1;
            if (a) aCount[a] = (aCount[a] || 0) + 1;
        }
        if (!guild) guild = Object.entries(gCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        if (!alliance) alliance = Object.entries(aCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    }
    return { guild, alliance };
}

function applyWhitelistPreset(kind) {
    const input = document.getElementById('whitelist-input');
    if (!input) return;
    const existing = input.value.split('\n').map(s => s.trim()).filter(Boolean);
    const add = (v) => { if (v && !existing.some(e => e.toLowerCase() === v.toLowerCase())) existing.push(v); };
    if (kind === 'guild') {
        const { guild } = _detectPrimaryGuildAlliance();
        if (!guild) { showToast('No guild detected in current session — start a live session or load one first', 'warn'); return; }
        add(guild);
        showToast(`Added "${guild}" to whitelist`, 'success');
    } else if (kind === 'alliance') {
        const { alliance } = _detectPrimaryGuildAlliance();
        if (!alliance) { showToast('No alliance detected — start a live session or load one first', 'warn'); return; }
        add(alliance);
        showToast(`Added "${alliance}" to whitelist`, 'success');
    } else if (kind === 'me') {
        // Try to infer the user's character name from discord profile or saved logs
        const savedName = (discordUser?.username) || localStorage.getItem('albion_character_name');
        if (!savedName) {
            showPrompt('Enter your in-game character name:', '', (myName) => {
                if (!myName) return;
                try { localStorage.setItem('albion_character_name', myName); } catch {}
                add(myName);
                showToast(`Added "${myName}" to whitelist`, 'success');
                input.value = existing.join('\n');
            });
            return;
        }
        add(savedName);
        showToast(`Added "${savedName}" to whitelist`, 'success');
    }
    input.value = existing.join('\n');
}
function isWhitelistedEvent(ev) {
    if (!lootWhitelist.length) return true;
    const name = (ev.looted_by_name || ev.lootedBy?.name || '').toLowerCase();
    const guild = (ev.looted_by_guild || ev.lootedBy?.guild || '').toLowerCase();
    const alliance = (ev.looted_by_alliance || ev.lootedBy?.alliance || '').toLowerCase();
    return lootWhitelist.some(w => w && (w === name || w === guild || w === alliance));
}

// --- Auto-save draft (every 5 min to localStorage) ---
function toggleLiveAutosave(enabled) {
    try { localStorage.setItem(LL_AUTOSAVE_KEY, enabled ? '1' : '0'); } catch {}
    if (_llAutosaveInterval) { clearInterval(_llAutosaveInterval); _llAutosaveInterval = null; }
    if (enabled) {
        _llAutosaveInterval = setInterval(saveLiveDraft, 5 * 60 * 1000);
        showToast('Auto-save draft enabled (every 5 min)', 'info');
    } else {
        try { localStorage.removeItem(LL_DRAFT_KEY); } catch {}
        const st = document.getElementById('ll-autosave-status');
        if (st) { st.textContent = ''; st.classList.remove('saved'); }
    }
}
function saveLiveDraft() {
    if (liveLootEvents.length === 0) return;
    try {
        localStorage.setItem(LL_DRAFT_KEY, JSON.stringify({
            events: liveLootEvents,
            name: liveSessionName,
            savedAt: Date.now()
        }));
        const st = document.getElementById('ll-autosave-status');
        if (st) {
            st.textContent = `Draft saved ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
            st.classList.add('saved');
        }
    } catch(e) {
        console.warn('[loot logger] draft save failed:', e);
    }
}
function restoreLiveDraftIfAny() {
    try {
        const raw = localStorage.getItem(LL_DRAFT_KEY);
        if (!raw) return;
        const draft = JSON.parse(raw);
        if (!draft?.events?.length) return;
        // Only offer if user hasn't already started a new session
        if (liveLootEvents.length > 0) return;
        const when = draft.savedAt ? new Date(draft.savedAt).toLocaleString() : 'earlier';
        const eventsCount = draft.events.length;
        const restoreMsg = `Auto-saved draft from ${when}: ${eventsCount} event${eventsCount !== 1 ? 's' : ''}${draft.name ? ` ("${draft.name}")` : ''}. Restore?`;
        showConfirm(restoreMsg, () => {
            liveLootEvents = draft.events;
            liveSessionName = draft.name || '';
            try { localStorage.setItem(LL_SESSION_NAME_KEY, liveSessionName); } catch {}
            const nameInput = document.getElementById('ll-session-name-input');
            if (nameInput) nameInput.value = liveSessionName;
            updateLiveLootIndicator();
            if (lootLoggerMode === 'live') loadLootSessions();
            showToast(`Restored ${eventsCount} events from draft`, 'success');
        }, 30000);
    } catch(e) {
        console.warn('[loot logger] restore draft failed:', e);
    }
}

// --- Silver formatting ---
function formatSilver(n) {
    if (!n || n <= 0) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return Math.round(n).toLocaleString();
}

// --- Price map for loot values (VPS scan data, fallback to IndexedDB) ---
// E4: Memoize results by the sorted item-id signature + 5-min TTL so repeated
// renders of the same session don't refetch. Cleared on saveLiveSession and
// when events change (new item ids invalidate the cache naturally).
const _LL_PRICE_CACHE_TTL = 5 * 60 * 1000;
const _llPriceCache = new Map(); // key -> { map, ts }
async function getLootPriceMap(itemIds) {
    const ids = [...itemIds].filter(Boolean);
    if (ids.length === 0) return {};

    // Cache hit check
    const key = ids.slice().sort().join('|');
    const cached = _llPriceCache.get(key);
    if (cached && (Date.now() - cached.ts) < _LL_PRICE_CACHE_TTL) {
        return cached.map;
    }

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
            if (Object.keys(data).length > 0) {
                _llPriceCache.set(key, { map: data, ts: Date.now() });
                // Bound cache size — keep at most 20 unique session signatures
                if (_llPriceCache.size > 20) {
                    const firstKey = _llPriceCache.keys().next().value;
                    _llPriceCache.delete(firstKey);
                }
                return data;
            }
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
        _llPriceCache.set(key, { map, ts: Date.now() });
        if (_llPriceCache.size > 20) {
            const firstKey = _llPriceCache.keys().next().value;
            _llPriceCache.delete(firstKey);
        }
        return map;
    } catch { return {}; }
}

// === Live Session state (E3: consolidated access) ================================
// The underlying flags are kept as top-level globals (see ~line 6609 and 8654) for
// backward-compat with the large surface of existing code. The helpers below give
// new code a canonical snapshot + reset path without a risky rename-everything pass:
//   - liveSessionState()          — read-only snapshot of every flag
//   - resetLiveSessionFlags()     — clears every flag; used inside resetLiveSession
//   - live session properties:
//       active       — whether we're actively recording (liveSessionActive)
//       saved        — whether the current queue has been pushed to backend (liveSessionSaved)
//       name         — user-editable label (liveSessionName)
//       events       — the rolling event array (liveLootEvents)
//       eventCount   — convenience, events.length
//       sessionId    — server-assigned id when viewing a saved session (_llCurrentSessionId)
//       autosaveOn   — whether the draft-to-localStorage interval is live (_llAutosaveInterval)
//       warnedAt     — last event-count threshold we toasted at (_liveEventWarnedAt)
//       droppedCount — count of events dropped due to the 10k cap (_liveEventDropCounter)
// ====================================================================================
function liveSessionState() {
    return {
        active: liveSessionActive,
        saved: liveSessionSaved,
        name: liveSessionName,
        events: liveLootEvents,
        eventCount: liveLootEvents.length,
        sessionId: _llCurrentSessionId,
        autosaveOn: !!_llAutosaveInterval,
        warnedAt: _liveEventWarnedAt,
        droppedCount: _liveEventDropCounter
    };
}

function resetLiveSessionFlags() {
    liveLootEvents = [];
    liveSessionActive = false;
    liveSessionSaved = false;
    liveSessionName = '';
    _liveEventWarnedAt = 0;
    _liveEventDropCounter = 0;
    if (_llAutosaveInterval) { clearInterval(_llAutosaveInterval); _llAutosaveInterval = null; }
    try { localStorage.removeItem(LL_SESSION_NAME_KEY); } catch {}
    try { localStorage.removeItem(LL_DRAFT_KEY); } catch {}
}

// Expose for dev-tools debugging without touching production call paths
window.liveSessionState = liveSessionState;

// --- Live session controls ---
// On Stop, if the user has captured events we auto-save AND render the session
// so they immediately see what they just logged. Previously Stop only toggled
// the flag, leaving users to guess they still had to click Save + click the
// session card to view their own run.
async function toggleLiveSession() {
    const wasActive = liveSessionActive;
    liveSessionActive = !liveSessionActive;
    const btn = document.getElementById('ll-live-toggle-btn');
    if (liveSessionActive) {
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"/></svg> Stop Live Session`;
        btn.classList.add('active');
        document.getElementById('ll-live-indicator')?.classList.remove('hidden');
        updateLiveLootIndicator();
        return;
    }

    // Stopping: normal UI reset
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg> Start Live Session`;
    btn.classList.remove('active');
    updateLiveLootIndicator();

    // If there's nothing to save, just stop silently.
    if (!wasActive || liveLootEvents.length === 0) return;

    // Auto-save (no-op if already saved) and render the session view.
    try {
        if (!liveSessionSaved) await saveLiveSession();
    } catch (e) {
        // saveLiveSession already shows a toast on failure; swallow so we
        // still render what the user captured in-memory.
        console.warn('[LiveSession] auto-save failed:', e);
    }
    // Render whatever we have — either the freshly saved session or the
    // in-memory events (showLiveSession reads liveLootEvents directly).
    const detail = document.getElementById('loot-session-detail');
    if (detail) detail.style.display = '';
    showLiveSession();
}

function updateLiveLootIndicator() {
    const indicator = document.getElementById('ll-live-indicator');
    if (!indicator) return;
    if (!liveSessionActive) { indicator.classList.add('hidden'); }
    else { indicator.classList.remove('hidden'); }
    // Exclude __DEATH__ events from counts
    const lootOnly = liveLootEvents.filter(e => (e.item_id || e.itemId || '') !== '__DEATH__');
    const players = new Set(lootOnly.map(e => e.looted_by_name || e.lootedBy?.name || '')).size;
    const evEl = document.getElementById('ll-event-count');
    const plEl = document.getElementById('ll-player-count');
    if (evEl) evEl.textContent = lootOnly.length;
    if (plEl) plEl.textContent = players;
    const saveBtn = document.getElementById('ll-save-btn');
    const resetBtn = document.getElementById('ll-reset-btn');
    if (saveBtn) saveBtn.disabled = liveLootEvents.length === 0;
    if (resetBtn) resetBtn.disabled = liveLootEvents.length === 0;
}

function resetLiveSession() {
    const doReset = () => {
    // E3: single source of truth for flag reset (clears state + localStorage)
    resetLiveSessionFlags();
    _llRemovedPlayers.clear();
    _llResolvedDeaths.clear();
    if (window._liveSessionIds) window._liveSessionIds.clear();
    if (window._liveEventKeys) window._liveEventKeys.clear();
    const nameInput = document.getElementById('ll-session-name-input');
    if (nameInput) nameInput.value = '';
    const st = document.getElementById('ll-autosave-status');
    if (st) { st.textContent = ''; st.classList.remove('saved'); }
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
    }; // end doReset
    if (liveLootEvents.length > 0 && !liveSessionSaved) {
        showConfirm('You have unsaved loot events. Discard them? (Cancel to go back and save first.)', doReset);
    } else if (liveLootEvents.length > 0) {
        showConfirm('Clear the current live session?', doReset);
    } else {
        doReset();
    }
}

async function saveLiveSession() {
    if (liveLootEvents.length === 0) { showToast('No events to save', 'warning'); return; }
    if (liveSessionSaved) { showToast('Session already saved. New events will reset this.', 'info'); return; }
    const btn = document.getElementById('ll-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        // NEW (2026-04-18): if the events arrived from a live Go-client stream, they're
        // already persisted in the DB under one or more session_ids. Instead of POSTing
        // the full event list (which duplicates every row under a new session_id),
        // consolidate the existing session_ids into one.
        const liveIds = Array.from(window._liveSessionIds || []).filter(Boolean);
        if (liveIds.length > 0) {
            const res = await fetch(`${VPS_BASE}/api/loot-session/consolidate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ sessionIds: liveIds, sessionName: liveSessionName || '' })
            });
            if (res.ok) {
                const data = await res.json();
                liveSessionSaved = true;
                const sid = data.sessionId;
                if (sid && liveSessionName) setSavedSessionName(sid, liveSessionName);
                try { localStorage.removeItem(LL_DRAFT_KEY); } catch {}
                const msg = data.merged > 0
                    ? `Session saved — merged ${data.fragmentCount} fragment${data.fragmentCount > 1 ? 's' : ''} (${data.merged} rows consolidated)${liveSessionName ? ` as "${liveSessionName}"` : ''}`
                    : `Session saved (already one session${liveSessionName ? ` — renamed to "${liveSessionName}"` : ''})`;
                showToast(msg, 'success');
                trackActivity('loot_session', 1);
                if (lootLoggerMode === 'live') loadLootSessions();
                return;
            }
            // Fall through to upload if consolidate failed for some reason (older backend etc.).
        }

        // Legacy / fallback path: if we have no session_ids (e.g. from a file-upload draft)
        // or consolidate failed, upload the raw event list as a new session.
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
            liveSessionSaved = true;
            const sid = data.sessionId || data.session_id;
            if (sid && liveSessionName) setSavedSessionName(sid, liveSessionName);
            try { localStorage.removeItem(LL_DRAFT_KEY); } catch {}
            showToast(`Session saved (${data.eventsImported} events)${liveSessionName ? ` as "${liveSessionName}"` : ''}`, 'success');
            trackActivity('loot_session', 1);
            if (lootLoggerMode === 'live') loadLootSessions();
        } else {
            showToast('Save failed — login required', 'error');
        }
    } catch(e) {
        showToast('Save failed: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = liveLootEvents.length === 0; btn.textContent = liveSessionSaved ? 'Saved ✓' : 'Save Session'; }
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
    window._chestCaptures.length = 0; // E2: clear in-place to preserve alias
    chestCaptureActive = false;
    const btn = document.getElementById('ll-capture-toggle-btn');
    if (btn) { btn.textContent = 'Start Capturing'; btn.classList.remove('active'); }
    document.getElementById('ll-capture-status-bar')?.classList.add('hidden');
    renderCaptureChips();
    populateAccountabilityDropdowns();
    showToast('Captures cleared', 'info');
}

// --- Chest LOG capture controls (deposit/withdraw ground truth) ---
// Parallel to chest captures but for opcode 157 responses. Each batch is one
// page from the game (up to 101 entries, tagged deposit or withdraw via the
// request-side pairing done in the Go client).
window._chestLogBatches = window._chestLogBatches || [];
let chestLogCaptureActive = false;

function toggleChestLogCapture() {
    chestLogCaptureActive = !chestLogCaptureActive;
    const btn = document.getElementById('ll-chestlog-toggle-btn');
    const bar = document.getElementById('ll-chestlog-status-bar');
    if (chestLogCaptureActive) {
        if (btn) { btn.textContent = 'Stop Capturing'; btn.classList.add('active'); }
        if (bar) bar.classList.remove('hidden');
    } else {
        if (btn) { btn.textContent = 'Start Capturing'; btn.classList.remove('active'); }
        if (bar) bar.classList.add('hidden');
    }
}

function resetChestLogCaptures() {
    window._chestLogBatches.length = 0;
    chestLogCaptureActive = false;
    const btn = document.getElementById('ll-chestlog-toggle-btn');
    if (btn) { btn.textContent = 'Start Capturing'; btn.classList.remove('active'); }
    document.getElementById('ll-chestlog-status-bar')?.classList.add('hidden');
    renderChestLogChips();
    populateAccountabilityDropdowns();
    showToast('Chest log captures cleared', 'info');
}

function renderChestLogChips() {
    const chips = document.getElementById('ll-chestlog-chips');
    if (!chips) return;
    const batches = window._chestLogBatches;
    if (!batches || batches.length === 0) {
        chips.innerHTML = '<span style="font-size:0.75rem; color:var(--text-muted);">No chest log captures yet — open a chest Log tab in-game and scroll through entries</span>';
        return;
    }
    chips.innerHTML = batches.map((b, i) => {
        const action = b.action || 'unknown';
        const n = (b.entries || []).length;
        const when = b.capturedAt ? timeAgo(new Date(b.capturedAt).toISOString()) : '';
        const actionColor = action === 'deposit' ? 'var(--profit-green)'
            : action === 'withdraw' ? 'var(--accent)'
            : 'var(--text-muted)';
        const actionIcon = action === 'deposit' ? '📥' : action === 'withdraw' ? '📤' : '❔';
        return `<div class="ll-capture-chip" style="background:rgba(91,141,239,0.08); border:1px solid rgba(91,141,239,0.3);" title="${n} ${action} entries">
            <span style="color:${actionColor}; font-weight:600;">${actionIcon} ${esc(action)}</span>
            <span style="color:var(--text-muted); font-size:0.72rem;">${n} entries · ${when}</span>
            <button class="btn-small" style="padding:0; background:none; border:none; color:var(--text-muted); cursor:pointer;" onclick="removeChestLogBatch(${i})" title="Remove this batch">&times;</button>
        </div>`;
    }).join('');
}

function removeChestLogBatch(idx) {
    if (idx < 0 || idx >= window._chestLogBatches.length) return;
    window._chestLogBatches.splice(idx, 1);
    renderChestLogChips();
    populateAccountabilityDropdowns();
}

function renderCaptureChips() {
    _updateLootLoggerModePillCounts();
    const chips = document.getElementById('ll-capture-chips');
    if (!chips) return;
    // E2: lootBuyerCaptures IS window._chestCaptures — no seeding needed
    const captures = window._chestCaptures;
    if (captures.length === 0) {
        chips.innerHTML = '<span style="font-size:0.75rem; color:var(--text-muted);">No chest captures yet — open a chest with the client running</span>';
        return;
    }
    chips.innerHTML = captures.map((cap, i) => {
        const name = esc(cap.tabName || `Tab ${i + 1}`);
        const count = cap.items ? cap.items.length : 0;
        const tw = cap.items ? cap.items.reduce((s, it) => s + getItemWeight(it.itemId) * (it.quantity || 1), 0) : 0;
        const weightStr = tw > 0 ? ` · ${tw.toFixed(1)} kg` : '';
        // Show capture age so the user can tell which tab is recent vs stale.
        const capturedMs = typeof cap.capturedAt === 'number' ? cap.capturedAt : (cap.capturedAt ? new Date(cap.capturedAt).getTime() : 0);
        const ageStr = capturedMs > 0 ? ` · ${timeAgo(new Date(capturedMs).toISOString())}` : '';
        return `<div class="ll-capture-chip">${name}<span class="ll-chip-count">${count} items${weightStr}${ageStr}</span></div>`;
    }).join('');
}

// --- Mode switching ---
// D2: Update the live/accountability pill counters.
// Live: saved sessions count + 1 if a live session is in-progress.
// Accountability: number of chest captures available to cross-reference.
function _updateLootLoggerModePillCounts() {
    const liveCount = (lootSessions?.length || 0) + (liveLootEvents?.length > 0 ? 1 : 0);
    const accCount = (window._chestCaptures?.length || lootBuyerCaptures?.length || 0);
    const lEl = document.getElementById('ll-mode-count-live');
    const aEl = document.getElementById('ll-mode-count-acc');
    if (lEl) { lEl.textContent = liveCount > 0 ? String(liveCount) : ''; lEl.style.display = liveCount > 0 ? '' : 'none'; }
    if (aEl) { aEl.textContent = accCount > 0 ? String(accCount) : ''; aEl.style.display = accCount > 0 ? '' : 'none'; }
}

function showLootLoggerMode(mode) {
    lootLoggerMode = mode;
    document.querySelectorAll('.loot-log-mode').forEach(el => el.style.display = 'none');
    document.getElementById('loot-log-live').style.display = mode === 'live' ? '' : 'none';
    document.getElementById('loot-log-upload').style.display = mode === 'upload' ? '' : 'none';
    document.getElementById('loot-log-accountability').style.display = mode === 'accountability' ? '' : 'none';
    // D2: Pill active class
    for (const [id, m] of [['loot-log-live-btn', 'live'], ['loot-log-upload-btn', 'upload'], ['loot-log-acc-btn', 'accountability']]) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', mode === m);
    }
    _updateLootLoggerModePillCounts();
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
        // E2: lootBuyerCaptures IS window._chestCaptures — no seeding needed
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
        // G4 follow-up: banner when any sessions have active share links
        const sharedCount = lootSessions.filter(s => !!s.public_token).length;
        if (sharedCount > 0) {
            html += `<div class="ll-shared-banner" title="Manage each share link from its session card">
                🔗 <strong>${sharedCount}</strong> of your session${sharedCount !== 1 ? 's are' : ' is'} shared publicly
                <span class="ll-shared-banner-hint">— anyone with the link can view</span>
            </div>`;
        }
        // Show live session card if events are accumulated
        if (liveLootEvents.length > 0) {
            const players = new Set(liveLootEvents.map(e => e.looted_by_name || e.lootedBy?.name || '')).size;
            const badge = liveSessionActive
                ? '<span class="loot-tab-status status-open" style="margin-left:0.4rem;">LIVE</span>'
                : '<span class="loot-tab-status status-partial" style="margin-left:0.4rem;">PAUSED</span>';
            const label = liveSessionName ? esc(liveSessionName) : 'Live Session';
            const wlNote = lootWhitelist.length ? ` <span style="font-size:0.66rem; color:var(--accent);">• whitelist active (${lootWhitelist.length})</span>` : '';
            html += `<div class="ll-session-card active-live" onclick="showLiveSession()">
                <div class="ll-session-info">
                    <div class="ll-session-title">${label}${badge}</div>
                    <div class="ll-session-meta">${liveLootEvents.length} events &bull; ${players} players${wlNote}</div>
                </div>
            </div>`;
        }

        if (lootSessions.length === 0 && liveLootEvents.length === 0) {
            // D6: onboarding landing cards instead of a flat empty state
            list.innerHTML = `<div class="empty-state" style="padding:0.75rem 0 1rem;">
                <p style="margin:0 0 0.75rem;">No loot sessions yet. Pick how you want to get started:</p>
                <div class="ll-landing">
                    <div class="ll-landing-card" onclick="document.querySelector('[data-tab=loot-buyer]')?.click(); setTimeout(()=>document.getElementById('client-download-link')?.scrollIntoView({behavior:'smooth',block:'center'}), 200);" title="Download the Go client to capture events live in-game">
                        <div class="ll-landing-icon">🎮</div>
                        <div class="ll-landing-title">Start a live session</div>
                        <div class="ll-landing-desc">Run the Coldtouch Go client while playing — PvP events stream in real time.</div>
                    </div>
                    <div class="ll-landing-card" onclick="showLootLoggerMode('upload')" title="Upload a .txt file from ao-loot-logger">
                        <div class="ll-landing-icon">📥</div>
                        <div class="ll-landing-title">Upload a log file</div>
                        <div class="ll-landing-desc">Already have a .txt from ao-loot-logger? Drop it here (or anywhere on the page).</div>
                    </div>
                    <div class="ll-landing-card" onclick="showLootLoggerMode('accountability')" title="Cross-reference loot against chest deposits">
                        <div class="ll-landing-icon">✓</div>
                        <div class="ll-landing-title">Run accountability</div>
                        <div class="ll-landing-desc">Compare a session against guild chest deposits to flag who didn't pay in.</div>
                    </div>
                </div>
            </div>`;
            return;
        }

        const savedNames = getSavedSessionNames();
        _updateLootLoggerModePillCounts();

        // Group sessions by CALENDAR day in the user's local timezone — not by rolling 24h window.
        // Fix (2026-04-18): previous version used `now - started_at < 24h` which put a 11 PM yesterday
        // session into "Today" if it's currently before 11 PM today. Now we compare against midnight
        // boundaries, so "Today" strictly means same calendar date.
        // Also handles both numeric (Unix ms) and ISO-string `started_at` by always going through `new Date()`.
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayMs = todayStart.getTime();
        const yesterdayMs = todayMs - 86400000;
        const weekStartMs = todayMs - 6 * 86400000; // last 7 calendar days including today
        const buckets = { today: [], yesterday: [], week: [], older: [] };
        for (const s of lootSessions) {
            const ts = +new Date(s.started_at); // works for both ms numbers and ISO strings
            if (isNaN(ts)) { buckets.older.push(s); continue; }
            if (ts >= todayMs) buckets.today.push(s);
            else if (ts >= yesterdayMs) buckets.yesterday.push(s);
            else if (ts >= weekStartMs) buckets.week.push(s);
            else buckets.older.push(s);
        }

        const renderCard = (s) => {
            const started = new Date(s.started_at).toLocaleString();
            const endedAt = s.ended_at ? new Date(s.ended_at) : null;
            const durMins = endedAt ? Math.round((endedAt - new Date(s.started_at)) / 60000) : 0;
            const duration = !endedAt ? 'ongoing' : durMins >= 60 ? `${Math.floor(durMins / 60)}h ${durMins % 60}m` : `${durMins} min`;
            const sid = esc(s.session_id);
            const customName = savedNames[s.session_id];
            const titleMain = customName
                ? `<strong>${esc(customName)}</strong> <span style="font-size:0.68rem; color:var(--text-muted);">${started}</span>`
                : `${started}`;
            const isShared = !!s.public_token;
            const sharedBadge = isShared ? `<span class="ll-session-shared-badge" title="This session has a public share link">🔗 shared</span>` : '';
            const tokenArg = isShared ? `'${esc(s.public_token)}'` : 'null';
            return `<div class="ll-session-card${isShared ? ' is-shared' : ''}" onclick="showSessionDetail('${sid}')">
                <div class="ll-session-info">
                    <div class="ll-session-title">${titleMain} <span style="font-size:0.68rem; color:var(--text-muted);">(${duration})</span>
                        <button class="ll-session-rename-btn" onclick="event.stopPropagation(); renameSavedSession('${sid}')" title="Rename session" aria-label="Rename session">✏️</button>
                        ${sharedBadge}
                    </div>
                    <div class="ll-session-meta">${s.event_count} events &bull; ${s.player_count} players${s.total_weight > 0 ? ` &bull; ${s.total_weight.toLocaleString()} kg` : ''}${s.death_count > 0 ? ` &bull; 💀 ${s.death_count}` : ''}</div>
                </div>
                <button class="btn-small" style="padding:0.35rem 0.55rem; font-size:0.8rem; flex-shrink:0; min-width:32px; min-height:32px;" onclick="event.stopPropagation(); openShareSessionModal('${sid}', ${tokenArg})" title="Share this session" aria-label="Share session">🔗</button>
                <button class="btn-small-danger" style="padding:0.35rem 0.55rem; font-size:0.8rem; flex-shrink:0; min-width:32px; min-height:32px;" onclick="event.stopPropagation(); deleteLootSession('${sid}', this)" title="Delete session" aria-label="Delete session">✕</button>
            </div>`;
        };

        const renderBucket = (label, items, open) => {
            if (!items.length) return '';
            return `<details class="ll-sessions-bucket" ${open ? 'open' : ''}>
                <summary class="ll-sessions-bucket-summary">
                    <span class="ll-sessions-bucket-label">${label}</span>
                    <span class="ll-sessions-bucket-count">${items.length}</span>
                </summary>
                <div class="ll-sessions-bucket-body">${items.map(renderCard).join('')}</div>
            </details>`;
        };

        html += renderBucket('📅 Today', buckets.today, true);
        html += renderBucket('Yesterday', buckets.yesterday, false);
        html += renderBucket('This Week', buckets.week, false);
        html += renderBucket('Older (past events)', buckets.older, false);

        list.innerHTML = html;
        // 4.5: Async stamp "📦 Tab" badges on sessions that overlap with tracked tab purchases
        _loadSessionTabBadges(lootSessions);
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

// 4.5: Reverse F1 — stamp "📦 Tab" badge on session cards when a tracked tab was purchased during the session
async function _loadSessionTabBadges(sessions) {
    if (!sessions || !sessions.length) return;
    if (!localStorage.getItem('albion_auth_token') && !discordUser) return;
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tabs`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const tabs = data.tabs || [];
        if (!tabs.length) return;
        const BUFFER = 3600000; // 1 hour
        for (const session of sessions) {
            const start = session.started_at - BUFFER;
            const end = (session.ended_at || session.started_at) + BUFFER;
            const overlapping = tabs.filter(t => t.purchasedAt >= start && t.purchasedAt <= end);
            if (overlapping.length === 0) continue;
            const card = document.querySelector(`.ll-session-card[onclick*="showSessionDetail('${esc(session.session_id)}')"]`);
            if (!card) continue;
            const titleArea = card.querySelector('.ll-session-title');
            if (!titleArea || titleArea.querySelector('.session-tab-badge')) continue;
            const badge = document.createElement('span');
            badge.className = 'll-session-shared-badge session-tab-badge';
            badge.style.cssText = 'background:rgba(245,158,11,0.15); color:#fbbf24; border-color:rgba(245,158,11,0.3); margin-left:0.3rem;';
            badge.title = `${overlapping.length} tracked tab${overlapping.length !== 1 ? 's' : ''} purchased during this session`;
            badge.textContent = `📦 ${overlapping.length} tab${overlapping.length !== 1 ? 's' : ''}`;
            titleArea.appendChild(badge);
        }
    } catch { /* silent */ }
}

function showLiveSession() {
    _llCurrentSessionId = null; // live session has no server-side ID yet
    // Whitelist is applied on the LIVE session view only. Death events always pass
    // through so "who died" remains accurate; only loot lines get filtered.
    const source = lootWhitelist.length
        ? liveLootEvents.filter(e => {
            const itemId = e.item_id || e.itemId || '';
            if (itemId === '__DEATH__') return true;
            return isWhitelistedEvent(e);
        })
        : liveLootEvents;
    renderLootSessionEvents(source.map(e => ({
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
    _llCurrentSessionId = sessionId;
    // Hide the sessions list while viewing one — user asked to declutter.
    const list = document.getElementById('loot-sessions-list');
    if (list) list.style.display = 'none';
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
    // Restore the sessions list.
    const list = document.getElementById('loot-sessions-list');
    if (list) list.style.display = '';
    _llCurrentSessionId = null;
}

function clearLootUpload() {
    document.getElementById('loot-upload-result').innerHTML = '';
    document.getElementById('loot-log-file-status').textContent = '';
    document.getElementById('ll-upload-clear-btn').style.display = 'none';
    // Dropping the uploaded session — clear the id so the in-report Share button
    // can't be wired to a stale session on a subsequent render.
    _llCurrentSessionId = null;
}

// === DEATH TIMELINE (Phase 2) ===
// Reconstruct "died with" info from the loot stream. The death packet itself
// carries no equipment (protocol limitation), but every loot event that
// follows where `looted_from_name === victim` is definitionally something
// looted off that victim's corpse. We attribute the corpse items to the death.
function buildDeathTimeline(events, byPlayer, priceMap, primaryGuild, primaryAlliance) {
    const deaths = [];
    // Index loot events by victim name for O(1) lookup
    const lootByVictim = new Map();
    for (const ev of events) {
        if (ev.item_id === '__DEATH__') continue;
        const victim = ev.looted_from_name;
        if (!victim) continue;
        if (!lootByVictim.has(victim)) lootByVictim.set(victim, []);
        lootByVictim.get(victim).push(ev);
    }
    for (const ev of events) {
        if (ev.item_id !== '__DEATH__') continue;
        const victim = ev.looted_from_name || '';
        const killer = ev.looted_by_name || '';
        if (!victim) continue;
        const deathTs = +new Date(ev.timestamp) || 0;
        // B6: parse equipment-at-death. Live WS events use `equipmentAtDeath`
        // (camelCase array); persisted DB rows use `equipment_json` (TEXT).
        let equipmentAtDeath = null;
        if (Array.isArray(ev.equipmentAtDeath) && ev.equipmentAtDeath.length > 0) {
            equipmentAtDeath = ev.equipmentAtDeath;
        } else if (typeof ev.equipment_json === 'string' && ev.equipment_json.length > 2) {
            try {
                const parsed = JSON.parse(ev.equipment_json);
                if (Array.isArray(parsed) && parsed.length > 0) equipmentAtDeath = parsed;
            } catch {}
        }
        // Attribute every loot event off this victim to the death.
        // Events can happen slightly before the death marker (packet ordering),
        // so we take all corpse loots regardless of timestamp but prefer post-death.
        const allCorpseLoots = lootByVictim.get(victim) || [];
        const lootedItems = allCorpseLoots.slice();  // copy
        // Aggregate by looter
        const byLooter = {};
        let estimatedValue = 0;
        for (const li of lootedItems) {
            const lname = li.looted_by_name || 'Unknown';
            if (!byLooter[lname]) byLooter[lname] = { name: lname, items: 0, silver: 0, guild: li.looted_by_guild || '' };
            byLooter[lname].items += (li.quantity || 1);
            const p = priceMap[li.item_id];
            if (p && p.price > 0) {
                const value = p.price * (li.quantity || 1);
                byLooter[lname].silver += value;
                estimatedValue += value;
            }
        }
        // Determine if victim was "ours" or "theirs" — mirrors isFriendly logic
        const victimData = byPlayer[victim];
        const victimGuild = victimData?.guild || ev.looted_from_guild || '';
        const victimAlliance = victimData?.alliance || ev.looted_from_alliance || '';
        const wasVictimFriendly = primaryAlliance && victimAlliance
            ? victimAlliance === primaryAlliance
            : (primaryGuild && victimGuild === primaryGuild);
        deaths.push({
            victim,
            victimGuild,
            victimAlliance,
            killer,
            killerGuild: ev.looted_by_guild || '',
            timestamp: deathTs,
            // Zone where the death happened — Go client v1.3.0+ emits this on
            // every DeathEvent; older .txt-log uploads won't have it. Used by
            // the player-card "died-with" preview tooltip.
            location: ev.location || '',
            lootedItems,
            equipmentAtDeath,
            estimatedValue,
            lootedBy: Object.values(byLooter).sort((a, b) => b.silver - a.silver || b.items - a.items),
            wasFriendly: !!wasVictimFriendly
        });
    }
    // Fallback — many .txt uploads (older Go client builds, upstream
    // ao-loot-logger) don't write __DEATH__ rows, so the explicit-death pass
    // above produces zero deaths and the "died with" preview never appears.
    // Evidence-based inference: a name that shows up as `looted_from_name`
    // AND carries a guild (mobs/chests have no guild) is almost certainly a
    // dead player. Synthesize a death entry using the earliest corpse-loot
    // timestamp as the time-of-death proxy.
    const explicitVictims = new Set(deaths.map(d => d.victim));
    for (const [victim, corpseLoots] of lootByVictim.entries()) {
        if (!victim || explicitVictims.has(victim)) continue;
        // Require guild evidence — skips mobs and world drops.
        const hasGuild = corpseLoots.some(ev => ev.looted_from_guild);
        // ALSO require the name to appear as an actual player elsewhere in the
        // session (they picked up something themselves at some point) OR there
        // to be at least 2 distinct items looted off them (a mob rarely drops
        // 2+ different items of equipment). This filters out name-collisions
        // with world chests / loot bags / mobs that happen to have a "guild".
        const isKnownPlayer = !!byPlayer[victim];
        const distinctItems = new Set(corpseLoots.map(ev => ev.item_id)).size;
        if (!hasGuild || (!isKnownPlayer && distinctItems < 2)) continue;

        corpseLoots.sort((a, b) => (+new Date(a.timestamp) || 0) - (+new Date(b.timestamp) || 0));
        const firstEv = corpseLoots[0];
        const deathTs = +new Date(firstEv.timestamp) || 0;

        // Aggregate looter summary (same shape as the explicit-death branch).
        const byLooter = {};
        let estimatedValue = 0;
        for (const li of corpseLoots) {
            const lname = li.looted_by_name || 'Unknown';
            if (!byLooter[lname]) byLooter[lname] = { name: lname, items: 0, silver: 0, guild: li.looted_by_guild || '' };
            byLooter[lname].items += (li.quantity || 1);
            const p = priceMap[li.item_id];
            if (p && p.price > 0) {
                const value = p.price * (li.quantity || 1);
                byLooter[lname].silver += value;
                estimatedValue += value;
            }
        }
        const victimData = byPlayer[victim];
        const victimGuild = victimData?.guild || firstEv.looted_from_guild || '';
        const victimAlliance = victimData?.alliance || firstEv.looted_from_alliance || '';
        const wasVictimFriendly = primaryAlliance && victimAlliance
            ? victimAlliance === primaryAlliance
            : (primaryGuild && victimGuild === primaryGuild);
        deaths.push({
            victim,
            victimGuild,
            victimAlliance,
            killer: '',          // unknown without __DEATH__ row
            killerGuild: '',
            timestamp: deathTs,
            location: firstEv.location || '',
            lootedItems: corpseLoots.slice(),
            equipmentAtDeath: null,
            estimatedValue,
            lootedBy: Object.values(byLooter).sort((a, b) => b.silver - a.silver || b.items - a.items),
            wasFriendly: !!wasVictimFriendly,
            inferred: true,       // flag so UI can distinguish if it ever cares
        });
    }

    // Sort newest-first — most recent death shows at top
    deaths.sort((a, b) => b.timestamp - a.timestamp);
    return deaths;
}

// G3: Heatmap timeline above the player cards. Divides the session duration
// into N buckets, rendering event density as bar height. Deaths get a red dot
// above their bucket so you can see at a glance when things went sideways.
// 2026-04-18: hover shows bucket death count + victim names (guild-colored).
function renderSessionTimeline(events, deaths) {
    if (!events || events.length < 2) return ''; // not enough data for a timeline
    const tsNums = events.map(e => +new Date(e.timestamp)).filter(n => !isNaN(n));
    if (tsNums.length < 2) return '';
    const minTs = Math.min(...tsNums);
    const maxTs = Math.max(...tsNums);
    const span = maxTs - minTs;
    if (span < 10000) return ''; // less than 10s range — skip
    const BUCKETS = 30;
    const bucketMs = span / BUCKETS;
    const counts = new Array(BUCKETS).fill(0);
    const deathsPerBucket = Array.from({ length: BUCKETS }, () => []);
    // Bucket events + attribute deaths from the deaths[] array (not from __DEATH__ events which we reconstruct elsewhere).
    for (const ev of events) {
        const t = +new Date(ev.timestamp);
        if (isNaN(t)) continue;
        let idx = Math.floor((t - minTs) / bucketMs);
        if (idx >= BUCKETS) idx = BUCKETS - 1;
        if (idx < 0) idx = 0;
        if (ev.item_id !== '__DEATH__') counts[idx]++;
    }
    for (const d of (deaths || [])) {
        const t = +new Date(d.timestamp);
        if (isNaN(t)) continue;
        let idx = Math.floor((t - minTs) / bucketMs);
        if (idx >= BUCKETS) idx = BUCKETS - 1;
        if (idx < 0) idx = 0;
        deathsPerBucket[idx].push(d);
    }
    // Guild color palette (same hash function as player cards for consistency).
    const guildPalette = ['#5b8def','#e06c75','#56b6c2','#c678dd','#e5c07b','#61afef','#98c379','#d19a66','#be5046','#7ec8e3'];
    const guildColor = (g) => {
        if (!g) return 'var(--text-muted)';
        const hash = [...g].reduce((s, c) => s + c.charCodeAt(0), 0);
        return guildPalette[hash % guildPalette.length];
    };
    const maxCount = Math.max(1, ...counts);
    const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // Build rich HTML tooltips — we need them escaped into data attributes; use a JSON-blob trick.
    const bars = counts.map((c, i) => {
        const pct = (c / maxCount) * 100;
        const bucketStart = minTs + i * bucketMs;
        const bucketEnd = bucketStart + bucketMs;
        const bucketDeaths = deathsPerBucket[i];
        const hasDeath = bucketDeaths.length > 0;
        // Plain-text tip for data-tip (old behavior)
        let tip = `${fmtTime(bucketStart)}\u2013${fmtTime(bucketEnd)} \u2022 ${c} event${c !== 1 ? 's' : ''}`;
        if (hasDeath) {
            tip += ` \u2022 ${bucketDeaths.length} death${bucketDeaths.length !== 1 ? 's' : ''}`;
        }
        // Rich tooltip via data-tip-html (consumed by ll-timeline-bar:hover CSS + a small JS hook below).
        let richTip = '';
        if (hasDeath) {
            const lines = bucketDeaths.slice(0, 8).map(d => {
                const icon = d.wasFriendly ? '🛡️' : '💀';
                const victim = esc(d.victim);
                const color = guildColor(d.victimGuild);
                const guild = d.victimGuild ? ` <span style="color:${color};">[${esc(d.victimGuild)}]</span>` : '';
                return `${icon} <strong>${victim}</strong>${guild}`;
            });
            if (bucketDeaths.length > 8) lines.push(`+${bucketDeaths.length - 8} more`);
            richTip = `<div class="ll-timeline-tip-title">${fmtTime(bucketStart)}</div>` +
                lines.map(l => `<div>${l}</div>`).join('') +
                `<div class="ll-timeline-tip-events">${c} loot event${c !== 1 ? 's' : ''}</div>`;
        } else {
            richTip = `<div class="ll-timeline-tip-title">${fmtTime(bucketStart)}</div><div>${c} event${c !== 1 ? 's' : ''}</div>`;
        }
        return `<div class="ll-timeline-bar${hasDeath ? ' has-death' : ''}${c === 0 ? ' empty' : ''}" style="height:${Math.max(pct, c > 0 ? 6 : 2)}%;" data-tip="${esc(tip)}" data-tip-html="${encodeURIComponent(richTip)}"></div>`;
    }).join('');
    return `<div class="ll-timeline-wrap">
        <div class="ll-timeline-label">Session timeline</div>
        <div class="ll-timeline">${bars}</div>
        <div class="ll-timeline-axis">
            <span>${fmtTime(minTs)}</span>
            <span>${fmtTime(minTs + span / 2)}</span>
            <span>${fmtTime(maxTs)}</span>
        </div>
    </div>`;
}

// Rewritten 2026-04-18 audit: one-liner rows inside a single collapsible <details>.
// Each row is itself a nested <details> so clicking the row expands full detail
// (items recovered, equipment-at-death, looters, Discord copy). Huge space saving
// on sessions with 20+ deaths where the old card-per-death layout dominated the page.
function renderDeathsSection(deaths) {
    if (!deaths || deaths.length === 0) return '';
    const filterActive = _llDeathFilterVictim !== null;
    const friendlyCount = deaths.filter(d => d.wasFriendly).length;
    const enemyCount = deaths.length - friendlyCount;
    // Reusable row renderer: icon + name + qty + value — readable at a glance.
    // Replaces the old icon-only strip where users had to hover each tiny square
    // to learn what the item was.
    const renderItemRow = (itemId, qty, source) => {
        const name = getFriendlyName(itemId) || itemId;
        const pe = _llPriceMap[itemId];
        const perUnit = pe && pe.price > 0 ? pe.price : 0;
        const total = perUnit * qty;
        const valStr = total > 0 ? formatSilver(total) : '';
        const valAttr = perUnit > 0 ? ` data-tip-value="${Math.floor(perUnit)}"` : '';
        return `<div class="ll-death-item-row">
            <img src="https://render.albiononline.com/v1/item/${encodeURIComponent(itemId)}.png" class="ll-death-item-icon" data-tip-item="${esc(itemId)}" data-tip-source="${source}"${valAttr} loading="lazy" onerror="this.style.display='none'" alt="">
            <span class="ll-death-item-name">${esc(name)}</span>
            ${qty > 1 ? `<span class="ll-death-item-qty">&times;${qty}</span>` : '<span class="ll-death-item-qty"></span>'}
            <span class="ll-death-item-value">${valStr}</span>
        </div>`;
    };

    const renderDeathRow = (d) => {
        const safeVictim = esc(d.victim);
        // User request 2026-04-21: prefix player names with their guild in the
        // death-row summary — [Guild] Name instead of just Name. Applies to
        // both friendly-deaths and enemy-kills subsections.
        const victimGuildPrefix = d.victimGuild ? `<span class="ll-death-row-guild" style="color:var(--text-muted);font-size:0.78rem;margin-right:0.25rem;">[${esc(d.victimGuild)}]</span>` : '';
        const killerGuildPrefix = d.killerGuild ? `<span class="ll-death-row-guild" style="color:var(--text-muted);font-size:0.78rem;margin-right:0.25rem;">[${esc(d.killerGuild)}]</span>` : '';
        const sideClass = d.wasFriendly ? 'll-death-friendly' : 'll-death-enemy';
        const sideIcon = d.wasFriendly ? '🛡️' : '💀';
        const sideLabel = d.wasFriendly ? 'friendly' : 'enemy';
        const when = d.timestamp ? new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
        const value = d.estimatedValue > 0 ? formatSilver(d.estimatedValue) : '—';

        // Group loot by (looter → item_id) so each looter's pile is a short,
        // readable list instead of one flat wall of icons across looters.
        const perLooter = {};
        for (const li of d.lootedItems) {
            if (!li.item_id) continue;
            const lname = li.looted_by_name || 'Unknown';
            if (!perLooter[lname]) perLooter[lname] = {};
            perLooter[lname][li.item_id] = (perLooter[lname][li.item_id] || 0) + (li.quantity || 1);
        }

        // Header summary: total item lines + silver across looters
        const totalLooters = d.lootedBy.length;
        const totalItems = d.lootedBy.reduce((s, l) => s + l.items, 0);

        // Per-looter sections (sorted by silver desc, mirrors d.lootedBy)
        const looterGroups = d.lootedBy.map(looter => {
            const items = perLooter[looter.name] || {};
            const rowsHtml = Object.entries(items)
                .sort((a, b) => {
                    const pa = (_llPriceMap[a[0]]?.price || 0) * a[1];
                    const pb = (_llPriceMap[b[0]]?.price || 0) * b[1];
                    return pb - pa; // most valuable first
                })
                .map(([itemId, qty]) => renderItemRow(itemId, qty, 'loot'))
                .join('');
            const guildBadge = looter.guild ? `<span class="ll-death-looter-guild">[${esc(looter.guild)}]</span>` : '';
            const statsStr = `${looter.items} item${looter.items !== 1 ? 's' : ''}${looter.silver > 0 ? ` · ${formatSilver(looter.silver)}` : ''}`;
            return `<div class="ll-death-looter-group">
                <div class="ll-death-looter-header">
                    ${guildBadge}
                    <span class="ll-death-looter-name">${esc(looter.name)}</span>
                    <span class="ll-death-looter-stats">${statsStr}</span>
                </div>
                <div class="ll-death-looter-items">${rowsHtml}</div>
            </div>`;
        }).join('');

        const lootSection = looterGroups
            ? `<div class="ll-death-section-label">Recovered by ${totalLooters} looter${totalLooters !== 1 ? 's' : ''} · ${totalItems} item${totalItems !== 1 ? 's' : ''}${d.estimatedValue > 0 ? ` · ${formatSilver(d.estimatedValue)}` : ''}</div>
               <div class="ll-death-looter-list">${looterGroups}</div>`
            : `<div class="ll-death-section-label">Recovered items</div>
               <div class="ll-death-empty">No items recovered in tracked range</div>`;

        // Worn-at-death: collapsible so the main focus stays on who looted what.
        // Shows full names and per-piece price. Defaults open when there are few
        // pieces, collapsed when the list is long.
        let equipmentHtml = '';
        if (Array.isArray(d.equipmentAtDeath) && d.equipmentAtDeath.length > 0) {
            const rows = d.equipmentAtDeath
                .filter(eq => eq && eq.itemId)
                .map(eq => renderItemRow(eq.itemId, 1, 'equipped'))
                .join('');
            const openAttr = d.equipmentAtDeath.length <= 4 ? ' open' : '';
            equipmentHtml = `<details class="ll-death-equipment-group"${openAttr}>
                <summary class="ll-death-section-label ll-death-equipment-summary">Worn at death (${d.equipmentAtDeath.length})</summary>
                <div class="ll-death-looter-items">${rows}</div>
            </details>`;
        }

        const isActive = filterActive && _llDeathFilterVictim === d.victim;
        return `<details class="ll-death-row ${sideClass}${isActive ? ' active-filter' : ''}"${isActive ? ' open' : ''}>
            <summary class="ll-death-row-summary">
                <span class="ll-death-row-icon">${sideIcon}</span>
                <span class="ll-death-row-time">${esc(when)}</span>
                <span class="ll-death-row-victim">${victimGuildPrefix}${safeVictim}</span>
                <span class="ll-death-row-sep">→</span>
                <span class="ll-death-row-killer">${killerGuildPrefix}${esc(d.killer) || 'unknown'}</span>
                <span class="ll-death-row-value">${value}</span>
                <span class="ll-death-badge">${sideLabel}</span>
            </summary>
            <div class="ll-death-row-body">
                ${equipmentHtml}
                ${lootSection}
                <div class="ll-death-actions">
                    <button class="btn-small" onclick="event.preventDefault();filterByDeath('${safeVictim}')" title="Filter main view to this death's loot chain">Filter main view</button>
                    <button class="btn-small" onclick="event.preventDefault();copyDeathReport('${safeVictim}', ${d.timestamp})" title="Copy death report for Discord">📋 Discord</button>
                </div>
            </div>
        </details>`;
    };

    // 2026-04-21 redesign — 74 death rows in one flat list was a wall of text.
    // Now split into two collapsible sub-sections:
    //   • Friendly deaths — auto-open (what matters for regear)
    //   • Enemy kills — collapsed by default (useful for audit but noisy in a ZvZ)
    // Both sorted chronologically (oldest first) so users can follow the fight
    // as it unfolded rather than jumping around by silver value.
    const byTime = (a, b) => (a.timestamp || 0) - (b.timestamp || 0);
    const friendlyDeaths = deaths.filter(d => d.wasFriendly).sort(byTime);
    const enemyDeaths = deaths.filter(d => !d.wasFriendly).sort(byTime);

    // Aggregate silver for the sub-section headers so users see the relative weight at a glance.
    const friendlyValue = friendlyDeaths.reduce((s, d) => s + (d.estimatedValue || 0), 0);
    const enemyValue = enemyDeaths.reduce((s, d) => s + (d.estimatedValue || 0), 0);

    // Column-header row — same grid as the row summaries so labels sit exactly
    // above their data columns. User feedback: "no label indicating killer, users
    // have to guess". Header also helps explain the layout at a glance.
    const columnsHeader = `
        <div class="ll-death-row-header">
            <span></span>
            <span class="ll-death-col-label">Time</span>
            <span class="ll-death-col-label">Victim</span>
            <span></span>
            <span class="ll-death-col-label">Killer</span>
            <span class="ll-death-col-label" style="text-align:right;">Value</span>
            <span></span>
        </div>`;

    const friendlyHtml = friendlyDeaths.length > 0 ? `
        <details class="ll-deaths-subgroup ll-deaths-subgroup-friendly" open>
            <summary class="ll-deaths-subgroup-summary">
                <span class="ll-deaths-subgroup-icon">🛡️</span>
                <span class="ll-deaths-subgroup-title">Friendly deaths</span>
                <span class="ll-deaths-subgroup-count">${friendlyDeaths.length}</span>
                ${friendlyValue > 0 ? `<span class="ll-deaths-subgroup-value">${formatSilver(friendlyValue)} lost</span>` : ''}
            </summary>
            ${columnsHeader}
            <div class="ll-deaths-list">${friendlyDeaths.map(renderDeathRow).join('')}</div>
        </details>` : '';

    const enemyHtml = enemyDeaths.length > 0 ? `
        <details class="ll-deaths-subgroup ll-deaths-subgroup-enemy">
            <summary class="ll-deaths-subgroup-summary">
                <span class="ll-deaths-subgroup-icon">💀</span>
                <span class="ll-deaths-subgroup-title">Enemy kills</span>
                <span class="ll-deaths-subgroup-count">${enemyDeaths.length}</span>
                ${enemyValue > 0 ? `<span class="ll-deaths-subgroup-value">${formatSilver(enemyValue)} taken</span>` : ''}
                <span class="ll-deaths-subgroup-hint">click to expand</span>
            </summary>
            ${columnsHeader}
            <div class="ll-deaths-list">${enemyDeaths.map(renderDeathRow).join('')}</div>
        </details>` : '';

    return `<details class="ll-deaths-section" open>
        <summary class="ll-deaths-summary">
            <span style="font-size:1.1rem;">☠</span>
            <span class="ll-deaths-title-text">Deaths</span>
            <span class="ll-deaths-count">${deaths.length}</span>
            ${friendlyCount > 0 ? `<span class="ll-deaths-friendly-count">🛡️ ${friendlyCount}</span>` : ''}
            ${enemyCount > 0 ? `<span class="ll-deaths-enemy-count">💀 ${enemyCount}</span>` : ''}
            ${filterActive ? `<button class="btn-small" style="margin-left:auto;" onclick="event.preventDefault();clearDeathFilter()">&times; Clear filter (${esc(_llDeathFilterVictim)})</button>` : ''}
        </summary>
        <div class="ll-deaths-body">${friendlyHtml}${enemyHtml}</div>
    </details>`;
}

function filterByDeath(victim) {
    _llDeathFilterVictim = (_llDeathFilterVictim === victim) ? null : victim;
    _llRenderFiltered();
}
function clearDeathFilter() {
    _llDeathFilterVictim = null;
    _llRenderFiltered();
}

function copyDeathReport(victim, timestamp) {
    const d = _llDeaths.find(x => x.victim === victim && x.timestamp === timestamp);
    if (!d) { showToast('Death record not found', 'error'); return; }
    const lines = [];
    lines.push(`**${d.wasFriendly ? '⚔ Friendly death' : '💀 Enemy kill'}**`);
    lines.push(`**${d.victim}**${d.victimGuild ? ` [${d.victimGuild}]` : ''} died to **${d.killer || 'unknown'}**${d.killerGuild ? ` [${d.killerGuild}]` : ''}`);
    lines.push(`at ${d.timestamp ? new Date(d.timestamp).toLocaleString() : 'unknown time'}`);
    lines.push(`Est. value recovered: **${d.estimatedValue > 0 ? formatSilver(d.estimatedValue) : 'unknown'}**`);
    if (d.lootedBy.length > 0) {
        lines.push('');
        lines.push('__Recovered by:__');
        for (const l of d.lootedBy) {
            lines.push(`• ${l.name}${l.guild ? ` [${l.guild}]` : ''} — ${l.items} item${l.items !== 1 ? 's' : ''}${l.silver > 0 ? `, ${formatSilver(l.silver)}` : ''}`);
        }
    }
    if (d.lootedItems.length > 0) {
        lines.push('');
        lines.push('__Items off corpse:__');
        const byItem = {};
        for (const li of d.lootedItems) {
            const key = li.item_id;
            if (!byItem[key]) byItem[key] = 0;
            byItem[key] += (li.quantity || 1);
        }
        for (const [itemId, qty] of Object.entries(byItem)) {
            lines.push(`• ${qty}x ${getFriendlyName(itemId) || itemId}`);
        }
    }
    lines.push('');
    lines.push('_Note: shows items picked up off the corpse by tracked players. Items left unlooted or looted by players outside capture range are not counted._');
    openCopyPreview(`Preview — ${d.victim}'s Death`, lines.join('\n'), 'Death report copied');
}

// Defensive client-side dedup — matches backend's UNIQUE INDEX tuple so any old
// duplicate rows in the DB (from before the April 18 dedupe migration) don't
// inflate looter totals in the UI. Also hardens against double-pushes from WS
// reconnects that sneak past the backend.
// Special/internal item IDs that should never be treated as loot. The Go
// client already skips silver pickups via IsSilver, but resolveItemName
// returns names like "GOLD", "FAME_CREDIT", etc. for negative numeric IDs —
// defensive filter here so they can't leak into accountability math.
const _specialInternalItemNames = new Set([
    'SILVER', 'GOLD', 'FAME_CREDIT', 'FAME_CREDIT_PREMIUM',
    'FACTION_TOKEN', 'SILVER_POUCH', 'GOLD_POUCH',
    'TOME_OF_INSIGHT', 'SEASONAL_TOKEN',
]);

// One-stop sanitize pass for loot-event arrays before any aggregation:
//   • UNKNOWN_<n> → real string ID (requires NUMERIC_ITEM_MAP loaded)
//   • Dedup on (ts, looter, item, victim, qty) — matches backend UNIQUE INDEX
//   • Drop events with missing item_id (protocol quirk → "" phantom key)
//   • Drop special/internal items (SILVER, GOLD, etc.)
// __DEATH__ events always pass through unchanged — they're not loot rows.
function sanitizeLootEvents(events) {
    if (!Array.isArray(events)) return events;
    events.forEach(normalizeLootEventInPlace);
    return _dedupeLootEvents(events).filter(ev => {
        if (ev.item_id === '__DEATH__') return true;
        const id = ev.item_id || ev.itemId || '';
        if (!id) return false;
        if (_specialInternalItemNames.has(id)) return false;
        return true;
    });
}

function _dedupeLootEvents(events) {
    if (!Array.isArray(events)) return events;
    const seen = new Set();
    const out = [];
    for (const e of events) {
        const key = [
            String(e.timestamp || e.ts || ''),
            (e.looted_by_name || e.lootedBy?.name || '').toLowerCase(),
            (e.item_id || e.itemId || '').toLowerCase(),
            (e.looted_from_name || e.lootedFrom?.name || '').toLowerCase(),
            String(e.quantity || 1),
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
    }
    return out;
}

async function renderLootSessionEvents(events, targetEl, depositedMap) {
    // One-stop sanitize: dedupe, drop empty item_ids, drop special internals
    // (SILVER, GOLD, etc.), normalize UNKNOWN_<n> → real IDs. Keeps this
    // path aligned with runAccountabilityCheck so both views attribute the
    // same way.
    events = sanitizeLootEvents(events);
    // depositedMap: optional { itemId: qty } for accountability coloring
    const isDetail = !targetEl;
    const detail = targetEl || document.getElementById('loot-session-detail');
    detail.style.display = '';

    if (events.length === 0) {
        detail.innerHTML = '<div class="empty-state"><p>No loot events in this session.</p></div>';
        return;
    }

    // Build per-player breakdown + track deaths
    const byPlayer = {};
    const deathSet = new Set(); // players who died (victim names)
    const killSet = new Set();  // players who got kills (killer names)
    for (const ev of events) {
        // Death events: item_id='__DEATH__', looted_by_name=killer, looted_from_name=victim
        if (ev.item_id === '__DEATH__') {
            if (ev.looted_from_name) deathSet.add(ev.looted_from_name);
            if (ev.looted_by_name) killSet.add(ev.looted_by_name);
            continue; // don't count as loot
        }
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
    // Attach death/kill info to players
    for (const [name, data] of Object.entries(byPlayer)) {
        data.died = deathSet.has(name);
        data.gotKills = killSet.has(name);
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

    // Detect primary guild and alliance (most common among looters = "our" side)
    const guildCounts = {};
    const allianceCounts = {};
    for (const [, data] of Object.entries(byPlayer)) {
        if (data.guild) guildCounts[data.guild] = (guildCounts[data.guild] || 0) + data.items.length;
        if (data.alliance) allianceCounts[data.alliance] = (allianceCounts[data.alliance] || 0) + data.items.length;
    }
    const primaryGuild = Object.entries(guildCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const primaryAlliance = Object.entries(allianceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Compute player values and mark guild/enemy status (alliance-aware for multi-guild ZvZ)
    for (const [name, data] of Object.entries(byPlayer)) {
        data.totalValue = data.items.reduce((s, ev) => {
            const p = priceMap[ev.item_id];
            return s + (p ? p.price * (ev.quantity || 1) : 0);
        }, 0);
        // isEnemy: player is a loot SOURCE (enemy who died), not a guild member doing the looting
        const isLootSource = data.items.length > 0 && data.items.every(ev => ev.looted_from_name === name);
        // Alliance-based matching: if player's alliance matches primary alliance, they're friendly
        // Falls back to guild matching when alliance is empty
        const isFriendly = primaryAlliance && data.alliance
            ? data.alliance === primaryAlliance
            : (!primaryGuild || data.guild === primaryGuild || !data.guild);
        data.isEnemy = isLootSource || !isFriendly;
    }

    // Compute death timeline for this session (used by _llRenderFiltered)
    _llPrimaryGuild = primaryGuild;
    _llPrimaryAlliance = primaryAlliance;
    _llDeaths = buildDeathTimeline(events, byPlayer, priceMap, primaryGuild, primaryAlliance);
    // Build per-victim "died-with" lookup — aggregates items looted off their
    // corpse across ALL deaths this session, so the player card preview can
    // surface the items they died with (greyed out + red border). A player may
    // have died multiple times; we merge the death metadata so the hover
    // tooltip reads "Died 3x — last at 3:45 PM in Bridgewatch — killed by ..."
    _llDiedWithByVictim = {};
    for (const d of _llDeaths) {
        if (!d.victim) continue;
        if (!_llDiedWithByVictim[d.victim]) {
            _llDiedWithByVictim[d.victim] = { items: new Map(), deaths: [] };
        }
        _llDiedWithByVictim[d.victim].deaths.push({
            ts: d.timestamp,
            location: d.location || '',
            killer: d.killer || '',
            lootedBy: d.lootedBy || [],
            inferred: !!d.inferred,
        });
        for (const li of d.lootedItems || []) {
            if (!li.item_id || li.item_id === '__DEATH__') continue;
            const q = li.quality || 1;
            const key = li.item_id + '_' + q;
            const existing = _llDiedWithByVictim[d.victim].items.get(key);
            const qty = li.quantity || 1;
            if (existing) existing.qty += qty;
            else _llDiedWithByVictim[d.victim].items.set(key, { itemId: li.item_id, quality: q, qty });
        }
    }
    // Mark `data.died = true` for INFERRED victims too (the explicit-death pass
    // at ~line 10715 only caught __DEATH__-row victims). Without this, the 💀
    // icon in the player header wouldn't appear for players whose death was
    // reconstructed from corpse-loot evidence in older .txt uploads.
    //
    // Also: ensure victims who never picked up anything themselves (they only
    // show up as `looted_from_name` in the events) get a player card. Without
    // this they'd have no card to show the died-with preview on — the whole
    // point of the feature. Create synthetic byPlayer entries for them,
    // sourcing guild/alliance from the first death record.
    for (const victim of Object.keys(_llDiedWithByVictim)) {
        if (!byPlayer[victim]) {
            const firstDeath = _llDeaths.find(d => d.victim === victim);
            byPlayer[victim] = {
                guild: firstDeath?.victimGuild || '',
                alliance: firstDeath?.victimAlliance || '',
                items: [],        // they never looted anything themselves
                totalQty: 0,
                totalWeight: 0,
                totalValue: 0,
                _victimOnly: true, // flag in case future code wants to treat these differently
            };
            // Victim-only players aren't "enemies" in the ZvZ sense — they're
            // just someone who showed up in a death. Classify by their own
            // alliance/guild the same way regular players are classified.
            const isFriendly = primaryAlliance && byPlayer[victim].alliance
                ? byPlayer[victim].alliance === primaryAlliance
                : (!primaryGuild || byPlayer[victim].guild === primaryGuild || !byPlayer[victim].guild);
            byPlayer[victim].isEnemy = !isFriendly;
        }
        byPlayer[victim].died = true;
    }
    // G6: fetch per-player trends across all of this user's saved sessions
    // (fire-and-forget — if it's slow, we re-render when it arrives)
    _llPlayerTrends = {};
    const playerNames = Object.keys(byPlayer);
    if (playerNames.length > 0 && localStorage.getItem('albion_auth_token')) {
        fetch(`${VPS_BASE}/api/player-trends-bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ names: playerNames })
        })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
            if (d?.trends) {
                _llPlayerTrends = d.trends;
                _llRenderFiltered();
            }
        })
        .catch(() => { /* silent — card just won't show trends */ });
    }
    // Reset filters when loading a new session
    _llDeathFilterVictim = null;
    window._llShowAllCards = false; // E5: reset card batch on session change

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
    // Persist last-used sort across reloads
    let sortVal = sortEl ? sortEl.value : '';
    if (!sortVal) {
        try { sortVal = localStorage.getItem('albion_ll_sort') || 'value'; } catch { sortVal = 'value'; }
    } else {
        try { localStorage.setItem('albion_ll_sort', sortVal); } catch {}
    }

    // Filter players by search text (match player name, guild, or any item name)
    let entries = Object.entries(byPlayer);
    // Remove players that were explicitly removed
    if (_llRemovedPlayers.size > 0) {
        entries = entries.filter(([name]) => !_llRemovedPlayers.has(name));
    }
    // Death filter: only show players who looted FROM the selected victim (or the victim themselves)
    if (_llDeathFilterVictim) {
        const victim = _llDeathFilterVictim;
        entries = entries.filter(([name, data]) => {
            if (name === victim) return true;
            return data.items.some(ev => ev.looted_from_name === victim);
        });
    }
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
    // Min-value filter (silver threshold)
    const minValEl = document.getElementById('ll-min-value');
    const minValRaw = minValEl ? parseInt(minValEl.value) : 0;
    const minVal = isNaN(minValRaw) ? 0 : minValRaw;
    try { if (minVal > 0) localStorage.setItem('albion_ll_min_value', String(minVal)); else localStorage.removeItem('albion_ll_min_value'); } catch {}
    if (minVal > 0) {
        entries = entries.filter(([, data]) => (data.totalValue || 0) >= minVal);
    }
    // Guild filter (dropdown)
    const guildFilter = document.getElementById('ll-filter-guild')?.value || '';
    if (guildFilter) {
        entries = entries.filter(([, data]) => (data.guild || '') === guildFilter);
    }
    // Single-player filter (dropdown)
    const playerFilter = document.getElementById('ll-filter-player')?.value || '';
    if (playerFilter) {
        entries = entries.filter(([name]) => name === playerFilter);
    }
    // Item tier filter helper
    function getItemTier(itemId) {
        const m = (itemId || '').match(/^T(\d)/);
        return m ? parseInt(m[1]) : 0;
    }
    function _llIsWeapon(itemId) {
        return /^T\d_(MAIN|2H|OFF)_/i.test(itemId || '');
    }
    function _llIsBag(itemId) {
        return /^T\d_BAG/i.test(itemId || '');
    }
    function _llPassesChips(itemId, ev) {
        if (_llActiveChips.size === 0) return true;
        // Tier chips (t5+ / t6+ / t7+ / t8+) are exclusive — highest wins
        const tierChips = ['t8+', 't7+', 't6+', 't5+'].filter(c => _llActiveChips.has(c));
        if (tierChips.length > 0) {
            const minTier = parseInt(tierChips[0][1]); // first element is highest
            if (getItemTier(itemId) < minTier) return false;
        }
        // Category chips (additive — AND with tier filter)
        if (_llActiveChips.has('weapons') && !_llIsWeapon(itemId)) return false;
        if (_llActiveChips.has('bags') && !_llIsBag(itemId)) return false;
        if (_llActiveChips.has('high-value')) {
            const p = priceMap[itemId];
            const total = p ? p.price * (ev?.quantity || 1) : 0;
            if (total < 100000) return false;
        }
        return true;
    }
    function passesItemFilter(itemId, filter, ev) {
        // Dropdown filter first (backwards compat)
        if (filter !== 'all') {
            if (filter === 'nobags' && (itemId || '').includes('BAG')) return false;
            if (filter === 't5+' && getItemTier(itemId) < 5) return false;
            if (filter === 't6+' && getItemTier(itemId) < 6) return false;
        }
        // Then chip filter
        return _llPassesChips(itemId, ev);
    }
    function _llToggleChip(chip) {
        // Tier chips are exclusive among themselves (only one min-tier makes sense)
        if (['t5+', 't6+', 't7+', 't8+'].includes(chip)) {
            const wasActive = _llActiveChips.has(chip);
            ['t5+', 't6+', 't7+', 't8+'].forEach(c => _llActiveChips.delete(c));
            if (!wasActive) _llActiveChips.add(chip);
        } else {
            if (_llActiveChips.has(chip)) _llActiveChips.delete(chip);
            else _llActiveChips.add(chip);
        }
        _persistChips();
        _llRenderFiltered();
    }
    function _llClearChips() {
        _llActiveChips.clear();
        _persistChips();
        _llRenderFiltered();
    }
    window._llToggleChip = _llToggleChip;
    window._llClearChips = _llClearChips;

    // Sort
    if (sortVal === 'value') entries.sort((a, b) => b[1].totalValue - a[1].totalValue);
    else if (sortVal === 'items') entries.sort((a, b) => b[1].totalQty - a[1].totalQty);
    else if (sortVal === 'weight') entries.sort((a, b) => b[1].totalWeight - a[1].totalWeight);
    else if (sortVal === 'name') entries.sort((a, b) => a[0].localeCompare(b[0]));

    // Guild grouping: unless a specific guild is filtered, cluster entries by
    // guild so cards from the same guild appear together under a collapsible
    // header. Within each guild, the user's sort (value/items/weight/name) is
    // preserved. Guilds themselves are ordered by their aggregate totalValue
    // (biggest contributor first) so the header-ordering matches expectations.
    const _llGuildTotals = new Map(); // guild -> sum(totalValue) across ALL entries
    const _llGuildCounts = new Map(); // guild -> member count
    for (const [, d] of entries) {
        const g = d.guild || '';
        _llGuildTotals.set(g, (_llGuildTotals.get(g) || 0) + (d.totalValue || 0));
        _llGuildCounts.set(g, (_llGuildCounts.get(g) || 0) + 1);
    }
    const _llGroupByGuild = !guildFilter;
    if (_llGroupByGuild) {
        entries.sort((a, b) => {
            const ga = a[1].guild || '';
            const gb = b[1].guild || '';
            if (ga === gb) return 0; // stable within-guild order (preserves sortVal)
            return (_llGuildTotals.get(gb) || 0) - (_llGuildTotals.get(ga) || 0);
        });
    }

    // Totals (from full dataset, not filtered — exclude death events for count/value)
    const lootEventsOnly = events.filter(e => e.item_id !== '__DEATH__');
    const deathEvents = events.filter(e => e.item_id === '__DEATH__');
    const totalItems = lootEventsOnly.reduce((s, e) => s + (e.quantity || 1), 0);
    const totalValue = lootEventsOnly.reduce((s, e) => {
        const p = priceMap[e.item_id];
        return s + (p ? p.price * (e.quantity || 1) : 0);
    }, 0);
    const totalPlayers = Object.keys(byPlayer).length;
    const totalDeaths = deathEvents.length;
    // Duration: first to last timestamp across all events
    const tsNums = events.map(e => +new Date(e.timestamp)).filter(n => !isNaN(n));
    const durMs = tsNums.length > 1 ? Math.max(...tsNums) - Math.min(...tsNums) : 0;
    const fmtDuration = (ms) => {
        if (ms <= 0) return '—';
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
    };

    // Summary stat strip (new, above existing viewer header)
    let html = `<div class="ll-summary-strip">
        <div class="ll-summary-stat">
            <div class="ll-summary-label">Events</div>
            <div class="ll-summary-value">${events.length}</div>
        </div>
        <div class="ll-summary-stat">
            <div class="ll-summary-label">Players</div>
            <div class="ll-summary-value">${totalPlayers}</div>
        </div>
        <div class="ll-summary-stat">
            <div class="ll-summary-label">Items looted</div>
            <div class="ll-summary-value">${totalItems.toLocaleString()}</div>
        </div>
        <div class="ll-summary-stat">
            <div class="ll-summary-label">Est. value</div>
            <div class="ll-summary-value accent">${totalValue > 0 ? formatSilver(totalValue) : '—'}</div>
        </div>
        <div class="ll-summary-stat" ${totalDeaths > 0 ? 'data-tip="Players who died during this session"' : ''}>
            <div class="ll-summary-label">Deaths</div>
            <div class="ll-summary-value ${totalDeaths > 0 ? 'loss' : ''}">${totalDeaths > 0 ? `💀 ${totalDeaths}` : '0'}</div>
        </div>
        <div class="ll-summary-stat">
            <div class="ll-summary-label">Duration</div>
            <div class="ll-summary-value">${fmtDuration(durMs)}</div>
        </div>
        ${_llPrimaryGuild ? `<div class="ll-summary-stat" title="Most common guild among looters">
            <div class="ll-summary-label">Guild</div>
            <div class="ll-summary-value" style="font-size:0.78rem;">${esc(_llPrimaryGuild)}</div>
        </div>` : ''}
        <div class="ll-summary-actions">
            <div class="ll-discord-dropdown">
                <button class="btn-small" onclick="this.nextElementSibling.classList.toggle('open')" title="Copy session to Discord">📋 Discord ▾</button>
                <div class="ll-discord-menu">
                    <button onclick="this.parentElement.classList.remove('open'); copySessionDiscord('summary')">GvG Summary</button>
                    <button onclick="this.parentElement.classList.remove('open'); copySessionDiscord('topLooters')">Top Looters</button>
                    <button onclick="this.parentElement.classList.remove('open'); copySessionDiscord('deaths')">Deaths Report</button>
                </div>
            </div>
            <button class="btn-small" onclick="exportLootSession()" title="Export to CSV">CSV</button>
            <button class="btn-small" onclick="exportLootSessionTxt()" title="Export as .txt in ao-loot-logger format">.txt</button>
            <button class="btn-small" onclick="exportLootSessionJson()" title="Export raw session data as JSON">JSON</button>
            ${_llCurrentSessionId && !window._sharedSessionViewActive
                ? `<button class="btn-small-accent" onclick="openShareSessionModal('${esc(_llCurrentSessionId)}', null)" title="Generate a public link — anyone with it can view this session">🔗 Share</button>
                   <button class="btn-small-accent" onclick="runAccountabilityForSession('${esc(_llCurrentSessionId)}')" title="Cross-reference this session against chest deposits">✓ Accountability</button>`
                : (window._sharedSessionViewActive ? '' : '<span id="ll-report-share-slot"></span>')}
            ${isDetail ? `<button class="btn-small" onclick="hideLootSessionDetail()">&#x2190; Back</button>` : ''}
        </div>
    </div>`;

    // G3: heatmap timeline (above deaths + player cards)
    html += renderSessionTimeline(events, _llDeaths);

    // Deaths section (above player cards)
    html += renderDeathsSection(_llDeaths);

    // Search/sort/filter bar
    const filterEl = document.getElementById('ll-filter-tier');
    let filterVal = filterEl ? filterEl.value : '';
    if (!filterVal) {
        try { filterVal = localStorage.getItem('albion_ll_filter') || 'all'; } catch { filterVal = 'all'; }
    } else {
        try { localStorage.setItem('albion_ll_filter', filterVal); } catch {}
    }
    const minValVal = (() => { try { return parseInt(localStorage.getItem('albion_ll_min_value')) || 0; } catch { return 0; } })();
    // Build a sorted list of unique guilds + players for dedicated dropdowns.
    // Much faster than typing a name into the freeform search when sessions have many players.
    const uniqueGuilds = [...new Set(Object.values(byPlayer).map(d => d.guild).filter(Boolean))].sort();
    const uniquePlayers = [...Object.keys(byPlayer)].sort();
    const selectedGuild = document.getElementById('ll-filter-guild')?.value || '';
    const selectedPlayer = document.getElementById('ll-filter-player')?.value || '';
    html += `<div class="ll-filter-bar">
        <div class="search-input-wrapper" style="flex:1; min-width:160px;">
            <span class="search-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></span>
            <input type="text" id="ll-search" placeholder="Search player, guild, or item..." value="${esc(searchVal)}" oninput="_llDebouncedRender(300)" aria-label="Search players, guilds, or items">
        </div>
        <select id="ll-filter-guild" class="transport-select" style="min-width:140px;" onchange="_llDebouncedRender(100)" aria-label="Filter by guild" title="Show only players in this guild">
            <option value="">All guilds</option>
            ${uniqueGuilds.map(g => `<option value="${esc(g)}"${selectedGuild === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}
        </select>
        <select id="ll-filter-player" class="transport-select" style="min-width:140px;" onchange="_llDebouncedRender(100)" aria-label="Filter to single player" title="Jump straight to one player's loot">
            <option value="">All players</option>
            ${uniquePlayers.map(p => `<option value="${esc(p)}"${selectedPlayer === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
        <select id="ll-filter-tier" class="transport-select" style="min-width:80px;" onchange="_llDebouncedRender(100)" title="Filter items by tier" aria-label="Filter by tier">
            <option value="all"${filterVal === 'all' ? ' selected' : ''}>All Tiers</option>
            <option value="t5+"${filterVal === 't5+' ? ' selected' : ''}>T5+</option>
            <option value="t6+"${filterVal === 't6+' ? ' selected' : ''}>T6+</option>
            <option value="nobags"${filterVal === 'nobags' ? ' selected' : ''}>No Bags</option>
        </select>
        <input type="number" id="ll-min-value" class="transport-select" style="width:110px;" placeholder="Min value (s)" value="${minValVal || ''}" oninput="_llDebouncedRender(300)" aria-label="Minimum total value to display" title="Hide players whose looted value is below this silver threshold">
        <select id="ll-sort" class="transport-select" style="min-width:100px;" onchange="_llDebouncedRender(100)" aria-label="Sort players by">
            <option value="value"${sortVal === 'value' ? ' selected' : ''}>Value ↓</option>
            <option value="items"${sortVal === 'items' ? ' selected' : ''}>Items ↓</option>
            <option value="weight"${sortVal === 'weight' ? ' selected' : ''}>Weight ↓</option>
            <option value="name"${sortVal === 'name' ? ' selected' : ''}>Name A-Z</option>
        </select>
        <span style="font-size:0.72rem; color:var(--text-muted); white-space:nowrap;">${entries.length}/${totalPlayers}</span>
    </div>`;
    // Small hint so users discover keyboard shortcuts (A11) without opening the help
    html += `<div class="ll-shortcut-hint">
        <kbd>?</kbd> shortcuts · <kbd>E</kbd> expand · <kbd>C</kbd> collapse · <kbd>F</kbd> search
    </div>`;

    // Item filter chips (Phase 5 G11) — multi-select, layered on top of the tier dropdown
    const chipDef = [
        { id: 't6+', label: 'T6+' },
        { id: 't7+', label: 'T7+' },
        { id: 't8+', label: 'T8+' },
        { id: 'weapons', label: '🗡 Weapons' },
        { id: 'bags', label: '🎒 Bags' },
        { id: 'high-value', label: '💎 >100k' }
    ];
    const chipHtml = chipDef.map(c => {
        const active = _llActiveChips.has(c.id);
        return `<button class="ll-filter-chip${active ? ' active' : ''}" onclick="_llToggleChip('${c.id}')" data-chip="${c.id}">${c.label}</button>`;
    }).join('');
    const chipClearHtml = _llActiveChips.size > 0
        ? `<button class="ll-filter-chip ll-chip-clear" onclick="_llClearChips()" title="Clear all item filters">✕ clear</button>`
        : '';
    html += `<div class="ll-filter-chips">${chipHtml}${chipClearHtml}</div>`;

    // Expand/Collapse All buttons + remove players
    html += `<div style="display:flex; gap:0.4rem; margin-bottom:0.3rem;">
        <button class="btn-small" onclick="document.querySelectorAll('#loot-session-detail .ll-player-card').forEach(c=>c.classList.add('expanded'))">Expand All</button>
        <button class="btn-small" onclick="document.querySelectorAll('#loot-session-detail .ll-player-card').forEach(c=>c.classList.remove('expanded'))">Collapse All</button>
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

    // E5: Virtualize large sessions — initially render max 30 cards, "Show more" loads the rest
    const CARD_BATCH = 30;
    const showAll = window._llShowAllCards || false;
    const visibleEntries = (!showAll && entries.length > CARD_BATCH) ? entries.slice(0, CARD_BATCH) : entries;
    const hiddenCount = entries.length - visibleEntries.length;

    // Player cards. When guild grouping is on, emit a <details> wrapper per
    // guild whose header shows count + totalValue; cards for the same guild
    // render inside the same wrapper. A mutable `_llLastGuildEmitted` tracks
    // the transition so we open/close wrappers around guild boundaries.
    let _llLastGuildEmitted = null;  // '' sentinel for "not started"; actual guild string once emitted
    const _llGuildBlockOpen = () => {
        if (!_llGroupByGuild || _llLastGuildEmitted === null) return '';
        return '</div></details>';
    };
    html += visibleEntries.map(([name, data]) => {
        // Guild header injection (only when grouping)
        let guildHeader = '';
        if (_llGroupByGuild) {
            const g = data.guild || '';
            if (g !== _llLastGuildEmitted) {
                // Close previous guild's wrapper (if any), then open new one
                if (_llLastGuildEmitted !== null) guildHeader += '</div></details>';
                const color = (data.guild && guildColorMap[data.guild]) || 'var(--border)';
                const label = data.guild ? esc(data.guild) : '<em style="color:var(--text-muted);">No guild</em>';
                const gTotal = _llGuildTotals.get(g) || 0;
                const gCount = _llGuildCounts.get(g) || 0;
                guildHeader += `<details class="ll-guild-group" open>
                    <summary class="ll-guild-summary" style="border-left:3px solid ${color};display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0.7rem;margin-top:0.5rem;background:var(--bg-subtle,rgba(255,255,255,0.03));border-radius:4px;cursor:pointer;font-size:0.85rem;">
                        <span class="ll-guild-name" style="font-weight:600;">${label}</span>
                        <span class="ll-guild-stats" style="color:var(--text-muted);font-size:0.78rem;">${gCount} player${gCount !== 1 ? 's' : ''} · ${gTotal > 0 ? formatSilver(gTotal) : '—'}</span>
                    </summary>
                    <div class="ll-guild-members" style="padding-top:0.3rem;">`;
                _llLastGuildEmitted = g;
            }
        }
        const playerValue = data.totalValue;
        const weightStr = data.totalWeight > 0 ? data.totalWeight.toFixed(1) + ' kg' : '—';
        const guildBorder = data.guild && guildColorMap[data.guild]
            ? `border-left: 3px solid ${guildColorMap[data.guild]};` : '';

        // Item icon preview strip — all unique items (no cap, per user request).
        // Aggregates quantities per distinct itemId+quality for the tooltip and badge.
        const itemAgg = new Map(); // key = itemId+_+quality, value = { itemId, quality, qty, totalValue }
        for (const ev of data.items) {
            if (!ev.item_id) continue;
            const q = ev.quality || 1;
            const key = ev.item_id + '_' + q;
            const existing = itemAgg.get(key);
            const qty = ev.quantity || 1;
            const priceEntry = priceMap[ev.item_id];
            const valEach = priceEntry && priceEntry.price > 0 ? priceEntry.price : 0;
            if (existing) {
                existing.qty += qty;
                existing.totalValue += valEach * qty;
            } else {
                itemAgg.set(key, { itemId: ev.item_id, quality: q, qty, totalValue: valEach * qty });
            }
        }
        // Sort by total value desc (most valuable first) so the header stripe leads with the big hits.
        const aggSorted = [...itemAgg.values()].sort((a, b) => b.totalValue - a.totalValue);
        let iconStripHtml = aggSorted.map(agg => {
            const valAttr = agg.totalValue > 0 ? ` data-tip-value="${Math.floor(agg.totalValue)}"` : '';
            const qtyBadge = agg.qty > 1 ? `<span class="ll-preview-qty-badge">${agg.qty}</span>` : '';
            const qLabel = agg.quality > 1 ? ` q${agg.quality}` : '';
            return `<div class="ll-preview-slot" data-tip-item="${esc(agg.itemId)}" data-tip-source="loot" data-tip-qty="${agg.qty}"${valAttr}>
                <img src="https://render.albiononline.com/v1/item/${encodeURIComponent(agg.itemId)}.png?quality=${agg.quality}" class="ll-preview-icon" loading="lazy" onerror="this.style.display='none'" alt="${esc(getFriendlyName(agg.itemId) || agg.itemId)}${qLabel} x${agg.qty}">
                ${qtyBadge}
            </div>`;
        }).join('');

        // "Died with" preview: for players who died, append the items looted off
        // their corpse (= what they died with) with red/greyed styling. Per-icon
        // `title` shows the death context: time, zone (if Go client v1.3.0+), killer,
        // and who looted the items. Reuses the same _llDiedWithByVictim map built
        // alongside _llDeaths in renderLootSessionEvents.
        const diedWith = _llDiedWithByVictim && _llDiedWithByVictim[name];
        if (diedWith && diedWith.items.size > 0) {
            const diedItems = [...diedWith.items.values()].sort((a, b) => b.qty - a.qty);
            // Aggregate title text once — same tooltip on every died-with icon.
            const deathCount = diedWith.deaths.length;
            const latest = diedWith.deaths.reduce((a, b) => (a.ts > b.ts ? a : b), diedWith.deaths[0]);
            const whenStr = latest && latest.ts ? new Date(latest.ts).toLocaleTimeString() : 'unknown time';
            const whereStr = latest && latest.location ? ` in ${latest.location}` : '';
            const killerStr = latest && latest.killer ? ` — killed by ${latest.killer}` : '';
            const lootedByStr = latest && latest.lootedBy && latest.lootedBy.length > 0
                ? ` — looted by ${latest.lootedBy.slice(0, 3).map(l => `${l.name}${l.items ? ` (${l.items} items)` : ''}`).join(', ')}${latest.lootedBy.length > 3 ? ` +${latest.lootedBy.length - 3} more` : ''}`
                : '';
            const countPrefix = deathCount > 1 ? `Died ${deathCount}× — last at ${whenStr}` : `Died at ${whenStr}`;
            const diedTitle = `${countPrefix}${whereStr}${killerStr}${lootedByStr}`;
            const diedDivider = `<span class="ll-preview-died-divider" title="${esc(diedTitle)}">💀</span>`;
            const diedIcons = diedItems.map(it => {
                const qtyBadge = it.qty > 1 ? `<span class="ll-preview-qty-badge">${it.qty}</span>` : '';
                const qLabel = it.quality > 1 ? ` q${it.quality}` : '';
                const iName = getFriendlyName(it.itemId) || it.itemId;
                return `<div class="ll-preview-slot ll-preview-died" title="${esc(iName)}${qLabel} × ${it.qty} — ${diedTitle}">
                    <img src="https://render.albiononline.com/v1/item/${encodeURIComponent(it.itemId)}.png?quality=${it.quality}" class="ll-preview-icon" loading="lazy" onerror="this.style.display='none'" alt="${esc(iName)}${qLabel} x${it.qty}">
                    ${qtyBadge}
                </div>`;
            }).join('');
            iconStripHtml += diedDivider + diedIcons;
        }

        // F2: Build a lookup of item IDs that have been sold recently (after this session's last event).
        // If a sale post-dates a pickup, the pickup LIKELY fed that sale (not guaranteed — could be
        // another copy — so UI labels it as "sold recently" not "this exact one sold").
        const soldItemIds = new Set();
        const recentSales = window._recentSales || [];
        if (recentSales.length > 0) {
            const sessionMinTs = Math.min(...data.items.map(ev => +new Date(ev.timestamp)).filter(n => !isNaN(n)));
            for (const sale of recentSales) {
                const saleTs = +new Date(sale.soldAt || sale.sold_at || sale.receivedAt || 0);
                if (!saleTs || saleTs < sessionMinTs) continue;
                const sid = sale.itemId || sale.item_id;
                if (sid) soldItemIds.add(sid);
            }
        }

        // G12: cache the favorites lookup outside the map so it's computed once per player card
        const favs = getAllFavoriteItemIds();

        // A5: identify the highest-value item so we can flag it with a ⭐
        const filteredItems = data.items.filter(ev => passesItemFilter(ev.item_id, filterVal, ev));
        let topValueEv = null;
        let topValueAmount = 0;
        for (const ev of filteredItems) {
            if (ev.item_id === '__DEATH__') continue;
            const pe = priceMap[ev.item_id];
            const tv = pe ? pe.price * (ev.quantity || 1) : 0;
            if (tv > topValueAmount) { topValueAmount = tv; topValueEv = ev; }
        }
        const itemsHtml = filteredItems.map(ev => {
            const iName = getFriendlyName(ev.item_id) || ev.item_id;
            const iconId = ev.item_id || 'T4_BAG';
            const iconUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(iconId)}.png`;
            const iw = ev.weight > 0 ? ev.weight : getItemWeight(ev.item_id) * (ev.quantity || 1);
            const priceEntry = priceMap[ev.item_id];
            const totalVal = priceEntry ? priceEntry.price * (ev.quantity || 1) : 0;
            // G5: friendly-fire detection — same guild looted from a player in the same guild
            const isFriendlyFire = ev.looted_from_guild && ev.looted_by_guild && ev.looted_from_guild === ev.looted_by_guild;
            const ffBadge = isFriendlyFire
                ? ` <span class="ll-ff-badge" data-tip="Friendly fire: same guild looted a guild member's corpse" title="Friendly fire">🤝</span>`
                : '';
            const fromStr = ev.looted_from_name
                ? `<span style="font-size:0.67rem; color:var(--text-muted); margin-left:0.2rem;">from ${esc(ev.looted_from_name)}${ffBadge}</span>`
                : (ffBadge ? `<span style="margin-left:0.2rem;">${ffBadge}</span>` : '');

            // A5: top-value star — only if this row is the priciest AND the value is meaningful (> 10k)
            const isTopValue = topValueEv === ev && topValueAmount >= 10000;
            const starBadge = isTopValue
                ? ` <span class="ll-top-value-star" data-tip="Top-value item in this card" title="Top value">⭐</span>`
                : '';
            // F2: sale cross-reference — item matches a recent sale notification
            const wasSold = soldItemIds.has(ev.item_id);
            const soldBadge = wasSold
                ? ` <span class="ll-sold-badge" data-tip="Matching item sold recently (check Loot Buyer recent sales)" title="Sold recently">💰</span>`
                : '';
            // G12: favorite item badge
            const isFavorite = favs.has(ev.item_id);
            const favBadge = isFavorite
                ? ` <span class="ll-fav-badge" data-tip="In your favorites list" title="Favorite">📌</span>`
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
            if (isTopValue) rowClass += ' ll-item-top-value';
            if (isFriendlyFire) rowClass += ' ll-item-ff';

            const unitVal = priceEntry && priceEntry.price > 0 ? Math.floor(priceEntry.price) : '';
            const valAttr = unitVal ? ` data-tip-value="${unitVal}"` : '';
            return `<div class="ll-item-row ll-item-clickable ${rowClass}" onclick="event.stopPropagation(); switchToBrowser('${esc(iconId)}')" title="View in Market Browser" data-tip-item="${esc(iconId)}" data-tip-source="loot"${valAttr}>
                <img src="${iconUrl}" class="ll-item-icon" loading="lazy" onerror="this.style.display='none'" alt="">
                <span class="ll-item-name">${esc(iName)}${starBadge}${favBadge}${soldBadge}${fromStr}</span>
                <span class="ll-item-qty">&times;${ev.quantity || 1}</span>
                <span class="ll-item-value">${totalVal > 0 ? formatSilver(totalVal) : '—'}</span>
                <span class="ll-item-weight">${iw > 0 ? iw.toFixed(1) + ' kg' : ''}</span>
                <span class="ll-item-status-dot ${dotClass}"></span>
            </div>`;
        }).join('');

        // "Died with" rows inside the expanded card — same data as the preview
        // strip, but as full item rows so users can see names / qty / value.
        // Styled with the existing `ll-item-died` class (red left border + dim)
        // and prefixed by a small section header so it reads as a separate block
        // below the normal pickups.
        let diedWithRowsHtml = '';
        if (diedWith && diedWith.items.size > 0) {
            const diedItems = [...diedWith.items.values()].sort((a, b) => {
                // Sort by value desc, then qty desc — matches the visual weight of the preview strip
                const pA = priceMap[a.itemId];
                const pB = priceMap[b.itemId];
                const vA = (pA && pA.price > 0 ? pA.price : 0) * a.qty;
                const vB = (pB && pB.price > 0 ? pB.price : 0) * b.qty;
                if (vB !== vA) return vB - vA;
                return b.qty - a.qty;
            });
            const deathCount = diedWith.deaths.length;
            const latest = diedWith.deaths.reduce((a, b) => (a.ts > b.ts ? a : b), diedWith.deaths[0]);
            const whenStr = latest && latest.ts ? new Date(latest.ts).toLocaleTimeString() : 'unknown time';
            const whereStr = latest && latest.location ? ` in ${latest.location}` : '';
            const killerStr = latest && latest.killer ? ` — killed by ${latest.killer}` : '';
            const inferredNote = latest && latest.inferred ? ' <span style="color:var(--text-muted); font-weight:400;" title="Death reconstructed from loot evidence — no __DEATH__ row in upload">(inferred)</span>' : '';
            const countPrefix = deathCount > 1 ? `Died ${deathCount}× — last at ${whenStr}` : `Died at ${whenStr}`;
            const headerTitle = `${countPrefix}${whereStr}${killerStr}`;
            const rows = diedItems.map(it => {
                const iName = getFriendlyName(it.itemId) || it.itemId;
                const iconUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(it.itemId)}.png?quality=${it.quality}`;
                const pe = priceMap[it.itemId];
                const totalVal = pe && pe.price > 0 ? pe.price * it.qty : 0;
                const iw = getItemWeight(it.itemId) * it.qty;
                const titleAttr = `${iName}${it.quality > 1 ? ` q${it.quality}` : ''} × ${it.qty} — ${headerTitle}`;
                return `<div class="ll-item-row ll-item-clickable ll-item-died" onclick="event.stopPropagation(); switchToBrowser('${esc(it.itemId)}')" title="${esc(titleAttr)}">
                    <img src="${iconUrl}" class="ll-item-icon" loading="lazy" onerror="this.style.display='none'" alt="">
                    <span class="ll-item-name">${esc(iName)}</span>
                    <span class="ll-item-qty">&times;${it.qty}</span>
                    <span class="ll-item-value">${totalVal > 0 ? formatSilver(totalVal) : '—'}</span>
                    <span class="ll-item-weight">${iw > 0 ? iw.toFixed(1) + ' kg' : ''}</span>
                    <span class="ll-item-status-dot ll-dot-died"></span>
                </div>`;
            }).join('');
            diedWithRowsHtml = `
                <div class="ll-died-with-section">
                    <div class="ll-died-with-header" title="${esc(headerTitle)}">
                        💀 Died with (${diedItems.length} item${diedItems.length !== 1 ? 's' : ''})${inferredNote}
                        <span class="ll-died-with-subtitle">${esc(headerTitle)}</span>
                    </div>
                    ${rows}
                </div>`;
        }

        // Card class + role tag: enemy (red), friendly with known guild (green), unknown (grey)
        let cardClass = 'll-player-card';
        let roleTag;
        if (data.isEnemy) {
            cardClass += ' ll-card-enemy';
            roleTag = '<span style="font-size:0.6rem; padding:0.1rem 0.35rem; background:rgba(239,68,68,0.2); color:var(--loss-red); border-radius:8px; margin-left:0.3rem;">Enemy Loot</span>';
        } else if (data.guild) {
            cardClass += ' ll-card-friendly';
            roleTag = '<span style="font-size:0.6rem; padding:0.1rem 0.35rem; background:rgba(34,197,94,0.2); color:var(--profit-green); border-radius:8px; margin-left:0.3rem;">Guild</span>';
        } else {
            cardClass += ' ll-card-unknown';
            roleTag = '<span style="font-size:0.6rem; padding:0.1rem 0.35rem; background:rgba(160,160,184,0.18); color:var(--text-muted); border-radius:8px; margin-left:0.3rem;">Unknown</span>';
        }

        // G6: per-player trend line (only shown if we have data for this name)
        const trend = _llPlayerTrends[name];
        let trendLine = '';
        if (trend && trend.sessionCount > 1) {
            const parts = [];
            parts.push(`${trend.sessionCount} session${trend.sessionCount !== 1 ? 's' : ''}`);
            if (trend.itemsTotal > 0) parts.push(`${trend.itemsTotal.toLocaleString()} items lifetime`);
            if (trend.deaths > 0) parts.push(`💀 ${trend.deaths}`);
            if (trend.lastSeen) {
                const days = Math.floor((Date.now() - trend.lastSeen) / 86400000);
                if (days >= 1) parts.push(`last seen ${days}d ago`);
            }
            trendLine = `<div class="ll-player-trend" title="Aggregated across all of your saved loot sessions">📊 ${parts.join(' · ')}</div>`;
        }

        return guildHeader + `<div class="${cardClass}">
            <div class="ll-player-header" onclick="this.closest('.ll-player-card').classList.toggle('expanded')">
                <button class="ll-remove-player" onclick="event.stopPropagation();_llRemovedPlayers.add('${esc(name)}');_llRenderFiltered()" title="Remove player from view" aria-label="Remove ${esc(name)} from view">&times;</button>
                <div class="ll-player-info">
                    <span class="ll-player-name">${esc(name)}</span>
                    ${data.died ? '<span title="Died during session" style="color:var(--loss-red); margin-left:0.3rem;">💀</span>' : ''}
                    ${data.gotKills ? '<span title="Got kills during session" style="color:var(--profit-green); margin-left:0.2rem;">⚔️</span>' : ''}
                    ${roleTag}
                    ${data.guild ? `<span class="ll-player-guild" style="color:${guildColorMap[data.guild]}">[${esc(data.guild)}]</span>` : ''}
                    ${trendLine}
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
            <div class="ll-player-items">${itemsHtml}${diedWithRowsHtml}</div>
        </div>`;
    }).join('');

    // Close trailing guild wrapper (if grouping was active and at least one was opened)
    if (_llGroupByGuild && _llLastGuildEmitted !== null) {
        html += '</div></details>';
    }

    if (entries.length === 0 && searchVal) {
        html += '<div class="empty-state"><p>No players match your search.</p></div>';
    }

    // E5: "Show more" button for large sessions
    if (hiddenCount > 0) {
        html += `<div style="text-align:center; padding:0.75rem;">
            <button class="btn-small-accent" onclick="window._llShowAllCards=true;_llRenderFiltered();">Show ${hiddenCount} more player${hiddenCount !== 1 ? 's' : ''}</button>
        </div>`;
    }

    // Preserve scroll so filter changes don't snap the viewport back up to
    // the Deaths section above. Capture scrollY + the currently-focused filter
    // control before replacing DOM, then restore both after.
    const _llPreScrollY = window.scrollY;
    const _llActiveFocusId = document.activeElement ? document.activeElement.id : null;
    const _llActiveSelStart = (document.activeElement && typeof document.activeElement.selectionStart === 'number')
        ? document.activeElement.selectionStart : null;

    detail.innerHTML = html;

    // Restore scroll position first (before focus so layout doesn't jump).
    window.scrollTo(0, _llPreScrollY);

    // Restore focus + cursor on the filter control the user was interacting with
    if (_llActiveFocusId) {
        const el = document.getElementById(_llActiveFocusId);
        if (el) {
            el.focus({ preventScroll: true });
            if (_llActiveSelStart !== null && typeof el.setSelectionRange === 'function') {
                try { el.setSelectionRange(_llActiveSelStart, _llActiveSelStart); } catch {}
            }
        }
    } else {
        // Fallback: restore search focus + cursor if there's a search term
        const newSearch = document.getElementById('ll-search');
        if (newSearch && searchVal) {
            newSearch.focus({ preventScroll: true });
            newSearch.setSelectionRange(searchVal.length, searchVal.length);
        }
    }
}

// Parse loot lines from text content
function parseLootLines(text) {
    const allLines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('timestamp'));
    const events = [];
    for (const line of allLines) {
        const parts = line.split(';');
        if (parts.length < 10) continue;
        const [ts, byAlliance, byGuild, byName, itemId, , qty, fromAlliance, fromGuild, fromName] = parts;
        events.push({
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
    return { events, lines: allLines };
}

// Handle .txt file upload (supports multiple files)
async function handleLootFileUpload(input) {
    const files = Array.from(input.files);
    if (!files.length) return;
    await processLootFiles(files);
    input.value = '';
}

// Handle drag-and-drop file upload
async function handleLootFileDrop(event) {
    const files = Array.from(event.dataTransfer.files).filter(f => f.name.endsWith('.txt'));
    if (!files.length) { showToast('Please drop .txt files', 'warning'); return; }
    await processLootFiles(files);
}

async function processLootFiles(files) {
    const status = document.getElementById('loot-log-file-status');
    const resultEl = document.getElementById('loot-upload-result');
    const clearBtn = document.getElementById('ll-upload-clear-btn');
    status.textContent = `Reading ${files.length} file${files.length > 1 ? 's' : ''}…`;

    let allParsed = [];
    let allLines = [];
    const fileNames = [];
    for (const file of files) {
        const text = await file.text();
        const { events, lines } = parseLootLines(text);
        allParsed.push(...events);
        allLines.push(...lines);
        fileNames.push(file.name);
    }
    // Sort merged events by timestamp
    allParsed.sort((a, b) => a.timestamp - b.timestamp);

    status.textContent = `${allParsed.length} events from ${fileNames.join(', ')}`;
    if (clearBtn) clearBtn.style.display = '';
    _llRemovedPlayers.clear();
    await renderLootSessionEvents(allParsed, resultEl);

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
            // Remember the just-uploaded session_id so the Accountability dropdown can
            // highlight it and auto-select when the user switches to that tab.
            if (data.sessionId || data.session_id) {
                const sid = data.sessionId || data.session_id;
                window._justUploadedSessionId = sid;
                window._justUploadedAt = Date.now();
                // Auto-stamp the session name to the first file uploaded (user can rename later).
                if (typeof setSavedSessionName === 'function' && fileNames.length > 0) {
                    setSavedSessionName(sid, fileNames[0].replace(/\.txt$/i, ''));
                }
                // Report row was rendered before upload completed, so _llCurrentSessionId was
                // null and the Share/Accountability buttons weren't emitted. Populate the
                // placeholder slot now that we know the session_id — also cross-link to the
                // Accountability action so the user can verify against chest logs in one click.
                _llCurrentSessionId = sid;
                const slot = document.getElementById('ll-report-share-slot');
                if (slot) {
                    const safeSid = esc(sid);
                    slot.outerHTML = `<button class="btn-small-accent" onclick="openShareSessionModal('${safeSid}', null)" title="Generate a public link — anyone with it can view this session">🔗 Share</button>
                        <button class="btn-small-accent" onclick="runAccountabilityForSession('${safeSid}')" title="Cross-reference this session against chest deposits">✓ Accountability</button>`;
                }
            }
        }
    } catch { /* silent — viewing works without login */ }
}

// === ACCOUNTABILITY CHECK ===

function populateAccountabilityDropdowns() {
    // Shared-accountability viewer commandeers the dropdowns with a synthetic session +
    // pre-selected captures; don't overwrite them when the user's own session list loads.
    if (window._sharedAccountabilityActive) return;
    const sessionSel = document.getElementById('acc-session-select');
    const captureSel = document.getElementById('acc-capture-select');
    if (!sessionSel || !captureSel) return;

    fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
            const sessions = (data.sessions || []);
            // Already ORDER BY started_at DESC server-side, but sort defensively so newest is on top.
            sessions.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));

            // Detect likely duplicate uploads of the same file: identical (started_at minute,
            // event_count, player_count, total_weight) tuple is almost certainly the same data.
            // We keep all rows but flag the later ones as duplicates so the user can clean up.
            const fingerprintSeen = new Map(); // fingerprint → earliest session_id
            for (const s of sessions) {
                const fp = `${Math.floor((s.started_at || 0) / 60000)}_${s.event_count}_${s.player_count}_${Math.round(s.total_weight || 0)}`;
                if (!fingerprintSeen.has(fp)) fingerprintSeen.set(fp, s.session_id);
            }

            const savedNames = typeof getSavedSessionNames === 'function' ? getSavedSessionNames() : {};
            const justUploaded = window._justUploadedSessionId;
            const recentUpload = window._justUploadedAt && (Date.now() - window._justUploadedAt < 3 * 60000);

            // Uploaded sessions use session_id = "<userId>_upload_<uploadMs>". The events they
            // contain carry their original (in-game) timestamps, so grouping/labeling by
            // MIN(event.timestamp) showed things like "7 days ago" for a file uploaded 2 min
            // ago. Detect the upload pattern and use the upload timestamp for grouping + label.
            const parseUploadTs = (sid) => {
                if (!sid || typeof sid !== 'string') return 0;
                const m = sid.match(/_upload_(\d{10,})$/);
                return m ? parseInt(m[1], 10) : 0;
            };
            const recentUploadWindow = 24 * 60 * 60 * 1000; // 24h — survives a browser refresh

            let opts = '<option value="">-- Select session --</option>';
            if (liveLootEvents.length > 0) opts += `<option value="__live__">🔴 LIVE — ${liveLootEvents.length} events</option>`;

            const now = Date.now();
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const todayMs = todayStart.getTime();
            const yesterdayMs = todayMs - 86400000;
            const weekMs = todayMs - 6 * 86400000;

            const groupJust = [], groupToday = [], groupYesterday = [], groupWeek = [], groupOlder = [], groupDups = [];
            for (const s of sessions) {
                const fp = `${Math.floor((s.started_at || 0) / 60000)}_${s.event_count}_${s.player_count}_${Math.round(s.total_weight || 0)}`;
                const isFirstOfFingerprint = fingerprintSeen.get(fp) === s.session_id;
                const isDup = !isFirstOfFingerprint;
                const uploadTs = parseUploadTs(s.session_id);
                s._uploadTs = uploadTs;
                const isNewlyUploaded = s.session_id === justUploaded && recentUpload;
                const isRecentUpload = uploadTs > 0 && (now - uploadTs < recentUploadWindow);
                if (isNewlyUploaded || isRecentUpload) { groupJust.push(s); continue; }
                if (isDup) { groupDups.push(s); continue; }
                // For uploaded sessions older than 24h, group by upload time (not event time)
                // so "Yesterday" means "uploaded yesterday" — the dropdown is the user's session
                // history, not an in-game combat timeline.
                const ts = uploadTs > 0 ? uploadTs : (s.started_at || 0);
                if (ts >= todayMs) groupToday.push(s);
                else if (ts >= yesterdayMs) groupYesterday.push(s);
                else if (ts >= weekMs) groupWeek.push(s);
                else groupOlder.push(s);
            }

            const renderOpt = (s) => {
                const customName = savedNames[s.session_id];
                // <option> content is plain text — use _computeTimeAgo(), NOT timeAgo()
                // (which wraps in a <span class="time-ago"> for live-updating bodies and would
                // show as literal "<span...>" text inside a dropdown).
                let label;
                if (customName) {
                    label = `"${customName}"`;
                } else if (s._uploadTs > 0) {
                    const uploadedRel = _computeTimeAgo(new Date(s._uploadTs).toISOString());
                    const eventRel = _computeTimeAgo(new Date(s.started_at).toISOString());
                    const showEventTime = Math.abs(s._uploadTs - s.started_at) > 60 * 60 * 1000;
                    label = showEventTime
                        ? `📤 Uploaded ${uploadedRel} · events from ${eventRel}`
                        : `📤 Uploaded ${uploadedRel}`;
                } else {
                    label = _computeTimeAgo(new Date(s.started_at).toISOString());
                }
                return `<option value="${esc(s.session_id)}">${esc(label)} — ${s.event_count} events · ${s.player_count} players</option>`;
            };

            if (groupJust.length > 0) {
                opts += `<optgroup label="🆕 Recently uploaded">`;
                groupJust.forEach(s => opts += renderOpt(s));
                opts += `</optgroup>`;
            }
            if (groupToday.length > 0) {
                opts += `<optgroup label="📅 Today">`;
                groupToday.forEach(s => opts += renderOpt(s));
                opts += `</optgroup>`;
            }
            if (groupYesterday.length > 0) {
                opts += `<optgroup label="Yesterday">`;
                groupYesterday.forEach(s => opts += renderOpt(s));
                opts += `</optgroup>`;
            }
            if (groupWeek.length > 0) {
                opts += `<optgroup label="This week">`;
                groupWeek.forEach(s => opts += renderOpt(s));
                opts += `</optgroup>`;
            }
            if (groupOlder.length > 0) {
                opts += `<optgroup label="Older">`;
                groupOlder.forEach(s => opts += renderOpt(s));
                opts += `</optgroup>`;
            }
            if (groupDups.length > 0) {
                opts += `<optgroup label="⚠ Possible duplicates (${groupDups.length})">`;
                groupDups.forEach(s => opts += renderOpt(s));
                opts += `</optgroup>`;
            }

            sessionSel.innerHTML = opts;

            // Auto-select the newly-uploaded session if present
            if (justUploaded && recentUpload) {
                sessionSel.value = justUploaded;
                // Visual cue: flash the select briefly
                sessionSel.style.boxShadow = '0 0 0 2px var(--accent)';
                setTimeout(() => { sessionSel.style.boxShadow = ''; }, 2500);
            }

            // Show a hint bar above the dropdowns if there are duplicates.
            let dupBar = document.getElementById('acc-dup-bar');
            if (groupDups.length > 0) {
                if (!dupBar) {
                    dupBar = document.createElement('div');
                    dupBar.id = 'acc-dup-bar';
                    dupBar.style.cssText = 'background:rgba(251,191,36,0.10); border:1px solid rgba(251,191,36,0.35); border-radius:6px; padding:0.45rem 0.7rem; margin-bottom:0.5rem; font-size:0.78rem; color:var(--text-secondary); display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;';
                    sessionSel.parentElement?.parentElement?.prepend(dupBar);
                }
                dupBar.innerHTML = `⚠ Detected <strong>${groupDups.length}</strong> likely duplicate session${groupDups.length > 1 ? 's' : ''} (same timestamp, event count, player count). <button class="btn-small" style="padding:0.15rem 0.5rem; font-size:0.7rem;" onclick="_accDeleteDuplicates()">🗑 Clean up duplicates</button>`;
            } else if (dupBar) {
                dupBar.remove();
            }
        }).catch(() => {});

    // E2: lootBuyerCaptures IS window._chestCaptures — no seeding needed
    const captures = window._chestCaptures;
    if (captures.length === 0) {
        captureSel.innerHTML = '<option value="" disabled>No captures yet — open a chest with the client running</option>';
    } else {
        // Sort by capture time desc so newest is on top.
        const indexed = captures.map((c, i) => ({ c, i }));
        indexed.sort((a, b) => {
            const ta = typeof a.c.capturedAt === 'number' ? a.c.capturedAt : (a.c.capturedAt ? new Date(a.c.capturedAt).getTime() : 0);
            const tb = typeof b.c.capturedAt === 'number' ? b.c.capturedAt : (b.c.capturedAt ? new Date(b.c.capturedAt).getTime() : 0);
            return tb - ta;
        });
        captureSel.innerHTML = indexed.map(({ c: cap, i }) => {
            const name = cap.tabName || `Capture ${i + 1}`;
            const count = cap.items ? cap.items.length : 0;
            const tw = cap.items ? cap.items.reduce((s, it) => s + getItemWeight(it.itemId) * (it.quantity || 1), 0) : 0;
            const weightStr = tw > 0 ? ` · ${tw.toFixed(1)} kg` : '';
            // Timestamp: show relative (e.g. "5m ago") + absolute HH:MM local time
            const capturedMs = typeof cap.capturedAt === 'number' ? cap.capturedAt : (cap.capturedAt ? new Date(cap.capturedAt).getTime() : 0);
            let timeStr = '';
            if (capturedMs > 0) {
                const iso = new Date(capturedMs).toISOString();
                // Plain-text variant for <option> content — timeAgo() returns an HTML <span>.
                const rel = _computeTimeAgo(iso);
                const abs = new Date(capturedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                timeStr = ` · ${rel} (${abs})`;
            } else {
                timeStr = ' · time unknown';
            }
            return `<option value="${i}">${esc(name)} — ${count} items${weightStr}${timeStr}</option>`;
        }).join('');
    }

    // Populate the chest-log selector (optional verification input).
    //
    // UX: the game streams each chest-log viewing as TWO separate batches
    // (deposits page + withdrawals page), so users naturally expect to see
    // both entries. We auto-select ALL batches by default until the user
    // manually interacts with the select — most users just click Merge &
    // Verify, so "select all the things" is the right default. Once a user
    // deselects something manually, we preserve their intent across
    // subsequent populates (when new batches arrive).
    const chestLogSel = document.getElementById('acc-chestlog-select');
    if (chestLogSel) {
        const batches = window._chestLogBatches || [];
        // One-time hook so we track when the user has manually changed the
        // selection. From that point on we preserve their choices instead
        // of blindly re-selecting-all.
        if (!chestLogSel._interactionHookAttached) {
            chestLogSel.addEventListener('change', () => {
                chestLogSel.dataset.userInteracted = 'yes';
            });
            chestLogSel._interactionHookAttached = true;
        }
        const userInteracted = chestLogSel.dataset.userInteracted === 'yes';
        const priorSelected = new Set(
            Array.from(chestLogSel.selectedOptions).map(o => o.value).filter(v => v !== '')
        );
        if (batches.length === 0) {
            chestLogSel.innerHTML = '<option value="" disabled>No chest log captures yet — open a chest Log tab in-game (each viewing produces a deposit + withdraw capture)</option>';
        } else {
            chestLogSel.innerHTML = batches.map((b, i) => {
                const capturedMs = typeof b.capturedAt === 'number' ? b.capturedAt : (b.capturedAt ? new Date(b.capturedAt).getTime() : 0);
                // Plain-text variant for <option> content — timeAgo() returns an HTML <span>.
                const rel = capturedMs > 0 ? _computeTimeAgo(new Date(capturedMs).toISOString()) : 'unknown';
                const abs = capturedMs > 0 ? new Date(capturedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                const action = b.action || 'unknown';
                const icon = action === 'deposit' ? '📥' : action === 'withdraw' ? '📤' : '❔';
                const count = (b.entries || []).length;
                // Before user interacts: auto-select everything.
                // After they manually click: preserve prior selection (only).
                const shouldSelect = userInteracted ? priorSelected.has(String(i)) : true;
                return `<option value="${i}"${shouldSelect ? ' selected' : ''}>${icon} ${esc(action)} — ${count} entries · ${rel}${abs ? ' (' + abs + ')' : ''}</option>`;
            }).join('');
        }
    }
}

// Re-run the last accountability check. Useful when people deposit loot a bit later
// and the user wants to check again without re-selecting the dropdowns.
// Merge & Verify — sugar wrapper over runAccountabilityCheck that ensures at
// least one chest log batch is selected (auto-selects all of them if the user
// forgot). The verification logic inside runAccountabilityCheck keys off the
// #acc-chestlog-select element's selected options.
async function runAccountabilityCheckWithMerge() {
    const chestLogSel = document.getElementById('acc-chestlog-select');
    const batches = window._chestLogBatches || [];
    if (!chestLogSel || batches.length === 0) {
        showToast('No chest log captures yet — open a chest Log tab in-game first', 'warning');
        return;
    }
    const anySelected = Array.from(chestLogSel.selectedOptions).some(o => o.value !== '');
    if (!anySelected) {
        for (const opt of chestLogSel.options) {
            if (opt.value !== '') opt.selected = true;
        }
        showToast(`Auto-selected all ${batches.length} chest log capture${batches.length !== 1 ? 's' : ''}`, 'info');
    }
    runAccountabilityCheck();
}

async function rerunAccountabilityCheck() {
    const sessionSel = document.getElementById('acc-session-select');
    const captureSel = document.getElementById('acc-capture-select');
    if (!sessionSel || !captureSel) return;
    if (!sessionSel.value) { showToast('Select a session first', 'warn'); return; }
    const anySelected = Array.from(captureSel.selectedOptions).some(o => o.value !== '');
    if (!anySelected) { showToast('Select at least one chest capture first', 'warn'); return; }
    // Refresh the dropdown so the timestamps update.
    populateAccountabilityDropdowns();
    // Brief pause to let DOM update the dropdown (selection may shift).
    await new Promise(r => setTimeout(r, 150));
    // Run the check. updateLastRunLabel will fire below.
    runAccountabilityCheck();
    const label = document.getElementById('acc-last-run');
    if (label) label.textContent = `Last re-run: ${new Date().toLocaleTimeString()}`;
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

// Cross-link from Accountability -> Loot Buyer with missing items pre-loaded.
// Opens Loot Buyer, fills the manual-entry list with aggregated missing items,
// and kicks off the worth analysis so current market values show immediately.
function valueMissingItemsInLootBuyer() {
    const missing = window._llSuspectMissingItems || {};
    const entries = Object.entries(missing);
    if (entries.length === 0) { showToast('No missing items to value', 'warn'); return; }
    // Switch to Loot Buyer tab
    document.querySelector('[data-tab="loot-buyer"]')?.click();
    // Populate manual items (quality=1 as we don't know the original quality from accountability)
    lootManualItems = entries.map(([itemId, qty]) => ({
        itemId,
        quality: 1,
        quantity: qty,
        isEquipment: false
    }));
    renderLootManualItems();
    // Expose in the Phase 1 worth-analysis view
    lootSelectedCapture = {
        items: lootManualItems.map(it => ({ ...it })),
        tabName: 'Missing from accountability',
        capturedAt: new Date().toISOString(),
        isManual: true
    };
    selectLootCaptureUI('Missing from accountability', lootSelectedCapture.items);
    showToast(`Loaded ${entries.length} missing item type${entries.length !== 1 ? 's' : ''} — set an asking price of 0 to see just the market values`, 'info');
}

// Cross-link from Loot Logger session view -> Accountability tab with session pre-selected.
// If the session dropdown hasn't been populated yet, populate it first.
// Delete all sessions flagged as possible duplicates (not the earliest of each fingerprint).
// Uses the existing DELETE /api/loot-session/:id endpoint (one call per duplicate).
async function _accDeleteDuplicates() {
    // Re-pull the current sessions list so we act on fresh data.
    let sessions;
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders() });
        const data = await res.json();
        sessions = (data.sessions || []).sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
    } catch {
        showToast('Failed to refresh sessions', 'error');
        return;
    }
    // Group by fingerprint, keep the earliest session_id (first-seen) in each group.
    const fpMap = new Map();
    for (const s of sessions) {
        const fp = `${Math.floor((s.started_at || 0) / 60000)}_${s.event_count}_${s.player_count}_${Math.round(s.total_weight || 0)}`;
        if (!fpMap.has(fp)) fpMap.set(fp, []);
        fpMap.get(fp).push(s);
    }
    const toDelete = [];
    for (const [fp, group] of fpMap) {
        if (group.length > 1) {
            // Keep the one with the lowest session_id (stable) or first-inserted — using started_at ASC means oldest first
            group.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
            // All except the earliest are duplicates
            for (let i = 1; i < group.length; i++) toDelete.push(group[i]);
        }
    }
    if (toDelete.length === 0) { showToast('No duplicates found', 'info'); return; }
    showConfirm(`Delete ${toDelete.length} duplicate session${toDelete.length > 1 ? 's' : ''}? (Kept the earliest of each group.)`, async () => {
        let ok = 0, fail = 0;
        for (const s of toDelete) {
            try {
                const r = await fetch(`${VPS_BASE}/api/loot-session/${encodeURIComponent(s.session_id)}`, {
                    method: 'DELETE',
                    headers: authHeaders(),
                });
                if (r.ok) ok++; else fail++;
            } catch { fail++; }
        }
        showToast(`Deleted ${ok} duplicate${ok !== 1 ? 's' : ''}${fail > 0 ? ` (${fail} failed)` : ''}`, ok > 0 ? 'success' : 'warn');
        populateAccountabilityDropdowns();
        if (typeof loadLootSessions === 'function') loadLootSessions();
    });
}

// Create a public share link for the current accountability check.
// Snapshots the session + selected chest captures to the backend so viewers
// can render the breakdown without needing access to live capture data.
async function shareAccountability(sessionId) {
    const captureSel = document.getElementById('acc-capture-select');
    const selectedIdxs = Array.from(captureSel.selectedOptions).map(o => parseInt(o.value)).filter(v => !isNaN(v));
    if (!sessionId) { showToast('No session selected', 'warn'); return; }
    if (selectedIdxs.length === 0) { showToast('Select at least one chest capture first', 'warn'); return; }
    const captures = window._chestCaptures || [];
    const selectedCaptures = selectedIdxs.map(i => captures[i]).filter(Boolean);
    if (selectedCaptures.length === 0) { showToast('Selected captures no longer available', 'warn'); return; }
    // Snapshot the chest-log batches the user has selected for verification
    // (opcode 157 deposit/withdraw ground truth). Without this the shared view
    // renders the accountability check with zero deposits and no "verified"
    // badges. If the user hasn't touched the chestlog dropdown we include ALL
    // loaded batches so the recipient sees the same verification result.
    const chestLogSel = document.getElementById('acc-chestlog-select');
    const allBatches = window._chestLogBatches || [];
    let batchesForShare = [];
    if (chestLogSel) {
        const selBatchIdxs = Array.from(chestLogSel.selectedOptions)
            .map(o => parseInt(o.value)).filter(v => !isNaN(v));
        batchesForShare = selBatchIdxs.length > 0
            ? selBatchIdxs.map(i => allBatches[i]).filter(Boolean)
            : allBatches; // fall back to all loaded batches
    } else {
        batchesForShare = allBatches;
    }
    // Get the session name from saved names if available.
    let sessionName = '';
    try {
        const savedNames = typeof getSavedSessionNames === 'function' ? getSavedSessionNames() : {};
        sessionName = savedNames[sessionId] || '';
    } catch {}
    try {
        const res = await fetch(`${VPS_BASE}/api/accountability/share`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ sessionId, captures: selectedCaptures, sessionName, chestLogs: batchesForShare })
        });
        const data = await res.json();
        if (!res.ok) { showToast('Share failed: ' + (data.error || res.status), 'error'); return; }
        const fullUrl = `${window.location.origin}${window.location.pathname}?accShare=${encodeURIComponent(data.token)}`;
        // Open the existing copy-preview modal if present, else show a toast with the link.
        if (typeof openCopyPreview === 'function') {
            openCopyPreview('Accountability share link', fullUrl, 'Link copied — share with anyone');
        } else {
            navigator.clipboard.writeText(fullUrl);
            showToast(`Link copied to clipboard: ${fullUrl}`, 'success');
        }
    } catch (e) {
        showToast('Share failed: ' + e.message, 'error');
    }
}

// Apply the Accountability result filter controls (search, guild, player).
// Works by toggling .ll-hidden-by-filter on each .ll-player-card based on dataset attrs.
function _accApplyFilter() {
    const search = (document.getElementById('acc-result-search')?.value || '').toLowerCase().trim();
    const guild = (document.getElementById('acc-result-guild')?.value || '').toLowerCase();
    const player = (document.getElementById('acc-result-player')?.value || '').toLowerCase();
    const cards = document.querySelectorAll('#accountability-result .ll-player-card');
    let visible = 0;
    cards.forEach(c => {
        const n = c.getAttribute('data-player-name') || '';
        const g = c.getAttribute('data-player-guild') || '';
        let show = true;
        if (search) show = show && (n.includes(search) || g.includes(search));
        if (guild) show = show && (g === guild);
        if (player) show = show && (n === player);
        c.style.display = show ? '' : 'none';
        if (show) visible++;
    });
    // Also add a small count badge to the right of the filter bar
    const badge = document.getElementById('acc-result-filter-count');
    if (badge) badge.textContent = `${visible} / ${cards.length}`;
}

// Show accountability results in the same per-player event layout used by the normal session view,
// but with a depositedMap overlaid so items get green/yellow/red dots per their deposit status.
async function _accShowEventView(sessionId) {
    const resultEl = document.getElementById('accountability-result');
    if (!resultEl) return;
    // Pull captures the user selected.
    const captureSel = document.getElementById('acc-capture-select');
    const selectedIdxs = Array.from(captureSel.selectedOptions).map(o => parseInt(o.value)).filter(v => !isNaN(v));
    const captures = window._chestCaptures || [];
    const deposited = {};
    for (const idx of selectedIdxs) {
        const cap = captures[idx];
        if (!cap || !cap.items) continue;
        for (const item of cap.items) deposited[item.itemId] = (deposited[item.itemId] || 0) + (item.quantity || 1);
    }
    // Fetch or use live events.
    let events;
    if (sessionId === '__live__') {
        events = liveLootEvents.map(e => ({
            looted_by_name: e.looted_by_name || e.lootedBy?.name || '',
            looted_by_guild: e.looted_by_guild || e.lootedBy?.guild || '',
            looted_by_alliance: e.looted_by_alliance || e.lootedBy?.alliance || '',
            looted_from_name: e.looted_from_name || e.lootedFrom?.name || '',
            item_id: e.item_id || e.itemId || '',
            quantity: e.quantity || 1,
            timestamp: e.timestamp,
            weight: e.weight || 0
        }));
    } else {
        try {
            const res = await fetch(`${VPS_BASE}/api/loot-session/${encodeURIComponent(sessionId)}`, { headers: authHeaders() });
            const data = await res.json();
            events = data.events || [];
        } catch {
            showToast('Failed to reload session for event view', 'error');
            return;
        }
    }
    // Swap the accountability result view into an event-style layout.
    // Prepend a "Back to accountability table" button so users can return.
    resultEl.innerHTML = `<button class="btn-small" style="margin-bottom:0.5rem;" onclick="runAccountabilityCheck()">← Back to accountability table</button>
        <div id="acc-event-view"></div>`;
    const target = document.getElementById('acc-event-view');
    await renderLootSessionEvents(events, target, deposited);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function runAccountabilityForSession(sessionId) {
    showLootLoggerMode('accountability');
    // Ensure dropdown has the session as an option, then select it
    const sel = document.getElementById('acc-session-select');
    if (sel) {
        // Wait for populateAccountabilityDropdowns to finish if we just triggered it
        await new Promise(r => setTimeout(r, 250));
        const has = Array.from(sel.options).some(o => o.value === sessionId);
        if (!has) {
            // Force re-populate (may have failed if not authed, but try)
            await populateAccountabilityDropdowns();
        }
        sel.value = sessionId;
        // Scroll into view so the user sees they're in the right mode
        sel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showToast('Session pre-selected. Choose chest captures and click "Run Check".', 'info');
    }
}

async function runAccountabilityCheck() {
    const sessionId = document.getElementById('acc-session-select').value;
    const captureSel = document.getElementById('acc-capture-select');
    const selectedIdxs = Array.from(captureSel.selectedOptions).map(o => parseInt(o.value)).filter(v => !isNaN(v));
    const resultEl = document.getElementById('accountability-result');

    if (!sessionId) { showToast('Select a loot session first', 'warning'); return; }
    if (selectedIdxs.length === 0) { showToast('Select at least one chest capture', 'warning'); return; }

    // Make sure NUMERIC_ITEM_MAP / ITEM_NAMES are loaded BEFORE we try to normalize
    // UNKNOWN_<n> item IDs below — otherwise the lookup is a silent no-op and
    // UNKNOWN_* keys get locked into the grouping maps (lootedByPlayer + deposited),
    // producing wrong accountability math. Shared-link loads race this hard:
    // _renderPublicAccountabilityView schedules runAccountabilityCheck 100ms after
    // its own fetch, which can beat loadData's itemmap.json fetch.
    if (!NUMERIC_ITEM_MAP || Object.keys(NUMERIC_ITEM_MAP).length === 0) {
        try { await loadData(); } catch { /* fall through — normalizer will no-op if still empty */ }
    }

    resultEl.innerHTML = '<div class="empty-state"><p>Analyzing…</p></div>';
    const lastRunLabel = document.getElementById('acc-last-run');
    if (lastRunLabel) lastRunLabel.textContent = `Running check at ${new Date().toLocaleTimeString()}…`;

    // Fetch loot events
    let lootEvents;
    if (sessionId === '__live__') {
        lootEvents = liveLootEvents.map(e => ({
            timestamp: e.timestamp || e.ts || 0, // preserved for death-window attribution
            looted_by_name: e.looted_by_name || e.lootedBy?.name || '',
            looted_by_guild: e.looted_by_guild || e.lootedBy?.guild || '',
            looted_by_alliance: e.looted_by_alliance || e.lootedBy?.alliance || '',
            looted_from_name: e.looted_from_name || e.lootedFrom?.name || '',
            looted_from_guild: e.looted_from_guild || e.lootedFrom?.guild || '',
            looted_from_alliance: e.looted_from_alliance || e.lootedFrom?.alliance || '',
            item_id: e.item_id || e.itemId || '',
            numeric_id: e.numeric_id != null ? e.numeric_id : e.numericId,
            quantity: e.quantity || 1
        }));
    } else if (sessionId === '__shared__' && Array.isArray(window._sharedAccountabilityEvents)) {
        // Shared accountability view — events come from /api/accountability/public/:token (in memory).
        // No auth fetch needed; skip straight to the compare logic.
        lootEvents = window._sharedAccountabilityEvents;
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
    // Sanitize: dedupe, drop empty item_ids, drop special internals (SILVER,
    // GOLD, etc.), normalize UNKNOWN_<n> → real IDs. See sanitizeLootEvents.
    lootEvents = sanitizeLootEvents(lootEvents);

    // Compute the session's actual time window from loot events — used to
    // filter chest-log entries to the right date range. In-game chest logs
    // retain up to 4 weeks of history; merging ALL of those into an
    // accountability check would flag every deposit in the last month as
    // "verified" even if it has nothing to do with today's fight.
    const _allTs = (lootEvents || [])
        .map(e => +new Date(e.timestamp))
        .filter(t => t > 0 && Number.isFinite(t));
    const sessionStart = _allTs.length ? Math.min(..._allTs) : 0;
    const sessionEnd = _allTs.length ? Math.max(..._allTs) : 0;
    // Time buffer: 1h before (people often deposit "seeds" before the fight starts)
    // and 24h after (late deposits — loot trickling back from carriers/mail).
    const SESSION_PRE_BUFFER = 60 * 60 * 1000;
    const SESSION_POST_BUFFER = 24 * 60 * 60 * 1000;
    const chestLogWindowStart = sessionStart > 0 ? sessionStart - SESSION_PRE_BUFFER : 0;
    const chestLogWindowEnd = sessionEnd > 0 ? sessionEnd + SESSION_POST_BUFFER : Infinity;

    // Merge selected chest captures into deposit inventory
    const captures = window._chestCaptures || [];
    const deposited = {};
    const selectedTabNames = [];
    for (const idx of selectedIdxs) {
        const cap = captures[idx];
        if (!cap || !cap.items) continue;
        // Re-normalize capture items now that loadData is guaranteed to have
        // finished — share-view injection may have happened before the map loaded.
        normalizeChestCaptureInPlace(cap);
        selectedTabNames.push(cap.tabName || `Tab ${idx + 1}`);
        for (const item of cap.items) {
            deposited[item.itemId] = (deposited[item.itemId] || 0) + (item.quantity || 1);
        }
    }

    // Chest-log cross-check — build { playerName: { itemId: depositedQty } } from
    // selected chest log batches. Ground truth for the verified-on-hover badges.
    //
    // IMPORTANT: in-game chest logs retain ~4 weeks of history. We filter to
    // the session's actual time window (± buffer) so a deposit from 2 weeks
    // ago doesn't get credited toward today's fight's pickups.
    const chestLogSel = document.getElementById('acc-chestlog-select');
    const chestLogIdxs = chestLogSel
        ? Array.from(chestLogSel.selectedOptions).map(o => parseInt(o.value)).filter(v => !isNaN(v))
        : [];
    const chestLogDeposits = {};
    const mergedLogMeta = {
        batches: 0,
        deposits: 0,
        withdrawals: 0,
        depositsInWindow: 0,
        depositsOutOfWindow: 0,
        windowStart: chestLogWindowStart,
        windowEnd: chestLogWindowEnd,
    };
    const _logBatches = window._chestLogBatches || [];
    for (const idx of chestLogIdxs) {
        const b = _logBatches[idx];
        if (!b || !Array.isArray(b.entries)) continue;
        mergedLogMeta.batches++;
        // Only deposits count for verification. Withdrawals tracked for the badge count only.
        if (b.action !== 'deposit') {
            if (b.action === 'withdraw') mergedLogMeta.withdrawals += b.entries.length;
            continue;
        }
        mergedLogMeta.deposits += b.entries.length;
        for (const e of b.entries) {
            if (!e.playerName || !e.itemId) continue;
            // Drop entries outside the session window — e.g. a deposit from
            // last week that happened to be in the chest log's 4-week history.
            const entryTs = +new Date(e.timestamp) || 0;
            if (chestLogWindowStart > 0 && (entryTs < chestLogWindowStart || entryTs > chestLogWindowEnd)) {
                mergedLogMeta.depositsOutOfWindow++;
                continue;
            }
            mergedLogMeta.depositsInWindow++;
            if (!chestLogDeposits[e.playerName]) chestLogDeposits[e.playerName] = {};
            chestLogDeposits[e.playerName][e.itemId] = (chestLogDeposits[e.playerName][e.itemId] || 0) + (e.quantity || 1);
        }
    }
    window._llChestLogMerged = mergedLogMeta;

    // Per-player looted inventory + death tracking.
    //
    // 2026-04-21 rewrite — death attribution now uses PICKUP TIMESTAMPS, not
    // corpse-loot ranges. The old logic only marked items as lost-on-death when
    // another guild member picked them up off the corpse (required being in
    // range of the kill). That undercounted losses whenever the victim died
    // out of range of any tracked looter, or when enemies out of range did the
    // looting. The new logic is simpler AND more accurate: if a player died at
    // time T, every item they picked up BEFORE T is lost (they didn't get to
    // deposit it). Supports multiple deaths per player (items picked up
    // between deaths get attributed to the next death).
    const lootedByPlayer = {};
    const deathVictims = new Set();
    const deathTimesByPlayer = {};  // { name: [sortedTs...] }

    // Pass 1 — collect deaths
    for (const ev of lootEvents) {
        if (ev.item_id === '__DEATH__') {
            const victim = ev.looted_from_name || '';
            if (!victim) continue;
            deathVictims.add(victim);
            const ts = +new Date(ev.timestamp) || 0;
            if (!deathTimesByPlayer[victim]) deathTimesByPlayer[victim] = [];
            deathTimesByPlayer[victim].push(ts);
        }
    }
    for (const n of Object.keys(deathTimesByPlayer)) deathTimesByPlayer[n].sort((a, b) => a - b);

    // Pass 2 — attribute each pickup to "survived" or "lost on death"
    const lostByDeath = {};  // { name: { itemId: qty } } — items the player lost by dying
    const evsByPlayerItem = {};  // { name: { itemId: [{ts, location}] } } — for missing-item tooltip
    for (const ev of lootEvents) {
        if (ev.item_id === '__DEATH__') continue;
        const name = ev.looted_by_name || 'Unknown';
        const evTs = +new Date(ev.timestamp) || 0;
        if (!lootedByPlayer[name]) lootedByPlayer[name] = { guild: ev.looted_by_guild || '', alliance: ev.looted_by_alliance || '', items: {} };
        lootedByPlayer[name].items[ev.item_id] = (lootedByPlayer[name].items[ev.item_id] || 0) + (ev.quantity || 1);
        // Collect per-event timestamp + zone for missing-item tooltip (zone from Go client v1.3.0+)
        if (!evsByPlayerItem[name]) evsByPlayerItem[name] = {};
        if (!evsByPlayerItem[name][ev.item_id]) evsByPlayerItem[name][ev.item_id] = [];
        if (evTs > 0) evsByPlayerItem[name][ev.item_id].push({ ts: evTs, location: ev.location || '' });
        // If this player died at some point AFTER picking this up, it's lost.
        const deaths = deathTimesByPlayer[name];
        if (deaths && evTs > 0 && deaths.some(dTs => dTs > evTs)) {
            if (!lostByDeath[name]) lostByDeath[name] = {};
            lostByDeath[name][ev.item_id] = (lostByDeath[name][ev.item_id] || 0) + (ev.quantity || 1);
        }
    }

    // Detect primary guild and alliance (alliance-aware for multi-guild ZvZ)
    const guildCounts = {};
    const allianceCounts = {};
    for (const [, data] of Object.entries(lootedByPlayer)) {
        if (data.guild) {
            const itemCount = Object.values(data.items).reduce((s, q) => s + q, 0);
            guildCounts[data.guild] = (guildCounts[data.guild] || 0) + itemCount;
        }
        if (data.alliance) {
            const itemCount = Object.values(data.items).reduce((s, q) => s + q, 0);
            allianceCounts[data.alliance] = (allianceCounts[data.alliance] || 0) + itemCount;
        }
    }
    const primaryGuild = Object.entries(guildCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const primaryAlliance = Object.entries(allianceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Proportional deposit allocation — fair regardless of player order
    // Step 1: Sum total looted per item across all guild members
    const totalLootedPerItem = {};
    for (const [name, data] of Object.entries(lootedByPlayer)) {
        const isGuildMember = primaryAlliance && data.alliance
            ? data.alliance === primaryAlliance
            : (!primaryGuild || data.guild === primaryGuild || !data.guild);
        if (!isGuildMember) continue;
        for (const [itemId, qty] of Object.entries(data.items)) {
            const lostQty = lostByDeath[name]?.[itemId] || 0;
            const effective = Math.max(0, qty - lostQty);
            if (effective > 0) totalLootedPerItem[itemId] = (totalLootedPerItem[itemId] || 0) + effective;
        }
    }

    // Cross-reference — proportional matching for guild members
    const playerResults = [];
    for (const [name, data] of Object.entries(lootedByPlayer)) {
        const isGuildMember = primaryAlliance && data.alliance
            ? data.alliance === primaryAlliance
            : (!primaryGuild || data.guild === primaryGuild || !data.guild);
        let totalLooted = 0, totalDeposited = 0;
        const itemResults = [];

        for (const [itemId, qty] of Object.entries(data.items)) {
            // Subtract items this player lost by dying (can't deposit what you lost)
            const lostQty = lostByDeath[name]?.[itemId] || 0;
            const effectiveQty = Math.max(0, qty - lostQty);
            totalLooted += effectiveQty;

            if (isGuildMember && effectiveQty > 0) {
                // Proportional share: player's looted / total looted * deposited
                const totalForItem = totalLootedPerItem[itemId] || 0;
                const depositedForItem = deposited[itemId] || 0;
                const share = totalForItem > 0 ? (effectiveQty / totalForItem) * depositedForItem : 0;
                const inChest = Math.min(effectiveQty, Math.round(share));
                const missing = effectiveQty - inChest;
                totalDeposited += inChest;
                // Chest-log verification: if this player has a deposit record for this item
                // in the selected chest logs, mark the row as ✓ verified — the icon gets a
                // green ring + tooltip explaining the evidence.
                const verifiedQty = chestLogDeposits[name] ? (chestLogDeposits[name][itemId] || 0) : 0;
                const verified = verifiedQty > 0;
                const fullyVerified = verifiedQty >= effectiveQty;
                itemResults.push({
                    itemId, looted: effectiveQty, inChest, missing,
                    verified, verifiedQty, fullyVerified,
                    pickupEvs: evsByPlayerItem[name]?.[itemId] || [],
                });
            } else if (effectiveQty > 0) {
                // Enemy loot source — don't check deposits, just list items
                itemResults.push({ itemId, looted: effectiveQty, inChest: -1, missing: -1 }); // -1 = N/A
            }
            // Show items lost on death separately (red outline, not counted as stolen)
            if (lostQty > 0 && isGuildMember) {
                itemResults.push({ itemId, looted: lostQty, inChest: -2, missing: -2, lostOnDeath: true }); // -2 = lost on death
            }
        }

        if (itemResults.length === 0) continue;
        const pct = isGuildMember && totalLooted > 0 ? Math.round(totalDeposited / totalLooted * 100) : -1;
        playerResults.push({
            name, guild: data.guild, totalLooted, totalDeposited,
            totalMissing: isGuildMember ? totalLooted - totalDeposited : 0,
            pct, items: itemResults, isEnemy: !isGuildMember,
            died: deathVictims.has(name)
        });
    }
    // Add a synthetic "you" row if the logged-in user isn't already in the list.
    // Albion's protocol doesn't broadcast the local player's own pickups, so Coldtouch
    // (or whoever is logged in) would otherwise be missing from the accountability list.
    // The previous version attempted to attribute "unclaimed" chest items (deposited qty
    // exceeding tracked pickups) to the local user — but the user correctly pointed out
    // that unclaimed items can come from any number of untracked sources (castle chests,
    // outpost chests, out-of-range players, vault transfers, items already in the chest
    // from a prior run). So we now show a placeholder row WITHOUT any inferred attribution.
    const selfName = (discordUser?.username || window._userData?.user?.username || '').trim();
    if (selfName) {
        const already = playerResults.some(p => p.name.toLowerCase() === selfName.toLowerCase());
        if (!already) {
            playerResults.push({
                name: selfName,
                guild: primaryGuild || '',
                totalLooted: 0,
                totalDeposited: 0,
                totalMissing: 0,
                pct: -1,
                items: [],
                isEnemy: false,
                died: false,
                isSelfUntracked: true,
                hasInferredItems: false, // explicit false — no auto-attribution
            });
        }
    }

    // Guild members sorted by deposit % (worst first), enemies at the end.
    // isSelfUntracked rows float to the top of guild members (to be visible).
    playerResults.sort((a, b) => {
        if (a.isEnemy !== b.isEnemy) return a.isEnemy ? 1 : -1;
        if (a.isSelfUntracked !== b.isSelfUntracked) return a.isSelfUntracked ? -1 : 1;
        return a.pct - b.pct;
    });

    // Build price map
    const allItemIds = new Set(playerResults.flatMap(p => p.items.map(i => i.itemId)));
    const priceMap = await getLootPriceMap(allItemIds);

    const totalLooted = playerResults.reduce((s, p) => s + p.totalLooted, 0);
    const totalDeposited = playerResults.reduce((s, p) => s + p.totalDeposited, 0);
    const totalMissing = playerResults.reduce((s, p) => s + p.totalMissing, 0);

    // Compute per-player missing silver values
    for (const p of playerResults) {
        p.missingSilver = 0;
        for (const it of p.items) {
            if (it.lostOnDeath || it.inChest < 0) continue;
            const pe = priceMap[it.itemId];
            if (pe && it.missing > 0) p.missingSilver += pe.price * it.missing;
        }
    }
    const totalMissingSilver = playerResults.reduce((s, p) => s + p.missingSilver, 0);
    // Suspects: guild members with <80% deposit rate and missing items
    const suspects = playerResults.filter(p => !p.isEnemy && p.pct >= 0 && p.pct < 80 && p.totalMissing > 0);

    // Store for export
    window._llAccResults = { playerResults, priceMap, selectedTabNames, totalLooted, totalDeposited, totalMissing, totalMissingSilver };

    let html = '';
    if (selectedTabNames.length > 0) {
        html += `<div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:0.75rem;">Comparing against: <strong>${selectedTabNames.map(n => esc(n)).join(', ')}</strong></div>`;
    }

    // Known-limitation banner: Albion's protocol never broadcasts the LOCAL player's
    // own loot pickups — only OTHER players in range. So the account holder won't
    // appear as a looter in the list even when they picked up items. We surface that
    // here so it doesn't look like a bug.
    const myName = (discordUser?.username || window._userData?.user?.username || '').trim();
    const foundMe = myName && playerResults.some(p => p.name.toLowerCase() === myName.toLowerCase());
    if (myName && !foundMe) {
        html += `<div style="background:rgba(88,101,242,0.10); border:1px solid rgba(88,101,242,0.35); border-radius:8px; padding:0.65rem 0.9rem; margin-bottom:0.75rem; font-size:0.82rem; color:var(--text-secondary); display:flex; gap:0.6rem; align-items:flex-start;">
            <span style="font-size:1.1rem; line-height:1;">ℹ️</span>
            <div>
                <strong style="color:#c7d2ff;">"${esc(myName)}" not in the list? That's expected.</strong><br>
                Albion's network protocol only broadcasts OTHER players' loot pickups — your own pickups aren't sent as events, so the Go client can't record them.
                If you deposited items into the tracked chest, they're counted in the total but aren't attributed to you individually.
            </div>
        </div>`;
    }

    // Suspects banner
    if (suspects.length > 0) {
        const suspectNames = suspects.map(s => esc(s.name)).join(', ');
        // Aggregate missing items across suspects so user can cross-check current market values
        const missingAgg = {};
        for (const p of suspects) {
            for (const it of (p.items || [])) {
                if (!it.missing || it.missing <= 0) continue;
                const key = it.itemId;
                missingAgg[key] = (missingAgg[key] || 0) + it.missing;
            }
        }
        const hasMissingItems = Object.keys(missingAgg).length > 0;
        // Stash on window so the handler can read it without globals through the function scope
        window._llSuspectMissingItems = missingAgg;
        html += `<div style="background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:0.7rem 1rem; margin-bottom:0.75rem;">
            <div style="font-weight:600; color:var(--loss-red); font-size:0.85rem; margin-bottom:0.25rem;">
                &#9888; ${suspects.length} suspect${suspects.length > 1 ? 's' : ''} — ${formatSilver(totalMissingSilver)} missing
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:${hasMissingItems ? '0.5rem' : '0'};">${suspectNames}</div>
            ${hasMissingItems ? `<button class="btn-small" onclick="valueMissingItemsInLootBuyer()" title="Load missing items into Loot Buyer to see current market values">&#128178; Value missing items</button>` : ''}
        </div>`;
    }

    // Verification summary — total verified item-lines from the chest log cross-check.
    const verifiedLines = playerResults.reduce((s, p) =>
        s + (p.items || []).filter(it => it.verified).length, 0);
    const fullyVerifiedLines = playerResults.reduce((s, p) =>
        s + (p.items || []).filter(it => it.fullyVerified).length, 0);
    if (mergedLogMeta.batches > 0) {
        // Session time window label — shows what slice of chest-log history counted.
        // Chest logs retain ~4 weeks; we filter to session start (-1h) to end (+24h).
        let windowLabel = '';
        if (mergedLogMeta.windowStart > 0 && Number.isFinite(mergedLogMeta.windowEnd)) {
            const fmt = (ms) => new Date(ms).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
            windowLabel = ` Filtered to session window <code style="background:rgba(255,255,255,0.04);padding:0.05rem 0.3rem;border-radius:3px;font-size:0.75rem;">${esc(fmt(mergedLogMeta.windowStart))} → ${esc(fmt(mergedLogMeta.windowEnd))}</code>.`;
        }
        const droppedLabel = mergedLogMeta.depositsOutOfWindow > 0
            ? ` <span style="color:#fbbf24;" title="These deposits happened outside the session time window (±buffer) and were excluded from verification">${mergedLogMeta.depositsOutOfWindow} deposit${mergedLogMeta.depositsOutOfWindow !== 1 ? 's' : ''} outside window dropped</span>.`
            : '';
        html += `<div class="ll-verify-banner">
            <span class="ll-verify-icon">✓</span>
            <div>
                <strong>Chest log merged</strong> &mdash;
                ${mergedLogMeta.batches} batch${mergedLogMeta.batches !== 1 ? 'es' : ''} ·
                <strong>${mergedLogMeta.depositsInWindow}</strong> deposit${mergedLogMeta.depositsInWindow !== 1 ? 's' : ''} in window${mergedLogMeta.withdrawals > 0 ? ` · ${mergedLogMeta.withdrawals} withdrawal record${mergedLogMeta.withdrawals !== 1 ? 's' : ''}` : ''}.${droppedLabel}
                <br>
                <span style="font-size:0.78rem; color:var(--text-muted);">
                    <strong style="color:var(--profit-green);">${verifiedLines}</strong> item line${verifiedLines !== 1 ? 's' : ''} verified
                    (${fullyVerifiedLines} fully · ${verifiedLines - fullyVerifiedLines} partial). Hover the green ✓ on any item to see who deposited what.${windowLabel}
                </span>
            </div>
        </div>`;
    }

    html += `<div class="ll-acc-summary">
        <div class="loot-tracked-stat"><span class="loot-tracked-stat-label">Looted</span><span class="loot-tracked-stat-value">${totalLooted}</span></div>
        <div class="loot-tracked-stat"><span class="loot-tracked-stat-label">In Chest</span><span class="loot-tracked-stat-value" style="color:var(--profit-green);">${totalDeposited}</span></div>
        <div class="loot-tracked-stat"><span class="loot-tracked-stat-label">Missing</span><span class="loot-tracked-stat-value" style="color:var(--loss-red);">${totalMissing}${totalMissingSilver > 0 ? ` (${formatSilver(totalMissingSilver)})` : ''}</span></div>
        <div class="loot-tracked-stat"><span class="loot-tracked-stat-label">Players</span><span class="loot-tracked-stat-value">${playerResults.length}</span></div>
        ${mergedLogMeta.batches > 0 ? `<div class="loot-tracked-stat"><span class="loot-tracked-stat-label">Verified</span><span class="loot-tracked-stat-value" style="color:var(--profit-green);">${verifiedLines}</span></div>` : ''}
    </div>`;

    // Deaths section — reconstructed from __DEATH__ events in the session.
    // Previously missing from accountability; users couldn't see who died in the list even
    // though death info is useful for allocating gear/regear responsibility.
    try {
        const deathPriceMap = priceMap;
        const deathByPlayer = {};
        for (const [n, d] of Object.entries(lootedByPlayer)) deathByPlayer[n] = { ...d, items: Object.entries(d.items).map(([id, q]) => ({ item_id: id, quantity: q, timestamp: 0 })) };
        const deaths = buildDeathTimeline(lootEvents, deathByPlayer, deathPriceMap, primaryGuild, primaryAlliance);
        if (deaths && deaths.length > 0) {
            // Stash so renderDeathsSection can use _llPriceMap for tooltips
            _llPriceMap = deathPriceMap;
            _llDeaths = deaths;
            html += renderDeathsSection(deaths);
        }
    } catch(e) { /* deaths section is optional — don't break the whole view */ }

    // Color legend — explains the item-state dots.
    html += `<div class="ll-accountability-legend">
        <span><span class="ll-item-status-dot ll-dot-deposited"></span> Deposited</span>
        <span><span class="ll-item-status-dot ll-dot-partial"></span> Partial</span>
        <span><span class="ll-item-status-dot ll-dot-missing"></span> Missing</span>
        <span><span class="ll-item-status-dot ll-dot-died"></span> Lost on death</span>
        <span style="color:var(--text-muted);font-style:italic;">Enemy loot shown without status</span>
    </div>`;

    // Filter bar for Accountability — lets user drill into a guild or single player quickly.
    const accGuilds = [...new Set(playerResults.map(p => p.guild).filter(Boolean))].sort();
    const accPlayers = playerResults.map(p => p.name).sort();
    const savedAccGuild = document.getElementById('acc-result-guild')?.value || '';
    const savedAccPlayer = document.getElementById('acc-result-player')?.value || '';
    html += `<div class="ll-filter-bar" style="margin-bottom:0.5rem;">
        <input type="text" id="acc-result-search" class="transport-select" placeholder="Search player / guild…" value="${esc(document.getElementById('acc-result-search')?.value || '')}" style="min-width:180px; flex:1;" oninput="_accApplyFilter()">
        <select id="acc-result-guild" class="transport-select" style="min-width:140px;" onchange="_accApplyFilter()" title="Show only players in this guild">
            <option value="">All guilds</option>
            ${accGuilds.map(g => `<option value="${esc(g)}"${savedAccGuild === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}
        </select>
        <select id="acc-result-player" class="transport-select" style="min-width:140px;" onchange="_accApplyFilter()" title="Filter to one player">
            <option value="">All players</option>
            ${accPlayers.map(p => `<option value="${esc(p)}"${savedAccPlayer === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
    </div>`;

    // Action buttons: view switcher + Share + Expand/Collapse + Discord + Export
    html += `<div style="display:flex; gap:0.4rem; margin-bottom:0.5rem; flex-wrap:wrap;">
        <button class="btn-small btn-small-accent" onclick="_accShowEventView('${esc(sessionId)}')" title="See the same per-player event layout as the session detail view, with deposit-status colors overlaid on each item">📋 Event View</button>
        <button class="btn-small" onclick="shareAccountability('${esc(sessionId)}')" title="Create a public link for this accountability check — viewers can toggle before/after view">🔗 Share</button>
        <button class="btn-small" onclick="document.querySelectorAll('#accountability-result .ll-player-card').forEach(c=>c.classList.add('expanded'))">Expand All</button>
        <button class="btn-small" onclick="document.querySelectorAll('#accountability-result .ll-player-card').forEach(c=>c.classList.remove('expanded'))">Collapse All</button>
        <div class="ll-discord-dropdown">
            <button class="btn-small" onclick="this.nextElementSibling.classList.toggle('open')">&#128203; Discord ▾</button>
            <div class="ll-discord-menu">
                <button onclick="this.parentElement.classList.remove('open'); copyAccountabilityToDiscord('table')">Accountability table</button>
                <button onclick="this.parentElement.classList.remove('open'); copyAccountabilityToDiscord('regear')">Regear report</button>
            </div>
        </div>
        <button class="btn-small" onclick="exportAccountabilityCSV()">CSV Export</button>
    </div>`;

    html += playerResults.map(p => {
        // Self-untracked placeholder row — show the user that they're in the session,
        // but explain pickups aren't tracked. Render a simplified card with optional
        // inferred-items strip when residual chest deposits can be attributed to them.
        if (p.isSelfUntracked) {
            const inferredStrip = p.hasInferredItems
                ? `<div style="padding:0.5rem 0.8rem; border-top:1px solid rgba(88,101,242,0.15); background:rgba(88,101,242,0.04);">
                    <div style="font-size:0.72rem; color:#c7d2ff; margin-bottom:0.3rem; font-weight:600; text-transform:uppercase; letter-spacing:0.03em;">🎯 Inferred deposits (${p.items.length} items · ${formatSilver(p.items.reduce((s, it) => s + ((priceMap[it.itemId]?.price || 0) * it.looted), 0))})</div>
                    <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:0.35rem; font-style:italic;">Chest items that don't match any other player's tracked pickups. Best-effort attribution to you.</div>
                    <div style="display:flex; flex-wrap:wrap; gap:0.3rem;">
                        ${p.items.map(it => {
                            const iName = getFriendlyName(it.itemId) || it.itemId;
                            const iconUrl = `https://render.albiononline.com/v1/item/${encodeURIComponent(it.itemId)}.png`;
                            const pe = priceMap[it.itemId];
                            const val = pe ? formatSilver(pe.price * it.looted) : '—';
                            return `<div style="display:flex; align-items:center; gap:0.3rem; padding:0.25rem 0.45rem; background:rgba(255,255,255,0.03); border-radius:4px; font-size:0.75rem;" title="${esc(iName)} ×${it.looted} · ${val}"><img src="${iconUrl}" style="width:24px; height:24px;" loading="lazy" onerror="this.style.display='none'"><span>${esc(iName)}</span><span style="color:var(--accent); font-weight:700;">×${it.looted}</span></div>`;
                        }).join('')}
                    </div>
                </div>`
                : '';
            return `<div class="ll-player-card ll-card-self-untracked" style="border-left:3px solid #5865f2; background:rgba(88,101,242,0.06);" data-player-name="${esc(p.name.toLowerCase())}" data-player-guild="${esc((p.guild || '').toLowerCase())}">
                <div class="ll-player-header" style="display:flex; align-items:center; gap:0.6rem; padding:0.6rem 0.8rem;">
                    <div style="width:36px; height:36px; border-radius:50%; background:#5865f2; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.82rem;">${esc(p.name.substring(0, 2).toUpperCase())}</div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:600; color:var(--text-primary); display:flex; align-items:center; gap:0.4rem;">
                            ${esc(p.name)}
                            <span class="tier-badge" style="background:rgba(88,101,242,0.18); color:#c7d2ff;">You</span>
                            ${p.hasInferredItems ? `<span class="tier-badge" style="background:rgba(240,192,64,0.18); color:var(--accent);" title="Chest items that don't match any tracked player's pickups — best-effort attribution">+${p.items.length} inferred</span>` : ''}
                        </div>
                        <div style="font-size:0.72rem; color:var(--text-muted);">Your pickups aren't tracked by Albion's protocol. Items below are "unclaimed" deposits attributed to you as a best-effort.</div>
                    </div>
                </div>
                ${inferredStrip}
            </div>`;
        }
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
            if (it.lostOnDeath) {
                // Items lost when player died — shown but not counted as stolen
                rowClass = 'll-item-died'; dotClass = 'll-dot-died'; statusLabel = 'Lost on Death';
            } else if (it.inChest === -1) {
                // Enemy loot — no deposit status
                rowClass = ''; dotClass = ''; statusLabel = 'Enemy Loot';
            } else if (it.missing === 0) {
                rowClass = 'll-item-deposited'; dotClass = 'll-dot-deposited'; statusLabel = 'Deposited';
            } else if (it.inChest > 0) {
                rowClass = 'll-item-partial'; dotClass = 'll-dot-partial'; statusLabel = `${it.inChest}/${it.looted}`;
            } else {
                rowClass = 'll-item-missing'; dotClass = 'll-dot-missing'; statusLabel = 'Missing';
            }
            // ✓ Verified badge — chest log has a deposit record for this player+item.
            // Green ring on the icon + hover tooltip explaining the evidence.
            const verifiedClass = it.verified ? (it.fullyVerified ? 'll-item-verified-full' : 'll-item-verified-partial') : '';
            const verifiedTitle = it.verified
                ? `✓ Verified: chest log shows ${p.name} deposited ${it.verifiedQty} of this item${it.fullyVerified ? '' : ` (covers ${it.verifiedQty}/${it.looted} of pickup)`}`
                : '';
            // Missing-item hover tooltip: who picked it up, when, and where (zone from Go client v1.3.0+)
            const missingTooltipHtml = (rowClass === 'll-item-missing' && it.pickupEvs && it.pickupEvs.length > 0)
                ? (() => {
                    const evs = it.pickupEvs.slice(0, 4);
                    const guildPart = p.guild ? ` [${esc(p.guild)}]` : '';
                    const lines = evs.map(e => {
                        const t = esc(new Date(e.ts).toLocaleTimeString());
                        const loc = e.location ? ` · <span style="color:var(--accent);font-size:0.68rem;">📍 ${esc(e.location)}</span>` : '';
                        return `<span style="color:var(--text-muted)">At: ${t}${loc}</span>`;
                    });
                    return `<span class="ll-missing-tooltip"><strong>Picked up by:</strong> ${esc(p.name)}${guildPart}<br>${lines.join('<br>')}</span>`;
                })()
                : '';
            return `<div class="ll-item-row ${rowClass} ${verifiedClass}${missingTooltipHtml ? ' ll-has-tooltip' : ''}">
                <img src="${iconUrl}" class="ll-item-icon ${it.verified ? 'll-icon-verified' : ''}" loading="lazy" onerror="this.style.display='none'" title="${esc(verifiedTitle)}">
                <span class="ll-item-name">${esc(iName)}${it.verified ? ' <span class="ll-verified-check" title="'+esc(verifiedTitle)+'">✓</span>' : ''}</span>
                <span class="ll-item-qty">&times;${it.looted}</span>
                <span class="ll-item-value">${totalVal > 0 ? formatSilver(totalVal) : '—'}</span>
                <span class="ll-item-weight">${weightStr}</span>
                <span class="ll-item-status-dot ${dotClass}" title="${statusLabel}"></span>
                <span style="font-size:0.67rem; flex-shrink:0; color:${dotClass === 'll-dot-missing' ? 'var(--loss-red)' : dotClass === 'll-dot-partial' ? '#fbbf24' : 'var(--profit-green)'};">${statusLabel}</span>
                ${missingTooltipHtml}
            </div>`;
        }).join('');

        const playerVal = p.items.reduce((s, it) => {
            const pe = priceMap[it.itemId];
            return s + (pe ? pe.price * it.looted : 0);
        }, 0);

        const enemyBorder = p.isEnemy ? 'border-left: 3px solid var(--loss-red); opacity: 0.7;' : '';
        const roleTag = p.isEnemy
            ? '<span style="font-size:0.6rem; padding:0.1rem 0.35rem; background:rgba(239,68,68,0.2); color:var(--loss-red); border-radius:8px; margin-left:0.3rem;">Enemy Loot</span>'
            : '';
        const deathTag = p.died ? '<span title="Died — lost items" style="color:var(--loss-red); margin-left:0.3rem;">💀</span>' : '';

        return `<div class="ll-player-card" style="${enemyBorder}" data-player-name="${esc(p.name.toLowerCase())}" data-player-guild="${esc((p.guild || '').toLowerCase())}">
            <div class="ll-player-header" onclick="this.closest('.ll-player-card').classList.toggle('expanded')">
                <div class="ll-player-avatar">${esc(initials)}</div>
                <div class="ll-player-info">
                    <span class="ll-player-name">${esc(p.name)}</span>${deathTag}${roleTag}
                    ${p.guild ? `<span class="ll-player-guild">[${esc(p.guild)}]</span>` : ''}
                </div>
                <div class="ll-player-stats">
                    ${p.isEnemy ? `<div class="ll-player-stat">
                        <span class="ll-stat-label">Looted From</span>
                        <span class="ll-stat-value" style="color:var(--loss-red);">${p.totalLooted} items</span>
                    </div>` : `<div class="ll-player-stat">
                        <span class="ll-stat-label">Deposited</span>
                        <span class="ll-stat-value ${p.pct >= 80 ? 'green' : p.pct >= 40 ? '' : 'red'}">${p.pct}%</span>
                    </div>`}
                    ${playerVal > 0 ? `<div class="ll-player-stat">
                        <span class="ll-stat-label">Value</span>
                        <span class="ll-stat-value accent">${formatSilver(playerVal)}</span>
                    </div>` : ''}
                    ${!p.isEnemy ? `<div class="ll-player-stat">
                        <span class="ll-stat-label">Missing</span>
                        <span class="ll-stat-value ${p.totalMissing > 0 ? 'red' : 'green'}">${p.totalMissing}${p.missingSilver > 0 ? ` (${formatSilver(p.missingSilver)})` : ''}</span>
                    </div>` : ''}
                </div>
                <span class="ll-player-chevron">&#x25BE;</span>
            </div>
            <div class="ll-deposit-bar"><div class="ll-deposit-fill" style="width:${p.pct}%; background:${barColor};"></div></div>
            <div class="ll-player-items">${itemsHtml}</div>
        </div>`;
    }).join('');

    resultEl.innerHTML = html;
    // Stamp last-run label so re-run timing is visible.
    const lastRunEl = document.getElementById('acc-last-run');
    if (lastRunEl) lastRunEl.textContent = `✓ Last checked: ${new Date().toLocaleTimeString()}`;
    trackActivity('accountability', 1);
}

function copyAccountabilityToDiscord(template) {
    const r = window._llAccResults;
    if (!r) { showToast('Run accountability check first', 'warning'); return; }
    const guildPlayers = r.playerResults.filter(p => !p.isEnemy);
    let text = '';
    const tmpl = template || 'table';
    if (tmpl === 'regear') {
        // Regear report: per-player missing items with silver value
        text = `**Regear Report**\n`;
        text += `Session: ${r.selectedTabNames.join(', ')}\n`;
        text += `Total owed: ~${Math.round(r.totalMissingSilver).toLocaleString()} silver across ${guildPlayers.filter(p => p.totalMissing > 0).length} player(s)\n\n`;
        for (const p of guildPlayers) {
            if (p.totalMissing <= 0) continue;
            text += `**${p.name}**${p.guild ? ` [${p.guild}]` : ''} — ${p.totalMissing} item${p.totalMissing !== 1 ? 's' : ''}${p.missingSilver > 0 ? `, ~${Math.round(p.missingSilver).toLocaleString()} silver` : ''}${p.died ? ' 💀 (died)' : ''}\n`;
            for (const it of (p.items || [])) {
                if (it.missing <= 0) continue;
                const name = getFriendlyName(it.itemId) || it.itemId;
                text += `  • ${it.missing}x ${name}\n`;
            }
        }
        text += `\n_Note: values shown are current market estimates, not the price paid._`;
    } else {
        // Default table
        text = `**Loot Accountability Report**\n`;
        text += `Chests: ${r.selectedTabNames.join(', ')}\n`;
        text += `Looted: ${r.totalLooted} | In Chest: ${r.totalDeposited} | Missing: ${r.totalMissing}`;
        if (r.totalMissingSilver > 0) text += ` (~${Math.round(r.totalMissingSilver).toLocaleString()} silver)`;
        text += `\n\n`;
        text += '```\n';
        text += 'Player'.padEnd(20) + 'Guild'.padEnd(15) + 'Dep%'.padEnd(6) + 'Missing'.padEnd(10) + 'Silver\n';
        text += '-'.repeat(65) + '\n';
        for (const p of guildPlayers) {
            const silver = p.missingSilver > 0 ? Math.round(p.missingSilver).toLocaleString() : '-';
            text += p.name.slice(0, 19).padEnd(20) + (p.guild || '-').slice(0, 14).padEnd(15) + `${p.pct}%`.padEnd(6) + String(p.totalMissing).padEnd(10) + silver + '\n';
        }
        text += '```';
    }
    const title = tmpl === 'regear' ? 'Preview — Regear Report' : 'Preview — Accountability Table';
    const success = tmpl === 'regear' ? 'Regear report copied' : 'Accountability table copied';
    openCopyPreview(title, text, success);
}

// Phase 5 G9: Session view Discord templates
// Pulls from the cached render state (_llCurrentEvents, _llCurrentByPlayer, _llDeaths, _llPriceMap)
function copySessionDiscord(template) {
    if (!_llCurrentEvents || _llCurrentEvents.length === 0) {
        showToast('No session loaded', 'warning');
        return;
    }
    const events = _llCurrentEvents;
    const byPlayer = _llCurrentByPlayer;
    const priceMap = _llPriceMap;
    const deaths = _llDeaths || [];
    const lootEventsOnly = events.filter(e => e.item_id !== '__DEATH__');
    const totalItems = lootEventsOnly.reduce((s, e) => s + (e.quantity || 1), 0);
    const totalValue = lootEventsOnly.reduce((s, e) => {
        const p = priceMap[e.item_id];
        return s + (p ? p.price * (e.quantity || 1) : 0);
    }, 0);
    const tsNums = events.map(e => +new Date(e.timestamp)).filter(n => !isNaN(n));
    const durMs = tsNums.length > 1 ? Math.max(...tsNums) - Math.min(...tsNums) : 0;
    const fmtDur = (ms) => {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    // Build looter ranking (guild members only, excluding loot sources/enemies)
    const ranked = Object.entries(byPlayer)
        .filter(([, d]) => !d.isEnemy)
        .sort((a, b) => (b[1].totalValue || 0) - (a[1].totalValue || 0));
    let text = '';
    if (template === 'summary') {
        const sessionLabel = liveSessionName || 'Session';
        text = `**${sessionLabel} — GvG Summary**\n`;
        text += `Duration: ${fmtDur(durMs)} · Players: ${Object.keys(byPlayer).length} · Events: ${events.length}\n`;
        text += `Items looted: ${totalItems.toLocaleString()} · Est. value: **${formatSilver(totalValue)}**\n`;
        text += `Deaths: ${deaths.length}`;
        const friendlyDeaths = deaths.filter(d => d.wasFriendly).length;
        const enemyDeaths = deaths.length - friendlyDeaths;
        if (deaths.length > 0) text += ` (${friendlyDeaths} friendly, ${enemyDeaths} enemy)`;
        text += `\n\n__Top 3 looters:__\n`;
        for (const [name, d] of ranked.slice(0, 3)) {
            text += `• **${name}**${d.guild ? ` [${d.guild}]` : ''} — ${formatSilver(d.totalValue || 0)} (${d.items.length} items)\n`;
        }
    } else if (template === 'topLooters') {
        text = `**Top Looters — ${liveSessionName || 'Session'}**\n`;
        text += `Est. total value: **${formatSilver(totalValue)}** over ${fmtDur(durMs)}\n\n`;
        text += '```\n';
        text += 'Rank  Player                Guild           Items   Value\n';
        text += '-'.repeat(65) + '\n';
        ranked.slice(0, 15).forEach(([name, d], i) => {
            const rank = String(i + 1).padEnd(6);
            const nm = name.slice(0, 20).padEnd(22);
            const gl = (d.guild || '-').slice(0, 14).padEnd(16);
            const itm = String(d.items.length).padEnd(8);
            const val = d.totalValue > 0 ? formatSilver(d.totalValue) : '-';
            text += `${rank}${nm}${gl}${itm}${val}\n`;
        });
        text += '```';
    } else if (template === 'deaths') {
        if (deaths.length === 0) {
            text = '**No deaths recorded in this session.**';
        } else {
            text = `**Deaths Report — ${liveSessionName || 'Session'}**\n`;
            text += `${deaths.length} death${deaths.length !== 1 ? 's' : ''} · Est. value moved: **${formatSilver(deaths.reduce((s, d) => s + d.estimatedValue, 0))}**\n\n`;
            for (const d of deaths) {
                const when = d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : '—';
                text += `${d.wasFriendly ? '⚔' : '💀'} **${d.victim}**${d.victimGuild ? ` [${d.victimGuild}]` : ''} died to **${d.killer || 'unknown'}** at ${when}\n`;
                text += `  ~${formatSilver(d.estimatedValue)} recovered off corpse`;
                if (d.lootedBy.length > 0) {
                    const top = d.lootedBy.slice(0, 2).map(l => `${l.name} (${l.items})`).join(', ');
                    text += ` by ${top}${d.lootedBy.length > 2 ? ` +${d.lootedBy.length - 2} more` : ''}`;
                }
                text += `\n`;
            }
            text += `\n_Shows items picked up off corpses by tracked players. Unlooted items not counted._`;
        }
    } else {
        showToast('Unknown template', 'error');
        return;
    }
    const titleMap = { summary: 'GvG Summary', topLooters: 'Top Looters', deaths: 'Deaths Report' };
    const successMap = { summary: 'GvG summary copied', topLooters: 'Top looters copied', deaths: 'Deaths report copied' };
    openCopyPreview(`Preview — ${titleMap[template] || 'Session'}`, text, successMap[template] || 'Copied');
}

function exportAccountabilityCSV() {
    const r = window._llAccResults;
    if (!r) { showToast('Run accountability check first', 'warning'); return; }
    const rows = r.playerResults.filter(p => !p.isEnemy).map(p => ({
        player: p.name,
        guild: p.guild,
        total_looted: p.totalLooted,
        total_deposited: p.totalDeposited,
        deposit_pct: p.pct,
        total_missing: p.totalMissing,
        missing_silver: Math.round(p.missingSilver),
        died: p.died ? 'Yes' : 'No'
    }));
    exportToCSV(rows, `accountability-${new Date().toISOString().slice(0, 10)}.csv`);
}

// E8: Bounded live event queue. Hard cap = 10k events. When we cross 9k we
// warn the user to save + reset, and keep accepting. When we actually hit
// 10k we drop the oldest event and surface a "dropping oldest" toast once
// per bucket-of-100 so chat-spam doesn't flood toasts.
const LIVE_EVENT_CAP = 10000;
const LIVE_EVENT_WARN_THRESHOLD = 9000;
let _liveEventWarnedAt = 0;
let _liveEventDropCounter = 0;
// Track the set of backend session_ids seen during this live session.
// Events stream in with `sessionId` from the backend; a WS reconnect creates a new
// session_id mid-session. We collect them all, and when the user clicks Save, we ask
// the backend to consolidate them into one (rather than uploading duplicates).
window._liveSessionIds = window._liveSessionIds || new Set();
// Content-based dedup for live events — WebSocket reconnects can replay the
// same event as a different JS object, so reference-equality dedup (`includes`)
// misses them. Keep a Set of content keys for O(1) lookup.
window._liveEventKeys = window._liveEventKeys || new Set();
function _liveEventKey(ev) {
    return [
        String(ev.timestamp || ev.ts || ''),
        (ev.looted_by_name || ev.lootedBy?.name || '').toLowerCase(),
        (ev.item_id || ev.itemId || '').toLowerCase(),
        (ev.looted_from_name || ev.lootedFrom?.name || '').toLowerCase(),
        String(ev.quantity || 1),
    ].join('|');
}

function _pushLiveEvent(ev) {
    // Recover UNKNOWN_<n> -> real string ID before anything else touches the event
    normalizeLootEventInPlace(ev);
    // Skip if we've already seen this exact event (replayed via WS reconnect, etc.)
    const key = _liveEventKey(ev);
    if (window._liveEventKeys.has(key)) return;
    window._liveEventKeys.add(key);
    liveLootEvents.push(ev);
    if (ev && ev.sessionId) window._liveSessionIds.add(ev.sessionId);
    if (liveLootEvents.length === LIVE_EVENT_WARN_THRESHOLD && _liveEventWarnedAt < LIVE_EVENT_WARN_THRESHOLD) {
        _liveEventWarnedAt = LIVE_EVENT_WARN_THRESHOLD;
        showToast(`Live session approaching ${LIVE_EVENT_CAP.toLocaleString()} events — Save Session soon to avoid dropped data`, 'warn');
    }
    if (liveLootEvents.length > LIVE_EVENT_CAP) {
        liveLootEvents.shift(); // drop oldest
        _liveEventDropCounter++;
        if (_liveEventDropCounter === 1 || _liveEventDropCounter % 100 === 0) {
            showToast(`Event queue at ${LIVE_EVENT_CAP.toLocaleString()} cap — oldest events are being dropped. Save now.`, 'error');
        }
    }
}

// Hook into existing WS to capture loot events for live mode
function handleLootLoggerWsMessage(msg) {
    if (msg.type === 'death-event' && msg.data) {
        if (liveSessionActive) {
            // Store as a special loot event with __DEATH__ marker
            _pushLiveEvent({
                timestamp: msg.data.timestamp || Date.now(),
                looted_by_name: msg.data.killerName || '',
                looted_by_guild: msg.data.killerGuild || '',
                looted_from_name: msg.data.victimName || '',
                looted_from_guild: msg.data.victimGuild || '',
                item_id: '__DEATH__',
                quantity: 0
            });
        }
    }
    if (msg.type === 'loot-event' && msg.data) {
        if (liveSessionActive) {
            _pushLiveEvent(msg.data);
            liveSessionSaved = false; // new events invalidate saved state
            const saveBtn = document.getElementById('ll-save-btn');
            if (saveBtn) saveBtn.textContent = 'Save Session';
            updateLiveLootIndicator();
            // Debounced re-render (2s) to avoid DOM thrashing on rapid events
            if (lootLoggerMode === 'live' && document.getElementById('loot-session-detail')?.style.display !== 'none') {
                if (_llShowLiveTimer) clearTimeout(_llShowLiveTimer);
                _llShowLiveTimer = setTimeout(showLiveSession, 2000);
            }
        }
    }
    if (msg.type === 'chest-capture' && msg.data) {
        // Gate captures on chestCaptureActive flag
        if (!chestCaptureActive && lootLoggerMode === 'accountability') {
            // Always store if in accountability mode regardless of toggle
        } else if (!chestCaptureActive) {
            // Skip if capture mode is off and not on accountability tab
        }
        // Recover UNKNOWN_<n> item IDs from a stale/missing client itemmap before
        // cosmetic filtering (otherwise mapped items like T4_RUNE would be lost
        // to the UNKNOWN_ prefix filter in isNonTradeableItemId).
        normalizeChestCaptureInPlace(msg.data);
        // Filter out account-bound cosmetics that the game sometimes leaks into chest slot maps
        // (mount skins, unlock tokens, TELLAFRIEND rewards, etc.). Defense-in-depth with Go client filter.
        if (Array.isArray(msg.data.items)) {
            const before = msg.data.items.length;
            msg.data.items = msg.data.items.filter(it => !isNonTradeableItemId(it.itemId));
            const filtered = before - msg.data.items.length;
            if (filtered > 0) {
                console.log(`[ChestCapture] Filtered ${filtered} non-tradeable item(s) (mount skins / unlocks / TELLAFRIEND cosmetics)`);
            }
        }
        // E2: lootBuyerCaptures IS window._chestCaptures — push to the unified store
        if (!window._chestCaptures.includes(msg.data)) {
            window._chestCaptures.push(msg.data);
            if (window._chestCaptures.length > 20) window._chestCaptures.shift();
            _fireCaptureBusEvent('add', msg.data); // F3: notify subscribers
        }
        showToast(`Chest capture received: ${esc(msg.data.tabName || 'Unknown tab')}`, 'success');
        // Update Accountability UI if visible (F3 subscriber also handles this, but kept for backward compat)
        if (lootLoggerMode === 'accountability') {
            populateAccountabilityDropdowns();
            renderCaptureChips();
        }
    }
    // Death event — mark affected player's items
    if (msg.type === 'death-event' && msg.data) {
        const playerName = msg.data.playerName || '';
        if (playerName) {
            liveLootEvents.forEach(ev => {
                const evName = ev.looted_by_name || ev.lootedBy?.name || '';
                if (evName === playerName) ev.died = true;
            });
            if (lootLoggerMode === 'live' && document.getElementById('loot-session-detail')?.style.display !== 'none') {
                if (_llShowLiveTimer) clearTimeout(_llShowLiveTimer);
                _llShowLiveTimer = setTimeout(showLiveSession, 2000);
            }
        }
    }

    // Chest log batch — deposit/withdraw ground truth from opcode 157.
    // Accept if the chest-log capture toggle is on OR if we're on the
    // accountability tab (same pattern as regular chest captures).
    if (msg.type === 'chest-log-batch' && msg.data) {
        _ingestChestLogBatch(msg.data);
    }
    // On (re)connect the backend sends any pending batches accumulated while the browser was offline.
    if (msg.type === 'chest-log-batches' && Array.isArray(msg.data)) {
        for (const b of msg.data) _ingestChestLogBatch(b);
    }
}

function _ingestChestLogBatch(batch) {
    if (!batch || !Array.isArray(batch.entries) || batch.entries.length === 0) return;
    if (!chestLogCaptureActive && lootLoggerMode !== 'accountability') {
        // Capture toggle is off and user isn't on the Accountability tab — drop it.
        return;
    }
    // Normalize any UNKNOWN_<n> IDs in case the Go client's itemmap was stale.
    for (const e of batch.entries) {
        if (typeof e.itemId === 'string' && e.itemId.startsWith('UNKNOWN_')) {
            e.itemId = rewriteUnknownItemId(e.itemId, e.numericId);
        }
    }
    window._chestLogBatches = window._chestLogBatches || [];
    // Dedup on (capturedAt, action, first entry signature) — WS reconnects can replay the same batch
    const sig = `${batch.capturedAt}|${batch.action}|${batch.entries[0]?.playerName || ''}|${batch.entries[0]?.itemId || ''}|${batch.entries[0]?.timestamp || ''}`;
    if (window._chestLogBatches.some(b => `${b.capturedAt}|${b.action}|${b.entries[0]?.playerName || ''}|${b.entries[0]?.itemId || ''}|${b.entries[0]?.timestamp || ''}` === sig)) return;
    window._chestLogBatches.push(batch);
    if (window._chestLogBatches.length > 40) window._chestLogBatches.shift();
    showToast(`Chest log received: ${batch.entries.length} ${batch.action} entries`, 'success');
    if (lootLoggerMode === 'accountability') {
        populateAccountabilityDropdowns();
        renderChestLogChips();
    }
}

// ====== TRANSPORT TAB ======
let lastTransportRoutes = null;

// ============================================================
// Transport enhancements (2026-04-18) — gank-rate, auto-refresh, saved plans, swap, Discord embed
// ============================================================
let _transportRefreshTimer = null;
const TRANSPORT_PLANS_KEY = 'transport_saved_plans_v1';

function _getTransportSavedPlans() {
    try { return JSON.parse(localStorage.getItem(TRANSPORT_PLANS_KEY) || '{}'); } catch { return {}; }
}
function _setTransportSavedPlans(plans) {
    try { localStorage.setItem(TRANSPORT_PLANS_KEY, JSON.stringify(plans)); } catch {}
}
function _refreshTransportSavedDropdown() {
    const sel = document.getElementById('transport-saved-select');
    if (!sel) return;
    const plans = _getTransportSavedPlans();
    const names = Object.keys(plans).sort();
    const current = sel.value;
    sel.innerHTML = '<option value="">— load saved —</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if (names.includes(current)) sel.value = current;
}
function _applyTransportPlan(plan) {
    if (!plan) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = String(v); };
    const check = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.checked = !!v; };
    set('transport-buy-city', plan.buyCity || '');
    set('transport-sell-city', plan.sellCity || '');
    set('transport-budget', plan.budget || 500000);
    set('transport-mount', plan.mount || 'ox_t8');
    set('transport-free-slots', plan.freeSlots || 30);
    set('transport-item-type', plan.itemType || 'all');
    set('transport-min-confidence', plan.minConfidence || 40);
    set('transport-sell-strategy', plan.sellStrategy || 'instant');
    set('transport-fresh-mode', plan.freshMode || 'off');
    set('transport-fresh-threshold', plan.freshThreshold || 60);
    set('transport-sort', plan.sortBy || 'trip_profit');
    check('transport-exclude-caerleon', plan.excludeCaerleon || false);
    set('transport-gank-rate', plan.gankRate || 0);
    const el = document.getElementById('transport-gank-rate-value');
    if (el) el.textContent = (plan.gankRate || 0) + '%';
    // Trigger change event on mount so capacity info updates
    document.getElementById('transport-mount')?.dispatchEvent(new Event('change'));
}

function initTransportEnhancements() {
    // --- Swap cities button ---
    const swapBtn = document.getElementById('transport-swap-btn');
    if (swapBtn) swapBtn.addEventListener('click', () => {
        const buy = document.getElementById('transport-buy-city');
        const sell = document.getElementById('transport-sell-city');
        if (!buy || !sell) return;
        const tmp = buy.value;
        buy.value = sell.value;
        sell.value = tmp;
        showToast('Cities swapped — planning the return leg', 'info');
        doTransportScan();
    });

    // --- Gank rate slider (live label update + re-render) ---
    const gankSlider = document.getElementById('transport-gank-rate');
    const gankLabel = document.getElementById('transport-gank-rate-value');
    if (gankSlider && gankLabel) {
        gankSlider.addEventListener('input', () => {
            gankLabel.textContent = gankSlider.value + '%';
            gankLabel.style.color = gankSlider.value >= 20 ? 'var(--loss-red)' : gankSlider.value >= 5 ? '#fbbf24' : 'var(--profit-green)';
        });
        gankSlider.addEventListener('change', () => {
            // Re-render existing routes with the new risk rate instead of re-fetching.
            if (lastTransportRoutes && lastTransportRoutes.length > 0) {
                const budget = parseInt(document.getElementById('transport-budget').value) || 500000;
                const sortBy = document.getElementById('transport-sort').value;
                const { mountCapacity, freeSlots } = getTransportMountConfig();
                enrichAndRenderTransport(lastTransportRoutes, budget, sortBy, mountCapacity, freeSlots);
            }
        });
    }

    // --- Auto-refresh ---
    const autoToggle = document.getElementById('transport-autorefresh');
    if (autoToggle) {
        autoToggle.addEventListener('change', () => {
            if (_transportRefreshTimer) { clearInterval(_transportRefreshTimer); _transportRefreshTimer = null; }
            if (autoToggle.checked) {
                _transportRefreshTimer = setInterval(() => {
                    // Only refresh if the pane is visible to the user.
                    const pane = document.getElementById('pane-transport');
                    if (!pane || pane.classList.contains('hidden')) return;
                    // Only auto-refresh in live mode.
                    const mode = document.querySelector('.transport-mode-btn.active')?.dataset.mode;
                    if (mode !== 'live') return;
                    doTransportScan();
                    const badge = document.getElementById('transport-refresh-time');
                    if (badge) badge.textContent = new Date().toLocaleTimeString();
                }, 60000);
                showToast('Auto-refresh ON — routes will update every 60 seconds', 'info');
                document.getElementById('transport-refresh-badge').style.display = '';
            } else {
                showToast('Auto-refresh OFF', 'info');
                document.getElementById('transport-refresh-badge').style.display = 'none';
            }
        });
    }

    // --- Saved Plans ---
    const savedSel = document.getElementById('transport-saved-select');
    const saveBtn = document.getElementById('transport-save-plan-btn');
    const delBtn = document.getElementById('transport-delete-plan-btn');
    if (savedSel) {
        _refreshTransportSavedDropdown();
        savedSel.addEventListener('change', () => {
            const name = savedSel.value;
            if (!name) return;
            const plans = _getTransportSavedPlans();
            if (plans[name]) {
                _applyTransportPlan(plans[name]);
                showToast(`Loaded plan "${name}"`, 'success');
                doTransportScan();
            }
        });
    }
    if (saveBtn) saveBtn.addEventListener('click', () => {
        showPrompt('Name this haul plan', '', (name) => {
            name = (name || '').trim();
            if (!name) return;
            const plans = _getTransportSavedPlans();
            plans[name] = {
                buyCity: document.getElementById('transport-buy-city').value,
                sellCity: document.getElementById('transport-sell-city').value,
                budget: parseInt(document.getElementById('transport-budget').value) || 500000,
                mount: document.getElementById('transport-mount').value,
                freeSlots: parseInt(document.getElementById('transport-free-slots').value) || 30,
                itemType: document.getElementById('transport-item-type').value,
                minConfidence: parseInt(document.getElementById('transport-min-confidence').value) || 0,
                sellStrategy: document.getElementById('transport-sell-strategy').value,
                freshMode: document.getElementById('transport-fresh-mode').value,
                freshThreshold: parseInt(document.getElementById('transport-fresh-threshold').value) || 60,
                sortBy: document.getElementById('transport-sort').value,
                excludeCaerleon: document.getElementById('transport-exclude-caerleon').checked,
                gankRate: parseInt(document.getElementById('transport-gank-rate').value) || 0,
            };
            _setTransportSavedPlans(plans);
            _refreshTransportSavedDropdown();
            const sel = document.getElementById('transport-saved-select');
            if (sel) sel.value = name;
            showToast(`Plan "${name}" saved`, 'success');
        });
    });
    if (delBtn) delBtn.addEventListener('click', () => {
        const sel = document.getElementById('transport-saved-select');
        const name = sel?.value;
        if (!name) { showToast('Select a plan to delete first', 'warn'); return; }
        showConfirm(`Delete plan "${name}"?`, () => {
            const plans = _getTransportSavedPlans();
            delete plans[name];
            _setTransportSavedPlans(plans);
            _refreshTransportSavedDropdown();
            showToast(`Plan "${name}" deleted`, 'info');
        });
    });
}

// Expose for Shopping List Discord copy — used in enrichAndRenderTransport
function getTransportGankRate() {
    const el = document.getElementById('transport-gank-rate');
    return el ? (parseInt(el.value) || 0) / 100 : 0;
}

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

    // Update URL with transport cities for sharing
    const shareUrl = new URL(window.location);
    shareUrl.searchParams.set('tab', 'transport');
    if (buyCity) shareUrl.searchParams.set('from', buyCity); else shareUrl.searchParams.delete('from');
    if (sellCity) shareUrl.searchParams.set('to', sellCity); else shareUrl.searchParams.delete('to');
    shareUrl.searchParams.delete('item');
    history.replaceState(null, '', shareUrl);

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
                limit: 300,
                premium: CraftConfig.premium ? '1' : '0',
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
        // Contributions the transport_plan activity score — once per successful load.
        if (typeof trackActivity === 'function') trackActivity('transport_plan', 1);
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

    // Sort (tiebreak by item name for stable ordering)
    const _tb = (a, b) => (a.itemId || '').localeCompare(b.itemId || '');
    if (sortBy === 'trip_profit') enriched.sort((a, b) => (b.tripProfit - a.tripProfit) || _tb(a, b));
    else if (sortBy === 'transport_score') enriched.sort((a, b) => (b.transportScore - a.transportScore) || _tb(a, b));
    else if (sortBy === 'profit_per_unit') enriched.sort((a, b) => (b.profitPerUnit - a.profitPerUnit) || _tb(a, b));
    else if (sortBy === 'volume') enriched.sort((a, b) => (b.volume - a.volume) || _tb(a, b));
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
                        ${(() => {
                            const gr = getTransportGankRate();
                            if (gr > 0) {
                                const expNet = Math.round(plan.totalProfit * (1 - gr) - plan.totalCost * gr);
                                const col = expNet >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';
                                return `<div style="text-align:right;" title="Expected net after ${(gr*100).toFixed(0)}% gank rate. If ganked you lose the full load: (profit × (1 − gank)) − (cost × gank).">
                                    <div style="font-size:0.7rem; color:var(--text-muted);">Risk-Adj Net</div>
                                    <div style="font-size:0.95rem; font-weight:700; color:${col};">${expNet >= 0 ? '+' : ''}${expNet.toLocaleString()}</div>
                                </div>`;
                            }
                            return '';
                        })()}
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
                <div style="margin-top:0.75rem; text-align:right; display:flex; gap:0.4rem; justify-content:flex-end;">
                    <button class="btn-copy-shopping-list-discord" style="
                        background:rgba(88,101,242,0.12); border:1px solid rgba(88,101,242,0.4); color:#5865f2;
                        padding:0.4rem 0.8rem; border-radius:6px; cursor:pointer; font-size:0.76rem;
                        display:inline-flex; align-items:center; gap:0.35rem; transition: all 0.15s;"
                        title="Copy shopping list as Discord-formatted code block (paste into any Discord channel)">
                        📋 Discord Embed
                    </button>
                    <button class="btn-copy-shopping-list" style="
                        background:var(--surface-3, #2a2a3a); border:1px solid var(--border-dim); color:var(--text-secondary);
                        padding:0.4rem 0.8rem; border-radius:6px; cursor:pointer; font-size:0.76rem;
                        display:inline-flex; align-items:center; gap:0.35rem; transition: all 0.15s;"
                        title="Copy shopping list to clipboard (plain text)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy Plain
                    </button>
                </div>
            `;

            // Discord embed copy — markdown-styled code block, renders as a table in Discord.
            const discordBtn = detailDiv.querySelector('.btn-copy-shopping-list-discord');
            if (discordBtn) discordBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const roi = plan.totalCost > 0 ? ((plan.totalProfit / plan.totalCost) * 100).toFixed(1) : 0;
                const gr = getTransportGankRate();
                const expNet = gr > 0 ? Math.round(plan.totalProfit * (1 - gr) - plan.totalCost * gr) : plan.totalProfit;
                const nameWidth = Math.max(18, Math.min(28, ...plan.items.map(it => getFriendlyName(it.itemId).length)));
                const pad = (s, w) => (s + ' '.repeat(w)).slice(0, w);
                const padNum = (n) => String(n).padStart(10);
                const rows = plan.items.map(it => {
                    const name = getFriendlyName(it.itemId);
                    return `${pad(name, nameWidth)} ${padNum(it.planUnits + 'x')} ${padNum(Math.floor(it.buyPrice).toLocaleString())} ${padNum(it.planCost.toLocaleString())}`;
                });
                const embed = [
                    `**🚛 Haul Plan — ${plan.buyCity} → ${plan.sellCity}**`,
                    '```',
                    `${pad('Item', nameWidth)} ${padNum('Qty')} ${padNum('Unit (s)')} ${padNum('Total (s)')}`,
                    '─'.repeat(nameWidth + 33),
                    ...rows,
                    '─'.repeat(nameWidth + 33),
                    `${pad('TOTAL COST', nameWidth)} ${padNum('')} ${padNum('')} ${padNum(plan.totalCost.toLocaleString())}`,
                    `${pad('TRIP PROFIT', nameWidth)} ${padNum('')} ${padNum('')} ${padNum('+' + plan.totalProfit.toLocaleString())}`,
                    gr > 0 ? `${pad(`RISK-ADJ (${(gr*100).toFixed(0)}% gank)`, nameWidth)} ${padNum('')} ${padNum('')} ${padNum((expNet >= 0 ? '+' : '') + expNet.toLocaleString())}` : '',
                    '```',
                    `**ROI:** ${roi}% · **Slots:** ${plan.totalSlots}/${availableSlots} · **Weight:** ${plan.totalWeight.toFixed(1)} kg`,
                ].filter(Boolean).join('\n');
                openCopyPreview('Preview — Haul Plan for Discord', embed, 'Haul plan copied — paste into Discord');
            });

            // Copy shopping list handler (plain text)
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
// Legacy scan tracking — kept for backward compat, still populates contributions table
function trackContribution(itemCount) {
    if (!discordUser) return;
    fetch(`${VPS_BASE}/api/contributions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ source: 'web_refresh', item_count: itemCount })
    }).catch(() => {});
    // Also track as new-style activity
    trackActivity('scan', 1);
}
// Unified activity tracking — tracks all user actions (scan, loot_session, chest_capture, etc.)
function trackActivity(type, count) {
    if (!localStorage.getItem('albion_auth_token') && !discordUser) return;
    fetch(`${VPS_BASE}/api/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ type, count: count || 1 })
    }).catch(() => {}); // Fire-and-forget
}

// ====== COMMUNITY TAB ======
const TIER_THRESHOLDS = { bronze: 0, silver: 100, gold: 400, diamond: 1000 }; // Updated for combined scoring
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
                const scoreEl = document.getElementById('community-my-score');
                if (scoreEl) scoreEl.textContent = (stats.score || 0).toLocaleString();
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
            // Fetch activity breakdown and render below stats
            try {
                const actRes = await fetch(`${VPS_BASE}/api/activity-stats`, { headers: authHeaders() });
                if (actRes.ok) {
                    const actData = await actRes.json();
                    const breakdown = actData.breakdown || {};
                    const score = actData.combinedScore || 0;
                    const ACTIVITY_LABELS = { scan: '🔍 Market Scans', loot_session: '📋 Loot Sessions', chest_capture: '📦 Chest Captures', sale_record: '💰 Sales', accountability: '✓ Accountability', transport_plan: '🚛 Transport', craft_calc: '🔨 Crafting' };
                    const ACTIVITY_WEIGHTS = { scan: 1, loot_session: 5, chest_capture: 3, sale_record: 2, accountability: 3, transport_plan: 1, craft_calc: 1 };
                    let breakdownHtml = '<div class="activity-breakdown" style="margin-top:0.75rem; padding:0.6rem; background:var(--bg-secondary); border-radius:8px; border:1px solid var(--border-color);">';
                    breakdownHtml += `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;"><span style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; font-weight:600;">Activity Score (30d)</span><span style="color:var(--accent); font-weight:700; font-size:1rem;">${score.toLocaleString()}</span></div>`;
                    const entries = Object.entries(ACTIVITY_LABELS).filter(([k]) => breakdown[k] > 0);
                    if (entries.length > 0) {
                        breakdownHtml += '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:0.35rem;">';
                        for (const [key, label] of entries) {
                            const count = breakdown[key] || 0;
                            const pts = count * (ACTIVITY_WEIGHTS[key] || 1);
                            breakdownHtml += `<div style="font-size:0.75rem; padding:0.25rem 0.4rem; background:rgba(255,255,255,0.03); border-radius:4px;" title="${count} actions × ${ACTIVITY_WEIGHTS[key]} pts = ${pts} pts">${label} <strong style="color:var(--accent);">${count}</strong></div>`;
                        }
                        breakdownHtml += '</div>';
                    } else {
                        breakdownHtml += '<p style="color:var(--text-muted); font-size:0.78rem; margin:0.25rem 0 0;">No activity tracked yet. Use the tools and your score will grow!</p>';
                    }
                    breakdownHtml += '</div>';
                    // Insert after the stats card
                    const statsCard = document.getElementById('community-my-stats');
                    let existingBreakdown = statsCard?.parentElement?.querySelector('.activity-breakdown');
                    if (existingBreakdown) existingBreakdown.remove();
                    statsCard?.insertAdjacentHTML('afterend', breakdownHtml);

                    // Update tier based on combined score (not just scans)
                    const actTier = actData.tier || 'bronze';
                    const tierBadge2 = document.getElementById('community-my-tier');
                    if (tierBadge2) {
                        tierBadge2.textContent = actTier.charAt(0).toUpperCase() + actTier.slice(1);
                        tierBadge2.className = `tier-badge tier-${actTier}`;
                    }
                    const progress2 = getTierProgress(actTier, score);
                    document.getElementById('tier-current-label').textContent = actTier.charAt(0).toUpperCase() + actTier.slice(1);
                    if (progress2.nextTier) {
                        document.getElementById('tier-next-label').textContent = `→ ${progress2.nextTier.charAt(0).toUpperCase() + progress2.nextTier.slice(1)} (${progress2.nextThreshold} pts)`;
                    }
                    document.getElementById('tier-progress-fill').style.width = progress2.pct + '%';
                }
            } catch { /* silent — activity breakdown is optional */ }
        } catch (e) {
            if (DEBUG) console.log('Failed to load my stats:', e);
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
            // URL-encode each CDN path segment to prevent injection if user_id/avatar ever become non-numeric
            // (Discord IDs are numeric today, but future Discord unlink bugs or DB corruption could break that).
            const avatarUrl = u.avatar
                ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(u.user_id)}/${encodeURIComponent(u.avatar)}.png?size=64`
                : 'https://cdn.discordapp.com/embed/avatars/0.png';
            const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
            // Primary metric: activity score. Secondary: scan count (kept for continuity with old leaderboard).
            const score = u.score || u.scans_30d || 0;
            const subMetric = u.scans_30d > 0 ? `<span style="color:var(--text-muted); font-size:0.7rem; margin-left:0.25rem;">${u.scans_30d.toLocaleString()} scans</span>` : '';

            return `
                <div class="leaderboard-row">
                    <div class="leaderboard-rank ${rankClass}">${medal}</div>
                    <img class="leaderboard-avatar" src="${esc(avatarUrl)}" alt="">
                    <div class="leaderboard-name">
                        ${esc(u.username) || 'Unknown'}
                        <span class="tier-badge tier-${tier}">${tierLabel}</span>
                    </div>
                    <div class="leaderboard-scans">${score.toLocaleString()} pts${subMetric}</div>
                </div>`;
        }).join('');
    } catch (e) {
        if (DEBUG) console.log('Failed to load leaderboard:', e);
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

        // Read the Quality filter from the tab (falls back to Q1 for gear-comparison accuracy).
        const ipQuality = parseInt(document.getElementById('ip-quality')?.value) || 1;

        // Build price map: (item_id, quality) -> { city -> sell_price_min }.
        // Previously this collapsed all qualities into one bucket — silver/IP then compared
        // Masterpiece silver to Normal IP, an apples-to-oranges comparison.
        // Quality also boosts effective IP: +20/+40/+60/+80/+100 per Good/Outstanding/Excellent/Masterpiece.
        const QUALITY_IP_BONUS = { 1: 0, 2: 20, 3: 40, 4: 60, 5: 100 };
        const priceMap = {};
        for (const p of cachedData) {
            const q = p.quality || 1;
            if (q !== ipQuality) continue;
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

            const baseIp = getItemPower(itemId);
            if (baseIp === 0) continue;
            const ip = baseIp + (QUALITY_IP_BONUS[ipQuality] || 0);

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

// G12: Aggregate all favorited item IDs across every user list → Set for O(1) lookup.
// Used by Loot Buyer + Loot Logger to highlight items the user has previously starred.
let _favoriteItemIds = null;
function getAllFavoriteItemIds() {
    if (_favoriteItemIds) return _favoriteItemIds;
    const set = new Set();
    try {
        const lists = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '{}');
        for (const name of Object.keys(lists)) {
            for (const item of (lists[name].items || [])) {
                const id = typeof item === 'string' ? item : (item?.itemId || item?.id);
                if (id) set.add(id);
            }
        }
    } catch {}
    _favoriteItemIds = set;
    return set;
}
function _invalidateFavoriteCache() { _favoriteItemIds = null; }
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
    _invalidateFavoriteCache();

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

    showConfirm(`Delete the list "${name}"?`, () => {
        const lists = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '{}');
        delete lists[name];
        localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(lists));
        _invalidateFavoriteCache();
        loadFavoriteLists();
        const container = document.getElementById('fav-results');
        if (container) container.innerHTML = '';
    });
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
                    <th style="width:180px;">Actions</th>
                </tr>
            </thead>
            <tbody>
                ${items.map(itemId => {
                    const cityPrices = priceMap[itemId] || {};
                    const prices = cities.map(c => cityPrices[c] || 0);
                    const validPrices = prices.filter(p => p > 0);
                    const minPrice = validPrices.length > 0 ? Math.min(...validPrices) : 0;
                    const maxPrice = validPrices.length > 0 ? Math.max(...validPrices) : 0;
                    const hasRecipe = !!recipesData[itemId];

                    return `
                        <tr data-fav-row="${esc(itemId)}">
                            <td style="padding:0.25rem;"><img src="https://render.albiononline.com/v1/item/${esc(itemId)}.png" style="width:40px;height:40px;" loading="lazy"></td>
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
                            <td><div class="fav-row-actions">
                                <button data-fav-action="chart" data-item="${esc(itemId)}" title="Open price chart">📈</button>
                                <button data-fav-action="browser" data-item="${esc(itemId)}" title="View in Market Browser">🔍</button>
                                <button data-fav-action="compare" data-item="${esc(itemId)}" title="Compare across cities">📊</button>
                                ${hasRecipe ? `<button data-fav-action="craft" data-item="${esc(itemId)}" title="Check crafting profit">🔨</button>` : ''}
                                <button data-fav-action="remove" data-item="${esc(itemId)}" title="Remove from this list">🗑</button>
                            </div></td>
                        </tr>`;
                }).join('')}
            </tbody>
        </table>`;
    container.appendChild(table);

    // Delegation-based action wiring (avoids N handlers).
    if (!container._favActionHandler) {
        container._favActionHandler = (e) => {
            const btn = e.target.closest('[data-fav-action]');
            if (!btn) return;
            const act = btn.dataset.favAction;
            const itemId = btn.dataset.item;
            if (!itemId) return;
            if (act === 'chart' && typeof showGraph === 'function') return showGraph(itemId);
            if (act === 'browser' && typeof switchToBrowser === 'function') return switchToBrowser(itemId);
            if (act === 'compare') {
                document.querySelector('[data-tab="compare"]')?.click();
                setTimeout(() => {
                    const inp = document.getElementById('compare-search');
                    if (inp) { inp.value = getFriendlyName(itemId); compareSelectedId = itemId; }
                    const btn = document.getElementById('compare-fetch-btn');
                    if (btn) btn.click();
                }, 150);
                return;
            }
            if (act === 'craft' && typeof switchToCraft === 'function') return switchToCraft(itemId);
            if (act === 'remove') {
                // Remove from the selected list (not chip editor).
                const select = document.getElementById('fav-list-select');
                const name = select ? select.value : '';
                if (!name) return;
                const lists = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '{}');
                if (!lists[name]) return;
                lists[name].items = (lists[name].items || []).filter(x => (typeof x === 'string' ? x : (x.itemId || x.id)) !== itemId);
                localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(lists));
                _invalidateFavoriteCache();
                loadFavoriteListPrices();
                showToast(`Removed ${getFriendlyName(itemId)} from "${name}"`, 'info');
            }
        };
        container.addEventListener('click', container._favActionHandler);
    }
}

// === Favorites HUB — site-wide "Add to Favorites" star button ===
// Call toggleStarredItem(itemId) from any card. It picks (or creates) a default "Watchlist" list.
function toggleStarredItem(itemId, listName = 'Watchlist') {
    if (!itemId) return false;
    const lists = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '{}');
    if (!lists[listName]) lists[listName] = { items: [], created: Date.now() };
    const existing = lists[listName].items || [];
    const idx = existing.findIndex(x => (typeof x === 'string' ? x : (x.itemId || x.id)) === itemId);
    let added = false;
    if (idx >= 0) { existing.splice(idx, 1); added = false; }
    else { existing.push(itemId); added = true; }
    lists[listName].items = existing;
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(lists));
    _invalidateFavoriteCache();
    showToast(added ? `⭐ Added to ${listName}` : `Removed from ${listName}`, added ? 'success' : 'info');
    // Update any visible star buttons on the page
    document.querySelectorAll(`.item-fav-btn[data-star-item="${itemId}"]`).forEach(btn => {
        btn.classList.toggle('is-fav', added);
        btn.textContent = added ? '★' : '☆';
    });
    return added;
}

// Return HTML for a star button — paste into any item card.
function renderFavStarButton(itemId) {
    const isFav = getAllFavoriteItemIds().has(itemId);
    return `<button class="item-fav-btn ${isFav ? 'is-fav' : ''}" data-star-item="${esc(itemId)}" title="${isFav ? 'Remove from Watchlist' : 'Add to Watchlist'}" aria-label="Toggle favorite">${isFav ? '★' : '☆'}</button>`;
}

// Global click handler — wired once — delegates star-button clicks.
if (typeof document !== 'undefined' && !window._starBtnHandlerWired) {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.item-fav-btn[data-star-item]');
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();
        toggleStarredItem(btn.dataset.starItem);
    });
    window._starBtnHandlerWired = true;
}

// ============================================================
/* BENCHED: MOUNTS DATABASE
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
END BENCHED: MOUNTS DATABASE */

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
        container.innerHTML = `<div class="empty-state"><p>Failed to load top items: ${esc(e.message)}</p></div>`;
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

// Portfolio ↔ Loot Buyer sync: auto-create BUY entry when a loot tab is tracked
function _addPortfolioBuyFromTab(tabId, tabName, purchasePrice, items) {
    const trades = getPortfolioTrades();
    // Check for duplicate by tabId
    if (trades.some(t => t._lootTabId === tabId)) return;
    if (!items || items.length === 0) {
        trades.push({
            id: Date.now(), _lootTabId: tabId, _source: 'loot_buyer',
            type: 'buy', itemId: 'LOOT_TAB_' + tabId, itemName: tabName,
            quantity: 1, price: purchasePrice, city: '',
            date: new Date().toISOString(),
        });
        savePortfolioTrades(trades);
        return;
    }
    // Split the purchase price across distinct items proportionally by count — previously this
    // collapsed a 40-item chest into ONE "primary item" entry, destroying per-item P/L attribution.
    const totalQty = items.reduce((s, it) => s + (it.quantity || 1), 0) || 1;
    const now = Date.now();
    let idx = 0;
    for (const it of items) {
        const qty = it.quantity || 1;
        const allocPrice = Math.round(purchasePrice * (qty / totalQty));
        const unitPrice = qty > 0 ? Math.round(allocPrice / qty) : 0;
        trades.push({
            id: now + idx++,
            _lootTabId: tabId,
            _source: 'loot_buyer',
            type: 'buy',
            itemId: it.itemId,
            itemName: it.name || getFriendlyName(it.itemId),
            quality: it.quality || 1,
            quantity: qty,
            price: unitPrice,
            city: '',
            date: new Date().toISOString(),
            _allocatedFromTab: true,
        });
    }
    savePortfolioTrades(trades);
}

// Portfolio ↔ Loot Buyer sync: auto-create SELL entry when a sale is recorded on a tracked tab
function _addPortfolioSellFromTab(tabId, salePrice, quantity) {
    const trades = getPortfolioTrades();
    // Find the matching BUY entry
    const buyEntry = trades.find(t => t._lootTabId === tabId && t.type === 'buy');
    if (!buyEntry) return;
    trades.push({
        id: Date.now(),
        _lootTabId: tabId,
        _source: 'loot_buyer',
        type: 'sell',
        itemId: buyEntry.itemId,
        itemName: buyEntry.itemName,
        quantity: quantity || 1,
        price: salePrice,
        city: '',
        date: new Date().toISOString()
    });
    savePortfolioTrades(trades);
}

// Sync button: scan tracked tabs and reconcile with portfolio
async function syncPortfolioFromTabs() {
    if (!localStorage.getItem('albion_auth_token') && !discordUser) {
        showToast('Log in to sync with Loot Buyer', 'warn');
        return;
    }
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-tabs`, { headers: authHeaders() });
        if (!res.ok) throw new Error('Failed to load tabs');
        const data = await res.json();
        const tabs = data.tabs || [];
        const trades = getPortfolioTrades();
        let imported = 0;
        for (const tab of tabs) {
            if (tab.purchasePrice <= 0) continue;
            if (trades.some(t => t._lootTabId === tab.id)) continue;
            trades.push({
                id: Date.now() + imported,
                _lootTabId: tab.id,
                _source: 'loot_buyer',
                type: 'buy',
                itemId: 'LOOT_TAB_' + tab.id,
                itemName: tab.tabName || `Tab #${tab.id}`,
                quantity: tab.totalQuantity || tab.itemCount || 1,
                price: tab.purchasePrice,
                city: tab.city || '',
                date: new Date(tab.purchasedAt).toISOString()
            });
            imported++;
            // Also import sales for this tab
            if (tab.revenueSoFar > 0 && tab.saleRecords > 0) {
                trades.push({
                    id: Date.now() + imported + 10000,
                    _lootTabId: tab.id,
                    _source: 'loot_buyer',
                    type: 'sell',
                    itemId: 'LOOT_TAB_' + tab.id,
                    itemName: tab.tabName || `Tab #${tab.id}`,
                    quantity: tab.saleRecords,
                    price: Math.round(tab.revenueSoFar / Math.max(1, tab.saleRecords)),
                    city: tab.city || '',
                    date: new Date().toISOString()
                });
                imported++;
            }
        }
        savePortfolioTrades(trades);
        if (imported > 0) {
            showToast(`Imported ${imported} entries from Loot Buyer`, 'success');
            renderPortfolio();
        } else {
            showToast('Portfolio already up to date', 'info');
        }
    } catch(e) {
        showToast('Sync failed: ' + e.message, 'error');
    }
}

function addPortfolioTrade() {
    const type = document.getElementById('portfolio-type').value;
    const itemId = portfolioSearchExactId || document.getElementById('portfolio-item-search').value.trim();
    const quantity = parseInt(document.getElementById('portfolio-quantity').value) || 0;
    const price = parseInt(document.getElementById('portfolio-price').value) || 0;
    const city = document.getElementById('portfolio-city').value;
    const quality = parseInt(document.getElementById('portfolio-quality')?.value) || 1;

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
        quality, // silent-default 1 for older trades; visible in new form
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
    showConfirm('Delete all portfolio trades? This cannot be undone.', () => {
        localStorage.removeItem(PORTFOLIO_STORAGE_KEY);
        renderPortfolio();
    });
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
        const syncBadge = t._source === 'loot_buyer' ? ' <span style="font-size:0.6rem; background:rgba(139,92,246,0.15); color:#a78bfa; padding:0.1rem 0.3rem; border-radius:4px;">Loot Buyer</span>' : '';
        const safeItemId = encodeURIComponent(t.itemId);
        const safeTradeId = esc(t.id);
        tableHTML += `<tr>
            <td>${date}</td>
            <td><span style="font-weight:700; color:${typeColor};">${typeLabel}</span>${syncBadge}</td>
            <td style="display:flex; align-items:center; gap:0.5rem;">
                <img src="https://render.albiononline.com/v1/item/${safeItemId}.png" width="24" height="24" style="image-rendering:pixelated;" onerror="this.style.display='none'">
                ${esc(t.itemName || name)}
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

    // Completed Craft Runs section — server-side, requires auth
    _renderPortfolioCraftRuns();
}

async function _renderPortfolioCraftRuns() {
    const el = document.getElementById('portfolio-craft-runs');
    if (!el) return;
    const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
    if (!token) { el.innerHTML = ''; return; }

    try {
        const r = await fetch(`${VPS_BASE}/api/craft-runs`, { headers: authHeaders() });
        if (!r.ok) { el.innerHTML = ''; return; }
        const data = await r.json();
        const completed = (data.runs || []).filter(run => run.status === 'complete');
        if (!completed.length) { el.innerHTML = ''; return; }

        const rows = completed.map(run => {
            const cost    = run.total_cost || 0;
            const rev     = run.total_revenue || 0;
            const taxEst  = rev * 0.055;
            const net     = rev - cost - taxEst;
            const sign    = net >= 0 ? '+' : '';
            const color   = net >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';
            const margin  = cost > 0 ? ((net / cost) * 100).toFixed(1) + '%' : '—';
            const closedDate = run.closed_at ? new Date(run.closed_at).toLocaleDateString() : '—';
            return `<tr>
                <td>${esc(closedDate)}</td>
                <td style="font-weight:600; color:var(--accent);">${esc(run.name)}</td>
                <td>${run.target_item ? esc(getFriendlyName(run.target_item) || run.target_item) : '—'}</td>
                <td style="color:var(--loss-red);">${formatSilver(cost)}</td>
                <td style="color:var(--profit-green);">${formatSilver(rev)}</td>
                <td style="font-weight:700; color:${color};">${sign}${formatSilver(net)}</td>
                <td style="color:${color};">${margin}</td>
                <td><button class="btn-small" onclick="switchTab('craft-runs')" title="Open in Craft Runs tab">Open</button></td>
            </tr>`;
        }).join('');

        const totalNet = completed.reduce((s, run) => {
            const net = (run.total_revenue || 0) - (run.total_cost || 0) - (run.total_revenue || 0) * 0.055;
            return s + net;
        }, 0);
        const totalColor = totalNet >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';

        el.innerHTML = `
        <details class="controls-panel" open style="margin-top:0;">
            <summary style="cursor:pointer; display:flex; justify-content:space-between; align-items:center; list-style:none;">
                <h3 style="color:var(--text-primary); margin:0; font-size:1rem;">🔨 Completed Craft Runs <span style="font-size:0.72rem; color:var(--text-muted); font-weight:normal;">(${completed.length} run${completed.length !== 1 ? 's' : ''})</span></h3>
                <span style="color:${totalColor}; font-weight:700; font-size:0.9rem;">${totalNet >= 0 ? '+' : ''}${formatSilver(totalNet)} net</span>
            </summary>
            <div class="table-scroll-wrapper" style="margin-top:0.75rem;">
                <table class="compare-table">
                    <thead><tr>
                        <th>Closed</th><th>Run Name</th><th>Target</th><th>Cost</th><th>Revenue</th><th>Net P/L</th><th>Margin</th><th></th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </details>`;
    } catch {
        el.innerHTML = '';
    }
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

        // Sort by profit descending, tiebreak by name
        results.sort((a, b) => (b.profit - a.profit) || (a.name || '').localeCompare(b.name || ''));
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

/* BENCHED: COMMUNITY BUILDS
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
            container.innerHTML = `<div class="empty-state"><p>Failed to load builds: ${esc(e.message)}</p></div>`;
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
END BENCHED: COMMUNITY BUILDS */

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

    // Inline input instead of prompt() — check if already showing
    const existing = document.getElementById('craft-save-name-input');
    if (existing) { existing.focus(); return; }
    const defaultName = getFriendlyName(itemId) || itemId;
    const container = document.createElement('div');
    container.id = 'craft-save-name-input';
    container.style.cssText = 'display:flex; gap:0.4rem; align-items:center; margin:0.5rem 0;';
    container.innerHTML = `
        <input type="text" id="craft-save-name-val" class="sale-form-input" value="${esc(defaultName)}" placeholder="Setup name" style="flex:1; height:30px;">
        <button class="btn-small-accent" onclick="confirmSaveCraftSetup()">Save</button>
        <button class="btn-small" onclick="document.getElementById('craft-save-name-input')?.remove()">Cancel</button>`;
    const detail = document.getElementById('craft-detail-view');
    if (detail) detail.prepend(container);
    else document.getElementById('craft-bulk-section')?.prepend(container);
    document.getElementById('craft-save-name-val')?.focus();
    return;
}
function confirmSaveCraftSetup() {
    const nameInput = document.getElementById('craft-save-name-val');
    const name = nameInput?.value?.trim();
    if (!name) return;
    document.getElementById('craft-save-name-input')?.remove();
    const searchInput = document.getElementById('craft-search');
    const itemId = craftSearchExactId || searchInput?.value?.trim();
    if (!itemId) return;

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
    showConfirm(`Delete setup "${name}"?`, () => {
        const setups = getCraftSetups();
        delete setups[name];
        localStorage.setItem(CRAFT_SETUPS_KEY, JSON.stringify(setups));
        loadCraftSetupDropdown();
    });
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

// ===== CSV EXPORT =====
function exportToCSV(data, filename) {
    if (!data || data.length === 0) { showToast('No data to export', 'warn'); return; }
    const headers = Object.keys(data[0]);
    const csv = [headers.join(',')];
    for (const row of data) {
        csv.push(headers.map(h => {
            const val = row[h] ?? '';
            const str = String(val).replace(/"/g, '""');
            return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str}"` : str;
        }).join(','));
    }
    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'export.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${data.length} rows`, 'success');
}

// Cache handles for CSV exports (each renderer updates these)
let _lastCraftsRendered = [];
let _lastArbTrades = [];

function exportTransportCSV() {
    if (!lastTransportRoutes || lastTransportRoutes.length === 0) {
        showToast('Run a scan first — no transport routes to export', 'warn');
        return;
    }
    const rows = lastTransportRoutes.map(r => ({
        item_id: r.itemId || '',
        item_name: getFriendlyName(r.itemId) || r.itemId || '',
        quality: r.quality || 1,
        buy_city: r.buyCity || '',
        buy_price: Math.floor(r.buyPrice || 0),
        sell_city: r.sellCity || '',
        sell_price: Math.floor(r.sellPrice || 0),
        profit_per_unit: Math.floor(r.profitPerUnit || r.profit || 0),
        roi_pct: (r.roi || 0).toFixed ? (r.roi).toFixed(1) : r.roi,
        weight_per_unit: r.weight || getItemWeight(r.itemId) || 0,
        volume_per_day: r.dailyVolume || r.volume || '',
        confidence_pct: r.confidence ?? '',
        buy_updated: r.dateBuy || '',
        sell_updated: r.dateSell || ''
    }));
    exportToCSV(rows, `transport-routes-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportLiveFlipsCSV() {
    const minProfit = parseInt(document.getElementById('flips-min-profit')?.value) || 10000;
    const minRoi = parseFloat(document.getElementById('flips-min-roi')?.value) || 3;
    const cityFilter = document.getElementById('flips-city-filter')?.value || 'all';
    const typeFilter = document.getElementById('flips-type-filter')?.value || 'all';
    const filtered = (liveFlipsCache || []).filter(f => {
        if (f.profit < minProfit || f.roi < minRoi) return false;
        if (cityFilter !== 'all' && f.buyCity !== cityFilter && f.sellCity !== cityFilter) return false;
        if (typeFilter !== 'all' && (f.type || 'cross-city') !== typeFilter) return false;
        return true;
    });
    if (filtered.length === 0) { showToast('No flips matching current filters', 'warn'); return; }
    const rows = filtered.map(f => ({
        detected_at: new Date(f.detectedAt).toISOString(),
        item_id: f.itemId || '',
        item_name: f.name || '',
        quality: f.quality || 1,
        type: f.type || 'cross-city',
        buy_city: f.buyCity || '',
        buy_price: Math.floor(f.buyPrice || 0),
        sell_city: f.sellCity || '',
        sell_price: Math.floor(f.sellPrice || 0),
        profit: Math.floor(f.profit || 0),
        roi_pct: f.roi
    }));
    exportToCSV(rows, `live-flips-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportCraftingCSV() {
    if (!_lastCraftsRendered || _lastCraftsRendered.length === 0) {
        showToast('Run a recipe scan first — no crafting data to export', 'warn');
        return;
    }
    const rows = _lastCraftsRendered.map(c => ({
        item_id: c.itemId || '',
        item_name: getFriendlyName(c.itemId) || c.itemId || '',
        quality: c.quality || 1,
        sell_city: c.sellCity || '',
        sell_price: Math.floor(c.sellPrice || 0),
        material_cost: Math.floor(c.matCost || 0),
        tax: Math.floor(c.tax || 0),
        station_fee: Math.floor(c.fee || 0),
        profit: Math.floor(c.profit || 0),
        roi_pct: (c.roi || 0).toFixed ? (c.roi).toFixed(1) : c.roi,
        materials: (c.mats || []).map(m => `${m.effectiveQty || m.qty}x ${m.id}@${m.city}`).join('; '),
        updated: c.updateDate || ''
    }));
    exportToCSV(rows, `crafting-recipes-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportArbitrageCSV() {
    if (!_lastArbTrades || _lastArbTrades.length === 0) {
        showToast('Scan the arbitrage market first — nothing to export', 'warn');
        return;
    }
    const rows = _lastArbTrades.map(t => ({
        item_id: t.itemId || '',
        item_name: getFriendlyName(t.itemId) || t.itemId || '',
        quality: t.quality || 1,
        buy_city: t.buyCity || '',
        buy_price: Math.floor(t.buyPrice || 0),
        sell_city: t.sellCity || '',
        sell_price: Math.floor(t.sellPrice || 0),
        profit: Math.floor(t.profit || 0),
        roi_pct: (t.roi || 0).toFixed ? (t.roi).toFixed(1) : t.roi,
        confidence_pct: t.confidencePct ?? t.confidence ?? '',
        upgrade_flip: t.isUpgradeFlip ? 'yes' : '',
        buy_updated: t.dateBuy || '',
        sell_updated: t.dateSell || ''
    }));
    exportToCSV(rows, `arbitrage-${new Date().toISOString().slice(0, 10)}.csv`);
}

// Export the currently viewed session as an ao-loot-logger compatible .txt file.
// Format: 10 semicolon-delimited columns with header row — exact match so
// re-uploading round-trips cleanly.
function exportLootSessionTxt() {
    const events = _llCurrentEvents;
    if (!events || events.length === 0) { showToast('No session data to export', 'warn'); return; }
    const header = 'timestamp_utc;looted_by__alliance;looted_by__guild;looted_by__name;item_id;item_name;quantity;looted_from__alliance;looted_from__guild;looted_from__name';
    const rows = events.filter(e => e.item_id !== '__DEATH__').map(e => {
        const ts = new Date(e.timestamp || Date.now()).toISOString();
        const byA = e.looted_by_alliance || '';
        const byG = e.looted_by_guild || '';
        const byN = e.looted_by_name || '';
        const itemId = e.item_id || '';
        const itemName = getFriendlyName(itemId) || itemId;
        const qty = e.quantity || 1;
        const frA = e.looted_from_alliance || '';
        const frG = e.looted_from_guild || '';
        const frN = e.looted_from_name || '';
        return [ts, byA, byG, byN, itemId, itemName, qty, frA, frG, frN].join(';');
    });
    if (rows.length === 0) { showToast('Session only contains deaths — nothing to export in .txt format', 'warn'); return; }
    const content = header + '\n' + rows.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = (liveSessionName || 'loot-session').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
    a.download = `${slug}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${rows.length} events as .txt`, 'success');
}

function exportLootSession() {
    const events = _llCurrentEvents;
    if (!events || events.length === 0) { showToast('No loot data to export', 'warn'); return; }
    const priceMap = _llPriceMap || {};
    const rows = events.filter(e => e.item_id !== '__DEATH__').map(e => {
        const p = priceMap[e.item_id];
        const unitPrice = p ? p.price : 0;
        const qty = e.quantity || 1;
        return {
            timestamp: new Date(e.timestamp).toISOString(),
            looted_by: e.looted_by_name || '',
            guild: e.looted_by_guild || '',
            alliance: e.looted_by_alliance || '',
            item_id: e.item_id || '',
            item_name: getFriendlyName(e.item_id) || e.item_id || '',
            quantity: qty,
            unit_price: unitPrice,
            total_value: unitPrice * qty,
            weight: (getItemWeight(e.item_id) * qty) || 0,
            looted_from: e.looted_from_name || ''
        };
    });
    exportToCSV(rows, `loot-session-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportLootSessionJson() {
    const events = _llCurrentEvents;
    if (!events || events.length === 0) { showToast('No loot data to export', 'warn'); return; }
    const priceMap = _llPriceMap || {};
    const deaths = _llDeaths || [];
    const byPlayer = _llCurrentByPlayer || {};
    const data = {
        exportedAt: new Date().toISOString(),
        sessionId: _llCurrentSessionId || 'live',
        eventCount: events.length,
        playerCount: Object.keys(byPlayer).length,
        deaths: deaths.map(d => ({
            victim: d.victim, killer: d.killer, timestamp: d.timestamp,
            estimatedValue: d.estimatedValue, wasFriendly: d.wasFriendly,
            itemCount: d.lootedItems.length
        })),
        players: Object.entries(byPlayer).map(([name, data]) => ({
            name, guild: data.guild || '', alliance: data.alliance || '',
            items: data.totalQty || 0, value: data.totalValue || 0,
            isEnemy: !!data.isEnemy
        })),
        events: events.map(e => ({
            t: e.timestamp, by: e.looted_by_name, byG: e.looted_by_guild,
            from: e.looted_from_name, item: e.item_id, qty: e.quantity || 1,
            w: e.weight || 0
        }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loot-session-${data.sessionId.slice(0, 20)}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Session exported as JSON', 'success');
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
    if (e.key !== 'Escape') return;
    // Close whichever modal is currently open (priority order: most-recently-opened first)
    const modalMap = [
        ['copy-preview-modal',    () => closeCopyPreviewModal()],
        ['guild-leaderboard-modal', () => closeGuildLeaderboard()],
        ['session-compare-modal', () => closeSessionCompare()],
        ['session-merge-modal',   () => closeSessionMerge()],
        ['share-session-modal',   () => closeShareSessionModal()],
        ['trip-summary-modal',    () => closeTripSummary()],
        ['loot-split-modal',      () => closeLootSplit()],
        ['whitelist-modal',       () => closeWhitelistModal()],
        ['feedback-modal',        () => closeFeedbackModal()],
        ['chart-modal',           () => { document.getElementById('chart-modal')?.classList.add('hidden'); }],
        ['cr-txn-modal',          () => { document.getElementById('cr-txn-modal')?.classList.add('hidden'); }],
        ['cr-scan-modal',         () => { document.getElementById('cr-scan-modal')?.classList.add('hidden'); }],
        ['ll-shortcut-help',      () => { document.getElementById('ll-shortcut-help')?.remove(); }],
    ];
    for (const [id, closeFn] of modalMap) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('hidden')) { closeFn(); return; }
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

// ===== CMD+K UNIVERSAL SEARCH =====
let _cmdkOpen = false;
function openCmdK() {
    if (_cmdkOpen) return;
    _cmdkOpen = true;
    const overlay = document.createElement('div');
    overlay.id = 'cmdk-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:var(--z-toast,10000);display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;';
    overlay.onclick = (e) => { if (e.target === overlay) closeCmdK(); };
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card,#1a1d26);border:1px solid var(--border-color,#2d3040);border-radius:12px;width:90%;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    modal.innerHTML = `<div style="padding:0.8rem 1rem;border-bottom:1px solid var(--border-color,#2d3040);">
        <input id="cmdk-input" type="text" placeholder="Search items, tabs, features... (Ctrl+K)" style="width:100%;background:transparent;border:none;outline:none;color:var(--text-primary);font-size:1rem;">
    </div><div id="cmdk-results" style="max-height:300px;overflow-y:auto;padding:0.4rem;"></div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const input = document.getElementById('cmdk-input');
    input.focus();
    input.addEventListener('input', () => renderCmdKResults(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCmdK();
        if (e.key === 'Enter') { const first = document.querySelector('.cmdk-item'); if (first) first.click(); }
    });
}
function closeCmdK() { _cmdkOpen = false; document.getElementById('cmdk-overlay')?.remove(); }
function renderCmdKResults(query) {
    const el = document.getElementById('cmdk-results');
    if (!el) return;
    const q = query.toLowerCase().trim();
    if (!q) { el.innerHTML = '<div style="padding:0.5rem;color:var(--text-muted);font-size:0.82rem;">Type to search items or tabs...</div>'; return; }
    const results = [];
    const tabLabels = {'browser':'Market Browser','flipper':'Market Flipper','bm-flipper':'BM Flipper','compare':'City Compare','top-traded':'Top Traded','item-power':'Item Power','favorites':'Favorites','crafting':'Crafting','journals':'Journals','rrr':'RRR Calculator','repair':'Repair Cost','transport':'Transport Routes','live-flips':'Live Flips','portfolio':'Portfolio','loot-buyer':'Loot Buyer','loot-logger':'Loot Logger','mounts':'Mounts','farm':'Farm & Breed','builds':'Community Builds','alerts':'Alerts','community':'Community','profile':'Profile','about':'About'};
    for (const [t, label] of Object.entries(tabLabels)) {
        if (label.toLowerCase().includes(q)) results.push({ type: 'tab', label, tab: t });
    }
    if (typeof allItemNames !== 'undefined' && allItemNames) {
        let count = 0;
        for (const [id, name] of Object.entries(allItemNames)) {
            if (count >= 8) break;
            if ((name || '').toLowerCase().includes(q) || id.toLowerCase().includes(q)) { results.push({ type: 'item', label: name || id, itemId: id }); count++; }
        }
    }
    if (!results.length) { el.innerHTML = '<div style="padding:0.5rem;color:var(--text-muted);font-size:0.82rem;">No results</div>'; return; }
    el.innerHTML = results.map(r => {
        if (r.type === 'tab') return `<div class="cmdk-item" onclick="closeCmdK();document.querySelector('[data-tab=\\'${r.tab}\\']')?.click()" style="padding:0.5rem 0.7rem;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:0.5rem;"><span style="font-size:0.7rem;padding:0.1rem 0.3rem;background:var(--accent);color:white;border-radius:4px;">TAB</span><span>${esc(r.label)}</span></div>`;
        return `<div class="cmdk-item" onclick="closeCmdK();document.querySelector('[data-tab=\\'browser\\']')?.click();setTimeout(()=>{const s=document.getElementById('search-item');if(s){s.value='${esc(r.itemId)}';s.dispatchEvent(new Event('input'));}},100)" style="padding:0.5rem 0.7rem;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:0.5rem;"><img src="https://render.albiononline.com/v1/item/${encodeURIComponent(r.itemId)}.png" style="width:22px;height:22px;" onerror="this.style.display='none'"><span>${esc(r.label)}</span><span style="font-size:0.67rem;color:var(--text-muted);margin-left:auto;">${esc(r.itemId)}</span></div>`;
    }).join('');
}
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openCmdK(); } });

// ===== IN-GAME TIMERS (status bar) =====
function initTimersWidget() {
    setInterval(() => {
        const now = new Date();
        const utcH = now.getUTCHours(), utcM = now.getUTCMinutes(), utcS = now.getUTCSeconds();
        const secToDaily = ((24 - utcH - 1) * 3600) + ((60 - utcM - 1) * 60) + (60 - utcS);
        const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        const secToMonthly = Math.floor((nextMonth - now) / 1000);
        const fmt = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`; };
        const el = document.getElementById('topbar-timers');
        if (el) el.textContent = `Daily: ${fmt(secToDaily)} \u2022 Monthly: ${fmt(secToMonthly)}`;
    }, 1000);
}

// ===== CONSUMED FLIP TRACKING =====
// FE-M5: try/catch on parse; FE-M3: prune stale/excess entries on load
let _consumedFlips; try { _consumedFlips = JSON.parse(localStorage.getItem('consumedFlips') || '{}'); } catch { _consumedFlips = {}; }
(function _pruneConsumedFlips() {
    const now = Date.now();
    // Remove entries older than 24h
    for (const k of Object.keys(_consumedFlips)) { if (now - _consumedFlips[k] > 86400000) delete _consumedFlips[k]; }
    // Hard cap at 1000 — if still over, drop oldest
    const keys = Object.keys(_consumedFlips);
    if (keys.length > 1000) {
        keys.sort((a, b) => _consumedFlips[a] - _consumedFlips[b]);
        keys.slice(0, keys.length - 1000).forEach(k => delete _consumedFlips[k]);
    }
    if (keys.length !== Object.keys(_consumedFlips).length) localStorage.setItem('consumedFlips', JSON.stringify(_consumedFlips));
})();
function markFlipConsumed(flipKey) {
    _consumedFlips[flipKey] = Date.now();
    localStorage.setItem('consumedFlips', JSON.stringify(_consumedFlips));
    const el = document.querySelector(`[data-flip-key="${flipKey}"]`);
    if (el) el.classList.add('flip-consumed');
    showToast('Flip marked as taken', 'info');
}
function isFlipConsumed(flipKey) {
    const ts = _consumedFlips[flipKey];
    if (!ts) return false;
    if (Date.now() - ts > 86400000) { delete _consumedFlips[flipKey]; localStorage.setItem('consumedFlips', JSON.stringify(_consumedFlips)); return false; }
    return true;
}

// ===== PRECONFIGURED ITEM LISTS =====
const ITEM_PRESETS = {
    'T4-T8 Leather Armor': ['T4_ARMOR_LEATHER_SET1','T4_ARMOR_LEATHER_SET2','T4_ARMOR_LEATHER_SET3','T5_ARMOR_LEATHER_SET1','T5_ARMOR_LEATHER_SET2','T5_ARMOR_LEATHER_SET3','T6_ARMOR_LEATHER_SET1','T6_ARMOR_LEATHER_SET2','T6_ARMOR_LEATHER_SET3','T7_ARMOR_LEATHER_SET1','T7_ARMOR_LEATHER_SET2','T7_ARMOR_LEATHER_SET3','T8_ARMOR_LEATHER_SET1','T8_ARMOR_LEATHER_SET2','T8_ARMOR_LEATHER_SET3'],
    'T5-T8 Plate Armor': ['T5_ARMOR_PLATE_SET1','T5_ARMOR_PLATE_SET2','T5_ARMOR_PLATE_SET3','T6_ARMOR_PLATE_SET1','T6_ARMOR_PLATE_SET2','T6_ARMOR_PLATE_SET3','T7_ARMOR_PLATE_SET1','T7_ARMOR_PLATE_SET2','T7_ARMOR_PLATE_SET3','T8_ARMOR_PLATE_SET1','T8_ARMOR_PLATE_SET2','T8_ARMOR_PLATE_SET3'],
    'Gathering Tools T5-T8': ['T5_TOOL_PICKAXE','T5_TOOL_SICKLE','T5_TOOL_SKINNINGKNIFE','T5_TOOL_WOODAXE','T5_TOOL_STONEHAMMER','T6_TOOL_PICKAXE','T6_TOOL_SICKLE','T6_TOOL_SKINNINGKNIFE','T6_TOOL_WOODAXE','T6_TOOL_STONEHAMMER','T7_TOOL_PICKAXE','T7_TOOL_SICKLE','T7_TOOL_SKINNINGKNIFE','T7_TOOL_WOODAXE','T7_TOOL_STONEHAMMER','T8_TOOL_PICKAXE','T8_TOOL_SICKLE','T8_TOOL_SKINNINGKNIFE','T8_TOOL_WOODAXE','T8_TOOL_STONEHAMMER'],
    'Transport Bags': ['T4_BAG','T5_BAG','T6_BAG','T7_BAG','T8_BAG','T4_BAG_INSIGHT','T5_BAG_INSIGHT','T6_BAG_INSIGHT','T7_BAG_INSIGHT','T8_BAG_INSIGHT'],
    'Popular Mounts': ['T5_MOUNT_OX','T7_MOUNT_OX','T8_MOUNT_MAMMOTH_TRANSPORT','T8_MOUNT_SWAMPDRAGON','T8_MOUNT_DIREBEAR','T8_MOUNT_DIREWOLF','T8_MOUNT_MAMMOTH_BATTLE']
};

// ===== REUSABLE HOVER TOOLTIP =====
// Any element with data-tip="..." (plain text) or data-tip-item="T8_BAG" (rich item tooltip)
// Optional companion data attributes on item tooltips:
//   data-tip-quality="4"  data-tip-crafter="Coldtouch"  data-tip-value="125000"
//   data-tip-source="loot" (renders "Unknown — looted" when crafter is missing)
let _tipEl = null;
let _tipTimer = null;
let _tipCurrent = null;

function ensureTooltipEl() {
    if (_tipEl) return _tipEl;
    const el = document.createElement('div');
    el.id = 'global-tooltip';
    el.className = 'global-tooltip hidden';
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
    _tipEl = el;
    return el;
}

function buildTooltipContent(target) {
    const itemId = target.dataset.tipItem;
    if (itemId) {
        const name = getFriendlyName(itemId) || itemId;
        const tier = (itemId.match(/^T(\d)/) || [])[1];
        const ench = extractEnchantment(itemId);
        const quality = target.dataset.tipQuality;
        const crafter = target.dataset.tipCrafter;
        const value = target.dataset.tipValue;
        const source = target.dataset.tipSource;
        const lines = [];
        lines.push(`<div class="tip-header">
            <img src="https://render.albiononline.com/v1/item/${encodeURIComponent(itemId)}.png${quality ? '?quality=' + encodeURIComponent(quality) : ''}" class="tip-icon" onerror="this.style.display='none'" alt="">
            <div class="tip-title-wrap">
                <div class="tip-title">${esc(name)}</div>
                <div class="tip-meta">${tier ? 'T' + tier : ''}${ench && ench !== '0' ? '.' + ench : ''}${quality && quality !== '1' ? ' · ' + esc(getQualityName(parseInt(quality))) : ''}</div>
            </div>
        </div>`);
        if (value && parseInt(value) > 0) lines.push(`<div class="tip-row"><span class="tip-label">Market value</span><span class="tip-val">${parseInt(value).toLocaleString()} 💰</span></div>`);
        if (crafter) lines.push(`<div class="tip-row"><span class="tip-label">Crafted by</span><span class="tip-val">${esc(crafter)}</span></div>`);
        else if (source === 'loot') lines.push(`<div class="tip-row muted"><span class="tip-label">Crafter</span><span class="tip-val">Unknown — looted</span></div>`);
        return lines.join('');
    }
    const txt = target.dataset.tip;
    if (txt) return `<div class="tip-simple">${esc(txt)}</div>`;
    return null;
}

function positionTooltip(target) {
    if (!_tipEl) return;
    const rect = target.getBoundingClientRect();
    const tipRect = _tipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 10;
    if (top < 10) top = rect.bottom + 10;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    _tipEl.style.left = left + 'px';
    _tipEl.style.top = top + 'px';
}

function showTooltipFor(target) {
    const content = buildTooltipContent(target);
    if (!content) return;
    const el = ensureTooltipEl();
    el.innerHTML = content;
    el.classList.remove('hidden');
    positionTooltip(target);
}

function hideTooltip() {
    if (_tipEl) _tipEl.classList.add('hidden');
    _tipCurrent = null;
}

document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tip], [data-tip-item]');
    if (!target || target === _tipCurrent) return;
    _tipCurrent = target;
    clearTimeout(_tipTimer);
    _tipTimer = setTimeout(() => showTooltipFor(target), 140);
});

document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-tip], [data-tip-item]');
    if (!target) return;
    const related = e.relatedTarget;
    if (related && target.contains(related)) return;
    clearTimeout(_tipTimer);
    hideTooltip();
});

document.addEventListener('scroll', hideTooltip, true);

// G2: Session Compare — pick two saved sessions, show them side-by-side with deltas.
async function openSessionCompare() {
    document.getElementById('session-compare-modal')?.classList.remove('hidden');
    document.getElementById('session-compare-body').innerHTML = '';
    await _populateSessionCompareDropdowns();
}
function closeSessionCompare() {
    document.getElementById('session-compare-modal')?.classList.add('hidden');
}
async function _populateSessionCompareDropdowns() {
    const a = document.getElementById('compare-session-a');
    const b = document.getElementById('compare-session-b');
    if (!a || !b) return;
    const savedNames = getSavedSessionNames();
    const fmt = (s) => {
        const started = new Date(s.started_at).toLocaleString();
        const label = savedNames[s.session_id] || started;
        return `<option value="${esc(s.session_id)}">${esc(label)} (${s.event_count || 0} events)</option>`;
    };
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders() });
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        const sessions = data.sessions || [];
        if (sessions.length < 2) {
            document.getElementById('session-compare-body').innerHTML = '<div class="empty-state"><p>Need at least 2 saved sessions to compare. Save some sessions first.</p></div>';
        }
        a.innerHTML = '<option value="">-- pick --</option>' + sessions.map(fmt).join('');
        b.innerHTML = '<option value="">-- pick --</option>' + sessions.map(fmt).join('');
        // Sensible defaults: latest two sessions
        if (sessions.length >= 1) a.value = sessions[0].session_id;
        if (sessions.length >= 2) b.value = sessions[1].session_id;
    } catch (e) {
        document.getElementById('session-compare-body').innerHTML = `<div class="empty-state"><p>Couldn't load sessions (login required).</p></div>`;
    }
}
async function _fetchSessionStats(sessionId) {
    const res = await fetch(`${VPS_BASE}/api/loot-session/${encodeURIComponent(sessionId)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    const events = data.events || [];
    const lootOnly = events.filter(e => e.item_id !== '__DEATH__');
    const deaths = events.filter(e => e.item_id === '__DEATH__');
    const players = new Set(lootOnly.map(e => e.looted_by_name)).size;
    const items = lootOnly.reduce((s, e) => s + (e.quantity || 1), 0);
    // Value estimate using the cached price map from the current session if available,
    // otherwise skip (we don't want to block comparison on a fresh price fetch)
    const priceMap = _llPriceMap || {};
    const value = lootOnly.reduce((s, e) => {
        const p = priceMap[e.item_id];
        return s + (p ? p.price * (e.quantity || 1) : 0);
    }, 0);
    const tsNums = events.map(e => +new Date(e.timestamp)).filter(n => !isNaN(n));
    const duration = tsNums.length > 1 ? Math.max(...tsNums) - Math.min(...tsNums) : 0;
    // Top 3 looters by item count
    const perPlayer = {};
    for (const ev of lootOnly) {
        const n = ev.looted_by_name || 'Unknown';
        if (!perPlayer[n]) perPlayer[n] = { items: 0, value: 0, guild: ev.looted_by_guild || '' };
        perPlayer[n].items += (ev.quantity || 1);
        const p = priceMap[ev.item_id];
        if (p) perPlayer[n].value += p.price * (ev.quantity || 1);
    }
    const ranked = Object.entries(perPlayer).sort((a, b) => b[1].value - a[1].value || b[1].items - a[1].items).slice(0, 3);
    return { events: events.length, players, items, value, deaths: deaths.length, duration, topLooters: ranked };
}
async function runSessionCompare() {
    const aId = document.getElementById('compare-session-a').value;
    const bId = document.getElementById('compare-session-b').value;
    const body = document.getElementById('session-compare-body');
    if (!aId || !bId) { body.innerHTML = '<div class="empty-state"><p>Pick both sessions first.</p></div>'; return; }
    if (aId === bId) { body.innerHTML = '<div class="empty-state"><p>Pick two different sessions.</p></div>'; return; }
    body.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    try {
        const [statsA, statsB] = await Promise.all([_fetchSessionStats(aId), _fetchSessionStats(bId)]);
        const savedNames = getSavedSessionNames();
        const a = document.getElementById('compare-session-a');
        const b = document.getElementById('compare-session-b');
        const labelA = savedNames[aId] || a.options[a.selectedIndex]?.textContent || 'Session A';
        const labelB = savedNames[bId] || b.options[b.selectedIndex]?.textContent || 'Session B';
        body.innerHTML = renderCompareStats(statsA, statsB, labelA, labelB);
    } catch (e) {
        body.innerHTML = `<div class="empty-state"><p>Failed to load: ${esc(e.message)}</p></div>`;
    }
}
function renderCompareStats(a, b, labelA, labelB) {
    const delta = (va, vb) => {
        if (va === vb) return '<span class="compare-delta same">=</span>';
        const diff = vb - va;
        const cls = diff > 0 ? 'gain' : 'loss';
        const arrow = diff > 0 ? '▲' : '▼';
        return `<span class="compare-delta ${cls}">${arrow} ${Math.abs(diff).toLocaleString()}</span>`;
    };
    const deltaSilver = (va, vb) => {
        if (va === vb || (va === 0 && vb === 0)) return '<span class="compare-delta same">=</span>';
        const diff = vb - va;
        const cls = diff > 0 ? 'gain' : 'loss';
        const arrow = diff > 0 ? '▲' : '▼';
        return `<span class="compare-delta ${cls}">${arrow} ${formatSilver(Math.abs(diff))}</span>`;
    };
    const fmtDur = (ms) => {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    const rows = [
        ['Events', a.events, b.events, delta(a.events, b.events)],
        ['Items looted', a.items, b.items, delta(a.items, b.items)],
        ['Unique players', a.players, b.players, delta(a.players, b.players)],
        ['Deaths', a.deaths, b.deaths, delta(a.deaths, b.deaths)],
        ['Duration', fmtDur(a.duration), fmtDur(b.duration), ''],
        ['Est. value', a.value > 0 ? formatSilver(a.value) : '—', b.value > 0 ? formatSilver(b.value) : '—', (a.value > 0 && b.value > 0) ? deltaSilver(a.value, b.value) : '']
    ];
    const topList = (list) => list.length > 0
        ? `<ol class="compare-top-list">${list.map(([n, d]) => `<li><strong>${esc(n)}</strong>${d.guild ? ` [${esc(d.guild)}]` : ''} <span style="color:var(--text-muted); font-size:0.72rem;">— ${d.items} items${d.value > 0 ? `, ${formatSilver(d.value)}` : ''}</span></li>`).join('')}</ol>`
        : '<p style="color:var(--text-muted); font-size:0.75rem;">None</p>';
    return `
        <div class="compare-headers">
            <div class="compare-header-a">${esc(labelA)}</div>
            <div class="compare-header-b">${esc(labelB)}</div>
        </div>
        <table class="compare-stats-table">
            <tbody>
                ${rows.map(([label, va, vb, d]) => `<tr>
                    <th>${label}</th>
                    <td>${va.toLocaleString ? va.toLocaleString() : va}</td>
                    <td>${vb.toLocaleString ? vb.toLocaleString() : vb}</td>
                    <td class="compare-delta-cell">${d || ''}</td>
                </tr>`).join('')}
            </tbody>
        </table>
        <div class="compare-top-grid">
            <div>
                <div class="compare-subhead">Top looters — ${esc(labelA)}</div>
                ${topList(a.topLooters)}
            </div>
            <div>
                <div class="compare-subhead">Top looters — ${esc(labelB)}</div>
                ${topList(b.topLooters)}
            </div>
        </div>
    `;
}

// === G4: Share session (public read-only URLs) ===
let _shareCurrentSessionId = null;
let _shareCurrentToken = null;

function _shareUrlForToken(token) {
    return `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(token)}`;
}

function openShareSessionModal(sessionId, existingToken) {
    _shareCurrentSessionId = sessionId;
    _shareCurrentToken = existingToken || null;
    document.getElementById('share-session-modal')?.classList.remove('hidden');
    _renderShareSessionBody();
}

function closeShareSessionModal() {
    document.getElementById('share-session-modal')?.classList.add('hidden');
    _shareCurrentSessionId = null;
    _shareCurrentToken = null;
}

function _renderShareSessionBody() {
    const body = document.getElementById('share-session-body');
    if (!body) return;
    if (_shareCurrentToken) {
        const url = _shareUrlForToken(_shareCurrentToken);
        body.innerHTML = `
            <div style="background:var(--bg-elevated); border:1px solid var(--border-color); border-radius:6px; padding:0.6rem 0.8rem; margin-bottom:0.75rem;">
                <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:0.25rem;">Public URL</div>
                <div style="display:flex; gap:0.5rem; align-items:center;">
                    <input type="text" id="share-url-input" readonly value="${esc(url)}" style="flex:1; background:var(--bg-primary); border:1px solid var(--border-color); border-radius:4px; padding:0.4rem 0.5rem; color:var(--text-primary); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:0.76rem;">
                    <button class="btn-small-accent" onclick="_copyShareUrl()">📋 Copy</button>
                </div>
            </div>
            <p style="font-size:0.78rem; color:var(--text-secondary); margin:0 0 0.75rem;">
                Anyone with this link can view the session's events + per-player breakdown. They can't edit, delete, or see your other sessions.
            </p>
            <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
                <button class="btn-small" onclick="closeShareSessionModal()">Close</button>
                <button class="btn-small-danger" onclick="_revokeShare()">Revoke link</button>
            </div>`;
    } else {
        body.innerHTML = `
            <p style="font-size:0.82rem; color:var(--text-primary); margin:0 0 0.75rem;">
                This session isn't shared yet. Click below to generate a public URL.
            </p>
            <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
                <button class="btn-small" onclick="closeShareSessionModal()">Cancel</button>
                <button class="btn-small-accent" onclick="_createShare()">🔗 Create share link</button>
            </div>`;
    }
}

async function _createShare() {
    if (!_shareCurrentSessionId) return;
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-session/${encodeURIComponent(_shareCurrentSessionId)}/share`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Share failed');
        _shareCurrentToken = data.token;
        _renderShareSessionBody();
        showToast('Share link created', 'success');
        // Refresh session list so the shared badge updates
        if (lootLoggerMode === 'live') loadLootSessions();
    } catch(e) {
        showToast('Failed to share: ' + e.message, 'error');
    }
}

async function _revokeShare() {
    if (!_shareCurrentSessionId) return;
    showConfirm('Revoke the share link? Anyone with the old link will get a 404.', async () => {
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-session/${encodeURIComponent(_shareCurrentSessionId)}/unshare`, {
            method: 'POST',
            headers: authHeaders()
        });
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Revoke failed');
        }
        _shareCurrentToken = null;
        _renderShareSessionBody();
        showToast('Share link revoked', 'success');
        if (lootLoggerMode === 'live') loadLootSessions();
    } catch(e) {
        showToast('Failed to revoke: ' + e.message, 'error');
    }
    });
}

function _copyShareUrl() {
    const input = document.getElementById('share-url-input');
    if (!input) return;
    navigator.clipboard.writeText(input.value)
        .then(() => showToast('Share URL copied to clipboard', 'success'))
        .catch(() => { input.select(); showToast('Press Ctrl+C to copy', 'info'); });
}

// G4: if the URL has ?share=xxx, fetch + render the public session view.
// 2026-04-18: also handles ?accShare=xxx for accountability shares.
// Runs on load before any login check so guild members without accounts can view.
async function _handlePublicShareLoad() {
    const params = new URLSearchParams(window.location.search);
    const sessionToken = params.get('share');
    const accToken = params.get('accShare');
    if (!sessionToken && !accToken) return;
    try {
        if (accToken) {
            const res = await fetch(`${VPS_BASE}/api/accountability/public/${encodeURIComponent(accToken)}`);
            if (!res.ok) {
                const data = await res.json();
                _renderPublicShareError(data.error || 'Failed to load shared accountability');
                return;
            }
            const data = await res.json();
            _renderPublicAccountabilityView(data);
            return;
        }
        const res = await fetch(`${VPS_BASE}/api/public/loot-session/${encodeURIComponent(sessionToken)}`);
        if (!res.ok) {
            const data = await res.json();
            _renderPublicShareError(data.error || 'Failed to load shared session');
            return;
        }
        const data = await res.json();
        _renderPublicShareView(data);
    } catch(e) {
        _renderPublicShareError('Network error loading shared link');
    }
}

// Render shared ACCOUNTABILITY inside the normal Loot Logger → Accountability tab
// (no overlay, no "Continue to Coldtouch" button). The recipient sees exactly what
// the share owner saw when they clicked Share — full accountability result with
// deposit-status dots, suspects banner, player cards, everything. A thin read-only
// banner is added at the top of the tab with the share metadata.
//
// Approach: hide the landing overlay, navigate to Loot Logger → Accountability,
// inject the shared events + captures into the same logic path that runs when a
// user clicks Run Check. This reuses 100% of the existing accountability render.
async function _renderPublicAccountabilityView(data) {
    // 0. Flag active so populateAccountabilityDropdowns leaves our synthetic state alone.
    window._sharedAccountabilityActive = true;

    // 1. Kill the landing overlay so the view is usable without forcing login.
    const landing = document.getElementById('landing-overlay');
    if (landing) { landing.style.display = 'none'; landing.classList.add('dismissed'); }

    // 2. Wait for the basic app init (tabs, handlers) to be in place before navigating.
    //    `init()` runs on DOMContentLoaded — we may get here before it finishes.
    const waitFor = (pred, timeout = 5000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() - start > timeout) return reject(new Error('timeout'));
            setTimeout(tick, 50);
        };
        tick();
    });
    try {
        await waitFor(() => typeof populateAccountabilityDropdowns === 'function' && document.querySelector('[data-tab="loot-logger"]'));
    } catch { /* init didn't come — render anyway, may fail gracefully */ }

    // 3. Navigate to Loot Logger → Accountability.
    document.querySelector('[data-tab="loot-logger"]')?.click();
    if (typeof showLootLoggerMode === 'function') showLootLoggerMode('accountability');

    // 4. Inject the shared captures into window._chestCaptures (without disturbing any
    //    existing captures the viewer may have). We'll select only the shared ones.
    window._chestCaptures = window._chestCaptures || [];
    const sharedCapStartIdx = window._chestCaptures.length;
    for (const cap of (data.captures || [])) {
        const shared = { ...cap, _isSharedView: true };
        normalizeChestCaptureInPlace(shared); // recover UNKNOWN_<n> items from shared view
        window._chestCaptures.push(shared);
    }

    // 4b. Inject the shared chest-log batches (opcode 157 deposit/withdraw ground
    //     truth) into window._chestLogBatches so runAccountabilityCheck can build
    //     its `chestLogDeposits` map and render the "verified deposited" badges
    //     the owner saw. Prior to this, shares omitted this snapshot entirely
    //     and recipients saw a stale, pre-chest-log rendering.
    window._chestLogBatches = window._chestLogBatches || [];
    const sharedLogStartIdx = window._chestLogBatches.length;
    const sharedChestLogs = Array.isArray(data.chestLogs) ? data.chestLogs : [];
    for (const batch of sharedChestLogs) {
        window._chestLogBatches.push({ ...batch, _isSharedView: true });
    }

    // 5. Pre-populate the dropdowns so runAccountabilityCheck reads exactly what was shared.
    const sessionSel = document.getElementById('acc-session-select');
    const captureSel = document.getElementById('acc-capture-select');
    const chestLogSel = document.getElementById('acc-chestlog-select');
    if (sessionSel) {
        // Synthetic option for the shared session id so the dropdown accepts it.
        const stubVal = '__shared__';
        sessionSel.innerHTML = `<option value="${stubVal}" selected>🔗 Shared: ${esc(data.sessionName || 'accountability check')}</option>`;
        sessionSel.value = stubVal;
    }
    if (captureSel) {
        // Build options for each shared capture + mark them selected.
        captureSel.innerHTML = (data.captures || []).map((cap, i) => {
            const name = cap.tabName || `Shared capture ${i + 1}`;
            const count = cap.items?.length || 0;
            return `<option value="${sharedCapStartIdx + i}" selected>${esc(name)} — ${count} items</option>`;
        }).join('');
    }
    if (chestLogSel && sharedChestLogs.length > 0) {
        // Mark userInteracted so populateAccountabilityDropdowns doesn't later
        // rebuild this dropdown and drop our indexes into the shared batches.
        chestLogSel.dataset.userInteracted = 'yes';
        chestLogSel.innerHTML = sharedChestLogs.map((b, i) => {
            const action = b.action || 'unknown';
            const icon = action === 'deposit' ? '📥' : action === 'withdraw' ? '📤' : '❔';
            const count = (b.entries || []).length;
            return `<option value="${sharedLogStartIdx + i}" selected>${icon} ${esc(action)} — ${count} entries (shared)</option>`;
        }).join('');
    }

    // 6. Stash the shared events + sessionId so runAccountabilityCheck fetches them from memory
    //    instead of hitting the private /api/loot-session endpoint (which requires auth).
    window._sharedAccountabilityEvents = data.events || [];
    window._sharedAccountabilitySessionId = '__shared__';
    window._sharedAccountabilityMeta = {
        sessionName: data.sessionName || '',
        createdAt: data.createdAt || 0,
    };

    // 7. Add a thin banner above the accountability pane so the recipient knows it's a share.
    const pane = document.getElementById('pane-loot-logger');
    if (pane && !document.getElementById('shared-acc-banner')) {
        const when = data.createdAt ? new Date(data.createdAt).toLocaleString() : '';
        const banner = document.createElement('div');
        banner.id = 'shared-acc-banner';
        banner.style.cssText = 'background:linear-gradient(90deg, rgba(88,101,242,0.14), rgba(88,101,242,0.06)); border:1px solid rgba(88,101,242,0.35); border-radius:8px; padding:0.55rem 0.9rem; margin:0.5rem 0 0.75rem; font-size:0.82rem; color:#c7d2ff; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;';
        banner.innerHTML = `
            <span>🔗</span>
            <span><strong>Shared accountability check</strong>${data.sessionName ? ` — "${esc(data.sessionName)}"` : ''}${when ? ` · created ${esc(when)}` : ''}</span>
            <span style="margin-left:auto; color:var(--text-muted); font-size:0.72rem;">Read-only view — ${(data.events || []).length} events · ${(data.captures || []).length} chest capture${(data.captures || []).length !== 1 ? 's' : ''}${sharedChestLogs.length > 0 ? ` · ${sharedChestLogs.length} log batch${sharedChestLogs.length !== 1 ? 'es' : ''}` : ''}</span>`;
        // Insert right at the top of the accountability mode container.
        const accMode = document.getElementById('loot-log-accountability');
        if (accMode) accMode.insertBefore(banner, accMode.firstChild);
        else pane.insertBefore(banner, pane.firstChild);
    }

    // 8. Run the accountability check — uses the same code path as a normal user click.
    if (typeof runAccountabilityCheck === 'function') {
        // Give the DOM a beat to settle after dropdown injection.
        setTimeout(() => runAccountabilityCheck(), 100);
    }
}

function _renderPublicShareError(msg) {
    const overlay = document.createElement('div');
    overlay.id = 'public-share-overlay';
    overlay.innerHTML = `
        <div class="public-share-box">
            <h2>Shared session unavailable</h2>
            <p>${esc(msg)}</p>
            <p style="font-size:0.78rem; color:var(--text-muted); margin-top:0.5rem;">The link may have been revoked.</p>
            <a href="${window.location.pathname}" class="btn-small-accent" style="display:inline-block; margin-top:0.75rem; text-decoration:none;">Continue to Coldtouch</a>
        </div>`;
    document.body.appendChild(overlay);
}

// Render shared LOOT SESSION inside the normal Loot Logger → Upload mode pane —
// recipient sees the EXACT same report the uploader saw (full death timeline,
// player cards, deaths section, export buttons, etc.). No separate overlay, no
// "Continue to Coldtouch" button. A thin banner at the top marks it read-only.
//
// Mirror of _renderPublicAccountabilityView (line ~16636) which uses the same
// approach for accountability shares.
async function _renderPublicShareView(data) {
    // 0. Flag active so action-row templates skip the Share/Accountability
    //    buttons (non-functional for an unauthenticated viewer).
    window._sharedSessionViewActive = true;

    // 1. Kill the landing overlay so the view is usable without forcing login.
    const landing = document.getElementById('landing-overlay');
    if (landing) { landing.style.display = 'none'; landing.classList.add('dismissed'); }

    // 2. Wait for the basic app init (tabs, handlers) to be in place before navigating.
    const waitFor = (pred, timeout = 5000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() - start > timeout) return reject(new Error('timeout'));
            setTimeout(tick, 50);
        };
        tick();
    });
    try {
        await waitFor(() => typeof showLootLoggerMode === 'function' && document.querySelector('[data-tab="loot-logger"]'));
    } catch { /* init didn't come — render anyway, may fail gracefully */ }

    // 3. Navigate to Loot Logger → Upload mode (the same pane the uploader uses).
    document.querySelector('[data-tab="loot-logger"]')?.click();
    if (typeof showLootLoggerMode === 'function') showLootLoggerMode('upload');

    // 4. Hide the upload input card — viewer can't upload anything and the
    //    "Choose Files" prompt would be confusing for a read-only share.
    //    Target the file input's wrapping card directly (more robust than a
    //    positional selector, which breaks once we insert the banner).
    const uploadCard = document.getElementById('loot-log-file-input')?.closest('div');
    if (uploadCard) uploadCard.style.display = 'none';

    // 5. Inject a thin banner above the result area so the recipient knows it's a share.
    const uploadPane = document.getElementById('loot-log-upload');
    if (uploadPane && !document.getElementById('shared-session-banner')) {
        const when = data.sharedAt ? new Date(data.sharedAt).toLocaleString() : '';
        const banner = document.createElement('div');
        banner.id = 'shared-session-banner';
        banner.style.cssText = 'background:linear-gradient(90deg, rgba(88,101,242,0.14), rgba(88,101,242,0.06)); border:1px solid rgba(88,101,242,0.35); border-radius:8px; padding:0.55rem 0.9rem; margin:0.5rem 0 0.75rem; font-size:0.82rem; color:#c7d2ff; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;';
        banner.innerHTML = `
            <span>🔗</span>
            <span><strong>Shared loot session</strong>${when ? ` · shared ${esc(when)}` : ''}</span>
            <span style="margin-left:auto; color:var(--text-muted); font-size:0.72rem;">Read-only view — ${(data.events || []).length} events</span>`;
        uploadPane.insertBefore(banner, uploadPane.firstChild);
    }

    // 6. Mark the session id so the report's action row has something to key off of
    //    (Share/Accountability buttons already suppressed via _sharedSessionViewActive).
    _llCurrentSessionId = data.sessionId || '__shared__';

    // 7. Render into the same target the uploader sees (#loot-upload-result).
    const target = document.getElementById('loot-upload-result');
    if (!target) return;
    renderLootSessionEvents(data.events || [], target, null).catch(e => {
        target.innerHTML = `<div class="empty-state"><p>Failed to render shared session: ${esc(e.message)}</p></div>`;
    });
}

// Trigger on page load — runs once after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _handlePublicShareLoad);
} else {
    _handlePublicShareLoad();
}

// G14: Trip Summary — cross-feature dashboard pulling from Loot Logger + Loot Buyer.
// Shows running totals for the selected time window (default 24h).
let _tripWindow = (() => { try { return localStorage.getItem('albion_trip_window') || '24h'; } catch { return '24h'; } })();

function openTripSummary() {
    document.getElementById('trip-summary-modal')?.classList.remove('hidden');
    _renderTripSummary();
}
function closeTripSummary() {
    document.getElementById('trip-summary-modal')?.classList.add('hidden');
}
function setTripWindow(win) {
    _tripWindow = win;
    try { localStorage.setItem('albion_trip_window', win); } catch {}
    // Update button highlighting
    document.querySelectorAll('#trip-summary-modal [data-window]').forEach(b => {
        b.classList.toggle('btn-small-accent', b.dataset.window === win);
        b.classList.toggle('btn-small', b.dataset.window !== win);
    });
    _renderTripSummary();
}

function _tripWindowCutoff() {
    const now = Date.now();
    if (_tripWindow === '24h') return now - 24 * 3600 * 1000;
    if (_tripWindow === '7d') return now - 7 * 24 * 3600 * 1000;
    return 0; // all time
}

// === G10: Loot Split Calculator ===
// Splits silver between participants with weights and an off-the-top deduction
// (covers tax/repair/scout cuts). Persists between opens via localStorage.
const _LOOT_SPLIT_LS_KEY = 'albion_loot_split_state_v1';
let _lootSplitState = null;

function _lootSplitDefaultState() {
    return {
        total: 0,
        deduction: 10,
        deductionMode: 'percent',
        participants: [
            { name: 'Player 1', weight: 1, bonus: 0 },
            { name: 'Player 2', weight: 1, bonus: 0 }
        ]
    };
}
function _lootSplitLoad() {
    try {
        const raw = localStorage.getItem(_LOOT_SPLIT_LS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.participants) && parsed.participants.length > 0) return parsed;
        }
    } catch {}
    return _lootSplitDefaultState();
}
function _lootSplitSave() {
    try { localStorage.setItem(_LOOT_SPLIT_LS_KEY, JSON.stringify(_lootSplitState)); } catch {}
}

function openLootSplit() {
    _lootSplitState = _lootSplitLoad();
    document.getElementById('loot-split-modal')?.classList.remove('hidden');
    const totalEl = document.getElementById('loot-split-total');
    const dedEl = document.getElementById('loot-split-deduction');
    const dedModeEl = document.getElementById('loot-split-deduction-mode');
    if (totalEl) totalEl.value = _lootSplitState.total;
    if (dedEl) dedEl.value = _lootSplitState.deduction;
    if (dedModeEl) dedModeEl.value = _lootSplitState.deductionMode;
    lootSplitRender();
}
function closeLootSplit() {
    document.getElementById('loot-split-modal')?.classList.add('hidden');
}
function lootSplitReset() {
    _lootSplitState = _lootSplitDefaultState();
    _lootSplitSave();
    openLootSplit();
}
function lootSplitAddRow() {
    if (!_lootSplitState) _lootSplitState = _lootSplitLoad();
    const n = _lootSplitState.participants.length + 1;
    _lootSplitState.participants.push({ name: `Player ${n}`, weight: 1, bonus: 0 });
    _lootSplitSave();
    lootSplitRender();
}
function lootSplitRemoveRow(idx) {
    if (!_lootSplitState) return;
    _lootSplitState.participants.splice(idx, 1);
    if (_lootSplitState.participants.length === 0) {
        _lootSplitState.participants.push({ name: 'Player 1', weight: 1, bonus: 0 });
    }
    _lootSplitSave();
    lootSplitRender();
}
function _lootSplitReadInputs() {
    if (!_lootSplitState) _lootSplitState = _lootSplitLoad();
    const totalEl = document.getElementById('loot-split-total');
    const dedEl = document.getElementById('loot-split-deduction');
    const dedModeEl = document.getElementById('loot-split-deduction-mode');
    _lootSplitState.total = Math.max(0, parseFloat(totalEl?.value) || 0);
    _lootSplitState.deduction = Math.max(0, parseFloat(dedEl?.value) || 0);
    _lootSplitState.deductionMode = dedModeEl?.value || 'percent';
    document.querySelectorAll('#loot-split-rows [data-row-idx]').forEach(row => {
        const i = parseInt(row.dataset.rowIdx, 10);
        if (!_lootSplitState.participants[i]) return;
        const nameEl = row.querySelector('.ls-name');
        const wEl = row.querySelector('.ls-weight');
        const bEl = row.querySelector('.ls-bonus');
        _lootSplitState.participants[i].name = (nameEl?.value || '').slice(0, 32);
        _lootSplitState.participants[i].weight = Math.max(0, parseFloat(wEl?.value) || 0);
        _lootSplitState.participants[i].bonus = Math.max(0, parseFloat(bEl?.value) || 0);
    });
}
function _lootSplitCompute() {
    if (!_lootSplitState) _lootSplitState = _lootSplitLoad();
    const s = _lootSplitState;
    const total = s.total;
    const dedAmt = s.deductionMode === 'percent'
        ? Math.min(total, total * (s.deduction / 100))
        : Math.min(total, s.deduction);
    const totalBonus = s.participants.reduce((a, p) => a + (p.bonus || 0), 0);
    const remaining = Math.max(0, total - dedAmt - totalBonus);
    const totalWeight = s.participants.reduce((a, p) => a + (p.weight || 0), 0);
    const shares = s.participants.map(p => {
        const wShare = totalWeight > 0 ? remaining * (p.weight / totalWeight) : 0;
        return { ...p, payout: Math.round(wShare + (p.bonus || 0)) };
    });
    const paidOut = shares.reduce((a, p) => a + p.payout, 0);
    return { total, dedAmt, totalBonus, remaining, totalWeight, shares, paidOut };
}
function lootSplitRender() {
    const rowsEl = document.getElementById('loot-split-rows');
    const sumEl = document.getElementById('loot-split-summary');
    if (!rowsEl || !sumEl) return;
    _lootSplitReadInputs();
    _lootSplitSave();
    const result = _lootSplitCompute();
    rowsEl.innerHTML = result.shares.map((p, i) => `
        <div data-row-idx="${i}" style="display:grid; grid-template-columns:minmax(0,1.6fr) 70px 110px minmax(0,1fr) 28px; gap:0.4rem; align-items:center; padding:0.35rem 0.45rem; background:var(--bg-primary); border:1px solid var(--border-color); border-radius:6px;">
            <input type="text" class="ls-name" value="${esc(p.name)}" maxlength="32" placeholder="Name" style="background:transparent; border:none; color:var(--text-primary); font-size:0.85rem; outline:none;" oninput="lootSplitRender()">
            <input type="number" class="ls-weight" value="${p.weight}" min="0" step="0.5" title="Share weight (1 = standard share)" style="background:transparent; border:none; color:var(--text-secondary); font-size:0.82rem; text-align:center; outline:none;" oninput="lootSplitRender()">
            <input type="number" class="ls-bonus" value="${p.bonus}" min="0" step="1000" title="Fixed bonus paid before split (e.g. caller cut)" placeholder="bonus" style="background:transparent; border:none; color:var(--text-secondary); font-size:0.82rem; text-align:right; outline:none;" oninput="lootSplitRender()">
            <span style="text-align:right; font-weight:600; color:var(--accent); font-size:0.88rem;" title="Total payout = weighted share + bonus">${p.payout.toLocaleString()}</span>
            <button onclick="lootSplitRemoveRow(${i})" title="Remove" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; font-size:1rem; padding:0; line-height:1;">×</button>
        </div>
    `).join('');
    const dedLabel = _lootSplitState.deductionMode === 'percent'
        ? `${_lootSplitState.deduction.toFixed(1)}%`
        : `${Math.round(_lootSplitState.deduction).toLocaleString()} silver`;
    sumEl.innerHTML = `
        <div style="display:flex; flex-wrap:wrap; gap:0.6rem 1.2rem; justify-content:space-between;">
            <span><strong>Pot:</strong> ${result.total.toLocaleString()} silver</span>
            <span><strong>Deducted (${dedLabel}):</strong> ${Math.round(result.dedAmt).toLocaleString()}</span>
            <span><strong>Bonuses:</strong> ${result.totalBonus.toLocaleString()}</span>
            <span><strong>Split pool:</strong> ${Math.round(result.remaining).toLocaleString()}</span>
            <span><strong>Paid out:</strong> ${result.paidOut.toLocaleString()}</span>
        </div>
    `;
}
async function lootSplitImportFromSession() {
    if (!_lootSplitState) _lootSplitState = _lootSplitLoad();
    const events = (typeof liveLootEvents !== 'undefined' && Array.isArray(liveLootEvents)) ? liveLootEvents : [];
    const lootOnly = events.filter(e => (e.item_id || e.itemId || '') !== '__DEATH__');
    if (lootOnly.length === 0) {
        if (typeof showToast === 'function') showToast('No loot events in current session', 'warn');
        return;
    }
    let prices;
    try { prices = await getPriceCache(); } catch { prices = []; }
    const priceMap = new Map();
    for (const p of (prices || [])) {
        const id = p.item_id || p.itemId;
        if (!id) continue;
        const px = p.sell_price_min || p.price_min || 0;
        if (px > 0) {
            const cur = priceMap.get(id) || 0;
            if (px > cur) priceMap.set(id, px); // best-city max as conservative valuation
        }
    }
    let total = 0;
    let priced = 0;
    let missing = 0;
    for (const ev of lootOnly) {
        const id = ev.item_id || ev.itemId || '';
        const qty = ev.quantity || ev.amount || 1;
        const px = priceMap.get(id) || 0;
        if (px > 0) { total += px * qty; priced++; } else { missing++; }
    }
    _lootSplitState.total = Math.round(total);
    _lootSplitSave();
    const totalEl = document.getElementById('loot-split-total');
    if (totalEl) totalEl.value = _lootSplitState.total;
    lootSplitRender();
    if (typeof showToast === 'function') {
        showToast(`Imported ${total.toLocaleString()} silver from ${priced} items (${missing} unpriced)`, 'success');
    }
}
function lootSplitCopyDiscord() {
    _lootSplitReadInputs();
    const result = _lootSplitCompute();
    const dedLabel = _lootSplitState.deductionMode === 'percent'
        ? `${_lootSplitState.deduction.toFixed(1)}%`
        : `${Math.round(_lootSplitState.deduction).toLocaleString()} silver`;
    const lines = [
        '**💰 Loot Split**',
        `Pot: \`${result.total.toLocaleString()}\` silver`,
        `Deducted (${dedLabel}): \`${Math.round(result.dedAmt).toLocaleString()}\``,
        result.totalBonus > 0 ? `Bonuses: \`${result.totalBonus.toLocaleString()}\`` : null,
        `Split pool: \`${Math.round(result.remaining).toLocaleString()}\``,
        '',
        ...result.shares.map(p => {
            const tag = (p.bonus || 0) > 0 ? ` _(+${p.bonus.toLocaleString()} bonus)_` : '';
            return `• **${p.name}** — \`${p.payout.toLocaleString()}\`${tag}`;
        })
    ].filter(Boolean);
    if (typeof openCopyPreview === 'function') {
        openCopyPreview('Preview — Loot Split', lines.join('\n'), 'Loot split copied');
    }
}

async function _renderTripSummary() {
    const body = document.getElementById('trip-summary-body');
    if (!body) return;
    body.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    setTripWindow; // keep linter happy
    // Highlight the active window button
    document.querySelectorAll('#trip-summary-modal [data-window]').forEach(b => {
        b.classList.toggle('btn-small-accent', b.dataset.window === _tripWindow);
        b.classList.toggle('btn-small', b.dataset.window !== _tripWindow);
    });
    const cutoff = _tripWindowCutoff();
    const authed = !!localStorage.getItem('albion_auth_token') || !!discordUser;

    // Fetch in parallel
    const [sessionsRes, tabsRes, salesRes] = await Promise.all([
        authed ? fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null) : null,
        authed ? fetch(`${VPS_BASE}/api/loot-tabs`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null) : null,
        authed ? fetch(`${VPS_BASE}/api/sale-notifications`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null) : null
    ]);

    const sessions = (sessionsRes?.sessions || []).filter(s => +new Date(s.started_at) >= cutoff);
    const tabs = (tabsRes?.tabs || []).filter(t => (+t.purchasedAt || 0) >= cutoff);
    const sales = (salesRes?.sales || salesRes || []).filter(s => +new Date(s.sold_at || s.soldAt || 0) >= cutoff);

    // Logger totals
    const lootSessionCount = sessions.length;
    const lootEventCount = sessions.reduce((s, x) => s + (x.event_count || 0), 0);
    const lootPlayerCount = sessions.reduce((s, x) => Math.max(s, x.player_count || 0), 0);
    // Pull current live session if its window overlaps
    if (liveLootEvents && liveLootEvents.length > 0) {
        const firstTs = Math.min(...liveLootEvents.map(e => +new Date(e.timestamp)).filter(n => !isNaN(n)));
        if (firstTs >= cutoff) {
            // We don't double-count — just include live events that haven't been saved yet.
            // Since the user may not have saved, include them.
        }
    }

    // Buyer totals
    const tabsBoughtCount = tabs.length;
    const totalPaid = tabs.reduce((s, t) => s + (t.purchasePrice || 0), 0);
    const totalRevenue = tabs.reduce((s, t) => s + (t.revenueSoFar || 0), 0);
    const netBuyer = totalRevenue - totalPaid;
    const salesCount = sales.length;
    const salesValue = sales.reduce((s, x) => s + ((x.sale_price || x.salePrice || 0) * (x.quantity || 1)), 0);

    // Render
    const windowLabel = _tripWindow === '24h' ? 'last 24 hours' : _tripWindow === '7d' ? 'last 7 days' : 'all time';
    if (!authed) {
        body.innerHTML = `<div class="empty-state">
            <p>Log in with Discord or email to see your trip summary.</p>
            <p class="hint" style="font-size:0.75rem; color:var(--text-muted);">Trip Summary aggregates Loot Logger sessions, tracked Loot Buyer tabs, and sale notifications across the selected window.</p>
        </div>`;
        return;
    }
    body.innerHTML = `
        <p style="color:var(--text-muted); font-size:0.8rem; margin:0 0 0.75rem;">Showing totals for the <strong style="color:var(--text-primary);">${windowLabel}</strong>.</p>

        <div class="trip-section">
            <div class="trip-section-title">📋 Loot Logger</div>
            <div class="trip-stats">
                <div class="trip-stat"><span class="trip-label">Sessions</span><span class="trip-val">${lootSessionCount}</span></div>
                <div class="trip-stat"><span class="trip-label">Events</span><span class="trip-val">${lootEventCount.toLocaleString()}</span></div>
                <div class="trip-stat"><span class="trip-label">Peak players</span><span class="trip-val">${lootPlayerCount}</span></div>
            </div>
        </div>

        <div class="trip-section">
            <div class="trip-section-title">📦 Loot Buyer</div>
            <div class="trip-stats">
                <div class="trip-stat"><span class="trip-label">Tabs bought</span><span class="trip-val">${tabsBoughtCount}</span></div>
                <div class="trip-stat"><span class="trip-label">Paid</span><span class="trip-val loss">${totalPaid > 0 ? formatSilver(totalPaid) : '—'}</span></div>
                <div class="trip-stat"><span class="trip-label">Revenue (tracked)</span><span class="trip-val gain">${totalRevenue > 0 ? formatSilver(totalRevenue) : '—'}</span></div>
                <div class="trip-stat"><span class="trip-label">Net</span><span class="trip-val ${netBuyer >= 0 ? 'gain' : 'loss'}">${netBuyer >= 0 ? '+' : ''}${formatSilver(Math.abs(netBuyer))}</span></div>
            </div>
            ${salesCount > 0 ? `<div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.35rem;">${salesCount} sale${salesCount !== 1 ? 's' : ''} notified, ${formatSilver(salesValue)} gross</div>` : ''}
        </div>

        ${tabs.length > 0 ? `
        <div class="trip-section">
            <div class="trip-section-title">Recent tracked tabs</div>
            <div class="trip-tabs-list">
                ${tabs.slice(0, 5).map(t => {
                    const net = (t.revenueSoFar || 0) - (t.purchasePrice || 0);
                    return `<div class="trip-tab-row">
                        <span class="trip-tab-name">${esc(t.tabName || 'Tab')}</span>
                        <span class="trip-tab-status status-${t.status}">${t.status}</span>
                        <span class="trip-tab-net ${net >= 0 ? 'gain' : 'loss'}">${net >= 0 ? '+' : ''}${formatSilver(Math.abs(net))}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>` : ''}

        ${lootSessionCount === 0 && tabsBoughtCount === 0 ? '<div class="empty-state"><p>Nothing to show for this window.</p><p class="hint">Try "All time" or run a live session / buy a loot tab to see data here.</p></div>' : ''}
    `;
}

// A14: Copy preview modal — wraps clipboard writes in a review/edit step
// Usage: openCopyPreview('GvG Summary', text, 'GvG summary copied') -> user
// reviews, edits if needed, clicks Copy → toast with the success message.
let _copyPreviewSuccessMsg = '';
function openCopyPreview(title, text, successMsg) {
    const modal = document.getElementById('copy-preview-modal');
    const ta = document.getElementById('copy-preview-text');
    const t = document.getElementById('copy-preview-title');
    const cc = document.getElementById('copy-preview-charcount');
    if (!modal || !ta) return;
    _copyPreviewSuccessMsg = successMsg || 'Copied to clipboard';
    if (t) t.textContent = title || 'Preview — Copy to Discord';
    ta.value = text || '';
    if (cc) cc.textContent = `${ta.value.length} characters`;
    ta.oninput = () => { if (cc) cc.textContent = `${ta.value.length} characters`; };
    modal.classList.remove('hidden');
    setTimeout(() => ta.focus(), 20);
}
function closeCopyPreviewModal() {
    document.getElementById('copy-preview-modal')?.classList.add('hidden');
}
function confirmCopyPreview() {
    const ta = document.getElementById('copy-preview-text');
    if (!ta) return;
    const text = ta.value;
    navigator.clipboard.writeText(text)
        .then(() => {
            showToast(_copyPreviewSuccessMsg, 'success');
            closeCopyPreviewModal();
        })
        .catch(() => showToast('Copy failed', 'error'));
}

// F4: Page-wide drag-and-drop for .txt loot logs. Works from any tab.
// Routes the dropped files to handleLootFileDrop() and switches to the Loot
// Logger tab + upload mode so user sees the import result.
let _dragCounter = 0;
function _isTxtDrag(e) {
    const types = Array.from(e.dataTransfer?.types || []);
    return types.includes('Files');
}
document.addEventListener('dragenter', (e) => {
    if (!_isTxtDrag(e)) return;
    _dragCounter++;
    const overlay = document.getElementById('global-drop-overlay');
    if (overlay) overlay.classList.remove('hidden');
});
document.addEventListener('dragover', (e) => {
    if (_isTxtDrag(e)) e.preventDefault(); // required to allow drop
});
document.addEventListener('dragleave', (e) => {
    if (!_isTxtDrag(e)) return;
    _dragCounter--;
    if (_dragCounter <= 0) {
        _dragCounter = 0;
        document.getElementById('global-drop-overlay')?.classList.add('hidden');
    }
});
document.addEventListener('drop', (e) => {
    const overlay = document.getElementById('global-drop-overlay');
    if (overlay) overlay.classList.add('hidden');
    _dragCounter = 0;
    if (!_isTxtDrag(e)) return;
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.name.toLowerCase().endsWith('.txt'));
    if (files.length === 0) return;
    // Don't override existing drop zones (they already have handlers that stopPropagation)
    const target = e.target;
    if (target && target.closest && target.closest('#ll-drop-zone')) return;
    e.preventDefault();
    // Switch to Loot Logger upload mode and feed the file list
    document.querySelector('[data-tab="loot-logger"]')?.click();
    setTimeout(() => {
        if (typeof showLootLoggerMode === 'function') showLootLoggerMode('upload');
        // Reuse the existing file-list processor via handleLootFileUpload-equivalent
        if (typeof processLootFiles === 'function') {
            processLootFiles(files);
        } else {
            // Fallback: inject into the hidden input
            const input = document.getElementById('loot-log-file-input');
            if (input) {
                const dt = new DataTransfer();
                for (const f of files) dt.items.add(f);
                input.files = dt.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
        showToast(`Importing ${files.length} file${files.length !== 1 ? 's' : ''}...`, 'info');
    }, 120);
});

// Close any open Discord-template dropdown when clicking outside
document.addEventListener('click', (e) => {
    const openMenus = document.querySelectorAll('.ll-discord-menu.open');
    if (openMenus.length === 0) return;
    for (const menu of openMenus) {
        const dropdown = menu.closest('.ll-discord-dropdown');
        if (!dropdown?.contains(e.target)) menu.classList.remove('open');
    }
});

// A11: Loot Logger keyboard shortcuts
// Only fire when the Loot Logger tab is active, no modal is open, and the
// user isn't typing into a form field.
function _llShowShortcutHelp() {
    const modal = document.createElement('div');
    modal.id = 'll-shortcut-help';
    modal.className = 'modal';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal-content" style="max-width:420px;">
            <button class="close-btn" onclick="this.closest('.modal').remove()">&times;</button>
            <h2 style="color:var(--accent); margin:0 0 0.75rem; font-size:1.1rem;">Loot Logger Shortcuts</h2>
            <div class="ll-shortcut-row"><kbd>E</kbd><span>Expand all player cards</span></div>
            <div class="ll-shortcut-row"><kbd>C</kbd><span>Collapse all player cards</span></div>
            <div class="ll-shortcut-row"><kbd>F</kbd><span>Focus the search box</span></div>
            <div class="ll-shortcut-row"><kbd>W</kbd><span>Open whitelist modal</span></div>
            <div class="ll-shortcut-row"><kbd>Esc</kbd><span>Close any open modal / clear death filter</span></div>
            <div class="ll-shortcut-row"><kbd>?</kbd><span>Show this help</span></div>
            <div class="ll-shortcut-row" style="border-top:1px dashed var(--border-color); margin-top:0.4rem; padding-top:0.55rem;"><kbd>Ctrl+Shift+T</kbd><span>Trip Summary (any tab)</span></div>
            <div class="ll-shortcut-row"><kbd>Ctrl+Shift+C</kbd><span>Compare Sessions (any tab)</span></div>
            <div class="ll-shortcut-row"><kbd>Ctrl+Shift+L</kbd><span>Guild Leaderboard (any tab)</span></div>
            <p style="font-size:0.72rem; color:var(--text-muted); margin:0.75rem 0 0;">Shortcuts don't fire while typing in a text field.</p>
        </div>`;
    document.body.appendChild(modal);
}

// Session Merge — combine 2+ saved sessions into one
function openSessionMerge() {
    document.getElementById('session-merge-modal')?.classList.remove('hidden');
    document.getElementById('session-merge-result').innerHTML = '';
    _populateMergeList();
}
function closeSessionMerge() {
    document.getElementById('session-merge-modal')?.classList.add('hidden');
}
async function _populateMergeList() {
    const list = document.getElementById('session-merge-list');
    if (!list) return;
    list.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-sessions`, { headers: authHeaders() });
        if (!res.ok) throw new Error('Failed to load sessions');
        const data = await res.json();
        const sessions = data.sessions || [];
        if (sessions.length < 2) {
            list.innerHTML = '<div class="empty-state"><p>Need at least 2 saved sessions to merge.</p></div>';
            return;
        }
        const savedNames = typeof getSavedSessionNames === 'function' ? getSavedSessionNames() : {};
        list.innerHTML = sessions.map(s => {
            const started = new Date(s.started_at).toLocaleString();
            const label = savedNames[s.session_id] || started;
            return `<label class="merge-session-item" onclick="event.stopPropagation()">
                <input type="checkbox" value="${esc(s.session_id)}" class="merge-session-cb">
                <span>${esc(label)}</span>
                <span style="color:var(--text-muted); font-size:0.72rem;">${s.event_count} events · ${s.player_count} players</span>
            </label>`;
        }).join('');
    } catch(e) {
        list.innerHTML = `<div class="empty-state"><p>${esc(e.message)} — login required.</p></div>`;
    }
}
async function submitSessionMerge() {
    const checkboxes = document.querySelectorAll('.merge-session-cb:checked');
    const ids = Array.from(checkboxes).map(cb => cb.value);
    if (ids.length < 2) { showToast('Select at least 2 sessions to merge', 'warn'); return; }
    const name = document.getElementById('merge-session-name')?.value?.trim() || '';
    const btn = document.getElementById('merge-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Merging...'; }
    try {
        const res = await fetch(`${VPS_BASE}/api/loot-sessions/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ sessionIds: ids, name })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        document.getElementById('session-merge-result').innerHTML =
            `<p style="color:var(--profit-green); font-size:0.8rem;">Merged ${ids.length} sessions (${data.eventsCopied} events). Reload to see the new session.</p>`;
        showToast(`Merged ${ids.length} sessions`, 'success');
    } catch(e) {
        document.getElementById('session-merge-result').innerHTML =
            `<p style="color:var(--loss-red); font-size:0.8rem;">${esc(e.message)}</p>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Merge Selected'; }
    }
}

// G1: Guild Leaderboard — aggregated stats across all saved sessions.
let _lbPeriod = (() => { try { return localStorage.getItem('albion_lb_period') || 'all'; } catch { return 'all'; } })();
function openGuildLeaderboard() {
    document.getElementById('guild-leaderboard-modal')?.classList.remove('hidden');
    _renderGuildLeaderboard();
}
function closeGuildLeaderboard() {
    document.getElementById('guild-leaderboard-modal')?.classList.add('hidden');
}
function setLeaderboardPeriod(p) {
    _lbPeriod = p;
    try { localStorage.setItem('albion_lb_period', p); } catch {}
    document.querySelectorAll('#guild-leaderboard-modal [data-lb-window]').forEach(b => {
        b.classList.toggle('btn-small-accent', b.dataset.lbWindow === p);
        b.classList.toggle('btn-small', b.dataset.lbWindow !== p);
    });
    _renderGuildLeaderboard();
}
async function _renderGuildLeaderboard() {
    const body = document.getElementById('guild-leaderboard-body');
    if (!body) return;
    body.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    // Highlight active period button
    document.querySelectorAll('#guild-leaderboard-modal [data-lb-window]').forEach(b => {
        b.classList.toggle('btn-small-accent', b.dataset.lbWindow === _lbPeriod);
        b.classList.toggle('btn-small', b.dataset.lbWindow !== _lbPeriod);
    });
    try {
        const res = await fetch(`${VPS_BASE}/api/guild-leaderboard?period=${_lbPeriod}`, { headers: authHeaders() });
        if (!res.ok) throw new Error('Failed to load leaderboard');
        const data = await res.json();
        const t = data.totals || {};
        let html = `<div class="ll-summary-strip" style="margin-bottom:1rem;">
            <div class="ll-summary-stat"><div class="ll-summary-label">Sessions</div><div class="ll-summary-value">${(t.total_sessions || 0).toLocaleString()}</div></div>
            <div class="ll-summary-stat"><div class="ll-summary-label">Players</div><div class="ll-summary-value">${(t.total_players || 0).toLocaleString()}</div></div>
            <div class="ll-summary-stat"><div class="ll-summary-label">Items</div><div class="ll-summary-value">${(t.total_items || 0).toLocaleString()}</div></div>
            <div class="ll-summary-stat"><div class="ll-summary-label">Deaths</div><div class="ll-summary-value ${t.total_deaths > 0 ? 'loss' : ''}">${t.total_deaths > 0 ? '💀 ' : ''}${(t.total_deaths || 0).toLocaleString()}</div></div>
        </div>`;
        html += `<div style="text-align:right; margin-bottom:0.5rem;">
            <button class="btn-small" onclick="copyLeaderboardToDiscord()" title="Copy leaderboard to clipboard as Discord-friendly text">📋 Copy to Discord</button>
        </div>`;
        html += '<div class="lb-grid">';
        html += _lbTable('Top Looters', '📦', data.topLooters || [], ['name', 'guild', 'items', 'total_weight', 'sessions'], { items: 'Items', total_weight: 'Weight', sessions: 'Sessions' });
        html += _lbTable('Top Killers', '⚔', data.topKillers || [], ['name', 'guild', 'kills'], { kills: 'Kills' });
        html += _lbTable('Most Deaths', '💀', data.mostDeaths || [], ['name', 'guild', 'deaths'], { deaths: 'Deaths' });
        html += _lbTable('Most Active', '🔥', data.mostActive || [], ['name', 'guild', 'sessions', 'items'], { sessions: 'Sessions', items: 'Items' });
        html += '</div>';
        // Stash data for Discord copy
        window._lastLeaderboardData = data;
        body.innerHTML = html;
    } catch (e) {
        body.innerHTML = `<div class="empty-state"><p>${esc(e.message)} — login required.</p></div>`;
    }
}
function _lbTable(title, icon, rows, cols, labels) {
    if (!rows.length) return `<div class="lb-section"><h3 class="lb-title">${icon} ${esc(title)}</h3><p class="hint" style="color:var(--text-muted); font-size:0.78rem;">No data yet.</p></div>`;
    const medals = ['🥇', '🥈', '🥉'];
    let html = `<div class="lb-section"><h3 class="lb-title">${icon} ${esc(title)}</h3><table class="lb-table"><thead><tr><th>#</th><th>Player</th>`;
    for (const c of cols) {
        if (c === 'name' || c === 'guild') continue;
        html += `<th>${esc(labels[c] || c)}</th>`;
    }
    html += '</tr></thead><tbody>';
    rows.forEach((r, i) => {
        const rank = i < 3 ? medals[i] : `${i + 1}`;
        const guild = r.guild ? `<span class="lb-guild">[${esc(r.guild)}]</span>` : '';
        html += `<tr class="${i < 3 ? 'lb-top3' : ''}"><td class="lb-rank">${rank}</td><td>${esc(r.name)} ${guild}</td>`;
        for (const c of cols) {
            if (c === 'name' || c === 'guild') continue;
            const val = r[c] || 0;
            const formatted = c === 'total_weight' ? (val > 0 ? val.toLocaleString() + ' kg' : '—') : val.toLocaleString();
            html += `<td class="lb-val">${formatted}</td>`;
        }
        html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
}

// Discord copy for Guild Leaderboard — formats leaderboard data as Markdown table
function copyLeaderboardToDiscord() {
    const d = window._lastLeaderboardData;
    if (!d) { showToast('No leaderboard data loaded', 'warn'); return; }
    const t = d.totals || {};
    const periodLabel = _lbPeriod === '7d' ? 'Last 7 days' : _lbPeriod === '30d' ? 'Last 30 days' : 'All time';
    let text = `**🏆 Guild Leaderboard — ${periodLabel}**\n`;
    text += `${t.total_sessions || 0} sessions · ${t.total_players || 0} players · ${(t.total_items || 0).toLocaleString()} items · 💀 ${t.total_deaths || 0} deaths\n\n`;
    const fmtSection = (title, icon, rows, valKey, suffix) => {
        if (!rows || !rows.length) return '';
        const medals = ['🥇', '🥈', '🥉'];
        let s = `**${icon} ${title}**\n`;
        rows.slice(0, 5).forEach((r, i) => {
            const rank = i < 3 ? medals[i] : `${i + 1}.`;
            const guild = r.guild ? ` [${r.guild}]` : '';
            const extra = suffix && r[suffix] ? ` (${r[suffix].toLocaleString()} kg)` : '';
            s += `${rank} ${r.name}${guild} — ${(r[valKey] || 0).toLocaleString()}${extra}\n`;
        });
        return s + '\n';
    };
    text += fmtSection('Top Looters', '📦', d.topLooters, 'items', 'total_weight');
    text += fmtSection('Top Killers', '⚔', d.topKillers, 'kills');
    text += fmtSection('Most Deaths', '💀', d.mostDeaths, 'deaths');
    text += fmtSection('Most Active', '🔥', d.mostActive, 'sessions');
    // Route through copy preview modal if it exists
    if (typeof openCopyPreviewModal === 'function') {
        openCopyPreviewModal('Guild Leaderboard — Discord', text);
    } else {
        navigator.clipboard.writeText(text.trim()).then(() => showToast('Leaderboard copied!', 'success'));
    }
}

// Global cross-tab shortcuts — work anywhere in the app
document.addEventListener('keydown', (e) => {
    // ? opens shortcut help from ANY tab (non-modifier)
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '?' || (e.key === '/' && e.shiftKey))) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        const anyModalOpen = Array.from(document.querySelectorAll('.modal')).some(m => !m.classList.contains('hidden'));
        if (anyModalOpen) return;
        e.preventDefault();
        if (typeof _llShowShortcutHelp === 'function') _llShowShortcutHelp();
        return;
    }
    // Ctrl+Shift+T opens Trip Summary, Ctrl+Shift+C opens Compare Sessions, Ctrl+Shift+L opens Leaderboard
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'T' || e.key === 't') {
        e.preventDefault();
        if (typeof openTripSummary === 'function') openTripSummary();
    } else if (e.key === 'C' || e.key === 'c') {
        e.preventDefault();
        if (typeof openSessionCompare === 'function') openSessionCompare();
    } else if (e.key === 'L' || e.key === 'l') {
        e.preventDefault();
        if (typeof openGuildLeaderboard === 'function') openGuildLeaderboard();
    }
});

document.addEventListener('keydown', (e) => {
    // Skip when focused on an input/textarea/contenteditable, or modifier combos
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // Only active on Loot Logger tab
    if (typeof currentTab !== 'undefined' && currentTab !== 'loot-logger') return;
    // Skip if any other modal is open (Esc already handled elsewhere)
    const anyModalOpen = Array.from(document.querySelectorAll('.modal')).some(m => !m.classList.contains('hidden'));
    if (anyModalOpen && e.key !== 'Escape') return;

    switch (e.key) {
        case '?':
        case '/': // some layouts surface ? as shift+/ — treat plain / as help too
            if (e.key === '/' && !e.shiftKey) return;
            e.preventDefault();
            _llShowShortcutHelp();
            break;
        case 'e':
        case 'E':
            e.preventDefault();
            document.querySelectorAll('#loot-session-detail .ll-player-card, #accountability-result .ll-player-card').forEach(c => c.classList.add('expanded'));
            break;
        case 'c':
        case 'C':
            e.preventDefault();
            document.querySelectorAll('#loot-session-detail .ll-player-card, #accountability-result .ll-player-card').forEach(c => c.classList.remove('expanded'));
            break;
        case 'f':
        case 'F':
            e.preventDefault();
            document.getElementById('ll-search')?.focus();
            break;
        case 'w':
        case 'W':
            e.preventDefault();
            if (typeof openWhitelistModal === 'function') openWhitelistModal();
            break;
    }
});

// Init with timers widget
const _origInit = typeof init === 'function' ? init : null;
function _wrappedInit() { if (_origInit) _origInit(); initTimersWidget(); }
window.addEventListener('load', _wrappedInit);

// ============================================================
// CRAFT RUNS TAB
// ============================================================

const CR_STATUS_FLOW = ['buying', 'refining', 'crafting', 'hauling', 'selling', 'complete'];
const CR_STATUS_LABELS = {
    buying:   '🛒 Buying',
    refining: '⚒️ Refining',
    crafting: '🔨 Crafting',
    hauling:  '📦 Hauling',
    selling:  '💰 Selling',
    complete: '✅ Complete',
};
const CR_COST_TYPES_FE = new Set(['buy', 'refine_in', 'craft_in']);
const CR_REV_TYPES_FE  = new Set(['sell', 'refine_out', 'craft_out']);

let crCurrentRunId = null;
let _crInitialized = false;

function initCraftRunsTab() {
    // Wire static buttons once; reload runs on every visit
    if (!_crInitialized) {
        _crInitialized = true;
        const newBtn    = document.getElementById('cr-new-btn');
        const backBtn   = document.getElementById('cr-back-btn');
        const cancelBtn = document.getElementById('cr-cancel-new-btn');
        const createBtn = document.getElementById('cr-create-btn');

        if (newBtn)    newBtn.onclick    = () => crToggleNewForm(true);
        if (backBtn)   backBtn.onclick   = () => crShowList();
        if (cancelBtn) cancelBtn.onclick = () => crToggleNewForm(false);
        if (createBtn) createBtn.onclick = crSubmitNewRun;

        // Transaction modal close wiring
        document.getElementById('cr-txn-close-btn')?.addEventListener('click', () => {
            document.getElementById('cr-txn-modal')?.classList.add('hidden');
        });
        document.getElementById('cr-txn-cancel-btn')?.addEventListener('click', () => {
            document.getElementById('cr-txn-modal')?.classList.add('hidden');
        });

        // Scan picker modal wiring
        document.getElementById('cr-scan-close-btn')?.addEventListener('click', () => {
            document.getElementById('cr-scan-modal')?.classList.add('hidden');
        });
        document.getElementById('cr-scan-cancel-btn')?.addEventListener('click', () => {
            document.getElementById('cr-scan-modal')?.classList.add('hidden');
        });

        // Refining planner wiring
        document.getElementById('cr-refine-planner-toggle')?.addEventListener('click', () => {
            const panel = document.getElementById('cr-refine-planner');
            if (!panel) return;
            panel.style.display = panel.style.display === 'none' || !panel.style.display ? 'flex' : 'none';
        });
        document.getElementById('cr-refine-planner-close')?.addEventListener('click', () => {
            const panel = document.getElementById('cr-refine-planner');
            if (panel) panel.style.display = 'none';
        });
        document.getElementById('cr-rp-calc')?.addEventListener('click', crRunRefinePlanner);
        // Also recalc when any input changes for live feel
        ['cr-rp-material','cr-rp-qty','cr-rp-tier','cr-rp-focus','cr-rp-hideout','cr-rp-pl','cr-rp-core'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', crRunRefinePlanner);
        });

        // Item autocomplete for new run target field
        crSetupTargetAutocomplete();
    }
    crShowList();
}

function crShowList() {
    crCurrentRunId = null;
    const listView   = document.getElementById('cr-list-view');
    const detailView = document.getElementById('cr-detail-view');
    const backBtn    = document.getElementById('cr-back-btn');
    const newBtn     = document.getElementById('cr-new-btn');
    if (listView)   listView.style.display = '';
    if (detailView) detailView.style.display = 'none';
    if (backBtn)    backBtn.style.display = 'none';
    if (newBtn)     newBtn.style.display = '';
    crToggleNewForm(false);
    crLoadRuns();
}

function crToggleNewForm(show) {
    const form = document.getElementById('cr-new-form');
    if (form) form.style.display = show ? 'flex' : 'none';
    if (!show) {
        const ni = document.getElementById('cr-name-input');
        const ti = document.getElementById('cr-target-input');
        if (ni) ni.value = '';
        if (ti) ti.value = '';
    }
}

async function crLoadRuns() {
    const cards = document.getElementById('cr-list-cards');
    const empty = document.getElementById('cr-list-empty');
    if (!cards) return;
    cards.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading runs…</p></div>';
    try {
        const r = await fetch(`${VPS_BASE}/api/craft-runs`, { headers: authHeaders() });
        if (!r.ok) {
            cards.innerHTML = `<div class="empty-state"><p>${r.status === 401 ? 'Please log in to use Craft Runs.' : 'Failed to load runs.'}</p></div>`;
            if (empty) empty.classList.add('hidden');
            return;
        }
        const data = await r.json();
        crRenderList(data.runs || []);
    } catch {
        cards.innerHTML = '<div class="empty-state"><p>Could not reach server. Check your connection.</p></div>';
        if (empty) empty.classList.add('hidden');
    }
}

function crRenderList(runs) {
    const cards = document.getElementById('cr-list-cards');
    const empty = document.getElementById('cr-list-empty');
    if (!cards) return;
    if (!runs.length) {
        cards.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');
    cards.innerHTML = runs.map(r => crRunCardHTML(r)).join('');
    cards.querySelectorAll('[data-open-run]').forEach(btn => {
        btn.addEventListener('click', () => crOpenRun(parseInt(btn.dataset.openRun)));
    });
    cards.querySelectorAll('[data-delete-run]').forEach(btn => {
        btn.addEventListener('click', () => crDeleteRun(parseInt(btn.dataset.deleteRun)));
    });
}

function crRunCardHTML(run) {
    const statusColor = {
        buying: '#f59e0b', refining: '#8b5cf6', crafting: '#3b82f6',
        hauling: '#f97316', selling: '#10b981', complete: '#22c55e'
    }[run.status] || 'var(--text-secondary)';
    const profit = (run.total_revenue || 0) - (run.total_cost || 0);
    const taxEst = (run.total_revenue || 0) * 0.055;
    const net = profit - taxEst;
    const profitSign = net >= 0 ? '+' : '';
    const profitColor = net >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';
    const marginPct = run.total_cost > 0 ? ((net / run.total_cost) * 100).toFixed(1) : '—';
    const created = run.created_at ? new Date(run.created_at).toLocaleDateString() : '';
    const statusIdx = CR_STATUS_FLOW.indexOf(run.status);
    const flowHTML = CR_STATUS_FLOW.map((s, i) => {
        const done   = i < statusIdx || run.status === 'complete';
        const active = s === run.status && run.status !== 'complete';
        const icon   = CR_STATUS_LABELS[s].split(' ')[0];
        return `<span class="cr-flow-step ${done ? 'done' : ''} ${active ? 'active' : ''}" title="${CR_STATUS_LABELS[s]}">${icon}</span>${i < CR_STATUS_FLOW.length - 1 ? '<span class="cr-flow-arrow">›</span>' : ''}`;
    }).join('');

    const hasData = (run.total_cost || 0) > 0 || (run.total_revenue || 0) > 0;
    const costDisplay = hasData ? formatSilver(run.total_cost || 0) : '0';
    const revenueDisplay = hasData ? formatSilver(run.total_revenue || 0) : '0';
    const pnlDisplay = hasData ? `${profitSign}${formatSilver(net)} (${marginPct}%)` : '—';

    return `<div class="trade-card cr-run-card">
        <div class="cr-run-header">
            <div>
                <div class="cr-run-name">${esc(run.name)}</div>
                ${run.target_item ? `<div style="color:var(--text-secondary);font-size:0.78rem;">${esc(run.target_item)}</div>` : ''}
            </div>
            <span class="cr-status-badge" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">${esc(CR_STATUS_LABELS[run.status] || run.status)}</span>
        </div>
        <div class="cr-flow-steps">${flowHTML}</div>
        <div class="cr-run-stats">
            <div class="cr-stat"><span class="cr-stat-label">Cost</span><span class="cr-stat-val">${costDisplay}</span></div>
            <div class="cr-stat"><span class="cr-stat-label">Revenue</span><span class="cr-stat-val">${revenueDisplay}</span></div>
            <div class="cr-stat"><span class="cr-stat-label">Net P&amp;L</span><span class="cr-stat-val" style="color:${hasData ? profitColor : 'var(--text-muted)'};">${pnlDisplay}</span></div>
        </div>
        <div class="cr-run-actions">
            <span style="color:var(--text-secondary);font-size:0.73rem;">${esc(created)}${run.txn_count ? ` · ${run.txn_count} txn${run.txn_count > 1 ? 's' : ''}` : ''}</span>
            <div style="display:flex;gap:0.4rem;">
                <button class="btn-secondary" data-open-run="${run.id}" style="padding:0.3rem 0.7rem;font-size:0.8rem;">Open</button>
                <button class="btn-secondary" data-delete-run="${run.id}" style="padding:0.3rem 0.5rem;font-size:0.8rem;color:var(--loss-red);" title="Delete run">🗑️</button>
            </div>
        </div>
    </div>`;
}

async function crOpenRun(id) {
    crCurrentRunId = id;
    const listView   = document.getElementById('cr-list-view');
    const detailView = document.getElementById('cr-detail-view');
    const backBtn    = document.getElementById('cr-back-btn');
    const newBtn     = document.getElementById('cr-new-btn');
    if (listView)   listView.style.display = 'none';
    if (detailView) { detailView.style.display = 'block'; detailView.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading…</p></div>'; }
    if (backBtn)    backBtn.style.display = '';
    if (newBtn)     newBtn.style.display = 'none';
    crToggleNewForm(false);

    try {
        const r = await fetch(`${VPS_BASE}/api/craft-runs/${id}`, { headers: authHeaders() });
        if (!r.ok) { showToast('Failed to load run.', 'error'); crShowList(); return; }
        const data = await r.json();
        crRenderDetail(data.run, data.transactions || [], data.scans || []);
    } catch {
        showToast('Network error loading run.', 'error');
        crShowList();
    }
}

function crRenderDetail(run, txns, scans) {
    const el = document.getElementById('cr-detail-view');
    if (!el) return;

    const profit = (run.total_revenue || 0) - (run.total_cost || 0);
    const taxEst = (run.total_revenue || 0) * 0.055;
    const net = profit - taxEst;
    const profitSign = net >= 0 ? '+' : '';
    const profitColor = net >= 0 ? 'var(--profit-green)' : 'var(--loss-red)';
    const marginPct = run.total_cost > 0 ? ((net / run.total_cost) * 100).toFixed(1) : '—';
    const statusIdx = CR_STATUS_FLOW.indexOf(run.status);
    const nextStatus = run.status !== 'complete' ? CR_STATUS_FLOW[Math.min(statusIdx + 1, CR_STATUS_FLOW.length - 1)] : null;

    // Progress bar
    const progressHTML = CR_STATUS_FLOW.map((s, i) => {
        const done   = i < statusIdx || run.status === 'complete';
        const active = s === run.status && run.status !== 'complete';
        const label  = CR_STATUS_LABELS[s].split(' ');
        return `<div class="cr-progress-step ${done ? 'done' : ''} ${active ? 'active' : ''}">
            <div class="cr-progress-icon">${label[0]}</div>
            <div class="cr-progress-label">${label.slice(1).join(' ')}</div>
        </div>${i < CR_STATUS_FLOW.length - 1 ? `<div class="cr-progress-line ${done ? 'done' : ''}"></div>` : ''}`;
    }).join('');

    // Transaction rows
    const txnTypeLabels = { buy: '🛒 Buy', refine_in: '⚒️ In', refine_out: '⚒️ Out', craft_in: '🔨 In', craft_out: '🔨 Out', sell: '💰 Sell' };
    const srcLabels = { manual: 'Manual', tab_scan: 'Tab Scan', market_auto: 'Auto' };
    const txnRows = txns.map(t => {
        const isCost = CR_COST_TYPES_FE.has(t.type);
        const total  = t.total_price != null ? t.total_price : (t.quantity * t.unit_price);
        const tColor = isCost ? 'var(--loss-red)' : 'var(--profit-green)';
        return `<tr>
            <td style="color:var(--text-secondary);font-size:0.73rem;">${new Date(t.timestamp).toLocaleDateString()}</td>
            <td><span class="cr-txn-type-badge">${txnTypeLabels[t.type] || esc(t.type)}</span></td>
            <td style="max-width:140px;">${esc(t.item_id)}</td>
            <td style="text-align:right;">${Number(t.quantity || 0).toLocaleString()}</td>
            <td style="text-align:right;">${formatSilver(t.unit_price)}</td>
            <td style="text-align:right;color:${tColor};">${isCost ? '-' : '+'}${formatSilver(total)}</td>
            <td style="color:var(--text-secondary);font-size:0.73rem;">${esc(t.city || '—')}</td>
            <td style="font-size:0.7rem;color:var(--text-secondary);">${srcLabels[t.source] || esc(t.source || '')}</td>
        </tr>`;
    }).join('');

    el.innerHTML = `
    <div class="controls-panel" style="margin-top:0.5rem;">
        <div style="flex:1;">
            <h3 style="margin:0 0 0.2rem;color:var(--accent);">${esc(run.name)}</h3>
            ${run.target_item ? `<div style="color:var(--text-secondary);font-size:0.82rem;">Target: ${esc(run.target_item)}</div>` : ''}
            ${run.hideout_power_level > 0 || run.hideout_core_bonus > 0
                ? `<div style="color:#a78bfa;font-size:0.75rem;">⚡ Hideout PL${run.hideout_power_level} · Core +${run.hideout_core_bonus}%</div>`
                : ''}
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            <button id="cr-btn-buy" class="btn-primary" style="font-size:0.82rem;">+ Buy</button>
            <button id="cr-btn-sell" class="btn-secondary" style="font-size:0.82rem;">+ Sell</button>
            <button id="cr-btn-craft" class="btn-secondary" style="font-size:0.82rem;">+ Craft</button>
            ${run.status !== 'complete'
                ? `<button id="cr-btn-scan" class="btn-secondary" style="font-size:0.82rem;" title="Attach a chest capture as a bulk buy">📦 From Scan</button>`
                : ''}
            ${txns.length > 0
                ? `<button id="cr-btn-sync-portfolio" class="btn-secondary" style="font-size:0.82rem;color:#a78bfa;" title="Sync buys/sells from this run into the Portfolio Tracker">📊 Sync to Portfolio</button>`
                : ''}
            ${nextStatus
                ? `<button id="cr-advance-btn" class="btn-secondary" style="font-size:0.82rem;color:var(--accent);" title="Advance to ${CR_STATUS_LABELS[nextStatus]}">→ ${CR_STATUS_LABELS[nextStatus]}</button>`
                : ''}
        </div>
    </div>

    <div class="cr-progress-bar">${progressHTML}</div>

    <div class="cr-pnl-dashboard">
        <div class="cr-pnl-card">
            <div class="cr-pnl-label">Total Cost</div>
            <div class="cr-pnl-val" style="color:var(--loss-red);">${formatSilver(run.total_cost || 0)}</div>
        </div>
        <div class="cr-pnl-card">
            <div class="cr-pnl-label">Revenue</div>
            <div class="cr-pnl-val" style="color:var(--profit-green);">${formatSilver(run.total_revenue || 0)}</div>
        </div>
        <div class="cr-pnl-card">
            <div class="cr-pnl-label">Tax Est. (5.5%)</div>
            <div class="cr-pnl-val" style="color:var(--text-secondary);">−${formatSilver(taxEst)}</div>
        </div>
        <div class="cr-pnl-card" style="border-color:${net >= 0 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'};">
            <div class="cr-pnl-label">Net Profit</div>
            <div class="cr-pnl-val" style="color:${profitColor};font-size:1.15rem;">${profitSign}${formatSilver(net)}</div>
            <div style="color:${profitColor};font-size:0.73rem;">${marginPct}% margin</div>
        </div>
    </div>

    <div class="controls-panel" style="margin-top:0.75rem;padding:0.75rem 1rem;flex-direction:column;align-items:stretch;">
        <h4 style="margin:0 0 0.6rem;color:var(--accent);">Transaction Log (${txns.length})</h4>
        ${txns.length ? `<div style="overflow-x:auto;">
            <table class="cr-txn-table">
                <thead><tr>
                    <th>Date</th><th>Type</th><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th><th>City</th><th>Source</th>
                </tr></thead>
                <tbody>${txnRows}</tbody>
            </table>
        </div>` : `<div class="empty-state" style="padding:0.75rem 0;"><p>No transactions yet — use <strong>+ Buy</strong> / <strong>+ Sell</strong> / <strong>+ Craft</strong> above.</p></div>`}
    </div>`;

    // Wire action buttons
    document.getElementById('cr-btn-buy')?.addEventListener('click', () => crOpenTxnModal(run.id, 'buy'));
    document.getElementById('cr-btn-sell')?.addEventListener('click', () => crOpenTxnModal(run.id, 'sell'));
    document.getElementById('cr-btn-craft')?.addEventListener('click', () => crOpenTxnModal(run.id, 'craft_out'));
    document.getElementById('cr-btn-scan')?.addEventListener('click', () => crOpenScanPicker(run.id));
    document.getElementById('cr-btn-sync-portfolio')?.addEventListener('click', () => crSyncToPortfolio(run, txns));
    const advBtn = document.getElementById('cr-advance-btn');
    if (advBtn && nextStatus) advBtn.addEventListener('click', () => crAdvanceStatus(run.id, nextStatus));
}

function crOpenTxnModal(runId, defaultType) {
    const modal = document.getElementById('cr-txn-modal');
    if (!modal) return;
    const typeEl = document.getElementById('cr-txn-type-select');
    if (typeEl) typeEl.value = defaultType;
    const itemEl  = document.getElementById('cr-txn-item-input');
    const qtyEl   = document.getElementById('cr-txn-qty-input');
    const priceEl = document.getElementById('cr-txn-price-input');
    const cityEl  = document.getElementById('cr-txn-city-input');
    if (itemEl)  itemEl.value  = '';
    if (qtyEl)   qtyEl.value   = '1';
    if (priceEl) priceEl.value = '';
    if (cityEl)  cityEl.value  = '';

    const submitBtn = document.getElementById('cr-txn-submit-btn');
    // Replace with a fresh clone to avoid duplicate listeners
    const fresh = submitBtn?.cloneNode(true);
    if (fresh && submitBtn) {
        submitBtn.replaceWith(fresh);
        fresh.addEventListener('click', () => crSubmitTxn(runId));
    }
    modal.classList.remove('hidden');
    itemEl?.focus();
}

async function crSubmitTxn(runId) {
    const type     = document.getElementById('cr-txn-type-select')?.value;
    const item_id  = document.getElementById('cr-txn-item-input')?.value.trim();
    const quantity = parseInt(document.getElementById('cr-txn-qty-input')?.value) || 1;
    const unit_price = parseInt(document.getElementById('cr-txn-price-input')?.value) || 0;
    const city     = document.getElementById('cr-txn-city-input')?.value || '';

    if (!item_id) { showToast('Item name / ID is required.', 'error'); return; }
    if (!unit_price && type !== 'refine_out' && type !== 'craft_out') {
        showToast('Price is required.', 'error'); return;
    }

    try {
        const r = await fetch(`${VPS_BASE}/api/craft-runs/${runId}/txn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ type, item_id, quantity, unit_price, city, source: 'manual' })
        });
        const d = await r.json();
        if (d.id) {
            document.getElementById('cr-txn-modal')?.classList.add('hidden');
            showToast('Transaction added.', 'success');
            crOpenRun(runId); // Reload detail
        } else {
            showToast(d.error || 'Failed to add transaction.', 'error');
        }
    } catch {
        showToast('Network error.', 'error');
    }
}

async function crSubmitNewRun() {
    const name     = document.getElementById('cr-name-input')?.value.trim();
    const target   = document.getElementById('cr-target-input')?.value.trim();
    const pl       = parseInt(document.getElementById('cr-pl-input')?.value) || 0;
    const core     = parseFloat(document.getElementById('cr-core-input')?.value) || 0;

    if (!name) { showToast('Run name is required.', 'error'); return; }

    try {
        const r = await fetch(`${VPS_BASE}/api/craft-runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ name, target_item: target || null, hideout_power_level: pl, hideout_core_bonus: core })
        });
        const d = await r.json();
        if (d.id) {
            showToast(`Run "${esc(name)}" created!`, 'success');
            crToggleNewForm(false);
            crOpenRun(d.id);
        } else {
            showToast(d.error || 'Failed to create run.', 'error');
        }
    } catch {
        showToast('Network error.', 'error');
    }
}

async function crDeleteRun(id) {
    showConfirm('Delete this craft run and all its transactions? This cannot be undone.', async () => {
        try {
            const r = await fetch(`${VPS_BASE}/api/craft-runs/${id}`, { method: 'DELETE', headers: authHeaders() });
            const d = await r.json();
            if (d.success) { showToast('Run deleted.', 'success'); crLoadRuns(); }
            else showToast(d.error || 'Failed to delete.', 'error');
        } catch { showToast('Network error.', 'error'); }
    });
}

async function crAdvanceStatus(runId, newStatus) {
    try {
        const r = await fetch(`${VPS_BASE}/api/craft-runs/${runId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ status: newStatus })
        });
        const d = await r.json();
        if (d.success) {
            showToast(`Status → ${CR_STATUS_LABELS[newStatus]}`, 'success');
            crOpenRun(runId);
        } else {
            showToast(d.error || 'Failed to update status.', 'error');
        }
    } catch { showToast('Network error.', 'error'); }
}

// ─── Scan Picker (attach chest capture to run) ───────────────────────
let _crScanSelectedCapIdx = null;

function crOpenScanPicker(runId) {
    const modal = document.getElementById('cr-scan-modal');
    if (!modal) return;
    _crScanSelectedCapIdx = null;

    const paidEl = document.getElementById('cr-scan-paid-input');
    if (paidEl) paidEl.value = '';
    const submitBtn = document.getElementById('cr-scan-submit-btn');
    if (submitBtn) submitBtn.disabled = true;

    // Render capture list
    crRenderScanCaptureList();

    // Replace submit btn with fresh clone (no duplicate listeners)
    if (submitBtn) {
        const fresh = submitBtn.cloneNode(true);
        submitBtn.replaceWith(fresh);
        fresh.addEventListener('click', () => crSubmitScan(runId));
    }
    // Enable submit only when both a capture is picked AND a paid value > 0 is entered
    paidEl?.addEventListener('input', () => crUpdateScanSubmitState());

    modal.classList.remove('hidden');
}

function crRenderScanCaptureList() {
    const list  = document.getElementById('cr-scan-captures-list');
    const empty = document.getElementById('cr-scan-empty');
    if (!list) return;
    const captures = Array.isArray(window._chestCaptures) ? window._chestCaptures : [];
    if (captures.length === 0) {
        list.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');

    list.innerHTML = captures.map((cap, idx) => {
        const capturedMs = typeof cap.capturedAt === 'number' ? cap.capturedAt : (cap.capturedAt ? new Date(cap.capturedAt).getTime() : 0);
        const ago = capturedMs > 0 ? timeAgo(new Date(capturedMs).toISOString()) : '—';
        const name = cap.customName || cap.tabName
            || (cap.vaultTabs && typeof cap.tabIndex === 'number' && cap.vaultTabs[cap.tabIndex]?.name)
            || 'Chest Capture';
        const vaultType = cap.isGuild ? 'Guild' : (cap.isGuild === false ? 'Bank' : '');
        const itemCount = cap.items?.length || 0;
        const totalQty = (cap.items || []).reduce((s, it) => s + (it.quantity || 1), 0);
        return `<div class="cr-scan-capture-row" data-cap-idx="${idx}" style="display:flex; justify-content:space-between; align-items:center; padding:0.55rem 0.75rem; border:1px solid var(--border); border-radius:6px; cursor:pointer; background:var(--bg-elevated);">
            <div>
                <div style="display:flex; align-items:center; gap:0.4rem;">
                    <strong>${esc(name)}</strong>
                    ${vaultType ? `<span style="font-size:0.65rem; padding:0.1rem 0.35rem; background:var(--bg-card); border-radius:8px; color:var(--text-muted);">${vaultType}</span>` : ''}
                </div>
                <div style="color:var(--text-secondary); font-size:0.75rem; margin-top:0.15rem;">${itemCount} lines · ${totalQty} items total · ${esc(ago)}</div>
            </div>
            <input type="radio" name="cr-scan-cap-pick" value="${idx}" style="transform:scale(1.2);">
        </div>`;
    }).join('');

    list.querySelectorAll('.cr-scan-capture-row').forEach(row => {
        row.addEventListener('click', () => {
            const idx = parseInt(row.dataset.capIdx);
            _crScanSelectedCapIdx = isNaN(idx) ? null : idx;
            list.querySelectorAll('.cr-scan-capture-row').forEach(r => {
                const radio = r.querySelector('input[type=radio]');
                const isSel = r === row;
                if (radio) radio.checked = isSel;
                r.style.borderColor = isSel ? 'var(--accent)' : 'var(--border)';
            });
            crUpdateScanSubmitState();
        });
    });
}

function crUpdateScanSubmitState() {
    const submitBtn = document.getElementById('cr-scan-submit-btn');
    const paid = parseFloat(document.getElementById('cr-scan-paid-input')?.value) || 0;
    if (!submitBtn) return;
    submitBtn.disabled = _crScanSelectedCapIdx === null || paid <= 0;
}

async function crSubmitScan(runId) {
    if (_crScanSelectedCapIdx === null) { showToast('Pick a capture first.', 'error'); return; }
    const paid = parseFloat(document.getElementById('cr-scan-paid-input')?.value) || 0;
    if (paid <= 0) { showToast('Enter a total paid value.', 'error'); return; }
    const alloc = document.getElementById('cr-scan-alloc-select')?.value || 'equal_split';
    const cap   = (window._chestCaptures || [])[_crScanSelectedCapIdx];
    if (!cap || !cap.items?.length) { showToast('Capture has no items.', 'error'); return; }

    const items = cap.items.map(it => ({
        item_id: it.itemId || it.item_id,
        qty:     it.quantity || 1,
    })).filter(x => x.item_id);
    if (!items.length) { showToast('Capture has no valid items.', 'error'); return; }

    const container_id = cap.containerGuid || cap.tabName || cap.customName || '';

    try {
        const r = await fetch(`${VPS_BASE}/api/craft-runs/${runId}/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ container_id, items_json: items, total_paid: paid, allocation_method: alloc })
        });
        const d = await r.json();
        if (d.success) {
            document.getElementById('cr-scan-modal')?.classList.add('hidden');
            showToast(`Attached: ${d.txns_created} line${d.txns_created !== 1 ? 's' : ''} added.`, 'success');
            crOpenRun(runId);
        } else {
            showToast(d.error || 'Failed to attach scan.', 'error');
        }
    } catch {
        showToast('Network error.', 'error');
    }
}

// ─── Portfolio Integration ────────────────────────────────────────────
function crSyncToPortfolio(run, txns) {
    const trades = getPortfolioTrades();
    const tagKey = `_craftRunId`;
    const runId  = run.id;

    // Remove any prior syncs for this run (idempotent re-sync)
    const before = trades.length;
    const kept = trades.filter(t => t[tagKey] !== runId);
    const removed = before - kept.length;

    // Only market-facing lines go to the portfolio:
    //   buy  → BUY entry (cost basis)
    //   sell → SELL entry (revenue)
    // refine_in/out and craft_in/out are internal pipeline steps, not market transactions.
    let buyCount = 0, sellCount = 0;
    const now = Date.now();
    let idx = 0;

    for (const t of txns) {
        if (t.type !== 'buy' && t.type !== 'sell') continue;
        const qty  = Math.max(1, parseInt(t.quantity) || 1);
        const unit = Math.max(0, parseFloat(t.unit_price) || 0);
        if (unit <= 0 && t.type === 'buy') continue; // Skip zero-cost buys (placeholder entries)

        kept.push({
            id: now + (idx++),
            [tagKey]: runId,
            _source: 'craft_run',
            _craftRunName: run.name,
            type: t.type,
            itemId: t.item_id,
            itemName: getFriendlyName(t.item_id) || t.item_id,
            quality: 1,
            quantity: qty,
            price: unit,
            city: t.city || '',
            date: new Date(t.timestamp || now).toISOString(),
        });
        if (t.type === 'buy') buyCount++; else sellCount++;
    }

    savePortfolioTrades(kept);

    const verb = removed > 0 ? 'Re-synced' : 'Synced';
    showToast(`${verb}: ${buyCount} buy + ${sellCount} sell entries → Portfolio.`, 'success');

    // Optional: if user is on portfolio tab, refresh; otherwise no-op
    if (typeof renderPortfolio === 'function' && document.getElementById('pane-portfolio')?.classList.contains('hidden') === false) {
        renderPortfolio();
    }
}

// ─── Refining Planner ─────────────────────────────────────────────────
const CR_REFINE_CITY_MAP = {
    ore:   { city: 'Thetford',      icon: '⛏️', refined: 'Metal Bars',  bonus: 40 },
    wood:  { city: 'Fort Sterling', icon: '🌲', refined: 'Planks',      bonus: 40 },
    fiber: { city: 'Lymhurst',      icon: '🧵', refined: 'Cloth',       bonus: 40 },
    hide:  { city: 'Martlock',      icon: '🐄', refined: 'Leather',     bonus: 40 },
    rock:  { city: 'Bridgewatch',   icon: '🪨', refined: 'Stone Blocks', bonus: 40 },
};

async function crRunRefinePlanner() {
    const container = document.getElementById('cr-rp-result');
    if (!container) return;

    const mat   = document.getElementById('cr-rp-material')?.value || 'ore';
    const qty   = Math.max(1, parseInt(document.getElementById('cr-rp-qty')?.value) || 0);
    const tier  = parseInt(document.getElementById('cr-rp-tier')?.value) || 5;
    const focus = document.getElementById('cr-rp-focus')?.checked || false;
    const useHideout = document.getElementById('cr-rp-hideout')?.checked || false;
    const pl    = Math.min(8, Math.max(0, parseInt(document.getElementById('cr-rp-pl')?.value) || 0));
    const core  = Math.min(30, Math.max(0, parseFloat(document.getElementById('cr-rp-core')?.value) || 0));

    const info = CR_REFINE_CITY_MAP[mat] || CR_REFINE_CITY_MAP.ore;
    // Bonus: +40% from specialist city (royal) OR 15% base + 2%/PL + core% (hideout)
    const cityBonus = info.bonus;
    const hideoutBonus = useHideout ? (15 + pl * 2 + core) : 0;
    const effectiveBonus = useHideout ? hideoutBonus : cityBonus;

    // RRR using existing formula (refining activity)
    const rrr = typeof calculateRRR === 'function'
        ? calculateRRR(focus, effectiveBonus, 'refining')
        : (1 - 1 / (1 + (18 + effectiveBonus + (focus ? 59 : 0)) / 100));
    const rrrPct = (rrr * 100);

    // Estimate output: for tier T2, no lower-tier input needed; T3+ uses same-tier + one lower-tier.
    // Refining produces 1 refined per raw (before RRR returns).
    // Effective output = raw_qty / (1 - RRR)   (since each refine returns a material with prob = RRR,
    // which reduces net consumption — classic albion formula).
    const effectiveOutput = Math.floor(qty / (1 - rrr));
    const materialsSaved  = effectiveOutput - qty;

    const cityRow = useHideout
        ? `<div><strong>Location:</strong> Hideout (Black Zone) · PL${pl} · Core +${core}% → <strong>${hideoutBonus}% bonus</strong></div>`
        : `<div><strong>Best City:</strong> ${info.icon} <strong>${esc(info.city)}</strong> · +${cityBonus}% specialist bonus</div>`;

    container.innerHTML = `<div style="margin-top:0.5rem; padding:0.75rem 1rem; background:var(--bg-elevated); border:1px solid var(--border); border-radius:6px; display:flex; flex-direction:column; gap:0.4rem;">
        ${cityRow}
        <div><strong>Refined into:</strong> T${tier} ${esc(info.refined)}</div>
        <div style="display:flex; gap:1.5rem; flex-wrap:wrap; margin-top:0.25rem;">
            <div><span style="color:var(--text-secondary); font-size:0.75rem;">RRR</span><br><strong style="font-size:1.1rem;">${rrrPct.toFixed(1)}%</strong></div>
            <div><span style="color:var(--text-secondary); font-size:0.75rem;">Input</span><br><strong>${qty.toLocaleString()}</strong></div>
            <div><span style="color:var(--text-secondary); font-size:0.75rem;">Expected Output</span><br><strong style="color:var(--profit-green); font-size:1.1rem;">${effectiveOutput.toLocaleString()}</strong></div>
            <div><span style="color:var(--text-secondary); font-size:0.75rem;">Material Bonus</span><br><strong style="color:#a78bfa;">+${materialsSaved.toLocaleString()} saved</strong></div>
            ${focus ? `<div><span style="color:var(--text-secondary); font-size:0.75rem;">Focus</span><br><strong>Enabled (+59% PB)</strong></div>` : ''}
        </div>
        <div style="color:var(--text-secondary); font-size:0.72rem; margin-top:0.25rem;">Formula: RRR = 1 − 1/(1 + totalPB/100), where totalPB = 18 (base refine) + location bonus + focus (59 if enabled). Output = floor(qty / (1 − RRR)).</div>
    </div>`;
}

// Item autocomplete for new run target field
function crSetupTargetAutocomplete() {
    const input    = document.getElementById('cr-target-input');
    const dropdown = document.getElementById('cr-target-autocomplete');
    if (!input || !dropdown) return;

    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 2) { dropdown.classList.add('hidden'); return; }
        const items = window.itemsData || window.itemList || [];
        const matches = items.filter(it => {
            const name = (it.name || it.localizedName || it.LocalizedNames?.['EN-US'] || '').toLowerCase();
            return name.includes(q);
        }).slice(0, 8);
        if (!matches.length) { dropdown.classList.add('hidden'); return; }
        dropdown.innerHTML = matches.map(it => {
            const name = esc(it.name || it.localizedName || it.LocalizedNames?.['EN-US'] || it.UniqueName || it.id);
            return `<div class="autocomplete-item" data-name="${name}">${name}</div>`;
        }).join('');
        dropdown.classList.remove('hidden');
        dropdown.querySelectorAll('.autocomplete-item').forEach(el => {
            el.addEventListener('click', () => {
                input.value = el.dataset.name;
                dropdown.classList.add('hidden');
            });
        });
    });
    document.addEventListener('click', (ev) => {
        if (!input.contains(ev.target) && !dropdown.contains(ev.target)) {
            dropdown.classList.add('hidden');
        }
    }, { passive: true });
}
