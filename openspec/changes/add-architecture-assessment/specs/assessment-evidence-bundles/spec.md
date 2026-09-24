## Purpose

Defines a safe, manifest-authoritative directory format for reviewing, reproducing, replacing, and transporting the artifacts of one architecture assessment.

## ADDED Requirements

### Requirement: Evidence publication is confined and atomic
`--evidence-dir` SHALL accept only a non-root workspace-relative directory that does not escape through path traversal or symlinks or overlap analytical inputs/discovery roots. The system SHALL stage and validate a complete bundle before making its manifest authoritative, and a fatal assessment SHALL NOT leave a valid-looking mixed-baseline bundle. These publication rules SHALL also apply to standalone split batches. A degraded assessment may publish only as specified by the qualification matrix.

#### Scenario: Evidence path escapes the workspace
- **WHEN** the requested evidence directory resolves outside the workspace or through an escaping symlink
- **THEN** assessment SHALL fail before writing any artifact

#### Scenario: Artifact generation fails
- **WHEN** any required artifact cannot be generated or validated
- **THEN** no new authoritative manifest SHALL be published at the target directory

### Requirement: Manifest binds the complete bundle
The evidence manifest SHALL identify its schema version, tool identity, canonical analytical arguments, source commit and input-scoped dirty state, input inventory digest, config digest, graph digest, executable/runtime identity, capture/replay provenance, qualification status and diagnostics, explicit overrides, and every generated artifact other than the manifest itself. Each artifact record SHALL contain a canonical bundle-relative path, byte size, and SHA-256 digest. Artifact paths SHALL be unique, confined beneath the bundle, and neither symlinks nor absolute/traversing paths. The input inventory SHALL separately identify repository-relative inputs and explicitly namespaced external dependency inputs. Publication-only options such as `--replace-generated`, `--max-bytes`, and destination paths SHALL NOT enter analytical arguments; analytical limits and selectors SHALL enter them. Effective byte-budget enforcement SHALL remain observable in command output.

#### Scenario: Bundle integrity is checked
- **WHEN** a consumer recomputes each listed artifact digest
- **THEN** every digest SHALL match the bytes covered by the manifest

#### Scenario: Optional evidence is omitted
- **WHEN** a potentially large artifact was not requested
- **THEN** the manifest SHALL identify the omitted evidence kind, reason, and reproducible command that would generate it

### Requirement: Existing contents are protected
Assessment SHALL refuse a nonempty evidence directory unless `--replace-generated` is supplied. Replacement SHALL remove or replace only the valid prior manifest itself and paths listed by that manifest from the same tool, and SHALL refuse any collision with an unrelated path.

#### Scenario: Unrelated file exists
- **WHEN** the target directory contains a file not owned by its prior valid manifest
- **THEN** assessment SHALL refuse replacement and leave the directory unchanged

#### Scenario: Prior generated bundle is replaced
- **WHEN** `--replace-generated` targets a directory whose contents agree with its prior manifest and contain no unrelated collisions
- **THEN** assessment SHALL publish the new complete bundle without retaining stale generated artifacts

#### Scenario: Prior manifest does not match disk
- **WHEN** a listed prior artifact has been modified or is missing
- **THEN** assessment SHALL refuse replacement and report the mismatched path

### Requirement: Publication serializes writers and exposes interruption recovery
Writers SHALL hold exclusive ownership of the canonical destination before prior-bundle validation through publication and cleanup. This lock coordinates cooperative invocations of this publisher; it SHALL NOT be described as preventing arbitrary processes with parent-directory write access from changing files. A concurrent cooperative writer SHALL fail with `EVIDENCE_DESTINATION_BUSY` without modifying the destination or the first writer's staging/recovery files. Existing target identity, ancestor confinement, and prior artifact hashes SHALL be revalidated before replacement. A stale or uncertain ownership record SHALL not be silently stolen.

Publication SHALL expose only a whole prior or whole new bundle; replacement may briefly leave the target absent between directory renames. An exception after moving the prior directory SHALL restore it before returning whenever restoration is possible. Uncatchable termination may leave owned sibling staging/backup/recovery records; the next invocation SHALL fail with `EVIDENCE_RECOVERY_REQUIRED`, name the recorded paths and recovery state, and preserve them for explicit operator recovery. It SHALL NOT infer that an absent destination authorizes a new publication or delete uncertain state. Cleanup SHALL remove residue only when identity, bytes, and expected contents establish publisher ownership; foreign replacements, unexpected children, changed owner/recovery contents, pre-existing quarantine entries, and other ambiguous residue SHALL remain untouched for operator recovery. The recovery record SHALL distinguish a prepared stage, preserved prior bundle, and published new bundle. Successful completion SHALL remove owned operational residue; abrupt interruption is the documented exception to final evidence-directory-only filesystem changes. No automatic crash recovery or unrelated cleanup command is introduced by this change.

#### Scenario: Two writers target one bundle
- **WHEN** a second writer reaches a destination whose canonical publication ownership is held
- **THEN** it SHALL exit 1 with `EVIDENCE_DESTINATION_BUSY` and leave both the target and first writer's operational files unchanged

#### Scenario: Outside process changes recovery bytes during caught rollback
- **WHEN** the recovery path retains its inode but its bytes no longer match any publisher-written phase record
- **THEN** rollback SHALL preserve that recovery entry, and a later publication SHALL require explicit operator recovery

#### Scenario: Cleanup finds unexpected quarantined residue
- **WHEN** cleanup finds a foreign replacement or an unexpected child after moving an owned entry to quarantine
- **THEN** publication SHALL fail closed, preserve the quarantine and recovery state, and a subsequent invocation SHALL refuse with `EVIDENCE_RECOVERY_REQUIRED` without modifying the suspicious residue

#### Scenario: Publication throws after preserving the prior bundle
- **WHEN** an injected error occurs after the old directory is moved aside but before the new directory is published
- **THEN** the old directory SHALL be restored byte-for-byte and no new authoritative bundle SHALL be exposed

#### Scenario: Process terminates at a rename boundary
- **WHEN** the process terminates after staging, after moving the old directory, or after publishing the new directory but before cleanup
- **THEN** the target SHALL contain only a complete old bundle, a complete new bundle, or no bundle; recovery records SHALL preserve the relevant complete artifacts and the next invocation SHALL refuse with `EVIDENCE_RECOVERY_REQUIRED`

#### Scenario: Prior manifest attempts to own an external path
- **WHEN** a prior manifest lists a traversing, absolute, duplicate, or symlink artifact path
- **THEN** replacement SHALL refuse before moving or deleting any path

### Requirement: Bundle size is enforced before publication
The operator MAY configure a maximum total byte budget using `--max-bytes <N>`, where N is a positive integer. The system SHALL calculate the staged total including the final manifest before publication and SHALL fail with artifact-level size evidence when the budget is exceeded. Raw scanner reports and the verified input inventory SHALL be mandatory, default replay evidence; neither SHALL be silently omitted to meet a budget. This change SHALL NOT provide a raw-report omission or compression option.

#### Scenario: Required raw report exceeds the budget
- **WHEN** the staged bundle is larger than the configured byte budget
- **THEN** assessment SHALL publish no new bundle, identify the largest artifacts, and suggest increasing the budget or omitting only explicitly optional full reports; if required artifacts alone exceed the budget it SHALL say that omission cannot satisfy it

### Requirement: Bundle inventory is deterministic
Artifact paths, manifest ordering, JSON serialization, Markdown rendering, and hashes SHALL be deterministic. Temporary names and process identifiers MUST NOT appear in final artifact contents or paths.

#### Scenario: Same bundle is regenerated
- **WHEN** two assessments have identical authoritative inputs and output options
- **THEN** their final artifact inventory, bytes, sizes, and hashes SHALL match
