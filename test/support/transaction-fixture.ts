import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { pnpmAdapter } from "../../src/adapters/pnpm.ts";
import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../../src/adapters/registry.ts";
import { rewriteResolvedImportSpecifier } from "../../src/codemod/imports.ts";
import { getApplication, parseConfig, resolveExtractionProfile } from "../../src/config.ts";
import type { ExtractionManifest, PlanOperation } from "../../src/plan/manifest.ts";
import { buildPlanProvenance } from "../../src/plan/provenance.ts";
import { hashText } from "../../src/util/hash.ts";
import { fixtureGit, read, write } from "./fixture-repo.ts";

export const DONOR = "apps/api/src/widget/widget.ts";
export const TARGET = "libs/analytics/src/widget/widget.ts";
export const CONSUMER = "apps/api/src/consumer.ts";
export const ENTRYPOINT = "libs/analytics/src/index.ts";
export const PACKAGE = "@acme/analytics";
export const PACKAGE_ROOT = "libs/analytics";
export const APP = "apps/api";
export const ZETA = "@acme/zeta";

/**
 * Real pnpm bytes, not this tool's dialect: an importer with nothing to declare
 * is written inline, and a link-only workspace has no `packages:` key. The
 * splicer has to be exercised against the file it will actually meet.
 */
export const LOCKFILE = ["lockfileVersion: '9.0'", "", "importers:", "", "  .: {}", "", "  libs/zeta: {}", ""].join("\n");

export const IMPORTER_BLOCK = pnpmAdapter.importerBlock(LOCKFILE.replace("  libs/zeta: {}", "  libs/analytics: {}\n\n  libs/zeta: {}"), PACKAGE_ROOT)!;
export const LOCKFILE_APPLIED = pnpmAdapter.insertImporter(LOCKFILE, PACKAGE_ROOT, IMPORTER_BLOCK);

export function importerBlock(lines: readonly string[]): string {
  return `${lines.join("\n")}\n\n`;
}

export function packageManifest(name: string, dependencies: Record<string, string> = {}): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": { types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts" } },
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    },
    null,
    2,
  )}\n`;
}

export function extractionFiles(): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "pnpm-lock.yaml": LOCKFILE,
    "apps/api/tsconfig.json": `${JSON.stringify({ include: ["src"] }, null, 2)}\n`,
    [DONOR]: "export const widgetValue = 1;\n",
    [CONSUMER]: 'import { widgetValue } from "./widget/widget.ts";\n\nexport const used = widgetValue + 1;\n',
    [`${PACKAGE_ROOT}/package.json`]: packageManifest(PACKAGE),
  };
}

export function baseManifest(root: string): ExtractionManifest {
  const donorHash = hashText(read(root, DONOR));
  const consumerText = read(root, CONSUMER);
  const rewritten = rewriteResolvedImportSpecifier(consumerText, join(root, CONSUMER), join(root, DONOR), PACKAGE, root);
  const barrel = 'export * from "./widget/widget.ts";\n';

  const operations: PlanOperation[] = [
    { kind: "move", source: DONOR, target: TARGET, preconditionHash: donorHash, resultHash: donorHash },
    {
      kind: "rewrite-import",
      file: CONSUMER,
      donors: [DONOR],
      rewrites: [{ from: "./widget/widget.ts", to: PACKAGE }],
      preconditionHash: hashText(consumerText),
      resultHash: hashText(rewritten),
    },
    { kind: "write-file", path: ENTRYPOINT, contents: barrel, preconditionHash: "missing", resultHash: hashText(barrel), generator: "scaffold:entrypoint" },
    {
      kind: "lockfile-importer",
      lockfile: "pnpm-lock.yaml",
      packageRoot: PACKAGE_ROOT,
      block: IMPORTER_BLOCK,
      mode: "insert",
      preconditionHash: hashText(LOCKFILE),
      resultHash: hashText(LOCKFILE_APPLIED),
    },
  ];

  const versioned = fixturePlanVersion(root);

  return {
    ...versioned,
    planId: "fixture-extraction",
    createdAt: new Date().toISOString(),
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("fixture-graph"),
    application: "api",
    target: { packageName: PACKAGE, packageRoot: PACKAGE_ROOT, entrypoint: "src/index.ts", requiredExports: [{ name: "widgetValue", typeOnly: false }] },
    source: { files: [DONOR], tests: [], sccs: { "scc-fixture": [DONOR] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [DONOR]: donorHash },
    operations,
    consumers: [
      {
        file: CONSUMER,
        owner: APP,
        expectedImporter: "./widget/widget.ts",
        specifiers: [{ from: "./widget/widget.ts", to: PACKAGE }],
        external: false,
        dependencySection: "runtime",
      },
    ],
    generatedFiles: [],
    changedFiles: [DONOR, TARGET, CONSUMER, ENTRYPOINT, "pnpm-lock.yaml"].toSorted(),
    lockfileImporter: { packageRoot: PACKAGE_ROOT, hash: hashText(IMPORTER_BLOCK) },
    expectedDynamicImportDelta: { added: [], removed: [] },
    // Every module in this fixture is a bare `export const`, so there is
    // nothing to inventory. A case that *does* have effects lives in
    // `evaluation-effects.test.ts`.
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 4, applicationLinesAfter: 3, consumers: 1 },
    commits: {
      plan: { subject: "chore(@acme/analytics): compile extraction plan fixture-extraction" },
      move: { subject: "refactor(@acme/analytics): move 1 files into libs/analytics", body: "Extraction-Proof: simulated fixture-extraction" },
      wiring: { subject: "refactor(@acme/analytics): wire @acme/analytics into the workspace" },
    },
    gates: { package: [], project: [], workspace: ["true"] },
  };
}

function fixturePlanVersion(root: string): Pick<ExtractionManifest, "schemaVersion" | "provenance"> {
  const configPath = join(root, "monocarve.config.json");
  if (!existsSync(configPath)) return { schemaVersion: 2 };
  const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")), configPath);
  const profile = resolveExtractionProfile(config, getApplication(config, "api"), undefined);
  return {
    schemaVersion: 3,
    provenance: buildPlanProvenance({
      config,
      profileGates: profile.gates,
      scaffoldTemplates: profile.scaffoldTemplates,
      packageManager: createPackageManagerAdapter(config),
      taskRunner: createTaskRunnerAdapter(config),
      rootPackageJson: readFileSync(join(root, "package.json"), "utf8"),
    }),
  };
}

export function landManifest(root: string, manifest: ExtractionManifest): string {
  const path = "plans/fixture-extraction.json";
  write(root, path, `${JSON.stringify(manifest, null, 2)}\n`);
  fixtureGit(root, "add", "--", path);
  fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);
  return path;
}

/**
 * Apply the journal on disk without git. The negative audits need a tree in a
 * particular state; how it got there is not what they are asserting on.
 */
export function landOnDisk(root: string, manifest: ExtractionManifest): void {
  for (const operation of manifest.operations) {
    if (operation.kind === "move" || operation.kind === "move-with-rewrite") {
      const text = read(root, operation.source);
      write(
        root,
        operation.target,
        operation.kind === "move" ? text : text.replace(operation.rewrites[0]!.donorlessSpecifier, operation.rewrites[0]!.packageSpecifier),
      );
      rmSync(join(root, operation.source));
    } else if (operation.kind === "rewrite-import") {
      const current = read(root, operation.file);
      write(
        root,
        operation.file,
        rewriteResolvedImportSpecifier(current, join(root, operation.file), join(root, operation.donors[0]!), operation.rewrites[0]!.to, root),
      );
    } else if (operation.kind === "write-file") {
      write(root, operation.path, operation.contents);
    } else if (operation.kind === "lockfile-importer") {
      write(root, operation.lockfile, pnpmAdapter.applyImporter(read(root, operation.lockfile), operation.packageRoot, operation.block, operation.mode));
    } else {
      throw new Error("fixture does not support path migrations");
    }
  }
}
