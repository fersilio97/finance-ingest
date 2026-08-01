"""Stage 4: regenerate transactions.csv and account_paula.xlsx from the DB.
The DB is the source of truth — these are generated artifacts, rebuilt in
full on every trigger run."""

import os
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
BALANCE_ENTRIES_COLUMNS = ["id", "account", "recorded_at", "recorded_balance"]


def load_transactions(conn) -> pd.DataFrame:
    rows = conn.execute(
        "SELECT id AS transaction_id, original_id AS original_transaction_id, "
        "date, account, source, description, amount, balance_after, category, status "
        "FROM transactions ORDER BY date, id"
    ).fetchall()
    if not rows:
        return pd.DataFrame(columns=TRANSACTIONS_COLUMNS)
    return pd.DataFrame([dict(r) for r in rows])


def load_balance_entries(conn) -> pd.DataFrame:
    rows = conn.execute(
        "SELECT id, account, recorded_at, balance AS recorded_balance "
        "FROM balance_entries ORDER BY account, recorded_at"
    ).fetchall()
    if not rows:
        return pd.DataFrame(columns=BALANCE_ENTRIES_COLUMNS)
    return pd.DataFrame([dict(r) for r in rows])


def load_account_flags(conn) -> dict:
    """account -> has_running_balance (bool), from the sources table — the
    one place this metadata lives. Kept out of load_transactions()/df on
    purpose: that dataframe also feeds transactions.csv and the xlsx
    Transactions sheet verbatim (whatever columns it has get written out),
    and only build_balance_trend() needs this flag, so it travels alongside
    df as a separate small dict rather than as an extra column every other
    consumer of df would have to ignore. A plain dict (not a DataFrame)
    because it's a simple lookup, and dict preserves the sources table's own
    row order (== SOURCES' order in db.py), which is what determines the
    order accounts appear in the balance-trend response."""
    rows = conn.execute("SELECT account, has_running_balance FROM sources").fetchall()
    return {r["account"]: bool(r["has_running_balance"]) for r in rows}


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


RECONCILIATION_COLUMNS = ["id", "account", "recorded_at", "recorded_balance", "derived_balance", "diff", "status"]


def build_reconciliation(df: pd.DataFrame, entries: pd.DataFrame) -> pd.DataFrame:
    """One row per balance_entries row (not a synthetic account x month grid —
    that grid is what the old build_calculator() produced, and it kept
    manufacturing "not_checked" placeholder rows for every month nobody ever
    recorded anything for). For each entry: derived_balance is the
    balance_after of the last transaction for that account on or before the
    entry's calendar date (transactions only carry date-level granularity, so
    recorded_at is sliced to its first 10 chars — "YYYY-MM-DD" — for the
    comparison; there is no finer match to make).

    Resolves to the same tri-state `status` spec 003 established:
    "not_checked" (no transaction at/before that date for the account —
    nothing to compare), "balanced" (derived exists and matches within
    tolerance) or "off" (derived exists and differs). Tolerance is the same
    |diff| < 0.01 sub-cent threshold used before, for the same float-sum
    reason."""
    if entries.empty:
        return pd.DataFrame(columns=RECONCILIATION_COLUMNS)

    entries = entries.copy()
    entries["entry_date"] = entries["recorded_at"].str.slice(0, 10)

    with_balance = pd.DataFrame(columns=["account", "date", "balance_after"])
    if not df.empty:
        # kind="stable" matters: default quicksort isn't stable, and can
        # reorder same-day rows so the last-match-per-account lookup below
        # picks the wrong row when a source posts multiple transactions on
        # one date.
        with_balance = df[df["balance_after"].notna()].sort_values("date", kind="stable")

    def derive(entry):
        if with_balance.empty:
            return None
        candidates = with_balance[
            (with_balance["account"] == entry["account"]) & (with_balance["date"] <= entry["entry_date"])
        ]
        if candidates.empty:
            return None
        return candidates.iloc[-1]["balance_after"]

    entries["derived_balance"] = entries.apply(derive, axis=1)
    entries["diff"] = entries["derived_balance"] - entries["recorded_balance"]

    derived_present = entries["derived_balance"].notna()
    entries["status"] = "not_checked"
    entries.loc[derived_present & (entries["diff"].abs() < 0.01), "status"] = "balanced"
    entries.loc[derived_present & (entries["diff"].abs() >= 0.01), "status"] = "off"

    return (
        entries[RECONCILIATION_COLUMNS]
        .sort_values(["account", "recorded_at"])
        .reset_index(drop=True)
    )


def build_balance_trend(df: pd.DataFrame, entries: pd.DataFrame, account_flags: dict) -> dict:
    """One series per account (all of them, from account_flags — not just
    the ones with transactions, so an account with zero rows still shows up
    with an empty points list rather than silently disappearing).

    "native" accounts (BoA Checking, Fidelity Savings) already have a real
    per-transaction balance_after — this just repackages the exact same
    filtered/sorted data the old flat endpoint returned, split per account,
    without changing how it's computed.

    "derived" accounts (the other four — no source-native running balance)
    get a *relative* running total: cumulative sum of amount in date order,
    starting at 0. This is explicitly not an absolute balance — there's no
    starting point to anchor to — the user asked for it anyway, as a
    directional trend line. kind="stable" for the same reason
    build_reconciliation uses it: default sort isn't stable, and can reorder
    same-day transactions, which would make the running total accumulate in
    a different (and non-reproducible) order across requests.

    "aggregated" sums, for every distinct date appearing in ANY account's
    points, each account's most-recent (forward-filled) balance as of that
    date — but only for accounts that have at least one point on or before
    that date. An account with no data yet is excluded from that date's sum
    entirely, not treated as contributing 0 — treating "no data yet" as 0
    would manufacture an artificial dip on whatever date the earliest
    overall series happens to start.
    """
    native_rows = df[df["balance_after"].notna()].sort_values("date")

    series = []
    account_points: dict = {}
    for account, is_native in account_flags.items():
        if is_native:
            rows = native_rows[native_rows["account"] == account]
            points = [{"date": d, "balance": b} for d, b in zip(rows["date"], rows["balance_after"])]
        else:
            rows = df[df["account"] == account].sort_values("date", kind="stable")
            points = []
            running = 0.0
            for d, amt in zip(rows["date"], rows["amount"]):
                running += amt
                points.append({"date": d, "balance": running})
        account_points[account] = points
        series.append({"account": account, "kind": "native" if is_native else "derived", "points": points})

    all_dates = sorted({p["date"] for pts in account_points.values() for p in pts})
    cursor = {account: 0 for account in account_points}
    last_balance = {account: None for account in account_points}
    aggregated = []
    for d in all_dates:
        for account, pts in account_points.items():
            i = cursor[account]
            while i < len(pts) and pts[i]["date"] <= d:
                last_balance[account] = pts[i]["balance"]
                i += 1
            cursor[account] = i
        aggregated.append({"date": d, "balance": sum(b for b in last_balance.values() if b is not None)})

    entries_out = [
        {"id": r["id"], "account": r["account"], "recorded_at": r["recorded_at"], "balance": r["recorded_balance"]}
        for r in entries.to_dict(orient="records")
    ]

    return {"series": series, "aggregated": aggregated, "entries": entries_out}


def export_all() -> dict:
    """SQLite is the one source of truth; transactions.csv and
    account_paula.xlsx are both just views onto it, regenerated together.

    They used to be written straight to their real paths, csv first: if the
    xlsx write then failed (most commonly a PermissionError because the user
    had account_paula.xlsx open in Excel), the csv was already overwritten
    with fresh data while the xlsx stayed stale — the two derived files could
    silently drift apart. Now both are written to temp files first and only
    swapped into place with an atomic os.replace() if BOTH writes succeed, so
    the pair is always either fully updated together or left fully untouched.
    """
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        df = load_transactions(conn)
        entries = load_balance_entries(conn)

    global_df = build_global(df)
    reconciliation_df = build_reconciliation(df, entries)

    csv_tmp = TRANSACTIONS_CSV.with_name(TRANSACTIONS_CSV.name + ".tmp")
    xlsx_tmp = ACCOUNTS_XLSX.with_name(ACCOUNTS_XLSX.name + ".tmp")
    try:
        df.to_csv(csv_tmp, index=False)
        with pd.ExcelWriter(xlsx_tmp, engine="openpyxl") as writer:
            df.to_excel(writer, sheet_name="Transactions", index=False)
            global_df.to_excel(writer, sheet_name="Global", index=False)
            reconciliation_df.to_excel(writer, sheet_name="Calculator", index=False)
    except PermissionError as e:
        csv_tmp.unlink(missing_ok=True)
        xlsx_tmp.unlink(missing_ok=True)
        raise RuntimeError(
            "Couldn't write the exports — account_paula.xlsx or transactions.csv "
            "looks like it's open in another program. Close it and run the pipeline again."
        ) from e
    except Exception:
        csv_tmp.unlink(missing_ok=True)
        xlsx_tmp.unlink(missing_ok=True)
        raise

    os.replace(csv_tmp, TRANSACTIONS_CSV)
    os.replace(xlsx_tmp, ACCOUNTS_XLSX)

    return {
        "transactions": len(df),
        "categories": len(global_df),
        "calculator_rows": len(reconciliation_df),
    }
