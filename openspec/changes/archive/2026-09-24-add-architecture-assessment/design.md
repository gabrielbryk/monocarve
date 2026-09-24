## Context

See `proposal.md` for motivation. Discovery commands currently load their own graph and shape their own reports. Raw scanner reports can be replayed, but the graph loader does not return the reports it captured. Split analysis builds a TypeScript program per invocation. Output writing is atomic per file and confined to the workspace, but there is no multi-artifact publication authority.

Build provenance already includes compiler source integrity and an optional source revision. Portfolio configuration already models composition roots, protected paths, retained roots, generic target segments, and review-size limits. The change must extend these foundations rather than create parallel identity or architecture-policy systems.

## Goals / Non-Goals

**Goals:**

- Establish one qualified, immutable assessment snapshot from which every report is derived.
- Make evidence compact by default while preserving explicit paths to deeper reports.
- Preserve the current workspace output boundary and deterministic serialization discipline.
- Make multi-file split analysis fast enough for hotspot review by sharing the TypeScript program.
- Keep failures machine-readable and capable of proving that misleading evidence was not published.

**Non-Goals:**

- Inferring bounded contexts, approving package ownership, or converting recommendations into plans.
- Adding deletion policy, retained-application aliases, forbidden package-name policy, or general graph comparison.
- Changing extraction manifests, plan hashes, transaction execution, or audit authority.
- Supporting arbitrary filesystem output destinations or every glob syntax accepted by every package manager.

## Decisions

### 1. Capture an assessment snapshot instead of composing CLI commands

Introduce an internal assessment snapshot containing loaded config, qualification, canonical analytical arguments, captured scanner reports, a versioned input inventory, graph, workspace context, portfolio, and all shared digests. Reports alone are insufficient: graph construction reads source/package facts, and declaration affinities depend on consumer files. The scanner adapter will expose captured reports together with the input authority observed during scanning. `assess` will call analyzers directly against this snapshot.

This avoids repeated scans and mixed in-process cache results. Calling existing CLI commands as subprocesses was rejected because each command independently discovers config and loads or scans a graph, and stdout schemas are presentation contracts rather than an internal composition API.

The input inventory binds canonical paths, content hashes, relevant directory entries, symlink identities, and absence probes across application/first-party source trees, graph tests and symbol consumers, the complete TypeScript program and configuration closure, loaded configuration dependencies, scanner configuration, workspace declarations, package manifests/exports, lockfiles, and consulted installed resolution/declaration inputs. External inputs use stable dependency-relative namespaces rather than machine-specific absolute paths. Tool/runtime and scanner/TypeScript dependency versions are recorded. A commit and dirty flag supplement this inventory and cannot substitute for it.

Capture the inventory before the live scan, verify it after scanning, before each dependent analysis, and just before publication. Use captured bytes for internal source/program reads and verify the scanner's observed input bytes against the same authority. If a resolver discovers an input not covered by the initial inventory, verify its captured state before accepting any result or fail with an unbound-input diagnostic; never assign it an earlier baseline without evidence. Directory membership verification detects additions/deletions. Changed or unverifiable inputs fail closed without a hidden rescan. This requires scanner/resolver read observation or an equivalent immutable read interface; a pair of HEAD checks or target-only hashes is not an adequate implementation. Scope graph, syntax, workspace, and resolution caches to this snapshot, bypassing older facts.

`assess --replay <bundle-directory>` and new batch replay accept only a complete verified assessment bundle containing the manifest, raw reports, and input inventory. Verify artifact integrity and exact current input/config/commit/executable/runtime authority before graph construction; no live scan fallback is allowed. Record capture identity separately from replay invocation provenance. Bare legacy `--graph` input is refused on these new surfaces with `ASSESSMENT_REPLAY_PROVENANCE_REQUIRED`; existing discovery commands retain legacy replay. Replay reproduces evidence against matching source/dependency bytes, not a source-free portable analysis. Packaging identity must match for assessment replay even though plan validation deliberately ignores packaging.

Reject output and operational paths overlapping an analytical input/discovery root. Exclude only validated evidence/operational paths from inventory and input-scoped dirty state, so replacing an unchanged bundle does not change source authority. Canonical analytical arguments omit publication-only flags and destinations. Live and replay modes retain distinct provenance; determinism is asserted within each mode and common metric equivalence across modes.

### 2. Compose executable identity without changing plan authority

Keep `CompilerBuildIdentity` and `compilerBuildIdentity()` exactly as the existing behavioral record: compiler integrity and optional source revision. Add a separate versioned assessment executable identity that composes that record with semantic version and packaging mode. Stamp `dist-source` and `standalone-bun` explicitly; direct source execution reports `source`. Plan provenance continues to store and compare only the unchanged behavioral record. No new schema, packaging field, projection ambiguity, or legacy-manifest migration enters extraction plans. Test same-build dist/standalone plan interchange in both directions and rejection when behavioral integrity differs.

No wall-clock build timestamp will be added. It would make otherwise identical builds and evidence differ. Where a source-bound time is useful, the report will use the baseline commit's committer date. This preserves the repository's determinism rule.

Executable configuration requires a pre-config authority phase. The current assessment loads the config before its values define inventory roots, so the ordinary config-driven inventory cannot prove the bytes that config execution read. The approved boundary retains TS/ESM execution for assessment, replay, and declaration batch, but permits filesystem reads only from immutable captured workspace/dependency inputs; other commands keep the ordinary loader. The pre-config capture must bind every file and directory exposed to config execution into the final input inventory, including module and resolver inputs, and refuse access outside that capture. A read-only bind of the live checkout, static import inspection, or a VM is not sufficient: none proves indirect runtime reads against change-and-restore. The implementation copies the capture into a private image and runs the config under `bwrap` with no network, no host home or `/tmp`, and a private scratch directory. `strace` refuses any failed out-of-set read after execution starts. Scope decision (2026-09-24): the boundary covers workspace, dependency, and host _files_. The sandbox-private `/proc` (its own PID namespace), the minimal `/dev` from `bwrap --dev`, the unmounted `/sys` (failed runtime probes there reveal nothing), and the trusted runtime binary and libraries are out of scope. A config that reads them is nondeterministic by construction, which is the config author's responsibility, not an authority breach over repository inputs.

The in-process graph cache key will include behavioral compiler identity. Assessment additionally scopes all reused facts to its input inventory digest and records executable/runtime identity and whether live scanning, replay, or an explicitly allowed empty graph supplied its inputs.

### 3. Use one shared segment-glob engine for discovery and coverage

The existing shared workspace-glob module will parse a deliberately bounded dialect: exact relative paths, `*` as one directory segment at any position, and the already-supported negation forms. Enumeration will walk only the literal and wildcard segments required by the pattern, canonicalize matches under the workspace root, read package manifests only at complete matches, apply exclusions, deduplicate roots, validate duplicate package names, and sort by code unit.

The same matcher will power `globCoversPackage`; enumeration and scaffolding therefore cannot disagree about whether a package already belongs to the workspace. Supported unmatched positive patterns produce degraded qualification; unsafe paths, duplicate package identities, malformed required inputs, and unsupported syntax are fatal. These are distinct outcomes, not one caught exception rendered as a partial inventory.

Adding a general glob dependency was rejected: the supported workspace dialect is small, path containment is security-sensitive, and matching must have identical semantics in enumeration and coverage checks.

### 4. Separate normalized facts from presentation

A versioned `ArchitectureSummary` will contain source/build identity, qualification, graph facts, and candidate totals. Layers, hotspots, backlog, and split aggregates remain dedicated typed reports referencing the same snapshot identity. Human and JSON output will be rendered from these records; Markdown will not independently recompute metrics.

Unavailable fields will use a discriminated result carrying diagnostics instead of unexplained `null` or omission. Stable diagnostics will contain at least code, severity, message, impact, and relevant paths or patterns. CLI error rendering may remain text by default, but `--json` will serialize stable diagnostics for qualification failures.

The qualification capability's outcome matrix is authoritative for `assess` and new batches: qualified and genuinely allowed-empty exit 0 with complete bundles; supported unmatched workspace patterns exit 2 with explicitly degraded bundles; fatal conditions exit 1 without a new authoritative bundle. Fatal wins over degraded and override outcomes. Degraded bundles retain only independently valid graph/symbol claims and make package-dependent conclusions unavailable. The empty override applies solely to an existing root with no configured production files; missing roots, omitted existing files, bad scanner output, unsafe discovery, and replay/drift failures cannot be overridden. Existing legacy command exit mappings and report formats remain intact.

### 5. Publish bundles through a staged directory transaction

The evidence writer will require a workspace-relative non-root target and resolve existing ancestors to prevent symlink escape. It will render all required artifacts into a sibling staging directory, enforce per-report limits and the total byte budget, compute hashes, and write the manifest last inside staging.

Hold an exclusive lock keyed by canonical destination from validation through publication/cleanup. This lock serializes cooperative invocations of this publisher; it is not an access-control boundary against hostile same-UID processes deliberately bypassing the protocol. A concurrent cooperative writer fails without touching the first writer's files. Validate prior manifest schema/tool identity, confined unique bundle-relative paths, artifact hashes, target identity, and ancestor confinement under ownership, then revalidate before replacement. For a new or empty destination, rename staging into place. For `--replace-generated`, move the old directory to a recoverable sibling, rename staging into place, and restore the old directory on a caught publication failure.

Directory replacement promises whole-bundle visibility, not continuous target availability: the target can be absent between renames. Record staged, prior-preserved, and new-published transitions durably before destructive transition/cleanup. On uncatchable termination, preserve owned staging/backup/recovery records; a subsequent invocation refuses with `EVIDENCE_RECOVERY_REQUIRED` and explicit paths/state. Cleanup removes only residue whose identity, bytes, and expected contents still prove publisher ownership. Any foreign replacement, unexpected child, changed owner record, pre-existing quarantine, or otherwise uncertain residue is preserved for operator recovery, even when that leaves the destination unavailable; subsequent publication refuses with `EVIDENCE_RECOVERY_REQUIRED` without altering the suspicious residue. Never steal uncertain locks or automatically delete recovery artifacts. A recovery record can lag a completed rename; filesystem identities and artifact hashes must distinguish both sides without trusting the phase alone. No automatic crash-recovery command is in scope. Successful operations clean owned siblings; crash or suspicious residue is an explicit exception to the final evidence-directory-only filesystem guarantee. Temporary names never enter final bundle bytes.

The manifest will not list or hash itself, avoiding a recursive self-hash. It is authoritative because it binds every other artifact and is published only with the complete staged directory.

Per-file atomic writes without a directory transaction were rejected because interruption could combine a new artifact with an old authoritative manifest or vice versa.

### 6. Bound full-fidelity evidence explicitly

The default bundle includes the normalized summary, mandatory raw scanner reports and input inventory, layers, bounded hotspots, bounded portfolio summary, bounded backlog, requested splits, and Markdown findings. Full candidate bodies and full ranked portfolios require explicit flags. Every bounded artifact carries totals, limits, and omission instructions.

Raw reports and input inventory jointly bind replay authority and cannot be omitted. There is no raw omission or compression option in this change. `--max-bytes <N>` is a positive-integer optional budget over all final bundle bytes, including its manifest. Fail before publication and identify the largest artifacts; suggest omitting only optional full reports or increasing the budget. Budget and destination are publication controls, not analytical identity.

### 7. Reuse one TypeScript program for a declaration batch

Refactor workspace symbol analysis so program construction is separate from per-file analysis. Each new command invocation selects one configured application, rejects cross-application targets, and reuses one captured TypeScript program across canonical sorted targets. The program's entire source/configuration/resolution closure belongs to snapshot authority; target hashes are convenient additional evidence. Hotspot selection uses the captured ranking and never starts another scan.

Sequential analysis is the initial behavior. Collect configuration/options/global, syntactic, and semantic diagnostics across the whole program, including consumers/declarations. Any TypeScript error or an unresolved relationship/unsupported operation detected by the analyzer makes requested analysis incomplete and fatal; warnings, suggestions, and messages remain visible but do not prevent completeness. This conservative policy intentionally rejects unrelated errors within the selected program. An analyzer returning an object does not prove completeness. Failure emits completed/failed paths but publishes no new assessment or batch bundle.

Preserve legacy single-file/positional `split-candidates` JSON, `--out`, and diagnostic/exit behavior when no batch options are supplied. Repeated `--file` occurrences, `--split-hotspots <N>`, or `--evidence-dir` explicitly select batch mode, even if deduplication leaves one target. Batch mode requires `--app` and `--evidence-dir`, rejects `--out`/positional targets, and shares replacement, budget, empty, and replay controls with assessment. It prints a versioned aggregate with `--json` or a human summary otherwise, and publishes detailed reports plus aggregate, scanner reports, input inventory, and manifest atomically. Assessment uses the same mutually exclusive file/hotspot selectors in its own bundle. Replay initially accepts assessment bundles; standalone batch bundles are integrity-bound review artifacts, not a new replay input format.

### 8. Keep architecture policy and graph comparison separate

The assessment report consumes existing portfolio classifications without changing their authority. Policy additions would change candidate classification and deserve their own delta. General comparison depends on the finalized assessment schema and manifest, so it follows this change and initially should compare assessment manifests rather than reconstruct historical graphs from raw reports against current source files.

## Risks / Trade-offs

- **[Directory replacement is more complex than per-file writes]** → Keep publication in one focused evidence-writer module; test competing writers, thrown failures, process death at each rename boundary, uncertain lock ownership, and preservation of recovery state.
- **[Raw scanner reports can dominate bundle size]** → Make size visible in the manifest, enforce an optional total budget, and retain an explicit future path to deterministic compression.
- **[Glob semantics may drift from a package manager]** → Document the supported dialect, test it against synthetic manifests, and fail unsupported syntax instead of silently approximating it.
- **[Capturing scanner and resolver input reads is substantial integration work]** → Prove the read-observation or immutable-input boundary first. Include all consumers/configuration/package/dependency inputs and directory membership; fail unbound reads. Hashing split targets or recording Git state alone cannot satisfy this change.
- **[Rich identity could leak into plan serialization]** → Keep the behavioral API unchanged; add tests proving rich fields never enter plan authority and same-build packaging modes interoperate while changed integrity fails.
- **[Program-wide errors reduce available split evidence]** → Document the conservative completeness policy; assessment without requested splits can still produce independently qualified graph evidence. A narrower error-relevance policy is deferred.
- **[One application program can consume substantial memory]** → Process targets sequentially and release per-application programs after their batch; assessment remains bounded by configured split count.

## Migration Plan

1. Add qualification and identity fields while retaining the existing non-verbose `--version` text.
2. Add the normalized summary and snapshot API, then route existing `scan` summary fields through the shared record without removing documented fields in the same change.
3. Add evidence publication and `assess` behind its new command surface.
4. Add batch split selection and integrate it into assessment.
5. Update CLI reference and operator guidance, then run typecheck, focused negative tests, the full test suite, quality checks, and CLI help verification.

Rollback consists of removing the new command and additive assessment schemas. Existing assessment evidence and any owned interruption-recovery artifacts remain available to operators and must not be deleted as rollback cleanup. No source, extraction-plan, or transaction-state migration is required; the new recovery records belong only to assessment publication.
