#!/usr/bin/env python3
"""rand(i,j,k,seed) uniformity / coordinate-independence check.

Reads universal-pgen binary dumps of a pure-noise initial condition
(rho = 1 + amp*rand(i,j,k,seed)) and computes, per block and per
axis, the Pearson correlation between the cell-center coordinate and
rho.  Under the null hypothesis (i.i.d. noise) |r| has expectation
~0.8/sqrt(n_cell-1); significance is judged with a Bonferroni
correction across all (block, axis) tests of a case.

See docs/rand_verification.md for methodology and recorded results.

Usage:
    python3 tools/check_rand.py CASE_DIR [CASE_DIR ...]

Each CASE_DIR must contain exactly one *_00000.bin initial dump.
Requires the kratos_frontend package (run with the repo .venv python
or PYTHONPATH=core) and numpy.
"""
from __future__ import annotations

import glob
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "core"))
from kratos_spec.binread import BinFile  # noqa: E402


def normal_sf(x: float) -> float:
    """One-sided standard-normal survival function."""
    return 0.5 * math.erfc(x / math.sqrt(2.0))


def pearson_p(r: float, n: int) -> float:
    """Approximate two-sided p-value for Pearson r under iid null.

    Uses the Fisher z transform; adequate for n >> 10.
    """
    if n < 10 or abs(r) >= 1:
        return 1.0
    z = abs(math.atanh(min(max(r, -0.999999), 0.999999))) * math.sqrt(n - 3)
    return 2.0 * normal_sf(z)


def analyze(bin_path: str) -> dict:
    bf = BinFile(bin_path)
    rows = []
    pats = []
    for blk in bf.blocks():
        info = bf.block_info(blk)
        rho = bf.read_field(blk, "hydro_cons")[0]  # (nz, ny, nx)
        pats.append((blk, info.level, rho.shape,
                     (rho - rho.mean()).ravel()))
        nz, ny, nx = rho.shape
        axes = {}
        for name, na, a in (("x", nx, 0), ("y", ny, 1), ("z", nz, 2)):
            xf0, dx0 = float(info.xf0[a]), float(info.dx0[a])
            cc = xf0 + (np.arange(na) + 0.5) * dx0
            shape = [1, 1, 1]
            shape[2 - a] = na  # array axes are z, y, x
            coord = np.broadcast_to(cc.reshape(shape), rho.shape)
            c0 = coord - coord.mean()
            r0 = rho - rho.mean()
            r = float((c0 * r0).sum()
                      / math.sqrt(float((c0 * c0).sum())
                                  * float((r0 * r0).sum())))
            axes[name] = r
        rows.append({"block": blk, "level": int(info.level),
                     "n": int(rho.size), **axes})

    # Cross-block independence: same-level, same-shape blocks
    # must NOT share the identical noise pattern (that was the
    # local-index bug caught by this very test).
    cross = {"max_r": 0.0, "min_d": float("inf"), "pairs": 0}
    groups: dict = {}
    for blk, lvl, shape, pat in pats:
        groups.setdefault((lvl, shape), []).append((blk, pat))
    for (lvl, shape), g in groups.items():
        if len(g) < 2:
            continue
        raw = np.stack([p for _, p in g])
        m = raw / np.linalg.norm(raw, axis=1, keepdims=True)
        cc = m @ m.T
        n = len(g)
        for a in range(n):
            for b in range(a + 1, n):
                cross["pairs"] += 1
                cross["max_r"] = max(cross["max_r"],
                                     abs(float(cc[a, b])))
                d = float(np.abs(raw[a] - raw[b]).max())
                cross["min_d"] = min(cross["min_d"], d)
    return {"rows": rows, "cross": cross}


def report(case: str, res: dict) -> bool:
    rows = res["rows"]
    n_tests = 3 * len(rows)
    alpha = 0.05 / max(n_tests, 1)
    worst = (1.0, "")
    print(f"== {case}: {len(rows)} blocks, {n_tests} tests, "
          f"Bonferroni alpha = {alpha:.2e}")
    print(f"{'block':<10} {'lvl':>3} {'n':>6} "
          f"{'r_x':>9} {'r_y':>9} {'r_z':>9}")
    for row in rows:
        print(f"{row['block']:<10} {row['level']:>3} {row['n']:>6} "
              f"{row['x']:>+9.4f} {row['y']:>+9.4f} {row['z']:>+9.4f}")
        for a in "xyz":
            p = pearson_p(row[a], row["n"])
            if p < worst[0]:
                worst = (p, f"{row['block']}:{a}")
    print(f"min p = {worst[0]:.3g} ({worst[1]}); "
          f"expect |r| ~ {0.8 / math.sqrt(rows[0]['n'] - 1):.4f} "
          f"under the null")
    cross = res["cross"]
    if cross["pairs"]:
        print(f"cross-block: {cross['pairs']} pairs, "
              f"max |corr| = {cross['max_r']:.4f}, "
              f"min pairwise max|diff| = {cross['min_d']:.4g}")
    ok = worst[0] > alpha and cross["min_d"] > 1e-12
    print("PASS" if ok else "FAIL")
    return ok


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    ok = True
    for case in argv:
        bins = sorted(glob.glob(os.path.join(case, "*_00000.bin")))
        if len(bins) != 1:
            print(f"{case}: expected exactly one *_00000.bin, "
                  f"found {len(bins)}")
            ok = False
            continue
        ok &= report(case, analyze(bins[0]))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
