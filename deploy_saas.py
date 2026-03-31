import paramiko
import sys
import base64
import os

# Load secrets from .env file
def load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, val = line.split('=', 1)
                    os.environ[key.strip()] = val.strip()

load_env()

ip = os.environ.get('VPS_IP', '209.97.129.125')
password = os.environ['VPS_PASSWORD']
usr = os.environ.get('VPS_USER', 'root')
domain = os.environ.get('VPS_DOMAIN', '209-97-129-125.nip.io')

CLIENT_ID = os.environ['DISCORD_CLIENT_ID']
CLIENT_SECRET = os.environ['DISCORD_CLIENT_SECRET']
BOT_TOKEN = os.environ['DISCORD_BOT_TOKEN']

def main():
    print("Connecting to VPS...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(ip, username=usr, password=password, timeout=10)
    
    def run_wait(cmd):
        stdin, stdout, stderr = ssh.exec_command(cmd)
        stdout.channel.recv_exit_status()
        return stdout.read().decode()

    run_wait("mkdir -p /opt/albion-saas")
    run_wait("systemctl disable --now albion-proxy || true")
    run_wait("apt-get update && apt-get install -y build-essential python3")
    
    pkg_json = """{
  "name": "albion-saas",
  "version": "1.0.0",
  "main": "backend.js",
  "dependencies": {
    "discord.js": "^14.14.1",
    "express": "^4.18.2",
    "express-session": "^1.18.0",
    "express-rate-limit": "^7.1.5",
    "connect-sqlite3": "^0.9.15",
    "passport": "^0.7.0",
    "passport-discord": "^0.1.4",
    "sqlite3": "^5.1.7",
    "nats": "^2.19.0",
    "ws": "^8.16.0",
    "cors": "^2.8.5"
  }
}"""
    b64_pkg = base64.b64encode(pkg_json.encode()).decode()
    run_wait(f"echo '{b64_pkg}' | base64 -d > /opt/albion-saas/package.json")
    
    print("Installing NPM packages (this will take a minute)...")
    run_wait("cd /opt/albion-saas && npm install")
    
    # Reuse existing session secret (so logins survive deploys), or generate a new one
    import secrets
    existing_env = run_wait("cat /opt/albion-saas/.env 2>/dev/null || echo ''")
    session_secret = None
    for line in existing_env.strip().split('\n'):
        if line.startswith('SESSION_SECRET='):
            session_secret = line.split('=', 1)[1].strip()
            break
    if not session_secret:
        session_secret = secrets.token_hex(32)

    backend_js = """
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit = require('express-rate-limit');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { connect, StringCodec } = require('nats');
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');

const domain = process.env.DOMAIN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET;

const GAME_SERVER = process.env.GAME_SERVER || 'europe';
const API_BASE = `https://${GAME_SERVER}.albion-online-data.com/api/v2/stats/prices`;
const CHARTS_BASE = `https://${GAME_SERVER}.albion-online-data.com/api/v2/stats/charts`;
const HISTORY_BASE = `https://${GAME_SERVER}.albion-online-data.com/api/v2/stats/history`;
const ITEMS_URL = 'https://coldtouch.github.io/coldtouch-market-analyzer/items.json';
const CHUNK_SIZE = 100;
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SITE_URL = 'https://coldtouch.github.io/coldtouch-market-analyzer';

// Item name cache (loaded from items.json)
let itemNames = {};

// === DATABASE ===
const db = new sqlite3.Database('/opt/albion-saas/database.sqlite');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, avatar TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS alerts (guild_id TEXT, channel_id TEXT, min_profit INTEGER, cooldown_ms INTEGER DEFAULT 600000, PRIMARY KEY(guild_id, channel_id))`);
  // Migrate: add columns if missing
  db.run(`ALTER TABLE alerts ADD COLUMN cooldown_ms INTEGER DEFAULT 600000`, () => {});
  db.run(`ALTER TABLE alerts ADD COLUMN min_confidence INTEGER DEFAULT 0`, () => {});

  // === PHASE 1: Historical Spread Analyzer ===
  db.run(`CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    quality INTEGER DEFAULT 1,
    city TEXT NOT NULL,
    sell_price_min INTEGER DEFAULT 0,
    buy_price_max INTEGER DEFAULT 0,
    sell_date TEXT,
    buy_date TEXT,
    recorded_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ps_item_city ON price_snapshots(item_id, city, recorded_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ps_recorded ON price_snapshots(recorded_at)`);
  db.run(`ALTER TABLE price_snapshots ADD COLUMN sell_date TEXT`, () => {});
  db.run(`ALTER TABLE price_snapshots ADD COLUMN buy_date TEXT`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS spread_stats (
    item_id TEXT NOT NULL,
    quality INTEGER DEFAULT 1,
    buy_city TEXT NOT NULL,
    sell_city TEXT NOT NULL,
    avg_spread REAL DEFAULT 0,
    median_spread REAL DEFAULT 0,
    consistency_pct REAL DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    window_days INTEGER DEFAULT 7,
    confidence_score REAL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(item_id, quality, buy_city, sell_city, window_days)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_spread_stats_search ON spread_stats(window_days, avg_spread, confidence_score)`);

  db.run(`CREATE TABLE IF NOT EXISTS price_averages (
    item_id TEXT NOT NULL,
    quality INTEGER DEFAULT 1,
    city TEXT NOT NULL,
    avg_sell INTEGER DEFAULT 0,
    avg_buy INTEGER DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    period_type TEXT NOT NULL,
    period_start INTEGER NOT NULL,
    PRIMARY KEY(item_id, quality, city, period_type, period_start)
  )`);

  // === PHASE 3: Community Scanning Incentives ===
  db.run(`CREATE TABLE IF NOT EXISTS contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    item_count INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_contrib_user ON contributions(user_id, created_at)`);

  db.run(`CREATE TABLE IF NOT EXISTS user_stats (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    avatar TEXT,
    scans_30d INTEGER DEFAULT 0,
    scans_total INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'bronze',
    updated_at INTEGER NOT NULL
  )`);


  // === SERVER MIGRATION: detect if data was collected from a different game server ===
  // Store which game server the data was collected from
  db.run(`CREATE TABLE IF NOT EXISTS meta_config (key TEXT PRIMARY KEY, value TEXT)`);
  db.get(`SELECT value FROM meta_config WHERE key = 'game_server'`, (err, row) => {
    const prevServer = row ? row.value : null;
    if (prevServer && prevServer !== GAME_SERVER) {
      console.log(`[Migration] Game server changed from ${prevServer} to ${GAME_SERVER}. Clearing historical data for re-collection...`);
      db.run(`DELETE FROM price_snapshots`);
      db.run(`DELETE FROM price_averages`);
      db.run(`DELETE FROM spread_stats`);
      console.log('[Migration] Old data cleared. Backfill will re-run for new server.');
    }
    db.run(`INSERT OR REPLACE INTO meta_config (key, value) VALUES ('game_server', ?)`, [GAME_SERVER]);
  });
});

// === SHARED MARKET CACHE ===
let cacheTimestamp = null;
let cacheItemCount = 0;
let cachedGzipBuffer = null;
let scanInProgress = false;

async function doServerScan() {
  if (scanInProgress) { console.log('[Cache] Scan already in progress, skipping.'); return; }
  scanInProgress = true;
  console.log('[Cache] Starting full market scan...');

  try {
    const itemsRes = await fetch(ITEMS_URL);
    if (!itemsRes.ok) throw new Error('Failed to fetch items.json: HTTP ' + itemsRes.status);
    itemNames = await itemsRes.json();
    const itemIds = Object.keys(itemNames).filter(k => k && itemNames[k]);
    console.log(`[Cache] Loaded ${itemIds.length} item IDs.`);

    const priceMap = new Map();

    for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
      const chunk = itemIds.slice(i, i + CHUNK_SIZE);
      try {
        const url = `${API_BASE}/${chunk.join(',')}.json`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          for (const entry of data) {
            if (entry.sell_price_min > 0 || entry.buy_price_max > 0) {
              const key = `${entry.item_id}|${entry.city}|${entry.quality}`;
              const existing = priceMap.get(key);

              const minimalEntry = {
                item_id: entry.item_id,
                city: entry.city,
                quality: entry.quality,
                sell_price_min: entry.sell_price_min,
                sell_price_min_date: entry.sell_price_min_date,
                buy_price_max: entry.buy_price_max,
                buy_price_max_date: entry.buy_price_max_date
              };

              if (!existing) {
                priceMap.set(key, minimalEntry);
              } else {
                if (minimalEntry.sell_price_min > 0 && (existing.sell_price_min === 0 || minimalEntry.sell_price_min < existing.sell_price_min)) {
                  existing.sell_price_min = minimalEntry.sell_price_min;
                  existing.sell_price_min_date = minimalEntry.sell_price_min_date;
                }
                if (minimalEntry.buy_price_max > 0 && minimalEntry.buy_price_max > existing.buy_price_max) {
                  existing.buy_price_max = minimalEntry.buy_price_max;
                  existing.buy_price_max_date = minimalEntry.buy_price_max_date;
                }
              }
            }
          }
        }
      } catch (e) { console.error(`[Cache] Chunk ${i} failed:`, e.message); }

      // Brief pause between chunks to avoid hammering the API
      if (i + CHUNK_SIZE < itemIds.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    const allPrices = Array.from(priceMap.values());
    priceMap.clear();

    cacheTimestamp = new Date().toISOString();
    cacheItemCount = allPrices.length;

    // Seed alerter with scan data
    seedAlerterFromScan(allPrices);

    // Record snapshots for historical analysis
    recordSnapshots(allPrices);

    const json = JSON.stringify({ timestamp: cacheTimestamp, count: cacheItemCount, data: allPrices });
    zlib.gzip(json, (err, buffer) => {
        if (!err) {
            cachedGzipBuffer = buffer;
            console.log(`[Cache] Scan complete: ${cacheItemCount} entries. Compressed: ${Math.round(buffer.length/1024)}KB`);
        }
        scanInProgress = false;
    });
  } catch (err) {
    console.error('[Cache] Scan failed:', err);
    scanInProgress = false;
  }
}

setTimeout(doServerScan, 5000);
setInterval(doServerScan, SCAN_INTERVAL_MS);

// === DISCORD BOT ===
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = [
  {
    name: 'setup_alerts',
    description: 'Start arbitrage alerts in this channel',
    options: [
      { name: 'min_profit', type: 4, description: 'Minimum silver profit (e.g. 50000)', required: true },
      { name: 'cooldown', type: 4, description: 'Minutes between alerts for the same item (default: 10)', required: false },
      { name: 'min_confidence', type: 4, description: 'Minimum confidence % (0=any, 40=medium, 70=high)', required: false }
    ]
  },
  {
    name: 'stop_alerts',
    description: 'Stop market alerts in this channel'
  },
  {
    name: 'my_alerts',
    description: 'Show active alert settings for this channel'
  },
  {
    name: 'status',
    description: 'Show bot status and market data stats'
  },
  {
    name: 'set_confidence',
    description: 'Set minimum confidence threshold for alerts (0-100)',
    options: [
      { name: 'min_confidence', type: 4, description: 'Minimum confidence score (0 = any, 40 = medium, 70 = high)', required: true }
    ]
  },
  {
    name: 'scan',
    description: 'Scan a specific item for fresh market data and earn contribution points',
    options: [
      { name: 'item', type: 3, description: 'Item name or ID (e.g. T4_BAG, Elder Bag)', required: true }
    ]
  },
  {
    name: 'leaderboard',
    description: 'Show top market scanners this month'
  },
  {
    name: 'mystats',
    description: 'Show your scanning stats and contributor tier'
  }
];

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

client.on('clientReady', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered Slash Commands successfully!');
  } catch (error) { console.error('Failed to register commands:', error); }
});

let totalAlertsSent = 0;
let lastAlertTime = null;

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setup_alerts') {
    const minP = interaction.options.getInteger('min_profit');
    const cooldown = interaction.options.getInteger('cooldown') || 10;
    const cooldownMs = Math.max(1, Math.min(120, cooldown)) * 60 * 1000;
    const minConf = Math.max(0, Math.min(100, interaction.options.getInteger('min_confidence') || 0));
    db.run(`INSERT OR REPLACE INTO alerts (guild_id, channel_id, min_profit, cooldown_ms, min_confidence) VALUES (?, ?, ?, ?, ?)`,
      [interaction.guildId, interaction.channelId, minP, cooldownMs, minConf], (err) => {
      if(err) return interaction.reply({content: 'DB Error :(', ephemeral: true});
      const fields = [
        { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
        { name: 'Min Profit', value: `${minP.toLocaleString()} silver`, inline: true },
        { name: 'Cooldown', value: `${cooldown} min per item`, inline: true }
      ];
      if (minConf > 0) fields.push({ name: 'Min Confidence', value: `${minConf}%+`, inline: true });
      interaction.reply({ embeds: [{
        title: 'Alerts Configured',
        color: 0x00ff00,
        fields,
        footer: { text: 'Coldtouch Market Analyzer • Use /set_confidence to change threshold later' }
      }]});
    });
  }

  if (interaction.commandName === 'stop_alerts') {
    db.run(`DELETE FROM alerts WHERE guild_id = ? AND channel_id = ?`, [interaction.guildId, interaction.channelId], (err) => {
      interaction.reply({ embeds: [{
        title: 'Alerts Stopped',
        color: 0xff4444,
        description: `Alerts have been removed from <#${interaction.channelId}>.`,
        footer: { text: 'Coldtouch Market Analyzer' }
      }]});
    });
  }

  if (interaction.commandName === 'my_alerts') {
    db.all(`SELECT channel_id, min_profit, cooldown_ms, min_confidence FROM alerts WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
      if (err || !rows || rows.length === 0) {
        return interaction.reply({ embeds: [{
          title: 'No Active Alerts',
          color: 0x888888,
          description: 'Use `/setup_alerts` to configure alerts in a channel.',
          footer: { text: 'Coldtouch Market Analyzer' }
        }], ephemeral: true });
      }
      const lines = rows.map(r => {
        const conf = r.min_confidence || 0;
        const confLabel = conf > 0 ? `, confidence **${conf}%+**` : '';
        return `<#${r.channel_id}> — min **${r.min_profit.toLocaleString()}** silver, cooldown **${Math.round((r.cooldown_ms || 600000) / 60000)}** min${confLabel}`;
      });
      interaction.reply({ embeds: [{
        title: `Active Alerts (${rows.length})`,
        color: 0xffd700,
        description: lines.join('\\n'),
        footer: { text: 'Coldtouch Market Analyzer • Use /set_confidence to filter by reliability' }
      }], ephemeral: true });
    });
  }

  if (interaction.commandName === 'set_confidence') {
    const minConf = Math.max(0, Math.min(100, interaction.options.getInteger('min_confidence')));
    db.run(`UPDATE alerts SET min_confidence = ? WHERE guild_id = ? AND channel_id = ?`,
      [minConf, interaction.guildId, interaction.channelId], (err) => {
      if (err) {
        // Try to check if alert exists
        return interaction.reply({ content: 'No alert configured in this channel. Use `/setup_alerts` first.', ephemeral: true });
      }
      const label = minConf === 0 ? 'Any (all alerts)' : minConf >= 70 ? `${minConf}% (High confidence only)` : minConf >= 40 ? `${minConf}% (Medium+ confidence)` : `${minConf}%`;
      interaction.reply({ embeds: [{
        title: 'Confidence Threshold Updated',
        color: 0x5865F2,
        fields: [
          { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
          { name: 'Min Confidence', value: label, inline: true }
        ],
        description: minConf > 0 ? 'Alerts will only fire for routes with historical confidence at or above this level.' : 'All profitable alerts will be sent regardless of historical confidence.',
        footer: { text: 'Coldtouch Market Analyzer' }
      }]});
    });
  }

  if (interaction.commandName === 'status') {
    let trackedItems = 0, trackedCities = 0;
    for (const id of Object.keys(alertMarketDb)) {
      for (const q of Object.keys(alertMarketDb[id])) {
        trackedCities += Object.keys(alertMarketDb[id][q]).length;
      }
      trackedItems++;
    }
    db.all(`SELECT COUNT(*) as cnt FROM alerts`, [], (err, rows) => {
      const alertCount = (rows && rows[0]) ? rows[0].cnt : 0;
      interaction.reply({ embeds: [{
        title: 'Market Analyzer Bot Status',
        color: 0x5865F2,
        fields: [
          { name: 'Items Tracked', value: trackedItems.toLocaleString(), inline: true },
          { name: 'Price Points', value: trackedCities.toLocaleString(), inline: true },
          { name: 'Active Alert Channels', value: alertCount.toString(), inline: true },
          { name: 'Alerts Sent (this session)', value: totalAlertsSent.toString(), inline: true },
          { name: 'Last Alert', value: lastAlertTime ? `<t:${Math.floor(lastAlertTime/1000)}:R>` : 'None yet', inline: true },
          { name: 'Market Scan', value: cacheTimestamp ? `${cacheItemCount.toLocaleString()} entries, last scan <t:${Math.floor(new Date(cacheTimestamp).getTime()/1000)}:R>` : 'Pending...', inline: false }
        ],
        footer: { text: 'Coldtouch Market Analyzer' }
      }]});
    });
  }

  if (interaction.commandName === 'scan') {
    const searchTerm = interaction.options.getString('item').trim();
    await interaction.deferReply();

    // Fuzzy match item
    const searchLower = searchTerm.toLowerCase();
    let matchedId = null;
    for (const [id, name] of Object.entries(itemNames)) {
      if (id.toLowerCase() === searchLower || (name && name.toLowerCase() === searchLower)) {
        matchedId = id;
        break;
      }
    }
    if (!matchedId) {
      const words = searchLower.split(' ').filter(w => w);
      for (const [id, name] of Object.entries(itemNames)) {
        const target = ((name || '') + ' ' + id.replace(/_/g, ' ')).toLowerCase();
        if (words.every(w => target.includes(w))) { matchedId = id; break; }
      }
    }

    if (!matchedId) {
      return interaction.editReply({ content: `Could not find item matching "${searchTerm}". Try an exact item ID like T4_BAG.` });
    }

    try {
      const url = `${API_BASE}/${matchedId}.json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('API error');
      const data = await res.json();

      // Update alertMarketDb with fresh data
      for (const entry of data) {
        if (!entry.item_id || !entry.city) continue;
        const id2 = entry.item_id, q2 = entry.quality || 1, city2 = entry.city;
        if (!alertMarketDb[id2]) alertMarketDb[id2] = {};
        if (!alertMarketDb[id2][q2]) alertMarketDb[id2][q2] = {};
        if (!alertMarketDb[id2][q2][city2]) alertMarketDb[id2][q2][city2] = { sellMin: Infinity, buyMax: 0, sellDate: 0, buyDate: 0 };
        const now2 = Date.now();
        alertMarketDb[id2][q2][city2].lastSeen = now2;
        if (entry.sell_price_min > 0) { alertMarketDb[id2][q2][city2].sellMin = entry.sell_price_min; alertMarketDb[id2][q2][city2].sellDate = now2; }
        if (entry.buy_price_max > 0) { alertMarketDb[id2][q2][city2].buyMax = entry.buy_price_max; alertMarketDb[id2][q2][city2].buyDate = now2; }
      }

      // Record contribution
      const userId = interaction.user.id;
      db.run(`INSERT INTO contributions (user_id, source, item_count, created_at) VALUES (?, ?, ?, ?)`,
        [userId, 'discord_scan', 1, Date.now()]);
      // Ensure user exists in users table
      db.run(`INSERT OR IGNORE INTO users (id, username, avatar) VALUES (?, ?, ?)`,
        [userId, interaction.user.username, interaction.user.avatar]);

      // Build price summary
      const cities = {};
      for (const entry of data) {
        if (entry.quality !== 1 && entry.quality) continue;
        let c = entry.city;
        if (!c) continue;
        cities[c] = { sell: entry.sell_price_min || 0, buy: entry.buy_price_max || 0 };
      }
      const priceLines = Object.entries(cities).map(([c, p]) => {
        const sell = p.sell > 0 ? p.sell.toLocaleString() : '—';
        const buy = p.buy > 0 ? p.buy.toLocaleString() : '—';
        return `**${c}**: Buy ${sell} / Sell ${buy}`;
      }).join('\\n');

      interaction.editReply({ embeds: [{
        title: `Scanned: ${getFriendlyName(matchedId)}`,
        color: 0x00ff00,
        thumbnail: { url: `https://render.albiononline.com/v1/item/${matchedId}.png` },
        description: priceLines || 'No price data available.',
        footer: { text: `+1 scan contribution • Coldtouch Market Analyzer` }
      }]});
    } catch (e) {
      interaction.editReply({ content: `Failed to scan: ${e.message}` });
    }
  }

  if (interaction.commandName === 'leaderboard') {
    db.all(`SELECT user_id, username, avatar, scans_30d, tier FROM user_stats WHERE scans_30d > 0 ORDER BY scans_30d DESC LIMIT 10`, [], (err, rows) => {
      if (err || !rows || rows.length === 0) {
        return interaction.reply({ embeds: [{
          title: 'Leaderboard',
          color: 0xffd700,
          description: 'No contributions yet. Use `/scan` or refresh items on the website to start!',
          footer: { text: 'Coldtouch Market Analyzer' }
        }]});
      }
      const tierEmoji = { diamond: '💎', gold: '🥇', silver: '🥈', bronze: '🥉' };
      const lines = rows.map((r, i) => {
        const emoji = tierEmoji[r.tier] || '🥉';
        return `**${i + 1}.** ${emoji} ${r.username || 'Unknown'} — **${r.scans_30d}** scans`;
      });
      interaction.reply({ embeds: [{
        title: '🏆 Top Scanners (30 days)',
        color: 0xffd700,
        description: lines.join('\\n'),
        footer: { text: 'Scan items with /scan or refresh on the website to climb!' }
      }]});
    });
  }

  if (interaction.commandName === 'mystats') {
    const userId = interaction.user.id;
    db.get(`SELECT scans_30d, scans_total, tier FROM user_stats WHERE user_id = ?`, [userId], (err, row) => {
      if (err || !row) {
        return interaction.reply({ embeds: [{
          title: 'Your Stats',
          color: 0x888888,
          description: 'No scanning activity yet. Use `/scan` or refresh items on the website to get started!',
          footer: { text: 'Coldtouch Market Analyzer' }
        }], ephemeral: true });
      }
      const tierEmoji = { diamond: '💎', gold: '🥇', silver: '🥈', bronze: '🥉' };
      const nextTier = { bronze: { name: 'Silver', need: 50 }, silver: { name: 'Gold', need: 200 }, gold: { name: 'Diamond', need: 500 }, diamond: null };
      const next = nextTier[row.tier];
      const progressLine = next ? `**${row.scans_30d}/${next.need}** scans to reach ${next.name}` : 'Maximum tier reached!';

      // Get rank
      db.get(`SELECT COUNT(*) + 1 as rank FROM user_stats WHERE scans_30d > ?`, [row.scans_30d], (err2, rankRow) => {
        const rank = rankRow ? rankRow.rank : '?';
        interaction.reply({ embeds: [{
          title: `${tierEmoji[row.tier] || '🥉'} ${interaction.user.username}'s Stats`,
          color: row.tier === 'diamond' ? 0xb9f2ff : row.tier === 'gold' ? 0xffd700 : row.tier === 'silver' ? 0xc0c0c0 : 0xcd7f32,
          fields: [
            { name: 'Tier', value: row.tier.charAt(0).toUpperCase() + row.tier.slice(1), inline: true },
            { name: 'Rank', value: `#${rank}`, inline: true },
            { name: 'Scans (30d)', value: row.scans_30d.toString(), inline: true },
            { name: 'Total Scans', value: row.scans_total.toString(), inline: true },
            { name: 'Progress', value: progressLine, inline: false }
          ],
          footer: { text: 'Coldtouch Market Analyzer' }
        }], ephemeral: true });
      });
    });
  }
});

client.login(BOT_TOKEN).catch(e => console.error('[Discord] Login failed (rate limited):', e.message));

// === EXPRESS APP ===
const app = express();
app.use(cors({ origin: 'https://coldtouch.github.io', credentials: true }));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: '/opt/albion-saas' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,  // must be true so OAuth state is persisted before Discord redirect
  cookie: {
    secure: true,
    sameSite: 'none',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  callbackURL: `https://${domain}/auth/discord/callback`,
  scope: ['identify']  // 'guilds' removed — caused passport-discord to make a secondary API call that hangs
}, (accessToken, refreshToken, profile, done) => {
  db.run(`INSERT OR REPLACE INTO users (id, username, avatar) VALUES (?, ?, ?)`, [profile.id, profile.username, profile.avatar]);
  return done(null, profile);
}));

app.use(passport.initialize());
app.use(passport.session());

// Explicit scope on the authenticate call; 'guilds' omitted intentionally (see strategy above)
app.get('/auth/discord', passport.authenticate('discord', { scope: ['identify'] }));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: 'https://coldtouch.github.io/coldtouch-market-analyzer?login=failed' }), (req, res) => {
  // Explicitly flush session to SQLite before redirecting.
  // Without this, there is a race condition: the browser arrives at ?login=success
  // and immediately calls /api/me, but the session write is still pending,
  // so req.user is undefined and the user appears logged out.
  req.session.save(() => {
    res.redirect(`https://coldtouch.github.io/coldtouch-market-analyzer?login=success`);
  });
});

app.get('/api/me', (req, res) => {
  if(req.user) {
    db.get(`SELECT scans_30d, scans_total, tier FROM user_stats WHERE user_id = ?`, [req.user.id], (err, stats) => {
      res.json({
        loggedIn: true,
        user: req.user,
        stats: stats || { scans_30d: 0, scans_total: 0, tier: 'bronze' }
      });
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// === SHARED MARKET CACHE ENDPOINTS ===
app.get('/api/market-cache', (req, res) => {
  if (!cachedGzipBuffer) {
    return res.status(503).json({ error: 'Market cache is still building. Try again in ~2 minutes.' });
  }
  res.set('Content-Type', 'application/json');
  res.set('Content-Encoding', 'gzip');
  res.set('Cache-Control', 'public, max-age=60');
  res.send(cachedGzipBuffer);
});

app.get('/api/market-cache/status', (req, res) => {
  res.json({
    available: !!cachedGzipBuffer,
    timestamp: cacheTimestamp,
    entries: cacheItemCount,
    sizeKB: cachedGzipBuffer ? Math.round(cachedGzipBuffer.length / 1024) : 0,
    scanning: scanInProgress,
    gameServer: GAME_SERVER
  });
});

// === ALERT CRUD ENDPOINTS (auth required) ===
app.use(express.json());

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  next();
}

app.get('/api/alerts', requireAuth, (req, res) => {
  db.all(`SELECT guild_id, channel_id, min_profit, cooldown_ms FROM alerts`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/alerts', requireAuth, (req, res) => {
  const { channel_id, min_profit } = req.body;
  if (!channel_id || !min_profit) return res.status(400).json({ error: 'channel_id and min_profit required' });
  const profit = parseInt(min_profit);
  if (isNaN(profit) || profit < 0 || profit > 100000000) return res.status(400).json({ error: 'min_profit must be between 0 and 100,000,000' });
  const guildId = 'web-' + channel_id;
  db.run(`INSERT OR REPLACE INTO alerts (guild_id, channel_id, min_profit) VALUES (?, ?, ?)`,
    [guildId, channel_id, profit], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, channel_id, min_profit: profit });
  });
});

app.delete('/api/alerts', requireAuth, (req, res) => {
  const { channel_id } = req.body;
  if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
  db.run(`DELETE FROM alerts WHERE channel_id = ?`, [channel_id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// === COMMUNITY: User Stats Recomputation (every 5 min) ===
function recomputeUserStats() {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  db.all(`SELECT c.user_id, COUNT(*) as cnt_30d, u.username, u.avatar
    FROM contributions c LEFT JOIN users u ON c.user_id = u.id
    WHERE c.created_at > ? GROUP BY c.user_id`, [thirtyDaysAgo], (err, rows30) => {
    if (err || !rows30) return;

    db.all(`SELECT user_id, COUNT(*) as cnt_total FROM contributions GROUP BY user_id`, [], (err2, rowsTotal) => {
      if (err2) return;
      const totalMap = {};
      for (const r of (rowsTotal || [])) totalMap[r.user_id] = r.cnt_total;

      for (const r of rows30) {
        const total = totalMap[r.user_id] || r.cnt_30d;
        let tier = 'bronze';
        if (r.cnt_30d >= 500) tier = 'diamond';
        else if (r.cnt_30d >= 200) tier = 'gold';
        else if (r.cnt_30d >= 50) tier = 'silver';

        db.run(`INSERT OR REPLACE INTO user_stats (user_id, username, avatar, scans_30d, scans_total, tier, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [r.user_id, r.username || '', r.avatar || '', r.cnt_30d, total, tier, now]);
      }
    });
  });
}

// Run stats recomputation every 5 min, first after 60s
setTimeout(recomputeUserStats, 60 * 1000);
setInterval(recomputeUserStats, 5 * 60 * 1000);

// Leaderboard memory cache
let leaderboardCache = null;
let leaderboardCacheTime = 0;

// === COMMUNITY API ENDPOINTS ===
const contribLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

app.post('/api/contributions', requireAuth, contribLimiter, (req, res) => {
  const { item_ids, source } = req.body;
  if (!item_ids || !Array.isArray(item_ids) || item_ids.length === 0) {
    return res.status(400).json({ error: 'item_ids array required' });
  }
  const validSources = ['web_refresh', 'web_compare'];
  const src = validSources.includes(source) ? source : 'web_refresh';
  const userId = req.user.id;
  const now = Date.now();

  db.run(`INSERT INTO contributions (user_id, source, item_count, created_at) VALUES (?, ?, ?, ?)`,
    [userId, src, item_ids.length, now], (err) => {
    if (err) return res.status(500).json({ error: err.message });

    // Return updated stats
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    db.get(`SELECT COUNT(*) as cnt FROM contributions WHERE user_id = ? AND created_at > ?`, [userId, thirtyDaysAgo], (err2, row) => {
      const scans30d = row ? row.cnt : 0;
      let tier = 'bronze';
      if (scans30d >= 500) tier = 'diamond';
      else if (scans30d >= 200) tier = 'gold';
      else if (scans30d >= 50) tier = 'silver';
      res.json({ success: true, scans_30d: scans30d, tier });
    });
  });
});

app.get('/api/my-stats', requireAuth, (req, res) => {
  const userId = req.user.id;
  db.get(`SELECT scans_30d, scans_total, tier FROM user_stats WHERE user_id = ?`, [userId], (err, row) => {
    if (err || !row) return res.json({ scans_30d: 0, scans_total: 0, tier: 'bronze', rank: 0 });
    db.get(`SELECT COUNT(*) + 1 as rank FROM user_stats WHERE scans_30d > ?`, [row.scans_30d], (err2, rankRow) => {
      res.json({
        scans_30d: row.scans_30d,
        scans_total: row.scans_total,
        tier: row.tier,
        rank: rankRow ? rankRow.rank : 0
      });
    });
  });
});

app.get('/api/leaderboard', (req, res) => {
  const now = Date.now();
  if (leaderboardCache && now - leaderboardCacheTime < 60000) {
    return res.json(leaderboardCache);
  }
  db.all(`SELECT user_id, username, avatar, scans_30d, tier FROM user_stats WHERE scans_30d > 0 ORDER BY scans_30d DESC LIMIT 20`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    leaderboardCache = rows || [];
    leaderboardCacheTime = now;
    res.json(leaderboardCache);
  });
});

// === SPREAD STATS API ===
app.get('/api/spread-stats', (req, res) => {
  const { item_id, quality } = req.query;
  if (!item_id) return res.status(400).json({ error: 'item_id required' });
  const q = parseInt(quality) || 1;
  db.all(
    `SELECT * FROM spread_stats WHERE item_id = ? AND quality = ? AND window_days = 7 ORDER BY confidence_score DESC`,
    [item_id, q],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.get('/api/spread-stats/top', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);
  const minConfidence = parseInt(req.query.min_confidence) || 0;
  db.all(
    `SELECT * FROM spread_stats WHERE window_days = 7 AND confidence_score >= ? AND avg_spread > 0 ORDER BY confidence_score DESC LIMIT ?`,
    [minConfidence, limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// === TRANSPORT ROUTES API ===
// Returns profitable routes enriched with daily volume data for bulk transport
app.get('/api/transport-routes', (req, res) => {
  const buyCity = req.query.buy_city || '';
  const sellCity = req.query.sell_city || '';
  const minProfit = parseInt(req.query.min_profit) || 0;
  const minConfidence = parseInt(req.query.min_confidence) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 100, 200);

  // Get spread_stats routes that are profitable, then enrich with volume
  const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;

  let whereClause = `WHERE ss.window_days = 7 AND ss.avg_spread > ? AND ss.confidence_score >= ?`;
  const params = [cutoff7d, cutoff7d, minProfit, minConfidence];

  if (buyCity) { whereClause += ` AND ss.buy_city = ?`; params.push(buyCity); }
  if (sellCity) { whereClause += ` AND ss.sell_city = ?`; params.push(sellCity); }

  // Join spread_stats with volume data from price_averages
  // Volume = average daily item_count (sample_count) over last 7 days for the buy city
  const sql = `
    SELECT
      ss.item_id, ss.quality, ss.buy_city, ss.sell_city,
      ss.avg_spread, ss.median_spread, ss.consistency_pct,
      ss.sample_count, ss.confidence_score,
      (SELECT COALESCE(AVG(sample_count), 0) FROM price_averages WHERE item_id = ss.item_id AND quality = ss.quality AND city = ss.buy_city AND period_type = 'daily' AND period_start > ?) as buy_volume,
      (SELECT COALESCE(AVG(sample_count), 0) FROM price_averages WHERE item_id = ss.item_id AND quality = ss.quality AND city = ss.sell_city AND period_type = 'daily' AND period_start > ?) as sell_volume
    FROM spread_stats ss
    ${whereClause}
    ORDER BY (ss.avg_spread * (SELECT COALESCE(AVG(sample_count), 0) FROM price_averages WHERE item_id = ss.item_id AND quality = ss.quality AND city = ss.buy_city AND period_type = 'daily' AND period_start > ?)) DESC
    LIMIT ?
  `;
  params.push(cutoff7d, limit);

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/price-history', (req, res) => {
  const { item_id, city, days } = req.query;
  if (!item_id) return res.status(400).json({ error: 'item_id required' });
  const daysBack = Math.min(parseInt(days) || 7, 90);
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  // Get raw snapshots for recent data
  const query = city
    ? `SELECT sell_price_min, buy_price_max, recorded_at FROM price_snapshots WHERE item_id = ? AND city = ? AND recorded_at > ? ORDER BY recorded_at`
    : `SELECT city, sell_price_min, buy_price_max, recorded_at FROM price_snapshots WHERE item_id = ? AND recorded_at > ? ORDER BY recorded_at`;

  const params = city ? [item_id, city, cutoff] : [item_id, cutoff];
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// === TLS SERVER & WSS ===
const server = https.createServer({
  cert: fs.readFileSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`),
  key: fs.readFileSync(`/etc/letsencrypt/live/${domain}/privkey.pem`)
}, app);

const wss = new WebSocket.Server({ server });
let wsClients = new Set();
wss.on('connection', ws => { wsClients.add(ws); ws.on('close', () => wsClients.delete(ws)); });

// === ALERTER LOGIC ===
const TAX_RATE = 0.065;
const alertMarketDb = {};
const CITY_NAMES = { 'Thetford': 'Thetford', 'Lymhurst': 'Lymhurst', 'Bridgewatch': 'Bridgewatch', 'Black Market': 'Black Market', 'Caerleon': 'Caerleon', 'Fort Sterling': 'Fort Sterling', 'Martlock': 'Martlock', 'Brecilien': 'Brecilien' };
const API_LOCALE_MAP = { '0': 'Thetford', '7': 'Thetford', '3004': 'Thetford', '3': 'Lymhurst', '1002': 'Lymhurst', '4': 'Bridgewatch', '2004': 'Bridgewatch', '3003': 'Black Market', '3005': 'Caerleon', '3008': 'Fort Sterling', '4000': 'Martlock', '4300': 'Brecilien' };
function getCity(id) { return API_LOCALE_MAP[id] || CITY_NAMES[id] || 'City-'+id; }
function getFriendlyName(id) { return itemNames[id] || id; }
function getQualityName(q) { return ['', 'Normal', 'Good', 'Outstanding', 'Excellent', 'Masterpiece'][q] || 'Normal'; }

// Live price validation — fetches current prices from the API right before sending an alert
// to confirm the spread still exists and hasn't moved significantly since it was cached.
async function validatePricesLive(id, q, buyCity, sellCity, expectedSellPrice, expectedBuyPrice) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const locs = [buyCity, sellCity].map(c => encodeURIComponent(c)).join(',');
    const url = `${API_BASE}/${encodeURIComponent(id)}.json?locations=${locs}&qualities=${q}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return true; // Can't verify — allow through rather than silence valid alerts

    const data = await res.json();
    let liveSellMin = 0, liveBuyMax = 0;
    for (const entry of data) {
      if (entry.city === buyCity && entry.quality === q && entry.sell_price_min > 0) {
        if (liveSellMin === 0 || entry.sell_price_min < liveSellMin) liveSellMin = entry.sell_price_min;
      }
      if (entry.city === sellCity && entry.quality === q && entry.buy_price_max > 0) {
        if (entry.buy_price_max > liveBuyMax) liveBuyMax = entry.buy_price_max;
      }
    }
    // Listing is gone entirely
    if (liveSellMin <= 0 || liveBuyMax <= 0) {
      console.log(`[Validate] ${id} q${q}: listing gone (sell=${liveSellMin} buy=${liveBuyMax}), skipping alert`);
      return false;
    }
    // Sell price moved >10% higher — deal is worse than what we cached
    if (liveSellMin > expectedSellPrice * 1.1) {
      console.log(`[Validate] ${id} q${q}: sell price moved up ${liveSellMin} vs expected ~${Math.round(expectedSellPrice)}, skipping`);
      return false;
    }
    // Buy order moved >10% lower — deal is worse than what we cached
    if (liveBuyMax < expectedBuyPrice * 0.9) {
      console.log(`[Validate] ${id} q${q}: buy price moved down ${liveBuyMax} vs expected ~${Math.round(expectedBuyPrice)}, skipping`);
      return false;
    }
    // Re-verify profit is still positive with live prices
    if (liveBuyMax - liveSellMin - (liveBuyMax * TAX_RATE) <= 0) {
      console.log(`[Validate] ${id} q${q}: live prices no longer profitable, skipping`);
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') console.log(`[Validate] ${id} q${q}: timed out, allowing alert through`);
    return true; // Allow through on timeout/error — don't silence potentially valid alerts
  }
}

const alertCooldowns = {};
const FRESHNESS_THRESHOLD = 30 * 60 * 1000; // 30 min — data must be this fresh to trigger alerts
const MIN_SAMPLE_THRESHOLD = 3; // Minimum historical samples required before alerting (blocks low-liquidity false positives)

// Seed alerter from the periodic server scan so it starts with full market coverage
function seedAlerterFromScan(allPrices) {
  const now = Date.now();
  let seeded = 0;
  for (const entry of allPrices) {
    const id = entry.item_id, q = entry.quality || 1, city = entry.city;
    if (!id || !city) continue;
    if (!alertMarketDb[id]) alertMarketDb[id] = {};
    if (!alertMarketDb[id][q]) alertMarketDb[id][q] = {};

    // Parse the date from the API to track freshness
    const sellDate = entry.sell_price_min_date && !entry.sell_price_min_date.startsWith('0001') ? new Date(entry.sell_price_min_date).getTime() : 0;
    const buyDate = entry.buy_price_max_date && !entry.buy_price_max_date.startsWith('0001') ? new Date(entry.buy_price_max_date).getTime() : 0;

    const existing = alertMarketDb[id][q][city];
    if (!existing) {
      alertMarketDb[id][q][city] = {
        sellMin: entry.sell_price_min || Infinity,
        sellDate: sellDate,
        buyMax: entry.buy_price_max || 0,
        buyDate: buyDate,
        lastSeen: now
      };
      seeded++;
    } else {
      // Update if better price or newer date
      if (entry.sell_price_min > 0 && (existing.sellMin === Infinity || entry.sell_price_min < existing.sellMin || sellDate > existing.sellDate)) {
        existing.sellMin = entry.sell_price_min;
        existing.sellDate = sellDate;
      }
      if (entry.buy_price_max > 0 && (entry.buy_price_max > existing.buyMax || buyDate > existing.buyDate)) {
        existing.buyMax = entry.buy_price_max;
        existing.buyDate = buyDate;
      }
      existing.lastSeen = now;
    }
  }
  console.log(`[Alerter] Seeded with ${seeded} new price points from server scan`);
}

// Evict stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(alertCooldowns)) {
    if (now - alertCooldowns[key] > 3600000) delete alertCooldowns[key];
  }
  let evicted = 0;
  for (const itemId of Object.keys(alertMarketDb)) {
    for (const q of Object.keys(alertMarketDb[itemId])) {
      for (const loc of Object.keys(alertMarketDb[itemId][q])) {
        const entry = alertMarketDb[itemId][q][loc];
        if (entry.lastSeen && now - entry.lastSeen > 7200000) {
          delete alertMarketDb[itemId][q][loc];
          evicted++;
        }
      }
      if (Object.keys(alertMarketDb[itemId][q]).length === 0) delete alertMarketDb[itemId][q];
    }
    if (Object.keys(alertMarketDb[itemId]).length === 0) delete alertMarketDb[itemId];
  }
  if (evicted > 0) console.log(`[Eviction] Cleared ${evicted} stale alertMarketDb entries`);
}, 1800000);

function checkAndAlert(id, q) {
  if (!alertMarketDb[id] || !alertMarketDb[id][q]) return;
  const now = Date.now();

  let bestSell = { price: Infinity, loc: null, date: 0 };
  let bestBuy = { price: 0, loc: null, date: 0 };

  for (const [city, cd] of Object.entries(alertMarketDb[id][q])) {
    if (cd.sellMin > 0 && cd.sellMin < Infinity && cd.sellMin < bestSell.price) {
      bestSell = { price: cd.sellMin, loc: city, date: cd.sellDate || cd.lastSeen };
    }
    if (cd.buyMax > 0 && cd.buyMax > bestBuy.price) {
      bestBuy = { price: cd.buyMax, loc: city, date: cd.buyDate || cd.lastSeen };
    }
  }

  if (!bestSell.loc || !bestBuy.loc || bestSell.loc === bestBuy.loc) return;

  // Both sides must be fresh to ensure the spread is real
  const sellFresh = (now - bestSell.date) < FRESHNESS_THRESHOLD;
  const buyFresh = (now - bestBuy.date) < FRESHNESS_THRESHOLD;
  if (!sellFresh || !buyFresh) return;

  const profit = bestBuy.price - bestSell.price - (bestBuy.price * TAX_RATE);
  if (profit <= 0) return;
  const roi = ((profit / bestSell.price) * 100).toFixed(1);

  const buyAge = Math.round((now - bestSell.date) / 60000);
  const sellAge = Math.round((now - bestBuy.date) / 60000);
  const freshLabel = (mins) => mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago' : Math.floor(mins/60) + 'h ago';

  // Look up historical confidence for this route
  const buyCity = getCity(bestSell.loc);
  const sellCity = getCity(bestBuy.loc);

  db.get(`SELECT confidence_score, consistency_pct, avg_spread, sample_count FROM spread_stats WHERE item_id = ? AND quality = ? AND buy_city = ? AND sell_city = ? AND window_days = 7`,
    [id, q, buyCity, sellCity], (statsErr, stats) => {

    const confidence = stats ? stats.confidence_score : null;
    const consistencyPct = stats ? stats.consistency_pct : null;
    const sampleCount = stats ? stats.sample_count : 0;

    db.all(`SELECT channel_id, cooldown_ms, min_confidence FROM alerts WHERE min_profit <= ?`, [profit], async (err, rows) => {
      if (err || !rows || rows.length === 0) return;

      // Live price validation — confirm the spread still exists before pinging any channel
      const priceValid = await validatePricesLive(id, q, buyCity, sellCity, bestSell.price, bestBuy.price);
      if (!priceValid) {
        console.log(`[Alert] Live validation rejected ${id} q${q} route ${buyCity}→${sellCity}`);
        return;
      }

      rows.forEach(row => {
        const cacheKey = `${id}_${q}_${row.channel_id}`;
        const last = alertCooldowns[cacheKey] || 0;
        const cooldown = row.cooldown_ms || 600000;
        if (now - last < cooldown) return;

        // Minimum sample threshold — block alerts on near-zero-liquidity items even when min_confidence=0
        if (sampleCount < MIN_SAMPLE_THRESHOLD) {
          console.log(`[Alert] Skipping ${id} q${q}: only ${sampleCount} samples (min ${MIN_SAMPLE_THRESHOLD} required)`);
          return;
        }

        // Check confidence threshold
        const minConf = row.min_confidence || 0;
        if (minConf > 0 && (confidence === null || confidence < minConf)) return;

        alertCooldowns[cacheKey] = now; // Set cooldown only after all checks pass
        const channel = client.channels.cache.get(row.channel_id);
        if (!channel) return;

        const qualName = getQualityName(q);
        const friendlyName = getFriendlyName(id);
        const thumbnailUrl = `https://render.albiononline.com/v1/item/${id}.png?quality=${q}`;

        // Color: factor in confidence
        let embedColor;
        if (confidence !== null && confidence >= 70) {
          embedColor = profit > 500000 ? 0xff4500 : profit > 100000 ? 0xffd700 : 0x00ff00;
        } else if (confidence !== null && confidence >= 40) {
          embedColor = profit > 500000 ? 0xffa500 : 0xffff00; // orange/yellow for mid confidence
        } else {
          embedColor = 0x888888; // grey for low/unknown confidence
        }

        // Build fields
        const fields = [
          { name: 'Profit', value: `**${Math.floor(profit).toLocaleString()}** silver (${roi}% ROI)`, inline: false },
          { name: 'Buy From', value: `**${buyCity}**\\n${Math.floor(bestSell.price).toLocaleString()} silver\\n${freshLabel(buyAge)}`, inline: true },
          { name: 'Sell To', value: `**${sellCity}**\\n${Math.floor(bestBuy.price).toLocaleString()} silver\\n${freshLabel(sellAge)}`, inline: true },
          { name: 'Quality', value: qualName, inline: true }
        ];

        // Add reliability field if we have historical data
        if (confidence !== null) {
          const confLabel = confidence >= 70 ? 'High' : confidence >= 40 ? 'Medium' : 'Low';
          const confEmoji = confidence >= 70 ? '🟢' : confidence >= 40 ? '🟡' : '🔴';
          fields.push({
            name: 'Reliability',
            value: `${confEmoji} **${confidence}%** ${confLabel} — profitable ${consistencyPct}% of the time (${sampleCount} samples over 7d)`,
            inline: false
          });
        } else {
          fields.push({
            name: 'Reliability',
            value: '⚪ No historical data yet',
            inline: false
          });
        }

        channel.send({
          embeds: [{
            title: `${friendlyName}`,
            color: embedColor,
            thumbnail: { url: thumbnailUrl },
            fields,
            footer: { text: `Coldtouch Market Analyzer` },
            timestamp: new Date().toISOString(),
            url: SITE_URL
          }]
        }).catch(e => console.error('[Alert] Failed to send:', e.message));

        totalAlertsSent++;
        lastAlertTime = now;
      });
    });
  });
}

let dbBusy = false; // Prevents concurrent transaction collisions

// === HISTORICAL SNAPSHOT RECORDING ===
function recordSnapshots(allPrices) {
  if (dbBusy) { console.log('[Snapshots] DB busy, skipping'); return; }
  const now = Date.now();
  let count = 0;
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare(`INSERT INTO price_snapshots (item_id, quality, city, sell_price_min, buy_price_max, sell_date, buy_date, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const entry of allPrices) {
      if (!entry.item_id || !entry.city) continue;
      if (entry.sell_price_min <= 0 && entry.buy_price_max <= 0) continue;
      stmt.run(entry.item_id, entry.quality || 1, entry.city, entry.sell_price_min || 0, entry.buy_price_max || 0, entry.sell_price_min_date || '', entry.buy_price_max_date || '', now);
      count++;
    }
    stmt.finalize();
    db.run('COMMIT', () => {
      console.log(`[Snapshots] Recorded ${count} price snapshots`);
    });
  });
}

// === SPREAD STATISTICS COMPUTATION (runs hourly) ===
let statsRunning = false;
function computeSpreadStats() {
  if (dbBusy || statsRunning) { console.log('[SpreadStats] Busy, skipping this cycle'); return; }
  statsRunning = true;

  const now = Date.now();
  const windowMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const cutoff = now - windowMs;

  console.log('[SpreadStats] Starting computation...');

  // Get distinct item+quality combos from recent snapshots
  db.all(`SELECT DISTINCT item_id, quality FROM price_snapshots WHERE recorded_at > ?`, [cutoff], (err, items) => {
    if (err || !items || items.length === 0) {
      console.log('[SpreadStats] No data to process');
      statsRunning = false;
      return;
    }

    let processed = 0;
    const batchSize = 200;

    function processBatch(startIdx) {
      const batch = items.slice(startIdx, startIdx + batchSize);
      if (batch.length === 0) {
        console.log(`[SpreadStats] Done. Processed ${processed} item/quality combos`);
        statsRunning = false;
        return;
      }

      let pending = batch.length;
      for (const { item_id, quality } of batch) {
        // Get all snapshots for this item+quality grouped by recorded_at (scan cycle)
        db.all(
          `SELECT city, sell_price_min, buy_price_max, sell_date, buy_date, recorded_at FROM price_snapshots WHERE item_id = ? AND quality = ? AND recorded_at > ? ORDER BY recorded_at`,
          [item_id, quality, cutoff],
          (err2, rows) => {
            if (!err2 && rows && rows.length > 0) {
              // Group by scan cycle (recorded_at)
              const cycles = {};
              for (const r of rows) {
                if (!cycles[r.recorded_at]) cycles[r.recorded_at] = {};
                cycles[r.recorded_at][r.city] = { sell: r.sell_price_min, buy: r.buy_price_max, sellDate: r.sell_date, buyDate: r.buy_date };
              }

              // For each city pair, compute spreads across cycles
              const citySet = new Set();
              for (const c of Object.values(cycles)) {
                for (const city of Object.keys(c)) citySet.add(city);
              }
              const cities = Array.from(citySet);

              for (let i = 0; i < cities.length; i++) {
                for (let j = 0; j < cities.length; j++) {
                  if (i === j) continue;
                  const buyCity = cities[i];
                  const sellCity = cities[j];
                  if (buyCity === 'Black Market') continue;

                  const spreads = [];
                  for (const cycle of Object.values(cycles)) {
                    const buyData = cycle[buyCity];
                    const sellData = cycle[sellCity];
                    if (!buyData || !sellData) continue;
                    if (buyData.sell <= 0 || sellData.buy <= 0) continue;
                    const spread = sellData.buy - buyData.sell - (sellData.buy * TAX_RATE);
                    spreads.push(spread);
                  }

                  if (spreads.length < 3) continue;

                  const positive = spreads.filter(s => s > 0);
                  const consistencyPct = (positive.length / spreads.length) * 100;
                  const avg = spreads.reduce((a, b) => a + b, 0) / spreads.length;
                  const sorted = [...positive].sort((a, b) => a - b);
                  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;

                  const sampleScore = Math.min(spreads.length, 100) / 100 * 30;
                  const consistScore = consistencyPct * 0.5;
                  const spreadScore = Math.min(Math.max(avg, 0), 500000) / 500000 * 20;
                  const confidence = Math.round(Math.min(100, sampleScore + consistScore + spreadScore));

                  db.run(`INSERT OR REPLACE INTO spread_stats (item_id, quality, buy_city, sell_city, avg_spread, median_spread, consistency_pct, sample_count, window_days, confidence_score, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [item_id, quality, buyCity, sellCity, Math.round(avg), Math.round(median), Math.round(consistencyPct * 10) / 10, spreads.length, 7, confidence, now],
                    () => {} // swallow errors silently
                  );
                }
              }
            }

            processed++;
            pending--;
            if (pending === 0) {
              // Process next batch with a yield
              setTimeout(() => processBatch(startIdx + batchSize), 50);
            }
          }
        );
      }
    }

    processBatch(0);
  });
}

// Run stats computation hourly, first run 5 minutes after start (after backfill)
setTimeout(computeSpreadStats, 5 * 60 * 1000);
setInterval(computeSpreadStats, 60 * 60 * 1000);

// === DATA COMPACTION (runs every 6 hours) ===
function compactOldData() {
  const now = Date.now();
  const sixHoursAgo = now - 6 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  console.log('[Compaction] Starting...');

  // Compact >6h old raw snapshots into hourly averages
  db.all(
    `SELECT item_id, quality, city,
      CAST(recorded_at / 3600000 AS INTEGER) * 3600000 as hour_start,
      AVG(sell_price_min) as avg_sell,
      AVG(buy_price_max) as avg_buy,
      COUNT(*) as cnt
    FROM price_snapshots
    WHERE recorded_at < ?
    GROUP BY item_id, quality, city, hour_start`,
    [sixHoursAgo],
    (err, rows) => {
      if (err || !rows || rows.length === 0) {
        console.log('[Compaction] No raw snapshots older than 6h to compact');
        return;
      }

      const stmt = db.prepare(`INSERT OR REPLACE INTO price_averages (item_id, quality, city, avg_sell, avg_buy, sample_count, period_type, period_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      db.run('BEGIN TRANSACTION');
      for (const r of rows) {
        stmt.run(r.item_id, r.quality, r.city, Math.round(r.avg_sell), Math.round(r.avg_buy), r.cnt, 'hourly', r.hour_start);
      }
      db.run('COMMIT', () => {
        stmt.finalize();
        // Delete all compacted raw snapshots (older than 6h)
        db.run(`DELETE FROM price_snapshots WHERE recorded_at < ?`, [sixHoursAgo], (err2) => {
          if (!err2) console.log(`[Compaction] Compacted ${rows.length} hourly averages, deleted raw snapshots older than 6h`);
        });
      });
    }
  );

  // Compact >30 day old hourly averages into daily
  db.all(
    `SELECT item_id, quality, city,
      CAST(period_start / 86400000 AS INTEGER) * 86400000 as day_start,
      AVG(avg_sell) as avg_sell,
      AVG(avg_buy) as avg_buy,
      SUM(sample_count) as cnt
    FROM price_averages
    WHERE period_type = 'hourly' AND period_start < ?
    GROUP BY item_id, quality, city, day_start`,
    [thirtyDaysAgo],
    (err, rows) => {
      if (err || !rows || rows.length === 0) return;

      const stmt = db.prepare(`INSERT OR REPLACE INTO price_averages (item_id, quality, city, avg_sell, avg_buy, sample_count, period_type, period_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      db.run('BEGIN TRANSACTION');
      for (const r of rows) {
        stmt.run(r.item_id, r.quality, r.city, Math.round(r.avg_sell), Math.round(r.avg_buy), r.cnt, 'daily', r.day_start);
      }
      db.run('COMMIT', () => {
        stmt.finalize();
        db.run(`DELETE FROM price_averages WHERE period_type = 'hourly' AND period_start < ?`, [thirtyDaysAgo], (err2) => {
          if (!err2) console.log(`[Compaction] Compacted ${rows.length} daily averages, deleted old hourly data`);
        });
      });
    }
  );

  // Safety net: delete any raw snapshots older than 24h (should already be compacted at 6h)
  db.run(`DELETE FROM price_snapshots WHERE recorded_at < ?`, [now - 24 * 60 * 60 * 1000]);

  // Clean up old contributions (keep 60 days)
  const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
  db.run(`DELETE FROM contributions WHERE created_at < ?`, [sixtyDaysAgo]);
}

// Run compaction every hour, first run 5 minutes after start
setTimeout(compactOldData, 5 * 60 * 1000);
setInterval(compactOldData, 60 * 60 * 1000);

// === HISTORICAL BACKFILL (Charts + History APIs) ===
// Runs once on start if no historical data exists
async function backfillHistoricalData() {
  // Check if we already have historical data
  const hasData = await new Promise((resolve) => {
    db.get(`SELECT COUNT(*) as cnt FROM price_averages`, (err, row) => {
      resolve(row && row.cnt > 0);
    });
  });
  if (hasData) {
    console.log('[Backfill] Historical data already exists, skipping backfill');
    return;
  }

  // Wait for items to be loaded from the first scan
  let retries = 0;
  while (Object.keys(itemNames).length === 0 && retries < 30) {
    await new Promise(r => setTimeout(r, 5000));
    retries++;
  }
  const itemIds = Object.keys(itemNames).filter(k => k && itemNames[k]);
  if (itemIds.length === 0) {
    console.log('[Backfill] No items loaded, skipping');
    return;
  }

  dbBusy = true;
  console.log(`[Backfill] Starting historical backfill for ${itemIds.length} items...`);

  // Helper: promisified batch insert
  function batchInsert(rows, periodType) {
    return new Promise((resolve, reject) => {
      if (rows.length === 0) return resolve(0);
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) return resolve(0);
        const stmt = db.prepare(`INSERT OR IGNORE INTO price_averages (item_id, quality, city, avg_sell, avg_buy, sample_count, period_type, period_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const r of rows) {
          stmt.run(r.item_id, r.quality, r.city, r.avg_sell, 0, r.count, periodType, r.period_start);
        }
        stmt.finalize(() => {
          db.run('COMMIT', (err2) => {
            resolve(rows.length);
          });
        });
      });
    });
  }

  // Phase A: Charts API (daily averages, time-scale=24, ~28 days back)
  let dailyCount = 0;
  for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
    const chunk = itemIds.slice(i, i + CHUNK_SIZE);
    try {
      const url = `${CHARTS_BASE}/${chunk.join(',')}.json?time-scale=24`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      const rows = [];
      for (const entry of data) {
        if (!entry.data || !entry.data.timestamps) continue;
        const ts = entry.data.timestamps;
        const avgPrices = entry.data.prices_avg || [];
        const counts = entry.data.item_count || [];
        for (let t = 0; t < ts.length; t++) {
          if (!avgPrices[t] || avgPrices[t] <= 0) continue;
          const periodStart = new Date(ts[t]).getTime();
          if (isNaN(periodStart)) continue;
          rows.push({ item_id: entry.item_id, quality: entry.quality || 1, city: entry.location || '', avg_sell: Math.round(avgPrices[t]), count: counts[t] || 1, period_start: periodStart });
        }
      }
      dailyCount += await batchInsert(rows, 'daily');
    } catch (e) {
      console.error(`[Backfill] Charts chunk ${i} failed:`, e.message);
    }
    if (i + CHUNK_SIZE < itemIds.length) await new Promise(r => setTimeout(r, 150));
    if (i % 1000 === 0 && i > 0) console.log(`[Backfill] Charts progress: ${i}/${itemIds.length} items`);
  }
  console.log(`[Backfill] Charts API: inserted ${dailyCount} daily averages`);

  // Phase B: History API (6-hour granularity, more recent data)
  let hourlyCount = 0;
  for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
    const chunk = itemIds.slice(i, i + CHUNK_SIZE);
    try {
      const url = `${HISTORY_BASE}/${chunk.join(',')}.json?time-scale=6`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      const rows = [];
      for (const entry of data) {
        if (!entry.data || !entry.data.timestamps) continue;
        const ts = entry.data.timestamps;
        const avgPrices = entry.data.prices_avg || [];
        const counts = entry.data.item_count || [];
        for (let t = 0; t < ts.length; t++) {
          if (!avgPrices[t] || avgPrices[t] <= 0) continue;
          const periodStart = new Date(ts[t]).getTime();
          if (isNaN(periodStart)) continue;
          rows.push({ item_id: entry.item_id, quality: entry.quality || 1, city: entry.location || '', avg_sell: Math.round(avgPrices[t]), count: counts[t] || 1, period_start: periodStart });
        }
      }
      hourlyCount += await batchInsert(rows, 'hourly');
    } catch (e) {
      console.error(`[Backfill] History chunk ${i} failed:`, e.message);
    }
    if (i + CHUNK_SIZE < itemIds.length) await new Promise(r => setTimeout(r, 150));
    if (i % 1000 === 0 && i > 0) console.log(`[Backfill] History progress: ${i}/${itemIds.length} items`);
  }
  console.log(`[Backfill] History API: inserted ${hourlyCount} hourly averages`);
  dbBusy = false;
  console.log(`[Backfill] Complete! Total: ${dailyCount} daily + ${hourlyCount} hourly records`);

  // Trigger a spread stats computation right after backfill
  setTimeout(computeSpreadStats, 5000);
}

// Start backfill 90 seconds after boot (after first scan completes)
setTimeout(backfillHistoricalData, 90 * 1000);

// === NATS SNAPSHOT BUFFER ===
// Buffer incoming NATS orders — deduplicated by item/quality/city, flushed every 60s
// Only stores the BEST price per item/quality/city combo (lowest sell, highest buy)
const natsSnapshotMap = {};  // key: "itemId_quality_city" → { sell, buy }
const NATS_FLUSH_INTERVAL = 60 * 1000;

function flushNatsBuffer() {
  const keys = Object.keys(natsSnapshotMap);
  if (keys.length === 0 || dbBusy || statsRunning) return;

  // Snapshot and clear the map
  const batch = [];
  for (const key of keys) {
    batch.push(natsSnapshotMap[key]);
    delete natsSnapshotMap[key];
  }
  const now = Date.now();

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare('INSERT INTO price_snapshots (item_id, quality, city, sell_price_min, buy_price_max, sell_date, buy_date, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const e of batch) {
      stmt.run(e.item_id, e.quality, e.city, e.sell || 0, e.buy || 0, '', '', now);
    }
    stmt.finalize();
    db.run('COMMIT', () => {
      if (batch.length > 50) console.log('[NATS-Snap] Flushed ' + batch.length + ' deduped snapshots (was ' + keys.length + ' raw)');
    });
  });
}

setInterval(flushNatsBuffer, NATS_FLUSH_INTERVAL);

let natsConnection = null;

(async () => {
  try {
    natsConnection = await connect({
      servers: "nats.albion-online-data.com:4222",
      user: "public",
      pass: "thenewalbiondata"
    });
    console.log('[NATS] Connected');
    const sc = StringCodec();
    const sub = natsConnection.subscribe("marketorders.deduped.*");

    for await (const m of sub) {
      const strData = sc.decode(m.data);
      for(let wc of wsClients) if(wc.readyState === WebSocket.OPEN) wc.send(strData);

      try {
        const payloads = JSON.parse(strData);
        for (const p of payloads) {
          if (!p.ItemTypeId || !p.LocationId || !p.UnitPriceSilver) continue;
          const id = p.ItemTypeId, q = p.QualityLevel || 1, loc = p.LocationId, price = p.UnitPriceSilver;
          const city = API_LOCALE_MAP[loc];
          if (!city) continue;

          if (!alertMarketDb[id]) alertMarketDb[id] = {};
          if (!alertMarketDb[id][q]) alertMarketDb[id][q] = {};
          if (!alertMarketDb[id][q][city]) alertMarketDb[id][q][city] = { sellMin: Infinity, buyMax: 0, sellDate: 0, buyDate: 0 };

          const now = Date.now();
          alertMarketDb[id][q][city].lastSeen = now;

          if (p.AuctionType === 'offer' && price < alertMarketDb[id][q][city].sellMin) {
            alertMarketDb[id][q][city].sellMin = price;
            alertMarketDb[id][q][city].sellDate = now;
          } else if (p.AuctionType === 'request' && price > alertMarketDb[id][q][city].buyMax) {
            alertMarketDb[id][q][city].buyMax = price;
            alertMarketDb[id][q][city].buyDate = now;
          }

          // Buffer for snapshot recording — deduplicated per item/quality/city
          const snapKey = id + '_' + q + '_' + city;
          if (!natsSnapshotMap[snapKey]) natsSnapshotMap[snapKey] = { item_id: id, quality: q, city: city, sell: 0, buy: 0 };
          if (p.AuctionType === 'offer' && (natsSnapshotMap[snapKey].sell === 0 || price < natsSnapshotMap[snapKey].sell)) {
            natsSnapshotMap[snapKey].sell = price;
          } else if (p.AuctionType === 'request' && price > natsSnapshotMap[snapKey].buy) {
            natsSnapshotMap[snapKey].buy = price;
          }

          // Check for alerts on this item
          checkAndAlert(id, q);
        }
      } catch(e) { console.error('[NATS] Parse error:', e.message); }
    }
  } catch(err){ console.error('[NATS] Connection failed:', err); }
})();

// === GRACEFUL SHUTDOWN ===
function shutdown(signal) {
  console.log(`[Shutdown] Received ${signal}, closing...`);
  flushNatsBuffer(); // Save any buffered NATS data before exit
  if (natsConnection) natsConnection.close();
  wss.close();
  client.destroy();
  db.close();
  server.close(() => {
    console.log('[Shutdown] Clean exit');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(443, () => console.log('SaaS Backend (Express + Discord + WSS + Market Cache) listening on 443!'));
"""
    b64_server = base64.b64encode(backend_js.encode()).decode()
    run_wait(f"echo '{b64_server}' | base64 -d > /opt/albion-saas/backend.js")

    # Write env file with restricted permissions
    game_server = os.environ.get('GAME_SERVER', 'europe')
    env_content = f"""DOMAIN={domain}
DISCORD_CLIENT_ID={CLIENT_ID}
DISCORD_CLIENT_SECRET={CLIENT_SECRET}
DISCORD_BOT_TOKEN={BOT_TOKEN}
SESSION_SECRET={session_secret}
GAME_SERVER={game_server}
"""
    b64_env = base64.b64encode(env_content.encode()).decode()
    run_wait(f"echo '{b64_env}' | base64 -d > /opt/albion-saas/.env")
    run_wait("chmod 600 /opt/albion-saas/.env")

    svc = """
[Unit]
Description=Albion SaaS Backend
After=network.target

[Service]
EnvironmentFile=/opt/albion-saas/.env
ExecStart=/usr/bin/node --max-old-space-size=400 /opt/albion-saas/backend.js
WorkingDirectory=/opt/albion-saas
Restart=always
User=root

[Install]
WantedBy=multi-user.target
"""
    b64_svc = base64.b64encode(svc.encode()).decode()
    run_wait(f"echo '{b64_svc}' | base64 -d > /etc/systemd/system/albion-saas.service")

    run_wait("systemctl daemon-reload")
    run_wait("systemctl enable albion-saas")
    run_wait("systemctl restart albion-saas")
    
    status = run_wait("systemctl is-active albion-saas")
    print(f"Service status: {status.strip()}")
    ssh.close()
    print("SaaS Deployed successfully!")

if __name__ == '__main__':
    main()
