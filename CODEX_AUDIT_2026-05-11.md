# Codex Project Audit - 2026-05-11

Scope:

- Website/app repo: `D:\Coding\albion_market_analyzer`
- Custom Albion data client repo: `D:\Coding\albiondata-client-custom`
- Live domain: `https://albionaitool.xyz`
- Focus: architecture, reliability, security posture, deploy flow, client integration, UX, and redesign direction.

## Current Snapshot

The project is a serious tool now, not a toy site. It has a large vanilla SPA, a Node/Express backend generated from `deploy_saas.py`, a SQLite/better-sqlite3 data store, a WebSocket relay for your custom game client, a public Albion Data Project NATS subscription, Discord auth/bot flows, loot/accountability workflows, and a Contabo VPS serving the production frontend and API.

Follow-up fixes implemented on May 12, 2026:

- Backend sale notifications, live flip broadcasts, and raw NATS browser broadcasts now go through `wsSafeSend()` instead of direct `wc.send()`.
- Go client `StopVPSRelay()` is now idempotent via `sync.Once`.
- Go client market-order decode and POW error-body reads now log and continue/return instead of calling `log.Fatal()`.
- Website CI was added under `.github/workflows/ci.yml` for JS syntax, Python compile, and static deploy-asset smoke checks.
- `deploy_saas.py` can now load deploy secrets from an external env file via `ALBION_DEPLOY_ENV` / `ALBION_ENV_PATH` or `D:\Coding\secrets\albion_market_analyzer.env`, with repo-local `.env` kept as fallback.
- `deploy_saas.env.example` was added as a blank template, and missing required deploy env vars now fail with a clear message instead of a raw `KeyError`.
- A report-only CSP header plus `/api/csp-report` endpoint were added as a safe first step toward stricter frontend XSS hardening.

Live checks on May 11, 2026:

- `https://albionaitool.xyz/healthz` returned `{"status":"ok"}`.
- `https://albionaitool.xyz/health` returned `{"status":"ok"}`.
- `https://albionaitool.xyz/lootlogger` returned HTTP 200 from the VPS.
- `https://albionaitool.xyz/api/market-cache/status` returned a populated active cache: 91k+ entries, scanning true, Europe server.

## What Is Strong

1. **The recent migration to VPS-hosted frontend was the right call.**
   Clean routes like `/lootlogger`, `/market`, `/transport`, `/accountability/:token`, and `/session/:token` are now a better foundation than GitHub Pages query/hash URLs.

2. **The backend has real stability work in it.**
   The old node-sqlite3 failure mode was addressed by switching to better-sqlite3, WAL mode, shorter WAL checkpoints, chunked heavy jobs, watchdog logging, and abort-on-wedge behavior. The relevant current areas are `deploy_saas.py:195`, `deploy_saas.py:279`, `deploy_saas.py:5417`, and `deploy_saas.py:6076`.

3. **Most of the old high-risk auth issues appear fixed.**
   JWT verification pins HS256 at `deploy_saas.py:1509`, `SESSION_SECRET` is required at startup at `deploy_saas.py:213`, Discord OAuth uses a short-lived exchange code at `deploy_saas.py:1489`, and admin routes check `ADMIN_DISCORD_ID` such as `deploy_saas.py:4101`.

4. **The Go client is much healthier than the earliest audit notes imply.**
   It now has a bounded router worker pool (`client/router.go:11`), malformed unreliable packets are guarded (`client/listener.go:187`), global item cache eviction exists, the VPS relay has backoff/queueing/context cancellation, and build/test pass locally when using a workspace Go cache.

5. **The product has unusually deep Albion-specific workflows.**
   Loot Logger, accountability, chest logs, sale mail tracking, craft ranking, transport, market cache, and Discord copy/reporting are a real moat. The redesign should preserve this power, not flatten it into a generic landing page.

## Highest-Risk Items

### P0 - Secret Hygiene Still Needs A Dedicated Cleanup Pass

The old Claude audit documented a live capture token committed in the client repo history, `.env` files inside the website repo folder, and historical deploy scripts that contained credentials. I did not print or inspect secret values, but the current website repo still contains `.env` and `New Text Document.env` in the working directory listing.

Recommended next step:

- Deploy loading now supports external env files. Next, move the actual secret file outside the repo, rotate all exposed or possibly exposed credentials, and do a Git history purge only after deciding exactly which historical paths need removal.

### P1 - The Real "Website Goes Down" Risk Is Still The Single-Process Backend

I do not see one fresh obvious bug that screams "this will take the VPS down today." The live service is up. The persistent risk is architectural: the same Node process handles API requests, WebSockets, NATS ingestion, Discord, SQLite writes, SpreadStats, analytics, compaction, and static serving.

The mitigations are much better now, but the class remains:

- `computeSpreadStats()` still performs sync SQLite aggregation in process (`deploy_saas.py:5417`).
- Analytics repeats the same pattern with chunking (`deploy_saas.py:6179`).
- NATS flushes every 30 seconds into SQLite (`deploy_saas.py:6555`).
- Event-loop watchdog can restart a wedged process (`deploy_saas.py:6076`), but restart is recovery, not isolation.

Recommended next step:

- Split heavy background jobs into a worker process or scheduled job runner that cannot block user-facing API/OAuth/WebSocket traffic.

### P1 - Some WebSocket Broadcast Paths Bypass Backpressure Guarding - Fixed May 12, 2026

`wsSafeSend()` checks `bufferedAmount` before sending at `deploy_saas.py:4426`, but several paths still call `wc.send()` directly:

- Sale notifications: `deploy_saas.py:4760`
- Live flip broadcast: `deploy_saas.py:4867`
- Raw NATS browser broadcast: `deploy_saas.py:6635`

Recommended next step:

- Completed for the direct-send paths found in this audit. Longer-term, consider dropping raw public NATS broadcasts to browsers unless a user-facing view actively needs them.

### P1 - The Frontend Is Now Too Large For Safe Long-Term Iteration

Current rough sizes:

- `app.js`: about 20k lines
- `style.css`: about 7.8k lines
- `index.html`: about 4.7k lines
- `deploy_saas.py`: about 7k lines, with an embedded backend string

This makes regressions more likely and makes feature-level ownership hard. The app still works, but the codebase is past the size where "one more function in app.js" remains cheap.

Recommended next step:

- Do an incremental modularization, not a full rewrite. Start with feature folders/modules for Loot Logger, Market, Crafting, Transport, and shared UI/render helpers.

### P1 - Website Repo Has No First-Class CI - Fixed May 12, 2026

The Go client has GitHub workflows. The website repo does not appear to have a real `.github/workflows` setup at the repo root. Current validation depends on manual `node --check`, `python -m py_compile`, and live testing.

Recommended next step:

- Completed for syntax and static deploy-asset smoke checks. A future CI upgrade can add a local Express/Playwright route smoke once preview startup is standardized.

## Medium-Risk Items

### P2 - `StopVPSRelay()` Can Panic If Called Twice - Fixed May 12, 2026

`StopVPSRelay()` closes `vpsRelay.stopCh` directly at `client/vps_relay.go:169`. If shutdown paths call it twice, Go will panic on close of a closed channel.

Recommended next step:

- Completed with `sync.Once`.

### P2 - Two Go Client `log.Fatal` Paths Remain - Fixed May 12, 2026

These can still crash the desktop client on malformed data or an I/O error:

- `client/operation_auction_get_offers.go:81`
- `client/uploader_http_pow.go:107`

Recommended next step:

- Completed. Malformed market-order JSON logs and skips that order; POW error-body read failure logs and returns.

### P2 - CSP Is Still Disabled While The Frontend Uses A Lot Of Dynamic HTML - Report-Only Added May 12, 2026

Helmet CSP is disabled at `deploy_saas.py:1300`. The app uses many `innerHTML` render paths. Most sampled paths now escape data, but `app.js:4011` intentionally decodes HTML into a rich tooltip. That can be okay if every producer is trusted, but it raises the value of adding CSP and gradually reducing raw HTML rendering.

Recommended next step:

- Report-only CSP is now present. Next, observe reports in production logs, reduce inline handlers/dynamic HTML where practical, then tighten into enforce mode.

### P2 - Deploy Is Better, But Still Too Magical

Good fixes are already present: host key rejection, exit-code checking, rollback, frontend-only deploy, SFTP `.env` upload. Remaining concerns:

- `deploy_saas.py` mutates `sw.js` locally on every deploy (`deploy_saas.py:56`).
- VPS dependencies are generated inside the deploy script and installed with `npm install` (`deploy_saas.py:150`, `deploy_saas.py:172`).
- The systemd service still runs as root (`deploy_saas.py:6960`).
- Backend source is embedded in a Python script rather than a normal tracked `backend.js` or `server/` folder.

Recommended next step:

- Extract backend into a real directory, track a lockfile for production dependencies, use `npm ci`, and run the service under a dedicated unprivileged user.

## UX And Product Findings

### The Current Design Is Usable But Feels Overgrown

The current UI has a consistent identity, but it leans heavily on dark/gold, shimmer, gradients, cards, and dense dropdowns. The root palette starts at `style.css:5`, the header gradient/shimmer begins around `style.css:56`, and navigation starts around `style.css:266`.

The main navigation exposes 20+ tools through groups at `index.html:320` onward. This is feature-rich, but it now behaves like a toolbox rather than a product.

### The First Screen Should Become A Workspace

Right now, unauthenticated users hit a large sign-in/landing experience, while guest users see the selected feature. For a professional tool, the best first screen after guest/login should be a useful operations dashboard:

- VPS/cache health
- current server
- recent or active loot sessions
- best market opportunities
- active alerts
- saved craft/transport plans
- clear next actions

### Routes Should Map To Workflows, Not Just Tabs

The clean route work was good. The next step is a real information architecture:

- `/market` for Market Browser, flipping, city comparison, favorites
- `/crafting` for crafting, Top-N, refining, journals, RRR
- `/transport` for routes and haul plans
- `/lootlogger` for sessions/upload/accountability
- `/lootbuyer` for tab evaluation and sale tracking
- `/alerts`
- `/profile`

### Loot Logger Is Probably The Product's Best Brand Anchor

The market tools are useful, but Loot Logger/accountability is the most differentiated. It should feel like a guild operations cockpit, not one more tab.

Recommended improvements:

- Player cards with clear status and Discord action.
- Missing/deposited/lost item grouping by default.
- A report preview side panel.
- Session search and saved filters.
- Direct "message this player" Discord copy.
- Cleaner merge/chest-log verification flow.

## Design Mockups Added

Created isolated design demos under `design-mockups/`:

- `design-mockups/index.html`
- `design-mockups/01-command-center.html`
- `design-mockups/02-market-terminal.html`
- `design-mockups/03-guild-operations.html`
- `design-mockups/04-crafting-studio.html`
- `design-mockups/mockups.css`
- `design-mockups/README.md`

My recommendation:

1. Use **Command Center** as the overall app shell.
2. Borrow the **Market Terminal** table density for market/transport pages.
3. Borrow the **Guild Operations** layout for Loot Logger/accountability.
4. Borrow the **Crafting Studio** calmer form/result split for crafting.

The best redesign is probably a hybrid, not one mockup copied wholesale.

## Plugin And Connector Recommendation

No extra connector is required for the code audit or these local HTML mockups.

Recommended if you want collaborative design selection:

- **Figma plugin**: best if you want editable design comps, design system tokens, and a UI spec before implementation.
- **Canva plugin**: useful for marketing/preview images, not necessary for the actual app UI.
- **GitHub plugin**: useful for PRs, issue tracking, CI triage, and release hygiene.
- **Chrome plugin**: useful when verification needs your logged-in browser profile or extensions.

## Validation Performed

Website:

- `node --check app.js` passed.
- `node --check sw.js` passed.
- `deploy_saas.py` compiled cleanly after the earlier escape-warning cleanup.
- Live VPS health and market cache were checked on May 11, 2026.

Client:

- `C:\Go\bin\go.exe test ./...` passed using a workspace-local Go cache.
- `C:\Go\bin\go.exe build ./...` passed using a workspace-local Go cache.

Mockups:

- Local browser DOM pass confirmed all mockup pages load through `http://127.0.0.1:8766/`.
- Production app files were not modified by the mockup work.

## Suggested Next Work Order

1. Secret cleanup and credential rotation.
2. Fix WebSocket direct-send paths.
3. Fix the three Go client reliability footguns: relay double-stop, two `log.Fatal` calls.
4. Add website CI.
5. Decide on redesign direction from the mockups.
6. Start redesign with the app shell/navigation only, then migrate feature areas one by one.
7. Split heavy background jobs away from user-facing API/WebSocket process.
