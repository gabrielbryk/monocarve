import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { parseConfig } from "../src/config.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { applyPreparerManifest, compilePreparerManifest, compileStandalonePreparerManifest, simulatePreparerManifest } from "../src/preparer/index.ts";
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

  test("compiles a declared source rewrite without an unrelated extraction move", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\n" });
    const configured = {
      id: "quality-ratchet",
      phase: "pre-extraction" as const,
      command: "printf 'export const view = 2;\\n' > {sourcePath}",
      outputs: ["{sourcePath}"],
      verify: "grep -q 'view = 2' {sourcePath}",
      commit: { subject: "refactor: rewrite {sourcePath}" },
    };
    const config = configuration(scratchDirectory(), [configured]);

    const manifest = await compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source });

    expect(manifest.binding).toMatchObject({ application: "standalone", sourcePath: source, targetPath: source });
    expect(manifest.mutations.map((item) => item.path)).toEqual([source]);
    await simulatePreparerManifest({ rootDir: root, config, manifest });
    applyPreparerManifest({ rootDir: root, config, manifest });
    expect(readFileSync(`${root}/${source}`, "utf8")).toBe("export const view = 2;\n");
  });

  test("composes declarative replacements sequentially in one file", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\n" });
    const configured = replacementPolicy(source, [
      { before: "view = 1", after: "view = 2" },
      { before: "view = 2", after: "view = 3" },
    ]);
    const config = configuration(scratchDirectory(), [configured]);

    const manifest = await compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source });

    expect(manifest.mutations[0]?.contents).toBe("export const view = 3;\n");
    applyPreparerManifest({ rootDir: root, config, manifest });
    expect(readFileSync(`${root}/${source}`, "utf8")).toBe("export const view = 3;\n");
  });

  test("deletes anchored text and recognizes the deleted terminal state", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const before = "export const remove = 1;\nexport const keep = 2;\n";
    const after = "export const keep = 2;\n";
    const configured = replacementPolicy(source, [{
      before: "export const remove = 1;\n",
      after: "",
      suffix: "export const keep = 2;\n",
    }]);
    const root = fixtureRepo({ [source]: before });
    const config = configuration(scratchDirectory(), [configured]);

    const manifest = await compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source });
    expect(manifest.mutations[0]?.contents).toBe(after);
    applyPreparerManifest({ rootDir: root, config, manifest });
    expect(readFileSync(`${root}/${source}`, "utf8")).toBe(after);

    const appliedRoot = fixtureRepo({ [source]: after });
    const appliedConfig = configuration(scratchDirectory(), [configured]);
    const idempotent = await compileStandalonePreparerManifest({ rootDir: appliedRoot, config: appliedConfig, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source });
    expect(idempotent.mutations[0]?.contents).toBe(after);
  });

  test("keeps replacement source text literal while rendering its path", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "const card = <Widget description={description} />;\n" });
    const configured = replacementPolicy("{sourcePath}", [{
      prefix: "const card = <Widget ",
      before: "description={description}",
      after: "description={summary}",
      suffix: " />;",
    }]);
    const config = configuration(scratchDirectory(), [configured]);

    const manifest = await compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source });

    expect(manifest.preparer.replacements).toEqual([{
      path: source,
      prefix: "const card = <Widget ",
      before: "description={description}",
      after: "description={summary}",
      suffix: " />;",
    }]);
    expect(manifest.mutations[0]?.contents).toBe("const card = <Widget description={summary} />;\n");
    await simulatePreparerManifest({ rootDir: root, config, manifest });
  });

  test("still refuses unknown placeholders in replacement paths", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\n" });
    const configured = replacementPolicy("{unknownPath}", [{ before: "view = 1", after: "view = 2" }]);
    const config = configuration(scratchDirectory(), [configured]);

    await expect(compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source }))
      .rejects.toThrow("unknown placeholder {unknownPath}");
  });

  test("treats already-applied declarative replacements as idempotent", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const contents = "export const view = 3;\n";
    const root = fixtureRepo({ [source]: contents });
    const configured = replacementPolicy(source, [
      { before: "view = 1", after: "view = 2" },
      { before: "view = 2", after: "view = 3" },
    ]);
    const config = configuration(scratchDirectory(), [configured]);

    const manifest = await compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source });

    expect(manifest.mutations[0]).toMatchObject({ preconditionHash: hashText(contents), resultHash: hashText(contents), contents });
    applyPreparerManifest({ rootDir: root, config, manifest });
    expect(readFileSync(`${root}/${source}`, "utf8")).toBe(contents);
  });

  test("reports the exact declarative replacement that matches neither state", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 9;\n" });
    const configured = replacementPolicy(source, [{ before: "view = 1", after: "view = 2" }]);
    const config = configuration(scratchDirectory(), [configured]);

    await expect(compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source }))
      .rejects.toThrow(`text replacement 1 matched neither before nor after text in ${source}`);
  });

  test("refuses ambiguous before text instead of choosing an occurrence", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\nexport const view = 1;\n" });
    const configured = replacementPolicy(source, [{ before: "view = 1", after: "view = 2" }]);
    const config = configuration(scratchDirectory(), [configured]);

    await expect(compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source }))
      .rejects.toThrow(`text replacement 1 before text is ambiguous in ${source}`);
  });

  test("does not mistake an unrelated after value for the contextual target state", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "const unrelated = 'view = 2';\nexport const view = 9;\n" });
    const configured = replacementPolicy(source, [{ before: "view = 1", after: "view = 2" }]);
    const config = configuration(scratchDirectory(), [configured]);

    await expect(compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source }))
      .rejects.toThrow(`text replacement 1 matched neither before nor after text in ${source}`);
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

function replacementPolicy(path: string, replacements: readonly { readonly before: string; readonly after: string; readonly prefix?: string; readonly suffix?: string }[]) {
  return {
    id: "source-rewrite",
    phase: "pre-extraction" as const,
    replacements: replacements.map((replacement) => ({ path, ...(replacement.prefix === undefined && replacement.suffix === undefined ? { prefix: "export const " } : {}), ...replacement })),
    outputs: [path],
    commit: { subject: "refactor: apply source rewrite" },
  };
}

function configuration(worktreeRoot: string, preparers: (ReturnType<typeof policy> | ReturnType<typeof replacementPolicy>)[]) {
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
