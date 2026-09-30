"""Golden round-trip tests: corpus pars must regenerate key-identical.

This is the M0 acceptance gate (design doc roadmap M0): lift each corpus
.par to a Spec, emit it back, and require a key-identical diff.
"""

import glob
import os

import pytest

from kratos_spec.diff import diff_par
from kratos_spec.parfile import load_par, parse_par
from kratos_spec.spec import Spec

CORPUS = sorted(glob.glob(os.path.join(os.path.dirname(__file__),
                                       "corpus", "*.par")))


def test_corpus_nonempty():
    assert len(CORPUS) >= 8


@pytest.mark.parametrize("path", CORPUS, ids=[os.path.basename(p)
                                              for p in CORPUS])
def test_roundtrip_key_identical(path):
    original = load_par(path)
    spec = Spec.from_par(original)
    regenerated = spec.to_par()
    problems = diff_par(original, regenerated)
    assert problems == [], "\n".join(problems)


@pytest.mark.parametrize("path", CORPUS, ids=[os.path.basename(p)
                                              for p in CORPUS])
def test_roundtrip_no_validation_errors(path):
    spec = Spec.from_par(load_par(path))
    errors = [str(i) for i in spec.validate() if i.level == "error"]
    assert errors == [], "\n".join(errors)


def test_spec_json_roundtrip():
    spec = Spec.from_par(load_par(CORPUS[0]))
    again = Spec.from_json(spec.to_json())
    assert again.to_dict() == spec.to_dict()


def test_roundtrip_via_text():
    with open(CORPUS[0], encoding="utf-8") as fh:
        spec = Spec.from_par_text(fh.read())
    text = spec.to_par_text()
    assert diff_par(parse_par(text), load_par(CORPUS[0])) == []
