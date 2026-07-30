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


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        for key, label, account, has_balance in SOURCES:
            conn.execute(
                "INSERT OR IGNORE INTO sources (key, label, account, has_running_balance) "
                "VALUES (?, ?, ?, ?)",
                (key, label, account, has_balance),
            )
