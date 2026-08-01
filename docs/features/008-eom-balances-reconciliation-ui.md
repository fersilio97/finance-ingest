# 008 — Balance-entry UI (datetime, dropdown, delete) and per-entry reconciliation panel
Status: Shipped
Iteration: 2, Session 6

## Problem

Feature 005 (backend, Session 2) replaced `manual_balances` (one balance per account per
calendar month) with `balance_entries` (one balance per account at an exact ISO-8601
datetime, no uniqueness constraint — the user can record BoA Checking twice in the same
week if he wants to), and replaced `GET /api/insights/calculator` with
`GET /api/insights/reconciliation`, which now returns exactly one row per real
`balance_entries` row instead of a synthetic account×month grid. 005 explicitly deferred
the frontend to this session and left three open questions in its handoff: whether the
entry form should be a dropdown or free text, what the cross-page "record it" deep-link
should carry now that there's no single "the month" to prefill, and whether a per-entry
`not_checked` state is even reachable.

Two files were live-broken against this backend before this session:

- `frontend/insights.js` still called the removed `/api/insights/calculator` — a 404 on
  every load of the Reconciliation panel, confirmed live before touching anything.
- `frontend/index.html`'s Balances panel had a **minimal, disclosed patch** from feature
  007 (Session 5): 007 found the panel throwing on `/api/manual-balances` (also removed by
  005) while working on an unrelated part of the same file, and made the smallest possible
  fix to stop the bleeding — pointed `loadBalances()`/the form's `POST` at
  `/api/balance-entries`, converting the still-month-only form's value to
  `${month}-01T00:00:00`. 007's own doc is explicit that it deliberately did *not* build a
  `datetime-local` input, an account dropdown, or per-entry delete — all called out as this
  session's job. This session replaces that patch, not the panel's original pre-007 code.

## Spec / behavior built

**Balance-entry form (`index.html`'s `#balances-section`, renamed "Balance Entries"):**
account `<select>`, `<input type="datetime-local">`, balance number input, Save button.
Submits `POST /api/balance-entries`. List below it: one row per entry (account, recorded
timestamp, balance, a per-row Delete button), sorted most-recent-first. Loading (skeleton),
empty (real copy + points at the form below it), and error (visible, `field-error`, not a
silent no-op) states, per the runbook.

**Reconciliation panel (`insights.html`, "Reconciliation" — renamed from "Calculator — EOM
reconciliation"):** one card per row from `GET /api/insights/reconciliation`, sorted
worst-first (`off` → `not_checked` → `balanced`, spec 003's convention preserved), each
showing account, full recorded date+time, recorded balance, derived balance, and status.
`off` cards show the signed `Off by ±X.XX`. Colors reuse spec 003's tri-state language
exactly: `not_checked` = `--text-muted` (never red — it means "unverified," not "wrong"),
`balanced` = `--positive`, `off` = `--negative` (the only state permitted to use red in this
panel). A summary line above the cards states the verdict in one sentence before the user
has to read any card.

**Empty state (0 live `balance_entries` today — this is the primary state most users will
see):** *"No balances recorded yet — record one to start reconciling."* with a real link to
`index.html#balances-section`, not just muted text — the panel's entire job depends on the
user recording at least one balance, so the empty state has to be a call to action, not a
dead end.

## Implementation notes

**Files changed:**

- `frontend/index.html` — `#balances-section` renamed "Balance Entries" with new copy;
  `#balances-table` gained a 4th (actions/Delete) column; `#balance-form` replaced the
  `type="month"` input with `type="datetime-local"` (`#balance-recorded-at`) and made the
  account `<select>` `required`; added `#balances-error` (separate from the existing
  `#balance-error`, which is the *form-submit* error — `#balances-error` is the *list-load*
  error, following the same split `#review-error`/`#review-status` already uses elsewhere).
- `frontend/app.js`:
  - `renderAccountSelect()` (line 1167) — dropdown populated from `SOURCES` (see judgment
    call below), with a disabled placeholder option.
  - `formatRecordedAt()` (line 1395) — `"...T12:00:00"` → `"... 12:00"` for display; the
    raw ISO string always stays in the cell's `title`.
  - `loadBalances()` (line 1401) rewritten: proper loading/empty/error states (previously
    the error state repurposed the empty-state div with no distinct styling); entries
    sorted newest-first before rendering (see judgment call below).
  - `renderBalanceRow()` (line 1440) — new; builds each row including the Delete button,
    which calls `DELETE /api/balance-entries/{id}` and reloads the list on success, or shows
    a per-row error and re-enables the button on failure. There was never a delete control
    for balances in this app before this session.
  - The `#balance-form` submit handler (line 1474) — validates account/datetime presence
    client-side (the server only validates `account` as "not blank" and `recorded_at` as
    ISO-parseable, per 005's handoff), and normalizes a no-seconds `datetime-local` value
    (`"YYYY-MM-DDTHH:MM"`) to include `:00` before POSTing, since the server stores
    `recorded_at` verbatim without normalizing it (005's handoff note, confirmed live in
    Verification below) — otherwise entries created via this form vs. any future path that
    already includes seconds would display inconsistently.
  - `prefillBalanceFormFromQuery()` (line 1524) — rewritten for the new deep-link contract
    (see judgment call below): reads only `?account=`, no `?month=`.
- `frontend/insights.html` — "Calculator — EOM reconciliation" section renamed
  "Reconciliation" with new copy; element ids renamed `calculator-*` → `reconciliation-*`
  to match the backend's own `/calculator` → `/reconciliation` rename (005); the underlying
  `.calc-*` CSS classes were deliberately **not** renamed (see judgment call below).
- `frontend/insights.js`:
  - `STATE_LABEL`/`STATE_ORDER` (line 65) unchanged in shape, carried over from spec 003.
  - `formatRecordedAt()` (line 74) — same helper as `app.js`'s (duplicated, not shared —
    `insights.js` is loaded as a classic script, not a module, and `app.js` is a module; the
    function is 4 lines, not worth a new shared module for).
  - `reconciliationSummary()` (line 80, was `calculatorSummary`) — reworked for the 4
    possible states the per-entry model can produce (see "not_checked reachability" below);
    copy changed from "N of M account-months" to "N of M recorded balances."
  - `buildReconciliationCard()` (line 105, was `buildCalculatorCard`) — identity is now
    `account · recorded_at` (was `month · account`); `recorded_balance` is rendered
    unconditionally non-muted (it's never `null` in the new model — every row is a real
    entry, never a synthetic placeholder, per 005's contract); the `not_checked` remedy link
    text/href changed (see judgment call below).
  - `renderReconciliationList()` (line 159, was `renderCalculatorList`) — now fetches
    `/reconciliation` instead of `/calculator`; builds the empty state as a real DOM link
    instead of plain `setEmpty()` text.
  - `init()` — calls `renderReconciliationList()` instead of `renderCalculatorList()`.
- `frontend/styles.css` — extended the existing `#rules-table button.ghost` /
  `#rules-table .field-error` selectors to also cover `#balances-table` (2 small selector
  additions, no new rules needed — the balances table's new Delete button and per-row error
  reuse the exact same visual treatment rules already use). No new custom properties, no
  hardcoded colors; `.calc-*` rules from spec 003 untouched and reused as-is.

**Judgment call: dropdown, not free text, for the account field.** 005's handoff left this
open — the API only rejects blank/whitespace `account` values, nothing checks it against
known accounts. Built a `<select>` populated from `GET /api/sources`' `account` field
(`renderAccountSelect()`) rather than a text input. Reasoning: a typo'd free-text account
name would silently create an orphan value that no transaction's `account` column will ever
match — its reconciliation row would sit at `not_checked` forever, and there would be no way
to distinguish "genuinely no transaction data yet" from "the user fat-fingered the account
name" from the UI alone. A dropdown constrained to the 6 real accounts closes that gap
entirely at zero API cost (no backend change needed — `GET /api/sources` already existed and
is already fetched by this page for other selects).

**Judgment call: deep-link redesign, `?account=...` only, no month/date.** Spec 003's
version passed `?account=...&month=...` because the old model was month-keyed — there was
one canonical "the month" to prefill. The new model has no such thing: a `balance_entries`
row is timestamped, not month-scoped, so there's nothing correct to put in a `?date=`
param — prefilling a specific date the user didn't choose would look like a suggestion it
isn't. The link now only carries `?account=`; landing on the form pre-selects that account
in the dropdown and focuses the datetime field, leaving the actual date/time as the one
thing only the user can supply correctly.

**Judgment call / finding: `not_checked` reachability under the new model, and what its
remedy should say.** Tested directly (see Verification): unlike spec 003's version — where
`not_checked` meant "no balance was ever entered for this account/month" — every row in the
new model already corresponds to a real, existing `balance_entries` row, so `not_checked`
can only mean "this entry exists, but there's no transaction on or before its date for this
account to derive a comparison balance from" (005's own Architecture section calls this out
as a real, if previously unexercised, combination). That makes spec 003's "Record it →"
copy actively wrong here — there's nothing left to record, it's already recorded. Changed
the remedy link's text to *"Review in Balances →"* and its target to
`index.html?account=<account>#balances-section` (no request to create anything new): the
useful next step for a genuinely `not_checked` entry is either deleting a typo'd one
(delete-then-recreate is the only edit path — 005 built no `PUT`) or simply waiting for
transaction data to catch up. Added a `title` on the status label explaining why, since the
card itself has no room for a second line of prose at spec 003's one-line desktop layout
without reintroducing the exact wrapping defect 003 fixed.

**Judgment call: reconciliation summary copy for the "all not_checked" case.**
`reconciliationSummary()` (insights.js:80) now distinguishes 4 outcomes instead of 003's 3,
because the per-entry model can produce a state 003 never had to handle: entries exist, none
are `off`, but also none are checkable (`checkedCount === 0` while `rows.length > 0`) — e.g.
every recorded entry predates all transaction data for its account. Old copy
("No end-of-month balances recorded yet — nothing to check against") would be false in that
case (balances *were* recorded); new copy for it reads *"N recorded balances can't be
checked yet — no transaction data covers them."* Not reachable in live data today (0 entries
exist at all), flagging as a real branch that exists for correctness, not one currently
exercised — the mutating test below only exercises `balanced`/`off`, matching 005's own test
pattern exactly.

**Judgment call: `.calc-*` CSS class names kept, only the API-facing element ids renamed.**
Renaming `#calculator-*` → `#reconciliation-*` in the two files this session owns is free
and mirrors the backend's own rename. Renaming every `.calc-*` CSS selector as well would
touch ~25 rules across `styles.css` (spec 003's "Calculator" section) for a purely cosmetic
gain — the class names are internal implementation detail, not user-facing, and the task
brief itself frames this work as *"reusing spec 003's tri-state visual language,"* which a
class rename would not change the meaning of. Left as-is to minimize the diff against a
system that already works and is already legible.

**Judgment call: balance-entries list sorted newest-first.** The raw
`GET /api/balance-entries` order is `ORDER BY account, recorded_at` (routes.py:345) —
alphabetical-by-account, then chronological within it. With multiple entries per account now
legitimate (the entire point of 005), that ordering buries whatever the user just added at
the bottom of its account's block. Sorted client-side by `recorded_at` descending instead so
the most recent entry — the one most likely to be reviewed or corrected — is always at the
top.

## Verification evidence

All against the live server at `http://127.0.0.1:8000`, `data/finance.db` (the real
database), following the runbook throughout.

**Server health check before touching anything** (this iteration's sessions have hit the
stale-`--reload`-listener bug three times before):

```
$ curl -s http://127.0.0.1:8000/openapi.json | ... sorted paths
/api/balance-entries, /api/balance-entries/{entry_id}, /api/insights/reconciliation, ...
(exactly the routes 005/006 document — no stale /calculator or /manual-balances survivors)
```

**Baseline, before any change:**

```
rules: 108
needs_review: 315
transactions: 1020
balance-entries: []
reconciliation: []
```

Matches feature 007's own final recorded baseline exactly — nothing drifted between
sessions.

**Static checks:**

```
$ node --input-type=module --check < frontend/app.js   # exit 0
$ node --check frontend/insights.js                     # exit 0
```

**`node scripts/ui-check.mjs` (both pages, light+dark, desktop+narrow), run twice:**

First run showed a one-off, non-reproducible timing artifact (`index · desktop · light`
rendered at 1364px/321 DOM nodes instead of the expected ~6900px/4767 — the review table's
skeleton never resolved to real content in that single capture). Re-ran immediately: second
and all subsequent runs showed `index` at the expected 6900px/4767 DOM nodes across all 4
viewport/theme combinations, with **0 problems on `index`** every time — confirmed this was
a harness/browser-context race on that one run, not a stale-server issue (the `/openapi.json`
check above, done first, already confirmed no duplicate/stale listener; a repeat run
resolving cleanly with identical page-height/DOM-count numbers is the standard signature of
a one-off timing race, not a persistent server problem).

**Remaining, pre-existing, out-of-scope failure on `insights` (all 4 viewport/theme
combinations):** `console error — uncaught: points is not iterable`, inside
`renderBalanceChart()`. Confirmed by reading the diff that this session's changes never
touch `renderBalanceChart()` or the `#balance-chart` canvas — the function is byte-for-byte
unchanged except for one unrelated line in `init()` (renaming the reconciliation-list call).
Root cause, confirmed by reading (not guessed): feature 006 (backend, Session 3, already
shipped ahead of its own frontend session) reshaped `GET /api/insights/balance-trend`'s
response from a flat array to `{"series": [...]}`, and `renderBalanceChart()` — explicitly
Session 7's territory per this session's task boundary — still expects the old flat-array
shape. Confirmed live: `curl .../api/insights/balance-trend` returns `{"series": [...]}`
today. Not fixed here, per the explicit instruction to leave the balance-trend chart
untouched; flagging clearly so Session 7 doesn't have to rediscover it. Confirmed this
failure does **not** prevent the Category totals table or the Reconciliation panel (both in
scope this session) from rendering correctly — `Promise.all([renderCategoryTable(),
renderReconciliationList(), renderBalanceChart()])` starts all three independently; the two
in-scope panels' DOM updates complete before `renderBalanceChart()`'s later, unrelated
`TypeError` surfaces.

**Screenshots opened and inspected** (`.artifacts/{index,insights}-{desktop,narrow}-{light,dark}.png`,
plus throwaway scrolled captures of `#balances-section` and the Reconciliation panel — both
sections sit below the harness's viewport-only screenshot on `index`, and the Reconciliation
panel needed scrolling to reach at the narrow 480px viewport):

- **Empty state (0 live entries — today's actual state, the primary one real users see):**
  both themes, both widths. Reconciliation panel: *"No balances recorded yet — record one to
  start reconciling."* renders as one line with a live accent-colored link, centered, legible
  in both themes, no console error from this panel. Balances panel (index.html): matching
  copy pointing at the form directly below it, form itself renders cleanly (account
  dropdown with placeholder, native datetime-local picker, balance input, Save) at both
  1440px and 480px with no horizontal overflow.
- **Synthetic tri-state test** (mirroring 005's own already-proven pattern exactly — reused
  the *same* account/date/balance values 005 itself verified, so the expected derived
  balances were already known-correct rather than freshly guessed):

  ```
  POST BoA Checking    2025-01-21T12:00:00  16315.24   (matches derived exactly)
  POST Fidelity Savings 2025-12-31T23:00:00 99999.99   (deliberately far off)
  GET /api/insights/reconciliation ->
    [{"account":"BoA Checking",... "status":"balanced"},
     {"account":"Fidelity Savings",... "diff":-72401.55,"status":"off"}]
  ```

  Exactly one `balanced`, exactly one `off` — matches 005's own verified numbers exactly.
  Re-screenshotted both pages: Reconciliation panel showed summary *"1 of 2 recorded
  balances are off."* in `--negative`, the `off` card sorted first with **"Off by
  -72401.55"** in red, the `balanced` card sorted second in green "Balanced", both in
  `tabular-nums`; identity truncated correctly at narrow width with full text still in
  `title`. Balances panel (index.html) listed both entries, newest (`2025-12-31`) above
  older (`2025-01-21`), each with a working Delete button. Confirmed in both light and dark.
  **Cleaned up immediately** (not batched — per the runbook and the project's own
  iteration-1 lesson):

  ```
  DELETE /api/balance-entries/6 -> {"ok":true}
  DELETE /api/balance-entries/7 -> {"ok":true}
  DELETE /api/balance-entries/999 -> 404   (sanity check, nonexistent id)
  GET /api/balance-entries -> []
  GET /api/insights/reconciliation -> []
  ```

- **UI-interaction test, through the real browser (not curl)** — the Delete button and the
  full form-submit path are new controls this session added and had no prior coverage:
  filled the form (account `HSA`, `recorded_at` `2030-01-01T09:30` — an obviously-placeholder
  future date, easy to spot/clean), clicked Save, confirmed the row appeared
  (`HSA | 2030-01-01 09:30 | 123.45 | Delete`), clicked that row's Delete button, confirmed
  it disappeared and the empty state returned with the exact expected copy. Zero console
  errors during the whole interaction. Cleanup was intrinsic to the test itself (the row no
  longer exists by the test's own last step); confirmed via a follow-up `GET
  /api/balance-entries -> []`.

**Final re-check — everything this session could have drifted, confirmed unchanged:**

```
rules: 108
needs_review: 315
transactions: 1020
balance-entries: []
reconciliation: []
```

Identical to the pre-session baseline. Final `node scripts/ui-check.mjs` run (after all
cleanup) reproduced the exact pre-test page heights/DOM counts (`index`: 6900px/4767 nodes
across all 4 combinations) with 0 problems on `index` and only the pre-existing,
out-of-scope `insights` balance-chart error.

**What was NOT verified:**
- The balance-trend chart itself (`renderBalanceChart()`, `#balance-chart`) — explicitly
  Session 7's territory per this session's task boundary; its pre-existing break is
  documented above but not fixed.
- The Category totals table logic — untouched, also Session 7's territory; confirmed by
  screenshot that it still renders (unaffected by this session's changes).
- Cross-browser behavior beyond the harness's Chromium (Playwright's default).
- Color-blind-safe legibility via simulated color-vision testing — every state carries a
  text label alongside its color (inherited unchanged from spec 003's own verified
  approach), not independently re-tested here.
- Server-side behavior of `POST /api/balance-entries`'s validation (422 on malformed
  `recorded_at`, blank-account rejection) — already verified live by feature 005's own
  Verification section; not re-run here since this session made no backend changes.
- What happens if `GET /api/sources` itself fails (the account dropdown would render with
  only its placeholder option) — pre-existing behavior shared with the Rules panel's own
  source select, not something this session introduced or was asked to fix.

Status: **Shipped.**

## Handoff to whoever builds Session 7 (balance-trend chart, category table)

- `GET /api/insights/balance-trend` now returns `{"series": [{"account", "kind",
  "points": [{"date", "balance"}]}]}` (feature 006, already shipped backend-side) instead of
  the flat `[{"account","date","balance_after"}]` shape `renderBalanceChart()` in
  `insights.js` still assumes. That mismatch is the one console error this session's
  screenshots show and did not fix (out of this session's scope) — `renderBalanceChart()`
  needs a rewrite against the new shape, not a patch.
- `formatRecordedAt()` exists independently in both `app.js` and `insights.js` (small,
  intentionally duplicated rather than shared across a module/non-module boundary — see
  Implementation notes). Reuse it rather than re-deriving the same display format a third
  time if the balance-trend chart also needs to render entry timestamps as markers.
