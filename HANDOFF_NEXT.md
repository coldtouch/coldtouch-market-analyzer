# DISPATCH HANDOFF — Albion Market Analyzer: DB VACUUM + hardened backup

> Created 2026-06-16. Self-contained for a cold/cloud agent (e.g. phone dispatch).
> Pick up the open DB work below. Everything else from the 2026-06-16 session is shipped + live.

## Context
- Repo: `coldtouch/coldtouch-market-analyzer` (local `D:\Coding\albion_market_analyzer`).
- Prod: https://albionaitool.xyz · VPS `5.189.189.71` (root) · systemd service `albion-saas` · app at `/opt/albion-saas` · Node backend is embedded in `deploy_saas.py` as `backend_js` · DB-compaction worker is `maintenance_compaction.js` (systemd `albion-db-compaction`).
- HEAD at handoff: `62cd738`. **Read first:** `AGENTS.md`, `CODEX_MEMORY_HANDOFF.md`.

On 2026-06-16 a prod outage was caused by the twice-daily DB backup cron running `sqlite3 .backup` on a 29.7 GB DB for 3h+ at 90% CPU, starving the single Node process (event loop wedged). Recovered by killing the backup + restarting. The bloat cause — `price_analytics` had **no retention** and grew unbounded since analytics was disabled 2026-05-20 — was fixed: a 14-day retention prune was added to `maintenance_compaction.js` and is draining. **The backup cron is CURRENTLY DISABLED:** `/etc/cron.d/albion-backup.disabled` (reversible rename).

## Goal of this dispatch
1. Confirm `price_analytics` has drained.
2. **VACUUM** the DB to physically shrink the ~29.7 GB file.
3. **Harden the backup script and re-enable it.**

## Hard rules
- Every prod / VPS state-changing action needs **explicit user approval** (the harness blocks otherwise). Ask per-action.
- **Never print secrets.** Deploy secrets: `D:\Coding\secrets\albion_market_analyzer.env`.
- Read-only diagnostics first. **Never** run heavy DB ops in the web process, and **never let an SSH session time out mid-VACUUM** (a prior SSH timeout mid-transaction once corrupted the DB — use `nohup`/`screen`). Verify on albionaitool.xyz before calling anything done.
- Git: commit with plain `git -C <repo> add … && git -C <repo> commit -m … -m …` (no `cd`, no pipes, no heredoc — the `block-no-verify` hook trips on those).

## Steps
1. **Confirm drain (read-only):** SSH and run
   `journalctl -u albion-db-compaction --no-pager -n 50 | grep -E 'analyticsDeleted|dbLive'`
   plus a read-only `freelist_count` / `page_count` probe. Expect `dbLive` dropping across runs and `analyticsDeleted` > 0.
2. **VACUUM (off-peak, with approval):** prefer `VACUUM INTO '/opt/albion-saas/database.vacuumed.sqlite'`, then `systemctl stop albion-saas`, swap the file in, `systemctl start albion-saas`, verify `/healthz` + journal. (Or stop service then `VACUUM;` under `nohup`.) Check free disk first (~49 GB free after the 2026-06-16 cleanup). Restore point: `/opt/albion-saas/backups/db-20260616-03.sqlite.gz`.
3. **Harden backup (with approval):** in `deploy_saas.py`, rewrite the `albion-db-backup.sh` generator to stream straight to gzip (NO 24 GB uncompressed `.tmp`) under `nice -n19` / `ionice -c3`, keep last 2. Then either a full `python -X utf8 deploy_saas.py` (regenerates + re-enables the cron with the hardened script) or `mv /etc/cron.d/albion-backup.disabled /etc/cron.d/albion-backup`. Confirm a manual backup run finishes fast WITHOUT spiking `[EventLoop]` delay in the journal.

## Done when
DB file ≪ 29.7 GB; `/healthz` 200; `NRestarts` flat; a backup runs in seconds without wedging the site; `CHANGELOG.md` updated; commit + push.

## Deploy / verify reference
- Frontend-only deploy: `python -X utf8 deploy_saas.py --frontend-only` (bumps `sw.js`, no restart, does NOT touch the backup cron). Full deploy: `python -X utf8 deploy_saas.py` (restarts service AND regenerates the backup cron).
- After a frontend deploy, commit+push the `sw.js` bump.
- Verify live: no-cache `Invoke-WebRequest` of `/sw.js` (CACHE_NAME) + `/app.js` (feature markers). Current live: `sw.js = coldtouch-v156`.
