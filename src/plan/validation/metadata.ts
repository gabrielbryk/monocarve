import { isSha256, stableStringify } from "../../util/hash.ts";
import { boundaryBaselineDefects } from "../boundary-baseline.ts";
import type { ExtractionManifest } from "../manifest.ts";
import { projectedArtifactEvidence } from "../projected-workspace.ts";
import { Issues } from "./shared.ts";

const COMMIT_SUBJECT = /^(?:refactor|fix|feat|chore|test|docs|ci|build|perf|style)(?:\([^)\n]+\))?!?: [^\n]+$/;

export function validateMetadata(manifest: ExtractionManifest, issues: Issues, containedPath: (path: string, rule: string) => boolean): void {
  validateBoundaryBaselineMetadata(manifest, issues, containedPath);
  validateProjectedArtifactsMetadata(manifest, issues);
  validateDependencyDecisions(manifest, issues, containedPath);
  validateGeneratedFiles(manifest, issues, containedPath);
  validatePostJournalPreparers(manifest, issues, containedPath);
  validateCommitSubjects(manifest, issues);
  validateGateCommands(manifest, issues);
  validateDynamicImportDelta(manifest, issues);
}

function validateBoundaryBaselineMetadata(manifest: ExtractionManifest, issues: Issues, containedPath: (path: string, rule: string) => boolean): void {
  // The recorded baseline is the only field that makes a proof accept
  // something, so it must be canonical before anything is applied: a duplicate,
  // an unsorted entry, or a digest that does not describe the edges beside it
  // means the bytes under review are not the bytes the compiler produces.
  for (const defect of boundaryBaselineDefects(manifest.boundaryBaseline)) issues.add("boundary-baseline", defect);
  for (const edge of manifest.boundaryBaseline?.edges ?? []) {
    containedPath(edge.file, "boundary-baseline");
    containedPath(edge.target, "boundary-baseline");
  }
}

function validateProjectedArtifactsMetadata(manifest: ExtractionManifest, issues: Issues): void {
  const projected = manifest.projectedArtifacts;
  if (projected !== undefined && stableStringify(projected) !== stableStringify(projectedArtifactEvidence(manifest.operations ?? []))) {
    issues.add("projected-artifacts", "projectedArtifacts must exactly describe the final structured operation outputs");
  }
}

function validateDependencyDecisions(manifest: ExtractionManifest, issues: Issues, containedPath: (path: string, rule: string) => boolean): void {
  const decisionKeys = new Set<string>();
  for (const decision of manifest.dependencyDecisions ?? []) {
    const key = `${decision.name}:${decision.decision}`;
    if (decisionKeys.has(key)) issues.add("dependency-evidence", `duplicate dependency decision ${key}`);
    decisionKeys.add(key);
    validateDependencyDecision(manifest, decision, key, issues, containedPath);
  }
  if (manifest.dependencyDecisions !== undefined) validateDecisionCoverage(manifest, decisionKeys, issues);
}

function validateDependencyDecision(
  manifest: ExtractionManifest,
  decision: NonNullable<ExtractionManifest["dependencyDecisions"]>[number],
  key: string,
  issues: Issues,
  containedPath: (path: string, rule: string) => boolean,
): void {
  if (decision.reasons.length === 0) issues.add("dependency-evidence", `dependency decision ${key} has no reason`);
  for (const source of decision.sources) containedPath(source, "dependency-evidence");
  if (decision.decision === "target-runtime" && manifest.dependencies.runtime[decision.name] === undefined)
    issues.add("dependency-evidence", `${key} is absent from runtime dependencies`);
  if (decision.decision === "target-dev" && manifest.dependencies.dev[decision.name] === undefined)
    issues.add("dependency-evidence", `${key} is absent from dev dependencies`);
}

function validateDecisionCoverage(manifest: ExtractionManifest, decisionKeys: ReadonlySet<string>, issues: Issues): void {
  const donorDecision = manifest.donorDependencyPruning?.mode === "apply" ? "donor-remove" : "donor-review";
  const expected = [
    ...Object.keys(manifest.dependencies.runtime).map((name) => `${name}:target-runtime`),
    ...Object.keys(manifest.dependencies.dev).map((name) => `${name}:target-dev`),
    ...(manifest.donorDependencyPruning?.candidates ?? []).map(({ name }) => `${name}:${donorDecision}`),
  ];
  for (const key of expected) if (!decisionKeys.has(key)) issues.add("dependency-evidence", `missing dependency decision ${key}`);
  if (decisionKeys.size !== expected.length) issues.add("dependency-evidence", "dependency decisions contain an undeclared addition or removal");
}

function validateGeneratedFiles(manifest: ExtractionManifest, issues: Issues, containedPath: (path: string, rule: string) => boolean): void {
  for (const generated of manifest.generatedFiles ?? []) {
    containedPath(generated.path, "generated-file");
    containedPath(generated.source, "generated-file");
    if (!generated.regenerate) issues.add("generated-file", `generated file ${generated.path} declares no regenerate command`);
    if (generated.expectedHash !== undefined && !isSha256(generated.expectedHash))
      issues.add("generated-file", `generated file ${generated.path} has an invalid expectedHash`);
    if (generated.expectedHash === undefined && generated.exemptReason === undefined)
      issues.add("generated-file", `generated file ${generated.path} needs expectedHash or exemptReason`);
  }
}

type PostJournalPreparer = NonNullable<ExtractionManifest["postJournalPreparers"]>[number];

function validatePostJournalPreparers(manifest: ExtractionManifest, issues: Issues, containedPath: (path: string, rule: string) => boolean): void {
  const postIds = new Set<string>();
  for (const preparer of manifest.postJournalPreparers ?? []) {
    if (postIds.has(preparer.id)) issues.add("post-journal-preparer", `duplicate post-journal preparer id: ${preparer.id}`);
    postIds.add(preparer.id);
    for (const output of preparer.outputs) containedPath(output, "post-journal-preparer");
    for (const mutation of preparer.mutations) validatePreparerMutation(preparer, mutation, issues, containedPath);
  }
}

function validatePreparerMutation(
  preparer: PostJournalPreparer,
  mutation: PostJournalPreparer["mutations"][number],
  issues: Issues,
  containedPath: (path: string, rule: string) => boolean,
): void {
  containedPath(mutation.path, "post-journal-preparer");
  if (mutation.preconditionHash !== "missing" && !isSha256(mutation.preconditionHash))
    issues.add("post-journal-preparer", `invalid precondition hash: ${mutation.path}`);
  if (!isSha256(mutation.resultHash)) issues.add("post-journal-preparer", `invalid result hash: ${mutation.path}`);
  if (!preparer.outputs.includes(mutation.path)) issues.add("post-journal-preparer", `declarative mutation is not an owned output: ${mutation.path}`);
  if (mutation.preconditionMode !== "missing" && mutation.preconditionMode !== 0o644 && mutation.preconditionMode !== 0o755)
    issues.add("post-journal-preparer", `invalid precondition mode: ${mutation.path}`);
  if (mutation.resultMode !== 0o644 && mutation.resultMode !== 0o755) issues.add("post-journal-preparer", `invalid result mode: ${mutation.path}`);
}

function validateCommitSubjects(manifest: ExtractionManifest, issues: Issues): void {
  for (const [name, commit] of Object.entries(manifest.commits ?? {})) {
    if (commit && !COMMIT_SUBJECT.test(commit.subject)) issues.add("commit-subject", `invalid Conventional Commit subject for the ${name} commit`);
  }
}

function validateGateCommands(manifest: ExtractionManifest, issues: Issues): void {
  for (const tier of ["package", "project", "workspace"] as const) {
    for (const command of manifest.gates?.[tier] ?? []) {
      if (typeof command !== "string" || command.length === 0) issues.add("gates", `gate command in the ${tier} tier must be a non-empty string`);
    }
  }
}

function validateDynamicImportDelta(manifest: ExtractionManifest, issues: Issues): void {
  const delta = manifest.expectedDynamicImportDelta;
  if (!delta || !Array.isArray(delta.added) || !Array.isArray(delta.removed)) {
    issues.add("dynamic-import-delta", "expectedDynamicImportDelta must declare added and removed arrays");
  }
}
