"""BoA Checking export. Real transaction table starts at line 7 (0-indexed
skiprows=6) — lines 1-6 are a period summary block (beginning/ending balance,
total credits/debits). Has a Running Bal. column, so this source auto-derives
its own EOM balance."""

import pandas as pd

from .base import clean_amount, make_hash_id, normalize_date

SOURCE = "boa_checking"


def parse(path, account: str = "BoA Checking") -> list[dict]:
    df = pd.read_csv(path, skiprows=6, dtype=str)
    df = df[df["Amount"].notna() & (df["Amount"].str.strip() != "")]

    rows = []
    for _, r in df.iterrows():
        amount = clean_amount(r["Amount"])
        date = normalize_date(r["Date"])
        description = str(r["Description"]).strip()
        balance_after = (
            clean_amount(r["Running Bal."])
            if pd.notna(r.get("Running Bal.")) and str(r.get("Running Bal.")).strip() != ""
            else None
        )
        rows.append(
            {
                "date": date,
                "description": description,
                "amount": amount,
                "balance_after": balance_after,
                "external_id": make_hash_id(SOURCE, account, date, description, amount),
            }
        )
    return rows
