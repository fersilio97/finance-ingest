# 013 — Move Balance Entries into the Reconciliation tab
Status: Shipped
Iteration: 6

## Problem

Balance Entries is the input mechanism for reconciliation — you record what you actually
saw at the bank, and the Reconciliation panel checks it against the balance derived from
transactions. Since feature 012 shipped, that check lives on its own `reconciliation.html`
tab, but the thing that feeds it is still stranded on `index.html`, half-width, next to a
panel about a completely different job (transaction classification rules).

Confirmed live against `http://127.0.0.1:8000` (`node scripts/ui-check.mjs --page index`
and `--page reconciliation`, screenshots read; a throwaway Playwright probe scrolled to
and screenshotted the split section directly, since `ui-check.mjs` only captures the first
viewport and this section sits ~5800px down a 6828px-tall page; deleted after use, per the
same one-off-probe convention feature 012's implementation notes used):

- **012 is live and confirmed working**, not just shipped-on-paper: `reconciliation.html`
  returns `200`, its `<nav>` shows all three links with `aria-current="page"` correctly on
  "Reconciliation," and the page renders today's real empty state ("No balances recorded
  yet — record one to start reconciling.") as a single full-width `<section class="panel">`
  with no `.split` sibling — exactly per 012's spec, and exactly the shape 012's own
  "Forward-looking note" said to leave room for a second section.
- `frontend/index.html:65-110` is a `<div class="split">` (`styles.css:157-161`,
  `grid-template-columns: 1.4fr 1fr`) with two `.panel` children: **Rules**
  (`#rules-table` + `#rule-form`, the 1.4fr / left column) and **Balance Entries**
  (`id="balances-section"`, `#balances-table` + `#balance-form`, the 1fr / right column).
  Measured directly in the live DOM: the Rules panel renders at **731px** wide, Balance
  Entries at **522px** — versus the ~1360px a single unsplit panel gets (what "Needs
  Review," the section directly above this one, already uses). Screenshot confirms both
  panels render correctly at their current widths — this is a width/consistency complaint,
  not a breakage — but it's a meaningfully smaller working area for Rules (23 rules today,
  each row showing Source/Match/Category/Priority/Edit/Delete) than the full-width table
  right above it gets.
- **Ambiguity resolved — Balance Entries moves, Rules stays and goes full width.** The
  raw capture note's title ("Balances Entries") and literal instruction ("move *this*
  section to the reconciliation tab") both name Balance Entries, not Rules. It also holds
  up on its own terms: Balance Entries is a reconciliation *input* — every field on
  `#balance-form` (account, recorded-at, balance) exists to feed the check that now lives
  on `reconciliation.html`, and `reconciliation.js`'s `not_checked` remedy link already
  points at this exact form. Rules is a transaction-classification concern with nothing to
  do with reconciliation. Moving Rules instead would sever the panel from the queue and
  rule-conflict logic it's adjacent to on `index.html` for no gain. Going with the literal
  note: **Balance Entries relocates to `reconciliation.html`; Rules stays on `index.html`
  and gets the freed-up full width.**
- **A pre-existing stale-copy bug, found while reading the code this feature will touch**:
  the Balance Entries empty state (`frontend/app.js:1546`) reads *"No balance entries
  recorded yet — record one below to start reconciling **on the Insights page**."* — a
  leftover from before 012 moved Reconciliation off Insights. It's already wrong today
  (Reconciliation lives on its own tab, not Insights) and would become doubly wrong after
  this move: once Balance Entries sits directly below the Reconciliation panel on the same
  page, telling the user to go "start reconciling" elsewhere is actively misleading — the
  thing it's telling them to go find is right above it. Fixing this copy is in scope for
  this feature (see spec below), not a separate backlog item — it's the same string this
  feature is relocating.
- **Backend needs no change — confirmed, not assumed.** `backend/app/api/routes.py:410-438`
  implements `GET/POST /api/balance-entries` and `DELETE /api/balance-entries/{id}` as
  plain REST handlers against the `balance_entries` table — no reference to referer,
  origin, or which page called them. `curl -s http://127.0.0.1:8000/api/sources` (the
  account dropdown's data source, via `renderAccountSelect()` in `app.js:1287-1292`)
  likewise returns the same 6 accounts regardless of caller. Both are already
  page-agnostic; this is a frontend-only relocation, same as 012.

## User story & spec

**As the user closing the books for the month, I want to record a balance and check it
against reconciliation in the same place, so recording an entry and seeing whether it
matches are one visit instead of two pages.**

### What moves

Move, unchanged in behavior and copy except the one stale string above:

- The entire `#balances-section` panel from `index.html`: heading, eyebrow paragraph,
  `#balances-table` (Account / Recorded at / Balance / Delete columns, `.table-scroll
  table-scroll--capped`), `#balances-empty`, `#balances-error`, `#balance-form` (account
  dropdown, datetime-local input, balance input, Save button), and its own inline
  `#balance-error`.
- Its backing logic from `frontend/app.js`: `renderAccountSelect()`, `loadBalances()`,
  `renderBalanceRow()`, the `#balance-form` submit handler, and `prefillBalanceFormFromQuery()`
  — verified present at `app.js:1287-1654` today; confirm exact lines at build time, code
  moves between sessions.
- **Copy fix, in scope**: `#balances-empty`'s text changes from *"No balance entries
  recorded yet — record one below to start reconciling on the Insights page."* to *"No
  balance entries recorded yet — record one below."* The "start reconciling" clause is
  dropped rather than repointed at "the Reconciliation panel above" — once this panel sits
  directly under Reconciliation on the same page, spelling out where reconciling happens is
  redundant, the same call 012 made when it dropped the duplicate inner `<h2>Reconciliation</h2>`.

### `index.html` after the move

- `<div class="split">` (`index.html:65-110`) is unwrapped, same pattern 012 used on
  `insights.html`'s category-table panel: remove the wrapper div, leave the Rules
  `<section class="panel">` as a direct child of `.page`, full width — matching "Needs
  Review" directly above it. Do not leave a single-child `.split`; `1.4fr 1fr` grid
  auto-placement would strand Rules at its current 731px with dead empty space where
  Balance Entries used to be, the exact regression 012's own spec called out and avoided.
  `#rule-form`, `#rule-preview`, `#rule-warnings`, `#rule-error` all move up unchanged
  along with the panel — nothing inside Rules changes, only its width.
- Narrow viewport (`<860px`) is unaffected: `styles.css:163-167`'s media query already
  collapses `.split` to a single column, so Rules and Balance Entries already render
  stacked full-width there today — this change only affects the ≥860px layout.

### `reconciliation.html` after the move — two sections, Reconciliation first

- Body becomes two stacked `<section class="panel">` elements, per 012's own
  forward-looking note that this page should already be a plain vertical stack ready for
  a second section:
  1. **Reconciliation** (existing, unchanged) — eyebrow, summary, list, empty, error.
  2. **Balance Entries** (new) — heading, eyebrow, table, empty, error, form — same
     internal structure it has on `index.html` today, just relocated.
- **Order is Reconciliation first, Balance Entries second**, not the reverse. Reconciliation
  is why the user opens this tab — it's the check being run; Balance Entries is the tool
  used to fix a problem the check surfaces. Putting the check first means "did everything
  reconcile" is answered in the first screenful, and a `not_checked`/`off` row's remedy
  link scrolls *down* to the form, matching the reading direction of "here's a problem,
  here's how to fix it" rather than making the user scroll back up past a form to see the
  result.
- `<title>` and `<h1>` stay "Reconciliation" (unchanged from 012) — Balance Entries getting
  a second section on this page doesn't rename the page; the page's job is still "check
  whether the books reconcile," and recording a balance is now part of that job, not a
  separate one.

### Deep-link fix (both existing links must be repointed, not left dead)

`reconciliation.js` has two links into the old `index.html#balances-section` location —
both were correct as of 012 and go stale the moment this feature ships if left alone:

1. **`buildReconciliationCard()`'s `not_checked` remedy link** (`reconciliation.js:92`):
   `` `index.html?account=${encodeURIComponent(r.account)}#balances-section` `` →
   `` `reconciliation.html?account=${encodeURIComponent(r.account)}#balances-section` ``.
   Preserves the existing query-param contract exactly (`prefillBalanceFormFromQuery()`
   moves along with the rest of the Balance Entries logic and keeps reading
   `?account=` + focusing the datetime field on load) — same behavior, new host page.
2. **Empty-state link** (`reconciliation.js:129`, *"record one to start reconciling"*):
   `index.html#balances-section` → `#balances-section`. This one carries no account param,
   so once the target is on the same page there's no reason to keep it as a cross-page
   `reconciliation.html#balances-section` link — a same-page anchor is simpler and correct.
- **Nice-to-have, not required**: link 1 currently forces a full page reload even when the
  user is already on `reconciliation.html` (clicking a link to the page you're on).
  Intercepting the click to just scroll-and-prefill via JS instead of navigating would
  remove a visible reload for what is now an in-page jump — worth doing if cheap, but the
  reload-based version above is functionally correct and is what to ship if it isn't.

### States (carried over unchanged except the one copy fix above)

- **Balance Entries empty**: table hidden, `#balances-empty` shows the corrected copy above
  (real link to nothing further — you're already on the page that explains it).
- **Balance Entries loading**: unchanged — `skeletonRows(tbody, 4)` renders 4 skeleton rows
  while `GET /api/balance-entries` is in flight, same as today on `index.html`.
- **Balance Entries error**: unchanged — `#balances-error` shows *"Couldn't load balance
  entries — {message}."*.
- **Reconciliation panel's three states**: entirely untouched by this feature (empty/error/
  no-explicit-loading-skeleton, all as documented in 012) — this feature only adds a
  sibling section below it.
- **1000+ rows**: unchanged reasoning from 012 — Balance Entries is hand-entered one row at
  a time (0 rows exist in the live DB today), not a scale risk. `#balances-table` already
  uses `.table-scroll--capped` (a max-height scroll cap) independent of page width, so this
  move doesn't change how it behaves at volume.
- **Rules panel, going full width**: no new states introduced — same load/empty/error
  behavior as today, just wider. 23 live rules today; full width gives more visible rows
  before `.table-scroll--capped`'s cap kicks in, not fundamentally different behavior.

## Architecture

**No backend, data model, or migration change. Confirmed live, not taken on faith:**

- `curl -s http://127.0.0.1:8000/api/balance-entries` → `200`, body `[]` (today's real
  empty state, same DB the rest of this feature will be checked against).
- `curl -s -D - -o /dev/null http://127.0.0.1:8000/api/balance-entries` → response headers
  show no cookie/redirect/vary-on-referer behavior — plain `content-type: application/json`.
- `curl -s http://127.0.0.1:8000/api/sources` → `200`, the same 6 accounts
  `renderAccountSelect()` needs, regardless of caller.
- Read `backend/app/api/routes.py:410-439` in full: `GET/POST /api/balance-entries` and
  `DELETE /api/balance-entries/{entry_id}` are plain SQLite CRUD against the
  `balance_entries` table. Grepped the whole file for `referer`/`origin`/`index.html`/
  `redirect` — zero matches. Nothing in this handler, or anywhere else in `routes.py`,
  knows or cares which page called it. Page-agnostic, exactly as the UX lead said.
- One thing worth naming for `fintech-frontend`, not a backend change but a routing fact
  that affects the JS constants below: `routes.py`'s router is mounted at
  `APIRouter(prefix="/api")` (`routes.py:19`) — `/api/balance-entries` and `/api/sources`
  live there. `insights.py`'s router is mounted separately at `prefix="/api/insights"`
  (`insights.py:17`) — `GET /api/insights/reconciliation` lives there. These are two
  different base paths today and this feature doesn't change that; it just means
  `reconciliation.js`, once it owns both fetches, needs two API-base constants, not one
  (see below — this is the one place a naive line-for-line copy would silently break).

This is a pure frontend file-boundary move, same shape as 012. File-level plan for
`fintech-frontend`, derived from reading `frontend/app.js` and `frontend/reconciliation.js`
in full today (line numbers below are current, not the spec capture's, per the spec's own
"confirm exact lines at build time" note):

### New content in `frontend/reconciliation.js`

**Constant collision — resolve before pasting anything.** `reconciliation.js` today
declares `const API = "/api/insights";` (line 1), used only by
`renderReconciliationList()`'s `jsonFetch(\`${API}/reconciliation\`)` (line 110). The
balance-entries code being moved from `app.js` was written against `app.js`'s own
`const API = "/api";` (`app.js:4`) — its calls are literally `${API}/balance-entries` and
`${API}/sources`. The two `API`s point at different base paths; they cannot share the
name. Rename the existing one and add the new one:
- `const API = "/api/insights";` → `const INSIGHTS_API = "/api/insights";`
- Add `const API = "/api";` (new, matches `app.js:4` verbatim) so every moved line that
  reads `${API}/...` needs zero edits.
- Update the one existing call site: `renderReconciliationList()`'s
  `jsonFetch(\`${API}/reconciliation\`)` → `jsonFetch(\`${INSIGHTS_API}/reconciliation\`)`.
  This is the one line of pre-existing reconciliation.js code this feature has to touch;
  everything else in that function is untouched.

**`jsonFetch()` must be upgraded, not just kept.** `reconciliation.js`'s current
`jsonFetch()` (lines 3-7) is GET-only — `async function jsonFetch(url) { ... }`, no
`options` parameter, no JSON error-detail extraction. The moved balance-entries code calls
`jsonFetch(url, { method: "POST", headers: {...}, body: ... })` and
`jsonFetch(url, { method: "DELETE" })` — that signature doesn't exist here today. Replace
reconciliation.js's `jsonFetch()` with `app.js`'s version verbatim (`app.js:7-21` — takes
`(url, options)`, throws with the server's JSON `detail` when present, returns `null` for
non-JSON responses). This is backward-compatible with the one existing call
(`jsonFetch(\`${INSIGHTS_API}/reconciliation\`)`, no second argument — `options` is simply
`undefined`, same as today).

**Copy verbatim (new to this file, not currently present):**
- `skeletonRows()` — `app.js:23-27`. Needed by `loadBalances()`'s
  `skeletonRows(tbody, 4)` loading state.
- `setEmpty()` — `app.js:37-40`. Needed by `loadBalances()`'s empty-state call.

**Move verbatim from `app.js`:**
- `renderAccountSelect()` — `app.js:1287-1292`. Reads a module-level `SOURCES` array that
  doesn't exist in `reconciliation.js` today — add `let SOURCES = [];` alongside it. This
  is new, not a move: `app.js`'s `loadSources()` (below) populates `SOURCES` as a side
  effect of also rebuilding the upload drop-zones and the Rules source dropdown — none of
  which belong in `reconciliation.js`. Write a small local `loadSources()` scoped to only
  what this page needs:
  ```js
  async function loadSources() {
    SOURCES = await jsonFetch(`${API}/sources`);
    renderAccountSelect();
  }
  ```
  Same function name as `app.js`'s (fine — separate classic-script file, no collision),
  deliberately narrower body.
- `loadBalances()` — `app.js:1521-1558`.
- `renderBalanceRow()` — `app.js:1560-1592`.
- The `#balance-form` submit handler — `app.js:1594-1633`.
- `prefillBalanceFormFromQuery()` — `app.js:1644-1654`.
- **Do not move `formatRecordedAt()`** — `reconciliation.js` already has its own
  byte-identical copy (lines 13-17, copied from `insights.js` under feature 008's
  "duplicated on purpose" convention). `app.js`'s copy (`app.js:1515-1519`) is deleted
  outright when its block is deleted, not moved — no gap, the target already has one.

**Copy fix (`#balances-empty` text, moves with `loadBalances()`):** the string embedded
in `loadBalances()` at `app.js:1546` — *"No balance entries recorded yet — record one
below to start reconciling on the Insights page."* — becomes *"No balance entries
recorded yet — record one below."* in the moved copy of the function.

**Deep-link fixes, both in code that stays in `reconciliation.js` (not moved, edited in
place):**
1. `buildReconciliationCard()`'s `not_checked` remedy link (currently line 92):
   `` `index.html?account=${encodeURIComponent(r.account)}#balances-section` `` →
   `` `reconciliation.html?account=${encodeURIComponent(r.account)}#balances-section` ``.
2. The reconciliation-empty-state remedy link (currently line 129): href
   `"index.html#balances-section"` → `"#balances-section"`. Copy text ("record one to
   start reconciling.") is unchanged — this is link 2 from the spec's Deep-link section,
   distinct from the `#balances-empty` copy fix above; don't conflate the two "record
   one..." strings, they're different elements with different fixes.

**`init()` (currently lines 144-146):** change from
`await renderReconciliationList();` to:
```js
(async function init() {
  await Promise.all([renderReconciliationList(), loadSources(), loadBalances()]);
  prefillBalanceFormFromQuery();
})();
```
Mirrors `app.js`'s own ordering guarantee (`app.js:1656-1663`): `prefillBalanceFormFromQuery()`
reads the account `<select>`'s options and needs `loadSources()` to have resolved first,
same as it needed `loadSources()` before `loadBalances()`/it ran in the original file.

### Edited `frontend/app.js`

- **Line 69**: remove `renderAccountSelect();` from `loadSources()`. `SOURCES` itself
  stays populated by this function — `sourceOptionsHtml()` (Rules' source dropdown) and
  `renderDropZones()` still need it; only the balance-account render call leaves.
- **Line 464** (`trigger-btn` handler): `Promise.all([loadReview(), loadRules(),
  loadBalances(), loadUploads()])` → `Promise.all([loadReview(), loadRules(),
  loadUploads()])`.
- **Delete lines 1287-1292** (`renderAccountSelect()`).
- **Delete lines 1500-1654**: the entire `/* Balance Entries (spec 008) */` block — its
  doc comment, `formatRecordedAt()`, `loadBalances()`, `renderBalanceRow()`, the
  `#balance-form` submit handler, and `prefillBalanceFormFromQuery()`. Confirmed by
  grepping the full file: nothing outside this range calls any of these five names.
- **Line 1662** (`init()`): `Promise.all([loadReview(), loadRules(), loadBalances(),
  loadUploads()])` → `Promise.all([loadReview(), loadRules(), loadUploads()])`.
- **Line 1663**: delete `prefillBalanceFormFromQuery();`.
- Nothing balance-entries-related remains in `app.js` after these edits — matches the
  task's requirement exactly, no redirect/cleanup shim needed since there's no code path
  left that references the removed ids.

### Edited `frontend/index.html`

- Delete the Balance Entries `<section class="panel" id="balances-section">` (lines
  89-109) entirely.
- **Unwrap `.split`** (lines 65/110): remove the `<div class="split">`/`</div>` wrapper,
  same pattern 012 used on `insights.html`. Leave the Rules `<section class="panel">`
  (lines 66-87, unchanged internally — `#rule-form`, `#rule-preview`, `#rule-warnings`,
  `#rule-error` all move up with it) as a direct child of `.page`, full width — matching
  "Needs Review" directly above it. Confirmed via grep: `class="split"` occurs exactly
  once in the entire `frontend/` tree today (`index.html:65`) — after this edit it occurs
  zero times anywhere. `styles.css`'s `.split` rule (`styles.css:157-167`, including its
  `<860px` collapse-to-one-column media query) is left in place unedited, same as 012 left
  `.split` in `styles.css` after emptying it out of `insights.html` — it's dead CSS after
  this ships, but this repo's convention (per 012) is not to prune CSS a feature didn't
  need to touch. Worth a follow-up cleanup item, not required here.
- No other change to `index.html` — `<script type="module" src="app.js"></script>` stays
  as-is; `app.js` keeps its `type="module"` because Rules' preview logic still imports
  `merchant-key.js`/`rule-keyword.js`. Confirmed none of the moved balance-entries code
  ever referenced those imports, so nothing is lost by `reconciliation.js` staying a
  classic (non-module) script.

### Edited `frontend/reconciliation.html`

Two stacked `<section class="panel">` elements, Reconciliation first (existing, lines
20-26, untouched) then a new Balance Entries section appended before `</div>` closing
`.page`, copied verbatim from `index.html`'s current markup (today's lines 89-109) with
the one copy fix already listed above:

```html
<section class="panel" id="balances-section">
  <h2>Balance Entries</h2>
  <p class="eyebrow">Record an account balance at the exact moment you checked it — reconciled against the balance derived from your transactions as of that date on the Insights page.</p>
  <div class="table-scroll table-scroll--capped">
    <table id="balances-table">
      <thead>
        <tr><th>Account</th><th>Recorded at</th><th class="num">Balance</th><th></th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
  <div id="balances-empty" class="empty-state" hidden></div>
  <div id="balances-error" class="field-error" hidden></div>
  <form class="inline" id="balance-form">
    <select name="account" id="balance-account" required></select>
    <input name="recorded_at" id="balance-recorded-at" type="datetime-local" required title="Date and time you checked this balance" />
    <input name="balance" type="number" step="0.01" placeholder="Balance" required style="width:8em" />
    <button type="submit">Save</button>
  </form>
  <div id="balance-error" class="field-error"></div>
</section>
```

Same ids, same classes, same field order as today — this is the relocation target, not a
redesign. The eyebrow paragraph's own copy ("reconciled against the balance derived from
your transactions as of that date on the Insights page") is carried over unchanged per
the spec's "What moves" list — the spec's in-scope copy fix is only `#balances-empty`'s
text, not this eyebrow. `<script src="reconciliation.js"></script>` (already present,
unedited) picks up the new markup automatically once the JS above lands.

### Risks / trade-offs

- **The `API`/`INSIGHTS_API` rename is the one piece of "unchanged" code this feature
  can't avoid touching.** It's a one-line rename plus a one-line call-site update, forced
  by two routers living at different prefixes — not a style choice. Flagging it explicitly
  so it isn't missed as an unplanned diff during review.
- **`jsonFetch()` upgrade is a real behavior change to existing reconciliation.js code**,
  not just an addition: the old GET-only version silently couldn't have supported a
  mutating call. The replacement is strictly more capable and verified backward-compatible
  with the one pre-existing caller (verified by inspection: an `undefined` second arg
  behaves identically to omitting it, both in the new `jsonFetch` and in `fetch()` itself).
- **`skeletonRows()`/`setEmpty()` duplication** across `app.js` and `reconciliation.js`,
  same "duplicated on purpose" precedent 012 already established for `API`/`jsonFetch`/
  `formatRecordedAt` at small size — consistent with this codebase's no-shared-file stance
  on a no-build-step static site.
- **Not in scope, flagging for `fintech-frontend` to decide, not silently doing**: once
  Balance Entries and Reconciliation share a page, saving a new balance entry could also
  refresh `renderReconciliationList()` so the reconciliation check updates without a
  reload. The spec's "What moves" section says the submit handler moves "unchanged in
  behavior" and doesn't ask for this; the two panels were on separate pages when this
  logic was written and never needed to talk to each other. Treating this as a genuine
  nice-to-have outside this feature's scope — same restraint the spec itself used for the
  deep-link click-interception nice-to-have.
- **Deep-link nice-to-have from the spec** (intercept `not_checked`'s remedy link click to
  scroll-and-prefill via JS instead of a full navigation when already on
  `reconciliation.html`): worth doing if cheap, but the plain `href` rewrite above is what
  ships if it isn't — per the spec's own explicit fallback.

## Implementation notes

Built exactly to the architecture section, with two small judgment calls where a
line-for-line copy would have left dead residue:

- **`renderAccountSelect()`'s doc comment moved with the function.** The architecture
  section named `app.js:1287-1292` for deletion (the function body only); the seven-line
  comment immediately above it (`app.js:1280-1286`, explaining why the account field is a
  dropdown, not free text) is about that function specifically, and leaving it behind
  would orphan a comment above `renderCategorySelect()` that describes code no longer
  there. Deleted both from `app.js`, moved both to `reconciliation.js` — the concept the
  architect named ("move `renderAccountSelect()`") is preserved; only the exact line range
  grew by seven lines to keep the explanation attached to the code it explains.
- **Confirmed all five other moved-function line ranges matched the spec's capture
  exactly** (`app.js:1500-1654` for the whole Balance Entries block, `1287-1292` for
  `renderAccountSelect()`) — no other drift since the spec was written.
- Everything else — the `API`/`INSIGHTS_API` split, the `jsonFetch()` upgrade, the new
  `SOURCES`/`loadSources()` pair, the two deep-link fixes, the `#balances-empty` copy fix,
  the `.split` unwrap, `init()` ordering — implemented verbatim as specified.
- Did not implement the "nice-to-have" click-interception for the `not_checked` remedy
  link (scroll-and-prefill via JS instead of a full navigation when already on
  `reconciliation.html`) — shipping the plain `href` rewrite instead, exactly the fallback
  the spec named as correct to ship if the nicety isn't done.
- Did not implement the "not in scope" idea of refreshing `renderReconciliationList()`
  after a balance-entry save — the spec explicitly flagged this as a call for
  `fintech-frontend` to leave alone, and the "unchanged in behavior" instruction for the
  moved submit handler settles it.
- **Post-ship fix**: the spec's "What moves" section (and the Architecture section's
  reconciliation.html snippet) explicitly carried the Balance Entries panel's `<p
  class="eyebrow">` copy over unchanged — *"...reconciled against the balance derived
  from your transactions as of that date on the Insights page."* That instruction was
  itself stale: the "Insights page" reference was already wrong the moment 012 shipped
  (Reconciliation moved off Insights before this feature existed), and became actively
  misleading once this section landed directly below the real Reconciliation panel on the
  same page. Caught in post-implementation spot-check, not by either agent during the
  pipeline. Fixed to *"...reconciled against the balance derived from your transactions as
  of that date, in the panel above."* Re-ran `node scripts/ui-check.mjs --page
  reconciliation` after the fix — clean, no console errors/overflow, screenshot confirms
  the corrected copy renders in both themes.

## Verification evidence

Checked live against `http://127.0.0.1:8000` (server already running via the dev
runbook's uvicorn command; no restart needed since these are all static frontend files).

**Read the whole diff before testing**, confirming no dangling references: grepped
`app.js` after edits for `renderAccountSelect`, `loadBalances`, `renderBalanceRow`,
`balance-form`, `prefillBalanceFormFromQuery`, `formatRecordedAt`, and every
`balances-*` id — zero matches, confirming the task's "nothing balance-entries-related
remains in `app.js`" requirement. Confirmed `SOURCES` still has five other live
consumers in `app.js` (drop zones, source select, Rules source dropdown) so removing the
one `renderAccountSelect()` call site didn't strand it.

**`curl` against the live API**, matching the architecture section's own numbers:
- `GET /api/balance-entries` → `200`, `[]` (0 entries — matches the doc's "0 rows exist
  in the live DB today").
- `GET /api/sources` → `200`, the same 6 accounts (`BoA Checking`, `BoA Credit Card`,
  `Fidelity Credit Card`, `Fidelity Savings`, `HSA`, `401k`).
- `GET /api/insights/reconciliation` → `200`, `[]`.

**`node scripts/ui-check.mjs` (all pages, light+dark, desktop+narrow, 12 screenshots)**:
exit 0, "No console errors, failed requests, or horizontal overflow." **All 12
screenshots opened and read with the Read tool**, not just the pass/fail exit code:
- `reconciliation-{desktop,narrow}-{light,dark}.png`: two stacked full-width panels,
  Reconciliation first (empty state, "record one to start reconciling." link visible)
  then Balance Entries second (heading, eyebrow, empty state, form with account
  dropdown/datetime/balance/Save) — exactly the shape specified. Both themes correct
  (light: warm-neutral surface/amber accent; dark: proper dark surface, no unstyled
  white flashes). Narrow (480px) stacks correctly with no overflow.
- `index-{desktop,narrow}-{light,dark}.png`: top-of-page (Upload/Pipeline/Needs Review)
  renders correctly in both themes; this viewport doesn't reach the Rules panel
  (~6200px down a ~6800px page), so a separate probe was used for that (below).
- `insights-{desktop,narrow}-{light,dark}.png`: unaffected by this feature, confirmed
  still rendering correctly (balance trend chart, category table) in both themes — sanity
  check that nothing here regressed.

**Rules-panel full-width check** (`ui-check.mjs` only captures the first viewport, and
the Rules panel now sits ~6200px down `index.html`): wrote a throwaway Playwright probe
that navigated to `index.html`, scrolled `#rules-table` into view, and read its
`.panel` ancestor's bounding box directly from the live DOM — **1276.8px wide**, no
sibling panel, no `.split` ancestor. Screenshot confirmed visually: Rules table and form
span the same width as "Needs Review" above it, no dead space where Balance Entries used
to sit. `grep -r 'class="split"' frontend/` returns zero matches post-edit, confirming
the wrapper is fully gone, not just visually absent. Probe script and its screenshot
deleted after use, per this repo's one-off-probe convention (see feature 012's own
implementation notes for precedent).

**Deep-link fix, verified by navigation, not just reading the code**: a second throwaway
probe navigated directly to
`reconciliation.html?account=BoA%20Checking#balances-section` (the exact URL shape
`buildReconciliationCard()`'s `not_checked` remedy link now produces) and read the live
DOM: `#balance-account`'s value was `"BoA Checking"` and `document.activeElement.id` was
`"balance-recorded-at"` — confirming `prefillBalanceFormFromQuery()` correctly selects
the account and focuses the datetime field at the new same-page location. Screenshot
confirms the page loaded scrolled to the Balance Entries section with the account
pre-selected. The second deep-link (empty-state "record one to start reconciling." link)
was visually confirmed in the `reconciliation-*` screenshots above and its `href`
inspected directly in `reconciliation.js` (`"#balances-section"`, same-page anchor).

**Mutating interaction test — add then delete a throwaway balance entry, on the new
`reconciliation.html` location** (per the task instructions, since this wiring had no
prior coverage here): using the same probe, selected "BoA Checking", set
recorded-at to `2030-01-01T09:30` (an obviously-future, obviously-fake timestamp) and
balance to `123456.78`, clicked Save, and waited for the real `POST /api/balance-entries`
response. Confirmed via the live DOM that the table then contained `123456.78`.
Screenshot confirms the row rendered correctly (account, formatted timestamp
`2030-01-01 09:30`, right-aligned tabular-nums balance, Delete button). Clicked that
row's Delete button, waited for the real `DELETE /api/balance-entries/{id}` response,
and confirmed via the live DOM the row was gone and the empty state
("No balance entries recorded yet — record one below.") reappeared — this is also the
first live confirmation of the `#balances-empty` copy fix rendering correctly, not just
existing in source. **Cleaned up immediately**: `curl -s
http://127.0.0.1:8000/api/balance-entries` after the test returned `[]`, confirming no
throwaway data was left in `data/finance.db`. Both probe scripts and their screenshots
deleted after use.

**What was not verified**: cross-browser rendering (Chromium only, via Playwright, per
this repo's existing `ui-check.mjs` convention); no automated regression test exists for
either page (none existed before this feature either — consistent with the rest of this
codebase's manual-verification-only convention); did not test concurrent edits (two tabs
open, one deleting a balance entry the other just saved) — not a scenario this feature's
spec asked for and not a regression risk since the moved code is unchanged in behavior.
