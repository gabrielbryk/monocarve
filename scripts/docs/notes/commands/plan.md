`plan` compiles a hash-journaled manifest but does not edit source. An explicit
package name resolves its root from the workspace graph when that package
already exists; `--package-root` is an optional override. A root containing
`package.json` is extended, otherwise a new package is scaffolded. Named profiles
own their target and cannot be overridden. `--force` bypasses portfolio eligibility only;
validation, preconditions, simulation, branch policy, and audit remain mandatory.
The result names `targetMode` (`existing` or `new`) and `targetPackageRoot` so
automation does not need to infer topology from scaffold operations. `next`
reports the same fields.

By default a moved file keeps the path it had below its application source
root, so `<app>/build/detect.ts` lands at `<packageRoot>/src/build/detect.ts`.
`--target-subpath <dir>` overrides that for a package whose own layout is
different: every selected file lands directly in `<dir>` under its own
basename. It applies only when an existing package is being extended, must name
`src` or a directory below it, and refuses two selected files whose basenames
would collide. The chosen directory is recorded on the plan target, so it is
part of the reviewed bytes and survives `refresh`.

With `--write`, the result also reports the exact manifest path, rendered
approval subject, `git add` argument vector, explicit `approve` command, and
subsequent `apply` command. Nothing is approved implicitly. Add
`--commit-approval` only after review to create a commit containing exactly the
manifest; it requires `--write` and refuses any other staged, modified, or
untracked path.

To append a candidate to an existing package:

```sh
monocarve plan --candidate <id> --package-name @acme/existing --write
```

Review `target.packageRoot` and every move operation's exact target path before
committing the manifest. The plan extends existing package exports, entrypoint, dependencies, project
references, consumers, and lockfile blocks. It does not recreate or register
the package.

If a repository gate reports a moved file, use the target path recorded in the
manifest—not a guessed flattened package path—when updating path-keyed lint,
coverage, or complexity baselines. Any baseline change alters HEAD, so compile
and commit a fresh manifest afterward.
