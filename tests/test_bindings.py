"""Smoke tests for `kratos-front bindings` (M1 make-bindings codegen)."""

import json
import os
import subprocess
import sys

import pytest

from kratos_spec.bindings import run_bindings


@pytest.fixture(scope="module")
def gen(tmp_path_factory):
    dest = tmp_path_factory.mktemp("bindings")
    run_bindings(str(dest))
    return dest


def test_four_artifacts(gen):
    for name in ("blocklib.json", "schema.json", "univ_proxy.gen.h",
                 "descriptors.md"):
        assert (gen / name).is_file(), name


def test_blocklib_content(gen):
    lib = json.loads((gen / "blocklib.json").read_text())
    types = [m["type"] for m in lib["modules"]]
    assert types == ["hydro", "mhd", "chem_hydro", "chemistry",
                     "multigrid", "post"]
    # module blocks carry parameter docs from the descriptors
    assert "gamma" in {k["name"]
                       for k in lib["modules"][0]["params"]["dynamics"]}
    post = lib["modules"][5]
    assert "post.cooling" in post["sections"]
    assert "enabled" in {k["name"]
                         for k in post["params"]["post.cooling"]}
    # coupling capabilities + reserved roles for the GUI dialog
    assert lib["couplings"]["post"]["dyn"]
    assert "module" not in lib["couplings"]
    assert lib["reserved_roles"] == [
        "module", "coupling", "device", "unit",
        "mesh", "boundary", "cycle", "file",
        "init", "ic", "bc", "species_init",
        "dynamics", "chemistry", "multigrid", "post", "cooling",
    ]
    # module blocks carry parameter docs from the descriptors
    assert "gamma" in {k["name"]
                       for k in lib["modules"][0]["params"]["dynamics"]}
    recipes = {r["name"] for r in lib["ic_recipes"]}
    assert {"sod", "briowu", "kh", "blast"} <= recipes
    # grammar rides along (frontend palette renders from this)
    names = [v["name"] for v in lib["grammar"]["variables"]]
    assert names == ["x", "y", "z", "t", "i", "j", "k"]
    assert "rand" in lib["grammar"]["functions"]["special"][0]["name"]


def test_schema_valid_json_schema(gen):
    sch = json.loads((gen / "schema.json").read_text())
    assert sch["properties"]["version"]["const"] == 1
    assert "mesh" in sch["x-known-sections"]
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.Draft202012Validator.check_schema(
        {k: v for k, v in sch.items() if not k.startswith("x-")})


def test_proxy_header_is_generated_copy(gen):
    text = (gen / "univ_proxy.gen.h").read_text()
    assert text.startswith("#pragma once")
    assert "GENERATED" in text.splitlines()[2]
    assert "prx_unv_t" in text


def test_cli(tmp_path):
    exe = os.path.join(os.path.dirname(sys.executable), "kratos-front")
    out = subprocess.run([exe, "bindings", str(tmp_path)],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert (tmp_path / "blocklib.json").is_file()
