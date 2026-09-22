# Agent contract

Read this before touching anything in this repository.

## 1. Config-first — no hardcoded workspace assumptions, ever

This is the rule that outranks the others. Every fact about a particular
repository lives in `src/config.ts` and nowhere else. Before adding any
constant, ask whether it is a fact about *this tool* or a fact about *some
workspace*. The second kind is a config field.

Concretely, this is a defect anywhere in `src/`:

- a literal package scope, package root, application name, branch name, or
  project id;
- a hardcoded command (`pnpm …`, `moon run …`) outside an adapter;
- a file extension list, test-path pattern, or commit subject baked into a
  module;
- a `switch` on `config.packageManager` / `config.taskRunner` anywhere except
  `src/adapters/registry.ts`.

Tool-specific values (the tool's own name, config filenames, scratch directory)
live in `src/branding.ts` — the single file a rename touches. Do not spell the
tool's name anywhere else in `src/`.

**Defaults are generic.** A default is what a workspace gets when it says
nothing, so it may never encode the conventions of the workspace that happened
to be in front of you. Workspace-specific values belong in that workspace's own
`monocarve.config.ts`, not here — and neither do its package names, paths, or
project ids, in code, tests, fixtures, or commit messages. `fixtures/` uses
`@acme/` and is entirely invented.

## 2. Invariants the engine may not break

These are properties, not preferences. Changing one requires an explicit
decision.

- **Determinism.** Same repo + same commit + same config ⇒ byte-identical plan,
  `planId` included, and the serialized manifest with it. No clock reads —
  `createdAt` is the baseline commit's committer date — no map iteration order,
  no randomness in anything hashed.
- **No partial application.** A journal either applies completely or restores
  every path it touched. There is no continue-on-error mode.
- **The move commit is pure renames.** Every path in it must be R100. Content
  changes belong in the wiring commit.
- **`move` is byte-identical.** `resultHash === preconditionHash`. A move whose
  content changes is `move-with-rewrite`, which carries a replay proof.
- **Simulation runs the repository's own gates**, not gates this tool invents.
- **Guarded branches are refusals**, not warnings.
- **Git is selected by `cwd` alone.** Every git invocation goes through
  `src/util/git.ts`, which strips `GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE`
  and friends from the child environment. Inheriting them lets a command run
  under a hook write into a *different* repository's index while `cwd` looks
  correct. Never call `execFileSync("git", …)` directly, in `src/` or in tests.

## 3. Proof discipline

A proof that can pass when the thing it describes is wrong is worse than no
proof, because it is trusted. When you touch the audit or the validator:

- state what a failure would look like before writing the check;
- if a check cannot fail on a plausible bug, it is documentation, not a proof —
  say so in the comment or delete it;
- add the negative test. Every audit proof in `test/transaction.test.ts` has a
  case that makes it fail, and that is why the passing case means something.

Unimplemented seams throw `NotYetPortedError`, whose message begins `not yet
ported`. What remains is the non-default adapters (bun, npm, yarn, nx, turbo) —
`grep -rn "not yet ported" src/` is the definitive list. Never replace a stub
with a partial implementation that returns plausible data.

## 4. Working here

```bash
bun install
bun run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
bun run test        # test/ only; fixtures/ contains a *.test.ts on purpose; wrapper sets scratch root and timeout
bun run cli -- --help
```

`bunfig.toml` scopes the test root to `test/`. `fixtures/basic-monorepo` is
input data — read it, and keep it synthetic, small, and NodeNext-clean (the
external-consumer proof compiles it for real).

Definition of done for any change here: typecheck clean, tests green, no new
hardcoded workspace assumption, and a negative test for anything that claims to
prove something.

## 5. Public repository hygiene

Keep the repository suitable for public distribution. Names, paths, scopes,
commands, project ids, credentials, and provenance from real workspaces may not
survive anywhere in this tree. Examples and fixtures must remain synthetic.
