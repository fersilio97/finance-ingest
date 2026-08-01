# 006 — Balance trend rework (all 6 accounts) and transaction drill-down filters
Status: Shipped (backend only)
Iteration: 2, Session 3

## Problem

**Balance trend.** `GET /api/insights/balance-trend` today returns only raw
`{account, date, balance_after}` rows for the 2 sources with a native running-balance
column (BoA Checking, Fidelity Savings — `sources.has_running_balance = 1`). The other 4
accounts (BoA Credit Card, Fidelity Credit Card, HSA, 401k) never appear, because they have
no source-native running-balance field at all. The user wants all 6 accounts represented as
a line, an aggregated total line across accounts, and the balance-entries from session 005
included so a later frontend session can plot them as markers on the right account's line.

**Transactions drill-down.** `GET /api/transactions` only accepts `status`. There is no way
to ask "show me the transactions behind this Insights cell" (a specific category × month
combination), which the discovery doc (`docs/FEATURES.md` backlog #10-adjacent territory —
"drill-down from an Insights cell to its transactions") flagged as valuable but deferred
until the queue itself was manageable. Iteration 2 is now adding the balance-entries/UI work
that makes a drill-down link worth having on the frontend side (session 7).

## Architecture

### Part A — `build_balance_trend(df, entries, account_flags)`

**Why this stays server-side, unlike 002's merchant grouping.** 002 (grouping the review
queue) explicitly kept its aggregation client-side, and its own architecture section states
the test it applied: does the feature need new/different data than what's already fetched?
For 002 the answer was no — `GET /api/transactions?status=needs_review` already returns
`description`, `date`, `amount`, `source`, `id`, which is 100% of what merchant-key grouping
needs, so computing it in JS costs nothing extra over the wire. **That condition does not
hold here.** The old `/api/insights/balance-trend` response contains only
`{account, date, balance_after}` — it never included raw `amount` at all, because
`balance_after` already *was* the plotted value for the 2 native accounts and nothing else
was being computed. Deriving a running total for the other 4 accounts needs `amount` for
every transaction on those accounts, which is not in today's response by construction.
Moving the derivation to the client would mean **first shipping a strictly bigger new
payload** (essentially all of `load_transactions()`, ~1020 rows, versus the ~556 filtered
rows the endpoint returns today) and then re-deriving the exact same cumulative-sum-with-
forward-fill logic in JS — the opposite of 002's "compute over data already fetched, for
free" condition. Python + pandas is also already the trusted place for this class of
computation in this codebase (`build_reconciliation`, `build_global`): multi-step,
correctness-sensitive aggregation (stable sort for same-day ties, forward-fill with
selective exclusion) that's easy to get subtly wrong once and is exercised by exactly one
consumer either way, so there's no reuse argument for pushing it to the client. Building it
in `export.py` also means the same builder could feed a future xlsx sheet or CLI tool without
duplicating the logic, the same reasoning that already applies to `build_reconciliation`
being shared between the API and the `Calculator` xlsx sheet.

**Where the native/derived flag comes from.** `sources.has_running_balance` is the
authority. `load_transactions()` does *not* currently join it in, and I chose not to make it
do so: that dataframe is also written verbatim to `transactions.csv` and the xlsx
`Transactions` sheet (`export.py:150`, `df.to_csv(...)`/`df.to_excel(...)` write whatever
columns `df` has, not a fixed allow-list — `TRANSACTIONS_COLUMNS` is only used for the
*empty*-dataframe case). Joining `has_running_balance` onto every transaction row would leak
an unrelated column into those two derived artifacts for a flag only one consumer needs. So
account metadata travels as a small separate dict instead: a new loader,
`load_account_flags(conn) -> dict[account, bool]`, doing one `SELECT account,
has_running_balance FROM sources` and nothing else — mirrors `load_balance_entries()`'s
shape (loader takes `conn`, returns a plain data structure; the builder that consumes it is
pure over that structure, no DB access). This is why `build_balance_trend` ends up with a
third parameter (`account_flags`) rather than the two-argument shape floated at spec time —
flagging the deviation here rather than silently changing the signature: the alternative
(joining into `df`) was rejected specifically to avoid the CSV/xlsx leak above.

**Native points — unchanged computation, repackaged.** For accounts with
`has_running_balance = 1`, `points` is exactly the old flat query's output
(`df[df["balance_after"].notna()].sort_values("date")`), just grouped per account instead of
returned as one flat list. Same sort (not `kind="stable"` — deliberately preserving the old,
already-shipped tie behaviour rather than "fixing" it as a side effect of this rework, which
would be an unrequested behaviour change smuggled into a repackaging task), same filter, same
columns renamed `balance_after` → `balance` for the new shape's consistency with the derived
side.

**Derived points — relative running total, starting at 0, `kind="stable"` sort.** For the
other 4 accounts: cumulative sum of `amount` in date-ascending order, first point = first
transaction's amount. This is explicitly *not* an absolute balance (the user's own framing,
stated in the task) — there is no starting balance to anchor a credit card, HSA, or 401k
series to, and manufacturing a fake anchor (e.g. 0 = "opened this account with nothing") would
be actively misleading for e.g. a credit card that already had a balance before the earliest
transaction in this DB. `kind="stable"` for the identical reason `build_reconciliation` uses
it: default quicksort can reorder same-day transactions, which here would make the running
total's *value* at each same-day point non-deterministic across requests (not just the tie-
breaking order like in reconciliation, but the actual accumulated number), a real
correctness bug if left unstable.

**Aggregated — forward-fill per account, exclusion not zero-fill.** For every distinct date
that appears in *any* account's `points`, sum each account's last known point as of that
date, but only for accounts that have at least one point on or before that date. Implemented
as a single forward merge-scan (each account keeps a cursor into its own already-sorted
`points` list, advanced only as far as the current aggregate date) rather than, say, a pandas
`reindex().ffill()` per account — deliberately simple, linear in total point count (~1,020
points across 6 accounts today), and avoids pandas' default `ffill()` semantics silently
carrying a `NaN`-turned-0 forward, which is exactly the bug this feature is designed to
avoid (a 0 for "no data yet" reads as "this account had nothing," which is false — it means
"we don't know"). Verified this matters live: the first aggregated date (2025-01-13) equals
BoA Checking's own first balance (200.00) exactly, not 200.00 diluted by 5 phantom zeros
from the other 5 accounts whose data doesn't start until between March 2025 and March 2026.

**`entries` — reused verbatim, reshaped.** `load_balance_entries(conn)` (005) is called
as-is, no reimplementation. Its `recorded_balance` column is renamed to `balance` in the
JSON output to match the shape the spec asked for (`{"id", "account", "recorded_at",
"balance"}`) — this rename happens only in the JSON-shaping step inside
`build_balance_trend`, not in `load_balance_entries` itself, so 005's `reconciliation`
endpoint (which still expects `recorded_balance`) is untouched.

**API contract:**

```
GET /api/insights/balance-trend ->
{
  "series": [
    {"account": "BoA Checking", "kind": "native", "points": [{"date": "2025-01-13", "balance": 200.0}, ...]},
    {"account": "BoA Credit Card", "kind": "derived", "points": [{"date": "2025-06-16", "balance": -42.1}, ...]},
    ... (6 entries total, one per account in `sources`, in `sources`' own row order)
  ],
  "aggregated": [{"date": "2025-01-13", "balance": 200.0}, ...],
  "entries": [{"id": 1, "account": "BoA Checking", "recorded_at": "2025-07-15T14:30:00", "balance": 11800.0}, ...]
}
```

This is a breaking response-shape change (old: flat array; new: object with 3 keys). No
justification is needed beyond what 003/005 already established for this same endpoint
family: the sole consumer, `frontend/insights.js`, hasn't been rewritten for the new shape
yet (that's session 7) — there is no live caller to break.

### Part B — `category`/`month` filters on `GET /api/transactions`

**Validation, not silent no-match.** `month` is checked against `^\d{4}-\d{2}$` before
touching the DB, raising `HTTPException(400, ...)` on failure — mirroring the file's existing
manual-validation style (`classify_transaction`'s `save_as_rule` check) rather than
`ClassifyRequest`'s pydantic `field_validator` style, because `status`/`category`/`month` are
plain function-parameter query params here, not a request body backed by a pydantic model;
introducing a pydantic model for 3 optional query params would be more machinery than the
existing endpoint uses for its current single param. Rejecting explicitly (400) rather than
matching zero rows silently means a malformed `month` in a future frontend bug is visible
immediately instead of rendering a quietly-empty drill-down.

**Parameterization.** Clauses (`status = ?`, `category = ?`, `date LIKE ?`) are built as a
list and joined with `AND`, with every value passed as a bind parameter — the same shape the
existing `status`-only query already used, just generalized to N optional clauses instead of
a hardcoded 0-or-1. `month` becomes a `LIKE` parameter value (`f"{month}%"`), not a
string-formatted-into-SQL fragment — the `%` wildcard is part of the *parameter value*, not
concatenated SQL text, so this is not vulnerable to injection via `month`, and the regex gate
means the value reaching that parameter is always exactly 7 characters matching `\d{4}-\d{2}`
before the wildcard is appended.

**No new index.** Per the task's own instruction and 002's own measurement (`GET
/api/transactions?status=needs_review` returns 862 rows / 329KB in ~70ms against the same
row count this session tested against), an unindexed scan over ~1,020 rows is already fast
enough that adding an index would be solving a problem that doesn't exist yet, at the cost of
one more thing to keep in sync on every insert. Measured live below — the combined-filter
query returned in ~8ms, faster than the unfiltered query (fewer rows to serialize back into
JSON), not slower.

**Risks / trade-offs, stated up front:**

- *`build_balance_trend` third parameter deviates from the two-arg signature suggested at
  spec time* (`account_flags`, not folded into `df`) — see the "where the flag comes from"
  paragraph above for why. Flagging explicitly since the task described a 2-arg signature.
- *Native same-day tie order is index-of-appearance-in-sort, not chronological* — this is
  inherited unchanged from the pre-existing endpoint (not introduced by this session), see
  005's identical risk note for `build_reconciliation`. Applies here too, to the `native`
  series' same-day points.
- *Derived series are relative, not absolute, and say so only via `kind: "derived"`* — the
  API doesn't embed a human-readable caveat string; whichever frontend session renders this
  needs to visually distinguish "derived" lines (e.g. dashed, or an axis note) so a user
  doesn't read a credit card's derived line as its literal balance.
- *`balance_entries.account` still has no validation against known account names* (005's own
  flagged gap, unchanged by this session) — if a future entry is recorded under a typo'd or
  otherwise unknown account string, `entries[].account` in this response won't match any
  `series[].account`, and the frontend has no account line to plot that dot on. Nothing in
  this session closes that gap; flagging again for whoever builds the entry UI (session 6).

## Implementation notes

**Files changed:**

- `backend/app/pipeline/export.py`:
  - `load_account_flags(conn)` added — `account -> has_running_balance` dict from `sources`.
  - `build_balance_trend(df, entries, account_flags)` added, co-located with
    `build_global`/`build_reconciliation`.
  - No changes to `load_transactions`, `load_balance_entries`, `build_global`,
    `build_reconciliation`, or `export_all()` — this session's additions are pure additions,
    not modifications to any existing function.
- `backend/app/api/insights.py` — `balance_trend()` rewritten to call
  `load_transactions`/`load_balance_entries`/`load_account_flags` then
  `build_balance_trend(...)`, returning its dict directly. Import line updated
  (`build_balance_trend`, `load_account_flags` added).
- `backend/app/api/routes.py`:
  - `import re` added; `MONTH_RE = re.compile(r"^\d{4}-\d{2}$")` module-level constant.
  - `list_transactions()` gained `category`/`month` optional params, a 400 on malformed
    `month`, and parameterized `AND`-joined clause building in place of the old
    single-`if status`/`else` branch.
  - No other endpoint touched.

No changes to `db.py`, `frontend/`, rules, merchant grouping, or the `balance_entries`
schema — scope was `export.py` / `insights.py` / `routes.py` only, confirmed by `git status`
before writing this doc.

**Deviation from the plan / thing found along the way:** the exact stale-`--reload`-worker
issue 004 and 005 both hit recurred here too, third session in a row. Before any edits the
server was up and answering `GET / -> 200`; after implementing both parts, `/openapi.json`
still showed only `["status"]` as the `/api/transactions` query params (the old shape) —
confirmed via `wmic process where "name='python.exe'" get ProcessId,ParentProcessId,
CommandLine` that the `--reload` watcher (venv Python on its own command line) had again
spawned a worker running a *different* interpreter
(`C:\Users\nano_\AppData\Local\Programs\Python\Python39\python.exe`), serving stale
pre-edit code. Killed the whole process tree with `taskkill //F //T //PID <watcher-pid>`
(note: this shell needs `//F //T` with doubled slashes, not `/F /T`, which Git Bash mangles
into a path), confirmed zero `python.exe` processes remained, and restarted one clean
instance per the runbook's documented command. After restart, `/openapi.json` showed
`["status", "category", "month"]` for `/api/transactions` and the new `balance-trend` route
was live — confirmed before any further testing, per the runbook's explicit warning about
this exact failure mode. Did not touch `data/finance.db` or any data.

## Verification evidence

All against the live server at `http://127.0.0.1:8000`, `data/finance.db` (the real
database) — no mutations at any point, both endpoints are GET-only.

**Baseline, before touching anything (confirmed identical to 005's documented end state):**

```
$ curl -s http://127.0.0.1:8000/api/rules | python -c "...len..."
108
$ curl -s "http://127.0.0.1:8000/api/transactions?status=needs_review" | python -c "...len..."
315
$ curl -s http://127.0.0.1:8000/api/balance-entries
[]
$ curl -s "http://127.0.0.1:8000/api/transactions" | python -c "...len..."
1020
```

**Routes registered after the stale-reload restart** (`/openapi.json`):

```
$ ... print([p for p in spec['paths'] if 'insights' in p or p == '/api/transactions'])
['/api/transactions', '/api/insights/category-monthly', '/api/insights/balance-trend', '/api/insights/reconciliation']
$ ... print(['status', 'category', 'month'])   # /api/transactions GET parameters
['status', 'category', 'month']
```

**Balance trend — all 6 accounts, correct `kind` per account:**

```
$ curl -s http://127.0.0.1:8000/api/insights/balance-trend | python -c "..."
top-level keys: ['series', 'aggregated', 'entries']
num series: 6
  'BoA Checking'            kind=native   n_points=488
  'BoA Credit Card'         kind=derived  n_points=228
  'Fidelity Credit Card'    kind=derived  n_points=48
  'Fidelity Savings'        kind=native   n_points=68
  'HSA'                     kind=derived  n_points=23
  '401k'                    kind=derived  n_points=165
aggregated points: 275
entries: []
```

`kind` matches exactly `has_running_balance` from `SOURCES` (native only for BoA Checking,
Fidelity Savings). `entries: []` matches 005's documented clean end state (0 live
`balance_entries` rows).

**Native points unchanged — re-derived the pre-existing flat logic directly and diffed
against the new API output for BoA Checking:**

```
old-style (direct call to the pre-existing filter/sort, run standalone):
  first 3: [{'date': '2025-01-13', 'balance_after': 200.0}, {'date': '2025-01-15', 'balance_after': 4065.54}, {'date': '2025-01-16', 'balance_after': 3860.0}]
  last 3:  [{'date': '2025-12-31', 'balance_after': 2253.45}, {'date': '2025-12-31', 'balance_after': 1942.45}, {'date': '2025-12-31', 'balance_after': 2550.41}]
API BoA Checking first 3: [{'date': '2025-01-13', 'balance': 200.0}, {'date': '2025-01-15', 'balance': 4065.54}, {'date': '2025-01-16', 'balance': 3860.0}]
API BoA Checking last 3:  [{'date': '2025-12-31', 'balance': 2253.45}, {'date': '2025-12-31', 'balance': 1942.45}, {'date': '2025-12-31', 'balance': 2550.41}]
```

Identical, including the same-day-tie order at year end — confirms the native path is a pure
repackaging, not a recomputation.

**Derived points — hand-computed cumulative sum for HSA (23 transactions, smallest derived
account) against direct SQL, compared to the API:**

```
$ sqlite3 direct query, hand cumsum:
  date=2025-12-01 amount=183.0   running=183.0
  date=2025-12-16 amount=183.0   running=366.0
  date=2025-12-31 amount=0.01    running=366.01
  date=2026-01-02 amount=183.0   running=549.01
  date=2026-01-16 amount=183.0   running=732.01
  ...
  final running total (hand): 2436.27

API HSA first 5: [{'date': '2025-12-01', 'balance': 183.0}, {'date': '2025-12-16', 'balance': 366.0},
                   {'date': '2025-12-31', 'balance': 366.01}, {'date': '2026-01-02', 'balance': 549.01},
                   {'date': '2026-01-16', 'balance': 732.01}]
API HSA last point: {'date': '2026-07-01', 'balance': 2436.27}
```

Exact match, hand computation to API.

**Aggregated — verified two ways.** First, the earliest date sanity check (no artificial
dip from unstarted accounts):

```
aggregated first point: {'date': '2025-01-13', 'balance': 200.0}
BoA Checking earliest date: 2025-01-13   (all other 5 accounts start later, ranging June 2025 - March 2026)
```

200.0 exactly matches BoA Checking's own first balance — confirms the other 5 accounts (no
data yet on that date) contributed nothing, not a phantom 0.

Second, an independent forward-fill re-derivation in Python (walking each account's own
`points` list directly from the API response, taking the last point `<= target_date` per
account, summing only accounts with a non-`None` result) against a mid-series date where 3 of
6 accounts have started:

```
target date: 2025-03-13
included accounts (hand re-derivation): [('BoA Checking', 2932.67), ('Fidelity Savings', 4000.0), ('401k', 500.0)]
expected sum (hand): 7432.67
API aggregated value: 7432.67
```

Exact match, including correct exclusion of BoA Credit Card / Fidelity Credit Card / HSA
(none had started by 2025-03-13).

**Transactions drill-down filters** — picked a real category/month cell from
`GET /api/insights/category-monthly` (`2025-01` → `Eat Out`: −111.84) and confirmed the new
filter's row set sums to the same value:

```
$ curl -s "http://127.0.0.1:8000/api/transactions?category=Eat+Out&month=2025-01"
count: 5
sum amount: -111.83999999999999   # float-sum noise, matches -111.84 exactly to the cent
dates: ['2025-01-21', '2025-01-22', '2025-01-27', '2025-01-27', '2025-01-30']
```

Malformed `month` rejected:

```
$ curl -s -o ... -w "http_code=%{http_code}\n" "http://127.0.0.1:8000/api/transactions?month=notamonth"
http_code=400
{"detail":"month must be YYYY-MM, got: 'notamonth'"}
$ curl -s -o /dev/null -w "http_code=%{http_code}\n" "http://127.0.0.1:8000/api/transactions?month=2025-1"
http_code=400
```

Combined `status`+`category`+`month`:

```
$ curl -s "http://127.0.0.1:8000/api/transactions?status=classified&category=Eat+Out&month=2025-01" -> count: 5
$ curl -s "http://127.0.0.1:8000/api/transactions?status=needs_review&category=Eat+Out&month=2025-01" -> count: 0
```

(All 5 January `Eat Out` transactions are already `classified`, so the `needs_review`
combination correctly returns 0, not an error — confirms `AND` semantics across all three
filters simultaneously, not just pairwise.)

**Timing** (no new index, per instruction — confirming the unindexed scan is still fast
enough at current row counts):

```
$ curl -s -o /dev/null -w "time_total=%{time_total}s\n" http://127.0.0.1:8000/api/insights/balance-trend
time_total=0.056856s   (57,399 bytes)
$ curl -s -o /dev/null -w "time_total=%{time_total}s\n" "http://127.0.0.1:8000/api/transactions?status=classified&category=Eat+Out&month=2025-01"
time_total=0.008152s
$ curl -s -o /dev/null -w "time_total=%{time_total}s\n" "http://127.0.0.1:8000/api/transactions"
time_total=0.107342s   (unfiltered, 1020 rows — for comparison)
```

**Final re-check — nothing this session was scoped to leave untouched drifted:**

```
rules: 108
needs_review: 315
transactions (total): 1020
balance_entries: 0
```

Identical to the baseline captured before any edits — every request made during this
session's verification was a `GET`.

**What was NOT tested:** the frontend (out of scope — session 7). Whether `sources.account`
can ever diverge from `sources.label` (they're identical for all 6 rows in `SOURCES` today,
`db.py`) — untested because there's no live case where they differ; flagged in the handoff
below since the frontend needs to know which field it's matching against. Behaviour under
zero transactions for an account that exists in `sources` but has never had a transaction
inserted — code-reviewed (an account with `account_flags[account] = True/False` but no
matching rows in `df` naturally produces `points: []`, no error) but not exercised against
live data, since all 6 accounts in `data/finance.db` currently have at least one transaction.

## Handoff to fintech-frontend (Session 7, partially unblocked by Session 6)

- **`series[].account` is the transactions/sources `account` field, not the source `key`.**
  `GET /api/sources` returns `{key, label, account, has_running_balance}` per source; today
  `account` and `label` are identical strings for all 6 sources (`"BoA Checking"`, `"BoA
  Credit Card"`, `"Fidelity Credit Card"`, `"Fidelity Savings"`, `"HSA"`, `"401k"` —
  `key` is the separate lowercase-underscore form, e.g. `"boa_checking"`). Match
  `series[].account`, `aggregated` (which has no account field — it's already summed), and
  `entries[].account` all against `GET /api/sources`' `account` field, **not** `key`. Since
  `account === label` for every row today, matching against `label` would also happen to
  work right now, but `account` is the actually-correct field per this session's convention
  (it's literally what `transactions.account` and `balance_entries.account` store) — don't
  build against `label` and rely on the coincidence.
- **`series` order is `sources`' own row order** (insertion order = the `SOURCES` list order
  in `db.py`: BoA Checking, BoA Credit Card, Fidelity Credit Card, Fidelity Savings, HSA,
  401k). Not alphabetical, not by data volume.
- **`kind: "derived"` values are relative running totals starting at 0, not absolute
  balances.** If the chart draws native and derived lines the same way, it will visually
  imply "the credit card started the year at $0," which is false — it started at whatever
  its real balance was before the earliest transaction in this DB, which is unknown. Style
  derived lines distinctly (dashed, muted, an axis caveat — your call) rather than letting
  them look like a literal balance.
- **`aggregated` is a single combined line, already summed** — no per-account breakdown in
  that array; if you want to show "which accounts contributed" at a given point, look them
  up in `series` by date instead.
- **`entries[].account` has no guaranteed match in `series`.** 005 never added account-name
  validation to `POST /api/balance-entries` — a typo'd or freeform account string is stored
  as-is. If an entry's `account` doesn't match any `series[].account` when you go to plot it
  as a marker, that's a real possible state, not a bug in this response; decide how to
  surface it (skip silently vs. a small "unmatched entry" note) rather than assuming it can't
  happen.
- **`entries[].balance`** is the renamed `recorded_balance` from `load_balance_entries` /
  005's reconciliation endpoint — same underlying value, different key name in this
  response only. `GET /api/insights/reconciliation` (005, unchanged) still uses
  `recorded_balance` — don't expect the two endpoints to use the same key for the same
  underlying number.
- **New `/api/transactions` filters are combinable and AND together**: `status`, `category`,
  `month` (any subset, any combination). `month` must be exactly `YYYY-MM` or the request
  gets a `400` with a `{"detail": "..."}` body — surface that rather than assuming a bad
  value silently matches nothing. Good use for an Insights-cell drill-down link: build the
  URL as `/api/transactions?category=<cell.category>&month=<cell.month>` directly off a
  `category-monthly` row.
- Both endpoints remain **GET-only, no auth, no pagination** — `balance-trend` returns
  everything (all points for all 6 accounts) in one response every time; at current data
  volume (~1,020 transactions total) this was 57KB / ~57ms, not something session 7 needs to
  paginate around yet, but flagging in case the dataset grows substantially before this is
  revisited.
