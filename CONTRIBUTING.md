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

## Pull requests

Explain the failure mode, the behavior change, and how the tests prove it. Keep
unrelated cleanup separate. Update the README, operator guide, and CLI reference
when public behavior changes.

By contributing, you agree that your contribution is made available under the
[CC0-1.0 dedication](LICENSE).
