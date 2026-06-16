const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../lootlogger-core.js');

test('death timeline assigns corpse loot to the matching repeated death only', () => {
    const t0 = Date.UTC(2026, 4, 12, 20, 0, 0);
    const events = [
        { timestamp: t0, item_id: '__DEATH__', looted_from_name: 'Victim', looted_from_guild: 'GuildA', looted_by_name: 'Enemy' },
        { timestamp: t0 + 60_000, item_id: 'T6_MAIN_FROSTSTAFF', looted_from_name: 'Victim', looted_from_guild: 'GuildA', looted_by_name: 'Looter1', quantity: 1 },
        { timestamp: t0 + 3_600_000, item_id: '__DEATH__', looted_from_name: 'Victim', looted_from_guild: 'GuildA', looted_by_name: 'Enemy2' },
        { timestamp: t0 + 3_660_000, item_id: 'T7_ARMOR_CLOTH_SET1', looted_from_name: 'Victim', looted_from_guild: 'GuildA', looted_by_name: 'Looter2', quantity: 1 },
    ];

    const deaths = core.buildDeathTimeline(events, { Victim: { guild: 'GuildA', alliance: '' } }, {}, 'GuildA', '');
    assert.equal(deaths.length, 2);

    const oldest = deaths.slice().sort((a, b) => a.timestamp - b.timestamp);
    assert.deepEqual(oldest[0].lootedItems.map(e => e.item_id), ['T6_MAIN_FROSTSTAFF']);
    assert.deepEqual(oldest[1].lootedItems.map(e => e.item_id), ['T7_ARMOR_CLOTH_SET1']);
});

test('loot shortly before a death marker is attributed to that death', () => {
    const t0 = Date.UTC(2026, 4, 12, 20, 0, 0);
    const events = [
        { timestamp: t0 - 10_000, item_id: 'T8_HEAD_PLATE_SET1', looted_from_name: 'Victim', looted_from_guild: 'GuildA', looted_by_name: 'Looter1', quantity: 1 },
        { timestamp: t0, item_id: '__DEATH__', looted_from_name: 'Victim', looted_from_guild: 'GuildA', looted_by_name: 'Enemy' },
    ];

    const deaths = core.buildDeathTimeline(events, { Victim: { guild: 'GuildA', alliance: '' } }, {}, 'GuildA', '');
    assert.equal(deaths.length, 1);
    assert.deepEqual(deaths[0].lootedItems.map(e => e.item_id), ['T8_HEAD_PLATE_SET1']);
});

test('death websocket normalization preserves metadata needed by live saves', () => {
    const normalized = core.normalizeDeathWsPayload({
        timestamp: 1778610000000,
        sessionId: 'user_session_1',
        victimName: 'Victim',
        victimGuild: 'GuildA',
        victimAlliance: 'ALLY',
        killerName: 'Enemy',
        killerGuild: 'EnemyGuild',
        killerAlliance: 'ENEMY',
        location: 'BLACK_ZONE_1',
        equipmentAtDeath: [{ slot: 'mainhand', itemId: 'T6_MAIN_FROSTSTAFF' }],
    });

    assert.equal(normalized.item_id, '__DEATH__');
    assert.equal(normalized.sessionId, 'user_session_1');
    assert.equal(normalized.location, 'BLACK_ZONE_1');
    assert.equal(normalized.looted_from_alliance, 'ALLY');
    assert.equal(normalized.looted_by_alliance, 'ENEMY');
    assert.equal(normalized.equipmentAtDeath[0].itemId, 'T6_MAIN_FROSTSTAFF');
});

test('multi-guild friendly perspective marks any selected guild as friendly', () => {
    const t0 = Date.UTC(2026, 5, 16, 20, 0, 0);
    const events = [
        { timestamp: t0, item_id: '__DEATH__', looted_from_name: 'AllyMain', looted_from_guild: 'GuildA', looted_by_name: 'Enemy' },
        { timestamp: t0 + 1000, item_id: '__DEATH__', looted_from_name: 'AllySecond', looted_from_guild: 'GuildB', looted_by_name: 'Enemy' },
        { timestamp: t0 + 2000, item_id: '__DEATH__', looted_from_name: 'Outsider', looted_from_guild: 'GuildC', looted_by_name: 'Friend' },
    ];
    const byPlayer = {
        AllyMain: { guild: 'GuildA', alliance: 'ALLY' },
        AllySecond: { guild: 'GuildB', alliance: 'ALLY' },
        Outsider: { guild: 'GuildC', alliance: 'OTHER' },
    };
    // Both of our guilds selected as friendly (capped-main + second guild use case).
    const deaths = core.buildDeathTimeline(events, byPlayer, {}, 'GuildA', '', undefined, ['GuildA', 'GuildB']);
    const friendlyByVictim = Object.fromEntries(deaths.map(d => [d.victim, d.wasFriendly]));
    assert.equal(friendlyByVictim['AllyMain'], true);
    assert.equal(friendlyByVictim['AllySecond'], true);   // second guild is now friendly too
    assert.equal(friendlyByVictim['Outsider'], false);    // a different guild stays enemy
});

test('omitting friendlyGuilds preserves single-guild behavior', () => {
    const t0 = Date.UTC(2026, 5, 16, 20, 0, 0);
    const events = [
        { timestamp: t0, item_id: '__DEATH__', looted_from_name: 'AllyMain', looted_from_guild: 'GuildA', looted_by_name: 'Enemy' },
        { timestamp: t0 + 1000, item_id: '__DEATH__', looted_from_name: 'AllySecond', looted_from_guild: 'GuildB', looted_by_name: 'Enemy' },
    ];
    const byPlayer = {
        AllyMain: { guild: 'GuildA', alliance: '' },
        AllySecond: { guild: 'GuildB', alliance: '' },
    };
    const deaths = core.buildDeathTimeline(events, byPlayer, {}, 'GuildA', '');
    const friendlyByVictim = Object.fromEntries(deaths.map(d => [d.victim, d.wasFriendly]));
    assert.equal(friendlyByVictim['AllyMain'], true);
    assert.equal(friendlyByVictim['AllySecond'], false);  // only GuildA friendly when single-guild
});
