# Remediation Plan — Albion Market Analyzer — 2026-06-18

> Companion to `FULL_AUDIT_2026-06-18.md`. A careful, sequenced plan to fix every finding
> and raise each scorecard grade. Designed to be executed incrementally across sessions
> without breaking the live product.

## Operating rules (carry into every step)
- **Every prod/VPS state change needs explicit per-action approval.** Read-only diagnostics first.
- **Never print secrets.** Secret source of truth: `D:\Coding\secrets\albion_market_analyzer.env`.
- **Surgical changes only.** No drive-by refactors riding along with a fix.
- **Each step ships independently and is revertable** (git revert + `deploy_saas.py rollback`).
- After user-facing changes: update `CHANGELOG.md` + About-tab changelog, commit, push.

## Target grades

| Dimension | Now | Target | Phase that moves it |
|---|---|---|---|
| Reliability / ops | C+ | A- | 0, 4 |
| Dependency / supply-chain | D | B+ | 1 |
| Automated testing | D+ | B | 2 |
| Code architecture / modularity | D | B- | 3, 6 |
| Security | B | A- | 5 |
| Deploy hygiene | C- | B | 1, 5 |
| CI/CD | C | B+ | 1, 2 |
| Repo hygiene | C | A- | 7 |

---

## Phase 0 — Close the operational gap (URGENT: no DB backup is running)
**Goal:** finish `HANDOFF_NEXT.md`. Reliability C+ → B. **Effort: M. VPS approval required.**

> ✅ **DONE 2026-06-18** (commit `be2688c`). Automated backups re-enabled with a hardened method.
> - **VACUUM dropped:** diagnostics showed the 30 GB is all *live* pages (`freelist_count=0`, steady-state churn), so VACUUM would reclaim ~nothing. The HANDOFF_NEXT "VACUUM to shrink" premise no longer held.
> - **Backup method rewritten** after finding `.backup` restarts on every concurrent write (looped 17+ min live) and `.dump` is too slow (~4h, ~0.4 MB/s on 100M+ rows): now **`VACUUM INTO` → gzip** under `nice -n19`/`ionice -c3`, disk-fill guard, pre-prune, atomic, keep-last-2. Verified: 5.4 GB snapshot, `gzip -t` OK, site stayed healthy (NRestarts=0). Cron re-enabled.
> - **Open follow-up (needs a product decision):** the backup takes ~2h and transiently grows WAL to ~6 GB (self-recovers) purely because the DB is ~30 GB. **Reducing price-history retention** (e.g. price_hourly 14d→7d, spread_stats 14d→7d, daily 90d→30d) would shrink the DB so backups become fast/cheap — this deletes history, so it needs your call on how much to keep, then a one-time drain + VACUUM.

Production currently has **no automated DB backup** (cron disabled after the June 16 wedge). This is the single most urgent item.

- [ ] **0.1** Read-only drain confirm: `journalctl -u albion-db-compaction | grep -E 'analyticsDeleted|dbLive'` + a read-only `freelist_count`/`page_count` probe. Expect `dbLive` falling, `analyticsDeleted > 0`.
- [ ] **0.2** Check free disk (`df -h /`). Need headroom for `VACUUM INTO`.
- [ ] **0.3** **VACUUM** off-peak: `VACUUM INTO '/opt/albion-saas/database.vacuumed.sqlite'` → `systemctl stop albion-saas` → swap file → `start` → verify `/healthz` + journal. Restore point: `db-20260616-03.sqlite.gz`. Run under `nohup`/`screen` — **never let SSH time out mid-VACUUM** (it once corrupted the DB).
- [ ] **0.4** Harden the backup generator in `deploy_saas.py:7698`: stream straight to `gzip` (no 24 GB `.tmp`), wrap in `nice -n19 ionice -c3`, keep last 2.
- [ ] **0.5** Re-enable cron (`mv /etc/cron.d/albion-backup.disabled /etc/cron.d/albion-backup` or full deploy). Trigger one manual run; confirm it finishes in seconds **without** spiking `[EventLoop]` delay.
- [ ] **0.6** Update `feedback_backup_wedge_db_bloat` memory + `CHANGELOG.md`; commit.

**Acceptance:** DB file ≪ 29.7 GB; `/healthz` 200; `NRestarts` flat; a backup completes in seconds without wedging the site; cron enabled.

---

## Phase 1 — Reproducible builds + supply chain (D → B+)
**Goal:** pin and lock production deps; deploy with `npm ci`; vuln-scan in CI. **Effort: M. Decoupled from full backend extraction — do this first, it's a fast high-value win.**

> ✅ **DONE 2026-06-18** (commit `16aef46`, pushed; CI green). All 1.1–1.5 complete. Bonus: the new `npm audit` caught a **high-severity nodemailer 6.x** advisory cluster (SMTP injection/CRLF/SSRF/file-read) → bumped to **9.0.1** (audit clean, API-compatible). Dependabot opened 7 bump PRs (#3–#9). **Pending:** the change goes live on the next `python deploy_saas.py` (needs approval); after deploy, send one test verification email to confirm nodemailer 9 works.

Today: backend deps are caret ranges generated inside `deploy_saas.py:184–198`, installed with `npm install` (`:203`), no committed production lockfile. Every deploy can pull a different tree.

- [ ] **1.1** Create `server/package.json` with the exact deps from `deploy_saas.py:186–196`. Run `npm install` **locally** once to generate `server/package-lock.json`. Commit both.
- [ ] **1.2** Change deploy to upload the committed `server/package.json` + `server/package-lock.json` and run **`npm ci`** instead of generating the package.json string + `npm install` (replace `deploy_saas.py:184–203`).
- [ ] **1.3** Decide pinning policy: pin exact versions (drop carets) or keep carets but rely on the committed lockfile (lockfile is the real guarantee — carets are then cosmetic). Recommend lockfile-as-truth + Dependabot/Renovate for controlled bumps.
- [ ] **1.4** Add to CI (`.github/workflows/ci.yml`): `npm ci` against the committed lockfile + `npm audit --omit=dev --audit-level=high` (non-blocking warn first, then gate).
- [ ] **1.5** Add a **secret-scan** step (gitleaks) and a **Dependabot** config (`.github/dependabot.yml`) for `server/` npm + GitHub Actions.

**Acceptance:** a deploy installs from a committed lockfile via `npm ci`; CI runs `npm audit` + gitleaks; two deploys produce byte-identical `node_modules` trees.

**Risk/rollback:** low — the VPS `node_modules` is unchanged in shape; if `npm ci` misbehaves, revert the deploy commit and `npm install` path is restored.

---

## Phase 2 — Automated test coverage (D+ → B)
**Goal:** test the logic that actually breaks. **Effort: L. Pure-local, zero prod risk — safe to parallelize with everything.**

> 🟡 **IN PROGRESS** (commit `be2688c`). First module extracted: `crafting-core.js` (effective tax rate, RRR, focus cost, quality distribution + EV price) with `tests/crafting-core.test.js` (6 tests). `app.js` delegates with inline fallback; verified behavior-identical in-browser. Wired into index.html/sw.js/deploy/CI. **Remaining 2.1 modules:** `pricing-core`, `transport-core`, `portfolio-core`; then 2.2 backend route-smoke (after Phase 3) and 2.3 coverage reporting.

`lootlogger-core.js` + its 5 tests is the proven pattern. Repeat it.

- [ ] **2.1** Extract pure functions from `app.js` into testable modules (no DOM), one domain at a time:
  - `pricing-core.js` — tax/setup-fee math, spread/confidence, freshness, outlier rejection.
  - `transport-core.js` — haul packing (weight/slots/budget), route/profit sorting.
  - `crafting-core.js` — recipe cost, RRR, hideout bonus, journal profit.
  - `portfolio-core.js` — FIFO cost basis, realized P/L.
  - Each: move logic out, re-import into `app.js` (keep behavior identical), add `tests/<name>.test.js`.
- [ ] **2.2** Backend route-smoke harness: once Phase 3 makes `backend.js` requireable (or via a thin import shim now), add **Supertest** tests for `/healthz`, `/api/me` (authed + anon), auth exchange-code flow, and one rate-limited route. Use an in-memory/throwaway SQLite file.
- [ ] **2.3** Wire coverage reporting (`node --test --experimental-test-coverage` or `c8`); set a floor (start 25%, ratchet up) and surface it in CI.
- [ ] **2.4** CI runs the full suite on every PR (already does `npm test` — extend globs).

**Acceptance:** ≥4 new core modules with tests; backend route-smoke suite green in CI; coverage reported and ratcheting.

---

## Phase 3 — Extract the backend out of the Python string (D → C+)
**Goal:** make the backend a real, lintable, testable, type-checkable codebase; `deploy_saas.py` becomes deploy-only. **Effort: L. Mechanical but high-stakes — do it as one careful, well-verified change.**

Today `backend_js` is one triple-quoted string, `deploy_saas.py:216–7477` (~7,260 lines). `tmp_check/extract_backend.py` already extracts it.

- [ ] **3.1** Extract the string verbatim to `server/backend.js`. Confirm byte-for-byte equality vs the current extracted artifact (`node --check` + diff against `tmp_check/backend_check.js`).
- [ ] **3.2** Change `deploy_saas.py` to **read** `server/backend.js` from disk and SFTP it (replace the inline string + the local syntax-check temp-file dance). Keep `.bak` rollback. Net deploy behavior identical; single-command deploy preserved.
- [ ] **3.3** Add `server/` to CI: `node --check`, ESLint (see 5.4), and the Supertest harness from 2.2.
- [ ] **3.4** (Optional, later) Split `server/backend.js` into modules by concern — `routes/`, `db/`, `jobs/`, `ws/`, `auth/`, `discord/` — one extraction per PR, behavior-preserving. **Do not** attempt in the same change as 3.1–3.2.

**Acceptance:** `deploy_saas.py` contains no embedded JS; backend lives in `server/`; a deploy produces an identical running service; CI lints + checks the backend.

**Risk/rollback:** medium. The deploy mechanism changes. Mitigate: ship 3.1–3.2 as one commit, deploy to prod with approval during a low-traffic window, verify `/healthz` + `NRestarts` flat, keep `rollback` ready.

---

## Phase 4 — Isolate heavy jobs from the request path (reliability → A-)
**Goal:** kill the recurring "site goes down" class for good. **Effort: L–XL. The highest-leverage reliability change left. VPS approval required.**

> ⭐ **CHOSEN as the permanent backup-wedge fix (2026-06-19).** The hardened backup still wedges the site: the 2h VACUUM-INTO read snapshot blocks WAL checkpointing → WAL grows to ~5 GB → the main Node process checkpoints it **synchronously** (better-sqlite3) → 97s event-loop block → watchdog abort (happened on the 2026-06-19 cron run). Interim mitigation shipped (`91570e1`): backup is now once-daily at 03:17 so a wedge lands off-peak.
>
> **Concrete first slice — checkpoint isolation (do this before the broader job migration):**
> 1. **Main `db` connection:** `wal_autocheckpoint = 0` (currently 500 at `deploy_saas.py:337`) so the request-serving process NEVER runs a synchronous checkpoint. Remove/neuter `runWalCheckpoint` (`:6127`, the 30-min PASSIVE) and the inline PASSIVE checkpoints in PriceRefCache (`:4077`), SpreadStats (`:5931`), and the embedded compaction (`:6456`) — a PASSIVE checkpoint of a 5 GB WAL still blocks.
> 2. **New checkpoint worker** (`wal_checkpoint_worker.js`, own systemd service, `Restart=always`, `nice -n19`/`ionice -c3`): internal loop every ~120s opens its own connection and runs `PRAGMA wal_checkpoint(TRUNCATE)`. This drains the WAL — including the post-backup 5 GB — **in a separate process**, so the main event loop is never blocked (worst case is brief SQLITE_BUSY on a main write during the final truncate, handled by `busy_timeout`). Deploy generator must add the service like the existing `albion-db-compaction` one.
> 3. **Safety:** with autocheckpoint=0, a dead worker = unbounded WAL → disk fill. Keep `[HEALTH] walMB` logging; add an alert/threshold and confirm the worker's `Restart=always` + a soak before trusting. Consider a high-watermark emergency PASSIVE in main only if walMB exceeds e.g. 3 GB (rare, bounded).
> 4. **Deploy + 72h soak:** this ships via a full `deploy_saas.py` (also lands Phase 1's `npm ci` + nodemailer 9 — verify a test email after). Watch `walMB` stays small in normal ops, and that a backup run no longer produces an `[EventLoop]` block or NRestarts bump. Then twice-daily backups can return.
> 5. **Then** the broader migration below (spread-stats / analytics / compaction off the main process) for full reliability.

One process does API + WS + NATS + DB writes + SpreadStats + analytics + compaction (~20 timers, `deploy_saas.py` `setInterval` sites). `maintenance_compaction.js` already proves the separate-systemd-timer pattern works.

- [ ] **4.1** Inventory the heavy jobs and their schedules (already located): market scan, `recomputeUserStats`, priceRef rebuild, `computeSpreadStats`, `runWalCheckpoint`, compaction, `checkDiskUsage`, `computeAnalytics`, NATS flush.
- [ ] **4.2** Move CPU/DB-heavy, non-request jobs into a **separate worker process** (`server/worker.js`, own systemd service) that opens its own SQLite connection (WAL already allows this). Start with the worst offenders: `computeSpreadStats` + `computeAnalytics` + compaction. Keep request-critical, lightweight timers in the web process.
- [ ] **4.3** Coordinate via the DB (`meta_config` lease/lock rows) or a tiny IPC so web + worker never run the same job concurrently. Preserve the existing overlap guards.
- [ ] **4.4** Keep the event-loop + RSS watchdogs in **both** processes.
- [ ] **4.5** Soak 72 h: `NRestarts=0`, no `[EventLoop]` panics, `/api/me` p95 unaffected during a spread-stats/analytics cycle.

**Acceptance:** user-facing API/WS/OAuth latency is unaffected while heavy jobs run; an analytics/compaction cycle can no longer wedge the web process.

**Risk/rollback:** medium–high (new process, shared DB). Mitigate: roll out one job at a time; the web-process fallback path stays until the worker proves stable; revert = re-enable the in-process timer.

---

## Phase 5 — Security & deploy hardening (security B → A-, deploy C- → B)
**Goal:** least-privilege, enforced CSP, safer pipeline. **Effort: M. Some VPS approval required.**

- [ ] **5.1** **Non-root service.** Create `albion` system user; `chown -R` `/opt/albion-saas`; set `User=albion`/`Group=albion` in the systemd unit (`deploy_saas.py:7607`); grant `:443` via `setcap cap_net_bind_service` or a reverse proxy. Verify the Discord bot, SQLite writes, and backup cron still work as the new user.
- [ ] **5.2** **CSP to enforce.** Observe `Content-Security-Policy-Report-Only` violations (`/api/csp-report`) in prod for ~1 week; reduce inline handlers / `innerHTML` (308 sites in `app.js`) where flagged; then flip `helmet` CSP on (`deploy_saas.py:1364`) in enforce mode with a tested policy.
- [ ] **5.3** **XSS surface reduction.** Audit the 308 `innerHTML` paths; route untrusted data through `esc()` (or `textContent`/DOM builders); specifically re-verify the intentional rich-tooltip HTML decode path. Add an ESLint rule to flag raw `innerHTML =`.
- [ ] **5.4** **Linting.** ESLint (security plugin) for JS, `ruff` for Python, in CI. Fix or baseline existing warnings.
- [ ] **5.5** **Staging.** Stand up a cheap staging target (or a `--staging` deploy to a second systemd unit/port) so backend changes get smoke-tested before prod. Pairs with Phase 3.
- [ ] **5.6** **Observability.** Replace grep-only `[HEALTH]` with a real alert: Discord webhook (or lightweight uptime monitor) firing on `dbMB`/`rssMB` thresholds, `NRestarts` increments, and `/healthz` failure.

**Acceptance:** service runs as non-root; CSP enforced with no console breakage; ESLint+ruff gate CI; a staging path exists; an alert fires on health regression without manual log-grepping.

---

## Phase 6 — Frontend modularization (architecture D → B-)
**Goal:** make `app.js` (20.8k lines) iterable again. **Effort: XL, lowest urgency — do continuously, not in one shot.**

- [ ] **6.1** Adopt a minimal module strategy that keeps the no-build-step ethos: native ES modules (`<script type="module">`), no bundler required. (Re-evaluate a light bundler like esbuild only if load perf needs it.)
- [ ] **6.2** Pull each feature area into its own module behind a stable interface: `market`, `crafting`, `transport`, `lootlogger`, `lootbuyer`, `alerts`, `profile`, plus shared `render`/`dom`/`api` helpers. The Phase 2 core extractions seed this.
- [ ] **6.3** One feature per PR, behavior-preserving, verified per tab at desktop + mobile widths before merge.
- [ ] **6.4** Same treatment for `style.css` (7.8k lines) → per-feature CSS or layers; and trim `index.html` (4.8k lines) toward templated/partial includes where practical.

**Acceptance:** no single frontend file > ~3k lines; a feature change touches one module; all tabs verified.

---

## Phase 7 — Repo & docs hygiene (C → A-)
**Goal:** clean working tree, single source of truth for docs. **Effort: S. Pure-local.**

- [ ] **7.1** Delete the stray `New Text Document.env` from disk (gitignored, never committed) — consolidate to the external secrets file. Confirm nothing reads it.
- [ ] **7.2** Triage root-level one-off scripts (`check_*.py`, `debug_*.py`, `diagnose_vps.py`, …) and the `tmp_check/` graveyard (~70 files): keep a documented few, delete the rest. They're gitignored, so this is local-only cleanup.
- [ ] **7.3** Archive stale planning/audit `.md` docs into `docs/archive/`; keep AGENTS.md's canonical set (AGENTS, CODEX_MEMORY_HANDOFF, PROJECT_FEATURE_INVENTORY, CHANGELOG, this plan) at root.
- [ ] **7.4** Decide track-or-ignore for the untracked files (`BETTER_SQLITE3_MIGRATION_PLAN.md`, `PROJECT_FEATURE_INVENTORY.md`, `crafting-pipeline-design.jsx`, `design-mockups/`).
- [ ] **7.5** Add a top-level `README.md` (currently none) with architecture, local-run, deploy, and the repo map — the real onboarding doc.

**Acceptance:** clean `git status`; no stray secret files; one canonical doc set; a README exists.

---

## Suggested execution order
1. **Phase 0** (urgent — no backup running).
2. **Phase 1** (fast, high-value, decoupled).
3. **Phase 2** (parallelizable, zero risk) — start alongside 1.
4. **Phase 3** (enables 2.2, 4, 5.4 on the backend).
5. **Phase 4** (biggest reliability win; needs 3).
6. **Phase 5** (hardening; 5.1/5.6 can start anytime, 5.5 pairs with 3).
7. **Phase 7** (cleanup; do opportunistically throughout).
8. **Phase 6** (continuous, long-tail).

## Rough sizing
- Phase 0: 1 session (gated on VPS approvals + off-peak window).
- Phase 1: 1 session.
- Phase 2: 2–3 sessions (one per core module + harness).
- Phase 3: 1 careful session (extract+deploy), splitting is long-tail.
- Phase 4: 2–4 sessions + 72 h soak.
- Phase 5: 2–3 sessions spread out.
- Phase 6: ongoing, weeks of opportunistic PRs.
- Phase 7: 1 session.
