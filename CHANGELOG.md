# Changelog

All notable changes to monocarve will be documented here. The project follows
[Semantic Versioning](https://semver.org/).

## 0.1.0 — unreleased

First public release. monocarve compiles a deterministic, hash-verified plan for
decomposing a TypeScript monorepo application into workspace packages. It
simulates the plan in a disposable worktree, applies it transactionally, and
audits the result.

It runs on Bun and supports the pnpm and bun package managers and the moon and
`none` task runners. Linux is the supported platform. The npm, yarn, nx, and
turbo adapter seams refuse with a `not yet ported` error.

### Added

- `assess`: captures one input-authoritative scanner baseline and derives the
  summary, layers, portfolio, backlog, and optional declaration splits from it.
  It publishes them atomically as a hash-verified evidence bundle that
  `assess --replay` re-verifies against the current inputs. The standalone
  `split-candidates` batch mode reuses the same authority. Executable TS/ESM
  config for these commands runs in a `bwrap` sandbox from copied bytes, and
  any other file access fails closed (Linux; requires `bwrap` and `strace`).
- `prune-worktrees` command, reclaiming simulation worktrees left behind by
  interrupted runs. A run disposes its own worktree on success and on failure
  alike, but no `finally` survives `SIGKILL` or a closed terminal, so leftovers
  accumulate in `transaction.worktreeRoot`. Defaults to `--older-than 1h`
  because that root is shared with any concurrently running simulation;
  `--all` ignores age. The underlying `pruneWorktrees` had existed unexported
  from any command since it was written.
- `MONOCARVE_SCRATCH_ROOT`, overriding where every disposable directory is
  created.
- bun package-manager adapter. `packageManager: "bun"` now resolves to a real
  adapter instead of the `not yet ported` seam: workspace membership is read
  from and written to the root `package.json` `workspaces` array, and the
  `bun.lock` importer is spliced as a composite block covering both its
  `workspaces` entry and its `packages` workspace link. Verified byte-identical
  against `bun install --lockfile-only` on bun 1.3.14.
- `fixtures/bun-monorepo`, a synthetic moon + bun workspace whose `bun.lock` is
  the real binary's output.

### Changed

- **Breaking:** `configDigest` no longer covers `transaction.worktreeRoot`.
  That field is a machine-local scratch path, and including it made a plan's
  identity depend on the filesystem of the machine that compiled it: two hosts
  with different `TMPDIR` computed different digests for the same plan, and a
  plan compiled before a scratch root changed was rejected as forged
  afterwards. Manifests recorded before this change no longer validate and must
  be recompiled. Every other configuration field, including the rest of the
  transaction block, still participates.
- Simulation worktrees and the other disposable directories default to a cache
  root rather than `os.tmpdir()` (see `MONOCARVE_SCRATCH_ROOT` under Added).

- Disposable state — simulation worktrees, the external-consumer proof fixture,
  the preparer bootstrap index and path-migration command directories — now
  defaults to `$XDG_CACHE_HOME/monocarve` or `~/.cache/monocarve` instead of
  `os.tmpdir()`. On most Linux hosts `/tmp` is tmpfs, where a worktree-sized
  tree is charged against RAM and against an inode budget that is exhausted
  long before the byte budget, and where an interrupted run's evidence is lost
  at the next reboot. `transaction.worktreeRoot` still overrides this for
  worktrees, and `os.tmpdir()` remains the fallback when no home directory can
  be determined.
- `node_modules` mirroring for the `symlink` strategy is bounded to the
  configured package-container subtrees (`packageContainerRoots`) instead of
  walking the whole repository, while remaining unbounded in depth within them.
- `RenderImporterInput` carries optional `packageName` and `packageVersion`, for
  lockfiles that record a package's identity as well as its dependencies.
- `PackageManagerAdapter` gained `blockDeclaresImporter`, replacing a hardcoded
  pnpm-shaped substring test in plan validation.
