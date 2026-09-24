# Contributing to monocarve

Thanks for helping improve monocarve. Small, focused changes with explicit
failure cases are easiest to review.

## Before changing code

Read [AGENTS.md](AGENTS.md). Its config-first rule and transaction invariants
are part of the product contract, not implementation suggestions.

In particular:

- workspace conventions belong in configuration, never in `src/` defaults;
- all Git commands go through `src/util/git.ts`;
- a `move` remains byte-identical and the move commit remains pure R100 renames;
- a journal either applies completely or restores every touched path; and
- every new proof needs a negative test showing the plausible defect it catches.

Unimplemented adapters must continue to throw `NotYetPortedError`. A partial
adapter that returns plausible output is unsafe.

## Development

Install [Bun](https://bun.sh/) and run:

```bash
bun install --frozen-lockfile
bun run check
bun run build:bundle
bun run verify-package
bun run cli -- --help
```

`bun run check` includes strict typechecking, the complete test suite, and the
repository's file-size and structural-complexity policies. The bundle step
creates `dist/`; package verification packs it, installs that exact artifact into a clean
consumer, imports the public APIs, and executes every declared binary.

Keep fixtures synthetic and use the `@acme/` scope. Do not add names, paths,
commands, project identifiers, or other conventions from a real workspace.

## Running the tests

Use the `test` script, not a bare `bun test`:

```bash
bun run test
```

It runs `bun test --timeout 60000`; a bare `bun test` uses Bun's 5s default,
which some subprocess-backed CLI proofs and the full suite running
concurrently can cross legitimately.

- **Executable-config (`.ts` config) tests need a real sandbox**: `bwrap`,
  `strace`, and working unprivileged user namespaces. Positive-path tests
  (`test/assessment-config-authority.test.ts` and others that call
  `loadSnapshotConfig` or run `assess` against a `.ts` config) skip
  automatically when the sandbox is unavailable, rather than failing; the test
  name says so. The fail-closed negative tests still run everywhere, because a
  missing sandbox and a real ambient-read violation both surface as the same
  `ASSESSMENT_CONFIG_UNBOUND`.
- **Scratch state** (fixture repositories, simulation worktrees) lives under a
  per-checkout cache directory by default (see `src/util/scratch-root.ts`), not
  the repository itself, and each suite cleans up what it creates. Set
  `MONOCARVE_SCRATCH_ROOT` to redirect it, for example on a host where the
  default cache location is unsuitable.
- **`git worktree add` may be blocked** by a local `git` wrapper on some hosts
  (a machine-local policy that routes worktree creation through a different
  tool). Suites that create real simulation worktrees probe for this once and
  fail with an actionable message rather than a confusing deep failure; if you
  hit it, set `ALLOW_GIT_WORKTREE_ADD=1` for the test run.

## Pull requests

Explain the failure mode, the behavior change, and how the tests prove it. Keep
unrelated cleanup separate. Update the README, operator guide, and CLI reference
when public behavior changes.

By contributing, you agree that your contribution is made available under the
[CC0-1.0 dedication](LICENSE).
