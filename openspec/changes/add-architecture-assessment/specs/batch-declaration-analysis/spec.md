## Purpose

Allows operators to obtain declaration-split evidence for several shared modules efficiently while proving that every result came from one application program and architecture baseline.

## ADDED Requirements

### Requirement: Explicit split targets are repeatable
`split-candidates --file` SHALL accept multiple occurrences while preserving the single-file form. Every target SHALL be a canonical repository-relative production source file in the selected configured application.

#### Scenario: Multiple valid files are supplied
- **WHEN** an operator repeats `--file` for several application source files
- **THEN** the system SHALL analyze each unique canonical path and emit one result per path

#### Scenario: Duplicate file is supplied
- **WHEN** the same canonical source path is supplied more than once
- **THEN** it SHALL be analyzed once and the aggregate SHALL report the deduplication

### Requirement: Hotspots can select split targets
The command and `assess` SHALL support selecting the top bounded number of eligible source hotspots from the same graph baseline. Explicit files and hotspot-driven selection SHALL be mutually exclusive unless a future schema explicitly defines their combination.

#### Scenario: Hotspot selection is requested
- **WHEN** an operator requests the top `N` split hotspots
- **THEN** the system SHALL deterministically select at most `N` analyzable production source files from the baseline hotspot ranking

#### Scenario: Conflicting selection modes are supplied
- **WHEN** explicit files and hotspot-driven selection are both supplied
- **THEN** the command SHALL reject the ambiguous invocation

### Requirement: Batch results share one analysis baseline
All files belonging to the same configured application SHALL be analyzed with one TypeScript program and the same input inventory digest, graph, source commit, config digest, graph digest, and executable identity. New batch invocations SHALL use the snapshot and replay authority defined by architecture-assessment, including all consumer and resolution inputs. The batch manifest SHALL additionally record the source hash of every requested file. A command SHALL select one configured application; targets from another application SHALL be rejected.

#### Scenario: Several files from one application are analyzed
- **WHEN** a batch contains multiple files from one configured application
- **THEN** every result SHALL identify the same program and graph baseline without rebuilding the application program per file

#### Scenario: Source changes during analysis
- **WHEN** a target file's bytes no longer match the hash captured for the batch
- **THEN** the batch SHALL fail rather than publish a mixed-baseline result

#### Scenario: Only a consumer or compiler configuration changes
- **WHEN** any consumer, referenced dependency, tsconfig, or package-resolution input changes while all selected target files remain unchanged
- **THEN** input inventory verification SHALL fail the batch before publication

### Requirement: Output names cannot collide
Each split report SHALL use a deterministic collision-safe name derived from the complete repository-relative source path, and the batch manifest SHALL map that name back to the source path.

#### Scenario: Two files share a basename
- **WHEN** two target paths end in the same filename
- **THEN** they SHALL receive distinct deterministic report paths

### Requirement: Aggregate output is bounded and actionable
The batch aggregate SHALL report per-file declaration count, split-candidate count, dominant affinities, unclassified count, cycle count, and success or failure status without requiring each detailed report to be opened.

#### Scenario: Every target succeeds
- **WHEN** all requested files are complete and qualification is qualified or allowed-empty
- **THEN** the command SHALL exit zero and publish complete reports and a batch manifest in the requested evidence directory; degraded workspace qualification SHALL instead follow the qualification matrix

#### Scenario: One target fails
- **WHEN** any requested target cannot be analyzed completely
- **THEN** the command SHALL exit nonzero, identify completed and failed paths, and SHALL NOT publish a manifest claiming the batch is complete

### Requirement: Symbol completeness is defined by diagnostics
For new batch and assessment split analysis, configuration/options/global diagnostics, syntactic diagnostics, and semantic diagnostics SHALL be collected for the entire selected application program, including consumers and referenced declaration inputs. Any TypeScript diagnostic with category `error`, failure to construct the program, missing target, unsupported analysis operation, or unresolved consumer relationship detected outside TypeScript diagnostics SHALL make requested split analysis incomplete and fatal with `SPLIT_ANALYSIS_INCOMPLETE`. Error-free warning, suggestion, and message diagnostics SHALL be preserved and may accompany complete results. An unrelated error in the selected program SHALL conservatively fail the batch; narrowing the diagnostic relevance policy is out of scope. Successfully returning a report object SHALL NOT establish completeness.

#### Scenario: Analyzer returns unresolved-import diagnostics
- **WHEN** an analyzer returns a report normally but a target or consumer has an unresolved-import error or unresolved symbol relationship
- **THEN** the batch SHALL exit 1 with incomplete status and SHALL publish no new batch or assessment bundle

#### Scenario: Warning accompanies complete analysis
- **WHEN** the selected application program has warnings or suggestions but no completeness-blocking condition
- **THEN** the report SHALL retain those diagnostics and may claim complete analysis subject to overall qualification

### Requirement: Batch output is explicit and legacy output remains compatible
One `--file` occurrence or the existing positional single-file form, without new batch options, SHALL preserve the current `WorkspaceSymbolAnalysis` JSON shape, human/stdout rendering, `--out` single-report behavior, diagnostic-return behavior, and exit semantics. No batch envelope or stricter completeness policy SHALL be silently imposed on that legacy surface.

Repeated `--file` occurrences (even if deduplicated to one target), `--split-hotspots <N>`, or `--evidence-dir` SHALL select the new batch surface. Batch mode SHALL require `--app <name>`, `--evidence-dir <path>`, and exactly one selection mode, reject `--out` and positional targets, and accept the shared `--replace-generated`, `--max-bytes <N>`, `--allow-empty`, and `--replay <bundle-directory>` controls. Supplying these batch-only controls without the required batch arguments SHALL be a usage failure, never a silently ignored legacy option. Replay SHALL accept only verified assessment bundles; standalone batch bundles SHALL be integrity-bound review artifacts without becoming an additional replay input format. `--json` SHALL emit a versioned aggregate envelope on stdout; otherwise stdout SHALL contain a human summary. Detail reports, the aggregate, input inventory, scanner reports, and a manifest SHALL be published together using the evidence-bundle contract. On fatal failure stdout/stderr SHALL identify completed and failed paths according to the selected output format, while publishing no new bundle. `assess` SHALL accept the same explicit `--file` or `--split-hotspots <N>` selectors within its single bundle, with both modes mutually exclusive; it MAY omit both to request no split analysis.

Hotspot counts SHALL be positive integers. If a valid hotspot selection yields no analyzable files, the aggregate SHALL explicitly report zero targets and the selection reason; no TypeScript program SHALL be built solely to analyze an empty target set. This empty selection SHALL follow overall qualification rather than invent a split failure. An explicitly requested missing or unanalyzable file SHALL remain fatal.

#### Scenario: Existing single-file automation is unchanged
- **WHEN** an operator invokes the existing single-file form with `--json --out <path>` and the analyzer returns semantic diagnostics
- **THEN** its JSON schema, report file, diagnostic contents, and exit behavior SHALL match the prior contract

#### Scenario: Batch output conflicts with single-report output
- **WHEN** repeated files or hotspot selection are supplied with `--out`, without `--evidence-dir`, or without `--app`
- **THEN** invocation SHALL fail before analysis or artifact writing with a stable usage diagnostic

#### Scenario: Hotspot selection is empty
- **WHEN** a valid positive hotspot count selects no analyzable production sources
- **THEN** the batch SHALL emit an explicit empty aggregate and use overall qualification for exit/publication status without claiming that declarations were analyzed
