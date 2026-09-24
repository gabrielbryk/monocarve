## 1. Reconcile current behavior

- [ ] Trace each historical failure family through current planner, adapter, and audit code; mark fixed, reproducible, or workspace-specific.
- [ ] Build synthetic reproductions for remaining target layout, import, consumer, scaffold, and lockfile defects before changing behavior.

## 2. Explicit move set

- [ ] Define reviewed source-set input and exact target layout output.
- [ ] Reuse candidate safety rules and require explicit acceptance of closure expansion.
- [ ] Add negative cases for protected files, omitted closure members, and ambiguous destinations.

## 3. Wiring completeness

- [ ] Validate moved relative imports, package self-imports, test consumers, exports, references, and importer operations before approval.
- [ ] Return specific unsupported/fixable diagnostics without filling adapter stubs with partial data.
- [ ] Add negative cases for each claimed proof, then document what still requires simulation and repository gates.
