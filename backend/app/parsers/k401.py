"""401k export. Multiple rows per date (one per fund allocation), not a
simple debit/credit ledger. No running balance — EOM is manual-entry-only
for this account by design, no derived calculation is attempted."""

import pandas as pd

from .base import clean_amount, make_hash_id, normalize_date

SOURCE = "k401"


def parse(path, account: str = "401k") -> list[dict]:
    df = pd.read_csv(path, dtype=str)

    rows = []
    for _, r in df.iterrows():
        amount = clean_amount(r["Value"])
        date = normalize_date(r["Date"])
        activity = str(r["Activity"]).strip()
        name = str(r["Name"]).strip()
        fund = str(r["Fund"]).strip()
        description = f"{activity}: {name} ({fund})"
        rows.append(
            {
                "date": date,
                "description": description,
                "amount": amount,
                "balance_after": None,
                "external_id": make_hash_id(SOURCE, account, date, description, amount),
            }
        )
    return rows
