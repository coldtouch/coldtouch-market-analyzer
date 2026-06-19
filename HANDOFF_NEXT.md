# DISPATCH HANDOFF — Albion Market Analyzer: audit remediation

> Updated 2026-06-19. Self-contained for a cold/cloud agent (e.g. phone dispatch).
> Supersedes the 2026-06-16 "DB VACUUM" handoff — that plan is OBSOLETE (see "Key findings" below).
> **Read first:** this file, then `AGENTS.md`, `CODEX_MEMORY_HANDOFF.md`, and `REMEDIATION_PLAN_2026-06-18.md`.

## Where we are
A full audit (`FULL_AUDIT_2026-06-18.md`) produced an 8-phase plan (`REMEDIATION_PLAN_2026-06-18.md`). Shipped so far, all pushed to `origin/main`, CI green:
- **Phase 1 — reproducible builds** (`16aef46`): backend deps now in committed `server/package.json` + `server/package-lock.json`, deploy installs via `npm ci`; CI has `backend-deps` (npm ci + `npm audit`) + `secret-scan` (gitleaks); Dependabot added. **nodemailer bumped 6.x→9.0.1** (cleared high-sev advisories).
- **Phase 0 — hardened DB backup** (`be2688c`, `91570e1`): backup re-enabled. Method is now `VACUUM INTO`→gzip at idle priority (see findings). Cron reduced to **once-daily 03:17** as interim mitigation.
- **Phase 2 — first module** (`be2688c`): pure crafting math extracted to `crafting-core.js` + `tests/crafting-core.test.js`; `app.js` delegates (verified in-browser).

HEAD = `91570e1`. Working tree also has UNTRACKED docs (`FULL_AUDIT_*`, `REMEDIATION_PLAN_*`, `BETTER_SQLITE3_MIGRATION_PLAN.md`, `PROJECT_FEATURE_INVENTORY.md`, `design-mockups/`) — a fresh clone won't have the gitignored ones (`FULL_AUDIT_*`), but `REMEDIATION_PLAN_2026-06-18.md` is committed alongside this handoff.

## Context / infra
- Repo: `coldtouch/coldtouch-market-analyzer` (local `D:\Coding\albion_market_analyzer`).
- Prod: https://albionaitool.xyz · VPS `5.189.189.71` (root) · systemd `albion-saas` · app at `/opt/albion-saas`.
- Backend is embedded in `deploy_saas.py` as the `backend_js` string (no `backend.js` in the repo). Frontend = `index.html`/`app.js`/`style.css`/`db.js`/`crafting-core.js`/`lootlogger-core.js`/`sw.js`.
- Existing separate worker: `maintenance_compaction.js` (systemd `albion-db-compaction.timer`) — the model to copy for a new worker.
- DB: `/opt/albion-saas/database.sqlite` ≈ 30 GB, WAL mode, better-sqlite3 (synchronous). `freelist_count=0` (all live pages).

## Hard rules (the harness enforces these)
- **Every prod/VPS state-changing action needs EXPLICIT per-action user approval.** Read-only diagnostics first. "Do phase X" is NOT blanket approval for a specific prod write.
- **Never print secrets.** Deploy secrets live OUTSIDE the repo at `D:\Coding\secrets\albion_market_analyzer.env` (loaded by `deploy_saas.py`'s `load_env()`; reuse `deploy_saas.ip/usr/password` for SSH). There is also a stray `New Text Document.env` on disk (gitignored) — do not delete without asking.
- **Git:** plain `git -C <repo> add <files> && git -C <repo> commit -m … -m …`. NO `cd`, NO pipes, NO heredoc, NO `--no-verify` (the `block-no-verify` hook trips on those).
- **Deploy:** `python -X utf8 deploy_saas.py` (full: restarts service, runs `npm ci`, regenerates cron). `--frontend-only` skips backend/restart. `rollback` restores `backend.js.bak`. Only deploy after explicit approval. A full deploy will ALSO ship Phase 1 (npm ci + nodemailer 9) — see "post-deploy checks".
- **VPS kill commands:** do NOT use `pkill -f '<pattern>'` where `<pattern>` also appears in your own command text — it self-matches and kills your own SSH shell. Use `comm`-based matching: `ps -eo pid,comm | awk '$2=="sqlite3"{print $1}' | xargs -r kill`.

## KEY FINDINGS from 2026-06-18/19 (why the old plan changed)
1. **VACUUM-to-shrink is moot:** the 30 GB DB is all LIVE pages (`freelist_count=0`, steady-state delete/insert churn). VACUUM reclaims ~nothing.
2. **`.backup` restarts on every concurrent write** → never completes on this busy DB (looped 17+ min live). This was the real 2026-06-16 outage cause, not just CPU.
3. **`.dump` is too slow** (~0.4 MB/s on 100M+ rows → ~4h).
4. **`VACUUM INTO` works** (single snapshot, not restarted) but takes ~2h and **grows the WAL to ~5 GB**; when the snapshot releases, the main Node process checkpoints that WAL **synchronously** → on 2026-06-19 it blocked the event loop **97s → watchdog abort → restart**. Idle priority does NOT help (it's a sync checkpoint, not CPU/IO starvation). **So the backup still wedges the site** — interim fix was reducing it to once-daily deep-night.

## THE MAIN TASK — Phase 4: isolate WAL checkpointing (permanent backup fix)
User CHOSE this over deleting history. Goal: the main request-serving Node process must NEVER do a large synchronous WAL checkpoint; a separate worker drains the WAL.

**Concrete steps (implement, then deploy with approval, then SOAK):**
1. In `deploy_saas.py` `backend_js`:
   - `db.pragma('wal_autocheckpoint = 0')` (currently `= 500` near `deploy_saas.py:337`) so writes never trigger an in-process checkpoint.
   - Remove/neuter `runWalCheckpoint()` (`:6127`) + its `setInterval` (`:6137`), and the inline `wal_checkpoint(PASSIVE)` calls in PriceRefCache (`:4077`), SpreadStats (`:5931`), and embedded compaction (`:6456`). A PASSIVE checkpoint of a 5 GB WAL still blocks — the worker must own ALL checkpointing.
2. New `wal_checkpoint_worker.js` (model on `maintenance_compaction.js`): long-running process, own better-sqlite3 connection, loop every ~120 s → `PRAGMA wal_checkpoint(TRUNCATE)`, log `busy/log/checkpointed`, `nice -n19`/`ionice -c3`. Add a systemd service (NOT just a timer — needs to run continuously; `Restart=always`) generated by `deploy_saas.py` like the compaction unit. Upload it in the SFTP block (add to `FRONTEND_STATIC_FILES`-style upload, and `chmod`).
3. **Safety:** with `wal_autocheckpoint=0`, a dead worker → unbounded WAL → disk fill. Keep `[HEALTH] walMB` logging; consider an emergency in-process PASSIVE only if `walMB` exceeds e.g. 3 GB (rare, bounded). Confirm `Restart=always` + monitor.
4. **Deploy + verify + SOAK 72h:** full `python -X utf8 deploy_saas.py`. Then watch `journalctl -u albion-saas | grep -E 'HEALTH|EventLoop'` — `walMB` should stay small in normal ops; the new worker's checkpoint logs should appear; and the next 03:17 backup must complete with NO `[EventLoop] ... >60000ms` line and NO `NRestarts` bump.
5. After it's proven stable, optionally restore twice-daily backups (`17 3,15 * * *` in the `backup_cron` string) and later do the broader job migration (move spreadStats/analytics/compaction off the main process too).

**Acceptance:** a backup run produces NO multi-second `[EventLoop]` block and NO restart; `walMB` stays bounded in steady state; `/healthz` 200 throughout.

## Also pending (smaller, independent)
- **After the next full deploy:** send ONE test verification email (register a throwaway account) to confirm nodemailer 9 still sends. SMTP is Gmail app-password, already configured.
- **Dependabot PRs #3–#9 are open.** Safe to merge: ws patch + the 4 GitHub-Actions bumps (also clears the Node-20 CI warnings). Review before merge: **#9 helmet 7→8** and **#7 bcryptjs 2→3** (majors — check CSP/header + hash API compat).
- **Phase 2 continuation (safe, local, no deploy):** extract + unit-test more pure modules from `app.js` — `pricing-core` (tax/freshness/outlier), `transport-core` (haul packing), `portfolio-core` (FIFO P/L). Mirror `crafting-core.js` exactly (UMD IIFE → `window.X` + `module.exports`; wire into index.html + sw.js APP_SHELL + `FRONTEND_STATIC_FILES` + CI `node --check` list + required-assets list; app.js delegates with inline fallback).
- **Optional alternative to Phase 4 (if priorities change):** shrink the DB via retention (`maintenance_compaction.js`: `price_hourly` 14→7d, `spread_stats` 14→7d, `price_averages` daily 90→30d) → drain → VACUUM. Makes backups fast/cheap but DELETES old history (all current 24h/7d/4w charts still work). Needs user OK on the numbers.
- Later phases: 3 (extract backend out of the Python string), 5 (non-root systemd user + CSP enforce + ESLint/ruff), 6 (frontend modularization), 7 (repo hygiene).

## Deploy / verify reference
- Post-deploy checks: `https://albionaitool.xyz/healthz` (expect `{"status":"ok"}`), `systemctl status albion-saas`, `journalctl -u albion-saas` for first `[HEALTH]` heartbeat, `NRestarts` should stay flat.
- Local validation before any deploy: `python -m py_compile deploy_saas.py`; extract `backend_js` to a temp file and `node --check` it; `npm test` (root, runs the core tests); `node --check app.js crafting-core.js lootlogger-core.js sw.js db.js`.
- Current live SW cache: `sw.js = coldtouch-v157`.
- Reuse the connection pattern from `deploy_saas.py` for read-only VPS diagnostics (import it, use `D.ip/D.usr/D.password` with paramiko + `RejectPolicy`). The VPS throttles rapid reconnects — keep one connection per check.
