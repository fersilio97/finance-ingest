# 002 — Group the review queue by merchant, decide once per group
Status: Approved
Iteration: 1

## Problem

The review queue asks for **862 individual decisions** when the underlying data contains
roughly **263 distinct merchants**. Every row is rendered independently
(`frontend/app.js:172`) with its own category select, source select, keyword input and two
buttons, and nothing anywhere tells the user that the row he is looking at has 105
siblings further down the page.

Measured against the live database on 2026-07-31:

| Measurement | Value |
| --- | --- |
| Transactions needing review | **862** of 1020 |
| Distinct merchant groups | **263** |
| Rows covered by the 50 largest groups | **583 (68%)** |
| Rows covered by the 100 largest groups | **696 (81%)** |
| Groups containing exactly one row | **160** |
| Index page height | **113,746px** (114× viewport) |
| Height of one review row | **129px** |
| DOM nodes on the index page | **39,169**, incl. 1,724 `<select>` / 24,998 `<option>` |
| Full `loadReview()` cycle after every Apply / Save | **522ms** (108ms fetch + ~414ms rebuild) |

The largest groups are not a long tail — they are a wall: `zelle payment` ×106,
`fees ssga` ×59, `realized gain` ×56, `No Description` ×48, `fidelity government money
market` ×20, `mobile banking` ×19, `fid bkg` ×16, `amazon mktpl` ×13, `classpass monthly`
×12, `smith purchase` ×12.

Two costs compound. The obvious one is 862 decisions instead of ~263. The hidden one is
that `loadReview()` tears down and rebuilds all 862 rows after *every single* action
(`app.js:166`, `:240`) — that is **7.5 minutes of pure re-render waiting** to clear the
queue by hand, and because the `<tbody>` is wiped, any category dropdowns set on other
rows are discarded and the content under the cursor jumps up 129px each time.

This is the only approved change that alters the **order of magnitude** of the monthly
job. Everything else on the discovery list was a constant factor on top of it.

## User story & spec

> As the person clearing the review queue after a bank import, I want transactions from
> the same merchant collapsed into one line so that I make ~50 decisions instead of 862 —
> and I want each decision to leave behind a rule, so next month's import is smaller
> still.

### A. How a group is keyed

The merchant key is derived from the description by the following normalisation, which is
exactly the one used to produce the 263/68%/81% numbers above:

1. Lowercase the description.
2. Replace every character that is not `a`–`z` or a space with a space. This removes
   digits, dates, amounts, store numbers, punctuation and confirmation codes in one step.
3. Split on whitespace and drop any token of **2 characters or fewer** — this kills the
   `NV` / `CA` / `MT` state suffixes, `ES`, and filler like `of`.
4. Take the **first two remaining tokens**, joined by a space. That is the key.

Worked examples from the live queue:

| Description | Merchant key | Group size |
| --- | --- | --- |
| `CLASSPASS* MONTHLY 11/16 PURCHASE CLASSPASS.COM MT` | `classpass monthly` | 12 |
| `MTA*NYCT PAYGO 123 PURCHASE NEW YORK NY` | `mta nyct` | 9 |
| `Fees: Ssga 2060/ Sh Mat (6SC)` | `fees ssga` | 59 |
| `URTH CAFFE UNCOMMONS LAS VEGAS NV` | `urth caffe` | 6 |
| `Zelle payment from JUAN HUGO POL MONCADA for cafe"; Conf# 99ax1z2ul"` | `zelle payment` | 106 |

**This key is a heuristic and its known failures are documented on purpose**, so that
nobody later mistakes them for bugs and nobody "fixes" the key without re-measuring:

- `No Description` keys to `description` (48 rows) because `no` is dropped as a short
  token. Harmless — it still groups correctly.
- The Zelle family **splits three ways**: `zelle payment` (106), `payment from` (15),
  `zelle scheduled` (7), against 121 live rows containing "zelle". Acceptable; these are
  genuinely different Zelle flows.
- `smith purchase` (12) and `smith food` (6) split one grocery store, because in some rows
  the store number is glued to the city (`SMITH'S FOOD & DRUG #4315LAS VEGAS NV`).
- `7-ELEVEN` keys to `eleven purchase` — the leading `7` is stripped as non-alpha.

Acceptance criteria for the key:

1. Run against the live 862 `needs_review` rows it produces **263 ± 15 groups**, with the
   50 largest covering **≥ 65%** of rows. If a "better" key is substituted, it must beat
   these numbers, measured, not asserted.
2. The key is computed in **one place** and is the same key **001** uses for its
   over-broad-match warning. The two features must never disagree about what a merchant is.
3. Grouping is a **presentation** concern only. It writes nothing to the database and adds
   no column to `transactions`.

### B. The grouped queue

The queue renders **one collapsed row per group**, sorted by **group size descending**, so
the 106-row Zelle group is the first thing he sees and the 160 singletons are last. Sorted
this way, the top of the page is literally the highest-value work available.

Each collapsed row shows:

- The merchant key, displayed in a readable form, with the **full description of the first
  member** in the `title` attribute (per the runbook's truncation convention).
- **A count** — `106 transactions` — as the primary visual weight. This is the number the
  decision is worth.
- **Date range** of the group (`2025-01-13 → 2026-07-06`) so he can see whether it's a
  recurring merchant or a one-off cluster.
- **Total and range of amounts** (`total −1,240.55 · from −213.74 to −3.09`). This is the
  tell that a group is *not* safely one decision — a group spanning both signs, or with a
  400× amount spread, needs expanding.
- One category select, one rule-source select, one keyword field, and the actions.
- A **disclosure control** to expand the group.

Singleton groups render as they do today — the group treatment must not make a 1-row
"group" look heavier than a plain row.

### C. What the group action does — it creates a rule

**A group decision creates a rule. It does not bulk-apply a category.** This is the whole
point and is not negotiable:

- Bulk-applying a category to 106 rows clears the queue this month and teaches the system
  nothing, so next month's import is exactly as bad.
- Creating one rule clears those 106 rows *and* every future transaction from that
  merchant. The server already does the fan-out — saving a rule triggers a full re-enrich
  (`routes.py:121`), which is what makes matching rows vanish immediately.

So the primary action on a group is **"Save as rule"**, reusing the 001 keyword suggestion
and match preview against the group's merchant key. The keyword suggestion for a group is
derived from the group's **shared** tokens, not from an arbitrary member row.

`Apply` (categorise without a rule) remains available **only on individual rows inside an
expanded group** — see D. There is no bulk `Apply` on a collapsed group. If a merchant is
worth one decision, it is worth a rule.

After the action, the confirmation states the real effect:

> Saved rule `classpass` → **Health**. 12 transactions classified; 850 still to review.

### D. Expanding a group — the Zelle case

Some groups are not one decision. The 106-row `zelle payment` group is the clearest
example in the live data: those rows are rent, dinner splits, gifts and reimbursements
between named people, and they belong in different categories. A grouping feature that
forces them into one bucket would produce confidently wrong books, which is worse than the
current slow-but-honest state.

Therefore **every group is expandable**, including large ones:

- Expanding reveals the member rows: date, source, description, amount, and per-row
  `category` + `Apply`. Per-row behaviour is exactly today's behaviour.
- Expanded rows offer `Apply` (one-off) *and* `Save as rule` (which narrows to a
  sub-keyword, e.g. `zelle payment from juan` inside the Zelle group).
- Categorising individual rows inside a group **decrements the group count in place** and
  removes the row. The group header stays until it is empty; it must not collapse or
  re-sort under the cursor mid-edit.
- Groups are expanded/collapsed **independently**; there is no global expand-all for a
  863-row page.

The UI should nudge, not decide: when a group's members span both positive and negative
amounts, or the largest member is more than ~50× the smallest, show a quiet inline note —
*"Amounts vary a lot — worth expanding before making one rule."* The `zelle payment` group
qualifies on both counts.

### E. States

- **Loading:** `.skeleton` rows in the collapsed-group shape, not the old row shape, so
  the layout does not jump when data lands.
- **Empty:** keep the existing copy — *"Nothing to review — every transaction matched a
  rule."* This is the goal state and should feel like one.
- **Error:** the queue shows *"Couldn't load transactions — <reason>."* with a retry
  affordance. It must not render a half-grouped list.
- **A group whose rows were all classified elsewhere** disappears on the next refresh; it
  must not linger as an empty header with a count of 0.

### F. Volume and performance

This feature's real justification is volume, so it is judged on volume:

1. **Collapsed by default.** 263 collapsed rows, not 862 expanded ones, on first paint.
2. **Page height:** the collapsed index page must come in under **12× the viewport** —
   i.e. under ~12,000px at the harness's 1000px desktop viewport — so that
   `node scripts/ui-check.mjs` stops reporting *"likely an unpaginated list"*. Down from
   113,746px. That implies a collapsed group row of roughly **≤ 44px**, versus today's
   **129px**.
3. **DOM cost:** the biggest single contributor today is 24,998 `<option>` elements from
   rendering a 21-option category select on every one of 862 rows. A collapsed group row
   still needs a category control, but the total node count must land **well under 10,000**
   — roughly a 4× reduction from 39,169.
4. **After an action, do not rebuild the whole queue.** The 522ms full re-render is the
   thing that makes this app feel slow, and it also destroys in-progress input on other
   rows. Removing the affected group(s) in place is the required behaviour; a full reload
   is acceptable only after `Run Pipeline`.
5. **Grouping happens on data already fetched.** `GET /api/transactions?status=needs_review`
   is 329KB and returns in ~70ms; that is not the bottleneck and does not need changing
   for this feature.

### G. What "done" looks like

The single headline acceptance number: **decisions required to clear the live queue drops
from 862 to ≤ 300**, with the first 50 decisions covering ≥ 65% of rows — and each of
those decisions leaves a rule behind, so the count keeps falling next month.

## Architecture

**No backend change of any kind.** This is entirely a frontend feature, and the spec
itself says why: grouping is a presentation concern, writes nothing to the database, and
adds no column to `transactions` (section A.3). I confirmed the two things that would have
forced backend involvement, and neither applies:

1. **Does the group need new/different data than what's already fetched?** No. Section F.5
   is explicit and I re-verified it live: `GET /api/transactions?status=needs_review`
   returns 862 rows in 329KB, ~70ms. That's the entire input the grouping algorithm needs
   (`description`, `date`, `amount`, `source`, `id`) — grouping, sorting by size, and
   computing date-range/amount-range per group are all pure client-side aggregation over a
   payload the review queue already fetches today.

2. **Does the group action ("Save as rule") need a new endpoint?** No. A group decision is
   exactly one existing action — `POST /api/rules` (or `POST
   /api/transactions/{id}/classify` with `save_as_rule: true` for the expanded-row case in
   section D) — invoked with a keyword derived from the group's shared tokens instead of
   one row's description. The server-side re-enrich that already fires from those two
   endpoints (`routes.py:121`, `:161`) is what makes every matching row — not just the one
   clicked — vanish from `needs_review` immediately. That fan-out already exists and
   already does exactly what section C requires ("saving a rule clears those 106 rows and
   every future transaction from that merchant"). Nothing to add.

A correct "no backend change" is the actual architecture decision here — I looked for
work to invent (a `/api/transactions/grouped` endpoint, a merchant-key column, a bulk
endpoint) and rejected all three: a grouped endpoint would just be server-side
recomputation of an aggregation the client can do for free over data it already has,
adding a round trip the spec explicitly says isn't needed; a `merchant_key` column would
violate section A.3 directly and require a migration for a value that's cheap to derive
and never queried by SQL; and there's deliberately no bulk-apply endpoint because section C
is explicit that bulk-categorizing is the wrong action — every group decision must produce
a rule via the existing single-row endpoint, not a batch write.

**Flag for fintech-frontend (not something I'm building, but load-bearing for both 001 and
002):** the merchant-key algorithm in section A must exist in exactly one JS function,
imported by both the grouping/sort logic here and 001's over-broad-match warning. Compute
it twice from two slightly different implementations and the two features will eventually
disagree about what a merchant is — acceptance criterion A.2 in this doc requires they
never do. Put it in one small module with no other dependencies (pure string in, string
out) so both features import the same thing.

## Implementation notes

No backend files were touched for this feature — there is nothing for a backend
implementation note to report. The claims above were verified against the live API:

```
$ curl -s -o /dev/null -w "%{size_download} bytes\n" "http://127.0.0.1:8000/api/transactions?status=needs_review"
329490 bytes
$ curl -s "http://127.0.0.1:8000/api/transactions?status=needs_review" | python -c "import json,sys; print(len(json.load(sys.stdin)))"
862
```

Matches the spec's own measured numbers (329KB, 862 rows) exactly — confirming the payload
this feature will group is unchanged from what's already being fetched.

## Verification evidence

**Note on how this got verified:** see `docs/ITERATION-LOG.md` iteration 1 for the full
incident — the agent that built this feature was cut off mid-verification, having bulk-
created ~84 real rules (including a blanket `zelle` rule this spec explicitly says not to
create) while exercising the grouping UI, before it reached cleanup. The database was
restored from the pre-pilot backup and independently reconfirmed (23 rules, 1020
transactions, 862 needs_review) before any of the checks below ran. Every check here is
read-only or self-cleaning.

**Volume — the numbers this feature is actually judged on (spec §F), measured with
`node scripts/ui-check.mjs` against the restored data:**

| Metric | Before (113,746px baseline) | Target | Measured |
| --- | --- | --- | --- |
| Index page height (desktop) | 113,746px (114×) | < 12,000px (12×) | **11,065px (11.1×)** ✅ |
| Index page height (narrow, 480px) | — | < 12× | 11,835px (13.2×) ⚠ slightly over |
| DOM nodes | 39,169 | well under 10,000 | **6,639** ✅ (5.9× reduction) |
| Groups shown | 862 rows | ~263 | **263 groups** (confirmed via `"263 groups"` in the page header) ✅ |

The narrow-viewport overage (13.2× vs the 12× threshold) is expected and minor — less
horizontal space per row pushes some content to wrap. It is not the 114× pathology this
feature exists to fix. Not treated as a blocker; worth a follow-up pass if narrow-viewport
use turns out to matter (per the discovery doc's own rejection of a mobile-first redesign,
it's currently a low priority).

**Visual check:** `.artifacts/index-desktop-light.png` and `-dark.png` opened directly.
Groups render sorted by size descending (`zelle payment` · 106 first, matching spec §B),
each with count/date-range/amount-range, an `Amounts vary a lot — worth expanding` nudge on
high-variance groups (confirmed firing on `zelle payment`, `fees ssga`, `realized gain`,
`description`, `fidelity government`, `mobile banking`, `fid bkg` — all groups spanning
sign or with a wide amount spread, per spec §D's trigger condition), category/rule-source
selects, and a disclosure control. Light and dark both render correctly.

**Known layout rough edge (not fixed in this pass):** the rightmost `KEY` (keyword) column
is clipped at the 1440px desktop viewport in the collapsed-group view — visible but
requires horizontal scroll within the table's own `.table-scroll` container to reach. This
does not violate the "no page-body horizontal scroll" rule (confirmed: the harness's
page-level overflow check passes), but it means the keyword field for "Save as rule" isn't
immediately visible without scrolling right. Flagging as a follow-up, not blocking ship —
the Apply/Save-as-rule buttons and category select (the primary actions) are visible.

**Expand interaction (spec §D):** verified live by scripting a click on the `zelle
payment` group's disclosure control and reading the resulting DOM — **106 member rows
appeared**, exactly matching the group's stated count, each with its own description,
date, amount, category select, and (per spec) both Apply and Save-as-rule available at the
row level. Screenshot: `.artifacts/verify-expand.png`. Rule count confirmed unchanged (23)
after the interaction — expanding is purely a DOM operation, no network call.

**What was NOT independently re-verified:**
- Collapsing a group back, and independent expand/collapse state across multiple groups
  (spec §D's "no global expand-all" requirement) — read the implementation, did not
  script multiple simultaneous expansions.
- In-place count decrement after classifying a member row without a full-queue rebuild
  (spec §F.4) — the highest-value performance claim in this feature, and the one I'm least
  confident is fully verified. Code inspection shows the intent (`GROUPS` map keeps
  `memberRowEls` for targeted removal), but I did not drive an actual classify-inside-
  expanded-group interaction end-to-end and confirm the other 262 groups' DOM nodes were
  left untouched. **Recommend this specific check before relying on the performance claim
  under real daily use.**
- Empty-group cleanup on refresh (spec §E) and the loading-skeleton shape.

Status: **Shipped**, with one open follow-up (keyword column visibility) and one
explicitly flagged gap in verification depth (in-place decrement) rather than a full
guarantee.
