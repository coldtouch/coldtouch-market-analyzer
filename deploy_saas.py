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
    
    backend_js = """
const express = require('express');
const session = require('express-session');
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

const domain = 'REPLACE_DOMAIN';
const CLIENT_ID = 'REPLACE_CLIENT';
const CLIENT_SECRET = 'REPLACE_SECRET';
const BOT_TOKEN = 'REPLACE_TOKEN';

const API_BASE = 'https://west.albion-online-data.com/api/v2/stats/prices';
const ITEMS_URL = 'https://coldtouch.github.io/coldtouch-market-analyzer/items.json';
const CHUNK_SIZE = 100;
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// === DATABASE ===
const db = new sqlite3.Database('/opt/albion-saas/database.sqlite');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, avatar TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS alerts (guild_id TEXT, channel_id TEXT, min_profit INTEGER, PRIMARY KEY(guild_id, channel_id))`);
});

// === SHARED MARKET CACHE ===
let marketCache = [];       // Full array of price entries for all items  
let cacheTimestamp = null;   // When the last full scan completed
let cacheItemCount = 0;      
let cachedGzipBuffer = null; // Pre-compressed response buffer
let scanInProgress = false;

async function doServerScan() {
  if (scanInProgress) { console.log('[Cache] Scan already in progress, skipping.'); return; }
  scanInProgress = true;
  console.log('[Cache] Starting full market scan...');
  const startTime = Date.now();
  
  try {
    // 1) Fetch the item list from GitHub Pages
    const itemsRes = await fetch(ITEMS_URL);
    if (!itemsRes.ok) throw new Error('Failed to fetch items.json: HTTP ' + itemsRes.status);
    const itemNames = await itemsRes.json();
    const itemIds = Object.keys(itemNames).filter(k => k && itemNames[k]);
    console.log(`[Cache] Loaded ${itemIds.length} item IDs.`);
    
    // 2) Fetch prices in chunks
    const allPrices = [];
    for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
      const chunk = itemIds.slice(i, i + CHUNK_SIZE);
      try {
        const url = `${API_BASE}/${chunk.join(',')}.json`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          for (const entry of data) {
            if (entry.sell_price_min > 0 || entry.buy_price_max > 0) {
              allPrices.push(entry);
            }
          }
        }
      } catch (e) { /* skip failed chunk */ }
      
      // Small delay to avoid hammering the API
      if (i + CHUNK_SIZE < itemIds.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    marketCache = allPrices;
    cacheTimestamp = new Date().toISOString();
    cacheItemCount = allPrices.length;
    
    // Pre-compress the cache for fast serving
    const jsonStr = JSON.stringify({ timestamp: cacheTimestamp, count: cacheItemCount, data: allPrices });
    cachedGzipBuffer = zlib.gzipSync(jsonStr);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Cache] Scan complete: ${allPrices.length} price entries in ${elapsed}s. Compressed: ${(cachedGzipBuffer.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.error('[Cache] Scan failed:', err.message);
  } finally {
    scanInProgress = false;
  }
}

// Start periodic scanning
setTimeout(doServerScan, 5000); // First scan 5s after boot
setInterval(doServerScan, SCAN_INTERVAL_MS);

// === DISCORD BOT ===
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = [
  {
    name: 'setup_alerts',
    description: 'Bind Albion Arbitrage alerts to this channel',
    options: [{ name: 'min_profit', type: 4, description: 'Minimum silver profit (e.g. 50000)', required: true }]
  },
  {
    name: 'stop_alerts',
    description: 'Stop market alerts in this channel'
  }
];

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

client.on('ready', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered Slash Commands successfully!');
  } catch (error) { console.error(error); }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'setup_alerts') {
    const minP = interaction.options.getInteger('min_profit');
    db.run(`INSERT OR REPLACE INTO alerts (guild_id, channel_id, min_profit) VALUES (?, ?, ?)`, [interaction.guildId, interaction.channelId, minP], (err) => {
      if(err) return interaction.reply({content: 'DB Error :(', ephemeral: true});
      interaction.reply(`✅ Bound Market Arbitrage alerts to this channel for flips > **${minP.toLocaleString()} silver**!`);
    });
  }
  if (interaction.commandName === 'stop_alerts') {
    db.run(`DELETE FROM alerts WHERE guild_id = ? AND channel_id = ?`, [interaction.guildId, interaction.channelId], (err) => {
      interaction.reply(`🛑 Alerts stopped for this channel.`);
    });
  }
});

client.login(BOT_TOKEN);

// === EXPRESS APP ===
const app = express();
app.use(cors({ origin: 'https://coldtouch.github.io', credentials: true }));
app.use(session({
  secret: 'albion-secret',
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

// === ALERT CRUD ENDPOINTS ===
app.use(express.json());

app.get('/api/alerts', (req, res) => {
  db.all(`SELECT guild_id, channel_id, min_profit FROM alerts`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/alerts', (req, res) => {
  const { channel_id, min_profit } = req.body;
  if (!channel_id || !min_profit) return res.status(400).json({ error: 'channel_id and min_profit required' });
  const guildId = 'web-' + channel_id;
  db.run(`INSERT OR REPLACE INTO alerts (guild_id, channel_id, min_profit) VALUES (?, ?, ?)`, 
    [guildId, channel_id, parseInt(min_profit)], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, channel_id, min_profit: parseInt(min_profit) });
  });
});

app.delete('/api/alerts', (req, res) => {
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
const API_LOCALE_MAP = { '0': 'Thetford', '7': 'Thetford', '3004': 'Thetford', '3': 'Lymhurst', '1002': 'Lymhurst', '4': 'Bridgewatch', '2004': 'Bridgewatch', '3003': 'Black Market', '3005': 'Caerleon', '3008': 'Fort Sterling', '4000': 'Martlock', '4300': 'Brecilien' };
function getCity(id) { return API_LOCALE_MAP[id] || 'City-'+id; }

const alertCooldowns = {}; 

(async () => {
  try {
    const nc = await connect({ 
      servers: "nats.albion-online-data.com:4222",
      user: "public",
      pass: "thenewalbiondata" 
    });
    const sc = StringCodec();
    const sub = nc.subscribe("marketorders.deduped.*");
    
    for await (const m of sub) {
      const strData = sc.decode(m.data);
      for(let wc of wsClients) if(wc.readyState === WebSocket.OPEN) wc.send(strData);
      
      try {
        const payloads = JSON.parse(strData);
        for (const p of payloads) {
          if (!p.ItemTypeId || !p.LocationId || !p.UnitPriceSilver) continue;
          const id = p.ItemTypeId, q = p.QualityLevel, loc = p.LocationId, price = p.UnitPriceSilver;
          if (!alertMarketDb[id]) alertMarketDb[id] = {};
          if (!alertMarketDb[id][q]) alertMarketDb[id][q] = {};
          if (!alertMarketDb[id][q][loc]) alertMarketDb[id][q][loc] = { sellMin: Infinity, buyMax: 0 };
          
          if (p.AuctionType === 'offer' && price < alertMarketDb[id][q][loc].sellMin) alertMarketDb[id][q][loc].sellMin = price;
          else if (p.AuctionType === 'request' && price > alertMarketDb[id][q][loc].buyMax) alertMarketDb[id][q][loc].buyMax = price;
          
          let bestSell = { price: Infinity, loc: null }, bestBuy = { price: 0, loc: null };
          for (const [c, cd] of Object.entries(alertMarketDb[id][q])) {
            if (cd.sellMin > 0 && cd.sellMin < bestSell.price) bestSell = { price: cd.sellMin, loc: c };
            if (cd.buyMax > 0 && cd.buyMax > bestBuy.price) bestBuy = { price: cd.buyMax, loc: c };
          }
          
          if (bestSell.loc && bestBuy.loc && bestSell.loc !== bestBuy.loc) {
            const profit = bestBuy.price - bestSell.price - (bestBuy.price * TAX_RATE);
            if (profit > 0) {
              db.all(`SELECT channel_id FROM alerts WHERE min_profit <= ?`, [profit], (err, rows) => {
                if(err || !rows) return;
                rows.forEach(row => {
                  const cacheKey = `${id}_${q}_${row.channel_id}`;
                  const last = alertCooldowns[cacheKey] || 0;
                  if (Date.now() - last > 1800000) { 
                    alertCooldowns[cacheKey] = Date.now();
                    const channel = client.channels.cache.get(row.channel_id);
                    if (channel) {
                      channel.send({
                        embeds: [{
                          title: `🚨 Arbitrage Alert! 💰 ${Math.floor(profit).toLocaleString()} Silver`,
                          color: 0xffd700,
                          fields: [
                            { name: "Item", value: `${id} (Qual ${q})`, inline: false },
                            { name: "Buy In", value: `**${getCity(bestSell.loc)}** for ${Math.floor(bestSell.price).toLocaleString()}`, inline: true },
                            { name: "Sell In", value: `**${getCity(bestBuy.loc)}** for ${Math.floor(bestBuy.price).toLocaleString()}`, inline: true }
                          ]
                        }]
                      }).catch(()=>{});
                    }
                  }
                });
              });
            }
          }
        }
      } catch(e) {}
    }
  } catch(err){ console.error(err); }
})();

server.listen(443, () => console.log('SaaS Backend (Express + Discord + WSS + Market Cache) listening on 443!'));
"""
    backend_js = backend_js.replace("REPLACE_DOMAIN", domain)
    backend_js = backend_js.replace("REPLACE_CLIENT", CLIENT_ID)
    backend_js = backend_js.replace("REPLACE_SECRET", CLIENT_SECRET)
    backend_js = backend_js.replace("REPLACE_TOKEN", BOT_TOKEN)

    b64_server = base64.b64encode(backend_js.encode()).decode()
    run_wait(f"echo '{b64_server}' | base64 -d > /opt/albion-saas/backend.js")
    
    svc = """
[Unit]
Description=Albion SaaS Backend
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/albion-saas/backend.js
WorkingDirectory=/opt/albion-saas
Restart=always
User=root

[Install]
WantedBy=multi-user.target
"""
    b64_svc = base64.b64encode(svc.encode()).decode()
    run_wait(f"echo '{b64_svc}' | base64 -d > /etc/systemd/system/albion-saas.service")
    
    run_wait("systemctl stop albion-proxy albion-alerter") 
    run_wait("systemctl disable albion-proxy albion-alerter") 
    run_wait("systemctl daemon-reload")
    run_wait("systemctl enable albion-saas")
    run_wait("systemctl restart albion-saas")
    
    print(run_wait("systemctl status albion-saas | head -n 15"))
    ssh.close()
    print("SaaS Deployed successfully!")

if __name__ == '__main__':
    main()
