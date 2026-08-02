# 017 — Insights: lead with the unclassified total

Status: Shipped
Iteration: 8

Frontend-only, against an unchanged API. Per the feature-loop skill's entry-point table
this skips `ux-lead`/`solution-architect` — the data returned by
`GET /api/insights/category-monthly` is already correct server-side; this is purely a
frontend reorder + headline. This doc stands in for the usual three-agent split, written
entirely by the frontend engineer, following 016's precedent for frontend-only docs.

## Problem

Discovery (this session's `fintech-ux-lead` pass, re-measured live 2026-08-01) found the
category-by-month table on `insights.html` buries its single most actionable number:

- `Uncategorized` sits at index 22 of the 24 columns the API returns (`month` first, then
  21 real categories, then `Uncategorized`, then `Total`) — off-screen at a normal desktop
  width, reachable only by scrolling the table's own `.table-scroll` container all the way
  right.
- 51.9% of the table's data cells (227 of 437 non-`month` cells, re-confirmed live) are
  exactly `0.00` — real numbers have to compete visually with a wall of zeros even once you
  do scroll to a column.
- The hidden number is real money. **Re-verified live via `curl
  http://127.0.0.1:8000/api/insights/category-monthly` before building** (per this feature's
  own instruction not to trust the discovery paraphrase): total Uncategorized across the 19
  months on disk is **-5,625.08**, with one month — 2025-01 — alone at **-5,185.72**.

**Discrepancy found during reconfirmation, worth flagging explicitly:** the discovery
brief's stated total was **-8,166.18**; the live total I measured is **-5,625.08**. The
per-month spot-check (2025-01 at -5,185.72) matches the brief exactly, so the brief wasn't
wrong when written — the aggregate has simply moved since, most plausibly because rows have
been reclassified (via new rules or manual correction) in the days between that pass and
this one. The number below is a *live, formula-driven* value computed from the same fetch
the table already makes, so it will always reflect current data rather than either of these
snapshots.

This is also backlog rank #6 from `docs/FEATURES.md` ("Insights: lead with how much is
still unclassified"), left unapproved after iteration-1 discovery. Shipping it here as 017.

## Design decisions

### A headline stat panel, first on the page — not a table restyle alone

Added a new `.panel` section, **above Balance trend**, i.e. the very first thing on
`insights.html`: a large (`2.25rem`, serif display font matching the app's heading
treatment) tabular-nums figure for total Uncategorized, plus two lines of muted micro-copy
(how many months had any unclassified activity at all, and which single month was worst).
This is deliberately *not* folded into the existing account-balance strip (`.balance-tile`,
feature 009) — those are six same-shaped per-account tiles; this is one number that needs
to read as categorically different (literally: it's not an account, it's a gap in the data)
and to lead the page, not sit inside another section's subsection.

Colored `var(--negative)` only when non-zero, following the existing `.calc-state-off`
convention ("the only state in this panel allowed to use red" — 003 §A.3): red here means
"there is something to review," the same semantics as a reconciliation mismatch, not a
generic "negative number" treatment.

No second network request: `renderUncategorizedHeadline()` is called from
`renderCategoryTable()`'s existing `category-monthly` fetch, so the headline and the table
can never disagree, and it inherits the same three states (loading skeleton, empty
micro-copy, error message) already required.

### Table: pin `Uncategorized` right after `month`, dim exact-zero cells

Rather than change the API's column order (out of scope — API is server-owned and
unchanged per this feature's brief), `orderedColumns()` in `insights.js` reorders the
already-fetched column list client-side: `month`, `Uncategorized`, `Total`, then every
other category in its original order. Row sort (`sortComparator`) and the per-cell
drill-down (`toggleDrilldown`) are both keyed by column **name**, not position, so
reordering columns doesn't touch either — confirmed live, see Verification evidence.

Exact-`0.00` cells get a `.cell-zero` class (dimmed to `var(--text-muted)`, full color
restored on hover/focus) rather than being hidden, greyed to the point of illegibility, or
made non-interactive. They stay clickable — the existing comment in the code already notes
a `0.00` total can hide two offsetting transactions worth seeing, which the drill-down
still needs to serve.

**Judgment call the user may want to weigh in on:** I placed `Uncategorized` immediately
after `month` (i.e. before `Total`) rather than, say, last-before-Total or leaving `Total`
first. Reasoning: of the two "not a real category" columns, `Uncategorized` is the
actionable one (a call to go classify something); `Total` is a reference figure you read
*after* you've decided whether to trust a row's Uncategorized number. Putting the
actionable column first felt like the more useful default, but a reasonable case exists for
`Total` leading since it's a more familiar "let me confirm this row is sane" first read.

**Also flagging:** the discovery brief only asked to resolve backlog rank #6 implicitly (it
*is* rank #6), but I went ahead and marked #6 resolved in `docs/FEATURES.md`'s backlog table
too, alongside the four ranks (#3, #7, #8, #9) the task explicitly named — leaving the exact
backlog item this feature ships marked "unapproved" while the feature itself ships read as
an oversight rather than a deliberate choice, so I closed it out consistently with how 014
closed out rank #4 and 009 closed out rank #10.

## Implementation

`frontend/insights.html`, `frontend/insights.js`, `frontend/styles.css` only. No backend
changes, no new endpoints, no DB reads/writes of any kind needed to build or verify this.

- `insights.html`: new `<section class="panel">` ("Uncategorized spending") inserted before
  the existing "Balance trend" panel, with the loading/content/empty/error element
  quadruplet matching every other async region on the page. Eyebrow copy on the existing
  category-table panel updated to describe the pin + dimming.
- `insights.js`:
  - `renderUncategorizedHeadline(rows, error)` — new function, called from
    `renderCategoryTable()` with the same fetched rows (or the same caught error) it
    already has; computes the total, the count of months with any nonzero Uncategorized
    activity, and the single worst month by absolute value.
  - `orderedColumns(rawColumns)` — new function, called once at the top of
    `renderCategoryTableBody()` in place of the raw `Object.keys(...)`.
  - Cell-rendering loop: added an `isZero` check that adds `.cell-zero` to the `<td>` (and
    additionally to the `<button class="cell-link">` for clickable cells) when a value is
    exactly `0`.
- `styles.css`:
  - `.headline-stat-value` / `.headline-stat-value.negative` / `.headline-stat-label` /
    `.headline-stat-detail` — new rules for the headline panel, all built from existing
    custom properties (`--negative`, `--text-muted`, `--font-display`, `--space-2`), no new
    colors.
  - `td.num.cell-zero`, `button.cell-link.cell-zero` (+ its own `:hover`/`:focus-visible`
    override back to full color) — new rules, placed next to the existing
    `button.cell-link` block.

## Verification evidence

**Numbers reconfirmed live before building**, via
`curl http://127.0.0.1:8000/api/insights/category-monthly` piped through a short Python
script (not just eyeballing the JSON): 19 months, 24 columns including `month`,
`Uncategorized` at 0-based index 22, 227/437 non-`month` cells exactly `0` (51.9%), total
Uncategorized -5,625.08, 2025-01 alone at -5,185.72 (this last figure matches the discovery
brief exactly; the total does not — see Problem section above for the discrepancy and why
I used the live number, not the brief's, in the shipped UI).

**`node scripts/ui-check.mjs`** (all 4 pages × 2 viewports × 2 themes = 16 screenshots):
clean — 0 console errors, 0 failed requests, 0 horizontal overflow. `index` unchanged at
6,505px/4,548 DOM nodes (273 rows in `needs_review` today), confirming this change didn't
touch other pages.

**Opened and visually reviewed every insights screenshot** (`insights-desktop-light`,
`insights-desktop-dark`, `insights-narrow-light`, `insights-narrow-dark`) with the Read
tool:
- The "Uncategorized spending" headline renders as the first panel on the page in all four
  combinations, fully visible without scrolling at 1440px, `-5625.08` in `var(--negative)`
  (dark red on light background, a legible coral on dark), micro-copy readable underneath.
- At 480px it still renders first, above the balance-trend chart, no truncation, no overflow.
- Both themes render the tile with correct contrast; no hardcoded colors were used (spot
  checked the diff itself, not just the screenshots).

**Table reorder + zero-dimming**, via a throwaway Playwright script (written to the
scratchpad, copied into the repo root temporarily to resolve the `playwright` package,
deleted immediately after — never committed):
- Screenshotted the category table region in both themes: `Uncategorized` and `Total`
  render as the 2nd/3rd columns, immediately after `month`; every exact-`0.00` cell (the
  visible majority) renders in muted grey against full-strength black/white for real
  numbers, in both themes.
- **Sort still works after the reorder**: clicked the `Uncategorized` column header,
  confirmed via `textContent` (not just a screenshot) that `2025-01` — the largest-magnitude
  Uncategorized month — sorted to the top in ascending order, i.e. `categorySort`/
  `sortComparator` are still resolving `col` by name correctly against the reordered header.
- **Drill-down still works after the reorder**: clicked the `2025-01` Uncategorized cell,
  confirmed a `.drilldown-row` appeared (`document.querySelectorAll(".drilldown-row").length
  === 1`) and screenshotted it showing 15 real transactions (Zelle payments, a WM Supercenter
  charge, etc.) — `toggleDrilldown` still resolves `category`/`month` correctly by name.
  Closed the panel afterward via its own Close button; no data was mutated (this is a
  read-only `GET /api/transactions?category=...&month=...` call, not a write).

### What was NOT verified

- Cross-browser: only Chromium via Playwright, consistent with `ui-check.mjs`'s existing
  scope and 016's precedent.
- Keyboard-only focus-ring appearance on the new headline panel wasn't screenshotted
  (there's nothing focusable in it — it's a static stat display, not a control) — the
  `.cell-zero` buttons' `:focus-visible` state was reviewed by eye in the stylesheet but not
  separately screenshotted mid-focus.
- No mutation of any kind was performed against `data/finance.db` — the one interactive
  check (drill-down click) is a read-only endpoint per the runbook's own guidance.
