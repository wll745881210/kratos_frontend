"""CLI surface tests (call main() with argv, no subprocess)."""
from __future__ import annotations

from kratos_spec.cli import main

_VALID_MESH = "[mesh]\nx_min = 0 0 0\nx_max = 1 1 1\nn_cell_global = 8 8 1\n"


def test_validate_accepts_par_file(tmp_path, capsys):
    par = tmp_path / "ok.par"
    par.write_text(_VALID_MESH + "[cycle]\nt_lim = 0.1\n", encoding="utf-8")
    assert main(["validate", str(par)]) == 0
    assert "OK" in capsys.readouterr().out


def test_validate_accepts_spec_json(tmp_path):
    spec = tmp_path / "ok.json"
    spec.write_text('{"version": 1, "sections": {"mesh": {'
                    '"x_min": [0,0,0], "x_max": [1,1,1], '
                    '"n_cell_global": [8,8,1]}}}',
                    encoding="utf-8")
    assert main(["validate", str(spec)]) == 0


def test_validate_bad_typed_value_is_clean_error(tmp_path, capsys):
    par = tmp_path / "bad.par"
    par.write_text(_VALID_MESH + "[cycle]\nt_lim = nope\n", encoding="utf-8")
    assert main(["validate", str(par)]) == 2
    assert "cycle.t_lim" in capsys.readouterr().err
