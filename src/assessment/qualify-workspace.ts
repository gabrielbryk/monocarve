import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import ts from "typescript";

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import { WorkspaceDiscoveryError } from "../adapters/workspace-error.ts";
import { getApplication, isTestPath, type MonocarveConfig } from "../config.ts";
import type { ScanReport } from "../graph/build.ts";
import { isSourceModulePath, sourceFiles } from "../util/files.ts";
import { normalizePath } from "../util/paths.ts";
import { qualifyAssessment, type AssessmentDiagnostic, type AssessmentQualification } from "./qualification.ts";

export interface WorkspaceQualificationResult {
  readonly qualification: AssessmentQualification;
  readonly workspaceResolution: "resolved" | "partial" | "unavailable";
  readonly packages: readonly { readonly name: string; readonly dir: string; readonly private?: boolean }[];
}

export async function qualifyWorkspace(input: {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly application?: string;
  readonly reports?: Readonly<Record<string, ScanReport>>;
  readonly allowEmpty?: boolean;
}): Promise<WorkspaceQualificationResult> {
  const diagnostics: AssessmentDiagnostic[] = [];
  if (input.reports !== undefined) diagnostics.push(...validateReports(input.rootDir, input.config, input.application, input.reports));
  const workspace = await inspectWorkspace(input.config, input.rootDir);
  diagnostics.push(...workspace.diagnostics);
  let allowedEmpty = false;
  for (const app of input.application ? [getApplication(input.config, input.application)] : input.config.applications) {
    const result = qualifyApplication(input, app);
    diagnostics.push(...result.diagnostics);
    allowedEmpty ||= result.allowedEmpty;
  }
  return { qualification: qualifyAssessment({ diagnostics, allowedEmpty }), workspaceResolution: workspace.resolution, packages: workspace.packages };
}

type Application = MonocarveConfig["applications"][number];

async function inspectWorkspace(
  config: MonocarveConfig,
  rootDir: string,
): Promise<{
  readonly resolution: WorkspaceQualificationResult["workspaceResolution"];
  readonly packages: WorkspaceQualificationResult["packages"];
  readonly diagnostics: readonly AssessmentDiagnostic[];
}> {
  try {
    const inspection = await createPackageManagerAdapter(config).inspectWorkspace(rootDir);
    const diagnostics = inspection.unmatchedPatterns.map((pattern): AssessmentDiagnostic => ({
      code: "WORKSPACE_PATTERN_UNMATCHED",
      severity: "warning",
      message: `workspace pattern matched no package manifests: ${pattern}`,
      impact: "Package-dependent readiness and resolution metrics are unavailable.",
      patterns: [pattern],
    }));
    return { resolution: diagnostics.length === 0 ? "resolved" : "partial", packages: [...inspection.packages], diagnostics };
  } catch (error) {
    return { resolution: "unavailable", packages: [], diagnostics: [workspaceDiagnostic(error)] };
  }
}

function qualifyApplication(
  input: { readonly config: MonocarveConfig; readonly rootDir: string; readonly reports?: Readonly<Record<string, ScanReport>>; readonly allowEmpty?: boolean },
  app: Application,
): { readonly diagnostics: AssessmentDiagnostic[]; readonly allowedEmpty: boolean } {
  const root = resolve(input.rootDir, app.sourceRoot);
  if (!existsSync(root))
    return {
      diagnostics: [
        {
          code: "SOURCE_ROOT_MISSING",
          severity: "error",
          message: `source root does not exist: ${app.sourceRoot}`,
          impact: "The application cannot be scanned.",
          paths: [app.sourceRoot],
        },
      ],
      allowedEmpty: false,
    };
  const production = readProductionFiles(input, app, root);
  if (Array.isArray(production) === false) return { diagnostics: [production.diagnostic], allowedEmpty: false };
  const report = input.reports?.[app.name];
  if (report === undefined) return { diagnostics: [], allowedEmpty: false };
  const scanned = report.modules
    .map((entry) => normalizePath(entry.source))
    .filter((path) => isInside(root, path) && !isTestPath(input.config, path) && isSourceModulePath(path, input.config.sourceExtensions));
  return evaluateCoverage(input, app, production, scanned);
}

function readProductionFiles(
  input: { readonly config: MonocarveConfig; readonly rootDir: string },
  app: Application,
  root: string,
): string[] | { readonly diagnostic: AssessmentDiagnostic } {
  try {
    return sourceFiles(root, undefined, input.config.sourceExtensions)
      .map((path) => normalizePath(relative(input.rootDir, path)))
      .filter((path) => isSourceModulePath(path, input.config.sourceExtensions) && !isTestPath(input.config, path));
  } catch (error) {
    return {
      diagnostic: {
        code: "ASSESSMENT_INPUT_UNREADABLE",
        severity: "error",
        message: `source root could not be read: ${error instanceof Error ? error.message : String(error)}`,
        impact: "The application cannot be qualified or scanned.",
        paths: [app.sourceRoot],
      },
    };
  }
}

function evaluateCoverage(
  input: { readonly config: MonocarveConfig; readonly rootDir: string; readonly allowEmpty?: boolean },
  app: Application,
  production: readonly string[],
  scanned: readonly string[],
): { readonly diagnostics: AssessmentDiagnostic[]; readonly allowedEmpty: boolean } {
  if (production.length === 0) return emptyCoverage(input.allowEmpty === true, app, scanned);
  const included = tsconfigFiles(input.rootDir, app.tsconfig);
  const excluded = production.filter((path) => !included.has(normalizePath(resolve(input.rootDir, path))));
  if (excluded.length > 0)
    return {
      diagnostics: [
        {
          code: "SCAN_TSCONFIG_EXCLUDES_PRODUCTION",
          severity: "error",
          message: `TypeScript configuration excludes production files for ${app.name}`,
          impact: "Existing application code is outside the scanner's TypeScript program.",
          paths: excluded,
        },
      ],
      allowedEmpty: false,
    };
  const scannedSet = new Set(scanned);
  const missing = production.filter((path) => !scannedSet.has(path));
  if (missing.length === 0) return { diagnostics: [], allowedEmpty: false };
  const code =
    input.config.graph.exclude.length > 0
      ? "SCAN_CONFIGURATION_EXCLUDES_PRODUCTION"
      : scanned.length === 0
        ? "SCAN_UNEXPECTED_EMPTY_GRAPH"
        : "SCAN_REPORT_MALFORMED";
  const message = scanned.length === 0 ? `scanner returned no production modules for ${app.name}` : `scanner omitted production modules for ${app.name}`;
  return {
    diagnostics: [{ code, severity: "error", message, impact: "The scanner output does not cover every configured production file.", paths: missing }],
    allowedEmpty: false,
  };
}

function emptyCoverage(
  allowEmpty: boolean,
  app: Application,
  scanned: readonly string[],
): { readonly diagnostics: AssessmentDiagnostic[]; readonly allowedEmpty: boolean } {
  if (scanned.length > 0)
    return {
      diagnostics: [
        {
          code: "SCAN_REPORT_MALFORMED",
          severity: "error",
          message: `scanner reported production modules beneath ${app.sourceRoot}, but the root contains none`,
          impact: "The scanner output is inconsistent with the configured source root.",
          paths: scanned,
        },
      ],
      allowedEmpty: false,
    };
  if (allowEmpty) return { diagnostics: [], allowedEmpty: true };
  return {
    diagnostics: [
      {
        code: "SOURCE_ROOT_EMPTY",
        severity: "error",
        message: `source root contains no configured production files: ${app.sourceRoot}`,
        impact: "Use --allow-empty only when this verified empty state is intentional.",
        paths: [app.sourceRoot],
      },
    ],
    allowedEmpty: false,
  };
}

/**
 * Validate scanner structure before any graph consumer can silently overwrite
 * duplicate modules or accept paths outside the configured workspace. A
 * plausible failure is a scanner returning one of two modules (or the same
 * module twice); both must be fatal rather than being treated as a qualified
 * partial graph.
 */
function validateReports(
  rootDir: string,
  config: MonocarveConfig,
  application: string | undefined,
  reports: Readonly<Record<string, ScanReport>>,
): AssessmentDiagnostic[] {
  const applications = application === undefined ? config.applications : [getApplication(config, application)];
  const diagnostics: AssessmentDiagnostic[] = [];
  for (const app of applications) {
    const report = reports[app.name];
    if (report === undefined) {
      diagnostics.push({
        code: "SCAN_REPORT_MALFORMED",
        severity: "error",
        message: `scanner returned no report for application ${app.name}`,
        impact: "The graph baseline is incomplete.",
        paths: [app.name],
      });
      continue;
    }
    const seen = new Set<string>();
    for (const module of report.modules) {
      diagnostics.push(...validateReportModule(rootDir, config, app.name, module, seen));
    }
  }
  return deduplicateDiagnostics(diagnostics);
}

function validateReportModule(
  rootDir: string,
  config: MonocarveConfig,
  application: string,
  module: ScanReport["modules"][number],
  seen: Set<string>,
): AssessmentDiagnostic[] {
  const diagnostics: AssessmentDiagnostic[] = [];
  const source = normalizePath(module.source);
  if (seen.has(source))
    diagnostics.push({
      code: "SCAN_REPORT_MALFORMED",
      severity: "error",
      message: `scanner returned duplicate module ${source} for application ${application}`,
      impact: "Duplicate scanner records cannot establish a deterministic graph baseline.",
      paths: [source],
    });
  seen.add(source);
  if (invalidWorkspacePath(rootDir, config, source))
    diagnostics.push({
      code: "SCAN_REPORT_MALFORMED",
      severity: "error",
      message: `scanner returned an invalid module path for application ${application}: ${module.source}`,
      impact: "The graph would read a path outside or absent from the captured workspace.",
      paths: [module.source],
    });
  for (const dependency of module.dependencies) {
    if (dependency.resolved !== undefined && invalidWorkspacePath(rootDir, config, normalizePath(dependency.resolved))) {
      diagnostics.push({
        code: "SCAN_REPORT_MALFORMED",
        severity: "error",
        message: `scanner resolved ${dependency.module} to an invalid path for application ${application}: ${dependency.resolved}`,
        impact: "The graph would rely on a path outside or absent from the captured workspace.",
        paths: [dependency.resolved],
      });
    }
  }
  return diagnostics;
}

function invalidWorkspacePath(rootDir: string, config: MonocarveConfig, path: string): boolean {
  return isUnsafePath(path) || (isConfiguredWorkspacePath(config, path) && !existsSync(resolve(rootDir, path)));
}

function isInside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(root, path)).replaceAll("\\", "/");
  return relativePath !== ".." && !relativePath.startsWith("../") && !isAbsolute(relativePath);
}

function isUnsafePath(path: string): boolean {
  return isAbsolute(path) || path === ".." || path.startsWith("../") || path.split("/").includes("..");
}

function isConfiguredWorkspacePath(config: MonocarveConfig, path: string): boolean {
  const roots = [...config.applications.map((entry) => entry.sourceRoot), ...config.packageRoots, ...config.firstPartyPackages.map((entry) => entry.root)].map(
    (root) => normalizePath(root).replace(/\/$/u, ""),
  );
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function deduplicateDiagnostics(diagnostics: readonly AssessmentDiagnostic[]): AssessmentDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((entry) => {
    const key = `${entry.code}\0${entry.message}\0${(entry.paths ?? []).join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function workspaceDiagnostic(error: unknown): AssessmentDiagnostic {
  if (error instanceof WorkspaceDiscoveryError) {
    const code =
      error.failure === "unsupported-glob"
        ? "WORKSPACE_GLOB_UNSUPPORTED"
        : error.failure === "unsafe-path"
          ? "WORKSPACE_PATH_UNSAFE"
          : error.failure === "duplicate-package"
            ? "WORKSPACE_PACKAGE_DUPLICATE"
            : "WORKSPACE_DISCOVERY_FAILED";
    return {
      code,
      severity: "error",
      message: error.message,
      impact: "Workspace resolution and package-dependent conclusions are unavailable.",
      ...error.evidence,
    };
  }
  return {
    code: "WORKSPACE_DISCOVERY_FAILED",
    severity: "error",
    message: error instanceof Error ? error.message : String(error),
    impact: "Workspace resolution and package-dependent conclusions are unavailable.",
  };
}

function tsconfigFiles(rootDir: string, path: string): ReadonlySet<string> {
  const absolute = resolve(rootDir, path);
  try {
    const read = ts.readConfigFile(absolute, (file) => ts.sys.readFile(file));
    if (read.error) return new Set();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(absolute), undefined, absolute);
    return new Set(parsed.fileNames.map((entry) => normalizePath(resolve(entry))));
  } catch {
    return new Set();
  }
}
