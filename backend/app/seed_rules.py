"""Initial rules loaded on first run, derived from patterns visible in the
actual sample bank exports. Fully editable/extendable via the UI afterward —
this is only a starting point, applied once when the rules table is empty."""

SEED_RULES = [
    # (source, match_text, category)
    ("boa_checking", "DES:PAYROLL", "Income:Salary"),
    ("boa_checking", "Zelle payment to", "Transfer:Zelle"),
    ("boa_checking", "UBER *TRIP", "Transport:Rideshare"),
    ("boa_checking", "UBER *EATS", "Dining:Delivery"),
    ("boa_checking", "PILATES", "Health:Fitness"),
    ("boa_checking", "YOG", "Health:Fitness"),
    ("fidelity_credit_card", "PAYMENT MADE BY ACCOUNT ENDING", "Transfer:CreditCardPayment"),
    ("fidelity_credit_card", "COSTCO", "Groceries"),
    ("fidelity_savings", "DIVIDEND RECEIVED", "Income:Investment"),
    ("fidelity_savings", "REINVESTMENT", "Investment:Reinvestment"),
    ("hsa", "Current Year Individual Contribution", "Transfer:HSAContribution"),
    ("hsa", "Interest Payment", "Income:Interest"),
    ("k401", "Contributions:", "Transfer:401kContribution"),
]


def seed(conn) -> int:
    existing = conn.execute("SELECT COUNT(*) AS n FROM rules").fetchone()["n"]
    if existing:
        return 0
    for source, match_text, category in SEED_RULES:
        conn.execute(
            "INSERT INTO rules (source, match_text, category, priority) VALUES (?, ?, ?, 100)",
            (source, match_text, category),
        )
    return len(SEED_RULES)
