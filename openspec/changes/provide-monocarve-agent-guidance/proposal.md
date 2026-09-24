## Why

Agents repeatedly had to discover the CLI, construct workspace configuration, interpret candidate IDs and plan states, and recover from predictable readiness errors. A reusable plugin can guide them through assessment, manual moves, and transactional extraction without hiding the costs or overstating proof.

## What Changes

- Package source-owned agent skills as a distributable plugin, with one entrypoint that chooses assessment, in-place, or transactional workflow.
- Provide focused skills for workspace setup/readiness, boundary assessment, in-place extraction, transactional extraction, and diagnosis/recovery.
- Keep command examples version-aware and prefer the installed executable identified by the plugin; stop on suspicious empty scans and source/build mismatch.
- Teach evidence labels, one-pass apply, exact manifest approval, and safe recovery. Keep user authorization and project instructions authoritative.

## Capabilities

### New Capabilities

- `agent-guidance-plugin`: Installable, source-owned skills for using the CLI with appropriate workflow and proof boundaries.

### Modified Capabilities

None.

## Impact

Plugin packaging, skill documents, CLI identity/readiness integration, and installation documentation. The plugin has no privileged bypass of CLI safeguards and contains only synthetic examples.
