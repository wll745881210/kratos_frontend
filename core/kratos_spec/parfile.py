"""Reading and writing kratos .par files.

Semantics mirror src/io/args/input.cpp (read_ascii):

* ``#`` starts a comment; everything after the first ``#`` on a line is
  dropped.
* ``[section]`` opens a section; text after the closing ``]`` is ignored.
* ``key = value`` assigns; only the text up to the *next* ``=`` is the
  value (values therefore cannot contain ``=``).
* keys and values are whitespace-trimmed; duplicate keys: last one wins.
* sections need not be unique; an absent value (``key =``) is the empty
  string.

The in-memory representation preserves first-seen order of sections and
keys so emitted files read naturally for humans.  Round-trip equality is
defined on (section, key, normalised value), not on byte identity.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ParFile:
    """Ordered section -> ordered {key: raw string value} mapping."""

    sections: dict[str, dict[str, str]] = field(default_factory=dict)

    # ------------------------------------------------------------------
    def set(self, section: str, key: str, value: str) -> None:
        self.sections.setdefault(section, {})[key] = value

    def get(self, section: str, key: str, default=None):
        return self.sections.get(section, {}).get(key, default)

    def keys(self) -> list[str]:
        """All internal ``section|key`` identifiers (kratos key_expand)."""
        return [f"{s}|{k}" for s, kv in self.sections.items() for k in kv]


def parse_par(text: str) -> ParFile:
    """Parse .par text, mirroring input.cpp::read_ascii."""
    par = ParFile()
    prefix = ""
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("["):
            end = line.find("]")
            if end < 0:
                raise ValueError(f"Incorrect input section: {raw_line!r}")
            prefix = line[1:end]
            par.sections.setdefault(prefix, {})
            continue
        item, sep, value = line.partition("=")
        if not sep:
            raise ValueError(f"Missing '=' in line: {raw_line!r}")
        # input.cpp reads the value with getline('='): a second '='
        # truncates the value (values cannot contain '=').
        value = value.split("=", 1)[0]
        par.set(prefix, item.strip(), value.strip())
    return par


def load_par(path: str) -> ParFile:
    with open(path, "r", encoding="utf-8") as fh:
        return parse_par(fh.read())


def dump_par(par: ParFile, order: list[str] | None = None) -> str:
    """Serialise.  ``order`` optionally lists section names first, in
    order; remaining sections follow in their stored order."""
    names = list(par.sections)
    if order:
        rank = {name: i for i, name in enumerate(order)}
        names = sorted(names, key=lambda n: (rank.get(n, len(rank)),
                                             names.index(n)))
    out: list[str] = []
    for name in names:
        out.append(f"[{name}]")
        for key, value in par.sections[name].items():
            out.append(f"{key} = {value}" if value != "" else f"{key} =")
        out.append("")
    return "\n".join(out)


def save_par(par: ParFile, path: str, order: list[str] | None = None) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(dump_par(par, order))
