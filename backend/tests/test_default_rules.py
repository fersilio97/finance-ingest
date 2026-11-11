"""Tests for seed_rules.ensure_default_rules. Plain unittest (runs under
`python -m unittest` or pytest) against a temp SQLite file, never the real DB."""

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.categories import CATEGORIES  # noqa: E402  (fails loudly if renamed)
from app.pipeline.enrich import enrich_all  # noqa: E402
from app.rules import store  # noqa: E402
from app.seed_rules import DEFAULT_RULES, ensure_default_rules, seed  # noqa: E402


class DefaultRulesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = db.DB_PATH
        db.DB_PATH = Path(self._tmp.name) / "test.db"
        db.init_db()

    def tearDown(self):
        db.DB_PATH = self._orig
        self._tmp.cleanup()

    def _count(self, conn):
        return conn.execute("SELECT COUNT(*) AS n FROM rules").fetchone()["n"]

    def test_default_categories_are_valid(self):
        for _, _, category in DEFAULT_RULES:
            self.assertIn(category, CATEGORIES)

    def test_idempotent_after_seed(self):
        with db.get_conn() as conn:
            seed(conn)
            before = self._count(conn)
            self.assertEqual(ensure_default_rules(conn), len(DEFAULT_RULES))
            after_first = self._count(conn)
            self.assertEqual(after_first, before + len(DEFAULT_RULES))
            self.assertEqual(ensure_default_rules(conn), 0)
            self.assertEqual(self._count(conn), after_first)

    def test_skips_equivalent_user_rule(self):
        with db.get_conn() as conn:
            # Different case/whitespace and a user-chosen category.
            store.create_rule(conn, "k401", "  FEES:  ", "Others")
            ensure_default_rules(conn)
            rows = conn.execute(
                "SELECT category FROM rules WHERE source = 'k401' AND match_text = 'fees:'"
            ).fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["category"], "Others")

    def test_k401_fee_row_classified_by_enrich_all(self):
        with db.get_conn() as conn:
            ensure_default_rules(conn)
            conn.execute(
                "INSERT INTO transactions (external_id, source, account, date, description, amount) "
                "VALUES ('x1', 'k401', '401k', '2026-01-01', 'Fees: Ssga 2060/ Sh Mat (6SC)', -0.5)"
            )
        result = enrich_all()
        self.assertEqual(result["classified"], 1)
        with db.get_conn() as conn:
            row = conn.execute("SELECT category, status FROM transactions").fetchone()
        self.assertEqual(row["category"], "Banking")
        self.assertEqual(row["status"], "classified")


if __name__ == "__main__":
    unittest.main()
