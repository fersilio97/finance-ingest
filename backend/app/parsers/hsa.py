"""HSA export. Amount has a literal $ prefix, no running balance column."""

import pandas as pd

from .base import clean_amount, make_hash_id, normalize_date

SOURCE = "hsa"


def parse(path, account: str = "HSA") -> list[dict]:
    df = pd.read_csv(path, dtype=str)

    rows = []
    for _, r in df.iterrows():
        amount = clean_amount(r["Amount"])
        date = normalize_date(r["Date"], fmt="%Y-%m-%d")
        description = str(r["Description"]).strip()
        rows.append(
            {
                "date": date,
                "description": description,
                "amount": amount,
                "balance_after": None,
                "external_id": make_hash_id(SOURCE, account, date, description, amount),
                "original_id": None,
            }
        )
    return rows
