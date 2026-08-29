# fixture: bun-monorepo

A synthetic moon + bun workspace. Every file here was written by hand for the
test suite; nothing is copied from a real repository.

It is `basic-monorepo`'s twin, and it exists for the one thing that twin cannot
show: what the engine does when workspace membership lives in the root
`package.json` and the lockfile is `bun.lock` rather than `pnpm-lock.yaml`.

| shape | where |
| --- | --- |
| membership declared in the root manifest | `package.json` -> `workspaces` |
| composite importer (a `workspaces` entry *and* a `packages` link) | `bun.lock` |
| the workspace root keyed as `""` rather than `.` | `bun.lock` |
| an external dependency with a real resolution | `left-pad` in `apps/web` |
| package resolution through an `exports` map | `libs/*/package.json` |
| value import across packages | `apps/web/src/main.ts` -> `@acme/logger` |
| type-only import | `apps/web/src/widgets/chart.ts` -> `../types.ts` |
| asset import (moves with the closure) | `chart.ts` -> `./chart.css` |
| test file travelling with its subject | `apps/web/src/widgets/chart.test.ts` |
| re-export barrel | `libs/format/src/index.ts` |

`bun.lock` was written by `bun install --lockfile-only` and is committed
verbatim, which is what makes it usable as the oracle: the byte-identity proof
in `test/lockfile-verify-bun.test.ts` regenerates it with the real binary and
compares. Editing it by hand would quietly turn that proof into a comparison of
two files nobody rewrites.

Nothing here is installed or built: there is no `node_modules`. Relative
specifiers carry explicit extensions for the same reason `basic-monorepo`'s do —
the external-consumer compile proof compiles under NodeNext resolution.

The gate commands in `monocarve.config.json` are trivial shell commands rather
than a task runner's, so the simulation can actually run them here.
