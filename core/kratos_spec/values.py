"""Typed values: inference from raw par strings, formatting back to par
strings, and normalised comparison.

Spec JSON values are one of: bool, int, float, str, list (of int/float/
str).  Raw par values are untyped strings; inference is only used for
sections that have no descriptor (raw passthrough).  Typed sections are
coerced according to their descriptor instead.
"""

from __future__ import annotations

import re

_INT_RE = re.compile(r"^[+-]?\d+$")


def _is_int(tok: str) -> bool:
    return bool(_INT_RE.match(tok))


def _is_float(tok: str) -> bool:
    try:
        float(tok)
        return True
    except ValueError:
        return False


def infer_value(raw: str):
    """Best-effort typed value for a raw par string."""
    toks = raw.split()
    if not toks:
        return ""
    if len(toks) == 1:
        (tok,) = toks
        if _is_int(tok):
            return int(tok)
        if _is_float(tok):
            return float(tok)
        return tok
    if all(_is_int(t) for t in toks):
        return [int(t) for t in toks]
    if all(_is_float(t) for t in toks):
        return [float(t) for t in toks]
    return toks  # mixed -> list of strings (e.g. boundary kinds)


def _trim_sci(s: str) -> str:
    mant, _, exp = s.partition("e")
    mant = mant.rstrip("0").rstrip(".")
    return f"{mant}e{exp}"


def format_float(x: float) -> str:
    """Shortest human-friendly round-trip float text, valid for C++
    ``istringstream >>``.  Scientific notation for |x| >= 1e12 or
    < 1e-4 (so 3.156e13 emits as ``3.156e+13``), otherwise Python repr
    (always carries '.' or 'e', so floats stay visually floats).
    """
    x = float(x)
    if x != 0.0 and (abs(x) >= 1e12 or abs(x) < 1e-4):
        for prec in (14, 15, 16, 17):
            c = _trim_sci(f"{x:.{prec}e}")
            if float(c) == x:
                return c
    return repr(x)


def format_value(v) -> str:
    """Serialise a typed value to a par value string."""
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return format_float(v)
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return " ".join(format_value(x) for x in v)
    raise TypeError(f"Unsupported value type: {type(v)!r}")


def values_equal(a, b) -> bool:
    """Normalised equality: numbers compare numerically, strings verbatim."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(values_equal(x, y)
                                        for x, y in zip(a, b))
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    # mixed scalar types (str vs number): not equal
    return False
