"""Tests for the server-side IC preview evaluator (kratos_spec.ic_eval)."""

import os

import pytest
from fastapi.testclient import TestClient

from kratos_spec import ic_eval
from kratos_spec.parfile import parse_par
from kratos_spec.spec import Spec
from kratos_server.app import create_app

CORPUS = os.path.join(os.path.dirname(__file__), "corpus")


def _spec_from_text(text: str) -> Spec:
    return Spec.from_par(parse_par(text))


SOD_IC = """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 128 4 1

[init]
rho0 = 1
pre0 = 1
vel0 = 0

[ic.left]
mask = x < 0.5
rho = 1
pre = 1

[ic.right]
mask = x geq 0.5
rho = 0.125
pre = 0.1
"""


def test_sod_profile_axis_z():
    spec = _spec_from_text(SOD_IC)
    out = ic_eval.eval_ic_slice(spec, axis=2, max_dim=128)
    assert not [i for i in out["issues"] if i["level"] == "error"]
    assert out["u"]["name"] == "x" and out["u"]["n"] == 128
    rho = out["fields"]["rho"]
    row = rho["data"][0]
    assert all(v == 1.0 for v in row[:64])
    assert all(v == 0.125 for v in row[64:])
    assert rho["min"] == 0.125 and rho["max"] == 1.0
    assert out["fields"]["pre"]["data"][0][0] == 1.0
    assert out["fields"]["pre"]["data"][0][-1] == pytest.approx(0.1)


def test_layering_later_region_wins():
    spec = _spec_from_text(
        SOD_IC
        + """
[ic.midpatch]
mask = x geq 0.4 and x lt 0.6
rho = 5
"""
    )
    out = ic_eval.eval_ic_slice(spec, axis=2, max_dim=128)
    row = out["fields"]["rho"]["data"][0]
    # cell 52 (x=0.41): midpatch (applied after left) wins -> 5
    assert row[52] == 5
    # cell 68 (x=0.535): ic.right sorts AFTER ic.midpatch lexicographically
    # and also matches -> right overwrites rho back to 0.125
    assert row[68] == 0.125
    assert row[80] == 0.125
    # pre: midpatch doesn't set it; left owns x<0.5, right owns x>=0.5
    pre = out["fields"]["pre"]["data"][0]
    assert pre[52] == 1.0
    assert pre[68] == pytest.approx(0.1)


def test_scalar_vec_zero_fill():
    spec = _spec_from_text(
        """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 4 4 1
[init]
rho0 = 2
pre0 = 1
vel0 = 1
"""
    )
    out = ic_eval.eval_ic_slice(spec, axis=2)
    f = out["fields"]
    assert f["vel_x"]["data"][0][0] == 1.0
    assert f["vel_y"]["data"][0][0] == 0.0  # kratos get<f3> zero-fill
    assert f["vel_z"]["data"][0][0] == 0.0


def test_b_channels_present_only_with_b0():
    spec = _spec_from_text(
        """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 4 4 1
[init]
rho0 = 1
pre0 = 1
b0 = 1 1 0
[ic.half]
mask = x geq 0.5
b_y = -1
"""
    )
    out = ic_eval.eval_ic_slice(spec, axis=2)
    f = out["fields"]
    assert "b_x" in f and "b_y" in f
    assert f["b_y"]["data"][0][0] == 1.0   # base
    assert f["b_y"]["data"][0][-1] == -1.0  # region override


def test_species_channels_normalized():
    spec = _spec_from_text(
        """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 8 2 1
[chemistry]
species = H2 H
[species_init]
H2 = 0.5
H = 0.5
[ic.right]
mask = x geq 0.5
x.H2 = 0.1
x.H = 0.9
"""
    )
    out = ic_eval.eval_ic_slice(spec, axis=2)
    f = out["fields"]
    assert "x.H2" in f and "x.H" in f
    row = f["x.H2"]["data"][0]
    assert row[0] == pytest.approx(0.5)
    assert row[-1] == pytest.approx(0.1)
    # normalization: x.H2 + x.H == 1 everywhere
    rh = f["x.H"]["data"][0]
    assert all(a + b == pytest.approx(1.0) for a, b in zip(row, rh))


def test_expr_error_surfaces_as_issue():
    spec = _spec_from_text(
        """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 4 4 1
[ic.bad]
mask = 1
rho = nope(1)
"""
    )
    out = ic_eval.eval_ic_slice(spec, axis=2)
    errs = [i for i in out["issues"] if i["level"] == "error"]
    assert len(errs) == 1
    assert errs[0]["where"] == "ic.bad.rho"
    assert "unknown function" in errs[0]["message"]
    # other channels still evaluate
    assert "rho" in out["fields"]


def test_missing_mesh_is_error():
    spec = _spec_from_text("[init]\nrho0 = 1\n")
    out = ic_eval.eval_ic_slice(spec, axis=2)
    errs = [i for i in out["issues"] if i["level"] == "error"]
    assert errs and errs[0]["where"] == "mesh.n_cell_global"


def test_max_dim_downsamples():
    spec = _spec_from_text(SOD_IC)
    out = ic_eval.eval_ic_slice(spec, axis=2, max_dim=32)
    assert out["u"]["n"] == 32
    assert out["v"]["n"] == 4


def test_index_clamped():
    spec = _spec_from_text(SOD_IC)
    out = ic_eval.eval_ic_slice(spec, axis=2, index=999, max_dim=32)
    assert out["index"] == 0  # nz=1


def test_endpoint_preview_ic():
    app = create_app(allowed_roots=[os.path.abspath(CORPUS)])
    client = TestClient(app)
    spec = _spec_from_text(SOD_IC)
    r = client.post("/api/preview/ic",
                    json={"spec": spec.to_dict(), "axis": 2, "max_dim": 64})
    assert r.status_code == 200
    body = r.json()
    rho = body["fields"]["rho"]
    assert rho["min"] == 0.125 and rho["max"] == 1.0
    assert body["u"]["n"] == 64
    assert body["issues"] == []


def test_endpoint_bad_axis():
    app = create_app(allowed_roots=[os.path.abspath(CORPUS)])
    client = TestClient(app)
    spec = _spec_from_text(SOD_IC)
    r = client.post("/api/preview/ic",
                    json={"spec": spec.to_dict(), "axis": 5})
    assert r.status_code == 200
    assert r.json()["issues"][0]["level"] == "error"


def test_role_scoped_ic_overrides_global():
    """[flow.ic.*] overrides global [ic.*] per region; [flow.init]
    overrides global [init] per key; chem species from [chem.chemistry]."""
    spec = _spec_from_text("""
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 128 2 1
[init]
rho0 = 9
pre0 = 9
[module.flow]
type = hydro
order = 0
[module.chem]
type = chemistry
order = 1
[chem.chemistry]
species = H2 H
[flow.init]
rho0 = 1
pre0 = 1
[ic.left]
mask = x < 0.5
rho = 5
[flow.ic.left]
rho = 2
[flow.ic.right]
mask = x geq 0.5
rho = 0.125
""")
    out = ic_eval.eval_ic_slice(spec, axis=2, max_dim=128)
    assert out["issues"] == []
    row = out["fields"]["rho"]["data"][0]
    # left: global rho=5 overridden by [flow.ic.left] rho=2; pre from
    # global [ic.left] is unset -> base pre0=1 (flow.init overrides init)
    assert row[10] == 2
    assert out["fields"]["pre"]["data"][0][10] == 1
    assert row[100] == 0.125  # scoped-only region
    # species channels exist (H2/H from chem.chemistry)
    assert "x.H2" in out["fields"]


# ---------------------------------------------------------------------------
# CGS suffix keys (univ_unit.h conversion mirror, float64 scaling)
# ---------------------------------------------------------------------------

CGS_UNIT = """
[unit]
length = 1.0e18
time = 1.0e10
density = 1.0e-24
"""


def test_cgs_region_matches_bare():
    """_cgs region values convert to the same code-unit numbers as
    the equivalent bare keys (python float64 mirrors the C++
    evaluate-at-float2_t-and-cast-once path)."""
    base = CGS_UNIT + """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 128 2 1
[init]
rho0_cgs = 1.0e-24
pre0_cgs = 1.0e-8
[ic.right]
mask = x geq 0.5
rho_cgs = 0.125e-24
pre_cgs = 0.1e-8
"""
    out = ic_eval.eval_ic_slice(_spec_from_text(base), axis=2, max_dim=128)
    assert not [i for i in out["issues"] if i["level"] == "error"]
    rho = out["fields"]["rho"]["data"][0]
    pre = out["fields"]["pre"]["data"][0]
    assert all(v == 1.0 for v in rho[:64])
    assert all(v == pytest.approx(0.125e-24 / 1e-24, rel=1e-12)
               for v in rho[64:])
    assert all(v == pytest.approx(0.1e-8 / 1e-8, rel=1e-12)
               for v in pre[64:])


def test_cgs_init_uniform_conversion():
    text = CGS_UNIT + """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 16 2 1
[init]
rho0_cgs = 2.0e-24
pre0_cgs = 2.0e-8
vel0_cgs = 1.0e8
"""
    out = ic_eval.eval_ic_slice(_spec_from_text(text), axis=2, max_dim=64)
    assert out["issues"] == []
    rho = out["fields"]["rho"]["data"][0]
    pre = out["fields"]["pre"]["data"][0]
    vx = out["fields"]["vel_x"]["data"][0]
    assert all(v == 2.0 for v in rho)
    assert all(v == pytest.approx(2.0, rel=1e-12) for v in pre)
    assert all(v == 1.0 for v in vx)  # vel0_cgs scalar -> (v,0,0)


def test_cgs_missing_unit_is_error_issue():
    # Spec constructed directly (NOT via from_par, which now forces a
    # [unit] section): specs sent by the GUI go through from_dict, so
    # the missing-unit guard stays live on that path.
    spec = Spec(
        version=1, meta={},
        sections={"init": {"rho0_cgs": 1.0e-24}})
    out = ic_eval.eval_ic_slice(spec, axis=2, max_dim=64)
    errs = [i for i in out["issues"] if i["level"] == "error"]
    assert any("require a [unit] section" in i["message"] for i in errs)


def test_cgs_region_exclusive_is_error_issue():
    text = CGS_UNIT + """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 16 2 1
[ic.left]
mask = x lt 0.5
rho = 1
rho_cgs = 1.0e-24
"""
    out = ic_eval.eval_ic_slice(_spec_from_text(text), axis=2, max_dim=64)
    errs = [i for i in out["issues"] if i["level"] == "error"]
    assert any("'rho' and 'rho_cgs' are mutually exclusive"
               in i["message"] for i in errs)


def test_cgs_b0_converts():
    text = CGS_UNIT + """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 16 2 1
[init]
rho0_cgs = 1.0e-24
b0_cgs = 3.5449077018110314e-4
"""
    out = ic_eval.eval_ic_slice(_spec_from_text(text), axis=2, max_dim=64)
    assert out["issues"] == []
    bx = out["fields"]["b_x"]["data"][0]
    assert all(abs(v - 1.0) < 1e-12 for v in bx)


def test_chem_T0_pressure():
    """read_chem mirror: pre0 = kb*T*rho_cgs/mu_mix/ene0 with the
    species-mixture mean mass (chemistry.cpp parse_species_single)."""
    text = CGS_UNIT + """
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 16 2 1
[module]
type = chem_hydro
[chemistry]
species = H2 H
[species_init]
H2 = 1
H = 1
[init]
rho0_cgs = 2.0e-24
T0 = 100
"""
    out = ic_eval.eval_ic_slice(_spec_from_text(text), axis=2, max_dim=64)
    assert not [i for i in out["issues"] if i["level"] == "error"]
    pre = out["fields"]["pre"]["data"][0]
    ma = 1.66054e-24
    mu = 0.5 * (2 * 1.00794 * ma) + 0.5 * (1.00794 * ma)
    expected = (1.38065e-16 * 100 * 2.0e-24) / mu / 1e-8
    assert all(abs(v - expected) / expected < 1e-12 for v in pre)
