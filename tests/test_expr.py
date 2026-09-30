"""Golden-vector tests for the Python expression engine port.

The vectors in tests/golden/expr_vectors.json are the shared contract with
the C++ engine (cross-checked by tests/golden/check_cpp.py). Here they run
against kratos_spec.expr.
"""

import json
import math
import os

import pytest

from kratos_spec import expr

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "golden", "expr_vectors.json")


def _load():
    with open(VECTORS) as f:
        return json.load(f)["vectors"]


VECTORS_ALL = _load()
VALUE_VECTORS = [v for v in VECTORS_ALL if "expect" in v]
ERROR_VECTORS = [v for v in VECTORS_ALL if "error" in v]


def _vars(v):
    return v.get("vars", {"x": 0, "y": 0, "z": 0, "t": 0})


@pytest.mark.parametrize("v", VALUE_VECTORS, ids=[v["name"] for v in VALUE_VECTORS])
def test_value_vector(v):
    varmap = _vars(v)
    prog = expr.compile(v["expr"], {n: i for i, n in enumerate(varmap)})
    got = expr.evaluate(prog, list(varmap.values()))
    exp = v["expect"]
    if isinstance(exp, str):
        if exp == "nan":
            assert math.isnan(got)
        elif exp == "inf":
            assert got == math.inf
        elif exp == "-inf":
            assert got == -math.inf
        return
    exp = float(exp)
    if exp == 0:
        assert got == 0
    else:
        assert abs(got - exp) <= 1e-12 * max(1.0, abs(exp))


@pytest.mark.parametrize("v", ERROR_VECTORS, ids=[v["name"] for v in ERROR_VECTORS])
def test_error_vector(v):
    varmap = _vars(v)
    with pytest.raises(expr.ExprError) as exc:
        expr.compile(v["expr"], {n: i for i, n in enumerate(varmap)})
    assert v["error"] in str(exc.value)


def test_error_message_format():
    with pytest.raises(expr.ExprError) as exc:
        expr.compile("foo")
    # Same format as the C++ engine: expr: <msg> (at byte N of "<src>")
    assert str(exc.value) == 'expr: unknown variable \'foo\' (at byte 3 of "foo")'
