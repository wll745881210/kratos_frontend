"""Key-identical comparison of two par files (the M0 acceptance metric).

Two par files are *identical* when they contain the same set of
``section|key`` pairs and every pair of values is equal after
normalisation (numbers compare numerically, strings verbatim).  Section
order, key order, whitespace and comments are ignored.
"""

from __future__ import annotations

from .parfile import ParFile
from .values import infer_value, values_equal


def diff_par(a: ParFile, b: ParFile) -> list[str]:
    problems: list[str] = []
    keys_a = {f"{s}|{k}": v for s, kv in a.sections.items()
              for k, v in kv.items()}
    keys_b = {f"{s}|{k}": v for s, kv in b.sections.items()
              for k, v in kv.items()}
    for k in sorted(keys_a.keys() - keys_b.keys()):
        problems.append(f"only in first:  {k} = {keys_a[k]!r}")
    for k in sorted(keys_b.keys() - keys_a.keys()):
        problems.append(f"only in second: {k} = {keys_b[k]!r}")
    for k in sorted(keys_a.keys() & keys_b.keys()):
        va, vb = infer_value(keys_a[k]), infer_value(keys_b[k])
        if not values_equal(va, vb):
            problems.append(
                f"value mismatch: {k}: {keys_a[k]!r} != {keys_b[k]!r}")
    return problems


def diff_par_files(path_a: str, path_b: str) -> list[str]:
    from .parfile import load_par
    return diff_par(load_par(path_a), load_par(path_b))
