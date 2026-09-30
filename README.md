# kratos_frontend

A graphical block-diagram frontend for the
[kratos](https://github.com/) GPU (magneto-)hydrodynamics code:
compose simulation setups visually, generate `.par` parameter files (and
later C++ problem generators), build, run, and preview results.

## Status

Early development. See the design document:
[`docs/kratos_frontend_plan.md`](docs/kratos_frontend_plan.md).

## Repository layout (planned)

| Path | Contents |
|---|---|
| `docs/` | Design documents |
| `descriptors/` | Module descriptors (YAML) — single source of truth |
| `core/` | Python package `kratos_spec`: Problem Spec model, par emitter, differ, expression parser |
| `server/` | FastAPI backend (local, single-user) |
| `cli/` | `kratos-front` CLI mirroring the REST API |
| `web/` | React + TypeScript visual editor (React Flow) |
| `tests/` | Golden round-trip par corpus, expression vectors, e2e tests |

## Development

Build/run rules for the accompanying kratos "universal" problem
generator live **outside** this repo — see
`~/apps/kratos_frontend_dev/DEVELOPMENT.md` (build dir), and run tests in
`~/scratch/tst_kratos_frontend`.

Never build kratos inside the Seafile-synced trunk, and never commit
kratos build artifacts (`obj/`, `bin/`) or run outputs here.

## License

TBD.
