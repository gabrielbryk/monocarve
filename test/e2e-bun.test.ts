/**
 * The whole pipeline against a bun workspace.
 *
 * `e2e.test.ts` proves the stages agree; this proves they agree when the
 * package manager is the one whose membership lives in the root manifest and
 * whose lockfile importer is composite. Everything the pnpm run exercises about
 * the *engine* is already covered there, so this asks only the questions a
 * second package manager can make fail: does the plan register the package
 * where bun looks for it, does the journal splice both halves of the lockfile
 * importer, and does the audit of the applied result pass rather than being
 * vacuously green.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bunAdapter } from "../src/adapters/bun.ts";
import { loadConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { buildPlanSync, serializeManifest } from "../src/plan/build.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { verifyPackageImporters } from "../src/transaction/projected-importers.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory, write } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/bun-monorepo");

function standaloneWorkspace(): string {
  const root = join(scratchDirectory(), "workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });
  fixtureGit(root, "init", "-q", "-b", "work");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed workspace");
  return root;
}

describe("end to end, on a bun workspace", () => {
  afterAll(cleanupFixtures);

  test("compiles, applies, and audits an extraction whose lockfile importer is composite", async () => {
    const root = standaloneWorkspace();
    const { config } = await loadConfig({ cwd: root });
    expect(config.packageManager).toBe("bun");

    const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
    const portfolio = buildPortfolio({ config, graph });
    const candidate = portfolio.candidates.find((entry) => entry.eligible && entry.assets.length > 0);
    expect(candidate).toBeDefined();

    const manifest = buildPlanSync({
      config,
      rootDir: root,
      graph,
      candidate: candidate!,
      baselineCommit: graph.commit!,
      packageName: "@acme/chart",
    });

    // The plan declares the two files bun reads for membership and resolution,
    // and declares them once each. A plan missing either is a plan that lands a
    // directory bun never installs.
    const lockfileOperations = manifest.operations.filter((operation) => operation.kind === "lockfile-importer");
    expect(lockfileOperations.map((operation) => operation.lockfile)).toEqual(["bun.lock", "bun.lock"]);
    expect(manifest.changedFiles).toContain("bun.lock");
    // `apps/*` and `libs/*` already cover `libs/chart`, so membership is
    // satisfied rather than edited — the root manifest is not in the plan.
    expect(manifest.changedFiles).not.toContain("package.json");

    const manifestPath = "plans/chart.json";
    write(root, manifestPath, serializeManifest(manifest));
    fixtureGit(root, "add", "--", manifestPath);
    fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);

    // The move commit is nothing but exact renames, on this manager too.
    const moveDiff = fixtureGit(root, "show", "--name-status", "--find-renames=100%", "--format=", "HEAD~1")
      .split("\n")
      .filter(Boolean);
    expect(moveDiff.length).toBeGreaterThan(0);
    expect(moveDiff.every((line) => line.startsWith("R100"))).toBe(true);

    const lockfile = readFileSync(join(root, "bun.lock"), "utf8");
    // Both halves landed: the manifest mirror and the workspace link.
    const block = bunAdapter.importerBlock(lockfile, "libs/chart");
    expect(block).toContain('    "libs/chart": {');
    expect(block).toContain('    "@acme/chart": ["@acme/chart@workspace:libs/chart"],');
    expect(bunAdapter.importerBlock(lockfile, "apps/web")).toContain('"@acme/chart": "workspace:*"');
    // The file is still parseable JSONC after two independent splices.
    expect(() => JSON.parse(lockfile.replaceAll(/,(\s*[}\]])/gu, "$1"))).not.toThrow();
    expect(bunAdapter.missingResolutions(lockfile)).toEqual([]);

    // The landed manifests and the landed importers agree, checked against the
    // lockfile rather than against the plan that wrote it.
    const projected = await verifyPackageImporters(root, bunAdapter, [".", "apps/web", "libs/chart"]);
    expect(projected.differences).toEqual([]);
    expect(projected.checked).toEqual([".", "apps/web", "libs/chart"]);

    // The package is real, and the consumer moved to its specifier.
    const created = JSON.parse(readFileSync(join(root, "libs/chart/package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(created.name).toBe("@acme/chart");
    expect(created.dependencies["@acme/format"]).toBe("workspace:*");
    expect(readFileSync(join(root, "apps/web/src/main.ts"), "utf8")).toContain('from "@acme/chart');

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);

    // The audit is not green because it looked at nothing: corrupting the half
    // of the importer a manifest-only block would have missed has to fail it.
    const damaged = lockfile.replace('    "@acme/chart": ["@acme/chart@workspace:libs/chart"],\n\n', "");
    expect(damaged).not.toBe(lockfile);
    write(root, "bun.lock", damaged);
    const tampered = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(tampered.passed).toBe(false);
  }, 180_000);
});
