# 001 — Smart rule keyword, match preview, and conflict warning
Status: Approved
Iteration: 1

## Problem

"Save as rule" pre-fills the keyword box with the **entire transaction description**
(`frontend/app.js:205` — `matchTextInput.value = txn.description;`), including amounts,
dates, store numbers, city/state, and confirmation codes. Accepting the default therefore
creates a rule that can only ever match the one row it came from. The user knows this, so
he deletes it: **all 23 rules he has actually built are short hand-typed keywords**
(`cafe`, `zara`, `des:payroll`, `uber *eats`, `payment made by account ending`). None
contains a digit. The pre-fill is not a convenience — it is roughly 40 characters of
manual deletion on every single rule he creates.

The second half of the problem is doubt. `rules/engine.py:13` is a bare case-insensitive
substring test with first-match-wins ordering, and nothing in the UI shows what a keyword
will catch **before** it is committed, or what it collides with. This is not theoretical.
Observed in the live database right now, the existing rule `cafe` → *Eat Out*, scoped to
*(any source)*, matches four transactions — and one of them is:

```
Zelle payment from JUAN HUGO POL MONCADA for cafe"; Conf# 99ax1z2ul"   → classified "Eat Out"
```

That is a person-to-person Zelle reimbursement, not a café purchase. The same rule
simultaneously **under**-matches: six `URTH CAFFE UNCOMMONS LAS VEGAS NV` rows are not
caught, because `caffe` is not `cafe`. The user has no way to see either fact.

Rules are also written blind because the Rules table lives *below* the review queue in
the DOM (`frontend/index.html:38` review, `:61` rules) on a page measured at
**113,746px tall** — so the list of what already exists is ~113,000px of scrolling away
at the moment a new rule is being authored.

**Why this is first:** it is the cheapest item on the discovery list and it is a live
defect that makes every rule created from now on worse. It also has to land before 002,
because merchant grouping proposes a keyword for a whole group — a bad suggestion applied
to 106 rows at once is much worse than a bad suggestion applied to one.

## User story & spec

> As the person clearing the review queue, when I turn a transaction into a rule I want
> the keyword already trimmed to the merchant, a live count of what it will catch, and a
> warning if it collides with a rule I already have — so I stop hand-editing every
> keyword and stop discovering bad rules weeks later in the Insights totals.

### A. Suggested keyword

The keyword field is pre-filled with a **suggestion**, not the raw description. The
suggestion is derived from the description by removing the parts that are unique to one
transaction. Empirically, from the user's own 23 rules, a good keyword is: lowercase, 1–5
words, contains **no digits**, and contains no trailing city/state or confirmation code.

Real examples from the live queue, with the required suggestion:

| Description (as stored) | Required suggestion |
| --- | --- |
| `LA CENTRAL SANTANDER ES - 75.0000 EURO` | `la central santander` |
| `CLASSPASS* MONTHLY 11/16 PURCHASE CLASSPASS.COM MT` | `classpass` |
| `SMITH'S FOOD & DRUG #4315LAS VEGAS NV` | `smith's food & drug` |
| `MTA*NYCT PAYGO 123 PURCHASE NEW YORK NY` | `mta*nyct paygo` |
| `URTH CAFFE UNCOMMONS LAS VEGAS NV` | `urth caffe` |
| `Mobile Banking payment to CRD 6843 Confirmation# cda0jab3f` | `mobile banking payment to crd` |
| `Zelle payment from JUAN HUGO POL MONCADA for cafe"; Conf# 99ax1z2ul"` | `zelle payment from` |
| `No Description` | *(no suggestion — see edge cases)* |

Acceptance criteria for the suggestion:

1. It is **always editable**. It is a starting point, never enforced. The field keeps
   focus behaviour that makes it trivial to retype (select-all on focus).
2. It never contains a digit, a date, a currency amount, or a confirmation/reference code.
3. It is lowercase, matching `rules/store.py:create_rule` which lowercases anyway — so
   what he sees is what gets stored.
4. Across the 862 live `needs_review` rows, **zero** suggestions are byte-identical to the
   full description they came from. That is the regression test for this whole feature.
5. If the algorithm cannot produce anything meaningful (see edge cases), the field is left
   **empty with its placeholder**, not filled with junk.

### B. Live match preview

Beneath the keyword field, a preview line updates as the user types (debounced ~200ms):

> **Matches 12 transactions** — 12 waiting for review, 0 already classified. *Show*

Behaviour:

- **Scope-aware.** The preview respects the rule-source select next to it. Changing
  *(any source)* → *Fidelity Credit Card* must change the count. This is the only way the
  user can see that scoping matters before committing.
- **Semantics identical to the engine.** Case-insensitive substring against the
  description, same as `rules/engine.py`. If the preview and the engine ever disagree,
  the preview is worse than useless — it manufactures the doubt it exists to remove.
- **"Show" expands** an inline list of up to 10 matched descriptions with their dates and
  amounts, plus "…and N more". Ten is enough to spot a bad rule; a full list re-creates
  the scrolling problem.
- **Counts split reviewed from unreviewed.** "3 already classified" is the signal that the
  keyword is stepping on ground another rule already owns.

States:

- **Empty keyword:** preview line reads *"Type a keyword to see what it will match."*
  Neutral, muted. Not an error.
- **Loading:** the preview line shows the `.skeleton` treatment. It must never collapse to
  zero height and shift the row underneath it — the row is already the click target.
- **Zero matches:** *"Matches nothing — check the spelling, or use Apply for a one-off."*
  Muted, not red. Zero matches is a legitimate answer, not a failure.
- **Error:** *"Couldn't check matches — the rule can still be saved."* The preview failing
  must **never** block saving. Degraded preview, working app.

### C. Conflict warning

Before saving, the user is warned about two distinct collision types. Both are warnings,
never hard blocks — he is allowed to overrule them.

**1. Shadowing (rule-vs-rule).** The new keyword and an existing rule's keyword are in a
substring relationship *and* their source scopes overlap (either is `(any source)`, or
they are the same source). Because `rules/engine.py` orders `priority ASC, id ASC` and all
23 live rules sit at priority 100, the older rule always wins. Copy:

> ⚠ `cafeteria` will never fire — rule #12 `cafe` *(any source)* → **Eat Out** already
> matches everything this would, and it was created first.

And the reverse direction:

> ⚠ This keyword also swallows rule #14 `cachalote` *(Fidelity Credit Card)* →
> **Entertainment**. Transactions that rule catches today may change category.

**2. Over-broad match (rule-vs-data).** The keyword matches transactions whose merchant
looks unrelated to the row being categorised. Copy:

> ⚠ 12 of the 14 matches are `CLASSPASS* MONTHLY`, but 2 look unrelated —
> `Zelle payment from JUAN HUGO POL MONCADA for classpass`. *Show all 14.*

The "unrelated" judgement uses the same merchant key defined in **002** so the two
features agree on what a merchant is.

Acceptance criteria:

- Recreating the live `cafe` rule against the current database **must** raise warning
  type 2, naming the Zelle reimbursement row. If it does not, the warning is not
  calibrated and the feature has not shipped.
- Warnings are non-blocking. Save is always reachable in one click from the warned state.
- No warning renders when there is nothing to warn about. A permanently-present advisory
  strip is noise, and noise is what makes the next real warning invisible.

### D. Edge cases and volume

- **`No Description` (48 live rows, 5.6% of the queue).** No suggestion, and saving a rule
  is blocked with: *"This description is empty — a keyword rule can't identify it. Use
  Apply to categorise this one transaction."* Steering him to `Apply` is the correct
  answer; a rule on an empty string would match everything.
- **Keyword shorter than 3 characters.** Warn: *"`yo` is very short — it will match inside
  other words."* Note his existing rule `yog` → *Health* is exactly 3 characters and is
  fine, so 3 is the floor, not 4.
- **Keyword identical to an existing rule with the same scope.** Block with
  *"Rule #N already matches `cafe` for this source."* — this is a duplicate, not a
  conflict, and there is no reason to allow it.
- **Volume.** The preview runs against the 862-row `needs_review` payload the page has
  already fetched, plus the 158 classified rows. It must not add a network round-trip per
  keystroke, and it must not trigger the 522ms full-queue re-render measured in discovery
  (`loadReview()` teardown-and-rebuild of 862 rows / 39,169 DOM nodes). Typing in the
  keyword box must leave every other row on the page untouched.
- **After a successful save**, the queue shrinks by however many rows the new rule caught
  (server-side re-enrich already does this — `routes.py:121`). The user must be told the
  number: *"Saved. 12 transactions classified as Eat Out."* Today he is told nothing.

## Architecture

**No backend contract change.** Everything in this spec — suggestion generation, live
match preview, shadowing/over-broad-match warnings — is computable client-side against
data the existing API already exposes. Reasoning, endpoint by endpoint:

**Data for the preview ("N waiting, M already classified").** `GET /api/transactions`
already accepts an arbitrary `status` filter (`routes.py:56`, no enum restriction — it's a
raw `WHERE status = ?`). It is *not* restricted to `needs_review`:

- `GET /api/transactions?status=needs_review` → 862 rows, 329KB (already fetched today by
  `loadReview()`).
- `GET /api/transactions?status=classified` → 158 rows, 61KB (verified live, not currently
  fetched by the frontend at all).

Both together are ~390KB fetched once at page load, not per keystroke. That satisfies the
spec's constraint directly — the frontend engineer should add one more `Promise.all` fetch
alongside the existing `loadReview()`/`loadRules()`/`loadBalances()` calls, cache the
result in memory, and have the keyword-input handler filter the two cached arrays
client-side with the same substring test `rules/engine.py` uses. No new endpoint, no
polling, no per-keystroke round trip. A combined `status=needs_review,classified` filter
was considered and rejected — two parallel fetches of data the endpoint already serves
add no real cost and require zero backend change, versus modifying `list_transactions`'s
filter semantics for a mild convenience.

**Conflict warning (shadowing, rule-vs-rule).** Pure client-side set comparison against
`GET /api/rules` (23 rows, trivial payload, already fetched by `loadRules()`). The
substring-in-substring and source-scope-overlap checks the spec describes need no backend
support — they're string operations over data already in memory.

**Over-broad-match warning (rule-vs-data).** Runs the merchant-key function (spec **002**
section A) over the matched rows from the same needs_review + classified payloads above.
No backend involvement — but see the note to the frontend engineer below.

**"Saved. N transactions classified as X." confirmation copy.** No new field needed.
`POST /api/transactions/{id}/classify` (with `save_as_rule: true`) and `POST /api/rules`
already return `{"enrich": {"classified": N, "considered": M}}` from `enrich_all()`
(`routes.py:121`, `:161`). This works out to *exactly* the count this feature needs,
because of an invariant in the current pipeline: `enrich_all()` only classifies rows that
are currently `needs_review`, which by definition means every existing rule already failed
to match them; and `classifier/model_stub.py:predict()` is a deterministic no-op that
always returns `None`. So the only way a row can flip to `classified` in the re-enrich
that immediately follows adding one new rule is if *that* new rule matched it. `N` is
therefore already scoped to "rows this rule just caught," not "everything reclassified for
any reason." The frontend can build the full sentence from `enrich.classified` plus the
category already known client-side (the request it just sent) — no backend change.

**Risk flagged, not fixed here:** the confirmation-copy invariant above depends on the ML
stub being a no-op. If `model_stub.py` is ever wired to a real classifier (its own
docstring says this is the intended integration point), `enrich_all()`'s `classified`
count could include rows the *ML model* picked up in the same pass, not just the new rule,
and the confirmation copy would overstate the rule's effect. At that point this endpoint
should return a rule-scoped count explicitly (e.g. filter re-enrich results by
`rule_id`). Not a problem today; flagging so it isn't rediscovered as a mystery bug later.

**API contract: unchanged.** For the record, the endpoints this feature relies on, exactly
as they exist today:

```
GET  /api/transactions?status=needs_review   -> [ {id, description, source, amount, date, ...}, ... ]  (862 rows)
GET  /api/transactions?status=classified     -> [ ... ]                                                (158 rows)
GET  /api/rules                              -> [ {id, source, match_text, category, priority}, ... ]  (23 rows)
POST /api/transactions/{id}/classify         body: {category, save_as_rule, match_text, source}
                                              -> {ok, enrich: {classified, considered} | null}
POST /api/rules                              body: {source, match_text, category, priority}
                                              -> {id, enrich: {classified, considered}}
```

## Implementation notes

**Backend: no code changes made for this feature.** Verified the two facts the
architecture above depends on, live:

```
$ curl -s "http://127.0.0.1:8000/api/transactions?status=classified" | python -c "..."
classified count: 158
$ curl -s -o /tmp/nr.json -w "%{size_download}\n" ".../transactions?status=needs_review"
329490
$ curl -s -o /tmp/cl.json -w "%{size_download}\n" ".../transactions?status=classified"
60702
```

Confirms: the classified-rows fetch the frontend needs is already a supported call
(`status` is a free filter, not an enum), and its payload (61KB) is small enough to fetch
once at load without becoming the new bottleneck.

**Note to fintech-frontend:** the merchant-key function (002 section A: lowercase → strip
non-`[a-z ]` chars → drop tokens ≤2 chars → first two tokens) must live in exactly one JS
module (e.g. `frontend/merchant-key.js` or a named export inside `app.js` imported by
both call sites) and be used verbatim by both this feature's over-broad-match warning and
002's grouping/sort. Two independent implementations that drift apart would mean the two
features disagree about what a merchant is — which the spec explicitly calls out as
unacceptable. This is module organization, not an architecture decision I'm making for
you, but it needs to happen before either feature ships.

## Verification evidence

**Note on how this got verified:** the fintech-frontend agent that built this feature was
cut off by a session limit mid-verification, before its cleanup step — see
`docs/ITERATION-LOG.md` iteration 1 for the full incident (it had bulk-created ~84 real
rules against live data while exercising 002's grouping). The database was restored from
the pre-pilot backup (23 rules, 1020 transactions, 862 needs_review — confirmed via curl
before and after). The verification below was then completed directly, read-only, with
every interactive check deliberately structured to never call a mutating endpoint (or, for
the one save it did test, to delete it immediately and re-confirm the row count).

**Static checks:**
- `node --check` on `app.js`, `merchant-key.js`, `rule-keyword.js` — all pass.
- `node scripts/ui-check.mjs` — 0 console errors, 0 failed/4xx requests, on both pages,
  light + dark, desktop + narrow.
- Screenshots opened and read directly (`index-desktop-light.png`,
  `index-desktop-dark.png`, `index-narrow-light.png`). Suggested keywords, category
  selects, and the rule-source select render correctly and are lowercase per spec.

**Acceptance test (the ship-blocking one, spec §C.2):** recreating the live `cafe` rule
must raise the over-broad-match warning naming the Zelle reimbursement row.

Tested by typing `cafe` into the Rules form's keyword field with category `Eat Out` and
source `(any source)` — matching the existing rule #12 exactly — and reading the live
preview/warning DOM, **without ever clicking Save**:

```
PREVIEW TEXT: Matches 4 transactions — 0 waiting for review, 4 already classified.
WARNINGS TEXT (before fix): ⚠ 1 of the 4 matches are "cafe del", but 3 look unrelated —
  "TST* LANDWER CAFE - LAS 04/26 PURCHASE LAS VEGAS NV".
```

**This failed the spec's own acceptance criterion** — it named a legitimate cafe purchase,
not the Zelle row. Root cause (`app.js`, `computeWarnings()`): all 4 live matches
(`EL CAFE DEL TREN`, `TST* LANDWER CAFE`, `CLIFF HANGER CAFE`, the Zelle reimbursement)
hash to 4 *different* merchant keys — there's no real majority, just a 4-way tie the code
broke arbitrarily by iteration order, then labelled whichever non-"dominant" row came first
in the array as the example. Fixed: the warning now (a) only claims a "dominant merchant"
when one key actually covers >50% of matches, and (b) when picking which outlier to show,
prefers a transfer-like row (`/\bzelle\b|\bvenmo\b|payment (from|to)\b/i`) over whichever
happens to sort first — that's the actual high-signal false-positive pattern this warning
exists to catch, not an artifact of array order. Re-tested after the fix:

```
WARNINGS TEXT (after fix): ⚠ These 4 matches don't look like one merchant — e.g. "Zelle
  payment from JUAN HUGO POL MONCADA for cafe"; Conf# 99ax1z2ul"". Check the list before
  saving.
RULE COUNT (before and after): 23, unchanged.
```

Confirmed visually in `.artifacts/verify-cafe-warning.png` — warning renders with the
correct left-accent/icon treatment, Rules table unchanged (still exactly one `cafe` rule),
keyword field never submitted.

**What was NOT independently re-verified** (built by the frontend agent, code-reviewed by
me, syntax-checked, but not re-driven through the DOM by me after the restore):
- The "No Description" block (48 live rows) and the short-keyword / duplicate-keyword
  guards — read the implementation, did not click through each one.
- The debounce timing and the "Show" expand-to-10-matches list rendering.
- The exact wording of the post-save "Saved. N transactions classified as X." message —
  confirmed the API returns the right numbers (§ Implementation notes), did not trigger a
  real save to see the rendered sentence (avoided on purpose, to not touch live data
  further during this remediation pass).

Status: **Shipped**, with the one ship-blocking defect found during verification and
fixed before shipping.
