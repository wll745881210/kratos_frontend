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

If ``web/client/dist`` exists it is served at ``/`` (single-command
deployment); during development the Vite dev server proxies ``/api``.

Localhost-only, no auth: this is a personal tool.  File-system access is
restricted to whitelisted roots (cwd at startup, the scratch test dir,
and any extra roots in ``KRATOS_FRONT_ROOTS`` (os.pathsep-separated)).
"""

from __future__ import annotations

import os
from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from kratos_spec.descriptors import load_default
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
    app = FastAPI(title="kratos-frontend server", version="0.1.0")

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

    # built client, if present (registered last: catch-all mount)
    dist = os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "client", "dist"))
    if os.path.isdir(dist):
        app.mount("/", StaticFiles(directory=dist, html=True),
                  name="client")
    return app


def run(host: str = "127.0.0.1", port: int = DEFAULT_PORT) -> None:
    import uvicorn
    uvicorn.run(create_app(), host=host, port=port)
