"""FastAPI application: REST shell over the kratos_spec core.

Endpoints (v1, all under ``/api``):

    GET  /api/health
    GET  /api/descriptors     block library (sections, keys, types, docs)
    POST /api/par/parse       {text}            -> {spec, issues}
    POST /api/spec/emit       {spec}            -> {text, issues}
    POST /api/spec/validate   {spec}            -> {issues}
    GET  /api/fs/read?path=                     -> {path, text}
    POST /api/fs/write        {path, text}      -> {path, bytes}
    GET  /api/fs/list?dir=                      -> {dir, entries}
    GET  /api/app/cwd                           -> {cwd, roots}
    POST /api/app/set-cwd     {dir}             -> {roots}  (whitelist += dir)

If ``web/client/dist`` exists it is served at ``/`` (single-command
deployment); during development the Vite dev server proxies ``/api``.

Localhost-only, no auth: this is a personal tool.  File-system access is
restricted to whitelisted roots (cwd at startup, the scratch test dir,
and any extra roots in ``KRATOS_FRONT_ROOTS`` (os.pathsep-separated)).
``set-cwd`` extends the whitelist at runtime — it is an accident-guard,
not a security boundary.
"""

from __future__ import annotations

import os
from dataclasses import asdict
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from kratos_spec.descriptors import load_default
from kratos_spec import bundle, ic_eval, project
from kratos_spec.parfile import parse_par
from kratos_spec.spec import Spec

DEFAULT_PORT = 8620


# ----------------------------------------------------------------------
# fs whitelist
# ----------------------------------------------------------------------
def default_roots() -> list[str]:
    roots = [os.getcwd(),
             os.path.expanduser(os.path.join("~", "scratch",
                                             "tst_kratos_frontend"))]
    extra = os.environ.get("KRATOS_FRONT_ROOTS")
    if extra:
        roots.extend(extra.split(os.pathsep))
    out = []
    for r in roots:
        r = os.path.realpath(os.path.expanduser(r))
        if r not in out:
            out.append(r)
    return out


def resolve_allowed(path: str, roots: list[str]) -> str:
    """Realpath ``path`` and require it to live under a whitelisted root."""
    p = os.path.realpath(os.path.expanduser(path))
    for root in roots:
        if p == root or p.startswith(root + os.sep):
            return p
    raise HTTPException(
        403, f"path {path!r} is outside the allowed roots: {roots}")


# ----------------------------------------------------------------------
# request bodies
# ----------------------------------------------------------------------
class ParseRequest(BaseModel):
    text: str


class SpecRequest(BaseModel):
    spec: dict


class WriteRequest(BaseModel):
    path: str
    text: str


class SetCwdRequest(BaseModel):
    dir: str


class PreviewIcRequest(BaseModel):
    spec: dict
    axis: int = 2
    index: Optional[int] = None
    max_dim: int = 384


class BinPreviewRequest(BaseModel):
    path: str
    field: Optional[str] = None    # no field -> structure only
    block: Optional[str] = None    # default: first block
    component: int = 0
    axis: int = 2                  # slice normal: 0=x 1=y 2=z
    index: Optional[int] = None


class ProjectInitRequest(BaseModel):
    dir: str
    text: Optional[str] = None  # par text; default minimal mesh+cycle
    arch: str = ""


class ProjectSaveRequest(BaseModel):
    dir: str
    manifest: dict


class DirRequest(BaseModel):
    dir: str


class BundleExportRequest(BaseModel):
    dir: str
    out: Optional[str] = None


class BundleImportRequest(BaseModel):
    bundle: str
    dir: str
    override: Optional[dict] = None


# ----------------------------------------------------------------------
def _issue_dicts(spec: Spec) -> list[dict]:
    return [asdict(i) for i in spec.validate()]


def _spec_from(payload: dict) -> Spec:
    try:
        return Spec.from_dict(payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


# ----------------------------------------------------------------------
def create_app(allowed_roots: list[str] | None = None) -> FastAPI:
    roots = allowed_roots if allowed_roots is not None else default_roots()
    app = FastAPI(
        title="kratos-frontend server",
        version="0.1.0",
        description=(
            "Local REST API for the kratos universal-pgen frontend: "
            "par <-> Spec round-trip, descriptor-driven validation, "
            "IC/mesh/bin previews, project manifests and tar.gz bundles. "
            "Interactive schema: /docs (Swagger UI) or /openapi.json."
        ),
    )

    app.add_middleware(  # dev convenience (Vite on :5173); proxy not needed
        CORSMiddleware, allow_origins=["http://localhost:5173",
                                       "http://127.0.0.1:5173"],
        allow_methods=["*"], allow_headers=["*"])

    @app.get("/api/health")
    def health():
        return {"status": "ok", "spec_version": Spec().version}

    @app.get("/api/descriptors")
    def descriptors():
        reg = load_default()
        return {"sections": [{
            "section": d.section, "title": d.title, "order": d.order,
            "doc": d.doc, "wildcard": d.wildcard,
            "keys": [{"name": k.name, "type": k.type,
                      "required": k.required, "default": k.default,
                      "doc": k.doc} for k in d.keys.values()],
        } for d in reg.all_descriptors()]}

    @app.get("/api/blocklib")
    def blocklib():
        """Module block library (in-memory; mirrors the C++ container).

        modules: type + native sections + parameter docs;
        couplings: module type -> slot docs (dialog semantics);
        slot_targets: module type -> slot -> allowed target module types;
        reserved_roles: role names the container rejects;
        ic_channels: [R.ic.<region>] channel keys incl x.<species>.
        """
        from kratos_spec import bindings
        reg = load_default()
        return {
            "modules": bindings._module_blocks(reg),
            "couplings": bindings._COUPLINGS,
            "slot_targets": bindings._SLOT_TARGETS,
            "reserved_roles": bindings._RESERVED_ROLES,
            "ic_channels": bindings._IC_CHANNELS,
        }

    @app.post("/api/par/parse")
    def par_parse(req: ParseRequest):
        spec = Spec.from_par_text(req.text)
        return {"spec": spec.to_dict(), "issues": _issue_dicts(spec)}

    @app.post("/api/spec/emit")
    def spec_emit(req: SpecRequest):
        spec = _spec_from(req.spec)
        issues = spec.validate()
        if any(i.level == "error" for i in issues):
            return {"text": None, "issues": [asdict(i) for i in issues]}
        return {"text": spec.to_par_text(),
                "issues": [asdict(i) for i in issues]}

    @app.post("/api/spec/validate")
    def spec_validate(req: SpecRequest):
        return {"issues": _issue_dicts(_spec_from(req.spec))}

    @app.post("/api/preview/ic")
    def preview_ic(req: PreviewIcRequest):
        # Evaluate the universal-pgen IC stack on a base-mesh slice
        # (no kratos run; see kratos_spec.ic_eval for mirrored semantics).
        spec = _spec_from(req.spec)
        return ic_eval.eval_ic_slice(spec, axis=req.axis,
                                     index=req.index, max_dim=req.max_dim)

    @app.post("/api/preview/bin")
    def preview_bin(req: BinPreviewRequest):
        # Read a kratos .bin output: exact AMR block list (level/xf0/dx0)
        # plus an optional 2D field slice. Format reader is vendored at
        # core/kratos_spec/vendor/binary_io.py (source of truth: kratos
        # trunk visual/binary_io.py).
        p = resolve_allowed(req.path, roots)
        if not os.path.isfile(p):
            raise HTTPException(404, f"not a file: {req.path!r}")
        from kratos_spec.binread import BinFile
        try:
            bf = BinFile(p)
        except Exception as e:
            raise HTTPException(400, f"not a kratos .bin file: {e}")
        try:
            blocks = bf.blocks()
            out = {
                "path": p,
                "globals": bf.globals(),
                "blocks": [bf.block_info(b).__dict__ for b in blocks],
                "fields": {b: bf.fields(b) for b in blocks},
            }
            if req.field:
                blk = req.block or (blocks[0] if blocks else None)
                if blk is None:
                    raise HTTPException(400, "bin file has no blocks")
                if req.field not in bf.fields(blk):
                    raise HTTPException(
                        400, f"no field {req.field!r} in {blk}; "
                             f"have: {bf.fields(blk)}")
                out["slice"] = bf.slice2d(blk, req.field, req.component,
                                          req.axis, req.index)
            return out
        finally:
            bf.close()

    @app.get("/api/fs/read")
    def fs_read(path: str = Query(...)):
        p = resolve_allowed(path, roots)
        if not os.path.isfile(p):
            raise HTTPException(404, f"not a file: {path!r}")
        with open(p, "r", encoding="utf-8") as fh:
            return {"path": p, "text": fh.read()}

    @app.post("/api/fs/write")
    def fs_write(req: WriteRequest):
        p = resolve_allowed(req.path, roots)
        with open(p, "w", encoding="utf-8") as fh:
            n = fh.write(req.text)
        return {"path": p, "bytes": n}

    @app.get("/api/fs/list")
    def fs_list(dir: str = Query(...)):
        p = resolve_allowed(dir, roots)
        if not os.path.isdir(p):
            raise HTTPException(404, f"not a directory: {dir!r}")
        entries = [{"name": n,
                    "type": "dir" if os.path.isdir(os.path.join(p, n))
                             else "file"}
                   for n in sorted(os.listdir(p))]
        entries.sort(key=lambda e: (e["type"] != "dir", e["name"]))
        return {"dir": p, "entries": entries}

    @app.get("/api/app/cwd")
    def app_cwd():
        return {"cwd": os.getcwd(), "roots": list(roots)}

    # ---- project / bundle (M2.4) -----------------------------------------

    @app.post("/api/project/init")
    def project_init(req: ProjectInitRequest):
        d = resolve_allowed(req.dir, roots)
        os.makedirs(d, exist_ok=True)
        text = req.text or ("[mesh]\nx_min = 0 0 0\nx_max = 1 1 1\n"
                            "n_cell_global = 64 64 1\n\n"
                            "[cycle]\nt_lim = 0.1\ndt_init = 1e-4\n")
        spec = Spec.from_par_text(text, load_default())
        m = project.new_manifest(spec, arch=req.arch)
        project.save_manifest(d, m)
        snap = os.path.join(d, m["par_snapshot"])
        with open(snap, "w", encoding="utf-8") as fh:
            fh.write(project.regenerate_par(m, load_default()))
        return {"dir": d, "manifest": m}

    @app.get("/api/project/load")
    def project_load(dir: str = Query(...)):
        d = resolve_allowed(dir, roots)
        if not project.is_project(d):
            raise HTTPException(404, f"not a kratos project: {dir!r}")
        return {"dir": d, "manifest": project.load_manifest(d)}

    @app.post("/api/project/save")
    def project_save(req: ProjectSaveRequest):
        d = resolve_allowed(req.dir, roots)
        if not project.is_project(d):
            raise HTTPException(404, f"not a kratos project: {req.dir!r}")
        project.save_manifest(d, req.manifest)
        return {"dir": d, "saved": True}

    @app.post("/api/project/check")
    def project_check(req: DirRequest):
        d = resolve_allowed(req.dir, roots)
        if not project.is_project(d):
            raise HTTPException(404, f"not a kratos project: {req.dir!r}")
        m = project.load_manifest(d)
        issues = (project.verify_assets(d, m)
                  + project.check_par_snapshot(d, m, load_default()))
        return {"dir": d, "issues": issues}

    @app.post("/api/bundle/export")
    def bundle_export(req: BundleExportRequest):
        d = resolve_allowed(req.dir, roots)
        out = resolve_allowed(req.out, roots) if req.out else None
        return {"bundle": bundle.export_bundle(d, out)}

    @app.post("/api/bundle/import")
    def bundle_import(req: BundleImportRequest):
        b = resolve_allowed(req.bundle, roots)
        d = resolve_allowed(req.dir, roots)
        issues = bundle.import_bundle(b, d, load_default(), req.override)
        return {"dir": d, "issues": issues}

    @app.post("/api/app/set-cwd")
    def app_set_cwd(req: SetCwdRequest):
        """Whitelist ``dir`` (runtime only) so /api/fs can reach it.

        Used by `kratos-front open` and by the client's ?file= fallback
        when the target lives outside the startup roots.
        """
        p = os.path.realpath(os.path.expanduser(req.dir))
        if not os.path.isdir(p):
            raise HTTPException(404, f"not a directory: {req.dir!r}")
        if p not in roots:
            roots.append(p)
        return {"roots": list(roots)}

    # built client, if present (registered last: catch-all mount).
    # KRATOS_FRONT_DIST overrides the repo-relative default (Docker).
    dist = os.environ.get("KRATOS_FRONT_DIST") or os.path.normpath(
        os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "..", "client", "dist"))
    if os.path.isdir(dist):
        app.mount("/", StaticFiles(directory=dist, html=True),
                  name="client")
    return app


def run(host: str = "127.0.0.1", port: int = DEFAULT_PORT) -> None:
    import uvicorn
    uvicorn.run(create_app(), host=host, port=port)
