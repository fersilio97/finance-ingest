"""Shared helpers for per-source parsers.

Every parser exposes parse(path, account) -> list[dict] with keys:
date (ISO), description, amount, balance_after (float | None), external_id.
"""

import hashlib
from datetime import datetime


def make_hash_id(source: str, account: str, date: str, description: str, amount: float) -> str:
    raw = f"{source}|{account}|{date}|{description}|{amount:.2f}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def clean_amount(value) -> float:
    if value is None:
        return 0.0
    s = str(value).strip()
    if s == "" or s.lower() == "nan":
        return 0.0
    s = s.replace("$", "").replace(",", "")
    negative = s.startswith("(") and s.endswith(")")
    if negative:
        s = s[1:-1]
    val = float(s)
    return -val if negative else val


def normalize_date(value, fmt: str = "%m/%d/%Y") -> str:
    s = str(value).strip()
    try:
        return datetime.strptime(s, fmt).date().isoformat()
    except ValueError:
        return s
