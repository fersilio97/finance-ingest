"""Read-only aggregation endpoints backing the Insights view. Reuses the
same builders as the xlsx export so the UI and the spreadsheet never
disagree."""

from fastapi import APIRouter

from ..db import get_conn
from ..pipeline.export import (
    build_balance_trend,
    build_global,
    build_reconciliation,
    load_account_flags,
    load_balance_entries,
    load_transactions,
)

router = APIRouter(prefix="/api/insights")


@router.get("/category-monthly")
def category_monthly():
    with get_conn() as conn:
        df = load_transactions(conn)
    return build_global(df).to_dict(orient="records")


@router.get("/balance-trend")
def balance_trend():
    with get_conn() as conn:
        df = load_transactions(conn)
        entries = load_balance_entries(conn)
        account_flags = load_account_flags(conn)
    return build_balance_trend(df, entries, account_flags)


@router.get("/reconciliation")
def reconciliation():
    with get_conn() as conn:
        df = load_transactions(conn)
        entries = load_balance_entries(conn)
    calc = build_reconciliation(df, entries)
    # NaN isn't valid JSON — swap for null before serializing (an entry with
    # no transaction at/before its date legitimately has no derived side).
    calc = calc.astype(object).where(calc.notna(), None)
    return calc.to_dict(orient="records")
