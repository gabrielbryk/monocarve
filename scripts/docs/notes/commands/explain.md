Every compiled plan also carries `projectedArtifacts`, the canonical final
hashes of its structured outputs, and `dependencyDecisions`, the source paths
and production/test/type-only reasons behind target additions and reviewed
donor removals. Validation refuses either record when it contradicts the
operation journal or declared dependency sections.

Use `explain` when reviewing either record without re-running discovery:

```sh
monocarve explain --plan .monocarve/plans/c-example.json --dependency library
monocarve explain --plan .monocarve/plans/c-example.json --artifact libs/example/package.json
```

The command is read-only and accepts exactly one selector. Its JSON form is a
stable projection of evidence already bound into the reviewed manifest; it
does not infer new reasons from the current checkout.
