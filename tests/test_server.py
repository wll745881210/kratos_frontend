"""API-level tests for the M2 FastAPI server (kratos_server).

Uses the starlette TestClient (httpx).  The fs whitelist is pointed at a
tmp_path so tests never touch real directories.
"""

import os

import pytest
from fastapi.testclient import TestClient

from kratos_server.app import create_app

CORPUS = os.path.join(os.path.dirname(__file__), "corpus")
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
SOD_PAR = os.path.join(CORPUS, "sod.par")
SOD_BIN = os.path.join(FIXTURES, "sod_univ_00000.bin")


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(allowed_roots=[str(tmp_path),
                                                CORPUS, FIXTURES]))


# ----------------------------------------------------------------------
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["spec_version"] == 1


def test_descriptors(client):
    r = client.get("/api/descriptors")
    assert r.status_code == 200
    sections = {s["section"]: s for s in r.json()["sections"]}
    assert "mesh" in sections and "dynamics" in sections
    assert any(s["wildcard"] for s in r.json()["sections"])
    mesh = sections["mesh"]
    assert mesh["order"] == 20
    keys = {k["name"]: k for k in mesh["keys"]}
    assert keys["n_cell_global"]["type"] == "ivec3"
    assert keys["n_cell_global"]["required"] is True


def test_parse_emit_roundtrip_via_api(client):
    with open(SOD_PAR, encoding="utf-8") as fh:
        text = fh.read()
    r = client.post("/api/par/parse", json={"text": text})
    assert r.status_code == 200
    body = r.json()
    assert body["spec"]["sections"]["mesh"]["n_cell_global"] \
        == [512, 2, 1]
    assert not [i for i in body["issues"] if i["level"] == "error"]

    r = client.post("/api/spec/emit", json={"spec": body["spec"]})
    assert r.status_code == 200
    emitted = r.json()["text"]
    assert emitted is not None

    # re-parse the emitted text: spec must be stable
    r = client.post("/api/par/parse", json={"text": emitted})
    assert r.status_code == 200
    assert r.json()["spec"]["sections"] == body["spec"]["sections"]


def test_validate_reports_error(client):
    spec = {"version": 1, "meta": {}, "sections": {
        "mesh": {"x_min": [0, 0, 0], "x_max": [1, 1, 1],
                 "n_cell_global": ["a", "b", "c"]}}}
    r = client.post("/api/spec/validate", json={"spec": spec})
    assert r.status_code == 200
    issues = r.json()["issues"]
    assert any(i["level"] == "error" and i["where"]
               == "mesh.n_cell_global" for i in issues)


def test_emit_refuses_invalid_spec(client):
    spec = {"version": 1, "meta": {}, "sections": {
        "mesh": {"n_cell_global": "nonsense"}}}
    r = client.post("/api/spec/emit", json={"spec": spec})
    assert r.status_code == 200
    assert r.json()["text"] is None
    assert any(i["level"] == "error" for i in r.json()["issues"])


def test_bad_spec_version_rejected(client):
    r = client.post("/api/spec/validate",
                    json={"spec": {"version": 99, "sections": {}}})
    assert r.status_code == 400


# ----------------------------------------------------------------------
def test_fs_read_write_list(client, tmp_path):
    target = tmp_path / "sub" / "x.par"
    target.parent.mkdir()
    r = client.post("/api/fs/write",
                    json={"path": str(target), "text": "[mesh]\n"})
    assert r.status_code == 200
    assert r.json()["bytes"] == len("[mesh]\n")

    r = client.get("/api/fs/read", params={"path": str(target)})
    assert r.status_code == 200
    assert r.json()["text"] == "[mesh]\n"

    r = client.get("/api/fs/list", params={"dir": str(tmp_path)})
    assert r.status_code == 200
    entries = r.json()["entries"]
    assert entries[0] == {"name": "sub", "type": "dir"}  # dirs first


def test_fs_corpus_readable(client):
    r = client.get("/api/fs/read", params={"path": SOD_PAR})
    assert r.status_code == 200
    assert "[mesh]" in r.json()["text"]


def test_fs_outside_roots_forbidden(client):
    r = client.get("/api/fs/read", params={"path": "/etc/hostname"})
    assert r.status_code == 403
    r = client.get("/api/fs/read",
                   params={"path": os.path.join(CORPUS, "..", "..",
                                                "pyproject.toml")})
    assert r.status_code == 403  # '..' escape must not slip through


def test_set_cwd_extends_whitelist(client, tmp_path):
    outside = tmp_path.parent / f"{tmp_path.name}_outside"
    outside.mkdir()
    target = outside / "y.par"
    target.write_text("[cycle]\n")
    try:
        r = client.get("/api/fs/read", params={"path": str(target)})
        assert r.status_code == 403

        r = client.post("/api/app/set-cwd", json={"dir": str(outside)})
        assert r.status_code == 200
        assert str(outside) in r.json()["roots"]

        r = client.get("/api/fs/read", params={"path": str(target)})
        assert r.status_code == 200
        assert r.json()["text"] == "[cycle]\n"

        # idempotent
        r = client.post("/api/app/set-cwd", json={"dir": str(outside)})
        assert r.json()["roots"].count(str(outside)) == 1
    finally:
        target.unlink()
        outside.rmdir()


def test_set_cwd_rejects_nonexistent(client):
    r = client.post("/api/app/set-cwd",
                    json={"dir": "/nonexistent-dir-xyz"})
    assert r.status_code == 404


def test_app_cwd_reports_roots(client):
    r = client.get("/api/app/cwd")
    assert r.status_code == 200
    assert os.path.isdir(r.json()["cwd"])
    assert isinstance(r.json()["roots"], list)


# ---------------------------------------------------------------------------
# project / bundle endpoints (M2.4)
# ---------------------------------------------------------------------------


def test_project_lifecycle(client, tmp_path):
    d = str(tmp_path / "proj")
    r = client.post("/api/project/init",
                    json={"dir": d,
                          "text": "[mesh]\nx_min = 0 0 0\nx_max = 1 1 1\n"
                                  "n_cell_global = 32 4 1\n\n"
                                  "[cycle]\nt_lim = 0.1\ndt_init = 1e-4\n"})
    assert r.status_code == 200
    assert r.json()["manifest"]["$schema"] == "kratos.project/v1"

    r = client.get("/api/project/load", params={"dir": d})
    assert r.status_code == 200
    m = r.json()["manifest"]
    assert m["spec"]["sections"]["mesh"]["n_cell_global"] == [32, 4, 1]

    r = client.post("/api/project/check", json={"dir": d})
    assert r.json()["issues"] == []

    m["ui"]["diagram_positions"] = {"flow": {"x": 1, "y": 2}}
    r = client.post("/api/project/save", json={"dir": d, "manifest": m})
    assert r.json()["saved"] is True
    r = client.get("/api/project/load", params={"dir": d})
    assert r.json()["manifest"]["ui"]["diagram_positions"]["flow"]["x"] == 1


def test_project_load_404(client, tmp_path):
    r = client.get("/api/project/load", params={"dir": str(tmp_path)})
    assert r.status_code == 404


def test_bundle_endpoints(client, tmp_path):
    d = str(tmp_path / "proj")
    client.post("/api/project/init", json={"dir": d})
    r = client.post("/api/bundle/export", json={"dir": d})
    assert r.status_code == 200
    bpath = r.json()["bundle"]
    assert bpath.endswith(".tar.gz")

    dest = str(tmp_path / "imp")
    r = client.post("/api/bundle/import",
                    json={"bundle": bpath, "dir": dest,
                          "override": {"mesh": {"n_cell_global": [128, 4, 1]}}})
    assert r.status_code == 200
    r = client.get("/api/project/load", params={"dir": dest})
    assert (r.json()["manifest"]["spec"]["sections"]["mesh"]
            ["n_cell_global"] == [128, 4, 1])


# ----------------------------------------------------------------------
def test_preview_bin_structure(client):
    r = client.post("/api/preview/bin", json={"path": SOD_BIN})
    assert r.status_code == 200
    j = r.json()
    assert j["globals"]["time"] == pytest.approx(0.2)
    assert j["blocks"][0]["n_cell"] == [512, 2, 1]
    assert "hydro_cons" in j["fields"]["block_0"]


def test_preview_bin_slice(client):
    r = client.post("/api/preview/bin", json={
        "path": SOD_BIN, "field": "hydro_cons", "component": 0,
        "axis": 1, "index": 0})
    assert r.status_code == 200
    s = r.json()["slice"]
    assert s["shape"] == [1, 512]
    assert s["min"] == pytest.approx(0.125)
    assert s["max"] == pytest.approx(1.0)


def test_preview_bin_bad_field(client):
    r = client.post("/api/preview/bin", json={
        "path": SOD_BIN, "field": "nope"})
    assert r.status_code == 400


def test_preview_bin_outside_roots(client):
    r = client.post("/api/preview/bin", json={"path": "/etc/hostname"})
    assert r.status_code == 403


def test_blocklib_endpoint(client):
    r = client.get("/api/blocklib")
    assert r.status_code == 200
    lib = r.json()
    types = [m["type"] for m in lib["modules"]]
    assert types == ["hydro", "mhd", "chem_hydro", "chemistry",
                     "multigrid", "post"]
    assert lib["couplings"]["post"]["dyn"]
    assert "ic" in lib["reserved_roles"]
    post = lib["modules"][5]
    assert "post.turb" in post["sections"]
    assert "edot" in {k["name"] for k in post["params"]["post.turb"]}
