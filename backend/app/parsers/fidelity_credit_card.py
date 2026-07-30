"""Fidelity Credit Card export. No natural external id, so dedup falls back
to a content hash."""

import pandas as pd

from .base import clean_amount, make_hash_id, normalize_date

SOURCE = "fidelity_credit_card"


def parse(path, account: str = "Fidelity Credit Card") -> list[dict]:
    df = pd.read_csv(path, dtype=str)

    rows = []
    for _, r in df.iterrows():
        amount = clean_amount(r["Amount"])
        date = normalize_date(r["Date"], fmt="%Y-%m-%d")
        description = str(r["Name"]).strip()
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
