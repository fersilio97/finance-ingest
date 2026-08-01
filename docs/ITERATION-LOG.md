# Iteration Log

A record of each pass through the feature loop: what was proposed, what the user
approved or rejected, what actually shipped, and what we learned.

The loop: **discover** (UX lead explores the running app) → **gate** (user approves) →
**spec** (UX) → **design** (architect) → **build** (architect backend, frontend UI) →
**verify** (real browser, screenshots reviewed) → **document**.

---

## Iteration 1 — pilot

**Started:** 2026-07-31
**Baseline before starting:** 23 rules, 1020 transactions, 862 needs_review (158
classified), 0 manual balances.

### Proposed

`fintech-ux-lead` explored the running app (screenshots + read-only API calls) and
returned 10 ranked candidates, grounded in measured numbers against the live database.
Full list, evidence, and rejections: `docs/FEATURES.md` backlog section. Top of the
ranking:

1. Group the review queue by merchant (862 decisions → ~263)
2. Smart rule keyword + match preview + conflict warning (the existing pre-fill was
   costing ~40 characters of manual deletion per rule, on all 23 real rules)
3. Paginate/window the queue (partly subsumed by #1)
4. All-transactions view (undo + explainability in one screen)
5. Stop the reconciliation panel's 22 false MISMATCH pills
6. Insights: lead with unclassified total
7–10: non-spend routing, row layout, pipeline summary text, chart axes

### Approved / rejected

User approved **#2 (rule keyword/preview), #1 (merchant grouping), #5 (reconciliation
states)** — shipped this iteration as features 001, 002, 003. Explicitly deferred (not
rejected): #3, #4, #6, #7, #8, #9, #10 — carried in the backlog table for iteration 2.

### Incident: agent-caused data mutation during verification, and recovery

Mid-iteration, the `fintech-frontend` agent building 002 (merchant grouping) was
terminated early by a session-length limit while exercising the grouping UI to verify it —
**before reaching its cleanup step.** It had bulk-created **~84 real rules** against the
live database, including a blanket `zelle` → Transfer rule that directly contradicts what
002's own spec says (§D: Zelle payments are genuinely ambiguous — rent, splits, gifts —
and must stay individually reviewed, never bulk-ruled). Rule creation re-enriches
automatically, so this had a real side effect: **681 transactions were silently
reclassified** (158 → 839 classified) before anyone reviewed the resulting rules.

**Caught by:** the routine data-safety check I run before handing work to the next agent
in the loop (`GET /api/rules` count vs. the recorded baseline) — 107 rules where 23 were
expected.

**Fix:** the database was restored from the backup taken immediately before any agent
touched it (`data/finance.db.bak-20260731`, captured right after the pre-pilot checkpoint
commit). Restored state independently reconfirmed via curl: 23 rules, 1020 transactions,
862 needs_review, 0 manual balances — exactly the baseline. The polluted database was
preserved, not deleted, at `data/finance.db.bak-pilot-polluted-20260731-2048` (gitignored)
in case any of those 84 rules are worth reviewing by hand later. Stray debug files the
agent left (`backend/server*.log`, a temp Playwright script) were also removed.

**What was NOT lost:** the agent's actual code (frontend JS/CSS/HTML) — code isn't data,
and none of it needed reverting. It was reviewed, syntax-checked, and (after the DB
restore) verified against clean data directly.

**Root cause:** the agent's own role definition and its task instructions both said to use
throwaway/minimal test interactions and clean up afterward — but nothing enforced that
before a session limit could cut it off mid-sequence. "Clean up when you're done" is not a
safe pattern for an agent that can be terminated at an arbitrary point.

**Process changes for future iterations:**
- Prefer **read-only verification** wherever the spec allows it (e.g. typing into a live-
  preview field and reading the DOM, never clicking Save) over interactions that mutate
  real data — this is how the remaining verification in this iteration was done.
- Where a mutation genuinely must be tested (e.g. 003's balanced/off states, which have no
  live coverage), **clean up immediately after that single test**, not "at the end of
  verification" — don't batch cleanup for later in the same session.
- Take a fresh DB backup before resuming any agent whose session was interrupted
  mid-task, and re-run the rule/transaction count check immediately after any agent
  session that had write access, not just at iteration boundaries.
- Consider capping how much verification breadth one agent invocation attempts —
  this agent was implementing AND verifying all three features in one long session,
  which is likely why it ran long enough to hit the limit before reaching cleanup.

### Shipped

All three approved features shipped, verified against the restored clean database, with
one bug found and fixed in each during verification (see each feature doc's Verification
evidence for full detail):

- **001** (keyword/preview/conflict): the over-broad-match warning's example-selection
  logic was picking an arbitrary outlier instead of the actual anomaly when there was no
  real majority merchant among the matches — found via the spec's own ship-blocking
  acceptance test (recreating the `cafe` rule), fixed, re-verified.
- **002** (merchant grouping): page height 113,746px → 11,065px desktop (11.1×, under the
  12× target), DOM nodes 39,169 → 6,639 (5.9× reduction, target was "well under 10,000").
  Expand interaction verified live (106 member rows appeared on click). One open follow-up,
  not blocking: the keyword column is clipped at 1440px and needs horizontal scroll within
  its own table container.
- **003** (reconciliation states): the live "22 false MISMATCH" bug fully fixed —
  confirmed 22/22 `Not checked`, zero red, in both light and dark. The `balanced`/`off`
  states had zero live coverage, so both were synthetically tested and immediately cleaned
  up. Found and fixed a layout bug (account/month identity crushed to `"B..."` by fixed-
  width siblings) during this verification.

`node scripts/ui-check.mjs` also gained a DOM-node-count check (alongside the existing
page-height check) during this iteration — a permanent addition, not iteration-specific,
since 002's volume claims needed it.

### Learned

- The three-agent loop produces genuinely good specs and code — the UX discovery's
  merchant-clustering finding (862 decisions are really ~263) and the keyword-pre-fill
  finding (a live tax on every rule ever created) were both things I hadn't seen despite
  having built this app across several prior rounds.
- The loop's biggest risk isn't code quality, it's **an agent with write access to real
  data being cut off mid-task.** The safety rules embedded in each agent's role definition
  ("clean up after yourself") are necessary but not sufficient — they assume the agent
  reaches its own end state, which isn't guaranteed. The coordinator (not the agent) has
  to be the one that verifies data integrity after every handoff, not just trusts the
  agent's self-report.
- Read-only verification (type into a field, read the DOM, never submit) turned out to be
  sufficient to check most of what mattered in this iteration, including the single most
  important acceptance test (001's cafe-rule warning). Worth defaulting to this pattern
  before reaching for a mutating test.

---

## Iteration 2 — direct feedback, not a fresh discovery pass

**Started:** 2026-08-01 (continuing from iteration 1's baseline: 23 rules, 1020
transactions, 862 needs_review, 0 manual balances).

Unlike iteration 1, this round did not start with `fintech-ux-lead` exploring the app
cold — the user reviewed the running app directly and gave feedback across six areas:
upload visibility, pipeline clarity, needs-review grouping (specifically "why didn't
IN-N-OUT group?"), the rules table's "(Any source)" label, exact-timestamp balance
entries, and the insights page (balance trend, category table, reconciliation). The loop
still ran discover→design→build→verify→document per feature, just gated by direct user
critique instead of a ranked UX proposal.

### Shipped

Seven sessions, spanning backend (`uploads` table, `balance_entries` table replacing
`manual_balances`, reshaped `/api/insights/balance-trend`, `category`/`month` filters on
`GET /api/transactions`) and frontend (drop-zone stats/staleness, exact-datetime balance
entry UI, per-entry dynamic reconciliation, a full balance-trend chart rework with
time-based axes and a hover tooltip, sortable+drill-down category table, an
account-balance strip) — features 004–009, all in `docs/features/`. Two smaller follow-up
sessions closed out the remaining direct-feedback gaps: naming which sources/files are
pending next to the Run Pipeline button, and fixing `merchantKey()` so leading short-token
brand names (IN-N-OUT: 6 keys → 2; five more cases fixed the same way across the dataset)
group correctly instead of being silently dropped.

One item was investigated and explicitly deferred rather than fixed: the residual
IN-N-OUT row with no separator between "OUT" and "WASHINGTONCITY" in its raw description
is a data-glue defect, not a short-token problem — out of scope for the merchant-key fix.

### Incident (near-miss, self-caught): uncommitted work across seven sessions

**None of this iteration's work was committed to git until the very end.** Sessions 1–7
ran sequentially/in parallel across a long working session, all landing as uncommitted
working-tree changes — by the time the checkpoint commit finally happened, it was ~1,900
lines across 12 files. Mid-iteration, the coordinator (this session) entered plan mode to
address a new round of user feedback, which interrupted Session 7's `fintech-frontend`
agent mid-verification — structurally the same risk iteration 1's incident called out
(an agent cut off before reaching a clean stopping point), except this time the agent
**detected plan mode itself and stopped cleanly**, writing a handoff plan describing
exactly what was done and what remained, rather than requiring the coordinator's
rule-count check to catch a bad state after the fact. Nothing was lost, but it was closer
to a real loss than it should have been: seven sessions of work had no checkpoint at all
until the coordinator committed it as the first action of the next session, purely by
habit rather than by any enforced process step.

**Process change for iteration 3:** checkpoint-commit after each session (or every 2–3),
not only at iteration boundaries. A commit is cheap and reversible; hours of uncommitted
agent work sitting in the working tree is not.

### Note: baseline drift during the session was real user activity, not an agent bug

Partway through, `rules` count moved 108 → 109 → 112 and `needs_review` dropped
315 → 304 while three agents were working. Every agent's own report claimed zero
mutations, which — per iteration 1's incident — is exactly the situation that deserves
verification, not trust. Checking the actual new rule rows (not just the count) showed
plausible, human-created category rules (`oakley.com` → Clothes, `nv energy` → Housing,
`transaction fee` → Banking, `spirit airl` → Trips) created at real, spaced-out
timestamps — the user was working the review queue live in a browser tab while the
agents ran. **Lesson:** don't stop at "did the count change" — read what actually
changed before concluding either "fine" or "incident." A single-user app being actively
used during a long agent session is expected, not a bug, but it looks identical to a
mutation incident from the count alone.

### Also noticed: an unexplained iteration-3 feature doc appeared mid-session

`docs/features/010-upload-duplicate-feedback-and-file-management.md` (Status: Approved,
Iteration 3) appeared in the working tree partway through this session, written in
`fintech-ux-lead`'s voice and citing live data timestamped later than this session's own
checkpoint commit. None of this session's three agents (all `fintech-frontend`, scoped
away from writing new specs) produced it. Left untouched and uncommitted — most likely
a concurrent, independent session already working iteration 3's discovery pass. Flagged
to the user rather than assumed.

### Learned

- Direct user feedback is a fine substitute for a `fintech-ux-lead` discovery pass when
  the user has actually used the app — it's still grounded in real observation, just the
  user's instead of the UX lead's. The loop's later stages (design/build/verify/document)
  don't care which one triggered them.
- A resumed agent with full prior context (via `SendMessage` to its existing session)
  finished its own remaining checklist correctly without re-deriving anything — cheaper
  and safer than restarting fresh, and it's what let Session 7's handoff plan pay off
  immediately instead of becoming stale.
- Scoping concurrent sessions to disjoint files (Session 7 to `insights.*`, pipeline
  clarity to `app.js`, merchant-key fix to `merchant-key.js` alone) avoided any merge
  conflict between three agents running in parallel against the same working tree.
