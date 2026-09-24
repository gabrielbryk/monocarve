`boundary` compiles one declared entry from `compositionBoundaries`,
`portPromotions`, `modulePromotions`, or `generatedSourceAdoptions` — see
"Boundary preparation" in the operator guide for their distinct proof
boundaries. `review` is read-only: it resolves the entry and
reports its baseline importers as discovered by a fresh dependency-graph
scan, for inspection before compiling. `compile` re-derives that same
importer set itself from the graph — it never accepts a hand-typed importer
list — and refuses `retire` outright unless the graph proves no importer of
the retained module survives. `--target <path>` is the promoted contract's
destination and is required for `strategy: "port"`; it is refused for
`existing-package`, which only rewrites specifiers. `--template <id>` names
an entry in `scaffoldTemplates.extraFiles` holding the reviewed adapter body
for a `port` boundary that declares `appAdapter` — Monocarve never
synthesizes adapter code, only renders a template a human already reviewed.
`--var key=value` (repeatable) supplies additional template substitution
values. `simulate` replays a compiled manifest in a disposable worktree
without landing it; `apply` does the same and, with `--commit`, commits the
result — matching `prepare-apply`'s exact simulate-then-commit shape.
