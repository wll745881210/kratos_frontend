"""Tests for project manifests and tar.gz bundles (M2.4)."""

import json
import os
import tarfile

import pytest

from kratos_spec import bundle, project
from kratos_spec.descriptors import load_default
from kratos_spec.spec import Spec

REG = load_default()

SOD_PAR = """\
[mesh]
x_min = 0 0 0
x_max = 1 1 1
n_cell_global = 128 2 1

[boundary]
kinds = fre fre fre fre fre fre

[dynamics]
gamma = 1.4
cfl = 0.4

[cycle]
t_lim = 0.2
dt_init = 1e-4
"""


def _make_project(tmp_path, spec_text=SOD_PAR) -> str:
    d = str(tmp_path / "proj")
    os.makedirs(d)
    spec = Spec.from_par_text(spec_text, REG)
    m = project.new_manifest(spec, arch="HIPCPU")
    project.save_manifest(d, m)
    snap = os.path.join(d, m["par_snapshot"])
    with open(snap, "w", encoding="utf-8") as f:
        f.write(spec.to_par_text(REG))
    return d


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------


def test_manifest_roundtrip(tmp_path):
    d = _make_project(tmp_path)
    assert project.is_project(d)
    m = project.load_manifest(d)
    assert m["$schema"] == "kratos.project/v1"
    assert m["format_version"] == "1"
    spec = project.manifest_spec(m)
    assert spec.sections["mesh"]["n_cell_global"] == [128, 2, 1]


def test_manifest_rejects_wrong_version(tmp_path):
    d = _make_project(tmp_path)
    m = project.load_manifest(d)
    m["format_version"] = "99"
    project.save_manifest(d, m)
    with pytest.raises(ValueError, match="format_version"):
        project.load_manifest(d)


# ---------------------------------------------------------------------------
# assets
# ---------------------------------------------------------------------------


def test_asset_checksum_verify(tmp_path):
    d = _make_project(tmp_path)
    with open(os.path.join(d, "cool.dat"), "w") as f:
        f.write("cooling table\n")
    m = project.load_manifest(d)
    project.add_asset(m, d, "cool.dat", role="cooling_table")
    project.save_manifest(d, m)
    assert project.verify_assets(d, project.load_manifest(d)) == []
    # corrupt it
    with open(os.path.join(d, "cool.dat"), "a") as f:
        f.write("tampered\n")
    issues = project.verify_assets(d, project.load_manifest(d))
    assert len(issues) == 1 and issues[0]["level"] == "error"


def test_missing_optional_asset_is_warning(tmp_path):
    d = _make_project(tmp_path)
    m = project.load_manifest(d)
    m["assets"].append(
        {"path": "nope.dat", "sha256": "0" * 64, "role": "ic_base", "required": False}
    )
    issues = project.verify_assets(d, m)
    assert issues[0]["level"] == "warning"


# ---------------------------------------------------------------------------
# merge patch / scale override
# ---------------------------------------------------------------------------


def test_merge_patch_rfc7386():
    t = {"a": {"b": 1, "c": 2}, "d": 3}
    p = {"a": {"b": 10, "c": None}, "e": 4}
    assert project.merge_patch(t, p) == {"a": {"b": 10}, "d": 3, "e": 4}


def test_scale_override_whitelist():
    spec = Spec.from_par_text(SOD_PAR, REG).to_dict()
    patch = {
        "mesh": {"n_cell_global": [1024, 8, 1]},
        "dynamics": {"gamma": 1.6667},  # not whitelisted
    }
    new_spec, applied, rejected = project.apply_scale_override(
        spec, patch, project.DEFAULT_OVERRIDABLE
    )
    assert applied == ["mesh.n_cell_global"]
    assert rejected == ["dynamics.gamma"]
    assert new_spec["sections"]["mesh"]["n_cell_global"] == [1024, 8, 1]
    assert new_spec["sections"]["dynamics"]["gamma"] == 1.4


# ---------------------------------------------------------------------------
# par snapshot diff
# ---------------------------------------------------------------------------


def test_par_snapshot_clean_and_dirty(tmp_path):
    d = _make_project(tmp_path)
    m = project.load_manifest(d)
    assert project.check_par_snapshot(d, m, REG) == []
    # dirty the snapshot
    snap = os.path.join(d, m["par_snapshot"])
    with open(snap, "a") as f:
        f.write("t_lim = 99\n")
    issues = project.check_par_snapshot(d, m, REG)
    assert issues and issues[0]["level"] == "warning"


# ---------------------------------------------------------------------------
# bundle export / import
# ---------------------------------------------------------------------------


def test_bundle_roundtrip(tmp_path):
    d = _make_project(tmp_path)
    with open(os.path.join(d, "cool.dat"), "w") as f:
        f.write("cooling table\n")
    m = project.load_manifest(d)
    project.add_asset(m, d, "cool.dat", role="cooling_table")
    project.save_manifest(d, m)

    out = bundle.export_bundle(d, str(tmp_path / "p.tar.gz"))
    assert tarfile.is_tarfile(out)

    dest = str(tmp_path / "imported")
    issues = bundle.import_bundle(out, dest, REG)
    assert [i for i in issues if i["level"] == "error"] == []
    assert project.is_project(dest)
    m2 = project.load_manifest(dest)
    assert m2["spec"]["sections"]["mesh"]["n_cell_global"] == [128, 2, 1]
    actions = [h["action"] for h in m2["provenance"]["history"]]
    assert "import" in actions
    # regenerated par snapshot matches the Spec
    assert project.check_par_snapshot(dest, m2, REG) == []


def test_bundle_import_with_scale_override(tmp_path):
    d = _make_project(tmp_path)
    out = bundle.export_bundle(d, str(tmp_path / "p.tar.gz"))
    dest = str(tmp_path / "big")
    issues = bundle.import_bundle(
        out,
        dest,
        REG,
        override_patch={
            "mesh": {"n_cell_global": [1024, 16, 1]},
            "dynamics": {"gamma": 9.9},  # rejected
        },
    )
    m = project.load_manifest(dest)
    assert m["spec"]["sections"]["mesh"]["n_cell_global"] == [1024, 16, 1]
    assert m["spec"]["sections"]["dynamics"]["gamma"] == 1.4
    warnings = [i for i in issues if i["level"] == "warning"]
    assert any("dynamics.gamma" in i["where"] for i in warnings)
    # the regenerated par carries the new resolution
    text = open(os.path.join(dest, m["par_snapshot"])).read()
    assert "1024 16 1" in text


def test_bundle_rejects_traversal(tmp_path):
    bad = str(tmp_path / "bad.tar.gz")
    with tarfile.open(bad, "w:gz") as tar:
        info = tarfile.TarInfo("proj/../../evil")
        data = b"x"
        info.size = len(data)
        import io

        tar.addfile(info, io.BytesIO(data))
    with pytest.raises(ValueError, match="unsafe path"):
        bundle.import_bundle(bad, str(tmp_path / "x"), REG)


def test_bundle_import_corrupt_asset_detected(tmp_path):
    d = _make_project(tmp_path)
    with open(os.path.join(d, "cool.dat"), "w") as f:
        f.write("cooling table\n")
    m = project.load_manifest(d)
    project.add_asset(m, d, "cool.dat", role="cooling_table")
    project.save_manifest(d, m)
    out = bundle.export_bundle(d, str(tmp_path / "p.tar.gz"))
    # corrupt inside the tarball is impractical; corrupt after a normal import
    dest = str(tmp_path / "imp")
    bundle.import_bundle(out, dest, REG)
    with open(os.path.join(dest, "cool.dat"), "a") as f:
        f.write("tampered\n")
    issues = project.verify_assets(dest, project.load_manifest(dest))
    assert any(i["level"] == "error" for i in issues)
