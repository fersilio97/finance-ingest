"""Stage 3: rule engine -> ML stub -> needs_review for whatever's left."""

from typing import Optional

from ..classifier.model_stub import predict
from ..db import get_conn, get_last_batch_id
from ..rules.engine import apply_rules


def enrich_all(batch_id: Optional[int] = None) -> dict:
    """Re-run classification over needs_review transactions. With no
    batch_id, considers every needs_review row (used by the full pipeline
    trigger); scoped to batch_id, only that upload's rows are touched."""
    classified = 0
    with get_conn() as conn:
        if batch_id is not None:
            rows = conn.execute(
                "SELECT id, source, description FROM transactions "
                "WHERE status = 'needs_review' AND batch_id = ?",
                (batch_id,),
            ).fetchall()
        else:
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


def enrich_last_batch() -> dict:
    with get_conn() as conn:
        batch_id = get_last_batch_id(conn)
    if batch_id is None:
        return {"classified": 0, "considered": 0}
    return enrich_all(batch_id=batch_id)
