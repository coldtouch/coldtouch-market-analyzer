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

## Key Features (22 Tabs)

> **Note 2026-04-28**: Mounts Database + Community Builds tabs were BENCHED earlier (commented out in app.js). Their feature cards were also removed from the About-page advertising on this date. Real shipped tab count = 22, not the previously-claimed 24.

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

### May 3-4 (overnight) — Site-down emergency: event-loop wedge on synchronous compaction → root-cause fix — Latest

User came home from work to a hung site. `systemctl restart` from his phone bought 26 min before it wedged again. From outside it looked like the pre-migration restart loop was back, but `NRestarts=0` — the process was technically alive, just unresponsive (479 requests queued in port 443's recv-q, HTTP timing out at 15+s, last journal log line 57 minutes prior).

**Root cause:** `compactOldData()` was loading the entire price_averages hourly result set (29,968,787 rows) into one JS array via `db.all()`, then running a single sync `db.transaction()` that called `stmt.run` for every row. Under better-sqlite3 (sync) this **blocks the JS event loop for the entire duration**. Combined with 30M old rows + 3 secondary indexes per row, the transaction grew RSS to 9.7 GB and held the event loop for hours.

**Why it surfaced now:** the May 2-3 migration eliminated the BUSY abort cycle. Pre-migration, every `process.abort` cleared in-flight compactions along with the queue — the silent compaction failures were *masked* by the same restart loop we were fighting. Post-migration the aborts stopped, the silent failures stopped being papered over, and tables grew unbounded until compaction ran into a 30M-row scan it couldn't finish.

**Fixes shipped (one deploy, server stamp `20260504-001522`):**

1. **`compactOldData` rewrite** — async + chunked (5K rows per cycle), `await new Promise(r => setImmediate(r))` between chunks (event loop gets a tick between every batch), per-cycle INSERT-then-DELETE in their own small transactions (so `wal_autocheckpoint=1000` keeps WAL bounded), `process.memoryUsage().rss > 1.5 GB` early bail, `PRAGMA wal_checkpoint(TRUNCATE)` at the end. Tier 2→3 same pattern but paginated by `item_id` ranges.
2. **`[HEALTH]` heartbeat** — emits every 10 min: `dbMB`, `walMB`, `rssMB`, `heapMB`, plus the `compactionRunning`/`statsRunning`/`analyticsRunning` flags. Now `journalctl -u albion-saas | grep HEALTH` is the single canonical view of "is the DB growing?". This is what would have made the pre-outage growth visible — it had been creeping up for days with no alarm.
3. **`.catch()` handlers** — added to all fire-and-forget `compactOldData(...)` callers (the function is now async; an unhandled promise rejection would kill the process).

**One-time offline cleanup (with service stopped):**
- Bulk-copy keepers strategy (chunked DELETE was ~700 rows/sec, way too slow on 30M rows because of per-row index updates):
  - `INSERT INTO price_averages_new SELECT * FROM old WHERE period_type='daily' OR period_start >= now-3d` → 5,929,557 keepers from 29,968,787 rows in **179 s**
  - `DROP TABLE price_averages` → **18 min** (4.7M pages added to freelist)
  - `RENAME` (instant) + 3 indexes → **84 s** total
  - `VACUUM` → **20 min** (rewrote 20.4 GB → 11.7 GB compact file)

**Numbers post-deploy:**
- DB on disk: **19.7 GB → 11.7 GB**
- `price_averages` rows: **29,968,787 → 5,929,557** (-80%)
- WAL: **4 GB → 6 MB** (clean)
- Process RSS: **9.7 GB → 191 MB** (-98%)
- Disk: 87% → 36% used (also dropped 4 obsolete backups during the work — backup cron keeps last 4 and they were 14-19 GB each from the bloat era)
- HTTP latency: timeout (15+s) → 300 ms
- First `[HEALTH]` heartbeat at 02:17 CEST: `dbMB=11234 walMB=6 rssMB=191 heapMB=64 compaction=0 stats=0 analytics=0` ✓
- `/api/leaderboard` returns real JSON end-to-end ✓
- 0 FATAL / 0 BUSY / 0 Uncaught log lines since deploy

**Still TODO (root-cause work flagged for next session):**
- `price_hourly` is 51M rows. Retention is 30 days, but data accrues at ~8M rows/day → 240M-row steady state. The new chunked Tier 2→3 will handle that load without wedging, but the table itself is structurally large. Options: (a) reduce retention to 14d, (b) skip `price_hourly` entirely and roll directly from raw → daily, (c) prune low-traffic items based on `volume`.
- `price_averages` daily rows have no retention policy — eventually they grow. At ~85K daily rows/day they're modest, but a 90-day cap is sensible.
- Add `monitorEventLoopDelay` watchdog from `node:perf_hooks` — would catch arbitrary sync wedges, not just compaction's.
- Add Discord webhook alert when `[HEALTH]` shows `dbMB > 15000` or `rssMB > 2000`.
- `price_snapshots` is empty (0 rows) — confirm that's expected (it's auto-compacted at 6h) vs. an ingest-path regression.

**Files modified:** `deploy_saas.py` (~+190 lines, mostly comments). One-time cleanup scripts in `tmp_check/` (kept for reference; `.gitignore`d).

**Lesson:** any sync DB operation that can scan more than ~10K rows MUST yield to the event loop between chunks under better-sqlite3. The May 2-3 migration removed the worst symptom (BUSY restart loops) but didn't audit every existing query for scan size — that's the next layer of hardening.

### May 2-3 — better-sqlite3 migration: drop node-sqlite3 entirely (4 stages, ~17h work)

The structural fix the May 1 perma-fix was a band-aid for. The May 1 work mitigated symptoms of node-sqlite3's async-callback orphan bug class via flow control + queue ceiling + `BEGIN IMMEDIATE` + various error-callback fixes. Restart rate dropped from 44/day to 47/day-ish (NRestarts went 0 → 94 in ~36h on the May 1 deploy — i.e. ~1.7/h, exactly the documented baseline). User asked: "is this normal? what should we do?" Answer: NO. A site this small should run for weeks/months between restarts. Driver is the wrong driver for the workload.

**Plan generated:** `BETTER_SQLITE3_MIGRATION_PLAN.md` (983 lines, 12 sections). Three subagents in parallel (architect / code-inventory / docs-lookup) produced the inventory + docs + strategy; I synthesized + added the §3 DATA SAFETY section the user explicitly asked for. User confirmed all 7 decisions and asked me to ship while they slept.

**Stages 1-4 shipped (5 deploys total — including the prep + a fix-up):**

- **Prep (commit `719331d`):** Added `node --check` syntax guard to `deploy_saas.py` itself before SFTP — catches typos in the embedded JS string locally.
- **Stage 1 (commit `958a147`):** `readDb` → better-sqlite3. 60 callsites converted from nested-callback to flat try/catch. `/api/me` prepared statement hoisted to module scope. Dropped `readDb.on('error')`. Verified clean for 15 min before stage 2.
- **Stage 2 (commit `e0b7e2b`):** `statsDb` → better-sqlite3. The big aggregates (5-30s) and EMA streaming (was `statsDb.each`) converted to chunked `stmt.iterate()` + `setImmediate` yields every 5K rows. `flushWrites` rewritten to `db.transaction().immediate()` with auto-rollback. `computeAnalytics` made async. `computeSpreadStats` write batches raised 100→1000.
- **Stage 3 (commits `697b63e` + `d7af1a8`):** `db` → better-sqlite3 + DDL block + compat shim. The 350-line `db.serialize` DDL block flattened into `db.exec()` + `tryExec()`. Compat shim (~100 lines) wraps `db.run/get/all/each/serialize/prepare` to accept node-sqlite3 callback API while routing through better-sqlite3 sync underneath — this lets ~150 untouched HTTP/WS handler callsites keep their syntax. Every shim call does sync work, so async-callback orphan class is structurally impossible regardless. Fix-up commit removed a dangling `_earlyDbErrors` reference.
- **Stage 4 (commit `05da8b8`):** Deleted the queue infrastructure. All 10 `withWriteLock` callsites converted to direct `db.transaction().immediate()` (with auto-rollback). Deleted `_writeQueue` / `_writeDepth` / `_writeActive` / `WRITE_QUEUE_CEILING` / `WATCHDOG_TIMEOUT_MS` / `WRITE_LOCK_NEVER_DROP` / `function withWriteLock(label, fn)` (38 lines) / queue-health setInterval / `_isSqliteFatal` / SQLite branch in `_handleFatal`. Dropped `node-sqlite3` from `package.json` entirely.
- **Stage 5 SKIPPED:** Cosmetic only (collapse statsDb into db). Plan flagged as optional. Stages 1-4 deliver the structural win.

**Pre-flight verified:** Local `node --check` passes at every commit. VPS pre-flight: `npm install better-sqlite3` pulled prebuilt for Linux x64 Node 20.20.2 (no compile). The deploy script's new syntax check runs every deploy and saved one typo from reaching SFTP.

**Observed at end of stage 4 (~05:14 CEST 2026-05-03):**
- backend.js: 305 KB → 289 KB total (-16 KB net across 4 stages)
- RSS at idle: 3.7 GB pre-migration accumulated → 242 MB fresh process (~15× drop)
- NRestarts since stage 4 deploy: 0
- 0 FATAL / 0 BUSY / 0 Uncaught log lines since stage 4 deploy
- All HTTP routes 200 OK at <300 ms (network-bound)
- spreadStats + market scanner + NATS flush all running cleanly through stages 1-4 deploys

**Real test will be over 24-72h.** If we see:
- 0 unplanned restarts in 24h → migration fully successful
- 0 unplanned restarts in 7 days → bug class is dead

**What to do if something breaks during the night:**
- Each stage is one git commit, independently revertable: `git revert <stage-N-sha> && python deploy_saas.py`
- Or roll all the way back: `git revert d7af1a8 697b63e e0b7e2b 958a147 719331d 05da8b8` (reverse order) → returns to the May 1 perma-fix baseline
- Worst case: `python deploy_saas.py rollback` restores `backend.js.bak` from previous deploy (~30 sec)
- Daily DB backups in `/opt/albion-saas/backups/` every 6h — last known-good was at May 3 00:02 UTC

**Compat shim is "temporary" but no urgency.** ~150 HTTP/WS callsites still use node-sqlite3 callback syntax under the hood. The shim is small + well-tested + zero overhead. Future cleanup can convert them one at a time. There's no deadline.

**Files modified:** `deploy_saas.py` (~1700 lines net change across 6 commits), `BETTER_SQLITE3_MIGRATION_PLAN.md` (new, 983 lines), `CHANGELOG.md` (new entry), `CLAUDE.md` (this entry).

### May 1 — SQLITE_BUSY perma-fix (research-driven)

- **Three-agent review pass** (architect / TS reviewer / external research) converged on the same root causes that 3 days of patches missed:
  - `_activeDone` releases the WRONG task (TOCTOU: points at currently-active holder, not BUSY-causer). When a prior task's orphan callback fires BUSY *late*, an innocent fresh holder gets released → BEGIN-on-uncommitted state → cascade → 8 GB RSS leak from accumulated orphans.
  - `computeSpreadStats.flushWrites()` was unbounded — fired `withWriteLock` per 100-row batch *without awaiting*. 4,700+ tasks queued simultaneously per cycle, each holding a `batch` array in V8 heap.
  - `priceRefCache-init`/`-incr` had bare `db.run('BEGIN')` + `stmt.finalize()` with no error callbacks — silent hang vector if either failed.
  - All BEGINs were deferred mode → upgrade-deadlock during writes. `BEGIN IMMEDIATE` is the SQLite forum's textbook fix for WAL writer contention.
  - No `'error'` listeners on the 3 sqlite3 Database connections → emitted errors with no listener would crash silently.
- **Commit shipped:** producer flow control (await), queue-depth ceiling (50, with NATS/snapshot/boot-cache exempt), drop `_activeDone` + restore abort-on-any-SQLITE in `_handleFatal`, `BEGIN IMMEDIATE` at all 9 writeLock sites, `PRAGMA journal_size_limit = 67108864` on all 3 connections, fix priceRefCache-init/-incr callback chain, register error listeners with early-buffer until `_handleFatal` defined.
- **Expected impact:** RSS plateau 600-1500 MB (vs current 400 MB → 8 GB cycle), aborts <5/day (vs 44/day), morning routine cron POSTs land cleanly.
- **Deferred to commit 2/3:** split analytics tables to separate `analytics.sqlite` file (architect Option F), `priceRefCache` JSON persistence on disk for fast cold-boot, eventual migration to `better-sqlite3` only if needed.
- **Kill switches in place:** every change is independently revertable. After yesterday's chunking disaster the bar is "any single change can be backed out without coupling to others."

### April 30 (late afternoon) — chunking REVERTED after site-hang incident

- **Site fully hung ~70 min after the chunking deploy.** Process stayed `active running` per systemd but the Node event loop wedged — 27 min of no logs, HTTP requests timing out both externally and on localhost (5–10s). Required `kill -9` to clear (systemd's SIGTERM stuck in `stop-sigterm` for >90s).
- **Root cause hypothesis: `_activeDone` cascade amplified by chunking.** `_activeDone` always points at whoever currently holds the lock, not whoever caused the BUSY. Under heavy load, a BUSY from a released task's orphan operations fires LATER, when an innocent fresh task is now the active holder — `_activeDone` releases that innocent task. Released task's orphans fire more BUSYs. Cascade. Chunking inflated this by multiplying pending writeLock tasks 50× (queue depth normally ~50, post-chunking 1000+ pending).
- **Reverted commit `2fe624b` via `git revert`** — kept the `_activeDone` release fix from `1c8917d` (which had been solo-stable in earlier observation: 1 abort in 90 min, no hangs). Site back up on revert deploy `20260430-153018`.
- **Known regression accepted:** occasional `nats-flush` silent wedges will return (~3 per 14h pre-chunking). The `_activeDone` fix only addresses the BUSY-uncaughtException case (spreadStats wedge), not the genuine-no-error wedge case (nats-flush legitimately holding 90s+).
- **Real perma-fix is now flagged TODO** with three concrete options in CHANGELOG.md: (a) detach orphan-prone task queues so an orphan can't cross-release another task, (b) track per-task timestamp in `_activeDone` and only release if the holder is older than ~30s, (c) revert `_activeDone` entirely and accept the 90s watchdog aborts as the cleaner failure mode.
- **Files:** `deploy_saas.py` (`flushNatsBuffer()` back to single-batch BEGIN/COMMIT), `sw.js` cache bump.

### April 30 (afternoon) — SQLITE_BUSY restart loop, round 2 — writeLock release on uncaughtException

- **Yesterday's fix didn't fully hold.** Returning to the VPS this afternoon: `NRestarts=50` over ~17.5h since yesterday's 18:25 UTC deploy. Roughly the same churn cadence as before yesterday's fix (63/22h). The `a82492e` patch eliminated the direct `process.abort()` on SQLITE_BUSY but the abort just moved to a different trigger.
- **Pinpointed via journalctl correlation:** every one of today's 13 `spreadStats-flush` watchdog fires is preceded by a `[BUSY] Uncaught exception` log line at the *same timestamp*. Zero `[WriteLock] 'spreadStats-flush' held lock for ...ms` lines were emitted in 12h — which only fires for holds >5s, so individual 100-row batches always finished fast. The watchdog wasn't timing actual work, it was timing a post-uncaughtException wedge.
- **Root cause (masked by yesterday's fix):** when SQLITE_BUSY bubbles up as `uncaughtException` (rather than landing in the per-statement callback chain), `_handleFatal` resets `scanInProgress`/`statsRunning`/etc and returns — but never calls `done()` on the active `withWriteLock` holder. The lock stays held forever, no further writers can run, 90s later the watchdog fires. One clean ROLLBACK case at 02:26:31 today confirms: when BUSY does land in the callback, the existing code path handles it cleanly (`[SpreadStats] Batch failed, rolling back: SQLITE_BUSY` → done(err) called → next task runs → no abort).
- **Fix:** added `let _activeDone = null` next to `_writeQueue`/`_writeActive`. `withWriteLock` sets it when a task acquires the lock, clears it when `done()` fires. `_handleFatal` checks whether the error message contains `SQLITE_*` and, if so, force-calls `_activeDone(err)` so the queue can drain instead of wedging. Scoped to SQLite-related errors specifically so a generic non-SQLite regression doesn't falsely release the lock. The 90s watchdog stays as last-resort safety net for genuine silent hangs.
- **Files:** `deploy_saas.py` — ~10 line surgical change (1 new variable, 2 lines in `withWriteLock`, 6-line release block in `_handleFatal`).

### April 29 (afternoon) — SQLITE_BUSY restart-loop fix (commit `a82492e`)

- **63 restarts in 22 hours diagnosed and fixed.** Returning from yesterday's session, the VPS service had cycled `NRestarts` from 0 → 63 between 18:40 UTC (Apr 28) and 16:59 UTC (Apr 29). Eight FATAL aborts in the most recent 6 hours alone.
- **Root cause:** yesterday's Tier 4 work classified `SQLITE_BUSY` and `SQLITE_LOCKED` as fatal in `_isSqliteFatal()`, calling `process.abort()` on every occurrence with the message `"SQLite state is corrupt — aborting for clean systemd restart"`. **BUSY/LOCKED are not corruption** — they're transient lock contention. The pattern: `spreadStats-flush` holds the JS write-lock for 30-45s on `statsDb`, NATS price events queue up to depth 3000-4000 behind it, ONE async `stmt.run` callback hits BUSY at the SQLite level (cross-connection contention between `db` and `statsDb` against the same file), bubbles to `uncaughtException`, `_handleFatal` aborts. systemd restarts → fresh `priceRefCache-init` runs under same load → queue rebuilds → abort again. Self-perpetuating.
- **Fix shipped (`a82492e`):** removed `SQLITE_BUSY` and `SQLITE_LOCKED` from `_isSqliteFatal`. They now log as `[BUSY] ${kind}: ${msg} — non-fatal, resetting flags` and let node-sqlite3's busy_timeout do its retry job. `SQLITE_CORRUPT`, `SQLITE_IOERR`, `SQLITE_MISUSE` remain fatal as designed. Flag resets (`scanInProgress`, `statsRunning`, `analyticsRunning`, `dbBusy`) still happen so a noisy BUSY doesn't leave a flag stuck.
- **Per-tx 90s watchdog still active.** The Tier 4 watchdog from Apr 27 (catches genuine wedges with no error thrown) is unchanged — only the over-aggressive abort-on-BUSY policy was relaxed. Real wedges still abort.
- **Verified post-deploy** (server version `20260429-162456`, deployed 18:25 UTC):
  - 23 minutes uptime, **0 restarts** through one full spreadStats-flush cycle.
  - Peak queue depth **3954** during the cycle — same load that caused 8 FATAL aborts in the prior 6 hours — drained cleanly to 0 in ~3 min. spreadStats wrote 471,568 rows. Zero FATAL aborts.
  - Memory peak 394 MB (vs 525-617 MB pre-deploy under the abort-rebuild churn). priceRefCache-incr held lock 20.5s (vs 33-60s pre-deploy when restart churn was constantly rebuilding cache from scratch).
- **Routine reports collateral damage.** This morning's 6 daily routines (04:00–05:15 UTC) all fired (`updated_at` timestamps confirm) but **none POSTed reports** to the table — the only rows in `routine_reports` are id=1 (yesterday's smoke test) and id=2 (today's resume-session smoke test). Investigation showed zero POST attempts in the VPS journal during the routine window, and queue-depth bursts of 4019 at 03:46, 4010+ at 04:25, etc. — i.e. the VPS was actively in the FATAL-abort cycle when agents tried to POST. Their `try/except urllib.request.urlopen` swallowed connection errors silently (and we can't see agent stdout because `persist_session: true` is silently ignored by the RemoteTrigger API). Tomorrow's 04:00 UTC cycle is the test — with the wedge fixed, POSTs should succeed.
- **Files:** `deploy_saas.py` (one ~30-line change to `_handleFatal` + `_isSqliteFatal` at lines 6131–6155, plus updated comment block), `sw.js` (cache bump v90 → v91 via deploy auto-bump). Single commit `a82492e`.

### April 28 (night) — Guild Syphon Check feature shipped

- **New `Syphon Check` tab** in the website nav next to Alerts (commits `229c876`, `7b3c8f6`, `11d0439`). Pure client-side feature for guild officers — paste the in-game Siphoned Energy log, the page parses TSV (date / player / reason / amount), aggregates per-player totals, and surfaces:
  - **Summary cards** (date range, txn count, player count, total deposits / withdrawals / net)
  - **Red 🔴 Owe Syphon** table — players with negative net, sorted by deficit
  - **Green 🟢 Everyone Else** collapsible section — players with zero or positive net
  - **Discord-ready summary** with both 🔴 owe + 🟢 good-standing sections (matching user's "show standing of players with how much they have left to use" request). Auto-splits into multiple messages when over Discord's 2000-char limit, with visible `━━━ paste below as separate Discord message ━━━` markers and `(continued — players who owe)` / `(continued — good standing)` markers when sections span chunks.
  - **Search + filter bar**: live player-name search (case-insensitive substring match, 120ms debounce, Esc to clear), highlights matched substring in yellow `<mark>`; auto-expands the green "Everyone else" section when search matches there. Sort dropdown (most owed / most deposited / A-Z / Z-A / most txns / biggest withdrawer / biggest depositor / most recently active). Min-txns filter to drop one-off players. "Showing X / Y players" status text.
- **localStorage persistence** of last-pasted log so refresh doesn't lose work (key: `syphon-last-input`).
- **Verified Sonnino case**: user reported "Sonnino missing from results" — investigation showed his net is +231 silver (deposited 474, withdrew 243 across 34 txns), so he was correctly classified as good-standing and hidden in the collapsed section. Fix: search-then-auto-expand UX change addresses the find-a-specific-player workflow.
- **Files:** `index.html` (`pane-syphon` + nav button), `app.js` (`parseSyphonLog`, `renderSyphonResults`, `buildSyphonDiscordMessage`, `_syphonHighlight`, `_syphonApplySort`, `_syphonInitTab`, `runSyphonCheck`), `style.css` (`.syphon-card` / `.syphon-table`), `sw.js` (CACHE_NAME v86 → v90), `CHANGELOG.md` + About-tab feature card + changelog list. No backend, no auth, no packet capture.

### April 28 (evening) — Watchdog tuning + analytics cleanup + v1.3.5 tag

- **18:00 UTC backup-collision incident diagnosed and fixed.** The daily `sqlite3 .backup` cron at 18:00 UTC holds a shared lock on `database.sqlite` (11.2GB) for ~30 min. Today's run collided with the 12:23 UTC deploy's restart cycle — `priceRefCache-init` queued behind the backup, hit the 90s Tier 4 watchdog, aborted, systemd restarted, repeated for 18 cycles across ~30 min. **Site was wedged 18:03–18:32 UTC.** Self-healed when the backup completed.
- **Fix shipped (commit `e83adbd`):** extended the per-label `WATCHDOG_TIMEOUT_MS` map to give `priceRefCache-init` and `priceRefCache-incr` 30 min (vs the 90s default + the 5-min cap previously set for `analytics-ema`/`-bulk`). Service can now ride out a backup window cleanly. Deployed at `20260428-164027`. Verified: 0 restarts since redeploy at 18:40:42 UTC.
- **DB-target correction:** the real production DB is `/opt/albion-saas/database.sqlite` (11.2GB). The `stats.db` / `albion.db` / `market.db` files are 0-byte legacy artifacts. Earlier "stats.db" references in CLAUDE.md/audit notes were misdirected.
- **#1 polluted analytics cleanup executed against the correct DB.** 2,071 rows deleted from `price_analytics` where `metric IN (sma_7d, vwap_7d, ema_7d) AND value > 50_000_000`. Worst offenders were @4 weapons at 666–850M silver (T8_2H_BOW_CRYSTAL@4 Lymhurst at 850M, T8_FARM_MAMMOTH_BABY at 800M, etc.). Verified count=0 after delete. T6_RUNE Black Market `sma_7d` now reads 152 silver (real value).
- **60 suspiciously-low rows** (sma/vwap < 10 silver) flagged but NOT deleted — likely vendor-price contamination, separate decision.
- **Outlier rejection live in production:** observed log lines like `[Snapshots] Rejecting outlier buy=124740 for T8_SHOES_LEATHER_AVALON@4 (gAvg=16,899,997)` — the new ingestion-time filter from earlier today's commit `0ad0385` is actively catching bad prices.
- **Go client v1.3.5 tagged + pushed.** `git tag -a v1.3.5` against existing commit `b54756e` (1-char fix: `slotID == 0` → `slotID <= 0` to skip negative-sentinel slot IDs in chest captures, resolves `UNKNOWN_-56/-59/-62/-63/-64/-65/-68/-71/-121` chain in Loot Buyer). GitHub Actions building binaries.
- **WAL state:** 735MB on disk. Stable but worth checkpointing on next 6h cycle.

### April 28 (afternoon) — Routine Reports infrastructure + 12 cloud routines wired

- **Backend: routine_reports table + endpoints shipped** in `deploy_saas.py` and deployed to VPS. New `ROUTINE_REPORT_SECRET` env var (32-byte hex) gates `POST /api/routine-report`; `GET /api/routine-reports` accepts the same secret OR an admin JWT. New `routineReportLimiter` (30/min). Tested end-to-end with curl: insert returns id=1, GET list + GET single both work, bad secret returns 401.
- **Frontend: admin Routine Reports tab** in `index.html` + `app.js`. Hidden by default, shown only when `discordUser.id === ADMIN_DISCORD_ID` after `/api/me` callback. Lists reports with slug + summary + length, click-to-expand renders full markdown in a scrollable `<pre>`. Slug filter dropdown. SW cache bumped v83 → v85 (deploy script auto-bump).
- **Cloud routines recreated**: 5 existing routines disabled + recreated with the curl POST tail to the new endpoint (Daily Health Sweep, Weekly TODO Audit, Weekly Security Spot Check, Weekly Improvement Suggestions, Weekly Code Quality Sweep). 5 new daily routines created (Daily Live Flips Heartbeat, Daily VPS Resources Snapshot, Daily NATS Connection State, Daily User-Impact Canary, Daily Polluted Analytics Watch). Total active: 10 (6 daily + 4 weekly), all firing at staggered times 04:00–05:15 UTC.
- **`persist_session: true` is silently ignored by the RemoteTrigger API** at both create and update time — confirmed across the v2 trigger creations. Routines visibility now depends entirely on the report POST → `routine_reports` table → admin tab pipeline.
- **Commit `7ea8244`** ships everything; backend deployed via `python deploy_saas.py`.

### April 28 (morning) — Tier 1 PvP perf + NATS leak fix + Accountability fix shipped (v1.3.4)

- **Go client v1.3.4 released** — `https://github.com/coldtouch/albiondata-client/releases/tag/v1.3.4`. Two zero-behavior-change improvements validated against a real PvP session before tagging:
  - **ZvZ perf (`79c5c4e`)** — five small hot-path edits in `client/listener.go` + `client/decode.go`: hoisted the mapstructure decode hook + `reflect.TypeOf` from per-call closure to package-level; reuse the `uint8→string` param map via `sync.Pool` + `clear()` instead of `make()` per event; cache source IPv4 as `uint32` to skip per-packet `SetServerFromIP`; drop four per-packet `log.Tracef` calls; reslice unreliable-packet header instead of make+copy.
  - **NATS connection leak fix (`b81cf6b`)** — `dispatcher.go` rebuilt the entire uploader chain on EVERY dispatched message via `createUploaders()`, leaking a NATS TCP connection per message + defeating HTTP keep-alive on POW path. Now reuses per-target uploaders via a small `RWMutex`-guarded map keyed by resolved URL string.
- **Local Tier 1 test binary** built and validated through tonight's PvP session — no freezes, no regressions. User confirmed "client was ok, ship it."
- **Accountability missing+verified contradiction fixed (`ff51f75`)** — user reported LaboringWolf's `T4_SHOES_LEATHER_ROYAL@3` showing BOTH ✗ missing AND ✓ verified by chest log on the same row. Root cause: `verified` flag read per-player chest-log entries (ground truth), but `missing` math came from chest CAPTURES (snapshot, no player attribution) using a proportional-share formula. When the snapshot was partial relative to actual deposits, proportional math under-allocated to specific players. Fix: when `chestLogDeposits[name][itemId] > 0`, use that count directly as `inChest`. Proportional capture-based math becomes a fallback only for items the chest log doesn't cover. Verified against the original session — Royal Shoes 4.3 now `missing=0, verified=true, fullyVerified=true`. Trash items still correctly flag missing (no chest log row → fallback → 0 in capture → still missing).
- **Sanity checks closed**: Loot Logger zone display flow verified intact end-to-end (Go client → backend → frontend, all 4 display sites); WS LootEvent.NumericID re-resolution verified intact (backend re-resolves at all 4 ingest paths via `resolveCanonicalItemId`).

### April 27 (evening) — PvP-focused perf audit + v1.3.3 distribution prep

- **v1.3.3 binaries verified live** with 8 release assets. User's install upgraded from zone-test.exe to v1.3.3 official; old `C:\Program Files\Albion Data Client\` leftover removed cleanly via uninstaller; registry + shortcuts restored.
- **PvP-focused perf audit** of the listener → router → worker pipeline + decode.go event handlers + event_loot.go ZvZ-hot path (already had v1.2.0 wins). Identified the master allocation hotspot: `decodeParams` rebuilding the mapstructure decoder + `make(map[string]interface{})` per event at 50–200 events/sec during ZvZ.
- **Reframed perf priorities** — original Tier A1/A2/A3 (NATS leak, log demote, chest-log bufio) was market-scanner focused. User's actual concern was PvP/ZvZ. Pivoted to Tier 1 PvP perf (shipped same evening) and kept NATS leak as a separate fix because it IS a real bug regardless of when it fires.

### April 27 (morning) — Itemmap canonical re-resolution + zonemap real names + 3 Go client releases

- **Item-id mismatch root cause** found: user's `D:\Albion Data Client\itemmap.json` was the April 11 build; April 13 game patch shifted ~75% of item IDs by exactly one. Wrong strings (e.g. T6.3 → T6.4) had been uploaded for weeks via .txt and stored as-is.
- **Backend authoritative re-resolution** shipped — `deploy_saas.py` loads canonical `itemmap.json` + `weightmap.json` at startup, applies `resolveCanonicalItemId(numericId, fallback)` + `resolveCanonicalWeight(numericId, fallback)` at 4 ingest paths (WS loot, WS chest capture, WS chest log batch, TXT upload).
- **`.txt` format extended with optional 11th column = `numeric_id`**. Backwards-compatible — old 10-col files still parse (numericId=0 → no re-resolution).
- **Zonemap real names** found in `cluster/world.xml` displayname attribute — 1423 entries. Earlier auto-derived labels ("T5 Highland Keeper Outland Q5") were rejected by user as misleading; real names like "Battlebrae Plain", "Bridgewatch", "Thetford" now display correctly.
- **In-session zone tracking** via opChangeCluster handler (Go client v1.3.1) — verified by 3-zone walk-out test; OpJoin Location at param 8 confirmed.
- **Removed Windows auto-startup from installer** — old `schtasks /Create /SC ONLOGON` line removed; v1.3.3 installer also auto-removes legacy task on upgrade.
- **3 Go client releases cut**: v1.3.1 (zone tracking + device auth fix), v1.3.2 (col 11 + installer no auto-startup), v1.3.3 (auto-cleanup of legacy task).

### April 26 — Analytics Fix + Loot Logger Polish + Accountability UX

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

### Done (April 27)
- [x] Device auth + redirect — CORS allowlist, root redirect preserves `?device=` query, rate limit 3→10/15min
- [x] In-session zone tracking — `opChangeCluster` handler (Go client v1.3.1), OpJoin Location param 8 verified by 3-zone walk-out
- [x] Tier S perf wins (e5ea731) — `evInventoryPutItem` decode short-circuit, `IsValidLocation` regex hoisted, `dumpJoinParams` gated on Debug
- [x] Zonemap real names — 1423 entries from `cluster/world.xml` displayname attribute (replaced auto-derived labels which user rejected as misleading)
- [x] Backend canonical itemmap + weightmap re-resolution — 4 ingest paths (WS loot, WS chest capture, WS chest log batch, TXT upload)
- [x] `.txt` format extended with optional col 11 = numericId (backwards-compatible)
- [x] Removed Windows auto-startup from installer — v1.3.3 installer also auto-removes legacy task
- [x] Go client v1.3.1 / v1.3.2 / v1.3.3 cut

### Done (April 28)
- [x] **Tier 1 PvP perf shipped** in Go client v1.3.4 (`79c5c4e`) — 5 hot-path edits: hoisted decode hook + reflect.TypeOf to package-level, `sync.Pool` for stringMap, IPv4 cache on listener, dropped 4 per-packet Tracef, reslice unreliable packets
- [x] **NATS connection leak fixed** in v1.3.4 (`b81cf6b`) — `getOrCreateUploaders()` with double-check locking; uploader chain reused per target instead of rebuilt per message
- [x] **Go client v1.3.4 released** + GitHub Actions binaries live + Discord message drafted for guild distribution
- [x] **Loot Logger zone display flow verified** intact end-to-end (Go client → backend → frontend, all 4 display sites; "regression" reports were old pre-v1.3.0 sessions correctly showing no 📍)
- [x] **WS LootEvent.NumericID re-resolution verified** intact at all 4 backend ingest paths
- [x] **Accountability missing+verified contradiction fixed** (`ff51f75`) — chest log per-player attribution now overrides proportional capture-based math; capture math is fallback only for items not in selected chest logs

### Pending
- [x] **SQLITE_BUSY root cause fix** — DONE 2026-04-24. Tiers 1+2+3+5 shipped: `uncaughtException` exits on SQLite state-corruption errors for clean systemd restart; all 7 batch-write sites now wrap BEGIN→prepare→run→finalize→COMMIT in explicit error-callback + ROLLBACK; `recordSnapshots` batches 5000→500, `computeSpreadStats` 500→100; RSS watchdog exits at 8 GB to prevent 11 GB OOM scenarios. `analyticsRunning` + `dbBusy` now reset in the handler too.
- [x] **SQLITE_BUSY Tier 1 amendment (`process.abort()`)** — DONE 2026-04-25. Yesterday's `setTimeout(() => process.exit(1), 500)` exit didn't actually exit (43-min wedge today, recovered via SIGKILL + `systemctl start`). Replaced with `process.abort()` (synchronous SIGABRT — no event-loop tick or async cleanup required). Also skip `flushNatsBuffer()` in the SQLite-fatal path (its `db.serialize() + BEGIN` on the locked connection was the second wedge step). `_aborting` re-entrancy guard added. Same `abort()` switch in the RSS watchdog.
- [x] **SQLITE_BUSY — Tier 4** — DONE 2026-04-27 after another silent-wedge outage (PID 489379, ~10h dead with no FATAL log because the tx hung instead of throwing). Two-mechanism fix: (a) `withWriteLock(label, fn)` JS-side promise queue that serializes all batch writes across `db` + `statsDb`, eliminating cross-connection BEGIN contention; (b) per-tx 90s watchdog → `process.abort()` if `done()` not called, catches the silent-hang case the `uncaughtException` handler can't see. All 10 batch-write sites wrapped: recordSnapshots, NATS flush, spread-stats flushWrites, analytics flushBulk + EMA, compaction tier1→2 + tier2→3, backfill, priceRefCache init + incremental.
- [x] **Analytics 7d query — `SQLITE_ERROR: integer overflow`** — DONE 2026-04-26. `CAST(min_sell - max_buy AS REAL)` on one operand in the `SUM((min_sell - max_buy)²)` term at [deploy_saas.py:5139](deploy_saas.py:5139) promotes the multiplication to double-precision float so it accumulates safely. Variance/stddev downstream loses no meaningful precision.
- [x] **Accountability missing-item hover tooltip** — DONE (2026-04-23). Time + looter + guild + zone (📍 pin) now render on hover of any missing item in the accountability player card.
  - Go client v1.3.0 sends `location` (zone) on every `LootEvent` and `DeathEvent` via `state.GetCurrentZone()`.
  - Backend: added `location TEXT DEFAULT ''` column to `loot_events` (ALTER is idempotent for existing DBs), updated 3 INSERTs (WS loot, WS death, merge-sessions copy) and the accountability-share SELECT to carry location end-to-end.
  - Frontend: `evsByPlayerItem[name][itemId]` now stores `{ts, location}` objects; tooltip renders each pickup as `At: HH:MM:SS · 📍 Zone` (zone omitted if blank, so old pre-v1.3 events still render cleanly).
- [x] **Craft Runs — Tab Scan linking UI** — DONE. `app.js:18541` calls `/api/craft-runs/${runId}/scan` from the run-detail UI.
- [x] **Craft Runs — Portfolio integration** — DONE 2026-04-23. `portfolio-craft-runs` element + collapsible table with cost/revenue/net P&L/margin lives in Portfolio Tracker.
- [ ] **Craft Runs — Refining Planner** — backend `/api/refine/optimal-city` exists, but no dedicated planner UI tab found (the existing `refining-lab` tab is something else). Auto-suggest city from material type + batch calculator UI is still TODO.
- [ ] **Loot Logger Viewer UX** — better layout, sorting, filtering, player search, total value estimates. Subjective scope; some search/filter exists but room for polish.
- [x] **Loot Logger — session timeline tooltip overlap** — DONE 2026-04-26.
- [x] **Loot Logger — Guild perspective selector** — DONE 2026-04-26.
- [x] **Loot Logger — verify death-zone display** — DONE 2026-04-28. End-to-end flow verified intact (Go client emits `Location: state.GetCurrentZone()` on every LootEvent + DeathEvent; backend stores via INSERT; frontend renders `📍 ${formatZone(e.location)}` conditionally on truthy location). The "regression" report was a pre-v1.3.0 session correctly showing no 📍 because location was added in v1.3.0 and old events have empty `location` defaults.
- [x] **ReadMail opcode handler** — DONE end-to-end. Go client `client/operation_read_mail.go` decodes mail + `SendSaleNotification()` relays to VPS; backend WS handler at `deploy_saas.py:4214` + REST `/api/sale-notifications` at `:2296`; frontend fetches at `app.js:8685`.
- [x] **Accountability missing+verified contradiction fix** — DONE 2026-04-28 (`ff51f75`).
- [ ] **Device Auth full end-to-end test** — partial coverage today via test client falling into auth flow due to bad config; proper guildmate flow not yet exercised
- [ ] **Test chest capture on guild island**
- [ ] **Multi-file CROSS-USER loot log merging** — current `/api/loot-session/consolidate` only handles within-user fragment merging; the cross-user use case (uploading N .txt files from different guildmates with timestamp+item+player dedup, unified accountability) is still TODO
- [ ] **Negative item ID cosmetic names** — identify -56, -59, -62, -63, -64, -65, -68, -71, -121 from in-game bank
- [ ] **Trade tracker WIP — pick up after PvP/CTA content (paused 2026-04-28)** — Code state:
  - 3 untracked files in `D:\Coding\albiondata-client-custom\`: `client/event_player_trade.go` (177 lines, raw dump logger), `client/trade_tracker.go` (269 lines, typed state machine), `client/zone_debug.go` (separate, zone-test work)
  - 2 modified tracked files: `albiondata-client.go` (+2 lines, `CloseTradeLogger` calls), `client/decode.go` (+32/-3 lines, opcode 174-181 routing)
  - Wire format reverse-engineered Apr 25-26 (3 controlled trades, +2 opcode shift confirmed): 176=invitation, 179=update, 178/180=end, 181=accept-change. Slot 1 items at param[8], slot 2 at param[18].
  - Build instruction: `export PATH="$PATH:/c/Go/bin" && cd /d/Coding/albiondata-client-custom && go build -o albiondata-client-trade-test.exe .`
  - **Stage A — verification (5 min in-game):** Run trade-test binary, do one trade, check `albiondata-client.log` for `[Trade] completed tradeID=… partner=… local_gave=[…] local_received=[…]` lines. Confirm items/qty/partner/guild match.
  - **Known issue: nickname missing on initiator-side trades.** Opcode 176 only fires on receiver/bystander client. When YOU initiate, partner shows `(unknown)`. Mitigation plan documented in `2026-04-26-trade-recon-session.tmp` line 136: cross-reference `param[3]` (partner char session ID) with the existing `evNewCharacter` (29) proximity tracker. Need one debug capture to find which 179 param holds partner char ID — current 179 spec doesn't include it.
  - **Decision branches:**
    - (A) Ship as-is in v1.3.6 with `(unknown)` for initiator-side trades. ~2h to wire WS relay + VPS table + frontend.
    - (B) Solve nickname first: 1 debug session + ~30min code + verification → then ship.
    - (C) Delete WIP entirely. The chest-log-overrides-proportional-math fix (`ff51f75`) shipped 2026-04-28 already resolved most of the missing+verified contradictions that motivated this work.
  - **All context preserved**: code in working tree (untracked files survive indefinitely), reasoning in `2026-04-26-trade-recon-session.tmp` (full reverse-engineering session), test logs in `D:\Coding\albiondata-client-custom\logs\trade-debug-*.log`.

### In-Game Testing Required
- [ ] **Device Auth end-to-end test** — device code flow from Go client to browser approval
- [ ] **Verify negative item ID mappings** — IDs -1 to -9 are guesses. Also discovered IDs far beyond -9: -54, -57, -60, etc.
- [ ] **Castle chest + Outpost chest capture** — test whether existing chest capture handlers (BankVaultInfo / GuildVaultInfo / container events) fire for castle and outpost chests, or if those use different opcodes. If they don't fire, capture the relevant opcodes with Wireshark/debug logging and add handlers.

### Investigation Required
- [ ] **Capture .4 enchanted material gathering** — determine if the Go client can detect when players gather .4 (enchanted) resources. Check whether the gathering event includes enchantment level; if so, wire it into loot logger and accountability. Need to identify the relevant opcode and verify in-game.
- [ ] **Nearby Castle Chest rarity + Outpost scout feature** — when a user running our client opens the in-game world map, capture what castle chests (and their rarity/color tier — e.g. green/blue/purple/gold) and outposts are near them. Surface this on the website as a live scouting overlay so guilds can prioritize targets. Requires: (a) packet research — does the map-open handshake emit chest rarity + outpost state, or is it only a static map render? Check for new opcodes fired on map open (likely `EvMapInfo` / `EvOutpostUpdate` / a castle-objective event); (b) if the data isn't in the map handshake, check whether periodic objective broadcasts carry rarity/ownership; (c) Go client handler + VPS relay; (d) website tab for the live scouting board. Blocked on in-game packet capture / Wireshark verification first.

### Short Term
- [x] **ReadMail opcode handler** — DONE (full pipeline shipped — see Pending section)
- [x] **Go client GitHub Releases automation** — DONE (workflow shipped earlier; v1.3.4 cut by Actions on 2026-04-27)
- [ ] **Multi-file CROSS-USER loot log merging** — see Pending. Allow uploading multiple .txt files from different guild members and merge them into a single accountability check. Use case: player A dies mid-fight and stops capturing, player B picks up the rest. Needs: dedup by timestamp+item+player (same event captured by two clients), unified timeline view, accountability check across the merged dataset. The current `/api/loot-session/consolidate` only handles within-user fragment merging — cross-user is the gap.

### Loot Logger Viewer — DONE (Major Feature, shipped April 9-28)
End-to-end pipeline live since April 9, with continuous polish through April 28. Go client emits loot events (EvOtherGrabbedLoot 275, EvNewCharacter 29, EvCharacterStats 143) → VPS WS relay + local `.txt` writer (with col 11 = numericId since v1.3.2) → website `/loot-logger` tab supports both `.txt` upload and live-session view → per-player accountability check cross-references pickups against chest captures + chest log batches with verified-by-chest-log badges, missing-item tooltips with zone (📍) + looter (since v1.3.0), 3-category death section (Friendly / Enemy / Other), guild perspective selector, accountability share links with chest-log snapshots. Source fork: https://github.com/coldtouch/ao-loot-logger (GPL-3.0, local: D:\Coding\ao-loot-logger\).

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
