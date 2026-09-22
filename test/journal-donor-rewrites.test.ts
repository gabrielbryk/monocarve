/**
 * Donor-specific consumer rewrites are executable journal data, not labels.
 *
 * Each negative below names a replay that could otherwise hash successfully
 * while lying about which moved source it represents: mixed legacy metadata,
 * an undeclared donor, or a declared donor omitted from the mapping. The
 * positive case proves distinct subpaths land, and the final case proves that
 * this new replay branch participates in the journal's all-or-nothing restore.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { rewriteResolvedImportSpecifier } from "../src/codemod/imports.ts";
import type { ExtractionManifest, ImportRewrite, PlanOperation, RewriteImportOperation } from "../src/plan/manifest.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";

const ALPHA = "apps/api/src/alpha.ts";
const BETA = "apps/api/src/beta.ts";
const CONSUMER = "apps/api/src/consumer.ts";
const ALPHA_PUBLIC = "@acme/values/alpha";
const BETA_PUBLIC = "@acme/values/beta";
const CONSUMER_TEXT = ['import { alpha } from "./alpha.ts";', 'import { beta } from "./beta.ts";', "export const total = alpha + beta;", ""].join("\n");

function files(): Record<string, string> {
  return {
    "package.json": '{"name":"fixture-workspace","private":true,"type":"module"}\n',
    "apps/api/tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}\n',
    [ALPHA]: "export const alpha = 1;\n",
    [BETA]: "export const beta = 2;\n",
    [CONSUMER]: CONSUMER_TEXT,
  };
}

function rewriteResult(root: string, rewrites: readonly Required<ImportRewrite>[]): string {
  return rewrites.reduce(
    (source, rewrite) => rewriteResolvedImportSpecifier(source, join(root, CONSUMER), join(root, rewrite.donor), rewrite.to, root),
    CONSUMER_TEXT,
  );
}

function rewriteOperation(root: string, donors: readonly string[], rewrites: readonly ImportRewrite[], result: string): RewriteImportOperation {
  return { kind: "rewrite-import", file: CONSUMER, donors, rewrites, preconditionHash: hashText(read(root, CONSUMER)), resultHash: hashText(result) };
}

function manifest(root: string, operations: readonly PlanOperation[]): ExtractionManifest {
  const alphaHash = hashText(read(root, ALPHA));
  const betaHash = hashText(read(root, BETA));
  return {
    schemaVersion: 2,
    planId: "fixture-donor-rewrites",
    createdAt: "2024-01-02T03:04:05.000Z",
    generator: { name: "fixture-engine", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("fixture-graph"),
    application: "api",
    target: { packageName: "@acme/values", packageRoot: "libs/values", entrypoint: "src/index.ts", requiredExports: [] },
    source: { files: [ALPHA, BETA], tests: [], sccs: { alpha: [ALPHA], beta: [BETA] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [ALPHA]: alphaHash, [BETA]: betaHash },
    operations,
    consumers: [],
    generatedFiles: [],
    changedFiles: [
      ...new Set(
        operations.flatMap((operation) => {
          if (operation.kind === "rewrite-import") return [operation.file];
          if (operation.kind === "write-file") return [operation.path];
          return [];
        }),
      ),
    ].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 2, movedLines: 2, applicationLinesBefore: 5, applicationLinesAfter: 3, consumers: 1 },
    commits: {
      plan: { subject: "chore(@acme/values): compile extraction plan fixture-donor-rewrites" },
      move: { subject: "refactor(@acme/values): move 2 files into libs/values" },
      wiring: { subject: "refactor(@acme/values): wire @acme/values into the workspace" },
    },
    gates: { package: [], project: [], workspace: [] },
  };
}

const DISTINCT_REWRITES = [
  { from: "./alpha.ts", to: ALPHA_PUBLIC, donor: ALPHA },
  { from: "./beta.ts", to: BETA_PUBLIC, donor: BETA },
] as const;

describe("donor-specific journal rewrites", () => {
  afterEach(cleanupFixtures);

  test("replays multiple donors to distinct public subpaths", async () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root);
    const result = rewriteResult(root, DISTINCT_REWRITES);
    const operation = rewriteOperation(root, [ALPHA, BETA], DISTINCT_REWRITES, result);

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, [operation]) })).resolves.toMatchObject({
      filesWritten: [CONSUMER],
      skipped: 0,
    });
    expect(read(root, CONSUMER)).toBe(result);
    expect(result).toContain(`from "${ALPHA_PUBLIC}"`);
    expect(result).toContain(`from "${BETA_PUBLIC}"`);
  });

  test("replays one package-root destination and one public subpath canonically", async () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root);
    const rewrites = [{ from: "./alpha.ts", to: "@acme/values", donor: ALPHA }, DISTINCT_REWRITES[1]] as const;
    const result = rewriteResult(root, rewrites);
    const operation = rewriteOperation(root, [ALPHA, BETA], rewrites, result);

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, [operation]) })).resolves.toMatchObject({ skipped: 0 });
    expect(read(root, CONSUMER)).toBe(result);
    expect(result).toContain('from "@acme/values"');
    expect(result).toContain(`from "${BETA_PUBLIC}"`);
  });

  test("rewrites a NodeNext .js specifier after its .ts donor moves first", async () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root);
    const source = CONSUMER_TEXT.replace("./alpha.ts", "./alpha.js");
    write(root, CONSUMER, source);
    fixtureGit(root, "add", "--", CONSUMER);
    fixtureGit(root, "commit", "-qm", "test: seed NodeNext consumer");
    const donorHash = hashText(read(root, ALPHA));
    const rewrite = { from: "./alpha.js", to: ALPHA_PUBLIC, donor: ALPHA } as const;
    const result = rewriteResolvedImportSpecifier(source, join(root, CONSUMER), join(root, ALPHA), ALPHA_PUBLIC, root);
    const operations: PlanOperation[] = [
      { kind: "move", source: ALPHA, target: "libs/values/src/alpha.ts", preconditionHash: donorHash, resultHash: donorHash },
      rewriteOperation(root, [ALPHA], [rewrite], result),
    ];

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, operations) })).resolves.toMatchObject({ skipped: 0 });
    expect(read(root, CONSUMER)).toBe(result);
    expect(result).toContain(`from "${ALPHA_PUBLIC}"`);
  });

  test("refuses mixed donor-specific and legacy rewrites without changing the consumer", async () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root);
    const rewrites: readonly ImportRewrite[] = [DISTINCT_REWRITES[0], { from: "./beta.ts", to: BETA_PUBLIC }];
    const operation = rewriteOperation(root, [ALPHA, BETA], rewrites, rewriteResult(root, DISTINCT_REWRITES));

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, [operation]) })).rejects.toThrow("mixes donor-specific and legacy rewrites");
    expect(read(root, CONSUMER)).toBe(CONSUMER_TEXT);
  });

  test("refuses a declared donor with no donor-specific mapping", async () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root);
    const rewrites = [DISTINCT_REWRITES[0]] as const;
    const operation = rewriteOperation(root, [ALPHA, BETA], rewrites, rewriteResult(root, rewrites));

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, [operation]) })).rejects.toThrow(
      `has no donor-specific rewrite for: ${BETA}`,
    );
    expect(read(root, CONSUMER)).toBe(CONSUMER_TEXT);
  });

  test("refuses donor-specific metadata that names an undeclared donor", async () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root);
    const wrong = [{ from: "./beta.ts", to: BETA_PUBLIC, donor: BETA }] as const;
    const operation = rewriteOperation(root, [ALPHA], wrong, rewriteResult(root, wrong));

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, [operation]) })).rejects.toThrow(`names undeclared donor(s): ${BETA}`);
    expect(read(root, CONSUMER)).toBe(CONSUMER_TEXT);
  });

  test("restores a donor-specific rewrite and earlier writes when a later operation fails", async () => {
    const root = fixtureRepo(files());
    const config = fixtureConfig(root);
    const result = rewriteResult(root, DISTINCT_REWRITES);
    const operations: PlanOperation[] = [
      rewriteOperation(root, [ALPHA, BETA], DISTINCT_REWRITES, result),
      { kind: "write-file", path: "libs/values/generated.txt", contents: "generated\n", preconditionHash: "missing", resultHash: hashText("generated\n") },
      { kind: "write-file", path: "libs/values/failure.txt", contents: "actual\n", preconditionHash: "missing", resultHash: hashText("different\n") },
    ];

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, operations) })).rejects.toThrow("hash mismatch");
    expect(read(root, CONSUMER)).toBe(CONSUMER_TEXT);
    expect(existsSync(join(root, "libs/values/generated.txt"))).toBe(false);
    expect(existsSync(join(root, "libs/values/failure.txt"))).toBe(false);
  });
});
