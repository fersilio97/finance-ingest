# Feature Index

Every feature gets a numbered doc in `docs/features/`, co-authored by the three agents:
UX writes the problem and spec, the architect writes the architecture, the frontend
engineer writes the verification evidence.

| #   | Feature | Status | Iteration |
| --- | ------- | ------ | --------- |
| [001](features/001-rule-keyword-and-match-preview.md) | Smart rule keyword, match preview, and conflict warning | Shipped | 1 |
| [002](features/002-group-review-queue-by-merchant.md) | Group the review queue by merchant, decide once per group | Shipped | 1 |
| [003](features/003-reconciliation-three-states.md) | Reconciliation: stop shouting MISMATCH when nothing was recorded | Shipped | 1 |
| [004](features/004-upload-visibility-stats.md) | Upload visibility: which files were uploaded, stats, staleness (backend) | Shipped | 2 |
| [005](features/005-balance-entries-reconciliation.md) | Balance entries: exact-timestamp balances, per-entry reconciliation (backend) | Shipped | 2 |
| [006](features/006-balance-trend-and-drilldown.md) | Balance trend for all 6 accounts + aggregated line; transaction drill-down filters (backend) | Shipped | 2 |
| [007](features/007-upload-visibility-pipeline-clarity.md) | Upload visibility and pipeline clarity (frontend) | Shipped | 2 |
| [008](features/008-eom-balances-reconciliation-ui.md) | Balance-entry UI (datetime, dropdown, delete) and per-entry reconciliation panel (frontend) | Shipped | 2 |
| [009](features/009-balance-trend-chart-category-drilldown.md) | Balance trend chart rework (time-based axes, 6+1 lines, entry markers, tooltip), sortable category table + transaction drill-down, account-balance strip (frontend) | Shipped | 2 |
| [010](features/010-upload-duplicate-feedback-and-file-management.md) | Upload duplicate feedback and pending-file management (delete pending file, refresh-proof "loaded" indicator) | Approved | 3 |

**Status values:** Proposed · Approved · In progress · Shipped · Rejected

Rejected features stay in the table on purpose — knowing what was considered and turned
down (and why) is as useful as knowing what shipped, and it stops the same idea being
re-proposed every iteration.

## Backlog (proposed, not approved)

Ranked candidates from iteration 1 discovery that were **not** approved this round. The
rank is the UX lead's ordering by "does this reduce the time or the doubt of closing the
month" — iteration 2 should start from here rather than re-deriving it. Numbers were
measured against the live app on 2026-07-31 (1020 transactions, 862 in `needs_review`,
23 rules).

| Rank | Candidate | Cost | Why it ranked there |
| --- | --- | --- | --- |
| 3 | Paginate/window the queue, plus search and filter | Medium | Index page is 113,746px tall (114× viewport), 39,169 DOM nodes, 522ms full re-render after every action ≈ 7.5 min of pure waiting to clear 862 rows. `GET /api/transactions` accepts only a `status` param — no search, no source filter. **Partly subsumed by 002** — re-measure after grouping ships before committing to virtualisation. |
| 4 | An "all transactions" view: fix a mistake, see which rule fired | Medium | Once a transaction leaves `needs_review` it vanishes from the UI forever — `app.js` only ever fetches `status=needs_review`, so a miscategorisation is unfixable in-app. `transactions.rule_id` is already populated (21 distinct rules across 158 classified rows) but never surfaced. Also: rule delete returns `{"reverted": N}` and the frontend discards it. This is the answer to "no undo" **and** "no explainability" in one screen — do not build them separately. |
| 6 | Insights: lead with how much is still unclassified | Small–medium | The category table is 19×24 with **75% of cells exactly 0.00**; `Uncategorized` is column 22 of 24 and invisible at 1440px. The hidden values are large and real — `2025-08` Uncategorized is **−12,983.02** against a Total of −4,792.98. Nine of 21 category columns are zero in all 19 months. *The user considered this and left it out of iteration 1; it is not rejected.* |
| 7 | Route structural non-spend out of the review queue | Small–medium | ~160 of 862 rows are not spending decisions: 121 k401 `Fees:` / `Realized Gain/Loss:` rows (only 6 exceed $5; 99 queue rows are under $1 and net −$10.64 total), 20 `FIDELITY GOVERNMENT MONEY MARKET` sweeps netting exactly $0.00, and 19 `Mobile Banking payment to CRD 6843` rows (−$19,095.83) that are credit-card payments already counted on the card side. Caveat: the 106 `Zelle payment` rows are genuinely ambiguous and must stay human-reviewed. |
| 8 | Review-row layout: density and wrapping | Small | Rows are 129px tall (~7 per screen), "Save as rule" wraps to two lines, dates wrap mid-value (`2026-` / `07-06`). Most *visible* defect, least *valuable* fix — 002 removes most of the scrolling anyway. Bundle into whatever touches the queue. |
| 9 | Run Pipeline reports in English | Small | `app.js:148` dumps raw nested JSON into the status line. Runs only a few times a month, but it is the moment he most needs "did anything import, and how many need me now?". Good filler, not a headline. |
| ~~10~~ | ~~Balance chart axes~~ | — | **Resolved by [009](features/009-balance-trend-chart-category-drilldown.md), iteration 2 session 7.** Time-based x-axis, y/x gridlines + labels, responsive canvas, all fixed. |

### Considered and rejected (do not re-propose without new evidence)

- **A real ML classifier to replace `classifier/model_stub.py`.** 158 labelled examples
  across 13 categories is far too few, and a probabilistic suggestion he must verify adds
  doubt rather than removing it. Rules + grouping reach 81% coverage with logic he can
  read. Revisit at 1,000+ labels.
- **A generic undo stack.** Real state and real risk against a live financial DB. The
  actual need — "I mis-tagged that, let me fix it" — is fully served by backlog #4, and
  rule deletion already has revert semantics (`routes.py:182-195`).
- **Drag-to-reorder rule priority.** All 23 rules sit at priority 100; he has never needed
  it. The useful 10% of this is the conflict warning in 001; the reordering UI is the
  useless 90%.
- **Budgets, forecasting, net worth, goals.** Standard personal-finance surface area that
  touches neither the time nor the doubt of closing the month.
- **A mobile-first redesign.** This runs on a laptop in Docker on the LAN. The narrow
  breakpoint should not be *broken* (the 1100px canvas clip is folded into backlog #10),
  but nobody categorises 862 transactions on a phone.
- **A charting library.** The runbook forbids CDN/remote assets and there is no build
  step. The canvas chart needs ~40 lines of axis code, not a dependency.
- **Bulk "Apply" without creating rules.** Tempting as a way to empty the queue, but it
  teaches the system nothing, so next month's import is just as bad. See 002 §C.
- **Drill-down from an Insights cell to its transactions.** Right idea, premature: 75% of
  cells are 0.00 and the honest headline is "−12,983 uncategorized". Valuable *after* the
  queue is cleared. Deferred, not rejected. **Built in [006](features/006-balance-trend-and-drilldown.md)
  (backend filter) + [009](features/009-balance-trend-chart-category-drilldown.md)
  (frontend sort + click-to-drill-down), iteration 2 sessions 3 and 7** — the "premature"
  concern didn't block it in the end; the category table already existed and the filter
  was cheap to add once 006 was building adjacent endpoints anyway.
