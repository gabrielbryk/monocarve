import ts from "typescript";

import { PlanValidationError } from "../errors.ts";
import { byCodeUnit, hashJson, hashText, isSha256, stableStringify } from "../util/hash.ts";
import {
  groupKey,
  isIsoDate,
  isModuleSpecifier,
  isWorkspacePath,
  reportOverlaps,
  validateMutation,
  validateSorted,
  validateSortedStrings,
  type AddIssue,
} from "./manifest-checks.ts";
import { validateExtractOperation } from "./manifest-extract.ts";
import { validateDeletionRecipe, validatePortPackageExportRecipe, validateRewriteRecipe } from "./manifest-recipe.ts";
import {
  PREPARATION_MANIFEST_SCHEMA_VERSION,
  type CompatibilityReexportIntent,
  type ExtractTypeDeclarationsOperation,
  type PreparationDeclarationGroupSelector,
  type PreparationDeclarationSelector,
  type PreparationManifest,
  type PreparationManifestDraft,
  type PreparationReplayOperation,
  type PreparationValidationIssue,
  type PreparationValidationResult,
  type ValidatePreparationManifestOptions,
} from "./manifest-types.ts";

const COMMIT_HASH = /^[0-9a-f]{7,64}$/;
const COMMIT_SUBJECT = /^(?:refactor|fix|feat|chore|test|docs|ci|build|perf|style)(?:\([^)\n]+\))?!?: [^\n]+$/;

/** Builds the deterministic identity from every manifest field except planId. */
function preparationPlanId(draft: PreparationManifestDraft): string {
  return `prepare-${hashJson(draft)}`;
}

/** Attaches the only valid plan id to a prepared manifest draft. */
export function createPreparationManifest(draft: PreparationManifestDraft): PreparationManifest {
  return { ...draft, planId: preparationPlanId(draft) };
}

/** Canonical, reviewable bytes for an independently replayable preparation plan. */
export function serializePreparationManifest(manifest: PreparationManifest): string {
  return `${stableStringify(manifest, 2)}\n`;
}

/** Every workspace-relative path the replay operations mutate. */
export function preparationOperationPaths(operation: PreparationReplayOperation): readonly string[] {
  return operation.kind === "extract-type-declarations" ? [operation.donor.path, operation.target.path] : [operation.file.path];
}

/**
 * Checks only supplied data; it never reads the repository. A caller that
 * supplies current file states or contents receives stale-input detection
 * without coupling this structural layer to filesystem access.
 */
export function validatePreparationManifest(manifest: PreparationManifest, options: ValidatePreparationManifestOptions = {}): PreparationValidationResult {
  const issues: PreparationValidationIssue[] = [];
  const add = (rule: string, message: string, path?: string): void => {
    issues.push(path === undefined ? { rule, message } : { rule, message, path });
  };

  validateHeader(manifest, add);
  validateGroups(manifest, add);
  validateOperations(manifest, add);
  validateCompatibility(manifest, add);
  validateScope(manifest, add);
  validateLiveState(manifest, options, add);
  return { ok: issues.length === 0, issues };
}

/** Throwing boundary for CLI, apply, and audit code. */
export function assertPreparationManifestValid(manifest: PreparationManifest, options: ValidatePreparationManifestOptions = {}): void {
  const result = validatePreparationManifest(manifest, options);
  if (result.ok) return;
  throw new PlanValidationError(
    `preparation plan ${manifest.planId} failed validation with ${result.issues.length} error(s):\n${result.issues.map((issue) => `  [${issue.rule}] ${issue.message}`).join("\n")}`,
    result.issues.map((issue) => issue.message),
  );
}

function validateHeader(manifest: PreparationManifest, add: AddIssue): void {
  if (manifest.schemaVersion !== PREPARATION_MANIFEST_SCHEMA_VERSION) add("schema-version", `schemaVersion must be ${PREPARATION_MANIFEST_SCHEMA_VERSION}`);
  if (!manifest.planId) add("plan-id", "planId must be a non-empty string");
  else if (manifest.planId !== preparationPlanId(withoutPlanId(manifest))) add("plan-id", "planId does not match the deterministic manifest identity");
  if (!manifest.generator?.name || !manifest.generator.version) add("generator", "generator must include non-empty name and version");
  if (!COMMIT_HASH.test(manifest.baseline?.commit ?? "")) add("baseline-commit", "baseline.commit must be a git commit hash");
  if (!isSha256(manifest.baseline?.configDigest ?? "")) add("config-digest", "baseline.configDigest must be a SHA-256 hash");
  if (!isSha256(manifest.graphDigest ?? "")) add("graph-digest", "graphDigest must be a SHA-256 hash");
  if (!isIsoDate(manifest.baseline?.committerDate)) add("baseline-date", "baseline.committerDate must be an ISO date");
  if (!isIsoDate(manifest.createdAt)) add("created-at", "createdAt must be an ISO date");
  if (manifest.createdAt !== manifest.baseline?.committerDate) add("created-at", "createdAt must equal the baseline committer date");
  if (!COMMIT_SUBJECT.test(manifest.commits?.prepare?.subject ?? "")) add("commit-subject", "prepare commit subject must be a single-line Conventional Commit");
  for (const tier of ["package", "project", "workspace"] as const) validateSortedStrings(manifest.gates?.[tier], `gates-${tier}`, `gates.${tier}`, add);
}

/**
 * A type-only extraction is selected by declaration group, so a manifest that
 * carries one must name the groups it moved. A boundary preparation carries
 * none: rewriting a specifier or deleting a retired shim selects no
 * declaration, and `declarations: []` is the honest answer rather than a
 * missing field. What must never be empty is the manifest as a whole — a plan
 * that selects nothing and mutates nothing is not a preparation.
 */
function validateGroups(manifest: PreparationManifest, add: AddIssue): void {
  const groups = manifest.declarations;
  const extracts = manifest.operations.some((operation) => operation.kind === "extract-type-declarations");
  if (groups.length === 0 && extracts) {
    add("declarations", "a type-declaration extraction must select at least one complete type group");
  }
  if (groups.length === 0 && manifest.operations.length === 0) {
    add("declarations", "a preparation must either select a declaration group or carry at least one operation");
  }
  validateSorted(groups, groupKey, "declaration-order", "declarations must be sorted by source path, first span, and group id", add);
  const seen: SeenGroupIdentities = { groupIds: new Set(), groupNames: new Set(), declarationIds: new Set() };
  const declarationsByPath = new Map<string, PreparationDeclarationSelector[]>();
  for (const group of groups) {
    validateGroupIdentity(group, seen, add);
    validateGroupDeclarations(group, seen, declarationsByPath, add);
  }
  for (const [path, declarations] of declarationsByPath) {
    reportOverlaps(
      declarations,
      (item) => item.span,
      (item) => item.declarationId,
      (previous, current) => add("declaration-span", `declaration span for ${current.name} overlaps ${previous.name}`, path),
    );
  }
  for (const [path, declarations] of declarationsByPath) {
    reportOverlaps(
      declarations,
      (item) => ({ start: item.extractionStart, end: item.extractionEnd }),
      (item) => item.selectorId,
      (previous, current) => add("extraction-region", `extraction region for ${current.name} overlaps ${previous.name}`, path),
    );
  }
}

interface SeenGroupIdentities {
  readonly groupIds: Set<string>;
  readonly groupNames: Set<string>;
  readonly declarationIds: Set<string>;
}

function validateGroupIdentity(group: PreparationDeclarationGroupSelector, seen: SeenGroupIdentities, add: AddIssue): void {
  const groupLabel = `${group.sourcePath}\u0000${group.name}`;
  if (seen.groupIds.has(group.groupId)) add("declaration-group", `duplicate declaration group ${group.groupId}`, group.sourcePath);
  seen.groupIds.add(group.groupId);
  if (seen.groupNames.has(groupLabel)) add("declaration-group", `ambiguous groups share ${group.name} in ${group.sourcePath}`, group.sourcePath);
  seen.groupNames.add(groupLabel);
  if (!isWorkspacePath(group.sourcePath)) add("declaration-path", "declaration group sourcePath must be workspace-relative", group.sourcePath);
  if (!group.name || group.space !== "type") add("declaration-group", "declaration groups must have a non-empty name and type-only space", group.sourcePath);
  if (group.declarations.length === 0) add("declaration-group", "declaration groups cannot be empty", group.sourcePath);
  if (group.groupId !== hashJson({ sourcePath: group.sourcePath, name: group.name, declarationIds: group.declarations.map((item) => item.declarationId) })) {
    add("declaration-group", `group id for ${group.name} does not match its declaration identities`, group.sourcePath);
  }
  validateSorted(group.declarations, declarationKey, "declaration-order", `declarations in ${group.name} must be span-sorted`, add);
}

function validateGroupDeclarations(
  group: PreparationDeclarationGroupSelector,
  seen: SeenGroupIdentities,
  declarationsByPath: Map<string, PreparationDeclarationSelector[]>,
  add: AddIssue,
): void {
  for (const declaration of group.declarations) {
    validateDeclaration(declaration, group, add);
    if (seen.declarationIds.has(declaration.declarationId)) add("declaration", `duplicate declaration ${declaration.declarationId}`, declaration.sourcePath);
    seen.declarationIds.add(declaration.declarationId);
    declarationsByPath.set(declaration.sourcePath, [...(declarationsByPath.get(declaration.sourcePath) ?? []), declaration]);
  }
}

function validateDeclaration(declaration: PreparationDeclarationSelector, group: PreparationDeclarationGroupSelector, add: AddIssue): void {
  const path = declaration.sourcePath;
  if (!isWorkspacePath(path)) add("declaration-path", "declaration sourcePath must be workspace-relative", path);
  if (!hasSha256Identities(declaration)) add("declaration-hash", "declaration, selector, source, span, and extraction hashes must be SHA-256 values", path);
  if (path !== group.sourcePath || declaration.name !== group.name || declaration.space !== "type")
    add("declaration-group", "every group member must match its group source, name, and type-only space", path);
  if (typeof declaration.originallyExported !== "boolean") add("declaration-export", "declaration originallyExported must be boolean", path);
  if (declaration.kind !== "interface" && declaration.kind !== "type-alias")
    add("declaration-kind", "only interfaces and type aliases are eligible for type-only extraction", path);
  if (!hasNonEmptySpan(declaration)) add("declaration-span", "declaration span must be a non-empty pair of UTF-16 offsets", path);
  if (declaration.declarationId !== declarationId(declaration)) {
    add("declaration-id", `declaration id for ${declaration.name} does not match its selector`, path);
  }
  if (extractionMissesSpan(declaration)) {
    add("extraction-region", "extraction region must contain its declaration span", path);
  }
  if (declaration.selectorId !== selectorId(declaration)) add("selector-id", `selector id for ${declaration.name} does not match its removal recipe`, path);
}

function hasSha256Identities(declaration: PreparationDeclarationSelector): boolean {
  return (
    isSha256(declaration.declarationId) &&
    isSha256(declaration.selectorId) &&
    isSha256(declaration.sourceHash) &&
    isSha256(declaration.span?.hash ?? "") &&
    isSha256(declaration.extractionHash)
  );
}

function hasNonEmptySpan(declaration: PreparationDeclarationSelector): boolean {
  return (
    Number.isInteger(declaration.span?.start) &&
    Number.isInteger(declaration.span?.end) &&
    declaration.span.start >= 0 &&
    declaration.span.end > declaration.span.start
  );
}

function extractionMissesSpan(declaration: PreparationDeclarationSelector): boolean {
  return (
    !Number.isInteger(declaration.extractionStart) ||
    !Number.isInteger(declaration.extractionEnd) ||
    declaration.extractionStart < 0 ||
    declaration.extractionEnd < declaration.extractionStart ||
    declaration.extractionStart > declaration.span.start ||
    declaration.extractionEnd < declaration.span.end
  );
}

function declarationId(declaration: PreparationDeclarationSelector): string {
  return hashJson({
    sourcePath: declaration.sourcePath,
    name: declaration.name,
    kind: declaration.kind,
    start: declaration.span.start,
    end: declaration.span.end,
    spanHash: declaration.span.hash,
  });
}

function validateOperations(manifest: PreparationManifest, add: AddIssue): void {
  if (manifest.operations.length === 0) add("operations", "operations must not be empty");
  validateSorted(manifest.operations, operationKey, "operation-order", "operations must be deterministically ordered", add);
  const mutationPaths = new Set<string>();
  const groupById = new Map(manifest.declarations.map((group) => [group.groupId, group]));
  const includedGroups = new Set<string>();
  for (const operation of manifest.operations) {
    validateOperationPaths(operation, mutationPaths, add);
    if (isFileOperation(operation)) validateFileOperation(operation, manifest.operations, add);
    else validateExtractOperation(operation, groupById, includedGroups, add);
  }
  validatePortPackageExportRecipe(manifest.operations, add);
  if (includedGroups.size !== groupById.size) add("operation-declarations", "operations must include every declared extraction group exactly once");
}

function validateOperationPaths(operation: PreparationReplayOperation, mutationPaths: Set<string>, add: AddIssue): void {
  for (const path of preparationOperationPaths(operation)) {
    if (!isWorkspacePath(path)) add("operation-path", "operation path must be workspace-relative", path);
    if (mutationPaths.has(path)) add("operation-path", `multiple operations mutate ${path}`, path);
    mutationPaths.add(path);
  }
}

type FileOperation = Exclude<PreparationReplayOperation, ExtractTypeDeclarationsOperation>;

const FILE_OPERATION_KINDS: ReadonlySet<string> = new Set<FileOperation["kind"]>([
  "write-file",
  "rewrite-module-specifier",
  "delete-module",
  "adopt-generated-source",
  "delete-generated-source-generator",
]);

/** Anything else is validated as an extraction, exactly as an unrecognized kind always has been. */
function isFileOperation(operation: PreparationReplayOperation): operation is FileOperation {
  return FILE_OPERATION_KINDS.has(operation.kind);
}

function validateFileOperation(operation: FileOperation, operations: readonly PreparationReplayOperation[], add: AddIssue): void {
  switch (operation.kind) {
    case "write-file":
      validateMutation(operation.file, operation.contents, "write-file", add);
      return;
    case "rewrite-module-specifier":
      validateMutation(operation.file, operation.contents, "rewrite-specifier", add);
      validateRewriteRecipe(operation, add);
      return;
    case "delete-module":
      validateDeletionRecipe(operation, operations, add);
      return;
    case "adopt-generated-source":
      validateAdoption(operation, add);
      return;
    case "delete-generated-source-generator":
      validateGeneratorRetirement(operation, add);
      return;
  }
}

function validateAdoption(operation: Extract<FileOperation, { kind: "adopt-generated-source" }>, add: AddIssue): void {
  validateMutation(operation.file, operation.contents, "generated-source-adoption", add);
  if (
    !isWorkspacePath(operation.declaredSource) ||
    operation.file.preconditionHash === "missing" ||
    operation.file.preconditionMode === "missing" ||
    operation.removedHeader.lines < 1 ||
    !isSha256(operation.removedHeader.hash)
  )
    add("generated-source-adoption", "adoption must bind an existing artifact, missing source path, and exact removed header", operation.file.path);
}

function validateGeneratorRetirement(operation: Extract<FileOperation, { kind: "delete-generated-source-generator" }>, add: AddIssue): void {
  if (operation.file.preconditionHash === "missing" || operation.file.preconditionMode === "missing" || operation.adoptedOutputs.length === 0)
    add("generated-source-generator", "generator retirement requires an existing generator and adopted output proof", operation.file.path);
  validateSortedStrings(operation.adoptedOutputs, "generated-source-generator", "adoptedOutputs", add);
}

function validateCompatibility(manifest: PreparationManifest, add: AddIssue): void {
  validateSorted(manifest.compatibilityReexports, compatibilityKey, "compatibility-order", "compatibility re-exports must be deterministically ordered", add);
  const operations = manifest.operations.filter((item): item is ExtractTypeDeclarationsOperation => item.kind === "extract-type-declarations");
  const seen = new Set<string>();
  for (const intent of manifest.compatibilityReexports) {
    const key = compatibilityKey(intent);
    if (seen.has(key)) add("compatibility", `duplicate compatibility re-export ${intent.fromPath} -> ${intent.toPath}`, intent.fromPath);
    seen.add(key);
    validateCompatibilityIntent(intent, operations, add);
  }
  for (const extraction of operations) validateExtractionCompatibility(manifest, extraction, add);
}

function validateCompatibilityIntent(intent: CompatibilityReexportIntent, operations: readonly ExtractTypeDeclarationsOperation[], add: AddIssue): void {
  if (!isWorkspacePath(intent.fromPath) || !isWorkspacePath(intent.toPath) || intent.fromPath === intent.toPath)
    add("compatibility", "compatibility paths must be distinct workspace-relative paths", intent.fromPath);
  if (!isModuleSpecifier(intent.moduleSpecifier))
    add("compatibility-specifier", "compatibility moduleSpecifier must be a non-empty, non-traversing module specifier", intent.fromPath);
  const extraction = operations.find((operation) => operation.donor.path === intent.fromPath && operation.target.path === intent.toPath);
  if (!extraction) add("compatibility", "compatibility re-export must correspond to an extraction donor and target", intent.fromPath);
  validateSortedStrings(
    intent.exports.map((item) => item.name),
    "compatibility-exports",
    "compatibility exports",
    add,
  );
  if (intent.exports.some((item) => item.typeOnly !== true || !item.name))
    add("compatibility-exports", "compatibility exports must be non-empty type-only names", intent.fromPath);
  if (extraction) validateIntentMatchesExtraction(intent, extraction, add);
}

function validateIntentMatchesExtraction(intent: CompatibilityReexportIntent, extraction: ExtractTypeDeclarationsOperation, add: AddIssue): void {
  if (intent.moduleSpecifier !== extraction.moduleSpecifier)
    add("compatibility-specifier", "compatibility moduleSpecifier must match its extraction replay specifier", intent.fromPath);
  const available = new Set(extraction.declarations.map((group) => group.name));
  for (const exported of intent.exports)
    if (!available.has(exported.name)) add("compatibility-exports", `${exported.name} is not selected by the matching extraction`, intent.fromPath);
}

function validateExtractionCompatibility(manifest: PreparationManifest, extraction: ExtractTypeDeclarationsOperation, add: AddIssue): void {
  const intents = manifest.compatibilityReexports.filter((intent) => intent.fromPath === extraction.donor.path && intent.toPath === extraction.target.path);
  const expected = extraction.declarations
    .filter((group) => group.declarations.some((declaration) => declaration.originallyExported))
    .map((group) => group.name)
    .toSorted(byCodeUnit);
  if (expected.length === 0 && intents.length > 0)
    add("compatibility-exports", "private-only extraction must not declare a compatibility re-export", extraction.donor.path);
  if (expected.length > 0 && intents.length !== 1) {
    add("compatibility-exports", "every extracted public type group requires exactly one compatibility re-export", extraction.donor.path);
    return;
  }
  const actual = intents[0]?.exports.map((item) => item.name) ?? [];
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
    add("compatibility-exports", "compatibility exports must exactly equal the extracted public type groups", extraction.donor.path);
}

function validateScope(manifest: PreparationManifest, add: AddIssue): void {
  const artifacts = manifest.generatedArtifacts ?? [];
  validateSorted(artifacts, (item) => item.path, "generated-artifact-order", "generatedArtifacts must be path-sorted", add);
  for (const artifact of artifacts) {
    if (!isWorkspacePath(artifact.path) || !isWorkspacePath(artifact.source))
      add("generated-artifact", "generated artifact paths must be workspace-relative", artifact.path);
    if (!artifact.regenerate) add("generated-artifact", "generated artifact regenerate command must be non-empty", artifact.path);
    if (artifact.regenerateOnApply !== true) add("generated-artifact", "generated artifact must declare regenerateOnApply true", artifact.path);
    if (artifact.exemptReason !== undefined && artifact.exemptReason.length === 0)
      add("generated-artifact", "generated artifact exemptReason must be non-empty when present", artifact.path);
  }
  const paths = [
    ...new Set([
      ...manifest.operations.flatMap(preparationOperationPaths),
      ...artifacts.map((item) => item.path),
      ...(manifest.postJournalPreparers ?? []).flatMap((item) => item.outputs),
    ]),
  ].toSorted(byCodeUnit);
  validateSortedStrings(manifest.changedFiles, "changed-files", "changedFiles", add);
  if (paths.length !== manifest.changedFiles.length || paths.some((path, index) => path !== manifest.changedFiles[index]))
    add("changed-files", "changedFiles must exactly equal the sorted union of operation, generated-artifact, and post-journal mutation paths");
}

function validateLiveState(manifest: PreparationManifest, options: ValidatePreparationManifestOptions, add: AddIssue): void {
  if (options.expectedGraphDigest !== undefined && !isSha256(options.expectedGraphDigest)) {
    add("expected-graph-digest", "expectedGraphDigest must be a SHA-256 hash");
  } else if (options.expectedGraphDigest !== undefined && manifest.graphDigest !== options.expectedGraphDigest) {
    add("graph-digest", "graphDigest does not match the expected fresh workspace graph");
  }
  if (options.currentFiles) validateCurrentFiles(manifest, options.currentFiles, add);
  if (options.currentContents) validateCurrentContents(manifest, options.currentContents, add);
}

function validateCurrentFiles(
  manifest: PreparationManifest,
  currentFiles: NonNullable<ValidatePreparationManifestOptions["currentFiles"]>,
  add: AddIssue,
): void {
  const mutations = manifest.operations.flatMap((operation) =>
    operation.kind === "extract-type-declarations" ? [operation.donor, operation.target] : [operation.file],
  );
  for (const mutation of mutations) {
    const actual = currentFiles[mutation.path];
    if (actual === undefined) add("stale-input", `no supplied current state for ${mutation.path}`, mutation.path);
    else if (actual !== mutation.preconditionHash) add("stale-input", `current state differs from ${mutation.path}'s precondition`, mutation.path);
  }
}

function validateCurrentContents(
  manifest: PreparationManifest,
  currentContents: NonNullable<ValidatePreparationManifestOptions["currentContents"]>,
  add: AddIssue,
): void {
  for (const declaration of manifest.declarations.flatMap((group) => group.declarations)) {
    const contents = currentContents[declaration.sourcePath];
    if (contents === undefined) add("stale-selector", `no supplied source text for ${declaration.sourcePath}`, declaration.sourcePath);
    else validateCurrentSelector(contents, declaration, add);
  }
}

function validateCurrentSelector(contents: string, declaration: PreparationDeclarationSelector, add: AddIssue): void {
  if (hashText(contents) !== declaration.sourceHash) add("stale-selector", "current source hash differs from declaration selector", declaration.sourcePath);
  if (declaration.span.end > contents.length || hashText(contents.slice(declaration.span.start, declaration.span.end)) !== declaration.span.hash)
    add("stale-selector", `span hash for ${declaration.name} no longer matches source text`, declaration.sourcePath);
  validateCurrentExtractionRegion(contents, declaration, add);
}

function withoutPlanId(manifest: PreparationManifest): PreparationManifestDraft {
  const { planId: _planId, ...draft } = manifest;
  return draft;
}

function declarationKey(declaration: PreparationDeclarationSelector): string {
  return `${String(declaration.span.start).padStart(12, "0")}\u0000${String(declaration.span.end).padStart(12, "0")}\u0000${declaration.declarationId}`;
}

function selectorId(declaration: PreparationDeclarationSelector): string {
  return hashJson({
    declarationId: declaration.declarationId,
    sourcePath: declaration.sourcePath,
    sourceHash: declaration.sourceHash,
    extractionStart: declaration.extractionStart,
    extractionEnd: declaration.extractionEnd,
    extractionHash: declaration.extractionHash,
  });
}

function validateCurrentExtractionRegion(contents: string, declaration: PreparationDeclarationSelector, add: AddIssue): void {
  if (declaration.extractionStart < 0 || declaration.extractionEnd > contents.length || declaration.extractionEnd < declaration.extractionStart) {
    add("stale-extraction", `extraction region for ${declaration.name} is outside source text`, declaration.sourcePath);
    return;
  }
  if (hashText(contents.slice(declaration.extractionStart, declaration.extractionEnd)) !== declaration.extractionHash) {
    add("stale-extraction", `extraction hash for ${declaration.name} no longer matches source text`, declaration.sourcePath);
    return;
  }
  const source = ts.createSourceFile(declaration.sourcePath, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements.find((item) => item.getStart(source) === declaration.span.start && item.end === declaration.span.end);
  if (!statement || statement.getFullStart() !== declaration.extractionStart || statement.end !== declaration.extractionEnd) {
    add("stale-extraction", `extraction region for ${declaration.name} does not match its full declaration boundary`, declaration.sourcePath);
  }
}

function operationKey(operation: PreparationReplayOperation): string {
  const path = operation.kind === "extract-type-declarations" ? operation.donor.path : operation.file.path;
  return `${path}\u0000${operation.kind}`;
}

function compatibilityKey(intent: CompatibilityReexportIntent): string {
  return `${intent.fromPath}\u0000${intent.toPath}`;
}
