# Dev Runbook

Read this first. It exists so every agent doesn't have to re-derive the same environment
knowledge from scratch.

## Safety rules — absolute, all agents

1. **Never delete, reset, move, or overwrite `data/finance.db`.** It holds real financial
   records (~1020 transactions) and 23+ hand-built rules the user created by hand. A
   backup exists at `data/finance.db.bak-*`, but restoring is a failure, not a plan.
   If you believe a change requires a DB reset, **stop and report that** — additive
   migrations exist precisely so this is never necessary.
2. **Never run `git reset --hard`, `git checkout --`, `git clean`, or force-push.**
3. **Never commit anything under `data/` or `.artifacts/`.**
4. **Report honestly.** Distinguish what you *ran and observed* from what you *inferred*.
   "Untested" is an acceptable answer; a false "verified" is not.

## Running the app

The dev server runs with `--reload`, so **backend edits apply automatically** — no
restart dance needed. Frontend files are served statically, so a browser reload is enough.

```bash
# is it already up?
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/

# start it (from repo root)
cd backend && ./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```

If you must run it in the background, redirect output to a log you can read, and prefer
fixing the running instance over starting a second one (port 8000 will conflict).

## Verifying the UI in a real browser

```bash
node scripts/ui-check.mjs              # all pages, light+dark, desktop+narrow
node scripts/ui-check.mjs --page index # just one page
```

It fails (exit 1) on console errors, failed/4xx requests, or horizontal page overflow,
and writes screenshots to `.artifacts/`.

**A passing run does not mean the UI is correct.** It means nothing threw. You must
**open the screenshots with the Read tool and look at them.** This project has shipped
logically-correct, visually-unverified UI more than once — that is the specific failure
this harness exists to prevent.

## Poking the API (read-only is safe)

```bash
curl -s http://127.0.0.1:8000/api/categories
curl -s http://127.0.0.1:8000/api/sources
curl -s http://127.0.0.1:8000/api/rules
curl -s "http://127.0.0.1:8000/api/transactions?status=needs_review" | python -c "import json,sys; print(len(json.load(sys.stdin)))"
curl -s http://127.0.0.1:8000/api/insights/calculator
```

`POST`/`PUT`/`DELETE` mutate real financial data. If you must test a mutation, use an
obviously-throwaway value (e.g. `__test_keyword__`) and **delete it afterwards**.
Note that deleting a rule reverts the last batch's transactions it classified back to
`needs_review` — that is intended behaviour, not a bug.

## Architecture in brief

```
CSV upload -> data/incoming/<source>/
   |  normalize.py   parse per source, dedupe on external_id, stamp batch_id
   v
SQLite (data/finance.db)  <-- THE source of truth
   |  enrich.py      keyword rules -> ML stub (no-op) -> needs_review
   |  export.py      regenerate BOTH derived artifacts, in full, every run
   v
data/exports/transactions.csv + account_paula.xlsx (Transactions / Global / Calculator)
```

Key invariants:

- **Exports are derived.** Never treat `.csv`/`.xlsx` as authoritative or write state there.
- **Dedupe by `external_id`**: a bank-native reference where one exists, else a content
  hash. `INSERT OR IGNORE` makes re-uploading the same file a no-op.
- **`batch_id` = one normalize run.** Rule edit/delete re-analysis is scoped to
  `MAX(batch_id)` so a rule change can't silently re-sweep old, reviewed data.
- **Migrations are additive**, via `_ensure_column()` / `_backfill_batch_ids()` in `db.py`.
- **Categories are fixed** (21, in `categories.py`, matching the user's reference
  spreadsheet) and validated server-side. No free-text categories.
- **Rule keywords are lowercased** at one choke point: `rules/store.py:create_rule`.

## Frontend conventions

Vanilla HTML/CSS/JS, no framework, no build step, **no CDN or remote assets** (must run
offline on an old laptop). Node is here *only* for Playwright.

Use the CSS custom properties in `styles.css` (`--bg`, `--surface`, `--border`, `--text`,
`--text-muted`, `--accent`, `--accent-soft`, `--positive`, `--negative`, `--space-*`).
Never hardcode a colour; everything must work in light **and** dark. Money is
`tabular-nums`, right-aligned, 2 decimals. Every async region needs loading
(`.skeleton`), empty (useful micro-copy), and error states. Long text truncates with
`title` holding the full value. The body must never scroll horizontally.

## Documentation

- `docs/features/NNN-slug.md` — one per feature, co-authored across the three agents.
- `docs/FEATURES.md` — index.
- `docs/ITERATION-LOG.md` — what was proposed, approved, rejected, shipped, learned.
