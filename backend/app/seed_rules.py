"""Initial rules loaded on first run, aligned to the reference taxonomy in
categories.py. Deliberately conservative — only unambiguous mappings are
seeded; anything else (e.g. Zelle payments, which vary by recipient — a
Zelle for "Buena Vista Club" is Entertainment, not a blanket Transfer) is
left for real classification through the review flow, which is how the
real rule set should get built. Fully editable/extendable via the UI
afterward — applied once when the rules table is empty."""

from .rules import store as rules_store

SEED_RULES = [
    # (source, match_text, category)
    ("boa_checking", "DES:PAYROLL", "Salary"),
    ("boa_checking", "PILATES", "Health"),
    ("boa_checking", "YOG", "Health"),
    ("boa_checking", "UBER *TRIP", "Transport"),
    ("boa_checking", "UBER *EATS", "Eat Out"),
    ("fidelity_credit_card", "PAYMENT MADE BY ACCOUNT ENDING", "Transfer"),
    ("fidelity_savings", "DIVIDEND RECEIVED", "Investments"),
    ("fidelity_savings", "REINVESTMENT", "Investments"),
    ("hsa", "Current Year Individual Contribution", "Health"),
    ("k401", "Contributions:", "Investments"),
]


# Structural non-spend rows (docs/FEATURES.md backlog #7) that should never
# need a human decision. Unlike SEED_RULES these are topped up on every
# startup by ensure_default_rules(). Zelle is deliberately absent: it varies
# by recipient and must stay in manual review.
DEFAULT_RULES = [
    # (source, match_text, category)
    ("k401", "Fees:", "Banking"),
    ("k401", "Realized Gain/Loss:", "Investments"),
    ("fidelity_savings", "FIDELITY GOVERNMENT MONEY MARKET", "Investments"),
    ("boa_checking", "Mobile Banking payment to CRD", "Transfer"),
]


def ensure_default_rules(conn) -> int:
    """Insert each DEFAULT_RULES entry unless a rule with the same source and
    normalized match_text already exists (whatever its category — user edits
    win). Idempotent. Returns the number of rules inserted. A default rule the
    user deleted will come back on the next restart."""
    inserted = 0
    for source, match_text, category in DEFAULT_RULES:
        normalized = match_text.strip().lower()
        existing = conn.execute(
            "SELECT 1 FROM rules WHERE source IS ? AND lower(trim(match_text)) = ?",
            (source, normalized),
        ).fetchone()
        if existing:
            continue
        rules_store.create_rule(conn, source, match_text, category)
        inserted += 1
    return inserted


def seed(conn) -> int:
    existing = conn.execute("SELECT COUNT(*) AS n FROM rules").fetchone()["n"]
    if existing:
        return 0
    for source, match_text, category in SEED_RULES:
        rules_store.create_rule(conn, source, match_text, category)
    return len(SEED_RULES)
