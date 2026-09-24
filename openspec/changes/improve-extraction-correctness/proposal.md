## Why

Session reviews found plans that did not match intended package boundaries, incomplete consumer and test coverage, broken relative imports after moves, missing package scaffolding, and lockfile importer failures. Agents sometimes completed those moves manually. These are correctness and expressiveness gaps, separate from transaction overhead.

## What Changes

- Provide an explicit move-set planning route for a reviewed multi-file boundary when portfolio candidates do not represent the intended unit.
- Check target layout, internal imports, test consumers, package references, public exports, and lockfile importer changes before approval.
- Distinguish unsupported extraction shapes from fixable configuration gaps; refuse compilation when proof is incomplete.
- Add synthetic negative cases for the observed failure families. First reconcile existing fixes, including target subpaths, boundary baselines, and reference deduplication, to avoid duplicate implementation.

## Capabilities

### New Capabilities

- `explicit-move-set-planning`: Compile a reviewed source closure independently of portfolio candidate ranking.
- `extraction-wiring-completeness`: Establish complete move destination and wiring evidence before approval.

### Modified Capabilities

None until existing behavior is reconciled against these requirements.

## Impact

Planner selection, import and consumer analysis, scaffold/adapter behavior, diagnostics, and synthetic fixtures. No implicit `--force` widening, guessed package policy, partial adapter implementation, or weakened audit.
