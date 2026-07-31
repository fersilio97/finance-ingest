"""Fidelity Credit Card export. No natural external id, so dedup falls back
to a content hash. The Memo field does carry a leading numeric reference
token before the first ';' (e.g. "24943006088403317023073; 05300; ..."),
captured as original_id even though it's not used for dedup."""

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
        memo = r.get("Memo")
        original_id = str(memo).split(";")[0].strip() if pd.notna(memo) and str(memo).strip() else None
        rows.append(
            {
                "date": date,
                "description": description,
                "amount": amount,
                "balance_after": None,
                "external_id": make_hash_id(SOURCE, account, date, description, amount),
                "original_id": original_id or None,
            }
        )
    return rows
