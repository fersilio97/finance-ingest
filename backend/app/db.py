"""SQLite access layer. This is the source of truth — transactions.csv and
account_paula.xlsx are generated exports, regenerated on every trigger run."""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = REPO_ROOT / "data" / "finance.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT NOT NULL UNIQUE,
    original_id TEXT,
    source TEXT NOT NULL,
    account TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL,
    category TEXT,
    rule_id INTEGER,
    status TEXT NOT NULL DEFAULT 'needs_review',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    match_text TEXT NOT NULL,
    category TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS manual_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    month TEXT NOT NULL,
    balance REAL NOT NULL,
    UNIQUE(account, month)
);

CREATE TABLE IF NOT EXISTS sources (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    account TEXT NOT NULL,
    has_running_balance INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_count INTEGER,
    date_start TEXT,
    date_end TEXT,
    processed_at TEXT,
    content_hash TEXT
);

CREATE TABLE IF NOT EXISTS balance_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    balance REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

SOURCES = [
    ("boa_checking", "BoA Checking", "BoA Checking", 1),
    ("boa_credit_card", "BoA Credit Card", "BoA Credit Card", 0),
    ("fidelity_credit_card", "Fidelity Credit Card", "Fidelity Credit Card", 0),
    ("fidelity_savings", "Fidelity Savings", "Fidelity Savings", 1),
    ("hsa", "HSA", "HSA", 0),
    ("k401", "401k", "401k", 0),
]


@contextmanager
def get_conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _ensure_column(conn, table: str, column: str, coltype: str) -> None:
    """CREATE TABLE IF NOT EXISTS won't retrofit new columns onto an
    existing DB file — this adds one if it's missing, so schema changes
    don't require deleting the DB (aside from the one-off reset needed for
    the category taxonomy change)."""
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")


def create_batch(conn) -> int:
    """One row per normalize_all() run. Rows an INSERT OR IGNORE skips as
    duplicates keep their original batch_id — so MAX(batch_id) on
    transactions naturally means 'the last upload that actually added
    something new', which is what rule edit/delete re-analysis scopes to."""
    cur = conn.execute("INSERT INTO batches DEFAULT VALUES")
    return cur.lastrowid


def get_last_batch_id(conn):
    row = conn.execute("SELECT MAX(batch_id) AS b FROM transactions").fetchone()
    return row["b"]


def _backfill_batch_ids(conn) -> None:
    """One-time migration: transactions inserted before batch tracking
    existed have batch_id IS NULL. Group them into a single legacy batch so
    'last batch' semantics (rule edit/delete re-analysis scope) still work
    for pre-existing data instead of silently no-op'ing forever. Idempotent
    — once backfilled, nothing has a NULL batch_id and this is a no-op."""
    orphans = conn.execute("SELECT COUNT(*) AS n FROM transactions WHERE batch_id IS NULL").fetchone()["n"]
    if orphans:
        batch_id = create_batch(conn)
        conn.execute("UPDATE transactions SET batch_id = ? WHERE batch_id IS NULL", (batch_id,))


def _migrate_manual_balances_to_entries(conn) -> None:
    """One-time fold: manual_balances (UNIQUE(account, month), one entry per
    account per month) is superseded by balance_entries (exact timestamp, no
    uniqueness constraint, multiple entries per month allowed). manual_balances
    is left in place — SQLite can't drop/change its UNIQUE constraint without a
    full table rebuild, and there's no need to risk that against a real DB for
    a table nothing writes to anymore.

    balance_entries has no UNIQUE constraint (multiple real entries can
    legitimately share an account+timestamp+balance), so this can't lean on
    INSERT OR IGNORE for idempotency the way _backfill_batch_ids does. Instead
    it checks for an already-migrated row with the same (account, recorded_at,
    balance) before inserting — safe to run on every startup, a no-op once the
    fold has happened once."""
    rows = conn.execute("SELECT account, month, balance FROM manual_balances").fetchall()
    for row in rows:
        recorded_at = f"{row['month']}-01T00:00:00"
        existing = conn.execute(
            "SELECT id FROM balance_entries WHERE account = ? AND recorded_at = ? AND balance = ?",
            (row["account"], recorded_at, row["balance"]),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO balance_entries (account, recorded_at, balance) VALUES (?, ?, ?)",
                (row["account"], recorded_at, row["balance"]),
            )


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _ensure_column(conn, "transactions", "original_id", "TEXT")
        _ensure_column(conn, "transactions", "batch_id", "INTEGER")
        _ensure_column(conn, "transactions", "overridden_at", "TEXT")
        _ensure_column(conn, "uploads", "content_hash", "TEXT")
        _backfill_batch_ids(conn)
        _migrate_manual_balances_to_entries(conn)
        for key, label, account, has_balance in SOURCES:
            conn.execute(
                "INSERT OR IGNORE INTO sources (key, label, account, has_running_balance) "
                "VALUES (?, ?, ?, ?)",
                (key, label, account, has_balance),
            )
