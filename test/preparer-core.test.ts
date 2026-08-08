import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { parseConfig } from "../src/config.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { applyPreparerManifest, assertPreparerManifest, compilePreparerManifest, compileStandalonePreparerManifest, simulatePreparerManifest } from "../src/preparer/index.ts";
import { hashJson, hashText } from "../src/util/hash.ts";
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
    await applyPreparerManifest({ rootDir: root, config, manifest });
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

  test("a failed verify preserves an early diagnostic through bounded noisy output", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\n" });
    const diagnostic = "complexity ratchet: packages/leads/src/view.ts score 47 exceeds 32";
    const configured = {
      ...replacementPolicy(source, [{ before: "view = 1", after: "view = 2" }]),
      verify: `printf '${diagnostic}\\n'; yes 'unrelated gate noise' | head -n 900; printf 'gate summary failed\\n' >&2; exit 23`,
    };
    const config = configuration(scratchDirectory(), [configured]);
    let message = "";
    try {
      await compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(diagnostic);
    expect(message).toContain("gate summary failed");
    expect(message).toContain("exit 23");
    expect(message.length).toBeLessThanOrEqual(8_200);
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
    await applyPreparerManifest({ rootDir: root, config, manifest });
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
    await applyPreparerManifest({ rootDir: root, config, manifest });
    expect(readFileSync(`${root}/${source}`, "utf8")).toBe("export const view = 3;\n");
  });

  test("creates a templated declared output without a command and replays idempotently", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\n" });
    const configured = createPolicy("{targetPath}.contract.ts", "export const contract = 1;\n", 0o755);
    const config = configuration(scratchDirectory(), [configured]);

    const manifest = await compilePreparerManifest({ rootDir: root, config, extraction: extractionManifest(root), preparerId: configured.id, sourcePath: source });

    expect(manifest.preparer.creates).toEqual([{ path: "packages/leads/src/tabs/leads/view.ts.contract.ts", contents: "export const contract = 1;\n", mode: 0o755 }]);
    expect(manifest.mutations[0]).toMatchObject({ path: "packages/leads/src/tabs/leads/view.ts.contract.ts", preconditionHash: "missing", preconditionMode: "missing", resultMode: 0o755, contents: "export const contract = 1;\n" });
    await simulatePreparerManifest({ rootDir: root, config, manifest });
    await applyPreparerManifest({ rootDir: root, config, manifest });
    expect(readFileSync(`${root}/packages/leads/src/tabs/leads/view.ts.contract.ts`, "utf8")).toBe("export const contract = 1;\n");
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-qm", "test: apply declarative create");
    const idempotent = await compilePreparerManifest({ rootDir: root, config, extraction: extractionManifest(root), preparerId: configured.id, sourcePath: source });
    expect(idempotent.mutations[0]).toMatchObject({ preconditionHash: manifest.mutations[0]!.resultHash, resultHash: manifest.mutations[0]!.resultHash, preconditionMode: 0o755, resultMode: 0o755 });
  });

  test("refuses a declarative create when different bytes already exist", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const created = "apps/consumer/src/tabs/leads/contract.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\n", [created]: "different\n" });
    const configured = createPolicy(created, "expected\n");
    const config = configuration(scratchDirectory(), [configured]);

    await expect(compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source }))
      .rejects.toThrow(`file create 1 found different existing content or mode: ${created}`);
  });

  test("refuses duplicate create paths, replacement overlap, and workspace escape", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\n" });
    const duplicate = { ...createPolicy("contract.ts", "one\n"), creates: [{ path: "contract.ts", contents: "one\n" }, { path: "contract.ts", contents: "two\n" }] };
    await expect(compileStandalonePreparerManifest({ rootDir: root, config: configuration(scratchDirectory(), [duplicate]), baselineCommit: "HEAD", preparerId: duplicate.id, sourcePath: source }))
      .rejects.toThrow("duplicate preparer create path: contract.ts");

    const overlap = { ...createPolicy(source, "created\n"), replacements: [{ path: source, prefix: "export const ", before: "view = 1", after: "view = 2" }] };
    await expect(compileStandalonePreparerManifest({ rootDir: root, config: configuration(scratchDirectory(), [overlap]), baselineCommit: "HEAD", preparerId: overlap.id, sourcePath: source }))
      .rejects.toThrow(`preparer path cannot be both replaced and created: ${source}`);

    const redundantOutput = { ...createPolicy("contract.ts", "created\n"), outputs: ["contract.ts"] };
    await expect(compileStandalonePreparerManifest({ rootDir: root, config: configuration(scratchDirectory(), [redundantOutput]), baselineCommit: "HEAD", preparerId: redundantOutput.id, sourcePath: source }))
      .rejects.toThrow("created path is automatically an output and must not be declared twice: contract.ts");

    const escape = createPolicy("../contract.ts", "escaped\n");
    await expect(compileStandalonePreparerManifest({ rootDir: root, config: configuration(scratchDirectory(), [escape]), baselineCommit: "HEAD", preparerId: escape.id, sourcePath: source }))
      .rejects.toThrow("path is not workspace-relative");
  });

  test("manifest validation detects tampered declarative create policy", async () => {
    const source = "apps/consumer/src/tabs/leads/view.ts";
    const root = fixtureRepo({ [source]: "export const view = 1;\n" });
    const configured = createPolicy("contract.ts", "expected\n");
    const config = configuration(scratchDirectory(), [configured]);
    const manifest = await compileStandalonePreparerManifest({ rootDir: root, config, baselineCommit: "HEAD", preparerId: configured.id, sourcePath: source });
    const tampered = structuredClone(manifest);
    (tampered.preparer.creates![0] as { contents: string }).contents = "tampered\n";
    const { planId: _policyPlanId, ...policyDraft } = tampered;
    (tampered as { planId: string }).planId = hashJson(policyDraft);

    expect(() => assertPreparerManifest(config, tampered)).toThrow("preparer manifest commands differ from configuration");

    const tamperedMutation = structuredClone(manifest);
    (tamperedMutation.mutations[0] as { contents: string }).contents = "tampered\n";
    const { planId: _mutationPlanId, ...mutationDraft } = tamperedMutation;
    (tamperedMutation as { planId: string }).planId = hashJson(mutationDraft);
    expect(() => assertPreparerManifest(config, tamperedMutation)).toThrow("preparer manifest create result differs from policy");
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
    await applyPreparerManifest({ rootDir: root, config, manifest });
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
    await applyPreparerManifest({ rootDir: root, config, manifest });
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

function createPolicy(path: string, contents: string, mode?: 0o644 | 0o755) {
  return {
    id: "create-contract",
    phase: "pre-extraction" as const,
    creates: [{ path, contents, ...(mode === undefined ? {} : { mode }) }],
    commit: { subject: "refactor: create contract" },
  };
}

function configuration(worktreeRoot: string, preparers: unknown[]) {
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
