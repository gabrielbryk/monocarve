import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { parseConfig } from "../src/config.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { applyPreparerManifest, compilePreparerManifest, simulatePreparerManifest } from "../src/preparer/index.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, scratchDirectory } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

describe("configured pre-extraction preparers", () => {
  test("derives a nested move destination and compiles a reviewable transaction in a disposable worktree", async () => {
    const root = fixtureRepo({ "apps/consumer/src/tabs/leads/view.ts": "export const view = 1;\n" });
    const config = configuration(scratchDirectory(), [policy("printf '{\"limit\":1}\\n' > {targetPath}.baseline.json")]);
    const extraction = extractionManifest(root);

    const manifest = await compilePreparerManifest({
      rootDir: root,
      config,
      extraction,
      preparerId: "quality-ratchet",
      sourcePath: "apps/consumer/src/tabs/leads/view.ts",
    });

    expect(manifest.binding.targetPath).toBe("packages/leads/src/tabs/leads/view.ts");
    expect(manifest.mutations.map((item) => item.path)).toEqual(["packages/leads/src/tabs/leads/view.ts.baseline.json"]);
    expect(manifest.mutations[0]?.preconditionHash).toBe("missing");
    expect(existsSync(`${root}/packages/leads/src/tabs/leads/view.ts.baseline.json`)).toBe(false);
    await simulatePreparerManifest({ rootDir: root, config, manifest });
    applyPreparerManifest({ rootDir: root, config, manifest });
    expect(readFileSync(`${root}/packages/leads/src/tabs/leads/view.ts.baseline.json`, "utf8")).toBe('{"limit":1}\n');
  });

  test("refuses undeclared writes and removes the disposable transaction worktree", async () => {
    const root = fixtureRepo({ "apps/consumer/src/tabs/leads/view.ts": "export const view = 1;\n" });
    const scratch = scratchDirectory();
    const config = configuration(scratch, [policy("mkdir -p packages/leads/src/tabs/leads && printf ok > {targetPath}.baseline.json && printf rogue > rogue.txt")]);

    await expect(compilePreparerManifest({
      rootDir: root,
      config,
      extraction: extractionManifest(root),
      preparerId: "quality-ratchet",
      sourcePath: "apps/consumer/src/tabs/leads/view.ts",
    })).rejects.toThrow("undeclared repository-visible path(s): rogue.txt");

    expect(existsSync(`${root}/rogue.txt`)).toBe(false);
    expect(existsSync(`${root}/packages/leads/src/tabs/leads/view.ts.baseline.json`)).toBe(false);
  });

  test("config rejects duplicate preparer identities", () => {
    expect(() => configuration(scratchDirectory(), [policy("true"), policy("true")])).toThrow("preparer id must be unique");
  });

  test("verify is observational and any repository-visible mutation is refused", async () => {
    const root = fixtureRepo({ "apps/consumer/src/tabs/leads/view.ts": "export const view = 1;\n" });
    const configured = { ...policy("printf ok > {targetPath}.baseline.json"), verify: "printf mutation > verify-mutated.txt" };
    const config = configuration(scratchDirectory(), [configured]);
    await expect(compilePreparerManifest({ rootDir: root, config, extraction: extractionManifest(root), preparerId: configured.id, sourcePath: "apps/consumer/src/tabs/leads/view.ts" }))
      .rejects.toThrow("undeclared repository-visible path(s): verify-mutated.txt");
    expect(existsSync(`${root}/verify-mutated.txt`)).toBe(false);
  });

  test("ignored scratch writes are discarded and never captured as outputs", async () => {
    const root = fixtureRepo({ ".gitignore": "*.scratch\n", "apps/consumer/src/tabs/leads/view.ts": "export const view = 1;\n" });
    const configured = policy("printf ok > {targetPath}.baseline.json && printf scratch > transient.scratch");
    const config = configuration(scratchDirectory(), [configured]);
    const manifest = await compilePreparerManifest({ rootDir: root, config, extraction: extractionManifest(root), preparerId: configured.id, sourcePath: "apps/consumer/src/tabs/leads/view.ts" });
    expect(manifest.mutations.map((item) => item.path)).not.toContain("transient.scratch");
    expect(existsSync(`${root}/transient.scratch`)).toBe(false);
  });
});

function policy(command: string) {
  return {
    id: "quality-ratchet",
    phase: "pre-extraction" as const,
    command: `mkdir -p packages/leads/src/tabs/leads && ${command}`,
    outputs: ["{targetPath}.baseline.json"],
    verify: "test -s {targetPath}.baseline.json",
    commit: { subject: "chore: update ratchet for {targetPath}" },
  };
}

function configuration(worktreeRoot: string, preparers: ReturnType<typeof policy>[]) {
  return parseConfig({
    applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }],
    packageRoots: ["packages"],
    packageManager: "pnpm",
    taskRunner: "none",
    scaffoldTemplates: { packageJson: { contents: "{}" } },
    transaction: { worktreeRoot, nodeModules: "none", cleanup: true },
    preparers,
  });
}

function extractionManifest(root: string): ExtractionManifest {
  const source = "apps/consumer/src/tabs/leads/view.ts";
  const target = "packages/leads/src/tabs/leads/view.ts";
  const hash = hashText("export const view = 1;\n");
  return {
    schemaVersion: 2,
    planId: "extraction-plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "fixture", version: "1" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("graph"),
    application: "consumer",
    target: { packageName: "@acme/leads", packageRoot: "packages/leads", entrypoint: "src/index.ts", requiredExports: [] },
    source: { files: [source], tests: [], sccs: { [source]: [source] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [source]: hash },
    operations: [{ kind: "move", source, target, preconditionHash: hash, resultHash: hash }],
    consumers: [], generatedFiles: [], changedFiles: [source, target],
    expectedDynamicImportDelta: { added: [], removed: [] }, evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 1, applicationLinesAfter: 0, consumers: 0 },
    commits: { move: { subject: "refactor: move" }, wiring: { subject: "refactor: wire" } },
    gates: { package: [], project: [], workspace: [] },
  };
}
