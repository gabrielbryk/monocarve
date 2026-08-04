/**
 * `assertPreparationPolicy` and `simulatePreparation` against a boundary
 * manifest — the "policy anchors" relaxation in `src/prepare/simulate.ts`
 * that lets a manifest with no extraction (a rewritten specifier, or a
 * retired shim) still render a real repository policy.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { verifyPreparationResultModes } from "../src/prepare/audit-modes.ts";
import { compileBoundaryPreparationManifest, type CompileBoundaryPreparationManifestInput } from "../src/prepare/build.ts";
import { validatePreparationManifest } from "../src/prepare/manifest.ts";
import type { PreparationManifest } from "../src/prepare/manifest-types.ts";
import { assertPreparationPolicy, simulatePreparation } from "../src/prepare/simulate.ts";
import { resolveCommit } from "../src/util/git.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

const RETAINED = "apps/api/src/config/env.ts";
const RETAINED_SOURCE = 'export const env = "prod";\n';
const IMPORTER = "apps/api/src/orders/service.ts";
const IMPORTER_SOURCE = 'import { env } from "../config/env.ts";\nexport const value = env;\n';

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler" },
  include: ["src/**/*.ts"],
});

/**
 * `env-shim`: the smallest boundary manifest that carries no extraction at
 * all — a rewrite-module-specifier operation, optionally followed by the
 * deletion that retires its shim.
 * `gates.workspace` is caller-controlled so the simulation-failure test can
 * force a real, observable gate failure.
 */
function existingPackageFixture(workspaceGate: string, retire = false): { readonly root: string; readonly config: ReturnType<typeof fixtureConfig>; readonly manifest: PreparationManifest } {
  const root = fixtureRepo({
    "apps/api/tsconfig.json": TSCONFIG,
    [RETAINED]: RETAINED_SOURCE,
    [IMPORTER]: IMPORTER_SOURCE,
  });
  const config = fixtureConfig(root, {
    compositionBoundaries: [{
      id: "env-shim",
      retained: RETAINED,
      strategy: "existing-package",
      replacement: { specifier: "@acme/env", symbols: ["env"] },
      retire,
    }],
    preparation: {
      gates: { package: [], project: [], workspace: [workspaceGate] },
      commit: { subject: "refactor: prepare env boundary" },
    },
  });
  const baseline = resolveCommit(root, "HEAD");
  const modules: ScanReport["modules"][number][] = [
    { source: RETAINED, dependencies: [] },
    { source: IMPORTER, dependencies: [{ module: "../config/env.ts", resolved: RETAINED }] },
  ];
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: baseline.commit });
  const input: CompileBoundaryPreparationManifestInput = {
    rootDir: root,
    config,
    baselineCommit: "HEAD",
    graphDigest: hashText("fixture-workspace-graph"),
    boundaryId: "env-shim",
    graph,
    rendering: {
      gates: { package: [], project: [], workspace: [workspaceGate] },
      commit: { subject: "refactor: prepare env boundary" },
    },
  };
  return { root, config, manifest: compileBoundaryPreparationManifest(input) };
}

describe("assertPreparationPolicy — boundary manifests (no extraction present)", () => {
  test("accepts a boundary manifest whose gates and commit exactly match the resolved config's rendered policy", () => {
    const { config, manifest } = existingPackageFixture("true");

    expect(() => assertPreparationPolicy(config, manifest)).not.toThrow();
  });

  test("rejects a boundary manifest whose gates differ from what the resolved configuration renders", () => {
    const { config, manifest } = existingPackageFixture("true");
    const tampered: PreparationManifest = { ...manifest, gates: { ...manifest.gates, workspace: [...manifest.gates.workspace, "false"] } };

    expect(() => assertPreparationPolicy(config, tampered)).toThrow(
      "preparation manifest policy differs from the exact gates or commit metadata rendered by the resolved configuration",
    );
  });

  test("rejects a boundary manifest whose commit metadata differs from what the resolved configuration renders", () => {
    const { config, manifest } = existingPackageFixture("true");
    const tampered: PreparationManifest = { ...manifest, commits: { prepare: { subject: "refactor: a different subject entirely" } } };

    expect(() => assertPreparationPolicy(config, tampered)).toThrow(
      "preparation manifest policy differs from the exact gates or commit metadata rendered by the resolved configuration",
    );
  });
});

describe("preparation manifest validity — the relaxation must not open a hole", () => {
  test("a manifest with neither a declaration group nor any operation is still rejected", () => {
    const { manifest } = existingPackageFixture("true");
    const empty: PreparationManifest = { ...manifest, declarations: [], operations: [], changedFiles: [] };

    const result = validatePreparationManifest(empty);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rule: "declarations", message: "a preparation must either select a declaration group or carry at least one operation" }),
    );
    // And the OTHER declarations rule — "a type-declaration extraction must
    // select at least one complete type group" — must NOT fire here: this
    // manifest carries no extraction, so that rule is simply inapplicable.
    expect(result.issues.some((issue) => issue.message.includes("type-declaration extraction must select"))).toBe(false);
  });
});

describe("simulatePreparation — failure restores the tree and leaves the real checkout untouched", () => {
  test("a gate failure inside the disposable worktree never mutates the real repository", async () => {
    const { root, config, manifest } = existingPackageFixture("exit 1");
    const beforeHead = fixtureGit(root, "rev-parse", "HEAD");
    const beforeStatus = fixtureGit(root, "status", "--porcelain");
    expect(beforeStatus).toBe("");

    const result = await simulatePreparation({
      config,
      rootDir: root,
      manifest,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }),
    });

    expect(result.ok).toBe(false);
    expect(result.failedGate).toMatchObject({ tier: "workspace", command: "exit 1" });
    // The audit ran and passed inside the worktree before the gate failed —
    // this is a gate failure, not a validation escape.
    expect(result.audit?.passed).toBe(true);

    const afterHead = fixtureGit(root, "rev-parse", "HEAD");
    const afterStatus = fixtureGit(root, "status", "--porcelain");
    expect(afterHead).toBe(beforeHead);
    expect(afterStatus).toBe("");
  }, 30_000);

  test("a retired existing-package shim audits its result as missing, while a retained shim fails the same proof", async () => {
    const { root, config, manifest } = existingPackageFixture("true", true);
    const deletion = manifest.operations.find((operation) => operation.kind === "delete-module");
    if (!deletion || deletion.kind !== "delete-module") throw new Error("expected retired existing-package boundary deletion");

    // Failure sensitivity: before replay the shim still exists, so the delete
    // result proof must reject it rather than treating legacy resultMode: 0 as
    // an ordinary file permission mode.
    const failures: string[] = [];
    expect(verifyPreparationResultModes(root, [deletion], failures)).toBe(1);
    expect(failures).toEqual([
      `landed deletion did not remove ${RETAINED} (expected missing, got 420)`,
    ]);

    const result = await simulatePreparation({
      config,
      rootDir: root,
      manifest,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }),
    });

    expect(result.ok).toBe(true);
    expect(result.audit?.fileModes).toEqual({ passed: true, checked: 2, failures: [] });
  }, 30_000);
});
