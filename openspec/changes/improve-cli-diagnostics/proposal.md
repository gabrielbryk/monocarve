## Why

Sessions lost time discovering the correct executable, using flags from another build, decoding large JSON reports, and passing a preparer or legacy manifest to a command that expects an extraction manifest. Some errors were unhandled exceptions or gave no practical next action. Public CLI diagnostics should make these mistakes cheap to identify.

## What Changes

- Report supported command and build identity in a compact discoverable form, coordinated with the existing architecture-assessment identity change.
- Validate manifest family and schema before command-specific access, returning typed usage errors rather than exceptions.
- Make path-containment errors and candidate-selection mistakes name accepted inputs and a valid next action.
- Add concise human summaries and bounded JSON output guidance for large discovery reports.

## Capabilities

### New Capabilities

- `cli-diagnostic-quality`: Actionable, typed diagnostics for common invocation and artifact mistakes.

### Modified Capabilities

None.

## Impact

CLI parser and error rendering, manifest dispatch, discovery presentation, documentation, and synthetic negative examples. This change does not relax output path containment or duplicate the existing assessment qualification proposal.
