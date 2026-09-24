## Why

Monocarve exposes the graph, portfolio, hotspot, layer, backlog, and declaration analyses needed to assess a large application, but operators must run and join them manually and can accidentally combine results from different graph baselines. Qualification gaps such as unsupported valid workspace globs, indistinguishable executable builds, and successful unexpected empty scans can also make otherwise plausible assessment evidence untrustworthy.

## What Changes

- Add qualification for nested workspace globs, executable build identity, and unexpected empty scans before architectural conclusions are emitted.
- Add a read-only `assess` command that binds scanner reports to a verified inventory of source, consumers, compiler configuration, workspace membership, and resolution inputs, then derives normalized summaries and deterministic findings from that baseline. Assessment replay requires this provenance; legacy raw reports remain usable only through existing discovery surfaces.
- Add a manifest-bound `--evidence-dir` that publishes assessment artifacts atomically, records hashes and omissions, enforces a byte budget, and cannot overwrite unrelated files.
- Add repeatable and hotspot-driven batch declaration-split analysis whose outputs prove that they share the assessment baseline.
- Define fatal, degraded, qualified, and explicitly allowed-empty outcomes, including exit codes, publication permission, and declaration-analysis completeness. Preserve legacy single-file split JSON and output behavior.
- Expose rich executable identity separately from the unchanged behavioral compiler identity used by extraction plans, preserving same-build distribution/standalone plan interoperability.
- Keep assessment separate from plan compilation, simulation, gates, source mutation, and architectural approval.
- Defer architecture-policy expansion and general before/after graph comparison to later changes after the assessment manifest stabilizes.

## Capabilities

### New Capabilities

- `assessment-qualification`: Qualify workspace discovery, executable identity, and empty-scan behavior before assessment evidence is trusted.
- `architecture-assessment`: Produce one bounded, normalized architectural assessment from one read-only graph baseline.
- `assessment-evidence-bundles`: Publish deterministic assessment artifacts with an authoritative manifest and safe replacement rules.
- `batch-declaration-analysis`: Analyze multiple explicit or hotspot-selected source files against one graph baseline without output collisions.

### Modified Capabilities

None. This repository has no existing OpenSpec capability specifications.

## Impact

- Affected CLI surfaces: `scan`, `config-doctor`, `split-candidates`, `--version`, and the new `assess` command.
- Affected internals: shared workspace-glob enumeration, scanner qualification and cache identity, build stamping, graph/report loading, architecture summary models, output publication, and symbol analysis orchestration.
- New public JSON schemas and stable assessment diagnostic codes will require explicit schema versions and documentation.
- No extraction manifest, approval, simulation, apply, recovery, audit, or receipt semantics change.
- No workspace-specific names, paths, package scopes, or architectural decisions enter defaults, fixtures, or source code.
