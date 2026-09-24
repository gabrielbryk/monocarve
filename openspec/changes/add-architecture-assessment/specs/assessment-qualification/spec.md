## Purpose

Ensures that architectural evidence is emitted only when workspace discovery, scanner output, and the executable that produced it are explicitly identifiable and trustworthy.

## ADDED Requirements

### Requirement: Supported workspace globs are enumerated completely
The system SHALL enumerate exact workspace paths and positive patterns containing single-segment `*` wildcards at any path segment, including nested forms such as `apps/*/ui`. It SHALL apply supported negated patterns, deduplicate canonical repository-relative package roots, and reject any match outside the workspace root.

#### Scenario: Nested positive glob resolves packages
- **WHEN** a workspace declares `apps/*/ui` and matching directories contain package manifests
- **THEN** every matched package SHALL appear once in deterministic name order

#### Scenario: Negation removes a nested match
- **WHEN** a supported positive pattern matches a package and a supported negated pattern excludes its canonical root
- **THEN** the package SHALL not appear in the workspace inventory

#### Scenario: Duplicate patterns converge
- **WHEN** multiple positive patterns match the same canonical package root
- **THEN** the workspace inventory SHALL contain one record for that root

#### Scenario: Unsupported syntax is explicit
- **WHEN** a workspace pattern uses syntax outside the supported dialect
- **THEN** qualification SHALL be fatal with `WORKSPACE_GLOB_UNSUPPORTED`, naming the exact pattern and supported alternatives

### Requirement: Executable identity is externally visible
Every executable and machine-readable assessment artifact SHALL expose a versioned executable identity containing the semantic version, compiler integrity digest, optional source revision, and packaging mode. Distribution artifacts produced by the same build SHALL have the same semantic version, compiler integrity, and source revision while retaining distinct packaging modes. This richer record SHALL compose the existing behavioral compiler identity without changing `CompilerBuildIdentity`, its return shape, extraction-plan provenance, canonical plan serialization, or plan validation comparisons. Packaging mode SHALL NOT become plan authority.

#### Scenario: Verbose version identifies an executable
- **WHEN** an operator runs `--version --verbose`
- **THEN** the command SHALL display the complete build identity in a stable machine-readable shape

#### Scenario: Same-version stale artifact is distinguishable
- **WHEN** two executables report the same semantic version but contain different compiler source bytes
- **THEN** their compiler integrity values SHALL differ

#### Scenario: Identity participates in evidence authority
- **WHEN** the system emits a scan, assessment summary, or evidence manifest
- **THEN** that artifact SHALL include the build identity that produced it

#### Scenario: Plan crosses same-build packaging modes
- **WHEN** a plan produced by a distribution executable is validated by the standalone executable from the same build, or the reverse
- **THEN** compiler provenance SHALL compare equal and packaging mode SHALL NOT change the plan's canonical identity

#### Scenario: Behavioral compiler changes
- **WHEN** a plan is validated by an executable whose behavioral compiler integrity differs
- **THEN** existing compiler-provenance validation SHALL still reject the plan regardless of packaging mode

### Requirement: Unexpected empty scans fail closed
Scanning a configured application SHALL fail when its source root exists and the scanner produces no production modules, unless `--allow-empty` authorizes a verified genuine absence of production files matching configured source extensions and test policy. The override SHALL NOT authorize missing roots, tsconfig exclusion of existing production files, scanner failure or inconsistent output, unsupported workspace syntax, unsafe paths, replay mismatch, or input drift. Results SHALL distinguish these cases with stable diagnostics.

#### Scenario: Existing source files produce an empty scanner graph
- **WHEN** the configured source root contains a production file with a configured source extension and the scanner returns zero modules
- **THEN** the command SHALL exit nonzero with diagnostic code `SCAN_UNEXPECTED_EMPTY_GRAPH`

#### Scenario: No configured source files exist
- **WHEN** the source root exists but contains no production files matching `sourceExtensions`
- **THEN** the command SHALL exit nonzero with a distinct stable diagnostic identifying that condition

#### Scenario: Empty application is explicitly allowed
- **WHEN** the operator supplies `--allow-empty` for an existing source root verified to contain no configured production files, with no other qualification failure
- **THEN** the command SHALL succeed and record the override in every emitted summary and manifest

#### Scenario: Empty allowance cannot conceal a scanner failure
- **WHEN** `--allow-empty` is supplied but existing production files are omitted by tsconfig or inconsistent scanner output, or the source root is missing
- **THEN** qualification SHALL remain fatal with the corresponding diagnostic

### Requirement: Qualification limits downstream claims
Qualification SHALL report workspace resolution and plan readiness independently from graph availability. A supported positive workspace pattern with no matches SHALL produce `WORKSPACE_PATTERN_UNMATCHED` and degraded qualification. Independently valid graph metrics SHALL remain available; package eligibility and plan-readiness claims SHALL be unavailable with explicit reasons. Graph metrics that themselves depend on unavailable resolution SHALL also be marked unavailable. Unsafe or ambiguous discovery SHALL remain fatal rather than be presented as a partial inventory.

#### Scenario: Graph succeeds while workspace discovery is incomplete
- **WHEN** module analysis succeeds but a supported positive workspace pattern has no matches
- **THEN** independent graph metrics SHALL remain available and package-dependent conclusions SHALL be unavailable with the qualification diagnostic

### Requirement: Qualification outcomes determine publication and exit status
For `assess` and the new explicit batch surface, the following matrix SHALL determine final status. Fatal conditions SHALL take precedence over every override and degraded condition. A qualified or degraded bundle means artifact generation and integrity verification completed; it SHALL NOT imply plan readiness or architectural approval. Existing legacy command error mappings SHALL remain unchanged; `scan` and `config-doctor` SHALL expose the same diagnostic classifications without adopting a new assessment bundle format.

| Outcome | Conditions | Exit code | Evidence publication | Permitted claims |
| --- | --- | --- | --- | --- |
| qualified | Complete inputs and analyses, including warning/suggestion/message diagnostics | 0 | Complete bundle | Available evidence with diagnostics |
| allowed-empty | Existing source root genuinely has no configured production files and `--allow-empty` is present | 0 | Complete bundle recording override | Verified zero graph metrics; no invented candidates |
| degraded | Supported positive workspace pattern has no matches; no fatal condition | 2 | Complete bundle explicitly labeled degraded | Independent graph/symbol facts only; dependent claims unavailable |
| fatal | Missing/unreadable roots or required inputs; invalid config; unsupported globs; escaping paths; duplicate package names at distinct roots; corrupt/malformed reports; unexpected empty graph; excluded production files; provenance mismatch; unbound inputs/drift; incomplete requested symbol analysis; output conflict/budget/publication failure | 1 | No new authoritative bundle; preserve prior valid bundle or documented recovery state | Stable diagnostics and available failure context only |

Unrecognized qualification failures SHALL default to fatal. Allowed-empty plus a degraded condition SHALL exit 2 with a degraded bundle and a recorded empty override. A supported unmatched pattern SHALL never conceal duplicate identities, unsafe paths, or unsupported syntax. Fatal and degraded machine-readable output SHALL include `status`, `exitCode`, diagnostic codes, and whether a bundle was published.

#### Scenario: Unsafe discovery also has an unmatched pattern
- **WHEN** discovery detects an unmatched pattern and an escaping package path or duplicate package name
- **THEN** the fatal condition SHALL win, exit code SHALL be 1, and no new bundle SHALL be published

#### Scenario: Valid graph has degraded workspace qualification
- **WHEN** the only qualification issue is `WORKSPACE_PATTERN_UNMATCHED`
- **THEN** assessment SHALL publish a degraded bundle, exit 2, and explicitly withhold package-dependent conclusions

#### Scenario: Empty allowance coexists with another failure
- **WHEN** `--allow-empty` is supplied together with replay mismatch or unsupported workspace syntax
- **THEN** the command SHALL exit 1 and publish no new authoritative bundle
