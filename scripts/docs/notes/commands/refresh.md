For a stale reviewed plan, `refresh` resolves the same candidate from a fresh
graph and refuses dirty workspaces or drift in the application, target,
profile, source closure, source bytes, gates, or commit policy. It reports a
`semanticDiff` separately from baseline provenance changes:

```sh
monocarve refresh --plan .monocarve/plans/c-example.json
monocarve refresh --plan .monocarve/plans/c-example.json \
  --out .monocarve/plans/c-example-refreshed.json --write
```

The first command cannot write. The second writes a separate file exclusively;
add `--commit-approval` only after reviewing the semantic diff. Reviewed plan
bytes are immutable: `--replace` and apply-time refresh are refused. `plan
--write` also refuses an existing output instead of silently overwriting it.
