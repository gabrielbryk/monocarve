import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import type { WorkspacePackage } from "../adapters/types.ts";
import type { AssessmentDiagnostic, QualificationStatus } from "../assessment/qualification.ts";
import { qualifyWorkspace } from "../assessment/qualify-workspace.ts";
import { resolveExtractionProfile, scaffoldFor, type LoadedConfig, type MonocarveConfig, type ScaffoldTemplatesConfig } from "../config.ts";
import { NotYetPortedError } from "../errors.ts";
import { statusEntries } from "../util/git.ts";
import { isJsonObject } from "../util/json.ts";

type ConfigValueSource = "explicit" | "default" | "unknown";

export interface ConfigDoctorInput extends Pick<LoadedConfig, "config" | "configPath" | "rootDir"> {
  /** The pre-parse config object, when the caller has it. Enables exact provenance. */
  readonly userConfig?: unknown;
}

interface AdapterStatus {
  readonly configured: string;
  readonly status: "available" | "not-yet-ported";
  readonly detail?: string;
}

export interface ConfigDoctorReport {
  readonly configPath: string;
  readonly rootDir: string;
  readonly effective: readonly { key: string; value: unknown; source: ConfigValueSource }[];
  readonly applications: readonly {
    name: string;
    sourceRoot: string;
    tsconfig: string;
    packageName?: string;
    project?: string;
    sourceRootExists: boolean;
    tsconfigExists: boolean;
    compilerProfile: MonocarveConfig["applications"][number]["compilerProfile"];
  }[];
  readonly packageRoots: readonly { path: string; exists: boolean }[];
  readonly workspacePackages: readonly WorkspacePackage[];
  /**
   * Legacy field: a successful adapter inspection has historically reported
   * `resolved`, even when the workspace matcher emitted a warning. The
   * additive `qualification` record carries that degraded distinction.
   */
  readonly workspaceResolution: { status: "resolved" | "unavailable"; detail?: string };
  /** Additive shared qualification record; legacy doctor fields remain unchanged. */
  readonly qualification: {
    readonly schemaVersion: 1;
    readonly status: QualificationStatus;
    readonly exitCode: 0 | 1 | 2;
    readonly mayPublish: boolean;
    readonly diagnostics: readonly AssessmentDiagnostic[];
    readonly overrides: readonly "allow-empty"[];
  };
  readonly adapters: { packageManager: AdapterStatus; taskRunner: AdapterStatus };
  readonly generatedArtifacts: MonocarveConfig["generatedArtifacts"];
  readonly pathMigrations: MonocarveConfig["pathMigrations"];
  readonly pathReferenceRewrites: MonocarveConfig["pathReferenceRewrites"];
  readonly moduleSpecifierCalls: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly dirtyPaths: readonly string[];
  readonly allowedDirtyPaths: readonly string[];
  readonly semanticIssues: readonly { severity: "error"; context: string; detail: string }[];
  readonly preparation: {
    readonly preparers: readonly { kind: "type-only"; declarations: readonly string[] }[];
    readonly policyConfigured: boolean;
    readonly commitConfigured: boolean;
    readonly gateTiersConfigured: readonly string[];
  };
  readonly boundaries: {
    readonly compositionBoundaries: readonly {
      id: string;
      strategy: "existing-package" | "port";
      retained: string;
      retainedExists: boolean;
      referencedByRetainedRoots: boolean;
    }[];
    readonly portPromotions: readonly {
      id: string;
      appConcreteTypes: readonly string[];
      appConcreteTypeMissingFiles: readonly string[];
      referencedByRetainedRoots: boolean;
    }[];
  };
}

const EFFECTIVE_KEYS = [
  "root",
  "packageRoots",
  "packageScope",
  "firstPartyRoots",
  "firstPartyPackages",
  "packageNamePattern",
  "packageManager",
  "taskRunner",
  "testPathPatterns",
  "moduleSpecifierCalls",
  "assetExtensions",
  "cssImportExtensions",
  "assetEmissionProofs",
  "postJournalPreparers",
  "guardedBranches",
  "gates",
  "graph",
  "pathReferences",
  "pathReferenceRewrites",
  "runtimeModuleRegistries",
  "transaction",
  "extractionProfiles",
  "planDir",
  "campaignDir",
] as const;

/** Build a deterministic, read-only account of the configuration and workspace it resolves. */
export async function inspectConfig(input: ConfigDoctorInput): Promise<ConfigDoctorReport> {
  const raw = objectValue(input.userConfig);
  const packageManager = adapterStatus(input.config.packageManager, () => createPackageManagerAdapter(input.config));
  const taskRunner = adapterStatus(input.config.taskRunner, () => createTaskRunnerAdapter(input.config));
  const workspace = await inspectWorkspaceQualification(input, packageManager);

  const boundaries = boundaryReport(input.config, input.rootDir);
  return {
    configPath: input.configPath,
    rootDir: input.rootDir,
    effective: EFFECTIVE_KEYS.map((key) => ({ key, value: input.config[key], source: valueSource(raw, key) })),
    applications: input.config.applications.map((application) => applicationReport(application, input.rootDir)),
    packageRoots: input.config.packageRoots.map((path) => ({ path, exists: existsSync(join(input.rootDir, path)) })),
    workspacePackages: workspace.packages,
    workspaceResolution: workspace.resolution,
    qualification: workspace.qualification,
    adapters: { packageManager, taskRunner },
    generatedArtifacts: input.config.generatedArtifacts,
    pathMigrations: input.config.pathMigrations,
    pathReferenceRewrites: input.config.pathReferenceRewrites,
    moduleSpecifierCalls: [...input.config.moduleSpecifierCalls].toSorted(),
    protectedPaths: [...input.config.portfolio.protectedPaths].toSorted(),
    dirtyPaths: [...new Set(statusEntries(input.rootDir).flatMap((entry) => entry.paths))].toSorted(),
    allowedDirtyPaths: [...input.config.transaction.allowDirtyPaths].toSorted(),
    semanticIssues: [...scaffoldSemanticIssues(input.config, input.rootDir), ...boundaryIssues(input.config, boundaries)],
    preparation: preparationReport(input.config.preparation),
    boundaries,
  };
}

function valueSource(raw: Record<string, unknown> | undefined, key: string): ConfigValueSource {
  if (raw === undefined) return "unknown";
  return Object.hasOwn(raw, key) ? "explicit" : "default";
}

function applicationReport(application: MonocarveConfig["applications"][number], rootDir: string): ConfigDoctorReport["applications"][number] {
  return {
    name: application.name,
    sourceRoot: application.sourceRoot,
    tsconfig: application.tsconfig,
    ...(application.packageName ? { packageName: application.packageName } : {}),
    ...(application.project ? { project: application.project } : {}),
    sourceRootExists: existsSync(join(rootDir, application.sourceRoot)),
    tsconfigExists: existsSync(join(rootDir, application.tsconfig)),
    compilerProfile: application.compilerProfile,
  };
}

function preparationReport(preparation: MonocarveConfig["preparation"]): ConfigDoctorReport["preparation"] {
  const gates = preparation.gates;
  const gateTiers = gates ? (["package", "project", "workspace"] as const).filter((tier) => gates[tier] !== undefined) : [];
  return {
    preparers: [{ kind: "type-only", declarations: ["interface", "type-alias"] }],
    policyConfigured: preparation.commit !== undefined && gates !== undefined,
    commitConfigured: preparation.commit !== undefined,
    gateTiersConfigured: gateTiers,
  };
}

async function inspectWorkspaceQualification(
  input: ConfigDoctorInput,
  packageManager: AdapterStatus,
): Promise<{
  readonly packages: readonly WorkspacePackage[];
  readonly resolution: ConfigDoctorReport["workspaceResolution"];
  readonly qualification: ConfigDoctorReport["qualification"];
}> {
  const qualified = packageManager.status === "available" ? await qualifyWorkspace({ config: input.config, rootDir: input.rootDir }) : undefined;
  if (qualified !== undefined)
    return {
      packages: qualified.packages.slice().toSorted((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name)),
      // Preserve the pre-assessment config-doctor contract. Unmatched workspace
      // patterns are a qualification warning, not a change to legacy status.
      resolution: { status: qualified.workspaceResolution === "unavailable" ? "unavailable" : "resolved" },
      qualification: qualified.qualification,
    };
  return {
    packages: [],
    resolution: { status: "unavailable", ...(packageManager.detail ? { detail: packageManager.detail } : {}) },
    qualification: {
      schemaVersion: 1,
      status: "fatal",
      exitCode: 1,
      mayPublish: false,
      overrides: [],
      diagnostics: [
        {
          code: "WORKSPACE_DISCOVERY_FAILED",
          severity: "error",
          message: packageManager.detail ?? "package manager adapter is unavailable",
          impact: "Workspace resolution is unavailable.",
        },
      ],
    },
  };
}

/**
 * Surface `compositionBoundaries`/`portPromotions` and the config debt that
 * would otherwise only be caught deep in `resolveBoundaries` or `next`: a
 * retained path or concrete-type file that no longer exists, a boundary no
 * `portfolio.retainedRoots` entry actually reaches (so nothing ever routes a
 * blocked candidate to it), and an id reused across both vocabularies (that
 * vocabulary pair shares one namespace, and a collision otherwise only fails
 * once `resolveBoundaries` runs).
 */
function boundaryReport(config: MonocarveConfig, rootDir: string): ConfigDoctorReport["boundaries"] {
  return {
    compositionBoundaries: config.compositionBoundaries.map((boundary) => ({
      id: boundary.id,
      strategy: boundary.strategy,
      retained: boundary.retained,
      retainedExists: existsSync(join(rootDir, boundary.retained)),
      referencedByRetainedRoots: underAnyRetainedRoot(boundary.retained, config.portfolio.retainedRoots),
    })),
    portPromotions: config.portPromotions.map((promotion) => ({
      id: promotion.id,
      appConcreteTypes: concreteTypeReferences(promotion),
      appConcreteTypeMissingFiles: concreteTypeReferences(promotion)
        .map(concreteTypeFile)
        .filter((path) => !existsSync(join(rootDir, path))),
      referencedByRetainedRoots: promotion.retainedRoots.some((root) => underAnyRetainedRoot(root, config.portfolio.retainedRoots)),
    })),
  };
}

function underAnyRetainedRoot(path: string, retainedRoots: readonly string[]): boolean {
  return retainedRoots.some((root) => pathsOverlap(path, root));
}

/** Equal, or one is an ancestor directory of the other. */
function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function concreteTypeFile(appConcreteType: string): string {
  return appConcreteType.slice(0, appConcreteType.indexOf("#"));
}

function concreteTypeReferences(promotion: MonocarveConfig["portPromotions"][number]): readonly string[] {
  return promotion.appConcreteTypes ?? (promotion.appConcreteType ? [promotion.appConcreteType] : []);
}

type SemanticIssue = ConfigDoctorReport["semanticIssues"][number];

function issue(context: string, detail: string): SemanticIssue {
  return { severity: "error", context, detail };
}

function boundaryIssues(config: MonocarveConfig, boundaries: ConfigDoctorReport["boundaries"]): SemanticIssue[] {
  const compositionIds = new Set(config.compositionBoundaries.map((boundary) => boundary.id));
  return [
    ...boundaries.compositionBoundaries.flatMap(compositionBoundaryIssues),
    ...boundaries.portPromotions.flatMap(portPromotionIssues),
    ...config.portPromotions
      .filter((promotion) => compositionIds.has(promotion.id))
      .map((promotion) =>
        issue(
          "boundaries",
          `id "${promotion.id}" is declared in both compositionBoundaries and portPromotions; boundary ids share one namespace across both vocabularies`,
        ),
      ),
  ];
}

function compositionBoundaryIssues(boundary: ConfigDoctorReport["boundaries"]["compositionBoundaries"][number]): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  if (!boundary.retainedExists) issues.push(issue("compositionBoundaries", `boundary "${boundary.id}" retained path "${boundary.retained}" does not exist`));
  if (!boundary.referencedByRetainedRoots) {
    issues.push(
      issue(
        "compositionBoundaries",
        `boundary "${boundary.id}" is declared but no portfolio.retainedRoots entry reaches "${boundary.retained}"; it can never be offered as a preparation recipe`,
      ),
    );
  }
  return issues;
}

function portPromotionIssues(promotion: ConfigDoctorReport["boundaries"]["portPromotions"][number]): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  if (promotion.appConcreteTypeMissingFiles.length > 0) {
    const missing = promotion.appConcreteTypeMissingFiles.map((path) => JSON.stringify(path)).join(", ");
    issues.push(issue("portPromotions", `promotion "${promotion.id}" app concrete types name files that do not exist: ${missing}`));
  }
  if (!promotion.referencedByRetainedRoots) {
    issues.push(
      issue(
        "portPromotions",
        `promotion "${promotion.id}" is declared but no portfolio.retainedRoots entry overlaps its retainedRoots; it can never be offered as a preparation recipe`,
      ),
    );
  }
  return issues;
}

function scaffoldSemanticIssues(config: MonocarveConfig, rootDir: string): SemanticIssue[] {
  const issues = [...scaffoldTemplateIssues(config, rootDir), ...pathReferenceRewriteIssues(config, rootDir)];
  return issues.filter((entry, index) => issues.findIndex((other) => other.context === entry.context && other.detail === entry.detail) === index);
}

function scaffoldTemplateIssues(config: MonocarveConfig, rootDir: string): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const profiles = Object.keys(config.extractionProfiles.profiles).toSorted();
  const scaffolds = config.applications.flatMap((application) => [
    { templates: scaffoldFor(config, application), context: `application ${application.name}` },
    ...profiles.map((name) => ({
      templates: resolveExtractionProfile(config, application, name).scaffoldTemplates,
      context: `application ${application.name}, profile ${name}`,
    })),
  ]);
  for (const { templates, context } of scaffolds) inspectScaffold(templates, context, rootDir, issues);
  return issues;
}

/** A rewriter must never be looser than, or reach beyond, the scanner that warns about the references it rewrites. */
function pathReferenceRewriteIssues(config: MonocarveConfig, rootDir: string): SemanticIssue[] {
  const rewrites = config.pathReferenceRewrites;
  if (!rewrites.enabled) return [];
  return [
    ...rewritePolicyIssues(config),
    ...rewrites.roots.flatMap((root) => rewriteRootIssues(config, rootDir, root.root)),
    ...rewriteOverlapIssues(rewrites.roots),
  ].map((detail) => issue("pathReferenceRewrites", detail));
}

function rewritePolicyIssues(config: MonocarveConfig): string[] {
  const rewrites = config.pathReferenceRewrites;
  const scanner = config.pathReferences;
  const details: string[] = [];
  if (rewrites.roots.length === 0) details.push("enabled: true but roots is empty; this configuration scans nothing");
  if (rewrites.minSegments < scanner.minSegments) {
    details.push(
      `minSegments (${rewrites.minSegments}) is looser than pathReferences.minSegments (${scanner.minSegments}); the rewriter would mutate references the warning scanner never warned about`,
    );
  }
  if (rewrites.matchExtensionless && !scanner.matchExtensionless) {
    details.push(
      "matchExtensionless is true but pathReferences.matchExtensionless is false; the rewriter would mutate extensionless references the warning scanner never warned about",
    );
  }
  if (!scanner.enabled) {
    details.push(
      "pathReferences.enabled is false while pathReferenceRewrites.enabled is true; the rewriter would mutate references the warning scanner never warned about",
    );
  }
  return details;
}

function rewriteRootIssues(config: MonocarveConfig, rootDir: string, root: string): string[] {
  const details: string[] = [];
  if (!existsSync(join(rootDir, root))) details.push(`root "${root}" does not exist`);
  for (const application of config.applications.filter((entry) => pathsOverlap(root, entry.sourceRoot))) {
    details.push(
      `root "${root}" overlaps with application "${application.name}" sourceRoot "${application.sourceRoot}"; the source scan already covers application source trees`,
    );
  }
  if (!config.pathReferences.textRoots.some((textRoot) => pathsOverlap(root, textRoot.root))) {
    details.push(`root "${root}" is not covered by pathReferences.textRoots; the rewriter would mutate a tree the warning scanner never looked at`);
  }
  return details;
}

function rewriteOverlapIssues(roots: MonocarveConfig["pathReferenceRewrites"]["roots"]): string[] {
  return roots.flatMap((left, index) =>
    roots
      .slice(index + 1)
      .filter((right) => pathsOverlap(left.root, right.root) && left.referenceBase !== right.referenceBase)
      .map(
        (right) => `overlapping roots "${left.root}" and "${right.root}" declare multiple referenceBase values; a document may have only one resolution base`,
      ),
  );
}

function inspectScaffold(templates: ScaffoldTemplatesConfig, context: string, rootDir: string, issues: SemanticIssue[]): void {
  if (templates.publicSurface.mode !== "subpaths") return;
  const source = templates.packageJson;
  const manifest = readTemplateJson(source, rootDir);
  if (!isJsonObject(manifest)) return;
  const exportsValue = manifest.exports;
  if (exportsValue === undefined) return;
  const rootExport = !isJsonObject(exportsValue) || Object.keys(exportsValue).some((key) => key === "." || !key.startsWith("."));
  if (rootExport) {
    issues.push(
      issue(context, "scaffold package template declares a root export, but publicSurface is subpaths-only; remove the root export or select barrel mode"),
    );
  }
}

/** The template's parsed package.json, or `undefined` when it cannot be read or parsed (other checks report that). */
function readTemplateJson(source: ScaffoldTemplatesConfig["packageJson"], rootDir: string): unknown {
  try {
    const text = "contents" in source ? source.contents : readFileSync(join(rootDir, source.file), "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function adapterStatus(configured: string, factory: () => unknown): AdapterStatus {
  try {
    const adapter = factory() as { id: string };
    return { configured: adapter.id, status: "available" };
  } catch (error) {
    if (!(error instanceof NotYetPortedError)) throw error;
    return { configured, status: "not-yet-ported", detail: error.message };
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}
