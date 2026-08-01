# 011 — Responsive page width + category-table drill-down visibility
Status: Approved
Iteration: 4

## Problem

Two connected width problems, both reported directly by the user and confirmed live
against `http://127.0.0.1:8000` (Playwright, both `node scripts/ui-check.mjs` and an ad
hoc probe script for viewports the harness doesn't cover by default).

**1. `.page { max-width: 1180px; margin: 0 auto; }` (`frontend/styles.css:65-69`) caps
every page's content width regardless of viewport, on both `index.html` and
`insights.html`.** Measured directly:

| Viewport | `.page` rendered width | Unused side margin |
| --- | --- | --- |
| 1440px (the harness's own "desktop" default) | 1180px | 260px total (18%) |
| 1920px | 1180px (unchanged) | 740px total (370px each side, 38.5%) |
| 2560px | 1180px (unchanged) | 1380px total (690px each side, 53.9%) |

The cap doesn't just waste whitespace — it starves the two tables that matter most, both
already inside `.table-scroll { overflow-x: auto; }`:

- `index.html`'s `#review-table` (the flagship "Needs Review" queue) already overflows
  its own scroll container **at the harness's default 1440px desktop width**: natural
  table width 1385px vs. 1084px visible in the scroll wrapper — **301px of forced
  horizontal scroll on the single most-used table in the app**, before any of the other
  known review-queue issues (backlog #8, row density) even come into play.
- `insights.html`'s `#category-table` sits inside a `.split` grid
  (`grid-template-columns: 1.4fr 1fr`) that only gives it 1.4 parts of the row, further
  squeezed inside the 1180px page cap. At 1440px desktop this panel's `.table-scroll`
  is 598px wide against a natural table width of 1819px — **1221px of forced horizontal
  scroll**.

Confirmed via `document.documentElement.scrollWidth`/`clientWidth` that the *page* itself
never overflows (the harness's own check passes, 0 problems) — the scrolling is correctly
contained to `.table-scroll`, exactly as designed. The defect is that the box the scroll
container gets is too narrow on screens with room to spare, not that overflow escapes
containment.

**2. The category table's drill-down panel renders outside the visible scroll window
when opened from a column the user has scrolled right (or left) to reach.**

`#category-table` has **24 columns**, not 23: `month` + the 21 entries in
`categories.py`'s `CATEGORIES` + `"Uncategorized"` (`export.py:67`,
`GLOBAL_COLUMNS = CATEGORIES + ["Uncategorized"]` — a 22nd category-like column not in
the fixed taxonomy) + the derived `Total` column. Confirmed by reading
`thead th` text content live: `month, Salary, Housing, ... Investments (21st), Banking,
Uncategorized, Total` = 24 headers. `Investments` is column **21 of 24**, not 20th as
initially assumed from the source alone — worth noting since a spec built only from
reading `categories.py` would get this wrong.

`toggleDrilldown()` (`insights.js:156`) inserts `<tr class="drilldown-row"><td
colspan={24}>` directly after the clicked row. The colspan'd `<td>` — and everything
inside it, including the "Category · Month · N transactions" header and Close button —
renders starting at the **table's own left edge**, not at the clicked cell's position.
Nothing scrolls `.table-scroll` to compensate.

**Reproduced live, programmatically (DOM geometry, not just a screenshot) at 1440px
desktop, matching the user's exact repro:**

1. Scrolled `.table-scroll` fully right (`scrollLeft = 1221`, its max).
2. Clicked the Investments cell on the 3rd data row (`2025-03`).
3. Drill-down row inserted; fetch resolved; content rendered.
4. `scrollLeft` after the click: **still 1221 — unchanged.**
5. The drill-down header's bounding rect: `left: -1027px, right: 760px`, against the
   scroll container's visible window `left: 178px, right: 776px`. `headerInViewport:
   false`. The panel — including its title, its Close button, and every transaction row
   — renders entirely off-screen to the left of the user's current scroll position, with
   no scrollbar affordance pointing them there. This is exactly the user's complaint:
   "there's no bar to do it with... hard to tell if the transactions are there or not."

**This will still repro after item 1's width fix ships.** Even removing the 1180px page
cap entirely, `.split`'s `1.4fr` share only gives the category panel ~58% of the row —
at 2560px that's still well under the space 24 currency-formatted columns need at a
readable width. Per the agreed build order (fix width first, then re-check), this spec
treats the drill-down-visibility defect as needing its own fix regardless of whether item
1 lands first — confirmed live rather than assumed.

## User story & spec

As the user reviewing category totals or the transaction queue on his desktop (this app
explicitly targets a laptop/monitor, not mobile — see `docs/FEATURES.md`'s rejected
"mobile-first redesign"), I want the page to use the screen I actually have, and I want
opening a drill-down to always show me what I just asked for — not force me to go hunting
left for it.

### A. Page width scales with viewport

- **Normal desktop (~1440px, the harness's own default):** `.page` must render wider
  than the current fixed 1180px. Acceptance: `.page`'s rendered width increases
  measurably above 1180px at this viewport, and `#review-table`'s `.table-scroll` no
  longer overflows by the full 301px measured today (some residual overflow is
  acceptable if the underlying review-queue row-density problem — backlog #8 — isn't
  also fixed in this pass; the goal here is width, not column layout).
- **Ultra-wide desktop (1920px, 2560px):** `.page` must continue to grow with viewport
  rather than staying pinned at 1180px. Acceptance: unused side margin at 1920px drops
  well below today's 370px/side, and at 2560px well below today's 690px/side — a generous
  but bounded max-width (so body text and form rows don't stretch into unreadable
  line lengths) is acceptable; a full, unbounded 100% width is not required. Whatever
  ceiling is chosen, panels containing `.table-scroll` (the review queue, the category
  table, the rules/balances tables) are the priority beneficiaries — they should get
  materially more real width at these sizes, not just the surrounding whitespace.
- **Narrow breakpoint (860px `.band`/`.split` single-column collapse, 480px `.calc-card`
  stacking) must stay intact, unchanged.** These are deliberate, already-shipped mobile/
  narrow accommodations (docs/FEATURES.md explicitly rejects a mobile-first redesign but
  keeps this breakpoint working) — this feature must not regress them. Acceptance: at
  480px and at 860px, layout and `document.documentElement.scrollWidth <=
  clientWidth + 1` (the harness's own overflow check) must continue to pass exactly as
  today.
- Not in scope: the review queue's own unpaginated-height problem
  (`index.html` is 6.8–9x the viewport tall at both widths tested — backlog #3) and its
  row-density issue (backlog #8). This feature is about horizontal width only; do not
  fold pagination or row-height changes in here.

### B. Category-table drill-down is always visible when opened

- When a user clicks a category cell whose column is currently scrolled out of the
  visible window (in either direction — off to the right, as in the reported repro, or
  off to the left), the resulting drill-down panel (header, loading skeleton, and once
  loaded its transaction table) **must end up inside the visible horizontal window of
  `.table-scroll`** immediately on open — not require the user to notice it's missing and
  go scrolling for it. Acceptance, mirroring the live geometry check already used to
  confirm the bug: after the click (and independent of whether the fetch has resolved
  yet — the loading skeleton must be visible too, not just the final content), the
  drill-down header's bounding-rect left/right must fall within the `.table-scroll`
  container's own visible left/right bounds.
- If the triggering cell (and therefore the panel, which renders at the *table's* left
  edge today) is already fully within the visible window when clicked, opening the panel
  must **not** introduce an unnecessary scroll jump — only scroll when the panel would
  otherwise render outside the visible area.
- Applies uniformly across all 24 columns, not just Investments — this is a structural
  fix (the panel's positioning/visibility relative to scroll state), not a special case
  for one category.
- Must keep working at the narrow (480px) breakpoint, where `.table-scroll` is already
  in near-constant horizontal-scroll use for the base table — same visibility guarantee
  applies there.
- Existing drill-down behavior is unchanged and must not regress: only one panel open at
  a time (`openDrilldown`), closing on re-sort, the loading/empty ("No transactions
  matched this cell — it may be a rounding artifact.")/error states from feature 009, and
  the description column's truncation-with-`title` convention. This spec adds
  *visibility*, not new data states.
- Edge case, left as an explicit judgment call for the implementing agent rather than
  mandated here: a browser resize while a panel is open is not required to re-run the
  visibility check dynamically — re-verifying visibility only needs to happen at open
  time. Note it as a known limitation if not handled, don't block on it.

## Architecture

**No backend, data-model, or API involvement.** Both defects are presentation-layer only —
a hardcoded CSS width and a missing scroll compensation in the DOM-manipulation code that
builds the drill-down row. Nothing here touches `backend/`: no new/changed endpoint, no
new response field, no migration, no change to `export.py`'s `GLOBAL_COLUMNS` or column
count. `SQLite`/`transactions.csv`/`account_paula.xlsx` are untouched and irrelevant to
this fix. This is 100% `frontend/styles.css` + `frontend/insights.js`. If, during
implementation, fintech-frontend finds a reason the fix needs new data from the API, stop
and flag it back rather than building around it — that would contradict this section.

### A. `.page` max-width (`frontend/styles.css:65-69`)

Replace the fixed `max-width: 1180px` with:

```css
.page {
  max-width: clamp(1180px, 92vw, 1680px);
  margin: 0 auto;
  padding: var(--space-8) var(--space-6) var(--space-12);
}
```

Reasoning:
- The clamp's floor (1180px) equals today's fixed value, and `92vw` only exceeds 1180px
  once the viewport passes ~1283px. Below that — including the 860px and 480px
  breakpoints the spec requires untouched — this resolves to exactly `1180px`, identical
  to current behavior. No separate media-query carve-out is needed for the narrow cases;
  the formula is self-limiting. `max-width` on a block element is an upper bound, not a
  forced width, so a "large" computed max-width at a narrow viewport is harmless — the
  element still can't exceed its containing block (`body`, which is itself capped to
  `max-width: 100%` with `overflow-x: hidden`).
- At 1440px (harness default): `0.92 × 1440 ≈ 1325px`, ~145px more than today — directly
  gives `.table-scroll` containers more room, chipping into the review table's 301px
  overflow and the category table's 1221px overflow. This pass is not required to
  eliminate either fully (see spec's "some residual overflow acceptable" carve-out tied to
  the out-of-scope row-density backlog item), so don't chase full elimination at the cost
  of the readability ceiling below.
- At 1920px: `0.92 × 1920 ≈ 1766px`, clamped to the 1680px ceiling → total side margin
  ≈240px, well below today's 740px.
- At 2560px: clamped to 1680px → total side margin ≈880px, well below today's 1380px.
- The 1680px ceiling is the "generous but bounded" ceiling the spec asks for — it bounds
  line length/form-row width on ultra-wide screens while still materially widening every
  `.table-scroll` panel, per the spec's stated priority.
- `1680px` and `92vw` are starting values, not gospel — fintech-frontend should verify the
  actual rendered numbers with `node scripts/ui-check.mjs` / a live DOM check (per
  `DEV-RUNBOOK.md`) and is free to nudge the vw fraction or ceiling if the review table's
  residual overflow is still uncomfortably large, as long as the 480px/860px breakpoints
  keep resolving to unchanged values and the ceiling doesn't approach an unreadable width.
- `.split`'s `1.4fr 1fr` ratio is intentionally untouched by this item — the spec is
  explicit that the category panel will still be too narrow for 24 columns after this fix
  regardless, and treats item B as a required fix independent of item A, not a fallback.

### B. Drill-down visibility (`frontend/insights.js`)

Root cause, precisely: `toggleDrilldown` (line 156) creates one `<tr><td colspan="24">`
and appends all drill-down content (header, skeleton/table/error) as direct children of
that `<td>`. Because the `<td>` itself spans all 24 columns, its own bounding rect always
overlaps part of `.table-scroll`'s visible window at *any* `scrollLeft` — so a visibility
check run against the `<td>` (or the `<tr>`) would always report "visible" and silently
fail to fix anything. **The check and the scroll compensation must target the
`.drilldown-header` element** (created by `renderDrilldownHeader`, always the first child
appended in all three states — loading/content/error), which has its own natural,
narrower width positioned at the `<td>`'s left edge — exactly the element the spec's own
acceptance criteria measures ("the drill-down header's bounding-rect left/right...").
This also sidesteps a second trap: `renderDrilldownContent` appends its own nested
`.table-scroll` div (line 271, wrapping the transaction table) *inside* the same `<td>`.
`.drilldown-header` is a sibling of that nested wrapper, not a descendant, so
`header.closest(".table-scroll")` unambiguously resolves to the outer category-table
scroll container — the one that actually needs scrolling. Do not call `closest()` from
inside the nested transaction-table wrapper; it would resolve to itself.

Recommended implementation: a small helper, called right after each of
`renderDrilldownLoading` / `renderDrilldownContent` / `renderDrilldownError` runs (i.e.
right after each `renderDrilldownHeader` call lands in the DOM) inside `toggleDrilldown`:

```js
function ensureDrilldownHeaderVisible(dTd) {
  const header = dTd.querySelector(".drilldown-header");
  const scrollEl = header?.closest(".table-scroll");
  if (!header || !scrollEl) return;
  header.scrollIntoView({ block: "nearest", inline: "nearest" });
}
```

- `scrollIntoView({ inline: "nearest" })` is preferred over hand-rolled `scrollLeft` math:
  it natively no-ops when the target is already fully within the scrollable ancestor's
  visible window, which is exactly the spec's "no unnecessary scroll jump" requirement,
  and it works uniformly for a column scrolled off-screen right *or* left without
  branching logic — satisfying "applies uniformly across all 24 columns." `block:
  "nearest"` avoids introducing a vertical page jump beyond whatever the row's own
  position already requires.
- Call it after the *loading* render too (not only after content/error resolves) — the
  spec explicitly requires the loading skeleton to be visible, independent of fetch
  timing. Calling it again after content/error render is cheap and correct: if the header
  hasn't moved (typical case), `scrollIntoView` is a no-op; it only re-corrects if the
  final content's width actually shifted the layout.
- Equivalent manual alternative (getBoundingClientRect diff against the scroll
  container's rect, adjusting `scrollLeft`) works too and is what the spec's own repro
  script used to *measure* the bug — either is acceptable, but `scrollIntoView` is less
  code and less likely to mis-handle an edge (e.g. header wider than the container).
- Known, accepted limitation per the spec: this is an open-time check only; a window
  resize while a panel is open does not re-run it. Note this in code as a comment, not a
  TODO to fix now.

### Risks / trade-offs

- `clamp()` and `scrollIntoView({ inline })` are both broad, long-standing browser
  support — no polyfill or new dependency, consistent with the offline-laptop constraint.
- The two items are independent and can be verified independently, but both change files
  `ui-check.mjs` already screenshots — a single verification pass after both land is fine.

## Implementation notes

No migration, no API contract change, no new dependency — this feature never touches
`backend/`. Architect and fintech-frontend jointly own this section: fintech-frontend
implements directly against the two approaches above in `frontend/styles.css` (item A)
and `frontend/insights.js` (item B), verifies with `node scripts/ui-check.mjs` plus the
live DOM bounding-rect checks the spec's Problem section already demonstrates, and records
the real before/after numbers here.

## Verification evidence

Implemented exactly as scoped: `frontend/styles.css` (item A + one additional necessary
fix in item B, explained below) and `frontend/insights.js` (item B). No backend files
touched. `data/finance.db` untouched — all checks below are read-only (`GET` requests via
the running app plus DOM inspection); no rows were created, edited, or deleted.

### A. Page width

Applied exactly the recommended CSS at `frontend/styles.css:65-76`:
`max-width: clamp(1180px, 92vw, 1680px);` (plus a comment explaining the formula).

`node scripts/ui-check.mjs` — clean: 0 console errors, 0 failed requests, 0 horizontal
overflow, all 8 screenshots (index/insights × desktop/narrow × light/dark) generated and
visually reviewed with the Read tool — layout is intact and matches the pre-existing
design system in both themes.

Wide-viewport numbers, measured with an ad hoc Playwright probe (`chromium.launch()`,
custom viewports, same harness pattern as `ui-check.mjs`, deleted after use since it isn't
part of the permanent suite):

| Viewport | `.page` width (before → after) | Side margin (before → after) | `#review-table` forced scroll (before → after) | `#category-table` forced scroll (before → after) | Page overflow |
| --- | --- | --- | --- | --- | --- |
| 1440px | 1180px → **1324.8px** | 260px → 115px | 301px → **156px** | 1221px → **1136px** | false |
| 1920px | 1180px → **1680px** (ceiling) | 740px → **240px** | unmeasured → **0px** | unmeasured → **929px** | false |
| 2560px | 1180px → **1680px** (ceiling) | 1380px → **880px** | unmeasured → **0px** | unmeasured → **929px** | false |

All match or beat the spec's predictions (1325px/240px/880px predicted vs. 1324.8px/240px/
880px measured — exact). Review table overflow eliminated entirely at ≥1920px; category
table's residual 929px overflow at wide viewports is expected and accepted per the spec
("`.split`'s 1.4fr/1fr ratio is intentionally untouched by this item" — 24 columns still
don't fit even at the 1680px ceiling).

Breakpoint self-limiting behavior confirmed directly, including the exact crossover the
architecture doc predicted:
- 1282px viewport → `.page` renders **1180px** (floor, identical to old fixed value).
- 1283px viewport → `.page` renders **1180.36px** (just past the ~1283px crossover where
  `92vw` first exceeds 1180px) — confirms the formula's self-limiting math precisely.
- 860px viewport → `.page` renders 860px (the viewport itself is the binding constraint,
  not the 1180px cap — `max-width` is an upper bound, as the architecture doc noted), `.band`'s
  `grid-template-columns` computes to a single `812px` track (collapsed, single-column) —
  unchanged from pre-fix behavior.
- 480px viewport → `ui-check.mjs`'s own overflow check passes (part of the standard run
  above).

### B. Drill-down visibility

Implemented the recommended `ensureDrilldownHeaderVisible()` helper in
`frontend/insights.js`, called after `renderDrilldownLoading`, `renderDrilldownContent`,
and `renderDrilldownError` inside `toggleDrilldown` — exactly the three call sites and
timing the architecture doc specified.

**One deviation from the architecture doc, found and fixed during implementation:** the
doc's premise that `.drilldown-header` "has its own natural, narrower width positioned at
the `<td>`'s left edge" is incorrect in the current CSS. `.drilldown-header` is
`display: flex` with no width set — a block-level flex container defaults to filling its
containing block, which here is the colspan-24 `<td>` (~1800px). Measured directly before
any CSS change: with the table scrolled fully right and the header rendered, its bounding
rect was `left: -998px, right: 788.8px` — **1787px wide**, matching the `<td>`'s content
width almost exactly, not a compact title/button bar. This meant `header.scrollIntoView()`
was structurally unable to satisfy the acceptance criterion (an element wider than its
scroll container can never have both edges simultaneously within the container's visible
window), and — independently — the Close button was already rendering far outside the
default (unscrolled) visible window even before this feature, because `justify-content:
space-between` pushed it to the far right of that same ~1800px box. Fixed with one added
rule in `frontend/styles.css` (`.drilldown-header { width: fit-content; max-width: 100%; }`,
with a comment recording why). This is still 100% within the two files the architecture
doc scoped (`styles.css` + `insights.js`), not a backend or data-model change, so it did
not require flagging back per the "stop and flag" rule (that rule is specifically about
needing new API data, which this doesn't).

Live DOM geometry check at 1440px, reproducing the spec's exact repro (ad hoc Playwright
probe, deleted after use):

1. Scrolled `#category-table`'s `.table-scroll` fully right (`scrollLeft = 1136`, max).
2. Clicked the Investments cell (column 21 of 24, confirmed via live header text) on the
   2025-03 row.
3. **Loading state** (immediately after click, before fetch resolves): `scrollLeft` jumped
   to `16`; header bounding rect `left: 105.6, right: 321.0`, exactly matching the
   `.table-scroll` container's own `left: 105.6, right: 788.4` — `inView: true`.
4. **Content state** (after fetch resolved, 18 transactions rendered): header widened
   slightly (`right: 423.3`, from the added "18 transactions" text) but stayed fully
   within the container — `inView: true`.
5. **No-unnecessary-scroll-jump case**: reset scroll to `0`, clicked an already-visible
   column (Salary, first category column). `scrollLeft` was `0` before the click, `0`
   after the loading render, and `0` after content resolved — confirmed no scroll jump.
6. **Narrow breakpoint (480px)**: scrolled fully right, clicked Investments on 2025-03 —
   header `inView: true`, page overflow still `false`.
7. Visually confirmed with screenshots (`.artifacts/drilldown-open-{light,dark,narrow}.png`,
   reviewed with the Read tool): the panel — title, transaction count, Close button, and
   the 18-row transaction table underneath — renders immediately visible in both themes
   and at the narrow width, with the Close button now readable next to the title instead
   of off-screen.

**Note on "either direction" (off-screen right vs. left):** in this codebase the
drill-down `<tr>`/`<td>` is always inserted spanning the full row starting at the table's
left edge (`x = 0` in table coordinates) regardless of which column was clicked — so the
header can only ever render off-screen to the *left* of the visible window (when
`scrollLeft > 0`), never to the right. The fix (via `scrollIntoView`) handles this
correctly and would equally handle a hypothetical off-screen-right case if the DOM
structure ever changed to position the panel at the clicked column instead of the row
start, but that scenario doesn't currently arise given how `toggleDrilldown` builds the
row.

### What was NOT verified

- The 860px breakpoint's drill-down visibility specifically (spec asks it be confirmed
  "at the narrow (480px) breakpoint" explicitly, and separately asks 860px only for the
  `.band`/`.split` collapse, not drill-down — both were checked as scoped, but drill-down
  was not separately re-checked at exactly 860px, only at 480px and 1440px).
- A window resize while a panel is open — explicitly out of scope per the spec's own
  judgment-call carve-out, and left as a known, accepted limitation (documented in a code
  comment in `insights.js`).
- The empty-state ("No transactions matched...") and error-state drill-down renders were
  not re-tested against the visibility fix in this pass — only loading and content states
  were geometry-checked live. Both call the same `renderDrilldownHeader` +
  `ensureDrilldownHeaderVisible` path as the tested content state, so the mechanism should
  apply identically, but this was not independently observed.
- Mutating interactions (creating/editing a rule, classifying a transaction) were not
  touched — this feature is presentation-only and none were needed.
- Cross-browser (only Chromium, via Playwright, was used — consistent with `ui-check.mjs`'s
  existing scope).

All of the spec's acceptance criteria for both item A and item B passed against the
numbers and checks above.
