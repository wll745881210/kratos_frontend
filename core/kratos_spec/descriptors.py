"""Module/section descriptors: the single source of truth.

A descriptor (YAML) declares one par section: its keys, types, defaults,
docs and emission order.  The JSON Schema, the web block library, the
Spec->par emitter and (later) the universal pgen proxy header are all
generated from these files (`make bindings`).

Descriptor format::

    section: mesh               # exact name, or wildcard "refine_region.*"
    title: Computational domain
    order: 20                   # emission order, lower first (default 1000)
    doc: free text
    keys:
      x_min:
        type: fvec3             # see TYPES below
        required: true          # default false
        default: ...
        doc: ...
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import yaml

TYPES = {
    "any",   # passthrough: keep inferred value uncoerced (e.g. "mp" | 1.67e-24)
    "int", "float", "str", "bool",
    "int[]", "float[]", "str[]",
    "fvec3", "ivec3",
}


class DescriptorError(ValueError):
    pass


@dataclass
class KeySpec:
    name: str
    type: str = "str"
    required: bool = False
    default: object = None
    doc: str = ""


@dataclass
class Descriptor:
    section: str                       # may end with ".*" wildcard
    title: str = ""
    order: int = 1000
    doc: str = ""
    keys: dict[str, KeySpec] = field(default_factory=dict)
    source: str = ""

    @property
    def wildcard(self) -> bool:
        return self.section.endswith("*")

    @property
    def prefix(self) -> str:
        return self.section[:-1] if self.wildcard else self.section

    # ------------------------------------------------------------------
    def matches(self, section: str) -> bool:
        if self.wildcard:
            return section.startswith(self.prefix)
        return section == self.section

    def coerce(self, key: str, value):
        """Coerce ``value`` to the declared type; raise DescriptorError."""
        spec = self.keys.get(key)
        if spec is None:
            return value  # unknown key: caller decides (kept verbatim)
        return coerce_value(spec.type, value, f"{self.section}.{key}")


def coerce_value(type_name: str, value, where: str = ""):
    def err(msg):
        raise DescriptorError(f"{where or '<value>'}: {msg}")

    if type_name not in TYPES:
        err(f"unknown type {type_name!r}")
    if type_name == "any":
        return value
    scalar = type_name in ("int", "float", "str", "bool")
    if not scalar and not isinstance(value, (list, tuple)):
        value = [value]
    try:
        if type_name == "int":
            if isinstance(value, bool):
                raise ValueError
            if isinstance(value, float) and not value.is_integer():
                raise ValueError
            return int(value)
        if type_name == "float":
            if isinstance(value, bool):
                raise ValueError
            return float(value)
        if type_name == "str":
            if isinstance(value, (list, tuple)):
                raise ValueError
            return str(value)
        if type_name == "bool":
            if isinstance(value, str):
                if value not in ("0", "1"):
                    raise ValueError
                return value == "1"
            return bool(value)
        conv = {"int[]": int, "float[]": float, "str[]": str,
                "fvec3": float, "ivec3": int}[type_name]
        out = [conv(v) for v in value]
        if type_name in ("fvec3", "ivec3") and len(out) != 3:
            raise ValueError
        return out
    except (TypeError, ValueError):
        err(f"value {value!r} does not match type {type_name!r}")


def _load_one(path: str) -> Descriptor:
    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    if not isinstance(raw, dict) or "section" not in raw:
        raise DescriptorError(f"{path}: missing 'section'")
    section = raw["section"]
    if "*" in section and not section.endswith("*"):
        raise DescriptorError(
            f"{path}: wildcard only allowed as trailing '*'")
    keys: dict[str, KeySpec] = {}
    for name, spec in (raw.get("keys") or {}).items():
        spec = spec or {}
        t = spec.get("type", "str")
        if t not in TYPES:
            raise DescriptorError(
                f"{path}: key {name!r}: unknown type {t!r}")
        keys[name] = KeySpec(name=name, type=t,
                             required=bool(spec.get("required", False)),
                             default=spec.get("default"),
                             doc=spec.get("doc", ""))
    return Descriptor(section=section, title=raw.get("title", ""),
                      order=int(raw.get("order", 1000)),
                      doc=raw.get("doc", ""), keys=keys, source=path)


class Registry:
    """All loaded descriptors; exact-match first, then wildcard prefix."""

    def __init__(self, descriptors: list[Descriptor]):
        self._exact: dict[str, Descriptor] = {}
        self._wild: list[Descriptor] = []
        for d in descriptors:
            if d.wildcard:
                self._wild.append(d)
            else:
                if d.section in self._exact:
                    raise DescriptorError(
                        f"duplicate descriptor for section {d.section!r}: "
                        f"{d.source} vs {self._exact[d.section].source}")
                self._exact[d.section] = d

    def match(self, section: str) -> Descriptor | None:
        if section in self._exact:
            return self._exact[section]
        for d in self._wild:
            if d.matches(section):
                return d
        return None

    def known_sections(self) -> list[str]:
        return sorted(self._exact)

    def all_descriptors(self) -> list[Descriptor]:
        """Every descriptor, exact first, sorted by (order, section)."""
        return sorted([*self._exact.values(), *self._wild],
                      key=lambda d: (d.order, d.section))

    def emission_order(self, names: list[str]) -> list[str]:
        """Sort section names: descriptor order first, unknowns last
        (stable, keeping input order among equal ranks)."""
        def rank(n):
            d = self.match(n)
            return d.order if d else 10_000
        return sorted(names, key=lambda n: (rank(n), names.index(n)))


def load_registry(root: str) -> Registry:
    """Load every descriptor ``*.yaml`` under ``root`` (recursively).

    Files without a top-level ``section:`` key are data files, not
    section descriptors (e.g. expr_grammar.yaml, ic/recipes.yaml) and
    are skipped.
    """
    descriptors = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in sorted(filenames):
            if fn.endswith((".yaml", ".yml")) and fn != "meta.schema.yaml":
                path = os.path.join(dirpath, fn)
                with open(path, "r", encoding="utf-8") as fh:
                    head = yaml.safe_load(fh)
                if isinstance(head, dict) and "section" in head:
                    descriptors.append(_load_one(path))
    return Registry(descriptors)


def default_root() -> str:
    """The descriptors/ directory shipped in this repository.

    ``KRATOS_FRONT_DESCRIPTORS`` overrides the location (needed by
    non-editable installs, e.g. inside Docker, where the repo checkout
    is not reachable relative to this file).
    """
    env = os.environ.get("KRATOS_FRONT_DESCRIPTORS")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    # core/kratos_spec/descriptors.py -> <repo>/descriptors
    return os.path.normpath(os.path.join(here, "..", "..", "descriptors"))


def load_default() -> Registry:
    return load_registry(default_root())
