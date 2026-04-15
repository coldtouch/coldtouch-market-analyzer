# Loot Tools Roadmap — Perfect-State Plan

> **Status:** Draft from 2026-04-15 research pass. Dispatch 4 parallel audit agents, synthesized into this one doc.
> **Scope:** Loot Logger + Loot Buyer only. Everything else untouched.
> **Intended reader:** You, over coffee. This is a planning doc, not a spec. Decisions noted as `DECISION:` and need your signoff before building.

---

## 0. TL;DR

You asked for four things specifically:
1. **Bigger, more readable preview icons on loot items** — yes, easy. Current icons are 22–24 px; I'll propose 36 px for preview strips, 40 px in expanded views, with a proper hover tooltip.
2. **Hover over preview/card → see who crafted it** — partially possible. **Only works for items captured from chests/vaults** (the Go client already reads the crafter name but doesn't forward it). **For items looted from corpses, the game protocol does not include crafter info** — this is not recoverable without hacking the client. I'll propose how to surface it where we have it and what placeholder to show where we don't.
3. **When players die, show they died AND what they died with** — possible, with caveats. The death packet only carries names, not equipment. But we can reconstruct "died with" by aggregating every `looted_from_name === victim` event that follows an `EvDied` — that gives us "what was picked up off the corpse by others." It's not their full inventory (items left in corpse aren't tracked) but it's meaningful and honest. I'll also propose a future expansion that captures nearby players' equipment via `EvCharacterEquipmentChanged` (currently unhandled).
4. **Move them to their own tab section** — yes, trivial HTML/CSS. They're currently the last two tabs in the "Trading" group; I'll promote them to a new **"Loot Tools"** group with its own nav separator.

Beyond those four, the audits surfaced a long tail of improvements. I've grouped them below by theme with effort T-shirt sizes (S/M/L/XL) and sequencing. **The phased rollout in §8 is my recommended build order; skim that first if you want the answer.**

---

## 1. Current State — One-Page Summary

### Loot Logger (`D:\Coding\albion_market_analyzer\app.js:5996-7500`, ~1500 LoC)
- **Live session:** WS events from Go client → `liveLootEvents[]` → `renderLootSessionEvents` → per-player cards
- **Upload mode:** parse `.txt` files from ao-loot-logger, same render pipeline
- **Accountability mode:** cross-reference loot session against chest captures, compute proportional deposit allocation, surface suspects
- **37 functions total**, 9 localStorage keys, 1 WS message type (`loot-event`, `death-event`), 11 CSS selectors starting with `.ll-`
- **Data per event:** `timestamp, looted_by_{name,guild,alliance}, looted_from_{name,guild,alliance}, item_id, quantity, weight, died` — no quality, no enchantment, no crafter
- **Death event:** only names + timestamp, no equipment/inventory. Special marker `item_id='__DEATH__'`

### Loot Buyer (`app.js:5140-6174`, ~1500 LoC)
- **3-phase system:**
  - Phase 1 — Buy Decision Helper: verdict (BUY/MAYBE/SKIP), margin %, per-item risk badges
  - Phase 2 — Sell Optimizer: 85% threshold (instant vs market), trip grouping by city, copy shopping list
  - Phase 3 — Lifecycle Tracker: tracked tabs with progress bars, inline sale recording, auto-match from in-game mail (`ReadMail` opcode → `/api/sale-notifications`)
- **Chest capture:** Go client sends full item list with `{itemId, quality, enchantment, crafterName}` — but the **crafter field is captured but NOT forwarded by `vps_relay.go`**. This is the single most impactful unlock in this entire doc (see §4).
- **Sale matching:** backend in `deploy_saas.py` matches `ReadMail` opcode → tracked tab by `(item_id, recent timestamp)`. Shows "(auto-matched)" badge on the Recent Sales feed.

### What's shared between them
- `window._chestCaptures` (live from WS) and `lootBuyerCaptures` (in-memory, max 20) — **two separate globals for the same data**, manually sync'd at 3 sites. Technical debt.
- `/api/batch-prices` (unauth), `/api/loot-sessions`, `/api/loot-session/{id}` (auth-gated)
- Shared session-name + whitelist + autosave keys in localStorage (just added yesterday)

### Tab position today (`index.html:336-350`)
```
<!-- Trading group -->
transport | live-flips | portfolio | loot-buyer | loot-logger
```
No group separator in the UI. Visually they blend with trading features.

---

## 2. User-Explicit Requests — How I'd Build Each

### 2.1 Bigger, more readable preview icons  `[S, 2-4 hrs]`

**Current sizes** (from style.css audit):
| Class | Where it appears | Size | File:line |
|---|---|---|---|
| `.ll-preview-icon` | Collapsed player card strip | 22×22 | style.css:1102 |
| `.ll-item-icon` | Expanded item row | 22×22 | style.css:1196 |
| `.loot-item-icon` | Loot Buyer Phase 1 grid | 24×24 | style.css:4126 |
| `.sale-notif-icon` | Recent sales feed | 28×28 | style.css:4607 |
| `.flip-card .flip-icon` | Flipper card (for ref) | 36×36 | style.css:1464 |
| `.mat-icon` | Crafting material rows | 22×22 | style.css:1832 |

**Proposal:**
- **Expanded item row:** 22 → **40 px** (matches crafting card `.item-icon` which is already larger)
- **Preview strip (collapsed):** 22 → **32 px** in default, 36 px on hover
- **Loot Buyer item grid:** 24 → **40 px**
- Keep `image-rendering: pixelated` everywhere (Albion sprites look bad when interpolated)
- Add a 1 px subtle border on each icon so low-contrast items (grey pants, dark leather) don't disappear against dark cards
- Reserve small (22 px) only for the "+N more" overflow indicator in preview strips

**Side note:** the preview strip currently dedupes per-card (Set within `_llRenderFiltered`), so the strip shows ≤ 8 unique items. At 32 px × 8 = 256 px + gaps = fits in a ~320 px player card, which is the narrow-phone worst case. Larger = more legible, no layout breakage expected.

### 2.2 Hover tooltip showing who crafted an item  `[M, 1 day]`

**Honest status:**

| Source | Crafter info available? | Why |
|---|---|---|
| **Chest/vault capture** (Loot Buyer) | ✅ Yes, Go client already reads it in `event_container_items.go:48` | Equipment items in containers carry crafter |
| **Looted items** (Loot Logger) | ❌ No | The `EvOtherGrabbedLoot` packet (opcode 277 post-Apr13) contains only `{lootedFrom, lootedBy, itemNumId, quantity, isSilver}` — no crafter, quality, or enchantment. Protocol limitation. |

**Proposal — what we CAN do:**

1. **Extend Go client to send crafter on chest captures** (one-line addition to `CapturedItem` struct + `SendChestCapture` in `vps_relay.go`). Not a breaking change; backend can ignore the field until the frontend uses it.
2. **Extend backend** (`deploy_saas.py`) to persist `crafter` in `loot_tabs` item JSON. No schema change needed if we're storing items as a JSON blob (verify in HANDOFF.md).
3. **Build a reusable hover tooltip** (we currently only use the browser `title=` attribute — no rich tooltips anywhere in the codebase). Proposed CSS-only implementation using `:hover` + `::after` with `data-tooltip-content`. For richer HTML content (icon + rows), a small JS helper — total ~60 lines.
4. **Tooltip content on hover:**
   - Loot Buyer items (always): `item name • Q{quality} • @{enchant} • T{tier} • Crafted by {name} • Market value: {price}`
   - Loot Logger items: `item name • T{tier} • Market value: {price} • Crafter: unknown (loot drop)` — honest about the gap
   - Unknown crafter placeholder: "Unknown — picked up as loot" (not a bug, a game limitation)

**What's explicitly impossible:** backfilling crafter on historical loot logs. The data was never in the packet. If you need crafter-by-item for a previous PvP session, we can't.

### 2.3 Death tracking — "they died and what they died with"  `[M, 1-2 days for v1; L for equipment-at-death]`

**Problem statement:** user wants each death in a session to be visually prominent, identify the victim and killer, and show "what loot they had when they died."

**What the Go client sees today** (`event_death.go:19-62`):
- `EvDied` (opcode 167): `{victimName, victimGuild, killerName, killerGuild}`
- `EvKilledPlayer` (opcode 166): same fields
- **Nothing about equipment or inventory**

**What CAN be reconstructed (v1):**

After an `EvDied` fires for player X, any subsequent `EvOtherGrabbedLoot` event where `looted_from_name === X` is *definitionally* something looted off X's corpse. We can:

1. Track deaths in a separate `liveDeaths[]` array keyed by `(victimName, timestamp)`
2. For each death, maintain a rolling "loot window" (say, 5 min after death) — every loot event in that window where victim matches gets attributed to that death
3. Aggregate items + estimated silver value
4. Render as a dedicated "Deaths" section at the top of the session view

**Mockup — Deaths section:**

```
 ☠ Deaths in this session (3)
┌─────────────────────────────────────────────────────────────┐
│ ⚔ YourBuddy died to EnemyMage at 14:32           [friendly] │
│   Items recovered from corpse: 7 (est. 820k silver)         │
│   🗡 T8_MAIN_SWORD    📦 T7_ARMOR_LEATHER   🎒 T8_BAG  +4   │
│   Recovered by: Coldtouch (5 items, 640k), Ally2 (2, 180k)  │
├─────────────────────────────────────────────────────────────┤
│ 💀 EnemyScout died to you at 14:41               [enemy]    │
│   Items recovered: 12 (est. 2.1M silver)                    │
│   ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

**Caveat to surface honestly in UI:** *"Shows items picked up off the corpse by tracked players. Items left unlooted or looted by players outside your capture range are not counted."*

**Implementation:**
- New function `buildDeathTimeline(events) → [{victim, killer, timestamp, lootedItems[], estimatedValue, lootedBy{}}]`
- New render function `renderDeathsSection(deaths)` — rendered above the per-player cards
- CSS: dedicated `.ll-death-card` with skull icon, red border for friendly deaths, green border for enemy deaths
- Add a time-sorted filter: "Show only events from death window of Player X" (click death card → filters main view)

**Future expansion (L, 3-5 days, requires Go client work):**

Add an `EvCharacterEquipmentChanged` (opcode 99) handler to the Go client. Whenever any visible player changes equipment, we record their current loadout in a `playerEquipmentCache` (sync.Map, 5-min TTL, same pattern as `playerCache`). When `EvDied` fires, we attach their last-known equipment to the death event payload. That gives us "died with" in the literal sense — the gear they had equipped at death, even if nobody looted it.

Limitations even in the future version:
- Only tracks players we've seen equipment events for (line-of-sight in zone)
- Doesn't show consumables or inventory bags, just equipped gear
- Brand-new entrants we just saw appear won't have equipment data

**Recommended:** ship v1 (reconstruct from loot) immediately; scope future version after v1 proves useful.

### 2.4 Move loot features into their own tab section  `[S, 1 hr]`

**Today** (`index.html:336-350`):
```html
<div class="nav-group"> <!-- Trading group -->
    <button data-tab="transport">Transport Routes</button>
    <button data-tab="live-flips">Live Flips</button>
    <button data-tab="portfolio">Portfolio</button>
    <button data-tab="loot-buyer">Loot Buyer</button>
    <button data-tab="loot-logger">Loot Logger</button>
</div>
```

**Proposal:**
```html
<div class="nav-group"> <!-- Trading group -->
    <button data-tab="transport">Transport Routes</button>
    <button data-tab="live-flips">Live Flips</button>
    <button data-tab="portfolio">Portfolio</button>
</div>
<div class="nav-group nav-group-loot"> <!-- Loot Tools -->
    <span class="nav-group-label">Loot Tools</span>
    <button data-tab="loot-buyer">Loot Buyer</button>
    <button data-tab="loot-logger">Loot Logger</button>
    <!-- Future: loot-analytics -->
</div>
```

And a small CSS rule:
```css
.nav-group-loot {
    border-left: 2px solid var(--accent-dim);
    padding-left: 0.5rem;
    position: relative;
}
.nav-group-label {
    display: block;
    font-size: 0.65rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 0.2rem;
}
```

Could also rename the tab buttons to emphasize parity:
- `Loot Buyer` → stays (well-known name now)
- `Loot Logger` → stays

Plus update the command palette (`openCmdK`, `tabLabels` at `app.js:9781`) so the Loot Tools tabs are grouped in search results too.

**DECISION:** `Loot Tools` name ok, or do you want `PvP Tools` / `Post-Fight` / `Guild Tools`? My vote: **Loot Tools** — it's literal and discoverable.

---

## 3. Improvement Catalog — Beyond the Explicit Asks

### A. Visual & UX polish  `[mostly S]`

| # | Item | Size | File |
|---|---|---|---|
| A1 | Bigger icons everywhere (§2.1) | S | style.css |
| A2 | Rich hover tooltips (§2.2) | M | new component |
| A3 | Top-of-session summary strip: total events, total value, deaths, players, duration | S | app.js |
| A4 | Color-coded left border on player cards (green=friendly, red=enemy, grey=unknown) | S | style.css |
| A5 | Brighter highlight of top-value item per player (small `⭐` badge on priciest item in each card) | S | app.js |
| A6 | Empty-state illustrations (Loot Logger shows a screenshot of starting a session; Loot Buyer shows chest-capture flow) | M | index.html |
| A7 | 375 px breakpoint — currently only 600/768 px, narrow phones break on toolbar | S | style.css |
| A8 | Touch targets to 44×44 px (remove-player button, rename pencil, delete x) | S | style.css |
| A9 | Always-visible remove button on mobile (currently `:hover` only — unusable on touch) | S | style.css |
| A10 | Replace prompt() for rename with an inline-editable field | S | app.js |
| A11 | Keyboard shortcuts: `?` for help, `E` to expand all, `C` to collapse all, `F` to focus search | S | app.js |
| A12 | `Esc` closes whitelist modal (currently click-outside only) | XS | app.js |
| A13 | ARIA labels on all icon-only buttons + status dots (accessibility gap) | S | everywhere |
| A14 | "Copy to Discord" preview before copying — show what will land in clipboard | S | app.js |

### B. Death tracking (§2.3)  `[M-L]`

| # | Item | Size |
|---|---|---|
| B1 | Deaths section at top of session view, v1 (reconstruct from loot events) | M |
| B2 | Click death → filter main view to only that victim's loot chain | S |
| B3 | Death timeline mini-chart (horizontal timeline showing when deaths happened) | S |
| B4 | Estimated loss aggregation per friendly death / estimated gain per enemy death | S |
| B5 | Filter toggle: "Show only events from [death X]" | S |
| B6 | **Future:** EvCharacterEquipmentChanged Go client handler + equipment-at-death in death event payload | L |

### C. Crafter attribution (§2.2)  `[M total]`

| # | Item | Size |
|---|---|---|
| C1 | Extend `CapturedItem` + `SendChestCapture` to include crafter name | XS (Go client, 5 lines) |
| C2 | Backend persists crafter in loot_tabs items JSON | S |
| C3 | Frontend tooltip shows crafter on Loot Buyer items | M (needs tooltip component from A2) |
| C4 | "Items crafted by X" aggregation — group tracked tabs by crafter, show top crafters | S |

### D. Information architecture  `[S-M]`

| # | Item | Size |
|---|---|---|
| D1 | Move loot-buyer + loot-logger to new "Loot Tools" group (§2.4) | S |
| D2 | Sub-navigation pills for Loot Logger modes (Sessions / Upload / Accountability) — currently 3 buttons, convert to unified pill bar with badge counts (e.g. `Sessions (12)` `Upload` `Accountability (3 captures)`) | S |
| D3 | Cross-link: session detail → "Run accountability check on this session" pre-fills the accountability tab | S |
| D4 | Cross-link: accountability suspects banner → "Buy back missing items" button that opens Loot Buyer with the missing items pre-filled | M |
| D5 | Cross-link: chest capture card → "Create tracked tab from this" button on every capture chip | S |
| D6 | Loot Logger landing page: three large buttons (Start Live Session / Upload Log / Run Accountability) + recent sessions below — clearer entry point for new users | M |

### E. Technical / code organization  `[M-L, unblocks future work]`

| # | Item | Size |
|---|---|---|
| E1 | Extract loot code from app.js into `app.loot-logger.js`, `app.loot-buyer.js`, `app.loot-shared.js` (requires `<script>` tag order and global-scope audit) | L |
| E2 | Consolidate `window._chestCaptures` and `lootBuyerCaptures` into one store with a single `onCaptureChange` pub/sub | M |
| E3 | Consolidate `liveSession*` flags into a single state object: `liveSession = {active, saved, events, name, sessionId}` | S |
| E4 | Memoize price map by session ID (avoid refetch on every filter change) | S |
| E5 | Virtualize player card list for large sessions (> 50 players) — only render visible | M |
| E6 | Debounce all filter/sort inputs at 200 ms; filter in a Worker for 1000+ event sessions | M |
| E7 | Replace innerHTML bulk writes with DocumentFragment + keyed replaceChildren | M |
| E8 | Bound live event queue — cap at 10k events, warn user to save, drop oldest with marker | S |
| E9 | Add JSDoc types for event, player, session, capture shapes | S |
| E10 | Unit tests for `buildDeathTimeline`, `processUpgradeFlips`, `isWhitelistedEvent`, accountability allocator (pure functions, testable) | M |
| E11 | Service worker v4 bump when loot code ships | XS |

### F. Cross-feature integrations  `[M]`

| # | Item | Size |
|---|---|---|
| F1 | Sessions ↔ Loot Tabs link: if a loot session timestamp-overlaps a tracked tab's purchase, show a badge on both | M |
| F2 | Sale notifications → Loot Logger: if mail says "X sold", and X appears in a loot session, flag it in the session view | M |
| F3 | Unified `capture bus` so chest captures fire a DOM event that both features subscribe to — cleaner than shared globals | M |
| F4 | Import from ao-loot-logger's `.txt` into both features simultaneously (currently only imports to logger) | S |

### G. New feature concepts  `[each S-L, pick favorites]`

| # | Item | Value | Size | Notes |
|---|---|---|---|---|
| G1 | Guild leaderboard (historical top looters, earners, biggest deaths) | High | L | Needs backend aggregation endpoint |
| G2 | Session comparison (diff two sessions side-by-side) | Med | M | Client-side only |
| G3 | Heatmap/timeline visualization (horizontal bar, when events happened) | Med | S | Chart.js or hand-rolled SVG |
| G4 | Shareable read-only URL for a session (guild officer → members) | High | M | Backend: add public token per session |
| G5 | Friendly-fire detection (`looted_from_guild === looted_by_guild`) | Med | S | Surfaces allied-player corpse looting |
| G6 | Per-player trend: "Coldtouch has 92% deposit rate over last 10 sessions" | High | M | Backend aggregation |
| G7 | Auto-session-naming (infer from primary guild + day, or top killer) | Low | S | Quality-of-life |
| G8 | Whitelist presets: "My guild only", "My alliance only" | High | S | One-click auto-populate from session data |
| G9 | Copy-to-Discord templates (regear report, GvG summary, loot split) | High | M | Multiple format buttons |
| G10 | Loot split calculator inside session view (split silver/items N ways by rules) | High | L | Dirtworks-adjacent feature |
| G11 | Item filter chips on session view (T6+, T7+, only weapons, only bags, > 100k value) | High | S | We have tier filters already; extend |
| G12 | Favorite item lists in Loot Buyer — if tab contains my favorited items, highlight | Low | S | |
| G13 | "What should I buy?" AI verdict explanation — expand the margin % into a plain-language reasoning | Med | M | Uses existing verdict data, just formats |
| G14 | Trip summary across a play session: total silver in, out, profit, deaths, loot events | High | M | Uses both features together |

---

## 4. The Single Biggest Unlock

If I had to pick one change that multiplies the value of everything else: **forward the crafter name on chest captures from the Go client.**

**Why it's the biggest unlock:**
- The data is already being read (`event_container_items.go:48` — `globalItemCache` already has it)
- It's a ~5-line change in `vps_relay.go` + a tiny backend accept
- It enables: Loot Buyer crafter tooltips, crafter leaderboards (G1), "items I crafted that are on the market" workflows, and any future guild-crafter-performance tracking
- Once in the database, every future tracked tab enriches itself automatically
- Zero risk — adding a field to the JSON payload, nothing depends on its absence

I'd ship this in week 1 regardless of which other items you pick.

---

## 5. What's Explicitly NOT Possible

Being honest up front so these don't get promised:

| Ask | Feasibility | Why |
|---|---|---|
| Crafter name on pure loot drops | ❌ impossible | Game doesn't include it in the loot packet |
| Exact inventory a player died with | ⚠️ only indirect | Death packet has no inventory; we can only show "what others picked up" |
| Weapon/ability used to kill | ❌ impossible | Not in EvDied/EvKilledPlayer packet |
| Backfilling historical data | ❌ impossible | Whatever wasn't captured then is gone |
| Real-time other-player inventory | ❌ impossible | No packet exposes it unless they open a container we observe |
| Distinguishing instant-sell vs sell-order in loot stream | ❌ impossible | Loot pickup is the same event regardless |

Everything else on this doc is feasible.

---

## 6. Mobile & Accessibility Audit Summary

Short list of things that need fixing regardless of which features you prioritize:

- `.ll-remove-player` button is `:hover`-revealed — broken on touch devices (A9)
- Rename pencil is `0.68rem × 0.68rem` — too small for any finger (A8)
- Delete buttons use `0.65rem` text — very hard to read (A8)
- No `aria-label` on any icon-only button (A13)
- Status dots (8 px) are color-only semantic — fails colorblind accessibility (A13: add pattern/symbol)
- 375 px screens (narrow iPhones) break the toolbar layout (A7)
- `Esc` doesn't close the whitelist modal (A12)

None of these are blockers but they'll accumulate into a worse experience if left.

---

## 7. Performance & Scale Audit

**Current risks (from app.js audit):**

- `liveLootEvents[]` is **unbounded** — a live session left running for hours will grow without limit. At ~500 events per PvP hour, 4-hour guild GvG = 2000 events × 50 players = player cards become laggy. Proposed: bound at 10k events with a warning to save+reset (E8).
- `_llRenderFiltered` does a **full innerHTML rebuild** on every filter/sort change. At 50+ player cards with 10+ items each, that's a visible stutter. Proposed: keyed DOM reuse (E7).
- Price map is **refetched on every render**, not cached per session (E4). Worst case: user types into the search box → 300 ms debounce → full refetch → render.
- No virtualization (E5). At 100+ players (huge ZvZ), scrolling gets janky.

None of these bite on a typical solo gank session (5-20 events, 3-10 players). They matter when guilds do serious content.

---

## 8. Recommended Phased Rollout

My proposed sequencing — each phase builds on the previous, each ships independently.

### Phase 1 — **Visual + tab reorg** (1-2 days)
Foundation work that makes everything else feel better.
- D1: New "Loot Tools" tab group
- A1: Bigger icons (22 → 32/40 px)
- A2: Reusable hover tooltip component
- A7, A8, A9: Mobile/touch fixes
- A12, A13: Accessibility quick wins
- A3: Top-of-session summary strip
- A4: Color-coded card borders (enemy/friendly)
- E11: SW cache bump

**Ship gate:** whitelist/autosave/session-name features from yesterday continue working; preview icons visibly bigger; hover tooltip works on at least one surface (Loot Buyer item name) as proof.

### Phase 2 — **Death tracking v1** (2-3 days)
The most user-visible win for PvP guilds.
- B1: Deaths section at top of session view (reconstruct-from-loot)
- B2: Click death → filter to that death's loot chain
- B3: Death timeline mini-chart
- B4: Estimated loss/gain per death
- A14: Copy-to-Discord preview for death reports

**Ship gate:** Every death in a session is visible with estimated value; click-filter works; copy-to-Discord includes deaths.

### Phase 3 — **Crafter attribution** (1-2 days)
Small scope, big enabler for future work.
- C1: Go client forwards crafter on chest captures
- C2: Backend stores it
- C3: Frontend tooltip shows it on Loot Buyer items
- C4: Simple "top crafters" aggregation on profile tab (if feasible)

**Ship gate:** Opening a chest → hover any crafted item → see the crafter's name. Untested items show "Unknown — looted" placeholder.

### Phase 4 — **Cross-feature integrations** (2-3 days)
Stitch the two features into one cohesive flow.
- D3, D4, D5: Cross-links between session view / accountability / Loot Buyer
- F3: Unified capture event bus
- E2: Consolidate chest capture globals
- F1, F2: Session ↔ tracked tab overlap badges

**Ship gate:** Every loot session has at least one link out to Loot Buyer or Accountability from a relevant view.

### Phase 5 — **New features (pick 2-3)** (3-7 days depending on picks)
Your call. My vote:
- G8: Whitelist presets (high value, low cost)
- G11: Item filter chips (high value, low cost)
- G9: Discord templates (high value, medium cost)
- Stretch: G4 Shareable URLs, G1 Guild leaderboard

### Phase 6 — **Equipment-at-death** (3-5 days, discretionary)
Only if the v1 death tracking proves popular:
- B6: EvCharacterEquipmentChanged handler in Go client, equipment snapshot cache, attach at death event

### Phase 7 — **Performance hardening** (2-4 days, discretionary)
Once a big guild hits a real scaling issue:
- E5: Virtualized player card list
- E6: Worker-based filtering
- E7: Keyed DOM updates
- E4: Price map memoization
- E8: Bounded live event queue

### Phase 8 — **Code split** (2-3 days, discretionary)
Only worth doing once feature surface stabilizes:
- E1: Split app.js into loot-scoped files
- E9: JSDoc types
- E10: Unit test suite for pure functions

**Realistic pace:** Phase 1-3 in the first 1-2 weeks, Phase 4 the following week. Phases 5-8 are strategic picks based on user feedback.

---

## 9. Decisions I Need From You

Before building, I want your signoff on:

1. **Tab group name**: `Loot Tools` (my vote) vs `PvP Tools` vs `Guild Tools` vs `Post-Fight`?
2. **Deaths v1 vs v2**: Ship the "reconstruct from loot" version first and iterate, or wait to build equipment-at-death properly?
3. **Tooltip library**: Hand-roll (60 LoC, zero deps) vs pull in Popper.js (~15KB, better positioning)? My vote: hand-roll, this is a vanilla-JS codebase.
4. **Phase 5 picks**: which 2-3 from G1-G14?
5. **Backend deploys required**: C2 (crafter storage) and G4 (public share tokens) need backend changes = `deploy_saas.py` deploys. Are you OK with 1-2 deploys over the next 2 weeks?
6. **Refactor scope**: are we OK with large changes to existing code (E1, E2) or should I keep everything additive for now?

---

## 10. What I'd Need From You to Move Fast

- **Ungated Go client testing:** a few live PvP sessions with the new Go client build so I can verify crafter forwarding, equipment-at-death, and chest-capture changes work end-to-end. If the client isn't runnable in-game during dev, progress stalls.
- **One real loot session file** (exported from a recent GvG): so I can iterate the Deaths section against realistic data without you being online
- **Screenshots** of any specific mobile breakage you've hit personally — that'll bump the 375 px work up the priority list
- **Priority call on Phase 5 features** once you've read this

---

## 11. Appendix — Full Audit References

All agent audits are summarized below; file:line references throughout the doc map to these findings.

### 11a. Loot Logger functions (37 total) — see §1 summary; full table in agent audit
Key hotspots:
- `renderLootSessionEvents` at `app.js:6673` — the rendering beast
- `_llRenderFiltered` at `app.js:6754` — full-rebuild on every filter change (perf opportunity)
- `runAccountabilityCheck` at `app.js:7108` — proportional deposit allocation logic
- `handleLootLoggerWsMessage` at `app.js:7425` — WS event router
- Death marker set at `app.js:7426-7437` (`item_id: '__DEATH__'`)

### 11b. Loot Buyer functions (30+) — see §1 summary
Key hotspots:
- `analyzeLoot` at `app.js:5468` — Phase 1 entry
- `buildSellPlan` at `app.js:5627` — Phase 2 trip grouping with 85% threshold
- `loadTrackedTabs` at `app.js:5828` — Phase 3 entry
- `showSaleForm` at `app.js:6007` — inline sale recording (already replaced prompt())
- `buyThisTab` at `app.js:5521` — "I Bought This" → `/api/loot-tab/save`

### 11c. Go client event handlers
Full mapping from agent audit:
- Loot event (opcode 277): `event_loot.go:119-126`
- Death events (166/167): `event_death.go:19-62` — **no equipment data in packet**
- Character cache (EvNewCharacter 38, EvCharacterStats 154): `event_loot.go:62-102` — **cached locally, not sent**
- Container capture (108): `operation_container_open.go:54-60`, items in `event_container_items.go:14-76` — **crafter name captured, not sent**
- Vault info (65/66): `event_vault_info.go:34-63` — used for GUID matching only

### 11d. CSS + structure
- Both tabs in `nav-group` "Trading group" at `index.html:336-350`
- 90+ CSS selectors for loot features (lines 780-4968 in style.css)
- Icon sizes: see §2.1 table
- Only 2 modals exist (`whitelist-modal`, `feedback-modal`, `chart-modal`) — pattern is consistent `.modal` + `.hidden` toggle
- Responsive breakpoints: 768 px (tablet), 600 px (phone) — **no 375 px**
- Dead CSS: `.ll-pulse-dot` unused, `.loot-log-item-row` minimally used

### 11e. API endpoints for loot features
| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/api/loot-evaluate` | POST | Y | Phase 1 verdict |
| `/api/loot-tab/save` | POST | Y | Phase 3 create |
| `/api/loot-tabs` | GET | Y | List tracked |
| `/api/loot-tab/{id}` | GET, DELETE | Y | |
| `/api/loot-tab/{id}/sale` | POST | Y | Record sale |
| `/api/loot-tab/{id}/status` | PATCH | Y | Open/partial/sold |
| `/api/sale-notifications` | GET | Y | Mail-matched sales |
| `/api/loot-upload` | POST | Y | Session from .txt |
| `/api/loot-sessions` | GET | Y | List sessions |
| `/api/loot-session/{id}` | GET, DELETE | Y | |
| `/api/batch-prices` | POST | N | Item prices |

---

## 12. Notes & Open Threads

- **ao-loot-logger compatibility:** our `.txt` format is identical to theirs (10 fields, same header). We could add columns (quality, enchantment, weight) without breaking their parsers — they ignore trailing columns. Worth doing in Phase 3 alongside the Go client crafter change.
- **Backend/frontend version skew risk:** if I ship frontend tooltips expecting a crafter field before the Go client update lands, the field is `undefined` and tooltips gracefully fall back to "Unknown — looted". That's the safe staging order.
- **Service worker:** current cache is `coldtouch-v3`. When we ship Phase 1, bump to `v4`. Reminder to users: hard refresh once.
- **Feedback loop:** I'd like a short list of "what a perfect post-fight review looks like for you and your guild" to validate Phase 2 against. Even 5 bullet points from a real PvP night would sharpen the Deaths UI.

---

**End of roadmap.** Happy reviewing. I'll wait on Phase 1 vs 2 ordering + the decisions in §9 before starting any code.
