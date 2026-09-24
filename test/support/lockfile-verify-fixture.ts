/** Shared fixture and manifest builders for lockfile verification proofs. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { pnpmAdapter } from "../../src/adapters/pnpm.ts";
import { rewriteResolvedImportSpecifier } from "../../src/codemod/imports.ts";
import type { ExtractionManifest, PlanOperation } from "../../src/plan/manifest.ts";
import { verifyLockfile } from "../../src/transaction/lockfile-verify.ts";
import { hashText } from "../../src/util/hash.ts";
import { fixtureConfig, fixtureGit, fixtureRepo, read, scratchDirectory, write } from "./fixture-repo.ts";

export const LOCKFILE = pnpmAdapter.lockfileName;
const PACKAGE = "@acme/analytics";
export const PACKAGE_ROOT = "libs/analytics";
export const APP = "apps/api";
const DONOR = "apps/api/src/widget/widget.ts";
const TARGET = "libs/analytics/src/widget/widget.ts";
const CONSUMER = "apps/api/src/consumer.ts";
const ENTRYPOINT = "libs/analytics/src/index.ts";

/** Absent means every pnpm case below reports as skipped, not as passed. */
export const PNPM = Bun.which("pnpm");

export function packageManifest(name: string, dependencies: Record<string, string> = {}): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      main: "./src/index.ts",
      types: "./src/index.ts",
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * A workspace shape, in the only terms that change what pnpm writes.
 *
 * Both flags exist to control which importers come out in pnpm's inline `{}`
 * form, because that form is what the splicer used to be blind to.
 * `siblingDependencies` governs the packages that sort *after* the new one, so
 * turning it off tests whether the insertion still finds its sorted position;
 * `consumerDependencies` governs the consuming application and the new package
 * itself, so turning it off tests whether an inline importer can be found and
 * expanded, and whether a package that declares nothing is rendered the way
 * pnpm renders one.
 */
interface WorkspaceShape {
  readonly siblingDependencies: boolean;
  readonly consumerDependencies: boolean;
}

/** What the consumer and the extracted package declare besides each other. */
function ownDependencies(shape: WorkspaceShape): Record<string, string> {
  return shape.consumerDependencies ? { "@acme/format": "workspace:*" } : {};
}

/** The workspace the plan extracts from, minus the package it creates. */
function workspaceFiles(shape: WorkspaceShape): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - libs/*\n",
    [`${APP}/package.json`]: packageManifest("@acme/api", ownDependencies(shape)),
    [`${APP}/tsconfig.json`]: `${JSON.stringify({ include: ["src"] }, null, 2)}\n`,
    "libs/format/package.json": packageManifest("@acme/format", shape.siblingDependencies ? { "@acme/logger": "workspace:*" } : {}),
    "libs/logger/package.json": packageManifest("@acme/logger", shape.siblingDependencies ? { "@acme/format": "workspace:*" } : {}),
    [DONOR]: "export const widgetValue = 1;\n",
    [CONSUMER]: 'import { widgetValue } from "./widget/widget.ts";\n\nexport const used = widgetValue + 1;\n',
  };
}

/** A scratch workspace whose lockfile is real pnpm's own output, not a fixture. */
export function pnpmWorkspace(shape: WorkspaceShape): string {
  const root = scratchDirectory();
  for (const [path, contents] of Object.entries(workspaceFiles(shape))) write(root, path, contents);
  runPnpm(root);
  return root;
}

export function runPnpm(cwd: string): void {
  const [binary, ...args] = pnpmAdapter.lockfileOnlyCommand();
  const result = Bun.spawnSync([binary!, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((result.exitCode ?? 1) !== 0) throw new Error(`fixture pnpm run failed: ${result.stderr.toString()}`);
}

/** The package the plan creates, and the two splices `scaffold.ts` emits for it. */
export function landExtraction(root: string, shape: WorkspaceShape): void {
  write(root, `${PACKAGE_ROOT}/package.json`, packageManifest(PACKAGE, ownDependencies(shape)));
  write(root, ENTRYPOINT, 'export * from "./widget/widget.ts";\n');
  write(root, `${APP}/package.json`, packageManifest("@acme/api", { [PACKAGE]: "workspace:*", ...ownDependencies(shape) }));
  writeFileSync(join(root, LOCKFILE), splicedLockfile(read(root, LOCKFILE), shape));
}

/** The new package's importer block, as `scaffold.ts` renders it. */
function targetBlock(baseline: string, shape: WorkspaceShape, extra: Record<string, string> = {}): string {
  return `${pnpmAdapter.renderImporterBlock({
    packageRoot: PACKAGE_ROOT,
    dependencies: { ...ownDependencies(shape), ...extra },
    devDependencies: {},
    lockfileText: baseline,
    workspaceRoots: { "@acme/format": "libs/format", "@acme/logger": "libs/logger" },
  })}\n\n`;
}

/** Exactly the adapter calls `scaffold.ts` makes: the new block, then the consumer's. */
function splicedLockfile(baseline: string, shape: WorkspaceShape): string {
  const inserted = pnpmAdapter.insertImporter(baseline, PACKAGE_ROOT, targetBlock(baseline, shape));
  const consumer = pnpmAdapter.importerBlock(inserted, APP);
  // `scaffold.ts` refuses rather than skipping when this is absent, so a helper
  // that quietly produced an unwired lockfile would be testing something the
  // engine cannot emit.
  if (consumer === undefined) throw new Error(`no importer block for the consumer ${APP}`);
  return pnpmAdapter.replaceImporter(
    inserted,
    APP,
    pnpmAdapter.addBlockDependency(consumer, PACKAGE, "workspace:*", pnpmAdapter.linkVersion(APP, PACKAGE_ROOT)),
  );
}

export function verify(workspacePath: string, command: readonly string[]) {
  return verifyLockfile({ workspacePath, lockfileName: LOCKFILE, command });
}
export function simulationFixture(
  shape: WorkspaceShape,
  options: SimulationOptions = {},
): { config: ReturnType<typeof fixtureConfig>; manifest: ExtractionManifest; root: string } {
  const root = fixtureRepo(workspaceFiles(shape));
  runPnpm(root);
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed the lockfile with pnpm's own output");
  const config = fixtureConfig(root, { transaction: { worktreeRoot: scratchDirectory(), nodeModules: "none", cleanup: true, simulateGates: true } });
  return { config, manifest: simulationManifest(root, shape, options), root };
}

interface SimulationOptions {
  /**
   * Splice a dependency into the new package's importer that its own manifest
   * does not declare. Every stage of the pipeline still agrees — the block is
   * what the plan hashed, the journal lands it, the audit re-reads it — and pnpm
   * removes it on the next resolve. That is the divergence only the flag sees.
   */
  readonly overDeclare?: boolean;
}

function simulationManifest(root: string, shape: WorkspaceShape, options: SimulationOptions): ExtractionManifest {
  const donorHash = hashText(read(root, DONOR));
  const consumerText = read(root, CONSUMER);
  const rewritten = rewriteResolvedImportSpecifier(consumerText, join(root, CONSUMER), join(root, DONOR), PACKAGE, root);
  const barrel = 'export * from "./widget/widget.ts";\n';
  const packageJson = packageManifest(PACKAGE, ownDependencies(shape));
  const consumerJson = packageManifest("@acme/api", { [PACKAGE]: "workspace:*", ...ownDependencies(shape) });

  const baseline = read(root, LOCKFILE);
  const block = targetBlock(baseline, shape, options.overDeclare ? { "@acme/logger": "workspace:*" } : {});
  const inserted = pnpmAdapter.insertImporter(baseline, PACKAGE_ROOT, block);
  const consumerBlock = pnpmAdapter.addBlockDependency(
    pnpmAdapter.importerBlock(inserted, APP)!,
    PACKAGE,
    "workspace:*",
    pnpmAdapter.linkVersion(APP, PACKAGE_ROOT),
  );
  const wired = pnpmAdapter.replaceImporter(inserted, APP, consumerBlock);

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
    {
      kind: "write-file",
      path: `${PACKAGE_ROOT}/package.json`,
      contents: packageJson,
      preconditionHash: "missing",
      resultHash: hashText(packageJson),
      generator: "scaffold:package-json",
    },
    { kind: "write-file", path: ENTRYPOINT, contents: barrel, preconditionHash: "missing", resultHash: hashText(barrel), generator: "scaffold:entrypoint" },
    {
      kind: "write-file",
      path: `${APP}/package.json`,
      contents: consumerJson,
      preconditionHash: hashText(read(root, `${APP}/package.json`)),
      resultHash: hashText(consumerJson),
      generator: "wiring:consumer-dependency",
    },
    {
      kind: "lockfile-importer",
      lockfile: LOCKFILE,
      packageRoot: PACKAGE_ROOT,
      block,
      mode: "insert",
      preconditionHash: hashText(baseline),
      resultHash: hashText(inserted),
    },
    {
      kind: "lockfile-importer",
      lockfile: LOCKFILE,
      packageRoot: APP,
      block: consumerBlock,
      mode: "replace",
      preconditionHash: hashText(inserted),
      resultHash: hashText(wired),
    },
  ];

  return {
    schemaVersion: 2,
    planId: "lockfile-verification-fixture",
    createdAt: new Date().toISOString(),
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("lockfile-verification-graph"),
    application: "api",
    target: { packageName: PACKAGE, packageRoot: PACKAGE_ROOT, entrypoint: "src/index.ts", requiredExports: [{ name: "widgetValue", typeOnly: false }] },
    source: { files: [DONOR], tests: [], sccs: { "scc-fixture": [DONOR] } },
    dependencies: { runtime: ownDependencies(shape), dev: {}, packageReferences: shape.consumerDependencies ? ["libs/format"] : [] },
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
    changedFiles: [DONOR, TARGET, CONSUMER, ENTRYPOINT, LOCKFILE, `${APP}/package.json`, `${PACKAGE_ROOT}/package.json`].toSorted(),
    lockfileImporter: { packageRoot: PACKAGE_ROOT, hash: hashText(block) },
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 4, applicationLinesAfter: 3, consumers: 1 },
    commits: {
      move: { subject: `refactor(${PACKAGE}): move 1 files into ${PACKAGE_ROOT}` },
      wiring: { subject: `refactor(${PACKAGE}): wire ${PACKAGE} into the workspace` },
    },
    gates: { package: [], project: [], workspace: ["true"] },
  };
}
