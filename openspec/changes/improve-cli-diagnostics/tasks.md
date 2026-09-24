## 1. Artifact and invocation errors

- [ ] Centralize manifest-family/version classification before command-specific validation.
- [ ] Add typed errors for wrong family, legacy artifact, candidate/package identifier mixup, and unsupported flag for current build.
- [ ] Add synthetic negative cases showing each error instead of a thrown `TypeError` or partial result.

## 2. Output usability

- [ ] Improve workspace-relative output-path errors without weakening containment.
- [ ] Add bounded human discovery summaries with totals, qualification, omissions, and full-output instructions.
- [ ] Reconcile identity and empty-scan presentation with the existing architecture-assessment change.

## 3. Documentation

- [ ] Keep CLI help, examples, and error suggestions consistent with actual command arguments.
