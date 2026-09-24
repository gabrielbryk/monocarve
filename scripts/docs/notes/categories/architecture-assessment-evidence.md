### Qualification, replay, and publication

Assessment qualification has four outcomes. `qualified` and a verified
`allowed-empty` exit 0; `degraded` exits 2 and publishes a bundle that marks
package-dependent claims unavailable; `fatal` exits 1 and publishes no new
authoritative bundle. Fatal conditions win over both the empty override and
degraded discovery. A supported positive workspace pattern with no package
manifest is degraded. Unsupported glob syntax, unsafe paths, duplicate package
identities, missing inputs, unexpected empty scanner output, drift, replay
mismatch, incomplete requested split analysis, publication conflicts, and byte
budget failures are fatal.

Executable TypeScript/ESM config for assessment, replay, and declaration batch
runs in a private Linux filesystem namespace from copied configuration inputs.
Imported helpers, package manifests, and lockfiles are copied first and bound
into the assessment input inventory. A failed read outside that copy is
refused. The boundary requires `bwrap`, `strace`, and unprivileged user
namespaces. Without them, executable config fails closed; JSON config and other
commands are unaffected. The sandbox's own `/proc`, a minimal `/dev`, and the
Bun runtime are not workspace inputs. A config that derives values from them is
nondeterministic.

The supported workspace dialect is exact paths and single-segment `*` at any
segment (for example `apps/*/ui`), plus exact negations and recursive segment
exclusions such as `!**/dist/**`. Other wildcard syntax fails with
`WORKSPACE_GLOB_UNSUPPORTED`; it is never approximated.

`assess --replay` accepts only a verified assessment directory containing its
manifest, mandatory raw scanner reports, and versioned input inventory. It
requires matching source/consumer bytes, directory membership, TypeScript
configuration/program closure, workspace/package resolution inputs, commit,
configuration, executable packaging identity, and runtime identity. Bare
`--graph` reports are intentionally refused on assessment and new batch
surfaces, while existing discovery replay remains compatible.

Bundles always retain raw reports and the input inventory. Full portfolio
evidence is optional and bounded evidence records its total, limit, omissions,
and deeper command. `--max-bytes` is a positive integer covering every final
artifact plus the manifest; mandatory replay evidence is never silently
omitted. `--replace-generated` replaces only a complete prior bundle whose
manifest and artifact hashes still match and which contains no unrelated file.

Publication owns the canonical destination exclusively and uses staged
directory renames. An ordinary caught failure restores a preserved prior
bundle where possible. Abrupt termination may leave sibling `.staging`,
`.backup`, `.recovery.json`, or `.lock` state; the next invocation fails with
`EVIDENCE_RECOVERY_REQUIRED` (or refuses uncertain ownership) and preserves
that state for manual inspection. It does not steal stale locks or perform
automatic recovery.

The destination lock protects cooperating Monocarve publishers. Processes
running as the same operating-system user that deliberately bypass this
protocol and race filesystem operations are outside the threat model. If
cleanup detects a changed owned path or unexpected quarantined contents, it
fails closed and preserves the quarantine and recovery record. Further
publication refuses with `EVIDENCE_RECOVERY_REQUIRED` until an operator
inspects and resolves that residue; the publisher does not guess which bytes
to remove or restore.

New declaration batches apply a conservative completeness rule: configuration,
options, global, syntactic, and semantic diagnostics are collected across the
whole selected application program. Any TypeScript error, missing target, or
unsupported/unresolved analyzer relationship fails with
`SPLIT_ANALYSIS_INCOMPLETE`; warnings, suggestions, and messages remain visible
without failing completeness. The legacy one-file stdout/JSON and `--out`
surface does not adopt this stricter envelope.

Assessment evidence is not a plan. It runs no gates, compiles no mutation
manifest, approves no package boundary, and changes no source or Git state.
The rich executable identity is evidence authority only: extraction plans keep
the existing behavioral compiler identity, so packaging mode does not alter
plan identity or same-build distribution/standalone interoperability.
