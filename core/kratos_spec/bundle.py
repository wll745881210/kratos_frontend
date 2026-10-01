"""tar.gz bundle export/import (plan §4.5.2).

Bundle = the project directory packed as-is (manifest + inline Spec +
par snapshot + assets). Import: safe-extract, verify asset checksums,
optionally apply a whitelisted scale-override patch, regenerate the par
from the Spec (the Spec is authoritative; the snapshot is for diffing),
and record provenance.

Packing excludes only: the bundle file itself, `__pycache__`, `.git`,
and `node_modules`. Run outputs should live outside the project dir.
"""

from __future__ import annotations

import json
import os
import tarfile

from .descriptors import Registry
from .project import (
    FORMAT_VERSION,
    apply_scale_override,
    check_par_snapshot,
    is_project,
    load_manifest,
    record_history,
    regenerate_par,
    save_manifest,
    verify_assets,
)

_EXCLUDE_DIRS = {".git", "__pycache__", "node_modules"}


def export_bundle(project_dir: str, out_path: str | None = None) -> str:
    """Pack the project directory into a tar.gz bundle. Returns the path."""
    project_dir = os.path.abspath(project_dir)
    if not is_project(project_dir):
        raise ValueError(f"{project_dir} is not a kratos project (no manifest)")
    if out_path is None:
        out_path = os.path.join(
            os.path.dirname(project_dir),
            os.path.basename(project_dir) + ".kratos-bundle.tar.gz",
        )
    out_path = os.path.abspath(out_path)
    base = os.path.basename(project_dir)

    def _filter(ti: tarfile.TarInfo):
        parts = ti.name.split("/")
        if any(p in _EXCLUDE_DIRS for p in parts):
            return None
        if os.path.abspath(os.path.join(project_dir, *parts[1:])) == out_path:
            return None
        return ti

    with tarfile.open(out_path, "w:gz") as tar:
        tar.add(project_dir, arcname=base, filter=_filter)
    return out_path


def _safe_members(tar: tarfile.TarFile):
    for m in tar.getmembers():
        name = m.name
        if name.startswith("/") or ".." in name.split("/"):
            raise ValueError(f"unsafe path in bundle: {name!r}")
        yield m


def import_bundle(
    bundle_path: str,
    dest_dir: str,
    registry: Registry,
    override_patch: dict | None = None,
) -> list[dict]:
    """Extract a bundle into dest_dir (created), verify, optionally rescale.

    Returns a list of issues (errors abort nothing by themselves — the
    caller decides). The bundle's top-level directory becomes dest_dir.
    """
    issues: list[dict] = []
    with tarfile.open(bundle_path, "r:gz") as tar:
        members = list(_safe_members(tar))
        roots = {m.name.split("/")[0] for m in members if m.name}
        if len(roots) != 1:
            raise ValueError(f"bundle must contain a single top-level dir, got {roots}")
        os.makedirs(dest_dir, exist_ok=True)
        for m in members:
            # strip the top-level dir
            parts = m.name.split("/")[1:]
            if not parts or not any(parts):
                continue
            m.name = "/".join(parts)
            tar.extract(m, dest_dir, filter="data")

    if not is_project(dest_dir):
        raise ValueError("bundle did not contain a kratos.project.json manifest")

    manifest = load_manifest(dest_dir)
    if manifest.get("format_version") != FORMAT_VERSION:
        raise ValueError("unsupported bundle format_version")

    # asset integrity
    issues.extend(verify_assets(dest_dir, manifest))

    # scale override (whitelisted; rejected keys reported, not applied)
    if override_patch:
        new_spec, applied, rejected = apply_scale_override(
            manifest["spec"], override_patch, manifest.get("overridable", [])
        )
        manifest["spec"] = new_spec
        for r in rejected:
            issues.append(
                {
                    "level": "warning",
                    "where": f"override.{r}",
                    "message": "override rejected: key not in overridable whitelist",
                }
            )
        record_history(
            manifest, "scale_override", f"applied: {', '.join(applied) or '(none)'}"
        )

    # regenerate the par snapshot from the authoritative Spec
    snap_rel = manifest.get("par_snapshot", "problem.par")
    snap_path = os.path.join(dest_dir, snap_rel)
    os.makedirs(os.path.dirname(snap_path) or dest_dir, exist_ok=True)
    with open(snap_path, "w", encoding="utf-8") as f:
        f.write(regenerate_par(manifest, registry))
    record_history(manifest, "import", f"from {os.path.basename(bundle_path)}")
    save_manifest(dest_dir, manifest)

    # diff confirmation (should be clean right after regeneration)
    issues.extend(check_par_snapshot(dest_dir, manifest, registry))
    return issues
