# Changelog

All notable changes to the Coldtouch Market Analyzer will be documented in this file.

### 2026-06-25 — Accountability: editable shares (Option B — editor link)

- **A shared report can now be refreshed as late deposits land.** Sharing a report now produces **two** links: a **👁 view link** (read-only, share with anyone) and a private **✏️ editor link** (give only to trusted officers). Opening the editor link puts the report in **Editor mode** — the officer pastes/captures the newer in-game chest log, hits Re-run check, then **⟳ Update this share**, and the *same* view link now shows the latest deposits for everyone. No account needed: the edit token in the link is the authorization.
- **The fight data stays locked.** Only the chest captures + chest logs are overwritten; the loot events (who looted what) are always read from the owner's session, so an editor can refresh deposits but can't rewrite the fight.
- **Safe by design.** Each update keeps the previous snapshot (last 5 per link) for recovery, the edit token rides in the URL hash (never sent to the server in request logs), validation is constant-time, and the update endpoint is rate-limited (20/min). A "created / updated" timestamp shows in the report banner.

### 2026-06-25 — Accountability: exact guild filter, chest-log tiebreaker, cleaner state

- **Guild selection is now exact.** When you pick specific guilds in the Friendly-guilds control, only players in *exactly* those guilds are held accountable. Previously the pick was silently auto-expanded to every guild in the same **alliance**, so an alliance-mate guild you didn't select (e.g. an "avoid" guild sharing your alliance) leaked into the result as friendly and wasn't hidden. Players with **no captured guild** are no longer auto-treated as friendly either — an explicit pick means "these guilds and no one else." (Diagnosed from a live report where Iron Dome + Gold Dome were selected but Avoid_Me — 214 loot events, same `IDF` alliance — showed at the top.)
- **Chest log is now the tiebreaker in 👤 Per-player mode.** When two players loot the same item, one deposits and one doesn't, and the chest capture shows one in the chest, the capture (a count with no per-player attribution) used to split proportionally and credit *both* — so the non-depositor escaped. Now the capture's proportional fallback only allocates the units the chest log hasn't **already** credited to a specific depositor, split across only the looters the log doesn't cover. Result: the logged depositor is ✓ verified and the non-depositor is correctly flagged missing, instead of being covered by the same physical item. ("Deposited by anyone" mode is unchanged — it intentionally counts loot that reached the chest regardless of who banked it.)
- **Cleaner state.** A new `.txt` upload, and navigating away from the Loot Logger tab and back, now clear any previously-rendered accountability result and its cached events — no more stale check from the last session lingering. Shared public report views are untouched.

### 2026-06-23 — Accountability: "deposited by anyone" mode + wider deposit window (fixes loot-master false-flagging)

- **New default "🏦 Deposited by anyone" matching mode.** The check used to credit a player only for loot **they personally** deposited (`deposits[player][item]`). In guilds with centralized loot — where a few loot-masters bank everyone's gear — that flagged the original looters as 0% deposited even though their loot reached the chest. The new mode treats a looted item as accounted-for if it reached the chest at all (deposited by **any** member, in-window), allocated proportionally across everyone who looted that item type (pool = chest-log deposits by item, or the capture snapshot, whichever is larger). A **"👤 Per-player deposits"** toggle in the result restores the strict each-deposits-their-own rule. Measured on a real 3900-item ZvZ log: verified item-lines went **37 → 398** (per-player → deposited-by-anyone). Recompute is instant (reuses cached events, no refetch).
- **Deposit window widened from session +24h to +72h.** Guilds bank loot over the following days (carriers, mail, loot-masters depositing in batches); the 24h cap was dropping legitimate late deposits. The −1h pre-cutoff is unchanged, so older unrelated deposits of the same item types from the chest's 4-week history still don't get credited.
- Diagnosed from a live shared report: of 3246 deposit rows only 610 were in the old ±24h window, and (looter == depositor) matches collapsed from 163 (all-time) to 37 — both filters now relaxed.

### 2026-06-23 — Accountability: paste an in-game chest log manually (no client needed)

- **New "📋 Or paste a chest log manually" box** in the Chest Log Captures card. In-game, open the chest **Log** tab → **Copy to clipboard** → paste the text in. It parses the quoted-TSV (`Date / Player / Item / Enchantment / Quality / Amount`), resolves each display name to its item id via the reverse of `ITEM_NAMES` plus the Enchantment column (`id@N`), and feeds the rows into the same pipeline as captured logs — so it cross-checks against chest captures, respects the session time window, and shows in the chest-log selector (tagged `📋 pasted`). You can paste multiple logs (different tabs/chests) and they accumulate.
- **Direction comes from the signed Amount**, which is the authoritative per-row truth: **positive = deposit, negative = withdraw**. This is *more* accurate than the packet capture, which infers direction from a per-view filter code and normalizes the sign away — meaning a single in-game "Log" view that mixes deposits and withdrawals was being mis-tagged. Pasted deposits count immediately (no "mapping unverified" caveat) and pasted withdrawals feed the withdrawal-audit. Verified end-to-end against a real log: 12 rows → 6 deposits + 6 withdrawals, names/enchants/IDs all resolved (gear, resources, mounts, consumables, furniture, "Trash").
- Works standalone (no client, no capture, no "View Chest Logs" permission caveat), or alongside client captures and chest snapshots — all cross-checked together.

### 2026-06-23 — Accountability: chest-log deposits now actually count (don't false-flag depositors)

- **Players who deposited per the chest log are no longer flagged "missing".** The merge skipped any deposit batch whose `actionMappingVerified` flag wasn't explicitly set true — and that flag defaults to false on the client, so client-captured deposits effectively never counted: people who deposited their loot still showed as missing. A live packet capture on 2026-06-23 confirmed the in-game chest-Log deposit request uses filter code `28` and is correctly tagged `action=deposit` (withdrawals carry a different code), so trusting "deposit"-tagged batches is safe. The merge now credits deposit batches regardless of the verified flag; unverified ones are still counted in `unverifiedDepositEntries` for an optional caveat. Combined with the existing chest-log-over-snapshot rule, an item that was deposited (per the log) — even if later withdrawn/redistributed and no longer in the current tab — is correctly credited, not flagged as theft.
- Note: if a future game update changes the deposit filter code, deposits would be tagged `filter_unknown` (not `deposit`) and simply wouldn't count — so this trust is self-protecting.

### 2026-06-23 — Accountability: instant guild re-tag (no refetch), enemies hidden by default, resilient Share

Four fixes to the live accountability flow:

- **Adding/removing a friendly guild no longer re-fetches or "fails to fetch".** `_accApplyGuildPerspective` called the full `runAccountabilityCheck()`, which re-fetched the session's loot events from the backend on every guild-chip change — slow, and it errored outright while the backend was in its cold-cache window. A guild-perspective change only re-tags friendly/enemy; it doesn't change the loot data. `runAccountabilityCheck` now caches the sanitized events per session (`window._accEventCache`) and accepts `{ reuseEvents: true }`; the guild toggle uses it, so re-tagging is instant and never hits the network.
- **Enemy / other-guild players are hidden by default.** The result listed enemy looters (sorted to the bottom) even though they're not accountable to the guild. Enemy cards now get a `ll-acc-enemy` class and are hidden by default behind a "▸ Show N enemy players" toggle in the filter bar. Searching or filtering by alliance/player still reveals matching enemies (so a deliberate lookup works), and clearing the filter re-hides them. `_accApplyFilter` enforces the rule; the dead `acc-result-guild` filter reference (removed earlier today) is gone.
- **Share survives a failed re-run.** `runAccountabilityCheck` nulled `window._llAccShareContext` at the very top of every run, so if a run failed (e.g. a slow-backend fetch error) the Share button had no context and failed too. The context is no longer nulled up-front — it's overwritten only on a successful run, so a failed re-run keeps the last good shareable result.
- Combined effect: adding a second guild (e.g. Iron Dome + Gold Dome) re-tags instantly with no network call, the list stays scoped to your side, and Share keeps working.

### 2026-06-23 — Accountability: single guild picker, shareable log-only checks, chest-log dedup (3 dispatch fixes)

Three follow-up fixes from the June 22 dispatch handoff (the dispatched session hit a usage limit before working them):

- **Duplicate guild picker removed.** The accountability result rendered two guild controls back-to-back: the older `<select multiple>` display filter (`acc-result-guild`) and the newer "Friendly guilds" perspective chip picker. They overlapped and conflicted. Removed the display-filter `<select>` — the "Friendly guilds" picker is now the single guild selector (it drives the friendly/enemy math), and guild text filtering remains available via the result search box, which already matches guild names. Alliance and player filters are unchanged.
- **Share now works after a log-only accountability check.** With the new log-only mode (run accountability from chest logs with no chest capture), the result has zero captures, so `shareAccountability()` bailed at `selectedCaptures.length === 0` ("Selected captures no longer available") and the backend `/api/accountability/share` rejected the request ("At least one capture required"). Both now accept a share when there is at least one chest capture **or** at least one chest-log batch. The frontend gate is combined (captures OR logs), and the backend serializes an empty captures array safely (the public viewer already renders from chest logs alone).
- **Duplicate chest logs no longer double-count.** The in-game chest "Log" is shared across all of a chest's storage tabs, so switching tabs (or a WebSocket reconnect replay) re-captures the same deposit/withdraw history with a fresh `capturedAt`. The dedup signature keyed on `capturedAt` + the first entry, so it treated those identical re-captures as distinct batches — they showed as two identical-looking logs in the picker and double-counted deposits when both were selected (auto-select-all is the default). Dedup now keys on full content (`action` + the sorted set of all entries) via a new `_chestLogContentSig()` helper, so identical logs collapse into one regardless of capture time.

### 2026-06-23 — Accountability: multi-guild friendly side + withdrawal audit

- **Adding a second guild no longer drops your main guild from "friendly".** When the user picks an additional guild via the "Friendly guilds" chip picker, the auto-detected primary guild is now implicitly included as the starting base. Previously, selecting GuildB as the first chip would make GuildA members show as enemy — the picker now starts from [autoPrimaryGuild] so adding GuildB results in both being friendly. The auto-detected guild also now shows as an implicit chip so you can see the full current selection before adding more.
- **"Enemy Loot" label no longer renders in green.** The per-item status label for enemy-loot items (players not on the friendly side) showed in green text because the color ternary had no explicit case for the empty dot class. Fixed: enemy = red, died = muted, deposited = green.
- **Withdrawal audit section.** When chest logs are selected and they contain withdrawal records within the session window, a collapsible "📤 Withdrawal audit" section now appears at the bottom of the accountability result. It shows which players moved items out of the chest (redistribution), broken down by player and item with silver values. This answers "where did the missing items go?" — deposited-then-redistributed items are explicitly distinguished from theft.
- **Per-item "📤 moved by" annotation.** On items that were deposited (log-verified, green ✓) but also appear in withdrawal records, a small "📤 moved by [Player]" note is shown inline in the expanded player card.

### 2026-06-23 — Server: fix cold-cache 190s event-loop blocks on price_averages

- **NATS writes no longer wedge the event loop after restart.** The `price_averages` table has grown to ~34 GB (170M+ rows) due to compaction being disabled. On cold-cache (every restart), each `writeNatsBatch.immediate(300 rows)` had to traverse a 34 GB B-tree with VPS-storage I/O latency of ~150 ms per random read — total blocking time ~190 seconds, triggering the event-loop watchdog and `process.abort()`, causing recurring systemd restarts and all-HTTP-down windows.
- **Fix:** NATS flushes are now blocked until `recordSnapshots` completes its first write (which warms the page cache for the current hour's B-tree pages). The first `recordSnapshots` fires ~3 minutes after startup; once it finishes, NATS flushes are re-enabled and run on warm pages. A 10-minute hard fallback allows flushes even if the API scan fails.
- **Also:** `db` page cache increased from 32 MB to 64 MB to reduce B-tree cache misses.
- **Note:** The underlying `price_averages` bloat still needs an offline cleanup (same bulk-copy + VACUUM as May 4). This fix stops crashes; cleanup brings write latency back to normal.

### 2026-06-23 — Loot Logger: fix misleading "choose chest captures" toast

- **"Session pre-selected" toast now correctly says chest captures or chest logs are optional.** The toast shown after clicking the Accountability button from an uploaded session still said "Choose chest captures and click Run Check", implying captures are required. Updated to "Select chest captures or chest logs, then click Run Check."

### 2026-06-23 — Loot Logger: fix Re-run Check still requiring chest capture

- **"🔄 Re-run Check" now works with chest logs only (no capture selected).** The original log-only fix only updated `runAccountabilityCheck()` (the "Run Check" button). `rerunAccountabilityCheck()` — called by the "🔄 Re-run Check" button — was missed and still had the old hard block `'Select at least one chest capture first'`. Updated it with the same combined check: allows log-only, capture-only, or both; only blocks when neither is selected.

### 2026-06-23 — Loot Logger: fix Share button invisible after file upload

- **Share button now appears after uploading a loot log file.** After a successful upload save the "🔗 Share" button was silently missing — clicking "↻ Retry Share" also had no effect. Root cause: `_llUploadShareSlotHtml()` had cases for `'saving'` and `'error'` but fell through to an empty span for the `'saved'` state, so every re-render after save wiped the button. Added the missing `'saved'` case to render the share button directly using the saved session ID.

### 2026-06-23 — Loot Logger: three accountability/session bug fixes

- **Tab names now show correctly in accountability.** Chest captures from vault/guild-vault tabs were showing as "Capture 1", "Capture 2", etc. in the selector and result header instead of the real tab name (e.g. "Loot Tab 3"). The name-resolution logic now checks `vaultTabs[tabIndex].name` before falling back, matching how the Loot Buyer displays them.
- **Alliance/second-guild members no longer tagged as enemy.** When a second guild in the same alliance looted items, they were sometimes shown with a red "enemy loot" border — both in the session player-cards and in the accountability result. Root cause: the friendly check fell back to strict guild matching when a player's alliance field was empty in the log, or when the "friendly guilds" override was active. Fix: build a set of all guilds known to share the perspective alliance, and use that as the fallback; accountability's explicit-guild mode now also extends to alliance-mates.
- **Accountability now works with chest logs only (no chest capture required).** Previously the check required at least one chest capture, blocking users who want to verify purely from chest-log data. Now you can select chest-log batches with no capture and run the check — verified items show their deposit count, unverified items show as missing. A yellow notice appears at the top of the result clarifying that it's running in log-only mode.

### 2026-06-22 — Loot Logger: remember your guild as the default perspective

- **Set your guild once, and every session opens from your side.** Next to the guild picker there's now a **★** — click it to make the selected guild your default. From then on, any session you open (upload, saved, or a shared link) auto-starts from that guild's perspective when it's present, instead of the biggest looter guild. Click ★ again to clear it. The per-session dropdown still overrides for one-offs.
- Resolution order is: per-session pick → your ★ default (if in this session) → auto-detect. Works on all existing sessions immediately — no client update needed.

- **The "Guild" stat is now a picker.** The session view auto-detects the most common looter guild as "yours" (e.g. it picked "Avoid_Me"), but you can now switch it to your guild from a dropdown in the summary strip. Changing it recolors friendly/enemy on every card and re-splits the Friendly/Enemy deaths from your side. Pick **⚙ Auto** to go back to auto-detect. Your choice is remembered per session (localStorage). The friendly alliance is derived from the chosen guild, so alliance-mates stay friendly; a guild with no alliance makes only that guild friendly.
- Note: detecting the log-runner's guild automatically (so it defaults to you) needs the Go client to tag who ran the log — a planned follow-up; the manual picker covers it for now.

- **Hovering an item now shows where it was picked up.** The item hover tooltip (both the expanded item rows and the collapsed icon strip) gained a "Pickups" section listing each pickup's time, who it was looted from, and the 📍 zone. Previously this pickup/zone detail only appeared in the Accountability view, not in the normal/shared session view — so the data was there but invisible on hover. Items looted multiple times list each location (top 8 + "+N more").

### 2026-06-22 — Loot Logger: looter zones shown + friendly guilds no longer tinted red

- **Where each player looted now shows on their card.** The session view added a `📍 <zone>` line to every looter card (e.g. `📍 Glacierfall Canyon +3 zones`, with the full per-zone breakdown on hover) — previously loot locations weren't shown anywhere in the looter list, only on deaths.
- **Friendly guilds are no longer tinted red.** The per-guild distinguishing color (guild name + group header + timeline) came from a hash palette that included red — and red reads as "enemy" in the loot logger. So two guilds in the *same* alliance could show one red and one blue (e.g. "Gold Dome" red, "Iron Dome" blue), which was misleading. Removed all red tones from the palette; guilds still get distinct colors, but a friendly guild can never look like an enemy.

### 2026-06-22 — Loot Logger: death location now shows on every dead player's card

- **Where a player died is now visible on their card.** Previously the death time / zone / killer only rendered inside the "Died with" item block — so a player who died but whose corpse was never looted (or whose loot wasn't captured) showed a 💀 with **no location at all**. Now every player who died gets a death line on their expanded card (`💀 Died at 5:01 PM · 📍 Glacierfall Canyon — killed by …`), whether or not any corpse loot was attributed.
- **The zone is a visible 📍 pin**, not just buried in a hover tooltip, so it's scannable. (On a real shared session this lifted the cards showing a death location from 190 → 267, with 265 now showing the zone pin.)
- Unresolved numeric zone IDs fall back to `Zone <id>` via the existing zonemap, so the line is never blank when a death was recorded.

### 2026-06-21 — Loot Logger: dropdown guild picker, sticky Deaths collapse, recoverable upload Share

- **Multi-guild selection is now a dropdown + chips, not Ctrl-click.** Both guild pickers — the loot session-view filter and the Accountability "Friendly guilds" perspective — replaced their `<select multiple>` (which required Ctrl/Cmd-click) with a clean control: pick a guild from a dropdown, and it becomes a removable chip; an "+ Add another guild…" dropdown lets you stack as many as you want, with a one-click **clear**. The selected guilds are viewed and compared **together as one group**. The Accountability picker treats them as a single combined friendly side for the who-picked-up-vs-who-deposited math, so multi-guild comparison needs no keyboard gymnastics.
- **The Deaths section (and its sub-lists) stay collapsed.** The Deaths panel and its **Friendly deaths** / **Enemy kills** sub-sections now each default to collapsed and **remember your toggle** — picking a guild or alliance (or any other filter change) no longer re-expands them. Choices persist across reloads (localStorage). (Fixes the Friendly-deaths list popping back open on every filter click.)
- **Uploads never silently lose the Share button.** When a logged-in upload's background server-save fails (expired session, transient network/server error), the action row now shows a visible reason plus a **↻ Retry Share** button instead of just omitting Share; if you're logged out it shows **Log in to Share**. Previously a failed save left no Share affordance and the reason was buried in a status line.

### 2026-06-20 — Dependency hygiene: merged safe Dependabot bumps + patched undici advisory

- Merged the low-risk Dependabot PRs: CI runner actions (checkout v7, setup-node v6, setup-python v6, gitleaks-action v3) and `ws` 8.20→8.21. The backend majors (express 5, helmet 8, bcryptjs 3, express-rate-limit 8) are held pending review/testing — they only go live on a deploy, and CI doesn't yet exercise the backend against them.
- A newly-disclosed **HIGH advisory in `undici`** (GHSA-p88m-4jfj-68fv, Set-Cookie HTTP header injection) surfaced via the CI `npm audit` gate. `undici` is a transitive dep of `discord.js` (pinned by `@discordjs/rest` to 6.24.1); the suggested auto-fix would downgrade discord.js to 13.x. Instead added an npm `overrides` forcing `undici` to a patched **6.27.0** (same major → API-compatible). `npm audit` is clean again. Goes live on the next backend deploy.

### 2026-06-18 — Hardened DB backup, re-enabled (audit remediation, Phase 0)

- **Automated DB backups are running again** (the cron was disabled after the 2026-06-16 starvation outage). The backup method is rewritten to fix the root cause:
  - **`VACUUM INTO` instead of `.backup`.** SQLite's online-backup API restarts from scratch whenever the source DB is written by another connection — on this continuously-written ~30 GB DB it never settled (observed looping 17+ min live; it's why the 2026-06-15 afternoon run took 3.5h vs 18 min at 03:17). A streaming `.dump` avoids the restart but text-serialises 100M+ rows at ~0.4 MB/s (~4h, also measured). `VACUUM INTO` takes one consistent snapshot that concurrent writes don't restart and writes a compact binary copy, which is then stream-compressed.
  - **Idle priority** (`nice -n19` + `ionice -c3`) so the backup yields CPU/disk to the live process — verified: the live service stayed responsive (NRestarts=0, `/healthz` ok) throughout a full backup.
  - **Disk-fill guard** (free ≥ DB size + 8 GB) + pre-prune to one prior snapshot, so the transient copy can never fill the disk; atomic temp→final rename; retention keeps the last 2.
  - Verified end-to-end: a manual run produced a 5.4 GB snapshot that passes `gzip -t`. Restore: `gunzip -c db-STAMP.sqlite.gz > restored.sqlite`.
- Known follow-up: the backup takes ~2h and transiently grows the WAL (it self-recovers) purely because the DB is ~30 GB. Reducing price-history retention to shrink the DB would make backups fast and cheap — tracked separately.

### 2026-06-18 — Extract crafting math into a tested module (audit remediation, Phase 2)

- Pure crafting/economy math (effective tax rate, resource return rate, focus cost, quality distribution, quality-weighted expected price) moved out of the 20k-line `app.js` into a new `crafting-core.js`, with a unit-test suite (`tests/crafting-core.test.js`). Same dual-export pattern as `lootlogger-core.js` — one source of truth used by both the browser and Node tests.
- `app.js` now delegates to the shared module (with an inline fallback, so nothing breaks if the script fails to load); behavior is identical (verified in-browser: RRR, tax, focus, and quality calcs return the same values). First step of the incremental `app.js` modularization from the audit.

### 2026-06-18 — Reproducible backend builds + dependency security (audit remediation, Phase 1)

- **Production dependencies are now reproducible.** The backend's `package.json` is no longer generated as an inline string inside `deploy_saas.py`; it lives in a committed `server/package.json` with a committed `server/package-lock.json`, and the deploy installs with **`npm ci`** (exact, lockfile-pinned) instead of `npm install` (which could pull a different transitive tree on every deploy). The lockfile is the single source of truth.
- **Security fix surfaced by the new audit:** the locked `nodemailer` was on the vulnerable 6.x line (high-severity SMTP command injection, CRLF header injection, SSRF, and arbitrary-file-read advisories) and is upgraded to **9.0.1** (audits clean). The API used (`createTransport` / `verify` / `sendMail`) is unchanged across the major bump, so verification emails behave identically — **takes effect on the next backend deploy** and should be sanity-checked with one test verification email afterward.
- **CI hardened:** new `backend-deps` job runs `npm ci` (fails on an out-of-sync lockfile — the same install the VPS does) and `npm audit --omit=dev --audit-level=high` (fails the build on high+ production advisories). New `secret-scan` job runs gitleaks on pushed commits.
- **Dependabot** added for `/server` npm deps, root tooling, and GitHub Actions — version bumps now arrive as reviewed PRs instead of silent drift.
- Note for maintainers: to change a backend dependency, edit `server/package.json`, run `npm install` in `server/` to refresh the lockfile, run `npm audit`, and commit both files. No user-facing behavior changes.

### 2026-06-16 — Accountability: multi-guild friendly perspective

- The Accountability **"Friendly guilds" selector is now multi-select** (Ctrl/Cmd-click). Use case: a capped main guild plus a second guild in the same alliance can both be held accountable for deposits in a single check, so loot thieves in either guild surface together. Selecting nothing reverts to auto-detect; selecting a single guild behaves exactly as before.
- The Accountability results' guild **display filter** is multi-select too (show players from any of the chosen guilds).
- Internals: the single `primaryGuild` override became a `friendlyGuilds` set behind one `isFriendly()` predicate (0/1-guild behavior is byte-for-byte unchanged); `lootlogger-core.js` death categorization takes an optional `friendlyGuilds` list (absent = unchanged). Added unit tests for the multi-guild case plus a single-guild backward-compatibility guard.

### 2026-06-16 — Loot Logger viewer: multi-guild filter, source guild/alliance, death zones

- The loot report's **guild filter is now multi-select** — Ctrl/Cmd-click to show players from several guilds at once; no selection still means all guilds.
- Expanded player-card loot rows now show the **source's alliance and guild**, not just the name (`from [Alliance] Guild Name`).
- **Death rows show the death zone (📍) again.** The zone was always captured in the log; the Deaths list just wasn't rendering it (it now resolves names too — e.g. zone `1312` → "Deadpine Forest").

### 2026-06-16 — Outage fix: backup starvation + price_analytics retention

- Root-caused a site-wide outage: the twice-daily `sqlite3 .backup` cron took 3+ hours at 90% CPU on a 31 GB DB, starving the single Node process and wedging the event loop (every route, including static, timed out). Recovered by killing the stuck backup (the live DB is untouched — `.backup` only reads the source) and restarting the service. Disabled the backup cron pending a hardened (throttled, stream-to-gzip) version.
- `maintenance_compaction.js` now prunes `price_analytics`, which previously had **no retention** and grew unbounded since analytics writes were disabled on 2026-05-20 — the primary cause of the DB bloat. Retention defaults to 14 days (`COMPACTION_ANALYTICS_RETENTION_DAYS`); the backlog drains in larger chunks (`COMPACTION_ANALYTICS_CHUNK`, default 1000) under a dedicated per-run sub-budget (`COMPACTION_ANALYTICS_MAX_MS`, default 4 min) so it clears without starving the core price rollups. The isolated compaction timer applies it gradually.

### 2026-06-16 — Loot Logger is now upload-first

- Removed the live-session recording toolbar and the saved-sessions browser from the Loot Logger tab. The workflow is now: save a log with the Coldtouch client at the end of your content, then upload the `.txt`. The tab opens directly in Upload mode with the same report viewer and Accountability check as before. Loot Logger now has two modes: **Upload File** (default) and **Accountability**.
- The Go-client live-relay code is left intact server-side (only its UI was removed), so nothing in the capture pipeline breaks and live could be re-surfaced later.
- **Share links no longer expire.** Previously a shared loot-session link returned "expired" after 30 days (SEC-M3); shared links are now permanent. The underlying loot data was already kept indefinitely, so old links keep working.
- Added a **Delete this share** button on the shared-session view, visible to the link's owner (or an admin). It revokes the link for everyone (`POST /api/loot-session/share/:token/delete`) while leaving the loot data intact, so the owner can re-share later. Requires a backend deploy.

### 2026-06-16 — Loot upload Share chunking

- Manual Loot Logger file uploads now save to the backend in bounded chunks instead of sending the whole file in one request, so larger logs can still create a server session for Share.
- If a server save chunk fails, the uploaded report still stays usable locally for Accountability and the UI shows a clearer save-failure message.

### 2026-06-14 — Albion item catalog refresh

- Refreshed Loot Logger item maps and weights from the 2026-05-26 `ao-bin-dumps` data so numeric loot IDs resolve to the current Albion item strings and names.
- Bumped the service-worker cache version so browsers can pick up the refreshed catalog assets after deployment.

### 2026-05-28 — Accountability chest scan timestamps

- Accountability results now show the selected chest capture scan time next to each tab name after a check runs.
- Per-player missing-loot Discord text and generated image reports now include the same chest scan timestamp, so officer screenshots show which chest snapshot was used.

### 2026-05-27 — Loot Logger upload accountability fix

- Fixed `/api/loot-upload` saving uploaded rows one-by-one outside a transaction. Large log files could make the frontend wait long enough that Share and Accountability looked missing until the session list eventually refreshed. Uploads now save in one `better-sqlite3` transaction and return their `sessionId` promptly.
- The Upload UI now shows a saving state, reports server-save failures, refreshes the Accountability dropdown after save, and waits for that refresh before pre-selecting the uploaded session.

### 2026-05-21 — Transport shopping-list quality floor

- Transport haul plans now skip tiny filler routes that are technically profitable but add negligible silver to the trip. Low-profit items still remain visible in the individual route list, but no longer pollute copied shopping lists.
- The shopping-list gate scales with budget and requires meaningful expected profit both per item line and per inventory slot, so high-budget mammoth-style plans stay focused on cargo worth hauling.

### 2026-05-21 — Transport unknown-demand caps

- Transport Routes now defaults items with unknown destination Sold/Day to Scout Only, capping them to a small test quantity instead of letting budget, slots, or source availability create oversized haul suggestions.
- Added an Unknown Demand control: Scout Only, Hide Unknown, or Allow Full Size. Sold/Day unknown items are now visibly badged as scout-demand risk in haul plans and individual route cards.

### 2026-05-21 — Navigation dropdown recovery

- Fixed top navigation dropdown groups opening and immediately closing. The guarded startup path had moved `init()` to `DOMContentLoaded`, but the older timers-widget `window.load` hook still called `init()` again, attaching duplicate dropdown handlers.
- Service-worker cache bumped and the `app.js` script URL versioned so browsers receive the fixed frontend shell instead of repeatedly serving the broken cached `app.js`.

### 2026-05-21 — NATS burst stability

- NATS price-buffer writes now drain in bounded SQLite chunks with short event-loop yields, preventing large market bursts from freezing public health checks and WebSocket handling for several seconds.
- Shutdown and RSS-watchdog exits still perform a synchronous best-effort NATS flush so buffered live prices are not intentionally dropped during restarts.
- The legacy historical backfill job no longer runs automatically on production boot, and its existence check no longer uses `COUNT(*)` over the 15GB `price_averages` table.
- Full market-cache scans now defer while DB maintenance is active, reducing CPU and DB pressure during the compaction window.
- DB compaction now treats an overlapping DB backup lock as a clean skip instead of a failed systemd unit, so backup/compaction timing collisions do not page as false maintenance failures.

### 2026-05-20 — Market Flipping quality filters

- Market Flipping now has Min Profit and Min ROI controls, defaulting to `10k+` and `5%+`, so the scanner no longer fills results with tiny technically-profitable routes.
- ROI sorting now rejects obvious low-side junk listings, such as 1-silver bait prices, using the same style of low-price guard already used by live flip detection.
- Freshness filtering now filters only; it no longer silently overrides the selected sort mode. Highest Profit, Highest ROI, and Highest Confidence now sort as labeled.

### 2026-05-20 — Startup and backend stability hardening

- The frontend now boots `init()` exactly once after the script loads. This restores the normal startup path for tab handlers, initial data loading, live sync setup, portfolio render, favorites dropdown hydration, and other non-inline controls.
- Favorites storage is now defensive: corrupted or non-object `albion_favorites` data in `localStorage` no longer throws during startup or Favorites tab actions.
- SpreadStats stuck-run recovery now uses a generation token, matching the analytics hardening pattern. If a stale run is invalidated, it stops at the next yield instead of continuing to write after a replacement run starts.
- Backend maintenance jobs now avoid broad `price_averages` range scans. SpreadStats, analytics, and historical price-reference refreshes use per-item SQLite queries from the loaded item catalog so one large tier/prefix cannot freeze the public event loop.
- Automatic SpreadStats, analytics, and historical price-reference refreshes are now disabled by default until those enrichment jobs are isolated from the public web process. Existing cached rows continue serving, while uptime is protected.
- Routine WAL checkpoints now use non-blocking `PASSIVE` mode in hot paths, and NATS price buffers now retry safely after a busy write instead of dropping the buffered live prices.

### 2026-05-15 — Transport liquidity-aware route sizing

Transport routes now use Albion Data chart `item_count` history as a destination sell-through signal before sizing hauls.

- Route scans batch-fetch recent per-market sell counts for candidate items and show a Sold/Day value on transport cards.
- Haul quantities are now capped by live source availability when known, destination sell-through when available, and a conservative scout cap when quantity is unknown.
- The haul planner now respects each route's capped carry quantity in both packing passes, preventing planned stacks from exceeding known availability.

### 2026-05-12 — Loot Logger flagship hardening

Hardened Loot Logger, Accountability, public shares, and the custom client after a deep audit.

- Live death WebSocket events now preserve session id, zone, alliance, and equipment-at-death metadata, mark the session unsaved, and refresh the live report like normal loot events.
- Chest capture toggles now actually gate browser-side capture ingestion outside the Accountability workflow.
- Death timeline attribution moved into a tested `lootlogger-core.js` helper that splits corpse loot across repeated deaths instead of attaching every victim loot row to every death.
- Public loot-session shares now query by both `session_id` and owner `user_id`, include `numeric_id`, `equipment_json`, and `location`, and merged sessions preserve death equipment/location.
- Accountability chest-log verification now respects a client-provided `actionMappingVerified` flag. Unverified deposit-like rows are shown but held out of green verified badges until the deposit/withdraw filter mapping is proven in a controlled in-game check.
- Offline Go-client loot logs now include optional zone and death equipment JSON columns while keeping the first ten ao-loot-logger columns backward-compatible.
- The private relay queue now has a durable JSONL spool and a larger bounded queue for outage recovery.
- Added focused Loot Logger unit tests and client chest-log mapping tests.

### 2026-05-11 — Loot Logger per-player missing-item Discord report

Added a per-player Discord copy action to Accountability player cards. Friendly players with missing items now show a Discord button in the card header; clicking it opens the existing copy-preview modal with that player's missing items, estimated silver, deposit rate, partial-deposit context, and pickup time/source/zone details when available.

Follow-up: added a per-player Discord image report. The new Image action generates a PNG card with Albion item icons, missing quantities, partial-deposit context, estimated silver, and pickup details. The PNG can be copied to the clipboard or downloaded for posting to Discord.

### 2026-05-11 — Stop DiskSafety false-positive compaction restart loop

Investigated the live VPS after repeated May 11 restarts (`NRestarts=23`). The site was up between restarts, but `DiskSafety` kept launching aggressive compaction because the SQLite file measured 15.3 GB. The missing detail: `pragma_freelist_count()` showed ~6.3 GB of that file was already free pages from prior deletes, so live DB pages were only ~9 GB. Because `checkDiskUsage()` used `page_count * page_size` without subtracting the freelist, it treated a mostly-clean DB file as over-threshold forever, started compaction every post-restart 25-minute check, then the event-loop watchdog aborted the process after compaction stalls crossed 60 s.

Fixes:
- `checkDiskUsage()` now bases WARN/EMERGENCY compaction decisions on live pages: `(page_count - freelist_count) * page_size`. Logs now include live size, total file size, and free-page size.
- Heavy background jobs now respect `compactionRunning` both ways: spreadStats and analytics defer while compaction runs; compaction skips while priceRefCache is running; priceRefCache skips while compaction runs.
- Compaction chunks reduced 5000 -> 1000 rows, Tier2 item batches reduced 200 -> 20 items, and extra `setImmediate` yields were added between read/write/delete phases. This lowers per-tick blocking risk on the live 16 GB DB.
- Added progress logs inside long compaction tiers so the next incident report shows exactly which phase is slow instead of only "Starting" followed by a watchdog abort.

Operational note: the VPS disk is still tight because `/opt/albion-saas/backups` holds four ~16 GB DB backups (~62 GB total). That is bounded by the current cron, but it leaves only ~15 GB free on a 96 GB disk; consider reducing backup count or compressing/offloading snapshots once the service is stable.

### 2026-05-04 (later, deferred backlog) — `price_hourly` retention 30 → 14 days + analytics double-fire fix

After the stability arc landed, picked up two deferred backlog items:

- **`price_hourly` retention reduced 30 d → 14 d.** At ~8 M new rows/day ingest, 30-day retention gives a ~240 M-row steady-state table; the chunked Tier 2→3 compaction handles that load fine, but the table itself is structurally large (~5 GB on disk just for indexes). 14-day retention cuts steady-state to ~112 M rows (-50%). User-facing impact: `/api/price-history?days>14` charts get hourly OHLC bars only for the last 14 days; older days fall back to daily resolution from `price_averages` (the line plot from `histRows` already returns daily rows for the older window, no endpoint code change needed). Default `?days=7` and the common `?days=14` views unchanged.

- **Analytics scheduling double-fire fixed.** The pattern `setTimeout(_runAnalytics, 35min); setInterval(_runAnalytics, 30min)` was firing analytics at +30, +35, +60, +90… — i.e. two consecutive runs near every restart (observed today at 19:03:55 + 19:07:25). Replaced with the cleaner nested form: `setTimeout(() => { _runAnalytics(); setInterval(_runAnalytics, 30min); }, 35min)`. Now fires at +35, +65, +95, … as documented.

### 2026-05-04 (final pass) — root cause was WAL frame traversal, not just SQL ordering

After all the chunking and mutex fixes landed, spreadStats *still* logged a 23.6 s EventLoop wedge at 18:27:08 — with no concurrent priceRefCache, with the 128 MB cache, with proper chunking. CLI EXPLAIN of the same query on the same chunk: 1.78 s. Production: 23 s. 13× slower.

Hypothesis: WAL frame index traversal cost. Each cross-connection read consults the WAL frame index for every page it needs. NATS flushes (every 30 s) and priceRefCache writes (87 k upserts every 10 min) push the WAL toward its 64 MB cap. With thousands of frames in the log, statsDb's reads pay an O(WAL frames) penalty per page lookup.

Tested by manually running `PRAGMA wal_checkpoint(TRUNCATE)` on the live DB — WAL went from 64 MB → 0 bytes; then the same query timed at 1.78 s in CLI. Confirmed.

**Three-part WAL discipline shipped:**

- **`wal_autocheckpoint` lowered 1000 → 500 pages** (~4 MB → ~2 MB threshold). Keeps WAL bounded between explicit checkpoints; less frame index to traverse on every cross-connection read.
- **End-of-`refreshPriceRefCache` checkpoint upgraded `PASSIVE` → `RESTART`**. PASSIVE was leaving frames behind whenever any reader held the snapshot (very common under live load). RESTART resets the frame count to 0 unconditionally; readers automatically restart on their next read. The file size doesn't shrink (preallocated cap stays) but frame index becomes empty.
- **Pre-run `wal_checkpoint(RESTART)` at start of `computeSpreadStats`**. The 90-second defer window between priceRefCache end and spreadStats retry refills the WAL with NATS flushes; clearing it just before the heavy aggregate ensures spreadStats reads against a clean frame index.

Both checkpoints log their `busy/log/checkpointed` counts so we have ongoing visibility.

**Verified at the 18:43:55 cycle:**

```
[SpreadStats] Starting chunked aggregation... RSS: 356MB Heap: 136MB
[SpreadStats] pre-run wal_checkpoint(RESTART): busy=0 log=25 checkpointed=25
[SpreadStats] Done. Processed 34987 items, 171617 agg rows, wrote 336175 spread stats. RSS: 373MB
```

Total runtime 25 s. Zero EventLoop WARNs in the surrounding 30 s window. WAL log=25 frames at start (was thousands), all 25 checkpointed cleanly, frame index reset to zero before the heavy reads.

The complete arc — chunking + mutex + cache bump + WAL discipline — has spreadStats running 90 s → 25 s, priceRefCache 50 s → 6-8 s, and the EventLoop watchdog reporting silent during normal cycles.

### 2026-05-04 (later evening) — `priceRefCache` + `computeAnalytics` chunked too; mutex+defer between heavy aggregates

After the spreadStats fix landed and ran clean once (17:16 cycle), the watchdog caught a **22.6 s wedge at 17:26:34** with `compaction=false stats=0 analytics=0` — none of the known-heavy jobs were running. Traced to `refreshPriceRefCache` (10-min interval) doing the **same monolithic GROUP BY anti-pattern** as spreadStats: full table scan against `idx_pa_ema_stream` with column-order mismatch on the GROUP BY, forcing a full sort.

**Same chunking fix applied to three more functions:**

- **`refreshPriceRefCache`** + **`initPriceRefCache`**: now async, chunked by 10 item_id ranges with `setImmediate` yields between SQL/write phases. Was 22 s monolithic; now 6-8 s total across 10 chunks.
- **`buildPriceReference`** (in-memory map builder over ~140 k cache rows): now async, yields after the SELECT and every ~12 k iterations in the city/volume/global accumulator loop.
- **`computeAnalytics` 7d aggregate** + **30d aggregate**: chunked by item_id range. Same anti-pattern, fires every 30-35 min.

**Plus a mutex layer to prevent concurrent collisions:**

After deploying the priceRefCache chunking, the next 10-min cycle (17:39) **still wedged at 20.9 s** because spreadStats ran *concurrently* — both functions querying `price_averages` on the same `statsDb` connection thrashed the SQLite page cache. Even with each chunk individually under 5 s, contention stretched single chunks to 20 s.

Fix: `priceRefCacheRunning` flag.
- `refreshPriceRefCache`/`initPriceRefCache` set it at start, clear in `finally`.
- `computeSpreadStats`/`computeAnalytics` check it and **defer 90 s with `setTimeout` retry** rather than skipping. Skip-policy would have meant spreadStats (60 min cycle) collided with priceRefCache (10 min cycle) at every LCM=60 min hit and *never* fired again. Defer-retry waits the ~6-8 s priceRefCache run and then proceeds.
- Similar bidirectional checks: priceRefCache also checks `statsRunning`/`analyticsRunning`; analytics checks `priceRefCacheRunning`/`statsRunning`.

**Verified live:**
- 17:55:51 — `[SpreadStats] PriceRefCache running, skipping this cycle` (early skip-only version).
- 18:09:40 — `[SpreadStats] PriceRefCache running, deferring 90s` (defer-retry version).
- 18:09:46 — `[PriceRefCache] Updated 86725 entries from last 2h` — full cycle in 8 s (vs 50 s pre-chunking).
- 18:11:10 — `[SpreadStats] Starting chunked aggregation...` — retry fired exactly 90 s later as designed.
- Zero EventLoop WARNs during the run on the new code.

**Files modified:** `deploy_saas.py` (~+200 lines net across 4 commits: spreadStats chunking, priceRefCache chunking, mutex flag, analytics chunking + defer-retry).

**Still TODO:**
- `transport-routes-live` CTE (line ~3458) is the last full-table GROUP BY against `price_averages`. User-facing endpoint, rate-limited (5/min) + 30 s response cache, so much lower wedge risk than the background jobs. Worth chunking for consistency but not urgent.

### 2026-05-04 (evening) — SpreadStats wedge: chunk aggregate by item_id range so event loop stays responsive

The afternoon's `monitorEventLoopDelay` watchdog earned its keep on its very first cycle. At 16:20:18 UTC the journal logged `[EventLoop] Max delay 49392ms in last 30s (compaction=false stats=1 analytics=0)` — a 49.4-second event-loop block during `computeSpreadStats`, just 10 s under the 60 s `process.abort()` threshold. Process kept running, but a single quality regression away from a restart loop.

**Root cause:** the SQL aggregate was a single sync `statsDb.prepare(...).all(cutoff)` returning 170,949 GROUP BY rows in one shot. SQLite's planner picked `idx_pa_ema_stream(item_id, city, quality, period_start)` for the scan, but our GROUP BY is `(item_id, quality, city)` — the column order mismatch forces a full sort before any rows are returned. `iterate()` can't stream past a sort, so the entire result set materializes before the JS loop sees anything. Direct `sqlite3` CLI: 8.8 s. Live process under concurrent NATS+snapshot load: 49 s.

**Why the migration didn't catch this:** stage 2 of better-sqlite3 chunked the WRITE phase (1000-row INSERT batches with `setImmediate` yields). The READ phase stayed as one `.all()` because at the time the table was 30 M rows of price_averages and the aggregate took 5-10 s — annoying but under the (then-nonexistent) watchdog threshold. After the May 4 cleanup the table dropped to 5.9 M but the query plan got worse: ANALYZE didn't move it off `idx_pa_ema_stream`.

**Fix shipped:** chunked aggregation across 10 item_id ranges (`''`-`T4_`, `T4_`-`T5_`, ..., `T8_`-`T8_M`, `T8_M`-`U`, `U`-`￿`). Each range's `WHERE item_id >= ? AND item_id < ?` switches the planner to `SEARCH ... USING INDEX (item_id>? AND item_id<?)` and runs in 1-3 s. `await new Promise(r => setImmediate(r))` between every range keeps Express + WS + NATS responsive throughout the ~30-40 s total runtime.

**Other tightening in the same change:**
- `computeSpreadStats` is now `async` proper, wrapped in try/finally so `statsRunning` always resets even on throw.
- Top-level `_spreadStatsRunner` catches and logs unhandled rejections — a future bug can never leave the flag stuck.
- `aggStmt` and `stmt_spreadInsert` prepared once outside the chunk loop; `processBatch` recursion + setTimeout(50) trampoline replaced with a flat for-await loop.

**Validated locally:** single-chunk T6 aggregate (36,280 result rows, 2.6 s) < 5 s WARN threshold. CLI `EXPLAIN QUERY PLAN` for the chunked form: `SEARCH price_averages USING INDEX idx_pa_ema_stream (item_id>? AND item_id<?)`. `node --check` on the embedded backend.js passes.

**Files modified:** `deploy_saas.py` (~140 lines net in `computeSpreadStats`).

**Still TODO (deferred):**
- Covering index `(item_id, quality, city, period_start, avg_sell, avg_buy, min_sell, max_buy)` would make the aggregate index-only and drop each chunk from 1-3 s to <500 ms — but adds ~480 MB to the DB. Not justified yet.
- Confirm overnight that no chunk crosses the 5 s WARN threshold under live concurrent load.

**Plus two follow-on hardenings shipped in the same deploy:**

- **`price_averages` daily rows now capped at 90 days.** Tier 2→3 compaction had no upper retention bound — daily rows accumulated forever from the price_hourly roll. At ~85 k daily rows/day that grows to ~31 M rows/year unbounded. The new prune step in `compactOldData()` runs after Tier 2→3, chunked by rowid in `COMPACTION_CHUNK`-sized slices with `setImmediate` yields between chunks (same pattern as Tier 1→2). 90 days is generous: SMA-30d uses hourly buckets, BM Flipper uses 7d, no UI surface needs more.

- **Skip the loot_events dedup DELETE on subsequent restarts.** The startup sequence ran a `DELETE FROM loot_events WHERE rowid NOT IN (SELECT MIN(rowid) ... GROUP BY 7 columns)` unconditionally on every boot, taking 5-10 s on a large table. Once the unique index `idx_loot_events_dedupe` is installed, all 4 `INSERT INTO loot_events` callsites use `INSERT OR IGNORE` so duplicates can't accumulate — the recurring DELETE is pointless. New code checks for the index in `sqlite_master` and skips the GROUP BY + DELETE when it exists. Should drop startup event-loop block from ~16 s → ~1-2 s on the next clean boot.

**Follow-on tightening from the first verified cycle (deploy `20260504-150601`):**

The 16:58 spreadStats run finished in 21 s (down from 90 s pre-fix) but logged a 5948 ms EventLoop max delay — one chunk's contiguous sync work (SQL aggregate + city-pair compute + flush) crossed 5 s. Added 3 yield points per chunk: after the SQL aggregate (compute starts on a fresh tick), every 1000 items in the compute loop (drains writeBuf periodically), and before flushing the chunk's tail buffer. Trade-off: small wallclock overhead (~25-30 s vs 21 s) for keeping each sync span under 5 s. PANIC threshold unchanged at 60 s.

Plus added a 60 s boot-grace window to the EventLoop watchdog. The startup path has 3 contiguous sync ops (`initPriceRefCache` GROUP BY + `writePriceRefInit` transaction + `buildPriceReference` loop) that combine to 5-7 s — natural one-spike-per-restart, not a regression. Boot-window WARNs now log at INFO level with a clear `(boot grace)` marker so we still have observability without crying wolf in the journal.

### 2026-05-04 (afternoon) — Hardening pass after first overnight: split transient errors, raise compaction threshold, add event-loop watchdog

After the morning's emergency compaction fix held cleanly through 7 compaction cycles overnight (NRestarts=0, all 1.4M migrated rows processed without wedging), reviewed the journal and fixed the loose ends I'd flagged for next session:

- **`[FATAL] Uncaught exception: socket hang up` (×2) + `Cannot read properties of null (reading 'setHeader')` (×2) overnight** — fired in pairs, ~30-65 s apart, both following AODP cache-scan timeouts. Service kept running (the handler logs and continues for non-SQLite errors), but the previous handler reset *every* job flag (`scanInProgress`/`statsRunning`/`analyticsRunning`/`dbBusy`) on any uncaughtException, so a single transient socket error blew away in-flight compaction state and let a second compaction race. **Fix in `_handleFatal`:** classify errors. Anything matching `/socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|AbortError|aborted|reading ['"]setHeader['"]/|Cannot set headers after they are sent|write after end|Premature close/` is now `[NET-WARN]` (logged, no flag reset). Genuine programmer/state errors keep the original `[FATAL]` + flag-reset behavior, plus full stack traces (previously `err.message || err.stack` only logged stack if message empty — flipped to log both).

- **`Cannot read properties of null (reading 'setHeader')` source identified** — the global 30s `res.setTimeout` middleware called `res.status(503).json(...)` even when the underlying socket had already been destroyed (mid-tear-down). The `setHeader on null` was Node's HTTP layer crashing inside `res.json`'s set-Content-Type path. **Fix:** check `res.destroyed`, `res.socket`, `res.socket.destroyed`, `res.socket.writableEnded` before calling `res.status().json(...)`, and wrap the call in try/catch. Also wrapped the patched `res.json`/`res.send` themselves in try/catch.

- **`DB_WARN_GB` raised 10 → 15 GB** — steady-state DB after the morning cleanup is ~13 GB (mostly `price_hourly`'s 51M rows; `price_averages` itself is ~1.5 GB). With WARN at 10 GB, the 2h `checkDiskUsage` cycle triggered compaction *every cycle, forever* — 8-13 min of work per cycle, 12 cycles/day = ~120-150 min/day on routine no-op compaction. With WARN at 15 GB the daily 7-day-retention compaction handles routine cleanup; the 2h trigger only fires if growth has actually outpaced the daily run. EMERGENCY threshold (20 GB → 1d retention) unchanged.

- **`monitorEventLoopDelay` watchdog added** — the missing piece from yesterday's diagnosis. Uses `node:perf_hooks` (libuv-level high-resolution timing — accurately measures sync wedges that the JS event loop itself can't observe). Sample every 30s: `>= 1000 ms` logs `[EventLoop] Max delay Xms` (slow sync query); `>= 60000 ms` triggers `process.abort()` for clean systemd restart. The May 3 wedge would have been caught here in the first 30s window vs. hours of silent unresponsiveness. The chunked compaction yields every 5K rows (~50 ms per chunk) so it stays well under 1000 ms during normal operation.

**Files modified:** `deploy_saas.py` (~+60 lines), `sw.js` (auto-bumped). One deploy (server stamp `20260504-125555`), zero downtime — clean SIGTERM → restart cycle, all subsystems came back in 5 s.

**Not addressed in this pass (deferred):**
- AODP cache-scan timeout retry — current behavior is fine (per-chunk catch already in place; AODP API is just flaky). Adding retry would double load when the API is already struggling.
- Discord webhook alert on `dbMB > 15000` or `rssMB > 2000` — needs webhook URL plumbing through env. Low priority while `[HEALTH]` is grep-able.
- `price_hourly` retention strategy — 30d retention on 8M new rows/day = 240M-row steady state. Patched compaction handles it without wedging, but the table itself is large.
- Daily `price_averages` retention cap (90d) — modest growth, not urgent.

### 2026-05-04 — Emergency: site outage from event-loop wedge on synchronous compaction (root-cause fix)

**Symptom:** User returned from work to a hung site. Manual `systemctl restart` fixed it for ~26 minutes, then it wedged again. External HTTP timed out (15s no response). Recv-Q on port 443 = 479 pending connections that the process couldn't drain. From outside, identical to the pre-migration restart loop — but `NRestarts=0`, the process was *technically* alive.

**Why the May 2-3 migration didn't catch this in stress testing:** the migration eliminated the `SQLITE_BUSY` abort class (3.7 GB RSS leak from accumulated orphans → process.abort → systemd restart, repeated). What had been hidden underneath was a slow-burning growth bug: `compactOldData()` had been silently failing for some time. Pre-migration the restart loop *masked* it — every `process.abort` cleared in-flight compactions along with the queue. Post-migration the aborts stopped, so the silent failures stopped being papered-over and the underlying tables grew unbounded.

**Root cause chain (fix at each layer):**

1. **Event-loop wedge** — `compactOldData()` (line 5344-5448 of the pre-fix backend) did `db.all("SELECT ... FROM price_averages WHERE period_type='hourly' AND period_start < ?", ...)` to load the entire result set into one JS array, then ran a single sync `db.transaction()` doing `stmt.run` for every row. With 30M rows this loaded ~9.7 GB into RSS and held the JS event loop for hours. While compaction was running, NO HTTP / WS / NATS request could be served — the process appeared dead from outside.
   - **Fix:** rewrote `compactOldData` as `async` with chunked `LIMIT N` SELECTs (5K rows per cycle), per-chunk INSERT-then-DELETE transactions, `await new Promise(r => setImmediate(r))` between chunks (event loop gets a tick between every batch), `process.memoryUsage().rss > 1.5 GB` early bail, and `PRAGMA wal_checkpoint(TRUNCATE)` at the end so WAL can't grow unbounded across cycles. Same chunked pattern applied to Tier 2→3 (paginated by `item_id`).

2. **Why the tables grew to 30M / 51M rows** — compaction has been failing ever since the DB crossed ~5 GB, but failures emitted only a single `console.error` line that was buried under thousands of routine log lines. No alert, no DB-size threshold, no log-line that periodically said "DB is now X GB".
   - **Fix:** added a `[HEALTH]` heartbeat that emits every 10 minutes with `dbMB`, `walMB`, `rssMB`, `heapMB`, plus the `compactionRunning`/`statsRunning`/`analyticsRunning` flags. Now `journalctl -u albion-saas | grep HEALTH` gives the entire growth history at a glance.

3. **WAL bloat** — when the wedged process *did* run something, the WAL grew to 4 GB and stayed there because a single multi-billion-row DELETE transaction never commits, so SQLite's `wal_autocheckpoint=1000` can't fire.
   - **Fix:** chunked DELETEs commit every 5K rows so autocheckpoint can keep WAL bounded. The per-cycle `wal_checkpoint(TRUNCATE)` at the end forces a hard reset.

4. **No watchdog for non-`withWriteLock` event-loop wedges** — the May 1 perma-fix added a 90-second `WriteLock-WATCHDOG` per task, but `compactOldData` doesn't go through `withWriteLock` (which was deleted in stage 4 of the migration anyway). Long-running sync queries outside that path have no detection at all.
   - **Mitigation now:** chunked compaction can't wedge for more than ~50ms per chunk. **Still TODO:** `monitorEventLoopDelay` from `node:perf_hooks` running in the main loop — would catch arbitrary sync wedges, not just compaction's. Documented for next session.

**One-time DB cleanup (offline, with service stopped):**
- Bulk-copy keepers strategy (much faster than chunked DELETE on a 30M-row indexed table — DELETE is ~700 rows/sec because of per-row index updates; bulk INSERT is ~33K rows/sec because indexes are recreated once at the end).
  1. `CREATE TABLE price_averages_new (same schema, no indexes)`
  2. `INSERT INTO _new SELECT * FROM old WHERE period_type='daily' OR period_start >= now-3d` — 5,929,557 keepers from 29,818,787 rows in **179 s**
  3. `DROP TABLE price_averages` — **18 min** (4.7M pages added to freelist)
  4. `ALTER TABLE _new RENAME TO price_averages`
  5. Recreate 3 indexes — **84 s total**
  6. `DELETE FROM spread_stats WHERE updated_at < now-14d` — 12,815 rows
  7. `PRAGMA wal_checkpoint(TRUNCATE)` — instant
  8. `VACUUM` — **20 min** (rewrote the 20.4 GB file with most pages free into an 11.7 GB compact file)

**Numbers:**
- DB on disk: 19.7 GB → 11.7 GB (-8 GB; the remainder is `price_hourly` 51M rows which weren't touched — see TODO below)
- `price_averages` rows: 29,968,787 → 5,929,557 (-80%)
- WAL at idle: 4 GB → 8 KB (clean)
- Process RSS at idle: 9.7 GB → 182 MB (-98%)
- Disk usage: 87% → 36% (after we also dropped 4 obsolete backups during the work — backup cron keeps 4 most recent and they were 14-19 GB each from the bloat era)
- HTTP latency: timeout (15+ s) → 300 ms

**Verified post-deploy (server version `20260504-001522`, MainPID=11442 at `Mon 2026-05-04 02:15:26 CEST`):**
- `NRestarts=0`
- 0 FATAL / 0 BUSY / 0 Uncaught log lines
- All HTTP routes 200 OK at <300 ms (`/api/leaderboard` returned real JSON end-to-end, including the user's own Discord profile)
- `[Cache] Loaded 11175 item IDs.` — initial market scan running cleanly
- Itemmap + Weightmap + NATS + SMTP + Discord bot all loaded without errors

**Open TODOs flagged during this work (not blocking site uptime):**
- `price_hourly` retention is 30 days but data accumulates at ~8M rows/day, giving a ~240M-row steady state. The chunked Tier 2→3 in this patch *will* handle that load without wedging, but the table itself is structurally large. Options for next session: (a) reduce `price_hourly` retention to 14 days, (b) skip `price_hourly` entirely and roll directly from raw → daily, (c) prune low-traffic items from `price_hourly` based on `volume`.
- `price_averages` daily rows have no retention policy — they'll grow forever as Tier 2→3 fires. At ~85K daily rows/day they're modest, but worth a 90-day-retention cap eventually.
- Add `monitorEventLoopDelay` watchdog (see fix #4 above).
- Add Discord webhook alert when `[HEALTH]` shows `dbMB > 15000` or `rssMB > 2000`.
- Consider `DELETE FROM price_snapshots` retention check — table is currently empty (0 rows), confirm that's expected vs. an ingest-path bug.

**Files modified:**
- `deploy_saas.py` — `compactOldData` rewrite (~140 lines), `[HEALTH]` heartbeat (~25 lines), `.catch()` handlers on fire-and-forget compaction calls. Net +~190 lines, mostly comments documenting why each guard exists.
- `tmp_check/bulk_copy_cleanup.py` — one-time offline DB cleanup script (kept in repo for reference; `tmp_check/` is in `.gitignore`).

**Lessons:** any sync DB operation that can scan more than ~10K rows MUST yield to the event loop between chunks under better-sqlite3. The migration removed the worst symptom (BUSY restart loops) but didn't audit every existing query for "scan size" — that's the next layer of hardening.

### 2026-05-03 — better-sqlite3 migration: drop node-sqlite3 entirely (4 stages, ~17 hours work)

The structural fix the May 1 perma-fix was a band-aid for. With `better-sqlite3` (sync), the entire async-callback orphan bug class becomes structurally impossible. JS itself is the natural serialization layer — there's no event-loop interleaving, no orphan callbacks firing late, no cross-connection BUSY cascades. Built per `BETTER_SQLITE3_MIGRATION_PLAN.md` §4 stages 1-4.

**Stage 1 — readDb (commit `958a147`):** Migrated the read-only connection (`/api/me`, leaderboard, public viewers, ~60 callsites). Hot-path `/api/me` prepared statement hoisted to module scope. All `readDb.get/all` callbacks converted to `try { readDb.prepare(sql).get(...params); } catch (err) {...}`. Dropped `readDb.on('error')` (better-sqlite3 has no EventEmitter). 

**Stage 2 — statsDb (commit `e0b7e2b`):** Migrated the analytics/spreadStats connection. The big aggregates (5-30s sync queries) and the EMA streaming pass (was `statsDb.each`) all preserve event-loop responsiveness via chunked `stmt.iterate()` + `setImmediate` yields every 5K rows. `flushWrites` rewritten to `db.transaction().immediate()` with auto-rollback. `computeAnalytics` made async to support the chunked yields. `computeSpreadStats` write batches raised 100 → 1000 rows (sync transactions are 4-10× faster).

**Stage 3 — db connection + DDL + compat shim (commits `697b63e` + `d7af1a8`):** Migrated the main writer connection. The 350-line `db.serialize` DDL block (60+ `CREATE TABLE` / `ALTER TABLE`) collapsed into flat `db.exec()` + `tryExec()` (which swallows "duplicate column" errors so re-deploys are idempotent). For the ~150 untouched HTTP/WS handler callsites, installed a thin compat shim (~100 lines) that gives `db.run/get/all/each/serialize/prepare` the node-sqlite3 callback API while routing through better-sqlite3 sync underneath. Every shim call does sync work — the async-callback orphan class is structurally impossible regardless of what the callsite syntax looks like.

**Stage 4 — delete the queue infrastructure + drop sqlite3 dep (commit `05da8b8`):** With all 3 connections sync, the `withWriteLock` queue + watchdog + queue-depth ceiling + `_isSqliteFatal` abort-on-SQLite policy are obsolete. Deleted `_writeQueue` / `_writeDepth` / `_writeActive` / `WRITE_QUEUE_CEILING` / `WATCHDOG_TIMEOUT_MS` / `WRITE_LOCK_NEVER_DROP` / the 38-line `withWriteLock(label, fn)` body / the queue-health `setInterval`. Dropped `node-sqlite3` from `package.json`. Simplified `_handleFatal` (kept the non-SQLite uncaughtException catch). All 10 `withWriteLock(...)` callsites converted to direct sync `db.transaction(...).immediate(args)` with auto-rollback semantics — the manual `BEGIN IMMEDIATE → prepare → run loop → finalize → COMMIT/ROLLBACK callbacks` chain (~20 lines per site) replaced by ~5 lines per site.

**Stage 5 (collapse statsDb into db) — SKIPPED.** Cosmetic only. Saves ~16 MB RSS and one file descriptor. Plan flagged as optional. Stages 1-4 deliver the full structural win.

**Pre-flight verified:**
- `npm install better-sqlite3` on VPS pulled prebuilt for Linux x64 Node 20.20.2 (no compile)
- Local `node --check` on the embedded backend.js passes at every commit (also added a pre-deploy syntax check to `deploy_saas.py` itself — commit `719331d` — so a typo can never reach SFTP)
- 5 deploys total (incl. one fix-up for a dangling `_earlyDbErrors` reference)

**Observed at deploy time:**
- backend.js: 305 KB → 289 KB (-16 KB net; deleted ~150 lines of queue infrastructure + ~70 lines of nested callback chains, added ~30 lines of try/catch + chunking + the compat shim)
- RSS at idle: 3.7 GB (pre-migration accumulated baseline) → 182-243 MB (fresh process) — ~15× reduction. Will need 24h+ observation to confirm steady-state.
- NRestarts since May 1: 94 → 0 since stage 4 deploy at 2026-05-03 03:13 UTC
- 0 FATAL / 0 BUSY / 0 Uncaught log lines since stage 4 deploy
- All HTTP routes responding 200 OK at <300 ms (network-bound, not server)
- spreadStats + market scanner + NATS flush all running cleanly through stages 2-4 deploys

**What stays:**
- All schema, indexes, WAL mode, daily backup cron unchanged
- All API contracts identical — every endpoint returns identical JSON
- All client code (`app.js`, `index.html`, `style.css`, IndexedDB, Go client) unchanged
- 8 GB RSS exit watchdog kept (independent of SQLite driver)
- 2 (was 3) connections: `db` (writer) + `readDb` (reader); `statsDb` separate connection retained because stage 5 was deferred — collapsing it is a pure cleanup, no functional impact

**The migration plan:** [BETTER_SQLITE3_MIGRATION_PLAN.md](BETTER_SQLITE3_MIGRATION_PLAN.md). Three subagents (architect, code-inventory, docs-lookup) ran in parallel to produce the plan; this CHANGELOG entry documents the executed result.

---

### 2026-05-01 — SQLITE_BUSY perma-fix: producer flow control + drop `_activeDone` + BEGIN IMMEDIATE

After three days of patches and a site-hang incident, this is the structural fix. Designed against synthesised input from three review agents (architect, TS reviewer, external-research) who converged on the same root causes and recommendations.

**Root causes the previous patches missed:**

1. **`_activeDone` releases the wrong task.** It points at "whoever currently holds the lock," not "whoever caused the BUSY." When a prior task's orphan `stmt.run` callback fires `SQLITE_BUSY` *after* its `done()` already resolved, the next holder (innocent fresh task) is now `_activeDone`. `_handleFatal` releases that innocent task. Its body still has open `BEGIN IMMEDIATE` on the connection — the next task's `BEGIN` collides with it, more BUSYs, cascade. Each spurious release leaves orphan callbacks pending in node-sqlite3's C++ worker queue. Their backing buffers stay resident → 8 GB RSS in 30 min.

2. **Producers were unbounded.** `computeSpreadStats.flushWrites()` fired `withWriteLock('spreadStats-flush', …)` per 100-row batch *without awaiting*. With ~470 k rows per cycle that's 4,700+ tasks queued simultaneously. Each holds a `batch` array closure in V8 heap. This is why the lock-depth log warning would scroll past 4,000 — by design of the producer.

3. **`priceRefCache-init` and `-incr` had bare `db.run('BEGIN')` with no error callback** — if BEGIN errored, the prepared statement still ran (in autocommit), `stmt.finalize()` (also no callback) silently dropped its error, and `done()` could go uncalled. The 30-min watchdog would eventually abort with no log of the underlying cause.

4. **`BEGIN TRANSACTION` (deferred mode) instead of `BEGIN IMMEDIATE`** — deferred BEGINs upgrade to writers on first write, which is when contention surfaces. IMMEDIATE acquires the writer lock at BEGIN time, failing fast if another writer holds it. The SQLite forum's most-cited explanation of WAL deadlocks calls this out as the textbook fix.

5. **No `'error'` listener on `db` / `statsDb` / `readDb`.** node-sqlite3's `Database` extends `EventEmitter`. An emitted `'error'` with no listener crashes the process synchronously, bypassing our `uncaughtException` handler and producing no log.

**The fix (one commit, multi-pronged):**

- **Producer flow control** in `computeSpreadStats`: `flushWrites()` now returns its `withWriteLock` promise. `processBatch` is `async` and `await`s `flushWrites()` before continuing. Bounded in-flight = bounded buffer residency. Same total throughput, no queue-depth explosion.
- **Queue-depth ceiling** (`WRITE_QUEUE_CEILING = 50`) inside `withWriteLock`. Producers other than NATS, snapshots, and priceRefCache-init are dropped if the queue is saturated (`Promise.reject(...)`). NATS / scan / boot-cache rebuild bypass the ceiling via `WRITE_LOCK_NEVER_DROP`.
- **Drop `_activeDone` entirely.** Restore abort-on-SQLite-uncaughtException as the single safe failure mode. With producers bounded, BUSY events at this layer should be rare (<1% of pre-fix frequency), and aborting on them is cheaper than the cascade leak `_activeDone` was designed to avoid.
- **`BEGIN TRANSACTION` → `BEGIN IMMEDIATE`** at all 9 writeLock-wrapped sites. Fail-fast at the SQLite engine level instead of upgrade-deadlocking mid-transaction.
- **`PRAGMA journal_size_limit = 67108864` (64 MB)** on all three connections. Prevents WAL file unbounded growth when long readers (daily backup, stalled cycles) block checkpoints. Source: Loke.dev's WAL-bloat post-mortem.
- **Fix `priceRefCache-init` / `-incr`**: error callbacks at BEGIN, prepare, run, finalize, COMMIT, and explicit ROLLBACK on error path. Was the only writeLock callsite without this pattern.
- **`db` / `statsDb` / `readDb` `'error'` event listeners**, registered immediately after each connection is constructed, with an early-buffer to defer to `_handleFatal` once it's defined later in the file.

**Expected impact:**
- RSS plateau in the 600–1500 MB range (vs current 400 MB→8 GB cycle).
- Watchdog/abort frequency: <5/day from 44/day.
- Site downtime from restarts: <1 min/day from ~7 min/day.
- Morning 04:00 UTC routine cron POSTs land cleanly.

**Kill switches preserved:**
- Producer awaits: single revert hunk in `computeSpreadStats` if it backfires.
- Queue ceiling: revert via removing one `if` block in `withWriteLock`.
- `_activeDone` removal: re-adding ~5 lines if a new wedge mode appears.
- BEGIN IMMEDIATE: search-replace back to `BEGIN TRANSACTION`.

**Deferred to follow-up commits:**
- Split `price_analytics`/`spread_stats`/`price_hourly`/`price_ref_cache` into separate `analytics.sqlite` file (architect Option F, commit 2). Eliminates remaining cross-connection contention with the daily backup window. Migration ~1-2 days, reversible.
- `priceRefCache` JSON persistence + cold-boot warmup (architect Option F, commit 3). Removes the 30-min watchdog on `priceRefCache-init` entirely.
- Migration to `better-sqlite3` only if the above is insufficient. ~1-2 weeks, mostly mechanical, would eliminate the entire async-callback-orphan class of bug.

**Files:** `deploy_saas.py` — ~150 lines net change across PRAGMAs (3 connections), `withWriteLock` (queue ceiling + label-set), `_handleFatal` (drop `_activeDone` path + abort-on-any-SQLITE), `computeSpreadStats` (`flushWrites` returns promise + `processBatch` async/await), `priceRefCache-init` and `-incr` (error callbacks + ROLLBACK), 9× BEGIN→BEGIN IMMEDIATE, error-event handlers + early buffer.

### 2026-04-30 — Reverted `flushNatsBuffer` chunking after site-hang incident (commit `9593084`)

The chunking change (`2fe624b`, ~90 min after `_activeDone` shipped) was reverted today after causing a full site hang. Process stayed `active running` per systemd but the Node event loop wedged — last log entry 27 min before observation, HTTP requests timing out both externally and on localhost. Required `kill -9` (systemd's SIGTERM stuck in `stop-sigterm` for >90s).

**Suspected interaction:** under heavy spreadStats-flush load, the writeLock queue depth spiked to 4275. After spreadStats finished, the queue drained nats-flush chunks. At 16:56:05 a BUSY uncaughtException fired and the `_activeDone` release path released the active chunk. Released-task orphans (pending `db.run` callbacks) continued firing on `db`'s internal queue. Subsequent BUSY uncaughtExceptions from those orphans likely released *innocent* fresh tasks via `_activeDone`, since `_activeDone` always points at whoever currently holds the lock — not whoever caused the BUSY. Cascade: each release leaves more orphans, more BUSYs, more wrong releases. Eventually node-sqlite3's worker threads got saturated processing thousands of orphan BEGIN/COMMIT/ROLLBACK ops, the JS event loop blocked on libuv, Express stopped responding.

The chunking change made this dramatically worse by inflating the number of pending withWriteLock tasks (8+ chunks per 30s NATS interval vs 1 task pre-chunking). Pre-chunking, queue depth maxed at ~50; post-chunking, 1000+ pending tasks was normal — multiplying the cascade surface.

**Action:** reverted `2fe624b`. Kept the `_activeDone` release fix from `1c8917d` (stable in 90 min of solo observation — 1 abort, no hangs). Site back up immediately on revert deploy `20260430-153018`.

**Known regression vs. the chunking attempt:** occasional `nats-flush` silent wedges will return (~3 per 14h pre-fix). `_activeDone` only helps the *BUSY-uncaughtException* wedge case (spreadStats), not the *genuine no-error wedge* case (nats-flush legitimately holding 90s+ under contention).

**Lesson learned about `_activeDone`:** it has a structural flaw — it has no way to identify which task an async error belongs to, so any BUSY uncaughtException AFTER the original wedger has been released will release the next innocent holder. The fix has been "stable enough" because the cadence of BUSYs is low enough that the wedge causer is usually still the holder when its BUSY fires. The chunking change broke that assumption by inflating the fast-rotating queue.

**Real perma-fix options (TODO):**
- (a) Detach orphan-prone tasks: don't share withWriteLock between spreadStats's many small batches and nats-flush's single big task — separate queues so an orphan from one can't release the other.
- (b) Track per-task timestamps in `_activeDone` and only release if active task is older than e.g. 30s (a fresh task can't be released by an old orphan's BUSY).
- (c) Abandon `_activeDone` entirely and accept the 90s watchdog aborts as the cleaner failure mode (~50 restarts/17h is annoying but not service-impacting between restarts).

**Files:** `deploy_saas.py` — `flushNatsBuffer()` reverted to single-batch BEGIN/COMMIT, sw.js cache bumped.

### 2026-04-30 — SQLITE_BUSY restart loop, round 2: writeLock release on uncaughtException

Yesterday's fix (`a82492e`) reclassified `SQLITE_BUSY` as non-fatal in `_handleFatal`. It stopped the direct `process.abort()` path but the service still cycled to `NRestarts=50` overnight (~17.5h) with the same churn cadence — the abort just moved to a different trigger.

**Root cause (was masked by the previous fix):** when `SQLITE_BUSY` bubbles up as an `uncaughtException` (rather than into the per-statement callback chain), `_handleFatal` resets the global flags and returns — but never calls `done()` on the active `withWriteLock` holder. The lock stays held, no further writers can run, and 90s later the `WriteLock-WATCHDOG` fires and aborts. The data is unambiguous: every one of today's 13 `spreadStats-flush` watchdog fires is preceded by a `[BUSY] Uncaught exception` log line at the *same timestamp*. Zero `[WriteLock] 'spreadStats-flush' held lock for ...` lines were emitted — which only fires for >5s holds, so individual batches always finished fast. The watchdog was timing the *post-uncaughtException wedge*, not actual work.

**Fix:** `withWriteLock` now tracks the currently-held task's `done()` callback in a module-level `_activeDone` ref. `_handleFatal`, when the error message contains `SQLITE_*`, force-calls `_activeDone(err)` so the queue can drain instead of wedging until the watchdog. Scoped to SQLite-related errors so a generic regression in unrelated code doesn't falsely free the lock. The watchdog itself stays in place as a last-resort safety net for genuine silent hangs.

**Files:** `deploy_saas.py` — adds `let _activeDone = null` next to the writeLock state, sets/clears it inside `withWriteLock`, and adds a 6-line release block in `_handleFatal`.

### 2026-04-29 — SQLITE_BUSY restart-loop fix (commit `a82492e`)

After yesterday's evening session ended with `NRestarts=0`, the service had cycled to `NRestarts=63` over the following 22 hours — averaging ~3 restarts per hour. Eight FATAL aborts in the last 6 hours alone, all with the message `"SQLite state is corrupt — aborting for clean systemd restart"`.

**Root cause:** the `_isSqliteFatal()` classifier from yesterday's Tier 4 work treated `SQLITE_BUSY` and `SQLITE_LOCKED` as corruption indicators. They aren't — they're transient lock-contention errors. The trigger pattern: `spreadStats-flush` (hourly aggregation on `statsDb`) holds the JS write-lock for 30-45s, NATS price events queue up to 3000-4000 entries behind it, ONE async `stmt.run` callback hits `SQLITE_BUSY` at the SQLite level (cross-connection contention between `db` and `statsDb` writing to the same file, since they don't share node-sqlite3's queue), bubbles up to `uncaughtException`, `_handleFatal` aborts. systemd restarts → fresh `priceRefCache-init` rebuilds under the same load → queue rebuilds → BUSY again → abort again. Self-perpetuating.

**Fix:** `SQLITE_BUSY` and `SQLITE_LOCKED` removed from the fatal set. They now log as `[BUSY] ... non-fatal, resetting flags` and let node-sqlite3's `busy_timeout` (30s on each connection) do its retry job. `SQLITE_CORRUPT`, `SQLITE_IOERR`, `SQLITE_MISUSE` remain fatal as designed. Flag resets (`scanInProgress`, `statsRunning`, `analyticsRunning`, `dbBusy`) still happen so a noisy BUSY doesn't leave a flag stuck. The per-tx 90s watchdog from the original Tier 4 work is unchanged — it still catches genuine wedges (silent hangs that don't throw any error).

**Verification post-deploy** (server version `20260429-162456`, deployed 18:25 UTC):
- 23 minutes uptime, **0 restarts** through the first full spreadStats-flush + NATS catch-up cycle.
- Peak queue depth **3954** during that cycle — same load that caused 8 FATAL aborts in the prior 6 hours — drained cleanly to 0 in ~3 minutes. spreadStats wrote 471,568 rows and finished without erroring.
- Memory peak 394 MB (vs 525-617 MB pre-deploy under the abort-rebuild churn). priceRefCache-incr held the lock 20.5s (vs 33-60s pre-deploy when restart loops were constantly rebuilding cache from scratch).
- Old code's last FATAL was at 18:17:18 UTC, three minutes before the deploy that replaced it.

**Side effect — explains missing morning routine reports.** This morning's 6 daily cloud routines (04:00–05:15 UTC) all fired but landed zero rows in `routine_reports`. The VPS was actively in the FATAL-abort cycle during that window (queue-depth bursts of 4019 at 03:46, 4010+ at 04:25, etc.), so agent POSTs hit connection errors that the silent `try/except urllib.request.urlopen` swallowed. With the wedge fixed, tomorrow's 04:00 UTC cycle is the verification — reports should land.

**Files:** `deploy_saas.py` (one ~30-line change to `_isSqliteFatal` and `_handleFatal` at lines 6131–6155, plus updated comment block), `sw.js` (cache bump v90 → v91 via deploy auto-bump). Single commit.

### 2026-04-28 — Guild Syphon Check tab

New self-service feature for guild officers. Paste your in-game **Siphoned Energy log** into a textarea, click **Run Check**, and the page parses the TSV (date / player / reason / amount), aggregates per-player totals, and flags everyone who withdrew more than they deposited. Output: a summary card row (date range, transactions, players, totals), a red **Owe syphon** table sorted by deficit, a collapsible **clean** section, and a Discord-ready pre-formatted summary (one click to copy). Pure client-side — no backend, no auth, no packet capture. Persists last paste in localStorage so a refresh doesn't lose work. Min-deficit filter for ignoring trivial -10 entries. Works for any guild's syphon log out of the box. Source: `app.js` (`parseSyphonLog`, `renderSyphonResults`, `buildSyphonDiscordMessage`), `index.html` `pane-syphon`, CSS `.syphon-table`/`.syphon-card`.

### 2026-04-28 — Stop-the-bleeding sweep: 14 fixes from production audit

After a deep production audit identified the cause of declining users — multiple invisible regressions accumulating over weeks — this batch ships the targeted fixes. **Headline finding**: the public site has been showing a 15-day-old red banner saying "Radiant Wilds update broke most data tools" to every visitor since 2026-04-13, linking to v0.6.3 (a Go client release we no longer ship). Every new visitor read this as a current outage and bounced. Combined with [other findings documented separately](https://github.com/coldtouch/coldtouch-market-analyzer): 36+ hours of cumulative downtime over 5 SQLITE_BUSY incidents this month, Live Flips silent for 16 days from a NATS port typo (4222 vs 24222), CORS hardcoded to coldtouch.github.io blocking auth on the primary albionaitool.xyz domain for 27 days, junk-listing pollution in `price_analytics` showing T6_RUNE at 21M silver and T4_BAG at 1.9M, and `transport-routes` historical mode 30s timeouts.

**Backend (`deploy_saas.py`):**
- **News banner auto-stale after 7 days.** The `/api/news` GET endpoint now checks `updatedAt` and silently returns `{active: false}` for any banner older than a week. The April 13 "everything is broken" banner can never poison the front page longer than 7 days again, even if no one updates it.
- **Outlier rejection in price ingestion.** Both `recordSnapshots` and `flushNatsBuffer` now reject any sell or buy price >100× or <0.01× the global price reference for that item. A single typo'd 21M-silver T6 rune listing was poisoning `sma_7d` for affected items.
- **Live Flips silent-drop fix.** `validateFlipPrices` now returns `'unverified'` (not `false`) when AODP returns "listing gone" on one side of a flip — AODP's snapshot frequently lags NATS by minutes on thin order books, so the previous always-drop behavior silenced legitimate flips. `broadcastFlip` now sets `flip.unverified = true` when validation returns the new sentinel; the frontend already badged unverified flips for the AODP-degraded path so the UX is free.
- **Analytics-ema watchdog 90s → 5min.** The `withWriteLock` watchdog from Tier 4 was too aggressive for the legitimately long EMA streaming pass. Per-label timeouts now: `analytics-ema` and `analytics-bulk` get 5 minutes; everything else stays at 90s. This was the root cause of the 26+ hour analytics staleness on April 26-28 — every cycle, the EMA pass tripped the 90s watchdog → process.abort() → systemd restart → 35-min wait → repeat → no analytics rows ever written.
- **Public `/api/health/internal` endpoint.** Returns market cache freshness, analytics + spreadStats run state, write-queue depth + active locks, AODP failure counter, WS client count. Catches silent wedges externally without needing admin auth — UptimeRobot, Better Uptime, etc. can monitor for `analytics.ageSinceLastStartMs > 90 minutes`.
- **transport-routes-live freshness 120 → 30 min default.** Audit found `buy_age` averages of 555 minutes (9 hours) under the 120m cap, while the frontend labelled it "real-time NATS data". 30m default makes "real-time" actually mean real-time. Power users can override `?max_age=` up to 240.
- **`/api/batch-prices` honors `cities` param.** Was previously documented in frontend calls but silently dropped. Now filters the result to the city allowlist, with a 16-city cap.

**Frontend (`app.js`):**
- **Live Flips auth-gate race fix.** `discordUser` is set asynchronously after `/api/me` resolves. New users landing on this tab during the OAuth-return flicker (`?login=success&code=…`) saw the "Login required" gate even though their token was already in localStorage. Now polls for `discordUser` for up to 3s before showing the gate, then re-renders.
- **Trend badge suppression on stale analytics.** `fetchAnalytics()` checks `computed_at` against a 4-hour staleness threshold; stale data renders as `—` with a "Trend data refresh delayed" tooltip instead of a misleading red ▼. Prevents users acting on yesterday's wrong arrow.
- **5 stale `0.055` literals replaced with `(TAX_RATE + SETUP_FEE)`.** Lines 2002 (BM Flipper upgrade-cost), 15689 + 15708 (Craft Runs Portfolio table + total net), and the `crRunCardHTML` inner-card variants. Was undertaxing Craft Runs net P&L by ~15% (4% premium tax + 2.5% setup = 6.5%, not the historical 5.5%).
- **Removed Mounts Database + Community Builds feature cards from About page.** Both tabs were BENCHED in code, but the About page still advertised them — credibility hit when users went looking for them. CLAUDE.md updated to reflect real shipped tab count (22, not 24).

**Service worker (`sw.js`):**
- **Added `itemweights.json` to APP_SHELL.** 411KB hit on every fresh install was previously not cached. CACHE_NAME bumped v82 → v83.

**Go client (`albiondata-client-custom`):**
- **Negative item ID 1-character fix** in `client/event_container_items.go:296` — changed `if slotID == 0` to `if slotID <= 0`. Negative slot IDs in `evAttachItemContainer.SlotMap` are sentinels for reserved/locked slots (tab dividers, premium-locked, hideout-bound), not items in the itemmap. Verified against ao-bin-dumps + 4 community Albion clients (Triky313, MaximMadsen, ao-loot-logger, broadwell-shipping). Resolves the `UNKNOWN_-56`, `UNKNOWN_-59`, ..., `UNKNOWN_-121` chain in Loot Buyer captures. Will ship as v1.3.5 once tagged.

**Documented but NOT shipped this batch (require user action):**
- DELETE polluted price_analytics rows (`DELETE FROM price_analytics WHERE metric IN ('sma_7d','vwap_7d') AND value > 50000000`) — needs SSH.
- Update active news banner via SSH or admin UI POST. (The auto-stale fix means even if you do nothing, the bad banner expires by April 20 + 7 = today, but a fresh value would be cleaner.)
- Pre-aggregate `volume_cache` table to fix `transport-routes` 503s — bigger refactor, deferred. Hidden Historical mode in UI in the meantime if it's hurting users.
- Cloud routine `persist_session: true` toggles via RemoteTrigger — applied separately.

---

### 2026-04-28 — Accountability check: chest log priority over proportional capture math

User reported a contradictory state on a real session: LaboringWolf's row showed `T4_SHOES_LEATHER_ROYAL@3` as **both** ✗ missing AND ✓ verified by chest log. Both flags were operating from independent data sources that could disagree.

**Root cause** — the accountability calculation had two unrelated sources for "did this player deposit this item":
1. The **`verified` flag** read from `chestLogDeposits[name][itemId]` — built from chest log batch entries which DO carry `playerName`. Per-player ground truth.
2. The **`missing` calculation** computed `share = (effectiveQty / totalForItem) * depositedForItem` from `deposited[itemId]`, which was built from **chest CAPTURES** (point-in-time snapshots of the chest contents). The capture has no player attribution at all — it's just an itemId-count map.

Worked example for the bug: 5 effective pickups of T4 Royal Shoes by guild members (one of them LaboringWolf), but the capture snapshot showed only 2 in the chest. The proportional math gave LaboringWolf `share = (1/5) × 2 = 0.4 → round = 0 → missing = 1`. Meanwhile the chest log had a row `playerName: LaboringWolf, T4_SHOES_LEATHER_ROYAL@3, qty 1` proving he actually deposited it.

**Fix:** when `chestLogDeposits[name][itemId] > 0` we now use that count directly as `inChest`, capped at `effectiveQty`. The proportional capture-based math becomes the **fallback** only for items the chest log doesn't cover (no batch selected, or that item not in the selected batches). The chest log is per-player ground truth; the capture is a partial snapshot — we now consult them in that order.

Single-row impact, surgical: 6 lines added, 5 deleted in `app.js` `runAccountabilityCheck`. Trash items still correctly flag as missing (chest log doesn't contain them → proportional fallback → 0 in capture → still missing). Items that previously verified-and-missed simultaneously now verify-and-don't-miss.

---

### 2026-04-28 — Go client v1.3.4: ZvZ perf + NATS connection leak fix

Two zero-behavior-change improvements to the Go client, validated against a real PvP session before tagging.

**ZvZ perf (commit `79c5c4e`)** — five small low-risk edits on the per-packet/per-event hot path that fires hardest during PvP:
- Hoisted the mapstructure decode hook + `reflect.TypeOf` calls from per-call closures inside `decodeParams` to package-level. Previously reallocated the closure value + recreated the reflect types on EVERY decoded event — at 50–200 events/sec during ZvZ that's a meaningful GC source.
- Reuse the `uint8→string` param map via `sync.Pool` instead of `make(map[string]interface{})` per call. This was the dominant per-event allocation source. Cleared between uses with the Go 1.21+ `clear()` builtin.
- Cache the source IPv4 as a `uint32` on the listener. The game server IP is set on session join and effectively never changes — short-circuits `SetServerFromIP` (the `.String()` allocation + albionstate mutex grab) on >99.9% of packets.
- Drop four `log.Tracef`/`log.Trace` calls that fired per packet. Their format-string args (`.String()`, `GetAODataServerID`, `GetAODataIngestBaseURL`) evaluated even when trace logging was disabled, so each packet paid two extra mutex grabs on albionstate for no operational value.
- Replace the per-unreliable-packet `make([]byte, n) + copy` with a slice reslice. Same semantics — drops 4-byte header — without an alloc. Position updates and other unreliable traffic fire constantly during PvP.

**NATS connection leak fix (commit `b81cf6b`)** — `sendMsgToPublic*/Private*Uploaders` rebuilt their entire uploader chain on every dispatched message via `createUploaders()`, which calls `newNATSUploader` (`nats.Connect`, never closed) and/or `newHTTPUploaderPow` (fresh `http.Transport`, no keep-alive). Real costs: NATS path leaked one TCP connection per dispatched message (during market scraping that's hundreds of leaked goroutines/connections per second until process restart); POW path created a fresh `http.Transport` per call defeating HTTP keep-alive so every upload paid a TLS handshake. Fix: `uploaderCache` (`map[string][]uploader`) keyed by resolved target URL string with a small `RWMutex` + double-check pattern so `createUploaders` runs at most once per unique target string across the worker pool. The Public list's placeholder resolves to at most one URL per game-server region the user touches in a session, so the cache stays bounded (typically 1–4 keys).

**Recommended upgrade for any guild member running v1.3.x.** Public release at https://github.com/coldtouch/albiondata-client/releases/tag/v1.3.4.

---

### 2026-04-27 — Item-id mismatch: backend authoritative re-resolution + .txt 11th column

User reported wrong enchant levels appearing on the website (e.g. their Master's Knight Armor .3 displayed as .4). Root cause traced to a stale `itemmap.json` shipped with the upstream Go client they were running (April 11 build): the April 13 game patch shifted ~75% of item IDs by exactly one position, but their itemmap was never regenerated. Their client's `resolveItemName(3506)` returned `T6_ARMOR_PLATE_SET2@4` instead of `@3`, and that wrong string got uploaded via .txt-file upload (no numericId in the format → backend trusted the string).

**Three-layer fix shipped:**

1. **Backend authoritative re-resolution.** `deploy_saas.py` now loads `itemmap.json` at startup into `CANONICAL_ITEMMAP` and applies `resolveCanonicalItemId(numericId, fallback)` at every ingest point:
   - `/api/loot-upload` (TXT path) — reads optional 11th column for numericId
   - WS `loot-event` ingest — uses the `numericId` already in the payload
   - WS `chest-log-batch` ingest — re-resolves each entry's itemId
   - Falls back to the client's string when numericId is missing or unmapped (preserves legacy 10-col TXT files + items added after our last itemmap regen)
   - Logs `[LootUpload] Re-resolved N/M item_ids` per upload so we can monitor the bug's prevalence

2. **`.txt` format extended with optional 11th column = `numeric_id`.** Go client `event_loot.go` writer now appends `;<numeric_id>`. Death-row sentinel writer also extended (numeric_id=0) so column counts stay consistent. Frontend `parseLootLines` reads the new column when present. **Fully backwards-compatible** — old 10-col files still parse (numericId defaults to 0 → no re-resolution → client's string used as-is).

3. **`itemmap.json` shipped to VPS via deploy_saas.py SFTP block.** Added `/opt/albion-saas/itemmap.json` upload alongside backend.js. Regenerate the file by copying from `D:\Coding\albiondata-client-custom\itemmap.json` (which is itself regenerated from ao-bin-dumps after each game patch).

**Net effect:** future loot/chest data uploaded by ANY client (current, stale, or future) is normalized to our canonical mapping. Wrong-enchant pollution stops at the front door. Phase 2 (DB backfill of historical wrong data) is a separate one-shot script — not run yet because most affected rows came from .txt uploads where numeric_id=0 and can't be re-resolved.

### 2026-04-27 — Removed Windows auto-startup from installer

The NSIS installer (`pkg/nsis/albiondata-client.nsi`) was registering a scheduled task with `/SC ONLOGON /RL HIGHEST` that auto-launched the client at every Windows login. User report: this is unwanted — explicit control over when the client runs is preferred (privacy, predictable session captures, no packet-capture overhead during non-game time). Removed the `Exec 'schtasks /Create ...'` line. The uninstaller's matching `schtasks /Delete` is kept so existing installations get cleaned up on uninstall. Existing installs need a one-shot manual cleanup (run as admin): `schtasks /Delete /TN "Albion Data Client" /F`.

---

### 2026-04-27 — Zone names UNSHELVED — found in ao-bin-dumps/cluster/world.xml

**The names were in the bin dumps all along — just in a file we hadn't checked.** Research agent firing turned up `cluster/world.xml` (13MB) which has every cluster element with a `displayname` attribute alongside the `id` we already had. 1423 entries, every numeric zone ID + every named special cluster.

**My earlier hand-curated KNOWN_NAMES guesses were ALL wrong.** Real mapping (verified by grep against world.xml):

| ID | Real name | What I'd guessed |
|---|---|---|
| 0007 | Thetford Market | Bridgewatch ❌ |
| 1002 | Lymhurst Market | Lymhurst ❌ |
| 2002 | (other) | Martlock ❌ |
| 3008 | (other) | Fort Sterling ❌ |
| 4002 | (other) | Thetford ❌ |
| 3013 | (other) | Brecilien ❌ |

The actual royal cities live at 0000 / 1000 / 2000 / 3003 / 3004 / 4000 / 5000. Good thing we shelved before going wider with bad data.

**User's actual ZvZ zones from today's testing now resolve correctly:**
- `3312` → "Battlebrae Plain" (T5 Highland Outland)
- `3348` → "Battlebrae Grassland" (T7 Highland Outland)
- `@HIDEOUT@3312@<UUID>` → "Hideout in Battlebrae Plain"

**Implementation:**
- `tmp_check/generate_zonemap.py` rewritten to parse `world.xml` via regex, extracting every `(id, displayname)` pair. Skips entries with empty/filename-shaped displaynames (none in current dump).
- `zonemap.js` regenerated: 1423 entries, ~52 KB.
- `formatZone()` re-enabled with the lookup logic. Bonus: named clusters like "ARENA-01" also resolve now (→ "Arena1") because they have their own world.xml entries.
- All 4 display sites (death tooltips, missing-item tooltip, rich pickup tooltip) light up automatically — they already called formatZone().

**Verified in browser preview:** 16 test cases (royal cities, user's actual zones, hideouts with known/unknown parents, unknown numerics, named clusters, edge cases) — all green, no console errors.

**Other research agents stopped** — once we found the answer locally, the GitHub repo hunt and packet-opcode investigation became redundant.

---

### 2026-04-27 — Zone-name lookup SHELVED pending real names (RESOLVED — see entry above)

The zonemap feature shipped a few hours ago auto-derived labels from the cluster filenames in `ao-bin-dumps/cluster/` (e.g. `3312_WRL_HL_AUTO_T5_KPR_OUT_Q5.cluster.xml` → `"T5 Highland Keeper Outland Q5"`). User feedback: those derived labels are MORE confusing than the raw IDs. Players don't recognize them as zone identifiers at all and they actively mislead. Better to show raw `"3312"` until we have real human-readable names like `"Bridgewatch"` or `"Holy Lake"`.

**`formatZone()` is now a pass-through.** Returns the raw input verbatim. Display sites (death tooltips, missing-item tooltip, rich pickup tooltip) keep calling it so re-enabling later is one swap. The full lookup logic + 474-entry zonemap.js are preserved in git (commit `9f248dc`) for the moment we have real names to plug in.

**Active research streams** (3 parallel agents firing now):
1. Community zone-name lists on GitHub / Albion data community repos
2. Deeper search of ao-bin-dumps for any name dictionary we missed
3. Packet/protocol investigation — opcodes like `evClusterInfoUpdate`, `opGetClusterMapInfo` may carry display names

When real names land, we update `KNOWN_NAMES` in `tmp_check/generate_zonemap.py` (or replace the whole map source), regenerate `zonemap.js`, and unshelf `formatZone()` by swapping the pass-through body for the lookup logic.

---

### 2026-04-27 — Zone-name lookup: raw cluster IDs → readable labels (SUPERSEDED — see shelving entry above)

The Go client v1.3.1 ships current zone identifiers like `3312` and `3348` for open-world zones (numeric cluster IDs from the game's wire protocol) and `@HIDEOUT@<parentId>@<UUID>` for hideouts. Both are unambiguous but unreadable — nobody recognizes "zone 3312".

**New `zonemap.js`** (474 entries, ~20 KB, auto-generated from `ao-bin-dumps/cluster/*.cluster.xml` filenames). The cluster filename pattern encodes everything we need: `3312_WRL_HL_AUTO_T5_KPR_OUT_Q5.cluster.xml` parses into `{tier:5, biome:Highland, faction:Keeper, region:Outland, quadrant:Q5}` → label `"T5 Highland Keeper Outland Q5"`. Auto-derivation covers the entire open-world map without any hand-curation, and a small KNOWN_NAMES override in the generator handles the 7 royal cities + Brecilien (whose generic filenames don't carry their famous names).

**New `formatZone(raw)` helper** in app.js handles all three identifier shapes:
- `"3312"` → `"T5 Highland Keeper Outland Q5"`
- `"@HIDEOUT@3312@<UUID>"` → `"Hideout in T5 Highland Keeper Outland Q5"`
- `"@HIDEOUT@<unknown>@<UUID>"` → `"Hideout (zone <id>)"` fallback
- `"0007"` → `"Bridgewatch"` (curated)
- `"99999"` (unknown numeric) → `"Zone 99999"` fallback
- `""` → `""`
- `"ARENA-01"` (other formats) → passed through verbatim

**Wired into 4 display sites** that previously showed raw IDs to users:
1. Player-card "died with" preview tooltip (death context summary)
2. Death section header tooltip ("Died at 02:05 in <zone>")
3. Missing-item hover tooltip (`📍 <zone>` line)
4. Rich pickup-detail tooltip (`📍 <zone>` per-pickup line)

Verified in browser preview: 474 entries loaded, all 10 test cases pass, no console errors. Generator script (`tmp_check/generate_zonemap.py`) is rerunnable when ao-bin-dumps updates ship new clusters.

---

### 2026-04-27 — Go client v1.3.1: in-session zone tracking via opChangeCluster

**Root cause confirmed.** The reason the entire 290-event production session had empty `Location` on every loot/death event wasn't the OpJoin field — it was that **opChangeCluster (=35, on-wire 41 after April 2026 +6 shift) was never handled at all.** OpJoin only fires on initial connect; every in-session zone transition went silent. So loot/death events fired in subsequent zones still carried the connect-time location (which was usually empty because the user started the client mid-session, after the OpJoin had already passed).

**Two fixes in v1.3.1:**

- **New `operation_change_cluster.go` handler.** Reads destination from mapstructure index `"0"`. Verified across a hideout → 3312 → 3348 → 3312 → hideout walk-out test: 4 transitions, 3 distinct destination values, all captured correctly. Wired into both raw and shifted branches of `decodeResponse`.
- **OpJoin reverted to `mapstructure:"8"`.** I temporarily switched to `"67"` earlier today based on a misread of the diag data (had confused the player's home/hideout reference at param 67 with their actual location). The 3-zone walk-out test conclusively showed param 8 matches the actual current zone every time, while param 67 stayed pinned to `@HIDEOUT@3312@<UUID>` regardless of where the player was.

**Combined effect:** both handlers now agree on the current zone for every transition. `[ChangeCluster]` and the subsequent OpJoin re-sync log lines now show identical values (no more 4-second clobbering window). LootEvent.Location and DeathEvent.Location will populate correctly for in-session transitions, which means the website's 📍 Zone tooltip on accountability pages will finally render for real ZvZ scenarios.

**Note on impact mitigation:** The existing 5-second post-zone-change invulnerability bubble means death events practically never fire during the 4-second OpJoin clobber window — so the OpJoin race condition was never going to corrupt death zones in practice. Loot pickups in that window were the realistic risk, now fixed.

**Released:** [albiondata-client v1.3.1](https://github.com/coldtouch/albiondata-client/releases/tag/v1.3.1) cut via `git tag v1.3.1 && git push --tags`. GitHub Actions release workflow auto-triggers cross-platform builds.

---

### 2026-04-27 — Device-auth rate limit raised + zone field discovered

**Rate limit bumped 3 → 10 requests per 15 min per IP** on `/api/device/code`. The previous cap was too tight: a user retrying device-auth during normal setup, or troubleshooting a broken auth flow, would burn through 3 attempts in seconds and then be locked out. The Go client previously masked this as a misleading "authorization timed out" — fix landed in the companion Go client commit (server now returns the same JSON shape, but the client surfaces the rate-limit message verbatim instead of timing out on zero-value polling).

**Zone field identified.** The `[ZONE-DIAG]` diagnostic binary built yesterday captured 189 param dumps across multiple OpJoin responses today. The zone identifier is at **mapstructure index 67**, not 8. Format: `@HIDEOUT@<id>@<UUID>` for hideouts, plain UUID for open-world zones. Old index 8 now holds an unrelated numeric string that varies per join. Fix landed in `albiondata-client-custom/client/operation_join.go` (Location mapstructure 8 → 67); will tag v1.3.1 once cleaned up. Result: `Updating player location to @HIDEOUT@3312@…` finally fires with a real value, and downstream the WS-uploaded `LootEvent.Location` and `DeathEvent.Location` will start populating for new captures — which means the 📍 Zone tooltip on accountability pages will render going forward.

---

### 2026-04-27 — Device auth fix: CORS allowlist + redirect query preservation

Device-authorization flow from the Go client was broken for any user on `albionaitool.xyz`. Clicking "Authorize" surfaced a generic "Network error" with no actionable info.

**Three bugs converged:**

- **CORS hardcoded to GitHub Pages only.** [deploy_saas.py:1130](deploy_saas.py:1130) set `cors({ origin: 'https://coldtouch.github.io', ... })`, so any browser origin other than the GitHub Pages mirror got `Access-Control-Allow-Origin: https://coldtouch.github.io` regardless of the real origin. Browser blocked the response, frontend's `catch` reported "Network error." Fix: `ALLOWED_ORIGINS` array gated by an `origin: (origin, cb) => …` callback. Both `coldtouch.github.io` and `albionaitool.xyz` now allowed; same-origin / curl requests (no `Origin` header) pass through.
- **Root redirect stripped query string.** [deploy_saas.py:1273](deploy_saas.py:1273) did `res.redirect('https://coldtouch.github.io/coldtouch-market-analyzer/')` — a flat string, no `req.url`. Visiting `https://albionaitool.xyz/?device=ABC-DEF` redirected to the GitHub Pages root WITHOUT the `?device=` query param, so the auth modal never opened. Fix: extract `?…` from `req.url` and append to the redirect target.
- **Go client console box truncated the auth URL.** [device_auth.go:60](D:/Coding/albiondata-client-custom/client/device_auth.go:60) printed the URL with `%-40s` formatting inside a 46-char box, but the verification URL is ~68 chars (including `?device=ABC-DEF`). Users saw `https://coldtouch.github.io/coldtouch-mar` truncated and couldn't copy the full link. Fix: print the URL on its own line *outside* the box, alongside the code as informational only (the code is already embedded in the URL — no manual entry on the site).

After deploy: confirmed via curl that `Origin: albionaitool.xyz` echoes back as `Access-Control-Allow-Origin: albionaitool.xyz`, `Origin: coldtouch.github.io` echoes back as itself (no regression), and `?device=TEST123` is preserved through the redirect to `https://coldtouch.github.io/coldtouch-market-analyzer/?device=TEST123`. Zone-test exe rebuilt with the cleaner console output.

---

### 2026-04-27 — SQLITE_BUSY Tier 4: single-writer queue + 90s watchdog

The April 25 `process.abort()` handler caught synchronous SQLITE_BUSY errors raised through `uncaughtException`, but it could not catch the actual failure mode that took down PID 489379 today: a transaction that *silently hung* without throwing. The journal stopped at 23:54 CEST. PID stayed alive at 2.9 GB RSS for 10 hours. systemctl reported `active`. Market cache went stale. Zero FATAL log lines. The handler had nothing to fire on.

**Tier 4 ships two interlocking mechanisms:**

- **`withWriteLock(label, fn)`** — a single Promise-queue wrapper that serializes every batch write across both the `db` and `statsDb` connections. SQLite WAL allows concurrent readers but only ONE writer at the file level; when both connections previously called `BEGIN` concurrently, one waited up to 30 s on `busy_timeout`, and if the active tx exceeded 30 s the waiter got `SQLITE_BUSY` — that's the cascade root cause. With this queue, two writers can never both be in `BEGIN/COMMIT` simultaneously, so the contention window doesn't exist.
- **90s per-tx watchdog** — each lock-holder is wrapped in a `setTimeout(90_000)` that calls `process.abort()` if `done()` isn't invoked. Caps any future silent wedge at 90 seconds instead of 10 hours, and unlike `uncaughtException` doesn't require a thrown error to fire.

All 10 batch-write sites were wrapped: `recordSnapshots`, `flushNatsBuffer`, `computeSpreadStats.flushWrites`, `computeAnalytics.flushBulk`, `computeAnalytics` EMA stream, `compactOldData` Tier1→2 + Tier2→3, `backfillHistoricalData.batchInsert`, and both `priceRefCache` initial + incremental builds. Each site preserves its existing per-step error callback + ROLLBACK pattern from Tier 2; the wrap only adds the queue acquire + 90s watchdog around it.

Telemetry: queue depth >5 logs a warning; any single write held >30 s logs a warning on a 30s heartbeat; any write held >5 s logs the elapsed time at completion. These give early-warning visibility before the watchdog fires.

Today's outage recovery: SIGKILL on wedged PID 489379 (32 min CPU consumed, peaked at 10.2 GB memory before settling at 2.9 GB), `systemctl start albion-saas`. Sub-10s recovery to PID 490291.

---

### 2026-04-26 — Accountability tooltip: "Verified by chest log" line

When a slot represents items that the chest log corroborates as deposited (`it.verified === true`), the hover tooltip now shows a green-on-green `✓ Verified by chest log (N/M)` bar between the status banner and the Pickups section. When verification is partial (e.g. chest log shows player deposited 2/4 of a pickup), the line reads `(2/4 of pickup)` instead of `(2/4)`.

When the slot has no chest-log verification, the line is omitted entirely — per the user's "if it is, state; if not, no need to state" rule.

Aggregation: the strip-build loop sums `verifiedQty` across rows in the same `itemId+status` bucket, so a slot representing multiple deposit rows shows the combined count. Encoded only when > 0 to keep the data attribute minimal.

---

### 2026-04-26 — Accountability strip: prominent ✓/✗ badges + rich pickup tooltip

Refinements on the morning's strip-on-header feature:

- **Replaced the small corner status dots with prominent ✓/✗ badges** (top-right, 16px, white glyph on solid status color). Deposited shows a green ✓, missing shows a red ✗, partial shows a yellow ½, lost-on-death shows 💀. Missing icons also gain a soft red glow ring around the icon border so they pull the eye even on a wide card with dozens of slots. Deposited icons get a matching subtle green inset highlight.
- **Hover tooltip enriched with pickup details.** Each slot now carries `data-tip-pickups` (URI-encoded JSON, top 8 + "+N more") and `data-tip-acc-status` (`status|inChest|looted|missing`). The global tooltip builder picks both up and renders a status banner (e.g. `✗ Missing 4 of 4` or `½ Partial 3/5 (2 missing)`) above the existing item info, then a Pickups section with one row per pickup: `HH:MM:SS · LooterName [Guild] · 📍 Zone`. Zone is shown when the Go client v1.3.0+ captured it; older events gracefully omit the line.
- **Source thread-through.** `evsByPlayerItem` now stores `from` (= `looted_from_name`) and `fromGuild` alongside the existing `ts` and `location`, so the tooltip can show whose corpse the items came from — useful for accountability triage when a guildmate's pickups disappear (you can see if they died with the items vs picked them up before a teammate died).

---

### 2026-04-26 — Accountability: status-aware icon strip on player card header

The accountability player cards previously only showed item icons inside the expanded body — to see what a player picked up you had to click the card open. The regular session view (uploaded .txt or live session) shows an icon-strip preview right in the card header, summarizing pickups at a glance. Brought the same strip into accountability with status overlays per item:

- **Green border + ●** — fully deposited
- **Yellow border + ●** — partially deposited
- **Red border + ●** — missing
- **Greyed + dim** — lost on death (mirrors the existing `.ll-preview-died` pattern)
- **Faint red border** — enemy loot (no deposit math)

Icons are aggregated by `itemId + status` (so the same item lost-on-death and surviving stay separated visually) and sorted by total silver value descending — most-valuable hits lead. Hover a slot to get the existing rich tooltip (item name, tier, market value, crafter — the global tooltip system already handled `data-tip-item`). Status corner-dot uses the same colors as the per-row status dots in the expanded card body, so the in-header preview matches the in-row legend exactly.

Verified end-to-end against a real shared session (`loot-events-2026-04-25_22-28-25` with 290 events, 15 player cards, mixed deposit states) — all five status classes render correctly and re-aggregate when the friendly-guild perspective is flipped.

---

### 2026-04-26 — Loot Logger: friendly-guild perspective override

Accountability auto-detected the "primary guild" by picking the guild with the most captured items. When the user's own guild was in the minority of events (e.g. running a small-roster fight near a larger enemy guild), auto-detect picked the wrong side as friendly and the whole accountability math flipped — your guildmates got tagged as enemies and the enemy's deposits were treated as your own.

Added a **Friendly guild** dropdown above the action buttons in the accountability report. Lists every guild seen in the session sorted by item count, with the auto-detected pick marked `(auto)`. Selecting a different guild:
- Persists the override in `localStorage` keyed by `acc-guild-override-<sessionId>` (per-session)
- Clears `primaryAlliance` so guild-only matching kicks in (predictable: only that exact guild is friendly, not its allies)
- Reruns `runAccountabilityCheck()` so `isGuildMember` math, `playerResults` enemy/friendly tagging, the primary-guild banner, and the deaths section all reflect the new perspective

Picking the auto-detected guild (or hitting **Reset**) drops the override and falls back to auto-detect. If a previously-selected guild isn't in the current session (different fight, different roster), the override is silently ignored and auto-detect kicks back in.

---

### 2026-04-26 — Loot Logger session timeline: tooltip dedup

Hovering a session-timeline bar in a loot report rendered TWO tooltip cards stacked at the same screen position. The bar carries both `data-tip-html` (rich death-info card via `initTimelineRichTooltip`) AND `data-tip` (plain text via the global tooltip handler). Both handlers are document-level `mouseover` listeners and both fire on a single hover, each creating its own singleton positioned over the bar.

Fix: the global tooltip handler now skips elements that have `data-tip-html` — those are owned by a dedicated rich-tooltip handler. One-line guard in [app.js:16554](app.js:16554) area. Verified via a synthetic-element test that (a) bars with both attrs render only the rich tooltip, and (b) elements with just `data-tip` (status dots, plain rows) still get the global tooltip as before.

---

### 2026-04-26 — Analytics 7d query: int64 overflow fix

`computeAnalytics` was logging `[Analytics] 7d query FAILED: SQLITE_ERROR: integer overflow` every cycle (first surfaced 2026-04-25 at 19:57). The `SUM((min_sell - max_buy) * (min_sell - max_buy))` term in the 7d aggregate at `deploy_saas.py:5139` overflows int64 when summed across the full 7-day `price_averages` window — a single squared spread on a high-value item is ~10¹⁴, summed across tens of thousands of rows × 168 hours easily blows past `9.2 × 10¹⁸`.

Fix: `CAST(min_sell - max_buy AS REAL)` on one operand promotes the multiplication to double-precision float, which then accumulates safely in the SUM. Variance/stddev downstream loses no meaningful precision since values past 2⁵³ would already be approximate anyway.

The error was cleanly handled by the existing `finalize('7d-err')` path, so no outage — but analytics rows weren't being written each cycle, leaving downstream `price_analytics` data stale.

---

### 2026-04-25 — SQLITE_BUSY wedge: real fix this time (`process.abort()`)

Yesterday's Tier 1 fix logged `[FATAL] SQLite state is corrupt — exiting for clean systemd restart` and called `setTimeout(() => process.exit(1), 500)`. Outage today proved that doesn't actually exit. PID stayed alive for 43 minutes after the FATAL with zero log activity, ports still bound, every HTTP request timing out. Diagnosis: when `SQLITE_BUSY` fires, the event loop is wedged inside the native sqlite3 mutex; `setTimeout` requires a loop tick to fire, and the cleanup hooks `process.exit()` runs also call back into native sqlite code that's blocked on the same lock. Both the timer and the exit hung.

Two fixes:

- **`process.abort()` instead of `process.exit(1)`.** `abort()` raises SIGABRT synchronously — no event-loop tick required, no async cleanup hooks. Systemd catches the SIGABRT exit and restarts within ~5 s. Same change applied to the RSS-watchdog path for consistency.
- **Skip `flushNatsBuffer()` in the SQLite-fatal path.** That helper does `db.serialize(() => db.run('BEGIN TRANSACTION'))` on the locked connection — it was the second wedge step after the FATAL log. RSS-driven exit still flushes (DB likely healthy in that path).
- **`_aborting` re-entrancy guard** so a second `SQLITE_BUSY` arriving while we're already aborting can't double-call `process.abort()`.

Recovery for the live outage: SIGKILL on the wedged PID + `systemctl start albion-saas`. New process came up clean. The `[Analytics] 7d query FAILED: SQLITE_ERROR: integer overflow` that fired 35 min before the FATAL is a separate (cleanly-handled) bug — tracked as a follow-up; not the cause of the wedge.

---

### 2026-04-24 — Player card "Lost" stat

Player cards now show a **Lost** stat alongside Items / Value / Weight when the player died. It's the total market value of items looted off their corpse (using live price reference). Rendered in red (`--loss-red`). Only appears when > 0. Tile carries a hover tooltip explaining that Lost is intentionally separate from Value (which counts pickups only) to avoid double-counting across the session total.

Victim-only players now finally surface useful info: "Items 0 · Lost 1.2M" — previously their card had only Items 0 and no value indication.

---

### 2026-04-24 — Player card "died with" — expansion + .txt upload fix

Follow-up to the earlier player-card "died with" feature. Two issues surfaced when viewing an uploaded .txt file:

- **Older .txt uploads had no `__DEATH__` rows.** The ao-loot-logger upstream format doesn't emit a `__DEATH__` sentinel, and older builds of our Go client didn't either. `buildDeathTimeline` only processed explicit `__DEATH__` rows, so `_llDiedWithByVictim` was empty for those uploads and the died-with section never appeared. Added evidence-based fallback: any `looted_from_name` that carries a guild (mobs/chests don't) and has ≥2 distinct items looted OR is a known player elsewhere in the session gets a synthetic death entry (`inferred: true` flag). The timestamp is the earliest corpse-loot time; killer/equipment left blank. `(inferred)` badge shown in the card header so it's distinguishable from an explicit death.
- **Victim-only players had no card at all.** If a player never looted anything themselves (they only appeared as `looted_from_name`), they weren't in `byPlayer` so no card was rendered — meaning their died-with section had nowhere to live. Added synthetic `byPlayer` entries for every victim in `_llDiedWithByVictim` with a `_victimOnly: true` flag, guild/alliance pulled from the first death record.
- **Expanded card also shows died-with items.** Below the normal pickup rows, players who died get a `💀 Died with (N items)` section with full-width `.ll-item-row.ll-item-died` rows (name / qty / value / weight). Header carries the same death context as the preview-strip tooltip. CSS: new `.ll-died-with-section` + `.ll-died-with-header` + `.ll-died-with-subtitle`.

---

### 2026-04-24 — Player card "died with" preview section

Player cards in loot reports now surface what each player died with. After the normal pickup-icon strip, players who died during the session get a 💀 divider followed by the items looted off their corpse — rendered with reduced opacity (0.55), 55% grayscale filter, and a red border so they read as "lost". Hover shows the full death context: time, zone (from Go client v1.3.0+), killer, and who looted the items ("Died at 2:30:43 AM in Thetford Outskirts — killed by Gank — looted by Bob (2 items)").

Data source is authoritative: items looted off the victim's corpse are captured via `ev.looted_from_name === victim` across the session events, aggregated per victim by `_llDiedWithByVictim`. Handles multiple deaths per session ("Died 3× — last at …") and merges items across deaths. `buildDeathTimeline` now also carries `location` through each death record so the tooltip can report the zone.

Visual styling lives in `.ll-preview-died` + `.ll-preview-died-divider` in style.css. Uses the existing native `title` attribute for hover — no new tooltip infrastructure needed.

---

### 2026-04-24 — SQLITE_BUSY stability overhaul (Tiers 1+2+3+5)

Root-cause fix for the recurring 15-min silent-wedge outages on April 22 + 23. `busy_timeout=30000` alone was insufficient because the `uncaughtException` handler was swallowing `SQLITE_BUSY` from async `stmt.run()` callbacks, leaving `BEGIN TRANSACTION` open on the connection, unfinalized prepared statements, and a cascade of queued writes behind a corrupted state. Memory grew to 11.1 GB RSS and GC stalls froze the event loop (ports stayed bound but HTTP never responded).

Four tiers of fixes landed together:

- **Tier 1 — fatal-error handler:** `uncaughtException` / `unhandledRejection` now detect SQLite state-corrupting errors (`SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_CORRUPT`, `SQLITE_IOERR`, `SQLITE_MISUSE`) and `process.exit(1)` for a clean systemd restart (< 5 s). For unrelated bugs (TypeError, etc.) the old flag-reset recovery behavior stays. Handler now also resets `analyticsRunning` and `dbBusy` (previously only `statsRunning` + `scanInProgress`).
- **Tier 2 — safe batch writes:** every one of the seven batch-write sites (NATS flush, hourly snapshot, spreadstats, analytics bulk, analytics EMA, compaction tier 1→2 and tier 2→3, Charts-API backfill) now uses per-step error callbacks + a `batchErr` accumulator + explicit `ROLLBACK` on any error or `COMMIT` failure. No more orphan transactions, no more unfinalized prepared statements.
- **Tier 3 — smaller batches:** `BATCH` in `recordSnapshots` 5000 → 500, `WRITE_BATCH` in `computeSpreadStats` 500 → 100. Shorter WAL lock windows (target: 10-50 ms per transaction vs. 500-2000 ms before) so concurrent connections don't pile up waiting.
- **Tier 5 — RSS watchdog:** memory log cadence 10 min → 1 min; if RSS crosses 8 GB the process exits cleanly so systemd starts a fresh heap instead of inheriting a pathologically-bloated one. The 2026-04-23 process hit 11.1 GB before SIGTERM, within ~100 MB of OOM/SIGKILL.

**Tier 4** (single-writer JS queue to eliminate cross-connection SQLITE_BUSY entirely) intentionally deferred — higher risk, 100+ line refactor. Revisit if tiers 1-3+5 don't fully stabilize.

---

### 2026-04-23 — Accountability dropdown fixes + Share button on uploads + sw.js fix

- **Loot Logger accountability dropdowns — HTML artifact fix.** The session / capture / chest-log dropdowns were showing literal `<span class="time-ago" data-ts="...">5m ago</span>` text inside each `<option>`. Root cause: `timeAgo()` returns an HTML `<span>` for live-updating bodies, but `<option>` content is plain text and was being passed through `esc()`. Switched all three dropdowns to `_computeTimeAgo()` (the plain-text variant).
- **Loot Logger accountability dropdown — upload grouping.** A `.txt` file uploaded 2 minutes ago containing last-week's combat used to show as "7d ago" in the "Older" group, confusing users into thinking their upload wasn't there. Now session IDs matching `<userId>_upload_<ms>` are grouped + labeled by upload time: `📤 Uploaded 5m ago · events from 7d ago — 500 events · 12 players`. The "Recently uploaded" window is extended from 3 min to 24 h so uploads survive a browser refresh. Duplicate 🆕/⚠ emoji prefixes on each row removed (optgroup label already carries it).
- **Loot Logger report — Share button on uploaded sessions.** Uploading a `.txt` file now shows a `🔗 Share` button in the report's action row alongside `CSV / .txt / JSON / ✓ Accountability`, wired into the existing G4 share infrastructure (`POST /api/loot-session/:id/share` + public viewer). Renders via a placeholder slot that `processLootFiles()` fills once the upload POST returns the `sessionId`; `clearLootUpload()` resets state on drop.
- **sw.js CACHE_NAME bug fix.** The deploy-time auto-bumper's regex captured the opening quote + version number but NOT the closing quote, so its replacement kept appending an extra `'` — after several deploys the file held a syntactically broken `CACHE_NAME = 'coldtouch-v64''''''';`. Reset to `'coldtouch-v65'` and dropped the stray `'` from the replacement template in [deploy_saas.py](deploy_saas.py) so future deploys stay clean.

---

### 2026-04-23 — SQLITE_BUSY hardening + Accountability tooltip + Portfolio craft runs section

- **SQLITE_BUSY hardening:** `readDb` busy_timeout bumped 5s → 30s, matching `db` and `statsDb`. All three connections now wait up to 30 seconds before failing — eliminates SQLITE_BUSY errors on `readDb` during concurrent analytics batch-writes that hold the WAL write lock.
- **Accountability missing-item hover tooltip:** Hovering (or tapping on mobile) a red "Missing" item row in the accountability check now shows a tooltip with who picked it up, at what time(s), and **in which zone (📍 pin)**. Pickup events are collected in Pass 2 of the accountability loop and attached to each item result; the tooltip renders with player name, guild, and up to 4 pickup timestamps with their zone. CSS class `.ll-missing-tooltip` + `.ll-has-tooltip` + `.tt-active` (touch toggle). Applies to accountability result cards only (not the session detail view).
  - **Zone end-to-end plumbing (needs deploy):** Go client v1.3.0 already emits `location` on every `LootEvent` / `DeathEvent`. Backend `loot_events` gains a `location TEXT DEFAULT ''` column via idempotent `ALTER TABLE` migration. Three INSERT paths now persist it: WS live loot, WS live death, and `INSERT INTO loot_events ... SELECT` used by the sessions-merge endpoint. Accountability share SELECT adds `location` to the column list so shared links carry zones too. Frontend `evsByPlayerItem[name][itemId]` now stores `{ts, location}` objects instead of raw timestamps; blank locations (pre-v1.3 events) render without the pin, so old sessions are unaffected.
- **Portfolio — Completed Craft Runs section:** The Portfolio Tracker tab now shows a collapsible "Completed Craft Runs" table (requires login) listing all runs at `status=complete`, with closed date, cost, revenue, net P/L (after 5.5% tax estimate), margin %, and total net across all runs. Fetches live from `/api/craft-runs`. Opens inline below the trade history.

---

### 2026-04-22 — Fixes: Stop-Live-Session save/display + Accountability share chest-log snapshot

- **Stop Live Session now saves + displays.** Clicking Stop on the Loot Logger live session previously just flipped a flag — the user had to click Save separately and then click the session card to view what they captured. Stop now: (a) auto-saves the in-memory events via `/api/loot-session/consolidate` if they weren't already saved, (b) opens the session detail panel and renders the run via `showLiveSession()`. If there are no events or the session is already saved, Stop just stops silently.

- **Accountability share now includes chest-log batches.** When a user creates a share link after running Verify / Merge & Verify, the backend was only snapshotting chest *captures* — not the chest-log *batches* (opcode 157 deposit/withdraw ground truth added in a recent release). Recipients of the share link therefore saw the accountability check rendered without any "verified deposited" badges, because `window._chestLogBatches` was empty on their side.
  - **Schema:** added `chest_logs_json TEXT` column to `accountability_shares` with an idempotent `ALTER TABLE ... ADD COLUMN` migration for existing DBs.
  - **Backend:** `POST /api/accountability/share` now accepts a `chestLogs` array (selected batches from the user's chestlog dropdown, or all loaded batches if they haven't interacted), validates size + entry caps (max 40 batches, 400 entries per batch, 500 KB total JSON), and persists. `GET /api/accountability/public/:token` returns the parsed array as `chestLogs`.
  - **Frontend:** `shareAccountability()` snapshots the relevant batches into the POST body. `_renderPublicAccountabilityView()` restores them into `window._chestLogBatches`, rebuilds the `acc-chestlog-select` dropdown with the shared batches auto-selected, and marks it `userInteracted` so a later `populateAccountabilityDropdowns()` call can't rebuild the indexes out from under the shared view. Banner footer now shows the batch count alongside events + captures.

- **VPS outage recovery.** Backend process was stuck in a `SQLITE_BUSY` chain that the `uncaughtException` handler caught without unblocking the event loop — logs went silent for 22 min while the port kept refusing new reads. Force-killed stuck PID, clean restart via systemd. Site + WS broadcast restored. Follow-up investigation pending on the `statsDb` vs. main `db` write serialization under WAL.

---

### 2026-04-23 — Custom Data Client v1.3.0 — Zone tracking

Feature release of the custom Go data client. Download from the [v1.3.0 GitHub release](https://github.com/coldtouch/albiondata-client/releases/tag/v1.3.0).

**Zone tracking (`albion_state.go`, `operation_join.go`)** — `albionState` gains a `CurrentZone string` field (RWMutex, thread-safe getter/setter). `operationJoinResponse.Process` calls `state.SetCurrentZone(op.Location)` on every zone transition (the same op that already set `LocationId`). Zone is updated atomically before any loot or death events in the new zone can fire.

**LootEvent** — new `Location string json:"location"` field. Populated from `state.GetCurrentZone()` in `eventOtherGrabbedLoot.Process`. Stored in the `loot_events` DB column and returned by all session/accountability API endpoints.

**DeathEvent** — new `Location string json:"location"` field. Populated in both `eventDied.Process` and `eventKilledPlayer.Process`.

**Website (deployed alongside client)** — accountability deaths section now splits into three collapsible categories: 🛡️ Friendly (our members died), 💀 Enemy (we killed them), 👁️ Other (bystanders, collapsed by default). Zone badge `📍 ZoneName` shown on each death card. Missing-item hover tooltip now shows the zone where the pickup happened alongside the timestamp.

---

### 2026-04-22 — Custom Data Client v1.2.0 — ZvZ performance pass

Performance-focused release of the custom Go data client. No feature or behavior changes — every loot, death, and chest event is captured exactly as before. Download from the [v1.2.0 GitHub release](https://github.com/coldtouch/albiondata-client/releases/tag/v1.2.0).

**Loot writer (`event_loot.go`)** — `bufio.Writer` wraps the `.txt` log file; the per-event `file.Sync()` is gone. A background ticker flushes to the kernel every 5 s; `CloseLootFile` drains on shutdown. The VPS relay path is unchanged and remains the authoritative copy for the Loot Logger viewer. Eliminates 50+ fsync syscalls/sec during ZvZ.

**Logging** — per-event `log.Infof` for loot + deaths downgraded to `Debugf`. Synchronous journald writes were stalling the event goroutine at 100+ events/sec. New 30-second aggregated Info summary: *"Captured N loot event(s) and M death(s) in the last 30s"*. Lock-free `atomic.Uint64` counters.

**VPS relay (`vps_relay.go`)** — new `buildRelayMessage(type, data)` helper uses a `sync.Pool[*bytes.Buffer]` + `json.Encoder` (stdlib's internal `encodeState` pool kicks in) instead of allocating a fresh `map[string]interface{}` + `bytes.Buffer` per call. All six `Send*` helpers converted. `connected` is now `atomic.Bool` so the disconnected fast-path skips mutex contention. Auth timeout uses a reusable `*time.Timer + defer Stop()` instead of `time.After`, closing a per-reconnect timer leak.

**WebSocket broadcast (`dispatcher.go`)** — the `{"topic":...,"data":...}` envelope is built into a pre-sized `[]byte` with `append` instead of three string concatenations per send. 1 allocation instead of 3.

**GUID construction (`operation_container_open.go`)** — three hand-rolled `fmt.Sprintf("%02x", byte(b))` loops replaced with a shared `guidHex()` helper using `encoding/hex`. Cuts 16+ allocations per container open to one small `[]byte`.

**Vault info parsing (`event_vault_info.go`)** — `names`, `icons`, `guids`, `vi.Tabs` slices preallocated to their final length instead of growing via append.

**Estimated combined impact during sustained 100+ event/sec ZvZ phases**: ~30–50% CPU reduction, ~80% disk-I/O latency reduction on the loot writer, ~20–30% GC pause reduction. No durability regression — the local `.txt` may lose up to 5 s of buffered bytes on an unclean process crash, but the VPS relay has the same events in real time and the Loot Logger upload path is unchanged.

---

### 2026-04-22 — Full security audit remediation + UX polish

**17 findings fixed** from FULL_AUDIT_2026-04-22.md.

**CRITICAL**
- **SEC-C1: JWT never in URL.** Discord OAuth callback now issues a one-time exchange code (60s TTL, `crypto.randomBytes(16)`) stored in server memory. Redirect contains `?code=` only. Frontend calls `POST /api/auth/exchange`, gets the JWT, stores it in localStorage, strips the param from the URL — token never reaches browser history or server logs.

**HIGH**
- **SEC-H1: Transport-routes-live.** Added `transportLiveLimiter` (5 req/min) and 30s server-side result cache — the O(n²) join is no longer computed on every unauthenticated hit.
- **SEC-H2: Health endpoints stripped.** `GET /health` and `GET /healthz` now return `{"status":"ok"}` only. Full diagnostics (uptime, DB sizes, job timings, VPS stats) moved to `GET /api/admin/health` behind JWT auth.
- **SEC-H3: Unbounded deviceCodes map.** Added `deviceCodeLimiter` (3 per 15 min per IP) on `POST /api/device/code` and a hard cap of 200 active entries.
- **SEC-H4: Password reset token in URL.** Frontend `?reset=` param handler added (`_handlePasswordResetParam()`). Reads the token, immediately strips it from the URL, opens a Reset Password modal that POSTs `{ token, newPassword }` to the backend.

**MEDIUM**
- **SEC-M1: Email HTML injection.** `escHtml()` helper added; username is now escaped before insertion into HTML email templates.
- **SEC-M2: WS IP spoofing via x-forwarded-for.** IP extraction now splits on comma and takes the first entry.
- **SEC-M3: Hardcoded admin Discord ID.** Extracted to `ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID || '...'` constant.
- **SEC-M4: SRI on Chart.js CDN.** `chart.js@4.4.9` tag now has `integrity="sha384-..."` + `crossorigin="anonymous"`.
- **SEC-M5: Weak password policy.** Registration and password-change endpoints reject passwords missing at least one letter or one digit. UI placeholder updated.
- **FEAT-M1: Loot upload cap.** Loot file uploads now reject payloads > 5,000 lines or > 2 MB.

**LOW / DevOps / Code**
- **UX-3: Login rate limiter.** `loginLimiter` (10 per 15 min) was referenced but never defined — definition added.
- **SEC-L2 + DO-1: Auto SW version bump.** `deploy_saas.py` now increments `sw.js` `CACHE_NAME` on every deploy so stale assets are always purged.
- **CODE-L1/L2: Go strings package.** `device_auth.go` `writeConfigFile` rewritten with stdlib `strings.Split/ReplaceAll/TrimSpace/HasPrefix/Join`; three hand-rolled helpers removed.
- **CODE-L3: Toast callback registry.** `showConfirm`/`showPrompt` replaced inline function serialization with `_toastCallbacks` ID map — closes XSS vector from arbitrary content reaching `onclick` strings.
- **UX-4: Toast stack cap.** Confirm/prompt toasts capped at `MAX_VISIBLE_TOASTS` (5).
- **UX-1: Offline indicator.** Persistent banner on `window offline`; success toast on `window online`.
- **UX-2: Tab titles.** `document.title` updated on every tab switch (e.g. "Market Flipping — Albion Market Analyzer").

---

### 2026-04-22 — UI polish: header, timers, empty states, tab titles, footer, profile pill

- **Header shrunk** — title reduced to ~60% of previous size; SEO keyword line hidden (kept in DOM for crawlers). Saves ~45 px of vertical space.
- **Timers moved to status bar** — Daily Reset & Monthly countdown now inline in the top bar ("Daily: 21h 30m • Monthly: 213h") instead of the floating bottom-right widget. Removed the widget entirely.
- **Dynamic browser tab title** — title updates to reflect the active tab: "Market Flipping — Coldtouch Market Analyzer", etc.
- **Footer sticks to bottom** — body is now a flex column with `flex:1` on `<main>`, so footer always anchors to the viewport bottom or below content (whichever is lower).
- **Craft Runs empty state** — runs with no transactions now show "0" for cost/revenue and "—" for Net P&L instead of the confusing "— / — / +— (—%)" broken look. Phase emoji strip made slightly larger (1rem → readable on small screens).
- **Market Flipping empty state** — shows "Click Scan Markets to find profitable flips" placeholder instead of blank results area on first load.
- **Loot logger restore banner** — auto-dismisses after 30 seconds; message shortened and less visually loud.
- **Crafter profile pill collapse** — on first visit shows full "No profile — click to create" CTA; on subsequent visits collapses to the 🧑‍🔧 icon with a tooltip, reducing persistent yellow noise.

---

### 2026-04-21 — Outage recovery: analytics rewrite + read-path isolation + craft-runs render fix

**Production outage.** The live site was returning HTTP 000 (connection timeout) for ~12 hours. Node was pinned at 97% of one core the entire time. Root cause: the scheduled analytics job's EMA phase ran 1,700 per-batch SQL queries that each did a full-ish scan of `price_averages` (6.5 GB). Each batch took ~1 s, total ~22 min — over the 25-min "stuck flag" reset threshold. Reset fired, spawned a new analytics run, but the old run's `setTimeout` chain kept firing batches in the background. Over 12 hours, 20+ overlapping EMA chains accumulated, saturated node's event loop, and locked up accept queues. Users saw connection timeouts.

**Analytics rewrite (backend).** Two fixes landed together:

- **Generation token.** Every `computeAnalytics` run captures a `myGen = ++analyticsGeneration` in closure. Every async callback checks `isStale()` before doing work; `finalize()` only clears the running flag if generation still matches. Stuck-flag reset now *also* bumps the generation, so stale callbacks from the old run see `isStale() === true` and abort silently — no more accumulating overlaps.
- **Single-pass EMA.** Replaced the 1,700-query batch loop with one ordered `statsDb.each()` that streams `price_averages` rows in `(item_id, city, quality, period_start)` order. EMA is computed incrementally per combo as rows stream, buffered, and flushed once at the end. A new composite index `idx_pa_ema_stream` covers the ORDER BY so SQLite walks the index without an external sort. Dry-run on production data: 11.4 M rows → 176 K combos in 178 s. The old version never completed in 30+ min.

First scheduled cycle after deploy logged the success signal that had never fired before: `[Analytics] Finalized (ok). Total time: 504s` (8 m 24 s end-to-end, bulk + stream + flush).

**Collateral fixes.**

- **`db` busy_timeout 5 s → 30 s.** During the analytics bulk INSERT, `statsDb` holds the write lock for ~13 s. Any `db.run()` from the market scan that landed mid-flush used to hit the 5 s timeout and surface as `[FATAL] Uncaught exception: SQLITE_BUSY` every log cycle. Bumping to 30 s lets writes wait through.
- **Read-path isolation.** Authenticated user-read endpoints (`/api/craft-runs`, `/api/loot-tabs`, `/api/loot-tab/:id`, `/api/loot-session/:sessionId`, `/api/alerts`, `/api/capture-token`, `/api/public/loot-session/:token`, `/api/spread-stats`, `/api/spread-stats/top`, `/api/transport-routes`) previously used the main `db` connection. `node-sqlite3` serialises all ops per connection — a SELECT queued behind a waiting write stalls until the write either commits or times out. Moved them to the existing `readDb` (OPEN_READONLY, dedicated connection) so they bypass the write queue entirely. Reads now return in <200 ms even while analytics holds the write lock.

**Craft-runs "network error" (frontend).** User-reported. Turned out to be two separate bugs compounding: the serial-queue stall above *plus* a JavaScript `ReferenceError: fmtSilver is not defined` thrown inside `crRunCardHTML` at the exact moment the fetched 200 OK response tried to render. The broad `catch {}` in `initCraftRunsTab` swallowed the ReferenceError and showed the generic *"Could not reach server. Check your connection."* message — making a pure frontend bug look like a backend outage. Replaced 8 `fmtSilver(...)` calls with `formatSilver(...)` (the real function name) and 1 `fmtNum(n)` with `Number(n || 0).toLocaleString()`. Service worker bumped to v55 so clients pick up the fix.

---

### 2026-04-21 — Accountability audit pass: session time window + dedupe + special-item filter

**Chest-log selector bug (user-reported).** Chips showed at the top but the selector below the Run Check button was empty or blank. Two root causes:

1. Each in-game chest-log viewing produces **two** batches (deposits + withdrawals), so the selector needed to fit multiple rows. The select had `min-height: 3.5rem` (~56 px, ~2 rows). Increased to `min-height: 6rem` + explicit `size="5"`.
2. User had to Ctrl-click to multi-select — non-discoverable. Now **auto-selects all batches on render** until the user manually interacts with the select (then it preserves their choices).

**Date cross-check (user-reported).** In-game chest logs retain ~4 weeks of history. Previously every deposit in that window counted toward verification, even ones from weeks ago. Now `runAccountabilityCheck` computes the session's actual time window from loot-event timestamps and filters chest-log entries to `[sessionStart - 1h, sessionEnd + 24h]`. Entries outside drop out of the verification math; the count is surfaced in the verify banner as *"N deposits outside window dropped"* with the exact date range shown.

**Loot-logger audit.** Extracted `sanitizeLootEvents(events)` as the one-stop cleanup pass used by both `runAccountabilityCheck` and `renderLootSessionEvents`. Does:

- Normalize `UNKNOWN_<n>` → real string IDs (via `NUMERIC_ITEM_MAP`)
- Dedupe on `(ts, looter, item, victim, qty)` matching backend's UNIQUE INDEX — prevents double-counting from old DB rows + WS-reconnect replays
- Drop events with missing `item_id` (protocol quirk — would create a phantom `""` key in the player→items map otherwise)
- Drop special/internal items: `SILVER`, `GOLD`, `FAME_CREDIT`, `FAME_CREDIT_PREMIUM`, `FACTION_TOKEN`, `SILVER_POUCH`, `GOLD_POUCH`, `TOME_OF_INSIGHT`, `SEASONAL_TOKEN`. Go client already skips silver via `IsSilver`, but `resolveItemName` returns string names for negative IDs — defensive belt-and-suspenders filter at the JS layer

Verified end-to-end: Alice picked up ×3 T4_RUNE + a duplicate event of the same + a SILVER pickup. After sanitize she shows ×3 T4_RUNE only (not ×6), no SILVER row. Chest log contained her deposit (in window) + a 4-week-old deposit from a different player (out of window) — only the in-window deposit counted, banner reports 1 dropped.

---

### 2026-04-21 — Deaths section: split friendly vs enemy, collapse enemy kills

74-death sessions (ZvZ) made the Accountability view unreadable — one flat list of death rows scrolled forever. Redesign:

- **Deaths section body** now splits into two `<details>` sub-groups:
  - **🛡️ Friendly deaths** — auto-expanded. Sorted by estimated silver lost. Header shows total value at risk for regear.
  - **💀 Enemy kills** — collapsed by default with "click to expand" hint on the right. Sorted by silver taken. Irrelevant to regear but kept for audit.
- Sub-group headers show count badge + silver total at a glance.
- Rows within each sub-group keep the existing per-looter grouping + item rows from the prior redesign.

Also fixed a latent bug — the `__live__` session event mapping was stripping `looted_from_guild` and `looted_from_alliance`, which broke the alliance-aware friendly detection for live sessions (everything rendered as "enemy"). Now preserved.

---

### 2026-04-21 — Death attribution via pickup timestamps + chest-log permission note

**Death-attribution rewrite.** Old logic only marked items as "lost on death" when another tracked player looted them off the corpse — this under-counted losses any time the victim died out of range of all tracked looters, or when enemies out of range did the looting.

**New logic:** if a player died at time T, every item they picked up BEFORE T is lost on death. Supports multiple deaths per player (pickups between two deaths get attributed to the next one). Post-death pickups still count toward "should have deposited". Implemented as a two-pass scan:

1. Pass 1: collect `deathTimesByPlayer[name] = [sortedTs...]` from all `__DEATH__` events
2. Pass 2: for each pickup, if `deathTimesByPlayer[name]` contains any timestamp later than the pickup's, the item is lost

Test case: Alice picks up ×3 Rune (t=0), ×2 Soul (t=10), dies at t=20, picks up ×5 Meal Stew (t=30). Result: Rune & Soul flagged "Lost on Death" (red row); Meal Stew counts as Deposited. Bob (never died) is unaffected.

The live-session event-object shape gained `timestamp`, `looted_by_alliance`, `looted_from_name` fields (previously stripped during the `__live__` mapping), needed for the timestamp window + alliance-aware friendly detection.

**Chest Log Captures permission note.** The card now warns that viewing chest logs requires the **View Chest Logs** permission on your guild role (typically Officer+). Members without it won't see a Log tab in the chest UI — nothing the website can fix.

---

### 2026-04-21 — Accountability: chest-log cross-check with ✓ verified badges

Existing accountability had two data sources — pickups tracked by the Go client and snapshots of chest tab contents. Attribution was **inferred** proportionally: if total pickups matched chest quantities, the math blamed whoever picked up the most. This missed deposits by the local player (protocol doesn't broadcast own pickups) and over-attributed missing items when multiple guild members touched the same chest.

**New: chest log capture** — the Go client now decodes opcode 157 (`opGetChestLogs`, +6 shift in the April 2026 build), which streams the in-game chest **Log tab** to the client whenever a player views it. Each entry is `(player, item, quality, qty, timestamp, action)`. Deposit vs withdraw isn't in the response body — it's inferred from the REQUEST's param 6 via Photon invocation-counter pairing (filter `1` = withdraw, filter `28` = deposit, confirmed against a mixed-direction capture).

**New UX:**

- New **Chest Log Captures** card in the Accountability tab (parallel to Chest Captures) with Start Capturing / Reset + chip list of received batches (📥 deposit / 📤 withdraw, entry counts, time-ago).
- New selector above Run Check lets user pick which batches to merge.
- New **🔗 Merge & Verify** button (auto-selects all batches if none picked). Cross-checks each player's pickup events against chest-log deposit records keyed by `(player, itemId)`.
- **Verified items get a green ring on the icon + ✓ badge next to the name** with hover tooltip: `"Verified: chest log shows {player} deposited {qty} of this item"`. Partially verified (log qty < picked up) shows a yellow ring.
- **Verify banner** above the summary strip reports `N batches · M deposit records` and counts fully vs partially verified rows.

**Full-stack transport:**

- Go client: `SendChestLogBatch` via existing WS relay.
- Backend: `chest-log-batch` WS handler stores per-user batches in `clientChestLogs`, forwards to user's browser sessions in real-time. New `GET /api/chest-logs` endpoint + auto-dispatch pending batches on browser connect. 1h auto-eviction.
- Frontend: `_ingestChestLogBatch` handles both live messages and the dispatch-on-connect batch list.

**Important scope note:** chest log is a **verification layer, not a replacement**. It only tells us what was deposited/withdrawn from the chest — it can't see pickups in the field. The existing loot-client pipeline remains the source of truth for "who picked up what". The merge highlights rows where both sources agree; the absence of a verification badge isn't proof of theft, just absence of corroboration.

---

### 2026-04-21 — Deaths: per-looter grouping with readable item rows

**Complaint:** expanded death cards in the accountability deaths section were an anonymous grid of 36px icons — you had to hover each one to learn what was looted. With a ZvZ death (8+ items, multiple looters), the whole row was unreadable.

**New layout — grouped by looter, one item per line:**

```
RECOVERED BY 2 LOOTERS · 13 ITEMS · 150k
┌ MorganNoir [Saggin]                           11 items · 120k ─┐
│ [icon] Master's Ursine Maulers .3          ×1        80k       │
│ [icon] Adept's Rune                        ×5        15k       │
│ [icon] Minor Healing Potion                ×3         3k       │
└─────────────────────────────────────────────────────────────────┘
┌ Georgekalavr [Saggin]                           2 items · 30k ─┐
│ [icon] Master's Stalker Shoes .2           ×1        27k       │
│ [icon] T6 Revive Potion                    ×1         3k       │
└─────────────────────────────────────────────────────────────────┘
```

- Each looter's pile is a distinct card; items within are sorted by silver value desc
- Stackables collapse into a single row with `×N` qty badge
- Worn-at-death moved into its own collapsible `<details>` (auto-open for ≤4 pieces)
- Empty-range deaths get a clean "No items recovered in tracked range" state
- Icon row → grid layout with name, qty, silver. Mobile drops the value column but keeps name + qty

CSS additions in `style.css`: `.ll-death-looter-group`, `.ll-death-looter-header`, `.ll-death-item-row`, `.ll-death-equipment-group` and friends. Verified against the friend's 74-death CTA share — looter groups render correctly, item names show inline without hover.

---

### 2026-04-21 — Accountability: recover item names when Go client ships without itemmap

**Bug:** a friend ran a CTA and shared the accountability report — every item rendered as "Unknown 1954", "Unknown 2409", "Unknown 9090"... 651 events, all unusable. Regear was impossible.

**Root cause:** the Go client resolves numeric item IDs via a companion `itemmap.json` file placed next to the binary. If that file is missing or stale (friend's case), `resolveItemName` falls back to `UNKNOWN_<numericID>` — so every loot event streamed to the VPS carries `item_id: "UNKNOWN_1954"` instead of `"T4_RUNE"`. The frontend's `getFriendlyName` has no way to recover from that, so the UI shows "Unknown 1954".

**Fix — frontend recovers numeric IDs without waiting for client re-install:**

- Added [itemmap.json](itemmap.json) to the website (11,175 numeric → string-ID mappings — same file the Go client uses).
- `loadData()` now fetches it alongside `items.json` / `recipes.json` into a `NUMERIC_ITEM_MAP` global.
- New `rewriteUnknownItemId(itemId, numericId)` helper: if `item_id` starts with `UNKNOWN_` and we have the numeric (either from the event payload or parsed out of the suffix), map it back to the real string ID. Falls through safely when the numeric isn't in our map.
- Normalization applied at every event ingestion point so the rest of the rendering pipeline works unchanged:
  - `runAccountabilityCheck` — normalizes after fetching session events (all three sources: `__live__`, `__shared__`, and the authenticated `/api/loot-session/:id` fetch).
  - `_pushLiveEvent` — recovers IDs on every WebSocket loot event.
  - `msg.type === 'chest-capture'` handler — recovers nested `items[].itemId` before the non-tradeable cosmetic filter runs (important: otherwise mapped items like T4_RUNE would be lost to the `UNKNOWN_` prefix filter).
  - `_renderPublicAccountabilityView` — normalizes shared captures as they're injected.

Verified against the friend's actual share link ([accShare=8WqBnRjy...](https://coldtouch.github.io/coldtouch-market-analyzer/?accShare=8WqBnRjy322hvOTr7gxPvCdXDG3TCdVz)): all 651 events resolved, 0 `UNKNOWN_*` left, 429 item rows render real names ("Battle Memento", "Grandmaster's Bag .1", "Major Gigantify Potion", "Grandmaster's Hellion Jacket .2"...). Works even for viewers who never ran the Go client themselves.

---

### 2026-04-20 — Loot Buyer: multi-tab select + combine

Each chest tab was a separate card — analysing a bulk purchase that spanned multiple tabs meant eyeballing them one by one. Now every capture card has a checkbox; ticking 2+ reveals a sticky combine bar with a live `N tabs · M item lines · X total qty · Y kg` summary. Click **🔗 Combine & Analyze** and we merge:

- Stackables by `(itemId, quality, enchantment)` — quantities sum
- Equipment stays separate (each instance is unique by crafter / enchant / quality)
- Every merged line gets a `_sourceTab` so downstream UI can show which tab contributed it
- Synthetic capture replaces `lootSelectedCapture` so Phase 1 evaluate / Phase 2 sell plan / Phase 3 track all work unchanged

Removing a capture clears the multi-select set (safer than trying to re-index after a shift).

---

### 2026-04-20 — Loot Buyer: filter account-bound cosmetics (ghost Unicorn skin fix)

**Bug:** chest captures sometimes included account-bound cosmetic items that aren't physically in the tab — most visible case was `UNIQUE_UNLOCK_SKIN_HORSE_UNICORN_WHITE_TELLAFRIEND` (Riding Horse Skin: Unicorn, a Tell-a-Friend recruiter reward) appearing in a personal "sell" tab in Fort Sterling even though the player never put it there. Symptom was reproducible on rescan.

**Root cause:** The Go client's `globalItemCache` is populated by every `NewSimpleItem`/`NewEquipmentItem`/etc. event the game sends — including events for account-bound items (mount skin unlocks, avatars, TELLAFRIEND rewards) that are always in awareness. When the game sends `evAttachItemContainer` with the tab's slot map, some of those slot IDs collide with cached account-bound items and get pulled into the capture.

**Fix — defensive filter at two layers:**

- **Go client** (`client/itemmap.go`, `client/event_container_items.go`): new `IsNonTradeableItem(itemName)` that returns true for `UNIQUE_UNLOCK_*`, `SKIN_*`, `UNIQUE_AVATAR*`, `UNIQUE_HIDEOUT*`, `UNKNOWN_*`, and any item containing `_TELLAFRIEND`. `BuildCaptureFromSlots` now skips these and logs each filtered item at Info level; capture summary reports a new `filtered` count.
- **Frontend** (`app.js`): matching `isNonTradeableItemId(itemId)` applied in the WS `chest-capture` handler before pushing to `window._chestCaptures` — gives immediate relief even if the user hasn't rebuilt the Go client.

Tradeable items (ores, bars, weapons, armor, regular mounts including Mammoths and Ox) are unaffected.

---

### 2026-04-20 — Craft Runs: Tab Scan linking + Portfolio sync + Refining Planner

**Tab Scan Linking (frontend for existing `POST /api/craft-runs/:id/scan`)**

- New **📦 From Scan** button in the run detail toolbar (all statuses except `complete`).
- Capture-picker modal lists every chest capture in memory from the custom client: tab name, vault type, item-line count, total qty, time ago.
- User picks a capture + enters total silver paid + allocation method (`equal_split` by qty, or `by_market_value`).
- Each item becomes a `tab_scan`-sourced BUY transaction; run `total_cost` increments by the paid amount.
- Submit disabled until both a capture is selected and paid > 0.
- Escape closes the scan modal (added to `modalMap`).

**Portfolio Integration**

- New **📊 Sync to Portfolio** button (visible when run has ≥1 transaction).
- Pushes `buy` + `sell` transactions into `localStorage['albion_portfolio']`, tagged `_craftRunId` + `_source:'craft_run'` + `_craftRunName`.
- Re-sync is idempotent — prior entries for the same run id are removed before new ones insert.
- Internal pipeline steps (`refine_in`/`refine_out`/`craft_in`/`craft_out`) skipped — they're run-internal, not market transactions.
- Auto-refreshes Portfolio view if user is on that tab.

**Refining Planner**

- Collapsible helper at the top of the Craft Runs tab, toggled by **⚒️ Refine Planner**.
- Inputs: material (Ore/Wood/Fiber/Hide/Rock), raw qty, tier (T2-T8), Focus, Hideout, PL (0-8), Core % (0-30).
- Output: best royal city (e.g. Ore → Thetford +40%) OR hideout mode (15% base + PL×2% + core), refined product name, RRR %, expected output = `floor(qty / (1 − RRR))`, materials saved.
- Live recalc on every input change via existing `calculateRRR()` helper.
- Formula footer explains the math.

**Backend**: no changes — all three features are frontend-only consumers of existing endpoints.

---

### 2026-04-20 — Craft Runs: full buy→refine→craft→sell pipeline tracker

**New tab: "Craft Runs" (Trading group)**

- **Run list**: cards showing status badge (Buying / Refining / Crafting / Hauling / Selling / Complete), mini emoji flow strip, running cost/revenue/net P&L (after 5.5% tax estimate), creation date, and transaction count.
- **New run form**: run name, optional target item with autocomplete, hideout Power Level (0-8), and Core Bonus % (0-30).
- **Run detail view**:
  - Visual progress bar with emoji icons and filled connector lines for completed steps.
  - P&L dashboard: Total Cost · Revenue · Tax Estimate (5.5%) · Net Profit (with margin %).
  - Full transaction log table: date, type, item, qty, unit price, total (color-coded cost/revenue), city, source.
  - Action buttons: **+ Buy**, **+ Sell**, **+ Craft** open the transaction modal; **→ [Next Status]** advances the run to the next phase.
- **Add Transaction modal**: 6 types (Buy, Refine In, Refine Out, Craft In, Craft Out, Sell) with item name/ID, qty, unit price, and city fields.
- **Delete run** with confirmation dialog; Escape closes the transaction modal.

**Backend: 3 new SQLite tables + 10 API endpoints**

| Table | Purpose |
|-------|---------|
| `craft_runs` | Run header: name, status, target item, hideout settings, cost/revenue totals |
| `craft_run_transactions` | Every buy/refine/craft/sell line with type, item, qty, unit price, city, source |
| `craft_run_scans` | Tab/chest scan records: items JSON, total paid, allocation method |

API endpoints (all JWT-protected except refine/hideout helpers):
- `POST /api/craft-runs` — create
- `GET /api/craft-runs` — list (last 100, with txn count)
- `GET /api/craft-runs/:id` — details with transactions and scans
- `PATCH /api/craft-runs/:id` — update name/status/settings (marks `closed_at` when → complete)
- `DELETE /api/craft-runs/:id` — cascades to transactions and scans
- `POST /api/craft-runs/:id/txn` — add transaction; auto-updates `total_cost`/`total_revenue` on run
- `POST /api/craft-runs/:id/scan` — link a chest scan and split total_paid across items by quantity proportion
- `GET /api/craft-runs/:id/summary` — full P&L breakdown by transaction type
- `GET /api/refine/optimal-city?material_type=ore` — returns optimal city + icon + bonus % for each material
- `GET /api/craft/hideout-bonus?power_level=5&core_bonus=10` — returns total hideout bonus and approximate RRR

**Crafting Profits tab enhancement**

- Added **"Hideout (Black Zone)"** option to the Location Bonus selector.
- When selected, reveals two sub-inputs: **PL (0-8)** and **Core % (0-30)** with a live preview (e.g. "= 27.0% bonus").
- Effective bonus = 15% base + PL × 2% (specialist rate) + core %. Feeds directly into `calculateRRR()`.

---

### 2026-04-20 — Modal scroll fix + comprehensive Escape handler

**Bug fix — Guild Leaderboard (and all tall modals) scroll:**
- **Root cause:** `.modal` CSS had `align-items: center` with no `overflow-y`. When modal content exceeded viewport height (e.g. guild leaderboard with 4 tables), content clipped above and below with no way to scroll — the backdrop blocked background scrolling too.
- **Fix:** `.modal` now uses `align-items: flex-start`, `overflow-y: auto`, `padding: 2rem 1rem`, `box-sizing: border-box`. The modal wrapper itself is the scroll surface; no change needed to `.modal-content`.

**Escape key — expanded from 3 to 11 modals:**
- Previous handler only covered `copy-preview-modal`, `feedback-modal`, and `chart-modal`.
- New `modalMap` array covers all modals: `copy-preview-modal`, `guild-leaderboard-modal`, `session-compare-modal`, `session-merge-modal`, `share-session-modal`, `trip-summary-modal`, `loot-split-modal`, `whitelist-modal`, `feedback-modal`, `chart-modal`, and the dynamic `ll-shortcut-help` modal (created with `createElement`, closed with `.remove()`).

---

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
