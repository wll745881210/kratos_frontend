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
- cgs: ``_cgs``-suffixed keys (univ_unit.h) require a [unit] section,
  are mutually exclusive with their bare counterpart, and convert to
  code-unit values checked against the float32 dynamic-range edge
  (warning when within 3 orders of magnitude of it).
"""

from __future__ import annotations

import math

from .spec import Issue, Spec

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
        elif _near_f32_edge(v):
            issues.append(Issue(
                "warning", f"unit.{key}",
                f"derived unit {key}={v:.3e} is within 3 orders "
                f"of magnitude of the float32 dynamic-range edge "
                f"(~{F32_MAX:.0e} / {F32_MIN_NORMAL:.0e}); kratos "
                f"stores units in float32 -- rescale [unit] to "
                f"keep results well inside the range"))
    return issues


# ---------------------------------------------------------------------------
# CGS suffix keys (_cgs): mirror the universal-pgen conversions
# (usr_ext/universal/univ_unit.h).  Checks: _cgs requires [unit];
# bare + _cgs same channel are mutually exclusive; [init] T0 vs
# pre0/pre0_cgs conflict; code-unit values near the float32 edge.
# ---------------------------------------------------------------------------

F32_EDGE_HI = 1e35   # 3 orders below F32_MAX
F32_EDGE_LO = 1e-35  # 3 orders above F32_MIN_NORMAL


def _near_f32_edge(v: float) -> bool:
    return abs(v) > F32_EDGE_HI or 0 < abs(v) < F32_EDGE_LO


def cgs_scales(spec) -> dict | None:
    """Per-kind code-unit divisors, mirroring univ_unit.h div().

    Returns {"rho": rho0, "pre": ene0, "vel": vel0,
             "b": sqrt(4*pi*ene0), "edot": l0**2/t0**3} or None
    [unit] is absent/incomplete.  ene0 = rho0*(l0/t0)^2.
    The unit section is normally global; a role-scoped [R.unit]
    override (C++ scoped_input delivers it to module R) is honored
    when no global [unit] exists.
    """
    nums = _unit_numbers(spec)
    if nums is None:
        sections = getattr(spec, "sections", {})
        if isinstance(sections, dict):
            declared = _declared_modules(sections)
            for name in sorted(sections):
                if name.endswith(".unit"):
                    prefix = name[:-5]
                    if prefix in declared:
                        sub = dict(sections[name])
                        sub.setdefault("length", 1.0)
                        sub.setdefault("time", 1.0)
                        holder = Spec.__new__(Spec)
                        holder.sections = {"unit": sub}
                        nums = _unit_numbers(holder)
                        break
    if nums is None:
        return None
    l0, t0, rho0 = nums
    if l0 == 0 or t0 == 0:
        return None
    ene0 = rho0 * (l0 / t0) ** 2
    return {"rho": rho0, "pre": ene0, "vel": l0 / t0,
            "b": math.sqrt(4 * math.pi * ene0),
            "edot": l0**2 / t0**3}


def _num_or_none(v):
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _spec_sections(spec) -> dict:
    sections = getattr(spec, "sections", {})
    return sections if isinstance(sections, dict) else {}


def _cgs_kind_of(channel: str) -> str | None:
    if channel in ("rho", "rho0"):
        return "rho"
    if channel in ("pre", "pre0"):
        return "pre"
    if channel.startswith("vel"):
        return "vel"
    if channel.startswith("b_") or channel == "b0":
        return "b"
    if channel == "edot":
        return "edot"
    return None


def _check_cgs(spec) -> list[Issue]:
    issues: list[Issue] = []
    sections = _spec_sections(spec)
    scales = cgs_scales(spec)
    declared = _declared_modules(sections)

    # (native-name prefix or exact, channel list)
    # init channels: rho0/pre0/vel0/b0 (+ chem T0); ic regions and
    # expr_inflow: rho/pre/vel_x../b_x..; post.turb: edot.
    def native_of(name: str) -> str | None:
        """Native section name for the cgs scan.

        [R.X] with R a declared module role -> X (the role override);
        [X] or a global multi-dot section such as [ic.left] /
        [post.turb] / [bc.expr_inflow] -> the name itself (consumed
        by the un-roled module; C++ scoped_input delivers globals to
        every module).  [coupling.*]/[module.*] are container syntax.
        """
        if "." not in name:
            return name
        prefix, rest = name.split(".", 1)
        if prefix in _CONTAINER_SECTIONS:
            return None
        if prefix in declared:
            return rest
        return name

    def scan(secname: str, native: str):
        if native == "init":
            chans = ["rho0", "pre0", "vel0", "b0"]
            where = f"{secname}"
        elif native.startswith("ic.") or native == "bc.expr_inflow":
            chans = ["rho", "pre",
                     "vel_x", "vel_y", "vel_z",
                     "b_x", "b_y", "b_z"]
            where = f"{secname}"
        elif native == "post.turb":
            chans = ["edot"]
            where = f"{secname}"
        else:
            return
        sec = sections.get(secname, {})
        if not isinstance(sec, dict):
            return
        cgs_keys = [k for k in sec if k.endswith("_cgs")]
        if not cgs_keys:
            return
        if scales is None:
            issues.append(Issue(
                "error", where,
                f"univ: _cgs keys require a [unit] section "
                f"(found {', '.join(sorted(cgs_keys))} in "
                f"[{secname}])"))
        else:
            # identity unit: every _cgs divisor is 1 (b divides by
            # sqrt(4*pi)) -> the "CGS" values land in code units
            # unchanged.  Almost always a forgotten [unit].
            l0, t0, rho0 = _unit_numbers(spec) or (None, None, None)
            if l0 == 1 and t0 == 1 and rho0 == 1:
                issues.append(Issue(
                    "warning", where,
                    f"[{secname}] uses _cgs keys while [unit] is the "
                    f"identity (length=time=density=1): values are "
                    f"divided by 1 -- set real units in [unit]"))
        for k in cgs_keys:
            base = k[:-4]
            if base in sec:
                issues.append(Issue(
                    "error", where,
                    f"univ: [{secname}] '{base}' and '{k}' are "
                    f"mutually exclusive"))
            elif base not in chans and not base.startswith("x."):
                issues.append(Issue(
                    "warning", where,
                    f"univ: [{secname}] '{k}' is not a known channel "
                    f"(kratos ignores it)"))
        # code-unit value sanity for numeric values
        if scales is not None:
            for k in cgs_keys:
                base = k[:-4]
                kind = _cgs_kind_of(base)
                if kind is None:
                    continue
                div = scales.get(kind)
                if not div:
                    continue
                v = _num_or_none(sec.get(k))
                if v is None:
                    continue
                code = v / div
                if abs(code) > F32_MAX:
                    issues.append(Issue(
                        "error", where,
                        f"[{secname}] {k}={v:.3e} converts to "
                        f"{code:.3e} code units and overflows float32 "
                        f"-- rescale [unit]"))
                elif _near_f32_edge(code):
                    issues.append(Issue(
                        "warning", where,
                        f"[{secname}] {k}={v:.3e} converts to "
                        f"{code:.3e} code units, within 3 orders of "
                        f"magnitude of the float32 dynamic-range edge "
                        f"(kratos computes in float32)"))
        return

    for name in sorted(sections):
        native = native_of(name)
        if native is None:
            continue
        scan(name, native)

    # chem pressure specification: T0 vs pre0/pre0_cgs (chem family)
    for name in sorted(sections):
        native = native_of(name)
        if native != "init":
            continue
        sec = sections.get(name, {})
        if not isinstance(sec, dict):
            continue
        if "T0" in sec and ("pre0" in sec or "pre0_cgs" in sec):
            issues.append(Issue(
                "error", name,
                f"univ: [{name}] 'T0' and 'pre0'/'pre0_cgs' are "
                f"mutually exclusive (pick one pressure "
                f"specification)"))
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
            + _check_refine(spec) + _check_roles(spec)
            + _check_post(spec) + _check_cgs(spec)
            + _check_chem_chain(spec) + _check_chem_modules(spec))


# ---------------------------------------------------------------------------
# Container syntax: [module.<role>] / [coupling.<role>] / [R.<section>].
# Mirrors registry.h (reserved roles, type/order-only, error text) and
# univ_mesh.h (role prefix stripping).  Kept in sync with bindings.
# ---------------------------------------------------------------------------

_CONTAINER_SECTIONS = {"module", "coupling"}


def _module_secs() -> dict[str, list[str]]:
    """module type -> native section patterns (bindings._MODULE_TYPES)."""
    from .bindings import _MODULE_TYPES
    return {m["type"]: list(m["sections"]) for m in _MODULE_TYPES}


def _coupling_slots() -> dict[str, dict]:
    """module type -> valid coupling slots (bindings._COUPLINGS)."""
    from .bindings import _COUPLINGS
    return _COUPLINGS


def _slot_targets() -> dict[str, dict[str, list[str]]]:
    """(declarer type, slot) -> allowed target types (bindings)."""
    from .bindings import _SLOT_TARGETS
    return _SLOT_TARGETS


def _reserved_roles() -> list[str]:
    from .bindings import _RESERVED_ROLES
    return _RESERVED_ROLES


def _sec_matches(native: str, pattern: str) -> bool:
    if pattern.endswith(".*"):
        return native.startswith(pattern[:-2])
    return native == pattern


def _check_roles(spec) -> list[Issue]:
    issues: list[Issue] = []
    sections = getattr(spec, "sections", {})
    if not isinstance(sections, dict):
        return issues
    secs = _module_secs()
    couplings = _coupling_slots()
    reserved = set(_reserved_roles())

    # declared roles: [module] (role '') + [module.<role>]
    declared: dict[str, str] = {}
    for name in sections:
        if name == "module":
            declared[""] = str(sections[name].get("type", ""))
        elif name.startswith("module."):
            declared[name[7:]] = str(sections[name].get("type", ""))

    for role, t in sorted(declared.items()):
        if role in reserved:
            issues.append(Issue(
                "error", f"module.{role}" if role else "module",
                f"role '{role}' collides with a native section name; "
                "pick another role (kratos throws at startup)"))
        if "." in role:
            issues.append(Issue(
                "error", f"module.{role}",
                f"role '{role}' must not contain '.'"))
        if t and t not in secs:
            issues.append(Issue(
                "error", f"module.{role}" if role else "module",
                f"unknown module type '{t}' (available: "
                + ", ".join(sorted(secs)) + ")"))

    # [module.<role>] accepts ONLY type/order (registry.h hard error)
    for name in sections:
        if name == "module" or name.startswith("module."):
            for key in sections[name]:
                if key not in ("type", "order"):
                    issues.append(Issue(
                        "error", name,
                        f"key '{key}' is not accepted here; "
                        "[module.<role>] takes only 'type' and 'order'. "
                        "Put module parameters in section "
                        f"[{name[7:]}.<section>]"))

    # role-scoped sections: [R.<native>] with R declared
    for name in sorted(sections):
        if "." not in name:
            continue
        if name.split(".", 1)[0] in _CONTAINER_SECTIONS:
            continue
        prefix, native = name.split(".", 1)
        if prefix not in declared:
            continue
        t = declared[prefix]
        patterns = secs.get(t, [])
        if patterns and not any(_sec_matches(native, p)
                                for p in patterns):
            issues.append(Issue(
                "warning", name,
                f"section '{native}' is not consumed by module type "
                f"'{t}' (reads: {', '.join(patterns)})"))

    # coupling sections: role must be declared, keys must be valid
    # slots for that role's type, values must reference declared roles
    # whose type satisfies the slot's target constraint (C++ mirrors)
    slot_targets = _slot_targets()
    for name in sorted(sections):
        if name == "coupling" or not name.startswith("coupling."):
            continue
        role = name[9:]
        if role not in declared:
            issues.append(Issue(
                "warning", name,
                f"coupling section for undeclared role '{role}'"))
            continue
        t = declared[role]
        slots = couplings.get(t, {})
        for key, val in sections[name].items():
            if key not in slots:
                issues.append(Issue(
                    "warning", name,
                    f"module type '{t}' has no coupling slot '{key}' "
                    + (f"(slots: {', '.join(slots)})"
                       if slots else "(it declares no couplings)")))
            targets = (val if isinstance(val, list)
                       else [val] if isinstance(val, str) else [])
            for tgt in targets:
                if not isinstance(tgt, str):
                    continue
                if tgt not in declared:
                    issues.append(Issue(
                        "warning", name,
                        f"coupling target '{tgt}' is not a declared role"))
                    continue
                tt = declared[tgt]
                allowed = slot_targets.get(t, {}).get(key)
                if allowed is None or tt == "":
                    continue
                if tt not in allowed:
                    if key == "parasite" and t == "chemistry":
                        # registry.h hard error (exact C++ text)
                        issues.append(Issue(
                            "error", name,
                            f"univ: [coupling.{role}] parasite target "
                            f"'{tgt}' (type {tt}) has no multi-species "
                            "handling -- chemistry must parasite onto "
                            "chem_hydro or chem_mhd"))
                    elif t == "post":
                        # post_t::init hard error (exact C++ text)
                        issues.append(Issue(
                            "error", name,
                            f"univ::post_t: coupling slot 'dyn' missing or "
                            f"not a dynamics module (target '{tgt}' is "
                            f"type {tt})"))
                    else:
                        issues.append(Issue(
                            "error", name,
                            f"coupling slot '{key}' of module type "
                            f"'{t}' does not accept target type "
                            f"'{tt}' (allowed: {', '.join(allowed)})"))

    return issues


# ---------------------------------------------------------------------------
# post module contract: runs AFTER its dyn target (registry.h hard
# error), and turbulence driving needs a nonzero initial velocity
# (the edot quadratic solve is singular at rest).
# ---------------------------------------------------------------------------

def _declared_modules(sections) -> dict[str, str]:
    declared: dict[str, str] = {}
    for name in sections:
        if name == "module":
            declared[""] = str(sections[name].get("type", ""))
        elif name.startswith("module."):
            declared[name[7:]] = str(sections[name].get("type", ""))
    return declared


def _module_orders(sections, declared: dict[str, str]) -> dict[str, int]:
    """Explicit order, else lexicographic rank (registry.h default)."""
    explicit = {
        r: sections["module" if r == "" else f"module.{r}"].get("order")
        for r in declared}
    order: dict[str, int] = {}
    rank = 0
    for role in sorted(declared):
        o = explicit[role]
        if o is None:
            o = rank
        order[role] = int(o)
        rank += 1
    return order


def _turb_enabled(sections, role: str) -> bool:
    """[R.post.turb] enabled for this role, or global [post.turb]."""
    for name in (f"{role}.post.turb" if role else "post.turb",
                 "post.turb"):
        sec = sections.get(name)
        if isinstance(sec, dict):
            v = sec.get("enabled", 0)
            if str(v) not in ("0", "", "false", "False", "None"):
                return True
    return False


def _has_initial_velocity(sections, declared: dict[str, str]) -> bool:
    """Any vel channel: [init]/[R.init] vel0 != 0, or an [ic*]/[R.ic*]
    vel_x/vel_y/vel_z expression key."""
    for name in sections:
        prefix = name.split(".", 1)[0] if "." in name else ""
        if prefix in ("module", "coupling"):
            continue
        native = name[len(prefix) + 1:] if prefix in declared else name
        if native == "init" or native.startswith("init."):
            vel0 = sections[name].get("vel0")
            if isinstance(vel0, list) and any(
                    _num(v) and float(v) != 0 for v in vel0):
                return True
        if native == "ic" or native.startswith("ic."):
            for key in sections[name]:
                if key.split(".")[0] in ("vel_x", "vel_y", "vel_z"):
                    return True
    return False


def _num(v):
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def _check_post(spec) -> list[Issue]:
    issues: list[Issue] = []
    sections = getattr(spec, "sections", {})
    if not isinstance(sections, dict):
        return issues
    declared = _declared_modules(sections)
    posts = {r: t for r, t in declared.items() if t == "post"}
    if not posts:
        return issues
    order = _module_orders(sections, declared)

    # post must run AFTER its coupling targets (registry.h throws)
    for name in sorted(sections):
        if name == "coupling" or not name.startswith("coupling."):
            continue
        role = name[9:]
        if role not in posts:
            continue
        for key, val in sections[name].items():
            targets = (val if isinstance(val, list)
                       else [val] if isinstance(val, str) else [])
            for tgt in targets:
                if (isinstance(tgt, str) and tgt in order
                        and order[role] <= order[tgt]):
                    issues.append(Issue(
                        "error", name,
                        f"module '{role}' (type post) must run AFTER "
                        f"its coupling target '{tgt}' -- give it a "
                        "larger 'order' (kratos throws at startup)"))

    # turbulence needs a nonzero initial velocity
    if any(_turb_enabled(sections, r) for r in posts):
        if not _has_initial_velocity(sections, declared):
            issues.append(Issue(
                "warning", "post.turb",
                "turbulence driving is singular at rest: seed an "
                "initial velocity perturbation, e.g. an [ic.*] region "
                "vel_x = 0.01*(2*rand(i,j,k,42)-1), or [init] "
                "vel0 != 0"))
    return issues


def _check_chem_chain(spec) -> list[Issue]:
    """Chemistry reads the shared field state at its own order: warn
    when it runs before another module of its host's family (post etc.)
    -- it would read that module's PRE-processed data."""
    issues: list[Issue] = []
    sections = getattr(spec, "sections", {})
    if not isinstance(sections, dict):
        return issues
    declared = _declared_modules(sections)
    chems = {r for r, t in declared.items() if t == "chemistry"}
    if not chems:
        return issues
    order = _module_orders(sections, declared)

    def _targets_of(val) -> list:
        out: list[str] = []
        for v in (val if isinstance(val, list) else [val]):
            out.extend(str(v).split())
        return out

    for name in sorted(sections):
        if name == "coupling" or not name.startswith("coupling."):
            continue
        role = name[9:]
        if role not in chems:
            continue
        host = str(sections[name].get("parasite", "")).strip()
        if not host or host not in order:
            continue  # undeclared target: warned elsewhere
        # family: the host itself + other modules coupled to it
        family = [host]
        for other in sorted(sections):
            if other == "coupling" or not other.startswith("coupling."):
                continue
            ofrom = other[9:]
            if ofrom == role or ofrom not in order:
                continue
            if any(host in _targets_of(v) for v in sections[other].values()):
                family.append(ofrom)
        for m in family:
            if order[m] >= order[role]:
                issues.append(Issue(
                    "warning", f"module.{role}",
                    f"module '{role}' (chemistry) runs at order "
                    f"{order[role]}, before '{m}' (order {order[m]}) "
                    f"which processes the same fields via host "
                    f"'{host}' -- chemistry would read pre-'{m}' data; "
                    f"give '{role}' a larger 'order'"))
    return issues


# ---------------------------------------------------------------------------
# Chemistry module contract (mirrors trunk hard errors, verified on the
# ttt.par marginal case):
#   - chem_hydro/chem_mhd need a chemistry parasite -- they take their
#     species list and EOS from it (chem_hydro::read throws
#     'q_che unbound: hydro' otherwise)
#   - chemistry needs >= 1 species -- the corrector's stoichiometry
#     matrix is built from the species list and its SVD throws
#     'svd.h' on an empty one (svd.cpp:29, m == 0)
# ---------------------------------------------------------------------------

def _species_count(sections, role: str) -> int:
    """[R.chemistry] species (scoped), else the global [chemistry]."""
    names = [f"{role}.chemistry"] if role else []
    names.append("chemistry")
    for name in names:
        sec = sections.get(name)
        if not isinstance(sec, dict) or "species" not in sec:
            continue
        v = sec["species"]
        if isinstance(v, list):
            return len([s for s in v if str(s).strip()])
        if isinstance(v, str):
            return len(v.split())
        return 0 if v is None else 1
    return 0


def _parasite_targets(sections, declared: dict) -> set:
    """Roles that have a chemistry module attached via
    [coupling.<chem>] parasite = <host>."""
    hosts: set = set()
    for name in sections:
        if name == "coupling" or not name.startswith("coupling."):
            continue
        if declared.get(name[9:]) != "chemistry":
            continue
        val = sections[name].get("parasite")
        for tgt in (val if isinstance(val, list) else [val]):
            if isinstance(tgt, str):
                hosts.update(tgt.split())
    return hosts


def _check_chem_modules(spec) -> list[Issue]:
    issues: list[Issue] = []
    sections = getattr(spec, "sections", {})
    if not isinstance(sections, dict):
        return issues
    declared = _declared_modules(sections)
    parasited = _parasite_targets(sections, declared)

    for role, t in sorted(declared.items()):
        if t in ("chem_hydro", "chem_mhd") and role not in parasited:
            issues.append(Issue(
                "error", f"module.{role}" if role else "module",
                f"module '{role}' (type {t}) has no chemistry "
                "parasite: chem_hydro/chem_mhd take their species "
                "list and EOS from a chemistry module -- declare one "
                "(e.g. [module.chem] type = chemistry) and couple it "
                f"(e.g. [coupling.chem] parasite = {role}); kratos "
                "throws 'q_che unbound: hydro' at startup otherwise"))

    for role, t in sorted(declared.items()):
        if t != "chemistry":
            continue
        if _species_count(sections, role) == 0:
            where = f"{role}.chemistry" if role else "chemistry"
            issues.append(Issue(
                "error", where,
                f"chemistry module '{role}' has no species: "
                f"[{where}] species = H2 H ... needs at least one "
                "entry -- the stoichiometry matrix is built from "
                "the species list and its SVD throws 'svd.h' on an "
                "empty one"))
    return issues
