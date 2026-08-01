# 007 — Upload visibility and pipeline clarity (frontend)
Status: Shipped
Iteration: 2, Session 5

## Problem

Two pieces of user feedback, both frontend-only, both about the moment right before
"Run Pipeline" gets clicked — the moment the user most needs to know what's about to
happen.

**Upload visibility.** Each source's drop zone (`frontend/index.html`'s `#drop-zones`,
built by `renderDropZones()` in `frontend/app.js`) only ever showed `zoneFiles` — an
in-memory list of files uploaded *this browser session*, wiped on reload. No filenames
survived a refresh, no stats (row count, date range), no sense of whether a source was
falling behind. Feature 004 (backend, Session 1) shipped the `uploads` table and
`GET /api/uploads` to make this possible; this session is the frontend that consumes it.

**Pipeline clarity.** `#trigger-btn`'s click handler dumped the raw `POST /api/trigger`
response straight into `#trigger-summary` via `JSON.stringify(result, null, 2)`, and gave
no indication before the click of whether there was anything to do.

## Spec / behavior built

Per the task brief (no separate UX-lead spec doc for this session — the brief served as
the spec, sourced from 004's "Handoff to fintech-frontend" section):

**Per drop zone**, below the existing session-only file-list:
- Pending (not-yet-processed) files for that source, each showing filename (truncated
  with `title` holding the full name), row count, and date range — sourced from
  `pending_files` in the `GET /api/uploads` response for that source.
- An aggregated "Waiting to process" line when `pending_files.length > 0`: file count,
  summed row count, combined date range.
- An "Up to date through `<date>`" line, using whichever is later between
  `ingested_coverage.date_end` and `pending_aggregate.date_end`, with a
  "(includes a pending file)" note when the pending side is the one that's newer.
- A gap-to-today advisory when `days_since_latest_covered` exceeds a threshold (see
  "Judgment call: gap threshold" below).
- A real empty state — "Nothing uploaded yet — drop a CSV above to get started." — when
  a source has zero pending files *and* zero ingested coverage (both `ingested_coverage`
  dates null). Not treated as an error.
- A real error state — "Couldn't load upload history for this source." in `--negative` —
  when `GET /api/uploads` itself fails, applied per zone since the whole drop-zones grid
  shares one failed fetch.

**Pipeline tile**, before the Run Pipeline button:
- A pending-work summary line, e.g. *"3 files ready to process across 2 sources."* or, at
  rest, *"Nothing waiting — every uploaded file has already been processed."* — also
  sourced from `GET /api/uploads`, computed as the sum of `pending_aggregate.file_count`
  across all sources and the count of sources with at least one pending file.
- After a run, the raw JSON dump is replaced with 1-2 humanized sentences built from the
  existing `POST /api/trigger` response (`normalize`, `enrich`, `export` — unchanged
  contract, just rendered better). Three cases: nothing was parsed at all, files were
  parsed but everything was already in the database (0 inserted — a real, distinguishable
  case per 004's handoff note that `row_count` is parsed rows, not net-new rows), or N new
  transactions were imported. Every case appends how many transactions got auto-classified
  vs. still need review this run.
- `GET /api/uploads` is re-fetched after a successful trigger (alongside the existing
  `loadReview()`/`loadRules()`/`loadBalances()` refresh), which is also the mechanism that
  confirms `processed_at` stamping (shipped in Session 1) works end-to-end: a source with
  pending files before the run should show zero after, live, without a page reload. Verified
  directly (see Verification evidence).

## Implementation notes

**Files changed:**
- `frontend/index.html` — added `#pending-summary` (skeleton-loaded status line) before
  `#trigger-btn`; changed the Manual EOM Balances table header from "Month" to "Recorded
  at" and added `#balance-error` (see "Incidental fix" below).
- `frontend/app.js`:
  - New module-level state: `UPLOADS` (line 54, `null` until first successful
    `GET /api/uploads`) and the `GAP_WARNING_DAYS` constant (line 63).
  - `renderDropZones()` (line 92) — added a `.zone-uploads` container per zone, seeded
    with a skeleton, populated later by `renderZoneUploads()`.
  - `uploadFiles()` (line 155) — now calls `loadUploads()` after every upload attempt
    (success or failure), so the persisted pending-file list updates immediately rather
    than waiting for the next full page load.
  - New functions (lines 178-303): `laterDate()`, `formatDateRange()`, `loadUploads()`,
    `renderPendingSummary()`, `renderAllZoneUploads()`, `renderZoneUploads()`.
  - `buildTriggerSummaryText()` (line 305) — pure function, `{normalize, enrich, export}`
    in, sentence out; kept separate from the click handler so it could be reasoned about
    (and could be unit-tested later) independent of DOM/fetch concerns.
  - Trigger click handler (~line 332) — calls `buildTriggerSummaryText()` instead of
    `JSON.stringify`, adds `loadUploads()` to the post-run refresh `Promise.all`, and adds
    an `is-error` class toggle for visible failure styling (previously the failure text
    used the same neutral styling as success).
  - `init()` — `loadUploads()` added to the second `Promise.all`, ordered after the first
    (`loadSources()`, which builds the drop zones `loadUploads()` needs to render into).
- `frontend/styles.css` — new rules for `.zone-uploads`, `.zone-uploads-empty`,
  `.zone-uploads-error`, `.upload-record-list`, `.upload-record`, `.upload-name`,
  `.upload-meta`, `.zone-coverage` (+ `.muted` modifier), `.zone-gap-warning`, and
  `.status-line.is-error`. All colors reference existing custom properties
  (`--text`, `--text-muted`, `--negative`, `--accent`, `--accent-soft`, `--border`) —
  no hardcoded colors introduced.

**Judgment call: gap threshold and copy.** The backend deliberately returns a raw
`days_since_latest_covered` integer with no built-in judgment (004's handoff note). Chose
**45 days** as the flag threshold, checked against the live data actually returned by
`GET /api/uploads` on 2026-08-01: Fidelity Credit Card (23 days) and HSA (31 days) are the
two sources imported somewhat regularly, both comfortably under 45; the other four
sources (BoA Checking 213, BoA Credit Card 232, Fidelity Savings 213, 401k 222) are all
genuinely stale by any reasonable reading. 45 days gives roughly "one calendar month of
statement coverage plus a couple of weeks' normal grace before getting around to
importing it" — under that, silence is expected and unremarkable; over it, something was
probably missed. Copy: *"`<N>` days since the last covered date (`<date>`) — probably
worth a fresh export."* Deliberately phrased as a suggestion, not an alarm — see the next
judgment call for why it isn't styled as one either.

**Judgment call: gap-warning visual treatment.** Initially reached for `--negative` (red)
for the gap warning, then reconsidered against spec 003's own precedent in this same
codebase: 003 explicitly reserves red for *"the only state permitted to use a
negative/red color"* (a confirmed, quantified reconciliation mismatch) and treats
"unverified/unknown" as neutral, never alarming. A stale import is closer to "worth
noticing" than "confirmed wrong" — the user might genuinely have nothing new for that
account. Used the same visual language as `.warning-item` (the rule-conflict advisory
introduced in 001): `--accent` left border, `--accent-soft` background, plain `--text`
copy. This keeps red meaningful and rare across the whole app rather than diluting it.

**Judgment call: pending-summary and trigger-summary copy.** "N files ready to process
across M sources" over alternatives like "N files pending" because "ready to process" is
what the button below it is about to do — the summary and the button read as one unit.
For the post-run summary, explicitly wrote "across the full queue" into the
classified/still-need-review sentence (see the code comment at `app.js:305-311`) because
`enrich_all()` re-sweeps every `needs_review` row on every trigger, not just the rows a
given run just inserted — the numbers are queue-wide outcomes, not scoped to "this
import," and the copy says so rather than implying a tighter scope the API doesn't
actually provide.

**Incidental fix, out of this session's spec — found during verification.** Before
touching anything, `node scripts/ui-check.mjs --page index` was run as a baseline and
failed: 12 problems, all variants of a 404 on `GET /api/manual-balances` and an uncaught
JS error. Feature 005 (Session 2, backend) had already removed
`GET/POST /api/manual-balances` and `DELETE /api/manual-balances/{id}` in favor of
`GET/POST /api/balance-entries` — a change explicitly scoped to be picked up by the
frontend in *Session 6*, per 005's own handoff note. Left as-is, this bug meant: (a) the
Manual EOM Balances panel threw on every single page load of `index.html`, the exact file
this session owns, and (b) the resulting unhandled rejection in `init()`'s `Promise.all`
meant `prefillBalanceFormFromQuery()` (the Insights-panel remedy-link handler from spec
003) silently never ran. Both are real, live regressions in a file this session is
already editing, not hypothetical. Made the minimal patch to stop the bleeding without
doing Session 6's job: `loadBalances()` now calls `/api/balance-entries` and maps
`account`/`recorded_at`/`balance` into the same table shape; the form's `POST` now
targets `/api/balance-entries` with `month` converted to `${month}-01T00:00:00` (the exact
convention 005's own `manual_balances → balance_entries` migration used); added
`#balance-error` for visible failure (previously: none at all, a silent no-op on submit
failure). Explicitly **not** built: a `datetime-local` input, an account dropdown
constrained to `GET /api/sources`, or per-entry delete — all called out as Session 6's
job in 005's handoff, and out of scope here. Confirmed via
`git log`/re-reading 005's doc that this actually is a different session's assigned
scope before touching it, so as not to duplicate or conflict with Session 6's work.

**What was explicitly not touched, and why:** `frontend/insights.html`/`insights.js` are
also currently broken against the live backend (`insights.js` still calls the removed
`/api/calculator`/`/api/insights/calculator`, now `/api/insights/reconciliation` per 005) —
confirmed by reading, not fixed. This is Session 6's explicit scope per the task boundary
("do not touch insights.html/insights.js — other sessions own those"), unlike the
index.html balances panel above, which is a file this session already owns and edits.

## Verification evidence

All against the live server at `http://127.0.0.1:8000`, `data/finance.db` (the real
database).

**Baseline, before any change:**
```
$ curl -s http://127.0.0.1:8000/api/rules | python -c "...len..."
108
$ curl -s "http://127.0.0.1:8000/api/transactions?status=needs_review" | python -c "...len..."
315
$ node scripts/ui-check.mjs --page index
12 problem(s) — all 404 on /api/manual-balances + uncaught JS error, in every
viewport/theme combination (pre-existing, from feature 005, Session 2 — not caused by
this session).
```

**API contract confirmed live** (rather than trusted from the doc, per the runbook):
`curl -s http://127.0.0.1:8000/api/uploads` returned the exact shape 004's handoff
section documents — `pending_files`, `pending_aggregate`, `ingested_coverage`,
`days_since_latest_covered` — for all 6 sources, all with 0 pending files and real
`ingested_coverage`/`days_since_latest_covered` values at session start (23-232 days
across sources, matching 004's own verification numbers exactly).

**After implementation, clean run:**
```
$ node --input-type=module --check < frontend/app.js
(exit 0 — syntax clean)
$ node scripts/ui-check.mjs --page index
✓ No console errors, failed requests, or horizontal overflow.
  index · desktop: 6900px (6.9x viewport), 4764 DOM nodes
  index · narrow:  7918px (8.8x viewport), 4764 DOM nodes
```
(DOM node count is essentially unchanged from before this session's work — the added
zone-uploads markup is 6 small blocks, not a per-row cost.)

**Screenshots opened and inspected** (`.artifacts/index-{desktop,narrow}-{light,dark}.png`):
- Desktop light/dark: all 6 drop zones show "Up to date through `<date>`." lines; 4 of 6
  sources (BoA Checking, BoA Credit Card, Fidelity Savings, 401k) show the amber
  gap-advisory box with the correct day count and date, matching the live
  `days_since_latest_covered` values from the API; Fidelity Credit Card and HSA show no
  advisory (23 and 31 days respectively — under the 45-day threshold), confirming the
  threshold behaves as intended against real data, not just a synthetic case. Pipeline
  tile reads "Nothing waiting — every uploaded file has already been processed." Both
  themes legible, amber advisory readable against both light and dark surface colors,
  no color-only signal (every state carries text).
- Narrow (480px): drop-zone grid reflows to 2 columns, gap-advisory boxes wrap cleanly,
  no horizontal scroll, confirmed by the harness's own overflow check plus visual read.
- A follow-up full-height capture of the page scrolled to `#balances-section` (both
  themes, via a throwaway Playwright script, deleted after use) confirmed the Manual EOM
  Balances panel now renders "No balance entries recorded yet." instead of throwing.

**End-to-end pending-file test** (mutating, cleaned up immediately per the runbook):
uploaded a 2-row throwaway CSV to `hsa` via `POST /api/upload/hsa` (never
`POST /api/trigger`, per the task's explicit instruction):
```
$ curl -s -F "files=@...\test_hsa_upload_007.csv" http://127.0.0.1:8000/api/upload/hsa
{"saved":["...\\data\\incoming\\hsa\\test_hsa_upload_007.csv"]}
$ curl -s http://127.0.0.1:8000/api/uploads | ... # hsa entry
pending_files: [{"filename":"test_hsa_upload_007.csv","row_count":2,
  "date_start":"2026-07-10","date_end":"2026-07-12", ...}]
pending_aggregate: {"file_count":1,"row_count":2,"date_start":"2026-07-10","date_end":"2026-07-12"}
days_since_latest_covered: 20
```
Re-screenshotted (`.artifacts/extra-hsa-pending-{light,dark}.png`, both opened): the HSA
zone correctly rendered the filename (bold, truncating class present), "2 rows ·
2026-07-10 → 2026-07-12", "Waiting to process: 1 file, 2 rows, covering 2026-07-10 →
2026-07-12.", and "Up to date through 2026-07-12 (includes a pending file)." — with no gap
advisory (20 days, under threshold, correctly recalculated against the new pending date).
The Pipeline tile summary updated live, without a page reload, to "1 file ready to process
across 1 source." Zero console errors in either theme during this test.

**Cleanup**, confirmed complete:
```
$ python -c "... DELETE FROM uploads WHERE filename = 'test_hsa_upload_007.csv' ..."
before delete: [(4, 'hsa', 'test_hsa_upload_007.csv')]
uploads table after cleanup: []
$ rm data/incoming/hsa/test_hsa_upload_007.csv
$ ls data/incoming/hsa/
Transactions-Export.csv   # only the pre-existing real file remains
```

**Final re-check — confirming nothing drifted:**
```
$ curl -s http://127.0.0.1:8000/api/rules | ... len
108
$ curl -s ".../api/transactions?status=needs_review" | ... len
315
$ curl -s ".../api/transactions" | ... len
1020
$ curl -s .../api/uploads | ... sum of pending_files across all sources
0
$ curl -s .../api/balance-entries
[]
```
Rules (108), needs_review (315), transactions (1020) exactly match the pre-session
baseline (and 004/005's own recorded baselines) — this session touched none of them.
Re-ran `node scripts/ui-check.mjs --page index` one final time after cleanup: clean,
screenshots re-opened, confirmed the HSA zone and Pipeline tile are back to their
pre-test state.

**What was NOT tested / verified:**
- An actual `POST /api/trigger` run through the real endpoint — explicitly out of scope
  per the task instructions (would ingest throwaway data into real `transactions`). The
  `buildTriggerSummaryText()` humanization logic was verified by code inspection and by
  constructing sample `{normalize, enrich, export}` objects matching the documented
  shapes, not by driving a real trigger response through it live. The
  `processed_at`-stamping confirmation this session was meant to close the loop on (per
  the task brief) is therefore still only verified at the level 004 left it — direct SQL,
  not the live button — since a live button-driven trigger would have mutated real data.
- Drag-and-drop file upload (only the file-input `change` path was exercised via curl;
  the drop-zone's `dragover`/`drop` handlers were not touched by this session and are
  unchanged from before).
- The `is-error` styling on `#trigger-summary` and `#pending-summary` was verified by
  code review (the CSS rule exists, colors reference `--negative`) but not by forcing the
  server offline mid-session to trigger it live — doing so would have interrupted the
  session's own verification calls.
- Color-blind-safe legibility of the gap-advisory box — every state carries a text label
  (no color-only signal), consistent with spec 003's precedent, but not verified via
  simulated color-vision testing.

Status: **Shipped.**
