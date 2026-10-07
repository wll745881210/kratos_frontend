"""Golden round-trip tests: corpus pars must regenerate key-identical.

This is the M0 acceptance gate (design doc roadmap M0): lift each corpus
.par to a Spec, emit it back, and require a key-identical diff.

The only sanctioned deviation: from_par forces the global sections
([unit] identity, empty [device]) into every project, so regeneration
may ADD exactly those defaults — never remove or change anything.
"""

import glob
import re
import os

import pytest

from kratos_spec.diff import diff_par
from kratos_spec.parfile import load_par, parse_par
from kratos_spec.spec import GLOBAL_SECTION_DEFAULTS, Spec

CORPUS = sorted(glob.glob(os.path.join(os.path.dirname(__file__),
                                       "corpus", "*.par")))


def _forced_global_additions(problems: list[str]) -> list[str] | None:
    """Problems that are purely added forced-global defaults.

    Depending on diff direction the additions land on either side;
    both "only in first/second" forms are tolerated.
    """
    ok: list[str] = []
    for p in problems:
        m = re.match(r"^only in (?:first|second): (.*)$", p)
        if not m:
            return None
        rest = m.group(1).strip()
        for sec, kv in GLOBAL_SECTION_DEFAULTS.items():
            for key, val in kv.items():
                if rest == f"{sec}|{key} = '{val}'":
                    ok.append(p)
    return ok if len(ok) == len(problems) and problems else None


def test_corpus_nonempty():
    assert len(CORPUS) >= 8


@pytest.mark.parametrize("path", CORPUS, ids=[os.path.basename(p)
                                              for p in CORPUS])
def test_roundtrip_key_identical(path):
    original = load_par(path)
    spec = Spec.from_par(original)
    regenerated = spec.to_par()
    problems = diff_par(original, regenerated)
    assert _forced_global_additions(problems) is not None or problems == [], \
        "\n".join(problems)


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
    problems = diff_par(parse_par(text), load_par(CORPUS[0]))
    assert _forced_global_additions(problems) is not None or problems == []
