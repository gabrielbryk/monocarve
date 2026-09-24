# Architecture assessment

`assess` captures one read-only, input-authoritative scanner baseline for a
configured application, derives normalized architecture evidence from it, and
publishes that evidence atomically as a hash-verified bundle. `batch
split-candidates` shares the same authority for standalone declaration-split
review. Both commands are read-only with respect to the source tree: neither
plans, prepares, nor mutates anything. They fail closed rather than fall back
to a live rescan whenever the inputs they would need to trust cannot be
proven.

## What `assess` does

```
monocarve assess --app <name> --evidence-dir <path>
  [--file <path> ... | --split-hotspots <n>]
  [--replay <bundle>] [--allow-empty] [--replace-generated]
  [--max-bytes <n>] [--limit <n>] [--full-portfolio]
```

1. Loads config (`refuseStaticFilesystemImports`, `executionBoundary:
"snapshot"` — see "The executable-config sandbox" below).
2. Captures an **assessment snapshot**: loaded config, qualification,
   canonical analytical arguments, captured scanner reports, a versioned
   input inventory, the dependency graph, workspace context, portfolio, and
   every shared digest. The snapshot is captured once and every derived
   report reads from it — nothing rescans mid-command.
3. Optionally runs a **declaration batch** (`--file` repeated, or
   `--split-hotspots <n>`) against the snapshot: split-candidate analysis for
   named files, or for the top-N complexity hotspots, sharing one TypeScript
   program across every target in the batch.
4. Derives the normalized reports from the snapshot and batch.
5. Publishes them as an evidence bundle at `--evidence-dir`, atomically.
6. Prints an outcome document and exits 0 (qualified/allowed-empty), 2
   (degraded), or 1 (fatal) — see `docs/errors-and-exit-codes.md` for the
   full diagnostic catalogue and JSON shapes.

`--file` and `--split-hotspots` are mutually exclusive. Bare positional
targets and `--out` are refused: use `--evidence-dir` for output.
Mutation-only flags (`--plan`, `--apply`, `--approve`, and the rest of
`MUTATION_ONLY_FLAGS` in `src/commands/assessment-outcome.ts`) are refused
outright, so a mistyped command reads as a clear refusal rather than a
silent no-op.

## Evidence bundle layout

A published bundle is a directory. Every bundle carries the manifest plus the
core artifacts (`CORE_ASSESSMENT_ARTIFACTS` in `src/assessment/bundle.ts`):

| File                                           | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                                | Binds every other artifact by path and hash. Authoritative because it is written last, inside a staging directory, and is never itself listed or hashed (no recursive self-hash). Records `kind` (`architecture-assessment` or `declaration-analysis-batch`), analytical arguments, baseline identity, qualification, the application-to-raw-report path mapping, provenance (`live` capture vs. `live`/`replay` invocation), overrides, and omissions. |
| `summary.json`                                 | The normalized `ArchitectureSummary`: source/build identity, qualification, graph facts, candidate totals.                                                                                                                                                                                                                                                                                                                                              |
| `layers.json`                                  | The layers report, scoped to the snapshot's `baseline`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `hotspots.json`                                | Bounded complexity-hotspot report (respects `--limit`).                                                                                                                                                                                                                                                                                                                                                                                                 |
| `portfolio.json`                               | Bounded portfolio summary.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `backlog.json`                                 | Bounded backlog report.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `findings.md`                                  | Human-readable Markdown findings; gains a "Declaration split overview" section when a batch ran.                                                                                                                                                                                                                                                                                                                                                        |
| `input-inventory.json`                         | The versioned input inventory that binds replay authority — canonical paths, content hashes, directory-entry snapshots, and absence probes. Mandatory; there is no raw-omission option.                                                                                                                                                                                                                                                                 |
| `<app>-raw.json` (one per scanned application) | The raw scanner report, canonicalized, named by `rawReports` in the manifest. Mandatory for the same reason as the input inventory: raw reports and the input inventory jointly bind replay authority.                                                                                                                                                                                                                                                  |
| `portfolio-full.json`                          | Only with `--full-portfolio`: the complete ranked portfolio instead of the bounded summary.                                                                                                                                                                                                                                                                                                                                                             |
| `split-aggregate.json`                         | Only when a batch selection (`--file`/`--split-hotspots`) ran as part of `assess`.                                                                                                                                                                                                                                                                                                                                                                      |

Every bounded artifact carries its totals, limits, and omission instructions,
so a truncated report never looks complete by accident.

Publication holds an exclusive lock keyed by the canonical destination,
renders into a sibling staging directory, computes hashes, and renames
staging into place last. This is a cooperative-writer protocol, not an
access-control boundary against a hostile same-UID process. A destination
that already holds a foreign or suspicious bundle refuses with
`EVIDENCE_RECOVERY_REQUIRED` rather than overwriting it; replacing an
existing bundle this tool owns requires `--replace-generated` explicitly.

## `--replay`

`assess --replay <bundle-directory>` (and the batch equivalent) re-derives
evidence from a previously published bundle's raw reports and input
inventory instead of scanning live. It verifies artifact integrity and the
exact current input/config/commit/executable/runtime authority before
building the graph — there is no live-scan fallback if verification fails.
A bare `--graph` report is refused on these surfaces with
`ASSESSMENT_REPLAY_PROVENANCE_REQUIRED`; only a complete bundle (manifest +
raw reports + input inventory) is an acceptable replay input. A bundle
captured against different inputs than the current checkout fails with
`ASSESSMENT_REPLAY_INPUT_MISMATCH`.

## Batch `split-candidates`

`monocarve batch split-candidates --app <name> --evidence-dir <path> \
  (--file <path>... | --split-hotspots <n>) [--replay <bundle>] \
  [--allow-empty] [--replace-generated] [--max-bytes <n>] [--json]`

Standalone declaration-split review, sharing assessment's snapshot, input
inventory, replay, budget, and empty-workspace controls. `--evidence-dir` is
required in batch mode; `--out` and positional targets are rejected.
`--file` repeated and `--split-hotspots <n>` are mutually exclusive and one
is required. The command shares one TypeScript program across every target,
so program-wide configuration/syntactic/semantic diagnostics anywhere in the
program (not just the targeted files) make the whole batch
`SPLIT_ANALYSIS_INCOMPLETE` and fatal — no partial bundle publishes. With
`--json` it prints a versioned aggregate (`completed`/`failed` paths plus
qualification fields); otherwise a human summary. Legacy single-file /
positional `split-candidates` invocation (no `--evidence-dir`, no repeated
`--file`, no `--split-hotspots`) keeps its old JSON, `--out`, and exit-code
behavior unchanged.

## Qualification statuses and exit codes

| Status          | Exit | `mayPublish` | Meaning                                                                                                                                                         |
| --------------- | ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qualified`     | 0    | true         | Every input qualified cleanly.                                                                                                                                  |
| `allowed-empty` | 0    | true         | A source root exists but has no production files, and `--allow-empty` was passed.                                                                               |
| `degraded`      | 2    | true         | A supported workspace pattern matched nothing (`WORKSPACE_PATTERN_UNMATCHED`); evidence still publishes, with package-dependent conclusions marked unavailable. |
| `fatal`         | 1    | false        | Any diagnostic with `severity: "error"`, or one of the fatal codes in `docs/errors-and-exit-codes.md`. Nothing new publishes.                                   |

Fatal always outranks degraded. See `docs/errors-and-exit-codes.md` for the
full diagnostic-code table and the `--json` failure-document shape.

## The executable-config sandbox

Assessment (and replay, and declaration batch) loads config under a stricter
boundary than ordinary commands: `refuseStaticFilesystemImports: true` plus
`executionBoundary: "snapshot"`. The reason: the ordinary loader runs config
before its own values define the inventory roots, so nothing can prove which
bytes config execution actually read. `src/config/snapshot-loader.ts`
(`loadSnapshotConfig`) closes that gap.

**Inside the boundary** (what is captured and permitted):

- Every file and directory exposed to config execution — module imports,
  resolver inputs, and their whole closure — is bound into the final input
  inventory before the config runs, not inferred afterward.
- The capture is copied into a private sandbox image (`mkdtempSync` under the
  scratch root), never a read-only bind of the live checkout: a bind still
  lets change-and-restore attacks fool a naive read check.
- The config runs inside that image under `bwrap`, with no network access,
  no host `$HOME`, and no host `/tmp` — the sandbox gets its own private
  scratch directory (`/.monocarve-config-tmp`, mounted over `/tmp`).
- `strace` observes every syscall the config process makes; any read outside
  the captured set, after the `ASSESSMENT_CONFIG_EXEC_START` stderr marker,
  fails the load closed with an `ASSESSMENT_CONFIG_UNBOUND:` prefixed
  `ConfigError`. The trace is rejoined per-PID so a threaded/concurrent read
  (which `strace -f` can split into `<unfinished ...>`/`<... resumed>`
  lines) cannot slip through unclassified, and every failed file-class
  syscall counts (`open`, `statfs`, `chdir`, `execve`, and others), not a
  fixed allowlist of syscall names.
- Type-only imports and re-exports are erased before execution, so the
  dependency walk neither follows nor captures them.
- The tool's own config facade (`monocarve/config`, and its `monocarve`
  alias) is not a workspace input. The walk does not descend into it, and
  nothing is captured from the workspace's `node_modules/monocarve`. Inside
  the sandbox those two specifiers resolve to a Bun virtual module whose
  bytes are part of the running executable (`src/config/config-facade.ts`),
  the same whether monocarve runs from source, `dist/`, or the standalone
  binary. It exports `defineConfig`, the identity helper. Its SHA-256 is
  recorded as `baseline.runtime.configFacade`, so replay rejects a bundle
  captured under a different facade. Any other value import from the
  facade fails at module link time, closed.

**Outside the boundary** (deliberately not covered, per the 2026-09-24 scope
decision recorded in `openspec/changes/archive/2026-09-24-add-architecture-assessment/design.md`):

- The sandbox-private `/proc` (its own PID namespace).
- The minimal `/dev` that `bwrap --dev` provides.
- The unmounted `/sys` — a runtime probe there fails and reveals nothing.
- The trusted runtime binary and its libraries (the Bun/Node runtime itself,
  staged read-only into the image).
- The config facade module described above (trusted tool identity, served
  from the executable rather than read from the image).

A config that reads any of these is nondeterministic by construction, which
is the config author's responsibility, not an authority breach over
repository inputs.

## Known limitations

From `openspec/changes/archive/2026-09-24-add-architecture-assessment/follow-ups.md`
(fixed items omitted; these remain open, fail closed, or are out of the
approved scope rather than merge blockers):

- **Directory listings inside the sandbox are silently incomplete.**
  `readdirSync` only shows captured entries, and `getdents`/`getdents64` is
  not traced. A config that enumerates `packages/*` can silently build a
  smaller config than the real workspace, without error.
- **A TOCTOU window in `copyInput`.** Containment is checked separately from
  the `readFileSync` that follows symlinks, so a concurrent writer could in
  principle swap in a symlink to a host file between the check and the read.
- **pnpm-installed config dependencies likely fail closed.** Node module
  resolution follows the real `.pnpm/` store path, but that path is absent
  from the sandbox image, so `node_modules/<pkg>` capture can come up empty.
- **`prepareSandboxImage` runs outside the outer `try`,** so a throw during
  image preparation can leak the scratch snapshot directory. The standalone
  binary also falls back to the first `bun` found on `PATH` when resolving
  the sandboxed runtime.

Executable (`.ts`/`.mts`/`.js`/`.mjs`) config for assess/replay/batch
requires Linux with `bwrap`, `strace`, and working unprivileged user
namespaces, and fails closed everywhere else (including other platforms,
which are out of scope entirely — monocarve is Linux-only).

## Running it in CI

CI needs `bubblewrap` and `strace` installed, and unprivileged user
namespaces available. On Ubuntu 24.04 (and the `ubuntu-latest` GitHub-hosted
runner, which currently maps to 24.04), AppArmor restricts unprivileged user
namespace creation by default, which `bwrap` needs. The release workflow
(`.github/workflows/release.yml`) shows the working sequence:

```bash
sudo apt-get update -qq
sudo apt-get install -y -qq bubblewrap strace
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true
bwrap --unshare-all --ro-bind / / true   # smoke-test the sandbox before relying on it
```

The `sysctl` line is best-effort (`|| true`): some hosts do not expose that
knob, or already allow unprivileged user namespaces. Verify the `bwrap`
smoke-test line succeeds before trusting `assess` output from that runner —
if user namespaces are unavailable, executable-config assessment fails
closed with `ASSESSMENT_CONFIG_UNBOUND`, which is the sandbox refusing to
run rather than a false pass.
