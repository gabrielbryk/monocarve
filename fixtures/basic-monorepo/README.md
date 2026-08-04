# fixture: basic-monorepo

A synthetic moon + pnpm workspace. Every file here was written by hand for the
test suite; nothing is copied from a real repository.

It exists to exercise the shapes the engine has to survive, in the smallest
workspace that still contains them:

| shape | where |
| --- | --- |
| value import across packages | `apps/web/src/main.ts` -> `@acme/logger` |
| type-only import | `apps/web/src/widgets/chart.ts` -> `../types` |
| asset import (moves with the closure) | `chart.ts` -> `./chart.css` |
| test file travelling with its subject | `apps/web/src/widgets/chart.test.ts` |
| re-export barrel | `libs/format/src/index.ts` |
| second application sharing a lib | `apps/api/src/server.ts` -> `@acme/logger` |
| composition root | `apps/web/src/main.ts` (declared in the config) |
| lockfile importers to insert into and to rewrite | `pnpm-lock.yaml` |

`monocarve.config.json` at the root is a working config for this workspace and
is what the config-loading tests discover by walking upward from a nested file.

Nothing here is installed or built: there is no `node_modules`, and the
`pnpm-lock.yaml` is hand-written so the lockfile-importer operations have
something real to edit.

Relative specifiers carry explicit extensions on purpose. The external-consumer
compile proof compiles the extracted package under NodeNext resolution, which
requires them — a fixture written the bundler way would fail that proof for a
reason that has nothing to do with the extraction.

The gate commands in `monocarve.config.json` are trivial shell commands rather
than a task runner's, so the simulation can actually run them here. A real
workspace puts its own lint/typecheck/test commands there.
