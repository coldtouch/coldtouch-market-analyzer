# Albion Market Analyzer — Project Handoff

> **Last updated:** 2026-04-07
> **Author:** Coldtouch (yuvalvilensky@gmail.com)
> **Purpose:** Everything a new session needs to continue development without re-discovering context.

---

## 1. What This Project Is

A full-stack SaaS web app for analyzing the Albion Online in-game economy. Players use it to find profitable market flips, plan transport hauls, evaluate guild loot tabs, track crafting profits, and more.

- **Live site:** https://albionaitool.xyz (Contabo VPS)
- **GitHub Pages mirror:** https://coldtouch.github.io/coldtouch-market-analyzer/
- **GitHub repo:** https://github.com/coldtouch/coldtouch-market-analyzer
- **Game client fork:** https://github.com/coldtouch/albiondata-client (private use)

---

## 2. Architecture Overview

### Frontend (Vanilla SPA)
| File | Lines | Role |
|------|-------|------|
| `app.js` | ~7,128 | All frontend logic, no framework |
| `index.html` | ~2,197 | All HTML structure, no templating |
| `style.css` | ~4,020 | Custom CSS, glassmorphism dark theme |
| `db.js` | ~500 | IndexedDB wrapper for client-side price caching |

No build step. No bundler. External data from Albion Data Project APIs.

### Backend (Node.js embedded in Python)
| File | Lines | Role |
|------|-------|------|
| `deploy_saas.py` | ~3,046 | Contains the ENTIRE backend as a Python string + SFTP deploy logic |

The backend includes: Express server, JWT auth, SQLite DB, NATS client, Discord bot, WebSocket server, 5-minute scan cycle, hourly spread stats, daily compaction, live flip detection.

**Deploy command:** `python deploy_saas.py` (SSH/SFTP to VPS, restarts systemd service)

### Game Client (Go)
| Directory | Role |
|-----------|------|
| `D:\Coding\albiondata-client-custom\` | Forked Albion Data Client (Go, MIT license) |

Custom additions on top of standard AODP client:
- Chest/vault content capture (ContainerOpen, ContainerManageSubContainer opcodes)
- Vault tab name resolution (GuildVaultInfo/BankVaultInfo events)
- WebSocket relay to VPS (`vps_relay.go`)
- OAuth Device Authorization flow (`device_auth.go`)
- Item numeric-to-string ID mapping (`itemmap.go`, 11,697 items)

### Data Sources
| Source | What | How |
|--------|------|-----|
| Albion Data Project API | Market prices (all cities) | HTTP polling every 5 min |
| AODP NATS stream | Real-time market orders | `nats.albion-online-data.com:24222` |
| Game client (custom) | Chest contents, vault tabs | WebSocket relay to VPS |

---

## 3. VPS & Infrastructure

| Item | Value |
|------|-------|
| **VPS provider** | Contabo VPS 20 |
| **IP** | 5.189.189.71 |
| **OS** | Ubuntu |
| **RAM** | 1 GB + 512 MB swap |
| **Domain** | albionaitool.xyz |
| **SSL** | Let's Encrypt via certbot |
| **Systemd service** | `albion-saas` |
| **Backend path** | `/opt/albion-saas/` |
| **Firewall** | UFW: ports 22, 80, 443 |
| **Game server** | Europe (configurable via `GAME_SERVER` env) |

### Environment Variables (.env)
```
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
DISCORD_BOT_TOKEN
JWT_SECRET
SESSION_SECRET
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM  (optional)
DISCORD_FEEDBACK_WEBHOOK
GAME_SERVER  (default: europe)
```

---

## 4. Database Schema (SQLite)

| Table | Purpose |
|-------|---------|
| `users` | Accounts (discord_id, email, password_hash, auth_type, capture_token, tier) |
| `price_snapshots` | Raw 5-min scan prices (auto-compacted after 6h) |
| `price_averages` | Hourly/daily aggregated prices |
| `spread_stats` | Confidence scores per item/city pair (7-day window, hourly job) |
| `contributions` | Scan tracking for leaderboard |
| `user_stats` | Username + scan counts |
| `alerts` | Discord bot alert configs (per guild/channel) |
| `loot_tabs` | Chest purchase records (items JSON, purchase price, status) |
| `loot_tab_sales` | Per-item sales from loot tabs |
| `feedback` | User bug reports / suggestions |
| `meta_config` | Key-value config store |
| `device_authorizations` | OAuth Device Flow state |

**Critical lesson:** The VPS has 1 GB RAM. On April 4, 22M rows in `price_snapshots` caused 100% CPU for 12+ hours, killing OAuth and all user-facing endpoints. Compaction now runs aggressively (6h retention on snapshots, daily aggregation).

---

## 5. All Features (24 Tabs)

### Market Group
- **Market Browser** -- Browse 11k+ items, search/filter, per-city prices
- **Market Flipping** -- Cross-city arbitrage with confidence badges, freshness filter
- **BM Flipper** -- Black Market specific flip finder
- **City Comparison** -- Side-by-side prices, 24h/7d/4w charts
- **Top Traded** -- 7-day volume rankings from Charts API
- **Item Power** -- Silver-per-IP ratio comparison
- **Favorites** -- Saved item lists with cross-city comparison

### Crafting Group
- **Crafting Profits** -- Recipe lookup, material cost calc, save/load setups
- **Journals Calculator** -- Labourer journal profits (10 types, T3-T8)
- **RRR Calculator** -- Resource return rate with spec/city/focus
- **Repair Cost** -- Estimates by tier/enchant/quality/durability

### Trading Group
- **Transport Routes** -- Bulk haul planner with weight/slots/budget, live + historical modes, sell strategy toggle (instant sell vs market listing), freshness filter, copy shopping list
- **Live Flips** -- Real-time flip detection via NATS stream, city/type filters, sound + desktop notifications
- **Portfolio Tracker** -- FIFO cost basis, realized P/L, CSV export (localStorage)
- **Loot Buyer** -- 3-phase system (see below)

### Game Tools Group
- **Mounts Database** -- All mounts with live prices
- **Farm & Breed** -- Crop/herb/animal profit calculator
- **Community Builds** -- Pulls from AlbionFreeMarket API

### System
- **Alerts** -- Discord bot alert configuration
- **Community** -- Leaderboard + tier badges (Bronze/Silver/Gold/Diamond)
- **Profile** -- Avatar, stats, settings, capture token, Discord linking
- **Feedback** -- Floating FAB, sends to Discord webhook
- **About** -- In-website changelog

---

## 6. Loot Buyer Feature (Detailed)

The flagship custom feature. Allows players to evaluate guild loot tabs before buying them, plan where to sell items, and track profit over time.

### Data Flow
```
Game client captures chest    -->  WebSocket relay  -->  VPS stores capture
     (Go, UDP packets)             (vps_relay.go)        (in-memory, 1h TTL)
                                                              |
Browser receives via WS  <--  VPS broadcasts  <--------------+
     (app.js)                  (to user's sessions)
```

### Phase 1: Buy Decision Helper (DONE)
- `/api/loot-evaluate` endpoint analyzes items against market data
- Verdict: buy / maybe / skip based on margin vs asking price
- Risk flags: `no_buy_orders`, `stale_data`, low daily volume
- Shows quick-sell value (buy orders) vs patient-sell value (market listing)

### Phase 2: Sell Optimizer (DONE)
- `buildSellPlan()` with 85% instant/market threshold
- Groups items by destination city, sorted by expected value
- Copy buttons per trip and "Copy All Trips" master button
- No-data bucket for items with zero market data

### Phase 3: Lifecycle Tracker (DONE)
- "I Bought This" saves tab to DB with city + purchase price
- Tracked tabs show paid/revenue/net/progress stats
- Expandable detail with sales history
- Manual sale recording (item ID, qty, price)
- Status badges: open / partial / sold

### Phase 3 Remaining: ReadMail Opcode (NOT DONE)
- Capture sale completion mail notifications in Go client
- Auto-match sold items to active loot tabs
- Skipped because it requires in-game testing

### Game Client Tab Identification
```
GuildVaultInfo event (418)  -->  Stores tab GUIDs + names in memory
BankVaultInfo event (419)        (separate vars for guild vs bank)
                                        |
ContainerOpen (opcode 92)  -->  Matches container GUID to vault tab GUIDs
                                If match: exact tab name
                                If no match: sequential index fallback
                                        |
ContainerManageSubContainer  -->  Same GUID matching for tab switches
(opcode 114)                      Increments index if no GUID match
```

---

## 7. Custom Go Client Architecture

### Packet Pipeline
```
UDP capture (port 5056)  -->  Photon decode  -->  Opcode dispatch  -->  Handler  -->  NATS publish
                                                                              |
                                                                     VPS WebSocket relay
                                                                     (chest captures only)
```

### Key Files
| File | Purpose |
|------|---------|
| `client/decode.go` | Routes opcodes to handler structs (request/response/event switch) |
| `client/operation_container_open.go` | ContainerOpen + ContainerManageSubContainer handlers |
| `client/event_container_items.go` | NewSimpleItem, NewEquipmentItem, NewJournalItem handlers + itemCollector |
| `client/event_vault_info.go` | GuildVaultInfo/BankVaultInfo parsing, tab GUID extraction, matchContainerToVaultTab() |
| `client/vps_relay.go` | WSS connection to albionaitool.xyz, auth, SendChestCapture() |
| `client/device_auth.go` | OAuth Device Authorization flow (request code, poll, save token) |
| `client/itemmap.go` | 11,697 numeric-to-string item mappings from ao-bin-dumps |
| `client/config.go` | CaptureToken from config.yaml or --capture-token CLI flag |
| `itemmap.json` | The mapping data file (committed) |
| `config.yaml` | User's saved capture token (not committed) |

### Registered Handlers (in decode.go)
**Request ops:** GetGameServerByCluster, AuctionGetOffers, AuctionGetItemAverageStats, GetClusterMapInfo, GoldMarketGetAverageInfo, RealEstateGetAuctionData, RealEstateBidOnAuction, ContainerOpen, ContainerManageSubContainer

**Events:** RedZoneWorldMapEvent, NewSimpleItem, NewEquipmentItem, InventoryPutItem, NewJournalItem, GuildVaultInfo, BankVaultInfo

### Build
```bash
# Go 1.24.2 installed at C:\Go (zip, NOT in system PATH)
export PATH="$PATH:/c/Go/bin"
cd D:\Coding\albiondata-client-custom
go build -v ./...
```

---

## 8. API Endpoints (38 Total)

### Auth & Users
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/auth/discord` | No | Redirect to Discord OAuth |
| GET | `/auth/discord/callback` | No | OAuth callback |
| POST | `/api/register` | No | Email/password registration (rate-limited) |
| POST | `/api/login` | No | Email/password login (rate-limited) |
| GET | `/api/me` | JWT | Current user profile |
| POST | `/api/link-discord` | JWT | Link Discord to account |
| POST | `/api/unlink-discord` | JWT | Unlink Discord |
| GET | `/api/verify-email` | No | Email verification token |
| POST | `/api/resend-verification` | JWT | Resend verification (rate-limited) |
| POST | `/api/change-password` | JWT | Update password (rate-limited) |
| POST | `/api/change-username` | JWT | Update username |

### Device Authorization (Game Client)
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/api/device/code` | No | Request device code |
| POST | `/api/device/token` | No | Poll for capture token |
| POST | `/api/device/authorize` | JWT | Approve device code from browser |
| POST | `/api/generate-capture-token` | JWT | Generate new capture token |
| GET | `/api/capture-token` | JWT | Get current capture token |

### Market Data
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/market-cache` | No | Latest scan results |
| GET | `/api/market-cache/status` | No | Cache freshness info |
| GET | `/api/spread-stats` | No | Historical confidence scores |
| GET | `/api/spread-stats/top` | No | Top 20 most reliable spreads |
| GET | `/api/price-history` | No | Historical price data for charts |
| GET | `/api/transport-routes` | No | Bulk transport candidates |
| GET | `/api/transport-routes-live` | No | Live-validated transport routes |
| GET | `/api/live-flips` | No | Recent flip detections |

### Loot Buyer
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/api/loot-evaluate` | JWT | Analyze loot tab items |
| GET | `/api/chest-captures` | JWT | List recent captures |
| POST | `/api/loot-tab/save` | JWT | Save purchase ("I Bought This") |
| GET | `/api/loot-tabs` | JWT | List user's tracked tabs |
| GET | `/api/loot-tab/:id` | JWT | Tab detail + sales history |
| POST | `/api/loot-tab/:id/sale` | JWT | Record a sale |
| PATCH | `/api/loot-tab/:id/status` | JWT | Update status |

### Alerts & Community
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/alerts` | JWT | User's Discord alert config |
| POST | `/api/alerts` | JWT | Create alert |
| DELETE | `/api/alerts` | JWT | Delete alert |
| POST | `/api/contributions` | JWT | Record scan (rate-limited 30/min) |
| GET | `/api/my-stats` | JWT | User's tier + scan counts |
| GET | `/api/leaderboard` | No | Top 20 scanners |
| POST | `/api/feedback` | Optional | Bug report / suggestion (rate-limited 1/min) |

---

## 9. In-Memory Caches (Backend)

| Cache | Structure | Purpose |
|-------|-----------|---------|
| `alertMarketDb` | `{itemId: {quality: {city: {sellMin, buyMax, dates, amounts}}}}` | Real-time market prices from NATS |
| `cityPriceRef` | `{itemId_quality_city: avgPrice}` | 2-day city averages for validation |
| `globalPriceRef` | `{itemId_quality: avgPrice}` | 7-day global averages for outlier detection |
| `volumeRef` | `{itemId_quality_city: avgSampleCount}` | Volume proxy data |
| `clientCaptures` | `{userId: [captures]}` | Chest captures from game client (max 10, 1h TTL) |
| `liveFlips` | Circular buffer (200) | Recent flip detections |
| `deviceCodes` | `{deviceCode: {userCode, expiresAt, ...}}` | Pending device authorizations |

---

## 10. Background Jobs (Server-Side)

| Interval | Job | What it does |
|----------|-----|-------------|
| 5 min | Market scan | Fetch all prices from AODP API, write snapshots, detect flips |
| 5 min | User stats | Aggregate 30-day scan counts, assign tiers |
| 10 min | Price reference rebuild | Rebuild `cityPriceRef` + `globalPriceRef` from `price_averages` |
| 1 hour | Spread stats | Calculate avg_spread, consistency, confidence per item/city pair |
| Daily | Compaction | Delete snapshots >6h, aggregate to hourly/daily, prune old stats |
| Continuous | NATS stream | Real-time market orders, buffer + batch-write every 60s, flip detection |

---

## 11. Decisions Made (and Why)

| Decision | Reasoning |
|----------|-----------|
| Vanilla JS, no framework | Simple deployment, no build step, one-file frontend |
| Backend embedded in deploy script | Single `python deploy_saas.py` deploys everything |
| Stateless JWT auth (no sessions) | Works cross-origin (GitHub Pages + VPS), no session store needed |
| Manual Discord OAuth (no passport) | Passport-discord had no timeouts, caused hanging logins |
| WebSocket to VPS (not private NATS) | Simpler than running a separate NATS server for custom data |
| OAuth Device Authorization for Go client | Users don't need to manually copy/paste tokens |
| Only collect items after ContainerOpen | Prevents ghost captures from zone loading, player gear events |
| Separate guild/bank vault info vars | Both events fire simultaneously; picking the one with more tabs |
| 2-day cityPriceRef (not 7-day) | More accurately reflects current market conditions |
| 85% threshold for sell strategy | If instant sell is within 15% of market listing, take the certainty |
| Keep contributing to public AODP NATS | Standard data still goes to public; custom data goes to private VPS |

---

## 12. Known Bugs & Technical Debt

### High Priority
- **Client GUID matching untested in live game** -- ContainerManageSubContainer GUID matching was coded but never verified in a real game session. If it fails, try mixed-endian byte-swap (same pattern as Character IDs in decodeCharacterID). Logs show `[ContainerManageSubContainer] guid=... len=...` -- if len=0 then there's no GUID in the packet.
- **Negative item ID mappings are guesses** -- IDs -1 to -9 mapped to Silver, Gold, Fame Credit, Silver Pouch, etc. based on community knowledge. Need live verification.

### Medium Priority
- **Transport volume data** -- `sample_count` is data frequency, not actual trade volume.

### Low Priority
- **app.js is 7,128+ lines** -- Could benefit from modularization
- **Go client build pipeline** -- Manual `go build`, no CI/CD

### RESOLVED (April 7 Session 9-10)
- ~~Latest changes not deployed~~ -- DEPLOYED (3 deploys this session)
- ~~SMTP not configured~~ -- CONFIRMED WORKING (`[SMTP] Mail transporter ready` in logs)
- ~~Sale recording UX~~ -- Replaced prompt() with inline form (item dropdown from tab, auto-fill qty, quality preserved)
- ~~UNKNOWN items~~ -- Special item map (-1 to -9) in Go client, filtered from addItem(), backend SPECIAL_ITEM_NAMES fallback
- ~~Portfolio XSS~~ -- encodeURIComponent on img src, data-attr + event delegation for delete buttons
- ~~Live Flip false positives~~ -- BM 3-min freshness, 4x global avg outlier check, always-validate broadcastFlip
- ~~Mobile responsive gaps~~ -- Breakpoints added for sale form, manual entry, sell plan, capture cards

---

## 13. Roadmap (Next Up)

### Immediate — In-Game Testing
1. **Live game test of chest capture** -- Go client → WebSocket → VPS → frontend. Verify GUID matching, tab names, item accuracy
2. **Device Auth end-to-end test** -- Device code flow from Go client to browser approval

### Short Term
3. **ReadMail opcode handler** in Go client -- capture sale completion mails, auto-match to tracked loot tabs
4. **Go client GitHub Releases** -- automated builds for Windows/Mac/Linux via GitHub Actions

### Major New Feature — Loot Logger Viewer
5. **Forked:** https://github.com/coldtouch/ao-loot-logger (GPL-3.0, cloned to `D:\Coding\ao-loot-logger\`)
6. **Go client additions:** Port EvOtherGrabbedLoot (opcode 275), EvNewCharacter (29), EvCharacterStats (143), OpInventoryMoveItem (29) for loot capture
7. **Website Loot Logger tab:** Upload .txt files OR receive live loot data from custom client. Per-player breakdown with market values.
8. **Killer feature — Loot Accountability Check:** Cross-reference loot log vs chest deposit. Show who picked up items that weren't deposited (green = deposited, red = missing).

### Testing Commands
```bash
# Build Go client
export PATH="$PATH:/c/Go/bin"
cd D:\Coding\albiondata-client-custom
go build -v -o albiondata-client-custom.exe .

# Run with debug logging
./albiondata-client-custom.exe -debug

# Key log lines to watch:
# [GuildVault] N tabs detected: [...]        -- tab names captured
# [BankVault] N tabs detected: [...]         -- personal bank tabs
# [VaultInfo] extractGUIDArray: parsed N GUIDs -- GUIDs OK
# [ContainerOpen] Matched to vault tab N: X  -- GUID match SUCCESS
# [ContainerOpen] No vault tab GUID match    -- GUID match FAILED
# [ContainerCapture] Captured N items        -- tab finalized
# [VPSRelay] Authenticated as: ...           -- WS connected
# [VPSRelay] Sent chest capture (N items)    -- sent to website
```

---

## 14. Session History (Recent)

### April 7, Sessions 9-10 (Latest)
- Deployed all pending changes (3 deploys)
- Inline sale recording form (replaced prompt() dialogs with item dropdown from tab)
- Unknown items mapped (negative IDs -1 to -9 in Go client, filtered from captures)
- SMTP verified working on VPS
- Sell plan travel route suggestion (geography-based route for multi-city sells)
- Manual item entry on Loot Buyer (autocomplete search, quality/qty, duplicate merging)
- Live flip false positives fix (BM 3-min freshness, 4x outlier, always-validate)
- Portfolio XSS hardened (encodeURIComponent, data-attr delegation)
- Mobile responsive breakpoints for newer features
- Custom client download page in About tab (setup guide, AODP comparison table)
- Capture mode toggle in Go client (--capture flag, config.yaml)
- Feedback webhook moved to dedicated #website-feedback Discord channel
- Forked ao-loot-logger to https://github.com/coldtouch/ao-loot-logger
- Loot Logger Viewer feature spec saved to roadmap

### April 7, Sessions 5-8
- Phase 3: Lifecycle Tracker -- DB tables, 5 API endpoints, tracked tabs, sale recording
- Phase 2: Sell Optimizer -- buildSellPlan(), 85% threshold, trip grouping, copy buttons
- Phase 1: Buy Decision Helper -- risk flags, verdict system, volume data
- Loot Buyer tab name fix (tabIndex), Go client tab index tracking
- Feedback & Bug Report system (floating FAB, Discord webhook)
- Market Flipper freshness Max Age input fix

### April 6, Session 4
- Transport freshness filter, live flip price validation, volume awareness, sell strategy toggle, `/api/transport-routes-live` endpoint, NATS order amounts, real price ages, 2-day cityPriceRef, Discord bot deferReply fix, historical analytics mode

### April 5, Sessions 1-3
- Email verification, user profile, live flip enhancements, user registration DB, live snipe/flip feature, Discord bot alert gating, haul plan collapse fix

### April 4
- Critical: DB bloat (22M rows) causing 100% CPU. Emergency recovery. OAuth timeout fixes. Compaction overhaul.

### April 3
- Manual OAuth2 implementation, custom domain setup, VPS responsiveness fixes

---

## 15. Critical Lessons Learned

1. **VPS has 1 GB RAM** -- Never load large result sets into memory. The April 4 incident (22M rows, 100% CPU for 12h) took down the entire site.
2. **Backend is embedded in deploy_saas.py** -- There is no separate backend.js in the repo. It only exists on the VPS after deploy.
3. **`esc()` on ALL external data** -- Multiple XSS hardening passes done. Every new innerHTML must use `esc()`.
4. **NATS sample_count is NOT volume** -- It's data point frequency, not trade volume. Labeled "24h Activity" to avoid misleading users.
5. **Go PATH not in system PATH** -- Every Go command needs `export PATH="$PATH:/c/Go/bin"`.
6. **Discord OAuth was painful** -- Went through passport -> manual OAuth, sessions -> JWT. Current stateless JWT approach works well.
7. **Deploy via SFTP, not base64 echo** -- Base64 via echo truncates at ~100KB. Always use SFTP for backend.js upload.
8. **Vault info fires for ALL chests** -- BankVaultInfo/GuildVaultInfo fire when approaching any chest. Must match by GUID or use separate guild/bank vars.

---

## 16. Standard Workflow

After finishing any work:
1. Update `CHANGELOG.md` with dated section
2. Add matching entry to changelog-list in `index.html` About tab
3. If new feature: add feature-card to features-grid in About tab
4. `git add` specific files, commit, push to origin/main
5. If backend changed: `python deploy_saas.py` to deploy

---

## 17. File Quick Reference

### Website (`D:\Coding\albion_market_analyzer\`)
| File | Size | What |
|------|------|------|
| `app.js` | ~346 KB | All frontend logic |
| `index.html` | ~145 KB | All HTML structure |
| `style.css` | ~88 KB | All styles |
| `deploy_saas.py` | ~136 KB | Backend + deploy script |
| `db.js` | ~15 KB | IndexedDB wrapper |
| `items.json` | ~667 KB | Item dictionary |
| `recipes.json` | ~1 MB | Crafting recipes |
| `CHANGELOG.md` | ~30 KB | Detailed history |
| `CLAUDE.md` | ~10 KB | Session context for Claude |
| `.env` | secrets | Environment variables |

### Game Client (`D:\Coding\albiondata-client-custom\`)
| File | What |
|------|------|
| `client/decode.go` | Opcode routing (request/response/event switches) |
| `client/operation_container_open.go` | ContainerOpen + SubContainer handlers |
| `client/event_container_items.go` | Item event handlers + itemCollector |
| `client/event_vault_info.go` | Vault tab parsing + GUID matching |
| `client/vps_relay.go` | WebSocket relay to VPS |
| `client/device_auth.go` | OAuth Device Flow |
| `client/itemmap.go` | Numeric-to-string item mapping |
| `client/config.go` | CLI config + capture token |
| `itemmap.json` | 11,697 item mappings |

### Claude Memory (`C:\Users\Coldtouch\.claude\projects\D--Coding\memory\`)
| File | What |
|------|------|
| `MEMORY.md` | Memory index |
| `project_albion.md` | Project overview |
| `reference_albion_infra.md` | VPS, GitHub, deployment refs |
| `todo_albion_roadmap.md` | Feature roadmap + completed items |
| `feedback_push_and_changelog.md` | Workflow: always push + update changelog |
| `feedback_vps_debugging.md` | Check CPU first on VPS issues |
| `user_profile.md` | User identity |
