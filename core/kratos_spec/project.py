"""Directory-based project support (plan §4.5.1).

A project is a directory containing a `kratos.project.json` manifest:

```json
{
  "format_version": "1",
  "$schema": "kratos.project/v1",
  "spec": { ... inline Problem Spec ... },
  "environment": {"kratos_version": "...", "descriptor_set": "...",
                  "arch": "HIPCPU", "mpi": false},
  "provenance": {"created_by": "...", "created_at": "...",
                 "parent": null, "history": []},
  "assets": [{"path": "cool.dat", "sha256": "...", "role": "cooling_table",
              "required": true, "regenerable_from": null}],
  "runs": [],
  "overridable": ["mesh.n_cell_global", ...],
  "par_snapshot": "problem.par",
  "ui": {"diagram_positions": {"flow": {"x": 0, "y": 0}}}
}
```

Design rules (plan §4.5.1): self-describing ($schema), keys only ever
added (never renamed), derivables regenerable (par from Spec; snapshot
kept only for diff confirmation), assets carry sha256.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Optional

from .descriptors import Registry
from .parfile import parse_par
from .spec import Spec

MANIFEST_NAME = "kratos.project.json"
FORMAT_VERSION = "1"
SCHEMA_ID = "kratos.project/v1"

# Plan §4.5.2: scale-override whitelist (local test -> cluster scale-up).
DEFAULT_OVERRIDABLE = [
    "mesh.n_cell_global",
    "mesh.x_min",
    "mesh.x_max",
    "cycle.t_lim",
    "cycle.n_cycle_lim",
]


# ---------------------------------------------------------------------------
# manifest construction / io
# ---------------------------------------------------------------------------


def new_manifest(
    spec: Spec,
    created_by: str = "kratos-front",
    arch: str = "",
    mpi: bool = False,
    parent: Optional[str] = None,
) -> dict:
    """Build a fresh manifest dict around an inline Spec."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {
        "$schema": SCHEMA_ID,
        "format_version": FORMAT_VERSION,
        "spec": spec.to_dict(),
        "environment": {
            "kratos_version": "",
            "descriptor_set": "",
            "arch": arch,
            "mpi": mpi,
        },
        "provenance": {
            "created_by": created_by,
            "created_at": now,
            "parent": parent,
            "history": [],
        },
        "assets": [],
        "runs": [],
        "overridable": list(DEFAULT_OVERRIDABLE),
        "par_snapshot": "problem.par",
        "ui": {"diagram_positions": {}},
    }


def manifest_path(project_dir: str) -> str:
    return os.path.join(project_dir, MANIFEST_NAME)


def is_project(project_dir: str) -> bool:
    return os.path.isfile(manifest_path(project_dir))


def load_manifest(project_dir: str) -> dict:
    with open(manifest_path(project_dir), encoding="utf-8") as f:
        m = json.load(f)
    if m.get("format_version") != FORMAT_VERSION:
        raise ValueError(
            f"unsupported format_version {m.get('format_version')!r}"
            f" (expected {FORMAT_VERSION!r})"
        )
    return m


def save_manifest(project_dir: str, manifest: dict) -> str:
    path = manifest_path(project_dir)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return path


def manifest_spec(manifest: dict) -> Spec:
    return Spec.from_dict(manifest["spec"])


# ---------------------------------------------------------------------------
# assets
# ---------------------------------------------------------------------------


def sha256_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def add_asset(
    manifest: dict,
    project_dir: str,
    rel_path: str,
    role: str,
    required: bool = True,
    regenerable_from: Optional[str] = None,
) -> dict:
    """Register an asset (file inside the project dir) with its checksum."""
    full = os.path.join(project_dir, rel_path)
    entry = {
        "path": rel_path,
        "sha256": sha256_file(full),
        "role": role,
        "required": required,
    }
    if regenerable_from:
        entry["regenerable_from"] = regenerable_from
    assets = manifest.setdefault("assets", [])
    assets[:] = [a for a in assets if a.get("path") != rel_path]
    assets.append(entry)
    return entry


def verify_assets(project_dir: str, manifest: dict) -> list[dict]:
    """Check all assets exist and match their sha256. Returns issue list."""
    issues = []
    for a in manifest.get("assets", []):
        rel = a.get("path", "")
        full = os.path.join(project_dir, rel)
        where = f"assets[{rel}]"
        if not os.path.isfile(full):
            level = "error" if a.get("required", True) else "warning"
            issues.append(
                {"level": level, "where": where, "message": "asset missing"}
            )
            continue
        digest = sha256_file(full)
        if digest != a.get("sha256"):
            issues.append(
                {
                    "level": "error",
                    "where": where,
                    "message": f"sha256 mismatch ({digest[:12]}...)",
                }
            )
    return issues


# ---------------------------------------------------------------------------
# scale override (JSON Merge Patch, RFC 7386, whitelisted)
# ---------------------------------------------------------------------------


def merge_patch(target, patch):
    """RFC 7386 JSON Merge Patch."""
    if not isinstance(patch, dict):
        return patch
    if not isinstance(target, dict):
        target = {}
    out = dict(target)
    for k, v in patch.items():
        if v is None:
            out.pop(k, None)
        else:
            out[k] = merge_patch(out.get(k), v)
    return out


def _patch_leaves(patch: dict, prefix: str = ""):
    for k, v in patch.items():
        dotted = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            yield from _patch_leaves(v, dotted)
        else:
            yield dotted, v


def apply_scale_override(spec_dict: dict, patch: dict, whitelist: list[str]):
    """Apply a scale-override patch to a Spec dict.

    The patch is expressed in section space: ``{"mesh": {"n_cell_global":
    [1024, ...]}}`` addresses ``spec.sections.mesh.n_cell_global``. Only
    dotted paths listed in the manifest's `overridable` whitelist are
    applied; everything else is rejected (reported, not silently applied).
    Returns (new_spec_dict, applied_paths, rejected_paths).
    """
    allowed = set(whitelist)
    applied, rejected = [], []
    filtered: dict = {}
    for dotted, value in _patch_leaves(patch):
        if dotted in allowed:
            applied.append(dotted)
            parts = dotted.split(".")
            node = filtered
            for p in parts[:-1]:
                node = node.setdefault(p, {})
            node[parts[-1]] = value
        else:
            rejected.append(dotted)
    out = dict(spec_dict)
    out["sections"] = merge_patch(spec_dict.get("sections", {}), filtered)
    return out, applied, rejected


# ---------------------------------------------------------------------------
# par snapshot: regenerate from Spec and diff against the stored snapshot
# ---------------------------------------------------------------------------


def regenerate_par(manifest: dict, registry: Registry) -> str:
    """Emit the canonical par text from the manifest's inline Spec."""
    spec = manifest_spec(manifest)
    return spec.to_par_text(registry)


def check_par_snapshot(project_dir: str, manifest: dict, registry: Registry) -> list[dict]:
    """Diff the regenerated par against the stored snapshot file."""
    from .diff import diff_par

    snap_rel = manifest.get("par_snapshot", "problem.par")
    snap_path = os.path.join(project_dir, snap_rel)
    if not os.path.isfile(snap_path):
        return [
            {
                "level": "warning",
                "where": "par_snapshot",
                "message": f"snapshot {snap_rel} missing",
            }
        ]
    text = regenerate_par(manifest, registry)
    fresh = parse_par(text)
    stored = parse_par(open(snap_path, encoding="utf-8").read())
    problems = diff_par(stored, fresh)
    if not problems:
        return []
    return [
        {
            "level": "warning",
            "where": "par_snapshot",
            "message": (
                "par snapshot differs from Spec regeneration: "
                + "; ".join(problems[:5])
            ),
        }
    ]


# ---------------------------------------------------------------------------
# provenance
# ---------------------------------------------------------------------------


def record_history(manifest: dict, action: str, detail: str = "") -> None:
    entry = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "action": action,
    }
    if detail:
        entry["detail"] = detail
    manifest.setdefault("provenance", {}).setdefault("history", []).append(entry)
