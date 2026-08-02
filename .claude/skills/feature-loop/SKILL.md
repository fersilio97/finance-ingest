---
name: feature-loop
description: Orchestrate finance-ingest's three-agent feature loop (fintech-ux-lead -> solution-architect -> fintech-frontend) as the coordinator. Use when starting a new iteration, running a discovery pass, turning direct user feedback into shipped features, resuming/handing off between the three agents, or deciding how much of the loop a given change actually needs. Encodes the scaling rules and the safety/token checklist learned across iterations 1-2 (docs/ITERATION-LOG.md) so they're enforced, not re-derived.
---

# Feature loop (coordinator skill)

You (the coordinator) run this loop by spawning `fintech-ux-lead`, `solution-architect`,
and `fintech-frontend` via the Agent tool. This skill governs *your* orchestration.
Project-specific facts (stack, schema, design system, safety rules) live in
`.claude/agents/*.md` and `docs/DEV-RUNBOOK.md` — read them there, don't expect them here.

**Stages:** `discover` (ux-lead, read-only) → `gate` (stop, wait for explicit approval) →
`spec` (ux-lead writes `docs/features/NNN-slug.md`) → `design` (architect: `##
Architecture` + backend) → `build` (frontend: UI) → `verify` (frontend: real browser) →
`document` (evidence recorded in the same doc) → checkpoint commit.

## 1. Parse `/feature-loop [args]`

| Args | Meaning | Gate? |
| --- | --- | --- |
| *(empty)* | Cold discovery: `fintech-ux-lead` investigates the running app, returns a ranked list | **Always gates.** Report the ranking, wait for approval. Nothing is implemented from an empty trigger. |
| A concrete description ("add a CSV date-range filter") | One item, scope already stated | **No gate.** The description is the approval. Skip discovery, run spec→design→build→verify→document for that one item. |
| A bare reference, noun only ("backlog", "docs/FEATURES.md", "open bugs") | Work the referenced list | **Gates per item.** Read the list, propose the next item, wait for approval, repeat. Safe default when you don't know if anyone's watching. |
| A reference **plus an execution verb** ("resolve the backlog", "implement all open bugs", "fix these") | Work the referenced list | **No gate.** Treat every item as pre-approved; ship them in ranked order, one checkpoint commit each. Stop only if a spec surfaces a genuine ambiguity a human must resolve. |
| Contains "autonomously" / "auto-approve" / "don't wait for me" | Unattended run | **No gate**, and use the cost ranking as the approval substitute (see §3). |

Rule of thumb: a noun-only reference gates; an execution verb or "autonomously" removes
the gate. If args match none of these cleanly, default to gating — cheap to ask, expensive
to guess wrong against a live financial database.

**Non-English / non-repo sources:** `/feature-loop backlog` only reads
`docs/FEATURES.md`. If the actual source is the user's Obsidian vault (often in Spanish),
run `/idea-to-execution` on it first to normalize the notes into English, repo-actionable
text, then pass *that output* as `/feature-loop`'s args. Don't point `/feature-loop` at
Obsidian directly — it doesn't read or translate it.

## 2. Once scoped, which agents actually run

| Situation | Run |
| --- | --- |
| One-line bug, typo, copy fix — no architecture decision | No agents. Fix it directly, still checkpoint-commit. |
| Backend only (migration, endpoint, no UI change) | `solution-architect` only |
| Frontend only, API contract unchanged | `fintech-frontend` only |
| Multiple independent approved items at once | Agents **in parallel**, each scoped to disjoint files (e.g. one to `insights.*`, one to `app.js`) |
| An agent's prior session was interrupted mid-task | `SendMessage` to resume it — never respawn fresh |
| Everything else | Full stage graph above |

## 3. Unattended / looped operation

`/feature-loop` never loops by itself — one invocation, one pass, then it returns. For
continuous operation, wrap it in `/loop`:

```
/loop /feature-loop <same args>            # self-paced — use when you said "until tokens run out" or a duration
/loop 30m /feature-loop <same args>        # fixed 30-min cadence instead
```

If the args gate per item (empty, or a bare reference), looping it only makes sense if
you'll periodically be present to approve — otherwise it stalls at the gate every pass and
ships nothing. For a truly unattended run, the args must remove the gate (§1) **and** give
an approval substitute, since no human is present to approve:

```
/loop /feature-loop find and implement general improvements autonomously; auto-approve
anything fintech-ux-lead ranks Small or Medium cost; queue anything Large, or anything
touching the DB schema, to the backlog instead of implementing it
```

The Small/Medium/Large cost ranking is already part of `fintech-ux-lead`'s standard
output — using it as the auto-approve threshold isn't a new judgment call, just reusing
one that already exists.

Because nothing is checked live: the coordinator checklist's data-integrity check (§4.2)
is mandatory every iteration, unattended or not. If it ever fails, **stop the loop and
surface the failure** — do not continue to the next item.

## 4. Coordinator checklist — every session, no exceptions

1. **Before** spawning any agent with DB write access: record baseline `rules` count and
   `needs_review` count (`GET /api/rules`, `GET /api/transactions?status=needs_review`).
2. **After** any handoff from an agent with write access: re-check those counts. If they
   moved, read the actual new/changed rows — not just the delta — before deciding
   "incident" vs. "the user was using the live app at the same time." Both look identical
   from the count alone.
3. Prefer **read-only verification** (type into a field, read the DOM, never click Save).
   If a mutation must be tested, clean it up **immediately after that one test**, not
   batched at session end.
4. **One agent invocation implements OR verifies — never both** across multiple features
   in one long session. That combination caused the iteration-1 incident (agent cut off
   before reaching cleanup).
5. **Checkpoint-commit after every session, or every 2-3.** Uncommitted agent work should
   never span more than that.
6. Concurrent agents get **disjoint files** — avoids merge conflicts and keeps DB changes
   attributable to one agent.

## 5. Token-usage rules

- Point agents at files (`docs/features/NNN-slug.md`, `## Architecture`) instead of
  pasting their content into the `Agent()` prompt — every agent already reads the doc
  itself as step 1.
- Ask agents to report back **facts** ("DOM node count and page height"), not raw
  curl/HTML/screenshot dumps.
- Keep `docs/ITERATION-LOG.md` entries factual (proposed / approved / shipped /
  incident). A standing process lesson goes in *this file*, once — not repeated prose in
  the next iteration's "Learned" section.
- Resume an interrupted agent with `SendMessage` (it keeps its context) instead of
  respawning fresh and re-explaining the task.

## Where things live

- Agent roles: `.claude/agents/{fintech-ux-lead,solution-architect,fintech-frontend}.md`
- Shared environment/safety knowledge: `docs/DEV-RUNBOOK.md`
- Feature docs: `docs/features/NNN-slug.md`, indexed in `docs/FEATURES.md`
- History: `docs/ITERATION-LOG.md`
