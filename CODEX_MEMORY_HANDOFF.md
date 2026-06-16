# Codex Memory Handoff - Coldtouch Market Analyzer

Last updated: 2026-06-16
Primary purpose: give future Codex sessions enough project memory to avoid
starting cold, especially around production deploys, Loot Logger, Accountability,
and the user's working preferences.

## Read This First

When the user says "load the handoff", "get context", "continue", "check live",
or asks for work on this project, start here:

1. Work from `D:\Coding\albion_market_analyzer` unless the user explicitly says
   the custom Go client or another repo.
2. Read `AGENTS.md`, this file, and `PROJECT_FEATURE_INVENTORY.md`.
3. For user-facing behavior, skim the top of `CHANGELOG.md`.
4. Run `git status -sb`, `git branch --show-current`, and
   `git log --oneline -n 8`.
5. Confirm whether the target is production `main`, a feature worktree, or the
   custom client repo.
6. Never say "live" until `https://albionaitool.xyz` itself has been checked.

## User Preferences And Working Style

The user strongly values continuity. They do not want Codex to behave like every
session starts from zero. If context is missing, read the handoff and project
docs before making assumptions.

Important preferences:

- Be proactive: inspect, implement, validate, and report exact results.
- Be honest about state. If something is pushed but not deployed, say that
  clearly.
- Do not call a fix "live" just because it is committed or pushed.
- Verify the real production domain, not only GitHub Pages.
- Prefer exact commands, commit hashes, live URLs, cache versions, and observed
  outputs over vague summaries.
- Keep final answers concise but include the proof that matters.
- Avoid repeated beginner questions when the answer is in the repo docs.
- Protect secrets. Never print tokens, `.env` values, VPS passwords, Discord
  secrets, SMTP credentials, capture tokens, or client `config.yaml` values.
- Ask for explicit approval before production deploys or risky VPS operations.
- Do not revert unrelated user changes or cleanup untracked files unless asked.

If Codex makes a mistake, acknowledge it plainly, correct it, and change the
process. The user prefers practical repair over defensive explanation.

## Project Identity

Coldtouch Market Analyzer is an Albion Online economy, crafting, loot, guild
operations, and live-client tooling project.

Main product surfaces:

- Market Browser, Market Flipping, BM Flipper, City Comparison, Top Traded,
  Item Power, Favorites, Live Flips.
- Crafting Profits, recursive craft tree, refining, journals, transport routes,
  portfolio tracker, craft runs.
- Loot Buyer, Loot Logger, uploaded loot files, live loot sessions, public
  sharing, Accountability, chest captures, chest logs, guild leaderboard, loot
  split.
- Profile/auth, alerts, feedback, community pages, admin health/reporting.

The project is not just a static website. It includes a production VPS backend,
a static frontend served from both the VPS and GitHub Pages, and a custom Albion
Data Client fork that captures private live game events.

## Repositories And Paths

Primary website repo:

- `D:\Coding\albion_market_analyzer`
- Branch for production work: `main`
- Production remote: `origin main` on GitHub

Known alternate/feature worktree:

- `D:\Coding\albion_market_analyzer_loot_discord`
- This is not the production worktree. Do not assume changes here are live.
- On 2026-06-16, an earlier fix was first made here by mistake before being
  ported to the real production worktree.

Custom Go client repo:

- `D:\Coding\albiondata-client-custom`
- Used for private capture: loot, chest, death, trade, sale notifications,
  device auth, and WebSocket relay.

Albion dump/data repo:

- `D:\Coding\ao-bin-dumps`
- Used for current item maps, weights, and Albion data refresh work.

## Production Topology

Production domain:

- `https://albionaitool.xyz`

Production host:

- `5.189.189.71`

VPS app path:

- `/opt/albion-saas`

systemd service:

- `albion-saas`

Static frontend serving:

- Custom domain `albionaitool.xyz` serves static frontend assets from the VPS:
  `/opt/albion-saas/public`.
- GitHub Pages also serves a mirror:
  `https://coldtouch.github.io/coldtouch-market-analyzer/`.
- GitHub Pages is not enough for "live" because users normally use
  `albionaitool.xyz`.

Backend:

- Node/Express backend source is embedded inside `deploy_saas.py` as the
  `backend_js` payload.
- Do not edit remote `/opt/albion-saas/backend.js` directly.
- Backend stores data in SQLite via `better-sqlite3`.
- Public health endpoints include `/health` and `/healthz`.
- Internal/admin health exists behind auth/admin routes.

## Deploy Rules

Only deploy after explicit user approval.

Frontend-only production deploy:

```powershell
python -X utf8 deploy_saas.py --frontend-only
```

What it does:

- Uploads static files to `/opt/albion-saas/public`.
- Does not restart the backend service.
- Bumps `sw.js` `CACHE_NAME` locally before upload.
- After running it, commit and push the service-worker bump if the deploy script
  modified `sw.js`.

Full backend deploy:

```powershell
python -X utf8 deploy_saas.py
```

What it does:

- Uploads backend and frontend assets.
- Installs/updates dependencies as scripted.
- Restarts or manages the production backend service.
- Requires more caution and post-deploy health checks.

Rollback:

```powershell
python -X utf8 deploy_saas.py rollback
```

Do not run rollback unless the user explicitly approves or asks.

## Definition Of Live

A fix is live only when all required items are true:

- Correct worktree changed: normally `D:\Coding\albion_market_analyzer` on
  `main`.
- Syntax/targeted checks passed.
- Changes committed.
- Changes pushed if GitHub state matters.
- If the user expects production, the relevant deploy ran with approval.
- `https://albionaitool.xyz` serves the new assets or backend behavior.
- Any service worker cache bump is visible at `https://albionaitool.xyz/sw.js`.

Do not say live after only:

- Editing local files.
- Running local tests.
- Pushing `main`.
- Seeing GitHub Pages update.

For frontend verification, use cache-busting or no-cache requests:

```powershell
$sw = (Invoke-WebRequest -UseBasicParsing -Uri 'https://albionaitool.xyz/sw.js' -Headers @{ 'Cache-Control' = 'no-cache' }).Content
$app = (Invoke-WebRequest -UseBasicParsing -Uri 'https://albionaitool.xyz/app.js' -Headers @{ 'Cache-Control' = 'no-cache' }).Content
```

Then check for the cache version and feature markers.

## Standard Validation

Frontend:

```powershell
node --check app.js
node --check sw.js
```

When behavior is visual or interactive, use the browser tool/local server if
available and check the touched tab at desktop and mobile widths.

Backend:

```powershell
python -m py_compile deploy_saas.py
```

Then extract or regenerate the embedded backend JS to a temporary file and run:

```powershell
node --check tmp_check\backend_check.js
```

Custom Go client:

```powershell
go test ./...
go build ./...
```

Network/VPS checks may require approval in Codex because network access is
restricted.

## Recent Production Fix: 2026-06-16

Issue:

After manually uploading a Loot Logger file, Share/Accountability could show:

```text
Save failed: Share / Accountability unavailable
```

The user wanted to click Accountability anyway to inspect the uploaded data.

Root mistake during the session:

- The first implementation happened in
  `D:\Coding\albion_market_analyzer_loot_discord`.
- The live production worktree is `D:\Coding\albion_market_analyzer`.
- Pushing `main` updated GitHub Pages, but `albionaitool.xyz` still needed the
  frontend-only VPS deploy.

Final shipped behavior:

- Manual upload stores parsed events locally under the synthetic session id
  `__upload__`.
- Accountability remains available for the current uploaded file even when
  server save/share fails.
- Share is separated from Accountability. If the uploaded file is not saved on
  the server yet, Share can be unavailable while local Accountability still
  works.
- The old combined failure string is gone from production app.js.
- Loot Logger report filters now include alliance.
- Accountability result filters now include alliance.

Follow-up from user testing:

- The message `Share unavailable: Failed to fetch. Accountability still works
  locally.` indicates the browser never received a normal HTTP response from
  `/api/loot-upload`.
- Live probing showed the API returns clean 401 responses for normal upload-sized
  unauthenticated JSON bodies, but oversized cross-origin bodies can return a
  413 without CORS headers before frontend code sees JSON, which browsers report
  as `Failed to fetch`.
- Client fix: manual uploads now save in bounded chunks and append later chunks
  to the same server session id, staying under the backend per-request upload
  limits while preserving one Share-able session.

Key app.js markers:

- `LL_UPLOAD_SESSION_ID`
- `_llUploadedEvents`
- `_llUploadSaveState`
- `_llBuildUploadChunks`
- `_llSaveUploadedLootLines`
- `ll-filter-alliance`
- `acc-result-alliance`

Commits:

- `4e1342d` - `Fix upload accountability fallback`
- `9331f7f` - `Bump service worker for frontend deploy`

Production verification on 2026-06-16:

- `https://albionaitool.xyz/sw.js` served `CACHE_NAME = 'coldtouch-v152'`.
- `https://albionaitool.xyz/app.js` contained:
  `LL_UPLOAD_SESSION_ID`, `ll-filter-alliance`, `acc-result-alliance`.
- `https://albionaitool.xyz/app.js` did not contain:
  `Save failed: Share / Accountability unavailable`.

User note:

- Browser may need one hard refresh after service-worker changes, usually
  `Ctrl+F5`.

## Current Git State Observed 2026-06-16

After the frontend deploy and push:

- `main` matched `origin/main`.
- Known untracked files in the website worktree:
  - `AGENTS.md`
  - `BETTER_SQLITE3_MIGRATION_PLAN.md`
  - `PROJECT_FEATURE_INVENTORY.md`
  - `crafting-pipeline-design.jsx`
  - `design-mockups/`

Do not delete or revert these. They appear to be local project docs/design work
and may be intentionally untracked.

## Frontend Architecture Notes

Frontend files:

- `index.html`
- `style.css`
- `app.js`
- `db.js`
- `sw.js`
- `lootlogger-core.js`
- static data files such as `items.json`, `recipes.json`, `itemweights.json`,
  `itemmap.json`

The app is a large vanilla JavaScript SPA. Prefer existing local patterns over
new frameworks. Keep changes narrowly scoped.

Service worker:

- `sw.js` caches the app shell.
- `deploy_saas.py` bumps `CACHE_NAME` during deploy.
- Do not hand-edit `sw.js` just for cache bumping unless the deploy script did
  it or the user explicitly wants that local sync.

User-facing changes:

- Update `CHANGELOG.md`.
- Update the About changelog inside `index.html` when appropriate.

## Backend Architecture Notes

`deploy_saas.py` contains the production backend as a generated JS payload.

Important backend areas:

- Express app and static frontend serving.
- SQLite through `better-sqlite3`.
- Auth: Discord OAuth, email auth, JWT, device auth for the Go client.
- Loot sessions, upload, merge, public session shares.
- Accountability shares and result snapshots.
- Chest captures and chest logs.
- WebSocket relay for custom client events.
- Market cache, live flips, spread stats, analytics, transport routes.
- Admin health, audit, routine reports, news banner.

Production stability risk to remember:

- Historically, heavy SQLite aggregation and compaction caused event-loop stalls.
- May 2026 hardening reduced this, but `SpreadStats` remains a watchpoint.
- Prefer chunked/yielding DB work and avoid adding monolithic scans to the public
  web process.

May 2026 incident memory:

- `DiskSafety` used total SQLite file size instead of live pages.
- A 15.3 GB DB file included about 6.3 GB free pages, so compaction kept
  triggering wrongly.
- Fix used `(page_count - freelist_count) * page_size`, added better logging,
  chunking, and job guards.

## Custom Go Client Notes

The custom client is central to the product, not optional.

Repo:

- `D:\Coding\albiondata-client-custom`

Private capture features:

- Device auth against `https://albionaitool.xyz/api/device/*`.
- Authenticated WebSocket relay to `wss://albionaitool.xyz`.
- Loot events with guild/alliance cache.
- Death and kill events with equipment metadata when available.
- Chest/container captures, vault tabs, chest logs.
- Marketplace buys/listings/orders, sale-finished mail, expired-order mail.
- Player trade diagnostics.
- Unknown opcode logging for post-patch reverse engineering.

Important safety:

- `config.yaml` contains capture tokens and must remain untracked.
- Do not delete untracked custom source files during cleanup.
- Before changing backend/client contracts, inspect both repos.

## Common Traps To Avoid

Wrong worktree:

- Do not confuse `albion_market_analyzer_loot_discord` with production
  `albion_market_analyzer`.

Wrong live check:

- GitHub Pages being updated does not mean `albionaitool.xyz` is updated.

Service worker:

- A fixed `app.js` may still be hidden behind an old service worker until the
  cache version changes and the browser reloads.

Deploy script side effect:

- `deploy_saas.py --frontend-only` bumps `sw.js` locally. Commit/push that bump
  after a successful deploy so git matches production.

Secrets:

- Never print or commit values from env/config files.

Dirty worktree:

- Treat unrelated untracked or modified files as user work. Leave them alone
  unless they directly block the task.

## Preferred Codex Workflow For This Project

For every non-trivial task:

1. Load context from this file and project docs.
2. Confirm the correct repo/worktree/branch.
3. Use `rg` to find existing patterns.
4. Make scoped edits with `apply_patch`.
5. Run focused validation.
6. For user-facing changes, update changelog/About when appropriate.
7. Commit when the user expects production work to be durable.
8. Push only when appropriate.
9. Deploy only with explicit user approval.
10. Verify `albionaitool.xyz` before saying the fix is live.
11. Final response should include exact checks, commit hashes, and anything the
    user must do, such as hard refresh.

## Suggested Future Improvements

To make Codex feel more like a remembered project environment:

- Keep this file current after meaningful sessions.
- Add a small `scripts/verify-live-frontend.ps1` that checks `sw.js`, `app.js`,
  cache version, and expected markers for a feature.
- Create a project-specific Codex skill/plugin named something like
  `albion-market-analyzer` that tells Codex to read this file, `AGENTS.md`, and
  `PROJECT_FEATURE_INVENTORY.md` before acting.
- Add a deploy checklist script or Markdown file for frontend-only and backend
  deploys.
- Consider committing `AGENTS.md`, `PROJECT_FEATURE_INVENTORY.md`, and this
  handoff if the user wants every clone/session to have the same memory.

## How To Keep This File Useful

Update this file when:

- Production topology changes.
- Deploy commands change.
- A new major product area is added.
- A recurring mistake happens and needs to become a rule.
- A major incident or live fix changes how future work should be done.
- The user's preferences change.

Keep entries factual, dated, and operational. The goal is not a diary. The goal
is a reliable project memory that future Codex sessions can act on.
