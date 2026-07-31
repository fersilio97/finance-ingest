"""Stage 4: regenerate transactions.csv and account_paula.xlsx from the DB.
The DB is the source of truth — these are generated artifacts, rebuilt in
full on every trigger run."""

from pathlib import Path

import pandas as pd

from ..categories import CATEGORIES
from ..db import get_conn

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"
EXPORTS_DIR = DATA_DIR / "exports"
TRANSACTIONS_CSV = EXPORTS_DIR / "transactions.csv"
ACCOUNTS_XLSX = EXPORTS_DIR / "account_paula.xlsx"


TRANSACTIONS_COLUMNS = [
    "transaction_id", "original_transaction_id", "date", "account", "source",
    "description", "amount", "balance_after", "category", "status",
]
MANUAL_BALANCES_COLUMNS = ["account", "month", "recorded_balance"]


def load_transactions(conn) -> pd.DataFrame:
    rows = conn.execute(
        "SELECT id AS transaction_id, original_id AS original_transaction_id, "
        "date, account, source, description, amount, balance_after, category, status "
        "FROM transactions ORDER BY date, id"
    ).fetchall()
    if not rows:
        return pd.DataFrame(columns=TRANSACTIONS_COLUMNS)
    return pd.DataFrame([dict(r) for r in rows])


def load_manual_balances(conn) -> pd.DataFrame:
    rows = conn.execute("SELECT account, month, balance AS recorded_balance FROM manual_balances").fetchall()
    if not rows:
        return pd.DataFrame(columns=MANUAL_BALANCES_COLUMNS)
    return pd.DataFrame([dict(r) for r in rows])


# Matches the reference accounts.xlsx Global tab: months as rows, the 21
# fixed categories as columns in the reference's exact order, plus a
# trailing bucket for the automated review queue (the hand-maintained
# reference never has an "uncategorized" state) and a row total.
GLOBAL_COLUMNS = CATEGORIES + ["Uncategorized"]


def build_global(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=["month"] + GLOBAL_COLUMNS + ["Total"])
    df = df.copy()
    df["month"] = df["date"].str.slice(0, 7)
    df["category"] = df["category"].fillna("Uncategorized")
    pivot = df.pivot_table(index="month", columns="category", values="amount", aggfunc="sum", fill_value=0)
    pivot = pivot.reindex(columns=GLOBAL_COLUMNS, fill_value=0)
    pivot["Total"] = pivot.sum(axis=1)
    return pivot.reset_index().sort_values("month").reset_index(drop=True)


def build_calculator(df: pd.DataFrame, manual: pd.DataFrame) -> pd.DataFrame:
    """Per account/month: derived_balance (last balance_after seen that
    month, only for sources that carry a running balance) vs
    recorded_balance (manual entry). Flags where they disagree."""
    if df.empty and manual.empty:
        return pd.DataFrame(
            columns=["account", "month", "derived_balance", "recorded_balance", "diff", "match"]
        )

    derived = pd.DataFrame(columns=["account", "month", "derived_balance"])
    if not df.empty:
        df = df.copy()
        df["month"] = df["date"].str.slice(0, 7)
        # kind="stable" matters: default quicksort isn't stable, and can
        # reorder same-day rows so .last() below picks the wrong row when a
        # source (e.g. BoA Checking) posts multiple transactions on one date.
        with_balance = df[df["balance_after"].notna()].sort_values("date", kind="stable")
        if not with_balance.empty:
            derived = (
                with_balance.groupby(["account", "month"])["balance_after"]
                .last()
                .reset_index()
                .rename(columns={"balance_after": "derived_balance"})
            )

    calc = pd.merge(derived, manual, on=["account", "month"], how="outer")
    calc["diff"] = calc["derived_balance"] - calc["recorded_balance"]
    calc["match"] = calc["diff"].abs() < 0.01
    return calc.sort_values(["account", "month"]).reset_index(drop=True)


def export_all() -> dict:
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        df = load_transactions(conn)
        manual = load_manual_balances(conn)

    df.to_csv(TRANSACTIONS_CSV, index=False)

    global_df = build_global(df)
    calc_df = build_calculator(df, manual)

    with pd.ExcelWriter(ACCOUNTS_XLSX, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Transactions", index=False)
        global_df.to_excel(writer, sheet_name="Global", index=False)
        calc_df.to_excel(writer, sheet_name="Calculator", index=False)

    return {
        "transactions": len(df),
        "categories": len(global_df),
        "calculator_rows": len(calc_df),
    }
