import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_NAME } from "../branding.ts";
import { executableBuildIdentity, type ExecutableBuildIdentity } from "../build-identity.ts";
import type { LoadedConfig } from "../config.ts";
import { configFacadeDigest } from "../config/config-facade.ts";
import { MonocarveError, toError } from "../errors.ts";
import { resetGraphCaches, ScanError, scanDependencyReports } from "../graph/cruiser.ts";
import { buildDependencyGraph, type DependencyGraph, type ScanReport } from "../graph/index.ts";
import { graphDigest } from "../plan/build.ts";
import { WorkspaceContext } from "../plan/context.ts";
import { hashBytes, hashJson, type Sha256 } from "../util/hash.ts";
import { inventoryName } from "./input-inventory-paths.ts";
import {
  assertReportsBoundToInventory,
  canonicalInputPath,
  captureInputInventory,
  inventoryBodyDigest,
  InputInventoryError,
  verifyInputInventory,
  type AssessmentInputInventory,
  type CaptureInventoryOptions,
} from "./input-inventory.ts";
import type { AssessmentQualification } from "./qualification.ts";
import { qualifyWorkspace } from "./qualify-workspace.ts";

export class AssessmentQualificationError extends MonocarveError {
  override readonly name = "AssessmentQualificationError";
  constructor(readonly qualification: AssessmentQualification) {
    super(qualification.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("\n") || "assessment qualification failed");
  }
}

function fatal(code: AssessmentQualification["diagnostics"][number]["code"], message: string, paths: readonly string[] = []): AssessmentQualificationError {
  return new AssessmentQualificationError({
    schemaVersion: 1,
    status: "fatal",
    exitCode: 1,
    mayPublish: false,
    overrides: [],
    diagnostics: [
      {
        code,
        severity: "error",
        message,
        impact: "Assessment evidence is not authoritative and no new bundle may be published.",
        ...(paths.length === 0 ? {} : { paths }),
      },
    ],
  });
}

function rethrowInput(error: unknown): never {
  if (error instanceof InputInventoryError) throw fatal(error.code, error.message, error.paths);
  throw toError(error);
}

function assertConfigSnapshotBound(input: LoadedConfig, inventory: AssessmentInputInventory): void {
  if (!input.configSnapshot) return;
  const entries = new Map(inventory.entries.map((entry) => [`${entry.namespace}:${entry.path}`, entry]));
  for (const captured of input.configSnapshot) {
    const named = inventoryName(input.rootDir, captured.path);
    const entry = entries.get(`${named.namespace}:${named.path}`);
    if (!entry || entry.kind !== "file" || entry.sha256 !== captured.sha256 || entry.size !== captured.size) {
      throw fatal("ASSESSMENT_INPUT_DRIFT", `executable config observed bytes that differ from inventory: ${named.path}`, [named.path]);
    }
  }
}

function inventoryAuthority(input: LoadedConfig, excludedRoots?: readonly string[]): CaptureInventoryOptions {
  return {
    config: input.config,
    configPath: input.configPath,
    rootDir: input.rootDir,
    ...(excludedRoots === undefined ? {} : { excludedRoots }),
    ...(input.configSnapshot === undefined ? {} : { configSnapshotPaths: input.configSnapshot.map((entry) => entry.path) }),
  };
}

export interface AssessmentRuntimeIdentity {
  readonly schemaVersion: 1;
  readonly bun: string;
  readonly node: string;
  readonly dependencies: Readonly<Record<string, string>>;
  /** Digest of the config facade module served to sandboxed executable config. */
  readonly configFacade: Sha256;
}

declare const __MONOCARVE_DEPENDENCY_VERSIONS__: Readonly<Record<string, string>> | undefined;

export interface AssessmentBaselineIdentity {
  readonly sourceCommit: string;
  readonly inputDigest: Sha256;
  readonly configDigest: Sha256;
  readonly graphDigest: Sha256;
  readonly executable: ExecutableBuildIdentity;
  readonly runtime: AssessmentRuntimeIdentity;
}

export interface AssessmentSnapshot {
  readonly schemaVersion: 1;
  readonly mode: "live" | "replay";
  readonly config: LoadedConfig["config"];
  readonly configPath: string;
  readonly rootDir: string;
  readonly application: string;
  readonly inputInventory: AssessmentInputInventory;
  readonly reports: Readonly<Record<string, ScanReport>>;
  readonly graph: DependencyGraph;
  readonly context: WorkspaceContext;
  readonly qualification: AssessmentQualification;
  readonly baseline: AssessmentBaselineIdentity;
  /** Revalidate before each dependent analysis and immediately before publication. */
  readonly verify: (additionalExcludedRoots?: readonly string[]) => void;
  readonly readTypeScriptInput: (path: string) => string | undefined;
}

export async function captureAssessmentSnapshot(
  input: LoadedConfig & { readonly application: string; readonly allowEmpty?: boolean; readonly excludedRoots?: readonly string[] },
): Promise<AssessmentSnapshot> {
  // Assessment authority is per snapshot, never a process-global path cache.
  // Clear legacy graph/syntax/workspace facts before capture so a second
  // assessment in one process cannot inherit stale module bytes.
  resetGraphCaches();
  const authority = inventoryAuthority(input, input.excludedRoots);
  let inputInventory: AssessmentInputInventory;
  try {
    inputInventory = captureInputInventory(authority);
  } catch (error) {
    throw fatal("ASSESSMENT_INPUT_UNREADABLE", error instanceof Error ? error.message : String(error));
  }
  assertConfigSnapshotBound(input, inputInventory);
  const verify = (additionalExcludedRoots: readonly string[] = []): void => {
    try {
      verifyInputInventory({ ...authority, excludedRoots: [...(authority.excludedRoots ?? []), ...additionalExcludedRoots] }, inputInventory);
    } catch (error) {
      rethrowInput(error);
    }
  };
  const readTypeScriptInput = inventoryReader(input.rootDir, inputInventory);
  verify();
  let reports: Record<string, ScanReport>;
  try {
    reports = await scanDependencyReports({ config: input.config, rootDir: input.rootDir, application: input.application, noCache: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sourceRootMissing = error instanceof ScanError && /sourceRoot that does not exist/u.test(message);
    const inputMissing = error instanceof ScanError && /tsconfig that does not exist/u.test(message);
    throw fatal(sourceRootMissing ? "SOURCE_ROOT_MISSING" : inputMissing ? "ASSESSMENT_INPUT_MISSING" : "ASSESSMENT_INPUT_UNREADABLE", message);
  }
  try {
    assertReportsBoundToInventory(input.rootDir, inputInventory, reports, true);
  } catch (error) {
    rethrowInput(error);
  }
  verify();
  const qualification = (
    await qualifyWorkspace({
      config: input.config,
      rootDir: input.rootDir,
      application: input.application,
      reports,
      ...(input.allowEmpty ? { allowEmpty: true } : {}),
    })
  ).qualification;
  if (qualification.status === "fatal") throw new AssessmentQualificationError(qualification);
  verify();
  const graph = buildDependencyGraph({ config: input.config, rootDir: input.rootDir, reports, commit: inputInventory.sourceCommit });
  verify();
  return buildSnapshot("live", input, inputInventory, reports, graph, qualification, verify, readTypeScriptInput);
}

export async function replayAssessmentSnapshot(
  input: LoadedConfig & {
    readonly application: string;
    readonly inputInventory: AssessmentInputInventory;
    readonly reports: Readonly<Record<string, ScanReport>>;
    readonly qualification: AssessmentQualification;
    readonly baseline: AssessmentBaselineIdentity;
    readonly excludedRoots?: readonly string[];
  },
): Promise<AssessmentSnapshot> {
  resetGraphCaches();
  const authority = inventoryAuthority(input, input.excludedRoots);
  if (inventoryBodyDigest(input.inputInventory) !== input.inputInventory.digest)
    throw fatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay input inventory digest does not match its serialized body");
  if (input.inputInventory.digest !== input.baseline.inputDigest)
    throw fatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay baseline input digest does not match the input inventory");
  const current = (() => {
    try {
      return captureInputInventory(authority);
    } catch (error) {
      throw fatal("ASSESSMENT_INPUT_UNREADABLE", error instanceof Error ? error.message : String(error));
    }
  })();
  assertConfigSnapshotBound(input, current);
  assertReplayIdentity(input, current);
  const verify = (additionalExcludedRoots: readonly string[] = []): void => {
    try {
      verifyInputInventory({ ...authority, excludedRoots: [...(authority.excludedRoots ?? []), ...additionalExcludedRoots] }, input.inputInventory);
    } catch (error) {
      rethrowInput(error);
    }
  };
  try {
    assertReportsBoundToInventory(input.rootDir, input.inputInventory, input.reports, true);
  } catch (error) {
    rethrowInput(error);
  }
  verify();
  const graph = buildDependencyGraph({ config: input.config, rootDir: input.rootDir, reports: input.reports, commit: input.inputInventory.sourceCommit });
  assertReplayGraphDigest(graph, input.baseline);
  verify();
  await assertReplayQualification(input);
  verify();
  return buildSnapshot(
    "replay",
    input,
    input.inputInventory,
    input.reports,
    graph,
    input.qualification,
    verify,
    inventoryReader(input.rootDir, input.inputInventory),
  );
}

function assertReplayIdentity(
  input: LoadedConfig & { readonly inputInventory: AssessmentInputInventory; readonly baseline: AssessmentBaselineIdentity },
  current: AssessmentInputInventory,
): void {
  const executable = executableBuildIdentity();
  const runtime = runtimeIdentity();
  const mismatches = [
    current.digest === input.inputInventory.digest ? undefined : "input inventory",
    current.sourceCommit === input.baseline.sourceCommit ? undefined : "source commit",
    hashJson(input.config) === input.baseline.configDigest ? undefined : "configuration",
    hashJson(executable) === hashJson(input.baseline.executable) ? undefined : "executable identity",
    hashJson(runtime) === hashJson(input.baseline.runtime) ? undefined : "runtime identity",
  ].filter((entry): entry is string => entry !== undefined);
  if (mismatches.length === 0) return;
  throw new AssessmentQualificationError({
    schemaVersion: 1,
    status: "fatal",
    exitCode: 1,
    mayPublish: false,
    overrides: [],
    diagnostics: [
      {
        code: "ASSESSMENT_REPLAY_INPUT_MISMATCH",
        severity: "error",
        message: `replay authority does not match current ${mismatches.join(", ")}`,
        impact: "Captured scanner output cannot be relabeled as current evidence.",
      },
    ],
  });
}

function assertReplayGraphDigest(graph: DependencyGraph, baseline: AssessmentBaselineIdentity): void {
  if (graphDigest(graph) === baseline.graphDigest) return;
  throw new AssessmentQualificationError({
    schemaVersion: 1,
    status: "fatal",
    exitCode: 1,
    mayPublish: false,
    overrides: [],
    diagnostics: [
      {
        code: "ASSESSMENT_REPLAY_INPUT_MISMATCH",
        severity: "error",
        message: "replayed graph digest does not match the captured graph",
        impact: "Replay evidence is not authoritative for this graph.",
      },
    ],
  });
}

function inventoryReader(rootDir: string, inventory: AssessmentInputInventory): (path: string) => string | undefined {
  return (path) => {
    const absolute = resolve(path);
    const normalized = absolute.replaceAll("\\", "/");
    const root = `${resolve(rootDir).replaceAll("\\", "/").replace(/\/$/u, "")}/`;
    const relative = normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
    const entry = inventory.entries.find((candidate) => candidate.kind === "file" && candidate.canonicalPath === canonicalInputPath(rootDir, normalized));
    if (!entry || entry.kind !== "file")
      throw fatal("ASSESSMENT_INPUT_UNBOUND", `TypeScript read is absent from captured input inventory: ${relative}`, [relative]);
    const bytes = readFileSync(absolute);
    if (hashBytes(bytes) !== entry.sha256)
      throw fatal("ASSESSMENT_INPUT_DRIFT", `TypeScript read differs from captured input inventory: ${relative}`, [relative]);
    return bytes.toString("utf8");
  };
}

async function assertReplayQualification(
  input: LoadedConfig & {
    readonly application: string;
    readonly reports: Readonly<Record<string, ScanReport>>;
    readonly qualification: AssessmentQualification;
  },
): Promise<void> {
  const current = (
    await qualifyWorkspace({
      config: input.config,
      rootDir: input.rootDir,
      application: input.application,
      reports: input.reports,
      ...(input.qualification.overrides.includes("allow-empty") ? { allowEmpty: true } : {}),
    })
  ).qualification;
  if (current.status !== "fatal" && hashJson(current) === hashJson(input.qualification)) return;
  throw fatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay qualification does not match current reports and workspace");
}

function buildSnapshot(
  mode: "live" | "replay",
  input: LoadedConfig & { readonly application: string },
  inputInventory: AssessmentInputInventory,
  reports: Readonly<Record<string, ScanReport>>,
  graph: DependencyGraph,
  qualification: AssessmentQualification,
  verify: () => void,
  readTypeScriptInput: (path: string) => string | undefined,
): AssessmentSnapshot {
  const executable = executableBuildIdentity();
  const runtime = runtimeIdentity();
  return {
    schemaVersion: 1,
    mode,
    config: input.config,
    configPath: input.configPath,
    rootDir: input.rootDir,
    application: input.application,
    inputInventory,
    reports,
    graph,
    context: new WorkspaceContext(input.config, input.rootDir),
    qualification,
    verify,
    readTypeScriptInput,
    baseline: {
      sourceCommit: inputInventory.sourceCommit,
      inputDigest: inputInventory.digest,
      configDigest: hashJson(input.config),
      graphDigest: graphDigest(graph),
      executable,
      runtime,
    },
  };
}

export function runtimeIdentity(): AssessmentRuntimeIdentity {
  const dependencies =
    typeof __MONOCARVE_DEPENDENCY_VERSIONS__ === "object"
      ? __MONOCARVE_DEPENDENCY_VERSIONS__
      : { "dependency-cruiser": installedVersion("dependency-cruiser"), typescript: installedVersion("typescript") };
  return {
    schemaVersion: 1,
    bun: typeof Bun === "undefined" ? "unavailable" : Bun.version,
    node: process.version,
    dependencies,
    configFacade: configFacadeDigest(),
  };
}

function installedVersion(name: string): string {
  let current = dirname(fileURLToPath(import.meta.resolve(name)));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(current, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name === name && typeof manifest.version === "string") return manifest.version;
    } catch {
      /* Ascend to the installed package root. */
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`invariant: could not identify the installed ${name} version; the ${TOOL_NAME} installation is incomplete`);
    current = parent;
  }
}
