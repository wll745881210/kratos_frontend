#!/usr/bin/env python3
"""Cross-check golden expression vectors against the C++ engine (source of truth).

Usage:
  python tests/golden/check_cpp.py [path-to-usr_ext/universal]

Requires g++ and the kratos universal-pgen directory (default:
~/apps/kratos_frontend_dev/usr_ext/universal). Not part of the default
pytest run (needs a C++ toolchain + kratos checkout); run after any
grammar change in expr.h / expr.py / expr_vectors.json.
"""

import json
import math
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "expr_vectors.json")
HARNESS = os.path.join(HERE, "expr_cpp_harness.cpp")

DEFAULT_UNIVERSAL = os.path.expanduser(
    "~/apps/kratos_frontend_dev/usr_ext/universal"
)


def load_vectors():
    with open(VECTORS) as f:
        return json.load(f)["vectors"]


def vector_vars(v):
    return v.get("vars", {"x": 0, "y": 0, "z": 0, "t": 0})


def main() -> int:
    univ_dir = (
        sys.argv[1] if len(sys.argv) > 1 else DEFAULT_UNIVERSAL
    )
    if not os.path.isfile(os.path.join(univ_dir, "expr.h")):
        print(f"expr.h not found in {univ_dir}", file=sys.stderr)
        return 2

    vectors = load_vectors()

    with tempfile.TemporaryDirectory() as tmp:
        exe = os.path.join(tmp, "expr_cpp_harness")
        subprocess.run(
            [
                "g++", "-std=c++17", "-O2",
                "-D__host__=", "-D__device__=",
                "-I", univ_dir, HARNESS, "-o", exe,
            ],
            check=True,
        )

        # TSV: expr \t name0=val0 \t name1=val1 ...
        lines = []
        for v in vectors:
            cols = [v["expr"] if v["expr"] else " "] + [
                f"{n}={float(x)!r}" for n, x in vector_vars(v).items()
            ]
            lines.append("\t".join(cols))
        out = subprocess.run(
            [exe], input="\n".join(lines) + "\n",
            capture_output=True, text=True, check=True,
        ).stdout.splitlines()

    if len(out) != len(vectors):
        print(f"output line count {len(out)} != vectors {len(vectors)}")
        return 1

    # Note: harness receives " " for the empty-expression vector; C++ skips
    # whitespace then fails at end -> message differs from "empty expression"
    # only in wording of the fail site; accept any ERROR for error vectors.

    n_fail = 0
    for v, line in zip(vectors, out):
        name = v["name"]
        if "error" in v:
            if not line.startswith("ERROR:"):
                print(f"FAIL {name}: expected error, got {line}")
                n_fail += 1
            continue
        if line.startswith("ERROR:"):
            print(f"FAIL {name}: unexpected {line}")
            n_fail += 1
            continue
        got = float(line)
        exp = v["expect"]
        ok = False
        if isinstance(exp, str):
            if exp == "nan":
                ok = math.isnan(got)
            elif exp == "inf":
                ok = got == math.inf
            elif exp == "-inf":
                ok = got == -math.inf
        else:
            exp = float(exp)
            if math.isnan(got):
                ok = False
            elif exp == 0:
                ok = got == 0
            else:
                ok = abs(got - exp) <= 1e-12 * max(1.0, abs(exp))
        if not ok:
            print(f"FAIL {name}: expr={v['expr']!r} expect={exp} got={got}")
            n_fail += 1
    if n_fail:
        print(f"{n_fail}/{len(vectors)} FAILED")
        return 1
    print(f"all {len(vectors)} vectors match the C++ engine")
    return 0


if __name__ == "__main__":
    sys.exit(main())
