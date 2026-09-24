## Purpose

Provides one read-only command that converts a qualified dependency graph into a bounded, normalized, and reproducible architecture-assessment report for human decomposition review.

## ADDED Requirements

### Requirement: Assessment uses one graph baseline

The `assess` command SHALL capture scanner reports once and derive every graph, layer, hotspot, portfolio, backlog, and split result from those reports and one verified input inventory. Every derived artifact SHALL carry the same input digest, graph digest, configuration digest, source commit, and executable identity. Scanner reports alone SHALL NOT constitute replay authority.

#### Scenario: Complete assessment runs

- **WHEN** an operator runs `assess` for a qualified application
- **THEN** the scanner SHALL execute once for that application and every output SHALL identify the same baseline

#### Scenario: Replay reports are supplied

- **WHEN** an operator supplies `--replay <bundle-directory>` containing a valid assessment manifest, scanner reports, and input inventory matching the current inputs
- **THEN** assessment SHALL derive all outputs without performing a live scan and SHALL record both original capture provenance and current replay provenance

### Requirement: Snapshot authority covers every analytical input

The versioned input inventory SHALL bind canonical paths, file bytes by SHA-256, symlink targets, relevant directory membership, and consulted absence states. It SHALL cover configured application and first-party source trees, tests and consumers used by graph or symbol analysis, all TypeScript program inputs including referenced declarations and dependency files, the tsconfig inheritance and project-reference closure, effective configuration and files used to load it, scanner configuration, workspace declarations, package manifests and exports, and dependency-resolution inputs including lockfiles and relevant installed metadata. Source commit and dirty-state observations SHALL supplement, not replace, content authority. Tool/runtime and scanner/TypeScript dependency versions SHALL also be recorded. Newly discovered analytical inputs SHALL be verified against the captured inventory before their results are accepted; unbound reads SHALL fail closed.

Assessment, replay, and declaration batch SHALL continue to accept executable TypeScript and ESM configuration. Their configuration execution SHALL use only immutable captured workspace and dependency inputs; a filesystem read outside that captured set SHALL fail closed. Other commands retain their existing configuration-loading behavior. A static import check alone SHALL NOT constitute this execution boundary. The boundary governs workspace, dependency, and host files. The sandbox's own process filesystem, a minimal device set, a private empty scratch directory, and the trusted runtime binary and its libraries are sandbox-private or executable identity rather than workspace inputs, and are outside the boundary. Configuration that derives values from them is nondeterministic, and determinism guarantees assume deterministic configuration.

Inventory and content SHALL be checked before and after scanning, before dependent analysis, and immediately before publication. Analytical reads SHALL use captured bytes or verify observed bytes against that inventory; cached facts SHALL be scoped to the input digest. Directory membership checks SHALL detect additions and deletions. Fatal drift SHALL produce `ASSESSMENT_INPUT_DRIFT` and publish no new bundle. Output and operational paths SHALL be excluded from input and dirty-state authority only after proving they do not overlap any analytical input or discovery root.

#### Scenario: Consumer changes while split targets remain unchanged

- **WHEN** an application consumer changes after snapshot capture while all requested split target hashes remain unchanged
- **THEN** assessment SHALL reject the drift rather than publish updated affinities under the old graph identity

#### Scenario: Configuration or package resolution changes

- **WHEN** a tsconfig, inherited configuration, workspace declaration, package manifest/export, or consulted dependency changes during assessment
- **THEN** assessment SHALL fail with the changed input path and SHALL publish no new bundle

#### Scenario: Executable config reads outside captured inputs

- **WHEN** a TypeScript or ESM config, including an imported helper, attempts an indirect filesystem read outside the immutable captured workspace and dependency set
- **THEN** assessment, replay, and declaration batch SHALL fail before publication rather than trust the resulting config value

#### Scenario: Executable config reads captured bytes during concurrent change

- **WHEN** a captured config input changes and is restored while the executable config runs
- **THEN** the config SHALL observe only the immutable captured bytes, and the resulting inventory SHALL bind those bytes

#### Scenario: Source membership changes

- **WHEN** a relevant source file is added, deleted, or replaced through a symlink during assessment
- **THEN** inventory verification SHALL fail even if all previously selected split targets are unchanged

#### Scenario: Legacy raw scanner report is supplied

- **WHEN** `assess` or the new split batch surface receives a bare `--graph` report without assessment input provenance
- **THEN** it SHALL refuse with `ASSESSMENT_REPLAY_PROVENANCE_REQUIRED`, perform no fallback live scan, and direct the operator to capture a live assessment; existing discovery replay behavior SHALL remain unchanged

#### Scenario: Replay input no longer matches

- **WHEN** a replay bundle has valid artifact hashes but the current source, compiler configuration, package resolution, source commit, or executable/runtime identity differs from its recorded authority
- **THEN** replay SHALL fail with `ASSESSMENT_REPLAY_INPUT_MISMATCH` before deriving reports and SHALL NOT relabel old scanner output as current evidence

### Requirement: Assessment is strictly read-only

Assessment SHALL NOT compile or approve mutation plans, invoke preparers, run repository gates, create worktrees, simulate transactions, apply journals, modify source files, or modify Git state.

#### Scenario: Assessment completes publication

- **WHEN** `assess` completes with qualified, allowed-empty, or degraded evidence
- **THEN** only files beneath the requested evidence directory SHALL differ from the pre-command filesystem state

#### Scenario: Evidence destination overlaps source discovery

- **WHEN** an evidence or staging destination overlaps a configured analytical input or discovery root
- **THEN** assessment SHALL refuse before writing artifacts rather than exclude genuine source inputs from verification

#### Scenario: Mutation-only flags are supplied

- **WHEN** an operator supplies a flag belonging to a mutation workflow
- **THEN** `assess` SHALL reject the invocation rather than forwarding or interpreting the flag

### Requirement: Architecture summary is normalized and versioned

Assessment SHALL emit one versioned architecture summary used by both JSON and human renderers. It SHALL include qualification, production module and line totals, edge totals, SCC and cyclic-SCC totals, maximum dependency layer, dynamic and unresolved import totals, and candidate totals grouped by eligibility and recommendation.

#### Scenario: All headline metrics are available

- **WHEN** the graph and portfolio analyses supply every standard metric
- **THEN** the summary SHALL expose each metric with documented units and consistent field names

#### Scenario: A metric is unavailable

- **WHEN** qualification prevents a metric from being computed truthfully
- **THEN** the summary SHALL represent it as an explicitly unavailable value with diagnostic reasons rather than omit it or emit an unexplained `null`

### Requirement: Default assessment output is bounded

Assessment SHALL apply deterministic limits to candidate bodies, portfolio records, blocker edges, and split targets. Each bounded report SHALL include the complete total, applied limit, truncation state, omitted sections, and a reproducible command for requesting deeper output.

#### Scenario: Candidate universe exceeds the default limit

- **WHEN** more candidates exist than the default reviewed limit
- **THEN** assessment SHALL emit the bounded deterministic subset and record how many records were omitted

#### Scenario: Full optional report is requested

- **WHEN** the operator explicitly requests a full candidate or portfolio report
- **THEN** assessment SHALL include it subject to the evidence byte budget and record that choice in the manifest

### Requirement: Findings distinguish evidence from decisions

The Markdown findings SHALL state the evidence boundary and qualification status, summarize domains, cycles, hotspots, candidates, and declaration splits, and label preparation questions as evidence for human review rather than architectural decisions or package approvals.

#### Scenario: Mechanically eligible candidate has weak cohesion

- **WHEN** a candidate is mechanically eligible but classified as review-required or discouraged
- **THEN** findings SHALL preserve its mechanical status while explaining the architectural review signal

#### Scenario: Assessment report is reviewed independently

- **WHEN** a reviewer reads only the generated findings and manifest
- **THEN** the report SHALL state that no source mutation or architecture approval occurred and SHALL identify retained and omitted evidence

### Requirement: Analytical output is deterministic

Given identical authoritative inputs, captured scanner reports, executable identity, input mode, and analytical arguments, assessment SHALL produce byte-identical analytical JSON and Markdown. Wall-clock timestamps SHALL NOT enter bundle contents. Source-bound dates SHALL use reproducible source metadata. Publication-only flags, temporary paths, and prior evidence contents SHALL NOT affect analytical identity. Live and replay provenance may differ; their common graph and analytical metrics SHALL agree when their authoritative inputs match.

#### Scenario: Assessment is repeated unchanged

- **WHEN** the same assessment is run twice against identical inputs
- **THEN** all analytical artifact bytes and hashes SHALL be identical
