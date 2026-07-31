from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from ..categories import CATEGORIES
from ..db import SOURCES, get_conn
from ..pipeline.enrich import enrich_all, enrich_last_batch
from ..pipeline.export import ACCOUNTS_XLSX, TRANSACTIONS_CSV, export_all
from ..pipeline.ingest import save_upload
from ..pipeline.normalize import normalize_all
from ..rules import store as rules_store

router = APIRouter(prefix="/api")

VALID_SOURCES = {key for key, *_ in SOURCES}


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
    for f in files:
        content = await f.read()
        path = save_upload(source, f.filename, content)
        saved.append(str(path))
    return {"saved": saved}


@router.post("/trigger")
def trigger():
    return {
        "normalize": normalize_all(),
        "enrich": enrich_all(),
        "export": export_all(),
    }


@router.get("/transactions")
def list_transactions(status: Optional[str] = None):
    with get_conn() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM transactions WHERE status = ? ORDER BY date DESC", (status,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM transactions ORDER BY date DESC").fetchall()
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


class ManualBalanceRequest(BaseModel):
    account: str
    month: str  # "YYYY-MM"
    balance: float


@router.get("/manual-balances")
def get_manual_balances():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM manual_balances ORDER BY account, month"
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/manual-balances")
def set_manual_balance(body: ManualBalanceRequest):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO manual_balances (account, month, balance) VALUES (?, ?, ?) "
            "ON CONFLICT(account, month) DO UPDATE SET balance = excluded.balance",
            (body.account, body.month, body.balance),
        )
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
