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
