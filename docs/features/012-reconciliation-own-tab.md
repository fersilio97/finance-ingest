# 012 — Reconciliation gets its own top-level tab
Status: Shipped
Iteration: 5

## Problem

Reconciliation is not an insight. Everything else on `insights.html` is an aggregation
you *read* — a balance-trend chart, a category-totals table — whereas Reconciliation is
a check you *run*: does the balance the app derived from transactions match the balance
the user actually recorded by hand. Grouping it with the analytical content buries a
verification tool inside an analysis page, and makes "did that account actually
reconcile?" one more scroll than it needs to be for a single-user app whose whole job is
closing the books with confidence each month.

Confirmed live against `http://127.0.0.1:8000` (`node scripts/ui-check.mjs --page
insights`, screenshots read, `GET /api/insights/reconciliation` curled directly):

- `frontend/insights.html:59-66` puts `<h2>Reconciliation</h2>` as the second half of a
  `<div class="split">` two-column grid (`styles.css:157-161`,
  `grid-template-columns: 1.4fr 1fr`) whose first half is "Category totals by month" —
  two unrelated jobs (an analytical table and a verification checklist) sharing one row
  because of a CSS layout, not because they're related. The `.top-bar` nav
  (`insights.html:11-16`, identical block at `index.html:11-16`) is a hardcoded two-link
  `<nav>`, not a tab switcher — there is no third destination to send Reconciliation to
  without adding one.
- Today's live data is the empty state: `GET /api/insights/reconciliation` returns `[]`
  — the screenshot shows "No balances recorded yet — record one to start reconciling."
  sitting to the right of a fully-populated category table, i.e. the page's least
  "insight"-like content is also, right now, its emptiest-looking corner.
- The Reconciliation panel's own logic (`STATE_LABEL`, `STATE_ORDER`, `money()`,
  `reconciliationSummary()`, `buildReconciliationCard()`, `renderReconciliationList()` —
  `insights.js:314-433`) is already fully self-contained: it only touches
  `#reconciliation-*` element ids and one endpoint, `GET /api/insights/reconciliation`.
  Nothing in the balance-trend chart or category-table code reads or writes
  Reconciliation's DOM or state, and vice versa (confirmed by reading `insights.js` in
  full — the only shared symbols are the generic `jsonFetch()`/`API` helpers and the
  `formatRecordedAt()` date formatter, both trivially reusable from a new file). This is
  an extraction, not a rewrite.

**Backend: no change needed.** `GET /api/insights/reconciliation` (shipped in features
005/008) already returns exactly the per-entry rows this panel needs, independent of any
other Insights endpoint. This is a pure frontend restructuring: a new static page, a nav
update on every page, and moving existing markup/CSS classes/JS functions that already
work.

## User story & spec

**As the user closing the books for the month, I want Reconciliation as its own tab so I
can check "does everything actually match" without wading through the category-totals
table to get to it, and without Reconciliation reading as one more chart to interpret.**

### Navigation

- Add a third top-level page: `frontend/reconciliation.html`, nav label **"Reconciliation"**,
  positioned to the right of "Insights" (order: Upload & Review · Insights ·
  Reconciliation) per the approved capture note.
- Update the literal `<nav>` block in **all three** pages (`index.html`, `insights.html`,
  the new `reconciliation.html`) to list all three links, each with `aria-current="page"`
  on the link matching the current page — the same pattern already used for the existing
  two. `.top-bar nav` is `display:flex; gap:...` with no `nth-child`/count-dependent CSS
  (`styles.css:96-119`), so a third link is a markup-only change; no CSS changes are
  needed for the nav itself.
- `<title>` on the new page follows the existing per-page pattern (`"Finance Ingestion
  App — Insights"`) → `"Finance Ingestion App — Reconciliation"`. `<h1>` is
  "Reconciliation".

### Page content — what moves, verbatim

Move, unchanged in behavior and copy:

- The eyebrow description: *"Each balance you've recorded, checked against the balance
  derived from transactions as of that moment — not just end-of-month."*
- `#reconciliation-summary`, `#reconciliation-list`, `#reconciliation-empty`,
  `#reconciliation-error` and everything that renders into them.
- The tri-state visual language (spec 003, carried through 008): `off` = `--negative`,
  `balanced` = `--positive`, `not_checked` = `--text-muted`, worst-first sort
  (`off` → `not_checked` → `balanced`).
- The summary line copy (all four cases from `reconciliationSummary()`), the per-card
  layout (`account · recorded_at`, derived balance, recorded balance, status, the
  `not_checked` → "Review in Balances →" remedy link to
  `index.html?account=<account>#balances-section`).

**One structural change, not a redesign:** drop the redundant heading. Today the panel
has its own `<h2>Reconciliation</h2>` *inside* `insights.html`'s `<h1>Insights</h1>`
page — distinct text, no duplication. On its own page, the page `<h1>` is already
"Reconciliation," so keeping a second, identical `<h2>Reconciliation</h2>` directly below
it would stack the same word twice for no reason. Drop the inner `<h2>`; keep the eyebrow
paragraph directly under `<h1>`, then the summary/list/empty/error elements — the same
pattern `index.html`'s tiles use where the page title alone suffices. Everything below
the heading is otherwise byte-for-byte the same markup, same ids, same classes.

The page's single panel gets full page width (no `.split` sibling to share a grid row
with) — consistent with how `insights.html`'s own "Balance trend" panel already sits full
width above its `.split` row.

### Consequence on `insights.html`: unwrap the now-single-child `.split`

Removing Reconciliation leaves "Category totals by month" as the *only* child of
`<div class="split">` (`grid-template-columns: 1.4fr 1fr`). Left as-is, CSS grid
auto-placement puts that one panel into the first (1.4fr) track and leaves the second
(1fr) track empty — the category table would stay exactly as squeezed as feature 011
already measured it (**1221px of forced horizontal scroll at 1440px desktop**,
`docs/features/011-responsive-page-width-and-drilldown-visibility.md`), now with visibly
wasted empty space beside it instead of Reconciliation. **The `.split` wrapper must be
removed** (or the panel promoted out of it) so "Category totals by month" spans the full
page width, matching the single-panel pattern the Balance trend panel above it already
uses. This isn't new scope-creep polish — it's the minimum needed so this move doesn't
visually regress a table 011 already flagged as too narrow.

### States (carried over unchanged — this is a move, not a redesign)

- **Empty** (today's actual live state — `GET /api/insights/reconciliation` returns `[]`
  right now): *"No balances recorded yet — record one to start reconciling."*, with a
  real link to `index.html#balances-section`, unchanged.
- **Error**: `#reconciliation-error` shows *"Couldn't load reconciliation — {message}."*,
  unchanged.
- **Loading**: carried over exactly as it is today — which is worth stating plainly
  rather than assuming: there is **no explicit skeleton** for this panel currently
  (unlike e.g. `#balance-strip-loading`). `#reconciliation-summary` starts present but
  text-empty, `#reconciliation-list` starts empty, both `-empty`/`-error` start hidden;
  the panel is blank until the fetch resolves. That's a pre-existing gap, not something
  this move introduces — flagging it for completeness (the runbook requires every async
  region to define a loading state) but **not fixing it here**, to keep this feature a
  pure relocation. Worth a follow-up backlog item on its own.
- **1000+ rows**: `renderReconciliationList()` appends one card per row with no
  pagination or virtualization. Unlike the review queue (862 rows, machine-generated from
  bank exports), reconciliation entries are hand-recorded one at a time via the Balance
  Entries form — 0 exist in the live DB today, and the realistic ceiling is dozens over
  years of manual entry, not thousands. Not a real scale risk the way the queue was;
  noting it to satisfy the "what happens with 1000+ rows" question honestly rather than
  silently skipping it, not proposing pagination.

### Forward-looking note (not in scope — for whoever builds the p2 "Balance Entries" move)

A separate, lower-priority backlog item will later move the "Balance Entries" recording
panel (currently `index.html#balances-section`) into this same new page, as a second
section alongside Reconciliation. Don't build this page as a single hardcoded panel with
no room for a sibling: keep the page body a simple vertical stack of `<section
class="panel">` elements (the same pattern `insights.html` already uses for its own
multiple panels), not a one-off layout that assumes exactly one section forever. No
action needed now beyond not fighting that later — this feature does not add the second
section itself.

## Architecture

**No backend, data model, or migration change.** Confirmed live rather than taken on
faith:

- `curl -s http://127.0.0.1:8000/api/insights/reconciliation` → `200`, body `[]` (real
  server, real DB, today's actual empty state — matches the Problem section's capture).
- `backend/app/api/insights.py` is the sole owner of `GET /api/insights/reconciliation`
  (`insights.py:36-45`): it calls `build_reconciliation()` from `pipeline/export.py`, the
  same builder the xlsx export uses. Nothing in this feature touches that function, the
  `balance_entries`/`transactions` tables, or any migration in `db.py`.
  `backend/app/api/routes.py` has zero occurrences of "reconciliation" — it owns upload,
  trigger, transactions, rules, and balance-entries CRUD, none of which this feature
  changes. Moving the panel to its own page doesn't change what data it asks for or how
  the server computes it, only where the existing fetch/render lands in the DOM.
- No new endpoint is needed either: the panel already fetches its own data
  independently (`insights.js:401`, `jsonFetch('${API}/reconciliation')`) rather than
  sharing a payload with category-totals or balance-trend, so relocating it doesn't
  strand a shared fetch or require splitting one.

This is entirely a frontend file-boundary exercise. Since this repo has no build step or
framework (per `docs/DEV-RUNBOOK.md`'s Frontend conventions — vanilla HTML/CSS/JS), the
"data model" here is just: which HTML lands in which `.html` file, and which JS functions
move to a new `.js` file vs. stay behind. Handing this off to `fintech-frontend` as a
concrete plan so file boundaries don't need to be re-derived:

### New file: `frontend/reconciliation.js`

Move verbatim from `frontend/insights.js`, lines 314–433 (the whole
`/* Reconciliation */` comment block through the end of `renderReconciliationList()`) —
that's `STATE_LABEL`, `STATE_ORDER`, `money()`, `reconciliationSummary()`,
`buildReconciliationCard()`, `renderReconciliationList()`. This block already only
touches `#reconciliation-*` ids and one endpoint; no other function in `insights.js`
calls into it or reads its module-level state, so there's nothing to untangle.

Also copy (not move — both `insights.js` and `reconciliation.js` need it, and it's 4
lines, same "duplicated on purpose" call the existing code already made per its own
comment at `insights.js:18-21`):
- `API` constant (`insights.js:1`, `"/api/insights"`)
- `jsonFetch()` (`insights.js:3-7`)
- `formatRecordedAt()` (`insights.js:22-26`)

End of the new file: its own init, mirroring the pattern at `insights.js:944-946`:
```js
(async function init() {
  await renderReconciliationList();
})();
```

### Edited file: `frontend/insights.js`

Delete lines 314–433 (the moved block) and the now-unused pieces of the doc comment at
310-312. Change the final `init()` (944-946) from
`Promise.all([renderCategoryTable(), renderReconciliationList(), loadAndRenderBalance()])`
to `Promise.all([renderCategoryTable(), loadAndRenderBalance()])`. Leave `API`,
`jsonFetch()`, `formatRecordedAt()`, `cssVar()`, `setEmpty()` in place — every one is
still used by the category-table and balance-trend code that stays on this page.

### New file: `frontend/reconciliation.html`

Same `<!doctype html>`/`<head>` skeleton as `insights.html`, with:
- `<title>Finance Ingestion App — Reconciliation</title>`
- `<h1>Reconciliation</h1>` in `.top-bar`, three-link nav (see below)
- Body: a single `<section class="panel">`, **not** wrapped in `.split` (full width, same
  top-level pattern as `insights.html`'s own "Balance trend" panel at lines 19-38) — and
  per the spec's forward-looking note, don't hardcode assumptions of exactly one panel;
  a plain vertical stack of `.panel` sections is the existing convention (see
  `insights.html` itself, three stacked/split panels) and needs no special scaffolding to
  support a second section landing here later.
- Inside the panel: **no repeated `<h2>Reconciliation</h2>`** (the spec's one structural
  change — the page `<h1>` already says it). Keep, verbatim: the eyebrow `<p>`
  (`insights.html:61`), then `#reconciliation-summary`, `#reconciliation-list`,
  `#reconciliation-empty`, `#reconciliation-error` (`insights.html:62-65`), same ids,
  same classes, same order.
- `<script src="reconciliation.js"></script>` at the bottom, same non-module classic-script
  pattern `insights.html` uses for `insights.js`.

### Edited file: `frontend/insights.html`

- Remove the entire second `<section class="panel">` (lines 59-66, the Reconciliation
  panel) from inside `.split`.
- **Unwrap `.split`**: with only "Category totals by month" left as a child, remove the
  `<div class="split">`/`</div>` wrapper (lines 40 and 67) and leave that `<section
  class="panel">` (lines 41-57) as a direct child of `.page`, full width — matching how
  the Balance trend panel above it already sits. Do not leave an empty `.split` or a
  single-child grid; `styles.css:157-161`'s `1.4fr 1fr` template is exactly what caused
  the 011-flagged squeeze and would leave a dead empty second track today.
- Update `<nav>` (lines 13-16) to the three-link version below.

### Edited file: `frontend/index.html`

Update `<nav>` (lines 13-16) to the three-link version below only — no other change on
this page.

### Nav block (all three pages)

Per spec: order Upload & Review · Insights · Reconciliation, `aria-current="page"` on
whichever link matches the current page. `styles.css:96-99`'s `.top-bar nav` is
`display:flex; gap:...` with no child-count-dependent selector, so this is a markup-only
change — confirmed by reading the full nav ruleset (`styles.css:76-118`), no CSS edit
needed for the nav itself:

```html
<nav>
  <a href="index.html">Upload &amp; Review</a>
  <a href="insights.html">Insights</a>
  <a href="reconciliation.html">Reconciliation</a>
</nav>
```

(with `aria-current="page"` moved onto whichever `<a>` matches the page it's on, same as
today's two-link pattern).

### Risks / trade-offs

- **Duplication of three small helpers** (`API`, `jsonFetch`, `formatRecordedAt`) across
  `insights.js` and `reconciliation.js`, rather than a shared `common.js`. Consistent
  with this codebase's existing precedent (the comment at `insights.js:18-21` already
  made this call once) and proportionate to 4-7 lines each; introducing a third `<script>`
  include and a shared-file dependency for this little logic isn't worth it on a
  no-build-step static site. If a fourth page needs the same helpers, that's the trigger
  to reconsider, not this feature.
- **CSS risk is contained**: removing `.split` from `insights.html` only affects that one
  page's one grid; `.split` itself stays in `styles.css` unchanged (still used by
  `index.html`'s two two-panel `.split` rows), so no shared-stylesheet risk.
- No API contract changes for `fintech-frontend` to account for — same request
  (`GET /api/insights/reconciliation`), same response shape, same states (empty/error/no
  explicit loading skeleton, all carried over unchanged per spec).

## Implementation notes

Implemented exactly per the architect's file-level plan; no deviations to the shape of
the change, one small addition to the verification harness.

**Files changed:**

- **New `frontend/reconciliation.js`** — moved `STATE_LABEL`, `STATE_ORDER`, `money()`,
  `reconciliationSummary()`, `buildReconciliationCard()`, `renderReconciliationList()`
  verbatim from `insights.js:314-433`. Copied (not moved) `API`, `jsonFetch()`,
  `formatRecordedAt()` — identical text to the versions still in `insights.js`/`app.js`,
  per this codebase's existing "duplicated on purpose" convention. Ends with
  `(async function init() { await renderReconciliationList(); })();`.
- **Edited `frontend/insights.js`** — deleted the moved block and its doc comment
  header. `init()` now runs `Promise.all([renderCategoryTable(), loadAndRenderBalance()])`.
  `API`, `jsonFetch()`, `formatRecordedAt()`, `cssVar()`, `setEmpty()` all left in place —
  `formatRecordedAt()` is still called from `attachTooltip()`'s entry-marker tooltip.
- **New `frontend/reconciliation.html`** — single full-width `<section class="panel">`,
  no `.split`, no inner `<h2>Reconciliation</h2>` (the page `<h1>` already says it).
  Eyebrow paragraph and `#reconciliation-summary` / `-list` / `-empty` / `-error` carried
  over byte-for-byte in the same order. `<script src="reconciliation.js">` as a classic
  (non-module) script, matching `insights.js`'s own inclusion pattern.
- **Edited `frontend/insights.html`** — removed the Reconciliation `<section>` and
  unwrapped `.split` (removed the wrapper div, not just one child), leaving "Category
  totals by month" as a direct full-width child of `.page`, matching the Balance Trend
  panel's own top-level placement.
- **Edited `frontend/index.html` and `frontend/insights.html`** — nav now lists all
  three pages with `aria-current="page"` on the current one.

**Judgment calls:**

- `scripts/ui-check.mjs` needed two changes, not one. Adding `reconciliation` to `PAGES`
  was expected. What wasn't: the naive `waitFor: "#reconciliation-list,
  #reconciliation-empty"` (mirroring the existing `insights`/`index` entries' pattern)
  hung for the full 10s timeout on every run, even though the page renders correctly.
  Root cause, confirmed with a throwaway Playwright probe: `#reconciliation-list` is
  first in DOM order and, in today's live empty-data state, is a childless `<div>` with a
  real (non-zero) width but 0 height — Playwright's `waitForSelector` resolves the
  selector to the first DOM match and only that match is checked for "visible," so it
  never falls through to check `#reconciliation-empty` (which *does* have a non-zero box
  once `hidden` is cleared). This is a pre-existing gap in the harness's `waitFor`
  convention that the insights/index pages never exposed because their equivalent
  "populated" element always has content today. Fixed by changing the selector to
  `"#reconciliation-list:not(:empty), #reconciliation-empty:not([hidden]),
  #reconciliation-error:not([hidden])"` — verified by hand with a scratch Playwright
  script before and after (times out before, resolves immediately after) — then deleted
  the scratch script. This only touches the reconciliation page's `waitFor` entry; the
  `index`/`insights` entries are untouched.
- No CSS changes were needed beyond the structural HTML edits above — `.top-bar nav` is
  already `display:flex` with no child-count selectors (confirmed by reading
  `styles.css:96-119`), and `.panel` needed no changes to render full-width once outside
  `.split`.

## Verification evidence

**Backend contract confirmed live before wiring the fetch**, per the architect's note:
`curl -s http://127.0.0.1:8000/api/insights/reconciliation` → `200`, body `[]` (today's
real empty state — matches what both the old and new panel now render).

**Browser verification**: `node scripts/ui-check.mjs` (all three pages, light + dark,
desktop 1440px + narrow 480px = 12 screenshots) — clean run, no console errors, no failed
requests, no horizontal page overflow:

```
✓ No console errors, failed requests, or horizontal overflow.
```

**All 12 screenshots opened and read with the Read tool** (not just the pass/fail exit
code):

- **Nav, all three pages, light + dark**: `index.html`, `insights.html`,
  `reconciliation.html` each show all three links — "Upload & Review · Insights ·
  Reconciliation" — with the current page underlined/accented via `aria-current="page"`.
  Confirmed on desktop; on the 480px narrow viewport the nav wraps to two lines (existing
  behavior, unchanged by this feature — same wrap the two-link nav already had).
- **`reconciliation.html`, desktop + narrow, light + dark**: renders the eyebrow copy,
  then the real empty state — "No balances recorded yet — record one to start
  reconciling." with a working-looking link to `index.html#balances-section` — matching
  today's live `[]` response. No inner `<h2>` duplicate of the page `<h1>`. No horizontal
  overflow at either width.
- **`insights.html`, desktop + narrow, light + dark**: Reconciliation panel is gone;
  "Category totals by month" (with its nested "Account balances" strip and "By category"
  table) now sits full width as a direct child of `.page`, visually matching the Balance
  Trend panel's width above it — no more squeezed 1.4fr column, no dead empty second grid
  track.
- **`index.html`, desktop + narrow, light + dark**: unchanged content, nav updated to
  three links, no regressions.

**Horizontal-overflow measurement (the specific number requested)**: wrote a throwaway
Playwright probe against the live `insights.html` at 1440×1000, measuring
`.table-scroll#category-table`'s `scrollWidth - clientWidth`:

- **Before (feature 011's own measurement, `.split` 1.4fr column)**: 1221px of forced
  horizontal scroll.
- **After (this feature, full page width)**: **590px** — `scrollWidth: 1819`,
  `clientWidth: 1229`.

That's a 631px reduction (~52%), consistent with the panel's available width roughly
doubling (from the 1.4fr share of a two-column `1.4fr 1fr` split minus the row gap, to
100% of the page). The table still scrolls internally at 1440px — 24 columns of monthly
category data is inherently wide, and no scope in this feature was to fix that further —
but the scroll is meaningfully smaller, which was the explicit non-regression bar this
feature had to clear.

**Mutating interaction**: none required. This feature is a pure read/relocate; no
classify/add-rule/add-balance-entry flow was touched, so nothing needed throwaway-value
testing.

**What was NOT verified**:
- The **non-empty** reconciliation states (`balanced`, `off`, `not_checked` cards; the
  four different summary-line copy variants) were not visually re-verified on the new
  page, because live data is `[]` — there is nothing to record a screenshot of. This
  logic moved verbatim (byte-for-byte identical to what shipped and was verified in
  features 003/008) and touches no code this feature edited, so it's treated as carried
  forward rather than re-tested. If a future feature adds balance entries to the live DB,
  a screenshot of the populated tri-state cards on `reconciliation.html` would be worth
  taking then.
- No load-testing at "1000+ rows" scale (spec explicitly deemed this a non-risk for
  hand-entered data and did not ask for pagination).
- Did not test the `#reconciliation-error` path (would require simulating a backend
  failure) — carried over unchanged from the prior implementation, not touched by this
  move.
