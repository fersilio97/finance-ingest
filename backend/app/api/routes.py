import re
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from ..categories import CATEGORIES
from ..db import SOURCES, get_conn
from ..parsers import PARSERS
from ..pipeline.enrich import enrich_all, enrich_last_batch
from ..pipeline.export import ACCOUNTS_XLSX, TRANSACTIONS_CSV, export_all
from ..pipeline.ingest import save_upload
from ..pipeline.normalize import ACCOUNTS, normalize_all
from ..rules import store as rules_store

router = APIRouter(prefix="/api")

VALID_SOURCES = {key for key, *_ in SOURCES}
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


@router.get("/categories")
def list_categories():
    return CATEGORIES


@router.get("/sources")
def list_sources():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT key, label, account, has_running_balance FROM sources"
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/upload/{source}")
async def upload(source: str, files: list[UploadFile]):
    if source not in VALID_SOURCES:
        raise HTTPException(404, f"Unknown source: {source}")
    saved = []
    with get_conn() as conn:
        for f in files:
            content = await f.read()
            path = save_upload(source, f.filename, content)
            saved.append(str(path))

            # Read-only stats pass, purely for the uploads table — the
            # parser doesn't touch the DB itself, so calling it here (ahead
            # of the real call inside normalize_all()) has no side effects.
            # Never let a parse failure block the actual upload: fall back
            # to NULL stats rather than raising.
            row_count = date_start = date_end = None
            try:
                rows = PARSERS[source](path, account=ACCOUNTS.get(source, source))
                row_count = len(rows)
                dates = [r["date"] for r in rows if r.get("date")]
                if dates:
                    date_start, date_end = min(dates), max(dates)
            except Exception:
                pass

            conn.execute(
                "INSERT INTO uploads (source, filename, row_count, date_start, date_end) "
                "VALUES (?, ?, ?, ?, ?)",
                (source, f.filename, row_count, date_start, date_end),
            )
    return {"saved": saved}


@router.get("/uploads")
def list_uploads():
    """One entry per source (even sources with zero uploads/transactions),
    combining not-yet-triggered upload metadata with already-ingested
    transaction coverage — so the Upload UI can show both "what's about to
    happen" and "how stale is what's already in"."""
    with get_conn() as conn:
        today = date.today()
        result = []
        for source_row in conn.execute("SELECT key, label FROM sources").fetchall():
            key, label = source_row["key"], source_row["label"]

            pending_rows = conn.execute(
                "SELECT id, filename, uploaded_at, row_count, date_start, date_end "
                "FROM uploads WHERE source = ? AND processed_at IS NULL ORDER BY uploaded_at",
                (key,),
            ).fetchall()
            pending_files = [dict(r) for r in pending_rows]

            row_counts = [f["row_count"] for f in pending_files if f["row_count"] is not None]
            starts = [f["date_start"] for f in pending_files if f["date_start"]]
            ends = [f["date_end"] for f in pending_files if f["date_end"]]
            pending_aggregate = {
                "file_count": len(pending_files),
                "row_count": sum(row_counts) if row_counts else None,
                "date_start": min(starts) if starts else None,
                "date_end": max(ends) if ends else None,
            }

            coverage_row = conn.execute(
                "SELECT MIN(date) AS date_start, MAX(date) AS date_end FROM transactions WHERE source = ?",
                (key,),
            ).fetchone()
            ingested_coverage = {
                "date_start": coverage_row["date_start"],
                "date_end": coverage_row["date_end"],
            }

            latest_covered = max(
                (d for d in (ingested_coverage["date_end"], pending_aggregate["date_end"]) if d),
                default=None,
            )
            days_since_latest_covered = None
            if latest_covered:
                try:
                    days_since_latest_covered = (today - date.fromisoformat(latest_covered)).days
                except ValueError:
                    days_since_latest_covered = None

            result.append(
                {
                    "source": key,
                    "label": label,
                    "pending_files": pending_files,
                    "pending_aggregate": pending_aggregate,
                    "ingested_coverage": ingested_coverage,
                    "days_since_latest_covered": days_since_latest_covered,
                }
            )
        return result


@router.post("/trigger")
def trigger():
    normalize_summary = normalize_all()
    # normalize_all() processes every source's incoming files unconditionally
    # in one pass (not per-source) — mirror that here: stamp every currently-
    # pending upload as processed in one shot, rather than trying to match
    # individual uploads rows to individual normalize() outcomes.
    with get_conn() as conn:
        conn.execute("UPDATE uploads SET processed_at = datetime('now') WHERE processed_at IS NULL")
    enrich_summary = enrich_all()
    try:
        export_summary = export_all()
    except RuntimeError as e:
        # normalize/enrich already committed to the DB — only the derived
        # files failed, and export_all() guarantees they were left untouched
        # (not partially updated) rather than drifting out of sync.
        raise HTTPException(500, str(e))
    return {
        "normalize": normalize_summary,
        "enrich": enrich_summary,
        "export": export_summary,
    }


@router.get("/transactions")
def list_transactions(status: Optional[str] = None, category: Optional[str] = None, month: Optional[str] = None):
    if month is not None and not MONTH_RE.match(month):
        raise HTTPException(400, f"month must be YYYY-MM, got: {month!r}")

    # Same parameterized-clause pattern as everywhere else in this file
    # (e.g. classify_transaction's UPDATE) — clauses combine with AND,
    # every value is a bind param, never string-formatted into the query.
    clauses = []
    params: list = []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if category:
        clauses.append("category = ?")
        params.append(category)
    if month:
        clauses.append("date LIKE ?")
        params.append(f"{month}%")

    query = "SELECT * FROM transactions"
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY date DESC"

    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


class ClassifyRequest(BaseModel):
    category: str
    save_as_rule: bool = False
    match_text: Optional[str] = None
    source: Optional[str] = None  # rule scope: a specific source key, or None for "any source"

    @field_validator("category")
    @classmethod
    def category_must_be_known(cls, v: str) -> str:
        if v not in CATEGORIES:
            raise ValueError(f"Unknown category: {v}")
        return v

    @field_validator("match_text")
    @classmethod
    def match_text_not_blank(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.strip():
            raise ValueError("match_text can't be blank")
        return v.strip() if v else v

    @field_validator("source")
    @classmethod
    def source_must_be_known(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VALID_SOURCES:
            raise ValueError(f"Unknown source: {v}")
        return v


@router.post("/transactions/{transaction_id}/classify")
def classify_transaction(transaction_id: int, body: ClassifyRequest):
    if body.save_as_rule and not body.match_text:
        raise HTTPException(
            400, "match_text is required when save_as_rule is set — pick the keyword phrase to match on"
        )

    with get_conn() as conn:
        txn = conn.execute(
            "SELECT * FROM transactions WHERE id = ?", (transaction_id,)
        ).fetchone()
        if not txn:
            raise HTTPException(404, "Transaction not found")

        rule_id = None
        if body.save_as_rule:
            rule_id = rules_store.create_rule(conn, body.source, body.match_text, body.category)

        conn.execute(
            "UPDATE transactions SET category = ?, rule_id = ?, status = 'classified' WHERE id = ?",
            (body.category, rule_id, transaction_id),
        )
    # The get_conn() block above commits on exit — only now is the new rule
    # visible to a fresh connection. Re-enrich immediately so every other
    # needs_review transaction the new rule matches gets reclassified right
    # away, instead of sitting stale until the next full "Run Pipeline".
    enrich_summary = enrich_all() if body.save_as_rule else None
    return {"ok": True, "enrich": enrich_summary}


@router.get("/rules")
def get_rules():
    with get_conn() as conn:
        return [dict(r) for r in rules_store.list_rules(conn)]


class RuleRequest(BaseModel):
    source: Optional[str] = None
    match_text: str
    category: str
    priority: int = 100

    @field_validator("category")
    @classmethod
    def category_must_be_known(cls, v: str) -> str:
        if v not in CATEGORIES:
            raise ValueError(f"Unknown category: {v}")
        return v

    @field_validator("match_text")
    @classmethod
    def match_text_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("match_text can't be blank")
        return v.strip()


@router.post("/rules")
def add_rule(body: RuleRequest):
    with get_conn() as conn:
        rule_id = rules_store.create_rule(
            conn, body.source, body.match_text, body.category, body.priority
        )
    # Same reasoning as classify_transaction: re-enrich immediately so a
    # rule added directly through this form also reclassifies any matching
    # needs_review rows right away, not just on the next full trigger.
    enrich_summary = enrich_all()
    return {"id": rule_id, "enrich": enrich_summary}


@router.put("/rules/{rule_id}")
def edit_rule(rule_id: int, body: RuleRequest):
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM rules WHERE id = ?", (rule_id,)).fetchone()
        if not existing:
            raise HTTPException(404, "Rule not found")
        rules_store.update_rule(conn, rule_id, body.source, body.match_text, body.category, body.priority)
    # Scoped to the last batch only, not every needs_review row ever —
    # an edited rule shouldn't reach back and silently re-sweep old,
    # already-reviewed uploads.
    enrich_summary = enrich_last_batch()
    return {"ok": True, "enrich": enrich_summary}


@router.delete("/rules/{rule_id}")
def remove_rule(rule_id: int):
    with get_conn() as conn:
        last_batch = conn.execute("SELECT MAX(batch_id) AS b FROM transactions").fetchone()["b"]
        reverted = 0
        if last_batch is not None:
            # Only the most recent batch reverts to needs_review — older,
            # already-reviewed batches that this rule also classified are
            # left alone rather than silently reopened.
            cur = conn.execute(
                "UPDATE transactions SET category = NULL, rule_id = NULL, status = 'needs_review' "
                "WHERE rule_id = ? AND batch_id = ?",
                (rule_id, last_batch),
            )
            reverted = cur.rowcount
        rules_store.delete_rule(conn, rule_id)
    return {"ok": True, "reverted": reverted}


class BalanceEntryRequest(BaseModel):
    account: str
    recorded_at: str  # ISO-8601 datetime, e.g. "2026-07-15T14:30:00"
    balance: float

    @field_validator("account")
    @classmethod
    def account_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("account can't be blank")
        return v.strip()

    @field_validator("recorded_at")
    @classmethod
    def recorded_at_must_parse(cls, v: str) -> str:
        try:
            datetime.fromisoformat(v)
        except ValueError:
            raise ValueError(f"recorded_at must be an ISO-8601 datetime, got: {v!r}")
        return v


@router.get("/balance-entries")
def get_balance_entries():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM balance_entries ORDER BY account, recorded_at"
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/balance-entries")
def add_balance_entry(body: BalanceEntryRequest):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO balance_entries (account, recorded_at, balance) VALUES (?, ?, ?)",
            (body.account, body.recorded_at, body.balance),
        )
        entry_id = cur.lastrowid
    return {"id": entry_id, "ok": True}


@router.delete("/balance-entries/{entry_id}")
def remove_balance_entry(entry_id: int):
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id FROM balance_entries WHERE id = ?", (entry_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(404, "Balance entry not found")
        conn.execute("DELETE FROM balance_entries WHERE id = ?", (entry_id,))
    return {"ok": True}


@router.get("/export/xlsx")
def download_xlsx():
    if not ACCOUNTS_XLSX.exists():
        raise HTTPException(404, "No export yet — trigger a run first")
    return FileResponse(ACCOUNTS_XLSX, filename=ACCOUNTS_XLSX.name)


@router.get("/export/csv")
def download_csv():
    if not TRANSACTIONS_CSV.exists():
        raise HTTPException(404, "No export yet — trigger a run first")
    return FileResponse(TRANSACTIONS_CSV, filename=TRANSACTIONS_CSV.name)
