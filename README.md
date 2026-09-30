# kratos_frontend

A graphical block-diagram frontend for the
[kratos](https://github.com/) GPU (magneto-)hydrodynamics code:
compose simulation setups visually, generate `.par` parameter files (and
later C++ problem generators), build, run, and preview results.

## Status

Early development: M0 (par toolchain) and M2.0/M2.1 (REST server + par
editor) are done — see [`docs/implementation.md`](docs/implementation.md).
Design: [`docs/kratos_frontend_plan.md`](docs/kratos_frontend_plan.md).

## Repository layout

| Path | Contents |
|---|---|
| `docs/` | Design documents (`kratos_frontend_plan.md`, `m2_plan.md`, `implementation.md`) |
| `descriptors/` | Module descriptors (YAML) — single source of truth |
| `core/kratos_spec/` | Python package: Problem Spec model, par parser/emitter, differ, `kratos-front` CLI |
| `web/server/kratos_server/` | FastAPI backend (localhost, single-user) |
| `web/client/` | React + TypeScript editor (Vite; form/text par editor now, React Flow diagram in M2.2) |
| `scripts/` | Desktop integration (`install.sh` registers `*.par` → editor) |
| `tests/` | Golden round-trip par corpus, API tests, unit tests |

## Quick start

```bash
uv venv && uv pip install -e '.[test,server]'
cd web/client && npm install && npm run build && cd ..
kratos-front serve                 # editor at http://127.0.0.1:8620
kratos-front open path/to/run.par  # opens one file (spawns the server if needed)
scripts/install.sh                 # optional: double-click .par files in your file manager
```

## Development

Build/run rules for the accompanying kratos "universal" problem
generator live **outside** this repo — see
`~/apps/kratos_frontend_dev/DEVELOPMENT.md` (build dir), and run tests in
`~/scratch/tst_kratos_frontend`.

Never build kratos inside the Seafile-synced trunk, and never commit
kratos build artifacts (`obj/`, `bin/`) or run outputs here.

## License

TBD.
