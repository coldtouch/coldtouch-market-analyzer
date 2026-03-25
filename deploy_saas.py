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
    
    # Generate a strong random session secret
    import secrets
    session_secret = secrets.token_hex(32)

    backend_js = """
const express = require('express');
const session = require('express-session');
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

const API_BASE = 'https://west.albion-online-data.com/api/v2/stats/prices';
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
  // Migrate: add cooldown_ms column if missing
  db.run(`ALTER TABLE alerts ADD COLUMN cooldown_ms INTEGER DEFAULT 600000`, () => {});
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
      { name: 'cooldown', type: 4, description: 'Minutes between alerts for the same item (default: 10)', required: false }
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
    db.run(`INSERT OR REPLACE INTO alerts (guild_id, channel_id, min_profit, cooldown_ms) VALUES (?, ?, ?, ?)`,
      [interaction.guildId, interaction.channelId, minP, cooldownMs], (err) => {
      if(err) return interaction.reply({content: 'DB Error :(', ephemeral: true});
      interaction.reply({ embeds: [{
        title: 'Alerts Configured',
        color: 0x00ff00,
        fields: [
          { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
          { name: 'Min Profit', value: `${minP.toLocaleString()} silver`, inline: true },
          { name: 'Cooldown', value: `${cooldown} min per item`, inline: true }
        ],
        footer: { text: 'Coldtouch Market Analyzer' }
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
    db.all(`SELECT channel_id, min_profit, cooldown_ms FROM alerts WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
      if (err || !rows || rows.length === 0) {
        return interaction.reply({ embeds: [{
          title: 'No Active Alerts',
          color: 0x888888,
          description: 'Use `/setup_alerts` to configure alerts in a channel.',
          footer: { text: 'Coldtouch Market Analyzer' }
        }], ephemeral: true });
      }
      const lines = rows.map(r => `<#${r.channel_id}> — min **${r.min_profit.toLocaleString()}** silver, cooldown **${Math.round((r.cooldown_ms || 600000) / 60000)}** min`);
      interaction.reply({ embeds: [{
        title: `Active Alerts (${rows.length})`,
        color: 0xffd700,
        description: lines.join('\\n'),
        footer: { text: 'Coldtouch Market Analyzer' }
      }], ephemeral: true });
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
});

client.login(BOT_TOKEN);

// === EXPRESS APP ===
const app = express();
app.use(cors({ origin: 'https://coldtouch.github.io', credentials: true }));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none'
  }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  callbackURL: `https://${domain}/auth/discord/callback`,
  scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
  db.run(`INSERT OR REPLACE INTO users (id, username, avatar) VALUES (?, ?, ?)`, [profile.id, profile.username, profile.avatar]);
  return done(null, profile);
}));

app.use(passport.initialize());
app.use(passport.session());

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
  res.redirect(`https://coldtouch.github.io/coldtouch-market-analyzer?login=success`);
});

app.get('/api/me', (req, res) => {
  if(req.user) res.json({ loggedIn: true, user: req.user });
  else res.json({ loggedIn: false });
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
    scanning: scanInProgress
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

const alertCooldowns = {};
const FRESHNESS_THRESHOLD = 30 * 60 * 1000; // 30 min — data must be this fresh to trigger alerts

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

  // At least one side must be fresh (updated within threshold)
  const sellFresh = (now - bestSell.date) < FRESHNESS_THRESHOLD;
  const buyFresh = (now - bestBuy.date) < FRESHNESS_THRESHOLD;
  if (!sellFresh && !buyFresh) return;

  const profit = bestBuy.price - bestSell.price - (bestBuy.price * TAX_RATE);
  if (profit <= 0) return;
  const roi = ((profit / bestSell.price) * 100).toFixed(1);

  const buyAge = Math.round((now - bestSell.date) / 60000);
  const sellAge = Math.round((now - bestBuy.date) / 60000);
  const freshLabel = (mins) => mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago' : Math.floor(mins/60) + 'h ago';

  db.all(`SELECT channel_id, cooldown_ms FROM alerts WHERE min_profit <= ?`, [profit], (err, rows) => {
    if (err || !rows) return;
    rows.forEach(row => {
      const cacheKey = `${id}_${q}_${row.channel_id}`;
      const last = alertCooldowns[cacheKey] || 0;
      const cooldown = row.cooldown_ms || 600000;
      if (now - last < cooldown) return;

      alertCooldowns[cacheKey] = now;
      const channel = client.channels.cache.get(row.channel_id);
      if (!channel) return;

      const qualName = getQualityName(q);
      const friendlyName = getFriendlyName(id);
      const thumbnailUrl = `https://render.albiononline.com/v1/item/${id}.png?quality=${q}`;

      channel.send({
        embeds: [{
          title: `${friendlyName}`,
          color: profit > 500000 ? 0xff4500 : profit > 100000 ? 0xffd700 : 0x00ff00,
          thumbnail: { url: thumbnailUrl },
          fields: [
            { name: 'Profit', value: `**${Math.floor(profit).toLocaleString()}** silver (${roi}% ROI)`, inline: false },
            { name: 'Buy From', value: `**${getCity(bestSell.loc)}**\\n${Math.floor(bestSell.price).toLocaleString()} silver\\n${freshLabel(buyAge)}`, inline: true },
            { name: 'Sell To', value: `**${getCity(bestBuy.loc)}**\\n${Math.floor(bestBuy.price).toLocaleString()} silver\\n${freshLabel(sellAge)}`, inline: true },
            { name: 'Quality', value: qualName, inline: true }
          ],
          footer: { text: `Coldtouch Market Analyzer` },
          timestamp: new Date().toISOString(),
          url: SITE_URL
        }]
      }).catch(e => console.error('[Alert] Failed to send:', e.message));

      totalAlertsSent++;
      lastAlertTime = now;
    });
  });
}

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
    env_content = f"""DOMAIN={domain}
DISCORD_CLIENT_ID={CLIENT_ID}
DISCORD_CLIENT_SECRET={CLIENT_SECRET}
DISCORD_BOT_TOKEN={BOT_TOKEN}
SESSION_SECRET={session_secret}
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
