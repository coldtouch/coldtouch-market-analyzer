/*
 * crafting-core.js — pure Albion crafting/economy math, extracted from app.js so it can be
 * unit-tested in Node and reused unchanged in the browser. No DOM, no globals: every input is
 * an explicit argument (the app.js wrappers pass TAX_RATE / SETUP_FEE / CraftConfig values in).
 *
 * Loaded in the browser via <script src="/crafting-core.js"> BEFORE app.js (exposes window.CraftingCore);
 * required directly in Node tests (module.exports). Same dual-export pattern as lootlogger-core.js.
 */
(function (root) {
    'use strict';

    // Quality distribution base table (wiki / forum 67684):
    // Normal 68.9%, Good 25.0%, Outstanding 5.0%, Excellent 1.0%, Masterpiece 0.1%.
    const QUALITY_BASE_DIST = [0.689, 0.250, 0.050, 0.010, 0.001];

    // Food buff crafting-efficiency multipliers.
    function foodBuffMultiplier(foodBuff) {
        return foodBuff === 'avalonian' ? 1.30 : (foodBuff === 'pork' ? 1.18 : 1.0);
    }

    // Effective market tax rate. Instant sell (buy orders) pays tax only; placing a sell order
    // also pays the listing setup fee. taxRate/setupFee are passed in (premium toggle lives in app.js).
    function effectiveTaxRate(sellMode, taxRate, setupFee) {
        return sellMode === 'instant' ? taxRate : (taxRate + setupFee);
    }

    // Resource Return Rate. totalPB = basePB (station, activity-dependent) + city bonus % + focus PB.
    // RRR = 1 - 1/(1 + totalPB/100). Verified: basePB=18 → ~15.25%.
    function rrr(useFocus, cityBonusPct, basePB, focusPB) {
        if (focusPB === undefined) focusPB = 59;
        const totalPB = (basePB || 0) + (cityBonusPct || 0) + (useFocus ? focusPB : 0);
        return 1 - 1 / (1 + totalPB / 100);
    }

    // Focus cost (V2, exponential per wiki): cost halves every 10000 efficiency points.
    // efficiency = (mastery*30 + mainSpec*250 + otherSpecs*30) * foodBuffMultiplier.
    function focusCostV2(baseCost, mainSpecLevel, masteryLevel, otherSpecLevels, foodBuff) {
        if (!baseCost || baseCost <= 0) return 0;
        otherSpecLevels = otherSpecLevels || 0;
        const buffMult = foodBuffMultiplier(foodBuff || 'none');
        const efficiency = (masteryLevel * 30 + mainSpecLevel * 250 + otherSpecLevels * 30) * buffMult;
        return Math.max(1, Math.ceil(baseCost * Math.pow(0.5, efficiency / 10000)));
    }

    // Probability distribution over the 5 qualities given accumulated quality points.
    // Each 100 points ≈ one extra "keep best" reroll; mass shifts toward higher qualities.
    function qualityDistribution(qualityPoints) {
        const rerolls = Math.max(0, Math.min(5, (qualityPoints || 0) / 100));
        const dist = QUALITY_BASE_DIST.slice();
        if (rerolls > 0) {
            let cumAbove = 0;
            const tailProbs = [];
            for (let q = 4; q >= 0; q--) {
                const singleQPlus = dist[q] + cumAbove;
                tailProbs[q] = 1 - Math.pow(1 - singleQPlus, 1 + rerolls);
                cumAbove += dist[q];
            }
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

    // Expected per-unit value given a {1..5: price} map and accumulated quality points.
    function qualityEVPrice(pricesByQuality, qualityPoints) {
        if (!pricesByQuality) return 0;
        const dist = qualityDistribution(qualityPoints || 0);
        let ev = 0;
        for (let q = 1; q <= 5; q++) {
            const p = pricesByQuality[q] || pricesByQuality[1] || 0; // fall back to Q1 if missing
            ev += p * dist[q - 1];
        }
        return Math.round(ev);
    }

    const api = {
        QUALITY_BASE_DIST,
        foodBuffMultiplier,
        effectiveTaxRate,
        rrr,
        focusCostV2,
        qualityDistribution,
        qualityEVPrice,
    };

    root.CraftingCore = Object.assign(root.CraftingCore || {}, api);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
