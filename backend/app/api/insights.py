"""Read-only aggregation endpoints backing the Insights view. Reuses the
same builders as the xlsx export so the UI and the spreadsheet never
disagree."""

from fastapi import APIRouter

from ..db import get_conn
from ..pipeline.export import build_calculator, build_global, load_manual_balances, load_transactions

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
    if df.empty:
        return []
    trend = (
        df[df["balance_after"].notna()]
        .sort_values("date")[["account", "date", "balance_after"]]
        .to_dict(orient="records")
    )
    return trend


@router.get("/calculator")
def calculator():
    with get_conn() as conn:
        df = load_transactions(conn)
        manual = load_manual_balances(conn)
    calc = build_calculator(df, manual)
    # NaN isn't valid JSON — swap for null before serializing (unmatched
    # account/month pairs legitimately have a missing derived or recorded side).
    calc = calc.astype(object).where(calc.notna(), None)
    return calc.to_dict(orient="records")
