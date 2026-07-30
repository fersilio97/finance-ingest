"""Stage 2: run each source's parser over its incoming files, dedupe
against the DB (unique external_id), insert only new rows."""

from ..db import SOURCES, get_conn
from ..parsers import PARSERS
from .ingest import list_incoming

ACCOUNTS = {key: account for key, _label, account, _has_balance in SOURCES}


def normalize_all() -> dict:
    summary = {}
    with get_conn() as conn:
        for source, parser in PARSERS.items():
            files = list_incoming(source)
            account = ACCOUNTS.get(source, source)
            parsed = 0
            inserted = 0
            for f in files:
                rows = parser(f, account=account)
                parsed += len(rows)
                for row in rows:
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO transactions "
                        "(external_id, source, account, date, description, amount, balance_after, status) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, 'needs_review')",
                        (
                            row["external_id"],
                            source,
                            account,
                            row["date"],
                            row["description"],
                            row["amount"],
                            row["balance_after"],
                        ),
                    )
                    if cur.rowcount:
                        inserted += 1
            summary[source] = {"parsed": parsed, "inserted": inserted}
    return summary
