/** Integration proofs against the installed pnpm binary. */

import { afterEach, describe, expect, test } from "bun:test";

import { LockfileError, pnpmAdapter } from "../src/adapters/pnpm.ts";
import { verifyLockfile } from "../src/transaction/lockfile-verify.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { cleanupFixtures, read, scratchDirectory, write } from "./support/fixture-repo.ts";
import {
  MIS_SORTED_SPLICE,
  ORACLE_BLIND_SPOT,
  SHAPES,
  checkShape,
  describeResult,
  frozenLockfileFailure,
} from "./support/lockfile-shapes.ts";
import {
  APP,
  LOCKFILE,
  PACKAGE_ROOT,
  PNPM,
  landExtraction,
  packageManifest,
  pnpmWorkspace,
  runPnpm,
  simulationFixture,
  verify,
} from "./support/lockfile-verify-fixture.ts";

describe("lockfile verification against real pnpm", () => {
  afterEach(cleanupFixtures);

  test.skipIf(PNPM === null)(
    "the splice is byte-identical to pnpm's own output when every neighbouring importer is a block",
    () => {
      const shape = { siblingDependencies: true, consumerDependencies: true };
      const root = pnpmWorkspace(shape);
      landExtraction(root, shape);

      const result = verify(root, pnpmAdapter.lockfileOnlyCommand());

      expect(result.differences).toBeUndefined();
      expect(result.ok).toBe(true);
    },
    120_000,
  );

  test.skipIf(PNPM === null)(
    "the splice is byte-identical when the importers that sort after the new package are inline",
    () => {
      const shape = { siblingDependencies: false, consumerDependencies: true };
      const root = pnpmWorkspace(shape);
      // pnpm wrote `  libs/format: {}` and `  libs/logger: {}`. While
      // `parseImporters` matched only `  <dir>:`, neither was an entry, so the
      // new block was appended past both and the next install sorted it back.
      expect(read(root, LOCKFILE)).toContain("  libs/format: {}");
      const baseline = read(root, LOCKFILE);
      expect(pnpmAdapter.importerBlock(baseline, "libs/format")).toBe("  libs/format: {}\n\n");

      landExtraction(root, shape);
      // The sorted position is between the consumer and the inline siblings.
      const spliced = read(root, LOCKFILE);
      expect(spliced.indexOf(`  ${APP}:`)).toBeLessThan(spliced.indexOf(`  ${PACKAGE_ROOT}:`));
      expect(spliced.indexOf(`  ${PACKAGE_ROOT}:`)).toBeLessThan(spliced.indexOf("  libs/format: {}"));

      const result = verify(root, pnpmAdapter.lockfileOnlyCommand());

      expect(result.differences).toBeUndefined();
      expect(result.ok).toBe(true);
    },
    120_000,
  );

  test.skipIf(PNPM === null)(
    "the splice is byte-identical when the consumer is inline and the new package declares nothing",
    () => {
      const shape = { siblingDependencies: false, consumerDependencies: false };
      const root = pnpmWorkspace(shape);
      const baseline = read(root, LOCKFILE);
      // The consuming application declares nothing, so pnpm wrote *its* importer
      // inline too. This is the case that used to emit no lockfile operation at
      // all: `importerBlock` returned undefined and the wiring skipped silently.
      expect(baseline).toContain(`  ${APP}: {}`);
      expect(pnpmAdapter.importerBlock(baseline, APP)).toBe(`  ${APP}: {}\n\n`);
      // The workspace root is inline as well, and must not be special-cased away.
      expect(pnpmAdapter.importerBlock(baseline, ".")).toBe("  .: {}\n\n");

      landExtraction(root, shape);
      const spliced = read(root, LOCKFILE);
      // The consumer's inline importer expanded to carry the new dependency, and
      // the new package, declaring nothing, is inline exactly as pnpm writes one.
      expect(spliced).toContain(`        version: link:../../${PACKAGE_ROOT}`);
      expect(spliced).toContain(`  ${PACKAGE_ROOT}: {}`);

      const result = verify(root, pnpmAdapter.lockfileOnlyCommand());

      expect(result.differences).toBeUndefined();
      expect(result.ok).toBe(true);
    },
    120_000,
  );

  test.skipIf(PNPM === null)(
    "simulation rejects manifest and importer divergence without waiting for an opt-in round-trip",
    async () => {
      const { config, manifest, root } = simulationFixture(
        { siblingDependencies: false, consumerDependencies: true },
        { overDeclare: true },
      );

      // The independent projection compares the landed package manifest to the
      // importer, so this former blind spot is now rejected even without asking
      // the package manager to serialize the lockfile.
      const unflagged = await simulatePlan({ config, rootDir: root, manifest });
      expect(unflagged.ok).toBe(false);
      expect(unflagged.lockfileVerification).toBeUndefined();
      expect(unflagged.projectedImporterVerification?.ok).toBe(false);
      expect(unflagged.failure).toContain("repository postconditions failed");
      expect(unflagged.failure).toContain("package.json dependency sections do not match the projected lockfile importer");
      expect(unflagged.gates).toEqual([]);
      const applied = await applyPlan({ config, rootDir: root, manifest });
      expect(applied.ok).toBeFalse();
      expect(applied.repositoryPostconditions).toMatchObject({ passed: false });
    },
    180_000,
  );

  test.skipIf(PNPM === null)(
    "the flag passes the simulation when the splice really is what pnpm writes",
    async () => {
      const { config, manifest, root } = simulationFixture({
        siblingDependencies: false,
        consumerDependencies: false,
      });

      const result = await simulatePlan({ config, rootDir: root, manifest, verifyLockfile: true });

      expect(result.failure).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.lockfileVerification?.ok).toBe(true);
    },
    180_000,
  );
});

/**
 * The same question as the three cases above, asked as a property.
 *
 * Those cases each hand-build one workspace. `SHAPES` describes workspaces in
 * the terms that change what pnpm serializes and enumerates them, so a splice
 * that happens to be right for a three-package repository with lowercase
 * directory names is no longer evidence that it is right at all. Every entry
 * runs the whole loop — build, let pnpm write the baseline, splice, let pnpm
 * write it again — and compares the two by sha256 of the bytes.
 *
 * Two matrix entries are expected *not* to match, which is what makes the rest
 * mean something: `harness-notices-an-over-declared-block` corrupts a splice
 * the whole pipeline would otherwise call green, and
 * `harness-notices-a-bare-key-instead-of-an-empty-map` asks pnpm whether a bare
 * importer key really is rewritten to `{}`, which is a claim the renderer makes
 * in a comment. Four more expect a refusal. A harness that returned `matched`
 * unconditionally fails all six.
 *
 * The three cases after the matrix are about the oracle rather than the splice:
 * one shows `--lockfile-only` moves a block that landed in the wrong place —
 * without which every sorting shape above would be comparing two files nobody
 * rewrites — and two are about the state it cannot see at all, which the
 * adapter's own completeness check now covers on both sides (it fails the
 * lockfile pnpm refuses to install, and it passes every lockfile pnpm wrote).
 */
describe("the splice against real pnpm, over generated workspace shapes", () => {
  afterEach(cleanupFixtures);

  // Runs without pnpm, and guards the matrix rather than the splicer: a matrix
  // that lost its negative cases would still report every shape green.
  test("the matrix keeps the cases that can fail", () => {
    expect(new Set(SHAPES.map((shape) => shape.id)).size).toBe(SHAPES.length);
    expect(SHAPES.filter((shape) => shape.expect === "diverge").length).toBeGreaterThanOrEqual(2);
    expect(SHAPES.filter((shape) => shape.expect === "throw").length).toBeGreaterThanOrEqual(4);
    for (const shape of SHAPES) {
      if (shape.expect === "throw") expect(shape.throwMessage).toBeDefined();
      if (shape.expect === "diverge") {
        expect((shape.plannedOnly?.length ?? 0) + (shape.regeneratedOnly?.length ?? 0)).toBeGreaterThan(0);
      }
    }
  });

  for (const shape of SHAPES) {
    test.skipIf(PNPM === null)(
      `${shape.id} — ${shape.why}`,
      () => {
        const result = checkShape(shape);
        // The report is the assertion's *actual* value, so a failure prints the
        // differing bytes on both sides instead of `false !== true`.
        const report = describeResult(shape, result);

        if (shape.expect === "throw") {
          expect(result.kind === "threw" ? "threw" : report).toBe("threw");
          if (result.kind !== "threw") return;
          expect(result.error).toBeInstanceOf(LockfileError);
          expect(result.error.message).toMatch(shape.throwMessage!);
          return;
        }

        if (shape.expect === "diverge") {
          expect(result.kind === "diverged" ? "diverged" : report).toBe("diverged");
          if (result.kind !== "diverged") return;
          const planned = result.planned.split("\n");
          const regenerated = result.regenerated.split("\n");
          // Naming the lines is what keeps a pinned gap describing the gap: a
          // bare "diverged" would keep passing if the divergence moved.
          for (const line of shape.plannedOnly ?? []) {
            expect(planned).toContain(line);
            expect(regenerated).not.toContain(line);
          }
          for (const line of shape.regeneratedOnly ?? []) {
            expect(regenerated).toContain(line);
            expect(planned).not.toContain(line);
          }
          return;
        }

        expect(result.kind === "matched" ? "matched" : report).toBe("matched");
      },
      120_000,
    );
  }

  test.skipIf(PNPM === null)(
    "a block that lands past the importer it sorts before is moved back, so the sorting shapes are not comparing two files nobody rewrites",
    () => {
      const result = checkShape(MIS_SORTED_SPLICE);
      expect(result.kind === "diverged" ? "diverged" : describeResult(MIS_SORTED_SPLICE, result)).toBe("diverged");
      if (result.kind !== "diverged") return;

      // Same lines on both sides, in different places: this is the one
      // divergence a membership check cannot express, and the only one the
      // whole sorted-insertion half of the matrix is about.
      const position = (text: string, root: string): number => text.indexOf(`\n  ${root}:`);
      expect(position(result.planned, "libs/analytics")).toBeGreaterThan(position(result.planned, "libs/format"));
      expect(position(result.regenerated, "libs/analytics")).toBeLessThan(
        position(result.regenerated, "libs/format"),
      );
    },
    120_000,
  );

  test.skipIf(PNPM === null)(
    "an incomplete lockfile round-trips byte-identically, and the completeness check is what fails it",
    () => {
      // The blind spot, kept: a lockfile whose importer names a version the
      // file carries no entry for. The adapter no longer writes one — that is
      // `pinned-version-nothing-in-the-lockfile-carries` in the matrix, which
      // refuses — so these bytes are hand-built, and what they still grade is
      // the oracle.
      const result = checkShape(ORACLE_BLIND_SPOT);
      expect(result.kind === "matched" ? "matched" : describeResult(ORACLE_BLIND_SPOT, result)).toBe("matched");
      if (result.kind !== "matched") return;

      expect(result.planned).toContain("      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0");
      expect(result.planned).not.toContain("\npackages:");
      expect(result.planned).not.toContain("\nsnapshots:");

      // The bytes regenerating just called agreement are bytes the install
      // command refuses. This is the fact the whole completeness check exists
      // for, so it is asserted before the check is asked anything.
      const failure = frozenLockfileFailure(result.root);
      expect(failure).toBeDefined();
      expect(failure).toContain("ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY");
      expect(failure).toContain("left-pad@1.3.0");

      // Without the check, the flag is green on a lockfile CI cannot install —
      // the pair is what makes the second line mean something.
      expect(verify(result.root, pnpmAdapter.lockfileOnlyCommand()).ok).toBe(true);

      const checked = verifyLockfile({
        workspacePath: result.root,
        lockfileName: LOCKFILE,
        command: pnpmAdapter.lockfileOnlyCommand(),
        completeness: pnpmAdapter.missingResolutions,
      });
      expect(checked.ok).toBe(false);
      // The finding names the importer and the resolution, so it is actionable
      // without re-reading the file — and it names what pnpm named.
      expect(checked.differences?.[0]).toBe(
        `${LOCKFILE}: libs/analytics declares left-pad@1.3.0, and the lockfile has no entry for it`,
      );
    },
    120_000,
  );

  test.skipIf(PNPM === null)(
    "the completeness check passes every lockfile pnpm itself wrote, including peer suffixes and aliases",
    () => {
      // The other half of the proof above: a check that reported a finding on
      // any lockfile would have made that test pass for free. These are pnpm's
      // own bytes for the version forms an importer can hold — a workspace
      // link, a peer-suffixed resolution, an alias resolving to another
      // package's id — and none of them is `name@version` in `snapshots:`.
      const root = scratchDirectory();
      write(root, "package.json", `${JSON.stringify({ name: "fixture-workspace", private: true }, null, 2)}\n`);
      write(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - libs/*\n");
      write(root, "libs/format/package.json", packageManifest("@acme/format"));
      write(
        root,
        `${APP}/package.json`,
        packageManifest("@acme/api", {
          "@acme/format": "workspace:*",
          mypad: "npm:left-pad@1.3.0",
          react: "18.3.1",
          "react-dom": "18.3.1",
        }),
      );
      runPnpm(root);
      const lockfile = read(root, LOCKFILE);

      expect(lockfile).toContain("version: link:../../libs/format");
      expect(lockfile).toContain("version: left-pad@1.3.0");
      expect(lockfile).toContain("version: 18.3.1(react@18.3.1)");
      expect(pnpmAdapter.missingResolutions(lockfile)).toEqual([]);
    },
    120_000,
  );
});
