"""CRUD against the rules table, used by the API and the manual-review
'save as rule' action."""

from typing import Optional


def list_rules(conn):
    return conn.execute("SELECT * FROM rules ORDER BY priority ASC, id ASC").fetchall()


def create_rule(conn, source: Optional[str], match_text: str, category: str, priority: int = 100) -> int:
    cur = conn.execute(
        "INSERT INTO rules (source, match_text, category, priority) VALUES (?, ?, ?, ?)",
        (source, match_text, category, priority),
    )
    return cur.lastrowid


def delete_rule(conn, rule_id: int) -> None:
    conn.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
