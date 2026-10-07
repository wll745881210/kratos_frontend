"""Server-side IC preview evaluation for the universal pgen.

Mirrors the init_cond semantics of usr_ext/universal/univ_hydro.h /
univ_mhd.h / univ_chem.h (kratos trunk) on the BASE mesh (no AMR tree):

  1. base state from [init] (rho0, pre0, vel0, b0) and [species_init];
  2. [ic.*] sections in lexicographic order; a region overwrites only the
     channels it sets, only where mask(x,y,z,t=0) != 0 (mask default "1");
  3. scalar vector values zero-fill missing components (kratos get<f3>
     semantics: vel0 = 1 -> (1,0,0));
  4. chem species channels x.<name>: base from [species_init] (kratos
     default 1e-20), renormalized to sum 1 when a species list exists.

Only channels the universal IC actually supports are produced:
rho, pre, vel_x/y/z, b_x/y/z (if b0 or any b_* channel present),
x.<species> (if [chemistry] species present or any x.* channel present).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from . import expr
from .spec import Issue, Spec
from .xchecks import CGS_MP, cgs_scales

# Channels in stable display order; x.* appended dynamically.
_BASE_CHANNELS = ["rho", "pre", "vel_x", "vel_y", "vel_z"]
_B_CHANNELS = ["b_x", "b_y", "b_z"]

# phys::cgs constants (src/utilities/phys/constants.h)
KB_CGS = 1.38065e-16
CGS_ME = 9.10938e-28
CGS_MA = 1.66054e-24

# Element masses (amu) mirroring periodic.cpp (first 30 + "Z" metal).
_ELEM_MASS = {
    "e": 5.49e-4, "H": 1.00794, "He": 4.0026, "Li": 6.941,
    "Be": 9.01218, "B": 10.811, "C": 12.0107, "N": 14.0067,
    "O": 15.9994, "F": 18.9994, "Ne": 20.1797, "Na": 22.9898,
    "Mg": 24.305, "Al": 26.9815, "Si": 28.0855, "P": 30.9738,
    "S": 32.065, "Cl": 35.453, "Ar": 39.948, "K": 39.0983,
    "Ca": 40.078, "Sc": 44.9559, "Ti": 47.867, "V": 50.9415,
    "Cr": 51.9961, "Mn": 54.938, "Fe": 55.845, "Co": 58.9332,
    "Ni": 58.6934, "Cu": 63.546, "Zn": 65.38, "Z": 16.0,
}


def _species_mass_cgs(formula: str) -> float:
    """Mirror chemistry.cpp parse_species_single mass computation."""
    import re

    s = formula.replace("*", "")
    chg = s.count("+") - s.count("-")
    s = s.replace("+", "").replace("-", "")
    s = re.sub(r"\([^)]*\)", "", s)
    if s == "e":
        return CGS_ME
    mass = -chg * CGS_ME
    for m in re.finditer(r"([A-Z][a-z]*)(\d*)", s):
        elem, n = m.group(1), m.group(2)
        if not elem:
            continue
        mass += CGS_MA * _ELEM_MASS.get(elem, 1.0) * (int(n) if n else 1)
    return mass

_MAX_DIM_HARD = 1024  # absolute cap per image dimension


@dataclass
class ICRegion:
    name: str
    mask: expr.Program
    channels: Dict[str, expr.Program] = field(default_factory=dict)
    # per-channel CGS->code-unit multiplier (1/div) for channels
    # declared via a _cgs key
    cgs: Dict[str, float] = field(default_factory=dict)


def _as_float(v, default: float = 0.0) -> float:
    try:
        if isinstance(v, (list, tuple)):
            v = v[0] if v else default
        return float(v)
    except (TypeError, ValueError):
        return default


def _as_vec3(v) -> List[float]:
    """kratos get<f3> semantics: scalar -> (v,0,0); short lists zero-fill."""
    if isinstance(v, (list, tuple)):
        out = [float(x) for x in v[:3]]
        return out + [0.0] * (3 - len(out))
    try:
        return [float(v), 0.0, 0.0]
    except (TypeError, ValueError):
        return [0.0, 0.0, 0.0]


def _mesh_grid(spec: Spec) -> Tuple[List[float], List[float], List[int], List[Issue]]:
    issues: List[Issue] = []
    mesh = spec.sections.get("mesh", {})

    def vec(key, default):
        if key not in mesh:
            return default
        return _as_vec3(mesh[key])

    x_min = vec("x_min", [0.0, 0.0, 0.0])
    x_max = vec("x_max", [1.0, 1.0, 1.0])
    n_cell = [max(1, int(_as_float(c, 1))) for c in vec("n_cell_global", [1, 1, 1])]
    if "n_cell_global" not in mesh:
        issues.append(
            Issue(level="error", where="mesh.n_cell_global",
                  message="missing mesh.n_cell_global; cannot build preview grid")
        )
    return x_min, x_max, n_cell, issues


def _species_list(spec: Spec, chem_section: dict) -> List[str]:
    sp = chem_section.get("species", [])
    if isinstance(sp, str):
        sp = sp.split()
    if isinstance(sp, (list, tuple)):
        return [str(s) for s in sp]
    return []


# --------------------------------------------------------------------------
# Role scoping (mirrors univ_mesh.h scoped_input): when [module.<role>]
# sections exist, module parameters live in [R.<section>] which the C++
# container remaps onto native names for that module only; global native
# sections stay visible to every module as shared defaults, with [R.*]
# overriding per key.  The preview follows the FIRST IC-capable module
# (hydro / mhd / chem_hydro) -- one field set is shown.
# --------------------------------------------------------------------------
IC_TYPES = ("hydro", "mhd", "chem_hydro")
CHEM_TYPES = ("chemistry",)


def _modules(spec: Spec) -> List[Tuple[str, str]]:
    out = []
    for name, sec in spec.sections.items():
        if name == "module" or name.startswith("module."):
            role = "" if name == "module" else name[len("module."):]
            out.append((role, str(sec.get("type", ""))))
    return out


def _scoped_merger(spec: Spec, role: str, chem_role: str):
    """Native-name -> value maps for init / species_init / chemistry /
    ic regions, each merged global-first then [R.*] per key."""

    def merged(native: str) -> dict:
        out = dict(spec.sections.get(native, {}))
        if role and f"{role}.{native}" in spec.sections:
            out.update(spec.sections[f"{role}.{native}"])
        return out

    init = merged("init")
    sp_init = merged("species_init")
    # chemistry section belongs to the chemistry module's role
    chem = dict(spec.sections.get("chemistry", {}))
    if chem_role and f"{chem_role}.chemistry" in spec.sections:
        chem.update(spec.sections[f"{chem_role}.chemistry"])

    regions: Dict[str, dict] = {}
    region_src: Dict[str, str] = {}
    for name, sec in spec.sections.items():
        if name.startswith("ic."):
            r = name[3:]
            regions.setdefault(r, {}).update(sec)
            region_src[r] = name
        elif role and name.startswith(f"{role}.ic."):
            r = name[len(f"{role}.ic."):]
            regions.setdefault(r, {}).update(sec)
            region_src[r] = name
    return init, sp_init, chem, regions, region_src


def build_ic(spec: Spec) -> Tuple[Dict[str, float], List[ICRegion], List[Issue]]:
    """Compile the IC stack from a Spec. Returns (base, regions, issues)."""
    issues: List[Issue] = []
    mods = _modules(spec)
    ic_role = next((r for r, t in mods if t in IC_TYPES), "")
    chem_role = next((r for r, t in mods if t in CHEM_TYPES), "")
    init, sp_init, chem, region_secs, region_src = _scoped_merger(
        spec, ic_role, chem_role)

    base: Dict[str, float] = {}
    scales = cgs_scales(spec)
    if scales is None and any(k in init for k in
                              ("rho0_cgs", "pre0_cgs",
                               "vel0_cgs", "b0_cgs")):
        issues.append(Issue(
            level="error", where="init",
            message="univ: _cgs keys require a [unit] section"))
    for bare, cgsk in (("rho0", "rho0_cgs"), ("pre0", "pre0_cgs"),
                       ("vel0", "vel0_cgs"), ("b0", "b0_cgs")):
        if bare in init and cgsk in init:
            issues.append(Issue(
                level="error", where="init",
                message=f"univ: [init] '{bare}' and '{cgsk}' are "
                        "mutually exclusive"))
    if "T0" in init and ("pre0" in init or "pre0_cgs" in init):
        issues.append(Issue(
            level="error", where="init",
            message="univ: [init] 'T0' and 'pre0'/'pre0_cgs' are "
                    "mutually exclusive (pick one pressure "
                    "specification)"))

    def conv(cgs_key: str, kind: str) -> Optional[float]:
        if cgs_key not in init or scales is None:
            return None
        return _as_float(init[cgs_key]) / scales[kind]

    base["rho"] = _as_float(init.get("rho0", 0.0))
    if (v := conv("rho0_cgs", "rho")) is not None:
        base["rho"] = v
    base["pre"] = _as_float(init.get("pre0", 0.0))
    if (v := conv("pre0_cgs", "pre")) is not None:
        base["pre"] = v
    vel0_cgs = init.get("vel0_cgs")
    if vel0_cgs is not None and scales is not None:
        vel0 = _as_vec3(vel0_cgs)
        for a in range(3):
            vel0[a] /= scales["vel"]
    else:
        vel0 = _as_vec3(init.get("vel0", 0.0))
    for a in range(3):
        base[f"vel_{'xyz'[a]}"] = vel0[a]
    b0_cgs = init.get("b0_cgs")
    if b0_cgs is not None or "b0" in init:
        b0 = _as_vec3(b0_cgs if b0_cgs is not None else init["b0"])
        if b0_cgs is not None and scales is not None:
            for a in range(3):
                b0[a] /= scales["b"]
        for a in range(3):
            base[f"b_{'xyz'[a]}"] = b0[a]

    species = _species_list(spec, chem)
    for sp in species:
        base[f"x.{sp}"] = _as_float(sp_init.get(sp, 1e-20), 1e-20)

    # chem T0 pressure path (read_chem: pre0 = kb*T*rho/mu_mix),
    # applied only when no explicit pressure was given.
    if "T0" in init and base.get("pre", 0.0) == 0.0 and scales is not None:
        rho_cgs = base["rho"] * scales["rho"]
        if species:
            xvals = [base.get(f"x.{s}", 1e-20) or 1e-20
                     for s in species]
            norm = sum(xvals) or 1.0
            mu = sum((x / norm) * _species_mass_cgs(s)
                     for x, s in zip(xvals, species))
        else:
            mu = CGS_MP
        base["pre"] = (KB_CGS * _as_float(init["T0"]) * rho_cgs
                       / mu / scales["pre"])

    regions: List[ICRegion] = []
    for name in sorted(region_secs):
        sec = region_secs[name]

        def compile_key(key: str, default: Optional[str]) -> Optional[expr.Program]:
            raw = sec.get(key, default)
            if raw is None:
                return None
            if isinstance(raw, (list, tuple)):
                # Spec stores multi-token par values as token lists; join
                # with spaces (mirrors get_expr_str in univ_hydro.h).
                raw = " ".join(str(tok) for tok in raw)
            elif not isinstance(raw, str):
                raw = str(raw)
            try:
                return expr.compile(raw)
            except expr.ExprError as e:
                issues.append(
                    Issue(level="error", where=f"{region_src[name]}.{key}",
                          message=str(e)))
                return None

        mask = compile_key("mask", "1")
        region = ICRegion(name=name, mask=mask or [(expr.PUSH_C, 1.0)])
        for key in sec:
            if key == "mask":
                continue
            if key in _BASE_CHANNELS or key in _B_CHANNELS:
                prog = compile_key(key, None)
                if prog is not None:
                    region.channels[key] = prog
            elif key.startswith("x."):
                prog = compile_key(key, None)
                if prog is not None:
                    region.channels[key] = prog
            elif key.endswith("_cgs"):
                base_ch = key[:-4]
                if (base_ch not in _BASE_CHANNELS
                        and base_ch not in _B_CHANNELS):
                    continue  # unknown channel: kratos ignores it
                if base_ch in sec:
                    issues.append(Issue(
                        level="error",
                        where=f"{region_src[name]}.{base_ch}",
                        message=f"univ: [{region_src[name]}] "
                                f"'{base_ch}' and '{key}' are "
                                "mutually exclusive"))
                    continue
                if scales is None:
                    issues.append(Issue(
                        level="error", where=f"{region_src[name]}.{key}",
                        message="univ: _cgs keys require a "
                                "[unit] section"))
                    continue
                prog = compile_key(key, None)
                if prog is not None:
                    # _cgs program evaluates in CGS; scale to code
                    # units (C++ evaluates+scales at float2_t and
                    # casts once; python floats are float64).
                    region.channels[base_ch] = prog
                    kind = ("rho" if base_ch == "rho"
                            else "pre" if base_ch == "pre"
                            else "vel" if base_ch.startswith("vel")
                            else "b")
                    region.cgs[base_ch] = 1.0 / scales[kind]
        regions.append(region)

    # channels appearing in any region get a base entry (0) so layering works
    for r in regions:
        for ch in r.channels:
            base.setdefault(ch, 0.0)
    return base, regions, issues


def _channel_names(spec: Spec, base: Dict[str, float],
                   regions: Sequence[ICRegion]) -> List[str]:
    names = list(_BASE_CHANNELS)
    have = set(base)
    for r in regions:
        have |= set(r.channels)
    names += [b for b in _B_CHANNELS if b in have]
    names += sorted(c for c in have if c.startswith("x."))
    return names


def eval_ic_slice(
    spec: Spec,
    axis: int = 2,
    index: Optional[int] = None,
    max_dim: int = 384,
) -> dict:
    """Evaluate the IC stack on a 2D cell-center slice of the base mesh.

    Returns a JSON-able dict: {axis, index, coord, u, v, fields, issues}.
    fields[name] = {data: [[...]] rows over v, cols over u (null for
    non-finite), min, max}. u/v = the two non-slice axes (in order).
    """
    issues: List[Issue] = []
    if axis not in (0, 1, 2):
        return {"issues": [Issue(level="error", where="axis",
                                 message="axis must be 0, 1 or 2").__dict__]}
    max_dim = max(1, min(int(max_dim), _MAX_DIM_HARD))

    x_min, x_max, n_cell, m_issues = _mesh_grid(spec)
    issues += m_issues
    base, regions, ic_issues = build_ic(spec)
    issues += ic_issues
    if any(i.level == "error" for i in m_issues):
        return {"issues": [i.__dict__ for i in issues]}

    index = (n_cell[axis] // 2) if index is None else int(index)
    index = max(0, min(index, n_cell[axis] - 1))

    axes_uv = [a for a in (0, 1, 2) if a != axis]
    strides = {a: max(1, math.ceil(n_cell[a] / max_dim)) for a in (0, 1, 2)}
    iu_list = list(range(0, n_cell[axes_uv[0]], strides[axes_uv[0]]))
    iv_list = list(range(0, n_cell[axes_uv[1]], strides[axes_uv[1]]))

    def center(a: int, i: int) -> float:
        dx = (x_max[a] - x_min[a]) / n_cell[a]
        return x_min[a] + (i + 0.5) * dx

    cu = [center(axes_uv[0], i) for i in iu_list]
    cv = [center(axes_uv[1], i) for i in iv_list]
    coord = center(axis, index)

    # [cycle] t_0 is exposed as expression variable `t` (mirrors the
    # universal pgen's ic.t0).
    cyc = spec.sections.get("cycle", {})
    try:
        t0 = float(cyc.get("t_0", 0.0))
    except (TypeError, ValueError):
        t0 = 0.0

    mods = _modules(spec)
    _ic_role = next((r for r, t in mods if t in IC_TYPES), "")
    _chem_role = next((r for r, t in mods if t in CHEM_TYPES), "")
    _init, _sp_init, chem, _regions, _rsrc = _scoped_merger(
        spec, _ic_role, _chem_role)
    species = _species_list(spec, chem)
    names = _channel_names(spec, base, regions)

    def state_at(xyz: List[float], ijk: List[int]) -> Dict[str, float]:
        st = dict(base)
        vars7 = [xyz[0], xyz[1], xyz[2], t0,
                 float(ijk[0]), float(ijk[1]), float(ijk[2])]
        for r in regions:
            if expr.evaluate(r.mask, vars7) != 0.0:
                for ch, prog in r.channels.items():
                    st[ch] = (expr.evaluate(prog, vars7)
                              * r.cgs.get(ch, 1.0))
        if species:
            norm = sum(st.get(f"x.{s}", 0.0) for s in species)
            for s in species:
                st[f"x.{s}"] = (st.get(f"x.{s}", 0.0) / norm) if norm > 0 else 0.0
        return st

    fields: Dict[str, dict] = {}
    grids: Dict[str, List[List[Optional[float]]]] = {n: [] for n in names}
    for j_iv, yv in zip(iv_list, cv):
        rows: Dict[str, List[Optional[float]]] = {n: [] for n in names}
        for i_iu, xu in zip(iu_list, cu):
            xyz = [0.0, 0.0, 0.0]
            xyz[axis] = coord
            xyz[axes_uv[0]] = xu
            xyz[axes_uv[1]] = yv
            ijk = [0, 0, 0]
            ijk[axis] = index
            ijk[axes_uv[0]] = i_iu
            ijk[axes_uv[1]] = j_iv
            st = state_at(xyz, ijk)
            for n in names:
                val = st.get(n, 0.0)
                rows[n].append(val if math.isfinite(val) else None)
        for n in names:
            grids[n].append(rows[n])

    for n in names:
        finite = [x for row in grids[n] for x in row if x is not None]
        fields[n] = {
            "data": grids[n],
            "min": min(finite) if finite else None,
            "max": max(finite) if finite else None,
        }

    axname = "xyz"
    return {
        "axis": axis,
        "index": index,
        "coord": coord,
        "u": {"axis": axes_uv[0], "name": axname[axes_uv[0]],
              "min": x_min[axes_uv[0]], "max": x_max[axes_uv[0]], "n": len(cu)},
        "v": {"axis": axes_uv[1], "name": axname[axes_uv[1]],
              "min": x_min[axes_uv[1]], "max": x_max[axes_uv[1]], "n": len(cv)},
        "fields": fields,
        "issues": [i.__dict__ for i in issues],
    }
