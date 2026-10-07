"""Cross-field validation tests (mesh divisibility, unit overflow)."""
import pytest

from kratos_spec.spec import Spec
from kratos_spec.xchecks import unit_summary


def mk(sections):
    return Spec(sections=sections)


class TestMeshChecks:
    def test_divisible_ok(self):
        s = mk({"mesh": {"x_min": [0, 0, 0], "x_max": [1, 1, 1],
                         "n_cell_global": [512, 2, 1],
                         "n_cell_block": [32, 2, 1]}})
        errs = [i for i in s.validate() if i.level == "error"]
        assert errs == []

    def test_default_block_is_global(self):
        # no n_cell_block -> single block per axis, always divisible
        s = mk({"mesh": {"n_cell_global": [511, 2, 1]}})
        errs = [i for i in s.validate() if "indivisible" in i.message]
        assert errs == []

    def test_indivisible_flagged(self):
        s = mk({"mesh": {"n_cell_global": [510, 2, 1],
                         "n_cell_block": [32, 2, 1]}})
        errs = [i for i in s.validate() if "indivisible" in i.message]
        assert len(errs) == 1
        assert "510" in errs[0].message and "32" in errs[0].message

    def test_degenerate_axes_skipped(self):
        # axis 1,2 have n==1 -> n_dim=1 -> only axis 0 checked
        s = mk({"mesh": {"n_cell_global": [512, 1, 1],
                         "n_cell_block": [64, 7, 9]}})
        errs = [i for i in s.validate() if "indivisible" in i.message]
        assert errs == []

    def test_zero_size_flagged(self):
        s = mk({"mesh": {"n_cell_global": [0, 2, 1]}})
        errs = [i for i in s.validate() if "Zero mesh size" in i.message
                or "zero mesh size" in i.message]
        assert errs


class TestUnitChecks:
    def test_kpc_mp_overflow(self):
        # m0 = mp * kpc^3 ~ 4.9e40 > FLT_MAX -> error (verified trunk)
        s = mk({"unit": {"length": 3.085677581e21, "time": 3.15576e13,
                         "density": "mp"}})
        errs = [i for i in s.validate()
                if i.level == "error" and "overflow" in i.message]
        assert errs and "m0" in errs[0].where

    def test_pc_mp_ok(self):
        s = mk({"unit": {"length": 3.085677581e18, "time": 3.15576e13,
                         "density": "mp"}})
        errs = [i for i in s.validate()
                if i.level == "error" and "unit" in i.where]
        assert errs == []

    def test_mass_form(self):
        s = mk({"unit": {"length": 1.0, "time": 1.0, "mass": 1.0}})
        assert unit_summary(s) is not None
        errs = [i for i in s.validate() if i.level == "error"]
        assert errs == []

    def test_summary_values(self):
        s = mk({"unit": {"length": 2.0, "time": 4.0, "density": 8.0}})
        u = unit_summary(s)
        assert u["m0"] == pytest.approx(64.0)      # 8 * 2^3
        assert u["vel0"] == pytest.approx(0.5)     # 2/4
        assert u["ene0"] == pytest.approx(2.0)     # 8 * 0.25

    def test_no_unit_section(self):
        s = mk({"mesh": {"n_cell_global": [64, 64, 1]}})
        assert unit_summary(s) is None


def test_core_section_unknown_key_is_error():
    # regulations §2.4.1: typo-catch for the four core sections
    s = Spec(sections={"mesh": {"n_cell_global": [64, 64, 1],
                                "x_min": [0, 0, 0], "x_max": [1, 1, 1],
                                "n_cell_globa": [64, 64, 1]}})
    issues = s.validate()
    hits = [i for i in issues if i.where == "mesh.n_cell_globa"]
    assert hits and all(i.level == "error" for i in hits)


def test_module_section_unknown_key_stays_warning():
    s = Spec(sections={"dynamics": {"gamma": 1.4, "gam": 1.3}})
    hits = [i for i in s.validate() if i.where == "dynamics.gam"]
    assert hits and all(i.level == "warning" for i in hits)


def test_deprecated_key_warns(tmp_path):
    import yaml
    from kratos_spec.descriptors import load_registry
    d = tmp_path / "dep.yaml"
    d.write_text(yaml.safe_dump({
        "section": "oldthing",
        "keys": {"legacy": {"type": "int", "deprecated": True}}}))
    reg = load_registry(str(tmp_path))
    s = Spec(sections={"oldthing": {"legacy": 3}})
    hits = [i for i in s.validate(reg) if i.where == "oldthing.legacy"]
    assert hits and hits[0].level == "warning" and "deprecated" in hits[0].message


def test_refine_region_out_of_domain_is_error():
    s = Spec(sections={
        "mesh": {"n_cell_global": [64, 64, 1], "x_min": [0, 0, 0],
                 "x_max": [1, 1, 1]},
        "refine_region_00": {"level": 1, "x_min": [0.2, -0.5, 0],
                             "x_max": [0.4, 0.5, 1]}})
    hits = [i for i in s.validate()
            if i.where == "refine_region_00.x_min"]
    assert hits and hits[0].level == "error"
    assert "Incorrect SMR region" in hits[0].message


def test_refine_region_level_zero_warns():
    s = Spec(sections={
        "mesh": {"n_cell_global": [64, 64, 1], "x_min": [0, 0, 0],
                 "x_max": [1, 1, 1]},
        "refine_region_00": {"level": 0, "x_min": [0.2, 0.2, 0],
                             "x_max": [0.4, 0.5, 1]}})
    hits = [i for i in s.validate()
            if i.where == "refine_region_00.level"]
    assert hits and hits[0].level == "warning"


def test_refine_region_inside_domain_clean():
    s = Spec(sections={
        "mesh": {"n_cell_global": [64, 64, 1], "x_min": [0, 0, 0],
                 "x_max": [1, 1, 1]},
        "refine_region_00": {"level": 1, "x_min": [0.2, 0.2, 0],
                             "x_max": [0.4, 0.5, 1]}})
    assert not [i for i in s.validate()
                if i.where.startswith("refine_region_00")]


# ---------------------------------------------------------------------------
# _check_roles: container syntax validation (registry.h / univ_mesh.h)
# ---------------------------------------------------------------------------

def _spec_with(sections):
    from kratos_spec.spec import Spec
    return Spec(version=1, meta={}, sections=sections)


def _msgs(spec):
    from kratos_spec.xchecks import cross_validate
    return [(i.level, i.where, i.message) for i in cross_validate(spec)]


def test_role_reserved_name_error():
    msgs = _msgs(_spec_with({
        "module.post": {"type": "post"},
        "post.turb": {"enabled": 1},
    }))
    assert any(l == "error" and "collides with a native section" in m
               for l, w, m in msgs)


def test_module_section_type_order_only():
    msgs = _msgs(_spec_with({
        "module.flow": {"type": "hydro", "dynamics.gamma": 1.4},
    }))
    assert any(l == "error" and "takes only 'type' and 'order'" in m
               for l, w, m in msgs)


def test_unknown_module_type_error():
    msgs = _msgs(_spec_with({"module.x": {"type": "flux tubes"}}))
    assert any(l == "error" and "unknown module type" in m
               for l, w, m in msgs)


def test_role_section_not_consumed_warning():
    msgs = _msgs(_spec_with({
        "module.flow": {"type": "hydro"},
        "flow.multigrid": {"n_iter": 2},
    }))
    assert any(l == "warning" and "not consumed by module type" in m
               for l, w, m in msgs)


def test_role_section_consumed_clean():
    msgs = _msgs(_spec_with({
        "module.flow": {"type": "hydro"},
        "flow.dynamics": {"gamma": 1.4},
        "flow.ic.left": {"mask": "1", "rho": 1},
    }))
    assert not any("not consumed" in m for l, w, m in msgs)


def test_coupling_unknown_slot_warning():
    msgs = _msgs(_spec_with({
        "module.flow": {"type": "hydro"},
        "module.sg": {"type": "post"},
        "coupling.sg": {"bogus_slot": "flow"},
    }))
    assert any(l == "warning" and "no coupling slot" in m
               for l, w, m in msgs)


def test_coupling_undeclared_target_warning():
    msgs = _msgs(_spec_with({
        "module.flow": {"type": "hydro"},
        "module.sg": {"type": "post"},
        "coupling.sg": {"dyn": "ghost_role"},
    }))
    assert any(l == "warning" and "not a declared role" in m
               for l, w, m in msgs)


def test_coupling_valid_clean():
    msgs = _msgs(_spec_with({
        "module.flow": {"type": "hydro"},
        "module.sg": {"type": "post"},
        "coupling.sg": {"dyn": "flow"},
    }))
    assert msgs == []


def test_role_with_dot_error():
    msgs = _msgs(_spec_with({
        "module.a.b": {"type": "hydro"},
    }))
    assert any(l == "error" and "must not contain '.'" in m
               for l, w, m in msgs)
