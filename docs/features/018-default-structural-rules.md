# 018 — Default rules for structural non-spend rows

Resolves backlog #7 (see `docs/FEATURES.md`) apart from Zelle.

## Problem
About 160 review-queue rows are not spending decisions: k401 `Fees:` /
`Realized Gain/Loss:` rows, Fidelity money-market sweeps, and BoA
`Mobile Banking payment to CRD …` card payments.

## Behaviour
`seed_rules.DEFAULT_RULES` (source, match_text, category):

| Source | match_text | Category |
| --- | --- | --- |
| `k401` | `Fees:` | Banking |
| `k401` | `Realized Gain/Loss:` | Investments |
| `fidelity_savings` | `FIDELITY GOVERNMENT MONEY MARKET` | Investments |
| `boa_checking` | `Mobile Banking payment to CRD` | Transfer |

The k401 parser builds descriptions as `"{Activity}: {Name} ({Fund})"`, so
`Fees:` / `Realized Gain/Loss:` match the activity prefix. The other two
strings are taken from the backlog entry and doc 001 (real exports); the
parsers pass those descriptions through unchanged. Matching is a
case-insensitive substring, and `create_rule` lowercases `match_text`.

- `ensure_default_rules(conn)` runs on every startup after `seed()`. It inserts
  a default only if no rule with the same `source` and normalized (trimmed,
  lowercased) `match_text` exists, regardless of its category — user-edited
  rules are never overridden or duplicated. Idempotent.
- `seed()` is unchanged (still only fills an empty rules table), so on an empty
  DB the seed runs first and the defaults are then added once.
- If any rule was inserted, startup runs `enrich_all()` once so existing
  `needs_review` rows are classified immediately (no wait for "Run Pipeline").
- **No Zelle rule** — Zelle payments vary by recipient and stay in manual review.

## Known limitation
No deletion marker is stored: if the user deletes a default rule, it returns on
the next restart. To override one permanently, edit it (change the category)
rather than deleting it.

## Verification
`backend/tests/test_default_rules.py` (`python -m unittest discover -s backend/tests`
from the repo root): idempotency, skipping an equivalent user rule (different
case/whitespace/category), valid categories, and a k401 `Fees:` row classified
as Banking by `enrich_all()`. Not run in the authoring environment (no command
execution) — please run it once.
