# Full Project Audit Report — April 12, 2026

5 audits conducted in parallel: Frontend UX, Backend Security, Go Client Reliability, Live Website Testing, Competitor Research.

**Total issues found: 137** (across all audits)

---

## PRIORITY 1 — FIX NOW (Broken / Data Loss / Security)

### P1.1 Discord Bot Alerts Down
- **Source:** Live test
- **Issue:** "Could not load alerts. Is the bot server online?" — bot is unreachable
- **Impact:** Entire Alerts feature broken for all users
- **Fix:** Check VPS service, restart bot, add auto-restart in systemd

### P1.2 VPS Relay Drops Messages on Disconnect (Go Client)
- **Source:** Go audit
- **Issue:** SendChestCapture/SendLootEvent/SendSaleNotification return silently if disconnected. No queue or retry.
- **Impact:** Chest captures and loot events lost if VPS connection hiccups
- **Fix:** Add a bounded message queue (e.g., 50 items) that retries on reconnect

### P1.3 globalItemCache / playerCache Unbounded Growth (Go Client)
- **Source:** Go audit
- **Issue:** sync.Map caches grow indefinitely — no eviction or cleanup
- **Impact:** Memory leak over hours of gameplay
- **Fix:** Add periodic eviction (e.g., clear on zone change or every 30 min for items older than 5 min)

### P1.4 Race Conditions in VaultInfo / AlbionState (Go Client)
- **Source:** Go audit
- **Issue:** Global vault info variables and AlbionState accessed from multiple goroutines without synchronization
- **Impact:** Potential crashes or data corruption
- **Fix:** Add sync.RWMutex to vault info globals and AlbionState fields

### P1.5 Mail Parser Panic on Malformed Body (Go Client)
- **Source:** Go audit
- **Issue:** `decodeSellNotification` accesses `body[1]`, `body[3]` without checking array length
- **Impact:** Client crash if mail format changes
- **Fix:** Add `if len(body) < 4 { return nil }` guard (already done for expiry but not for sell)

### P1.6 Unreliable Packet Panic (Go Client)
- **Source:** Go audit
- **Issue:** `command.Data[4:]` in listener.go panics if data < 4 bytes
- **Impact:** Client crash on malformed unreliable packets
- **Fix:** Add `if len(command.Data) < 4 { return }` guard

---

## PRIORITY 2 — IMPORTANT (Bad UX / Significant Gaps)

### P2.1 Mobile Responsiveness Broken
- **Source:** Live test + Frontend audit
- **Issue:** No hamburger menu, nav tabs overflow, header too tall, renderer freezes at narrow widths
- **Impact:** Unusable on phones/tablets
- **Fix:** Add media queries, hamburger nav, reduce header size on mobile

### P2.2 Alerts Page Accessible Without Login
- **Source:** Live test
- **Issue:** Guest users can see the alert form despite "Login to Setup Alerts" existing
- **Impact:** Confusing — form would fail anyway without auth
- **Fix:** Gate the Alerts content behind auth check like Live Flips does

### P2.3 Tab Initialization Incomplete
- **Source:** Frontend audit
- **Issue:** Only 6 of 24 tabs have init handlers on switch. Others show stale/blank data on revisit.
- **Impact:** User sees old data after switching tabs
- **Fix:** Add init handlers for remaining tabs (at minimum: transport, arbitrage, compare)

### P2.4 Price Cache Sync Across Tabs
- **Source:** Frontend audit
- **Issue:** Refreshing an item in Browser doesn't update prices shown in Arbitrage/Crafting/Transport
- **Impact:** Inconsistent prices shown across features
- **Fix:** Invalidate and re-render open tab when price cache updates

### P2.5 WebSocket IP Hardcoded (Old VPS)
- **Source:** Frontend audit
- **Issue:** Console log references old DigitalOcean IP 209.97.129.125
- **Impact:** Misleading debug info
- **Fix:** Remove or update the console.log message

### P2.6 ConnectLoop Never Stops on Shutdown (Go Client)
- **Source:** Go audit
- **Issue:** VPS relay reconnect loop runs forever with no shutdown signal
- **Impact:** Goroutine leak on exit
- **Fix:** Add context.Context cancellation

### P2.7 No Shareable URLs / Deep Linking
- **Source:** Competitor research
- **Issue:** Every competitor has shareable URLs for items/configs. We have none.
- **Impact:** Users can't share finds with guildmates
- **Fix:** Add URL params for tab, item, city, quality

### P2.8 No CSV/JSON Export
- **Source:** Competitor research
- **Issue:** AlbionOnlineGrind and others offer data export. We don't.
- **Impact:** Power users can't analyze data in spreadsheets
- **Fix:** Add export buttons on flip results, loot sessions, price data

---

## PRIORITY 3 — MODERATE (Polish / Robustness)

### Backend
- P3.1 Add regex validation for item IDs in batch-prices: `/^[A-Z0-9_@]+$/`
- P3.2 Sanitize loot upload guild/player names (control chars, XSS payloads)
- P3.3 Add FOREIGN KEY constraints on loot_tab_sales → loot_tabs
- P3.4 Add NATS auto-reconnect with backoff (currently no reconnect on drop)
- P3.5 Add WebSocket backpressure handling (check send() return)
- P3.6 Add request timeouts to REST endpoints
- P3.7 Improve loot session ID uniqueness (add random suffix)
- P3.8 Password reset flow (no /api/forgot-password exists)

### Frontend
- P3.9 Transport mount change event — changing mount doesn't re-render routes
- P3.10 Compare tab auto-fill shows no error on API failure
- P3.11 BM Flipper help text says "Scan Black Market" but button says "Find BM Flips"
- P3.12 About page extremely tall (~13K px) — performance issues on low-end devices
- P3.13 NATS price merge could overwrite valid price with expired order (price=0)
- P3.14 Freshness badges don't auto-update while staying on same tab

### Go Client
- P3.15 Fragment reassembly ignores errors (`msg, _ :=`)
- P3.16 CLI flags not validated for conflicts (offline + capture token)
- P3.17 Config file path hardcoded to CWD ("config.yaml")
- P3.18 Log rotation errors silently ignored
- P3.19 File handle leak in gob encoder on error path
- P3.20 Mail parameter parsing uses ambiguous trial-and-error fallbacks

---

## PRIORITY 4 — LOW (Nice to Have)

- P4.1 Add `/health` endpoint — DONE (implemented this session)
- P4.2 Mask emails in VPS logs
- P4.3 Add audit log table for sensitive operations
- P4.4 Console.log cleanup (14 debug logs in production)
- P4.5 CSS z-index system (no documented stacking context)
- P4.6 Toast notification positioning/stacking
- P4.7 Disabled button visual states
- P4.8 Arbitrage sort tiebreaker missing

---

## FEATURE ROADMAP (from Competitor Research)

### Quick Wins (< 1 day each)
1. **In-game timers widget** — daily reset, conqueror's chest, monthly (multiple competitors have this)
2. **PWA manifest** — make the site installable (AlbionKit, OneLifeGaming both do this)
3. **Shareable URLs** — URL params for item/tab/config (every competitor has this)
4. **CSV/JSON export** — on flip results, loot sessions, price data
5. **Cmd+K search** — universal search across all features (AlbionKit pattern)

### Medium Effort (1-3 days)
6. **Upgrade flips** — cross-enchantment arbitrage (AFM's unique feature)
7. **Price alerts via Discord DM** — personal alerts, not just channel-wide
8. **Consumed flip tracking** — mark flips as taken to reduce failure rates
9. **Preconfigured item lists** — one-click "All T4-T8 Leather Armor"
10. **Knowledge base / tutorials** — educational content

### Large Effort (1+ week)
11. **Dungeon Tracker** — Go client captures dungeon events, web UI shows fame/silver/time (would be first web-based tool with this)
12. **Gathering Tracker** — resource tracking with silver/hour metrics
13. **Damage Meter** — web-based DPS/HPS (massive differentiator vs desktop-only Triky313)
14. **Private flips** — per-user flip visibility (AFM's killer feature)
15. **Map pathfinder** — route planning through zones

### Our Unique Advantages (lean into these)
- Live NATS flips (real-time, not batch)
- Loot Accountability (no competitor has this)
- Custom all-in-one Go client
- Analytics engine (EMA, VWAP, SMA, trend arrows, volatility badges)
- Loot Buyer 3-phase pipeline

---

## COMPLETED THIS SESSION

- [x] Crafting revamp: quality selector, city bonus dropdown, shopping list fix, focus cost, tab persistence
- [x] /health endpoint
- [x] Batch-prices timeout (5s)
- [x] Accountability capture gate removed
- [x] Optimistic JWT login
- [x] Device auth sessionStorage fix
