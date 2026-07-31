"""BoA Credit Card export (one file per statement month). Has a natural
Reference Number, used directly as the dedup key instead of a content hash."""

import pandas as pd

from .base import clean_amount, normalize_date

SOURCE = "boa_credit_card"


def parse(path, account: str = "BoA Credit Card") -> list[dict]:
    df = pd.read_csv(path, dtype=str)

    rows = []
    for _, r in df.iterrows():
        amount = clean_amount(r["Amount"])
        date = normalize_date(r["Posted Date"])
        description = str(r["Payee"]).strip()
        reference = str(r["Reference Number"]).strip()
        rows.append(
            {
                "date": date,
                "description": description,
                "amount": amount,
                "balance_after": None,
                "external_id": f"{SOURCE}:{reference}",
                "original_id": reference,
            }
        )
    return rows
