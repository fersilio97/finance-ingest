"""CRUD against the rules table, used by the API and the manual-review
'save as rule' action."""

from typing import Optional


def list_rules(conn):
    # Browsable order for the Rules tab (source = "type", match_text = the
    # closest thing a rule has to a name) — independent of the priority-based
    # ordering rules/engine.py uses when actually applying rules.
    return conn.execute("SELECT * FROM rules ORDER BY source ASC, match_text ASC").fetchall()


def create_rule(conn, source: Optional[str], match_text: str, category: str, priority: int = 100) -> int:
    # Single choke point for rule creation — normalize to lowercase here so
    # every path (review row, rules form, seed rules) stores consistently,
    # regardless of the case the keyword was copied from.
    cur = conn.execute(
        "INSERT INTO rules (source, match_text, category, priority) VALUES (?, ?, ?, ?)",
        (source, match_text.strip().lower(), category, priority),
    )
    return cur.lastrowid


def update_rule(conn, rule_id: int, source: Optional[str], match_text: str, category: str, priority: int) -> None:
    conn.execute(
        "UPDATE rules SET source = ?, match_text = ?, category = ?, priority = ? WHERE id = ?",
        (source, match_text.strip().lower(), category, priority, rule_id),
    )


def delete_rule(conn, rule_id: int) -> None:
    conn.execute("DELETE FROM rules WHERE id = ?", (rule_id,))
