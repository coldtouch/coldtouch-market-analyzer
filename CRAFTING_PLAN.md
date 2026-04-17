# Crafting & Refining Overhaul — Master Plan

> **Status:** Research-complete planning doc, 2026-04-17. Decisions noted as `DECISION:` need user signoff before building.
> **Authors:** Claude Opus 4.7 with 4 parallel research agents (refining mechanics, crafting mechanics, competitive tools, crafter workflows).
> **Scope:** Crafting Profits tab overhaul + new Refining Materials section + cross-tab synergies. Touches `app.js` (Crafting/RRR/Journals/Repair sections), `index.html` (new tab + modal), `recipes.json` (sub-recipe walking already supported, needs focus-cost data), and the Market Browser / Transport / BM Flipper / Live Flips / Loot Buyer integration points.
> **Why now:** The user said "tackle all of em." Existing 5-phase plan in `HANDOFF.md` Section 13 was scoped before this research. This doc replaces that — same phases reorganized around real-world crafter workflows + a competitive moat that no other tool has.

---

## TL;DR — The Big Bets

We have **four moats no competitor has**:

1. **Custom Go client packet capture** — we can read realised RRR + actual crafting events from the user's game session. No web tool can do this.
2. **Cross-tab integrated ecosystem** — Crafting talks to Market Browser, Transport, BM Flipper, Loot Buyer, Live Flips in one app. AlbionFreeMarket has the closest equivalent; nothing's wired together properly.
3. **Account-system + saved spec profile** — set spec/mastery once, propagate everywhere. Every competitor makes you re-enter per tab.
4. **Live VPS NATS feed** — sub-second price updates, not 5-minute polling. We already have this for Live Flips; crafting can ride the same data.

**The single highest-leverage feature that no competitor has at all:** a "Top-N Craft Right Now" ranker that takes your spec/city/focus budget and sorts the entire 5,026-recipe catalog by **silver/focus** and **silver/hour**. AlbionFreeMarket has all the inputs and outputs but doesn't rank. Building this first establishes us as the destination tool for the daily-quest-grinder archetype (the largest single user segment per workflow research).

---

## Part A — Formula Audit: Bugs in Current Code

The cross-checked research surfaced **6 formula issues** in `app.js`. Some are critical (active money loss for users); some are missing functionality.

### A1. `basePB` mismatched between activities — CRITICAL

**Current code** ([app.js:1812](.claude/worktrees/friendly-dubinsky/app.js#L1812), [app.js:3523](.claude/worktrees/friendly-dubinsky/app.js#L3523)):
```js
const basePB = 18; // Royal city base production bonus
const basePB = activityType === 'refining' ? 18 : 18; // both 18
```

**Research finding:** Sources disagree on whether crafting base is 15 or 18. Refining is unambiguously 18.

| Source | Crafting basePB | Refining basePB |
|---|---|---|
| OneLifeGaming guide | 15 | 18 |
| AlbionFreeMarket calculator | 15 (implied) | 18 |
| Wiki Local_Production_Bonus | 18 (ambiguous on activity) | 18 |
| AlbionMaster / Brannstroom | 18 | 18 |
| Refining research agent | 18 (both) | 18 |
| Crafting research agent | **15 (crafting only)** | 18 |

**`DECISION-A1`:** Pick one of:
- **(A)** Stay at 18/18 — matches majority of calculators, in-game tooltip math reportedly aligns. Risk: if the OneLifeGaming/AFM authors are right, our crafting profit numbers are slightly optimistic by ~2%.
- **(B)** Split to 15/18 with a footnote — matches OneLifeGaming and AFM. Risk: if we're wrong, we under-report crafting profit.
- **(C)** Make it user-configurable with a default of 18/18 and a help-tip explaining the disagreement. Lowest risk but adds clutter.

Recommendation: **(C) for v1, then (A) or (B) after one in-game RRR-history capture session via the Go client.** Our packet-reading client can resolve this for us in ~30 minutes of crafting.

### A2. City-specialty bonus not applied — HIGH

**Current code:** Settings panel has a "City Bonus" dropdown with hard-coded 15/20% values, but **the bonus is not auto-detected from the recipe + city pairing**. User has to know what to pick.

**Correct city map:**

| City | Refining specialty (+40% PB) | Crafting specialty (+15-18% PB) |
|---|---|---|
| **Lymhurst** | Fiber → Cloth | Bow, Cursed Staff, Mage Armor (Cloth) |
| **Bridgewatch** | Hide → Leather | Crossbow, Dagger, Cursed Staff, Plate Armor |
| **Fort Sterling** | Wood → Planks | Hammer, Quarterstaff, Holy Staff, Plate Armor |
| **Thetford** | Ore → Metal Bars | Cursed Staff, Fire Staff, Cloth Armor |
| **Martlock** | Stone → Stone Blocks | Axe, Quarterstaff, Frost Staff, Leather Armor |
| **Caerleon** | (none for raw refining) | Capes, Tools, Food, War Gloves, Magic Staves |
| **Brecilien** | (none) | (none — combat hub) |

**`DECISION-A2`:** I'll build a `CITY_SPECIALTY` map per category and auto-apply when the user picks a city + the recipe's category matches. User can still override.

### A3. Focus reduction formula wrong — CRITICAL

**Current code** ([app.js:1818](.claude/worktrees/friendly-dubinsky/app.js#L1818)):
```js
function calculateFocusCost(baseCost, specLevel, masteryLevel) {
    const reduction = (specLevel * 0.6 + masteryLevel * 0.3);
    return Math.max(1, Math.floor(baseCost * (1 - reduction / 100)));
}
```

This is a linear reduction — wrong. Real formula is exponential:

```js
// CORRECT (per forum thread 64414, wiki, AlbionFreeMarket calc, multiple confirmations)
function calculateFocusCost(baseCost, mainSpecLevel, otherSpecLevels, masteryLevel) {
    // Per wiki: 0.5^(efficiency / 10000), efficiency in points
    // Mastery (5 tiers × 100 levels × 30) = up to 15,000
    // Main spec (target tier, 100 × 250) = up to 25,000
    // Other specs contribute much less (×30 per level)
    const efficiency = (masteryLevel * 30)
                     + (mainSpecLevel * 250)
                     + (otherSpecLevels * 30);
    return Math.max(1, Math.ceil(baseCost * Math.pow(0.5, efficiency / 10000)));
}
```

**Impact:** At spec=100/mastery=100, our current code says reduction = 0.6×100 + 0.3×100 = 90% off → 10% of base. The real answer is `0.5^((100×30 + 100×250)/10000) = 0.5^2.8 = 14.4%` of base — close, but **the slope is completely wrong** so for partial spec our numbers are way off.

`DECISION-A3`: Replace formula. Add a tooltip explaining "main spec" vs "other spec" so users know which input drives the curve.

### A4. Tax rate stale — HIGH

**Current code:**
```js
const TAX_RATE = 0.03;      // 3% market transaction tax
const SETUP_FEE = 0.025;    // 2.5% listing setup fee
```

**Reality (per devtracker + forum 169251 + 2023 patch):**
- **Premium**: 4% sale tax + 2.5% setup = **6.5%** total
- **Non-Premium**: 8% sale tax + 2.5% setup = **10.5%** total

Our 3% is from a pre-2021 era. Users on Premium are **under-projecting tax by 33%**; non-premium users by **167%**.

`DECISION-A4`: Add a `userIsPremium` toggle (default on — most active players have premium). Update TAX_RATE to 0.04/0.08 conditionally. Save preference in localStorage. **This is the most user-impactful fix in the entire plan.** Note: this also affects [Transport](.claude/worktrees/friendly-dubinsky/app.js#L1080), [BM Flipper](.claude/worktrees/friendly-dubinsky/app.js#L3420), and [Portfolio](.claude/worktrees/friendly-dubinsky/app.js#L9411) — must update everywhere `TAX_RATE` is referenced.

### A5. Item Value formula not implemented — MEDIUM

We have no `itemValue(itemId)` function. Item value drives **station fees** (the per-item nutrition cost) and is needed for the formal Black Market sell-price model.

```js
// Per wiki Item_Value page
function itemValue(itemId) {
    const tier = parseInt(itemId.match(/^T(\d)/)?.[1] || 0);
    const ench = parseInt(itemId.match(/@(\d)/)?.[1] || 0);
    const recipe = recipesData[itemId];
    if (!recipe) return 0;
    // Sum non-artifact mats (each unit) × base
    const base = 16 * Math.pow(2, tier + ench - 4);
    let nonArtifactMats = 0;
    let artifactValue = 0;
    for (const m of recipe.materials) {
        if (isArtifact(m.id)) {
            artifactValue += artifactValueOf(m.id, tier);
        } else {
            nonArtifactMats += m.qty;
        }
    }
    return nonArtifactMats * base + artifactValue;
}
```

`DECISION-A5`: Build this; needed for accurate station-fee math + IV-aware features. Need to enumerate artifact item IDs from `items.json`.

### A6. Station fee formula not implemented — MEDIUM

Current code treats station fee as a flat `%` input. Reality:

```js
// Fee per craft = ItemValue × 0.1125 × (silverPer100Nutrition / 100)
function stationFeePerCraft(itemId, silverPer100Nutrition) {
    return itemValue(itemId) * 0.1125 * (silverPer100Nutrition / 100);
}
```

`DECISION-A6`: Replace the `%` input with a "Silver per 100 nutrition" input (matches in-game station UI). Default to typical city values (~150-300 for prime stations).

### A7. Quality probability not modeled — MEDIUM

We have a Quality dropdown that filters which sell price to use, but **no calculator that estimates EV across qualities** given spec. Players ask: "what's my expected average sell price given I roll quality?"

Base distribution (from research):
```
Normal      68.9%
Good        25.0%
Outstanding  5.0%
Excellent    1.0%
Masterpiece  0.1%
```
Each +100 quality points = 1 reroll. Maxed mastery + city + food can push to ~50% Outstanding+.

`DECISION-A7`: Add a "Quality EV" toggle that computes expected average sell price weighted by the quality distribution at the user's spec. Most useful for masterpiece-target items where the sell premium is enormous.

### A8. No food buff support — LOW

Pork Omelette (T6) gives +18% focus efficiency; Avalonian Pork Omelette (T8) gives +30%. These are crafter staples. No tool surfaces them.

`DECISION-A8`: Add a "Food Buff" dropdown (None / Pork Omelette / Avalonian) that multiplies focus efficiency.

---

## Part B — New Refining Materials Section

Today we hide refining inside the Crafting tab and the standalone RRR Calculator. **Players treat refining as a different game** — different city, different focus loop, different time horizon. Give it its own tab.

### B1. Tab structure
- New nav button under **Crafting Group**: **🔥 Refining Lab**
- Three modes (pill toggle):
  - **Today's Best** — sorted profit grid (default landing)
  - **Single Material Deep-Dive** — pick a refined material, see full breakdown
  - **Daily Focus Planner** — "I have 10k focus, what should I refine"

### B2. Today's Best (the killer view)
- Auto-loads top profitable refines per family + tier (cloth, leather, planks, bars, blocks × T3-T8)
- Each row shows: profit/unit, profit/focus, RRR%, "list-vs-buy-order" sell mode, freshness badge
- Default sort: silver/focus (most efficient use of daily focus)
- Filters: city (auto-detect specialty), focus on/off, enchant level, tier
- Click row → opens single-material deep-dive

### B3. Single Material Deep-Dive
- Picks a target refined material (e.g., T6 Steel Bar)
- Shows:
  - **Recipe ratio table** (T6 = 4 ore + 1 T5 bar)
  - **City heatmap**: Bridgewatch / Fort Sterling / etc., each with per-city PB, RRR, profit
  - **Focus cost** at user's spec — base / per-batch / per-day-of-focus
  - **Sub-material chain** with **buy-vs-craft toggles** (this is the killer differentiator — see Part C)
  - **Inverse calc**: "Max raw price I can pay for X% net margin"
  - **Daily volume gate**: hide if <100 units/day market depth (don't refine what you can't sell)

### B4. Daily Focus Planner
- Input: focus available (default 10000, max 30000), city, list of items I have on hand (optional)
- Output: optimal allocation across families/tiers to maximize silver from that focus
- Shows expected daily silver, break point at which next-best refine becomes negative ROI
- Considers focus regen — "with 10k regen, this strategy earns 1.5M/day on autopilot"

### B5. Recipe data already there
Sample from current `recipes.json`:
```json
"T6_PLANKS": { "materials": [{"id":"T6_WOOD","qty":4},{"id":"T5_PLANKS","qty":1}], "category":"materials" }
```
130 "materials" recipes covering all refining tiers + enchant levels. **Sub-recipe walking is already supported in the data**; we just don't expose it in the UI.

What's **missing** in `recipes.json`:
- `focusCost` field for refining (we have base values from research per tier, need to add a `focus_costs.json` lookup)
- `cityBonusFamily` (e.g., `T6_PLANKS` → "wood" → bonus city Fort Sterling)

`DECISION-B5`: Build a small `focus_costs.json` data file with per-tier base focus costs (research-derived values: T2≈1, T3≈3, T4≈48, T5≈96, T6≈192, T7≈384, T8≈768 per refined unit).

---

## Part C — Crafting Tab Overhaul

### C1. Saved character profile (account-tied)
- Single "My Crafter" profile: per-category mastery + per-recipe spec + premium toggle + preferred city + food buff defaults
- Auto-applies everywhere: Crafting tab, RRR Calculator, Refining Lab, Repair, Journals
- Quick-switch profile (e.g., "Plate Armor Specialist" vs "Cloth Armor Specialist") for users who actively maintain multiple specs
- Stored in `users` table on backend; localStorage fallback for non-logged-in users

`DECISION-C1`: One profile per user vs multiple? Recommend **multiple named profiles** — guildies often have 2-3 active specs. Cost: small DB change (`crafter_profiles` table).

### C2. Sub-recipe tree with editable buy-vs-craft toggles
- Render the full chain: T8 Plate Boots → T8 Steel Bar + T7 Steel Bar + T8 Leather + T7 Leather → T8 Ore + T7 Ore + T8 Hide + T7 Hide
- Each node has a toggle: **🛒 Buy (current cheapest city)** | **🔨 Craft (apply MY RRR)**
- Toggle propagates: if you craft T8 Steel, the math then shows the T8 Ore + T7 Steel costs
- Live recompute on every toggle
- "Auto-optimize" button: tries every combination, picks the cheapest end-to-end path
- **No competitor has this with toggles** — Slishy has trees but read-only; APC has trees but no buy-vs-craft per node

`DECISION-C2`: Build this. Requires recursive recipe walking (recipes.json supports it). Estimated ~600 lines of code; we already have the data.

### C3. "Top-N Craft Right Now" Ranker (THE BIG ONE)
- Default screen of the Crafting tab when no item is selected
- Pulls live prices, applies user's spec/city/focus, ranks all 5,026 recipes
- Default sort: **silver per focus point** (most actionable for daily-focus grinders)
- Alt sorts: silver/hour (assuming N seconds/craft), silver/item, ROI%, silver/kg (transport-aware)
- Filters: tier, category, ench level, focus on/off, "fits in my mount" (uses Transport tab's mount selector), liquidity gate (hide items with <X daily volume)
- Each row: item icon, profit, focus cost, expected qty after RRR, sell city, "Craft this" → opens detail
- **The killer competitive feature** — no tool ranks the catalog given personal spec + live prices

`DECISION-C3`: Build this. Needs a backend endpoint that returns the top-N candidates pre-filtered (5026 recipes × 8 cities × 4 enchant levels × prices = expensive client-side). Endpoint: `GET /api/craft-rankings?spec=...&city=...&focus=true&tier=6&category=armor&minVol=50`. Backend pre-computes once per market scan and caches.

### C4. City heatmap per recipe
- For one recipe, show all 7 cities × focus on/off as a 7×2 matrix
- Each cell: profit (color-coded), RRR%, sell-side liquidity badge
- Click cell → load that city + focus combo into the detail view
- Helps the player decide where to actually go

`DECISION-C4`: Build. Reuse the existing per-city material price data we already fetch.

### C5. Inverse calc per item
- "Set target margin %" → tool computes max material prices that deliver that margin
- Useful for setting buy orders: "I want 10% margin on T6 Carrioncaller; how much will I pay for T6 leather?"
- Tools4Albion / Brannstroom have this for refining only — none for crafting

### C6. Quality EV mode
- Toggle in summary card: "Show expected value across quality distribution"
- Computes: weighted avg sell price = Σ(qualityProb × qualitySellPrice)
- Especially valuable for masterpiece-premium items
- Pulls per-quality prices from the same fetch we already do (we filter by quality today; just show all)

### C7. Liquidity / volume gate
- Filter: "hide items with <N daily volume"
- Pulls 24h volume from existing analytics endpoint
- Stops users from crafting 200 items they can't sell
- Default threshold: 50/day for finished goods, 200/day for refined materials

### C8. Daily-bonus calendar
- API call to fetch today's +10/+20% production-bonus items (from in-game daily activities)
- Show as a banner: "Today's bonus: +20% Plate Armor, +10% Bows"
- Filter / boost ranker by today's bonus
- `DECISION-C8`: Where does the daily-bonus data come from? AODP doesn't provide it. Options:
  - Manual user input (tedious)
  - Scrape from official Albion site (fragile)
  - Pull from one of the community data scrapers (uncertain availability)
  - Skip for v1, ship later

---

## Part D — Cross-Tab Synergies

Each tab gets a "Craft this" / "Refine this" / "Check craft profit" button where it makes sense. Each tab also gets a "From crafting" inflow.

### D1. Market Browser → Crafting
- "🔨 Craft this" button on every row that has a recipe → `switchToCraft(itemId)` (already wired at [app.js:2462](.claude/worktrees/friendly-dubinsky/app.js#L2462))
- "🔥 Refine this" button on raw materials → opens Refining Lab single-material view
- New "Craftable" filter: only show items that have a recipe (useful for crafters browsing)

### D2. Transport → Crafting
- Each haul plan row: if the item has a recipe, "vs craft locally?" badge that compares haul-arrival profit vs crafting at destination with same materials
- **Killer flow**: "I'm hauling T5 ore to Lymhurst. Should I refine it there instead?" — auto-comparison
- Refining Lab "Best refine" rows → "📦 Add to haul plan" button to push the raw materials into Transport

### D3. BM Flipper → Crafting (the moneymaker)
- BM Flipper finds items where BM buy > city sell — these are high-margin sells
- Cross-link: "Can I CRAFT this for BM?" → opens Crafting with BM as the sell city
- BM crafting margins are usually higher than flip margins — but only if the user crafts; we make this discoverable

### D4. Live Flips → Crafting
- Live flip cards already have a "🔨 Check Craft" button (per audit). Strengthen the wiring: pre-fill destination = the flip's sell city.

### D5. Loot Buyer → Crafting
- Loot tabs often contain crafted gear — "What did this gear cost to craft?" comparison view
- Use Item Value (A5) to estimate the original crafter's cost basis vs your buying price
- Helps Loot Buyer Phase 1 (Buy Decision Helper) by adding a "fair value" benchmark

### D6. Crafting → Sell Plan (reverse)
- After you craft, "→ Sell Plan" button opens the Loot Buyer Phase 2 logic with the crafted output
- Especially for batch crafts ("I made 50 plate boots, where do I sell?")

### D7. Repair → Crafting
- On Repair Cost results, show "vs crafting a new one" — many old gear is cheaper to replace than repair
- Cross-link to Crafting tab with the same item pre-loaded

### D8. Journals → Crafting
- Journals tab today is standalone. Tie to Crafting:
  - "Use a journal on this craft" toggle in Crafting detail view
  - Show marginal silver per craft when journaling
  - Shopping list: "to fill all my T6 journals, I need to craft N items"
- Could become "Journal Optimizer" sub-mode of Crafting tab

### D9. Live RRR (the biggest moat)
- Go client adds a `craftEvent` opcode handler — captures every craft attempt's actual material count
- Send to VPS: `(itemId, materialsRequested, materialsConsumed, qualityRolled)`
- Frontend: "Your realised RRR over last 1000 crafts: 47.7% (theoretical: 47.5%)"
- "Realised quality distribution": shows actual masterpiece rate vs expected
- This is the single moat no competitor can replicate — only Triky313 reads packets, but they don't surface this
- `DECISION-D9`: Build later (requires Go client opcode work + new DB table + frontend chart). Big payoff but new packet research.

---

## Part E — Killer Features Ranked by Impact

In priority order, with rough effort estimate (S=hours, M=1-2 days, L=>3 days):

| # | Feature | Effort | Impact | Notes |
|---|---|---|---|---|
| 1 | **Top-N Craft Right Now ranker** (C3) | M | XL | The single feature no competitor has |
| 2 | **Tax rate fix** (A4) | S | XL | Active money-losing bug for premium users |
| 3 | **Sub-recipe tree with toggles** (C2) | M | L | Killer differentiator |
| 4 | **Refining Lab tab** (B1-B4) | L | L | New revenue use case |
| 5 | **Saved crafter profile** (C1) | M | L | Universal time-saver |
| 6 | **Focus formula fix** (A3) | S | L | Wrong slope, wide accuracy improvement |
| 7 | **City heatmap per recipe** (C4) | S | M | High-value visual; cheap to build |
| 8 | **Auto city specialty bonus** (A2) | S | M | Removes user error |
| 9 | **Inverse calc** (C5) | M | M | Powerful for buy-order setters |
| 10 | **Live RRR via Go client** (D9) | L | XL | Unique moat, but needs packet work |
| 11 | **Cross-tab links** (D1-D8) | M | M | Compounding value across the app |
| 12 | **Quality EV mode** (C6) | S | M | Differentiator for masterpiece crafters |
| 13 | **Liquidity gate** (C7) | S | M | Stops bad crafts |
| 14 | **Item Value + Station fee fix** (A5, A6) | M | M | Accuracy + needed for IV-aware features |
| 15 | **basePB resolution** (A1) | S | S | Document and let user pick; resolve later |
| 16 | **Food buff support** (A8) | S | S | Niche but easy |
| 17 | **Daily-bonus calendar** (C8) | M | M | Blocked on data source |
| 18 | **Mobile-first responsive layout** | M | M | No competitor has this; PWA polish |

---

## Part F — Phased Rollout

Replaces the previous 5-phase plan in HANDOFF.md.

### Phase 1: Formula Foundation (1-2 days, ship-ready)
- Fix tax rate (A4) with premium toggle — also updates Transport, BM Flipper, Portfolio
- Fix focus reduction formula (A3) — exponential, not linear
- Add city specialty auto-detection (A2) per category
- Add Item Value function (A5) and station fee formula (A6)
- **Why first:** unblocks every downstream feature. Users immediately get more accurate numbers.

### Phase 2: Refining Lab (3-5 days)
- New nav tab under Crafting Group
- Today's Best mode (default landing)
- Single Material Deep-Dive with sub-recipe chain
- Daily Focus Planner
- `focus_costs.json` data file
- City specialty mapping for refining
- **Why second:** entirely new user surface, doesn't risk breaking existing crafting flows. Lets us iterate on sub-recipe rendering for re-use in Phase 3.

### Phase 3: Crafting Top-N Ranker (3-4 days)
- Backend endpoint `/api/craft-rankings` with caching
- Frontend default landing of Crafting tab
- All filters (tier, category, ench, liquidity gate)
- Liquidity gate (C7)
- Quality EV mode (C6)
- **Why third:** depends on Phase 1 fixes for accurate rankings. The "wow" feature.

### Phase 4: Sub-recipe Tree + City Heatmap (2-3 days)
- Crafting detail view gets the recursive tree (C2)
- Per-node buy-vs-craft toggles
- Auto-optimize button
- City heatmap matrix (C4)
- Inverse calc (C5)

### Phase 5: Saved Profiles + Cross-tab Synergies (2-3 days)
- `crafter_profiles` table + UI
- Multi-profile support
- Add cross-tab buttons everywhere (D1-D8)
- Universal "Use my crafter" propagation

### Phase 6 (separate): Live RRR via Go Client (1-2 weeks)
- Research craft opcode (likely opcode TBD — needs in-game packet capture session)
- Add handler in Go client
- New backend table `craft_events`
- Frontend "My realised RRR" chart on Crafting tab
- "Compare to theoretical" overlay
- Marketing angle: "Only tool that shows your real crafting performance"

### Phase 7 (low priority): Mobile-first responsive layout
- PWA polish, breakpoints for 375px, focused crafter "30-second daily" view

### Phase 8 (blocked): Daily Production Bonus Calendar
- Find data source (community scraper or manual)
- Filter / boost ranker by today's bonus

---

## Part G — Data Layer Requirements

### G1. New file: `focus_costs.json`
Structure:
```json
{
  "refining": {
    "T2": { "base": 1 },
    "T3": { "base": 3 },
    "T4": { "base": 48 },
    "T5": { "base": 96 },
    "T6": { "base": 192 },
    "T7": { "base": 384 },
    "T8": { "base": 768 }
  },
  "crafting": {
    "T4": { "base": 14 },
    "T5": { "base": 30 },
    "T6": { "base": 62 },
    "T7": { "base": 126 },
    "T8": { "base": 254 }
  }
}
```
Values from research — will need in-game verification at one tier to confirm scale.

### G2. New backend endpoint: `/api/craft-rankings`
Query params: `spec`, `mastery`, `city`, `focus`, `tier`, `category`, `enchant`, `minVol`, `premium`
Returns: top-50 craftable items sorted by configurable metric, pre-computed once per market scan.
Caching: per-(city, focus, premium) tuple, 5-min TTL.

### G3. New backend table: `crafter_profiles`
```sql
CREATE TABLE IF NOT EXISTS crafter_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT, -- e.g. 'plate_armor', 'cloth_armor', 'sword'
  spec_level INTEGER DEFAULT 0,
  mastery_level INTEGER DEFAULT 0,
  preferred_city TEXT,
  premium INTEGER DEFAULT 1,
  food_buff TEXT, -- 'none' / 'pork' / 'avalonian'
  created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
  is_active INTEGER DEFAULT 0
);
CREATE INDEX idx_crafter_user ON crafter_profiles(user_id);
```

### G4. Future: `craft_events` table (for Phase 6 Live RRR)
```sql
CREATE TABLE IF NOT EXISTS craft_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  materials_requested INTEGER,
  materials_consumed INTEGER,
  rrr_realised REAL,
  quality_rolled INTEGER,
  city TEXT,
  used_focus INTEGER
);
CREATE INDEX idx_craft_user_ts ON craft_events(user_id, timestamp);
```

### G5. Items.json artifact tagging
Need a way to identify artifact items so `itemValue()` can use a separate multiplier. Options:
- Pattern match: artifact item IDs follow `_ARTEFACT_` or specific suffixes
- Augment `items.json` with an `isArtifact` flag (one-time data prep)

---

## Part H — Open Questions (Need User Decision)

1. **`DECISION-A1`**: For crafting basePB, pick (A) keep 18, (B) drop to 15, or (C) make user-configurable? Recommendation: **C with default 18**.
2. **`DECISION-A4`**: Premium toggle default — assume premium (yes) or non-premium (safer for new players)? Recommendation: **assume premium, save preference in localStorage on first interaction**.
3. **`DECISION-C1`**: One crafter profile per user, or multiple named profiles? Recommendation: **multiple — guildies often run 2-3 specs**.
4. **`DECISION-C3`**: Should the Top-N ranker default to silver/focus or silver/hour? Recommendation: **silver/focus** (matches the most common archetype: daily-focus grinder).
5. **`DECISION-C8`**: Build daily-bonus calendar in v1 (blocked on data source) or skip? Recommendation: **skip v1, banner placeholder for later**.
6. **`DECISION-D9`**: Live RRR is a major moat but needs Go client packet research (~1 week). Build in Phase 6 (later) or front-load? Recommendation: **Phase 6** — ship value-side first, then unique-moat later.
7. **Refining Lab nav placement**: Under Crafting Group as new tab, or as a mode of existing Crafting tab? Recommendation: **separate tab — players treat them as different activities** per workflow research.
8. **Phase ordering**: Above is one suggestion. Open to reshuffling based on user priorities.

---

## Part I — What This Beats (Competitive Positioning)

If we ship Phases 1-5 as described:

| Feature | Us | AlbionFreeMarket | Tools4Albion | Albion Profit Calc | Triky313 |
|---|---|---|---|---|---|
| Top-N ranker (silver/focus) | **✓** | ✗ | ✗ | ✗ | ✗ |
| Sub-recipe with toggles | **✓** | ✗ | ✗ | ✗ (read-only tree) | ✗ |
| Inverse calc (crafting) | **✓** | ✗ | ✗ | ✗ | ✗ |
| Saved crafter profile | **✓** | partial | ✗ | partial | ✗ |
| City heatmap | **✓** | partial | ✗ | ✗ | ✗ |
| Quality EV | **✓** | ✗ | ✗ | ✗ | ✗ |
| Live RRR (Phase 6) | **✓** | ✗ | ✗ | ✗ | partial (no UI) |
| Cross-tab synergy | **✓** | partial | ✗ | ✗ | ✗ |
| Mobile-first | (Phase 7) | ✗ | ✗ | ✗ | ✗ |
| Refining lab (own tab) | **✓** | partial | partial | ✗ | ✗ |
| Daily focus planner | **✓** | ✗ | ✗ | ✗ | ✗ |
| Liquidity gate | **✓** | ✗ | ✗ | ✗ | ✗ |
| Custom packet client | ✓ (existing) | partial (data only) | ✗ | ✗ | ✓ |

**By Phase 5 we are best-in-class.** By Phase 6 (Live RRR) we are uncopyable.

---

## Part J — Sources (full list across all 4 research agents)

**Refining mechanics:**
- https://wiki.albiononline.com/wiki/Resource_return_rate
- https://wiki.albiononline.com/wiki/Local_Production_Bonus
- https://wiki.albiononline.com/wiki/Refining
- https://wiki.albiononline.com/wiki/Crafting_Focus
- https://wiki.albiononline.com/wiki/Specializations
- https://brannstroom.github.io/albiononline-refining-calculator/
- https://albionfreemarket.com/resource-return-rate-calculator
- https://albionmaster.com/refining-calculator
- https://onelifegaming.com/en/albion-online/blog/crafting-guide
- https://forum.albiononline.com/index.php/Thread/195965-Calculation-of-Focus-Cost-in-Resource-Refinement/
- https://forum.albiononline.com/index.php/Thread/112079-Resource-Return-Rate-how-does-it-work/

**Crafting mechanics:**
- https://wiki.albiononline.com/wiki/Item_Value
- https://wiki.albiononline.com/wiki/Quality
- https://wiki.albiononline.com/wiki/Marketplace
- https://wiki.albiononline.com/wiki/Pork_Omelette
- https://wiki.albiononline.com/wiki/Avalonian_Pork_Omelette
- https://wiki.albiononline.com/wiki/Journal
- https://forum.albiononline.com/index.php/Thread/167434-Explaining-Crafting-Tax-and-more/
- https://forum.albiononline.com/index.php/Thread/198660-Analysis-of-Focus-Cost-in-Crafting/
- https://forum.albiononline.com/index.php/Thread/53339-Formula-to-calculate-focus-cost-of-enchanted-items/
- https://forum.albiononline.com/index.php/Thread/67684-Crafting-quality-chance/
- https://forum.albiononline.com/index.php/Thread/169251-44-Increase-in-Market-Taxes/
- https://devtrackers.gg/albion/p/510446ae-usage-fee-and-crafting-changes-lands-awakened-update
- https://www.pecsandbox.com/2025/08/albion-online-market-mastery-guide-2025.html

**Competitive tools:**
- https://www.tools4albion.com/refining.php
- https://albionfreemarket.com/crafting
- https://albion-profit-calculator.com/
- https://albiononlinegrind.com/craft-planner
- https://github.com/Triky313/AlbionOnline-StatisticsAnalysis
- https://onelifegaming.com/en/albion-online/crafting-calculator
- https://www.slishy.com/
- https://albionbattlehub.com/

**Crafter workflows (forum & community):**
- forum.albiononline.com Threads: 163755, 197570, 164179, 148003, 166527, 181656, 174674, 191177, 64414, 110223, 144153, 86790, 130067
- https://albionfreemarket.com/changelog
- https://www.keengamer.com/articles/guides/albion-online-everything-you-need-to-know/section/18-crafting-and-refining-in-albion-online-specializations-and-profit/

---

## Appendix — Existing 5-Phase Plan (from HANDOFF.md, superseded)

| Old Phase | What it said | Status under new plan |
|---|---|---|
| P1 Test & stabilize | Verify formulas, refresh buttons | **Done** in this research; formula bugs documented above |
| P2 Cost breakdowns | RRR accuracy, journal calc, ench mats, sub-recipe | Replaced by Phase 1 (formulas) + Phase 4 (sub-recipe) |
| P3 Cross-feature nav | switchToCraft + buttons | **Already wired**; expanded in Phase 5 (D1-D8) |
| P4 Bulk scanner enhancements | Filters, insta-sell vs list, profit/focus | Replaced by Phase 3 (Top-N Ranker) — better UX |
| P5 QoL | Favorites, shopping list, mobile | Phases 5 & 7 |

The old plan's intent survives; the new plan is more ambitious and better-targeted at the workflows we now know matter.

---

*End of plan. Ready for user signoff before any implementation begins.*
