/** Deterministic provenance explanations for one reviewed plan. */

import { byCodeUnit } from "../util/hash.ts";
import { PlanningError } from "./context.ts";
import { operationPaths, type ExtractionManifest } from "./manifest.ts";

export type PlanExplanation = DependencyExplanation | ArtifactExplanation;

export interface DependencyExplanation {
  readonly kind: "dependency";
  readonly planId: string;
  readonly name: string;
  readonly declarations: readonly { readonly section: "runtime" | "dev"; readonly version: string }[];
  readonly decisions: NonNullable<ExtractionManifest["dependencyDecisions"]>;
  readonly pruning?: { readonly mode: "report" | "apply"; readonly section: "runtime" | "dev" | "optional" };
}

export interface ArtifactExplanation {
  readonly kind: "artifact";
  readonly planId: string;
  readonly path: string;
  readonly projection?: NonNullable<ExtractionManifest["projectedArtifacts"]>[number];
  readonly operations: readonly { readonly index: number; readonly kind: string; readonly generator?: string; readonly paths: readonly string[] }[];
}

export function explainDependency(manifest: ExtractionManifest, name: string): DependencyExplanation {
  const declarations = (["runtime", "dev"] as const).flatMap((section) => {
    const version = manifest.dependencies[section][name];
    return version === undefined ? [] : [{ section, version }];
  });
  const decisions = (manifest.dependencyDecisions ?? []).filter((entry) => entry.name === name);
  const candidate = manifest.donorDependencyPruning?.candidates.find((entry) => entry.name === name);
  if (declarations.length === 0 && decisions.length === 0 && candidate === undefined) {
    throw new PlanningError(`plan ${manifest.planId} has no dependency evidence for ${name}`);
  }
  return {
    kind: "dependency",
    planId: manifest.planId,
    name,
    declarations,
    decisions,
    ...(candidate === undefined ? {} : { pruning: { mode: manifest.donorDependencyPruning!.mode, section: candidate.section } }),
  };
}

export function explainArtifact(manifest: ExtractionManifest, path: string): ArtifactExplanation {
  const operations = manifest.operations.flatMap((operation, index) => {
    const paths = operationPaths(operation);
    return paths.includes(path)
      ? [{ index, kind: operation.kind, ...(operation.kind === "write-file" && operation.generator ? { generator: operation.generator } : {}), paths }]
      : [];
  });
  const projection = manifest.projectedArtifacts?.find((entry) => entry.path === path);
  if (operations.length === 0 && projection === undefined) throw new PlanningError(`plan ${manifest.planId} does not affect artifact ${path}`);
  return { kind: "artifact", planId: manifest.planId, path, ...(projection === undefined ? {} : { projection }), operations };
}

export function formatPlanExplanation(explanation: PlanExplanation): string {
  if (explanation.kind === "artifact")
    return (
      [
        `Artifact ${explanation.path}`,
        explanation.projection
          ? `Final ${explanation.projection.kind} hash: ${explanation.projection.resultHash}`
          : "Final hash: carried by move/rewrite evidence",
        ...explanation.operations.map(
          (operation) => `  operation ${operation.index}: ${operation.kind}${operation.generator ? ` (${operation.generator})` : ""}`,
        ),
      ].join("\n") + "\n"
    );
  return (
    [
      `Dependency ${explanation.name}`,
      ...explanation.declarations.map(({ section, version }) => `  target ${section}: ${version}`),
      ...[...explanation.decisions]
        .sort((left, right) => byCodeUnit(left.decision, right.decision))
        .map((decision) => `  ${decision.decision}: ${decision.reasons.join(", ")}${decision.sources.length ? ` from ${decision.sources.join(", ")}` : ""}`),
      ...(explanation.pruning ? [`  donor ${explanation.pruning.mode}: ${explanation.pruning.section}`] : []),
    ].join("\n") + "\n"
  );
}
