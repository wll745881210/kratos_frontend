"""The Problem Spec: the single intermediate representation (IR).

M0 shape (JSON)::

    {
      "version": 1,
      "meta": {"name": "...", ...},
      "sections": {
        "unit":  {"length": 3.086e18, ...},
        "mesh":  {...},
        "refine_region.1": {...},      # wildcard-described sections
        "prob":  {...},                # raw passthrough (no descriptor)
        ...
      }
    }

Sections whose descriptor exists are type-checked/coerced; unknown
sections round-trip verbatim (values with inferred types).  Structured
top-level keys (``modules``, ``coupling``, ``ic``) arrive with M1 and
compile down to the same sections map at emission time.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from .descriptors import Registry, load_default
from .parfile import ParFile, dump_par, parse_par
from .values import format_value, infer_value

SPEC_VERSION = 1


# regulations §2.1: the four core super-parameter sections.
CORE_SECTIONS = frozenset({"device", "unit", "mesh", "cycle"})

# Global sections every project carries (added by from_par when absent;
# identity unit keeps bare-key pars in code units, empty [device] keeps
# the engine defaults). Never written when the par already has them.
GLOBAL_SECTION_DEFAULTS: dict = {
    "unit": {"length": 1, "time": 1, "density": 1},
    "device": {},
}


@dataclass
class Issue:
    level: str            # "error" | "warning"
    where: str            # "section.key"
    message: str

    def __str__(self):
        return f"{self.level}: {self.where}: {self.message}"


@dataclass
class Spec:
    meta: dict = field(default_factory=dict)
    sections: dict[str, dict] = field(default_factory=dict)
    version: int = SPEC_VERSION

    # ------------------------------------------------------------------
    @classmethod
    def from_par(cls, par: ParFile, registry: Registry | None = None
                 ) -> "Spec":
        reg = registry or load_default()
        sections: dict[str, dict] = {}
        for name, kv in par.sections.items():
            d = reg.match(name)
            out: dict = {}
            for key, raw in kv.items():
                if d is not None and key in d.keys:
                    out[key] = d.coerce(key, infer_value(raw))
                else:
                    out[key] = infer_value(raw)
            sections[name] = out
        # Every project carries the global sections: [unit] with the
        # identity unit (= code units, so _cgs keys divide by 1) and
        # [device] empty (engine defaults: idx_device auto, seed_rng 7).
        # Added only when absent; existing values are never touched.
        for name, default in GLOBAL_SECTION_DEFAULTS.items():
            sections.setdefault(name, dict(default))
        return cls(sections=sections)

    # ------------------------------------------------------------------
    def to_par(self, registry: Registry | None = None) -> ParFile:
        reg = registry or load_default()
        par = ParFile()
        for name in reg.emission_order(list(self.sections)):
            par.sections.setdefault(name, {})  # keep empty sections
            for key, value in self.sections[name].items():
                par.set(name, key, format_value(value))
        return par

    def to_par_text(self, registry: Registry | None = None) -> str:
        reg = registry or load_default()
        order = [s for s in reg.emission_order(list(self.sections))]
        return dump_par(self.to_par(reg), order=order)

    # ------------------------------------------------------------------
    def validate(self, registry: Registry | None = None) -> list[Issue]:
        reg = registry or load_default()
        issues: list[Issue] = []
        for name, kv in self.sections.items():
            d = reg.match(name)
            if d is None:
                continue  # raw passthrough
            for key, value in kv.items():
                if key not in d.keys:
                    # regulations §2.4.1: an unknown key in a core
                    # super-parameter section is almost certainly a
                    # typo -> error; module sections keep the warning
                    # (forward compatibility).
                    level = "error" if name in CORE_SECTIONS else "warning"
                    issues.append(Issue(
                        level, f"{name}.{key}",
                        f"unknown key for section {name!r}"))
                    continue
                if d.keys[key].deprecated:
                    issues.append(Issue(
                        "warning", f"{name}.{key}",
                        f"key {name}.{key} is deprecated"))
                try:
                    kv[key] = d.coerce(key, value)
                except ValueError as exc:
                    msg = str(exc)
                    prefix = f"{name}.{key}: "
                    if msg.startswith(prefix):
                        msg = msg[len(prefix):]
                    issues.append(Issue("error", f"{name}.{key}", msg))
            for key, spec in d.keys.items():
                if spec.required and key not in kv:
                    issues.append(Issue(
                        "error", f"{name}.{key}",
                        f"required key of section {name!r} is missing"))
        from .xchecks import cross_validate
        issues.extend(cross_validate(self))
        return issues

    # ------------------------------------------------------------------
    def to_dict(self) -> dict:
        return {"version": self.version, "meta": self.meta,
                "sections": self.sections}

    @classmethod
    def from_dict(cls, data: dict) -> "Spec":
        version = data.get("version")
        if version != SPEC_VERSION:
            raise ValueError(
                f"unsupported spec version {version!r} "
                f"(expected {SPEC_VERSION})")
        return cls(meta=dict(data.get("meta") or {}),
                   sections={k: dict(v) for k, v in
                             (data.get("sections") or {}).items()},
                   version=version)

    @classmethod
    def from_json(cls, text: str) -> "Spec":
        return cls.from_dict(json.loads(text))

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent) + "\n"

    # ------------------------------------------------------------------
    @classmethod
    def from_par_text(cls, text: str,
                      registry: Registry | None = None) -> "Spec":
        return cls.from_par(parse_par(text), registry)
