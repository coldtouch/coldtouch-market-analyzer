# DISPATCH HANDOFF — Albion (loot accountability) — 2026-06-23

> Self-contained for a cold/cloud (phone) dispatch agent. Read this first.
> Two repos are in play. **Read the repo's `CLAUDE.md` after this file.**
> Owner: Coldtouch. Live site: https://albionaitool.xyz · VPS `5.189.189.71` (root) · systemd `albion-saas` at `/opt/albion-saas`.

## TL;DR — what's where right now
- **Website** `D:\Coding\albion_market_analyzer` (GitHub `coldtouch/coldtouch-market-analyzer`): clean at `e3cb0f0`, **deployed live = SW `coldtouch-v180`**. All the accountability work below is LIVE.
- **Go client** `D:\Coding\albiondata-client-custom` (GitHub `coldtouch/albiondata-client`): HEAD `e3dfad8` + **ONE uncommitted change**: `client/operation_get_chest_logs.go` (the chest-log direction fix). **Not committed — pending in-game verification.** A debug build with the fix is built at `D:\Coding\albiondata-client-custom\albiondata-client-debug.exe`.

## THE ACTIVE TASK — verify + ship the Go client chest-log "direction from sign" fix
**Problem it fixes:** the in-game chest **Log** packet (opcode 157, `operation_get_chest_logs.go`) carries a **signed** quantity in param 3 (positive = deposit, negative = withdraw) — the same signal the game's "Copy to clipboard" shows in its Amount column. The OLD code did `if qty < 1 { qty = 1 }` (discarding the sign) and inferred deposit/withdraw from the request **filter code** (28=deposit, 1=withdraw). That filter only covers the Deposit/Withdraw views; the in-game **"All" view sends a different code → batches came back `filter_unknown` → the website dropped them.** On a real capture, **15 of 21 pages (≈85% of entries) were `filter_unknown` and silently dropped.**

**The fix (already applied, uncommitted):** in `operationGetChestLogsResponse.Process()`, derive direction per row from `op.Quantities[i]` sign, set `Quantity = abs(qty)`, split each page into a **deposit batch + withdraw batch**, and send both with `ActionMappingVerified: true`. Filter code kept for logging only. Result: no more `filter_unknown`, nothing dropped, direction is authoritative. New log line: `[ChestLog] Decoded N entries (... ) — X deposits, Y withdrawals (direction from signed qty)`.

**Steps to finish (do in order):**
1. **In-game verification (user, ~3 min):** run `albiondata-client-debug.exe` (debug baked in), open a guild chest **Log → "All" view**, page through it. Confirm the log shows `X deposits, Y withdrawals` and NO `filter_unknown`, and that website chest-log batches show `📥 deposit` / `📤 withdraw` (never `❔ filter_unknown`).
2. **Commit** `client/operation_get_chest_logs.go` to `coldtouch/albiondata-client` master. Git identity `Coldtouch <coldtouch@users.noreply.github.com>`. (Build with Go first: `export PATH="$PATH:/c/Go/bin" && cd /d/Coding/albiondata-client-custom && go build ./...`)
3. **Cut a RELEASE build** for guildmates (not the debug exe): tag a new version (`git tag -a vX.Y.Z && git push --tags`) → GitHub Actions `tag-release.yml` builds Win/Mac/Linux binaries. Last releases were v1.3.x. Check the current latest tag before bumping.
   - The debug exe has debug logging baked in (the `--debug` flag default was temporarily flipped then reverted — source is clean); a release build uses the normal `--debug=false` default.
4. No website change needed for this — the website already handles `deposit`/`withdraw` batches and counts unverified+verified deposits (see below).

## Website accountability — what's LIVE (v180) and how it now works
All shipped + deployed today. Key behaviors a dispatch agent must know before touching accountability (`app.js`, `runAccountabilityCheck`):
- **Deposit direction:** chest-log deposits are credited even when `actionMappingVerified` is false (commit `44680e0`); the manual paste + the new Go fix both set it true anyway.
- **"Deposited by anyone" is the DEFAULT match mode** (`window._accDepositMode`, default `'anyone'`; toggle `_accToggleDepositMode()` → `'self'`). 'anyone' credits a looted item if it reached the chest by ANY depositor (pool = `chestLogDepositsByItem[itemId]`, proportional allocation) — fits centralized loot-master banking. 'self' = strict per-player. Toggle button "🏦 Deposited by anyone / 👤 Per-player deposits" in the result action bar.
- **Deposit time window:** session −1h → **+72h** (`SESSION_POST_BUFFER`, was +24h). Deposits outside are dropped (`depositsOutOfWindow`).
- **Manual paste feature** (no client needed): "📋 Or paste a chest log manually" in the Chest Log Captures card. `addPastedChestLog()` / `_parseChestLogPasteText()` / `_resolvePastedItemId()`. Parses the in-game "Copy to clipboard" quoted-TSV (`Date / Player / Item / Enchantment / Quality / Amount`), **direction from the Amount sign**, resolves display name → item id via reversed `ITEM_NAMES` + the Enchantment column (`id@N`). Pushes deposit/withdraw batches into `window._chestLogBatches` (`_pasted:true`, tagged `📋 pasted`, content-deduped). Verified 20/20 + a 12-row real log.
- **Enemy/other-guild players hidden by default** behind a "Show N enemy players" toggle; guild-chip change recomputes instantly from cached events (`window._accEventCache`, no refetch); Share survives a failed re-run.

## KEY OPEN QUESTION the user is chasing (don't lose this thread)
"Why is so much loot flagged missing?" Diagnosis from real shared reports (`dGoOti…`, `h6BG…`, both session = June 22 18:50–20:47Z, 3510 events, log-only):
1. **`filter_unknown` dropping** ≈85% of captured pages → being fixed by the Go change above.
2. **Loot-master pattern** → fixed by the "deposited by anyone" mode (verified item-lines went 37 → ~400 in the simulation).
3. **The logs are PARTIAL** — both the client capture AND the game's "Copy to clipboard" only contain the rows the user **scrolled/paginated** into view; neither auto-pulls the full 4 weeks. The user must scroll the in-game log back to cover **the fight + ~3 days** and capture/paste **every chest tab** the loot went to.
4. **1,201 items were withdrawn back OUT** during the session (withdrawal audit) — so much of what was deposited didn't stay.
**Next measurement:** after the user recaptures with the fixed client (no `filter_unknown`) across all relevant tabs and re-shares, re-run the cross-match (fetch `GET https://albionaitool.xyz/api/accountability/public/<token>` → compare friendly looted (player,item) vs in-window deposits) to give a TRUE missing %. The old "76% missing" figure was unreliable because of the dropped `filter_unknown` pages.

## Systemic root cause still UNFIXED (the real fix for slowness)
`price_averages` is bloated to **~34.8 GB / ~170M rows** (compaction disabled since May 4). It starves the 64 MB page cache → every cold indexed read hits slow VPS disk (~150 ms). This causes: the recurring post-restart slowness, **slow loot-upload saves** (each `INSERT OR IGNORE` probes 3 cold indexes), and the wedge risk. **Permanent fix = offline cleanup (~40 min downtime, NEEDS user approval + careful execution — never raw SSH a destructive op, it corrupted the DB once; use screen/nohup):** stop service → `INSERT INTO price_averages_new SELECT * WHERE period_type='daily' OR period_start >= now-7d` → DROP old → RENAME → recreate 4 indexes → VACUUM → set `ENABLE_COMPACTION=1` → start. Expected 34.8 GB → ~2 GB. See `HANDOFF_NEXT.md` + [[feedback_backup_wedge_db_bloat]] for the exact SQL.

## Other pending (smaller)
- **Loot-upload save smoothing** (optional): backend `/api/loot-upload` does the whole chunk in one synchronous better-sqlite3 transaction (blocks the event loop). Could sub-batch with `setImmediate` yields (reliability, not raw speed). The real speed fix is the DB cleanup above.
- **Held Dependabot majors** open: express 4→5 (#10), helmet 7→8 (#9), bcryptjs 2→3 (#7), express-rate-limit 7→8 (#11).
- Optional: surface a warning in the accountability banner when batches are dropped as `filter_unknown` (moot once everyone runs the fixed client, but old captures/shares still show them).

## Hard rules (the harness enforces)
- **Every prod/VPS state-changing action needs EXPLICIT per-action user approval.** "Deploy X" is not blanket approval. Read-only diagnostics first.
- **Deploy:** website is **frontend-only-deployable** for app.js/index.html/css changes → `python -X utf8 deploy_saas.py --frontend-only` = NO service restart = NO cold-cache window. Full `python -X utf8 deploy_saas.py` only when `deploy_saas.py` (backend) changed (it restarts the service → cold-cache slow window). Both auto-bump `sw.js`; commit the bump after.
- **Git:** plain `git -C <repo> add <files> && git -C <repo> commit -m … -m …`. NO `--no-verify`, NO heredoc in commit messages, NO pipes around `git commit` (the `block-no-verify` hook trips). End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Secrets** live OUTSIDE the repo at `D:\Coding\secrets\albion_market_analyzer.env` (loaded by `deploy_saas.py`). Never print them. VPS read-only SSH (paramiko) is gated and needs explicit per-target approval.
- **Always after work:** update `CHANGELOG.md` + the in-site changelog in `index.html` (About tab) + push to origin/main.
- **Codex is OUT** — user moved fully to Claude (Max) as of today; no deploy coordination needed unless the user says otherwise.

## Quick repo/build reference
- Website frontend = `index.html` / `app.js` / `style.css` / `sw.js` / `db.js`. Backend = the `backend_js` Python string inside `deploy_saas.py` (no separate backend.js in repo). Validate before deploy: `node --check app.js`; for backend, `python tmp_check/extract_backend.py && node --check tmp_check/backend_check.js`; `python -m py_compile deploy_saas.py`.
- Go client build: `export PATH="$PATH:/c/Go/bin" && cd /d/Coding/albiondata-client-custom && go build -o albiondata-client-debug.exe .` (Go 1.24). Key file for chest logs: `client/operation_get_chest_logs.go`; opcode routing `client/decode.go`; config/flags `client/config.go`.
- Post-deploy verify: `curl https://albionaitool.xyz/healthz` (expect `{"status":"ok"}`), live `sw.js` version, grep live `app.js` for the changed symbol.
