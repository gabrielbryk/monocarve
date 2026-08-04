/**
 * The codemod's resolution cache has no notion of *when* an answer was true.
 *
 * `optionsCache` and `resolutionCache` are keyed on (boundary, importer,
 * specifier) and live for the lifetime of the process, so two observations of
 * the same root in one process share answers even when the tree changed in
 * between. The audit's whole claim is that it re-resolves every reference
 * against the tree as it is now; a stale answer turns that claim into a replay
 * of an earlier tree, and the audit reports a verdict about a tree that no
 * longer exists.
 *
 * The case below is the cheapest one that makes the difference a verdict rather
 * than an internal detail. A package file reaches back into the application by
 * relative path. At the first audit the file it names is absent, so the
 * specifier resolves to nothing and the boundary rule is genuinely satisfied —
 * that `null` is what gets cached. The application file then lands, the same
 * specifier now resolves into the application source root, and the boundary rule
 * is genuinely violated. A second audit that serves the cached `null` passes a
 * tree that breaks the rule the proof exists to enforce.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { auditPlanSync } from "../src/transaction/audit.ts";
import { hashText } from "../src/util/hash.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";

const DONOR = "apps/api/src/widget/widget.ts";
const TARGET = "libs/analytics/src/widget/widget.ts";
const ENTRYPOINT = "libs/analytics/src/index.ts";
const BRIDGE = "libs/analytics/src/bridge.ts";
const LATE = "apps/api/src/late.ts";
/** Written `.js`, meaning `late.ts` on disk: the form whose answer depends on the tree. */
const LATE_SPECIFIER = "../../../apps/api/src/late.js";
const PACKAGE = "@acme/analytics";
const PACKAGE_ROOT = "libs/analytics";
const BARREL = 'export * from "./widget/widget.ts";\n';

function fixtureFiles(): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "apps/api/tsconfig.json": `${JSON.stringify({ include: ["src"] }, null, 2)}\n`,
    [DONOR]: "export const widgetValue = 1;\n",
    [BRIDGE]: `import { late } from "${LATE_SPECIFIER}";\n\nexport const bridged = late;\n`,
    [`${PACKAGE_ROOT}/package.json`]: `${JSON.stringify(
      {
        name: PACKAGE,
        version: "0.1.0",
        private: true,
        type: "module",
        main: "./src/index.ts",
        types: "./src/index.ts",
        exports: { ".": { types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts" } },
      },
      null,
      2,
    )}\n`,
  };
}

/** A plan whose only claim is the move and the barrel: nothing else can fail. */
function manifestFor(root: string): ExtractionManifest {
  const donorHash = hashText(read(root, DONOR));
  return {
    schemaVersion: 2,
    planId: "codemod-cache",
    createdAt: new Date().toISOString(),
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("codemod-cache-graph"),
    application: "api",
    target: {
      packageName: PACKAGE,
      packageRoot: PACKAGE_ROOT,
      entrypoint: "src/index.ts",
      requiredExports: [{ name: "widgetValue", typeOnly: false }],
    },
    source: { files: [DONOR], tests: [], sccs: { "scc-fixture": [DONOR] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [DONOR]: donorHash },
    operations: [
      { kind: "move", source: DONOR, target: TARGET, preconditionHash: donorHash, resultHash: donorHash },
      {
        kind: "write-file",
        path: ENTRYPOINT,
        contents: BARREL,
        preconditionHash: "missing",
        resultHash: hashText(BARREL),
        generator: "scaffold:entrypoint",
      },
    ],
    consumers: [],
    generatedFiles: [],
    changedFiles: [DONOR, TARGET, ENTRYPOINT].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 1, applicationLinesAfter: 0, consumers: 0 },
    commits: {
      plan: { subject: `chore(${PACKAGE}): compile extraction plan codemod-cache` },
      move: { subject: `refactor(${PACKAGE}): move 1 files into ${PACKAGE_ROOT}` },
      wiring: { subject: `refactor(${PACKAGE}): wire ${PACKAGE} into the workspace` },
    },
    gates: { package: [], project: [], workspace: ["true"] },
  };
}

describe("codemod cache boundaries", () => {
  afterEach(cleanupFixtures);

  test("a second audit of the same root sees the tree as it is now, not as the first audit found it", () => {
    const root = fixtureRepo(fixtureFiles());
    const config = fixtureConfig(root);
    const manifest = manifestFor(root);

    write(root, TARGET, read(root, DONOR));
    rmSync(join(root, DONOR));
    write(root, ENTRYPOINT, BARREL);

    // `libs/analytics/src/bridge.ts` names a file that is not there, so it
    // imports nothing and the boundary rule holds. This audit is honest, and it
    // is what poisons the cache: the specifier is recorded as resolving to null.
    const before = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(before.failures).toEqual([]);
    expect(before.passed).toBe(true);

    // The application file lands — a merge, a rebase, another plan applied in
    // the same process. The same specifier now names application code.
    write(root, LATE, "export const late = 1;\n");

    const after = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(after.boundaryRules.failures).toEqual([`${BRIDGE} imports application code: ${LATE_SPECIFIER}`]);
    expect(after.passed).toBe(false);
  }, 60_000);
});
