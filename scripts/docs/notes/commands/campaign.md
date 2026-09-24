New campaigns use stable source identities rather than candidate IDs:

```sh
monocarve campaign optimize --app storefront --out campaign.targets.json --write
monocarve campaign resolve --targets campaign.targets.json
```

The target file contains an application and an ordered `targets` array of
`{ "path": "apps/web/src/feature.ts", "packageName": "@acme/feature" }`.
Resolve always scans current HEAD, skips targets no longer owned by the
application, compiles at most one current candidate, and stops for review. It
writes the plan only with `--write`. This lets candidate IDs change after each
applied extraction without invalidating the campaign definition.
`campaign optimize` orders these stable targets by extracted LOC per deterministic
review unit and includes read-only coupling hotspots as preparation priorities.

The `init`, `status`, `advance`, and `record` forms are retained only to finish
existing schema-v1 pair ledgers.

Campaign ledgers must live beneath configured `campaignDir` and be git-ignored.
`init` and `advance` require fresh native scans and refuse captured `--graph`
evidence. `advance` queues exactly one reviewed child and never applies it.
`record` audits and records an already-applied child with a fresh post-apply
scan. `status` is read-only and reports stale HEAD as non-actionable.
