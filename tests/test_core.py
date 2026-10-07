import pytest

from kratos_spec.descriptors import (DescriptorError, coerce_value,
                                     load_default)
from kratos_spec.parfile import dump_par, parse_par
from kratos_spec.values import format_value, infer_value, values_equal


# ---------------- parfile ----------------

def test_parse_comments_and_trim():
    par = parse_par("# head\n[s]\n  k = 1 2  # tail\n\nempty =\n")
    assert par.sections == {"s": {"k": "1 2", "empty": ""}}


def test_parse_value_cannot_contain_equals():
    par = parse_par("[s]\nk = a=b\n")
    assert par.get("s", "k") == "a"  # truncated at second '=', like C++


def test_duplicate_keys_last_wins():
    par = parse_par("[s]\nk = 1\nk = 2\n")
    assert par.get("s", "k") == "2"


def test_bad_section_raises():
    with pytest.raises(ValueError):
        parse_par("[unclosed\nk = 1\n")


def test_dump_empty_value():
    par = parse_par("[s]\nk =\n")
    assert dump_par(par) == "[s]\nk =\n"


# ---------------- values ----------------

@pytest.mark.parametrize("raw,expected", [
    ("1", 1), ("-3", 3 - 6), ("1.5", 1.5), ("1e-4", 1e-4),
    ("mp", "mp"), ("", ""),
    ("1 2 3", [1, 2, 3]),
    ("-1.0 -0.25 -4.0", [-1.0, -0.25, -4.0]),
    ("per per out", ["per", "per", "out"]),
    ("1 mp", ["1", "mp"]),
])
def test_infer_value(raw, expected):
    assert infer_value(raw) == expected


@pytest.mark.parametrize("v", [1, -3, 1.5, 1e-4, 3.086e18, "mp", "",
                               [1, 2, 3], [-1.0, -0.25, -4.0],
                               ["per", "out"], True, False])
def test_format_infer_roundtrip(v):
    if isinstance(v, bool):
        assert format_value(v) in ("0", "1")
    else:
        assert values_equal(infer_value(format_value(v)), v)


def test_values_equal_numeric_vs_string():
    assert values_equal(1.0, 1.0)
    assert values_equal([1, 2], [1.0, 2.0])
    assert not values_equal("1", 1)


# ---------------- descriptors ----------------

def test_default_registry_loads():
    reg = load_default()
    for section in ("unit", "mesh", "boundary", "cycle", "dynamics",
                    "multigrid", "chemistry", "init", "device"):
        assert reg.match(section) is not None, section


def test_wildcard_refine_region():
    reg = load_default()
    d = reg.match("refine_region_00")
    assert d is not None
    assert d.coerce("level", 2) == 2
    assert reg.match("refine_region.stripe") is d


def test_coerce_bool_from_strings():
    assert coerce_value("bool", "1") is True
    assert coerce_value("bool", "0") is False
    with pytest.raises(DescriptorError):
        coerce_value("bool", "true")  # C++ reads 0/1 only


def test_coerce_fvec3_length():
    assert coerce_value("fvec3", [1, 2, 3]) == [1.0, 2.0, 3.0]
    with pytest.raises(DescriptorError):
        coerce_value("fvec3", [1, 2])


def test_coerce_any_passthrough():
    assert coerce_value("any", "mp") == "mp"
    assert coerce_value("any", 1.67e-24) == 1.67e-24


def test_from_par_forces_global_sections():
    from kratos_spec.parfile import parse_par
    from kratos_spec.spec import Spec
    # a par with neither [unit] nor [device]
    spec = Spec.from_par_text("[mesh]\nn_cell_global = 8 8 1\n")
    assert spec.sections["unit"] == {"length": 1, "time": 1, "density": 1}
    assert spec.sections["device"] == {}
    # explicit values are never overwritten
    spec = Spec.from_par_text("[unit]\nlength = 10\n[device]\nidx_device = 1\n")
    assert spec.sections["unit"] == {"length": 10}
    assert spec.sections["device"] == {"idx_device": 1}
    # idempotent: emit -> parse gives the same sections
    text = spec.to_par_text()
    assert Spec.from_par_text(text).sections == spec.sections
    assert "parse_par"  # keep import referenced
