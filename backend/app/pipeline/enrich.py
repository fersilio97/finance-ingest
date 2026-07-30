"""Stage 3: rule engine -> ML stub -> needs_review for whatever's left."""

from ..classifier.model_stub import predict
from ..db import get_conn
from ..rules.engine import apply_rules


def enrich_all() -> dict:
    classified = 0
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, source, description FROM transactions WHERE status = 'needs_review'"
        ).fetchall()
        for row in rows:
            category, rule_id = apply_rules(conn, row["source"], row["description"])
            if category is None:
                category = predict(dict(row))
                rule_id = None
            if category:
                conn.execute(
                    "UPDATE transactions SET category = ?, rule_id = ?, status = 'classified' WHERE id = ?",
                    (category, rule_id, row["id"]),
                )
                classified += 1
    return {"classified": classified, "considered": len(rows)}
