"""Cross-field validation: checks that span multiple keys/sections.

These mirror failure modes verified in the kratos trunk:

- mesh: ``n_cell_global[a] % n_cell_block[a] != 0`` throws
  "Mesh size indivisible by sub-mesh." (meshgen.cpp); a zero size on
  an axis below ``n_dim`` throws "Zero mesh size".
- unit: the dynamics EoS holds ``phys::unit_t<type::float_t>`` (FP32;
  src/modules/dynamics/prototypes/eos.h:35).  If any derived unit
  (``m0 = rho0*l0^3``, ``ene0 = rho0*l0^2/t0^2``, ``vel0 = l0/t0``)
  exceeds the float32 range, ``unit_t::init`` throws
  "Unit sys overflow" (src/utilities/phys/unit.h:47-49).
"""

from __future__ import annotations

from .spec import Issue

# float32 limits (IEEE 754 binary32)
F32_MAX = 3.4028234663852886e38
F32_MIN_NORMAL = 1.1754943508222875e-38

CGS_MP = 1.67262192369e-24   # matches src/utilities/phys/constants.h


def _as_vec(v) -> list | None:
    if isinstance(v, (int, float)):
        return [v]
    if isinstance(v, (list, tuple)):
        return list(v)
    return None


def _check_mesh(spec) -> list[Issue]:
    issues: list[Issue] = []
    mesh = spec.sections.get("mesh")
    if not isinstance(mesh, dict):
        return issues
    n_glob = _as_vec(mesh.get("n_cell_global"))
    if n_glob is None or len(n_glob) != 3:
        return issues
    n_block = _as_vec(mesh.get("n_cell_block"))
    if n_block is None:
        n_block = list(n_glob)          # trunk default: single block
    if len(n_block) != 3:
        return issues
    # n_dim = highest axis index with size > 1 (meshgen.cpp)
    n_dim = 0
    for a in range(3):
        if isinstance(n_glob[a], (int, float)) and n_glob[a] > 1:
            n_dim = a + 1
    blocks = 1
    for a in range(n_dim):
        g, b = n_glob[a], n_block[a]
        if not isinstance(g, int) or not isinstance(b, int):
            continue                    # type errors handled elsewhere
        if g == 0:
            issues.append(Issue(
                "error", f"mesh.n_cell_global",
                f"zero mesh size on axis {a} (kratos throws "
                f"'Zero mesh size')"))
            continue
        if b <= 0:
            issues.append(Issue(
                "error", "mesh.n_cell_block",
                f"n_cell_block[{a}] must be positive"))
            continue
        if g % b != 0:
            issues.append(Issue(
                "error", "mesh.n_cell_block",
                f"n_cell_global[{a}]={g} indivisible by "
                f"n_cell_block[{a}]={b} (kratos throws "
                f"'Mesh size indivisible by sub-mesh.')"))
        else:
            blocks *= g // b
    return issues


def _unit_numbers(spec) -> tuple[float, float, float] | None:
    """Return (l0, t0, rho0) or None if [unit] is absent/incomplete."""
    unit = spec.sections.get("unit")
    if not isinstance(unit, dict):
        return None
    def num(key, default):
        v = unit.get(key, default)
        if isinstance(v, str):
            if v in ("mp", "mh"):
                return CGS_MP
            try:
                return float(v)
            except ValueError:
                return None
        if isinstance(v, (int, float)):
            return float(v)
        return None
    l0 = num("length", 1.0)
    t0 = num("time", 1.0)
    if "mass" in unit:
        m0 = num("mass", None)
        if m0 is None or l0 is None:
            return None
        rho0 = m0 / l0 ** 3 if l0 else None
    else:
        rho0 = num("density", 1.0)
    if l0 is None or t0 is None or rho0 is None:
        return None
    return l0, t0, rho0


def unit_summary(spec) -> dict | None:
    """Derived CGS units for display/pre-check, or None if N/A."""
    nums = _unit_numbers(spec)
    if nums is None:
        return None
    l0, t0, rho0 = nums
    if l0 == 0 or t0 == 0:
        return {"l0": l0, "t0": t0, "rho0": rho0,
                "m0": None, "vel0": None, "ene0": None}
    return {"l0": l0, "t0": t0, "rho0": rho0,
            "m0": rho0 * l0 ** 3,
            "vel0": l0 / t0,
            "ene0": rho0 * (l0 / t0) ** 2}


def _check_unit(spec) -> list[Issue]:
    issues: list[Issue] = []
    s = unit_summary(spec)
    if s is None:
        return issues
    for key in ("m0", "vel0", "ene0"):
        v = s.get(key)
        if v is None:
            continue
        if abs(v) > F32_MAX:
            issues.append(Issue(
                "error", f"unit.{key}",
                f"derived unit {key}={v:.3e} overflows float32 "
                f"(max {F32_MAX:.3e}); kratos throws "
                f"'Unit sys overflow' -- rescale [unit] "
                f"(e.g. smaller length or different density/mass)"))
        elif 0 < abs(v) < F32_MIN_NORMAL:
            issues.append(Issue(
                "warning", f"unit.{key}",
                f"derived unit {key}={v:.3e} underflows normal "
                f"float32 range (min {F32_MIN_NORMAL:.3e})"))
    return issues




def _check_refine(spec) -> list[Issue]:
    """refine_region_* bounds/level checks (regulations section 3.3).

    Mirrors meshgen.cpp: a region whose loc/x_min/x_max falls outside
    [mesh.x_min, mesh.x_max] on a live axis makes kratos throw
    "Incorrect SMR region"; level <= 0 regions are silently ignored.
    """
    issues: list[Issue] = []
    mesh = spec.sections.get("mesh")
    if not isinstance(mesh, dict):
        return issues
    x_min = _as_vec(mesh.get("x_min"))
    x_max = _as_vec(mesh.get("x_max"))
    n_glob = _as_vec(mesh.get("n_cell_global"))
    if not (x_min and x_max and n_glob):
        return issues
    n_dim = 0
    for a in range(3):
        if isinstance(n_glob[a], (int, float)) and n_glob[a] > 1:
            n_dim = a + 1
    for name, kv in spec.sections.items():
        if not (isinstance(kv, dict) and name.startswith("refine_region")):
            continue
        level = kv.get("level", 0)
        if isinstance(level, (int, float)) and level <= 0:
            issues.append(Issue(
                "warning", f"{name}.level",
                f"{name}: level <= 0 -> region silently ignored by kratos"))
        for key in ("loc", "x_min", "x_max"):
            v = _as_vec(kv.get(key))
            if v is None:
                continue
            for a in range(n_dim):
                if not isinstance(v[a], (int, float)):
                    continue
                if v[a] < x_min[a] or v[a] > x_max[a]:
                    issues.append(Issue(
                        "error", f"{name}.{key}",
                        f"{name}.{key}[{a}]={v[a]} outside domain "
                        f"[{x_min[a]}, {x_max[a]}] (kratos throws "
                        f"'Incorrect SMR region')"))
    return issues


def cross_validate(spec) -> list[Issue]:
    """Cross-field checks; appended to Spec.validate()."""
    return (_check_mesh(spec) + _check_unit(spec)
            + _check_refine(spec))
