# Changelog

All notable changes to monocarve will be documented here. The project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

The first public release is being prepared. Its final notes will summarize the
supported Bun runtime, pnpm and bun package-manager adapters, moon and `none`
task-runner adapters, deterministic plan format, transactional application, and
audit proofs.

### Added

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
