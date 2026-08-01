# 010 — Upload duplicate feedback and pending-file management
Status: Shipped
Iteration: 3

**Reopened 2026-08-01:** user-reported bug — clicking "Remove" opens the browser's file
picker instead of removing the entry. Root cause confirmed by reading the code: the
drop-zone element (`zone`) has a click-to-browse handler (`app.js:113`,
`zone.addEventListener("click", () => input.click())`), and `renderZoneUploads()` appends
the Remove button inside that same `zone` element with no `stopPropagation()` on its click
handler (`app.js:367`) — every click on Remove bubbles up and also fires the file picker.
The original verification pass exercised Remove and confirmed the row disappeared, but did
not check for the file-picker side effect.

**Fixed 2026-08-01 (fintech-frontend):** confirmed the diagnosis by reading `app.js:113`
(the zone's click-to-browse listener) and `renderZoneUploads()`'s Remove button block
(`app.js:288-390`) directly, then added `e.stopPropagation()` as the first line of the
Remove button's click handler (`app.js:367`). See `## Implementation notes` and
`## Verification evidence` below for the fix detail and the regression test that proves it,
including confirmation the same test fails against the unpatched code.

## Problem

Three related pain points, all in the same screen real-estate (`frontend/index.html`'s
drop-zone grid, the moment right before "Run Pipeline" is clicked — the exact moment 007
identified as "the moment the user most needs to know what's about to happen"), all
reported by the user from his own use of the app. Bundled here because a fix to one
without the others leaves the upload flow still untrustworthy.

**1. No feedback when the same file is uploaded twice.** Confirmed live, not hypothetical:
at the time of writing, `GET /api/uploads` for `boa_checking` shows exactly this happening
in the user's real data —

```json
"pending_files": [
  {"id": 5, "filename": "Movements_BoA_2025.csv", "uploaded_at": "2026-08-01 18:41:13", "row_count": 494, ...},
  {"id": 6, "filename": "Movements_BoA_2025.csv", "uploaded_at": "2026-08-01 18:42:32", "row_count": 494, ...},
  {"id": 7, "filename": "Movements_BoA_2025.csv", "uploaded_at": "2026-08-01 19:00:59", "row_count": 494, ...}
],
"pending_aggregate": {"file_count": 3, "row_count": 1482, ...}
```

The same 494-row file, uploaded three times within 20 minutes, produced three separate
`uploads` rows and a "Waiting to process: 3 files, 1482 rows" line in the live UI
(screenshot: `.artifacts/index-desktop-light.png`, BoA Checking zone) with nothing telling
the user two of those three are redundant. The backend already makes the *data* safe —
`normalize.py` dedupes into `transactions` by `external_id`/content hash via
`INSERT OR IGNORE` (confirmed in `docs/DEV-RUNBOOK.md` and 004's architecture notes), so
running the pipeline on this exact state would insert the 494 real rows once and discard
988 duplicate rows silently. The only signal that anything was redundant appears **after**
the fact, buried in `buildTriggerSummaryText()`'s sentence ("all were already in the
database (0 new)") — read *after* clicking Run Pipeline, not before, and not per-file. At
upload time — the moment this matters, per 007's own framing — there is zero feedback.

**2. No way to remove a pending (not-yet-processed) file.** Confirmed via
`GET /openapi.json`: the only routes touching uploads are `POST /api/upload/{source}` and
`GET /api/uploads` — no `DELETE`. 004's own architecture notes flagged this explicitly as
a known gap it left out of scope ("*No delete endpoint for `uploads` rows... Worth
flagging as a likely near-term ask once the frontend ships this*"). Combined with problem
1: the user's only way to clear those three stacked `Movements_BoA_2025.csv` entries today
is to run the pipeline and accept the wasted parse, or edit `data/finance.db` by hand.
Wrong-file mistakes (drop the wrong CSV into a source's zone) have no in-app recovery at
all before the pipeline runs.

**3. The "loaded" green dot vanishes on refresh — but this is a *different* gap than what
007 fixed, not the same one, and not a regression.** Checked by reading the actual running
code and app state, not assumed:

- `frontend/app.js`'s `renderFileList()` (line 137) renders one `<li>` per entry in
  `zoneFiles[sourceKey]` (line 49) — a plain in-memory object, populated only inside
  `uploadFiles()` (line 155) and never read from or written to any server response. Each
  `<li>` gets a `.status-dot` span (line 145) colored via CSS by `li.pending`/`li.done`/
  `li.failed` — `styles.css:268-270` confirms `.done .status-dot { background:
  var(--positive) }`, i.e. **the green dot the user is describing**. `zoneFiles` is never
  populated on page load — only `uploadFiles()` writes to it — so a refresh empties it and
  `renderFileList()` has nothing to render: the whole `.file-list` (dots included) goes
  blank, whether or not the file is still sitting there server-side.
- Feature 007 (read in full) added a *separate* element, `.zone-uploads`
  (`renderZoneUploads()`, app.js line 236), fed by `GET /api/uploads`'s persisted
  `pending_files`. This one does survive a refresh — it's text (filename, row count, date
  range), not a colored status dot, and it lives in a different DOM node
  (`[data-role="zone-uploads"]`) than `.file-list`. 007's own doc never mentions a dot,
  checkmark, or colored status indicator anywhere in its spec or implementation notes —
  it solved "what did I upload" with prose, not with the same visual language as the
  in-session dot.

**Finding: this is a genuine, additional gap 007 did not touch, not a regression and not
already fixed.** The user has two upload-status signals today that look related but
behave differently: an ephemeral colored dot that resets to nothing on refresh, and a
persistent text list that 007 added alongside it. He is describing the first one. Neither
007 nor anything since gave the persistent list the same at-a-glance "yes, this is safely
here" affordance the dot gave him in the moment of upload — so after a refresh he has
prose he has to read carefully, not the glanceable confirmation he had a second ago.

## User story & spec

> As the person doing the monthly import, when I drop a CSV into a source's box I want to
> know immediately if I've already uploaded this exact file and it's just sitting there
> unprocessed; I want a way to pull back a file I dropped in the wrong box before I run the
> pipeline on it; and I want to be able to tell, even after closing and reopening the app,
> which files are safely uploaded and waiting — not have to re-derive that from a sentence
> of prose.

### A. Duplicate-upload feedback

**Decision: a visible warning, not a silent overwrite.** The either/or was left open by
the user; here is the call and why.

Silent overwrite requires the system to guess, on his behalf, which of two files should
win whenever they aren't byte-identical — a corrected re-export, or the same filename
covering a longer date range, are exactly as plausible as an accidental double-click, and
nothing at upload time can tell those cases apart. This app's own house rules already
reject that shape of decision: `DEV-RUNBOOK.md` refuses to let anything silently discard
financial records, and `FEATURES.md` explicitly rejected a generic undo stack for the same
reason — a system quietly picking a "winner" file with no undo is worse than a redundant
row sitting in a list. A warning plus the manual delete this same spec adds (part B) gives
100% of overwrite's benefit — a clean, single pending file per source — with none of its
risk, and at no extra engineering cost, since part B's delete affordance has to be built
either way. If, after this ships, the warning proves too passive (he keeps running the
pipeline over unnoticed duplicates), a later iteration can promote it to a blocking
confirm step — but today's evidence (three stacked copies, still sitting there, never
triggered) is a doubt problem, not yet a bad-run problem, so start passive.

**Behavior:**
- Duplicate means: another `pending_files` entry **for the same source** whose content
  matches the newly-uploaded file. Compare content, not filename — a renamed identical
  export and a same-named-but-extended export are both plausible, and only content
  answers "would this add nothing." (The exact fingerprint mechanism is an architecture
  decision; the requirement is that it must not false-positive a file with more/different
  rows just because the name matches, and must not miss an identically-named-but-empty
  coincidence.)
- The upload itself is **not blocked** — it still saves and appears in the pending list
  exactly as today (the pipeline's `INSERT OR IGNORE` already makes actually running it
  harmless). The warning is additive information, not a gate.
- Feedback appears **at upload time**, in the same `loadUploads()` refresh that already
  runs after every `uploadFiles()` call (app.js line 175) — no new polling needed.
- Per-file: the duplicate's row in the persisted pending list (`.zone-uploads`, part C
  below) carries an inline note, e.g. *"Matches a file already pending, uploaded 12
  minutes ago — running the pipeline won't add anything new from this copy."* Style:
  `--accent`/`--accent-soft` (the same visual language 007 used for the gap-advisory box),
  **not** `--negative`/red — this is a heads-up, not a confirmed error, consistent with
  003's precedent that red is reserved for a confirmed reconciliation mismatch.
- Roll up into `#pending-summary` too, so the signal isn't only visible per-zone: e.g.
  *"4 files ready to process: BoA Checking (3, 2 look like duplicates)."* — reusing the
  existing sentence-building logic in `renderPendingSummary()`.
- Relative time ("12 minutes ago" / "yesterday") beats a raw timestamp for this specific
  copy, since the point is "you just did this," not an audit trail.

**States:**
- *Loading:* unchanged — existing `.zone-uploads` skeleton covers this; the duplicate flag
  arrives with the same payload, not a separate request.
- *Empty (no duplicates):* no note at all — this is the common case and must add zero
  visual noise (most uploads are not duplicates).
- *Error (`GET /api/uploads` fails):* falls back to the existing
  "Couldn't load upload history for this source." — do not attempt to show a stale
  duplicate flag computed from data we know is now unreliable.
- *Edge case — duplicate detected across more than 2 copies:* the note should reference
  the *earliest* pending match ("already pending, uploaded 20 minutes ago"), not enumerate
  all copies; the aggregate line and per-file list already show the total count.
- *Edge case — file matches something already fully processed (ingested), not just
  something pending:* out of scope for this iteration. The existing post-trigger summary
  ("all were already in the database (0 new)") already softens that case, and detecting it
  pre-trigger means comparing against historical ingested data, a materially bigger check
  than comparing against the small pending set. Flag as a candidate for a later iteration,
  not silently dropped.
- *1000+ pending files:* not realistic for a single source in normal use (this would mean
  1000 unprocessed uploads sitting untouched), but the duplicate check must be scoped to
  "pending files for this source" only, never the full cross-source pending set, so cost
  doesn't grow with unrelated sources' backlogs.

### B. Delete a pending (not-yet-processed) file

**Behavior:**
- Every entry in a source's persisted pending list (part C) gets a "Remove" affordance,
  visible only while the file is pending (`processed_at IS NULL`) — once a file has been
  through `Run Pipeline` there is no clean "remove" concept (its rows may already be
  merged into reviewed data), and building one is explicitly out of scope, the same way
  `FEATURES.md` already rejected a generic undo stack for the same underlying reason.
- Clicking Remove: deletes that file's `uploads` row and ensures the physical file under
  `data/incoming/<source>/` will not be picked up by the next `Run Pipeline` (exact
  mechanism — delete-from-disk vs. mark-and-skip — is an architecture decision).
- **No confirm dialog.** This codebase has no `confirm()`/modal pattern anywhere — rule
  deletion (`app.js:1225`) and balance-entry deletion (`app.js:1462`) both act on a single
  click with an inline `.field-error`-style message on failure. Match that convention
  rather than introducing a new one; a generic "Are you sure?" modal is exactly the kind
  of surface this product's owner has said he doesn't want. Removing a pending file is
  also the single lowest-stakes delete in the app — nothing has been parsed into
  `transactions` yet.
- After a successful remove: that entry disappears from the pending list, `pending_aggregate`
  and `#pending-summary` recompute immediately (same `loadUploads()` refresh pattern used
  everywhere else in this file) — no page reload required.
- If a source's whole pending list becomes empty as a result, fall back to the existing
  "Nothing uploaded yet" / "up to date through `<date>`" states already built by 007 — no
  new empty state needed, the existing one already covers "zero pending files."

**States:**
- *Loading (delete in flight):* disable that row's Remove button and show inline
  "Removing…", mirroring `delBtn.disabled = true` in the existing balance-entry delete
  handler — don't disable the whole zone, only the row being removed.
- *Error:* inline message on that row (same `field-error`/`rowErrorEl` pattern as rules
  and balance entries), Remove button re-enabled, nothing else in the list changes.
- *Empty:* covered by 007's existing empty state, see above.
- *Edge case — remove while a duplicate warning (part A) is showing on that same entry:*
  removing it should also cause the warning to disappear from any sibling entries that
  referenced it as "the earlier copy" (recomputed on the next `loadUploads()`, not stale).
- *1000+ rows:* if a source's pending list grows long (many small files, or the exact
  duplicate-pile scenario from the evidence above), the list must scroll within a
  constrained height rather than pushing the drop-zone card's height without bound —
  these are the entries the user needs to act on, so cap-and-scroll, never truncate-and-hide.

### C. Persistent "loaded" indicator (resolving finding 3)

**Behavior:** the glanceable "yes, this is safely uploaded" signal must be driven by
server truth (`GET /api/uploads`'s `pending_files`), not by the session-only `zoneFiles`
object, so it looks identical immediately after upload and after a full page reload.
Concretely: every entry in a source's persisted pending list (part C's list, i.e. 007's
`.zone-uploads` block) carries the same green "done" treatment the in-session dot gives
today — the visual vocabulary (`--positive`) can stay the same; what changes is its data
source. The existing in-session `.file-list`/`zoneFiles` dot can remain for the moment
*during* an active upload (pending → pulsing accent, matching current behavior) but must
hand off to the persisted, refresh-proof signal as soon as `GET /api/uploads` confirms the
row exists — at that point the two lists are describing the same fact and should not be
able to disagree. (Whether that's implemented as one merged list or two reconciled ones is
an architecture/frontend call; the user-visible requirement is a single, unambiguous
"still safely here" indicator that survives a refresh.)

**States:**
- *Loading:* existing `.zone-uploads` skeleton.
- *Empty:* existing "Nothing uploaded yet" copy — no dot, nothing to confirm.
- *Error:* existing "Couldn't load upload history for this source." — must not show a
  stale green dot left over from a previous successful load; a failed fetch means "unknown,"
  not "still fine."
- *Edge case — upload in flight when the user refreshes mid-request:* on reload there is no
  session state to show "in progress" (browser navigation aborts the in-flight request);
  the next `loadUploads()` will simply show the file as pending (if the server finished
  saving it) or absent (if it didn't) — no attempt to reconstruct "was mid-upload," since
  that state cannot outlive the page that started it.
- *1000+ rows:* same scroll-not-truncate treatment as part B, since this is the same list.

## Explicitly out of scope (deliberately, not overlooked)

- Auto-overwrite on duplicate detection — see decision above.
- Duplicate detection against already-ingested (processed) history, only against pending
  files — flagged as a candidate for a later iteration.
- Any "undo" after `Run Pipeline` has processed a file — unchanged rejected territory from
  `FEATURES.md`.
- A confirm-dialog/modal pattern — inconsistent with every existing delete affordance in
  this app.
- Cross-source duplicate detection (identical content uploaded to two different source
  zones) — no evidence this happens; not worth the added comparison surface.

## Architecture

### A. Duplicate detection — stored hash, computed at upload time

**Decision: add `uploads.content_hash TEXT`, populated from the exact bytes read in
`POST /api/upload/{source}`, not computed on the fly at read time.**

Why not compute-on-the-fly from the physical file at `GET /api/uploads` time: `ingest.
save_upload()` writes to a **deterministic, filename-keyed path**
(`data/incoming/<source>/<filename>`) — confirmed live: `boa_checking`'s three pending
`uploads` rows (ids 5, 6, 7, all `Movements_BoA_2025.csv`) all resolve to the *same single
physical file* on disk today (`data/incoming/boa_checking/Movements_BoA_2025.csv` is the
only file there). Each re-upload of the same filename **overwrites** the previous physical
copy. So the current on-disk bytes only ever reflect the *most recent* upload of that
filename — hashing the file at read time would be correct for the newest of a set of
same-named pending uploads, but only *accidentally* correct for the older ones (correct
here only because the three uploads happen to be byte-identical). If an older upload had
different content than a later same-named one, on-the-fly hashing would misreport the old
row's fingerprint entirely. A stored hash, captured once per upload event from the bytes
actually submitted at that time (`content = await f.read()` in `upload()`, already in
memory before `save_upload()` writes/overwrites), is the only fingerprint that's accurate
per-row rather than per-filename.

**Migration:** additive, following the existing `_ensure_column` pattern —
`_ensure_column(conn, "uploads", "content_hash", "TEXT")` in `db.py:init_db()`, plus the
column added to `SCHEMA`'s `CREATE TABLE IF NOT EXISTS uploads` for fresh DBs. No table
rebuild, no data loss risk.

**Backfill for pre-existing rows (the real ids 5/6/7 in evidence today predate this
column and have `content_hash IS NULL`):** self-heals lazily inside `GET /api/uploads`,
not as a separate startup migration. For each *pending* row with a NULL hash, best-effort
read the current physical file at `data/incoming/<source>/<filename>` and hash it, then
persist the result back (`UPDATE uploads SET content_hash = ? WHERE id = ?`) so it's
computed once. This is the same filename-keyed assumption the storage layer already makes
implicitly (one physical slot per filename) — for legacy rows sharing a filename, this
recovers a hash that is correct for whichever upload most recently wrote that file, same
caveat as above. If the physical file is missing (e.g. deleted out-of-band), the row stays
NULL and is simply excluded from duplicate comparison — fails safe (no flag), never a
crash, never a false positive.

**Comparison logic:** scoped per source, over `pending_files` only (per spec, never
cross-source, never against ingested history). Within one source's pending rows ordered by
`uploaded_at`, group by `content_hash` (skipping NULLs); every row after the first in a
group gets `duplicate_of` pointing at the first (earliest) row in that group — this
directly satisfies the "reference the earliest match, not enumerate all copies" spec
requirement without needing a separate query.

### B. Delete a pending file — conditional disk delete, not mark-and-skip

**Decision: actually delete the `uploads` row and, conditionally, the physical file —
not mark-and-skip.** Mark-and-skip is not implementable without touching a different
choke point than intended: `pipeline/ingest.list_incoming(source)` drives what
`normalize_all()` parses by **globbing the directory** (`source_dir.glob("*.csv")`), not
by joining against the `uploads` table. There is currently no mechanism anywhere that
consults `uploads` rows to decide what to parse. Making "removed" uploads invisible to the
pipeline without deleting the file would require teaching `normalize_all()`/
`list_incoming()` about `uploads.processed_at`/a new "removed" flag — a parallel filtering
mechanism next to the existing glob-based one, which is exactly the "one choke point per
concern" commitment telling us not to. Deleting the physical file is therefore the only
way to fulfil the endpoint's actual contract ("won't be picked up by the next Run
Pipeline") without adding that parallel mechanism.

This is a lower-stakes delete than anything touching `data/finance.db`'s `transactions`
table: `transactions` is the source of truth per the runbook, and nothing here is parsed
into it yet (`processed_at IS NULL` is exactly "not yet in `transactions`"). The physical
CSV under `data/incoming/` is disposable working storage, not the source of truth.

**The one real risk, and how it's handled:** because `save_upload()` is filename-keyed
(confirmed live: 3 pending rows, 1 physical file), deleting the physical file
unconditionally on any single row's removal could destroy data a *sibling* pending row
still needs — e.g. deleting id 6 of the three `boa_checking` duplicates would, if done
naively, also remove the one physical file ids 5 and 7 still depend on, so a later Run
Pipeline would silently parse zero rows for a filename that still has pending entries
pointing at it. Fix: only unlink the physical file if no *other* pending row (same
source + filename, `processed_at IS NULL`) still references it —

```sql
SELECT COUNT(*) FROM uploads WHERE source = ? AND filename = ? AND processed_at IS NULL
```
run *after* the target row's own DELETE. Zero remaining -> safe to unlink. This preserves
exactly the same duplicate-tolerant behavior the pipeline already has (`INSERT OR IGNORE`
on `external_id`) at the filesystem layer, rather than introducing a new failure mode.

**Contract:**
```
DELETE /api/uploads/{upload_id}
  200 {"ok": true}
  404 {"detail": "Upload not found"}          — no such id
  400 {"detail": "Upload has already been processed and can't be removed"}
                                                — processed_at IS NOT NULL
```
Chose `400` over inventing a `409` for the "already processed" case: this codebase's only
precedent codes are 404/400/500 (`routes.py`); 400 already covers "the request as given is
invalid given current state" elsewhere (e.g. the `month` format check), so this stays
consistent rather than adding a new status code for one endpoint.

No new module: this is small, single-table, single-endpoint logic that lives in
`routes.py` next to the sibling `DELETE /api/rules/{id}` and
`DELETE /api/balance-entries/{id}` handlers it mirrors in shape and error style.

### C. Extended `GET /api/uploads` response — additive fields only

```jsonc
[
  {
    "source": "boa_checking",
    "label": "BoA Checking",
    "pending_files": [
      {
        "id": 5, "filename": "Movements_BoA_2025.csv",
        "uploaded_at": "2026-08-01 18:41:13", "row_count": 494,
        "date_start": "2025-01-13", "date_end": "2025-12-31",
        "duplicate_of": null                                    // NEW
      },
      {
        "id": 6, "filename": "Movements_BoA_2025.csv",
        "uploaded_at": "2026-08-01 18:42:32", "row_count": 494,
        "date_start": "2025-01-13", "date_end": "2025-12-31",
        "duplicate_of": {"id": 5, "uploaded_at": "2026-08-01 18:41:13"}   // NEW
      },
      {
        "id": 7, "...": "...",
        "duplicate_of": {"id": 5, "uploaded_at": "2026-08-01 18:41:13"}   // NEW
      }
    ],
    "pending_aggregate": {
      "file_count": 3, "row_count": 1482,
      "date_start": "2025-01-13", "date_end": "2025-12-31",
      "duplicate_count": 2                                        // NEW
    },
    "ingested_coverage": { "...": "..." },
    "days_since_latest_covered": 213
  }
]
```

- `duplicate_of`: `null` for a non-duplicate (or the earliest copy of a group); otherwise
  `{"id", "uploaded_at"}` of the earliest matching pending upload for that source. Frontend
  computes the relative-time phrasing ("12 minutes ago") client-side from `uploaded_at`, no
  new backend time-formatting logic needed. `id` is included so the frontend can also
  cross-reference/remove stale flags client-side if it wants, though a fresh
  `loadUploads()` after any delete already recomputes this server-side (part A's "recomputed
  on next `loadUploads()`, not stale" requirement is satisfied for free — the flag is
  derived at request time, there is nothing to invalidate).
- `pending_aggregate.duplicate_count`: count of entries in *this source's* `pending_files`
  with non-null `duplicate_of` — matches the spec's own example sentence ("3, 2 look like
  duplicates").
- No breaking changes to any existing field; both new fields are purely additive.

### Risks / trade-offs

- The backfill's "same filename -> assume same content for old NULL-hash rows" heuristic
  is an approximation for pre-existing data only; every upload from this point forward
  gets an exact per-upload-event hash, so the approximation is a one-time, shrinking edge
  case, not a permanent gap.
- Conditional disk-delete depends on `filename` equality as the sibling-detection key
  (matching how `save_upload` itself already keys physical storage) — consistent with an
  existing assumption, not a new one.
- No index added on `uploads(source, filename)` or `uploads(content_hash)` — pending lists
  are small (tens, not thousands, per the spec's own "1000+ rows" edge case framing being
  explicitly hypothetical), so a full scan per source per request is cheap and not worth
  the schema complexity.

## Implementation notes
<!-- architect + frontend -->

**Backend (solution-architect):**

- `backend/app/db.py`: added `content_hash TEXT` to the `uploads` table in `SCHEMA`
  (fresh DBs) and `_ensure_column(conn, "uploads", "content_hash", "TEXT")` in `init_db()`
  (existing DBs) — additive migration, no data loss, ran clean against the live
  `data/finance.db` (verified via a running `--reload` server, no restart needed).
- `backend/app/api/routes.py`:
  - `POST /api/upload/{source}`: computes `hashlib.sha256(content).hexdigest()` from the
    already-in-memory upload bytes and stores it in the new `uploads.content_hash` column.
  - `GET /api/uploads`: self-heals NULL `content_hash` on pending rows (best-effort hash
    of the current on-disk file), then groups pending rows by hash to compute
    `duplicate_of` per entry and `duplicate_count` on `pending_aggregate`.
  - `DELETE /api/uploads/{upload_id}`: new route per the contract above; conditional
    physical-file delete guarded by a sibling-reference count query.

**Real curl verification (solution-architect), against the live dev server / live DB:**

1. Extended `GET /api/uploads` against the real, pre-existing `boa_checking` triple
   duplicate (ids 5/6/7, the exact evidence quoted in the Problem section) — backfill
   self-heal ran on first request, then correctly flagged the two later uploads against
   the earliest:
   ```json
   "pending_files": [
     {"id": 5, "...": "...", "duplicate_of": null},
     {"id": 6, "...": "...", "duplicate_of": {"id": 5, "uploaded_at": "2026-08-01 18:41:13"}},
     {"id": 7, "...": "...", "duplicate_of": {"id": 5, "uploaded_at": "2026-08-01 18:41:13"}}
   ],
   "pending_aggregate": {"file_count": 3, "row_count": 1482, "duplicate_count": 2}
   ```
   Confirmed via direct sqlite query that all three rows' `content_hash` backfilled to the
   same value (`d1ad1cb7...`) — matches the fact that all three uploads share one physical
   file on disk (`save_upload()`'s filename-keyed storage).
2. Synthetic throwaway test (not touching the real `boa_checking` evidence): uploaded a
   `__test_dup__.csv` to `hsa` (0 real pending uploads there) twice via the real
   `POST /api/upload/hsa` endpoint. Second upload correctly showed
   `"duplicate_of": {"id": 8, ...}`, `pending_aggregate.duplicate_count: 1`.
3. `DELETE /api/uploads/9` (the duplicate, id 9) -> `200 {"ok": true}`. Physical file
   **remained on disk** afterward — verified sibling id 8 still referenced it, matching
   the conditional-unlink design.
4. `DELETE /api/uploads/8` (now the only reference) -> `200 {"ok": true}`. Physical file
   **was removed** from `data/incoming/hsa/__test_dup__.csv` — verified via `[ -f ... ]`.
5. `DELETE /api/uploads/8` again -> `404 {"detail": "Upload not found"}`.
6. Already-processed rejection: uploaded a second synthetic file
   (`__test_processed__.csv`, id 10), set its `processed_at` directly via sqlite (the only
   way to produce a processed row without running `/api/trigger` against the real,
   already-pending `boa_checking` data — running trigger would have ingested the live
   evidence rows, which this session was told to preserve). `DELETE /api/uploads/10` ->
   `400 {"detail": "Upload has already been processed and can't be removed"}`. File
   confirmed still present (delete correctly rejected). Cleaned up the synthetic row and
   file directly afterward.
7. Final sanity: `GET /api/uploads` shows `hsa` back to `file_count: 0` and
   `boa_checking` unchanged at `file_count: 3, duplicate_count: 2` — the real evidence
   data was never altered except via the new endpoint's own synthetic test cases above.

All five states (success, not-found, already-processed, sibling-preserved, last-reference-
unlinked) verified against the real running server, not inferred.

**Frontend (fintech-frontend):**

- `frontend/app.js`:
  - `formatRelativeTime()`: new helper, converts the server's
    `"YYYY-MM-DD HH:MM:SS"` timestamp into "just now" / "N minutes/hours ago" /
    "yesterday" / "N days/months/years ago", client-side, per the
    architecture's "frontend computes the relative-time phrasing" note.
  - `renderZoneUploads()`: each `pending_files` `<li>` (`.upload-record`) now
    renders a row (`.upload-record-row`) with a `--positive` status dot
    (`.upload-status-dot` — part C: every persisted row is, by definition,
    server-confirmed, so it's unconditionally "done," unlike the session-only
    dot), the filename, and a per-row "Remove" button
    (`.upload-remove-btn`). Below that: the existing row count/date-range
    meta line, then — only when `f.duplicate_of` is non-null — a
    `.upload-duplicate-note` with the "Matches a file already pending,
    uploaded `<relative time>`…" copy (part A), then a `.field-error` div for
    remove failures. No duplicate note at all when `duplicate_of` is null —
    verified zero visual noise in the common case (BoA Credit Card, Fidelity
    Credit Card, etc. render with no note).
  - Remove button click handler: disables the button and sets its text to
    "Removing…" (mirrors `delBtn.disabled = true` in the balance-entry
    delete handler), calls `DELETE /api/uploads/{id}`, and on success calls
    the existing `loadUploads()` — which re-fetches and re-renders
    everything (`pending_aggregate`, `#pending-summary`, and every sibling's
    `duplicate_of`) from server truth, so there is nothing to invalidate
    client-side. On failure, the error message lands in that row's own
    `.field-error` and the button re-enables — per-row, not per-zone, no
    confirm dialog, matching the rule-delete (`app.js:1225`) and
    balance-entry-delete (`app.js:1462`) convention exactly.
  - `renderPendingSummary()`: the per-source clause in the existing sentence
    now appends `, N look(s) like a duplicate(s)` when
    `pending_aggregate.duplicate_count > 0` — e.g. "BoA Checking (3, 2 look
    like duplicates)" — and is omitted entirely otherwise.
  - `reconcileZoneFiles()` (new) + one call site in `uploadFiles()`: once
    `loadUploads()` confirms a same-named row is present in that source's
    persisted `pending_files`, the matching "done" entry is dropped from the
    session-only `zoneFiles`/`.file-list`, so the ephemeral upload-moment dot
    hands off to the persisted `.zone-uploads` dot instead of both being
    visible at once for the same fact (part C's "should not be able to
    disagree"). Entries still `pending` or `failed` are left alone.
  - Error path: unchanged from 007 — when `GET /api/uploads` itself fails,
    `renderZoneUploads()`'s `UPLOADS === null` branch returns immediately
    with the existing "Couldn't load upload history for this source."
    message and never reaches the code that would render a dot or a
    duplicate note, so a failed fetch cannot show stale positive/duplicate
    state (verified by reading the code path — this branch was already
    structured this way before this feature, and the new rendering logic
    all lives strictly after it).
- `frontend/styles.css`: added `.upload-status-dot` (`--positive`),
  `.upload-record-row`, `.upload-remove-btn` (small `.ghost`-based button,
  inherits the existing global `:hover`/`:focus-visible`/`:active`/
  `:disabled` button rules), `.upload-duplicate-note` (`--accent`/
  `--accent-soft`, left border — same visual language as the pre-existing
  `.zone-gap-warning`, deliberately not `--negative`). `.upload-record-list`
  got `max-height: 480px; overflow-y: auto` for the "1000+ rows"
  cap-and-scroll requirement. First attempt used 220px and it clipped the
  real live 3-file `boa_checking` duplicate pile with no visible scroll
  affordance — caught by actually looking at the screenshot (see below),
  raised to 480px so today's ordinary case (a handful of files, some with
  multi-line duplicate notes) always renders in full; only long lists
  (tens of files) will actually hit the cap. No hex colors hardcoded —
  everything reuses existing custom properties.
- `frontend/index.html`: no changes — `.zone-uploads` containers are already
  built dynamically by `renderDropZones()`, no new container element was
  needed.

### Reopened-bug fix (fintech-frontend, 2026-08-01)

**Bug:** clicking "Remove" on a pending upload row opened the OS file picker
instead of (or in addition to) removing the row.

**Root cause, confirmed by reading the code directly (not just trusting the
reopened note above):** `renderDropZones()` (`app.js:113`) attaches
`zone.addEventListener("click", () => input.click())` to the whole `.drop-zone`
element so clicking anywhere in the zone opens the file picker (the
click-to-browse affordance). `renderZoneUploads()` appends its
`.zone-uploads` block — including each pending file's Remove button — inside
that same `zone` element (`app.js:288` onward). The Remove button's own click
handler (`app.js:367`, pre-fix) had no `stopPropagation()`, so a click on
Remove bubbled up to the zone's listener and fired `input.click()` as well as
the button's own delete logic — both handlers ran off a single click.

**Fix:** added `e.stopPropagation()` as the first statement in the Remove
button's click handler (`app.js:367`, now takes the event as its `e`
parameter). One line, no other files touched.

**Per-button vs. container-level propagation — chose per-button, and why:**
audited every element `renderZoneUploads()` puts inside `.zone-uploads`
(status dot, filename, meta line, duplicate note, row error div) — the Remove
button is the *only* interactive element in that block. Stopping propagation
on the whole `.zone-uploads` container would silently change behavior for
clicks that land on inert text (filename, meta, duplicate note) inside an
already-populated list — today those clicks fall through to click-to-browse,
which is existing, unreported, and not part of this bug report. Scoping the
fix to the one element that's actually broken keeps the change surgical
(this repo's stated architecture commitment) and avoids second-guessing
unrelated, unreported behavior. If a future feature adds another interactive
element inside `.zone-uploads` (e.g. an "edit" affordance), it will need the
same one-line treatment — not a container-level rule that would silently
paper over a class of bugs instead of surfacing each one.

## Verification evidence

**Note (2026-08-01):** the sections below through "What was not verified" are the
*original* verification pass from this feature's first ship — left intact, not
re-run, because nothing in this reopening touched the code paths they cover
(duplicate detection, the delete contract's success/error states, relative-time
formatting). The reopened-bug fix and its own regression evidence are appended
as a new subsection below, `### Reopened-bug regression test (2026-08-01)`.
That new subsection is exactly the check the original pass missed — it never
listened for a `filechooser` event, so it confirmed Remove worked without
confirming Remove *only* did what it should.

**API contract, confirmed live via curl before writing any frontend code**
(matches the architecture doc exactly):
- `GET /api/uploads` for `boa_checking`: real production ids 5/6/7, id 5
  `"duplicate_of": null`, ids 6 and 7 both `"duplicate_of": {"id": 5,
  "uploaded_at": "2026-08-01 18:41:13"}`, `pending_aggregate.duplicate_count:
  2` — exactly as the spec's evidence claimed.

**`node scripts/ui-check.mjs` (all pages, light+dark, desktop+narrow):**
exit 0, no console errors, no failed/4xx requests, no horizontal overflow,
on both `index.html` and `insights.html`.

**Screenshots actually opened and read (not just "ran clean"):**
- `index-desktop-light.png` / `index-desktop-dark.png`: BoA Checking zone
  shows all 3 real pending files (not just 2 — this is what caught the
  220px-cap bug above). File 1 (id 5) has no note. Files 2 and 3 (ids 6, 7)
  each show a `--positive` dot, a "Remove" button, and an amber
  `.upload-duplicate-note` reading "Matches a file already pending,
  uploaded just now — running the pipeline won't add anything new from this
  copy." `#pending-summary` (top right, "2–4 · PIPELINE" panel) reads "3
  files ready to process: BoA Checking (3, 2 look like duplicates)." Colors
  read correctly in both themes — amber note stays legible on the dark
  `--accent-soft`, green dot stays legible on both. Long filenames
  ("Movements_BoA_2025.csv") truncate with `title` holding the full name.
- `index-narrow-light.png` / `index-narrow-dark.png` (480px viewport): same
  content, single-column stacked drop zones, no horizontal scrollbar, text
  wraps inside the duplicate-note box instead of overflowing.
- `insights-desktop-light.png`: spot-checked to confirm no shared-CSS
  regression — unaffected, renders exactly as before.
- Did not re-open every one of the 8 screenshots pixel-by-pixel a second
  time after the 220px→480px CSS fix; re-ran `ui-check.mjs` (clean exit) and
  re-opened only the two `index` screenshots that mattered for that specific
  fix, which is where the fix is visible.

**Real interaction test (mutating, throwaway data, not the read-only
`ui-check.mjs`):** used `hsa` (0 real pending files) exactly as instructed,
never touched `boa_checking` ids 5/6/7.
1. Uploaded a throwaway `__frontend_verify_dup__.csv` to `hsa` twice via the
   real `POST /api/upload/hsa` (curl, same endpoint the browser's drop zone
   calls) — second upload's `GET /api/uploads` showed `duplicate_of` pointing
   at the first (id 11), `pending_aggregate.duplicate_count: 1`.
2. Loaded `index.html` in a real headless Chromium (throwaway Playwright
   script, deleted afterward) and screenshotted the HSA zone
   (`.artifacts/hsa-zone-before.png`, viewed): both rows render, second row
   shows the duplicate note, "Waiting to process: 2 files, 2 rows."
   `#pending-summary` on the full page read "5 files ready to process: BoA
   Checking (3, 2 look like duplicates), HSA (2, 1 looks like a duplicate)."
   — confirmed singular grammar ("1 looks like a duplicate") renders
   correctly, not just the plural case from the spec's own example.
3. Clicked the first row's real "Remove" button in the browser (Playwright
   `.click()`, not a simulated event) — waited for the row to disappear via
   `loadUploads()`'s refresh, no page reload. Screenshotted the result
   (`.artifacts/hsa-zone-after.png`, viewed): one row remains, and critically
   — its duplicate note is now **gone**, because removing its "earlier copy"
   (id 11) correctly made the server recompute `duplicate_of: null` for the
   sole remaining row (id 12) on the next `loadUploads()`. This is the exact
   "sibling duplicate-notes recompute, not stale" edge case the spec calls
   out, confirmed against real client-driven DOM state, not just a curl
   response. Zero console errors during the click/refresh cycle.
4. Cleanup: `DELETE /api/uploads/12` (the sole remaining test row) →
   `200 {"ok": true}`. Confirmed via curl: `hsa` back to `file_count: 0`,
   and the physical file `data/incoming/hsa/__frontend_verify_dup__.csv` was
   removed from disk (only the pre-existing `Transactions-Export.csv`
   remains in that directory) — the conditional-unlink logic correctly held
   the file while a sibling referenced it (after step 3) and released it once
   the last reference was gone (after step 4).
5. Re-confirmed via curl that `boa_checking` ids 5/6/7 and their
   `duplicate_of`/`duplicate_count` values are byte-identical to the
   pre-test state — the real evidence data was never touched.
6. Deleted both throwaway Playwright scripts and the scratch CSV afterward;
   nothing under `scripts/` or `data/` was left behind from this test.

**What was not verified:**
- Drag-and-drop upload specifically (only the underlying `POST` endpoint,
  via curl and the browser's Remove click) — the drop-zone's drag/drop
  wiring itself is unchanged from feature 007 and out of scope for this
  feature's diff.
- The exact "yesterday" / "N months ago" / "N years ago" branches of
  `formatRelativeTime()` — only the "just now" (<1 min) and the singular
  "1 looks like a duplicate" grammar branch were exercised against real
  timestamps in this session, since all test data was created and removed
  within the same session. The function's logic was read and reasoned
  through, not exercised end-to-end for every time bucket.
- Concurrent/race conditions (e.g. two browser tabs removing the same row
  at once) — not tested, no evidence this is a realistic scenario for a
  single-user local app.

### Reopened-bug regression test (2026-08-01, fintech-frontend)

**`node scripts/ui-check.mjs --page index`:** exit 0, no console errors, no
failed/4xx requests, no horizontal overflow, both viewports and themes.
Screenshots actually opened and read (`index-desktop-light.png`,
`index-desktop-dark.png`, `index-narrow-light.png`): drop zones, Remove
buttons (where pending files exist), and the pipeline panel render correctly
in both themes; narrow viewport stacks with no horizontal scrollbar. (At the
time of this check the real `boa_checking` pending list had already dropped
from 3 files to 0 through the user's own separate use of the app outside this
session — not something this fix touched or needs to explain.)

**Real interaction test — the specific check the original pass missed —
throwaway Playwright script, deleted after use, never touched the real
`boa_checking` ids 5/6/7:**

1. Uploaded a throwaway `__remove_regression_test__.csv` to `hsa` (0 real
   pending files) via `POST /api/upload/hsa` — same endpoint the browser's
   drop zone calls.
2. Loaded `index.html` in a real (non-headless-hidden, actual Chromium via
   Playwright) browser and registered `page.on("filechooser", () => { fired =
   true })` **before** interacting with the page.
3. Located the HSA zone's Remove button for the throwaway row and clicked it
   with Playwright's real `.click()`.
4. Waited for the row to detach from the DOM (i.e. `loadUploads()`'s refresh
   completed, not a fixed sleep), then asserted the `filechooser` flag —
   **result: `false`, no file picker was triggered.**
5. Confirmed removal against server truth, not just the DOM: `GET
   /api/uploads` showed `hsa` back to zero pending files and the specific
   uploaded row's id absent from the list.
6. **Sanity-checked the test itself is capable of catching the bug**, not
   just passing trivially: temporarily reverted the `e.stopPropagation()`
   fix, re-ran the identical script against the unpatched code — result:
   `filechooser fired during Remove click: true`, test correctly failed with
   `REGRESSION: clicking Remove opened the OS file picker`. Re-applied the
   fix, re-ran the script a final time — clean pass again (`filechooser
   fired: false`, row removed). This before/after comparison is the actual
   proof the fix works, not just that the happy path is green.
7. Cleanup: confirmed `data/incoming/hsa/` contains only the pre-existing
   `Transactions-Export.csv` (the throwaway CSV and its `uploads` row were
   both removed by the Remove click itself, since the delete logic runs
   regardless of whether the click also bubbled). Confirmed via curl that
   `boa_checking`'s pending state was untouched by this session (this session
   never called `DELETE` against any `boa_checking` id). Deleted the
   throwaway Playwright script (`scripts/_tmp_remove_regression_test.mjs`)
   afterward — nothing left under `scripts/` or `data/` from this test.

**What this specifically proves that the original pass didn't:** Remove no
longer has a side effect beyond removing the row — verified by listening for
the browser-level `filechooser` event, not by inference from the DOM update
alone, and verified the test has discriminating power by watching it fail
against the unpatched code before watching it pass against the patched code.

**What was not re-verified in this pass:** the duplicate-note UI and
multi-row scroll behavior (part A/C of the original spec) — no pending files
existed on any real source at test time to exercise those visually again;
their code paths are unchanged by this one-line fix and were not touched.
