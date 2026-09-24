## Context

Portfolio candidates are ranked graph closures, not necessarily an architect's desired work unit. Existing `--force` can bypass eligibility but must not enlarge a candidate. Current code contains some targeted fixes; implementation starts with a live gap audit rather than assuming every historical transcript issue still exists.

## Goals / Non-Goals

**Goals:** Represent intentional multi-file moves, prove destination and consumer wiring, and fail before approval on known incorrect results.

**Non-Goals:** Automatically invent architectural seams, move arbitrary untracked files, approximate unsupported package-manager semantics, or suppress meaningful refusals.

## Decisions

### 1. Separate selection from eligibility

An explicit reviewed move set names application, source files, destination package, and optional relative target layout. It is compiled through the same closure, protected-path, composition-root, import-resolution, and manifest validation rules as candidate plans. The planner reports files it must include for closure and requires the operator to accept any expansion explicitly. `--force` remains an eligibility override, not a source-list wildcard.

### 2. Bind destination and internal imports before approval

The plan review displays each exact destination path and the resulting import specifiers for moved siblings and external consumers. It detects relative imports that cease to resolve, package self-imports that are invalid under exports, and test-only consumers that need separate dev dependency or import changes. A broken edge refuses compilation or review; it cannot become a plausible successful manifest.

### 3. Prove package wiring against actual adapter semantics

The package-manager adapter computes manifest, workspace, and lockfile importer changes. The plan checks that every new workspace reference has a corresponding package identity and importer operation where required. Scaffolding is configured by the target workspace; absent lint, type, or task-runner setup is reported as a gap, not invented from another repository. Unsupported adapter semantics retain `NotYetPortedError` behavior.

### 4. Keep proof negative

For each proposed check, identify a plausible bad move or wrong wiring that it must reject. Tests use synthetic packages and scopes only. A green plan review is not a behavioral equivalence verdict; repository gates and transaction audit retain their roles.

## Risks / Trade-offs

- Explicit sets could encourage unsafe partial closures. Exact closure and protected-path checks remain mandatory.
- Workspace package rules vary. All workspace-specific values remain in config or adapters, never generic defaults.
- Historical issues may already be fixed. Gap reconciliation is required before implementing a duplicate fix.

## Dependencies

Can be built independently of transaction-readiness. The in-place guide may reuse move-set analysis but does not need a manifest compiler.
