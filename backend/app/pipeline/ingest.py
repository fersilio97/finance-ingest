"""Stage 1: store uploaded files under data/incoming/<source>/."""

from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"
INCOMING_DIR = DATA_DIR / "incoming"


def save_upload(source: str, filename: str, content: bytes) -> Path:
    dest_dir = INCOMING_DIR / source
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    dest.write_bytes(content)
    return dest


def list_incoming(source: Optional[str] = None) -> list[Path]:
    if source:
        source_dir = INCOMING_DIR / source
        return sorted(source_dir.glob("*.csv")) if source_dir.exists() else []
    if not INCOMING_DIR.exists():
        return []
    return sorted(INCOMING_DIR.glob("*/*.csv"))
