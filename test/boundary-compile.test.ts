/**
 * `compileBoundaryPreparationManifest` — the boundary-preparation compiler
 * (proposal features 2+3) wired through `resolveBoundaries`,
 * `planExistingPackageBoundary`/`planPortBoundary`, and
 * `assertPreparationManifestValid`.
 *
 * This is the first exercise of the compile path after two invariant fixes
 * in `src/prepare/manifest.ts` (`validateGroups`) and
 * `src/prepare/simulate.ts` (`assertPreparationPolicy`) that previously made
 * `boundary compile` throw unconditionally for every non-extraction plan.
 * Every test here either proves the fix works end to end, or names exactly
 * how it still doesn't.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import type { DependencyGraph } from "../src/graph/model.ts";
import { compileBoundaryPreparationManifest, type CompileBoundaryPreparationManifestInput } from "../src/prepare/build.ts";
import { assertPreparationManifestValid, createPreparationManifest } from "../src/prepare/manifest.ts";
import { resolveCommit } from "../src/util/git.ts";
import { byCodeUnit, hashText, stableStringify } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, write } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

const RETAINED = "apps/api/src/config/env.ts";
const RETAINED_SOURCE = 'export const env = "prod";\n';
const IMPORTER = "apps/api/src/orders/service.ts";
const IMPORTER_SOURCE = 'import { env } from "../config/env.ts";\nexport const value = env;\n';
const TEST_IMPORTER = "apps/api/src/orders/service.test.ts";
const TEST_IMPORTER_SOURCE = 'import { env } from "../config/env.ts";\nvoid env;\n';
const MOCK_IMPORTER = "apps/api/src/orders/service.mock.test.ts";
const MOCK_IMPORTER_SOURCE = 'vi.mock("../config/env.ts");\n';

const PORT_RETAINED = "apps/api/src/widget.ts";
const PORT_RETAINED_SOURCE = "export interface Widget { amount: number }\n";
const PORT_CONSUMER = "apps/api/src/orders/service.ts";
const PORT_CONSUMER_SOURCE = 'import type { Widget } from "../widget.ts";\nexport function run(input: Widget): void { void input; }\n';
const CONTRACT_TARGET = "libs/ports/src/widget.ts";
const ADAPTER_PATH = "apps/api/src/widget-adapter.ts";
const ADAPTER_TEMPLATE_TEXT = "export class Widget {\n  amount = 0;\n}\n";

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler", baseUrl: "../../..", paths: { "@acme/env": ["libs/env/src/index.ts"] } },
  include: ["src/**/*.ts"],
});

interface ExistingPackageFixture {
  readonly root: string;
  readonly config: ReturnType<typeof fixtureConfig>;
  readonly graph: DependencyGraph;
  readonly input: CompileBoundaryPreparationManifestInput;
}

/**
 * `env-shim` boundary: one legitimate importer of a retained shim, whose
 * single symbol is fully covered by the declared replacement — the ordinary,
 * fully-satisfiable case.
 */
function existingPackageFixture(overrides: { readonly extraModules?: readonly ScanReport["modules"][number][]; readonly extraFiles?: Readonly<Record<string, string>>; readonly retire?: boolean; readonly selective?: boolean; readonly pathReferences?: boolean; readonly replacementSpecifier?: string } = {}): ExistingPackageFixture {
  const root = fixtureRepo({
    "apps/api/tsconfig.json": TSCONFIG,
    [RETAINED]: RETAINED_SOURCE,
    [IMPORTER]: IMPORTER_SOURCE,
    "libs/env/src/index.ts": 'export const env = "prod";\n',
    ...(overrides.extraFiles ?? {}),
  });
  const config = fixtureConfig(root, {
    moduleSpecifierCalls: ["vi.mock"],
    testKinds: { unit: ["\\.test\\.ts$"], integration: [], e2e: [] },
    compositionBoundaries: [{
      id: "env-shim",
      retained: RETAINED,
      strategy: "existing-package",
      replacement: { specifier: overrides.replacementSpecifier ?? "@acme/env", symbols: ["env"] },
      retire: overrides.retire ?? true,
      selective: overrides.selective ?? false,
    }],
    preparation: {
      gates: { package: [], project: [], workspace: ["true"] },
      commit: { subject: "refactor: prepare env boundary" },
    },
    ...(overrides.pathReferences ? {
      pathReferenceRewrites: {
        enabled: true,
        roots: [{ root: ".agents", extensions: [".md"], mode: "exact-path-token" as const }],
        onAmbiguousMatch: "refuse" as const,
        matchExtensionless: false,
        minSegments: 3,
      },
    } : {}),
  });
  const baseline = resolveCommit(root, "HEAD");
  const modules: ScanReport["modules"][number][] = [
    { source: RETAINED, dependencies: [] },
    { source: IMPORTER, dependencies: [{ module: "../config/env.ts", resolved: RETAINED }] },
    ...(overrides.extraModules ?? []),
  ];
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: baseline.commit });
  const input: CompileBoundaryPreparationManifestInput = {
    rootDir: root,
    config,
    baselineCommit: "HEAD",
    graphDigest: hashText("fixture-workspace-graph"),
    boundaryId: "env-shim",
    graph,
    rendering: {
      gates: { package: [], project: [], workspace: ["true"] },
      commit: { subject: "refactor: prepare env boundary" },
    },
  };
  return { root, config, graph, input };
}

interface PortFixture {
  readonly root: string;
  readonly config: ReturnType<typeof fixtureConfig>;
  readonly graph: DependencyGraph;
  readonly input: CompileBoundaryPreparationManifestInput;
}

function portFixture(overrides: { readonly retainedSource?: string; readonly consumerSource?: string } = {}): PortFixture {
  const root = fixtureRepo({
    "apps/api/tsconfig.json": TSCONFIG,
    [PORT_RETAINED]: overrides.retainedSource ?? PORT_RETAINED_SOURCE,
    [PORT_CONSUMER]: overrides.consumerSource ?? PORT_CONSUMER_SOURCE,
  });
  const config = fixtureConfig(root, {
    compositionBoundaries: [{
      id: "widget-port",
      retained: PORT_RETAINED,
      strategy: "port",
      contract: "Widget",
      contractModule: "widget",
      appAdapter: ADAPTER_PATH,
      packageImport: "@acme/ports/widget",
      symbols: ["Widget"],
      template: "widget-adapter",
    }],
    preparation: {
      gates: { package: [], project: [], workspace: ["true"] },
      commit: { subject: "refactor: prepare widget port boundary" },
    },
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
    rendering: {
      gates: { package: [], project: [], workspace: ["true"] },
      commit: { subject: "refactor: prepare widget port boundary" },
    },
  };
  return { root, config, graph, input };
}

describe("compileBoundaryPreparationManifest — existing-package strategy", () => {
  test("compiles a complete, VALID PreparationManifest end to end (retire:true, one covered importer)", () => {
    const { input, graph } = existingPackageFixture();

    const manifest = compileBoundaryPreparationManifest(input);
    // Redundant with the internal call inside compileBoundaryPreparationManifest,
    // but exercised explicitly here: this is the exact proof the fixed
    // invariant in `validateGroups` exists to make possible.
    expect(() => assertPreparationManifestValid(manifest)).not.toThrow();

    expect(manifest.declarations).toEqual([]);
    expect(manifest.operations).toHaveLength(2);
    const rewrite = manifest.operations.find((op) => op.kind === "rewrite-module-specifier");
    const deletion = manifest.operations.find((op) => op.kind === "delete-module");
    expect(rewrite?.kind).toBe("rewrite-module-specifier");
    expect(deletion?.kind).toBe("delete-module");
    if (rewrite?.kind !== "rewrite-module-specifier" || deletion?.kind !== "delete-module") throw new Error("expected rewrite and deletion operations");
    expect(rewrite.file.path).toBe(IMPORTER);
    expect(rewrite.contents).toBe('import { env } from "@acme/env";\nexport const value = env;\n');
    expect(deletion.file.path).toBe(RETAINED);
    // RETIREMENT SAFETY: importerProof must equal the graph's own importer
    // set for the retained module exactly — not a caller-supplied guess.
    expect(deletion.importerProof).toEqual([...(graph.incoming.get(RETAINED) ?? [])].sort(byCodeUnit));
    expect(manifest.changedFiles).toEqual([IMPORTER, RETAINED].sort(byCodeUnit));
  });

  test("compiles the same config and baseline byte-identically twice (deterministic plan id)", () => {
    const { input } = existingPackageFixture();

    const first = compileBoundaryPreparationManifest(input);
    const second = compileBoundaryPreparationManifest(input);

    expect(second.planId).toBe(first.planId);
    expect(stableStringify(second)).toBe(stableStringify(first));
  });

  test("includes configured test importers in retirement rewrites and proof", () => {
    const { input, graph } = existingPackageFixture({
      extraFiles: { [TEST_IMPORTER]: TEST_IMPORTER_SOURCE },
      extraModules: [{ source: TEST_IMPORTER, dependencies: [{ module: "../config/env.ts", resolved: RETAINED }] }],
    });

    const manifest = compileBoundaryPreparationManifest(input);
    const rewrites = manifest.operations
      .filter((operation) => operation.kind === "rewrite-module-specifier")
      .map((operation) => operation.file.path)
      .sort(byCodeUnit);
    const deletion = manifest.operations.find((operation) => operation.kind === "delete-module");
    expect(graph.testImporters.get(RETAINED)).toContain(TEST_IMPORTER);
    expect(rewrites).toEqual([IMPORTER, TEST_IMPORTER].sort(byCodeUnit));
    expect(deletion?.kind === "delete-module" ? deletion.importerProof : []).toEqual(rewrites);
  });

  test("includes mock-only test consumers in retirement rewrites and proof", () => {
    const { input, graph } = existingPackageFixture({
      extraFiles: { [MOCK_IMPORTER]: MOCK_IMPORTER_SOURCE },
      extraModules: [{ source: MOCK_IMPORTER, dependencies: [] }],
    });

    const manifest = compileBoundaryPreparationManifest(input);
    const rewrite = manifest.operations.find(
      (operation) => operation.kind === "rewrite-module-specifier" && operation.file.path === MOCK_IMPORTER,
    );
    const deletion = manifest.operations.find((operation) => operation.kind === "delete-module");
    expect(graph.testImporters.get(RETAINED)).toContain(MOCK_IMPORTER);
    expect(rewrite?.kind === "rewrite-module-specifier" ? rewrite.contents : "").toBe(
      'vi.mock("@acme/env");\n',
    );
    expect(deletion?.kind === "delete-module" ? deletion.importerProof : []).toContain(MOCK_IMPORTER);
  });

  test("rewrites configured non-source path citations when retiring a shim", () => {
    const citation = ".agents/skills/example/SKILL.md";
    const fixture = existingPackageFixture({
      pathReferences: true,
      replacementSpecifier: "../../../../libs/env/src/index.ts",
      extraFiles: { [citation]: `See ${RETAINED} for the runtime contract.\n` },
    });

    const manifest = compileBoundaryPreparationManifest(fixture.input);
    const operation = manifest.operations.find((item) => item.kind === "write-file" && item.file.path === citation);
    expect(operation).toMatchObject({ kind: "write-file", purpose: "wiring" });
    if (!operation || operation.kind !== "write-file") throw new Error("expected path citation rewrite");
    expect(operation.contents).toContain("libs/env/src/index.ts");
    expect(operation.contents).not.toContain(RETAINED);
  });

  test("selective mode rewrites fully covered importers and retains mixed consumers", () => {
    const mixed = "apps/api/src/orders/mixed.ts";
    const mixedSource = 'import { env, other } from "../config/env.ts";\nexport const values = [env, other];\n';
    const { input } = existingPackageFixture({
      retire: false,
      selective: true,
      extraFiles: { [mixed]: mixedSource },
      extraModules: [{ source: mixed, dependencies: [{ module: "../config/env.ts", resolved: RETAINED }] }],
    });

    const manifest = compileBoundaryPreparationManifest(input);
    expect(manifest.operations).toHaveLength(1);
    expect(manifest.operations[0]?.kind).toBe("rewrite-module-specifier");
    expect(manifest.changedFiles).toEqual([IMPORTER]);
  });

  test("orders a rewrite before a later-path shim deletion and rejects the inverse", () => {
    const earlyImporter = "apps/api/src/admin/consumer.ts";
    const root = fixtureRepo({
      "apps/api/tsconfig.json": TSCONFIG,
      [RETAINED]: RETAINED_SOURCE,
      [earlyImporter]: 'import { env } from "../config/env.ts";\nexport const value = env;\n',
    });
    const config = fixtureConfig(root, {
      compositionBoundaries: [{
        id: "env-shim",
        retained: RETAINED,
        strategy: "existing-package",
        replacement: { specifier: "@acme/env", symbols: ["env"] },
        retire: true,
      }],
      preparation: {
        gates: { package: [], project: [], workspace: ["true"] },
        commit: { subject: "refactor: prepare env boundary" },
      },
    });
    const baseline = resolveCommit(root, "HEAD");
    const graph = buildDependencyGraph({
      config,
      rootDir: root,
      reports: { api: { modules: [
        { source: RETAINED, dependencies: [] },
        { source: earlyImporter, dependencies: [{ module: "../config/env.ts", resolved: RETAINED }] },
      ] } },
      commit: baseline.commit,
    });
    const manifest = compileBoundaryPreparationManifest({
      rootDir: root,
      config,
      baselineCommit: "HEAD",
      graphDigest: hashText("fixture-workspace-graph"),
      boundaryId: "env-shim",
      graph,
      rendering: {
        gates: { package: [], project: [], workspace: ["true"] },
        commit: { subject: "refactor: prepare env boundary" },
      },
    });

    expect(manifest.operations.map((operation) => operation.kind)).toEqual(["rewrite-module-specifier", "delete-module"]);
    expect(() => assertPreparationManifestValid(manifest)).not.toThrow();
    const { planId: _planId, ...draft } = manifest;
    const inverse = createPreparationManifest({ ...draft, operations: [...manifest.operations].reverse() });
    expect(() => assertPreparationManifestValid(inverse)).toThrow(/\[operation-order\] operations must be deterministically ordered/);
  });

  test("RETIREMENT SAFETY: a remaining live importer the graph reports refuses retirement, naming the offending module and symbol", () => {
    const otherImporter = "apps/api/src/orders/other.ts";
    const otherSource = 'import { other } from "../config/env.ts";\nexport const otherValue = other;\n';
    const { root, config } = existingPackageFixture({ retire: true });
    // Add a second, real importer directly to the fixture repo and to the
    // scanned graph — this is the graph-derived importer set, not a
    // caller-supplied list. It imports a symbol the declared replacement
    // does not cover, so the boundary's own consumer-rewrite proof must
    // refuse before any deletion is ever computed.
    write(root, otherImporter, otherSource);
    fixtureGit(root, "add", "-A");
    fixtureGit(root, "commit", "-qm", "test: add uncovered importer");

    const baseline = resolveCommit(root, "HEAD");
    const modules: ScanReport["modules"][number][] = [
      { source: RETAINED, dependencies: [] },
      { source: IMPORTER, dependencies: [{ module: "../config/env.ts", resolved: RETAINED }] },
      { source: otherImporter, dependencies: [{ module: "../config/env.ts", resolved: RETAINED }] },
    ];
    const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: baseline.commit });
    const input: CompileBoundaryPreparationManifestInput = {
      rootDir: root,
      config,
      baselineCommit: "HEAD",
      graphDigest: hashText("fixture-workspace-graph"),
      boundaryId: "env-shim",
      graph,
      rendering: {
        gates: { package: [], project: [], workspace: ["true"] },
        commit: { subject: "refactor: prepare env boundary" },
      },
    };

    expect(() => compileBoundaryPreparationManifest(input)).toThrow(
      `${otherImporter} imports other from ${RETAINED}, which is not in the declared replacement symbol list for boundary env-shim`,
    );
  });

  test("a stale graph (digest/commit not matching the resolved baseline) is refused, naming both commits", () => {
    const { input, graph } = existingPackageFixture();
    const staleGraph: DependencyGraph = { ...graph, commit: "0000000000000000000000000000000000000000" };

    expect(() => compileBoundaryPreparationManifest({ ...input, graph: staleGraph })).toThrow(
      /boundary env-shim importer graph was scanned at 0{40}, but the preparation baseline is [0-9a-f]{40}; rescan before compiling/,
    );
  });
});

describe("compileBoundaryPreparationManifest — port strategy", () => {
  test("ignores a graph importer that binds only retained donor symbols", () => {
    const retainedSource = "export interface Widget { amount: number }\nexport const makeWidget = (): Widget => ({ amount: 0 });\n";
    const consumerSource = 'import { makeWidget } from "../widget.ts";\nexport const value = makeWidget();\n';
    const manifest = compileBoundaryPreparationManifest(portFixture({ retainedSource, consumerSource }).input);

    expect(() => assertPreparationManifestValid(manifest)).not.toThrow();
    expect(manifest.operations.some((operation) => operation.kind === "rewrite-module-specifier")).toBe(false);
    expect(manifest.changedFiles).not.toContain(PORT_CONSUMER);
  });

  test("compiles a valid selective split for a mixed retained/promoted importer", () => {
    const retainedSource = "export interface Widget { amount: number }\nexport const makeWidget = (): Widget => ({ amount: 0 });\n";
    const consumerSource = 'import { type Widget as Input, makeWidget } from "../widget.ts";\nexport const value: Input = makeWidget();\n';
    const manifest = compileBoundaryPreparationManifest(portFixture({ retainedSource, consumerSource }).input);
    const rewrite = manifest.operations.find((operation) => operation.kind === "rewrite-module-specifier");

    expect(() => assertPreparationManifestValid(manifest)).not.toThrow();
    expect(rewrite?.kind).toBe("rewrite-module-specifier");
    if (rewrite?.kind !== "rewrite-module-specifier") throw new Error("expected mixed consumer rewrite");
    expect(rewrite.rewrites).toEqual([{
      from: "../widget.ts", to: "@acme/ports/widget", symbols: ["Widget"], retainedSymbols: ["makeWidget"],
    }]);

    const operations = manifest.operations.map((operation) => operation === rewrite ? {
      ...operation,
      rewrites: operation.rewrites.map(({ retainedSymbols: _omitted, ...entry }) => entry),
    } : operation);
    const { planId: _planId, ...draft } = manifest;
    const tampered = createPreparationManifest({ ...draft, operations });
    expect(() => assertPreparationManifestValid(tampered)).toThrow(/still reference the retired specifier|retain undeclared symbols/);
  });

  test("compiles a complete, VALID PreparationManifest end to end, emitting contract and adapter write-file operations", () => {
    const { input } = portFixture();

    const manifest = compileBoundaryPreparationManifest(input);
    expect(() => assertPreparationManifestValid(manifest)).not.toThrow();

    expect(manifest.declarations).toEqual([]);
    const contract = manifest.operations.find((op) => op.kind === "write-file" && op.purpose === "port-contract");
    const adapter = manifest.operations.find((op) => op.kind === "write-file" && op.purpose === "app-adapter");
    const rewrite = manifest.operations.find((op) => op.kind === "rewrite-module-specifier");
    if (contract?.kind !== "write-file" || adapter?.kind !== "write-file" || rewrite?.kind !== "rewrite-module-specifier") {
      throw new Error("expected contract write, adapter write, and consumer rewrite operations");
    }
    expect(contract.file.path).toBe(CONTRACT_TARGET);
    expect(contract.contents).toBe("export interface Widget { amount: number }\n");
    expect(adapter.file.path).toBe(ADAPTER_PATH);
    expect(adapter.contents).toBe(ADAPTER_TEMPLATE_TEXT);
    expect(rewrite.file.path).toBe(PORT_CONSUMER);
    expect(rewrite.contents).toBe('import type { Widget } from "@acme/ports/widget";\nexport function run(input: Widget): void { void input; }\n');
    expect(manifest.changedFiles).toEqual([ADAPTER_PATH, CONTRACT_TARGET, PORT_CONSUMER].sort(byCodeUnit));
  });

  test("compiles the same config and baseline byte-identically twice (deterministic plan id)", () => {
    const { input } = portFixture();

    const first = compileBoundaryPreparationManifest(input);
    const second = compileBoundaryPreparationManifest(input);

    expect(second.planId).toBe(first.planId);
    expect(stableStringify(second)).toBe(stableStringify(first));
  });

  test("a stale graph is refused, naming the boundary and both commits", () => {
    const { input, graph } = portFixture();
    const staleGraph: DependencyGraph = { ...graph, commit: "1111111111111111111111111111111111111111" };

    expect(() => compileBoundaryPreparationManifest({ ...input, graph: staleGraph })).toThrow(
      /boundary widget-port importer graph was scanned at 1{40}, but the preparation baseline is [0-9a-f]{40}; rescan before compiling/,
    );
  });
});
