"""Fidelity Savings export. File has a BOM and a blank leading line before
the header, plus a disclaimer footer after the transaction rows — parse with
utf-8-sig and filter to rows with a valid Run Date. Has a Cash Balance ($)
column, so this source auto-derives its own EOM balance."""

import re

import pandas as pd

from .base import clean_amount, make_hash_id, normalize_date

SOURCE = "fidelity_savings"
DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")


def parse(path, account: str = "Fidelity Savings") -> list[dict]:
    df = pd.read_csv(path, skiprows=2, encoding="utf-8-sig", dtype=str)
    df = df[df["Run Date"].astype(str).str.match(DATE_RE)]

    rows = []
    for _, r in df.iterrows():
        amount = clean_amount(r["Amount ($)"])
        date = normalize_date(r["Run Date"])
        description = str(r["Description"]).strip()
        cash_balance = r.get("Cash Balance ($)")
        balance_after = (
            clean_amount(cash_balance)
            if pd.notna(cash_balance) and str(cash_balance).strip() != ""
            else None
        )
        rows.append(
            {
                "date": date,
                "description": description,
                "amount": amount,
                "balance_after": balance_after,
                "external_id": make_hash_id(SOURCE, account, date, description, amount),
                "original_id": None,
            }
        )
    return rows
