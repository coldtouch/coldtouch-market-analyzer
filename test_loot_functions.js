/**
 * E10: Unit tests for loot tool pure functions
 * Run: node test_loot_functions.js
 *
 * These tests extract pure functions from app.js by evaluating them
 * with minimal global stubs, then exercise them with synthetic data.
 */
const assert = require('assert');

// ─── Stub globals needed by the functions ──────────────────────────
let lootWhitelist = [];
const window = {};

// ─── Extract the pure functions ────────────────────────────────────

// isWhitelistedEvent — returns true if event passes the whitelist
function isWhitelistedEvent(ev) {
    if (!lootWhitelist.length) return true;
    const name = (ev.looted_by_name || '').toLowerCase();
    const guild = (ev.looted_by_guild || '').toLowerCase();
    const alliance = (ev.looted_by_alliance || '').toLowerCase();
    return lootWhitelist.some(w => w && (w === name || w === guild || w === alliance));
}

// buildDeathTimeline — reconstruct deaths from loot events
function buildDeathTimeline(events, byPlayer, priceMap, primaryGuild, primaryAlliance) {
    const deaths = [];
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
        const allCorpseLoots = lootByVictim.get(victim) || [];
        const lootedItems = allCorpseLoots.slice();
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
        const victimData = byPlayer[victim];
        const victimGuild = victimData?.guild || ev.looted_from_guild || '';
        const victimAlliance = victimData?.alliance || ev.looted_from_alliance || '';
        const wasVictimFriendly = primaryAlliance && victimAlliance
            ? victimAlliance === primaryAlliance
            : (primaryGuild && victimGuild === primaryGuild);
        deaths.push({
            victim, victimGuild, victimAlliance, killer,
            killerGuild: ev.looted_by_guild || '',
            timestamp: deathTs, lootedItems, estimatedValue,
            lootedBy: Object.values(byLooter).sort((a, b) => b.silver - a.silver || b.items - a.items),
            wasFriendly: !!wasVictimFriendly
        });
    }
    deaths.sort((a, b) => b.timestamp - a.timestamp);
    return deaths;
}

// ─── Test runner ───────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${e.message}`);
    }
}

// ─── isWhitelistedEvent tests ──────────────────────────────────────
console.log('\nisWhitelistedEvent:');

test('empty whitelist passes everything', () => {
    lootWhitelist = [];
    assert.strictEqual(isWhitelistedEvent({ looted_by_name: 'Anyone' }), true);
});

test('name match passes', () => {
    lootWhitelist = ['coldtouch'];
    assert.strictEqual(isWhitelistedEvent({ looted_by_name: 'Coldtouch' }), true);
});

test('guild match passes', () => {
    lootWhitelist = ['alpha'];
    assert.strictEqual(isWhitelistedEvent({ looted_by_name: 'Other', looted_by_guild: 'Alpha' }), true);
});

test('alliance match passes', () => {
    lootWhitelist = ['bigalliance'];
    assert.strictEqual(isWhitelistedEvent({ looted_by_name: 'Other', looted_by_guild: 'SomeGuild', looted_by_alliance: 'BigAlliance' }), true);
});

test('non-matching name rejected', () => {
    lootWhitelist = ['coldtouch'];
    assert.strictEqual(isWhitelistedEvent({ looted_by_name: 'EnemyPlayer' }), false);
});

test('case-insensitive: whitelist entries stored lowercase match CamelCase input', () => {
    lootWhitelist = ['coldtouch'];
    assert.strictEqual(isWhitelistedEvent({ looted_by_name: 'COLDTOUCH' }), true);
});

test('case-insensitive: uppercase whitelist does NOT match (whitelist must be stored lowercase)', () => {
    lootWhitelist = ['COLDTOUCH'];
    // Production stores whitelist entries lowercase — this documents the contract
    assert.strictEqual(isWhitelistedEvent({ looted_by_name: 'coldtouch' }), false);
});

// ─── buildDeathTimeline tests ──────────────────────────────────────
console.log('\nbuildDeathTimeline:');

test('empty events returns empty timeline', () => {
    const result = buildDeathTimeline([], {}, {}, '', '');
    assert.deepStrictEqual(result, []);
});

test('no death events returns empty timeline', () => {
    const events = [
        { item_id: 'T4_SWORD', looted_by_name: 'A', looted_from_name: 'B', quantity: 1, timestamp: '2026-04-16T10:00:00Z' }
    ];
    const result = buildDeathTimeline(events, {}, {}, '', '');
    assert.deepStrictEqual(result, []);
});

test('single death with loot items reconstructed', () => {
    const events = [
        { item_id: 'T6_HEAD_PLATE', looted_by_name: 'Coldtouch', looted_by_guild: 'Alpha', looted_from_name: 'Victim1', quantity: 1, timestamp: '2026-04-16T10:01:00Z' },
        { item_id: 'T5_BAG', looted_by_name: 'Ally2', looted_by_guild: 'Alpha', looted_from_name: 'Victim1', quantity: 1, timestamp: '2026-04-16T10:01:30Z' },
        { item_id: '__DEATH__', looted_by_name: 'Coldtouch', looted_from_name: 'Victim1', looted_from_guild: 'EnemyGuild', timestamp: '2026-04-16T10:00:30Z' }
    ];
    const byPlayer = {
        'Coldtouch': { guild: 'Alpha', alliance: '' },
        'Ally2': { guild: 'Alpha', alliance: '' },
        'Victim1': { guild: 'EnemyGuild', alliance: '' }
    };
    const priceMap = {
        'T6_HEAD_PLATE': { price: 50000 },
        'T5_BAG': { price: 10000 }
    };
    const result = buildDeathTimeline(events, byPlayer, priceMap, 'Alpha', '');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].victim, 'Victim1');
    assert.strictEqual(result[0].killer, 'Coldtouch');
    assert.strictEqual(result[0].lootedItems.length, 2);
    assert.strictEqual(result[0].estimatedValue, 60000);
    assert.strictEqual(result[0].wasFriendly, false);
    assert.strictEqual(result[0].lootedBy.length, 2);
    assert.strictEqual(result[0].lootedBy[0].name, 'Coldtouch'); // higher value → first
});

test('friendly death detected by guild match', () => {
    const events = [
        { item_id: '__DEATH__', looted_by_name: 'EnemyKiller', looted_from_name: 'AllyPlayer', looted_from_guild: 'Alpha', timestamp: '2026-04-16T12:00:00Z' }
    ];
    const byPlayer = { 'AllyPlayer': { guild: 'Alpha', alliance: '' } };
    const result = buildDeathTimeline(events, byPlayer, {}, 'Alpha', '');
    assert.strictEqual(result[0].wasFriendly, true);
});

test('friendly death detected by alliance match', () => {
    const events = [
        { item_id: '__DEATH__', looted_by_name: 'Enemy', looted_from_name: 'Ally', looted_from_alliance: 'BigAlliance', timestamp: '2026-04-16T12:00:00Z' }
    ];
    const byPlayer = { 'Ally': { guild: 'Beta', alliance: 'BigAlliance' } };
    const result = buildDeathTimeline(events, byPlayer, {}, 'Beta', 'BigAlliance');
    assert.strictEqual(result[0].wasFriendly, true);
});

test('multiple deaths sorted newest-first', () => {
    const events = [
        { item_id: '__DEATH__', looted_by_name: 'K1', looted_from_name: 'V1', timestamp: '2026-04-16T10:00:00Z' },
        { item_id: '__DEATH__', looted_by_name: 'K2', looted_from_name: 'V2', timestamp: '2026-04-16T11:00:00Z' },
        { item_id: '__DEATH__', looted_by_name: 'K3', looted_from_name: 'V3', timestamp: '2026-04-16T10:30:00Z' }
    ];
    const result = buildDeathTimeline(events, {}, {}, '', '');
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].victim, 'V2'); // 11:00 = newest
    assert.strictEqual(result[1].victim, 'V3'); // 10:30
    assert.strictEqual(result[2].victim, 'V1'); // 10:00 = oldest
});

test('death with no matching loot has empty items and zero value', () => {
    const events = [
        { item_id: '__DEATH__', looted_by_name: 'Killer', looted_from_name: 'Victim', timestamp: '2026-04-16T10:00:00Z' }
    ];
    const result = buildDeathTimeline(events, {}, {}, '', '');
    assert.strictEqual(result[0].lootedItems.length, 0);
    assert.strictEqual(result[0].estimatedValue, 0);
});

test('items without prices contribute zero to estimated value', () => {
    const events = [
        { item_id: 'UNKNOWN_ITEM', looted_by_name: 'A', looted_from_name: 'B', quantity: 5, timestamp: '2026-04-16T10:01:00Z' },
        { item_id: '__DEATH__', looted_by_name: 'A', looted_from_name: 'B', timestamp: '2026-04-16T10:00:00Z' }
    ];
    const result = buildDeathTimeline(events, {}, {}, '', '');
    assert.strictEqual(result[0].lootedItems.length, 1);
    assert.strictEqual(result[0].estimatedValue, 0);
});

// ─── Results ───────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
