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
domain = os.environ.get('VPS_DOMAIN', 'albionaitool.xyz')

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
    "express-rate-limit": "^7.1.5",
    "sqlite3": "^5.1.7",
    "nats": "^2.19.0",
    "ws": "^8.16.0",
    "cors": "^2.8.5",
    "jsonwebtoken": "^9.0.2",
    "helmet": "^7.1.0",
    "bcryptjs": "^2.4.3",
    "nodemailer": "^6.9.8"
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
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { connect, StringCodec } = require('nats');
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const domain = process.env.DOMAIN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_FEEDBACK_WEBHOOK = process.env.DISCORD_FEEDBACK_WEBHOOK || '';
const SESSION_SECRET = process.env.SESSION_SECRET;

const GAME_SERVER = process.env.GAME_SERVER || 'europe';
const API_BASE = `https://${GAME_SERVER}.albion-online-data.com/api/v2/stats/prices`;
const CHARTS_BASE = `https://${GAME_SERVER}.albion-online-data.com/api/v2/stats/charts`;
const HISTORY_BASE = `https://${GAME_SERVER}.albion-online-data.com/api/v2/stats/history`;
const ITEMS_URL = 'https://coldtouch.github.io/coldtouch-market-analyzer/items.json';
const CHUNK_SIZE = 50;  // Larger chunks OK with 6 vCPU / 12GB RAM
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const SITE_URL = 'https://coldtouch.github.io/coldtouch-market-analyzer';

// === SMTP EMAIL CONFIG ===
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_RAW = process.env.SMTP_FROM || 'noreply@albionaitool.xyz';
const SMTP_FROM = SMTP_FROM_RAW.includes('<') ? SMTP_FROM_RAW : '"Coldtouch Market Analyzer" <' + SMTP_FROM_RAW + '>';

let mailTransporter = null;
if (SMTP_HOST && SMTP_USER) {
  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  mailTransporter.verify().then(() => console.log('[SMTP] Mail transporter ready')).catch(e => {
    console.error('[SMTP] Mail transporter failed:', e.message);
    mailTransporter = null;
  });
} else {
  console.log('[SMTP] No SMTP config — email verification disabled, accounts auto-verified');
}

// Item name cache (loaded from items.json)
let itemNames = {};

// === DATABASE ===
const db = new sqlite3.Database('/opt/albion-saas/database.sqlite');

// Performance PRAGMAs — WAL mode dramatically reduces read/write contention
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = -128000');  // 128MB page cache
db.run('PRAGMA busy_timeout = 5000');
db.run('PRAGMA wal_autocheckpoint = 1000');

// Separate connection for SpreadStats + Analytics bulk reads/writes.
// SpreadStats does a 90-second db.all() on 3M+ rows then writes 526k rows.
// Using a separate connection prevents this from blocking the main db queue,
// which would cause /api/me (5s timeout) to fail and break Discord login.
const statsDb = new sqlite3.Database('/opt/albion-saas/database.sqlite');
statsDb.run('PRAGMA journal_mode = WAL');
statsDb.run('PRAGMA synchronous = NORMAL');
statsDb.run('PRAGMA cache_size = -32000');  // 32MB page cache
statsDb.run('PRAGMA busy_timeout = 30000'); // longer timeout — bulk writes can wait

// Dedicated read-only connection for user-facing endpoints (/api/me, etc.).
// WAL mode allows concurrent readers, but node-sqlite3 serialises ALL ops
// on a single connection object — so even a fast SELECT queues behind slow
// writes on the main db connection (e.g. market scan batch-inserts).
// A separate connection bypasses that queue entirely.
const readDb = new sqlite3.Database('/opt/albion-saas/database.sqlite', sqlite3.OPEN_READONLY);
readDb.run('PRAGMA journal_mode = WAL');
readDb.run('PRAGMA busy_timeout = 5000');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, avatar TEXT)`);
  // Migrate users table: add columns for email/password registration
  db.run(`ALTER TABLE users ADD COLUMN email TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN password_hash TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN auth_type TEXT DEFAULT 'discord'`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'free'`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN created_at INTEGER`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN last_login INTEGER`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN linked_discord_id TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN verification_token TEXT`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN verification_expires INTEGER`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN capture_token TEXT`, () => {});
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`);

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
  db.run(`CREATE INDEX IF NOT EXISTS idx_ss_item_quality ON spread_stats(item_id, quality)`);

  db.run(`CREATE TABLE IF NOT EXISTS price_averages (
    item_id TEXT NOT NULL,
    quality INTEGER DEFAULT 1,
    city TEXT NOT NULL,
    avg_sell INTEGER DEFAULT 0,
    avg_buy INTEGER DEFAULT 0,
    min_sell INTEGER DEFAULT 0,
    max_buy INTEGER DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    period_type TEXT NOT NULL,
    period_start INTEGER NOT NULL,
    PRIMARY KEY(item_id, quality, city, period_type, period_start)
  )`);
  // Migrate: add min_sell/max_buy columns if missing
  db.run(`ALTER TABLE price_averages ADD COLUMN min_sell INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE price_averages ADD COLUMN max_buy INTEGER DEFAULT 0`, () => {});
  db.run(`CREATE INDEX IF NOT EXISTS idx_pa_item_city_ts ON price_averages(item_id, city, period_start)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pa_spread_query ON price_averages(period_start, avg_sell, avg_buy)`);

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

  // === PHASE 3: Loot Lifecycle Tracker ===
  db.run(`CREATE TABLE IF NOT EXISTS loot_tabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    tab_name TEXT NOT NULL,
    city TEXT DEFAULT '',
    purchase_price INTEGER DEFAULT 0,
    items_json TEXT NOT NULL,
    purchased_at INTEGER NOT NULL,
    status TEXT DEFAULT 'open'
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_loot_tabs_user ON loot_tabs(user_id, purchased_at)`);

  db.run(`CREATE TABLE IF NOT EXISTS loot_tab_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loot_tab_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    quality INTEGER DEFAULT 1,
    quantity INTEGER DEFAULT 1,
    sale_price INTEGER NOT NULL,
    sold_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_loot_tab_sales_tab ON loot_tab_sales(loot_tab_id)`);

  // === SALE NOTIFICATIONS (from in-game mail) ===
  db.run(`CREATE TABLE IF NOT EXISTS sale_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mail_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    unit_price INTEGER NOT NULL,
    total INTEGER NOT NULL,
    location TEXT DEFAULT '',
    order_type TEXT DEFAULT 'FINISHED',
    sold_at INTEGER NOT NULL,
    matched_tab_id INTEGER DEFAULT NULL
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_notif_mail ON sale_notifications(user_id, mail_id)`);

  // === LOOT LOGGER ===
  db.run(`CREATE TABLE IF NOT EXISTS loot_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    looted_by_name TEXT NOT NULL,
    looted_by_guild TEXT DEFAULT '',
    looted_by_alliance TEXT DEFAULT '',
    looted_from_name TEXT DEFAULT '',
    looted_from_guild TEXT DEFAULT '',
    looted_from_alliance TEXT DEFAULT '',
    item_id TEXT NOT NULL,
    numeric_id INTEGER DEFAULT 0,
    quantity INTEGER DEFAULT 1,
    weight REAL DEFAULT 0,
    is_silver INTEGER DEFAULT 0
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_loot_events_user_session ON loot_events(user_id, session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_loot_events_session ON loot_events(session_id, timestamp)`);

  // === ANALYTICS TABLES ===
  db.run(`CREATE TABLE IF NOT EXISTS price_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    city TEXT NOT NULL,
    quality INTEGER DEFAULT 1,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    computed_at TEXT NOT NULL,
    UNIQUE(item_id, city, quality, metric)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_analytics_item ON price_analytics(item_id, city, quality)`);

  db.run(`CREATE TABLE IF NOT EXISTS price_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    city TEXT NOT NULL,
    quality INTEGER DEFAULT 1,
    hour TEXT NOT NULL,
    open_price REAL,
    high_price REAL,
    low_price REAL,
    close_price REAL,
    avg_price REAL,
    volume INTEGER DEFAULT 0,
    UNIQUE(item_id, city, quality, hour)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_hourly_item ON price_hourly(item_id, city, quality, hour)`);

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
let scanStartTime = 0;
let lastSnapshotTime = 0;
const SNAPSHOT_INTERVAL = 15 * 60 * 1000; // Record snapshots every 15 min, not every scan
const SCAN_TIMEOUT_MS = 4 * 60 * 1000;    // Auto-reset stuck scans after 4 minutes

async function doServerScan() {
  // Watchdog: if a scan has been "in progress" for > 4 minutes, force-reset it
  if (scanInProgress) {
    const elapsed = Date.now() - scanStartTime;
    if (elapsed > SCAN_TIMEOUT_MS) {
      console.error(`[Cache] Scan stuck for ${Math.round(elapsed/1000)}s — force-resetting scanInProgress flag`);
      scanInProgress = false;
    } else {
      console.log('[Cache] Scan already in progress, skipping.');
      return;
    }
  }
  scanInProgress = true;
  scanStartTime = Date.now();
  console.log('[Cache] Starting full market scan...');

  try {
    const itemsRes = await fetch(ITEMS_URL, { signal: AbortSignal.timeout(15000) });
    if (!itemsRes.ok) throw new Error('Failed to fetch items.json: HTTP ' + itemsRes.status);
    itemNames = await itemsRes.json();
    const itemIds = Object.keys(itemNames).filter(k => k && itemNames[k]);
    console.log(`[Cache] Loaded ${itemIds.length} item IDs.`);

    const priceMap = new Map();

    for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
      const chunk = itemIds.slice(i, i + CHUNK_SIZE);
      try {
        const url = `${API_BASE}/${chunk.join(',')}.json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
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

      // Yield between chunks so the event loop can serve HTTP requests
      if (i + CHUNK_SIZE < itemIds.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const allPrices = Array.from(priceMap.values());
    priceMap.clear();

    cacheTimestamp = new Date().toISOString();
    cacheItemCount = allPrices.length;

    // Stagger post-scan work to keep event loop responsive
    // 1) Compress cache immediately (needed for serving)
    const json = JSON.stringify({ timestamp: cacheTimestamp, count: cacheItemCount, data: allPrices });
    zlib.gzip(json, (err, buffer) => {
        if (!err) {
            cachedGzipBuffer = buffer;
            const mem = process.memoryUsage();
            console.log(`[Cache] Scan complete: ${cacheItemCount} entries. Compressed: ${Math.round(buffer.length/1024)}KB. RSS: ${Math.round(mem.rss/1024/1024)}MB Heap: ${Math.round(mem.heapUsed/1024/1024)}MB`);
        }
        scanInProgress = false;
    });

    // 2) Seed alerter after a short delay
    setTimeout(() => seedAlerterFromScan(allPrices), 2000);

    // 3) Record snapshots after alerter has had time to finish
    const now = Date.now();
    if (now - lastSnapshotTime >= SNAPSHOT_INTERVAL) {
      setTimeout(() => { recordSnapshots(allPrices); lastSnapshotTime = now; }, 8000);
    }
  } catch (err) {
    console.error('[Cache] Scan failed:', err.message);
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

  // Helper: safe reply that catches expired interaction errors
  const safeReply = async (opts) => { try { await interaction.reply(opts); } catch(e) { if (e.code !== 10062) console.error('[Bot] Reply error:', e.message); } };
  const safeEditReply = async (opts) => { try { await interaction.editReply(opts); } catch(e) { console.error('[Bot] EditReply error:', e.message); } };

  if (interaction.commandName === 'setup_alerts') {
    await interaction.deferReply({ ephemeral: false });
    const discordUserId = interaction.user.id;
    // Gate: check if this Discord user has a registered website account (or linked Discord)
    db.get(`SELECT id FROM users WHERE id = ? OR linked_discord_id = ?`, [discordUserId, discordUserId], (err, userRow) => {
      if (!userRow) {
        return safeEditReply({ embeds: [{
          title: 'Registration Required',
          color: 0xffa500,
          description: 'You need a registered account on the website to use alerts.\\n\\n**How to set up:**\\n1. Visit [albionaitool.xyz](https://coldtouch.github.io/coldtouch-market-analyzer/) and create an account\\n2. Either login with Discord or create an email account and link your Discord\\n3. Come back here and run `/setup_alerts` again',
          footer: { text: 'Coldtouch Market Analyzer • Free registration required' }
        }] });
      }

      const minP = interaction.options.getInteger('min_profit');
      const cooldown = interaction.options.getInteger('cooldown') || 10;
      const cooldownMs = Math.max(1, Math.min(120, cooldown)) * 60 * 1000;
      const minConf = Math.max(0, Math.min(100, interaction.options.getInteger('min_confidence') || 0));
      db.run(`INSERT OR REPLACE INTO alerts (guild_id, channel_id, min_profit, cooldown_ms, min_confidence) VALUES (?, ?, ?, ?, ?)`,
        [interaction.guildId, interaction.channelId, minP, cooldownMs, minConf], (err2) => {
        if(err2) return safeEditReply({content: 'DB Error :('});
        const fields = [
          { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
          { name: 'Min Profit', value: `${minP.toLocaleString()} silver`, inline: true },
          { name: 'Cooldown', value: `${cooldown} min per item`, inline: true }
        ];
        if (minConf > 0) fields.push({ name: 'Min Confidence', value: `${minConf}%+`, inline: true });
        safeEditReply({ embeds: [{
          title: 'Alerts Configured',
          color: 0x00ff00,
          fields,
          footer: { text: 'Coldtouch Market Analyzer • Use /set_confidence to change threshold later' }
        }]});
      });
    });
  }

  if (interaction.commandName === 'stop_alerts') {
    await interaction.deferReply();
    db.run(`DELETE FROM alerts WHERE guild_id = ? AND channel_id = ?`, [interaction.guildId, interaction.channelId], (err) => {
      safeEditReply({ embeds: [{
        title: 'Alerts Stopped',
        color: 0xff4444,
        description: `Alerts have been removed from <#${interaction.channelId}>.`,
        footer: { text: 'Coldtouch Market Analyzer' }
      }]});
    });
  }

  if (interaction.commandName === 'my_alerts') {
    await interaction.deferReply({ ephemeral: true });
    db.all(`SELECT channel_id, min_profit, cooldown_ms, min_confidence FROM alerts WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
      if (err || !rows || rows.length === 0) {
        return safeEditReply({ embeds: [{
          title: 'No Active Alerts',
          color: 0x888888,
          description: 'Use `/setup_alerts` to configure alerts in a channel.',
          footer: { text: 'Coldtouch Market Analyzer' }
        }] });
      }
      const lines = rows.map(r => {
        const conf = r.min_confidence || 0;
        const confLabel = conf > 0 ? `, confidence **${conf}%+**` : '';
        return `<#${r.channel_id}> — min **${r.min_profit.toLocaleString()}** silver, cooldown **${Math.round((r.cooldown_ms || 600000) / 60000)}** min${confLabel}`;
      });
      safeEditReply({ embeds: [{
        title: `Active Alerts (${rows.length})`,
        color: 0xffd700,
        description: lines.join('\\n'),
        footer: { text: 'Coldtouch Market Analyzer • Use /set_confidence to filter by reliability' }
      }] });
    });
  }

  if (interaction.commandName === 'set_confidence') {
    await interaction.deferReply();
    const minConf = Math.max(0, Math.min(100, interaction.options.getInteger('min_confidence')));
    db.run(`UPDATE alerts SET min_confidence = ? WHERE guild_id = ? AND channel_id = ?`,
      [minConf, interaction.guildId, interaction.channelId], (err) => {
      if (err) {
        return safeEditReply({ content: 'No alert configured in this channel. Use `/setup_alerts` first.' });
      }
      const label = minConf === 0 ? 'Any (all alerts)' : minConf >= 70 ? `${minConf}% (High confidence only)` : minConf >= 40 ? `${minConf}% (Medium+ confidence)` : `${minConf}%`;
      safeEditReply({ embeds: [{
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
    await interaction.deferReply();
    let trackedItems = 0, trackedCities = 0;
    for (const id of Object.keys(alertMarketDb)) {
      for (const q of Object.keys(alertMarketDb[id])) {
        trackedCities += Object.keys(alertMarketDb[id][q]).length;
      }
      trackedItems++;
    }
    db.all(`SELECT COUNT(*) as cnt FROM alerts`, [], (err, rows) => {
      const alertCount = (rows && rows[0]) ? rows[0].cnt : 0;
      safeEditReply({ embeds: [{
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
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
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
        const sd2 = entry.sell_price_min_date && !entry.sell_price_min_date.startsWith('0001') ? new Date(entry.sell_price_min_date).getTime() : now2;
        const bd2 = entry.buy_price_max_date && !entry.buy_price_max_date.startsWith('0001') ? new Date(entry.buy_price_max_date).getTime() : now2;
        if (entry.sell_price_min > 0) { alertMarketDb[id2][q2][city2].sellMin = entry.sell_price_min; alertMarketDb[id2][q2][city2].sellDate = sd2; }
        if (entry.buy_price_max > 0) { alertMarketDb[id2][q2][city2].buyMax = entry.buy_price_max; alertMarketDb[id2][q2][city2].buyDate = bd2; }
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
    await interaction.deferReply();
    db.all(`SELECT user_id, username, avatar, scans_30d, tier FROM user_stats WHERE scans_30d > 0 ORDER BY scans_30d DESC LIMIT 10`, [], (err, rows) => {
      if (err || !rows || rows.length === 0) {
        return safeEditReply({ embeds: [{
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
      safeEditReply({ embeds: [{
        title: '🏆 Top Scanners (30 days)',
        color: 0xffd700,
        description: lines.join('\\n'),
        footer: { text: 'Scan items with /scan or refresh on the website to climb!' }
      }]});
    });
  }

  if (interaction.commandName === 'mystats') {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.user.id;
    db.get(`SELECT scans_30d, scans_total, tier FROM user_stats WHERE user_id = ?`, [userId], (err, row) => {
      if (err || !row) {
        return safeEditReply({ embeds: [{
          title: 'Your Stats',
          color: 0x888888,
          description: 'No scanning activity yet. Use `/scan` or refresh items on the website to get started!',
          footer: { text: 'Coldtouch Market Analyzer' }
        }] });
      }
      const tierEmoji = { diamond: '💎', gold: '🥇', silver: '🥈', bronze: '🥉' };
      const nextTier = { bronze: { name: 'Silver', need: 50 }, silver: { name: 'Gold', need: 200 }, gold: { name: 'Diamond', need: 500 }, diamond: null };
      const next = nextTier[row.tier];
      const progressLine = next ? `**${row.scans_30d}/${next.need}** scans to reach ${next.name}` : 'Maximum tier reached!';

      // Get rank
      db.get(`SELECT COUNT(*) + 1 as rank FROM user_stats WHERE scans_30d > ?`, [row.scans_30d], (err2, rankRow) => {
        const rank = rankRow ? rankRow.rank : '?';
        safeEditReply({ embeds: [{
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
        }] });
      });
    });
  }
});

client.login(BOT_TOKEN).catch(e => console.error('[Discord] Login failed (rate limited):', e.message));

// === EXPRESS APP ===
const app = express();
app.use(cors({ origin: 'https://coldtouch.github.io', credentials: true }));
// Security headers: HSTS, X-Content-Type-Options, X-Frame-Options, etc.
// contentSecurityPolicy disabled — this is a JSON API, not an HTML server.
app.use(helmet({ contentSecurityPolicy: false }));

// JSON body parsing — must be before any route that reads req.body
app.use(express.json());

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);


// Manual Discord OAuth2 flow (replaces passport-discord which has no HTTP timeouts)
const DISCORD_AUTH_URL = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(`https://${domain}/auth/discord/callback`)}&response_type=code&scope=identify`;
const SITE = 'https://coldtouch.github.io/coldtouch-market-analyzer';

app.get('/auth/discord', (req, res) => res.redirect(DISCORD_AUTH_URL));

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect(`${SITE}?login=failed`);

  try {
    // Exchange code for access token (30s timeout)
    const tokenController = new AbortController();
    const tokenTimer = setTimeout(() => tokenController.abort(), 30000);
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `https://${domain}/auth/discord/callback`
      }),
      signal: tokenController.signal
    });
    clearTimeout(tokenTimer);
    if (!tokenRes.ok) { console.error('[OAuth] Token exchange failed:', tokenRes.status); return res.redirect(`${SITE}?login=failed`); }
    const tokenData = await tokenRes.json();

    // Fetch user profile (30s timeout)
    const profileController = new AbortController();
    const profileTimer = setTimeout(() => profileController.abort(), 30000);
    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: profileController.signal
    });
    clearTimeout(profileTimer);
    if (!profileRes.ok) { console.error('[OAuth] Profile fetch failed:', profileRes.status); return res.redirect(`${SITE}?login=failed`); }
    const profile = await profileRes.json();

    const now = Date.now();

    // Check if this is a Discord-linking flow (email user linking their Discord)
    const stateParam = req.query.state;
    if (stateParam) {
      try {
        const state = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
        if (state.link && state.userId) {
          // Link Discord to existing email account
          db.run(`UPDATE users SET linked_discord_id = ?, avatar = ? WHERE id = ?`,
            [profile.id, profile.avatar, state.userId]);
          // Also create/update the Discord user row so contributions from Discord bot still work
          db.run(`INSERT INTO users (id, username, avatar, auth_type, created_at, last_login) VALUES (?, ?, ?, 'discord', ?, ?)
            ON CONFLICT(id) DO UPDATE SET username=excluded.username, avatar=excluded.avatar, last_login=?`,
            [profile.id, profile.username, profile.avatar, now, now, now]);
          console.log(`[Link] User ${state.userId} linked Discord: ${profile.username} (${profile.id})`);
          return res.redirect(`${SITE}?link=success`);
        }
      } catch(e) { /* invalid state, fall through to normal login */ }
    }

    // Normal Discord login: save user to DB (upsert: preserve email/role columns for linked accounts)
    db.run(`INSERT INTO users (id, username, avatar, auth_type, created_at, last_login) VALUES (?, ?, ?, 'discord', ?, ?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, avatar=excluded.avatar, last_login=?`,
      [profile.id, profile.username, profile.avatar, now, now, now]);

    // Issue JWT (bypasses cross-origin cookie issues)
    const token = jwt.sign(
      { id: profile.id, username: profile.username, avatar: profile.avatar },
      SESSION_SECRET,
      { expiresIn: '30d' }
    );
    res.redirect(`${SITE}?login=success&token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('[OAuth] Discord auth error:', err.message);
    res.redirect(`${SITE}?login=failed`);
  }
});

// JWT auth middleware — runs before all /api routes.
function resolveUser(req, res, next) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(auth.slice(7), SESSION_SECRET);
    } catch(e) { /* invalid/expired token — req.user stays undefined */ }
  }
  next();
}
app.use('/api/', resolveUser);

// Redirect root to GitHub Pages frontend
app.get('/', (req, res) => res.redirect('https://coldtouch.github.io/coldtouch-market-analyzer/'));

// Health check for monitoring
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    nats: !!natsConnection,
    wsClients: wsClients ? wsClients.size : 0,
    cacheItems: cacheItemCount || 0
  });
});

app.get('/api/me', (req, res) => {
  if(req.user) {
    // Use readDb (separate connection) so this never queues behind main db writes
    // (market scan batch-inserts, compaction, etc.) — prevents login timeouts.
    readDb.get(`SELECT u.auth_type, u.role, u.email, u.linked_discord_id, u.email_verified, u.created_at, s.scans_30d, s.scans_total, s.tier
      FROM users u LEFT JOIN user_stats s ON u.id = s.user_id WHERE u.id = ?`, [req.user.id], (err, row) => {
      if (err) console.error('[/api/me] readDb error:', err.message);
      const stats = row ? { scans_30d: row.scans_30d || 0, scans_total: row.scans_total || 0, tier: row.tier || 'bronze' } : { scans_30d: 0, scans_total: 0, tier: 'bronze' };
      res.json({
        loggedIn: true,
        user: {
          id: req.user.id,
          username: req.user.username,
          avatar: req.user.avatar,
          authType: (row && row.auth_type) || 'discord',
          role: (row && row.role) || 'free',
          email: row && row.email ? row.email.replace(/(.{2})(.*)(@.*)/, '$1***$3') : null,
          emailVerified: !!(row && row.email_verified),
          hasDiscordLinked: !!(row && (row.auth_type === 'discord' || row.linked_discord_id)),
          createdAt: row && row.created_at ? row.created_at : null
        },
        stats
      });
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// === EMAIL/PASSWORD REGISTRATION & LOGIN ===
const { randomUUID } = require('crypto');

// Rate limit: 5 registration attempts per 15 minutes per IP
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many registration attempts. Try again in 15 minutes.' } });

app.post('/api/register', registerLimiter, async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username) return res.status(400).json({ error: 'Email, password, and username are required.' });

  // Validate email format
  const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format.' });

  // Validate password strength
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password.length > 128) return res.status(400).json({ error: 'Password too long.' });

  // Validate username
  const trimUser = username.trim();
  if (trimUser.length < 2 || trimUser.length > 32) return res.status(400).json({ error: 'Username must be 2-32 characters.' });

  const emailLower = email.toLowerCase().trim();

  // Check if email already exists
  db.get(`SELECT id FROM users WHERE email = ?`, [emailLower], async (err, existing) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    try {
      const hash = await bcrypt.hash(password, 12);
      const userId = 'e_' + randomUUID();
      const now = Date.now();

      const verifyToken = randomUUID();
      const verifyExpires = now + 24 * 60 * 60 * 1000; // 24 hours
      const autoVerified = !mailTransporter ? 1 : 0;

      db.run(`INSERT INTO users (id, username, email, password_hash, auth_type, role, created_at, last_login, email_verified, verification_token, verification_expires) VALUES (?, ?, ?, ?, 'email', 'free', ?, ?, ?, ?, ?)`,
        [userId, trimUser, emailLower, hash, now, now, autoVerified, autoVerified ? null : verifyToken, autoVerified ? null : verifyExpires], (err) => {
        if (err) {
          console.error('[Register] DB insert error:', err.message);
          if (err.message.includes('UNIQUE constraint')) return res.status(409).json({ error: 'An account with this email already exists.' });
          return res.status(500).json({ error: 'Registration failed.' });
        }

        // Send verification email if SMTP configured
        if (mailTransporter && !autoVerified) {
          const verifyUrl = `https://${domain}/api/verify-email?token=${verifyToken}`;
          mailTransporter.sendMail({
            from: SMTP_FROM, to: emailLower,
            subject: 'Verify your Coldtouch Market Analyzer account',
            html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;background:#1a1a26;color:#e8e8f0;border-radius:8px"><h2 style="color:#d4af37">Welcome, ${trimUser}!</h2><p>Click below to verify your email address:</p><a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#d4af37;color:#000;text-decoration:none;border-radius:6px;font-weight:bold">Verify Email</a><p style="color:#8888a0;font-size:12px;margin-top:20px">This link expires in 24 hours. If you didn't create this account, ignore this email.</p></div>`
          }).catch(e => console.error('[SMTP] Verification email failed:', e.message));
        }

        const token = jwt.sign({ id: userId, username: trimUser, avatar: null }, SESSION_SECRET, { expiresIn: '30d' });
        console.log(`[Register] New user: ${trimUser} (${emailLower}) verified=${autoVerified}`);
        res.json({ success: true, token, user: { id: userId, username: trimUser, authType: 'email', role: 'free', emailVerified: !!autoVerified } });
      });
    } catch (hashErr) {
      console.error('[Register] Hash error:', hashErr);
      res.status(500).json({ error: 'Registration failed.' });
    }
  });
});

// Rate limit: 10 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });

app.post('/api/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const emailLower = email.toLowerCase().trim();

  db.get(`SELECT id, username, avatar, password_hash, auth_type, role FROM users WHERE email = ?`, [emailLower], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!user.password_hash) return res.status(401).json({ error: 'This account uses Discord login. Please sign in with Discord.' });

    try {
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

      db.run(`UPDATE users SET last_login = ? WHERE id = ?`, [Date.now(), user.id]);

      const token = jwt.sign({ id: user.id, username: user.username, avatar: user.avatar }, SESSION_SECRET, { expiresIn: '30d' });
      console.log(`[Login] User logged in: ${user.username} (${emailLower})`);
      res.json({ success: true, token, user: { id: user.id, username: user.username, avatar: user.avatar, authType: user.auth_type, role: user.role } });
    } catch (compareErr) {
      console.error('[Login] Compare error:', compareErr);
      res.status(500).json({ error: 'Login failed.' });
    }
  });
});

// Link Discord account to email account (requires auth)
app.post('/api/link-discord', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  // This initiates the linking flow — redirect to Discord OAuth with a special state param
  const state = Buffer.from(JSON.stringify({ link: true, userId: req.user.id })).toString('base64url');
  const linkUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent('https://' + domain + '/auth/discord/callback')}&response_type=code&scope=identify&state=${state}`;
  res.json({ url: linkUrl });
});

// === EMAIL VERIFICATION ===
app.get('/api/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing verification token.');

  db.get(`SELECT id, email_verified FROM users WHERE verification_token = ?`, [token], (err, user) => {
    if (err || !user) return res.redirect(`${SITE_URL}?verify=invalid`);
    if (user.email_verified) return res.redirect(`${SITE_URL}?verify=already`);

    db.get(`SELECT verification_expires FROM users WHERE id = ?`, [user.id], (err2, row) => {
      if (row && row.verification_expires && Date.now() > row.verification_expires) {
        return res.redirect(`${SITE_URL}?verify=expired`);
      }
      db.run(`UPDATE users SET email_verified = 1, verification_token = NULL, verification_expires = NULL WHERE id = ?`, [user.id]);
      console.log(`[Verify] Email verified for user ${user.id}`);
      res.redirect(`${SITE_URL}?verify=success`);
    });
  });
});

app.post('/api/resend-verification', registerLimiter, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });
  if (!mailTransporter) return res.status(400).json({ error: 'Email verification is not configured on this server.' });

  db.get(`SELECT email, email_verified, username FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'Database error.' });
    if (!user.email) return res.status(400).json({ error: 'No email on this account.' });
    if (user.email_verified) return res.json({ success: true, message: 'Email already verified.' });

    const newToken = randomUUID();
    const newExpires = Date.now() + 24 * 60 * 60 * 1000;
    db.run(`UPDATE users SET verification_token = ?, verification_expires = ? WHERE id = ?`, [newToken, newExpires, req.user.id]);

    const verifyUrl = `https://${domain}/api/verify-email?token=${newToken}`;
    mailTransporter.sendMail({
      from: SMTP_FROM, to: user.email,
      subject: 'Verify your Coldtouch Market Analyzer account',
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;background:#1a1a26;color:#e8e8f0;border-radius:8px"><h2 style="color:#d4af37">Hi ${user.username}!</h2><p>Click below to verify your email address:</p><a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#d4af37;color:#000;text-decoration:none;border-radius:6px;font-weight:bold">Verify Email</a><p style="color:#8888a0;font-size:12px;margin-top:20px">This link expires in 24 hours.</p></div>`
    }).then(() => res.json({ success: true, message: 'Verification email sent.' }))
      .catch(e => { console.error('[SMTP] Resend failed:', e.message); res.status(500).json({ error: 'Failed to send email.' }); });
  });
});

// === USER PROFILE MANAGEMENT ===
app.post('/api/change-password', loginLimiter, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  if (newPassword.length > 128) return res.status(400).json({ error: 'Password too long.' });

  db.get(`SELECT password_hash, auth_type FROM users WHERE id = ?`, [req.user.id], async (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'Database error.' });
    if (!user.password_hash) return res.status(400).json({ error: 'This account uses Discord login and has no password to change.' });

    try {
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });

      const hash = await bcrypt.hash(newPassword, 12);
      db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, req.user.id], (err2) => {
        if (err2) return res.status(500).json({ error: 'Failed to update password.' });
        console.log(`[Profile] Password changed for user ${req.user.id}`);
        res.json({ success: true });
      });
    } catch (e) {
      res.status(500).json({ error: 'Password change failed.' });
    }
  });
});

app.post('/api/change-username', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required.' });
  const trimUser = username.trim();
  if (trimUser.length < 2 || trimUser.length > 32) return res.status(400).json({ error: 'Username must be 2-32 characters.' });

  db.run(`UPDATE users SET username = ? WHERE id = ?`, [trimUser, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: 'Failed to update username.' });
    // Update user_stats too if it exists
    db.run(`UPDATE user_stats SET username = ? WHERE user_id = ?`, [trimUser, req.user.id]);
    // Issue new JWT with updated username
    const token = jwt.sign({ id: req.user.id, username: trimUser, avatar: req.user.avatar }, SESSION_SECRET, { expiresIn: '30d' });
    console.log(`[Profile] Username changed for user ${req.user.id} to ${trimUser}`);
    res.json({ success: true, token, username: trimUser });
  });
});

app.post('/api/unlink-discord', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });

  db.get(`SELECT auth_type, password_hash, linked_discord_id FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'Database error.' });
    if (user.auth_type === 'discord' && !user.password_hash) {
      return res.status(400).json({ error: 'Cannot unlink Discord — it is your only login method. Set a password first.' });
    }
    if (!user.linked_discord_id && user.auth_type !== 'discord') {
      return res.status(400).json({ error: 'No Discord account linked.' });
    }

    db.run(`UPDATE users SET linked_discord_id = NULL WHERE id = ?`, [req.user.id], (err2) => {
      if (err2) return res.status(500).json({ error: 'Failed to unlink Discord.' });
      console.log(`[Profile] Discord unlinked for user ${req.user.id}`);
      res.json({ success: true });
    });
  });
});

// === DEVICE AUTHORIZATION (OAuth 2.0 Device Flow) ===
const deviceCodes = {}; // { userCode: { deviceCode, userId, username, captureToken, expiresAt, authorized } }

// Step 1: Client requests a device code
app.post('/api/device/code', (req, res) => {
  const userCode = require('crypto').randomBytes(3).toString('hex').toUpperCase().match(/.{3}/g).join('-'); // ABC-DEF
  const deviceCode = require('crypto').randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min expiry

  deviceCodes[userCode] = { deviceCode, userId: null, captureToken: null, expiresAt, authorized: false };

  console.log(`[DeviceAuth] Code issued: ${userCode}`);
  res.json({
    user_code: userCode,
    device_code: deviceCode,
    verification_uri: SITE_URL + '?device=' + userCode,
    expires_in: 600,
    interval: 5
  });
});

// Step 2: Client polls for authorization
app.post('/api/device/token', (req, res) => {
  const { device_code } = req.body;
  if (!device_code) return res.status(400).json({ error: 'device_code required' });

  // Find the matching entry
  let found = null;
  for (const [code, entry] of Object.entries(deviceCodes)) {
    if (entry.deviceCode === device_code) { found = { code, entry }; break; }
  }

  if (!found) return res.status(404).json({ error: 'expired_token' });
  if (Date.now() > found.entry.expiresAt) {
    delete deviceCodes[found.code];
    return res.status(410).json({ error: 'expired_token' });
  }
  if (!found.entry.authorized) {
    return res.status(428).json({ error: 'authorization_pending' });
  }

  // Authorized — return the capture token
  const result = {
    capture_token: found.entry.captureToken,
    username: found.entry.username
  };
  delete deviceCodes[found.code]; // One-time use
  console.log(`[DeviceAuth] Token claimed by ${found.entry.username}`);
  res.json(result);
});

// Step 3: User authorizes on website (browser, logged in)
app.post('/api/device/authorize', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const { user_code } = req.body;
  if (!user_code) return res.status(400).json({ error: 'user_code required' });

  const entry = deviceCodes[user_code];
  if (!entry) return res.status(404).json({ error: 'Invalid or expired code.' });
  if (Date.now() > entry.expiresAt) {
    delete deviceCodes[user_code];
    return res.status(410).json({ error: 'Code expired. Request a new one from the client.' });
  }

  // Generate capture token for this user
  const captureToken = require('crypto').randomBytes(24).toString('hex');
  db.run(`UPDATE users SET capture_token = ? WHERE id = ?`, [captureToken, req.user.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to generate token.' });

    entry.authorized = true;
    entry.userId = req.user.id;
    entry.username = req.user.username;
    entry.captureToken = captureToken;

    console.log(`[DeviceAuth] Code ${user_code} authorized by ${req.user.username}`);
    res.json({ success: true, username: req.user.username });
  });
});

// Evict expired device codes every 5 min
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(deviceCodes)) {
    if (now > deviceCodes[code].expiresAt) delete deviceCodes[code];
  }
}, 5 * 60 * 1000);

// === CAPTURE TOKEN + LOOT BUYER ===
const clientCaptures = {}; // { userId: [{ items, capturedAt, ... }] } — auto-expire 1h

// Generate a capture token for the custom client
app.post('/api/generate-capture-token', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });
  const token = require('crypto').randomBytes(24).toString('hex');
  db.run(`UPDATE users SET capture_token = ? WHERE id = ?`, [token, req.user.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to generate token.' });
    console.log(`[CaptureToken] Generated for user ${req.user.id}`);
    res.json({ success: true, token });
  });
});

// Get current capture token
app.get('/api/capture-token', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });
  db.get(`SELECT capture_token FROM users WHERE id = ?`, [req.user.id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    res.json({ token: row?.capture_token || null });
  });
});

// Evaluate loot tab items against market data
app.post('/api/loot-evaluate', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });
  const { items, askingPrice } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0 || items.length > 300) {
    return res.status(400).json({ error: 'Items array required (1-300 items).' });
  }

  const now = Date.now();
  const STALE_MS = 6 * 60 * 60 * 1000; // 6 hours — data older than this is flagged stale
  const results = [];
  let totalQuickSell = 0, totalPatientSell = 0;

  for (const item of items) {
    const { itemId, quality, quantity } = item;
    if (!itemId) continue;
    const q = parseInt(quality) || 1;
    const qty = parseInt(quantity) || 1;
    const data = alertMarketDb[itemId] && alertMarketDb[itemId][q];

    const result = {
      itemId, quality: q, quantity: qty,
      name: getFriendlyName(itemId),
      bestInstantSell: null,
      bestMarketSell: null,
      cityBreakdown: [],
      globalAvg: globalPriceRef[itemId + '_' + q] || 0,
      riskFlags: []
    };

    if (!data) {
      result.riskFlags.push('no_data');
      results.push(result);
      continue;
    }

    let bestBuyMax = 0, bestBuyCity = null, bestBuyAmount = 0;
    let bestCityAvg = 0, bestCityAvgCity = null;
    let freshestSeen = 0;

    for (const [city, cd] of Object.entries(data)) {
      const cityAvg = cityPriceRef[itemId + '_' + q + '_' + city] || 0;
      const cityVol = volumeRef[itemId + '_' + q + '_' + city] || 0;
      const ageMin = Math.round((now - (cd.lastSeen || 0)) / 60000);
      result.cityBreakdown.push({
        city,
        sellMin: cd.sellMin === Infinity ? 0 : cd.sellMin,
        buyMax: cd.buyMax || 0,
        buyAmount: cd.buyAmount || 0,
        cityAvg,
        dailyVol: cityVol,
        age: ageMin
      });
      if ((cd.lastSeen || 0) > freshestSeen) freshestSeen = cd.lastSeen || 0;
      if (cd.buyMax > bestBuyMax) {
        bestBuyMax = cd.buyMax;
        bestBuyCity = city;
        bestBuyAmount = cd.buyAmount || 0;
      }
      if (cityAvg > bestCityAvg) {
        bestCityAvg = cityAvg;
        bestCityAvgCity = city;
      }
    }

    if (bestBuyMax > 0) {
      const net = Math.floor(bestBuyMax * (1 - TAX_RATE));
      result.bestInstantSell = { city: bestBuyCity, price: bestBuyMax, amount: bestBuyAmount, netPerUnit: net };
      totalQuickSell += net * qty;
    }

    if (bestCityAvg > 0) {
      const net = Math.floor(bestCityAvg * (1 - TAX_RATE));
      result.bestMarketSell = { city: bestCityAvgCity, price: Math.round(bestCityAvg), netPerUnit: net };
      totalPatientSell += net * qty;
    }

    // Risk flags
    if (bestBuyMax === 0) result.riskFlags.push('no_buy_orders');        // No buy orders anywhere
    if (bestBuyAmount > 0 && bestBuyAmount < qty) result.riskFlags.push('low_liquidity'); // Fewer buyers than our qty
    if (freshestSeen > 0 && now - freshestSeen > STALE_MS) result.riskFlags.push('stale_data');  // Data > 6h old

    results.push(result);
  }

  // Server-side verdict summary if askingPrice supplied
  let verdict = null;
  if (askingPrice > 0) {
    if (askingPrice <= totalQuickSell) verdict = 'buy';
    else if (askingPrice <= totalPatientSell) verdict = 'maybe';
    else verdict = 'skip';
  }

  res.json({
    items: results,
    totals: {
      quickSellTotal: totalQuickSell,
      patientSellTotal: totalPatientSell,
      itemCount: results.length,
      riskItemCount: results.filter(r => r.riskFlags.length > 0).length,
      verdict
    }
  });
});

// Get pending chest captures for this user
app.get('/api/chest-captures', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required.' });
  const captures = clientCaptures[req.user.id] || [];
  res.json({ captures });
});

// Evict stale captures every 30 min
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const userId of Object.keys(clientCaptures)) {
    clientCaptures[userId] = clientCaptures[userId].filter(c => c.capturedAt > cutoff);
    if (clientCaptures[userId].length === 0) delete clientCaptures[userId];
  }
}, 30 * 60 * 1000);

// === LOOT TAB LIFECYCLE TRACKER ===

// "I Bought This" — save a loot tab with purchase price to DB
app.post('/api/loot-tab/save', requireAuth, (req, res) => {
  const { tabName, city, purchasePrice, items } = req.body;
  if (!tabName || !items || !Array.isArray(items) || items.length === 0 || items.length > 300) {
    return res.status(400).json({ error: 'tabName and items array required (1-300 items).' });
  }
  const price = Math.max(0, parseInt(purchasePrice) || 0);
  const now = Date.now();
  const itemsJson = JSON.stringify(items);
  db.run(
    `INSERT INTO loot_tabs (user_id, tab_name, city, purchase_price, items_json, purchased_at, status) VALUES (?, ?, ?, ?, ?, ?, 'open')`,
    [req.user.id, tabName.slice(0, 100), (city || '').slice(0, 50), price, itemsJson, now],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// List user's tracked tabs with revenue summary
app.get('/api/loot-tabs', requireAuth, (req, res) => {
  db.all(
    `SELECT lt.id, lt.tab_name, lt.city, lt.purchase_price, lt.items_json, lt.purchased_at, lt.status,
      COALESCE(SUM(ls.sale_price * ls.quantity), 0) as revenue_so_far,
      COUNT(ls.id) as sale_records
     FROM loot_tabs lt
     LEFT JOIN loot_tab_sales ls ON ls.loot_tab_id = lt.id
     WHERE lt.user_id = ?
     GROUP BY lt.id
     ORDER BY lt.purchased_at DESC
     LIMIT 50`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const tabs = (rows || []).map(r => {
        let items = [];
        try { items = JSON.parse(r.items_json); } catch(e) {}
        const totalQty = items.reduce((s, it) => s + (parseInt(it.quantity) || 1), 0);
        return {
          id: r.id,
          tabName: r.tab_name,
          city: r.city,
          purchasePrice: r.purchase_price,
          purchasedAt: r.purchased_at,
          status: r.status,
          itemCount: items.length,
          totalQuantity: totalQty,
          revenueSoFar: r.revenue_so_far,
          saleRecords: r.sale_records
        };
      });
      res.json({ tabs });
    }
  );
});

// Get a single tab with full item list and sales history
app.get('/api/loot-tab/:id', requireAuth, (req, res) => {
  const tabId = parseInt(req.params.id);
  if (!tabId) return res.status(400).json({ error: 'Invalid tab id.' });
  db.get(`SELECT * FROM loot_tabs WHERE id = ? AND user_id = ?`, [tabId, req.user.id], (err, tab) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!tab) return res.status(404).json({ error: 'Tab not found.' });
    let items = [];
    try { items = JSON.parse(tab.items_json); } catch(e) {}
    db.all(`SELECT * FROM loot_tab_sales WHERE loot_tab_id = ? ORDER BY sold_at DESC`, [tabId], (err2, sales) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const revenue = (sales || []).reduce((s, r) => s + r.sale_price * r.quantity, 0);
      res.json({
        id: tab.id,
        tabName: tab.tab_name,
        city: tab.city,
        purchasePrice: tab.purchase_price,
        purchasedAt: tab.purchased_at,
        status: tab.status,
        items,
        sales: sales || [],
        revenueSoFar: revenue,
        netProfit: revenue - tab.purchase_price
      });
    });
  });
});

// Record a manual sale against a tracked tab
app.post('/api/loot-tab/:id/sale', requireAuth, (req, res) => {
  const tabId = parseInt(req.params.id);
  if (!tabId) return res.status(400).json({ error: 'Invalid tab id.' });
  const { itemId, quality, quantity, salePrice } = req.body;
  if (!itemId || !salePrice) return res.status(400).json({ error: 'itemId and salePrice required.' });
  const price = parseInt(salePrice);
  if (isNaN(price) || price <= 0) return res.status(400).json({ error: 'salePrice must be positive.' });
  db.get(`SELECT id FROM loot_tabs WHERE id = ? AND user_id = ?`, [tabId, req.user.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Tab not found.' });
    const qty = Math.max(1, parseInt(quantity) || 1);
    const now = Date.now();
    db.run(
      `INSERT INTO loot_tab_sales (loot_tab_id, item_id, quality, quantity, sale_price, sold_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [tabId, itemId.slice(0, 100), parseInt(quality) || 1, qty, price, now],
      function(err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

// Update tab status (open / partial / sold)
app.patch('/api/loot-tab/:id/status', requireAuth, (req, res) => {
  const tabId = parseInt(req.params.id);
  if (!tabId) return res.status(400).json({ error: 'Invalid tab id.' });
  const { status } = req.body;
  if (!['open', 'partial', 'sold'].includes(status)) {
    return res.status(400).json({ error: 'status must be open, partial, or sold.' });
  }
  db.run(`UPDATE loot_tabs SET status = ? WHERE id = ? AND user_id = ?`, [status, tabId, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Tab not found.' });
    res.json({ success: true });
  });
});

app.delete('/api/loot-tab/:id', requireAuth, (req, res) => {
  const tabId = parseInt(req.params.id);
  if (!tabId) return res.status(400).json({ error: 'Invalid tab id.' });
  // Delete sales first (foreign key), then the tab itself
  db.run(`DELETE FROM loot_tab_sales WHERE loot_tab_id = ? AND loot_tab_id IN (SELECT id FROM loot_tabs WHERE user_id = ?)`, [tabId, req.user.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`DELETE FROM loot_tabs WHERE id = ? AND user_id = ?`, [tabId, req.user.id], function(err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Tab not found.' });
      res.json({ success: true });
    });
  });
});

// === BATCH PRICE LOOKUP (for loot logger estimates) ===
// Uses price_averages (aggregated scan data) — no outliers, no stale NATS orders.
app.post('/api/batch-prices', (req, res) => {
  const { itemIds } = req.body;
  if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 500) {
    return res.status(400).json({ error: 'itemIds array required (1-500).' });
  }

  // Build SQL placeholders for the item list
  const cleanIds = itemIds.filter(id => typeof id === 'string').slice(0, 500);
  if (cleanIds.length === 0) return res.json({});

  const placeholders = cleanIds.map(() => '?').join(',');

  // Query price_averages: get the most recent average sell price per item across all cities
  // Uses the last 48 hours of aggregated data — reliable, no outlier single orders
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  readDb.all(
    `SELECT item_id, city,
            AVG(avg_sell) as price_avg,
            MIN(min_sell) as price_min
     FROM price_averages
     WHERE item_id IN (${placeholders})
       AND avg_sell > 0
       AND quality = 1
       AND period_start > ?
     GROUP BY item_id, city`,
    [...cleanIds, cutoff],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const result = {};
      for (const row of (rows || [])) {
        const existing = result[row.item_id];
        const price = Math.round(row.price_avg);
        if (!existing) {
          result[row.item_id] = { price, city: row.city, source: 'avg' };
        } else if (price < existing.price) {
          result[row.item_id] = { price, city: row.city, source: 'avg' };
        }
      }

      // Fill gaps from in-memory alertMarketDb (real-time scan data)
      for (const itemId of cleanIds) {
        if (result[itemId]) continue;
        const data = alertMarketDb[itemId] && alertMarketDb[itemId][1];
        if (data) {
          for (const [city, cd] of Object.entries(data)) {
            if (cd.sellMin > 0) {
              if (!result[itemId] || cd.sellMin < result[itemId].price) {
                result[itemId] = { price: cd.sellMin, city, source: 'live' };
              }
            }
          }
        }
      }

      // Last resort: globalPriceRef
      for (const itemId of cleanIds) {
        if (result[itemId]) continue;
        const gAvg = globalPriceRef[itemId + '_1'] || 0;
        if (gAvg > 0) result[itemId] = { price: Math.round(gAvg), city: '', source: 'global' };
      }

      res.json(result);
    }
  );
});

// === SALE NOTIFICATIONS API ===
app.get('/api/sale-notifications', requireAuth, (req, res) => {
  readDb.all(`SELECT * FROM sale_notifications WHERE user_id = ? ORDER BY sold_at DESC LIMIT 50`, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// === LOOT LOGGER API ===

// List loot sessions for the current user
app.get('/api/loot-sessions', requireAuth, (req, res) => {
  db.all(`SELECT session_id, MIN(timestamp) as started_at, MAX(timestamp) as ended_at, COUNT(*) as event_count,
    COUNT(DISTINCT looted_by_name) as player_count
    FROM loot_events WHERE user_id = ? GROUP BY session_id ORDER BY started_at DESC LIMIT 50`,
    [req.user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ sessions: rows || [] });
    });
});

// Get all events for a specific session
app.get('/api/loot-session/:sessionId', requireAuth, (req, res) => {
  const sessionId = req.params.sessionId;
  db.all(`SELECT * FROM loot_events WHERE session_id = ? AND user_id = ? ORDER BY timestamp ASC`,
    [sessionId, req.user.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ events: rows || [] });
    });
});

// Upload a .txt loot log file (ao-loot-logger format)
app.post('/api/loot-upload', requireAuth, (req, res) => {
  const { lines } = req.body;
  if (!lines || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'No loot data provided.' });
  }
  const sessionId = req.user.id + '_upload_' + Date.now();
  const stmt = db.prepare(`INSERT INTO loot_events (user_id, session_id, timestamp, looted_by_name, looted_by_guild, looted_by_alliance, looted_from_name, looted_from_guild, looted_from_alliance, item_id, numeric_id, quantity, weight, is_silver)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`);
  let count = 0;
  for (const line of lines) {
    // Format: timestamp_utc;looted_by__alliance;looted_by__guild;looted_by__name;item_id;item_name;quantity;looted_from__alliance;looted_from__guild;looted_from__name
    const parts = line.split(';');
    if (parts.length < 10) continue;
    const [ts, byAlliance, byGuild, byName, itemId, itemName, qty, fromAlliance, fromGuild, fromName] = parts;
    const timestamp = new Date(ts).getTime() || Date.now();
    stmt.run(req.user.id, sessionId, timestamp, byName || '', byGuild || '', byAlliance || '', fromName || '', fromGuild || '', fromAlliance || '', itemId || '', 0, parseInt(qty) || 1);
    count++;
  }
  stmt.finalize();
  res.json({ success: true, sessionId, eventsImported: count });
});

// Delete a loot session
app.delete('/api/loot-session/:sessionId', requireAuth, (req, res) => {
  const sessionId = req.params.sessionId;
  db.run(`DELETE FROM loot_events WHERE session_id = ? AND user_id = ?`, [sessionId, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

// === LIVE FLIPS API (registration-gated) ===
app.get('/api/live-flips', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required. Create a free account to access live flips.' });
  res.json({ flips: liveFlips, total: liveFlips.length });
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
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  next();
}

// Alerts are scoped to the requesting user's web guild ID ('web-<userId>').
// This prevents any authenticated user from reading/deleting another user's alerts.
app.get('/api/alerts', requireAuth, (req, res) => {
  const guildId = 'web-' + req.user.id;
  db.all(`SELECT guild_id, channel_id, min_profit, cooldown_ms FROM alerts WHERE guild_id = ?`, [guildId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/alerts', requireAuth, (req, res) => {
  const { channel_id, min_profit } = req.body;
  if (!channel_id || !min_profit) return res.status(400).json({ error: 'channel_id and min_profit required' });
  const profit = parseInt(min_profit);
  if (isNaN(profit) || profit < 0 || profit > 100000000) return res.status(400).json({ error: 'min_profit must be between 0 and 100,000,000' });
  const guildId = 'web-' + req.user.id;
  db.run(`INSERT OR REPLACE INTO alerts (guild_id, channel_id, min_profit) VALUES (?, ?, ?)`,
    [guildId, channel_id, profit], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, channel_id, min_profit: profit });
  });
});

app.delete('/api/alerts', requireAuth, (req, res) => {
  const { channel_id } = req.body;
  if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
  const guildId = 'web-' + req.user.id;
  // Scoped delete: only removes the alert if it belongs to the requesting user.
  db.run(`DELETE FROM alerts WHERE channel_id = ? AND guild_id = ?`, [channel_id, guildId], (err) => {
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
  // Cap array length to prevent score manipulation and memory pressure.
  // A real web refresh touches at most ~500 items per batch.
  if (item_ids.length > 500) {
    return res.status(400).json({ error: 'item_ids must contain 500 or fewer entries' });
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

const feedbackLimiter = rateLimit({ windowMs: 60 * 1000, max: 1, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => (req.user ? req.user.id : req.ip) });

app.post('/api/feedback', feedbackLimiter, (req, res) => {
  const { type, message } = req.body;
  const validTypes = ['bug', 'suggestion'];
  if (!type || !validTypes.includes(type)) return res.status(400).json({ error: 'type must be bug or suggestion' });
  if (!message || typeof message !== 'string' || message.trim().length < 5) return res.status(400).json({ error: 'message must be at least 5 characters' });
  if (message.length > 1000) return res.status(400).json({ error: 'message must be 1000 characters or fewer' });

  if (!DISCORD_FEEDBACK_WEBHOOK) return res.status(503).json({ error: 'Feedback not configured' });

  const username = req.user ? req.user.username : 'Anonymous';
  const userId = req.user ? req.user.id : null;
  const color = type === 'bug' ? 0xf87171 : 0x60a5fa;
  const label = type === 'bug' ? '\\uD83D\\uDC1B Bug Report' : '\\uD83D\\uDCA1 Suggestion';

  const embed = {
    title: label,
    description: message.trim().substring(0, 1000),
    color,
    fields: [{ name: 'Submitted by', value: userId ? `${username} (${userId})` : 'Anonymous', inline: true }],
    timestamp: new Date().toISOString()
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  fetch(DISCORD_FEEDBACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
    signal: controller.signal
  }).then(r => {
    clearTimeout(timer);
    if (!r.ok) { console.error('[Feedback] Webhook failed:', r.status); return res.status(502).json({ error: 'Failed to deliver feedback' }); }
    res.json({ success: true });
  }).catch(err => {
    clearTimeout(timer);
    console.error('[Feedback] Webhook error:', err.message);
    res.status(500).json({ error: 'Failed to deliver feedback' });
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
  const params = [cutoff7d, minProfit, minConfidence];

  if (buyCity) { whereClause += ` AND ss.buy_city = ?`; params.push(buyCity); }
  if (sellCity) { whereClause += ` AND ss.sell_city = ?`; params.push(sellCity); }

  // CTE pre-aggregates volume data once, then JOINs to spread_stats (10-50x faster than correlated subqueries)
  const sql = `
    WITH vol AS (
      SELECT item_id, quality, city, AVG(sample_count) as avg_vol
      FROM price_averages
      WHERE period_type IN ('daily','hourly') AND period_start > ?
      GROUP BY item_id, quality, city
    )
    SELECT
      ss.item_id, ss.quality, ss.buy_city, ss.sell_city,
      ss.avg_spread, ss.median_spread, ss.consistency_pct,
      ss.sample_count, ss.confidence_score,
      COALESCE(bv.avg_vol, 0) as buy_volume,
      COALESCE(sv.avg_vol, 0) as sell_volume
    FROM spread_stats ss
    LEFT JOIN vol bv ON bv.item_id = ss.item_id AND bv.quality = ss.quality AND bv.city = ss.buy_city
    LEFT JOIN vol sv ON sv.item_id = ss.item_id AND sv.quality = ss.quality AND sv.city = ss.sell_city
    ${whereClause}
    ORDER BY (ss.avg_spread * COALESCE(bv.avg_vol, 0)) DESC
    LIMIT ?
  `;
  params.push(limit);

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// === LIVE TRANSPORT ROUTES (computed from alertMarketDb + historical per-city averages) ===
// Per-city historical price reference: { "itemId_quality_city": avgPrice }
// This tells us what an item ACTUALLY SELLS FOR in each city over 7 days
let cityPriceRef = {};
let globalPriceRef = {}; // { "itemId_quality": avgPrice } for outlier detection
let volumeRef = {};     // { "itemId_quality_city": avg_sample_count } — activity proxy for liquidity flags
function buildPriceReference() {
  // Use last 2 days for city reference (recent transaction prices, not week-old inflated data)
  // Use last 7 days for global reference (outlier detection needs broader sample)
  const cutoff2d = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Per-city averages: RECENT (2 days) — what items actually sell for NOW in each city
  db.all(`SELECT item_id, quality, city, AVG(avg_sell) as avg_price, AVG(sample_count) as avg_vol, COUNT(*) as samples
    FROM price_averages WHERE period_type IN ('daily','hourly') AND period_start > ? AND avg_sell > 0
    GROUP BY item_id, quality, city`, [cutoff2d], (err, rows) => {
    if (err || !rows) return;
    const cityRef = {}, globalRef = {}, volRef = {};
    for (const r of rows) {
      if (r.samples >= 2 && r.avg_price > 0) {
        cityRef[r.item_id + '_' + r.quality + '_' + r.city] = Math.round(r.avg_price);
        volRef[r.item_id + '_' + r.quality + '_' + r.city] = Math.round(r.avg_vol || 0);
        // Also build global average (across all cities)
        const gk = r.item_id + '_' + r.quality;
        if (!globalRef[gk]) globalRef[gk] = { sum: 0, cnt: 0 };
        globalRef[gk].sum += r.avg_price;
        globalRef[gk].cnt++;
      }
    }
    cityPriceRef = cityRef;
    volumeRef = volRef;
    console.log(`[PriceRef] City prices (2d): ${Object.keys(cityRef).length}, volume entries: ${Object.keys(volRef).length}`);

    // Global averages use 7 days for broader outlier detection
    db.all(`SELECT item_id, quality, AVG(avg_sell) as avg_price, COUNT(*) as samples
      FROM price_averages WHERE period_type IN ('daily','hourly') AND period_start > ? AND avg_sell > 0
      GROUP BY item_id, quality`, [cutoff7d], (err2, rows2) => {
      if (err2 || !rows2) return;
      const gRef = {};
      for (const r of rows2) {
        if (r.samples >= 5 && r.avg_price > 0) gRef[r.item_id + '_' + r.quality] = Math.round(r.avg_price);
      }
      globalPriceRef = gRef;
      console.log(`[PriceRef] Global averages (7d): ${Object.keys(gRef).length}`);
    });
  });
}
setTimeout(buildPriceReference, 15000);
setInterval(buildPriceReference, 10 * 60 * 1000);

app.get('/api/transport-routes-live', (req, res) => {
  const buyCity = req.query.buy_city || '';
  const sellCity = req.query.sell_city || '';
  const sellStrategy = req.query.sell_strategy || 'market';
  const minProfit = parseInt(req.query.min_profit) || 100; // Low default: resources have tiny per-unit margins but huge bulk volume
  const maxAge = parseInt(req.query.max_age) || 120;
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const excludeCities = (req.query.exclude || '').split(',').filter(Boolean);

  const now = Date.now();
  const maxAgeMs = maxAge * 60 * 1000;
  const routes = [];

  for (const [itemId, qualities] of Object.entries(alertMarketDb)) {
    for (const [qStr, cities] of Object.entries(qualities)) {
      const q = parseInt(qStr);
      const cityEntries = Object.entries(cities);
      const globalAvg = globalPriceRef[itemId + '_' + q] || 0;
      if (!globalAvg) continue; // No trade history = skip

      // === CROSS-CITY SANITY CHECK ===
      // Find the MINIMUM sell price across ALL cities — this is the TRUE market value.
      // Any city where sell_price_min is wildly above this baseline has a junk listing.
      let minSellAcrossCities = Infinity;
      let citiesWithSellData = 0;
      for (const [, cd] of cityEntries) {
        if (cd.sellMin > 0 && cd.sellMin < Infinity) {
          if (cd.sellMin < minSellAcrossCities) minSellAcrossCities = cd.sellMin;
          citiesWithSellData++;
        }
      }
      if (minSellAcrossCities === Infinity || citiesWithSellData < 2) continue;

      // Use the lower of (min across cities) and (global historical avg) as the baseline
      // This catches both live manipulation AND historical pollution
      const baseline = Math.min(minSellAcrossCities, globalAvg);

      for (let i = 0; i < cityEntries.length; i++) {
        const [srcCity, srcData] = cityEntries[i];
        if (!srcData.sellMin || srcData.sellMin === Infinity || srcData.sellMin <= 0) continue;
        // Use lastSeen for freshness (= when API last returned this item, proves it exists)
        // sellDate = when price last changed (for display only)
        if (srcData.lastSeen && (now - srcData.lastSeen) > maxAgeMs) continue;
        if (buyCity && srcCity !== buyCity) continue;
        if (excludeCities.includes(srcCity)) continue;
        if (srcData.sellMin > baseline * 2) continue;

        for (let j = 0; j < cityEntries.length; j++) {
          if (i === j) continue;
          const [dstCity, dstData] = cityEntries[j];
          if (sellCity && dstCity !== sellCity) continue;
          if (excludeCities.includes(dstCity)) continue;

          let dstPrice = 0, dstDate = 0;

          if (sellStrategy === 'instant') {
            if (!dstData.buyMax || dstData.buyMax <= 0) continue;
            if (dstData.lastSeen && (now - dstData.lastSeen) > maxAgeMs) continue;
            dstPrice = dstData.buyMax;
            dstDate = dstData.buyDate || dstData.lastSeen || 0;
            if (dstPrice > baseline * 3) continue;
          } else {
            // "List on Market": use LIVE sell_price_min in destination city
            // This is what items actually cost there — you'd undercut to sell.
            // Double validation: must be reasonable vs both baseline AND historical avg
            if (!dstData || !dstData.sellMin || dstData.sellMin === Infinity || dstData.sellMin <= 0) continue;
            if (dstData.lastSeen && (now - dstData.lastSeen) > maxAgeMs) continue;
            dstPrice = dstData.sellMin;
            dstDate = dstData.sellDate || dstData.lastSeen || 0;
            // Must be within 2x baseline (catches junk listings)
            if (dstPrice > baseline * 2) continue;
            // Must be within 2x of city historical avg (catches data anomalies)
            const dstAvg = cityPriceRef[itemId + '_' + q + '_' + dstCity] || 0;
            if (dstAvg > 0 && dstPrice > dstAvg * 2) continue;
            // Source must also be near its own city average
            const srcAvg = cityPriceRef[itemId + '_' + q + '_' + srcCity] || 0;
            if (srcAvg > 0 && srcData.sellMin > srcAvg * 2) continue;
          }

          if (dstPrice <= srcData.sellMin) continue;

          const profit = dstPrice - srcData.sellMin - (dstPrice * TAX_RATE);
          if (profit < minProfit) continue;
          const roi = (profit / srcData.sellMin) * 100;
          if (roi > 150) continue; // Skip extreme outliers but allow low-margin bulk routes

          // Detect stackable items by ID pattern.
          // Gear IDs contain: HEAD_, ARMOR_, SHOES_, MAIN_, 2H_, OFF_, CAPEITEM_, BAG_, CAPE_
          // Resource/material IDs are like: T5_CLOTH, T5_PLANKS, T5_ROCK (no gear prefix)
          const isGear = /_(HEAD|ARMOR|SHOES|MAIN|2H|OFF|CAPEITEM|BAG|CAPE|MOUNT)_/.test(itemId) || itemId.startsWith('MOUNT_');
          const isStackable = !isGear && (
            /^T\d_(ROCK|STONE|STONEBLOCK|WOOD|PLANKS|ORE|METALBAR|HIDE|LEATHER|FIBER|CLOTH|FISH)/.test(itemId) ||
            itemId.includes('POTION') || itemId.includes('MEAL') || itemId.startsWith('JOURNAL') ||
            /^T\d_(RUNE|SOUL|RELIC|SHARD|ARTEFACT)/.test(itemId) || itemId.includes('SKILLBOOK') ||
            itemId.includes('MOB_') || itemId.includes('TREASURE') || itemId.includes('TOKEN')
          );
          const stackSize = isStackable ? 999 : 1;
          // Rough trip profit: profit × (budget / buyPrice) capped by 48 slots
          const maxByBudget = Math.floor(30000000 / srcData.sellMin); // assume 30M budget
          const maxBySlots = isStackable ? 48 * stackSize : 48;
          const estQuantity = Math.min(maxByBudget, maxBySlots);
          const estTripProfit = Math.floor(profit * estQuantity);

          routes.push({
            item_id: itemId,
            quality: q,
            name: getFriendlyName(itemId),
            buy_city: srcCity,
            sell_city: dstCity,
            buy_price: srcData.sellMin,
            sell_price: Math.round(dstPrice),
            buy_amount: srcData.sellAmount || 0, // Available qty at buy price (from NATS)
            sell_amount: sellStrategy === 'instant' ? (dstData?.buyAmount || 0) : 0,
            profit: Math.floor(profit),
            roi: parseFloat(roi.toFixed(1)),
            est_trip_profit: estTripProfit,
            est_quantity: estQuantity,
            is_stackable: isStackable,
            buy_age: Math.round((now - (srcData.sellDate || srcData.lastSeen || now)) / 60000),
            sell_age: sellStrategy === 'instant' ? Math.round((now - (dstDate || now)) / 60000) : -1,
            sell_strategy: sellStrategy,
            avg_price: globalAvg
          });
        }
      }
    }
  }

  routes.sort((a, b) => b.est_trip_profit - a.est_trip_profit);
  const result = routes.slice(0, limit);
  // Also count how many have buy orders (instant sell) available for the same route
  let instantAvailable = 0;
  for (const r of result) {
    const dstData = alertMarketDb[r.item_id]?.[r.quality]?.[r.sell_city];
    if (dstData?.buyMax > 0 && dstData.buyMax > r.buy_price) {
      r.instant_sell_price = dstData.buyMax;
      r.instant_profit = Math.floor(dstData.buyMax - r.buy_price - (dstData.buyMax * TAX_RATE));
      if (r.instant_profit > 0) instantAvailable++;
    }
  }
  console.log(`[Transport-Live] ${routes.length} routes (strategy=${sellStrategy}, maxAge=${maxAge}m, instant=${instantAvailable})`);
  res.json({ routes: result, total: routes.length, dataPoints: Object.keys(alertMarketDb).length });
});

app.get('/api/price-history', (req, res) => {
  const { item_id, city, days } = req.query;
  if (!item_id) return res.status(400).json({ error: 'item_id required' });
  const daysBack = Math.min(parseInt(days) || 7, 90);
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const quality = parseInt(req.query.quality) || 1;

  // Query price_averages (hourly/daily) instead of raw snapshots
  const histQuery = city
    ? `SELECT avg_sell as sell_price_min, avg_buy as buy_price_max, min_sell, max_buy, period_start as recorded_at FROM price_averages WHERE item_id = ? AND city = ? AND quality = ? AND period_start > ? ORDER BY period_start`
    : `SELECT city, avg_sell as sell_price_min, avg_buy as buy_price_max, min_sell, max_buy, period_start as recorded_at FROM price_averages WHERE item_id = ? AND quality = ? AND period_start > ? ORDER BY period_start`;
  const histParams = city ? [item_id, city, quality, cutoff] : [item_id, quality, cutoff];

  db.all(histQuery, histParams, (err, histRows) => {
    if (err) return res.status(500).json({ error: 'An internal error occurred' });
    const history = histRows || [];

    // OHLC from price_hourly (7–30 day range)
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const ohlcQuery = city
      ? `SELECT hour, open_price, high_price, low_price, close_price, avg_price, volume FROM price_hourly WHERE item_id = ? AND city = ? AND quality = ? AND hour >= ? ORDER BY hour`
      : `SELECT city, hour, open_price, high_price, low_price, close_price, avg_price, volume FROM price_hourly WHERE item_id = ? AND quality = ? AND hour >= ? ORDER BY hour`;
    const ohlcCutoff = new Date(cutoff).toISOString().slice(0, 13);
    const ohlcParams = city ? [item_id, city, quality, ohlcCutoff] : [item_id, quality, ohlcCutoff];

    db.all(ohlcQuery, ohlcParams, (errO, ohlcRows) => {
      const ohlc = ohlcRows || [];

      // Pre-computed analytics from price_analytics
      const analyticsQuery = city
        ? `SELECT metric, value, computed_at FROM price_analytics WHERE item_id = ? AND city = ? AND quality = ?`
        : `SELECT city, metric, value, computed_at FROM price_analytics WHERE item_id = ? AND quality = ?`;
      const analyticsParams = city ? [item_id, city, quality] : [item_id, quality];

      db.all(analyticsQuery, analyticsParams, (errA, analyticsRows) => {
        const analytics = {};
        for (const r of (analyticsRows || [])) {
          if (city) {
            analytics[r.metric] = r.value;
          } else {
            if (!analytics[r.city]) analytics[r.city] = {};
            analytics[r.city][r.metric] = r.value;
          }
        }
        res.json({ history, ohlc, analytics });
      });
    });
  });
});

// === ANALYTICS API ===
// Returns all pre-computed metrics from price_analytics per item+city+quality.
// Optional query params: city, quality (default 1)
app.get('/api/analytics/:itemId', (req, res) => {
  const item_id = req.params.itemId;
  const quality  = parseInt(req.query.quality) || 1;
  const city     = req.query.city || null;

  const query = city
    ? `SELECT metric, value, computed_at FROM price_analytics WHERE item_id = ? AND city = ? AND quality = ? ORDER BY metric`
    : `SELECT city, metric, value, computed_at FROM price_analytics WHERE item_id = ? AND quality = ? ORDER BY city, metric`;
  const params = city ? [item_id, city, quality] : [item_id, quality];

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'An internal error occurred' });
    if (!rows || rows.length === 0) return res.json({ item_id, quality, metrics: {} });

    if (city) {
      // Flat metrics object for a single city
      const metrics = {};
      let computed_at = null;
      for (const r of rows) {
        metrics[r.metric] = r.value;
        computed_at = computed_at || r.computed_at;
      }
      res.json({ item_id, city, quality, metrics, computed_at });
    } else {
      // Group by city
      const cities = {};
      let computed_at = null;
      for (const r of rows) {
        if (!cities[r.city]) cities[r.city] = {};
        cities[r.city][r.metric] = r.value;
        computed_at = computed_at || r.computed_at;
      }
      res.json({ item_id, quality, cities, computed_at });
    }
  });
});

// === ADMIN: DB STATS (JWT-protected) ===
// Returns DB size, row counts per table, oldest/newest timestamps for monitoring.
app.get('/api/admin/db-stats', requireAuth, (req, res) => {
  const tables = [
    'price_averages', 'price_hourly', 'price_analytics',
    'spread_stats', 'price_snapshots', 'users', 'contributions', 'loot_tabs'
  ];

  db.get(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`, (errSz, szRow) => {
    if (errSz) return res.status(500).json({ error: 'An internal error occurred' });

    // Count rows and get min/max timestamps per table
    const results = {};
    let pending = tables.length;

    function done() {
      if (--pending === 0) {
        res.json({
          db_size_bytes: szRow ? szRow.size : 0,
          db_size_mb: szRow ? Math.round(szRow.size / (1024 * 1024)) : 0,
          tables: results,
          analytics_running: analyticsRunning,
          vacuum_scheduled: vacuumScheduled,
          server_time: new Date().toISOString()
        });
      }
    }

    for (const t of tables) {
      const tsCol = t === 'price_hourly' ? 'hour' : t === 'price_analytics' ? 'computed_at' : 'period_start';
      const hasTs = ['price_averages', 'price_hourly', 'price_analytics', 'spread_stats'].includes(t);
      const countQ = hasTs && t !== 'price_hourly' && t !== 'price_analytics'
        ? `SELECT COUNT(*) as cnt, MIN(period_start) as oldest, MAX(period_start) as newest FROM ${t}`
        : `SELECT COUNT(*) as cnt FROM ${t}`;

      db.get(countQ, (err, row) => {
        results[t] = {
          rows: row ? row.cnt : 0,
          oldest: row && row.oldest ? new Date(row.oldest).toISOString().slice(0, 16) : null,
          newest: row && row.newest ? new Date(row.newest).toISOString().slice(0, 16) : null
        };
        done();
      });
    }
  });
});

// === TLS SERVER & WSS ===
const server = https.createServer({
  cert: fs.readFileSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`),
  key: fs.readFileSync(`/etc/letsencrypt/live/${domain}/privkey.pem`)
}, app);

const wss = new WebSocket.Server({ server });
let wsClients = new Set();
wss.on('connection', ws => {
  wsClients.add(ws);
  ws.isAuthenticated = false;
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      // Browser auth (JWT token)
      if (msg.type === 'auth' && msg.token) {
        try {
          ws.user = jwt.verify(msg.token, SESSION_SECRET);
          ws.isAuthenticated = true;
          ws.clientType = 'browser';
          ws.send(JSON.stringify({ type: 'auth', success: true }));
          ws.send(JSON.stringify({ type: 'flip-history', data: liveFlips }));
          // Send any pending chest captures
          const pending = clientCaptures[ws.user.id];
          if (pending && pending.length > 0) {
            ws.send(JSON.stringify({ type: 'chest-captures', data: pending }));
          }
        } catch(e) {
          ws.send(JSON.stringify({ type: 'auth', success: false, error: 'Invalid token' }));
        }
      }

      // Game client auth (capture token) — use readDb to avoid queue starvation behind NATS inserts
      if (msg.type === 'client-auth' && msg.token) {
        readDb.get(`SELECT id, username FROM users WHERE capture_token = ?`, [msg.token], (err, user) => {
          if (err || !user) {
            ws.send(JSON.stringify({ type: 'client-auth', success: false, error: 'Invalid capture token' }));
            return;
          }
          ws.user = { id: user.id, username: user.username };
          ws.isAuthenticated = true;
          ws.clientType = 'game-client';
          ws.send(JSON.stringify({ type: 'client-auth', success: true, username: user.username }));
          console.log(`[ClientAuth] Game client authenticated for user ${user.username}`);
        });
      }

      // Loot event from game client
      if (msg.type === 'loot-event' && ws.clientType === 'game-client' && ws.user) {
        const ev = msg.data;
        if (!ev || !ev.lootedBy || !ev.lootedBy.name) return;

        // Assign session ID (one per WS connection)
        if (!ws.lootSessionId) {
          ws.lootSessionId = ws.user.id + '_' + Date.now();
        }

        db.run(`INSERT INTO loot_events (user_id, session_id, timestamp, looted_by_name, looted_by_guild, looted_by_alliance, looted_from_name, looted_from_guild, looted_from_alliance, item_id, numeric_id, quantity, weight, is_silver)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ws.user.id, ws.lootSessionId, ev.timestamp || Date.now(),
           ev.lootedBy.name, ev.lootedBy.guild || '', ev.lootedBy.alliance || '',
           ev.lootedFrom?.name || '', ev.lootedFrom?.guild || '', ev.lootedFrom?.alliance || '',
           ev.itemId || '', ev.numericId || 0, ev.quantity || 1, ev.weight || 0, ev.isSilver ? 1 : 0]);

        // Push to user's browser session(s) in real-time
        for (const wc of wsClients) {
          if (wc.clientType === 'browser' && wc.isAuthenticated && wc.user && wc.user.id === ws.user.id) {
            wc.send(JSON.stringify({ type: 'loot-event', data: { ...ev, sessionId: ws.lootSessionId } }));
          }
        }
      }

      // Chest capture from game client
      if (msg.type === 'chest-capture' && ws.clientType === 'game-client' && ws.user) {
        const capture = msg.data;
        if (!capture || !capture.items) return;

        // Add player info
        capture.playerName = ws.user.username;
        capture.userId = ws.user.id;

        // Store in memory
        if (!clientCaptures[ws.user.id]) clientCaptures[ws.user.id] = [];
        clientCaptures[ws.user.id].push(capture);
        // Keep max 10 captures per user
        if (clientCaptures[ws.user.id].length > 10) clientCaptures[ws.user.id].shift();

        console.log(`[ChestCapture] Received ${capture.itemCount || capture.items.length} items from ${ws.user.username}`);

        // Push to user's browser session(s) in real-time
        for (const wc of wsClients) {
          if (wc.clientType === 'browser' && wc.isAuthenticated && wc.user && wc.user.id === ws.user.id) {
            wc.send(JSON.stringify({ type: 'chest-capture', data: capture }));
          }
        }
      }

      // Sale notification from game client (in-game mail)
      if (msg.type === 'sale-notification' && ws.clientType === 'game-client' && ws.user) {
        const sale = msg.data;
        if (!sale || !sale.itemId || !sale.mailId) return;

        const userId = ws.user.id;
        const now = sale.timestamp || Date.now();

        // Insert into sale_notifications (dedup by mail_id)
        db.run(`INSERT OR IGNORE INTO sale_notifications (user_id, mail_id, item_id, quantity, unit_price, total, location, order_type, sold_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, sale.mailId, sale.itemId, sale.amount || 1, sale.price || 0,
           sale.total || (sale.price || 0) * (sale.amount || 1), sale.location || '', sale.orderType || 'FINISHED', now],
          function(err) {
            if (err) { console.error('[SaleNotif] DB error:', err.message); return; }
            if (this.changes === 0) return; // duplicate mail_id, skip

            console.log(`[SaleNotif] ${sale.itemId} x${sale.amount || 1} @ ${sale.price} silver from ${ws.user.username}`);

            // Auto-match to open/partial loot tabs containing this item
            db.all(`SELECT id, items_json FROM loot_tabs WHERE user_id = ? AND status IN ('open','partial')`, [userId], (err2, tabs) => {
              if (err2 || !tabs) return;
              for (const tab of tabs) {
                try {
                  const items = JSON.parse(tab.items_json);
                  const match = items.find(it => it.itemId === sale.itemId);
                  if (match) {
                    // Auto-record sale on this tab
                    db.run(`INSERT INTO loot_tab_sales (loot_tab_id, item_id, quality, quantity, sale_price, sold_at)
                      VALUES (?, ?, ?, ?, ?, ?)`,
                      [tab.id, sale.itemId, match.quality || 1, sale.amount || 1, sale.price || 0, now]);
                    db.run(`UPDATE sale_notifications SET matched_tab_id = ? WHERE user_id = ? AND mail_id = ?`,
                      [tab.id, userId, sale.mailId]);
                    console.log(`[SaleNotif] Auto-matched to tab ${tab.id}`);
                    break; // match first open tab only
                  }
                } catch(e) { /* skip bad JSON */ }
              }
            });

            // Push to user's browser
            const payload = JSON.stringify({ type: 'sale-notification', data: { ...sale, userId } });
            for (const wc of wsClients) {
              if (wc.clientType === 'browser' && wc.isAuthenticated && wc.user && wc.user.id === userId) {
                wc.send(payload);
              }
            }
          });
      }
    } catch(e) { /* ignore non-JSON messages */ }
  });
  ws.on('close', () => wsClients.delete(ws));
});

// === LIVE FLIP DETECTION ===
const liveFlips = [];
const MAX_FLIPS = 200;
const FLIP_MIN_PROFIT = 10000; // 10k silver minimum to show in live feed
const FLIP_COOLDOWN_MS = 120000; // 2 min cooldown per route to prevent spam
const flipCooldowns = {};

// Evict stale flip cooldowns every 10 min
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(flipCooldowns)) {
    if (now - flipCooldowns[key] > 600000) delete flipCooldowns[key];
  }
}, 600000);

let lastFlipValidation = 0;
async function broadcastFlip(flip) {
  // Always validate before broadcasting — queue with rate-limited API calls
  const now = Date.now();
  const waitMs = Math.max(0, 1000 - (now - lastFlipValidation));
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  lastFlipValidation = Date.now();
  try {
    const valid = await validateFlipPrices(flip.itemId, flip.quality, flip.buyCity, flip.sellCity, flip.buyPrice, flip.sellPrice);
    if (!valid) return;
  } catch(e) { /* validation failed — broadcast anyway rather than silencing valid flips */ }

  liveFlips.unshift(flip);
  if (liveFlips.length > MAX_FLIPS) liveFlips.pop();
  const msg = JSON.stringify({ type: 'flip', data: flip });
  for (const wc of wsClients) {
    if (wc.readyState === WebSocket.OPEN && wc.isAuthenticated) {
      wc.send(msg);
    }
  }
}

// Validate flip prices against the live API before broadcasting
async function validateFlipPrices(id, q, buyCity, sellCity, expectedBuyPrice, expectedSellPrice) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const locs = buyCity === sellCity ? encodeURIComponent(buyCity) : [buyCity, sellCity].map(c => encodeURIComponent(c)).join(',');
    const url = `${API_BASE}/${encodeURIComponent(id)}.json?locations=${locs}&qualities=${q}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return true; // Can't verify — allow through

    const data = await res.json();
    let liveBuyPrice = 0, liveSellPrice = 0;
    for (const entry of data) {
      // Buy price = lowest sell offer in buy city (what you'd pay)
      if (entry.city === buyCity && entry.quality === q && entry.sell_price_min > 0) {
        if (liveBuyPrice === 0 || entry.sell_price_min < liveBuyPrice) liveBuyPrice = entry.sell_price_min;
      }
      // Sell price = highest buy order in sell city (what you'd receive)
      if (entry.city === sellCity && entry.quality === q && entry.buy_price_max > 0) {
        if (entry.buy_price_max > liveSellPrice) liveSellPrice = entry.buy_price_max;
      }
    }
    // Listing is gone
    if (liveBuyPrice <= 0 || liveSellPrice <= 0) {
      console.log(`[FlipValidate] ${id} q${q}: listing gone (buy=${liveBuyPrice} sell=${liveSellPrice}), skipping`);
      return false;
    }
    // Price moved significantly (>15% worse)
    if (liveBuyPrice > expectedBuyPrice * 1.15) {
      console.log(`[FlipValidate] ${id} q${q}: buy price moved up ${liveBuyPrice} vs ${expectedBuyPrice}, skipping`);
      return false;
    }
    if (liveSellPrice < expectedSellPrice * 0.85) {
      console.log(`[FlipValidate] ${id} q${q}: sell price moved down ${liveSellPrice} vs ${expectedSellPrice}, skipping`);
      return false;
    }
    // Re-verify profitability with live prices
    const liveProfit = liveSellPrice - liveBuyPrice - (liveSellPrice * TAX_RATE);
    if (liveProfit < FLIP_MIN_PROFIT * 0.5) {
      console.log(`[FlipValidate] ${id} q${q}: live profit only ${Math.floor(liveProfit)}, skipping`);
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(timeoutId);
    return true; // Allow through on timeout/error
  }
}

function detectFlip(id, q) {
  const data = alertMarketDb[id] && alertMarketDb[id][q];
  if (!data) return;

  const now = Date.now();
  const FRESH_MS = 300000; // 5 min general freshness
  const BM_FRESH_MS = 180000; // 3 min for Black Market (orders fill fast, stale prices cause phantom flips)
  let bestSell = { price: Infinity, city: null, date: 0 };
  let bestBuy = { price: 0, city: null, date: 0 };

  for (const [city, cd] of Object.entries(data)) {
    if (cd.sellMin > 0 && cd.sellMin < Infinity && cd.sellMin < bestSell.price) {
      bestSell = { price: cd.sellMin, city, date: cd.sellDate || cd.lastSeen || 0 };
    }
    if (cd.buyMax > 0 && cd.buyMax > bestBuy.price) {
      bestBuy = { price: cd.buyMax, city, date: cd.buyDate || cd.lastSeen || 0 };
    }
  }

  // Outlier check: reject if sell price is suspiciously far from global average
  const gAvg = globalPriceRef[id + '_' + q] || 0;
  if (gAvg > 0 && bestBuy.price > gAvg * 4) return; // >4x global avg is almost certainly stale

  // === Cross-city flips ===
  if (bestSell.city && bestBuy.city && bestSell.city !== bestBuy.city) {
    const sellFresh = bestSell.city === 'Black Market' ? BM_FRESH_MS : FRESH_MS;
    const buyFresh = bestBuy.city === 'Black Market' ? BM_FRESH_MS : FRESH_MS;
    if ((now - bestSell.date) <= sellFresh && (now - bestBuy.date) <= buyFresh) {
      const profit = bestBuy.price - bestSell.price - (bestBuy.price * TAX_RATE);
      if (profit >= FLIP_MIN_PROFIT) {
        const roi = ((profit / bestSell.price) * 100).toFixed(1);
        if (parseFloat(roi) >= 3) {
          const flipKey = id + '_' + q + '_' + bestSell.city + '_' + bestBuy.city;
          if (!flipCooldowns[flipKey] || now - flipCooldowns[flipKey] >= FLIP_COOLDOWN_MS) {
            flipCooldowns[flipKey] = now;
            broadcastFlip({
              id: flipKey, itemId: id, quality: q, name: getFriendlyName(id),
              buyCity: bestSell.city, sellCity: bestBuy.city,
              buyPrice: bestSell.price, sellPrice: bestBuy.price,
              profit: Math.floor(profit), roi: parseFloat(roi),
              type: 'cross-city', detectedAt: now
            });
          }
        }
      }
    }
  }

  // === Same-city instant flips (buy order > sell offer in same city) ===
  for (const [city, cd] of Object.entries(data)) {
    if (!cd.sellMin || cd.sellMin === Infinity || !cd.buyMax || cd.buyMax <= 0) continue;
    if (cd.buyMax <= cd.sellMin) continue; // no margin
    const cityFresh = city === 'Black Market' ? BM_FRESH_MS : FRESH_MS;
    if ((now - (cd.sellDate || 0)) > cityFresh || (now - (cd.buyDate || 0)) > cityFresh) continue;

    const profit = cd.buyMax - cd.sellMin - (cd.buyMax * TAX_RATE);
    if (profit < FLIP_MIN_PROFIT) continue;

    const roi = ((profit / cd.sellMin) * 100).toFixed(1);
    if (parseFloat(roi) < 3) continue;

    const flipKey = id + '_' + q + '_' + city + '_' + city + '_instant';
    if (flipCooldowns[flipKey] && now - flipCooldowns[flipKey] < FLIP_COOLDOWN_MS) continue;
    flipCooldowns[flipKey] = now;

    broadcastFlip({
      id: flipKey, itemId: id, quality: q, name: getFriendlyName(id),
      buyCity: city, sellCity: city,
      buyPrice: cd.sellMin, sellPrice: cd.buyMax,
      profit: Math.floor(profit), roi: parseFloat(roi),
      type: 'instant', detectedAt: now
    });
  }
}

// === ALERTER LOGIC ===
const TAX_RATE = 0.065;
const alertMarketDb = {};
const CITY_NAMES = { 'Thetford': 'Thetford', 'Lymhurst': 'Lymhurst', 'Bridgewatch': 'Bridgewatch', 'Black Market': 'Black Market', 'Caerleon': 'Caerleon', 'Fort Sterling': 'Fort Sterling', 'Martlock': 'Martlock', 'Brecilien': 'Brecilien' };
const API_LOCALE_MAP = { '0': 'Thetford', '7': 'Thetford', '3004': 'Thetford', '3': 'Lymhurst', '1002': 'Lymhurst', '4': 'Bridgewatch', '2004': 'Bridgewatch', '3003': 'Black Market', '3005': 'Caerleon', '3008': 'Fort Sterling', '4000': 'Martlock', '4300': 'Brecilien' };
function getCity(id) { return API_LOCALE_MAP[id] || CITY_NAMES[id] || 'City-'+id; }
const SPECIAL_ITEM_NAMES = { SILVER: 'Silver', GOLD: 'Gold', FAME_CREDIT: 'Fame Credit', FAME_CREDIT_PREMIUM: 'Premium Fame Credit', FACTION_TOKEN: 'Faction Token', SILVER_POUCH: 'Silver Pouch', GOLD_POUCH: 'Gold Pouch', TOME_OF_INSIGHT: 'Tome of Insight', SEASONAL_TOKEN: 'Seasonal Token' };
function getFriendlyName(id) { return itemNames[id] || SPECIAL_ITEM_NAMES[id] || id; }
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

// Diagnostic counters — logged every 10 minutes so we can see what the alerter is doing
let alertStats = { checked: 0, noData: 0, sameCity: 0, stale: 0, noProfit: 0, belowThreshold: 0, lowSamples: 0, liveRejected: 0, cooldown: 0, sent: 0 };
setInterval(() => {
  if (alertStats.checked > 0) {
    console.log(`[Alerter Stats] checked=${alertStats.checked} noData=${alertStats.noData} sameCity=${alertStats.sameCity} stale=${alertStats.stale} noProfit=${alertStats.noProfit} belowThreshold=${alertStats.belowThreshold} lowSamples=${alertStats.lowSamples} liveRejected=${alertStats.liveRejected} cooldown=${alertStats.cooldown} sent=${alertStats.sent}`);
    alertStats = { checked: 0, noData: 0, sameCity: 0, stale: 0, noProfit: 0, belowThreshold: 0, lowSamples: 0, liveRejected: 0, cooldown: 0, sent: 0 };
  }
}, 600000);

// Seed alerter from the periodic server scan so it starts with full market coverage
function seedAlerterFromScan(allPrices) {
  const now = Date.now();
  let seeded = 0, i = 0;
  const BATCH = 5000;

  function processBatch() {
    const end = Math.min(i + BATCH, allPrices.length);
    for (; i < end; i++) {
      const entry = allPrices[i];
      const id = entry.item_id, q = entry.quality || 1, city = entry.city;
      if (!id || !city) continue;
      if (!alertMarketDb[id]) alertMarketDb[id] = {};
      if (!alertMarketDb[id][q]) alertMarketDb[id][q] = {};

      // Use the API's own timestamps for price age display.
      // BUT keep lastSeen = now since the API did return this item (it exists in the order book).
      // sellDate = when the price last changed (honest age for display)
      // lastSeen = when we last verified the listing exists (for filtering)
      const apiSellDate = entry.sell_price_min_date && !entry.sell_price_min_date.startsWith('0001') ? new Date(entry.sell_price_min_date).getTime() : 0;
      const apiBuyDate = entry.buy_price_max_date && !entry.buy_price_max_date.startsWith('0001') ? new Date(entry.buy_price_max_date).getTime() : 0;
      const sellDate = apiSellDate || 0;
      const buyDate = apiBuyDate || 0;

      const existing = alertMarketDb[id][q][city];
      if (!existing) {
        alertMarketDb[id][q][city] = {
          sellMin: entry.sell_price_min || Infinity,
          sellAmount: 0, // API doesn't give per-order amounts; NATS will fill this
          sellDate: sellDate,
          buyMax: entry.buy_price_max || 0,
          buyAmount: 0,
          buyDate: buyDate,
          lastSeen: now
        };
        seeded++;
      } else {
        if (entry.sell_price_min > 0 && (existing.sellMin === Infinity || entry.sell_price_min < existing.sellMin || sellDate > existing.sellDate)) {
          existing.sellMin = entry.sell_price_min;
          existing.sellAmount = 0; // Reset — NATS will populate with real amounts
          existing.sellDate = sellDate;
        }
        if (entry.buy_price_max > 0 && (entry.buy_price_max > existing.buyMax || buyDate > existing.buyDate)) {
          existing.buyMax = entry.buy_price_max;
          existing.buyDate = buyDate;
        }
        existing.lastSeen = now;
      }
    }
    if (i < allPrices.length) {
      setTimeout(processBatch, 10);
    } else {
      console.log(`[Alerter] Seeded with ${seeded} new price points from server scan`);
    }
  }
  processBatch();
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
  if (!alertMarketDb[id] || !alertMarketDb[id][q]) { alertStats.noData++; return; }
  alertStats.checked++;
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

  if (!bestSell.loc || !bestBuy.loc || bestSell.loc === bestBuy.loc) { alertStats.sameCity++; return; }

  // Both sides must be fresh to ensure the spread is real
  const sellFresh = (now - bestSell.date) < FRESHNESS_THRESHOLD;
  const buyFresh = (now - bestBuy.date) < FRESHNESS_THRESHOLD;
  if (!sellFresh || !buyFresh) { alertStats.stale++; return; }

  const profit = bestBuy.price - bestSell.price - (bestBuy.price * TAX_RATE);
  if (profit <= 0) { alertStats.noProfit++; return; }
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
      if (err || !rows || rows.length === 0) { alertStats.belowThreshold++; return; }

      // Short cooldown for live validation to prevent spamming the API on the same route
      const validationKey = `validate_${id}_${q}_${buyCity}_${sellCity}`;
      if (alertCooldowns[validationKey] && now - alertCooldowns[validationKey] < 120000) return; // 2 min cooldown on validation attempts

      // Live price validation — confirm the spread still exists before pinging any channel
      const priceValid = await validatePricesLive(id, q, buyCity, sellCity, bestSell.price, bestBuy.price);
      if (!priceValid) {
        alertStats.liveRejected++;
        alertCooldowns[validationKey] = now; // Don't re-validate this route for 2 min
        console.log(`[Alert] Live validation rejected ${id} q${q} ${buyCity}->${sellCity} (profit was ${Math.floor(profit)})`);
        return;
      }

      rows.forEach(row => {
        const cacheKey = `${id}_${q}_${row.channel_id}`;
        const last = alertCooldowns[cacheKey] || 0;
        const cooldown = row.cooldown_ms || 600000;
        if (now - last < cooldown) { alertStats.cooldown++; return; }

        // Minimum sample threshold — block alerts on near-zero-liquidity items even when min_confidence=0
        if (sampleCount < MIN_SAMPLE_THRESHOLD) {
          alertStats.lowSamples++;
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

        console.log(`[Alert] SENDING: ${friendlyName} q${q} ${buyCity}->${sellCity} profit=${Math.floor(profit)} ROI=${roi}%`);
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

        alertStats.sent++;
        totalAlertsSent++;
        lastAlertTime = now;
      });
    });
  });
}

let dbBusy = false; // Prevents concurrent transaction collisions

// === HISTORICAL SNAPSHOT RECORDING ===
// Writes directly to price_averages (hourly buckets) instead of price_snapshots.
// This eliminates the compaction pipeline and prevents unbounded table growth.
function recordSnapshots(allPrices) {
  if (dbBusy) { console.log('[Snapshots] DB busy, skipping'); return; }
  const now = Date.now();
  const hourStart = Math.floor(now / 3600000) * 3600000;
  const BATCH = 5000;
  let i = 0, count = 0;

  function writeBatch() {
    const end = Math.min(i + BATCH, allPrices.length);
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare(`INSERT INTO price_averages (item_id, quality, city, avg_sell, avg_buy, min_sell, max_buy, sample_count, period_type, period_start)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'hourly', ?)
        ON CONFLICT(item_id, quality, city, period_type, period_start) DO UPDATE SET
          avg_sell = CASE WHEN excluded.avg_sell > 0 THEN excluded.avg_sell ELSE avg_sell END,
          avg_buy = CASE WHEN excluded.avg_buy > 0 THEN excluded.avg_buy ELSE avg_buy END,
          min_sell = CASE WHEN excluded.min_sell > 0 AND (min_sell = 0 OR excluded.min_sell < min_sell) THEN excluded.min_sell ELSE min_sell END,
          max_buy = CASE WHEN excluded.max_buy > max_buy THEN excluded.max_buy ELSE max_buy END,
          sample_count = sample_count + 1`);
      for (; i < end; i++) {
        const entry = allPrices[i];
        if (!entry.item_id || !entry.city) continue;
        const sell = entry.sell_price_min || 0;
        const buy = entry.buy_price_max || 0;
        if (sell <= 0 && buy <= 0) continue;
        stmt.run(entry.item_id, entry.quality || 1, entry.city, sell, buy, sell, buy, hourStart);
        count++;
      }
      stmt.finalize();
      db.run('COMMIT', () => {
        if (i < allPrices.length) {
          setTimeout(writeBatch, 10);
        } else {
          console.log(`[Snapshots] Recorded ${count} prices into price_averages (hourly)`);
        }
      });
    });
  }
  writeBatch();
}

// === SPREAD STATISTICS COMPUTATION (runs hourly) ===
// Queries price_averages (pre-aggregated, ~3M rows) rather than price_snapshots
// (which can grow to 20M+ rows from NATS and OOM the process).
let statsRunning = false;
let statsStartTime = 0;
function computeSpreadStats() {
  // Watchdog: if statsRunning has been true for >20 min, force-reset it
  if (statsRunning) {
    if (Date.now() - statsStartTime > 20 * 60 * 1000) {
      console.error('[SpreadStats] Resetting stuck statsRunning flag after 20min');
      statsRunning = false;
    } else {
      console.log('[SpreadStats] Busy, skipping this cycle');
      return;
    }
  }
  if (dbBusy) { console.log('[SpreadStats] DB busy, skipping this cycle'); return; }
  if (analyticsRunning) { console.log('[SpreadStats] Analytics running, skipping this cycle'); return; }
  statsRunning = true;
  statsStartTime = Date.now();

  const now = Date.now();
  const windowMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const cutoff = now - windowMs;

  const mem = process.memoryUsage();
  console.log(`[SpreadStats] Starting SQL-aggregated computation... RSS: ${Math.round(mem.rss/1024/1024)}MB Heap: ${Math.round(mem.heapUsed/1024/1024)}MB`);

  // Use SQL GROUP BY to aggregate per (item_id, quality, city) over the 7-day window.
  // This produces one row per city instead of one row per hourly period, dramatically
  // reducing the amount of data loaded into JS memory.
  // Uses statsDb (separate connection) so this 90-second query doesn't block
  // the main db queue — otherwise /api/me (5s timeout) would fail during SpreadStats.
  statsDb.all(
    `SELECT item_id, quality, city,
      AVG(CASE WHEN min_sell > 0 THEN min_sell ELSE avg_sell END) AS avg_min_sell,
      AVG(CASE WHEN max_buy  > 0 THEN max_buy  ELSE avg_buy  END) AS avg_max_buy,
      COUNT(*) AS sample_count
     FROM price_averages
     WHERE period_start > ? AND (avg_sell > 0 OR avg_buy > 0)
     GROUP BY item_id, quality, city`,
    [cutoff],
    (err, aggRows) => {
      if (err || !aggRows || aggRows.length === 0) {
        console.log('[SpreadStats] No data to process');
        statsRunning = false;
        return;
      }

      console.log(`[SpreadStats] Processing ${aggRows.length} aggregated city rows...`);

      // Group by item_id + quality → map of city → { minSell, maxBuy, samples }
      const itemMap = {};
      for (const r of aggRows) {
        const key = r.item_id + '_' + r.quality;
        if (!itemMap[key]) itemMap[key] = { item_id: r.item_id, quality: r.quality, cities: {} };
        itemMap[key].cities[r.city] = {
          minSell: r.avg_min_sell || 0,
          maxBuy:  r.avg_max_buy  || 0,
          samples: r.sample_count
        };
      }
      aggRows.length = 0; // free memory

      const itemKeys = Object.keys(itemMap);
      let processed = 0;
      let statsWritten = 0;
      const WRITE_BATCH = 500;
      let writeBuf = [];

      function flushWrites() {
        if (writeBuf.length === 0) return;
        const batch = writeBuf.splice(0);
        // Use statsDb so these 500-row transactions don't queue behind main db operations
        statsDb.serialize(() => {
          statsDb.run('BEGIN TRANSACTION');
          const stmt = statsDb.prepare(`INSERT OR REPLACE INTO spread_stats (item_id, quality, buy_city, sell_city, avg_spread, median_spread, consistency_pct, sample_count, window_days, confidence_score, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const r of batch) stmt.run(...r);
          stmt.finalize();
          statsDb.run('COMMIT');
        });
        statsWritten += batch.length;
      }

      function processBatch(startIdx) {
        const endIdx = Math.min(startIdx + 200, itemKeys.length);
        if (startIdx >= itemKeys.length) {
          flushWrites();
          const mem2 = process.memoryUsage();
          console.log(`[SpreadStats] Done. Processed ${processed} items, wrote ${statsWritten} spread stats. RSS: ${Math.round(mem2.rss/1024/1024)}MB`);
          statsRunning = false;
          return;
        }

        for (let idx = startIdx; idx < endIdx; idx++) {
          const { item_id, quality, cities } = itemMap[itemKeys[idx]];
          delete itemMap[itemKeys[idx]]; // release memory as we go

          const cityNames = Object.keys(cities);

          for (let i = 0; i < cityNames.length; i++) {
            for (let j = 0; j < cityNames.length; j++) {
              if (i === j) continue;
              const buyCity  = cityNames[i];
              const sellCity = cityNames[j];
              if (buyCity === 'Black Market') continue;

              const buyData  = cities[buyCity];
              const sellData = cities[sellCity];
              const buyCost     = buyData.minSell;
              const sellRevenue = sellData.maxBuy;
              if (buyCost <= 0 || sellRevenue <= 0) continue;

              // sample_count is the number of hourly periods that contributed to the aggregate.
              // Use the lesser of the two cities so we only count cycles where both had data.
              const samples = Math.min(buyData.samples, sellData.samples);
              if (samples < 3) continue;

              const spread = sellRevenue - buyCost - (sellRevenue * TAX_RATE);

              // Estimate consistency from sample count (168h per week max).
              // Without per-cycle rows we can't compute exact positive-cycle %, but
              // a positive average spread strongly implies consistent profitability.
              const consistencyPct = spread > 0
                ? Math.min(85, 40 + (samples / 168) * 45)
                : Math.max(15, 40 - (samples / 168) * 25);

              const sampleScore = Math.min(samples, 100) / 100 * 30;
              const consistScore = consistencyPct * 0.5;
              const spreadScore  = Math.min(Math.max(spread, 0), 500000) / 500000 * 20;
              const confidence   = Math.round(Math.min(100, sampleScore + consistScore + spreadScore));

              writeBuf.push([item_id, quality, buyCity, sellCity, Math.round(spread), Math.round(Math.max(spread, 0)), Math.round(consistencyPct * 10) / 10, samples, 7, confidence, now]);
            }
          }
          processed++;

          if (writeBuf.length >= WRITE_BATCH) flushWrites();
        }

        // Yield to event loop between batches so Express can still serve requests
        setTimeout(() => processBatch(endIdx), 50);
      }

      processBatch(0);
    }
  );
}

// Run stats computation hourly, first run 10 minutes after start (after backfill)
setTimeout(computeSpreadStats, 10 * 60 * 1000);
setInterval(computeSpreadStats, 60 * 60 * 1000);

// === WAL CHECKPOINT (every 6 hours) ===
// Prevents the WAL file from growing unbounded on a write-heavy database.
function runWalCheckpoint() {
  if (dbBusy) return;
  db.run('PRAGMA wal_checkpoint(TRUNCATE)', (err) => {
    if (err) console.error('[WAL] Checkpoint error:', err.message);
    else console.log('[WAL] Checkpoint (TRUNCATE) complete');
  });
}
setInterval(runWalCheckpoint, 6 * 60 * 60 * 1000);

// === VACUUM HELPERS ===
// Only schedule a VACUUM if a meaningful amount of data was just deleted.
// VACUUM reclaims disk pages but locks the DB, so we run it during 2-4 AM UTC.
const VACUUM_ROW_THRESHOLD = 100000; // ~500 MB heuristic at ~5 KB/row average

function msUntilUtcHour(targetHour) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetHour, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

let vacuumScheduled = false; // prevent stacking multiple scheduled VACUUMs

function runVacuum() {
  vacuumScheduled = false;
  if (dbBusy) { setTimeout(runVacuum, 30 * 60 * 1000); return; }
  console.log('[VACUUM] Running VACUUM to reclaim disk space...');
  db.run('VACUUM', (err) => {
    if (err) console.error('[VACUUM] Error:', err.message);
    else console.log('[VACUUM] Complete — disk space reclaimed');
  });
}

function scheduleVacuumIfNeeded(rowsDeleted) {
  if (rowsDeleted < VACUUM_ROW_THRESHOLD || vacuumScheduled) return;
  const utcHour = new Date().getUTCHours();
  if (utcHour >= 2 && utcHour < 4) {
    console.log(`[VACUUM] ${rowsDeleted} rows deleted — running VACUUM now (low-traffic window)`);
    vacuumScheduled = true;
    setTimeout(runVacuum, 0);
  } else {
    const delay = msUntilUtcHour(2);
    console.log(`[VACUUM] ${rowsDeleted} rows deleted — VACUUM scheduled for next 2 AM UTC (~${Math.round(delay/3600000)}h)`);
    vacuumScheduled = true;
    setTimeout(runVacuum, delay);
  }
}

// === DATA COMPACTION (runs every 2 hours) ===
// Three-tier retention:
//   Tier 1: price_averages hourly  → keep rawRetentionDays (default 7)
//   Tier 2: price_hourly (OHLC)    → keep 30 days
//   Tier 3: price_averages daily   → keep forever
function compactOldData(rawRetentionDays) {
  const keepRawDays = rawRetentionDays || 7;
  const now = Date.now();
  const rawCutoff    = now - keepRawDays * 24 * 60 * 60 * 1000;
  const hourlyCutoff = now - 30 * 24 * 60 * 60 * 1000;

  console.log(`[Compaction] Starting (raw retention: ${keepRawDays}d)...`);

  // === TIER 1→2: Migrate price_averages hourly older than rawCutoff into price_hourly ===
  db.all(
    `SELECT item_id, quality, city,
      strftime('%Y-%m-%dT%H', datetime(period_start/1000, 'unixepoch')) as hour,
      avg_sell as open_price,
      avg_sell as high_price,
      CASE WHEN min_sell > 0 THEN min_sell ELSE avg_sell END as low_price,
      avg_sell as close_price,
      avg_sell as avg_price,
      sample_count as volume
    FROM price_averages
    WHERE period_type = 'hourly' AND period_start < ?`,
    [rawCutoff],
    (err, rows) => {
      if (err) { console.error('[Compaction] Tier1→2 error:', err.message); return; }
      if (!rows || rows.length === 0) {
        console.log('[Compaction] No hourly rows to migrate');
      } else {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare(`INSERT OR IGNORE INTO price_hourly (item_id, city, quality, hour, open_price, high_price, low_price, close_price, avg_price, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const r of rows) {
            stmt.run(r.item_id, r.city, r.quality, r.hour, r.open_price, r.high_price, r.low_price, r.close_price, r.avg_price, r.volume);
          }
          stmt.finalize();
          db.run('COMMIT', () => {
            db.run(`DELETE FROM price_averages WHERE period_type = 'hourly' AND period_start < ?`, [rawCutoff], function(err2) {
              const deleted = this.changes || 0;
              if (!err2) console.log(`[Compaction] Tier1→2: migrated ${rows.length} rows to price_hourly, deleted ${deleted} raw rows`);
              scheduleVacuumIfNeeded(deleted);
            });
          });
        });
      }

      // === TIER 2→3: Roll price_hourly older than 30 days into price_averages daily ===
      // SQLite strftime comparison: convert hourlyCutoff ms to ISO hour string
      const hourlyCutoffSec = Math.floor(hourlyCutoff / 1000);
      const hourlyCutoffStr = new Date(hourlyCutoff).toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
      db.all(
        `SELECT item_id, city, quality,
          CAST(strftime('%s', hour || ':00:00') AS INTEGER) / 86400 * 86400000 as day_start,
          AVG(avg_price) as avg_sell,
          AVG(avg_price) as avg_buy,
          MIN(low_price) as min_sell,
          MAX(high_price) as max_buy,
          SUM(volume) as cnt
        FROM price_hourly
        WHERE hour < ?
        GROUP BY item_id, city, quality, day_start`,
        [hourlyCutoffStr],
        (errH, hrows) => {
          if (errH) { console.error('[Compaction] Tier2→3 error:', errH.message); return; }
          if (!hrows || hrows.length === 0) { console.log('[Compaction] No price_hourly rows to roll into daily'); return; }

          db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            const stmt2 = db.prepare(`INSERT OR REPLACE INTO price_averages (item_id, quality, city, avg_sell, avg_buy, min_sell, max_buy, sample_count, period_type, period_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'daily', ?)`);
            for (const r of hrows) {
              stmt2.run(r.item_id, r.quality, r.city, Math.round(r.avg_sell), Math.round(r.avg_buy), r.min_sell || 0, r.max_buy || 0, r.cnt, r.day_start);
            }
            stmt2.finalize();
            db.run('COMMIT', () => {
              db.run(`DELETE FROM price_hourly WHERE hour < ?`, [hourlyCutoffStr], function(err3) {
                const deletedH = this.changes || 0;
                if (!err3) console.log(`[Compaction] Tier2→3: compacted ${hrows.length} daily rows, deleted ${deletedH} price_hourly rows`);
                scheduleVacuumIfNeeded(deletedH);
              });
            });
          });
        }
      );
    }
  );

  // Prune spread_stats rows older than 14 days
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  db.run(`DELETE FROM spread_stats WHERE updated_at < ?`, [fourteenDaysAgo], (err) => {
    if (!err) console.log('[Compaction] Pruned spread_stats rows older than 14 days');
  });

  // Clean up old contributions (keep 60 days)
  const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;
  db.run(`DELETE FROM contributions WHERE created_at < ?`, [sixtyDaysAgo]);
}

// === DISK SAFETY CHECK (runs alongside compaction every 2 hours) ===
// Prevents SQLite DB from growing unbounded. Adaptive retention based on DB size.
const DB_WARN_GB  = 10;
const DB_EMERG_GB = 20;

function checkDiskUsage() {
  db.get(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`, (err, row) => {
    if (err || !row) return;
    const sizeBytes = row.size;
    const sizeGB = sizeBytes / (1024 * 1024 * 1024);
    const sizeMB = sizeBytes / (1024 * 1024);

    if (sizeGB >= DB_EMERG_GB) {
      console.error(`[DiskSafety] EMERGENCY: DB is ${sizeGB.toFixed(1)}GB (>${DB_EMERG_GB}GB). Emergency compact: 1 day raw retention`);
      compactOldData(1);
    } else if (sizeGB >= DB_WARN_GB) {
      console.warn(`[DiskSafety] WARNING: DB is ${sizeGB.toFixed(1)}GB (>${DB_WARN_GB}GB). Aggressive compact: 3 day raw retention`);
      compactOldData(3);
    } else {
      console.log(`[DiskSafety] DB size: ${sizeMB.toFixed(0)}MB — OK`);
    }
  });
}

// Run compaction every 2 hours, first run 25 minutes after start
// STAGGERED: SpreadStats runs at 10min+hourly, compaction at 25min+2h — they never overlap
setTimeout(() => { checkDiskUsage(); compactOldData(); }, 25 * 60 * 1000);
setInterval(() => { checkDiskUsage(); compactOldData(); }, 2 * 60 * 60 * 1000);

// === ANALYTICS COMPUTATION ENGINE ===
// Computes SMA 7d, SMA 30d, EMA 7d, VWAP 7d, price_trend, spread_volatility
// per active item+city+quality combo. Runs every 30 minutes.
let analyticsRunning = false;
let analyticsStartTime = 0;

function computeAnalytics() {
  if (analyticsRunning) {
    if (Date.now() - analyticsStartTime > 25 * 60 * 1000) {
      console.error('[Analytics] Resetting stuck analyticsRunning flag after 25min');
      analyticsRunning = false;
    } else {
      console.log('[Analytics] Busy, skipping this cycle');
      return;
    }
  }
  if (dbBusy) { console.log('[Analytics] DB busy, skipping'); return; }
  if (statsRunning) { console.log('[Analytics] SpreadStats running, skipping this cycle'); return; }
  analyticsRunning = true;
  analyticsStartTime = Date.now();

  const now = Date.now();
  const sevenDaysAgo  = now - 7  * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const oneDayAgo     = now - 24 * 60 * 60 * 1000;
  const computedAt    = new Date(now).toISOString();

  console.log('[Analytics] Starting computation...');

  // === STEP 1: Bulk SQL metrics (SMA 7d, SMA 30d, VWAP 7d, price_trend, spread_volatility) ===
  // Use statsDb to avoid blocking the main db connection during heavy reads
  statsDb.all(
    `SELECT item_id, city, quality,
      AVG(CASE WHEN avg_sell > 0 THEN avg_sell ELSE NULL END) AS sma_7d,
      AVG(CASE WHEN avg_sell > 0 THEN avg_sell * sample_count ELSE NULL END) /
        NULLIF(AVG(CASE WHEN avg_sell > 0 THEN sample_count ELSE NULL END), 0) AS vwap_7d,
      AVG(CASE WHEN period_start > ? AND avg_sell > 0 THEN avg_sell ELSE NULL END) AS avg_24h,
      COUNT(CASE WHEN avg_sell > 0 THEN 1 ELSE NULL END) AS data_points_7d,
      SUM(CASE WHEN min_sell > 0 AND max_buy > 0 THEN (min_sell - max_buy) ELSE NULL END) AS sum_spread,
      SUM(CASE WHEN min_sell > 0 AND max_buy > 0 THEN (min_sell - max_buy) * (min_sell - max_buy) ELSE NULL END) AS sum_spread_sq,
      COUNT(CASE WHEN min_sell > 0 AND max_buy > 0 THEN 1 ELSE NULL END) AS spread_count
    FROM price_averages
    WHERE period_start > ? AND (avg_sell > 0 OR avg_buy > 0)
    GROUP BY item_id, city, quality
    HAVING data_points_7d >= 2`,
    [oneDayAgo, sevenDaysAgo],
    (err, rows7d) => {
      if (err) {
        console.error('[Analytics] 7d query FAILED:', err.message || err);
        analyticsRunning = false;
        return;
      }
      if (!rows7d || rows7d.length === 0) {
        console.log('[Analytics] No 7d data yet, skipping');
        analyticsRunning = false;
        return;
      }
      // Build lookup for 7d results keyed by item_id|city|quality
      const map7d = {};
      for (const r of rows7d) {
        map7d[r.item_id + '|' + r.city + '|' + r.quality] = r;
      }

      // SMA 30d — separate query since it spans a different time window
      statsDb.all(
        `SELECT item_id, city, quality,
          AVG(CASE WHEN avg_sell > 0 THEN avg_sell ELSE NULL END) AS sma_30d
        FROM price_averages
        WHERE period_start > ? AND (avg_sell > 0 OR avg_buy > 0)
        GROUP BY item_id, city, quality`,
        [thirtyDaysAgo],
        (err2, rows30d) => {
          if (err2) { console.error('[Analytics] 30d query FAILED:', err2.message || err2); analyticsRunning = false; return; }

          const map30d = {};
          for (const r of rows30d || []) {
            map30d[r.item_id + '|' + r.city + '|' + r.quality] = r.sma_30d;
          }

          // === STEP 2: Write bulk metrics (all except EMA) ===
          const bulkResults = []; // [ [item_id, city, quality, metric, value, computedAt], ... ]
          const combos = Object.keys(map7d);

          for (const key of combos) {
            const r = map7d[key];
            const [item_id, city, quality] = key.split('|');
            const q = parseInt(quality);

            if (r.sma_7d > 0) bulkResults.push([item_id, city, q, 'sma_7d', r.sma_7d, computedAt]);

            const sma30 = map30d[key];
            if (sma30 > 0) bulkResults.push([item_id, city, q, 'sma_30d', sma30, computedAt]);

            if (r.vwap_7d > 0) bulkResults.push([item_id, city, q, 'vwap_7d', r.vwap_7d, computedAt]);

            // Price trend: ((24h avg - sma_7d) / sma_7d) * 100
            if (r.avg_24h > 0 && r.sma_7d > 0) {
              const trend = ((r.avg_24h - r.sma_7d) / r.sma_7d) * 100;
              bulkResults.push([item_id, city, q, 'price_trend', trend, computedAt]);
            }

            // Spread volatility: sqrt(sum_sq/n - (sum/n)^2)
            if (r.spread_count >= 2) {
              const mean = r.sum_spread / r.spread_count;
              const variance = (r.sum_spread_sq / r.spread_count) - (mean * mean);
              const stddev = variance > 0 ? Math.sqrt(variance) : 0;
              bulkResults.push([item_id, city, q, 'spread_volatility', stddev, computedAt]);
            }
          }

          // Flush bulk results in transaction
          function flushBulk(results, cb) {
            if (results.length === 0) return cb();
            statsDb.serialize(() => {
              statsDb.run('BEGIN TRANSACTION');
              const stmt = statsDb.prepare(`INSERT OR REPLACE INTO price_analytics (item_id, city, quality, metric, value, computed_at) VALUES (?, ?, ?, ?, ?, ?)`);
              for (const row of results) stmt.run(...row);
              stmt.finalize();
              statsDb.run('COMMIT', cb);
            });
          }

          flushBulk(bulkResults, () => {
            console.log(`[Analytics] Wrote ${bulkResults.length} bulk metrics (SMA/VWAP/trend/volatility)`);

            // === STEP 3: EMA 7d — batched per combo (needs ordered price series) ===
            // α = 2/(7+1) = 0.25 for a 7-period EMA
            const EMA_ALPHA = 0.25;
            const BATCH_SIZE = 100;
            let batchIdx = 0;
            let emaWritten = 0;

            function processEmaBatch() {
              const end = Math.min(batchIdx + BATCH_SIZE, combos.length);
              if (batchIdx >= combos.length) {
                const elapsed = Math.round((Date.now() - analyticsStartTime) / 1000);
                console.log(`[Analytics] Done. EMA rows written: ${emaWritten}. Total time: ${elapsed}s`);
                analyticsRunning = false;
                return;
              }

              const batchCombos = combos.slice(batchIdx, end);
              batchIdx = end;

              // Build IN clause using concatenated key (compatible with all SQLite versions)
              const placeholders = batchCombos.map(() => '?').join(',');

              statsDb.all(
                `SELECT item_id, city, quality, avg_sell
                FROM price_averages
                WHERE period_start > ?
                  AND avg_sell > 0
                  AND (item_id || '|' || city || '|' || quality) IN (${placeholders})
                ORDER BY item_id, city, quality, period_start ASC`,
                [sevenDaysAgo, ...batchCombos],
                (errEma, priceRows) => {
                  if (errEma || !priceRows || priceRows.length === 0) {
                    setTimeout(processEmaBatch, 20);
                    return;
                  }

                  // Group rows by combo key and compute EMA
                  const emaResults = [];
                  let curKey = null, curPrices = [];

                  function computeEmaForKey(key, prices) {
                    if (prices.length === 0) return;
                    let ema = prices[0].avg_sell;
                    for (let i = 1; i < prices.length; i++) {
                      ema = EMA_ALPHA * prices[i].avg_sell + (1 - EMA_ALPHA) * ema;
                    }
                    const [ii, cc, qq] = key.split('|');
                    emaResults.push([ii, cc, parseInt(qq), 'ema_7d', ema, computedAt]);
                  }

                  for (const pr of priceRows) {
                    const k = pr.item_id + '|' + pr.city + '|' + pr.quality;
                    if (k !== curKey) {
                      if (curKey) computeEmaForKey(curKey, curPrices);
                      curKey = k;
                      curPrices = [pr];
                    } else {
                      curPrices.push(pr);
                    }
                  }
                  if (curKey) computeEmaForKey(curKey, curPrices);

                  if (emaResults.length === 0) {
                    setTimeout(processEmaBatch, 20);
                    return;
                  }

                  statsDb.serialize(() => {
                    statsDb.run('BEGIN TRANSACTION');
                    const stmt = statsDb.prepare(`INSERT OR REPLACE INTO price_analytics (item_id, city, quality, metric, value, computed_at) VALUES (?, ?, ?, ?, ?, ?)`);
                    for (const row of emaResults) stmt.run(...row);
                    stmt.finalize();
                    statsDb.run('COMMIT', () => {
                      emaWritten += emaResults.length;
                      setTimeout(processEmaBatch, 30); // yield to event loop
                    });
                  });
                }
              );
            }

            processEmaBatch();
          });
        }
      );
    }
  );
}

// Run analytics every 30 minutes; first run 35 minutes after start (after spread stats)
// STAGGERED: SpreadStats @10min, Compaction @25min, Analytics @35min
setTimeout(computeAnalytics, 35 * 60 * 1000);
setInterval(computeAnalytics, 30 * 60 * 1000);

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
        const stmt = db.prepare(`INSERT OR IGNORE INTO price_averages (item_id, quality, city, avg_sell, avg_buy, min_sell, max_buy, sample_count, period_type, period_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const r of rows) {
          // Charts/History API returns transaction averages — use for both sell and buy
          const price = r.avg_sell;
          stmt.run(r.item_id, r.quality, r.city, price, price, price, price, r.count, periodType, r.period_start);
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
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
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
    // Very gentle backfill: 1s pause between chunks
    if (i + CHUNK_SIZE < itemIds.length) await new Promise(r => setTimeout(r, 1000));
    if (i % 1000 === 0 && i > 0) console.log(`[Backfill] Charts progress: ${i}/${itemIds.length} items`);
  }
  console.log(`[Backfill] Charts API: inserted ${dailyCount} daily averages`);

  // Phase B: History API (6-hour granularity, more recent data)
  let hourlyCount = 0;
  for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
    const chunk = itemIds.slice(i, i + CHUNK_SIZE);
    try {
      const url = `${HISTORY_BASE}/${chunk.join(',')}.json?time-scale=6`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
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
    // Very gentle backfill: 1s pause between chunks
    if (i + CHUNK_SIZE < itemIds.length) await new Promise(r => setTimeout(r, 1000));
    if (i % 1000 === 0 && i > 0) console.log(`[Backfill] History progress: ${i}/${itemIds.length} items`);
  }

  console.log(`[Backfill] History API: inserted ${hourlyCount} hourly averages`);
  dbBusy = false;
  console.log(`[Backfill] Complete! Total: ${dailyCount} daily + ${hourlyCount} hourly records`);

  // Trigger a spread stats computation right after backfill
  setTimeout(computeSpreadStats, 5000);
}

// Start backfill 30 minutes after boot (after first scan is long finished and server is stable)
setTimeout(backfillHistoricalData, 30 * 60 * 1000);

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
  const hourStart = Math.floor(now / 3600000) * 3600000;

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare(`INSERT INTO price_averages (item_id, quality, city, avg_sell, avg_buy, min_sell, max_buy, sample_count, period_type, period_start)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'hourly', ?)
      ON CONFLICT(item_id, quality, city, period_type, period_start) DO UPDATE SET
        avg_sell = CASE WHEN excluded.avg_sell > 0 THEN excluded.avg_sell ELSE avg_sell END,
        avg_buy = CASE WHEN excluded.avg_buy > 0 THEN excluded.avg_buy ELSE avg_buy END,
        min_sell = CASE WHEN excluded.min_sell > 0 AND (min_sell = 0 OR excluded.min_sell < min_sell) THEN excluded.min_sell ELSE min_sell END,
        max_buy = CASE WHEN excluded.max_buy > max_buy THEN excluded.max_buy ELSE max_buy END,
        sample_count = sample_count + 1`);
    for (const e of batch) {
      const sell = e.sell || 0;
      const buy = e.buy || 0;
      if (sell <= 0 && buy <= 0) continue;
      stmt.run(e.item_id, e.quality, e.city, sell, buy, sell, buy, hourStart);
    }
    stmt.finalize();
    db.run('COMMIT', () => {
      if (batch.length > 50) console.log('[NATS] Flushed ' + batch.length + ' prices into price_averages');
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
      for(let wc of wsClients) if(wc.readyState === WebSocket.OPEN && wc.clientType !== 'game-client') wc.send(strData);

      try {
        const payloads = JSON.parse(strData);
        for (const p of payloads) {
          if (!p.ItemTypeId || !p.LocationId || !p.UnitPriceSilver) continue;
          const id = p.ItemTypeId, q = p.QualityLevel || 1, loc = p.LocationId, price = p.UnitPriceSilver;
          const city = API_LOCALE_MAP[loc];
          if (!city) continue;

          if (!alertMarketDb[id]) alertMarketDb[id] = {};
          if (!alertMarketDb[id][q]) alertMarketDb[id][q] = {};
          if (!alertMarketDb[id][q][city]) alertMarketDb[id][q][city] = { sellMin: Infinity, sellAmount: 0, buyMax: 0, buyAmount: 0, sellDate: 0, buyDate: 0 };

          const now = Date.now();
          const amount = p.Amount || 1;
          alertMarketDb[id][q][city].lastSeen = now;

          if (p.AuctionType === 'offer') {
            if (price < alertMarketDb[id][q][city].sellMin) {
              // New best price — reset amount
              alertMarketDb[id][q][city].sellMin = price;
              alertMarketDb[id][q][city].sellAmount = amount;
              alertMarketDb[id][q][city].sellDate = now;
            } else if (price === alertMarketDb[id][q][city].sellMin) {
              // Same price — accumulate amount (multiple orders at same price)
              alertMarketDb[id][q][city].sellAmount += amount;
            }
          } else if (p.AuctionType === 'request') {
            if (price > alertMarketDb[id][q][city].buyMax) {
              alertMarketDb[id][q][city].buyMax = price;
              alertMarketDb[id][q][city].buyAmount = amount;
              alertMarketDb[id][q][city].buyDate = now;
            } else if (price === alertMarketDb[id][q][city].buyMax) {
              alertMarketDb[id][q][city].buyAmount += amount;
            }
          }

          // Buffer for snapshot recording — deduplicated per item/quality/city
          const snapKey = id + '_' + q + '_' + city;
          if (!natsSnapshotMap[snapKey]) natsSnapshotMap[snapKey] = { item_id: id, quality: q, city: city, sell: 0, buy: 0 };
          if (p.AuctionType === 'offer' && (natsSnapshotMap[snapKey].sell === 0 || price < natsSnapshotMap[snapKey].sell)) {
            natsSnapshotMap[snapKey].sell = price;
          } else if (p.AuctionType === 'request' && price > natsSnapshotMap[snapKey].buy) {
            natsSnapshotMap[snapKey].buy = price;
          }

          // Check for alerts and live flips on this item
          checkAndAlert(id, q);
          detectFlip(id, q);
        }
      } catch(e) { console.error('[NATS] Parse error:', e.message); }
    }
  } catch(err){ console.error('[NATS] Connection failed:', err); }
})();

// === GLOBAL ERROR HANDLERS ===
// Prevent uncaught errors from silently breaking scan/stats loops
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  // Reset flags so loops can recover
  scanInProgress = false;
  statsRunning = false;
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  scanInProgress = false;
  statsRunning = false;
});

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

// Log memory usage periodically for diagnostics
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`[Memory] RSS: ${Math.round(mem.rss/1024/1024)}MB Heap: ${Math.round(mem.heapUsed/1024/1024)}/${Math.round(mem.heapTotal/1024/1024)}MB External: ${Math.round(mem.external/1024/1024)}MB`);
}, 10 * 60 * 1000);

server.listen(443, () => console.log('SaaS Backend (Express + Discord + WSS + Market Cache) listening on 443!'));

// HTTP → HTTPS redirect on port 80
require('http').createServer((req, res) => {
  res.writeHead(301, { Location: `https://${domain}${req.url}` });
  res.end();
}).listen(80, () => console.log('HTTP redirect listening on 80'));
"""
    # Use SFTP for backend.js — base64 via echo truncates at ~100KB
    sftp = ssh.open_sftp()
    with sftp.file('/opt/albion-saas/backend.js', 'w') as f:
        f.write(backend_js)
    sftp.close()
    print(f"Uploaded backend.js ({len(backend_js)} bytes via SFTP)")

    # Write env file with restricted permissions
    game_server = os.environ.get('GAME_SERVER', 'europe')
    smtp_host = os.environ.get('SMTP_HOST', '')
    smtp_port = os.environ.get('SMTP_PORT', '587')
    smtp_user = os.environ.get('SMTP_USER', '')
    smtp_pass = os.environ.get('SMTP_PASS', '')
    smtp_from = os.environ.get('SMTP_FROM', 'noreply@albionaitool.xyz')
    feedback_webhook = os.environ.get('DISCORD_FEEDBACK_WEBHOOK', '')
    env_content = f"""DOMAIN={domain}
DISCORD_CLIENT_ID={CLIENT_ID}
DISCORD_CLIENT_SECRET={CLIENT_SECRET}
DISCORD_BOT_TOKEN={BOT_TOKEN}
DISCORD_FEEDBACK_WEBHOOK={feedback_webhook}
SESSION_SECRET={session_secret}
GAME_SERVER={game_server}
SMTP_HOST={smtp_host}
SMTP_PORT={smtp_port}
SMTP_USER={smtp_user}
SMTP_PASS={smtp_pass}
SMTP_FROM={smtp_from}
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
ExecStart=/usr/bin/node --max-old-space-size=6144 /opt/albion-saas/backend.js
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
