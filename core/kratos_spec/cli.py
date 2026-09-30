"""kratos-front: CLI for the Problem Spec toolchain.

Subcommands
-----------
lift       PAR [-o spec.json]        par  -> Spec (JSON)
emit       spec.json [-o out.par]    Spec -> par
validate   spec.json                 descriptor validation report
diff       a.par b.par               key-identical comparison
roundtrip  in.par                    par -> Spec -> par -> diff report
serve      [--host H] [--port P]     REST server + web editor (M2)
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

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
