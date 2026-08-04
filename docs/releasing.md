# Release guide

Releases are deliberately manual until the public repository, npm ownership,
and trusted-publishing relationship are established.

## One-time setup

1. Confirm the public repository URLs in `package.json` and the README badges.
2. Verify that private vulnerability reporting remains enabled.
3. Confirm that the unscoped `monocarve` package name is available to the npm
   account that will own it. Name availability alone does not establish a right
   to use a name.
4. Configure npm trusted publishing for the repository and a protected GitHub
   environment named `npm`. Do not add a long-lived npm token when trusted
   publishing is available.
5. Require the CI workflow on the default branch.

## Release checklist

1. Start from a clean default branch and review all changes since the previous
   release.
2. Choose the semantic version and update `package.json` and `src/branding.ts`
   together. The generated manifest version must match the package version.
3. Add release notes to `CHANGELOG.md` once the first release baseline exists.
4. Run the exact local gates:

   ```bash
   bun install --frozen-lockfile
   bun run check
   bun run build:bundle
   bun run verify-package
   npm pack --dry-run
   ```

5. Publish a release candidate first when package behavior or the transaction
   format changed: `npm publish --tag next --provenance`.
6. Install the published candidate in a disposable real monorepo and exercise
   read-only discovery plus `plan`. Review the plan; do not use a release smoke
   test as authorization to mutate that repository.
7. Promote the tested version with `npm dist-tag add monocarve@<version> latest`,
   then create the matching signed Git tag and GitHub release.

Never publish from a dirty checkout or bypass `prepublishOnly`. npm publishing
is an external, irreversible action; the maintainer performs it explicitly after
reviewing the packed file list and provenance.
