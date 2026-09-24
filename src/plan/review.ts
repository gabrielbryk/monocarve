import { byCodeUnit, stableStringify } from "../util/hash.ts";
import type { ExtractionManifest, PlanOperationKind, WriteFileOperation } from "./manifest.ts";
import type { ExportSurface } from "./public-surface.ts";

export interface PlanReviewContext {
  /** Workspace-relative paths observed at the reviewed baseline. */
  readonly baselinePaths?: readonly string[];
  readonly manifestPath?: string;
  readonly approvalSubject?: string;
}

export interface PlanReviewMove {
  readonly kind: "move" | "move-with-rewrite" | "migrate-path-key";
  readonly source: string;
  readonly target: string;
  readonly operationIndex: number;
  readonly nestedIndex?: number;
}

export interface RewrittenDocument {
  readonly path: string;
  readonly rewrites: readonly { readonly from: string; readonly to: string }[];
}

export interface PlanReviewSummary {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly baselineCommit: string;
  readonly assessment?: ExtractionManifest["assessment"];
  readonly target: {
    readonly mode: "new" | "existing" | "unknown";
    readonly root: string;
    readonly name: string;
    readonly entrypoint: string;
    readonly projectId?: string;
    /** Explicit destination directory inside the package, when the plan declares one. */
    readonly subpath?: string;
  };
  /**
   * Boundary violations the plan recorded as already present, which the audit
   * will therefore not fail on. Approving the plan approves this list.
   * `recorded: false` means the manifest carries no baseline at all, so the
   * audit fails on every violation edge it finds.
   */
  readonly boundaryBaseline: {
    readonly recorded: boolean;
    readonly digest?: string;
    readonly edges: readonly { readonly file: string; readonly target: string }[];
  };
  readonly moves: readonly PlanReviewMove[];
  readonly rewrittenDocuments: readonly RewrittenDocument[];
  readonly operationCounts: Readonly<Record<PlanOperationKind, number>>;
  readonly dependencyAdditions: {
    readonly runtime: readonly { readonly name: string; readonly version: string }[];
    readonly dev: readonly { readonly name: string; readonly version: string }[];
    readonly packageReferences: readonly string[];
  };
  readonly consumerRewrites: ExtractionManifest["consumers"];
  readonly exports: { readonly entrypoint: readonly ExportSurface[]; readonly publicModules: NonNullable<ExtractionManifest["target"]["publicModules"]> };
  readonly generatedOutputs: ExtractionManifest["generatedFiles"];
  readonly scaffoldOutputs: readonly { readonly path: string; readonly generator: string }[];
  readonly gates: ExtractionManifest["gates"];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly approval: { readonly subject?: string; readonly manifestPath?: string };
}

const OPERATION_KINDS: readonly PlanOperationKind[] = [
  "move",
  "move-with-rewrite",
  "rewrite-import",
  "rewrite-fs-reference",
  "rewrite-path-reference",
  "write-file",
  "delete-file",
  "lockfile-importer",
  "migrate-path-keys",
];

function sortedEntries(values: Readonly<Record<string, string>>): { name: string; version: string }[] {
  return Object.entries(values)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => ({ name, version }));
}

function targetMode(manifest: ExtractionManifest, paths: readonly string[] | undefined): "new" | "existing" | "unknown" {
  if (!paths) return "unknown";
  const root = manifest.target.packageRoot.replace(/\/+$/, "");
  return paths.some((path) => path === root || path.startsWith(`${root}/`)) ? "existing" : "new";
}

function collectMoves(manifest: ExtractionManifest): PlanReviewMove[] {
  return manifest.operations.flatMap((operation, operationIndex): PlanReviewMove[] => {
    if (operation.kind === "move" || operation.kind === "move-with-rewrite") {
      return [{ kind: operation.kind, source: operation.source, target: operation.target, operationIndex }];
    }
    if (operation.kind !== "migrate-path-keys") return [];
    return operation.moves.map((move, nestedIndex) => ({ kind: "migrate-path-key", source: move.source, target: move.target, operationIndex, nestedIndex }));
  });
}

function collectRewrittenDocuments(manifest: ExtractionManifest): RewrittenDocument[] {
  const byPath = new Map<string, Set<string>>();
  for (const operation of manifest.operations) {
    if (operation.kind !== "rewrite-path-reference") continue;
    const key = operation.file;
    if (!byPath.has(key)) byPath.set(key, new Set());
    const rewrites = byPath.get(key)!;
    for (const rewrite of operation.rewrites) {
      rewrites.add(`${rewrite.from}\x00${rewrite.to}`);
    }
  }
  return Array.from(byPath.entries())
    .toSorted(([pathA], [pathB]) => byCodeUnit(pathA, pathB))
    .map(([path, rewriteSet]) => ({
      path,
      rewrites: Array.from(rewriteSet)
        .toSorted()
        .map((pair) => {
          const separator = pair.indexOf("\x00");
          return { from: pair.slice(0, separator), to: pair.slice(separator + 1) };
        }),
    }));
}

function warnings(manifest: ExtractionManifest, context: PlanReviewContext): PlanReviewSummary["warnings"] {
  const result: { code: string; message: string }[] = [];
  for (const reason of manifest.assessment?.reasons ?? []) result.push({ code: reason.code, message: reason.detail });
  if (!context.baselinePaths) result.push({ code: "target-mode-unknown", message: "Baseline paths were not supplied; target existence is unproven." });
  if (!context.manifestPath) result.push({ code: "approval-path-missing", message: "No manifest path was supplied for approval." });
  if (!(context.approvalSubject ?? manifest.commits.plan?.subject))
    result.push({ code: "approval-subject-missing", message: "No approval commit subject was supplied." });
  // Approving the plan approves this set: the post-apply audit will not fail on
  // these edges. It has to be a warning, not a footnote, because it is the one
  // part of the manifest that makes a proof accept something.
  const baselineEdges = manifest.boundaryBaseline?.edges ?? [];
  if (baselineEdges.length > 0) {
    result.push({
      code: "boundary-baseline-recorded",
      message: `${baselineEdges.length} pre-existing boundary violation edge${baselineEdges.length === 1 ? "" : "s"} are recorded as reviewed; the audit will accept exactly these and fail on any other. Approving this plan approves them.`,
    });
  }
  if (manifest.gates.package.length + manifest.gates.project.length + manifest.gates.workspace.length === 0) {
    result.push({ code: "no-gates", message: "The plan records no repository gates." });
  }
  for (const candidate of manifest.donorDependencyPruning?.candidates ?? []) {
    result.push({
      code: manifest.donorDependencyPruning?.mode === "apply" ? "donor-dependency-pruned" : "donor-dependency-review",
      message: `${candidate.name} (${candidate.section}) has no retained indexed-source reference; verify scripts, config, generators, and other non-source consumers${manifest.donorDependencyPruning?.mode === "apply" ? " before approval" : " before opting into removal"}.`,
    });
  }
  return result;
}

/** Build a deterministic, read-only operator review of an extraction manifest. */
export function summarizePlanReview(manifest: ExtractionManifest, context: PlanReviewContext = {}): PlanReviewSummary {
  const counts = Object.fromEntries(OPERATION_KINDS.map((kind) => [kind, 0])) as Record<PlanOperationKind, number>;
  for (const operation of manifest.operations) counts[operation.kind] += 1;

  const scaffoldOutputs = manifest.operations
    .filter((operation): operation is WriteFileOperation => operation.kind === "write-file" && operation.generator?.startsWith("scaffold:") === true)
    .map((operation) => ({ path: operation.path, generator: operation.generator! }))
    .toSorted((left, right) => left.path.localeCompare(right.path) || left.generator.localeCompare(right.generator));

  return {
    schemaVersion: 1,
    planId: manifest.planId,
    baselineCommit: manifest.baselineCommit,
    ...(manifest.assessment === undefined ? {} : { assessment: manifest.assessment }),
    target: {
      mode: targetMode(manifest, context.baselinePaths),
      root: manifest.target.packageRoot,
      name: manifest.target.packageName,
      entrypoint: manifest.target.entrypoint,
      ...(manifest.target.projectId ? { projectId: manifest.target.projectId } : {}),
      ...(manifest.target.targetSubpath === undefined ? {} : { subpath: manifest.target.targetSubpath }),
    },
    boundaryBaseline: {
      recorded: manifest.boundaryBaseline !== undefined,
      ...(manifest.boundaryBaseline === undefined ? {} : { digest: manifest.boundaryBaseline.digest }),
      edges: (manifest.boundaryBaseline?.edges ?? []).map((edge) => ({ file: edge.file, target: edge.target })),
    },
    moves: collectMoves(manifest),
    rewrittenDocuments: collectRewrittenDocuments(manifest),
    operationCounts: counts,
    dependencyAdditions: {
      runtime: sortedEntries(manifest.dependencies.runtime),
      dev: sortedEntries(manifest.dependencies.dev),
      packageReferences: [...manifest.dependencies.packageReferences].toSorted(),
    },
    consumerRewrites: [...manifest.consumers].toSorted((a, b) => a.file.localeCompare(b.file) || a.owner.localeCompare(b.owner)),
    exports: {
      entrypoint: [...manifest.target.requiredExports],
      publicModules: [...(manifest.target.publicModules ?? [])].toSorted((a, b) => a.exportKey.localeCompare(b.exportKey)),
    },
    generatedOutputs: [...manifest.generatedFiles].toSorted((a, b) => a.path.localeCompare(b.path)),
    scaffoldOutputs,
    gates: { package: [...manifest.gates.package], project: [...manifest.gates.project], workspace: [...manifest.gates.workspace] },
    warnings: warnings(manifest, context),
    approval: {
      ...((context.approvalSubject ?? manifest.commits.plan?.subject) ? { subject: context.approvalSubject ?? manifest.commits.plan!.subject } : {}),
      ...(context.manifestPath ? { manifestPath: context.manifestPath } : {}),
    },
  };
}

export function planReviewJson(summary: PlanReviewSummary): string {
  return `${stableStringify(summary)}\n`;
}

export function formatPlanReview(summary: PlanReviewSummary): string {
  const dependencies = [
    ...summary.dependencyAdditions.runtime.map((entry) => `runtime ${entry.name}@${entry.version}`),
    ...summary.dependencyAdditions.dev.map((entry) => `dev ${entry.name}@${entry.version}`),
    ...summary.dependencyAdditions.packageReferences.map((path) => `reference ${path}`),
  ];
  const lines = [
    `Plan ${summary.planId}`,
    `Target: ${summary.target.name} (${summary.target.mode}) at ${summary.target.root}${summary.target.subpath === undefined ? "" : ` into ${summary.target.subpath}/`}`,
    ...(summary.assessment === undefined
      ? []
      : [
          `Recommendation: ${summary.assessment.status}; cohesion=${summary.assessment.cohesion}`,
          `  selected ${summary.assessment.selectedTarget.action}: ${summary.assessment.selectedTarget.packageName}`,
          ...summary.assessment.targetOptions.map(
            (target) => `  target ${target.action}: ${target.packageName} (${target.confidence}, ${target.compatibility})`,
          ),
        ]),
    ...(summary.warnings.length === 0 ? [] : ["Warnings:", ...summary.warnings.map((warning) => `  [${warning.code}] ${warning.message}`)]),
    summary.boundaryBaseline.recorded
      ? `Pre-existing boundary violations: ${summary.boundaryBaseline.edges.length} (baseline ${summary.boundaryBaseline.digest?.slice(0, 12) ?? "unknown"})`
      : "Pre-existing boundary violations: none recorded (the audit fails on every violation)",
    ...summary.boundaryBaseline.edges.map((edge) => `  ${edge.file} -> ${edge.target}`),
    `Moves: ${summary.moves.length}`,
    ...summary.moves.map((move) => `  ${move.source} -> ${move.target}`),
    ...(summary.rewrittenDocuments.length > 0
      ? [
          `RewrittenDocuments: ${summary.rewrittenDocuments.length}`,
          ...summary.rewrittenDocuments.flatMap((doc) => [`  ${doc.path}`, ...doc.rewrites.map((rewrite) => `    ${rewrite.from} -> ${rewrite.to}`)]),
        ]
      : []),
    `Operations: ${OPERATION_KINDS.map((kind) => `${kind}=${summary.operationCounts[kind]}`).join(", ")}`,
    `Dependencies: runtime=${summary.dependencyAdditions.runtime.length}, dev=${summary.dependencyAdditions.dev.length}, references=${summary.dependencyAdditions.packageReferences.length}`,
    ...dependencies.map((entry) => `  ${entry}`),
    `Consumers: ${summary.consumerRewrites.length}`,
    ...summary.consumerRewrites.map(
      (consumer) => `  ${consumer.file} (${consumer.dependencySection}) -> ${consumer.specifiers.map((rewrite) => rewrite.to).join(", ")}`,
    ),
    `Exports: entrypoint=${summary.exports.entrypoint.length}, public-modules=${summary.exports.publicModules.length}`,
    ...summary.exports.entrypoint.map((entry) => `  ${entry.typeOnly ? "type " : "value "}${entry.name}`),
    ...summary.exports.publicModules.map((entry) => `  ${entry.exportKey} -> ${entry.exportTarget}`),
    `Generated outputs: ${summary.generatedOutputs.length}; scaffold outputs: ${summary.scaffoldOutputs.length}`,
    ...summary.generatedOutputs.map((output) => `  ${output.path} (${output.regenerate})`),
    ...summary.scaffoldOutputs.map((output) => `  ${output.path} (${output.generator})`),
    `Gates: package=${summary.gates.package.length}, project=${summary.gates.project.length}, workspace=${summary.gates.workspace.length}`,
    ...summary.gates.package.map((gate) => `  package: ${gate}`),
    ...summary.gates.project.map((gate) => `  project: ${gate}`),
    ...summary.gates.workspace.map((gate) => `  workspace: ${gate}`),
    `Approval: ${summary.approval.subject ?? "(missing subject)"} @ ${summary.approval.manifestPath ?? "(missing path)"}`,
  ];
  return `${lines.join("\n")}\n`;
}
