"""Ordered keyword-in-description rule matching. First match wins."""


def apply_rules(conn, source: str, description: str):
    desc_lower = description.lower()
    rules = conn.execute(
        "SELECT id, match_text, category FROM rules "
        "WHERE source IS NULL OR source = ? "
        "ORDER BY priority ASC, id ASC",
        (source,),
    ).fetchall()
    for rule in rules:
        if rule["match_text"].lower() in desc_lower:
            return rule["category"], rule["id"]
    return None, None
