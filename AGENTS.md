# Codex Project Guide

This repository is the public Coldtouch Market Analyzer website plus the deploy
wrapper for the private Node backend on the VPS.

## Start Here

1. Read this file.
2. Read `CODEX_MEMORY_HANDOFF.md` for project memory, user preferences, deploy
   rules, and recent live-state context.
3. Read `PROJECT_FEATURE_INVENTORY.md` for the current product map.
4. Read `CHANGELOG.md` before changing user-facing behavior.
5. Use `CLAUDE.md`, `HANDOFF.md`, and local `.memory/` files only as historical
   context. They are not the primary operating instructions anymore.

## Repositories And Runtime

- Website repo: `D:\Coding\albion_market_analyzer`
- Custom Go client repo: `D:\Coding\albiondata-client-custom`
- Albion dump/data repo: `D:\Coding\ao-bin-dumps`
- Production domain: `albionaitool.xyz`
- Production host: `5.189.189.71`
- VPS app path: `/opt/albion-saas`
- systemd service: `albion-saas`
- Static frontend is served from GitHub Pages and the VPS.
- Backend source lives inside `deploy_saas.py` as the `backend_js` payload.

## Secrets

Never print secrets. Do not paste values from `.env`, `New Text Document.env`,
client `config.yaml`, capture tokens, Discord secrets, SMTP credentials, JWT
secrets, VPS passwords, or NATS tokens into chat, docs, logs, or commits.

When debugging, refer to secrets by key name only. If a secret was exposed in a
terminal or shared context, recommend rotation instead of repeating the value.

## Normal Website Workflow

- Frontend files are plain HTML/CSS/JS:
  - `index.html`
  - `style.css`
  - `app.js`
  - `db.js`
  - `sw.js`
- Backend changes are made in `deploy_saas.py`, not by editing remote
  `/opt/albion-saas/backend.js` directly.
- After user-facing changes, update `CHANGELOG.md` and the About changelog in
  `index.html`.
- `deploy_saas.py` bumps the service worker cache stamp during deploy. Do not
  hand-edit `sw.js` just to bump the stamp unless the deploy script did it.
- Avoid unrelated refactors. This codebase has many live product surfaces and a
  small change can affect multiple tabs.

## Validation

For backend edits:

1. Parse the Python wrapper:
   `python -m py_compile deploy_saas.py`
2. Extract or regenerate the embedded backend JS into a temporary file under
   `tmp_check/`.
3. Run Node syntax validation:
   `node --check tmp_check\backend_check.js`

For frontend edits, open the local file or dev target in the browser and check
the touched tab at desktop and mobile widths.

For the Go client, work in `D:\Coding\albiondata-client-custom` and run:

- `go test ./...`
- `go build ./...`

Use network or VPS access only when it is necessary for the task and the user has
approved it.

## Deploy And VPS Checks

Only deploy after explicit user approval.

Deploy command:

`python -X utf8 deploy_saas.py`

Post-deploy checks:

- `https://albionaitool.xyz/healthz`
- `systemctl status albion-saas`
- `journalctl -u albion-saas` for startup and first heartbeat logs
- `NRestarts` should stay flat after the restart window

Prefer read-only diagnostics first. Do not run destructive SQLite, filesystem, or
systemd commands unless the user explicitly asked for that exact operation.

## May 11 2026 Production Incident

Root cause: the backend `DiskSafety` check used SQLite `page_count * page_size`
as DB size. The file was about 15.3 GB, but about 6.3 GB was freelist pages, so
live data was only about 9 GB. Crossing the 15 GB warning threshold triggered
compaction after every restart. Compaction then blocked the Node event loop long
enough for the watchdog to abort, causing a restart loop.

Fix deployed on 2026-05-11:

- `checkDiskUsage()` now thresholds live SQLite pages:
  `(page_count - freelist_count) * page_size`
- Disk logs show live, total, and free page sizes.
- Compaction chunks were reduced and yield with `setImmediate`.
- Heavy background jobs are guarded so compaction, spread stats, analytics, and
  price reference refresh do not overlap dangerously.

Observed after deploy:

- `/healthz` returned OK.
- `NRestarts=0` after the clean restart.
- The old 25 minute failure window passed with:
  `DB live=9261MB total=15.3GB freePages=6.3GB - OK`

Remaining watchpoint: `SpreadStats` can still block the event loop for tens of
seconds while processing large aggregates. It completed without restarting the
service, but should be the next backend hardening target.

## Custom Client Relationship

The Go client is a first-class part of the product, not a side project. It
captures live loot, chest, death, market trade, and sale-notification signals and
streams them to the VPS over an authenticated WebSocket. Website features such
as Loot Logger, Loot Buyer, accountability, chest captures, chest logs, and sale
notifications depend on this fork.

Before changing client/backend contracts, check both repositories.

## Multiagent Work

The user is interested in multiagent workflows. In this environment, use
subagents only when the user explicitly asks for parallel agents or delegation.
Keep write scopes separate and do not have agents edit the same files.
