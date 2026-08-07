import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { PreflightError } from "../src/errors.ts";
import { PreparationApplyError, applyPreparation } from "../src/prepare/apply.ts";
import { createPreparationManifest, serializePreparationManifest } from "../src/prepare/manifest.ts";
import type { PreparationManifest } from "../src/prepare/manifest-types.ts";
import { resolveCommit } from "../src/util/git.ts";
import { hashJson, hashText, MISSING } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";

const DONOR = "apps/api/src/types.ts";
const TARGET = "shared/types.ts";
const PLAN_PATH = "plans/preparation.json";
const SOURCE = "export interface Thing { readonly value: string }\n";
const DONOR_RESULT = '\n\nexport type { Thing } from "../../../shared/types.ts";\n';

afterEach(cleanupFixtures);

describe("preparation application", () => {
  test("simulates, commits one declared source scope, and immediately audits", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    const manifest = manifestFor(root, config);
    landManifest(root, manifest);

    const result = await applyPreparation({ config, rootDir: root, manifest, manifestPath: PLAN_PATH, commit: true, baselineGraphScanner: scannerFor(manifest) });

    expect(result.ok).toBe(true);
    expect(result.audit?.passed).toBe(true);
    expect(fixtureGit(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual([DONOR, TARGET]);
    expect(read(root, DONOR)).toBe(DONOR_RESULT);
    expect(read(root, TARGET)).toBe(SOURCE);
    expect(Number(lstatSync(join(root, TARGET)).mode) & 0o777).toBe(0o644);
  });

  test("returns a gate failure without changing the reviewed checkout", async () => {
    const root = fixture();
    const config = preparationConfig(root, "printf 'specific gate diagnostic\\n' >&2; false");
    const manifest = manifestFor(root, config, ["printf 'specific gate diagnostic\\n' >&2; false"]);
    landManifest(root, manifest);
    const before = fixtureGit(root, "rev-parse", "HEAD");

    const result = await applyPreparation({ config, rootDir: root, manifest, manifestPath: PLAN_PATH, commit: true, baselineGraphScanner: scannerFor(manifest) });

    expect(result.ok).toBe(false);
    expect(result.failure).toContain("gate failed");
    expect(result.failedGate).toMatchObject({
      tier: "workspace",
      output: expect.stringContaining("specific gate diagnostic"),
      outputTail: expect.stringContaining("specific gate diagnostic"),
    });
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(before);
    expect(read(root, DONOR)).toBe(SOURCE);
    expect(existsSync(join(root, TARGET))).toBe(false);
    expect(readdirSync(config.transaction.worktreeRoot).filter((name) => name.startsWith(".monocarve-prepare-"))).toEqual([]);
  });

  test("restores the journal when a later journal operation fails", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    const manifest = manifestFor(root, config);
    landManifest(root, manifest);
    const approved = fixtureGit(root, "rev-parse", "HEAD");

    await expect(applyPreparation({
      config,
      rootDir: root,
      manifest,
      manifestPath: PLAN_PATH,
      commit: true,
      baselineGraphScanner: scannerFor(manifest),
      testHooks: { beforeJournalOperation: (index) => { if (index === 1) throw new Error("injected journal-stage failure"); } },
    })).rejects.toThrow("injected journal-stage failure");

    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(approved);
    expect(read(root, DONOR)).toBe(SOURCE);
    expect(existsSync(join(root, TARGET))).toBe(false);
  });

  test("CAS-rolls back journal output when commit construction fails", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    const manifest = manifestFor(root, config);
    landManifest(root, manifest);
    const approved = fixtureGit(root, "rev-parse", "HEAD");

    await expect(applyPreparation({
      config,
      rootDir: root,
      manifest,
      manifestPath: PLAN_PATH,
      commit: true,
      baselineGraphScanner: scannerFor(manifest),
      testHooks: { beforeCommit: () => { throw new Error("injected commit failure"); } },
    })).rejects.toThrow("injected commit failure");

    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(approved);
    expect(read(root, DONOR)).toBe(SOURCE);
    expect(existsSync(join(root, TARGET))).toBe(false);
  });

  test("disables post-commit hooks for the real preparation commit", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    const manifest = manifestFor(root, config);
    landManifest(root, manifest);
    installPostCommitHook(root);

    const result = await applyPreparation({ config, rootDir: root, manifest, manifestPath: PLAN_PATH, commit: true, baselineGraphScanner: scannerFor(manifest) });

    expect(result.ok).toBe(true);
    expect(read(root, DONOR)).toBe(DONOR_RESULT);
    expect(existsSync(join(root, "outside/hook-ran"))).toBe(false);
  });

  test("refuses even an approved manifest on a configured guarded branch", async () => {
    const root = fixture("main");
    const config = preparationConfig(root);
    const manifest = manifestFor(root, config);
    landManifest(root, manifest);

    await expect(applyPreparation({ config, rootDir: root, manifest, manifestPath: PLAN_PATH, commit: true, baselineGraphScanner: scannerFor(manifest) })).rejects.toBeInstanceOf(PreflightError);
    expect(read(root, DONOR)).toBe(SOURCE);
  });

  test("restores HEAD, index, bytes, and mode after an after-stage failure", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    markDonorExecutable(root);
    const manifest = manifestFor(root, config);
    landManifest(root, manifest);
    const approved = fixtureGit(root, "rev-parse", "HEAD");

    await expect(applyPreparation({
      config,
      rootDir: root,
      manifest,
      manifestPath: PLAN_PATH,
      commit: true,
      baselineGraphScanner: scannerFor(manifest),
      testHooks: { afterStage: () => { throw new Error("injected after-stage failure"); } },
    })).rejects.toThrow("injected after-stage failure");

    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(approved);
    expect(fixtureGit(root, "diff", "--cached", "--name-only")).toBe("");
    expect(read(root, DONOR)).toBe(SOURCE);
    expect(Number(lstatSync(join(root, DONOR)).mode) & 0o777).toBe(0o751);
    expect(existsSync(join(root, TARGET))).toBe(false);
  });

  test("refuses an immediate-audit mode mismatch and reports concurrent mode residue", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    const manifest = manifestFor(root, config);
    landManifest(root, manifest);
    const approved = fixtureGit(root, "rev-parse", "HEAD");

    const error = await applyPreparation({
      config,
      rootDir: root,
      manifest,
      manifestPath: PLAN_PATH,
      commit: true,
      baselineGraphScanner: scannerFor(manifest),
      testHooks: { afterCommit: () => { chmodSync(join(root, DONOR), 0o755); } },
    }).then(
      () => { throw new Error("expected mode audit failure"); },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PreparationApplyError);
    expect((error as PreparationApplyError).message).toContain("landed mode differs");
    expect((error as PreparationApplyError).residue).toEqual([DONOR]);
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(approved);
    expect(fixtureGit(root, "diff", "--cached", "--name-only")).toBe("");
    expect(read(root, DONOR)).toBe(DONOR_RESULT);
    expect(Number(lstatSync(join(root, DONOR)).mode) & 0o777).toBe(0o755);
    expect(existsSync(join(root, TARGET))).toBe(false);
  });

  test("refuses a valid-looking manifest edited after its review commit", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    const approved = manifestFor(root, config);
    landManifest(root, approved);
    const forged = reidentify(approved, { graphDigest: hashText("forged but valid graph") });
    write(root, PLAN_PATH, serializePreparationManifest(forged));

    await expect(applyPreparation({ config, rootDir: root, manifest: forged, manifestPath: PLAN_PATH, commit: true, baselineGraphScanner: scannerFor(approved) })).rejects.toThrow(
      "loaded preparation manifest bytes do not match the reviewed manifest committed at HEAD",
    );
    expect(read(root, DONOR)).toBe(SOURCE);
    expect(existsSync(join(root, TARGET))).toBe(false);
  });

  test("refuses a reviewed manifest whose graph digest differs from a fresh baseline scan", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    const original = manifestFor(root, config);
    const forged = reidentify(original, { graphDigest: hashText("forged graph") });
    landManifest(root, forged);

    await expect(applyPreparation({ config, rootDir: root, manifest: forged, manifestPath: PLAN_PATH, commit: true, baselineGraphScanner: scannerFor(original) })).rejects.toThrow(
      "preparation manifest graph digest does not match the fresh baseline graph",
    );
    expect(read(root, DONOR)).toBe(SOURCE);
    expect(existsSync(join(root, TARGET))).toBe(false);
  });

  test("refuses a reviewed manifest that omits a configured preparation gate", async () => {
    const root = fixture();
    const config = preparationConfig(root);
    const original = manifestFor(root, config);
    const gateStripped = reidentify(original, { gates: { package: [], project: [], workspace: [] } });
    landManifest(root, gateStripped);

    await expect(applyPreparation({ config, rootDir: root, manifest: gateStripped, manifestPath: PLAN_PATH, commit: true, baselineGraphScanner: scannerFor(original) })).rejects.toThrow(
      "preparation manifest policy differs from the exact gates or commit metadata rendered by the resolved configuration",
    );
    expect(read(root, DONOR)).toBe(SOURCE);
  });
});

function fixture(branch = "preparation-fixture"): string {
  const root = fixtureRepo({
    "package.json": "{\"name\":\"fixture\",\"private\":true}\n",
    "apps/api/tsconfig.json": "{\"include\":[\"src\"]}\n",
    [DONOR]: SOURCE,
    "hooks/post-commit": "#!/bin/sh\nmkdir -p outside\nprintf '%s' 'hook ran' > outside/hook-ran\n",
  }, branch);
  chmodSync(join(root, "hooks/post-commit"), 0o755);
  fixtureGit(root, "add", "--", "hooks/post-commit");
  fixtureGit(root, "commit", "-qm", "test: add dormant post-commit hook");
  return root;
}

function preparationConfig(root: string, workspaceGate = "true") {
  return fixtureConfig(root, {
    preparation: {
      commit: { subject: "chore: prepare type declarations" },
      gates: { workspace: [workspaceGate] },
    },
  });
}

function manifestFor(root: string, config: ReturnType<typeof fixtureConfig>, workspaceGates: readonly string[] = ["true"]): PreparationManifest {
  const baseline = resolveCommit(root, "HEAD");
  const sourceHash = hashText(SOURCE);
  const declarationEnd = SOURCE.length - 1;
  const declarationHash = hashText(SOURCE.slice(0, declarationEnd));
  const span = { start: 0, end: declarationEnd, hash: declarationHash };
  const declarationId = hashJson({ sourcePath: DONOR, name: "Thing", kind: "interface", start: span.start, end: span.end, spanHash: span.hash });
  const selectorId = hashJson({
    declarationId,
    sourcePath: DONOR,
    sourceHash,
    extractionStart: 0,
    extractionEnd: declarationEnd,
    extractionHash: declarationHash,
  });
  const groupId = hashJson({ sourcePath: DONOR, name: "Thing", declarationIds: [declarationId] });
  const group = {
    groupId,
    sourcePath: DONOR,
    name: "Thing",
    space: "type" as const,
    declarations: [{
      declarationId,
      selectorId,
      sourcePath: DONOR,
      sourceHash,
      name: "Thing",
      kind: "interface" as const,
      space: "type" as const,
      originallyExported: true,
      span,
      extractionStart: 0,
      extractionEnd: declarationEnd,
      extractionHash: declarationHash,
    }],
  };
  const donorMode = canonicalGitMode(Number(lstatSync(join(root, DONOR)).mode));
  return createPreparationManifest({
    schemaVersion: 1,
    createdAt: baseline.committedAt,
    generator: { name: "test", version: "1" },
    baseline: { commit: baseline.commit, committerDate: baseline.committedAt, configDigest: hashJson(config) },
    graphDigest: hashText("test graph"),
    declarations: [group],
    operations: [{
      kind: "extract-type-declarations",
      donor: {
        path: DONOR,
        preconditionHash: sourceHash,
        preconditionMode: donorMode,
        resultHash: hashText(DONOR_RESULT),
        resultMode: donorMode,
      },
      target: {
        path: TARGET,
        preconditionHash: MISSING,
        preconditionMode: "missing",
        resultHash: sourceHash,
        resultMode: 0o644,
      },
      moduleSpecifier: "../../../shared/types.ts",
      declarations: [group],
      targetImportProofs: [],
      targetImports: [],
      donorImports: [],
      reExportNames: ["Thing"],
      targetDeclarationProofs: [{
        selectorId,
        targetStart: 0,
        targetEnd: declarationEnd,
        targetHash: declarationHash,
        targetExtractionStart: 0,
        targetExtractionEnd: declarationEnd,
        targetExtractionHash: declarationHash,
        synthesizedExport: false,
      }],
      donorContents: DONOR_RESULT,
      targetContents: SOURCE,
    }],
    compatibilityReexports: [{
      fromPath: DONOR,
      toPath: TARGET,
      moduleSpecifier: "../../../shared/types.ts",
      exports: [{ name: "Thing", typeOnly: true }],
    }],
    changedFiles: [DONOR, TARGET],
    commits: { prepare: { subject: "chore: prepare type declarations" } },
    gates: { package: [], project: [], workspace: [...workspaceGates] },
  });
}

function landManifest(root: string, manifest: PreparationManifest): void {
  write(root, PLAN_PATH, serializePreparationManifest(manifest));
  fixtureGit(root, "add", "--", PLAN_PATH);
  fixtureGit(root, "commit", "-qm", manifest.commits.prepare.subject);
}

function installPostCommitHook(root: string): void {
  fixtureGit(root, "config", "core.hooksPath", join(root, "hooks"));
}

function markDonorExecutable(root: string): void {
  chmodSync(join(root, DONOR), 0o751);
  fixtureGit(root, "add", "--", DONOR);
  fixtureGit(root, "commit", "-qm", "test: make preparation donor executable");
}

function scannerFor(manifest: PreparationManifest) {
  return async ({ baselineCommit }: { readonly baselineCommit: string }) => ({ commit: baselineCommit, digest: manifest.graphDigest });
}

function canonicalGitMode(mode: number): number {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

function reidentify(manifest: PreparationManifest, changes: Partial<Omit<PreparationManifest, "planId">>): PreparationManifest {
  const { planId: _planId, ...draft } = manifest;
  return createPreparationManifest({ ...draft, ...changes });
}
