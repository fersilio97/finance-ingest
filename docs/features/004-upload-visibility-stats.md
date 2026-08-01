# 004 — Upload visibility: what did I just upload, and what's stale
Status: Shipped (backend only)
Iteration: 2

## Problem

`save_upload()` (`backend/app/pipeline/ingest.py:11-16`) writes an uploaded file straight
to `data/incoming/<source>/<filename>` and returns. No DB row, no metadata is ever
persisted about an upload — not the filename, not when it landed, not how many rows or
what date range it covers. The Upload section of the UI therefore cannot show which files
are sitting in `incoming/` waiting for the next `Run Pipeline`, cannot show per-file or
aggregate stats (row count, date range), and cannot flag "you haven't uploaded anything
covering the last N days" — because none of that data exists anywhere.

## User story & spec (as given)

> As the person doing the monthly import, I want the Upload section to show me which files
> I've uploaded, how many rows and what date range they cover (individually and combined
> across multiple files for the same source), and whether there's a gap between the latest
> data I have and today — so I know what's about to happen before I hit Run Pipeline, and
> whether I'm missing something.

This session is backend-only. The frontend that consumes it is a separate, later session,
blocked on this one landing.

## Architecture

**Data model — one new, additive table.** `uploads` (schema below) is a new table added to
`SCHEMA` in `backend/app/db.py`. It is genuinely new, not a column on an existing table, so
`CREATE TABLE IF NOT EXISTS` — already idempotent for every other table in this file — is
sufficient; no `_ensure_column()` migration path is needed because there's no existing
table shape to retrofit. `init_db()` runs `conn.executescript(SCHEMA)` unconditionally on
every startup, so the table appears on next boot with zero manual steps and zero risk to
`data/finance.db`'s existing rows.

```sql
CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_count INTEGER,
    date_start TEXT,
    date_end TEXT,
    processed_at TEXT
);
```

`row_count`/`date_start`/`date_end` are nullable because the stats pass that fills them is
explicitly allowed to fail without blocking the upload (see below) — a NULL here means
"stats unknown," not "zero rows." `processed_at` is nullable and starts NULL; it is set the
next time `/api/trigger` runs `normalize_all()`. This table is metadata *about* uploads,
not a duplicate of `transactions` or `batches` — it never gets joined into dedupe or
enrichment logic, and nothing in the existing pipeline reads it. It's additive in the
architectural-commitment sense (new table, existing tables untouched) and also additive in
the "doesn't change existing behaviour" sense: `save_upload()` itself is unchanged, and
`normalize_all()` is unchanged.

**Why a stats pass at upload time, calling the real parser, instead of a separate
lightweight sniff.** The alternative — peeking at the CSV with `csv.reader` to count rows
without depending on `parsers/` — would need to reinvent per-source column names, date
formats and the "real transaction table starts at row 7" skip logic that already lives in
each parser (see `boa_checking.py`'s `skiprows=6`). That duplication would drift the moment
a parser changes. Calling `PARSERS[source](path, account=...)` — the exact call shape
`normalize.py` uses — costs one extra parse per uploaded file (all files here are small
CSVs, sub-second) and guarantees the stats shown always match what a subsequent `Run
Pipeline` will actually ingest. Parsers are pure functions over a file path with no DB
access (confirmed by reading all six), so this is genuinely side-effect-free: it can't
double-insert transactions or double-stamp a batch.

**Failure isolation.** The parse call is wrapped in `try/except Exception: pass`, per the
spec's requirement that a stats-computation failure must never block the actual upload —
the file is already saved to disk by the time the parse is attempted, and the `uploads` row
is inserted either way, just with NULL stats on failure. Verified live (see Implementation
notes) with a CSV whose columns don't match the HSA parser's expectations.

**API — one extended endpoint, one new one.**

- `POST /api/upload/{source}` (existing) now opens one `get_conn()` for the whole file
  loop and inserts one `uploads` row per uploaded file, after `save_upload()` and the stats
  pass. Response shape (`{"saved": [...]}`) is unchanged — this is additive to the side
  effects, not the contract, so it can't break whatever the frontend already does with the
  existing response.
- `GET /api/uploads` (new) returns one entry per row in the `sources` table (so a source
  with zero uploads or zero ingested transactions still appears — the frontend shouldn't
  have to special-case "never touched this source"). Per source:
  - `pending_files`: `uploads` rows for that source where `processed_at IS NULL`.
  - `pending_aggregate`: file count, summed row_count, min/max date across those pending
    files, computed in Python over the (small) `pending_files` list rather than a second
    SQL aggregate query — simpler and avoids a second round trip through SQLite for what's
    at most a handful of rows per source.
  - `ingested_coverage`: `MIN(date)`/`MAX(date)` from `transactions WHERE source = ?` — the
    *already-ingested* picture, independent of anything pending.
  - `days_since_latest_covered`: today (`date.today()`) minus the later of
    `ingested_coverage.date_end` and `pending_aggregate.date_end`, as a raw integer, or
    `null` if there's no date data at all for that source. Deliberately no "this is
    concerning" threshold or copy here — that's a frontend/UX decision for the later
    session, and baking a threshold into the API would make it a business-logic choke
    point the frontend can't adjust without a backend redeploy.
- `POST /api/trigger` (existing) gains one statement, immediately after `normalize_all()`
  and before `enrich_all()`: `UPDATE uploads SET processed_at = datetime('now') WHERE
  processed_at IS NULL`. This mirrors `normalize_all()`'s own granularity — it already
  processes every source's incoming files unconditionally in a single pass, not per-source
  — so stamping every currently-pending upload in one shot matches that, rather than trying
  to correlate individual `uploads` rows to individual per-file outcomes inside
  `normalize_all()` (which returns per-*source* counts, not per-*file* counts, so that
  correlation isn't available without changing `normalize_all()`'s return shape — out of
  scope and unnecessary for what this feature needs).

**Risks / trade-offs, stated up front:**

- *Double-parse cost.* Every uploaded file is now parsed twice — once for stats at upload
  time, once for real inside `normalize_all()` at trigger time. For this app's data volumes
  (small personal-finance CSVs, a handful of files a month) this is negligible; flagging it
  so it isn't silently forgotten if a future source ever gets a multi-MB export.
- *`uploads` and `transactions.source` can drift in what counts as "the same file."* If a
  user re-uploads an identical file (same content, same or different filename),
  `save_upload()` overwrites the same path when the filename matches (a no-op re-upload
  today) or creates a second file with pandas/OS-level de-dup only kicking in at the
  `transactions.external_id UNIQUE` layer on ingest. Each `POST /api/upload/{source}` call
  always inserts a fresh `uploads` row per file in the request, even for a file that will
  turn out to be 100% duplicate rows once actually normalized (`inserted: 0` in
  `normalize_all()`'s summary). This is intentional — "you uploaded a file" and "that file
  added new data" are different facts, and conflating them would make `pending_aggregate`
  lie about what's about to be triggered. The frontend session should be aware
  `pending_aggregate.row_count` is *parsed* rows, not *net-new* rows.
- *No delete endpoint for `uploads` rows.* Not requested by this session's spec. Cleanup
  during my own verification testing was done directly via `sqlite3`, which is fine for a
  one-off dev/test row but means there's currently no in-app way to remove a mistaken
  upload's metadata row (the underlying file in `data/incoming/` also has no delete path
  today). Worth flagging as a likely near-term ask once the frontend ships this, but out of
  scope here.
- *`days_since_latest_covered` uses wall-clock `date.today()`, not a value the caller can
  override.* Fine for a single-user, single-timezone, self-hosted deployment (this app's
  entire target), called out in case that assumption is ever revisited.

## Implementation notes

Files changed:

- `backend/app/db.py` — added the `uploads` table to `SCHEMA` (no other table touched).
- `backend/app/api/routes.py`:
  - imports: added `from datetime import date`, `from ..parsers import PARSERS`, and
    `ACCOUNTS` from `..pipeline.normalize` (reusing the exact `{source: account}` mapping
    `normalize_all()` already uses).
  - `POST /api/upload/{source}` — wrapped the existing save loop in one `get_conn()`, added
    the try/except stats pass and the `INSERT INTO uploads` per file.
  - new `GET /api/uploads`.
  - `POST /api/trigger` — added the one-line `UPDATE uploads SET processed_at = ...`
    between `normalize_all()` and `enrich_all()`.

No other files were touched. `manual_balances`, `transactions`, `rules`, `batches` schemas
and every existing endpoint are unchanged.

**Deviation from the plan / thing I found along the way:** the dev server's `--reload`
watcher had stopped detecting file changes partway through this session (the exact
stale-process gotcha the runbook warns about) — a prior reload cycle had left an orphaned
worker process (PID 18360, child of an already-dead PID 24376) still bound to port 8000
alongside the live reloader tree, and separately the live reloader's own worker had simply
stopped restarting on file writes. Neither issue touched `data/finance.db`. I killed the
orphan, confirmed the "real" tree's worker process StartTime hadn't advanced past its
original launch despite edits made afterward, then killed and cleanly restarted the whole
dev server tree per the documented `docs/DEV-RUNBOOK.md` command. After the restart, both
routes appeared in `/openapi.json` and behaved correctly. This did not require touching the
DB or any data.

## Verification evidence

All against the live server at `http://127.0.0.1:8000`, `data/finance.db` (the real
database — no temp DB used, since this only reads/writes the new empty `uploads` table and
the pre-existing `data/incoming/hsa/` directory for the throwaway test file, both cleaned up
afterward).

**Before touching anything:**
```
$ curl -s http://127.0.0.1:8000/api/rules | python -c "...len..."
108
$ curl -s "http://127.0.0.1:8000/api/transactions?status=needs_review" | python -c "...len..."
315
```

**Routes registered** (`/openapi.json`):
```
$ curl -s http://127.0.0.1:8000/openapi.json | python -c "...paths with 'upload'..."
['/api/upload/{source}', '/api/uploads']
```

**`GET /api/uploads` before any test upload** — one entry per source, all six present, real
`ingested_coverage` from the live `transactions` table, `days_since_latest_covered` computed
against 2026-08-01:
```json
{"source":"boa_checking","label":"BoA Checking","pending_files":[],
 "pending_aggregate":{"file_count":0,"row_count":null,"date_start":null,"date_end":null},
 "ingested_coverage":{"date_start":"2025-01-13","date_end":"2025-12-31"},
 "days_since_latest_covered":213}
```
(and similarly for the other five sources — boa_credit_card: 232, fidelity_credit_card: 23,
fidelity_savings: 213, hsa: 31, k401: 222 — all matching `today − max(ingested end date)`.)

**Upload with real stats:** uploaded a 2-row throwaway HSA CSV.
```
$ curl -s -F "files=@...\test_hsa_upload.csv" http://127.0.0.1:8000/api/upload/hsa
{"saved":["...\\data\\incoming\\hsa\\test_hsa_upload.csv"]}
```
Resulting `uploads` row (read directly via sqlite3):
```
{'id': 1, 'source': 'hsa', 'filename': 'test_hsa_upload.csv', 'row_count': 2,
 'date_start': '2026-07-10', 'date_end': '2026-07-12', 'processed_at': None}
```
`GET /api/uploads` for `hsa` reflected it as pending:
```json
{"pending_files":[{"id":1,"filename":"test_hsa_upload.csv","row_count":2,
  "date_start":"2026-07-10","date_end":"2026-07-12", ...}],
 "pending_aggregate":{"file_count":1,"row_count":2,"date_start":"2026-07-10","date_end":"2026-07-12"},
 "ingested_coverage":{"date_start":"2025-12-01","date_end":"2026-07-01"},
 "days_since_latest_covered":20}
```
(20 = 2026-08-01 minus 2026-07-12, the later of the two date_ends — correct.)

**Failure isolation:** uploaded a CSV with the wrong columns for the HSA parser.
```
$ curl -s -F "files=@...\bad_hsa_upload.csv" http://127.0.0.1:8000/api/upload/hsa
{"saved":["...\\data\\incoming\\hsa\\bad_hsa_upload.csv"]}
```
The upload succeeded (not blocked); the resulting row has NULL stats:
```
{'id': 2, 'source': 'hsa', 'filename': 'bad_hsa_upload.csv', 'row_count': None,
 'date_start': None, 'date_end': None, 'processed_at': None}
```

**`processed_at` stamping logic** — verified by direct SQL (not the `/api/trigger`
endpoint, per instructions, to avoid actually ingesting the throwaway file into
`transactions`): inserted a synthetic pending `uploads` row, ran the exact `UPDATE uploads
SET processed_at = datetime('now') WHERE processed_at IS NULL` statement used in
`routes.py`, confirmed all three then-NULL rows (including the two real test uploads above)
got stamped in one shot:
```
before: [{'id': 1, 'processed_at': None}, {'id': 2, 'processed_at': None}, {'id': 3, 'processed_at': None}]
after:  [{'id': 1, 'processed_at': '2026-08-01 14:05:20'}, {'id': 2, '...'}, {'id': 3, '...'}]
```
`GET /api/uploads` for `hsa` afterward correctly showed zero pending files.

**Cleanup:** deleted all three test `uploads` rows via `sqlite3`, deleted both test files
from `data/incoming/hsa/` (confirmed only the pre-existing real `Transactions-Export.csv`
remains).

**After — confirming nothing drifted:**
```
$ curl -s http://127.0.0.1:8000/api/rules | python -c "...len..."
108
$ curl -s "http://127.0.0.1:8000/api/transactions?status=needs_review" | python -c "...len..."
315
$ curl -s "http://127.0.0.1:8000/api/transactions" | python -c "...len..."
1020
$ curl -s http://127.0.0.1:8000/api/uploads | python -c "...sum of pending_files across all sources..."
0
```
Rules (108), needs_review (315) and total transactions (1020) are exactly what they were
before this session started; `uploads` is empty again.

**What was NOT tested:** an actual `POST /api/trigger` run through the real endpoint (the
task explicitly says not to, to avoid ingesting throwaway data into `transactions`) — the
`processed_at` UPDATE statement was verified directly via SQL instead, which exercises the
same WHERE-clause logic but not the endpoint wiring around it (a two-line addition, low
risk). Also not tested: a source with `pending_files` containing more than one file (to
exercise the multi-file `pending_aggregate` summation path) — only single-file uploads were
exercised live; the summation logic was code-reviewed but not driven with a two-file
request.

## Handoff to fintech-frontend

**`GET /api/uploads`** — no query params, no auth. Returns a JSON array, one object per
source (always all sources from `GET /api/sources`, even ones with zero activity):

```json
[
  {
    "source": "boa_checking",
    "label": "BoA Checking",
    "pending_files": [
      {"id": 1, "filename": "...", "uploaded_at": "2026-08-01 14:04:52",
       "row_count": 42, "date_start": "2026-07-01", "date_end": "2026-07-15"}
    ],
    "pending_aggregate": {"file_count": 1, "row_count": 42, "date_start": "2026-07-01", "date_end": "2026-07-15"},
    "ingested_coverage": {"date_start": "2025-01-13", "date_end": "2025-12-31"},
    "days_since_latest_covered": 213
  }
]
```

Notes for the frontend build:
- Any of `row_count`/`date_start`/`date_end`/`days_since_latest_covered` can be `null` —
  render "unknown"/"—", not "0" or a crash. `file_count` is always a real integer (0 when
  no pending files), never null.
- `pending_aggregate.row_count` is *parsed* rows from the file, not guaranteed *net-new*
  rows — a re-upload of an already-ingested file will show a non-zero `row_count` here even
  though triggering will insert 0 new transactions. Don't imply "N new transactions" from
  this number; "N rows in the file(s) waiting to be processed" is the accurate framing.
- `days_since_latest_covered` is a raw integer or null — this endpoint deliberately makes no
  judgment about what's "stale." That threshold/copy decision belongs to this feature's
  frontend session.
- `POST /api/upload/{source}` response shape is unchanged (`{"saved": [...]}"`) — the new
  `uploads` row is a side effect, not something returned inline from the upload call itself.
  Call `GET /api/uploads` after an upload (or after `POST /api/trigger`) to see the current
  state, the same way the review queue re-fetches after a mutation.
- There is currently no `DELETE` for an `uploads` row — not in scope for this session.
