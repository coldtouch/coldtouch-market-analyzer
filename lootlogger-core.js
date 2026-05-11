(function(root) {
    'use strict';

    const DEFAULT_CORPSE_LOOT_WINDOW_MS = 20 * 60 * 1000;
    const PRE_DEATH_GRACE_MS = 30 * 1000;

    function eventTimeMs(ev) {
        if (!ev) return 0;
        const raw = ev.timestamp ?? ev.ts ?? ev.capturedAt;
        if (raw == null || raw === '') return 0;
        if (typeof raw === 'number') {
            if (!Number.isFinite(raw)) return 0;
            return raw > 0 && raw < 10000000000 ? raw * 1000 : raw;
        }
        const parsed = new Date(raw).getTime();
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function normalizeDeathWsPayload(data) {
        if (!data || typeof data !== 'object') return null;
        const victim = data.victimName || data.playerName || data.looted_from_name || data.lootedFrom?.name || '';
        const killer = data.killerName || data.looted_by_name || data.lootedBy?.name || '';
        if (!victim && !killer) return null;

        const out = {
            timestamp: data.timestamp || Date.now(),
            looted_by_name: killer,
            looted_by_guild: data.killerGuild || data.looted_by_guild || data.lootedBy?.guild || '',
            looted_by_alliance: data.killerAlliance || data.looted_by_alliance || data.lootedBy?.alliance || '',
            looted_from_name: victim,
            looted_from_guild: data.victimGuild || data.looted_from_guild || data.lootedFrom?.guild || '',
            looted_from_alliance: data.victimAlliance || data.looted_from_alliance || data.lootedFrom?.alliance || '',
            item_id: '__DEATH__',
            numeric_id: 0,
            quantity: 0,
            weight: 0,
            is_silver: 0,
            sessionId: data.sessionId || data.session_id || '',
            location: data.location || '',
        };

        if (Array.isArray(data.equipmentAtDeath)) out.equipmentAtDeath = data.equipmentAtDeath;
        if (typeof data.equipment_json === 'string') out.equipment_json = data.equipment_json;
        return out;
    }

    function parseEquipmentAtDeath(ev) {
        if (Array.isArray(ev?.equipmentAtDeath) && ev.equipmentAtDeath.length > 0) {
            return ev.equipmentAtDeath;
        }
        if (typeof ev?.equipment_json === 'string' && ev.equipment_json.length > 2) {
            try {
                const parsed = JSON.parse(ev.equipment_json);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            } catch {}
        }
        return null;
    }

    function friendlyVictim(byPlayer, victim, ev, primaryGuild, primaryAlliance) {
        const victimData = byPlayer?.[victim];
        const victimGuild = victimData?.guild || ev.looted_from_guild || '';
        const victimAlliance = victimData?.alliance || ev.looted_from_alliance || '';
        const wasFriendly = primaryAlliance && victimAlliance
            ? victimAlliance === primaryAlliance
            : (primaryGuild && victimGuild === primaryGuild);
        return { victimGuild, victimAlliance, wasFriendly: !!wasFriendly };
    }

    function aggregateDeathLoot(lootedItems, priceMap) {
        const byLooter = {};
        let estimatedValue = 0;
        for (const li of lootedItems || []) {
            const lname = li.looted_by_name || 'Unknown';
            if (!byLooter[lname]) byLooter[lname] = { name: lname, items: 0, silver: 0, guild: li.looted_by_guild || '' };
            byLooter[lname].items += (li.quantity || 1);
            const p = priceMap?.[li.item_id];
            if (p && p.price > 0) {
                const value = p.price * (li.quantity || 1);
                byLooter[lname].silver += value;
                estimatedValue += value;
            }
        }
        return {
            estimatedValue,
            lootedBy: Object.values(byLooter).sort((a, b) => b.silver - a.silver || b.items - a.items),
        };
    }

    function assignCorpseLootToDeaths(corpseLoots, deathEvents, options) {
        const preGraceMs = options?.preDeathGraceMs ?? PRE_DEATH_GRACE_MS;
        const windowMs = options?.corpseLootWindowMs ?? DEFAULT_CORPSE_LOOT_WINDOW_MS;
        const deaths = (deathEvents || []).slice().sort((a, b) => eventTimeMs(a) - eventTimeMs(b));
        const assignments = deaths.map(() => []);
        if (deaths.length === 0) return { deaths, assignments };

        for (const loot of (corpseLoots || [])) {
            const lootTs = eventTimeMs(loot);
            if (!lootTs) {
                if (deaths.length === 1) assignments[0].push(loot);
                continue;
            }

            let matchedIdx = -1;
            for (let i = 0; i < deaths.length; i++) {
                const deathTs = eventTimeMs(deaths[i]);
                if (!deathTs) continue;
                const prevTs = i > 0 ? eventTimeMs(deaths[i - 1]) : 0;
                const nextTs = i < deaths.length - 1 ? eventTimeMs(deaths[i + 1]) : 0;
                let start = deathTs - preGraceMs;
                let end = deathTs + windowMs;
                if (prevTs) start = Math.max(start, prevTs + preGraceMs);
                if (nextTs) end = Math.min(end, nextTs - preGraceMs);
                if (lootTs >= start && lootTs <= end) {
                    matchedIdx = i;
                    break;
                }
            }
            if (matchedIdx >= 0) assignments[matchedIdx].push(loot);
        }

        return { deaths, assignments };
    }

    function clusterCorpseLoots(corpseLoots, options) {
        const windowMs = options?.corpseLootWindowMs ?? DEFAULT_CORPSE_LOOT_WINDOW_MS;
        const sorted = (corpseLoots || []).slice().sort((a, b) => eventTimeMs(a) - eventTimeMs(b));
        const clusters = [];
        for (const loot of sorted) {
            const ts = eventTimeMs(loot);
            const last = clusters[clusters.length - 1];
            const lastTs = last ? eventTimeMs(last[last.length - 1]) : 0;
            if (!last || (ts && lastTs && ts - lastTs > windowMs)) clusters.push([loot]);
            else last.push(loot);
        }
        return clusters;
    }

    function buildDeathTimeline(events, byPlayer, priceMap, primaryGuild, primaryAlliance, options) {
        const deaths = [];
        const lootByVictim = new Map();
        const deathByVictim = new Map();

        for (const ev of events || []) {
            if (ev.item_id === '__DEATH__') {
                const victim = ev.looted_from_name || '';
                if (!victim) continue;
                if (!deathByVictim.has(victim)) deathByVictim.set(victim, []);
                deathByVictim.get(victim).push(ev);
                continue;
            }
            const victim = ev.looted_from_name || '';
            if (!victim) continue;
            if (!lootByVictim.has(victim)) lootByVictim.set(victim, []);
            lootByVictim.get(victim).push(ev);
        }

        for (const [victim, victimDeaths] of deathByVictim.entries()) {
            const allCorpseLoots = lootByVictim.get(victim) || [];
            const { deaths: sortedDeaths, assignments } = assignCorpseLootToDeaths(allCorpseLoots, victimDeaths, options);
            for (let i = 0; i < sortedDeaths.length; i++) {
                const ev = sortedDeaths[i];
                const lootedItems = assignments[i] || [];
                const summary = aggregateDeathLoot(lootedItems, priceMap);
                const side = friendlyVictim(byPlayer || {}, victim, ev, primaryGuild || '', primaryAlliance || '');
                deaths.push({
                    victim,
                    victimGuild: side.victimGuild,
                    victimAlliance: side.victimAlliance,
                    killer: ev.looted_by_name || '',
                    killerGuild: ev.looted_by_guild || '',
                    timestamp: eventTimeMs(ev),
                    location: ev.location || '',
                    lootedItems,
                    equipmentAtDeath: parseEquipmentAtDeath(ev),
                    estimatedValue: summary.estimatedValue,
                    lootedBy: summary.lootedBy,
                    wasFriendly: side.wasFriendly,
                });
            }
        }

        const explicitVictims = new Set(deathByVictim.keys());
        for (const [victim, corpseLoots] of lootByVictim.entries()) {
            if (!victim || explicitVictims.has(victim)) continue;
            const hasGuild = corpseLoots.some(ev => ev.looted_from_guild);
            const isKnownPlayer = !!(byPlayer || {})[victim];
            const distinctItems = new Set(corpseLoots.map(ev => ev.item_id)).size;
            if (!hasGuild || (!isKnownPlayer && distinctItems < 2)) continue;

            for (const cluster of clusterCorpseLoots(corpseLoots, options)) {
                const firstEv = cluster[0];
                const summary = aggregateDeathLoot(cluster, priceMap);
                const side = friendlyVictim(byPlayer || {}, victim, firstEv, primaryGuild || '', primaryAlliance || '');
                deaths.push({
                    victim,
                    victimGuild: side.victimGuild,
                    victimAlliance: side.victimAlliance,
                    killer: '',
                    killerGuild: '',
                    timestamp: eventTimeMs(firstEv),
                    location: firstEv.location || '',
                    lootedItems: cluster.slice(),
                    equipmentAtDeath: null,
                    estimatedValue: summary.estimatedValue,
                    lootedBy: summary.lootedBy,
                    wasFriendly: side.wasFriendly,
                    inferred: true,
                });
            }
        }

        deaths.sort((a, b) => b.timestamp - a.timestamp);
        return deaths;
    }

    const api = {
        DEFAULT_CORPSE_LOOT_WINDOW_MS,
        PRE_DEATH_GRACE_MS,
        eventTimeMs,
        normalizeDeathWsPayload,
        assignCorpseLootToDeaths,
        buildDeathTimeline,
    };

    root.LootLoggerCore = Object.assign(root.LootLoggerCore || {}, api);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
