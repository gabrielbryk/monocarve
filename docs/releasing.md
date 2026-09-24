# Release guide

**Publishing is currently on hold by owner decision.** Nothing is on npm yet;
0.1.0 is unreleased. This guide documents the mechanics for when publishing
resumes — do not tag or publish without separately confirming that hold has
been lifted.

## One-time setup

1. Configure an npm **trusted publisher** for this repository
   (`.github/workflows/release.yml`) on the npm side: npm package settings →
   Trusted Publisher → GitHub Actions, pointing at this repository and the
   `release.yml` workflow. Trusted publishing uses OIDC (`id-token: write`)
   instead of a long-lived npm token; do not add one.
2. Create a protected GitHub Actions environment named `npm` on this
   repository (`Settings → Environments`). The release workflow runs its
   publish job under `environment: npm`, so this is what npm's trusted
   publisher configuration must match, and what any required-reviewer or
   branch-restriction protection rules should be attached to.
3. Confirm the unscoped `monocarve` package name is available to the npm
   account/organization that will own it. Name availability alone does not
   establish a right to use it.
4. Confirm private vulnerability reporting remains enabled
   (`Settings → Security`), matching `SECURITY.md`.
5. Require the CI workflow to pass on the default branch before a tag is
   pushed.

## Releasing

The workflow triggers on push of a `v*` tag and enforces that the tag,
`package.json#version`, and `src/branding.ts`'s `TOOL_VERSION` all agree
before it does anything else:

```bash
tag="${GITHUB_REF_NAME#v}"
pkg="$(node -p "require('./package.json').version")"
tool="$(sed -n 's/^export const TOOL_VERSION = "\(.*\)" as const;$/\1/p' src/branding.ts)"
test "$tag" = "$pkg" && test "$pkg" = "$tool"
```

So the release checklist is:

1. Start from a clean default branch and review everything since the
   previous release.
2. Choose the semantic version and bump it in **both**
   `package.json#version` and `TOOL_VERSION` in `src/branding.ts` — the
   workflow refuses to publish if they disagree with each other or with the
   tag.
3. Date the `CHANGELOG.md` heading for the release (it currently reads
   `## 0.1.0 — unreleased`; replace `unreleased` with the release date).
4. Run the exact gates the workflow runs, locally, before tagging:

   ```bash
   bun install --frozen-lockfile
   bun run check          # typecheck + full test suite + quality ratchet
   bun run build:bundle
   bun run verify-package
   ```

5. Commit the version bump and changelog date on the default branch.
6. Create and push a **signed** tag matching the version exactly:

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

7. Pushing the tag triggers `.github/workflows/release.yml`, which:
   - checks out the tag and sets up Bun and Node 24 with the npm registry
     configured;
   - requires an npm CLI new enough for trusted publishing
     (`npm install -g npm@^11.5.1`);
   - verifies the tag/`package.json`/`TOOL_VERSION` agreement above;
   - installs `bubblewrap` and `strace` and smoke-tests the assessment
     sandbox (`bwrap --unshare-all --ro-bind / / true`), since
     `bun run check` exercises executable-config assessment tests;
   - runs `bun install --frozen-lockfile`, `bun run check`,
     `bun run build:bundle`, and `bun run verify-package` again in CI;
   - publishes with `npm publish --provenance --access public`, using the
     `npm` environment's trusted-publisher OIDC token — no token is stored
     in the repository or in secrets.

There is no separate `next`-tag/dist-tag promotion step in the current
workflow: a pushed `vX.Y.Z` tag publishes straight to `latest`. If a staged
rollout is wanted later, that is a workflow change, not something the
current release process does implicitly.

Never push a release tag from a dirty checkout, and never bypass the gates
above locally "because CI will catch it" — CI runs the same gates, but a
local failure caught before tagging is cheaper to fix than a failed publish
job on a tag that already exists.
