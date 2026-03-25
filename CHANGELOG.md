# Changelog

All notable changes to the Coldtouch Market Analyzer will be documented in this file.

### 2026-03-25 — Phase 3: Community Scanning Incentives

#### Backend (VPS)
- **Contribution Tracking**: Every item refresh (web or Discord `/scan`) is recorded in a `contributions` table, attributing scans to Discord users.
- **User Stats Engine**: `recomputeUserStats()` runs every 5 minutes, aggregating 30-day scan counts and assigning tier ranks (Bronze 0-49, Silver 50-199, Gold 200-499, Diamond 500+).
- **Leaderboard API**: `GET /api/leaderboard` returns top 20 scanners with 60-second in-memory cache. `GET /api/my-stats` returns the logged-in user's rank, tier, and scan counts.
- **Contribution API**: `POST /api/contributions` (rate-limited 30/min) accepts scan events from the frontend.
- **`/api/me` Enhanced**: Now returns the user's tier alongside login info.
- **Contribution Cleanup**: Old contribution records (>60 days) are pruned during the daily compaction job.

#### Discord Bot
- **`/scan` Command**: Scan any item by name directly from Discord — fetches live prices and records the contribution.
- **`/leaderboard` Command**: Shows top 10 community scanners with tier badges and scan counts.
- **`/mystats` Command**: Shows personal scanning stats including tier, 30-day scans, all-time scans, and server rank.

#### Frontend
- **Community Tab**: New "Community" navigation tab with a full leaderboard UI showing top 20 scanners ranked by 30-day activity.
- **My Stats Card**: Logged-in users see their personal stats (rank, scans, tier) with a visual tier progression bar.
- **Tier Badges**: Bronze/Silver/Gold/Diamond tier badges displayed next to Discord username in the header and throughout the Community tab.
- **Contribution Tracking**: Every item refresh button click automatically records a contribution when the user is logged in via Discord OAuth.
- **Tier Progression Bar**: Visual progress bar showing how close the user is to the next tier threshold.

---

### 2026-03-25 — Phase 2: Enhanced Alert System

#### Discord Bot
- **Reliability in Alerts**: Every alert now includes a Reliability field showing the historical confidence score, consistency %, and sample count (e.g., "🟢 85% High — profitable 92% of the time (48 samples over 7d)").
- **Confidence-Based Colors**: Alert embed color reflects both profit AND confidence — green for high-confidence profitable routes, orange/yellow for medium, grey for low or unknown.
- **`/setup_alerts` Confidence Option**: New optional `min_confidence` parameter when setting up alerts (0=any, 40=medium, 70=high only).
- **`/set_confidence` Command**: Change the confidence threshold for an existing alert channel at any time.
- **Noise Reduction**: Routes below the channel's confidence threshold are automatically suppressed — no more alerts for unreliable flips that have historically been unprofitable.
- **`/my_alerts` Enhanced**: Now shows confidence threshold alongside profit and cooldown settings.

---

### 2026-03-25 — Phase 1: Historical Spread Analyzer

#### Data Sources (4 total)
- **Server Scan Snapshots**: Every 5-min scan persists ~130k price snapshots to SQLite on disk.
- **Charts API Backfill**: On first start, fetches 28 days of daily averages from the Albion Data Project for all 11,115 items — 1,006,565 historical records loaded instantly.
- **History API**: Fetches 6-hour granularity data for more granular recent coverage.
- **NATS Live Order Snapshots**: All incoming real-time market orders (~1,000+/min) are buffered and batch-written to snapshots every 60 seconds, filling gaps between full scans.

#### Backend (VPS)
- **Price Snapshot Recording**: Every 5-minute server scan now persists ~130k price snapshots to SQLite on disk, building a historical price database over time.
- **Spread Statistics Engine**: Hourly job computes spread statistics for every item/city-pair combo over a 7-day window — average spread, consistency %, median profit, and a composite confidence score (0-100).
- **Data Compaction**: Daily job compacts raw snapshots into hourly averages after 7 days and daily averages after 30 days, keeping the DB at ~50-100MB steady state.
- **New API Endpoints**: `/api/spread-stats`, `/api/spread-stats/top`, `/api/price-history` serve historical analysis data to the frontend.

#### Frontend
- **Confidence Badges**: Market Flipping cards now display a historical confidence badge (green High / yellow Mid / red Low) showing how reliably profitable each route has been over the past 7 days.
- **"Profitable X% of the time"**: Each flip card shows the historical consistency — e.g., "Profitable 82% of the time" with sample count and average spread on hover.
- **Sort by Confidence**: New dropdown to sort flips by Highest Profit (default), Highest Confidence, or Highest ROI.
- **Min Confidence Filter**: Filter out low-confidence routes with a minimum threshold selector (Any, 20%+, 40%+, 60%+, 80%+).

#### Session Persistence
- **Persistent Discord Login**: Sessions now stored in SQLite with 30-day cookie, surviving server restarts and deploys. Session secret preserved across deploys.

---

### 2026-03-25 — Discord Bot Overhaul

#### Discord Bot
- **Alerter Seeded from Server Scans**: The alerter now starts with full market coverage (~125k price points) from the 5-minute server scans instead of building from scratch via NATS stream.
- **Freshness-Gated Alerts**: Alerts only fire when at least one side (buy or sell) has data fresher than 30 minutes, eliminating stale/misleading notifications.
- **Friendly Item Names**: Alert embeds now show item names (e.g. "Elder's Claymore") instead of raw IDs, plus item thumbnails.
- **ROI in Alerts**: Each alert now shows profit percentage (ROI) alongside the silver amount.
- **Color-Coded Severity**: Embed color reflects profit level — green (<100k), gold (100k-500k), red (>500k).
- **Data Age in Alerts**: Each alert shows how old the buy/sell prices are (e.g. "3m ago", "just now").
- **Website Link**: Each alert embed links to the Coldtouch Market Analyzer website.
- **Configurable Cooldown**: `/setup_alerts` now accepts an optional `cooldown` parameter (minutes between alerts per item, default 10 min, was hardcoded at 30 min).
- **`/my_alerts` Command**: Shows all active alert configurations for the current server.
- **`/status` Command**: Shows bot stats — items tracked, price points, alerts sent, last alert time, and market scan info.
- **Improved Embed Formatting**: All bot responses use rich embeds with consistent styling and footer branding.

---

### 2026-03-25 — Smart Market Data Pipeline

#### Changed
- **Server Cache Always Loads**: All users now get fresh server-scanned data on every page load, not just first-time visitors.
- **Background Auto-Refresh**: Frontend silently pulls the latest server cache every 5 minutes and refreshes the browser view.
- **Instant "Scan All Market"**: Button now pulls pre-built server cache instantly (~1s) instead of making 112 sequential API calls from the browser (~2min).
- **Stale Data Eviction**: IndexedDB entries older than 24 hours are automatically purged on load and every 5 minutes.
- **Live db-status Indicator**: The "prices cached" status now auto-refreshes every 60 seconds.

---

### 2026-03-25 — VPS Hardening & UI Fix

#### Infrastructure
- **VPS Upgrade Optimizations**: Tuned backend for 1 GB RAM plan — reduced scan throttle (500ms → 100ms), removed GC pause, increased scan frequency (10min → 5min), adjusted heap limit to 400 MB.
- **Swap Space**: Added 512 MiB swap as OOM safety net, persisted in fstab.
- **UFW Firewall**: Enabled firewall allowing only ports 22 (SSH) and 443 (HTTPS).
- **Certbot Auto-Restart**: Added deploy hook to automatically restart the backend when SSL certificates are renewed.
- **Dead Service Cleanup**: Removed vestigial `albion-proxy` and `albion-alerter` systemd services and `/opt/albion-proxy/` directory.

#### Security
- **Secrets Externalized**: Moved Discord bot token, client secret, and session secret out of source code into a server-side `.env` file (chmod 600) loaded via systemd `EnvironmentFile`.
- **Strong Session Secret**: Replaced hardcoded `'albion-secret'` with a random 64-character hex token.
- **API Rate Limiting**: Added `express-rate-limit` (60 req/min per IP) on all `/api/` endpoints.
- **Alert Auth Gate**: GET/POST/DELETE `/api/alerts` now require Discord OAuth login.
- **Input Validation**: `min_profit` validated as a number between 0 and 100,000,000.

#### Backend
- **Cache Eviction**: `alertMarketDb` entries expire after 2 hours, cooldowns after 1 hour (cleanup runs every 30 min).
- **Graceful Shutdown**: SIGTERM/SIGINT handler cleanly closes NATS, WebSocket, Discord bot, SQLite, and HTTP server.
- **Error Logging**: Replaced silent `catch(e) {}` blocks with meaningful error output.
- **discord.js Fix**: Changed `ready` → `clientReady` event to eliminate deprecation warning.

#### UI
- **Separated Scan & Sync Indicators**: Split the overlapping "market scan" and "live sync" status into two distinct indicators in the top bar, each with their own dot and label.

---

### Added
- **Browser Batched History Engine**: Dramatically upgraded the global *Market Browser* by allowing users to filter searches by specific Cities. Additionally, built an advanced HTTP batcher that quietly fetches the exact `24h Volume (Sold)` and `24h Average Price` for all 50 items visible on your screen simultaneously, injecting them right onto the cards without locking your browser or banning your IP.
- **Global Toolbar Unification**: Completely stripped and rebuilt the Item Cards inside the `Market Flipping (Arbitrage)` and `Crafting Profits` tabs. Extracted the new 3-button (Compare, Refresh, History) action toolbar and injected it deeply into every module for 100% uniformity. Now every single item card across the entire website clearly broadcasts `"Updated: XXm ago"` and natively allows 1-click live sync refreshes!
- **Zero-Delay Live Sync Architecture**: Successfully constructed and deployed a dedicated Linux Node.js proxy to intercept raw TCP data from the community NATS stream. Injected a WebSocket listener into `app.js` to natively feed these packets directly into the IndexedDB. When players use the Albion Data Client to scan the game, the browser will now ingest those exact prices with effectively zero milliseconds of delay, completely bypassing the standard REST API.
- **Analytics Integration**: Injected Google Analytics tracking script into the central layout index to natively track incoming visitors and live dashboard user metrics.
- **In-Game Price History UI**: Completely overhauled the "Show Price History" modal to serve as an exact, deep visual replica of the native Albion Online market graph. This includes the signature parchment theme, exact hex colors for the line and bar charts, a dual-column order book layout, integrated 4 weeks/7 days/24 hours metric toggles, and identical custom tooltip styling.
- **Dual-Track Arbitrage Profits**: Completely overhauled the Market Flipping result cards to display exact numbers for *both* trading strategies simultaneously. The card clearly labels prices as "Instant Buy/Sell" and now features two distinct profit blocks: **Instant Sell Profit** and **Sell Order Profit**, calculating separate net profits, ROIs, and taxes based on which liquidation path you choose.
- **Comprehensive Arbitrage Prices**: The Market Flipping cards now display both the Instant Buy/Sell prices *and* the underlying Buy Order and Sell Order prices for each respective city directly on the UI, allowing for much deeper transport planning.
- **City-Specific Refresh Buttons**: Replaced the general "Refresh" button on Arbitrage cards with two distinct, inline refresh buttons immediately next to the Buy and Sell prices for maximum intuitive clarity.
- **Split Market Flipping City Filters**: Segmented the initial city filter into explicit **Buy From** and **Sell To** dropdowns in the Market Flipping section. This allows for pinpoint arbitrage routing (e.g. exclusively finding trades bought in Lymhurst and sold in Caerleon).
- **Per-City Sales Graphs**: Added a City selector dropdown directly inside the historical chart modal. The graph now accurately filters and displays the exact price and volume history specific to the selected city (specifically utilizing Normal quality items to eliminate overlapping edge-case data).
- **Sales Volume on Price Charts**: Upgraded the historical average price graphs across the entire website to also display the **Daily Volume Sold**. This is rendered as a secondary bar chart behind the average price line, complete with a dedicated right-side axis to prevent vertical scaling issues.
- **Consumable Crafting Support**: Integrated the entire consumable database from the Albion Data Project, adding 371 accurate crafting recipes for all foods and potions (all tiers and enchantments) to the Crafting Profits calculator.
- **Crafting Batch Sizes**: Updated the crafting calculator logic to factor in `recipe.output` quantities (e.g. 5 per craft for potions), accurately projecting total revenue and profit for bulk-crafted items.
- **Market Browser Search Button**: Added a dedicated `Search` button to the Market Browser tab and updated its filtering logic to wait for the button click or an `Enter` keystroke, rather than automatically querying upon every single keyboard press or dropdown change.
- **Updated Item Database**: Downloaded a fresh dictionary of items from the Albion Data Project community repository. `items.json` now includes over 1,500 newly added items, including the entire line of Avalonian weapons (Dawnsong, Daybreaker, Astral Aegis, etc.), which were previously missing from the local database.
- **Market Flipping Enchantment Filter**: Added an enchantment filter dropdown to the Market Flipping tab, allowing scans to be narrowed down to specific enchantment levels (.0 to .4).
- **Market Browser Quality Filter**: Added a dropdown to filter the best Buy and Sell prices for a selected quality (Normal to Masterpiece).
- **Market Browser Sort Option**: Added a dropdown to sort the displayed items by Name (A-Z), Lowest Buy Price, or Highest Sell Price.
- **Market Browser Autocomplete**: The search bar in the Market Browser now features an autocomplete dropdown to quickly find specific items by name.
- **Git Push Automation**: Automated pushing changes to the GitHub repository upon request.
- **Crafting Profits Overhaul**: Redesigned the Crafting Profits tab. You can now search for any specific item to view a detailed breakdown of its crafting process. Includes accurate per-city material cost comparisons, optimal selling city suggestions, and dynamic adjustments for Focus, Specialization, Mastery, City Production Bonuses (Resource Return Rate), and Station Fees.
- **Expanded Recipe Database**: Auto-generated 4,655 exact crafting recipes (T3-T8, all armors, weapons, materials, bags, and capes) mapped to the game's actual material patterns to accurately power the Crafting Calculator. Now includes the entire **Shapeshifter Staff** weapon line (Prowling, Rootbound, Bloodmoon, etc.).
- **Enhanced Item Database**: Replaced the item list source with the active `ao-data` repository, expanding the searchable database to over 11,000 items (including all Missing "Wild Blood" content).
### Fixed
- **Pagination Bug**: Fixed an issue where changing the page in the Market Browser would reset the view to page 1 because the filter logic reset the page unconditionally.
- **Enchanted Material IDs**: Fixed a bug where enchanted refined materials (like 5.3 Metal Bars) were generated with the incorrect API ID format, causing them to return no prices. They now correctly use the `_LEVEL` suffix.
- **Buy & Sell Order Clarity**: Updated the Crafting Profits tables to explicitly show both "Insta-Buy" and "Buy Order" costs for materials, as well as distinguishing "Insta-Sell" and "Sell Orders" for the finished product.
