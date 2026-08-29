# Changelog

All notable changes to monocarve will be documented here. The project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

The first public release is being prepared. Its final notes will summarize the
supported Bun runtime, pnpm and bun package-manager adapters, moon and `none`
task-runner adapters, deterministic plan format, transactional application, and
audit proofs.

### Added

- bun package-manager adapter. `packageManager: "bun"` now resolves to a real
  adapter instead of the `not yet ported` seam: workspace membership is read
  from and written to the root `package.json` `workspaces` array, and the
  `bun.lock` importer is spliced as a composite block covering both its
  `workspaces` entry and its `packages` workspace link. Verified byte-identical
  against `bun install --lockfile-only` on bun 1.3.14.
- `fixtures/bun-monorepo`, a synthetic moon + bun workspace whose `bun.lock` is
  the real binary's output.

### Changed

- `RenderImporterInput` carries optional `packageName` and `packageVersion`, for
  lockfiles that record a package's identity as well as its dependencies.
- `PackageManagerAdapter` gained `blockDeclaresImporter`, replacing a hardcoded
  pnpm-shaped substring test in plan validation.
