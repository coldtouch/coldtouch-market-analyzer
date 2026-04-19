# Changelog

All notable changes to the Coldtouch Market Analyzer will be documented in this file.

### 2026-04-20 — Security hardening + frontend robustness (FULL_AUDIT_2026-04-19 remediation)

**Backend (deploy_saas.py) — 10 fixes:**
- **SEC-M2** — `app.set('trust proxy', 1)` added; rate limiters now use real client IP behind nginx.
- **SEC-C4** — `/api/admin/db-stats` now requires owner ID (`325634482524782592`); was JWT-only.
- **SEC-C5** — `/api/loot-upload` capped at 100 lines per request; oversized batches return HTTP 400.
- **SEC-H2** — `/api/batch-prices` gets its own `batchPricesLimiter` (10 req/min); tighter than the global 60 req/min.
- **SEC-H3** — News banner `link` field validated against `^https?://`; non-URL values are stripped rather than stored.
- **SEC-H4** — `san()` now strips HTML chars (`<>"'&`) in addition to control characters.
- **SEC-M5** — All `err.message` / `err2.message` / `eN.message` raw DB errors replaced with generic `"An internal error occurred."` response.
- **SEC-M3** — Accountability share tokens and loot-session share tokens now expire after 30 days (HTTP 410 on expired token).
- **PY-H1** — `.env` file now uploaded via SFTP instead of `echo 'base64' | base64 -d`; secrets no longer exposed in `/proc/<pid>/cmdline`.
- **PY-H2** — Broken `try:` block (syntax error from previous session) fixed; rollback path now closes SSH before exit; `sys.excepthook` override ensures SSH cleanup on unhandled exception.

**Frontend — 10 fixes:**
- **FE-H1** — `e.message` in two `innerHTML` error states (Top Traded, Community Builds) wrapped with `esc()`.
- **FE-H2** — `active.foodBuff` in crafter profile pill now wrapped with `esc()`.
- **FE-H3** — Service worker bumped to `coldtouch-v45`; fetch strategy changed from pure cache-first to stale-while-revalidate; SW registration uses `{updateViaCache: 'none'}`.
- **FE-H4** — `fetchMarketChunk` now passes `AbortSignal.timeout(30_000)` to `fetch()`; no more indefinite hangs on slow market API.
- **FE-H5** — IDB upgrade guard now compares `e.oldVersion < DB_VERSION` (was hardcoded `< 4`).
- **FE-M1** — `spreadStatsCache` gets a `SPREAD_STATS_CACHE_MAX = 2000` cap with eviction after rebuild.
- **FE-M3** — `_consumedFlips` pruned on load: entries older than 24h removed, hard cap of 1000 entries enforced.
- **FE-M4** — WebSocket `catch` block now rethrows non-`SyntaxError` exceptions (logic/render bugs no longer silently swallowed).
- **FE-M5** — `localStorage.getItem` JSON.parse calls for `lootWhitelist` and `_consumedFlips` wrapped in `try/catch`.
- **FE-M6** — WebSocket URL now derived from `VPS_BASE.replace(/^https/, 'wss')` instead of a hardcoded `wss://albionaitool.xyz`.

**Cleanup:**
- **CLEAN-1** — Deleted 19 scratch/test files (`test_*.js`, `death_payload.js`, `share2.json`, `deploy_bot.py`, `deploy_vps.py`, etc.).
- **CLEAN-4** — `.gitignore` updated: `loot-events-*.txt`, `FULL_AUDIT_*.md`, `DEEP_AUDIT_*.md`, `*.exe~`, and remaining test files added.

---

### 2026-04-19 — Upgrade Flips show exact rune/soul/relic breakdown

**Before:** Upgrade Flips in Market Flipping showed a single hardcoded "Upgrade materials (est.): -X silver" line. Numbers were ballpark estimates baked into the frontend — never updated, never checked against real market prices.

**After:** each flip card lists the actual materials needed per step, priced at the live sell offer in the buy city:

```
Upgrade materials (2H × 3 steps)
  T6_RUNE  × 384 @ 150       -57,600
  T6_SOUL  × 384 @ 800      -307,200
  T6_RELIC × 384 @ 3,000  -1,152,000
Upgrade materials total:   -1,516,800
```

**Implementation:**
- Counts extracted from `ao-bin-dumps/items.xml` `<upgraderequirements>` blocks. Identical across tiers 4–8; only the material class changes per enchant step. Slot counts: HEAD/SHOES/OFF/CAPE = 96, CHEST/BAG = 192, 1H = 288, 2H = 384.
- Material class per step: 0→1 uses `T{tier}_RUNE`, 1→2 uses `T{tier}_SOUL`, 2→3 uses `T{tier}_RELIC`.
- `estimateUpgradeCost()` rewritten to look up live `sell_price_min` in the cached market data for the same city as the flip. Returns `{ totalSilver, breakdown, missingPrices, slot }`.
- If any material price is missing from cache, the flip is SKIPPED — profit math would lie otherwise. Empty-state hint now advises running a normal scan first so rune/soul/relic prices are cached.
- Fixed a pre-existing off-by-one bug: the decorator loop used `cards[idx + 1]` (skipped the first card) because it assumed `countBar` was a `.trade-card`. It isn't.

**sw.js cache:** v43 → v44. Frontend-only.

---

### 2026-04-19 — Offline .txt upload now carries deaths (fixes "0 deaths, all loot missing")

**Symptom found in a real shared accountability link:** 522 loot events, 0 deaths, most loot red-dotted as missing. Root cause: the `.txt` file format only captured loot pickups. Offline uploads rebuilt the session without deaths, so the accountability view's "lost on death" subtraction had nothing to subtract → everything looked missing.

**Fix:**
- Go client (v0.7.2) — `event_loot.go` + `event_death.go` now write `__DEATH__` sentinel rows into loot-events-*.txt alongside loot. Row layout reuses the 10-column schema: `looted_by_*` = killer, `looted_from_*` = victim.
- Backend — `/api/loot-upload` now accepts an optional `sessionId` param (regex-validated, ownership-checked). Used for appending rows to an existing uploaded session, e.g. backfilling deaths into a session created before this fix.
- Retroactive fix for the user's broken share session: parsed 144 `[Death]` lines from the local stdout log, uploaded with `sessionId = <existing upload session>`. 143 rows persisted (1 caught by dedup UNIQUE INDEX). Share now renders: **47 deaths on Saggin (user's guild)**, 23 Savants, 17 XXX, 16 Lemon Girls, 13 E H O T, 12 Polska Gildia, etc.

Backend deploy: `20260419-153126`. Go release `v0.7.2`.

---

### 2026-04-19 — Session_id stability across WS reconnects (no more fragmented PvP sessions)

**Found by analyzing a real PvP log:** 37 `[VPSRelay] Authenticated` reconnects in 50 minutes meant one PvP fight fragmented into ~37 Loot Logger sessions — one per reconnect. Root cause: `ws.lootSessionId` was generated server-side per WS connection, so every reconnect got a new ID.

**Fix:**
- Go client (v0.7.1) generates a UUIDv4 once per game run in `InitVPSRelay`, stores on the relay struct, and sends it in every `client-auth` handshake.
- Backend honors it: if a valid `sessionID` is present in the auth message, `ws.lootSessionId` is pinned to `user.id + "_" + sessionID`. On reconnect, the same UUID comes back → same session. Strict regex (`^[a-zA-Z0-9-]{8,64}$`) prevents injection.
- Old clients (pre-v0.7.1) continue to use the server-assigned ID — no breaking change.

**Backend deploy required** (`20260419-151641`). Go client release `v0.7.1`.

---

### 2026-04-19 — Audit pass: recipes, transport, contributions, itemmap, security, DB hygiene, flip validation

**User-reported bugs fixed:**
- **Bear Paws T6.3 (and ~70 other artifact weapons) now have recipes.** `build_recipes.py` was missing KEEPER/HELL/MORGANA/AVALON/CRYSTAL faction variants across 1H and 2H weapons + several offhands. Added 70 new entries, dropped 13 phantom ones that didn't exist in items.json. Recipes.json regenerated (6,080 recipes). Market Browser Craft button now renders for Bear Paws and every other artifact weapon automatically (conditional was already correct; recipe data was the gap).
- **Transport now shows food / potions / raw materials.** `/api/transport-routes-live` had `min_profit=100` silver/unit default, which wiped out bulk cargo (T4/T5 resources, meals, potions all have 5–60 s/unit margin). Dropped to 1 — frontend sorts by `est_trip_profit` and ROI cap still catches outliers.
- **Community + Profile contribution score now updates.** `/api/contributions` required `{item_ids: Array}` but frontend sent `{item_count}` → silent 400 every call. Backend now accepts either. Also added the missing `trackActivity('transport_plan', 1)` call after Transport loads — it was weighted in `ACTIVITY_WEIGHTS` but never emitted.
- **Loot Logger item-mismatch fix (Assassin Hood 6.3, etc).** `itemmap.json` was from the April 1 ao-bin-dumps; game shipped Protocol18 on April 13 (shifted items). Regenerated itemmap.json (11,175 entries), weightmap.json (10,749 entries), frontend items.json + itemweights.json from April 16 dump. Go client exe rebuilt — same path, drop-in replacement.

**In-game chest log capture prep (MVP skeleton):**
- `opGetChestLogs` (#151), `opGetAccessRightLogs` (#152), `opGetGuildAccountLogs` (#153), `opGetGuildAccountLogsLargeAmount` (#154) dispatchers added to `decode.go`. When `LogUnknownEvents: true` + user opens the in-game Log tab on a chest, the raw params now get dumped via `dumpParams()` for reverse-engineering. Full typed handler + accountability cross-check UI will follow once we have a real param shape sample.

**Security hardening:**
- Leaderboard avatar URL — `encodeURIComponent` on user_id/avatar + `esc()` on the full URL. Closes a theoretical XSS vector.
- Device-auth no longer resets the user's capture token on every approval — reuses the existing token so the user's OTHER running Go client doesn't get kicked offline. Explicit token regen still available from Profile.
- WebSocket auth now has per-IP rate limiting (15 failed auths / 5 min → reject + close connection). Previously `/api/` had a limiter but `wss://` was wide open.
- `/api/activity` per-call count clamped to 1–25 (was 1–500); added per-type **daily caps** per user (scan 5000, loot_session 50, chest_capture 500, etc). A bad actor could previously inflate 150k pts/min into the leaderboard — now capped.
- `/api/device/token` returns uniform 428 for all pending/expired/unknown cases — was leaking 404 vs 410 vs 428 (token-existence enumeration).

**DB hygiene (latency):**
- `/api/price-history`, `/api/analytics/:itemId`, `/api/activity-stats`, `/api/my-stats` — moved all reads to `readDb` so chart opens and Profile loads don't queue behind NATS batch writes on the main `db` connection.

**Live Flips reliability:**
- Flip validation now runs with bounded concurrency (5 parallel) instead of a single-shared 1s lock that serialized every flip.
- Added a 30s staleness TTL — flips that waited too long in the validation queue are dropped instead of broadcast as fresh.
- AODP degraded detection (5 consecutive failures) — when the upstream validator is unreachable, flips go through with `unverified: true` instead of silently passing as validated.

**Low-priority polish:**
- `categorizeItem()` precedence bug: `MAIN_ || 2H_ && !TOOL_` now parenthesized correctly — TOOL_ items no longer misclassify as weapons.
- `isStackableItem()` expanded — trophies, furniture, mount tokens, kill trophies, labourer items, bags, hideouts no longer fall through to "stackable 999" and produce absurd transport suggestions.

**sw.js cache:** v40 → v41. **Backend deploy required** for all backend fixes.

---

### 2026-04-18 — Accountability deaths expandable + share-failed-on-big-content fix

- **Shared Accountability view:** each death row is now clickable — expanding shows Recovered items (48×48 icons with qty badges and price tooltips), Worn-at-death equipment, and who looted the corpse. Previously the share link only showed a flat "victim → killer" strip with no way to see what was dropped or recovered.
- Replaced the inline deaths section in `runAccountabilityCheck` with the same `renderDeathsSection(deaths)` helper the main Loot Logger session view uses, so owner view and shared view now render identically.
- **Fix: "Share failed: Unexpected token '<'" on big sessions.** Express's default JSON body limit was 100 KB — large accountability shares (many captures with many items) exceeded it, Express returned an HTML error page, and the client choked trying to JSON.parse `<!DOCTYPE`. Bumped the global JSON body limit to 5 MB. Individual endpoints still enforce their own caps (e.g. captures_json ≤ 500 KB).
- **sw.js cache:** v39 → v40. **Backend deploy required** for the body-limit fix.

---

### 2026-04-18 — Community leaderboard + Profile overhaul + Transport deferred items

**Community page:**
- Leaderboard now ranks by **combined Activity Score** (30d), not just market scans. Top 20 contributors with tier, score, and scans sub-metric.
- Backend `/api/leaderboard` rewritten to sum weighted activities via SQL — scan ×1, loot_session ×5, chest_capture ×3, sale_record ×2, accountability ×3, transport ×1, craft ×1. Falls back to legacy scans if activity table is empty.
- Top section now explains the new scoring system (collapsible "How is this calculated" with weights + tier thresholds Bronze 0+ / Silver 100+ / Gold 400+ / Diamond 1000+).
- My Stats card adds a prominent "Activity Score (30d)" box alongside the existing scan counters.

**Profile page:**
- Stats grid now leads with **Activity Score + Community Rank + Tier**, followed by scan counts. Adds an Activity Breakdown panel below (per-activity counts + point totals).
- `/api/my-stats` backend returns the full `{ score, breakdown, rank, scans_30d, scans_total, tier }` payload so Profile doesn't need a second round-trip.
- Data Client setup wizard step 4 rewritten — removed the "Run with `--capture`" instruction. Capture is on by default in the Go client (`config.CaptureEnabled = true`); users don't need any flags.

**Transport — all deferred items from earlier research shipped:**
- **Route Risk slider** (0-40% gank rate) — computes "Risk-Adj Net" = profit × (1 − rate) − cost × rate and shows it as a new column on every route card. Red zone routes are now explicitly penalised for expected losses.
- **Auto-refresh (60s)** — toggle that polls `/api/transport-routes-live` every minute when Transport tab is visible + live mode is active. "Last refreshed" timestamp badge.
- **My Haul Plans** (localStorage) — save/load named filter configurations. Each plan stores buy/sell city, mount, budget, slots, item type, confidence, sell strategy, freshness, sort, exclude-Caerleon, gank rate. Dropdown in the control panel.
- **↔ Swap cities button** — flips buy↔sell and re-scans instantly. Quick round-trip planning without rebuilding the filter.
- **Discord Embed Shopping List** — new "📋 Discord Embed" button renders the haul plan as a Discord markdown code block (aligned columns: Item / Qty / Unit / Total + Risk-Adj Net if gank-rate is set). Goes through the copy-preview modal so users can trim before sharing. Plain-text copy still available as secondary button.

**sw.js cache:** v28 → v29.

**Backend deploy required** for the activity-score leaderboard rewrite.

---

### 2026-04-18 — User request batch: Live Flips fix + Market Browser + Loot Logger redesign

**Live Flips — WORKING AGAIN 🎯**
- Root cause: frontend default filter was **50k silver** but backend broadcasts 10k+. Users saw only a subset of flips.
- Plus `initLiveFlipsFilterPersistence` was using non-existent DOM IDs (`flips-city-buy`, `flips-type`) — silently broken.
- **Fixes:** default min-profit 50k → 10k; persistence ID list aligned with real IDs (`flips-city-filter`, `flips-type-filter`); softened low-side outlier guard from 0.25× to 0.1× of global average (was rejecting legitimately cheap resource tiers during volatile periods).

**Market Browser card button swap**
- The "Flips" button on each item card now shows "Craft" for items with a recipe, leading straight to the crafting detail view with material breakdown + best sell city. Items without a recipe keep "Flips" as a fallback.

**Transport — mount weights CORRECTED (bombshell)**
- Our MOUNT_DATA was 5-10× too low. Wiki says T7 Grandmaster's Ox = 2,667 kg (we had 1,262), T8 Elder's Ox = 3,200 kg (missing), T8 Elder's Mammoth = 22,521 kg (we had 1,764!).
- All mounts now use wiki-correct values. Added Mule, T3 Horse, Swiftclaw, Moose, Giant Stag, Grizzly Bear, T4/T5/T6/T8 Ox variants. Dropdown reorganized into optgroups: On Foot / Transport Ox / Combat hybrid / Mammoth.
- Impact: every Transport haul plan that used anything other than our existing (wrong) T7 Ox or T8 Mammoth entry was under-predicting capacity by 5-10×.

**Recent Sales moved from Loot Buyer → Portfolio**
- Lives alongside trade history where it belongs. Now in a collapsible `<details>` card. Auto-detect from in-game mail still works — same `_recentSales` buffer, same `renderRecentSales` function.

**Loot Logger — major redesign (items 5-12 from user request)**
- **Sessions grouping** — past sessions are now grouped into collapsible buckets: 📅 Today (open) / Yesterday / This Week / Older. Huge space saving for users with 50+ saved sessions.
- **Hide sessions list on pick** — clicking a session hides the list entirely; a "← Back" button in the detail view restores it. Resolves the "both visible at once" complaint.
- **Timeline hover rich tooltip** — bars now show a floating tooltip with death count + victim names, **guild-colored** via a deterministic hash palette so the same guild appears in the same color everywhere in the session.
- **Deaths color fix** — friendlies were shown in red, enemies in green (framed as "outcome for our guild"). Flipped to match player-card convention: **friends = green, enemies = red**, regardless of which side benefited.
- **Deaths section is now one big collapsible card** containing one-liner rows. Click any row to expand for items, equipment-at-death, recovered-by list, and action buttons. Massive visual cleanup on sessions with 20+ deaths.
- **Player card loot icons** — ALL unique items shown (no 10-icon cap), aggregated per item+quality with a qty badge. Icons bumped to 48×48 px (was ~32). Flex-wrap means the strip grows vertically instead of getting truncated.
- **Accountability gets Event View** — new "📋 Event View" button on the accountability results renders the same per-player layout as the normal session view, with deposit-status color dots (🟢 deposited / 🟡 partial / 🔴 missing / ⚫ lost on death) overlaid on each item row. Added a color legend strip at the top explaining what each dot means.

**Files modified:** `app.js` (Live Flips + Market Browser + Loot Logger), `db.js` (no change — freshness fix already in place), `deploy_saas.py` (outlier guard 0.25→0.1), `index.html` (mount dropdown, Recent Sales move), `style.css` (260+ lines of new Loot Logger CSS), `sw.js` (v27→v28).

**Backend deploy required** for the outlier guard loosening.

---

### 2026-04-18 — Big Audit Remediation (price accuracy + UX + flows)

Follow-up to the Crafting Overhaul: comprehensive audit across price accuracy, UX polish, and user journeys surfaced ~40 findings. This release fixes all **CRITICAL** and **HIGH** severity items plus the top-ranked structural improvements.

**Backend price accuracy (deploy_saas.py — the single biggest correctness release ever):**
- **TAX_RATE premium-aware** — was hardcoded 0.03 (pre-2021 rate) site-wide. Now uses `taxInstant(isPremium)` / `taxSellOrder(isPremium)` helpers → 0.04/0.065 Premium, 0.08/0.105 Non-Premium. Fixes server-computed net-after-tax across Loot Buyer, Transport Live routes, Live Flip detection, spread_stats, and all broadcast flip profits.
- **Loot Buyer patient-sell** (`deploy_saas.py:1610`) was using instant-sell tax (no setup fee) for sell-order math — inflated patient totals by 2.5-3.5 points and skewed BUY/MAYBE/SKIP verdicts toward BUY. Now uses `taxSellOrder()`.
- **`/api/loot-evaluate`** accepts `isPremium` in body; **`/api/transport-routes-live`** accepts `?premium=0|1`. Frontend auto-sends from `CraftConfig.premium`.
- **`/api/batch-prices`** now accepts `items: [{itemId, quality}]` for per-quality lookups (backward compatible with legacy `itemIds[]` which defaults to Q1). Loot Logger value estimates no longer treat T8 Masterpiece drops as T8 Normal.
- **1-silver sell outlier guard** added to flip detection — rejects flips whose sell price is below 25% of the global average (catches junk listings that would create phantom flips).
- **VWAP 7d** documented honestly in code as "scan-weighted avg" (it's weighted by `sample_count` scan frequency, not trade volume).

**Frontend price accuracy (app.js, db.js):**
- **NATS freshness bug** — NATS packets arrive with empty `sell_price_min_date`. Previously `mergeEntry` could overwrite a recent AODP date with that empty string → freshness dot went black on every NATS-updated row. Now stamps `now` when NATS wins the merge, or when a new entry has no date.
- **Hardcoded "Tax (3%)" / "Tax+Setup (5.5%)" labels** across Transport, Market Flipper, Crafting detail, BM Flipper — now interpolate live TAX_RATE so the label always matches the math.
- **Black Market excluded from sell-city loops for refined materials** (Top-N Ranker + Refining Lab). BM only buys finished equipment in-game; including it skewed rankings toward prices the user cannot realise.
- **Market Browser Q=All → Q1 default** for card math. Previously mixed Q1 sells with Q5 buys, producing fictional cross-quality spreads.
- **Item Power now quality-aware** — new Quality dropdown on the tab; effective IP = base + quality bonus (+20/+40/+60/+80/+100). Prevents comparing Masterpiece silver to Normal IP.
- **Portfolio manual form gains Quality field** — all historical trades default to Q1 (silent); new trades record actual quality.
- **Loot-tab → Portfolio sync** now splits the purchase price across distinct items proportionally instead of collapsing to a single "primary item" row. P/L attribution preserved.
- **`VALID_TABS` set realigned** — shareable deep links like `?tab=toptraded`, `?tab=itempower`, `?tab=farming` now actually work. `currentTab === 'farm'` guard corrected to `'farming'`.

**UX / UI polish:**
- **Market Browser empty state** — first-time visitors now see a helpful hint with 3 example queries instead of a blank grid.
- **"RRR Calculator" renamed to "Return Rate Calculator"** — less developer jargon.
- **Hidden dev-only fields** from Crafting settings: legacy "Station % (old)" flat-fee input and "Base PB 18/15" research-disagreement toggle. Both preserved as hidden inputs so saved setups still round-trip.
- **Transport "FIND ROUTES"** → **"Find Routes"** (was the only ALL-CAPS button on the site).
- **Discord Channel ID input** now has a `aria-describedby` hint ("19-digit number from Discord 'Copy Channel ID'").
- **Icon-only buttons** (🗑 delete, ✓ close, etc.) on Loot Logger filter bar got `aria-label` attributes.

**Structural / flow fixes:**
- **Favorites as a hub.** Every Market Browser card now shows a ⭐/★ star button. One click adds/removes the item from a default "Watchlist" list. Favorites rows grew action buttons: 📈 chart, 🔍 browser, 📊 compare, 🔨 craft (when recipe exists), 🗑 remove. `toggleStarredItem()` and `renderFavStarButton()` are the new primitives.
- **Live Flips cards are clickable** — clicking opens the price chart modal for that item. Each card also has a small × to dismiss the flip for the session (stops repeating "already-taken" notifications).
- **Live Flips filter state persists to localStorage** (`liveFlipsFilters_v1`) — re-entering the tab remembers city/profit/ROI filters and sound/desktop toggles.
- **Loot Buyer Phase 2 accessible from any tracked tab** — new "📊 Sell Strategy" accordion expands inline on every tracked-tab detail card, reloads the Sell Optimizer for remaining unsold items. No more forced restart-from-capture flow.
- **Loot Logger min-value filter** — hide players whose looted value is below a silver threshold. Persisted to localStorage.

**Onboarding:**
- **Alerts tab** gets an inline expandable "How to set this up" wizard: numbered steps, Invite Bot button, "How to get a Channel ID" link, and a live-preview of what the Discord embed will look like.
- **Profile tab** gets a 5-step "Set up the Coldtouch Data Client" wizard with a Download button that jumps to GitHub Releases, token copy, config.yaml guidance, and in-game verification step.

**Go client CI (new):**
- **`.github/workflows/ci.yml`** — matrix build (Ubuntu/Windows/macOS) on every push/PR: `go mod tidy` verify + `go vet` + `go build` + `go test -short`. Catches regressions before a release tag is cut.
- **`.github/workflows/tag-release.yml`** — pushing a `v*.*.*` tag auto-creates a GitHub Release with generated notes (last 20 commits since previous tag). The existing release.yml then fires on `release: created` and uploads binaries.

**Files modified:**
- `deploy_saas.py` (backend tax helpers + premium-aware endpoints + VWAP doc + outlier guard + batch-prices quality)
- `app.js` (freshness, tax labels, BM exclusion, quality fixes, Item Power quality, Portfolio quality + per-item sync, Live Flips clickable + persistence, Favorites hub, tracked-tab Sell Strategy accordion, Loot Logger min-value filter, Top-N isPremium pass-through, Transport isPremium pass-through)
- `db.js` (NATS empty-date stamp fix)
- `index.html` (Market Browser empty state, RRR rename, legacy field removal, ip-quality select, portfolio-quality select, Alerts wizard, Profile client wizard, Transport button case fix)
- `style.css` (new CSS blocks for flip dismiss, favorites actions, star button, alerts wizard, profile wizard, tracked-tab accordion, loot-logger toolbar)
- `sw.js` (cache v26 → v27)
- `.github/workflows/ci.yml` (Go client CI — new)
- `.github/workflows/tag-release.yml` (Go client tag-based release — new)

**Backend deploy required** — the `deploy_saas.py` changes must land on VPS via `python deploy_saas.py`.

---

### 2026-04-18 — Crafting & Refining Overhaul v2 (MASSIVE release)

Full implementation of the 13k-word CRAFTING_PLAN.md. Fixes 6 documented formula bugs that were actively misleading users, adds 2 entire new tabs, and delivers the killer features no competitor has.

**Formula fixes (Phase 1) — every existing user was seeing wrong numbers:**
- **TAX_RATE fix (A4, CRITICAL)** — was hardcoded 3% (pre-2021 value). Corrected to **4% Premium / 8% Non-Premium** per 2023 Lands Awakened patch. Non-premium users were under-projecting tax by **167%**. A live Premium toggle (default ON, persisted to localStorage) now drives `TAX_RATE` globally; every downstream tab (Transport, BM Flipper, Portfolio) auto-updates because the constant is dynamic.
- **Focus formula fix (A3, CRITICAL)** — replaced linear `specLevel × 0.6 + masteryLevel × 0.3` with the correct exponential `cost = base × 0.5^(efficiency/10000)` per wiki + forum thread 198660. Main spec contributes ×250 per level, mastery + other specs ×30 per level.
- **City specialty auto-detect (A2)** — `CITY_CRAFT_SPECIALTY` + `CITY_REFINE_SPECIALTY` maps per category. Auto-applied in the new Heatmap and Top-N Ranker; badge shown on summary card when active.
- **Item Value + Station Fee (A5/A6)** — `itemValue(itemId)` per wiki formula. `stationFeePerCraft(itemId, silverPer100)` = IV × 11.25% × (s/100). New "Station s/100 Nutrition" input replaces the flat %, matching the in-game station UI.
- **Configurable basePB (A1)** — dropdown default 18, alt 15 (sources disagree). Persisted in CraftConfig.
- **Quality EV mode (A7)** — new toggle. When on, finished-item sell prices are weighted averages across the quality distribution at your spec (Normal 68.9% → Masterpiece 0.1% base, shifts with mastery via reroll model).
- **Food buff support (A8)** — Pork Omelette (+18% focus efficiency), Avalonian Pork (+30%).

**New tab: ⚡ Top-N Crafting Ranker (Phase 3 — the killer feature)**
- Ranks every recipe by **silver/focus**, silver/hour, net profit, or ROI against live prices.
- Filters: tier, category, enchant level, focus on/off, min liquidity (10/50/200 per day).
- Auto-detects the best specialty city per recipe and applies the +15/+20% PB to the ranking.
- Each card: rank, profit, mat cost, RRR%, best sell city, specialty badge. Click → opens Crafting detail.
- **No other tool ranks the catalog given personal spec + live prices.**

**New tab: 🔥 Refining Lab (Phase 2)**
- Three modes: **Today's Best** (sorted grid by silver/focus), **Single Material Deep-Dive**, **Daily Focus Planner** (greedy allocates your focus budget).
- Filters by family (Planks/Bars/Cloth/Leather/Stone), tier, enchant.
- Auto-applies refining specialty cities (Fort Sterling planks, Thetford bars, etc.).
- Focus Planner: input 10k-30k daily focus, output expected daily silver with run-by-run breakdown.

**Crafting detail view — Phase 4 features:**
- **🗺️ City Heatmap (C4)** — 7 cities × (focus on/off) = 14-cell matrix with per-city RRR + auto-specialty badge.
- **🌳 Sub-recipe Tree with Buy-vs-Craft toggles (C2)** — recursive tree render, per-node 🛒 Buy / 🔨 Craft toggle. "Auto-optimize" picks cheaper path per node. Running savings total vs all-buy baseline. **No competitor has this with toggles.**
- **🎯 Inverse Calc (C5)** — target-margin slider (0-60%) → computes max unit price you can pay for each material to hit the margin.

**Crafter Profiles (Phase 5 — C1)**
- Multiple named profiles (e.g. "Plate Specialist", "Cloth Refiner") stored in localStorage.
- Each profile: spec, mastery, city, premium, food buff, basePB, station s/100.
- Quick-switch propagates to Crafting + RRR + Refining Lab + Top-N tabs simultaneously.
- "Crafter Profile" pill in nav header shows active profile + quick-access to modal.

**🎲 Monte-Carlo Craft Simulator (BONUS)**
- Simulates 400 full crafting sessions with your spec/RRR/quality distribution.
- Shows silver-earned distribution: p5 (unlucky), p50 (median), p95 (lucky).
- Histogram chart of outcomes + stats grid.
- Open via new "Run Monte-Carlo Simulator" button on any crafting detail view.
- **No competitor surfaces crafting-session variance** — turns "expected profit" into "expected profit ± realistic range."

**Cross-tab nav (D-series helpers):**
- `switchToRefineLab(itemId)` — opens Refining Lab, pre-filters by material family + tier.
- `switchToTopN({tier, category})` — opens Top-N with filters pre-set.
- Existing `switchToCraft(itemId)` already widely wired.

**CSS:** new sections for `.city-heatmap`, `.subtree-*`, `.inverse-*`, `.topn-*`, `.refine-*`, `.crafter-profile-*`, `.craft-sim-*`. Mobile-first responsive at 768px.

**Service Worker:** cache bumped v25 → v26.

**Migration notes:**
- Users who had the old `TAX_RATE = 0.03` hardcoded in their saved Crafting Setups will now see higher tax numbers (correct). Portfolio P/L estimates will also shift.
- `calculateFocusCost(baseCost, spec, mastery)` remains as backward-compat shim — internally calls `calculateFocusCostV2` with food buff and exponential curve.
- Legacy "Station Fee %" input retained as fallback; new "Station s/100" takes precedence when > 0.

**Files modified:** `app.js` (+2100 lines), `index.html` (+220 lines, 2 new tab panes), `style.css` (+260 lines), `sw.js` (cache v26), `CHANGELOG.md`, `HANDOFF.md`.

**Not in this release (per signed-off decisions):**
- Live RRR via Go client packet capture (DECISION-D9 → Phase 6, needs ~1 week packet research).
- Daily-bonus calendar (DECISION-C8 → blocked on community data source).

---

### 2026-04-17 — Loot Split + Equipment-at-Death + DevOps batch

**New features:**
- **G10 Loot Split Calculator** — modal under Loot Tools dropdown. Splits silver between participants with per-person weights and bonuses, supports % or fixed silver off-the-top deduction (tax/repair/scout cut), pulls totals from current loot session, and copies a Discord-formatted breakdown via the existing copy-preview modal. State persists in localStorage.
- **B6 Equipment-at-death** — new Go client opcode 90 handler (`evCharacterEquipmentChanged`) tracks each player's last-known gear by name. Death events now carry the victim's equipped items at the moment of death; backend persists in `loot_events.equipment_json`; frontend renders a teal-bordered "Worn at death" strip on each death card.

**DevOps (deploy_saas.py):**
- **DO-1 Rollback** — `python deploy_saas.py rollback` restores the previous backend.js from the `.bak` snapshot taken on every deploy.
- **DO-2 /healthz** — added a stable health endpoint (mirrors `/health`) that includes db/readDb/statsDb status, NATS state, WS client count, deploy version stamp (`SERVER_VERSION`), and start time. Suitable for UptimeRobot/BetterStack pings.
- **DO-3 DB backup cron** — deploy installs `/etc/cron.d/albion-backup` running `sqlite3 .backup` every 6h with 7-day retention to `/opt/albion-saas/backups/`.
- **DO-6 --frontend-only flag** — `deploy_saas.py --frontend-only` exits with a notice (frontend lives on GitHub Pages, not VPS) so frontend pushes never accidentally restart the backend.
- **DO-4 Go client `--version`** — augmented existing flag to also print build date, runtime OS/arch, and Go version. Build with `-ldflags "-X main.version=vX.Y -X main.buildDate=..."`.

**Schema:**
- `loot_events.equipment_json TEXT` — new nullable column for B6. Added via `ALTER` so existing rows are unaffected.

**Verified already in-place (no change needed):**
- ReadMail → loot tab auto-match end-to-end (Go client `SendSaleNotification` + backend `sale-notification` handler matches active loot tabs and pushes to user browser).
- Go client GC-1/GC-2/GC-3/GC-4/GC-6/GC-7 — all critical Go client audit findings already fixed in worktree (router worker pool, item cache TTL, auth goroutine cleanup, sendOrQueue/flushPending race, queue size 500, WS read deadline).
- FG-1 D4 accountability → Loot Buyer (`valueMissingItemsInLootBuyer()`).
- FG-2 D5 capture → Track this (📦 Track button on every capture card).

**Deferred (needs live verification):**
- Multi-server VPS price history. NATS topic-per-region pattern needs live confirmation before adding `server` column + multi-subscribe — risk of silent data corruption otherwise.
- Device Auth end-to-end live test — requires in-game session.

---

### 2026-04-16 — Chest Capture Duplicate & Timestamp Fix

**Frontend (app.js):**
- Deduplicate chest captures on WS reconnect — `chest-captures` batch handler now skips captures already in `lootBuyerCaptures` (matched by `containerId + capturedAt`), preventing old captures from re-appearing as new on every disconnect/reconnect
- Tab flash, activity tracking, and capture bus event now only fire for genuinely new captures (not reconnect duplicates)
- Defensive `capturedAt` handling in `renderLootCaptures` — handles both Unix-ms numbers and ISO strings safely; shows "Unknown time" instead of throwing on missing/invalid timestamp

---

### 2026-04-16 — Security & Quality Audit Fixes (Batch 5)

**Backend (deploy_saas.py):**
- **S-1** — Pin all `jwt.verify()` calls to `{ algorithms: ['HS256'] }` — prevents alg:none / RS256 downgrade attacks
- **S-2** — Crash-fail at startup if `SESSION_SECRET` is undefined — avoids silently using `undefined` as HMAC key
- **S-3** — HMAC-sign Discord OAuth state param with `SESSION_SECRET` — prevents account-linking hijack via forged state
- **S-4** — Rate-limit `/api/device/authorize` (10 req/15min per user) — prevents brute-force code scanning
- **B-1** — `broadcastFlip` validation errors now log + return instead of broadcasting unvalidated flips
- **B-2** — Rate-limit `/api/loot-evaluate` (10 req/min per user)
- **B-3** — `/api/player-trends-bulk` reads via `readDb` to avoid main DB queue starvation
- **B-4** — Wrap `/api/transport-routes-live` computation in try/catch
- **B-5** — Session merge limit lowered from 10 → 5

**Frontend (app.js + index.html):**
- **F-1** — Replace inline `onclick` + template literal in news banner with `addEventListener` — eliminates XSS via server-controlled `dismissedKey` injected into `onclick` attr
- **F-2** — Whitelist valid tab names before using URL `?tab=` in `querySelector` — prevents CSS injection via unsanitized URL param
- **F-3/P-1** — Cap `analyticsCache` at 500 entries with FIFO eviction — prevents unbounded memory growth
- **DI-1** — Add `_analyticsInFlight` Map to deduplicate concurrent `fetchAnalytics()` calls
- **S-9** — Add `rel="noopener noreferrer"` to all `target="_blank"` links
- **UX-1** — Add `aria-label`, `aria-expanded`, `aria-controls` to mobile menu button
- **CQ-2** — Replace all `confirm()`/`prompt()` calls with `showConfirm()`/`showPrompt()` toast dialogs — adds `showPrompt()` helper, converts 13 call sites across alerts, loot, portfolio, crafting, and session management

**Go client (event_vault_info.go):**
- **GC-5** — Hold `vaultMu.RLock()` in `matchContainerToVaultTab` — fixes data race against `Process()` goroutines writing shared vault state (GC-3/4/6/7 were fixed in previous session)

### 2026-04-16 — Guild Leaderboard, Session Merge, Sale Edit/Delete, Crafter Stats + Refactors (Batch 2)

### 2026-04-16 — Feature Review: Fix, Bench, Overhaul (Batch 4)

**Fix:**
- **Live Flips fixed**: NATS port corrected from 4222 → 24222. Backend TAX_RATE corrected from 0.065 → 0.03. Flips should now flow again.

**Benched (commented out, not deleted):**
- **Mounts Database**: Nav button + tab pane + JS functions commented out. MOUNT_DATA constant kept for Transport tab.
- **Community Builds**: Nav button + tab pane + JS functions commented out. AlbionFreeMarket API no longer called.

**Overhauled:**
- **Crafting Profits**: Category filter on bulk scan (weapons/armor/consumables/offhand/accessories/materials), batch quantity multiplier, focus cost input (shown when "Use Focus" checked), inline save name input (replaces prompt()), auto-calculate on switchToCraft().
- **Community Tab**: Unified activity tracking — new `user_activity` table tracks scans, loot sessions, chest captures, sales, accountability checks, transport plans, and craft calculations. Combined weighted score (scan=1pt, session=5pt, capture=3pt, sale=2pt, accountability=3pt, transport/craft=1pt). Activity breakdown grid on Community tab. Tier thresholds updated.
- **Portfolio Tracker**: Auto-imports from Loot Buyer — buyThisTab() creates BUY entry, submitSaleForm() creates SELL entry. "Sync from Loot Buyer" button imports all tracked tabs. Synced entries show purple "Loot Buyer" badge.

SW cache bumped to v24.

**Session 2 continued (Batch 3):**
- **JSON export**: Full session export as structured JSON (metadata, death timeline, player summaries, raw events).
- **Leaderboard weight column**: Top Looters table now shows total weight (kg) per player. Discord copy includes weight in parentheses.
- **Better duration formatting**: Sessions over 1 hour show "2h 15m" instead of "135 min".
- **Primary guild in summary strip**: Session detail summary shows the detected primary guild for quick context.

**Session 2 additions:**
- **Discord copy for Guild Leaderboard**: 📋 button generates markdown-formatted leaderboard with medal icons, routes through copy preview modal.
- **Reverse session badges** (4.5): Session cards show "📦 N tabs" badge when tracked tabs were purchased during that session. Completes the bidirectional link from F1.
- **Capture event bus** (F3): `_fireCaptureBusEvent()` dispatches DOM CustomEvent on every chest capture add/remove. Loot Logger accountability auto-refreshes via subscriber.
- **Unit tests** (E10): 15 tests covering `isWhitelistedEvent` (case-sensitivity contract) and `buildDeathTimeline` (value estimation, friendly/enemy detection, multi-death sorting).
- **Null-safety fixes**: 4 crash-path bugs fixed in sale form handling (`submitSaleForm`, `showSaleForm`, `initLootManualEntry`).
- **Dead CSS cleanup**: Removed unused `.loot-log-item-row` selector.



**New Features:**
- **Guild Leaderboard** (G1): Historical top looters, killers, deaths, and most active players across all your saved sessions. 7d/30d/all-time filter. Accessible from Loot Tools menu or Ctrl+Shift+L.
- **Inline Sale Edit/Delete**: Edit the price/quantity of any recorded sale, or delete it entirely. Hover a sale row to see the edit/delete buttons.
- **Crafter Aggregation** (C4): "Top Crafters" strip shows the 5 most frequent crafters across all your tracked loot tabs with medal icons.
- **Session/Tab Overlap Badges** (F1): Tracked tab cards now show a "📋 Session" badge when the purchase happened during a logged loot session.
- **Per-Item Sell Mark-Off**: Collapsible items checklist in tracked tab detail. Click items to mark them as sold (persists in localStorage, visual strikethrough).
- **Session Merge**: Combine 2+ saved sessions into one new merged session. Original sessions are preserved. Accessible from Loot Tools menu.

**Refactors:**
- **E2**: Consolidated `window._chestCaptures` and `lootBuyerCaptures` into a single shared array reference. Eliminated 3 seeding/sync sites.
- **E5**: Player card virtualization — large sessions (50+ players) now render first 30 cards with a "Show more" button.
- **E6**: All Loot Logger filter/sort inputs debounced through `_llDebouncedRender()`.
- **E9**: JSDoc type definitions for CapturedItem, ChestCapture, LootEvent, LootSession, TrackedTab.
- **4.4**: Documented and grouped all Loot Logger render-state globals with clear comments.

SW cache bumped to v22.

### 2026-04-16 — Per-player trends (G6)

Every player card in the Loot Logger session view now shows a compact
cross-session trend line when the player has appeared in more than one
of your saved sessions:

> `📊 8 sessions · 1,250 items lifetime · 💀 3 · last seen 2d ago`

Great for officers: glance at a player card and see "this guildmate has
looted with us 15 times, died twice total, last seen yesterday" — or
for enemies, see "this scout has ganked us 4 times this week."

**Backend:** new endpoint `POST /api/player-trends-bulk` aggregates
sessions, items, deaths, and last-seen timestamp across the authed
user's saved `loot_events`. Input capped at 200 names and 64 chars
per name so it can't be abused. One roundtrip per session view.

**Frontend:** `_llPlayerTrends` map populates async after
`renderLootSessionEvents` kicks off, triggers a re-render when the
response arrives so trends fade in without blocking the initial paint.
Threshold of 2+ sessions avoids cluttering cards for one-time appearances.

Service worker cache bumped `v19` → `v20`.

---

### 2026-04-16 — Shareable session URLs (G4) + E3 state consolidation

**G4 — Shareable read-only session URLs:**
- Click the 🔗 icon on any saved session card to generate a public
  URL like `albionaitool.xyz/?share=abc123`
- Anyone with the link views the session in a read-only overlay —
  no login required. They see the full per-player breakdown, death
  section, heatmap timeline, tooltips, everything.
- A subtle `🔗 shared` badge on your session card shows the link is
  active. Revoke any time with one click in the same modal; old URLs
  immediately 404.
- Backend: new `loot_session_shares` table with unique token column,
  3 new endpoints (`POST /api/loot-session/:id/share`,
  `POST /api/loot-session/:id/unshare`,
  `GET /api/public/loot-session/:token`)
- The public endpoint is unauthenticated but only exposes the
  session_id owner decided to share — no user_id, no other sessions.
- Events capped at 5000 per public response so a huge session can't
  be used to hammer the backend.

**E3 — live-session state consolidation (internal):**
- New `liveSessionState()` snapshot helper returns a single object
  with all 9 live-session flags (active, saved, name, events,
  eventCount, sessionId, autosaveOn, warnedAt, droppedCount)
- New `resetLiveSessionFlags()` helper for the reset path
- `resetLiveSession()` now delegates to the helper — removed ~10
  lines of duplicate clearing logic
- Rollback checkpoint tagged at `pre-e3-refactor`

Service worker cache bumped `v18` → `v19`.

---

### 2026-04-16 — Tracked tab polish: days-held badge + break-even tick

- **Days-held badge** on open / partial tracked tabs — at a glance you
  see how long a tab has been sitting without fully selling. Shows
  `Nd` next to the status badge. Tabs older than 14 days get a red
  "stale" variant. Sold tabs don't show the badge (no urgency).
- **Break-even tick** on tab progress bars — small gold vertical
  marker at the 100% position so you can see at-a-glance whether
  revenue has crossed the purchase price. The progress bar itself is
  still capped at 100% width (visual sanity) but the percentage text
  now shows unbounded values so you can tell a tab at 180% apart
  from one at 100%.

Service worker cache bumped `v17` → `v18`.

---

### 2026-04-16 — About shortcuts card + session .txt export

- **Keyboard Shortcuts reference** on the About tab — a clean two-
  column card listing every shortcut (Ctrl+K, Ctrl+Shift+T,
  Ctrl+Shift+C, Esc, and the Loot Logger-specific E/C/F/W/?). Each
  shortcut shows a proper keycap-styled `<kbd>` next to its description.
- **Export session as `.txt`** — the session summary strip now has
  a `.txt` button next to the existing CSV button. Exports in the
  exact 10-column ao-loot-logger format so you can upload the file
  into other tools or save it as a long-term archive. Death events
  are filtered out of the .txt (same as the official format).

Service worker cache bumped `v16` → `v17`.

---

### 2026-04-16 — Recent sales search, shortcut hint, two bug fixes

- **Recent sales search** — filter the Loot Buyer sales feed by item
  name, item id, or city. Empty-state message shows the total count
  when nothing matches.
- **Shortcut hint on Loot Logger** — small subtle chip above the
  filter chips: `? shortcuts · E expand · C collapse · F search`.
  Discoverable without cluttering the view; fades in on hover.
- **Bug fix:** `renderRecentSales` was calling `getItemIcon` without
  a typeof guard — threw ReferenceError when the feed rendered.
  Now falls back to the standard Albion Online CDN icon URL.
- **Bug fix:** `timeAgo` was being passed a ms number from WS pushes
  but expects an ISO string — threw "startsWith is not a function".
  Normalizer handles both now.

Service worker cache bumped `v15` → `v16`.

---

### 2026-04-16 — Profile lifetime stats, Copy All Trips preview, sales history CSV

- **Profile: Loot Lifetime Stats card** — new section on the Profile
  tab showing totals across all your saved loot sessions and tracked
  loot-buyer tabs: session count, event count, tabs bought, total
  paid, total revenue, net profit. Hidden when there's no data.
- **Copy All Trips → preview modal** — the aggregated sell-plan copy
  button now routes through the same edit-preview modal as the
  individual trip copies and every other Discord flow. Consistent
  pattern everywhere.
- **Tracked tab sales history — sort + CSV** — inside each tracked
  tab's expanded detail, sales history now has a sort picker (Newest
  / Oldest / Highest $ / Lowest $, persisted to localStorage) and a
  CSV export button that downloads just that tab's sales as
  `sales-{tab-name}-{date}.csv`.

Service worker cache bumped `v14` → `v15`.

---

### 2026-04-16 — Phase 1 chips, per-trip Discord, global shortcuts

- **Phase 1 filter chips on captured item list** — new multi-select
  chip bar above the items grid: `T6+ / T7+ / T8+ / 🗡 Weapons /
  🎒 Bags / ⚔ Equipment only`. Tier chips mutually exclusive, category
  chips stack, clear pill appears when any chip is active. Chip state
  persists in localStorage across captures so your workflow is stable.
  The existing search bar and chips filter together (AND logic).
- **Per-trip Discord copy (Phase 2)** — the existing `Copy List` button
  on each sell-plan trip card now routes through the same edit-preview
  modal the other Discord copies use. You can trim the list or add a
  note ("for X buyer in Caerleon") before it lands in clipboard.
- **Global shortcuts `Ctrl+Shift+T` and `Ctrl+Shift+C`** — open Trip
  Summary and Compare Sessions from any tab. Works anywhere outside
  of text inputs. Added to the in-app shortcut help (`?` key) under a
  dedicated section.

Service worker cache bumped `v13` → `v14`.

---

### 2026-04-16 — Recent Sales → Discord

- **Copy Recent Sales to Discord** — new 📋 button next to the Recent
  Sales heading on the Loot Buyer tab. Routes through the standard
  copy-preview modal so you can trim or edit before it hits your
  guild chat. Output format: summary line with total silver and
  auto-matched count, followed by a monospace table of the last 15
  sales (item · qty · price/ea · total).

Service worker cache bumped `v12` → `v13`.

---

### 2026-04-16 — Tracked tabs summary + sort

- **Portfolio-style summary header** at the top of the tracked tabs
  list: total tab count, Open/Partial/Sold breakdown, aggregate
  Paid / Revenue / Net across every tab you're tracking. Answers
  "am I up or down on loot trading overall?" without clicking into
  individual cards.
- **Sort picker** — `Newest / Oldest / Highest profit / Lowest profit
  / Open first`. Stored in localStorage so your preferred sort
  persists across reloads. Sort re-renders client-side without
  hitting the backend.

Service worker cache bumped `v11` → `v12`.

---

### 2026-04-16 — Loot Buyer landing + preference persistence

- **Loot Buyer empty-state cards (A6)** — the "no chest captures yet"
  panel now mirrors the Loot Logger landing: three clickable cards
  (🎮 capture in-game · ✍ add items manually · 📋 jump to Loot Logger).
  Each card is self-explanatory and wired to the relevant tab/action.
- **Sort + filter preferences persist across reloads** — the Loot
  Logger session view remembers your last-used sort (`value/items/
  weight/name`), tier filter (`All/T5+/T6+/No Bags`), and active chip
  set (`T6+`, `🗡 Weapons`, `💎 >100k`, etc.) in localStorage. Reload
  the page and your workflow is right back where you left it.

Service worker cache bumped `v10` → `v11`.

---

### 2026-04-16 — Mode pills, landing cards, bounded event queue, price cache

- **Loot Logger mode pills (D2)** — replaces the three flat mode
  buttons with a proper pill bar in a rounded background container.
  Active mode pops in accent gold; inactive pills are subtle. Each
  pill shows a badge count when relevant:
  - `Sessions (N)` — saved + live session count
  - `Accountability (N)` — chest captures available for cross-reference
  Updates live as sessions load and captures arrive.
- **Landing cards (D6)** — the "no sessions yet" empty state now shows
  three onboarding cards: 🎮 Start a live session · 📥 Upload a log
  file · ✓ Run accountability. Cards are clickable and route into the
  right mode. Much friendlier than a flat line of text.
- **Bounded event queue (E8)** — live sessions used to grow the
  `liveLootEvents` array without limit. Now capped at 10,000 events.
  At 9k we fire a warning toast ("save session soon"); at 10k we drop
  the oldest event and surface a toast every 100 drops so the user
  knows data is being lost. Counters reset on save/reset.
- **Price map memoization (E4)** — `getLootPriceMap` now caches
  results keyed by the sorted item-id signature for 5 minutes. Same
  session re-rendered (filter changes, sort changes, chip toggles) no
  longer refetches `/api/batch-prices` repeatedly. Cache bound to 20
  unique signatures with LRU eviction.

Service worker cache bumped `v9` → `v10`.

---

### 2026-04-16 — Session compare, favorite items highlight, global drop zone

- **Compare Sessions (G2)** — new menu entry in the Loot Tools dropdown.
  Pick two saved sessions from dropdowns, click Compare, see them
  side-by-side: events, items, players, deaths, duration, est. value
  — all with gain/loss deltas. Top 3 looters per session shown below
  the stat table.
- **Favorite items highlight (G12)** — items that appear in any of
  your Favorites lists now get a 📌 badge on both Loot Logger and
  Loot Buyer item rows. Loot Buyer rows also get a subtle gold left
  border accent. Uses the existing `albion_favorites` localStorage
  key — no new storage.
- **Global drop zone (F4)** — drag a `.txt` loot log onto any page
  and a full-screen overlay invites you to drop. Releases into the
  Loot Logger upload pipeline regardless of which tab you're on. The
  existing Loot Logger drop zone still works as-is for
  upload-tab-specific use.

Service worker cache bumped `v8` → `v9`.

---

### 2026-04-16 — Trip Summary, verdict reasoning, sale cross-reference

- **Trip Summary (G14)** — new menu entry in the Loot Tools dropdown.
  Opens a modal dashboard pulling from both features: loot sessions
  (count, events, peak players), tracked loot tabs (count, paid,
  revenue, net), recent sale notifications. Window picker switches
  between last 24h / last 7d / all time. Recent tracked tabs list with
  status badges. Graceful empty states when you're not logged in or
  have no data in the window.
- **Verdict reasoning (G13)** — the BUY/MAYBE/SKIP line on the Loot
  Buyer analysis now has a `▼ Why?` button. Expand it for plain-
  language reasoning: spread analysis (instant vs market), risk
  breakdown (stale data / no buyers / low volume / etc. with item
  counts), best destination city, and a bottom-line conclusion tuned
  to the verdict ("you'd overpay by ~X silver" for SKIP, "pocket ~X
  right away" for BUY, etc.).
- **Sale cross-reference (F2)** — items in the Loot Logger session
  view now get a 💰 badge if a matching item appears in your recent
  sale notifications feed (and the sale post-dates the pickup). Soft
  indicator: "matching item sold recently" — we can't know for certain
  it was *this exact copy*, but it helps officers eyeball which gear
  from a session turned into actual silver.

Service worker cache bumped `v7` → `v8`.

---

### 2026-04-16 — Session UX batch: auto-naming, inline rename, copy preview

Three small wins aimed at the friction points you hit most when running a
session.

- **Auto-session-naming** (G7) — a new `💡 Auto-name` button next to the
  session label input. Detects the primary guild (most common among
  looters) and the most common enemy guild (from loot sources), pairs
  them with the session's first-event date, and suggests a name like
  `Alpha vs Evil · Apr 16`. Falls back gracefully to just the date if
  no guilds are detected yet.
- **Inline rename** (A10) — clicking the ✏️ on a saved session card now
  turns the title into an editable input in-place instead of firing a
  browser `prompt()`. Enter saves, Esc cancels, blur saves. Keystrokes
  don't trigger the Loot Logger keyboard shortcuts.
- **Copy preview modal** (A14) — every "Copy to Discord" flow (session
  summary, top looters, deaths report, accountability table, regear
  report, individual death report) now routes through a preview modal.
  Text is pre-populated and editable; you review / tweak, then click
  the Copy button. Esc closes the preview. Character count shown live.

Service worker cache bumped `v6` → `v7`.

---

### 2026-04-16 — Loot Tools polish: timeline, friendly-fire, top-value, shortcuts

Four small-but-useful additions for the Loot Logger session view:

- **Heatmap timeline** above the player cards. Divides the session into
  30 buckets and draws a bar chart of event density, with 💀 markers
  sitting on top of any bucket where someone died. Hover for time range
  and event count. Gives you a visual "shape" of the fight at a glance.
- **Friendly-fire detection** (🤝 badge) on item rows where the looter
  and the corpse belong to the same guild. Surfaces cases where an
  allied player looted a guildmate's corpse — usually benign, but
  worth knowing for accountability. Rows also get a subtle pink left
  border.
- **Top-value ⭐** on the priciest item in each player card (only when
  the value is meaningful — >10k silver). Row gets a soft gold
  background wash so it's easy to spot the carry item.
- **Keyboard shortcuts** on the Loot Logger tab:
  `E` expand all, `C` collapse all, `F` focus search,
  `W` open whitelist, `?` show help modal, `Esc` close modal /
  clear death filter. Shortcuts don't fire while typing in a text
  field.

Service worker cache bumped `v5` → `v6`.

---

### 2026-04-16 — Loot Tools Phases 2-5: Deaths, Crafters, Cross-links, Combo A

Five phases landed in a single day. Highlights below; full phase-by-phase
detail in LOOT_ROADMAP.md.

**Phase 2 — Death tracking v1:**
Every session view now has a Deaths section above the player cards.
For each death we reconstruct "what they died with" by aggregating
every loot event where `looted_from_name === victim` — the stuff
picked up off the corpse. Card shows victim, killer, timestamp,
friendly/enemy side badge, estimated value, up to 8 corpse items,
and top 3 looters. Click **Filter** to narrow the main view to that
death's loot chain. Click **📋 Discord** for a formatted report.
Honest caveat surfaced in UI: items left unlooted / looted by
players outside capture range aren't counted.

**Phase 3 — Crafter attribution:**
Wired end-to-end for chest captures (Loot Buyer). The Go client
already reads `CrafterName` off equipment packets; frontend
renderLootItemRows now reads it and pushes it to the hover tooltip
so you see "Crafted by X" on every piece of gear you captured. Loot
drops (Loot Logger) continue to show "Unknown — looted" — game
protocol limitation, not a bug.

**Phase 4 — Cross-feature integrations:**
- Session detail → **✓ Accountability** button jumps to
  Accountability with the session pre-selected
- Accountability suspects banner → **💰 Value missing items**
  loads the aggregated missing items into Loot Buyer and runs the
  worth analysis so you see current market values
- Chest capture chip → **📦 Track** fast-path posts directly to
  `/api/loot-tab/save` without running Phase 1 eval (for "I already
  bought this, just let me log sales")

**Phase 5 — Combo A (QoL):**
- **Whitelist presets** in the Loot Logger whitelist modal: one
  click adds your primary guild / alliance / character name, auto-
  detected from the current session's most-common values
- **Item filter chips** above the player cards (multi-select):
  `T6+ / T7+ / T8+ / 🗡 Weapons / 🎒 Bags / 💎 >100k`. Tier chips are
  exclusive (one min-tier), category chips stack. Active chips get
  a gold pill, and a `✕ clear` pill appears when any are on.
- **Discord copy templates** — both the session Copy button and the
  accountability Copy button now show a dropdown:
  - Session: *GvG Summary*, *Top Looters*, *Deaths Report*
  - Accountability: *Accountability table* (existing), *Regear Report*
    (new, per-player missing items with silver values)

Service worker cache bumped `v4` → `v5`. Hard refresh if you see stale
UI. See LOOT_ROADMAP.md for the v2 roadmap picks that were deferred.

---

### 2026-04-16 — Loot Tools Phase 1: New Section + Visual Overhaul

**New "Loot Tools" navigation group:**
- Loot Buyer and Loot Logger promoted from the Trading dropdown into their own top-level group with a dedicated icon and menu, reflecting how central they've become.

**Icon size bump for readability:**
- Preview strip icons: 22 → 32 px (with hover zoom + subtle border)
- Expanded item rows: 28 → 40 px
- Loot Buyer item grid: 24 → 40 px
- Preview strip now caps at 10 unique items with a `+N` overflow indicator (was unbounded)

**Reusable hover tooltip component:**
- `data-tip` (plain text) or `data-tip-item` (rich card with icon, tier, enchantment, quality, market value, crafter)
- Wired on every Loot Logger item row + preview icon + Loot Buyer item row
- For loot pickups where crafter info isn't in the game packet, tooltip honestly shows "Unknown — looted" instead of hiding the row
- Vanilla JS, ~90 LoC, zero new dependencies

**Session overview strip:**
- Six at-a-glance stats above every session view: events, players, items looted, est. value, deaths (💀), duration
- Replaces the old muted single-line header

**Color-coded player cards:**
- Friendly guild members get a green 4 px left border
- Enemy loot sources get a red border
- Unknown players (no guild data) get a grey border

**Mobile / touch / a11y:**
- New 420 px breakpoint for narrow phones — toolbar stacks cleanly, session-name input goes full width
- Remove-player button now 32×32 px and always visible on mobile (was 20 px hover-only — unusable on touch)
- Session rename pencil + session delete `✕` bumped to 28–32 px touch targets
- ARIA labels on every icon-only button
- `Esc` key now closes the whitelist modal in addition to the feedback modal
- Focus-visible outlines on remove/rename buttons

**Service worker cache bumped `v3` → `v4`** so returning users pick up the new app.js. Hard refresh once if you see stale UI.

---

### 2026-04-15 — Batch 5 Wrap-up: Session Labels, Whitelist, Auto-save, CSV Exports, Upgrade Flips

**Loot Logger:**
- **Session labels:** name your live session before/after it starts (persisted to localStorage). Custom names show on the session card and on the saved-session list; a ✏️ button on each saved card lets you rename after the fact.
- **Player whitelist:** optional filter — only show events from names/guilds/alliances you care about. Modal accepts one entry per line; matches name, guild, or alliance (case-insensitive). Death events always pass through.
- **Auto-save draft:** opt-in toggle writes the in-flight loot log to localStorage every 5 minutes so a crashed tab doesn't lose data. Draft is cleared on successful save or manual reset, and the app offers to restore it on next load.

**CSV Exports (parity across tabs):**
- Transport Routes — `Export CSV` button next to `FIND ROUTES`, exports current route list with item, quality, cities, prices, profit, ROI, weight, volume, confidence, and data freshness.
- Live Flips — exports the filtered flip list (respects min profit, ROI, city, and type filters).
- Crafting — exports the current recipe scan with materials, tax, station fee, profit, and ROI.
- Arbitrage — exports current cross-city trades, including upgrade-flip markers.
- Portfolio already exported — unchanged.

**Upgrade Flips (cross-enchantment arbitrage):**
- New `🔮 Upgrade Flips` button on the Market Flipper tab.
- Scans cached prices for each gear-style base item, groups by `(base, city, quality)`, and finds every `@N → @N+1` (or multi-step) upgrade where the enchanted sell price covers buy price + estimated rune/soul/relic cost + 5.5% sell-order tax.
- Reuses the standard trade card with an `UPGRADE @0→@1` badge and a dedicated "Upgrade materials (est.)" row so the cost model is visible.
- Upgrade costs are tier-banded ballparks — the UI explicitly asks users to verify rune/soul/relic prices in-game before committing silver.

**Infrastructure:**
- Service worker cache bumped `coldtouch-v2 → v3` so returning users pick up the new app.js on next load.
- In-website changelog and About tab updated.

---

### 2026-04-14 — Full Audit Remediation (70+ items)

**Go Client (v0.7.0):**
- Cache eviction for playerCache (30-min TTL) and marketOrderCache (10-min TTL) — prevents memory leaks
- Thread-safe AlbionState with RWMutex — 8 getters/setters, all callers updated across 10 files
- New `--config-dir` flag with exe-directory fallback for portable config loading

**Backend:**
- Discord bot health monitoring (5-min isReady check + auto-re-login)
- NATS subscription wrapped in retry function with reconnect event logging
- WebSocket auth responses now use backpressure-safe wsSafeSend (6 calls fixed)
- Express 30s global request timeout middleware
- NATS price merge guard (price > 0) prevents expired order overwrite
- Email addresses masked in server logs (`yu***@gmail.com`)
- Old VPS IP default updated to current Contabo
- Password reset flow: `/api/forgot-password` + `/api/reset-password` with email token (1h TTL)
- Audit log table with logAudit() on login, register, password change, password reset
- Admin audit log endpoint: `GET /api/admin/audit-log`

**Loot Logger Bug Fixes:**
- Debounced live session re-renders (2s) — no more DOM thrashing on rapid WS events
- Debounced search input (300ms) — no more full re-render on every keystroke
- Reset confirmation dialog ("You have unsaved events. Discard?")
- Duplicate save prevention with "Saved" button state
- Death events excluded from item/player counts but shown with red outline + "Lost on Death" label
- Proportional deposit allocation — fair regardless of player iteration order
- Alliance-based enemy detection for multi-guild ZvZ (falls back to guild matching)
- CSV export now includes item_name, unit_price, total_value, weight columns

**Loot Logger New Features:**
- "Suspects" red banner on accountability — flags players with <80% deposit + total missing silver
- Per-player missing silver value on accountability cards
- "Copy to Discord" button — formatted markdown table for officers
- Export accountability CSV (player, guild, deposited%, missing items/silver)
- Expand All / Collapse All buttons
- Item tier filters (T5+, T6+, No Bags)
- Remove individual players from session view
- Drag-and-drop + multi-file upload with merged results
- Toast notification when chest captures arrive

**Platform-Wide:**
- Ctrl/Cmd+K universal search — search items, tabs, and features instantly
- In-game timers widget (daily reset + monthly countdown)
- PWA manifest + service worker — app is now installable
- Shareable URLs with deep linking (?tab=transport&from=Martlock&to=Caerleon)
- Tab initialization for portfolio, mounts, farm tabs
- Alerts page UI gated for non-logged-in users
- Console.log cleanup (9 debug logs gated behind DEBUG flag)
- Collapsible changelog in About page (500px max-height + "Show All")
- Freshness badges auto-update every 60s
- CSS z-index system with custom properties (--z-base through --z-toast)
- Toast stacking with max 5 visible + auto-eviction
- Disabled button styles (opacity + cursor)
- Arbitrage sort tiebreaker (secondary sort by item name)
- Compare tab error handling with user-friendly messages

**New Features:**
- Consumed flip tracking — mark flips as taken (24h auto-expire, localStorage)
- Preconfigured item lists (T4-T8 Leather/Plate/Cloth, Gathering Tools, Bags, Mounts)

### 2026-04-13 — Game Update: Protocol18 Support (v0.6.0)

- **Critical fix:** Albion Online's April 13 patch changed the network protocol from Protocol16 to Protocol18 (GpBinaryV18). The custom data client has been fully updated.
- **New protocol decoder:** Zigzag varint encoding, little-endian shorts, compressed integers, zero-value types, bit-packed boolean arrays — all decoded correctly.
- **Dual opcode matching:** Operations shifted +6 in the update; client now handles both old and new codes seamlessly.
- **Loot event shifted:** OtherGrabbedLoot moved from event 275 to 277.
- **All features confirmed working:** Chest capture (0 missing), mail sale tracking, market data upload to AODP, loot logger, death events, player location, VPS relay.
- **Download v0.6.0** from [GitHub Releases](https://github.com/coldtouch/albiondata-client/releases/tag/v0.6.0) — older versions will crash after the game update.

### 2026-04-12 — Crafting Calculator Revamp

- **Quality selector:** Choose Normal through Masterpiece quality — sell prices now reflect the selected quality instead of always assuming Normal.
- **City bonus dropdown:** Replaced manual percentage input with preset options (No Bonus, Royal City 15%, Caerleon 20%, Island T2/T3).
- **Shopping list fixed:** Now actually populates with real prices grouped by cheapest buy city, with copy-to-clipboard button.
- **Focus cost display:** Shows focus consumed and silver-per-focus ratio when Focus is enabled.
- **Tab state persistence:** Switching away from Crafting and back now restores your last calculation instead of showing a blank page.
- **Settings saved per setup:** Quality selection is now included in save/load setups.
- **Recalculate without refetch:** Changing quality/settings uses cached data instead of hitting the API again.

### 2026-04-11 — Sale Notifications from In-Game Mail

- **Auto sale detection:** The Go client now reads marketplace sale mails (sold/expired) and relays them to the VPS in real-time.
- **Auto-match to tracked tabs:** When a sale is detected, it automatically matches to open/partial loot tabs containing that item and records the sale.
- **Recent Sales feed:** New section on the Loot Buyer tab shows the last 10 auto-detected sales with item, quantity, price, and auto-match status.
- **Toast notifications:** Real-time toast when an item sells while the website is open.
- **Chest capture fix:** Fixed int16 overflow in slot IDs — game update pushed slot values beyond 32,767. Widened all item event struct fields to int32.
- **Mail protocol update:** Rewrote GetMailInfos decoder for changed game protocol param layout.

### 2026-04-11 — Loot Logger: player card UX overhaul

- **Item icon preview in header:** Each player card now shows all unique item icons to the right of the player name, giving an at-a-glance view of what they looted. Replaces the old gold initials avatar.
- **Guild color grouping:** Players from the same guild share a matching left border color and guild name color, making it easy to visually identify guild members at a glance.
- **Clickable items → Market Browser:** Clicking any item row in the expanded player card navigates directly to the Market Browser with that item pre-filled in search for price lookup.

### 2026-04-11 — Loot Logger: search/sort + fix stuck loading

- **Search bar on player cards:** Filter loot session results by player name, guild, alliance, or item name. Shows filtered/total count (e.g., "2/8").
- **Sort dropdown:** Sort players by Value, Items, Weight, or Name A-Z. Default is Value descending.
- **Fix: "Loading sessions..." no longer hangs forever.** Sessions tab now checks auth upfront — if not logged in, shows "Log in with Discord" immediately instead of waiting for a fetch that never completes. Upload mode hint shown for unauthenticated users.
- **Timeout + retry:** Session fetch now has 8-second timeout. Network errors show "Could not reach server" with a Retry button (separate from auth errors).
- **Responsive:** Search/sort bar stacks vertically on mobile.

### 2026-04-10 — UX: Browser item count label

- **`#browser-count` now reads "X known items"** instead of "X items" — clarifies this is the full game catalog count, not items with price data in cache. Commit 155c685.

### 2026-04-10 — Fix server switch not reloading prices

- **Server dropdown now clears and reloads prices on change.** Switching between Europe / Americas West / Asia East now immediately clears the IndexedDB price cache (which was stale from the previous server) and reloads it from the correct source.
- **VPS cache reload is server-aware.** The background `/api/market-cache` endpoint is only used when the user's selected server matches the server the VPS scans. For other servers, prices load on-demand directly from AODP when browsing items.
- **Background refresh interval fixed.** The 5-minute auto-refresh of the VPS cache is now skipped when the user is viewing a different server, preventing Europe-server prices from silently repopulating the cache.
- **Status bar updates** show "Switching to [Server]..." during the transition and update to reflect the new item count once done. A toast message informs users of the on-demand pricing mode for non-VPS servers.
- **Market Browser re-renders** immediately after the switch; other scan tabs (Flipper, Transport, etc.) require the user to re-run their scan to get new-server data.

### 2026-04-10 — Loot Logger major revamp

- **Live Session toolbar:** Persistent "Start / Stop Live Session" toggle button at the top of the tab. Loot events from the Coldtouch client only accumulate while the session is active. "Save Session" and "New Session" buttons also added.
- **Player cards redesigned:** Circular avatar with initials, per-player stats (item count, estimated silver value, weight). Items collapsed by default; expand to see full item list with icons, quantity, value, and weight per row. Cards update in-place for accountability status.
- **Estimated item values:** All item rows now show estimated silver value from IndexedDB price cache (Caerleon-preferred, best available city fallback). Session and player totals show aggregate estimated value.
- **Chest Capture panel (Accountability tab):** Explicit "Start Capturing" / "Stop Capturing" toggle with pulsing indicator. Captured tabs shown as chips (name + item count + weight). "Reset" clears all captures.
- **Accountability coloring in-place:** After running the check, item rows in each player card are color-coded: green = deposited, red = missing, yellow = partial deposit, gray = died with it. Deposit progress bar under each player header.
- **Death event prep:** `handleLootLoggerWsMessage` handles `death-event` type; marks looted items as "died with" (gray) when a player death is received from the Go client.
- **Upload mode:** Added "Clear" button to reset upload view. Upload parser unchanged.
- **Back button:** Session detail view now has a "← Back" button to return to the session list.

### 2026-04-10 — Discord login reliability fix

- **Backend:** Added `readDb` — a third SQLite connection (`OPEN_READONLY`) dedicated to `/api/me`. In WAL mode, separate connections can read concurrently without waiting for write transactions. Previously `/api/me` queued behind market scan batch-inserts on the main `db` connection, causing 5s timeouts during background jobs → Discord login appeared broken.
- **Frontend:** JWT fallback — if `/api/me` is unreachable (timeout/network error) but a valid non-expired JWT exists in localStorage, the auth check now decodes the JWT payload locally and logs the user in from cached claims. A transient VPS hiccup no longer looks like a login failure.
- **Frontend:** `/api/me` timeout raised 5s → 8s. Added one auto-retry with 1.5s pause before throwing.

### 2026-04-10 — SEO improvements

- **Title tag:** Expanded with targeted keywords ("Market Prices, Flipping & Crafting Tool") for better search ranking
- **Meta description:** Rewritten to cover all major features and call-to-actions for search result snippets
- **Meta keywords:** Added comprehensive Albion Online keyword set
- **Canonical URL:** Added `<link rel="canonical">` and `<meta name="robots" content="index, follow">`
- **Open Graph:** Added `og:title`, `og:description`, `og:image`, `og:url`, `og:type`, `og:site_name` for Discord/social previews
- **Twitter Card:** Added `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image` for Twitter/X previews
- **JSON-LD:** Added WebApplication schema markup (name, description, featureList, offers) for Google rich results
- **Favicon:** Inline SVG favicon — site now shows a gold chart icon in browser tabs without a separate image file
- **robots.txt:** Created — allows all crawlers, references sitemap
- **sitemap.xml:** Created — single canonical URL with weekly changefreq
- **Performance:** Added `preconnect` for `fonts.gstatic.com` (was missing alongside the googleapis preconnect)

### 2026-04-09 — Audit fixes #7-9: Toasts, cross-feature links, price cache

- **Fix #7:** Replaced 20+ `alert()` calls with non-blocking toast notifications. Toast system supports info/warn/error/success types with auto-dismiss. 5 `confirm()` calls kept for destructive actions only.
- **Fix #8:** Cross-feature synergy links — "Craft?" button on Market Flipper cards jumps to Crafting tab with item pre-filled. "Flips" button on Market Browser cards scans that item for flip opportunities.
- **Fix #9:** Module-level price cache (`getCachedPrices()`) with 30-second TTL. `renderBrowser()` no longer reads all IndexedDB prices on every page flip, filter, or sort change. Cache invalidated when new market data arrives.

### 2026-04-09 — Audit fixes #1-6

- **Fix #1:** `computeAnalytics` moved to `statsDb` connection — was silently failing with SQLITE_BUSY because it ran on the main DB connection that blocks all user requests. Now properly logs errors instead of "No 7d data, skipping."
- **Fix #2:** `itemNames` → `ITEM_NAMES` in Loot Buyer sale form (2 occurrences) — sale recording dropdown was showing raw item IDs instead of friendly names.
- **Fix #3:** XSS fix — `esc()` added to `plan.buyCity`/`plan.sellCity` in innerHTML on transport haul cards.
- **Fix #4:** `scanAbortController` wired into `doArbScan` and `doTransportScan` — rapid clicks now abort the previous scan instead of firing duplicate fetch chains.
- **Fix #5:** Analytics chart now shows **EMA 7d** (green dashed) and **VWAP** (purple dashed, when volume data available) alongside Price, SMA 7d, and SMA 30d. Added `computeEMA()` helper.
- **Fix #6:** **Stale data badges** on Market Flipper cards — red "STALE DATA" badge when prices are 6+ hours old, yellow "Data is 2+ hours old" warning for moderately aged data.

### 2026-04-09 — Loot Logger Viewer + Accountability Check

- **New tab: Loot Logger** — under Trading group. Three modes: Live Sessions, Upload Log File, Accountability Check.
- **Live Sessions:** View loot events captured in real-time by the Coldtouch client. Per-player breakdown showing who looted what, with guild/alliance info, item icons, and quantities. Sessions auto-created per client connection.
- **Upload Log File:** Import `.txt` files from the ao-loot-logger tool (semicolon-delimited format). Events stored in DB and viewable like live sessions.
- **Accountability Check:** Cross-reference a loot session (who picked up items) against a chest tab capture (what was deposited). Shows per-player deposit percentage with progress bars. Items color-coded: green = deposited, yellow = partial, red = missing.
- **Backend:** New `loot_events` DB table with session grouping. WebSocket handler stores incoming loot events from game client and pushes to browser in real-time. New API endpoints: `GET /api/loot-sessions`, `GET /api/loot-session/:id`, `POST /api/loot-upload`, `DELETE /api/loot-session/:id`.

### 2026-04-09 — Real item weights across website + delete tracked tabs

- **Real game weight data:** Added `itemweights.json` (11,535 items) generated from ao-bin-dumps game files. Replaces the old tier-based weight estimation with actual in-game weights. Mounts, furniture, and unique items now have correct weights.
- **Market Browser:** Weight badge shown on each item card (e.g., "5.1 kg").
- **Transport Routes:** Haul plan collapsed summary now shows total weight vs mount capacity (e.g., "450/1764 kg").
- **Loot Buyer — Capture cards:** Total tab weight shown in card meta line.
- **Loot Buyer — Item rows:** Per-item weight displayed next to quantity.
- **Loot Buyer — Selected capture header:** Total weight in stats line.
- **Loot Buyer — Sell plan:** Weight per trip shown in trip header (helps plan which mount to use).
- **Loot Buyer — Delete tracked tab:** New "Delete" button on tracked tab cards with inline confirmation. Removes the tab and its sales from the database.
- **Backend:** New `DELETE /api/loot-tab/:id` endpoint (JWT-authenticated, cascades to sales).

### 2026-04-09 — Go Client: Chest capture fully working + item weights

- **Chest capture architecture rewrite:** Replaced timer-based EquipItem collection with a global item cache + `evAttachItemContainer` param 3 slot lookup. Items are cached globally by slot number from all 6 item event types, then looked up when the game attaches a container tab. This matches how Triky313/AlbionOnline-StatisticsAnalysis captures chests.
- **3 new item event handlers:** Added `evNewFurnitureItem` (opcode 33), `evNewKillTrophyItem` (34), `evNewLaborerItem` (36). Mounts, furniture, kill trophies, and laborer contracts now captured correctly. Total: 6 item event types handled.
- **Updated itemmap.json:** Regenerated from latest ao-bin-dumps (April 1, 2026 game update). ALL 11,964 numeric item IDs had shifted — the old map resolved every item to the wrong name. Now 11,963 entries.
- **New weightmap.json:** Generated 11,235 weight entries from ao-bin-dumps `items.json` `@weight` field. Enchanted items inherit base weight. Per-item weight and total tab weight included in every capture.
- **Verified on personal island:** 4 tabs captured (Bank 109 items/589.4 kg, loot 43/160 kg, loot3 15/40.2 kg, vanity 5/230.5 kg). All items match in-game names, crafter names verified, weight exact match confirmed.

### 2026-04-09 — Fix: Discord login broken during SpreadStats (separate DB connection)

- **Root cause:** `computeSpreadStats` was running a 90-second `db.all()` (GROUP BY across 3M+ rows) on the **main shared SQLite connection**. All Express handlers — including the 5-second-timeout `/api/me` call made right after Discord OAuth — queued behind it. Result: `/api/me` timed out, user saw "Could not reach server", login appeared broken.
- **Fix:** SpreadStats now uses a **separate `statsDb` connection** for both its big read (`statsDb.all()`) and all 526k write transactions (`statsDb.serialize()`). The main `db` queue is completely unblocked during SpreadStats runs.
- **Fix:** `computeAnalytics` now checks `statsRunning` before starting (guard against simultaneous execution). `computeSpreadStats` now checks `analyticsRunning` symmetrically.
- **No change to auth logic** — Discord OAuth code, JWT, and routes untouched.

### 2026-04-09 — Transport mount capacity system fix

- **Corrected mount weight values:** T8 Transport Mammoth fixed from 1,696 kg to **1,764 kg**; all other mount weights verified against in-game values.
- **"No Mount" now uses 600 kg base weight** (player inventory bags) instead of ignoring weight entirely.
- **Mounts do not add inventory slots** — slot calculation is now purely based on the player's "Free Slots" input. Removed the incorrect "+8 slots for Mammoth" logic.
- **MOUNT_DATA config object:** Centralized `{ weight, label }` table replacing raw numeric dropdown values. Mount keys used instead of raw integers.
- **`getTransportMountConfig()` helper:** Single function reads mount dropdown + free-slots input, returns `{ mountCapacity, freeSlots }`. All 8 call sites updated to use it.
- **Capacity info line:** A "Carry capacity: X kg" line below the mount dropdown updates live on selection change.
- **Infinity-safe weight check:** `Number.isFinite(mountCapacity)` replaces old `> 0 && < 999999` guard; "Ignore Weight" option properly passes `Infinity` through the entire chain.

### 2026-04-09 — Workstream 2: Frontend analytics improvements

- **Analytics tab in chart modal:** Chart modal now has a "Live Prices" / "Analytics" toggle. The Analytics tab fetches from our own `/api/price-history` endpoint and renders a price line with SMA 7-day (gold) and SMA 30-day (blue) overlays computed client-side from hourly/daily data. Includes a legend and time toggles (7 days / 30 days). Switches city when the city dropdown changes.
- **Trend arrows on Market Flipper and BM Flipper cards:** Each card now shows a small trend badge next to the item name (green ▲ / red ▼ / neutral —) loaded asynchronously from `/api/analytics/:itemId`. Displays the 24h-vs-SMA7 % change. Uses a client-side cache to avoid duplicate requests.
- **Volatile badge on Market Flipper, BM Flipper, and Transport cards:** If a route's `consistencyPct < 50%` (profitable less than half the time over 7 days), an orange "Volatile" badge appears alongside the confidence badge. Helps users avoid deals that look good on average but swing unpredictably.
- **CSS:** New `.trend-badge` (`.trend-up`, `.trend-down`, `.trend-neutral`), `.volatile-badge`, `.chart-tab-bar`, `.chart-tab-btn`, `.analytics-legend`, `.analytics-legend-item`, `.analytics-legend-dot` classes added. Gold accent for active tab.

### 2026-04-09 — Workstream 1B: Analytics computation engine

- **`price_analytics` table:** Stores pre-computed SMA 7d, SMA 30d, EMA 7d (α=0.25), VWAP 7d, price trend (%), and spread volatility per `(item_id, city, quality)`. Populated by `computeAnalytics()` which runs every 30 minutes.
- **`price_hourly` OHLC table:** Stores open/high/low/close/avg/volume per hour for the 7–30 day window. Migrated from `price_averages hourly` during compaction.
- **Three-tier retention (compactOldData rewrite):** Tier 1 = `price_averages hourly` (0–7 days, default). Tier 2 = `price_hourly` OHLC (7–30 days). Tier 3 = `price_averages daily` (30+ days, forever). Each tier explicitly deletes migrated rows after insertion.
- **`computeAnalytics()` implementation:** SMA/VWAP/trend/spread volatility computed in a single SQL GROUP BY pass (memory-safe). EMA computed in JS batches of 100 combos with event-loop yields. Guard flag prevents concurrent runs.
- **`checkDiskUsage()` disk safety:** Runs alongside compaction. Reads SQLite page size × page count to get exact DB size. Triggers aggressive compaction (3-day raw retention) at 10 GB; emergency compaction (1-day) at 20 GB.
- **`GET /api/analytics/:itemId`:** Returns all pre-computed metrics. Optional `city` and `quality` query params. Without `city`, groups by city.
- **`GET /api/price-history` upgraded:** Now returns `{ history, ohlc, analytics }` — the existing price series plus OHLC data from `price_hourly` and moving averages from `price_analytics`. Frontend updated for backward compatibility.
- **`GET /api/admin/db-stats`** (JWT-protected): Returns DB size, row counts per table, oldest/newest timestamps, analytics running state.

### 2026-04-09 — Workstream 1A: VPS constraints lifted, analytics engine optimised

- **Node heap raised:** `--max-old-space-size` increased from 2048 MB to 6144 MB to match new Contabo VPS 20 (11 GB RAM, 6 vCPUs).
- **computeSpreadStats rewritten (SQL aggregation):** Replaced the old approach that loaded up to 1 million raw hourly rows into JS memory with a single SQL `GROUP BY (item_id, quality, city)` query. SQLite now does the aggregation; Node receives one pre-averaged row per city instead of one row per hourly period — reducing peak memory by orders of magnitude.
- **Removed 1M row LIMIT:** The defensive `LIMIT 1000000` cap on the price_averages spread query has been removed; the SQL aggregation approach no longer risks OOM from large result sets.
- **Composite indexes added:** `idx_pa_item_city_ts ON price_averages(item_id, city, period_start)` and `idx_pa_spread_query ON price_averages(period_start, avg_sell, avg_buy)` speed up the spread query; `idx_ss_item_quality ON spread_stats(item_id, quality)` speeds up flipper lookups. All use `CREATE INDEX IF NOT EXISTS` — safe to re-run.
- **WAL checkpoint added:** `PRAGMA wal_checkpoint(TRUNCATE)` now runs every 6 hours to prevent WAL file bloat on a write-heavy database.
- **Conditional VACUUM:** After compaction, if more than 100,000 hourly rows were deleted (~500 MB), a `VACUUM` is scheduled during the 2–4 AM UTC low-traffic window to reclaim disk pages. Skips if a VACUUM is already queued.

### 2026-04-09 — Crafting Revamp Phase 1: Formula fixes and tax rate correction

- **Corrected market tax rates globally:** `TAX_RATE` changed from 6.5% to 3% (actual market transaction tax). Added separate `SETUP_FEE = 2.5%` constant for sell-order listing fee. Combined 5.5% now applied wherever crafters/traders place sell orders; 3% applied for instant-sell scenarios (BM flipper, transport insta-sell, Farm & Breed).
- **Crafting station fee base fixed:** Station fee (set by station owner) is now calculated as a percentage of the item's sell price (item value), not the raw material cost. This matches how Albion Online charges station fees in-game.
- **Crafting profit labels updated:** Crafting Profits tab now shows "Tax+Setup (5.5%)" instead of the old incorrect "Tax (6.5%)". Transport cards show "Tax (3%)" for instant sell and "Tax+Setup (5.5%)" for sell order routes.
- **Portfolio tax estimate corrected:** Net P/L estimate now uses 5.5% (3% tax + 2.5% setup) to account for sell orders.
- **Transport sell-order tax corrected:** `soTax` now uses 5.5% (was 6.5%) for sell-order profit rows in transport and BM journal flipper.
- **Transport route enrichment:** Sell mode is now respected — instant-sell routes use 3% tax, market-listing routes use 5.5%.
- **City Compare refresh button:** Already present — verified the refresh button in City Compare header works correctly (same pattern as Transport/Flipper cards).
- **RRR formula verified:** Base RRR of 15.2% in a royal city (18% production bonus) confirmed correct. Focus bonus (59% PB flat) and spec-based scaling in standalone RRR calculator unchanged — values are within expected range of ~47-49% max effective return at max spec.

### 2026-04-07 — Batch: Flip fix, XSS hardening, mobile, download page, capture toggle

- **Live Flip false positives reduced:** Black Market prices now use a tighter 3-minute freshness window (vs 5 min for other cities). Added global price outlier check — flips where the sell price exceeds 4x the global average are rejected as stale. `broadcastFlip()` now always validates (waits for rate limit instead of skipping validation).
- **Portfolio XSS hardened:** `t.itemId` in img src now uses `encodeURIComponent()`. Trade delete buttons use `data-trade-id` with `esc()` + event delegation instead of inline onclick with raw user data from localStorage.
- **Mobile responsive:** Added `@media (max-width: 600px)` breakpoints for inline sale form, manual item entry, sell plan, and loot capture cards.
- **Custom client download page:** New "Coldtouch Data Client" section in the About tab — what it does, how it works, 5-step setup guide, and comparison table vs AODP client.
- **Capture mode toggle (Go client):** `--capture=false` CLI flag or `CaptureEnabled: false` in config.yaml disables chest scanning. Defaults to true.

### 2026-04-07 — Feature: Manual item entry on Loot Buyer

- **"+ Add Items Manually" button:** Toggles an inline form on the Loot Buyer tab for adding items without the game client.
- **Item search with autocomplete:** Reuses the existing `setupAutocomplete()` — searches 11k+ items by name, tier, or ID. Shows up to 8 matches.
- **Quality selector + quantity input:** Pick Normal through Masterpiece quality and set stack count.
- **Smart duplicate merging:** Adding the same item+quality again merges quantities instead of creating duplicates.
- **Item list with remove buttons:** Each added item shows icon, name, quality, quantity, and an × remove button.
- **"Use These Items" button:** Creates a manual capture that feeds into the same Buy Decision / Sell Optimizer analysis flow as real chest captures.
- **"Clear All" button:** Resets the manual item list.
- **CSS:** `.loot-manual-item`, `.loot-manual-item-name`, `.loot-manual-item-qty`, `.loot-manual-remove` classes.

### 2026-04-07 — Feature: Sell plan travel route suggestion

- **Route heuristic:** When the sell optimizer groups items across multiple cities, a suggested travel route is shown based on Royal Continent geography (Caerleon → Martlock → Fort Sterling → Thetford → Lymhurst → Bridgewatch → Brecilien → Black Market).
- **Route in summary:** Displayed as a subtle hint line below the sell plan summary bar.
- **Route in clipboard:** "Copy All Trips" text now includes the suggested route at the top.
- **Non-intrusive:** Only shows when 2+ cities are in the plan. Unknown cities are appended at the end.

### 2026-04-07 — Fix: Unknown items in chest captures + SMTP verified

- **Special item mapping (Go client):** Negative numeric IDs (-1 through -9) now resolve to human-readable names: Silver, Gold, Fame Credit, Silver Pouch, Gold Pouch, Tome of Insight, Seasonal Token, etc.
- **Special items filtered from captures:** `addItem()` in the Go client now skips internal/currency items (silver, gold, fame credits) since they aren't tradable on the market and would clutter loot analysis.
- **Backend friendly names:** `getFriendlyName()` now has a `SPECIAL_ITEM_NAMES` fallback map so any special items that reach the backend display proper names instead of raw IDs.
- **SMTP verified working:** Confirmed `[SMTP] Mail transporter ready` in VPS logs — email verification is live, no longer auto-approving accounts.

### 2026-04-07 — UX: Inline Sale Recording Form

- **Replaced `prompt()` dialogs:** The "+ Record Sale" button on tracked loot tabs now opens an inline form instead of three sequential browser prompts.
- **Item dropdown:** Populated from the tab's actual items (deduplicated by item+quality, showing name and quantity). Includes a "Custom item ID" fallback option for items not in the list.
- **Auto-fill quantity:** Selecting an item pre-fills the quantity field with the item's count from the tab.
- **Quality preserved:** Quality is carried from the selected item (no longer hardcoded to 1).
- **CSS:** New `.sale-inline-form`, `.sale-form-row`, `.sale-form-select`, `.sale-form-input`, `.sale-form-actions` classes matching the glassmorphism theme.

### 2026-04-07 — Feature: Feedback & Bug Report

- **Floating feedback button:** Fixed bottom-right chat-bubble FAB opens a glassmorphism modal. Works on all tabs, no login required.
- **Modal fields:** Type selector (Bug Report / Suggestion) + message textarea with live character counter (max 1000). ESC and click-outside dismiss.
- **Backend endpoint:** `POST /api/feedback` in backend.js. Validates type and message (5–1000 chars), resolves user from JWT if logged in, posts a Discord embed to `DISCORD_FEEDBACK_WEBHOOK`. Rate-limited to 1 submission/minute per user ID (or IP for guests).
- **Discord embed:** Colored by type (red = bug, blue = suggestion), shows message body, "Submitted by" field with username and user ID (or "Anonymous"). Includes ISO timestamp.
- **Deploy:** `DISCORD_FEEDBACK_WEBHOOK` added to `.env` template in deploy_saas.py — set this env variable to activate. Endpoint returns 503 gracefully when webhook is not configured.

### 2026-04-07 — Fix: Market Flipper freshness Max Age input restored

- **Root cause:** `fresh-threshold-group` had `style="display:none;"` in HTML but `init()` never ran the show/hide sync on load — so the Max Age dropdown was permanently hidden until the user manually changed the Fresh Filter mode dropdown.
- **Fix:** Extracted `syncFreshThreshold()` from the `change` listener and called it immediately on load in `app.js`. Removed the redundant inline `display:none` from the HTML so CSS/JS state is the single source of truth.

### 2026-04-07 — Phase 3: Loot Tab Lifecycle Tracker

- **DB tables:** `loot_tabs (user_id, tab_name, city, purchase_price, items_json, purchased_at, status)` and `loot_tab_sales (loot_tab_id, item_id, quality, quantity, sale_price, sold_at)` added via SQLite `CREATE TABLE IF NOT EXISTS`.
- **5 new API endpoints:** `POST /api/loot-tab/save` (I Bought This), `GET /api/loot-tabs` (list with revenue summary), `GET /api/loot-tab/:id` (detail + sales), `POST /api/loot-tab/:id/sale` (record a sale), `PATCH /api/loot-tab/:id/status` (update open/partial/sold). All JWT-auth gated via `requireAuth`.
- **"I Bought This" button:** Appears after any loot analysis (both Worth Buying and Sell Optimizer modes). Includes a city input field. On save, turns green and triggers tracker refresh.
- **My Tracked Tabs section:** Shown below loot results, auto-loads when switching to Loot Buyer tab. Each card shows tab name, city badge, status badge, paid/revenue/net profit/progress stats, and a fill-bar progress indicator (accent → yellow → green as revenue approaches purchase price).
- **Expandable detail view:** Click any card to expand — shows all recorded sales (item, qty, total silver, date), revenue/net profit summary, "+ Record Sale" prompt, and a status dropdown.
- **Manual sale recording:** `recordSale()` prompts for item ID, quantity, and price-per-unit. Collapses detail and reloads tracker on success.
- **CSS:** `.loot-tracked-card`, `.loot-tracked-header`, `.loot-tracked-stats`, `.loot-tracked-progress-bar/fill`, `.loot-tab-badge`, `.loot-tab-status` (open/partial/sold variants), `.loot-status-select`.

### 2026-04-07 — Phase 2: Sell Optimizer complete

- **`buildSellPlan()` helper:** Per-item sell strategy decision using an 85% threshold — if instant sell is within 15% of the best market listing price, prefer instant (take the certainty). Otherwise recommend listing on market. Items with neither price go to a "No Market Data" bucket.
- **`renderSellPlan()` fully rebuilt:** Summary bar (total trips, total silver, instant vs listed split, items with no data warning). One city trip card per destination, sorted by expected value descending. Per-item rows show icon, name×qty, Instant/Market badge, price/ea, and total silver.
- **Safe copy buttons:** `copySellTrip()` uses `data-copytext` attribute on the card element (no inline string escaping). "Copy List" per trip and "Copy All Trips" master button. Clipboard text is human-readable with city, method (Instant sell / Market list), item names, quantities, and prices.
- **CSS added:** `.sell-plan-summary`, `.sell-trip-header`, `.sell-plan-item` grid, `.sell-plan-icon`, `.sell-method-badge` (instant/market), `.loot-copy-all-btn`. Mobile breakpoint hides price/ea column below 600px.
- **No-data edge case:** Items with no buy orders AND no market price shown at bottom in a dimmed card, flagged with `danger` risk badge.

### 2026-04-07 — Phase 1: Buy Decision Helper complete

- **Loot-evaluate endpoint hardened:** Fixed `no_buy_orders` flag — previously fired when buy order AMOUNT was unknown (NATS hadn't filled it yet), even though a buy order existed. Now only fires when no buy orders exist anywhere (`bestBuyMax === 0`). Added `stale_data` flag for items where all price data is >6h old. Added daily volume proxy from `price_averages.sample_count` to the response (`dailyVol` per city). Added server-side `verdict` field (`buy`/`maybe`/`skip`) in the totals when `askingPrice` is sent.
- **Loot-evaluate volumeRef cache:** `buildPriceReference()` now builds `volumeRef` alongside `cityPriceRef`, querying `AVG(sample_count)` per item/quality/city. Used for future low-volume flags.
- **Buy Decision UI complete:** `renderWorthAnalysis()` now shows margin % in the BUY verdict, passes `askingPrice` to the server. Risk badges styled with `.risk-badge` (danger/warning/ok). Verdict banner styled with `.loot-verdict` (good/caution/bad). Risky item count in stats bar.
- **Auth-aware analyze:** If user isn't logged in, Analyze shows a login prompt instead of a 401 error.
- **CSS for analysis UI:** Added `.loot-verdict`, `.risk-badge`, `.loot-city-group` classes that were referenced but unstyled.
- **Go client tab ordering fix:** `ContainerManageSubContainer` now tries GUID matching first (exact tab regardless of click order); falls back to incrementing sequential counter only if GUID match fails. Captures `ContainerSlot`, `ContainerGUID`, and all remaining params for debugging.

### 2026-04-06 — Loot Buyer tab fix + client tab index tracking

- **Loot Buyer tab names fixed:** Each chest capture is now shown as one card with the correct vault tab name. The previous slot-range-splitting approach was wrong (each capture = one tab's items, not all tabs). The card now uses `tabIndex` from the client to look up the vault tab name from the captured vault structure.
- **Captures area scrollable:** `#loot-captures-list` now has `max-height: 260px` with `overflow-y: auto`, preventing many cards from pushing analysis controls off-screen.
- **Go client — tab index tracking:** `ContainerOpen` resets the tab counter to 0 (new chest open). `ContainerManageSubContainer` increments it before starting the next collection. Each capture now includes a `tabIndex` field so the website can map it to the correct vault tab name without relying on GUID matching.
- **Go client — tab name resolution in finalize():** If GUID matching didn't provide a direct tab name, `finalize()` now looks up the tab name from the current vault info using `tabIndex`. This gives correct names even when GUID matching fails, as long as the player clicks tabs in order.
- **Go client — matchContainerToVaultTab returns (name, index):** Updated to return both the matched tab name and its 0-based index, so `ContainerOpen` can set the exact tabIndex when a GUID match succeeds.

### 2026-04-05 — Transport Freshness Filter, Live Flip Validation, Volume Awareness

- **Transport freshness filter:** Added Buy/Sell/Both freshness filter with configurable max age (30m/1h/2h/6h). Stale routes are filtered out before haul plan packing — same pattern as Market Flipping.
- **Live flip price validation:** `broadcastFlip()` now validates prices against the live API before broadcasting. Catches stale Black Market prices (listing gone, price moved >15%, profit vanished). Rate-limited to 1 API call/second.
- **Transport volume awareness:** Daily volume shown on every haul plan item row (`~N/day`). Yellow warning when suggested quantity exceeds estimated daily volume. Volume cap tightened from 2x to 1x daily volume to give realistic packing.
- **Freshness re-render:** Changing the freshness filter or threshold live-updates the transport results without re-scanning.

### 2026-04-05 — Email Verification, User Profile, and Live Flip Enhancements

- **Email verification system:** Registration now generates a verification token (24h expiry). When SMTP is configured, verification email is sent with branded HTML template. Accounts are auto-verified when SMTP is not configured. New `/api/verify-email` and `/api/resend-verification` endpoints. Verification status shown in profile page with resend button.
- **User Profile page:** New Profile tab (visible when logged in) with avatar, username, email, auth type, verification status, tier badge, and member-since date. Contribution stats card showing 30-day scans, all-time scans, and current tier. Account settings: change username (issues new JWT), change password (email accounts), link/unlink Discord.
- **Same-city instant flips:** `detectFlip()` now detects profitable instant flips within the same city (buy order price > sell offer price). Purple "Instant" badge distinguishes them from blue "Transport" cross-city flips.
- **Live Flip enhanced filters:** City filter (filter by any city involved in the flip), flip type filter (cross-city vs instant), sound notification toggle (880Hz beep), desktop notification support with permission request. Stats bar showing flip count and total potential silver.
- **Flip buffer doubled:** MAX_FLIPS increased from 100 to 200 for richer history.
- **Refactored auth UI:** Extracted `updateHeaderProfile()` helper to deduplicate login/register/OAuth profile update code.

### 2026-04-05 — User Registration, Live Flips, and Discord Alert Gating

- **Email/password registration:** New `/api/register` and `/api/login` endpoints with bcrypt password hashing (12 rounds). Users table extended with email, password_hash, auth_type, role, and timestamps. Registration form on the landing page alongside Discord login.
- **Live Flip Detection:** Real-time flip detection from NATS market stream. Backend `detectFlip()` finds cross-city spreads (10k+ profit, 3%+ ROI) and broadcasts to authenticated WebSocket clients. In-memory circular buffer of 100 recent flips. New "Live Flips" tab in the frontend with filterable feed and slide-in animations.
- **Registration-gated features:** Live flips API requires authentication. Discord bot `/setup_alerts` command now checks if the user has a registered website account. Unregistered users get a friendly setup guide.
- **Discord account linking:** Email users can link their Discord account via OAuth flow. Backend handles `state` parameter to distinguish login vs. linking.
- **Haul plan collapse fix:** Three bugs fixed — removed `data-action="refresh"` double-handler from haul plan buttons, added `freeSlots` param to generic refresh handler, and improved expanded state tracking with `data-route-key` DOM snapshot before re-render.

### 2026-04-05 — Transport refresh buttons + In-website changelog update

- **Per-item refresh buttons:** Every item row in a haul plan now has a small refresh icon that fetches live prices for that specific item and re-renders the transport results.
- **"Refresh All" button:** Each haul plan's detail section has a "Refresh All" button that fetches prices for every item in the plan at once.
- **Buy/sell prices inline:** Item rows now show `Buy @ 150,000` and `Sell @ 200,000` with freshness indicators, so you can see exactly what prices the plan is using.
- **In-website changelog updated:** Added April 4-5 entries covering the server migration, DB architecture fix, Discord bot alerts, and transport overhaul.

### 2026-04-05 — Fix Discord bot alerts + Transport routes overhaul v2

- **Discord bot alerts fixed:** Alerts were not firing because the alerter's 30-minute freshness check rejected all seeded data. The API's `sell_price_min_date` reflects when a price last *changed*, not when we verified it. Items with unchanged prices for >30 min were treated as stale even though they're still live. Fix: treat recently-fetched API prices (<24h old) as fresh.
- **Alert threshold lowered:** 500k → 50k. Only 5 items in the entire market had spreads above 500k — now 500+ routes qualify.
- **Alerter diagnostic logging:** Every 10 minutes, the alerter logs a stats summary (checked/stale/noProfit/belowThreshold/sent) for easy debugging.
- **Live validation spam fix:** When a listing disappears, NATS keeps triggering `checkAndAlert` on every update for that item. Added a 2-minute cooldown on failed live validations to prevent API spam.
- **Transport haul plans v2:** Two-pass packing algorithm — Pass 1 caps each item at 40% budget/slots to guarantee 3+ items per haul, Pass 2 fills remaining capacity. Removed fake volume caps (sample_count is poll frequency, not trade volume). Added freshness indicators + "No vol data" warnings to haul plan items and summary bar.

### 2026-04-05 — Transport routes: shopping list, query optimization, volume safety

- **Copy Shopping List button:** Each haul plan card now has a clipboard button that formats the trip's items into a readable shopping list (item names, quantities, prices, total cost, expected profit, ROI). Click to copy, then paste in-game or to friends.
- **Backend CTE query optimization:** Replaced 3 correlated subqueries in `/api/transport-routes` with a single CTE that pre-aggregates volume data, then JOINs to spread_stats. Also queries both `daily` and `hourly` period types so volume data appears even before daily compaction runs. Expected 10-50x speedup on large databases.
- **Volume safety cap:** Items with no volume data were previously uncapped in the packing algorithm (could suggest buying 999 of an item nobody trades). Now falls back to conservative limits: 10 units for gear, 100 for stackable items.
- **Renamed "24h Vol Sold" → "24h Activity":** The metric is based on `sample_count` (number of price data points recorded), not actual trade volume. Added tooltip explaining it's data frequency, not sales count.

### 2026-04-04 — Fix Discord OAuth root cause: DB bloat → 100% CPU → event loop death

- **Root cause chain:** NATS market orders built up 22M rows in `price_snapshots` (high-volume feed × 24h retention). `computeSpreadStats` queried ALL rows with no LIMIT, loading 22M rows into Node.js RAM. Stuck running for 12+ hours at 100% CPU. Event loop starved → OAuth fetch to Discord's API timed out at 8s → "Server is not responding".
- **computeSpreadStats:** now queries `price_averages` (3.1M rows, pre-aggregated) instead of `price_snapshots` (22M rows). Added `LIMIT 1000000` safety cap. Added 20-minute `statsStartTime` watchdog so it auto-resets if stuck again.
- **compactOldData:** dropped the aggregation SELECT+INSERT step (which itself OOMed on 22M rows). Now just DELETEs `price_snapshots` older than 6h directly — `price_averages` already holds historical data from backfill.
- **OAuth timeouts:** increased 8s → 30s to survive event loop backpressure.
- **Emergency recovery:** 4GB SQLite DB was corrupted during manual cleanup (SSH died mid-transaction). Deleted old DB, rebuilt clean 360KB DB preserving users/alerts. NATS + backfill will rebuild market history automatically.
- Disk freed: 4GB → 54% usage (was 99%). CPU: 100% → 11%.

### 2026-04-04 — Fix Discord OAuth "Server is not responding" (event loop saturation)

- **Root cause diagnosed:** Node.js was running at 98% CPU with 520 CLOSE-WAIT sockets. The TLS handshake for new connections (including OAuth login) was never completing because the event loop was never idle. Users saw "Server is not responding. Please try again." after 12 seconds.
- **Root cause:** All `fetch()` calls in `doServerScan` and `backfillHistoricalData` had **no timeout**. When the Albion Online Data API was slow, hundreds of pending fetch requests accumulated across overlapping scan cycles, saturating the event loop.
- **Fix:** Added `AbortSignal.timeout()` to 5 previously-uncovered fetch calls: items.json (15s), price chunk fetches (30s), Discord slash command live scan (10s), charts backfill chunks (30s), history backfill chunks (30s).
- Redeployed. OAuth `/auth/discord` now responds in <1s, CLOSE-WAIT count dropped from 520 → 1.

### 2026-04-03 — Discord OAuth rewrite + VPS responsiveness fix

- Replaced `passport-discord` with manual OAuth2 implementation — adds 8-second timeouts on Discord API calls (token exchange + profile fetch). Passport-discord had no timeouts, causing the login to hang indefinitely.
- Removed 4 dependencies: `passport`, `passport-discord`, `express-session`, `connect-sqlite3`. Auth is now fully stateless via JWT.
- Added client-side 12-second timeout on Discord login button — shows "Server is not responding" error instead of spinning forever.
- Batched `recordSnapshots` (5000-row transactions), `seedAlerterFromScan` (5000-entry chunks), and `computeSpreadStats` (100-item batches) with `setTimeout` yields to prevent event loop starvation during market scans.
- Staggered post-scan work: gzip immediately, alerter seeding after 2s, snapshot recording after 8s.
- VPS now stays responsive to HTTP requests throughout the entire scan cycle.

### 2026-04-03 — Custom domain: albionaitool.xyz

- Replaced slow nip.io wildcard DNS (`209-97-129-125.nip.io`) with real domain `albionaitool.xyz` across frontend (`app.js`, `index.html`) and backend (`deploy_saas.py`).
- Set up Let's Encrypt SSL certificate on VPS for the new domain.
- Opened port 80 in UFW for certbot HTTP-01 challenge renewals.
- Discord OAuth login should now be significantly faster (no more nip.io DNS latency).

### 2026-04-01 — XSS hardening pass 2 (security reviewer findings)

- Applied `esc()` to all remaining `getFriendlyName()` calls in `innerHTML` contexts: crafting material names, compare tab headers/city columns, haul plan items, autocomplete dropdown, repair calculator, top-traded table, item power table, favorites chips and table.
- Fixed stored XSS in portfolio tab: `t.city` from `localStorage` now escaped on read.
- Fixed two more unescaped `e.message` in journal and farming error handlers.
- Fixed leaderboard CSS class injection: `u.tier` from VPS API now validated against `/^[a-z]+$/` before use in `class="tier-${tier}"`.

### 2026-04-01 — XSS hardening + memory fix + .gitignore cleanup

- **XSS hardening** (`app.js`): Applied `esc()` to all remaining unescaped external data in `innerHTML`: item names and IDs in browser cards, city names in arbitrage/transport/crafting/Black Market trade cards, error messages in `catch` blocks. All API-sourced strings now go through the HTML entity escaper before insertion.
- **Performance fix** (`deploy_saas.py`): Added `spread_stats` cleanup in `compactOldData()` — deletes rows with `updated_at` older than 14 days. Prevents unbounded table growth (2.5M+ rows) that was causing OOM kills on the VPS.
- **`.gitignore`**: Added `node_modules/`, debug Python scripts (`debug_dump.py`, `why_missing.py`, `check_avalon.py`, `check_stoneskin.py`, `check_mats.py`, `verify_dict.py`, `check_live_json.py`, `rebuild_items.py`, `fetch_latest_items.py`, `inspect_consumables.py`, `build_recipes.py`, `merge_consumables.py`), and test/debug JS files.

### 2026-04-01 — Security hardening + bug fixes (full review pass)

**Critical fixes:**
- **CRIT-3: Alerts access control** (`deploy_saas.py`): `/api/alerts` GET/POST/DELETE were not scoped to the requesting user — any authenticated user could read or delete all guild alert configs. All three endpoints now filter by `guild_id = 'web-' + req.user.id`.
- **CRIT-4: Contribution score manipulation** (`deploy_saas.py`): `/api/contributions` accepted unbounded `item_ids` arrays. Added `length > 500` cap to prevent score inflation and memory pressure.

**High fixes:**
- **session.regenerate() on OAuth callback** (`deploy_saas.py`): Added `req.session.regenerate()` before issuing the JWT to prevent session fixation attacks.
- **Security headers** (`deploy_saas.py`): Added `helmet()` middleware — sets HSTS, X-Content-Type-Options, X-Frame-Options, and other security headers on all responses.
- **Session store cleanup** (`deploy_saas.py`): Added `cleanupInterval: 86400` to `SQLiteStore` config so expired anonymous sessions are pruned daily instead of accumulating forever.
- **WebSocket reconnect leak** (`app.js`): `initLiveSync` was overwriting `wsLink` without closing the old socket. The old socket's `onclose` would then fire after reconnect, triggering a second `initLiveSync` and stacking concurrent connections. Fixed by nulling all handlers and calling `.close()` before creating a new socket.

**Bug fixes:**
- **OAuth init blocking** (`app.js`): `await checkDiscordAuth()` was blocking the entire `init()` chain for up to 10s when the VPS is slow or unreachable, freezing the UI. Changed to fire-and-forget so `loadData()` runs concurrently.
- **loadAlerts XSS + res.ok** (`app.js`): `a.channel_id` was injected into `onclick="deleteAlert('${a.channel_id}')"` — attribute injection escape. Rewrote to use DOM element + `textContent` + `addEventListener`. Also added missing `res.ok` check before `.json()`.
- Added `helmet` and `jsonwebtoken` to backend `package.json`.

### 2026-04-01 — Fix: OAuth cross-origin cookie blocking (the real login bug)

- **Root cause identified**: Safari ITP and Chrome Privacy Sandbox treat the `nip.io` session cookie as a third-party cookie when called from `github.io` and silently drop it. This is why `?login=success` was received but `/api/me` always returned `loggedIn: false` — the session cookie was never sent.
- **Fix (backend)**: After successful OAuth, issue a signed JWT (`jsonwebtoken`) containing `{id, username, avatar}` and append it as `?token=...` in the redirect URL. Added `resolveUser` middleware that accepts `Authorization: Bearer <token>` on all `/api/` routes as an alternative to the session cookie.
- **Fix (frontend)**: `checkDiscordAuth()` now parses the `token` URL param and stores it in `localStorage('albion_auth_token')`. Added `authHeaders()` helper that returns the `Authorization: Bearer` header. All authenticated API calls (`/api/me`, `/api/my-stats`, `/api/alerts`, `/api/contributions`) now use `authHeaders()`.
- Added `jsonwebtoken ^9.0.2` to backend dependencies.

### 2026-04-01 — Fix: Discord OAuth hang + tier badge + XSS hardening

- **Fix Discord OAuth login hang** (`deploy_saas.py`): Added `req.session.save()` callback before the post-auth redirect. Without this, `connect-sqlite3` wrote the session asynchronously — the browser called `/api/me` before the session was committed to SQLite, receiving `loggedIn: false` and staying on the landing overlay indefinitely. Session is now flushed before the redirect.
- **Fix tier badge never showing** (`app.js`): `/api/me` returns `stats.tier` nested under `data.stats`, but the frontend checked `data.tier` (always `undefined`). Changed to `data.stats && data.stats.tier`.
- **XSS hardening** (`app.js`): Added `esc()` HTML-escaping utility. Applied to all third-party data injected via `innerHTML`: builds tab (`build.name`, `build.authorName`, `build.strengths[]`, tag arrays from `albionfreemarket.com` API) and community leaderboard (`u.username` from VPS API).

### 2026-04-01 — Fix: Sync deploy_saas.py with deployed VPS state

- Committed deploy changes that were on VPS (Mar 30 deploy) but missing from git
- Disable albion-proxy service on deploy (NATS proxy consolidated into albion-saas)
- Add `sell_date`/`buy_date` columns to `price_snapshots` table via ALTER TABLE
- Add `idx_spread_stats_search` index on `spread_stats(window_days, avg_spread, confidence_score)`
- Discord bot login now catches rate-limit errors gracefully (`.catch()`)
- Transport routes query refactored: correlated subqueries replace double JOIN on `price_averages`; fixed params array order that caused wrong values being bound

### 2026-03-29 — Feature: Transport Weight & Haul Planning System

- Implemented Albion Online gear weight calculation: tier material weights (T4-T8) × equipment slot material counts (chest=16, head/shoes/offhand/cape=8, 1H=24, 2H=32)
- Added Mount / Carry Weight selector with real mount capacities (T3-T8 Ox, Mammoth, Saddled Mammoth)
- Transport now respects 48 inventory slot limit — gear takes 1 slot each, stackables compress
- Volume-aware: never suggests buying more than daily sell volume (prevents unsellable hauls)
- Shows limiting factor per item: Budget, Volume, Weight, or Slots — so you know what's capping you
- Haul Plan grouping: packs multiple items from same route to fill remaining budget/weight/slots
- Top 5 Haul Plans displayed above individual routes with total cost, weight, slots, and ROI
- Items within each plan sorted by profit/unit (best items packed first)
- Individual route cards now show Unit Weight, Carry Qty, Silver Used, and limiting factor

### 2026-03-29 — Feature: Discord OAuth Landing Page + Premium Visual Redesign

- Added full-screen landing page overlay with animated glassmorphism UI (floating orbs, gold mesh grid, fade-in animation)
- Users must log in with Discord to access the main app; overlay dismisses with a smooth fade-out on successful auth
- Handles `?login=success` redirect from OAuth callback and cleans the URL via `history.replaceState`
- Overlay stays visible if auth check fails (network error or backend down), so user always has login access
- Modernized `style.css` with glassmorphism across header, nav, top-bar, controls panel, item cards, and trade cards (`backdrop-filter: blur`)
- Enhanced hover states: gold glow on cards, Discord button glow, input focus ring
- Added styled scrollbar, `::selection` highlight, and tab pane fade-in animation
- Tier badges (Bronze/Silver/Gold/Diamond) now have colored glow box-shadows
- Feature pills on landing page highlight each of the 20+ tools available

### 2026-03-29 — Fix: timestamp Z-suffix in timeAgo and getFreshnessIndicator

- `timeAgo()` and `getFreshnessIndicator()` were blindly appending `'Z'` to all date strings
- Server-cache timestamps already have `'Z'`, producing double-Z → Invalid Date → "NaNd ago" and 🔴 for all cached prices
- The same fix from `bea3063` (applied to `processArbitrage`) is now applied to both utility functions

### 2026-03-29 — Feature Audit & Polish Pass

- Added missing HTML elements: `ip-error`, `fav-spinner`, `fav-error`, `mount-error`, `mount-type` filter
- Added empty-state placeholder hints to all 9 new feature tabs (no more blank screens on first visit)
- Fixed RRR Calculator: now updates built-in result elements instead of replacing them; auto-calculates on load
- Added Mount Type filter (Riding / Transport / Battle) to Mounts Database
- Fixed Item Power sort options to match JS (silver/IP, highest IP, lowest/highest price)
- Added "All Gear" and "Off-hand" categories to Item Power Checker
- Fixed Mount sort options (removed non-functional speed/load sorts, added tier sorting)
- RRR premium checkbox now triggers recalculation

### 2026-03-29 — Fix: UI instantly interactive on page load

- Moved all event listener setup + Live Sync connect to run before async VPS fetches
- Added 5s timeout to Discord auth check (`/api/me`) — prevents slow VPS response from blocking UI
- Previously, slow VPS startup caused buttons/menus to be unresponsive for 10–25 seconds

### 2026-03-28 — Navigation Redesign (Grouped Dropdowns)

- Reorganized 19 tabs into 4 dropdown groups: Market, Crafting, Trading, Game Tools
- Each group has a toggle button with chevron indicator and dropdown menu
- Standalone tabs (Alerts, About, Community) remain directly accessible
- Dropdowns auto-close when clicking a tab or clicking outside
- Mobile responsive: dropdowns use fixed positioning for full-width menus
- Removed old horizontal scroll buttons (no longer needed)

### 2026-03-28 — Massive Feature Expansion (12 New Tools)

Inspired by AlbionFreeMarket.com, this update adds 12 new features — all completely free with no paywalls.

#### New Tabs
- **Black Market Flipper**: Dedicated tool for finding profitable items to sell to the Black Market. Filters by tier, enchantment, category, and minimum profit. Reuses the proven arbitrage engine with BM-hardcoded sell target.
- **Journals Calculator**: Calculate labourer journal profits for all 10 journal types (Mercenary, Lumberjack, Stonecutter, Prospector, Cropper, Gamekeeper, Blacksmith, Fletcher, Imbuer, Tinker) across T3-T8. Shows buy-empty/sell-full profit with ROI and sell-order alternatives.
- **RRR Calculator**: Standalone Resource Return Rate calculator. Input spec level, city bonus, focus toggle — see effective return rate, materials saved per 100 crafts, and a visual breakdown of each bonus contribution.
- **Repair Cost Calculator**: Estimate repair costs for any item. Accounts for tier, enchantment, quality, and current durability. Shows quick reference grid for 25%/50%/75%/100% repairs.
- **Item Power Checker**: Compare item power vs price across items in the same category. Find the best silver-per-IP ratio. Sortable by IP, price, or value efficiency.
- **Favorites**: Save and manage custom item lists stored in your browser. Create named lists, add items via autocomplete, load lists to see prices across all cities with cheapest/most expensive color coding.
- **Mounts Database**: Browse all mounts with live prices, categorized by type (riding, transport, battle). Filter by tier, search by name, sort by price or speed.
- **Top Traded Items**: See the most actively traded items ranked by 7-day volume from the Charts API. Filter by city, tier, and category.
- **Portfolio Tracker**: Trade journal with FIFO cost basis matching. Log buys and sells, track realized P/L with tax estimates, export to CSV. All stored locally.
- **Farm & Breed Calculator**: Calculate farming profits for crops, herbs, and animals. Shows seed cost vs harvest revenue, growth times, and profit-per-hour. Accounts for premium bonuses.
- **Builds Browser**: Browse community character builds from AlbionFreeMarket's public API. View equipment loadouts, tags, vote counts, and build descriptions.

#### Crafting Calculator Upgrades
- **Save/Load Setups**: Save crafting configurations to localStorage and reload them instantly.
- **Shopping List**: See a material breakdown table with estimated costs when calculating a recipe.

#### UI Improvements
- Navigation bar optimized for 15+ tabs with compact styling and smooth horizontal scrolling
- New CSS styles for tables, progress bars, favorite chips, build cards, and mount groupings
- **City Comparison Toolbar**: Injected the Global Action Toolbar (Refresh, History) directly into the City Comparison item headers to match the rest of the site and provide instant 0-delay refreshes and 24h/7d/4w volume graphs.

---

### 2026-03-27 — Data Quality & Server Fix

#### Critical Fix
- **VPS now scans Europe server** instead of Americas (West). All cached prices, spread stats, and confidence scores now reflect the correct game server.
- **Server auto-migration**: On deploy, old West server data is automatically cleared and re-collected from Europe APIs (Charts, History, live scans).
- **Configurable game server**: VPS uses `GAME_SERVER` env var (defaults to `europe`), allowing other deployers to target any region.

#### Data Quality Improvements
- **Junk price filtering**: Arbitrage scanner now detects and skips placeholder listings (prices >20x median for the same item), eliminating false routes caused by 999,999 silver junk orders.
- **10x more spread stats**: Frontend now loads up to 2,000 spread stats (was 200), so far more trade routes show confidence scores.
- **Lower confidence threshold**: Minimum confidence for loading stats reduced from 10% to 5%, showing data for more routes.

#### Frontend
- **Auto server detection**: Website automatically selects the correct server dropdown (Europe) based on which server the VPS scans.

---

### 2026-03-26 — Bulk Transport Profits

#### New Feature: Transport Tab
- **Bulk Transport Route Finder**: New "Transport" tab optimized for mammoth runs and bulk hauling between cities.
- **Budget-Based Calculations**: Enter your silver budget to see how many units you can buy and estimated trip profit.
- **Transport Score**: Routes ranked by profit x daily volume — highlights items that sell in quantity AND are profitable.
- **Daily Volume Data**: Pulled from historical Charts API data to show actual trading activity per item/city.
- **Confidence Integration**: All routes include spread stats confidence scores and consistency percentages.
- **5 Sort Modes**: Trip Profit, Transport Score, Profit/Unit, Volume, and Confidence.
- **City Filters**: Select specific buy/sell cities — defaults to Black Market as sell target.

#### Backend
- **`GET /api/transport-routes`**: New endpoint joining spread_stats with volume data from price_averages.

---

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
