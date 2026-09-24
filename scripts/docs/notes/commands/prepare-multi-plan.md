`prepare-multi-plan --spec <path> [--out <path>] [--write]` accepts a reviewed
JSON specification containing one multi-file candidate and at least two
per-donor members (`file`, local `candidate`, `target`, `moduleSpecifier`, and
exact `groups`). The union must exactly cover the atomic multi-file SCC. Each
donor transform is independently replayable, targets may not collide, all
cross-file edges must be type-only, and the result is one manifest committed,
audited, and rolled back as a unit.
