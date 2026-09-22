/**
 * The reviewed boundary baseline.
 *
 * The audit's boundary proof is repository-wide, so on a workspace part-way
 * through a decomposition it fails on debt the plan never touched. The baseline
 * makes that debt an explicit, reviewed input instead of a flag that turns the
 * proof off — which means the proof has to keep failing on everything outside
 * the recorded set. Every accepting case below is paired with the negative that
 * makes it mean something:
 *
 *  - a recorded edge passes, and the identical edge against a plan that did not
 *    record it still fails;
 *  - a plan whose own applied result introduces a *new* edge fails even though
 *    its recorded baseline is otherwise honoured;
 *  - a record whose digest, order, or uniqueness does not describe its own
 *    edges is refused before anything is applied.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { boundaryBaselineDefects, boundaryBaselineDigest, boundaryBaselineOf, collectBoundaryEdges } from "../src/plan/boundary-baseline.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import type { BoundaryBaselineRecord, ExtractionManifest } from "../src/plan/manifest.ts";
import { formatPlanReview, summarizePlanReview } from "../src/plan/review.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";
import { ENTRYPOINT, baseManifest, extractionFiles, landOnDisk, packageManifest } from "./support/transaction-fixture.ts";

const LEGACY_IMPORTER = "libs/legacy/src/index.ts";
const LEGACY_TARGET = "apps/api/src/legacy-helper.ts";
const LEGACY_EDGE = { file: LEGACY_IMPORTER, target: LEGACY_TARGET };
const LEGACY_FAILURE = `${LEGACY_IMPORTER} imports application code: ../../../apps/api/src/legacy-helper.ts`;
const NEW_FAILURE = `${ENTRYPOINT} imports application code: ../../../apps/api/src/legacy-helper.ts`;

/** The fixture extraction, plus a package that already reaches into the app. */
function filesWithPreExistingViolation(): Record<string, string> {
  return {
    ...extractionFiles(),
    [LEGACY_TARGET]: "export const legacy = 1;\n",
    "libs/legacy/package.json": packageManifest("@acme/legacy"),
    [LEGACY_IMPORTER]: 'export { legacy } from "../../../apps/api/src/legacy-helper.ts";\n',
  };
}

function baselineFor(root: string, config: ReturnType<typeof fixtureConfig>): BoundaryBaselineRecord {
  const context = new WorkspaceContext(config, root);
  return boundaryBaselineOf({ config, rootDir: root, files: context.repositorySources(), referencesOf: (file) => context.moduleReferences(file) });
}

describe("boundary baseline — what the compiler records", () => {
  afterEach(cleanupFixtures);

  test("records exactly the package-to-application edges present in the tree", () => {
    const root = fixtureRepo(filesWithPreExistingViolation());
    const config = fixtureConfig(root);

    const baseline = baselineFor(root, config);

    expect(baseline.edges).toEqual([LEGACY_EDGE]);
    expect(baseline.digest).toBe(boundaryBaselineDigest([LEGACY_EDGE]));
  }, 60_000);

  test("an application file importing application code is not an edge", () => {
    // The rule governs package-owned files. `apps/api/src/consumer.ts` imports
    // the donor, which is application code, and must never be recorded — a
    // collector that recorded it would bless real violations later.
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);

    expect(baselineFor(root, config).edges).toEqual([]);
  }, 60_000);

  test("edges are deduplicated and canonically ordered regardless of discovery order", () => {
    const config = fixtureConfig(fixtureRepo(extractionFiles()));
    const references = new Map<string, { specifier: string; resolved: string }[]>([
      [
        "libs/b/src/index.ts",
        [
          { specifier: "./z.ts", resolved: "/repo/apps/api/src/z.ts" },
          { specifier: "../../../apps/api/src/a.ts", resolved: "/repo/apps/api/src/a.ts" },
        ],
      ],
      [
        "libs/a/src/index.ts",
        [
          { specifier: "./a", resolved: "/repo/apps/api/src/a.ts" },
          // The same edge reached through a second spelling of the same module.
          { specifier: "./a.ts", resolved: "/repo/apps/api/src/a.ts" },
        ],
      ],
    ]);

    const edges = collectBoundaryEdges({ config, rootDir: "/repo", files: [...references.keys()], referencesOf: (file) => references.get(file) ?? [] });

    expect(edges).toEqual([
      { file: "libs/a/src/index.ts", target: "apps/api/src/a.ts" },
      { file: "libs/b/src/index.ts", target: "apps/api/src/a.ts" },
      { file: "libs/b/src/index.ts", target: "apps/api/src/z.ts" },
    ]);
    expect(boundaryBaselineDigest(edges)).toBe(boundaryBaselineDigest([...edges].reverse()));
  }, 60_000);
});

describe("boundary baseline — what the audit does with it", () => {
  afterEach(cleanupFixtures);

  test("a recorded pre-existing edge is evidence, not a failure", () => {
    const root = fixtureRepo(filesWithPreExistingViolation());
    const config = fixtureConfig(root);
    const manifest: ExtractionManifest = { ...baseManifest(root), boundaryBaseline: baselineFor(root, config) };
    landOnDisk(root, manifest);

    const report = auditPlanSync({ config, rootDir: root, manifest });

    expect(report.boundaryRules.failures).toEqual([]);
    expect(report.failures).not.toContain(LEGACY_FAILURE);
    expect(report.boundaryBaseline).toEqual({ recorded: 1, observed: [`${LEGACY_IMPORTER} -> ${LEGACY_TARGET}`], cleared: [] });
  }, 60_000);

  test("the same edge fails when the reviewed plan did not record it", () => {
    // The negative that makes the case above mean something: nothing about the
    // tree changed, only whether the reviewer approved the edge.
    const root = fixtureRepo(filesWithPreExistingViolation());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    landOnDisk(root, manifest);

    const report = auditPlanSync({ config, rootDir: root, manifest });

    expect(report.boundaryRules.failures).toContain(LEGACY_FAILURE);
    expect(report.passed).toBe(false);
    expect(report.boundaryBaseline.recorded).toBe(0);
  }, 60_000);

  test("an empty recorded baseline is not a waiver either", () => {
    const root = fixtureRepo(filesWithPreExistingViolation());
    const config = fixtureConfig(root);
    const manifest: ExtractionManifest = { ...baseManifest(root), boundaryBaseline: { digest: boundaryBaselineDigest([]), edges: [] } };
    landOnDisk(root, manifest);

    expect(auditPlanSync({ config, rootDir: root, manifest }).boundaryRules.failures).toContain(LEGACY_FAILURE);
  }, 60_000);

  test("a NEW edge introduced by the applied plan still fails while the baseline edge passes", () => {
    const root = fixtureRepo(filesWithPreExistingViolation());
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    // The plan's own generated barrel reaches back into the application it was
    // carved out of. This is the class the proof exists for, and it is invisible
    // to every other proof: the bytes match the manifest exactly.
    const barrel = 'export * from "./widget/widget.ts";\nexport * from "../../../apps/api/src/legacy-helper.ts";\n';
    const manifest: ExtractionManifest = {
      ...base,
      boundaryBaseline: baselineFor(root, config),
      operations: base.operations.map((operation) =>
        operation.kind === "write-file" && operation.path === ENTRYPOINT ? { ...operation, contents: barrel, resultHash: hashText(barrel) } : operation,
      ),
    };
    expect(manifest.operations).not.toEqual(base.operations);
    landOnDisk(root, manifest);

    const report = auditPlanSync({ config, rootDir: root, manifest });

    expect(report.boundaryRules.failures).toEqual([NEW_FAILURE]);
    expect(report.boundaryRules.failures).not.toContain(LEGACY_FAILURE);
    expect(report.passed).toBe(false);
    // The recorded edge is still honoured; the failure is the new one only.
    expect(report.boundaryBaseline.observed).toEqual([`${LEGACY_IMPORTER} -> ${LEGACY_TARGET}`]);
  }, 60_000);

  test("a recorded edge the transaction removed is reported as cleared, not as evidence of one", () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest: ExtractionManifest = { ...baseManifest(root), boundaryBaseline: { digest: boundaryBaselineDigest([LEGACY_EDGE]), edges: [LEGACY_EDGE] } };
    landOnDisk(root, manifest);

    const report = auditPlanSync({ config, rootDir: root, manifest });

    expect(report.boundaryBaseline.observed).toEqual([]);
    expect(report.boundaryBaseline.cleared).toEqual([`${LEGACY_IMPORTER} -> ${LEGACY_TARGET}`]);
  }, 60_000);
});

describe("boundary baseline — canonical form", () => {
  afterEach(cleanupFixtures);

  const record = (edges: readonly { file: string; target: string }[], digest?: string): BoundaryBaselineRecord => ({
    digest: digest ?? boundaryBaselineDigest(edges),
    edges,
  });

  test("a well-formed record has no defects", () => {
    expect(boundaryBaselineDefects(record([LEGACY_EDGE]))).toEqual([]);
    expect(boundaryBaselineDefects(undefined)).toEqual([]);
  });

  test("a digest that does not describe its edges is a defect", () => {
    const widened = [LEGACY_EDGE, { file: "libs/legacy/src/other.ts", target: LEGACY_TARGET }];
    expect(boundaryBaselineDefects({ digest: boundaryBaselineDigest([LEGACY_EDGE]), edges: widened })).toContain(
      "recorded boundary baseline digest does not match its edges",
    );
  });

  test("unsorted and duplicated edges are defects", () => {
    const unsorted = [{ file: "libs/z/src/index.ts", target: LEGACY_TARGET }, LEGACY_EDGE];
    expect(boundaryBaselineDefects(record(unsorted))).toContain("recorded boundary baseline edges are not in canonical order");
    expect(boundaryBaselineDefects(record([LEGACY_EDGE, LEGACY_EDGE]))).toContain("recorded boundary baseline contains duplicate edges");
  });

  test("plan validation refuses a manifest whose baseline was edited without its digest", () => {
    const root = fixtureRepo(filesWithPreExistingViolation());
    const config = fixtureConfig(root);
    const honest = baselineFor(root, config);
    const manifest: ExtractionManifest = {
      ...baseManifest(root),
      boundaryBaseline: { digest: honest.digest, edges: [...honest.edges, { file: "libs/legacy/src/late.ts", target: LEGACY_TARGET }] },
    };

    const result = validatePlan(manifest, { config, rootDir: root });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain("recorded boundary baseline digest does not match its edges");
  }, 60_000);

  test("the audit refuses to run against an unreadable recorded baseline", () => {
    const root = fixtureRepo(filesWithPreExistingViolation());
    const config = fixtureConfig(root);
    const manifest = { ...baseManifest(root), boundaryBaseline: { digest: "not-a-digest", edges: "everything" } } as unknown as ExtractionManifest;
    landOnDisk(root, manifest);

    const report = auditPlanSync({ config, rootDir: root, manifest });

    expect(report.passed).toBe(false);
    expect(report.unauditable).toContain("[boundary-baseline] boundaryBaseline must be an object with a digest and an edges array");
  }, 60_000);
});

describe("boundary baseline — what the reviewer sees", () => {
  afterEach(cleanupFixtures);

  test("plan-review names the count, the digest and every recorded edge, and warns", () => {
    const root = fixtureRepo(filesWithPreExistingViolation());
    const config = fixtureConfig(root);
    const manifest: ExtractionManifest = { ...baseManifest(root), boundaryBaseline: baselineFor(root, config) };

    const summary = summarizePlanReview(manifest, { manifestPath: "plans/fixture.json" });
    const text = formatPlanReview(summary);

    expect(summary.boundaryBaseline.recorded).toBe(true);
    expect(summary.boundaryBaseline.edges).toEqual([LEGACY_EDGE]);
    expect(summary.warnings.map((warning) => warning.code)).toContain("boundary-baseline-recorded");
    expect(text).toContain(`Pre-existing boundary violations: 1 (baseline ${manifest.boundaryBaseline!.digest.slice(0, 12)})`);
    expect(text).toContain(`  ${LEGACY_IMPORTER} -> ${LEGACY_TARGET}`);
  }, 60_000);

  test("a plan with no recorded baseline says so, and raises no waiver warning", () => {
    const root = fixtureRepo(extractionFiles());
    const manifest = baseManifest(root);

    const summary = summarizePlanReview(manifest, { manifestPath: "plans/fixture.json" });

    expect(summary.boundaryBaseline.recorded).toBe(false);
    expect(summary.warnings.map((warning) => warning.code)).not.toContain("boundary-baseline-recorded");
    expect(formatPlanReview(summary)).toContain("Pre-existing boundary violations: none recorded");
  }, 60_000);
});
