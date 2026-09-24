Run `monocarve plan-review --plan <path>` before approval for a human-readable
review of target mode, exact top-level and nested move targets, operation counts,
dependency and consumer wiring, public exports, generated outputs, repository
gates, warnings, and the pre-existing boundary violations recorded with the plan
(see _Reviewed boundary baseline_ under Extraction execution). Add `--json` for its stable structured form. The approval
section records the manifest path and defaults its subject to `commits.plan`;
`--approval-subject` supplies a different exact proposed subject for review.
