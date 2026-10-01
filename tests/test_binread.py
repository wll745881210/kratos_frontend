"""binread tests against tests/fixtures/sod_univ_00000.bin — the t=0.2
final state of the universal-pgen Sod run (512x2x1; rho left 1.0,
right 0.125, contact plateau ~0.4255 near x=0.5 at t=0.2)."""

import math
from pathlib import Path

import pytest

from kratos_spec.binread import BinFile

FIX = Path(__file__).parent / "fixtures" / "sod_univ_00000.bin"


@pytest.fixture(scope="module")
def bf():
    f = BinFile(FIX)
    yield f
    f.close()


def test_blocks_and_geometry(bf):
    blocks = bf.blocks()
    assert blocks == ["block_0"]
    info = bf.block_info("block_0")
    assert info.level == 0
    assert info.n_cell == [512, 2, 1]
    assert info.xf0 == [0.0, -1.0, 0.0]
    assert info.dx0[0] == pytest.approx(1.0 / 512)


def test_globals(bf):
    g = bf.globals()
    assert g["time"] == pytest.approx(0.2)
    assert g["cycle"] > 0


def test_fields_and_shape(bf):
    assert "hydro_cons" in bf.fields("block_0")
    arr = bf.read_field("block_0", "hydro_cons")
    assert arr.shape == (5, 1, 2, 512)      # (n_int, nz, ny, nx)


def test_evolved_states(bf):
    rho = bf.read_field("block_0", "hydro_cons")[0, 0, 0]
    assert rho[0] == pytest.approx(1.0)         # untouched far-left
    assert rho[-1] == pytest.approx(0.125)      # untouched far-right
    assert rho[256] == pytest.approx(0.4255, abs=2e-3)  # contact plateau


def test_slice2d(bf):
    s = bf.slice2d("block_0", "hydro_cons", component=0, axis=1, index=0)
    assert s["shape"] == [1, 512]
    assert s["extent"][0] == pytest.approx(0.0)
    assert s["extent"][1] == pytest.approx(1.0)
    assert s["min"] == pytest.approx(0.125)
    assert s["max"] == pytest.approx(1.0)
    assert all(v is None or math.isfinite(v) for v in s["data"][0])


def test_read_args(bf):
    args = bf.read_args()
    assert args is not None
    assert args["boundary|kinds"].split()[0] == "fre"
    assert args["cycle|n_cycle_lim"] == "100000000"
