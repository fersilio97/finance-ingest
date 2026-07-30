from . import (
    boa_checking,
    boa_credit_card,
    fidelity_credit_card,
    fidelity_savings,
    hsa,
    k401,
)

PARSERS = {
    "boa_checking": boa_checking.parse,
    "boa_credit_card": boa_credit_card.parse,
    "fidelity_credit_card": fidelity_credit_card.parse,
    "fidelity_savings": fidelity_savings.parse,
    "hsa": hsa.parse,
    "k401": k401.parse,
}
