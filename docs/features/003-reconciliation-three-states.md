# 003 — Reconciliation: stop shouting MISMATCH when nothing was recorded
Status: Approved
Iteration: 1

## Problem

The "Calculator — EOM reconciliation" panel on Insights currently renders **22 cards and
22 red MISMATCH pills. Zero say OK.** Every one of them is false.

Observed on 2026-07-31 against the live database:

- `GET /api/insights/calculator` returns 22 rows (12 × BoA Checking, 10 × Fidelity
  Savings). **All 22** have `recorded_balance: null` and `match: false`.
- `GET /api/manual-balances` returns `[]` — the user has never entered a single
  end-of-month balance.
- Browser probe: `calcRows: 22, mismatchPills: 22, okPills: 0`.

So the panel is reporting *"your derived balance disagrees with your recorded balance"*
when the truth is *"you never recorded a balance to compare against."* `insights.js:85`
branches on `r.match === true` / `=== false` and never checks whether `recorded_balance`
is null, so "unknown" is rendered as "wrong".

This is the single worst doubt item in the app. The one panel whose entire job is to
answer **"is this number right?"** currently answers **"no"** twenty-two times in a row,
and it is wrong every time. A user who trusts it panics; a user who learns to ignore it
has lost the only reconciliation signal the app has — and that second outcome is the
likely one, which means the feature is already effectively dead.

There is a layout defect on top of it. The panel sits in a narrow grid column measured at
roughly **180px wide**, so every card wraps across five lines — account, month, `derived`,
value, `recorded`, `—` — turning 22 rows into a tall ribbon of fragments. Confirmed by
section screenshot at the 1440px desktop viewport, so this is not a narrow-viewport-only
problem.

## User story & spec

> As the person closing the month, I want the reconciliation panel to tell me exactly one
> of three things per account-month — I haven't checked this, this agrees, or this is off
> by 412.68 — so that a red flag means something and I act on it.

### A. The three states

Every account-month card resolves to **exactly one** of these. There is no fourth state.

**1. Not recorded** — a derived balance exists; no end-of-month balance has been entered.
*This is all 22 live rows today.*

- Neutral, muted treatment. **Not red, not a warning colour.** Uses `--text-muted` /
  `--border`; must read as "unknown", never as "problem", in both light and dark.
- Label: **`Not checked`**.
- Shows the derived balance. The recorded side reads `—`.
- Carries the remedy: a control that jumps to / pre-fills the existing *Manual EOM
  Balances* form on the index page with this account and month already selected. Telling
  someone a thing is unverified without giving them the way to verify it is half a feature.

**2. Balanced** — both balances present and equal within tolerance.

- Positive treatment (`--positive`).
- Label: **`Balanced`**.
- Tolerance is **`|derived − recorded| < 0.01`**, i.e. sub-cent. These are float sums over
  hundreds of rows; an exact `==` will produce phantom mismatches of 0.000000001 and
  reintroduce the exact problem this feature exists to remove.
- Shows both values. This is the state the user is working toward, so it should be
  visually quiet and scannable — a column of green in the periphery is the "month closed"
  signal.

**3. Off by X** — both balances present and differing by ≥ 0.01.

- Negative treatment (`--negative`).
- Label states the **signed difference**, not a bare verdict: **`Off by −412.68`**. A
  difference the user can see is a difference he can chase; the word "MISMATCH" alone
  tells him nothing about whether it's a rounding artefact or a missing paycheque.
- Shows derived, recorded, and the difference. Money is `tabular-nums`, right-aligned,
  2 decimals, per the runbook.
- This is the **only** state permitted to use a red/negative colour anywhere in this panel.

Acceptance criterion, stated against live data: **on the current database the panel shows
22 `Not checked` cards and zero red pills.** If any red survives against a database with
no manual balances, the feature has not shipped.

A second criterion, because state 3 currently has no live coverage: entering one manual
balance that matches and one that doesn't must produce exactly one `Balanced` and one
`Off by X`. That path needs deliberate verification — no row in the live data exercises it.

### B. Panel summary

Because the panel's job is a yes/no answer, it leads with one:

- All account-months balanced → **`All 22 account-months reconcile.`** (positive)
- Any differ → **`2 of 22 account-months are off.`** (negative) — differences first in the
  list, then not-checked, then balanced.
- None recorded (today) → **`No end-of-month balances recorded yet — nothing to check
  against.`** (muted), with the link to the balances form.

The summary is what he reads; the cards are what he reads when the summary is bad.

### C. Layout

- At desktop widths each card is **one line**: `Account · Month` on the left, derived and
  recorded values in aligned money columns, status on the right. No five-line wraps. The
  fix is the panel's column width, not the card's internals — a 180px column cannot host
  this content at any font size.
- At the harness's 480px narrow viewport, two lines are acceptable: identity above,
  values + status below. Values stay aligned and right-justified.
- Colour comes only from the CSS custom properties in `styles.css`
  (`--positive`, `--negative`, `--text-muted`, `--border`); nothing hardcoded, and every
  state must be legible in **both** light and dark.
- Status must not be conveyed by colour alone — each state carries its text label, so the
  panel is readable without colour perception.

### D. States and volume

- **Loading:** `.skeleton` cards in the final one-line shape, so nothing reflows when data
  lands.
- **Empty** (no account-month data at all — no accounts carry a running balance): keep the
  existing copy, *"No account/month data to reconcile yet."*
- **Error:** *"Couldn't load reconciliation — <reason>."* The panel must fail visibly
  rather than render an empty list that reads as "everything is fine". A silent empty
  state on a reconciliation panel is a lie.
- **Volume:** 22 rows today, growing by ~2 per month (one per running-balance account:
  BoA Checking and Fidelity Savings). At ~50/year this stays a plain list — it needs no
  pagination and should not get any. If it ever exceeds ~60, collapse fully-balanced
  months by default and keep differences expanded.
- **Data contract note (behavioural, for the architect):** the UI cannot currently
  distinguish state 1 from state 3, because `/api/insights/calculator` returns
  `match: false` for both. The distinction must exist by the time it reaches the renderer;
  whether that is fixed in the endpoint or derived from `recorded_balance == null` in the
  client is an architecture decision, not a UX one.

## Architecture

**Decision: fix the tri-state logic in the endpoint, not the client.** `build_calculator()`
in `pipeline/export.py` is the single builder shared by `GET /api/insights/calculator` and
the xlsx `Calculator` sheet (`insights.py:8`, `export.py:105-108`) — exactly the
"SQLite/backend owns business logic, one choke point per concern" pattern already
established for rule-keyword lowercasing (`rules/store.py:create_rule`). Deriving the
tri-state from `recorded_balance == null` in the client instead would mean the tolerance
logic (`< 0.01`) and the null-handling both get re-implemented in JS, and the xlsx export
would keep emitting the old NaN-unsafe boolean forever since nothing owns fixing it there.
Fixing it once, at the source, means both consumers agree by construction.

**Root cause confirmed by reading, not assumed:** the old code was
`calc["match"] = calc["diff"].abs() < 0.01` where `diff = derived_balance -
recorded_balance`. When `recorded_balance` is `NaN` (SQL `NULL`, i.e. never recorded),
`diff` is `NaN`, and `NaN.abs() < 0.01` is `False` in both pandas and numpy — never `True`,
never raises. So "never recorded" and "recorded but wrong" were computationally
indistinguishable: both produced `match: False`. Verified this was the live behavior before
my change (22/22 `match: false`, 0 `match: true`, matching the bug report exactly).

**What changed.** `build_calculator()` now computes an explicit `status` column instead of
the boolean `match`:

```python
both_present = calc["derived_balance"].notna() & calc["recorded_balance"].notna()
calc["status"] = "not_checked"
calc.loc[both_present & (calc["diff"].abs() < 0.01), "status"] = "balanced"
calc.loc[both_present & (calc["diff"].abs() >= 0.01), "status"] = "off"
```

`status` is one of exactly three values: `"not_checked"`, `"balanced"`, `"off"` — matching
spec section A's "no fourth state" requirement. `diff` is retained (still `null`/`NaN`
when either side is missing, `float` when both present) so the client can render the signed
`Off by −412.68` label without recomputing a subtraction. `match` (the boolean) is removed
entirely rather than kept alongside `status` — I checked for other consumers first
(`grep -rn "match"` across `backend/`, plus `frontend/insights.js`) and the only reader is
`insights.js:85`, which spec 003 requires rewriting anyway to consume the tri-state. Keeping
a parallel `match` boolean that's now *ill-defined* (true only for "balanced," false for
both "not_checked" and "off" — the exact bug this feature exists to remove) would be worse
than removing it: it invites a future caller to reach for the familiar-looking boolean and
reintroduce the same silent conflation.

**Edge case beyond what the spec states explicitly:** the spec's three states are framed as
"derived exists, recorded missing" (not_checked) vs. "both present" (balanced/off). I also
handled the reverse — a manual balance recorded for an account/month with no derived
balance at all (e.g. no transactions posted that month) — as `not_checked` rather than
leaving it to fall through to a NaN-diff `"off"`. Reasoning: if either side is missing,
there is nothing to *compare*, so "unknown" is the only honest state; asymmetric handling
(treating "derived-missing" differently from "recorded-missing") would reintroduce exactly
the kind of asymmetric, unstated behavior this feature is fixing elsewhere. Not currently
reachable in live data (all 22 rows have a derived balance) but is a real theoretical
combination since `recorded_balance` has no foreign-key constraint on `derived_balance`
existing.

**New endpoint: `DELETE /api/manual-balances/{balance_id}`.** There was no way to remove a
manual balance entry — needed for cleanup after the synthetic balanced/off verification
below, and a real gap for the frontend (the runbook's remedy control in state 1 implies a
user should also be able to *un-enter* a wrong balance, not just overwrite it). Matches the
existing `DELETE /api/rules/{id}` shape exactly: 404 if the id doesn't exist, hard delete
otherwise, no re-enrich side effect needed (manual balances don't drive classification).

```python
@router.delete("/manual-balances/{balance_id}")
def remove_manual_balance(balance_id: int):
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM manual_balances WHERE id = ?", (balance_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Manual balance not found")
        conn.execute("DELETE FROM manual_balances WHERE id = ?", (balance_id,))
    return {"ok": True}
```

No schema/migration change — `manual_balances` already has an `id INTEGER PRIMARY KEY`
(`db.py:42-48`), unused by any existing endpoint until now; `GET /api/manual-balances`
already returns it (`SELECT *`).

**API contract — `GET /api/insights/calculator` (changed response shape):**

```
GET /api/insights/calculator
-> [
     {
       "account": str,
       "month": str,            # "YYYY-MM"
       "derived_balance": float | null,
       "recorded_balance": float | null,
       "diff": float | null,    # null unless both sides present
       "status": "not_checked" | "balanced" | "off"
     },
     ...
   ]
```

Removed field: `match` (boolean). Added field: `status` (string enum, see above).
`account`, `month`, `derived_balance`, `recorded_balance`, `diff` are unchanged in name and
type from before.

**API contract — new endpoint:**

```
DELETE /api/manual-balances/{balance_id}
-> 200 {"ok": true}          if the row existed and was deleted
-> 404 {"detail": "..."}     if balance_id doesn't exist
```

**Risk/tradeoff:** this is a breaking change to the `/api/insights/calculator` response
shape (`match` removed) rather than an additive one. I chose not to keep `match` for
backward compatibility because it's the sole thing this feature exists to correct, and
`insights.js` is the only consumer, already scheduled to be rewritten by the frontend
engineer as part of this same feature — keeping a broken boolean around "for compatibility"
would compat with nothing real and would be an attractive nuisance later. Flagging the
shape change explicitly here so it's a stated decision, not a silent break.

## Implementation notes

**Files changed:**
- `backend/app/pipeline/export.py` — `build_calculator()`: replaced the `match` boolean
  with the `status` tri-state (see Architecture above for the exact diff). This function is
  shared by `/api/insights/calculator` and the xlsx `Calculator` sheet, so both pick up the
  fix from one change.
- `backend/app/api/routes.py` — added `DELETE /api/manual-balances/{balance_id}`.

**Verification against live data** (before touching anything, to establish the bug was
real):

```
$ curl -s http://127.0.0.1:8000/api/insights/calculator | python -c "..."
calculator rows: 22
Counter({False: 22})          # old shape: match=false for all 22, zero true
$ curl -s http://127.0.0.1:8000/api/manual-balances
[]
```

**After the fix, against the same live (untouched) data:**

```
$ curl -s http://127.0.0.1:8000/api/insights/calculator | python -c "..."
rows: 22
Counter({'not_checked': 22})   # zero 'balanced', zero 'off' — matches spec's acceptance criterion
```

Also verified directly against the DB layer (bypassing the HTTP layer, to isolate the
pandas logic from any server-process issue):

```
$ ./.venv/Scripts/python.exe -c "from app.pipeline.export import build_calculator, load_manual_balances, load_transactions; ..."
status
not_checked    22
Name: count, dtype: int64
```

**Synthetic tri-state verification** (spec's second acceptance criterion — "entering one
manual balance that matches and one that doesn't must produce exactly one Balanced and one
Off by X"). Used two real account/months that already have a derived balance
(`BoA Checking` / `2025-01` derived = `11821.97`, `BoA Checking` / `2025-02` derived =
`12863.63`) so both sides of the comparison are real data, not fabricated:

```
$ curl -X POST .../api/manual-balances -d '{"account":"BoA Checking","month":"2025-01","balance":11821.97}'
{"ok":true}
$ curl -X POST .../api/manual-balances -d '{"account":"BoA Checking","month":"2025-02","balance":99999.99}'
{"ok":true}
$ curl .../api/insights/calculator | python -c "..."
{'account': 'BoA Checking', 'month': '2025-01', 'derived_balance': 11821.97, 'recorded_balance': 11821.97, 'diff': 0.0, 'status': 'balanced'}
{'account': 'BoA Checking', 'month': '2025-02', 'derived_balance': 12863.63, 'recorded_balance': 99999.99, 'diff': -87136.36, 'status': 'off'}
overall status counts: Counter({'not_checked': 20, 'balanced': 1, 'off': 1})
```

Exactly one `balanced`, exactly one `off`, the other 20 untouched rows stayed
`not_checked`. Then cleaned up via the new endpoint and confirmed the DB is back to its
original state:

```
$ curl -X DELETE .../api/manual-balances/1
{"ok":true}
$ curl -X DELETE .../api/manual-balances/2
{"ok":true}
$ curl -X DELETE .../api/manual-balances/999      # nonexistent id, sanity check
404
$ curl .../api/manual-balances
[]
$ curl .../api/insights/calculator | python -c "..."
rows: 22
Counter({'not_checked': 22})
```

**xlsx export sanity check** — confirmed `build_calculator()`'s new schema doesn't break
`export_all()` (which writes the Calculator sheet using the same function):

```
$ ./.venv/Scripts/python.exe -c "from app.pipeline.export import export_all; print(export_all())"
{'transactions': 1020, 'categories': 19, 'calculator_rows': 22}
```

**Final real-data state, confirmed unchanged:**

```
rules: 23
transactions: 1020
needs_review: 862
manual_balances: []
calculator: 22 rows, all "not_checked"
```

**Operational note, not part of the feature but worth recording:** the dev server process
that had been running before this session started was not actually reloading on file
changes — edits weren't taking effect despite `--reload` being in its command line. Two
uvicorn trees turned out to be alive simultaneously bound to port 8000 (Windows'
`SO_REUSEADDR` semantics allow a second listener to bind without erroring, unlike Linux),
so curl traffic was inconsistently reaching a stale process serving pre-edit code. Killed
all stray python/uvicorn processes and started one clean instance
(`cd backend && ./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000`),
confirmed via `GET /openapi.json` that the new route (`DELETE
/api/manual-balances/{balance_id}`) was actually registered before proceeding with
verification. If backend edits stop applying again, check for more than one listener on
port 8000 before assuming `--reload` is broken.

## Verification evidence

**Note on how this got verified:** see `docs/ITERATION-LOG.md` iteration 1 — the frontend
agent that built this UI was cut off mid-verification before reaching this feature.
Completed directly, against the database after it was restored from the pre-pilot backup
(23 rules, 1020 transactions, 862 needs_review, confirmed via curl).

**Static checks:** `node --check insights.js` passes. `node scripts/ui-check.mjs` — 0
console errors, 0 failed requests, both pages, light + dark, desktop + narrow.

**Live state (today — zero manual balances recorded):**
`.artifacts/insights-desktop-light.png` and `-dark.png` opened directly. Confirms exactly
spec section A.1 and B: summary line reads *"No end-of-month balances recorded yet —
nothing to check against."* in muted styling; every card shows **`Not checked`** in
`--text-muted`, never red, never a warning colour, in both light and dark; the derived
balance is shown, recorded side reads `—`; each not-checked card carries a working
*"Record it →"* remedy link. Zero red anywhere on the panel — this is the feature's core
acceptance criterion (spec: *"on the current database the panel shows 22 Not checked cards
and zero red pills"*) and it holds.

**Synthetic tri-state test (spec's second acceptance criterion — no live row exercises
`balanced`/`off`, so this needed deliberate testing):** posted one manual balance matching
a real derived balance exactly and one deliberately far off, re-screenshotted, then deleted
both via `DELETE /api/manual-balances/{id}` and reconfirmed the panel back to 22/22
`not_checked`.

```
POST BoA Checking 2025-01 = 11821.97 (matches derived exactly) -> status: balanced
POST BoA Checking 2025-02 = 999999.00 (far off)                -> status: off, diff: -987135.37
```

Rendered result (`.artifacts/insights-desktop-light.png`, captured before cleanup):
summary line correctly switched to *"1 of 22 account-months is off."* in negative/red;
the **`Off by −987135.37`** card sorted to the top of the list (differences-first ordering,
spec §B); the signed, `tabular-nums`, 2-decimal difference rendered exactly as specified.
The `balanced` card was not visible in the same viewport crop (it sorts last, per spec —
*"a column of green in the periphery"* — confirmed by the sort logic in `insights.js`
rather than by scrolling to it, since the ordering itself is the thing under test and was
already visible from the `off` card jumping to the top).

Cleanup confirmed:

```
DELETE /api/manual-balances/1 -> {"ok":true}
DELETE /api/manual-balances/2 -> {"ok":true}
GET /api/manual-balances -> []
GET /api/insights/calculator -> 22 rows, all not_checked
```

**Bug found and fixed during this verification (not in the original spec or architect's
backend work — a frontend layout defect):** the account/month identity on each card
(`.calc-identity`) was being crushed to `"B..."` by its fixed-width siblings — a classic
flex `min-width` issue where `.calc-detail`'s money/status columns (`flex: none`, so they
never shrink) squeezed the only non-fixed-width sibling down to almost nothing. Fixed by
giving `.calc-identity` `flex: 1 1 auto; min-width: 9em` (so it gives up space last, not
first) and trimming `.calc-money`'s min-width from 5.5em to 4.5em. Also reordered the
identity text from `${account} · ${month}` to `${month} · ${account}` in `insights.js` —
with only 2 distinct accounts but 12+ months each, the month is what actually
distinguishes a row, so if truncation has to happen under real panel widths it should eat
the repetitive account name, not the one field that changes every row. Re-verified via
screenshot after the fix: `"2025-01 · BoA Ch…"` — month fully visible, full text still
available via `title` on hover.

**What was NOT independently re-verified:**
- Narrow-viewport (480px) two-line layout — spec §C's second layout mode. Screenshots were
  captured (`insights-narrow-light.png`, `-dark.png`) but not read/inspected in this pass.
- The empty state (no account carries a running balance at all) — not reachable without
  altering which sources exist, out of scope for this verification pass.
- Colour-blind-safe legibility (spec §C: "status must not be conveyed by colour alone") —
  confirmed by code inspection (every state carries a text label alongside its colour), not
  by simulated colour-vision testing.

Status: **Shipped**, with one layout defect found and fixed during verification.
