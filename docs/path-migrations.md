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
{
  "artifact": "quality/source-baseline.json",
  "contents": "the complete current artifact text",
  "moves": [{ "source": "apps/a.ts", "target": "libs/a.ts" }]
}
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
