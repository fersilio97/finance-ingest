# 005 — Balance entries: record a balance at an exact moment, reconcile against it
Status: Shipped (backend only)
Iteration: 2, Session 2

## Problem

`manual_balances` (`backend/app/db.py`) is `UNIQUE(account, month)` — one balance per
account per calendar month, entered by hand via `POST /api/manual-balances`. The user
wants to record a balance at the exact date and time he checked it (so, for example, two
different balances for BoA Checking within July are both keepable), and wants the
balance-trend chart (a later session) to plot each entry as a dot at its exact timestamp
rather than snapped to a month bucket. He also wants reconciliation to compare against
*whatever he's actually recorded*, not manufacture a placeholder row for every
account-month combination that ever had a derived running balance, whether or not he ever
checked it.

That second part matters because of what spec 003 already fixed once. `build_calculator()`
(pre-session) produced one row per account × month with a derived balance — including
synthetic rows for months nobody ever recorded anything for. Live, that was 22 rows, all
`not_checked`, because `manual_balances` has always been empty in the real database. 003
fixed the *symptom* (a NaN-unsafe boolean turning "never recorded" and "recorded but
wrong" into the same false `match: false`). This session removes the underlying
*generator* of synthetic rows altogether: once nothing writes to `manual_balances` again,
`build_calculator()` fed an always-empty frame would keep emitting exactly 22
permanently-`not_checked` placeholder rows forever, both in the API and in the xlsx —
reintroducing 003's bug in the spreadsheet even after the UI stops using the old path.

## Architecture

**Data model — new table, `manual_balances` left physically in place.**
`manual_balances`'s `UNIQUE(account, month)` constraint is exactly what has to stop being
true (the whole point is "more than one entry per account per month"), and SQLite cannot
`ALTER TABLE ... DROP CONSTRAINT` — changing a UNIQUE constraint requires a full
create-copy-drop-rename table rebuild. Running that against `data/finance.db` for a
constraint change is exactly the kind of migration risk this project's rules explicitly
avoid; a table that's currently empty doesn't need a risky rebuild to correct. So
`balance_entries` is a new, additive table (`backend/app/db.py`):

```sql
CREATE TABLE IF NOT EXISTS balance_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    recorded_at TEXT NOT NULL,       -- ISO-8601 datetime, e.g. "2026-07-15T14:30:00"
    balance REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

No uniqueness constraint at all — multiple entries can legitimately share an
account/timestamp/balance (e.g. two identical corrections), and the whole reason this
table exists is "more than one per account per month" is now allowed. `manual_balances`
stays in `SCHEMA` unchanged, unused by any endpoint or builder from this session forward.
Deleting it was never on the table — it's real (if currently empty) user data and the
runbook's additive-only rule applies to removal too, not only addition.

**Migration — additive, idempotent, no-op on live data (confirmed).** Following the exact
idiom `_ensure_column()`/`_backfill_batch_ids()` established (helper function, called
unconditionally from `init_db()`, safe to run every server start):

```python
def _migrate_manual_balances_to_entries(conn) -> None:
    rows = conn.execute("SELECT account, month, balance FROM manual_balances").fetchall()
    for row in rows:
        recorded_at = f"{row['month']}-01T00:00:00"
        existing = conn.execute(
            "SELECT id FROM balance_entries WHERE account = ? AND recorded_at = ? AND balance = ?",
            (row["account"], recorded_at, row["balance"]),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO balance_entries (account, recorded_at, balance) VALUES (?, ?, ?)",
                (row["account"], recorded_at, row["balance"]),
            )
```

Idempotency can't lean on `INSERT OR IGNORE` against a UNIQUE constraint the way
`create_batch()`'s pattern does (`balance_entries` deliberately has none) — instead it's a
check-before-insert per source row, safe to re-run every boot. **Confirmed live
`manual_balances` is 0 rows** (see Verification) so this migration is a no-op in
production; it exists for safety, not because there was anything to fold. Verified the
folding and idempotency logic itself against a throwaway temp SQLite file (never
`data/finance.db`) — see Verification evidence.

**Reconciliation rework — per-entry, not per-account-month-grid.**
`build_calculator(df, manual)` is removed outright and replaced with
`build_reconciliation(df, entries)` (`backend/app/pipeline/export.py`). The new function
produces exactly one row per `balance_entries` row that exists — zero rows if nothing has
been recorded, growing by exactly one row per entry the user adds, never a synthetic
placeholder for a month nobody checked.

For each entry: `derived_balance` is the `balance_after` of the last transaction for that
account with `date <= entry.recorded_at[:10]` (transactions only carry date-level
granularity, never a time, so the entry's timestamp is truncated to its comparable date —
there is no finer match available). The lookup uses the same `sort_values("date",
kind="stable")` approach the old `build_calculator()` used and for the identical reason:
default quicksort isn't stable and can silently reorder same-day rows, which would then
make "last balance for that date" pick an arbitrary row instead of the one that's last in
the DB's own `date, id` insertion order. `diff = derived_balance - entry.balance`
(`null` when `derived_balance` is null). Tri-state `status` is unchanged from 003's
contract: `"not_checked"` when there's no transaction at/before the entry's date for that
account, `"balanced"` when `|diff| < 0.01`, `"off"` otherwise — same sub-cent tolerance,
same reasoning (float sums over hundreds of rows produce phantom mismatches at exact
equality).

`load_balance_entries(conn)` mirrors the shape of the removed `load_manual_balances(conn)`
— reads `balance_entries` into a DataFrame with columns
`[id, account, recorded_at, recorded_balance]`.

**`build_calculator()` and `load_manual_balances()` are deleted, not deprecated-in-place.**
This mirrors 003's own precedent exactly (003 removed the `match` boolean rather than
keeping it alongside the new `status` field, "for compatibility"): after this session
ships, nothing ever writes a fresh row into `manual_balances` again — every write path
(`POST/DELETE /api/manual-balances*`) is removed in the same commit — so a lingering
`build_calculator()` fed a permanently-empty frame would forever render the xlsx
`Calculator` sheet as N synthetic `not_checked` rows (N = however many distinct
account-months exist by then, growing every month), silently reintroducing exactly the
"panel that always says unverified and is never right about it" bug 003 exists to remove
— just relocated from the UI into the spreadsheet, where nobody would notice until asked.
Keeping the old function "just in case" would be an attractive nuisance: it still runs,
still produces output, still looks correct at a glance, and is wrong by construction the
moment `manual_balances` stops being written to.

**API — replace, not extend.** `GET/POST /api/manual-balances` and `DELETE
/api/manual-balances/{id}` are removed; `GET/POST /api/balance-entries` and `DELETE
/api/balance-entries/{id}` take their place, following the exact shape of the `DELETE
/api/rules/{id}` / old `DELETE /api/manual-balances/{id}` pattern (404 via `HTTPException`
if the row doesn't exist, hard delete otherwise, no re-enrich side effect — balance
entries don't drive classification, same as manual balances never did).

```
GET    /api/balance-entries                                      -> 200 [ {...}, ... ]
POST   /api/balance-entries {account, recorded_at, balance}       -> 200 {"id": int, "ok": true}
DELETE /api/balance-entries/{entry_id}                            -> 200 {"ok": true}
                                                                    -> 404 if entry_id doesn't exist
```

Validation on `POST /api/balance-entries` (`BalanceEntryRequest` in `routes.py`), matching
the existing `field_validator` pattern used elsewhere in the file (`category_must_be_known`,
`match_text_not_blank`):
- `account`: rejected if blank/whitespace-only, stripped otherwise (same "not blank" shape
  as `RuleRequest.match_text`, though the old `ManualBalanceRequest` had *no* validation on
  `account` at all — this is a small addition beyond parity, closing a real gap: an
  all-whitespace account string would previously have been silently stored).
- `recorded_at`: must parse via `datetime.fromisoformat` or the request is rejected
  (422) — this is new; nothing validated `month` shape before either, but a malformed
  timestamp is far more likely to happen by accident (a JS `Date` serialized wrong, a
  copy-paste typo) and a bad `recorded_at` silently corrupts every reconciliation row and
  the balance-trend chart's x-axis (a later session), so it's worth rejecting at the door
  rather than storing garbage.
- `balance`: `float`, same as before, no additional validation (a balance of `0.0` or
  negative is legitimate — overdraft, empty account).

**`GET /api/insights/calculator` renamed to `GET /api/insights/reconciliation`.** Same
justification 003 already used for its own breaking response-shape change on this same
endpoint: the sole consumer, `frontend/insights.js`, is scheduled to be rewritten in a
later session of this same iteration (Session 6, alongside the new balance-entry UI), so
there is no real caller left to be compatible with. Renaming now — rather than keeping
`/calculator` as an alias — avoids a stale, misleadingly-named route surviving in
`openapi.json` for a feature that no longer exists in that shape.

**API contract — `GET /api/insights/reconciliation`:**

```
GET /api/insights/reconciliation ->
[
  {
    "id": int,
    "account": str,
    "recorded_at": str,
    "recorded_balance": float,
    "derived_balance": float | null,
    "diff": float | null,
    "status": "not_checked" | "balanced" | "off"
  },
  ...
]
```

Zero rows live today (zero `balance_entries` rows exist) — this is the intended, more
honest behavior described in the Problem section: nothing to show until something is
actually recorded, instead of 22 permanent placeholders.

**Risks / trade-offs, stated up front:**

- *Same-day tie ambiguity in `derived_balance` is inherited, not introduced.* Because
  transactions only carry date-level granularity, if a source posts several transactions
  on one date, "last balance for that date" is whichever row is last in the DB's `date, id`
  order — which is the order the source file listed transactions in, not necessarily true
  intraday chronological order (confirmed live: BoA Checking's CSV lists a day's
  transactions newest-first, so the DB's `id` order for that day is descending balance,
  and "last by id" picks the *smallest* balance of the day, not the largest). This exact
  ambiguity already existed in `build_calculator()` before this session; `build_reconciliation()`
  preserves it rather than trying to solve it, because solving it (e.g. sniffing statement
  order per source) is out of scope for this session and would be guessing intraday order
  from a source that was never given intraday timestamps to begin with. Flagging clearly
  because it directly affects what "balanced" means for a same-day entry: an entry dated
  the same calendar day as several transactions is being compared against a specific one
  of them by DB insertion order, not by "the true end-of-day balance."
- *`recorded_at` accuracy is entirely user-trusted.* Nothing cross-checks a submitted
  timestamp against, say, "not in the future" or "not before the account existed" — out of
  scope for this session, flagging for whoever builds the entry-creation UI to decide
  whether that's worth adding client-side.
- *No account-name validation against `sources`/`SOURCES`.* `BalanceEntryRequest.account`
  only rejects blank strings, not unknown account names — this matches the old
  `ManualBalanceRequest`'s behavior exactly (it had no such check either), preserved rather
  than tightened because the frontend session hasn't landed yet and it's cleaner to decide
  "should this be a closed set, free text, or a dropdown populated from `GET /api/sources`"
  together with that UI rather than guessing the constraint here first.

## Implementation notes

**Files changed:**

- `backend/app/db.py` — added `balance_entries` to `SCHEMA` (new table, `manual_balances`
  untouched); added `_migrate_manual_balances_to_entries()`, called from `init_db()`
  immediately after `_backfill_batch_ids()`.
- `backend/app/pipeline/export.py`:
  - `load_manual_balances()` removed; `load_balance_entries()` added (mirrors its shape,
    reads `balance_entries` instead).
  - `build_calculator()` removed; `build_reconciliation(df, entries)` added — per-entry
    output instead of the per-account-month grid (`RECONCILIATION_COLUMNS` constant lists
    the 7 output columns).
  - `export_all()` updated to call `load_balance_entries`/`build_reconciliation`; the xlsx
    `Calculator` sheet keeps its existing name (`export.py:152`) and is now sourced from
    the new builder — same DataFrame-in shape to `to_excel(...)` as before.
- `backend/app/api/insights.py` — `calculator()` renamed to `reconciliation()`, mounted at
  `GET /api/insights/reconciliation`; imports updated to `build_reconciliation` /
  `load_balance_entries`.
- `backend/app/api/routes.py`:
  - `datetime` added to the existing `from datetime import date` import (needed for
    `recorded_at` ISO validation).
  - `ManualBalanceRequest` and its three endpoints (`GET/POST /api/manual-balances`,
    `DELETE /api/manual-balances/{id}`) removed.
  - `BalanceEntryRequest` (with `account`/`recorded_at` validators) and
    `GET/POST /api/balance-entries`, `DELETE /api/balance-entries/{entry_id}` added in
    their place.

No changes to `uploads`, `frontend/`, merchant grouping, or rules — confirmed by re-running
the baseline checks below and by `grep`-confirming no other backend file referenced the
removed names after the change.

**Deviation from the plan / thing found along the way:** the exact stale-`--reload`
listener issue 003 and Session 1 both hit recurred here. Before making any edits the dev
server was already up (`GET / -> 200`), but after implementing all the code changes,
`GET /openapi.json` still showed the *old* routes (`/api/manual-balances`, distinct from
docs' warning to check this before trusting responses). `wmic process where "name=
'python.exe'" get ProcessId,ParentProcessId,CommandLine` showed the `--reload` watcher
process had spawned its worker using a *different* Python interpreter than the one on its
own command line (the watcher's command line named the project's `.venv` python; its child
worker was running `C:\Users\nano_\AppData\Local\Programs\Python\Python39\python.exe`
instead) — serving stale, pre-edit code regardless of source-file changes. Killed the
whole process tree (`taskkill /F /T /PID <watcher>`), confirmed zero `python.exe` processes
remained, and started one clean instance per the runbook's documented command. After the
restart, `/openapi.json` showed exactly the expected new routes and none of the old ones —
verified before proceeding with any further testing, per the runbook's explicit warning
about this exact failure mode. This did not touch `data/finance.db` or any data.

## Verification evidence

All against the live server at `http://127.0.0.1:8000`, `data/finance.db` (the real
database) unless stated otherwise. Synthetic test data was created and deleted
immediately after use, per the runbook and the project's iteration-1 cleanup lesson
(`docs/ITERATION-LOG.md`).

**Baseline, before touching anything:**

```
$ curl -s http://127.0.0.1:8000/api/rules | python -c "...len..."
108
$ curl -s "http://127.0.0.1:8000/api/transactions?status=needs_review" | python -c "...len..."
315
$ curl -s http://127.0.0.1:8000/api/manual-balances
[]
```

**Routes registered after the change** (`/openapi.json`, after resolving the stale-reload
issue above):

```
/api/balance-entries
/api/balance-entries/{entry_id}
/api/insights/balance-trend
/api/insights/reconciliation
```

`/api/manual-balances`, `/api/manual-balances/{balance_id}`, `/api/insights/calculator`
all return 404 (route no longer exists) — confirmed directly:

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/manual-balances
404
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/insights/calculator
404
```

**Empty state — 0 balance_entries live, 0 reconciliation rows returned** (the new, more
honest behavior — no synthetic placeholders):

```
$ curl -s http://127.0.0.1:8000/api/balance-entries
[]
$ curl -s http://127.0.0.1:8000/api/insights/reconciliation
[]
```

**Migration folding + idempotency**, tested against a throwaway temp SQLite file (never
`data/finance.db` — live `manual_balances` is 0 rows, so this path has no live coverage
otherwise):

```
$ ./.venv/Scripts/python.exe -c "... insert 2 manual_balances rows into a temp DB, call init_db() twice ..."
after first migration:  [{'id': 1, 'account': 'BoA Checking', 'recorded_at': '2025-01-01T00:00:00', 'balance': 11821.97, ...},
                         {'id': 2, 'account': 'Fidelity Savings', 'recorded_at': '2025-06-01T00:00:00', 'balance': 27000.5, ...}]
after second migration (idempotency check): <identical 2 rows>
row count unchanged: True
```

**Synthetic tri-state test.** First attempt used a derived value read from
`GET /api/insights/balance-trend`, which turned out to use a *non*-`kind="stable"` sort —
its same-day tie order differs from `build_reconciliation()`'s (see Architecture's "same-day
tie ambiguity" risk note); that first attempt produced `status: off` for what was meant to
be the `balanced` case, an authentically caught bug in the test itself, not the code.
Re-derived the expected value directly via `build_reconciliation()` before re-testing live:

```
$ ./.venv/Scripts/python.exe -c "... load_transactions(conn), then build_reconciliation(df, entries) with two candidate entries ..."
[{'account': 'BoA Checking', 'recorded_at': '2025-01-21T12:00:00', 'recorded_balance': 16315.24,
  'derived_balance': 16315.24, 'diff': 0.0, 'status': 'balanced'},
 {'account': 'Fidelity Savings', 'recorded_at': '2025-12-31T23:00:00', 'recorded_balance': 99999.99,
  'derived_balance': 27598.44, 'diff': -72401.55, 'status': 'off'}]
```

Then posted the same two entries through the real HTTP endpoint and confirmed identically:

```
$ curl -X POST .../api/balance-entries -d '{"account":"BoA Checking","recorded_at":"2025-01-21T12:00:00","balance":16315.24}'
{"id":3,"ok":true}
$ curl -X POST .../api/balance-entries -d '{"account":"Fidelity Savings","recorded_at":"2025-12-31T23:00:00","balance":99999.99}'
{"id":4,"ok":true}
$ curl .../api/insights/reconciliation
[{"id":3,"account":"BoA Checking", ..., "status":"balanced"},
 {"id":4,"account":"Fidelity Savings", ..., "status":"off"}]
```

Exactly one `balanced`, exactly one `off`. Cleaned up immediately:

```
$ curl -X DELETE .../api/balance-entries/3
{"ok":true}
$ curl -X DELETE .../api/balance-entries/4
{"ok":true}
$ curl -X DELETE .../api/balance-entries/999      # nonexistent id, sanity check
404
$ curl .../api/balance-entries
[]
$ curl .../api/insights/reconciliation
[]
```

**Validation checks:**

```
$ curl -X POST .../api/balance-entries -d '{"account":"BoA Checking","recorded_at":"not-a-date","balance":100}'
422
$ curl -X POST .../api/balance-entries -d '{"account":"  ","recorded_at":"2025-01-21T12:00:00","balance":100}'
422
$ curl -X POST .../api/balance-entries -d '{"account":"__test_account__","recorded_at":"2025-01-21T12:00","balance":100}'
200 {"id":5,"ok":true}     # no-seconds ISO datetime accepted — see handoff note below
```

Cleaned up (`DELETE .../api/balance-entries/5` -> `{"ok":true}`, re-confirmed `[]`).

**`export_all()` end-to-end, direct python call:**

```
$ ./.venv/Scripts/python.exe -c "from app.pipeline.export import export_all; print(export_all())"
{'transactions': 1020, 'categories': 19, 'calculator_rows': 0}
```

`calculator_rows: 0` matches the 0 live `balance_entries` rows (correct — no synthetic
rows manufactured). Confirmed the `Calculator` sheet exists in the regenerated xlsx with
the new 7-column header (`id, account, recorded_at, recorded_balance, derived_balance,
diff, status`) and 0 data rows, via `openpyxl.load_workbook(...)`.

**Final re-check — everything this session was scoped to leave untouched, confirmed
unchanged:**

```
rules: 108
needs_review: 315
transactions (total): 1020
balance_entries: 0
manual_balances: 0 rows, table still physically present (sqlite_master check)
```

**What was NOT tested:** the frontend (out of scope — Session 6). The `uploads` table and
its endpoints (untouched, not part of this session's scope, confirmed via `grep` that no
file touching `uploads` was modified). Cross-timezone or "future timestamp" validation for
`recorded_at` — not built, not requested.

## Handoff to fintech-frontend (Session 6)

- **`recorded_at` format:** the server accepts anything `datetime.fromisoformat()` parses.
  Confirmed live that a value with **no seconds** — e.g. `"2025-01-21T12:00"`, which is
  exactly what an HTML `<input type="datetime-local">` produces when the user doesn't
  touch the seconds field — is accepted as-is (200, stored verbatim, not normalized to
  include `:00`). If you want stored values to always include seconds for consistent
  display/sorting, normalize on the client before POSTing; the server does not currently
  do this for you.
- **Malformed `recorded_at` is rejected with 422**, not silently coerced — build your form
  to surface FastAPI's validation error rather than assume a bad value gets "fixed" server-side.
- **`account` validation is currently just "not blank"** — no check against known account
  names (`GET /api/sources` returns the `account` field per source). Decide in this session
  whether the balance-entry form should be a free-text field or a dropdown constrained to
  known accounts; the backend doesn't enforce either way yet.
- **`GET /api/insights/reconciliation` returns `[]` today** — there is no synthetic
  placeholder data to build against. You'll need to `POST /api/balance-entries` at least
  one row (test data, cleaned up afterward, or real data if the user starts using the
  feature) to see non-empty output while building/testing the UI.
- **Same-day ties in `derived_balance` are DB-insertion-order-dependent, not
  chronological**, for accounts that post multiple transactions on one date — see
  Architecture's risk note. If the UI surfaces "as of X" alongside `derived_balance`, don't
  imply it's the literal end-of-day balance; it's "the last transaction we have on or
  before that date, in the order the source file listed them."
- **`recorded_balance`, `derived_balance`, and `diff` are all JSON `number` or `null`** —
  `derived_balance`/`diff` are `null` together whenever `status` is `"not_checked"`,
  never independently null.
- There is no `PUT /api/balance-entries/{id}` — editing an entry is delete-then-recreate,
  same as the old manual-balances endpoint never had an edit path either.
