# Path-keyed artifact migrations

Some repository baselines preserve measurements under source-file paths. A
pure relocation should rename those keys without recomputing the measurements.
Declare each such artifact in workspace config:

```ts
pathMigrations: {
  artifacts: [
    {
      path: "quality/source-baseline.json",
      command: "workspace-baseline-migrator",
      triggers: ["^apps/"],
    },
  ],
}
```

The command is a UTF-8 text-filter protocol. It runs from a disposable working
directory and receives one JSON object on stdin:

```json
{ "artifact": "quality/source-baseline.json", "contents": "the complete current artifact text", "moves": [{ "source": "apps/a.ts", "target": "libs/a.ts" }] }
```

`moves` is the plan's complete source-to-target map, sorted by source and then
target. The command writes the complete UTF-8 replacement artifact to stdout.
Logs belong on stderr. Invalid UTF-8 input or output is refused. The command
must be self-contained and discoverable through `PATH`; relative writes stay in
the disposable directory and are removed on success or failure.

A repository script such as `bun scripts/migrate-source-baseline.ts` will not
resolve from that directory. Expose it as a PATH-installed workspace tool, or
declare an explicit absolute command in that workspace's config. Prefer the
installed form when plan bytes must remain portable across checkout paths.

Planning records the command, exact move map, input hash, and output hash as a
journal operation. Simulation and real apply run the same command again and
require the same output hash. A changed command, nondeterministic output, or
command failure refuses the transaction. Command isolation prevents accidental
relative writes, including ignored files, from reaching the workspace. It is not a
security sandbox for hostile commands; configuration remains trusted repository
code and an intentionally absolute write can escape the disposable directory.

An empty `triggers` list means every extraction. Duplicate artifact paths are
invalid because one path may have only one declared producer.

## Path-reference rewrites vs. path migrations

Path migrations and path-reference rewrites are complementary features that
handle different kinds of path updates during extraction.

**Path migrations** (`pathMigrations.artifacts`) handle _structured artifacts_:
files where source paths appear as object keys or values in JSON, YAML, or other
formats. A workspace supplies a command that reads the artifact, receives the
list of moved files, and produces a corrected version with updated keys or
references. Examples: test-coverage baselines, linting rule exclusions, or
complexity baselines organized by source path.

The command is external and deterministic. It runs after the extraction is
journaled but before gates. If its output differs from the recorded hash,
simulation and apply both fail. A committing apply regenerates the artifact
and includes it in the wiring commit.

**Path-reference rewrites** (`pathReferenceRewrites`) handle _path tokens found
in documents_: exact path-shaped substrings in Markdown, JSON, plain text, or
configuration files that reference moved code. Monocarve detects and rewrites
them by byte-level span matching, with no external command. Strict matching
rules prevent ambiguity: only one moved source may normalize to each token,
and `matchExtensionless` defaults to `false` so bare stems are not guessed.

Use path migrations when:

- The artifact is structured (JSON, YAML) and the tool owns the update logic
- Path transformation requires domain knowledge (e.g. excluding test paths, or
  aggregating by directory)
- Nondeterministic output is acceptable (as long as it matches the recorded
  hash on replay)

Use path-reference rewrites when:

- The document is unstructured or loosely structured (Markdown, configuration,
  plain text)
- Every occurrence of the path token should be rewritten identically
- The workspace wants no external command or simple span-based updates
- Configuration and documentation must stay in sync with moved code

A workspace often uses both: configure path migrations for structured metrics,
and path-reference rewrites for documentation and configuration. Both are
included in plan review and audit, and a failed apply restores all modified
files.
