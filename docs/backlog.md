# Backlog

Deferred work that is known and deliberate. Each item records why it waits.

## TypeScript 7

`typescript` is held at `^5.9` (commit `7956906`). TypeScript 7's native
compiler exposes no JavaScript compiler API: its entry point exports only
`version` and `versionMajorMinor`, so `createProgram`, `forEachChild`, and
`factory` are undefined. 34 files under `src/` and 9 under `test/` use the classic
Compiler API, and typechecking against 7.0.2 reports 1125 errors. Revisit when
the 7.x JS API is stable (announced for 7.1). Dependabot ignores TypeScript
majors until then.

## tsdown build

A migration of `scripts/build.ts` to tsdown was started and interrupted. Nothing
depends on it; the current Bun build and `verify-package` gate are sufficient.

## macOS and Windows

CI runs on `ubuntu-latest` only. Add a macOS job to the CI matrix before
claiming macOS support. Executable-config assessment additionally needs a
sandbox equivalent to `bwrap` there.

## Adapters

The npm and yarn package-manager adapters and the nx and turbo task-runner
adapters refuse with `not yet ported`. See the README's Status table.
