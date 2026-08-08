import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import type { WorkspacePackage } from "../adapters/types.ts";
import { resolveExtractionProfile, scaffoldFor, type LoadedConfig, type MonocarveConfig, type ScaffoldTemplatesConfig } from "../config.ts";
import { NotYetPortedError } from "../errors.ts";
import { statusEntries } from "../util/git.ts";

export type ConfigValueSource = "explicit" | "default" | "unknown";

export interface ConfigDoctorInput extends Pick<LoadedConfig, "config" | "configPath" | "rootDir"> {
  /** The pre-parse config object, when the caller has it. Enables exact provenance. */
  readonly userConfig?: unknown;
}

export interface AdapterStatus {
  readonly configured: string;
  readonly status: "available" | "not-yet-ported";
  readonly detail?: string;
}

export interface ConfigDoctorReport {
  readonly configPath: string;
  readonly rootDir: string;
  readonly effective: readonly { key: string; value: unknown; source: ConfigValueSource }[];
  readonly applications: readonly {
    name: string; sourceRoot: string; tsconfig: string; packageName?: string; project?: string;
    sourceRootExists: boolean; tsconfigExists: boolean; compilerProfile: MonocarveConfig["applications"][number]["compilerProfile"];
  }[];
  readonly packageRoots: readonly { path: string; exists: boolean }[];
  readonly workspacePackages: readonly WorkspacePackage[];
  readonly workspaceResolution: { status: "resolved" | "unavailable"; detail?: string };
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
      id: string; strategy: "existing-package" | "port"; retained: string;
      retainedExists: boolean; referencedByRetainedRoots: boolean;
    }[];
    readonly portPromotions: readonly {
      id: string; appConcreteTypes: readonly string[]; appConcreteTypeMissingFiles: readonly string[];
      referencedByRetainedRoots: boolean;
    }[];
  };
}

const EFFECTIVE_KEYS = [
  "root", "packageRoots", "packageScope", "firstPartyRoots", "firstPartyPackages", "packageNamePattern",
  "packageManager", "taskRunner", "testPathPatterns", "moduleSpecifierCalls",
  "assetExtensions", "cssImportExtensions", "assetEmissionProofs", "postJournalPreparers",
  "guardedBranches", "gates", "graph", "pathReferences", "pathReferenceRewrites", "runtimeModuleRegistries", "transaction", "extractionProfiles", "planDir", "campaignDir",
] as const;

/** Build a deterministic, read-only account of the configuration and workspace it resolves. */
export async function inspectConfig(input: ConfigDoctorInput): Promise<ConfigDoctorReport> {
  const raw = objectValue(input.userConfig);
  const packageManager = adapterStatus(input.config.packageManager, () => createPackageManagerAdapter(input.config));
  const taskRunner = adapterStatus(input.config.taskRunner, () => createTaskRunnerAdapter(input.config));
  let workspacePackages: readonly WorkspacePackage[] = [];
  let workspaceResolution: ConfigDoctorReport["workspaceResolution"] = packageManager.status === "available"
    ? { status: "resolved" }
    : { status: "unavailable", ...(packageManager.detail ? { detail: packageManager.detail } : {}) };
  if (packageManager.status === "available") {
    try {
      workspacePackages = (await createPackageManagerAdapter(input.config).listPackages(input.rootDir))
        .slice().sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name));
    } catch (error) {
      workspaceResolution = { status: "unavailable", detail: errorMessage(error) };
    }
  }

  const preparation = input.config.preparation;
  const gateTiers = preparation.gates
    ? (["package", "project", "workspace"] as const).filter((tier) => preparation.gates?.[tier] !== undefined)
    : [];
  const boundaries = boundaryReport(input.config, input.rootDir);
  return {
    configPath: input.configPath,
    rootDir: input.rootDir,
    effective: EFFECTIVE_KEYS.map((key) => ({
      key, value: input.config[key], source: raw ? (Object.hasOwn(raw, key) ? "explicit" : "default") : "unknown",
    })),
    applications: input.config.applications.map((application) => ({
      name: application.name, sourceRoot: application.sourceRoot, tsconfig: application.tsconfig,
      ...(application.packageName ? { packageName: application.packageName } : {}),
      ...(application.project ? { project: application.project } : {}),
      sourceRootExists: existsSync(join(input.rootDir, application.sourceRoot)),
      tsconfigExists: existsSync(join(input.rootDir, application.tsconfig)),
      compilerProfile: application.compilerProfile,
    })),
    packageRoots: input.config.packageRoots.map((path) => ({ path, exists: existsSync(join(input.rootDir, path)) })),
    workspacePackages,
    workspaceResolution,
    adapters: { packageManager, taskRunner },
    generatedArtifacts: input.config.generatedArtifacts,
    pathMigrations: input.config.pathMigrations,
    pathReferenceRewrites: input.config.pathReferenceRewrites,
    moduleSpecifierCalls: [...input.config.moduleSpecifierCalls].sort(),
    protectedPaths: [...input.config.portfolio.protectedPaths].sort(),
    dirtyPaths: [...new Set(statusEntries(input.rootDir).flatMap((entry) => entry.paths))].sort(),
    allowedDirtyPaths: [...input.config.transaction.allowDirtyPaths].sort(),
    semanticIssues: [...scaffoldSemanticIssues(input.config, input.rootDir), ...boundaryIssues(input.config, boundaries)],
    preparation: {
      preparers: [{ kind: "type-only", declarations: ["interface", "type-alias"] }],
      policyConfigured: preparation.commit !== undefined && preparation.gates !== undefined,
      commitConfigured: preparation.commit !== undefined,
      gateTiersConfigured: gateTiers,
    },
    boundaries,
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
      appConcreteTypeMissingFiles: concreteTypeReferences(promotion).map(concreteTypeFile).filter((path) => !existsSync(join(rootDir, path))),
      referencedByRetainedRoots: promotion.retainedRoots.some((root) => underAnyRetainedRoot(root, config.portfolio.retainedRoots)),
    })),
  };
}

function underAnyRetainedRoot(path: string, retainedRoots: readonly string[]): boolean {
  return retainedRoots.some((root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`));
}

function concreteTypeFile(appConcreteType: string): string {
  return appConcreteType.slice(0, appConcreteType.indexOf("#"));
}

function concreteTypeReferences(promotion: MonocarveConfig["portPromotions"][number]): readonly string[] {
  return promotion.appConcreteTypes ?? (promotion.appConcreteType ? [promotion.appConcreteType] : []);
}

function boundaryIssues(config: MonocarveConfig, boundaries: ConfigDoctorReport["boundaries"]): ConfigDoctorReport["semanticIssues"] {
  const issues: { severity: "error"; context: string; detail: string }[] = [];
  for (const boundary of boundaries.compositionBoundaries) {
    if (!boundary.retainedExists) {
      issues.push({ severity: "error", context: "compositionBoundaries", detail: `boundary "${boundary.id}" retained path "${boundary.retained}" does not exist` });
    }
    if (!boundary.referencedByRetainedRoots) {
      issues.push({ severity: "error", context: "compositionBoundaries", detail: `boundary "${boundary.id}" is declared but no portfolio.retainedRoots entry reaches "${boundary.retained}"; it can never be offered as a preparation recipe` });
    }
  }
  for (const promotion of boundaries.portPromotions) {
    if (promotion.appConcreteTypeMissingFiles.length > 0) {
      issues.push({ severity: "error", context: "portPromotions", detail: `promotion "${promotion.id}" app concrete types name files that do not exist: ${promotion.appConcreteTypeMissingFiles.map((path) => JSON.stringify(path)).join(", ")}` });
    }
    if (!promotion.referencedByRetainedRoots) {
      issues.push({ severity: "error", context: "portPromotions", detail: `promotion "${promotion.id}" is declared but no portfolio.retainedRoots entry overlaps its retainedRoots; it can never be offered as a preparation recipe` });
    }
  }
  const compositionIds = new Set(config.compositionBoundaries.map((boundary) => boundary.id));
  for (const promotion of config.portPromotions) {
    if (compositionIds.has(promotion.id)) {
      issues.push({ severity: "error", context: "boundaries", detail: `id "${promotion.id}" is declared in both compositionBoundaries and portPromotions; boundary ids share one namespace across both vocabularies` });
    }
  }
  return issues;
}

function scaffoldSemanticIssues(config: MonocarveConfig, rootDir: string): ConfigDoctorReport["semanticIssues"] {
  const issues: { severity: "error"; context: string; detail: string }[] = [];
  for (const application of config.applications) {
    inspectScaffold(scaffoldFor(config, application), `application ${application.name}`, rootDir, issues);
    for (const name of Object.keys(config.extractionProfiles.profiles).sort()) {
      inspectScaffold(resolveExtractionProfile(config, application, name).scaffoldTemplates, `application ${application.name}, profile ${name}`, rootDir, issues);
    }
  }
  if (config.pathReferenceRewrites.enabled) {
    if (config.pathReferenceRewrites.roots.length === 0) {
      issues.push({
        severity: "error", context: "pathReferenceRewrites",
        detail: "enabled: true but roots is empty; this configuration scans nothing",
      });
    }
    if (config.pathReferenceRewrites.minSegments < config.pathReferences.minSegments) {
      issues.push({
        severity: "error", context: "pathReferenceRewrites",
        detail: `minSegments (${config.pathReferenceRewrites.minSegments}) is looser than pathReferences.minSegments (${config.pathReferences.minSegments}); the rewriter would mutate references the warning scanner never warned about`,
      });
    }
    if (config.pathReferenceRewrites.matchExtensionless && !config.pathReferences.matchExtensionless) {
      issues.push({
        severity: "error", context: "pathReferenceRewrites",
        detail: "matchExtensionless is true but pathReferences.matchExtensionless is false; the rewriter would mutate extensionless references the warning scanner never warned about",
      });
    }
    if (!config.pathReferences.enabled && config.pathReferenceRewrites.enabled) {
      issues.push({
        severity: "error", context: "pathReferenceRewrites",
        detail: "pathReferences.enabled is false while pathReferenceRewrites.enabled is true; the rewriter would mutate references the warning scanner never warned about",
      });
    }
    for (const root of config.pathReferenceRewrites.roots) {
      const fullPath = join(rootDir, root.root);
      if (!existsSync(fullPath)) {
        issues.push({
          severity: "error", context: "pathReferenceRewrites",
          detail: `root "${root.root}" does not exist`,
        });
      }
      for (const application of config.applications) {
        if (root.root === application.sourceRoot || root.root.startsWith(application.sourceRoot + "/") || application.sourceRoot.startsWith(root.root + "/")) {
          issues.push({
            severity: "error", context: "pathReferenceRewrites",
            detail: `root "${root.root}" overlaps with application "${application.name}" sourceRoot "${application.sourceRoot}"; the source scan already covers application source trees`,
          });
        }
      }
      const covered = config.pathReferences.textRoots.some((textRoot) => root.root === textRoot.root || root.root.startsWith(textRoot.root + "/") || textRoot.root.startsWith(root.root + "/"));
      if (!covered) {
        issues.push({
          severity: "error", context: "pathReferenceRewrites",
          detail: `root "${root.root}" is not covered by pathReferences.textRoots; the rewriter would mutate a tree the warning scanner never looked at`,
        });
      }
    }
  }
  return issues.filter((issue, index) => issues.findIndex((entry) => entry.context === issue.context && entry.detail === issue.detail) === index);
}

function inspectScaffold(
  templates: ScaffoldTemplatesConfig,
  context: string,
  rootDir: string,
  issues: { severity: "error"; context: string; detail: string }[],
): void {
  if (templates.publicSurface.mode !== "subpaths") return;
  const source = templates.packageJson;
  let manifest: unknown;
  try {
    const text = "contents" in source ? source.contents : readFileSync(join(rootDir, source.file), "utf8");
    manifest = JSON.parse(text) as unknown;
  } catch { return; }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return;
  const exportsValue = (manifest as Record<string, unknown>).exports;
  if (exportsValue === undefined) return;
  const rootExport = typeof exportsValue !== "object" || exportsValue === null || Array.isArray(exportsValue) ||
    Object.keys(exportsValue as Record<string, unknown>).some((key) => key === "." || !key.startsWith("."));
  if (rootExport) issues.push({
    severity: "error", context,
    detail: "scaffold package template declares a root export, but publicSurface is subpaths-only; remove the root export or select barrel mode",
  });
}

function adapterStatus(configured: string, factory: () => unknown): AdapterStatus {
  try {
    const adapter = factory() as { id: string };
    return { configured: adapter.id, status: "available" };
  } catch (error) {
    if (error instanceof NotYetPortedError) {
      return { configured, status: "not-yet-ported", detail: error.message };
    }
    throw error;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
