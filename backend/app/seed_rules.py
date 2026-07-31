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


def seed(conn) -> int:
    existing = conn.execute("SELECT COUNT(*) AS n FROM rules").fetchone()["n"]
    if existing:
        return 0
    for source, match_text, category in SEED_RULES:
        rules_store.create_rule(conn, source, match_text, category)
    return len(SEED_RULES)
