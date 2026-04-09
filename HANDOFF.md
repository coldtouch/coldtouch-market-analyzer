# Albion Market Analyzer — Project Handoff

> **Last updated:** 2026-04-09
> **Author:** Coldtouch (yuvalvilensky@gmail.com)
> **Purpose:** Everything a new session needs to continue development without re-discovering context.

---

## 0. Latest Session — April 9, 2026 (Full Project Audit)

### What Was Done
Ran 4 parallel audit sessions covering the entire project.

#### 1. Frontend & UX Audit (COMPLETED — 40 findings)

**CRITICAL (2):**
- `scanAbortController` declared at `app.js:65` but never wired up — no abort protection on any scan. Rapid clicks fire duplicate fetch chains.
- `itemNames` at `app.js:5261` references non-existent variable (should be `ITEM_NAMES`) — Loot Buyer sale form shows raw item IDs instead of friendly names.

**HIGH (8):**
- 20+ `alert()`/`confirm()` calls blocking UI thread
- `analyticsCache` Map has no size cap or eviction (grows unbounded in long sessions)
- Silent failure when `items.json`/`recipes.json` fail to load (no error banner, no retry)
- `plan.buyCity`/`plan.sellCity` injected into innerHTML without `esc()` at `app.js:5819,5928` (XSS)
- Live Flips REST fallback `.catch(() => {})` silences all errors — no user feedback
- `renderBrowser()` reads ALL IndexedDB prices on every page flip/filter/sort change
- `setupAutocomplete()` accumulates 7+ permanent global `document.click` listeners at init
- Stale VPS IP `"209-97-129-125"` in console.log at `app.js:3975`

**MEDIUM (9):**
- Inline `onclick` with `esc()` uses wrong escaping context — HTML entity-decodes before JS runs
- Only 7 CSS breakpoints for 24-tab app (no 1024px tablet, no 480px/375px phone breakpoints)
- Zero ARIA attributes in entire app (no `role`, `aria-selected`, `aria-expanded`, `aria-live`, `aria-label`)
- No keyboard/Escape handler for chart modal, no focus trap
- `window._userData` and `window._lootSelectedItems` pollute global scope
- Top Traded ranks by cities in YOUR IndexedDB cache, not actual server trading volume
- CSV export from Portfolio doesn't escape commas in item names
- No `<label for="">` on form inputs — placeholders only
- Chart time radio `onclick` stale closure risk when `showGraph()` called while modal open

**Cross-Feature Synergy Gaps (10):**
1. Market Flipper → no "Check Crafting" action on flip cards
2. Transport haul → no crafting/refining alternative check per item
3. City Compare → no "Find Flips for this item" button
4. Live Flips → no Chart/History button on flip cards
5. Loot Buyer sell plan → no transport route suggestion for multi-city hauls
6. BM Flipper → no "Check Craft for BM" link
7. Portfolio → no current market prices / unrealized P/L
8. Item Browser → no "Add to Favorites" button on cards
9. City filter state doesn't persist when switching between tabs
10. Alerts → no preview of recent flips that would have matched the threshold

**Low/Nice-to-Have (10):**
- No contextual tooltips (Confidence %, VOLATILE, RRR unexplained inline)
- No global "Backend unreachable" banner when VPS is down
- No dark/light mode toggle
- No URL deep linking (`?tab=compare&item=T6_MAIN_SWORD`)
- Favorites lists stored in localStorage only — no server sync for logged-in users
- No back-to-top button on long results pages
- WebSocket reconnect has no exponential backoff (360 attempts/hr if VPS down for 30 min)
- Old DNS prefetch refs (`dns-prefetch`) in `index.html` pointing to current domain (correct but annotated to old IP in comments)
- No loading skeleton for initial `items.json`/`recipes.json` load
- Top Traded shows `--` volume for items without 7d chart data, making ranking misleading

#### 2. Data & Analytics Audit (COMPLETED)

**CRITICAL:**
- `computeAnalytics` silently fails every run. `price_analytics` has 0 rows.
- Error handler: `if (err || !rows7d || rows7d.length === 0)` logs "No 7d data, skipping" without logging `err`.
- Real error is likely `SQLITE_BUSY` — runs on main `db` connection. **Fix:** add `console.error(err)` + move to `statsDb` (same fix used for SpreadStats).

**Data Quality (Healthy):**
- 14.1M rows in `price_averages`, 9,799 unique items, 8 cities
- Average data freshness: 5.5 hours
- Daily intake: 3.1–3.5M rows/day, consistent
- 527K `spread_stats` rows, avg confidence 35.8%
- WAL file 220MB — healthy

**Issues Found:**
- 3 computed metrics exist in DB schema but are never exposed to frontend: `vwap_7d`, `ema_7d`, `spread_volatility`
- SpreadStats and Analytics background jobs can collide (both can run in same minute window)
- `price_hourly` has 0 rows — NOT a bug, first compaction run triggers ~April 11
- NATS flush is skipped during SpreadStats run (~2 min gap, minor data loss)

#### 3. Backend & VPS Audit (INCOMPLETE)
Blocked on workspace approval during session. Needs re-run with PC access. Should check: CPU/RAM/disk health, Node process, journalctl logs, NATS connectivity, CORS config, rate limiting, JWT expiry policy.

#### 4. Git/DevOps/Go Client Audit (INCOMPLETE)
Session ran but report not fully captured. Needs re-run. Known issue from prior work: `operation_read_mail.go:103` — expiry notification sets `ItemID = body[1]` (total amount, not item ID). Go client also needs GitHub Actions for automated builds.

### Recommended Fix Order
| # | Task | Effort | Impact |
|---|------|--------|--------|
| 1 | Fix `computeAnalytics` — log error + move to `statsDb` | 30 min | Unlocks trend arrows, SMA chart, VWAP/EMA |
| 2 | Fix `itemNames` → `ITEM_NAMES` at `app.js:5261` | 5 min | Fixes Loot Buyer sale form |
| 3 | Fix `plan.buyCity`/`plan.sellCity` XSS — add `esc()` at `app.js:5819,5928` | 5 min | Security hardening |
| 4 | Wire up `scanAbortController` in all scan functions | 1 hour | Scan stability |
| 5 | Expose VWAP + EMA on analytics chart | 1 hour | Requires fix #1 first |
| 6 | Add stale data badges to Market Flipper cards | 1 hour | Data transparency |
| 7 | Replace `alert()`/`confirm()` with inline modals/toast | 3 hours | UX polish |
| 8 | Add top 3 cross-feature synergy links | 2 hours | Usability |
| 9 | Cache `renderBrowser()` IndexedDB reads in module-level variable | 1 hour | Performance |
| 10 | Monitor first compaction run ~April 11 | Passive | Data retention validation |

### Still Pending (Carried Forward)
- Crafting Revamp Phases 1–5 (see Section 13)
- In-game testing: GUID matching, Device Auth, negative item ID mappings, chest capture phantom items
- ReadMail → loot tab matching integration (research done, implementation pending)
- Fix `operation_read_mail.go:103` expiry notification ItemID bug
- Go client GitHub Releases / Actions CI
- Loot Logger Viewer (major future feature)
- Re-run backend + git/devops audits with PC access

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
- **Negative item ID mappings are guesses** -- IDs -1 to -9 mapped to Silver, Gold, Fame Credit, Silver Pouch, etc. based on community knowledge. Need live verification. Also discovered IDs far beyond -9: -54, -57, -60, -62, -63, -66, -69, -84, -96, -107.

### Medium Priority
- **Transport volume data** -- `sample_count` is data frequency, not actual trade volume.

### Low Priority
- **app.js is 7,128+ lines** -- Could benefit from modularization
- **Go client build pipeline** -- Manual `go build`, no CI/CD

### RESOLVED (April 9 Session — Chest Capture FULLY WORKING)
- ~~Item mismatch bug~~ -- ROOT CAUSE: itemmap.json was stale. Game update shifted ALL 11,964 numeric IDs. Regenerated from latest ao-bin-dumps (April 1 2026 dump). Items now verified correct with crafter names + in-game visual confirmation.
- ~~Capture architecture rewrite~~ -- Replaced timer-based EquipItem collection with global item cache + `evAttachItemContainer` param 3 slot lookup. Param 3 contains global slot IDs referencing items in cache. This is the same approach used by Triky313/AlbionOnline-StatisticsAnalysis.
- ~~Missing item types~~ -- Added 3 new event handlers: `evNewFurnitureItem` (33), `evNewKillTrophyItem` (34), `evNewLaborerItem` (36). Now handling all 6 item event types. Mounts and furniture now captured correctly.
- ~~Item weight~~ -- Added weightmap.json (11,235 entries) generated from ao-bin-dumps items.json. Per-item weight + total tab weight included in captures. Verified exact match (40.2 kg) against in-game display.
- ~~GUID matching untested in live game~~ -- CONFIRMED WORKING: All tabs match by GUID every time. Mixed-endian byte-swap NOT needed.
- ~~NATS flood killing game client auth~~ -- FIXED (earlier session): Added `wc.clientType !== 'game-client'` filter to NATS broadcast in deploy_saas.py.

### RESOLVED (April 8 Session — Cowork/Dispatch)
- ~~Freshness age bug~~ -- `fresh-threshold-group` had `display:none` hardcoded in HTML and JS sync only fired on change events, never on page load. Fixed by extracting `syncFreshThreshold()` function called on init. Deployed.
- ~~Phase 3 Lifecycle Tracker~~ -- DB tables (`loot_tabs`, `loot_tab_sales`), 5 API endpoints, "I Bought This" button, tracking UI with progress %, net profit, status badges. All JWT-authenticated. Deployed.
- ~~Feedback/Bug Report feature~~ -- Discord webhook form (Bug Report / Suggestion + textarea), rate-limited 1/min per user. **CONFIRMED LIVE** (April 9 Cowork session) — `/api/feedback` active, `DISCORD_FEEDBACK_WEBHOOK` set in VPS `.env`, points to `#website-feedback`.

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

### Immediate
1. ~~**Chest capture**~~ -- FULLY WORKING (April 9). Items, weights, tab names, GUIDs all verified.
2. **Commit + push Go client changes** -- All changes uncommitted. Need to commit decode.go, operation_container_open.go, event_container_items.go, itemmap.go, client.go, itemmap.json, weightmap.json
3. **Device Auth end-to-end test** -- Device code flow from Go client to browser approval (not yet tested)
4. **Test on guild island** -- Verified on personal island only. Guild island needs retest with new architecture + updated itemmap

### Short Term
3. **ReadMail opcode — wire into loot tab matching** — opcode research DONE (April 9). Implementation: intercept `lib.NatsMarketNotifications`, match by ItemID + LocationID + timestamp window. Fix expiry bug at `operation_read_mail.go:103` (ItemID = body[1] is wrong — it's the total amount). Handle MailInfos cache miss (zone transition required before mails populate).
4. **Go client GitHub Releases** -- automated builds for Windows/Mac/Linux via GitHub Actions
5. ~~**Feedback form deployment**~~ -- CONFIRMED LIVE (April 9 Cowork session)

### Crafting Profits Revamp (5 Phases)

**Phase 1 — Test & stabilize existing crafting features (START HERE)**
- Test all existing Crafting Profits functionality; identify what's broken vs working
- Add refresh buttons to City Compare tab

**Phase 2 — Improve cost breakdowns**
- Verify RRR (Resource Return Rate) formulas are accurate
- Fix journal profit calculation
- Add enchantment material costs
- Add sub-recipe option (craft sub-components vs buy)

**Phase 3 — Cross-feature navigation**
- Implement `switchToCraft(itemId)` function callable from Item Browser, Transport, Loot Buyer, Market Flipper
- "Craft this item" buttons across tabs that jump directly to Crafting Profits with item pre-loaded

**Phase 4 — Enhanced bulk scanner**
- Filters by tier/enchant/category
- Insta-sell vs list toggle (like Transport Routes)
- Profit-per-focus-point metric
- Historical trend support

**Phase 5 — QoL**
- Favorites / saved setups
- Shopping list export
- Mobile responsive layout

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

### April 9 — Cowork/Dispatch Session (Latest)

#### Completed
1. **Feedback form verified LIVE** — `/api/feedback` endpoint confirmed deployed. `DISCORD_FEEDBACK_WEBHOOK` set in VPS `.env` pointing to `#website-feedback`. Service active. No action needed.

2. **ReadMail opcode research — COMPLETE**
   - Both `opGetMailInfos` (168) and `opReadMail` (170) are already fully wired in the Go client
   - Mail body is pipe-delimited: `quantity | itemID | unused | price_in_10000ths`
   - Price formula: `body[3] / 10000`; total after tax: `price * amount * 0.97`
   - Existing code produces `MarketSellNotification` with: ItemID, Amount, Price, TotalAfterTaxes, LocationID, MailID
   - For loot tab matching: match by ItemID + LocationID + timestamp window. No buyer name available at protocol level
   - **GOTCHA:** MailInfos cache requires prior zone transition or clicking mail icon. If ReadMail fires before GetMailInfos, item is silently dropped — needs handling in implementation
   - **BUG:** `operation_read_mail.go:103` — expiry notification sets `ItemID = body[1]` which is actually total amount, not item ID
   - Notifications sent via `lib.NatsMarketNotifications` — intercept here for loot tab matching

3. **Crafting Profits Revamp Phase 1** — attempted but stuck waiting for workspace directory approval (user was at work, not at PC). Changes from earlier in the day session:
   - TAX_RATE corrected to 3% (`0.03`), SETUP_FEE added at 2.5% (`0.025`)
   - Station fee base changed from material cost → sell price
   - Tax display labels updated across Transport, BM Flipper, Portfolio
   - RRR formula verified: basePB=18, focusPB=59 flat

#### Not completed (needs PC access)
- Crafting Revamp Phase 1 audit (full formula verification + refresh buttons) — two sessions blocked waiting for workspace approval

#### Next steps when at PC
1. Complete Crafting Revamp Phase 1 (formula audit + refresh buttons)
2. Wire ReadMail into loot tab matching (opcode research done, implementation is straightforward)
3. Fix expiry notification ItemID bug at `operation_read_mail.go:103`
4. Continue with Crafting Revamp Phase 2+ per roadmap

---

### April 9 — Chest Capture SOLVED + Weight Data (Latest)
- **Root cause found:** itemmap.json was stale — game update shifted ALL 11,964 numeric item IDs. Capture was correct all along, just displaying wrong names. Regenerated from latest ao-bin-dumps (April 1 2026 update).
- **Architecture rewrite:** Replaced timer-based EquipItem collection with global item cache (`sync.Map` keyed by slot number) + `evAttachItemContainer` param 3 slot lookup. Param 3 = `[globalSlotId_at_pos0, globalSlotId_at_pos1, ...]`. Same approach as Triky313/AlbionOnline-StatisticsAnalysis.
- **3 new item event handlers:** `evNewFurnitureItem` (33), `evNewKillTrophyItem` (34), `evNewLaborerItem` (36). Now 6 total. Mounts, furniture, trophies captured correctly.
- **Weight data:** Generated weightmap.json (11,235 entries) from ao-bin-dumps `@weight` field. Per-item + total tab weight in captures. Verified exact match (40.2 kg) against in-game.
- **Verified on personal island:** 4 tabs (Bank 109 items/589.4kg, loot 43/160kg, loot3 15/40.2kg, vanity 5/230.5kg), all items + crafter names + weights verified correct.
- **Code changes (uncommitted):** decode.go, operation_container_open.go (full rewrite), event_container_items.go (full rewrite), itemmap.go (weight loading), client.go (LoadWeightMap), itemmap.json (regenerated), weightmap.json (new)

### April 8 Evening — Chest Capture Debugging Session
- Investigated item mismatch across 6 test runs on guild island. Fixed default tab capture (evAttachItemContainer handler) and item timing (pre-buffer). Discovered the real issue was stale itemmap, not the capture mechanism.

### April 8 — Cowork/Dispatch Session
- **Phase 3: Lifecycle Tracker** — built and deployed: `loot_tabs` + `loot_tab_sales` DB tables, 5 API endpoints (save/list/record sale/get detail/update status), "I Bought This" button on loot eval results, tracking UI with progress %, net profit, status badges (open/partial/sold). JWT-authenticated. Confirmed live on VPS.
- **Freshness age bug** — fixed and deployed: `fresh-threshold-group` had `display:none` hardcoded in HTML; JS sync only fired on change events, never on init. Extracted `syncFreshThreshold()` called on page load.
- **Feedback/Bug Report feature** — built: Discord webhook form with Bug Report / Suggestion selector + message textarea, rate-limited 1/min per user. **CONFIRMED LIVE** (verified April 9 Cowork session) — `DISCORD_FEEDBACK_WEBHOOK` set, points to `#website-feedback`.
- **Crafting Profits Revamp** — full 5-phase plan added to roadmap (see Section 13 above). Phase 1 is the starting point for next session.

### April 7, Sessions 9-10 (Previous)
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
9. **GUID matching works perfectly** -- All 7 guild tabs + 1 bank tab matched by GUID on first try. Mixed-endian byte-swap was NOT needed. Sequential fallback was never triggered.
10. **EquipItem/SimpleItem events have NO container reference** -- Param 0=slot, 1=itemTypeID, 2=quality, 4=objectID, 5=crafter, 6=enchantment, 7=durability, 8=spells, 9=sockets, 10=unknown. No way to link an item to its container from the event alone.
11. **evAttachItemContainer param 3 is a slot map** -- Array of signed bytes listing which slots have items. Zeros = empty. Matches slot positions of EquipItem events. Param 4 = capacity (500 for guild tabs, 128 for bank).
12. **Game does NOT resend chest items on tab switch** -- It assumes the client cached them from earlier. EquipItem events after ContainerOpen may be from nearby containers, NOT from the opened tab.
13. **Never assume large captures are correct** -- 373 items in Loot 2 looked right but was never validated. Always test with known items.

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
