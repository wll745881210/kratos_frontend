"""kratos-front: CLI for the Problem Spec toolchain.

Subcommands
-----------
lift       PAR [-o spec.json]        par  -> Spec (JSON)
emit       spec.json [-o out.par]    Spec -> par
validate   spec.json                 descriptor validation report
diff       a.par b.par               key-identical comparison
roundtrip  in.par                    par -> Spec -> par -> diff report
serve      [--host H] [--port P]     REST server + web editor (M2)
open       FILE.par                  open a par file in the web editor
"""

from __future__ import annotations

import argparse
import sys

from .descriptors import load_default
from .diff import diff_par
from .parfile import load_par, parse_par
from .spec import Spec


def _cmd_lift(args) -> int:
    spec = Spec.from_par(load_par(args.par))
    if args.name:
        spec.meta["name"] = args.name
    text = spec.to_json()
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    return 0


def _load_spec(path: str) -> Spec:
    with open(path, "r", encoding="utf-8") as fh:
        return Spec.from_json(fh.read())


def _cmd_emit(args) -> int:
    spec = _load_spec(args.spec)
    issues = spec.validate()
    for issue in issues:
        print(issue, file=sys.stderr)
    if any(i.level == "error" for i in issues) and not args.force:
        print("emit: validation errors; use --force to emit anyway",
              file=sys.stderr)
        return 2
    text = spec.to_par_text()
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    return 0


def _cmd_validate(args) -> int:
    spec = _load_spec(args.spec)
    issues = spec.validate()
    for issue in issues:
        print(issue)
    if not issues:
        print("OK")
        return 0
    return 1 if any(i.level == "error" for i in issues) else 0


def _cmd_diff(args) -> int:
    problems = diff_par(load_par(args.a), load_par(args.b))
    for p in problems:
        print(p)
    print("IDENTICAL" if not problems else f"{len(problems)} difference(s)")
    return 0 if not problems else 1


def _cmd_roundtrip(args) -> int:
    original = load_par(args.par)
    spec = Spec.from_par(original)
    issues = spec.validate()
    for issue in issues:
        print(issue, file=sys.stderr)
    regenerated = spec.to_par()
    problems = diff_par(original, regenerated)
    for p in problems:
        print(p)
    print("ROUNDTRIP OK" if not problems
          else f"ROUNDTRIP FAILED ({len(problems)} difference(s))")
    return 0 if not problems else 1


def _cmd_serve(args) -> int:
    try:
        from kratos_server.app import run
    except ImportError:
        print("serve: server extras not installed; run "
              "`pip install -e '.[server]'` first", file=sys.stderr)
        return 2
    run(host=args.host, port=args.port)
    return 0


def _cmd_bindings(args) -> int:
    from .bindings import run_bindings

    outs = run_bindings(args.outdir)
    for o in outs:
        print(f"wrote {o}")
    return 0


def _http_json(url: str, payload: dict | None = None,
               timeout: float = 2.0) -> dict:
    """Tiny stdlib JSON client (keeps `open` free of httpx)."""
    import json
    import urllib.request

    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _cmd_bin(args) -> int:
    """Inspect a kratos .bin output: globals, blocks, fields."""
    try:
        from kratos_spec.binread import BinFile
    except ImportError:
        print("bin: numpy not installed; run `pip install -e .` again",
              file=sys.stderr)
        return 2
    bf = BinFile(args.file)
    try:
        g = bf.globals()
        print(f"{args.file}")
        if g:
            print(f"  time={g.get('time')}  cycle={g.get('cycle')}"
                  f"  dt={g.get('dt')}")
        for b in bf.blocks():
            info = bf.block_info(b)
            print(f"  {b}: level={info.level} n_cell={info.n_cell}"
                  f" xf0={info.xf0} dx0={info.dx0}")
            for f in bf.fields(b):
                arr = bf.read_field(b, f)
                import numpy as np
                print(f"    {f}: shape={list(arr.shape)}"
                      f" min={np.nanmin(arr):.6g} max={np.nanmax(arr):.6g}")
        if args.field:
            blk = bf.blocks()[0]
            s = bf.slice2d(blk, args.field)
            print(f"  slice {args.field}[0] axis=z idx={s['index']}:"
                  f" shape={s['shape']} min={s['min']} max={s['max']}")
    finally:
        bf.close()
    return 0


def _cmd_open(args) -> int:
    """Open FILE.par in the web editor.

    If no server answers on the port, spawn a detached one with
    cwd = the file's directory (so the directory is whitelisted).
    Either way, register the directory via /api/app/set-cwd and point
    the browser at http://HOST:PORT/?file=ABS_PATH.
    """
    import os
    import shutil
    import subprocess
    import time

    path = os.path.realpath(os.path.expanduser(args.par))
    if not os.path.isfile(path):
        print(f"open: not a file: {args.par}", file=sys.stderr)
        return 2
    base = f"http://{args.host}:{args.port}"

    def healthy() -> bool:
        try:
            _http_json(base + "/api/health", timeout=0.5)
            return True
        except Exception:
            return False

    if not healthy():
        cmd = [sys.executable, "-c",
               "import sys; from kratos_spec.cli import main;"
               " sys.exit(main())",
               "serve", "--host", args.host, "--port", str(args.port)]
        subprocess.Popen(  # noqa: S603 (own interpreter, fixed argv)
            cmd, cwd=os.path.dirname(path),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.time() + 10.0
        while time.time() < deadline and not healthy():
            time.sleep(0.2)
        if not healthy():
            print(f"open: server did not come up on {base}",
                  file=sys.stderr)
            return 1

    try:  # idempotent; needed when the server was started elsewhere
        _http_json(base + "/api/app/set-cwd",
                   {"dir": os.path.dirname(path)})
    except Exception as exc:
        print(f"open: set-cwd failed: {exc}", file=sys.stderr)
        return 1

    url = f"{base}/?file={path}"
    print(url)
    if not args.no_browser:
        opener = shutil.which("xdg-open")
        if opener:
            subprocess.Popen([opener, url],
                             stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    return 0


def _cmd_project_init(args) -> int:
    """Create a project directory with a kratos.project.json manifest."""
    import os

    from .descriptors import load_default
    from .project import (new_manifest, regenerate_par, save_manifest)
    from .spec import Spec

    d = os.path.abspath(args.dir)
    os.makedirs(d, exist_ok=True)
    reg = load_default()
    if args.from_par:
        with open(args.from_par, encoding="utf-8") as f:
            spec = Spec.from_par_text(f.read(), reg)
    else:
        spec = Spec.from_par_text(
            "[mesh]\nx_min = 0 0 0\nx_max = 1 1 1\n"
            "n_cell_global = 64 64 1\n"
            "\n[cycle]\nt_lim = 0.1\ndt_init = 1e-4\n", reg)
    m = new_manifest(spec, arch=args.arch)
    save_manifest(d, m)
    with open(os.path.join(d, m["par_snapshot"]), "w",
              encoding="utf-8") as f:
        f.write(regenerate_par(m, reg))
    print(os.path.join(d, "kratos.project.json"))
    return 0


def _cmd_project_check(args) -> int:
    """Validate manifest + asset checksums + par snapshot diff."""
    from .descriptors import load_default
    from .project import (check_par_snapshot, load_manifest, verify_assets)

    reg = load_default()
    m = load_manifest(args.dir)
    issues = verify_assets(args.dir, m) + check_par_snapshot(args.dir, m, reg)
    for i in issues:
        print(f"{i['level']}: [{i['where']}] {i['message']}")
    if not issues:
        print("PROJECT OK")
    return 1 if any(i["level"] == "error" for i in issues) else 0


def _cmd_bundle_export(args) -> int:
    from .bundle import export_bundle

    print(export_bundle(args.dir, args.out))
    return 0


def _cmd_bundle_import(args) -> int:
    import json

    from .bundle import import_bundle
    from .descriptors import load_default

    patch = None
    if args.override:
        with open(args.override, encoding="utf-8") as f:
            patch = json.load(f)
    issues = import_bundle(args.bundle, args.dir, load_default(), patch)
    for i in issues:
        print(f"{i['level']}: [{i['where']}] {i['message']}")
    print(f"imported to {args.dir}")
    return 1 if any(i["level"] == "error" for i in issues) else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kratos-front",
                                 description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("lift", help="par -> Spec (JSON)")
    p.add_argument("par")
    p.add_argument("-o", "--out")
    p.add_argument("--name")
    p.set_defaults(func=_cmd_lift)

    p = sub.add_parser("emit", help="Spec -> par")
    p.add_argument("spec")
    p.add_argument("-o", "--out")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=_cmd_emit)

    p = sub.add_parser("validate", help="validate a Spec")
    p.add_argument("spec")
    p.set_defaults(func=_cmd_validate)

    p = sub.add_parser("diff", help="key-identical par comparison")
    p.add_argument("a")
    p.add_argument("b")
    p.set_defaults(func=_cmd_diff)

    p = sub.add_parser("roundtrip", help="par -> Spec -> par -> diff")
    p.add_argument("par")
    p.set_defaults(func=_cmd_roundtrip)

    p = sub.add_parser("serve", help="REST server + web editor")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8620)
    p.set_defaults(func=_cmd_serve)

    p = sub.add_parser(
        "bindings", help="generate blocklib/Schema/univ_proxy.gen.h/docs "
        "from descriptors (make bindings)")
    p.add_argument("outdir", nargs="?", default="generated")
    p.set_defaults(func=_cmd_bindings)

    p = sub.add_parser("open", help="open a par file in the web editor")
    p.add_argument("par")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8620)
    p.add_argument("--no-browser", action="store_true")
    p.set_defaults(func=_cmd_open)

    p = sub.add_parser("project", help="project directory operations")
    psub = p.add_subparsers(dest="subcmd", required=True)
    pi = psub.add_parser("init", help="create a project directory")
    pi.add_argument("dir")
    pi.add_argument("--from", dest="from_par")
    pi.add_argument("--arch", default="")
    pi.set_defaults(func=_cmd_project_init)
    pc = psub.add_parser("check", help="verify manifest/assets/snapshot")
    pc.add_argument("dir")
    pc.set_defaults(func=_cmd_project_check)

    p = sub.add_parser("bundle", help="tar.gz bundle export/import")
    bsub = p.add_subparsers(dest="subcmd", required=True)
    be = bsub.add_parser("export", help="pack a project directory")
    be.add_argument("dir")
    be.add_argument("-o", "--out")
    be.set_defaults(func=_cmd_bundle_export)
    bi = bsub.add_parser("import", help="unpack + verify + optional rescale")
    bi.add_argument("bundle")
    bi.add_argument("dir")
    bi.add_argument("--override", help="JSON Merge Patch file (whitelisted)")
    bi.set_defaults(func=_cmd_bundle_import)

    p = sub.add_parser("bin", help="inspect a kratos .bin output file")
    p.add_argument("file")
    p.add_argument("--field", help="also dump min/max of this field")
    p.set_defaults(func=_cmd_bin)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
