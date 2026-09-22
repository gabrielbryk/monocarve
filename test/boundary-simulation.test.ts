/**
 * `assertPreparationPolicy` and `simulatePreparation` against a boundary
 * manifest — the "policy anchors" relaxation in `src/prepare/simulate.ts`
 * that lets a manifest with no extraction (a rewritten specifier, or a
 * retired shim) still render a real repository policy.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { verifyPreparationResultModes } from "../src/prepare/audit-modes.ts";
import { auditPreparationSync } from "../src/prepare/audit.ts";
import { compileBoundaryPreparationManifest, type CompileBoundaryPreparationManifestInput } from "../src/prepare/build.ts";
import { executePreparationJournal } from "../src/prepare/journal.ts";
import type { PreparationManifest } from "../src/prepare/manifest-types.ts";
import { createPreparationManifest, serializePreparationManifest, validatePreparationManifest } from "../src/prepare/manifest.ts";
import { runPreparationPostJournalPreparers } from "../src/prepare/post-journal.ts";
import { assertPreparationPolicy, preparationFilesystemOperations, simulatePreparation } from "../src/prepare/simulate.ts";
import { resolveCommit } from "../src/util/git.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

const RETAINED = "apps/api/src/config/env.ts";
const RETAINED_SOURCE = 'export const env = "prod";\n';
const IMPORTER = "apps/api/src/orders/service.ts";
const IMPORTER_SOURCE = 'import { env } from "../config/env.ts";\nexport const value = env;\n';

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] });

/**
 * `env-shim`: the smallest boundary manifest that carries no extraction at
 * all — a rewrite-module-specifier operation, optionally followed by the
 * deletion that retires its shim.
 * `gates.workspace` is caller-controlled so the simulation-failure test can
 * force a real, observable gate failure.
 */
function existingPackageFixture(
  workspaceGate: string,
  retire = false,
  extraConfig: Record<string, unknown> = {},
  extraFiles: Record<string, string> = {},
): { readonly root: string; readonly config: ReturnType<typeof fixtureConfig>; readonly manifest: PreparationManifest } {
  const root = fixtureRepo({ "apps/api/tsconfig.json": TSCONFIG, [RETAINED]: RETAINED_SOURCE, [IMPORTER]: IMPORTER_SOURCE, ...extraFiles });
  const config = fixtureConfig(root, {
    compositionBoundaries: [
      { id: "env-shim", retained: RETAINED, strategy: "existing-package", replacement: { specifier: "@acme/env", symbols: ["env"] }, retire },
    ],
    preparation: { gates: { package: [], project: [], workspace: [workspaceGate] }, commit: { subject: "refactor: prepare env boundary" } },
    ...extraConfig,
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
    rendering: { gates: { package: [], project: [], workspace: [workspaceGate] }, commit: { subject: "refactor: prepare env boundary" } },
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
  test("runs boundary-triggered artifacts and post-journal preparers before audit and gates", async () => {
    const { root, config, manifest } = existingPackageFixture(
      "true",
      false,
      {
        generatedArtifacts: {
          artifacts: [
            { path: "generated/ledger.txt", source: "apps/api/src", regenerate: "printf 'fresh\\n' > generated/ledger.txt", triggers: ["^apps/api/src/"] },
          ],
        },
        postJournalPreparers: [
          {
            id: "post-ledger",
            phase: "after-journal-before-gates",
            command: "printf 'post\\n' > generated/post.txt",
            outputs: ["generated/post.txt"],
            triggers: ["^apps/api/src/"],
          },
        ],
      },
      { "generated/ledger.txt": "stale\n", "generated/post.txt": "stale\n" },
    );

    expect(manifest.generatedArtifacts).toEqual([
      { path: "generated/ledger.txt", source: "apps/api/src", regenerate: "printf 'fresh\\n' > generated/ledger.txt", regenerateOnApply: true },
    ]);
    expect(manifest.postJournalPreparers?.map((item) => item.id)).toEqual(["post-ledger"]);
    expect(manifest.changedFiles).toContain("generated/ledger.txt");
    expect(manifest.changedFiles).toContain("generated/post.txt");
    const result = await simulatePreparation({
      config,
      rootDir: root,
      manifest,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }),
    });
    expect(result.ok).toBe(true);
    expect(result.audit?.generatedArtifactFreshness).toEqual({ passed: true, checked: 1, failures: [] });
    executePreparationJournal({ rootDir: root, operations: preparationFilesystemOperations(manifest) });
    const generated = runPreparationPostJournalPreparers(config, root, manifest);
    expect(generated.ok).toBe(true);
    const audit = auditPreparationSync({
      config,
      rootDir: root,
      manifest,
      freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest },
      regeneratedArtifacts: generated.hashes as never,
    });
    expect(audit.passed).toBe(true);
  });

  test("fails closed when a triggered generator is a no-op or produces no output", async () => {
    for (const regenerate of ["true", "rm -f generated/ledger.txt"]) {
      const fixture = existingPackageFixture(
        "true",
        false,
        { generatedArtifacts: { artifacts: [{ path: "generated/ledger.txt", source: "apps/api/src", regenerate, triggers: ["^apps/api/src/"] }] } },
        { "generated/ledger.txt": "stale\n" },
      );
      const result = await simulatePreparation({
        config: fixture.config,
        rootDir: fixture.root,
        manifest: fixture.manifest,
        baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: fixture.manifest.graphDigest }),
      });
      expect(result.ok).toBe(false);
      expect(result.failure).toMatch(/not refreshed|produced no declared output/);
    }
  });

  test("accepts a Moon-sync-like no-op only with its exact configured exemption", async () => {
    const fixture = existingPackageFixture("true", false, {
      generatedArtifacts: {
        artifacts: [
          {
            path: "apps/api/tsconfig.json",
            source: "apps/api/src",
            regenerate: "true",
            triggers: ["^apps/api/src/"],
            exemptReason: "Moon sync may truthfully preserve an already-current project file",
          },
        ],
      },
    });
    const reloaded = JSON.parse(serializePreparationManifest(fixture.manifest)) as PreparationManifest;
    expect(validatePreparationManifest(reloaded).ok).toBe(true);
    expect(reloaded.generatedArtifacts).toEqual([
      {
        path: "apps/api/tsconfig.json",
        source: "apps/api/src",
        regenerate: "true",
        regenerateOnApply: true,
        exemptReason: "Moon sync may truthfully preserve an already-current project file",
      },
    ]);
    const result = await simulatePreparation({
      config: fixture.config,
      rootDir: fixture.root,
      manifest: reloaded,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: reloaded.graphDigest }),
    });
    expect(result.ok).toBe(true);
    expect(result.audit?.generatedArtifactFreshness?.passed).toBe(true);

    const record = reloaded.generatedArtifacts![0]!;
    const { exemptReason: _exemptReason, ...withoutExemption } = record;
    const { planId: _planId, ...draft } = reloaded;
    const tampered = createPreparationManifest({ ...draft, generatedArtifacts: [withoutExemption] });
    const refused = await simulatePreparation({
      config: fixture.config,
      rootDir: fixture.root,
      manifest: tampered,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: tampered.graphDigest }),
    });
    expect(refused.ok).toBe(false);
    expect(refused.failure).toContain("differs from current configuration");
  });

  test("refuses a stale manifest that omits a newly required triggered artifact", async () => {
    const fixture = existingPackageFixture(
      "true",
      false,
      {
        generatedArtifacts: {
          artifacts: [
            { path: "generated/ledger.txt", source: "apps/api/src", regenerate: "printf 'fresh\\n' > generated/ledger.txt", triggers: ["^apps/api/src/"] },
          ],
        },
      },
      { "generated/ledger.txt": "stale\n" },
    );
    const { planId: _planId, generatedArtifacts: _generatedArtifacts, ...draft } = fixture.manifest;
    const stale = createPreparationManifest({ ...draft, changedFiles: draft.changedFiles.filter((path) => path !== "generated/ledger.txt") });
    const result = await simulatePreparation({
      config: fixture.config,
      rootDir: fixture.root,
      manifest: stale,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: stale.graphDigest }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("generated artifact set differs");
  });

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
    expect(failures).toEqual([`landed deletion did not remove ${RETAINED} (expected missing, got 420)`]);

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
