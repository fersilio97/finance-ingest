"""Future ML classification integration point. Currently a no-op — always
returns None, so unmatched transactions fall through to manual review.
Wire a real model in here later without changing the enrichment pipeline's
contract (predict(transaction) -> category or None)."""

from typing import Optional


def predict(transaction: dict) -> Optional[str]:
    return None
