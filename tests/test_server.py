"""API-level tests for the M2 FastAPI server (kratos_server).

Uses the starlette TestClient (httpx).  The fs whitelist is pointed at a
tmp_path so tests never touch real directories.
"""

import os

import pytest
from fastapi.testclient import TestClient

from kratos_server.app import create_app

CORPUS = os.path.join(os.path.dirname(__file__), "corpus")
SOD_PAR = os.path.join(CORPUS, "sod.par")


@pytest.fixture()
def client(tmp_path):
    return TestClient(create_app(allowed_roots=[str(tmp_path),
                                                CORPUS]))


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
