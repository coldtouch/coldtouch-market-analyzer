# Coldtouch Market Analyzer — Project Context

> **Purpose:** This file gives any new Claude session instant context about the project.
> **INSTRUCTIONS FOR EVERY SESSION:**
> 1. Read this file FIRST before doing any work
> 2. At the END of each session, update: "Recent Session History", "TODO / Unfinished Work", and "Learned Patterns" sections
> 3. If a TODO item is completed, check it off `[x]` and move it to the session history
> 4. If new issues/patterns are discovered, add them to "Learned Patterns"
> 5. See also: `HANDOFF.md` for deep-dive reference (API endpoints, DB schema, Go client architecture, background jobs, in-memory caches)

## Project Overview

**Albion Online Market Analyzer** — a full-stack SaaS web app for analyzing the in-game economy of Albion Online.

- **Live site:** https://albionaitool.xyz
- **GitHub Pages mirror:** https://coldtouch.github.io/coldtouch-market-analyzer/
- **GitHub repo:** https://github.com/coldtouch/coldtouch-market-analyzer
- **Owner:** Coldtouch (yuvalvilensky@gmail.com, Discord-linked)

## Architecture

### Frontend (Vanilla SPA — no framework, no build step)
- `app.js` (~346KB, ~7,128 lines) — entire frontend logic
- `index.html` (~145KB) — all HTML structure
- `style.css` (~88KB) — custom CSS, glassmorphism dark theme
- `db.js` (~15KB) — IndexedDB wrapper for client-side price caching

### Backend (Node.js embedded in Python deploy script)
- `deploy_saas.py` (~136KB, ~3,046 lines) — contains the ENTIRE backend as a Python string + SFTP deploy logic
- **There is no separate backend.js in the repo** — it only exists on the VPS after deploy
- Express + JWT auth + SQLite + NATS + Discord bot + WebSocket + live flip detection, all in one Node process

### Game Client (Go)
- `../albiondata-client-custom/` — forked Albion Data Client
- Custom additions: chest/vault capture, GUID-based tab identification, WebSocket relay to VPS, OAuth Device Flow
- Key files: `operation_container_open.go`, `event_vault_info.go`, `event_container_items.go`, `vps_relay.go`, `device_auth.go`, `itemmap.go` (11,697 items)
- Build: `export PATH="$PATH:/c/Go/bin" && cd D:\Coding\albiondata-client-custom && go build -v ./...`

### Other Repos
- `../ao-bin-dumps/` — game data dumps (items.xml, items.json, recipes.json)

## Infrastructure

- **VPS (current):** Contabo VPS 20, **IP: 5.189.189.71**, Ubuntu, **11 GB RAM, 6 vCPUs, 96 GB disk** (migrated April 4 from DigitalOcean)
- **VPS (old):** 209.97.129.125 (DigitalOcean 1vCPU/1GB, decommission pending)
- **Domain:** albionaitool.xyz (Let's Encrypt SSL, certbot auto-renewal)
- **Systemd service:** `albion-saas` at `/opt/albion-saas/`
- **Game Server:** Europe (configurable via `GAME_SERVER` env var)
- **Deploy:** `python deploy_saas.py` — SFTP uploads backend.js + restarts service
- **NATS:** `nats://public:thenewalbiondata@nats.albion-online-data.com:24222`
- **Firewall:** UFW — ports 22 (SSH), 80 (certbot), 443 (HTTPS)

## Database Schema (SQLite)

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

## Key Features (24 Tabs)

### Market Group
- **Market Browser** — browse 11k+ items, search/filter, per-city prices
- **Market Flipping** — cross-city arbitrage with confidence badges, freshness filter
- **BM Flipper** — Black Market specific flip finder
- **City Comparison** — side-by-side prices, 24h/7d/4w charts
- **Top Traded** — 7-day volume rankings from Charts API
- **Item Power** — silver-per-IP ratio comparison
- **Favorites** — saved item lists with cross-city comparison

### Crafting Group
- **Crafting Profits** — recipe lookup, material costs, save/load setups
- **Journals Calculator** — labourer journal profits (10 types, T3-T8)
- **RRR Calculator** — resource return rate with spec/city/focus
- **Repair Cost** — estimates by tier/enchant/quality/durability

### Trading Group
- **Transport Routes** — bulk haul planner with weight/slots/budget, live + historical modes, sell strategy toggle, freshness filter, copy shopping list
- **Live Flips** — real-time flip detection via NATS, city/type filters, sound + desktop notifications
- **Portfolio Tracker** — FIFO cost basis, realized P/L, CSV export (localStorage)
- **Loot Buyer** — 3-phase system:
  - Phase 1: Buy Decision Helper (verdict: buy/maybe/skip, risk badges, margin %)
  - Phase 2: Sell Optimizer (per-item sell strategy, 85% instant/market threshold, trip grouping, copy buttons)
  - Phase 3: Lifecycle Tracker (track tabs, record sales, progress bars, status badges)

### Game Tools Group
- **Mounts Database** — all mounts with live prices
- **Farm & Breed** — crop/herb/animal profit calculator
- **Community Builds** — from AlbionFreeMarket API

### System
- **Alerts** — Discord bot alert configuration (per-channel, confidence threshold, cooldown)
- **Community** — leaderboard, tier badges (Bronze/Silver/Gold/Diamond)
- **Profile** — avatar, stats, settings, capture token, Discord linking
- **Feedback** — floating FAB, sends to Discord webhook
- **About** — in-website changelog

## Background Jobs (Server-Side)

| Interval | Job |
|----------|-----|
| 5 min | Market scan — fetch prices, write snapshots, detect flips |
| 5 min | User stats — aggregate 30-day scans, assign tiers |
| 10 min | Price reference rebuild — cityPriceRef + globalPriceRef |
| 1 hour | Spread stats — confidence per item/city pair |
| Daily | Compaction — delete snapshots >6h, aggregate, prune old stats |
| Continuous | NATS stream — buffer + batch-write every 60s, flip detection |

## Recent Session History

### Workstream 2: Frontend Analytics (April 9, 2026 — Latest)
- Chart modal now has **Live Prices / Analytics** tab toggle. Analytics tab fetches `/api/price-history`, computes SMA 7d (gold) and SMA 30d (blue) client-side, renders with Chart.js. Updates on city change and time toggle (7d/30d).
- **Trend arrows** on Market Flipper + BM Flipper cards: `<span data-trend-item="...">` placeholder filled asynchronously via `fetchAnalytics()` → `/api/analytics/:itemId` → `cities[*].price_trend` averaged. Green ▲ >2%, red ▼ <-2%, neutral dash.
- **Volatile badge** on Market Flipper, BM Flipper, Transport cards: `getVolatilityBadge(consistencyPct)` — orange "VOLATILE" if `consistencyPct < 50` (route profitable <50% of 7-day scans). No extra API call — uses existing spread_stats data already in `spreadStatsCache`.
- New helpers: `getTrendBadge()`, `getVolatilityBadge()`, `fetchAnalytics()`, `prefetchTrendBadges()`, `computeSMA()`, `renderAnalyticsChart()`
- New CSS: `.trend-badge`, `.trend-up/down/neutral`, `.volatile-badge`, `.chart-tab-bar`, `.chart-tab-btn`, `.analytics-legend*`

### Workstream 1B: Analytics Computation Engine (April 9, 2026)
- New tables: `price_analytics` (pre-computed metrics) and `price_hourly` (OHLC hourly)
- `computeAnalytics()`: runs every 30min. SMA 7d/30d, EMA 7d (α=0.25), VWAP 7d, price trend, spread volatility. Bulk SQL pass + batched EMA with event-loop yields.
- `compactOldData()` rewritten: 3-tier retention — raw hourly 7d → `price_hourly` 30d → daily forever. Each tier deletes migrated rows after insertion.
- `checkDiskUsage()`: adaptive compaction at 10 GB (3d raw retention) and 20 GB (1d emergency).
- New endpoint: `GET /api/analytics/:itemId` (optional city/quality params)
- Upgraded: `GET /api/price-history` now returns `{ history, ohlc, analytics }` — app.js updated with backward-compat shim
- New endpoint: `GET /api/admin/db-stats` (JWT-protected)
- Background job schedule: SpreadStats @10min, Compaction+DiskCheck @25min, Analytics @35min

### Workstream 1A: VPS constraints lifted + analytics engine (April 9, 2026)
- Node heap: `--max-old-space-size` raised 2048 → 6144 MB (Contabo VPS 20: 11 GB RAM, 6 vCPUs)
- `computeSpreadStats` rewritten: SQL `GROUP BY (item_id, quality, city)` replaces 1M-row JS-side loop; one aggregated row per city instead of one per hourly period — drastically lower memory
- Removed `LIMIT 1000000` cap (no longer needed with aggregation approach)
- Added 4 composite indexes: `idx_pa_item_city_ts`, `idx_pa_spread_query` on price_averages; `idx_ss_item_quality` on spread_stats (all `IF NOT EXISTS`)
- Added `runWalCheckpoint()` every 6 h — `PRAGMA wal_checkpoint(TRUNCATE)` to prevent WAL bloat
- CHANGELOG.md + About tab in index.html updated

### Crafting Revamp Phase 1 (April 9, 2026)
- Global tax rate fix: `TAX_RATE` 0.065 → 0.03 (3% market tax), added `SETUP_FEE = 0.025` (2.5% listing fee)
- Crafting profit: station fee base changed from material cost → sell price (matches Albion mechanic)
- Crafting: tax now uses TAX_RATE + SETUP_FEE = 5.5% for sell orders
- Transport: insta-sell shows "Tax (3%)", sell orders show "Tax+Setup (5.5%)", `soTax` fixed to 5.5%
- Transport route enrichment: effectiveTaxRate varies by sellMode (instant=3%, market=5.5%)
- BM journal flipper: sell order soTax corrected to 5.5%
- Portfolio: Net P/L tax estimate corrected to 5.5%
- City Compare refresh button: already existed and works correctly (Task 2 was already done)
- RRR formula verified: basePB=18 (15.25% RRR ≈ 15.2% ✓), focusPB=59 flat ✓
- CHANGELOG.md + About tab in index.html updated

### Code Tab Sessions 9-10 (April 7, 2026)
- Deployed all pending changes (3 deploys). SMTP confirmed working.
- Inline sale recording form (replaced prompt() with item dropdown)
- Unknown items mapped (-1 to -9 in Go client, filtered from captures, backend fallback names)
- Sell plan travel route suggestion (geography-based for multi-city sells)
- Manual item entry on Loot Buyer (autocomplete, quality/qty, duplicate merging)
- Live flip false positives fix (BM 3-min freshness, 4x outlier, always-validate)
- Portfolio XSS hardened (encodeURIComponent, data-attr delegation)
- Mobile responsive breakpoints for newer features
- Custom client download page in About tab (setup guide, AODP comparison)
- Capture mode toggle in Go client (--capture flag, config.yaml)
- Feedback webhook → dedicated #website-feedback Discord channel
- Forked ao-loot-logger → https://github.com/coldtouch/ao-loot-logger (D:\Coding\ao-loot-logger\)
- Go client exe built and ready: D:\Coding\albiondata-client-custom\albiondata-client-custom.exe

### Code Tab Sessions 5-8 (April 7, 2026)
- Feedback & Bug Report system, Market Flipper freshness fix
- Phase 3: Lifecycle Tracker, Phase 2: Sell Optimizer, Phase 1: Buy Decision Helper
- Loot Buyer tab name fix (tabIndex), Go client tab index tracking

### Previous Sessions
- April 6: Transport freshness, live flip validation, volume awareness, sell strategy, historical analytics
- April 5: Email verification, user profile, live flips, user registration, Discord alert gating
- April 4: Critical DB bloat fix (22M rows → 100% CPU), compaction overhaul
- April 3: Manual OAuth2, custom domain albionaitool.xyz

## TODO / Unfinished Work

### Immediate — In-Game Testing Required
- [ ] **Live game test of chest capture** — Go client → WS → VPS → frontend. Test GUID matching, tab names, item accuracy. If GUID matching fails, try mixed-endian byte-swap. Exe ready at `albiondata-client-custom.exe -debug`
- [ ] **Device Auth end-to-end test** — device code flow from Go client to browser approval
- [ ] **Verify negative item ID mappings** — IDs -1 to -9 are guesses, need live verification

### Short Term
- [ ] **ReadMail opcode handler** — capture sale mail notifications, auto-match to tracked loot tabs
- [ ] **Go client GitHub Releases** — automated builds via GitHub Actions

### Major New Feature — Loot Logger Viewer
- [ ] **Go client:** Port EvOtherGrabbedLoot (275), EvNewCharacter (29), EvCharacterStats (143), OpInventoryMoveItem (29)
- [ ] **Website tab:** Upload .txt files OR live data. Per-player breakdown with market values.
- [ ] **Loot Accountability Check:** Cross-reference loot log vs chest deposit → who picked up items that weren't deposited
- [ ] **Source repo:** https://github.com/coldtouch/ao-loot-logger (GPL-3.0, local: D:\Coding\ao-loot-logger\)
- [ ] **Txt format:** `timestamp_utc;looted_by__alliance;looted_by__guild;looted_by__name;item_id;item_name;quantity;looted_from__alliance;looted_from__guild;looted_from__name`

## Learned Patterns & Observations
> Accumulated knowledge from working sessions. Add new observations here.

- **VPS now has 11 GB RAM, 6 vCPUs (Contabo VPS 20)** — Still avoid loading large result sets into memory (April 4 incident: 22M rows, 100% CPU for 12h). Use SQL aggregation over JS-side loops wherever possible.
- **Backend is embedded in deploy_saas.py** — no separate backend.js in repo, only exists on VPS after deploy
- **Deploy via SFTP, not base64 echo** — base64 via echo truncates at ~100KB. Always use SFTP
- **`esc()` on ALL external data in innerHTML** — multiple XSS passes done, every new feature needs same treatment
- **NATS `sample_count` is NOT volume** — it's data frequency. Labeled "24h Activity" to avoid misleading users
- **Discord OAuth was painful** — passport → manual OAuth, sessions → JWT. Current stateless JWT works well, don't revert
- **Go PATH not in system PATH** — every Go command needs `export PATH="$PATH:/c/Go/bin"`
- **Vault info fires for ALL chests** — BankVaultInfo/GuildVaultInfo fire when approaching any chest. Match by GUID or use separate guild/bank vars
- **2-day cityPriceRef** (not 7-day) — more accurately reflects current market conditions
- **85% threshold for sell strategy** — if instant sell is within 15% of market listing, take the certainty
- **IndexedDB data older than 24h is auto-purged** on the frontend
- **Go client GUID matching is fragile** — falls back to sequential tab index when matching fails
- **VPS debugging: check CPU first** — don't chase symptoms (OAuth failures, timeouts). Run `ps aux | grep node` first. Multiple sessions were wasted investigating code that wasn't broken when the real issue was 100% CPU from computeSpreadStats
- **Never run destructive SQLite ops over raw SSH** — use `nohup`/`screen`. SSH timeout mid-transaction corrupted 4GB DB, lost 3.1M rows of price_averages
- **SMTP is already configured and working** — Gmail app password (yuvalvilensky4), verification emails sending
- **Git identity:** `Coldtouch <coldtouch@users.noreply.github.com>`
- **Always update 3 things after work:** CHANGELOG.md + in-website changelog in About tab (index.html) + features-grid if new feature. User had to remind about this when it was missed during Transport release

## Standard Workflow (After Any Work)
1. Update `CHANGELOG.md` with dated section
2. Add matching entry to changelog-list in `index.html` About tab
3. If new feature: add feature-card to features-grid in About tab
4. `git add` specific files, commit, push to origin/main
5. If backend changed: `python deploy_saas.py` to deploy

## Decisions Made (and Why)

| Decision | Reasoning |
|----------|-----------|
| Vanilla JS, no framework | Simple deployment, no build step, one-file frontend |
| Backend embedded in deploy script | Single `python deploy_saas.py` deploys everything |
| Stateless JWT (no sessions) | Works cross-origin (GitHub Pages + VPS) |
| Manual Discord OAuth | Passport-discord had no timeouts, caused hangs |
| WebSocket to VPS (not private NATS) | Simpler than running separate NATS for custom data |
| OAuth Device Auth for Go client | Users don't need to manually copy/paste tokens |
| Only collect items after ContainerOpen | Prevents ghost captures from zone loading |
| 2-day cityPriceRef | More accurate than 7-day for current market |

## Key Files Quick Reference

### Website (`D:\Coding\albion_market_analyzer\`)
| File | What it does |
|------|-------------|
| `app.js` | All frontend logic (346KB) |
| `index.html` | All HTML structure (145KB) |
| `style.css` | All styles (88KB) |
| `deploy_saas.py` | Backend + deploy script (136KB) |
| `db.js` | IndexedDB client-side cache |
| `CHANGELOG.md` | Detailed history of all changes |
| `HANDOFF.md` | Deep reference (API endpoints, caches, Go client details) |
| `.env` | Environment variables (secrets) |
| `items.json` | Item dictionary (667KB) |
| `recipes.json` | Crafting recipes (1MB) |

### Game Client (`D:\Coding\albiondata-client-custom\`)
| File | What |
|------|------|
| `client/decode.go` | Opcode routing |
| `client/operation_container_open.go` | ContainerOpen + SubContainer handlers |
| `client/event_container_items.go` | Item event handlers + itemCollector |
| `client/event_vault_info.go` | Vault tab parsing + GUID matching |
| `client/vps_relay.go` | WebSocket relay to VPS |
| `client/device_auth.go` | OAuth Device Flow |
| `client/itemmap.go` | Numeric-to-string item mapping (11,697 items) |
