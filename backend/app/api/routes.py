from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..db import SOURCES, get_conn
from ..pipeline.enrich import enrich_all
from ..pipeline.export import ACCOUNTS_XLSX, TRANSACTIONS_CSV, export_all
from ..pipeline.ingest import save_upload
from ..pipeline.normalize import normalize_all
from ..rules import store as rules_store

router = APIRouter(prefix="/api")

VALID_SOURCES = {key for key, *_ in SOURCES}


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
    rule_source_scope: bool = True


@router.post("/transactions/{transaction_id}/classify")
def classify_transaction(transaction_id: int, body: ClassifyRequest):
    with get_conn() as conn:
        txn = conn.execute(
            "SELECT * FROM transactions WHERE id = ?", (transaction_id,)
        ).fetchone()
        if not txn:
            raise HTTPException(404, "Transaction not found")

        rule_id = None
        if body.save_as_rule:
            match_text = body.match_text or txn["description"]
            source = txn["source"] if body.rule_source_scope else None
            rule_id = rules_store.create_rule(conn, source, match_text, body.category)

        conn.execute(
            "UPDATE transactions SET category = ?, rule_id = ?, status = 'classified' WHERE id = ?",
            (body.category, rule_id, transaction_id),
        )
    return {"ok": True}


@router.get("/rules")
def get_rules():
    with get_conn() as conn:
        return [dict(r) for r in rules_store.list_rules(conn)]


class RuleRequest(BaseModel):
    source: Optional[str] = None
    match_text: str
    category: str
    priority: int = 100


@router.post("/rules")
def add_rule(body: RuleRequest):
    with get_conn() as conn:
        rule_id = rules_store.create_rule(
            conn, body.source, body.match_text, body.category, body.priority
        )
    return {"id": rule_id}


@router.delete("/rules/{rule_id}")
def remove_rule(rule_id: int):
    with get_conn() as conn:
        rules_store.delete_rule(conn, rule_id)
    return {"ok": True}


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
