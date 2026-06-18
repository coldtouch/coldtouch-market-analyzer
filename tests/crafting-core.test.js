const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../crafting-core.js');

test('effectiveTaxRate: instant pays tax only; order adds the setup fee', () => {
    assert.equal(core.effectiveTaxRate('instant', 0.04, 0.025), 0.04);
    // Sell-order rate is tax + setup fee (compare with tolerance — IEEE754 float addition).
    assert.ok(Math.abs(core.effectiveTaxRate('order', 0.04, 0.025) - 0.065) < 1e-9);
    // Non-premium tax (0.08) + setup (0.025) = 0.105 on a sell order.
    assert.ok(Math.abs(core.effectiveTaxRate('order', 0.08, 0.025) - 0.105) < 1e-9);
});

test('rrr: matches the documented basePB=18 -> ~15.25% and focus raises it', () => {
    assert.ok(Math.abs(core.rrr(false, 0, 18) - 0.152542) < 1e-4);
    // Focus adds +59 PB: totalPB=77 -> 1 - 1/1.77.
    assert.ok(Math.abs(core.rrr(true, 0, 18) - 0.435028) < 1e-4);
    // Using focus and city bonus always returns more than the base rate.
    assert.ok(core.rrr(true, 0, 18) > core.rrr(false, 0, 18));
    assert.ok(core.rrr(false, 50, 18) > core.rrr(false, 0, 18));
    // Zero everything -> zero return.
    assert.equal(core.rrr(false, 0, 0), 0);
});

test('focusCostV2: guard, zero-efficiency baseline, monotonicity, food buff', () => {
    assert.equal(core.focusCostV2(0, 100, 100, 0, 'none'), 0);   // baseCost guard
    assert.equal(core.focusCostV2(-5, 100, 100, 0, 'none'), 0);
    assert.equal(core.focusCostV2(100, 0, 0, 0, 'none'), 100);   // efficiency 0 -> unchanged
    // More spec/mastery -> strictly cheaper focus cost.
    assert.ok(core.focusCostV2(1000, 100, 100, 0, 'none') < core.focusCostV2(1000, 0, 0, 0, 'none'));
    assert.ok(core.focusCostV2(1000, 100, 0, 0, 'none') < core.focusCostV2(1000, 50, 0, 0, 'none'));
    // Food buff raises efficiency -> lowers cost (avalonian best, then pork, then none).
    const none = core.focusCostV2(1000, 50, 50, 0, 'none');
    const pork = core.focusCostV2(1000, 50, 50, 0, 'pork');
    const aval = core.focusCostV2(1000, 50, 50, 0, 'avalonian');
    assert.ok(aval <= pork && pork <= none);
    assert.ok(aval < none);
    // Never below 1 for a positive base cost.
    assert.ok(core.focusCostV2(1000, 100, 100, 100, 'avalonian') >= 1);
});

test('foodBuffMultiplier mapping', () => {
    assert.equal(core.foodBuffMultiplier('avalonian'), 1.30);
    assert.equal(core.foodBuffMultiplier('pork'), 1.18);
    assert.equal(core.foodBuffMultiplier('none'), 1.0);
    assert.equal(core.foodBuffMultiplier(undefined), 1.0);
});

test('qualityDistribution: base table at 0 points, valid distribution, shifts upward', () => {
    assert.deepEqual(core.qualityDistribution(0), core.QUALITY_BASE_DIST);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const d0 = core.qualityDistribution(0);
    const d300 = core.qualityDistribution(300);
    assert.ok(Math.abs(sum(d0) - 1) < 1e-9);
    assert.ok(Math.abs(sum(d300) - 1) < 1e-9);
    // Every probability stays in [0,1].
    for (const p of d300) assert.ok(p >= 0 && p <= 1);
    // Mass shifts toward higher qualities (Outstanding+ grows, Normal shrinks).
    const highPlus = (d) => d[2] + d[3] + d[4];
    assert.ok(highPlus(d300) > highPlus(d0));
    assert.ok(d300[0] < d0[0]);
    // Clamps at 5 rerolls: 600 points behaves like 500.
    assert.deepEqual(core.qualityDistribution(600), core.qualityDistribution(500));
});

test('qualityEVPrice: flat prices ~= that price; missing qualities fall back to Q1', () => {
    assert.equal(core.qualityEVPrice(null, 0), 0);
    // Flat price across all qualities -> EV equals that price (dist sums to 1).
    assert.equal(core.qualityEVPrice({ 1: 1000, 2: 1000, 3: 1000, 4: 1000, 5: 1000 }, 0), 1000);
    // Only Q1 provided -> all qualities fall back to Q1.
    assert.equal(core.qualityEVPrice({ 1: 500 }, 250), 500);
    // Higher qualities worth more -> EV rises with quality points.
    const prices = { 1: 100, 2: 150, 3: 300, 4: 800, 5: 2000 };
    assert.ok(core.qualityEVPrice(prices, 300) > core.qualityEVPrice(prices, 0));
});
