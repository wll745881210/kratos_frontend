"""binread — read kratos .bin output files (blocks, fields, slices).

Built on the vendored low-level reader `vendor/binary_io.py` (format
owner: kratos trunk `visual/binary_io.py`). Key conventions verified
against kratos `visual/hydro_data.py`:

- Per-block keys: `block_N|n_ceff` (i×3, x,y,z order), `block_N|n_gh`,
  `block_N|level`, `block_N|xf0` / `block_N|dx0` (f×3, x,y,z).
- Field keys: `block_N|<name>_n_int`, `_n_gh`, `_n_cell`, `_field`.
  `_n_gh`/`_n_cell` are stored x,y,z and must be REVERSED for numpy
  (z,y,x) reshaping (hydro_data.get_field does `[::-1]`).
- `_field` payload: C-order `(nz, ny, nx, n_int)` including ghosts;
  ghost cells are stripped per axis after reshape.
- `input_args` holds the run's input map (binary: size_t count, then
  per entry size_t key-len + key + size_t val-len + val).
- Global entries: `time`/`dt`/`t_out` (float), `cycle`/`i_out` (int).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field as _dc_field
from pathlib import Path
from typing import Optional

import numpy as np

from .vendor.binary_io import binary_io

_GLOBAL_FLOAT = ("time", "dt", "t_out")
_GLOBAL_INT = ("cycle", "i_out")


@dataclass
class BlockInfo:
    name: str
    level: int = 0
    xf0: list = _dc_field(default_factory=list)   # x,y,z
    dx0: list = _dc_field(default_factory=list)   # x,y,z
    n_cell: list = _dc_field(default_factory=list)  # x,y,z (interior)


class BinFile:
    """Reader for one kratos .bin output file."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        self._io = binary_io(self.path)
        self._io.open()

    # ---- structure -------------------------------------------------
    def keys(self) -> list:
        return list(self._io.hmap.keys())

    def blocks(self) -> list:
        """All block names, sorted by numeric suffix (block_0, block_1...)."""
        out = set()
        for k in self._io.hmap:
            if k.startswith("block_"):
                out.add(k.split("|", 1)[0])
        return sorted(out, key=lambda b: int(b.split("_", 1)[1]))

    def _entry(self, key: str, dtype: str) -> np.ndarray:
        size, u_size, _off = self._io.hmap[key]
        return np.frombuffer(self._io[key], dtype=f"<{dtype}{u_size}")

    def block_info(self, blk: str) -> BlockInfo:
        info = BlockInfo(name=blk)
        h = self._io.hmap
        if f"{blk}|level" in h:
            info.level = int(self._entry(f"{blk}|level", "i")[0])
        if f"{blk}|xf0" in h:
            info.xf0 = [float(v) for v in self._entry(f"{blk}|xf0", "f")]
        if f"{blk}|dx0" in h:
            info.dx0 = [float(v) for v in self._entry(f"{blk}|dx0", "f")]
        if f"{blk}|n_ceff" in h:
            info.n_cell = [int(v) for v in self._entry(f"{blk}|n_ceff", "i")]
        return info

    def fields(self, blk: Optional[str] = None) -> list:
        """Field names (without the `_n_int` etc. suffixes)."""
        out = set()
        pref = f"{blk}|" if blk else ""
        for k in self._io.hmap:
            if not k.startswith(pref):
                continue
            rest = k[len(pref):]
            for suf in ("_n_int", "_n_gh", "_n_cell", "_field"):
                if rest.endswith(suf) and "|" not in rest:
                    out.add(rest[: -len(suf)])
        return sorted(out)

    # ---- data ------------------------------------------------------
    def read_field(self, blk: str, name: str) -> np.ndarray:
        """Ghost-stripped field, shape (n_int, nz, ny, nx)."""
        p = f"{blk}|{name}"
        n_int = int(self._entry(p + "_n_int", "i")[0])
        n_gh = self._entry(p + "_n_gh", "i")[::-1]     # -> z,y,x
        n_c = self._entry(p + "_n_cell", "i")[::-1]    # -> z,y,x
        fld = self._entry(p + "_field", "f").reshape((*n_c, -1))
        fld = fld[n_gh[0]: n_c[0] - n_gh[0] if n_gh[0] else None,
                  n_gh[1]: n_c[1] - n_gh[1] if n_gh[1] else None,
                  n_gh[2]: n_c[2] - n_gh[2] if n_gh[2] else None, :]
        if fld.shape[-1] != n_int:
            raise ValueError(f"{p}: inconsistent n_internal")
        return np.stack([fld[..., n] for n in range(n_int)])

    def slice2d(self, blk: str, name: str, component: int = 0,
                axis: int = 2, index: Optional[int] = None) -> dict:
        """2D slice of one component.

        axis: 0=x, 1=y, 2=z (normal of the slice plane).
        Returns rows ordered (slow, fast) = remaining axes in z,y,x
        order with x fastest, plus the physical extent (x,y of the
        slice plane) and min/max.
        """
        arr = self.read_field(blk, name)[component]     # (nz,ny,nx)
        ax_zyx = 2 - axis                                # axis x-> zyx idx
        n = arr.shape[ax_zyx]
        i = index if index is not None else n // 2
        i = max(0, min(int(i), n - 1))
        img = np.take(arr, i, axis=ax_zyx)               # 2D
        info = self.block_info(blk)
        # plane axes in x,y,z: the two axes != `axis`
        plane = [a for a in (0, 1, 2) if a != axis]
        extent = []
        for a in plane:
            x0, dx, nc = info.xf0[a], info.dx0[a], info.n_cell[a]
            extent += [x0, x0 + dx * nc] if x0 or dx or nc else [0.0, 1.0]
        finite = img[np.isfinite(img)]
        return {
            "block": blk, "field": name, "component": component,
            "axis": axis, "index": i, "n_index": n,
            "shape": list(img.shape),
            "extent": extent,   # [h0, h1, v0, v1] in plane coords
            "min": float(finite.min()) if finite.size else None,
            "max": float(finite.max()) if finite.size else None,
            "data": [[None if not math.isfinite(v) else float(v)
                      for v in row] for row in img.tolist()],
        }

    def read_args(self) -> Optional[dict]:
        """The run's input map as {section|key: value-string}.

        `input_args` is a binary serialization of kratos's item_map:
        size_t n_entries, then per entry size_t key_len, key bytes,
        size_t value_len, value bytes (see kratos io/binary writer).
        """
        if "input_args" not in self._io.hmap:
            return None
        raw = self._io["input_args"]
        out: dict = {}
        off = 0
        sz = self._io.s_size_t

        def take(n: int) -> bytes:
            nonlocal off
            b = raw[off:off + n]
            off += n
            return b

        def take_size() -> int:
            return int.from_bytes(take(sz), self._io.endian)

        n = take_size()
        for _ in range(n):
            k = take(take_size()).decode("ascii", errors="replace")
            v = take(take_size()).decode("utf-8", errors="replace")
            out[k] = v
        return out

    def close(self):
        self._io.close()

    def globals(self) -> dict:
        """Global scalars: time, dt, cycle, ... (dtypes per kratos writer)."""
        out: dict = {}
        h = self._io.hmap
        for k in _GLOBAL_FLOAT:
            if k in h:
                out[k] = float(self._entry(k, "f")[0])
        for k in _GLOBAL_INT:
            if k in h:
                out[k] = int(self._entry(k, "i")[0])
        return out
