'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || '/opt/albion-saas/database.sqlite';
const ITEMS_PATHS = [
  process.env.ITEMS_JSON,
  '/opt/albion-saas/public/items.json',
  '/opt/albion-saas/items.json'
].filter(Boolean);

const DB_WARN_GB = Number(process.env.COMPACTION_WARN_GB || 15);
const DB_EMERG_GB = Number(process.env.COMPACTION_EMERG_GB || 20);
const NORMAL_RAW_RETENTION_DAYS = Number(process.env.COMPACTION_RAW_RETENTION_DAYS || 7);
const WARN_RAW_RETENTION_DAYS = Number(process.env.COMPACTION_WARN_RAW_RETENTION_DAYS || 3);
const EMERG_RAW_RETENTION_DAYS = Number(process.env.COMPACTION_EMERG_RAW_RETENTION_DAYS || 1);
const PRICE_HOURLY_RETENTION_DAYS = Number(process.env.COMPACTION_HOURLY_RETENTION_DAYS || 14);
const DAILY_RETENTION_DAYS = Number(process.env.COMPACTION_DAILY_RETENTION_DAYS || 90);
const SPREAD_RETENTION_DAYS = Number(process.env.COMPACTION_SPREAD_RETENTION_DAYS || 14);
const CONTRIBUTION_RETENTION_DAYS = Number(process.env.COMPACTION_CONTRIBUTION_RETENTION_DAYS || 60);

const CHUNK = Number(process.env.COMPACTION_CHUNK || 250);
const ITEM_BATCH_SLEEP_MS = Number(process.env.COMPACTION_SLEEP_MS || 150);
const MAX_RUN_MS = Number(process.env.COMPACTION_MAX_RUN_MS || 10 * 60 * 1000);
const RSS_LIMIT_MB = Number(process.env.COMPACTION_RSS_LIMIT_MB || 1024);
const BUSY_TIMEOUT_MS = Number(process.env.COMPACTION_BUSY_TIMEOUT_MS || 1000);
const LOCK_DIR = process.env.COMPACTION_LOCK_DIR || '/tmp/albion-compaction-worker.lock';
const ACTIVE_SENTINEL = process.env.COMPACTION_ACTIVE_SENTINEL || '/tmp/albion-db-maintenance-active';

let stopRequested = false;
process.on('SIGTERM', () => { stopRequested = true; });
process.on('SIGINT', () => { stopRequested = true; });

function log(message) {
  console.log(`[CompactionWorker] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireJsLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
    fs.writeFileSync(path.join(LOCK_DIR, 'pid'), `${process.pid}\n${new Date().toISOString()}\n`);
    fs.writeFileSync(ACTIVE_SENTINEL, `${process.pid}\n${new Date().toISOString()}\n`);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      log(`another worker appears active (${LOCK_DIR}); exiting`);
      return false;
    }
    throw err;
  }
}

function releaseJsLock() {
  try { fs.rmSync(ACTIVE_SENTINEL, { force: true }); } catch {}
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
}

function rssMB() {
  return Math.round(process.memoryUsage().rss / 1048576);
}

function assertBudget(deadline) {
  if (stopRequested) return false;
  if (Date.now() >= deadline) return false;
  if (rssMB() > RSS_LIMIT_MB) {
    log(`RSS ${rssMB()}MB exceeded ${RSS_LIMIT_MB}MB; stopping early`);
    return false;
  }
  return true;
}

function getDbStats(db) {
  const pageCount = db.pragma('page_count', { simple: true }) || 0;
  const freelistCount = db.pragma('freelist_count', { simple: true }) || 0;
  const pageSize = db.pragma('page_size', { simple: true }) || 4096;
  const totalBytes = pageCount * pageSize;
  const freeBytes = freelistCount * pageSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalGB: totalBytes / 1073741824,
    freeGB: freeBytes / 1073741824,
    usedGB: usedBytes / 1073741824,
    dbMB: Math.round(totalBytes / 1048576),
    freeMB: Math.round(freeBytes / 1048576)
  };
}

function chooseRawRetention(stats) {
  if (stats.usedGB >= DB_EMERG_GB) return EMERG_RAW_RETENTION_DAYS;
  if (stats.usedGB >= DB_WARN_GB) return WARN_RAW_RETENTION_DAYS;
  return NORMAL_RAW_RETENTION_DAYS;
}

function loadMarketItemIds(db) {
  for (const file of ITEMS_PATHS) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ids = Object.keys(parsed || {}).filter(Boolean).sort();
      if (ids.length > 1000) {
        log(`loaded ${ids.length} item ids from ${file}`);
        return ids;
      }
    } catch (err) {
      log(`could not load item ids from ${file}: ${err.message}`);
    }
  }

  log('item catalog unavailable; falling back to distinct price_hourly item ids');
  return db.prepare('SELECT DISTINCT item_id FROM price_hourly ORDER BY item_id')
    .all()
    .map((row) => row.item_id)
    .filter(Boolean);
}

function deleteByRowids(db, table, rowids) {
  if (!rowids.length) return 0;
  const placeholders = rowids.map(() => '?').join(',');
  return db.prepare(`DELETE FROM ${table} WHERE rowid IN (${placeholders})`).run(...rowids).changes;
}

async function compactRawHourly(db, rawCutoff, itemIds, deadline, totals) {
  const selT1 = db.prepare(`
    SELECT rowid AS rid, item_id, quality, city,
      strftime('%Y-%m-%dT%H', datetime(period_start/1000, 'unixepoch')) AS hour,
      avg_sell AS open_price,
      avg_sell AS high_price,
      CASE WHEN min_sell > 0 THEN min_sell ELSE avg_sell END AS low_price,
      avg_sell AS close_price,
      avg_sell AS avg_price,
      sample_count AS volume
    FROM price_averages
    WHERE item_id = ? AND period_type = 'hourly' AND period_start < ?
    ORDER BY period_start
    LIMIT ?`);

  const insT1 = db.prepare(`INSERT OR IGNORE INTO price_hourly
    (item_id, city, quality, hour, open_price, high_price, low_price, close_price, avg_price, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const writeChunk = db.transaction((rows) => {
    for (const r of rows) {
      insT1.run(r.item_id, r.city, r.quality, r.hour, r.open_price, r.high_price, r.low_price, r.close_price, r.avg_price, r.volume);
    }
  });

  for (let i = 0; i < itemIds.length && assertBudget(deadline); i++) {
    const itemId = itemIds[i];
    while (assertBudget(deadline)) {
      const rows = selT1.all(itemId, rawCutoff, CHUNK);
      if (rows.length === 0) break;
      writeChunk.immediate(rows);
      totals.rawMigrated += rows.length;
      totals.rawDeleted += deleteByRowids(db, 'price_averages', rows.map((r) => r.rid));
      await sleep(ITEM_BATCH_SLEEP_MS);
    }
    if ((i + 1) % 500 === 0) {
      log(`raw->hourly progress items=${i + 1}/${itemIds.length} migrated=${totals.rawMigrated} deleted=${totals.rawDeleted} rss=${rssMB()}MB`);
    }
    await sleep(Math.max(1, Math.floor(ITEM_BATCH_SLEEP_MS / 4)));
  }
}

async function rollHourlyToDaily(db, hourlyCutoffStr, itemIds, deadline, totals) {
  const selectOldHourlyRows = db.prepare(`
    SELECT rowid AS rid, item_id, city, quality,
      CAST(strftime('%s', hour || ':00:00') AS INTEGER) / 86400 * 86400000 AS day_start,
      avg_price,
      low_price,
      high_price,
      volume
    FROM price_hourly
    WHERE item_id = ? AND hour < ?
    ORDER BY city, quality, hour
    LIMIT ?`);

  const upsertDaily = db.prepare(`INSERT INTO price_averages
    (item_id, quality, city, avg_sell, avg_buy, min_sell, max_buy, sample_count, period_type, period_start)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'daily', ?)
    ON CONFLICT(item_id, quality, city, period_type, period_start) DO UPDATE SET
      avg_sell = CASE
        WHEN price_averages.sample_count + excluded.sample_count > 0
        THEN ROUND(((price_averages.avg_sell * price_averages.sample_count) + (excluded.avg_sell * excluded.sample_count)) / (price_averages.sample_count + excluded.sample_count))
        ELSE excluded.avg_sell
      END,
      avg_buy = CASE
        WHEN price_averages.sample_count + excluded.sample_count > 0
        THEN ROUND(((price_averages.avg_buy * price_averages.sample_count) + (excluded.avg_buy * excluded.sample_count)) / (price_averages.sample_count + excluded.sample_count))
        ELSE excluded.avg_buy
      END,
      min_sell = CASE
        WHEN price_averages.min_sell > 0 AND excluded.min_sell > 0 THEN MIN(price_averages.min_sell, excluded.min_sell)
        ELSE MAX(price_averages.min_sell, excluded.min_sell)
      END,
      max_buy = MAX(price_averages.max_buy, excluded.max_buy),
      sample_count = price_averages.sample_count + excluded.sample_count`);

  const writeDaily = db.transaction((rows) => {
    for (const r of rows) {
      upsertDaily.run(r.item_id, r.quality, r.city, Math.round(r.avg_sell), Math.round(r.avg_buy), r.min_sell || 0, r.max_buy || 0, r.sample_count, r.day_start);
    }
  });

  const buildDailyRows = (rows) => {
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.item_id}\u0000${row.city}\u0000${row.quality}\u0000${row.day_start}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          item_id: row.item_id,
          city: row.city,
          quality: row.quality,
          day_start: row.day_start,
          weighted_sum: 0,
          weight: 0,
          min_sell: 0,
          max_buy: 0
        };
        groups.set(key, group);
      }
      const price = Number(row.avg_price) || 0;
      const weight = Math.max(1, Number(row.volume) || 0);
      if (price > 0) {
        group.weighted_sum += price * weight;
        group.weight += weight;
      }
      const low = Number(row.low_price) || 0;
      const high = Number(row.high_price) || 0;
      if (low > 0) group.min_sell = group.min_sell > 0 ? Math.min(group.min_sell, low) : low;
      if (high > 0) group.max_buy = Math.max(group.max_buy, high);
    }
    return Array.from(groups.values())
      .filter((group) => group.weight > 0)
      .map((group) => ({
        item_id: group.item_id,
        city: group.city,
        quality: group.quality,
        day_start: group.day_start,
        avg_sell: group.weighted_sum / group.weight,
        avg_buy: group.weighted_sum / group.weight,
        min_sell: group.min_sell,
        max_buy: group.max_buy,
        sample_count: group.weight
      }));
  };

  let chunkCount = 0;
  for (let i = 0; i < itemIds.length && assertBudget(deadline); i++) {
    const itemId = itemIds[i];
    while (assertBudget(deadline)) {
      const rows = selectOldHourlyRows.all(itemId, hourlyCutoffStr, CHUNK);
      if (rows.length === 0) break;
      const dailyRows = buildDailyRows(rows);
      if (dailyRows.length > 0) {
        writeDaily.immediate(dailyRows);
        totals.dailyRows += dailyRows.length;
      }
      totals.hourlyDeleted += deleteByRowids(db, 'price_hourly', rows.map((row) => row.rid));
      chunkCount++;
      if (chunkCount % 100 === 0) {
        log(`hourly->daily chunks=${chunkCount} item=${itemId} dailyRows=${totals.dailyRows} hourlyDeleted=${totals.hourlyDeleted} rss=${rssMB()}MB`);
      }
      await sleep(ITEM_BATCH_SLEEP_MS);
    }

    if ((i + 1) % 500 === 0) {
      log(`hourly->daily progress items=${i + 1}/${itemIds.length} dailyRows=${totals.dailyRows} hourlyDeleted=${totals.hourlyDeleted} rss=${rssMB()}MB`);
    }
    await sleep(Math.max(1, Math.floor(ITEM_BATCH_SLEEP_MS / 4)));
  }
}

async function prunePriceAveragesDaily(db, dailyCutoff, deadline, totals) {
  const selDaily = db.prepare(`
    SELECT rowid FROM price_averages
    WHERE period_type = 'daily' AND period_start < ?
    LIMIT ?`);

  let cycles = 0;
  while (assertBudget(deadline)) {
    const rowids = selDaily.all(dailyCutoff, CHUNK).map((r) => r.rowid);
    if (rowids.length === 0) break;
    totals.dailyDeleted += deleteByRowids(db, 'price_averages', rowids);
    cycles++;
    if (cycles % 100 === 0) {
      log(`daily prune progress deleted=${totals.dailyDeleted} rss=${rssMB()}MB`);
    }
    await sleep(ITEM_BATCH_SLEEP_MS);
  }
}

async function pruneSimpleTable(db, table, column, cutoff, deadline, label) {
  let deleted = 0;
  const stmt = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`);
  while (assertBudget(deadline)) {
    const info = stmt.run(cutoff, CHUNK);
    if (!info.changes) break;
    deleted += info.changes;
    await sleep(ITEM_BATCH_SLEEP_MS);
  }
  if (deleted > 0) log(`pruned ${deleted} ${label}`);
  return deleted;
}

async function main() {
  if (!acquireJsLock()) return;
  const started = Date.now();
  const deadline = started + MAX_RUN_MS;
  const db = new Database(DB_PATH, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });

  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -16000');
    db.pragma('mmap_size = 0');
    db.pragma('wal_autocheckpoint = 500');
    db.pragma('journal_size_limit = 67108864');

    const before = getDbStats(db);
    const rawRetentionDays = chooseRawRetention(before);
    const now = Date.now();
    const rawCutoff = now - rawRetentionDays * 86400000;
    const hourlyCutoffStr = new Date(now - PRICE_HOURLY_RETENTION_DAYS * 86400000).toISOString().slice(0, 13);
    const dailyCutoff = now - DAILY_RETENTION_DAYS * 86400000;

    log(`start dbLive=${before.usedGB.toFixed(1)}GB total=${before.totalGB.toFixed(1)}GB freePages=${before.freeGB.toFixed(1)}GB rawRetention=${rawRetentionDays}d maxRun=${Math.round(MAX_RUN_MS / 60000)}m`);

    const totals = {
      rawMigrated: 0,
      rawDeleted: 0,
      dailyRows: 0,
      hourlyDeleted: 0,
      dailyDeleted: 0,
      spreadDeleted: 0,
      contributionDeleted: 0
    };

    const itemIds = loadMarketItemIds(db);

    await rollHourlyToDaily(db, hourlyCutoffStr, itemIds, deadline, totals);

    if (assertBudget(deadline)) {
      await compactRawHourly(db, rawCutoff, itemIds, deadline, totals);
    }

    if (assertBudget(deadline)) {
      await rollHourlyToDaily(db, hourlyCutoffStr, itemIds, deadline, totals);
    }

    if (assertBudget(deadline)) {
      await prunePriceAveragesDaily(db, dailyCutoff, deadline, totals);
    }

    if (assertBudget(deadline)) {
      try {
        totals.spreadDeleted = await pruneSimpleTable(db, 'spread_stats', 'updated_at', now - SPREAD_RETENTION_DAYS * 86400000, deadline, 'spread_stats rows');
      } catch (err) {
        log(`spread_stats prune skipped: ${err.message}`);
      }
    }

    if (assertBudget(deadline)) {
      try {
        totals.contributionDeleted = await pruneSimpleTable(db, 'contributions', 'created_at', now - CONTRIBUTION_RETENTION_DAYS * 86400000, deadline, 'contribution rows');
      } catch (err) {
        log(`contributions prune skipped: ${err.message}`);
      }
    }

    try {
      const cp = db.pragma('wal_checkpoint(PASSIVE)');
      log(`wal_checkpoint(PASSIVE): ${JSON.stringify(cp)}`);
    } catch (err) {
      log(`wal checkpoint skipped: ${err.message}`);
    }

    const after = getDbStats(db);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    log(`complete in ${elapsed}s rawMigrated=${totals.rawMigrated} rawDeleted=${totals.rawDeleted} dailyRows=${totals.dailyRows} hourlyDeleted=${totals.hourlyDeleted} dailyDeleted=${totals.dailyDeleted} dbLive=${after.usedGB.toFixed(1)}GB total=${after.totalGB.toFixed(1)}GB freePages=${after.freeGB.toFixed(1)}GB rss=${rssMB()}MB stopped=${!assertBudget(deadline)}`);
  } finally {
    db.close();
    releaseJsLock();
  }
}

main().catch((err) => {
  console.error('[CompactionWorker] fatal:', err && err.stack || err);
  releaseJsLock();
  process.exit(1);
});
