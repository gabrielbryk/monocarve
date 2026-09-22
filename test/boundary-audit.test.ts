/**
 * `auditPreparationSync`'s two boundary-preparation proof categories:
 * `retainedRootClearance` (a deleted shim's importers must be provably clear
 * of a value-level import after replay) and `adapterSurfaceParity` (a "port"
 * adapter's exported surface must exactly match its own contract). Both are
 * independent, post-replay re-proofs — they read real files on disk, never
 * trust the manifest's own claims.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { auditPreparationSync } from "../src/prepare/audit.ts";
import { compileBoundaryPreparationManifest, type CompileBoundaryPreparationManifestInput } from "../src/prepare/build.ts";
import { executePreparationJournal } from "../src/prepare/journal.ts";
import type { PreparationManifest } from "../src/prepare/manifest-types.ts";
import { preparationFilesystemOperations } from "../src/prepare/simulate.ts";
import { resolveCommit } from "../src/util/git.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo, write } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] });

const RETAINED = "apps/api/src/config/env.ts";
const RETAINED_SOURCE = 'export const env = "prod";\n';
const IMPORTER = "apps/api/src/orders/service.ts";
const IMPORTER_SOURCE = 'import { env } from "../config/env.ts";\nexport const value = env;\n';

function existingPackageBoundary(): { readonly root: string; readonly config: ReturnType<typeof fixtureConfig>; readonly manifest: PreparationManifest } {
  const root = fixtureRepo({ "apps/api/tsconfig.json": TSCONFIG, [RETAINED]: RETAINED_SOURCE, [IMPORTER]: IMPORTER_SOURCE });
  const config = fixtureConfig(root, {
    compositionBoundaries: [
      { id: "env-shim", retained: RETAINED, strategy: "existing-package", replacement: { specifier: "@acme/env", symbols: ["env"] }, retire: true },
    ],
    preparation: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare env boundary" } },
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
    rendering: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare env boundary" } },
  };
  return { root, config, manifest: compileBoundaryPreparationManifest(input) };
}

const PORT_RETAINED = "apps/api/src/widget.ts";
const PORT_RETAINED_SOURCE = "export interface Widget { amount: number }\n";
const PORT_CONSUMER = "apps/api/src/orders/service.ts";
const PORT_CONSUMER_SOURCE = 'import type { Widget } from "../widget.ts";\nexport function run(input: Widget): void { void input; }\n';
const CONTRACT_TARGET = "libs/ports/src/widget.ts";
const ADAPTER_PATH = "apps/api/src/widget-adapter.ts";
const ADAPTER_TEMPLATE_TEXT = "export class Widget {\n  amount = 0;\n}\n";

function portBoundary(): { readonly root: string; readonly config: ReturnType<typeof fixtureConfig>; readonly manifest: PreparationManifest } {
  const root = fixtureRepo({
    "apps/api/tsconfig.json": TSCONFIG,
    [PORT_RETAINED]: PORT_RETAINED_SOURCE,
    [PORT_CONSUMER]: PORT_CONSUMER_SOURCE,
    "libs/ports/package.json": JSON.stringify({ name: "@acme/ports/widget" }),
  });
  const config = fixtureConfig(root, {
    compositionBoundaries: [
      {
        id: "widget-port",
        retained: PORT_RETAINED,
        strategy: "port",
        contract: "Widget",
        contractModule: "widget",
        appAdapter: ADAPTER_PATH,
        packageImport: "@acme/ports/widget",
        symbols: ["Widget"],
        template: "widget-adapter",
      },
    ],
    preparation: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare widget port boundary" } },
  });
  const baseline = resolveCommit(root, "HEAD");
  const modules: ScanReport["modules"][number][] = [
    { source: PORT_RETAINED, dependencies: [] },
    { source: PORT_CONSUMER, dependencies: [{ module: "../widget.ts", resolved: PORT_RETAINED }] },
  ];
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: baseline.commit });
  const input: CompileBoundaryPreparationManifestInput = {
    rootDir: root,
    config,
    baselineCommit: "HEAD",
    graphDigest: hashText("fixture-workspace-graph"),
    boundaryId: "widget-port",
    graph,
    contractTargetPath: CONTRACT_TARGET,
    adapterTemplateText: ADAPTER_TEMPLATE_TEXT,
    rendering: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare widget port boundary" } },
  };
  return { root, config, manifest: compileBoundaryPreparationManifest(input) };
}

describe("auditPreparationSync — retainedRootClearance", () => {
  test("fails when a value-level import into a retained root survives replay, naming the importer and the edge", () => {
    const { root, config, manifest } = existingPackageBoundary();
    // Deliberately do NOT execute the journal: the importer on disk is still
    // exactly its baseline text, still importing the retained shim by value,
    // even though the manifest's own deletion claims this importer was
    // already rewritten away from it.

    const report = auditPreparationSync({ config, rootDir: root, manifest, freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest } });

    expect(report.retainedRootClearance.passed).toBe(false);
    expect(report.retainedRootClearance.failures).toEqual([`${IMPORTER} still imports a value binding from retained root ../config/env.ts after promotion`]);
  });

  test("passes once the manifest's own rewrite has actually landed on disk", () => {
    const { root, config, manifest } = existingPackageBoundary();
    executePreparationJournal({ rootDir: root, operations: preparationFilesystemOperations(manifest) });

    const report = auditPreparationSync({ config, rootDir: root, manifest, freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest } });

    expect(report.retainedRootClearance.passed).toBe(true);
    expect(report.retainedRootClearance.failures).toEqual([]);
  });
});

describe("auditPreparationSync — adapterSurfaceParity", () => {
  test("fails when the landed adapter's exported surface does not match the landed contract", () => {
    const { root, config, manifest } = portBoundary();
    // The contract is absent from disk (falls back to the manifest's own,
    // correct contents), but a DIFFERENT adapter — with a mismatched export
    // — has actually landed at the declared adapter path. This is exactly
    // the drift class the re-proof exists to catch: a manifest's own claim
    // about its adapter is never enough, only the landed bytes are.
    write(root, ADAPTER_PATH, "export const NotWidget = 1;\n");

    const report = auditPreparationSync({ config, rootDir: root, manifest, freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest } });

    expect(report.adapterSurfaceParity.passed).toBe(false);
    expect(report.adapterSurfaceParity.failures).toHaveLength(1);
    expect(report.adapterSurfaceParity.failures[0]).toContain(ADAPTER_PATH);
    expect(report.adapterSurfaceParity.failures[0]).toContain("missing: Widget");
    expect(report.adapterSurfaceParity.failures[0]).toContain("unexpected: NotWidget");
  });

  test("passes when the landed adapter's surface exactly matches the landed contract", () => {
    const { root, config, manifest } = portBoundary();
    executePreparationJournal({ rootDir: root, operations: preparationFilesystemOperations(manifest) });

    const report = auditPreparationSync({ config, rootDir: root, manifest, freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest } });

    expect(report.adapterSurfaceParity.passed).toBe(true);
    expect(report.adapterSurfaceParity.failures).toEqual([]);
  });

  test("a generated contract and adapter are inside the audited change scope", () => {
    const { root, config, manifest } = portBoundary();
    executePreparationJournal({ rootDir: root, operations: preparationFilesystemOperations(manifest) });

    expect(manifest.changedFiles).toContain(CONTRACT_TARGET);
    expect(manifest.changedFiles).toContain(ADAPTER_PATH);

    const report = auditPreparationSync({ config, rootDir: root, manifest, freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest } });

    expect(report.changedPathScope.passed).toBe(true);
    expect(report.changedPathScope.failures).toEqual([]);
  });
});
