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
