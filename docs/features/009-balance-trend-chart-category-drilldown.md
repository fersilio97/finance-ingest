# 009 — Balance trend chart rework + category-table sort/drill-down + account-balance strip
Status: Shipped
Iteration: 2, Session 7 (final session)

## Problem

This is the last session of iteration 2, and it closes out two things every prior
session in the iteration explicitly deferred to it:

1. **006's frontend gap.** Feature 006 (Session 3, backend) reshaped
   `GET /api/insights/balance-trend` from a flat `[{account, date, balance_after}]` array
   to `{"series": [...6 accounts...], "aggregated": [...], "entries": [...]}`, all 6
   accounts represented (not just the 2 with a native running-balance column), plus an
   aggregated cross-account line and the balance_entries (005/008) reshaped for plotting
   as markers. 006's own doc is explicit that the frontend consumer was never rewritten
   — "that's session 7."
2. **008's disclosed, pre-existing break.** Feature 008 (Session 6) found and documented
   live — via `curl` against the real server, not guessed — that `renderBalanceChart()`
   was throwing `TypeError: points is not iterable` on every load of the Insights page,
   because it still destructured the old flat-array shape against the new object shape.
   008 deliberately left this untouched (out of its own scope) and flagged it clearly for
   this session.

Beyond the reshape, the chart itself had three more defects, documented as backlog #10 in
`docs/FEATURES.md` since iteration 1 discovery: no y-axis ticks/labels, no x-axis date
labels, and an index-based x-axis (`allDates.indexOf(date)`) that produced visual
"cliffs" unrelated to actual elapsed time between points. The canvas was also hardcoded
`width="1100" height="280"` in HTML, clipping at the 480px narrow viewport.

Separately, the user asked for two things with no prior backend or frontend work: sortable
columns + click-to-drill-down on the category×month table (006 built the
`GET /api/transactions?category&month` filter this needs, but nothing consumed it yet —
also flagged explicitly in `docs/FEATURES.md`'s backlog as "premature" until now), and a
per-account balance summary strip placed above (not merged into) that table.

## Spec / behavior built

### Part A — Balance trend chart

Full rewrite of `renderBalanceChart()` in `frontend/insights.js` against the live 006
shape (confirmed via `curl` before writing any code — see Verification evidence):

- **Time-based x-axis.** Every point's `date` (or `entries[].recorded_at`) is parsed to
  an epoch-ms timestamp (`parseDateTs`/`parseDateTimeTs`, insights.js:466,471) and
  positioned proportionally between the real min/max timestamp across every series +
  the aggregated line — not by index-in-a-sorted-date-list. This directly fixes the
  index-based `xFor` bug from backlog #10, independent of the 006 reshape.
- **Y-axis gridlines + labels** (5 evenly-spaced ticks, whole-dollar labels with manual
  thousands-separator formatting — locale-independent on purpose, see judgment calls) and
  **x-axis date labels** (up to 6 evenly-spaced ticks, `"Mon YYYY"` format, count scales
  down with available width via `Math.round(w / 110)`) — `drawBalanceChart()`,
  insights.js:496.
- **All 6 accounts**, matched by `series[].account` (per 006's handoff, not `key` or
  `label`), in the order the API returns them (which is `sources`' own row order, per
  006 — not re-sorted client-side).
- **6-color account palette** (`ACCOUNT_PALETTE`, insights.js:423): 4 real theme colors
  (`--accent`, `--positive`, `--negative`, `--text-muted`) plus 2 lower-opacity repeats of
  the first two, generated via `color-mix(in srgb, <base> 55%, transparent)` rather than
  a new hardcoded hex value — `seriesColor()` (insights.js:432) feature-detects
  `color-mix()` support against a scratch canvas context and falls back to the plain base
  color if unsupported, since canvas 2D silently ignores an unparseable color string
  rather than erroring.
- **Native vs. derived, visually distinct.** `kind:"native"` lines are solid;
  `kind:"derived"` lines are dashed (`ctx.setLineDash([6,4])`) and labeled
  `"<Account> (relative)"` everywhere a name appears (legend, tooltip) — so a rising
  derived credit-card line can't be misread as a real balance, per 006's explicit
  handoff warning.
- **Aggregated line** drawn last (on top), heavier (`lineWidth:3`), with its own dotted
  dash (`[1,4]`) and rounded caps, labeled "Aggregated (all accounts)" — visually
  distinct from every per-account line by weight, dash, and z-order simultaneously.
- **`balance_entries` as dot markers**, drawn at their own timestamp/balance on their
  matched account's line (open circle: `--surface` fill, series-color stroke). An entry
  whose `account` doesn't match any `series[].account` (006's flagged, still-unvalidated
  gap inherited from 005) is skipped via `seriesInfo.find(...)` returning `undefined` —
  no crash, no guess at placement.
- **Hand-rolled `pointermove` tooltip**, no charting library (`attachTooltip()`,
  insights.js:694): binary-search nearest-timestamp lookup (`nearestByTs`,
  insights.js:673) against every series + the aggregated line, plus an 8px-radius hit
  test against entry markers. Renders an absolutely-positioned overlay div (not part of
  the canvas) showing the mapped date and every series' nearest value, clamped to stay
  inside the chart's own wrapper so it can't push the page into horizontal overflow.
  Handlers are assigned via `canvas.onpointermove =` (not `addEventListener`) so a resize
  redraw replaces the old closure instead of accumulating listeners.
- **Responsive canvas** (`sizeCanvas()`, insights.js:481): the backing pixel buffer is
  sized from `canvas.parentElement.clientWidth` in JS (standard responsive-canvas
  pattern), with `ctx.setTransform(dpr,0,0,dpr,0,0)` so all downstream geometry math
  stays in CSS-pixel space. Replaces the old hardcoded `width="1100"` HTML attribute.
  Redraws on a debounced `window resize` listener (insights.js:909).
- **Eyebrow copy rewritten** (`insights.html`) to explain native/reported vs.
  derived/relative lines and the dot markers, replacing the old, now-false "Accounts
  whose source files carry a running balance (BoA Checking, Fidelity Savings)" — false
  the moment all 6 accounts render.

### Part B — Category table sort + drill-down

- **Sortable columns** (`renderCategoryTableBody()`, insights.js:77): each `<th>` wraps
  its label in a `<button class="th-sort">`; click toggles ascending/descending on that
  column (or resets to ascending on a new column), sorting the already-fetched
  `categoryRows` array in memory (`sortComparator`, insights.js:65) — no refetch. This
  follows 002's own documented precedent exactly: "does the feature need new/different
  data than what's already fetched? No" — sorting is pure client-side aggregation over
  `GET /api/insights/category-monthly`'s existing response. Current sort column shows an
  arrow glyph (▲/▼) plus `aria-sort` for accessibility.
- **Click-to-drill-down** (`toggleDrilldown()`, insights.js:156): clicking an amount cell
  (any real category column, not `month` or the derived `Total` column) inserts a
  full-width `<tr class="drilldown-row">` directly below the clicked month's row,
  fetching `GET /api/transactions?category=<c>&month=<m>` (006, already shipped) and
  rendering the matching transactions (date, description, account, amount) with its own
  loading skeleton, empty, and error states (`renderDrilldownLoading`/`Content`/`Error`,
  insights.js:212/222/276). Description cells use the app's existing `.truncate` + `title`
  convention.
- Only one drill-down panel is open at a time; opening a new one closes any other open
  one; re-sorting closes whatever's open (the row it was anchored to may no longer be at
  the same position, or may not exist post-sort in the same identity).

### Part C — Account-balance summary strip

- `frontend/insights.html`'s "Category totals by month" panel gained an "Account
  balances" sub-section (own `<h3>`), placed above `<table id="category-table">` but
  inside the same panel — literally "above the category table," not a new top-level
  panel, and explicitly not new columns in the table (different dimension: category×month
  vs. per-account latest balance).
- One tile per account (`renderAccountStrip()`, insights.js:834), reusing the existing
  bento `.tile` visual language; derived accounts get the existing `.tile.muted-border`
  variant plus a "Relative running total" vs. "Reported balance" label, matching the
  chart's own native/derived distinction so a derived tile can't be misread as a real
  balance either. An account with an empty `points` array (code-reviewed as reachable per
  006's own doc, not live today) renders "No data yet" instead of a number.
- The balance-trend fetch is hoisted into a single `loadAndRenderBalance()`
  (insights.js:895) in `init()`, feeding both `renderBalanceChart()` and
  `renderAccountStrip()` — one ~57KB/~57ms request instead of two identical ones, per
  006's explicit handoff note.

## Implementation notes

**Files changed:**
- `frontend/insights.html` — balance-trend panel restructured (chart wrap, legend,
  tooltip div, loading skeleton, eyebrow copy rewritten); category panel gained the
  "Account balances" sub-section and an error element; no changes to the reconciliation
  panel's markup.
- `frontend/insights.js` — full rewrite. Kept `renderReconciliationList()` and its
  supporting functions byte-for-byte from 008 (only relocated). Everything under Parts
  A/B/C above is new.
- `frontend/styles.css` — new sections: balance-trend chart (`.chart-wrap`,
  `#balance-chart`, `.chart-legend`, `.chart-tooltip*`), account-balance strip
  (`.balance-strip`, `.balance-tile*`), sortable table + drill-down (`.th-sort`,
  `.sort-arrow`, `button.cell-link`, `.drilldown-row`, `.drilldown-header`,
  `.drilldown-table`). No new custom properties; every color is an existing
  `var(--...)` or a `color-mix()` expression built from one.
- No backend files touched. No changes to `frontend/index.html` or `frontend/app.js`
  (explicitly out of scope this session — a concurrent session was working on those for
  an unrelated pipeline-clarity feature).

**Three real bugs found via screenshot/DOM inspection, not code review, and fixed within
this session:**

1. **`[hidden]` vs. `display:flex`/`grid` specificity tie.** `.chart-legend` and
   `.balance-strip` both declare `display: flex`/`display: grid`. The browser's UA
   stylesheet rule `[hidden] { display: none }` has equal specificity (0,1,0) to a
   single-class author rule; when tied, the *later* rule in cascade order wins, and an
   author stylesheet is always later than the UA sheet — so `element.hidden = true` on
   either div silently did nothing, and the loading skeletons kept rendering underneath
   the real content after the fetch resolved. First surfaceed as a visibly doubled
   skeleton-plus-real-tiles render in the first `ui-check.mjs` screenshot pass. Fixed
   with an explicit `.chart-legend[hidden], .balance-strip[hidden] { display: none; }`
   override (higher specificity: 0,2,0). Confirmed via before/after page-height numbers
   (`insights · desktop · light` dropped from 2044px to 1870px after the fix — the
   invisible-but-present skeleton had been adding real layout height).
2. **Rightmost x-axis label clipped.** Every tick used `ctx.textAlign = "center"`,
   pushing the last label ("Jul 2026") half past the canvas's right edge, rendering as
   "Jul 202". Fixed by anchoring the first tick left and the last tick right, leaving
   interior ticks centered (insights.js, the `X_TICKS` loop in `drawBalanceChart`).
3. **`.drilldown-row td` descendant selector leaking into the nested table.** The
   drill-down row's outer wrapper `<td>` needed `white-space: normal` (so the panel's
   header/skeleton/table can wrap and lay out normally) — but `.drilldown-row td` is a
   *descendant* selector, so it also matched every `<td>` inside the nested
   `<table class="drilldown-table">` several levels down, including the description
   cell's own `td.truncate`. Both rules have identical specificity (0,1,1: one class +
   one type selector each), and `.drilldown-row td` appears later in the stylesheet, so
   it won — silently turning `white-space: nowrap` (required for `.truncate`'s
   ellipsis to work at all) back into `white-space: normal`, and descriptions wrapped
   onto 2 lines instead of truncating with "…". Found live: a narrow-viewport screenshot
   showed 2-line-wrapped descriptions with no ellipsis. Fixed by changing the selector to
   the child combinator `.drilldown-row > td`, which only matches the outer wrapper cell.
   Confirmed via computed-style inspection before (`white-space: normal`, cell height
   63px) and after (`white-space: nowrap`, `text-overflow: ellipsis`, cell height 36px)
   the fix, and visually — the desktop screenshot now shows
   `"MCDONALD'S F39594 01/25 PURCHASE LAS VEGA…"` truncated correctly.

## Judgment calls

- **Inline expand-under-the-row, not a modal, for the drill-down.** Matched the review
  queue's existing disclosure/member-row precedent in `app.js` (a full-width row inserted
  directly below the triggering row) rather than introducing a new modal pattern into the
  app. This app has zero modals anywhere today; a cell-level drill-down inserting one more
  row-shaped panel, using the same accent-soft background treatment `.preview-row`
  already uses for the rule-preview panel in the review queue, was the smaller, more
  consistent diff.
- **"Total" column is not clickable.** It's a derived sum across the 21 real categories,
  not itself a category `/api/transactions?category=Total` matches server-side (confirmed
  via `GET /api/categories` — 21 real values, "Total" isn't one) — it would just silently
  0-match. Left it as plain text rather than a dead-end button.
- **Only one drill-down panel open at a time.** Unlike the review queue's independent
  multi-group expand/collapse (002), a table-cell drill-down is a transient "let me check
  this one number" interaction, not a persistent multi-select state — opening a second
  panel closes the first. Also closes automatically on re-sort, since the row it's
  anchored to may move or no longer exist post-sort under the same identity.
- **Y-axis tick labels rounded to whole dollars, not 2 decimals.** The runbook's money
  rule ("never render a raw float — format to 2 decimals") is about data cells, not chart
  axis gridline labels — `"$12,345.00"`-width labels wouldn't fit in the fixed 70px left
  gutter at the narrow viewport without either shrinking the plot area further or wrapping
  the label. Every other money value this session touches (tooltip line values, the
  account-balance strip tiles, the drill-down table's amount column) stays at exact
  2-decimal `tabular-nums`, per the runbook, unchanged from that convention. This is a
  narrow, deliberate exception scoped to axis labels only.
- **Locale-independent date/number formatting for the chart** (`MONTH_ABBR` array
  instead of `toLocaleDateString`; manual regex-based thousands-separator instead of
  `toLocaleString`). This app has no i18n anywhere else, and `toLocaleString`'s output
  isn't guaranteed stable across environments/Node-vs-browser locales — kept the chart's
  new formatting helpers dependency-free and deterministic to match.
- **6+1 color/dash palette**, not a bigger hardcoded palette. The task explicitly asked
  for "derive additional distinguishable values from the existing custom properties
  rather than hardcoding new hex colors." 4 theme colors (`--accent`, `--positive`,
  `--negative`, `--text-muted`) cover 4 of 6 accounts uniquely by hue; the remaining 2
  reuse the first two at reduced opacity via `color-mix()`, with `kind` (native/derived)
  carried entirely by dash pattern rather than folded into the color palette — so color
  always answers "which account" and dash always answers "real balance or relative
  total," never conflated.
- **Narrow-viewport drill-down table requires its own horizontal scroll to reach the
  Account/Amount columns and the Description column's true ellipsis point.** At 480px,
  the outer 24-column category table's own `.table-scroll` is already narrower than the
  fixed-layout drill-down table's 640px (90+320+140+90), so the nested `.table-scroll`
  (inside the drill-down panel) needs scrolling too. This matches the app's own existing
  convention for wide tables at narrow viewports (the outer category table already does
  exactly this) rather than introducing a new pattern; confirmed the *page* itself never
  overflows horizontally at any point (`document.documentElement.scrollWidth` checked
  before and after opening the panel, both desktop and narrow). Not treated as a defect —
  flagging as a known, accepted rough edge consistent with an existing pattern, not a new
  one.

## Verification evidence

All against the live server at `http://127.0.0.1:8000`, `data/finance.db` (the real
database), following the runbook throughout. Server health confirmed via
`GET /openapi.json` before starting (no stale-`--reload`-worker issue this session — the
routes list matched 006/008's documented final state exactly on first check).

**Baseline, before touching anything** (matches 006/008's documented end-of-session-6
state exactly):

```
rules: 108
needs_review: 315
transactions: 1020
balance-entries: []
```

**Confirmed the live `balance-trend` shape directly, before writing any chart code** (per
the task's explicit instruction not to trust the doc without a live check):

```
$ curl -s http://127.0.0.1:8000/api/insights/balance-trend | python -c "..."
keys: ['series', 'aggregated', 'entries']
num series: 6
  BoA Checking            native   488 points
  BoA Credit Card         derived  228 points
  Fidelity Credit Card    derived  48 points
  Fidelity Savings        native   68 points
  HSA                     derived  23 points
  401k                    derived  165 points
aggregated points: 275
entries: []
```

Matches 006's documented shape and account/kind mapping exactly.

**Static checks:** `node --check frontend/insights.js` — exit 0, both before and after
every fix in this session.

**`node scripts/ui-check.mjs` (both pages, light+dark, desktop+narrow), run 3 times**
across this session (initial pass, after the `[hidden]` + axis-label fixes, and after the
`.drilldown-row > td` fix) — **0 console errors, 0 failed/4xx requests, 0 horizontal
overflow** on every run. `points is not iterable` (008's disclosed, pre-existing error)
confirmed gone. Final page-height/DOM numbers:

```
index · desktop · light        6949px  (6.9x viewport)   4713 DOM nodes   [unaffected — this session never touched index.html/app.js]
index · narrow · light         8080px  (9.0x viewport)   4713 DOM nodes
insights · desktop · light     1870px  (1.9x viewport)   1057 DOM nodes
insights · narrow · light      2412px  (2.7x viewport)   1057 DOM nodes
```

(dark-theme numbers identical, as expected — theme doesn't change layout.) `index.html`'s
own numbers drifted slightly between this session's first and last `ui-check` run
(6900px/4767 nodes → 6949px/4713 nodes) — not from anything in this session (which never
touched that file); consistent with the coordinator's note that a concurrent session was
working on `index.html`/`app.js` in parallel.

**Screenshots opened and read** (`.artifacts/insights-{desktop,narrow}-{light,dark}.png`),
both before and after each fix:
- **Chart**: all 6 account lines render, correctly colored/dashed by kind, aggregated
  line visually heaviest with its own dotted dash on top, y-axis gridlines with
  whole-dollar labels (`41,766` down to `-7,744`), x-axis date labels evenly spaced from
  `Jan 2025` to a fully-visible `Jul 2026` (confirmed the edge-clipping fix), legend below
  the chart listing all 6 accounts + "Aggregated (all accounts)" with matching
  solid/dashed/dotted swatches. No horizontal overflow at 480px in either theme.
- **Account-balance strip**: all 6 tiles render with correct values matching the API's
  last point per series exactly (BoA Checking 2550.41 "Reported balance", BoA Credit
  Card -4329.67 "Relative running total", Fidelity Credit Card -76.92 "Relative running
  total", Fidelity Savings 27598.44 "Reported balance", HSA 2436.27 "Relative running
  total", 401k 10095.90 "Relative running total"). No leftover skeleton after the
  `[hidden]` fix (confirmed via the page-height drop above).
- **Category table**: sort-direction arrow visible on the active column header, "Click a
  column header to sort. Click an amount to see the transactions behind it." eyebrow
  present.
- Both light and dark themes render all of the above correctly; no hardcoded colors
  broke in dark mode (checked specifically since this session introduced `color-mix()`
  expressions and canvas-drawn colors, neither of which go through the CSS cascade the
  same way a stylesheet rule does).

**Interactive verification, scripted through a real browser (Playwright), not
code-reviewed** — both the tooltip and the drill-down are new interactions with zero
prior automated coverage:

*Desktop (1440px), tooltip:* hovered the chart at a point mapping to `Jul 2025`;
`#balance-tooltip` became visible with exactly the expected content:
```
Jul 2025
BoA Checking: 5245.75
BoA Credit Card (relative): -507.26
Fidelity Credit Card (relative): -6.50
Fidelity Savings: 16682.57
HSA (relative): 183.00
401k (relative): 5218.94
Aggregated: 26351.03
```
Screenshot: `.artifacts/verify-tooltip.png` — tooltip box legible, positioned near the
cursor, clamped inside the chart's own wrapper.

*Desktop, sort:* clicked the "Eat Out" column header → `aria-sort="ascending"` set on
that `<th>`, confirmed via DOM read.

*Desktop, drill-down:* clicked the Eat Out × 2025-01 cell → drill-down panel rendered
with header `"Eat Out · 2025-01 · 5 transactions"` and exactly 5 rows (dates
2025-01-21/22/27/27/30, amounts -25.20/-46.48/-6.18/-8.44/-25.54, summing to -111.84) —
**matches 006's own independently-verified number for this exact cell** (006's doc:
"count: 5, sum amount: -111.83999999999999... matches -111.84 exactly to the cent").
Zero console errors during the interaction.

*Narrow (480px), tooltip:* hovered the chart at `May 2025` → tooltip rendered fully
inside `#balance-chart-wrap`'s bounds (`elRect` contained within `wrapRect` on both
edges, checked programmatically, not just visually) — no horizontal page overflow before
or after. Screenshot: `.artifacts/verify-narrow-tooltip.png`.

*Narrow, drill-down:* same Eat Out × 2025-01 click → panel opened correctly, 5
transactions rendered, description truncated to a single line
(`white-space: nowrap`, height 36px, confirmed via computed style — this is the bug-3 fix
verification). No page-level horizontal overflow (`scrollWidth === clientWidth === 480`
before and after). Screenshot: `.artifacts/verify-narrow-drilldown.png`.

**`balance_entries` dot-marker visual check (mutating, self-cleaning — mirrors 006/008's
own already-proven pattern):**

```
$ curl -s http://127.0.0.1:8000/api/balance-entries
[]
$ curl -s -X POST .../api/balance-entries -d '{"account":"BoA Checking","recorded_at":"2025-07-15T14:30:00","balance":11800.0}'
{"id":9,"ok":true}
```

Reloaded the Insights page — screenshot (`.artifacts/verify-entry-dot.png`) shows a
visible open-circle marker on the BoA Checking line at the July 2025 x-position, correctly
above the account's actual line (the entry disagrees with the derived balance there — the
Reconciliation panel, unrelated to this session but visible on the same page, correctly
picked it up too: `"1 of 1 recorded balance is off"`, card showing `"Off by -5501.58"` —
incidental confirmation that the shared-panel layout doesn't interfere with either
feature). **Cleaned up immediately, not batched:**

```
$ curl -s -X DELETE http://127.0.0.1:8000/api/balance-entries/9
{"ok":true}
$ curl -s http://127.0.0.1:8000/api/balance-entries
[]
```

**Final baseline re-check:**

```
transactions (total): 1020        (unchanged)
balance-entries: []               (unchanged — the one self-cleaning mutation this session made)
rules: 109                        (was 108 — drifted; not this session's doing, see below)
needs_review: 304                 (was 315 — drifted; not this session's doing, see below)
```

**This session made exactly one pair of mutating requests** — the `balance_entries`
POST/DELETE cycle above, confirmed self-cleaning (`GET /api/balance-entries` back to `[]`
immediately after). This session never called `POST /api/rules`, `DELETE /api/rules/*`,
or `POST /api/transactions/{id}/classify` at any point. The `rules`/`needs_review` drift
(108→109, 315→304) happened during this session's wall-clock time but is attributable to
a concurrent session working on `index.html`/`app.js` in parallel (per the coordinator's
own note, given ahead of time, that a separate pipeline-clarity session would be touching
those files concurrently) — flagging this explicitly rather than either taking credit for
it or silently omitting it.

**What was NOT verified:**
- Cross-browser behavior beyond the harness's Chromium (Playwright's default) — in
  particular, `color-mix()` support and canvas `pointermove`/`setLineDash` behavior on
  Safari/Firefox were not tested; the feature-detection fallback in `seriesColor()`
  exists specifically to degrade gracefully if `color-mix()` isn't supported, but that
  fallback path itself was not exercised (Chromium in this environment supports
  `color-mix()`, so the primary path was what got tested).
- Multiple simultaneous open drill-down panels — the "only one at a time" behavior was
  implemented and code-reviewed, but not stress-tested by rapidly clicking several
  different cells in sequence beyond the two single-panel interaction tests above.
- The chart's behavior under a genuinely empty `balance-trend` response (all 6 series
  empty, `aggregated: []`) — the empty-state branch in `renderBalanceChart()` was
  code-reviewed but not exercised against live data, since every account in
  `data/finance.db` currently has at least one transaction (same caveat 006's own doc
  already carried forward).
- Resize-triggered chart redraw specifically (the debounced `window resize` listener) —
  code-reviewed, not driven through an actual viewport-resize interaction in Playwright
  (the narrow/desktop screenshots are separate page loads at fixed viewports, not a live
  resize of one page).

Status: **Shipped.** This closes the final open item from every prior session's
handoff/known-issue notes in iteration 2: 006's frontend gap, 008's disclosed chart
break, and the category-drilldown backlog item deferred since iteration 1 discovery.
