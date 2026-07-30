from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .api.insights import router as insights_router
from .api.routes import router as api_router
from .db import get_conn, init_db
from .seed_rules import seed as seed_rules

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = REPO_ROOT / "frontend"

app = FastAPI(title="Finance Ingestion App")
app.include_router(api_router)
app.include_router(insights_router)


@app.on_event("startup")
def on_startup():
    init_db()
    with get_conn() as conn:
        seed_rules(conn)


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
