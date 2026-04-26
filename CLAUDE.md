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

### April 26 — Analytics Fix + Loot Logger Polish + Accountability UX — Latest

- **Analytics 7d query integer overflow fixed:** `CAST(min_sell - max_buy AS REAL)` inside the `SUM(…²)` variance term promotes the multiplication to double-precision float so it no longer overflows SQLite's 64-bit int range. Commit 099d3c2.
- **Loot logger tooltip dedup:** Two singleton tooltip systems (`data-tip` global + `data-tip-html` rich-tip) were both firing on `.ll-timeline-bar` hover, stacking at the same screen coords. Global handler now skips elements with `data-tip-html` — those are owned by the dedicated rich-tip handler.
- **Guild perspective selector:** New "Friendly guild" dropdown in the accountability action-bar lets users flip the auto-detected `primaryGuild`. Picking a different guild re-runs `runAccountabilityCheck` so all friendly/enemy tagging, deaths section, and deposit checks update. Persisted per-session in `localStorage` (`acc-guild-override-<sessionId>`); reset button and re-picking the auto guild drop the override.
- **"Lost" stat on player cards:** Each player card in the loot logger now shows the estimated market value of items the player died with (items looted off their corpse). Displayed in the card header stats row.
- **Accountability icon strip:** Player card headers now show a compact icon strip (same as regular session view) with per-item green/yellow/red borders reflecting deposit status at a glance.
- **Rich pickup tooltip with verified line:** Hover tooltip on missing items now shows: time, looter name + guild, zone (📍), and — when the item is verified by a chest log — a "✓ Verified by chest log (N/N)" line. Unverified items omit the verified line (no clutter). Commit 86bf4c3.
- **Prominent status badges:** ✓/✗ corner badges on accountability icon strip icons; green glow for deposited, red for missing.
- **5 scheduled cloud routines created:** Daily health sweep + weekly TODO+CHANGELOG audit (Mon), code quality sweep (Sun), security spot check (Wed), improvement suggestions (Fri). All read-only, fire at 07:00 Jerusalem (04:00 UTC). IDs logged in session file.
- **Zone-test binary built** (`albiondata-client-zone-test.exe`, 21.8 MB): dumps every OpJoin response param under `[ZONE-DIAG]` label. **NOT YET RUN IN-GAME.** Needed to identify which param now carries zone name (current mapstructure index "8" maps to empty on all 290 live session events tested).

### April 25 — process.abort() Amendment

- **SQLITE_BUSY Tier 1 amended:** Yesterday's `setTimeout(() => process.exit(1), 500)` didn't actually exit on the wedge — 43-min outage recovered via `systemctl kill`. Root cause: the async exit gave the event loop one more tick, which attempted another `db.serialize() + BEGIN` on the locked connection, re-entrancy wedge. Replaced with `process.abort()` (synchronous SIGABRT — no event-loop tick required). Systemd `Restart=always` catches the non-zero exit and restarts within 1s.
- **Skip `flushNatsBuffer()` in SQLite-fatal path:** Its `db.serialize() + BEGIN` on the locked connection was the second wedge step. Now skipped when `_aborting` flag is set.
- **`_aborting` re-entrancy guard:** Prevents a second `uncaughtException` from firing during the abort path.
- **Same `abort()` in RSS watchdog:** RSS-based OOM exit now also uses `process.abort()` instead of `process.exit`.

### April 24 — SQLITE_BUSY Stability Overhaul

- **Tiers 1+2+3+5 shipped** — complete overhaul of SQLite error handling and batch-write safety:
  - **Tier 1:** `uncaughtException` handler exits (`process.exit(1)`) on SQLite state-corruption errors for clean systemd restart — changed to `process.abort()` next day (see April 25).
  - **Tier 2:** All 7 batch-write sites (`recordSnapshots`, `computeSpreadStats`, `computeAnalytics`, loot ingestion, etc.) now wrap `BEGIN → prepare → run → finalize → COMMIT` in explicit error-callbacks with `ROLLBACK` on failure. No more silent partial transactions.
  - **Tier 3:** Batch sizes reduced — `recordSnapshots` 5000→500, `computeSpreadStats` 500→100 rows per transaction — limits the lock-hold duration per batch.
  - **Tier 5:** RSS watchdog exits at 8 GB to prevent 11 GB OOM from cascading into SQLITE_BUSY.
  - **Flag resets:** `analyticsRunning` + `dbBusy` now reset in the handler so the scheduler can retry after a clean restart.

### April 23 — Zone Tracking + Go Client v1.3.0

- **Go client v1.3.0:**
  - `CurrentZone string` field on `albionState` (RWMutex getter/setter).
  - `operationJoinResponse.Process` calls `state.SetCurrentZone(op.Location)` on every zone transition.
  - `LootEvent` gains `Location string json:"location"` — populated from `state.GetCurrentZone()`.
  - `DeathEvent` gains `Location string json:"location"` — same.
  - **v1.3.0 GitHub Release cut** via `git tag v1.3.0 && git push --tags` → GitHub Actions `tag-release.yml` fired.
- **Backend:** `location TEXT DEFAULT ''` column added to `loot_events` (CREATE TABLE + `ALTER TABLE` migration for existing DBs). WS loot-event and death-event ingestion both store `ev.location`. Accountability public share SELECT returns `location`.
- **Accountability deaths — 3 categories:** Friendly (victim in primary guild), Enemy (killer in primary guild), Other (bystanders — collapsed by default, grey styling). `buildDeathTimeline` now computes `wasKillerFriendly` and sets `isEnemy` / `isOther` flags.
- **Zone badge:** `📍 ZoneName` on each death card row when `location` is non-empty.
- **Missing-item tooltip:** Shows zone alongside pickup timestamp. Mobile tap-to-toggle supported.
- **SQLITE_BUSY:** `readDb` busy_timeout bumped 5s→30s.
- **Portfolio:** Completed craft runs section added — fetches `/api/craft-runs`, filters `status=complete`, renders collapsible table with cost/revenue/net P&L/margin.

### April 22 — Security Audit + Design Polish + Outage Recovery

- **FULL_AUDIT_2026-04-22.md — 17 findings fixed:**
  - CRITICAL: JWT never in URL — Discord OAuth now issues a 60s one-time exchange code; frontend calls `POST /api/auth/exchange`, token goes direct to localStorage, never hits browser history.
  - HIGH: `transportLiveLimiter` (5 req/min) + 30s server cache on live routes; health endpoints stripped to `{"status":"ok"}` only; `deviceCodes` map capped at 200 + per-IP rate limit; password reset token moved out of URL into modal flow.
  - MEDIUM: `escHtml()` for email templates, x-forwarded-for comma split, ADMIN_DISCORD_ID env constant, Chart.js SRI hash, password complexity check, loot upload 5k-line/2MB cap.
  - LOW/DevOps/Code: login rate limiter wired, SW CACHE_NAME auto-bump on deploy, Go `device_auth.go` rewritten with stdlib strings, toast callback registry (`_toastCallbacks`), toast stack cap (5), offline indicator, dynamic tab titles.
- **UI/Design improvements (separate branch, merged):**
  - Header shrunk ~60%, SEO line hidden (stays in DOM for crawlers). Timers moved from floating widget into status bar. Footer anchored with flex column layout. Dynamic browser tab title. Craft Runs empty state (shows 0/—). Market Flipping first-load placeholder. Loot logger restore banner auto-dismisses 30s. Crafter profile pill collapses to icon after first visit.
- **VPS outage #1:** Duplicate `loginLimiter` definition in merged backend.js → syntax error → 14h downtime. Removed, deployed, restored.
- **VPS outage #2:** `SQLITE_BUSY` chain swallowed by `uncaughtException` handler → event loop stalled silently for 22 min, ports alive but reads refused. Force-killed stuck PID, clean systemd restart. Root cause (WAL write contention between `statsDb` batch writes and `db` real-time writes) **unresolved — expected to recur**.
- **Go client v1.2.0 released** (ZvZ performance pass): `bufio.Writer` on loot file (drops per-event fsync), 30s aggregated log summary, `sync.Pool[*bytes.Buffer]` + `json.Encoder` in VPS relay, `atomic.Bool` for connected flag, reusable `*time.Timer`, `guidHex()` with `encoding/hex`, slice preallocs in vault info. ~30-50% CPU, ~80% disk I/O improvement. Published at https://github.com/coldtouch/albiondata-client/releases/tag/v1.2.0.
- **Loot Logger — Stop button fix:** Stop now auto-saves (calls `/api/loot-session/consolidate`) and renders the session. Previously just flipped a flag.
- **Accountability share — chest-log snapshot:** Added `chest_logs_json TEXT` column to `accountability_shares`. Share creation snapshots selected chest-log batches; public viewer restores them so recipients see the same verified-deposited badges as the owner.
- All committed + deployed to VPS.

### April 20 — Craft Runs Feature + Bug Fixes

**Craft Runs full pipeline tracker (buy→refine→craft→sell):**
- 3 new SQLite tables: `craft_runs`, `craft_run_transactions`, `craft_run_scans`
- 10 new API endpoints: CRUD on runs, add transactions, link tab scans, P&L summary, refine city helper, hideout bonus helper
- New "Craft Runs" tab in Trading group with full UI: run list cards, new run form, detail view with progress bar + P&L dashboard + transaction log, Add Transaction modal (6 types), advance status, delete
- Crafting Profits hideout enhancement: "Hideout (Black Zone)" option in city-bonus select reveals PL (0-8) + Core % (0-30) inputs; bonus = 15% base + PL×2% + core
- CSS: `.cr-*` classes for run cards, progress bar, P&L dashboard, txn table
- CHANGELOG.md + About tab (dual entries) + features-grid card

**Modal scroll fix + Escape handler (same session):**
- `.modal` CSS: `align-items: flex-start; overflow-y: auto` — tall modals now scroll
- Escape handler expanded from 3 to 11 modals (+ `cr-txn-modal`)

### April 20 — Security Hardening (Full Audit Remediation)
- **20 audit findings fixed** from FULL_AUDIT_2026-04-19.md across backend, frontend, and deploy script.
- **Backend:** trust proxy, admin guard on db-stats, upload cap, batch-prices rate limiter, news link URL validation, HTML-strip in san(), generic DB errors, 30-day share token expiry, SFTP for .env upload.
- **PY-H2:** Fixed broken `try:` syntax error left from previous session; SSH cleanup via `sys.excepthook`.
- **Frontend:** Two `e.message` XSS paths closed, foodBuff escaped, 30s fetch timeout, WS catch narrowed, localStorage try/catch, `_consumedFlips` pruned, `spreadStatsCache` size-capped, WS URL from `VPS_BASE`, IDB upgrade uses `DB_VERSION`.
- **SW:** v44→v45, cache-first→stale-while-revalidate, `updateViaCache:'none'`.
- **Cleanup:** 19 scratch files deleted, `.gitignore` updated.
- **Committed & pushed:** `claude/friendly-dubinsky` branch.

### April 10 — SEO + Discord Login Fix
- **SEO:** Full meta tag overhaul — expanded title, richer description, keywords, canonical, OG tags, Twitter Card, JSON-LD WebApplication schema, inline SVG favicon, robots.txt, sitemap.xml, og-image.png.
- **Discord login reliability:** `readDb` (OPEN_READONLY, third SQLite connection) for `/api/me` — no queue starvation. Frontend JWT fallback — when VPS unreachable, decodes token locally and logs user in from cached claims. Timeout 5s → 8s + 1 retry.
- **HANDOFF:** Fixed stale VPS RAM (was "1 GB", now 11 GB Contabo).

### April 9 — Mega Session
- **Root cause:** itemmap.json was stale — ALL 11,964 IDs shifted in game update. Regenerated from ao-bin-dumps April 1 dump.
- **Architecture rewrite:** Global item cache (sync.Map by slot) + evAttachItemContainer param 3 slot lookup. Same approach as Triky313's C# app.
- **3 new event handlers:** FurnitureItem (33), KillTrophyItem (34), LaborerItem (36) — 6 total. Mounts/furniture now captured.
- **Weight data:** weightmap.json (11,235 entries), per-item + total tab weight. Verified 40.2kg exact match.
- **Verified on personal island:** 4 tabs, all items + crafters + weights correct.
- **All committed and pushed.** Go client + website.
- **Loot Logger full pipeline:** Go client EvOtherGrabbedLoot + player tracking → VPS loot_events DB → website Loot Logger tab (live/upload/accountability). Saves .txt on exit. Delete sessions. Upload viewer works without login.
- **Weight data across website:** itemweights.json (11,535), Market Browser badges, Transport haul X/Y kg, Loot Buyer captures/items/sell plan.
- **GitHub Releases:** v1.0.0 released, CI working (Win/Linux/Mac).
- **Audit fixes #1-9 ALL COMPLETE:** analytics→statsDb, itemNames fix, XSS, abort controller, EMA+VWAP chart, stale badges, toast notifications, cross-feature links, price cache.
- **Delete tracked tabs + client docs rewrite.**

### Hotfix: Discord Login Broken During SpreadStats (April 9, 2026)
- **Root cause found**: `computeSpreadStats` did a 90-second `db.all()` GROUP BY query (203k rows from 3M+ price_averages) on the **main shared db connection**. The node-sqlite3 queue serializes ALL operations, so `/api/me` (5s AbortSignal.timeout) stalled behind it and timed out → user saw "Could not reach server" → Discord login appeared broken.
- **Fix**: Added `statsDb` — a separate `sqlite3.Database` connection for SpreadStats only. Both the big read (`statsDb.all()`) and all 526k write transactions (`statsDb.serialize()`) use `statsDb`. Main `db` queue is now completely unaffected during SpreadStats.
- **Cross-guards**: `computeAnalytics` now checks `statsRunning`, `computeSpreadStats` now checks `analyticsRunning` — prevents simultaneous heavy DB runs (both were firing at the exact same minute every hour).
- **No CPU/memory issue**: VPS was healthy (24% CPU avg, 2GB/12GB RAM, 0 CLOSE_WAIT). The issue was purely DB queue starvation.

### Transport Mount Capacity Fix (April 9, 2026)
- **`MOUNT_DATA` config object** added near constants: maps keys (`none`, `ox_t3`, `ox_t5`, `ox_t7`, `mammoth_t8`, `mammoth_saddled`, `ignore`) to `{weight, extraSlots, label}`. Centralizes all mount data.
- **Mammoth weight corrected**: 1,696 kg → 1,764 kg. Saddled Mammoth stays 2,308 kg.
- **Mammoth extra slots**: `extraSlots: 8` added for both Mammoth variants (mount bag). Added to `availableSlots` in `enrichAndRenderTransport()`. Comment notes in-game verification needed.
- **"No Mount" now 600 kg**: Was value=0 (treated as infinite weight), now `weight: 600` enforces base player bag limit.
- **HTML dropdown** switched from raw number values to string keys. `transport-mount-info` div shows live capacity info below the select.
- **`updateMountCapacityInfo()`** added; called on change and on init. Change event also triggers re-render if routes loaded.
- **Weight guards cleaned up**: Removed old `mountCapacity > 0 &&` from `maxByWeight`, haul plan `maxWt`/`maxWeight`/`extraWeight` lines. All weight limits now always apply.

### Workstream 2: Frontend Analytics (April 9, 2026)
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

### Done (April 9)
- [x] Chest capture — FULLY WORKING, all committed
- [x] Weight data — 11,535 items, verified exact match, displayed across website
- [x] Loot Logger — full pipeline (Go client + VPS + website tab)
- [x] GitHub Releases — v1.0.0, CI pipeline
- [x] Audit fixes #1-9 — ALL COMPLETE
- [x] Delete tracked tabs, client docs, toast system, cross-feature links

### Done (April 20)
- [x] FULL_AUDIT_2026-04-19.md remediation — 20 findings fixed (SEC/PY/FE phases 1+3+4)
- [x] PY-H2 syntax error fixed (broken try: block)
- [x] .env now uploaded via SFTP (PY-H1)
- [x] 19 scratch files deleted, .gitignore updated (CLEAN-1, CLEAN-4)

### Done (April 22)
- [x] FULL_AUDIT_2026-04-22.md remediation — 17 findings fixed
- [x] UI/Design polish — header, status bar timers, footer, empty states, tab title, profile pill
- [x] Go client v1.2.0 — ZvZ performance pass, GitHub Release published
- [x] Loot Logger Stop button auto-saves + renders session
- [x] Accountability share carries chest-log snapshot (`chest_logs_json` column)
- [x] VPS outage ×2 — both resolved (deploys + kill -9)

### Done (April 23–26)
- [x] Go client v1.3.0 released — zone tracking (CurrentZone on albionState, LootEvent.Location, DeathEvent.Location)
- [x] Backend: `location TEXT` column on `loot_events`, stored on WS loot + death ingestion
- [x] Accountability deaths — 3 categories: Friendly / Enemy / Other (bystanders, collapsed)
- [x] Zone badge (📍) on death cards, missing-item tooltip shows zone + pickup time
- [x] SQLITE_BUSY Tiers 1+2+3+5 — batch-write safety, uncaughtException exits, RSS watchdog
- [x] SQLITE_BUSY Tier 1 amended — `process.abort()` replaces `process.exit` (synchronous, no event-loop tick)
- [x] Analytics 7d query integer overflow — `CAST(… AS REAL)` fix
- [x] Loot logger: "Lost" stat, accountability icon strip, rich pickup tooltip with verified-by-chest-log line
- [x] Loot logger session timeline tooltip overlap resolved (rich-tip wins over global)
- [x] Guild perspective selector in accountability (persisted per-session, localStorage)
- [x] Portfolio: completed craft runs section (cost/revenue/net P&L/margin collapsible table)
- [x] 5 scheduled cloud routines created (daily health + 4 weekly audits, 07:00 Jerusalem)
- [x] Zone-test diagnostic binary built (`albiondata-client-zone-test.exe`) — NOT YET RUN IN-GAME

### Pending
- [x] **SQLITE_BUSY root cause fix** — DONE 2026-04-24. Tiers 1+2+3+5 shipped: `uncaughtException` exits on SQLite state-corruption errors for clean systemd restart; all 7 batch-write sites now wrap BEGIN→prepare→run→finalize→COMMIT in explicit error-callback + ROLLBACK; `recordSnapshots` batches 5000→500, `computeSpreadStats` 500→100; RSS watchdog exits at 8 GB to prevent 11 GB OOM scenarios. `analyticsRunning` + `dbBusy` now reset in the handler too.
- [x] **SQLITE_BUSY Tier 1 amendment (`process.abort()`)** — DONE 2026-04-25. Yesterday's `setTimeout(() => process.exit(1), 500)` exit didn't actually exit (43-min wedge today, recovered via SIGKILL + `systemctl start`). Replaced with `process.abort()` (synchronous SIGABRT — no event-loop tick or async cleanup required). Also skip `flushNatsBuffer()` in the SQLite-fatal path (its `db.serialize() + BEGIN` on the locked connection was the second wedge step). `_aborting` re-entrancy guard added. Same `abort()` switch in the RSS watchdog.
- [x] **SQLITE_BUSY — Tier 4** — DONE 2026-04-27 after another silent-wedge outage (PID 489379, ~10h dead with no FATAL log because the tx hung instead of throwing). Two-mechanism fix: (a) `withWriteLock(label, fn)` JS-side promise queue that serializes all batch writes across `db` + `statsDb`, eliminating cross-connection BEGIN contention; (b) per-tx 90s watchdog → `process.abort()` if `done()` not called, catches the silent-hang case the `uncaughtException` handler can't see. All 10 batch-write sites wrapped: recordSnapshots, NATS flush, spread-stats flushWrites, analytics flushBulk + EMA, compaction tier1→2 + tier2→3, backfill, priceRefCache init + incremental.
- [x] **Analytics 7d query — `SQLITE_ERROR: integer overflow`** — DONE 2026-04-26. `CAST(min_sell - max_buy AS REAL)` on one operand in the `SUM((min_sell - max_buy)²)` term at [deploy_saas.py:5139](deploy_saas.py:5139) promotes the multiplication to double-precision float so it accumulates safely. Variance/stddev downstream loses no meaningful precision.
- [x] **Accountability missing-item hover tooltip** — DONE (2026-04-23). Time + looter + guild + zone (📍 pin) now render on hover of any missing item in the accountability player card.
  - Go client v1.3.0 sends `location` (zone) on every `LootEvent` and `DeathEvent` via `state.GetCurrentZone()`.
  - Backend: added `location TEXT DEFAULT ''` column to `loot_events` (ALTER is idempotent for existing DBs), updated 3 INSERTs (WS loot, WS death, merge-sessions copy) and the accountability-share SELECT to carry location end-to-end.
  - Frontend: `evsByPlayerItem[name][itemId]` now stores `{ts, location}` objects; tooltip renders each pickup as `At: HH:MM:SS · 📍 Zone` (zone omitted if blank, so old pre-v1.3 events still render cleanly).
- [ ] **Craft Runs — Tab Scan linking UI** — frontend flow to link a chest capture to an active run (backend endpoint exists at `POST /api/craft-runs/:id/scan`)
- [ ] **Craft Runs — Portfolio integration** — completed runs appear in Portfolio Tracker with full cost basis
- [ ] **Craft Runs — Refining Planner** — auto-suggest city from material type, batch calculator (backend `/api/refine/optimal-city` exists)
- [ ] **Loot Logger Viewer UX** — better layout, sorting, filtering, player search, total value estimates
- [x] **Loot Logger — session timeline tooltip overlap** — DONE 2026-04-26. Two singleton tooltip systems both fired on `.ll-timeline-bar` hover (rich-tip via `data-tip-html` + global tooltip via `data-tip`), stacking at the same screen coords. Global handler now skips elements that have `data-tip-html` — those are owned by the dedicated rich-tip handler. Verified via synthetic-element test: dual-attr bars render only the rich tooltip, plain `data-tip`-only elements still get the global one.
- [x] **Loot Logger — Guild perspective selector** — DONE 2026-04-26. New "Friendly guild" dropdown in the accountability action-bar lists every guild seen in the session (sorted by item count, auto-pick marked `(auto)`). Picking a different guild flips `primaryGuild`, clears `primaryAlliance` (guild-only matching), and reruns `runAccountabilityCheck` so `isGuildMember`, primary-guild banner, deaths section, and friendly/enemy tagging all update. Persisted per-session in `localStorage` (`acc-guild-override-<sessionId>`); reset button + picking the auto-detected guild both drop the override.
- [ ] **Loot Logger — verify death-zone display still works** — 2026-04-23 we shipped the missing-item hover tooltip showing time/looter/guild/📍 zone (Go client v1.3.0 sends `location` on every LootEvent + DeathEvent; backend stores `location TEXT`; frontend reads `evsByPlayerItem[name][itemId].location`). User reports it may have regressed — open a recent uploaded session in the loot logger, hover a missing item, and confirm the 📍 Zone line renders. If broken, check whether (a) Go client is still emitting location, (b) backend is still persisting it through to the response, (c) frontend is still reading the `.location` field on the new event-object shape.
- [ ] **Device Auth end-to-end test**
- [ ] **Test chest capture on guild island**
- [ ] **ReadMail opcode** → auto-match sold items to tracked loot tabs
- [ ] **Negative item ID cosmetic names** — identify -56, -59, -62, -63, -64, -65, -68, -71, -121 from in-game bank

### In-Game Testing Required
- [ ] **Device Auth end-to-end test** — device code flow from Go client to browser approval
- [ ] **Verify negative item ID mappings** — IDs -1 to -9 are guesses. Also discovered IDs far beyond -9: -54, -57, -60, etc.
- [ ] **Castle chest + Outpost chest capture** — test whether existing chest capture handlers (BankVaultInfo / GuildVaultInfo / container events) fire for castle and outpost chests, or if those use different opcodes. If they don't fire, capture the relevant opcodes with Wireshark/debug logging and add handlers.

### Investigation Required
- [ ] **Capture .4 enchanted material gathering** — determine if the Go client can detect when players gather .4 (enchanted) resources. Check whether the gathering event includes enchantment level; if so, wire it into loot logger and accountability. Need to identify the relevant opcode and verify in-game.
- [ ] **Nearby Castle Chest rarity + Outpost scout feature** — when a user running our client opens the in-game world map, capture what castle chests (and their rarity/color tier — e.g. green/blue/purple/gold) and outposts are near them. Surface this on the website as a live scouting overlay so guilds can prioritize targets. Requires: (a) packet research — does the map-open handshake emit chest rarity + outpost state, or is it only a static map render? Check for new opcodes fired on map open (likely `EvMapInfo` / `EvOutpostUpdate` / a castle-objective event); (b) if the data isn't in the map handshake, check whether periodic objective broadcasts carry rarity/ownership; (c) Go client handler + VPS relay; (d) website tab for the live scouting board. Blocked on in-game packet capture / Wireshark verification first.

### Short Term
- [ ] **ReadMail opcode handler** — capture sale mail notifications, auto-match to tracked loot tabs
- [ ] **Go client GitHub Releases** — automated builds via GitHub Actions
- [ ] **Multi-file loot log merging** — allow users to upload multiple .txt loot log files (from different guild members running the client) and merge/cross-reference them into a single unified session. Use case: player A dies mid-fight and stops capturing, player B picks up the rest. Needs: deduplication by timestamp+item+player (same event captured by two clients), unified timeline view, accountability check across the merged dataset. Improves accuracy since no single client captures everything if the operator dies.

### Major New Feature — Loot Logger Viewer
- [ ] **Go client:** Port EvOtherGrabbedLoot (275), EvNewCharacter (29), EvCharacterStats (143), OpInventoryMoveItem (29)
- [ ] **Website tab:** Upload .txt files OR live data. Per-player breakdown with market values.
- [ ] **Loot Accountability Check:** Cross-reference loot log vs chest deposit → who picked up items that weren't deposited
- [ ] **Source repo:** https://github.com/coldtouch/ao-loot-logger (GPL-3.0, local: D:\Coding\ao-loot-logger\)
- [ ] **Txt format:** `timestamp_utc;looted_by__alliance;looted_by__guild;looted_by__name;item_id;item_name;quantity;looted_from__alliance;looted_from__guild;looted_from__name`

## Learned Patterns & Observations
> Accumulated knowledge from working sessions. Add new observations here.

- **node-sqlite3 serializes ALL db operations on one connection** — a long-running `db.all()` (even seconds) blocks ALL other `db.get()`/`db.run()` calls queued after it. Three-connection pattern: `db` (main writes), `statsDb` (bulk analytics/spreadstats), `readDb` (OPEN_READONLY, `/api/me` and other user-facing reads). WAL mode allows true concurrent reads on separate connection objects. WAL helps at the OS level but NOT at the node-sqlite3 queue level.
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

## Agent Coding Principles (Karpathy-inspired)

> Adopted April 20, 2026. These principles guide how Claude sessions approach work on this project.

1. **Think Before Coding** — Don't assume. Surface confusion, ask clarifying questions, identify tradeoffs before writing code. If a requirement is ambiguous, stop and clarify rather than guessing.

2. **Simplicity First** — Minimum code that solves the problem. No speculative abstractions, no flexibility that wasn't requested. If 200 lines could be 50, rewrite. Ask: "Would a senior engineer say this is overcomplicated?"

3. **Surgical Changes** — Only touch what you must. Clean up only your own mess. Don't refactor unrelated code in the same commit. Keeps changes reversible and reviews clean.

4. **Goal-Driven Execution** — Define what success looks like, not just what to do. Transform imperatives into verifiable goals:
   - Instead of "fix the bug" → "reproduce in test, then fix, verify test passes"
   - Instead of "add validation" → "write tests for constraints, then implement until tests pass"

5. **Eval Loops for Critical Features** — For big features, define acceptance criteria upfront → implement → test against criteria → analyze failures → improve → re-test. Especially valuable for multi-phase features.

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
