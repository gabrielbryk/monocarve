# monocarve

[![CI](https://github.com/gabrielbryk/monocarve/actions/workflows/ci.yml/badge.svg)](https://github.com/gabrielbryk/monocarve/actions/workflows/ci.yml)
[![license: CC0-1.0](https://img.shields.io/badge/license-CC0--1.0-blue.svg)](LICENSE)

Monocarve moves code out of large TypeScript monorepo applications and into
workspace packages. It compiles the refactor instead of performing it. The
result is a plan manifest that lists which bytes move where, the hash each file
must have before and after, and the commits that will result. Monocarve
simulates that plan in a disposable worktree, replays it into your checkout
as a transaction, and then audits the landed tree against the plan. A
move-and-rewire refactor of hundreds of files is hard to review by eye, and
tests will not always catch a changed byte or an import left behind. Monocarve
replaces that manual review with hash comparisons and independent checks.

## Safety model

- **Compiled, deterministic plans.** The same repository, commit, and config
  always produce the same manifest, byte for byte. Every journal operation
  records a precondition hash and a result hash.
- **Disposable-worktree simulation.** Before your checkout changes, the exact
  journal runs in a throwaway git worktree against your repository's own gates.
- **Transactional apply with recovery.** A committing apply produces a
  pure-rename move commit and a separate wiring commit. Any failure rolls back.
  An interrupted apply leaves a durable checkpoint, which `apply-recover`
  restores.
- **Audit proofs.** `audit` checks the landed tree against the manifest on its
  own terms: byte fidelity, consumer completeness, boundaries, an
  external-consumer compile, codemod replay, the entrypoint closure, and the
  lockfile.
- **Nothing pretends to succeed.** An unsupported adapter, a missing sandbox,
  a stale plan, or a dirty tree is a refusal with a reason. Monocarve never
  guesses a fallback.

## Requirements

- [Bun](https://bun.sh/) `>=1.1.0` (`engines.bun`). The CLI and its TypeScript
  config loader do not support Node.
- Linux. CI runs on Linux, and macOS and Windows are untested.
- `git`.
- `bwrap`, `strace`, and unprivileged user namespaces, **only** if you run
  `assess` (or its replay and batch forms) with a TypeScript or ESM config.
  JSON config and every other command work without them.

## Install

Monocarve is not published to npm yet. Once it is, the intended install is:

```sh
bun add --dev monocarve
```

Until then, install from a git checkout and link it:

```sh
git clone https://github.com/gabrielbryk/monocarve.git
cd monocarve
bun install --frozen-lockfile
bun run build:bundle   # builds dist/, which holds the bin and monocarve/config
bun link

cd /path/to/your-monorepo
bun link monocarve     # adds monocarve to package.json and node_modules
bunx monocarve --help
```

The only programmatic entry point is `monocarve/config`. It exports
`defineConfig` and the config types. Everything else is the CLI.

## First run

Put a `monocarve.config.ts` at the workspace root (see
[Getting started](docs/getting-started.md)), switch to a feature branch, and
run:

```sh
bunx monocarve config-doctor                  # what the tool thinks your workspace is
bunx monocarve scan --app web                 # build the dependency model (read-only)
bunx monocarve portfolio --app web            # ranked extraction candidates
bunx monocarve plan --candidate <id> --package-name @acme/chart --write
bunx monocarve plan-review --plan .monocarve/plans/<id>.json
bunx monocarve approve --plan .monocarve/plans/<id>.json --commit
bunx monocarve apply --plan .monocarve/plans/<id>.json --commit
bunx monocarve audit --plan .monocarve/plans/<id>.json
```

The first three commands are read-only, and `plan --write` only writes a
manifest. For a first evaluation, stop after `plan-review`. Before you approve
and apply, read the [operator guide](docs/operator-guide.md) and make sure your
configured gates match your repository's real required checks.

## Status

| area                                                                     | state                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------- |
| scan, layers, portfolio, candidates, backlog, visualize                  | implemented                                    |
| plan compilation, review, approval, refresh                              | implemented                                    |
| simulation, transactional apply, rollback, apply checkpoint and recovery | implemented                                    |
| audit proofs, status, receipts, reconciliation                           | implemented                                    |
| declaration preparation, boundaries, configured preparers, campaigns     | implemented                                    |
| `assess` architecture evidence bundles                                   | implemented                                    |
| package manager: `pnpm`, `bun`                                           | implemented                                    |
| task runner: `moon`, `none`                                              | implemented                                    |
| package manager: `npm`, `yarn`; task runner: `nx`, `turbo`               | not implemented; rejected by config validation |

The version is 0.1.0 and the plan manifest format may still change.

## Documentation

| document                                                    | read it for                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)                  | a first extraction, step by step, on a small example workspace            |
| [Concepts](docs/concepts.md)                                | plans, journals, simulation, apply recovery, audit proofs, and a glossary |
| [Operator guide](docs/operator-guide.md)                    | the safe loop for real extractions, preparation, boundaries, and refusals |
| [Troubleshooting](docs/troubleshooting.md)                  | common refusals and how to fix them, plus an FAQ                          |
| [CLI reference](docs/cli-reference.md)                      | every command and flag                                                    |
| [Configuration reference](docs/configuration.md)            | every `monocarve.config.ts` field                                         |
| [Architecture assessment](docs/assessment.md)               | `assess` evidence bundles, replay, and the config sandbox                 |
| [Path migrations](docs/path-migrations.md)                  | keeping path-keyed artifacts and documents in step with moves             |
| [Errors and exit codes](docs/errors-and-exit-codes.md)      | the exit-code contract and diagnostic codes                               |
| [Architecture](docs/architecture.md)                        | contributors: source layout, invariants, quality policy, tests            |
| [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)   | development setup and private vulnerability reporting                     |
| [Releasing](docs/releasing.md) · [Backlog](docs/backlog.md) | the maintainer release checklist and known deferred work                  |
| [Changelog](CHANGELOG.md)                                   | release notes                                                             |

## License

CC0-1.0. See [LICENSE](LICENSE).
